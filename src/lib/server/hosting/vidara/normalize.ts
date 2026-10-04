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
import { HostingProviderError } from '../errors';
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
  VidaraVideoStatusResponse,
} from './types';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Vidara embed URL pattern.
 *
 * Vidara's API returns two URL types:
 *   - Share URL:  https://vidara.to/<code>       (NOT embeddable — shows share/download page)
 *   - Embed URL:  https://vidara.to/e/<code>     (iframe-embeddable player)
 *
 * For LOCAL uploads, the API returns the full embed URL in the `filecode` field:
 *   filecode: "https://vidara.to/e/Vw0hY4n13k83Y"
 *
 * For file info/list responses, the `link` field contains the share URL:
 *   link: "https://vidara.to/<code>"
 *
 * We must use the embed URL (/e/ path) for playback, NOT the share URL.
 */
const VIDARA_EMBED_URL_BASE = 'https://vidara.to/e/';

// ---------------------------------------------------------------------------
// Status mapping — Vidara numeric status → Mavero AssetLifecycleState
// ---------------------------------------------------------------------------

/**
 * Maps a Vidara file status (numeric or string) to the canonical
 * Mavero AssetLifecycleState.
 *
 * Vidara /v1/video/info status values (API document + observed behavior):
 *   0 = pending upload / inactive
 *   1 = active / ready
 *   2 = encoding / processing
 *   3 = error / failed
 *   "queued" = pre-active (observed LIVE: a file actively encoding at 14%
 *              reported status="queued" on /v1/video/info)
 *   "blocked" = documented file status (API docs "Filter by file status:
 *              active, blocked, error") — a blocked file is not playable
 *              and will not become playable → mapped to 'failed' so the
 *              admin sees an actionable terminal state instead of an
 *              eternal "processing".
 *
 * NOTE: the file-info status is the FILE lifecycle, NOT encoding progress.
 * The authoritative source for ACTIVE encoding is GET /v1/video/status
 * (see normalizeVidaraEncodingList + VidaraAdapter.getProcessingStatus).
 * (Other values default to 'processing' as conservative.)
 */
export function vidaraStatusMapper(status: number | string | undefined): AssetLifecycleState {
  const s = typeof status === 'string' ? status.toLowerCase() : status;
  if (s === 0 || s === '0' || s === 'pending' || s === 'queued') return 'queued';
  if (s === 1 || s === '1' || s === 'active' || s === 'ready') return 'ready';
  if (s === 2 || s === '2' || s === 'encoding' || s === 'processing') return 'processing';
  if (s === 3 || s === '3' || s === 'error' || s === 'failed' || s === 'blocked') return 'failed';
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
  // VERIFIED (live API, 2026-09-29): /v1/video/info returns:
  //   {
  //     "player_img": "https://...thumbnail...",
  //     "status": "active" | "pending" | ...,
  //     "filecode": "<code>",
  //     "link": "https://vidara.to/<code>",
  //     "video_length": "00:01:30",
  //     "video_title": "...",
  //     "video_views": 0,
  //     "video_created": "2026-09-29",
  //     "file_active": 1 | 0,
  //     "vid_id": 4006148
  //   }
  // /v1/video/list returns:
  //   {
  //     "vid_id": 4006148,
  //     "filecode": "<code>",
  //     "title": "...",
  //     "thumbnail": null,
  //     "length": null,
  //     "link": "https://vidara.to/<code>",
  //     "views": 0,
  //     "uploaded": "2026-09-29",
  //     "status": "active" | "pending" | ...,
  //     "file_active": 1 | 0
  //   }
  const filecode = file.file_code ?? file.filecode ?? '';
  const title = file.title ?? file.video_title ?? file.name ?? file.filename ?? null;
  const providerStatus = file.status_text ?? String(file.status ?? 'unknown');
  return {
    providerAssetId: filecode,
    providerVideoId: (file.vid_id != null ? String(file.vid_id) : null) ?? (filecode ? filecode : null),
    filename: file.filename ?? file.name ?? null,
    title,
    // Phase 6 fix: use the embed URL (vidara.to/e/<code>) for playback,
    // NOT the share URL (file.link which is vidara.to/<code>).
    // The share URL renders the Vidara share/download page in the iframe,
    // not the embedded player.
    playbackUrl: filecode ? `${VIDARA_EMBED_URL_BASE}${filecode}` : null,
    thumbnailUrl: file.player_img ?? file.single_img ?? file.thumb ?? file.thumbnail ?? file.splash ?? null,
    sizeBytes: coerceNumber(file.size),
    durationSeconds: coerceNumber(file.length ?? file.duration ?? file.video_length),
    sourceQuality: file.quality ?? null,
    availableQualities: file.quality ? [String(file.quality)] : [],
    audioLanguages: normalizeAudioLanguages(file.audio),
    hasSubtitles: file.subtitles !== undefined && file.subtitles !== 0 && file.subtitles !== false && file.subtitles !== '0',
    providerStatus,
    status: vidaraStatusMapper(file.status),
    providerFolderId: file.folder_id != null ? String(file.folder_id) : null,
    providerUpdatedAt: file.last_modified ?? file.updated_at ?? file.video_created ?? file.uploaded ?? file.uploaded_at ?? null,
    raw: file as Record<string, unknown>,
  };
}

export function normalizeVidaraFileList(res: VidaraFileListResponse): ProviderAssetInfo[] {
  // VERIFIED (live API): /v1/video/list returns { result: { videos: [...] } }
  // The previous implementation looked for result.files — but the actual
  // field is result.videos. We check both for backward compatibility.
  //
  // INVENTORY HARDENING (Abyss zero-inventory false-success fix): a JSON
  // response that has NONE of the recognized keys (result/videos/files)
  // throws a typed VALIDATION error instead of silently normalizing to
  // an empty list — "provider response could not be understood" must
  // never masquerade as "provider has zero files". Behavior for every
  // previously-recognized shape (including empty arrays and result:null)
  // is unchanged.
  const result = res.result;
  const hasResultKey = res && typeof res === 'object' && !Array.isArray(res) && 'result' in res;
  const candidates = [
    (typeof result === 'object' && result !== null && !Array.isArray(result)
      ? (result.videos ?? result.files)
      : undefined),
    res.videos,
    res.files,
  ];
  const defined = candidates.find((c) => c !== undefined);
  if (defined === undefined && !hasResultKey) {
    const keys = (res && typeof res === 'object' && !Array.isArray(res))
      ? Object.keys(res).join(', ') || '(empty object)'
      : String(res);
    throw new HostingProviderError('VALIDATION', {
      message: `Vidara video list response has no recognized file list (expected "result.videos"; saw top-level keys: ${keys}). Inventory discovery failed — refusing to report a false zero-file success.`,
    });
  }
  const files = defined ?? [];
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
  // VERIFIED CONTRACT (live API, 2026-09-29):
  //
  // LOCAL upload response (from the upload server, POST /api/upload?api_key=...):
  //   {
  //     "filecode": "https://vidara.to/e/Vw0hY4n13k83Y",  ← TOP LEVEL (full URL)
  //     "video_id": 4006148,
  //     "title": "test_video"
  //   }
  //   The filecode is a FULL URL like "https://vidara.to/e/<code>".
  //   The short code is the last path segment: "Vw0hY4n13k83Y".
  //
  // REMOTE URL upload response (from GET /v1/upload/url?api_key=...&url=...):
  //   {
  //     "data": {
  //       "filecode": "28ef362466ac",        ← nested in data (short code)
  //       "link": "https://vidara.to/28ef362466ac",
  //       "size": 469771811,
  //       "title": "imiebcpikd"
  //     },
  //     "msg": "OK",
  //     "server_time": "...",
  //     "status": 200
  //   }
  //   The filecode is a SHORT CODE (not a URL).
  //
  // The previous implementation only checked res.data.filecode and
  // res.result_data.filecode — it MISSED the top-level filecode from
  // the local upload response. This was the root cause of the
  // "Provider upload result does not contain a provider asset ID" error.
  //
  // We now check ALL possible locations:
  //   1. Top-level filecode (local upload)
  //   2. res.data.filecode (remote URL upload)
  //   3. res.data.file_code (alternative field name)
  //   4. res.result_data.filecode (legacy)
  //
  // For the filecode, if it's a full URL (starts with http), we extract
  // the last path segment as the short code — this is what Vidara uses
  // for the player URL (https://vidara.so/v/<short_code>).
  const rawFilecode = (res.filecode as string | undefined)
    ?? (res.data?.filecode as string | undefined)
    ?? (res.data?.file_code as string | undefined)
    ?? (res.result_data?.filecode as string | undefined)
    ?? (res.result_data?.file_code as string | undefined)
    ?? '';

  // If the filecode is a full URL (e.g. "https://vidara.to/e/Vw0hY4n13k83Y"),
  // it IS the embed URL — preserve it directly as playbackUrl.
  // Extract the last path segment as the short code for providerAssetId.
  const filecode = rawFilecode.startsWith('http')
    ? rawFilecode.split('/').pop() ?? ''
    : rawFilecode;

  // For local uploads, Vidara returns the full embed URL in filecode.
  // For remote URL uploads, filecode is just the short code.
  const playbackUrl = rawFilecode.startsWith('http')
    ? rawFilecode                          // Already the embed URL from Vidara
    : (filecode ? `${VIDARA_EMBED_URL_BASE}${filecode}` : null);

  return {
    providerAssetId: filecode,
    providerVideoId: filecode || null,
    playbackUrl,
    providerStatus: 'uploaded',
    status: 'uploaded',
    sizeBytes: coerceNumber(res.data?.size),
    raw: res as Record<string, unknown>,
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
// Encoding progress (GET /v1/video/status) — the REAL processing source
// ---------------------------------------------------------------------------

/**
 * Normalizes Vidara's video-status (encoding progress) response into the
 * in-progress encoding entry for ONE file, or null when nothing is in
 * progress for that file.
 *
 * VERIFIED CONTRACT (Vidara API document — "Encoding Status"):
 *   GET /v1/video/status?filecode=<code> →
 *   {
 *     "msg": "OK", "status": 200,
 *     "result": {
 *       "encodings": [
 *         { "filecode": "AbC123xY", "type": "encode",
 *           "progress_percentage": "42%", "last_update": "3m",
 *           "created_at": "2026-01-08 01:05:32" }
 *       ],
 *       "total": 1
 *     }
 *   }
 *   "Returns 'encodings': null once nothing is in progress."
 *
 * Defensive handling:
 *   - result null/absent, encodings null/absent/empty → null (nothing in
 *     progress — the caller must fall back to /v1/video/info for the
 *     terminal state).
 *   - If the response includes encodings for OTHER filecodes (account-wide
 *     response shape), only the entry matching THIS filecode counts.
 *   - progress_percentage arrives as a STRING with a "%" suffix ("42%");
 *     it is coerced to a number (42). Missing/malformed → null (progress
 *     unknown, but encoding is still in progress).
 */
export function normalizeVidaraEncodingList(
  res: VidaraVideoStatusResponse,
  filecode: string,
): { progressPercent: number | null; lastUpdate: string | null; providerStatus: string } | null {
  const encodings = res?.result?.encodings;
  if (!Array.isArray(encodings) || encodings.length === 0) return null;
  // Match this filecode when the entry carries one; a single-entry response
  // without a filecode field is treated as this file's encoding (the
  // endpoint was queried with our filecode).
  const entry = encodings.find((e) => !e.filecode || e.filecode === filecode) ?? null;
  if (!entry) return null;
  const progressPercent = parseVidaraProgress(entry.progress_percentage);
  const providerStatus = `encoding ${progressPercent != null ? `${progressPercent}%` : ''}`.trim();
  return {
    progressPercent,
    lastUpdate: typeof entry.last_update === 'string' ? entry.last_update : null,
    providerStatus,
  };
}

/**
 * Parses Vidara's "42%" progress strings (also accepts 42, "42", "42.5%").
 * Clamped to 0-100: media_upload_operations.progress_percent has a DB CHECK
 * constraint of [0,100], so a malformed provider value (e.g. "150%") must
 * never reach the persistence layer.
 */
function parseVidaraProgress(value: string | number | undefined | null): number | null {
  if (value == null) return null;
  let n: number;
  if (typeof value === 'number') {
    n = value;
  } else {
    const raw = String(value).trim().replace(/%$/, '').trim();
    if (!raw) return null;
    n = Number(raw);
  }
  if (!Number.isFinite(n)) return null;
  return Math.min(100, Math.max(0, Math.round(n)));
}

/**
 * Converts a ProviderAssetInfo (from /v1/video/info) into a
 * ProviderProcessingStatus. This is the FILE-INFO FALLBACK used by
 * getProcessingStatus AFTER the encoding-progress endpoint
 * (/v1/video/status) reports nothing in progress — it resolves the
 * terminal/pre-encoding states:
 *   active → ready, error/failed/blocked → failed,
 *   pending/queued → queued (awaiting encoding).
 *
 * VERIFIED (live API): the status field is a STRING: "active", "pending",
 * "queued" (pre-active — observed while actively encoding), "error".
 * The vidaraStatusMapper handles these string values.
 *
 * NOTE: this fallback alone CANNOT distinguish "queued and waiting" from
 * "queued and actively encoding" — the /v1/video/info status stays
 * "queued" during active encoding (live-verified at 14% progress). The
 * encoding-progress endpoint (normalizeVidaraEncodingList) is checked
 * FIRST for exactly that reason.
 */
export function normalizeVidaraProcessingStatus(asset: ProviderAssetInfo): ProviderProcessingStatus {
  const providerStatus = asset.providerStatus ?? 'unknown';
  const isError = providerStatus.toLowerCase().includes('error')
    || providerStatus.toLowerCase().includes('fail')
    || providerStatus.toLowerCase().includes('blocked');
  return {
    status: isError ? 'failed' : asset.status,
    providerStatus,
    progressPercent: null, // Vidara /v1/video/info does not report progress percentage.
    availableQualities: asset.availableQualities,
    providerErrorCode: isError ? 'provider_error' : null,
    providerErrorMessage: isError ? providerStatus : null,
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
