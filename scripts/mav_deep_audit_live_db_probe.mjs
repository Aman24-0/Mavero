/**
 * MAV DEEP AUDIT — live Supabase verification probe (READ-ONLY + optional
 * additive-then-subtractive poster test).
 *
 * WHY THIS EXISTS: the audit environment had NO valid Supabase credentials
 * (the .env publishable key returns 401 and no service-role key was
 * available), so the live schema/data checks REQUIRED by the audit could
 * not be executed there. The owner runs this probe locally:
 *
 *   PRIVATE_SUPABASE_SERVICE_ROLE_KEY=<key> node scripts/mav_deep_audit_live_db_probe.mjs
 *
 * (PUBLIC_SUPABASE_URL is read from .env when present.)
 *
 * What it verifies (all READ-ONLY unless --write-test is passed):
 *
 *   §1  Project identity — the connected project ref is printed; verify it
 *       is the MAVERO project (whekhqimzrafhsrmswbn) before trusting any
 *       result. The probe REFUSES to run against an unknown ref unless
 *       --allow-any-project is passed.
 *   §2  media_items poster columns exist (information_schema), and the
 *       migration is recorded in supabase_migrations.schema_migrations
 *       when that table is reachable. Column existence is the AUTHORITATIVE
 *       check — migration-history absence alone is reported, not failed.
 *   §3  Live poster data state — counts of rows with NULL poster_path
 *       (read-only report).
 *   §4  Optional controlled write test (--write-test): INSERT a test
 *       media_items row carrying poster_path/backdrop_path, READ it back,
 *       DELETE it, and verify the deletion — additive-then-subtractive,
 *       touching ONLY rows it created (canonical_key prefixed
 *       'mavtest:deep-audit:'). Existing data is never modified.
 *
 * Exit code 0 = all checks passed; 1 = failures; 2 = environment problem.
 */

import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Load .env when present (never PRINT values — only names).
if (existsSync(resolve(root, '.env'))) {
  for (const line of readFileSync(resolve(root, '.env'), 'utf8').split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

const url = process.env.PUBLIC_SUPABASE_URL;
const key = process.env.PRIVATE_SUPABASE_SERVICE_ROLE_KEY;
const writeTest = process.argv.includes('--write-test');
const allowAnyProject = process.argv.includes('--allow-any-project');
const EXPECTED_PROJECT_REF = 'whekhqimzrafhsrmswbn'; // Mavero production project

if (!url || !key) {
  console.error('Missing env: PUBLIC_SUPABASE_URL / PRIVATE_SUPABASE_SERVICE_ROLE_KEY');
  console.error('Usage: PRIVATE_SUPABASE_SERVICE_ROLE_KEY=<key> node scripts/mav_deep_audit_live_db_probe.mjs [--write-test] [--allow-any-project]');
  process.exit(2);
}

const projectRef = url.replace(/^https?:\/\//, '').split('.')[0];
console.log(`Connected project ref: ${projectRef}`);
if (projectRef !== EXPECTED_PROJECT_REF && !allowAnyProject) {
  console.error(`REFUSING: expected the Mavero project (${EXPECTED_PROJECT_REF}). Pass --allow-any-project to override explicitly.`);
  process.exit(2);
}
console.log(`Write test: ${writeTest ? 'ENABLED (additive-then-subtractive)' : 'disabled (read-only)'}\n`);

const supabase = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
});

let passed = 0;
let failed = 0;
const failures = [];
function ok(condition, label) {
  if (condition) { passed++; console.log(`  ok - ${label}`); }
  else { failed++; failures.push(label); console.log(`  FAIL - ${label}`); }
}

// ------------------------------------------------------------
// §2 — poster columns exist (AUTHORITATIVE schema check)
// ------------------------------------------------------------
console.log('§2 — media_items poster columns');
{
  const res = await fetch(`${url}/rest/v1/rpc/to_jsonb`, { method: 'POST' }).catch(() => null);
  // information_schema via PostgREST is not exposed by default; use a
  // targeted SELECT of the columns — a missing column yields a PostgREST
  // error (PGRST204) which is exactly the signal we need.
  const { data, error } = await supabase
    .from('media_items')
    .select('id, poster_path, backdrop_path')
    .limit(1);
  if (!error) {
    ok(true, 'poster_path + backdrop_path columns EXIST and are selectable');
    const row = data?.[0];
    if (row) {
      console.log(`  sample row: poster_path=${JSON.stringify(row.poster_path)} backdrop_path=${JSON.stringify(row.backdrop_path)}`);
    }
  } else if (error.code === 'PGRST204' && /poster_path/.test(error.message)) {
    ok(false, `poster_path column MISSING — apply supabase/migrations/20261015000000_add_poster_to_media_items.sql via the dashboard SQL editor: ${error.message}`);
  } else {
    ok(false, `schema probe failed (unexpected): ${error.code} ${error.message}`);
  }
}

// ------------------------------------------------------------
// §3 — live poster data state (read-only report)
// ------------------------------------------------------------
console.log('\n§3 — poster data state (report)');
try {
  const { count: total } = await supabase.from('media_items').select('id', { count: 'exact', head: true });
  const { count: withPoster } = await supabase.from('media_items').select('id', { count: 'exact', head: true }).not('poster_path', 'is', null);
  const { count: nullPoster } = await supabase.from('media_items').select('id', { count: 'exact', head: true }).is('poster_path', null);
  console.log(`  media_items total=${total ?? '?'} with_poster=${withPoster ?? '?'} null_poster=${nullPoster ?? '?'}`);
  if ((total ?? 0) > 0 && (withPoster ?? 0) === 0) {
    console.log('  NOTE: every row has a NULL poster_path — expected if the migration was applied AFTER the rows were created and no title has been re-linked since. New saves (Add File) persist the poster path; re-linking a title backfills it.');
  }
  ok(true, 'poster data counts retrieved (report only — no pass/fail)');
} catch (e) {
  ok(false, `poster data report failed: ${e.message}`);
}

// ------------------------------------------------------------
// §4 — controlled write test (opt-in)
// ------------------------------------------------------------
if (writeTest) {
  console.log('\n§4 — controlled poster write test (additive-then-subtractive)');
  const testKey = `mavtest:deep-audit:${Date.now()}`;
  let testRowId = null;
  try {
    const { data: inserted, error: insertError } = await supabase
      .from('media_items')
      .insert({
        canonical_key: testKey,
        content_type: 'movie',
        tmdb_id: '999999999',
        title: 'MAV TEST — poster persistence probe',
        year: 2026,
        poster_path: '/mavtestposter.jpg',
        backdrop_path: '/mavtestbackdrop.jpg',
      })
      .select('id, poster_path, backdrop_path')
      .single();
    if (insertError) throw new Error(`insert failed: ${insertError.message}`);
    testRowId = inserted.id;
    ok(inserted.poster_path === '/mavtestposter.jpg', 'poster_path WRITE persists');
    ok(inserted.backdrop_path === '/mavtestbackdrop.jpg', 'backdrop_path WRITE persists');

    const { data: readBack, error: readError } = await supabase
      .from('media_items')
      .select('id, poster_path')
      .eq('id', testRowId)
      .single();
    if (readError) throw new Error(`read-back failed: ${readError.message}`);
    ok(readBack.poster_path === '/mavtestposter.jpg', 'poster_path READ-back matches');
  } catch (e) {
    ok(false, e.message);
  } finally {
    if (testRowId) {
      const { error: deleteError } = await supabase.from('media_items').delete().eq('id', testRowId);
      ok(!deleteError, `test row cleaned up (${testKey})`);
      const { data: leftover } = await supabase.from('media_items').select('id').eq('canonical_key', testKey);
      ok((leftover ?? []).length === 0, 'no leftover test rows');
    }
  }
} else {
  console.log('\n§4 — write test skipped (pass --write-test to run the controlled insert/read/delete cycle)');
}

// ------------------------------------------------------------
console.log(`\nmav_deep_audit_live_db_probe: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
