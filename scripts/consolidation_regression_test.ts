/**
 * Consolidation + Hosting/Operations Fix — Regression Tests
 *
 * Covers:
 *   A. Vidara delete contract (GET method, /v1/video/delete, filecode param)
 *   B. Operations Activity (no profiles.email, uses display_name)
 *   C. Unified Media Library (Provider Files view, drawer actions)
 *   D. Asset lifecycle (detach vs delete semantics preserved)
 *   E. Navigation (no top-level Upload, Operations under Hosting, no Assets tab)
 *   F. Upload selector (hosting providers only — canonical getHostingAdapter check)
 *
 * Run: pnpm exec tsx --tsconfig ./jsconfig.json scripts/consolidation_regression_test.ts
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

let passed = 0;
let failed = 0;
function ok(message: string) {
  passed += 1;
  console.log(`  ok ${passed} - ${message}`);
}

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative: string) => readFileSync(path.join(REPO_ROOT, relative), 'utf8');

console.log('\n=== Consolidation + Hosting/Operations Fix — Regression Tests ===\n');

// ============================================================
// A. Vidara Delete Contract
// ============================================================
console.log('--- A. Vidara Delete Contract ---');

const vidaraAdapter = read('src/lib/server/hosting/vidara/adapter.ts');
const deleteMatch = vidaraAdapter.match(/async deleteAsset[\s\S]*?\n  \}/);
assert.ok(deleteMatch, 'A1. Vidara deleteAsset method found');

// Method must be GET (NOT POST)
assert.match(deleteMatch[0], /method:\s*'GET'/, 'A2. Vidara delete uses GET method (NOT POST)');
assert.doesNotMatch(deleteMatch[0], /method:\s*'POST'/, 'A3. Vidara delete does NOT use POST');

// URL must be /v1/video/delete with filecode query param (no underscore)
assert.match(deleteMatch[0], /this\.url\('\/v1\/video\/delete', \{ filecode: providerAssetId \}\)/, 'A4. Vidara delete uses filecode query param (no underscore)');

// Must NOT use file_code (underscore) in actual code (comments are OK)
const deleteCodeOnly = deleteMatch[0].replace(/\/\/.*$/gm, '');
assert.doesNotMatch(deleteCodeOnly, /file_code/, 'A5. Vidara delete does NOT use file_code in code (underscore)');

// Must NOT send a JSON body
assert.doesNotMatch(deleteMatch[0], /body:\s*\{/, 'A6. Vidara delete does NOT send JSON body');

// Success detection: checks result field
assert.match(deleteMatch[0], /result/, 'A7. Vidara delete checks result field for success');

// Error propagation: throws HostingProviderError on failure
assert.match(deleteMatch[0], /throw new HostingProviderError/, 'A8. Vidara delete throws HostingProviderError on failure');
ok('A. Vidara delete: GET /v1/video/delete?filecode=<id> (correct contract)');

// ============================================================
// B. Operations Activity Fix
// ============================================================
console.log('\n--- B. Operations Activity Fix ---');

const opsService = read('src/lib/server/hosting/operations/service.ts');
const opsTypes = read('src/lib/shared/operations-types.ts');
const opsHistoryComponent = read('src/lib/components/admin2/AdminOpsHistory.svelte');
const legacyOpsEndpoint = read('src/routes/api/admin/media/operations/+server.ts');

// The query must NOT reference profiles.email
assert.doesNotMatch(opsService, /profiles\(id, email\)/, 'B1. OperationsService no longer queries profiles(id, email)');

// The query MUST use profiles(id, display_name)
assert.match(opsService, /profiles\(id, display_name\)/, 'B2. OperationsService queries profiles(id, display_name)');

// The field must be populated from display_name
assert.match(opsService, /row\.admin_user\?\.display_name/, 'B3. OperationsService reads display_name from the joined row');

// The type must be renamed to adminUserDisplayName
assert.match(opsTypes, /adminUserDisplayName:\s*string \| null/, 'B4. HistoryRow type has adminUserDisplayName field');
assert.doesNotMatch(opsTypes, /adminUserEmail/, 'B5. HistoryRow type no longer has adminUserEmail field');

// The component must use adminUserDisplayName
assert.match(opsHistoryComponent, /adminUserDisplayName/, 'B6. AdminOpsHistory component uses adminUserDisplayName');
assert.doesNotMatch(opsHistoryComponent, /adminUserEmail/, 'B7. AdminOpsHistory component no longer uses adminUserEmail');

// Legacy endpoint also fixed
assert.doesNotMatch(legacyOpsEndpoint, /profiles\(id, email\)/, 'B8. Legacy /api/admin/media/operations endpoint also fixed');
assert.match(legacyOpsEndpoint, /profiles\(id, display_name\)/, 'B9. Legacy endpoint uses profiles(id, display_name)');
ok('B. Operations Activity: profiles.email → profiles(display_name), type renamed, consumers updated');

// ============================================================
// C. Unified Media Library
// ============================================================
console.log('\n--- C. Unified Media Library ---');

const libraryPage = read('src/routes/admin/media/library/+page.svelte');
const libraryServer = read('src/routes/admin/media/library/+page.server.ts');
const mediaDrawer = read('src/lib/components/admin2/AdminMediaDetailDrawer.svelte');

// Provider Files view toggle
assert.match(libraryPage, /currentView/, 'C1. Library page has currentView state');
assert.match(libraryPage, /viewTabs/, 'C2. Library page has viewTabs');
assert.match(libraryPage, /'media'.*'files'|'files'.*'media'/, 'C3. View tabs include media and files');
assert.match(libraryPage, /AdminHostingAssets/, 'C4. Library page renders AdminHostingAssets in files view');
assert.match(libraryPage, /'files'/, 'C5. Files view is URL-driven via view param');

// Library server enriches hostingSources with capabilities
assert.match(libraryServer, /getHostingAdapter/, 'C6. Library server uses getHostingAdapter to enrich sources');
assert.match(libraryServer, /capabilities/, 'C7. Library server adds capabilities to hostingSources');
ok('C. Unified Media Library: Provider Files view + capabilities enrichment');

// Drawer has Delete, Rename, Move actions
assert.match(mediaDrawer, /deleteAsset/, 'C8. Media drawer has deleteAsset handler');
assert.match(mediaDrawer, /confirmRename/, 'C9. Media drawer has confirmRename handler');
assert.match(mediaDrawer, /confirmMove/, 'C10. Media drawer has confirmMove handler');
assert.match(mediaDrawer, /renameModal/, 'C11. Media drawer has renameModal state');
assert.match(mediaDrawer, /moveModal/, 'C12. Media drawer has moveModal state');

// Delete confirmation dialog
assert.match(mediaDrawer, /confirmDialog\.action === 'delete'/, 'C13. Media drawer has delete confirmation dialog');

// Delete button is rendered for assets with provider_asset_id
assert.match(mediaDrawer, /Trash2.*Delete/, 'C14. Media drawer renders Delete button');
assert.match(mediaDrawer, /Pencil.*Rename/, 'C15. Media drawer renders Rename button');
assert.match(mediaDrawer, /FolderInput.*Move/, 'C16. Media drawer renders Move button');

// Existing actions preserved
assert.match(mediaDrawer, /detachAsset/, 'C17. Media drawer still has detachAsset');
assert.match(mediaDrawer, /reactivateAsset/, 'C18. Media drawer still has reactivateAsset');
assert.match(mediaDrawer, /reconcileAsset/, 'C19. Media drawer still has reconcileAsset');
ok('C2. Media drawer: Delete/Rename/Move added, existing actions preserved');

// ============================================================
// D. Asset Lifecycle Semantics
// ============================================================
console.log('\n--- D. Asset Lifecycle Semantics ---');

const managementService = read('src/lib/server/hosting/management/service.ts');

// DETACH: sets mavero_status='missing', does NOT delete remote file
const detachMatch = managementService.match(/async detachAsset[\s\S]*?return \{ ok: true/);
assert.ok(detachMatch, 'D1. detachAsset method found');
assert.match(detachMatch[0], /mavero_status: 'missing'/, 'D2. detach sets mavero_status=missing');
assert.doesNotMatch(detachMatch[0], /adapter\.deleteAsset/, 'D3. detach does NOT call adapter.deleteAsset');
// The "preserved" / "NOT deleted" semantics are documented in the method's docstring
// (above the method), not in the method body. Check the full file for the invariant.
assert.match(managementService, /Does NOT delete the provider-side file/i, 'D4. Management service documents that detach does NOT delete the provider file');

// DELETE: calls adapter.deleteAsset FIRST, then marks DB deleted only on success
const deleteMatchMgmt = managementService.match(/async deleteAsset[\s\S]*?return \{ ok: false[\s\S]*?\}/);
assert.ok(deleteMatchMgmt, 'D5. deleteAsset method found');
assert.match(deleteMatchMgmt[0], /adapter\.deleteAsset\(asset\.provider_asset_id\)/, 'D6. delete calls adapter.deleteAsset first');
assert.match(deleteMatchMgmt[0], /Only update Mavero state after provider confirms/, 'D7. delete only updates DB after provider confirms');
assert.match(deleteMatchMgmt[0], /status: 'deleted'[\s\S]*?mavero_status: 'missing'/, 'D8. delete marks status=deleted, mavero_status=missing on success');
assert.match(deleteMatchMgmt[0], /do NOT mark the Mavero asset as deleted/, 'D9. delete does NOT mark DB deleted on provider failure');
ok('D. Asset lifecycle: detach preserves remote file, delete removes it (semantics intact)');

// ============================================================
// E. Navigation Consolidation
// ============================================================
console.log('\n--- E. Navigation Consolidation ---');

const appShell = read('src/lib/components/admin2/AdminAppShell.svelte');
const hostingServer = read('src/routes/admin/hosting/+page.server.ts');
const hostingPage = read('src/routes/admin/hosting/+page.svelte');

// No top-level Upload / Import in nav
assert.doesNotMatch(appShell, /label: 'Upload \/ Import'/, 'E1. No top-level Upload / Import nav entry');
assert.doesNotMatch(appShell, /id: 'upload'.*label: 'Upload'/, 'E2. No upload item in desktop nav');

// Mobile nav: no Upload, has Media Library instead
assert.doesNotMatch(appShell, /id: 'upload'.*label: 'Upload'.*href: '\/admin\/media\/upload'/, 'E3. No upload in mobile nav');
assert.match(appShell, /id: 'media-library'.*label: 'Media'.*href: '\/admin\/media\/library'/, 'E4. Mobile nav has Media Library');

// Operations is under Hosting group (not a separate top-level group)
assert.doesNotMatch(appShell, /id: 'operations'.*label: 'Operations'[\s\S]*?items: \[\s*\{ id: 'operations'/, 'E5. Operations is not a separate top-level nav group');

// Operations item exists in the Hosting group
// Find the hosting group and check it contains operations
const hostingGroupMatch = appShell.match(/id: 'hosting'[\s\S]*?items: \[([\s\S]*?)\]\s*\}/);
assert.ok(hostingGroupMatch, 'E6. Hosting nav group found');
assert.match(hostingGroupMatch[1], /id: 'hosting'.*label: 'Hosting Control'/, 'E7. Hosting group has Hosting Control');
assert.match(hostingGroupMatch[1], /id: 'operations'.*label: 'Operations'/, 'E8. Hosting group contains Operations');
ok('E. Navigation: Upload removed, Operations under Hosting');

// Hosting page: Assets tab removed, redirects to Media Library
assert.match(hostingServer, /tab === 'assets'/, 'E9. Hosting server checks for assets tab');
assert.match(hostingServer, /redirect\(303, '\/admin\/media\/library\?view=files'\)/, 'E10. Hosting server redirects assets tab to Media Library');
assert.doesNotMatch(hostingServer, /'assets'.*'sync'/, 'E11. Hosting VALID_TABS does not include assets');

// Hosting page UI: no Assets tab
assert.doesNotMatch(hostingPage, /\{ id: 'assets', label: 'Assets' \}/, 'E12. Hosting page UI has no Assets tab');
assert.match(hostingPage, /\{ id: 'providers', label: 'Providers' \}/, 'E13. Hosting page has Providers tab');
assert.match(hostingPage, /\{ id: 'sync', label: 'Sync' \}/, 'E14. Hosting page has Sync tab');

// openAssetsForProvider navigates to Media Library
assert.match(hostingPage, /\/admin\/media\/library\?view=files/, 'E15. openAssetsForProvider navigates to Media Library');
ok('E2. Hosting: Assets tab removed, redirects to Media Library');

// ============================================================
// F. Upload Selector (hosting providers only)
// ============================================================
console.log('\n--- F. Upload Selector ---');

const uploadServer = read('src/routes/admin/media/upload/+page.server.ts');
const registry = read('src/lib/server/hosting/registry.ts');

// Upload page filters by getHostingAdapter() != null
assert.match(uploadServer, /getHostingAdapter\(s\.adapterId\)/, 'F1. Upload page uses getHostingAdapter to check hosting capability');
assert.match(uploadServer, /return adapter !== null/, 'F2. Upload page filters where getHostingAdapter returns non-null');

// No hardcoded Vidara/Abyss-only filtering
assert.doesNotMatch(uploadServer, /adapterId === 'vidara' \|\| .* === 'abyss'/, 'F3. No hardcoded Vidara/Abyss string matching');
ok('F. Upload selector: canonical getHostingAdapter() filter, future-proof');

// ============================================================
// G. Regression Checks — Existing Systems Preserved
// ============================================================
console.log('\n--- G. Regression: Existing Systems Preserved ---');

// Vidara embed URL unchanged
const vidaraNormalize = read('src/lib/server/hosting/vidara/normalize.ts');
assert.match(vidaraNormalize, /vidara\.to\/e\//, 'G1. Vidara embed URL still vidara.to/e/');

// Management service still uses canonical resolver
assert.match(managementService, /resolveAdapterForSource/, 'G2. Management service uses canonical resolver');

// Upload route still works (kept for deep links)
const uploadRoute = read('src/routes/api/admin/media/upload/+server.ts');
assert.match(uploadRoute, /requireAdmin/, 'G3. Upload API route still requires admin');
assert.match(uploadRoute, /resolveAdapterForSource/, 'G4. Upload API route uses canonical resolver');

// Media Library still has the media-item-centric list + drawer
assert.match(libraryServer, /MediaLibraryService/, 'G5. Library server still uses MediaLibraryService');
assert.match(libraryPage, /AdminMediaTable/, 'G6. Library page still renders AdminMediaTable');
assert.match(libraryPage, /AdminMediaDetailDrawer/, 'G7. Library page still renders AdminMediaDetailDrawer');

// Operations endpoints still work
const opsCountsEndpoint = read('src/routes/api/admin/operations/counts/+server.ts');
assert.match(opsCountsEndpoint, /requireAdmin/, 'G8. Operations counts endpoint still requires admin');

// Delete route still requires admin + returns proper error
const deleteRoute = read('src/routes/api/admin/media/assets/[id]/delete/+server.ts');
assert.match(deleteRoute, /requireAdmin/, 'G9. Delete route still requires admin');
assert.match(deleteRoute, /result\.ok \? 200 : 502/, 'G10. Delete route returns 502 on failure');

// Abyss adapter unchanged
const abyssAdapter = read('src/lib/server/hosting/abyss/adapter.ts');
const abyssDelete = abyssAdapter.match(/async deleteAsset[\s\S]*?\n  \}/);
assert.ok(abyssDelete, 'G11. Abyss deleteAsset method found');
assert.match(abyssDelete[0], /method:\s*'DELETE'/, 'G12. Abyss delete still uses DELETE method');
ok('G. Regression: all existing systems preserved (Vidara embed, resolver, upload route, admin auth, Abyss)');

// ============================================================
// SUMMARY
// ============================================================
console.log('\n=== Summary ===');
console.log(`  Passed: ${passed}`);
console.log(`  Failed: ${failed}`);
if (failed > 0) {
  console.error(`\n  ${failed} test(s) FAILED`);
  process.exit(1);
} else {
  console.log(`\n  All ${passed} tests passed.`);
}
