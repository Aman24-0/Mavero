/**
 * Abyss API response types (Phase 3).
 *
 * These types represent the EXPECTED shapes of Abyss API responses.
 * The Abyss adapter normalizes them into the provider-neutral types
 * from `hosting/types.ts`.
 */

/** Abyss login response (JWT). */
export type AbyssLoginResponse = {
  token?: string;
  access_token?: string;
  jwt?: string;
  expires_in?: number;
  token_type?: string;
  user?: {
    id?: string;
    email?: string;
    name?: string;
    [k: string]: unknown;
  };
  [k: string]: unknown;
};

/** Abyss account/about response. */
export type AbyssAboutResponse = {
  data?: {
    id?: string | number;
    email?: string;
    name?: string;
    username?: string;
    storage_used?: number | string;
    storage_limit?: number | string;
    storage_used_mb?: number | string;
    storage_limit_mb?: number | string;
    plan?: string;
    [k: string]: unknown;
  };
  [k: string]: unknown;
};

/** A single Abyss file/resource. */
export type AbyssFile = {
  id?: string | number;
  slug?: string;
  name?: string;
  filename?: string;
  title?: string;
  size?: number | string;
  duration?: number | string;
  status?: string;
  state?: string;
  quality?: string;
  qualities?: string[];
  audio_lang?: string;
  audio_language?: string;
  has_subtitles?: boolean;
  subtitles?: unknown[];
  thumbnail?: string;
  thumb?: string;
  player_url?: string;
  stream_url?: string;
  folder_id?: string | number;
  folder_name?: string;
  created_at?: string;
  updated_at?: string;
  processed?: boolean;
  is_converted?: boolean;
  [k: string]: unknown;
};

/** Abyss file list response. */
export type AbyssFileListResponse = {
  data?: AbyssFile[];
  files?: AbyssFile[];
  result?: AbyssFile[];
  meta?: {
    total?: number;
    current_page?: number;
    last_page?: number;
    [k: string]: unknown;
  };
  [k: string]: unknown;
};

/** Abyss folder. */
export type AbyssFolder = {
  id?: string | number;
  name?: string;
  slug?: string;
  parent_id?: string | number | null;
  parent?: string | number | null;
  files_count?: number;
  folders_count?: number;
  [k: string]: unknown;
};

/** Abyss folder list response. */
export type AbyssFolderListResponse = {
  data?: AbyssFolder[];
  folders?: AbyssFolder[];
  result?: AbyssFolder[];
  [k: string]: unknown;
};

/** Abyss upload response. */
export type AbyssUploadResponse = {
  /** VERIFIED (live API): the upload endpoint returns { slug: "file-id" } at the top level. */
  slug?: string;
  data?: {
    id?: string | number;
    slug?: string;
    file_id?: string | number;
    player_url?: string;
    stream_url?: string;
    size?: number | string;
    status?: string;
    [k: string]: unknown;
  };
  file?: AbyssFile;
  [k: string]: unknown;
};

/** Abyss generic operation response. */
export type AbyssOperationResponse = {
  success?: boolean;
  message?: string;
  data?: unknown;
  [k: string]: unknown;
};

/** Abyss subtitle list response. */
export type AbyssSubtitleListResponse = {
  data?: Array<{
    id?: string | number;
    language?: string;
    lang?: string;
    name?: string;
    [k: string]: unknown;
  }>;
  subtitles?: Array<{
    id?: string | number;
    language?: string;
    lang?: string;
    name?: string;
    [k: string]: unknown;
  }>;
  [k: string]: unknown;
};

/** Abyss Google Drive import response (same shape as upload). */
export type AbyssDriveImportResponse = AbyssUploadResponse;
