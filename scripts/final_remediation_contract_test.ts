/**
 * FINAL REMEDIATION — REGRESSION CONTRACT TESTS.
 *
 * Source-contract coverage for every architecture change in the final
 * remediation (companion to final_remediation_behavioral_test.ts which
 * exercises real service behavior with a mock DB client):
 *
 *   1. Media Library deleted-exclusion default (service + API)
 *   2. Facet counts (file counts from the same dataset)
 *   3. Library page server URL wiring (provider/mediaItem/status/view)
 *   4. Hosting provider deep-link initializes the provider filter
 *   5. Jobs unified read model + Deleted filter (service + API + shared types)
 *   6. Activity "Delete File" wording everywhere (never "Provider Delete")
 *   7. Mobile Mavero-native filter sheet (AdminFilterSheet, no <select>)
 *   8. Detach durability (sync / reconcile / upload poll preserve missing)
 *   9. Vidara delete NOT_FOUND terminal-state mapping
 *  10. linkAsset impossible-NULL guard (ASSET_STATE) + dead path removal
 *  11. Delete success → terminal drawer state (no stuck stale actions)
 *  12. Deep-links repointed to ?mediaItem= (Jobs/History/Attention/Upload)
 *  13. Demand service fixes (no .limit(1); recordDemand guard)
 *  14. Playback resolver dual-gate unchanged (regression)
 *  15. Legacy routes still redirect (operations/view=assets)
 */

import { readFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';

const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');

/**
 * Strips block + line comments so negative assertions test MARKUP/CODE,
 * not explanatory comments (comments legitimately reference removed
 * patterns like ".limit(1)" or "tab=assets" when documenting the fix).
 */
const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const controlService = read('../src/lib/server/hosting/control/service.ts');
const opsService = read('../src/lib/server/hosting/operations/service.ts');
const demandService = read('../src/lib/server/hosting/demand/service.ts');
const managementService = read('../src/lib/server/hosting/management/service.ts');
const syncService = read('../src/lib/server/hosting/sync/service.ts');
const uploadService = read('../src/lib/server/hosting/upload/service.ts');
const vidaraAdapter = read('../src/lib/server/hosting/vidara/adapter.ts');
const resolverHosted = read('../src/lib/server/resolver/mavero-hosted.ts');

const assetsApi = read('../src/routes/api/admin/hosting/assets/+server.ts');
const jobsApi = read('../src/routes/api/admin/operations/jobs/+server.ts');
const historyApi = read('../src/routes/api/admin/operations/history/+server.ts');
const unlinkedApi = read('../src/routes/api/admin/media/unlinked/+server.ts');

const libraryPageServer = read('../src/routes/admin/media/library/+page.server.ts');
const libraryPage = read('../src/routes/admin/media/library/+page.svelte');
const operationsPageServer = read('../src/routes/admin/operations/+page.server.ts');
const hostingPageServer = read('../src/routes/admin/hosting/+page.server.ts');
const hostingPage = read('../src/routes/admin/hosting/+page.svelte');

const hostingAssets = read('../src/lib/components/admin2/AdminHostingAssets.svelte');
const opsJobs = read('../src/lib/components/admin2/AdminOpsJobs.svelte');
const opsHistory = read('../src/lib/components/admin2/AdminOpsHistory.svelte');
const opsAttention = read('../src/lib/components/admin2/AdminOpsAttention.svelte');
const uploadFlow = read('../src/lib/components/admin2/AdminUploadFlow.svelte');
const adminFilterSheet = read('../src/lib/components/admin2/AdminFilterSheet.svelte');
const hostingTypes = read('../src/lib/shared/hosting-types.ts');
const opsTypes = read('../src/lib/shared/operations-types.ts');

let passed = 0;
let failed = 0;
function ok(name: string) { passed++; console.log(`  ok - ${name}`); }
function run(name: string, fn: () => void) {
  try { fn(); ok(name); }
  catch (err) { failed++; console.error(`  FAIL - ${name}`); console.error(err instanceof Error ? err.message : String(err)); }
}

console.log('--- 1. Media Library deleted-exclusion default ---');
run('1a. listAssets defaults status to active (deleted EXCLUDED)', () => {
  assert.match(controlService, /statusFilter = query\.status \?\? 'active'/);
  assert.match(controlService, /neq\('status', 'deleted'\)/);
});
run('1b. assets API defaults status=active', () => {
  assert.match(assetsApi, /url\.searchParams\.get\('status'\) \?\? 'active'/);
  assert.match(assetsApi, /'deleted', 'active', 'all'\]/);
});
run('1c. facet scope also excludes deleted by default', () => {
  assert.match(controlService, /const statusFilter = scope\.status \?\? 'active'/);
  assert.match(controlService, /q\.neq\('status', 'deleted'\)/);
});
run('1d. UI default status=active + Deleted is explicit opt-in', () => {
  assert.match(hostingAssets, /status: initialFilters\.status \?\? 'active'/);
  assert.match(hostingAssets, /<option value="deleted">Deleted \(terminal\)<\/option>/);
});

console.log('--- 2. Facet counts (file counts, same dataset) ---');
run('2a. listAssets computes + returns facet counts', () => {
  assert.match(controlService, /facetCountQuery/);
  assert.match(controlService, /aggregateFacetCounts/);
  assert.match(controlService, /counts,/);
});
run('2b. HostingAssetFacetCounts type defined (contentType + provider)', () => {
  assert.match(hostingTypes, /export type HostingAssetFacetCounts/);
  assert.match(hostingTypes, /contentType: \{ all: number; movie: number; series: number; anime: number \}/);
});
run('2c. UI renders file-count chips (Type · files, Provider · files)', () => {
  assert.match(hostingAssets, /Type · files/);
  assert.match(hostingAssets, /Provider · files/);
  assert.match(hostingAssets, /counts\?\.contentType\.movie/);
  assert.match(hostingAssets, /counts\?\.provider\[p\.adapterId\]/);
});
run('2d. counts are labeled as FILE counts in docs/types', () => {
  assert.match(hostingTypes, /Counts are FILE counts, not media-item counts/);
});

console.log('--- 3. Library page server URL wiring ---');
run('3a. provider param → initialFilters (validated)', () => {
  assert.match(libraryPageServer, /get\('provider'\)/);
  assert.match(libraryPageServer, /VALID_PROVIDERS/);
});
run('3b. mediaItem deep-link param → initialFilters', () => {
  assert.match(libraryPageServer, /get\('mediaItem'\)/);
  assert.match(libraryPageServer, /\[0-9a-f\]\{8\}-\[0-9a-f\]\{4\}/);
});
run('3c. legacy ?view= stripped via redirect (params preserved)', () => {
  assert.match(libraryPageServer, /params\.delete\('view'\)/);
  assert.match(libraryPageServer, /redirect\(303/);
});
run('3d. page passes initialFilters; component initializes from them', () => {
  assert.match(libraryPage, /initialFilters=\{data\.initialFilters\}/);
  assert.match(hostingAssets, /initialFilters\.provider \?\? 'all'/);
  assert.match(hostingAssets, /initialFilters\.mediaItemId \?\? null/);
});
run('3e. syncUrl preserves canonical params (no ?tab=assets)', () => {
  assert.match(hostingAssets, /function syncUrl/);
  assert.doesNotMatch(stripComments(hostingAssets), /tab=assets/);
  assert.match(hostingAssets, /params\.set\('mediaItem'/);
  assert.match(hostingAssets, /params\.set\('provider'/);
});

console.log('--- 4. Hosting provider deep-link → Media Library filter ---');
run('4a. Hosting Control openAssetsForProvider → /admin/media/library?provider=', () => {
  assert.match(hostingPage, /goto\(`\/admin\/media\/library\?provider=\$\{encodeURIComponent\(adapterId\)\}`\)/);
});

console.log('--- 5. Jobs unified read model + Deleted filter ---');
run('5a. service merges media_operations management actions', () => {
  assert.match(opsService, /MANAGEMENT_ACTION_TO_TYPE/);
  assert.match(opsService, /provider_delete: 'delete'/);
  assert.match(opsService, /\.in\('action', MANAGEMENT_ACTIONS\)/);
});
run('5b. upload-lifecycle actions NEVER sourced from media_operations (no duplicate rows)', () => {
  // The management map must NOT contain upload-lifecycle actions.
  assert.doesNotMatch(opsService, /MANAGEMENT_ACTION_TO_TYPE[^}]*'upload':/);
  assert.doesNotMatch(opsService, /MANAGEMENT_ACTION_TO_TYPE[^}]*upload_remote:/);
});
run('5c. status=deleted maps to provider_delete AND success (successful deletes ONLY)', () => {
  assert.match(opsService, /status === 'deleted'/);
  // The STATUS filter must pin BOTH action and success (failed deletes excluded).
  assert.match(opsService, /mb = mb\.eq\('action', 'provider_delete'\)\.eq\('status', 'success'\)/);
  // The Type filter (operationType==='delete') legitimately matches the action
  // only — status-orthogonal by design; its dedicated line ends after the
  // action filter. Both facts are pinned by the behavioral/live tests.
});
run('5c2. retryable/stale are DB-side (no post-fetch JS filtering)', () => {
  assert.match(opsService, /NOT_RETRYABLE_OR/);
  assert.match(opsService, /query\.retryable === true[\s\S]*?\.in\('error_code', RETRYABLE_ERROR_CODES_LIST\)/);
  assert.match(opsService, /query\.retryable === false[\s\S]*?\.or\(NOT_RETRYABLE_OR\)/);
  assert.match(opsService, /query\.stale === false[\s\S]*?\.or\(notStaleOr\(/);
  // The old desynchronized JS post-filter must be gone.
  assert.doesNotMatch(opsService, /merged\.filter\(\(i\) => i\.isRetryable\)/);
  assert.doesNotMatch(opsService, /merged\.filter\(\(i\) => i\.isStale\)/);
});
run('5d. jobs API VALID_STATUSES includes deleted', () => {
  assert.match(jobsApi, /'deleted', 'all'\]/);
  assert.match(jobsApi, /VALID_OP_TYPES = new Set\(\['upload', 'upload_remote', 'retry', 'delete'/);
});
run('5e. shared types: JobOrigin + JobOperationType + deleted status', () => {
  assert.match(opsTypes, /export type JobOrigin = 'upload' | 'management'/);
  assert.match(opsTypes, /'deleted' \| 'all'/);
  assert.match(opsTypes, /provider_delete, rename, move, detach,[\s\S]*?reactivate, link/);
});
run('5f. merged pagination: per-source depth + summed total', () => {
  assert.match(opsService, /fetchDepth = offset \+ limit/);
  assert.match(opsService, /uploadsRes\.count \?\? 0\) \+ \(managementRes\.count \?\? 0\)/);
});
run('5g. Jobs UI offers the Deleted status option + Delete File type', () => {
  assert.match(opsJobs, /<option value="deleted">Deleted<\/option>/);
  assert.match(opsJobs, /<option value="delete">Delete File<\/option>/);
});
run('5h. Jobs drawer gates pipeline actions by origin', () => {
  assert.match(opsJobs, /selectedJob\.origin === 'management'/);
});

console.log('--- 6. Activity "Delete File" wording ---');
run('6a. ACTION_LABELS maps provider_delete → Delete File', () => {
  assert.match(opsHistory, /provider_delete: 'Delete File'/);
});
run('6b. filter dropdown uses "Delete File"', () => {
  assert.match(opsHistory, /value: 'provider_delete', label: 'Delete File'/);
});
run('6c. NO user-facing "Provider delete" text remains', () => {
  assert.doesNotMatch(stripComments(opsHistory), /Provider [Dd]elete/);
  assert.doesNotMatch(stripComments(opsJobs), /Provider [Dd]elete/);
  assert.doesNotMatch(stripComments(hostingAssets), /Provider [Dd]elete/);
});
run('6d. internal DB action provider_delete stays (no rename churn)', () => {
  assert.match(managementService, /action: 'provider_delete'/);
});
run('6e. Jobs type label for delete is "Delete File"', () => {
  assert.match(opsJobs, /case 'delete': return 'Delete File'/);
});

console.log('--- 7. Mobile Mavero-native filter sheet ---');
run('7a. AdminFilterSheet is chip-based (no native <select>)', () => {
  assert.match(adminFilterSheet, /a2-fs-chip/);
  assert.doesNotMatch(stripComments(adminFilterSheet), /<select/);
  assert.match(adminFilterSheet, /role="dialog"/);
  assert.match(adminFilterSheet, /aria-pressed/);
  assert.match(adminFilterSheet, /safe-area-inset-bottom/);
  assert.match(adminFilterSheet, /prefers-reduced-motion/);
});
run('7b. Jobs mobile sheet uses AdminFilterSheet', () => {
  assert.match(opsJobs, /<AdminFilterSheet/);
});
run('7c. History mobile sheet uses AdminFilterSheet', () => {
  assert.match(opsHistory, /<AdminFilterSheet/);
});
run('7d. Media Library mobile sheet uses AdminFilterSheet', () => {
  assert.match(hostingAssets, /<AdminFilterSheet/);
});
run('7e. the old native-select mobile sheets are gone', () => {
  assert.doesNotMatch(opsJobs, /a2-jobs-filter-sheet/);
  assert.doesNotMatch(opsHistory, /a2-history-filter-sheet/);
  assert.doesNotMatch(hostingAssets, /a2-assets-filter-sheet/);
});

console.log('--- 8. Detach durability ---');
run('8a. provider sync preserves mavero_status=missing', () => {
  // [final 3-issue fix] the sync now resolves the EFFECTIVE status for
  // pre-active (queued) assets via getProcessingStatus — the detach
  // durability invariant is identical, only the status variable changed.
  assert.match(syncService, /effectiveStatus === 'ready' && existing\.mavero_status !== 'missing' \? 'available' : existing\.mavero_status/);
});
run('8b. reconcile preserves mavero_status=missing', () => {
  assert.match(syncService, /procStatus\.status === 'ready' && ar\.mavero_status !== 'missing' \? 'available' : ar\.mavero_status/);
});
run('8c. upload poll guards the available flip with neq(missing)', () => {
  assert.match(uploadService, /\.neq\('mavero_status', 'missing'\)/);
});
run('8d. upload poll skips demand resolution for detached assets', () => {
  assert.match(uploadService, /mavero_status === 'missing'/);
  assert.match(uploadService, /Demand stays open/);
});

console.log('--- 9. Vidara delete NOT_FOUND terminal mapping ---');
run('9a. Vidara deleteAsset throws NOT_FOUND when result is false', () => {
  assert.match(vidaraAdapter, /throw new HostingProviderError\('NOT_FOUND', \{ message: 'Vidara reports the file is no longer present/);
});
run('9b. ManagementService treats provider NOT_FOUND as terminal success', () => {
  assert.match(managementService, /if \(err\.code !== 'NOT_FOUND'\)/);
});

console.log('--- 10. linkAsset impossible-NULL guard ---');
run('10a. NULL media_item_id → deterministic ASSET_STATE error', () => {
  assert.match(managementService, /ASSET_STATE/);
  assert.match(managementService, /impossible under the NOT NULL media_item_id constraint/);
});
run('10b. dead linkExistingAssetRow removed', () => {
  assert.doesNotMatch(managementService, /private async linkExistingAssetRow/);
});
run('10c. deleted rows rejected for linking (ASSET_DELETED)', () => {
  assert.match(managementService, /existingRow\.status === 'deleted'/);
});
run('10d. Media Library Link Existing File targets untracked provider files', () => {
  assert.match(hostingAssets, /Link Existing File/);
  assert.match(hostingAssets, /providers\/\$\{encodeURIComponent\(p\.adapterId\)\}\/files/);
});

console.log('--- 11. Delete success → terminal drawer state ---');
run('11a. executeAction delete success updates selectedAsset to terminal', () => {
  assert.match(hostingAssets, /if \(action === 'delete'\) \{/);
  assert.match(hostingAssets, /status: 'deleted', maveroStatus: 'missing'/);
});
run('11b. deleted drawer: terminal notice + no mutation actions', () => {
  assert.match(hostingAssets, /selectedAsset\.status === 'deleted'/);
  assert.match(hostingAssets, /permanently deleted\. No actions are available/);
});
run('11c. backend delete idempotency guard (no provider call on second delete)', () => {
  assert.match(managementService, /asset\.status === 'deleted'\) \{\s*\n\s*return \{ ok: true, action: 'provider_delete'/);
});

console.log('--- 11b. Terminal-state guards on ALL remote-file mutations ---');
run('11d. rename rejects deleted assets (backend ASSET_DELETED)', () => {
  const body = managementService.match(/async renameAsset[\s\S]*?\n  \}/)?.[0] ?? '';
  assert.match(body, /asset\.status === 'deleted'/);
  assert.match(body, /ASSET_DELETED/);
});
run('11e. move rejects deleted assets (backend ASSET_DELETED)', () => {
  const body = managementService.match(/async moveAsset[\s\S]*?\n  \}/)?.[0] ?? '';
  assert.match(body, /asset\.status === 'deleted'/);
  assert.match(body, /ASSET_DELETED/);
});
run('11f. detach rejects deleted assets (backend ASSET_DELETED)', () => {
  const body = managementService.match(/async detachAsset[\s\S]*?\n  \}/)?.[0] ?? '';
  assert.match(body, /asset\.status === 'deleted'/);
  assert.match(body, /ASSET_DELETED/);
});
run('11g. reconcile rejects deleted assets (backend ASSET_DELETED)', () => {
  // Extract the reconcileAsset method body (up to the media_operations insert).
  const start = syncService.indexOf('async reconcileAsset');
  const end = syncService.indexOf('record the reconcile audit event', start);
  const reconcile = syncService.slice(start, end > 0 ? end : start + 4000);
  assert.ok(reconcile.length > 100, 'reconcileAsset body extracted');
  assert.match(reconcile, /ar\.status === 'deleted'/);
  assert.match(reconcile, /ASSET_DELETED/);
});

console.log('--- 12. Deep-links repointed to ?mediaItem= ---');
run('12a. no dead ?selected= links remain', () => {
  for (const src of [hostingAssets, opsJobs, opsHistory, opsAttention, uploadFlow]) {
    assert.doesNotMatch(src, /library\?selected=/, `?selected= link found`);
  }
});
run('12b. Jobs/History/Attention use ?mediaItem= deep-links', () => {
  assert.match(opsJobs, /library\?mediaItem=\$\{selectedJob\.mediaItem\.id\}/);
  assert.match(opsHistory, /library\?mediaItem=\$\{selectedEvent\.mediaItem\.id\}/);
  assert.match(opsAttention, /library\?mediaItem=\$\{item\.mediaItemId\}/);
});
run('12c. assets API accepts the mediaItem param (UUID-validated)', () => {
  assert.match(assetsApi, /mediaItem/);
  assert.match(assetsApi, /must be a UUID/);
  assert.match(assetsApi, /mediaItemId: mediaItem/);
});

console.log('--- 13. Demand service fixes ---');
run('13a. sweepResolvedDemand no longer collapses the batch with .limit(1)', () => {
  const sweep = demandService.match(/async sweepResolvedDemand[\s\S]*?\n  \}/)?.[0] ?? '';
  assert.ok(sweep, 'sweep method found');
  assert.doesNotMatch(stripComments(sweep), /\.limit\(1\)/);
});
run('13b. sweepStaleResolvedDemand has no .limit(1) either', () => {
  const sweep = demandService.match(/async sweepStaleResolvedDemand[\s\S]*?\n  \}/)?.[0] ?? '';
  assert.doesNotMatch(sweep, /\.limit\(1\)/);
});
run('13c. recordDemand availability guard (no spurious demand)', () => {
  assert.match(demandService, /LIFECYCLE GUARD/);
  assert.match(demandService, /const assetAvailable = await this\.hasReadyAvailableAsset\(entry\.canonicalKey\)/);
  assert.match(demandService, /if \(assetAvailable\) \{/);
});

console.log('--- 14. Playback resolver dual-gate (regression) ---');
run('14a. resolver requires status=ready AND mavero_status=available', () => {
  assert.match(resolverHosted, /eq\('status', 'ready'\)/);
  assert.match(resolverHosted, /eq\('mavero_status', 'available'\)/);
});
run('14b. Vidara embed URL form preserved (vidara.to/e/)', () => {
  const vidaraNormalize = read('../src/lib/server/hosting/vidara/normalize.ts');
  assert.match(vidaraNormalize, /VIDARA_EMBED_URL_BASE = 'https:\/\/vidara\.to\/e\/'/);
});

console.log('--- 15. Legacy routes redirect (regression) ---');
run('15a. /admin/operations redirects to /admin/hosting with tab mapping', () => {
  assert.match(operationsPageServer, /redirect\(303, `\/admin\/hosting\?\$\{params\.toString\(\)\}`\)/);
  assert.match(operationsPageServer, /'history' \? 'activity'/);
});
run('15b. hosting?tab=assets redirects to Media Library', () => {
  assert.match(hostingPageServer, /tab === 'assets'\)\s*\{\s*\n\s*throw redirect\(303, '\/admin\/media\/library'\)/);
});

console.log(`\n  Passed: ${passed}  Failed: ${failed}`);
if (failed > 0) {
  console.error(`\n  ${failed} contract check(s) FAILED`);
  process.exit(1);
}
console.log('  All final remediation contract checks passed.');
