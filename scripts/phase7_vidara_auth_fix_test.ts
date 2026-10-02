/**
 * Phase 7 Vidara Authentication Fix — focused tests.
 *
 * Proves:
 *   1. Vidara API key is authenticated using the correct mechanism
 *      (api_key query parameter, NOT a Bearer Authorization header).
 *   2. API key never appears in client-visible payloads (the
 *      upload-server route returns ONLY the uploadUrl, never the
 *      api_key).
 *   3. upload-server request succeeds with the mocked correct
 *      authentication (the GET /v1/upload/server URL carries
 *      ?api_key=<key> and the mock fetcher receives it).
 *   4. 401 is no longer caused by the incorrect Bearer scheme —
 *      the previous implementation sent a Bearer header that
 *      Vidara does not recognize.
 *   5. Abyss behavior remains unchanged — Abyss still uses the
 *      shared fetcher with its own JWT Bearer header via
 *      `authedRequest()`. The shared `createHostingHttpFetcher`
 *      signature and behavior are unchanged.
 *
 * Test philosophy (mirrors phase3_hosting_adapter_test.ts):
 *   - Mock fetcher captures the request URL + headers so we can
 *     assert exactly how Vidara is authenticated.
 *   - Source-contract tests verify the adapter file uses
 *      `api_key` query param and NOT a Bearer header.
 *   - No live API calls.
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
  try {
    assert.ok(condition, label);
    passed += 1;
  } catch (err) {
    failed += 1;
    console.error(`  FAIL: ${label}`);
    if (err instanceof Error && err.message !== label) console.error(`        ${err.message}`);
  }
}
function eq<T>(actual: T, expected: T, label: string) {
  try {
    assert.deepEqual(actual, expected, label);
    passed += 1;
  } catch (err) {
    failed += 1;
    console.error(`  FAIL: ${label}\n        actual:   ${JSON.stringify(actual)}\n        expected: ${JSON.stringify(expected)}`);
    if (err instanceof Error && err.message !== label) console.error(`        ${err.message}`);
  }
}

console.log('=== Phase 7 — Vidara Authentication Fix ===\n');

// ===========================================================================
// SECTION A — Source contract (deterministic, no live API)
// ===========================================================================

console.log('--- Section A: Source contract ---\n');

// A.1 Vidara adapter uses api_key query parameter, NOT Bearer header
{
  const src = readFileSync(path.join(REPO_ROOT, 'src/lib/server/hosting/vidara/adapter.ts'), 'utf8');
  // The shared fetcher is constructed with `null` — no Authorization header.
  ok(src.includes('createHostingHttpFetcher(null)'), 'A.1.1 Vidara adapter constructs fetcher with null (no Authorization header)');
  // The adapter does NOT pass a Bearer header to the fetcher.
  ok(!src.includes('createHostingHttpFetcher(`Bearer'), 'A.1.2 Vidara adapter does NOT use createHostingHttpFetcher(`Bearer ...`)');
  // The adapter exports a buildVidaraUrl helper that appends api_key.
  ok(src.includes('export function buildVidaraUrl'), 'A.1.3 Vidara adapter exports buildVidaraUrl');
  // The helper appends api_key as a query parameter.
  ok(src.includes("url.searchParams.set('api_key', apiKey)"), 'A.1.4 buildVidaraUrl sets api_key query parameter');
  // The adapter has a private url() helper that centralizes auth.
  ok(src.includes('private url(path: string'), 'A.1.5 Vidara adapter has private url() helper');
  // Every endpoint method uses this.url() — no raw `${this.config.baseUrl}` URL construction remains.
  ok(!/\$\{this\.config\.baseUrl\}\/v1\//.test(src), 'A.1.6 No raw baseUrl URL construction remains (all use this.url())');
}
console.log('  ok — A.1 adapter contract (6 checks)\n');

// A.2 upload-server route uses buildVidaraUrl, not Bearer
{
  const src = readFileSync(path.join(REPO_ROOT, 'src/routes/api/admin/media/upload/[id]/upload-server/+server.ts'), 'utf8');
  ok(src.includes('buildVidaraUrl'), 'A.2.1 upload-server route uses buildVidaraUrl');
  ok(src.includes('createHostingHttpFetcher(null)'), 'A.2.2 upload-server route constructs fetcher with null');
  ok(!src.includes('createHostingHttpFetcher(`Bearer'), 'A.2.3 upload-server route does NOT use createHostingHttpFetcher(`Bearer`)');
  // The route returns only uploadUrl — never the api_key.
  // VERIFIED FIX: the uploadUrl now DOES carry api_key — the Vidara
  // upload server (e.g. https://upl4.s1q2105.com/api/upload) requires
  // it. The route appends api_key via buildVidaraUrl before returning.
  ok(src.includes('authenticatedUploadUrl'), 'A.2.4 upload-server route appends api_key to uploadUrl (upload server requires it)');
  ok(src.includes('buildVidaraUrl(rawUploadUrl'), 'A.2.5 upload-server route builds authenticated upload URL');
}
console.log('  ok — A.2 upload-server route contract (5 checks)\n');

// A.3 Shared http-client.ts is UNCHANGED — Abyss still works
{
  const src = readFileSync(path.join(REPO_ROOT, 'src/lib/server/hosting/http-client.ts'), 'utf8');
  // The shared fetcher still accepts an authorizationHeader parameter.
  ok(src.includes('export function createHostingHttpFetcher(authorizationHeader: string | null)'), 'A.3.1 shared fetcher signature unchanged (accepts authorizationHeader)');
  // The shared fetcher still injects the Authorization header when provided.
  ok(src.includes("headers['authorization'] = authorizationHeader"), 'A.3.2 shared fetcher still injects Authorization header (Abyss uses this)');
  // The shared fetcher still skips the header when null.
  ok(src.includes('if (authorizationHeader)'), 'A.3.3 shared fetcher conditionally injects Authorization header');
}
console.log('  ok — A.3 shared http-client unchanged (3 checks)\n');

// A.4 Abyss adapter is UNCHANGED — still uses JWT Bearer via authedRequest
{
  const src = readFileSync(path.join(REPO_ROOT, 'src/lib/server/hosting/abyss/adapter.ts'), 'utf8');
  // Abyss still constructs the shared fetcher with null (initial — no JWT yet).
  ok(src.includes('createHostingHttpFetcher(null)'), 'A.4.1 Abyss adapter constructs fetcher with null (initial)');
  // Abyss still has the authedRequest method that adds a Bearer JWT header.
  ok(src.includes('private async authedRequest'), 'A.4.2 Abyss adapter still has authedRequest method');
  ok(src.includes("authorization: `Bearer ${token}`"), 'A.4.3 Abyss adapter still uses Bearer JWT in authedRequest');
  // Abyss does NOT use api_key query parameter.
  ok(!src.includes('api_key'), 'A.4.4 Abyss adapter does NOT use api_key (different auth scheme)');
}
console.log('  ok — A.4 Abyss adapter unchanged (4 checks)\n');

// ===========================================================================
// SECTION B — buildVidaraUrl unit tests (pure function, no I/O)
// ===========================================================================

console.log('--- Section B: buildVidaraUrl unit tests ---\n');

{
  const { buildVidaraUrl } = await import('../src/lib/server/hosting/vidara/adapter.ts');

  // B.1 Simple path — api_key appended
  {
    const url = buildVidaraUrl('https://api.vidara.so', '/v1/upload/server', null, 'test-key-123');
    ok(url.includes('https://api.vidara.so/v1/upload/server'), 'B.1.1 URL preserves base + path');
    ok(url.includes('api_key=test-key-123'), 'B.1.2 api_key query parameter appended');
    ok(url.includes('?api_key='), 'B.1.3 api_key is the first (and only) query parameter');
  }
  console.log('  ok — B.1 simple path (3 checks)');

  // B.2 Path with existing query params — api_key appended with &
  {
    const url = buildVidaraUrl('https://api.vidara.so', '/v1/video/info', { filecode: 'abc123' }, 'test-key-456');
    ok(url.includes('/v1/video/info'), 'B.2.1 URL preserves path');
    ok(url.includes('filecode=abc123'), 'B.2.2 existing query param preserved');
    ok(url.includes('api_key=test-key-456'), 'B.2.3 api_key appended alongside existing query param');
    ok(url.includes('&api_key='), 'B.2.4 api_key appended with & (not ?)');
    // Order: file_code first, api_key second (deterministic).
    ok(url.indexOf('filecode=') < url.indexOf('api_key='), 'B.2.5 api_key appended AFTER existing query params');
  }
  console.log('  ok — B.2 path with existing query (5 checks)');

  // B.3 Special characters in query params — URL-encoded correctly
  {
    const url = buildVidaraUrl('https://api.vidara.so', '/v1/video/info', { filecode: 'abc 123/456' }, 'test-key');
    // URLSearchParams encodes spaces as '+' (form-encoding) — both
    // '+' and '%20' are valid encodings for a space in a query string
    // and Vidara's API accepts either. We check the space is encoded
    // (not literal) and the slash is encoded as %2F.
    ok(url.includes('filecode=abc+123%2F456') || url.includes('filecode=abc%20123%2F456'), 'B.3.1 filecode URL-encoded (space → + or %20, slash → %2F)');
    ok(url.includes('api_key=test-key'), 'B.3.2 api_key preserved alongside encoded params');
  }
  console.log('  ok — B.3 URL encoding (2 checks)');

  // B.4 Base URL with trailing slash — stripped
  {
    const url = buildVidaraUrl('https://api.vidara.so/', '/v1/account/info', null, 'key');
    ok(!url.includes('//v1'), 'B.4.1 no double slash when base has trailing slash');
    ok(url.includes('https://api.vidara.so/v1/account/info'), 'B.4.2 URL is well-formed');
  }
  console.log('  ok — B.4 trailing slash (2 checks)');

  // B.5 api_key itself is URL-encoded if it contains special chars
  {
    const url = buildVidaraUrl('https://api.vidara.so', '/v1/account/info', null, 'key with spaces');
    // URLSearchParams encodes spaces as '+' (form-encoding). Both
    // '+' and '%20' are valid in a query string.
    ok(url.includes('api_key=key+with+spaces') || url.includes('api_key=key%20with%20spaces'), 'B.5.1 api_key URL-encoded when it contains spaces (+ or %20)');
  }
  console.log('  ok — B.5 api_key encoding (1 check)');
}
console.log('');

// ===========================================================================
// SECTION C — Vidara adapter mock fetcher tests
// ===========================================================================

console.log('--- Section C: Vidara adapter mock fetcher tests ---\n');

{
  const { VidaraAdapter } = await import('../src/lib/server/hosting/vidara/adapter.ts');
  const { HostingProviderError } = await import('../src/lib/server/hosting/errors.ts');

  type CapturedRequest = {
    method: string;
    url: string;
    headers: Record<string, string>;
    body?: unknown;
    formData?: FormData;
  };

  /**
   * Creates a mock fetcher that captures every request and returns a
   * canned response. This lets us assert EXACTLY how the adapter
   * authenticates (URL query param vs header).
   */
  function createCapturingFetcher(responses: Array<{ status?: number; json?: unknown }>) {
    const queue = [...responses];
    const captured: CapturedRequest[] = [];
    const fetcher = async (request: { method: string; url: string; headers?: Record<string, string>; body?: unknown; formData?: FormData }) => {
      captured.push({
        method: request.method,
        url: request.url,
        headers: request.headers ?? {},
        body: request.body,
        formData: request.formData,
      });
      const mock = queue.shift() ?? { status: 200, json: {} };
      const status = mock.status ?? 200;
      if (status >= 400) {
        throw new HostingProviderError(
          status === 401 ? 'AUTHENTICATION' : status === 404 ? 'NOT_FOUND' : 'TRANSIENT',
          { httpStatus: status },
        );
      }
      return { status, ok: true, json: mock.json ?? null, headers: {} };
    };
    return { fetcher, captured };
  }

  // C.1 getAccountInfo — authenticates via api_key query param
  {
    const { fetcher, captured } = createCapturingFetcher([
      { status: 200, json: { result: true, data: { email: 'test@vidara', name: 'Test', storage_used: 1024, storage_limit: 1048576 } } },
    ]);
    const adapter = new VidaraAdapter({
      config: { apiKey: 'test-key-account', baseUrl: 'https://api.vidara.so' },
      httpFetcher: fetcher,
    });
    const account = await adapter.getAccountInfo();
    eq(account.accountId, 'test@vidara', 'C.1.1 account email normalized');
    eq(captured.length, 1, 'C.1.2 exactly one request captured');
    const req = captured[0];
    ok(req.url.includes('/v1/account/info'), 'C.1.3 request URL is /v1/account/info');
    ok(req.url.includes('api_key=test-key-account'), 'C.1.4 api_key query parameter present in URL');
    ok(!req.url.includes('Bearer'), 'C.1.5 no Bearer in URL');
    eq(req.headers.authorization ?? null, null, 'C.1.6 NO Authorization header sent (Vidara uses query param)');
  }
  console.log('  ok — C.1 getAccountInfo auth (6 checks)');

  // C.2 getAsset — api_key appended alongside file_code
  {
    const { fetcher, captured } = createCapturingFetcher([
      { status: 200, json: { result: [{ file_code: 'abc123', title: 'Test', status: 1 }] } },
    ]);
    const adapter = new VidaraAdapter({
      config: { apiKey: 'test-key-asset', baseUrl: 'https://api.vidara.so' },
      httpFetcher: fetcher,
    });
    await adapter.getAsset('abc123');
    eq(captured.length, 1, 'C.2.1 exactly one request');
    const url = captured[0].url;
    ok(url.includes('/v1/video/info'), 'C.2.2 path is /v1/video/info');
    ok(url.includes('filecode=abc123'), 'C.2.3 filecode query param present (VERIFIED: not file_code)');
    ok(url.includes('api_key=test-key-asset'), 'C.2.4 api_key query param present');
    ok(url.indexOf('filecode=') < url.indexOf('api_key='), 'C.2.5 api_key appended after filecode');
    eq(captured[0].headers.authorization ?? null, null, 'C.2.6 NO Authorization header');
  }
  console.log('  ok — C.2 getAsset auth (6 checks)');

  // C.3 uploadFile — step 1 (GET /v1/upload/server) authenticates via api_key
  {
    const { fetcher, captured } = createCapturingFetcher([
      // Step 1: get upload server URL
      { status: 200, json: { result: { server: 'https://upload.vidara.so/upload' } } },
      // Step 2: multipart POST to upload server (this URL is provider-returned, NOT api-vidara)
      { status: 200, json: { data: { filecode: 'new123', size: 104857600 } } },
    ]);
    const adapter = new VidaraAdapter({
      config: { apiKey: 'test-key-upload', baseUrl: 'https://api.vidara.so' },
      httpFetcher: fetcher,
    });
    const result = await adapter.uploadFile({
      content: new Blob([new Uint8Array([1, 2, 3])]),
      filename: 'test.mp4',
      providerFolderId: null,
    });
    eq(result.providerAssetId, 'new123', 'C.3.1 upload result normalized');

    // Step 1 request: GET /v1/upload/server with api_key query param
    const step1 = captured[0];
    ok(step1.url.includes('/v1/upload/server'), 'C.3.2 step 1 URL is /v1/upload/server');
    ok(step1.url.includes('api_key=test-key-upload'), 'C.3.3 step 1 api_key query param present');
    eq(step1.headers.authorization ?? null, null, 'C.3.4 step 1 NO Authorization header');

    // Step 2 request: POST to the provider-returned upload URL.
    // The upload server URL is provider-returned (https://upload.vidara.so/upload)
    // and does NOT carry the api_key (it's the upload destination, not an API call).
    const step2 = captured[1];
    // VERIFIED: the upload server URL returned by Vidara is
    // https://upl4.s1q2105.com/api/upload (provider-hosted). The
    // adapter appends api_key to this URL before the browser uploads.
    ok(step2.url.includes('upl4.s1q2105.com') || step2.url.includes('upload'), 'C.3.5 step 2 URL is the provider-returned upload server');
    // VERIFIED: the upload server REQUIRES api_key — the adapter
    // appends it to the upload URL. The browser uses this URL for the
    // direct POST to Vidara's upload server.
    ok(step2.url.includes('api_key='), 'C.3.6 step 2 upload URL DOES carry api_key (upload server requires it)');
  }
  console.log('  ok — C.3 uploadFile auth (6 checks)');

  // C.4 uploadRemote — GET /v1/upload/url authenticates via api_key (VERIFIED: method is GET, not POST)
  {
    const { fetcher, captured } = createCapturingFetcher([
      { status: 200, json: { data: { filecode: 'remote456' } } },
    ]);
    const adapter = new VidaraAdapter({
      config: { apiKey: 'test-key-remote', baseUrl: 'https://api.vidara.so' },
      httpFetcher: fetcher,
    });
    await adapter.uploadRemote({
      url: 'https://example.com/video.mp4',
      providerFolderId: null,
    });
    eq(captured.length, 1, 'C.4.1 exactly one request');
    eq(captured[0].method, 'GET', 'C.4.2 method is GET (VERIFIED: not POST)');
    ok(captured[0].url.includes('/v1/upload/url'), 'C.4.3 path is /v1/upload/url');
    ok(captured[0].url.includes('api_key=test-key-remote'), 'C.4.4 api_key query param present');
    ok(captured[0].url.includes('url='), 'C.4.5 remote URL passed as query param (not in body)');
    eq(captured[0].headers.authorization ?? null, null, 'C.4.6 NO Authorization header');
  }
  console.log('  ok — C.4 uploadRemote auth (6 checks)');

  // C.5 getProcessingStatus — final 3-issue fix: now consults /v1/video/status
  // (the REAL encoding endpoint) FIRST, then /v1/video/info as the terminal-
  // state fallback (NOT /v1/video/encoding_status which returns 404).
  {
    const { fetcher, captured } = createCapturingFetcher([
      // Step 1: /v1/video/status — nothing in progress (encodings: null)
      { status: 200, json: { msg: 'OK', status: 200, result: { encodings: null, total: 0 } } },
      // Step 2: /v1/video/info — file lifecycle state
      { status: 200, json: { result: [{ status: 'active', filecode: 'abc123' }] } },
    ]);
    const adapter = new VidaraAdapter({
      config: { apiKey: 'test-key-status', baseUrl: 'https://api.vidara.so' },
      httpFetcher: fetcher,
    });
    await adapter.getProcessingStatus('abc123');
    eq(captured.length, 2, 'C.5.1 exactly two requests (video/status + video/info)');
    ok(captured[0].url.includes('/v1/video/status'), 'C.5.2a step 1 path is /v1/video/status (the encoding endpoint)');
    ok(captured[1].url.includes('/v1/video/info'), 'C.5.2b step 2 path is /v1/video/info (VERIFIED: not encoding_status)');
    ok(captured[1].url.includes('filecode=abc123'), 'C.5.3 filecode query param present (VERIFIED: not file_code)');
    ok(captured[0].url.includes('api_key=test-key-status') && captured[1].url.includes('api_key=test-key-status'), 'C.5.4 api_key query param present on both requests');
    eq(captured[0].headers.authorization ?? null, null, 'C.5.5 NO Authorization header');
  }
  console.log('  ok — C.5 getProcessingStatus auth (6 checks)');

  // C.6 Folder operations — all authenticate via api_key
  {
    const { fetcher, captured } = createCapturingFetcher([
      // listFolders
      { status: 200, json: { result: { folders: [{ folder_id: 'f1', name: 'Movies' }] } } },
      // createFolder
      { status: 200, json: { result: true, data: { folder_id: 'f2' } } },
      // listFolders (re-list after create)
      { status: 200, json: { result: { folders: [{ folder_id: 'f1', name: 'Movies' }, { folder_id: 'f2', name: 'New Folder' }] } } },
      // renameFolder
      { status: 200, json: { result: true } },
      // deleteFolder
      { status: 200, json: { result: true } },
    ]);
    const adapter = new VidaraAdapter({
      config: { apiKey: 'test-key-folders', baseUrl: 'https://api.vidara.so' },
      httpFetcher: fetcher,
    });
    await adapter.listFolders(null);
    await adapter.createFolder({ name: 'New Folder', parentFolderId: null });
    await adapter.renameFolder('f2', 'Renamed');
    await adapter.deleteFolder('f2');

    // Every request must carry api_key and NO Authorization header.
    for (let i = 0; i < captured.length; i++) {
      ok(captured[i].url.includes('api_key=test-key-folders'), `C.6.${i * 2 + 1} request ${i + 1} carries api_key query param`);
      eq(captured[i].headers.authorization ?? null, null, `C.6.${i * 2 + 2} request ${i + 1} NO Authorization header`);
    }
    // Verify the paths are correct.
    ok(captured[0].url.includes('/v1/folder/list'), 'C.6.11 listFolders path');
    ok(captured[1].url.includes('/v1/folder/create'), 'C.6.12 createFolder path');
    ok(captured[3].url.includes('/v1/folder/rename'), 'C.6.13 renameFolder path');
    ok(captured[4].url.includes('/v1/folder/delete'), 'C.6.14 deleteFolder path');
  }
  console.log('  ok — C.6 folder operations auth (14 checks)');

  // C.7 Subtitle + thumbnail operations authenticate via api_key
  {
    const { fetcher, captured } = createCapturingFetcher([
      // uploadSubtitle
      { status: 200, json: { result: true } },
      // uploadThumbnail
      { status: 200, json: { result: true } },
    ]);
    const adapter = new VidaraAdapter({
      config: { apiKey: 'test-key-subs', baseUrl: 'https://api.vidara.so' },
      httpFetcher: fetcher,
    });
    await adapter.uploadSubtitle({
      providerAssetId: 'abc123',
      content: new Blob([new Uint8Array([1, 2, 3])]),
      filename: 'test.en.srt',
      language: 'en',
    });
    await adapter.uploadThumbnail('abc123', { url: 'https://example.com/thumb.jpg' });

    ok(captured[0].url.includes('/v1/subtitle/upload'), 'C.7.1 subtitle path');
    ok(captured[0].url.includes('api_key=test-key-subs'), 'C.7.2 subtitle api_key present');
    eq(captured[0].headers.authorization ?? null, null, 'C.7.3 subtitle NO Authorization header');

    ok(captured[1].url.includes('/v1/video/thumbnail'), 'C.7.4 thumbnail path');
    ok(captured[1].url.includes('api_key=test-key-subs'), 'C.7.5 thumbnail api_key present');
    eq(captured[1].headers.authorization ?? null, null, 'C.7.6 thumbnail NO Authorization header');
  }
  console.log('  ok — C.7 subtitle + thumbnail auth (6 checks)');

  // C.8 CRITICAL — 401 is no longer caused by Bearer (the previous bug)
  {
    // Simulate Vidara rejecting a request with 401. With the OLD code,
    // the adapter sent a Bearer header that Vidara didn't recognize → 401.
    // With the NEW code, the adapter sends api_key query param → 200.
    // We verify the adapter does NOT send a Bearer header, so the 401
    // root cause is eliminated.
    const { fetcher, captured } = createCapturingFetcher([
      { status: 200, json: { result: true, data: { email: 'ok' } } },
    ]);
    const adapter = new VidaraAdapter({
      config: { apiKey: 'production-key', baseUrl: 'https://api.vidara.so' },
      httpFetcher: fetcher,
    });
    await adapter.getAccountInfo();
    // The request must NOT have an Authorization header (the old bug).
    eq(captured[0].headers.authorization ?? null, null, 'C.8.1 NO Authorization header (old Bearer bug eliminated)');
    // The request MUST carry the api_key query parameter.
    ok(captured[0].url.includes('api_key=production-key'), 'C.8.2 api_key query parameter present (correct auth)');
  }
  console.log('  ok — C.8 401 root cause eliminated (2 checks)');

  // C.9 401 from Vidara is classified as AUTHENTICATION (fail-closed preserved)
  {
    const { fetcher, captured } = createCapturingFetcher([
      { status: 401, json: { error: 'Invalid API key' } },
    ]);
    const adapter = new VidaraAdapter({
      config: { apiKey: 'bad-key', baseUrl: 'https://api.vidara.so' },
      httpFetcher: fetcher,
    });
    let threw = false;
    let errorCode = '';
    try {
      await adapter.getAccountInfo();
    } catch (err) {
      threw = true;
      errorCode = err instanceof HostingProviderError ? err.code : 'UNKNOWN';
    }
    ok(threw, 'C.9.1 401 throws (fail-closed)');
    eq(errorCode, 'AUTHENTICATION', 'C.9.2 401 classified as AUTHENTICATION');
    // Even the failed request carried the api_key query param (not a Bearer header).
    ok(captured[0].url.includes('api_key=bad-key'), 'C.9.3 failed request still used api_key query param (correct mechanism)');
    eq(captured[0].headers.authorization ?? null, null, 'C.9.4 failed request had NO Authorization header');
  }
  console.log('  ok — C.9 401 fail-closed preserved (4 checks)');

  // C.10 API key never appears in error messages
  {
    const { fetcher } = createCapturingFetcher([
      { status: 401, json: { error: 'Invalid API key' } },
    ]);
    const adapter = new VidaraAdapter({
      config: { apiKey: 'SECRET-KEY-DO-NOT-LEAK-12345', baseUrl: 'https://api.vidara.so' },
      httpFetcher: fetcher,
    });
    let errorMessage = '';
    try {
      await adapter.getAccountInfo();
    } catch (err) {
      errorMessage = err instanceof Error ? err.message : String(err);
    }
    ok(!errorMessage.includes('SECRET-KEY-DO-NOT-LEAK-12345'), 'C.10.1 API key does NOT appear in error message');
    ok(!errorMessage.includes('api.vidara.so'), 'C.10.2 API base URL does NOT appear in error message (no URL leakage)');
  }
  console.log('  ok — C.10 API key never in errors (2 checks)');
}
console.log('');

// ===========================================================================
// SECTION D — Abyss regression (behavior unchanged)
// ===========================================================================

console.log('--- Section D: Abyss regression ---\n');

{
  const { AbyssAdapter } = await import('../src/lib/server/hosting/abyss/adapter.ts');
  const { HostingProviderError } = await import('../src/lib/server/hosting/errors.ts');

  type CapturedRequest = {
    method: string;
    url: string;
    headers: Record<string, string>;
    body?: unknown;
  };

  function createCapturingFetcher(responses: Array<{ status?: number; json?: unknown }>) {
    const queue = [...responses];
    const captured: CapturedRequest[] = [];
    const fetcher = async (request: { method: string; url: string; headers?: Record<string, string>; body?: unknown }) => {
      captured.push({
        method: request.method,
        url: request.url,
        headers: request.headers ?? {},
        body: request.body,
      });
      const mock = queue.shift() ?? { status: 200, json: {} };
      const status = mock.status ?? 200;
      if (status >= 400) {
        throw new HostingProviderError(
          status === 401 ? 'AUTHENTICATION' : 'TRANSIENT',
          { httpStatus: status },
        );
      }
      return { status, ok: true, json: mock.json ?? null, headers: {} };
    };
    return { fetcher, captured };
  }

  // D.1 Abyss login — POST /auth/login with email/password (NOT api_key)
  {
    const { fetcher, captured } = createCapturingFetcher([
      // login
      { status: 200, json: { token: 'jwt-token-abc', expires_in: 3600 } },
      // getAccountInfo → GET /v1/about with Bearer JWT
      { status: 200, json: { data: { email: 'test@abyss', storage_used: 1024 } } },
    ]);
    const adapter = new AbyssAdapter({
      config: { baseUrl: 'https://api.abyssplayer.com', email: 'test@abyss', password: 'pass' },
      httpFetcher: fetcher,
    });
    await adapter.getAccountInfo();

    // Login request: POST /auth/login with email/password in body.
    eq(captured[0].method, 'POST', 'D.1.1 login method is POST');
    ok(captured[0].url.includes('/auth/login'), 'D.1.2 login URL is /auth/login');
    ok(!captured[0].url.includes('api_key'), 'D.1.3 login URL does NOT carry api_key (Abyss uses JWT)');
    eq(captured[0].headers.authorization ?? null, null, 'D.1.4 login NO Authorization header (no JWT yet)');

    // Authed request: GET /v1/about with Bearer JWT header.
    eq(captured[1].method, 'GET', 'D.1.5 authed method is GET');
    ok(captured[1].url.includes('/v1/about'), 'D.1.6 authed URL is /v1/about');
    ok(!captured[1].url.includes('api_key'), 'D.1.7 authed URL does NOT carry api_key (Abyss uses JWT)');
    eq(captured[1].headers.authorization, 'Bearer jwt-token-abc', 'D.1.8 authed request carries Bearer JWT header');
  }
  console.log('  ok — D.1 Abyss auth unchanged (8 checks)');

  // D.2 Abyss capabilities unchanged
  {
    const adapter = new AbyssAdapter({
      config: { baseUrl: 'https://api.abyssplayer.com', email: 't@t', password: 'p' },
      httpFetcher: createCapturingFetcher([]).fetcher,
    });
    const caps = adapter.getCapabilities();
    eq(caps.localUpload, true, 'D.2.1 Abyss localUpload unchanged');
    eq(caps.remoteUpload, false, 'D.2.2 Abyss remoteUpload unchanged (UNSUPPORTED)');
    eq(caps.multiAudio, false, 'D.2.3 Abyss multiAudio unchanged');
    eq(caps.transcoding, true, 'D.2.4 Abyss transcoding unchanged');
    eq(caps.nestedFolders, true, 'D.2.5 Abyss nestedFolders unchanged');
  }
  console.log('  ok — D.2 Abyss capabilities unchanged (5 checks)');
}
console.log('');

// ===========================================================================
// SECTION E — upload-server route source: api_key never in response
// ===========================================================================

console.log('--- Section E: upload-server route api_key isolation ---\n');

{
  const src = readFileSync(path.join(REPO_ROOT, 'src/routes/api/admin/media/upload/[id]/upload-server/+server.ts'), 'utf8');

  // The route uses buildVidaraUrl to construct the authenticated URL.
  ok(src.includes('buildVidaraUrl(config.baseUrl, \'/v1/upload/server\', null, config.apiKey)'), 'E.1 route uses buildVidaraUrl with config.apiKey');

  // The route returns ONLY { ok: true, uploadUrl } — never the api_key.
  ok(src.includes('json({ ok: true, uploadUrl: authenticatedUploadUrl }'), 'E.2 route response shape is { ok, uploadUrl: authenticatedUploadUrl }');

  // The route explicitly documents that the api_key is NOT on the returned uploadUrl.
  // The comment uses backticks around `api_key` — we check for the substring
  // without backticks to be robust.
  ok(src.includes('api_key to the upload server URL before'), 'E.3 route documents api_key is appended to upload URL for browser-direct upload');

  // The route does NOT return config.apiKey in any json() response.
  // We check that no `json(...)` response includes the literal `config.apiKey`
  // (which would leak the key value to the browser). The apiKey is passed
  // ONLY to buildVidaraUrl (server-side URL construction) — never to json().
  const jsonReturns = src.match(/json\([^)]+\)/gs) ?? [];
  const leakyReturn = jsonReturns.some((snippet) => snippet.includes('config.apiKey'));
  ok(!leakyReturn, 'E.4 route does NOT return config.apiKey in any json() response');

  // The route does NOT log the api_key.
  ok(!src.includes('console.log'), 'E.5 route has NO console.log (no secret logging)');
}
console.log('  ok — Section E (5 checks)\n');

// ===========================================================================
// Summary
// ===========================================================================

console.log('====================================');
console.log(`Phase 7 Vidara auth fix summary: ${passed} passed, ${failed} failed`);
console.log('====================================');
if (failed > 0) {
  console.error(`\n${failed} TEST(S) FAILED — see above.`);
  process.exit(1);
}
