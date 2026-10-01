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
    // TERMINAL-STATE GUARD: no remote-file mutations on deleted assets.
    if (asset.status === 'deleted') {
      throw new HostingProviderError('ASSET_DELETED', { message: 'Deleted provider assets cannot be renamed. The remote file has been permanently deleted.' });
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
    // TERMINAL-STATE GUARD: no remote-file mutations on deleted assets.
    if (asset.status === 'deleted') {
      throw new HostingProviderError('ASSET_DELETED', { message: 'Deleted provider assets cannot be moved. The remote file has been permanently deleted.' });
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

    // TERMINAL-STATE GUARD: deleted assets are already terminal — detach is
    // meaningless (mavero_status is already 'missing') and must be rejected
    // so the state machine stays explicit.
    if (asset.status === 'deleted') {
      throw new HostingProviderError('ASSET_DELETED', { message: 'Deleted provider assets cannot be detached. The asset is already terminal.' });
    }

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

      // DEMAND LIFECYCLE FIX: reopen the demand if no other available
      // asset exists for this media item. Detach removes the asset from
      // playback availability — if it was the last available one, the
      // content is effectively missing again and demand should reflect
      // that. 'ignored' demands are NOT reopened.
      await this.reopenDemandForMediaItem(asset.media_item_id);

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

    // IDEMPOTENCY: if the asset is already deleted, return success without
    // calling the provider again. This prevents repeated 404 errors when
    // an admin clicks Delete on an already-deleted asset.
    if (asset.status === 'deleted') {
      return { ok: true, action: 'provider_delete', mediaAssetId, providerAssetId: asset.provider_asset_id };
    }

    const adapter = await this.getAdapterForAsset(mediaAssetId);
    if (!adapter) throw new HostingProviderError('UNSUPPORTED', { message: 'No hosting adapter found.' });

    try {
      // Delete at the provider first.
      try {
        await adapter.deleteAsset(asset.provider_asset_id);
      } catch (providerError) {
        // If the provider returns 404 (NOT_FOUND), the file is already gone.
        // Treat this as a successful delete — the end state (file absent at
        // provider) is achieved. This prevents misleading failed operations
        // when the file was deleted out-of-band or by a previous delete call.
        const err = providerError instanceof HostingProviderError ? providerError : new HostingProviderError('UNKNOWN', { cause: providerError });
        if (err.code !== 'NOT_FOUND') {
          throw providerError; // Re-throw non-404 errors.
        }
        // File already gone at provider — proceed to mark as deleted.
      }

      // Only update Mavero state after provider confirms deletion (or file
      // was already absent).
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

      // DEMAND LIFECYCLE FIX: reopen the demand for this media item so
      // Missing Media shows it again. The asset was deleted — users who
      // try to play this content should be able to surface it as missing.
      // This transitions media_availability_requests.status from 'ready'
      // to 'open' (preserving request_count). 'ignored' demands are NOT
      // reopened (admin explicitly dismissed them).
      await this.reopenDemandForMediaItem(asset.media_item_id);

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

    // 2. Check if a media_assets row already exists for this
    // (provider_source_id, provider_asset_id). ARCHITECTURE NOTE (final
    // remediation): media_assets.media_item_id is NOT NULL in the live
    // schema — a NULL-media_item row is an IMPOSSIBLE state (provider sync
    // never creates media_assets rows; only upload + this method INSERT
    // them, always with a media_item_id). The old NULL-row UPDATE path
    // ("Link Existing" for media_item_id IS NULL) was dead code and has
    // been removed. Sub-cases:
    //
    //   a) EXISTING + mavero_status='missing' + media_item_id === mediaItemId
    //      (detached, re-linking to the same media item):
    //      → Reactivate the existing asset (UPDATE mavero_status back
    //        to available/processing). This is the detach → reactivate
    //        recovery path.
    //
    //   b) EXISTING + linked to a DIFFERENT media_item_id:
    //      → REJECT with VALIDATION error. The admin must detach it
    //        first.
    //
    //   c) EXISTING + linked to the SAME media_item_id + already available:
    //      → Idempotent — return success without modifying the DB.
    //        Do NOT create a duplicate.
    //
    //   d) EXISTING + status='deleted' (terminal):
    //      → REJECT with ASSET_DELETED. The provider file is permanently
    //        gone — linking it would create a phantom asset.
    //
    //   e) EXISTING + media_item_id IS NULL (schema drift — impossible under
    //      the NOT NULL constraint):
    //      → REJECT with a deterministic ASSET_STATE error. Never silently
    //        UPDATE a state the architecture declares impossible.
    const { data: existing } = await this.client
      .from('media_assets')
      .select('id, mavero_status, media_item_id, status')
      .eq('provider_source_id', providerSourceId)
      .eq('provider_asset_id', providerAssetId)
      .maybeSingle();
    if (existing) {
      const existingRow = existing as { id: string; mavero_status: string; media_item_id: string | null; status: string };

      // Case (e): impossible NULL-media_item state (schema drift guard).
      // The dead "update the NULL row" path was removed — see the
      // architecture note above.
      if (existingRow.media_item_id === null) {
        throw new HostingProviderError('ASSET_STATE', { message: 'Provider file row exists without a media link — impossible under the NOT NULL media_item_id constraint. Investigate schema drift before linking.' });
      }

      // Case (d): terminal deleted row — never relinkable.
      if (existingRow.status === 'deleted') {
        throw new HostingProviderError('ASSET_DELETED', { message: 'This provider file was permanently deleted. Link it again only after re-uploading the file to the provider.' });
      }

      // Case (a): detached + same media_item → reactivate.
      if (existingRow.mavero_status === 'missing' && existingRow.media_item_id === mediaItemId) {
        return await this.reactivateAsset(existingRow.id, adminUserId);
      }

      // Case (c): already linked to the same media_item + available → idempotent.
      if (existingRow.media_item_id === mediaItemId && existingRow.mavero_status !== 'missing') {
        await this.uploadService.recordOperation({
          action: 'link',
          status: 'success',
          media_item_id: mediaItemId,
          media_asset_id: existingRow.id,
          provider_source_id: providerSourceId,
          admin_user_id: adminUserId,
          details: { provider_asset_id: providerAssetId, idempotent: true },
        });
        return { ok: true, action: 'link', mediaAssetId: existingRow.id, providerAssetId };
      }

      // Case (b): linked to a different media_item → reject.
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

    // BUG 2 fix: a deleted provider asset (status='deleted') must NOT
    // be reactivated. The remote file no longer exists — reactivating
    // would create a phantom Mavero asset that the resolver would try
    // to serve but the provider would reject (file not found).
    //
    // Only DETACHED assets (status != 'deleted' AND mavero_status='missing')
    // are eligible for reactivation. The UI gates on this too, but the
    // backend MUST enforce it independently — never rely only on UI gating.
    if (asset.status === 'deleted') {
      const error = { code: 'ASSET_DELETED', message: 'Deleted provider assets cannot be reactivated. The remote file has been permanently deleted.' };
      await this.uploadService.recordOperation({
        action: 'reactivate',
        status: 'failed',
        media_item_id: asset.media_item_id,
        media_asset_id: mediaAssetId,
        provider_source_id: asset.provider_source_id ?? undefined,
        admin_user_id: adminUserId,
        error_code: error.code,
        error_message: error.message,
      });
      return { ok: false, action: 'reactivate', mediaAssetId, providerAssetId: asset.provider_asset_id, error };
    }

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

  /**
   * REMOVED (final remediation): linkExistingAssetRow() — the "Link
   * Existing" path that UPDATED a media_assets row with media_item_id IS
   * NULL. The live schema declares media_item_id NOT NULL and provider
   * sync never creates media_assets rows (only UploadService.createMediaAsset
   * and linkAsset INSERT rows, always with a media_item_id), so the
   * NULL-media_item state is architecturally impossible and the path was
   * dead code. linkAsset() now REJECTS such a row with a deterministic
   * ASSET_STATE error (schema-drift guard) instead of silently updating it.
   *
   * The LEGITIMATE "Link Existing File" flow (a provider-side file that
   * has NO media_assets row — uploaded out-of-band and discovered by
   * provider sync) is handled by the linkAsset INSERT path below, driven
   * by the Media Library header action.
   */

  /**
   * Reopens the demand for a media item if no ready+available asset
   * exists. Called after delete/detach to transition demand from 'ready'
   * to 'open' so Missing Media surfaces the content again.
   *
   * Only reopens if NO other asset for this media_item is still
   * ready+available. If another provider's asset is still available,
   * the content is still playable and demand stays 'ready'.
   *
   * 'ignored' demands are NOT reopened (admin explicitly dismissed them).
   */
  private async reopenDemandForMediaItem(mediaItemId: string): Promise<void> {
    try {
      // Check if any other asset for this media item is still available.
      const { count } = await this.client
        .from('media_assets')
        .select('id', { count: 'exact', head: true })
        .eq('media_item_id', mediaItemId)
        .eq('status', 'ready')
        .eq('mavero_status', 'available');
      if ((count ?? 0) > 0) {
        // Another asset is still available — don't reopen demand.
        return;
      }
      // No available asset — reopen the demand.
      const { data: item } = await this.client
        .from('media_items')
        .select('canonical_key')
        .eq('id', mediaItemId)
        .maybeSingle();
      const canonicalKey = (item as { canonical_key?: string } | null)?.canonical_key;
      if (canonicalKey) {
        const { DemandService } = await import('../demand/service');
        const demandService = new DemandService(this.client);
        await demandService.reopenDemand(canonicalKey);
      }
    } catch {
      // Best-effort — demand tracking must NOT break delete/detach.
    }
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
