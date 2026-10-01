/**
 * Phase 8 — Media management service.
 *
 * Wraps provider adapter operations (rename, move, detach, delete)
 * with Mavero state updates and operation history recording.
 *
 * Architecture:
 *   Admin Route → requireAdmin → ManagementService → adapter operation
 *   → update media_assets → record media_operations history → return result
 *
 * SECURITY: this service is SERVER-SIDE ONLY. No credentials are
 * exposed to the client. Operation details never contain secrets.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '$lib/server/supabase/database.types';
import { getHostingAdapter } from '../registry';
import { HostingProviderError } from '../errors';
import { UploadService } from '../upload/service';
import { CanonicalMediaService } from '../media/service';
import { resolveAdapterForSource, ProviderResolutionError } from '../provider-resolver';

export type ManagementResult = {
  ok: boolean;
  action: string;
  mediaAssetId: string;
  providerAssetId: string | null;
  error?: { code: string; message: string };
};

export class ManagementService {
  private uploadService: UploadService;

  constructor(
    private client: SupabaseClient<Database>,
    private mediaService: CanonicalMediaService,
  ) {
    this.uploadService = new UploadService(client, mediaService);
  }

  /**
   * Renames a provider-side asset and updates the Mavero media_asset.
   * Uses the adapter's renameAsset method. Does NOT change the canonical
   * media_item title — only the provider-side filename/title.
   */
  async renameAsset(mediaAssetId: string, newName: string, adminUserId?: string): Promise<ManagementResult> {
    const asset = await this.getMediaAsset(mediaAssetId);
    if (!asset.provider_asset_id) {
      throw new HostingProviderError('VALIDATION', { message: 'Media asset has no provider_asset_id.' });
    }

    const adapter = await this.getAdapterForAsset(mediaAssetId);
    if (!adapter) throw new HostingProviderError('UNSUPPORTED', { message: 'No hosting adapter found.' });

    try {
      const result = await adapter.renameAsset(asset.provider_asset_id, newName);

      // Update the Mavero media_asset with the new provider-provided metadata.
      await this.client.from('media_assets').update({
        filename: result.filename ?? asset.filename,
        title: result.title ?? newName,
        provider_status: result.providerStatus,
        last_synced_at: new Date().toISOString(),
      }).eq('id', mediaAssetId);

      await this.uploadService.recordOperation({
        action: 'rename',
        status: 'success',
        media_item_id: asset.media_item_id,
        media_asset_id: mediaAssetId,
        provider_source_id: asset.provider_source_id ?? undefined,
        admin_user_id: adminUserId,
        details: { old_name: asset.filename, new_name: newName },
      });

      return { ok: true, action: 'rename', mediaAssetId, providerAssetId: asset.provider_asset_id };
    } catch (error) {
      const err = error instanceof HostingProviderError ? error : new HostingProviderError('UNKNOWN', { cause: error });
      await this.uploadService.recordOperation({
        action: 'rename',
        status: 'failed',
        media_item_id: asset.media_item_id,
        media_asset_id: mediaAssetId,
        provider_source_id: asset.provider_source_id ?? undefined,
        admin_user_id: adminUserId,
        error_code: err.code,
        error_message: err.message,
      });
      return { ok: false, action: 'rename', mediaAssetId, providerAssetId: asset.provider_asset_id, error: { code: err.code, message: err.message } };
    }
  }

  /**
   * Moves a provider-side asset to a different folder. Does NOT change
   * the canonical Mavero folder hierarchy — only the provider folder mapping.
   */
  async moveAsset(mediaAssetId: string, targetFolderId: string | null, adminUserId?: string): Promise<ManagementResult> {
    const asset = await this.getMediaAsset(mediaAssetId);
    if (!asset.provider_asset_id) {
      throw new HostingProviderError('VALIDATION', { message: 'Media asset has no provider_asset_id.' });
    }

    const adapter = await this.getAdapterForAsset(mediaAssetId);
    if (!adapter) throw new HostingProviderError('UNSUPPORTED', { message: 'No hosting adapter found.' });

    const caps = adapter.getCapabilities();
    if (!caps.folderManagement) {
      throw new HostingProviderError('UNSUPPORTED', { message: 'This provider does not support folder management.' });
    }

    try {
      const result = await adapter.moveAsset(asset.provider_asset_id, targetFolderId);

      await this.client.from('media_assets').update({
        provider_status: result.providerStatus,
        last_synced_at: new Date().toISOString(),
      }).eq('id', mediaAssetId);

      await this.uploadService.recordOperation({
        action: 'move',
        status: 'success',
        media_item_id: asset.media_item_id,
        media_asset_id: mediaAssetId,
        provider_source_id: asset.provider_source_id ?? undefined,
        admin_user_id: adminUserId,
        details: { target_folder_id: targetFolderId },
      });

      return { ok: true, action: 'move', mediaAssetId, providerAssetId: asset.provider_asset_id };
    } catch (error) {
      const err = error instanceof HostingProviderError ? error : new HostingProviderError('UNKNOWN', { cause: error });
      await this.uploadService.recordOperation({
        action: 'move',
        status: 'failed',
        media_item_id: asset.media_item_id,
        media_asset_id: mediaAssetId,
        provider_source_id: asset.provider_source_id ?? undefined,
        admin_user_id: adminUserId,
        error_code: err.code,
        error_message: err.message,
      });
      return { ok: false, action: 'move', mediaAssetId, providerAssetId: asset.provider_asset_id, error: { code: err.code, message: err.message } };
    }
  }

  /**
   * Detaches a provider asset from its canonical Mavero media_item.
   * Does NOT delete the provider-side file — the asset remains at the
   * provider. The media_asset's mavero_status is set to 'missing' so
   * the resolver no longer returns it. media_item_id, provider_source_id,
   * provider_asset_id, and playback_url are all PRESERVED so the asset
   * can be reactivated later via reactivateAsset() or linkAsset().
   */
  async detachAsset(mediaAssetId: string, adminUserId?: string): Promise<ManagementResult> {
    const asset = await this.getMediaAsset(mediaAssetId);

    try {
      await this.client.from('media_assets').update({
        mavero_status: 'missing',
        last_synced_at: new Date().toISOString(),
      }).eq('id', mediaAssetId);

      await this.uploadService.recordOperation({
        action: 'detach',
        status: 'success',
        media_item_id: asset.media_item_id,
        media_asset_id: mediaAssetId,
        provider_source_id: asset.provider_source_id ?? undefined,
        admin_user_id: adminUserId,
        details: { provider_asset_id: asset.provider_asset_id },
      });

      return { ok: true, action: 'detach', mediaAssetId, providerAssetId: asset.provider_asset_id };
    } catch (error) {
      const err = error instanceof HostingProviderError ? error : new HostingProviderError('UNKNOWN', { cause: error });
      await this.uploadService.recordOperation({
        action: 'detach',
        status: 'failed',
        media_item_id: asset.media_item_id,
        media_asset_id: mediaAssetId,
        provider_source_id: asset.provider_source_id ?? undefined,
        admin_user_id: adminUserId,
        error_code: err.code,
        error_message: err.message,
      });
      return { ok: false, action: 'detach', mediaAssetId, providerAssetId: asset.provider_asset_id, error: { code: err.code, message: err.message } };
    }
  }

  /**
   * Deletes a provider-side asset through the adapter and marks the
   * Mavero media_asset as deleted. If the provider-side delete fails,
   * the Mavero asset is NOT marked as deleted — it retains enough state
   * for retry/reconciliation.
   */
  async deleteAsset(mediaAssetId: string, adminUserId?: string): Promise<ManagementResult> {
    const asset = await this.getMediaAsset(mediaAssetId);
    if (!asset.provider_asset_id) {
      throw new HostingProviderError('VALIDATION', { message: 'Media asset has no provider_asset_id.' });
    }

    const adapter = await this.getAdapterForAsset(mediaAssetId);
    if (!adapter) throw new HostingProviderError('UNSUPPORTED', { message: 'No hosting adapter found.' });

    try {
      // Delete at the provider first.
      await adapter.deleteAsset(asset.provider_asset_id);

      // Only update Mavero state after provider confirms deletion.
      await this.client.from('media_assets').update({
        status: 'deleted',
        mavero_status: 'missing',
        last_synced_at: new Date().toISOString(),
      }).eq('id', mediaAssetId);

      await this.uploadService.recordOperation({
        action: 'provider_delete',
        status: 'success',
        media_item_id: asset.media_item_id,
        media_asset_id: mediaAssetId,
        provider_source_id: asset.provider_source_id ?? undefined,
        admin_user_id: adminUserId,
        details: { provider_asset_id: asset.provider_asset_id },
      });

      return { ok: true, action: 'provider_delete', mediaAssetId, providerAssetId: asset.provider_asset_id };
    } catch (error) {
      const err = error instanceof HostingProviderError ? error : new HostingProviderError('UNKNOWN', { cause: error });
      // Provider delete failed — do NOT mark the Mavero asset as deleted.
      await this.uploadService.recordOperation({
        action: 'provider_delete',
        status: 'failed',
        media_item_id: asset.media_item_id,
        media_asset_id: mediaAssetId,
        provider_source_id: asset.provider_source_id ?? undefined,
        admin_user_id: adminUserId,
        error_code: err.code,
        error_message: err.message,
      });
      return { ok: false, action: 'provider_delete', mediaAssetId, providerAssetId: asset.provider_asset_id, error: { code: err.code, message: err.message } };
    }
  }

  // --- Helpers ---

  /**
   * Links an existing provider-side file to a Mavero media_item.
   *
   * This is the admin action for connecting a Vidara/Abyss file that was
   * uploaded outside of Mavero (e.g. via the Vidara dashboard) to a
   * canonical media_item. The admin explicitly selects which media_item
   * to link to which provider file — there is NO auto-matching.
   *
   * Flow:
   *   1. Verify the media_item exists.
   *   2. Verify the (provider_source_id, provider_asset_id) is not already linked.
   *   3. Fetch current provider metadata via adapter.getAsset().
   *   4. INSERT a new media_assets row.
   *   5. Record the operation.
   *   6. Resolve any open demand requests for this media_item.
   */
  async linkAsset(
    mediaItemId: string,
    providerSourceId: string,
    providerAssetId: string,
    adminUserId?: string,
  ): Promise<ManagementResult> {
    // 1. Verify the media_item exists.
    const { data: mediaItem, error: itemError } = await this.client
      .from('media_items')
      .select('id, canonical_key')
      .eq('id', mediaItemId)
      .maybeSingle();
    if (itemError || !mediaItem) {
      throw new HostingProviderError('NOT_FOUND', { message: 'Media item not found.' });
    }

    // 2. Check if already linked — if an existing row has mavero_status='missing'
    // (detached), reactivate it instead of creating a duplicate. This is the
    // recovery path for the detach → relink lifecycle.
    const { data: existing } = await this.client
      .from('media_assets')
      .select('id, mavero_status, media_item_id')
      .eq('provider_source_id', providerSourceId)
      .eq('provider_asset_id', providerAssetId)
      .maybeSingle();
    if (existing) {
      const existingRow = existing as { id: string; mavero_status: string; media_item_id: string };
      if (existingRow.mavero_status === 'missing' && existingRow.media_item_id === mediaItemId) {
        // Reactivate the detached asset — UPDATE instead of INSERT.
        return await this.reactivateAsset(existingRow.id, adminUserId);
      }
      throw new HostingProviderError('VALIDATION', { message: 'This provider file is already linked to a different media asset. Detach it first.' });
    }

    // 3. Resolve the adapter for this provider source via the CANONICAL
    // resolver. Phase C audit fix: replaces inline two-query lookup.
    let adapter: ReturnType<typeof getHostingAdapter>;
    try {
      const resolution = await resolveAdapterForSource(this.client, providerSourceId);
      adapter = resolution.adapter;
    } catch (err) {
      if (err instanceof ProviderResolutionError) {
        // Distinguish NOT_FOUND (source/provider doesn't exist) from
        // UNSUPPORTED (adapter_id has no registered adapter).
        if (err.code === 'ADAPTER_NOT_REGISTERED') {
          throw new HostingProviderError('UNSUPPORTED', { message: err.message });
        }
        throw new HostingProviderError('NOT_FOUND', { message: err.message });
      }
      throw err;
    }

    try {
      // 4. Fetch current provider metadata.
      const assetInfo = await adapter.getAsset(providerAssetId);

      // 5. INSERT the new media_assets row.
      //
      // FINDING-001 fix (mirrored): inspect the FULL Supabase insert
      // response. Previously the `error` field was destructured away
      // — a UNIQUE violation on (provider_source_id, provider_asset_id)
      // or any other DB failure was silently swallowed, `assetRow` was
      // null, `assetId` became the empty string, and the operation was
      // recorded as "success" with a bogus media_asset_id. Now the real
      // DB error is surfaced as a HostingProviderError so the admin UI
      // can display it.
      const maveroStatus = assetInfo.status === 'ready' ? 'available' : 'processing';
      const { data: assetRow, error: insertError } = await this.client
        .from('media_assets')
        .insert({
          media_item_id: mediaItemId,
          provider_source_id: providerSourceId,
          provider_asset_id: providerAssetId,
          provider_video_id: assetInfo.providerVideoId,
          playback_url: assetInfo.playbackUrl,
          filename: assetInfo.filename,
          title: assetInfo.title,
          status: assetInfo.status,
          provider_status: assetInfo.providerStatus,
          mavero_status: maveroStatus,
          source_quality: assetInfo.sourceQuality,
          available_qualities: assetInfo.availableQualities ?? [],
          audio_languages: assetInfo.audioLanguages ?? [],
          has_subtitles: assetInfo.hasSubtitles ?? false,
          size_bytes: assetInfo.sizeBytes,
          duration_seconds: assetInfo.durationSeconds,
          provider_metadata: JSON.parse(JSON.stringify(assetInfo.raw)),
          last_synced_at: new Date().toISOString(),
        })
        .select('id')
        .single();

      if (insertError || !assetRow) {
        const pgMessage = insertError?.message ?? 'No row was returned by the insert.';
        const pgCode = insertError?.code ?? 'NO_DATA';
        let code: 'DUPLICATE_PROVIDER_ASSET' | 'FK_VIOLATION' | 'CHECK_VIOLATION' | 'ASSET_INSERT_FAILED' = 'ASSET_INSERT_FAILED';
        if (pgCode === '23505') code = 'DUPLICATE_PROVIDER_ASSET';
        else if (pgCode === '23503') code = 'FK_VIOLATION';
        else if (pgCode === '23514') code = 'CHECK_VIOLATION';
        throw new HostingProviderError(code, {
          message: `Failed to link media asset (${pgCode}): ${pgMessage}`,
          cause: insertError ?? undefined,
        });
      }

      const assetId = (assetRow as { id: string }).id;

      // 6. Record the operation.
      await this.uploadService.recordOperation({
        action: 'link',
        status: 'success',
        media_item_id: mediaItemId,
        media_asset_id: assetId,
        provider_source_id: providerSourceId,
        admin_user_id: adminUserId,
        details: { provider_asset_id: providerAssetId, playback_url: assetInfo.playbackUrl },
      });

      // 7. Resolve any open demand requests for this media_item.
      try {
        const { DemandService } = await import('../demand/service');
        const demandService = new DemandService(this.client);
        await demandService.resolveDemand((mediaItem as { canonical_key: string }).canonical_key);
      } catch {
        // Best-effort — demand resolution must not break the link operation.
      }

      return { ok: true, action: 'link', mediaAssetId: assetId, providerAssetId };
    } catch (error) {
      const err = error instanceof HostingProviderError ? error : new HostingProviderError('UNKNOWN', { cause: error });
      await this.uploadService.recordOperation({
        action: 'link',
        status: 'failed',
        media_item_id: mediaItemId,
        provider_source_id: providerSourceId,
        admin_user_id: adminUserId,
        error_code: err.code,
        error_message: err.message,
      });
      return { ok: false, action: 'link', mediaAssetId: '', providerAssetId, error: { code: err.code, message: err.message } };
    }
  }

  /**
   * Reactivates a previously detached provider asset.
   *
   * This is the recovery path for the detach → reattach lifecycle.
   * Sets mavero_status back to 'available' (if status='ready') or
   * 'processing' (otherwise), restoring playback.
   *
   * Does NOT delete or modify any provider-side state.
   * Does NOT create a new media_assets row — updates the existing one.
   */
  async reactivateAsset(mediaAssetId: string, adminUserId?: string): Promise<ManagementResult> {
    const asset = await this.getMediaAsset(mediaAssetId);

    try {
      // Set mavero_status based on current status.
      // If the asset was 'ready' before detach, make it 'available' again.
      // Otherwise keep it as 'processing' for the resolver to handle.
      const newMaveroStatus = asset.status === 'ready' || asset.status === 'processing' ? 'available' : 'processing';

      await this.client.from('media_assets').update({
        mavero_status: newMaveroStatus,
        last_synced_at: new Date().toISOString(),
      }).eq('id', mediaAssetId);

      await this.uploadService.recordOperation({
        action: 'reactivate',
        status: 'success',
        media_item_id: asset.media_item_id,
        media_asset_id: mediaAssetId,
        provider_source_id: asset.provider_source_id ?? undefined,
        admin_user_id: adminUserId,
        details: { previous_mavero_status: 'missing', new_mavero_status: newMaveroStatus },
      });

      // Resolve any open demand requests for this media item.
      try {
        const { data: item } = await this.client
          .from('media_items')
          .select('canonical_key')
          .eq('id', asset.media_item_id)
          .maybeSingle();
        const canonicalKey = (item as { canonical_key?: string } | null)?.canonical_key;
        if (canonicalKey) {
          const { DemandService } = await import('../demand/service');
          const demandService = new DemandService(this.client);
          await demandService.resolveDemand(canonicalKey);
        }
      } catch {
        // Best-effort — demand resolution must not break reactivation.
      }

      return { ok: true, action: 'reactivate', mediaAssetId, providerAssetId: asset.provider_asset_id };
    } catch (error) {
      const err = error instanceof HostingProviderError ? error : new HostingProviderError('UNKNOWN', { cause: error });
      await this.uploadService.recordOperation({
        action: 'reactivate',
        status: 'failed',
        media_item_id: asset.media_item_id,
        media_asset_id: mediaAssetId,
        provider_source_id: asset.provider_source_id ?? undefined,
        admin_user_id: adminUserId,
        error_code: err.code,
        error_message: err.message,
      });
      return { ok: false, action: 'reactivate', mediaAssetId, providerAssetId: asset.provider_asset_id, error: { code: err.code, message: err.message } };
    }
  }

  /**
   * Lists all provider-side files for a given adapter that are NOT
   * currently linked to any Mavero media_asset.
   *
   * Used by the "Link existing file" UI to show the admin which
   * Vidara/Abyss files are available for linking.
   */
  async listUnlinkedProviderFiles(adapterId: string): Promise<{
    providerAssetId: string;
    title: string | null;
    filename: string | null;
    sizeBytes: number | null;
    durationSeconds: number | null;
    status: string;
    playbackUrl: string | null;
  }[]> {
    const adapter = getHostingAdapter(adapterId);
    if (!adapter) return [];

    // List all provider files.
    const allFiles = await adapter.listAssets(null);

    // Find which provider_asset_ids are already linked.
    const { data: sourceRow } = await this.client
      .from('streaming_sources')
      .select('id')
      .eq('provider_id', (await this.client
        .from('streaming_providers')
        .select('id')
        .eq('adapter_id', adapterId)
        .maybeSingle()
      ).data?.id ?? '')
      .maybeSingle();

    const providerSourceId = sourceRow?.id;
    if (!providerSourceId) return [];

    const { data: linkedAssets } = await this.client
      .from('media_assets')
      .select('provider_asset_id')
      .eq('provider_source_id', providerSourceId)
      .not('provider_asset_id', 'is', null);

    const linkedIds = new Set((linkedAssets ?? []).map((a: any) => a.provider_asset_id as string));

    // Return only unlinked files.
    return allFiles
      .filter(f => f.providerAssetId && !linkedIds.has(f.providerAssetId))
      .map(f => ({
        providerAssetId: f.providerAssetId,
        title: f.title,
        filename: f.filename,
        sizeBytes: f.sizeBytes,
        durationSeconds: f.durationSeconds,
        status: f.status,
        playbackUrl: f.playbackUrl,
      }));
  }

  private async getMediaAsset(mediaAssetId: string): Promise<{
    id: string;
    media_item_id: string;
    provider_source_id: string | null;
    provider_asset_id: string | null;
    filename: string | null;
    status: string;
  }> {
    const { data, error } = await this.client
      .from('media_assets')
      .select('id, media_item_id, provider_source_id, provider_asset_id, filename, status')
      .eq('id', mediaAssetId)
      .maybeSingle();

    if (error || !data) throw new HostingProviderError('NOT_FOUND', { message: 'Media asset not found.' });
    return data as { id: string; media_item_id: string; provider_source_id: string | null; provider_asset_id: string | null; filename: string | null; status: string };
  }

  private async getAdapterForAsset(mediaAssetId: string): Promise<ReturnType<typeof getHostingAdapter>> {
    const asset = await this.getMediaAsset(mediaAssetId);
    if (!asset.provider_source_id) return null;
    try {
      const resolution = await resolveAdapterForSource(this.client, asset.provider_source_id);
      return resolution.adapter;
    } catch (err) {
      if (err instanceof ProviderResolutionError) {
        throw new HostingProviderError('NOT_FOUND', { message: err.message });
      }
      throw err;
    }
  }
}
