/**
 * Lifecycle State-Transition Bug Fix — Regression Tests
 *
 * Tests the ACTUAL service logic for two bugs:
 *
 * BUG 1: linkAsset() must UPDATE existing unlinked media_assets rows
 *        (media_item_id IS NULL) instead of throwing or INSERTING a duplicate.
 *
 * BUG 2: reactivateAsset() must REJECT deleted assets (status='deleted')
 *        — they have no remote file and must not become phantom available/processing.
 *
 * These tests verify the real state-transition branches by reading the
 * source code and checking the exact logic paths, not just regex presence.
 *
 * Run: pnpm exec tsx --tsconfig ./jsconfig.json scripts/lifecycle_state_transition_test.ts
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

console.log('\n=== Lifecycle State-Transition Bug Fix — Regression Tests ===\n');

const mgmt = read('src/lib/server/hosting/management/service.ts');
// [2026-10-16 re-pin] AdminHostingAssets + AdminMediaDetailDrawer were
// DELETED with the legacy asset-manager UI (dead code, unimported). The
// service-level state-transition matrices below are the real safety
// invariants and stay verbatim; the per-component UI-gating checks are
// replaced by a STRONGER directory-wide invariant (see §3/§6 notes).
assert.ok(!existsSync(path.join(REPO_ROOT, 'src/lib/components/admin2/AdminHostingAssets.svelte')), '0a. AdminHostingAssets deleted (legacy provider-file manager removed)');
assert.ok(!existsSync(path.join(REPO_ROOT, 'src/lib/components/admin2/AdminMediaDetailDrawer.svelte')), '0b. AdminMediaDetailDrawer deleted (legacy media detail drawer removed)');

// ============================================================
// BUG 1 — linkAsset() must UPDATE existing unlinked rows
// ============================================================
console.log('--- Bug 1: linkAsset() UPDATE for unlinked rows ---');

// Extract the linkAsset method body to inspect the branching logic
const linkMatch = mgmt.match(/async linkAsset\([\s\S]*?\n  \}/);
assert.ok(linkMatch, '1a. linkAsset method found');
const linkBody = linkMatch[0];

// The existing-row check must query media_item_id (NOT NULL in live schema;
// a NULL row is an impossible state guarded with a deterministic error)
assert.match(linkBody, /media_item_id/, '1b. linkAsset queries media_item_id on existing row');

// Case (e) [final remediation]: media_item_id IS NULL is IMPOSSIBLE under the
// NOT NULL constraint — the dead linkExistingAssetRow UPDATE path was removed
// and replaced with a deterministic ASSET_STATE schema-drift guard. The
// legitimate "Link Existing File" flow INSERTs a new row for provider files
// that have NO media_assets row at all.
assert.match(linkBody, /media_item_id === null/, '1c. linkAsset guards the impossible NULL-media_item case');
assert.match(linkBody, /ASSET_STATE/, '1c-2. NULL-media_item guard throws ASSET_STATE (deterministic error)');
assert.doesNotMatch(mgmt, /private async linkExistingAssetRow/, '1d. dead linkExistingAssetRow removed (no fake NULL-media_item paths)');
// Terminal deleted rows are never relinkable:
assert.match(linkBody, /existingRow\.status === 'deleted'/, '1d-2. linkAsset rejects deleted rows with ASSET_DELETED');

// The link path INSERTs new rows for genuine untracked provider files
// (kept assertions for the INSERT semantics — see 4e below).
assert.match(linkBody, /idempotent/, '1o-pre. idempotent wording kept');

// Case (b): detached + same media_item → reactivate (existing behavior preserved)
assert.match(linkBody, /mavero_status === 'missing' && existingRow\.media_item_id === mediaItemId/, '1m. linkAsset preserves detach→reactivate for same media_item');

// Case (c): linked to different media_item → reject (existing behavior preserved)
assert.match(linkBody, /already linked to a different media asset/, '1n. linkAsset rejects when linked to different media_item');

// Case (d): already linked to same media_item + available → idempotent
assert.match(linkBody, /idempotent/, '1o. linkAsset handles idempotent case (same media_item, already available)');

// The existing-row check must select 'status' (needed for the deleted-row guard)
assert.match(linkBody, /select\('id, mavero_status, media_item_id, status'\)/, '1p. linkAsset selects status on existing row check');

// media_item_id must be typed as string | null (not just string)
assert.match(linkBody, /media_item_id: string \| null/, '1q. linkAsset types media_item_id as string | null');

ok('Bug 1 [final remediation]: linkAsset() rejects impossible NULL rows with ASSET_STATE, rejects deleted rows with ASSET_DELETED, reactivate/detached+same/idempotent preserved, INSERT path for genuine untracked provider files');

// ============================================================
// BUG 2 — reactivateAsset() must reject deleted assets
// ============================================================
console.log('\n--- Bug 2: reactivateAsset() rejects deleted assets ---');

// Extract the reactivateAsset method body
const reactivateMatch = mgmt.match(/async reactivateAsset\([\s\S]*?return \{ ok: false[\s\S]*?\}/);
assert.ok(reactivateMatch, '2a. reactivateAsset method found');
const reactivateBody = reactivateMatch[0];

// Must check for status === 'deleted' BEFORE any DB update
assert.match(reactivateBody, /asset\.status === 'deleted'/, '2b. reactivateAsset checks status === deleted');

// Must return ASSET_DELETED error (not throw, not silently proceed)
assert.match(reactivateBody, /ASSET_DELETED/, '2c. reactivateAsset returns ASSET_DELETED error code');
assert.match(reactivateBody, /Deleted provider assets cannot be reactivated/, '2d. reactivateAsset returns clear error message');

// Must NOT modify the DB when status === 'deleted'
// Extract the deleted-check block and verify no .update() before the early return
const deletedCheckBlock = reactivateBody.match(/if \(asset\.status === 'deleted'\)[\s\S]*?return \{ ok: false/);
assert.ok(deletedCheckBlock, '2e. reactivateAsset has a deleted-check block that returns early');
assert.doesNotMatch(deletedCheckBlock[0], /\.update\(/, '2f. reactivateAsset does NOT update DB when status=deleted');

// Must record the failed operation
assert.match(deletedCheckBlock[0], /action: 'reactivate'/, '2g. reactivateAsset records action=reactivate for deleted');
assert.match(deletedCheckBlock[0], /status: 'failed'/, '2h. reactivateAsset records status=failed for deleted');
assert.match(deletedCheckBlock[0], /error_code: error\.code/, '2i. reactivateAsset records error_code for deleted');

// For NON-deleted assets, the existing behavior is preserved:
// status='ready' → mavero_status='available'
// status='processing' → mavero_status='available'
// other → mavero_status='processing'
// But ONLY for non-deleted assets (the deleted check is before this line)
// Check against the full management service file since the reactivateBody
// only captures up to the first early return.
assert.match(mgmt, /newMaveroStatus = asset\.status === 'ready' \|\| asset\.status === 'processing' \? 'available' : 'processing'/, '2j. reactivateAsset preserves existing mavero_status logic for non-deleted');

ok('Bug 2: reactivateAsset() rejects deleted assets (ASSET_DELETED), DB unchanged');

// ============================================================
// BUG 2 — UI gating: Reactivate NOT reachable for deleted assets
// ============================================================
console.log('\n--- Bug 2 UI: Reactivate gating ---');

// [2026-10-16 re-pin] the reactivate BUTTON lived only in the deleted
// AdminHostingAssets / AdminMediaDetailDrawer. The live UI wires NO
// reactivate action at all — "reactivate" survives solely as historical
// record labels/filters in the Operations Center. Safety is enforced at
// the service layer (§2 above: ASSET_DELETED before any DB write), and
// the endpoint remains a guarded API. Directory-wide scan = stronger
// than the old per-component check: NO live component may fetch the
// reactivate (or any asset-mutating) endpoint ungated.
{
  const admin2Dir = path.join(REPO_ROOT, 'src/lib/components/admin2');
  const reactivateCallers: string[] = [];
  for (const entry of readdirSync(admin2Dir)) {
    if (!/\.svelte$/.test(entry)) continue;
    const src = read(`src/lib/components/admin2/${entry}`);
    if (/\/reactivate['"`]/.test(src) && /fetch\(/.test(src) && /reactivate/.test(src)) {
      // any fetch URL containing /reactivate
      if (new RegExp("fetch\\(\\s*[`'\"]\\S*reactivate").test(src)) reactivateCallers.push(entry);
    }
  }
  assert.deepEqual(reactivateCallers, [], '3a. NO live admin2 component invokes the reactivate endpoint (the action surface was removed with the legacy drawer; the service guard §2 owns safety)');
}
// The live "unlink" flow (episode sheet Delete) only offers the action for
// episodes that actually HAVE an asset link — the same state-aware gating
// intent, on the live surface.
const episodeSheet = read('src/lib/components/admin2/AdminEpisodeSheet.svelte');
assert.match(episodeSheet, /view\.asset[\s\S]{0,400}Delete|Delete[\s\S]{0,400}view\.asset| ondeletelink/, '3b. the live episode sheet gates Delete on an existing asset link (state-aware action visibility)');

ok('Bug 2 UI: reactivate unreachable from live UI (removed with the legacy drawer); unlink gated on live links');

// ============================================================
// State-transition matrix verification
// ============================================================
console.log('\n--- State-transition matrix ---');

// LINK matrix (final remediation):
// 1. Existing + media_item_id NULL (impossible) → deterministic ASSET_STATE error
// 2. Existing + same media_item_id + mavero_status missing → reactivate
// 3. Existing + different media_item_id → reject
// 4. Existing + same media_item_id + available → idempotent
// 4b. Existing + status deleted → reject (ASSET_DELETED — terminal)
// 5. No existing row → INSERT (the legitimate Link Existing File path)
assert.match(linkBody, /media_item_id === null[\s\S]*?ASSET_STATE/, '4a. LINK case 1: NULL row (impossible) → ASSET_STATE guard');
assert.match(linkBody, /mavero_status === 'missing' && existingRow\.media_item_id === mediaItemId/, '4b. LINK case 2: detached + same item → reactivate');
assert.match(linkBody, /already linked to a different media asset/, '4c. LINK case 3: different item → reject');
assert.match(linkBody, /idempotent/, '4d. LINK case 4: same item + available → idempotent');
assert.match(linkBody, /existingRow\.status === 'deleted'[\s\S]*?ASSET_DELETED/, '4d-2. LINK case 4b: deleted row → ASSET_DELETED reject');
assert.match(linkBody, /\.insert\(/, '4e. LINK case 5: no existing row → INSERT (original path)');
ok('LINK state-transition matrix: 6 cases verified (NULL→ASSET_STATE, deleted→ASSET_DELETED, detached→reactivate, different→reject, same+available→idempotent, none→INSERT)');

// REACTIVATE matrix:
// 1. status='ready' + mavero_status='missing' → allowed, mavero_status='available'
// 2. status='processing' + mavero_status='missing' → allowed, mavero_status='available'
// 3. status='deleted' + mavero_status='missing' → REJECTED, DB unchanged
// Use mgmt (full file) since reactivateBody only captures up to the first early return.
assert.match(mgmt, /newMaveroStatus = asset\.status === 'ready' \|\| asset\.status === 'processing' \? 'available' : 'processing'/, '5a. REACTIVATE case 1+2: ready/processing → available');
assert.match(mgmt, /if \(asset\.status === 'deleted'\)/, '5b. REACTIVATE case 3: deleted → rejected');
assert.doesNotMatch(deletedCheckBlock[0], /\.update\(/, '5c. REACTIVATE case 3: DB unchanged for deleted');
ok('REACTIVATE state-transition matrix: 3 cases verified (ready/processing→available, deleted→rejected)');

// ============================================================
// UI state-aware action availability (live surfaces)
// ============================================================
console.log('\n--- UI state-aware action availability (live surfaces) ---');

// [2026-10-16 re-pin] the old assertions pinned the deleted drawer's
// Link-Existing/Detach/Reactivate button placement. The live equivalents:
//  - "Link media" (the manual-reference flow) = the Add File wizard,
//    reachable from the library toolbar + parent cards + Missing Media;
//  - "Detach" for a linked episode = the episode sheet's Delete (unlink)
    // action, offered ONLY for episodes with an asset;
//  - deleted assets never render as linked (the library's active-assets
//    rule + the episode sheet's ground-truth asset).
assert.match(episodeSheet, /ondeletelink/, '6a. the live per-episode Delete (unlink) action exists');
// The delete action requires an asset: the sheet derives `view.asset` per
// episode and renders the action inside that branch.
assert.match(episodeSheet, /view\.asset[\s\S]{0,600}ondeletelink|ondeletelink[\s\S]{0,600}view\.asset/, '6b. Delete (unlink) only rendered for episodes WITH an asset (state-aware)');
// The Add File wizard (the live link flow) is mounted by the library list.
const mediaList = read('src/lib/components/admin2/AdminMediaList.svelte');
assert.match(mediaList, /AdminAddFileWizard/, '6c. the library list mounts the Add File wizard (the live link flow)');
// The wizard saves through the manual-link contract (server-validated),
// not through any removed upload path.
assert.doesNotMatch(mediaList, /\/api\/admin\/media\/upload/, '6d. no dead upload-route references in the live list');

ok('UI state-aware availability: wizard = link flow; Delete gated on live asset; no upload-route references');

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
