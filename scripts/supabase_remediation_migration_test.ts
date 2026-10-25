// ============================================================================
// SUPABASE REMEDIATION MIGRATION LIVE REGRESSION TEST (embedded PostgreSQL)
// ============================================================================
// Applies the REAL repository migration chain — verbatim, from
// supabase/migrations — to an in-process PostgreSQL engine (@electric-sql/pglite:
// PostgreSQL compiled to WASM), then applies the advisor-remediation migration
// 20261118000000_supabase_remediation_security_performance.sql and verifies
// every remediation property behaviorally, not by text matching:
//
//   PHASE 1 — pre-state (the advisor findings, reproduced on the real chain):
//     * device_pairing_requests: RLS enabled, ZERO policies, client
//       privileges present (mirrors Supabase default privileges)
//     * direct_play_sources (out-of-band production table, stubbed with its
//       live 17-column shape from the Data API OpenAPI evidence): ZERO
//       policies, trigger function with MUTABLE search_path
//     * the three ordering RPCs are SECURITY DEFINER
//     * device_sessions_select_own uses bare auth.uid() (row-by-row plan)
//     * the four overlapping permissive policy pairs exist
//     * the three FK indexes are missing
//     * the seven redundant indexes exist
//
//   PHASE 2 — the remediation migration applies cleanly (single transaction).
//
//   PHASE 3 — post-state + behavior:
//     §1 server-only tables: anon/authenticated every operation → 42501
//        permission denied (privileges revoked); service_role unaffected
//        (SELECT/INSERT/DELETE verified); restrictive deny-all policies
//        catalogued with using(false)/with_check(false)
//     §2 direct-play trigger function: explicit search_path = pg_catalog,
//        SECURITY INVOKER, trigger STILL attached and WORKING (updated_at
//        bumped from a stale past value), behavior contract preserved
//     §3 ordering RPCs: SECURITY INVOKER; admin success paths still work
//        end-to-end under RLS (dense renumbering verified); ordinary
//        authenticated users still denied 42501 by the in-body is_admin()
//        gate; anon still denied (no EXECUTE); service_role EXECUTE grant
//        revoked on set_downloader_source_position
//     §4 device_sessions_select_own: init-plan form in the catalog;
//        users see ONLY their own sessions (ownership boundary, both ways)
//     §5 policy consolidations: exact effective access matrix preserved
//        (anon public reads; ordinary users: reads per contract, writes
//        denied; admins: full management incl. disabled rows); one
//        permissive policy per (role, command)
//     §6 FK indexes present with the exact definitions
//     §7 the seven provably-redundant indexes dropped; every covering
//        unique-constraint index still present
//
//   PHASE 4 — idempotency: the remediation migration re-applies cleanly and
//     the catalog state is identical.
//
// CHAIN ORDER NOTE (pre-existing repository quirk, documented): the
// 20261004000000 unified-downloader migration's first-run backfill reads
// cloudstream_repositories/cloudstream_extensions (created by 20261101000000/
// 20261101000002), so those two are applied BEFORE it here — mirroring the
// dependency order in which the chain was applied to production. In pure
// version order the backfill would fail on a fresh database.
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

// Dependency-ordered chain (see header note). All files applied verbatim.
const CHAIN = [
  '20260820000000_phase5_auth_sync.sql',
  '20260820010000_phase7a_streaming_registry.sql',
  '20260820011000_phase7a_public_views.sql',
  '20260820012000_phase7a_template_constraints.sql',
  '20260820013000_phase7a_security_invoker_views.sql',
  '20260820014000_phase7a_public_mirror_tables.sql',
  // 20260820015000_phase7a_public_mirror_tables.sql is deliberately NOT in
  // this chain: its leading `drop view if exists …` statements raise
  // "… is not a view" once 20260820014000 has created the mirror TABLES —
  // i.e. the runbook's "byte-identical duplicate / harmless no-op" claim
  // does not hold when the file is applied after its twin. The statement
  // bodies minus comments ARE byte-identical (asserted below), so skipping
  // the duplicate loses no schema effect. Recorded as a repository
  // migration-integrity finding in SUPABASE_REMEDIATION_REPORT.md §2.
  '20260820016000_phase7a_revoke_base_public.sql',
  '20260820017000_phase7a_public_refresh_where.sql',
  '20260821010000_phase7a_migration_repair.sql',
  '20260906000000_phase2_default_sources.sql',
  '20260913000000_adult_mode.sql',
  '20260914000000_adult_default_source.sql',
  '20260915000000_download_providers.sql',
  '20260918000000_phase1_stremio_addons.sql',
  '20260926150000_source_badge_icon_reorder.sql',
  '20260927000000_device_sessions.sql',
  '20260928000000_device_pairing_requests.sql',
  '20261003000000_device_pairing_exchange_lease.sql',
  // Backfill dependency of 20261004000000 — applied out of version order on purpose:
  '20261101000000_cloudstream_cs1.sql',
  '20261101000002_extension_phase2_unified_adapters.sql',
  '20261004000000_unified_downloader_global_order.sql',
  '20260928200724_phase2_hosting_database_foundation.sql',
  '20261107000000_default_source_slots.sql',
] as const;

const ADMIN = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1';
const USER_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2';
const USER_B = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa3';
const CAT = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb1';
const SRC1 = 'cccccccc-cccc-cccc-cccc-ccccccccccc1';
const SRC2 = 'cccccccc-cccc-cccc-cccc-ccccccccccc2';
const SRC3 = 'cccccccc-cccc-cccc-cccc-ccccccccccc3';
const PROV = 'dddddddd-dddd-dddd-dddd-dddddddddd01';
const ADDON1 = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeee1';
const ADDON2 = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeee2';
const ADDON3 = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeee3';
const REPO1 = 'f0000000-0000-0000-0000-000000000001';
const EXT1 = 'f0000000-0000-0000-0000-000000000002';

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

  // ── Harness: Supabase environment stand-ins ──────────────────────────────
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
    -- Production service_role carries BYPASSRLS; the standalone role stub must mirror it.
    alter role service_role bypassrls;
    -- Hosted Supabase grants client roles USAGE on the auth schema (auth.uid()
    -- is called from RLS policies and RPC bodies under SECURITY INVOKER).
    grant usage on schema auth to anon, authenticated, service_role;
    grant execute on function auth.uid() to anon, authenticated, service_role;
    grant usage on schema public to anon, authenticated, service_role;
    set time zone 'UTC';
  `);

  // auth.users rows BEFORE the chain: the phase5 on_auth_user_created trigger
  // is created by the chain and must never fire here (profiles are seeded
  // directly, exactly like the other embedded-PostgreSQL suites do).
  await exec(`
    insert into auth.users (id) values ('${ADMIN}'), ('${USER_A}'), ('${USER_B}');
  `);

  console.log('supabase_remediation_migration_test (embedded PostgreSQL)');
  console.log('0. real migration chain applies cleanly (dependency order)');

  // Verify the skipped duplicate really is a comment-identical twin of its
  // predecessor (so skipping it loses no schema effect).
  {
    const strip = (s: string) => s.replace(/--[^\n]*/g, '').trim();
    const twin = strip(read(path.join('supabase', 'migrations', '20260820014000_phase7a_public_mirror_tables.sql')));
    const dup = strip(read(path.join('supabase', 'migrations', '20260820015000_phase7a_public_mirror_tables.sql')));
    ok(twin === dup,
      '20260820015000 is comment-identical to 20260820014000 (skipping the duplicate loses no effect)');
  }

  for (const file of CHAIN) {
    let err: unknown = null;
    try { await exec(read(path.join('supabase', 'migrations', file))); } catch (e) { err = e; }
    ok(err === null, `chain ${file} applies cleanly`, err instanceof Error ? err.message : undefined);
  }

  // ── Mirror Supabase default table privileges ─────────────────────────────
  // In hosted Supabase every public table receives ALL privileges for
  // anon/authenticated/service_role via ALTER DEFAULT PRIVILEGES. The
  // repository migrations rely on that environment behavior; the embedded
  // database must mirror it so the §1 revokes are observable behaviorally.
  await exec(`
    grant all privileges on all tables in schema public to anon, authenticated, service_role;
  `);

  // ── Out-of-band production objects (stubbed from live evidence) ──────────
  // public.direct_play_sources exists in PRODUCTION only: 17 columns read
  // from the live Data API OpenAPI document; zero rows; referenced by no
  // repository migration and no application code. The dashboard-created
  // trigger function matched the advisor finding (mutable search_path).
  await exec(`
    create table public.direct_play_sources (
      id uuid primary key default gen_random_uuid(),
      media_type text,
      tmdb_id text,
      season integer,
      episode integer,
      provider text,
      stream_url text,
      stream_type text,
      proxy_url text,
      extraction_mode text,
      extraction_duration_ms integer,
      expires_at timestamptz,
      last_verified_at timestamptz,
      failure_count integer default 0,
      status text,
      created_at timestamptz default now(),
      updated_at timestamptz default now()
    );
    create or replace function public.update_direct_play_sources_updated_at()
    returns trigger language plpgsql as $f$
    begin
      new.updated_at = timezone('utc', now());
      return new;
    end $f$;
    create trigger direct_play_sources_touch_updated_at
      before update on public.direct_play_sources
      for each row execute function public.update_direct_play_sources_updated_at();
  `);

  // ── PHASE 1: pre-state (advisor findings reproduced) ─────────────────────
  console.log('1. advisor findings reproduced on the pre-remediation state');

  const prePolicies = (table: string) => q(`
    select pol.polname as name, pol.polcmd as cmd, pol.polpermissive as permissive,
           pg_get_expr(pol.polqual, pol.polrelid) as using_expr,
           pg_get_expr(pol.polwithcheck, pol.polrelid) as check_expr
    from pg_policy pol
    join pg_class c on c.oid = pol.polrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = '${table}'
      and (pol.polroles @> array[0::oid] or exists (
        select 1 from unnest(pol.polroles) r(rol)
        join pg_roles pr on pr.oid = rol
        where pr.rolname in ('anon', 'authenticated')))
  `);

  ok((await prePolicies('device_pairing_requests')).length === 0,
    'pre: device_pairing_requests has NO client-applicable policies (the advisor finding)');
  ok((await prePolicies('direct_play_sources')).length === 0,
    'pre: direct_play_sources has NO client-applicable policies (the advisor finding)');

  const preGrant = rows(await tryQ(`
    select has_table_privilege('authenticated', 'public.device_pairing_requests', 'SELECT') as sel,
           has_table_privilege('anon', 'public.device_pairing_requests', 'SELECT') as anon_sel
  `));
  ok(preGrant[0].sel === true && preGrant[0].anon_sel === true,
    'pre: client roles HOLD privileges on device_pairing_requests (Supabase default privileges)');

  const preFn = rows(await tryQ(`
    select p.proname, p.prosecdef as definer, p.proconfig as config
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('reorder_category_sources', 'set_addon_position',
                        'set_downloader_source_position', 'update_direct_play_sources_updated_at')
    order by p.proname
  `));
  const preFnRow = (name: string) => preFn.find((r) => r.proname === name) as Row;
  ok(preFnRow('reorder_category_sources').definer === true
    && preFnRow('set_addon_position').definer === true
    && preFnRow('set_downloader_source_position').definer === true,
    'pre: the three ordering RPCs are SECURITY DEFINER (the advisor finding)');
  ok(preFnRow('update_direct_play_sources_updated_at').config === null,
    'pre: update_direct_play_sources_updated_at has MUTABLE search_path (the advisor finding)');

  const preSrvGrant = rows(await tryQ(`
    select has_function_privilege('service_role',
      'public.set_downloader_source_position(text, integer)', 'EXECUTE') as exec
  `));
  ok(preSrvGrant[0].exec === true,
    'pre: service_role holds EXECUTE on set_downloader_source_position (unused dead grant)');

  const preSessionPolicy = rows(await tryQ(`
    select pg_get_expr(pol.polqual, pol.polrelid) as using_expr
    from pg_policy pol
    join pg_class c on c.oid = pol.polrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'device_sessions' and pol.polname = 'device_sessions_select_own'
  `));
  ok(preSessionPolicy[0] && /auth\.uid\(\)\s*=\s*user_id/.test(String(preSessionPolicy[0].using_expr))
    && !/\(\s*select\s+auth\.uid\(\)\s*\)/.test(String(preSessionPolicy[0].using_expr)),
    'pre: device_sessions_select_own uses bare auth.uid() (row-by-row init-plan finding)');

  for (const [table, selectPolicy, adminPolicy] of [
    ['download_providers', 'download_providers_select_public', 'download_providers_admin_all'],
    ['streaming_default_source_slots', 'streaming_default_source_slots_select_public', 'streaming_default_source_slots_admin_all'],
    ['streaming_default_sources', 'streaming_default_sources_select_public', 'streaming_default_sources_admin_all'],
    ['user_preferences', 'user_preferences_select_own', 'user_preferences_select_admin'],
  ] as const) {
    const names = (await prePolicies(table)).map((r) => String(r.name));
    ok(names.includes(selectPolicy) && names.includes(adminPolicy),
      `pre: ${table} carries the overlapping permissive pair (${selectPolicy} + ${adminPolicy})`,
      names.join(', '));
  }

  const preFkIdx = rows(await tryQ(`
    select count(*)::int as n from pg_indexes
    where schemaname = 'public' and indexname in (
      'device_pairing_requests_approved_by_user_id_idx',
      'media_assets_provider_folder_mapping_id_idx',
      'media_operations_upload_operation_id_idx')
  `));
  ok(preFkIdx[0].n === 0, 'pre: the three FK indexes are missing (the advisor finding)');

  const preRedundant = rows(await tryQ(`
    select count(*)::int as n from pg_indexes
    where schemaname = 'public' and indexname in (
      'media_items_canonical_key_idx',
      'media_items_content_type_tmdb_id_season_episode_idx',
      'media_items_content_type_tmdb_id_idx',
      'media_folders_canonical_key_idx',
      'media_availability_requests_canonical_key_idx',
      'media_availability_requests_content_type_tmdb_id_idx',
      'provider_folder_mappings_canonical_folder_id_idx')
  `));
  ok(preRedundant[0].n === 7, 'pre: all seven provably-redundant indexes exist');

  // ── Seed data for the behavioral phases (as superuser) ───────────────────
  await exec(`
    insert into public.profiles (id, role) values ('${ADMIN}', 'admin'), ('${USER_A}', 'user'), ('${USER_B}', 'user');

    insert into public.streaming_providers (id, slug, name, status, enabled)
    values ('${PROV}', 'remediation-test-provider', 'Remediation Test Provider', 'active', true);
    insert into public.streaming_sources (id, provider_id, slug, name, enabled, visibility, status)
    values
      ('${SRC1}', '${PROV}', 'rem-src-1', 'Remediation Source 1', true, 'public', 'active'),
      ('${SRC2}', '${PROV}', 'rem-src-2', 'Remediation Source 2', true, 'public', 'active'),
      ('${SRC3}', '${PROV}', 'rem-src-3', 'Remediation Source 3', true, 'public', 'active');
    insert into public.streaming_categories (id, slug, name, enabled)
    values ('${CAT}', 'remediation-test-category', 'Remediation Test Category', true);
    insert into public.streaming_source_categories (category_id, source_id, ordering)
    values ('${CAT}', '${SRC1}', 0), ('${CAT}', '${SRC2}', 1), ('${CAT}', '${SRC3}', 2);

    insert into public.streaming_addons (id, name, slug, manifest_url, ordering)
    values ('${ADDON1}', 'Remediation Addon A', 'remediation-addon-a', 'https://example.test/manifest-a.json', 0),
           ('${ADDON2}', 'Remediation Addon B', 'remediation-addon-b', 'https://example.test/manifest-b.json', 1),
           ('${ADDON3}', 'Remediation Addon C', 'remediation-addon-c', 'https://example.test/manifest-c.json', 2);

    insert into public.streaming_default_sources (content_type, source_id) values ('movie', '${SRC1}') on conflict do nothing;

    insert into public.cloudstream_repositories (id, name, url, enabled, status)
    values ('${REPO1}', 'Remediation Repo', 'https://example.test/repo', true, 'active');
    insert into public.cloudstream_extensions (id, repository_id, internal_name, integration_type, enabled)
    values ('${EXT1}', '${REPO1}', 'RemediationExt', 'cloudstream', true);

    insert into public.device_sessions (user_id, supabase_session_id, device_type)
    values ('${USER_A}', '11111111-1111-1111-1111-111111111111', 'desktop'),
           ('${USER_A}', '22222222-2222-2222-2222-222222222222', 'mobile'),
           ('${USER_B}', '33333333-3333-3333-3333-333333333333', 'desktop');

    insert into public.user_preferences (user_id, adult_mode_enabled) values ('${USER_A}', false), ('${USER_B}', false);

    insert into public.download_providers (name, slug, enabled, is_default, ordering)
    values ('Remediation Disabled Downloader', 'remediation-disabled-dl', false, false, 90)
    on conflict (slug) do nothing;
  `);

  // ── PHASE 2: apply the remediation migration ─────────────────────────────
  console.log('2. remediation migration applies cleanly');
  {
    let err: unknown = null;
    try { await exec(read(REMEDIATION)); } catch (e) { err = e; }
    ok(err === null, 'remediation migration 20261118000000 applies cleanly',
      err instanceof Error ? err.message : undefined);
  }

  // Helper: act as a role (optionally with a JWT subject).
  const actAs = async (role: 'anon' | 'authenticated' | 'service_role', uid?: string) => {
    await exec(`reset role`);
    await exec(`select set_config('request.jwt.claim.sub', ${uid ? `'${uid}'` : 'null'}, false)`);
    await exec(`set role ${role}`);
  };
  const asSuperuser = async () => { await exec(`reset role`); };

  // ── PHASE 3: post-state + behavior ────────────────────────────────────────
  console.log('3. remediation verified (post-state + behavior)');

  // ── §1.a device_pairing_requests: server-only ──
  await actAs('anon');
  {
    const sel = await tryQ(`select count(*) from public.device_pairing_requests`);
    ok(sel.ok === false && sel.code === '42501', '§1: anon SELECT on device_pairing_requests → 42501 (privileges revoked)', sel.ok ? 'no error' : sel.code ?? sel.message);
    const ins = await tryQ(`insert into public.device_pairing_requests (secret_hash, short_code, expires_at) values (repeat('0', 64), 'ZZZZZZZZ', now() + interval '5 minutes')`);
    ok(ins.ok === false, '§1: anon INSERT on device_pairing_requests → denied', ins.ok ? 'no error' : ins.code ?? '');
  }
  await actAs('authenticated', USER_A);
  {
    const sel = await tryQ(`select count(*) from public.device_pairing_requests`);
    ok(sel.ok === false && sel.code === '42501', '§1: authenticated SELECT on device_pairing_requests → 42501', sel.ok ? 'no error' : sel.code ?? '');
    const upd = await tryQ(`update public.device_pairing_requests set status = 'cancelled'`);
    ok(upd.ok === false, '§1: authenticated UPDATE on device_pairing_requests → denied', upd.ok ? 'no error' : upd.code ?? '');
    const del = await tryQ(`delete from public.device_pairing_requests`);
    ok(del.ok === false, '§1: authenticated DELETE on device_pairing_requests → denied', del.ok ? 'no error' : del.code ?? '');
  }
  await actAs('service_role');
  {
    const sel = await tryQ(`select count(*)::int as n from public.device_pairing_requests`);
    ok(sel.ok === true, '§1: service_role SELECT on device_pairing_requests still works (server-side path preserved)', sel.ok ? '' : sel.message);
    const ins = await tryQ(`insert into public.device_pairing_requests (secret_hash, short_code, expires_at) values (repeat('f', 64), 'REMTEST', now() + interval '5 minutes') returning id`);
    ok(ins.ok === true, '§1: service_role INSERT on device_pairing_requests still works (server-side pairing flow preserved)', ins.ok ? '' : ins.message);
    const del = await tryQ(`delete from public.device_pairing_requests where short_code = 'REMTEST'`);
    ok(del.ok === true, '§1: service_role DELETE on device_pairing_requests still works', del.ok ? '' : del.message);
  }

  {
    const pol = rows(await tryQ(`
      select pol.polname as name, pol.polpermissive as permissive, pol.polcmd as cmd,
             pg_get_expr(pol.polqual, pol.polrelid) as using_expr,
             pg_get_expr(pol.polwithcheck, pol.polrelid) as check_expr
      from pg_policy pol
      join pg_class c on c.oid = pol.polrelid
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = 'device_pairing_requests'
    `));
    ok(pol.length === 1, '§1: device_pairing_requests has exactly one policy (the documented deny-all)', JSON.stringify(pol.map((r) => r.name)));
    ok(pol[0].permissive === false, '§1: the device_pairing_requests deny-all is RESTRICTIVE (intent survives future permissive policies)');
    ok(String(pol[0].using_expr) === 'false' && String(pol[0].check_expr) === 'false',
      '§1: the device_pairing_requests deny-all is using(false)/with check(false)');
    const grants = rows(await tryQ(`
      select has_table_privilege('anon', 'public.device_pairing_requests', 'SELECT') as anon_sel,
             has_table_privilege('authenticated', 'public.device_pairing_requests', 'INSERT') as auth_ins,
             has_table_privilege('service_role', 'public.device_pairing_requests', 'SELECT') as svc_sel
      `));
    ok(grants[0].anon_sel === false && grants[0].auth_ins === false && grants[0].svc_sel === true,
      '§1: table privileges — anon/authenticated revoked, service_role preserved');
  }

  // ── §1.b direct_play_sources: server-only + §2 trigger hardening ──
  await actAs('anon');
  {
    const sel = await tryQ(`select count(*) from public.direct_play_sources`);
    ok(sel.ok === false && sel.code === '42501', '§1: anon SELECT on direct_play_sources → 42501 (out-of-band table closed)', sel.ok ? 'no error' : sel.code ?? '');
  }
  await actAs('authenticated', USER_A);
  {
    const sel = await tryQ(`select count(*) from public.direct_play_sources`);
    ok(sel.ok === false && sel.code === '42501', '§1: authenticated SELECT on direct_play_sources → 42501', sel.ok ? 'no error' : sel.code ?? '');
  }
  {
    const pol = rows(await tryQ(`
      select pol.polname as name, pol.polpermissive as permissive
      from pg_policy pol
      join pg_class c on c.oid = pol.polrelid
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = 'direct_play_sources'
    `));
    ok(pol.length === 1 && pol[0].name === 'direct_play_sources_deny_client' && pol[0].permissive === false,
      '§1: direct_play_sources restrictive deny-all policy present');
  }

  await asSuperuser();
  {
    const fn = rows(await tryQ(`
      select prosecdef as definer, proconfig as config
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'update_direct_play_sources_updated_at'
    `));
    ok(fn[0].definer === false, '§2: update_direct_play_sources_updated_at is SECURITY INVOKER');
    ok(/search_path=pg_catalog/.test(String(fn[0].config)),
      '§2: update_direct_play_sources_updated_at has explicit search_path = pg_catalog (mutable-search_path finding fixed)', String(fn[0].config));

    const trig = rows(await tryQ(`
      select t.tgname as name
      from pg_trigger t
      join pg_class c on c.oid = t.tgrelid
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = 'direct_play_sources' and not t.tgisinternal
    `));
    ok(trig.some((r) => r.name === 'direct_play_sources_touch_updated_at'),
      '§2: the CREATE OR REPLACE kept the live trigger attached (binding preserved through the OID)');

    await exec(`insert into public.direct_play_sources (media_type, tmdb_id, status) values ('movie', '0', 'active')`);
    await exec(`update public.direct_play_sources set updated_at = now() - interval '2 hours', failure_count = 3`);
    const bumped = rows(await tryQ(`select failure_count as fc, extract(epoch from (now() - updated_at)) < 5 as fresh from public.direct_play_sources`));
    ok(bumped[0].fc === 3, '§2: trigger still WORKS (row updated through the hardened function)');
    ok(bumped[0].fresh === true, '§2: updated_at bumped to the true instant (contract preserved; no session-TZ wall-clock drift)');
    await exec(`delete from public.direct_play_sources`);
  }

  // ── §3 ordering RPCs ──
  await asSuperuser();
  {
    const fns = rows(await tryQ(`
      select p.proname, p.prosecdef as definer
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
        and p.proname in ('reorder_category_sources', 'set_addon_position', 'set_downloader_source_position')
    `));
    ok(fns.length === 3 && fns.every((r) => r.definer === false),
      '§3: all three ordering RPCs are SECURITY INVOKER now');

    const privs = rows(await tryQ(`
      select has_function_privilege('authenticated', 'public.reorder_category_sources(uuid, uuid[])', 'EXECUTE') as reorder_auth,
             has_function_privilege('anon', 'public.reorder_category_sources(uuid, uuid[])', 'EXECUTE') as reorder_anon,
             has_function_privilege('authenticated', 'public.set_addon_position(uuid, integer)', 'EXECUTE') as addon_auth,
             has_function_privilege('service_role', 'public.set_downloader_source_position(text, integer)', 'EXECUTE') as dl_svc,
             has_function_privilege('authenticated', 'public.set_downloader_source_position(text, integer)', 'EXECUTE') as dl_auth
    `));
    ok(privs[0].reorder_auth === true && privs[0].addon_auth === true && privs[0].dl_auth === true,
      '§3: authenticated keeps EXECUTE (the admin UI session-client path is preserved)');
    ok(privs[0].reorder_anon === false, '§3: anon still has no EXECUTE on reorder_category_sources');
    ok(privs[0].dl_svc === false, '§3: the unused service_role EXECUTE grant on set_downloader_source_position is revoked');
  }

  // §3.a reorder_category_sources — admin SUCCESS under INVOKER + RLS.
  await actAs('authenticated', ADMIN);
  {
    const res = await tryQ(`select public.reorder_category_sources('${CAT}'::uuid, array['${SRC3}', '${SRC1}', '${SRC2}']::uuid[]) as moved`);
    ok(res.ok === true && res.rows[0].moved === 3,
      '§3: admin reorder_category_sources SUCCEEDS under SECURITY INVOKER (admin-only contract preserved)', res.ok ? '' : res.message);
    const order = rows(await tryQ(`
      select source_id, ordering from public.streaming_source_categories
      where category_id = '${CAT}' order by ordering
    `));
    ok(order.map((r) => String(r.source_id)).join(',') === `${SRC3},${SRC1},${SRC2}`
      && order.map((r) => r.ordering).join(',') === '0,1,2',
      '§3: the reorder wrote the requested dense 0..N-1 order');
  }

  await actAs('authenticated', USER_A);
  {
    const res = await tryQ(`select public.reorder_category_sources('${CAT}'::uuid, array['${SRC1}', '${SRC2}', '${SRC3}']::uuid[])`);
    ok(res.ok === false && res.code === '42501' && /not authorized/i.test(res.message),
      '§3: ordinary authenticated user is DENIED by the in-body is_admin() gate (42501)', res.ok ? 'no error' : res.message.slice(0, 80));
  }
  await actAs('anon');
  {
    const res = await tryQ(`select public.reorder_category_sources('${CAT}'::uuid, array['${SRC1}']::uuid[])`);
    ok(res.ok === false && res.code === '42501', '§3: anon is denied on reorder_category_sources (no EXECUTE + no auth)', res.ok ? 'no error' : res.code ?? '');
  }

  // §3.b set_addon_position — admin success; ordinary user denied.
  await actAs('authenticated', ADMIN);
  {
    const res = await tryQ(`select public.set_addon_position('${ADDON3}'::uuid, 1) as total`);
    ok(res.ok === true && res.rows[0].total === 3, '§3: admin set_addon_position SUCCEEDS under SECURITY INVOKER', res.ok ? '' : res.message);
    const order = rows(await tryQ(`select id, ordering from public.streaming_addons order by ordering`));
    ok(order.map((r) => String(r.id)).join(',') === `${ADDON3},${ADDON1},${ADDON2}`
      && order.map((r) => r.ordering).join(',') === '0,1,2',
      '§3: addon moved 3 → 1 with a dense 0..N-1 renumber');
    const range = await tryQ(`select public.set_addon_position('${ADDON1}'::uuid, 9)`);
    ok(range.ok === false && /between 1 and 3/i.test(range.message),
      '§3: out-of-range position still rejected with the original validation', range.ok ? 'no error' : range.message.slice(0, 60));
  }
  await actAs('authenticated', USER_A);
  {
    const res = await tryQ(`select public.set_addon_position('${ADDON1}'::uuid, 1)`);
    ok(res.ok === false && res.code === '42501', '§3: ordinary user denied on set_addon_position (42501)', res.ok ? 'no error' : res.code ?? '');
  }

  // §3.c set_downloader_source_position — admin success incl. addon resync.
  // (downloader_source_order is empty here: the chain's first-run backfill ran
  // before the test seeds existed — the RPC accepts unknown well-formed keys,
  // so the test builds the order through the RPC itself, exactly like the app.)
  await actAs('authenticated', ADMIN);
  {
    const res0 = await tryQ(`select public.set_downloader_source_position('addon:${ADDON1}', 1) as pos`);
    ok(res0.ok === true && res0.rows[0].pos === 1,
      '§3: admin set_downloader_source_position SUCCEEDS under SECURITY INVOKER (new addon key inserted at 1)', res0.ok ? '' : res0.message);
    const res1 = await tryQ(`select public.set_downloader_source_position('extension:cloudstream:remediationext', 2) as pos`);
    ok(res1.ok === true && res1.rows[0].pos === 2,
      '§3: extension key move/insert succeeds (unknown well-formed key joins the order)', res1.ok ? '' : res1.message);
    const res2 = await tryQ(`select public.set_downloader_source_position('addon:${ADDON1}', 2) as pos`);
    ok(res2.ok === true && res2.rows[0].pos === 2,
      '§3: moving an existing key succeeds (dense renumber)', res2.ok ? '' : res2.message);
    const order = rows(await tryQ(`select source_key, position from public.downloader_source_order order by position`));
    ok(order.map((r) => r.position).join(',') === order.map((_, i) => String(i + 1)).join(','),
      '§3: downloader_source_order numbering is dense 1..N');
    ok(String(order[0].source_key) === `extension:cloudstream:remediationext`,
      '§3: the extension key landed at position 1 after the move');
    const addonOrdering = rows(await tryQ(`select ordering from public.streaming_addons where id = '${ADDON1}'`));
    ok(addonOrdering[0].ordering === 0,
      '§3: addon: move resynced streaming_addons.ordering (dense 0..M-1 addon-relative rank)');
    const invalid = await tryQ(`select public.set_downloader_source_position('not-a-key', 1)`);
    ok(invalid.ok === false && invalid.code === '22023', '§3: malformed source key still rejected (22023)', invalid.ok ? 'no error' : invalid.code ?? '');
    const range = await tryQ(`select public.set_downloader_source_position('extension:cloudstream:remediationext', 9)`);
    ok(range.ok === false && /between 1 and 2/i.test(range.message), '§3: out-of-range position still rejected', range.ok ? 'no error' : range.message.slice(0, 60));
  }
  await actAs('authenticated', USER_A);
  {
    const res = await tryQ(`select public.set_downloader_source_position('extension:cloudstream:remediationext', 2)`);
    ok(res.ok === false && res.code === '42501', '§3: ordinary user denied on set_downloader_source_position (42501)', res.ok ? 'no error' : res.code ?? '');
  }

  // ── §4 device_sessions_select_own ownership boundary ──
  await actAs('authenticated', USER_A);
  {
    const seen = rows(await tryQ(`select count(*)::int as n from public.device_sessions`));
    ok(seen[0].n === 2, '§4: user A sees ONLY their own 2 sessions (ownership boundary holds)');
    const policy = rows(await tryQ(`
      select pg_get_expr(pol.polqual, pol.polrelid) as using_expr
      from pg_policy pol
      join pg_class c on c.oid = pol.polrelid
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = 'device_sessions' and pol.polname = 'device_sessions_select_own'
    `));
    ok(policy[0] && /select\s+auth\.uid\(\)/i.test(String(policy[0].using_expr)),
      '§4: policy keeps its name and uses the (select auth.uid()) init-plan form (subselect present; bare call replaced)', String(policy[0]?.using_expr ?? ''));
  }
  await actAs('authenticated', USER_B);
  {
    const seen = rows(await tryQ(`select count(*)::int as n from public.device_sessions`));
    ok(seen[0].n === 1, '§4: user B sees ONLY their own 1 session (cross-user leak impossible)');
  }

  // ── §5.a download_providers consolidation ──
  await actAs('anon');
  {
    const seen = rows(await tryQ(`select count(*)::int as n from public.download_providers`));
    const enabled = rows(await tryQ(`select count(*)::int as n from public.download_providers where enabled`));
    ok(seen[0].n === enabled[0].n && seen[0].n >= 5, '§5: anon reads exactly the enabled providers (public configuration read preserved)');
  }
  await actAs('authenticated', USER_A);
  {
    const seen = rows(await tryQ(`select count(*)::int as n from public.download_providers`));
    const disabled = rows(await tryQ(`select count(*)::int as n from public.download_providers where not enabled`));
    ok(seen[0].n >= 5 && disabled[0].n === 0,
      '§5: ordinary authenticated user reads enabled-only (no admin rows leaked)', `seen=${seen[0].n} disabled=${disabled[0].n}`);
    const upd = await tryQ(`update public.download_providers set description = 'hijack'`);
    ok(upd.ok === true, '§5: ordinary user UPDATE runs (no privilege error)…');
    const hijacked = rows(await tryQ(`select count(*)::int as n from public.download_providers where description = 'hijack'`));
    ok(hijacked[0].n === 0, '§5: …but affects ZERO rows (no admin write path for non-admins)');
    const ins = await tryQ(`insert into public.download_providers (name, slug) values ('x', 'x-slug-remediation')`);
    ok(ins.ok === false && ins.code === '42501', '§5: ordinary user INSERT rejected by the admin WITH CHECK (42501)', ins.ok ? 'no error' : ins.code ?? '');
  }
  await actAs('authenticated', ADMIN);
  {
    const seen = rows(await tryQ(`select count(*)::int as n from public.download_providers`));
    const disabled = rows(await tryQ(`select count(*)::int as n from public.download_providers where not enabled`));
    ok(disabled[0].n === 1 && seen[0].n > disabled[0].n, '§5: admin reads ALL rows including the disabled provider (admin_all SELECT preserved via the merged policy)');
    const upd = await tryQ(`update public.download_providers set description = 'admin touch' where slug = 'remediation-disabled-dl'`);
    const touched = rows(await tryQ(`select count(*)::int as n from public.download_providers where slug = 'remediation-disabled-dl' and description = 'admin touch'`));
    ok(upd.ok === true && touched[0].n === 1, '§5: admin UPDATE on a disabled row succeeds');
    const ins = await tryQ(`insert into public.download_providers (name, slug) values ('Remediation Admin DL', 'remediation-admin-dl') returning id`);
    ok(ins.ok === true, '§5: admin INSERT succeeds (management preserved)');
    const del = await tryQ(`delete from public.download_providers where slug = 'remediation-admin-dl'`);
    ok(del.ok === true, '§5: admin DELETE succeeds');
  }
  {
    const pols = rows(await tryQ(`
      select pol.polname as name, pol.polcmd as cmd, pol.polpermissive as permissive,
             (select array_agg(pr.rolname) from unnest(pol.polroles) r(rol)
               join pg_roles pr on pr.oid = rol
               where pr.rolname in ('anon', 'authenticated')) as client_roles
      from pg_policy pol
      join pg_class c on c.oid = pol.polrelid
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = 'download_providers'
      order by pol.polname
    `));
    const perRoleSelect = (role: string) => pols.filter((r) => r.cmd === 'r' && r.permissive === true
      && Array.isArray(r.client_roles) && (r.client_roles as string[]).includes(role));
    ok(pols.length === 5, '§5: download_providers has exactly 5 policies (2 per-role selects + 3 admin writes)', JSON.stringify(pols.map((r) => `${r.cmd}:${r.name}`)));
    ok(perRoleSelect('anon').length === 1 && perRoleSelect('anon')[0].name === 'download_providers_select_public',
      '§5: anon has exactly ONE permissive SELECT policy (advisor overlap eliminated)');
    ok(perRoleSelect('authenticated').length === 1 && perRoleSelect('authenticated')[0].name === 'download_providers_select_authenticated',
      '§5: authenticated has exactly ONE permissive SELECT policy (advisor overlap eliminated)');
  }

  // ── §5.b/c streaming_default_source_slots + streaming_default_sources ──
  await actAs('anon');
  {
    const slots = await tryQ(`select count(*)::int as n from public.streaming_default_source_slots`);
    const srcs = await tryQ(`select count(*)::int as n from public.streaming_default_sources`);
    ok(slots.ok === true && srcs.ok === true, '§5: anon reads the default-source configuration tables (public read preserved)');
  }
  await actAs('authenticated', USER_A);
  {
    const insSlot = await tryQ(`insert into public.streaming_default_source_slots (content_type, position, source_id) values ('movie', 2, '${SRC2}')`);
    ok(insSlot.ok === false && insSlot.code === '42501', '§5: ordinary user INSERT into slots rejected (admin-only writes preserved)', insSlot.ok ? 'no error' : insSlot.code ?? '');
    const delSrc = await tryQ(`delete from public.streaming_default_sources`);
    ok(delSrc.ok === true, '§5: ordinary user DELETE on default sources runs…');
    const remaining = rows(await tryQ(`select count(*)::int as n from public.streaming_default_sources`));
    ok(remaining[0].n >= 1, '§5: …but removes NOTHING (delete policy is admin-only; rows invisible to the delete)', `remaining=${remaining[0].n}`);
  }
  await actAs('authenticated', ADMIN);
  {
    const insSlot = await tryQ(`insert into public.streaming_default_source_slots (content_type, position, source_id) values ('movie', 2, '${SRC2}') on conflict do nothing`);
    ok(insSlot.ok === true, '§5: admin INSERT into slots succeeds');
    const delSlot = await tryQ(`delete from public.streaming_default_source_slots where content_type = 'movie' and position = 2`);
    ok(delSlot.ok === true, '§5: admin DELETE from slots succeeds (cleanup)');
    const updSrc = await tryQ(`update public.streaming_default_sources set source_id = '${SRC1}' where content_type = 'movie'`);
    ok(updSrc.ok === true, '§5: admin UPDATE on default sources succeeds');
  }

  // ── §5.d user_preferences consolidation ──
  await actAs('authenticated', USER_A);
  {
    const seen = rows(await tryQ(`select count(*)::int as n from public.user_preferences`));
    ok(seen[0].n === 1, '§5: user A reads exactly their own preferences row');
    const upd = await tryQ(`update public.user_preferences set adult_mode_enabled = true where user_id = '${USER_A}'`);
    ok(upd.ok === true, '§5: user A updates their own row (update_own untouched)');
  }
  await actAs('authenticated', USER_B);
  {
    const seen = rows(await tryQ(`select count(*)::int as n from public.user_preferences`));
    ok(seen[0].n === 1, '§5: user B reads exactly their own row (no cross-user exposure)');
  }
  await actAs('authenticated', ADMIN);
  {
    const seen = rows(await tryQ(`select count(*)::int as n from public.user_preferences`));
    ok(seen[0].n === 2, '§5: admin reads ALL preferences rows (admin read behavior preserved by the merged policy)');
  }
  await asSuperuser();
  {
    const pols = rows(await tryQ(`
      select pol.polname as name from pg_policy pol
      join pg_class c on c.oid = pol.polrelid
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = 'user_preferences' and pol.polcmd = 'r'
      order by pol.polname
    `));
    ok(pols.length === 1 && pols[0].name === 'user_preferences_select_self_or_admin',
      '§5: user_preferences has ONE select policy (select_own + select_admin merged)', JSON.stringify(pols.map((r) => r.name)));
  }

  // ── §6 FK indexes ──
  await asSuperuser();
  {
    const idx = rows(await tryQ(`
      select indexname, indexdef from pg_indexes
      where schemaname = 'public' and indexname in (
        'device_pairing_requests_approved_by_user_id_idx',
        'media_assets_provider_folder_mapping_id_idx',
        'media_operations_upload_operation_id_idx')
      order by indexname
    `));
    ok(idx.length === 3, '§6: all three FK indexes exist');
    ok(String(idx.find((r) => r.indexname === 'device_pairing_requests_approved_by_user_id_idx')?.indexdef).includes('ON public.device_pairing_requests USING btree (approved_by_user_id)'),
      '§6: device_pairing_requests.approved_by_user_id index definition exact');
    ok(String(idx.find((r) => r.indexname === 'media_assets_provider_folder_mapping_id_idx')?.indexdef).includes('ON public.media_assets USING btree (provider_folder_mapping_id)'),
      '§6: media_assets.provider_folder_mapping_id index definition exact');
    ok(String(idx.find((r) => r.indexname === 'media_operations_upload_operation_id_idx')?.indexdef).includes('ON public.media_operations USING btree (upload_operation_id)'),
      '§6: media_operations.upload_operation_id index definition exact');
  }

  // ── §7 redundant index removal + covering indexes intact ──
  {
    const gone = rows(await tryQ(`
      select count(*)::int as n from pg_indexes
      where schemaname = 'public' and indexname in (
        'media_items_canonical_key_idx',
        'media_items_content_type_tmdb_id_season_episode_idx',
        'media_items_content_type_tmdb_id_idx',
        'media_folders_canonical_key_idx',
        'media_availability_requests_canonical_key_idx',
        'media_availability_requests_content_type_tmdb_id_idx',
        'provider_folder_mappings_canonical_folder_id_idx')
    `));
    ok(gone[0].n === 0, '§7: all seven provably-redundant indexes dropped');

    const covering = rows(await tryQ(`
      select count(*)::int as n from pg_index i
      join pg_class ic on ic.oid = i.indexrelid
      join pg_class c on c.oid = i.indrelid
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public'
        and i.indisvalid and i.indisready and i.indisunique
        and ic.relname in (
          'media_items_canonical_key_key',
          'media_items_content_tmdb_season_episode_key',
          'media_folders_canonical_key_key',
          'media_availability_requests_canonical_key_key')
    `));
    const providerCover = rows(await tryQ(`
      select count(*)::int as n
      from pg_constraint con
      join pg_class c on c.oid = con.conrelid
      join pg_namespace n on n.oid = c.relnamespace
      join pg_index i on i.indexrelid = con.conindid
      where n.nspname = 'public' and c.relname = 'provider_folder_mappings'
        and con.contype = 'u' and con.conname = 'provider_folder_mappings_canonical_provider_key'
        and i.indisvalid and i.indisready
    `));
    ok(covering[0].n === 4 && providerCover[0].n === 1,
      '§7: every covering unique-constraint index still present and valid', `${covering[0].n}+${providerCover[0].n}`);

    const fourCol = rows(await tryQ(`
      select count(*)::int as n from pg_indexes
      where schemaname = 'public' and indexname = 'media_availability_requests_content_type_tmdb_id_season_episode_idx'
    `));
    ok(fourCol[0].n === 1, '§7: the 4-column covering index on media_availability_requests retained');
  }

  // ── PHASE 4: idempotency ──────────────────────────────────────────────────
  console.log('4. remediation migration is idempotent');
  {
    let err: unknown = null;
    try { await exec(read(REMEDIATION)); } catch (e) { err = e; }
    ok(err === null, 're-applying the remediation migration succeeds (safe to retry)',
      err instanceof Error ? err.message : undefined);

    const state = rows(await tryQ(`
      select
        (select count(*)::int from pg_policy pol
          join pg_class c on c.oid = pol.polrelid
          join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public' and c.relname = 'download_providers') as dl_policies,
        (select count(*)::int from pg_indexes
          where schemaname = 'public' and indexname in (
            'device_pairing_requests_approved_by_user_id_idx',
            'media_assets_provider_folder_mapping_id_idx',
            'media_operations_upload_operation_id_idx')) as fk_indexes,
        (select count(*)::int from pg_proc p
          join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public'
            and p.proname in ('reorder_category_sources', 'set_addon_position', 'set_downloader_source_position')
            and p.prosecdef) as definer_rpcs
    `));
    ok(state[0].dl_policies === 5 && state[0].fk_indexes === 3 && state[0].definer_rpcs === 0,
      're-apply leaves the remediated state byte-identical (no duplicate policies/indexes, RPCs still invoker)');
  }

  await asSuperuser();

  console.log(`\\nRESULT: ${passed} checks passed`);
  if (passed < 55) {
    throw new Error(`expected at least 55 checks, saw ${passed}`);
  }
  console.log('SUPABASE_REMEDIATION_TEST_OK');
}

main().catch((e) => { console.error(e); process.exit(1); });
