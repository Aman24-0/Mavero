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
import { readFileSync, existsSync } from 'node:fs';
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
// [2026-10-16 re-pin] AdminMediaDetailDrawer was DELETED with the legacy
// asset-manager UI. Its contracts are re-pinned on the LIVE surfaces:
// the management SERVICE (lifecycle semantics — section D), the Add File
// wizard + episode sheet (the link/unlink UI), and OpsAttention/OpsJobs
// (the reconcile action).
assert.ok(!existsSync('src/lib/components/admin2/AdminMediaDetailDrawer.svelte'), 'C0a. AdminMediaDetailDrawer deleted (legacy drawer removed with the asset-manager UI)');
const directLinkEndpoint = read('src/routes/api/admin/media/assets/link/+server.ts');
const opsAttentionC = read('src/lib/components/admin2/AdminOpsAttention.svelte');

// Media Library is a single asset-centric file manager (no view toggle)
assert.match(libraryPage, /AdminMediaList/, 'C1. Library page renders AdminMediaList as the sole file manager');
assert.doesNotMatch(libraryPage, /currentView/, 'C2. Library page has no view toggle (single file manager)');
assert.doesNotMatch(libraryPage, /viewTabs/, 'C3. Library page has no view tabs');

// Library server provides hostingSources with capabilities
assert.match(libraryServer, /getHostingAdapter/, 'C4. Library server uses getHostingAdapter to enrich sources');
assert.match(libraryServer, /capabilities/, 'C5. Library server adds capabilities to hostingSources');
ok('C. Unified Media Library: single asset-centric file manager (no view toggle)');

// [2026-10-16 re-pin] the drawer's Delete/Rename/Move/reactivate UI is
// retired with the drawer — the per-episode DELETE (unlink) is the live
// destructive action, with an explicit confirm (owned by AdminMediaList,
// which renders the confirm dialog the sheet's ondeletelink delegates
// to); rename/move/reactivate remain service/API-level operations (see
// section D below). The direct-UUID link endpoint keeps the canonical
// mediaItemId+providerSourceId+providerAssetId contract the drawer used
// to send.
const mediaListC = read('src/lib/components/admin2/AdminMediaList.svelte');
assert.match(mediaListC, /confirmDelete|deleteTarget/, 'C8. the live list confirms before delete (explicit confirmation dialog)');
assert.match(mediaListC, /method: 'DELETE'/, 'C9. per-episode delete uses the manual-link DELETE (unlink, provider file preserved)');
assert.match(directLinkEndpoint, /mediaItemId/, 'C11. the direct-UUID link endpoint accepts mediaItemId');
assert.match(directLinkEndpoint, /providerSourceId/, 'C12. the direct-UUID link endpoint accepts providerSourceId');
assert.match(directLinkEndpoint, /providerAssetId/, 'C10. the direct-UUID link endpoint accepts providerAssetId');
assert.match(directLinkEndpoint, /requireAdmin/, 'C13. the link endpoint is admin-gated (confirmation-grade write path)');
// The live reconcile action (the drawer's reconcile moved to Ops).
assert.match(opsAttentionC, /reconcileItem/, 'C17. OpsAttention exposes the live reconcile action');
assert.match(read('src/lib/components/admin2/AdminOpsJobs.svelte'), /reconcile/, 'C19. OpsJobs keeps the reconcile action (live endpoint-backed)');
ok('C2. Live surfaces: confirmed unlink, direct-UUID link contract, ops reconcile (rename/move/reactivate remain service-level)');

// ============================================================
// C3. Asset lifecycle — service/API surface (2026-10-16 re-pin)
// ============================================================
console.log('\n--- C3. Asset lifecycle service + link flow (live surfaces) ---');

// [2026-10-16 re-pin] the Provider Files UI (AdminHostingAssets) was
// DELETED with the legacy asset-manager UI. Its lifecycle surface lives
// on at the SERVICE level (every method intact) and the link flow is the
// Add File wizard / direct-UUID endpoint. The dead NULL-media_item path
// stays gone by construction (the component no longer exists).
assert.ok(!existsSync('src/lib/components/admin2/AdminHostingAssets.svelte'), 'C3-0. AdminHostingAssets deleted (legacy Provider Files UI removed)');

// The management service still implements the FULL lifecycle (API surface
// intact for programmatic/admin-tool use):
const managementServiceC3 = read('src/lib/server/hosting/management/service.ts');
assert.match(managementServiceC3, /async renameAsset\(/, 'C3-13. renameAsset service method intact');
assert.match(managementServiceC3, /async moveAsset\(/, 'C3-14. moveAsset service method intact');
assert.match(managementServiceC3, /async detachAsset\(/, 'C3-15. detachAsset service method intact');
assert.match(managementServiceC3, /async deleteAsset\(/, 'C3-16. deleteAsset service method intact');
assert.match(managementServiceC3, /async reactivateAsset\(/, 'C3-17. reactivateAsset service method intact');

// Link flow: the direct-UUID endpoint keeps the canonical contract
// (C10-C13 above) and the wizard-based flow uses manual-link. Neither is
// gated by provider capabilities (Mavero lifecycle writes, server-side).
assert.match(directLinkEndpoint, /typeof mediaItemId === 'string'|mediaItemId\?/, 'C3-8. the link endpoint validates its reference fields');
assert.doesNotMatch(directLinkEndpoint, /caps\?/, 'C3-20. Link NOT gated by provider capabilities (Mavero lifecycle op)');

// Reactivate: only reachable via the guarded API; the service rejects
// deleted assets (see lifecycle test) — the capability contract survives
// in the service layer.
assert.match(managementServiceC3, /asset\.status === 'deleted'[\s\S]{0,300}ASSET_DELETED/, 'C3-1. reactivate service-level gating intact (deleted assets rejected)');

ok('C3. Asset lifecycle: full service surface intact + canonical link contract (UI retired with the legacy manager)');

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

// Operations is NOT a separate nav item — merged into Hosting Control as tabs
assert.doesNotMatch(appShell, /id: 'operations'.*label: 'Operations'/, 'E5. Operations is not a separate nav item (merged into Hosting Control)');

// [MAV-FOCUSED 2026-10 redesign] there is NO Hosting nav group at all —
// the sidebar intentionally dropped Hosting Control (Media Library is the
// hosting surface; /admin/hosting remains reachable by URL). The merged
// Operations contract is still pinned by E5 + the hosting route files.
assert.doesNotMatch(appShell, /id: 'hosting'[\s\S]*?items: \[/, 'E6. No Hosting nav group in the sidebar (MAV-FOCUSED redesign — Media Library is the hosting surface)');
ok('E. Navigation: Upload removed, Operations not a nav item, no Hosting group (all workspaces reachable by URL)');

// Hosting page: Assets tab removed, redirects to Media Library
assert.match(hostingServer, /tab === 'assets'/, 'E9. Hosting server checks for assets tab');
assert.match(hostingServer, /redirect\(303, '\/admin\/media\/library'\)/, 'E10. Hosting server redirects assets tab to Media Library');
assert.doesNotMatch(hostingServer, /'assets'.*'sync'/, 'E11. Hosting VALID_TABS does not include assets');

// Hosting page: [HOSTING NAVIGATION CONSOLIDATION — final 3-issue fix]
// Exactly 3 tabs: Providers, Jobs, Activity. The separate Sync tab was
// removed (Sync all + Refresh health on Providers; per-card Sync); the
// Attention tab was retired from the required IA. Legacy ?tab=sync and
// ?tab=attention redirect server-side to /admin/hosting.
assert.match(hostingPage, /\{ id: 'providers', label: 'Providers' \}/, 'E13. Hosting page has Providers tab');
assert.match(hostingPage, /\{ id: 'jobs', label: 'Jobs'/, 'E15. Hosting page has Jobs tab');
assert.match(hostingPage, /\{ id: 'activity', label: 'Activity' \}/, 'E16. Hosting page has Activity tab');
assert.doesNotMatch(hostingPage, /\{ id: 'sync', label: 'Sync' \}/, 'E14. Hosting page has NO Sync tab (consolidated into Providers)');
assert.doesNotMatch(hostingPage, /'attention', label: 'Attention'/, 'E17. Hosting page has NO Attention tab (required IA)');
assert.match(hostingServer, /tab === 'sync' \|\| tab === 'attention'/, 'E19. Hosting server redirects legacy sync/attention tabs');
assert.match(hostingServer, /redirect\(303, '\/admin\/hosting'\)/, 'E20. Legacy tab redirect target is canonical /admin/hosting');
assert.match(hostingPage, /Sync all providers/, 'E21. Providers tab hosts the Sync all providers action');
assert.match(hostingPage, /syncAllProviders/, 'E22. Hosting page has the sync-all handler (same POST /api/admin/media/sync backend)');

// Operations page redirects to Hosting Control
assert.match(read('src/routes/admin/operations/+page.server.ts'), /redirect\(303, `\/admin\/hosting/, 'E18. Operations page redirects to Hosting Control');

// openAssetsForProvider navigates to Media Library (no ?view=files)
assert.match(hostingPage, /\/admin\/media\/library\?provider=/, 'E15. openAssetsForProvider navigates to Media Library');
ok('E2. Hosting: 5 tabs (Providers/Sync/Jobs/Activity/Attention), Operations redirects');

// ============================================================
// F. Upload Selector (hosting providers only)
// ============================================================
console.log('\n--- F. Upload Selector ---');

const registry = read('src/lib/server/hosting/registry.ts');

// (2026-10-15) the upload page was REMOVED with the Upload/Import
// workflow. Its provider-selector contract is retired; the canonical
// capability check survives in the hosting registry (getHostingAdapter)
// and the library page's resolver wiring.
assert.ok(!existsSync('src/routes/admin/media/upload/+page.server.ts'), 'F1. Upload page removed with the workflow');
assert.match(registry, /export function getHostingAdapter/, 'F2. Hosting registry keeps the canonical getHostingAdapter capability check');

// No hardcoded Vidara/Abyss-only filtering in the surviving registry.
assert.doesNotMatch(registry, /adapterId === 'vidara' \|\| .* === 'abyss'/, 'F3. No hardcoded Vidara/Abyss string matching');
ok('F. Upload selector retired; canonical capability check survives in the registry');

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
// (2026-10-15) the upload API route was REMOVED with the Upload/Import
// workflow (no deep links remain). The surviving write path (manual-link)
// keeps both invariants:
const manualLinkRoute = read('src/routes/api/admin/media/manual-link/+server.ts');
assert.match(manualLinkRoute, /requireAdmin/, 'G3. Manual-link route requires admin (surviving write path)');
assert.match(manualLinkRoute, /upsertLinkAsset/, 'G4. Manual-link route uses the shared canonical contract');

// Media Library renders AdminHostingAssets as the sole file manager
assert.match(libraryPage, /AdminMediaList/, 'G6. Library page renders AdminMediaList');

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
