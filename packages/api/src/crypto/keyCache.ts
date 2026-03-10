const DEFAULT_TTL_MS = parseInt(process.env.ENCRYPTION_KEY_CACHE_TTL ?? '900000', 10); // 15 min
const EVICTION_INTERVAL_MS = 60_000; // run cleanup every minute

interface CachedKey {
  uek: Buffer;
  expiresAt: number;
}

/**
 * In-memory, TTL-evicting cache for User Encryption Keys (UEKs).
 *
 * Keys are held only for the duration of an active session (default: 15 minutes)
 * and evicted automatically on TTL expiry or explicit logout.
 *
 * For multi-instance deployments, consider replacing with a Redis-backed cache
 * using a shared ephemeral key (see ENCRYPTION_PRD §8.4 / §9).
 */
export class UserKeyCache {
  private readonly cache = new Map<string, CachedKey>();
  private readonly ttlMs: number;
  private readonly evictionTimer: ReturnType<typeof setInterval>;

  constructor(ttlMs: number = DEFAULT_TTL_MS) {
    this.ttlMs = ttlMs;
    this.evictionTimer = setInterval(() => this.evictExpired(), EVICTION_INTERVAL_MS);
    // `unref()` is a Node.js-only API that prevents the timer from keeping the process alive.
    // The optional chain guards against browser/edge runtime environments where it may not exist.
    this.evictionTimer.unref?.();
  }

  /** Stores the UEK for `userId` with a fresh TTL. */
  setUEK(userId: string, uek: Buffer): void {
    this.cache.set(userId, { uek, expiresAt: Date.now() + this.ttlMs });
  }

  /** Returns the UEK for `userId`, or `null` if absent or expired. */
  getUEK(userId: string): Buffer | null {
    const entry = this.cache.get(userId);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(userId);
      return null;
    }
    return entry.uek;
  }

  /** Explicitly removes the UEK for `userId` (called on logout). */
  evict(userId: string): void {
    this.cache.delete(userId);
  }

  /** Removes all expired entries — called on the periodic timer. */
  evictExpired(): void {
    const now = Date.now();
    for (const [userId, entry] of this.cache) {
      if (now > entry.expiresAt) this.cache.delete(userId);
    }
  }

  /** Returns the number of keys currently in the cache (includes potentially expired). */
  get size(): number {
    return this.cache.size;
  }

  /** Stops the background eviction timer. */
  destroy(): void {
    clearInterval(this.evictionTimer);
    this.cache.clear();
  }
}

/** Singleton key cache for the application process. */
export const userKeyCache = new UserKeyCache();
