/**
 * UNIFIED LIVE TV — Phase 7 migration verification on embedded PostgreSQL
 * (PGlite) — mirrors livetv_phase3_epg_migration_test.ts conventions.
 *
 * Verifies migration 20261122000000_livetv_refresh_history.sql against the
 * REAL DDL semantics:
 *
 *   PHASE A — applies cleanly over the realistic pre-state (Phase 1 + Phase 3
 *     livetv family) and is IDEMPOTENT (re-apply changes nothing).
 *   PHASE B — schema contract: the status/trigger/subject/operation CHECK
 *     vocabularies, the bounded text caps, non-negative bounded counts, the
 *     duration cap, and the subject_slug bound.
 *   PHASE C — append-only durability: NO foreign keys (history SURVIVES
 *     source deletion with the slug snapshot) + the config-version trigger
 *     does NOT fire on history writes (history is not configuration).
 *   PHASE D — RLS: enabled, ONLY the admin-all policy, anon has no
 *     grants-backed access, a granted non-admin role sees ZERO rows.
 *   PHASE E — indexes for the documented access patterns exist.
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
const PHASE7 = 'supabase/migrations/20261122000000_livetv_refresh_history.sql';
const phase1Sql = readFileSync(path.join(REPO_ROOT, PHASE1), 'utf8');
const phase3Sql = readFileSync(path.join(REPO_ROOT, PHASE3), 'utf8');
const phase7Sql = readFileSync(path.join(REPO_ROOT, PHASE7), 'utf8');

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
                const apply7 = await tryExec(phase7Sql);
                ok(apply7.ok, 'A3 the Phase 7 history migration applies cleanly over the family', apply7.message);
                const replay7 = await tryExec(phase7Sql);
                ok(replay7.ok, 'A4 the Phase 7 migration re-applies idempotently (IF NOT EXISTS throughout)', replay7.message);
                const replay1 = await tryExec(phase1Sql);
                ok(replay1.ok, 'A5 the earlier migrations still replay after Phase 7 (additive, no interference)', replay1.message);
        }

        // -------------------------------------------------------------------------
        console.log('PHASE B — schema contract (bounded by construction)');
        // -------------------------------------------------------------------------
        const subjectId = '77777777-0000-0000-0000-000000000001';
        {
                const tables = await q(`select table_name from information_schema.tables where table_schema = 'public' and table_name = 'livetv_refresh_history'`);
                ok(tables.length === 1, 'B1 the livetv_refresh_history table exists');

                const columns = await q(`select column_name, data_type, is_nullable from information_schema.columns where table_schema = 'public' and table_name = 'livetv_refresh_history' order by ordinal_position`);
                const byName = new Map(columns.map((row) => [String(row['column_name']), row]));
                ok(byName.get('subject_id')?.['data_type'] === 'uuid' && byName.get('subject_id')?.['is_nullable'] === 'NO', 'B2 subject_id is a NOT NULL uuid');
                ok(byName.get('correlation_id')?.['data_type'] === 'uuid', 'B3 correlation_id is a uuid');
                ok(byName.get('started_at')?.['data_type'] === 'timestamp with time zone', 'B4 started_at is timestamptz');
                ok(byName.get('finished_at')?.['is_nullable'] === 'YES', 'B5 finished_at is nullable (in-flight rows are impossible by writer design but the schema tolerates late completion)');

                // Vocabulary CHECKs.
                const base = (status: string, extra = '') =>
                        `insert into public.livetv_refresh_history (subject_kind, subject_id, subject_slug, operation, trigger_type, correlation_id, status, error_category, error_message${extra ? ', ' + extra : ''}) values ('source', '${subjectId}', 'probe', 'refresh', 'scheduled', '77777777-0000-0000-0000-0000000000cc', '${status}', null, null${extra ? ', ' + extra.split(',')[1] ?? '' : ''})`;
                // Simplify: build explicit inserts instead of the generic helper.
                const badKind = await tryExec(`insert into public.livetv_refresh_history (subject_kind, subject_id, subject_slug, operation, trigger_type, correlation_id, status) values ('channel', '${subjectId}', 'p', 'refresh', 'scheduled', '77777777-0000-0000-0000-0000000000c1', 'success')`);
                ok(!badKind.ok, 'B6 an invalid subject_kind is rejected', badKind.message.slice(0, 80));
                const badOp = await tryExec(`insert into public.livetv_refresh_history (subject_kind, subject_id, subject_slug, operation, trigger_type, correlation_id, status) values ('source', '${subjectId}', 'p', 'preview', 'scheduled', '77777777-0000-0000-0000-0000000000c2', 'success')`);
                ok(!badOp.ok, 'B7 an invalid operation is rejected (preview is never history)');
                const badTrigger = await tryExec(`insert into public.livetv_refresh_history (subject_kind, subject_id, subject_slug, operation, trigger_type, correlation_id, status) values ('source', '${subjectId}', 'p', 'refresh', 'cron', '77777777-0000-0000-0000-0000000000c3', 'success')`);
                ok(!badTrigger.ok, 'B8 an invalid trigger_type is rejected (scheduled|manual only)');
                const badStatus = await tryExec(`insert into public.livetv_refresh_history (subject_kind, subject_id, subject_slug, operation, trigger_type, correlation_id, status) values ('source', '${subjectId}', 'p', 'refresh', 'scheduled', '77777777-0000-0000-0000-0000000000c4', 'pending')`);
                ok(!badStatus.ok, 'B9 an invalid status is rejected (terminal statuses only)');
                const badAttempt = await tryExec(`insert into public.livetv_refresh_history (subject_kind, subject_id, subject_slug, operation, trigger_type, correlation_id, status, attempt_count) values ('source', '${subjectId}', 'p', 'refresh', 'scheduled', '77777777-0000-0000-0000-0000000000c5', 'success', 0)`);
                ok(!badAttempt.ok, 'B10 attempt_count 0 is rejected (1-based)');
                const badAttempt2 = await tryExec(`insert into public.livetv_refresh_history (subject_kind, subject_id, subject_slug, operation, trigger_type, correlation_id, status, attempt_count) values ('source', '${subjectId}', 'p', 'refresh', 'scheduled', '77777777-0000-0000-0000-0000000000c6', 'success', 99)`);
                ok(!badAttempt2.ok, 'B11 attempt_count > 10 is rejected (retry-cap parity)');
                const negativeCount = await tryExec(`insert into public.livetv_refresh_history (subject_kind, subject_id, subject_slug, operation, trigger_type, correlation_id, status, error_count) values ('source', '${subjectId}', 'p', 'refresh', 'scheduled', '77777777-0000-0000-0000-0000000000c7', 'success', -1)`);
                ok(!negativeCount.ok, 'B12 a negative count is rejected');
                const hugeDuration = await tryExec(`insert into public.livetv_refresh_history (subject_kind, subject_id, subject_slug, operation, trigger_type, correlation_id, status, duration_ms) values ('source', '${subjectId}', 'p', 'refresh', 'scheduled', '77777777-0000-0000-0000-0000000000c8', 'success', 7200000)`);
                ok(!hugeDuration.ok, 'B13 a duration beyond 1h is rejected');
                const longSlug = await tryExec(`insert into public.livetv_refresh_history (subject_kind, subject_id, subject_slug, operation, trigger_type, correlation_id, status) values ('source', '${subjectId}', '${'s'.repeat(121)}', 'refresh', 'scheduled', '77777777-0000-0000-0000-0000000000c9', 'success')`);
                ok(!longSlug.ok, 'B14 an over-cap slug snapshot is rejected (120 max)');
                const longCategory = await tryExec(`insert into public.livetv_refresh_history (subject_kind, subject_id, subject_slug, operation, trigger_type, correlation_id, status, error_category) values ('source', '${subjectId}', 'p', 'refresh', 'scheduled', '77777777-0000-0000-0000-0000000000ca', 'failure', '${'c'.repeat(61)}')`);
                ok(!longCategory.ok, 'B15 an over-cap error_category is rejected (60 max)');
                const longMessage = await tryExec(`insert into public.livetv_refresh_history (subject_kind, subject_id, subject_slug, operation, trigger_type, correlation_id, status, error_message) values ('source', '${subjectId}', 'p', 'refresh', 'scheduled', '77777777-0000-0000-0000-0000000000cb', 'failure', '${'m'.repeat(241)}')`);
                ok(!longMessage.ok, 'B16 an over-cap error_message is rejected (240 max)');
                const validRow = await tryExec(`insert into public.livetv_refresh_history (subject_kind, subject_id, subject_slug, operation, trigger_type, correlation_id, status, imported_count, updated_count, skipped_count, error_count, error_category, error_message, duration_ms) values ('source', '${subjectId}', 'probe', 'refresh', 'scheduled', '77777777-0000-0000-0000-0000000000cc', 'partial', 3, 1, 2, 1, 'http_error', 'The source endpoint returned an HTTP error status.', 1234)`);
                ok(validRow.ok, 'B17 a fully-valid row is accepted', validRow.message);
        }

        // -------------------------------------------------------------------------
        console.log('PHASE C — append-only durability (NO FK; NOT config)');
        // -------------------------------------------------------------------------
        {
                const fks = await q(`select conname from pg_constraint where conrelid = 'public.livetv_refresh_history'::regclass and contype = 'f'`);
                ok(fks.length === 0, 'C1 the history table has NO foreign keys (history survives source deletion)');

                // Delete the "source" the rows point at (no FK, nothing cascades).
                const before = Number((await q(`select count(*) as n from public.livetv_refresh_history`))[0]!['n']);
                ok(before >= 1, 'C2 history rows exist before the deletion probe');
                // (The subject id was never a real registry row — the point is
                // that nothing in the schema references it.)

                // The config-version trigger must NOT fire for history writes.
                const versionBefore = (await q(`select version, updated_at from public.livetv_config_meta where id = 1`))[0];
                await tryExec(`insert into public.livetv_refresh_history (subject_kind, subject_id, subject_slug, operation, trigger_type, correlation_id, status) values ('epg_source', '${subjectId}', 'probe-epg', 'epg_refresh', 'manual', '77777777-0000-0000-0000-0000000000cd', 'success')`);
                const versionAfter = (await q(`select version, updated_at from public.livetv_config_meta where id = 1`))[0];
                ok(String(versionBefore!['version']) === String(versionAfter!['version']), 'C3 a history insert does NOT bump the config version (history is not configuration)');
        }

        // -------------------------------------------------------------------------
        console.log('PHASE D — RLS: fail-closed, admin-only');
        // -------------------------------------------------------------------------
        {
                const rls = await q(`select relname, relrowsecurity from pg_class where relnamespace = 'public'::regnamespace and relname = 'livetv_refresh_history'`);
                ok(rls.length === 1 && rls[0]!['relrowsecurity'] === true, 'D1 RLS is enabled on livetv_refresh_history');

                const policies = await q(`select policyname, cmd, roles from pg_policies where schemaname = 'public' and tablename = 'livetv_refresh_history'`);
                ok(policies.length === 1 && String(policies[0]!['policyname']).endsWith('_admin_all'), 'D2 exactly one admin_all policy exists');
                ok(Array.isArray(policies[0]!['roles']) && (policies[0]!['roles'] as string[]).includes('authenticated') && (policies[0]!['roles'] as string[]).length === 1, 'D2 the policy targets authenticated only (no anon policy)');

                const anonGrants = await q(`select privilege_type from information_schema.role_table_grants where table_schema = 'public' and table_name = 'livetv_refresh_history' and grantee = 'anon'`);
                ok(anonGrants.length === 0, 'D3 anon has NO grants on the history table');

                await db.exec(`create role probe_admin7 login; grant usage on schema public to probe_admin7;`);
                await db.exec(`grant select on public.livetv_refresh_history to probe_admin7;`);
                await db.exec(`set role probe_admin7;`);
                const deniedRows = await q(`select count(*) as n from public.livetv_refresh_history`);
                ok(Number(deniedRows[0]!['n']) === 0, 'D4 a granted non-admin role sees ZERO history rows (RLS fail-closed)');
                const deniedWrite = await tryExec(`insert into public.livetv_refresh_history (subject_kind, subject_id, subject_slug, operation, trigger_type, correlation_id, status) values ('source', '${subjectId}', 'hax', 'refresh', 'manual', '77777777-0000-0000-0000-0000000000ce', 'success')`);
                ok(!deniedWrite.ok, 'D4 a non-admin role CANNOT write history (no policy permits it)');
                await db.exec(`reset role;`);

                // An admin session (profiles row with role='admin' + matching auth.uid) sees the rows.
                const adminId = 'aaaaaaaa-0000-0000-0000-00000000000a';
                await db.exec(`insert into public.profiles (id, role) values ('${adminId}', 'admin')`);
                await db.exec(`create or replace function auth.uid() returns uuid language sql as $$ select '${adminId}'::uuid $$;`);
                await db.exec(`grant select on public.livetv_refresh_history to authenticated;`);
                await db.exec(`set role authenticated;`);
                const adminRows = await q(`select count(*) as n from public.livetv_refresh_history`);
                ok(Number(adminRows[0]!['n']) >= 1, 'D5 an admin JWT session reads the history (admin-all policy works)');
                await db.exec(`reset role;`);
                await db.exec(`create or replace function auth.uid() returns uuid language sql as $$ select null::uuid $$;`);
        }

        // -------------------------------------------------------------------------
        console.log('PHASE E — indexes for the documented access patterns');
        // -------------------------------------------------------------------------
        {
                const indexes = await q(`select indexname from pg_indexes where schemaname = 'public' and tablename = 'livetv_refresh_history' order by indexname`);
                const names = indexes.map((row) => String(row['indexname']));
                ok(names.some((n) => n.endsWith('subject_idx')), 'E1 the per-subject (kind, id, started desc) index exists', names.join(','));
                ok(names.some((n) => n.endsWith('started_idx')), 'E2 the retention/time-scan index exists');
                const pk = await q(`select conname from pg_constraint where conrelid = 'public.livetv_refresh_history'::regclass and contype = 'p'`);
                ok(pk.length === 1, 'E3 the primary key exists');
        }

        console.log(`\n=== livetv Phase 7 migration verification: ${passed} checks PASSED ===`);
}

main()
        .then(() => process.exit(0))
        .catch((error) => {
                console.error(error);
                process.exit(1);
        });
