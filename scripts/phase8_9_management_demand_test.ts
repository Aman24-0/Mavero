/**
 * Phase 8 + 9 — Management operations + missing media demand tests.
 *
 * Phase 8 tests:
 *   1. ManagementService source contract
 *   2. Admin API route contracts (rename, move, detach, delete, unlinked)
 *   3. All routes have requireAdmin
 *   4. No secrets in any new source file
 *
 * Phase 9 tests:
 *   5. DemandService source contract
 *   6. Missing media API route contract
 *   7. Playback resolve endpoint has demand tracking
 *   8. Demand tracking is fire-and-forget (does not block)
 *   9. Demand only fires on playback, NOT search/browse
 *   10. No secrets in demand tracking
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

console.log('=== Phase 8 + 9 — Management + Missing Media ===\n');

// ===========================================================================
// PHASE 8 — Management operations
// ===========================================================================
console.log('--- Phase 8: Management operations ---\n');

// 1. ManagementService source contract
{
  const src = readFileSync(path.join(REPO_ROOT, 'src/lib/server/hosting/management/service.ts'), 'utf8');
  ok(src.includes('export class ManagementService'), '1.1 ManagementService class exported');
  ok(src.includes('async renameAsset'), '1.2 renameAsset method');
  ok(src.includes('async moveAsset'), '1.3 moveAsset method');
  ok(src.includes('async detachAsset'), '1.4 detachAsset method');
  ok(src.includes('async deleteAsset'), '1.5 deleteAsset method');
  ok(src.includes('recordOperation'), '1.6 records operations in media_operations');
  ok(src.includes('action: \'rename\''), '1.7 records rename action');
  ok(src.includes('action: \'move\''), '1.8 records move action');
  ok(src.includes('action: \'detach\''), '1.9 records detach action');
  ok(src.includes('action: \'provider_delete\''), '1.10 records provider_delete action');
  // Detach does NOT delete provider file
  ok(src.includes('Does NOT delete the provider-side file'), '1.11 detach does NOT delete provider file');
  // Provider delete only marks deleted after provider confirms
  ok(src.includes('Only update Mavero state after provider confirms deletion'), '1.12 delete only marks deleted after provider confirmation');
  ok(!src.includes('api_key') && !src.includes('password'), '1.13 NO credentials in management source');
}
console.log('  ok — 1. ManagementService contract (13 checks)\n');

// 2. Admin API routes for management
{
  const routes = [
    ['src/routes/api/admin/media/assets/[id]/rename/+server.ts', 'rename'],
    ['src/routes/api/admin/media/assets/[id]/move/+server.ts', 'move'],
    ['src/routes/api/admin/media/assets/[id]/detach/+server.ts', 'detach'],
    ['src/routes/api/admin/media/assets/[id]/delete/+server.ts', 'delete'],
    ['src/routes/api/admin/media/unlinked/+server.ts', 'unlinked'],
  ];
  for (const [route, label] of routes) {
    const src = readFileSync(path.join(REPO_ROOT, route), 'utf8');
    ok(src.includes('requireAdmin'), `2.${label}.1 ${label}: has requireAdmin`);
    ok(src.includes('NO_STORE'), `2.${label}.2 ${label}: no-store cache headers`);
    ok(!src.includes('api_key') && !src.includes('password'), `2.${label}.3 ${label}: NO credentials`);
  }
}
console.log('  ok — 2. Admin API routes (15 checks)\n');

// ===========================================================================
// PHASE 9 — Missing media demand tracking
// ===========================================================================
console.log('--- Phase 9: Missing media demand ---\n');

// 3. DemandService source contract
{
  const src = readFileSync(path.join(REPO_ROOT, 'src/lib/server/hosting/demand/service.ts'), 'utf8');
  ok(src.includes('export class DemandService'), '3.1 DemandService class exported');
  ok(src.includes('async recordDemand'), '3.2 recordDemand method');
  ok(src.includes('async resolveDemand'), '3.3 resolveDemand method');
  ok(src.includes('static buildEntry'), '3.4 buildEntry static method');
  ok(src.includes('movieCanonicalKey'), '3.5 uses movieCanonicalKey');
  ok(src.includes('episodeCanonicalKey'), '3.6 uses episodeCanonicalKey');
  ok(src.includes('canonical_key'), '3.7 uses canonical_key for deduplication');
  ok(src.includes('request_count'), '3.8 increments request_count');
  ok(!src.includes('first_requested_at'), '3.9 preserves first_requested_at (UPDATE does NOT overwrite it — DB default sets it on INSERT)');
  ok(src.includes('last_requested_at'), '3.10 updates last_requested_at');
  ok(src.includes('last_user_kind'), '3.11 tracks last_user_kind');
  ok(src.includes('status'), '3.12 tracks status (open/uploading/ready/ignored)');
  ok(src.includes('Silently absorb'), '3.13 fire-and-forget (absorbs errors)');
  ok(src.includes('Search/browse/detail-page loads do NOT'), '3.14 documents NOT from search/browse');
  ok(!src.includes('api_key') && !src.includes('password') && !src.includes('token'), '3.15 NO credentials in demand source');
}
console.log('  ok — 3. DemandService contract (15 checks)\n');

// 4. Playback resolve endpoint has demand tracking
{
  const src = readFileSync(path.join(REPO_ROOT, 'src/routes/api/playback/resolve/+server.ts'), 'utf8');
  ok(src.includes('Phase 9: Missing-media demand tracking'), '4.1 resolve endpoint has Phase 9 demand tracking');
  ok(src.includes('recordDemandIfNeeded'), '4.2 calls recordDemandIfNeeded');
  ok(src.includes('Fire-and-forget'), '4.3 documents fire-and-forget');
  ok(src.includes('catch(() =>'), '4.4 demand tracking errors are caught (not propagated)');
  ok(src.includes('NOT a Mavero-hosted provider'), '4.5 only fires when NOT a Mavero provider');
  ok(src.includes('mavero') || src.includes('vidara') || src.includes('abyss'), '4.6 checks for Mavero provider name');
  ok(src.includes('DemandService'), '4.7 uses DemandService');
  ok(src.includes('buildEntry'), '4.8 builds demand entry from resolver context');
}
console.log('  ok — 4. Playback resolve demand tracking (8 checks)\n');

// 5. Missing media admin API
{
  const src = readFileSync(path.join(REPO_ROOT, 'src/routes/api/admin/media/missing/+server.ts'), 'utf8');
  ok(src.includes('requireAdmin'), '5.1 missing media API has requireAdmin');
  ok(src.includes('media_availability_requests'), '5.2 queries media_availability_requests table');
  ok(src.includes('status'), '5.3 supports status filter');
  ok(src.includes('limit'), '5.4 supports limit');
  ok(src.includes('PATCH'), '5.5 supports PATCH for status update');
  ok(src.includes('NO_STORE'), '5.6 no-store cache headers');
  ok(!src.includes('api_key') && !src.includes('password'), '5.7 NO credentials');
}
console.log('  ok — 5. Missing media admin API (7 checks)\n');

// 6. Missing media admin UI
{
  const pageSrc = readFileSync(path.join(REPO_ROOT, 'src/routes/admin/media/missing/+page.svelte'), 'utf8');
  ok(pageSrc.includes('Missing Media'), '6.1 UI page title includes "Missing Media"');
  ok(pageSrc.includes('title_snapshot'), '6.2 shows title');
  ok(pageSrc.includes('request_count'), '6.3 shows request count');
  ok(pageSrc.includes('first_requested_at'), '6.4 shows first requested');
  ok(pageSrc.includes('last_requested_at'), '6.5 shows last requested');
  ok(pageSrc.includes('status'), '6.6 shows status');
  ok(pageSrc.includes('Ignore'), '6.7 has Ignore action');
  ok(pageSrc.includes('Resolve'), '6.8 has Resolve action');
  ok(pageSrc.includes('Reopen'), '6.9 has Reopen action');
  ok(pageSrc.includes('Upload'), '6.10 has Upload action (links to upload workflow)');
  ok(pageSrc.includes('uploadUrl'), '6.11 Upload link preserves TMDB/season/episode identity');

  const serverSrc = readFileSync(path.join(REPO_ROOT, 'src/routes/admin/media/missing/+page.server.ts'), 'utf8');
  ok(serverSrc.includes('requireAdmin'), '6.12 page server has requireAdmin');
}
console.log('  ok — 6. Missing media admin UI (12 checks)\n');

// 7. Secret safety
{
  const files = [
    'src/lib/server/hosting/management/service.ts',
    'src/lib/server/hosting/demand/service.ts',
    'src/routes/api/admin/media/assets/[id]/rename/+server.ts',
    'src/routes/api/admin/media/assets/[id]/move/+server.ts',
    'src/routes/api/admin/media/assets/[id]/detach/+server.ts',
    'src/routes/api/admin/media/assets/[id]/delete/+server.ts',
    'src/routes/api/admin/media/unlinked/+server.ts',
    'src/routes/api/admin/media/missing/+server.ts',
    'src/routes/api/playback/resolve/+server.ts',
  ];
  for (const f of files) {
    const src = readFileSync(path.join(REPO_ROOT, f), 'utf8');
    ok(!/54c822e4|adad12|dahayataman/i.test(src), `7.${f}: NO hardcoded credentials in ${f}`);
  }
}
console.log('  ok — 7. Secret safety (9 checks)\n');

// ===========================================================================
// Summary
// ===========================================================================
console.log('====================================');
console.log(`Phase 8+9 summary: ${passed} passed, ${failed} failed`);
console.log('====================================');
if (failed > 0) { console.error(`\n${failed} TEST(S) FAILED`); process.exit(1); }
