/**
 * Admin 2.0 — Link an existing provider file to a Mavero media item.
 *
 * POST /api/admin/media/assets/link
 *
 * MAV-FOCUSED (2026-10): accepts BOTH identity contracts:
 *   * TMDB identity: { contentType, tmdbId, season?, episode?, providerSourceId, providerAssetId }
 *     The server resolves the canonical media_item UUID via
 *     CanonicalMediaService.ensure* (same as the Missing Media link flow).
 *   * Direct UUID: { mediaItemId, providerSourceId, providerAssetId }
 *     For callers that already have the media_items.id UUID (e.g. the
 *     AdminMediaDetailDrawer).
 *
 * This endpoint NEVER accepts a prefixed canonical key (e.g. "movie-12345")
 * as a mediaItemId — that was the root cause of the UUID mismatch.
 *
 * Security: admin-only (requireAdmin). Service-role client.
 */

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireAdmin } from '$lib/server/streaming/admin-auth';
import { createSupabaseAdminClient } from '$lib/server/supabase/admin';
import { NO_STORE } from '$lib/server/http/cache-headers';
import { ManagementService } from '$lib/server/hosting/management/service';
import { CanonicalMediaService } from '$lib/server/hosting/media/service';
import { HostingProviderError } from '$lib/server/hosting/errors';
import type { ContentType } from '$lib/server/content/types';
import { getDetail } from '$lib/server/content/service';

const NO_STORE_HEADERS = { 'cache-control': NO_STORE } as const;

export const POST: RequestHandler = async ({ request, locals }) => {
  const { user } = await requireAdmin(locals, { redirectTo: '/admin' });
  const adminClient = createSupabaseAdminClient();
  const mediaService = new CanonicalMediaService(adminClient);
  const management = new ManagementService(adminClient, mediaService);

  let body: {
    mediaItemId?: string;
    contentType?: string;
    tmdbId?: string;
    season?: string;
    episode?: string;
    providerSourceId?: string;
    providerAssetId?: string;
  };
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: { code: 'INVALID_REQUEST', message: 'Invalid JSON body.' } }, { status: 400, headers: NO_STORE_HEADERS });
  }

  const { mediaItemId, contentType, tmdbId, season, episode, providerSourceId, providerAssetId } = body;

  if (!providerSourceId || !providerAssetId) {
    return json({ ok: false, error: { code: 'INVALID_REQUEST', message: 'providerSourceId and providerAssetId are required.' } }, { status: 400, headers: NO_STORE_HEADERS });
  }

  // Resolve the canonical media_item UUID.
  let resolvedMediaItemId: string;

  if (mediaItemId) {
    // Direct UUID path — validate it looks like a UUID (not a prefixed
    // canonical key like "movie-12345").
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(mediaItemId)) {
      return json({ ok: false, error: { code: 'INVALID_REQUEST', message: 'mediaItemId must be a valid UUID. Use the TMDB identity (contentType + tmdbId) for titles not yet in the catalog.' } }, { status: 400, headers: NO_STORE_HEADERS });
    }
    resolvedMediaItemId = mediaItemId;
  } else if (contentType && tmdbId) {
    // TMDB identity path — resolve to a real UUID via CanonicalMediaService.
    const validTypes: ContentType[] = ['movie', 'series', 'anime'];
    if (!validTypes.includes(contentType as ContentType)) {
      return json({ ok: false, error: { code: 'INVALID_REQUEST', message: `contentType must be one of: ${validTypes.join(', ')}.` } }, { status: 400, headers: NO_STORE_HEADERS });
    }
    const seasonNum = season ? Number(season) : null;
    const episodeNum = episode ? Number(episode) : null;

    try {
      // Fetch TMDB metadata to get the title (required by ensure* methods).
      const tmdbType = (contentType === 'movie') ? 'movie' : 'series';
      const detail = await getDetail(tmdbType as ContentType, tmdbId);
      const title = detail.title ?? 'Untitled';
      const year = detail.year ?? null;

      if (contentType === 'movie') {
        const result = await mediaService.ensureMovie({ tmdbId, title, year });
        resolvedMediaItemId = result.mediaItemId;
      } else {
        // series or anime — both use ensureSeries.
        const result = await mediaService.ensureSeries({ tmdbId, title, year });
        if (seasonNum != null && episodeNum != null) {
          const epResult = await mediaService.ensureEpisode({
            seriesTmdbId: tmdbId,
            season: seasonNum,
            episode: episodeNum,
            seriesTitle: title,
          });
          resolvedMediaItemId = epResult.mediaItemId;
        } else {
          resolvedMediaItemId = result.mediaItemId;
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to resolve the media item.';
      return json({ ok: false, error: { code: 'MEDIA_ITEM_RESOLUTION_FAILED', message } }, { status: 400, headers: NO_STORE_HEADERS });
    }
  } else {
    return json({ ok: false, error: { code: 'INVALID_REQUEST', message: 'Either mediaItemId (UUID) or contentType + tmdbId are required.' } }, { status: 400, headers: NO_STORE_HEADERS });
  }

  try {
    const result = await management.linkAsset(resolvedMediaItemId, providerSourceId, providerAssetId, user.id);
    if (result.ok) {
      return json({ ok: true, mediaAssetId: result.mediaAssetId }, { headers: NO_STORE_HEADERS });
    }
    return json({ ok: false, error: { code: result.error?.code ?? 'UNKNOWN', message: result.error?.message ?? 'Link failed.' } }, { status: 400, headers: NO_STORE_HEADERS });
  } catch (error) {
    if (error instanceof HostingProviderError) {
      return json({ ok: false, error: { code: error.code, message: error.message } }, { status: 400, headers: NO_STORE_HEADERS });
    }
    const message = error instanceof Error ? error.message : 'Unknown error';
    return json({ ok: false, error: { code: 'UNKNOWN', message } }, { status: 500, headers: NO_STORE_HEADERS });
  }
};
