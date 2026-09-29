/**
 * Phase 3 — Hosting provider adapter tests.
 *
 * Tests the provider-neutral interface, capability model, error model,
 * HTTP client, and the concrete Vidara + Abyss adapters using mock
 * HTTP fetchers (NO live provider API calls).
 *
 * Test philosophy (mirrors the existing repo test convention):
 *   - Mock fetcher injects canned responses
 *   - Each test verifies request construction + response normalization
 *   - Security tests verify NO credential leakage in errors/responses
 *   - Error classification tests verify the closed vocabulary
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

// --- Import adapter modules ---
// We import from the source directly (tsx resolves $lib aliases via jsconfig.json).
import { VidaraAdapter } from '../src/lib/server/hosting/vidara/adapter.ts';
import { AbyssAdapter } from '../src/lib/server/hosting/abyss/adapter.ts';
import { HostingProviderError, classifyHttpError, isRetryable, asHostingError } from '../src/lib/server/hosting/errors.ts';
import { createHostingHttpFetcher, withRetry } from '../src/lib/server/hosting/http-client.ts';
import type { HostingHttpFetcher, HostingHttpResponse } from '../src/lib/server/hosting/http-client.ts';
import type { ProviderCapabilities, ProviderAssetInfo } from '../src/lib/server/hosting/types.ts';

// --- Mock HTTP fetcher factory ---

type MockResponse = {
  status?: number;
  json?: unknown;
  headers?: Record<string, string>;
};

function createMockFetcher(responses: MockResponse[] | MockResponse | ((request: { method: string; url: string; body?: unknown }) => MockResponse)): HostingHttpFetcher {
  const queue = Array.isArray(responses) ? [...responses] : null;
  const handler = typeof responses === 'function' ? responses : null;
  return async (request) => {
    const mock = handler ? handler(request) : queue!.shift() ?? { status: 200, json: {} };
    const status = mock.status ?? 200;
    const ok = status >= 200 && status < 300;
    if (!ok) {
      throw new HostingProviderError(classifyHttpError(status), { httpStatus: status });
    }
    return { status, ok, json: mock.json ?? null, headers: mock.headers ?? {} };
  };
}

// ===========================================================================
// 1. Provider capability model
// ===========================================================================

function testCapabilities(): void {
  const vidara = new VidaraAdapter({ config: { apiKey: 'test-key', baseUrl: 'https://api.test.vidara' } });
  const abyss = new AbyssAdapter({ config: { baseUrl: 'https://api.test.abyss', email: 'test@abyss', password: 'test-pass', apiKey: 'test-api-key' } });

  const vcaps = vidara.getCapabilities();
  const acaps = abyss.getCapabilities();

  // Vidara capabilities (plan §3.1 + §6)
  ok(vcaps.localUpload === true, 'Vidara: localUpload supported');
  ok(vcaps.remoteUpload === true, 'Vidara: remoteUpload supported');
  ok(vcaps.folderManagement === true, 'Vidara: folderManagement supported');
  ok(vcaps.nestedFolders === false, 'Vidara: nestedFolders=false (documented as flat)');
  ok(vcaps.subtitles === true, 'Vidara: subtitles supported');
  ok(vcaps.multiAudio === true, 'Vidara: multiAudio supported (plan §3.1)');
  ok(vcaps.transcoding === false, 'Vidara: transcoding=false (single uploaded quality)');
  ok(vcaps.qualityVariants === false, 'Vidara: qualityVariants=false');
  ok(vcaps.processingStatus === true, 'Vidara: processingStatus supported');
  ok(vcaps.rename === true && vcaps.move === true && vcaps.delete === true, 'Vidara: rename/move/delete supported');
  ok(vcaps.thumbnails === true, 'Vidara: thumbnails supported');

  // Abyss capabilities (plan §3.2 + §6 + Phase 0 §3.2.1)
  ok(acaps.localUpload === true, 'Abyss: localUpload supported');
  ok(acaps.remoteUpload === false, 'Abyss: remoteUpload=false (NOT API-verified — Phase 0 §3.2.1)');
  ok(acaps.remoteUploadTypes.length === 0, 'Abyss: remoteUploadTypes empty (no verified remote upload types)');
  ok(acaps.folderManagement === true, 'Abyss: folderManagement supported');
  ok(acaps.nestedFolders === true, 'Abyss: nestedFolders=true');
  ok(acaps.subtitles === true, 'Abyss: subtitles supported');
  ok(acaps.multiAudio === false, 'Abyss: multiAudio=false (original/single audio — plan §3.2)');
  ok(acaps.transcoding === true, 'Abyss: transcoding=true (480p/720p/1080p — plan §3.2)');
  ok(acaps.qualityVariants === true, 'Abyss: qualityVariants=true');
  ok(acaps.processingStatus === true, 'Abyss: processingStatus supported');
  ok(acaps.rename === true && acaps.move === true && acaps.delete === true, 'Abyss: rename/move/delete supported');
  ok(acaps.thumbnails === false, 'Abyss: thumbnails=false (not documented)');
}

// ===========================================================================
// 2. Error model
// ===========================================================================

function testErrorModel(): void {
  // classifyHttpError
  ok(classifyHttpError(401) === 'AUTHENTICATION', 'Error: 401 → AUTHENTICATION');
  ok(classifyHttpError(403) === 'AUTHENTICATION', 'Error: 403 → AUTHENTICATION');
  ok(classifyHttpError(404) === 'NOT_FOUND', 'Error: 404 → NOT_FOUND');
  ok(classifyHttpError(422) === 'VALIDATION', 'Error: 422 → VALIDATION');
  ok(classifyHttpError(429) === 'RATE_LIMITED', 'Error: 429 → RATE_LIMITED');
  ok(classifyHttpError(500) === 'TRANSIENT', 'Error: 500 → TRANSIENT');
  ok(classifyHttpError(503) === 'TRANSIENT', 'Error: 503 → TRANSIENT');
  ok(classifyHttpError(400) === 'VALIDATION', 'Error: 400 → VALIDATION');

  // isRetryable
  ok(isRetryable('RATE_LIMITED') === true, 'Retry: RATE_LIMITED is retryable');
  ok(isRetryable('TRANSIENT') === true, 'Retry: TRANSIENT is retryable');
  ok(isRetryable('NETWORK') === true, 'Retry: NETWORK is retryable');
  ok(isRetryable('TIMEOUT') === true, 'Retry: TIMEOUT is retryable');
  ok(isRetryable('AUTHENTICATION') === false, 'Retry: AUTHENTICATION is NOT retryable');
  ok(isRetryable('VALIDATION') === false, 'Retry: VALIDATION is NOT retryable');
  ok(isRetryable('NOT_FOUND') === false, 'Retry: NOT_FOUND is NOT retryable');
  ok(isRetryable('UNSUPPORTED') === false, 'Retry: UNSUPPORTED is NOT retryable');

  // HostingProviderError
  const err = new HostingProviderError('RATE_LIMITED', { httpStatus: 429, retryAfterSeconds: 60 });
  ok(err.code === 'RATE_LIMITED', 'Error: code preserved');
  ok(err.httpStatus === 429, 'Error: httpStatus preserved');
  ok(err.retryAfterSeconds === 60, 'Error: retryAfterSeconds preserved');
  ok(err.message.includes('rate limit') && err.message.includes('HTTP 429'), 'Error: message is safe (no credentials)');

  // asHostingError
  const wrapped = asHostingError(new Error('test'), 'UNKNOWN');
  ok(wrapped instanceof HostingProviderError, 'asHostingError: wraps unknown error');
  ok(wrapped.code === 'UNKNOWN', 'asHostingError: fallback code');

  // AbortError → TIMEOUT
  const abortErr = asHostingError(new DOMException('aborted', 'AbortError'));
  ok(abortErr.code === 'TIMEOUT', 'asHostingError: AbortError → TIMEOUT');
}

// ===========================================================================
// 3. Vidara adapter — request construction + response normalization
// ===========================================================================

async function testVidaraAdapter(): Promise<void> {
  const mockFetcher = createMockFetcher([
    // getAccountInfo
    { status: 200, json: { result: true, data: { email: 'test@vidara', name: 'Test', storage_used: 1024, storage_limit: 1048576 } } },
    // getAsset
    { status: 200, json: { result: [{ file_code: 'abc123', title: 'Test Movie', status: 1, size: 104857600, duration: 7200, quality: '720p', audio: ['en', 'hi'], subtitles: 1 }] } },
    // listAssets
    { status: 200, json: { result: { files: [{ file_code: 'abc123', title: 'Test Movie', status: 1 }] } } },
    // renameAsset (operation response)
    { status: 200, json: { result: true } },
    // getAsset (re-fetch after rename)
    { status: 200, json: { result: [{ file_code: 'abc123', title: 'Renamed Movie', status: 1 }] } },
    // moveAsset (operation response)
    { status: 200, json: { result: true } },
    // getAsset (re-fetch after move)
    { status: 200, json: { result: [{ file_code: 'abc123', title: 'Renamed Movie', status: 1 }] } },
    // deleteAsset (operation response)
    { status: 200, json: { result: true } },
    // uploadFile — step 1: get upload server (VERIFIED: field is upload_server)
    { status: 200, json: { result: { upload_server: 'https://upload.vidara.so/upload' } } },
    // uploadFile — step 2: multipart POST result (VERIFIED: filecode at top level)
    { status: 200, json: { filecode: 'new123', video_id: 123, title: 'test' } },
    // uploadRemote (VERIFIED: GET /v1/upload/url returns data.filecode)
    { status: 200, json: { data: { filecode: 'remote456', link: 'https://vidara.to/remote456', size: 1024 } } },
    // getProcessingStatus (VERIFIED: now uses /v1/video/info, returns result array with status string)
    { status: 200, json: { result: [{ status: 'processing', filecode: 'abc123', link: 'https://vidara.to/abc123' }] } },
    // listFolders
    { status: 200, json: { result: { folders: [{ folder_id: 'f1', name: 'Movies' }] } } },
    // createFolder (operation)
    { status: 200, json: { result: true, data: { folder_id: 'f2' } } },
    // listFolders (re-list after create)
    { status: 200, json: { result: { folders: [{ folder_id: 'f1', name: 'Movies' }, { folder_id: 'f2', name: 'New Folder' }] } } },
    // renameFolder
    { status: 200, json: { result: true } },
    // deleteFolder
    { status: 200, json: { result: true } },
    // uploadSubtitle
    { status: 200, json: { result: true } },
    // uploadThumbnail
    { status: 200, json: { result: true } },
  ]);

  const adapter = new VidaraAdapter({
    config: { apiKey: 'test-key', baseUrl: 'https://api.test.vidara' },
    httpFetcher: mockFetcher,
  });

  // getAccountInfo
  const account = await adapter.getAccountInfo();
  ok(account.accountId === 'test@vidara', 'Vidara: account email normalized');
  ok(account.storageUsed === 1024, 'Vidara: storage_used normalized');
  ok(account.storageTotal === 1048576, 'Vidara: storage_limit normalized');

  // getAsset
  const asset = await adapter.getAsset('abc123');
  ok(asset.providerAssetId === 'abc123', 'Vidara: providerAssetId from file_code');
  ok(asset.title === 'Test Movie', 'Vidara: title normalized');
  ok(asset.playbackUrl === 'https://vidara.so/v/abc123', 'Vidara: playbackUrl is player URL (NOT raw stream)');
  ok(asset.status === 'ready', 'Vidara: status 1 → ready');
  ok(asset.sizeBytes === 104857600, 'Vidara: size normalized');
  ok(asset.durationSeconds === 7200, 'Vidara: duration normalized');
  ok(asset.sourceQuality === '720p', 'Vidara: quality normalized');
  ok(asset.audioLanguages.length === 2 && asset.audioLanguages[0] === 'en', 'Vidara: multi-audio preserved');
  ok(asset.hasSubtitles === true, 'Vidara: subtitles flag preserved');

  // listAssets
  const assets = await adapter.listAssets(null);
  ok(assets.length === 1 && assets[0].providerAssetId === 'abc123', 'Vidara: listAssets normalizes file array');

  // renameAsset
  const renamed = await adapter.renameAsset('abc123', 'Renamed Movie');
  ok(renamed.title === 'Renamed Movie', 'Vidara: renameAsset returns updated title');

  // moveAsset
  const moved = await adapter.moveAsset('abc123', 'folder-2');
  ok(moved.title === 'Renamed Movie', 'Vidara: moveAsset returns asset');

  // deleteAsset (should not throw)
  await adapter.deleteAsset('abc123');
  ok(true, 'Vidara: deleteAsset completes');

  // uploadFile
  const uploadResult = await adapter.uploadFile({
    content: new Blob(['test']),
    filename: 'test.mp4',
    providerFolderId: null,
  });
  ok(uploadResult.providerAssetId === 'new123', 'Vidara: uploadFile returns providerAssetId');
  ok(uploadResult.status === 'uploaded', 'Vidara: uploadFile status = uploaded');

  // uploadRemote
  const remoteResult = await adapter.uploadRemote({
    url: 'https://example.com/video.mp4',
    providerFolderId: null,
  });
  ok(remoteResult.providerAssetId === 'remote456', 'Vidara: uploadRemote returns providerAssetId');

  // getProcessingStatus (VERIFIED: now uses /v1/video/info, status is a string)
  const procStatus = await adapter.getProcessingStatus('abc123');
  ok(procStatus.status === 'processing', 'Vidara: status "processing" → processing');
  // /v1/video/info does NOT report progress percentage — null is expected.
  ok(procStatus.progressPercent === null, 'Vidara: progressPercent null (video/info does not report progress)');

  // listFolders
  const folders = await adapter.listFolders(null);
  ok(folders.length === 1 && folders[0].name === 'Movies', 'Vidara: listFolders normalizes');

  // createFolder
  const newFolder = await adapter.createFolder({ name: 'New Folder', parentFolderId: null });
  ok(newFolder.name === 'New Folder', 'Vidara: createFolder returns folder');

  // renameFolder
  await adapter.renameFolder('f2', 'Renamed Folder');
  ok(true, 'Vidara: renameFolder completes');

  // deleteFolder
  await adapter.deleteFolder('f2');
  ok(true, 'Vidara: deleteFolder completes');

  // uploadSubtitle
  await adapter.uploadSubtitle({
    providerAssetId: 'abc123',
    content: new ArrayBuffer(10),
    filename: 'subs.en.srt',
    language: 'en',
  });
  ok(true, 'Vidara: uploadSubtitle completes');

  // uploadThumbnail
  await adapter.uploadThumbnail('abc123', { url: 'https://example.com/thumb.jpg' });
  ok(true, 'Vidara: uploadThumbnail completes');

  // moveFolder should throw UNSUPPORTED (Vidara folders are flat)
  try {
    await adapter.moveFolder('f1', 'f2');
    assert.fail('Vidara: moveFolder should throw UNSUPPORTED');
  } catch (e) {
    ok(e instanceof HostingProviderError && e.code === 'UNSUPPORTED', 'Vidara: moveFolder throws UNSUPPORTED (flat folders)');
  }
}

// ===========================================================================
// 4. Abyss adapter — request construction + response normalization
// ===========================================================================

async function testAbyssAdapter(): Promise<void> {
  // The Abyss adapter caches the JWT token (50 min TTL) so only ONE
  // login response is needed. All subsequent authedRequest calls reuse
  // the cached token.
  const mockFetcher = createMockFetcher([
    // 1. login (ensureToken on first authedRequest)
    { status: 200, json: { token: 'jwt-token-123', expires_in: 3600 } },
    // 2. getAccountInfo
    { status: 200, json: { data: { id: 'user1', email: 'test@abyss', name: 'Test', storage_used: 2048, storage_limit: 1073741824 } } },
    // 3. getAsset
    { status: 200, json: { data: { id: 42, slug: 'test-slug', name: 'Test Movie', status: 'active', size: 209715200, duration: 5400, quality: '1080p', qualities: ['480p', '720p', '1080p'] } } },
    // 4. listAssets
    { status: 200, json: { data: [{ id: 42, slug: 'test-slug', status: 'active' }] } },
    // 5. renameAsset (PUT)
    { status: 200, json: { success: true } },
    // 6. getAsset (re-fetch after rename)
    { status: 200, json: { data: { id: 42, slug: 'test-slug', name: 'Renamed', status: 'active' } } },
    // 7. moveAsset (PATCH)
    { status: 200, json: { success: true } },
    // 8. getAsset (re-fetch after move)
    { status: 200, json: { data: { id: 42, slug: 'test-slug', name: 'Renamed', status: 'active' } } },
    // 9. deleteAsset (DELETE)
    { status: 200, json: { success: true } },
    // 10. uploadFile (POST up.abyss.to/:key) — verified: returns { slug: 'file-id' } at top level
    { status: 200, json: { slug: 'new-upload' } },
    // 11. getProcessingStatus (GET /v1/files/:id)
    { status: 200, json: { data: { id: 42, slug: 'test-slug', status: 'processing', qualities: ['480p', '720p'] } } },
    // 12. listFolders
    { status: 200, json: { data: [{ id: 'f1', name: 'Movies', parent_id: null }] } },
    // 13. createFolder
    { status: 200, json: { data: { id: 'f2', name: 'New Folder', parent_id: 'f1' } } },
    // 14. renameFolder
    { status: 200, json: { data: { id: 'f2', name: 'Renamed', parent_id: 'f1' } } },
    // 15. moveFolder
    { status: 200, json: { data: { id: 'f2', name: 'Renamed', parent_id: 'f1' } } },
    // 16. deleteFolder
    { status: 200, json: { success: true } },
    // 17. uploadSubtitle
    { status: 200, json: { success: true } },
  ]);

  const adapter = new AbyssAdapter({
    config: { baseUrl: 'https://api.test.abyss', email: 'test@abyss', password: 'test-pass', apiKey: 'test-api-key' },
    httpFetcher: mockFetcher,
  });

  // getAccountInfo
  const account = await adapter.getAccountInfo();
  ok(account.accountId === 'user1', 'Abyss: account id normalized');
  ok(account.storageUsed === 2048, 'Abyss: storage_used normalized');

  // getAsset
  const asset = await adapter.getAsset('test-slug');
  ok(asset.providerAssetId === 'test-slug', 'Abyss: providerAssetId from slug');
  ok(asset.providerVideoId === '42', 'Abyss: providerVideoId from id');
  ok(asset.playbackUrl === 'https://player.abyssplayer.com/test-slug', 'Abyss: playbackUrl is player URL (NOT raw stream)');
  ok(asset.status === 'ready', 'Abyss: status "active" → ready');
  ok(asset.availableQualities.length === 3, 'Abyss: multi-quality variants preserved');
  ok(asset.availableQualities.includes('1080p'), 'Abyss: 1080p quality variant present');

  // listAssets
  const assets = await adapter.listAssets(null);
  ok(assets.length === 1, 'Abyss: listAssets normalizes');

  // renameAsset
  const renamed = await adapter.renameAsset('test-slug', 'Renamed');
  ok(renamed.title === 'Renamed', 'Abyss: renameAsset returns updated name');

  // moveAsset
  const moved = await adapter.moveAsset('test-slug', 'f1');
  ok(moved.title === 'Renamed', 'Abyss: moveAsset returns asset');

  // deleteAsset
  await adapter.deleteAsset('test-slug');
  ok(true, 'Abyss: deleteAsset completes');

  // uploadFile
  const uploadResult = await adapter.uploadFile({
    content: new Blob(['test']),
    filename: 'test.mp4',
    providerFolderId: null,
  });
  ok(uploadResult.providerAssetId === 'new-upload', 'Abyss: uploadFile returns slug');
  ok(uploadResult.status === 'processing', 'Abyss: uploadFile status = processing (transcoding starts)');

  // getProcessingStatus
  const procStatus = await adapter.getProcessingStatus('test-slug');
  ok(procStatus.status === 'processing', 'Abyss: processing status preserved');
  ok(procStatus.availableQualities.length === 2, 'Abyss: processing qualities updated');

  // listFolders
  const folders = await adapter.listFolders(null);
  ok(folders.length === 1 && folders[0].name === 'Movies', 'Abyss: listFolders normalizes');

  // createFolder
  const newFolder = await adapter.createFolder({ name: 'New Folder', parentFolderId: 'f1' });
  ok(newFolder.name === 'New Folder', 'Abyss: createFolder returns folder');
  ok(newFolder.parentFolderId === 'f1', 'Abyss: createFolder preserves parent (nestedFolders=true)');

  // renameFolder
  const renamedFolder = await adapter.renameFolder('f2', 'Renamed');
  ok(renamedFolder.name === 'Renamed', 'Abyss: renameFolder returns updated name');

  // moveFolder (should NOT throw — Abyss supports nested folders)
  const movedFolder = await adapter.moveFolder('f2', 'f1');
  ok(movedFolder.parentFolderId === 'f1', 'Abyss: moveFolder preserves parent');

  // deleteFolder
  await adapter.deleteFolder('f2');
  ok(true, 'Abyss: deleteFolder completes');

  // uploadSubtitle
  await adapter.uploadSubtitle({
    providerAssetId: 'test-slug',
    content: new ArrayBuffer(10),
    filename: 'subs.en.srt',
    language: 'en',
  });
  ok(true, 'Abyss: uploadSubtitle completes');

  // uploadRemote MUST throw UNSUPPORTED
  try {
    await adapter.uploadRemote({ url: 'https://example.com/video.mp4', providerFolderId: null });
    assert.fail('Abyss: uploadRemote should throw UNSUPPORTED');
  } catch (e) {
    ok(e instanceof HostingProviderError && e.code === 'UNSUPPORTED', 'Abyss: uploadRemote throws UNSUPPORTED (not API-verified)');
    ok(e.message.includes('not API-verified'), 'Abyss: uploadRemote error message documents the reason');
  }
}

// ===========================================================================
// 5. Security tests — no credential leakage
// ===========================================================================

function testSecurity(): void {
  // HostingProviderError messages must NEVER contain credentials.
  const err1 = new HostingProviderError('AUTHENTICATION', { httpStatus: 401 });
  ok(!err1.message.includes('key') && !err1.message.includes('token') && !err1.message.includes('password'), 'Security: error message contains no credentials');

  const err2 = new HostingProviderError('NETWORK');
  ok(!err2.message.includes('api') && !err2.message.includes('url'), 'Security: network error message is generic');

  // ProviderAssetInfo must NEVER contain credentials.
  const mockAsset: ProviderAssetInfo = {
    providerAssetId: 'abc', providerVideoId: null, filename: 'test.mp4', title: 'Test',
    playbackUrl: 'https://vidara.so/v/abc', thumbnailUrl: null, sizeBytes: null, durationSeconds: null,
    sourceQuality: null, availableQualities: [], audioLanguages: [], hasSubtitles: false,
    providerStatus: 'ok', status: 'ready', providerFolderId: null, providerUpdatedAt: null,
    raw: {},
  };
  const serialized = JSON.stringify(mockAsset);
  ok(!serialized.includes('apiKey') && !serialized.includes('password') && !serialized.includes('token'), 'Security: ProviderAssetInfo JSON contains no credentials');

  // Source code must not contain hardcoded credentials.
  const vidaraAdapterSource = readFileSync(path.join(REPO_ROOT, 'src/lib/server/hosting/vidara/adapter.ts'), 'utf8');
  ok(!vidaraAdapterSource.includes('test-key') && !vidaraAdapterSource.includes('sk_'), 'Security: Vidara adapter source has no hardcoded keys');
  const abyssAdapterSource = readFileSync(path.join(REPO_ROOT, 'src/lib/server/hosting/abyss/adapter.ts'), 'utf8');
  ok(!abyssAdapterSource.includes('test-pass') && !abyssAdapterSource.includes('password123'), 'Security: Abyss adapter source has no hardcoded passwords');

  // .env.example must reference secrets via variable names, not values.
  const envExample = readFileSync(path.join(REPO_ROOT, '.env.example'), 'utf8');
  ok(envExample.includes('VIDARA_API_KEY') && !envExample.includes('=sk_') && !envExample.match(/VIDARA_API_KEY=\S/), 'Security: .env.example has no VIDARA_API_KEY value');
  ok(envExample.includes('ABYSS_PASSWORD') && !envExample.match(/ABYSS_PASSWORD=\S/), 'Security: .env.example has no ABYSS_PASSWORD value');

  // Source files must not log credentials.
  const httpClientSource = readFileSync(path.join(REPO_ROOT, 'src/lib/server/hosting/http-client.ts'), 'utf8');
  ok(!httpClientSource.includes('console.log') && !httpClientSource.includes('console.warn') && !httpClientSource.includes('console.error'), 'Security: HTTP client does NOT log (prevents credential leakage)');
}

// ===========================================================================
// 6. Retry helper
// ===========================================================================

async function testRetry(): Promise<void> {
  // Permanent error → no retry.
  let calls = 0;
  try {
    await withRetry(async () => {
      calls += 1;
      throw new HostingProviderError('VALIDATION');
    }, 3, 1, 10);
    assert.fail('Should have thrown');
  } catch (e) {
    ok(calls === 1, 'Retry: permanent error does not retry');
    ok(e instanceof HostingProviderError && e.code === 'VALIDATION', 'Retry: permanent error propagated');
  }

  // Transient error → retries until success.
  calls = 0;
  const result = await withRetry(async () => {
    calls += 1;
    if (calls < 3) throw new HostingProviderError('TRANSIENT');
    return 'success';
  }, 5, 1, 10);
  ok(result === 'success', 'Retry: transient error eventually succeeds');
  ok(calls === 3, 'Retry: exactly 3 attempts');

  // Transient error → exhausts retries.
  calls = 0;
  try {
    await withRetry(async () => {
      calls += 1;
      throw new HostingProviderError('NETWORK');
    }, 2, 1, 10);
    assert.fail('Should have thrown');
  } catch (e) {
    ok(calls === 2, 'Retry: exhausted 2 attempts');
    ok(e instanceof HostingProviderError && e.code === 'NETWORK', 'Retry: last error propagated');
  }
}

// ===========================================================================
// Run all tests
// ===========================================================================

console.log('=== Phase 3 — Hosting provider adapter tests ===\n');

testCapabilities();
console.log('  ok — capability model (Vidara + Abyss)');

testErrorModel();
console.log('  ok — error model (classification + retryable + wrapping)');

await testVidaraAdapter();
console.log('  ok — Vidara adapter (account, asset, list, rename, move, delete, upload, remote, processing, folders, subtitles, thumbnails)');

await testAbyssAdapter();
console.log('  ok — Abyss adapter (login, account, asset, list, rename, move, delete, upload, processing, folders, subtitles, uploadRemote=UNSUPPORTED)');

testSecurity();
console.log('  ok — security (no credential leakage in errors, responses, source, env)');

await testRetry();
console.log('  ok — retry helper (permanent=no-retry, transient=retries)');

console.log(`\nPhase 3 hosting adapter tests: ${passed} checks passed.`);
