// Phase 2-D (audit PERF-004 / MEM-001) — Bound in-process content cache.
//
// Problem: the previous implementation used an unbounded `Map`. Cache keys
// are derived from request params (section, language, provider, page,
// type, id, sort, cursor, ...). Under sustained traffic against varied
// filter combinations, the cache grew without limit, holding server
// memory indefinitely. Expired entries were never reaped — only replaced
// on the next miss for the SAME key, so an attacker who probed distinct
// unused keys could keep stale entries resident forever.
//
// Fix: a small LRU bound + a periodic expiry sweep.
//
// Design (reuses the manifest-cache.ts LRU pattern already in the repo):
//   * Maximum entry count (default 256). When exceeded, the oldest
//     insertion-order key is evicted. Map's iteration order gives us
//     LRU for free — every read re-inserts the entry (delete + set), so
//     frequently-accessed keys stay resident.
//   * Every read checks `expiresAt` and evicts on miss — stale entries
//     don't survive past their TTL even if nobody writes to the same key.
//   * A periodic sweep (runs at most every SWEEP_INTERVAL_MS, triggered
//     by any read) walks all entries and removes expired ones. Cheap
//     because the sweep is amortized — once per interval, not per read.
//   * Request de-duplication (in-flight promises) is preserved.
//   * Stale-while-revalidate is preserved: a stale entry is returned
//     immediately while a refresh runs in the background.
//   * cacheStats() remains useful and now also reports evictions + sweeps.
//
// The bound is intentionally generous (256) — the catalog has a finite
// shape (a handful of sections × languages × providers × pages), and
// the working set is far smaller than the bound. The cap exists to
// prevent unbounded growth under adversarial probing, not to constrain
// legitimate traffic.

const DEFAULT_MAX_ENTRIES = 256;
const SWEEP_INTERVAL_MS = 60_000; // 1 minute — amortized expiry sweep

type CacheEntry<T> = {
  value: T;
  expiresAt: number;
  staleUntil: number;
};

const entries = new Map<string, CacheEntry<unknown>>();
const inFlight = new Map<string, Promise<unknown>>();

// Amortized sweep bookkeeping.
let lastSweepAt = 0;
let evictionCount = 0;
let sweepCount = 0;
let expiredReapedCount = 0;

export type CachePolicy = {
  ttlMs: number;
  staleWhileRevalidateMs?: number;
};

// Exposed for tests / ops dashboards. The shape is additive — existing
// readers of `entries` / `requestsInFlight` continue to work.
export function cacheStats() {
  return {
    entries: entries.size,
    requestsInFlight: inFlight.size,
    evictions: evictionCount,
    sweeps: sweepCount,
    expiredReaped: expiredReapedCount,
    lastSweepAt,
    maxEntries: DEFAULT_MAX_ENTRIES
  };
}

/**
 * Read an entry, evicting it if expired. Re-inserts on hit so the Map's
 * insertion-order reflects recency (LRU semantics).
 */
function readEntry<T>(key: string, now: number): CacheEntry<T> | undefined {
  const entry = entries.get(key) as CacheEntry<T> | undefined;
  if (!entry) return undefined;
  // Expired past the stale window — gone for good.
  if (entry.staleUntil <= now) {
    entries.delete(key);
    expiredReapedCount += 1;
    return undefined;
  }
  // Refresh insertion order so hot keys stay resident.
  entries.delete(key);
  entries.set(key, entry);
  return entry;
}

/**
 * Insert/replace an entry, evicting the LRU entry when over the bound.
 */
function writeEntry<T>(key: string, value: T, policy: CachePolicy, now: number): CacheEntry<T> {
  const entry: CacheEntry<T> = {
    value,
    expiresAt: now + policy.ttlMs,
    staleUntil: now + policy.ttlMs + (policy.staleWhileRevalidateMs ?? 0)
  };
  entries.delete(key);
  entries.set(key, entry);
  // Bound: evict oldest insertion-order key while over the cap.
  while (entries.size > DEFAULT_MAX_ENTRIES) {
    const oldestKey = entries.keys().next().value;
    if (oldestKey === undefined) break;
    entries.delete(oldestKey);
    evictionCount += 1;
  }
  return entry;
}

/**
 * Amortized sweep — walks all entries and removes any whose stale window
 * has expired. Runs at most every SWEEP_INTERVAL_MS, triggered by reads.
 * This bounds the worst-case residency of expired entries to the sweep
 * interval even when nobody writes to the same key.
 */
function maybeSweep(now: number): void {
  if (now - lastSweepAt < SWEEP_INTERVAL_MS) return;
  lastSweepAt = now;
  sweepCount += 1;
  for (const [key, entry] of entries) {
    if (entry.staleUntil <= now) {
      entries.delete(key);
      expiredReapedCount += 1;
    }
  }
}

export async function getOrSet<T>(key: string, policy: CachePolicy, loader: () => Promise<T>): Promise<{ value: T; stale: boolean }> {
  const now = Date.now();
  maybeSweep(now);

  const cached = readEntry<T>(key, now);

  if (cached && cached.expiresAt > now) {
    return { value: cached.value, stale: false };
  }

  if (cached && cached.staleUntil > now) {
    void refresh(key, policy, loader);
    return { value: cached.value, stale: true };
  }

  return { value: await refresh(key, policy, loader), stale: false };
}

async function refresh<T>(key: string, policy: CachePolicy, loader: () => Promise<T>): Promise<T> {
  const existing = inFlight.get(key) as Promise<T> | undefined;
  if (existing) return existing;

  const request = loader()
    .then((value) => {
      const now = Date.now();
      writeEntry(key, value, policy, now);
      return value;
    })
    .finally(() => inFlight.delete(key));

  inFlight.set(key, request);
  return request;
}

export function invalidate(prefix?: string) {
  if (!prefix) {
    const cleared = entries.size;
    entries.clear();
    expiredReapedCount += cleared;
    return;
  }

  for (const key of entries.keys()) {
    if (key.startsWith(prefix)) {
      entries.delete(key);
      expiredReapedCount += 1;
    }
  }
}

export function clearCache() {
  entries.clear();
  inFlight.clear();
  // Reset bookkeeping so tests start from a clean slate.
  evictionCount = 0;
  sweepCount = 0;
  expiredReapedCount = 0;
  lastSweepAt = 0;
}

// Test-only exports (used by phase2_content_cache_test.ts).
// Exported so the test can drive the LRU / sweep behavior deterministically
// without waiting real time. Production code never imports these.
export const __test = {
  get DEFAULT_MAX_ENTRIES() { return DEFAULT_MAX_ENTRIES; },
  get SWEEP_INTERVAL_MS() { return SWEEP_INTERVAL_MS; },
  /**
   * Force the sweep timer to fire on the next read regardless of the
   * interval — used by tests to verify expired entries are reaped.
   */
  forceSweepOnNextRead() { lastSweepAt = 0; },
  /** Direct insertion — used by tests to seed entries without a loader. */
  seedEntry<T>(key: string, value: T, policy: CachePolicy, now = Date.now()) {
    writeEntry(key, value, policy, now);
  },
  /** Test-only: read the raw entry without affecting LRU order or expiry. */
  peekEntry<T>(key: string): { expiresAt: number; staleUntil: number } | undefined {
    const entry = entries.get(key) as CacheEntry<T> | undefined;
    if (!entry) return undefined;
    return { expiresAt: entry.expiresAt, staleUntil: entry.staleUntil };
  }
};
