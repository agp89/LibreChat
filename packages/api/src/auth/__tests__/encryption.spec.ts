/**
 * Integration tests for the encryption auth service.
 *
 * Tests the full lifecycle: setup → unlock → change passphrase → reset.
 *
 * The encryption module imports from ~/crypto which re-exports @librechat/data-schemas.
 * In test environments the data-schemas dist may not exist, so we mock ~/crypto
 * and @librechat/data-schemas to provide inline crypto implementations.
 */

// Must be set before module evaluation (jest.mock is hoisted, but env is read at import time)
process.env.ENCRYPTION_MASTER_KEY = 'a'.repeat(64);

jest.mock('@librechat/data-schemas', () => {
  const { AsyncLocalStorage } = require('async_hooks'); // eslint-disable-line @typescript-eslint/no-require-imports
  process.env.ENCRYPTION_MASTER_KEY = 'a'.repeat(64);
  return {
    encryptionStore: new AsyncLocalStorage(),
    logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn() },
  };
});

jest.mock('~/crypto', () => {
  const cryptoMod = require('crypto'); // eslint-disable-line @typescript-eslint/no-require-imports
  const ALG = 'aes-256-gcm';
  const IV_LEN = 12;
  const TAG_LEN = 16;
  const VER = 'enc1';
  return {
    generatePassphraseSalt(): Buffer {
      return cryptoMod.randomBytes(32);
    },
    deriveKEK(masterKey: Buffer, userId: string, sessionSecret: Buffer): Buffer {
      return cryptoMod.pbkdf2Sync(
        Buffer.concat([masterKey, sessionSecret]),
        userId,
        1000,
        32,
        'sha256',
      );
    },
    generateUEK(): Buffer {
      return cryptoMod.randomBytes(32);
    },
    wrapUEK(uek: Buffer, kek: Buffer): string {
      const iv = cryptoMod.randomBytes(IV_LEN);
      const cipher = cryptoMod.createCipheriv(ALG, kek, iv, { authTagLength: TAG_LEN });
      const enc = Buffer.concat([cipher.update(uek), cipher.final()]);
      const tag = cipher.getAuthTag();
      return `${iv.toString('hex')}:${tag.toString('hex')}:${enc.toString('hex')}`;
    },
    unwrapUEK(wrapped: string, kek: Buffer): Buffer {
      const [ivHex, tagHex, encHex] = wrapped.split(':');
      const iv = Buffer.from(ivHex, 'hex');
      const tag = Buffer.from(tagHex, 'hex');
      const enc = Buffer.from(encHex, 'hex');
      const decipher = cryptoMod.createDecipheriv(ALG, kek, iv, { authTagLength: TAG_LEN });
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(enc), decipher.final()]);
    },
    encryptUserData(plaintext: string, uek: Buffer): string {
      const iv = cryptoMod.randomBytes(IV_LEN);
      const cipher = cryptoMod.createCipheriv(ALG, uek, iv, { authTagLength: TAG_LEN });
      const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
      const tag = cipher.getAuthTag();
      return `${VER}:${iv.toString('hex')}:${tag.toString('hex')}:${enc.toString('hex')}`;
    },
    decryptUserData(ciphertext: string, uek: Buffer): string {
      const parts = ciphertext.split(':');
      const [, ivHex, tagHex, encHex] = parts;
      const iv = Buffer.from(ivHex, 'hex');
      const tag = Buffer.from(tagHex, 'hex');
      const enc = Buffer.from(encHex, 'hex');
      const decipher = cryptoMod.createDecipheriv(ALG, uek, iv, { authTagLength: TAG_LEN });
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
    },
    isEncrypted(value: unknown): boolean {
      return typeof value === 'string' && value.startsWith(`${VER}:`);
    },
  };
});

jest.mock('~/crypto/keyCache', () => {
  const cache = new Map<string, Buffer>();
  return {
    userKeyCache: {
      setUEK: jest.fn((userId: string, uek: Buffer) => cache.set(userId, uek)),
      getUEK: jest.fn((userId: string) => cache.get(userId) ?? null),
      evict: jest.fn((userId: string) => cache.delete(userId)),
      get size() {
        return cache.size;
      },
    },
  };
});

import {
  getEncryptionSalt,
  setupEncryption,
  unlockEncryption,
  changePassphrase,
  resetEncryption,
} from '../encryption';

const mockUserStore: Record<string, Record<string, unknown>> = {};

function createMockUser(userId: string) {
  mockUserStore[userId] = {
    _id: userId,
    encryptedUEK: null,
    passphraseSalt: null,
    encryptionVersion: 0,
  };
}

function createMockUserModel() {
  return {
    findById: jest.fn((id: string) => ({
      select: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue(mockUserStore[id] ?? null),
      }),
    })),
    findByIdAndUpdate: jest.fn((id: string, update: Record<string, unknown>) => {
      const user = mockUserStore[id];
      if (!user) return Promise.resolve(null);
      const setFields = update.$set as Record<string, unknown> | undefined;
      const unsetFields = update.$unset as Record<string, unknown> | undefined;
      if (setFields) {
        Object.assign(user, setFields);
      }
      if (unsetFields) {
        for (const key of Object.keys(unsetFields)) {
          user[key] = null;
        }
      }
      return Promise.resolve(user);
    }),
    countDocuments: jest.fn().mockResolvedValue(0),
  };
}

const mockDeleteMany = jest.fn().mockResolvedValue({ deletedCount: 5 });

function createMockMongoose() {
  const userModel = createMockUserModel();
  const mongooseObj = {
    models: {
      User: userModel,
      Message: { deleteMany: mockDeleteMany, countDocuments: jest.fn().mockResolvedValue(0) },
      Conversation: { deleteMany: mockDeleteMany },
      File: { deleteMany: mockDeleteMany },
      MemoryEntry: { deleteMany: mockDeleteMany },
      ToolCall: { deleteMany: mockDeleteMany },
    },
  };
  return mongooseObj as unknown as typeof import('mongoose');
}

describe('encryption auth service', () => {
  const userId = 'test-user-123';
  let mockMongoose: ReturnType<typeof createMockMongoose>;

  beforeEach(() => {
    for (const key of Object.keys(mockUserStore)) delete mockUserStore[key];
    createMockUser(userId);
    mockMongoose = createMockMongoose();
    jest.clearAllMocks();
  });

  describe('setupEncryption', () => {
    it('generates a passphrase salt and stores it', async () => {
      const result = await setupEncryption(mockMongoose, userId);
      expect(result).toHaveProperty('passphraseSalt');
      expect(typeof result.passphraseSalt).toBe('string');
      expect(result.passphraseSalt.length).toBe(64);
    });

    it('rejects if encryption is already configured', async () => {
      mockUserStore[userId].encryptedUEK = 'already-wrapped';
      await expect(setupEncryption(mockMongoose, userId)).rejects.toThrow(
        'Encryption already configured',
      );
    });
  });

  describe('getEncryptionSalt', () => {
    it('returns the stored salt', async () => {
      const { passphraseSalt } = await setupEncryption(mockMongoose, userId);
      const result = await getEncryptionSalt(mockMongoose, userId);
      expect(result.passphraseSalt).toBe(passphraseSalt);
    });

    it('throws when no salt is configured', async () => {
      await expect(getEncryptionSalt(mockMongoose, userId)).rejects.toThrow();
    });
  });

  describe('unlockEncryption', () => {
    it('generates UEK on first unlock after setup', async () => {
      await setupEncryption(mockMongoose, userId);
      const sessionSecret = 'b'.repeat(64);
      const result = await unlockEncryption(mockMongoose, userId, { sessionSecret });
      expect(result).toHaveProperty('status', 'encryption_active');
    });

    it('unwraps existing UEK on subsequent unlocks', async () => {
      await setupEncryption(mockMongoose, userId);
      const sessionSecret = 'b'.repeat(64);

      await unlockEncryption(mockMongoose, userId, { sessionSecret });
      const result = await unlockEncryption(mockMongoose, userId, { sessionSecret });
      expect(result.status).toBe('encryption_active');
    });

    it('rejects invalid passphrase on existing UEK', async () => {
      await setupEncryption(mockMongoose, userId);
      const sessionSecret = 'b'.repeat(64);
      await unlockEncryption(mockMongoose, userId, { sessionSecret });

      const wrongSecret = 'c'.repeat(64);
      await expect(
        unlockEncryption(mockMongoose, userId, { sessionSecret: wrongSecret }),
      ).rejects.toThrow('Invalid passphrase');
    });
  });

  describe('changePassphrase', () => {
    it('re-wraps UEK with new KEK', async () => {
      await setupEncryption(mockMongoose, userId);
      const sessionSecret = 'c'.repeat(64);
      await unlockEncryption(mockMongoose, userId, { sessionSecret });

      const result = await changePassphrase(mockMongoose, userId, {
        oldSessionSecret: sessionSecret,
        newSessionSecret: 'd'.repeat(64),
      });
      expect(result).toHaveProperty('status', 'passphrase_changed');
      expect(result).toHaveProperty('newPassphraseSalt');
      expect(typeof result.newPassphraseSalt).toBe('string');
    });

    it('rejects if encryption is not configured', async () => {
      await expect(
        changePassphrase(mockMongoose, userId, {
          oldSessionSecret: 'a'.repeat(64),
          newSessionSecret: 'b'.repeat(64),
        }),
      ).rejects.toThrow('Encryption not configured');
    });
  });

  describe('resetEncryption', () => {
    it('requires confirmation', async () => {
      await expect(resetEncryption(mockMongoose, userId, { confirm: false })).rejects.toThrow(
        'Reset must be confirmed',
      );
    });

    it('deletes encrypted data and clears encryption fields', async () => {
      await setupEncryption(mockMongoose, userId);
      const result = await resetEncryption(mockMongoose, userId, { confirm: true });
      expect(result).toHaveProperty('status', 'encryption_reset');
      expect(result).toHaveProperty('deletedData');
      expect(result.deletedData).toHaveProperty('messages');
      expect(result.deletedData).toHaveProperty('conversations');
      expect(result.deletedData).toHaveProperty('files');
      expect(result.deletedData).toHaveProperty('memories');
      expect(result.deletedData).toHaveProperty('toolcalls');
    });
  });
});
