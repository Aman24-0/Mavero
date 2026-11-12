/**
 * Phase 6 Completion/Refinement — Tests for the new routes.
 *
 * Tests:
 *   - upload-server route source (authorization, no secrets)
 *   - complete route source (idempotency, provider mismatch)
 *   - subtitle route source (authorization, capability check)
 *   - proxy-upload route source (file size limit, authorization)
 *   - Abyss large-file architecture (documented limitation)
 *   - Subtitle error handling (separate from main upload)
 */

import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

let passed = 0;
function ok(condition: unknown, label: string) {
  assert.ok(condition, label);
  passed += 1;
}

console.log('=== Phase 6 Completion/Refinement — Route tests ===\n');

// ===========================================================================
// 1-5. Upload route family — REMOVED (2026-10-15)
// ===========================================================================
// The Upload/Import workflow was deliberately removed: the upload-server,
// complete, subtitle, proxy-upload, status, cancel, retry routes, the
// upload page, and the upload service are all gone. The per-route source
// contracts (requireAdmin, capability checks, Vidara api_key query auth,
// 5 MB proxy limit, subtitle error isolation) are retired with them.
// The auth/secret-safety invariants that remain live on in the surviving
// write paths and are re-pinned below.
console.log('=== Route removal contract ===\n');
{
  const removedRoutes = [
    'src/routes/api/admin/media/upload/+server.ts',
    'src/routes/api/admin/media/upload/[id]/upload-server/+server.ts',
    'src/routes/api/admin/media/upload/[id]/complete/+server.ts',
    'src/routes/api/admin/media/upload/[id]/subtitle/+server.ts',
    'src/routes/api/admin/media/upload/[id]/proxy-upload/+server.ts',
    'src/routes/api/admin/media/upload/[id]/status/+server.ts',
    'src/routes/api/admin/media/upload/[id]/cancel/+server.ts',
    'src/routes/api/admin/media/upload/[id]/retry/+server.ts',
    'src/routes/admin/media/upload/+page.svelte',
    'src/routes/admin/media/upload/+page.server.ts',
    'src/lib/server/hosting/upload/service.ts',
  ];
  for (const route of removedRoutes) {
    ok(!existsSync(path.join(REPO_ROOT, route)), `Removed: ${route}`);
  }
}
console.log('  ok — upload route family + service removed (11 checks)');

// The surviving write paths keep the auth + secret-safety invariants.
{
  const surviving = [
    'src/routes/api/admin/media/manual-link/+server.ts',
    'src/routes/api/admin/media/bulk-link/+server.ts',
    'src/routes/api/admin/media/bulk-unlink/+server.ts',
    'src/routes/api/admin/media/search/+server.ts',
  ];
  for (const route of surviving) {
    const src = readFileSync(path.join(REPO_ROOT, route), 'utf8');
    ok(src.includes('requireAdmin'), `Auth: ${route} has requireAdmin`);
    ok(!src.includes('sbp_'), `Security: ${route} — no Supabase PAT`);
    ok(!src.includes('sk_'), `Security: ${route} — no API key prefix`);
  }
  // Vidara's api-key-as-query-parameter auth contract survives in the
  // adapter itself (the upload-server route was only a consumer).
  const vidaraAdapter = readFileSync(path.join(REPO_ROOT, 'src/lib/server/hosting/vidara/adapter.ts'), 'utf8');
  ok(vidaraAdapter.includes('buildVidaraUrl'), 'Vidara adapter keeps buildVidaraUrl (api_key query auth)');
  ok(!vidaraAdapter.includes('createHostingHttpFetcher(`Bearer'), 'Vidara adapter never constructs a Bearer header (comments may document why not)');
}
console.log('  ok — surviving write paths: auth + secret safety (9 checks)');

// ===========================================================================
// 6. Abyss large-file architecture — documented limitation
// (2026-10-15) the server-proxied upload path was removed with the
// Upload/Import workflow; Abyss large-file guidance now lives in the
// adapter's own documentation.
// ===========================================================================
{
  const abyssSrc = readFileSync(path.join(REPO_ROOT, 'src/lib/server/hosting/abyss/adapter.ts'), 'utf8');
  ok(abyssSrc.includes('uploadFile') || abyssSrc.includes('upload'), 'Abyss: adapter keeps its upload capability for direct flows');
}

console.log(`\nPhase 6 Completion/Refinement tests: ${passed} checks passed.`);
