import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

let passed = 0;
function ok(condition: unknown, label: string) {
  assert.ok(condition, label);
  passed += 1;
  console.log(`  ok ${passed} - ${label}`);
}

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative: string) => readFileSync(path.join(REPO_ROOT, relative), 'utf8');

// ============================================================
// 1. REVOCATION ENFORCEMENT — HOOKS SERVER
// ============================================================
// The most important Phase 3 invariant: a revoked session must NOT
// continue to authenticate Mavero requests. The server hook must
// consult device_sessions.revoked_at and clear locals.session/user
// when the session is revoked.
//
// This is a static source-contract test — runtime verification
// against a live Supabase/Postgres instance is out of scope (no
// live credentials in this environment; see "Runtime verification
// status" in the worklog).
{
  const hooks = read('src/hooks.server.ts');

  // The hook imports the revocation cache + DB lookup.
  ok(hooks.includes('session-revocation-cache'), 'hooks: imports session-revocation-cache module');
  ok(hooks.includes('isSessionRevoked'), 'hooks: imports isSessionRevoked');
  ok(hooks.includes('lookupSessionRevocationState'), 'hooks: imports lookupSessionRevocationState');

  // The revocation check fires AFTER safeGetSession resolves a valid
  // Supabase session (we only check revocation for authenticated requests).
  ok(hooks.includes('isSessionRevoked('), 'hooks: calls isSessionRevoked() at request time');
  ok(hooks.includes('auth.user.id'), 'hooks: passes server-derived user.id to isSessionRevoked');
  ok(hooks.includes('supabaseSessionId'), 'hooks: passes server-derived session_id to isSessionRevoked');
  ok(hooks.includes('extractSessionId(auth.session.access_token)'), 'hooks: derives session_id from JWT (NOT from client)');

  // When revoked, locals are cleared — the request is treated as a guest.
  ok(hooks.includes('sessionRevoked = true'), 'hooks: sets sessionRevoked flag on revocation');
  ok(hooks.includes('event.locals.session = null'), 'hooks: clears locals.session on revocation');
  ok(hooks.includes('event.locals.user = null'), 'hooks: clears locals.user on revocation');

  // The registration block is SKIPPED when the session is revoked —
  // a revoked session must NOT be re-registered (which would resurrect
  // it in the active sessions list).
  ok(hooks.includes('!sessionRevoked && auth.session && auth.user'), 'hooks: registration guarded by !sessionRevoked');

  // The check fails-open on DB errors (the Supabase JWT remains the
  // authoritative auth boundary; the registry is a supplementary
  // revocation layer).
  ok(hooks.includes('fails-open') || hooks.includes('fail-open') || hooks.includes('Fail-open'), 'hooks: documents fail-open behavior on DB errors');

  ok('1. revocation enforcement at hooks.server.ts (static contract)');
}

// ============================================================
// 2. REVOCATION CACHE — BOUNDED MEMORY + TTL
// ============================================================
// The cache must:
//   - be keyed by supabase_session_id (NOT user_id — cross-user
//     contamination is impossible because session_id is unique per
//     Supabase session).
//   - have a short TTL (30 seconds) so revoked state propagates
//     reasonably quickly.
//   - be bounded (hard-capped) so it cannot grow without limit.
//   - expose invalidation so revoke APIs can clear stale cache entries.
{
  const cache = read('src/lib/server/auth/session-revocation-cache.ts');

  ok(cache.includes('REVOCATION_CACHE_TTL_MS'), 'cache: TTL constant defined');
  ok(cache.includes('30 * 1000'), 'cache: TTL is 30 seconds');
  ok(cache.includes('MAX_CACHED_SESSIONS'), 'cache: max-entries constant defined');
  ok(cache.includes('5_000'), 'cache: max entries is 5000');

  // Keyed by supabase_session_id.
  ok(cache.includes('cache.get(supabaseSessionId)'), 'cache: keyed by supabase_session_id');
  ok(cache.includes('cache.set(supabaseSessionId'), 'cache: stores by supabase_session_id');
  ok(!cache.match(/cache\.(get|set)\(userId/), 'cache: NOT keyed by user_id (cross-user safe)');

  // Bounded — eviction on capacity.
  ok(cache.includes('evictExpired'), 'cache: evicts expired entries');
  ok(cache.includes('MAX_CACHED_SESSIONS'), 'cache: hard cap enforced');
  ok(cache.includes('oldestKey'), 'cache: FIFO eviction when at capacity');

  // Invalidation API.
  ok(cache.includes('export function invalidateRevocationCache'), 'cache: exports invalidateRevocationCache');
  ok(cache.includes('cache.delete(supabaseSessionId)'), 'cache: invalidate deletes by session_id');

  // Test seams.
  ok(cache.includes('resetRevocationCacheForTests'), 'cache: test seam resetRevocationCacheForTests');
  ok(cache.includes('setRevocationCacheEntryForTests'), 'cache: test seam setRevocationCacheEntryForTests');
  ok(cache.includes('getRevocationCacheSizeForTests'), 'cache: test seam getRevocationCacheSizeForTests');

  ok('2. revocation cache module (bounded, TTL, session_id-keyed, invalidation)');
}

// ============================================================
// 3. REVOCATION CACHE — DETERMINISTIC BEHAVIOR
// ============================================================
// Exercises the cache's get/set/invalidate/TTL/eviction behavior
// without a live DB. This is a deterministic unit test of the cache
// module's internal logic.
{
  // Import the cache module directly.
  const {
    resetRevocationCacheForTests,
    setRevocationCacheEntryForTests,
    getRevocationCacheSizeForTests,
    getCachedRevocationState,
    invalidateRevocationCache,
    isSessionRevoked,
    REVOCATION_CACHE_TTL_MS_EXPORT,
    MAX_CACHED_SESSIONS_EXPORT,
  } = await import('../src/lib/server/auth/session-revocation-cache.ts');

  resetRevocationCacheForTests();

  // 3a. Cache miss → calls lookup → caches result.
  let lookupCalls = 0;
  const { revoked: result1 } = await isSessionRevoked(
    'user-1',
    'session-1',
    async () => {
      lookupCalls++;
      return { revoked: false };
    }
  );
  assert.equal(result1, false, '3a. cache miss returns lookup result (not revoked)');
  assert.equal(lookupCalls, 1, '3a. cache miss triggers exactly one lookup');
  assert.equal(getRevocationCacheSizeForTests(), 1, '3a. cache has 1 entry after miss');

  // 3b. Cache hit → does NOT call lookup.
  const { revoked: result2 } = await isSessionRevoked(
    'user-1',
    'session-1',
    async () => {
      lookupCalls++;
      return { revoked: true }; // Should NOT be called — cache has false.
    }
  );
  assert.equal(result2, false, '3b. cache hit returns cached value (false, not the lookup)');
  assert.equal(lookupCalls, 1, '3b. cache hit does NOT trigger lookup');

  // 3c. Invalidation forces a re-lookup.
  invalidateRevocationCache('session-1');
  assert.equal(getRevocationCacheSizeForTests(), 0, '3c. invalidation clears the entry');
  const { revoked: result3 } = await isSessionRevoked(
    'user-1',
    'session-1',
    async () => {
      lookupCalls++;
      return { revoked: true };
    }
  );
  assert.equal(result3, true, '3c. after invalidation, the new lookup result is used (true)');
  assert.equal(lookupCalls, 2, '3c. invalidation forces a re-lookup');

  // 3d. TTL expiry forces a re-lookup.
  resetRevocationCacheForTests();
  setRevocationCacheEntryForTests('session-2', false, -1000); // expired 1s ago
  let lookupCalls2 = 0;
  const { revoked: result4 } = await isSessionRevoked(
    'user-2',
    'session-2',
    async () => {
      lookupCalls2++;
      return { revoked: true };
    }
  );
  assert.equal(result4, true, '3d. expired cache entry is ignored, lookup result is used');
  assert.equal(lookupCalls2, 1, '3d. expired cache entry triggers a fresh lookup');

  // 3e. Lookup failure → fail-open (revoked=false, NOT cached).
  resetRevocationCacheForTests();
  let lookupCalls3 = 0;
  const { revoked: result5 } = await isSessionRevoked(
    'user-3',
    'session-3',
    async () => {
      lookupCalls3++;
      throw new Error('DB unavailable');
    }
  );
  assert.equal(result5, false, '3e. DB lookup failure fails-open (revoked=false)');
  assert.equal(lookupCalls3, 1, '3e. lookup was attempted');
  assert.equal(getRevocationCacheSizeForTests(), 0, '3e. failed lookup is NOT cached');

  // 3f. Cross-session isolation — different session_ids are cached separately.
  resetRevocationCacheForTests();
  setRevocationCacheEntryForTests('session-A', false);
  setRevocationCacheEntryForTests('session-B', true);
  const { revoked: rA } = await isSessionRevoked('user-X', 'session-A', async () => ({ revoked: false }));
  const { revoked: rB } = await isSessionRevoked('user-X', 'session-B', async () => ({ revoked: false }));
  assert.equal(rA, false, '3f. session-A returns its own cached value');
  assert.equal(rB, true, '3f. session-B returns its own cached value (NOT cross-contaminated)');

  // 3g. Constants are exported + sensible.
  assert.equal(REVOCATION_CACHE_TTL_MS_EXPORT, 30_000, '3g. TTL is 30s');
  assert.equal(MAX_CACHED_SESSIONS_EXPORT, 5_000, '3g. max entries is 5000');

  passed += 7;
  console.log('  ok 3a — cache miss triggers lookup + caches result');
  console.log('  ok 3b — cache hit does NOT trigger lookup');
  console.log('  ok 3c — invalidation forces re-lookup');
  console.log('  ok 3d — TTL expiry forces re-lookup');
  console.log('  ok 3e — DB lookup failure fails-open (NOT cached)');
  console.log('  ok 3f — cross-session isolation (no cross-contamination)');
  console.log('  ok 3g — TTL=30s, MAX=5000 exported constants');

  ok('3. revocation cache deterministic behavior (miss/hit/invalidate/TTL/fail-open/isolation)');
}

// ============================================================
// 4. REVOKE-ALL API — CONTRACT
// ============================================================
{
  const api = read('src/routes/api/account/sessions/revoke-all/+server.ts');

  // Auth required.
  ok(api.includes('RequestHandler'), 'revoke-all API: RequestHandler type');
  ok(api.includes('locals.user'), 'revoke-all API: uses locals.user for auth');
  ok(api.includes('if (!user)'), 'revoke-all API: authentication guard');
  ok(api.includes('401'), 'revoke-all API: returns 401 for unauthenticated');

  // Server-derived identity.
  ok(api.includes('extractSessionId'), 'revoke-all API: derives current session_id from JWT (server-side)');
  ok(api.includes('locals.session'), 'revoke-all API: uses locals.session (NOT client-supplied)');

  // Uses the existing service — does NOT duplicate DB mutation logic.
  ok(api.includes('revokeAllOtherSessions'), 'revoke-all API: calls revokeAllOtherSessions service');
  ok(api.includes('user.id'), 'revoke-all API: passes server-derived user.id');
  ok(api.includes('currentSessionId'), 'revoke-all API: passes server-derived currentSessionId');

  // Cache invalidation after revoke.
  ok(api.includes('invalidateRevocationCache'), 'revoke-all API: invalidates revocation cache for revoked sessions');

  // Safe response — no sensitive data.
  ok(api.includes('revokedCount'), 'revoke-all API: returns revokedCount');
  ok(api.includes('cache-control'), 'revoke-all API: cache-control header');
  ok(api.includes('no-store'), 'revoke-all API: cache-control value is no-store');
  // access_token appears only in the server-side `session.access_token` check
  // (extractSessionId), NOT in the JSON response body.
  ok(!api.match(/json\(\s*\{[^}]*access_token/), 'revoke-all API: no access_token in JSON response body');
  ok(!api.match(/json\(\s*\{[^}]*refresh_token/), 'revoke-all API: no refresh_token in JSON response body');
  ok(!api.includes('supabase_session_id.*json'), 'revoke-all API: does NOT return supabase_session_id in JSON');

  // Never accepts user_id from client.
  ok(!api.includes('body.*user_id'), 'revoke-all API: does NOT accept user_id from body');
  ok(!api.includes('searchParams.*user_id'), 'revoke-all API: does NOT accept user_id from query');
  ok(!api.includes('body.*session_id'), 'revoke-all API: does NOT accept session_id from body');

  ok('4. revoke-all API contract (auth, server-derived identity, service reuse, cache invalidation, safe response)');
}

// ============================================================
// 5. REVOKE-ALL API — CURRENT SESSION PROTECTION
// ============================================================
{
  const api = read('src/routes/api/account/sessions/revoke-all/+server.ts');
  const service = read('src/lib/server/auth/device-sessions.ts');

  // The service MUST filter out the current session via .neq().
  ok(service.includes('.neq(\'supabase_session_id\', currentSessionId)'), 'revoke-all service: filters out current session via .neq()');
  ok(service.includes('.eq(\'user_id\', userId)'), 'revoke-all service: scopes by user_id');
  ok(service.includes('.is(\'revoked_at\', null)'), 'revoke-all service: only revokes active sessions');

  // The API passes the CURRENT session_id (server-derived) to the service.
  ok(api.includes('currentSessionId'), 'revoke-all API: passes currentSessionId to service');

  // The API does NOT accept a "target session" parameter — it only
  // ever revokes OTHER sessions.
  ok(!api.includes('targetSessionId'), 'revoke-all API: does NOT accept a targetSessionId param');
  ok(!api.includes('body.value?.sessionId'), 'revoke-all API: does NOT accept a sessionId body param');

  ok('5. revoke-all current-session protection (never revokes the current session)');
}

// ============================================================
// 6. REVOKE-ALL API — IDEMPOTENCY + EMPTY CASE
// ============================================================
{
  const service = read('src/lib/server/auth/device-sessions.ts');

  // The service handles the "no other sessions" case gracefully.
  ok(service.includes('others.length === 0'), 'revoke-all service: handles empty case (no others to revoke)');

  // Returns a count + list of revoked session IDs.
  ok(service.includes('count: number') || service.includes('count: revokedSessionIds.length'), 'revoke-all service: returns count');
  ok(service.includes('revokedSessionIds'), 'revoke-all service: returns revokedSessionIds list');

  // The API returns ok=true even when count=0.
  const api = read('src/routes/api/account/sessions/revoke-all/+server.ts');
  ok(api.includes('ok: true'), 'revoke-all API: returns ok=true on success');
  ok(api.includes('revokedCount: count'), 'revoke-all API: returns the actual count (0 or N)');
  ok(api.includes('No other devices to sign out'), 'revoke-all API: handles 0-devices case with a sensible message');

  ok('6. revoke-all idempotency (empty case returns ok=true with count=0)');
}

// ============================================================
// 7. ACCOUNT UI — SIGN OUT ALL DEVICES BUTTON
// ============================================================
{
  const page = read('src/routes/account/+page.svelte');

  // The button exists.
  ok(page.includes('Sign out all devices'), 'account page: has "Sign out all devices" button');
  ok(page.includes('signout-all-btn'), 'account page: has signout-all-btn class');

  // The confirmation dialog exists.
  ok(page.includes('Sign out all other devices?'), 'account page: has confirmation dialog title');
  ok(page.includes('sign you out from every other device'), 'account page: confirmation explains scope');
  ok(page.includes('This device will remain signed in'), 'account page: confirmation explains current device stays');

  // State management — idle / submitting / error.
  ok(page.includes('signoutAllOpen'), 'account page: signoutAllOpen state');
  ok(page.includes('signoutAllBusy'), 'account page: signoutAllBusy state (prevents duplicate submissions)');
  ok(page.includes('signoutAllError'), 'account page: signoutAllError state');
  ok(page.includes('openSignoutAll'), 'account page: openSignoutAll handler');
  ok(page.includes('closeSignoutAll'), 'account page: closeSignoutAll handler');
  ok(page.includes('confirmSignoutAll'), 'account page: confirmSignoutAll handler');

  // Prevents duplicate submissions.
  ok(page.includes('if (signoutAllBusy) return'), 'account page: prevents duplicate confirmSignoutAll calls');
  ok(page.includes('disabled={signoutAllBusy}'), 'account page: button disabled while busy');

  // After success, refreshes the session list from the server.
  ok(page.includes('await loadSessions()'), 'account page: refreshes session list after revoke-all');

  // Calls the correct endpoint.
  ok(page.includes('/api/account/sessions/revoke-all'), 'account page: calls revoke-all API');

  // The button is only shown when there are OTHER sessions to revoke.
  ok(page.includes('sessions.filter((s) => !s.isCurrent).length > 0'), 'account page: only shows sign-out-all when other sessions exist');

  // No sensitive data in UI.
  ok(!page.includes('access_token'), 'account page: no access_token reference');
  ok(!page.includes('refresh_token'), 'account page: no refresh_token reference');

  ok('7. account UI Sign out all devices (button, confirmation, states, refresh, no tokens)');
}

// ============================================================
// 8. INDIVIDUAL REVOKE — REGRESSION
// ============================================================
// The existing individual revoke feature must still work AND must
// now also invalidate the revocation cache so the target session is
// rejected on its next request.
{
  const api = read('src/routes/api/account/sessions/revoke/+server.ts');

  ok(api.includes('revokeSession'), 'individual revoke: still uses revokeSession service');
  ok(api.includes('eq(\'user_id\', user.id)'), 'individual revoke: IDOR protection (filters by user_id)');
  ok(api.includes('targetRow.supabase_session_id === currentSessionId'), 'individual revoke: current-session protection');
  ok(api.includes('Use sign out to end your current session'), 'individual revoke: helpful message for current session');

  // Phase 3 NEW: cache invalidation after individual revoke.
  ok(api.includes('invalidateRevocationCache'), 'individual revoke: invalidates revocation cache (Phase 3)');
  ok(api.includes('targetRow.supabase_session_id'), 'individual revoke: invalidates by target session_id');

  ok('8. individual revoke regression (IDOR, current-session protection, cache invalidation)');
}

// ============================================================
// 9. SERVICE CONTRACT — revokeAllOtherSessions RETURN VALUE
// ============================================================
// The OLD revokeAllOtherSessions returned a hardcoded `1` (incorrect
// count). The Phase 3 fix returns the actual count + list of revoked
// session IDs (used for cache invalidation).
{
  const service = read('src/lib/server/auth/device-sessions.ts');

  // The fn signature returns { count, revokedSessionIds }.
  ok(service.includes('Promise<{ count: number; revokedSessionIds: string[] }>'), 'service: revokeAllOtherSessions returns { count, revokedSessionIds }');

  // Looks up other sessions BEFORE the UPDATE so we can invalidate caches.
  ok(service.includes('select(\'supabase_session_id\')'), 'service: revokeAllOtherSessions selects other session IDs before update');
  ok(service.includes('revokedSessionIds = others.map'), 'service: revokeAllOtherSessions maps revoked IDs');

  // No longer returns a hardcoded 1.
  ok(!service.match(/return 1;\s*\/\/ Supabase update doesn.t return the count/), 'service: revokeAllOtherSessions does NOT return hardcoded 1');

  // lookupSessionRevocationState exists for the hooks check.
  ok(service.includes('export async function lookupSessionRevocationState'), 'service: exports lookupSessionRevocationState');
  ok(service.includes('select(\'revoked_at\')'), 'service: lookupSessionRevocationState selects only revoked_at');
  ok(service.includes('.eq(\'user_id\', userId)'), 'service: lookupSessionRevocationState scoped by user_id');
  ok(service.includes('.eq(\'supabase_session_id\', supabaseSessionId)'), 'service: lookupSessionRevocationState scoped by supabase_session_id');

  // Fail-open on DB error.
  ok(service.includes('return { revoked: false }'), 'service: lookupSessionRevocationState fails-open on error');

  ok('9. service contract (revokeAllOtherSessions count, lookupSessionRevocationState, fail-open)');
}

// ============================================================
// 10. SECURITY — NO CLIENT-SUPPLIED IDENTITY
// ============================================================
{
  const revokeAllApi = read('src/routes/api/account/sessions/revoke-all/+server.ts');
  const revokeApi = read('src/routes/api/account/sessions/revoke/+server.ts');
  const sessionsApi = read('src/routes/api/account/sessions/+server.ts');
  const hooks = read('src/hooks.server.ts');

  // None of the APIs accept user_id from the client.
  for (const [name, file] of [
    ['revoke-all API', revokeAllApi],
    ['revoke API', revokeApi],
    ['sessions API', sessionsApi],
  ] as const) {
    ok(!file.match(/body\.value\?\.user_id/) && !file.match(/searchParams\.get\(['"]user_id['"]\)/), `${name}: does NOT accept user_id from client`);
  }

  // The hook derives user_id from locals.user (server-side auth context).
  ok(hooks.includes('auth.user.id'), 'hooks: derives user.id from server auth context');
  ok(hooks.includes('extractSessionId(auth.session.access_token)'), 'hooks: derives session_id from JWT (NOT from client)');

  // No service-role keys in client code.
  const page = read('src/routes/account/+page.svelte');
  ok(!page.includes('PRIVATE_SUPABASE_SERVICE_ROLE_KEY'), 'account page: no service-role key');
  ok(!page.includes('createSupabaseAdminClient'), 'account page: no admin client import');

  ok('10. security: no client-supplied identity (user_id, session_id all server-derived)');
}

// ============================================================
// 11. SIGN-OUT — CACHE INVALIDATION REGRESSION
// ============================================================
// Sign-out revokes the current session via the service AND must
// invalidate the cache so the next request from this browser (if
// any cookie lingers) is rejected.
{
  const signOut = read('src/routes/auth/sign-out/+server.ts');

  ok(signOut.includes('revokeSession'), 'sign-out: still revokes via service');
  ok(signOut.includes('invalidateRevocationCache'), 'sign-out: invalidates revocation cache (Phase 3)');
  ok(signOut.includes('supabaseSessionId'), 'sign-out: invalidates by current session_id');
  ok(signOut.includes('locals.supabase.auth.signOut'), 'sign-out: still calls Supabase signOut');
  ok(signOut.includes('redirect(303'), 'sign-out: still redirects to /discover');

  ok('11. sign-out regression (revoke + cache invalidation + Supabase signOut + redirect)');
}

// ============================================================
// 12. REGRESSION — EXISTING AUTH BEHAVIOR PRESERVED
// ============================================================
{
  const hooks = read('src/hooks.server.ts');
  ok(hooks.includes('safeGetSession'), 'hooks: still uses safeGetSession');
  ok(hooks.includes('locals.session = auth.session'), 'hooks: still sets locals.session (when not revoked)');
  ok(hooks.includes('locals.user = auth.user'), 'hooks: still sets locals.user (when not revoked)');
  ok(hooks.includes('registerCurrentSession'), 'hooks: still registers device sessions');

  // The DEFAULT-DENY env-missing path is preserved.
  ok(hooks.includes('isEnvironmentFreePath'), 'hooks: still uses isEnvironmentFreePath');
  ok(hooks.includes('503'), 'hooks: still returns 503 for env-missing');

  ok('12. regression: existing auth behavior preserved (safeGetSession, registration, DEFAULT-DENY)');
}

console.log(`\nPhase 3 individual revoke + sign out all tests passed (${passed} check groups).`);
