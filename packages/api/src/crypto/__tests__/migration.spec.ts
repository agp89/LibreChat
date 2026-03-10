/**
 * Unit tests for the user data migration service.
 *
 * The migration module imports from ~/crypto which re-exports @librechat/data-schemas.
 * In test environments the data-schemas dist may not exist, so we mock ~/crypto
 * to provide inline crypto implementations.
 */

jest.mock('~/crypto', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const cryptoMod = require('crypto');
  const ALG = 'aes-256-gcm';
  const IV = 12;
  const TAG = 16;
  const VER = 'enc1';
  return {
    encryptUserData(plaintext: string, uek: Buffer): string {
      const iv = cryptoMod.randomBytes(IV);
      const cipher = cryptoMod.createCipheriv(ALG, uek, iv, { authTagLength: TAG });
      const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
      const tag = cipher.getAuthTag();
      return `${VER}:${iv.toString('hex')}:${tag.toString('hex')}:${enc.toString('hex')}`;
    },
    isEncrypted(value: unknown): boolean {
      return typeof value === 'string' && value.startsWith(`${VER}:`);
    },
  };
});

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { encryptUserData, isEncrypted } = require('~/crypto') as {
  encryptUserData: (p: string, u: Buffer) => string;
  isEncrypted: (v: unknown) => boolean;
};

import crypto from 'crypto';
import { migrateUserDataOnSetup } from '../migration';

import type { MigrationReport } from '../migration';

function generateUEK(): Buffer {
  return crypto.randomBytes(32);
}

/**
 * Unit tests for the user data migration service.
 *
 * These tests mock mongoose models to verify the migration logic without
 * requiring a real MongoDB instance.
 */

function createMockModel(
  docs: Array<Record<string, unknown>>,
): Record<string, jest.Mock> {
  const model = {
    countDocuments: jest.fn().mockResolvedValue(docs.length),
    find: jest.fn().mockReturnValue({
      sort: jest.fn().mockReturnValue({
        limit: jest.fn().mockReturnValue({
          lean: jest.fn().mockResolvedValueOnce(docs).mockResolvedValue([]),
        }),
      }),
    }),
    updateOne: jest.fn().mockResolvedValue({ modifiedCount: 1 }),
  };
  return model;
}

function createMockMongoose(
  models: Record<string, ReturnType<typeof createMockModel>>,
): typeof import('mongoose') {
  return { models } as unknown as typeof import('mongoose');
}

describe('migrateUserDataOnSetup', () => {
  const uek = generateUEK();
  const userId = 'user_migrate_123';

  it('encrypts plaintext documents across all collections', async () => {
    const msgDocs = [
      { _id: 'm1', text: 'Hello world', encryptionVersion: 0 },
      { _id: 'm2', text: 'Second message', encryptionVersion: 0 },
    ];
    const convoDocs = [
      { _id: 'c1', title: 'Test Convo', system: 'You are helpful', encryptionVersion: 0 },
    ];

    const MessageModel = createMockModel(msgDocs);
    const ConversationModel = createMockModel(convoDocs);
    const FileModel = createMockModel([]);
    const MemoryEntryModel = createMockModel([]);
    const ToolCallModel = createMockModel([]);

    const mongoose = createMockMongoose({
      Message: MessageModel,
      Conversation: ConversationModel,
      File: FileModel,
      MemoryEntry: MemoryEntryModel,
      ToolCall: ToolCallModel,
    });

    const report = await migrateUserDataOnSetup(mongoose, userId, uek);

    expect(report.userId).toBe(userId);
    expect(report.collections['Message'].encrypted).toBe(2);
    expect(report.collections['Conversation'].encrypted).toBe(1);
    expect(report.collections['File'].total).toBe(0);

    // Verify updateOne was called with encrypted values
    expect(MessageModel.updateOne).toHaveBeenCalledTimes(2);
    const updateCall = MessageModel.updateOne.mock.calls[0];
    expect(updateCall[0]).toEqual({ _id: 'm1' });
    const setClause = updateCall[1].$set;
    expect(setClause.encryptionVersion).toBe(1);
    expect(isEncrypted(setClause.text)).toBe(true);
  });

  it('skips documents with no sensitive data (sets encryptionVersion only)', async () => {
    const docs = [
      { _id: 'm1', text: null, encryptionVersion: 0 },
    ];
    const MessageModel = createMockModel(docs);
    const mongoose = createMockMongoose({
      Message: MessageModel,
      Conversation: createMockModel([]),
      File: createMockModel([]),
      MemoryEntry: createMockModel([]),
      ToolCall: createMockModel([]),
    });

    const report = await migrateUserDataOnSetup(mongoose, userId, uek);
    expect(report.collections['Message'].skipped).toBe(1);
    expect(report.collections['Message'].encrypted).toBe(0);

    // Verify only encryptionVersion was set (no field encryption)
    expect(MessageModel.updateOne).toHaveBeenCalledWith(
      { _id: 'm1' },
      { $set: { encryptionVersion: 1 } },
    );
  });

  it('respects dryRun option — does not write to DB', async () => {
    const docs = [{ _id: 'm1', text: 'Secret', encryptionVersion: 0 }];
    const MessageModel = createMockModel(docs);
    const mongoose = createMockMongoose({
      Message: MessageModel,
      Conversation: createMockModel([]),
      File: createMockModel([]),
      MemoryEntry: createMockModel([]),
      ToolCall: createMockModel([]),
    });

    const report = await migrateUserDataOnSetup(mongoose, userId, uek, { dryRun: true });
    expect(report.collections['Message'].encrypted).toBe(1);
    expect(MessageModel.updateOne).not.toHaveBeenCalled();
  });

  it('can target a specific collection', async () => {
    const MessageModel = createMockModel([{ _id: 'm1', text: 'Test', encryptionVersion: 0 }]);
    const ConvoModel = createMockModel([{ _id: 'c1', title: 'Test', encryptionVersion: 0 }]);
    const mongoose = createMockMongoose({
      Message: MessageModel,
      Conversation: ConvoModel,
      File: createMockModel([]),
      MemoryEntry: createMockModel([]),
      ToolCall: createMockModel([]),
    });

    const report = await migrateUserDataOnSetup(mongoose, userId, uek, {
      collection: 'Message',
    });

    expect(report.collections['Message']).toBeDefined();
    expect(report.collections['Conversation']).toBeUndefined();
    expect(MessageModel.updateOne).toHaveBeenCalled();
    expect(ConvoModel.updateOne).not.toHaveBeenCalled();
  });

  it('skips unregistered models without error', async () => {
    // Only provide Message model, skip the rest
    const mongoose = createMockMongoose({
      Message: createMockModel([]),
    });

    const report = await migrateUserDataOnSetup(mongoose, userId, uek);
    expect(report.collections['Message']).toBeDefined();
    // Other collections skipped because models not registered
    expect(report.collections['Conversation']).toBeUndefined();
  });

  it('reports errors for individual documents without stopping', async () => {
    const docs = [
      { _id: 'm1', text: 'Good', encryptionVersion: 0 },
      { _id: 'm2', text: 'Bad', encryptionVersion: 0 },
    ];
    const MessageModel = createMockModel(docs);
    // Make the second updateOne call fail
    MessageModel.updateOne
      .mockResolvedValueOnce({ modifiedCount: 1 })
      .mockRejectedValueOnce(new Error('DB write error'));

    const mongoose = createMockMongoose({
      Message: MessageModel,
      Conversation: createMockModel([]),
      File: createMockModel([]),
      MemoryEntry: createMockModel([]),
      ToolCall: createMockModel([]),
    });

    const report = await migrateUserDataOnSetup(mongoose, userId, uek);
    expect(report.collections['Message'].encrypted).toBe(1);
    expect(report.collections['Message'].errors).toBe(1);
  });

  it('handles jsonFields (toolCall result)', async () => {
    const resultObj = { output: 'some tool result', data: [1, 2, 3] };
    const docs = [{ _id: 't1', result: resultObj, encryptionVersion: 0 }];
    const ToolCallModel = createMockModel(docs);

    const mongoose = createMockMongoose({
      Message: createMockModel([]),
      Conversation: createMockModel([]),
      File: createMockModel([]),
      MemoryEntry: createMockModel([]),
      ToolCall: ToolCallModel,
    });

    const report = await migrateUserDataOnSetup(mongoose, userId, uek);
    expect(report.collections['ToolCall'].encrypted).toBe(1);

    const setClause = ToolCallModel.updateOne.mock.calls[0][1].$set;
    expect(isEncrypted(setClause.result)).toBe(true);
    expect(setClause.encryptionVersion).toBe(1);
  });
});
