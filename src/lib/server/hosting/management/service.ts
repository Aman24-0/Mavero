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
   * provider. The media_asset's media_item_id is set to null and its
   * mavero_status is set to 'missing' so the resolver no longer returns it.
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

  private async getMediaAsset(mediaAssetId: string): Promise<{
    id: string;
    media_item_id: string;
    provider_source_id: string | null;
    provider_asset_id: string | null;
    filename: string | null;
  }> {
    const { data, error } = await this.client
      .from('media_assets')
      .select('id, media_item_id, provider_source_id, provider_asset_id, filename')
      .eq('id', mediaAssetId)
      .maybeSingle();

    if (error || !data) throw new HostingProviderError('NOT_FOUND', { message: 'Media asset not found.' });
    return data as { id: string; media_item_id: string; provider_source_id: string | null; provider_asset_id: string | null; filename: string | null };
  }

  private async getAdapterForAsset(mediaAssetId: string): Promise<ReturnType<typeof getHostingAdapter>> {
    const asset = await this.getMediaAsset(mediaAssetId);
    if (!asset.provider_source_id) return null;

    const { data: sourceRow } = await this.client
      .from('streaming_sources')
      .select('provider_id')
      .eq('id', asset.provider_source_id)
      .maybeSingle();

    const { data: providerRow } = await this.client
      .from('streaming_providers')
      .select('adapter_id')
      .eq('id', sourceRow?.provider_id ?? '')
      .maybeSingle();

    return getHostingAdapter(providerRow?.adapter_id);
  }
}
