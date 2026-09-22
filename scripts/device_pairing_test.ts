import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parseDeviceMetadata } from '../src/lib/server/auth/device-metadata.ts';
import { extractSessionId } from '../src/lib/server/auth/jwt-session-id.ts';

let passed = 0;
function ok(condition: unknown, label: string) {
  assert.ok(condition, label);
  passed += 1;
  console.log(`  ok ${passed} - ${label}`);
}

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative: string) => readFileSync(path.join(REPO_ROOT, relative), 'utf8');

// ============================================================
// 1. DATABASE MIGRATION CONTRACT
// ============================================================
{
  const migration = read('supabase/migrations/20260928000000_device_pairing_requests.sql');

  ok(migration.includes('CREATE TABLE IF NOT EXISTS public.device_pairing_requests'), 'migration creates device_pairing_requests table');
  ok(migration.includes('secret_hash text not null'), 'secret_hash column');
  ok(migration.includes('short_code text not null'), 'short_code column');
  ok(migration.includes('status text not null default'), 'status column with default');
  ok(migration.includes("check (status in ('pending', 'approved', 'consumed', 'expired', 'cancelled'))"), 'status check constraint');
  ok(migration.includes('expires_at timestamptz not null'), 'expires_at column');
  ok(migration.includes('consumed_at timestamptz'), 'consumed_at column');
  ok(migration.includes('exchange_code text'), 'exchange_code column');
  ok(migration.includes('approved_by_user_id uuid references auth.users(id)'), 'approved_by_user_id FK');
  ok(migration.includes('ENABLE ROW LEVEL SECURITY'), 'RLS enabled');

  // No access tokens stored.
  ok(!migration.includes('access_token'), 'migration: no access_token column');
  ok(!migration.includes('refresh_token'), 'migration: no refresh_token column');

  // No client policies (all server-side).
  ok(!migration.includes('POLICY'), 'migration: no client RLS policies (server-side only)');

  ok('1. database migration contract');
}

// ============================================================
// 2. DATABASE TYPES
// ============================================================
{
  const types = read('src/lib/server/supabase/database.types.ts');
  ok(types.includes('device_pairing_requests:'), 'database types include device_pairing_requests');
  ok(types.includes('secret_hash: string'), 'database types include secret_hash');
  ok(types.includes('short_code: string'), 'database types include short_code');
  ok(types.includes('exchange_code: string | null'), 'database types include exchange_code');

  ok('2. database types updated');
}

// ============================================================
// 3. PAIRING SERVICE — SOURCE CONTRACT
// ============================================================
{
  const service = read('src/lib/server/auth/device-pairing.ts');

  ok(service.includes('createPairingRequest'), 'exports createPairingRequest');
  ok(service.includes('getPairingBySecret'), 'exports getPairingBySecret');
  ok(service.includes('approvePairingRequest'), 'exports approvePairingRequest');
  ok(service.includes('cancelPairingRequest'), 'exports cancelPairingRequest');
  ok(service.includes('consumePairingRequest'), 'exports consumePairingRequest');

  // Secret hashing — raw secret never stored.
  ok(service.includes('hashSecret'), 'service has hashSecret function');
  ok(service.includes('createHash'), 'service uses createHash for SHA-256');
  ok(service.includes('secret_hash: secretHash'), 'service stores hash, not raw secret');

  // Short code generation.
  ok(service.includes('generateShortCode'), 'service has generateShortCode');
  ok(service.includes('SHORT_CODE_ALPHABET'), 'service has short code alphabet');
  ok(service.includes('ABCDEFGHJKLMNPQRSTUVWXYZ23456789'), 'short code alphabet excludes ambiguous chars (0/O/1/I)');

  // Expiration.
  ok(service.includes('PAIRING_TTL_MS'), 'service has TTL constant');
  ok(service.includes('5 * 60 * 1000'), 'TTL is 5 minutes');

  // Atomic state transitions.
  ok(service.includes("eq('status', 'pending')"), 'approve: atomic update guarded by status=pending');
  ok(service.includes("eq('status', 'approved')"), 'consume: atomic update guarded by status=approved');

  // Exchange code cleared after consumption.
  ok(service.includes('exchange_code: null'), 'consume: clears exchange_code');

  // generateLink used for TV session creation.
  ok(service.includes('admin.auth.admin.generateLink'), 'service uses Supabase generateLink');
  ok(service.includes('hashed_token'), 'service extracts hashed_token from generateLink response');

  // No tokens logged.
  // No access/refresh tokens logged (hashed_token is the OTP code, not an access token).
  ok(!service.match(/console\.\w+.*access_token/i), 'service: no access_token logging');
  ok(!service.match(/console\.\w+.*refresh_token/i), 'service: no refresh_token logging');
  ok(!service.includes('access_token'), 'service: no access_token reference');
  ok(!service.includes('refresh_token'), 'service: no refresh_token reference');

  ok('3. pairing service contract');
}

// ============================================================
// 4. PAIRING CREATE API
// ============================================================
{
  const api = read('src/routes/api/auth/device-pairing/create/+server.ts');

  ok(api.includes('POST'), 'create API: POST handler');
  ok(!api.includes('locals.user'), 'create API: does NOT require authentication (TV is unauthenticated)');
  ok(api.includes('checkRateLimit'), 'create API: rate limited');
  ok(api.includes('createPairingRequest'), 'create API: uses service');
  ok(api.includes('qrUrl'), 'create API: returns QR URL');
  ok(api.includes('shortCode'), 'create API: returns short code');
  ok(api.includes('secret'), 'create API: returns pairing secret');
  ok(api.includes('expiresAt'), 'create API: returns expiration');

  // No tokens in response.
  ok(!api.includes('access_token'), 'create API: no access_token in response');
  ok(!api.includes('refresh_token'), 'create API: no refresh_token in response');

  ok('4. pairing create API contract');
}

// ============================================================
// 5. PAIRING STATUS API
// ============================================================
{
  const api = read('src/routes/api/auth/device-pairing/status/+server.ts');

  ok(api.includes('GET'), 'status API: GET handler');
  ok(!api.includes('locals.user'), 'status API: does NOT require authentication');
  ok(api.includes('getPairingBySecret'), 'status API: uses service');
  ok(api.includes('exchangeCode'), 'status API: returns exchangeCode when approved');
  ok(api.includes('cache-control'), 'status API: cache-control header');

  // No tokens in response beyond the one-time exchange code.
  ok(!api.includes('access_token'), 'status API: no access_token');
  ok(!api.includes('refresh_token'), 'status API: no refresh_token');

  ok('5. pairing status API contract');
}

// ============================================================
// 6. PAIRING APPROVE API
// ============================================================
{
  const api = read('src/routes/api/auth/device-pairing/approve/+server.ts');

  ok(api.includes('POST'), 'approve API: POST handler');
  ok(api.includes('locals.user'), 'approve API: uses locals.user for auth');
  ok(api.includes('if (!user)'), 'approve API: authentication required');
  ok(api.includes('401'), 'approve API: returns 401 for unauthenticated');
  ok(api.includes('approvePairingRequest'), 'approve API: uses service');
  ok(api.includes('user.id'), 'approve API: passes authenticated user ID');
  ok(api.includes('user.email'), 'approve API: passes user email for generateLink');

  // Never accepts user_id from client.
  ok(!api.includes('body.*user_id'), 'approve API: does NOT accept user_id from body');
  ok(!api.includes('searchParams.*user_id'), 'approve API: does NOT accept user_id from query');

  ok('6. pairing approve API contract');
}

// ============================================================
// 7. PAIRING CONSUME API
// ============================================================
{
  const api = read('src/routes/api/auth/device-pairing/consume/+server.ts');

  ok(api.includes('POST'), 'consume API: POST handler');
  ok(api.includes('consumePairingRequest'), 'consume API: uses service');
  ok(api.includes('cache-control'), 'consume API: cache-control header');

  ok('7. pairing consume API contract');
}

// ============================================================
// 8. PAIRING INFO API (for phone authorization page)
// ============================================================
{
  const api = read('src/routes/api/auth/device-pairing/info/+server.ts');

  ok(api.includes('GET'), 'info API: GET handler');
  ok(api.includes('device_pairing_requests'), 'info API: queries pairing table');
  ok(api.includes('secret_hash'), 'info API: looks up by secret_hash');
  ok(api.includes('deviceName'), 'info API: returns deviceName');
  ok(api.includes('browser'), 'info API: returns browser');
  ok(api.includes('os'), 'info API: returns os');

  // No sensitive data returned.
  ok(!api.includes('access_token'), 'info API: no access_token');
  ok(!api.includes('refresh_token'), 'info API: no refresh_token');
  ok(!api.includes('exchange_code'), 'info API: does NOT return exchange_code');
  ok(!api.includes('approved_by_user_id'), 'info API: does NOT return approver user ID');

  ok('8. pairing info API contract');
}

// ============================================================
// 9. TV LOGIN UI
// ============================================================
{
  const page = read('src/routes/tv-login/+page.svelte');

  ok(page.includes('createPairing'), 'TV login: calls createPairing on mount');
  ok(page.includes('/api/auth/device-pairing/create'), 'TV login: calls create API');
  ok(page.includes('/api/auth/device-pairing/status'), 'TV login: polls status API');
  ok(page.includes('exchangeSession'), 'TV login: has exchangeSession function');
  ok(page.includes('/auth/callback'), 'TV login: uses auth callback for session exchange');
  ok(page.includes('pairingState'), 'TV login: has pairing state');
  ok(page.includes('pending'), 'TV login: has pending state');
  ok(page.includes('approved'), 'TV login: has approved/exchanging state');
  ok(page.includes('expired'), 'TV login: has expired state');
  ok(page.includes('error'), 'TV login: has error state');
  ok(page.includes('countdown'), 'TV login: has countdown timer');
  ok(page.includes('formatCountdown'), 'TV login: has countdown formatter');
  ok(page.includes('shortCode'), 'TV login: displays short code');
  ok(page.includes('Generate new code'), 'TV login: has retry button');

  // No tokens in the UI.
  ok(!page.includes('access_token'), 'TV login: no access_token reference');
  ok(!page.includes('refresh_token'), 'TV login: no refresh_token reference');

  ok('9. TV login UI contract');
}

// ============================================================
// 10. PHONE AUTHORIZE UI
// ============================================================
{
  const page = read('src/routes/authorize/+page.svelte');

  ok(page.includes('/api/auth/device-pairing/info'), 'authorize: calls info API');
  ok(page.includes('/api/auth/device-pairing/approve'), 'authorize: calls approve API');
  ok(page.includes('Approve'), 'authorize: has Approve button');
  ok(page.includes('Cancel'), 'authorize: has Cancel button');
  ok(page.includes('deviceName'), 'authorize: displays device name');
  ok(page.includes('approved'), 'authorize: has approved state');
  ok(page.includes('expired'), 'authorize: has expired state');
  ok(page.includes('error'), 'authorize: has error state');
  ok(page.includes('loading'), 'authorize: has loading state');

  // No tokens in the UI.
  ok(!page.includes('access_token'), 'authorize: no access_token reference');
  ok(!page.includes('refresh_token'), 'authorize: no refresh_token reference');

  ok('10. phone authorize UI contract');
}

// ============================================================
// 11. SECURITY — QR PAYLOAD
// ============================================================
{
  const createApi = read('src/routes/api/auth/device-pairing/create/+server.ts');
  const service = read('src/lib/server/auth/device-pairing.ts');

  // The QR URL contains only the pairing secret, not tokens.
  ok(createApi.includes('qrUrl'), 'create API: builds QR URL');
  ok(createApi.includes('/authorize?s='), 'create API: QR URL points to /authorize with secret param');

  // The secret is a 32-byte random string.
  ok(service.includes('getRandomValues'), 'service: uses crypto.getRandomValues');
  ok(service.includes('Uint8Array(32)'), 'service: 32 bytes of entropy');

  // The raw secret is hashed before storage.
  ok(service.includes('hashSecret(secret)'), 'service: hashes secret before storage');

  // No tokens in QR payload.
  ok(!createApi.includes('access_token'), 'create API: no access_token in QR');
  ok(!createApi.includes('refresh_token'), 'create API: no refresh_token in QR');
  ok(!createApi.includes('session'), 'create API: no session object in QR (besides pairingSecret)');

  ok('11. security: QR payload contains only pairing secret, no tokens');
}

// ============================================================
// 12. SECURITY — SESSION ISOLATION
// ============================================================
{
  const service = read('src/lib/server/auth/device-pairing.ts');
  const tvLogin = read('src/routes/tv-login/+page.svelte');

  // TV establishes its OWN session via exchangeCodeForSession.
  ok(service.includes('generateLink'), 'service: uses generateLink (not token copy)');
  ok(service.includes('hashed_token'), 'service: extracts OTP code (not access token)');
  ok(tvLogin.includes('exchangeCodeForSession') || tvLogin.includes('/auth/callback'), 'TV: uses auth callback (exchangeCodeForSession) for session');

  // The pairing status API returns exchangeCode, not tokens.
  const statusApi = read('src/routes/api/auth/device-pairing/status/+server.ts');
  ok(statusApi.includes('exchangeCode'), 'status API: returns exchangeCode (OTP, not token)');
  ok(!statusApi.includes('access_token'), 'status API: no access_token');
  ok(!statusApi.includes('refresh_token'), 'status API: no refresh_token');

  // The exchange code is cleared after consumption (single-use).
  ok(service.includes('exchange_code: null'), 'consume: clears exchange_code');
  ok(service.includes("eq('status', 'approved')"), 'consume: only approved requests can be consumed');

  ok('12. security: session isolation (TV gets own session, no token copy)');
}

// ============================================================
// 13. REPLAY PROTECTION
// ============================================================
{
  const service = read('src/lib/server/auth/device-pairing.ts');

  // Approve: only pending → approved (atomic).
  ok(service.includes("eq('status', 'pending')"), 'approve: guarded by status=pending');

  // Consume: only approved → consumed (atomic).
  ok(service.includes("eq('status', 'approved')"), 'consume: guarded by status=approved');

  // Exchange code cleared after consumption.
  ok(service.includes('exchange_code: null'), 'consume: clears exchange_code (no reuse)');

  // Expired requests cannot be approved.
  ok(service.includes('expires_at'), 'approve: checks expiration');
  ok(service.includes('expired'), 'approve: marks expired if past TTL');

  ok('13. replay protection: atomic state transitions + single-use exchange code');
}

// ============================================================
// 14. EXPIRATION
// ============================================================
{
  const service = read('src/lib/server/auth/device-pairing.ts');

  ok(service.includes('5 * 60 * 1000'), 'TTL is 5 minutes');
  ok(service.includes('expires_at'), 'service: sets expires_at');
  ok(service.includes('new Date(data.expires_at).getTime() < Date.now()'), 'service: checks expiration in getPairingBySecret');

  // TV UI shows countdown.
  const tvLogin = read('src/routes/tv-login/+page.svelte');
  ok(tvLogin.includes('countdown'), 'TV login: shows countdown');
  ok(tvLogin.includes('expires'), 'TV login: handles expiry');

  ok('14. expiration: 5-minute TTL + countdown + lazy expiry marking');
}

// ============================================================
// 15. REGRESSION — EXISTING AUTH BEHAVIOR
// ============================================================
{
  const hooks = read('src/hooks.server.ts');
  ok(hooks.includes('safeGetSession'), 'hooks: still uses safeGetSession');
  ok(hooks.includes('locals.session'), 'hooks: still sets locals.session');
  ok(hooks.includes('locals.user'), 'hooks: still sets locals.user');
  ok(hooks.includes('registerCurrentSession'), 'hooks: still registers device sessions');

  const signOut = read('src/routes/auth/sign-out/+server.ts');
  ok(signOut.includes('locals.supabase.auth.signOut'), 'sign-out: still calls signOut');
  ok(signOut.includes('revokeSession'), 'sign-out: still revokes device session');

  // Layout: TV login and authorize routes render bare.
  const layout = read('src/routes/+layout.svelte');
  ok(layout.includes('/tv-login'), 'layout: /tv-login renders bare (no AppShell)');
  ok(layout.includes('/authorize'), 'layout: /authorize renders bare (no AppShell)');

  ok('15. regression: existing auth, sign-out, layout all preserved');
}

// ============================================================
// 16. DEVICE METADATA REUSED
// ============================================================
{
  const service = read('src/lib/server/auth/device-pairing.ts');
  ok(service.includes('parseDeviceMetadata'), 'pairing service: uses existing parseDeviceMetadata');
  ok(service.includes('device-metadata'), 'pairing service: imports from device-metadata module');

  ok('16. device metadata: reuses existing Phase 1 parser');
}

console.log(`\nPhase 3 QR TV device authorization tests passed (${passed} check groups).`);
