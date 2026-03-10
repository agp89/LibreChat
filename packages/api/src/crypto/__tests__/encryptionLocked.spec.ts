/**
 * Tests for 403 encryption_locked middleware behavior (PRD §8.2).
 *
 * Tests the logic that the requireEncryptionUnlock middleware implements:
 * when ENCRYPT_USER_DATA is enabled and a user has encryption configured
 * (encryptionVersion === 1) but UEK is not in cache, return 403.
 */

import crypto from 'node:crypto';
import { UserKeyCache } from '~/crypto/keyCache';

describe('encryption_locked detection (PRD §8.2)', () => {
  const userId = 'user-403-test';
  const cache = new UserKeyCache(30_000);

  afterEach(() => {
    cache.evict(userId);
  });

  afterAll(() => {
    cache.destroy();
  });

  function generateUEK(): Buffer {
    return crypto.randomBytes(32);
  }

  it('UEK is retrievable when cached', () => {
    const uek = generateUEK();
    cache.setUEK(userId, uek);
    expect(cache.getUEK(userId)).toEqual(uek);
  });

  it('UEK returns null when not cached', () => {
    expect(cache.getUEK(userId)).toBeNull();
  });

  it('UEK returns null after eviction', () => {
    const uek = generateUEK();
    cache.setUEK(userId, uek);
    cache.evict(userId);
    expect(cache.getUEK(userId)).toBeNull();
  });

  it('simulates encryption_locked flow — no UEK means locked', () => {
    const isLocked = (uid: string, hasEncryption: boolean): boolean => {
      const uek = cache.getUEK(uid);
      if (uek) return false; // unlocked
      if (!hasEncryption) return false; // not configured
      return true; // locked
    };

    // No encryption configured — not locked
    expect(isLocked(userId, false)).toBe(false);

    // Encryption configured, UEK not cached — locked
    expect(isLocked(userId, true)).toBe(true);

    // Encryption configured, UEK cached — not locked
    const uek = generateUEK();
    cache.setUEK(userId, uek);
    expect(isLocked(userId, true)).toBe(false);
  });

  it('different users have independent lock state', () => {
    const user1 = 'user-403-a';
    const user2 = 'user-403-b';
    const uek = generateUEK();

    cache.setUEK(user1, uek);

    expect(cache.getUEK(user1)).toBeDefined();
    expect(cache.getUEK(user2)).toBeNull();

    cache.evict(user1);
    cache.evict(user2);
  });
});
