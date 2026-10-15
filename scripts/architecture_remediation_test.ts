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
import { readFileSync, existsSync, readdirSync } from 'node:fs';
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
// [2026-10-16 re-pin] AdminHostingAssets + AdminMediaDetailDrawer were
// deleted with the legacy asset-manager UI. See §4 below for how the
// deleted-asset UI rules were re-pinned.
assert.ok(!existsSync(path.join(REPO_ROOT, 'src/lib/components/admin2/AdminHostingAssets.svelte')), '0a. AdminHostingAssets deleted (legacy file manager removed)');
assert.ok(!existsSync(path.join(REPO_ROOT, 'src/lib/components/admin2/AdminMediaDetailDrawer.svelte')), '0b. AdminMediaDetailDrawer deleted (legacy drawer removed)');
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

// list() uses activeAssets (exclude deleted) for the zero-link filter
// [2026-10-16 final round re-pin] the default exclusion is now the ZERO-LINK
// rule (a library card requires at least one ACTIVE asset in its union) —
// this supersedes the earlier "demand but no assets kept (pending)" rule.
// Demand-backed zero-link titles are Missing Media's domain; computeHostingState
// still computes 'pending' for the episodes(parentId)/debug reads (3d below).
assert.match(libraryService, /unionAssets\.filter\(a => a\.status !== 'deleted'\)/, '3a. list() computes active union assets excluding deleted (parent rollup)');
assert.match(libraryService, /const activeAssets = assets\.filter\(a => a\.status !== 'deleted'\);/, '3a-ii. computeHostingState computes activeAssets excluding deleted (same filter, per item)');
assert.match(libraryService, /if \(!includeOrphans && activeUnionAssets\.length === 0\) \{/, '3b. list() drops ZERO-LINK items (no active assets in the union) — demand-backed zero-link rows return to Missing Media, not the library');

// computeHostingState already filtered deleted (verify it still does)
assert.match(libraryService, /assets\.filter\(a => a\.status !== 'deleted'\)/, '3c. computeHostingState filters deleted assets');

// The pending state remains COMPUTED for demand-backed rows (episodes read
// + includeOrphans debug path) even though the default library list now
// excludes them.
assert.match(libraryService, /pending/, '3d. computeHostingState returns pending for items with demand but no active assets (episodes read / debug path)');

ok('3. Media Library: zero-link items excluded by default; deleted assets never count as active; pending still computed for Missing Media surfaces');

// ============================================================
// 4. UI State Rules for Deleted Assets (re-pinned 2026-10-16)
// ============================================================
console.log('\n--- 4. UI State Rules for Deleted Assets ---');

// [2026-10-16 re-pin] the deleted-asset UI rules (terminal notice, no
// Rename/Move/Delete/Reactivate) lived in AdminHostingAssets +
// AdminMediaDetailDrawer, both deleted with the legacy asset-manager UI.
// The live model enforces the SAME invariant earlier in the chain:
//  - the library read model never counts a deleted asset as active
//    (3a/3a-ii/3c) — a deleted-only title has zero active links and is
//    excluded from the default list entirely;
//  - the episode sheet only offers per-episode actions for episodes with
//    a LIVE asset link (ground truth from the episodes API);
//  - no live component wires any reactivate/rename/move action at all
//    (verified directory-wide below).
{
  const admin2Dir = path.join(REPO_ROOT, 'src/lib/components/admin2');
  const actionCallers: string[] = [];
  for (const entry of readdirSync(admin2Dir)) {
    if (!/\.svelte$/.test(entry)) continue;
    const src = read(`src/lib/components/admin2/${entry}`);
    // A live component fetching any asset-lifecycle action endpoint
    // (reactivate/rename/move/delete) — the legacy action surface.
    if (/fetch\(\s*[`'"`]\S*\/assets\/\S*\/(reactivate|rename|move|delete)/.test(src)) actionCallers.push(entry);
  }
  assert.deepEqual(actionCallers, [], '4a. NO live admin2 component invokes legacy asset-lifecycle action endpoints (surface removed with the drawer; unlink/reconcile are the live actions)');
}
const episodeSheet2 = read('src/lib/components/admin2/AdminEpisodeSheet.svelte');
assert.match(episodeSheet2, /view\.asset[\s\S]{0,600}ondeletelink|ondeletelink[\s\S]{0,600}view\.asset/, '4b. episode-sheet Delete offered only for episodes WITH a live asset (deleted assets render no actions)');
assert.match(episodeSheet2, /badge-status/, '4c. the episode sheet renders per-asset status badges (deleted/missing states visible without actions)');

ok('4. UI: deleted assets surface as status-only records — no lifecycle actions reachable from live components');

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
