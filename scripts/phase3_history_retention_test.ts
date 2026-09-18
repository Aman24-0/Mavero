import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  DEFAULT_WATCH_HISTORY_RETENTION_DAYS,
  MIN_WATCH_HISTORY_RETENTION_DAYS,
  MAX_WATCH_HISTORY_RETENTION_DAYS
} from '../src/lib/server/account/history-retention';

/**
 * Phase 3-F (audit OBS-6) — Watch history bounded retention.
 *
 * watch_history is an audit log of playback events. The unique index on
 * (user_id, event_key) means duplicate events UPSERT instead of inserting
 * new rows, so growth is bounded by the number of DISTINCT titles each
 * user watches. Even so, a power user accumulates rows that are never
 * read again (Continue Watching reads from watch_progress, NOT
 * watch_history).
 *
 * This test verifies the retention strategy:
 *   1. The migration adds an index on occurred_at (for efficient prune).
 *   2. The migration adds a SECURITY DEFINER function
 *      prune_old_watch_history(retention_days) that deletes rows older
 *      than the cutoff.
 *   3. The function clamps retention_days to [1, 3650] (defense in depth).
 *   4. The function PRESERVES recent history, Continue Watching
 *      (watch_progress), favorites, and active progress.
 *   5. The function is granted to authenticated (service-role client)
 *      and revoked from anon.
 *   6. The application-level helper clamps retention_days to match.
 *   7. RLS remains intact (the function is SECURITY DEFINER but only
 *      DELETES old rows — no cross-user data leak).
 */

let passed = 0;
function ok(condition: unknown, label: string) {
  assert.ok(condition, label);
  passed += 1;
  console.log(`  ok ${passed} - ${label}`);
}

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative: string) => readFileSync(path.join(REPO_ROOT, relative), 'utf8');

// ============================================================
// 1. The migration exists.
// ============================================================
ok(existsSync(path.join(REPO_ROOT, 'supabase/migrations/20260922000000_phase3_watch_history_retention.sql')), '1a. migration file exists');

const migration = read('supabase/migrations/20260922000000_phase3_watch_history_retention.sql');

// ============================================================
// 2. The migration adds an index on occurred_at.
// ============================================================
ok(/create index if not exists watch_history_occurred_at_idx/.test(migration), '2a. migration creates watch_history_occurred_at_idx');
ok(/on public\.watch_history \(occurred_at\)/.test(migration), '2b. index is on (occurred_at) — supports efficient global prune');

// ============================================================
// 3. The migration adds the prune function.
// ============================================================
ok(/create or replace function public\.prune_old_watch_history\(retention_days int\)/.test(migration), '3a. migration creates prune_old_watch_history function');
ok(/returns integer/.test(migration), '3b. function returns the count of deleted rows');
ok(/language plpgsql/.test(migration), '3c. function is plpgsql');
ok(/security definer/.test(migration), '3d. function is SECURITY DEFINER (bypasses RLS for the prune)');
ok(/set search_path = public/.test(migration), '3e. function sets search_path = public (defense against search_path injection)');

// ============================================================
// 4. The function clamps retention_days to [1, 3650].
// ============================================================
ok(/if retention_days is null or retention_days < 1 then/.test(migration), '4a. function clamps retention_days < 1 to 180 (default)');
ok(/retention_days := 180;/.test(migration), '4b. function default is 180 days');
ok(/elsif retention_days > 3650 then/.test(migration), '4c. function clamps retention_days > 3650 to 3650');
ok(/retention_days := 3650;/.test(migration), '4d. function max is 3650 days (10 years)');

// ============================================================
// 5. The function PRESERVES recent history + other tables.
// ============================================================
ok(/delete from public\.watch_history/.test(migration), '5a. function deletes from watch_history');
ok(/where occurred_at < cutoff;/.test(migration), '5b. function deletes ONLY rows older than the cutoff (preserves recent)');
// The function does NOT touch watch_progress, favorites, or favorite_deletions.
ok(!/delete from public\.watch_progress/.test(migration), '5c. function does NOT delete from watch_progress (Continue Watching preserved)');
ok(!/delete from public\.favorites/.test(migration), '5d. function does NOT delete from favorites (library preserved)');
ok(!/delete from public\.favorite_deletions/.test(migration), '5e. function does NOT delete from favorite_deletions (tombstones preserved)');

// ============================================================
// 6. Permission model — REGRESSION-1 (Phase 4) lockdown.
//
// The original migration granted execute to `authenticated` — TOO BROAD.
// Phase 4 REGRESSION-1 corrected this: a corrective migration revokes
// execute from BOTH `authenticated` and `anon`. The function is now
// callable ONLY by the postgres superuser (pg_cron / scheduled reminders)
// and the service-role key (which bypasses RLS — used by the admin
// trigger). Ordinary authenticated users receive 403 if they attempt
// to call it via PostgREST.
// ============================================================
// The original migration STILL grants to authenticated (we don't edit
// existing migrations — we add corrective ones). The test verifies the
// ORIGINAL grant exists AND that the CORRECTIVE migration revokes it.
ok(/grant execute on function public\.prune_old_watch_history\(int\) to authenticated/.test(migration), '6a. original migration granted to authenticated (historical — corrected by Phase 4 regression-1)');
ok(/revoke execute on function public\.prune_old_watch_history\(int\) from anon/.test(migration), '6b. original migration revoked from anon');

// The corrective migration locks down the permission model.
const correctiveMigration = read('supabase/migrations/20260923000000_phase4_regression1_history_retention_permissions.sql');
ok(/revoke execute on function public\.prune_old_watch_history\(int\) from authenticated/.test(correctiveMigration), '6c. corrective migration revokes execute from authenticated (REGRESSION-1 fix: ordinary users cannot trigger a global prune)');
ok(/revoke execute on function public\.prune_old_watch_history\(int\) from anon/.test(correctiveMigration), '6d. corrective migration revokes execute from anon (defense in depth)');
// The corrective migration must NOT grant execute to any role — the
// function is callable ONLY by the postgres superuser + service-role key.
ok(!/grant execute on function public\.prune_old_watch_history/.test(correctiveMigration), '6e. corrective migration does NOT grant execute to any role (only postgres superuser + service-role key can call)');
ok(/Phase 4 REGRESSION-1/i.test(correctiveMigration), '6f. corrective migration annotated with Phase 4 REGRESSION-1');

// ============================================================
// 7. The application-level helper clamps retention_days.
// ============================================================
const helper = read('src/lib/server/account/history-retention.ts');
ok(/export const DEFAULT_WATCH_HISTORY_RETENTION_DAYS = 180;/.test(helper), '7a. default retention is 180 days');
ok(/export const MIN_WATCH_HISTORY_RETENTION_DAYS = 1;/.test(helper), '7b. min retention is 1 day');
ok(/export const MAX_WATCH_HISTORY_RETENTION_DAYS = 3650;/.test(helper), '7c. max retention is 3650 days (10 years)');
ok(/Math\.max\(\s*MIN_WATCH_HISTORY_RETENTION_DAYS,\s*Math\.min\(MAX_WATCH_HISTORY_RETENTION_DAYS, Math\.floor\(retentionDays\)\)\s*\)/.test(helper), '7d. helper clamps retention_days to [MIN, MAX] (defense in depth — matches SQL clamp)');

// Verify the constants.
ok(DEFAULT_WATCH_HISTORY_RETENTION_DAYS === 180, '7e. DEFAULT_WATCH_HISTORY_RETENTION_DAYS is 180');
ok(MIN_WATCH_HISTORY_RETENTION_DAYS === 1, '7f. MIN_WATCH_HISTORY_RETENTION_DAYS is 1');
ok(MAX_WATCH_HISTORY_RETENTION_DAYS === 3650, '7g. MAX_WATCH_HISTORY_RETENTION_DAYS is 3650');

// ============================================================
// 8. The helper calls the function via RPC.
// ============================================================
ok(/client\.rpc\('prune_old_watch_history'/.test(helper), '8a. helper calls prune_old_watch_history via RPC');
ok(/retention_days: clamped/.test(helper), '8b. helper passes the clamped retention_days');

// ============================================================
// 9. RLS remains intact — the function is SECURITY DEFINER but only
// DELETES old rows. The migration does NOT alter any RLS policy.
// ============================================================
ok(!/drop policy/.test(migration), '9a. migration does NOT drop any RLS policy');
ok(!/create policy/.test(migration), '9b. migration does NOT create any RLS policy (RLS architecture preserved)');

// ============================================================
// 10. The existing watch_history schema + RLS policies are preserved.
// (Verify the original migration is unchanged — the retention migration
// is ADDITIVE only.)
// ============================================================
const originalMigration = read('supabase/migrations/20260820000000_phase5_auth_sync.sql');
ok(/create table if not exists public\.watch_history/.test(originalMigration), '10a. original watch_history table definition preserved');
ok(/alter table public\.watch_history enable row level security/.test(originalMigration), '10b. RLS enabled on watch_history (preserved)');
ok(/create policy watch_history_select_own/.test(originalMigration), '10c. watch_history_select_own policy preserved');
ok(/create policy watch_history_insert_own/.test(originalMigration), '10d. watch_history_insert_own policy preserved');
ok(/create policy watch_history_update_own/.test(read('supabase/migrations/20260921100000_phase1_watch_history_update_policy.sql')), '10e. watch_history_update_own policy preserved (Phase 1)');
ok(/create policy watch_history_delete_own/.test(originalMigration), '10f. watch_history_delete_own policy preserved');

// ============================================================
// 11. Continue Watching reads from watch_progress, NOT watch_history.
// Pruning watch_history does NOT affect Continue Watching.
// ============================================================
const cloudSync = read('src/lib/client/progress/cloud.ts');
ok(/watch_progress/.test(cloudSync), '11a. cloud sync reads from watch_progress (Continue Watching source)');
// Strip BOTH line comments AND block comments before checking — the file
// has a block comment that mentions watch_history for documentation only.
const cloudSyncCode = cloudSync.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
ok(!/watch_history/.test(cloudSyncCode), '11b. cloud sync does NOT read from watch_history (pruning history does not affect Continue Watching)');

// ============================================================
// 12. The migration documents the production cleanup path.
// ============================================================
ok(/Production cleanup should run via Supabase[\s\S]*?reminders \/ pg_cron/.test(migration), '12a. migration documents that production cleanup runs via Supabase scheduled reminders / pg_cron');
ok(/NOT application requests/.test(migration), '12b. migration documents that cleanup should NOT run on application requests');

console.log(`phase3_history_retention_test: ${passed} checks passed (Phase 3-F watch history bounded retention)`);
