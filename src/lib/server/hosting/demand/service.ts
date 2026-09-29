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
        // Status is 'ignored' or 'ready' — do not increment.
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
