import { UserKeyCache } from '../keyCache';

describe('UserKeyCache', () => {
  const makeUEK = (fill: number): Buffer => Buffer.alloc(32, fill);

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('setUEK / getUEK', () => {
    it('returns null for a user with no cached key', () => {
      const cache = new UserKeyCache(60_000);
      expect(cache.getUEK('user_1')).toBeNull();
      cache.destroy();
    });

    it('stores and retrieves a UEK', () => {
      const cache = new UserKeyCache(60_000);
      const uek = makeUEK(0x11);
      cache.setUEK('user_1', uek);
      const retrieved = cache.getUEK('user_1');
      expect(retrieved).not.toBeNull();
      expect(retrieved!.toString('hex')).toBe(uek.toString('hex'));
      cache.destroy();
    });

    it('returns the correct UEK for multiple users', () => {
      const cache = new UserKeyCache(60_000);
      const uekA = makeUEK(0xaa);
      const uekB = makeUEK(0xbb);
      cache.setUEK('user_a', uekA);
      cache.setUEK('user_b', uekB);
      expect(cache.getUEK('user_a')!.toString('hex')).toBe(uekA.toString('hex'));
      expect(cache.getUEK('user_b')!.toString('hex')).toBe(uekB.toString('hex'));
      cache.destroy();
    });
  });

  describe('TTL expiry', () => {
    it('returns null after the TTL has passed', () => {
      jest.useFakeTimers();
      const ttlMs = 5_000;
      const cache = new UserKeyCache(ttlMs);
      const uek = makeUEK(0x22);
      cache.setUEK('user_1', uek);

      // Just before expiry
      jest.advanceTimersByTime(ttlMs - 1);
      expect(cache.getUEK('user_1')).not.toBeNull();

      // After expiry
      jest.advanceTimersByTime(2);
      expect(cache.getUEK('user_1')).toBeNull();
      cache.destroy();
    });

    it('refreshes TTL on setUEK', () => {
      jest.useFakeTimers();
      const ttlMs = 5_000;
      const cache = new UserKeyCache(ttlMs);
      const uek = makeUEK(0x33);
      cache.setUEK('user_1', uek);

      // Advance past initial TTL
      jest.advanceTimersByTime(ttlMs - 1_000);
      // Re-set the key (refreshes TTL)
      cache.setUEK('user_1', uek);
      jest.advanceTimersByTime(ttlMs - 1_000);
      // Should still be valid (new TTL from the re-set)
      expect(cache.getUEK('user_1')).not.toBeNull();
      cache.destroy();
    });
  });

  describe('evict', () => {
    it('removes a specific user key', () => {
      const cache = new UserKeyCache(60_000);
      cache.setUEK('user_1', makeUEK(0x11));
      cache.setUEK('user_2', makeUEK(0x22));
      cache.evict('user_1');
      expect(cache.getUEK('user_1')).toBeNull();
      expect(cache.getUEK('user_2')).not.toBeNull();
      cache.destroy();
    });

    it('is a no-op for a non-existent user', () => {
      const cache = new UserKeyCache(60_000);
      expect(() => cache.evict('nonexistent')).not.toThrow();
      cache.destroy();
    });
  });

  describe('evictExpired', () => {
    it('removes expired entries and keeps valid ones', () => {
      jest.useFakeTimers();
      const ttlMs = 5_000;
      const cache = new UserKeyCache(ttlMs);
      cache.setUEK('expired_user', makeUEK(0x11));
      cache.setUEK('active_user', makeUEK(0x22));

      // Expire the first key
      jest.advanceTimersByTime(ttlMs + 1);
      // Add a fresh key for active_user
      cache.setUEK('active_user', makeUEK(0x22));

      cache.evictExpired();
      expect(cache.getUEK('expired_user')).toBeNull();
      expect(cache.getUEK('active_user')).not.toBeNull();
      cache.destroy();
    });
  });

  describe('size', () => {
    it('reflects the number of cached entries', () => {
      const cache = new UserKeyCache(60_000);
      expect(cache.size).toBe(0);
      cache.setUEK('user_1', makeUEK(0x11));
      expect(cache.size).toBe(1);
      cache.setUEK('user_2', makeUEK(0x22));
      expect(cache.size).toBe(2);
      cache.evict('user_1');
      expect(cache.size).toBe(1);
      cache.destroy();
    });
  });

  describe('destroy', () => {
    it('clears all entries', () => {
      const cache = new UserKeyCache(60_000);
      cache.setUEK('user_1', makeUEK(0x11));
      cache.setUEK('user_2', makeUEK(0x22));
      cache.destroy();
      expect(cache.size).toBe(0);
    });
  });
});
