import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { resolveAddonDownloads } from '$lib/server/streaming/stremio/addon-download-service';
import { StreamServiceError } from '$lib/server/streaming/stremio/stream-errors';
import { createSupabaseAdminClient } from '$lib/server/supabase/admin';
import type { ContentType } from '$lib/server/content/types';

/**
 * MAVERO Downloader — public endpoint (Phase 14).
 *
 *   GET /api/downloader/mavero?mediaType=movie&contentId=movie-123&tmdbId=123
 *   GET /api/downloader/mavero?mediaType=series&contentId=series-94605&tmdbId=94605&season=1&episode=2
 *
 * Resolves the enabled Stremio HTTP addons for ONE title and returns the
 * BEST practical direct links per addon, grouped and state-tagged:
 *
 *   { ok: true, consideredAddons, groups: [ { addonId, addonName, addonSlug,
 *     addonOrdering, status: 'loaded'|'empty'|'failed', streams: [...] } ] }
 *
 * SECURITY CONTRACT:
 *   * The server fetches ONLY addon stream LIST endpoints (existing SSRF
 *     guard). It NEVER fetches the returned media URLs.
 *   * The response contains ONLY safe presentation data — no manifest URLs,
 *     no addon configuration, no auth tokens, no internal SSRF detail, no
 *     raw upstream errors. Per-addon failures use the closed error-code
 *     vocabulary.
 *   * `tmdbId` is accepted only as a bounded sanity check; addon ID
 *     construction still comes from the canonical content pipeline.
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
    const result = await resolveAddonDownloads(createSupabaseAdminClient(), {
      mediaType,
      contentId,
      ...(season !== undefined ? { season } : {}),
      ...(episode !== undefined ? { episode } : {}),
    });
    return json({ ok: true, consideredAddons: result.consideredAddons, groups: result.groups }, { headers: NO_STORE });
  } catch (error) {
    console.warn('[MaveroDownloader] resolution failed', error instanceof StreamServiceError ? error.code : error);
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
