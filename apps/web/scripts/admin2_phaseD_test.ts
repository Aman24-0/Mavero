import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Admin 2.0 — Phase D contracts.
 *
 * RE-SCOPED (2026-10-15): Phase D was the Upload / Import redesign
 * (AdminUploadFlow guided wizard + the upload backend pipeline). The
 * Upload/Import workflow has since been DELIBERATELY REMOVED from Mavero
 * — every upload page, route, service, and the orchestrator entry points
 * are gone. The previous 20 sections pinned contracts of that removed
 * surface; they are obsolete by the removal contract.
 *
 * This suite now pins the REMOVAL contract with equivalent strength:
 *   1. The upload surface is fully gone (pages, routes, service, barrel).
 *   2. The ONE surviving capability — the media_operations audit writer —
 *      is rehomed with identical semantics.
 *   3. No LIVE source still imports the removed service (the historical
 *      AdminUploadFlow component survives only as unreachable dead code).
 *   4. The manual-link / bulk-link / management write paths still audit
 *      every terminal outcome (the Phase E dependency that mattered).
 */

let passed = 0;
function ok(message: string) {
  passed += 1;
  console.log(`  ok ${passed} - ${message}`);
}

// ============================================================
// 1. Upload surface fully removed
// ============================================================
const removedPaths = [
  'src/routes/admin/media/upload/+page.svelte',
  'src/routes/admin/media/upload/+page.server.ts',
  'src/routes/api/admin/media/upload/+server.ts',
  'src/lib/server/hosting/upload/service.ts',
  'src/lib/server/hosting/upload/index.ts',
];
for (const path of removedPaths) {
  assert.ok(!existsSync(path), `removed: ${path}`);
}
ok('1a. Upload pages, routes, service, and barrel are removed');

// The whole upload API subtree is gone (cancel/complete/execute-remote/
// proxy-upload/retry/status/subtitle/upload-server).
assert.ok(!existsSync('src/routes/api/admin/media/upload'), 'upload API route tree removed');
assert.ok(!existsSync('src/routes/admin/media/upload'), 'upload page route tree removed');
ok('1b. Upload route TREES removed (not just individual files)');

// ============================================================
// 2. Audit writer rehomed with identical semantics
// ============================================================
const operationAudit = readFileSync('src/lib/server/hosting/media/operation-audit.ts', 'utf8');
assert.match(operationAudit, /export async function recordMediaOperation/, 'exports recordMediaOperation');
assert.match(operationAudit, /from\('media_operations'\)\.insert/, 'inserts into media_operations');
assert.match(operationAudit, /action: params\.action/, 'carries action');
assert.match(operationAudit, /status: params\.status/, 'carries status');
assert.match(operationAudit, /details: \(params\.details \?\? \{\}\)/, 'carries details jsonb');
assert.match(operationAudit, /error_code: params\.error_code \?\? null/, 'carries error_code');
assert.match(operationAudit, /catch \{\s*\/\/ Silently absorb/, 'best-effort: insert failures silently absorbed');
ok('2a. recordMediaOperation keeps the exact audit insert contract (best-effort)');

// ============================================================
// 3. No LIVE source imports the removed upload service
// ============================================================
// (AdminUploadFlow.svelte / AdminOpsAttention.svelte / AdminOpsJobs.svelte
// reference upload endpoints only as fetch STRING literals in dead code —
// no module import, so nothing breaks. Live importers would break the
// build; assert none exist.)
function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) yield* walk(full);
    else if (/\.(ts|svelte)$/.test(entry)) yield full;
  }
}
const LIVE_ALLOWLIST = new Set([
  // Dead (unimported) components kept for history — reference the removed
  // endpoints only as string literals:
  'src/lib/components/admin2/AdminUploadFlow.svelte',
  'src/lib/components/admin2/AdminOpsAttention.svelte',
  'src/lib/components/admin2/AdminOpsJobs.svelte',
  'src/lib/components/admin2/AdminMediaDetailDrawer.svelte',
]);
const importers: string[] = [];
for (const file of walk('src')) {
  const rel = file;
  if (LIVE_ALLOWLIST.has(rel)) continue;
  const src = readFileSync(file, 'utf8');
  if (/from\s+['"][^'"]*upload\/(service|index)['"]/.test(src)) {
    importers.push(rel);
  }
}
assert.deepStrictEqual(importers, [], `no live importer of the removed upload module: ${importers.join(', ')}`);
ok('3a. No live source imports hosting/upload (removal is compile-complete)');

// ============================================================
// 4. The write paths still audit every terminal outcome
// ============================================================
const manualLinkContract = readFileSync('src/lib/server/hosting/media/manual-link-contract.ts', 'utf8');
assert.match(manualLinkContract, /recordMediaOperation\(adminClient, \{\s*action: 'link', status: 'success'/, 'link success audited');
assert.match(manualLinkContract, /recordMediaOperation\(adminClient, \{\s*action: 'link', status: 'failed'/, 'link failure audited');
assert.match(manualLinkContract, /mode: 'update', via/, 'update mode audited with via discriminator');
assert.match(manualLinkContract, /mode: 'relink', via/, 'relink mode audited with via discriminator');
assert.match(manualLinkContract, /mode: 'insert', via/, 'insert mode audited with via discriminator');
ok('4a. upsertLinkAsset audits every terminal path (insert/relink/update, success+failure)');

const manualLinkRoute = readFileSync('src/routes/api/admin/media/manual-link/+server.ts', 'utf8');
assert.match(manualLinkRoute, /recordMediaOperation\(adminClient, \{\s*action: 'unlink', status: 'success'/, 'unlink success audited');
assert.match(manualLinkRoute, /action: 'unlink', status: 'failed'/, 'unlink failure audited');
assert.match(manualLinkRoute, /media_asset_id: mediaAssetId,/, 'failure audit keeps media_asset_id (row still exists)');
assert.match(manualLinkRoute, /action: 'unlink', status: 'success', media_item_id: ex\.media_item_id,\s*\r?\n\s*provider_source_id: ex\.provider_source_id \?\? undefined, admin_user_id: user\.id,\s*\r?\n\s*details: \{/, 'success audit omits top-level media_asset_id (FK-safe; the id rides in details)');
ok('4b. manual-link DELETE audits both outcomes with the FK-safe shape');

// (2026-10-15 Task 4) bulk-unlink is a thin HTTP adapter — the audited
// write path lives in the shared contract module (same convention as
// manual-link / bulk-link).
const bulkUnlinkRoute = readFileSync('src/routes/api/admin/media/bulk-unlink/+server.ts', 'utf8');
const bulkUnlinkContract = readFileSync('src/lib/server/hosting/media/bulk-unlink-contract.ts', 'utf8');
assert.match(bulkUnlinkRoute, /requireAdmin/, 'bulk-unlink route enforces admin authorization');
assert.match(bulkUnlinkRoute, /bulkUnlinkSeason/, 'bulk-unlink route delegates to the shared contract');
assert.match(bulkUnlinkContract, /action: 'unlink', status: 'success'/, 'bulk-unlink success audited');
assert.match(bulkUnlinkContract, /action: 'unlink', status: 'failed'/, 'bulk-unlink failure audited');
assert.match(bulkUnlinkContract, /via: 'bulk-unlink'/, 'bulk-unlink audits carry the via discriminator');
ok('4c. bulk-unlink audits follow the same conventions (route = auth adapter, contract = audited writes)');

console.log(`\nAdmin 2.0 Phase D tests passed (${passed} check groups).`);
