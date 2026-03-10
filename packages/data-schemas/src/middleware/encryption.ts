import type { Schema, Document, Query } from 'mongoose';
import { encryptUserData, decryptUserData, isEncrypted } from '~/crypto/userEncryption';
import { encryptionStore } from '~/middleware/encryptionContext';

const ENCRYPTION_ENABLED = process.env.ENCRYPT_USER_DATA === 'true';

/**
 * Options for the encryption middleware factory.
 * `fields` lists the top-level string fields to encrypt/decrypt.
 * `jsonFields` lists fields that must be JSON-serialized before encryption
 * (typically Array or Mixed typed fields like `content`).
 */
export interface EncryptionMiddlewareOptions {
  fields: string[];
  jsonFields?: string[];
}

type AnyDocument = Document & Record<string, unknown>;
type AnyQuery = Query<unknown, AnyDocument>;

function encryptFields(
  doc: Record<string, unknown>,
  fields: string[],
  jsonFields: string[],
  uek: Buffer,
): void {
  for (const field of fields) {
    const value = doc[field];
    if (value == null) continue;
    if (isEncrypted(value)) continue;

    const plaintext = jsonFields.includes(field)
      ? JSON.stringify(value)
      : String(value);
    doc[field] = encryptUserData(plaintext, uek);
  }
}

function decryptFields(
  doc: Record<string, unknown>,
  fields: string[],
  jsonFields: string[],
  uek: Buffer,
): void {
  for (const field of fields) {
    const value = doc[field];
    if (!isEncrypted(value)) continue;
    const decrypted = decryptUserData(value as string, uek);
    doc[field] = jsonFields.includes(field) ? JSON.parse(decrypted) : decrypted;
  }
}

/**
 * Attaches AES-256-GCM encrypt-on-write / decrypt-on-read hooks to a Mongoose schema.
 *
 * The UEK is sourced from `AsyncLocalStorage` via `encryptionStore`. If no UEK
 * is present in the store the middleware is a no-op, allowing unauthenticated
 * reads (legacy plaintext documents remain readable).
 */
export function attachEncryptionMiddleware(
  schema: Schema,
  { fields, jsonFields = [] }: EncryptionMiddlewareOptions,
): void {
  if (!ENCRYPTION_ENABLED) return;

  /** Pre-save: encrypt fields before writing to MongoDB */
  schema.pre('save', function (this: AnyDocument, next) {
    const ctx = encryptionStore.getStore();
    if (!ctx?.uek) return next();
    const doc = this as unknown as Record<string, unknown>;
    encryptFields(doc, fields, jsonFields, ctx.uek);
    doc['encryptionVersion'] = 1;
    next();
  });

  /** Pre-findOneAndUpdate: encrypt fields in $set updates */
  schema.pre('findOneAndUpdate', function (this: AnyQuery, next) {
    const ctx = encryptionStore.getStore();
    if (!ctx?.uek) return next();
    const update = this.getUpdate() as Record<string, unknown> | null;
    if (!update) return next();

    const setClause = (update['$set'] as Record<string, unknown> | undefined) ?? update;
    encryptFields(setClause as Record<string, unknown>, fields, jsonFields, ctx.uek);

    if (update['$set']) {
      (update['$set'] as Record<string, unknown>)['encryptionVersion'] = 1;
    } else {
      update['encryptionVersion'] = 1;
    }
    next();
  });

  /** Post-find / post-findOne: decrypt fields after reading from MongoDB */
  const postFindHook = function (doc: AnyDocument | null) {
    if (!doc) return;
    const encVer = (doc as AnyDocument & { encryptionVersion?: number }).encryptionVersion;
    if (!encVer) return;
    const ctx = encryptionStore.getStore();
    if (!ctx?.uek) return;
    decryptFields(doc as unknown as Record<string, unknown>, fields, jsonFields, ctx.uek);
  };

  schema.post('save', postFindHook);
  schema.post('find', function (docs: AnyDocument[]) {
    if (!Array.isArray(docs)) return;
    const ctx = encryptionStore.getStore();
    if (!ctx?.uek) return;
    for (const doc of docs) {
      const encVer = (doc as AnyDocument & { encryptionVersion?: number }).encryptionVersion;
      if (!encVer) continue;
      decryptFields(doc as unknown as Record<string, unknown>, fields, jsonFields, ctx.uek);
    }
  });
  schema.post('findOne', postFindHook);
  schema.post('findOneAndUpdate', postFindHook);
}
