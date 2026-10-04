/**
 * Abyss response normalization.
 *
 * Maps Abyss's raw API response shapes into the provider-neutral types
 * from `hosting/types.ts`.
 *
 * VERIFIED CONTRACT (official dash.abyss.to SPA bundle, 2026-10-04):
 *   Playback URL: https://player.abyssplayer.com/<id>   (player/embed
 *   URL — NOT a raw media stream). When the account configures a custom
 *   embed domain, the dashboard builds https://<domainEmbed>/?v=<id>
 *   instead; Mavero keeps constructing the DEFAULT player domain (the
 *   origin allowlist on streaming_providers governs what the playback
 *   resolver will actually serve).
 *
 * Abyss resource identifiers:
 *   Resource rows carry `id` (e.g. "ltJEfKQxR") — there is no `slug`
 *   field on list rows. The upload endpoint returns the same identifier
 *   under the legacy key `slug` ({slug: "file-id"}). The normalizer
 *   prefers `slug` when present (upload/legacy paths) and falls back to
 *   `String(id)` for resource rows — both produce the identifier the
 *   player URL uses, so `providerAssetId` is always the canonical one.
 */

import type {
  ProviderAccountInfo,
  ProviderAssetInfo,
  ProviderFolderInfo,
  ProviderUploadResult,
  ProviderProcessingStatus,
  AssetLifecycleState,
} from '../types';
import { HostingProviderError } from '../errors';
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
 * VERIFIED CONTRACT (official dashboard bundle badge styling,
 * 2026-10-04): the observed file status vocabulary is
 *   waiting, in-processing   → in progress (gray)
 *   ready, public            → playable (green)
 *   error, banned            → failed (red)
 * plus legacy/documented values from earlier API versions. The
 * mapping below covers both vocabularies:
 *   'active' / 'ready' / 'public' / 'processed' / 'converted' → ready
 *   'processing' / 'converting' / 'encoding' / 'in-processing' / 'pending' → processing
 *   'failed' / 'error' / 'banned' → failed
 *   'pending'→processing, 'queued' / 'waiting' / 'raw' → queued
 *   'uploading' → uploading
 *   'deleted' / 'inactive' → deleted
 *   (Other values default to 'processing' as conservative.)
 *
 * 'public' and 'banned' were previously MISSING — a playable 'public'
 * file mapped to the conservative 'processing' default (never became
 * ready via sync) and a 'banned' file stayed 'processing' instead of
 * failing. Both are live vocabulary, both are now mapped.
 */
export function abyssStatusMapper(status: string | undefined): AssetLifecycleState {
  const s = (status ?? '').toLowerCase().trim();
  if (s === 'active' || s === 'ready' || s === 'public' || s === 'processed' || s === 'converted' || s === '1') return 'ready';
  if (s === 'processing' || s === 'converting' || s === 'encoding' || s === 'in-processing' || s === 'pending') return 'processing';
  if (s === 'failed' || s === 'error' || s === 'banned') return 'failed';
  if (s === 'queued' || s === 'waiting' || s === 'raw' || s === '0') return 'queued';
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
  // VERIFIED CONTRACT: quality variants arrive as `resolutions`
  // (["SD","HD","FullHD","2K","4K"]); `qualities`/`quality` are kept as
  // tolerated fallbacks from earlier API shapes.
  const qualities = Array.isArray(file.resolutions)
    ? file.resolutions.map(String)
    : Array.isArray(file.qualities)
      ? file.qualities.map(String)
      : (file.quality ? [String(file.quality)] : []);
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
    availableQualities: qualities,
    audioLanguages: normalizeAudioLanguages(file.audio_lang ?? file.audio_language),
    hasSubtitles: file.has_subtitles === true || (Array.isArray(file.subtitles) && file.subtitles.length > 0),
    providerStatus,
    status: abyssStatusMapper(providerStatus),
    providerFolderId: file.folder_id != null ? String(file.folder_id) : null,
    providerUpdatedAt: file.updated_at ?? file.updatedAt ?? file.created_at ?? file.createdAt ?? null,
    raw: file as Record<string, unknown>,
  };
}

/**
 * Normalizes an Abyss /v1/resources (or /v1/folders/list) response.
 *
 * VERIFIED CONTRACT (dashboard bundle): files live under `items` and
 * are MIXED with folders — `isDir: true` rows are folders, `isDir` is
 * false/absent for files. Legacy keys (`data`/`files`/`result`) are
 * tolerated as fallbacks.
 *
 * CRITICAL — no silent empty on an UNRECOGNIZED shape: this was the
 * production root cause of the zero-inventory false-success (every
 * Abyss sync reported `outcome: success, total_provider_assets: 0`
 * while the account had a real file, because the normalizer looked
 * for `data`/`files`/`result` and the real key is `items`). If the
 * response is a JSON object with NONE of the recognized list keys,
 * this function now throws a typed VALIDATION error naming the
 * top-level keys it saw — inventory sync can never again report a
 * fabricated "zero files" success. A RECOGNIZED empty list
 * (`items: []`) is still a legitimate zero.
 */
export function normalizeAbyssFileList(res: AbyssFileListResponse): ProviderAssetInfo[] {
  const files = res.items ?? res.data ?? res.files ?? res.result;
  if (files === undefined) {
    const keys = (res && typeof res === 'object' && !Array.isArray(res))
      ? Object.keys(res).filter((k) => k !== 'pageToken' && k !== 'meta' && k !== 'breadcrumbs').join(', ') || '(empty object)'
      : String(res);
    throw new HostingProviderError('VALIDATION', {
      message: `Abyss resources response has no recognized file list (expected "items"; saw top-level keys: ${keys}). Inventory discovery failed — refusing to report a false zero-file success.`,
    });
  }
  if (!Array.isArray(files)) {
    throw new HostingProviderError('VALIDATION', {
      message: 'Abyss resources response "items" was not an array. Inventory discovery failed — refusing to report a false zero-file success.',
    });
  }
  // The resources listing mixes files and folders — keep only files.
  return files.filter((f) => (f as AbyssFile).isDir !== true).map(normalizeAbyssFile);
}

/**
 * Extracts the next-page token from an Abyss list response.
 * Returns null when there is no next page (last page or legacy shape).
 */
export function abyssNextPageToken(res: AbyssFileListResponse): string | null {
  const token = res.pageToken;
  return typeof token === 'string' && token.length > 0 ? token : null;
}

export function normalizeAbyssFolderList(res: AbyssFolderListResponse): ProviderFolderInfo[] {
  const folders = res.items ?? res.data ?? res.folders ?? res.result;
  if (folders === undefined) {
    const keys = (res && typeof res === 'object' && !Array.isArray(res))
      ? Object.keys(res).filter((k) => k !== 'pageToken' && k !== 'meta' && k !== 'breadcrumbs').join(', ') || '(empty object)'
      : String(res);
    throw new HostingProviderError('VALIDATION', {
      message: `Abyss folders response has no recognized folder list (expected "items"; saw top-level keys: ${keys}).`,
    });
  }
  if (!Array.isArray(folders)) {
    throw new HostingProviderError('VALIDATION', {
      message: 'Abyss folders response "items" was not an array.',
    });
  }
  // Only folder rows (isDir true when present — the folders endpoint
  // returns folders only, so rows without isDir are folders).
  return folders.filter((f) => f.isDir === undefined || f.isDir === true).map(normalizeAbyssFolder);
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
  // VERIFIED CONTRACT (live API, 2026-09-29): the upload endpoint
  // POST http://up.abyss.to/:key returns:
  //   { slug: "file-id" }
  // The `slug` is at the TOP LEVEL (not nested in `data`). The previous
  // normalizer looked for `res.data.slug` — which would miss the actual
  // field. We now check `res.slug` first (verified), then fall back to
  // `res.data.slug` / `res.file.slug` for compatibility with other
  // possible response shapes.
  const topLevelSlug = (res as { slug?: string }).slug;
  const data = res.data ?? (res.file ? {
    id: res.file.id,
    slug: res.file.slug,
    player_url: res.file.player_url,
    size: res.file.size,
    status: res.file.status,
  } : {});
  // CRITICAL (Abyss fix §6): if neither slug nor id is present, the
  // upload did not actually produce a playable resource. We return
  // providerAssetId as an empty string (the type requires `string`,
  // not `string | null`) so the adapter's validation
  // (`if (!result.providerAssetId)`) catches it and throws a typed
  // VALIDATION error.
  const slug = topLevelSlug ?? data.slug ?? (data.id != null && data.id !== '' ? String(data.id) : '');
  const hasValidSlug = slug.length > 0;
  return {
    providerAssetId: slug,
    providerVideoId: data.id != null ? String(data.id) : slug,
    playbackUrl: hasValidSlug ? (data.player_url ?? `${ABYSS_PLAYBACK_URL_BASE}${slug}`) : (data.player_url ?? null),
    providerStatus: data.status ?? 'processing',
    status: abyssStatusMapper(data.status ?? 'processing'),
    sizeBytes: coerceNumber(data.size),
    raw: data as Record<string, unknown>,
  };
}

export function normalizeAbyssProcessingStatus(file: AbyssFile): ProviderProcessingStatus {
  const providerStatus = file.status ?? file.state ?? 'unknown';
  const isError = providerStatus.toLowerCase().includes('error') || providerStatus.toLowerCase().includes('fail') || providerStatus.toLowerCase().includes('banned');
  return {
    status: abyssStatusMapper(providerStatus),
    providerStatus,
    progressPercent: null, // Abyss doesn't report progress percentage in the standard API.
    availableQualities: Array.isArray(file.resolutions)
      ? file.resolutions.map(String)
      : Array.isArray(file.qualities)
        ? file.qualities.map(String)
        : (file.quality ? [String(file.quality)] : []),
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
