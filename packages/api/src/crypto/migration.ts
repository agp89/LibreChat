import type { FilterQuery, Model, Document } from 'mongoose';
import { encryptUserData, isEncrypted } from '~/crypto';

/**
 * Lazy logger: uses @librechat/data-schemas logger if available, falls back to console.
 * This avoids a hard dependency on the built package in test environments.
 */
const logger = (() => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('@librechat/data-schemas').logger ?? console;
  } catch {
    return console;
  }
})() as Pick<Console, 'info' | 'warn' | 'error'>;

const DEFAULT_BATCH_SIZE = 100;

export interface MigrationReport {
  userId: string;
  collections: Record<string, { total: number; encrypted: number; skipped: number; errors: number }>;
}

interface CollectionConfig {
  modelName: string;
  userField: string;
  fields: string[];
  jsonFields: string[];
}

const COLLECTION_CONFIGS: CollectionConfig[] = [
  {
    modelName: 'Message',
    userField: 'user',
    fields: ['text'],
    jsonFields: ['content'],
  },
  {
    modelName: 'Conversation',
    userField: 'user',
    fields: ['title', 'system', 'promptPrefix'],
    jsonFields: [],
  },
  {
    modelName: 'File',
    userField: 'user',
    fields: ['text'],
    jsonFields: [],
  },
  {
    modelName: 'MemoryEntry',
    userField: 'userId',
    fields: ['value', 'key'],
    jsonFields: [],
  },
  {
    modelName: 'ToolCall',
    userField: 'user',
    fields: [],
    jsonFields: ['result'],
  },
];

function encryptDocFields(
  doc: Record<string, unknown>,
  fields: string[],
  jsonFields: string[],
  uek: Buffer,
): boolean {
  let modified = false;
  for (const field of [...fields, ...jsonFields]) {
    const value = doc[field];
    if (value == null) continue;
    if (isEncrypted(value)) continue;
    const plaintext = jsonFields.includes(field) ? JSON.stringify(value) : String(value);
    doc[field] = encryptUserData(plaintext, uek);
    modified = true;
  }
  return modified;
}

async function migrateCollection(
  model: Model<Document>,
  config: CollectionConfig,
  userId: string,
  uek: Buffer,
  batchSize: number,
  dryRun: boolean,
): Promise<{ total: number; encrypted: number; skipped: number; errors: number }> {
  const filter: FilterQuery<Document> = {
    [config.userField]: userId,
    $or: [{ encryptionVersion: { $exists: false } }, { encryptionVersion: 0 }],
  };

  const allFields = [...config.fields, ...config.jsonFields];
  const total = await model.countDocuments(filter);
  let encrypted = 0;
  let skipped = 0;
  let errors = 0;
  let processed = 0;

  while (processed < total) {
    const docs = await model
      .find(filter)
      .limit(batchSize)
      .lean();

    if (docs.length === 0) break;

    for (const doc of docs) {
      try {
        const record = doc as unknown as Record<string, unknown>;
        const hasData = allFields.some((f) => record[f] != null);

        if (!hasData) {
          if (!dryRun) {
            await model.updateOne(
              { _id: record['_id'] },
              { $set: { encryptionVersion: 1 } },
            );
          }
          skipped++;
          processed++;
          continue;
        }

        if (!dryRun) {
          const update: Record<string, unknown> = {};
          encryptDocFields(record, config.fields, config.jsonFields, uek);
          for (const field of allFields) {
            if (record[field] != null) {
              update[field] = record[field];
            }
          }
          update['encryptionVersion'] = 1;
          await model.updateOne({ _id: record['_id'] }, { $set: update });
        }
        encrypted++;
      } catch (err) {
        logger.error(`[migrateUserData] Error encrypting doc ${String((doc as Record<string, unknown>)['_id'])} in ${config.modelName}:`, err);
        errors++;
      }
      processed++;
    }
  }

  return { total, encrypted, skipped, errors };
}

/**
 * Encrypts all existing plaintext data for a user after they set up their encryption passphrase.
 * Runs incrementally, batch-by-batch, so it can handle large datasets without blocking.
 *
 * @param mongoose - The mongoose instance (for accessing registered models)
 * @param userId  - The user whose data should be migrated
 * @param uek     - The user's decrypted User Encryption Key
 * @param options - Optional: batchSize (default 100), dryRun (default false), collection (specific collection name)
 */
export async function migrateUserDataOnSetup(
  mongoose: typeof import('mongoose'),
  userId: string,
  uek: Buffer,
  options?: {
    batchSize?: number;
    dryRun?: boolean;
    collection?: string;
  },
): Promise<MigrationReport> {
  const batchSize = options?.batchSize ?? DEFAULT_BATCH_SIZE;
  const dryRun = options?.dryRun ?? false;
  const targetCollection = options?.collection;

  const report: MigrationReport = { userId, collections: {} };

  const configs = targetCollection
    ? COLLECTION_CONFIGS.filter((c) => c.modelName.toLowerCase() === targetCollection.toLowerCase())
    : COLLECTION_CONFIGS;

  for (const config of configs) {
    const model = mongoose.models[config.modelName] as Model<Document> | undefined;
    if (!model) {
      logger.warn(`[migrateUserData] Model ${config.modelName} not registered, skipping.`);
      continue;
    }

    const result = await migrateCollection(model, config, userId, uek, batchSize, dryRun);
    report.collections[config.modelName] = result;
    logger.info(
      `[migrateUserData] ${dryRun ? '(dry-run) ' : ''}${config.modelName}: ` +
      `${result.encrypted} encrypted, ${result.skipped} skipped, ${result.errors} errors ` +
      `(of ${result.total} total) for user ${userId}`,
    );
  }

  return report;
}
