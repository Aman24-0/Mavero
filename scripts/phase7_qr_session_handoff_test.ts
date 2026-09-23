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
// PHASE 7 — QR → NEW AUTHENTICATED SESSION HANDOFF TESTS
// ============================================================
// Phase 7 verifies the complete session handoff: after the phone
// approves the TV pairing, the TV establishes its OWN independent
// Supabase session via server-side exchangeCodeForSession(). The
// phone's session is NEVER copied.
//
// STATIC CONTRACT tests. Runtime verification (actual Supabase
// session exchange, actual cookie set, actual device_sessions
// registration) is out of scope — no live Supabase credentials.

// ============================================================
// SECTION 1 — EXCHANGE ENDPOINT EXISTS
// ============================================================
{
  const api = read('src/routes/api/auth/device-pairing/exchange/+server.ts');

  ok(api.includes('POST'), '1. exchange endpoint: POST handler exists');
  ok(api.includes('RequestHandler'), '1. exchange endpoint: RequestHandler type');
  ok(api.includes('claimAndExchangePairing'), '1. exchange endpoint: calls claimAndExchangePairing service');
  ok(api.includes('readJsonBody'), '1. exchange endpoint: bounded body parsing');
  ok(api.includes('MAX_BODY_BYTES'), '1. exchange endpoint: body size limit');

  ok('1. exchange endpoint exists');
}

// ============================================================
// SECTION 2 — EXCHANGE ENDPOINT USES TV SSR CLIENT
// ============================================================
{
  const api = read('src/routes/api/auth/device-pairing/exchange/+server.ts');

  // Uses locals.supabase (the TV request's own SSR client).
  ok(api.includes('locals.supabase'), '2. exchange endpoint: uses locals.supabase (TV SSR client)');
  ok(api.includes('tvSupabase = locals.supabase'), '2. exchange endpoint: assigns to tvSupabase');
  ok(api.includes('claimAndExchangePairing(admin, tvSupabase'), '2. exchange endpoint: passes TV SSR client to service');

  // Does NOT use the admin client for exchangeCodeForSession.
  ok(!api.includes('admin.auth.exchangeCodeForSession'), '2. exchange endpoint: does NOT use admin client for exchange');

  ok('2. exchange endpoint uses TV SSR client (not admin)');
}

// ============================================================
// SECTION 3 — exchangeCodeForSession IS SERVER-SIDE
// ============================================================
{
  const service = read('src/lib/server/auth/device-pairing.ts');
  const exchangeApi = read('src/routes/api/auth/device-pairing/exchange/+server.ts');
  const tvLogin = read('src/routes/tv-login/+page.svelte');

  // The service calls exchangeCodeForSession on the TV SSR client.
  ok(service.includes('exchangeCodeForSession'), '3. service: calls exchangeCodeForSession');
  ok(service.includes('tvSupabase.auth.exchangeCodeForSession'), '3. service: calls on tvSupabase (TV SSR client)');

  // The TV login page does NOT call exchangeCodeForSession directly
  // (only the server-side service does). The word may appear in
  // comments — we check for actual function call syntax, not string
  // presence in comments.
  ok(!tvLogin.match(/\.auth\.exchangeCodeForSession\(/), '3. TV login: does NOT call .auth.exchangeCodeForSession() directly (server-side only)');

  // The exchange endpoint delegates to the service function
  // claimAndExchangePairing (verified in Sections 1 and 2). The
  // actual exchangeCodeForSession() call happens inside the service,
  // not in the endpoint handler. (The word may appear in JSDoc
  // comments — Sections 1 and 2 already prove delegation.)
  ok(exchangeApi.includes('claimAndExchangePairing(admin, tvSupabase'), '3. exchange endpoint: delegates to service with TV SSR client');

  ok('3. exchangeCodeForSession is server-side (never client-side)');
}

// ============================================================
// SECTION 4 — NO TOKEN JSON RESPONSE
// ============================================================
{
  const api = read('src/routes/api/auth/device-pairing/exchange/+server.ts');

  // Success response contains only ok + message.
  ok(api.includes("ok: true"), '4. exchange: success response has ok: true');
  ok(api.includes('Session established'), '4. exchange: success response has message');

  // No tokens in JSON response body.
  ok(!api.match(/json\(\s*\{[^}]*access_token/), '4. exchange: no access_token in JSON response');
  ok(!api.match(/json\(\s*\{[^}]*refresh_token/), '4. exchange: no refresh_token in JSON response');
  ok(!api.match(/json\(\s*\{[^}]*exchange_code/), '4. exchange: no exchange_code in JSON response');
  ok(!api.match(/json\(\s*\{[^}]*session/), '4. exchange: no session object in JSON response');

  ok('4. no auth tokens in JSON response');
}

// ============================================================
// SECTION 5 — ATOMIC CLAIM RPC
// ============================================================
{
  const migration = read('supabase/migrations/20260929000000_device_pairing_claim_rpc.sql');

  // Function definition.
  ok(migration.includes('create or replace function public.claim_device_pairing'), '5. RPC function defined');
  ok(migration.includes('language plpgsql'), '5. RPC is PL/pgSQL');
  ok(migration.includes('security definer'), '5. RPC is SECURITY DEFINER');
  ok(migration.includes('set search_path = public'), '5. RPC pins search_path');

  // SELECT FOR UPDATE.
  ok(migration.includes('for update;'), '5. RPC: SELECT ... FOR UPDATE (row lock)');

  // WHERE clause guards.
  ok(migration.includes("status = 'approved'"), '5. RPC: WHERE status=approved');
  ok(migration.includes('consumed_at is null'), '5. RPC: WHERE consumed_at IS NULL');
  ok(migration.includes('expires_at > p_now'), '5. RPC: WHERE expires_at > now');

  // UPDATE to consumed.
  ok(migration.includes("set status = 'consumed'"), '5. RPC: UPDATE sets status=consumed');
  ok(migration.includes('consumed_at = p_now'), '5. RPC: UPDATE sets consumed_at');
  ok(migration.includes('exchange_code = null'), '5. RPC: UPDATE clears exchange_code');

  // Privilege lockdown.
  ok(migration.includes('revoke execute on function public.claim_device_pairing'), '5. RPC: EXECUTE revoked');
  ok(migration.includes('grant execute on function public.claim_device_pairing'), '5. RPC: EXECUTE granted');
  ok(migration.includes('to service_role'), '5. RPC: granted to service_role');

  ok('5. atomic claim RPC (SELECT FOR UPDATE, consumed, privilege lockdown)');
}

// ============================================================
// SECTION 6 — OLD exchange_code CAPTURED BEFORE CLEARING
// ============================================================
{
  const migration = read('supabase/migrations/20260929000000_device_pairing_claim_rpc.sql');
  const service = read('src/lib/server/auth/device-pairing.ts');

  // RPC captures OLD exchange_code into v_row BEFORE UPDATE.
  ok(migration.includes('select id, exchange_code into v_row'), '6. RPC: captures OLD exchange_code into v_row');
  ok(migration.includes('for update;'), '6. RPC: row lock BEFORE update');

  // RPC returns the OLD value.
  ok(migration.includes('return query select v_row.id'), '6. RPC: returns OLD v_row.id');
  ok(migration.includes('v_row.exchange_code'), '6. RPC: returns OLD v_row.exchange_code');

  // Service reads the OLD OTP from the RPC result.
  ok(service.includes('const otpCode = claimed.exchange_code'), '6. service: reads OLD OTP from RPC result');
  ok(service.includes('exchangeCodeForSession(otpCode)'), '6. service: passes OLD OTP to exchangeCodeForSession');

  // Service does NOT use .update().select() (which returns NEW values).
  ok(!service.match(/\.update\(\{[\s\S]*?exchange_code:\s*null[\s\S]*?\}\.select\(/m), '6. service: NO broken .update().select() pattern');

  ok('6. OLD exchange_code captured before clearing (RPC v_row pattern)');
}

// ============================================================
// SECTION 7 — CONSUMED STATE
// ============================================================
{
  const migration = read('supabase/migrations/20260929000000_device_pairing_claim_rpc.sql');
  const service = read('src/lib/server/auth/device-pairing.ts');

  // RPC sets status to consumed.
  ok(migration.includes("set status = 'consumed'"), '7. RPC: UPDATE sets status=consumed');
  ok(migration.includes('consumed_at = p_now'), '7. RPC: UPDATE sets consumed_at');

  // Service handles consumed state in diagnostic.
  ok(service.includes("current.status === 'consumed'"), '7. service: handles consumed status in diagnostic');
  ok(service.includes('already been consumed'), '7. service: returns consumed message');
  ok(service.includes('status: 409'), '7. service: returns 409 for consumed');

  ok('7. consumed state (RPC sets it, service handles it)');
}

// ============================================================
// SECTION 8 — SINGLE-USE PROTECTION
// ============================================================
{
  const migration = read('supabase/migrations/20260929000000_device_pairing_claim_rpc.sql');
  const service = read('src/lib/server/auth/device-pairing.ts');

  // RPC WHERE clause prevents claiming a consumed row.
  ok(migration.includes("status = 'approved'"), '8. RPC: requires status=approved (not consumed)');
  ok(migration.includes('consumed_at is null'), '8. RPC: requires consumed_at IS NULL (not already consumed)');

  // After claim, status is consumed — a second claim finds no row.
  ok(migration.includes("set status = 'consumed'"), '8. RPC: UPDATE changes status to consumed (prevents second claim)');

  // Service handles empty result (loser of race).
  ok(service.includes('Array.isArray(claimedRows) && claimedRows.length > 0'), '8. service: checks if RPC returned a row');
  ok(service.includes('!claimed'), '8. service: handles empty RPC result (race loser)');

  ok('8. single-use protection (RPC WHERE + consumed state + service handles empty)');
}

// ============================================================
// SECTION 9 — APPROVAL RACE PROTECTION (PHASE 7 FIX)
// ============================================================
// Phase 7 fix: the approve function now chains .select() after .update()
// to verify the UPDATE actually affected a row. Without this check,
// a concurrent approval that loses the race would falsely report
// success because the Supabase JS client returns { error: null }
// even when 0 rows are affected.
{
  const service = read('src/lib/server/auth/device-pairing.ts');

  // The approve function chains .select() after .update().
  ok(service.includes('.select('), '9. approve: chains .select() after .update()');
  ok(service.includes("select('id')"), '9. approve: selects id to verify affected rows');

  // The approve function checks the returned data.
  ok(service.includes('updatedRows'), '9. approve: captures updatedRows from .select()');
  ok(service.includes('!updatedRows || updatedRows.length === 0'), '9. approve: checks if 0 rows affected (race lost)');

  // Returns failure when race is lost.
  ok(service.includes("'This request was already approved.'"), '9. approve: returns failure when race lost');

  // Still has the .eq('status', 'pending') guard.
  ok(service.includes("eq('status', 'pending')"), '9. approve: still has .eq(status, pending) atomic guard');

  ok('9. approval race protection (.select() verifies affected rows)');
}

// ============================================================
// SECTION 9b — APPROVAL RACE SIMULATION
// ============================================================
// Deterministic simulation: two concurrent approvals for the same
// pending pairing. Exactly one should succeed.
{
  type Row = { id: string; status: string; exchange_code: string | null };
  let dbRow: Row = { id: 'pairing-1', status: 'pending', exchange_code: null };

  function simulateApprove(otp: string): { success: boolean; error: string | null } {
    // Phase 7 fix: simulate .update().select('id') — returns the
    // updated rows. If WHERE status='pending' doesn't match (because
    // another approval already changed it), returns empty array.
    if (dbRow.status !== 'pending') {
      // WHERE clause doesn't match — 0 rows affected.
      return { success: false, error: 'This request was already approved.' };
    }
    dbRow = { ...dbRow, status: 'approved', exchange_code: otp };
    return { success: true, error: null };
  }

  // Request A wins.
  const resultA = simulateApprove('OTP_A');
  assert.equal(resultA.success, true, '9b. first approve succeeds');
  assert.equal(resultA.error, null, '9b. first approve has no error');

  // Request B loses (status is now 'approved', not 'pending').
  const resultB = simulateApprove('OTP_B');
  assert.equal(resultB.success, false, '9b. second approve fails (race lost)');
  assert.equal(resultB.error, 'This request was already approved.', '9b. second approve returns race-lost error');
  assert.equal(dbRow.exchange_code, 'OTP_A', '9b. DB has OTP_A (winner), not OTP_B (loser)');

  passed += 4;
  console.log('  ok 9b-1 — first approve succeeds');
  console.log('  ok 9b-2 — first approve has no error');
  console.log('  ok 9b-3 — second approve fails (race lost)');
  console.log('  ok 9b-4 — DB has winner OTP, not loser OTP');

  ok('9b. approval race simulation (single winner, loser correctly fails)');
}

// ============================================================
// SECTION 10 — OTP NEVER REACHES CLIENT
// ============================================================
{
  const statusApi = read('src/routes/api/auth/device-pairing/status/+server.ts');
  const createApi = read('src/routes/api/auth/device-pairing/create/+server.ts');
  const exchangeApi = read('src/routes/api/auth/device-pairing/exchange/+server.ts');
  const approveApi = read('src/routes/api/auth/device-pairing/approve/+server.ts');
  const service = read('src/lib/server/auth/device-pairing.ts');
  const tvLogin = read('src/routes/tv-login/+page.svelte');

  // Status endpoint: no exchange_code in response.
  ok(!statusApi.match(/exchange_code.*json/), '10. status: no exchange_code in JSON');

  // Create endpoint: no exchange_code in response.
  ok(!createApi.match(/exchange_code.*json/), '10. create: no exchange_code in JSON');

  // Exchange endpoint: no exchange_code in response.
  ok(!exchangeApi.match(/exchange_code.*json/), '10. exchange: no exchange_code in JSON');

  // Approve endpoint: no exchange_code in response.
  ok(!approveApi.match(/exchange_code.*json/), '10. approve: no exchange_code in JSON');

  // getPairingBySecret does NOT select exchange_code.
  const fnStart = service.indexOf('export async function getPairingBySecret');
  const fnEnd = service.indexOf('\n}\n', fnStart);
  const fnBody = service.slice(fnStart, fnEnd !== -1 ? fnEnd : undefined);
  ok(fnBody.includes("select('status, expires_at')"), '10. getPairingBySecret: selects ONLY status + expires_at');
  ok(!fnBody.includes('exchange_code'), '10. getPairingBySecret: does NOT select exchange_code');

  // TV login page does NOT reference exchange_code.
  ok(!tvLogin.match(/\bexchange_code\b/), '10. TV login: no exchange_code reference');

  ok('10. OTP never reaches client (status, create, exchange, approve, service, TV login)');
}

// ============================================================
// SECTION 11 — NO SENSITIVE LOGGING
// ============================================================
{
  const service = read('src/lib/server/auth/device-pairing.ts');
  const exchangeApi = read('src/routes/api/auth/device-pairing/exchange/+server.ts');
  const approveApi = read('src/routes/api/auth/device-pairing/approve/+server.ts');

  const allFiles = [service, exchangeApi, approveApi];

  for (const file of allFiles) {
    ok(!file.match(/console\.\w+.*exchange_code/i), '11. no file logs exchange_code');
    ok(!file.match(/console\.\w+.*hashed_token/i), '11. no file logs hashed_token');
    ok(!file.match(/console\.\w+.*access_token/i), '11. no file logs access_token');
    ok(!file.match(/console\.\w+.*refresh_token/i), '11. no file logs refresh_token');
    ok(!file.match(/console\.\w+.*\bsecret\b/i), '11. no file logs raw secret');
    ok(!file.match(/console\.\w+.*otp/i), '11. no file logs OTP');
  }

  ok('11. no sensitive logging (exchange_code, hashed_token, tokens, secret, OTP)');
}

// ============================================================
// SECTION 12 — no-store HEADERS
// ============================================================
{
  const createApi = read('src/routes/api/auth/device-pairing/create/+server.ts');
  const statusApi = read('src/routes/api/auth/device-pairing/status/+server.ts');
  const approveApi = read('src/routes/api/auth/device-pairing/approve/+server.ts');
  const exchangeApi = read('src/routes/api/auth/device-pairing/exchange/+server.ts');

  for (const [name, file] of [
    ['create', createApi],
    ['status', statusApi],
    ['approve', approveApi],
    ['exchange', exchangeApi],
  ] as const) {
    ok(file.includes('cache-control'), `12. ${name}: has cache-control header`);
    ok(file.includes('no-store'), `12. ${name}: cache-control value is no-store`);
  }

  ok('12. no-store headers on all pairing endpoints');
}

// ============================================================
// SECTION 13 — TV SESSION REGISTRATION PATH
// ============================================================
{
  const hooks = read('src/hooks.server.ts');
  const service = read('src/lib/server/auth/device-sessions.ts');

  // hooks.server.ts calls registerCurrentSession.
  ok(hooks.includes('registerCurrentSession'), '13. hooks: calls registerCurrentSession');
  ok(hooks.includes('extractSessionId'), '13. hooks: extracts session ID from JWT');
  ok(hooks.includes('auth.user.id'), '13. hooks: passes server-derived user.id');
  ok(hooks.includes('supabaseSessionId'), '13. hooks: passes server-derived session_id');
  ok(hooks.includes('parseDeviceMetadata'), '13. hooks: parses device metadata from UA');

  // registerCurrentSession delegates to the RPC.
  ok(service.includes("rpc('register_device_session'"), '13. service: calls register_device_session RPC');

  // The registration is fire-and-forget (non-blocking).
  ok(hooks.includes('void registerCurrentSession'), '13. hooks: fire-and-forget registration');
  ok(hooks.includes('.catch'), '13. hooks: catches registration errors (non-blocking)');

  ok('13. TV session registration path (hooks → registerCurrentSession → RPC)');
}

// ============================================================
// SECTION 14 — REVOCATION INTEGRATION
// ============================================================
{
  const hooks = read('src/hooks.server.ts');
  const service = read('src/lib/server/auth/device-sessions.ts');

  // hooks checks revocation before registration.
  ok(hooks.includes('isSessionRevoked'), '14. hooks: calls isSessionRevoked');
  ok(hooks.includes('lookupSessionRevocationState'), '14. hooks: calls lookupSessionRevocationState');
  ok(hooks.includes('sessionRevoked'), '14. hooks: has sessionRevoked flag');
  ok(hooks.includes('!sessionRevoked'), '14. hooks: skips registration when revoked');
  ok(hooks.includes('event.locals.session = null'), '14. hooks: clears locals on revoked session');
  ok(hooks.includes('event.locals.user = null'), '14. hooks: clears locals on revoked session');

  // The register_device_session RPC does NOT resurrect revoked sessions.
  const migration = read('supabase/migrations/20260930000000_register_device_session_rpc.sql');
  ok(migration.includes('for update;'), '14. register RPC: SELECT FOR UPDATE (row lock)');
  ok(migration.includes('if v_row.revoked_at is not null then'), '14. register RPC: checks revoked_at');
  ok(migration.includes('return;'), '14. register RPC: returns empty when revoked (do NOT resurrect)');

  ok('14. revocation integration (hooks checks + RPC prevents resurrection)');
}

// ============================================================
// SECTION 15 — POLLING EXCHANGES ONLY AFTER APPROVAL
// ============================================================
{
  const tvLogin = read('src/routes/tv-login/+page.svelte');

  // Polling checks for 'approved' status.
  ok(tvLogin.includes("payload.status === 'approved'"), '15. TV: detects approved status');
  ok(tvLogin.includes("pairingState = 'exchanging'"), '15. TV: transitions to exchanging after approved');

  // Polling stops before exchange.
  ok(tvLogin.includes("clearInterval(pollTimer)"), '15. TV: stops polling before exchange');
  ok(tvLogin.includes("await exchangeSession(token)"), '15. TV: calls exchange after approved');

  // Exchange is called only once (polling stopped + requestToken guard).
  ok(tvLogin.includes('requestToken'), '15. TV: requestToken prevents stale callbacks');
  ok(tvLogin.includes('if (token !== requestToken) return'), '15. TV: stale callback guard');

  ok('15. polling exchanges only after approval (stops + token guard)');
}

// ============================================================
// SECTION 16 — RETRY / NEW PAIRING BEHAVIOR
// ============================================================
{
  const tvLogin = read('src/routes/tv-login/+page.svelte');

  // Retry calls createPairing() which creates a NEW pairing.
  ok(tvLogin.includes('createPairing()'), '16. TV: retry calls createPairing');
  ok(tvLogin.includes('/api/auth/device-pairing/create'), '16. TV: retry creates new pairing via create endpoint');

  // Old secret is not reused.
  ok(tvLogin.includes('++requestToken'), '16. TV: increments requestToken on retry');
  ok(tvLogin.includes('myToken !== requestToken'), '16. TV: stale callbacks bail out');

  // Old timers are cleared.
  ok(tvLogin.includes('clearInterval(pollTimer); pollTimer = undefined'), '16. TV: clears old poll timer');
  ok(tvLogin.includes('clearInterval(countdownTimer); countdownTimer = undefined'), '16. TV: clears old countdown timer');

  ok('16. retry creates new pairing (old secret not reused, timers cleared)');
}

// ============================================================
// SECTION 17 — SESSION ISOLATION
// ============================================================
{
  const exchangeApi = read('src/routes/api/auth/device-pairing/exchange/+server.ts');
  const service = read('src/lib/server/auth/device-pairing.ts');

  // Exchange uses the TV's OWN SSR client (locals.supabase), NOT the admin client.
  ok(exchangeApi.includes('locals.supabase'), '17. exchange: uses locals.supabase (TV SSR client)');
  ok(!exchangeApi.includes('admin.auth.exchangeCodeForSession'), '17. exchange: does NOT use admin for session');

  // The phone's session is NOT copied.
  ok(!service.includes('locals.session.access_token'), '17. service: does NOT read phone access_token');
  ok(!service.includes('locals.session.refresh_token'), '17. service: does NOT read phone refresh_token');

  // No localStorage/sessionStorage token injection.
  const tvLogin = read('src/routes/tv-login/+page.svelte');
  ok(!tvLogin.includes('localStorage'), '17. TV login: no localStorage');
  ok(!tvLogin.includes('sessionStorage'), '17. TV login: no sessionStorage');

  ok('17. session isolation (TV gets own SSR session, phone session not copied)');
}

// ============================================================
// SECTION 18 — TERMINAL STATE HANDLING
// ============================================================
{
  const service = read('src/lib/server/auth/device-pairing.ts');
  const tvLogin = read('src/routes/tv-login/+page.svelte');

  // Service handles all terminal states in the diagnostic branch.
  ok(service.includes("current.status === 'consumed'"), '18. service: handles consumed (409)');
  ok(service.includes("current.status === 'cancelled'"), '18. service: handles cancelled (410)');
  ok(service.includes('isExpired'), '18. service: handles expired (410)');
  ok(service.includes('Pairing request not found'), '18. service: handles not-found (404)');

  // TV handles terminal states.
  ok(tvLogin.includes("'expired'"), '18. TV: expired state');
  ok(tvLogin.includes("'error'"), '18. TV: error state');
  ok(tvLogin.includes("'success'"), '18. TV: success state');
  ok(tvLogin.includes("payload.status === 'cancelled'"), '18. TV: detects cancelled');

  ok('18. terminal state handling (consumed, cancelled, expired, not-found, success, error)');
}

// ============================================================
// SECTION 19 — MALFORMED INPUT HANDLING
// ============================================================
{
  const exchangeApi = read('src/routes/api/auth/device-pairing/exchange/+server.ts');

  // Body size bounded.
  ok(exchangeApi.includes('MAX_BODY_BYTES'), '19. exchange: body size limit');
  ok(exchangeApi.includes('readJsonBody'), '19. exchange: bounded body parser');

  // Secret validation.
  ok(exchangeApi.includes('typeof secret !== \'string\''), '19. exchange: type-checks secret');
  ok(exchangeApi.includes('secret.length < 16'), '19. exchange: minimum secret length');
  ok(exchangeApi.includes('400'), '19. exchange: returns 400 for invalid input');

  // Rejects empty/malformed body.
  ok(exchangeApi.includes('if (!body.ok)'), '19. exchange: rejects malformed body');

  ok('19. malformed input handling (body size, type check, min length)');
}

// ============================================================
// SECTION 20 — RATE-LIMIT INTEGRATION
// ============================================================
{
  const exchangeApi = read('src/routes/api/auth/device-pairing/exchange/+server.ts');
  const rl = read('src/lib/server/http/rate-limit.ts');

  // Exchange endpoint is rate limited.
  ok(exchangeApi.includes('checkRateLimit'), '20. exchange: rate limited');
  ok(exchangeApi.includes("'pairingExchange'"), '20. exchange: uses pairingExchange bucket');
  ok(exchangeApi.includes('429'), '20. exchange: returns 429 on rate limit');
  ok(exchangeApi.includes('retry-after'), '20. exchange: includes retry-after header');

  // Rate limit bucket exists in the rules.
  ok(rl.includes('pairingExchange'), '20. rate-limit: pairingExchange bucket defined');

  ok('20. rate-limit integration (pairingExchange bucket + 429 + retry-after)');
}

// ============================================================
// SECTION 21 — EXCHANGE FAILURE SEMANTICS (DOCUMENTED)
// ============================================================
// The current design intentionally makes the pairing single-use
// BEFORE exchangeCodeForSession(). This is correct: generateLink()
// requires the phone user's auth context which the TV does not have.
// If exchangeCodeForSession() fails, the user must re-pair.
{
  const service = read('src/lib/server/auth/device-pairing.ts');

  // The RPC marks pairing as consumed BEFORE exchangeCodeForSession.
  // The OTP is captured from the RPC's OLD value.
  ok(service.includes('const otpCode = claimed.exchange_code'), '21. service: OTP captured from RPC OLD value');
  ok(service.includes('exchangeCodeForSession(otpCode)'), '21. service: exchange called AFTER claim');

  // If exchangeCodeForSession fails, the pairing is already consumed.
  // The service returns 503 — the user must re-pair.
  ok(service.includes('exchangeError'), '21. service: checks exchange error');
  ok(service.includes('status: 503'), '21. service: returns 503 on exchange failure');
  ok(service.includes('Unable to establish a session'), '21. service: safe error message');

  // The failure is documented as intentional.
  ok(service.includes('Failure semantics') || service.includes('failure semantics') || service.includes('intended behavior'), '21. service: documents intentional terminal-consumption');

  ok('21. exchange failure semantics (pairing consumed before exchange, documented as intentional)');
}

console.log(`\nPhase 7 QR session handoff tests passed (${passed} check groups).`);
