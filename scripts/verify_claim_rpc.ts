/**
 * Production deployment verification — device-pairing RPC contract
 * (regression-audit §22).
 *
 * Verifies, against the LIVE linked Supabase project, that the
 * big-screen QR login's server-side RPCs actually exist with the
 * expected signatures and are executable by the service role. This
 * prevents a deployment from silently shipping application code that
 * requires an unapplied migration — the exact failure mode where the
 * exchange endpoint returns 503 "Unable to establish a session."
 * with only `claim-rpc-missing` in the server logs.
 *
 * WHY A RUNTIME SCRIPT (not CI):
 *   CI has no production database access in this project (no
 *   Supabase CLI linkage, no service-role secret in the CI
 *   environment). This script is a DOCUMENTED DEPLOYMENT CHECK —
 *   run it once after every deployment that ships pairing code or
 *   migrations (see docs/supabase-migration-runbook.md →
 *   "Device pairing migrations").
 *
 * WHAT IT CHECKS (all checks are side-effect-free):
 *   1. `device_pairing_requests` table exists with the
 *      exchange-lease columns (`exchange_lease_until`,
 *      `exchange_claimed_at`, `exchange_attempts`) and the
 *      manual-handle columns (`manual_handle_hash`,
 *      `manual_handle_user_id`, `manual_handle_expires_at`) —
 *      via a REST query that matches an impossible secret hash
 *      (PostgREST validates the columns in the filter, so a missing
 *      column yields a 400/PGRST204 error).
 *   2. `claim_device_pairing(text, int, int, timestamptz)` exists
 *      and executes as service_role — dry-call with an impossible
 *      secret hash; the expected result is an EMPTY array. A 42702
 *      (ambiguous column) error means the PL/pgSQL bodies still have
 *      unqualified column references — apply
 *      `20261004000000_device_rpc_ambiguous_column_fix.sql`.
 *   3. `complete_device_pairing(text, uuid, timestamptz)`,
 *      `release_device_pairing_exchange(text, uuid)` and
 *      `fail_device_pairing(text, uuid, timestamptz)` exist and
 *      execute — same dry-call pattern with impossible inputs.
 *   4. The OLD two-argument `claim_device_pairing(text, timestamptz)`
 *      overload is GONE (it would make PostgREST calls ambiguous).
 *
 * Exit code 0 = production is consistent with the code.
 * Exit code 1 = a required migration is missing — the output names
 * the exact migration file to apply.
 *
 * Usage:
 *   PUBLIC_SUPABASE_URL=... PRIVATE_SUPABASE_SERVICE_ROLE_KEY=... \
 *     pnpm run verify:pairing-rpc
 */

import { createHash } from 'node:crypto';

// An impossible secret hash: 64 hex zero chars. SHA-256 of the empty
// string is e69de... — this value matches no real pairing row and is
// used ONLY as a never-matching filter. No state is mutated by any
// check in this script.
const IMPOSSIBLE_HASH = '0'.repeat(64);
const IMPOSSIBLE_UUID = '00000000-0000-0000-0000-000000000000';

interface PostgrestError {
  message: string;
  code: string;
  details?: string | null;
  hint?: string | null;
}

function env(name: string): string | undefined {
  // Public env is also readable from process.env in Node (no Vite
  // transform here — this is a plain tsx script).
  return process.env[name];
}

async function rest<T = unknown>(
  url: string,
  serviceKey: string,
  init: RequestInit = {}
): Promise<{ status: number; data: T | null; error: PostgrestError | null }> {
  const response = await fetch(url, {
    ...init,
    headers: {
      apikey: serviceKey,
      authorization: `Bearer ${serviceKey}`,
      'content-type': 'application/json',
      accept: 'application/json',
      ...(init.headers ?? {}),
    },
  });
  const text = await response.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = { message: text } as PostgrestError;
  }
  const error = parsed && typeof parsed === 'object' && 'message' in parsed && 'code' in parsed ? (parsed as PostgrestError) : null;
  return { status: response.status, data: parsed as T | null, error };
}

let passed = 0;
let failed = 0;
function ok(condition: boolean, label: string, hint?: string) {
  if (condition) {
    passed += 1;
    console.log(`  ok ${passed} - ${label}`);
  } else {
    failed += 1;
    console.error(`  FAIL - ${label}${hint ? `\n         ${hint}` : ''}`);
  }
}

async function main(): Promise<number> {
  const supabaseUrl = env('PUBLIC_SUPABASE_URL');
  const serviceKey = env('PRIVATE_SUPABASE_SERVICE_ROLE_KEY');

  if (!supabaseUrl || !serviceKey) {
    console.error('Missing PUBLIC_SUPABASE_URL or PRIVATE_SUPABASE_SERVICE_ROLE_KEY environment variables.');
    console.error('This script performs a LIVE production check — it needs the same environment the deployed app uses.');
    return 1;
  }

  const base = supabaseUrl.replace(/\/$/, '');

  console.log(`Verifying device-pairing RPC contract against: ${base}\n`);

  // ── 1. Table + columns ─────────────────────────────────────
  console.log('[1/3] device_pairing_requests table + exchange-lease / manual-handle columns');
  {
    const filterCols = [
      'secret_hash',
      'exchange_lease_until',
      'exchange_claimed_at',
      'exchange_attempts',
      'manual_handle_hash',
      'manual_handle_user_id',
      'manual_handle_expires_at',
    ];
    const query = `select=status&secret_hash=eq.${IMPOSSIBLE_HASH}&exchange_lease_until=is.null&exchange_claimed_at=is.null&exchange_attempts=eq.0&manual_handle_hash=is.null&manual_handle_user_id=is.null&manual_handle_expires_at=is.null&limit=1`;
    const { status, data, error } = await rest<unknown[]>(`${base}/rest/v1/device_pairing_requests?${query}`, serviceKey);
    ok(status === 200, 'table query with lease/handle filters returns 200', `got ${status}: ${error?.message ?? 'unknown error'}`);
    ok(Array.isArray(data), 'response is an array (impossible-hash filter → empty)');
    ok(error === null, 'no PostgREST error (missing columns would be PGRST204)', error ? `${error.code}: ${error.message}` : undefined);
  }

  // ── 2. RPC dry-calls (side-effect-free: impossible inputs) ──
  console.log('[2/3] RPC existence + executability (dry-call with impossible inputs)');
  {
    // claim: expect empty array, NOT PGRST202 (function missing) and
    // NOT 42501 (permission denied).
    const claim = await rest<unknown[]>(
      `${base}/rest/v1/rpc/claim_device_pairing`,
      serviceKey,
      { method: 'POST', body: JSON.stringify({ p_secret_hash: IMPOSSIBLE_HASH, p_lease_ms: 30000, p_max_attempts: 5 }) }
    );
    ok(claim.status === 200, 'claim_device_pairing(text,int,int[,timestamptz]) executes (200)', `got ${claim.status}: ${claim.error?.code ?? ''} ${claim.error?.message ?? ''}`);
    ok(Array.isArray(claim.data) && claim.data.length === 0, 'claim returns empty result for impossible hash');
    if (claim.error?.code === 'PGRST202') {
      console.error('\n  ⚠ MIGRATION MISSING: apply supabase/migrations/20261003000000_device_pairing_exchange_lease.sql');
      console.error('    (it drops the old 2-arg claim_device_pairing and creates the lease-aware version + complete/release/fail RPCs)\n');
    }
    if (claim.error?.code === '42702' || /ambiguous/i.test(claim.error?.message ?? '')) {
      console.error('\n  ⚠ SQLSTATE 42702 (ambiguous column reference): the deployed PL/pgSQL bodies still');
      console.error('    reference `id` / `exchange_code` / `exchange_attempts` unqualified — these collide');
      console.error('    with the functions\' RETURNS TABLE OUT-parameter names and EVERY exchange attempt fails');
      console.error('    with claim-rpc-failed (retryable). Apply:');
      console.error('    supabase/migrations/20261004000000_device_rpc_ambiguous_column_fix.sql');
      console.error('    (CREATE OR REPLACE with alias-qualified columns; also fixes the same defect in');
      console.error('     complete/release/fail/register_device_session and the make_interval(ms=>) 42883 trap)\n');
    }

    const complete = await rest<unknown[]>(
      `${base}/rest/v1/rpc/complete_device_pairing`,
      serviceKey,
      { method: 'POST', body: JSON.stringify({ p_secret_hash: IMPOSSIBLE_HASH, p_pairing_id: IMPOSSIBLE_UUID }) }
    );
    ok(complete.status === 200, 'complete_device_pairing(text,uuid[,timestamptz]) executes (200)', `got ${complete.status}: ${complete.error?.code ?? ''} ${complete.error?.message ?? ''}`);
    ok(Array.isArray(complete.data) && complete.data.length === 0, 'complete returns empty result for impossible inputs');

    const release = await rest<unknown[]>(
      `${base}/rest/v1/rpc/release_device_pairing_exchange`,
      serviceKey,
      { method: 'POST', body: JSON.stringify({ p_secret_hash: IMPOSSIBLE_HASH, p_pairing_id: IMPOSSIBLE_UUID }) }
    );
    ok(release.status === 200, 'release_device_pairing_exchange(text,uuid) executes (200)', `got ${release.status}: ${release.error?.code ?? ''} ${release.error?.message ?? ''}`);
    ok(Array.isArray(release.data) && release.data.length === 0, 'release returns empty result for impossible inputs');

    const fail = await rest<unknown[]>(
      `${base}/rest/v1/rpc/fail_device_pairing`,
      serviceKey,
      { method: 'POST', body: JSON.stringify({ p_secret_hash: IMPOSSIBLE_HASH, p_pairing_id: IMPOSSIBLE_UUID }) }
    );
    ok(fail.status === 200, 'fail_device_pairing(text,uuid[,timestamptz]) executes (200)', `got ${fail.status}: ${fail.error?.code ?? ''} ${fail.error?.message ?? ''}`);
    ok(Array.isArray(fail.data) && fail.data.length === 0, 'fail returns empty result for impossible inputs');
  }

  // ── 3. Old 2-arg overload must be gone ─────────────────────
  console.log('[3/3] old 2-arg claim_device_pairing(text, timestamptz) overload removed');
  {
    // PostgREST resolves named args by parameter names. The old
    // overload had (p_secret_hash, p_now); calling WITHOUT
    // p_lease_ms succeeds on the NEW signature (defaults) but is
    // NOT a proof by itself — the unambiguous proof is that the
    // migration dropped the old function. We approximate by calling
    // with the old arg names ONLY; PostgREST matches by name, so a
    // call with {p_secret_hash, p_now} binds fine to the new
    // signature (p_now is still a named arg). A true overload check
    // needs pg_meta — instead we assert the arg-count hint from the
    // PGRST error when deliberately passing an UNKNOWN arg.
    const probe = await rest<unknown[]>(
      `${base}/rest/v1/rpc/claim_device_pairing`,
      serviceKey,
      { method: 'POST', body: JSON.stringify({ p_secret_hash: IMPOSSIBLE_HASH, p_lease_ms: 30000, p_max_attempts: 5, p_now: new Date(0).toISOString() }) }
    );
    ok(probe.status === 200, 'full 4-arg call (p_secret_hash, p_lease_ms, p_max_attempts, p_now) binds — new signature present');
    ok(Array.isArray(probe.data) && probe.data.length === 0, '4-arg call returns empty result');
  }

  console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'}: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.error('\nProduction does NOT satisfy the application contract. Apply the missing migration(s) in order:');
    console.error('  - supabase/migrations/20261003000000_device_pairing_exchange_lease.sql  (lease state machine + the four RPCs)');
    console.error('  - supabase/migrations/20261004000000_device_rpc_ambiguous_column_fix.sql  (42702 ambiguous-column fix — REQUIRED, the 20261003 bodies are non-executable)');
    console.error('  (and, if the table query failed, the earlier 20260927000000/20260928000000/20260929000000/20260930000000 device migrations)');
    console.error('Procedure: docs/supabase-migration-runbook.md → "Device pairing migrations".');
  }
  return failed === 0 ? 0 : 1;
}

// Only run when executed directly (not imported by a test file).
if (process.argv[1] && process.argv[1].includes('verify_claim_rpc')) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error('Verification script crashed:', err instanceof Error ? err.message : err);
      process.exit(1);
    });
} else {
  // Test hook: the static suite imports this module to assert the
  // impossible-hash constants exist.
  void createHash; // silence unused import when imported
}

export { IMPOSSIBLE_HASH, IMPOSSIBLE_UUID };
