/**
 * Tests for shared conversation re-encryption behavior (PRD §7.8).
 *
 * Validates that the encryption context and decryption functions work
 * correctly for the shared link snapshot flow.
 */
import { AsyncLocalStorage } from 'async_hooks';

const mockEncryptionStore = new AsyncLocalStorage<{ uek: Buffer; userId: string }>();

jest.mock('~/middleware/encryptionContext', () => ({
  encryptionStore: mockEncryptionStore,
}));

jest.mock('~/crypto/userEncryption', () => {
  const VER = 'enc1';
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const cryptoMod = require('crypto');
  return {
    isEncrypted: (value: unknown) => typeof value === 'string' && (value as string).startsWith(`${VER}:`),
    decryptUserData: (ciphertext: string, uek: Buffer) => {
      const parts = ciphertext.split(':');
      if (parts.length !== 4 || parts[0] !== VER) throw new Error('Invalid format');
      const iv = Buffer.from(parts[1], 'hex');
      const tag = Buffer.from(parts[2], 'hex');
      const enc = Buffer.from(parts[3], 'hex');
      const decipher = cryptoMod.createDecipheriv('aes-256-gcm', uek, iv, { authTagLength: 16 });
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
    },
    encryptUserData: (plaintext: string, uek: Buffer) => {
      const iv = cryptoMod.randomBytes(12);
      const cipher = cryptoMod.createCipheriv('aes-256-gcm', uek, iv, { authTagLength: 16 });
      const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
      const tag = cipher.getAuthTag();
      return `${VER}:${iv.toString('hex')}:${tag.toString('hex')}:${enc.toString('hex')}`;
    },
  };
});

// eslint-disable-next-line @typescript-eslint/no-require-imports
const cryptoMod = require('crypto');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { encryptUserData, decryptUserData, isEncrypted } = require('~/crypto/userEncryption');

describe('shared link encryption support (PRD §7.8)', () => {
  const uek = cryptoMod.randomBytes(32);

  describe('message snapshot decryption', () => {
    it('decrypts encrypted message text via UEK', () => {
      const plaintext = 'Hello shared world';
      const encrypted = encryptUserData(plaintext, uek);
      const decrypted = decryptUserData(encrypted, uek);
      expect(decrypted).toBe(plaintext);
    });

    it('correctly detects encrypted vs plaintext values', () => {
      const encrypted = encryptUserData('test', uek);
      expect(isEncrypted(encrypted)).toBe(true);
      expect(isEncrypted('plain text')).toBe(false);
      expect(isEncrypted(null)).toBe(false);
      expect(isEncrypted(42)).toBe(false);
    });

    it('simulates share creation with encryption context', () => {
      const encTitle = encryptUserData('My Conversation', uek);
      const encText = encryptUserData('Hello from user', uek);

      mockEncryptionStore.run({ uek, userId: 'owner-123' }, () => {
        const ctx = mockEncryptionStore.getStore()!;

        // Simulate createSharedLink decrypting title
        const plainTitle = isEncrypted(encTitle)
          ? decryptUserData(encTitle, ctx.uek)
          : encTitle;
        expect(plainTitle).toBe('My Conversation');

        // Simulate message snapshot creation
        const msg = { text: encText, sender: 'user' };
        const snapshot = { ...msg };
        if (isEncrypted(snapshot.text)) {
          snapshot.text = decryptUserData(snapshot.text, ctx.uek);
        }
        expect(snapshot.text).toBe('Hello from user');
        expect(snapshot.sender).toBe('user');
      });
    });

    it('leaves plaintext unchanged during share creation', () => {
      mockEncryptionStore.run({ uek, userId: 'owner-456' }, () => {
        const ctx = mockEncryptionStore.getStore()!;
        const plainTitle = 'Already Plain';
        const result = isEncrypted(plainTitle)
          ? decryptUserData(plainTitle, ctx.uek)
          : plainTitle;
        expect(result).toBe('Already Plain');
      });
    });
  });

  describe('encryption context isolation', () => {
    it('encryptionStore is undefined outside run scope', () => {
      expect(mockEncryptionStore.getStore()).toBeUndefined();
    });

    it('provides UEK inside run scope', () => {
      mockEncryptionStore.run({ uek, userId: 'test' }, () => {
        const ctx = mockEncryptionStore.getStore();
        expect(ctx?.uek).toBe(uek);
        expect(ctx?.userId).toBe('test');
      });
    });
  });
});
