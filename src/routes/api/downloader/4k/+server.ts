import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { fetchFourKLinks } from '$lib/server/downloader/fourk-service';
import type { ContentType } from '$lib/server/content/types';

/**
 * MAVERO 4K Downloader — public endpoint (Phase 19).
 *
 *   GET /api/downloader/4k?mediaType=movie&tmdbId=123456
 *   GET /api/downloader/4k?mediaType=series&tmdbId=94605&season=1&episode=2
 *
 * Fetches the downloads.shegu.st JSON API server-side (avoids client-side CORS)
 * and returns the parsed links[] array. The media URLs are preserved verbatim
 * — Download + Share operate on the EXACT returned URL.
 *
 * SECURITY (task §14):
 *   * The 4K service fetches ONLY from the fixed https://downloads.shegu.st origin.
 *   * Path parameters are validated (tmdbId = digits, season/episode = positive ints).
 *   * Response size is bounded (1 MiB).
 *   * Timeout is 15s.
 *   * No media URLs are fetched server-side — only the JSON API.
 */

const NO_STORE = { 'cache-control': 'no-store' } as const;

function validMediaType(value: string | null): value is ContentType {
  return value === 'movie' || value === 'series' || value === 'anime';
}

export const GET: RequestHandler = async ({ url }) => {
  const mediaType = url.searchParams.get('mediaType');
  const tmdbId = url.searchParams.get('tmdbId')?.trim() ?? '';
  const seasonRaw = url.searchParams.get('season');
  const episodeRaw = url.searchParams.get('episode');
  const season = seasonRaw === null ? undefined : Number(seasonRaw);
  const episode = episodeRaw === null ? undefined : Number(episodeRaw);

  if (!validMediaType(mediaType) || !tmdbId || !/^\d{1,12}$/.test(tmdbId)) {
    return json(
      { ok: false, error: { code: 'INVALID_REQUEST', message: 'The 4K Downloader request is invalid.' } },
      { status: 400, headers: NO_STORE },
    );
  }
  if ((season !== undefined && !Number.isSafeInteger(season)) || (episode !== undefined && !Number.isSafeInteger(episode))) {
    return json(
      { ok: false, error: { code: 'INVALID_REQUEST', message: 'The 4K Downloader request is invalid.' } },
      { status: 400, headers: NO_STORE },
    );
  }

  try {
    const result = await fetchFourKLinks({ mediaType, tmdbId, ...(season !== undefined ? { season } : {}), ...(episode !== undefined ? { episode } : {}) });
    return json({ ok: true, links: result.links, malformed: result.malformed }, { headers: NO_STORE });
  } catch (error) {
    console.warn('[4KDownloader] resolution failed', error);
    return json(
      { ok: false, error: { code: 'RESOLUTION_UNAVAILABLE', message: '4K Downloader is temporarily unavailable.' } },
      { status: 503, headers: NO_STORE },
    );
  }
};
