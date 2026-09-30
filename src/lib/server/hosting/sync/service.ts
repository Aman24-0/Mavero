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
      return {
        providerAdapterId: adapterId,
        totalProviderAssets: 0,
        updatedAssets: 0,
        deletedAssets: 0,
        unlinkedFiles: [],
        errors: [{ providerAssetId: '', errorCode: 'UNSUPPORTED', errorMessage: `No hosting adapter for ${adapterId}. The provider may be unconfigured.` }],
      };
    }

    const { data: providerRow } = await this.client
      .from('streaming_providers').select('id').eq('adapter_id', adapterId).limit(1).maybeSingle();
    if (!providerRow) {
      return {
        providerAdapterId: adapterId,
        totalProviderAssets: 0,
        updatedAssets: 0,
        deletedAssets: 0,
        unlinkedFiles: [],
        errors: [{ providerAssetId: '', errorCode: 'NOT_FOUND', errorMessage: `No provider row for adapter ${adapterId}. Run the Phase 4 migration or add a provider.` }],
      };
    }

    const { data: sourceRow } = await this.client
      .from('streaming_sources').select('id').eq('provider_id', providerRow.id).limit(1).maybeSingle();
    const providerSourceId = sourceRow?.id;
    if (!providerSourceId) {
      return {
        providerAdapterId: adapterId,
        totalProviderAssets: 0,
        updatedAssets: 0,
        deletedAssets: 0,
        unlinkedFiles: [],
        errors: [{ providerAssetId: '', errorCode: 'NOT_FOUND', errorMessage: `No source row for provider ${adapterId}.` }],
      };
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
          await this.client.from('media_assets').update({
            status: providerAsset.status,
            provider_status: providerAsset.providerStatus,
            playback_url: providerAsset.playbackUrl,
            thumbnail_url: providerAsset.thumbnailUrl,
            size_bytes: providerAsset.sizeBytes,
            duration_seconds: providerAsset.durationSeconds,
            available_qualities: providerAsset.availableQualities,
            audio_languages: providerAsset.audioLanguages,
            has_subtitles: providerAsset.hasSubtitles,
            last_synced_at: new Date().toISOString(),
            mavero_status: providerAsset.status === 'ready' ? 'available' : existing.mavero_status,
          }).eq('id', existing.id);
          updatedAssets += 1;
          // Phase 9: if the synced asset is ready, auto-resolve matching
          // missing-media demand requests. Fire-and-forget — does NOT block sync.
          if (providerAsset.status === 'ready') {
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

    const { data: sourceRow } = await this.client.from('streaming_sources').select('provider_id').eq('id', ar.provider_source_id).maybeSingle();
    const { data: providerRow } = await this.client.from('streaming_providers').select('adapter_id').eq('id', sourceRow?.provider_id ?? '').maybeSingle();
    const adapterId = providerRow?.adapter_id;
    if (!adapterId) throw new Error('Provider adapter_id not found.');
    const adapter = getHostingAdapter(adapterId);
    if (!adapter) throw new Error(`No hosting adapter for ${adapterId}.`);

    const procStatus = await adapter.getProcessingStatus(ar.provider_asset_id);
    await this.client.from('media_assets').update({
      status: procStatus.status, provider_status: procStatus.providerStatus,
      available_qualities: procStatus.availableQualities, error_code: procStatus.providerErrorCode,
      error_message: procStatus.providerErrorMessage, last_synced_at: new Date().toISOString(),
      mavero_status: procStatus.status === 'ready' ? 'available' : ar.mavero_status,
    }).eq('id', mediaAssetId);

    if (procStatus.status === 'ready') {
      await this.client.from('media_upload_operations').update({ status: 'ready', ready_at: new Date().toISOString() }).eq('media_asset_id', mediaAssetId).in('status', ['processing', 'uploaded']);
      // Phase 9: auto-resolve matching missing-media demand requests.
      await this.resolveDemandForAsset(mediaAssetId);
    } else if (procStatus.status === 'failed') {
      await this.client.from('media_upload_operations').update({ status: 'failed', failed_at: new Date().toISOString(), error_code: procStatus.providerErrorCode ?? 'PROVIDER_PROCESSING', error_message: procStatus.providerErrorMessage ?? 'Provider processing failed.' }).eq('media_asset_id', mediaAssetId).in('status', ['processing', 'uploaded']);
    }
    return { status: procStatus.status, providerStatus: procStatus.providerStatus, ready: procStatus.status === 'ready', failed: procStatus.status === 'failed' };
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
