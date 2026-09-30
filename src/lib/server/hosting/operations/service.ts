/**
 * Admin 2.0 — Phase F — Operations Center service.
 *
 * Aggregated read model for the Operations workspace. Combines:
 *   - media_upload_operations (Jobs tab — active + recent upload operations)
 *   - media_operations (History tab — immutable audit timeline)
 *   - stale detection + failed ops + provider health (Attention tab)
 *
 * Three read methods:
 *   - listJobs(query) — paginated, filtered jobs from media_upload_operations
 *   - listHistory(query) — paginated, filtered audit events from media_operations
 *   - listAttention(query) — aggregated items needing admin action
 *   - getBadgeCounts() — lightweight counts for nav badges
 *
 * Why a dedicated read model:
 *   - The existing /api/admin/media/operations endpoint has no pagination,
 *     no search, no date filter. It returns up to 200 rows with a limit param.
 *   - The existing /api/admin/media/stale endpoint returns only stale upload
 *     operations — it does NOT aggregate with failed ops or unconfigured
 *     providers for the Attention view.
 *   - Without this read model, the client would need 4+ requests per tab
 *     (jobs + stale + failed + health).
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
  JobRow, JobQuery, JobListResult, JobStatus,
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

const HOSTING_ADAPTER_IDS = ['vidara', 'abyss'] as const;

// ============================================================
// Service
// ============================================================

export class OperationsService {
  constructor(private client: SupabaseClient<Database>) {}

  // ------------------------------------------------------------
  // Jobs — from media_upload_operations
  // ------------------------------------------------------------

  async listJobs(query: JobQuery): Promise<JobListResult> {
    const page = clampPage(query.page);
    const limit = clampLimit(query.limit);
    const offset = (page - 1) * limit;
    const sort = query.sort ?? 'recently_updated';

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

    // Status filter — supports 'active' (non-terminal) + 'stale' (derived)
    if (query.status === 'active') {
      qb = qb.in('status', ['queued', 'uploading', 'uploaded', 'processing']);
    } else if (query.status && query.status !== 'all') {
      qb = qb.eq('status', query.status);
    }

    // Operation type filter — derived from source_url (remote vs local) + parent_operation_id (retry)
    if (query.operationType && query.operationType !== 'all') {
      if (query.operationType === 'upload_remote') {
        qb = qb.not('source_url', 'is', null);
      } else if (query.operationType === 'upload') {
        qb = qb.is('source_url', null);
      } else if (query.operationType === 'retry') {
        qb = qb.not('parent_operation_id', 'is', null);
      }
    }

    // Provider filter — resolve adapter → source_ids
    if (query.provider && query.provider !== 'all') {
      const sourceIds = await this.sourceIdsForAdapter(query.provider);
      if (sourceIds.length === 0) return { items: [], total: 0, page, limit, hasMore: false };
      qb = qb.in('provider_source_id', sourceIds);
    }

    // Retryable filter — applied post-fetch (error_code based)
    // Stale filter — applied post-fetch (updated_at based)

    // Search — operation id, media title, provider_asset_id
    if (query.q && query.q.trim()) {
      const q = query.q.trim();
      // Operation ID match
      if (/^[0-9a-f]{8}-/i.test(q)) {
        qb = qb.eq('id', q);
      } else {
        // Search via media_item title join + provider_asset_id
        qb = qb.or(`media_item.title.ilike.%${q}%,provider_asset_id.ilike.%${q}%`);
      }
    }

    // Sorting
    switch (sort) {
      case 'newest':         qb = qb.order('created_at', { ascending: false }); break;
      case 'oldest':         qb = qb.order('created_at', { ascending: true }); break;
      case 'recently_updated': qb = qb.order('updated_at', { ascending: false }); break;
      case 'failed':         qb = qb.order('failed_at', { ascending: false, nullsFirst: false }); break;
      case 'stale':
        // Stale first = oldest updated_at among non-terminal states.
        qb = qb.in('status', STALE_STATES).order('updated_at', { ascending: true }); break;
      default:               qb = qb.order('updated_at', { ascending: false }); break;
    }

    qb = qb.range(offset, offset + limit - 1);

    const { data, error, count } = await qb;
    if (error) throw new Error(`OperationsService.listJobs: ${error.message}`);

    const now = Date.now();
    let items: JobRow[] = (data ?? []).map((row: any) => {
      const updatedAtMs = row.updated_at ? new Date(row.updated_at).getTime() : now;
      const isStale = STALE_STATES.includes(row.status) && (now - updatedAtMs) > STALE_THRESHOLD_MS;
      const isRetryable = row.status === 'failed' && RETRYABLE_ERROR_CODES.has(row.error_code ?? '');
      const operationType: 'upload' | 'upload_remote' | 'retry' =
        row.parent_operation_id ? 'retry' : row.source_url ? 'upload_remote' : 'upload';
      return {
        id: row.id,
        status: row.status as JobStatus,
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

    // Post-fetch filters: retryable + stale
    if (query.retryable === true) items = items.filter((i) => i.isRetryable);
    else if (query.retryable === false) items = items.filter((i) => !i.isRetryable);
    if (query.stale === true) items = items.filter((i) => i.isStale);
    else if (query.stale === false) items = items.filter((i) => !i.isStale);

    // Fill providerAdapterId via source lookup
    const sourceIds = [...new Set(items.map((i) => i.providerSourceId).filter(Boolean))] as string[];
    if (sourceIds.length > 0) {
      const adapterBySource = await this.adapterBySourceIds(sourceIds);
      for (const item of items) {
        if (item.providerSourceId) {
          item.providerAdapterId = adapterBySource.get(item.providerSourceId) ?? null;
        }
      }
    }

    const total = count ?? 0;
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
        admin_user:profiles(id, email)
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
      adminUserEmail: row.admin_user?.email ?? null,
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
