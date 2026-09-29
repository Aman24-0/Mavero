/**
 * Phase 6 — Upload operation service.
 *
 * Orchestrates the admin upload workflow:
 *   1. Create a media_upload_operations row (queued state)
 *   2. Ensure the canonical media item + folder (Phase 5)
 *   3. Execute the provider upload (Phase 3 adapter)
 *   4. Persist the normalized media_assets row
 *   5. Update operation state through the lifecycle
 *   6. Poll provider processing status
 *
 * State machine (Phase 2 corrected — uses `queued`, NOT `pending`):
 *   queued → uploading → uploaded → processing → ready
 *                                                    ↘ failed
 *                          ↳ cancelled (any state)
 *
 * Large-file architecture decision (user task brief §25):
 *
 * Netlify serverless functions have a body limit (~26MB Pro tier).
 * Video files are typically 100MB–10GB. Therefore:
 *
 *   Vidara local upload:
 *     Server gets the upload server URL from Vidara API (using the API
 *     key). The browser uploads directly to Vidara's upload server.
 *     The browser then calls back to Mavero with the result. The server
 *     normalizes and persists.
 *
 *   Abyss local upload:
 *     Abyss requires JWT auth — the browser cannot hold the JWT.
 *     The server proxies the upload for files within the platform body
 *     limit. For larger files, the admin should use remote URL upload
 *     (which Abyss does NOT currently support) or a direct upload
 *     mechanism to be designed in a future phase.
 *
 *   Remote URL upload (Vidara only):
 *     Server handles the entire flow server-side. The provider fetches
 *     the URL.
 *
 * This service is SERVER-SIDE ONLY. Provider credentials never reach
 * the browser.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '$lib/server/supabase/database.types';
import type { HostingProviderAdapter, ProviderUploadResult, ProviderProcessingStatus, AssetLifecycleState } from '../types';
import { getHostingAdapter } from '../registry';
import { CanonicalMediaService } from '../media/service';
import { HostingProviderError } from '../errors';
import type { EnsureMovieInput, EnsureSeriesInput, EnsureEpisodeInput, EnsureAnimeInput, EnsureAnimeEpisodeInput } from '../media/service';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type UploadSource = 'local' | 'remote';

export type CreateUploadOperationInput = {
  /** TMDB identity */
  tmdbId: string;
  imdbId?: string | null;
  title: string;
  year?: number | null;
  contentType: 'movie' | 'series' | 'anime';
  /** Episode-specific fields */
  season?: number;
  episode?: number;
  episodeTitle?: string | null;
  /** Provider selection */
  providerSourceId: string;
  providerAdapterId: string;
  /** Upload source */
  uploadSource: UploadSource;
  /** For remote upload: the URL the provider should fetch */
  remoteUrl?: string;
  /** Original filename (for local upload) */
  filename?: string;
  /** Source quality (e.g. '720p', '1080p') */
  sourceQuality?: string;
  /** Admin user ID */
  adminUserId: string;
};

export type UploadOperation = {
  id: string;
  media_item_id: string;
  provider_source_id: string | null;
  media_asset_id: string | null;
  parent_operation_id: string | null;
  provider_asset_id: string | null;
  status: string;
  attempt_number: number;
  progress_percent: number | null;
  source_quality: string | null;
  source_filename: string | null;
  source_url: string | null;
  error_code: string | null;
  error_message: string | null;
  requested_by_user_id: string | null;
  queued_at: string;
  upload_started_at: string | null;
  uploaded_at: string | null;
  processing_started_at: string | null;
  ready_at: string | null;
  failed_at: string | null;
  cancelled_at: string | null;
  created_at: string;
  updated_at: string;
};

// ---------------------------------------------------------------------------
// Polling constants
// ---------------------------------------------------------------------------

export const POLL_INTERVAL_MS = 10_000; // 10 seconds
export const POLL_MAX_ATTEMPTS = 60; // ~10 minutes max
export const POLL_TRANSITIONAL_STATES: AssetLifecycleState[] = ['processing', 'uploaded'];

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class UploadService {
  constructor(
    private client: SupabaseClient<Database>,
    private mediaService: CanonicalMediaService,
  ) {}

  // --- Operation creation ---

  /**
   * Creates a media_upload_operations row in `queued` state.
   * Also ensures the canonical media item + folder via Phase 5 service.
   */
  async createOperation(input: CreateUploadOperationInput): Promise<UploadOperation> {
    // 1. Ensure canonical media item + folder.
    let mediaItemId: string;
    let folderId: string;

    if (input.contentType === 'movie') {
      const result = await this.mediaService.ensureMovie({
        tmdbId: input.tmdbId,
        imdbId: input.imdbId,
        title: input.title,
        year: input.year,
      });
      mediaItemId = result.mediaItemId;
      folderId = result.folderId;
    } else if (input.contentType === 'series') {
      if (input.season != null && input.episode != null) {
        // Episode upload — ensure parent series first.
        await this.mediaService.ensureSeries({
          tmdbId: input.tmdbId,
          imdbId: input.imdbId,
          title: input.title,
          year: input.year,
        });
        const result = await this.mediaService.ensureEpisode({
          seriesTmdbId: input.tmdbId,
          season: input.season,
          episode: input.episode,
          episodeTitle: input.episodeTitle,
        });
        mediaItemId = result.mediaItemId;
        folderId = result.folderId;
      } else {
        const result = await this.mediaService.ensureSeries({
          tmdbId: input.tmdbId,
          imdbId: input.imdbId,
          title: input.title,
          year: input.year,
        });
        mediaItemId = result.mediaItemId;
        folderId = result.folderId;
      }
    } else {
      // Anime
      if (input.season != null && input.episode != null) {
        await this.mediaService.ensureAnime({
          tmdbId: input.tmdbId,
          imdbId: input.imdbId,
          title: input.title,
          year: input.year,
        });
        const result = await this.mediaService.ensureAnimeEpisode({
          seriesTmdbId: input.tmdbId,
          season: input.season,
          episode: input.episode,
          episodeTitle: input.episodeTitle,
        });
        mediaItemId = result.mediaItemId;
        folderId = result.folderId;
      } else {
        const result = await this.mediaService.ensureAnime({
          tmdbId: input.tmdbId,
          imdbId: input.imdbId,
          title: input.title,
          year: input.year,
        });
        mediaItemId = result.mediaItemId;
        folderId = result.folderId;
      }
    }

    // 2. Create the upload operation row.
    const { data, error } = await this.client
      .from('media_upload_operations')
      .insert({
        media_item_id: mediaItemId,
        provider_source_id: input.providerSourceId,
        status: 'queued',
        attempt_number: 1,
        source_quality: input.sourceQuality ?? null,
        source_filename: input.filename ?? null,
        source_url: input.remoteUrl ?? null,
        requested_by_user_id: input.adminUserId,
      })
      .select('*')
      .single();

    if (error || !data) {
      throw new Error(`Failed to create upload operation: ${error?.message ?? 'unknown'}`);
    }

    return data as unknown as UploadOperation;
  }

  // --- Execute upload (remote URL only — local upload is browser-direct for Vidara) ---

  /**
   * Executes a remote URL upload via the Phase 3 adapter.
   * Updates the operation state through uploading → uploaded → processing.
   * Creates the media_assets row.
   *
   * For local file uploads, the browser uploads directly to the provider's
   * upload server (Vidara) or through a server proxy (Abyss). The result
   * is then passed to `completeUploadFromResult()`.
   */
  async executeRemoteUpload(operationId: string): Promise<UploadOperation> {
    const op = await this.getOperation(operationId);
    if (!op) throw new Error('Upload operation not found.');
    if (op.status !== 'queued') throw new Error(`Operation is not queued (current: ${op.status}).`);

    // Get the adapter.
    // Look up the provider's adapter_id from the DB via a direct query.
    const { data: sourceRow } = await this.client
      .from('streaming_sources')
      .select('provider_id')
      .eq('id', op.provider_source_id!)
      .maybeSingle();

    if (!sourceRow?.provider_id) {
      throw new Error('Provider not found for source.');
    }

    const { data: providerRow } = await this.client
      .from('streaming_providers')
      .select('adapter_id')
      .eq('id', sourceRow.provider_id)
      .maybeSingle();

    if (!providerRow?.adapter_id) {
      throw new Error('Provider adapter_id not found.');
    }

    const providerAdapter = getHostingAdapter(providerRow.adapter_id);
    if (!providerAdapter) {
      throw new Error(`No hosting adapter found for adapter_id: ${providerRow.adapter_id}`);
    }

    // Check capability.
    const caps = providerAdapter.getCapabilities();
    if (!caps.remoteUpload) {
      throw new HostingProviderError('UNSUPPORTED', { message: 'This provider does not support remote URL upload.' });
    }

    try {
      // Update state: queued → uploading
      await this.updateOperationState(operationId, 'uploading', { upload_started_at: new Date().toISOString() });

      // Execute the remote upload.
      const result = await providerAdapter.uploadRemote({
        url: op.source_url ?? '',
        providerFolderId: null,
        filename: op.source_filename ?? undefined,
      });

      // CRITICAL FIX (Phase 8): validate that the upload result contains a
      // non-empty providerAssetId BEFORE creating the media_asset. The
      // previous implementation did NOT validate this — if the normalizer
      // failed to extract the filecode (empty string), the media_asset was
      // created with provider_asset_id = null (Supabase converts empty
      // string to null for nullable text columns). The operation then
      // transitioned to 'processing', but the polling could not find a
      // provider_asset_id to poll → the operation stayed stuck at
      // 'processing' forever.
      //
      // The completeUploadFromResult route (local upload path) already
      // validates this — the remote upload path was missing the same check.
      if (!result.providerAssetId) {
        throw new HostingProviderError('VALIDATION', {
          message: 'Remote upload succeeded but the provider response did not contain a provider asset ID (filecode). The upload may not have completed correctly.',
        });
      }

      // Update state: uploading → uploaded
      await this.updateOperationState(operationId, 'uploaded', { uploaded_at: new Date().toISOString() });

      // Create media_assets row.
      await this.createMediaAsset(op, result, providerAdapter);

      // Update state: uploaded → processing (if provider reports processing)
      await this.updateOperationState(operationId, 'processing', { processing_started_at: new Date().toISOString() });

      return await this.getOperation(operationId) as unknown as UploadOperation;
    } catch (error) {
      const err = error instanceof HostingProviderError ? error : new HostingProviderError('UNKNOWN', { cause: error });
      await this.updateOperationState(operationId, 'failed', {
        failed_at: new Date().toISOString(),
        error_code: err.code,
        error_message: err.message,
      });
      throw err;
    }
  }

  /**
   * Completes an upload from a provider result (used after browser-direct
   * upload to Vidara's upload server, or after a server-proxied upload).
   */
  async completeUploadFromResult(operationId: string, providerResult: ProviderUploadResult, adapterId: string): Promise<UploadOperation> {
    const op = await this.getOperation(operationId);
    if (!op) throw new Error('Upload operation not found.');

    const adapter = getHostingAdapter(adapterId);
    if (!adapter) throw new Error(`No hosting adapter found for adapter_id: ${adapterId}`);

    // Update state: → uploaded
    await this.updateOperationState(operationId, 'uploaded', { uploaded_at: new Date().toISOString() });

    // Create media_assets row.
    await this.createMediaAsset(op, providerResult, adapter);

    // Update state: uploaded → processing (provider typically starts encoding)
    await this.updateOperationState(operationId, 'processing', { processing_started_at: new Date().toISOString() });

    return await this.getOperation(operationId) as unknown as UploadOperation;
  }

  // --- Polling ---

  /**
   * Polls the provider processing status for an operation.
   * Returns the current state. Does NOT loop — the caller (API route)
   * calls this on each poll request.
   */
  async pollProcessingStatus(operationId: string): Promise<{ status: string; providerStatus: string | null; progressPercent: number | null; ready: boolean; failed: boolean }> {
    const op = await this.getOperation(operationId);
    if (!op) throw new Error('Upload operation not found.');
    if (op.status !== 'processing' && op.status !== 'uploaded') {
      return { status: op.status, providerStatus: null, progressPercent: null, ready: op.status === 'ready', failed: op.status === 'failed' };
    }

    // CRITICAL FIX (Phase 8): stale-operation safety. If the operation is
    // in 'processing' but has NO media_asset_id (or the media_asset has
    // no provider_asset_id), it CANNOT be polled — the operation is
    // stuck. Auto-fail it with a clear error instead of leaving it
    // stuck forever. This prevents the "processing with null
    // provider_asset_id" bug from creating permanent orphans.
    if (!op.media_asset_id) {
      await this.updateOperationState(operationId, 'failed', {
        failed_at: new Date().toISOString(),
        error_code: 'STALE_OPERATION',
        error_message: 'Operation is in processing state but has no associated media asset. The upload may have failed to produce a valid provider asset.',
      });
      return { status: 'failed', providerStatus: null, progressPercent: null, ready: false, failed: true };
    }

    // Look up the adapter via direct queries.
    const { data: sourceRow } = await this.client
      .from('streaming_sources')
      .select('provider_id')
      .eq('id', op.provider_source_id!)
      .maybeSingle();

    const { data: providerRow } = await this.client
      .from('streaming_providers')
      .select('adapter_id')
      .eq('id', sourceRow?.provider_id ?? '')
      .maybeSingle();

    const adapterId = providerRow?.adapter_id;
    if (!adapterId) throw new Error('Provider adapter_id not found.');

    const adapter = getHostingAdapter(adapterId);
    if (!adapter) throw new Error(`No hosting adapter for ${adapterId}.`);

    // Get the provider asset ID from the media_assets row.
    const { data: asset } = await this.client
      .from('media_assets')
      .select('provider_asset_id')
      .eq('id', op.media_asset_id)
      .maybeSingle();

    const providerAssetId = (asset as { provider_asset_id: string | null })?.provider_asset_id;
    if (!providerAssetId) {
      // CRITICAL FIX (Phase 8): auto-fail operations with no provider_asset_id
      // instead of throwing an unhandled error that leaves the operation stuck.
      await this.updateOperationState(operationId, 'failed', {
        failed_at: new Date().toISOString(),
        error_code: 'MISSING_ASSET_ID',
        error_message: 'The media asset has no provider_asset_id. The provider upload may not have completed correctly.',
      });
      // Also mark the media_asset as failed.
      await this.client.from('media_assets').update({
        status: 'failed',
        mavero_status: 'failed',
        error_code: 'MISSING_ASSET_ID',
        error_message: 'No provider_asset_id was stored during upload.',
      }).eq('id', op.media_asset_id);
      return { status: 'failed', providerStatus: null, progressPercent: null, ready: false, failed: true };
    }

    // Poll the provider.
    const procStatus = await adapter.getProcessingStatus(providerAssetId);

    // Update the media_assets row.
    await this.client
      .from('media_assets')
      .update({
        status: procStatus.status,
        provider_status: procStatus.providerStatus,
        available_qualities: procStatus.availableQualities,
        error_code: procStatus.providerErrorCode,
        error_message: procStatus.providerErrorMessage,
        last_synced_at: new Date().toISOString(),
      })
      .eq('id', op.media_asset_id);

    // Update the operation state.
    if (procStatus.status === 'ready') {
      await this.updateOperationState(operationId, 'ready', { ready_at: new Date().toISOString() });
      // Also update the media_assets mavero_status.
      await this.client.from('media_assets').update({ mavero_status: 'available' }).eq('id', op.media_asset_id);
      // Phase 8: record the ready transition in operation history.
      await this.recordOperation({
        action: 'ready',
        status: 'success',
        media_item_id: op.media_item_id,
        media_asset_id: op.media_asset_id ?? undefined,
        provider_source_id: op.provider_source_id ?? undefined,
        upload_operation_id: operationId,
        details: { provider_status: procStatus.providerStatus },
      });
      // Phase 9: auto-resolve any matching missing-media demand request.
      // Fire-and-forget — does NOT block playback or the upload lifecycle.
      await this.resolveDemandForMediaItem(op.media_item_id);
    } else if (procStatus.status === 'failed') {
      await this.updateOperationState(operationId, 'failed', {
        failed_at: new Date().toISOString(),
        error_code: procStatus.providerErrorCode ?? 'PROVIDER_PROCESSING',
        error_message: procStatus.providerErrorMessage ?? 'Provider processing failed.',
      });
      // Phase 8: record the failure in operation history.
      await this.recordOperation({
        action: 'failed',
        status: 'failed',
        media_item_id: op.media_item_id,
        media_asset_id: op.media_asset_id ?? undefined,
        provider_source_id: op.provider_source_id ?? undefined,
        upload_operation_id: operationId,
        error_code: procStatus.providerErrorCode ?? 'PROVIDER_PROCESSING',
        error_message: procStatus.providerErrorMessage ?? 'Provider processing failed.',
      });
    }

    return {
      status: procStatus.status,
      providerStatus: procStatus.providerStatus,
      progressPercent: procStatus.progressPercent,
      ready: procStatus.status === 'ready',
      failed: procStatus.status === 'failed',
    };
  }

  // --- Cancel ---

  async cancelOperation(operationId: string): Promise<UploadOperation> {
    const op = await this.getOperation(operationId);
    if (!op) throw new Error('Upload operation not found.');
    if (op.status === 'ready' || op.status === 'failed' || op.status === 'cancelled') {
      throw new Error(`Cannot cancel operation in ${op.status} state.`);
    }
    await this.updateOperationState(operationId, 'cancelled', { cancelled_at: new Date().toISOString() });
    return await this.getOperation(operationId) as unknown as UploadOperation;
  }

  // --- Retry ---

  async retryOperation(operationId: string): Promise<UploadOperation> {
    const op = await this.getOperation(operationId);
    if (!op) throw new Error('Upload operation not found.');
    if (op.status !== 'failed') throw new Error(`Cannot retry operation in ${op.status} state (must be failed).`);

    // Create a new operation linked to the original.
    const { data, error } = await this.client
      .from('media_upload_operations')
      .insert({
        media_item_id: op.media_item_id,
        provider_source_id: op.provider_source_id,
        status: 'queued',
        attempt_number: op.attempt_number + 1,
        parent_operation_id: operationId,
        source_quality: null,
        source_filename: null,
        source_url: null,
        requested_by_user_id: op.requested_by_user_id,
      })
      .select('*')
      .single();

    if (error || !data) throw new Error(`Failed to create retry operation: ${error?.message}`);
    return data as unknown as UploadOperation;
  }

  // --- Lookup ---

  async getOperation(operationId: string): Promise<UploadOperation | null> {
    const { data, error } = await this.client
      .from('media_upload_operations')
      .select('*')
      .eq('id', operationId)
      .maybeSingle();
    if (error) throw new Error(`DB error: ${error.message}`);
    return data as unknown as UploadOperation | null;
  }

  async listOperations(limit = 50): Promise<UploadOperation[]> {
    const { data, error } = await this.client
      .from('media_upload_operations')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) throw new Error(`DB error: ${error.message}`);
    return (data ?? []) as unknown as UploadOperation[];
  }

  // --- Internal helpers ---

  async updateOperationState(operationId: string, status: string, extra?: Record<string, string | number | null>): Promise<void> {
    // Use `any` cast because the Supabase typed client rejects Record<string, ...>
    // for the update method due to excess property checking.
    const update = { status, ...extra } as Record<string, unknown>;
    await (this.client.from('media_upload_operations') as unknown as { update: (values: Record<string, unknown>) => { eq: (col: string, val: string) => Promise<unknown> } }).update(update).eq('id', operationId);
  }

  private async createMediaAsset(op: UploadOperation, result: ProviderUploadResult, _adapter: HostingProviderAdapter): Promise<void> {
    const { data: assetRow } = await this.client
      .from('media_assets')
      .insert({
        media_item_id: op.media_item_id,
        provider_source_id: op.provider_source_id,
        provider_asset_id: result.providerAssetId,
        provider_video_id: result.providerVideoId,
        playback_url: result.playbackUrl,
        filename: op.source_filename,
        title: null,
        status: result.status,
        provider_status: result.providerStatus,
        mavero_status: 'processing',
        source_quality: op.source_quality,
        available_qualities: [],
        audio_languages: [],
        has_subtitles: false,
        size_bytes: result.sizeBytes,
        provider_metadata: JSON.parse(JSON.stringify(result.raw)),
        last_synced_at: new Date().toISOString(),
      })
      .select('id')
      .single();

    if (assetRow) {
      const assetId = (assetRow as { id: string }).id;
      await this.client.from('media_upload_operations').update({ media_asset_id: assetId }).eq('id', op.id);
      // Phase 8: record the operation in media_operations for audit history.
      await this.recordOperation({
        action: op.source_url ? 'upload_remote' : 'upload',
        status: 'success',
        media_item_id: op.media_item_id,
        media_asset_id: assetId,
        provider_source_id: op.provider_source_id ?? undefined,
        upload_operation_id: op.id,
        admin_user_id: op.requested_by_user_id ?? undefined,
        details: { provider_asset_id: result.providerAssetId, playback_url: result.playbackUrl },
      });
    }
  }

  /**
   * Phase 9 — Auto-resolves matching missing-media demand requests when
   * a hosted asset becomes ready. Looks up the canonical_key from the
   * media_items table and calls DemandService.resolveDemand().
   *
   * This is a fire-and-forget side effect — errors are silently absorbed.
   * Only 'open' and 'uploading' status requests are resolved.
   * 'ignored' requests are NOT reopened (admin explicitly dismissed them).
   * 'ready' requests are already resolved (idempotent).
   */
  private async resolveDemandForMediaItem(mediaItemId: string): Promise<void> {
    try {
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
      // Silently absorb — auto-resolution must NOT break the upload lifecycle.
    }
  }

  /**
   * Phase 8 — Records a management operation in the media_operations
   * audit table. Used by sync, reconcile, retry, cancel, and other
   * management actions to build a consistent operation history.
   *
   * SECURITY: never store credentials, tokens, or API keys in `details`.
   * The `details` field is jsonb and may be visible to admins.
   */
  async recordOperation(params: {
    action: string;
    status: 'success' | 'failed' | 'pending';
    media_item_id?: string;
    media_asset_id?: string;
    provider_source_id?: string;
    upload_operation_id?: string;
    admin_user_id?: string;
    details?: Record<string, unknown>;
    error_code?: string;
    error_message?: string;
  }): Promise<void> {
    try {
      await this.client.from('media_operations').insert({
        action: params.action,
        status: params.status,
        media_item_id: params.media_item_id ?? null,
        media_asset_id: params.media_asset_id ?? null,
        provider_source_id: params.provider_source_id ?? null,
        upload_operation_id: params.upload_operation_id ?? null,
        admin_user_id: params.admin_user_id ?? null,
        details: (params.details ?? {}) as never,
        error_code: params.error_code ?? null,
        error_message: params.error_message ?? null,
      });
    } catch {
      // Silently absorb — operation history is a best-effort audit trail.
      // A failure to record history must NOT break the main operation.
    }
  }
}
