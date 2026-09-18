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
  lastSweepAt = 0;
}

export function railCacheStats(): { entries: number; maxEntries: number; ttlMs: number } {
  return { entries: cache.size, maxEntries: DEFAULT_MAX_ENTRIES, ttlMs: DEFAULT_TTL_MS };
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
