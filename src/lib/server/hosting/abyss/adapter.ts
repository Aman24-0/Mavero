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
import { createHostingHttpFetcher } from '../http-client';
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

  constructor(options: AbyssAdapterOptions) {
    this.config = options.config;
    // Initial fetcher has no auth — login will produce a JWT and
    // the adapter will create a new authenticated fetcher.
    this.http = options.httpFetcher ?? createHostingHttpFetcher(null);
  }

  getCapabilities(): ProviderCapabilities {
    return ABYSS_CAPABILITIES;
  }

  // --- JWT login + token management ---

  /**
   * Logs in to Abyss and caches the JWT token. Called lazily on the
   * first authenticated request. The token is NEVER returned to the
   * caller — it stays in the adapter instance.
   */
  private async ensureToken(): Promise<string> {
    if (this.tokenCache && this.tokenCache.expiresAt > Date.now()) {
      return this.tokenCache.token;
    }

    // Login uses the unauthenticated fetcher (no JWT yet).
    const res = await this.http({
      method: 'POST',
      url: `${this.config.baseUrl}/auth/login`,
      body: { email: this.config.email, password: this.config.password },
    });

    const loginData = res.json as AbyssLoginResponse;
    const token = loginData.token ?? loginData.access_token ?? loginData.jwt;
    if (!token || typeof token !== 'string') {
      throw new HostingProviderError('AUTHENTICATION', { message: 'Abyss login did not return a JWT token.' });
    }

    const expiresInMs = (loginData.expires_in ? loginData.expires_in * 1000 : TOKEN_TTL_MS);
    this.tokenCache = { token, expiresAt: Date.now() + Math.min(expiresInMs, TOKEN_TTL_MS) };
    return token;
  }

  /**
   * Makes an authenticated request. Logs in (or reuses cached JWT)
   * before the request, then adds the Authorization header to the
   * request and delegates to the injected HTTP fetcher. If a 401 is
   * received, clears the token cache and retries once.
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
      if (error instanceof HostingProviderError && error.code === 'AUTHENTICATION') {
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
    const res = await this.authedRequest({ method: 'GET', url: `${this.config.baseUrl}/v1/about` });
    return normalizeAbyssAccount(res.json as AbyssAboutResponse);
  }

  // --- File / asset operations ---

  async getAsset(providerAssetId: string, _deps?: HostingAdapterDeps): Promise<ProviderAssetInfo> {
    const res = await this.authedRequest({ method: 'GET', url: `${this.config.baseUrl}/v1/files/${encodeURIComponent(providerAssetId)}` });
    const file = (res.json as { data?: AbyssFile })?.data ?? res.json as AbyssFile;
    if (!file) throw new HostingProviderError('NOT_FOUND', { message: 'Abyss file info response contained no file data.' });
    // Reuse normalizeAbyssFile for consistency.
    
    return normalizeAbyssFile(file);
  }

  async listAssets(providerFolderId: string | null, _deps?: HostingAdapterDeps): Promise<ProviderAssetInfo[]> {
    const params = new URLSearchParams();
    if (providerFolderId) params.set('folder_id', providerFolderId);
    const url = `${this.config.baseUrl}/v1/resources${params.size ? `?${params}` : ''}`;
    const res = await this.authedRequest({ method: 'GET', url });
    return normalizeAbyssFileList(res.json as AbyssFileListResponse);
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
    await this.authedRequest({
      method: 'PATCH',
      url: `${this.config.baseUrl}/v1/files/${encodeURIComponent(providerAssetId)}/move`,
      body: { folder_id: targetFolderId },
    });
    return this.getAsset(providerAssetId);
  }

  async deleteAsset(providerAssetId: string, _deps?: HostingAdapterDeps): Promise<void> {
    await this.authedRequest({
      method: 'DELETE',
      url: `${this.config.baseUrl}/v1/files/${encodeURIComponent(providerAssetId)}`,
    });
  }

  // --- Upload operations ---

  async uploadFile(params: UploadFileParams, _deps?: HostingAdapterDeps): Promise<ProviderUploadResult> {
    const formData = new FormData();
    formData.append('file', params.content instanceof Blob ? params.content : new Blob([params.content]), params.filename);
    if (params.providerFolderId) formData.append('folder_id', params.providerFolderId);
    if (params.title) formData.append('title', params.title);

    const res = await this.authedRequest({
      method: 'POST',
      url: `${this.config.baseUrl}/v1/upload`,
      formData,
      timeoutMs: 120_000, // uploads may take longer.
    });
    return normalizeAbyssUploadResult(res.json as AbyssUploadResponse);
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
    const res = await this.authedRequest({
      method: 'GET',
      url: `${this.config.baseUrl}/v1/files/${encodeURIComponent(providerAssetId)}`,
    });
    const file = (res.json as { data?: AbyssFile })?.data ?? res.json as AbyssFile;
    if (!file) throw new HostingProviderError('NOT_FOUND', { message: 'Abyss file info response contained no file data.' });
    return normalizeAbyssProcessingStatus(file);
  }

  // --- Folder operations ---

  async listFolders(parentFolderId: string | null, _deps?: HostingAdapterDeps): Promise<ProviderFolderInfo[]> {
    const params = new URLSearchParams();
    if (parentFolderId) params.set('parent_id', parentFolderId);
    const url = `${this.config.baseUrl}/v1/folders${params.size ? `?${params}` : ''}`;
    const res = await this.authedRequest({ method: 'GET', url });
    return normalizeAbyssFolderList(res.json as AbyssFolderListResponse);
  }

  async createFolder(params: CreateFolderParams, _deps?: HostingAdapterDeps): Promise<ProviderFolderInfo> {
    const body: Record<string, unknown> = { name: params.name };
    if (params.parentFolderId) body.parent_id = params.parentFolderId;

    const res = await this.authedRequest({
      method: 'POST',
      url: `${this.config.baseUrl}/v1/folders`,
      body,
    });
    const data = res.json as AbyssOperationResponse & { data?: AbyssFolder };
    const folder = data.data;
    if (!folder) throw new HostingProviderError('VALIDATION', { message: 'Abyss folder create did not return folder data.' });
    
    return normalizeAbyssFolder(folder);
  }

  async renameFolder(providerFolderId: string, newName: string, _deps?: HostingAdapterDeps): Promise<ProviderFolderInfo> {
    const res = await this.authedRequest({
      method: 'PUT',
      url: `${this.config.baseUrl}/v1/folders/${encodeURIComponent(providerFolderId)}`,
      body: { name: newName },
    });
    const data = res.json as AbyssOperationResponse & { data?: AbyssFolder };
    const folder = data.data;
    if (!folder) return { providerFolderId, name: newName, parentFolderId: null, childCount: null, raw: data as Record<string, unknown> };
    
    return normalizeAbyssFolder(folder);
  }

  async moveFolder(providerFolderId: string, targetParentFolderId: string | null, _deps?: HostingAdapterDeps): Promise<ProviderFolderInfo> {
    const res = await this.authedRequest({
      method: 'PATCH',
      url: `${this.config.baseUrl}/v1/folders/${encodeURIComponent(providerFolderId)}/move`,
      body: { parent_id: targetParentFolderId },
    });
    const data = res.json as AbyssOperationResponse & { data?: AbyssFolder };
    const folder = data.data;
    if (!folder) return { providerFolderId, name: '', parentFolderId: targetParentFolderId, childCount: null, raw: data as Record<string, unknown> };
    
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
    formData.append('file', new Blob([params.content]), params.filename);
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
