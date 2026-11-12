/**
 * Session revocation cache.
 *
 * Phase 3 — application-level enforcement of `device_sessions.revoked_at`.
 *
 * PROBLEM:
 *   `device_sessions.revoked_at` is the canonical revocation flag, but the
 *   Supabase JWT remains valid until its own expiry (default 1 hour). Without
 *   a check at the Mavero auth boundary, a revoked session can continue to
 *   authenticate Mavero requests for up to 1 hour.
 *
 * SOLUTION:
 *   The server hook (src/hooks.server.ts) consults this module on every
 *   authenticated request. The module:
 *     1. Checks a short-TTL in-memory cache keyed by `supabase_session_id`.
 *     2. On cache miss, queries `device_sessions` for an active row matching
 *        `(user_id, supabase_session_id, revoked_at IS NULL)`.
 *     3. Caches the result for REVOCATION_CACHE_TTL_MS so subsequent requests
 *        do not hit the DB.
 *
 * BOUNDED MEMORY:
 *   The cache is hard-capped at MAX_CACHED_SESSIONS entries. When the cap
 *   is hit, expired entries are evicted first, then the oldest-inserted
 *   ones. The cache can never grow without bound regardless of traffic.
 *
 * SERVERLESS HONESTY:
 *   This cache is per-instance (Netlify function instance). A revocation
 *   performed on instance A is NOT instantly visible to instance B — B
 *   may serve up to REVOCATION_CACHE_TTL_MS of stale-authenticated
 *   requests before its cache expires and it re-queries the DB. This is
 *   an acceptable tradeoff: the alternative is a DB query on every
 *   request, which is cost-prohibitive at Mavero's traffic level. The
 *   30-second TTL bounds the staleness window.
 *
 * KEY:
 *   Cache entries are keyed by `supabase_session_id` (NOT user_id) — this
 *   is the canonical session identity derived from the JWT. Cross-user
 *   cache contamination is impossible because the key includes the
 *   session_id which is unique per Supabase session.
 *
 * SECURITY:
 *   - user_id and supabase_session_id are ALWAYS server-derived (from
 *     locals.user.id and the JWT session_id claim). Never client-supplied.
 *   - The cache stores only `{ revoked: boolean, expiresAt: number }`.
 *     No tokens, no user data, no PII.
 *   - Cache writes are atomic in Node's single-threaded event loop.
 */

const REVOCATION_CACHE_TTL_MS = 30 * 1000; // 30 seconds
const MAX_CACHED_SESSIONS = 5_000;

type CacheEntry = {
  revoked: boolean;
  expiresAt: number; // epoch millis
};

const cache = new Map<string, CacheEntry>();

/** Test seam — clears the cache. Used by tests, not by application code. */
export function resetRevocationCacheForTests(): void {
  cache.clear();
}

/** Test seam — sets a cache entry directly. Used by tests to simulate cached state. */
export function setRevocationCacheEntryForTests(
  supabaseSessionId: string,
  revoked: boolean,
  ttlMs: number = REVOCATION_CACHE_TTL_MS
): void {
  cache.set(supabaseSessionId, {
    revoked,
    expiresAt: Date.now() + ttlMs,
  });
}

/** Test seam — returns the current cache size. Used by tests to verify bounded memory. */
export function getRevocationCacheSizeForTests(): number {
  return cache.size;
}

/**
 * Reads a cached revocation state. Returns `null` if the entry is missing
 * or stale (in which case the caller must query the DB).
 */
export function getCachedRevocationState(
  supabaseSessionId: string,
  now: number = Date.now()
): { revoked: boolean } | null {
  const entry = cache.get(supabaseSessionId);
  if (!entry) return null;
  if (now >= entry.expiresAt) {
    // Stale — evict and treat as cache miss.
    cache.delete(supabaseSessionId);
    return null;
  }
  return { revoked: entry.revoked };
}

/**
 * Records the revocation state for a session. Called after a DB lookup
 * (cache miss) so subsequent requests for the same session are served
 * from cache.
 */
export function setCachedRevocationState(
  supabaseSessionId: string,
  revoked: boolean,
  now: number = Date.now()
): void {
  // Bound the cache. Evict expired entries first; if still at capacity,
  // evict the oldest-inserted entry (FIFO).
  if (cache.size >= MAX_CACHED_SESSIONS) {
    evictExpired(now);
    if (cache.size >= MAX_CACHED_SESSIONS) {
      // Still at capacity — evict the oldest entry. Map iteration order
      // reflects insertion order in JavaScript.
      const oldestKey = cache.keys().next().value;
      if (oldestKey !== undefined) cache.delete(oldestKey);
    }
  }
  cache.set(supabaseSessionId, {
    revoked,
    expiresAt: now + REVOCATION_CACHE_TTL_MS,
  });
}

/**
 * Invalidates the cache entry for a specific session. Called by the
 * revoke APIs (individual revoke + Sign out All) so the next request
 * from that session sees the new revoked state immediately.
 *
 * Note: this invalidation is per-instance. On Netlify, other function
 * instances may still serve stale-authenticated requests for up to
 * REVOCATION_CACHE_TTL_MS until their own cache expires.
 */
export function invalidateRevocationCache(supabaseSessionId: string): void {
  cache.delete(supabaseSessionId);
}

/**
 * Determines whether a session is revoked. Checks the cache first; on
 * miss, queries the DB via the provided lookup function and caches the
 * result.
 *
 * The lookup function MUST:
 *   - Accept (userId, supabaseSessionId)
 *   - Return `{ revoked: boolean }` (true if the session is revoked or
 *     not found in the active registry)
 *   - Never throw (wrap errors and treat as "not revoked" — fail-open
 *     on DB errors so the existing Supabase auth remains authoritative)
 *
 * Returns `{ revoked: boolean }`.
 */
export async function isSessionRevoked(
  userId: string,
  supabaseSessionId: string,
  lookup: (userId: string, supabaseSessionId: string) => Promise<{ revoked: boolean }>,
  now: number = Date.now()
): Promise<{ revoked: boolean }> {
  const cached = getCachedRevocationState(supabaseSessionId, now);
  if (cached) return cached;

  let result: { revoked: boolean };
  try {
    result = await lookup(userId, supabaseSessionId);
  } catch {
    // DB lookup failed — fail-open (do not block auth on a registry
    // query failure). The Supabase JWT remains the authoritative auth.
    return { revoked: false };
  }

  setCachedRevocationState(supabaseSessionId, result.revoked, now);
  return result;
}

/** Evicts all expired entries. Called internally when the cache approaches capacity. */
function evictExpired(now: number): void {
  for (const [key, entry] of cache) {
    if (now >= entry.expiresAt) cache.delete(key);
  }
}

/** Exposed for tests / diagnostics. */
export const REVOCATION_CACHE_TTL_MS_EXPORT = REVOCATION_CACHE_TTL_MS;
export const MAX_CACHED_SESSIONS_EXPORT = MAX_CACHED_SESSIONS;
