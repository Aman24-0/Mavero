/**
 * Admin 2.0 — Phase F — Shared types for the Operations Center workspace.
 *
 * Imported by:
 *   - the operations API endpoints (`src/routes/api/admin/operations/*`)
 *   - the operations page server loader (`src/routes/admin/operations/+page.server.ts`)
 *   - the operations UI components (`src/lib/components/admin2/AdminOps*.svelte`)
 *
 * These types are SERVER-SIDE shapes (no credentials, no provider_metadata
 * jsonb, no playback_url unless explicitly safe). The API layer is
 * responsible for projecting raw DB rows into these shapes.
 */

// ============================================================
// Jobs (from media_upload_operations)
// ============================================================

export type JobStatus = 'queued' | 'uploading' | 'uploaded' | 'processing' | 'ready' | 'failed' | 'cancelled';

/**
 * Where a Jobs row comes from in the unified operational read model:
 *   - 'upload'     → media_upload_operations (upload/remote-upload/retry pipeline)
 *   - 'management' → media_operations (provider_delete, rename, move, detach,
 *                    reactivate, link, subtitle_upload, replace, sync)
 *
 * Upload-lifecycle actions (upload, upload_remote, processing_started, ready,
 * failed, retry) are NEVER sourced from media_operations in the Jobs stream —
 * they are already represented by their media_upload_operations rows, so
 * including both would duplicate the same event.
 */
export type JobOrigin = 'upload' | 'management';

/**
 * Operation type of a Jobs row. Upload-pipeline types map 1:1 to
 * media_upload_operations rows; management types map to media_operations
 * actions. 'delete' is the management provider_delete action — surfaced in
 * the UI as "Delete File" (the internal DB action stays provider_delete).
 */
export type JobOperationType =
  | 'upload' | 'upload_remote' | 'retry'
  | 'delete' | 'rename' | 'move' | 'detach' | 'reactivate' | 'link'
  | 'subtitle' | 'replace' | 'sync';

export type JobRow = {
  id: string;
  status: JobStatus;
  origin: JobOrigin;
  attemptNumber: number;
  parentOperationId: string | null;
  providerSourceId: string | null;
  providerAdapterId: string | null;
  mediaItemId: string;
  mediaAssetId: string | null;
  providerAssetId: string | null;
  sourceQuality: string | null;
  sourceFilename: string | null;
  sourceUrl: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  queuedAt: string;
  uploadStartedAt: string | null;
  uploadedAt: string | null;
  processingStartedAt: string | null;
  readyAt: string | null;
  failedAt: string | null;
  cancelledAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** Derived: is this job stale (in non-terminal state for > 60 min)? */
  isStale: boolean;
  /** Derived: is the error retryable? (RATE_LIMITED, TRANSIENT, NETWORK, TIMEOUT) */
  isRetryable: boolean;
  /** Derived: operation type label */
  operationType: JobOperationType;
  /** Linked media item (null if media_item was deleted) */
  mediaItem: {
    id: string;
    title: string;
    contentType: 'movie' | 'series' | 'anime';
    tmdbId: string;
    season: number | null;
    episode: number | null;
  } | null;
};

export type JobQuery = {
  q?: string;
  /**
   * Status filter. In addition to concrete upload statuses:
   *   - 'active'   → non-terminal upload jobs (queued/uploading/uploaded/processing)
   *   - 'stale'    → non-terminal upload jobs stuck > 60 min (pushed to the DB query)
   *   - 'deleted'  → delete-file operations (media_operations action='provider_delete')
   *   - 'all'      → the full unified stream
   */
  status?: JobStatus | 'active' | 'stale' | 'deleted' | 'all';
  operationType?: JobOperationType | 'all';
  provider?: string;        // adapter id
  retryable?: boolean | null;
  stale?: boolean | null;
  sort?: 'newest' | 'oldest' | 'recently_updated' | 'failed' | 'stale';
  page?: number;
  limit?: number;
};

export type JobListResult = {
  items: JobRow[];
  total: number;
  page: number;
  limit: number;
  hasMore: boolean;
};

// ============================================================
// History (from media_operations)
// ============================================================

export type HistoryAction =
  | 'upload' | 'upload_remote' | 'processing_started' | 'ready' | 'failed'
  | 'retry' | 'rename' | 'move' | 'replace' | 'subtitle_upload' | 'sync'
  | 'provider_delete' | 'detach' | 'link' | 'reactivate'
  | 'create_media_item' | 'update_media_item' | 'delete_media_item'
  | 'create_folder' | 'update_folder' | 'delete_folder'
  | 'create_folder_mapping' | 'update_folder_mapping' | 'delete_folder_mapping'
  | 'resolve_availability';

export type HistoryStatus = 'success' | 'failed' | 'pending';

export type HistoryRow = {
  id: string;
  action: HistoryAction;
  status: HistoryStatus;
  details: Record<string, unknown>;
  errorCode: string | null;
  errorMessage: string | null;
  occurredAt: string;
  createdAt: string;
  providerSourceId: string | null;
  providerAdapterId: string | null;
  uploadOperationId: string | null;
  adminUserDisplayName: string | null;
  mediaItem: {
    id: string;
    title: string;
    contentType: 'movie' | 'series' | 'anime';
    tmdbId: string;
    season: number | null;
    episode: number | null;
  } | null;
  mediaAsset: {
    id: string;
    providerAssetId: string | null;
    status: string;
  } | null;
};

export type HistoryQuery = {
  q?: string;
  action?: HistoryAction | 'all';
  status?: HistoryStatus | 'all';
  provider?: string;        // adapter id
  page?: number;
  limit?: number;
};

export type HistoryListResult = {
  items: HistoryRow[];
  total: number;
  page: number;
  limit: number;
  hasMore: boolean;
};

// ============================================================
// Attention (aggregated from multiple sources)
// ============================================================

export type AttentionCategory = 'failed' | 'stale' | 'unconfigured' | 'degraded';
export type AttentionSeverity = 'critical' | 'warning' | 'info';

export type AttentionItem = {
  id: string;
  category: AttentionCategory;
  severity: AttentionSeverity;
  title: string;
  description: string;
  /** Source table: 'upload_operation' | 'media_operation' | 'provider' */
  source: 'upload_operation' | 'media_operation' | 'provider';
  /** The ID in the source table (for action navigation) */
  sourceId: string;
  providerAdapterId: string | null;
  mediaItemId: string | null;
  mediaAssetId: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  /** When the issue was first detected / last updated */
  detectedAt: string;
  /** Whether a retry action is available for this item */
  canRetry: boolean;
  /** Whether a reconcile action is available for this item */
  canReconcile: boolean;
};

export type AttentionQuery = {
  category?: AttentionCategory | 'all';
  severity?: AttentionSeverity | 'all';
  provider?: string;        // adapter id
  page?: number;
  limit?: number;
};

export type AttentionListResult = {
  items: AttentionItem[];
  total: number;
  page: number;
  limit: number;
  hasMore: boolean;
  /** Counts per category (for badge display) */
  counts: {
    failed: number;
    stale: number;
    unconfigured: number;
    degraded: number;
    total: number;
  };
};

// ============================================================
// Nav badge counts
// ============================================================

export type OpsBadgeCounts = {
  /** Active jobs = queued + uploading + uploaded + processing */
  jobsActive: number;
  /** Attention = failed + stale + unconfigured + degraded */
  attentionTotal: number;
};
