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

// Verify the frontend expects an array
const uploadFlow = readFileSync('src/lib/components/admin2/AdminUploadFlow.svelte', 'utf8');
assert.match(uploadFlow, /\(json\.results \?\? \[\]\)\.map/, 'frontend calls .map() on json.results (expects array)');
ok('C2. Frontend expects json.results to be an array (contract matches API)');

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

// Verify the drawer uses display_name
const detailDrawer = readFileSync('src/lib/components/admin2/AdminMediaDetailDrawer.svelte', 'utf8');
assert.match(detailDrawer, /admin_user_display_name/, 'detail drawer uses admin_user_display_name');
assert.doesNotMatch(detailDrawer, /admin_user_email/, 'detail drawer does NOT use admin_user_email');
ok('D3. AdminMediaDetailDrawer uses admin_user_display_name (not admin_user_email)');

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

const mediaTable = readFileSync('src/lib/components/admin2/AdminMediaTable.svelte', 'utf8');
assert.match(mediaTable, /Not linked/i, 'table renders "Not linked" for items with no assets');
ok('E2. AdminMediaTable renders "Not linked" for empty asset arrays (correct empty state)');

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

// No LIVE source may still import the removed upload service (the dead
// AdminUploadFlow/AdminOps* components reference endpoints only as fetch
// strings — they are unreachable, not compile-breaking).
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
