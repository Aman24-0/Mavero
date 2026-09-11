import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { listAddonDownloadTargets } from '$lib/server/streaming/stremio/addon-download-service';
import { StreamServiceError } from '$lib/server/streaming/stremio/stream-errors';
import { createSupabaseAdminClient } from '$lib/server/supabase/admin';
import type { ContentType } from '$lib/server/content/types';

/**
 * MAVERO Downloader — addon TAB list endpoint (Phase 15, task §1).
 *
 *   GET /api/downloader/mavero/tabs?mediaType=movie&contentId=movie-123&tmdbId=123
 *   GET /api/downloader/mavero/tabs?mediaType=series&contentId=series-94605&tmdbId=94605&season=1&episode=2
 *
 * Returns the addon tab metadata ONLY — NO stream fetches. The UI renders
 * the tabs immediately in `loading` state and fires
 * `GET /api/downloader/mavero/addon` per tab independently, so:
 *   * successful addon tabs appear immediately as they complete;
 *   * slow addons continue loading in the background;
 *   * a failed addon never resets successful addons;
 *   * retry affects only the retried addon.
 *
 * SECURITY CONTRACT (same as the batch endpoint):
 *   * no manifest URLs, no addon configuration, no auth tokens;
 *   * only safe display metadata (id/name/slug/ordering) is returned;
 *   * `tmdbId` is a bounded sanity check; addon ID construction comes from
 *     the canonical content pipeline.
 */

const NO_STORE = { 'cache-control': 'no-store' } as const;

function validMediaType(value: string | null): value is ContentType {
  return value === 'movie' || value === 'series' || value === 'anime';
}

export const GET: RequestHandler = async ({ url }) => {
  const mediaType = url.searchParams.get('mediaType');
  const contentId = url.searchParams.get('contentId')?.trim() ?? '';
  const tmdbId = url.searchParams.get('tmdbId')?.trim() ?? '';
  const seasonRaw = url.searchParams.get('season');
  const episodeRaw = url.searchParams.get('episode');
  const season = seasonRaw === null ? undefined : Number(seasonRaw);
  const episode = episodeRaw === null ? undefined : Number(episodeRaw);

  if (!validMediaType(mediaType) || !contentId || contentId.length > 200 || !tmdbId || tmdbId.length > 50) {
    return json(
      { ok: false, error: { code: 'INVALID_REQUEST', message: 'The Mavero Downloader request is invalid.' } },
      { status: 400, headers: NO_STORE },
    );
  }
  if ((season !== undefined && !Number.isSafeInteger(season)) || (episode !== undefined && !Number.isSafeInteger(episode))) {
    return json(
      { ok: false, error: { code: 'INVALID_REQUEST', message: 'The Mavero Downloader request is invalid.' } },
      { status: 400, headers: NO_STORE },
    );
  }

  try {
    const result = await listAddonDownloadTargets(createSupabaseAdminClient(), {
      mediaType,
      contentId,
      ...(season !== undefined ? { season } : {}),
      ...(episode !== undefined ? { episode } : {}),
    });
    return json({ ok: true, consideredAddons: result.consideredAddons, tabs: result.tabs }, { headers: NO_STORE });
  } catch (error) {
    console.warn('[MaveroDownloader/tabs] resolution failed', error instanceof StreamServiceError ? error.code : error);
    const invalid = error instanceof StreamServiceError && error.code === 'INVALID_REQUEST';
    return json(
      {
        ok: false,
        error: {
          code: invalid ? 'INVALID_REQUEST' : 'RESOLUTION_UNAVAILABLE',
          message: invalid ? 'The Mavero Downloader request is invalid.' : 'Mavero Downloader is temporarily unavailable.',
        },
      },
      { status: invalid ? 400 : 503, headers: NO_STORE },
    );
  }
};
