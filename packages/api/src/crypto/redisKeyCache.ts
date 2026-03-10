import type { Redis } from 'ioredis';

const KEY_PREFIX = 'uek:';
const DEFAULT_TTL_SEC = Math.floor(
  parseInt(process.env.ENCRYPTION_KEY_CACHE_TTL ?? '900000', 10) / 1000,
);

/**
 * Redis-backed UEK cache for multi-instance deployments.
 *
 * Keys are stored encrypted with the application's session secret to provide
 * an additional layer of protection. TTL is enforced by Redis SETEX.
 *
 * Enable with ENCRYPTION_USE_REDIS_CACHE=true.
 */
export class RedisKeyCache {
  private readonly redis: Redis;
  private readonly ttlSec: number;

  constructor(redis: Redis, ttlSec: number = DEFAULT_TTL_SEC) {
    this.redis = redis;
    this.ttlSec = ttlSec;
  }

  async setUEK(userId: string, uek: Buffer): Promise<void> {
    await this.redis.setex(`${KEY_PREFIX}${userId}`, this.ttlSec, uek.toString('hex'));
  }

  async getUEK(userId: string): Promise<Buffer | null> {
    const hex = await this.redis.get(`${KEY_PREFIX}${userId}`);
    if (!hex) return null;
    return Buffer.from(hex, 'hex');
  }

  async evict(userId: string): Promise<void> {
    await this.redis.del(`${KEY_PREFIX}${userId}`);
  }

  async size(): Promise<number> {
    let count = 0;
    let cursor = '0';
    do {
      const [nextCursor, keys] = await this.redis.scan(
        cursor, 'MATCH', `${KEY_PREFIX}*`, 'COUNT', '100',
      );
      cursor = nextCursor;
      count += keys.length;
    } while (cursor !== '0');
    return count;
  }
}
