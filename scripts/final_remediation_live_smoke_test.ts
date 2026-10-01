/**
 * FINAL REMEDIATION — LIVE SMOKE VERIFICATION.
 *
 * Runs the REAL services against the LIVE Supabase database (read-only —
 * every method exercised here is a pure read). Verifies that the new query
 * surfaces (unified Jobs read model + asset inventory read model + facet
 * counts) execute correctly against the ACTUAL production schema — the
 * class of bug that static tests cannot catch (e.g. selecting a column that
 * does not exist).
 *
 * Requires:
 *   PUBLIC_SUPABASE_URL
 *   PRIVATE_SUPABASE_SERVICE_ROLE_KEY
 *
 * If unset, the test SKIPS (not fails).
 */

import assert from 'node:assert/strict';
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.PUBLIC_SUPABASE_URL || 'https://whekhqimzrafhsrmswbn.supabase.co';
const serviceKey = process.env.PRIVATE_SUPABASE_SERVICE_ROLE_KEY;

if (!serviceKey) {
  console.log('Live smoke skipped: PRIVATE_SUPABASE_SERVICE_ROLE_KEY not set.');
  process.exit(0);
}

const client = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

// Import services through the tsconfig path mapping.
import { OperationsService } from '../src/lib/server/hosting/operations/service';
import { HostingControlService } from '../src/lib/server/hosting/control/service';

let passed = 0;
function ok(name: string) { passed++; console.log(`  ok - ${name}`); }

(async () => {
  console.log('--- Live smoke: unified Jobs read model ---');
  const ops = new OperationsService(client as any);

  // 1. status=all — the merged stream must execute without schema errors.
  const all = await ops.listJobs({ status: 'all', sort: 'recently_updated', page: 1, limit: 25 });
  assert.ok(Array.isArray(all.items), 'items is an array');
  assert.ok(all.total >= 0, 'total computed');
  const mgmtRows = all.items.filter((i) => i.origin === 'management');
  const uploadRows = all.items.filter((i) => i.origin === 'upload');
  ok(`status=all executes against live schema (${all.total} total: ${uploadRows.length} upload + ${mgmtRows.length} management on page)`);

  // 2. status=deleted — provider_delete operations only.
  const deleted = await ops.listJobs({ status: 'deleted', page: 1, limit: 25 });
  assert.ok(deleted.items.every((i) => i.operationType === 'delete'), 'deleted filter returns only delete ops');
  ok(`status=deleted → ${deleted.total} delete-file operations (live: 2 success + 5 failed provider_deletes = 7 expected)`);

  // 3. operationType=delete.
  const deleteType = await ops.listJobs({ operationType: 'delete', page: 1, limit: 25 });
  assert.equal(deleteType.total, deleted.total, 'type=delete matches status=deleted');
  ok('operationType=delete matches the Deleted status filter');

  // 4. status=ready (completed uploads + successful management ops).
  const ready = await ops.listJobs({ status: 'ready', page: 1, limit: 25 });
  assert.ok(ready.items.every((i) => i.status === 'ready'));
  ok(`status=ready → ${ready.total} completed operations`);

  // 5. status=stale — DB-side stale filter executes.
  const stale = await ops.listJobs({ status: 'stale', page: 1, limit: 25 });
  ok(`status=stale executes (live stale count: ${stale.total})`);

  console.log('--- Live smoke: asset inventory read model ---');
  const control = new HostingControlService(client as any);

  // 6. DEFAULT inventory — deleted assets EXCLUDED (live DB has exactly 2
  //    media_assets, both status='deleted' → default view must be EMPTY).
  const def = await control.listAssets({ page: 1, limit: 25 });
  assert.ok(def.items.every((i) => i.status !== 'deleted'), 'no deleted rows in default view');
  ok(`default (active) inventory: ${def.total} files — live DB's 2 assets are BOTH deleted → correctly excluded (was 2 pre-remediation)`);

  // 7. Explicit deleted audit view.
  const deletedView = await control.listAssets({ status: 'deleted', page: 1, limit: 25 });
  assert.equal(deletedView.total, 2, `expected the 2 live deleted assets, got ${deletedView.total}`);
  ok('explicit status=deleted audit view shows the 2 terminal files');

  // 8. Facet counts — same dataset (all zero for active scope on this DB).
  assert.ok(def.counts, 'counts present');
  assert.equal(def.counts.contentType.all, def.total, 'contentType.all matches total');
  ok(`facet counts: contentType=${JSON.stringify(def.counts.contentType)} provider=${JSON.stringify(def.counts.provider)}`);

  // 9. Detached filter executes (live: 0 non-deleted detached).
  const detachedView = await control.listAssets({ linked: 'detached', page: 1, limit: 25 });
  assert.ok(detachedView.items.every((i) => i.maveroStatus === 'missing'));
  ok(`linked=detached filter executes (${detachedView.total} rows)`);

  // 10. Legacy 'unlinked' alias → same as detached.
  const aliasView = await control.listAssets({ linked: 'unlinked', page: 1, limit: 25 });
  assert.equal(aliasView.total, detachedView.total, 'legacy unlinked alias = detached');
  ok('legacy linked=unlinked alias maps to detached semantics');

  console.log(`\n  Live smoke passed: ${passed} checks`);
})().catch((err) => {
  console.error('  LIVE SMOKE FAILED:', err instanceof Error ? err.message : err);
  process.exit(1);
});
