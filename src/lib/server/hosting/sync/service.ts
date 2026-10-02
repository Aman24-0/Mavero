/**
 * Phase 8 — Provider sync service.
 *
 * Reconciles provider-side asset state with Mavero's media_assets.
 * Idempotent: running sync twice does NOT create duplicate assets.
 *
 * For each provider:
 *   1. List provider assets via the adapter
 *   2. For each provider asset, check if a matching media_asset exists
 *   3. If the media_asset exists: update status/playback_url/metadata
 *   4. If no media_asset exists: report as "unlinked provider file"
 *   5. For each media_asset that has a provider_asset_id: check if the
 *      provider still has the file. If not: mark as 'deleted'.
 *
 * Does NOT guess TMDB matches for arbitrary provider-side files.
 * Unlinked files are returned for the admin to manually link.
 *
 * SECURITY: this service is SERVER-SIDE ONLY. It uses the adapter which
 * reads credentials from $env/dynamic/private. No credentials are
 * exposed to the client.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '$lib/server/supabase/database.types';
import { getHostingAdapter } from '../registry';
import { HostingProviderError } from '../errors';
import { resolveAdapterForSource, ProviderResolutionError } from '../provider-resolver';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SyncResult = {
  providerAdapterId: string;
  totalProviderAssets: number;
  updatedAssets: number;
  deletedAssets: number;
  unlinkedFiles: UnlinkedProviderFile[];
  errors: Array<{ providerAssetId: string; errorCode: string; errorMessage: string }>;
};

export type UnlinkedProviderFile = {
  providerAssetId: string;
  title: string | null;
  thumbnailUrl: string | null;
  sizeBytes: number | null;
  durationSeconds: number | null;
  status: string;
  providerStatus: string;
};

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class SyncService {
  constructor(private client: SupabaseClient<Database>) {}

  async syncProvider(adapterId: string): Promise<SyncResult> {
    const adapter = getHostingAdapter(adapterId);
    if (!adapter) {
      // Phase E: return a structured "failed" result instead of throwing,
      // so the UI can render "Unconfigured / Unsupported" without catching.
      // syncAll() already converted this case to a structured result; we
      // now do the same at the syncProvider level for direct callers.
      const result = {
        providerAdapterId: adapterId,
        totalProviderAssets: 0,
        updatedAssets: 0,
        deletedAssets: 0,
        unlinkedFiles: [],
        errors: [{ providerAssetId: '', errorCode: 'UNSUPPORTED', errorMessage: `No hosting adapter for ${adapterId}. The provider may be unconfigured.` }],
      };
      // Phase F: record the failed sync attempt in the audit log.
      await this.recordSyncAudit({ adapterId, providerSourceId: null, outcome: 'failed', totalProviderAssets: 0, updatedAssets: 0, deletedAssets: 0, unlinkedCount: 0, errorCount: 1, firstError: result.errors[0] });
      return result;
    }

    const { data: providerRow } = await this.client
      .from('streaming_providers').select('id').eq('adapter_id', adapterId).limit(1).maybeSingle();
    if (!providerRow) {
      const result = {
        providerAdapterId: adapterId,
        totalProviderAssets: 0,
        updatedAssets: 0,
        deletedAssets: 0,
        unlinkedFiles: [],
        errors: [{ providerAssetId: '', errorCode: 'NOT_FOUND', errorMessage: `No provider row for adapter ${adapterId}. Run the Phase 4 migration or add a provider.` }],
      };
      await this.recordSyncAudit({ adapterId, providerSourceId: null, outcome: 'failed', totalProviderAssets: 0, updatedAssets: 0, deletedAssets: 0, unlinkedCount: 0, errorCount: 1, firstError: result.errors[0] });
      return result;
    }

    const { data: sourceRow } = await this.client
      .from('streaming_sources').select('id').eq('provider_id', providerRow.id).limit(1).maybeSingle();
    const providerSourceId = sourceRow?.id;
    if (!providerSourceId) {
      const result = {
        providerAdapterId: adapterId,
        totalProviderAssets: 0,
        updatedAssets: 0,
        deletedAssets: 0,
        unlinkedFiles: [],
        errors: [{ providerAssetId: '', errorCode: 'NOT_FOUND', errorMessage: `No source row for provider ${adapterId}.` }],
      };
      await this.recordSyncAudit({ adapterId, providerSourceId: null, outcome: 'failed', totalProviderAssets: 0, updatedAssets: 0, deletedAssets: 0, unlinkedCount: 0, errorCount: 1, firstError: result.errors[0] });
      return result;
    }

    const providerAssets = await adapter.listAssets(null);
    const providerAssetIds = new Set(providerAssets.map((a) => a.providerAssetId).filter(Boolean));

    const { data: maveroAssets } = await this.client
      .from('media_assets')
      .select('id, provider_asset_id, status, mavero_status')
      .eq('provider_source_id', providerSourceId)
      .not('provider_asset_id', 'is', null);

    const maveroAssetMap = new Map<string, { id: string; status: string; mavero_status: string }>();
    for (const asset of maveroAssets ?? []) {
      const pa = asset as { id: string; provider_asset_id: string; status: string; mavero_status: string };
      if (pa.provider_asset_id) maveroAssetMap.set(pa.provider_asset_id, { id: pa.id, status: pa.status, mavero_status: pa.mavero_status });
    }

    let updatedAssets = 0;
    let deletedAssets = 0;
    const unlinkedFiles: UnlinkedProviderFile[] = [];
    const errors: Array<{ providerAssetId: string; errorCode: string; errorMessage: string }> = [];

    for (const providerAsset of providerAssets) {
      if (!providerAsset.providerAssetId) continue;
      try {
        const existing = maveroAssetMap.get(providerAsset.providerAssetId);
        if (existing) {
          // PROCESSING-STATE ENRICHMENT (final 3-issue fix — Vidara
          // processing status): the file-info status alone cannot
          // distinguish "queued and waiting" from "queued and actively
          // encoding" (live-verified: /v1/video/info reports "queued"
          // while Vidara's page shows "Processing 14%"). Without this, a
          // sync that runs mid-encoding would OVERWRITE the asset's
          // 'processing' status (set by the upload poll) back to 'queued'.
          // For pre-active files only, ask the adapter's authoritative
          // getProcessingStatus (encoding endpoint + file info). Steady
          // state (all files active/ready) makes ZERO extra API calls.
          let effectiveStatus = providerAsset.status;
          let effectiveProviderStatus = providerAsset.providerStatus;
          if (providerAsset.status === 'queued') {
            try {
              const procStatus = await adapter.getProcessingStatus(providerAsset.providerAssetId);
              effectiveStatus = procStatus.status;
              effectiveProviderStatus = procStatus.providerStatus;
            } catch {
              // Keep the file-info-derived status — enrichment is
              // best-effort and must NOT fail the sync.
            }
          }
          await this.client.from('media_assets').update({
            status: effectiveStatus,
            provider_status: effectiveProviderStatus,
            playback_url: providerAsset.playbackUrl,
            thumbnail_url: providerAsset.thumbnailUrl,
            size_bytes: providerAsset.sizeBytes,
            duration_seconds: providerAsset.durationSeconds,
            available_qualities: providerAsset.availableQualities,
            audio_languages: providerAsset.audioLanguages,
            has_subtitles: providerAsset.hasSubtitles,
            last_synced_at: new Date().toISOString(),
            // DETACH DURABILITY (final remediation): mavero_status='missing'
            // is an admin-set detached state. Sync must NOT silently restore
            // 'available' for a detached asset when the provider still reports
            // the file ready — that would fight the admin's detach decision
            // (reactivateAsset is the only path back to 'available').
            // The processing → available transition still happens for
            // non-detached assets.
            mavero_status: effectiveStatus === 'ready' && existing.mavero_status !== 'missing' ? 'available' : existing.mavero_status,
          }).eq('id', existing.id);
          updatedAssets += 1;
          // Phase 9: if the synced asset is ready AND still linked (not
          // detached), auto-resolve matching missing-media demand requests.
          // Fire-and-forget — does NOT block sync.
          if (effectiveStatus === 'ready' && existing.mavero_status !== 'missing') {
            await this.resolveDemandForAsset(existing.id);
          }
        } else {
          unlinkedFiles.push({
            providerAssetId: providerAsset.providerAssetId,
            title: providerAsset.title,
            thumbnailUrl: providerAsset.thumbnailUrl,
            sizeBytes: providerAsset.sizeBytes,
            durationSeconds: providerAsset.durationSeconds,
            status: providerAsset.status,
            providerStatus: providerAsset.providerStatus,
          });
        }
      } catch (error) {
        const err = error instanceof HostingProviderError ? error : new HostingProviderError('UNKNOWN', { cause: error });
        errors.push({ providerAssetId: providerAsset.providerAssetId, errorCode: err.code, errorMessage: err.message });
      }
    }

    for (const [providerAssetId, maveroAsset] of maveroAssetMap) {
      if (!providerAssetIds.has(providerAssetId) && maveroAsset.status !== 'deleted') {
        await this.client.from('media_assets').update({
          status: 'deleted', mavero_status: 'missing', last_synced_at: new Date().toISOString(),
        }).eq('id', maveroAsset.id);
        deletedAssets += 1;
      }
    }

    // Phase F: record a sync audit event in media_operations.
    // One summary event per provider sync (NOT one per asset) — keeps
    // the audit trail readable + bounded. Stores aggregate counts in
    // `details` (safe, non-secret metadata).
    await this.recordSyncAudit({
      adapterId,
      providerSourceId,
      outcome: errors.length > 0 ? (updatedAssets > 0 ? 'partial' : 'failed') : 'success',
      totalProviderAssets: providerAssets.length,
      updatedAssets,
      deletedAssets,
      unlinkedCount: unlinkedFiles.length,
      errorCount: errors.length,
      firstError: errors[0] ?? null,
    });

    return { providerAdapterId: adapterId, totalProviderAssets: providerAssets.length, updatedAssets, deletedAssets, unlinkedFiles, errors };
  }

  async syncAll(): Promise<SyncResult[]> {
    const results: SyncResult[] = [];
    for (const adapterId of ['vidara', 'abyss'] as const) {
      try {
        results.push(await this.syncProvider(adapterId));
      } catch (error) {
        if (error instanceof HostingProviderError && error.code === 'UNSUPPORTED') continue;
        results.push({
          providerAdapterId: adapterId, totalProviderAssets: 0, updatedAssets: 0, deletedAssets: 0,
          unlinkedFiles: [], errors: [{ providerAssetId: '', errorCode: error instanceof HostingProviderError ? error.code : 'UNKNOWN', errorMessage: error instanceof Error ? error.message : 'Unknown error' }],
        });
      }
    }
    return results;
  }

  async reconcileAsset(mediaAssetId: string): Promise<{ status: string; providerStatus: string | null; ready: boolean; failed: boolean }> {
    const { data: asset } = await this.client
      .from('media_assets').select('id, provider_asset_id, provider_source_id, status, mavero_status').eq('id', mediaAssetId).maybeSingle();
    if (!asset) throw new Error('Media asset not found.');
    const ar = asset as { id: string; provider_asset_id: string | null; provider_source_id: string | null; status: string; mavero_status: string };
    if (!ar.provider_asset_id) throw new HostingProviderError('VALIDATION', { message: 'Media asset has no provider_asset_id.' });
    if (!ar.provider_source_id) throw new HostingProviderError('VALIDATION', { message: 'Media asset has no provider_source_id.' });

    // TERMINAL-STATE GUARD (final remediation): deleted assets are terminal —
    // no remote-file mutations (including reconcile) are permitted. The UI
    // hides the action; the backend MUST enforce it independently. Reconciling
    // a deleted row would poll the provider and flip its status away from
    // 'deleted', breaking the terminal contract.
    if (ar.status === 'deleted') {
      throw new HostingProviderError('ASSET_DELETED', { message: 'Deleted provider assets cannot be reconciled. The remote file has been permanently deleted.' });
    }

    // Phase C audit fix: use the CANONICAL provider resolver instead of
    // inline two-query lookup. Surfaces real errors with actionable codes.
    let adapter: ReturnType<typeof getHostingAdapter>;
    let adapterId: string;
    try {
      const resolution = await resolveAdapterForSource(this.client, ar.provider_source_id);
      adapter = resolution.adapter;
      adapterId = resolution.adapterId;
    } catch (err) {
      if (err instanceof ProviderResolutionError) {
        throw new HostingProviderError('NOT_FOUND', { message: err.message });
      }
      throw err;
    }

    const procStatus = await adapter.getProcessingStatus(ar.provider_asset_id);
    await this.client.from('media_assets').update({
      status: procStatus.status, provider_status: procStatus.providerStatus,
      available_qualities: procStatus.availableQualities, error_code: procStatus.providerErrorCode,
      error_message: procStatus.providerErrorMessage, last_synced_at: new Date().toISOString(),
      // DETACH DURABILITY (final remediation): reconcile is a metadata sync —
      // it must NOT silently restore 'available' for an admin-detached asset
      // (mavero_status='missing'). Reactivate is the explicit recovery path.
      mavero_status: procStatus.status === 'ready' && ar.mavero_status !== 'missing' ? 'available' : ar.mavero_status,
    }).eq('id', mediaAssetId);

    if (procStatus.status === 'ready') {
      await this.client.from('media_upload_operations').update({ status: 'ready', ready_at: new Date().toISOString() }).eq('media_asset_id', mediaAssetId).in('status', ['processing', 'uploaded']);
      // Phase 9: auto-resolve matching missing-media demand requests —
      // ONLY for still-linked (non-detached) assets.
      if (ar.mavero_status !== 'missing') {
        await this.resolveDemandForAsset(mediaAssetId);
      }
    } else if (procStatus.status === 'failed') {
      await this.client.from('media_upload_operations').update({ status: 'failed', failed_at: new Date().toISOString(), error_code: procStatus.providerErrorCode ?? 'PROVIDER_PROCESSING', error_message: procStatus.providerErrorMessage ?? 'Provider processing failed.' }).eq('media_asset_id', mediaAssetId).in('status', ['processing', 'uploaded']);
    }

    // Phase F: record the reconcile audit event. Uses action='sync' with
    // a `reconcile: true` flag in details so the audit trail distinguishes
    // per-asset reconciliation from full provider sync.
    const reconcileOutcome = procStatus.status === 'failed' ? 'failed' : 'success';
    try {
      await this.client.from('media_operations').insert({
        action: 'sync',
        status: reconcileOutcome,
        media_item_id: null,
        media_asset_id: mediaAssetId,
        provider_source_id: ar.provider_source_id,
        upload_operation_id: null,
        admin_user_id: null,
        details: {
          reconcile: true,
          adapter: adapterId,
          provider_asset_id: ar.provider_asset_id,
          previous_status: ar.status,
          new_status: procStatus.status,
          provider_status: procStatus.providerStatus,
        } as never,
        error_code: procStatus.providerErrorCode,
        error_message: procStatus.providerErrorMessage,
      });
    } catch {
      // Silently absorb — audit logging must NOT break reconcile.
    }

    return { status: procStatus.status, providerStatus: procStatus.providerStatus, ready: procStatus.status === 'ready', failed: procStatus.status === 'failed' };
  }

  /**
   * Phase F — Records a sync audit event in media_operations.
   * One summary event per provider sync (NOT one per asset). Stores
   * aggregate counts + the first error in `details` (safe metadata).
   * Fire-and-forget — audit failures must NOT break sync.
   */
  private async recordSyncAudit(params: {
    adapterId: string;
    providerSourceId: string | null;
    outcome: 'success' | 'partial' | 'failed';
    totalProviderAssets: number;
    updatedAssets: number;
    deletedAssets: number;
    unlinkedCount: number;
    errorCount: number;
    firstError: { providerAssetId: string; errorCode: string; errorMessage: string } | null;
  }): Promise<void> {
    try {
      await this.client.from('media_operations').insert({
        action: 'sync',
        status: params.outcome === 'success' ? 'success' : params.outcome === 'partial' ? 'success' : 'failed',
        media_item_id: null,
        media_asset_id: null,
        provider_source_id: params.providerSourceId,
        upload_operation_id: null,
        admin_user_id: null,
        details: {
          sync: true,
          adapter: params.adapterId,
          outcome: params.outcome,
          total_provider_assets: params.totalProviderAssets,
          updated_assets: params.updatedAssets,
          deleted_assets: params.deletedAssets,
          unlinked_count: params.unlinkedCount,
          error_count: params.errorCount,
          first_error: params.firstError,
        } as never,
        error_code: params.firstError?.errorCode ?? null,
        error_message: params.outcome === 'failed' ? (params.firstError?.errorMessage ?? 'Sync failed.') : null,
      });
    } catch {
      // Silently absorb — audit logging must NOT break sync.
    }
  }

  /**
   * Phase 9 — Auto-resolves matching missing-media demand requests when
   * a hosted asset becomes ready (via sync or reconcile). Looks up the
   * media_item_id from the media_asset, then the canonical_key from
   * the media_item, then calls DemandService.resolveDemand().
   *
   * Fire-and-forget — errors are silently absorbed. Only 'open' and
   * 'uploading' status requests are resolved. 'ignored' requests are
   * NOT reopened (admin explicitly dismissed them). 'ready' requests
   * are already resolved (idempotent — no duplicate resolution).
   */
  private async resolveDemandForAsset(mediaAssetId: string): Promise<void> {
    try {
      const { data: asset } = await this.client
        .from('media_assets')
        .select('media_item_id')
        .eq('id', mediaAssetId)
        .maybeSingle();
      const mediaItemId = (asset as { media_item_id?: string } | null)?.media_item_id;
      if (!mediaItemId) return;

      const { data: item } = await this.client
        .from('media_items')
        .select('canonical_key')
        .eq('id', mediaItemId)
        .maybeSingle();
      const canonicalKey = (item as { canonical_key?: string } | null)?.canonical_key;
      if (!canonicalKey) return;

      const { DemandService } = await import('../demand/service');
      const demandService = new DemandService(this.client);
      await demandService.resolveDemand(canonicalKey);
    } catch {
      // Silently absorb — auto-resolution must NOT break sync/reconcile.
    }
  }
}
