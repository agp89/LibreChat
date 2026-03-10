import crypto from 'node:crypto';

const CIPHER_ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const FILE_MAGIC = Buffer.from('ENC1');

/**
 * Encrypts a file buffer using AES-256-GCM with the user's UEK.
 * Format: [4B magic "ENC1"][4B header length][JSON header][ciphertext]
 * The JSON header contains { iv, tag, origSize } in hex.
 *
 * PRD §7.6: Application-layer file binary encryption.
 */
export function encryptFileBuffer(plaintext: Buffer, uek: Buffer): Buffer {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(CIPHER_ALGORITHM, uek, iv, {
    authTagLength: AUTH_TAG_BYTES,
  });
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();

  const header = JSON.stringify({
    iv: iv.toString('hex'),
    tag: authTag.toString('hex'),
    origSize: plaintext.length,
  });
  const headerBuf = Buffer.from(header, 'utf8');
  const headerLenBuf = Buffer.alloc(4);
  headerLenBuf.writeUInt32BE(headerBuf.length, 0);

  return Buffer.concat([FILE_MAGIC, headerLenBuf, headerBuf, encrypted]);
}

/**
 * Decrypts a file buffer produced by `encryptFileBuffer`.
 * Validates the ENC1 magic header and GCM auth tag.
 */
export function decryptFileBuffer(data: Buffer, uek: Buffer): Buffer {
  if (data.length < 8 || !data.subarray(0, 4).equals(FILE_MAGIC)) {
    throw new Error('Not an encrypted file (missing ENC1 header)');
  }

  const headerLen = data.readUInt32BE(4);
  const headerEnd = 8 + headerLen;
  if (data.length < headerEnd) {
    throw new Error('Encrypted file header truncated');
  }

  const header = JSON.parse(data.subarray(8, headerEnd).toString('utf8')) as {
    iv: string;
    tag: string;
    origSize: number;
  };

  const iv = Buffer.from(header.iv, 'hex');
  const authTag = Buffer.from(header.tag, 'hex');
  const ciphertext = data.subarray(headerEnd);

  const decipher = crypto.createDecipheriv(CIPHER_ALGORITHM, uek, iv, {
    authTagLength: AUTH_TAG_BYTES,
  });
  decipher.setAuthTag(authTag);

  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/**
 * Returns true if the buffer starts with the ENC1 magic bytes.
 */
export function isEncryptedFile(data: Buffer): boolean {
  return data.length >= 4 && data.subarray(0, 4).equals(FILE_MAGIC);
}
