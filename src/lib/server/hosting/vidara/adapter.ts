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
import { createHostingHttpFetcher } from '../http-client';
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
    this.http = options.httpFetcher ?? createHostingHttpFetcher(`Bearer ${this.config.apiKey}`);
  }

  getCapabilities(): ProviderCapabilities {
    return VIDARA_CAPABILITIES;
  }

  // --- Account ---

  async getAccountInfo(_deps?: HostingAdapterDeps): Promise<ProviderAccountInfo> {
    const res = await this.http({ method: 'GET', url: `${this.config.baseUrl}/v1/account/info` });
    return normalizeVidaraAccount(res.json as VidaraAccountResponse);
  }

  // --- File / asset operations ---

  async getAsset(providerAssetId: string, _deps?: HostingAdapterDeps): Promise<ProviderAssetInfo> {
    const url = `${this.config.baseUrl}/v1/video/info?file_code=${encodeURIComponent(providerAssetId)}`;
    const res = await this.http({ method: 'GET', url });
    return normalizeVidaraFileInfo(res.json as VidaraFileInfoResponse);
  }

  async listAssets(providerFolderId: string | null, _deps?: HostingAdapterDeps): Promise<ProviderAssetInfo[]> {
    const params = new URLSearchParams();
    if (providerFolderId) params.set('folder_id', providerFolderId);
    const url = `${this.config.baseUrl}/v1/video/list${params.size ? `?${params}` : ''}`;
    const res = await this.http({ method: 'GET', url });
    return normalizeVidaraFileList(res.json as VidaraFileListResponse);
  }

  async renameAsset(providerAssetId: string, newName: string, _deps?: HostingAdapterDeps): Promise<ProviderAssetInfo> {
    const res = await this.http({
      method: 'POST',
      url: `${this.config.baseUrl}/v1/video/rename`,
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
      url: `${this.config.baseUrl}/v1/video/move`,
      body: { file_code: providerAssetId, folder_id: targetFolderId ?? '' },
    });
    if (!(res.json as VidaraOperationResponse)?.result) {
      throw new HostingProviderError('VALIDATION', { message: 'Vidara move returned failure.' });
    }
    return this.getAsset(providerAssetId);
  }

  async deleteAsset(providerAssetId: string, _deps?: HostingAdapterDeps): Promise<void> {
    const res = await this.http({
      method: 'POST',
      url: `${this.config.baseUrl}/v1/video/delete`,
      body: { file_code: providerAssetId },
    });
    if (!(res.json as VidaraOperationResponse)?.result) {
      throw new HostingProviderError('VALIDATION', { message: 'Vidara delete returned failure.' });
    }
  }

  // --- Upload operations ---

  async uploadFile(params: UploadFileParams, _deps?: HostingAdapterDeps): Promise<ProviderUploadResult> {
    // Step 1: get the upload server URL.
    const serverRes = await this.http({ method: 'GET', url: `${this.config.baseUrl}/v1/upload/server` });
    const uploadUrl = extractVidaraUploadServerUrl(serverRes.json as VidaraUploadServerResponse);

    // Step 2: multipart POST to the upload server.
    const formData = new FormData();
    formData.append('file', params.content instanceof Blob ? params.content : new Blob([params.content]), params.filename);
    if (params.title) formData.append('title', params.title);
    if (params.providerFolderId) formData.append('folder_id', params.providerFolderId);

    const uploadRes = await this.http({
      method: 'POST',
      url: uploadUrl,
      formData,
      timeoutMs: 120_000, // uploads may take longer.
    });
    return normalizeVidaraUploadResult(uploadRes.json as VidaraUploadResultResponse);
  }

  async uploadRemote(params: UploadRemoteParams, _deps?: HostingAdapterDeps): Promise<ProviderUploadResult> {
    const res = await this.http({
      method: 'POST',
      url: `${this.config.baseUrl}/v1/upload/url`,
      body: {
        url: params.url,
        folder_id: params.providerFolderId ?? '',
        filename: params.filename ?? '',
        title: params.title ?? '',
      },
    });
    return normalizeVidaraUploadResult(res.json as VidaraUploadResultResponse);
  }

  // --- Processing status ---

  async getProcessingStatus(providerAssetId: string, _deps?: HostingAdapterDeps): Promise<ProviderProcessingStatus> {
    const res = await this.http({
      method: 'GET',
      url: `${this.config.baseUrl}/v1/video/encoding_status?file_code=${encodeURIComponent(providerAssetId)}`,
    });
    return normalizeVidaraEncodingStatus(res.json as VidaraEncodingStatusResponse);
  }

  // --- Folder operations ---

  async listFolders(parentFolderId: string | null, _deps?: HostingAdapterDeps): Promise<ProviderFolderInfo[]> {
    // Vidara folders are flat — parentFolderId is ignored.
    const res = await this.http({ method: 'GET', url: `${this.config.baseUrl}/v1/folder/list` });
    return normalizeVidaraFolderList(res.json as VidaraFolderListResponse);
  }

  async createFolder(params: CreateFolderParams, _deps?: HostingAdapterDeps): Promise<ProviderFolderInfo> {
    // Vidara folders are flat — parentFolderId is ignored (nestedFolders = false).
    const res = await this.http({
      method: 'POST',
      url: `${this.config.baseUrl}/v1/folder/create`,
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
      url: `${this.config.baseUrl}/v1/folder/rename`,
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
      url: `${this.config.baseUrl}/v1/folder/delete`,
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
      url: `${this.config.baseUrl}/v1/subtitle/upload`,
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
      url: `${this.config.baseUrl}/v1/video/thumbnail`,
      body,
    });
    if (!(res.json as VidaraOperationResponse)?.result) {
      throw new HostingProviderError('VALIDATION', { message: 'Vidara thumbnail upload returned failure.' });
    }
  }
}
