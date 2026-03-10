import crypto from 'node:crypto';

const CIPHER_ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const KEY_BYTES = 32;
const HKDF_INFO = 'librechat-kek';
const CIPHERTEXT_VERSION = 'enc1';

/**
 * Generates a random 32-byte salt for PBKDF2 client-side key derivation.
 * Stored (hex-encoded) in the User document as `passphraseSalt`.
 */
export function generatePassphraseSalt(): Buffer {
  return crypto.randomBytes(KEY_BYTES);
}

/**
 * Derives the Key Encryption Key (KEK) from the ENCRYPTION_MASTER_KEY,
 * the user's MongoDB `_id`, and the passphrase-derived `sessionSecret`.
 *
 * KEK = HKDF-SHA-256(ikm=masterKey, salt=userId+sessionSecret, info="librechat-kek")
 *
 * The `sessionSecret` is derived client-side via PBKDF2 and sent once per session.
 * Without the user's passphrase, no admin can derive this KEK offline.
 */
export function deriveKEK(masterKey: Buffer, userId: string, sessionSecret: Buffer): Buffer {
  const salt = Buffer.concat([Buffer.from(userId, 'utf8'), sessionSecret]);
  return Buffer.from(crypto.hkdfSync('sha256', masterKey, salt, HKDF_INFO, KEY_BYTES));
}

/**
 * Generates a random 256-bit User Encryption Key (UEK).
 * Generated once per user; stored wrapped in the User document.
 */
export function generateUEK(): Buffer {
  return crypto.randomBytes(KEY_BYTES);
}

/**
 * Wraps (encrypts) a UEK with the KEK using AES-256-GCM.
 * Returns the wrapped key as an "enc1:<iv>:<tag>:<ciphertext>" string for storage.
 */
export function wrapUEK(uek: Buffer, kek: Buffer): string {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(CIPHER_ALGORITHM, kek, iv);
  const encrypted = Buffer.concat([cipher.update(uek), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${CIPHERTEXT_VERSION}:${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
}

/**
 * Unwraps (decrypts) a wrapped UEK using the KEK.
 * Throws if the KEK is wrong (GCM auth tag mismatch — wrong passphrase).
 */
export function unwrapUEK(wrappedUEK: string, kek: Buffer): Buffer {
  const parts = wrappedUEK.split(':');
  if (parts.length !== 4 || parts[0] !== CIPHERTEXT_VERSION) {
    throw new Error('Invalid wrapped UEK format');
  }
  const iv = Buffer.from(parts[1], 'hex');
  const authTag = Buffer.from(parts[2], 'hex');
  const ciphertext = Buffer.from(parts[3], 'hex');
  const decipher = crypto.createDecipheriv(CIPHER_ALGORITHM, kek, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/**
 * Encrypts a plaintext string using AES-256-GCM with the user's UEK.
 * Returns a versioned ciphertext string: "enc1:<iv_hex>:<tag_hex>:<ciphertext_hex>"
 */
export function encryptUserData(plaintext: string, uek: Buffer): string {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(CIPHER_ALGORITHM, uek, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${CIPHERTEXT_VERSION}:${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
}

/**
 * Decrypts a versioned ciphertext string using AES-256-GCM with the user's UEK.
 * Throws on auth tag mismatch (tampered data or wrong key).
 */
export function decryptUserData(ciphertext: string, uek: Buffer): string {
  const parts = ciphertext.split(':');
  if (parts.length !== 4 || parts[0] !== CIPHERTEXT_VERSION) {
    throw new Error('Invalid encrypted data format');
  }
  const iv = Buffer.from(parts[1], 'hex');
  const authTag = Buffer.from(parts[2], 'hex');
  const encrypted = Buffer.from(parts[3], 'hex');
  const decipher = crypto.createDecipheriv(CIPHER_ALGORITHM, uek, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

/**
 * Returns true if the given value is an enc1-formatted ciphertext string.
 */
export function isEncrypted(value: unknown): boolean {
  return typeof value === 'string' && value.startsWith(`${CIPHERTEXT_VERSION}:`);
}

/**
 * Derives HMAC-SHA-256 blind index for a tag using the UEK.
 * Used for tag filtering without exposing plaintext tag values.
 */
export function deriveTagBlindIndex(tag: string, uek: Buffer): string {
  return crypto
    .createHmac('sha256', uek)
    .update(tag.toLowerCase())
    .digest('hex');
}
