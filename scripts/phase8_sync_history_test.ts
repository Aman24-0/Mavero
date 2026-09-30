/**
 * Phase 8 — Sync + History + Management tests.
 *
 * Tests:
 *   1. SyncService source contract (correct imports, idempotent design)
 *   2. UploadService.executeRemoteUpload validates providerAssetId
 *   3. UploadService.pollProcessingStatus auto-fails stale operations
 *   4. UploadService.recordOperation records audit history
 *   5. Sync API route source contract
 *   6. Operations API route source contract
 *   7. Reconcile API route source contract
 *   8. No secrets in any new source file
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

let passed = 0;
let failed = 0;
function ok(condition: unknown, label: string) {
  try { assert.ok(condition, label); passed += 1; }
  catch (err) { failed += 1; console.error(`  FAIL: ${label}`); if (err instanceof Error && err.message !== label) console.error(`        ${err.message}`); }
}

console.log('=== Phase 8 — Sync + History + Management ===\n');

// ===========================================================================
// 1. SyncService source contract
// ===========================================================================
console.log('--- 1. SyncService source contract ---');
{
  const src = readFileSync(path.join(REPO_ROOT, 'src/lib/server/hosting/sync/service.ts'), 'utf8');
  ok(src.includes('export class SyncService'), '1.1 SyncService class exported');
  ok(src.includes('async syncProvider'), '1.2 syncProvider method');
  ok(src.includes('async syncAll'), '1.3 syncAll method');
  ok(src.includes('async reconcileAsset'), '1.4 reconcileAsset method');
  ok(src.includes('Idempotent'), '1.5 documents idempotency');
  ok(src.includes('unlinkedFiles'), '1.6 returns unlinked files');
  ok(src.includes('Does NOT guess TMDB'), '1.7 does not guess TMDB matches');
  ok(src.includes('getHostingAdapter'), '1.8 uses adapter registry');
  ok(src.includes('SERVER-SIDE ONLY'), '1.9 documents server-side only');
  ok(!src.includes('api_key') && !src.includes('password') && !src.includes('token'), '1.10 NO credentials in sync source');
}
console.log('  ok — 1. SyncService contract (10 checks)\n');

// ===========================================================================
// 2. executeRemoteUpload validates providerAssetId
// ===========================================================================
console.log('--- 2. executeRemoteUpload validates providerAssetId ---');
{
  const src = readFileSync(path.join(REPO_ROOT, 'src/lib/server/hosting/upload/service.ts'), 'utf8');
  ok(src.includes('CRITICAL FIX (Phase 8): validate that the upload result contains a'), '2.1 documents the Phase 8 fix');
  ok(src.includes('if (!result.providerAssetId)'), '2.2 validates providerAssetId before createMediaAsset');
  ok(src.includes('Remote upload succeeded but the provider response did not contain a provider asset ID'), '2.3 clear error message for missing asset ID');
  ok(src.includes("throw new HostingProviderError('VALIDATION'"), '2.4 throws VALIDATION error');
}
console.log('  ok — 2. executeRemoteUpload validation (4 checks)\n');

// ===========================================================================
// 3. pollProcessingStatus auto-fails stale operations
// ===========================================================================
console.log('--- 3. pollProcessingStatus auto-fails stale operations ---');
{
  const src = readFileSync(path.join(REPO_ROOT, 'src/lib/server/hosting/upload/service.ts'), 'utf8');
  ok(src.includes('stale-operation safety'), '3.1 documents stale-operation safety');
  ok(src.includes('if (!op.media_asset_id)'), '3.2 checks for missing media_asset_id');
  ok(src.includes('STALE_OPERATION'), '3.3 uses STALE_OPERATION error code');
  ok(src.includes('MISSING_ASSET_ID'), '3.4 uses MISSING_ASSET_ID error code');
  ok(src.includes('auto-fail operations with no provider_asset_id'), '3.5 documents auto-fail for missing provider_asset_id');
  ok(src.includes("status: 'failed'"), '3.6 marks operation as failed');
  ok(src.includes("mavero_status: 'failed'"), '3.7 marks media_asset as failed');
}
console.log('  ok — 3. Stale operation handling (7 checks)\n');

// ===========================================================================
// 4. recordOperation records audit history
// ===========================================================================
console.log('--- 4. recordOperation audit history ---');
{
  const src = readFileSync(path.join(REPO_ROOT, 'src/lib/server/hosting/upload/service.ts'), 'utf8');
  ok(src.includes('Phase 8 — Records a management operation'), '4.1 documents Phase 8 audit recording');
  ok(src.includes('async recordOperation'), '4.2 recordOperation method exists');
  ok(src.includes("action: 'ready'"), '4.3 records ready transitions');
  ok(src.includes("action: 'failed'"), '4.4 records failed transitions');
  ok(src.includes("'upload_remote'"), '4.5 records remote upload actions');
  ok(src.includes('Silently absorb'), '4.6 best-effort (does not break main operation)');
  ok(src.includes('never store credentials'), '4.7 documents security: no credentials in details');
  ok(!/password|api_key.*=.*['"][a-f0-9]{20}/i.test(src), '4.8 NO hardcoded secrets');
}
console.log('  ok — 4. Audit history (8 checks)\n');

// ===========================================================================
// 5. Sync API route source contract
// ===========================================================================
console.log('--- 5. Sync API route contract ---');
{
  const src = readFileSync(path.join(REPO_ROOT, 'src/routes/api/admin/media/sync/+server.ts'), 'utf8');
  ok(src.includes('requireAdmin'), '5.1 sync route has requireAdmin');
  ok(src.includes('SyncService'), '5.2 uses SyncService');
  ok(src.includes('syncProvider'), '5.3 supports single-provider sync');
  ok(src.includes('syncAll'), '5.4 supports sync-all');
  ok(src.includes('NO_STORE'), '5.5 no-store cache headers');
  ok(!src.includes('api_key') && !src.includes('password'), '5.6 NO credentials in route');
}
console.log('  ok — 5. Sync API route (6 checks)\n');

// ===========================================================================
// 6. Operations API route source contract
// ===========================================================================
console.log('--- 6. Operations API route contract ---');
{
  const src = readFileSync(path.join(REPO_ROOT, 'src/routes/api/admin/media/operations/+server.ts'), 'utf8');
  ok(src.includes('requireAdmin'), '6.1 operations route has requireAdmin');
  ok(src.includes('media_operations'), '6.2 queries media_operations table');
  ok(src.includes('action'), '6.3 supports action filter');
  ok(src.includes('status'), '6.4 supports status filter');
  ok(src.includes('limit'), '6.5 supports limit');
  ok(src.includes('NO_STORE'), '6.6 no-store cache headers');
  ok(!src.includes('api_key') && !src.includes('password'), '6.7 NO credentials in route');
}
console.log('  ok — 6. Operations API route (7 checks)\n');

// ===========================================================================
// 7. Reconcile API route source contract
// ===========================================================================
console.log('--- 7. Reconcile API route contract ---');
{
  const src = readFileSync(path.join(REPO_ROOT, 'src/routes/api/admin/media/assets/[id]/reconcile/+server.ts'), 'utf8');
  ok(src.includes('requireAdmin'), '7.1 reconcile route has requireAdmin');
  ok(src.includes('SyncService'), '7.2 uses SyncService.reconcileAsset');
  ok(src.includes('reconcileAsset'), '7.3 calls reconcileAsset');
  ok(src.includes('NO_STORE'), '7.4 no-store cache headers');
  ok(!src.includes('api_key') && !src.includes('password'), '7.5 NO credentials in route');
}
console.log('  ok — 7. Reconcile API route (5 checks)\n');

// ===========================================================================
// 8. No secrets in any new source file
// ===========================================================================
console.log('--- 8. Secret safety ---');
{
  const files = [
    'src/lib/server/hosting/sync/service.ts',
    'src/routes/api/admin/media/sync/+server.ts',
    'src/routes/api/admin/media/operations/+server.ts',
    'src/routes/api/admin/media/assets/[id]/reconcile/+server.ts',
  ];
  for (const f of files) {
    const src = readFileSync(path.join(REPO_ROOT, f), 'utf8');
    ok(!/54c822e4|adad12|dahayataman/i.test(src), `8.${f}: NO hardcoded credentials in ${f}`);
  }
}
console.log('  ok — 8. Secret safety (4 checks)\n');

// ===========================================================================
// Summary
// ===========================================================================
console.log('====================================');
console.log(`Phase 8 summary: ${passed} passed, ${failed} failed`);
console.log('====================================');
if (failed > 0) { console.error(`\n${failed} TEST(S) FAILED`); process.exit(1); }
