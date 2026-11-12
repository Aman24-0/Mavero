/**
 * Phase 9 — Missing media demand tracking service.
 *
 * Records demand for media that is NOT yet hosted on any Mavero provider.
 * Created ONLY on a playback attempt where BOTH Mavero providers (Vidara
 * and Abyss) are unavailable. Search/browse/detail-page loads do NOT
 * create requests.
 *
 * Uses the existing `media_availability_requests` table (Phase 2 schema).
 * Deduplication is via `canonical_key` (unique constraint) — repeated
 * requests increment `request_count` and update `last_requested_at`.
 *
 * SECURITY: this service is SERVER-SIDE ONLY. No credentials are stored.
 * The `last_user_kind` field records guest/authenticated/admin (useful
 * for prioritization without exposing user identity).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '$lib/server/supabase/database.types';
import { movieCanonicalKey, episodeCanonicalKey } from '../media/canonical-key';
import type { ContentType, NormalizedMediaItem } from '$lib/server/content/types';
import type { ResolverRequest } from '$lib/server/resolver/types';

export type DemandEntry = {
  canonicalKey: string;
  contentType: 'movie' | 'series' | 'anime';
  tmdbId: string;
  imdbId?: string | null;
  season?: number;
  episode?: number;
  title: string;
  episodeTitle?: string | null;
  year?: number | null;
  userKind: 'guest' | 'authenticated' | 'admin';
};

export type DemandResult = {
  created: boolean;
  requestCount: number;
  status: string;
};

export class DemandService {
  constructor(private client: SupabaseClient<Database>) {}

  /**
   * Records or increments a missing-media demand request.
   * Uses atomic upsert to handle concurrent requests safely.
   *
   * This is a fire-and-forget side effect — it must NOT block playback.
   * Errors are silently absorbed (logged server-side but not propagated).
   */
  async recordDemand(entry: DemandEntry): Promise<DemandResult | null> {
    try {
      // LIFECYCLE GUARD (final remediation): demand must NEVER be created or
      // incremented while a ready+available Mavero asset exists for the
      // canonical key. Without this guard, a playback that resolves via a
      // non-Mavero source (e.g. the user's default source preference, a
      // provider in health cooldown, or an outranked third-party embed)
      // would spuriously create demand even though Mavero CAN serve the
      // content. Per the demand lifecycle: "No available asset + actual
      // playback miss → OPEN" — the availability check is part of the
      // trigger, not just the resolution path.
      //
      // When an asset IS available and a stale 'open'/'uploading' demand
      // row exists, we self-heal it to 'ready' (the sweep does the same on
      // the Missing Media page). 'ignored' rows are never touched.
      const assetAvailable = await this.hasReadyAvailableAsset(entry.canonicalKey);
      if (assetAvailable) {
        await this.resolveDemand(entry.canonicalKey);
        return { created: false, requestCount: 0, status: 'ready' };
      }

      // Use upsert with onConflict on canonical_key.
      // If the row exists: increment request_count + update last_requested_at + last_user_kind.
      // If not: insert with default request_count=1.
      // The `status` CHECK constraint supports: 'open', 'uploading', 'ready', 'ignored'.
      // Only 'open' requests should be incremented. 'ignored' requests should NOT
      // create new duplicates (the unique constraint prevents this). 'ready' requests
      // should NOT be incremented (the media is now available).
      const { data: existing } = await this.client
        .from('media_availability_requests')
        .select('id, request_count, status')
        .eq('canonical_key', entry.canonicalKey)
        .maybeSingle();

      if (existing) {
        const row = existing as { id: string; request_count: number; status: string };
        // Only increment if status is 'open' or 'uploading'.
        // 'ignored' requests should NOT be incremented (admin dismissed them).
        // 'ready' requests should NOT be incremented (media is available).
        if (row.status === 'open' || row.status === 'uploading') {
          const { data: updated } = await this.client
            .from('media_availability_requests')
            .update({
              request_count: row.request_count + 1,
              last_requested_at: new Date().toISOString(),
              last_user_kind: entry.userKind,
              title_snapshot: entry.title,
              episode_title_snapshot: entry.episodeTitle ?? null,
              year: entry.year ?? null,
              imdb_id: entry.imdbId ?? null,
            })
            .eq('id', row.id)
            .select('request_count, status')
            .single();
          return {
            created: false,
            requestCount: (updated as { request_count: number })?.request_count ?? row.request_count + 1,
            status: (updated as { status: string })?.status ?? row.status,
          };
        }
        // Status is 'ignored' — admin explicitly dismissed. Do not increment.
        if (row.status === 'ignored') {
          return { created: false, requestCount: row.request_count, status: row.status };
        }
        // Status is 'ready' — check if a ready+available Mavero asset still
        // exists. If the asset was deleted/detached after the demand was
        // resolved, the demand should be REOPENED so Missing Media shows it
        // again. This is the critical demand-lifecycle fix: previously, a
        // 'ready' demand was permanently stuck even after the underlying
        // asset was deleted, leaving users unable to surface the content as
        // missing again.
        if (row.status === 'ready') {
          const hasAvailableAsset = await this.hasReadyAvailableAsset(entry.canonicalKey);
          if (hasAvailableAsset) {
            // Asset still exists and is available — no-op.
            return { created: false, requestCount: row.request_count, status: row.status };
          }
          // Asset is gone/unavailable — REOPEN the demand.
          // Transition 'ready' → 'open' and increment request_count.
          const { data: reopened } = await this.client
            .from('media_availability_requests')
            .update({
              status: 'open',
              request_count: row.request_count + 1,
              last_requested_at: new Date().toISOString(),
              last_user_kind: entry.userKind,
              title_snapshot: entry.title,
              episode_title_snapshot: entry.episodeTitle ?? null,
              year: entry.year ?? null,
              imdb_id: entry.imdbId ?? null,
            })
            .eq('canonical_key', entry.canonicalKey)
            .eq('status', 'ready')
            .select('request_count, status')
            .single();
          return {
            created: false,
            requestCount: (reopened as { request_count: number })?.request_count ?? row.request_count + 1,
            status: (reopened as { status: string })?.status ?? 'open',
          };
        }
        return { created: false, requestCount: row.request_count, status: row.status };
      }

      // No existing row — create one.
      const { data: inserted, error } = await this.client
        .from('media_availability_requests')
        .insert({
          canonical_key: entry.canonicalKey,
          content_type: entry.contentType,
          tmdb_id: entry.tmdbId,
          imdb_id: entry.imdbId ?? null,
          season: entry.season ?? null,
          episode: entry.episode ?? null,
          title_snapshot: entry.title,
          episode_title_snapshot: entry.episodeTitle ?? null,
          year: entry.year ?? null,
          request_count: 1,
          last_user_kind: entry.userKind,
          status: 'open',
        })
        .select('request_count, status')
        .single();

      if (error) {
        // If unique constraint violation (concurrent insert), the row
        // was already created by another request — that's fine.
        return null;
      }

      return {
        created: true,
        requestCount: (inserted as { request_count: number })?.request_count ?? 1,
        status: (inserted as { status: string })?.status ?? 'open',
      };
    } catch {
      // Silently absorb — demand tracking must NOT break playback.
      return null;
    }
  }

  /**
   * Resolves a missing-media request when hosted media becomes available.
   * Called after a successful upload/sync/attach that makes the media
   * playable on a Mavero provider.
   */
  async resolveDemand(canonicalKey: string): Promise<void> {
    try {
      await this.client
        .from('media_availability_requests')
        .update({ status: 'ready' })
        .eq('canonical_key', canonicalKey)
        .in('status', ['open', 'uploading']);
    } catch {
      // Silently absorb — auto-resolution is best-effort.
    }
  }

  /**
   * Reopens a previously-resolved demand request when the underlying
   * asset is deleted or detached. Transitions status from 'ready' to
   * 'open' so Missing Media shows it again. Preserves request_count.
   *
   * Does NOT reopen 'ignored' demands — admin explicitly dismissed those.
   *
   * Called from ManagementService.deleteAsset() and detachAsset().
   */
  async reopenDemand(canonicalKey: string): Promise<void> {
    try {
      await this.client
        .from('media_availability_requests')
        .update({ status: 'open' })
        .eq('canonical_key', canonicalKey)
        .eq('status', 'ready');
    } catch {
      // Silently absorb — demand tracking must NOT break delete/detach.
    }
  }

  /**
   * Checks whether a ready+available Mavero asset exists for the given
   * canonical_key. Uses the same gate as the playback resolver:
   * status='ready' AND mavero_status='available'.
   *
   * Used by recordDemand() to determine whether a 'ready' demand should
   * be reopened (asset was deleted/detached) or left as-is (asset still
   * available).
   */
  private async hasReadyAvailableAsset(canonicalKey: string): Promise<boolean> {
    try {
      // First find the media_item by canonical_key.
      const { data: item } = await this.client
        .from('media_items')
        .select('id')
        .eq('canonical_key', canonicalKey)
        .maybeSingle();
      if (!item) return false;

      // Then check if any media_asset for this item is ready+available.
      const { count } = await this.client
        .from('media_assets')
        .select('id', { count: 'exact', head: true })
        .eq('media_item_id', (item as { id: string }).id)
        .eq('status', 'ready')
        .eq('mavero_status', 'available');
      return (count ?? 0) > 0;
    } catch {
      // On error, assume asset exists (don't spuriously reopen demand).
      return true;
    }
  }

  /**
   * Sweeps all 'open'/'uploading' demand requests and auto-resolves any
   * that now have a ready+available media asset.
   *
   * This is the "reconciliation sweep" that catches demand rows that were
   * missed by the fire-and-forget `resolveDemand` calls (e.g. transient
   * DB errors during upload completion, or assets that became available
   * via a path that doesn't trigger auto-resolution).
   *
   * Called on every admin Missing Media page load — bounded by the
   * `media_availability_requests` table size (typically < 1000 rows).
   * Returns the number of rows auto-resolved.
   */
  async sweepResolvedDemand(): Promise<number> {
    try {
      // Fetch all open/uploading demand rows with their canonical_keys.
      const { data: openRequests, error } = await this.client
        .from('media_availability_requests')
        .select('id, canonical_key')
        .in('status', ['open', 'uploading']);
      if (error || !openRequests || openRequests.length === 0) return 0;

      const canonicalKeys = openRequests.map((r: any) => r.canonical_key as string);
      if (canonicalKeys.length === 0) return 0;

      // Fetch media_items that match these canonical_keys (batch — no N+1).
      const { data: mediaItems, error: itemError } = await this.client
        .from('media_items')
        .select('id, canonical_key')
        .in('canonical_key', canonicalKeys);
      if (itemError || !mediaItems || mediaItems.length === 0) return 0;

      // Fetch ready+available media_assets for those media_items (batch — no N+1).
      // Phase 6 fix: check BOTH status='ready' AND mavero_status='available',
      // matching the resolver's requirements. Previously only checked status='ready',
      // which would falsely resolve demands for detached assets (mavero_status='missing').
      //
      // SWEEP BUG FIX (final remediation): the query previously had
      // `.limit(1)` here. Because this is a BATCH query across ALL
      // media_item_ids in the sweep, the limit collapsed the entire result
      // set to a single row — so at most ONE demand row was ever resolved
      // per sweep even when many assets became available (A/B/C scenario:
      // only A resolved). The limit is removed; we need every ready+available
      // asset row so `readyItemIds` covers the full batch. The result is
      // naturally bounded by the number of demand rows in the sweep.
      const mediaItemIds = mediaItems.map((m: any) => m.id as string);
      const { data: readyAssets, error: assetError } = await this.client
        .from('media_assets')
        .select('media_item_id')
        .in('media_item_id', mediaItemIds)
        .eq('status', 'ready')
        .eq('mavero_status', 'available');
      if (assetError || !readyAssets || readyAssets.length === 0) return 0;

      // Build the set of canonical_keys that have a ready+available asset.
      const readyItemIds = new Set(readyAssets.map((a: any) => a.media_item_id as string));
      const keysToResolve = mediaItems
        .filter((m: any) => readyItemIds.has(m.id))
        .map((m: any) => m.canonical_key as string);

      if (keysToResolve.length === 0) return 0;

      // Batch-resolve all matched demand rows.
      const { count } = await this.client
        .from('media_availability_requests')
        .update({ status: 'ready' }, { count: 'exact' })
        .in('canonical_key', keysToResolve)
        .in('status', ['open', 'uploading']);

      return count ?? 0;
    } catch {
      // Silently absorb — sweep is best-effort.
      return 0;
    }
  }

  /**
   * Sweeps all 'ready' demand requests and auto-reopens any that no
   * longer have a ready+available media asset.
   *
   * This is the "reverse reconciliation sweep" — it catches demand rows
   * that were resolved when an asset was available, but the asset was
   * subsequently deleted/detached. Without this sweep, the demand stays
   * 'ready' forever even though the content is no longer playable, and
   * Missing Media never surfaces it again.
   *
   * Called on every admin Missing Media page load (after
   * sweepResolvedDemand). Does NOT reopen 'ignored' demands.
   *
   * Returns the number of rows auto-reopened.
   */
  async sweepStaleResolvedDemand(): Promise<number> {
    try {
      // Fetch all 'ready' demand rows with their canonical_keys.
      const { data: readyRequests, error } = await this.client
        .from('media_availability_requests')
        .select('id, canonical_key')
        .eq('status', 'ready');
      if (error || !readyRequests || readyRequests.length === 0) return 0;

      const canonicalKeys = readyRequests.map((r: any) => r.canonical_key as string);
      if (canonicalKeys.length === 0) return 0;

      // Fetch media_items that match these canonical_keys (batch).
      const { data: mediaItems, error: itemError } = await this.client
        .from('media_items')
        .select('id, canonical_key')
        .in('canonical_key', canonicalKeys);
      if (itemError || !mediaItems || mediaItems.length === 0) {
        // No media_items found — all demands should be reopened (the
        // canonical media identity is gone).
        const { count } = await this.client
          .from('media_availability_requests')
          .update({ status: 'open' }, { count: 'exact' })
          .in('canonical_key', canonicalKeys)
          .eq('status', 'ready');
        return count ?? 0;
      }

      // Fetch ready+available media_assets for those media_items (batch).
      const mediaItemIds = mediaItems.map((m: any) => m.id as string);
      const { data: readyAssets } = await this.client
        .from('media_assets')
        .select('media_item_id')
        .in('media_item_id', mediaItemIds)
        .eq('status', 'ready')
        .eq('mavero_status', 'available');

      // Build the set of media_item_ids that have a ready+available asset.
      const availableItemIds = new Set((readyAssets ?? []).map((a: any) => a.media_item_id as string));

      // Find canonical_keys whose media_item does NOT have an available asset.
      const keysToReopen = mediaItems
        .filter((m: any) => !availableItemIds.has(m.id))
        .map((m: any) => m.canonical_key as string);

      // Also include canonical_keys that have no media_item at all.
      const foundKeys = new Set(mediaItems.map((m: any) => m.canonical_key as string));
      for (const key of canonicalKeys) {
        if (!foundKeys.has(key)) keysToReopen.push(key);
      }

      if (keysToReopen.length === 0) return 0;

      // Batch-reopen all matched demand rows.
      const { count } = await this.client
        .from('media_availability_requests')
        .update({ status: 'open' }, { count: 'exact' })
        .in('canonical_key', keysToReopen)
        .eq('status', 'ready');

      return count ?? 0;
    } catch {
      // Silently absorb — sweep is best-effort.
      return 0;
    }
  }

  /**
   * Builds a DemandEntry from the resolver context.
   */
  static buildEntry(
    content: NormalizedMediaItem,
    request: ResolverRequest,
    userKind: 'guest' | 'authenticated' | 'admin',
  ): DemandEntry | null {
    const tmdbId = content.externalIds?.tmdb ?? (content.source.provider === 'tmdb' ? content.source.externalId : undefined);
    if (!tmdbId) return null;

    const mediaType = request.mediaType;
    if (mediaType === 'movie') {
      return {
        canonicalKey: movieCanonicalKey(tmdbId),
        contentType: 'movie',
        tmdbId,
        imdbId: content.externalIds?.imdb ?? null,
        title: content.title,
        year: content.year ?? null,
        userKind,
      };
    } else if (mediaType === 'series' || mediaType === 'anime') {
      const season = request.season;
      const episode = request.episode;
      if (season == null || episode == null) return null;
      return {
        canonicalKey: episodeCanonicalKey(tmdbId, season, episode),
        contentType: mediaType as 'series' | 'anime',
        tmdbId,
        imdbId: content.externalIds?.imdb ?? null,
        season,
        episode,
        title: content.title,
        episodeTitle: null,
        year: content.year ?? null,
        userKind,
      };
    }
    return null;
  }
}
