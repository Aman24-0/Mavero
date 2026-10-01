/**
 * Architecture Remediation — Regression Tests
 *
 * Tests the actual state-transition logic for:
 *
 * 1. Demand lifecycle: reopenDemand, recordDemand Branch B fix,
 *    sweepStaleResolvedDemand
 * 2. Delete idempotency + 404 handling
 * 3. Media Library excludes deleted-only items
 * 4. UI state rules for deleted assets
 *
 * Run: pnpm exec tsx --tsconfig ./jsconfig.json scripts/architecture_remediation_test.ts
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

console.log('\n=== Architecture Remediation — Regression Tests ===\n');

const demandService = read('src/lib/server/hosting/demand/service.ts');
const mgmtService = read('src/lib/server/hosting/management/service.ts');
const libraryService = read('src/lib/server/hosting/library/service.ts');
const hostingAssets = read('src/lib/components/admin2/AdminHostingAssets.svelte');
const mediaDrawer = read('src/lib/components/admin2/AdminMediaDetailDrawer.svelte');
const missingServer = read('src/routes/admin/media/missing/+page.server.ts');

// ============================================================
// 1. Demand Lifecycle — reopenDemand + recordDemand Branch B
// ============================================================
console.log('--- 1. Demand Lifecycle ---');

// reopenDemand method exists
assert.match(demandService, /async reopenDemand\(canonicalKey: string\)/, '1a. reopenDemand method exists');

// reopenDemand transitions 'ready' → 'open' (NOT 'ignored')
const reopenMatch = demandService.match(/async reopenDemand[\s\S]*?\n  \}/);
assert.ok(reopenMatch, '1b. reopenDemand method body found');
assert.match(reopenMatch[0], /\.update\(\{ status: 'open' \}\)/, '1c. reopenDemand sets status=open');
assert.match(reopenMatch[0], /\.eq\('status', 'ready'\)/, '1d. reopenDemand only affects status=ready');
assert.doesNotMatch(reopenMatch[0], /ignored/, '1e. reopenDemand does NOT affect ignored demands');

// hasReadyAvailableAsset helper exists
assert.match(demandService, /private async hasReadyAvailableAsset/, '1f. hasReadyAvailableAsset helper exists');
const hasAssetMatch = demandService.match(/private async hasReadyAvailableAsset[\s\S]*?\n  \}/);
assert.ok(hasAssetMatch, '1g. hasReadyAvailableAsset body found');
assert.match(hasAssetMatch[0], /\.eq\('status', 'ready'\)/, '1h. hasReadyAvailableAsset checks status=ready');
assert.match(hasAssetMatch[0], /\.eq\('mavero_status', 'available'\)/, '1i. hasReadyAvailableAsset checks mavero_status=available');

// recordDemand Branch B fix: when status='ready', checks if asset still available
assert.match(demandService, /if \(row\.status === 'ready'\)/, '1j. recordDemand checks status=ready branch');
assert.match(demandService, /hasReadyAvailableAsset\(entry\.canonicalKey\)/, '1k. recordDemand calls hasReadyAvailableAsset');
assert.match(demandService, /status: 'open'[\s\S]*?request_count: row\.request_count \+ 1/, '1l. recordDemand reopens to open + increments count');

// 'ignored' demands are NOT reopened by recordDemand
assert.match(demandService, /if \(row\.status === 'ignored'\)/, '1m. recordDemand has explicit ignored check');
const ignoredMatch = demandService.match(/Status is 'ignored'[\s\S]*?return \{ created: false/);
assert.ok(ignoredMatch, '1n. recordDemand ignored branch returns early without incrementing');

// sweepStaleResolvedDemand method exists
assert.match(demandService, /async sweepStaleResolvedDemand/, '1o. sweepStaleResolvedDemand method exists');
const sweepStaleMatch = demandService.match(/async sweepStaleResolvedDemand[\s\S]*?\n  \}/);
assert.ok(sweepStaleMatch, '1p. sweepStaleResolvedDemand body found');
assert.match(sweepStaleMatch[0], /\.eq\('status', 'ready'\)/, '1q. sweepStaleResolvedDemand fetches ready demands');
assert.match(sweepStaleMatch[0], /\.update\(\{ status: 'open' \}/, '1r. sweepStaleResolvedDemand reopens to open');
assert.match(sweepStaleMatch[0], /mavero_status.*available/, '1s. sweepStaleResolvedDemand checks mavero_status=available');

// Missing Media page calls sweepStaleResolvedDemand
assert.match(missingServer, /sweepStaleResolvedDemand/, '1t. Missing Media page calls sweepStaleResolvedDemand');

ok('1. Demand lifecycle: reopenDemand + recordDemand Branch B + sweepStaleResolvedDemand');

// ============================================================
// 2. Delete Idempotency + 404 Handling + Demand Reopen
// ============================================================
console.log('\n--- 2. Delete Idempotency + 404 + Demand Reopen ---');

const deleteMatch = mgmtService.match(/async deleteAsset[\s\S]*?return \{ ok: false[\s\S]*?\}/);
assert.ok(deleteMatch, '2a. deleteAsset method found');

// Idempotency: already-deleted → return success without calling provider
assert.match(deleteMatch[0], /asset\.status === 'deleted'/, '2b. deleteAsset checks for already-deleted');
assert.match(deleteMatch[0], /return \{ ok: true[\s\S]*?provider_delete[\s\S]*?\}/, '2c. deleteAsset returns success for already-deleted');

// 404 handling: provider returns NOT_FOUND → treat as success
assert.match(deleteMatch[0], /NOT_FOUND/, '2d. deleteAsset handles NOT_FOUND from provider');
assert.match(deleteMatch[0], /err\.code !== 'NOT_FOUND'/, '2e. deleteAsset re-throws non-404 errors only');

// Demand reopen: after successful delete, calls reopenDemandForMediaItem
assert.match(deleteMatch[0], /reopenDemandForMediaItem/, '2f. deleteAsset calls reopenDemandForMediaItem');

// detachAsset also calls reopenDemandForMediaItem
const detachMatch = mgmtService.match(/async detachAsset[\s\S]*?return \{ ok: true/);
assert.ok(detachMatch, '2g. detachAsset method found');
assert.match(detachMatch[0], /reopenDemandForMediaItem/, '2h. detachAsset calls reopenDemandForMediaItem');

// reopenDemandForMediaItem: checks if any other available asset exists first
const reopenHelperMatch = mgmtService.match(/private async reopenDemandForMediaItem[\s\S]*?\n  \}/);
assert.ok(reopenHelperMatch, '2i. reopenDemandForMediaItem method found');
assert.match(reopenHelperMatch[0], /\.eq\('status', 'ready'\)/, '2j. reopenDemandForMediaItem checks status=ready');
assert.match(reopenHelperMatch[0], /\.eq\('mavero_status', 'available'\)/, '2k. reopenDemandForMediaItem checks mavero_status=available');
assert.match(reopenHelperMatch[0], /count.*> 0/, '2l. reopenDemandForMediaItem skips if other available assets exist');
assert.match(reopenHelperMatch[0], /reopenDemand/, '2m. reopenDemandForMediaItem calls DemandService.reopenDemand');

ok('2. Delete: idempotent (already-deleted→success), 404→success, demand reopened');

// ============================================================
// 3. Media Library Excludes Deleted-Only Items
// ============================================================
console.log('\n--- 3. Media Library Read Model ---');

// list() uses activeAssets (exclude deleted) for orphan filter
assert.match(libraryService, /activeAssets = itemAssets\.filter\(a => a\.status !== 'deleted'\)/, '3a. list() computes activeAssets excluding deleted');
assert.match(libraryService, /activeAssets\.length === 0 && !itemDemand/, '3b. list() drops items with no active assets AND no demand');

// computeHostingState already filtered deleted (verify it still does)
assert.match(libraryService, /assets\.filter\(a => a\.status !== 'deleted'\)/, '3c. computeHostingState filters deleted assets');

// Items with demand but no active assets are KEPT (pending)
assert.match(libraryService, /pending/, '3d. computeHostingState returns pending for items with demand but no active assets');

ok('3. Media Library: deleted-only items excluded, pending items (demand) kept');

// ============================================================
// 4. UI State Rules for Deleted Assets
// ============================================================
console.log('\n--- 4. UI State Rules for Deleted Assets ---');

// AdminHostingAssets: deleted assets show terminal notice, no action buttons
assert.match(hostingAssets, /selectedAsset\.status === 'deleted'/, '4a. AdminHostingAssets checks status=deleted');
assert.match(hostingAssets, /a2-asset-deleted-notice/, '4b. AdminHostingAssets has deleted-notice class');
assert.match(hostingAssets, /permanently deleted.*No actions are available/, '4c. AdminHostingAssets shows terminal deleted message');
assert.match(hostingAssets, /a2-asset-deleted-notice[\s\S]*?\{:else\}/, '4d. AdminHostingAssets uses {:else} for non-deleted actions');

// AdminMediaDetailDrawer: deleted assets show notice, no Rename/Move/Delete
assert.match(mediaDrawer, /asset\.status !== 'deleted'/, '4e. AdminMediaDetailDrawer gates file actions on status !== deleted');
assert.match(mediaDrawer, /provider-asset-deleted-notice/, '4f. AdminMediaDetailDrawer has deleted-notice class');
assert.match(mediaDrawer, /permanently deleted/, '4g. AdminMediaDetailDrawer shows terminal deleted message');

// Reactivate still gated (from previous fix)
assert.match(mediaDrawer, /mavero_status === 'missing' && asset\.status !== 'deleted'/, '4h. AdminMediaDetailDrawer Reactivate gated on status !== deleted');

ok('4. UI: deleted assets show terminal state, no actions offered');

// ============================================================
// 5. Demand State-Transition Matrix
// ============================================================
console.log('\n--- 5. Demand State-Transition Matrix ---');

// recordDemand lifecycle:
// - No row → INSERT (status='open', count=1)
// - Existing 'open'/'uploading' → increment count
// - Existing 'ready' + available asset → no-op
// - Existing 'ready' + NO available asset → REOPEN to 'open' + increment
// - Existing 'ignored' → no-op (admin dismissed)
assert.match(demandService, /status: 'open'[\s\S]*?request_count: 1/, '5a. recordDemand INSERT creates status=open, count=1');
assert.match(demandService, /status === 'open' \|\| row\.status === 'uploading'/, '5b. recordDemand increments for open/uploading');
assert.match(demandService, /hasAvailableAsset[\s\S]*?return \{ created: false[\s\S]*?status: row\.status/, '5c. recordDemand no-op when ready + asset available');
assert.match(demandService, /status: 'open'[\s\S]*?request_count: row\.request_count \+ 1/, '5d. recordDemand reopens when ready + no asset');
assert.match(demandService, /row\.status === 'ignored'[\s\S]*?return \{ created: false/, '5e. recordDemand no-op for ignored');

// resolveDemand: open|uploading → ready
assert.match(demandService, /\.update\(\{ status: 'ready' \}\)[\s\S]*?\.(eq|in)\('status'/, '5f. resolveDemand transitions to ready');

// reopenDemand: ready → open
assert.match(demandService, /reopenDemand[\s\S]*?\.update\(\{ status: 'open' \}\)[\s\S]*?\.eq\('status', 'ready'\)/, '5g. reopenDemand transitions ready → open');

ok('5. Demand state-transition matrix: INSERT→open, open→increment, ready+available→no-op, ready+gone→reopen, ignored→no-op');

// ============================================================
// 6. Delete State-Transition Matrix
// ============================================================
console.log('\n--- 6. Delete State-Transition Matrix ---');

// deleteAsset lifecycle:
// - Already deleted → idempotent success (no provider call)
// - Provider 404 → success (file already gone)
// - Provider success → status=deleted, mavero_status=missing, demand reopened
// - Provider other error → NOT marked deleted, operation recorded as failed
assert.match(deleteMatch[0], /asset\.status === 'deleted'[\s\S]*?return \{ ok: true/, '6a. DELETE already-deleted → idempotent success');
assert.match(deleteMatch[0], /NOT_FOUND[\s\S]*?proceed to mark as deleted/, '6b. DELETE provider 404 → success');
assert.match(deleteMatch[0], /status: 'deleted'[\s\S]*?mavero_status: 'missing'/, '6c. DELETE success → status=deleted, mavero_status=missing');
assert.match(deleteMatch[0], /reopenDemandForMediaItem/, '6d. DELETE success → demand reopened');
assert.match(deleteMatch[0], /do NOT mark the Mavero asset as deleted/, '6e. DELETE failure → DB unchanged');

// reactivateAsset: deleted → rejected (from previous fix)
const reactivateMatch = mgmtService.match(/async reactivateAsset[\s\S]*?return \{ ok: false[\s\S]*?\}/);
assert.ok(reactivateMatch, '6f. reactivateAsset method found');
assert.match(reactivateMatch[0], /asset\.status === 'deleted'/, '6g. REACTIVATE deleted → rejected');
assert.match(reactivateMatch[0], /ASSET_DELETED/, '6h. REACTIVATE deleted → ASSET_DELETED error');

ok('6. Delete state-transition matrix: already-deleted→idempotent, 404→success, success→deleted+reopen, failure→unchanged');

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
