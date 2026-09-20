import { Global, Injectable, Module } from "@nestjs/common";

/**
 * In-process TTL cache with tag-based invalidation + LRU eviction.
 *
 * Strategy
 * ────────
 * • Read-mostly reference data (goods, categories) → long TTL, tag "goods".
 * • Public profiles / computed boards / suggestions → short TTL, per-entity tags.
 * • Every mutation invalidates the tags it touches → no stale reads after writes.
 *
 * Deliberately dependency-free; the same interface maps 1:1 onto Redis when
 * horizontal scaling requires a shared cache (swap the internals only).
 */

interface Entry {
  value: unknown;
  expiresAt: number;
  tags: readonly string[];
}

const MAX_ENTRIES = 5_000;

@Injectable()
export class CacheService {
  private store = new Map<string, Entry>();
  private hits = 0;
  private misses = 0;

  /** Get-or-load. Returns the value plus whether it came from cache. */
  async wrap<T>(
    key: string,
    opts: { ttlMs: number; tags?: readonly string[] },
    loader: () => Promise<T>
  ): Promise<{ value: T; hit: boolean }> {
    const now = Date.now();
    const found = this.store.get(key);

    if (found && found.expiresAt > now) {
      // LRU refresh
      this.store.delete(key);
      this.store.set(key, found);
      this.hits++;
      return { value: found.value as T, hit: true };
    }

    this.misses++;
    const value = await loader();
    this.store.set(key, { value, expiresAt: now + opts.ttlMs, tags: opts.tags ?? [] });
    this.evictIfNeeded();
    return { value, hit: false };
  }

  /** Invalidate one exact key. */
  invalidate(key: string): void {
    this.store.delete(key);
  }

  /** Invalidate every entry carrying the given tag. */
  invalidateTag(tag: string): void {
    for (const [key, entry] of this.store) {
      if (entry.tags.includes(tag)) this.store.delete(key);
    }
  }

  stats(): { size: number; hits: number; misses: number; hitRatio: number } {
    const total = this.hits + this.misses;
    return {
      size: this.store.size,
      hits: this.hits,
      misses: this.misses,
      hitRatio: total === 0 ? 0 : Math.round((this.hits / total) * 100),
    };
  }

  private evictIfNeeded(): void {
    while (this.store.size > MAX_ENTRIES) {
      const oldest = this.store.keys().next().value;
      if (oldest === undefined) break;
      this.store.delete(oldest);
    }
  }
}

/** Standard TTLs (ms) */
export const TTL = {
  MINUTE: 60_000,
  SHORT: 30_000,
  FIVE_MIN: 5 * 60_000,
} as const;

@Global()
@Module({
  providers: [CacheService],
  exports: [CacheService],
})
export class CacheModule {}
