import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

/**
 * Admin 2.0 — Phase 0 — Recovery & P0 Stabilization tests.
 *
 * Verifies:
 * A. The Upload/Import workflow is REMOVED (2026-10-15 deliberate
 *    removal: pages, routes, service, and barrel are gone; the audit
 *    writer survives in hosting/media/operation-audit.ts)
 * B. Analytics trend uses correct field name (points, not series)
 * C. TMDB search API returns array (not ContentList object)
 * D. Media Library detail query uses display_name (not email)
 * E. Dune linkage investigation — verified as correct DB state
 * F. Upload flow API endpoints are REMOVED (no orphaned routes)
 */

let passed = 0;
function ok(message: string) {
  passed += 1;
  console.log(`  ok ${passed} - ${message}`);
}

// ============================================================
// A. Upload/Import workflow REMOVED (2026-10-15)
// ============================================================
// The workflow was deliberately removed: no upload page, no upload
// service, no barrel. The ONE surviving capability — the media_operations
// audit writer — is rehomed in src/lib/server/hosting/media/
// operation-audit.ts (same table, same best-effort semantics).

assert.ok(!existsSync('src/routes/admin/media/upload/+page.svelte'), 'upload page removed');
assert.ok(!existsSync('src/routes/admin/media/upload/+page.server.ts'), 'upload page server removed');
assert.ok(!existsSync('src/lib/server/hosting/upload/service.ts'), 'upload service removed');
assert.ok(!existsSync('src/lib/server/hosting/upload/index.ts'), 'upload index removed');
ok('A1. Upload workflow files removed (page + page.server + service + index)');

assert.ok(existsSync('src/lib/server/hosting/media/operation-audit.ts'), 'rehomed audit writer exists');
const operationAudit = readFileSync('src/lib/server/hosting/media/operation-audit.ts', 'utf8');
assert.match(operationAudit, /recordMediaOperation/, 'audit writer exports recordMediaOperation');
assert.match(operationAudit, /media_operations/, 'audit writer inserts into media_operations');
assert.match(operationAudit, /silently absorb|Silently absorb/, 'audit writer keeps best-effort semantics');
ok('A2. media_operations audit writer rehomed (recordMediaOperation, best-effort)');

const manualLinkContract = readFileSync('src/lib/server/hosting/media/manual-link-contract.ts', 'utf8');
assert.doesNotMatch(manualLinkContract, /upload\/service/, 'manual-link contract no longer imports the upload service');
assert.match(manualLinkContract, /recordMediaOperation/, 'manual-link contract audits via the rehomed writer');
ok('A3. Manual-link contract uses the rehomed audit writer (no upload dependency)');

// ============================================================
// B. Analytics trend uses correct field name
// ============================================================

const analyticsPage = readFileSync('src/routes/admin/analytics/+page.svelte', 'utf8');
assert.doesNotMatch(analyticsPage, /o\.trend\.series/, 'analytics page does NOT reference o.trend.series');
assert.match(analyticsPage, /o\.trend\.points/, 'analytics page references o.trend.points');
ok('B1. Analytics page uses o.trend.points (not o.trend.series)');

const overviewService = readFileSync('src/lib/server/analytics/overview.ts', 'utf8');
assert.match(overviewService, /points: TrendPoint\[\]/, 'TrendSeries type has points field');
assert.doesNotMatch(overviewService, /series: TrendPoint\[\]/, 'TrendSeries type does NOT have series field');
ok('B2. TrendSeries type has points (not series) — contract is consistent');

// ============================================================
// C. TMDB search API returns array
// ============================================================

const searchApi = readFileSync('src/routes/api/admin/media/search/+server.ts', 'utf8');
assert.match(searchApi, /results: results\.items/, 'search API returns results.items (array)');
assert.doesNotMatch(searchApi, /return json\(\{ ok: true, results \}\)/, 'search API does NOT return raw ContentList');
ok('C1. TMDB search API returns results: results.items (array, not ContentList object)');

// 2026-10-16 re-pin: AdminUploadFlow was deleted with the upload workflow.
// The array contract is now verified on the LIVE consumers — the Add File
// wizard (TMDB search) — plus the removal itself is asserted.
const wizard = readFileSync('src/lib/components/admin2/AdminAddFileWizard.svelte', 'utf8');
assert.match(wizard, /json\.results \?\? \[\]/, 'the wizard treats json.results as an array');
ok('C2. Frontend expects json.results to be an array (contract matches API — verified on the live wizard)');
assert.ok(!existsSync('src/lib/components/admin2/AdminUploadFlow.svelte'), 'AdminUploadFlow component removed (workflow retired)');
ok('C2b. AdminUploadFlow component deleted (2026-10-16 upload-removal completion)');

// ============================================================
// D. Media Library detail query uses display_name
// ============================================================

const libraryService = readFileSync('src/lib/server/hosting/library/service.ts', 'utf8');
assert.doesNotMatch(libraryService, /profiles\(email\)/, 'detail query does NOT select profiles(email)');
assert.match(libraryService, /profiles\(display_name\)/, 'detail query selects profiles(display_name)');
ok('D1. MediaLibraryService.detail() uses profiles(display_name) (not profiles(email))');

// Verify the consumer uses display_name
assert.match(libraryService, /admin_user_display_name/, 'service has admin_user_display_name field');
assert.match(libraryService, /op\.admin_user\?\.display_name/, 'consumer accesses op.admin_user?.display_name');
assert.doesNotMatch(libraryService, /op\.admin_user\?\.email/, 'consumer does NOT access op.admin_user?.email');
ok('D2. LibraryOperationSummary has admin_user_display_name (consumer updated)');

// 2026-10-16 re-pin: AdminMediaDetailDrawer (dead code, unimported) was
// deleted with the legacy asset-manager UI. The display_name contract
// lives in the library read model (D1/D2) and is rendered by the
// operations history UI; assert the drawer is GONE.
assert.ok(!existsSync('src/lib/components/admin2/AdminMediaDetailDrawer.svelte'), 'AdminMediaDetailDrawer removed (dead code)');
ok('D3. AdminMediaDetailDrawer deleted — the display_name contract stays verified on the service (D1/D2)');

// ============================================================
// E. Dune linkage investigation result
// ============================================================

// The investigation confirmed that "Not Linked" for Dune is the correct
// rendering when no media_assets rows exist for a given media_item.
// This is NOT a bug — it's the intended empty state.
// The code path is:
//   list() → batch-fetch assets → assetsByItem.get(item.id) ?? []
//   → empty array → AdminMediaTable/AdminMediaCard renders "Not linked"
//
// No code fix was needed. This test verifies the rendering logic is correct.

assert.match(libraryService, /assetsByItem\.get\(item\.id\) \?\? \[\]/, 'list() returns empty array when no assets exist');
ok('E1. Dune "Not Linked" is correct behavior — list() returns [] when no media_assets exist (not a bug)');

// 2026-10-16 re-pin: AdminMediaTable (dead code, unimported) was deleted.
// The honest empty-state contract now lives in the episode sheet's
// "Not linked" badge for episodes with no asset.
const episodeSheet = readFileSync('src/lib/components/admin2/AdminEpisodeSheet.svelte', 'utf8');
assert.match(episodeSheet, /Not linked/, 'the episode sheet renders the honest "Not linked" state');
ok('E2. The live episode sheet renders "Not linked" for empty asset arrays (correct empty state)');

// ============================================================
// F. Upload flow API endpoints REMOVED (2026-10-15)
// ============================================================

const uploadEndpoints = [
  'src/routes/api/admin/media/upload/+server.ts',
  'src/routes/api/admin/media/upload/[id]/cancel/+server.ts',
  'src/routes/api/admin/media/upload/[id]/complete/+server.ts',
  'src/routes/api/admin/media/upload/[id]/proxy-upload/+server.ts',
  'src/routes/api/admin/media/upload/[id]/retry/+server.ts',
  'src/routes/api/admin/media/upload/[id]/status/+server.ts',
  'src/routes/api/admin/media/upload/[id]/subtitle/+server.ts',
  'src/routes/api/admin/media/upload/[id]/upload-server/+server.ts',
];

for (const endpoint of uploadEndpoints) {
  assert.ok(!existsSync(endpoint), `upload endpoint removed: ${endpoint}`);
}
ok('F1. All 8 upload API endpoints removed from disk (workflow retired)');

// No LIVE source may still import the removed upload service. (The dead
// AdminUploadFlow/AdminMediaDetailDrawer/AdminMediaTable components were
// DELETED in the 2026-10-16 completion round — no fetch-string references
// to removed endpoints remain anywhere in src/.)
const liveSources = [
  'src/lib/server/hosting/media/manual-link-contract.ts',
  'src/lib/server/hosting/management/service.ts',
  'src/routes/api/admin/media/manual-link/+server.ts',
  'src/routes/api/admin/media/bulk-link/+server.ts',
  'src/routes/admin/hosting/+page.server.ts',
];
for (const src of liveSources) {
  const content = readFileSync(src, 'utf8');
  assert.doesNotMatch(content, /hosting\/upload|\.\.\/upload\/service/, `no upload import: ${src}`);
}
ok('F2. No live source imports the removed upload service (removal complete)');

console.log(`\nPhase 0 tests passed (${passed} check groups).`);
