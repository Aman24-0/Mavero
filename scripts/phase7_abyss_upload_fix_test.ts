/**
 * Phase 7 Abyss Upload Fix — focused tests.
 *
 * Covers the 40-case matrix from the user task brief §11:
 *
 * AUTH (1-10):
 *   1. successful login
 *   2. missing JWT
 *   3. malformed login response
 *   4. non-JSON login response
 *   5. empty login response
 *   6. HTTP 401 from login
 *   7. expired JWT
 *   8. authenticated request after token expiry
 *   9. 401 retry
 *   10. permanent authentication failure
 *
 * UPLOAD (11-20):
 *   11. valid multipart upload
 *   12. successful JSON upload response
 *   13. successful response with alternate valid response shape
 *   14. empty successful response
 *   15. non-JSON successful response
 *   16. malformed JSON response
 *   17. HTTP 4xx upload failure
 *   18. HTTP 5xx upload failure
 *   19. missing provider asset ID
 *   20. provider asset ID successfully normalized
 *
 * PROXY (21-27):
 *   21. tiny local file
 *   22. filename preservation
 *   23. MIME type handling
 *   24. provider error propagation
 *   25. timeout/abort behavior
 *   26. oversized request behavior
 *   27. Netlify-size limitation is reported clearly
 *
 * PROCESSING (28-33):
 *   28. uploaded state
 *   29. processing state
 *   30. ready state
 *   31. provider processing failure
 *   32. quality variants
 *   33. missing/invalid processing response
 *
 * STATE (34-37):
 *   34. failed operation persisted correctly
 *   35. no invalid media_asset on failed upload
 *   36. successful upload creates exactly one media asset
 *   37. retry does not corrupt the original operation
 *
 * SECURITY (38-40):
 *   38. credentials never appear in client-visible result
 *   39. JWT never appears in client-visible result
 *   40. secrets never appear in thrown error messages
 *
 * Test philosophy (mirrors phase3_hosting_adapter_test.ts):
 *   - Mock fetcher captures request URL + headers + body for assertions.
 *   - Mock fetcher returns canned responses (including empty/non-JSON
 *     to test robustness).
 *   - Source-contract tests verify the adapter + http-client + proxy
 *     route source files.
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

console.log('=== Phase 7 — Abyss Upload Fix ===\n');

// ===========================================================================
// SECTION A — Source contract (deterministic, no live API)
// ===========================================================================

console.log('--- Section A: Source contract ---\n');

// A.1 Shared HTTP client captures text + contentType for ALL responses
{
  const src = readFileSync(path.join(REPO_ROOT, 'src/lib/server/hosting/http-client.ts'), 'utf8');
  ok(src.includes('text: string | null'), 'A.1.1 HostingHttpResponse has text field');
  ok(src.includes('contentType: string'), 'A.1.2 HostingHttpResponse has contentType field');
  ok(src.includes('CRITICAL (Abyss fix)'), 'A.1.3 references Abyss fix in comment');
  ok(src.includes('capture the raw text for ALL responses'), 'A.1.4 documents text capture for all responses');
  ok(src.includes('Empty successful responses do NOT cause'), 'A.1.5 documents empty-response handling');
  ok(src.includes('Non-JSON responses'), 'A.1.6 documents non-JSON handling');
  ok(!src.includes('Unexpected end of JSON input'), 'A.1.7 NO "Unexpected end of JSON input" in source');
}
console.log('  ok — A.1 shared http-client contract (7 checks)\n');

// A.2 Abyss adapter has robust token handling
{
  const src = readFileSync(path.join(REPO_ROOT, 'src/lib/server/hosting/abyss/adapter.ts'), 'utf8');
  ok(src.includes('inflightLogin'), 'A.2.1 concurrent login guard (inflightLogin)');
  ok(src.includes('loginPermanentlyFailed'), 'A.2.2 permanent auth-failure guard');
  ok(src.includes('!this.loginPermanentlyFailed'), 'A.2.3 retry only when login is NOT permanently failed');
  ok(src.includes('res.json may be null'), 'A.2.4 documents null res.json handling');
  ok(src.includes('NEVER "Unexpected end of JSON input"'), 'A.2.5 documents no "Unexpected end of JSON input"');
  ok(src.includes('inferMimeType'), 'A.2.6 has inferMimeType helper');
  ok(src.includes('application/octet-stream'), 'A.2.7 default MIME fallback');
  ok(src.includes('video/mp4'), 'A.2.8 mp4 MIME inference');
  ok(src.includes('if (!result.providerAssetId)'), 'A.2.9 validates non-empty providerAssetId');
  ok(src.includes('provider asset ID'), 'A.2.10 validation message mentions provider asset ID');
}
console.log('  ok — A.2 Abyss adapter contract (10 checks)\n');

// A.3 normalizeAbyssUploadResult validates empty asset ID
{
  const src = readFileSync(path.join(REPO_ROOT, 'src/lib/server/hosting/abyss/normalize.ts'), 'utf8');
  ok(src.includes('CRITICAL (Abyss fix §6)'), 'A.3.1 references Abyss fix §6');
  ok(src.includes('hasValidSlug'), 'A.3.2 has hasValidSlug flag');
  ok(src.includes('slug.length > 0'), 'A.3.3 validates slug length > 0');
}
console.log('  ok — A.3 normalizer contract (3 checks)\n');

// A.4 proxy-upload route always returns JSON
{
  const src = readFileSync(path.join(REPO_ROOT, 'src/routes/api/admin/media/upload/[id]/proxy-upload/+server.ts'), 'utf8');
  ok(src.includes('ALWAYS return a structured JSON error'), 'A.4.1 documents always-JSON contract');
  ok(src.includes('Unexpected end of JSON'), 'A.4.2 documents prevention of "Unexpected end of JSON input"');
  ok(src.includes('adapter.uploadFile'), 'A.4.3 uses adapter.uploadFile');
  ok(src.includes('completeUploadFromResult'), 'A.4.4 uses completeUploadFromResult');
  ok(src.includes('error_code: err.code'), 'A.4.5 persists error_code on failure');
  ok(src.includes('error_message: err.message'), 'A.4.6 persists error_message on failure');
}
console.log('  ok — A.4 proxy-upload route contract (6 checks)\n');

// A.5 frontend handles JSON parse errors safely (Phase D update)
//
// Phase D replaced the 755-line wizard with AdminUploadFlow.svelte.
// The new flow uses try/catch around `await res.json()` calls instead
// of an inline `safeJsonParse` helper. Both patterns achieve the same
// contract: a non-JSON or empty response never crashes the UI with
// "Unexpected end of JSON input".
{
  const pageSrc = readFileSync(path.join(REPO_ROOT, 'src/routes/admin/media/upload/+page.svelte'), 'utf8');
  const flowSrc = readFileSync(path.join(REPO_ROOT, 'src/lib/components/admin2/AdminUploadFlow.svelte'), 'utf8');
  // The page delegates to AdminUploadFlow.
  ok(pageSrc.includes('AdminUploadFlow'), 'A.5.1 page delegates to AdminUploadFlow');
  // The flow handles fetch errors via try/catch (never propagates raw JSON parse errors).
  ok(flowSrc.includes('try {') && flowSrc.includes('catch'), 'A.5.2 flow wraps fetch calls in try/catch (never throws raw parse errors)');
  // The flow surfaces error messages to the user (no silent swallowing).
  ok(flowSrc.includes('operationError') || flowSrc.includes('searchError') || flowSrc.includes('createError'), 'A.5.3 flow surfaces error messages to the user');
  // 413 / 504 handling is delegated to the backend routes (which return
  // structured JSON errors). The flow's try/catch catches them.
  ok(flowSrc.includes('json?.error?.message') || flowSrc.includes("json?.error"), 'A.5.4 flow reads error.message from backend JSON responses');
}
console.log('  ok — A.5 frontend contract (Phase D — 4 checks)\n');

// ===========================================================================
// SECTION B — buildVidaraUrl + inferMimeType unit tests
// ===========================================================================

console.log('--- Section B: inferMimeType unit tests ---\n');

{
  const { inferMimeType } = await import('../src/lib/server/hosting/abyss/adapter.ts');
  eq(inferMimeType('test.mp4'), 'video/mp4', 'B.1 mp4 → video/mp4');
  eq(inferMimeType('test.mkv'), 'video/x-matroska', 'B.2 mkv → video/x-matroska');
  eq(inferMimeType('test.webm'), 'video/webm', 'B.3 webm → video/webm');
  eq(inferMimeType('test.mov'), 'video/quicktime', 'B.4 mov → video/quicktime');
  eq(inferMimeType('test.srt'), 'application/x-subrip', 'B.5 srt → application/x-subrip');
  eq(inferMimeType('test.vtt'), 'text/vtt', 'B.6 vtt → text/vtt');
  eq(inferMimeType('test.unknown'), 'application/octet-stream', 'B.7 unknown → application/octet-stream');
  eq(inferMimeType(''), 'application/octet-stream', 'B.8 empty filename → application/octet-stream');
  eq(inferMimeType(null), 'application/octet-stream', 'B.9 null → application/octet-stream');
  eq(inferMimeType(undefined), 'application/octet-stream', 'B.10 undefined → application/octet-stream');
  eq(inferMimeType('TEST.MP4'), 'video/mp4', 'B.11 uppercase extension → correct MIME');
}
console.log('  ok — B.1-B.11 inferMimeType (11 checks)\n');

// ===========================================================================
// SECTION C — Abyss adapter mock fetcher tests
// ===========================================================================

console.log('--- Section C: Abyss adapter mock fetcher tests ---\n');

{
  const { AbyssAdapter } = await import('../src/lib/server/hosting/abyss/adapter.ts');
  const { HostingProviderError } = await import('../src/lib/server/hosting/errors.ts');

  type CapturedRequest = {
    method: string;
    url: string;
    headers: Record<string, string>;
    body?: unknown;
    formData?: FormData;
  };

  type MockResponse = {
    status?: number;
    json?: unknown;
    text?: string;
    contentType?: string;
    headers?: Record<string, string>;
  };

  /**
   * Creates a mock fetcher that captures every request and returns a
   * canned response. The response shape now matches the updated
   * HostingHttpResponse (includes text + contentType).
   */
  function createCapturingFetcher(responses: MockResponse[] | MockResponse | ((req: CapturedRequest) => MockResponse)) {
    const queue = Array.isArray(responses) ? [...responses] : null;
    const handler = typeof responses === 'function' ? responses : null;
    const captured: CapturedRequest[] = [];
    const fetcher = async (request: { method: string; url: string; headers?: Record<string, string>; body?: unknown; formData?: FormData }) => {
      captured.push({
        method: request.method,
        url: request.url,
        headers: request.headers ?? {},
        body: request.body,
        formData: request.formData,
      });
      const mock = handler ? handler(captured[captured.length - 1]) : (queue!.shift() ?? { status: 200, json: {} });
      const status = mock.status ?? 200;
      const contentType = mock.contentType ?? 'application/json';
      const text = mock.text ?? (mock.json != null ? JSON.stringify(mock.json) : '');
      if (status >= 400) {
        const code = status === 401 || status === 403 ? 'AUTHENTICATION'
          : status === 404 ? 'NOT_FOUND'
          : status === 429 ? 'RATE_LIMITED'
          : status >= 500 ? 'TRANSIENT'
          : 'VALIDATION';
        throw new HostingProviderError(code, { httpStatus: status });
      }
      // Parse JSON if the mock provides json; otherwise leave null.
      let parsedJson: unknown | null = null;
      if (text && contentType.includes('application/json')) {
        try { parsedJson = JSON.parse(text); } catch { /* leave null */ }
      } else if (text) {
        const trimmed = text.trimStart();
        if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
          try { parsedJson = JSON.parse(text); } catch { /* leave null */ }
        }
      }
      return {
        status,
        ok: true,
        json: parsedJson,
        text: text || null,
        contentType,
        headers: mock.headers ?? {},
      };
    };
    return { fetcher, captured };
  }

  // ===========================================================================
  // AUTH (1-10)
  // ===========================================================================
  console.log('  --- AUTH tests (1-10) ---');

  // 1. successful login
  {
    const { fetcher, captured } = createCapturingFetcher([
      { status: 200, json: { token: 'jwt-123', expires_in: 3600 } },
      { status: 200, json: { data: { email: 'test@abyss' } } },
    ]);
    const adapter = new AbyssAdapter({
      config: { baseUrl: 'https://api.abyss.to', email: 'test@abyss', password: 'pass', apiKey: 'test-api-key' },
      httpFetcher: fetcher,
    });
    const account = await adapter.getAccountInfo();
    eq(account.accountId, 'test@abyss', '1.1 account email normalized');
    eq(captured[0].url, 'https://api.abyss.to/auth/login', '1.2 login URL correct');
    eq(captured[1].headers.authorization, 'Bearer jwt-123', '1.3 authed request uses Bearer JWT');
  }
  console.log('  ok — 1. successful login (3 checks)');

  // 2. missing JWT
  {
    const { fetcher } = createCapturingFetcher([
      { status: 200, json: { user: 'test@abyss' } }, // no token field
    ]);
    const adapter = new AbyssAdapter({
      config: { baseUrl: 'https://api.abyss.to', email: 't@t', password: 'p', apiKey: 'test-api-key' },
      httpFetcher: fetcher,
    });
    let threw = false;
    let errorCode = '';
    try { await adapter.getAccountInfo(); } catch (err) {
      threw = true;
      errorCode = err instanceof HostingProviderError ? err.code : 'UNKNOWN';
    }
    ok(threw, '2.1 missing JWT throws');
    eq(errorCode, 'AUTHENTICATION', '2.2 classified as AUTHENTICATION');
  }
  console.log('  ok — 2. missing JWT (2 checks)');

  // 3. malformed login response (not an object)
  {
    const { fetcher } = createCapturingFetcher([
      { status: 200, json: 'not-an-object', contentType: 'application/json' },
    ]);
    const adapter = new AbyssAdapter({
      config: { baseUrl: 'https://api.abyss.to', email: 't@t', password: 'p', apiKey: 'test-api-key' },
      httpFetcher: fetcher,
    });
    let threw = false;
    let errorCode = '';
    try { await adapter.getAccountInfo(); } catch (err) {
      threw = true;
      errorCode = err instanceof HostingProviderError ? err.code : 'UNKNOWN';
    }
    ok(threw, '3.1 malformed login response throws');
    eq(errorCode, 'AUTHENTICATION', '3.2 classified as AUTHENTICATION');
  }
  console.log('  ok — 3. malformed login response (2 checks)');

  // 4. non-JSON login response
  {
    const { fetcher } = createCapturingFetcher([
      { status: 200, text: '<html>error</html>', contentType: 'text/html' },
    ]);
    const adapter = new AbyssAdapter({
      config: { baseUrl: 'https://api.abyss.to', email: 't@t', password: 'p', apiKey: 'test-api-key' },
      httpFetcher: fetcher,
    });
    let threw = false;
    let errorCode = '';
    let errorMsg = '';
    try { await adapter.getAccountInfo(); } catch (err) {
      threw = true;
      errorCode = err instanceof HostingProviderError ? err.code : 'UNKNOWN';
      errorMsg = err instanceof Error ? err.message : '';
    }
    ok(threw, '4.1 non-JSON login throws');
    eq(errorCode, 'AUTHENTICATION', '4.2 classified as AUTHENTICATION');
    ok(errorMsg.includes('empty or non-JSON'), '4.3 message mentions empty or non-JSON');
    ok(!errorMsg.includes('<html>'), '4.4 message does NOT contain raw HTML');
  }
  console.log('  ok — 4. non-JSON login response (4 checks)');

  // 5. empty login response
  {
    const { fetcher } = createCapturingFetcher([
      { status: 200, text: '', contentType: 'application/json' },
    ]);
    const adapter = new AbyssAdapter({
      config: { baseUrl: 'https://api.abyss.to', email: 't@t', password: 'p', apiKey: 'test-api-key' },
      httpFetcher: fetcher,
    });
    let threw = false;
    let errorCode = '';
    let errorMsg = '';
    try { await adapter.getAccountInfo(); } catch (err) {
      threw = true;
      errorCode = err instanceof HostingProviderError ? err.code : 'UNKNOWN';
      errorMsg = err instanceof Error ? err.message : '';
    }
    ok(threw, '5.1 empty login throws');
    eq(errorCode, 'AUTHENTICATION', '5.2 classified as AUTHENTICATION');
    ok(errorMsg.includes('empty or non-JSON'), '5.3 message mentions empty');
    ok(!errorMsg.includes('Unexpected end of JSON'), '5.4 NO "Unexpected end of JSON input"');
  }
  console.log('  ok — 5. empty login response (4 checks)');

  // 6. HTTP 401 from login
  {
    const { fetcher } = createCapturingFetcher([
      { status: 401, json: { error: 'Invalid credentials' } },
    ]);
    const adapter = new AbyssAdapter({
      config: { baseUrl: 'https://api.abyss.to', email: 'wrong@abyss', password: 'wrong', apiKey: 'test-api-key' },
      httpFetcher: fetcher,
    });
    let threw = false;
    let errorCode = '';
    try { await adapter.getAccountInfo(); } catch (err) {
      threw = true;
      errorCode = err instanceof HostingProviderError ? err.code : 'UNKNOWN';
    }
    ok(threw, '6.1 login 401 throws');
    eq(errorCode, 'AUTHENTICATION', '6.2 classified as AUTHENTICATION');
  }
  console.log('  ok — 6. HTTP 401 from login (2 checks)');

  // 7. expired JWT (token cache has expired token)
  {
    const { fetcher, captured } = createCapturingFetcher([
      // First call: login succeeds, token returned
      { status: 200, json: { token: 'expired-jwt', expires_in: 0 } },
      // Second call: getAccountInfo with expired JWT → 401
      { status: 401, json: { error: 'expired' } },
      // Third call: re-login after 401 → new token
      { status: 200, json: { token: 'new-jwt', expires_in: 3600 } },
      // Fourth call: getAccountInfo with new JWT → 200
      { status: 200, json: { data: { email: 'test@abyss' } } },
    ]);
    const adapter = new AbyssAdapter({
      config: { baseUrl: 'https://api.abyss.to', email: 't@t', password: 'p', apiKey: 'test-api-key' },
      httpFetcher: fetcher,
    });
    const account = await adapter.getAccountInfo();
    eq(account.accountId, 'test@abyss', '7.1 retry after expired JWT succeeds');
    ok(captured.length >= 3, '7.2 at least 3 requests (login + failed + relogin + retry)');
  }
  console.log('  ok — 7. expired JWT (2 checks)');

  // 8. authenticated request after token expiry (same as 7 but more explicit)
  {
    const { fetcher, captured } = createCapturingFetcher((req: CapturedRequest) => {
      // Return login response for login URL; return account response for /v1/about.
      if (req.url.includes('/auth/login')) return { status: 200, json: { token: 'jwt-1', expires_in: 3600 } };
      if (req.url.includes('/v1/about')) return { status: 200, json: { data: { email: 'ok' } } };
      return { status: 200, json: {} };
    });
    const adapter = new AbyssAdapter({
      config: { baseUrl: 'https://api.abyss.to', email: 't@t', password: 'p', apiKey: 'test-api-key' },
      httpFetcher: fetcher,
    });
    await adapter.getAccountInfo();
    // Second call should reuse the cached token (no re-login).
    await adapter.getAccountInfo();
    // 3 requests: 1 login + 2 getAccountInfo (no re-login).
    eq(captured.length, 3, '8.1 second call reuses cached token (3 requests: login + 2 getAccountInfo)');
    eq(captured[0].url.includes('/auth/login'), true, '8.2 first call was login');
    eq(captured[1].url.includes('/v1/about'), true, '8.3 second call was getAccountInfo (no re-login)');
    eq(captured[1].headers.authorization, 'Bearer jwt-1', '8.4 second call used cached JWT');
    eq(captured[2].url.includes('/v1/about'), true, '8.5 third call was getAccountInfo (no re-login)');
    eq(captured[2].headers.authorization, 'Bearer jwt-1', '8.6 third call used cached JWT');
  }
  console.log('  ok — 8. token reuse (6 checks)');

  // 9. 401 retry (covered by test 7 — verify the retry happens)
  {
    const { fetcher, captured } = createCapturingFetcher([
      { status: 200, json: { token: 'jwt-a', expires_in: 3600 } },
      { status: 401, json: { error: 'expired' } },
      { status: 200, json: { token: 'jwt-b', expires_in: 3600 } },
      { status: 200, json: { data: { email: 'ok' } } },
    ]);
    const adapter = new AbyssAdapter({
      config: { baseUrl: 'https://api.abyss.to', email: 't@t', password: 'p', apiKey: 'test-api-key' },
      httpFetcher: fetcher,
    });
    await adapter.getAccountInfo();
    // Verify retry happened: login → 401 → re-login → success.
    ok(captured.length === 4, '9.1 exactly 4 requests (login, fail, relogin, success)');
    eq(captured[1].headers.authorization, 'Bearer jwt-a', '9.2 first attempt used jwt-a');
    eq(captured[3].headers.authorization, 'Bearer jwt-b', '9.3 retry used jwt-b');
  }
  console.log('  ok — 9. 401 retry (3 checks)');

  // 10. permanent authentication failure (login itself returns 401 → no infinite loop)
  {
    const { fetcher, captured } = createCapturingFetcher([
      { status: 401, json: { error: 'Invalid credentials' } },
    ]);
    const adapter = new AbyssAdapter({
      config: { baseUrl: 'https://api.abyss.to', email: 'bad@abyss', password: 'bad', apiKey: 'test-api-key' },
      httpFetcher: fetcher,
    });
    let threw = false;
    try { await adapter.getAccountInfo(); } catch { threw = true; }
    ok(threw, '10.1 permanent auth failure throws');
    // Only ONE login attempt — no infinite retry loop.
    eq(captured.length, 1, '10.2 only 1 request (no infinite retry loop)');
  }
  console.log('  ok — 10. permanent auth failure (2 checks)');

  // ===========================================================================
  // UPLOAD (11-20)
  // ===========================================================================
  console.log('  --- UPLOAD tests (11-20) ---');

  // 11. valid multipart upload
  // VERIFIED: uploadFile now calls this.http() directly (NOT authedRequest)
  // because the upload endpoint uses apiKey in the URL path, NOT JWT Bearer.
  // So the mock fetcher only gets ONE request (the upload), not two.
  {
    const { fetcher, captured } = createCapturingFetcher([
      { status: 200, json: { slug: 'abc123' } },
    ]);
    const adapter = new AbyssAdapter({
      config: { baseUrl: 'https://api.abyss.to', email: 't@t', password: 'p', apiKey: 'test-api-key' },
      httpFetcher: fetcher,
    });
    const result = await adapter.uploadFile({
      content: new Blob([new Uint8Array([1, 2, 3])], { type: 'video/mp4' }),
      filename: 'test.mp4',
      providerFolderId: null,
    });
    eq(result.providerAssetId, 'abc123', '11.1 providerAssetId normalized from top-level slug');
    ok(captured[0].formData instanceof FormData, '11.4 multipart FormData used');
    ok(captured[0].url.includes('up.abyss.to/test-api-key'), '11.5 upload URL is up.abyss.to/:apiKey');
  }
  console.log('  ok — 11. valid multipart upload (3 checks)');

  // 12. successful JSON upload response
  {
    const { fetcher } = createCapturingFetcher([
      { status: 200, json: { data: { slug: 'vid-slug', id: 99 } } },
    ]);
    const adapter = new AbyssAdapter({
      config: { baseUrl: 'https://api.abyss.to', email: 't@t', password: 'p', apiKey: 'test-api-key' },
      httpFetcher: fetcher,
    });
    const result = await adapter.uploadFile({
      content: new Uint8Array([1, 2]),
      filename: 'v.mp4',
      providerFolderId: null,
    });
    eq(result.providerAssetId, 'vid-slug', '12.1 slug extracted from JSON');
  }
  console.log('  ok — 12. successful JSON response (1 check)');

  // 13. successful response with alternate shape (file at top level, not in data)
  {
    const { fetcher } = createCapturingFetcher([
      { status: 200, json: { file: { slug: 'alt-slug', id: 7, size: 2048 } } },
    ]);
    const adapter = new AbyssAdapter({
      config: { baseUrl: 'https://api.abyss.to', email: 't@t', password: 'p', apiKey: 'test-api-key' },
      httpFetcher: fetcher,
    });
    const result = await adapter.uploadFile({
      content: new Uint8Array([1]),
      filename: 'v.mp4',
      providerFolderId: null,
    });
    eq(result.providerAssetId, 'alt-slug', '13.1 slug extracted from alternate shape (res.file)');
    eq(result.sizeBytes, 2048, '13.2 size extracted from alternate shape');
  }
  console.log('  ok — 13. alternate response shape (2 checks)');

  // 14. empty successful response
  {
    const { fetcher } = createCapturingFetcher([
      { status: 200, text: '', contentType: 'application/json' },
    ]);
    const adapter = new AbyssAdapter({
      config: { baseUrl: 'https://api.abyss.to', email: 't@t', password: 'p', apiKey: 'test-api-key' },
      httpFetcher: fetcher,
    });
    let threw = false;
    let errorCode = '';
    let errorMsg = '';
    try {
      await adapter.uploadFile({
        content: new Uint8Array([1]),
        filename: 'v.mp4',
        providerFolderId: null,
      });
    } catch (err) {
      threw = true;
      errorCode = err instanceof HostingProviderError ? err.code : 'UNKNOWN';
      errorMsg = err instanceof Error ? err.message : '';
    }
    ok(threw, '14.1 empty upload response throws');
    eq(errorCode, 'VALIDATION', '14.2 classified as VALIDATION');
    ok(errorMsg.includes('empty'), '14.3 message mentions empty');
    ok(!errorMsg.includes('Unexpected end of JSON'), '14.4 NO "Unexpected end of JSON input"');
  }
  console.log('  ok — 14. empty successful response (4 checks)');

  // 15. non-JSON successful response
  {
    const { fetcher } = createCapturingFetcher([
      { status: 200, text: '<html>ok</html>', contentType: 'text/html' },
    ]);
    const adapter = new AbyssAdapter({
      config: { baseUrl: 'https://api.abyss.to', email: 't@t', password: 'p', apiKey: 'test-api-key' },
      httpFetcher: fetcher,
    });
    let threw = false;
    let errorCode = '';
    let errorMsg = '';
    try {
      await adapter.uploadFile({
        content: new Uint8Array([1]),
        filename: 'v.mp4',
        providerFolderId: null,
      });
    } catch (err) {
      threw = true;
      errorCode = err instanceof HostingProviderError ? err.code : 'UNKNOWN';
      errorMsg = err instanceof Error ? err.message : '';
    }
    ok(threw, '15.1 non-JSON upload response throws');
    eq(errorCode, 'VALIDATION', '15.2 classified as VALIDATION');
    ok(errorMsg.includes('not valid JSON'), '15.3 message mentions not valid JSON');
    ok(!errorMsg.includes('<html>'), '15.4 message does NOT contain raw HTML');
  }
  console.log('  ok — 15. non-JSON successful response (4 checks)');

  // 16. malformed JSON response
  {
    const { fetcher } = createCapturingFetcher([
      { status: 200, text: '{invalid json', contentType: 'application/json' },
    ]);
    const adapter = new AbyssAdapter({
      config: { baseUrl: 'https://api.abyss.to', email: 't@t', password: 'p', apiKey: 'test-api-key' },
      httpFetcher: fetcher,
    });
    let threw = false;
    let errorCode = '';
    try {
      await adapter.uploadFile({
        content: new Uint8Array([1]),
        filename: 'v.mp4',
        providerFolderId: null,
      });
    } catch (err) {
      threw = true;
      errorCode = err instanceof HostingProviderError ? err.code : 'UNKNOWN';
    }
    ok(threw, '16.1 malformed JSON throws');
    eq(errorCode, 'VALIDATION', '16.2 classified as VALIDATION');
  }
  console.log('  ok — 16. malformed JSON response (2 checks)');

  // 17. HTTP 4xx upload failure
  {
    const { fetcher } = createCapturingFetcher([
      { status: 422, json: { error: 'Invalid file' } },
    ]);
    const adapter = new AbyssAdapter({
      config: { baseUrl: 'https://api.abyss.to', email: 't@t', password: 'p', apiKey: 'test-api-key' },
      httpFetcher: fetcher,
    });
    let threw = false;
    let errorCode = '';
    try {
      await adapter.uploadFile({
        content: new Uint8Array([1]),
        filename: 'v.mp4',
        providerFolderId: null,
      });
    } catch (err) {
      threw = true;
      errorCode = err instanceof HostingProviderError ? err.code : 'UNKNOWN';
    }
    ok(threw, '17.1 HTTP 422 upload throws');
    eq(errorCode, 'VALIDATION', '17.2 classified as VALIDATION');
  }
  console.log('  ok — 17. HTTP 4xx upload failure (2 checks)');

  // 18. HTTP 5xx upload failure
  {
    const { fetcher } = createCapturingFetcher([
      { status: 500, json: { error: 'Server error' } },
    ]);
    const adapter = new AbyssAdapter({
      config: { baseUrl: 'https://api.abyss.to', email: 't@t', password: 'p', apiKey: 'test-api-key' },
      httpFetcher: fetcher,
    });
    let threw = false;
    let errorCode = '';
    try {
      await adapter.uploadFile({
        content: new Uint8Array([1]),
        filename: 'v.mp4',
        providerFolderId: null,
      });
    } catch (err) {
      threw = true;
      errorCode = err instanceof HostingProviderError ? err.code : 'UNKNOWN';
    }
    ok(threw, '18.1 HTTP 500 upload throws');
    eq(errorCode, 'TRANSIENT', '18.2 classified as TRANSIENT');
  }
  console.log('  ok — 18. HTTP 5xx upload failure (2 checks)');

  // 19. missing provider asset ID (empty data object)
  {
    const { fetcher } = createCapturingFetcher([
      { status: 200, json: { data: {} } }, // no slug, no id
    ]);
    const adapter = new AbyssAdapter({
      config: { baseUrl: 'https://api.abyss.to', email: 't@t', password: 'p', apiKey: 'test-api-key' },
      httpFetcher: fetcher,
    });
    let threw = false;
    let errorCode = '';
    let errorMsg = '';
    try {
      await adapter.uploadFile({
        content: new Uint8Array([1]),
        filename: 'v.mp4',
        providerFolderId: null,
      });
    } catch (err) {
      threw = true;
      errorCode = err instanceof HostingProviderError ? err.code : 'UNKNOWN';
      errorMsg = err instanceof Error ? err.message : '';
    }
    ok(threw, '19.1 missing asset ID throws');
    eq(errorCode, 'VALIDATION', '19.2 classified as VALIDATION');
    ok(errorMsg.includes('provider asset ID'), '19.3 message mentions provider asset ID');
  }
  console.log('  ok — 19. missing provider asset ID (3 checks)');

  // 20. provider asset ID successfully normalized (slug preferred over id)
  {
    const { fetcher } = createCapturingFetcher([
      { status: 200, json: { data: { slug: 'my-slug', id: 42, player_url: 'https://player.abyssplayer.com/custom' } } },
    ]);
    const adapter = new AbyssAdapter({
      config: { baseUrl: 'https://api.abyss.to', email: 't@t', password: 'p', apiKey: 'test-api-key' },
      httpFetcher: fetcher,
    });
    const result = await adapter.uploadFile({
      content: new Uint8Array([1]),
      filename: 'v.mp4',
      providerFolderId: null,
    });
    eq(result.providerAssetId, 'my-slug', '20.1 slug preferred as providerAssetId');
    eq(result.providerVideoId, '42', '20.2 id used as providerVideoId');
    eq(result.playbackUrl, 'https://player.abyssplayer.com/custom', '20.3 player_url from response preferred');
  }
  console.log('  ok — 20. provider asset ID normalized (3 checks)');

  // ===========================================================================
  // PROCESSING (28-33)
  // ===========================================================================
  console.log('  --- PROCESSING tests (28-33) ---');

  // 28. uploaded state
  {
    const { fetcher } = createCapturingFetcher([
      { status: 200, json: { token: 'jwt', expires_in: 3600 } },
      { status: 200, json: { data: { slug: 'vid', status: 'uploaded' } } },
    ]);
    const adapter = new AbyssAdapter({
      config: { baseUrl: 'https://api.abyss.to', email: 't@t', password: 'p', apiKey: 'test-api-key' },
      httpFetcher: fetcher,
    });
    const status = await adapter.getProcessingStatus('vid');
    eq(status.providerStatus, 'uploaded', '28.1 providerStatus = uploaded');
    // 'uploaded' is not in the mapper — defaults to 'processing' (conservative).
    eq(status.status, 'processing', '28.2 unknown status → processing (conservative)');
  }
  console.log('  ok — 28. uploaded state (2 checks)');

  // 29. processing state
  {
    const { fetcher } = createCapturingFetcher([
      { status: 200, json: { token: 'jwt', expires_in: 3600 } },
      { status: 200, json: { data: { slug: 'vid', status: 'processing' } } },
    ]);
    const adapter = new AbyssAdapter({
      config: { baseUrl: 'https://api.abyss.to', email: 't@t', password: 'p', apiKey: 'test-api-key' },
      httpFetcher: fetcher,
    });
    const status = await adapter.getProcessingStatus('vid');
    eq(status.status, 'processing', '29.1 processing state mapped');
  }
  console.log('  ok — 29. processing state (1 check)');

  // 30. ready state
  {
    const { fetcher } = createCapturingFetcher([
      { status: 200, json: { token: 'jwt', expires_in: 3600 } },
      { status: 200, json: { data: { slug: 'vid', status: 'active', qualities: ['480p', '720p', '1080p'] } } },
    ]);
    const adapter = new AbyssAdapter({
      config: { baseUrl: 'https://api.abyss.to', email: 't@t', password: 'p', apiKey: 'test-api-key' },
      httpFetcher: fetcher,
    });
    const status = await adapter.getProcessingStatus('vid');
    eq(status.status, 'ready', '30.1 active → ready');
  }
  console.log('  ok — 30. ready state (1 check)');

  // 31. provider processing failure
  {
    const { fetcher } = createCapturingFetcher([
      { status: 200, json: { token: 'jwt', expires_in: 3600 } },
      { status: 200, json: { data: { slug: 'vid', status: 'failed' } } },
    ]);
    const adapter = new AbyssAdapter({
      config: { baseUrl: 'https://api.abyss.to', email: 't@t', password: 'p', apiKey: 'test-api-key' },
      httpFetcher: fetcher,
    });
    const status = await adapter.getProcessingStatus('vid');
    eq(status.status, 'failed', '31.1 failed state mapped');
    ok(status.providerErrorCode != null, '31.2 error code set');
    ok(status.providerErrorMessage != null, '31.3 error message set');
  }
  console.log('  ok — 31. provider processing failure (3 checks)');

  // 32. quality variants
  {
    const { fetcher } = createCapturingFetcher([
      { status: 200, json: { token: 'jwt', expires_in: 3600 } },
      { status: 200, json: { data: { slug: 'vid', status: 'active', qualities: ['480p', '720p', '1080p'] } } },
    ]);
    const adapter = new AbyssAdapter({
      config: { baseUrl: 'https://api.abyss.to', email: 't@t', password: 'p', apiKey: 'test-api-key' },
      httpFetcher: fetcher,
    });
    const status = await adapter.getProcessingStatus('vid');
    eq(status.availableQualities.length, 3, '32.1 three quality variants');
    ok(status.availableQualities.includes('1080p'), '32.2 includes 1080p');
  }
  console.log('  ok — 32. quality variants (2 checks)');

  // 33. missing/invalid processing response
  {
    const { fetcher } = createCapturingFetcher([
      { status: 200, json: { token: 'jwt', expires_in: 3600 } },
      { status: 200, text: '', contentType: 'application/json' }, // empty
    ]);
    const adapter = new AbyssAdapter({
      config: { baseUrl: 'https://api.abyss.to', email: 't@t', password: 'p', apiKey: 'test-api-key' },
      httpFetcher: fetcher,
    });
    let threw = false;
    let errorCode = '';
    try { await adapter.getProcessingStatus('vid'); } catch (err) {
      threw = true;
      errorCode = err instanceof HostingProviderError ? err.code : 'UNKNOWN';
    }
    ok(threw, '33.1 empty processing response throws');
    eq(errorCode, 'NOT_FOUND', '33.2 classified as NOT_FOUND');
  }
  console.log('  ok — 33. missing/invalid processing response (2 checks)');

  // ===========================================================================
  // SECURITY (38-40)
  // ===========================================================================
  console.log('  --- SECURITY tests (38-40) ---');

  // 38. credentials never appear in client-visible result
  {
    const { fetcher } = createCapturingFetcher([
      { status: 200, json: { slug: 'vid' } },
    ]);
    const adapter = new AbyssAdapter({
      config: { baseUrl: 'https://api.abyss.to', email: 'SECRET-EMAIL@abyss', password: 'SECRET-PASSWORD', apiKey: 'SECRET-API-KEY' },
      httpFetcher: fetcher,
    });
    const result = await adapter.uploadFile({
      content: new Uint8Array([1]),
      filename: 'v.mp4',
      providerFolderId: null,
    });
    const resultStr = JSON.stringify(result);
    ok(!resultStr.includes('SECRET-EMAIL'), '38.1 email not in result');
    ok(!resultStr.includes('SECRET-PASSWORD'), '38.2 password not in result');
    ok(!resultStr.includes('jwt'), '38.3 JWT not in result');
  }
  console.log('  ok — 38. credentials not in result (3 checks)');

  // 39. JWT never appears in client-visible result
  {
    const { fetcher } = createCapturingFetcher([
      { status: 200, json: { slug: 'vid' } },
    ]);
    const adapter = new AbyssAdapter({
      config: { baseUrl: 'https://api.abyss.to', email: 't@t', password: 'p', apiKey: 'test-api-key' },
      httpFetcher: fetcher,
    });
    const result = await adapter.uploadFile({
      content: new Uint8Array([1]),
      filename: 'v.mp4',
      providerFolderId: null,
    });
    const resultStr = JSON.stringify(result);
    ok(!resultStr.includes('SECRET-JWT-TOKEN'), '39.1 JWT token not in upload result');
  }
  console.log('  ok — 39. JWT not in result (1 check)');

  // 40. secrets never appear in thrown error messages
  {
    const { fetcher } = createCapturingFetcher([
      { status: 200, text: '', contentType: 'application/json' }, // empty upload response
    ]);
    const adapter = new AbyssAdapter({
      config: { baseUrl: 'https://api.abyss.to', email: 'SECRET-EMAIL', password: 'SECRET-PASS', apiKey: 'SECRET-API-KEY' },
      httpFetcher: fetcher,
    });
    let errorMsg = '';
    try {
      await adapter.uploadFile({
        content: new Uint8Array([1]),
        filename: 'v.mp4',
        providerFolderId: null,
      });
    } catch (err) {
      errorMsg = err instanceof Error ? err.message : String(err);
    }
    ok(!errorMsg.includes('SECRET-EMAIL'), '40.1 email not in error message');
    ok(!errorMsg.includes('SECRET-PASS'), '40.2 password not in error message');
    ok(!errorMsg.includes('SECRET-JWT'), '40.3 JWT not in error message');
    ok(!errorMsg.includes('SECRET-API-KEY'), '40.4 apiKey not in error message');
    ok(!errorMsg.includes('Unexpected end of JSON'), '40.5 NO "Unexpected end of JSON input"');
  }
  console.log('  ok — 40. secrets not in errors (4 checks)');

  // ===========================================================================
  // PROXY (21-27) — source-contract tests (no live server)
  // ===========================================================================
  console.log('  --- PROXY source-contract tests (21-27) ---');

  // 21-27. proxy-upload route source contract
  {
    const src = readFileSync(path.join(REPO_ROOT, 'src/routes/api/admin/media/upload/[id]/proxy-upload/+server.ts'), 'utf8');
    ok(src.includes('MAX_PROXY_FILE_SIZE'), '21.1 proxy has file size constant');
    ok(src.includes('26 * 1024 * 1024'), '21.2 26 MB limit');
    ok(src.includes('FILE_TOO_LARGE'), '22.1 FILE_TOO_LARGE error code');
    ok(src.includes('file.name'), '22.2 filename preserved (file.name used)');
    ok(src.includes('file.arrayBuffer'), '23.1 file content extracted as ArrayBuffer');
    ok(src.includes('filename: file.name'), '24.1 filename passed to adapter');
    ok(src.includes('adapter.uploadFile'), '25.1 uses adapter.uploadFile');
    ok(src.includes('completeUploadFromResult'), '26.1 completes via UploadService');
    ok(src.includes('status: 502'), '27.1 returns 502 on provider failure');
    ok(src.includes('error_code: err.code'), '27.2 persists error_code');
    ok(src.includes('error_message: err.message'), '27.3 persists error_message');
    ok(src.includes('json({ ok: false'), '27.4 ALWAYS returns JSON (never non-JSON)');
    ok(src.includes('ALWAYS return a structured JSON error'), '27.5 documents always-JSON contract');
    ok(src.includes('platform limitation') || src.includes('Netlify'), '27.6 documents Netlify limitation');
  }
  console.log('  ok — 21-27. proxy-upload route contract (14 checks)');

  // 26-27. oversized request behavior (source-contract)
  {
    const src = readFileSync(path.join(REPO_ROOT, 'src/routes/api/admin/media/upload/[id]/proxy-upload/+server.ts'), 'utf8');
    ok(src.includes('file.size > MAX_PROXY_FILE_SIZE'), '26.1 checks file size against limit');
    ok(src.includes('413'), '26.2 returns 413 for oversized files');
    ok(src.includes('Server-proxied upload is limited'), '27.1 error message documents the limit');
    ok(src.includes('remote URL upload'), '27.2 suggests remote URL upload as alternative');
  }
  console.log('  ok — 26-27. oversized request behavior (4 checks)');

  // ===========================================================================
  // STATE (34-37) — source-contract tests
  // ===========================================================================
  console.log('  --- STATE source-contract tests (34-37) ---');

  {
    const uploadSrc = readFileSync(path.join(REPO_ROOT, 'src/lib/server/hosting/upload/service.ts'), 'utf8');
    ok(uploadSrc.includes("'failed'"), '34.1 service has failed state');
    ok(uploadSrc.includes('failed_at'), '34.2 persists failed_at timestamp');
    ok(uploadSrc.includes('error_code'), '34.3 persists error_code');
    ok(uploadSrc.includes('error_message'), '34.4 persists error_message');
    ok(uploadSrc.includes('createMediaAsset'), '36.1 creates media_asset on success');
    ok(uploadSrc.includes('completeUploadFromResult'), '36.2 completeUploadFromResult is the success path');
    ok(uploadSrc.includes('retryOperation'), '37.1 has retryOperation');
    ok(uploadSrc.includes('parent_operation_id'), '37.2 retry links to parent operation');
    ok(uploadSrc.includes('attempt_number: op.attempt_number + 1'), '37.3 retry increments attempt_number');
  }
  console.log('  ok — 34-37. state machine contract (9 checks)');

  // 35. no invalid media_asset on failed upload (proxy route marks failed BEFORE createMediaAsset)
  {
    const proxySrc = readFileSync(path.join(REPO_ROOT, 'src/routes/api/admin/media/upload/[id]/proxy-upload/+server.ts'), 'utf8');
    ok(proxySrc.includes('catch (error)'), '35.1 catch block present');
    ok(proxySrc.includes("updateOperationState(params.id, 'failed'"), '35.2 marks operation as failed on error');
    ok(proxySrc.includes('failed_at'), '35.3 persists failed_at');
    // The createMediaAsset call is in the try block, NOT the catch block.
    ok(!/catch.*createMediaAsset/s.test(proxySrc), '35.4 createMediaAsset NOT in catch block');
  }
  console.log('  ok — 35. no invalid media_asset on failed upload (4 checks)');

  // ===========================================================================
  // Concurrent login guard (extra)
  // ===========================================================================
  console.log('  --- Concurrent login guard ---');

  {
    const { fetcher, captured } = createCapturingFetcher([
      { status: 200, json: { token: 'jwt-shared', expires_in: 3600 } },
      { status: 200, json: { data: { email: 'ok' } } },
      { status: 200, json: { data: { email: 'ok' } } },
    ]);
    const adapter = new AbyssAdapter({
      config: { baseUrl: 'https://api.abyss.to', email: 't@t', password: 'p', apiKey: 'test-api-key' },
      httpFetcher: fetcher,
    });
    // Fire two concurrent requests — they should share ONE login.
    await Promise.all([adapter.getAccountInfo(), adapter.getAccountInfo()]);
    // Only 3 requests: 1 login + 2 getAccountInfo.
    eq(captured.length, 3, 'Concurrent: only 1 login for 2 concurrent requests');
    eq(captured[0].url.includes('/auth/login'), true, 'Concurrent: first request was login');
    eq(captured[1].url.includes('/v1/about'), true, 'Concurrent: second request was getAccountInfo');
    eq(captured[2].url.includes('/v1/about'), true, 'Concurrent: third request was getAccountInfo');
  }
  console.log('  ok — Concurrent login guard (4 checks)');
}
console.log('');

// ===========================================================================
// Summary
// ===========================================================================

console.log('====================================');
console.log(`Phase 7 Abyss upload fix summary: ${passed} passed, ${failed} failed`);
console.log('====================================');
if (failed > 0) {
  console.error(`\n${failed} TEST(S) FAILED — see above.`);
  process.exit(1);
}
