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

  // 2. status=deleted — SUCCESSFUL provider_delete operations only.
  //    GROUND TRUTH is derived from the live media_operations table (the
  //    production data drifts as admins delete files — e.g. 2 successful
  //    deletes at the previous audit, 3 after the admin deleted the failed
  //    test upload). The failed deletes must NOT appear under Deleted.
  const { data: pdRows } = await client.from('media_operations')
    .select('status').eq('action', 'provider_delete');
  const pdLive = (pdRows ?? []) as Array<{ status: string }>;
  const pdSuccessLive = pdLive.filter((r) => r.status === 'success').length;
  const pdFailedLive = pdLive.filter((r) => r.status === 'failed').length;
  const deleted = await ops.listJobs({ status: 'deleted', page: 1, limit: 25 });
  assert.ok(deleted.items.every((i) => i.operationType === 'delete'), 'deleted filter returns only delete ops');
  assert.ok(deleted.items.every((i) => i.status === 'ready'), 'every Deleted row is a SUCCESSFUL delete (status ready = media_operations success)');
  assert.ok(deleted.items.every((i) => i.origin === 'management'), 'deleted rows come from media_operations');
  assert.equal(deleted.total, pdSuccessLive, `live Deleted total must equal the live successful provider_delete count (${pdSuccessLive}), got ${deleted.total}`);
  ok(`status=deleted → ${deleted.total} successful file deletions (${pdFailedLive} failed deletes correctly EXCLUDED)`);

  // 2b. The failed deletes must appear under the FAILED filter instead.
  const failedFilter = await ops.listJobs({ status: 'failed', page: 1, limit: 25 });
  const failedDeletes = failedFilter.items.filter((i) => i.operationType === 'delete' && i.origin === 'management');
  assert.equal(failedDeletes.length, Math.min(pdFailedLive, 25), `live Failed filter must include the ${pdFailedLive} failed provider_deletes, got ${failedDeletes.length}`);
  assert.ok(failedDeletes.every((i) => i.status === 'failed'));
  // Disjointness: no row in both Deleted and Failed buckets.
  const overlap = deleted.items.filter((d) => failedFilter.items.some((f) => f.id === d.id));
  assert.equal(overlap.length, 0, 'no operation may appear in both Deleted and Failed buckets');
  ok(`status=failed → includes the 5 failed deletes (+ ${failedFilter.total - failedDeletes.length} failed uploads); buckets disjoint`);

  // 2c. Pagination invariant LIVE — Deleted dataset (2 rows) with limit=1:
  //     page 1 = 1 row + hasMore, page 2 = 1 row + !hasMore, page 3 = empty.
  // (Pagination invariant only meaningful when the Deleted dataset has ≥2
  // rows — true in the live production data.)
  if (pdSuccessLive >= 2) {
    const dP1 = await ops.listJobs({ status: 'deleted', page: 1, limit: 1 });
    assert.equal(dP1.items.length, 1); assert.equal(dP1.total, pdSuccessLive); assert.equal(dP1.hasMore, true);
    const dP2 = await ops.listJobs({ status: 'deleted', page: 2, limit: 1 });
    assert.equal(dP2.items.length, 1); assert.equal(dP2.total, pdSuccessLive); assert.equal(dP2.hasMore, pdSuccessLive > 2);
    const dP3 = await ops.listJobs({ status: 'deleted', page: pdSuccessLive + 1, limit: 1 });
    assert.equal(dP3.items.length, 0, 'no phantom page beyond the dataset'); assert.equal(dP3.total, pdSuccessLive);
    ok(`Deleted pagination (limit=1): total ${pdSuccessLive} constant across pages, no phantom page`);
  } else {
    ok(`Deleted pagination check skipped (only ${pdSuccessLive} successful deletes live)`);
  }

  // 3. operationType=delete — the Type filter shows ALL delete outcomes
  //    (status-orthogonal): live = 7 (2 success + 5 failed) ≥ Deleted's 2.
  const deleteType = await ops.listJobs({ operationType: 'delete', page: 1, limit: 25 });
  assert.ok(deleteType.total >= deleted.total, 'Type=Delete File is status-orthogonal (superset of Deleted)');
  assert.equal(deleteType.total, pdSuccessLive + pdFailedLive, `live Type=Delete File total must be ${pdSuccessLive + pdFailedLive} (all provider_delete outcomes), got ${deleteType.total}`);
  ok(`operationType=delete → ${deleteType.total} rows (all delete outcomes; status shown per row)`);

  // 4. status=ready (completed uploads + successful management ops).
  const ready = await ops.listJobs({ status: 'ready', page: 1, limit: 25 });
  assert.ok(ready.items.every((i) => i.status === 'ready'));
  ok(`status=ready → ${ready.total} completed operations`);

  // 5. status=stale — DB-side stale filter executes.
  const stale = await ops.listJobs({ status: 'stale', page: 1, limit: 25 });
  ok(`status=stale executes (live stale count: ${stale.total})`);

  // 5b. retryable/stale boolean filters are DB-side (Issue B fix) — rows,
  //     total, and hasMore must describe the SAME dataset. These calls also
  //     exercise the or-grammar against the LIVE PostgREST instance (a
  //     malformed filter would throw a schema/parse error).
  //     Live facts: 3 uploads (2 ready + 1 failed with error_code
  //     STALE_OPERATION — NOT transient) → retryable count = 0, stale = 0.
  const retryableOnly = await ops.listJobs({ status: 'all', retryable: true, page: 1, limit: 25 });
  assert.ok(retryableOnly.items.every((i) => i.isRetryable), 'only retryable rows may appear under retryable=true');
  assert.equal(retryableOnly.total, 0, `live retryable=true must be 0 (STALE_OPERATION is not transient), got ${retryableOnly.total}`);
  assert.equal(retryableOnly.hasMore, false);
  ok('retryable=true → 0 live rows (executes against live PostgREST; exact count)');

  const notRetryable = await ops.listJobs({ status: 'all', retryable: false, page: 1, limit: 25 });
  assert.equal(notRetryable.total, all.total, `retryable=false total (${notRetryable.total}) must equal the unified stream total (${all.total}) when no retryable rows exist`);
  assert.ok(notRetryable.items.every((i) => !i.isRetryable));
  ok(`retryable=false → ${notRetryable.total} rows = full unified stream (uploads + management — exact count)`);

  const staleOnly = await ops.listJobs({ status: 'all', stale: true, page: 1, limit: 25 });
  assert.equal(staleOnly.total, stale.total, 'stale=true agrees with the status=stale DB filter');
  ok(`stale=true → ${staleOnly.total} rows (agrees with status=stale filter)`);

  console.log('--- Live smoke: asset inventory read model ---');
  const control = new HostingControlService(client as any);

  // 6. DEFAULT inventory — deleted assets EXCLUDED. Ground truth is
  //    derived from live media_assets (production data drifts as admins
  //    delete/upload files).
  const { data: liveAssets } = await client.from('media_assets').select('status, mavero_status');
  const liveRows = (liveAssets ?? []) as Array<{ status: string; mavero_status: string }>;
  const liveDeletedAssets = liveRows.filter((r) => r.status === 'deleted').length;
  const liveActiveAssets = liveRows.filter((r) => r.status !== 'deleted').length;
  const def = await control.listAssets({ page: 1, limit: 25 });
  assert.ok(def.items.every((i) => i.status !== 'deleted'), 'no deleted rows in default view');
  assert.equal(def.total, liveActiveAssets, `default (active) inventory must equal the live non-deleted asset count (${liveActiveAssets}), got ${def.total}`);
  ok(`default (active) inventory: ${def.total} files — live DB's ${liveDeletedAssets} deleted assets correctly excluded (was counting them pre-remediation)`);

  // 7. Explicit deleted audit view.
  const deletedView = await control.listAssets({ status: 'deleted', page: 1, limit: 25 });
  assert.equal(deletedView.total, liveDeletedAssets, `expected the ${liveDeletedAssets} live deleted assets, got ${deletedView.total}`);
  ok(`explicit status=deleted audit view shows the ${liveDeletedAssets} terminal files`);

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
