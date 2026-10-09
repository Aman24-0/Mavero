// Phase 2-G (audit PERF-007) — Small bounded client-side rail cache.
//
// Problem: each DiscoverSection instance fetches its rail on mount. When
// the user navigates away and back (browser back button, or app nav),
// SvelteKit restores the page from its snapshot — but the section
// component is RE-MOUNTED and refetches every rail. For a page with
// ~10 sections, that's 10 simultaneous refetches on every back-nav.
//
// Fix: a tiny in-memory module cache that survives component remounts
// within the same tab. Hit on back-nav → no refetch.
//
// Safety contract (audit Phase 2-G):
//   * BOUNDED size (max 32 entries, LRU eviction)
//   * TTL (default 2 minutes — short enough that adult-mode flips
//     and admin catalog changes propagate quickly, long enough to
//     cover a typical back-nav)
//   * Route/filter-aware keys (the full rail URL including section,
//     language, provider, page)
//   * Cleanup (LRU + TTL sweep on every read)
//   * NO cross-user data leakage: cache is per-tab in-memory module
//     state. On sign-out, call `clearRailCache()` to evict everything
//     (the sign-out flow already resets IndexedDB; this matches that
//     pattern). Cache keys also include the user id when available
//     so a different user signing in on the same tab cannot hit a
//     previous user's cached rail.
//
// What this is NOT:
//   * Not a substitute for HTTP caching (the CDN policy is separate).
//   * Not a persistent cache (no IndexedDB / localStorage) — the data
//     dies with the tab.
//   * Not a cache for adult-content authorization — the SERVER remains
//     the authority. The cache only stores what the server already
//     authorized at fetch time.

const DEFAULT_TTL_MS = 2 * 60_000; // 2 minutes
const DEFAULT_MAX_ENTRIES = 32;

type CachedRail = {
  items: unknown[];
  hasNextPage: boolean;
  fetchedAt: number;
  ttlMs: number;
};

const cache = new Map<string, CachedRail>();
let lastSweepAt = 0;
const SWEEP_INTERVAL_MS = 60_000;

function makeKey(railUrl: string, userId: string | null): string {
  // Include the user id in the key so a different user signing in on
  // the same tab cannot hit the previous user's cached rails.
  return userId ? `${userId}:${railUrl}` : `guest:${railUrl}`;
}

function maybeSweep(now: number): void {
  if (now - lastSweepAt < SWEEP_INTERVAL_MS) return;
  lastSweepAt = now;
  for (const [key, entry] of cache) {
    if (now - entry.fetchedAt > entry.ttlMs) {
      cache.delete(key);
    }
  }
  for (const [key, entry] of batchCache) {
    if (now - entry.fetchedAt > entry.ttlMs) {
      batchCache.delete(key);
    }
  }
}

export function getCachedRail<T>(
  railUrl: string,
  userId: string | null | undefined,
  now: number = Date.now()
): { items: T[]; hasNextPage: boolean } | undefined {
  maybeSweep(now);
  const key = makeKey(railUrl, userId ?? null);
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (now - entry.fetchedAt > entry.ttlMs) {
    cache.delete(key);
    return undefined;
  }
  // LRU: re-insert to refresh insertion order.
  cache.delete(key);
  cache.set(key, entry);
  return { items: entry.items as T[], hasNextPage: entry.hasNextPage };
}

export function setCachedRail<T>(
  railUrl: string,
  userId: string | null | undefined,
  items: T[],
  hasNextPage: boolean,
  ttlMs: number = DEFAULT_TTL_MS,
  now: number = Date.now()
): void {
  maybeSweep(now);
  const key = makeKey(railUrl, userId ?? null);
  cache.delete(key);
  cache.set(key, { items: [...items], hasNextPage, fetchedAt: now, ttlMs });
  // Bound: evict oldest insertion-order key when over the cap.
  while (cache.size > DEFAULT_MAX_ENTRIES) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey === undefined) break;
    cache.delete(oldestKey);
  }
}

export function clearRailCache(): void {
  cache.clear();
  batchCache.clear();
  // In-flight batch requests are NOT aborted here — they belong to a
  // mounted component lifecycle and resolve into the (now cleared)
  // cache only via setCachedBatch, which re-inserts fresh entries. A
  // sign-out followed by a same-tab batch refetch therefore always
  // serves data fetched for the NEW user id key, never the old one.
  lastSweepAt = 0;
}

export function railCacheStats(): { entries: number; maxEntries: number; ttlMs: number; batchEntries: number } {
  return { entries: cache.size, maxEntries: DEFAULT_MAX_ENTRIES, ttlMs: DEFAULT_TTL_MS, batchEntries: batchCache.size };
}

// ============================================================
// MAV-20 Phase E — batch response cache + in-flight deduplication.
//
// The Discover page fetches its rails through /api/discover/batch in
// PRIORITY TIERS (two scoped requests). On back-navigation the page
// remounts and previously re-fired both tier requests. The batch cache
// reuses the SAME safety contract as the per-rail cache above:
//   * per-user keys (no cross-user leakage)
//   * TTL (2 minutes — adult-mode flips and catalog changes propagate)
//   * bounded size (LRU, 8 entries — 2 tiers × a handful of
//     language/provider variants is the realistic working set)
//   * in-flight dedup: a second mount while a tier request is still in
//     flight reuses the SAME promise instead of double-fetching.
// Failures are never cached — a rejected tier settles as 'failed' in
// the caller's state machine and the next mount retries cold.
// ============================================================

type CachedBatchRails = Record<string, { items: unknown[]; page: number; hasNextPage: boolean }>;

type CachedBatch = {
  rails: CachedBatchRails;
  fetchedAt: number;
  ttlMs: number;
};

const batchCache = new Map<string, CachedBatch>();
const batchInFlight = new Map<string, Promise<CachedBatchRails>>();
const BATCH_MAX_ENTRIES = 8;

function batchKey(batchUrl: string, userId: string | null): string {
  return makeKey(batchUrl, userId);
}

export function getCachedBatch(
  batchUrl: string,
  userId: string | null | undefined,
  now: number = Date.now()
): CachedBatchRails | undefined {
  maybeSweep(now);
  const key = batchKey(batchUrl, userId ?? null);
  const entry = batchCache.get(key);
  if (!entry) return undefined;
  if (now - entry.fetchedAt > entry.ttlMs) {
    batchCache.delete(key);
    return undefined;
  }
  // LRU: re-insert to refresh insertion order.
  batchCache.delete(key);
  batchCache.set(key, entry);
  return entry.rails;
}

export function setCachedBatch(
  batchUrl: string,
  userId: string | null | undefined,
  rails: CachedBatchRails,
  ttlMs: number = DEFAULT_TTL_MS,
  now: number = Date.now()
): void {
  maybeSweep(now);
  const key = batchKey(batchUrl, userId ?? null);
  batchCache.delete(key);
  batchCache.set(key, { rails, fetchedAt: now, ttlMs });
  while (batchCache.size > BATCH_MAX_ENTRIES) {
    const oldestKey = batchCache.keys().next().value;
    if (oldestKey === undefined) break;
    batchCache.delete(oldestKey);
  }
}

/**
 * Fetch a batch tier with cache + in-flight deduplication.
 *
 * Order of resolution:
 *   1. Fresh cache hit → returned synchronously (resolved promise).
 *   2. In-flight request for the same per-user key → the SAME promise
 *      (a remount while the request is running never double-fetches).
 *   3. Cold → fetcher() runs; a successful result is cached and
 *      returned; a failure propagates (never cached).
 *
 * Generic over the client item shape — the cache stores the parsed
 * payload opaquely (unknown[]), the wrapper types the result for the
 * caller.
 */
export async function fetchBatchWithCache<T>(
  batchUrl: string,
  userId: string | null | undefined,
  fetcher: () => Promise<Record<string, { items: T[]; page: number; hasNextPage: boolean }>>
): Promise<Record<string, { items: T[]; page: number; hasNextPage: boolean }>> {
  const cached = getCachedBatch(batchUrl, userId);
  if (cached) return cached as Record<string, { items: T[]; page: number; hasNextPage: boolean }>;

  const key = batchKey(batchUrl, userId ?? null);
  const existing = batchInFlight.get(key);
  if (existing) return existing as Promise<Record<string, { items: T[]; page: number; hasNextPage: boolean }>>;

  const request = fetcher()
    .then((rails) => {
      setCachedBatch(batchUrl, userId, rails as CachedBatchRails);
      return rails;
    })
    .finally(() => batchInFlight.delete(key));

  batchInFlight.set(key, request as Promise<CachedBatchRails>);
  return request;
}

// Test-only exports.
export const __test = {
  get DEFAULT_TTL_MS() { return DEFAULT_TTL_MS; },
  get DEFAULT_MAX_ENTRIES() { return DEFAULT_MAX_ENTRIES; },
  get SWEEP_INTERVAL_MS() { return SWEEP_INTERVAL_MS; },
  forceSweepOnNextRead() { lastSweepAt = 0; },
  peekEntry(railUrl: string, userId: string | null | undefined): CachedRail | undefined {
    return cache.get(makeKey(railUrl, userId ?? null));
  }
};
