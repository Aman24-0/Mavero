/**
 * Admin 2.0 — Phase F — Operations Center service.
 *
 * Aggregated read model for the Operations workspace (now the Jobs /
 * Activity / Attention tabs of Hosting Control). Combines:
 *   - media_upload_operations (Jobs tab — active + recent upload operations)
 *   - media_operations (Activity tab — immutable audit timeline; ALSO the
 *     source of operational management jobs — see listJobs)
 *   - stale detection + failed ops + provider health (Attention tab)
 *
 * JOBS — UNIFIED OPERATIONAL READ MODEL (final remediation):
 *   listJobs() merges TWO sources into ONE operational execution stream:
 *
 *   1. media_upload_operations — upload / remote upload / retry /
 *      processing pipeline jobs (the original Jobs dataset).
 *
 *   2. media_operations rows whose action is an operational MANAGEMENT
 *      action: provider_delete, rename, move, detach, reactivate, link,
 *      subtitle_upload, replace, sync. These are instantaneous provider/
 *      lifecycle operations that belong in the operational stream — the
 *      user specifically requires file deletion to appear in Jobs with a
 *      Deleted filter.
 *
 *   NO duplicate rows are created: upload-lifecycle events (upload,
 *   upload_remote, processing_started, ready, failed, retry) exist in BOTH
 *   tables (media_operations is the audit mirror of the upload pipeline) —
 *   those actions are sourced ONLY from media_upload_operations in the
 *   Jobs stream, so a single event never appears twice. media_operations
 *   remains the single source for the Activity (audit) tab.
 *
 *   Merged pagination: the top (page × limit) rows are fetched from each
 *   source (sorted by the SAME key), merged, re-sorted, and sliced. Any
 *   row in the first K merged rows must be within the top K of its own
 *   source, so the merged window is exact. total = sum of both counts.
 *
 *   FILTER INVARIANT (Issue B): every filter — status, operationType,
 *   provider, search, retryable, stale — is pushed into the per-source
 *   DB queries. `count: 'exact'` returns the count of the FULL filtered
 *   set (PostgREST ignores .limit() for exact counts — verified against
 *   the live instance), so rows, total, page count, and hasMore always
 *   describe the SAME logical dataset. There is NO post-fetch filtering.
 *
 *   Status semantics (Issue A): the Deleted status filter means
 *   SUCCESSFULLY completed file deletions only (media_operations rows
 *   with action='provider_delete' AND status='success' — a provider
 *   404/NOT_FOUND counts as success per ManagementService.deleteAsset).
 *   FAILED delete attempts appear under the Failed filter, never under
 *   Deleted. Upload jobs can never be "deleted" (deletion applies to
 *   media assets via management operations only).
 *
 * Three read methods:
 *   - listJobs(query) — paginated, filtered UNIFIED operational stream
 *   - listHistory(query) — paginated, filtered audit events from media_operations
 *   - listAttention(query) — aggregated items needing admin action
 *   - getBadgeCounts() — lightweight counts for nav badges
 *
 * Partial-failure contract:
 *   - If provider health check fails during Attention aggregation, the
 *     Attention list still loads — health items are skipped.
 *   - If a media_item join fails for a job, the job still loads with
 *     mediaItem=null.
 *
 * SECURITY: SERVER-SIDE ONLY. No credentials are exposed. The read model
 * intentionally does NOT expose provider_metadata jsonb or playback_url.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '$lib/server/supabase/database.types';
import { getVidaraConfigOrNull } from '../vidara/config';
import { getAbyssConfigOrNull } from '../abyss/config';
import type {
  JobRow, JobQuery, JobListResult, JobStatus, JobOperationType, JobOrigin,
  HistoryRow, HistoryQuery, HistoryListResult, HistoryAction, HistoryStatus,
  AttentionItem, AttentionQuery, AttentionListResult,
  AttentionCategory, AttentionSeverity,
  OpsBadgeCounts,
} from '$lib/shared/operations-types';

// ============================================================
// Constants
// ============================================================

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

const STALE_THRESHOLD_MS = 60 * 60 * 1000; // 60 minutes
const STALE_STATES = ['uploading', 'uploaded', 'processing'];

const RETRYABLE_ERROR_CODES = new Set(['RATE_LIMITED', 'TRANSIENT', 'NETWORK', 'TIMEOUT']);

/** Retryable error codes as an array — for PostgREST `.in('error_code', ...)`. */
const RETRYABLE_ERROR_CODES_LIST = [...RETRYABLE_ERROR_CODES];

/**
 * Builds the PostgREST or-filter for "NOT retryable" (the complement of
 * status='failed' AND error_code IN retryables). Three-value-logic-safe:
 * rows with NULL error_code are included via the explicit is.null arm.
 * Verified against the live PostgREST instance (G1+G2 = total).
 */
const NOT_RETRYABLE_OR = `status.neq.failed,error_code.is.null,error_code.not.in.(${RETRYABLE_ERROR_CODES_LIST.join(',')})`;

/**
 * Builds the PostgREST or-filter for "NOT stale" (the complement of
 * status IN stale-states AND updated_at < staleBefore).
 */
function notStaleOr(staleBeforeIso: string): string {
  return `status.not.in.(${STALE_STATES.join(',')}),updated_at.gte.${staleBeforeIso}`;
}

const HOSTING_ADAPTER_IDS = ['vidara', 'abyss'] as const;

/**
 * media_operations actions that are operational MANAGEMENT work and thus
 * appear in the Jobs stream (mapped to JobOperationType). Upload-lifecycle
 * actions are deliberately EXCLUDED — they are represented by their
 * media_upload_operations rows and would otherwise duplicate the same event.
 */
const MANAGEMENT_ACTION_TO_TYPE: Record<string, JobOperationType> = {
  provider_delete: 'delete',
  rename: 'rename',
  move: 'move',
  detach: 'detach',
  reactivate: 'reactivate',
  link: 'link',
  subtitle_upload: 'subtitle',
  replace: 'replace',
  sync: 'sync',
};

const MANAGEMENT_ACTIONS = Object.keys(MANAGEMENT_ACTION_TO_TYPE);

/** media_operations.status → JobRow.status (single vocabulary). */
function managementStatusToJobStatus(status: string): JobStatus {
  if (status === 'success') return 'ready';
  if (status === 'failed') return 'failed';
  return 'processing'; // 'pending'
}

// ============================================================
// Service
// ============================================================

export class OperationsService {
  constructor(private client: SupabaseClient<Database>) {}

  // ------------------------------------------------------------
  // Jobs — unified operational stream (uploads + management ops)
  // ------------------------------------------------------------

  async listJobs(query: JobQuery): Promise<JobListResult> {
    const page = clampPage(query.page);
    const limit = clampLimit(query.limit);
    const offset = (page - 1) * limit;
    const sort = query.sort ?? 'recently_updated';
    // Merged-window depth: the top K rows from EACH source are enough to
    // produce the exact merged page window (see class doc).
    const fetchDepth = offset + limit;

    const status = query.status ?? 'all';
    const operationType = query.operationType ?? 'all';

    // ==========================================================
    // Source selection — which tables feed this query.
    //
    //  - 'deleted' status or 'delete' type → management ops ONLY
    //    (action='provider_delete').
    //  - Concrete upload statuses / 'active' / upload-pipeline types
    //    → uploads ONLY.
    //  - 'ready'/'failed'/'all' + 'all' types → BOTH sources.
    //
    //  retryable/stale are NOT part of source selection: they are
    //  pushed into each source's DB query with their natural
    //  per-source semantics (management rows are never stale and
    //  never retryable — see the pushdown below), so rows, total,
    //  and hasMore always describe ONE logical dataset.
    // ==========================================================
    const isManagementOnly =
      status === 'deleted' ||
      (operationType !== 'all' && operationType !== 'upload' && operationType !== 'upload_remote' && operationType !== 'retry');
    const isUploadOnly =
      !isManagementOnly &&
      (['queued', 'uploading', 'uploaded', 'processing', 'cancelled', 'active'].includes(status) ||
        operationType === 'upload' || operationType === 'upload_remote' || operationType === 'retry');
    const includeUploads = !isManagementOnly;
    const includeManagement = !isUploadOnly;

    // Provider filter — resolve adapter → source_ids once, shared by both sources.
    let providerSourceIds: string[] | null = null;
    if (query.provider && query.provider !== 'all') {
      providerSourceIds = await this.sourceIdsForAdapter(query.provider);
      if (providerSourceIds.length === 0) {
        return { items: [], total: 0, page, limit, hasMore: false };
      }
    }

    // ==========================================================
    // Source A — media_upload_operations
    // ==========================================================
    const noSource = { data: [] as any[], error: null as any, count: 0 };
    let uploadsPromise: Promise<{ data: any[] | null; error: any; count: number | null }> = Promise.resolve(noSource);
    if (includeUploads) {
      let qb = this.client
        .from('media_upload_operations')
        .select(`
          id, status, attempt_number, parent_operation_id, provider_source_id,
          media_item_id, media_asset_id, provider_asset_id, source_quality,
          source_filename, source_url, error_code, error_message,
          queued_at, upload_started_at, uploaded_at, processing_started_at,
          ready_at, failed_at, cancelled_at, created_at, updated_at,
          media_item:media_items(id, title, content_type, tmdb_id, season, episode)
        `, { count: 'exact' });

      // Status filter — 'active' (non-terminal), 'stale' (pushed to the DB:
      // non-terminal + updated_at older than the 60-minute threshold —
      // previously this hit eq('status','stale') which matched 0 rows),
      // or a concrete status. (status==='deleted' is impossible here —
      // it forces isManagementOnly, which excludes this source.)
      if (status === 'active') {
        qb = qb.in('status', ['queued', 'uploading', 'uploaded', 'processing']);
      } else if (status === 'stale') {
        const staleBefore = new Date(Date.now() - STALE_THRESHOLD_MS).toISOString();
        qb = qb.in('status', STALE_STATES).lt('updated_at', staleBefore);
      } else if (status !== 'all') {
        qb = qb.eq('status', status as string);
      }

      // ========================================================
      // Retryable / stale pushdown (Issue B fix).
      // These MUST be DB-side filters: rows, total, page count, and
      // hasMore must all describe the SAME filtered dataset. Post-
      // fetching and filtering in JS would desynchronize them from
      // the exact DB count. Grammar verified against live PostgREST.
      //   retryable = status='failed' AND error_code IN retryables
      //   stale     = status IN stale-states AND updated_at < cutoff
      // ========================================================
      if (query.retryable === true) {
        qb = qb.eq('status', 'failed').in('error_code', RETRYABLE_ERROR_CODES_LIST);
      } else if (query.retryable === false) {
        qb = qb.or(NOT_RETRYABLE_OR);
      }
      if (query.stale === true) {
        const staleBefore = new Date(Date.now() - STALE_THRESHOLD_MS).toISOString();
        qb = qb.in('status', STALE_STATES).lt('updated_at', staleBefore);
      } else if (query.stale === false) {
        const staleBefore = new Date(Date.now() - STALE_THRESHOLD_MS).toISOString();
        qb = qb.or(notStaleOr(staleBefore));
      }

      // Operation type filter — derived from source_url (remote vs local) + parent_operation_id (retry)
      if (operationType !== 'all') {
        if (operationType === 'upload_remote') {
          qb = qb.not('source_url', 'is', null);
        } else if (operationType === 'upload') {
          qb = qb.is('source_url', null);
        } else if (operationType === 'retry') {
          qb = qb.not('parent_operation_id', 'is', null);
        }
      }

      if (providerSourceIds) {
        qb = qb.in('provider_source_id', providerSourceIds);
      }

      // Search — operation id, media title, provider_asset_id
      if (query.q && query.q.trim()) {
        const q = query.q.trim();
        if (/^[0-9a-f]{8}-/i.test(q)) {
          qb = qb.eq('id', q);
        } else {
          qb = qb.or(`media_item.title.ilike.%${q}%,provider_asset_id.ilike.%${q}%`);
        }
      }

      // Sorting — applied per-source by the SAME key used in the merge below.
      switch (sort) {
        case 'newest':           qb = qb.order('created_at', { ascending: false }); break;
        case 'oldest':           qb = qb.order('created_at', { ascending: true }); break;
        case 'recently_updated': qb = qb.order('updated_at', { ascending: false }); break;
        case 'failed':           qb = qb.order('failed_at', { ascending: false, nullsFirst: false }); break;
        case 'stale':            qb = qb.in('status', STALE_STATES).order('updated_at', { ascending: true }); break;
        default:                 qb = qb.order('updated_at', { ascending: false }); break;
      }

      // Merged-window depth (NOT the visible page — see class doc).
      qb = qb.limit(fetchDepth);
      uploadsPromise = (async () => await qb)();
    }

    // ==========================================================
    // Source B — media_operations (operational MANAGEMENT actions only)
    // ==========================================================
    let managementPromise: Promise<{ data: any[] | null; error: any; count: number | null }> = Promise.resolve(noSource);
    if (includeManagement) {
      let mb = this.client
        .from('media_operations')
        .select(`
          id, action, status, error_code, error_message, details,
          occurred_at, created_at, provider_source_id,
          media_item_id, media_asset_id,
          media_item:media_items(id, title, content_type, tmdb_id, season, episode),
          media_asset:media_assets(id, provider_asset_id)
        `, { count: 'exact' })
        .in('action', MANAGEMENT_ACTIONS);

      // Status mapping: media_operations.status ∈ {success, failed, pending}
      // → JobRow.status ∈ {ready, failed, processing}.
      if (status === 'ready') {
        mb = mb.eq('status', 'success');
      } else if (status === 'failed') {
        mb = mb.eq('status', 'failed');
      } else if (status === 'deleted') {
        // The Deleted view: SUCCESSFULLY completed file deletions ONLY —
        // the provider confirmed the delete, OR returned 404/NOT_FOUND
        // (which ManagementService.deleteAsset treats as success since
        // the file is already gone → terminal deleted state).
        // FAILED delete attempts do NOT appear here — the provider
        // returned a real error and the file still exists; those rows
        // surface under the Failed filter instead (status='failed').
        mb = mb.eq('action', 'provider_delete').eq('status', 'success');
      } else if (status === 'active' || status === 'stale') {
        // Management ops are instantaneous — nothing is ever "active".
        mb = mb.eq('status', '__none__'); // matches nothing
      }

      // ========================================================
      // Retryable / stale pushdown (Issue B fix).
      // Management ops are instantaneous provider calls: they are
      // NEVER stale (isStale ≡ false) and never retryable through the
      // upload pipeline (isRetryable ≡ false — they are retried via the
      // asset drawer). So the DB-side contribution is exact:
      //   retryable=true / stale=true  → contribute nothing (empty set)
      //   retryable=false / stale=false → contribute everything
      // ========================================================
      if (query.retryable === true || query.stale === true) {
        mb = mb.eq('action', '__none__'); // matches nothing
      }

      // Operation type filter — map JobOperationType back to DB actions.
      if (operationType !== 'all') {
        if (operationType === 'delete') {
          mb = mb.eq('action', 'provider_delete');
        } else {
          const dbAction = Object.keys(MANAGEMENT_ACTION_TO_TYPE).find((k) => MANAGEMENT_ACTION_TO_TYPE[k] === operationType);
          if (dbAction) {
            mb = mb.eq('action', dbAction);
          } else {
            // Upload-pipeline type requested — management source contributes nothing.
            mb = mb.eq('action', '__none__');
          }
        }
      }

      if (providerSourceIds) {
        mb = mb.in('provider_source_id', providerSourceIds);
      }

      // Search — operation id, media title, error code
      if (query.q && query.q.trim()) {
        const q = query.q.trim();
        if (/^[0-9a-f]{8}-/i.test(q)) {
          mb = mb.eq('id', q);
        } else {
          mb = mb.or(`media_item.title.ilike.%${q}%,error_code.ilike.%${q}%`);
        }
      }

      // Sorting — same keys; occurred_at is the management "updated_at".
      // The per-source fetch order MUST match the merge order below (same
      // key AND direction) — the merged window is only exact when each
      // source window comes from the same end of the ordering.
      switch (sort) {
        case 'newest':           mb = mb.order('created_at', { ascending: false }); break;
        case 'oldest':           mb = mb.order('created_at', { ascending: true }); break;
        case 'recently_updated': mb = mb.order('occurred_at', { ascending: false }); break;
        case 'failed':           mb = mb.order('occurred_at', { ascending: false }); break;
        // Merge direction for 'stale' is ASCENDING (longest-stuck first) —
        // the management window must come from the SAME end (oldest
        // occurred_at first), not the newest.
        case 'stale':            mb = mb.order('occurred_at', { ascending: true }); break;
        default:                 mb = mb.order('occurred_at', { ascending: false }); break;
      }

      mb = mb.limit(fetchDepth);
      managementPromise = (async () => await mb)();
    }

    const [uploadsRes, managementRes] = await Promise.all([uploadsPromise, managementPromise]);
    if (uploadsRes.error) throw new Error(`OperationsService.listJobs (uploads): ${uploadsRes.error.message}`);
    if (managementRes.error) throw new Error(`OperationsService.listJobs (management): ${managementRes.error.message}`);

    const now = Date.now();
    const uploadItems: JobRow[] = ((uploadsRes.data ?? []) as any[]).map((row) => {
      const updatedAtMs = row.updated_at ? new Date(row.updated_at).getTime() : now;
      const isStale = STALE_STATES.includes(row.status) && (now - updatedAtMs) > STALE_THRESHOLD_MS;
      const isRetryable = row.status === 'failed' && RETRYABLE_ERROR_CODES.has(row.error_code ?? '');
      const operationType: JobOperationType =
        row.parent_operation_id ? 'retry' : row.source_url ? 'upload_remote' : 'upload';
      return {
        id: row.id,
        status: row.status as JobStatus,
        origin: 'upload' as JobOrigin,
        attemptNumber: row.attempt_number,
        parentOperationId: row.parent_operation_id,
        providerSourceId: row.provider_source_id,
        providerAdapterId: null, // filled below
        mediaItemId: row.media_item_id,
        mediaAssetId: row.media_asset_id,
        providerAssetId: row.provider_asset_id,
        sourceQuality: row.source_quality,
        sourceFilename: row.source_filename,
        sourceUrl: row.source_url,
        errorCode: row.error_code,
        errorMessage: row.error_message,
        queuedAt: row.queued_at,
        uploadStartedAt: row.upload_started_at,
        uploadedAt: row.uploaded_at,
        processingStartedAt: row.processing_started_at,
        readyAt: row.ready_at,
        failedAt: row.failed_at,
        cancelledAt: row.cancelled_at,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        isStale,
        isRetryable,
        operationType,
        mediaItem: row.media_item ? {
          id: row.media_item.id,
          title: row.media_item.title,
          contentType: row.media_item.content_type,
          tmdbId: row.media_item.tmdb_id,
          season: row.media_item.season,
          episode: row.media_item.episode,
        } : null,
      };
    });

    const managementItems: JobRow[] = ((managementRes.data ?? []) as any[]).map((row) => {
      const opType = MANAGEMENT_ACTION_TO_TYPE[row.action] ?? 'sync';
      // For delete operations the user-facing terminology is "Delete File"
      // — the internal DB action stays provider_delete (backward compat).
      const detailFilename = (row.details && typeof row.details === 'object')
        ? ((row.details as Record<string, unknown>).provider_asset_id as string | undefined) ?? null
        : null;
      return {
        id: row.id,
        status: managementStatusToJobStatus(row.status),
        origin: 'management' as JobOrigin,
        attemptNumber: 1,
        parentOperationId: null,
        providerSourceId: row.provider_source_id,
        providerAdapterId: null, // filled below
        mediaItemId: row.media_item_id,
        mediaAssetId: row.media_asset_id,
        providerAssetId: row.media_asset?.provider_asset_id ?? detailFilename,
        sourceQuality: null,
        sourceFilename: null,
        sourceUrl: null,
        errorCode: row.error_code,
        errorMessage: row.error_message,
        queuedAt: row.created_at,
        uploadStartedAt: null,
        uploadedAt: null,
        processingStartedAt: row.status === 'pending' ? row.occurred_at : null,
        readyAt: row.status === 'success' ? row.occurred_at : null,
        failedAt: row.status === 'failed' ? row.occurred_at : null,
        cancelledAt: null,
        createdAt: row.created_at,
        updatedAt: row.occurred_at,
        isStale: false, // management ops are instantaneous
        isRetryable: false, // retried via the asset drawer, not the upload pipeline
        operationType: opType,
        mediaItem: row.media_item ? {
          id: row.media_item.id,
          title: row.media_item.title,
          contentType: row.media_item.content_type,
          tmdbId: row.media_item.tmdb_id,
          season: row.media_item.season,
          episode: row.media_item.episode,
        } : null,
      };
    });

    // NOTE: no post-fetch filtering. Every filter (status, operationType,
    // provider, search, retryable, stale) is pushed into the DB queries
    // above, so `merged`, `total`, and `hasMore` all describe the SAME
    // logical dataset. The derived per-row flags (isStale / isRetryable
    // below) are display badges only — they are computed for EVERY row,
    // not used to filter.
    const merged = [...uploadItems, ...managementItems];

    // Merge sort — the SAME key each source was sorted by, applied to the
    // combined window. Deterministic and exact (see class doc).
    const sortValue = (i: JobRow): number | string => {
      switch (sort) {
        case 'newest': case 'oldest':
          return new Date(i.createdAt).getTime();
        case 'failed':
          if (i.origin === 'management') return i.failedAt ? new Date(i.failedAt).getTime() : 0;
          return i.failedAt ? new Date(i.failedAt).getTime() : 0;
        case 'stale':
          return new Date(i.updatedAt).getTime();
        default: // recently_updated
          return new Date(i.updatedAt).getTime();
      }
    };
    const ascending = sort === 'oldest' || sort === 'stale';
    merged.sort((a, b) => {
      const va = sortValue(a);
      const vb = sortValue(b);
      const diff = (va as number) - (vb as number);
      return ascending ? diff : -diff;
    });

    // Fill providerAdapterId via source lookup (both sources).
    const sourceIds = [...new Set(merged.map((i) => i.providerSourceId).filter(Boolean))] as string[];
    if (sourceIds.length > 0) {
      const adapterBySource = await this.adapterBySourceIds(sourceIds);
      for (const item of merged) {
        if (item.providerSourceId) {
          item.providerAdapterId = adapterBySource.get(item.providerSourceId) ?? null;
        }
      }
    }

    const total = (uploadsRes.count ?? 0) + (managementRes.count ?? 0);
    const items = merged.slice(offset, offset + limit);
    return { items, total, page, limit, hasMore: offset + limit < total };
  }

  // ------------------------------------------------------------
  // History — from media_operations
  // ------------------------------------------------------------

  async listHistory(query: HistoryQuery): Promise<HistoryListResult> {
    const page = clampPage(query.page);
    const limit = clampLimit(query.limit);
    const offset = (page - 1) * limit;

    let qb = this.client
      .from('media_operations')
      .select(`
        id, action, status, details, error_code, error_message, occurred_at, created_at,
        provider_source_id, upload_operation_id,
        media_item:media_items(id, title, content_type, tmdb_id, season, episode),
        media_asset:media_assets(id, provider_asset_id, status),
        admin_user:profiles(id, display_name)
      `, { count: 'exact' })
      .order('occurred_at', { ascending: false });

    if (query.action && query.action !== 'all') {
      qb = qb.eq('action', query.action);
    }
    if (query.status && query.status !== 'all') {
      qb = qb.eq('status', query.status);
    }
    if (query.provider && query.provider !== 'all') {
      const sourceIds = await this.sourceIdsForAdapter(query.provider);
      if (sourceIds.length === 0) return { items: [], total: 0, page, limit, hasMore: false };
      qb = qb.in('provider_source_id', sourceIds);
    }

    // Search — operation id, media title, provider_asset_id, error code
    if (query.q && query.q.trim()) {
      const q = query.q.trim();
      if (/^[0-9a-f]{8}-/i.test(q)) {
        qb = qb.eq('id', q);
      } else {
        qb = qb.or(`media_item.title.ilike.%${q}%,error_code.ilike.%${q}%`);
      }
    }

    qb = qb.range(offset, offset + limit - 1);

    const { data, error, count } = await qb;
    if (error) throw new Error(`OperationsService.listHistory: ${error.message}`);

    const sourceIds = [...new Set((data ?? []).map((r: any) => r.provider_source_id).filter(Boolean))] as string[];
    const adapterBySource = sourceIds.length > 0 ? await this.adapterBySourceIds(sourceIds) : new Map<string, string>();

    const items: HistoryRow[] = (data ?? []).map((row: any) => ({
      id: row.id,
      action: row.action as HistoryAction,
      status: row.status as HistoryStatus,
      details: (row.details ?? {}) as Record<string, unknown>,
      errorCode: row.error_code,
      errorMessage: row.error_message,
      occurredAt: row.occurred_at,
      createdAt: row.created_at,
      providerSourceId: row.provider_source_id,
      providerAdapterId: row.provider_source_id ? (adapterBySource.get(row.provider_source_id) ?? null) : null,
      uploadOperationId: row.upload_operation_id,
      adminUserDisplayName: row.admin_user?.display_name ?? null,
      mediaItem: row.media_item ? {
        id: row.media_item.id,
        title: row.media_item.title,
        contentType: row.media_item.content_type,
        tmdbId: row.media_item.tmdb_id,
        season: row.media_item.season,
        episode: row.media_item.episode,
      } : null,
      mediaAsset: row.media_asset ? {
        id: row.media_asset.id,
        providerAssetId: row.media_asset.provider_asset_id,
        status: row.media_asset.status,
      } : null,
    }));

    const total = count ?? 0;
    return { items, total, page, limit, hasMore: offset + limit < total };
  }

  // ------------------------------------------------------------
  // Attention — aggregated from multiple sources
  // ------------------------------------------------------------

  async listAttention(query: AttentionQuery): Promise<AttentionListResult> {
    const page = clampPage(query.page);
    const limit = clampLimit(query.limit);
    const offset = (page - 1) * limit;

    const items: AttentionItem[] = [];
    const now = Date.now();
    const staleBefore = new Date(now - STALE_THRESHOLD_MS).toISOString();

    // 1. Failed upload operations
    const { data: failedOps } = await this.client
      .from('media_upload_operations')
      .select('id, status, error_code, error_message, updated_at, media_item_id, media_asset_id, provider_source_id, source_filename, source_url, attempt_number')
      .eq('status', 'failed')
      .order('updated_at', { ascending: false })
      .limit(100);

    for (const op of (failedOps ?? []) as any[]) {
      const adapterId = op.provider_source_id ? await this.adapterForSource(op.provider_source_id) : null;
      const isRetryable = RETRYABLE_ERROR_CODES.has(op.error_code ?? '');
      items.push({
        id: `failed-${op.id}`,
        category: 'failed',
        severity: isRetryable ? 'warning' : 'critical',
        title: op.source_url ? `Remote upload failed` : `Upload failed`,
        description: op.error_message ?? 'Operation failed.',
        source: 'upload_operation',
        sourceId: op.id,
        providerAdapterId: adapterId,
        mediaItemId: op.media_item_id,
        mediaAssetId: op.media_asset_id,
        errorCode: op.error_code,
        errorMessage: op.error_message,
        detectedAt: op.updated_at,
        canRetry: isRetryable,
        canReconcile: false,
      });
    }

    // 2. Stale upload operations
    const { data: staleOps } = await this.client
      .from('media_upload_operations')
      .select('id, status, error_code, error_message, updated_at, media_item_id, media_asset_id, provider_source_id, source_filename, source_url')
      .in('status', STALE_STATES)
      .lt('updated_at', staleBefore)
      .order('updated_at', { ascending: true })
      .limit(100);

    for (const op of (staleOps ?? []) as any[]) {
      const adapterId = op.provider_source_id ? await this.adapterForSource(op.provider_source_id) : null;
      items.push({
        id: `stale-${op.id}`,
        category: 'stale',
        severity: 'warning',
        title: `Stale operation (${op.status})`,
        description: `Operation has been in "${op.status}" state for over 60 minutes.`,
        source: 'upload_operation',
        sourceId: op.id,
        providerAdapterId: adapterId,
        mediaItemId: op.media_item_id,
        mediaAssetId: op.media_asset_id,
        errorCode: op.error_code,
        errorMessage: op.error_message,
        detectedAt: op.updated_at,
        canRetry: false,
        canReconcile: Boolean(op.media_asset_id),
      });
    }

    // 3. Unconfigured providers (credentials missing)
    for (const adapterId of HOSTING_ADAPTER_IDS) {
      const configured = adapterId === 'vidara' ? getVidaraConfigOrNull() !== null : getAbyssConfigOrNull() !== null;
      if (!configured) {
        // Check if the provider row exists (it may be disabled but still "expected")
        const { data: providerRow } = await this.client
          .from('streaming_providers')
          .select('id, name, enabled')
          .eq('adapter_id', adapterId)
          .maybeSingle();
        if (providerRow) {
          items.push({
            id: `unconfigured-${adapterId}`,
            category: 'unconfigured',
            severity: 'warning',
            title: `${adapterId} not configured`,
            description: `Server-side credentials are missing for ${adapterId}. Upload and sync are not available.`,
            source: 'provider',
            sourceId: adapterId,
            providerAdapterId: adapterId,
            mediaItemId: null,
            mediaAssetId: null,
            errorCode: 'MISCONFIGURED',
            errorMessage: `${adapterId.toUpperCase()}_API_KEY is not configured.`,
            detectedAt: new Date().toISOString(),
            canRetry: false,
            canReconcile: false,
          });
        }
      }
    }

    // 4. Degraded provider health (best-effort — skip if health check fails)
    // We check health inline rather than calling ProviderHealthService to
    // avoid circular imports + keep this method self-contained.
    for (const adapterId of HOSTING_ADAPTER_IDS) {
      const configured = adapterId === 'vidara' ? getVidaraConfigOrNull() !== null : getAbyssConfigOrNull() !== null;
      if (!configured) continue; // already in 'unconfigured' above
      try {
        const { ProviderHealthService } = await import('../health/service');
        const healthService = new ProviderHealthService(this.client);
        const report = await healthService.checkProvider(adapterId);
        if (report.status === 'unavailable' || report.status === 'degraded') {
          items.push({
            id: `degraded-${adapterId}`,
            category: 'degraded',
            severity: report.status === 'unavailable' ? 'critical' : 'warning',
            title: `${adapterId} health ${report.status}`,
            description: report.lastError ?? `Provider is ${report.status}.`,
            source: 'provider',
            sourceId: adapterId,
            providerAdapterId: adapterId,
            mediaItemId: null,
            mediaAssetId: null,
            errorCode: report.status === 'unavailable' ? 'UNAVAILABLE' : 'DEGRADED',
            errorMessage: report.lastError,
            detectedAt: report.checkedAt,
            canRetry: false,
            canReconcile: false,
          });
        }
      } catch {
        // Health check failed — skip this item. Don't break the whole Attention list.
      }
    }

    // Sort by severity (critical first) then by detectedAt (newest first)
    const severityOrder: Record<AttentionSeverity, number> = { critical: 0, warning: 1, info: 2 };
    items.sort((a, b) => {
      const sevDiff = severityOrder[a.severity] - severityOrder[b.severity];
      if (sevDiff !== 0) return sevDiff;
      return new Date(b.detectedAt).getTime() - new Date(a.detectedAt).getTime();
    });

    // Apply filters
    let filtered = items;
    if (query.category && query.category !== 'all') {
      filtered = filtered.filter((i) => i.category === query.category);
    }
    if (query.severity && query.severity !== 'all') {
      filtered = filtered.filter((i) => i.severity === query.severity);
    }
    if (query.provider && query.provider !== 'all') {
      filtered = filtered.filter((i) => i.providerAdapterId === query.provider);
    }

    const total = filtered.length;
    const paged = filtered.slice(offset, offset + limit);

    return {
      items: paged,
      total,
      page,
      limit,
      hasMore: offset + limit < total,
      counts: {
        failed: items.filter((i) => i.category === 'failed').length,
        stale: items.filter((i) => i.category === 'stale').length,
        unconfigured: items.filter((i) => i.category === 'unconfigured').length,
        degraded: items.filter((i) => i.category === 'degraded').length,
        total: items.length,
      },
    };
  }

  // ------------------------------------------------------------
  // Badge counts — lightweight for nav badges
  // ------------------------------------------------------------

  async getBadgeCounts(): Promise<OpsBadgeCounts> {
    // Phase 2 perf: run the three media_upload_operations counts in parallel
    // (they are independent — no shared dependencies). Previously this was
    // three sequential awaits, costing ~3 round-trips of latency.
    const staleBefore = new Date(Date.now() - STALE_THRESHOLD_MS).toISOString();
    const [activeRes, failedRes, staleRes] = await Promise.all([
      this.client
        .from('media_upload_operations')
        .select('id', { count: 'exact', head: true })
        .in('status', ['queued', 'uploading', 'uploaded', 'processing']),
      this.client
        .from('media_upload_operations')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'failed'),
      this.client
        .from('media_upload_operations')
        .select('id', { count: 'exact', head: true })
        .in('status', STALE_STATES)
        .lt('updated_at', staleBefore),
    ]);

    // Unconfigured providers (cheap — just env var checks). The two adapter
    // lookups are also independent — parallelize them.
    const unconfiguredProviders = await Promise.all(
      HOSTING_ADAPTER_IDS.map(async (adapterId) => {
        const configured = adapterId === 'vidara' ? getVidaraConfigOrNull() !== null : getAbyssConfigOrNull() !== null;
        if (configured) return false;
        // Only count if the provider row exists (expected but not configured)
        const { data: providerRow } = await this.client
          .from('streaming_providers')
          .select('id')
          .eq('adapter_id', adapterId)
          .maybeSingle();
        return Boolean(providerRow);
      })
    );
    const unconfiguredCount = unconfiguredProviders.filter(Boolean).length;

    return {
      jobsActive: activeRes.count ?? 0,
      attentionTotal: (failedRes.count ?? 0) + (staleRes.count ?? 0) + unconfiguredCount,
    };
  }

  // ------------------------------------------------------------
  // Helpers
  // ------------------------------------------------------------

  private async sourceIdsForAdapter(adapterId: string): Promise<string[]> {
    const { data: providerRow } = await this.client
      .from('streaming_providers')
      .select('id')
      .eq('adapter_id', adapterId)
      .maybeSingle();
    if (!providerRow) return [];
    const { data: sourceRows } = await this.client
      .from('streaming_sources')
      .select('id')
      .eq('provider_id', providerRow.id);
    return (sourceRows ?? []).map((s) => s.id);
  }

  private async adapterBySourceIds(sourceIds: string[]): Promise<Map<string, string>> {
    if (sourceIds.length === 0) return new Map();
    const { data: sourceRows } = await this.client
      .from('streaming_sources')
      .select('id, provider_id')
      .in('id', sourceIds);
    const sRows = (sourceRows ?? []) as Array<{ id: string; provider_id: string }>;
    const providerIds = sRows.map((s) => s.provider_id);
    if (providerIds.length === 0) return new Map();
    const { data: providerRows } = await this.client
      .from('streaming_providers')
      .select('id, adapter_id')
      .in('id', providerIds);
    const adapterByProvider = new Map<string, string>();
    for (const p of (providerRows ?? []) as Array<{ id: string; adapter_id: string | null }>) {
      if (p.adapter_id) adapterByProvider.set(p.id, p.adapter_id);
    }
    const result = new Map<string, string>();
    for (const s of sRows) {
      const adapter = adapterByProvider.get(s.provider_id);
      if (adapter) result.set(s.id, adapter);
    }
    return result;
  }

  private async adapterForSource(sourceId: string): Promise<string | null> {
    const map = await this.adapterBySourceIds([sourceId]);
    return map.get(sourceId) ?? null;
  }
}

// ============================================================
// Helpers
// ============================================================

function clampPage(page: unknown): number {
  const n = typeof page === 'number' ? page : parseInt(String(page ?? '1'), 10);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.floor(n);
}

function clampLimit(limit: unknown): number {
  const n = typeof limit === 'number' ? limit : parseInt(String(limit ?? String(DEFAULT_LIMIT)), 10);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_LIMIT;
  return Math.min(Math.floor(n), MAX_LIMIT);
}
