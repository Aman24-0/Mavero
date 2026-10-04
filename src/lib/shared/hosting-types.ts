/**
 * Admin 2.0 — Phase E — Shared types for the Hosting Control workspace.
 *
 * Imported by:
 *   - the hosting API endpoints (`src/routes/api/admin/hosting/*`)
 *   - the hosting page server loader (`src/routes/admin/hosting/+page.server.ts`)
 *   - the hosting UI components (`src/lib/components/admin2/AdminHosting*.svelte`)
 *
 * These types are SERVER-SIDE shapes (no credentials, no provider_metadata
 * jsonb, no playback_url unless explicitly safe). The API layer is
 * responsible for projecting raw DB rows into these shapes — the UI
 * never reads raw provider metadata.
 */

import type { ProviderCapabilities } from '$lib/server/hosting/types';
import type { ProviderHealthStatus } from '$lib/server/hosting/health/service';

// ============================================================
// Provider overview
// ============================================================

export type HostingProviderQuota = {
  storageUsed: number | null;
  storageLimit: number | null;
  maxUploadSize: number | null;
  /** 'available' = quota reported, 'unknown' = provider doesn't expose quota, 'unavailable' = provider unreachable */
  availability: 'available' | 'unknown' | 'unavailable';
};

export type HostingProviderHealth = {
  status: ProviderHealthStatus;
  configured: boolean;
  latencyMs: number | null;
  lastError: string | null;
  checkedAt: string;
  quota: HostingProviderQuota | null;
};

export type HostingProviderOverview = {
  /** Adapter id ('vidara' | 'abyss') */
  adapterId: string;
  /** Provider row id from streaming_providers */
  providerId: string;
  /** Source row id from streaming_sources (the canonical Mavero source) */
  sourceId: string | null;
  /** Display name from streaming_providers */
  name: string;
  /** Slug from streaming_providers */
  slug: string;
  /** Whether the provider row is enabled */
  enabled: boolean;
  /** Whether the source row is enabled */
  sourceEnabled: boolean;
  /** Verified capability set from the adapter (never guessed) */
  capabilities: ProviderCapabilities;
  /** Health report (null if health check failed entirely) */
  health: HostingProviderHealth | null;
  /**
   * Asset counts (null if count query failed — partial failure contract).
   *
   * SEMANTICS (final 3-issue fix): `total` and `ready` count ONLY
   * currently-usable assets — status='ready' AND mavero_status='available'
   * (the canonical playback availability predicate used by the resolver,
   * the Media Library and the DemandService). Deleted / failed / queued /
   * processing / uploaded / detached / disabled rows are never counted.
   * `processing` / `failed` / `deleted` / `detached` are diagnostic
   * breakdowns of the non-usable rows and intentionally do NOT sum to
   * `total` — the Media Library remains the full lifecycle inventory.
   */
  assetCounts: {
    /** Usable assets: status='ready' AND mavero_status='available'. */
    total: number;
    /** Usable assets (same canonical predicate as `total`). */
    ready: number;
    /** Diagnostic: rows in queued/uploading/uploaded/processing states. */
    processing: number;
    /** Diagnostic: rows in the failed state. */
    failed: number;
    /** Diagnostic: rows in the terminal deleted state. */
    deleted: number;
    /** Detached assets: mavero_status='missing' AND status!='deleted' (still linked to a media_item) */
    detached: number;
  } | null;
  /**
   * PROVIDER INVENTORY snapshot (Abyss direct-upload discovery): the
   * provider-side file counts from the LATEST successful/partial sync,
   * as recorded on the sync audit. This is the only place unlinked
   * provider files can be counted — media_assets.media_item_id is NOT
   * NULL, so a provider file with no Mavero link has no row.
   *
   *   assets  = provider files that exist and are valid/working
   *             (not failed/banned/deleted) — includes UNLINKED files
   *   ready   = subset that is ready/playable per the provider
   *             integration's status mapping
   *   linked  = subset associated with Mavero media (LIVE count of
   *             media_assets rows for this source with a
   *             provider_asset_id, excluding terminal deleted rows)
   *
   * Null when this provider has never completed a post-hardening sync —
   * the UI shows an honest "—" (unknown), never a fake zero.
   */
  inventory: {
    assets: number;
    ready: number;
    linked: number;
    /** When the snapshot was taken (the sync audit row's created_at). */
    syncedAt: string;
  } | null;
  /**
   * Outcome of the LATEST sync attempt (any outcome, including failed).
   * A failed sync must be visible on the card — API health (auth/about)
   * and inventory discovery are DIFFERENT failure domains; a green
   * health badge must not mask a broken inventory sync.
   */
  lastSyncOutcome: 'success' | 'partial' | 'failed' | null;
  /** Error message from the latest failed/partial sync (null when none). */
  lastSyncError: string | null;
  /** Last sync timestamp (max of media_assets.last_synced_at for this source) */
  lastSyncAt: string | null;
};

// ============================================================
// Asset inventory
// ============================================================

export type AssetLifecycleStatus = 'queued' | 'uploading' | 'uploaded' | 'processing' | 'ready' | 'failed' | 'deleted';
export type AssetMaveroStatus = 'available' | 'missing' | 'processing' | 'failed' | 'disabled' | 'stale';

export type HostingAssetRow = {
  id: string;
  providerSourceId: string | null;
  providerAdapterId: string | null;
  providerAssetId: string | null;
  providerVideoId: string | null;
  filename: string | null;
  title: string | null;
  status: AssetLifecycleStatus;
  maveroStatus: AssetMaveroStatus;
  providerStatus: string | null;
  sourceQuality: string | null;
  availableQualities: string[];
  audioLanguages: string[];
  hasSubtitles: boolean;
  durationSeconds: number | null;
  sizeBytes: number | null;
  lastSyncedAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** Linked media item — null when the asset row has no media link (impossible under the NOT NULL schema; kept for defensive rendering) */
  mediaItem: {
    id: string;
    title: string;
    contentType: 'movie' | 'series' | 'anime';
    tmdbId: string;
    imdbId: string | null;
    canonicalKey: string;
    year: number | null;
    season: number | null;
    episode: number | null;
  } | null;
};

/**
 * Link-state filter for the asset inventory.
 *
 * ARCHITECTURE NOTE (final remediation): `media_assets.media_item_id` is
 * NOT NULL in the live schema — every row IS linked to a canonical
 * media_item. The meaningful distinction is therefore:
 *   - 'linked'   → mavero_status !== 'missing' (active link, playable when ready)
 *   - 'detached' → mavero_status = 'missing' (admin-detached; still belongs
 *                  to the media_item; remote file may still exist)
 * The legacy 'unlinked' value is accepted by the API as an alias for
 * 'detached' for backward compatibility with old bookmarks.
 */
export type HostingAssetLinkState = 'linked' | 'detached' | 'unlinked' | 'all';

export type HostingAssetQuery = {
  q?: string;
  provider?: string;        // adapter id
  linked?: HostingAssetLinkState;
  /**
   * Status filter. 'active' (the default) EXCLUDES terminal deleted
   * assets — deleted files never appear in the normal Media Library
   * inventory, counts, search, or pagination. 'deleted' is an explicit
   * opt-in audit view of terminal files. 'all' includes everything
   * (reserved for programmatic use; the UI never sends it by default).
   */
  status?: AssetLifecycleStatus | 'active' | 'all';
  contentType?: 'movie' | 'series' | 'anime' | 'all';
  hasSubtitles?: boolean | null;
  sort?: 'recently_updated' | 'recently_added' | 'status' | 'provider';
  /** Deep-link: constrain the inventory to one media_item's files (used by Jobs/Activity/Attention "Open media" links). */
  mediaItemId?: string | null;
  page?: number;
  limit?: number;
};

/**
 * Facet counts derived from the SAME canonical asset inventory the
 * Media Library displays. Each dimension's counts are computed with all
 * OTHER filters applied but the dimension itself removed (standard
 * facet semantics — the chips always show what you would get by
 * clicking them). Deleted assets never contribute (they are excluded
 * from the facet scope unless status='deleted' is explicitly selected).
 * Counts are FILE counts, not media-item counts.
 */
export type HostingAssetFacetCounts = {
  /** Active file counts per content type ('all' = total of the facet scope). */
  contentType: { all: number; movie: number; series: number; anime: number };
  /** Active file counts per hosting adapter ('all' = total of the facet scope). */
  provider: Record<string, number> & { all: number };
};

export type HostingAssetListResult = {
  items: HostingAssetRow[];
  total: number;
  page: number;
  limit: number;
  hasMore: boolean;
  /** Facet counts from the same inventory dataset (null if the facet queries failed — list still loads). */
  counts: HostingAssetFacetCounts | null;
};

// ============================================================
// Sync
// ============================================================

export type HostingSyncResultRow = {
  providerAdapterId: string;
  totalProviderAssets: number;
  updatedAssets: number;
  deletedAssets: number;
  unlinkedFileCount: number;
  errorCount: number;
  errors: Array<{ providerAssetId: string; errorCode: string; errorMessage: string }>;
  /** 'success' = sync completed without fatal errors; 'partial' = some per-asset errors; 'failed' = sync itself threw */
  outcome: 'success' | 'partial' | 'failed';
  errorMessage: string | null;
};

export type HostingUnlinkedFile = {
  providerAdapterId: string;
  providerAssetId: string;
  title: string | null;
  thumbnailUrl: string | null;
  sizeBytes: number | null;
  durationSeconds: number | null;
  status: string;
  providerStatus: string;
};

// ============================================================
// Reusable capability display config
// ============================================================

export type CapabilityRow = {
  key: keyof ProviderCapabilities;
  label: string;
  description: string;
};

export const CAPABILITY_ROWS: CapabilityRow[] = [
  { key: 'localUpload', label: 'Local upload', description: 'Multipart file upload via the provider API' },
  { key: 'remoteUpload', label: 'Remote URL upload', description: 'Provider fetches a URL server-side' },
  { key: 'folderManagement', label: 'Folder management', description: 'Create / list / rename / delete folders' },
  { key: 'nestedFolders', label: 'Nested folders', description: 'Folders can contain sub-folders' },
  { key: 'subtitles', label: 'Subtitles', description: 'External subtitle file upload' },
  { key: 'multiAudio', label: 'Multi-audio', description: 'Multiple audio tracks per asset' },
  { key: 'transcoding', label: 'Transcoding', description: 'Provider transcodes uploads into multiple quality variants' },
  { key: 'qualityVariants', label: 'Quality variants', description: 'Provider reports available quality variants' },
  { key: 'processingStatus', label: 'Processing status', description: 'Provider reports encoding / processing state' },
  { key: 'rename', label: 'Rename', description: 'Rename an existing asset' },
  { key: 'move', label: 'Move', description: 'Move an asset between folders' },
  { key: 'delete', label: 'Delete', description: 'Delete an asset' },
  { key: 'thumbnails', label: 'Thumbnails', description: 'Thumbnail upload' },
];
