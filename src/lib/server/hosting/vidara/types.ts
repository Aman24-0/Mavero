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
  size?: number | string;
  length?: number | string;
  duration?: number | string;
  status?: number | string;
  status_text?: string;
  single_img?: string;
  thumb?: string;
  thumbnail?: string;
  splash?: string;
  folder_id?: string | number;
  uploads?: number | string;
  views?: number | string;
  last_modified?: string;
  updated_at?: string;
  quality?: string;
  audio?: string | string[];
  subtitles?: number | string | boolean;
  [k: string]: unknown;
};

/** Vidara file list response. */
export type VidaraFileListResponse = {
  result?: boolean | { files?: VidaraFile[]; total?: number; pages?: number; [k: string]: unknown };
  status?: number;
  msg?: string | { msg?: string };
  files?: VidaraFile[];
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
  result?: boolean | { server?: string; url?: string; session?: string; [k: string]: unknown };
  status?: number;
  msg?: string | { msg?: string };
  server?: string;
  url?: string;
  [k: string]: unknown;
};

/** Vidara upload result (from the upload server after multipart POST). */
export type VidaraUploadResultResponse = {
  result?: boolean;
  status?: number;
  msg?: string | { msg?: string };
  data?: {
    filecode?: string;
    file_code?: string;
    download_url?: string;
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
