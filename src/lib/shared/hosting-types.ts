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
  /** Asset counts (null if count query failed — partial failure contract) */
  assetCounts: {
    total: number;
    ready: number;
    processing: number;
    failed: number;
    deleted: number;
    unlinked: number;
  } | null;
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
  /** Linked media item — null when the asset is unlinked (mavero_status='missing' or media_item_id is null) */
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

export type HostingAssetQuery = {
  q?: string;
  provider?: string;        // adapter id
  linked?: 'linked' | 'unlinked' | 'all';
  status?: AssetLifecycleStatus | 'all';
  contentType?: 'movie' | 'series' | 'anime' | 'all';
  hasSubtitles?: boolean | null;
  sort?: 'recently_updated' | 'recently_added' | 'status' | 'provider';
  page?: number;
  limit?: number;
};

export type HostingAssetListResult = {
  items: HostingAssetRow[];
  total: number;
  page: number;
  limit: number;
  hasMore: boolean;
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
