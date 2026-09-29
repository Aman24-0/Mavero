/**
 * Vidara response normalization (Phase 3).
 *
 * Maps Vidara's raw API response shapes into the provider-neutral
 * types from `hosting/types.ts`. Every field is defensively
 * coerced — a missing/undefined field in the provider response
 * becomes `null` (for nullable fields) or a sensible default
 * (for non-nullable fields).
 *
 * Vidara playback URL convention (user task brief §9):
 *   https://vidara.so/v/<filecode>
 * This is a PLAYER/EMBED URL — NOT a raw media stream URL.
 */

import type {
  ProviderAccountInfo,
  ProviderAssetInfo,
  ProviderFolderInfo,
  ProviderUploadResult,
  ProviderProcessingStatus,
  AssetLifecycleState,
} from '../types';
import type {
  VidaraAccountResponse,
  VidaraFile,
  VidaraFolder,
  VidaraFileInfoResponse,
  VidaraFileListResponse,
  VidaraFolderListResponse,
  VidaraUploadServerResponse,
  VidaraUploadResultResponse,
  VidaraEncodingStatusResponse,
} from './types';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Vidara player URL pattern. */
const VIDARA_PLAYBACK_URL_BASE = 'https://vidara.so/v/';

// ---------------------------------------------------------------------------
// Status mapping — Vidara numeric status → Mavero AssetLifecycleState
// ---------------------------------------------------------------------------

/**
 * Maps a Vidara file status (numeric or string) to the canonical
 * Mavero AssetLifecycleState.
 *
 * Vidara status codes (from API documentation / observed behavior):
 *   0 = pending upload / inactive
 *   1 = active / ready
 *   2 = encoding / processing
 *   3 = error / failed
 *   (Other values default to 'unknown' → 'processing' as conservative.)
 */
export function vidaraStatusMapper(status: number | string | undefined): AssetLifecycleState {
  const s = typeof status === 'string' ? status.toLowerCase() : status;
  if (s === 0 || s === '0' || s === 'pending' || s === 'queued') return 'queued';
  if (s === 1 || s === '1' || s === 'active' || s === 'ready') return 'ready';
  if (s === 2 || s === '2' || s === 'encoding' || s === 'processing') return 'processing';
  if (s === 3 || s === '3' || s === 'error' || s === 'failed') return 'failed';
  return 'processing'; // Conservative — unknown status treated as in-progress.
}

// ---------------------------------------------------------------------------
// Normalizers
// ---------------------------------------------------------------------------

export function normalizeVidaraAccount(res: VidaraAccountResponse): ProviderAccountInfo {
  const data = res.data ?? {};
  return {
    accountId: String(data.email ?? data.name ?? 'unknown'),
    accountName: data.name ?? data.email ?? null,
    storageUsed: coerceNumber(data.storage_used),
    storageTotal: coerceNumber(data.storage_limit),
    active: true,
    raw: data as Record<string, unknown>,
  };
}

export function normalizeVidaraFile(file: VidaraFile): ProviderAssetInfo {
  const filecode = file.file_code ?? file.filecode ?? '';
  const title = file.title ?? file.name ?? file.filename ?? null;
  const providerStatus = file.status_text ?? String(file.status ?? 'unknown');
  return {
    providerAssetId: filecode,
    providerVideoId: filecode ? filecode : null, // Vidara uses filecode as the video id.
    filename: file.filename ?? file.name ?? null,
    title,
    playbackUrl: filecode ? `${VIDARA_PLAYBACK_URL_BASE}${filecode}` : null,
    thumbnailUrl: file.single_img ?? file.thumb ?? file.thumbnail ?? file.splash ?? null,
    sizeBytes: coerceNumber(file.size),
    durationSeconds: coerceNumber(file.length ?? file.duration),
    sourceQuality: file.quality ?? null,
    availableQualities: file.quality ? [String(file.quality)] : [],
    audioLanguages: normalizeAudioLanguages(file.audio),
    hasSubtitles: file.subtitles !== undefined && file.subtitles !== 0 && file.subtitles !== false && file.subtitles !== '0',
    providerStatus,
    status: vidaraStatusMapper(file.status),
    providerFolderId: file.folder_id != null ? String(file.folder_id) : null,
    providerUpdatedAt: file.last_modified ?? file.updated_at ?? null,
    raw: file as Record<string, unknown>,
  };
}

export function normalizeVidaraFileList(res: VidaraFileListResponse): ProviderAssetInfo[] {
  const result = res.result;
  const files = (typeof result === 'object' && result !== null && !Array.isArray(result) ? result.files : undefined) ?? res.files ?? [];
  if (!Array.isArray(files)) return [];
  return files.map(normalizeVidaraFile);
}

export function normalizeVidaraFileInfo(res: VidaraFileInfoResponse): ProviderAssetInfo {
  // Vidara returns either a single file object or an array (single-element).
  const result = res.result;
  const file = Array.isArray(result) ? result[0] : (typeof result === 'object' && result !== null ? result as VidaraFile : null);
  if (!file) throw new Error('Vidara file info response contained no file data.');
  return normalizeVidaraFile(file);
}

export function normalizeVidaraFolderList(res: VidaraFolderListResponse): ProviderFolderInfo[] {
  const result = res.result;
  const folders = (typeof result === 'object' && result !== null ? result.folders : undefined) ?? res.folders ?? [];
  if (!Array.isArray(folders)) return [];
  return folders.map(normalizeVidaraFolder);
}

export function normalizeVidaraFolder(folder: VidaraFolder): ProviderFolderInfo {
  return {
    providerFolderId: String(folder.folder_id ?? ''),
    name: folder.name ?? 'Unnamed',
    parentFolderId: folder.parent_id != null ? String(folder.parent_id) : null,
    childCount: folder.files_count != null ? Number(folder.files_count) : null,
    raw: folder as Record<string, unknown>,
  };
}

export function normalizeVidaraUploadResult(res: VidaraUploadResultResponse): ProviderUploadResult {
  const data = res.data ?? res.result_data ?? {};
  const filecode = data.filecode ?? data.file_code ?? '';
  return {
    providerAssetId: filecode,
    providerVideoId: filecode || null,
    playbackUrl: filecode ? `${VIDARA_PLAYBACK_URL_BASE}${filecode}` : null,
    providerStatus: 'uploaded',
    status: 'uploaded',
    sizeBytes: coerceNumber(data.size),
    raw: data as Record<string, unknown>,
  };
}

export function normalizeVidaraEncodingStatus(res: VidaraEncodingStatusResponse): ProviderProcessingStatus {
  const data = res.data ?? {};
  const providerStatus = data.status_text ?? String(data.status ?? 'unknown');
  const hasError = data.error != null && data.error !== '';
  return {
    status: hasError ? 'failed' : vidaraStatusMapper(data.status),
    providerStatus,
    progressPercent: coerceNumber(data.progress),
    availableQualities: Array.isArray(data.qualities) ? data.qualities.map(String)
      : Array.isArray(data.quality) ? data.quality.map(String)
      : [],
    providerErrorCode: hasError ? 'provider_error' : null,
    providerErrorMessage: hasError ? String(data.error) : null,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function coerceNumber(value: unknown): number | null {
  if (value == null) return null;
  const n = typeof value === 'string' ? parseInt(value, 10) : value;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

function normalizeAudioLanguages(audio: unknown): string[] {
  if (Array.isArray(audio)) return audio.map(String).filter(Boolean);
  if (typeof audio === 'string' && audio.trim()) return [audio.trim()];
  return [];
}

// ---------------------------------------------------------------------------
// Vidara upload server URL extraction
// ---------------------------------------------------------------------------

/**
 * Extracts the upload server URL from Vidara's /v1/upload/server response.
 *
 * VERIFIED CONTRACT (live API, 2026-09-29):
 *   GET /v1/upload/server?api_key=<key> →
 *   {
 *     "msg": "OK",
 *     "status": 200,
 *     "result": {
 *       "upload_server": "https://upl4.s1q2105.com/api/upload"
 *     }
 *   }
 *
 * The field is `result.upload_server` (NOT `result.server` or `result.url`).
 * The previous implementation looked for `result.server` / `result.url` and
 * threw "did not contain a server URL" — this was the root cause of the
 * Vidara local upload failure.
 *
 * We now check `upload_server` first (verified field), then fall back to
 * `server` / `url` for backward compatibility with any older Vidara API
 * version.
 */
export function extractVidaraUploadServerUrl(res: VidaraUploadServerResponse): string {
  const result = res.result;
  const url = (typeof result === 'object' && result !== null
    ? (result.upload_server ?? result.server ?? result.url)
    : undefined
  ) ?? res.server ?? res.url;
  if (typeof url !== 'string' || !url) throw new Error('Vidara upload server response did not contain a server URL.');
  return url;
}
