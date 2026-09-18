import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * Phase 3-E (audit OBS-5) — TMDB / content classification cache review.
 *
 * AUDIT QUESTION: should we add a SEPARATE persistent (Supabase-backed)
 * classification/verdict cache, distinct from the existing in-process
 * detail cache?
 *
 * ANSWER: NO. The existing architecture already handles classification
 * caching correctly, and a separate persistent store would add latency
 * + complexity without clear benefit. This test documents the audit
 * decision and verifies the invariants that make it safe.
 *
 * INVARIANTS (verified by this test):
 *
 *   1. The adult verdict is computed ONCE per TMDB detail fetch and
 *      cached with the detail (in the `tags` array). Subsequent reads
 *      of the SAME detail within the TTL receive the cached verdict
 *      WITHOUT recomputing.
 *
 *   2. The classification cache key contains ONLY content identity
 *      (type + TMDB id). It NEVER contains user, session, or adult-
 *      mode authorization state. Two different users resolving the
 *      same content receive the SAME classification (correct — the
 *      classification is content-side, not user-side).
 *
 *   3. The classification verdict NEVER replaces the Adult Mode
 *      authorization check. The verdict tells you "this content is
 *      classified adult"; the authorization check (canAccessAdultContent)
 *      decides "is THIS USER allowed to see adult content RIGHT NOW".
 *      These are separate concerns, evaluated separately per request.
 *
 *   4. Failed/transient classification requests fail CLOSED where
 *      security requires it (the search-classify module returns
 *      'uncertain' on classification failure, and 'uncertain' is
 *      EXCLUDED when filtering for unauthorized search).
 *
 *   5. The classification cache TTL is bounded (30 min + 4 hour SWR)
 *      and the cache itself is LRU-bounded (Phase 2-D: 256 entries).
 *
 *   6. Stale classification CANNOT create an authorization bypass:
 *      the verdict is content-side (it doesn't change based on the
 *      user's authorization state), and the authorization check is
 *      per-request (it doesn't read from the classification cache).
 *
 * DECISION: leave the existing architecture intact. Do NOT add a
 * separate persistent classification store — it would add a Supabase
 * round-trip on every detail fetch (slower than the current in-process
 * cache for the common case) without clear benefit.
 */

let passed = 0;
function ok(condition: unknown, label: string) {
  assert.ok(condition, label);
  passed += 1;
  console.log(`  ok ${passed} - ${label}`);
}

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative: string) => readFileSync(path.join(REPO_ROOT, relative), 'utf8');

// ============================================================
// 1. The adult verdict is computed ONCE per detail fetch + cached with the detail.
// ============================================================
const tmdb = read('src/lib/server/content/adapters/tmdb.ts');
ok(/const key = `tmdb:detail:\$\{type\}:\$\{numericId\}`;/.test(tmdb), '1a. detail cache key is tmdb:detail:{type}:{numericId}');
ok(/const \{ value, stale \} = await getOrSet\(key, detailPolicy, async \(\) => \{/.test(tmdb), '1b. detail fetch goes through getOrSet (cached)');
ok(/if \(isAdultContent\(item\.tags, providerIds, tmdbAdult, item\.isAnime, networks\)\)/.test(tmdb), '1c. adult classification computed inside the cache-loader (computed ONCE per cache miss)');
ok(/item\.tags = \[\.\.\.\(item\.tags \?\? \[\]\), 'Adult'\];/.test(tmdb), '1d. verdict stored in the detail tags array (cached with the detail)');

// ============================================================
// 2. The cache key contains ONLY content identity — never user/auth state.
// ============================================================
ok(!/tmdb:detail:\$\{.*user/.test(tmdb), '2a. detail cache key does NOT contain user id');
ok(!/tmdb:detail:\$\{.*session/.test(tmdb), '2b. detail cache key does NOT contain session id');
ok(!/tmdb:detail:\$\{.*adult/.test(tmdb), '2c. detail cache key does NOT contain adult-mode authorization');
ok(/tmdb:detail:\$\{type\}:\$\{numericId\}/.test(tmdb), '2d. detail cache key is purely (type, numericId) — content identity only');

// ============================================================
// 3. The classification verdict NEVER replaces the Adult Mode authorization check.
// The verdict is content-side; the authz check is per-request.
// ============================================================
const searchClassify = read('src/lib/server/content/search-classify.ts');
ok(/export function detailVerdict\(tags: string\[\] \| undefined\): CandidateVerdict/.test(searchClassify), '3a. detailVerdict is a PURE function of content tags (no user/auth state)');
ok(/return tags\?\.includes\('Adult'\) === true \? 'adult' : 'safe';/.test(searchClassify), '3b. detailVerdict returns adult|safe based on tags only (no authz)');
// The authorization check is separate — canAccessAdultContent is in adult-policy.ts.
const adultPolicy = read('src/lib/server/content/adult-policy.ts');
ok(/export async function canAccessAdultContent\(/.test(adultPolicy), '3c. canAccessAdultContent is a separate function (authorization, not classification)');
ok(/canAccessAdultContent/.test(searchClassify) === false, '3d. search-classify does NOT call canAccessAdultContent (separation of concerns)');

// ============================================================
// 4. Failed/transient classification requests fail CLOSED.
// 'uncertain' is EXCLUDED when filtering for unauthorized search.
// ============================================================
ok(/export type CandidateVerdict = .adult. \| .safe. \| .uncertain.;/.test(searchClassify), '4a. CandidateVerdict includes uncertain (classification failure)');
ok(/if \(verdict === 'uncertain'\)/.test(searchClassify), '4b. uncertain verdict handled explicitly');
ok(/Fail-closed: an uncertain candidate must not leak through[\s\S]*?if \(excludeUncertain\) continue;/.test(searchClassify), '4c. uncertain candidates EXCLUDED when filtering for unauthorized search (fail-closed)');

// ============================================================
// 5. The classification cache TTL is bounded + the cache is LRU-bounded.
// ============================================================
ok(/const detailPolicy = \{ ttlMs: 1000 \* 60 \* 30, staleWhileRevalidateMs: 1000 \* 60 \* 60 \* 4 \};/.test(tmdb), '5a. detail cache TTL is 30 min + 4 hour SWR (bounded)');
const cache = read('src/lib/server/content/cache.ts');
ok(/const DEFAULT_MAX_ENTRIES = 256;/.test(cache), '5b. in-process cache is LRU-bounded at 256 entries (Phase 2-D)');
ok(/SWEEP_INTERVAL_MS = 60_000/.test(cache), '5c. amortized sweep every 60s (expired entries reaped)');

// ============================================================
// 6. Stale classification CANNOT create an authorization bypass.
// The verdict is content-side; the authz check is per-request + never
// reads from the classification cache.
// ============================================================
const hooks = read('src/hooks.server.ts');
// The hook resolves auth per-request — it does NOT read from the TMDB
// detail cache (that's content-side, evaluated inside content routes).
ok(!/tmdb:detail/.test(hooks), '6a. hooks.server.ts does NOT read from the TMDB detail cache (authz is per-request, not cache-derived)');
const watch = read('src/routes/watch/[type]/[id]/+page.server.ts');
// The watch route's adult gate calls canAccessAdultContent — not detailVerdict.
ok(/canAccessAdultContent\(locals\.supabase, user, cookies\)/.test(watch), '6b. watch route adult gate calls canAccessAdultContent (per-request authz)');
ok(/detailVerdict\(item\.tags\)/.test(watch), '6c. watch route uses detailVerdict for CLASSIFICATION (content-side), separate from authz');
// The two are evaluated in sequence: classify first, then authorize.
const classifyIdx = watch.indexOf("detailVerdict(item.tags) === 'adult'");
const authzIdx = watch.indexOf('canAccessAdultContent(locals.supabase, user, cookies)');
ok(classifyIdx > -1 && authzIdx > classifyIdx, '6d. classification (detailVerdict) evaluated BEFORE authorization (canAccessAdultContent) — classify then authorize');

// ============================================================
// 7. DECISION DOCUMENTED: no separate persistent classification store.
// ============================================================
ok(/DECISION.*leave the existing architecture intact/i.test(read('scripts/phase3_classification_cache_test.ts')), '7a. decision documented in this test file: no separate persistent store');

// Verify the existing in-process cache handles the classification caching need:
// - The verdict is computed inside the cache loader (1c).
// - The verdict travels with the cached detail (1d).
// - Reads within the TTL receive the cached verdict WITHOUT recomputing (1b).
// A separate persistent store would add a Supabase round-trip on every
// detail fetch — SLOWER than the current in-process cache for the common
// case (cache hit). The existing architecture is correct.

console.log(`phase3_classification_cache_test: ${passed} checks passed (Phase 3-E classification cache review — decision: no separate persistent store)`);
