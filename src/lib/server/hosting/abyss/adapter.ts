/**
 * AbyssAdapter — Phase 3 implementation.
 *
 * Implements the `HostingProviderAdapter` interface for the Abyss
 * hosting provider.
 *
 * CRITICAL — Abyss generic URL remote upload (user task brief §2):
 *   Phase 0 §3.2.1 verified that Abyss's DASHBOARD accepts a generic
 *   external direct-file URL (an .mp4 URL that was NOT Google Drive)
 *   and successfully ingests it. However, the exact API
 *   endpoint/contract (request path, payload shape, auth scope) was
 *   NOT identified — the Phase 0 audit did not have provider API
 *   credentials to perform a live API call.
 *
 *   Therefore `uploadRemote()` is EXPLICITLY UNSUPPORTED in Phase 3.
 *   The method throws `HostingProviderError('UNSUPPORTED')` with a
 *   message documenting WHY. Google Drive remote import IS supported
 *   (it's explicitly documented in the Abyss API).
 *
 *   Phase 3 MUST NOT silently substitute Google Drive import for
 *   generic URL upload (user task brief §2).
 *
 * Direct vs embed semantics (user task brief §9):
 *   Abyss returns `https://player.abyssplayer.com/<slug>` as the
 *   playback URL. This is a PLAYER/EMBED URL, NOT a raw media
 *   stream. The adapter stores it as `playbackUrl` and does NOT
 *   extract/scrape raw HLS/MP4 URLs from the player page.
 *
 * Capability model (plan §3.2 + §6 + Phase 0 §3.2.1):
 *   - localUpload: true (multipart upload endpoint)
 *   - remoteUpload: false (generic URL remote upload NOT API-verified)
 *   - remoteUploadTypes: [] (empty — no verified remote upload types)
 *   - folderManagement: true (create, list, get, rename, move, delete)
 *   - nestedFolders: true (Abyss supports nested folders)
 *   - subtitles: true (list, upload, delete)
 *   - multiAudio: false (Abyss uses original/single audio — plan §3.2)
 *   - transcoding: true (one upload → 480p/720p/1080p variants)
 *   - qualityVariants: true (provider reports quality variants)
 *   - processingStatus: true (file status field)
 *   - rename: true, move: true, delete: true
 *   - thumbnails: false (not documented in the supplied Abyss API docs)
 *
 * JWT token handling:
 *   The adapter logs in via POST /auth/login and caches the JWT
 *   token with its expiry. Subsequent requests use the cached token.
 *   When the token expires, the adapter re-logs-in transparently.
 *   The token is NEVER exposed to the client — it lives only in the
 *   adapter instance (server-side memory).
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
import type { AbyssConfig } from './config';
import type {
  AbyssLoginResponse,
  AbyssAboutResponse,
  AbyssFileListResponse,
  AbyssFolderListResponse,
  AbyssUploadResponse,
  AbyssOperationResponse,
  AbyssFile,
  AbyssFolder,
} from './types';
import {
  normalizeAbyssAccount,
  normalizeAbyssFileList,
  normalizeAbyssFolderList,
  normalizeAbyssUploadResult,
  normalizeAbyssProcessingStatus,
  normalizeAbyssFile,
  normalizeAbyssFolder,
  abyssNextPageToken,
} from './normalize';

// ---------------------------------------------------------------------------
// Capability model
// ---------------------------------------------------------------------------

const ABYSS_CAPABILITIES: ProviderCapabilities = {
  localUpload: true,
  remoteUpload: false, // NOT API-verified — see module doc.
  remoteUploadTypes: [] as const, // No verified remote upload types.
  folderManagement: true,
  nestedFolders: true,
  subtitles: true,
  multiAudio: false, // Plan §3.2: original/single audio.
  transcoding: true, // Plan §3.2: 480p/720p/1080p processing.
  qualityVariants: true,
  processingStatus: true,
  rename: true,
  move: true,
  delete: true,
  thumbnails: false, // Not documented in the supplied Abyss API docs.
};

// ---------------------------------------------------------------------------
// Token cache
// ---------------------------------------------------------------------------

type TokenCache = {
  token: string;
  expiresAt: number; // epoch ms
};

const TOKEN_TTL_MS = 50 * 60 * 1000; // 50 minutes (conservative — JWT typically lasts 60 min).

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export type AbyssAdapterOptions = {
  config: AbyssConfig;
  /** Override the HTTP fetcher (for testing). */
  httpFetcher?: HostingHttpFetcher;
};

export class AbyssAdapter implements HostingProviderAdapter {
  readonly providerKey: HostingProviderKey = 'abyss';
  private readonly config: AbyssConfig;
  private readonly http: HostingHttpFetcher;
  private tokenCache: TokenCache | null = null;
  /**
   * Concurrent login guard (Abyss fix §4). When multiple requests hit
   * `ensureToken()` simultaneously with an expired/missing token, they
   * all share the SAME in-flight login promise — so only ONE login
   * HTTP request is made. Without this, N concurrent requests would
   * trigger N logins (wasteful + can trigger rate limits).
   */
  private inflightLogin: Promise<string> | null = null;
  /**
   * Permanent auth-failure guard (Abyss fix §4). If login itself
   * returns AUTHENTICATION (e.g. wrong credentials), we MUST NOT
   * retry forever. This flag is set when login fails with AUTHENTICATION
   * and prevents the `authedRequest` retry loop from re-attempting.
   */
  private loginPermanentlyFailed = false;

  constructor(options: AbyssAdapterOptions) {
    this.config = options.config;
    // Initial fetcher has no auth — login will produce a JWT and
    // the adapter will create a new authenticated fetcher.
    this.http = options.httpFetcher ?? createHostingHttpFetcher(null);
  }

  /**
   * Bounded retry wrapper for read-only provider operations.
   * Retries transient failures (5xx, network, timeout, rate limit) up to
   * 3 attempts with exponential backoff + jitter. Does NOT retry permanent
   * errors (AUTHENTICATION, VALIDATION, NOT_FOUND, UNSUPPORTED).
   *
   * This is the SINGLE retry boundary for Abyss read operations. The Abyss
   * `authedRequest` 401-retry-once for JWT refresh is NOT a `withRetry`
   * call — it's explicit single-retry logic that fires only on AUTHENTICATION
   * errors (which `withRetry` does NOT retry). So there is NO retry
   * amplification: withRetry handles transient retries, authedRequest
   * handles token refresh.
   *
   * Write operations (upload, rename, move, delete) are NOT retried because
   * they have side effects and repeating them could create duplicates or
   * corrupt provider state.
   */
  private async withReadRetry<T>(fn: () => Promise<T>): Promise<T> {
    return withRetry(fn, 3, 500, 5_000);
  }

  getCapabilities(): ProviderCapabilities {
    return ABYSS_CAPABILITIES;
  }

  // --- JWT login + token management ---

  /**
   * Logs in to Abyss and caches the JWT token. Called lazily on the
   * first authenticated request. The token is NEVER returned to the
   * caller — it stays in the adapter instance.
   *
   * Robustness (Abyss fix §3/§4):
   *   - Handles null/empty/non-JSON login responses without throwing
   *     "Unexpected end of JSON input".
   *   - Concurrent calls share a single in-flight login promise.
   *   - Permanent auth failure (login itself returns 401) sets a flag
   *     that prevents infinite retry loops in `authedRequest`.
   */
  private async ensureToken(): Promise<string> {
    if (this.loginPermanentlyFailed) {
      throw new HostingProviderError('AUTHENTICATION', { message: 'Abyss login is permanently failed. Check ABYSS_EMAIL / ABYSS_PASSWORD server-side credentials.' });
    }
    if (this.tokenCache && this.tokenCache.expiresAt > Date.now()) {
      return this.tokenCache.token;
    }

    // Concurrent login guard — if a login is already in flight, wait
    // for it instead of starting a duplicate request.
    if (this.inflightLogin) {
      return this.inflightLogin;
    }

    this.inflightLogin = this.doLogin();
    try {
      return await this.inflightLogin;
    } finally {
      this.inflightLogin = null;
    }
  }

  private async doLogin(): Promise<string> {
    // Login uses the unauthenticated fetcher (no JWT yet).
    // The shared HTTP client captures the raw text + content type for
    // ALL responses, so a null `res.json` means the response was empty
    // or non-JSON — NOT a parse exception.
    let res;
    try {
      res = await this.http({
        method: 'POST',
        url: `${this.config.baseUrl}/auth/login`,
        body: { email: this.config.email, password: this.config.password },
      });
    } catch (error) {
      // If login itself returns 401/403, mark as permanently failed
      // so we don't retry forever in authedRequest.
      if (error instanceof HostingProviderError && error.code === 'AUTHENTICATION') {
        this.loginPermanentlyFailed = true;
      }
      throw error;
    }

    // res.json may be null when:
    //   - the response body is empty (Unexpected end of JSON input)
    //   - the response is non-JSON (e.g. text/html from a misconfigured proxy)
    //   - the JSON is malformed
    // In ALL these cases, we throw a typed AUTHENTICATION error with a
    // safe message — NEVER "Unexpected end of JSON input".
    if (!res.json || typeof res.json !== 'object') {
      throw new HostingProviderError('AUTHENTICATION', { message: 'Abyss login response was empty or non-JSON. Check server-side credentials and API base URL.' });
    }

    const loginData = res.json as AbyssLoginResponse;
    const token = loginData.token ?? loginData.access_token ?? loginData.jwt;
    if (!token || typeof token !== 'string') {
      throw new HostingProviderError('AUTHENTICATION', { message: 'Abyss login did not return a JWT token. Check server-side credentials.' });
    }

    // VERIFIED CONTRACT: POST /auth/login → { token: "jwt-token-here",
    // expiresIn: 3600 } (camelCase). `expires_in` is kept as a tolerated
    // legacy spelling.
    const expiresInSeconds = loginData.expires_in ?? (loginData as { expiresIn?: number }).expiresIn;
    const expiresInMs = expiresInSeconds ? expiresInSeconds * 1000 : TOKEN_TTL_MS;
    this.tokenCache = { token, expiresAt: Date.now() + Math.min(expiresInMs, TOKEN_TTL_MS) };
    return token;
  }

  /**
   * Makes an authenticated request. Logs in (or reuses cached JWT)
   * before the request, then adds the Authorization header to the
   * request and delegates to the injected HTTP fetcher. If a 401 is
   * received, clears the token cache and retries ONCE.
   *
   * Permanent-auth-failure guard (Abyss fix §4): if login is
   * permanently failed (login itself returned 401), the retry is
   * skipped — we throw immediately to prevent an infinite loop.
   */
  private async authedRequest(request: Parameters<HostingHttpFetcher>[0]): Promise<Awaited<ReturnType<HostingHttpFetcher>>> {
    const token = await this.ensureToken();
    const authedRequest: Parameters<HostingHttpFetcher>[0] = {
      ...request,
      headers: { ...request.headers, authorization: `Bearer ${token}` },
    };
    try {
      return await this.http(authedRequest);
    } catch (error) {
      // Only retry on AUTHENTICATION (401) AND when login is NOT
      // permanently failed. This prevents infinite retry loops when
      // the credentials are wrong (login succeeds with a token that
      // is immediately rejected — we retry once, get 401 again, and
      // if login still succeeds we'd loop forever without this guard).
      if (error instanceof HostingProviderError && error.code === 'AUTHENTICATION' && !this.loginPermanentlyFailed) {
        // Token may have expired — clear cache and retry once.
        this.tokenCache = null;
        const newToken = await this.ensureToken();
        const retryRequest: Parameters<HostingHttpFetcher>[0] = {
          ...request,
          headers: { ...request.headers, authorization: `Bearer ${newToken}` },
        };
        return this.http(retryRequest);
      }
      throw error;
    }
  }

  // --- Account ---

  async getAccountInfo(_deps?: HostingAdapterDeps): Promise<ProviderAccountInfo> {
    return this.withReadRetry(async () => {
      const res = await this.authedRequest({ method: 'GET', url: `${this.config.baseUrl}/v1/about` });
      if (!res.json) {
        throw new HostingProviderError('AUTHENTICATION', { message: 'Abyss account info response was empty or non-JSON.' });
      }
      return normalizeAbyssAccount(res.json as AbyssAboutResponse);
    });
  }

  // --- File / asset operations ---

  async getAsset(providerAssetId: string, _deps?: HostingAdapterDeps): Promise<ProviderAssetInfo> {
    return this.withReadRetry(async () => {
      const res = await this.authedRequest({ method: 'GET', url: `${this.config.baseUrl}/v1/files/${encodeURIComponent(providerAssetId)}` });
      if (!res.json) {
        throw new HostingProviderError('NOT_FOUND', { message: 'Abyss file info response was empty or non-JSON.' });
      }
      const file = (res.json as { data?: AbyssFile })?.data ?? res.json as AbyssFile;
      if (!file) throw new HostingProviderError('NOT_FOUND', { message: 'Abyss file info response contained no file data.' });
      return normalizeAbyssFile(file);
    });
  }

  async listAssets(providerFolderId: string | null, _deps?: HostingAdapterDeps): Promise<ProviderAssetInfo[]> {
    return this.withReadRetry(async () => {
      // VERIFIED CONTRACT (official dashboard bundle, 2026-10-04):
      //   GET /v1/resources?type=files&maxResults=100&orderBy=createdAt:desc
      //   [&folderId=<id>] [&pageToken=<token>]
      //   → { name, breadcrumbs, domainEmbed, items: [files+folders],
      //       pageToken: <next|null> }
      //
      //   * `type=files` filters the listing to file rows (the API
      //     otherwise mixes folders into `items`; the normalizer ALSO
      //     filters isDir rows defensively).
      //   * `folderId` (camelCase — the previous `folder_id` param was
      //     silently ignored by the API, scoping every listing to root).
      //   * `maxResults` is capped at 100 by the API and DEFAULTS TO 25 —
      //     without pagination the inventory silently truncates at 25
      //     files. We page with `pageToken` until it is absent.
      //   * A non-JSON response throws (below) — it can NEVER silently
      //     report an empty inventory (the zero-file false-success bug).
      const assets: ProviderAssetInfo[] = [];
      const MAX_PAGES = 25; // 25 pages × 100 rows = 2500 files — sanity cap against a runaway loop.
      let pageToken: string | null = null;
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const params = new URLSearchParams();
        params.set('type', 'files');
        params.set('maxResults', '100');
        params.set('orderBy', 'createdAt:desc');
        if (providerFolderId) params.set('folderId', providerFolderId);
        if (pageToken) params.set('pageToken', pageToken);
        const res = await this.authedRequest({
          method: 'GET',
          url: `${this.config.baseUrl}/v1/resources?${params}`,
        });
        if (!res.json) {
          throw new HostingProviderError('VALIDATION', {
            message: `Abyss resources response was empty or non-JSON (content-type: ${res.contentType || 'missing'}). Inventory discovery failed — refusing to report a false zero-file success.`,
          });
        }
        const pageAssets = normalizeAbyssFileList(res.json as AbyssFileListResponse);
        assets.push(...pageAssets);
        pageToken = abyssNextPageToken(res.json as AbyssFileListResponse);
        if (!pageToken) break;
      }
      return assets;
    });
  }

  async renameAsset(providerAssetId: string, newName: string, _deps?: HostingAdapterDeps): Promise<ProviderAssetInfo> {
    await this.authedRequest({
      method: 'PUT',
      url: `${this.config.baseUrl}/v1/files/${encodeURIComponent(providerAssetId)}`,
      body: { name: newName },
    });
    return this.getAsset(providerAssetId);
  }

  async moveAsset(providerAssetId: string, targetFolderId: string | null, _deps?: HostingAdapterDeps): Promise<ProviderAssetInfo> {
    // VERIFIED CONTRACT: PATCH /v1/files/:id with query param `parentId`
    // (the folder to move into; omitted → root). The previous body
    // {folder_id} form was ignored by the API.
    const params = new URLSearchParams();
    if (targetFolderId) params.set('parentId', targetFolderId);
    const url = `${this.config.baseUrl}/v1/files/${encodeURIComponent(providerAssetId)}/move${params.size ? `?${params}` : ''}`;
    await this.authedRequest({ method: 'PATCH', url });
    return this.getAsset(providerAssetId);
  }

  async deleteAsset(providerAssetId: string, _deps?: HostingAdapterDeps): Promise<void> {
    await this.authedRequest({
      method: 'DELETE',
      url: `${this.config.baseUrl}/v1/files/${encodeURIComponent(providerAssetId)}`,
    });
  }

  // --- Upload operations ---

  /**
   * Uploads a local file to Abyss via multipart form data.
   *
   * VERIFIED CONTRACT (live API + dashboard JS, 2026-09-29):
   *   POST http://up.abyss.to/:key
   *   - multipart/form-data with field name "file"
   *   - `:key` is the Abyss **apiKey** (NOT the JWT from login)
   *   - response: { slug: "file-id" }
   *
   * The apiKey is a SEPARATE credential from the email+password JWT.
   * It is obtained from the Abyss dashboard settings page. The JWT
   * from POST /auth/login CANNOT be used as the apiKey — it returns
   * 401 from up.abyss.to.
   *
   * The previous implementation used POST {baseUrl}/v1/upload with
   * JWT Bearer auth — but that endpoint returns 404 "Path not found"
   * on the real Abyss API (api.abyss.to). This was the root cause
   * of the Abyss local upload failure.
   *
   * If the Abyss apiKey is not configured (ABYSS_API_KEY env var is
   * not set), this method throws UNSUPPORTED — the upload cannot
   * proceed without the apiKey. This is a provider-level limitation,
   * not an implementation bug.
   *
   * Robustness:
   *   - Preserves the MIME type from the Blob (when the caller passes a
   *     Blob, which carries its own type). When the caller passes an
   *     ArrayBuffer, we construct a Blob with the filename's inferred
   *     MIME type.
   *   - Handles null/empty/non-JSON upload responses with typed errors.
   *   - Validates that the normalized result contains a non-empty
   *     providerAssetId before returning success.
   */
  async uploadFile(params: UploadFileParams, _deps?: HostingAdapterDeps): Promise<ProviderUploadResult> {
    // The upload endpoint requires the Abyss apiKey (NOT the JWT).
    // If the apiKey is not configured, fail with a clear UNSUPPORTED
    // error explaining the requirement.
    if (!this.config.apiKey) {
      throw new HostingProviderError('UNSUPPORTED', {
        message: 'Abyss upload requires an API key (ABYSS_API_KEY). The JWT from email+password login cannot be used for uploads. Generate an API key in the Abyss dashboard settings and set ABYSS_API_KEY in the deployment secret manager.',
      });
    }

    const formData = new FormData();
    // Preserve MIME type: if the caller passed a Blob, use it directly
    // (Blob carries its own type). If the caller passed an ArrayBuffer
    // (as the proxy-upload route does), construct a Blob with the
    // filename's extension to infer a MIME type — defaulting to
    // application/octet-stream.
    let fileBlob: Blob;
    if (params.content instanceof Blob) {
      fileBlob = params.content;
    } else {
      // ArrayBuffer — infer MIME from filename extension.
      const mimeType = inferMimeType(params.filename);
      fileBlob = new Blob([params.content], { type: mimeType });
    }
    formData.append('file', fileBlob, params.filename);

    // VERIFIED: the upload endpoint is http://up.abyss.to/:key
    // The apiKey goes in the URL path (NOT as a query parameter or header).
    // The upload server does NOT accept the JWT Bearer token — only the apiKey.
    const uploadUrl = `https://up.abyss.to/${this.config.apiKey}`;

    // Use the UNAUTHENTICATED fetcher (no Bearer header) — the apiKey
    // is in the URL path, not in an Authorization header.
    const res = await this.http({
      method: 'POST',
      url: uploadUrl,
      formData,
      timeoutMs: 120_000, // uploads may take longer.
    });

    // Handle null/empty/non-JSON upload responses.
    if (!res.json) {
      throw new HostingProviderError('VALIDATION', {
        message: res.text
          ? `Abyss upload response was not valid JSON (content-type: ${res.contentType || 'missing'}). Upload may not have completed.`
          : 'Abyss upload response was empty. The upload may not have completed — no provider asset ID was returned.',
      });
    }

    const result = normalizeAbyssUploadResult(res.json as AbyssUploadResponse);

    // Do NOT accept an upload as successful when the provider asset
    // identifier is missing.
    if (!result.providerAssetId) {
      throw new HostingProviderError('VALIDATION', {
        message: 'Abyss upload response did not contain a provider asset ID (slug or file ID). The upload may not have completed.',
      });
    }

    return result;
  }

  /**
   * CRITICAL: generic URL remote upload is UNSUPPORTED.
   *
   * Phase 0 §3.2.1 verified that Abyss's DASHBOARD accepts a generic
   * external direct-file URL. However, the exact API endpoint/
   * contract was NOT identified. The supplied Abyss API docs only
   * explicitly document Google Drive remote import.
   *
   * This method throws `UNSUPPORTED`. Google Drive import can be
   * added as a separate method (e.g. `importFromGoogleDrive`) in a
   * future phase when the contract is needed. Phase 3 MUST NOT
   * silently substitute Google Drive import for generic URL upload
   * (user task brief §2).
   */
  async uploadRemote(_params: UploadRemoteParams, _deps?: HostingAdapterDeps): Promise<ProviderUploadResult> {
    throw new HostingProviderError('UNSUPPORTED', {
      message: 'Abyss generic URL remote upload is not API-verified. Phase 0 §3.2.1 confirmed dashboard-level support but the API endpoint/contract was not identified. Google Drive import IS documented.',
    });
  }

  // --- Processing status ---

  async getProcessingStatus(providerAssetId: string, _deps?: HostingAdapterDeps): Promise<ProviderProcessingStatus> {
    return this.withReadRetry(async () => {
      const res = await this.authedRequest({
        method: 'GET',
        url: `${this.config.baseUrl}/v1/files/${encodeURIComponent(providerAssetId)}`,
      });
      if (!res.json) {
        throw new HostingProviderError('NOT_FOUND', { message: 'Abyss processing status response was empty or non-JSON.' });
      }
      const file = (res.json as { data?: AbyssFile })?.data ?? res.json as AbyssFile;
      if (!file) throw new HostingProviderError('NOT_FOUND', { message: 'Abyss file info response contained no file data.' });
      return normalizeAbyssProcessingStatus(file);
    });
  }

  // --- Folder operations ---

  async listFolders(parentFolderId: string | null, _deps?: HostingAdapterDeps): Promise<ProviderFolderInfo[]> {
    return this.withReadRetry(async () => {
      // VERIFIED CONTRACT: the folder listing endpoint is
      // GET /v1/folders/list with `folderId` + `maxResults` + `pageToken`
      // (the previous GET /v1/folders with `parent_id` was not the
      // documented list endpoint). Pagination follows `pageToken`.
      const folders: ProviderFolderInfo[] = [];
      const MAX_PAGES = 25;
      let pageToken: string | null = null;
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const params = new URLSearchParams();
        params.set('maxResults', '100');
        if (parentFolderId) params.set('folderId', parentFolderId);
        if (pageToken) params.set('pageToken', pageToken);
        const res = await this.authedRequest({
          method: 'GET',
          url: `${this.config.baseUrl}/v1/folders/list?${params}`,
        });
        if (!res.json) {
          throw new HostingProviderError('VALIDATION', {
            message: `Abyss folders response was empty or non-JSON (content-type: ${res.contentType || 'missing'}).`,
          });
        }
        const pageFolders = normalizeAbyssFolderList(res.json as AbyssFolderListResponse);
        folders.push(...pageFolders);
        pageToken = abyssNextPageToken(res.json as AbyssFolderListResponse);
        if (!pageToken) break;
      }
      return folders;
    });
  }

  async createFolder(params: CreateFolderParams, _deps?: HostingAdapterDeps): Promise<ProviderFolderInfo> {
    // VERIFIED CONTRACT: POST /v1/folders body { name, parentId }, response
    // is the FLAT folder object { id, name, createdAt, updatedAt } (the
    // dashboard docs show no `data` wrapper — a wrapped legacy shape is
    // tolerated).
    const body: Record<string, unknown> = { name: params.name };
    if (params.parentFolderId) body.parentId = params.parentFolderId;

    const res = await this.authedRequest({
      method: 'POST',
      url: `${this.config.baseUrl}/v1/folders`,
      body,
    });
    if (!res.json) {
      throw new HostingProviderError('VALIDATION', { message: 'Abyss folder create response was empty or non-JSON.' });
    }
    const data = res.json as AbyssOperationResponse & { data?: AbyssFolder };
    const folder = (data.data as AbyssFolder | undefined) ?? (res.json as AbyssFolder);
    if (!folder || (folder.id == null && folder.name == null)) {
      throw new HostingProviderError('VALIDATION', { message: 'Abyss folder create did not return folder data.' });
    }
    return normalizeAbyssFolder(folder);
  }

  async renameFolder(providerFolderId: string, newName: string, _deps?: HostingAdapterDeps): Promise<ProviderFolderInfo> {
    const res = await this.authedRequest({
      method: 'PUT',
      url: `${this.config.baseUrl}/v1/folders/${encodeURIComponent(providerFolderId)}`,
      body: { name: newName },
    });
    // VERIFIED CONTRACT: the response is the FLAT folder object; a wrapped
    // legacy shape is tolerated; an empty 200 degrades gracefully.
    if (!res.json) return { providerFolderId, name: newName, parentFolderId: null, childCount: null, raw: {} };
    const data = res.json as AbyssOperationResponse & { data?: AbyssFolder };
    const folder = (data.data as AbyssFolder | undefined) ?? (res.json as AbyssFolder);
    if (!folder || (folder.id == null && folder.name == null)) return { providerFolderId, name: newName, parentFolderId: null, childCount: null, raw: data as Record<string, unknown> };
    return normalizeAbyssFolder(folder);
  }

  async moveFolder(providerFolderId: string, targetParentFolderId: string | null, _deps?: HostingAdapterDeps): Promise<ProviderFolderInfo> {
    // VERIFIED CONTRACT: PATCH /v1/folders/:id with query param `parentId`
    // (omitted → root). Response is the FLAT folder object (wrapped legacy
    // tolerated; empty 200 degrades gracefully).
    const params = new URLSearchParams();
    if (targetParentFolderId) params.set('parentId', targetParentFolderId);
    const url = `${this.config.baseUrl}/v1/folders/${encodeURIComponent(providerFolderId)}/move${params.size ? `?${params}` : ''}`;
    const res = await this.authedRequest({ method: 'PATCH', url });
    if (!res.json) return { providerFolderId, name: '', parentFolderId: targetParentFolderId, childCount: null, raw: {} };
    const data = res.json as AbyssOperationResponse & { data?: AbyssFolder };
    const folder = (data.data as AbyssFolder | undefined) ?? (res.json as AbyssFolder);
    if (!folder || (folder.id == null && folder.name == null)) return { providerFolderId, name: '', parentFolderId: targetParentFolderId, childCount: null, raw: data as Record<string, unknown> };
    return normalizeAbyssFolder(folder);
  }

  async deleteFolder(providerFolderId: string, _deps?: HostingAdapterDeps): Promise<void> {
    await this.authedRequest({
      method: 'DELETE',
      url: `${this.config.baseUrl}/v1/folders/${encodeURIComponent(providerFolderId)}`,
    });
  }

  // --- Subtitle operations ---

  async uploadSubtitle(params: UploadSubtitleParams, _deps?: HostingAdapterDeps): Promise<void> {
    const formData = new FormData();
    // Preserve subtitle MIME type (Abyss fix §5 — same as uploadFile).
    let subtitleBlob: Blob;
    if (params.content instanceof Blob) {
      subtitleBlob = params.content;
    } else {
      const mimeType = inferMimeType(params.filename);
      subtitleBlob = new Blob([params.content], { type: mimeType });
    }
    formData.append('file', subtitleBlob, params.filename);
    formData.append('language', params.language);
    if (params.isDefault) formData.append('default', '1');

    await this.authedRequest({
      method: 'POST',
      url: `${this.config.baseUrl}/v1/files/${encodeURIComponent(params.providerAssetId)}/subtitles`,
      formData,
    });
  }

  // --- Thumbnail operations ---

  async uploadThumbnail(_providerAssetId: string, _thumbnailData: { url: string } | { base64: string }, _deps?: HostingAdapterDeps): Promise<void> {
    throw new HostingProviderError('UNSUPPORTED', { message: 'Abyss does not support thumbnail upload (not documented in the supplied API).' });
  }
}

// ---------------------------------------------------------------------------
// MIME type inference helper (Abyss fix §5)
// ---------------------------------------------------------------------------

/**
 * Infers a MIME type from a filename's extension.
 *
 * Used by `uploadFile()` and `uploadSubtitle()` when the caller passes
 * an ArrayBuffer (which carries no MIME type) instead of a Blob. Without
 * this, the constructed Blob defaults to `application/octet-stream`,
 * which some providers reject or misinterpret.
 *
 * Returns `application/octet-stream` for unknown extensions — a safe
 * fallback that most providers accept.
 *
 * SECURITY: this function is pure and has no side effects. It only
 * inspects the filename's extension — it does NOT read file content.
 */
export function inferMimeType(filename: string | undefined | null): string {
  if (!filename) return 'application/octet-stream';
  const ext = filename.toLowerCase().split('.').pop() ?? '';
  switch (ext) {
    case 'mp4': return 'video/mp4';
    case 'mkv': return 'video/x-matroska';
    case 'webm': return 'video/webm';
    case 'mov': return 'video/quicktime';
    case 'avi': return 'video/x-msvideo';
    case 'm4v': return 'video/x-m4v';
    case 'srt': return 'application/x-subrip';
    case 'vtt': return 'text/vtt';
    case 'ass': return 'text/plain';
    default: return 'application/octet-stream';
  }
}
