import { Redis } from 'ioredis';

export interface RateLimitResult {
  count: number;
  resetAt: number;
}

export interface RateLimitStore {
  increment(key: string, windowMs: number): Promise<RateLimitResult>;
}

export class MemoryRateLimitStore implements RateLimitStore {
  private readonly entries = new Map<string, { count: number; resetAt: number }>();
  private lastSweepAt = 0;

  constructor(
    private readonly maxEntries = 10_000,
    private readonly sweepIntervalMs = 60_000,
  ) {}

  async increment(key: string, windowMs: number): Promise<RateLimitResult> {
    const now = Date.now();
    this.sweep(now);

    const existing = this.entries.get(key);
    if (existing && now <= existing.resetAt) {
      existing.count += 1;
      return { count: existing.count, resetAt: existing.resetAt };
    }

    // Starting a new window for this key. Inserting a brand-new key grows the
    // map, so make room first; overwriting an expired entry does not.
    if (!existing && this.entries.size >= this.maxEntries) {
      this.evictExpired(now);
      if (this.entries.size >= this.maxEntries) {
        this.evictSoonestToExpire();
      }
    }

    const entry = { count: 1, resetAt: now + windowMs };
    this.entries.set(key, entry);
    return { count: 1, resetAt: entry.resetAt };
  }

  // Periodically drop expired windows so stale keys cannot accumulate without
  // bound. Correctness never depends on this: increment() always checks an
  // entry's resetAt directly, so sweeping is purely a memory bound.
  private sweep(now: number): void {
    if (now - this.lastSweepAt < this.sweepIntervalMs) return;
    this.lastSweepAt = now;
    this.evictExpired(now);
  }

  private evictExpired(now: number): void {
    for (const [key, entry] of this.entries) {
      if (now > entry.resetAt) {
        this.entries.delete(key);
      }
    }
  }

  // Last resort when the map is full of unexpired windows (e.g. a key-rotation
  // attack): drop the soonest-to-expire entry to make room. This bounds memory
  // at the cost of resetting one caller's window early.
  private evictSoonestToExpire(): void {
    let oldestKey: string | undefined;
    let oldestResetAt = Infinity;
    for (const [key, entry] of this.entries) {
      if (entry.resetAt < oldestResetAt) {
        oldestResetAt = entry.resetAt;
        oldestKey = key;
      }
    }
    if (oldestKey !== undefined) {
      this.entries.delete(oldestKey);
    }
  }
}

// Wraps a primary store with an in-memory fallback so a primary outage degrades
// rate limiting to per-instance (still enforced) instead of being bypassed
// entirely. Error logging is throttled to avoid log spam during an outage.
export class ResilientRateLimitStore implements RateLimitStore {
  private lastErrorLogAt = 0;

  constructor(
    private readonly primary: RateLimitStore,
    private readonly fallback: RateLimitStore,
    private readonly errorLogIntervalMs = 60_000,
  ) {}

  async increment(key: string, windowMs: number): Promise<RateLimitResult> {
    try {
      return await this.primary.increment(key, windowMs);
    } catch (err) {
      const now = Date.now();
      if (now - this.lastErrorLogAt >= this.errorLogIntervalMs) {
        this.lastErrorLogAt = now;
        console.error('rate limit primary store error; enforcing via in-memory fallback', err);
      }
      return await this.fallback.increment(key, windowMs);
    }
  }
}

// Atomic fixed-window increment: INCR the counter, set the expiry on the first
// hit, and return the remaining TTL so the caller can compute the reset time.
const INCR_SCRIPT = `
local current = redis.call('INCR', KEYS[1])
if current == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
local ttl = redis.call('PTTL', KEYS[1])
return {current, ttl}
`;

export class RedisRateLimitStore implements RateLimitStore {
  private readonly client: Redis;
  private readonly keyPrefix: string;

  constructor(url: string, keyPrefix: string) {
    this.client = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 1 });
    this.keyPrefix = keyPrefix;
  }

  async increment(key: string, windowMs: number): Promise<RateLimitResult> {
    const [count, ttl] = (await this.client.eval(
      INCR_SCRIPT,
      1,
      `${this.keyPrefix}:${key}`,
      windowMs,
    )) as [number, number];
    const effectiveTtl = ttl > 0 ? ttl : windowMs;
    return { count, resetAt: Date.now() + effectiveTtl };
  }
}
