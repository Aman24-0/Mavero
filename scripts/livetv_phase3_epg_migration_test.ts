/**
 * UNIFIED LIVE TV — Phase 3 migration verification on embedded PostgreSQL
 * (PGlite) — mirrors livetv_phase1_migration_test.ts conventions.
 *
 * Verifies migration 20261121000000_livetv_epg_guide_data.sql against the
 * REAL DDL semantics:
 *
 *   PHASE A — applies cleanly over the realistic pre-state (auth.uid +
 *     profiles + is_admin + set_updated_at + the Phase 1 livetv family) and
 *     is IDEMPOTENT (re-apply changes nothing).
 *   PHASE B — schema contract: window ordering (end_at > start_at), title
 *     bounds, https-only icon URLs, the guide-id shape (no whitespace/
 *     control chars), and THE idempotency uniqueness
 *     (epg_source_id, epg_channel_id, start_at, end_at).
 *   PHASE C — idempotent upserts at the DB level (ON CONFLICT converges;
 *     a repeat import creates no duplicates) + FK cascade (removing a guide
 *     source removes exactly its own programme rows).
 *   PHASE D — RLS: enabled, ONLY the admin-all policy, anon has no
 *     grants-backed access, is_admin() resolves fail-closed.
 *   PHASE E — triggers: updated_at maintenance + config-version bumping on
 *     programme writes.
 *   PHASE F — retention semantics on real timestamps: a cutoff strictly in
 *     the past can never reach current/upcoming windows.
 *
 * NO network, NO Supabase project, NO production database is touched.
 */

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
const PHASE1 = 'supabase/migrations/20261120000000_livetv_source_registry.sql';
const PHASE3 = 'supabase/migrations/20261121000000_livetv_epg_guide_data.sql';
const phase1Sql = readFileSync(path.join(REPO_ROOT, PHASE1), 'utf8');
const phase3Sql = readFileSync(path.join(REPO_ROOT, PHASE3), 'utf8');

type Row = Record<string, unknown>;

async function main() {
  const db = new PGlite();
  async function q(sql: string): Promise<Row[]> {
    const res = await db.query<Row>(sql);
    return (res.rows ?? []) as Row[];
  }
  async function tryExec(sql: string): Promise<{ ok: boolean; message: string }> {
    try {
      await db.exec(sql);
      return { ok: true, message: '' };
    } catch (e) {
      const err = e as { message?: string };
      return { ok: false, message: String(err.message ?? e) };
    }
  }

  // -------------------------------------------------------------------------
  console.log('PHASE A — pre-state + apply (idempotent)');
  // -------------------------------------------------------------------------
  {
    // Realistic pre-state — everything the migrations reference but never
    // redefine (auth.uid, profiles, is_admin, set_updated_at, roles).
    await db.exec(`
      create schema if not exists auth;
      create table if not exists auth.users (id uuid primary key);
      create or replace function auth.uid() returns uuid language sql as $$ select null::uuid $$;
      do $h$
      begin
        if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
        if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon; end if;
      end
      $h$;
      create table if not exists public.profiles (id uuid primary key, role text not null default 'user');
      create or replace function public.set_updated_at()
        returns trigger language plpgsql security invoker set search_path = public
        as $$ begin new.updated_at = timezone('utc', now()); return new; end; $$;
      create or replace function public.is_admin()
        returns boolean language sql stable security definer set search_path = public
        as $$ select exists(select 1 from public.profiles where id = (select auth.uid()) and role = 'admin') $$;
      grant execute on function public.is_admin() to authenticated;
      create schema if not exists supabase_migrations;
    `);

    const apply1 = await tryExec(phase1Sql);
    ok(apply1.ok, 'A1 the Phase 1 registry migration applies cleanly', apply1.message);
    const apply3 = await tryExec(phase3Sql);
    ok(apply3.ok, 'A2 the Phase 3 EPG migration applies cleanly over the Phase 1 family', apply3.message);
    const replay = await tryExec(phase3Sql);
    ok(replay.ok, 'A3 the Phase 3 migration re-applies idempotently (IF NOT EXISTS throughout)', replay.message);
    const replay1 = await tryExec(phase1Sql);
    ok(replay1.ok, 'A4 the Phase 1 migration still replays after Phase 3 (additive, no interference)', replay1.message);
  }

  // -------------------------------------------------------------------------
  console.log('PHASE B — schema contract');
  // -------------------------------------------------------------------------
  const epgSourceId = 'eeeeeeee-0000-0000-0000-000000000001';
  {
    const tables = await q(`select table_name from information_schema.tables
      where table_schema = 'public' and table_name like 'livetv_%' order by table_name`);
    const names = tables.map((row) => String(row['table_name']));
    ok(names.includes('livetv_epg_programmes'), 'B1 the livetv_epg_programmes table exists');

    const columns = await q(`select column_name, data_type, is_nullable from information_schema.columns
      where table_schema = 'public' and table_name = 'livetv_epg_programmes' order by ordinal_position`);
    const byName = new Map(columns.map((row) => [String(row['column_name']), row]));
    ok(byName.get('start_at')?.['data_type'] === 'timestamp with time zone', 'B2 start_at is timestamptz (absolute instant)');
    ok(byName.get('end_at')?.['data_type'] === 'timestamp with time zone', 'B2 end_at is timestamptz (absolute instant)');

    await db.exec(`insert into public.livetv_epg_sources (id, slug, name, source_url, enabled, status) values ('${epgSourceId}', 'probe-guide', 'Probe Guide', 'https://guides.example/guide.xml', true, 'active')`);

    // Window ordering is enforced, not assumed.
    const reversed = await tryExec(`insert into public.livetv_epg_programmes (epg_source_id, epg_channel_id, start_at, end_at, title)
      values ('${epgSourceId}', 'c1', '2026-01-10T02:00:00Z', '2026-01-10T01:00:00Z', 'Reversed')`);
    ok(!reversed.ok, 'B3 end_at <= start_at is rejected (windows are forward-ordered)', reversed.message);

    const zeroLen = await tryExec(`insert into public.livetv_epg_programmes (epg_source_id, epg_channel_id, start_at, end_at, title)
      values ('${epgSourceId}', 'c1', '2026-01-10T01:00:00Z', '2026-01-10T01:00:00Z', 'ZeroLen')`);
    ok(!zeroLen.ok, 'B3 zero-length windows are rejected');

    // Title bounds.
    const longTitle = await tryExec(`insert into public.livetv_epg_programmes (epg_source_id, epg_channel_id, start_at, end_at, title)
      values ('${epgSourceId}', 'c1', '2026-01-10T01:00:00Z', '2026-01-10T02:00:00Z', '${'X'.repeat(501)}')`);
    ok(!longTitle.ok, 'B4 an over-cap title is rejected (500 max)');
    const blankTitle = await tryExec(`insert into public.livetv_epg_programmes (epg_source_id, epg_channel_id, start_at, end_at, title)
      values ('${epgSourceId}', 'c1', '2026-01-10T01:00:00Z', '2026-01-10T02:00:00Z', '   ')`);
    ok(!blankTitle.ok, 'B4 a blank title is rejected');

    // Guide-id shape (parity with the Phase 1 identity columns).
    const spacedId = await tryExec(`insert into public.livetv_epg_programmes (epg_source_id, epg_channel_id, start_at, end_at, title)
      values ('${epgSourceId}', 'bad id', '2026-01-10T01:00:00Z', '2026-01-10T02:00:00Z', 'T')`);
    ok(!spacedId.ok, 'B5 a whitespace-bearing guide channel id is rejected', spacedId.message);

    // https-only icon URLs (every stored URL in this family is https).
    const httpIcon = await tryExec(`insert into public.livetv_epg_programmes (epg_source_id, epg_channel_id, start_at, end_at, title, icon_url)
      values ('${epgSourceId}', 'c1', '2026-01-10T01:00:00Z', '2026-01-10T02:00:00Z', 'T', 'http://cdn.example/icon.png')`);
    ok(!httpIcon.ok, 'B6 a non-https icon URL is rejected');
    const okIcon = await tryExec(`insert into public.livetv_epg_programmes (epg_source_id, epg_channel_id, start_at, end_at, title, icon_url)
      values ('${epgSourceId}', 'c1', '2026-01-10T01:00:00Z', '2026-01-10T02:00:00Z', 'Icon Show', 'https://cdn.example/icon.png')`);
    ok(okIcon.ok, 'B6 a genuine https icon URL is accepted', okIcon.message);
  }

  // -------------------------------------------------------------------------
  console.log('PHASE C — idempotent upserts + FK cascade');
  // -------------------------------------------------------------------------
  {
    // THE idempotency mechanism at the DB level.
    await db.exec(`
      insert into public.livetv_epg_programmes (epg_source_id, epg_channel_id, start_at, end_at, title)
      values ('${epgSourceId}', 'ch.x', '2026-01-10T03:00:00Z', '2026-01-10T04:00:00Z', 'Original')
      on conflict (epg_source_id, epg_channel_id, start_at, end_at) do update set title = excluded.title
    `);
    await db.exec(`
      insert into public.livetv_epg_programmes (epg_source_id, epg_channel_id, start_at, end_at, title, description)
      values ('${epgSourceId}', 'ch.x', '2026-01-10T03:00:00Z', '2026-01-10T04:00:00Z', 'Corrected', 'New description')
      on conflict (epg_source_id, epg_channel_id, start_at, end_at) do update set title = excluded.title, description = excluded.description
    `);
    const rows = await q(`select title, description from public.livetv_epg_programmes where epg_channel_id = 'ch.x'`);
    ok(rows.length === 1, 'C1 the repeat import created NO duplicate row (unique constraint convergence)');
    ok(rows[0]!['title'] === 'Corrected' && rows[0]!['description'] === 'New description', 'C1 the upsert updated the changed fields in place');

    // FK cascade: removing the guide source removes exactly its programmes.
    await db.exec(`insert into public.livetv_epg_sources (id, slug, name, source_url) values ('${'eeeeeeee-0000-0000-0000-000000000002'}', 'probe-guide-2', 'Probe Guide 2', 'https://guides.example/two.xml')`);
    await db.exec(`insert into public.livetv_epg_programmes (epg_source_id, epg_channel_id, start_at, end_at, title)
      values ('eeeeeeee-0000-0000-0000-000000000002', 'ch.y', '2026-01-10T05:00:00Z', '2026-01-10T06:00:00Z', 'Other Source Show')`);
    const beforeCount = Number((await q(`select count(*) as n from public.livetv_epg_programmes`))[0]!['n']);
    ok(beforeCount === 3, 'C2 three programme rows across two guide sources before the cascade');
    await db.exec(`delete from public.livetv_epg_sources where id = 'eeeeeeee-0000-0000-0000-000000000002'`);
    const remaining = await q(`select epg_channel_id from public.livetv_epg_programmes order by epg_channel_id`);
    ok(remaining.length === 2 && remaining.every((row) => row['epg_channel_id'] !== 'ch.y'), 'C2 deleting a guide source cascades ONLY its own programmes');
    // The Phase 1 mapping table is untouched by programme data.
    const mappingCount = Number((await q(`select count(*) as n from public.livetv_epg_channel_mappings`))[0]!['n']);
    ok(mappingCount === 0, 'C3 programme ingestion never touches the mapping table (separate concerns)');
  }

  // -------------------------------------------------------------------------
  console.log('PHASE D — RLS: fail-closed, admin-only');
  // -------------------------------------------------------------------------
  {
    const rls = await q(`select relname, relrowsecurity from pg_class
      where relnamespace = 'public'::regnamespace and relname = 'livetv_epg_programmes'`);
    ok(rls.length === 1 && rls[0]!['relrowsecurity'] === true, 'D1 RLS is enabled on livetv_epg_programmes');

    const policies = await q(`select policyname, cmd, roles from pg_policies
      where schemaname = 'public' and tablename = 'livetv_epg_programmes'`);
    ok(policies.length === 1 && String(policies[0]!['policyname']).endsWith('_admin_all'), 'D2 exactly one admin_all policy exists');
    ok(Array.isArray(policies[0]!['roles']) && (policies[0]!['roles'] as string[]).includes('authenticated') && (policies[0]!['roles'] as string[]).length === 1, 'D2 the policy targets authenticated only (no anon policy — fail-closed)');

    const anonGrants = await q(`select privilege_type from information_schema.role_table_grants
      where table_schema = 'public' and table_name = 'livetv_epg_programmes' and grantee = 'anon'`);
    ok(anonGrants.length === 0, 'D3 anon has NO grants on livetv_epg_programmes');

    await db.exec(`create role probe_admin3 login; grant usage on schema public to probe_admin3;`);
    await db.exec(`set role probe_admin3;`);
    const isAdmin = await q(`select public.is_admin() as ok`);
    ok(isAdmin.length === 1 && isAdmin[0]!['ok'] === false, 'D4 is_admin() resolves FALSE outside an admin JWT session');
    // Simulate an ordinary (non-admin) authenticated role with default grants:
    // RLS must filter the table to ZERO rows, not leak them.
    await db.exec(`reset role;`);
    await db.exec(`grant select on public.livetv_epg_programmes to probe_admin3;`);
    await db.exec(`set role probe_admin3;`);
    const deniedRows = await q(`select count(*) as n from public.livetv_epg_programmes`);
    ok(Number(deniedRows[0]!['n']) === 0, 'D4 a granted non-admin role sees ZERO programme rows (RLS fail-closed)');
    const deniedWrite = await tryExec(`insert into public.livetv_epg_programmes (epg_source_id, epg_channel_id, start_at, end_at, title) values ('${epgSourceId}', 'hax', now(), now() + interval '1 hour', 'Nope')`);
    ok(!deniedWrite.ok, 'D4 a non-admin role CANNOT write programmes (no policy permits it)');
    await db.exec(`reset role;`);
  }

  // -------------------------------------------------------------------------
  console.log('PHASE E — triggers (updated_at + config version)');
  // -------------------------------------------------------------------------
  {
    const versionBefore = Number((await q(`select version from public.livetv_config_meta where id = 1`))[0]!['version']);
    // PGlite's now() is transaction-stable — give the update a distinct
    // transaction timestamp before comparing.
    await new Promise((resolve) => setTimeout(resolve, 10));
    await db.exec(`update public.livetv_epg_programmes set title = 'Renamed' where epg_channel_id = 'ch.x'`);
    const row = await q(`select title, (updated_at > created_at) as advances, updated_at, created_at from public.livetv_epg_programmes where epg_channel_id = 'ch.x'`);
    ok(row[0]!['title'] === 'Renamed', 'E1 the update applied');
    ok(row[0]!['advances'] === true, 'E1 set_updated_at maintains updated_at on programme updates (DB-evaluated)');
    const versionAfter = Number((await q(`select version from public.livetv_config_meta where id = 1`))[0]!['version']);
    ok(versionAfter > versionBefore, 'E2 programme writes bump the unified config version (versioned-cache pattern)');
  }

  // -------------------------------------------------------------------------
  console.log('PHASE F — retention semantics on real timestamps');
  // -------------------------------------------------------------------------
  {
    const nowIso = new Date().toISOString();
    await db.exec(`
      insert into public.livetv_epg_programmes (epg_source_id, epg_channel_id, start_at, end_at, title) values
        ('${epgSourceId}', 'ch.ret', now() - interval '48 hours', now() - interval '47 hours', 'Expired Past'),
        ('${epgSourceId}', 'ch.ret', now() - interval '2 hours',  now() - interval '1 hour',  'Grace Past'),
        ('${epgSourceId}', 'ch.ret', now() - interval '30 minutes', now() + interval '30 minutes', 'Current'),
        ('${epgSourceId}', 'ch.ret', now() + interval '2 hours',  now() + interval '3 hours',  'Upcoming')
      on conflict (epg_source_id, epg_channel_id, start_at, end_at) do nothing
    `);
    // The documented sweep predicate: strictly-past end_at beyond the cutoff
    // (scoped to this phase's channel so earlier fixture rows don't interfere).
    const doomed = await q(`select title from public.livetv_epg_programmes where epg_source_id = '${epgSourceId}' and epg_channel_id = 'ch.ret' and end_at < '${nowIso}'::timestamptz - interval '24 hours' order by title`);
    ok(doomed.length === 1 && doomed[0]!['title'] === 'Expired Past', 'F1 the retention predicate reaches ONLY the fully-expired window');
    const currentOrFuture = await q(`select count(*) as n from public.livetv_epg_programmes
      where epg_source_id = '${epgSourceId}' and epg_channel_id = 'ch.ret' and end_at >= '${nowIso}'`);
    ok(Number(currentOrFuture[0]!['n']) === 2, 'F2 current + upcoming rows are structurally unreachable by the cutoff');

    // Retention indexes exist for the two access patterns.
    const indexes = await q(`select indexname from pg_indexes
      where schemaname = 'public' and tablename = 'livetv_epg_programmes' order by indexname`);
    const indexNames = indexes.map((row) => String(row['indexname']));
    ok(indexNames.includes('livetv_epg_programmes_window_idx'), 'F3 the window-query index exists (source, channel, start)');
    ok(indexNames.includes('livetv_epg_programmes_retention_idx'), 'F3 the retention-sweep index exists (source, end)');
  }

  console.log(`\nLIVETV PHASE 3 MIGRATION TESTS: ${passed} checks passed`);
  if (passed === 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
