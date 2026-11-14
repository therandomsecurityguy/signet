type CacheEntry<T> = {
  value: T;
  expiresAt: number;
};

/**
 * Ephemeral in-memory LRU cache with TTL. Used to remember summarized payloads
 * for a short window so repeated identical requests do not re-summarize.
 */
export class EphemeralCache<T> {
  private readonly entries = new Map<string, CacheEntry<T>>();

  constructor(
    private readonly opts: {
      maxEntries: number;
      ttlMs: number;
    },
  ) {}

  get(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.entries.delete(key);
      return undefined;
    }
    // LRU touch: move to most-recently-used position.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: T): void {
    if (this.entries.has(key)) this.entries.delete(key);
    this.entries.set(key, { value, expiresAt: Date.now() + this.opts.ttlMs });
    if (this.entries.size > this.opts.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
  }

  size(): number {
    return this.entries.size;
  }
}
