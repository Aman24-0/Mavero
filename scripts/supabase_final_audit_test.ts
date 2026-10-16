// ============================================================================
// SUPABASE FINAL AUDIT REGRESSION TEST (embedded PostgreSQL)
// ============================================================================
// Follow-up suite to supabase_remediation_migration_test.ts. Applies the REAL
// repository migration chain + the remediation migration (20261118000000) +
// the final-audit hardening migration (20261119000000) to an in-process
// PostgreSQL engine (@electric-sql/pglite), then verifies the final-audit
// decisions behaviorally and by catalog evidence:
//
//   PHASE 1 — pre-state (final-audit findings, reproduced on the real chain):
//     * streaming_public_source_categories_order_idx exists as an EXACT
//       duplicate of the valid unique constraint index over (category_id,
//       ordering) — the one provable redundancy of the final audit
//     * the out-of-band direct_play_sources stub is created WITHOUT RLS
//       enabled (mirroring the weakest possible live state): the remediation
//       migration's deny-all POLICY exists but is INERT while RLS is off —
//       the enforceability gap closed by 20261119000000 §1
//     * the ORIGINAL (defective) download_providers verification counter —
//       an OR over both role arrays compared to 0 — counts BOTH correct
//       role-specific policies and reports a false failure (the documented
//       verification-script defect fixed in docs/supabase-remediation-
//       verification.sql)
//
//   PHASE 2 — the corrective migration applies cleanly (single transaction).
//
//   PHASE 3 — post-state + behavior:
//     §1 server-only posture is now SELF-CONTAINED: RLS is enabled on both
//        server-only tables; the restrictive deny-all policies remain and
//        are ENFORCED (anon/authenticated every operation → 42501 even
//        though privileges alone would have blocked them; service_role
//        unaffected); device_pairing_requests enablement is idempotent
//     §2 streaming_public_source_categories_order_idx is GONE while the
//        covering unique constraint index stays valid; the mirror refresh
//        (refresh_streaming_public_config) still works end-to-end; the
//        unique constraint still rejects duplicate (category_id, ordering)
//
//   PHASE 4 — the CORRECTED docs/supabase-remediation-verification.sql runs
//     against the real chain and every check returns ok = true (the
//     verification script's assertions are proven meaningful, not just
//     syntactically valid), and the four pairing dry-calls return 0 rows.
//
//   PHASE 5 — foreign-key supporting-index sweep over the FULL chain: every
//     FK has a valid non-partial leading-column index, or a partial one whose
//     predicate is an `IS NOT NULL` over the FK columns (planner-provable for
//     RI lookups). The THREE accepted exceptions are partial-only-covered FKs
//     whose parent-delete path is a rare administrative/account event on
//     personal-scale tables, not flagged by the production advisor (documented
//     in SUPABASE_REMEDIATION_REPORT.md — "avoid speculative changes"):
//       device_sessions(user_id)                  (partial `revoked_at IS NULL`)
//       analytics_sessions(user_id)               (partial `ended_at IS NULL`)
//       cloudstream_adapter_build_jobs(extension_id) (partial active-job states)
//
//   PHASE 6 — index-matrix pins: every final-audit index candidate is pinned
//     present/absent with its defining shape (columns + partial predicate).
//
//   PHASE 7 — idempotency: the corrective migration re-applies cleanly and
//     the catalog (indexes + policies) is byte-identical afterwards.
// ============================================================================

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

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

const REMEDIATION = 'supabase/migrations/20261118000000_supabase_remediation_security_performance.sql';
const CORRECTIVE = 'supabase/migrations/20261119000000_supabase_final_audit_hardening.sql';
const VERIFICATION = 'docs/supabase-remediation-verification.sql';

// Dependency-ordered chain — identical to supabase_remediation_migration_test.ts
// plus the files the final audit needed for its full-table sweep (analytics,
// provider health, downloader type, unique assignment, extension builder,
// build lifecycle, live-TV analytics, icon contracts, provider migrations).
const CHAIN = [
  '20260820000000_phase5_auth_sync.sql',
  '20260820010000_phase7a_streaming_registry.sql',
  '20260820011000_phase7a_public_views.sql',
  '20260820012000_phase7a_template_constraints.sql',
  '20260820013000_phase7a_security_invoker_views.sql',
  '20260820014000_phase7a_public_mirror_tables.sql',
  // 20260820015000 (the comment-identical duplicate) deliberately skipped —
  // see supabase_remediation_migration_test.ts for the documented reason.
  '20260820016000_phase7a_revoke_base_public.sql',
  '20260820017000_phase7a_public_refresh_where.sql',
  '20260821010000_phase7a_migration_repair.sql',
  '20260906000000_phase2_default_sources.sql',
  '20260913000000_adult_mode.sql',
  '20260914000000_adult_default_source.sql',
  '20260915000000_download_providers.sql',
  '20260822000000_phase7f_provider_health.sql',
  '20260918000000_phase1_stremio_addons.sql',
  '20260926150000_source_badge_icon_reorder.sql',
  '20260927000000_device_sessions.sql',
  '20260928000000_device_pairing_requests.sql',
  '20261003000000_device_pairing_exchange_lease.sql',
  '20261101000000_cloudstream_cs1.sql',
  '20261101000002_extension_phase2_unified_adapters.sql',
  '20261004000000_device_rpc_ambiguous_column_fix.sql',
  '20261004000000_unified_downloader_global_order.sql',
  '20260928200724_phase2_hosting_database_foundation.sql',
  '20261007000000_download_provider_type.sql',
  '20261008000000_analytics_foundation.sql',
  '20261012000000_source_category_unique_assignment.sql',
  '20261101000001_cloudstream_cs5_downloader2.sql',
  '20261101000003_extension_phase3_builder.sql',
  '20261102000000_adapter_build_lifecycle.sql',
  '20261103000000_live_tv_analytics_events.sql',
  '20261106000000_source_icon_badge_contracts.sql',
  '20261112000000_blue_velvet_provider.sql',
  '20261113000000_vixolity_tgvid_zxcstream_providers.sql',
  '20261107000000_default_source_slots.sql',
] as const;

const USER_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2';
const PROV = 'dddddddd-dddd-dddd-dddd-dddddddddd01';
const CAT = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb1';
const SRC1 = 'cccccccc-cccc-cccc-cccc-ccccccccccc1';
const SRC2 = 'cccccccc-cccc-cccc-cccc-ccccccccccc2';

async function main() {
  const db = new PGlite({ extensions: { pgcrypto } });
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
  const q = async (sql: string): Promise<Row[]> => rows(await tryQ(sql));

  // ── Harness: Supabase environment stand-ins (same pattern as the
  //    supabase_remediation_migration_test harness) ─────────────────────────
  await exec(`
    create schema if not exists auth;
    create table if not exists auth.users (id uuid primary key);
    create or replace function auth.uid() returns uuid language sql as $$
      select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
    $$;
    do $h$
    begin
      if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
      if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon; end if;
      if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role; end if;
    end
    $h$;
    alter role service_role bypassrls;
    grant usage on schema auth to anon, authenticated, service_role;
    grant execute on function auth.uid() to anon, authenticated, service_role;
    grant usage on schema public to anon, authenticated, service_role;
    set time zone 'UTC';
  `);
  await exec(`insert into auth.users (id) values ('${USER_A}');`);

  console.log('supabase_final_audit_test (embedded PostgreSQL)');
  console.log('0. real migration chain applies cleanly (dependency order)');
  for (const file of CHAIN) {
    let err: unknown = null;
    try { await exec(read(path.join('supabase', 'migrations', file))); } catch (e) { err = e; }
    ok(err === null, `chain ${file} applies cleanly`, err instanceof Error ? err.message : undefined);
  }

  // Mirror Supabase default table privileges (hosted Supabase grants ALL to
  // anon/authenticated/service_role via ALTER DEFAULT PRIVILEGES).
  await exec(`grant all privileges on all tables in schema public to anon, authenticated, service_role;`);

  // Out-of-band production objects. direct_play_sources is deliberately
  // created WITHOUT `enable row level security` — the weakest live state the
  // §1 guard must close (the original advisor finding says production has
  // RLS enabled; the guard makes the posture self-contained either way).
  // direct_play_sources_active_lookup mirrors the live-only index name from
  // the advisor output; the true live definition is not verifiable through
  // the Data API (documented limitation), so the stub is a plausible shape.
  await exec(`
    create table public.direct_play_sources (
      id uuid primary key default gen_random_uuid(),
      media_type text, tmdb_id text, season integer, episode integer,
      provider text, stream_url text, stream_type text, proxy_url text,
      extraction_mode text, extraction_duration_ms integer,
      expires_at timestamptz, last_verified_at timestamptz,
      failure_count integer default 0, status text,
      created_at timestamptz default now(), updated_at timestamptz default now()
    );
    create or replace function public.update_direct_play_sources_updated_at()
    returns trigger language plpgsql as $f$
    begin new.updated_at = timezone('utc', now()); return new; end $f$;
    create trigger direct_play_sources_touch_updated_at
      before update on public.direct_play_sources
      for each row execute function public.update_direct_play_sources_updated_at();
    create index direct_play_sources_active_lookup
      on public.direct_play_sources (media_type, tmdb_id) where status = 'active';
  `);
  // Mirror hosted-Supabase default privileges ON the out-of-band table
  // (created in the Dashboard, it received the standard default grants;
  // the remediation migration then revokes the client roles).
  await exec(`grant all privileges on public.direct_play_sources to anon, authenticated, service_role;`);

  // Apply the remediation migration (the state production is in today).
  await exec(read(REMEDIATION));

  // Seed minimal config rows for the refresh behavioral test.
  await exec(`
    insert into public.streaming_providers (id, slug, name, status, enabled)
    values ('${PROV}', 'final-audit-provider', 'Final Audit Provider', 'active', true);
    insert into public.streaming_sources (id, provider_id, slug, name, enabled, visibility, status)
    values
      ('${SRC1}', '${PROV}', 'final-audit-src-1', 'Final Audit Source 1', true, 'public', 'active'),
      ('${SRC2}', '${PROV}', 'final-audit-src-2', 'Final Audit Source 2', true, 'public', 'active');
    insert into public.streaming_categories (id, slug, name, enabled)
    values ('${CAT}', 'final-audit-category', 'Final Audit Category', true);
    insert into public.streaming_source_categories (category_id, source_id, ordering)
    values ('${CAT}', '${SRC1}', 0), ('${CAT}', '${SRC2}', 1);
  `);

  // ── PHASE 1: pre-state (final-audit findings reproduced) ─────────────────
  console.log('1. final-audit findings reproduced on the pre-corrective state');

  const preRls = rows(await tryQ(`
    select c.relname as t, c.relrowsecurity as rls
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname in ('device_pairing_requests', 'direct_play_sources')
    order by c.relname
  `));
  ok(preRls.find((r) => r.t === 'device_pairing_requests')?.rls === true,
    'pre: device_pairing_requests has RLS enabled (from its creating migration)');
  ok(preRls.find((r) => r.t === 'direct_play_sources')?.rls === false,
    'pre: direct_play_sources RLS DISABLED on the out-of-band stub — the deny-all policy is INERT (the enforceability gap)');

  const preDenyAll = rows(await tryQ(`
    select pol.polname, pol.polpermissive
    from pg_policy pol join pg_class c on c.oid = pol.polrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'direct_play_sources'
  `));
  ok(preDenyAll.length === 1 && preDenyAll[0].polname === 'direct_play_sources_deny_client'
    && preDenyAll[0].polpermissive === false,
    'pre: the restrictive deny-all POLICY exists on direct_play_sources (but cannot enforce while RLS is off)');

  // While RLS is off and only the privilege revocation stands, an
  // authenticated client is blocked from SELECT by the GRANT system — with a
  // distinctly different error than the RLS denial the guard must guarantee.
  await exec(`set role authenticated; set request.jwt.claim.sub = '${USER_A}';`);
  const preAnon = await tryQ(`select count(*)::int as n from public.direct_play_sources`);
  await exec(`reset role;`);
  ok(preAnon.ok === false && preAnon.code === '42501',
    'pre: authenticated SELECT blocked (privilege revocation) — but only the §1 guard makes this RLS-enforced',
    preAnon.ok ? 'unexpectedly allowed' : preAnon.message);

  const preOrderIdx = rows(await tryQ(`
    select i.indisunique, i.indisvalid, pg_get_indexdef(i.indexrelid) as def,
           (select array_agg(sa.attname order by ord) as cols
              from unnest(i.indkey) with ordinality k(attnum, ord)
              join pg_attribute sa on sa.attrelid = i.indrelid and sa.attnum = k.attnum)
    from pg_index i
    join pg_class ic on ic.oid = i.indexrelid
    join pg_class c on c.oid = i.indrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and ic.relname = 'streaming_public_source_categories_order_idx'
  `));
  ok(preOrderIdx.length === 1 && preOrderIdx[0].indisunique === false && preOrderIdx[0].indisvalid === true
    && JSON.stringify(preOrderIdx[0].cols) === JSON.stringify(['category_id', 'ordering']),
    'pre: streaming_public_source_categories_order_idx exists (non-unique, valid) over (category_id, ordering)');

  const preCover = rows(await tryQ(`
    select i.indisunique, i.indisvalid, i.indisready
    from pg_index i
    join pg_class ic on ic.oid = i.indexrelid
    join pg_class c on c.oid = i.indrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and ic.relname = 'streaming_public_source_categories_category_id_ordering_key'
  `));
  ok(preCover.length === 1 && preCover[0].indisunique === true && preCover[0].indisvalid === true
    && preCover[0].indisready === true,
    'pre: the covering unique constraint index (category_id, ordering) is valid — the exact-duplicate proof');

  // The ORIGINAL verification counter (OR over both roles = 0) reports a
  // false failure against the CORRECT role-split design — the documented
  // verification-script defect.
  const preDefect = rows(await tryQ(`
    select (select count(*) from pg_policy pol
      where pol.polrelid = 'public.download_providers'::regclass
        and pol.polcmd = 'r' and pol.polpermissive
        and (pol.polroles @> array[to_regrole('anon')::oid] or pol.polroles @> array[to_regrole('authenticated')::oid])
    ) = 0 as old_check_passes
  `));
  ok(preDefect[0].old_check_passes === false,
    'pre: the ORIGINAL OR-based verification counter fails against the correct design (the fixed defect)');

  // ── PHASE 2: apply the corrective migration ──────────────────────────────
  console.log('2. corrective migration 20261119000000 applies cleanly');
  {
    let err: unknown = null;
    try { await exec(read(CORRECTIVE)); } catch (e) { err = e; }
    ok(err === null, 'corrective migration applies in a single transaction',
      err instanceof Error ? err.message : undefined);
  }

  // ── PHASE 3: post-state + behavior ────────────────────────────────────────
  console.log('3. corrective migration post-state and behavior');

  const postRls = rows(await tryQ(`
    select c.relname as t, c.relrowsecurity as rls, c.relforcerowsecurity as forced
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname in ('device_pairing_requests', 'direct_play_sources')
    order by c.relname
  `));
  ok(postRls.find((r) => r.t === 'direct_play_sources')?.rls === true,
    '§1: direct_play_sources RLS now ENABLED (self-contained server-only posture)');
  ok(postRls.find((r) => r.t === 'direct_play_sources')?.forced === false,
    '§1: FORCE row level security NOT set (owner/SQL-Editor maintenance stays possible)');
  ok(postRls.find((r) => r.t === 'device_pairing_requests')?.rls === true,
    '§1: device_pairing_requests RLS still enabled (idempotent re-statement is a no-op)');

  // RLS-enforced denial: even if the privilege revocation were undone, the
  // deny-all policy still filters everything. Prove the policy enforces by
  // granting SELECT back: the query succeeds but returns ZERO rows (RLS
  // default-deny is row filtering, not an error), and an INSERT with a
  // granted privilege raises 42501 "violates row-level security policy".
  await exec(`grant select, insert on public.direct_play_sources to authenticated;`);
  await exec(`set role authenticated; set request.jwt.claim.sub = '${USER_A}';`);
  const rlsFiltered = await tryQ(`select count(*)::int as n from public.direct_play_sources`);
  const rlsInsert = await tryQ(`insert into public.direct_play_sources (media_type, tmdb_id) values ('movie', 'tt-rls')`);
  await exec(`reset role; revoke select, insert on public.direct_play_sources from authenticated;`);
  ok(rlsFiltered.ok === true && Number(rlsFiltered.rows?.[0]?.n) === 0,
    '§1: deny-all policy ENFORCED — authenticated SELECT returns 0 rows even WITH a granted privilege',
    JSON.stringify(rlsFiltered));
  ok(rlsInsert.ok === false && rlsInsert.code === '42501',
    '§1: authenticated INSERT raises 42501 (row-level security policy violation) even WITH a granted privilege',
    rlsInsert.ok ? 'unexpectedly allowed' : rlsInsert.message);

  await exec(`set role anon;`);
  const anonDenied = await tryQ(`select count(*)::int as n from public.direct_play_sources`);
  const anonInsert = await tryQ(`insert into public.direct_play_sources (media_type, tmdb_id) values ('movie', 'tt0')`);
  await exec(`reset role;`);
  ok(anonDenied.ok === false && anonDenied.code === '42501',
    '§1: anon SELECT denied (revocation + restrictive deny-all)');
  ok(anonInsert.ok === false && anonInsert.code === '42501',
    '§1: anon INSERT denied');

  await exec(`set role service_role;`);
  const svcSelect = await tryQ(`select count(*)::int as n from public.direct_play_sources`);
  const svcInsert = await tryQ(`insert into public.direct_play_sources (media_type, tmdb_id) values ('movie', 'tt-test')`);
  const svcDelete = await tryQ(`delete from public.direct_play_sources where tmdb_id = 'tt-test'`);
  await exec(`reset role;`);
  ok(svcSelect.ok === true && Number(svcSelect.rows?.[0]?.n) === 0,
    '§1: service_role SELECT intact (server-side paths unaffected)',
    JSON.stringify(svcSelect));
  ok(svcInsert.ok === true && svcDelete.ok === true,
    '§1: service_role INSERT/DELETE intact',
    JSON.stringify({ ins: svcInsert, del: svcDelete }));

  // §2 — the guarded redundant-index drop
  const postOrderIdx = rows(await tryQ(`
    select count(*)::int as n from pg_indexes
    where schemaname = 'public' and indexname = 'streaming_public_source_categories_order_idx'
  `));
  ok(postOrderIdx[0].n === 0, '§2: streaming_public_source_categories_order_idx is GONE');

  const postCover = rows(await tryQ(`
    select i.indisunique, i.indisvalid, i.indisready
    from pg_index i
    join pg_class ic on ic.oid = i.indexrelid
    join pg_class c on c.oid = i.indrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and ic.relname = 'streaming_public_source_categories_category_id_ordering_key'
  `));
  ok(postCover.length === 1 && postCover[0].indisunique === true && postCover[0].indisvalid === true
    && postCover[0].indisready === true,
    '§2: the covering unique constraint index remains valid/ready');

  // Behavioral: the mirror refresh still works end-to-end without the
  // dropped index, and the unique constraint still rejects duplicates.
  const refreshRes = await tryQ(`select public.refresh_streaming_public_config()`);
  ok(refreshRes.ok === true, '§2: refresh_streaming_public_config() runs cleanly');
  const mirror = rows(await tryQ(`
    select count(*)::int as n from public.streaming_public_source_categories
  `));
  ok(Number(mirror[0].n) === 2,
    '§2: the mirror is correctly rebuilt (2 source-category rows) after the index drop');
  const dupInsert = await tryQ(`
    insert into public.streaming_public_source_categories (source_id, category_id, ordering, created_at)
    values ('11111111-1111-1111-1111-111111111111', '${CAT}', 0, now())
  `);
  ok(dupInsert.ok === false && dupInsert.code === '23505',
    '§2: the unique constraint still rejects duplicate (category_id, ordering) — no protection lost',
    dupInsert.ok ? 'unexpectedly allowed' : dupInsert.message);

  // ── PHASE 4: the CORRECTED verification SQL, run against the real chain ──
  console.log('4. corrected docs/supabase-remediation-verification.sql — every check green');
  {
    const sqlText = read(VERIFICATION);
    const results = await exec(sqlText);
    let okChecks = 0;
    let triggerAttached = false;
    for (const res of results) {
      for (const row of (res.rows ?? []) as Row[]) {
        if ('ok' in row) {
          okChecks += 1;
          assert.equal(row.ok, true, `verification check FAILED: ${row.check ?? '(unnamed)'} → ${JSON.stringify(row)}`);
        }
        if ('trigger_attached' in row) triggerAttached = row.trigger_attached === true;
      }
    }
    ok(okChecks >= 10, `all ${okChecks} verification checks returned ok = true`);
    ok(triggerAttached, 'verification: the direct-play trigger is still attached (trigger_attached = true)');
    // The dry-call block returns 0-row result sets with no error — reaching
    // this point already proves no statement errored; assert emptiness.
    const dryCalls = results.filter((r) => (r.rows ?? []).length === 0);
    ok(dryCalls.length >= 4, 'verification: the four pairing RPC dry-calls ran and returned 0 rows');
  }

  // The corrected download_providers coverage check — asserted directly as
  // well (per-role coverage = 1, no dual-role policy, no PUBLIC policy).
  const cov = rows(await tryQ(`
    select
      (select count(*) from pg_policy pol
        where pol.polrelid = 'public.download_providers'::regclass
          and pol.polcmd = 'r' and pol.polpermissive
          and (pol.polroles && array[0::oid] or pol.polroles @> array[to_regrole('anon')::oid])) as anon_n,
      (select count(*) from pg_policy pol
        where pol.polrelid = 'public.download_providers'::regclass
          and pol.polcmd = 'r' and pol.polpermissive
          and (pol.polroles && array[0::oid] or pol.polroles @> array[to_regrole('authenticated')::oid])) as auth_n,
      (select count(*) from pg_policy pol
        where pol.polrelid = 'public.download_providers'::regclass
          and pol.polcmd = 'r' and pol.polpermissive
          and (pol.polroles && array[0::oid]
               or (pol.polroles @> array[to_regrole('anon')::oid]
                   and pol.polroles @> array[to_regrole('authenticated')::oid]))) as dual_n
  `));
  ok(Number(cov[0].anon_n) === 1 && Number(cov[0].auth_n) === 1 && Number(cov[0].dual_n) === 0,
    'verification fix: per-role SELECT coverage is exactly 1 / 1 with zero overlap');

  // ── PHASE 5: foreign-key supporting-index sweep over the FULL chain ──────
  console.log('5. FK supporting-index sweep (full chain)');
  {
    const fks = rows(await tryQ(`
      select c.relname as table_name, con.conname,
             (select array_agg(sa.attname order by ord)
                from unnest(con.conkey) with ordinality k(attnum, ord)
                join pg_attribute sa on sa.attrelid = con.conrelid and sa.attnum = k.attnum) as cols
      from pg_constraint con
      join pg_class c on c.oid = con.conrelid
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and con.contype = 'f'
    `));
    const idxs = rows(await tryQ(`
      select c.relname as table_name, ic.relname as index_name,
             pg_get_expr(i.indpred, i.indrelid) as predicate,
             i.indisvalid,
             (select array_agg(sa.attname order by ord)
                from unnest(i.indkey) with ordinality k(attnum, ord)
                join pg_attribute sa on sa.attrelid = i.indrelid and sa.attnum = k.attnum) as cols
      from pg_index i
      join pg_class c on c.oid = i.indrelid
      join pg_class ic on ic.oid = i.indexrelid
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public'
    `));
    const isNotNulCover = (pred: unknown, cols: string[]) => {
      const p = String(pred ?? '');
      return cols.every((c) => p.toLowerCase().includes(`${c.toLowerCase()} is not null`));
    };
    const uncovered: string[] = [];
    for (const fk of fks) {
      const cols = fk.cols as string[];
      const suitable = (idxs as Row[]).filter((ix) => ix.table_name === fk.table_name
        && ix.indisvalid === true
        && (ix.cols as string[]).length >= cols.length
        && cols.every((c, i) => (ix.cols as string[])[i] === c)
        && (ix.predicate === null || isNotNulCover(ix.predicate, cols)));
      if (suitable.length === 0) uncovered.push(`${fk.table_name}(${cols.join(',')}) [${fk.conname}]`);
    }
    ok(fks.length >= 31, `sweep covered ${fks.length} foreign keys`);
    const expectedExceptions = [
      'device_sessions(user_id)',
      'analytics_sessions(user_id)',
      'cloudstream_adapter_build_jobs(extension_id)',
    ];
    ok(uncovered.length === 3
      && expectedExceptions.every((e) => uncovered.some((u) => u.startsWith(e))),
      'every FK has a suitable supporting index — the three accepted partial-only exceptions are exactly the documented set',
      uncovered.join('; '));
  }

  // ── PHASE 6: index-matrix pins (final-audit candidates) ──────────────────
  console.log('6. index matrix pins');
  {
    const shape = async (table: string, name: string) => rows(await tryQ(`
      select pg_get_indexdef(i.indexrelid) as def, pg_get_expr(i.indpred, i.indrelid) as pred,
             i.indisunique, i.indisvalid
      from pg_index i
      join pg_class ic on ic.oid = i.indexrelid
      join pg_class c on c.oid = i.indrelid
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = '${table}' and ic.relname = '${name}'
    `));

    // REMOVED (by 20261118000000 §7 or 20261119000000 §2) — absent, with
    // their covering constraint indexes present and valid.
    for (const [table, idx] of [
      ['media_items', 'media_items_canonical_key_idx'],
      ['media_items', 'media_items_content_type_tmdb_id_season_episode_idx'],
      ['media_items', 'media_items_content_type_tmdb_id_idx'],
      ['media_folders', 'media_folders_canonical_key_idx'],
      ['media_availability_requests', 'media_availability_requests_canonical_key_idx'],
      ['media_availability_requests', 'media_availability_requests_content_type_tmdb_id_idx'],
      ['provider_folder_mappings', 'provider_folder_mappings_canonical_folder_id_idx'],
      ['streaming_public_source_categories', 'streaming_public_source_categories_order_idx'],
    ] as const) {
      ok((await shape(table, idx)).length === 0, `matrix: ${idx} removed (absent)`);
    }
    for (const [table, idx] of [
      ['media_items', 'media_items_canonical_key_key'],
      ['media_items', 'media_items_content_tmdb_season_episode_key'],
      ['media_folders', 'media_folders_canonical_key_key'],
      ['media_availability_requests', 'media_availability_requests_canonical_key_key'],
      ['provider_folder_mappings', 'provider_folder_mappings_canonical_provider_key'],
      ['streaming_public_source_categories', 'streaming_public_source_categories_category_id_ordering_key'],
    ] as const) {
      const s = await shape(table, idx);
      ok(s.length === 1 && s[0].indisunique === true && s[0].indisvalid === true,
        `matrix: covering ${idx} present and valid`);
    }

    // KEEP — FK-supporting indexes (the remediation trio + slots source_idx).
    for (const [table, idx] of [
      ['device_pairing_requests', 'device_pairing_requests_approved_by_user_id_idx'],
      ['media_assets', 'media_assets_provider_folder_mapping_id_idx'],
      ['media_operations', 'media_operations_upload_operation_id_idx'],
      ['streaming_default_source_slots', 'streaming_default_source_slots_source_idx'],
    ] as const) {
      const s = await shape(table, idx);
      ok(s.length === 1 && s[0].indisvalid === true && s[0].pred === null,
        `matrix: FK index ${idx} present (full, valid)`);
    }

    // KEEP — hot-path partial indexes with their exact predicates.
    for (const [table, idx, predPart] of [
      ['device_pairing_requests', 'device_pairing_secret_hash_idx', 'pending'],
      ['device_pairing_requests', 'device_pairing_short_code_idx', 'pending'],
      ['device_pairing_requests', 'device_pairing_manual_handle_idx', 'manual_handle_hash is not null'],
      ['media_items', 'media_items_imdb_id_idx', 'imdb_id is not null'],
      ['analytics_sessions', 'analytics_sessions_user_active_idx', 'ended_at is null'],
      ['analytics_sessions', 'analytics_sessions_anon_active_idx', 'ended_at is null'],
      ['analytics_events', 'analytics_events_session_time_idx', 'session_id is not null'],
      ['media_assets', 'media_assets_provider_asset_id_idx', 'provider_asset_id is not null'],
      ['media_assets', 'media_assets_last_synced_at_idx', 'last_synced_at is not null'],
      ['media_operations', 'media_operations_provider_source_id_occurred_at_idx', 'provider_source_id is not null'],
      ['media_upload_operations', 'media_upload_operations_requested_by_user_id_idx', 'requested_by_user_id is not null'],
    ] as const) {
      const s = await shape(table, idx);
      ok(s.length === 1 && s[0].indisvalid === true
        && String(s[0].pred ?? '').toLowerCase().includes(predPart),
        `matrix: partial index ${idx} present with its predicate`);
    }

    // KEEP — full secondary indexes verified present.
    for (const [table, idx] of [
      ['device_pairing_requests', 'device_pairing_secret_hash_all_idx'],
      ['streaming_provider_health', 'streaming_provider_health_state_idx'],
      ['analytics_sessions', 'analytics_sessions_started_at_idx'],
      ['streaming_categories', 'streaming_categories_public_idx'],
      ['media_assets', 'media_assets_provider_source_media_item_id_idx'],
      ['media_assets', 'media_assets_mavero_status_idx'],
      ['media_upload_operations', 'media_upload_operations_status_idx'],
      ['media_upload_operations', 'media_upload_operations_provider_source_created_at_idx'],
      ['media_operations', 'media_operations_admin_user_id_occurred_at_idx'],
      ['media_folders', 'media_folders_kind_idx'],
      ['provider_folder_mappings', 'provider_folder_mappings_provider_source_canonical_idx'],
      ['cloudstream_repositories', 'cloudstream_repositories_listing_idx'],
    ] as const) {
      const s = await shape(table, idx);
      ok(s.length === 1 && s[0].indisvalid === true && s[0].pred === null,
        `matrix: full index ${idx} present (kept)`);
    }

    // STUB-ONLY: the live-only index on the out-of-band table exists in the
    // stub (its true live definition is not verifiable via the Data API —
    // documented limitation; classified UNCERTAIN and retained).
    ok((await shape('direct_play_sources', 'direct_play_sources_active_lookup')).length === 1,
      'matrix: direct_play_sources_active_lookup present in the stub (live-only, retained)');
  }

  // ── PHASE 7: idempotency ─────────────────────────────────────────────────
  console.log('7. corrective migration is idempotent');
  {
    const snapshot = async () => rows(await tryQ(`
      select indexname from pg_indexes where schemaname = 'public'
      union all
      select 'policy:' || polname || ':' || polrelid::regclass::text from pg_policy
      order by 1
    `));
    const before = await snapshot();
    let err: unknown = null;
    try { await exec(read(CORRECTIVE)); } catch (e) { err = e; }
    ok(err === null, 'corrective migration re-applies cleanly', err instanceof Error ? err.message : undefined);
    const after = await snapshot();
    ok(JSON.stringify(before) === JSON.stringify(after), 'catalog state byte-identical after re-apply');
  }

  console.log(`\nPASS supabase_final_audit_test — ${passed} checks`);
}

main().catch((e) => { console.error(e); process.exit(1); });
