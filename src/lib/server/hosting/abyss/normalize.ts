/**
 * Abyss response normalization (Phase 3).
 *
 * Maps Abyss's raw API response shapes into the provider-neutral types
 * from `hosting/types.ts`.
 *
 * Abyss playback URL convention (user task brief §9):
 *   https://player.abyssplayer.com/<slug>
 * This is a PLAYER/EMBED URL — NOT a raw media stream URL.
 *
 * Abyss resource identifiers (user task brief §7):
 *   Abyss uses `id` (numeric resource ID), `slug` (URL-safe string),
 *   and `file_id` interchangeably in some contexts. The normalizer
 *   picks the most stable identifier and uses it as `providerAssetId`.
 *   The `slug` is preferred because it's directly used in the player URL.
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
  AbyssAboutResponse,
  AbyssFile,
  AbyssFolder,
  AbyssFileListResponse,
  AbyssFolderListResponse,
  AbyssUploadResponse,
  AbyssOperationResponse,
} from './types';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ABYSS_PLAYBACK_URL_BASE = 'https://player.abyssplayer.com/';

// ---------------------------------------------------------------------------
// Status mapping — Abyss status string → Mavero AssetLifecycleState
// ---------------------------------------------------------------------------

/**
 * Maps an Abyss status/state string to the canonical Mavero
 * AssetLifecycleState.
 *
 * Abyss status values (from API documentation / observed behavior):
 *   'active' / 'ready' / 'processed' / 'converted' → ready
 *   'processing' / 'converting' / 'encoding' → processing
 *   'failed' / 'error' → failed
 *   'pending' / 'queued' / 'waiting' → queued
 *   'uploading' → uploading
 *   'deleted' → deleted
 *   (Other values default to 'processing' as conservative.)
 */
export function abyssStatusMapper(status: string | undefined): AssetLifecycleState {
  const s = (status ?? '').toLowerCase().trim();
  if (s === 'active' || s === 'ready' || s === 'processed' || s === 'converted' || s === '1') return 'ready';
  if (s === 'processing' || s === 'converting' || s === 'encoding' || s === 'pending') return 'processing';
  if (s === 'failed' || s === 'error') return 'failed';
  if (s === 'queued' || s === 'waiting' || s === '0') return 'queued';
  if (s === 'uploading') return 'uploading';
  if (s === 'deleted' || s === 'inactive') return 'deleted';
  return 'processing'; // Conservative — unknown status treated as in-progress.
}

// ---------------------------------------------------------------------------
// Normalizers
// ---------------------------------------------------------------------------

export function normalizeAbyssAccount(res: AbyssAboutResponse): ProviderAccountInfo {
  const data = res.data ?? {};
  const storageUsed = data.storage_used != null ? coerceNumber(data.storage_used)
    : data.storage_used_mb != null ? coerceNumber(Number(data.storage_used_mb) * 1_048_576)
    : null;
  const storageTotal = data.storage_limit != null ? coerceNumber(data.storage_limit)
    : data.storage_limit_mb != null ? coerceNumber(Number(data.storage_limit_mb) * 1_048_576)
    : null;
  return {
    accountId: String(data.id ?? data.email ?? data.username ?? 'unknown'),
    accountName: data.name ?? data.username ?? data.email ?? null,
    storageUsed,
    storageTotal,
    active: true,
    raw: data as Record<string, unknown>,
  };
}

export function normalizeAbyssFile(file: AbyssFile): ProviderAssetInfo {
  const slug = file.slug ?? String(file.id ?? '');
  const title = file.title ?? file.name ?? file.filename ?? null;
  const providerStatus = file.status ?? file.state ?? 'unknown';
  return {
    providerAssetId: slug,
    providerVideoId: file.id != null ? String(file.id) : slug,
    filename: file.filename ?? file.name ?? null,
    title,
    playbackUrl: slug ? (file.player_url ?? `${ABYSS_PLAYBACK_URL_BASE}${slug}`) : (file.player_url ?? null),
    thumbnailUrl: file.thumbnail ?? file.thumb ?? null,
    sizeBytes: coerceNumber(file.size),
    durationSeconds: coerceNumber(file.duration),
    sourceQuality: file.quality ?? null,
    availableQualities: Array.isArray(file.qualities) ? file.qualities.map(String) : (file.quality ? [String(file.quality)] : []),
    audioLanguages: normalizeAudioLanguages(file.audio_lang ?? file.audio_language),
    hasSubtitles: file.has_subtitles === true || (Array.isArray(file.subtitles) && file.subtitles.length > 0),
    providerStatus,
    status: abyssStatusMapper(providerStatus),
    providerFolderId: file.folder_id != null ? String(file.folder_id) : null,
    providerUpdatedAt: file.updated_at ?? file.created_at ?? null,
    raw: file as Record<string, unknown>,
  };
}

export function normalizeAbyssFileList(res: AbyssFileListResponse): ProviderAssetInfo[] {
  const files = res.data ?? res.files ?? res.result ?? [];
  if (!Array.isArray(files)) return [];
  return files.map(normalizeAbyssFile);
}

export function normalizeAbyssFolderList(res: AbyssFolderListResponse): ProviderFolderInfo[] {
  const folders = res.data ?? res.folders ?? res.result ?? [];
  if (!Array.isArray(folders)) return [];
  return folders.map(normalizeAbyssFolder);
}

export function normalizeAbyssFolder(folder: AbyssFolder): ProviderFolderInfo {
  return {
    providerFolderId: String(folder.id ?? folder.slug ?? ''),
    name: folder.name ?? 'Unnamed',
    parentFolderId: folder.parent_id != null ? String(folder.parent_id) : (folder.parent != null ? String(folder.parent) : null),
    childCount: (folder.files_count ?? 0) + (folder.folders_count ?? 0) || null,
    raw: folder as Record<string, unknown>,
  };
}

export function normalizeAbyssUploadResult(res: AbyssUploadResponse): ProviderUploadResult {
  const data = res.data ?? (res.file ? {
    id: res.file.id,
    slug: res.file.slug,
    player_url: res.file.player_url,
    size: res.file.size,
    status: res.file.status,
  } : {});
  const slug = data.slug ?? String(data.id ?? '');
  return {
    providerAssetId: slug,
    providerVideoId: data.id != null ? String(data.id) : slug,
    playbackUrl: slug ? (data.player_url ?? `${ABYSS_PLAYBACK_URL_BASE}${slug}`) : (data.player_url ?? null),
    providerStatus: data.status ?? 'processing',
    status: abyssStatusMapper(data.status ?? 'processing'),
    sizeBytes: coerceNumber(data.size),
    raw: data as Record<string, unknown>,
  };
}

export function normalizeAbyssProcessingStatus(file: AbyssFile): ProviderProcessingStatus {
  const providerStatus = file.status ?? file.state ?? 'unknown';
  const isError = providerStatus.toLowerCase().includes('error') || providerStatus.toLowerCase().includes('fail');
  return {
    status: abyssStatusMapper(providerStatus),
    providerStatus,
    progressPercent: null, // Abyss doesn't report progress percentage in the standard API.
    availableQualities: Array.isArray(file.qualities) ? file.qualities.map(String) : (file.quality ? [String(file.quality)] : []),
    providerErrorCode: isError ? 'provider_error' : null,
    providerErrorMessage: isError ? String(providerStatus) : null,
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
  if (typeof audio === 'string' && audio.trim()) return [audio.trim()];
  if (Array.isArray(audio)) return audio.map(String).filter(Boolean);
  return [];
}
