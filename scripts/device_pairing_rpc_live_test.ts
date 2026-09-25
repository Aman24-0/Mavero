// ============================================================================
// DEVICE-PAIRING RPC LIVE REGRESSION TEST (embedded PostgreSQL)
// ============================================================================
// Applies the REAL device migration chain — verbatim, from
// supabase/migrations — to an in-process PostgreSQL engine
// (@electric-sql/pglite: PostgreSQL compiled to WASM; identical
// plpgsql/SQL semantics) and verifies:
//
//   PHASE 1 (teeth — the production incident, reproduced):
//     * claim_device_pairing(repeat('0',64),30000,5) raises SQLSTATE 42702
//       "column reference 'id' is ambiguous" — the exact production error
//       behind claim-rpc-failed (requestId e8fb94ed-bb64-46b8-a5bb-6a3b17088f92)
//     * register_device_session raises 42702 (user_id) — the same defect
//       class that silently killed the account session registry
//     * make_interval(ms => …) raises 42883 — the SECOND, masked bug in the
//       original claim body (invisible in production because 42702 fired first)
//     * failed calls mutate no state
//
//   PHASE 2: the fix migration (20261004000000) applies cleanly.
//
//   PHASE 3 (fixed behavior):
//     * impossible hash → 0 rows (NOT 42702) for claim; complete/release/fail
//       dry-calls → 0 rows
//     * full lease state machine: approved → exchanging (credential KEPT,
//       lease set, attempts incremented) → lease-busy second claim →
//       release → approved → re-claim → complete → consumed (credential
//       cleared) → replay-protected
//     * fail path (terminal), attempt cap (5), lease-expiry takeover,
//       pending/expired ineligible, p_now default
//     * register_device_session: insert / heartbeat-throttle / heartbeat /
//       revoked-no-resurrection
//     * security posture: SECURITY DEFINER + search_path=public preserved,
//       signatures + defaults unchanged (wire contract), single claim
//       overload (no 2-arg ghost), EXECUTE granted to service_role ONLY
//       (revoked from PUBLIC/anon/authenticated)
//
// This test would have caught the production bug BEFORE deploy: Phase 1 is
// the pre-fix state of the shipped migration files. Any future migration
// that reintroduces an OUT-parameter/table-column collision in these
// functions fails here at the exact SQL statement.
// ============================================================================

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';

let passed = 0;
function ok(condition: unknown, label: string, hint?: string) {
  assert.ok(condition, hint ? `${label} (${hint})` : label);
  passed += 1;
  console.log(`  ok ${passed} - ${label}`);
}

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative: string) => readFileSync(path.join(REPO_ROOT, relative), 'utf8');

type Row = Record<string, unknown>;
type QResult = { ok: true; rows: Row[] } | { ok: false; code: string | null; message: string };

const CHAIN = [
  '20260927000000_device_sessions.sql',
  '20260928000000_device_pairing_requests.sql',
  '20260929000000_device_pairing_claim_rpc.sql',
  '20260930000000_register_device_session_rpc.sql',
  '20261003000000_device_pairing_exchange_lease.sql',
] as const;
const FIX_MIGRATION = '20261004000000_device_rpc_ambiguous_column_fix.sql';

const ZERO64 = '0'.repeat(64);
const A64 = 'a'.repeat(64);
const B64 = 'b'.repeat(64);
const C64 = 'c'.repeat(64);
const D64 = 'd'.repeat(64);
const E64 = 'e'.repeat(64);
const F64 = 'f'.repeat(64);
const G64 = 'g'.repeat(64);
const ZERO_UUID = '00000000-0000-0000-0000-000000000000';

async function main() {
  const db = new PGlite();
  const exec = (sql: string) => db.exec(sql);
  async function tryQ(sql: string): Promise<QResult> {
    try {
      const res = await db.query<Row>(sql);
      return { ok: true, rows: (res.rows ?? []) as Row[] };
    } catch (e) {
      const err = e as { code?: string; message?: string };
      return { ok: false, code: err.code ?? null, message: String(err.message ?? e) };
    }
  }
  const rows = (r: QResult): Row[] => (r.ok ? r.rows : assert.fail(`query failed: ${r.code} ${r.message}`));

  // ── Harness: auth stub + client roles (Supabase environment stand-ins) ──
  await exec(`
    create schema if not exists auth;
    create table if not exists auth.users (id uuid primary key);
    create or replace function auth.uid() returns uuid language sql as $$ select null::uuid $$;
    do $h$
    begin
      if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
      if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon; end if;
      if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role; end if;
    end
    $h$;
  `);

  console.log('device_pairing_rpc_live_test (embedded PostgreSQL)');
  console.log('0. real migration chain applies cleanly');

  for (const file of CHAIN) {
    let err: unknown = null;
    try { await exec(read(path.join('supabase', 'migrations', file))); } catch (e) { err = e; }
    ok(err === null, `migration ${file} applies cleanly`, err instanceof Error ? err.message : undefined);
  }

  // ── PHASE 1: reproduce the production incident on the PRE-FIX state ──
  console.log('1. production incident reproduced (pre-fix definitions)');

  await exec(`insert into public.device_pairing_requests
    (secret_hash, short_code, status, exchange_code, expires_at)
    values ('${A64}', 'AAAA1111', 'approved', 'cred-A', now() + interval '5 minutes')`);

  {
    const claim = await tryQ(`select * from public.claim_device_pairing(repeat('0', 64), 30000, 5)`);
    ok(claim.ok === false, 'pre-fix claim_device_pairing(repeat(\'0\',64)) RAISES (the production failure)');
    ok(claim.ok === false && claim.code === '42702', 'error is SQLSTATE 42702', `got ${claim.ok ? 'no error' : claim.code}`);
    ok(claim.ok === false && /ambiguous/i.test(claim.message), 'message is the ambiguous column reference error', claim.ok ? '' : claim.message.slice(0, 120));
    ok(claim.ok === false && /\bid\b/i.test(claim.message), 'ambiguous name is "id" (the OUT-parameter collision)', claim.ok ? '' : claim.message.slice(0, 120));

    const claimReal = await tryQ(`select * from public.claim_device_pairing('${A64}', 30000, 5)`);
    ok(claimReal.ok === false && claimReal.code === '42702',
      'pre-fix claim fails identically on a REAL approved row (input-independent)', claimReal.ok ? 'no error' : claimReal.code);

    const reg = await tryQ(`select * from public.register_device_session(
      '00000000-0000-0000-0000-0000000000aa'::uuid,
      '00000000-0000-0000-0000-0000000000bb'::uuid,
      'dev', 'desktop', 'Laptop', 'Chrome', 'Windows', 'Windows', 'hash')`);
    ok(reg.ok === false && reg.code === '42702', 'pre-fix register_device_session raises 42702 (session registry was silently dead)', reg.ok ? 'no error' : reg.code);
    ok(reg.ok === false && /user_id/i.test(reg.message), 'register ambiguity is "user_id" (OUT parameter vs column)', reg.ok ? '' : reg.message.slice(0, 120));

    const ms = await tryQ(`select make_interval(ms => 1)`);
    ok(ms.ok === false && ms.code === '42883',
      'make_interval(ms => …) is INVALID SQL (no ms parameter) — the second, masked bug in claim Step 3', ms.ok ? 'no error' : ms.code);

    const state = rows(await tryQ(`select status, exchange_attempts, exchange_code,
      (exchange_lease_until is null) as lease_null, (exchange_claimed_at is null) as claimed_null
      from public.device_pairing_requests where secret_hash = '${A64}'`));
    ok(state.length === 1 && state[0].status === 'approved' && state[0].exchange_attempts === 0
      && state[0].exchange_code === 'cred-A' && state[0].lease_null === true && state[0].claimed_null === true,
      'failed claims mutated NOTHING (row still approved, untouched — no partial writes)');
    const sessions = rows(await tryQ(`select count(*)::int as n from public.device_sessions`));
    ok(sessions[0].n === 0, 'failed register call inserted nothing');
  }

  // ── PHASE 2: apply the fix migration ──
  console.log('2. fix migration applies cleanly');
  {
    let err: unknown = null;
    try { await exec(read(path.join('supabase', 'migrations', FIX_MIGRATION))); } catch (e) { err = e; }
    ok(err === null, `migration ${FIX_MIGRATION} applies cleanly`, err instanceof Error ? err.message : undefined);
  }

  // ── PHASE 3: fixed behavior ──
  console.log('3. impossible-hash probes: 0 rows, never 42702');
  {
    const c1 = await tryQ(`select * from public.claim_device_pairing(repeat('0', 64), 30000, 5)`);
    ok(c1.ok === true, 'claim_device_pairing(repeat(\'0\',64)) EXECUTES (no 42702)');
    ok(c1.ok && c1.rows.length === 0, 'claim returns 0 rows for the impossible hash');
    const c2 = await tryQ(`select * from public.claim_device_pairing('${ZERO64}')`);
    ok(c2.ok === true && c2.rows.length === 0, 'claim with defaults only (p_now default intact) returns 0 rows');
    const c3 = await tryQ(`select * from public.claim_device_pairing('${ZERO64}', 30000, 5, now())`);
    ok(c3.ok === true && c3.rows.length === 0, 'claim with explicit p_now returns 0 rows');

    for (const [fn, label] of [
      [`select * from public.complete_device_pairing('${ZERO64}', '${ZERO_UUID}')`, 'complete_device_pairing'],
      [`select * from public.release_device_pairing_exchange('${ZERO64}', '${ZERO_UUID}')`, 'release_device_pairing_exchange'],
      [`select * from public.fail_device_pairing('${ZERO64}', '${ZERO_UUID}')`, 'fail_device_pairing'],
    ] as const) {
      const r = await tryQ(fn);
      ok(r.ok === true && r.rows.length === 0, `${label} impossible inputs → 0 rows (no 42702)`, r.ok ? '' : `${r.code} ${r.message.slice(0, 100)}`);
    }
  }

  console.log('4. full approved pairing through the lease state machine');
  {
    // claim A → exchanging, credential kept, lease set, attempts 1
    const claimA = await tryQ(`select * from public.claim_device_pairing('${A64}', 30000, 5)`);
    ok(claimA.ok === true, 'claim on real approved row EXECUTES (42702 gone)');
    ok(claimA.ok && claimA.rows.length === 1, 'claim returns exactly 1 row');
    ok(claimA.ok && claimA.rows[0].exchange_code === 'cred-A', 'claim returns the stored one-time credential (OLD value semantics)');
    ok(claimA.ok && claimA.rows[0].exchange_attempts === 1, 'claim reports exchange_attempts = 1');
    const aid = claimA.ok ? String(claimA.rows[0].id) : '';

    const st = rows(await tryQ(`select
  status,
  exchange_attempts,
  exchange_code,
  exchange_lease_until,
  now() as current_now,
  extract(epoch from (exchange_lease_until - now())) as lease_delta_seconds,
  (exchange_lease_until > now()) as lease_active,
  (exchange_lease_until < now() + interval '60 seconds') as lease_bounded,
  (exchange_claimed_at is not null) as claimed
  from public.device_pairing_requests
  where secret_hash = '${A64}'`));

console.log('LEASE DEBUG:', st[0]);
    ok(st[0].status === 'exchanging' && st[0].exchange_attempts === 1 && st[0].exchange_code === 'cred-A',
      'row: approved → exchanging, attempts 1, credential KEPT');
    ok(st[0].lease_active === true && st[0].lease_bounded === true, 'lease is active and bounded (≈30s)');
    ok(st[0].claimed === true, 'exchange_claimed_at recorded');

    // lease-busy second claim → 0 rows
    const busy = await tryQ(`select * from public.claim_device_pairing('${A64}', 30000, 5)`);
    ok(busy.ok === true && busy.rows.length === 0, 'second claim while lease is ACTIVE → 0 rows (lease busy)');

    // release → approved, lease cleared, credential kept
    const rel = await tryQ(`select * from public.release_device_pairing_exchange('${A64}', '${aid}')`);
    ok(rel.ok === true && rel.rows.length === 1, 'release returns the pairing id');
    const stRel = rows(await tryQ(`select status, exchange_code, (exchange_lease_until is null) as lease_null
      from public.device_pairing_requests where secret_hash = '${A64}'`));
    ok(stRel[0].status === 'approved' && stRel[0].lease_null === true && stRel[0].exchange_code === 'cred-A',
      'release: exchanging → approved, lease cleared, credential KEPT for retry');

    // re-claim → attempts 2 → complete → consumed
    const claimA2 = await tryQ(`select * from public.claim_device_pairing('${A64}', 30000, 5)`);
    ok(claimA2.ok === true && claimA2.rows.length === 1 && claimA2.rows[0].exchange_attempts === 2,
      're-claim after release → same credential, attempts 2');
    const comp = await tryQ(`select * from public.complete_device_pairing('${A64}', '${aid}')`);
    ok(comp.ok === true && comp.rows.length === 1, 'complete returns the pairing id');
    const stComp = rows(await tryQ(`select status, exchange_code, (consumed_at is not null) as consumed, (exchange_lease_until is null) as lease_null
      from public.device_pairing_requests where secret_hash = '${A64}'`));
    ok(stComp[0].status === 'consumed' && stComp[0].consumed === true && stComp[0].lease_null === true,
      'complete: exchanging → consumed, consumed_at set, lease cleared');
    ok(stComp[0].exchange_code === null, 'complete CLEARS the one-time credential (one-time use)');

    const replay = await tryQ(`select * from public.claim_device_pairing('${A64}', 30000, 5)`);
    ok(replay.ok === true && replay.rows.length === 0, 'claim after consumption → 0 rows (replay protection)');

    const wrongId = await tryQ(`select * from public.complete_device_pairing('${B64}', '${aid}')`);
    ok(wrongId.ok === true && wrongId.rows.length === 0, 'complete with wrong pairing id → 0 rows (claim-cycle binding)');
  }

  console.log('5. fail path / attempt cap / lease takeover / ineligible states');
  {
    // fail path
    await exec(`insert into public.device_pairing_requests (secret_hash, short_code, status, exchange_code, expires_at)
      values ('${B64}', 'BBBB2222', 'approved', 'cred-B', now() + interval '5 minutes')`);
    const cb = await tryQ(`select * from public.claim_device_pairing('${B64}', 30000, 5)`);
    const bid = cb.ok ? String(cb.rows[0].id) : '';
    ok(cb.ok === true && cb.rows.length === 1, 'claim B succeeds');
    const fb = await tryQ(`select * from public.fail_device_pairing('${B64}', '${bid}')`);
    ok(fb.ok === true && fb.rows.length === 1, 'fail returns the pairing id');
    const stB = rows(await tryQ(`select status, exchange_code, (consumed_at is not null) as consumed
      from public.device_pairing_requests where secret_hash = '${B64}'`));
    ok(stB[0].status === 'failed' && stB[0].exchange_code === null && stB[0].consumed === true,
      'fail: exchanging → failed (terminal), credential cleared');
    const cb2 = await tryQ(`select * from public.claim_device_pairing('${B64}', 30000, 5)`);
    ok(cb2.ok === true && cb2.rows.length === 0, 'claim after fail → 0 rows (terminal state)');

    // lease-expiry takeover
    await exec(`insert into public.device_pairing_requests (secret_hash, short_code, status, exchange_code, expires_at)
      values ('${C64}', 'CCCC3333', 'exchanging', 'cred-C', now() + interval '5 minutes')`);
    await exec(`update public.device_pairing_requests set exchange_lease_until = now() - interval '1 second',
      exchange_claimed_at = now() - interval '1 second', exchange_attempts = 2 where secret_hash = '${C64}'`);
    const cc = await tryQ(`select * from public.claim_device_pairing('${C64}', 30000, 5)`);
    ok(cc.ok === true && cc.rows.length === 1, 'claim on an EXPIRED lease takes over');
    ok(cc.ok && cc.rows[0].exchange_code === 'cred-C' && cc.rows[0].exchange_attempts === 3,
      'takeover returns the SAME credential, attempts 2 → 3');
    const stC = rows(await tryQ(`select status, (exchange_lease_until > now()) as lease_active
      from public.device_pairing_requests where secret_hash = '${C64}'`));
    ok(stC[0].status === 'exchanging' && stC[0].lease_active === true, 'takeover re-arms the lease');

    // attempt cap
    await exec(`insert into public.device_pairing_requests (secret_hash, short_code, status, exchange_code, expires_at, exchange_attempts)
      values ('${D64}', 'DDDD4444', 'approved', 'cred-D', now() + interval '5 minutes', 5)`);
    const cd = await tryQ(`select * from public.claim_device_pairing('${D64}', 30000, 5)`);
    ok(cd.ok === true && cd.rows.length === 0, 'claim at the attempt cap (5) → 0 rows');
    const stD = rows(await tryQ(`select status, exchange_code from public.device_pairing_requests where secret_hash = '${D64}'`));
    ok(stD[0].status === 'failed' && stD[0].exchange_code === null, 'attempt-capped row flips to failed, credential cleared');

    // pending / expired / cancelled ineligible
    await exec(`insert into public.device_pairing_requests (secret_hash, short_code, status, exchange_code, expires_at) values
      ('${E64}', 'EEEE5555', 'pending', null, now() + interval '5 minutes'),
      ('${F64}', 'FFFF6666', 'approved', 'cred-F', now() - interval '1 second'),
      ('${G64}', 'GGGG7777', 'cancelled', null, now() + interval '5 minutes')`);
    for (const [hash, why] of [[E64, 'pending'], [F64, 'expired'], [G64, 'cancelled']] as const) {
      const r = await tryQ(`select * from public.claim_device_pairing('${hash}', 30000, 5)`);
      ok(r.ok === true && r.rows.length === 0, `claim on ${why} row → 0 rows`);
    }
    const stE = rows(await tryQ(`select status, exchange_attempts from public.device_pairing_requests where secret_hash = '${E64}'`));
    ok(stE[0].status === 'pending' && stE[0].exchange_attempts === 0, 'ineligible claim attempts leave the row untouched');
  }

  console.log('6. register_device_session fixed (atomic registry upsert)');
  {
    const U = '00000000-0000-0000-0000-0000000000aa';
    const S = '00000000-0000-0000-0000-0000000000bb';
    // device_sessions.user_id is FK-bound to auth.users — create the user
    // in the auth stub first (mirrors a real Supabase user).
    await exec(`insert into auth.users (id) values ('${U}')`);
    const call = `select * from public.register_device_session('${U}', '${S}', 'dev-id', 'desktop', 'Laptop', 'Chrome', 'Windows', 'Windows', 'iph')`;

    const r1 = await tryQ(call);
    ok(r1.ok === true, 'register EXECUTES (no 42702)');
    ok(r1.ok && r1.rows.length === 1 && r1.rows[0].registered === true, 'fresh session INSERTs (registered = true)');
    ok(r1.ok && r1.rows[0].user_id === U && r1.rows[0].device_type === 'desktop', 'returned row matches the input identity');
    const firstSeen = r1.ok ? String(r1.rows[0].last_seen_at) : '';

    const cnt1 = rows(await tryQ(`select count(*)::int as n from public.device_sessions`));
    ok(cnt1[0].n === 1, 'exactly one registry row');

    const r2 = await tryQ(call);
    ok(r2.ok === true && r2.rows.length === 1 && r2.rows[0].registered === false,
      'second call within the 5-minute heartbeat window → registered = false (no write)');
    ok(r2.ok && String(r2.rows[0].last_seen_at) === firstSeen, 'heartbeat THROTTLED (last_seen_at unchanged)');
    const cnt2 = rows(await tryQ(`select count(*)::int as n from public.device_sessions`));
    ok(cnt2[0].n === 1, 'still exactly one registry row');

    await exec(`update public.device_sessions set last_seen_at = now() - interval '10 minutes' where user_id = '${U}'`);
    const r3 = await tryQ(call);
    ok(r3.ok === true && r3.rows.length === 1 && r3.rows[0].registered === false, 'stale session heartbeats (registered = false)');
    const beatFresh = rows(await tryQ(`select (last_seen_at > now() - interval '1 minute') as fresh,
      (last_seen_at::text) as seen from public.device_sessions where user_id = '${U}'`));
    ok(beatFresh[0].fresh === true, 'heartbeat updated last_seen_at to a FRESH timestamp', String(beatFresh[0].seen));
    const cnt3 = rows(await tryQ(`select count(*)::int as n from public.device_sessions`));
    ok(cnt3[0].n === 1, 'heartbeat does not duplicate rows');

    await exec(`update public.device_sessions set revoked_at = now() where user_id = '${U}'`);
    const r4 = await tryQ(call);
    ok(r4.ok === true && r4.rows.length === 0, 'revoked session → 0 rows (NO resurrection)');
    const stR = rows(await tryQ(`select count(*)::int as n, count(revoked_at)::int as revoked from public.device_sessions`));
    ok(stR[0].n === 1 && stR[0].revoked === 1, 'revoked row stays revoked, no new row created');
  }

  console.log('7. security posture + wire contract preserved');
  {
    const sec = rows(await tryQ(`
      select count(*)::int as n from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
        and p.proname in ('claim_device_pairing', 'complete_device_pairing',
                          'release_device_pairing_exchange', 'fail_device_pairing',
                          'register_device_session')
        and p.prosecdef = true
        and 'search_path=public' = any(p.proconfig)`));
    ok(sec[0].n === 5, 'all five RPCs: SECURITY DEFINER + search_path = public preserved');

    const overloads = rows(await tryQ(`select count(*)::int as n from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'claim_device_pairing'`));
    ok(overloads[0].n === 1, 'exactly ONE claim_device_pairing (old 2-arg overload stays dropped)');

    const idArgs = rows(await tryQ(`
      select p.proname, pg_get_function_identity_arguments(p.oid) as args
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
        and p.proname in ('claim_device_pairing', 'complete_device_pairing',
                          'release_device_pairing_exchange', 'fail_device_pairing',
                          'register_device_session') order by p.proname`));
    const argsByName: Record<string, string> = {};
    for (const r of idArgs) argsByName[String(r.proname)] = String(r.args);
    ok(argsByName['claim_device_pairing'] === 'p_secret_hash text, p_lease_ms integer, p_max_attempts integer, p_now timestamp with time zone',
      'claim signature unchanged (PostgREST named-arg wire contract)', argsByName['claim_device_pairing']);
    ok(argsByName['complete_device_pairing'] === 'p_secret_hash text, p_pairing_id uuid, p_now timestamp with time zone',
      'complete signature unchanged', argsByName['complete_device_pairing']);
    ok(argsByName['release_device_pairing_exchange'] === 'p_secret_hash text, p_pairing_id uuid',
      'release signature unchanged', argsByName['release_device_pairing_exchange']);
    ok(argsByName['fail_device_pairing'] === 'p_secret_hash text, p_pairing_id uuid, p_now timestamp with time zone',
      'fail signature unchanged', argsByName['fail_device_pairing']);
    ok(argsByName['register_device_session'] ===
      'p_user_id uuid, p_supabase_session_id uuid, p_device_id text, p_device_type text, p_device_name text, p_browser text, p_os text, p_platform text, p_ip_hash text, p_heartbeat_interval_ms integer, p_now timestamp with time zone',
      'register signature unchanged', argsByName['register_device_session']);

    const fullArgs = rows(await tryQ(`
      select pg_get_function_arguments(p.oid) as args
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'claim_device_pairing'`));
    const fa = String(fullArgs[0].args);
    ok(fa.includes('p_lease_ms integer DEFAULT 30000') && fa.includes('p_max_attempts integer DEFAULT 5')
      && fa.toLowerCase().includes("p_now timestamp with time zone default timezone('utc'::text, now())"),
      'claim DEFAULTS preserved (30000 / 5 / timezone utc now)', fa);

    const acl = rows(await tryQ(`
      select
        count(*) filter (where has_function_privilege('service_role', p.oid::text, 'EXECUTE')) as svc,
        count(*) filter (where has_function_privilege('anon', p.oid::text, 'EXECUTE')) as anon,
        count(*) filter (where has_function_privilege('authenticated', p.oid::text, 'EXECUTE')) as auth,
        count(*) filter (where has_function_privilege('public', p.oid::text, 'EXECUTE')) as pub
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
        and p.proname in ('claim_device_pairing', 'complete_device_pairing',
                          'release_device_pairing_exchange', 'fail_device_pairing',
                          'register_device_session')`));
    ok(acl[0].svc === 5, 'service_role has EXECUTE on all five RPCs');
    ok(acl[0].anon === 0 && acl[0].auth === 0 && acl[0].pub === 0,
      'EXECUTE revoked from anon / authenticated / PUBLIC on all five (privilege lockdown intact)');
  }

  await db.close().catch(() => undefined as unknown as void);
  console.log(`\nPASS: device_pairing_rpc_live_test — ${passed} checks`);
}

main().catch((e) => {
  console.error(`\nFAIL: device_pairing_rpc_live_test — after ${passed} checks`);
  console.error(e instanceof Error ? e.stack : e);
  process.exit(1);
});
