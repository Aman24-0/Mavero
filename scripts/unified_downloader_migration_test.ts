/**
 * FINAL TASK — migration verification on embedded PostgreSQL (PGlite).
 *
 * Verifies migration 20261004000000_unified_downloader_global_order.sql:
 *
 *   PHASE A — the migration applies cleanly over a realistic pre-state:
 *     * streaming_addons (10 rows, dense 0..9 ordering — the LIVE shape)
 *     * cloudstream_repositories (2 repos, one disabled) +
 *       cloudstream_extensions (4 rows, 2 enabled — the live shape: only
 *       Bollyflix + MoviesDrive enabled) + the minimal columns the
 *       backfill reads
 *     * download_providers (mavero-downloader + mavero-downloader-2 rows)
 *   PHASE B — post-state invariants:
 *     * downloader_source_order backfilled: ALL 10 addons first (positions
 *       1..10 in the EXACT live order), then the 2 enabled extensions in
 *       catalog order (11, 12); the disabled repo's rows are excluded
 *     * RLS: admin-only CRUD (anon has no policy, admin passes)
 *     * the mavero-downloader-2 provider row is DISABLED (retired); the
 *       mavero-downloader row is UNTOUCHED
 *   PHASE C — the RPC contract:
 *     * admin gate (non-admin rejected)
 *     * position validation (0 / out-of-range rejected with a message)
 *     * MOVE: existing key to position N → dense renumber, others shift
 *     * INSERT: unknown key at position N → appended/inserted densely
 *     * ADDON RESYNC: an addon move resyncs streaming_addons.ordering to
 *       the addon-relative dense ranks
 *     * idempotent no-op: move to current position changes nothing
 *   PHASE D — re-running the migration on the populated table: backfill
 *     skipped, positions preserved (idempotence).
 *   PHASE E — a PRE-migration apply on an EMPTY catalog (fresh project):
 *     backfill writes zero rows, everything else still applies.
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
const read = (relative: string) => readFileSync(path.join(REPO_ROOT, relative), 'utf8');
const MIGRATION = 'supabase/migrations/20261004000000_unified_downloader_global_order.sql';

type Row = Record<string, unknown>;

const A1 = '11111111-1111-1111-1111-111111111111';
const A2 = '22222222-2222-2222-2222-222222222222';
const A3 = '33333333-3333-3333-3333-333333333333';
const A4 = '44444444-4444-4444-4444-444444444444';
const A5 = '55555555-5555-5555-5555-555555555555';
const A6 = '66666666-6666-6666-6666-666666666666';
const A7 = '77777777-7777-7777-7777-777777777777';
const A8 = '88888888-8888-8888-8888-888888888888';
const A9 = '99999999-9999-9999-9999-999999999999';
const A10 = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const ADMIN = 'baaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const USER = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

async function main() {
  const db = new PGlite();
  const exec = (sql: string) => db.exec(sql);
  async function q(sql: string): Promise<Row[]> {
    const res = await db.query<Row>(sql);
    return (res.rows ?? []) as Row[];
  }
  async function tryRpc(fn: string, args: Record<string, unknown>): Promise<{ ok: boolean; value: unknown; message: string }> {
    try {
      const res = await db.query<Row>(`select ${fn}(${Object.entries(args).map(([k, v]) => `${k} := ${typeof v === 'number' ? v : `'${String(v).replace(/'/g, "''")}'`}`).join(', ')}) as result;`);
      return { ok: true, value: res.rows?.[0]?.['result'], message: '' };
    } catch (e) {
      const err = e as { message?: string };
      return { ok: false, value: null, message: String(err.message ?? e) };
    }
  }

  // ── Harness: auth stub + roles + profiles (Supabase stand-ins) ──
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
    create table if not exists public.profiles (id uuid primary key, role text not null default 'user');
    create or replace function public.is_admin()
    returns boolean language sql stable security definer set search_path = public
    as $$ select exists (select 1 from public.profiles where id = (select auth.uid()) and role = 'admin') $$;
    create or replace function public.set_updated_at() returns trigger language plpgsql
    as $$ begin new.updated_at = timezone('utc', now()); return new; end $$;
    insert into public.profiles (id, role) values ('${ADMIN}', 'admin'), ('${USER}', 'user');
    create or replace function public.auth_uid_of(p uuid) returns uuid language sql as $$ select p $$;
  `);
  // auth.uid() override per session: PGlite has no set_config-based auth.uid
  // here, so tests switch identity by redefining the stub before each call.
  const setUid = async (uuid: string | null) => {
    const value = uuid === null ? 'null::uuid' : `'${uuid}'::uuid`;
    await exec(`create or replace function auth.uid() returns uuid language sql as $$ select ${value} $$;`);
  };

  console.log('=== FINAL TASK migration verification (PGlite) ===\n');
  console.log('PHASE A — pre-state + apply');

  // ── The pre-state (the LIVE shape, minimal columns) ──
  await exec(`
    create table public.streaming_addons (
      id uuid primary key,
      name text not null,
      slug text not null,
      enabled boolean not null default true,
      status text not null default 'experimental',
      ordering integer not null default 0,
      created_at timestamptz not null default now()
    );
    insert into public.streaming_addons (id, name, slug, enabled, status, ordering) values
      ('${A1}', 'PenguPlay', 'penguplay', true, 'experimental', 0),
      ('${A2}', 'HdHub', 'hdhub', true, 'experimental', 1),
      ('${A3}', 'AIOStreams', 'aiostreams', true, 'experimental', 2),
      ('${A4}', 'CNCVerse Bridge', 'cncverse-bridge', true, 'experimental', 3),
      ('${A5}', '[HS+] Sootio', 'hs-sootio', true, 'experimental', 4),
      ('${A6}', 'Flix-Streams Free', 'flix-streams-free', true, 'experimental', 5),
      ('${A7}', 'Orion', 'orion', true, 'experimental', 6),
      ('${A8}', 'Showbox', 'showbox', true, 'experimental', 7),
      ('${A9}', 'DesiFlix', 'desiflix', true, 'experimental', 8),
      ('${A10}', 'FebBox Addon', 'febbox-addon', true, 'experimental', 9);

    create table public.cloudstream_repositories (
      id uuid primary key,
      name text not null,
      url text not null,
      enabled boolean not null default false,
      created_at timestamptz not null default now()
    );
    insert into public.cloudstream_repositories (id, name, url, enabled) values
      ('aaaaaaa1-0000-0000-0000-000000000001', 'Megix', 'https://megix.example/CS.json', true),
      ('aaaaaaa2-0000-0000-0000-000000000002', 'DeadRepo', 'https://dead.example/CS.json', false);

    create table public.cloudstream_extensions (
      id uuid primary key,
      repository_id uuid not null,
      internal_name text not null,
      name text,
      enabled boolean not null default false,
      integration_type text not null default 'cloudstream'
    );
    insert into public.cloudstream_extensions (id, repository_id, internal_name, name, enabled, integration_type) values
      ('bbbbbbb1-0000-0000-0000-000000000001', 'aaaaaaa1-0000-0000-0000-000000000001', 'Bollyflix', 'Bollyflix', true, 'cloudstream'),
      ('bbbbbbb2-0000-0000-0000-000000000002', 'aaaaaaa1-0000-0000-0000-000000000001', 'MoviesDrive', 'MoviesDrive', true, 'cloudstream'),
      ('bbbbbbb3-0000-0000-0000-000000000003', 'aaaaaaa1-0000-0000-0000-000000000001', 'VegaMovies', 'VegaMovies', false, 'cloudstream'),
      ('bbbbbbb4-0000-0000-0000-000000000004', 'aaaaaaa2-0000-0000-0000-000000000002', 'OtherExt', 'OtherExt', true, 'cloudstream');

    create table public.download_providers (
      slug text primary key,
      name text not null,
      enabled boolean not null default true,
      is_default boolean not null default false
    );
    insert into public.download_providers (slug, name, enabled, is_default) values
      ('mavero-downloader', 'Mavero Downloader', true, true),
      ('mavero-downloader-2', 'Mavero Downloader 2', true, false);
  `);

  // ── Apply the migration ──
  try {
    await exec(read(MIGRATION));
    ok(true, 'the migration applies cleanly over the live-shaped pre-state');
  } catch (e) {
    assert.fail(`migration failed: ${(e as Error).message}`);
  }

  console.log('\nPHASE B — post-state invariants');

  let order = await q('select source_key, position from public.downloader_source_order order by position asc');
  ok(order.length === 12, `backfill: 12 rows (10 addons + 2 enabled extensions), got ${order.length}`);
  const expectedBackfill = [
    `addon:${A1}`, `addon:${A2}`, `addon:${A3}`, `addon:${A4}`, `addon:${A5}`,
    `addon:${A6}`, `addon:${A7}`, `addon:${A8}`, `addon:${A9}`, `addon:${A10}`,
    'extension:cloudstream:bollyflix', 'extension:cloudstream:moviesdrive',
  ];
  ok(
    order.map((row) => String(row['source_key'])).join('|') === expectedBackfill.join('|'),
    'backfill order: addons 1..10 in the EXACT live order, then enabled extensions in catalog order',
    order.map((row) => row['source_key']).join('|'),
  );
  const dense = order.map((row) => Number(row['position']));
  ok(dense.every((value, index) => value === index + 1), 'backfill positions are dense 1..N');

  // RLS: the admin policy path (is_admin) — verify the policy exists and
  // anon has no grants (static posture checks; role-switching in PGlite
  // needs set role, which the RPC gate exercises functionally below).
  const policies = await q("select policyname from pg_policies where tablename = 'downloader_source_order'");
  ok(policies.length === 1 && String(policies[0]?.['policyname']) === 'downloader_source_order_admin_all', 'RLS: exactly the admin_all policy exists');
  const grants = await q("select privilege_type from information_schema.role_table_grants where table_name = 'downloader_source_order' and grantee = 'anon'");
  ok(grants.length === 0, 'RLS: anon has zero table grants');

  const providers = await q('select slug, enabled, is_default from public.download_providers order by slug');
  const m2 = providers.find((row) => row['slug'] === 'mavero-downloader-2');
  const m1 = providers.find((row) => row['slug'] === 'mavero-downloader');
  ok(m2 !== undefined && m2['enabled'] === false, 'retire: the mavero-downloader-2 row is disabled');
  ok(m1 !== undefined && m1['enabled'] === true && m1['is_default'] === true, 'retire: the mavero-downloader row is untouched (enabled + default)');

  console.log('\nPHASE C — the RPC contract');

  // Admin gate: a non-admin is rejected.
  await setUid(USER);
  let gate = await tryRpc('public.set_downloader_source_position', { p_source_key: `addon:${A1}`, p_position: 1 });
  ok(!gate.ok && /not authorized/i.test(gate.message), 'RPC: non-admin rejected with the authorization message', gate.message);

  // Anonymous (no uid) is rejected too.
  await setUid(null);
  gate = await tryRpc('public.set_downloader_source_position', { p_source_key: `addon:${A1}`, p_position: 1 });
  ok(!gate.ok && /not authorized/i.test(gate.message), 'RPC: anonymous rejected');
  await setUid(ADMIN);

  // Validation: malformed key.
  let validation = await tryRpc('public.set_downloader_source_position', { p_source_key: 'bogus-key', p_position: 1 });
  ok(!validation.ok && /invalid/i.test(validation.message), 'RPC: malformed source key rejected');
  // Validation: position 0.
  validation = await tryRpc('public.set_downloader_source_position', { p_source_key: `addon:${A1}`, p_position: 0 });
  ok(!validation.ok && /invalid|between/i.test(validation.message), 'RPC: position 0 rejected');
  // Validation: out-of-range position.
  validation = await tryRpc('public.set_downloader_source_position', { p_source_key: `addon:${A1}`, p_position: 99 });
  ok(!validation.ok && /between 1 and 12/i.test(validation.message), 'RPC: out-of-range position rejected with the range message', validation.message);

  // MOVE: MoviesDrive (extension, position 12) → position 2.
  let move = await tryRpc('public.set_downloader_source_position', { p_source_key: 'extension:cloudstream:moviesdrive', p_position: 2 });
  ok(move.ok && move.value === 2, 'RPC: extension move to position 2 returns 2');
  order = await q('select source_key, position from public.downloader_source_order order by position asc');
  const afterMove = [
    `addon:${A1}`,
    'extension:cloudstream:moviesdrive',
    `addon:${A2}`, `addon:${A3}`, `addon:${A4}`, `addon:${A5}`,
    `addon:${A6}`, `addon:${A7}`, `addon:${A8}`, `addon:${A9}`, `addon:${A10}`,
    'extension:cloudstream:bollyflix',
  ];
  ok(order.map((row) => String(row['source_key'])).join('|') === afterMove.join('|'), 'RPC: the move shifts everything else by exactly one (dense 1..12)');
  // The addon-relative order is UNCHANGED by an extension move.
  const addonOrdering = await q('select id, ordering from public.streaming_addons order by ordering asc');
  ok(addonOrdering.map((row) => String(row['id'])).join('|') === [A1, A2, A3, A4, A5, A6, A7, A8, A9, A10].join('|'), 'RPC: extension move does NOT touch streaming_addons.ordering');

  // ADDON MOVE + RESYNC: move addon A7 (position 8 after the shift) → position 1.
  move = await tryRpc('public.set_downloader_source_position', { p_source_key: `addon:${A7}`, p_position: 1 });
  ok(move.ok && move.value === 1, 'RPC: addon move to position 1 returns 1');
  order = await q('select source_key, position from public.downloader_source_order order by position asc');
  ok(String(order[0]?.['source_key']) === `addon:${A7}` && String(order[1]?.['source_key']) === `addon:${A1}`, 'RPC: the addon now leads the global order');
  // The resync: streaming_addons.ordering must equal the addon-relative dense ranks.
  const resynced = await q('select id, ordering from public.streaming_addons order by ordering asc');
  const expectedAddonRanks = [A7, A1, A2, A3, A4, A5, A6, A8, A9, A10];
  ok(resynced.map((row) => String(row['id'])).join('|') === expectedAddonRanks.join('|'), 'RPC: streaming_addons.ordering resynced to the addon-relative dense ranks');
  ok(resynced.every((row, index) => Number(row['ordering']) === index), 'RPC: resynced ordering values are dense 0..M-1');

  // INSERT: an unknown (but well-formed) key at a position.
  const NEW_KEY = 'extension:nuvio:futureplugin';
  move = await tryRpc('public.set_downloader_source_position', { p_source_key: NEW_KEY, p_position: 3 });
  ok(move.ok && move.value === 3, 'RPC: unknown key inserts at position 3');
  order = await q('select source_key, position from public.downloader_source_order order by position asc');
  ok(order.length === 13, 'RPC: the table now holds 13 rows');
  ok(String(order[2]?.['source_key']) === NEW_KEY, 'RPC: the new key occupies position 3 exactly');
  const positionsNow = order.map((row) => Number(row['position']));
  ok(positionsNow.every((value, index) => value === index + 1), 'RPC: positions remain dense after the insert');

  // Idempotent no-op: move to the current position.
  move = await tryRpc('public.set_downloader_source_position', { p_source_key: NEW_KEY, p_position: 3 });
  ok(move.ok && move.value === 3, 'RPC: move-to-current-position is a no-op returning 3');
  order = await q('select source_key, position from public.downloader_source_order order by position asc');
  ok(String(order[2]?.['source_key']) === NEW_KEY && order.length === 13, 'RPC: the no-op leaves the order untouched');

  console.log('\nPHASE D — migration re-run (idempotence)');

  // Record the current order, re-apply the migration, compare.
  const before = (await q('select source_key, position from public.downloader_source_order order by position asc')).map((row) => `${row['source_key']}=${row['position']}`).join('|');
  try {
    await exec(read(MIGRATION));
    ok(true, 'the migration re-applies cleanly');
  } catch (e) {
    assert.fail(`migration re-run failed: ${(e as Error).message}`);
  }
  const after = (await q('select source_key, position from public.downloader_source_order order by position asc')).map((row) => `${row['source_key']}=${row['position']}`).join('|');
  ok(before === after, 're-run: the populated table is untouched (backfill skipped)');

  console.log('\nPHASE E — fresh-project apply (empty catalog)');

  const db2 = new PGlite();
  await db2.exec(`
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
    create table if not exists public.profiles (id uuid primary key, role text not null default 'user');
    create or replace function public.is_admin() returns boolean language sql stable security definer set search_path = public
    as $$ select exists (select 1 from public.profiles where id = (select auth.uid()) and role = 'admin') $$;
    create or replace function public.set_updated_at() returns trigger language plpgsql
    as $$ begin new.updated_at = timezone('utc', now()); return new; end $$;
    create table public.streaming_addons (id uuid primary key, name text not null, slug text not null, enabled boolean not null default true, status text not null default 'experimental', ordering integer not null default 0, created_at timestamptz not null default now());
    create table public.cloudstream_repositories (id uuid primary key, name text not null, url text not null, enabled boolean not null default false, created_at timestamptz not null default now());
    create table public.cloudstream_extensions (id uuid primary key, repository_id uuid not null, internal_name text not null, name text, enabled boolean not null default false, integration_type text not null default 'cloudstream');
    create table public.download_providers (slug text primary key, name text not null, enabled boolean not null default true, is_default boolean not null default false);
  `);
  try {
    await db2.exec(read(MIGRATION));
    ok(true, 'fresh project: the migration applies cleanly with zero catalog rows');
  } catch (e) {
    assert.fail(`fresh apply failed: ${(e as Error).message}`);
  }
  const freshRows = (await db2.query<Row>('select count(*)::int as n from public.downloader_source_order')).rows ?? [];
  ok(Number(freshRows[0]?.['n']) === 0, 'fresh project: the backfill writes zero rows (deterministic empty init)');

  console.log(`\n=== migration verification: ${passed} checks PASSED ===`);
}

main().catch((error) => {
  console.error('FAILED:', error instanceof Error ? error.message : error);
  process.exit(1);
});
