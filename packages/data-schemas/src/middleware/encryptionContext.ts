import { AsyncLocalStorage } from 'node:async_hooks';

export interface EncryptionContext {
  /** User Encryption Key — 32-byte buffer; available only after passphrase unlock */
  uek: Buffer;
  /** The authenticated user's MongoDB _id (string) */
  userId: string;
}

/**
 * AsyncLocalStorage store that carries the per-request encryption context
 * (UEK + userId) through the async call chain without explicit parameter
 * threading. Set by the encryption unlock middleware; read by Mongoose hooks.
 */
export const encryptionStore = new AsyncLocalStorage<EncryptionContext>();
