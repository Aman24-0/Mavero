/**
 * VidaraAdapter — Phase 3 implementation.
 *
 * Implements the `HostingProviderAdapter` interface for the Vidara
 * hosting provider. All HTTP calls go through the shared hosting
 * HTTP client (timeout, SSRF, error classification).
 *
 * Direct vs embed semantics (user task brief §9):
 *   Vidara returns `https://vidara.so/v/<filecode>` as the playback
 *   URL. This is a PLAYER/EMBED URL, NOT a raw media stream. The
 *   adapter stores it as `playbackUrl` (a provider player URL) and
 *   does NOT extract/scrape raw HLS/MP4 URLs from the player page.
 *
 * Folder semantics (user task brief §3):
 *   Vidara's documented API describes folders as FLAT. The dashboard
 *   may visually suggest nesting, but the API does NOT support
 *   nested folders. `nestedFolders = false` in the capability model.
 *
 * Capability model (plan §3.1 + §6):
 *   - localUpload: true (multipart upload via /v1/upload/server)
 *   - remoteUpload: true (documented remote URL upload endpoint)
 *   - folderManagement: true (create, list, rename, delete)
 *   - nestedFolders: false (documented as flat)
 *   - subtitles: true (separate subtitle upload endpoint)
 *   - multiAudio: true (plan §3.1)
 *   - transcoding: false (single uploaded quality, no transcoding)
 *   - qualityVariants: false (no multi-quality output)
 *   - processingStatus: true (encoding status endpoint)
 *   - rename: true, move: true, delete: true
 *   - thumbnails: true (thumbnail upload endpoint)
 */

import type {
  HostingProviderAdapter,
  HostingProviderKey,
  ProviderCapabilities,
  ProviderAccountInfo,
  ProviderAssetInfo,
  ProviderFolderInfo,
  ProviderUploadResult,
  ProviderProcessingStatus,
  UploadFileParams,
  UploadRemoteParams,
  CreateFolderParams,
  UploadSubtitleParams,
  HostingAdapterDeps,
} from '../types';
import { HostingProviderError } from '../errors';
import type { HostingHttpFetcher } from '../http-client';
import { createHostingHttpFetcher, withRetry } from '../http-client';
import type { VidaraConfig } from './config';
import type {
  VidaraAccountResponse,
  VidaraFileListResponse,
  VidaraFileInfoResponse,
  VidaraFolderListResponse,
  VidaraUploadServerResponse,
  VidaraUploadResultResponse,
  VidaraEncodingStatusResponse,
  VidaraOperationResponse,
} from './types';
import {
  normalizeVidaraAccount,
  normalizeVidaraFileList,
  normalizeVidaraFileInfo,
  normalizeVidaraFolderList,
  normalizeVidaraUploadResult,
  normalizeVidaraEncodingStatus,
  normalizeVidaraProcessingStatus,
  extractVidaraUploadServerUrl,
} from './normalize';

// ---------------------------------------------------------------------------
// Capability model
// ---------------------------------------------------------------------------

const VIDARA_CAPABILITIES: ProviderCapabilities = {
  localUpload: true,
  remoteUpload: true,
  remoteUploadTypes: ['direct-file'] as const,
  folderManagement: true,
  nestedFolders: false, // Documented as flat.
  subtitles: true,
  multiAudio: true, // Plan §3.1.
  transcoding: false, // Single uploaded quality, no transcoding.
  qualityVariants: false, // No multi-quality output.
  processingStatus: true,
  rename: true,
  move: true,
  delete: true,
  thumbnails: true,
};

// ---------------------------------------------------------------------------
// Authentication — Vidara uses `api_key` query parameter (NOT Bearer header)
// ---------------------------------------------------------------------------

/**
 * Appends the Vidara API key as an `api_key` query parameter to a URL.
 *
 * Vidara's API contract authenticates EVERY request via an
 * `api_key=<server-side-key>` query parameter — NOT via an
 * `Authorization: Bearer <key>` header. This was confirmed by a
 * production 401 failure: the previous implementation used the
 * shared `createHostingHttpFetcher(\`Bearer ${apiKey}\`)` which sent
 * a Bearer header that Vidara does not recognize, causing every
 * Vidara API call (account info, video info, upload server, etc.)
 * to return HTTP 401 "Provider authentication failed".
 *
 * The key is appended using the standard `URL` API so existing
 * query parameters (e.g. `?file_code=abc`) are preserved and the
 * `api_key` is correctly URL-encoded. The returned string is the
 * full href (e.g.
 * `https://api.vidara.so/v1/video/info?file_code=abc&api_key=<key>`).
 *
 * SECURITY: the API key NEVER appears in client-visible payloads
 * because:
 *   1. This function is called ONLY from server-side adapter methods.
 *   2. The shared `HostingHttpFetcher` validates the URL via the
 *      SSRF guard and NEVER logs the URL in error messages (the
 *      `http-client.ts` module doc explicitly states "never logs
 *      headers, bodies, or URLs with secrets").
 *   3. The browser-direct upload flow (upload-server route) returns
 *      ONLY the temporary upload server URL extracted from the
 *      Vidara response — the `api_key` query parameter is on the
 *      GET /v1/upload/server request, NOT on the returned upload
 *      server URL, so the browser never receives the API key.
 *
 * @param baseUrl The Vidara API base URL (e.g. `https://api.vidara.so`).
 * @param path    The API path (e.g. `/v1/upload/server`).
 * @param extraQuery Optional additional query parameters (merged with api_key).
 * @param apiKey  The server-side Vidara API key.
 * @returns The full authenticated URL string.
 */
export function buildVidaraUrl(
  baseUrl: string,
  path: string,
  extraQuery: Record<string, string> | null,
  apiKey: string,
): string {
  const url = new URL(path, baseUrl);
  // Existing query parameters (if any) are preserved by the URL API.
  if (extraQuery) {
    for (const [key, value] of Object.entries(extraQuery)) {
      url.searchParams.set(key, value);
    }
  }
  // The api_key is ALWAYS appended last so it is present on every
  // Vidara API request regardless of which endpoint is called.
  url.searchParams.set('api_key', apiKey);
  return url.href;
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export type VidaraAdapterOptions = {
  config: VidaraConfig;
  /** Override the HTTP fetcher (for testing). */
  httpFetcher?: HostingHttpFetcher;
};

export class VidaraAdapter implements HostingProviderAdapter {
  readonly providerKey: HostingProviderKey = 'vidara';
  private readonly config: VidaraConfig;
  private readonly http: HostingHttpFetcher;

  constructor(options: VidaraAdapterOptions) {
    this.config = options.config;
    // Vidara authenticates via `api_key` query parameter on every request
    // (see `buildVidaraUrl`). The shared HTTP fetcher is constructed with
    // `null` so NO `Authorization` header is sent — that would conflict
    // with Vidara's auth scheme and is not what the API expects.
    // The shared fetcher is still used for: SSRF guard, timeout, JSON
    // parsing, error classification. Abyss uses the same fetcher with
    // its own JWT Bearer header injected via `authedRequest()`.
    this.http = options.httpFetcher ?? createHostingHttpFetcher(null);
  }

  /**
   * Bounded retry wrapper for read-only provider operations.
   * Retries transient failures (5xx, network, timeout, rate limit) up to
   * 3 attempts with exponential backoff + jitter. Does NOT retry permanent
   * errors (AUTHENTICATION, VALIDATION, NOT_FOUND, UNSUPPORTED).
   *
   * This is the SINGLE retry boundary for Vidara read operations. Write
   * operations (upload, rename, move, delete) are NOT retried because they
   * have side effects and repeating them could create duplicates or corrupt
   * provider state.
   */
  private async withReadRetry<T>(fn: () => Promise<T>): Promise<T> {
    return withRetry(fn, 3, 500, 5_000);
  }

  /**
   * Builds a fully-authenticated Vidara API URL for the given path.
   * Centralizes the `api_key` query parameter so every endpoint uses
   * the same auth scheme (single source of truth).
   */
  private url(path: string, extraQuery: Record<string, string> | null = null): string {
    return buildVidaraUrl(this.config.baseUrl, path, extraQuery, this.config.apiKey);
  }

  getCapabilities(): ProviderCapabilities {
    return VIDARA_CAPABILITIES;
  }

  // --- Account ---

  async getAccountInfo(_deps?: HostingAdapterDeps): Promise<ProviderAccountInfo> {
    return this.withReadRetry(async () => {
      const res = await this.http({ method: 'GET', url: this.url('/v1/account/info') });
      return normalizeVidaraAccount(res.json as VidaraAccountResponse);
    });
  }

  // --- File / asset operations ---

  async getAsset(providerAssetId: string, _deps?: HostingAdapterDeps): Promise<ProviderAssetInfo> {
    return this.withReadRetry(async () => {
      const url = this.url('/v1/video/info', { filecode: providerAssetId });
      const res = await this.http({ method: 'GET', url });
      return normalizeVidaraFileInfo(res.json as VidaraFileInfoResponse);
    });
  }

  async listAssets(providerFolderId: string | null, _deps?: HostingAdapterDeps): Promise<ProviderAssetInfo[]> {
    return this.withReadRetry(async () => {
      const extraQuery = providerFolderId ? { folder_id: providerFolderId } : null;
      const url = this.url('/v1/video/list', extraQuery);
      const res = await this.http({ method: 'GET', url });
      return normalizeVidaraFileList(res.json as VidaraFileListResponse);
    });
  }

  async renameAsset(providerAssetId: string, newName: string, _deps?: HostingAdapterDeps): Promise<ProviderAssetInfo> {
    const res = await this.http({
      method: 'POST',
      url: this.url('/v1/video/rename'),
      body: { file_code: providerAssetId, title: newName },
    });
    // Vidara returns a generic operation response; re-fetch the file info.
    if (!(res.json as VidaraOperationResponse)?.result) {
      throw new HostingProviderError('VALIDATION', { message: 'Vidara rename returned failure.' });
    }
    return this.getAsset(providerAssetId);
  }

  async moveAsset(providerAssetId: string, targetFolderId: string | null, _deps?: HostingAdapterDeps): Promise<ProviderAssetInfo> {
    const res = await this.http({
      method: 'POST',
      url: this.url('/v1/video/move'),
      body: { file_code: providerAssetId, folder_id: targetFolderId ?? '' },
    });
    if (!(res.json as VidaraOperationResponse)?.result) {
      throw new HostingProviderError('VALIDATION', { message: 'Vidara move returned failure.' });
    }
    return this.getAsset(providerAssetId);
  }

  async deleteAsset(providerAssetId: string, _deps?: HostingAdapterDeps): Promise<void> {
    // VERIFIED CONTRACT (audit fix): Vidara's delete endpoint is:
    //   GET /v1/video/delete?filecode=<providerAssetId>&api_key=<key>
    //
    // The method is GET (NOT POST). The query parameter is `filecode`
    // (NO underscore — matching the same param name used by
    // /v1/video/info and /v1/upload/url).
    //
    // Previous incorrect attempts:
    //   1. POST /v1/video/delete with JSON body { file_code: ... } → HTTP 400
    //      (Vidara does not parse JSON bodies on this endpoint)
    //   2. POST /v1/video/delete?file_code=... → still failed
    //      (wrong method + wrong param name with underscore)
    //
    // The correct contract uses GET with `filecode` (no underscore),
    // consistent with every other verified Vidara read endpoint:
    //   - GET /v1/video/info?filecode=... (getAsset, getProcessingStatus)
    //   - GET /v1/upload/url?url=... (uploadRemote)
    //
    // Success detection: Vidara returns a VidaraOperationResponse with
    // `result: true` on success. A missing/already-deleted file returns
    // `result: false` (or a NOT_FOUND error) — we surface that as a
    // VALIDATION error so the admin knows the filecode was not found
    // at the provider, rather than silently treating it as success.
    const res = await this.http({
      method: 'GET',
      url: this.url('/v1/video/delete', { filecode: providerAssetId }),
    });
    if (!(res.json as VidaraOperationResponse)?.result) {
      throw new HostingProviderError('VALIDATION', { message: 'Vidara delete returned failure — the file may not exist or the filecode is invalid.' });
    }
  }

  // --- Upload operations ---

  async uploadFile(params: UploadFileParams, _deps?: HostingAdapterDeps): Promise<ProviderUploadResult> {
    // Step 1: get the upload server URL (api_key injected by this.url()).
    const serverRes = await this.http({ method: 'GET', url: this.url('/v1/upload/server') });
    const uploadUrl = extractVidaraUploadServerUrl(serverRes.json as VidaraUploadServerResponse);

    // Step 2: multipart POST to the upload server.
    // VERIFIED CONTRACT (live API, 2026-09-29): the upload server
    // (e.g. https://upl4.s1q2105.com/api/upload) REQUIRES the api_key
    // as a query parameter. Without it, the upload server returns 401
    // "Missing API key". The previous implementation did NOT append
    // api_key to the upload URL — this was the second root cause of
    // the Vidara local upload failure (the browser-direct upload got
    // 401 from the upload server).
    const authenticatedUploadUrl = buildVidaraUrl(uploadUrl, '', null, this.config.apiKey);

    const formData = new FormData();
    formData.append('file', params.content instanceof Blob ? params.content : new Blob([params.content]), params.filename);
    if (params.title) formData.append('title', params.title);
    if (params.providerFolderId) formData.append('folder_id', params.providerFolderId);

    const uploadRes = await this.http({
      method: 'POST',
      url: authenticatedUploadUrl,
      formData,
      timeoutMs: 120_000, // uploads may take longer.
    });
    return normalizeVidaraUploadResult(uploadRes.json as VidaraUploadResultResponse);
  }

  /**
   * Remote URL upload — asks Vidara to fetch a URL.
   *
   * VERIFIED CONTRACT (live API, 2026-09-29):
   *   GET /v1/upload/url?api_key=<key>&url=<remote_url> →
   *   {
   *     "data": {
   *       "filecode": "70c79656afdf",
   *       "link": "https://vidara.to/70c79656afdf",
   *       "size": 469771811,
   *       "title": "..."
   *     },
   *     "msg": "OK",
   *     "status": 200
   *   }
   *
   * The method is **GET** (NOT POST), and the URL is a **query parameter**
   * (NOT in the request body). The previous implementation used POST with
   * a JSON body — Vidara returned 400 "missing url parameter". This was
   * the root cause of the Vidara remote URL upload failure.
   *
   * The Sootio URL that the user tested works via the Vidara dashboard
   * because the dashboard uses this same GET endpoint. The previous
   * Mavero implementation used the wrong HTTP method.
   */
  async uploadRemote(params: UploadRemoteParams, _deps?: HostingAdapterDeps): Promise<ProviderUploadResult> {
    const res = await this.http({
      method: 'GET',
      url: this.url('/v1/upload/url', { url: params.url }),
    });
    return normalizeVidaraUploadResult(res.json as VidaraUploadResultResponse);
  }

  // --- Processing status ---

  /**
   * Gets the processing status of a Vidara asset.
   *
   * VERIFIED CONTRACT (live API, 2026-09-29):
   *   GET /v1/video/info?filecode=<code>&api_key=<key> →
   *   {
   *     "result": [
   *       {
   *         "status": "active" | "pending" | ...,
   *         "filecode": "<code>",
   *         "link": "https://vidara.to/<code>",
   *         "file_active": 1 | 0,
   *         "video_length": "00:01:30",
   *         "video_title": "...",
   *         ...
   *       }
   *     ]
   *   }
   *
   * The endpoint `/v1/video/encoding_status` returns 404 — it does NOT
   * exist on the current Vidara API. The status is obtained from
   * `/v1/video/info` which returns the `status` field as a STRING
   * ("active", "pending", etc.) and `file_active` as a number (1=active, 0=inactive).
   *
   * The previous implementation used `/v1/video/encoding_status` — this
   * was the root cause of the Vidara remote upload being stuck in
   * PROCESSING: the polling endpoint returned 404, the error was caught,
   * and the operation never transitioned to ready.
   *
   * We now use `/v1/video/info` and normalize the result through
   * `normalizeVidaraFileInfo` → `normalizeVidaraFile` → `vidaraStatusMapper`.
   */
  async getProcessingStatus(providerAssetId: string, _deps?: HostingAdapterDeps): Promise<ProviderProcessingStatus> {
    return this.withReadRetry(async () => {
      const res = await this.http({
        method: 'GET',
        url: this.url('/v1/video/info', { filecode: providerAssetId }),
      });
      if (!res.json) {
        throw new HostingProviderError('NOT_FOUND', { message: 'Vidara processing status response was empty or non-JSON.' });
      }
      const assetInfo = normalizeVidaraFileInfo(res.json as VidaraFileInfoResponse);
      return normalizeVidaraProcessingStatus(assetInfo);
    });
  }

  // --- Folder operations ---

  async listFolders(parentFolderId: string | null, _deps?: HostingAdapterDeps): Promise<ProviderFolderInfo[]> {
    return this.withReadRetry(async () => {
      const res = await this.http({ method: 'GET', url: this.url('/v1/folder/list') });
      return normalizeVidaraFolderList(res.json as VidaraFolderListResponse);
    });
  }

  async createFolder(params: CreateFolderParams, _deps?: HostingAdapterDeps): Promise<ProviderFolderInfo> {
    // Vidara folders are flat — parentFolderId is ignored (nestedFolders = false).
    const res = await this.http({
      method: 'POST',
      url: this.url('/v1/folder/create'),
      body: { name: params.name },
    });
    const data = res.json as VidaraOperationResponse & { data?: { folder_id?: string } };
    if (!data.result) throw new HostingProviderError('VALIDATION', { message: 'Vidara folder create returned failure.' });
    // Re-list to find the newly created folder (Vidara may not return it directly).
    const folders = await this.listFolders(null);
    const found = folders.find((f) => f.name === params.name);
    return found ?? { providerFolderId: String(data.data?.folder_id ?? ''), name: params.name, parentFolderId: null, childCount: null, raw: data as Record<string, unknown> };
  }

  async renameFolder(providerFolderId: string, newName: string, _deps?: HostingAdapterDeps): Promise<ProviderFolderInfo> {
    const res = await this.http({
      method: 'POST',
      url: this.url('/v1/folder/rename'),
      body: { folder_id: providerFolderId, name: newName },
    });
    if (!(res.json as VidaraOperationResponse)?.result) {
      throw new HostingProviderError('VALIDATION', { message: 'Vidara folder rename returned failure.' });
    }
    return { providerFolderId, name: newName, parentFolderId: null, childCount: null, raw: res.json as Record<string, unknown> };
  }

  async moveFolder(_providerFolderId: string, _targetParentFolderId: string | null, _deps?: HostingAdapterDeps): Promise<ProviderFolderInfo> {
    // Vidara folders are flat — moving folders is not supported.
    throw new HostingProviderError('UNSUPPORTED', { message: 'Vidara does not support nested folders; folder move is not available.' });
  }

  async deleteFolder(providerFolderId: string, _deps?: HostingAdapterDeps): Promise<void> {
    const res = await this.http({
      method: 'POST',
      url: this.url('/v1/folder/delete'),
      body: { folder_id: providerFolderId },
    });
    if (!(res.json as VidaraOperationResponse)?.result) {
      throw new HostingProviderError('VALIDATION', { message: 'Vidara folder delete returned failure.' });
    }
  }

  // --- Subtitle operations ---

  async uploadSubtitle(params: UploadSubtitleParams, _deps?: HostingAdapterDeps): Promise<void> {
    const formData = new FormData();
    formData.append('file', new Blob([params.content]), params.filename);
    formData.append('file_code', params.providerAssetId);
    formData.append('lang', params.language);
    if (params.isDefault) formData.append('default', '1');

    const res = await this.http({
      method: 'POST',
      url: this.url('/v1/subtitle/upload'),
      formData,
    });
    if (!(res.json as VidaraOperationResponse)?.result) {
      throw new HostingProviderError('VALIDATION', { message: 'Vidara subtitle upload returned failure.' });
    }
  }

  // --- Thumbnail operations ---

  async uploadThumbnail(providerAssetId: string, thumbnailData: { url: string } | { base64: string }, _deps?: HostingAdapterDeps): Promise<void> {
    const body: Record<string, unknown> = { file_code: providerAssetId };
    if ('url' in thumbnailData) body.url = thumbnailData.url;
    else body.image = thumbnailData.base64;

    const res = await this.http({
      method: 'POST',
      url: this.url('/v1/video/thumbnail'),
      body,
    });
    if (!(res.json as VidaraOperationResponse)?.result) {
      throw new HostingProviderError('VALIDATION', { message: 'Vidara thumbnail upload returned failure.' });
    }
  }
}
