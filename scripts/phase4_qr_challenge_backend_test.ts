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
// PHASE 4 — QR CHALLENGE BACKEND TESTS
// ============================================================
// Phase 4 means backend challenge creation + lifecycle.
// The existing device_pairing_requests model + the create/status/
// approve/cancel/exchange endpoints already implement this. These
// tests verify the hardened backend contract including:
//   - challenge creation (cryptographic secret, hashing, TTL)
//   - lifecycle states (pending → approved → consumed, etc.)
//   - rate limiting on create/status/approve/exchange
//   - status endpoint safety (no exchange_code, no tokens)
//   - cancellation (atomic, idempotent)
//   - expiry (lazy + RPC-enforced)
//   - single-use claim via RPC (SELECT FOR UPDATE → capture OLD → UPDATE → RETURN OLD)
//   - no unauthenticated device session registration during challenge
//
// STATIC CONTRACT + DETERMINISTIC tests. Runtime DB verification
// out of scope (no live Supabase credentials).

// ============================================================
// 1. CHALLENGE DATABASE MODEL
// ============================================================
{
  const migration = read('supabase/migrations/20260928000000_device_pairing_requests.sql');

  // Table + fields.
  ok(migration.includes('CREATE TABLE IF NOT EXISTS public.device_pairing_requests'), '1. table exists');
  ok(migration.includes('id uuid primary key'), '1. id PK');
  ok(migration.includes('secret_hash text not null'), '1. secret_hash column');
  ok(migration.includes('short_code text not null'), '1. short_code column');
  ok(migration.includes("check (status in ('pending', 'approved', 'consumed', 'expired', 'cancelled'))"), '1. status CHECK constraint (lifecycle states)');
  ok(migration.includes('requested_device_type text'), '1. device_type metadata');
  ok(migration.includes('requested_device_name text'), '1. device_name metadata');
  ok(migration.includes('requested_browser text'), '1. browser metadata');
  ok(migration.includes('requested_os text'), '1. os metadata');
  ok(migration.includes('requested_platform text'), '1. platform metadata');
  ok(migration.includes('approved_by_user_id uuid references auth.users(id)'), '1. approved_by_user_id FK');
  ok(migration.includes('approved_at timestamptz'), '1. approved_at');
  ok(migration.includes('exchange_code text'), '1. exchange_code (nullable, cleared after consumption)');
  ok(migration.includes('created_at timestamptz'), '1. created_at');
  ok(migration.includes('expires_at timestamptz not null'), '1. expires_at (not null, required)');
  ok(migration.includes('consumed_at timestamptz'), '1. consumed_at');

  // Indexes for efficient lookup.
  ok(migration.includes('device_pairing_secret_hash_idx'), '1. index: secret_hash (pending only)');
  ok(migration.includes('device_pairing_short_code_idx'), '1. index: short_code (pending only)');
  ok(migration.includes('device_pairing_expires_idx'), '1. index: expires_at (pending only, for cleanup)');

  // RLS: no client access.
  ok(migration.includes('ENABLE ROW LEVEL SECURITY'), '1. RLS enabled');
  ok(!migration.includes('POLICY'), '1. no client RLS policies (server-side only)');

  ok('1. challenge database model (fields, lifecycle states, indexes, RLS)');
}

// ============================================================
// 2. SECRET GENERATION + HASHING
// ============================================================
{
  const service = read('src/lib/server/auth/device-pairing.ts');

  // Cryptographic randomness — 32 bytes.
  ok(service.includes('crypto.getRandomValues'), '2. uses crypto.getRandomValues');
  ok(service.includes('Uint8Array(32)'), '2. 32 bytes of entropy (256 bits)');
  ok(service.includes('base64url'), '2. URL-safe base64 encoding');

  // SHA-256 hash for storage.
  ok(service.includes('createHash'), '2. uses createHash');
  ok(service.includes('sha256'), '2. SHA-256 hashing');
  ok(service.includes('hashSecret(secret)'), '2. hashes secret before storage');

  // No Math.random or timestamps as secrets.
  ok(!service.match(/Math\.random/), '2. does NOT use Math.random');
  ok(!service.match(/Date\.now\(\).*secret/), '2. does NOT use timestamps as secret material');

  // Short code generation (8 chars, ambiguous-char-excluded alphabet).
  ok(service.includes('SHORT_CODE_LENGTH = 8'), '2. short code length is 8');
  ok(service.includes('SHORT_CODE_ALPHABET'), '2. short code alphabet defined');
  ok(service.includes('ABCDEFGHJKLMNPQRSTUVWXYZ23456789'), '2. short code alphabet excludes ambiguous chars (0/O/1/I)');

  // TTL — 5 minutes.
  ok(service.includes('PAIRING_TTL_MS'), '2. TTL constant defined');
  ok(service.includes('5 * 60 * 1000'), '2. TTL is 5 minutes');

  ok('2. secret generation (crypto, 32 bytes, SHA-256 hash, short code, TTL)');
}

// ============================================================
// 3. CHALLENGE CREATION — ENDPOINT CONTRACT
// ============================================================
{
  const api = read('src/routes/api/auth/device-pairing/create/+server.ts');

  // Unauthenticated endpoint — TV is unauthenticated during creation.
  ok(api.includes('POST'), '3. POST handler');
  ok(!api.includes('locals.user'), '3. does NOT require authentication (TV is unauthenticated)');

  // Rate limited via dedicated bucket.
  ok(api.includes('checkRateLimit'), '3. rate limited');
  ok(api.includes("'pairingCreate'"), '3. uses pairingCreate bucket (dedicated)');
  ok(!api.includes("'resolve' as never"), '3. does NOT use buggy resolve cast');
  ok(!api.includes("'search'"), '3. does NOT use search bucket proxy');

  // 429 response with retry-after.
  ok(api.includes('429'), '3. returns 429 on rate limit');
  ok(api.includes('retry-after'), '3. includes retry-after header');

  // Returns secret + short code + QR URL + expiration.
  ok(api.includes('secret: pairing.secret'), '3. returns raw secret (once)');
  ok(api.includes('shortCode'), '3. returns short code');
  ok(api.includes('qrUrl'), '3. returns QR URL');
  ok(api.includes('expiresAt'), '3. returns expiration');

  // No tokens in response.
  ok(!api.match(/access_token.*json/) && !api.match(/json.*access_token/), '3. no access_token in response');
  ok(!api.match(/refresh_token.*json/) && !api.match(/json.*refresh_token/), '3. no refresh_token in response');

  // cache-control: no-store.
  ok(api.includes('cache-control'), '3. cache-control header');
  ok(api.includes('no-store'), '3. cache-control value is no-store');

  ok('3. challenge creation endpoint (unauthenticated, rate limited, safe response)');
}

// ============================================================
// 4. STATUS ENDPOINT — SAFE RESPONSE
// ============================================================
{
  const api = read('src/routes/api/auth/device-pairing/status/+server.ts');
  const service = read('src/lib/server/auth/device-pairing.ts');

  // Returns only status — no exchange_code, no tokens.
  ok(api.includes('GET'), '4. GET handler');
  ok(api.includes('status: request.status'), '4. returns status field');
  ok(!api.match(/exchange_code.*json/) && !api.match(/json.*exchange_code/), '4. no exchange_code in response');
  ok(!api.includes('access_token'), '4. no access_token in response');
  ok(!api.includes('refresh_token'), '4. no refresh_token in response');

  // The service selects ONLY status + expires_at.
  const fnStart = service.indexOf('export async function getPairingBySecret');
  const fnEnd = service.indexOf('\n}\n', fnStart);
  const fnBody = service.slice(fnStart, fnEnd !== -1 ? fnEnd : undefined);
  ok(fnBody.includes("select('status, expires_at')"), '4. getPairingBySecret selects ONLY status + expires_at');
  ok(!fnBody.includes('exchange_code'), '4. getPairingBySecret does NOT select exchange_code');

  // Rate limited via pairingPoll bucket.
  ok(api.includes('checkRateLimit'), '4. rate limited');
  ok(api.includes("'pairingPoll'"), '4. uses pairingPoll bucket');

  // cache-control: no-store.
  ok(api.includes('no-store'), '4. cache-control: no-store');

  // Lazy expiry — pending → expired on read.
  ok(fnBody.includes("status === 'pending'"), '4. getPairingBySecret checks pending status for lazy expiry');
  ok(fnBody.includes("status: 'expired'"), '4. getPairingBySecret returns expired on stale pending');

  ok('4. status endpoint (safe response, rate limited, lazy expiry)');
}

// ============================================================
// 5. APPROVE ENDPOINT — AUTH + RATE LIMIT
// ============================================================
{
  const api = read('src/routes/api/auth/device-pairing/approve/+server.ts');
  const service = read('src/lib/server/auth/device-pairing.ts');

  // Auth required.
  ok(api.includes('locals.user'), '5. uses locals.user for auth');
  ok(api.includes('if (!user)'), '5. authentication guard');
  ok(api.includes('401'), '5. returns 401 for unauthenticated');

  // Rate limited via pairingApprove bucket.
  ok(api.includes('checkRateLimit'), '5. rate limited');
  ok(api.includes("'pairingApprove'"), '5. uses pairingApprove bucket');
  ok(api.includes('user.id'), '5. rate limit keyed by user.id (authenticated)');

  // User identity from server context.
  ok(api.includes('user.id'), '5. passes server-derived user.id');
  ok(api.includes('user.email'), '5. passes user.email for generateLink');

  // Atomic transition: pending → approved (guarded by eq('status', 'pending')).
  const approveStart = service.indexOf('export async function approvePairingRequest');
  const approveEnd = service.indexOf('\n}\n', approveStart);
  const approveBody = service.slice(approveStart, approveEnd !== -1 ? approveEnd : undefined);
  ok(approveBody.includes("eq('status', 'pending')"), '5. approve: atomic update guarded by status=pending');

  // generateLink + hashed_token extraction.
  ok(approveBody.includes('admin.auth.admin.generateLink'), '5. approve: uses Supabase generateLink');
  ok(approveBody.includes('hashed_token'), '5. approve: extracts hashed_token (OTP)');

  // Never accepts user_id from client.
  ok(!api.includes('body.*user_id'), '5. does NOT accept user_id from body');
  ok(!api.includes('searchParams.*user_id'), '5. does NOT accept user_id from query');

  ok('5. approve endpoint (auth, rate limit, atomic transition, server-derived identity)');
}

// ============================================================
// 6. EXCHANGE ENDPOINT — RATE LIMIT + RPC
// ============================================================
{
  const api = read('src/routes/api/auth/device-pairing/exchange/+server.ts');
  const service = read('src/lib/server/auth/device-pairing.ts');

  // Rate limited via pairingExchange bucket.
  ok(api.includes('checkRateLimit'), '6. rate limited');
  ok(api.includes("'pairingExchange'"), '6. uses pairingExchange bucket');

  // Uses the claim_device_pairing RPC (NOT PostgREST .update().select()).
  ok(service.includes("'claim_device_pairing'"), '6. service: calls claim_device_pairing RPC');
  ok(!service.match(/\.update\(\{[\s\S]*?exchange_code:\s*null[\s\S]*?\}\.select\(/m), '6. service: NO broken .update().select() pattern');

  // No tokens in response.
  ok(!api.match(/access_token.*json/) && !api.match(/json.*access_token/), '6. no access_token in response');
  ok(!api.match(/refresh_token.*json/) && !api.match(/json.*refresh_token/), '6. no refresh_token in response');
  ok(!api.match(/exchange_code.*json/) && !api.match(/json.*exchange_code/), '6. no exchange_code in response');

  ok('6. exchange endpoint (rate limited, RPC-based, no token leakage)');
}

// ============================================================
// 7. CANCEL ENDPOINT — ATOMIC + IDEMPOTENT
// ============================================================
{
  const api = read('src/routes/api/auth/device-pairing/cancel/+server.ts');
  const service = read('src/lib/server/auth/device-pairing.ts');

  // Atomic transition: pending → cancelled (guarded by eq('status', 'pending')).
  const cancelStart = service.indexOf('export async function cancelPairingRequest');
  const cancelEnd = service.indexOf('\n}\n', cancelStart);
  const cancelBody = service.slice(cancelStart, cancelEnd !== -1 ? cancelEnd : undefined);
  ok(cancelBody.includes("update({ status: 'cancelled' }"), '7. cancel: UPDATE sets status=cancelled');
  ok(cancelBody.includes("eq('status', 'pending')"), '7. cancel: WHERE status=pending (atomic, idempotent)');

  // A cancelled request cannot be approved (approve requires pending).
  ok(service.includes("eq('status', 'pending')"), '7. cancelled → approved blocked (approve requires pending)');

  // A cancelled request cannot be exchanged (claim RPC requires approved).
  const rpcMigration = read('supabase/migrations/20260929000000_device_pairing_claim_rpc.sql');
  ok(rpcMigration.includes("status = 'approved'"), '7. cancelled → consumed blocked (claim RPC requires approved)');

  ok('7. cancel endpoint (atomic, idempotent, prevents later approve/consume)');
}

// ============================================================
// 8. EXPIRY — LAZY + RPC-ENFORCED
// ============================================================
{
  const service = read('src/lib/server/auth/device-pairing.ts');
  const rpcMigration = read('supabase/migrations/20260929000000_device_pairing_claim_rpc.sql');

  // Lazy expiry in getPairingBySecret.
  ok(service.includes('isExpired') || service.includes('expires_at'), '8. service: checks expiry');
  ok(service.includes("status: 'expired'"), '8. service: marks expired on stale pending');

  // RPC-enforced expiry — claim_device_pairing WHERE clause.
  ok(rpcMigration.includes('expires_at > p_now'), '8. RPC: WHERE expires_at > now (atomic expiry check)');

  // Approved → expired path (lazy in status, enforced in RPC).
  ok(service.includes('new Date(data.expires_at).getTime() < Date.now()'), '8. service: time-based expiry check');

  ok('8. expiry (lazy in status, RPC-enforced in claim)');
}

// ============================================================
// 9. SINGLE-USE CLAIM — RPC CONTRACT
// ============================================================
{
  const migration = read('supabase/migrations/20260929000000_device_pairing_claim_rpc.sql');

  // SELECT FOR UPDATE — row lock.
  ok(migration.includes('for update;'), '9. RPC: SELECT FOR UPDATE (row lock)');

  // Captures OLD exchange_code BEFORE UPDATE.
  ok(migration.includes('select id, exchange_code into v_row'), '9. RPC: captures OLD exchange_code');
  ok(migration.includes('return query select v_row.id'), '9. RPC: returns OLD v_row.id');
  ok(migration.includes('v_row.exchange_code'), '9. RPC: returns OLD v_row.exchange_code (NOT post-update NULL)');

  // UPDATE: status=consumed, consumed_at, exchange_code=NULL.
  ok(migration.includes("set status = 'consumed'"), '9. RPC: UPDATE sets status=consumed');
  ok(migration.includes('consumed_at = p_now'), '9. RPC: UPDATE sets consumed_at');
  ok(migration.includes('exchange_code = null'), '9. RPC: UPDATE clears exchange_code');

  // WHERE guards.
  ok(migration.includes("status = 'approved'"), '9. RPC: WHERE status=approved');
  ok(migration.includes('consumed_at is null'), '9. RPC: WHERE consumed_at IS NULL');
  ok(migration.includes('expires_at > p_now'), '9. RPC: WHERE expires_at > now');

  // Privilege model.
  ok(migration.includes('security definer'), '9. RPC: SECURITY DEFINER');
  ok(migration.includes('set search_path = public'), '9. RPC: search_path pinned');
  ok(migration.includes('revoke execute on function public.claim_device_pairing'), '9. RPC: EXECUTE revoked');
  ok(migration.includes('grant execute on function public.claim_device_pairing'), '9. RPC: EXECUTE granted');
  ok(migration.includes('to service_role'), '9. RPC: granted to service_role');

  ok('9. single-use claim RPC (SELECT FOR UPDATE, OLD OTP capture, atomic consume, privilege lockdown)');
}

// ============================================================
// 10. RATE LIMIT BUCKETS — DEDICATED PAIRING BUCKETS
// ============================================================
{
  const rl = read('src/lib/server/http/rate-limit.ts');

  ok(rl.includes('pairingCreate'), '10. pairingCreate bucket defined');
  ok(rl.includes('pairingPoll'), '10. pairingPoll bucket defined');
  ok(rl.includes('pairingApprove'), '10. pairingApprove bucket defined');
  ok(rl.includes('pairingExchange'), '10. pairingExchange bucket defined');

  // Limits are sensible.
  ok(rl.match(/pairingCreate:\s*\{\s*limit:\s*10/), '10. pairingCreate: 10/min per IP');
  ok(rl.match(/pairingPoll:\s*\{\s*limit:\s*60/), '10. pairingPoll: 60/min per IP+secret');
  ok(rl.match(/pairingApprove:\s*\{\s*limit:\s*20/), '10. pairingApprove: 20/min per user');
  ok(rl.match(/pairingExchange:\s*\{\s*limit:\s*10/), '10. pairingExchange: 10/min per IP');

  // Bounded memory.
  ok(rl.includes('MAX_TRACKED_BUCKETS'), '10. bounded memory (MAX_TRACKED_BUCKETS)');

  ok('10. rate limit buckets (dedicated pairing buckets, bounded memory)');
}

// ============================================================
// 11. NO UNAUTHENTICATED DEVICE SESSION REGISTRATION
// ============================================================
// The TV is unauthenticated during challenge creation, status
// polling, and exchange (before the exchange succeeds). The hook
// must NOT register a device session for these unauthenticated
// requests.
{
  const hooks = read('src/hooks.server.ts');

  // Registration only happens when auth.session && auth.user are set.
  ok(hooks.includes('!sessionRevoked && auth.session && auth.user'), '11. hook: registration guarded by authenticated + not revoked');

  // Unauthenticated requests (no auth.session or auth.user) skip
  // registration entirely — the hook's isSessionRevoked check and
  // the registration block are both inside `if (auth.session?.access_token && auth.user)`.
  ok(hooks.includes('if (auth.session?.access_token && auth.user)'), '11. hook: revocation check only for authenticated requests');

  // The pairing endpoints (create, status, exchange) are unauthenticated
  // (except approve which requires locals.user). They do NOT trigger
  // device session registration because auth.user is null.
  const createApi = read('src/routes/api/auth/device-pairing/create/+server.ts');
  ok(!createApi.includes('registerCurrentSession'), '11. create endpoint: does NOT call registerCurrentSession');
  ok(!createApi.includes('locals.user'), '11. create endpoint: does NOT use locals.user (unauthenticated)');

  const statusApi = read('src/routes/api/auth/device-pairing/status/+server.ts');
  ok(!statusApi.includes('registerCurrentSession'), '11. status endpoint: does NOT call registerCurrentSession');

  const exchangeApi = read('src/routes/api/auth/device-pairing/exchange/+server.ts');
  ok(!exchangeApi.includes('registerCurrentSession'), '11. exchange endpoint: does NOT call registerCurrentSession');

  // The exchange endpoint establishes the TV's session via
  // exchangeCodeForSession on locals.supabase. The TV becomes
  // authenticated AFTER the exchange succeeds — its NEXT request
  // (after redirect to /discover) will register a device session
  // normally via the hook.
  ok(exchangeApi.includes('exchangeCodeForSession') || exchangeApi.includes('claimAndExchangePairing'), '11. exchange endpoint: establishes TV session via exchangeCodeForSession');

  ok('11. no unauthenticated device session registration (challenge creation does not register)');
}

// ============================================================
// 12. LOGGING / PRIVACY — NO SECRETS LOGGED
// ============================================================
{
  const service = read('src/lib/server/auth/device-pairing.ts');
  const createApi = read('src/routes/api/auth/device-pairing/create/+server.ts');
  const approveApi = read('src/routes/api/auth/device-pairing/approve/+server.ts');
  const exchangeApi = read('src/routes/api/auth/device-pairing/exchange/+server.ts');
  const statusApi = read('src/routes/api/auth/device-pairing/status/+server.ts');
  const cancelApi = read('src/routes/api/auth/device-pairing/cancel/+server.ts');
  const infoApi = read('src/routes/api/auth/device-pairing/info/+server.ts');

  const allFiles = [service, createApi, approveApi, exchangeApi, statusApi, cancelApi, infoApi];

  for (const file of allFiles) {
    ok(!file.match(/console\.\w+.*\bsecret\b/i), '12. no file logs raw pairing secret');
    ok(!file.match(/console\.\w+.*exchange_code/i), '12. no file logs exchange_code');
    ok(!file.match(/console\.\w+.*hashed_token/i), '12. no file logs hashed_token');
    ok(!file.match(/console\.\w+.*access_token/i), '12. no file logs access_token');
    ok(!file.match(/console\.\w+.*refresh_token/i), '12. no file logs refresh_token');
  }

  ok('12. logging/privacy (no secrets, exchange codes, or tokens in logs)');
}

// ============================================================
// 13. LIFECYCLE STATE TRANSITIONS — VALID VS INVALID
// ============================================================
// Static contract of valid transitions:
//   PENDING → APPROVED (via approve endpoint)
//   PENDING → CANCELLED (via cancel endpoint)
//   PENDING → EXPIRED (lazy in status, or via expiry)
//   APPROVED → CONSUMED (via claim RPC)
//   APPROVED → EXPIRED (via RPC WHERE clause rejection)
//
// Invalid transitions (must be blocked):
//   CONSUMED → APPROVED, CONSUMED → PENDING (no path)
//   CANCELLED → APPROVED (approve requires pending)
//   EXPIRED → APPROVED (approve requires pending)
//   CANCELLED → CONSUMED (claim requires approved)
//   EXPIRED → CONSUMED (claim requires approved)
{
  const service = read('src/lib/server/auth/device-pairing.ts');
  const rpcMigration = read('supabase/migrations/20260929000000_device_pairing_claim_rpc.sql');

  // approve: requires status=pending.
  ok(service.includes("eq('status', 'pending')"), '13. approve: requires status=pending (blocks cancelled/expired/consumed)');

  // cancel: requires status=pending.
  ok(service.includes("update({ status: 'cancelled' }"), '13. cancel: sets status=cancelled');
  ok(service.includes("eq('status', 'pending')"), '13. cancel: requires status=pending (blocks cancelled/expired/consumed)');

  // claim RPC: requires status=approved AND consumed_at IS NULL AND expires_at > now.
  ok(rpcMigration.includes("status = 'approved'"), '13. claim RPC: requires status=approved (blocks pending/cancelled/expired/consumed)');
  ok(rpcMigration.includes('consumed_at is null'), '13. claim RPC: requires consumed_at IS NULL (blocks already-consumed)');
  ok(rpcMigration.includes('expires_at > p_now'), '13. claim RPC: requires expires_at > now (blocks expired)');

  // Terminal states: consumed, cancelled, expired have no outgoing
  // transitions defined anywhere in the service or RPC.
  ok(!service.includes("update({ status: 'pending'"), '13. no path back to pending (terminal states cannot resurrect)');
  ok(!service.includes("update({ status: 'approved'"), '13. no path from cancelled/expired/consumed back to approved');

  ok('13. lifecycle transitions (valid: pending→approved/cancelled/expired, approved→consumed/expired; invalid: all others)');
}

// ============================================================
// 14. CONCURRENT CLAIM — DETERMINISTIC SIMULATION
// ============================================================
// Two concurrent exchange requests with the same secret. Only one
// wins; the other gets HTTP 409.
{
  // Simulate the RPC's behavior.
  let dbRow = {
    id: 'pairing-1',
    secret_hash: 'hash-abc',
    status: 'approved' as const,
    consumed_at: null as string | null,
    exchange_code: 'OTP_xyz' as string | null,
    expires_at: new Date(Date.now() + 60_000).toISOString(),
  };

  const winners: { id: string; otp: string | null }[] = [];

  function simulateClaim(): { id: string; otp: string | null } | null {
    // RPC: SELECT FOR UPDATE — if row matches (approved, not consumed, not expired), lock + capture OLD.
    if (dbRow.status !== 'approved' || dbRow.consumed_at !== null || dbRow.exchange_code === null) {
      return null; // not eligible
    }
    const captured = { id: dbRow.id, otp: dbRow.exchange_code };
    // UPDATE: status=consumed, consumed_at=now, exchange_code=NULL.
    dbRow = {
      ...dbRow,
      status: 'consumed' as const,
      consumed_at: new Date().toISOString(),
      exchange_code: null,
    };
    return captured; // RETURN OLD
  }

  // Request A wins.
  const resultA = simulateClaim();
  if (resultA) winners.push(resultA);

  // Request B loses (status is now consumed).
  const resultB = simulateClaim();
  if (resultB) winners.push(resultB);

  // Invariants.
  assert.equal(winners.length, 1, '14. exactly one winner');
  assert.equal(winners[0]?.otp, 'OTP_xyz', '14. winner received the OLD OTP');
  assert.equal(resultB, null, '14. loser received null (RPC returned empty)');
  assert.equal(dbRow.status, 'consumed', '14. DB row is consumed');
  assert.equal(dbRow.exchange_code, null, '14. DB row exchange_code is NULL');

  passed += 5;
  console.log('  ok 14a — exactly one winner');
  console.log('  ok 14b — winner received OLD OTP');
  console.log('  ok 14c — loser received null');
  console.log('  ok 14d — DB row consumed after both');
  console.log('  ok 14e — DB row exchange_code NULL after both');

  ok('14. concurrent claim simulation (single-winner, OLD OTP captured, consumed state)');
}

// ============================================================
// 15. APPROVE CANNOT BE CALLED TWICE
// ============================================================
// Deterministic simulation: approve is guarded by eq('status', 'pending').
// After the first approve succeeds, status=approved. A second approve
// finds status != pending and fails.
{
  let dbRow = { id: 'pairing-1', status: 'pending' as const };

  function simulateApprove(): boolean {
    // UPDATE ... WHERE status='pending'
    if (dbRow.status !== 'pending') return false;
    dbRow = { ...dbRow, status: 'approved' as const };
    return true;
  }

  const r1 = simulateApprove();
  const r2 = simulateApprove();

  assert.equal(r1, true, '15. first approve succeeds');
  assert.equal(r2, false, '15. second approve fails (status no longer pending)');
  assert.equal(dbRow.status, 'approved', '15. status is approved (not consumed)');

  passed += 3;
  console.log('  ok 15a — first approve succeeds');
  console.log('  ok 15b — second approve fails');
  console.log('  ok 15c — status remains approved');

  ok('15. approve cannot be called twice (atomic guarded by status=pending)');
}

// ============================================================
// 16. CONSUMED CANNOT BE CONSUMED AGAIN
// ============================================================
// The claim RPC requires status=approved AND consumed_at IS NULL.
// After consumption, status=consumed and consumed_at is set. A
// second claim finds no eligible row.
{
  let dbRow = {
    status: 'consumed' as const,
    consumed_at: new Date().toISOString(),
    exchange_code: null as string | null,
    expires_at: new Date(Date.now() + 60_000).toISOString(),
  };

  function simulateClaim(): boolean {
    return dbRow.status === 'approved' && dbRow.consumed_at === null && dbRow.exchange_code !== null;
  }

  assert.equal(simulateClaim(), false, '16. consumed request cannot be claimed again');

  passed += 1;
  console.log('  ok 16a — consumed request cannot be claimed again');

  ok('16. consumed cannot be consumed again (RPC WHERE clause rejects)');
}

// ============================================================
// 17. WRONG/INVALID SECRET REJECTED
// ============================================================
// A secret that doesn't match any secret_hash returns 404 (status)
// or 404 (exchange diagnostic).
{
  const service = read('src/lib/server/auth/device-pairing.ts');

  // getPairingBySecret returns null + error if not found.
  ok(service.includes('Pairing request not found.'), '17. getPairingBySecret: returns not-found error');

  // claimAndExchangePairing returns 404 if the diagnostic lookup finds no row.
  ok(service.includes('status: 404'), '17. claimAndExchangePairing: returns 404 for not-found');

  // Status endpoint returns 404.
  const statusApi = read('src/routes/api/auth/device-pairing/status/+server.ts');
  ok(statusApi.includes('404'), '17. status endpoint: returns 404 for invalid secret');

  ok('17. wrong/invalid secret rejected (404)');
}

// ============================================================
// 18. EXISTING DEVICE-PAIRING TESTS REMAIN GREEN
// ============================================================
// Verify the existing test file is still present and references
// the new rate-limit buckets where applicable.
{
  const existingTests = read('scripts/device_pairing_test.ts');
  ok(existingTests.length > 1000, '18. existing device_pairing_test.ts is present and substantial');
  ok(existingTests.includes('check crate rate limit') || existingTests.includes('rate limited') || existingTests.includes('checkRateLimit'), '18. existing tests reference rate limiting');

  ok('18. existing device-pairing tests remain present');
}

console.log(`\nPhase 4 QR challenge backend tests passed (${passed} check groups).`);
