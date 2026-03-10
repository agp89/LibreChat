import {
  generatePassphraseSalt,
  deriveKEK,
  generateUEK,
  wrapUEK,
  unwrapUEK,
  encryptUserData,
  decryptUserData,
  isEncrypted,
  deriveTagBlindIndex,
} from '../userEncryption';

describe('userEncryption crypto primitives', () => {
  // Fixed test vectors for deterministic checks
  const masterKey = Buffer.alloc(32, 0xab);
  const userId = 'user_test_123';
  const sessionSecret = Buffer.alloc(32, 0xcd);

  // ---------- generatePassphraseSalt ----------

  describe('generatePassphraseSalt', () => {
    it('returns a 32-byte Buffer', () => {
      const salt = generatePassphraseSalt();
      expect(salt).toBeInstanceOf(Buffer);
      expect(salt.byteLength).toBe(32);
    });

    it('generates unique salts each call', () => {
      const a = generatePassphraseSalt();
      const b = generatePassphraseSalt();
      expect(a.toString('hex')).not.toBe(b.toString('hex'));
    });
  });

  // ---------- deriveKEK ----------

  describe('deriveKEK', () => {
    it('returns a 32-byte Buffer', () => {
      const kek = deriveKEK(masterKey, userId, sessionSecret);
      expect(kek).toBeInstanceOf(Buffer);
      expect(kek.byteLength).toBe(32);
    });

    it('is deterministic for the same inputs', () => {
      const a = deriveKEK(masterKey, userId, sessionSecret);
      const b = deriveKEK(masterKey, userId, sessionSecret);
      expect(a.toString('hex')).toBe(b.toString('hex'));
    });

    it('differs for different userIds', () => {
      const a = deriveKEK(masterKey, 'user_a', sessionSecret);
      const b = deriveKEK(masterKey, 'user_b', sessionSecret);
      expect(a.toString('hex')).not.toBe(b.toString('hex'));
    });

    it('differs for different sessionSecrets', () => {
      const secretA = Buffer.alloc(32, 0x01);
      const secretB = Buffer.alloc(32, 0x02);
      const a = deriveKEK(masterKey, userId, secretA);
      const b = deriveKEK(masterKey, userId, secretB);
      expect(a.toString('hex')).not.toBe(b.toString('hex'));
    });

    it('differs for different masterKeys', () => {
      const keyA = Buffer.alloc(32, 0xaa);
      const keyB = Buffer.alloc(32, 0xbb);
      const a = deriveKEK(keyA, userId, sessionSecret);
      const b = deriveKEK(keyB, userId, sessionSecret);
      expect(a.toString('hex')).not.toBe(b.toString('hex'));
    });
  });

  // ---------- generateUEK ----------

  describe('generateUEK', () => {
    it('returns a 32-byte Buffer', () => {
      const uek = generateUEK();
      expect(uek).toBeInstanceOf(Buffer);
      expect(uek.byteLength).toBe(32);
    });

    it('generates unique keys each call', () => {
      const a = generateUEK();
      const b = generateUEK();
      expect(a.toString('hex')).not.toBe(b.toString('hex'));
    });
  });

  // ---------- wrapUEK / unwrapUEK ----------

  describe('wrapUEK / unwrapUEK', () => {
    it('round-trips: unwrap(wrap(uek, kek), kek) === uek', () => {
      const kek = deriveKEK(masterKey, userId, sessionSecret);
      const uek = generateUEK();
      const wrapped = wrapUEK(uek, kek);
      const unwrapped = unwrapUEK(wrapped, kek);
      expect(unwrapped.toString('hex')).toBe(uek.toString('hex'));
    });

    it('wrapped format starts with "enc1:"', () => {
      const kek = deriveKEK(masterKey, userId, sessionSecret);
      const uek = generateUEK();
      const wrapped = wrapUEK(uek, kek);
      expect(wrapped.startsWith('enc1:')).toBe(true);
    });

    it('wrapped format has 4 colon-separated parts', () => {
      const kek = deriveKEK(masterKey, userId, sessionSecret);
      const uek = generateUEK();
      const wrapped = wrapUEK(uek, kek);
      expect(wrapped.split(':').length).toBe(4);
    });

    it('produces different ciphertext each call (random IV)', () => {
      const kek = deriveKEK(masterKey, userId, sessionSecret);
      const uek = generateUEK();
      const a = wrapUEK(uek, kek);
      const b = wrapUEK(uek, kek);
      expect(a).not.toBe(b);
    });

    it('throws on wrong KEK (GCM auth tag mismatch = wrong passphrase)', () => {
      const kek = deriveKEK(masterKey, userId, sessionSecret);
      const wrongKEK = deriveKEK(masterKey, userId, Buffer.alloc(32, 0xff));
      const uek = generateUEK();
      const wrapped = wrapUEK(uek, kek);
      expect(() => unwrapUEK(wrapped, wrongKEK)).toThrow();
    });

    it('throws on invalid format', () => {
      const kek = deriveKEK(masterKey, userId, sessionSecret);
      expect(() => unwrapUEK('not_valid', kek)).toThrow('Invalid wrapped UEK format');
      expect(() => unwrapUEK('v3:a:b:c', kek)).toThrow('Invalid wrapped UEK format');
    });
  });

  // ---------- encryptUserData / decryptUserData ----------

  describe('encryptUserData / decryptUserData', () => {
    const uek = Buffer.alloc(32, 0x42);
    const plaintext = 'Hello, World! 🔐 This is sensitive user content.';

    it('round-trips: decrypt(encrypt(plain, uek), uek) === plain', () => {
      const ciphertext = encryptUserData(plaintext, uek);
      const decrypted = decryptUserData(ciphertext, uek);
      expect(decrypted).toBe(plaintext);
    });

    it('ciphertext starts with "enc1:"', () => {
      const ciphertext = encryptUserData(plaintext, uek);
      expect(ciphertext.startsWith('enc1:')).toBe(true);
    });

    it('ciphertext has 4 colon-separated parts', () => {
      const ciphertext = encryptUserData(plaintext, uek);
      expect(ciphertext.split(':').length).toBe(4);
    });

    it('produces different ciphertext each call (random IV)', () => {
      const a = encryptUserData(plaintext, uek);
      const b = encryptUserData(plaintext, uek);
      expect(a).not.toBe(b);
    });

    it('throws on wrong UEK (GCM auth tag mismatch)', () => {
      const ciphertext = encryptUserData(plaintext, uek);
      const wrongUEK = Buffer.alloc(32, 0x99);
      expect(() => decryptUserData(ciphertext, wrongUEK)).toThrow();
    });

    it('throws when ciphertext is tampered', () => {
      const ciphertext = encryptUserData(plaintext, uek);
      // Replace the last character of the ciphertext hex to corrupt it
      const tampered = ciphertext.slice(0, -1) + (ciphertext.endsWith('0') ? '1' : '0');
      expect(() => decryptUserData(tampered, uek)).toThrow();
    });

    it('throws on invalid format', () => {
      expect(() => decryptUserData('not_valid', uek)).toThrow('Invalid encrypted data format');
      expect(() => decryptUserData('v3:a:b:c', uek)).toThrow('Invalid encrypted data format');
    });

    it('handles empty string', () => {
      const ciphertext = encryptUserData('', uek);
      expect(decryptUserData(ciphertext, uek)).toBe('');
    });

    it('handles unicode and long strings', () => {
      const long = '日本語テスト'.repeat(500);
      const ciphertext = encryptUserData(long, uek);
      expect(decryptUserData(ciphertext, uek)).toBe(long);
    });
  });

  // ---------- isEncrypted ----------

  describe('isEncrypted', () => {
    const uek = Buffer.alloc(32, 0x42);

    it('returns true for enc1-formatted strings', () => {
      const ciphertext = encryptUserData('test', uek);
      expect(isEncrypted(ciphertext)).toBe(true);
    });

    it('returns false for plaintext strings', () => {
      expect(isEncrypted('Hello World')).toBe(false);
      expect(isEncrypted('v3:abc:def')).toBe(false);
      expect(isEncrypted('')).toBe(false);
    });

    it('returns false for non-string values', () => {
      expect(isEncrypted(null)).toBe(false);
      expect(isEncrypted(undefined)).toBe(false);
      expect(isEncrypted(42)).toBe(false);
      expect(isEncrypted({})).toBe(false);
    });
  });

  // ---------- deriveTagBlindIndex ----------

  describe('deriveTagBlindIndex', () => {
    const uek = Buffer.alloc(32, 0x42);

    it('returns a 64-character hex string', () => {
      const idx = deriveTagBlindIndex('Work', uek);
      expect(idx).toMatch(/^[0-9a-f]{64}$/);
    });

    it('is deterministic', () => {
      const a = deriveTagBlindIndex('Work', uek);
      const b = deriveTagBlindIndex('Work', uek);
      expect(a).toBe(b);
    });

    it('is case-insensitive (lowercases before hashing)', () => {
      const lower = deriveTagBlindIndex('work', uek);
      const upper = deriveTagBlindIndex('WORK', uek);
      const mixed = deriveTagBlindIndex('Work', uek);
      expect(lower).toBe(upper);
      expect(lower).toBe(mixed);
    });

    it('differs for different tags', () => {
      const a = deriveTagBlindIndex('Work', uek);
      const b = deriveTagBlindIndex('Personal', uek);
      expect(a).not.toBe(b);
    });

    it('differs for different UEKs', () => {
      const uek2 = Buffer.alloc(32, 0x99);
      const a = deriveTagBlindIndex('Work', uek);
      const b = deriveTagBlindIndex('Work', uek2);
      expect(a).not.toBe(b);
    });
  });

  // ---------- Cross-user isolation ----------

  describe('cross-user key isolation', () => {
    it("User A's passphrase cannot decrypt User B's data", () => {
      const masterKeyAB = Buffer.alloc(32, 0x11);
      const sessionA = Buffer.alloc(32, 0xaa);
      const sessionB = Buffer.alloc(32, 0xbb);
      const kekA = deriveKEK(masterKeyAB, 'userA', sessionA);
      const kekB = deriveKEK(masterKeyAB, 'userB', sessionB);

      const uekA = generateUEK();
      const uekB = generateUEK();
      const wrappedA = wrapUEK(uekA, kekA);
      const wrappedB = wrapUEK(uekB, kekB);

      // A's KEK cannot unwrap B's wrapped UEK
      expect(() => unwrapUEK(wrappedB, kekA)).toThrow();
      // B's KEK cannot unwrap A's wrapped UEK
      expect(() => unwrapUEK(wrappedA, kekB)).toThrow();

      // A's UEK cannot decrypt B's data
      const dataA = encryptUserData('Secret for A', uekA);
      expect(() => decryptUserData(dataA, uekB)).toThrow();
    });
  });
});
