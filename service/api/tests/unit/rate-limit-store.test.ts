import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  MemoryRateLimitStore,
  ResilientRateLimitStore,
  type RateLimitStore,
} from '../../src/app/middleware/rate-limit-store.js';

// Test-only handle to the store's private map for direct size assertions.
function mapOf(store: MemoryRateLimitStore): Map<string, { count: number; resetAt: number }> {
  return (store as unknown as { entries: Map<string, { count: number; resetAt: number }> }).entries;
}

describe('MemoryRateLimitStore', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('counts within a window and resets after the window expires', async () => {
    vi.useFakeTimers();
    const store = new MemoryRateLimitStore();

    expect((await store.increment('k', 1000)).count).toBe(1);
    expect((await store.increment('k', 1000)).count).toBe(2);

    vi.advanceTimersByTime(1001);
    expect((await store.increment('k', 1000)).count).toBe(1);
  });

  it('sweeps expired entries out of the map', async () => {
    vi.useFakeTimers();
    const store = new MemoryRateLimitStore(10_000, 1_000);

    await store.increment('a', 500);
    await store.increment('b', 500);
    expect(mapOf(store).size).toBe(2);

    // Move past the 500ms windows and the 1s sweep interval, then trigger a sweep.
    vi.advanceTimersByTime(1_500);
    await store.increment('c', 500);

    // Expired a/b were reclaimed; only c remains.
    expect(mapOf(store).size).toBe(1);
    expect(mapOf(store).has('c')).toBe(true);
  });

  it('bounds memory by evicting once over maxEntries', async () => {
    vi.useFakeTimers();
    const store = new MemoryRateLimitStore(3, 60_000);

    // Insert more unique keys than the cap; all windows unexpired.
    for (let i = 0; i < 10; i++) {
      await store.increment(`key-${i}`, 60_000);
    }

    // key-0 was evicted to stay within the cap, so it starts a fresh window
    // (an unbounded store would still hold it and return count 2).
    expect((await store.increment('key-0', 60_000)).count).toBe(1);
  });
});

describe('ResilientRateLimitStore', () => {
  it('uses the primary store when it succeeds', async () => {
    const primary: RateLimitStore = {
      increment: async (_key, windowMs) => ({ count: 42, resetAt: Date.now() + windowMs }),
    };
    const store = new ResilientRateLimitStore(primary, new MemoryRateLimitStore());

    expect((await store.increment('k', 1000)).count).toBe(42);
  });

  it('falls back to the in-memory store (still enforcing) when the primary errors', async () => {
    const failing: RateLimitStore = {
      increment: async () => {
        throw new Error('redis unavailable');
      },
    };
    const store = new ResilientRateLimitStore(failing, new MemoryRateLimitStore());

    // Rate limiting is still applied via the fallback, not bypassed.
    expect((await store.increment('k', 1000)).count).toBe(1);
    expect((await store.increment('k', 1000)).count).toBe(2);
  });
});
