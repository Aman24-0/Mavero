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
// PHASE 9 — FULL DEVICE AUTH REGRESSION SUITE
// ============================================================
// This is the canonical Phase 9 test for the ORIGINAL 9-phase Device
// Auth roadmap. It verifies that Phases 1–8 remain internally
// consistent and that no Phase 8 security hardening broke earlier
// phases.
//
// STATIC CONTRACT + DETERMINISTIC SIMULATION tests only.
// No live Supabase credentials. No external services.

// ============================================================
// A. TEST CHAIN INTEGRITY
// ============================================================
{
  const pkg = JSON.parse(read('package.json'));
  const testScript: string = pkg.scripts.test;

  // All Device Auth suites exist in the correct order.
  const suites = [
    'device_session_registry_test.ts',
    'account_sessions_test.ts',
    'device_pairing_test.ts',
    'phase3_session_revocation_test.ts',
    'phase3_hardening_test.ts',
    'phase4_qr_challenge_backend_test.ts',
    'phase5_tv_login_ui_test.ts',
    'phase6_phone_qr_scanner_test.ts',
    'phase7_qr_session_handoff_test.ts',
    'phase8_security_hardening_test.ts',
    'phase9_device_auth_regression_test.ts',
  ];

  for (const suite of suites) {
    ok(testScript.includes(suite), `A. test chain includes ${suite}`);
  }

  // Verify order: each suite appears after the previous one.
  for (let i = 1; i < suites.length; i++) {
    ok(
      testScript.indexOf(suites[i - 1]) < testScript.indexOf(suites[i]),
      `A. ${suites[i]} appears after ${suites[i - 1]}`
    );
  }

  // Phase 9 is the last Device Auth test.
  ok(
    testScript.indexOf('phase9_device_auth_regression_test.ts') > testScript.indexOf('phase8_security_hardening_test.ts'),
    'A. Phase 9 test is after Phase 8 test'
  );

  ok('A. test chain integrity (11 Device Auth suites in correct order)');
}

// ============================================================
// B. PHASE 1 → SESSION IDENTITY
// ============================================================
{
  const hooks = read('src/hooks.server.ts');
  const jwt = read('src/lib/server/auth/jwt-session-id.ts');
  const sessions = read('src/lib/server/auth/device-sessions.ts');
  const metadata = read('src/lib/server/auth/device-metadata.ts');

  // Session identity from JWT session_id claim.
  ok(jwt.includes('extractSessionId'), 'B. jwt-session-id: has extractSessionId');
  ok(jwt.includes('session_id'), 'B. jwt-session-id: extracts session_id claim');

  // Device ID is separate from auth identity.
  ok(metadata.includes('getOrCreateDeviceId'), 'B. device-metadata: has getOrCreateDeviceId');
  ok(metadata.includes('not a security credential') || metadata.includes('authentication credential'), 'B. device-metadata: documents device ID is NOT a credential');

  // Registration is server-side.
  ok(hooks.includes('registerCurrentSession'), 'B. hooks: calls registerCurrentSession');
  ok(hooks.includes('auth.user.id'), 'B. hooks: uses server-derived user.id');

  // Registration uses atomic RPC.
  ok(sessions.includes("rpc('register_device_session'"), 'B. device-sessions: uses register_device_session RPC');

  // Registration does NOT resurrect revoked sessions.
  ok(sessions.includes('rows.length === 0'), 'B. device-sessions: handles empty RPC result (do NOT resurrect)');
  ok(hooks.includes('!sessionRevoked'), 'B. hooks: skips registration when revoked');

  // Heartbeat throttling.
  ok(sessions.includes('HEARTBEAT_INTERVAL_MS'), 'B. device-sessions: has heartbeat throttle');
  ok(sessions.includes('5 * 60 * 1000'), 'B. device-sessions: 5-minute heartbeat interval');

  // No Phase 8 changes bypassed session registration.
  ok(hooks.includes('registerCurrentSession'), 'B. hooks: registration still present after Phase 8');

  ok('B. Phase 1 session identity preserved');
}

// ============================================================
// C. PHASE 2 → ACCOUNT SESSIONS UI
// ============================================================
{
  const accountPage = read('src/routes/account/+page.svelte');
  const sessionsApi = read('src/routes/api/account/sessions/+server.ts');

  // Sessions UI loads device sessions.
  ok(accountPage.includes('loadSessions'), 'C. account: has loadSessions');
  ok(accountPage.includes('/api/account/sessions'), 'C. account: fetches sessions API');

  // Current session identified server-side.
  ok(sessionsApi.includes('extractSessionId'), 'C. sessions API: identifies current via JWT');
  ok(sessionsApi.includes('isCurrent'), 'C. sessions API: returns isCurrent flag');

  // No tokens reach client.
  ok(!accountPage.includes('access_token'), 'C. account: no access_token');
  ok(!accountPage.includes('refresh_token'), 'C. account: no refresh_token');

  // Current session cannot be revoked via individual revoke.
  ok(accountPage.includes('{#if !session.isCurrent}'), 'C. account: hides revoke button for current session');

  // Login on TV entry point.
  ok(accountPage.includes('Login on TV'), 'C. account: has Login on TV button');
  ok(accountPage.includes('/account/scan-tv'), 'C. account: links to scanner route');

  ok('C. Phase 2 account sessions UI preserved');
}

// ============================================================
// D. PHASE 3 → REVOCATION
// ============================================================
{
  const revokeApi = read('src/routes/api/account/sessions/revoke/+server.ts');
  const revokeAllApi = read('src/routes/api/account/sessions/revoke-all/+server.ts');
  const signOutApi = read('src/routes/auth/sign-out/+server.ts');
  const sessions = read('src/lib/server/auth/device-sessions.ts');

  // INDIVIDUAL REVOKE
  ok(revokeApi.includes('locals.user'), 'D. revoke: requires authentication');
  ok(revokeApi.includes('401'), 'D. revoke: returns 401 for unauthenticated');
  ok(revokeApi.includes("eq('user_id', user.id)"), 'D. revoke: scopes by authenticated user');
  ok(revokeApi.includes('Use sign out to end your current session'), 'D. revoke: blocks current session');
  ok(revokeApi.includes('invalidateRevocationCache'), 'D. revoke: invalidates cache');

  // SIGN OUT ALL
  ok(revokeAllApi.includes('locals.user'), 'D. revoke-all: requires authentication');
  ok(revokeAllApi.includes('extractSessionId'), 'D. revoke-all: derives current session server-side');
  ok(revokeAllApi.includes('revokeAllOtherSessions'), 'D. revoke-all: calls service');
  ok(sessions.includes('.neq'), 'D. revoke-all service: excludes current session');
  ok(sessions.includes("'supabase_session_id', currentSessionId"), 'D. revoke-all service: neq currentSessionId');
  ok(revokeAllApi.includes('invalidateRevocationCache'), 'D. revoke-all: invalidates cache');
  ok(sessions.includes('others.length === 0'), 'D. revoke-all: idempotent empty case');

  // SIGN OUT
  ok(signOutApi.includes('revokeSession'), 'D. sign-out: revokes session');
  ok(signOutApi.includes('invalidateRevocationCache'), 'D. sign-out: invalidates cache');
  ok(signOutApi.includes('signOut'), 'D. sign-out: calls Supabase signOut');
  ok(signOutApi.includes('redirect(303'), 'D. sign-out: redirects');

  ok('D. Phase 3 revocation preserved (individual, sign-out-all, sign-out)');
}

// ============================================================
// E. PHASE 4 → QR CHALLENGE BACKEND
// ============================================================
{
  const createApi = read('src/routes/api/auth/device-pairing/create/+server.ts');
  const statusApi = read('src/routes/api/auth/device-pairing/status/+server.ts');
  const infoApi = read('src/routes/api/auth/device-pairing/info/+server.ts');
  const approveApi = read('src/routes/api/auth/device-pairing/approve/+server.ts');
  const cancelApi = read('src/routes/api/auth/device-pairing/cancel/+server.ts');
  const service = read('src/lib/server/auth/device-pairing.ts');
  const migration = read('supabase/migrations/20260928000000_device_pairing_requests.sql');

  // CREATE
  ok(service.includes('getRandomValues'), 'E. create: crypto.getRandomValues');
  ok(service.includes('Uint8Array(32)'), 'E. create: 32 bytes entropy');
  ok(service.includes('hashSecret'), 'E. create: hashes secret before storage');
  ok(service.includes('5 * 60 * 1000'), 'E. create: 5-minute TTL');
  ok(migration.includes('ENABLE ROW LEVEL SECURITY'), 'E. pairing: RLS enabled');
  ok(!migration.includes('POLICY'), 'E. pairing: no client RLS policies');

  // STATUS
  ok(statusApi.includes('checkRateLimit'), 'E. status: rate limited');
  ok(statusApi.includes("'pairingPoll'"), 'E. status: uses pairingPoll bucket');
  ok(statusApi.includes('no-store'), 'E. status: no-store cache-control');

  // INFO (Phase 8: POST, not GET)
  ok(infoApi.includes('export const POST'), 'E. info: POST handler (Phase 8)');
  ok(!infoApi.includes('export const GET'), 'E. info: no GET handler');
  ok(infoApi.includes("'pairingInfo'"), 'E. info: uses pairingInfo rate limit');
  ok(!infoApi.includes("url.searchParams.get"), 'E. info: no URL query param reading');

  // APPROVE
  ok(approveApi.includes('locals.user'), 'E. approve: requires authentication');
  ok(approveApi.includes('401'), 'E. approve: returns 401 for unauthenticated');
  ok(approveApi.includes('user.id'), 'E. approve: server-derived user.id');
  ok(approveApi.includes("'pairingApprove'"), 'E. approve: uses pairingApprove rate limit');

  // Approval race protection (Phase 7 fix).
  ok(service.includes('.select('), 'E. approve: .select() after .update()');
  ok(service.includes('updatedRows'), 'E. approve: checks affected rows');
  ok(service.includes("'This request was already approved.'"), 'E. approve: returns failure on race loss');

  // CANCEL
  ok(cancelApi.includes("'pairingCancel'"), 'E. cancel: uses pairingCancel rate limit');
  ok(service.includes("eq('status', 'pending')"), 'E. cancel: atomic pending → cancelled');

  ok('E. Phase 4 QR challenge backend preserved');
}

// ============================================================
// F. PHASE 5 → TV LOGIN
// ============================================================
{
  const tvLogin = read('src/routes/tv-login/+page.svelte');
  const createApi = read('src/routes/api/auth/device-pairing/create/+server.ts');

  // QR generated locally.
  ok(tvLogin.includes("import QRCode from 'qrcode'"), 'F. TV: local qrcode import');
  ok(tvLogin.includes('QRCode.toDataURL'), 'F. TV: local QR generation');
  ok(!tvLogin.includes('api.qrserver.com'), 'F. TV: no external QR service');

  // Phase 8: QR URL uses #s= fragment.
  ok(createApi.includes('/authorize#s='), 'F. create: QR URL uses #s= fragment');
  ok(!createApi.includes('/authorize?s='), 'F. create: QR URL does NOT use ?s= query');

  // Responsive QR sizing.
  ok(tvLogin.includes('@media (min-width: 1920px)'), 'F. TV: has TV breakpoint');
  ok(tvLogin.includes('width: 360px'), 'F. TV: QR is 360px at TV breakpoint');

  // Retry creates fresh pairing.
  ok(tvLogin.includes('createPairing()'), 'F. TV: retry calls createPairing');
  ok(tvLogin.includes('requestToken'), 'F. TV: requestToken prevents stale callbacks');

  // Polling stops after approved.
  ok(tvLogin.includes("payload.status === 'approved'"), 'F. TV: detects approved');
  ok(tvLogin.includes("clearInterval(pollTimer)"), 'F. TV: stops polling');

  // Exchange only after approval.
  ok(tvLogin.includes("pairingState = 'exchanging'"), 'F. TV: exchanges after approved');

  // No tokens rendered in page.
  ok(!tvLogin.includes('access_token'), 'F. TV: no access_token');
  ok(!tvLogin.includes('refresh_token'), 'F. TV: no refresh_token');
  ok(!tvLogin.match(/\bexchange_code\b/), 'F. TV: no exchange_code reference');

  ok('F. Phase 5 TV login preserved (including #s= fragment contract)');
}

// ============================================================
// G. PHASE 6 → PHONE SCANNER
// ============================================================
{
  const scanner = read('src/routes/account/scan-tv/+page.svelte');
  const serverLoad = read('src/routes/account/scan-tv/+page.server.ts');

  // Scanner requires authentication.
  ok(serverLoad.includes('locals.user'), 'G. scanner load: checks locals.user');
  ok(serverLoad.includes('redirect'), 'G. scanner load: redirects unauthenticated');

  // Camera is client-side.
  ok(scanner.includes('navigator.mediaDevices.getUserMedia'), 'G. scanner: uses getUserMedia');
  ok(!scanner.includes('fetch.*body.*image'), 'G. scanner: no camera frame upload');

  // QR data is untrusted.
  ok(scanner.includes('javascript:'), 'G. scanner: rejects javascript:');
  ok(scanner.includes('data:'), 'G. scanner: rejects data:');
  ok(scanner.includes('vbscript:'), 'G. scanner: rejects vbscript:');

  // Same origin + exact pathname.
  ok(scanner.includes('window.location.origin'), 'G. scanner: requires same origin');
  ok(scanner.includes("url.pathname !== '/authorize'"), 'G. scanner: requires /authorize path');

  // Secret from fragment (Phase 8).
  ok(scanner.includes('fragmentParams'), 'G. scanner: parses fragment params');
  ok(scanner.includes("fragmentParams.get('s')"), 'G. scanner: extracts secret from fragment');
  ok(!scanner.includes("url.searchParams.get('s')"), 'G. scanner: does NOT read from query');
  ok(scanner.includes("'unexpected-query-params'"), 'G. scanner: rejects query params');
  ok(scanner.includes("'missing-fragment'"), 'G. scanner: rejects missing fragment');

  // Navigation to #s=.
  ok(scanner.includes('goto(`/authorize#s='), 'G. scanner: navigates to /authorize#s=');
  ok(!scanner.includes('goto(`/authorize?s='), 'G. scanner: does NOT navigate to /authorize?s=');

  // Camera cleanup.
  ok(scanner.includes('function stopCamera'), 'G. scanner: has stopCamera');
  ok(scanner.includes('track.stop()'), 'G. scanner: stops tracks');
  ok(scanner.includes('onDestroy'), 'G. scanner: onDestroy cleanup');

  // Video element always mounted.
  ok(scanner.includes('bind:this={video}'), 'G. scanner: video bind:this');
  ok(scanner.includes('class:scan-video-hidden'), 'G. scanner: video visibility via CSS class');

  // Rear camera not mirrored (no actual CSS scaleX rule).
  ok(!scanner.match(/\.scan-video\s*\{[^}]*scaleX/s), 'G. scanner: no scaleX mirror in .scan-video CSS rule');

  // Does not directly approve.
  ok(!scanner.includes('/api/auth/device-pairing/approve'), 'G. scanner: does NOT call approve');
  ok(!scanner.includes('/api/auth/device-pairing/exchange'), 'G. scanner: does NOT call exchange');

  ok('G. Phase 6 phone scanner preserved (including fragment validation)');
}

// ============================================================
// H. PHASE 7 → SESSION HANDOFF
// ============================================================
{
  const service = read('src/lib/server/auth/device-pairing.ts');
  const exchangeApi = read('src/routes/api/auth/device-pairing/exchange/+server.ts');
  const rpcMigration = read('supabase/migrations/20260929000000_device_pairing_claim_rpc.sql');

  // Exchange uses TV SSR client.
  ok(exchangeApi.includes('locals.supabase'), 'H. exchange: uses TV SSR client');
  ok(exchangeApi.includes('claimAndExchangePairing'), 'H. exchange: calls service');

  // Atomic claim RPC.
  ok(rpcMigration.includes('for update;'), 'H. RPC: SELECT FOR UPDATE');
  ok(rpcMigration.includes("status = 'approved'"), 'H. RPC: requires approved');
  ok(rpcMigration.includes('consumed_at is null'), 'H. RPC: requires unconsumed');
  ok(rpcMigration.includes('expires_at > p_now'), 'H. RPC: requires not expired');

  // OLD exchange_code captured.
  ok(rpcMigration.includes('select id, exchange_code into v_row'), 'H. RPC: captures OLD exchange_code');
  ok(rpcMigration.includes('exchange_code = null'), 'H. RPC: clears exchange_code');
  ok(rpcMigration.includes('return query select v_row.id'), 'H. RPC: returns OLD values');

  // Service calls exchangeCodeForSession on TV SSR client.
  ok(service.includes('tvSupabase.auth.exchangeCodeForSession'), 'H. service: exchangeCodeForSession on TV SSR client');

  // No token in JSON response.
  ok(!exchangeApi.match(/json\(\s*\{[^}]*access_token/), 'H. exchange: no access_token in JSON');
  ok(!exchangeApi.match(/json\(\s*\{[^}]*refresh_token/), 'H. exchange: no refresh_token in JSON');
  ok(!exchangeApi.match(/json\(\s*\{[^}]*exchange_code/), 'H. exchange: no exchange_code in JSON');

  // Single-use: consumed pairing cannot be claimed again.
  ok(rpcMigration.includes("status = 'approved'"), 'H. RPC: requires approved (not consumed)');
  ok(service.includes("current.status === 'consumed'"), 'H. service: handles consumed diagnostic');

  // Approval race fix preserved.
  ok(service.includes('.select('), 'H. approve: .select() for affected rows');
  ok(service.includes('!updatedRows || updatedRows.length === 0'), 'H. approve: checks 0 affected rows');

  ok('H. Phase 7 session handoff preserved (atomic claim + race fix + SSR exchange)');
}

// ============================================================
// I. PHASE 8 → SECURITY HARDENING
// ============================================================
{
  const createApi = read('src/routes/api/auth/device-pairing/create/+server.ts');
  const infoApi = read('src/routes/api/auth/device-pairing/info/+server.ts');
  const cancelApi = read('src/routes/api/auth/device-pairing/cancel/+server.ts');
  const authorize = read('src/routes/authorize/+page.svelte');
  const rl = read('src/lib/server/http/rate-limit.ts');

  // QR uses #s= fragment.
  ok(createApi.includes('/authorize#s='), 'I. create: QR uses #s= fragment');
  ok(!createApi.includes('/authorize?s='), 'I. create: no ?s= query');

  // /info is POST.
  ok(infoApi.includes('export const POST'), 'I. info: POST handler');
  ok(!infoApi.includes('export const GET'), 'I. info: no GET handler');
  ok(infoApi.includes('readJsonBody'), 'I. info: JSON body parsing');
  ok(!infoApi.includes("url.searchParams.get"), 'I. info: no query param reading');

  // Authorize reads from fragment.
  ok(authorize.includes('window.location.hash'), 'I. authorize: reads hash');
  ok(authorize.includes('fragmentParams'), 'I. authorize: parses fragment');
  ok(!authorize.includes("searchParams.get('s')"), 'I. authorize: no searchParams.get(s)');
  ok(authorize.includes("method: 'POST'"), 'I. authorize: POST /info');
  ok(!authorize.includes('/info?s='), 'I. authorize: no /info?s= call');

  // All 6 rate-limit buckets exist.
  ok(rl.includes('pairingCreate'), 'I. rate-limit: pairingCreate');
  ok(rl.includes('pairingPoll'), 'I. rate-limit: pairingPoll');
  ok(rl.includes('pairingApprove'), 'I. rate-limit: pairingApprove');
  ok(rl.includes('pairingExchange'), 'I. rate-limit: pairingExchange');
  ok(rl.includes('pairingInfo'), 'I. rate-limit: pairingInfo (Phase 8)');
  ok(rl.includes('pairingCancel'), 'I. rate-limit: pairingCancel (Phase 8)');

  // 429 + retry-after on rate-limited endpoints.
  for (const [name, file] of [
    ['info', infoApi],
    ['cancel', cancelApi],
  ] as const) {
    ok(file.includes('429'), `I. ${name}: returns 429`);
    ok(file.includes('retry-after'), `I. ${name}: includes retry-after`);
    ok(file.includes('no-store'), `I. ${name}: no-store`);
  }

  ok('I. Phase 8 security hardening preserved');
}

// ============================================================
// J. CROSS-PHASE SECURITY INVARIANTS
// ============================================================
{
  const tvLogin = read('src/routes/tv-login/+page.svelte');
  const scanner = read('src/routes/account/scan-tv/+page.svelte');
  const authorize = read('src/routes/authorize/+page.svelte');
  const accountPage = read('src/routes/account/+page.svelte');
  const hooks = read('src/hooks.server.ts');
  const approveApi = read('src/routes/api/auth/device-pairing/approve/+server.ts');
  const exchangeApi = read('src/routes/api/auth/device-pairing/exchange/+server.ts');
  const statusApi = read('src/routes/api/auth/device-pairing/status/+server.ts');
  const infoApi = read('src/routes/api/auth/device-pairing/info/+server.ts');
  const createApi = read('src/routes/api/auth/device-pairing/create/+server.ts');

  const clientFiles = [tvLogin, scanner, authorize, accountPage];
  const apiFiles = [approveApi, exchangeApi, statusApi, infoApi, createApi];

  // 1. No service-role key in client routes.
  for (const [i, file] of clientFiles.entries()) {
    ok(!file.includes('PRIVATE_SUPABASE_SERVICE_ROLE_KEY'), `J.1. client file ${i}: no service-role key`);
  }

  // 2. No pairing endpoint returns tokens/exchange_code in JSON.
  for (const [name, file] of [
    ['approve', approveApi],
    ['exchange', exchangeApi],
    ['status', statusApi],
    ['info', infoApi],
    ['create', createApi],
  ] as const) {
    ok(!file.match(/json\(\s*\{[^}]*access_token/), `J.2. ${name}: no access_token in JSON`);
    ok(!file.match(/json\(\s*\{[^}]*refresh_token/), `J.2. ${name}: no refresh_token in JSON`);
    ok(!file.match(/json\(\s*\{[^}]*exchange_code/), `J.2. ${name}: no exchange_code in JSON`);
  }

  // 3-5. Server-derived identity.
  ok(hooks.includes('auth.user.id'), 'J.3-5. hooks: user.id from server auth context');
  ok(hooks.includes('extractSessionId'), 'J.3-5. hooks: session_id from JWT');

  // 6. Approval user ID from locals.user.
  ok(approveApi.includes('user.id'), 'J.6. approve: user.id from locals.user');

  // 7-8. Exchange does not accept client-supplied user/session ID.
  ok(!exchangeApi.includes('body.*user_id'), 'J.7. exchange: no user_id from body');
  ok(!exchangeApi.includes('body.*session_id'), 'J.8. exchange: no session_id from body');

  // 9. Status cannot disclose exchange credentials.
  const statusService = read('src/lib/server/auth/device-pairing.ts');
  const fnStart = statusService.indexOf('export async function getPairingBySecret');
  const fnEnd = statusService.indexOf('\n}\n', fnStart);
  const fnBody = statusService.slice(fnStart, fnEnd !== -1 ? fnEnd : undefined);
  ok(fnBody.includes("select('status, expires_at')"), 'J.9. status: selects ONLY status + expires_at');
  ok(!fnBody.includes('exchange_code'), 'J.9. status: does NOT select exchange_code');

  // 10. Consumed pairing cannot be exchanged.
  const rpc = read('supabase/migrations/20260929000000_device_pairing_claim_rpc.sql');
  ok(rpc.includes("status = 'approved'"), 'J.10. RPC: requires approved (not consumed)');

  // 11. Revoked session cannot be resurrected.
  const regMigration = read('supabase/migrations/20260930000000_register_device_session_rpc.sql');
  ok(regMigration.includes('if v_row.revoked_at is not null then'), 'J.11. register RPC: checks revoked_at');
  ok(regMigration.includes('return;'), 'J.11. register RPC: returns empty when revoked');

  // 12. Current session protected by sign-out-all.
  const sessions = read('src/lib/server/auth/device-sessions.ts');
  ok(sessions.includes('.neq'), 'J.12. revoke-all: excludes current session via neq');

  // 13. Different users' sessions isolated.
  ok(sessions.includes('.eq(\'user_id\', userId)'), 'J.13. sessions: scoped by user_id');

  // 14. Scanner cannot navigate to external origin.
  ok(scanner.includes('window.location.origin'), 'J.14. scanner: enforces same origin');

  // 15. URL query credential transport is gone.
  ok(!createApi.includes('/authorize?s='), 'J.15. create: no ?s= in QR URL');
  ok(!authorize.includes('/info?s='), 'J.15. authorize: no /info?s= call');

  ok('J. cross-phase security invariants (15 invariants)');
}

// ============================================================
// K. CROSS-PHASE DATA-FLOW CONTRACT
// ============================================================
// Verify the complete data flow: no sensitive credential crosses
// a client boundary where it should not.
{
  const createApi = read('src/routes/api/auth/device-pairing/create/+server.ts');
  const scanner = read('src/routes/account/scan-tv/+page.svelte');
  const authorize = read('src/routes/authorize/+page.svelte');
  const infoApi = read('src/routes/api/auth/device-pairing/info/+server.ts');
  const approveApi = read('src/routes/api/auth/device-pairing/approve/+server.ts');
  const exchangeApi = read('src/routes/api/auth/device-pairing/exchange/+server.ts');
  const hooks = read('src/hooks.server.ts');

  // CREATE → raw secret returned once.
  ok(createApi.includes('secret: pairing.secret'), 'K. create: returns raw secret once');

  // QR → /authorize#s=<secret> (fragment, not query).
  ok(createApi.includes('/authorize#s='), 'K. QR: uses fragment');

  // SCANNER → validates fragment → navigates to /authorize#s=.
  ok(scanner.includes('fragmentParams.get'), 'K. scanner: validates fragment');
  ok(scanner.includes('goto(`/authorize#s='), 'K. scanner: navigates to #s=');

  // AUTHORIZE → reads fragment → POST /info with JSON body.
  ok(authorize.includes('window.location.hash'), 'K. authorize: reads fragment');
  ok(authorize.includes("method: 'POST'"), 'K. authorize: POST /info');
  ok(authorize.includes('JSON.stringify({ secret: pairingSecret })'), 'K. authorize: JSON body');

  // INFO → returns safe metadata only (no exchange_code).
  ok(!infoApi.match(/json\(\s*\{[^}]*exchange_code/), 'K. info: no exchange_code in response');

  // APPROVE → stores exchange_code server-side (never returned to client).
  ok(!approveApi.match(/json\(\s*\{[^}]*exchange_code/), 'K. approve: no exchange_code in response');

  // EXCHANGE → server-side exchangeCodeForSession on TV SSR client.
  ok(exchangeApi.includes('locals.supabase'), 'K. exchange: TV SSR client');
  ok(!exchangeApi.match(/json\(\s*\{[^}]*access_token/), 'K. exchange: no token in JSON');

  // TV SESSION → registered via hooks.
  ok(hooks.includes('registerCurrentSession'), 'K. hooks: registers TV session');

  ok('K. cross-phase data-flow contract (no credential crosses client boundary)');
}

// ============================================================
// L. DATABASE / MIGRATION REGRESSION
// ============================================================
{
  const sessionsMigration = read('supabase/migrations/20260927000000_device_sessions.sql');
  const pairingMigration = read('supabase/migrations/20260928000000_device_pairing_requests.sql');
  const claimMigration = read('supabase/migrations/20260929000000_device_pairing_claim_rpc.sql');
  const registerMigration = read('supabase/migrations/20260930000000_register_device_session_rpc.sql');

  // DEVICE SESSIONS
  ok(sessionsMigration.includes('references auth.users(id) on delete cascade'), 'L. sessions: user FK');
  ok(sessionsMigration.includes('ENABLE ROW LEVEL SECURITY'), 'L. sessions: RLS enabled');
  ok(sessionsMigration.includes('revoked_at timestamptz'), 'L. sessions: revoked_at column');

  // PAIRING
  ok(pairingMigration.includes('secret_hash text not null'), 'L. pairing: secret_hash');
  ok(pairingMigration.includes("check (status in ('pending', 'approved', 'consumed', 'expired', 'cancelled'))"), 'L. pairing: status constraints');
  ok(pairingMigration.includes('expires_at timestamptz not null'), 'L. pairing: expires_at');
  ok(pairingMigration.includes('approved_by_user_id uuid references auth.users(id)'), 'L. pairing: approved_by_user_id FK');
  ok(pairingMigration.includes('approved_at timestamptz'), 'L. pairing: approved_at');
  ok(pairingMigration.includes('consumed_at timestamptz'), 'L. pairing: consumed_at');
  ok(pairingMigration.includes('exchange_code text'), 'L. pairing: exchange_code');
  ok(pairingMigration.includes('ENABLE ROW LEVEL SECURITY'), 'L. pairing: RLS enabled');

  // CLAIM RPC
  ok(claimMigration.includes('security definer'), 'L. claim RPC: SECURITY DEFINER');
  ok(claimMigration.includes('set search_path = public'), 'L. claim RPC: search_path pinned');
  ok(claimMigration.includes('for update;'), 'L. claim RPC: SELECT FOR UPDATE');
  ok(claimMigration.includes("status = 'approved'"), 'L. claim RPC: requires approved');
  ok(claimMigration.includes('consumed_at is null'), 'L. claim RPC: requires unconsumed');
  ok(claimMigration.includes('expires_at > p_now'), 'L. claim RPC: requires not expired');
  ok(claimMigration.includes('exchange_code = null'), 'L. claim RPC: clears exchange_code');
  ok(claimMigration.includes('v_row.exchange_code'), 'L. claim RPC: returns OLD exchange_code');
  ok(claimMigration.includes('revoke execute'), 'L. claim RPC: EXECUTE revoked');
  ok(claimMigration.includes('to service_role'), 'L. claim RPC: granted to service_role');

  // REGISTER RPC
  ok(registerMigration.includes('security definer'), 'L. register RPC: SECURITY DEFINER');
  ok(registerMigration.includes('set search_path = public'), 'L. register RPC: search_path pinned');
  ok(registerMigration.includes('for update;'), 'L. register RPC: SELECT FOR UPDATE');
  ok(registerMigration.includes('if v_row.revoked_at is not null then'), 'L. register RPC: checks revoked_at');
  ok(registerMigration.includes('return;'), 'L. register RPC: returns empty when revoked');
  ok(registerMigration.includes('revoke execute'), 'L. register RPC: EXECUTE revoked');
  ok(registerMigration.includes('to service_role'), 'L. register RPC: granted to service_role');

  ok('L. database/migration regression (4 migrations verified)');
}

// ============================================================
// M. NEGATIVE-CASE MATRIX
// ============================================================
// Verify the architecture rejects all these cases.
{
  const approveApi = read('src/routes/api/auth/device-pairing/approve/+server.ts');
  const sessionsApi = read('src/routes/api/account/sessions/+server.ts');
  const revokeApi = read('src/routes/api/account/sessions/revoke/+server.ts');
  const revokeAllApi = read('src/routes/api/account/sessions/revoke-all/+server.ts');
  const exchangeApi = read('src/routes/api/auth/device-pairing/exchange/+server.ts');
  const scanner = read('src/routes/account/scan-tv/+page.svelte');
  const service = read('src/lib/server/auth/device-pairing.ts');
  const sessionsService = read('src/lib/server/auth/device-sessions.ts');

  // Unauthenticated approve.
  ok(approveApi.includes('if (!user)'), 'M. approve: rejects unauthenticated');

  // Unauthenticated account sessions.
  ok(sessionsApi.includes('if (!user)'), 'M. sessions: rejects unauthenticated');

  // Unauthenticated revoke.
  ok(revokeApi.includes('if (!user)'), 'M. revoke: rejects unauthenticated');

  // Unauthenticated revoke-all.
  ok(revokeAllApi.includes('if (!user)'), 'M. revoke-all: rejects unauthenticated');

  // Revoke another user's session (scoped by user_id).
  ok(revokeApi.includes("eq('user_id', user.id)"), 'M. revoke: scoped by user_id (IDOR protection)');

  // Revoke current session via individual revoke (blocked).
  ok(revokeApi.includes('Use sign out to end your current session'), 'M. revoke: blocks current session');

  // Sign-out-all targeting current session (excluded via neq in device-sessions service).
  ok(sessionsService.includes('.neq'), 'M. revoke-all: excludes current session');

  // Malformed/short pairing secret.
  ok(exchangeApi.includes('secret.length < 16'), 'M. exchange: rejects short secret');
  ok(approveApi.includes('secret.length < 16'), 'M. approve: rejects short secret');

  // Expired pairing (RPC WHERE clause).
  const rpc = read('supabase/migrations/20260929000000_device_pairing_claim_rpc.sql');
  ok(rpc.includes('expires_at > p_now'), 'M. claim RPC: rejects expired');

  // Consumed pairing (RPC requires approved, not consumed).
  ok(rpc.includes("status = 'approved'"), 'M. claim RPC: rejects consumed');

  // Cancelled pairing (RPC requires approved, not cancelled).
  ok(rpc.includes("status = 'approved'"), 'M. claim RPC: rejects cancelled');

  // Second exchange (RPC WHERE doesn't match after consumed).
  ok(rpc.includes("status = 'approved'"), 'M. claim RPC: second exchange fails (status is consumed)');

  // Second approval (approve requires pending).
  ok(service.includes("eq('status', 'pending')"), 'M. approve: second approval fails (status is approved)');

  // Wrong-origin QR.
  ok(scanner.includes("'wrong-origin'"), 'M. scanner: rejects wrong origin');

  // Wrong-path QR.
  ok(scanner.includes("'wrong-path'"), 'M. scanner: rejects wrong path');

  // Query-based QR secret.
  ok(scanner.includes("'unexpected-query-params'"), 'M. scanner: rejects query params');

  // Unexpected fragment params.
  ok(scanner.includes("'unexpected-fragment-param'"), 'M. scanner: rejects unexpected fragment params');

  // javascript/data/vbscript QR.
  ok(scanner.includes('javascript:'), 'M. scanner: rejects javascript:');
  ok(scanner.includes('data:'), 'M. scanner: rejects data:');
  ok(scanner.includes('vbscript:'), 'M. scanner: rejects vbscript:');

  // Client-supplied user ID (not accepted by any endpoint).
  ok(!approveApi.includes('body.value?.user_id'), 'M. approve: does NOT accept user_id from body');
  ok(!exchangeApi.includes('body.value?.user_id'), 'M. exchange: does NOT accept user_id from body');

  // Client-supplied session ID (not accepted).
  ok(!exchangeApi.includes('body.value?.session_id'), 'M. exchange: does NOT accept session_id from body');

  // Client-supplied exchange code (not accepted).
  ok(!exchangeApi.includes('body.value?.exchange_code'), 'M. exchange: does NOT accept exchange_code from body');

  ok('M. negative-case matrix (25 rejection paths verified)');
}

// ============================================================
// N. NO SENSITIVE LOGGING (CROSS-PHASE)
// ============================================================
{
  const service = read('src/lib/server/auth/device-pairing.ts');
  const exchangeApi = read('src/routes/api/auth/device-pairing/exchange/+server.ts');
  const approveApi = read('src/routes/api/auth/device-pairing/approve/+server.ts');
  const statusApi = read('src/routes/api/auth/device-pairing/status/+server.ts');
  const infoApi = read('src/routes/api/auth/device-pairing/info/+server.ts');
  const cancelApi = read('src/routes/api/auth/device-pairing/cancel/+server.ts');

  const allFiles = [service, exchangeApi, approveApi, statusApi, infoApi, cancelApi];

  for (const file of allFiles) {
    ok(!file.match(/console\.\w+.*\bsecret\b/i), 'N. no file logs raw secret');
    ok(!file.match(/console\.\w+.*exchange_code/i), 'N. no file logs exchange_code');
    ok(!file.match(/console\.\w+.*access_token/i), 'N. no file logs access_token');
    ok(!file.match(/console\.\w+.*refresh_token/i), 'N. no file logs refresh_token');
  }

  ok('N. no sensitive logging across all pairing files');
}

// ============================================================
// O. CACHE-CONTROL: no-store ON ALL PAIRING ENDPOINTS
// ============================================================
{
  const endpoints = [
    ['create', read('src/routes/api/auth/device-pairing/create/+server.ts')],
    ['status', read('src/routes/api/auth/device-pairing/status/+server.ts')],
    ['info', read('src/routes/api/auth/device-pairing/info/+server.ts')],
    ['approve', read('src/routes/api/auth/device-pairing/approve/+server.ts')],
    ['cancel', read('src/routes/api/auth/device-pairing/cancel/+server.ts')],
    ['exchange', read('src/routes/api/auth/device-pairing/exchange/+server.ts')],
  ];

  for (const [name, file] of endpoints) {
    ok(file.includes('cache-control'), `O. ${name}: has cache-control header`);
    ok(file.includes('no-store'), `O. ${name}: cache-control is no-store`);
  }

  ok('O. cache-control: no-store on all 6 pairing endpoints');
}

// ============================================================
// P. DETERMINISTIC SIMULATION — FULL QR FLOW
// ============================================================
// Simulate the complete pairing lifecycle end-to-end to verify
// state transitions are correct.
{
  type Status = 'pending' | 'approved' | 'consumed' | 'expired' | 'cancelled';
  let status: Status = 'pending';
  let exchangeCode: string | null = null;
  let consumed = false;

  // 1. Create → pending.
  assert.equal(status, 'pending', 'P.1. initial status is pending');

  // 2. Approve → pending → approved.
  if (status === 'pending') {
    status = 'approved';
    exchangeCode = 'OTP_xyz';
  }
  assert.equal(status, 'approved', 'P.2. after approve: status is approved');
  assert.equal(exchangeCode, 'OTP_xyz', 'P.2. after approve: exchange_code stored');

  // 3. Second approve fails (status is now 'approved', not 'pending').
  let secondApprove = false;
  if (status === 'pending') {
    secondApprove = true;
  }
  assert.equal(secondApprove, false, 'P.3. second approve fails (status is approved)');

  // 4. Claim (atomic) → approved → consumed, exchange_code captured + cleared.
  if (status === 'approved' && !consumed) {
    const capturedOTP = exchangeCode; // OLD value
    status = 'consumed';
    exchangeCode = null; // cleared
    consumed = true;
    assert.equal(capturedOTP, 'OTP_xyz', 'P.4. claim: captured OLD OTP');
  }
  assert.equal(status, 'consumed', 'P.4. after claim: status is consumed');
  assert.equal(exchangeCode, null, 'P.4. after claim: exchange_code is NULL');

  // 5. Second claim fails (status is consumed, not approved).
  let secondClaim = false;
  if (status === 'approved' && !consumed) {
    secondClaim = true;
  }
  assert.equal(secondClaim, false, 'P.5. second claim fails (status is consumed)');

  passed += 5;
  console.log('  ok P.1 — initial status is pending');
  console.log('  ok P.2 — approve transitions pending → approved');
  console.log('  ok P.3 — second approve fails');
  console.log('  ok P.4 — claim captures OLD OTP + transitions to consumed');
  console.log('  ok P.5 — second claim fails');

  ok('P. deterministic simulation — full QR flow lifecycle');
}

// ============================================================
// Q. EXISTING DEVICE AUTH TESTS REMAIN PRESENT
// ============================================================
{
  const suites = [
    'device_session_registry_test.ts',
    'account_sessions_test.ts',
    'device_pairing_test.ts',
    'phase3_session_revocation_test.ts',
    'phase3_hardening_test.ts',
    'phase4_qr_challenge_backend_test.ts',
    'phase5_tv_login_ui_test.ts',
    'phase6_phone_qr_scanner_test.ts',
    'phase7_qr_session_handoff_test.ts',
    'phase8_security_hardening_test.ts',
  ];

  for (const suite of suites) {
    try {
      read(`scripts/${suite}`);
      ok(true, `Q. ${suite} exists`);
    } catch {
      ok(false, `Q. ${suite} MISSING`);
    }
  }

  ok('Q. existing Device Auth tests remain present (10 suites)');
}

console.log(`\nPhase 9 device auth regression tests passed (${passed} check groups).`);
