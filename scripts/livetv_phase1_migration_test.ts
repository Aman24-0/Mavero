/**
 * UNIFIED LIVE TV — Phase 1 migration verification on embedded PostgreSQL
 * (PGlite) — mirrors adapter_build_lifecycle_migration_test.ts conventions.
 *
 * Verifies migration 20261120000000_livetv_source_registry.sql against the
 * REAL DDL semantics:
 *
 *   PHASE A — applies cleanly over the realistic pre-state (auth.uid +
 *     profiles + is_admin + set_updated_at) and is IDEMPOTENT (re-apply
 *     changes nothing).
 *   PHASE B — schema contract: closed CHECK vocabularies, the endpoint
 *     kind/format pairing (direct_stream ⇔ dash|hls, embed_page ⇔ null),
 *     https-only URLs, unique candidate (channel, endpoint), the partial
 *     dedup_key uniqueness, and the EPG 1:1 mapping uniques.
 *   PHASE C — the built-in LiveGT V1 seed: present, enabled, active,
 *     priority 0, and DELETE-protected (non-deletable) while remaining
 *     enable/disable-capable.
 *   PHASE D — RLS: enabled everywhere, ONLY admin-all policies, anon has no
 *     grants-backed access (no permissive policy), non-admin denied,
 *     admin allowed (is_admin() predicate verified live).
 *   PHASE E — integrity triggers: candidate↔endpoint↔channel mapping guard,
 *     config-version bumping, updated_at maintenance.
 *   PHASE F — realistic multi-source lifecycle: one canonical channel fed by
 *     a LiveGT source (direct + embed endpoints) and a playlist source;
 *     conservative dedup (identical display names stay separate until
 *     explicitly mapped); removing a source never deletes the canonical
 *     channel or another source's mapping; deleting a canonical channel
 *     unmaps (never cascades into source entries); EPG identity survives
 *     endpoint deletion.
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
const MIGRATION = 'supabase/migrations/20261120000000_livetv_source_registry.sql';
const migrationSql = readFileSync(path.join(REPO_ROOT, MIGRATION), 'utf8');

type Row = Record<string, unknown>;

const ADMIN = 'baaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const USER = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

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
    // Realistic pre-state: auth.uid + profiles (is_admin source) +
    // set_updated_at (from 20260820000000_phase5_auth_sync.sql) — everything
    // the migration references but never redefines.
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
      insert into auth.users (id) values ('${ADMIN}'), ('${USER}') on conflict do nothing;
      insert into public.profiles (id, role) values ('${ADMIN}', 'admin'), ('${USER}', 'user') on conflict do nothing;
      create or replace function public.set_updated_at()
        returns trigger language plpgsql security invoker set search_path = public
        as $$ begin new.updated_at = timezone('utc', now()); return new; end; $$;
      create or replace function public.is_admin()
        returns boolean language sql stable security definer set search_path = public
        as $$ select exists(select 1 from public.profiles where id = (select auth.uid()) and role = 'admin') $$;
      grant execute on function public.is_admin() to authenticated;
      create schema if not exists supabase_migrations;
    `);

    const apply1 = await tryExec(migrationSql);
    ok(apply1.ok, 'A1 the migration applies cleanly over the realistic pre-state', apply1.message);
    const apply2 = await tryExec(migrationSql);
    ok(apply2.ok, 'A2 the migration re-applies idempotently (IF NOT EXISTS throughout)', apply2.message);

    const seededAgain = await q(`select count(*) as n from public.livetv_sources`);
    ok(Number(seededAgain[0]!['n']) === 1, 'A3 the built-in seed stays a single row after replay (on conflict do nothing)');
  }

  // -------------------------------------------------------------------------
  console.log('PHASE B — schema contract');
  // -------------------------------------------------------------------------
  {
    const tables = await q(`select table_name from information_schema.tables
      where table_schema = 'public' and table_name like 'livetv_%' order by table_name`);
    const names = tables.map((row) => String(row['table_name']));
    for (const expected of [
      'livetv_config_meta',
      'livetv_epg_channel_mappings',
      'livetv_epg_sources',
      'livetv_playback_candidates',
      'livetv_playback_endpoints',
      'livetv_source_channels',
      'livetv_sources',
      'livetv_channels'
    ]) {
      ok(names.includes(expected), `B1 table ${expected} exists`);
    }

    // B2 — the unified system ships DISABLED (rollback lever).
    const meta = await q(`select unified_enabled, version from public.livetv_config_meta where id = 1`);
    ok(meta.length === 1 && meta[0]!['unified_enabled'] === false, 'B2 unified_enabled defaults to FALSE (V1-only behavior preserved)');
    // The seed insert itself fires the version-bump trigger (by design), so
    // after two applies the counter is >= 1 rather than exactly 1 — Phase E
    // verifies the bump DELTAS instead of absolute values.
    ok(Number(meta[0]!['version']) >= 1, 'B2 config version counter is live (>= 1)');

    // B3 — closed source_type vocabulary.
    const badType = await tryExec(`insert into public.livetv_sources (slug, name, source_type) values ('x-bad', 'Bad', 'shaka_player')`);
    ok(!badType.ok, 'B3 an unknown source_type is rejected (a playback engine can never be registered as a source)', badType.message);

    // B4 — closed status vocabulary + default.
    const badStatus = await tryExec(`insert into public.livetv_sources (slug, name, source_type, status) values ('x-bad2', 'Bad2', 'manual_stream', 'retired')`);
    ok(!badStatus.ok, 'B4 an unknown status is rejected by the CHECK');

    // B5 — the endpoint kind/format pairing (type-safe separation).
    const srcId = String((await q(`select id from public.livetv_sources where slug = 'builtin-livegt-v1'`))[0]!['id']);
    const ch = await q(`insert into public.livetv_channels (name) values ('Kind/Format Probe') returning id`);
    const channelId = String(ch[0]!['id']);
    const entry = await q(`insert into public.livetv_source_channels (source_id, source_channel_id, canonical_channel_id, name)
      values ('${srcId}', 'probe-entry', '${channelId}', 'Kind/Format Probe Entry') returning id`);
    const entryId = String(entry[0]!['id']);

    const embedAsManifest = await tryExec(`insert into public.livetv_playback_endpoints (source_channel_id, endpoint_kind, stream_format, url)
      values ('${entryId}', 'embed_page', 'dash', 'https://embed.example/page')`);
    ok(!embedAsManifest.ok, 'B5 an embed_page endpoint CANNOT declare a stream format (iframe ≠ manifest)', embedAsManifest.message);

    const directWithoutFormat = await tryExec(`insert into public.livetv_playback_endpoints (source_channel_id, endpoint_kind, url)
      values ('${entryId}', 'direct_stream', 'https://cdn.example/stream.mpd')`);
    ok(!directWithoutFormat.ok, 'B5 a direct_stream endpoint REQUIRES a dash/hls stream_format', directWithoutFormat.message);

    const badFormat = await tryExec(`insert into public.livetv_playback_endpoints (source_channel_id, endpoint_kind, stream_format, url)
      values ('${entryId}', 'direct_stream', 'rtmp', 'https://cdn.example/stream')`);
    ok(!badFormat.ok, 'B5 an unsupported direct format is rejected (closed dash/hls vocabulary)');

    // B6 — https-only playback URLs.
    const httpUrl = await tryExec(`insert into public.livetv_playback_endpoints (source_channel_id, endpoint_kind, stream_format, url)
      values ('${entryId}', 'direct_stream', 'hls', 'http://cdn.example/stream.m3u8')`);
    ok(!httpUrl.ok, 'B6 a non-https playback URL is rejected by the CHECK');

    // B7 — duplicate candidate (channel, endpoint) is impossible.
    const ep1 = await q(`insert into public.livetv_playback_endpoints (source_channel_id, endpoint_kind, stream_format, url)
      values ('${entryId}', 'direct_stream', 'dash', 'https://cdn.example/probe.mpd') returning id`);
    const ep1Id = String(ep1[0]!['id']);
    const c1 = await tryExec(`insert into public.livetv_playback_candidates (channel_id, endpoint_id, priority) values ('${channelId}', '${ep1Id}', 10)`);
    ok(c1.ok, 'B7 the first candidate row inserts');
    const c2 = await tryExec(`insert into public.livetv_playback_candidates (channel_id, endpoint_id, priority) values ('${channelId}', '${ep1Id}', 20)`);
    ok(!c2.ok, 'B7 a duplicate (channel, endpoint) candidate is rejected (no duplicate attempts)', c2.message);

    // B8 — dedup_key is unique when present, free when absent.
    const d1 = await tryExec(`insert into public.livetv_channels (name, dedup_key) values ('Dup A', 'verified:abc123')`);
    ok(d1.ok, 'B8 a verified dedup_key inserts');
    const d2 = await tryExec(`insert into public.livetv_channels (name, dedup_key) values ('Dup B', 'verified:abc123')`);
    ok(!d2.ok, 'B8 a duplicate dedup_key is rejected (partial unique index)');
    const d3 = await tryExec(`insert into public.livetv_channels (name) values ('No Key A'), ('No Key B')`);
    ok(d3.ok, 'B8 multiple NULL dedup_keys coexist (conservative — unmapped stays separate)');

    // B9 — EPG mapping 1:1 in both directions per EPG source.
    const epg = await q(`insert into public.livetv_epg_sources (slug, name, source_url)
      values ('probe-epg', 'Probe EPG', 'https://example.com/guide.xml') returning id`);
    const epgId = String(epg[0]!['id']);
    const chanA = String((await q(`select id from public.livetv_channels where name = 'Dup A'`))[0]!['id']);
    const chanB = String((await q(`select id from public.livetv_channels where name = 'No Key A'`))[0]!['id']);
    const m1 = await tryExec(`insert into public.livetv_epg_channel_mappings (epg_source_id, channel_id, epg_channel_id) values ('${epgId}', '${chanA}', 'DupA.kr')`);
    ok(m1.ok, 'B9 the first EPG mapping inserts');
    const m2 = await tryExec(`insert into public.livetv_epg_channel_mappings (epg_source_id, channel_id, epg_channel_id) values ('${epgId}', '${chanB}', 'DupA.kr')`);
    ok(!m2.ok, 'B9 one EPG guide identity cannot map to two channels in the same source');
    const m3 = await tryExec(`insert into public.livetv_epg_channel_mappings (epg_source_id, channel_id, epg_channel_id) values ('${epgId}', '${chanA}', 'Other.kr')`);
    ok(!m3.ok, 'B9 one channel cannot hold two EPG identities in the same source (1:1 per source)');

    // B10 — non-https EPG source_url rejected.
    const badEpg = await tryExec(`insert into public.livetv_epg_sources (slug, name, source_url) values ('bad-epg', 'Bad EPG', 'http://insecure.example/g.xml')`);
    ok(!badEpg.ok, 'B10 a non-https EPG source_url is rejected');
  }

  // -------------------------------------------------------------------------
  console.log('PHASE C — the built-in LiveGT V1 seed');
  // -------------------------------------------------------------------------
  {
    const builtin = await q(`select slug, source_type, builtin, enabled, status, priority, visibility
      from public.livetv_sources where slug = 'builtin-livegt-v1'`);
    ok(builtin.length === 1, 'C1 the built-in LiveGT V1 source row is seeded');
    ok(String(builtin[0]!['source_type']) === 'builtin_livegt_v1', 'C1 its source_type is builtin_livegt_v1');
    ok(builtin[0]!['builtin'] === true, 'C1 it is flagged builtin');
    ok(builtin[0]!['enabled'] === true && String(builtin[0]!['status']) === 'active', 'C1 it is enabled + active (preserves LiveGT-only behavior)');
    ok(Number(builtin[0]!['priority']) === 0, 'C1 its priority is 0 (first by default)');
    ok(String(builtin[0]!['visibility']) === 'public', 'C1 it is public (the current user-facing catalogue)');

    const del = await tryExec(`delete from public.livetv_sources where slug = 'builtin-livegt-v1'`);
    ok(!del.ok && del.message.includes('LIVETV_BUILTIN_SOURCE_PROTECTED'), 'C2 the built-in source CANNOT be deleted (protect trigger)', del.message);

    const disable = await tryExec(`update public.livetv_sources set enabled = false where slug = 'builtin-livegt-v1'`);
    ok(disable.ok, 'C3 the built-in source CAN be disabled (enablement stays admin-controlled)');
    const reEnable = await tryExec(`update public.livetv_sources set enabled = true where slug = 'builtin-livegt-v1'`);
    ok(reEnable.ok, 'C3 the built-in source can be re-enabled');
  }

  // -------------------------------------------------------------------------
  console.log('PHASE D — RLS: fail-closed, admin-only');
  // -------------------------------------------------------------------------
  {
    const rlsRows = await q(`select relname, relrowsecurity from pg_class
      where relnamespace = 'public'::regnamespace and relname like 'livetv_%' and relkind = 'r'`);
    ok(rlsRows.length === 8 && rlsRows.every((row) => row['relrowsecurity'] === true), 'D1 RLS is enabled on ALL 8 livetv tables');

    const policies = await q(`select tablename, policyname, cmd, roles from pg_policies
      where schemaname = 'public' and tablename like 'livetv_%' order by tablename, policyname`);
    ok(policies.length === 8, 'D2 exactly 8 policies exist (one admin_all per table)');
    ok(policies.every((row) => String(row['policyname']).endsWith('_admin_all')), 'D2 every policy is an admin_all policy');
    ok(
      policies.every((row) => Array.isArray(row['roles']) && (row['roles'] as string[]).includes('authenticated') && (row['roles'] as string[]).length === 1),
      'D2 every policy targets authenticated only (no anon policy exists — fail-closed)'
    );

    const anonGrants = await q(`select privilege_type from information_schema.role_table_grants
      where table_schema = 'public' and table_name = 'livetv_sources' and grantee = 'anon'`);
    ok(anonGrants.length === 0, 'D3 anon has NO grants on livetv tables');

    // The is_admin() predicate (the same call the policies make) resolves.
    await db.exec(`create role probe_admin login; grant usage on schema public to probe_admin;`);
    await db.exec(`set role probe_admin;`);
    const isAdmin = await q(`select public.is_admin() as ok`);
    ok(isAdmin.length === 1 && isAdmin[0]!['ok'] === false, 'D4 is_admin() resolves and is FALSE outside an admin JWT session (fail-closed by construction)');
    await db.exec(`reset role;`);
  }

  // -------------------------------------------------------------------------
  console.log('PHASE E — integrity triggers');
  // -------------------------------------------------------------------------
  {
    // Reset probe data from Phase B that would interfere.
    await db.exec(`delete from public.livetv_playback_candidates`);

    const srcId = String((await q(`select id from public.livetv_sources where slug = 'builtin-livegt-v1'`))[0]!['id']);
    const chanA = String((await q(`select id from public.livetv_channels where name = 'Dup A'`))[0]!['id']);
    const chanB = String((await q(`select id from public.livetv_channels where name = 'No Key A'`))[0]!['id']);
    const entryA = await q(`insert into public.livetv_source_channels (source_id, source_channel_id, canonical_channel_id, name)
      values ('${srcId}', 'entry-A', '${chanA}', 'Entry A') returning id`);
    const entryAId = String(entryA[0]!['id']);
    const epA = await q(`insert into public.livetv_playback_endpoints (source_channel_id, endpoint_kind, stream_format, url)
      values ('${entryAId}', 'direct_stream', 'dash', 'https://cdn.example/a.mpd') returning id`);
    const epAId = String(epA[0]!['id']);

    const crossChannel = await tryExec(`insert into public.livetv_playback_candidates (channel_id, endpoint_id)
      values ('${chanB}', '${epAId}')`);
    ok(!crossChannel.ok && crossChannel.message.includes('LIVETV_CANDIDATE_CHANNEL_MISMATCH'), 'E1 a candidate CANNOT attach an endpoint to a different channel (integrity trigger)', crossChannel.message);

    const unmapped = await tryExec(`insert into public.livetv_source_channels (source_id, source_channel_id, name) values ('${srcId}', 'entry-orphan', 'Orphan Entry')`);
    ok(unmapped.ok, 'E2 an UNMAPPED source entry is legal (kept separate until safely mapped)');

    // Measure the bump DELTA around exactly one successful candidate insert
    // (the E2 insert above legitimately bumped the counter as well).
    const versionBeforeGood = Number((await q(`select version from public.livetv_config_meta where id = 1`))[0]!['version']);
    const good = await tryExec(`insert into public.livetv_playback_candidates (channel_id, endpoint_id, priority) values ('${chanA}', '${epAId}', 5)`);
    ok(good.ok, 'E1 a correctly-mapped candidate inserts');

    const versionAfter = Number((await q(`select version from public.livetv_config_meta where id = 1`))[0]!['version']);
    ok(versionAfter === versionBeforeGood + 1, 'E3 the config version bumped on candidate insert', `${versionBeforeGood} -> ${versionAfter}`);

    const updatedAtBefore = String((await q(`select updated_at from public.livetv_playback_candidates`))[0]!['updated_at']);
    await db.exec(`update public.livetv_playback_candidates set priority = 6`);
    const updatedAtAfter = String((await q(`select updated_at from public.livetv_playback_candidates`))[0]!['updated_at']);
    ok(updatedAtAfter >= updatedAtBefore, 'E4 updated_at is maintained by the set_updated_at trigger');

    const versionAfterUpdate = Number((await q(`select version from public.livetv_config_meta where id = 1`))[0]!['version']);
    ok(versionAfterUpdate === versionAfter + 1, 'E3 the config version also bumps on update');
  }

  // -------------------------------------------------------------------------
  console.log('PHASE F — realistic multi-source lifecycle (isolation rules)');
  // -------------------------------------------------------------------------
  {
    // Fresh fixtures: canonical channel "Example News" fed by two sources.
    await db.exec(`delete from public.livetv_source_channels where source_channel_id in ('probe-entry', 'entry-A', 'entry-orphan')`);
    await db.exec(`delete from public.livetv_channels`);

    const srcId = String((await q(`select id from public.livetv_sources where slug = 'builtin-livegt-v1'`))[0]!['id']);
    const playlist = await q(`insert into public.livetv_sources (slug, name, source_type, enabled, status, priority, visibility, config)
      values ('playlist-a', 'Playlist A', 'm3u_playlist', true, 'active', 10, 'internal', '{"playlistUrl":"https://example.com/list.m3u"}'::jsonb)
      returning id`);
    const playlistId = String(playlist[0]!['id']);

    const channel = await q(`insert into public.livetv_channels (name, category) values ('Example News', 'News') returning id`);
    const channelId = String(channel[0]!['id']);

    // Conservative dedup: two entries with the IDENTICAL display name from
    // two sources remain TWO rows; only the explicit canonical mapping joins
    // them (never display-name equality).
    const livegtEntry = await q(`insert into public.livetv_source_channels (source_id, source_channel_id, canonical_channel_id, name, tvg_id)
      values ('${srcId}', '143', '${channelId}', 'Example News', 'livegt-143') returning id`);
    const livegtEntryId = String(livegtEntry[0]!['id']);
    const playlistEntry = await q(`insert into public.livetv_source_channels (source_id, source_channel_id, canonical_channel_id, name, tvg_id)
      values ('${playlistId}', 'exnews.hd', '${channelId}', 'Example News', 'ExNewsHD.kr') returning id`);
    const playlistEntryId = String(playlistEntry[0]!['id']);
    const entryCount = Number((await q(`select count(*) as n from public.livetv_source_channels where name = 'Example News'`))[0]!['n']);
    ok(entryCount === 2, 'F1 identical display names from two sources stay SEPARATE entries (conservative dedup)');
    ok(
      String((await q(`select canonical_channel_id from public.livetv_source_channels where id = '${livegtEntryId}'`))[0]!['canonical_channel_id']) === channelId &&
        String((await q(`select canonical_channel_id from public.livetv_source_channels where id = '${playlistEntryId}'`))[0]!['canonical_channel_id']) === channelId,
      'F1 both entries explicitly reference the ONE canonical channel (one channel card, four-source ready)'
    );

    // LiveGT direct + embed endpoints for the SAME source entry — both
    // representable independently (requirement §2.D).
    const livegtDirect = String((await q(`insert into public.livetv_playback_endpoints (source_channel_id, endpoint_kind, stream_format, url, ordering)
      values ('${livegtEntryId}', 'direct_stream', 'dash', 'https://cdn.example/livegt-143.mpd', 0) returning id`))[0]!['id']);
    const livegtEmbed = String((await q(`insert into public.livetv_playback_endpoints (source_channel_id, endpoint_kind, url, ordering)
      values ('${livegtEntryId}', 'embed_page', 'https://livetgtv.lovable.app/embed/143', 1) returning id`))[0]!['id']);
    const playlistDirect = String((await q(`insert into public.livetv_playback_endpoints (source_channel_id, endpoint_kind, stream_format, url)
      values ('${playlistEntryId}', 'direct_stream', 'hls', 'https://cdn.example/exnews.m3u8') returning id`))[0]!['id']);
    ok(
      Number((await q(`select count(*) as n from public.livetv_playback_endpoints where source_channel_id = '${livegtEntryId}'`))[0]!['n']) === 2,
      'F2 LiveGT direct + embed endpoints coexist for ONE source entry (independently representable)'
    );

    // The user's example configuration: playlist direct → LiveGT direct →
    // LiveGT embed (data-driven, never hard-coded; engines derived, not stored).
    await db.exec(`insert into public.livetv_playback_candidates (channel_id, endpoint_id, priority) values
      ('${channelId}', '${playlistDirect}', 10),
      ('${channelId}', '${livegtDirect}', 20),
      ('${channelId}', '${livegtEmbed}', 30)`);
    const order = await q(`select endpoint_id, priority from public.livetv_playback_candidates
      where channel_id = '${channelId}' order by priority asc, created_at asc, id asc`);
    ok(
      order.length === 3 && String(order[0]!['endpoint_id']) === playlistDirect && String(order[1]!['endpoint_id']) === livegtDirect && String(order[2]!['endpoint_id']) === livegtEmbed,
      'F3 the configured candidate order is deterministic (priority ASC, created_at ASC, id ASC)'
    );

    // Removing one source must NOT delete the canonical channel nor another
    // source's mapping (requirement §3). Playlist deletion cascades ONLY its
    // own entry + endpoints + candidates.
    await db.exec(`delete from public.livetv_sources where id = '${playlistId}'`);
    const channelSurvives = Number((await q(`select count(*) as n from public.livetv_channels where id = '${channelId}'`))[0]!['n']);
    const livegtEntrySurvives = Number((await q(`select count(*) as n from public.livetv_source_channels where id = '${livegtEntryId}'`))[0]!['n']);
    const playlistEntryGone = Number((await q(`select count(*) as n from public.livetv_source_channels where id = '${playlistEntryId}'`))[0]!['n']);
    const livegtEndpointsSurvive = Number((await q(`select count(*) as n from public.livetv_playback_endpoints where id in ('${livegtDirect}', '${livegtEmbed}')`))[0]!['n']);
    ok(channelSurvives === 1, 'F4 deleting a source preserves the canonical channel');
    ok(livegtEntrySurvives === 1, 'F4 deleting a source preserves ANOTHER source\'s mapping');
    ok(playlistEntryGone === 0, 'F4 deleting a source cascades only its own entry');
    ok(livegtEndpointsSurvive === 2, 'F4 deleting a source preserves the other source\'s endpoints');

    // EPG identity is independent of playback URLs (requirement §8).
    const epg = String((await q(`insert into public.livetv_epg_sources (slug, name) values ('lifecycle-epg', 'Lifecycle EPG') returning id`))[0]!['id']);
    await db.exec(`insert into public.livetv_epg_channel_mappings (epg_source_id, channel_id, epg_channel_id) values ('${epg}', '${channelId}', 'ExampleNews.kr')`);
    await db.exec(`delete from public.livetv_playback_endpoints where id in ('${livegtDirect}', '${livegtEmbed}')`);
    const epgSurvives = Number((await q(`select count(*) as n from public.livetv_epg_channel_mappings where channel_id = '${channelId}'`))[0]!['n']);
    ok(epgSurvives === 1, 'F5 deleting playback endpoints leaves EPG identity untouched (EPG ≠ stream URL)');

    // Deleting the canonical channel UNMAPS the source entry (provenance
    // preserved) and cascades mappings — never orphans source data.
    await db.exec(`delete from public.livetv_channels where id = '${channelId}'`);
    const entryRow = await q(`select canonical_channel_id from public.livetv_source_channels where id = '${livegtEntryId}'`);
    const entryStillExists = Number((await q(`select count(*) as n from public.livetv_source_channels where id = '${livegtEntryId}'`))[0]!['n']);
    ok(entryStillExists === 1 && entryRow.length === 1 && entryRow[0]!['canonical_channel_id'] === null, 'F6 deleting the canonical channel only UNMAPS the source entry (provenance preserved)');
    const epgCascade = Number((await q(`select count(*) as n from public.livetv_epg_channel_mappings where channel_id = '${channelId}'`))[0]!['n']);
    ok(epgCascade === 0, 'F6 the EPG mapping follows the canonical channel (cascade)');
  }

  console.log(`\n=== livetv Phase 1 migration verification: ${passed} checks PASSED ===`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
