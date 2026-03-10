/**
 * Tests for client-side encryption utilities (PRD §15.5).
 *
 * `deriveSessionSecret` uses the WebCrypto API (PBKDF2).
 * In the jsdom test environment, we provide a polyfill via Node.js crypto.
 */
import { validatePassphraseLength } from '~/utils/encryption';

// Mock TextEncoder if not available in test env
if (typeof globalThis.TextEncoder === 'undefined') {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { TextEncoder } = require('util');
  globalThis.TextEncoder = TextEncoder;
}

// Polyfill crypto.subtle for jsdom using Node.js webcrypto
if (!globalThis.crypto?.subtle) {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { webcrypto } = require('crypto');
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto });
}

describe('encryption client utilities (PRD §15.5)', () => {
  describe('validatePassphraseLength', () => {
    it('rejects too-short passphrases (< 12 chars)', () => {
      const result = validatePassphraseLength('short');
      expect(result.valid).toBe(false);
      expect(result.error).toBe('too_short');
    });

    it('rejects too-long passphrases (> 128 chars)', () => {
      const long = 'a'.repeat(129);
      const result = validatePassphraseLength(long);
      expect(result.valid).toBe(false);
      expect(result.error).toBe('too_long');
    });

    it('accepts valid-length passphrases', () => {
      const result = validatePassphraseLength('this is a valid passphrase');
      expect(result.valid).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('accepts exactly 12 characters', () => {
      expect(validatePassphraseLength('123456789012').valid).toBe(true);
    });

    it('accepts exactly 128 characters', () => {
      expect(validatePassphraseLength('a'.repeat(128)).valid).toBe(true);
    });

    it('respects custom min/max', () => {
      expect(validatePassphraseLength('abc', 2, 5).valid).toBe(true);
      expect(validatePassphraseLength('a', 2, 5).valid).toBe(false);
      expect(validatePassphraseLength('abcdef', 2, 5).valid).toBe(false);
    });
  });

  describe('deriveSessionSecret', () => {
    // Dynamic import since it depends on crypto.subtle
    let deriveSessionSecret: (passphrase: string, saltHex: string, iterations?: number) => Promise<string>;

    beforeAll(async () => {
      const mod = await import('~/utils/encryption');
      deriveSessionSecret = mod.deriveSessionSecret;
    });

    it('produces a 64-character hex string (256-bit)', async () => {
      const salt = 'ab'.repeat(32); // 64 hex chars = 32 bytes
      const result = await deriveSessionSecret('test passphrase!', salt, 1000);
      expect(result).toMatch(/^[0-9a-f]{64}$/);
    });

    it('is deterministic for the same inputs', async () => {
      const salt = 'cd'.repeat(32);
      const a = await deriveSessionSecret('my encryption pass', salt, 1000);
      const b = await deriveSessionSecret('my encryption pass', salt, 1000);
      expect(a).toBe(b);
    });

    it('produces different output for different passphrases', async () => {
      const salt = 'ef'.repeat(32);
      const a = await deriveSessionSecret('passphrase one!', salt, 1000);
      const b = await deriveSessionSecret('passphrase two!', salt, 1000);
      expect(a).not.toBe(b);
    });

    it('produces different output for different salts', async () => {
      const salt1 = 'aa'.repeat(32);
      const salt2 = 'bb'.repeat(32);
      const a = await deriveSessionSecret('same passphrase!', salt1, 1000);
      const b = await deriveSessionSecret('same passphrase!', salt2, 1000);
      expect(a).not.toBe(b);
    });

    it('produces different output for different iteration counts', async () => {
      const salt = '11'.repeat(32);
      const a = await deriveSessionSecret('test passphrase!', salt, 1000);
      const b = await deriveSessionSecret('test passphrase!', salt, 2000);
      expect(a).not.toBe(b);
    });
  });
});
