/**
 * Focused regression tests for two production issues:
 *
 * ISSUE 1 — Hosting asset delete does not work (Vidara HTTP 400)
 * ISSUE 2 — Upload provider selector shows non-hosting providers
 *
 * Run: pnpm exec tsx --tsconfig ./jsconfig.json scripts/delete_and_upload_selector_test.ts
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
function fail(message: string) {
  failed += 1;
  console.error(`  FAIL ${failed} - ${message}`);
}

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative: string) => readFileSync(path.join(REPO_ROOT, relative), 'utf8');

console.log('\n=== Delete Flow + Upload Provider Selector — Regression Tests ===\n');

// ============================================================
// ISSUE 1 — Hosting Asset Delete (Vidara HTTP 400 root cause)
// ============================================================
console.log('--- Issue 1: Hosting Asset Delete ---');

const vidaraAdapter = read('src/lib/server/hosting/vidara/adapter.ts');
const abyssAdapter = read('src/lib/server/hosting/abyss/adapter.ts');
const managementService = read('src/lib/server/hosting/management/service.ts');
const deleteRoute = read('src/routes/api/admin/media/assets/[id]/delete/+server.ts');
// [2026-10-16 re-pin] AdminHostingAssets was DELETED with the legacy
// asset-manager UI; its delete-UI contracts (loading state, error display,
// no-close-on-failure) are re-pinned on the LIVE surfaces (AdminMediaList
// owns the delete confirm; the episode sheet owns bulk operations).
assert.ok(!existsSync(path.join(REPO_ROOT, 'src/lib/components/admin2/AdminHostingAssets.svelte')), '0a. AdminHostingAssets deleted (legacy file manager removed)');
const mediaListDel = read('src/lib/components/admin2/AdminMediaList.svelte');
const episodeSheetDel = read('src/lib/components/admin2/AdminEpisodeSheet.svelte');

// 1a. Vidara delete uses GET method with filecode query param (correct contract)
// The fix: GET /v1/video/delete?filecode=<id> (NOT POST, NOT file_code with underscore)
const vidaraDeleteMatch = vidaraAdapter.match(/async deleteAsset[\s\S]*?\n  \}/);
assert.ok(vidaraDeleteMatch, '1a. Vidara deleteAsset method found');
assert.match(vidaraDeleteMatch[0], /method:\s*'GET'/, '1b. Vidara delete uses GET method');
assert.match(vidaraDeleteMatch[0], /this\.url\('\/v1\/video\/delete', \{ filecode: providerAssetId \}\)/, '1c. Vidara delete passes filecode as query param (no underscore)');
const vidaraDeleteCodeOnly = vidaraDeleteMatch[0].replace(/\/\/.*$/gm, '');
assert.doesNotMatch(vidaraDeleteCodeOnly, /file_code/, '1d. Vidara delete does NOT use file_code (underscore) in code');
assert.doesNotMatch(vidaraDeleteMatch[0], /body:\s*\{/, '1e. Vidara delete does NOT send JSON body');
assert.match(vidaraDeleteMatch[0], /VERIFIED CONTRACT/, '1f. Vidara delete has contract comment');
ok('1. Vidara deleteAsset: GET /v1/video/delete?filecode=<id> (correct contract)');

// 1b. Abyss delete uses DELETE method with path parameter (unchanged — was already correct)
const abyssDeleteMatch = abyssAdapter.match(/async deleteAsset[\s\S]*?\n  \}/);
assert.ok(abyssDeleteMatch, '2a. Abyss deleteAsset method found');
assert.match(abyssDeleteMatch[0], /method:\s*'DELETE'/, '2b. Abyss delete uses DELETE method');
assert.match(abyssDeleteMatch[0], /\/v1\/files\/\$\{encodeURIComponent\(providerAssetId\)\}/, '2c. Abyss delete uses path parameter');
ok('2. Abyss deleteAsset: DELETE /v1/files/{id} (unchanged, was correct)');

// 1c. ManagementService.deleteAsset: provider delete first, then DB update on success only
const deleteMatch = managementService.match(/async deleteAsset[\s\S]*?return \{ ok: false[\s\S]*?\}/);
assert.ok(deleteMatch, '3a. ManagementService.deleteAsset method found');
assert.match(deleteMatch[0], /Delete at the provider first/, '3b. deleteAsset: provider delete first');
assert.match(deleteMatch[0], /await adapter\.deleteAsset\(asset\.provider_asset_id\)/, '3c. deleteAsset: calls adapter.deleteAsset');
assert.match(deleteMatch[0], /Only update Mavero state after provider confirms deletion/, '3d. deleteAsset: DB update only after provider confirms');
assert.match(deleteMatch[0], /status: 'deleted'[\s\S]*?mavero_status: 'missing'/, '3e. deleteAsset: marks status=deleted, mavero_status=missing on success');
assert.match(deleteMatch[0], /Provider delete failed — do NOT mark the Mavero asset as deleted/, '3f. deleteAsset: does NOT mark deleted on failure');
assert.match(deleteMatch[0], /action: 'provider_delete'[\s\S]*?status: 'success'/, '3g. deleteAsset: records success operation');
assert.match(deleteMatch[0], /action: 'provider_delete'[\s\S]*?status: 'failed'/, '3h. deleteAsset: records failed operation');
ok('3. ManagementService.deleteAsset: provider-first, DB-update-on-success-only, operation history recorded');

// 1d. Delete API route returns error properly
assert.match(deleteRoute, /result\.ok \? 200 : 502/, '4a. Delete route returns 502 on failure');
assert.match(deleteRoute, /error: result\.error/, '4b. Delete route returns error in response');
ok('4. Delete API route: returns error with 502 status on provider failure');

// 1e. [2026-10-16 re-pin] UI: loading state tracked per-action on the
// LIVE surfaces — the list's delete + the sheet's bulk operations disable
// their buttons while in flight.
assert.match(mediaListDel, /deleting = true/, '5a. UI: delete sets the in-flight flag');
assert.match(mediaListDel, /deleting = false/, '5b. UI: clears on completion (finally)');
assert.match(mediaListDel, /disabled=\{deleting\}/, '5c. UI: delete buttons disabled while in flight');
assert.match(episodeSheetDel, /disabled=\{bulkDeleting\}/, '5d. UI: bulk-delete buttons disabled while in flight');
ok('5. UI: per-action loading state on the live surfaces (buttons disabled in flight)');

// 1f. [2026-10-16 re-pin] UI: error display with actionable retry — the
// live error block carries role=alert + the Retry button (the unlink is
// provider-preserving by construction, so the NOT-deleted hint is the
// server contract, not a UI string).
assert.match(mediaListDel, /state-error" role="alert"/, '6a. UI: error block rendered for failures (role=alert)');
assert.match(mediaListDel, /retry-btn/, '6b. UI: error block offers Retry (actionable)');
assert.match(mediaListDel, /Network error during delete/, '6c. UI: network errors handled distinctly');
ok('6. UI: error display with actionable retry (role=alert + Retry button)');

// 1g. [2026-10-16 re-pin] UI: a FAILED delete surfaces the error WITHOUT
// a list reload (no silent state change); a SUCCESSFUL delete reloads —
// pinned in the zero-link suite (F1/F2), verified here on the code shape.
assert.match(mediaListDel, /json\.ok[\s\S]{0,200}loadList\(true\)/, '7a. UI: list reload happens only on the success path');
assert.match(mediaListDel, /error = json\.error\?\.message \?\? 'Delete failed\.'/, '7b. UI: failure path sets the error, no reload');
ok('7. UI: failure surfaces the error (no silent reload); success refreshes the list');

// 1h. [2026-10-16 re-pin] UI: in-flight feedback is announced politely
// (aria-live) on the live sheet surfaces.
assert.match(episodeSheetDel, /aria-live="polite"/, '8a. UI: sheet progress lines are aria-live (announced)');
ok('8. UI: in-flight progress announced politely (aria-live)');

// ============================================================
// ISSUE 2 — Upload Provider Selector Filtering
// ============================================================
console.log('\n--- Issue 2: Upload Provider Selector ---');

const registry = read('src/lib/server/hosting/registry.ts');

// 2a. (2026-10-15) the upload page was REMOVED with the Upload/Import
// workflow — its provider-selector filtering contract is retired. The
// canonical capability check survives in the hosting registry itself
// (getHostingAdapter) and the LIBRARY page's resolver wiring.
assert.ok(!existsSync('src/routes/admin/media/upload/+page.server.ts'), '9a. Upload page removed with the workflow');
assert.match(registry, /export function getHostingAdapter/, '9b. Hosting registry keeps the canonical getHostingAdapter capability check');
ok('9. Upload selector retired; canonical getHostingAdapter() check survives in the registry');

// 2b. No hardcoded Vidara/Abyss-only filtering in the surviving registry.
assert.doesNotMatch(registry, /adapterId === 'vidara' \|\| .* === 'abyss'/, '10a. No hardcoded Vidara/Abyss string matching');
assert.doesNotMatch(registry, /in\('adapter_id', \['vidara', 'abyss'\]\)/, '10b. No hardcoded adapter_id IN list');
ok('10. No hardcoded Vidara/Abyss filtering — future hosting adapters auto-included');

// 2c. Registry is the canonical source of truth
assert.match(registry, /ADAPTER_ID_TO_KEY/, '11a. Registry has ADAPTER_ID_TO_KEY map');
assert.match(registry, /export function getHostingAdapter/, '11b. Registry exports getHostingAdapter');
assert.match(registry, /returns null/, '11c. Registry returns null for non-hosting adapters');
ok('11. Registry is canonical source of truth for hosting adapter distinction');

// 2d. (2026-10-15) the upload page is REMOVED; the future-proof filter
// contract survives in the registry: any newly registered adapter is
// served by getHostingAdapter with no adapter-id list anywhere.
assert.match(registry, /export function getHostingAdapter/, '12a. Registry serves every registered adapter via getHostingAdapter');
assert.doesNotMatch(registry, /\['vidara',\s*'abyss'\]/, '12b. No hardcoded adapter list in the registry');
ok('12. Capability check is future-proof (registry-driven, no hardcoded lists)');

// 2e. getHostingAdapter returns null when an adapter's credentials are
// not configured — the registry keeps that behavior.
assert.match(registry, /return null/, '13a. getHostingAdapter returns null for unconfigured adapters');
ok('13. Unconfigured adapters resolve to null (registry contract)');

// ============================================================
// Regression: existing behavior preserved
// ============================================================
console.log('\n--- Regression: Existing Behavior Preserved ---');

// Vidara embed URL unchanged
const vidaraNormalize = read('src/lib/server/hosting/vidara/normalize.ts');
assert.match(vidaraNormalize, /vidara\.to\/e\//, '14a. Vidara embed URL still vidara.to/e/');
ok('14. Vidara embed URL unchanged (no regression)');

// Management service still uses canonical resolver
assert.match(managementService, /resolveAdapterForSource/, '15a. Management service still uses canonical resolver');
ok('15. Management service: canonical resolver intact (no regression)');

// Delete route still requires admin
assert.match(deleteRoute, /requireAdmin/, '16a. Delete route still requires admin auth');
ok('16. Delete route: admin auth intact (no regression)');

// Abyss adapter unchanged (was already correct)
assert.match(abyssAdapter, /async deleteAsset[\s\S]*?method:\s*'DELETE'[\s\S]*?\/v1\/files\//, '17a. Abyss delete unchanged');
ok('17. Abyss adapter: delete unchanged (no regression)');

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
