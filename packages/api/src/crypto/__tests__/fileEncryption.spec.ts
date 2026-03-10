/**
 * Tests for file binary encryption (PRD §7.6).
 *
 * Validates the ENC1 header format, AES-256-GCM encrypt/decrypt round-trips,
 * tamper detection, and the `isEncryptedFile` detection helper.
 */
import crypto from 'node:crypto';
import {
  encryptFileBuffer,
  decryptFileBuffer,
  isEncryptedFile,
} from '~/crypto/fileEncryption';

const UEK = crypto.randomBytes(32);

describe('file binary encryption (PRD §7.6)', () => {
  const plaintext = Buffer.from('Hello, encrypted file world! 🔒');

  it('encrypts and decrypts a buffer round-trip', () => {
    const encrypted = encryptFileBuffer(plaintext, UEK);
    const decrypted = decryptFileBuffer(encrypted, UEK);
    expect(decrypted).toEqual(plaintext);
  });

  it('starts with ENC1 magic header', () => {
    const encrypted = encryptFileBuffer(plaintext, UEK);
    expect(encrypted.subarray(0, 4).toString('ascii')).toBe('ENC1');
  });

  it('contains a valid JSON header', () => {
    const encrypted = encryptFileBuffer(plaintext, UEK);
    const headerLen = encrypted.readUInt32BE(4);
    const header = JSON.parse(encrypted.subarray(8, 8 + headerLen).toString('utf8'));
    expect(header).toHaveProperty('iv');
    expect(header).toHaveProperty('tag');
    expect(header).toHaveProperty('origSize');
    expect(header.origSize).toBe(plaintext.length);
  });

  it('produces different ciphertext for the same plaintext (random IV)', () => {
    const enc1 = encryptFileBuffer(plaintext, UEK);
    const enc2 = encryptFileBuffer(plaintext, UEK);
    expect(enc1).not.toEqual(enc2);
  });

  it('fails to decrypt with a wrong key', () => {
    const wrongKey = crypto.randomBytes(32);
    const encrypted = encryptFileBuffer(plaintext, UEK);
    expect(() => decryptFileBuffer(encrypted, wrongKey)).toThrow();
  });

  it('detects tampered ciphertext', () => {
    const encrypted = encryptFileBuffer(plaintext, UEK);
    // Flip a byte near the end (in the ciphertext region)
    encrypted[encrypted.length - 1] ^= 0xff;
    expect(() => decryptFileBuffer(encrypted, UEK)).toThrow();
  });

  it('handles empty buffers', () => {
    const empty = Buffer.alloc(0);
    const encrypted = encryptFileBuffer(empty, UEK);
    const decrypted = decryptFileBuffer(encrypted, UEK);
    expect(decrypted.length).toBe(0);
  });

  it('handles large buffers (1 MB)', () => {
    const large = crypto.randomBytes(1024 * 1024);
    const encrypted = encryptFileBuffer(large, UEK);
    const decrypted = decryptFileBuffer(encrypted, UEK);
    expect(decrypted).toEqual(large);
  });

  describe('isEncryptedFile', () => {
    it('returns true for encrypted files', () => {
      const encrypted = encryptFileBuffer(plaintext, UEK);
      expect(isEncryptedFile(encrypted)).toBe(true);
    });

    it('returns false for plaintext', () => {
      expect(isEncryptedFile(plaintext)).toBe(false);
    });

    it('returns false for empty buffer', () => {
      expect(isEncryptedFile(Buffer.alloc(0))).toBe(false);
    });

    it('returns false for short buffer', () => {
      expect(isEncryptedFile(Buffer.from('EN'))).toBe(false);
    });
  });

  describe('error handling', () => {
    it('throws on non-encrypted buffer', () => {
      expect(() => decryptFileBuffer(plaintext, UEK)).toThrow('Not an encrypted file');
    });

    it('throws on truncated header', () => {
      const encrypted = encryptFileBuffer(plaintext, UEK);
      const truncated = encrypted.subarray(0, 6); // Only magic + partial header length
      expect(() => decryptFileBuffer(truncated, UEK)).toThrow();
    });
  });
});
