/**
 * Vidara API response types (Phase 3).
 *
 * These types represent the EXPECTED shapes of Vidara API responses.
 * The Vidara adapter normalizes them into the provider-neutral types
 * from `hosting/types.ts`.
 *
 * All fields are optional in the raw API response — the normalizer
 * defensively handles missing/undefined fields. Only the fields we
 * actually consume are typed here.
 */

/** Vidara account info response. */
export type VidaraAccountResponse = {
  result?: boolean;
  status?: number;
  msg?: string | { msg?: string };
  data?: {
    email?: string;
    name?: string;
    storage_used?: number | string;
    storage_limit?: number | string;
    premium?: boolean | number;
    [k: string]: unknown;
  };
};

/** A single Vidara file in a list/info response. */
export type VidaraFile = {
  file_code?: string;
  filecode?: string;
  title?: string;
  name?: string;
  filename?: string;
  video_title?: string;
  size?: number | string;
  length?: number | string;
  duration?: number | string;
  video_length?: string;
  status?: number | string;
  status_text?: string;
  single_img?: string;
  thumb?: string;
  thumbnail?: string;
  player_img?: string;
  splash?: string;
  folder_id?: string | number;
  uploads?: number | string;
  views?: number | string;
  video_views?: number | string;
  last_modified?: string;
  updated_at?: string;
  video_created?: string;
  uploaded?: string;
  uploaded_at?: string;
  quality?: string;
  audio?: string | string[];
  subtitles?: number | string | boolean;
  link?: string;
  file_active?: number | string;
  vid_id?: number | string;
  [k: string]: unknown;
};

/** Vidara file list response. */
export type VidaraFileListResponse = {
  result?: boolean | { files?: VidaraFile[]; videos?: VidaraFile[]; total?: number; pages?: number; [k: string]: unknown };
  status?: number;
  msg?: string | { msg?: string };
  files?: VidaraFile[];
  videos?: VidaraFile[];
  [k: string]: unknown;
};

/** Vidara file info response. */
export type VidaraFileInfoResponse = {
  result?: boolean | VidaraFile | VidaraFile[];
  status?: number;
  msg?: string | { msg?: string };
  [k: string]: unknown;
};

/** Vidara folder. */
export type VidaraFolder = {
  folder_id?: string | number;
  name?: string;
  parent_id?: string | number | null;
  files_count?: number;
  [k: string]: unknown;
};

/** Vidara folder list response. */
export type VidaraFolderListResponse = {
  result?: boolean | { folders?: VidaraFolder[]; [k: string]: unknown };
  status?: number;
  msg?: string | { msg?: string };
  folders?: VidaraFolder[];
  [k: string]: unknown;
};

/** Vidara upload server response. */
export type VidaraUploadServerResponse = {
  result?: boolean | { server?: string; url?: string; upload_server?: string; session?: string; [k: string]: unknown };
  status?: number;
  msg?: string | { msg?: string };
  server?: string;
  url?: string;
  upload_server?: string;
  [k: string]: unknown;
};

/** Vidara upload result (from the upload server after multipart POST). */
export type VidaraUploadResultResponse = {
  result?: boolean;
  status?: number;
  msg?: string | { msg?: string };
  /** VERIFIED (live API): local upload returns filecode at the TOP LEVEL
   * as a full URL (e.g. "https://vidara.to/e/Vw0hY4n13k83Y").
   * Remote URL upload returns it nested in data.filecode as a short code.
   */
  filecode?: string;
  video_id?: number;
  title?: string;
  data?: {
    filecode?: string;
    file_code?: string;
    download_url?: string;
    link?: string;
    size?: number | string;
    [k: string]: unknown;
  };
  result_data?: {
    filecode?: string;
    file_code?: string;
    [k: string]: unknown;
  };
  [k: string]: unknown;
};

/** Vidara generic operation response (rename, move, delete, etc.). */
export type VidaraOperationResponse = {
  result?: boolean;
  status?: number;
  msg?: string | { msg?: string };
  data?: unknown;
  [k: string]: unknown;
};

/** Vidara encoding status response. */
export type VidaraEncodingStatusResponse = {
  result?: boolean;
  status?: number;
  msg?: string | { msg?: string };
  data?: {
    status?: number | string;
    status_text?: string;
    progress?: number | string;
    qualities?: string[];
    quality?: string[];
    error?: string;
    [k: string]: unknown;
  };
  [k: string]: unknown;
};

/**
 * Vidara VIDEO STATUS response — GET /v1/video/status?filecode=<code>.
 *
 * VERIFIED CONTRACT (Vidara API document, https://vidara.so/api — "Encoding
 * Status"): "Encoding progress for one video. Poll this after an upload
 * until progress_percentage reaches 100%. Returns 'encodings': null once
 * nothing is in progress."
 *
 *   {
 *     "msg": "OK",
 *     "status": 200,
 *     "result": {
 *       "encodings": [
 *         {
 *           "filecode": "AbC123xY",
 *           "type": "encode",
 *           "progress_percentage": "42%",
 *           "last_update": "3m",
 *           "created_at": "2026-01-08 01:05:32"
 *         }
 *       ],
 *       "total": 1
 *     }
 *   }
 *
 * `encodings` is null (or absent/empty) when nothing is in progress. This
 * endpoint — NOT /v1/video/info — is the authoritative source for active
 * encoding state: /v1/video/info's `status` field is the FILE lifecycle
 * (active / blocked / error, plus the observed pre-active "queued") and
 * stays "queued" while a video is actively encoding (live-verified: a file
 * at 14% processing reported status="queued" on /v1/video/info).
 */
export type VidaraVideoStatusResponse = {
  result?: {
    encodings?: Array<{
      filecode?: string;
      type?: string;
      progress_percentage?: string | number;
      last_update?: string;
      created_at?: string;
      [k: string]: unknown;
    }> | null;
    total?: number | string;
    [k: string]: unknown;
  } | null;
  status?: number;
  msg?: string | { msg?: string };
  [k: string]: unknown;
};
