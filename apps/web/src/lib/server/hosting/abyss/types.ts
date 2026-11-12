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

/**
 * A single Abyss resource row.
 *
 * VERIFIED CONTRACT (official dash.abyss.to SPA bundle, API-docs
 * playground, 2026-10-04): GET /v1/resources returns `items` where each
 * row is a MIX of files and folders — `isDir` distinguishes them:
 *
 *   { isDir: false, id: "ltJEfKQxR", name: "BigBuckBunny.mp4",
 *     size: 81347747, status: "ready",
 *     resolutions: ["SD","HD","FullHD","2K","4K"],
 *     createdAt: "2018-01-01T00:00:00.000Z",
 *     updatedAt: "2018-01-01T00:00:00.000Z" }
 *
 * There is NO `slug` field on resource rows — the identifier is `id`
 * (the same value the upload endpoint returns under the legacy key
 * `slug`, and the same value the player URL uses:
 * https://player.abyssplayer.com/<id>). `resolutions` is the real
 * quality-variant field (["SD","HD","FullHD","2K","4K"]).
 *
 * Observed file status vocabulary (dashboard badge styling):
 *   waiting, in-processing (in progress) · ready, public (playable) ·
 *   error, banned (failed). Folders use status "active".
 */
export type AbyssFile = {
  id?: string | number;
  slug?: string;
  isDir?: boolean;
  name?: string;
  filename?: string;
  title?: string;
  size?: number | string;
  duration?: number | string;
  status?: string;
  state?: string;
  quality?: string;
  qualities?: string[];
  resolutions?: string[];
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
  createdAt?: string;
  updated_at?: string;
  updatedAt?: string;
  processed?: boolean;
  is_converted?: boolean;
  [k: string]: unknown;
};

/** Abyss file list response. */
export type AbyssFileListResponse = {
  /** VERIFIED: the real list lives under `items` (mixed files+folders). */
  items?: AbyssFile[];
  /** Token for the next page (absent on the last page). */
  pageToken?: string | null;
  /** Current folder display name. */
  name?: string | null;
  breadcrumbs?: unknown[];
  /** Custom embed domain for the account (null/'' = default player domain). */
  domainEmbed?: string | null;
  /** Legacy/tolerated shapes — kept for backward compatibility. */
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
  isDir?: boolean;
  parent_id?: string | number | null;
  parent?: string | number | null;
  files_count?: number;
  folders_count?: number;
  createdAt?: string;
  updatedAt?: string;
  [k: string]: unknown;
};

/**
 * Abyss folder list response.
 *
 * VERIFIED CONTRACT (dashboard bundle): GET /v1/folders/list returns
 * { name, breadcrumbs, items: [folders], pageToken } — items are
 * folders (isDir true in the resources listing; the folders endpoint
 * returns them without isDir).
 */
export type AbyssFolderListResponse = {
  items?: AbyssFolder[];
  pageToken?: string | null;
  name?: string | null;
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
