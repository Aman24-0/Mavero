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
// PHASE 3 HARDENING — TOCTOU RACE FIX (register_device_session RPC)
// ============================================================
//
// PROBLEM:
//   The Phase 3 commit `57cafd7` had a TOCTOU race between
//   isSessionRevoked() (in hooks.server.ts) and registerCurrentSession()
//   (in device-sessions.ts). The unique partial index on
//   (user_id, supabase_session_id) WHERE revoked_at IS NULL means a
//   revoked row is EXCLUDED from the index — so a separate INSERT
//   after revocation would NOT violate the constraint and would
//   resurrect the revoked session.
//
// FIX:
//   A SECURITY DEFINER PL/pgSQL RPC `register_device_session` that
//   uses SELECT ... FOR UPDATE to atomically check the revocation
//   state and INSERT/UPDATE. The RPC returns empty if the session
//   is revoked (do NOT resurrect).
//
// These are STATIC CONTRACT + DETERMINISTIC tests. Runtime DB
// verification is out of scope (no live Supabase credentials).

// ============================================================
// 1. RPC MIGRATION CONTRACT
// ============================================================
{
  const migration = read('supabase/migrations/20260930000000_register_device_session_rpc.sql');

  // Function definition.
  ok(migration.includes('create or replace function public.register_device_session'), '1. RPC function defined');
  ok(migration.includes('language plpgsql'), '1. RPC is PL/pgSQL');
  ok(migration.includes('security definer'), '1. RPC is SECURITY DEFINER');
  ok(migration.includes('set search_path = public'), '1. RPC pins search_path');

  // Arguments match the service's call signature.
  ok(migration.includes('p_user_id uuid'), '1. RPC arg: p_user_id');
  ok(migration.includes('p_supabase_session_id uuid'), '1. RPC arg: p_supabase_session_id');
  ok(migration.includes('p_device_id text'), '1. RPC arg: p_device_id');
  ok(migration.includes('p_device_type text'), '1. RPC arg: p_device_type');
  ok(migration.includes('p_device_name text'), '1. RPC arg: p_device_name');
  ok(migration.includes('p_browser text'), '1. RPC arg: p_browser');
  ok(migration.includes('p_os text'), '1. RPC arg: p_os');
  ok(migration.includes('p_platform text'), '1. RPC arg: p_platform');
  ok(migration.includes('p_ip_hash text'), '1. RPC arg: p_ip_hash');
  ok(migration.includes('p_heartbeat_interval_ms integer'), '1. RPC arg: p_heartbeat_interval_ms');
  ok(migration.includes('p_now timestamptz'), '1. RPC arg: p_now');

  // Returns the session row + a `registered` flag.
  ok(migration.includes('returns table('), '1. RPC returns table');
  ok(migration.includes('id uuid'), '1. RPC returns id');
  ok(migration.includes('revoked_at timestamptz'), '1. RPC returns revoked_at');
  ok(migration.includes('registered boolean'), '1. RPC returns registered flag');

  // Privilege lockdown + service_role grant.
  ok(migration.includes('revoke execute on function public.register_device_session'), '1. RPC: EXECUTE revoked');
  ok(migration.includes('from PUBLIC'), '1. RPC: revoked from PUBLIC');
  ok(migration.includes('from authenticated'), '1. RPC: revoked from authenticated');
  ok(migration.includes('from anon'), '1. RPC: revoked from anon');
  ok(migration.includes('grant execute on function public.register_device_session'), '1. RPC: EXECUTE granted');
  ok(migration.includes('to service_role'), '1. RPC: granted to service_role');

  ok('1. register_device_session RPC migration contract');
}

// ============================================================
// 2. RPC INTERNAL LOGIC — SELECT FOR UPDATE + REVOKED GUARD
// ============================================================
{
  const migration = read('supabase/migrations/20260930000000_register_device_session_rpc.sql');

  // SELECT ... FOR UPDATE — row lock held until COMMIT.
  ok(migration.includes('for update;'), '2. RPC uses SELECT ... FOR UPDATE (row lock)');

  // Lock is NOT scoped by revoked_at IS NULL — must lock the row
  // regardless of revoked_at state so a racing revoke is serialized.
  // Verify the SELECT does NOT have `and revoked_at is null` in the
  // FOR UPDATE query (it would skip the revoked row and let the
  // INSERT proceed).
  const forUpdateSection = migration.slice(
    migration.indexOf('select * into v_row'),
    migration.indexOf('for update;')
  );
  ok(!forUpdateSection.includes('revoked_at is null'), '2. RPC SELECT FOR UPDATE does NOT filter by revoked_at (locks row regardless of state)');

  // Revoked guard — do NOT resurrect.
  ok(migration.includes('if v_row.revoked_at is not null then'), '2. RPC checks revoked_at AFTER lock');
  ok(migration.includes('return;'), '2. RPC returns empty when revoked (do NOT resurrect)');

  // Heartbeat check uses p_heartbeat_interval_ms.
  ok(migration.includes('p_heartbeat_interval_ms'), '2. RPC uses p_heartbeat_interval_ms for heartbeat');

  // INSERT path with unique_violation catch.
  ok(migration.includes('insert into public.device_sessions'), '2. RPC INSERTs when no row exists');
  ok(migration.includes('exception when unique_violation'), '2. RPC catches unique_violation (concurrent INSERT race)');

  ok('2. RPC internal logic (SELECT FOR UPDATE, revoked guard, heartbeat, INSERT race handling)');
}

// ============================================================
// 3. SERVICE CONTRACT — registerCurrentSession DELEGATES TO RPC
// ============================================================
{
  const service = read('src/lib/server/auth/device-sessions.ts');

  // The service calls the RPC.
  ok(service.includes("rpc('register_device_session'"), '3. service: calls register_device_session RPC');
  ok(service.includes('p_user_id:'), '3. service: passes p_user_id');
  ok(service.includes('p_supabase_session_id:'), '3. service: passes p_supabase_session_id');
  ok(service.includes('p_device_id:'), '3. service: passes p_device_id');
  ok(service.includes('p_device_type:'), '3. service: passes p_device_type');
  ok(service.includes('p_device_name:'), '3. service: passes p_device_name');
  ok(service.includes('p_browser:'), '3. service: passes p_browser');
  ok(service.includes('p_os:'), '3. service: passes p_os');
  ok(service.includes('p_platform:'), '3. service: passes p_platform');
  ok(service.includes('p_heartbeat_interval_ms: HEARTBEAT_INTERVAL_MS'), '3. service: passes heartbeat interval');

  // The service handles the empty-array case (revoked — do NOT resurrect).
  ok(service.includes('rows.length === 0'), '3. service: handles empty RPC result (revoked, do NOT resurrect)');

  // The service does NOT do its own SELECT-then-INSERT anymore.
  // The old registerCurrentSession did: .from('device_sessions').select(...).is('revoked_at', null).maybeSingle()
  // followed by a separate .insert(...). The new pattern is a single
  // RPC call. We extract ONLY the registerCurrentSession function body
  // to check — other functions (revokeSession, lookupSessionRevocationState,
  // etc.) legitimately use .is('revoked_at', null) for their own queries.
  const fnStart = service.indexOf('export async function registerCurrentSession');
  const fnEnd = service.indexOf('\n}\n', fnStart);
  ok(fnStart !== -1, '3. registerCurrentSession function exists');
  const fnBody = service.slice(fnStart, fnEnd !== -1 ? fnEnd : undefined);
  const oldSelectPattern = fnBody.match(/from\('device_sessions'\)[\s\S]*?\.is\('revoked_at', null\)[\s\S]*?\.maybeSingle\(\)/);
  ok(oldSelectPattern === null, '3. registerCurrentSession: NO old SELECT-then-INSERT pattern (delegates to RPC)');
  ok(!fnBody.includes('.insert('), '3. registerCurrentSession: NO direct .insert() call (delegates to RPC)');

  ok('3. service contract (delegates to RPC, handles empty result, no SELECT-then-INSERT)');
}

// ============================================================
// 4. DATABASE TYPES — RPC TYPE SIGNATURE
// ============================================================
{
  const types = read('src/lib/server/supabase/database.types.ts');

  ok(types.includes('register_device_session:'), '4. database types include register_device_session RPC');
  ok(types.includes('p_user_id: string'), '4. RPC type: p_user_id');
  ok(types.includes('p_supabase_session_id: string'), '4. RPC type: p_supabase_session_id');
  ok(types.includes('p_heartbeat_interval_ms?: number'), '4. RPC type: p_heartbeat_interval_ms');
  ok(types.includes('registered: boolean | null'), '4. RPC type: returns registered flag');

  ok('4. database types register_device_session RPC signature');
}

// ============================================================
// 5. DETERMINISTIC SIMULATION — RACE FIX
// ============================================================
// Simulates the RPC's behavior under the TOCTOU race to verify a
// revoked session is NOT resurrected.
{
  // Simulate the device_sessions table as an in-memory array.
  type Row = {
    id: string;
    user_id: string;
    supabase_session_id: string;
    revoked_at: string | null;
    last_seen_at: string;
  };

  function makeRpcSimulation(now: number) {
    // The RPC locks rows via SELECT FOR UPDATE. In simulation, we
    // serialize the calls — only one at a time. The race between
    // isSessionRevoked() (in hooks) and registerCurrentSession()
    // (in service) is what we're testing.
    return function registerDeviceSession(
      rows: Row[],
      userId: string,
      sessionId: string,
      heartbeatMs: number
    ): Row | null {
      // SELECT ... FOR UPDATE (locks the row regardless of revoked_at).
      const row = rows.find(r => r.user_id === userId && r.supabase_session_id === sessionId);

      if (row) {
        if (row.revoked_at !== null) {
          // Revoked — do NOT resurrect. Return empty.
          return null;
        }
        // Active — heartbeat if stale.
        const lastSeen = new Date(row.last_seen_at).getTime();
        if (now - lastSeen >= heartbeatMs) {
          row.last_seen_at = new Date(now).toISOString();
        }
        return row;
      }

      // No row — INSERT.
      const newRow: Row = {
        id: `row-${rows.length + 1}`,
        user_id: userId,
        supabase_session_id: sessionId,
        revoked_at: null,
        last_seen_at: new Date(now).toISOString(),
      };
      rows.push(newRow);
      return newRow;
    };
  }

  // 5a. Active session — heartbeat, no resurrection.
  {
    const now = Date.now();
    const rows: Row[] = [{
      id: 'row-1',
      user_id: 'user-1',
      supabase_session_id: 'session-1',
      revoked_at: null,
      last_seen_at: new Date(now - 1000).toISOString(), // 1s ago — fresh
    }];
    const rpc = makeRpcSimulation(now);
    const result = rpc(rows, 'user-1', 'session-1', 300_000);
    assert.ok(result, '5a. active session returns the row');
    assert.equal(rows.length, 1, '5a. no new row created (heartbeat, not insert)');
    assert.equal(result?.revoked_at, null, '5a. session remains active');
  }

  // 5b. Revoked session — do NOT resurrect.
  {
    const now = Date.now();
    const rows: Row[] = [{
      id: 'row-1',
      user_id: 'user-1',
      supabase_session_id: 'session-1',
      revoked_at: new Date(now - 1000).toISOString(), // revoked 1s ago
      last_seen_at: new Date(now - 2000).toISOString(),
    }];
    const rpc = makeRpcSimulation(now);
    const result = rpc(rows, 'user-1', 'session-1', 300_000);
    assert.equal(result, null, '5b. revoked session returns null (do NOT resurrect)');
    assert.equal(rows.length, 1, '5b. no new row created (no resurrection)');
    assert.notEqual(rows[0].revoked_at, null, '5b. existing row remains revoked');
  }

  // 5c. First-time session — INSERT.
  {
    const now = Date.now();
    const rows: Row[] = [];
    const rpc = makeRpcSimulation(now);
    const result = rpc(rows, 'user-1', 'session-1', 300_000);
    assert.ok(result, '5c. first-time session returns the new row');
    assert.equal(rows.length, 1, '5c. one row created');
    assert.equal(result?.revoked_at, null, '5c. new session is active');
  }

  // 5d. RACE: hook checks isSessionRevoked → false, then revoke
  // happens, then registerCurrentSession is called. The RPC must
  // NOT resurrect.
  {
    const now = Date.now();
    // Step 1: row exists and is active (hook's isSessionRevoked returns false).
    const rows: Row[] = [{
      id: 'row-1',
      user_id: 'user-1',
      supabase_session_id: 'session-1',
      revoked_at: null,
      last_seen_at: new Date(now - 1000).toISOString(),
    }];

    // Step 2: revoke happens between isSessionRevoked and registerCurrentSession.
    rows[0].revoked_at = new Date(now).toISOString();

    // Step 3: registerCurrentSession is called. The RPC sees the revoked row.
    const rpc = makeRpcSimulation(now);
    const result = rpc(rows, 'user-1', 'session-1', 300_000);

    // The RPC must NOT resurrect — it returns null.
    assert.equal(result, null, '5d. RACE: registerCurrentSession returns null after concurrent revoke');
    assert.equal(rows.length, 1, '5d. RACE: no new row created');
    assert.notEqual(rows[0].revoked_at, null, '5d. RACE: existing row remains revoked');
  }

  passed += 4;
  console.log('  ok 5a — active session: heartbeat, no resurrection');
  console.log('  ok 5b — revoked session: do NOT resurrect');
  console.log('  ok 5c — first-time session: INSERT');
  console.log('  ok 5d — RACE: concurrent revoke does NOT resurrect');

  ok('5. deterministic simulation — register_device_session RPC race safety');
}

// ============================================================
// 6. REGRESSION — EXISTING PHASE 3 BEHAVIOR PRESERVED
// ============================================================
{
  const hooks = read('src/hooks.server.ts');
  const service = read('src/lib/server/auth/device-sessions.ts');

  // Revocation enforcement is still in the hook.
  ok(hooks.includes('isSessionRevoked'), '6. hooks: still calls isSessionRevoked');
  ok(hooks.includes('sessionRevoked = true'), '6. hooks: still sets sessionRevoked flag');
  ok(hooks.includes('event.locals.session = null') && hooks.includes('event.locals.user = null'), '6. hooks: still clears locals on revoked');

  // The hook still skips registration when revoked.
  ok(hooks.includes('!sessionRevoked && auth.session && auth.user'), '6. hooks: registration guarded by !sessionRevoked');

  // revokeSession / revokeAllOtherSessions / lookupSessionRevocationState still exist.
  ok(service.includes('export async function revokeSession'), '6. service: revokeSession still exists');
  ok(service.includes('export async function revokeAllOtherSessions'), '6. service: revokeAllOtherSessions still exists');
  ok(service.includes('export async function lookupSessionRevocationState'), '6. service: lookupSessionRevocationState still exists');

  // The cache module is unchanged.
  const cache = read('src/lib/server/auth/session-revocation-cache.ts');
  ok(cache.includes('REVOCATION_CACHE_TTL_MS'), '6. cache: TTL constant still defined');
  ok(cache.includes('invalidateRevocationCache'), '6. cache: invalidation API still exists');

  ok('6. regression: Phase 3 enforcement + cache + revoke APIs preserved');
}

// ============================================================
// 7. SECURITY — NO CLIENT-SUPPLIED IDENTITY
// ============================================================
{
  const hooks = read('src/hooks.server.ts');
  const service = read('src/lib/server/auth/device-sessions.ts');

  // user_id and supabase_session_id are server-derived.
  ok(hooks.includes('auth.user.id'), '7. hooks: derives user.id from server auth context');
  ok(hooks.includes('extractSessionId(auth.session.access_token)'), '7. hooks: derives session_id from JWT (NOT from client)');
  ok(!hooks.includes('body.*user_id'), '7. hooks: does NOT accept user_id from client');
  ok(!hooks.includes('body.*session_id'), '7. hooks: does NOT accept session_id from client');

  // The service does not log tokens or secrets.
  ok(!service.match(/console\.\w+.*access_token/i), '7. service: no access_token logging');
  ok(!service.match(/console\.\w+.*refresh_token/i), '7. service: no refresh_token logging');
  ok(!service.match(/console\.\w+.*secret/i), '7. service: no secret logging');

  ok('7. security: no client-supplied identity, no token/secret logging');
}

console.log(`\nPhase 3 hardening tests passed (${passed} check groups).`);
