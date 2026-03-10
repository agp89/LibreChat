import type { FilterQuery } from 'mongoose';
import {
  generatePassphraseSalt,
  deriveKEK,
  generateUEK,
  wrapUEK,
  unwrapUEK,
  encryptUserData,
  decryptUserData,
  isEncrypted,
} from '~/crypto';
import { migrateUserDataOnSetup } from '~/crypto/migration';
import { userKeyCache } from '~/crypto/keyCache';
import type { IUser } from '@librechat/data-schemas';

const MASTER_KEY_HEX = process.env.ENCRYPTION_MASTER_KEY ?? '';
const MAX_PASSPHRASE_ATTEMPTS = parseInt(
  process.env.ENCRYPTION_MAX_PASSPHRASE_ATTEMPTS ?? '5',
  10,
);

/** Returns the ENCRYPTION_MASTER_KEY as a Buffer; throws if misconfigured. */
function getMasterKey(): Buffer {
  if (!MASTER_KEY_HEX || MASTER_KEY_HEX.length !== 64) {
    throw new Error(
      'ENCRYPTION_MASTER_KEY is not set or invalid. Must be a 64-character hex string.',
    );
  }
  return Buffer.from(MASTER_KEY_HEX, 'hex');
}

/** In-process failed-attempt counter (resets on process restart). */
const failedAttempts = new Map<string, { count: number; lockedUntil: number }>();

/** Returns true and resets counter if within attempt limits, false if rate-limited. */
function checkRateLimit(userId: string): { allowed: boolean; retryAfter?: number } {
  const record = failedAttempts.get(userId);
  if (!record) return { allowed: true };
  if (Date.now() < record.lockedUntil) {
    return { allowed: false, retryAfter: Math.ceil((record.lockedUntil - Date.now()) / 1000) };
  }
  return { allowed: true };
}

function recordFailure(userId: string): void {
  const record = failedAttempts.get(userId) ?? { count: 0, lockedUntil: 0 };
  record.count += 1;
  if (record.count >= MAX_PASSPHRASE_ATTEMPTS) {
    // Exponential backoff: 2^(count-maxAttempts+1) * 30 seconds, capped at 1 hour
    const backoffSeconds = Math.min(
      30 * Math.pow(2, record.count - MAX_PASSPHRASE_ATTEMPTS),
      3600,
    );
    record.lockedUntil = Date.now() + backoffSeconds * 1000;
  }
  failedAttempts.set(userId, record);
}

function clearFailures(userId: string): void {
  failedAttempts.delete(userId);
}

export interface EncryptionSaltResponse {
  passphraseSalt: string;
}

export interface UnlockEncryptionRequest {
  sessionSecret: string;
}

export interface UnlockEncryptionResponse {
  status: 'encryption_active';
}

export interface SetupEncryptionResponse {
  passphraseSalt: string;
}

export interface ChangePassphraseRequest {
  oldSessionSecret: string;
  newSessionSecret: string;
}

export interface ChangePassphraseResponse {
  status: 'passphrase_changed';
  newPassphraseSalt: string;
}

export interface ResetEncryptionRequest {
  confirm: boolean;
}

export interface ResetEncryptionResponse {
  status: 'encryption_reset';
  deletedData: Record<string, number>;
}

/**
 * GET /api/auth/encryption-salt
 * Returns the user's PBKDF2 salt for client-side sessionSecret derivation.
 * Throws with code 'encryption_not_configured' if the user has not set up encryption.
 */
export async function getEncryptionSalt(
  mongoose: typeof import('mongoose'),
  userId: string,
): Promise<EncryptionSaltResponse> {
  const User = mongoose.models.User;
  const user = await User.findById(userId).select('+passphraseSalt').lean<IUser>();
  if (!user?.passphraseSalt) {
    const err = Object.assign(new Error('Encryption not configured for this user'), {
      code: 'encryption_not_configured',
      status: 404,
    });
    throw err;
  }
  return { passphraseSalt: user.passphraseSalt };
}

/**
 * POST /api/auth/setup-encryption
 * Initializes encryption for a first-time passphrase setup.
 * Generates and stores a new passphraseSalt; the client will use it to derive the
 * sessionSecret and then call unlock-encryption to complete the flow.
 */
export async function setupEncryption(
  mongoose: typeof import('mongoose'),
  userId: string,
): Promise<SetupEncryptionResponse> {
  const User = mongoose.models.User;
  const existing = await User.findById(userId).select('+encryptedUEK').lean<IUser>();
  if (existing?.encryptedUEK) {
    const err = Object.assign(new Error('Encryption already configured'), {
      code: 'encryption_already_configured',
      status: 409,
    });
    throw err;
  }

  const salt = generatePassphraseSalt();
  const saltHex = salt.toString('hex');
  await User.findByIdAndUpdate(userId, { $set: { passphraseSalt: saltHex } });
  return { passphraseSalt: saltHex };
}

/**
 * POST /api/auth/unlock-encryption
 * Receives the client-derived sessionSecret, derives the KEK, and unwraps the UEK.
 * On first call (no encryptedUEK), generates a new UEK and stores it wrapped.
 */
export async function unlockEncryption(
  mongoose: typeof import('mongoose'),
  userId: string,
  { sessionSecret }: UnlockEncryptionRequest,
): Promise<UnlockEncryptionResponse> {
  const { allowed, retryAfter } = checkRateLimit(userId);
  if (!allowed) {
    const err = Object.assign(
      new Error(`Too many failed passphrase attempts. Retry after ${retryAfter}s.`),
      { code: 'passphrase_rate_limited', status: 429, retryAfter },
    );
    throw err;
  }

  const masterKey = getMasterKey();
  const secretBuffer = Buffer.from(sessionSecret, 'hex');
  const kek = deriveKEK(masterKey, userId, secretBuffer);

  const User = mongoose.models.User;
  const user = await User.findById(userId).select('+encryptedUEK +passphraseSalt').lean<IUser>();

  let uek: Buffer;
  let isFirstUnlock = false;
  if (!user?.encryptedUEK) {
    // First unlock after setup-encryption — generate and wrap a new UEK
    isFirstUnlock = true;
    uek = generateUEK();
    const wrappedUEK = wrapUEK(uek, kek);
    await User.findByIdAndUpdate(userId, {
      $set: { encryptedUEK: wrappedUEK, encryptionVersion: 1 },
    });
  } else {
    try {
      uek = unwrapUEK(user.encryptedUEK, kek);
    } catch {
      recordFailure(userId);
      const err = Object.assign(new Error('Invalid passphrase'), {
        code: 'invalid_passphrase',
        status: 401,
      });
      throw err;
    }
  }

  clearFailures(userId);
  userKeyCache.setUEK(userId, uek);

  // On first unlock, migrate existing plaintext data asynchronously (fire-and-forget)
  if (isFirstUnlock) {
    migrateUserDataOnSetup(mongoose, userId, uek).catch((err) => {
      console.error(`[unlockEncryption] Migration failed for user ${userId}:`, err);
    });
  }

  return { status: 'encryption_active' };
}

/**
 * POST /api/auth/change-passphrase
 * Re-wraps the UEK under a new KEK without re-encrypting user data.
 */
export async function changePassphrase(
  mongoose: typeof import('mongoose'),
  userId: string,
  { oldSessionSecret, newSessionSecret }: ChangePassphraseRequest,
): Promise<ChangePassphraseResponse> {
  const masterKey = getMasterKey();
  const oldSecretBuffer = Buffer.from(oldSessionSecret, 'hex');
  const oldKEK = deriveKEK(masterKey, userId, oldSecretBuffer);

  const User = mongoose.models.User;
  const user = await User.findById(userId).select('+encryptedUEK').lean<IUser>();
  if (!user?.encryptedUEK) {
    const err = Object.assign(new Error('Encryption not configured'), {
      code: 'encryption_not_configured',
      status: 404,
    });
    throw err;
  }

  let uek: Buffer;
  try {
    uek = unwrapUEK(user.encryptedUEK, oldKEK);
  } catch {
    const err = Object.assign(new Error('Invalid current passphrase'), {
      code: 'invalid_passphrase',
      status: 401,
    });
    throw err;
  }

  const newSalt = generatePassphraseSalt();
  const newSaltHex = newSalt.toString('hex');
  const newSecretBuffer = Buffer.from(newSessionSecret, 'hex');
  const newKEK = deriveKEK(masterKey, userId, newSecretBuffer);
  const newWrappedUEK = wrapUEK(uek, newKEK);

  await User.findByIdAndUpdate(userId, {
    $set: { encryptedUEK: newWrappedUEK, passphraseSalt: newSaltHex },
  });

  // Refresh the cached UEK with the same key (it hasn't changed)
  userKeyCache.setUEK(userId, uek);
  return { status: 'passphrase_changed', newPassphraseSalt: newSaltHex };
}

/**
 * POST /api/auth/reset-encryption
 * Deletes all encrypted user data and clears encryption configuration.
 * Requires `{ confirm: true }` in the request body.
 */
export async function resetEncryption(
  mongoose: typeof import('mongoose'),
  userId: string,
  { confirm }: ResetEncryptionRequest,
): Promise<ResetEncryptionResponse> {
  if (!confirm) {
    const err = Object.assign(new Error('Reset must be confirmed'), {
      code: 'confirmation_required',
      status: 400,
    });
    throw err;
  }

  const { Message, Conversation, File, MemoryEntry, ToolCall } = mongoose.models;

  const userFilter: FilterQuery<unknown> = { user: userId };
  const userFilterAlt: FilterQuery<unknown> = { userId };

  const [messages, conversations, files, memories, toolcalls] = await Promise.all([
    Message ? Message.deleteMany({ ...userFilter, encryptionVersion: 1 }) : { deletedCount: 0 },
    Conversation
      ? Conversation.deleteMany({ ...userFilter, encryptionVersion: 1 })
      : { deletedCount: 0 },
    File ? File.deleteMany({ ...userFilter, encryptionVersion: 1 }) : { deletedCount: 0 },
    MemoryEntry
      ? MemoryEntry.deleteMany({ ...userFilterAlt, encryptionVersion: 1 })
      : { deletedCount: 0 },
    ToolCall
      ? ToolCall.deleteMany({ ...userFilter, encryptionVersion: 1 })
      : { deletedCount: 0 },
  ]);

  const User = mongoose.models.User;
  await User.findByIdAndUpdate(userId, {
    $unset: { encryptedUEK: '', passphraseSalt: '' },
    $set: { encryptionVersion: 0 },
  });

  userKeyCache.evict(userId);
  clearFailures(userId);

  const deletedCount = (result: unknown): number =>
    (result as { deletedCount: number }).deletedCount;

  return {
    status: 'encryption_reset',
    deletedData: {
      messages: deletedCount(messages),
      conversations: deletedCount(conversations),
      files: deletedCount(files),
      memories: deletedCount(memories),
      toolcalls: deletedCount(toolcalls),
    },
  };
}

/**
 * Encryption middleware for Express: retrieves the cached UEK for the authenticated user
 * and populates the AsyncLocalStorage encryption context for Mongoose hooks.
 *
 * Must be called after `requireJwtAuth` so `req.user` is available.
 */
export { userKeyCache } from '~/crypto/keyCache';
export { encryptionStore } from '@librechat/data-schemas';
export { encryptUserData, decryptUserData, isEncrypted } from '~/crypto';
