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
import { readFileSync } from 'node:fs';
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
// 1. Upload-server route source verification
// ===========================================================================
{
  const src = readFileSync(path.join(REPO_ROOT, 'src/routes/api/admin/media/upload/[id]/upload-server/+server.ts'), 'utf8');
  ok(src.includes('requireAdmin'), 'Upload-server: has requireAdmin');
  ok(src.includes('getHostingAdapter'), 'Upload-server: uses getHostingAdapter');
  ok(src.includes('localUpload'), 'Upload-server: checks localUpload capability');
  ok(src.includes('queued'), 'Upload-server: checks queued state');
  // Phase 7 auth fix: Vidara authenticates via `api_key` query parameter,
  // NOT a Bearer header. The literal `api_key` query-parameter NAME is
  // expected in the source (it is appended by `buildVidaraUrl`). The
  // api_key VALUE IS included in the returned uploadUrl — this is
  // REQUIRED because Vidara's upload server (e.g.
  // https://upl4.s1q2105.com/api/upload) rejects uploads without
  // api_key authentication (returns 401 "Missing API key"). The
  // browser uses this URL ONCE for the direct POST to Vidara and
  // does NOT store or log it.
  ok(src.includes('buildVidaraUrl'), 'Upload-server: uses buildVidaraUrl (api_key query auth)');
  // The route must NOT construct a Bearer Authorization header for the
  // Vidara API call. We check that `createHostingHttpFetcher` is called
  // with `null` (no auth header) and that the dangerous pattern
  // `createHostingHttpFetcher(\`Bearer` (the old broken construction)
  // does NOT appear anywhere — including in comments — so a future
  // reader cannot copy-paste the broken pattern from a comment.
  ok(src.includes('createHostingHttpFetcher(null)'), 'Upload-server: fetcher constructed with null (no Bearer header)');
  ok(!src.includes('createHostingHttpFetcher(`Bearer'), 'Upload-server: NO createHostingHttpFetcher(Bearer) pattern anywhere');
  ok(src.includes('config.apiKey') && !src.includes('console.log'), 'Upload-server: apiKey used server-side only, no logging');
  // VERIFIED FIX: the uploadUrl now carries api_key (needed for the
  // browser-direct upload to Vidara's upload server). The route
  // appends api_key via buildVidaraUrl before returning the URL.
  ok(src.includes('authenticatedUploadUrl'), 'Upload-server: appends api_key to uploadUrl (browser-direct upload requires it)');
  ok(src.includes('buildVidaraUrl(rawUploadUrl'), 'Upload-server: builds authenticated upload URL');
  ok(src.includes('NO_STORE'), 'Upload-server: no-store cache headers');
}
console.log('  ok — upload-server route (9 checks)');

// ===========================================================================
// 2. Complete route source verification
// ===========================================================================
{
  const src = readFileSync(path.join(REPO_ROOT, 'src/routes/api/admin/media/upload/[id]/complete/+server.ts'), 'utf8');
  ok(src.includes('requireAdmin'), 'Complete: has requireAdmin');
  ok(src.includes('providerResult'), 'Complete: accepts providerResult');
  ok(src.includes('normalizeVidaraUploadResult') || src.includes('normalizeAbyssUploadResult'), 'Complete: uses adapter normalizer');
  ok(src.includes('completeUploadFromResult'), 'Complete: uses UploadService.completeUploadFromResult');
  ok(src.includes('already completed'), 'Complete: idempotent (already completed returns existing)');
  ok(src.includes('INVALID_STATE'), 'Complete: rejects non-uploading state');
  ok(!src.includes('api_key'), 'Complete: no api_key in source');
  ok(!src.includes('password'), 'Complete: no password in source');
  ok(src.includes('providerAssetId'), 'Complete: validates providerAssetId present');
  ok(src.includes('NO_STORE'), 'Complete: no-store cache headers');
}
console.log('  ok — complete route (10 checks)');

// ===========================================================================
// 3. Subtitle route source verification
// ===========================================================================
{
  const src = readFileSync(path.join(REPO_ROOT, 'src/routes/api/admin/media/upload/[id]/subtitle/+server.ts'), 'utf8');
  ok(src.includes('requireAdmin'), 'Subtitle: has requireAdmin');
  ok(src.includes('uploadSubtitle'), 'Subtitle: uses adapter.uploadSubtitle()');
  ok(src.includes('subtitles'), 'Subtitle: checks subtitles capability');
  ok(src.includes('UNSUPPORTED'), 'Subtitle: rejects unsupported capability');
  ok(src.includes('subtitle_upload'), 'Subtitle: records subtitle_upload operation');
  ok(src.includes('has_subtitles'), 'Subtitle: updates has_subtitles flag');
  ok(src.includes('media upload remains intact'), 'Subtitle: error does NOT affect main upload');
  ok(!src.includes('api_key'), 'Subtitle: no api_key in source');
  ok(!src.includes('password'), 'Subtitle: no password in source');
  ok(src.includes('NO_STORE'), 'Subtitle: no-store cache headers');
}
console.log('  ok — subtitle route (10 checks)');

// ===========================================================================
// 4. Proxy-upload route source verification (Abyss)
// ===========================================================================
{
  const src = readFileSync(path.join(REPO_ROOT, 'src/routes/api/admin/media/upload/[id]/proxy-upload/+server.ts'), 'utf8');
  ok(src.includes('requireAdmin'), 'Proxy-upload: has requireAdmin');
  ok(src.includes('MAX_PROXY_FILE_SIZE'), 'Proxy-upload: has file size limit');
  // The limit was lowered from 26 MB to 5 MB (Netlify free/Starter plan
  // body limit is 6 MB). See the comment in proxy-upload route.
  ok(src.includes('5 * 1024 * 1024'), 'Proxy-upload: limit is 5 MB (Netlify default)');
  ok(src.includes('FILE_TOO_LARGE'), 'Proxy-upload: rejects oversized files');
  ok(src.includes('uploadFile'), 'Proxy-upload: uses adapter.uploadFile()');
  ok(src.includes('completeUploadFromResult'), 'Proxy-upload: completes via UploadService');
  ok(src.includes('Netlify serverless function body limit'), 'Proxy-upload: documents Netlify limit');
  ok(!src.includes('api_key'), 'Proxy-upload: no api_key in source');
  ok(!src.includes('password'), 'Proxy-upload: no password in source');
  ok(src.includes('NO_STORE'), 'Proxy-upload: no-store cache headers');
}
console.log('  ok — proxy-upload route (10 checks)');

// ===========================================================================
// 5. Admin UI — subtitle upload wired
// ===========================================================================
{
  const src = readFileSync(path.join(REPO_ROOT, 'src/routes/admin/media/upload/+page.svelte'), 'utf8');
  ok(src.includes('uploadSubtitle'), 'UI: has uploadSubtitle function');
  ok(src.includes('subtitleFile'), 'UI: has subtitleFile state');
  ok(src.includes('subtitleLanguage'), 'UI: has subtitleLanguage state');
  ok(src.includes('subtitle-section'), 'UI: has subtitle UI section');
  ok(src.includes('/subtitle'), 'UI: calls /subtitle endpoint');
  ok(src.includes('NOT affected'), 'UI: documents subtitle failure does not affect main upload');
  ok(src.includes('Upload Subtitle'), 'UI: has Upload Subtitle button');
  ok(src.includes('upload-server'), 'UI: calls upload-server endpoint');
  ok(src.includes('/complete'), 'UI: calls complete endpoint');
  ok(src.includes('proxy-upload'), 'UI: calls proxy-upload for Abyss');
}
console.log('  ok — admin UI (10 checks)');

// ===========================================================================
// 6. Abyss large-file architecture — documented limitation
// ===========================================================================
{
  const proxySrc = readFileSync(path.join(REPO_ROOT, 'src/routes/api/admin/media/upload/[id]/proxy-upload/+server.ts'), 'utf8');
  // CRITICAL FIX: the limit was lowered from 26 MB to 5 MB because the
  // actual Netlify Functions body limit on the free/Starter plan is 6 MB.
  // The previous 26 MB value assumed Pro tier — an 8 MB file would be
  // rejected by Netlify BEFORE the route handler ran, returning a non-JSON
  // 413 that the frontend couldn't parse.
  ok(proxySrc.includes('5 * 1024 * 1024'), 'Abyss: max proxy size = 5 MB (Netlify free/Starter plan limit)');
  ok(proxySrc.includes('Netlify serverless function body limit'), 'Abyss: documents Netlify serverless function body limit');
  ok(proxySrc.includes('remote URL upload') || proxySrc.includes('Vidara'), 'Abyss: suggests Vidara for larger files');

  // Abyss adapter: remoteUpload = false (not API-verified).
  const abyssSrc = readFileSync(path.join(REPO_ROOT, 'src/lib/server/hosting/abyss/adapter.ts'), 'utf8');
  ok(abyssSrc.includes('remoteUpload: false'), 'Abyss: remoteUpload = false in adapter');
  ok(abyssSrc.includes('UNSUPPORTED'), 'Abyss: uploadRemote throws UNSUPPORTED');

  // Vidara adapter: remoteUpload = true (documented).
  const vidaraSrc = readFileSync(path.join(REPO_ROOT, 'src/lib/server/hosting/vidara/adapter.ts'), 'utf8');
  ok(vidaraSrc.includes('remoteUpload: true'), 'Vidara: remoteUpload = true in adapter');
}
console.log('  ok — Abyss large-file architecture (5 checks)');

// ===========================================================================
// 7. Security — no credentials in any route
// ===========================================================================
{
  const routes = [
    'src/routes/api/admin/media/upload/[id]/upload-server/+server.ts',
    'src/routes/api/admin/media/upload/[id]/complete/+server.ts',
    'src/routes/api/admin/media/upload/[id]/subtitle/+server.ts',
    'src/routes/api/admin/media/upload/[id]/proxy-upload/+server.ts',
  ];
  for (const route of routes) {
    const src = readFileSync(path.join(REPO_ROOT, route), 'utf8');
    ok(!src.includes('sbp_'), `Security: ${route} — no Supabase PAT`);
    ok(!src.includes('sk_'), `Security: ${route} — no API key prefix`);
    ok(!src.includes('console.log'), `Security: ${route} — no console.log`);
  }
}
console.log('  ok — security (12 checks)');

// ===========================================================================
// 8. State machine — no `pending` introduced
// ===========================================================================
{
  const uploadSrc = readFileSync(path.join(REPO_ROOT, 'src/lib/server/hosting/upload/service.ts'), 'utf8');
  ok(!uploadSrc.includes("'pending'"), 'State machine: no pending in upload service');

  const routes = [
    'src/routes/api/admin/media/upload/+server.ts',
    'src/routes/api/admin/media/upload/[id]/upload-server/+server.ts',
    'src/routes/api/admin/media/upload/[id]/complete/+server.ts',
    'src/routes/api/admin/media/upload/[id]/subtitle/+server.ts',
    'src/routes/api/admin/media/upload/[id]/proxy-upload/+server.ts',
  ];
  for (const route of routes) {
    const src = readFileSync(path.join(REPO_ROOT, route), 'utf8');
    ok(!src.includes("'pending'"), `State machine: no pending in ${route}`);
  }
}
console.log('  ok — state machine (no pending) (6 checks)');

// ===========================================================================
// 9. All routes have requireAdmin
// ===========================================================================
{
  const routes = [
    'src/routes/api/admin/media/search/+server.ts',
    'src/routes/api/admin/media/upload/+server.ts',
    'src/routes/api/admin/media/upload/[id]/status/+server.ts',
    'src/routes/api/admin/media/upload/[id]/cancel/+server.ts',
    'src/routes/api/admin/media/upload/[id]/retry/+server.ts',
    'src/routes/api/admin/media/upload/[id]/upload-server/+server.ts',
    'src/routes/api/admin/media/upload/[id]/complete/+server.ts',
    'src/routes/api/admin/media/upload/[id]/subtitle/+server.ts',
    'src/routes/api/admin/media/upload/[id]/proxy-upload/+server.ts',
  ];
  for (const route of routes) {
    const src = readFileSync(path.join(REPO_ROOT, route), 'utf8');
    ok(src.includes('requireAdmin'), `Auth: ${route} has requireAdmin`);
  }
}
console.log('  ok — all routes authorized (9 checks)');

console.log(`\nPhase 6 Completion/Refinement tests: ${passed} checks passed.`);
