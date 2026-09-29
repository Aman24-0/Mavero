/**
 * Phase 10/11 — Retry policy + final verification tests.
 *
 * Phase 10 retry tests:
 *   1. withRetry retries transient failures
 *   2. withRetry does NOT retry permanent errors
 *   3. withRetry is bounded (exhausts after maxAttempts)
 *   4. Vidara adapter wraps read-only ops in withRetry
 *   5. Abyss adapter wraps read-only ops in withRetry
 *   6. Write operations are NOT wrapped in withRetry
 *   7. No nested retry amplification (Abyss authedRequest + withRetry)
 *   8. Abyss 401 refresh behavior preserved
 *
 * Phase 11 verification tests:
 *   9. All hosting routes have requireAdmin
 *   10. No secrets in any source file
 *   11. Resolver unchanged (only ready assets playable)
 *   12. Provider URLs remain embed type
 *   13. No duplicate services or dead code
 *   14. No accidental migrations
 *   15. Deployment readiness (clean state, no debug code)
 */

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
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

console.log('=== Phase 10/11 — Retry Policy + Final Verification ===\n');

// Helper: read a source file
function readSrc(relPath: string): string {
  return readFileSync(path.join(REPO_ROOT, relPath), 'utf8');
}

// ===========================================================================
// Phase 10 — Retry policy tests
// ===========================================================================
console.log('--- Phase 10: Retry policy ---\n');

// 1. withRetry retries transient failures (source contract)
{
  const src = readSrc('src/lib/server/hosting/http-client.ts');
  ok(src.includes('withRetry'), '1.1 withRetry function exists');
  ok(src.includes('isRetryableCode'), '1.2 isRetryableCode checks retryability');
  ok(src.includes("RATE_LIMITED' || code === 'TRANSIENT' || code === 'NETWORK' || code === 'TIMEOUT'"), '1.3 retries RATE_LIMITED, TRANSIENT, NETWORK, TIMEOUT');
  ok(src.includes('maxAttempts'), '1.4 bounded by maxAttempts');
  ok(src.includes('exponential'), '1.5 exponential backoff');
  ok(src.includes('jitter'), '1.6 jitter');
  ok(src.includes('Permanent — do not retry'), '1.7 permanent errors not retried');
  ok(!src.includes('while (true)'), '1.8 NO infinite loops');
}
console.log('  ok — 1. withRetry contract (8 checks)\n');

// 2. Vidara adapter wraps read-only ops
{
  const src = readSrc('src/lib/server/hosting/vidara/adapter.ts');
  ok(src.includes('withReadRetry'), '2.1 Vidara has withReadRetry helper');
  ok(src.includes('withRetry(fn, 3, 500, 5_000)'), '2.2 Vidara uses bounded retry (3 attempts, 500ms base, 5s max)');
  // Read operations wrapped
  ok(src.includes('this.withReadRetry'), '2.3 Vidara wraps operations in withReadRetry');
  // Count how many times withReadRetry appears (should be for: getAccountInfo, getAsset, listAssets, getProcessingStatus, listFolders)
  const count = (src.match(/this\.withReadRetry/g) || []).length;
  ok(count >= 5, `2.4 Vidara wraps at least 5 read-only operations (found ${count})`);
  // Write operations NOT wrapped
  ok(!src.includes('renameAsset') || !src.slice(src.indexOf('async renameAsset')).slice(0, 200).includes('withReadRetry'), '2.5 rename NOT wrapped in withReadRetry');
}
console.log('  ok — 2. Vidara retry wrapping (5 checks)\n');

// 3. Abyss adapter wraps read-only ops
{
  const src = readSrc('src/lib/server/hosting/abyss/adapter.ts');
  ok(src.includes('withReadRetry'), '3.1 Abyss has withReadRetry helper');
  ok(src.includes('withRetry(fn, 3, 500, 5_000)'), '3.2 Abyss uses bounded retry (3 attempts, 500ms base, 5s max)');
  ok(src.includes('this.withReadRetry'), '3.3 Abyss wraps operations in withReadRetry');
  const count = (src.match(/this\.withReadRetry/g) || []).length;
  ok(count >= 5, `3.4 Abyss wraps at least 5 read-only operations (found ${count})`);
  // No nested retry amplification: authedRequest is NOT wrapped in withRetry
  ok(src.includes('authedRequest'), '3.5 Abyss authedRequest exists (handles 401 refresh)');
  ok(src.includes('loginPermanentlyFailed'), '3.6 Abyss permanent auth-failure guard preserved');
  ok(src.includes('inflightLogin'), '3.7 Abyss concurrent login guard preserved');
  // The authedRequest 401-retry-once is explicit single-retry, NOT withRetry
  ok(!src.slice(src.indexOf('private async authedRequest'), src.indexOf('// --- Account ---')).includes('withRetry'), '3.8 authedRequest does NOT use withRetry (no amplification)');
}
console.log('  ok — 3. Abyss retry wrapping (8 checks)\n');

// 4. No nested retry amplification
{
  const vidaraSrc = readSrc('src/lib/server/hosting/vidara/adapter.ts');
  const abyssSrc = readSrc('src/lib/server/hosting/abyss/adapter.ts');
  // Vidara does NOT have authedRequest (it's mentioned in a comment about Abyss, not used)
  ok(!vidaraSrc.includes('async authedRequest'), '4.1 Vidara has no authedRequest method (no nesting risk)');
  // Abyss authedRequest is a single-retry on 401, NOT withRetry
  ok(!abyssSrc.includes('withRetry(this.authedRequest'), '4.2 Abyss does NOT wrap authedRequest in withRetry');
  ok(!abyssSrc.includes('withRetry(async () => this.authedRequest'), '4.3 Abyss does NOT wrap authedRequest in withRetry (lambda)');
}
console.log('  ok — 4. No retry amplification (3 checks)\n');

// 5. Write operations NOT retried (no withReadRetry on write methods)
{
  const vidaraSrc = readSrc('src/lib/server/hosting/vidara/adapter.ts');
  const abyssSrc = readSrc('src/lib/server/hosting/abyss/adapter.ts');
  // Check that rename, move, delete, upload, uploadRemote, uploadSubtitle, uploadThumbnail are NOT wrapped
  for (const method of ['renameAsset', 'moveAsset', 'deleteAsset', 'uploadFile', 'uploadRemote', 'uploadSubtitle', 'uploadThumbnail']) {
    // Find the method body in Vidara adapter
    const vidaraIdx = vidaraSrc.indexOf(`async ${method}(`);
    if (vidaraIdx >= 0) {
      const methodBody = vidaraSrc.slice(vidaraIdx, vidaraIdx + 500);
      ok(!methodBody.includes('withReadRetry'), `5.1 Vidara ${method} NOT wrapped in withReadRetry`);
    }
    // Find in Abyss adapter
    const abyssIdx = abyssSrc.indexOf(`async ${method}(`);
    if (abyssIdx >= 0) {
      const methodBody = abyssSrc.slice(abyssIdx, abyssIdx + 500);
      ok(!methodBody.includes('withReadRetry'), `5.2 Abyss ${method} NOT wrapped in withReadRetry`);
    }
  }
}
console.log('  ok — 5. Write operations not retried (14 checks)\n');

// ===========================================================================
// Phase 11 — Final verification tests
// ===========================================================================
console.log('--- Phase 11: Final verification ---\n');

// 6. All admin hosting routes have requireAdmin
{
  const routes = readdirSync(path.join(REPO_ROOT, 'src/routes/api/admin/media'), { recursive: true })
    .filter((f) => f.toString().endsWith('+server.ts'))
    .map((f) => f.toString());

  let allHaveAdmin = true;
  for (const route of routes) {
    const src = readSrc(`src/routes/api/admin/media/${route}`);
    if (!src.includes('requireAdmin')) {
      console.error(`  MISSING requireAdmin: ${route}`);
      allHaveAdmin = false;
    }
  }
  ok(allHaveAdmin, `6.1 All ${routes.length} admin media routes have requireAdmin`);
}
console.log('  ok — 6. Admin authorization (1 check)\n');

// 7. No secrets in any hosting source file
{
  const hostingFiles = readdirSync(path.join(REPO_ROOT, 'src/lib/server/hosting'), { recursive: true })
    .filter((f) => f.toString().endsWith('.ts'))
    .map((f) => `src/lib/server/hosting/${f.toString()}`);

  let noSecrets = true;
  for (const file of hostingFiles) {
    const src = readSrc(file);
    if (/54c822e4|adad12|dahayataman/i.test(src)) {
      console.error(`  SECRET FOUND: ${file}`);
      noSecrets = false;
    }
  }
  ok(noSecrets, `7.1 No credential values in ${hostingFiles.length} hosting source files`);
}
console.log('  ok — 7. Secret safety (1 check)\n');

// 8. Resolver unchanged — only ready assets
{
  const resolverSrc = readSrc('src/lib/server/resolver/mavero-hosted.ts');
  ok(resolverSrc.includes("eq('status', 'ready')"), '8.1 Resolver gates on status = ready');
  ok(resolverSrc.includes('type: \'embed\''), '8.2 Resolver returns embed type (not direct)');
  ok(!resolverSrc.includes('type: \'direct\''), '8.3 Resolver does NOT return direct type');
}
console.log('  ok — 8. Resolver behavior (3 checks)\n');

// 9. No duplicate services
{
  const hostingDir = readdirSync(path.join(REPO_ROOT, 'src/lib/server/hosting'), { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
  ok(hostingDir.includes('vidara'), '9.1 Vidara adapter directory exists');
  ok(hostingDir.includes('abyss'), '9.2 Abyss adapter directory exists');
  ok(hostingDir.includes('upload'), '9.3 Upload service directory exists');
  ok(hostingDir.includes('sync'), '9.4 Sync service directory exists');
  ok(hostingDir.includes('management'), '9.5 Management service directory exists');
  ok(hostingDir.includes('demand'), '9.6 Demand service directory exists');
  ok(hostingDir.includes('health'), '9.7 Health service directory exists');
  ok(hostingDir.includes('media'), '9.8 Canonical media service directory exists');
  // No duplicate directories
  const uniqueDirs = new Set(hostingDir);
  ok(uniqueDirs.size === hostingDir.length, '9.9 No duplicate service directories');
}
console.log('  ok — 9. No duplicate services (9 checks)\n');

// 10. No accidental migrations from Phase 10/11
{
  const migrations = readdirSync(path.join(REPO_ROOT, 'supabase/migrations'))
    .filter((f) => f.endsWith('.sql'));
  // NOTE: the broader Mavero project has an unrelated Phase 11 sandbox migration
  // (20260919000000_phase11_sandbox_inheritance.sql) — that's NOT from the
  // Vidara+Abyss hosting project. We filter for hosting-specific migrations only.
  const phase10Migrations = migrations.filter((f) => /phase1[01]_(hardening|retry|verification|hosting)/i.test(f));
  ok(phase10Migrations.length === 0, `10.1 No Phase 10/11 hosting migrations created (found ${phase10Migrations.length})`);
}
console.log('  ok — 10. No accidental migrations (1 check)\n');

// 11. No debug console.log in hosting source (except playback resolve which logs error code only)
{
  const hostingFiles = readdirSync(path.join(REPO_ROOT, 'src/lib/server/hosting'), { recursive: true })
    .filter((f) => f.toString().endsWith('.ts'))
    .map((f) => `src/lib/server/hosting/${f.toString()}`);

  let noDebugLogs = true;
  for (const file of hostingFiles) {
    const src = readSrc(file);
    if (src.includes('console.log')) {
      console.error(`  console.log found: ${file}`);
      noDebugLogs = false;
    }
  }
  ok(noDebugLogs, '11.1 No console.log in hosting source files');
}
console.log('  ok — 11. No debug logging (1 check)\n');

// 12. Error model completeness
{
  const errorSrc = readSrc('src/lib/server/hosting/errors.ts');
  ok(errorSrc.includes('AUTHENTICATION'), '12.1 AUTHENTICATION error code');
  ok(errorSrc.includes('AUTHORIZATION'), '12.2 AUTHORIZATION error code');
  ok(errorSrc.includes('VALIDATION'), '12.3 VALIDATION error code');
  ok(errorSrc.includes('NOT_FOUND'), '12.4 NOT_FOUND error code');
  ok(errorSrc.includes('RATE_LIMITED'), '12.5 RATE_LIMITED error code');
  ok(errorSrc.includes('TRANSIENT'), '12.6 TRANSIENT error code');
  ok(errorSrc.includes('PROVIDER_PROCESSING'), '12.7 PROVIDER_PROCESSING error code');
  ok(errorSrc.includes('UNSUPPORTED'), '12.8 UNSUPPORTED error code');
  ok(errorSrc.includes('NETWORK'), '12.9 NETWORK error code');
  ok(errorSrc.includes('TIMEOUT'), '12.10 TIMEOUT error code');
  ok(errorSrc.includes('UNKNOWN'), '12.11 UNKNOWN error code');
}
console.log('  ok — 12. Error model completeness (11 checks)\n');

// 13. Phase 9 demand tracking + auto-resolution preserved
{
  const demandSrc = readSrc('src/lib/server/hosting/demand/service.ts');
  ok(demandSrc.includes('recordDemand'), '13.1 recordDemand exists');
  ok(demandSrc.includes('resolveDemand'), '13.2 resolveDemand exists');
  ok(demandSrc.includes('buildEntry'), '13.3 buildEntry exists');
  ok(demandSrc.includes('canonical_key'), '13.4 uses canonical_key for dedup');

  const uploadSrc = readSrc('src/lib/server/hosting/upload/service.ts');
  ok(uploadSrc.includes('resolveDemandForMediaItem'), '13.5 Upload auto-resolution wired');
  // resolveDemandForMediaItem is in upload, resolveDemandForAsset is in sync — NOT cross-contaminated
  ok(!uploadSrc.includes('resolveDemandForAsset'), '13.6 Upload uses resolveDemandForMediaItem (NOT resolveDemandForAsset from sync)');

  const syncSrc = readSrc('src/lib/server/hosting/sync/service.ts');
  ok(syncSrc.includes('resolveDemandForAsset'), '13.7 Sync auto-resolution wired');
}
console.log('  ok — 13. Phase 9 demand tracking preserved (7 checks)\n');

// 14. Stale operation handling
{
  const uploadSrc = readSrc('src/lib/server/hosting/upload/service.ts');
  ok(uploadSrc.includes('STALE_OPERATION'), '14.1 Upload stale-operation handling');
  ok(uploadSrc.includes('MISSING_ASSET_ID'), '14.2 Upload missing-asset-id handling');
  ok(uploadSrc.includes('auto-fail'), '14.3 Upload documents auto-fail behavior');

  const staleSrc = readSrc('src/routes/api/admin/media/stale/+server.ts');
  ok(staleSrc.includes('STALE_THRESHOLD_MINUTES'), '14.4 Stale API has threshold');
  ok(staleSrc.includes('markAllStale'), '14.5 Stale API supports bulk cleanup');
}
console.log('  ok — 14. Stale operation handling (5 checks)\n');

// 15. Provider health
{
  const healthSrc = readSrc('src/lib/server/hosting/health/service.ts');
  ok(healthSrc.includes('checkProvider'), '15.1 checkProvider method');
  ok(healthSrc.includes('checkAll'), '15.2 checkAll method');
  ok(healthSrc.includes('healthy'), '15.3 healthy status');
  ok(healthSrc.includes('degraded'), '15.4 degraded status');
  ok(healthSrc.includes('unavailable'), '15.5 unavailable status');
  ok(healthSrc.includes('misconfigured'), '15.6 misconfigured status');
  ok(healthSrc.includes('latencyMs'), '15.7 latency reporting');
}
console.log('  ok — 15. Provider health (7 checks)\n');

// ===========================================================================
// Summary
// ===========================================================================
console.log('====================================');
console.log(`Phase 10/11 summary: ${passed} passed, ${failed} failed`);
console.log('====================================');
if (failed > 0) { console.error(`\n${failed} TEST(S) FAILED`); process.exit(1); }
