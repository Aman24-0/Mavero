/**
 * Focused regression tests for two production issues:
 *
 * ISSUE 1 — Hosting asset delete does not work (Vidara HTTP 400)
 * ISSUE 2 — Upload provider selector shows non-hosting providers
 *
 * Run: pnpm exec tsx --tsconfig ./jsconfig.json scripts/delete_and_upload_selector_test.ts
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
const hostingAssets = read('src/lib/components/admin2/AdminHostingAssets.svelte');

// 1a. Vidara delete uses query param, NOT JSON body
// The fix: file_code is passed as a query parameter via this.url(..., { file_code: ... })
// NOT as body: { file_code: ... }
const vidaraDeleteMatch = vidaraAdapter.match(/async deleteAsset[\s\S]*?\n  \}/);
assert.ok(vidaraDeleteMatch, '1a. Vidara deleteAsset method found');
assert.match(vidaraDeleteMatch[0], /this\.url\('\/v1\/video\/delete', \{ file_code: providerAssetId \}\)/, '1b. Vidara delete passes file_code as query param (not JSON body)');
assert.doesNotMatch(vidaraDeleteMatch[0], /body:\s*\{\s*file_code:\s*providerAssetId\s*\}/, '1c. Vidara delete does NOT send JSON body with file_code');
assert.match(vidaraDeleteMatch[0], /VERIFIED CONTRACT FIX/, '1d. Vidara delete has contract fix comment');
ok('1. Vidara deleteAsset: file_code sent as query param (fixes HTTP 400)');

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

// 1e. UI: loading state tracked per-action
assert.match(hostingAssets, /let actionInProgress = \$state<string \| null>\(null\)/, '5a. UI: actionInProgress is string|null (tracks which action)');
assert.match(hostingAssets, /actionInProgress = action/, '5b. UI: sets action name on start');
assert.match(hostingAssets, /actionInProgress = null/, '5c. UI: clears on completion');
assert.match(hostingAssets, /actionInProgress !== null/, '5d. UI: buttons disabled when any action in progress');
assert.match(hostingAssets, /actionInProgress === 'delete'/, '5e. UI: delete button shows specific loading state');
ok('5. UI: per-action loading state (tracks which action, disables all buttons)');

// 1f. UI: error display with actionable hint
assert.match(hostingAssets, /a2-asset-action-error-box/, '6a. UI: error-box rendered for failures');
assert.match(hostingAssets, /Action failed/, '6b. UI: error box shows "Action failed" heading');
assert.match(hostingAssets, /asset was NOT deleted.*available for retry/, '6c. UI: error hint says asset NOT deleted, available for retry');
assert.match(hostingAssets, /Network error/, '6d. UI: network errors handled separately');
ok('6. UI: error display with actionable hint (asset NOT deleted, available for retry)');

// 1g. UI: does NOT close drawer on failure — reloads list instead
assert.match(hostingAssets, /Provider failure — surface the real error/, '7a. UI: comment confirms failure surfacing');
assert.match(hostingAssets, /Do NOT close the drawer/, '7b. UI: comment confirms drawer stays open on failure');
assert.match(hostingAssets, /Reload the list anyway so the failed operation/, '7c. UI: reloads list on failure (operation history visible)');
ok('7. UI: drawer stays open on failure, list reloaded for operation history');

// 1h. UI: loading banner shown while action in progress
assert.match(hostingAssets, /a2-asset-action-loading/, '8a. UI: loading banner class exists');
assert.match(hostingAssets, /in progress/, '8b. UI: loading banner shows "in progress" text');
assert.match(hostingAssets, /aria-live="polite"/, '8c. UI: loading banner has aria-live for a11y');
ok('8. UI: loading banner shown while action in progress');

// ============================================================
// ISSUE 2 — Upload Provider Selector Filtering
// ============================================================
console.log('\n--- Issue 2: Upload Provider Selector ---');

const uploadPageServer = read('src/routes/admin/media/upload/+page.server.ts');
const registry = read('src/lib/server/hosting/registry.ts');

// 2a. Upload page server filters by getHostingAdapter() != null
assert.match(uploadPageServer, /getHostingAdapter\(s\.adapterId\)/, '9a. Upload page uses getHostingAdapter() to check hosting capability');
assert.match(uploadPageServer, /\.filter\(\(s\) => \{[\s\S]*?getHostingAdapter[\s\S]*?return adapter !== null/, '9b. Upload page filters sources where getHostingAdapter() returns non-null');
assert.match(uploadPageServer, /ISSUE 2 fix/, '9c. Upload page has ISSUE 2 fix comment');
ok('9. Upload page server: filters by canonical getHostingAdapter() check');

// 2b. No hardcoded Vidara/Abyss-only filtering
assert.doesNotMatch(uploadPageServer, /adapterId === 'vidara' \|\| .* === 'abyss'/, '10a. No hardcoded Vidara/Abyss string matching');
assert.doesNotMatch(uploadPageServer, /in\('adapter_id', \['vidara', 'abyss'\]\)/, '10b. No hardcoded adapter_id IN list');
ok('10. No hardcoded Vidara/Abyss filtering — future hosting adapters auto-included');

// 2c. Registry is the canonical source of truth
assert.match(registry, /ADAPTER_ID_TO_KEY/, '11a. Registry has ADAPTER_ID_TO_KEY map');
assert.match(registry, /export function getHostingAdapter/, '11b. Registry exports getHostingAdapter');
assert.match(registry, /returns null/, '11c. Registry returns null for non-hosting adapters');
ok('11. Registry is canonical source of truth for hosting adapter distinction');

// 2d. The filter is future-proof: adding a new adapter to the registry
// automatically makes it appear in the upload selector
assert.match(uploadPageServer, /new hosting adapter is registered[\s\S]*?automatically appears/, '12a. Upload page comment confirms future-proof behavior');
assert.match(uploadPageServer, /no hardcoded adapter_id list, no name matching/, '12b. Upload page comment confirms no hardcoded filtering');
ok('12. Filter is future-proof (new registry entries auto-appear in selector)');

// 2e. The filter excludes providers with unconfigured credentials
// (getHostingAdapter returns null if config is missing)
assert.match(uploadPageServer, /adapter's credentials are not configured/, '13a. Upload page comment confirms credentials check');
ok('13. Filter excludes providers with unconfigured credentials (correct — can\'t upload without creds)');

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
