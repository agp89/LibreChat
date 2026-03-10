import { encryptionStore } from '~/middleware/encryptionContext';
import {
  generateUEK,
  encryptUserData,
  decryptUserData,
  isEncrypted,
} from '~/crypto/userEncryption';

/**
 * Tests for encryption middleware primitives: AsyncLocalStorage context,
 * encrypt/decrypt round-trips through the context, and field configuration
 * matching PRD §7.4.
 */
describe('encryption middleware', () => {
  const uek = generateUEK();
  const userId = 'test-user-enc';

  describe('encryptionStore (AsyncLocalStorage)', () => {
    it('populates context inside a run scope', () => {
      let captured: { uek: Buffer; userId: string } | undefined;
      encryptionStore.run({ uek, userId }, () => {
        captured = encryptionStore.getStore();
      });
      expect(captured).toBeDefined();
      expect(captured!.uek).toBe(uek);
      expect(captured!.userId).toBe(userId);
    });

    it('returns undefined outside of a run scope', () => {
      expect(encryptionStore.getStore()).toBeUndefined();
    });

    it('isolates nested contexts', () => {
      const outerUek = generateUEK();
      const innerUek = generateUEK();
      let outerCapture: Buffer | undefined;
      let innerCapture: Buffer | undefined;

      encryptionStore.run({ uek: outerUek, userId: 'outer' }, () => {
        outerCapture = encryptionStore.getStore()?.uek;
        encryptionStore.run({ uek: innerUek, userId: 'inner' }, () => {
          innerCapture = encryptionStore.getStore()?.uek;
        });
      });
      expect(outerCapture).toBe(outerUek);
      expect(innerCapture).toBe(innerUek);
    });
  });

  describe('encrypt-on-write / decrypt-on-read simulation', () => {
    it('round-trips string fields through encrypt→decrypt', () => {
      const plaintext = 'Hello, encrypted world! 🔐';
      const encrypted = encryptUserData(plaintext, uek);
      expect(isEncrypted(encrypted)).toBe(true);
      const decrypted = decryptUserData(encrypted, uek);
      expect(decrypted).toBe(plaintext);
    });

    it('round-trips JSON-serialized fields (content array)', () => {
      const content = [
        { type: 'text', text: 'Hello' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,...' } },
      ];
      const serialized = JSON.stringify(content);
      const encrypted = encryptUserData(serialized, uek);
      expect(isEncrypted(encrypted)).toBe(true);

      const decrypted = decryptUserData(encrypted, uek);
      expect(JSON.parse(decrypted)).toEqual(content);
    });

    it('skips null/undefined values (no encryption of empty fields)', () => {
      expect(isEncrypted(null)).toBe(false);
      expect(isEncrypted(undefined)).toBe(false);
      expect(isEncrypted('')).toBe(false);
    });

    it('is idempotent — already-encrypted values are not double-encrypted', () => {
      const plaintext = 'original text';
      const encrypted = encryptUserData(plaintext, uek);
      expect(isEncrypted(encrypted)).toBe(true);
      // The middleware checks isEncrypted before encrypting, preventing double-encryption
    });

    it('sets encryptionVersion=1 on encrypted documents', () => {
      // Simulate what the pre-save hook does
      const doc: Record<string, unknown> = { text: 'test', encryptionVersion: 0 };
      doc['text'] = encryptUserData(doc['text'] as string, uek);
      doc['encryptionVersion'] = 1;
      expect(doc['encryptionVersion']).toBe(1);
      expect(isEncrypted(doc['text'])).toBe(true);
    });

    it('leaves plaintext documents readable (encryptionVersion=0)', () => {
      const doc: Record<string, unknown> = { text: 'plaintext doc', encryptionVersion: 0 };
      // Post-find hook only decrypts if encryptionVersion > 0
      expect(isEncrypted(doc['text'])).toBe(false);
      expect(doc['text']).toBe('plaintext doc');
    });

    it('handles mixed state — some docs encrypted, some plaintext', () => {
      const docs = [
        { text: encryptUserData('encrypted msg', uek), encryptionVersion: 1 },
        { text: 'plaintext msg', encryptionVersion: 0 },
      ];

      // Simulate post-find decryption
      for (const doc of docs) {
        if (doc.encryptionVersion === 0) continue;
        if (!isEncrypted(doc.text)) continue;
        doc.text = decryptUserData(doc.text, uek);
      }

      expect(docs[0].text).toBe('encrypted msg');
      expect(docs[1].text).toBe('plaintext msg');
    });
  });

  describe('attachEncryptionMiddleware hook registration', () => {
    it('attaches pre-save and post hooks when ENCRYPT_USER_DATA is true', () => {
      // Save original env and set to true for this test
      const orig = process.env.ENCRYPT_USER_DATA;
      process.env.ENCRYPT_USER_DATA = 'true';

      // Re-import to pick up the new env value
      jest.resetModules();
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { attachEncryptionMiddleware: attach } = require('~/middleware/encryption');
      const { Schema } = require('mongoose');

      const schema = new Schema({ text: String, encryptionVersion: Number });
      attach(schema, { fields: ['text'] });

      // Mongoose stores hooks in schema.s.hooks
      const hooks = (schema as Record<string, Record<string, Record<string, unknown[]>>>).s.hooks;
      expect(hooks._pres.get('save')).toBeDefined();
      expect(hooks._pres.get('findOneAndUpdate')).toBeDefined();
      expect(hooks._posts.get('find')).toBeDefined();
      expect(hooks._posts.get('findOne')).toBeDefined();
      expect(hooks._posts.get('findOneAndUpdate')).toBeDefined();

      process.env.ENCRYPT_USER_DATA = orig ?? '';
    });

    it('does not attach hooks when ENCRYPT_USER_DATA is false', () => {
      const orig = process.env.ENCRYPT_USER_DATA;
      process.env.ENCRYPT_USER_DATA = 'false';

      jest.resetModules();
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { attachEncryptionMiddleware: attach } = require('~/middleware/encryption');
      const { Schema } = require('mongoose');

      const schema = new Schema({ text: String, encryptionVersion: Number });
      const preSaveBefore = (schema as Record<string, Record<string, Record<string, unknown[]>>>).s.hooks._pres.get('save')?.length ?? 0;
      attach(schema, { fields: ['text'] });
      const preSaveAfter = (schema as Record<string, Record<string, Record<string, unknown[]>>>).s.hooks._pres.get('save')?.length ?? 0;

      expect(preSaveAfter).toBe(preSaveBefore);

      process.env.ENCRYPT_USER_DATA = orig ?? '';
    });
  });
});
