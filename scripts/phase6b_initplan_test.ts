import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * Phase 6b — user_streaming_credentials RLS initplan optimization.
 *
 * The Supabase Performance Advisor reported auth_rls_initplan on
 * user_streaming_credentials because the policy used bare auth.uid()
 * instead of the initplan-safe (select auth.uid()) form.
 *
 * This migration optimizes the expression. The table was created outside
 * of tracked migrations (likely via the Supabase dashboard), but the
 * corrective migration targets the production table by name.
 *
 * Tests verify:
 *   1. The migration uses (select auth.uid()) in both USING and WITH CHECK.
 *   2. The policy name is preserved.
 *   3. The TO role is authenticated.
 *   4. The command is FOR ALL.
 *   5. No grants or revokes are added.
 *   6. No table schema changes.
 *   7. The policy is dropped before recreate (idempotent).
 */

let passed = 0;
function ok(condition: unknown, label: string) {
  assert.ok(condition, label);
  passed += 1;
  console.log(`  ok ${passed} - ${label}`);
}

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative: string) => readFileSync(path.join(REPO_ROOT, relative), 'utf8');

const migration = read('supabase/migrations/20260926000000_phase6b_streaming_credentials_initplan.sql');

// ============================================================
// 1. The migration uses (select auth.uid()) in both USING and WITH CHECK.
// ============================================================
ok(/\(select auth\.uid\(\)\) = user_id/.test(migration), '1a. USING uses (select auth.uid()) = user_id (initplan-safe)');
ok(/using \(\(select auth\.uid\(\)\) = user_id\)/.test(migration), '1b. USING clause has (select auth.uid()) = user_id');
ok(/with check \(\(select auth\.uid\(\)\) = user_id\)/.test(migration), '1c. WITH CHECK clause has (select auth.uid()) = user_id');

// ============================================================
// 2. The bare auth.uid() form is NOT used.
// ============================================================
// Strip comments first to avoid false positives from documentation.
const migrationCode = migration.replace(/--[^\n]*/g, '');
ok(!/using \(auth\.uid\(\) = user_id\)/.test(migrationCode), '2a. USING does NOT use bare auth.uid() = user_id');
ok(!/with check \(auth\.uid\(\) = user_id\)/.test(migrationCode), '2b. WITH CHECK does NOT use bare auth.uid() = user_id');

// ============================================================
// 3. Policy name is preserved.
// ============================================================
ok(/"Users manage own streaming credentials"/.test(migration), '3a. Policy name preserved: "Users manage own streaming credentials"');

// ============================================================
// 4. TO authenticated.
// ============================================================
ok(/to authenticated/.test(migration), '4a. Policy TO authenticated (preserved)');

// ============================================================
// 5. FOR ALL.
// ============================================================
ok(/for all/.test(migration), '5a. Policy FOR ALL (preserved — covers select/insert/update/delete)');

// ============================================================
// 6. No grants or revokes.
// ============================================================
ok(!/grant /.test(migrationCode), '6a. No GRANT statements (no privilege changes)');
ok(!/revoke /.test(migrationCode), '6b. No REVOKE statements (no privilege changes)');

// ============================================================
// 7. No table schema changes.
// ============================================================
ok(!/create table/.test(migrationCode), '7a. No CREATE TABLE (table schema not altered)');
ok(!/alter table/.test(migrationCode), '7b. No ALTER TABLE (table schema not altered)');
ok(!/create index/.test(migrationCode), '7c. No CREATE INDEX (no index changes)');

// ============================================================
// 8. Idempotent — drop before create.
// ============================================================
ok(/drop policy if exists/.test(migration), '8a. Drops policy before recreating (idempotent)');

console.log(`phase6b_initplan_test: ${passed} checks passed (Phase 6b RLS initplan optimization)`);
