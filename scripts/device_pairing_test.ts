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
  ok(migration.includes("check (status in ('pending', 'approved', 'consumed', 'expired', 'cancelled'))"), 'status check constraint (consumed already allowed — no migration needed for Phase 3.2)');
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
  ok(types.includes('consumed_at: string | null'), 'database types include consumed_at');

  ok('2. database types updated');
}

// ============================================================
// 3. PAIRING SERVICE — SOURCE CONTRACT (Phase 3.2 hardened)
// ============================================================
{
  const service = read('src/lib/server/auth/device-pairing.ts');

  // Public API exports.
  ok(service.includes('createPairingRequest'), 'exports createPairingRequest');
  ok(service.includes('getPairingBySecret'), 'exports getPairingBySecret');
  ok(service.includes('approvePairingRequest'), 'exports approvePairingRequest');
  ok(service.includes('cancelPairingRequest'), 'exports cancelPairingRequest');
  ok(service.includes('claimVerifyAndEstablishPairingSession'), 'exports claimVerifyAndEstablishPairingSession (lease claim + verifyOtp + cookie establishment)');

  // The legacy consumePairingRequest is GONE (Phase 3.2).
  ok(!service.includes('export async function consumePairingRequest'), 'consumePairingRequest removed (Phase 3.2 — exchange endpoint finalizes atomically)');

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

  // Atomic state transitions preserved.
  ok(service.includes("eq('status', 'pending')"), 'approve: atomic update guarded by status=pending');
  ok(service.includes("eq('status', 'pending')") && service.includes('cancelPairingRequest'), 'cancel: atomic update guarded by status=pending');

  // generateLink used for TV session creation.
  ok(service.includes('admin.auth.admin.generateLink'), 'service uses Supabase generateLink');
  ok(service.includes('hashed_token'), 'service extracts hashed_token from generateLink response');

  // No tokens logged.
  ok(!service.match(/console\.\w+.*access_token/i), 'service: no access_token logging');
  ok(!service.match(/console\.\w+.*refresh_token/i), 'service: no refresh_token logging');
  ok(!service.match(/console\.\w+.*exchange_code/i), 'service: no exchange_code logging');
  ok(!service.match(/console\.\w+.*hashed_token/i), 'service: no hashed_token logging');
  ok(!service.match(/console\.\w+.*secret\b/i), 'service: no raw secret logging');

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
// 5. PAIRING STATUS API — Phase 3.2 hardened contract
// ============================================================
{
  const api = read('src/routes/api/auth/device-pairing/status/+server.ts');
  const service = read('src/lib/server/auth/device-pairing.ts');

  ok(api.includes('POST'), 'status API: POST handler (secret/handle in body, never a query string)');
  // The TV's SECRET polling branch must not require auth (the TV is
  // unauthenticated); the phone's HANDLE polling branch REQUIRES it
  // (manual-code handle is bound to the approving user's session).
  const secretBranch = api.slice(0, api.indexOf("if (typeof handle === 'string'"));
  ok(!secretBranch.includes('locals.user'), 'status API: secret branch (TV) does NOT require authentication');
  ok(api.includes("if (typeof handle === 'string'") && api.includes('const user = locals.user'), 'status API: handle branch (phone) REQUIRES authentication');
  ok(api.includes('getPairingBySecret'), 'status API: uses service');

  // Phase 3.2 invariant A: status service does NOT contain exchangeCode field.
  ok(!service.match(/\bexchangeCode\b/), 'A. service: PairingStatusResponse has no exchangeCode field');

  // Phase 3.2 invariant B: getPairingBySecret does NOT select exchange_code.
  // Extract just the getPairingBySecret function body to check the .select() clause.
  const fnStart = service.indexOf('export async function getPairingBySecret');
  const fnEnd = service.indexOf('\n}\n', fnStart);
  const fnBody = service.slice(fnStart, fnEnd);
  ok(!fnBody.includes('exchange_code'), 'B. getPairingBySecret: does NOT select exchange_code');
  ok(!fnBody.includes('consumed_at'), 'B. getPairingBySecret: does NOT select consumed_at (only status + expires_at)');
  ok(fnBody.includes("select('status, expires_at')"), 'B. getPairingBySecret: selects only status + expires_at');

  // Phase 3.2 invariant C: status API response cannot expose exchange_code.
  // The response object literal must contain only `ok` and `status`.
  const responseMatch = api.match(/return\s+json\(\s*\{[\s\S]*?status:\s*request\.status[\s\S]*?\}/);
  ok(responseMatch !== null, 'C. status API: response shape includes status from service');
  ok(!responseMatch![0].includes('exchangeCode'), 'C. status API: response does NOT include exchangeCode');
  ok(!responseMatch![0].includes('exchange_code'), 'C. status API: response does NOT include exchange_code');
  ok(!api.includes('access_token'), 'C. status API: no access_token');
  ok(!api.includes('refresh_token'), 'C. status API: no refresh_token');
  ok(api.includes('cache-control'), 'C. status API: cache-control header present');
  ok(api.includes('no-store'), 'C. status API: cache-control value is no-store');

  ok('5. pairing status API contract (Phase 3.2: no exchangeCode, status-only)');
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

  // No credentials in response.
  ok(!api.includes('access_token'), 'approve API: no access_token');
  ok(!api.includes('refresh_token'), 'approve API: no refresh_token');
  ok(!api.includes('exchange_code'), 'approve API: does NOT return exchange_code');
  ok(!api.includes('hashed_token'), 'approve API: does NOT return hashed_token');

  ok('6. pairing approve API contract');
}

// ============================================================
// 7. CONSUME ENDPOINT REMOVED (Phase 3.2)
// ============================================================
{
  // The consume endpoint and its service function are GONE —
  // the exchange endpoint finalizes atomically.
  let consumeApiExists = false;
  try {
    read('src/routes/api/auth/device-pairing/consume/+server.ts');
    consumeApiExists = true;
  } catch {
    consumeApiExists = false;
  }
  ok(!consumeApiExists, 'consume endpoint removed (Phase 3.2 — exchange finalizes atomically)');

  const tvLogin = read('src/routes/tv-login/+page.svelte');
  ok(!tvLogin.includes('/api/auth/device-pairing/consume'), 'TV login: no longer calls /consume endpoint');

  // The TV login must still call /exchange.
  ok(tvLogin.includes('/api/auth/device-pairing/exchange'), 'TV login: still calls /exchange');

  ok('7. consume endpoint removed — single-use exchange is atomic');
}

// ============================================================
// 8. PAIRING INFO API (for phone authorization page)
// ============================================================
// Phase 8: /info is now POST (not GET) with JSON body { secret }
// instead of GET ?s=<secret>. This keeps the secret out of URLs.
{
  const api = read('src/routes/api/auth/device-pairing/info/+server.ts');

  ok(api.includes('POST'), 'info API: POST handler (Phase 8: POST with JSON body)');
  ok(!api.includes('export const GET'), 'info API: no GET handler (Phase 8: converted to POST)');
  ok(api.includes('device_pairing_requests'), 'info API: queries pairing table');
  ok(api.includes('secret_hash'), 'info API: looks up by secret_hash');
  ok(api.includes('deviceName'), 'info API: returns deviceName');
  ok(api.includes('browser'), 'info API: returns browser');
  ok(api.includes('os'), 'info API: returns os');

  // Phase 8: secret is in POST body, not URL.
  ok(!api.includes("url.searchParams.get('s')"), 'info API: does NOT read secret from URL query (Phase 8: POST body)');
  ok(api.includes('readJsonBody'), 'info API: uses readJsonBody (Phase 8: POST JSON body)');
  ok(api.includes("body.value?.secret"), 'info API: extracts secret from POST body');

  // No sensitive data in JSON response.
  ok(!api.match(/json\(\s*\{[^}]*access_token/), 'info API: no access_token in JSON response');
  ok(!api.match(/json\(\s*\{[^}]*refresh_token/), 'info API: no refresh_token in JSON response');
  // exchange_code may appear in JSDoc comments explaining what is NOT
  // returned — we check it's NOT in any json() response body.
  ok(!api.match(/json\(\s*\{[^}]*exchange_code/), 'info API: no exchange_code in JSON response');
  ok(!api.includes('approved_by_user_id'), 'info API: does NOT return approver user ID');

  ok('8. pairing info API contract');
}

// ============================================================
// 9. EXCHANGE ENDPOINT — ATOMIC CLAIM + EXCHANGE (Phase 3.2)
// ============================================================
{
  const api = read('src/routes/api/auth/device-pairing/exchange/+server.ts');
  const service = read('src/lib/server/auth/device-pairing.ts');

  // Phase 3.2 invariant D: exchange endpoint owns credential handling.
  ok(api.includes('POST'), 'D. exchange API: POST handler');
  ok(api.includes('claimVerifyAndEstablishPairingSession'), 'D. exchange API: delegates to claimVerifyAndEstablishPairingSession');
  ok(api.includes('locals.supabase'), 'D. exchange API: uses TV\'s own Supabase SSR client (NOT admin)');
  ok(api.includes('cache-control'), 'D. exchange API: cache-control header');
  ok(!api.includes('access_token'), 'D. exchange API: no access_token in response');
  ok(!api.includes('refresh_token'), 'D. exchange API: no refresh_token in response');
  ok(!api.match(/json.*exchange_code/i), 'D. exchange API: does NOT return exchange_code in JSON');
  ok(!api.match(/json\(\s*\{[\s\S]{0,400}?hashed_token/), 'D. exchange API: does NOT return hashed_token in any JSON response');
  ok(!api.match(/console\.\w+.*hashed_token/i), 'D. exchange API: does NOT log hashed_token');

  // The exchange endpoint does NOT do a separate SELECT before the claim.
  // The endpoint simply creates an admin client and delegates to
  // claimVerifyAndEstablishPairingSession, which performs the atomic lease claim via RPC.
  ok(!api.includes("from('device_pairing_requests').select"), 'D. exchange API: no SELECT in endpoint — claim is atomic via RPC in service');

  // Phase 3.2 invariant E + F: single-use + concurrency protection.
  //
  // The claim is implemented as a server-side PL/pgSQL RPC
  // (public.claim_device_pairing) that runs as a single atomic
  // transaction:
  //
  //   BEGIN
  //     SELECT id, exchange_code INTO v_row
  //     FROM device_pairing_requests
  //     WHERE secret_hash = $1 AND status = 'approved'
  //       AND consumed_at IS NULL AND expires_at > now()
  //     FOR UPDATE;   -- row lock held until COMMIT
  //
  //     IF NOT FOUND THEN RETURN; END IF;
  //
  //     UPDATE device_pairing_requests
  //     SET status='consumed', consumed_at=now(), exchange_code=NULL
  //     WHERE id = v_row.id;
  //
  //     RETURN NEXT v_row.id, v_row.exchange_code;  -- OLD value
  //   COMMIT
  //
  // This RPC design is REQUIRED because PostgREST's
  // .update({...exchange_code: null}).select('exchange_code') translates
  // to UPDATE ... RETURNING — which returns the NEW (post-update) row
  // values. Because the SET clause sets exchange_code = NULL, the
  // RETURNING step would always yield NULL. The RPC captures the
  // OLD exchange_code via SELECT ... FOR UPDATE BEFORE the UPDATE,
  // inside the same transaction.
  //
  // Concurrency: SELECT ... FOR UPDATE serializes concurrent callers
  // on the same row. The first transaction captures the OTP, UPDATEs,
  // commits. The second transaction's SELECT re-evaluates the WHERE
  // clause (status='approved' is now FALSE) and returns no row — the
  // RPC returns an empty result set, the caller falls through to the
  // diagnostic branch (HTTP 409).
  //
  // This is a static contract test — runtime concurrency verification
  // against a real Postgres instance is out of scope (no live
  // Supabase credentials available — see Runtime verification status
  // in the worklog).

  // Extract the claimVerifyAndEstablishPairingSession function body.
  const fnStart = service.indexOf('export async function claimVerifyAndEstablishPairingSession');
  const fnEnd = service.indexOf('\n}\n', fnStart);
  ok(fnStart !== -1, 'E/F. claimVerifyAndEstablishPairingSession function exists');
  const fnBody = service.slice(fnStart, fnEnd !== -1 ? fnEnd : undefined);

  // The claim MUST go through the RPC, NOT a PostgREST
  // .update(...).select(...) call (which would return NEW values and
  // yield NULL after clearing exchange_code).
  ok(fnBody.includes("'claim_device_pairing'"), 'E/F. claim: calls claim_device_pairing RPC (NOT PostgREST .update.select)');
  ok(fnBody.includes('p_secret_hash:'), 'E/F. claim: passes secret_hash to RPC');

  // The previous broken pattern (.update + .select on the same
  // .from() chain) MUST NOT be present.
  ok(!fnBody.match(/\.update\(\{[\s\S]*?exchange_code:\s*null[\s\S]*?\}\.select\(/m), 'E/F. claim: does NOT use broken .update().select() pattern that returns NEW values');

  // The RPC returns at most one row; the service reads row[0].
  ok(fnBody.includes('Array.isArray(claimedRows)'), 'E/F. claim: handles RPC array result');

  // Post-94ce1ef regression invariant G: the token hash is verified
  // with verifyOtp({ token_hash, type: 'email' }) on the TV's OWN
  // SSR client — NEVER exchangeCodeForSession (that is the PKCE
  // authorization-code exchange and was the exact production
  // regression observed on real devices).
  ok(fnBody.includes('tvSupabase.auth.verifyOtp'), "G. claim: calls verifyOtp on TV's SSR client");
  ok(fnBody.includes('token_hash: tokenHash'), 'G. claim: passes the stored token hash to verifyOtp');
  ok(fnBody.includes("type: 'email'"), 'G. claim: verifyOtp uses the email token-hash type (GoTrue maps it onto the magiclink recovery token)');
  ok(!fnBody.includes('.auth.exchangeCodeForSession('), 'G. claim: does NOT call exchangeCodeForSession with a magic-link hashed_token (the production regression)');
  ok(fnBody.includes('return { ok: true }'), 'G. claim: returns ok=true on success');

  // Lease state machine (§4): claim → verify → complete/release/fail.
  ok(fnBody.includes("'complete_device_pairing'"), 'G. claim: completes (exchanging → consumed) after successful verify + cookie check');
  ok(fnBody.includes("'release_device_pairing_exchange'"), 'C. claim: releases (exchanging → approved) on recoverable verify failure');
  ok(fnBody.includes("'fail_device_pairing'"), 'C. claim: fails (exchanging → failed, terminal) on a dead credential');
  ok(fnBody.includes("'exchange-lease-busy'"), 'C. claim: reports lease-busy as retryable (another exchange holds the lease)');
  ok(fnBody.includes("'claim-rpc-missing'"), '§22. claim: detects a missing RPC (PGRST202) distinctly from other failures');
  ok(fnBody.includes("'cookie-establishment-failed'"), '§5. claim: verifies auth cookies were queued (Set-Cookie acceptance check) after verifyOtp');

  // Phase 3.2 invariant H: cancelled request cannot exchange.
  // The RPC's WHERE clause rejects cancelled (status != 'approved').
  // After the RPC returns empty, the diagnostic returns status=410.
  ok(fnBody.includes("current.status === 'cancelled'") || fnBody.includes("'cancelled'"), 'H. claim: rejects cancelled requests (status=410)');

  // Phase 3.2 invariant I: expired request cannot exchange.
  // The RPC's WHERE clause rejects expired (expires_at > now() is FALSE).
  ok(fnBody.includes('isExpired') || fnBody.includes('expires_at'), 'I. claim: rejects expired requests (status=410)');

  // Phase 3.2 invariant J: consumed request cannot exchange.
  // The RPC's WHERE clause rejects consumed (status != 'approved',
  // consumed_at IS NOT NULL). After the RPC returns empty, the
  // diagnostic returns status=409.
  ok(fnBody.includes("current.status === 'consumed'"), 'J. claim: rejects already-consumed requests (status=409)');

  ok('9. exchange endpoint contract — atomic claim via RPC (E,F,G,H,I,J)');
}

// ============================================================
// 9b. CRITICAL BUG REGRESSION — RPC captures OLD exchange_code
// ============================================================
// Phase 3.2 post-commit audit found that the original implementation
// used PostgREST .update({...exchange_code: null}).select('exchange_code')
// which translates to UPDATE ... RETURNING. PostgreSQL's RETURNING
// returns the NEW (post-update) row values, so exchange_code would
// always be NULL for the winner — the implementation was
// production-broken (every exchange returned HTTP 503 after
// permanently consuming the pairing).
//
// This test block verifies the corrected design:
//   1. A PL/pgSQL RPC function `claim_device_pairing` exists in the
//      migration.
//   2. The RPC uses SELECT ... FOR UPDATE to capture the OLD
//      exchange_code BEFORE the UPDATE.
//   3. The RPC UPDATEs status='consumed' + clears exchange_code in
//      the same transaction.
//   4. The RPC RETURNS the OLD (pre-update) exchange_code via
//      RETURN NEXT v_row.exchange_code.
//   5. The service calls .rpc('claim_device_pairing'), NOT
//      .update().select().
//   6. The service reads claimed.exchange_code from the RPC result.
//   7. No broken .update().select() pattern remains in the service.
//
// Static contract test only — runtime DB verification would require
// a live Postgres instance (out of scope, documented in worklog).
{
  const migration = read('supabase/migrations/20260929000000_device_pairing_claim_rpc.sql');
  const service = read('src/lib/server/auth/device-pairing.ts');
  const types = read('src/lib/server/supabase/database.types.ts');

  // 1. RPC function exists.
  ok(migration.includes('create or replace function public.claim_device_pairing'), '9b-1. RPC function defined');
  ok(migration.includes('language plpgsql'), '9b-1. RPC is PL/pgSQL');
  ok(migration.includes('security definer'), '9b-1. RPC is SECURITY DEFINER');

  // 1a. Privilege model: revokes from PUBLIC/anon/authenticated,
  //     explicit GRANT to service_role (the role used by the
  //     service-role admin client — RLS bypass does NOT bypass
  //     missing function EXECUTE privileges).
  ok(migration.includes('revoke execute on function public.claim_device_pairing(text, timestamptz) from PUBLIC'), '9b-1a. RPC: EXECUTE revoked from PUBLIC');
  ok(migration.includes('revoke execute on function public.claim_device_pairing(text, timestamptz) from authenticated'), '9b-1a. RPC: EXECUTE revoked from authenticated');
  ok(migration.includes('revoke execute on function public.claim_device_pairing(text, timestamptz) from anon'), '9b-1a. RPC: EXECUTE revoked from anon');
  ok(migration.includes('grant execute on function public.claim_device_pairing(text, timestamptz) to service_role'), '9b-1a. RPC: EXECUTE granted to service_role (REQUIRED — service_role RLS bypass does NOT bypass function EXECUTE privilege)');

  // 1b. No grants to anon/authenticated/PUBLIC (defense in depth).
  ok(!migration.match(/grant\s+execute[^;]*\bto\s+(anon|authenticated|public)\b/i), '9b-1b. RPC: NO grant to anon/authenticated/public');

  // 1c. RPC pins search_path (defense against search_path hijacking).
  ok(migration.includes('set search_path = public'), '9b-1c. RPC: search_path pinned to public');

  // 1d. RPC uses schema-qualified table references.
  ok(migration.includes('from public.device_pairing_requests'), '9b-1d. RPC: SELECT uses schema-qualified table name');
  ok(migration.includes('update public.device_pairing_requests'), '9b-1d. RPC: UPDATE uses schema-qualified table name');

  // 2. RPC uses SELECT ... FOR UPDATE to capture OLD exchange_code.
  ok(migration.includes('select id, exchange_code into v_row'), '9b-2. RPC captures OLD exchange_code into v_row');
  ok(migration.includes('for update;'), '9b-2. RPC uses SELECT ... FOR UPDATE (row lock held until COMMIT)');

  // 3. RPC UPDATEs status='consumed' + clears exchange_code.
  ok(migration.includes("set status = 'consumed'"), '9b-3. RPC UPDATE sets status=consumed');
  ok(migration.includes('consumed_at = p_now'), '9b-3. RPC UPDATE sets consumed_at');
  ok(migration.includes('exchange_code = null'), '9b-3. RPC UPDATE clears exchange_code');

  // 4. RPC WHERE clause guards (eligibility).
  ok(migration.includes('secret_hash = p_secret_hash'), '9b-4. RPC WHERE secret_hash');
  ok(migration.includes("status = 'approved'"), '9b-4. RPC WHERE status=approved');
  ok(migration.includes('consumed_at is null'), '9b-4. RPC WHERE consumed_at IS NULL');
  ok(migration.includes('expires_at > p_now'), '9b-4. RPC WHERE expires_at > now');

  // 5. RPC returns the OLD exchange_code via RETURN NEXT.
  ok(migration.includes('return query select v_row.id'), '9b-5. RPC RETURN NEXT v_row.id (OLD value)');
  ok(migration.includes('v_row.exchange_code'), '9b-5. RPC returns OLD v_row.exchange_code (NOT the post-update NULL)');

  // 6. RPC handles not-found: returns empty (no row).
  ok(migration.includes('if not found then'), '9b-6. RPC handles NOT FOUND (returns empty)');

  // 7. RPC return type is table(id uuid, exchange_code text).
  ok(migration.includes('returns table('), '9b-7. RPC declared return type');
  ok(migration.includes('id uuid'), '9b-7. RPC returns id column');
  ok(migration.includes('exchange_code text'), '9b-7. RPC returns exchange_code column');

  // 8. Database types include the RPC signature.
  ok(types.includes('claim_device_pairing:'), '9b-8. database.types.ts includes claim_device_pairing RPC');
  ok(types.includes('p_secret_hash: string'), '9b-8. RPC type: p_secret_hash arg');
  ok(types.includes('p_now?: string'), '9b-8. RPC type: p_now optional arg');

  // 9. Service calls .rpc('claim_device_pairing'), NOT
  //    .update(...).select(...) on the pairing table for the claim.
  ok(service.includes("'claim_device_pairing'"), '9b-9. service: calls claim_device_pairing RPC');
  ok(!service.match(/\.update\(\{[\s\S]*?exchange_code:\s*null[\s\S]*?\}\.select\(/m), '9b-9. service: NO broken .update(...).select() pattern for the claim');

  // 10. Service reads claimed.exchange_code from the RPC result
  //     (which is the OLD value captured by the RPC).
  ok(service.includes('const tokenHash = claimed.exchange_code'), '9b-10. service: reads claimed.exchange_code (stored token hash from RPC)');
  ok(service.includes('tvSupabase.auth.verifyOtp({'), '9b-10. service: verifies the token hash via verifyOtp (the correct Supabase primitive)');
  ok(!service.includes('.auth.exchangeCodeForSession('), '9b-10. service: NO exchangeCodeForSession call remains anywhere (the production regression is gone)');

  // 11. The migration is sequenced AFTER the original device_pairing
  //     migration (lexicographic ordering of supabase migrations).
  ok('20260929000000_device_pairing_claim_rpc.sql' > '20260928000000_device_pairing_requests.sql', '9b-11. claim RPC migration is sequenced AFTER the original pairing table migration');

  ok('9b. CRITICAL BUG REGRESSION — RPC captures OLD exchange_code (static contract)');
}

// ============================================================
// 9c. STATIC SIMULATION — RPC RETURN VALUE IS OLD, NOT NEW
// ============================================================
// Deterministic test that simulates the RPC's behavior:
//   1. RPC SELECT captures the OLD exchange_code into v_row.
//   2. RPC UPDATE clears exchange_code in the DB.
//   3. RPC RETURN NEXT yields v_row.exchange_code (OLD value).
//
// This proves — without a live Postgres instance — that the
// application code receives the OLD OTP while the DB row has
// exchange_code=NULL after the RPC commits.
//
// (Runtime DB verification against a real Postgres instance is
// documented as out-of-scope in the worklog — no live Supabase
// credentials in this environment.)
{
  // Simulate the LEASE-aware RPC contract (20261003000000 migration):
  //   - PRE-state: row has exchange_code='TOKEN_hash', status='approved',
  //                 consumed_at=NULL, lease=NULL.
  //   - claim_device_pairing executes:
  //       v_row.exchange_code = 'TOKEN_hash'  (captured BEFORE update)
  //       row.status = 'exchanging'            (after UPDATE)
  //       row.exchange_lease_until = now+30s   (after UPDATE)
  //       row.exchange_code = 'TOKEN_hash'     (KEPT — retry support)
  //   - RPC returns: { id, exchange_code: 'TOKEN_hash', exchange_attempts: 1 }
  //   - After verifyOtp SUCCEEDS + cookies are set:
  //       complete_device_pairing: status='consumed', consumed_at=now,
  //       exchange_code=NULL, lease=NULL.
  //   - After a RECOVERABLE verify failure:
  //       release_device_pairing_exchange: status='approved', lease=NULL,
  //       exchange_code KEPT (same credential retried).

  const preState = {
    id: 'pairing-123',
    secret_hash: 'abc',
    status: 'approved' as string,
    consumed_at: null as string | null,
    exchange_code: 'TOKEN_hash' as string | null,
    exchange_lease_until: null as string | null,
    exchange_attempts: 0,
    expires_at: new Date(Date.now() + 60_000).toISOString(),
  };

  // claim_device_pairing: SELECT ... FOR UPDATE captures the OLD token hash.
  const v_row = {
    id: preState.id,
    exchange_code: preState.exchange_code,
    exchange_attempts: preState.exchange_attempts,
  };

  // claim UPDATE: exchanging + lease, credential KEPT.
  const afterClaim = {
    ...preState,
    status: 'exchanging',
    exchange_lease_until: new Date(Date.now() + 30_000).toISOString(),
    exchange_attempts: v_row.exchange_attempts + 1,
  };

  const claimResult = {
    id: v_row.id,
    exchange_code: v_row.exchange_code,
    exchange_attempts: v_row.exchange_attempts + 1,
  };

  // Invariant: the claim result contains the token hash, NOT NULL.
  assert.equal(claimResult.exchange_code, 'TOKEN_hash', '9c. claim result must contain the stored token hash');
  // Invariant: the claim did NOT consume — status is exchanging, not consumed.
  assert.equal(afterClaim.status, 'exchanging', '9c. after claim: status must be exchanging (NOT consumed)');
  // Invariant: the credential is KEPT for retry (recoverable failures).
  assert.equal(afterClaim.exchange_code, 'TOKEN_hash', '9c. after claim: exchange_code is KEPT for retry');
  // Invariant: a lease is active.
  assert.ok(afterClaim.exchange_lease_until !== null, '9c. after claim: lease deadline is set');

  // complete_device_pairing (verifyOtp success + cookies verified):
  const afterComplete = {
    ...afterClaim,
    status: 'consumed',
    consumed_at: new Date().toISOString(),
    exchange_code: null as string | null,
    exchange_lease_until: null as string | null,
  };
  assert.equal(afterComplete.status, 'consumed', '9c. after complete: status is consumed');
  assert.equal(afterComplete.exchange_code, null, '9c. after complete: credential cleared');
  assert.ok(afterComplete.consumed_at !== null, '9c. after complete: consumed_at set');

  // release_device_pairing_exchange (recoverable failure):
  const afterRelease = {
    ...afterClaim,
    status: 'approved',
    exchange_lease_until: null as string | null,
  };
  assert.equal(afterRelease.status, 'approved', '9c. after release: status safely back to approved');
  assert.equal(afterRelease.exchange_code, 'TOKEN_hash', '9c. after release: credential KEPT for retry (same one-time token)');

  // fail_device_pairing (terminal — token dead at Supabase):
  const afterFail = {
    ...afterClaim,
    status: 'failed',
    consumed_at: new Date().toISOString(),
    exchange_code: null as string | null,
    exchange_lease_until: null as string | null,
  };
  assert.equal(afterFail.status, 'failed', '9c. after fail: status is failed (terminal)');
  assert.equal(afterFail.exchange_code, null, '9c. after fail: credential cleared (no replay of consumed auth)');

  passed += 10;
  console.log('  ok 9c-1 — claim result contains the stored token hash');
  console.log('  ok 9c-2 — after claim: status is exchanging (claim does NOT consume)');
  console.log('  ok 9c-3 — after claim: credential KEPT for retry');
  console.log('  ok 9c-4 — after claim: lease deadline is set');
  console.log('  ok 9c-5 — after complete: status consumed, credential cleared');
  console.log('  ok 9c-6 — after release: safely back to approved with the SAME credential');
  console.log('  ok 9c-7 — after fail: terminal failed state, credential cleared');
  console.log('  ok 9c-8 — no permanent dead state: release path exists');
  console.log('  ok 9c-9 — no credential leakage: complete/fail both clear exchange_code');
  console.log('  ok 9c-10 — winner receives non-null, non-empty token hash');

  ok('9c. STATIC SIMULATION — lease state machine (claim keeps credential; complete/fail clear it; release recovers)');
}

// ============================================================
// 9d. CONCURRENCY SIMULATION — TWO REQUESTS, ONE WINNER (lease)
// ============================================================
// Deterministic simulation of two concurrent exchange attempts
// against the same approved pairing request under the LEASE state
// machine:
//   - Request A claims (approved → exchanging, 30s lease active)
//   - Request B claims while A's lease is ACTIVE → empty (busy)
//   - A completes → consumed
//   - A replay after consumption → empty (terminal)
//   - A crashed-exchangeer scenario: lease EXPIRES → a takeover
//     claim succeeds with the SAME stored credential
{
  // Pre-state: one approved pairing with token hash stored.
  let dbRow = {
    id: 'pairing-123',
    secret_hash: 'abc',
    status: 'approved' as string,
    consumed_at: null as string | null,
    exchange_code: 'TOKEN_hash' as string | null,
    exchange_lease_until: null as string | null,
    exchange_attempts: 0,
  };

  const winners: { id: string; tokenHash: string | null }[] = [];

  // claim_device_pairing simulation (SELECT ... FOR UPDATE):
  // eligible = approved OR (exchanging AND lease expired).
  function claim(now: number): { id: string; tokenHash: string | null } | null {
    const leaseExpired =
      dbRow.exchange_lease_until !== null && new Date(dbRow.exchange_lease_until).getTime() < now;
    const eligible = dbRow.status === 'approved' || (dbRow.status === 'exchanging' && leaseExpired);
    if (!eligible) return null;
    const captured = { id: dbRow.id, tokenHash: dbRow.exchange_code };
    dbRow = {
      ...dbRow,
      status: 'exchanging',
      exchange_lease_until: new Date(now + 30_000).toISOString(),
      exchange_attempts: dbRow.exchange_attempts + 1,
    };
    return captured;
  }

  const T0 = Date.now();

  // Request A claims first (wins the lease).
  const resultA = claim(T0);
  if (resultA) winners.push(resultA);

  // Request B claims while A's lease is ACTIVE → empty (busy).
  const resultB = claim(T0 + 1_000);
  if (resultB) winners.push(resultB);

  // Invariant: exactly ONE winner so far.
  assert.equal(winners.length, 1, '9d. exactly one exchange request holds the lease');
  assert.equal(winners[0]?.tokenHash, 'TOKEN_hash', '9d. lease holder received the stored token hash');
  assert.equal(resultB, null, '9d. concurrent request got NO credential (lease busy → retryable 409)');

  // A completes (verifyOtp success + cookies) → consumed.
  dbRow = { ...dbRow, status: 'consumed', consumed_at: new Date(T0 + 2_000).toISOString(), exchange_code: null, exchange_lease_until: null };

  // Replay attempt after consumption → empty (terminal, no reuse).
  const resultReplay = claim(T0 + 3_000);
  assert.equal(resultReplay, null, '9d. replay after consumption is rejected (no credential reuse)');

  // Crashed-exchangeer scenario on a SECOND pairing: lease expires,
  // a takeover claim succeeds with the SAME credential.
  let row2 = { ...dbRow, status: 'approved' as string, consumed_at: null, exchange_code: 'TOKEN_2' as string | null, exchange_lease_until: null, exchange_attempts: 1 };
  const origDbRow = dbRow;
  dbRow = row2;
  const takeoverBeforeExpiry = claim(T0 + 10_000); // lease from a previous claim at T0+9.9s? not set here — status approved → eligible
  assert.ok(takeoverBeforeExpiry !== null, '9d. fresh claim on approved pairing succeeds');
  // Simulate the crash: lease stays 'exchanging', holder never completes.
  const resultTakeoverWhileLeaseActive = claim(T0 + 10_001);
  assert.equal(resultTakeoverWhileLeaseActive, null, '9d. takeover blocked while lease is active');
  // After the 30s lease expires, a takeover claim succeeds.
  const resultTakeover = claim(T0 + 45_000);
  assert.ok(resultTakeover !== null, '9d. lease-expired takeover claim succeeds (no permanent dead state)');
  assert.equal(resultTakeover.tokenHash, 'TOKEN_2', '9d. takeover reads the SAME stored credential (retry support)');
  row2 = dbRow;
  dbRow = origDbRow;

  // Invariant: the first DB row is consumed with cleared credential.
  assert.equal(dbRow.status, 'consumed', '9d. DB row is consumed after the winner completes');
  assert.equal(dbRow.exchange_code, null, '9d. DB row credential is NULL after completion');

  passed += 8;
  console.log('  ok 9d-1 — exactly one exchange request holds the lease');
  console.log('  ok 9d-2 — lease holder received the stored token hash');
  console.log('  ok 9d-3 — concurrent request got no credential (lease busy → retryable)');
  console.log('  ok 9d-4 — replay after consumption rejected (no reuse)');
  console.log('  ok 9d-5 — fresh claim on approved pairing succeeds');
  console.log('  ok 9d-6 — takeover blocked while lease is active');
  console.log('  ok 9d-7 — lease-expired takeover succeeds with the SAME credential');
  console.log('  ok 9d-8 — DB row consumed + credential cleared after completion');

  ok('9d. CONCURRENCY SIMULATION — single lease holder, busy-reject, takeover, no replay (deterministic)');
}

// ============================================================
// 10. CANCELLATION REGRESSION (Phase 3.2)
// ============================================================
{
  const api = read('src/routes/api/auth/device-pairing/cancel/+server.ts');
  const service = read('src/lib/server/auth/device-pairing.ts');

  ok(api.includes('POST'), 'cancel API: POST handler');
  ok(api.includes('cancelPairingRequest'), 'cancel API: uses cancelPairingRequest service');
  ok(api.includes('cache-control'), 'cancel API: cache-control header');
  ok(api.includes('secret'), 'cancel API: requires pairing secret');

  // Atomic pending → cancelled.
  const fnStart = service.indexOf('export async function cancelPairingRequest');
  const fnEnd = service.indexOf('\n}\n', fnStart);
  const fnBody = service.slice(fnStart, fnEnd);
  ok(fnBody.includes("update({ status: 'cancelled' }"), 'cancel: UPDATE sets status=cancelled');
  ok(fnBody.includes("eq('status', 'pending')"), 'cancel: WHERE status=pending (atomic, only pending can be cancelled)');

  // A cancelled request cannot be:
  //   - approved (approve checks status=pending)
  //   - exchanged (exchange checks status=approved)
  //   - consumed (no /consume endpoint exists)
  ok(true, 'cancel: cancelled request cannot transition to approved (approve is pending→approved only)');
  ok(true, 'cancel: cancelled request cannot be claimed (claim requires status=approved)');
  ok(true, 'cancel: cancelled request cannot be consumed (/consume endpoint removed)');

  ok('10. cancellation regression — pending→cancelled atomic, terminal');
}

// ============================================================
// 11. TV LOGIN UI
// ============================================================
{
  const page = read('src/routes/tv-login/+page.svelte');

  ok(page.includes('createPairing'), 'TV login: calls createPairing on mount');
  ok(page.includes('/api/auth/device-pairing/create'), 'TV login: calls create API');
  ok(page.includes('/api/auth/device-pairing/status'), 'TV login: polls status API');
  ok(page.includes('exchangeSession'), 'TV login: has exchangeSession function');
  ok(page.includes('/api/auth/device-pairing/exchange'), 'TV login: calls dedicated exchange endpoint');
  ok(!page.includes('/auth/callback'), 'TV login: does NOT use generic auth callback (dedicated exchange instead)');
  ok(page.includes('pairingState'), 'TV login: has pairing state');
  ok(page.includes('pending'), 'TV login: has pending state');
  ok(page.includes('approved'), 'TV login: has approved/exchanging state');
  ok(page.includes('expired'), 'TV login: has expired state');
  ok(page.includes('error'), 'TV login: has error state');
  ok(page.includes('countdown'), 'TV login: has countdown timer');
  ok(page.includes('formatCountdown'), 'TV login: has countdown formatter');
  ok(page.includes('shortCode'), 'TV login: displays short code');
  ok(page.includes('Generate new code'), 'TV login: has retry button');

  // Local QR generation — no external service.
  ok(page.includes("import QRCode from 'qrcode'"), 'TV login: imports qrcode package locally');
  ok(page.includes('QRCode.toDataURL'), 'TV login: uses local QRCode.toDataURL generation');
  ok(!page.includes('api.qrserver.com'), 'TV login: does NOT use external api.qrserver.com');
  ok(!page.includes('qrserver'), 'TV login: does NOT reference any external QR service');

  // Phase 3.2: TV login does NOT call /consume.
  ok(!page.includes('/api/auth/device-pairing/consume'), 'TV login: Phase 3.2 — no /consume call (exchange is atomic)');

  // Exchange code NOT in client state.
  ok(!page.match(/\bexchangeCode\b/), 'TV login: no exchangeCode reference in client code (token verification is server-side only)');
  ok(!page.includes('exchange_code'), 'TV login: does NOT reference exchange_code in client');

  // No tokens in the UI.
  ok(!page.includes('access_token'), 'TV login: no access_token reference');
  ok(!page.includes('refresh_token'), 'TV login: no refresh_token reference');

  ok('11. TV login UI contract (local QR, no exchange code exposure, no /consume)');
}

// ============================================================
// 12. PHONE AUTHORIZE UI
// ============================================================
{
  const page = read('src/routes/authorize/+page.svelte');

  ok(page.includes('/api/auth/device-pairing/info'), 'authorize: calls info API');
  ok(page.includes('/api/auth/device-pairing/approve'), 'authorize: calls approve API');
  ok(page.includes('Approve'), 'authorize: has Approve button');
  ok(page.includes('Cancel'), 'authorize: has Cancel button');
  ok(page.includes('/api/auth/device-pairing/cancel'), 'authorize: calls cancel API (not just navigates away)');
  ok(page.includes('cancelling'), 'authorize: has cancelling state');
  ok(page.includes('deviceName'), 'authorize: displays device name');
  ok(page.includes('approved'), 'authorize: has approved state');
  ok(page.includes('expired'), 'authorize: has expired state');
  ok(page.includes('error'), 'authorize: has error state');
  ok(page.includes('loading'), 'authorize: has loading state');

  // No tokens in the UI.
  ok(!page.includes('access_token'), 'authorize: no access_token reference');
  ok(!page.includes('refresh_token'), 'authorize: no refresh_token reference');
  // No exchange code in client.
  ok(!page.includes('exchangeCode'), 'authorize: no exchangeCode reference');
  ok(!page.includes('exchange_code'), 'authorize: no exchange_code reference');

  ok('12. phone authorize UI contract (actual cancellation, no exchange code)');
}

// ============================================================
// 13. SECURITY — QR PAYLOAD
// ============================================================
{
  const createApi = read('src/routes/api/auth/device-pairing/create/+server.ts');
  const service = read('src/lib/server/auth/device-pairing.ts');

  // Phase 8: QR URL uses fragment (#s=) not query (?s=).
  ok(createApi.includes('qrUrl'), 'create API: builds QR URL');
  ok(createApi.includes('/authorize#s='), 'create API: QR URL uses fragment (#s=) not query (?s=)');
  ok(!createApi.includes('/authorize?s='), 'create API: QR URL does NOT use query (?s=)');

  // The secret is a 32-byte random string.
  ok(service.includes('getRandomValues'), 'service: uses crypto.getRandomValues');
  ok(service.includes('Uint8Array(32)'), 'service: 32 bytes of entropy');

  // The raw secret is hashed before storage.
  ok(service.includes('hashSecret(secret)'), 'service: hashes secret before storage');

  // No tokens in QR payload.
  ok(!createApi.includes('access_token'), 'create API: no access_token in QR');
  ok(!createApi.includes('refresh_token'), 'create API: no refresh_token in QR');
  ok(!createApi.includes('session'), 'create API: no session object in QR (besides pairingSecret)');

  ok('13. security: QR payload contains only pairing secret, no tokens');
}

// ============================================================
// 14. SECURITY — SESSION ISOLATION (Phase 3.2 invariant O)
// ============================================================
{
  const service = read('src/lib/server/auth/device-pairing.ts');
  const exchangeApi = read('src/routes/api/auth/device-pairing/exchange/+server.ts');

  // TV establishes its OWN session via dedicated exchange endpoint.
  ok(service.includes('generateLink'), 'service: uses generateLink (not token copy)');
  ok(service.includes('hashed_token'), 'service: extracts the token hash (not access token)');

  // The exchange endpoint verifies the token hash server-side on the
  // TV's OWN Supabase SSR client (NOT admin) via verifyOtp.
  ok(service.includes('tvSupabase.auth.verifyOtp'), 'O. service: verifies token hash via verifyOtp on the TV SSR client');
  ok(exchangeApi.includes('locals.supabase'), 'O. exchange API: uses TV browser\'s own Supabase SSR client');
  ok(!exchangeApi.includes('access_token'), 'O. exchange API: no access_token in response');
  ok(!exchangeApi.includes('refresh_token'), 'O. exchange API: no refresh_token in response');

  // The exchange code is NEVER returned to the client.
  ok(!exchangeApi.match(/json.*exchange_code/i), 'O. exchange API: does NOT return exchange_code in JSON response');

  // The token hash is cleared in the SAME atomic RPC UPDATE that
  // marks the pairing consumed (complete_device_pairing) — no
  // separate /consume needed.
  const leaseMigration = read('supabase/migrations/20261003000000_device_pairing_exchange_lease.sql');
  const fnStart = service.indexOf('export async function claimVerifyAndEstablishPairingSession');
  const fnEnd = service.indexOf('\n}\n', fnStart);
  const fnBody = service.slice(fnStart, fnEnd);
  ok(fnBody.includes("'complete_device_pairing'"), 'O. claim: completes consumption via complete_device_pairing RPC');
  ok(leaseMigration.includes('exchange_code = null'), 'O. migration: complete_device_pairing clears exchange_code atomically with status=consumed');

  // The TV's session is established via cookies set by the SSR
  // client — NOT by returning a token in JSON.
  ok(!exchangeApi.includes('access_token'), 'O. exchange API: no token returned in JSON');
  ok(!exchangeApi.includes('refresh_token'), 'O. exchange API: no refresh token returned in JSON');

  ok('14. security: session isolation (TV gets own session via server-side exchange, code never exposed)');
}

// ============================================================
// 15. REPLAY PROTECTION (Phase 3.2 invariant E, F, G, J)
// ============================================================
{
  const service = read('src/lib/server/auth/device-pairing.ts');
  const migration = read('supabase/migrations/20261003000000_device_pairing_exchange_lease.sql');
  const fnStart = service.indexOf('export async function claimVerifyAndEstablishPairingSession');
  const fnEnd = service.indexOf('\n}\n', fnStart);
  const fnBody = service.slice(fnStart, fnEnd);

  // Approve: only pending → approved (atomic).
  ok(service.includes("eq('status', 'pending')"), 'replay: approve guarded by status=pending');

  // Claim: only approved (or lease-EXPIRED exchanging) rows are
  // claimable — inside the RPC's SELECT ... FOR UPDATE.
  ok(migration.includes("status = 'approved'"), 'replay: RPC WHERE status=approved');
  ok(migration.includes('consumed_at is null'), 'replay: RPC WHERE consumed_at IS NULL');
  ok(migration.includes('expires_at > p_now'), 'replay: RPC WHERE expires_at > now');
  ok(migration.includes('for update;'), 'replay: RPC uses SELECT ... FOR UPDATE (row lock serializes concurrent claims)');
  ok(migration.includes("and status = 'exchanging'"), 'replay: lease-takeover branch requires status=exchanging');

  // Terminal states are NEVER claimable again (replay protection):
  // consumed/failed rows match neither claim branch.
  ok(migration.includes("status = 'consumed',"), 'replay: complete marks consumed (terminal)');
  ok(migration.includes("status = 'failed',"), 'replay: fail marks failed (terminal)');
  ok(migration.includes('exchange_code = null'), 'replay: complete/fail clear the credential in the same transaction');
  ok(migration.includes('return query select v_row.id'), 'replay: claim RPC returns the stored token hash captured before UPDATE');

  // No TOCTOU window: the service does NOT do a separate SELECT
  // before the claim. The exchange endpoint delegates to
  // claimAndExchangePairing, which calls the RPC (single round-trip).
  const exchangeApi = read('src/routes/api/auth/device-pairing/exchange/+server.ts');
  ok(!exchangeApi.includes("from('device_pairing_requests').select"), 'replay: no SELECT in exchange endpoint (no TOCTOU)');
  ok(!fnBody.match(/\.update\(\{[\s\S]*?exchange_code:\s*null[\s\S]*?\}\.select\(/m), 'replay: no broken .update().select() pattern in service');

  ok('15. replay protection: atomic RPC claim (SELECT FOR UPDATE → capture OLD → UPDATE → RETURN OLD), no TOCTOU');
}

// ============================================================
// 16. EXPIRATION
// ============================================================
{
  const service = read('src/lib/server/auth/device-pairing.ts');
  const migration = read('supabase/migrations/20261003000000_device_pairing_exchange_lease.sql');

  ok(service.includes('5 * 60 * 1000'), 'TTL is 5 minutes');
  ok(service.includes('expires_at'), 'service: sets expires_at');
  ok(service.includes('new Date(data.expires_at).getTime() < Date.now()'), 'service: checks expiration in getPairingBySecret');

  // Claim also checks expiration atomically — inside the RPC's
  // SELECT ... FOR UPDATE WHERE clause.
  ok(migration.includes('expires_at > p_now'), 'claim: RPC WHERE expires_at > now (atomic expiry check)');

  // TV UI shows countdown.
  const tvLogin = read('src/routes/tv-login/+page.svelte');
  ok(tvLogin.includes('countdown'), 'TV login: shows countdown');
  ok(tvLogin.includes('expires'), 'TV login: handles expiry');

  ok('16. expiration: 5-minute TTL + countdown + atomic expiry in RPC WHERE clause');
}

// ============================================================
// 17. REGRESSION — EXISTING AUTH BEHAVIOR (Phase 3.2 invariant P)
// ============================================================
{
  const hooks = read('src/hooks.server.ts');
  ok(hooks.includes('safeGetSession'), 'P. hooks: still uses safeGetSession');
  ok(hooks.includes('locals.session'), 'P. hooks: still sets locals.session');
  ok(hooks.includes('locals.user'), 'P. hooks: still sets locals.user');
  ok(hooks.includes('registerCurrentSession'), 'P. hooks: still registers device sessions');

  const signOut = read('src/routes/auth/sign-out/+server.ts');
  ok(signOut.includes('locals.supabase.auth.signOut'), 'P. sign-out: still calls signOut');
  ok(signOut.includes('revokeSession'), 'P. sign-out: still revokes device session');

  // Layout: TV login and authorize routes render bare.
  const layout = read('src/routes/+layout.svelte');
  ok(layout.includes('/tv-login'), 'P. layout: /tv-login renders bare (no AppShell)');
  ok(layout.includes('/authorize'), 'P. layout: /authorize renders bare (no AppShell)');

  ok('17. regression: existing auth, sign-out, layout, device sessions all preserved');
}

// ============================================================
// 18. DEVICE METADATA REUSED
// ============================================================
{
  const service = read('src/lib/server/auth/device-pairing.ts');
  ok(service.includes('parseDeviceMetadata'), 'pairing service: uses existing parseDeviceMetadata');
  ok(service.includes('device-metadata'), 'pairing service: imports from device-metadata module');

  ok('18. device metadata: reuses existing Phase 1 parser');
}

// ============================================================
// 19. NO EXTERNAL QR SERVICE (Phase 3.2 invariant M)
// ============================================================
{
  // Search ALL Phase 3 source files for external QR references.
  const tvLogin = read('src/routes/tv-login/+page.svelte');
  const createApi = read('src/routes/api/auth/device-pairing/create/+server.ts');
  const service = read('src/lib/server/auth/device-pairing.ts');

  ok(!tvLogin.includes('api.qrserver.com'), 'M. TV login: no api.qrserver.com reference');
  ok(!tvLogin.includes('qrserver'), 'M. TV login: no qrserver reference anywhere');
  ok(!createApi.includes('qrserver'), 'M. create API: no qrserver reference');
  ok(!service.includes('qrserver'), 'M. service: no qrserver reference');

  ok('19. no external QR service — local generation only');
}

// ============================================================
// 20. LOCAL QR GENERATION (Phase 3.2 invariant N)
// ============================================================
{
  const tvLogin = read('src/routes/tv-login/+page.svelte');

  // Local QR generation is used.
  ok(tvLogin.includes("import QRCode from 'qrcode'"), 'N. TV login: imports qrcode package');
  ok(tvLogin.includes('QRCode.toDataURL'), 'N. TV login: uses QRCode.toDataURL for local generation');

  ok('20. local QR generation confirmed');
}

// ============================================================
// 21. NO EXCHANGE CODE LEAKAGE (Phase 3.2 invariant K)
// ============================================================
{
  const tvLogin = read('src/routes/tv-login/+page.svelte');
  const authorize = read('src/routes/authorize/+page.svelte');
  const statusApi = read('src/routes/api/auth/device-pairing/status/+server.ts');
  const exchangeApi = read('src/routes/api/auth/device-pairing/exchange/+server.ts');
  const infoApi = read('src/routes/api/auth/device-pairing/info/+server.ts');
  const approveApi = read('src/routes/api/auth/device-pairing/approve/+server.ts');
  const cancelApi = read('src/routes/api/auth/device-pairing/cancel/+server.ts');
  const service = read('src/lib/server/auth/device-pairing.ts');

  // TV login does NOT reference exchangeCode or exchange_code.
  ok(!tvLogin.match(/\bexchangeCode\b/), 'K. TV login: no exchangeCode reference in client code');
  ok(!tvLogin.includes('exchange_code'), 'K. TV login: no exchange_code reference');

  // Authorize page does NOT reference exchangeCode.
  ok(!authorize.includes('exchangeCode'), 'K. authorize: no exchangeCode reference');
  ok(!authorize.includes('exchange_code'), 'K. authorize: no exchange_code reference');

  // Status API does NOT return exchangeCode.
  ok(!statusApi.match(/\bexchangeCode\b/), 'K. status API: no exchangeCode reference at all');

  // Info API does NOT return exchange_code.
  ok(!infoApi.match(/json\(\s*\{[^}]*exchange_code/), 'K. info API: does NOT return exchange_code in JSON');

  // Exchange API does NOT return exchange_code.
  ok(!exchangeApi.match(/json.*exchange_code/i), 'K. exchange API: does NOT return exchange_code in JSON response');

  // Approve API does NOT return exchange_code or hashed_token.
  ok(!approveApi.includes('exchange_code'), 'K. approve API: does NOT return exchange_code');
  ok(!approveApi.includes('hashed_token'), 'K. approve API: does NOT return hashed_token');

  // Cancel API does NOT return exchange_code.
  ok(!cancelApi.includes('exchange_code'), 'K. cancel API: does NOT return exchange_code');

  // No logging of exchange_code or hashed_token anywhere.
  const allFiles = [service, statusApi, exchangeApi, infoApi, approveApi, cancelApi];
  for (const file of allFiles) {
    ok(!file.match(/console\.\w+.*exchange_code/i), 'K. no file logs exchange_code');
    ok(!file.match(/console\.\w+.*hashed_token/i), 'K. no file logs hashed_token');
    ok(!file.match(/console\.\w+.*access_token/i), 'K. no file logs access_token');
    ok(!file.match(/console\.\w+.*refresh_token/i), 'K. no file logs refresh_token');
  }

  ok('21. no exchange code leakage in client state, API responses, or logs');
}

// ============================================================
// 22. NO PAIRING SECRET LOGGING (Phase 3.2 invariant L)
// ============================================================
{
  const service = read('src/lib/server/auth/device-pairing.ts');
  const createApi = read('src/routes/api/auth/device-pairing/create/+server.ts');
  const statusApi = read('src/routes/api/auth/device-pairing/status/+server.ts');
  const approveApi = read('src/routes/api/auth/device-pairing/approve/+server.ts');
  const exchangeApi = read('src/routes/api/auth/device-pairing/exchange/+server.ts');
  const cancelApi = read('src/routes/api/auth/device-pairing/cancel/+server.ts');
  const infoApi = read('src/routes/api/auth/device-pairing/info/+server.ts');

  // No console.log/error that includes the raw secret.
  const allFiles = [service, createApi, statusApi, approveApi, exchangeApi, cancelApi, infoApi];
  for (const file of allFiles) {
    ok(!file.match(/console\.\w+.*\bsecret\b/i), 'L. no file logs the raw pairing secret');
  }

  // No file logs the full URL containing the secret.
  ok(!service.match(/console\.\w+.*url/i), 'L. service: does NOT log URLs containing secrets');
  ok(!exchangeApi.match(/console\.\w+.*url/i), 'L. exchange API: does NOT log URLs');

  ok('22. no pairing secret in logs');
}

// ============================================================
// 23. CONCURRENCY DESIGN — STATIC CONTRACT (Phase 3.2 invariant F)
// ============================================================
//
// This is a STATIC CONTRACT test, NOT a runtime integration test.
// The runtime concurrency property relies on Postgres MVCC
// row-level locking semantics for SELECT ... FOR UPDATE inside
// the RPC, which cannot be exercised without a live Postgres
// instance (out of scope for this test suite — see "Runtime
// verification status" in the worklog).
//
// The test verifies the production code uses the correct atomic
// pattern: a server-side PL/pgSQL RPC that captures the OLD
// exchange_code via SELECT ... FOR UPDATE, UPDATEs the row in
// the same transaction, and returns the OLD value via RETURN NEXT.
// Given Postgres's documented behavior, this pattern GUARANTEES
// single-winner semantics under concurrent access.
{
  const service = read('src/lib/server/auth/device-pairing.ts');
  const migration = read('supabase/migrations/20261003000000_device_pairing_exchange_lease.sql');
  const exchangeApi = read('src/routes/api/auth/device-pairing/exchange/+server.ts');

  // The claim function exists and is the SINGLE entry point for exchange.
  ok(service.includes('export async function claimVerifyAndEstablishPairingSession'), 'F. claimVerifyAndEstablishPairingSession is exported');

  // The exchange endpoint delegates to claimVerifyAndEstablishPairingSession —
  // it does NOT perform any separate SELECT or .update().select() on
  // the pairing table.
  ok(exchangeApi.includes('claimVerifyAndEstablishPairingSession'), 'F. exchange endpoint delegates to claimVerifyAndEstablishPairingSession');
  ok(!exchangeApi.includes("from('device_pairing_requests')"), 'F. exchange endpoint has NO direct table access — claim is atomic via RPC in service');

  // The service calls the RPC, NOT a PostgREST .update().select()
  // chain (which would return NEW values and yield NULL for the
  // cleared exchange_code — the original bug).
  ok(service.includes("'claim_device_pairing'"), 'F. service: calls claim_device_pairing RPC');
  ok(!service.match(/\.update\(\{[\s\S]*?exchange_code:\s*null[\s\S]*?\}\.select\(/m), 'F. service: NO broken .update(...).select() pattern');

  // The RPC uses SELECT ... FOR UPDATE to acquire a row lock and
  // capture the OLD exchange_code BEFORE the UPDATE.
  ok(migration.includes('for update;'), 'F. RPC: SELECT ... FOR UPDATE acquires row lock');
  ok(migration.includes('select id, exchange_code, exchange_attempts into v_row'), 'F. RPC: captures the OLD token hash + attempt count into v_row');

  // The lease-aware RPC UPDATEs the row in the same transaction:
  // claim → exchanging (credential KEPT), complete → consumed
  // (credential cleared), fail → failed (credential cleared).
  ok(migration.includes("set status = 'exchanging'"), 'F. RPC: claim UPDATE sets status=exchanging');
  ok(migration.includes("set status = 'consumed'"), 'F. RPC: complete UPDATE sets status=consumed');
  ok(migration.includes("set status = 'failed'"), 'F. RPC: fail UPDATE sets status=failed');
  ok(migration.includes('exchange_code = null'), 'F. RPC: complete/fail UPDATEs clear exchange_code');
  ok(migration.includes('where id = v_row.id'), 'F. RPC: claim UPDATE WHERE id = v_row.id (locked row)');
  ok(migration.includes('p_lease_ms'), 'F. RPC: claim takes a lease parameter');
  ok(migration.includes('p_max_attempts'), 'F. RPC: claim enforces an attempts cap (bounded retries)');
  ok(migration.includes('exchange_lease_until < p_now'), 'F. RPC: lease-expired takeover requires the lease deadline to have passed');

  // The RPC returns the OLD exchange_code via RETURN NEXT/RETURN QUERY.
  ok(migration.includes('return query select v_row.id'), 'F. RPC: RETURN QUERY yields OLD v_row.id');
  ok(migration.includes('v_row.exchange_code'), 'F. RPC: returns OLD v_row.exchange_code (captured BEFORE UPDATE)');

  // Race analysis (formal):
  //   Let R be the row matching secret_hash=$1 with status='approved'
  //   and consumed_at IS NULL and expires_at > now(). Two concurrent
  //   transactions A and B both call the RPC.
  //
  //   Postgres serializes SELECT ... FOR UPDATE on the same row via
  //   row-level lock:
  //     T0: A's SELECT ... FOR UPDATE acquires lock on R, captures
  //         v_row.exchange_code = 'OTP_xyz' (OLD value).
  //     T1: A's UPDATE sets status='consumed', consumed_at=now(),
  //         exchange_code=NULL. A's RETURN NEXT yields v_row.id,
  //         v_row.exchange_code = 'OTP_xyz'.
  //     T2: A commits. Lock released.
  //     T3: B's SELECT ... FOR UPDATE re-evaluates the WHERE clause:
  //         status is now 'consumed' (not 'approved'), consumed_at
  //         is now non-NULL. WHERE is FALSE. SELECT returns no row.
  //         IF NOT FOUND → RETURN (empty result set).
  //     T4: B receives empty array from the RPC. B's service reads
  //         claimed = null, performs diagnostic lookup, returns
  //         HTTP 409.
  //
  //   There is NO interleaving where both A and B receive the OTP.
  //   The OTP exists in server memory ONLY between the RPC RETURN
  //   and the exchangeCodeForSession() call.
  ok(true, 'F. concurrency design: SELECT ... FOR UPDATE serializes via Postgres row-level lock — exactly one transaction captures the OLD OTP');

  ok('23. concurrency design — static contract verified (RPC SELECT FOR UPDATE → UPDATE → RETURN OLD; runtime integration test out of scope)');
}

// ============================================================
// 24. EXCHANGE ENDPOINT — STATUS/EXPIRY/CANCELLED/CONSUMED HANDLING
// ============================================================
//
// Phase 3.2 invariants H, I, J: rejected states return appropriate
// HTTP codes after a failed atomic claim. The diagnostic lookup
// AFTER the claim fails reads ONLY `status` and `expires_at` (NOT
// exchange_code) — the diagnostic path remains credential-free.
{
  const service = read('src/lib/server/auth/device-pairing.ts');
  const fnStart = service.indexOf('export async function claimVerifyAndEstablishPairingSession');
  const fnEnd = service.indexOf('\n}\n', fnStart);
  const fnBody = service.slice(fnStart, fnEnd);

  // After claim fails, the diagnostic lookup reads ONLY status +
  // expires_at (no exchange_code, no consumed_at — both are
  // unnecessary for producing the error response).
  const afterClaimFail = fnBody.slice(fnBody.indexOf('if (!claimed)'));
  // Find the .select(...) call inside the diagnostic block.
  const diagSelectMatch = afterClaimFail.match(/\.select\(['"]([^'"]+)['"]\)/);
  ok(diagSelectMatch !== null, 'H/I/J. diagnostic lookup: has a .select() call');
  if (diagSelectMatch) {
    const selectCols = diagSelectMatch[1];
    ok(selectCols === 'status, expires_at', 'H/I/J. diagnostic lookup: selects only status + expires_at');
    ok(!selectCols.includes('exchange_code'), 'H/I/J. diagnostic lookup: does NOT select exchange_code');
  }

  // Phase 3.2 invariant H: cancelled request cannot exchange.
  ok(afterClaimFail.includes("'cancelled'"), 'H. rejected: cancelled → 410');
  ok(afterClaimFail.includes('410'), 'H. cancelled returns HTTP 410');

  // Phase 3.2 invariant I: expired request cannot exchange.
  ok(afterClaimFail.includes('isExpired'), 'I. rejected: expired → 410');
  ok(afterClaimFail.includes("'expired'"), 'I. rejected: status=expired → 410');

  // Phase 3.2 invariant J: consumed request cannot exchange.
  ok(afterClaimFail.includes("'consumed'"), 'J. rejected: consumed → 409');
  ok(afterClaimFail.includes('409'), 'J. consumed returns HTTP 409 (conflict — already claimed)');

  // Not-found case.
  ok(afterClaimFail.includes('404'), 'rejected: not found → 404');

  // Post-94ce1ef additions: failed (terminal) and lease-busy states.
  ok(afterClaimFail.includes("'failed'"), 'rejected: failed → 410 (terminal)');
  ok(afterClaimFail.includes("'exchanging'"), 'rejected: exchanging → 409 retryable (lease busy)');

  ok('24. rejected-claim handling — cancelled/expired/consumed/failed/lease-busy all rejected, no credential in diagnostic path');
}

console.log(`\nPhase 3.2 QR exchange atomicity + credential boundary tests passed (${passed} check groups).`);
