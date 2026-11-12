/**
 * Phase 3 — Hosting provider adapter foundation.
 *
 * Provider-neutral types, error model, capability model, and the
 * HostingProviderAdapter interface that every concrete adapter
 * (VidaraAdapter, AbyssAdapter) implements.
 *
 * Design principles (from Phase 0/1/2 audit + user task brief):
 *
 *   * The adapter is a SERVER-SIDE service that talks to a hosting
 *     provider's API (Vidara, Abyss). It is NOT a player adapter
 *     and NOT a playback resolver.
 *   * Provider credentials NEVER leave the server. The adapter
 *     reads them from `$env/dynamic/private` at the boundary.
 *   * The adapter does NOT directly read/write the hosting DB tables
 *     (media_assets, media_upload_operations, etc.). Higher-level
 *     services will call the adapter, normalize responses, and
 *     persist to the DB. This keeps the adapter pure and testable.
 *   * HTTP fetch is INJECTABLE so tests can use mock fetchers
 *     without hitting the real provider API.
 *   * Errors are classified into a closed vocabulary so retry logic
 *     can distinguish transient from permanent failures.
 *   * The adapter reports its CAPABILITIES explicitly — the rest
 *     of Mavero must not guess what a provider supports.
 *
 * Direct vs embed semantics (user task brief §9):
 *   The adapter distinguishes `playback_url` (a provider-hosted
 *   player/embed page — e.g. `https://vidara.so/v/<filecode>` or
 *   `https://player.abyssplayer.com/<slug>`) from a raw media
 *   stream URL. Phase 3 does NOT extract/scrape raw HLS/MP4 URLs
 *   from player pages. The `playback_url` is stored as-is for the
 *   future playback resolver (Phase 7) to consume.
 */

// ---------------------------------------------------------------------------
// Capability model
// ---------------------------------------------------------------------------

/**
 * The set of provider capabilities the hosting layer queries. Each
 * concrete adapter reports a `ProviderCapabilities` object whose
 * fields are all `boolean` (or typed arrays for `remoteUploadTypes`).
 *
 * Capabilities are VERIFIED — an adapter MUST NOT claim a capability
 * it has not audited. `false` means "not supported / not verified".
 */
export type ProviderCapabilities = {
  /** Local file upload via multipart or similar. */
  localUpload: boolean;
  /** Remote URL upload (provider fetches the URL itself). */
  remoteUpload: boolean;
  /** The URL schemes the provider accepts for remote upload (empty = unsupported). */
  remoteUploadTypes: readonly RemoteUploadType[];
  /** Folder CRUD (create, list, rename, move, delete). */
  folderManagement: boolean;
  /** Whether the provider supports nested folders (true) or flat-only (false). */
  nestedFolders: boolean;
  /** External subtitle upload. */
  subtitles: boolean;
  /** Whether the provider supports multiple audio tracks in one asset. */
  multiAudio: boolean;
  /** Whether the provider transcodes uploads into multiple quality variants. */
  transcoding: boolean;
  /** Whether the provider reports quality variants (e.g. 480p/720p/1080p). */
  qualityVariants: boolean;
  /** Whether the provider reports processing/encoding status. */
  processingStatus: boolean;
  /** Rename an existing file. */
  rename: boolean;
  /** Move a file between folders. */
  move: boolean;
  /** Delete a file. */
  delete: boolean;
  /** Thumbnail upload. */
  thumbnails: boolean;
};

export type RemoteUploadType = 'direct-file' | 'google-drive';

// ---------------------------------------------------------------------------
// Normalized response shapes (provider-neutral)
// ---------------------------------------------------------------------------

/** Normalized provider account / quota info. */
export type ProviderAccountInfo = {
  /** Provider-specific account identifier (masked / non-sensitive). */
  accountId: string;
  /** Human-readable account name (or null when not exposed). */
  accountName: string | null;
  /** Storage quota used (bytes), or null when not reported. */
  storageUsed: number | null;
  /** Storage quota total (bytes), or null when not reported. */
  storageTotal: number | null;
  /** Whether the account is in good standing. */
  active: boolean;
  /** Raw provider metadata (non-sensitive, for diagnostics). */
  raw: Record<string, unknown>;
};

/** Normalized provider file / asset info. */
export type ProviderAssetInfo = {
  /** The provider's own asset identifier (filecode, slug, file_id, etc.). */
  providerAssetId: string;
  /** Optional secondary provider video id (some providers use a separate video id). */
  providerVideoId: string | null;
  /** The filename on the provider (as stored). */
  filename: string | null;
  /** Display title (provider-provided or derived). */
  title: string | null;
  /** The provider's playback/player URL (NOT a raw stream URL — see module doc). */
  playbackUrl: string | null;
  /** The provider's thumbnail URL. */
  thumbnailUrl: string | null;
  /** File size in bytes (null when not reported). */
  sizeBytes: number | null;
  /** Duration in seconds (null when not reported). */
  durationSeconds: number | null;
  /** The source/uploaded quality (e.g. '720p', '1080p'). */
  sourceQuality: string | null;
  /** Available quality variants (for providers that transcode). */
  availableQualities: string[];
  /** Audio language labels the provider reports. */
  audioLanguages: string[];
  /** Whether subtitles are available (embedded or external). */
  hasSubtitles: boolean;
  /** The provider's own status string (verbatim — for provider-specific states). */
  providerStatus: string;
  /** Normalized Mavero-side lifecycle state. */
  status: AssetLifecycleState;
  /** The provider folder id the asset belongs to (null = root). */
  providerFolderId: string | null;
  /** Last-modified timestamp from the provider (ISO 8601, or null). */
  providerUpdatedAt: string | null;
  /** Raw provider metadata (non-sensitive, for diagnostics). */
  raw: Record<string, unknown>;
};

/** Normalized provider folder info. */
export type ProviderFolderInfo = {
  /** The provider's own folder identifier. */
  providerFolderId: string;
  /** Folder display name. */
  name: string;
  /** Parent folder id (null = root). Only present when nestedFolders is true. */
  parentFolderId: string | null;
  /** Number of direct children (files + subfolders), or null when not reported. */
  childCount: number | null;
  /** Raw provider metadata. */
  raw: Record<string, unknown>;
};

/** Normalized upload result (after a local-file or remote-URL upload completes). */
export type ProviderUploadResult = {
  /** The provider's asset identifier for the newly uploaded file. */
  providerAssetId: string;
  /** Optional secondary video id. */
  providerVideoId: string | null;
  /** The provider's playback/player URL for the uploaded file. */
  playbackUrl: string | null;
  /** The provider's initial status string (e.g. 'processing', 'active'). */
  providerStatus: string;
  /** Normalized Mavero-side lifecycle state. */
  status: AssetLifecycleState;
  /** File size in bytes (if known at upload time). */
  sizeBytes: number | null;
  /** Raw provider metadata. */
  raw: Record<string, unknown>;
};

/** Normalized encoding/processing status. */
export type ProviderProcessingStatus = {
  /** Normalized Mavero-side lifecycle state. */
  status: AssetLifecycleState;
  /** The provider's own status string (verbatim). */
  providerStatus: string;
  /** Progress percentage 0-100 (null when not reported). */
  progressPercent: number | null;
  /** Available quality variants (updated by processing). */
  availableQualities: string[];
  /** Error code from the provider (null when no error). */
  providerErrorCode: string | null;
  /** Error message from the provider (null when no error). */
  providerErrorMessage: string | null;
};

// ---------------------------------------------------------------------------
// Lifecycle state mapping (Phase 2 corrected — uses `queued`, NOT `pending`)
// ---------------------------------------------------------------------------

export type AssetLifecycleState =
  | 'queued'
  | 'uploading'
  | 'uploaded'
  | 'processing'
  | 'ready'
  | 'failed'
  | 'deleted';

/**
 * Maps a provider's own status string to the canonical Mavero
 * AssetLifecycleState. Each adapter implements this; the mapping
 * is provider-specific.
 *
 * The `deleted` state is the Mavero-side administrative terminal
 * state retained by the Phase 2 correction (NOT part of the plan's
 * public upload lifecycle §7.2).
 */
export type StatusMapper = (providerStatus: string) => AssetLifecycleState;

// ---------------------------------------------------------------------------
// Provider identity
// ---------------------------------------------------------------------------

/** Identifies which hosting provider an adapter serves. */
export type HostingProviderKey = 'vidara' | 'abyss';

// ---------------------------------------------------------------------------
// The adapter interface
// ---------------------------------------------------------------------------

/**
 * Injectable dependencies for the adapter (HTTP fetcher, etc.).
 * Tests inject a mock fetcher; production uses the default `fetch`.
 */
export type HostingAdapterDeps = {
  /** Custom fetch implementation (for testing). Defaults to global `fetch`. */
  fetcher?: typeof fetch;
  /** Custom AbortSignal (for overall deadline management). */
  signal?: AbortSignal;
};

/**
 * The provider-neutral hosting adapter interface.
 *
 * Each method accepts `deps` so the caller can inject a custom
 * fetcher, timeout signal, etc. Methods that talk to the provider
 * API are async; pure helpers (like `getCapabilities()`) are sync.
 *
 * An adapter that does NOT support a capability MUST throw
 * `HostingProviderError` with code `'UNSUPPORTED'` when the
 * corresponding method is called.
 */
export interface HostingProviderAdapter {
  /** Which hosting provider this adapter serves. */
  readonly providerKey: HostingProviderKey;

  /** The provider's verified capabilities. */
  getCapabilities(): ProviderCapabilities;

  /** Account / quota info. */
  getAccountInfo(deps?: HostingAdapterDeps): Promise<ProviderAccountInfo>;

  // --- File / asset operations ---

  /** Get info about a single asset by its provider asset id. */
  getAsset(providerAssetId: string, deps?: HostingAdapterDeps): Promise<ProviderAssetInfo>;

  /** List assets (optionally filtered by folder). */
  listAssets(providerFolderId: string | null, deps?: HostingAdapterDeps): Promise<ProviderAssetInfo[]>;

  /** Rename an asset. */
  renameAsset(providerAssetId: string, newName: string, deps?: HostingAdapterDeps): Promise<ProviderAssetInfo>;

  /** Move an asset to a different folder. */
  moveAsset(providerAssetId: string, targetFolderId: string | null, deps?: HostingAdapterDeps): Promise<ProviderAssetInfo>;

  /** Delete an asset (provider-side deletion). */
  deleteAsset(providerAssetId: string, deps?: HostingAdapterDeps): Promise<void>;

  // --- Upload operations ---

  /**
   * Upload a local file via multipart.
   * `uploadRemote()` is separate because some providers support
   * remote URL upload but not local multipart, or vice versa.
   */
  uploadFile(params: UploadFileParams, deps?: HostingAdapterDeps): Promise<ProviderUploadResult>;

  /**
   * Upload via a remote URL (the provider fetches the URL).
   * Throws `UNSUPPORTED` if the adapter has not verified this
   * capability.
   */
  uploadRemote(params: UploadRemoteParams, deps?: HostingAdapterDeps): Promise<ProviderUploadResult>;

  // --- Processing status ---

  /** Get the current processing/encoding status of an asset. */
  getProcessingStatus(providerAssetId: string, deps?: HostingAdapterDeps): Promise<ProviderProcessingStatus>;

  // --- Folder operations ---

  /** List folders (optionally filtered by parent). */
  listFolders(parentFolderId: string | null, deps?: HostingAdapterDeps): Promise<ProviderFolderInfo[]>;

  /** Create a folder. Throws UNSUPPORTED if folderManagement is false. */
  createFolder(params: CreateFolderParams, deps?: HostingAdapterDeps): Promise<ProviderFolderInfo>;

  /** Rename a folder. */
  renameFolder(providerFolderId: string, newName: string, deps?: HostingAdapterDeps): Promise<ProviderFolderInfo>;

  /** Move a folder (if nestedFolders is supported). */
  moveFolder(providerFolderId: string, targetParentFolderId: string | null, deps?: HostingAdapterDeps): Promise<ProviderFolderInfo>;

  /** Delete a folder. */
  deleteFolder(providerFolderId: string, deps?: HostingAdapterDeps): Promise<void>;

  // --- Subtitle operations ---

  /** Upload an external subtitle file for an asset. */
  uploadSubtitle(params: UploadSubtitleParams, deps?: HostingAdapterDeps): Promise<void>;

  // --- Thumbnail operations ---

  /** Upload a thumbnail for an asset (if thumbnails capability is true). */
  uploadThumbnail(providerAssetId: string, thumbnailData: { url: string } | { base64: string }, deps?: HostingAdapterDeps): Promise<void>;
}

// ---------------------------------------------------------------------------
// Parameter types for adapter methods
// ---------------------------------------------------------------------------

export type UploadFileParams = {
  /** The file content (as a Blob or ArrayBuffer). */
  content: Blob | ArrayBuffer;
  /** The filename (including extension). */
  filename: string;
  /** Target folder id (null = root). */
  providerFolderId: string | null;
  /** Optional title override. */
  title?: string;
};

export type UploadRemoteParams = {
  /** The remote URL the provider should fetch. MUST be a direct downloadable media-file URL. */
  url: string;
  /** Target folder id (null = root). */
  providerFolderId: string | null;
  /** Optional filename override. */
  filename?: string;
  /** Optional title override. */
  title?: string;
};

export type CreateFolderParams = {
  /** Folder display name. */
  name: string;
  /** Parent folder id (null = root). Only used when nestedFolders is true. */
  parentFolderId: string | null;
};

export type UploadSubtitleParams = {
  /** The asset the subtitle belongs to. */
  providerAssetId: string;
  /** The subtitle file content. */
  content: Blob | ArrayBuffer;
  /** The subtitle filename (including extension, e.g. `movie.en.srt`). */
  filename: string;
  /** ISO 639-1 language code (e.g. `en`, `hi`). */
  language: string;
  /** Whether this is the default track. */
  isDefault?: boolean;
};
