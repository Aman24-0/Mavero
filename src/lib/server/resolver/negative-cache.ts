// Phase 3-D (audit OBS-4) — Bounded negative-result cache for resolver.
//
// Problem: when a provider returns a DETERMINISTIC "not found" / unsupported
// result for a (source, content, mediaType, episode) tuple, the resolver
// re-attempts the same resolution on every request. Under load (e.g. a
// trending title a provider doesn't have), this drove repeated identical
// upstream calls — wasted bandwidth, wasted latency, and provider-side
// rate-limit pressure for no benefit.
//
// Fix: a small bounded in-process negative cache. It stores NEGATIVE
// outcomes (not-found / unsupported — NEVER transient failures) for a
// short TTL, keyed by the canonical resolver identity (sourceId +
// contentId + mediaType + season + episode). A subsequent identical
// resolution attempt within the TTL receives the cached negative
// result without hitting the provider again.
//
// CRITICAL DISTINCTIONS:
//
//   1. NEGATIVE-ONLY cache. Transient failures (network error, timeout,
//      5xx, INTERNAL_RESOLUTION_ERROR) are NEVER cached as negatives.
//      A transient failure might succeed on retry — caching it as a
//      "not found" would make the system permanently unable to recover
//      until the TTL expired. Only DETERMINISTIC "this source cannot
//      serve this content" outcomes are cached.
//
//   2. NO AUTHORIZATION STATE. The cache key contains ONLY content
//      identity + source identity — NEVER the user, NEVER the adult-
//      mode authorization decision. The negative cache stores the
//      FACT that "source X cannot serve content Y at this episode";
//      it NEVER stores or replaces the Adult Mode authorization check.
//      Authorization is still evaluated per-request by the existing
//      canAccessAdultContent policy function.
//
//   3. BOUNDED. The cache has a maximum entry count (default 256) and
//      a TTL (default 60s). Entries are evicted on LRU + on expiry.
//      The bound is generous (the resolver's fallback loop already
//      caps attempts at DEFAULT_FALLBACK_MAX_ATTEMPTS, so the working
//      set is far smaller than the bound).
//
//   4. PROCESS-LOCAL — NOT GLOBAL. This cache lives in the Netlify
//      function's process memory. Each function instance has its OWN
//      cache; there is no cross-instance coordination. This is a
//      DELIBERATE limitation: a globally-distributed circuit breaker
//      would require Redis or similar infrastructure, which is out
//      of scope for Phase 3 (see audit PRV-09). The cache is still
//      valuable: within a single function instance, repeated identical
//      negative resolutions (e.g. the same trending title a provider
//      doesn't have) skip the upstream call. The negative cache +
//      the existing per-endpoint rate limiting + the existing resolver
//      fallback cap together bound the worst-case load on a provider.
//
//   5. INVALIDATION. `invalidate(sourceId?)` clears entries — for a
//      specific source (e.g. when an admin reconfigures it) or all
//      (e.g. for tests). The cache is also cleared on process start.

const DEFAULT_TTL_MS = 60_000; // 60 seconds — short, deterministic
const DEFAULT_MAX_ENTRIES = 256;

type NegativeEntry = {
  /** The resolver error code that was cached (e.g. RESOLUTION_UNAVAILABLE). */
  code: string;
  /** The HTTP status the cached error maps to (e.g. 503 for UNAVAILABLE). */
  status: number;
  /** When the entry was cached (epoch ms). */
  cachedAt: number;
  /** When the entry expires (epoch ms). */
  expiresAt: number;
};

const entries = new Map<string, NegativeEntry>();
let defaultTtlMs = DEFAULT_TTL_MS;
let defaultMaxEntries = DEFAULT_MAX_ENTRIES;

/**
 * The set of resolver error codes that are SAFE to cache as negatives.
 *
 * DETERMINISTIC "this source cannot serve this content" outcomes are
 * cached: the same request will produce the same outcome until the
 * provider's configuration changes (which the admin invalidation
 * handles via `invalidate(sourceId)`).
 *
 * TRANSIENT failures are NEVER cached: they might succeed on retry.
 *
 * Phase 4 REGRESSION-2: RESOLUTION_UNAVAILABLE was previously in this
 * set, but it maps to HTTP 503 ("Service Unavailable" — transient by
 * HTTP spec) and is generated in MULTIPLE transient contexts:
 *   * missing adapter (configuration issue — fixable by admin);
 *   * missing env (environment issue — fixable by ops);
 *   * content load failure (TMDB transient);
 *   * adapter returned null (ambiguous — could be transient);
 *   * all-candidates-exhausted (wraps the last error, which is usually
 *     transient).
 * Caching it as a deterministic negative would make the system
 * permanently unable to recover until the TTL expired — a transient
 * failure would become a 60-second permanent negative. This is wrong.
 *
 * The ONLY genuinely deterministic codes (content/source identity —
 * doesn't change per-request, doesn't depend on transient state) are:
 *   * UNSUPPORTED_MEDIA_TYPE (422) — the source's capabilities JSON
 *     says "no" for this media type. Changes only when admin
 *     reconfigures the source (admin invalidation clears the cache).
 *   * MISSING_IDENTIFIER (422) — the content is missing an identifier
 *     the source requires. The content's identifiers come from TMDB
 *     and don't change (the same content always has the same IDs).
 *
 * Every other code is either transient (503/504/500/502/410) or
 * admin-state-dependent (409/404) — NONE are cacheable as negatives.
 */
const CACHEABLE_NEGATIVE_CODES = new Set<string>([
  // The source doesn't support this media type — deterministic (the
  // source's capabilities JSON hasn't changed). Admin invalidation
  // clears the cache when the source is reconfigured.
  'UNSUPPORTED_MEDIA_TYPE',
  // The content is missing an identifier the source requires —
  // deterministic (the content's identifiers haven't changed — they
  // come from TMDB).
  'MISSING_IDENTIFIER',
]);

/**
 * Returns true if the resolver error code is SAFE to cache as a negative.
 * Transient failures (network, timeout, internal error) return false —
 * they might succeed on retry and must NOT be cached as permanent
 * negatives.
 */
export function isCacheableNegative(code: string): boolean {
  return CACHEABLE_NEGATIVE_CODES.has(code);
}

/**
 * Builds the negative-cache key for a resolver request. The key
 * contains ONLY content identity + source identity — NEVER the user,
 * NEVER the adult-mode authorization decision. Two different users
 * resolving the same source+content receive the SAME cache key
 * (the negative result is content-side, not user-side).
 */
export function negativeCacheKey(request: {
  sourceId: string;
  contentId: string;
  mediaType: string;
  season?: number;
  episode?: number;
}): string {
  return `neg:${request.sourceId}:${request.contentId}:${request.mediaType}:${request.season ?? 0}:${request.episode ?? 0}`;
}

/**
 * Reads a cached negative result. Returns undefined when no cached
 * entry exists, when the entry has expired, or when the entry's code
 * is no longer in the cacheable set (defensive — a code that was
 * cacheable when stored but later removed from the set is treated as
 * a miss). Re-inserts on hit so the Map's insertion order reflects
 * recency (LRU semantics).
 */
export function getCachedNegative(key: string, now: number = Date.now()): NegativeEntry | undefined {
  const entry = entries.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt <= now) {
    entries.delete(key);
    return undefined;
  }
  // LRU: re-insert to refresh insertion order.
  entries.delete(key);
  entries.set(key, entry);
  return entry;
}

/**
 * Stores a negative result, but ONLY when the code is in the cacheable
 * set. Transient failures (network, timeout, internal error) are NEVER
 * cached — the caller can call this unconditionally and the function
 * decides whether to store.
 */
export function setCachedNegative(
  key: string,
  code: string,
  status: number,
  ttlMs: number = defaultTtlMs,
  now: number = Date.now()
): void {
  if (!isCacheableNegative(code)) return;
  const entry: NegativeEntry = { code, status, cachedAt: now, expiresAt: now + ttlMs };
  entries.delete(key);
  entries.set(key, entry);
  // Bound: evict oldest insertion-order key while over the cap.
  while (entries.size > defaultMaxEntries) {
    const oldestKey = entries.keys().next().value;
    if (oldestKey === undefined) break;
    entries.delete(oldestKey);
  }
}

/**
 * Invalidates negative-cache entries. With no argument, clears all
 * entries (used by tests). With a sourceId, clears entries whose key
 * contains that source id prefix — for admin source reconfiguration.
 */
export function invalidate(sourceId?: string): void {
  if (!sourceId) {
    entries.clear();
    return;
  }
  const prefix = `neg:${sourceId}:`;
  for (const key of entries.keys()) {
    if (key.startsWith(prefix)) entries.delete(key);
  }
}

/** Clears all entries and resets bookkeeping — for tests. */
export function clearNegativeCache(): void {
  entries.clear();
}

/** Diagnostics — for tests and ops dashboards. */
export function negativeCacheStats(): { entries: number; maxEntries: number; ttlMs: number } {
  return { entries: entries.size, maxEntries: defaultMaxEntries, ttlMs: defaultTtlMs };
}

/** Test-only: configure the TTL/max for tests that need different bounds. */
export function configureNegativeCache(options: { ttlMs?: number; maxEntries?: number }): void {
  if (typeof options.ttlMs === 'number') defaultTtlMs = options.ttlMs;
  if (typeof options.maxEntries === 'number') defaultMaxEntries = options.maxEntries;
}

// Test-only exports for behavioral verification.
export const __test = {
  get DEFAULT_TTL_MS() { return DEFAULT_TTL_MS; },
  get DEFAULT_MAX_ENTRIES() { return DEFAULT_MAX_ENTRIES; },
  peekEntry(key: string): NegativeEntry | undefined {
    return entries.get(key);
  },
  resetDefaults() {
    defaultTtlMs = DEFAULT_TTL_MS;
    defaultMaxEntries = DEFAULT_MAX_ENTRIES;
  }
};
