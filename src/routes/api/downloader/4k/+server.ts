import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { fetchFourKLinks } from '$lib/server/downloader/fourk-service';
import { assertAdultDownloadAllowed, downloaderContentId } from '$lib/server/content/adult-guard';
import type { ContentType } from '$lib/server/content/types';
import { RATE_LIMITED_ERROR_CODE, RATE_LIMITED_MESSAGE, checkRateLimit, clientIdentity } from '$lib/server/http/rate-limit';

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

/**
 * Season/episode bounds (Phase 1, audit API-17): positive integers with a
 * sensible upper bound, consistent with the existing route contract
 * (parseStremioPlaybackRequest accepts the same 1..10000 range). Previously
 * season/episode <= 0 passed this endpoint and failed inside the service,
 * producing a misleading 503 instead of a client validation error.
 */
function validEpisodeContext(value: number | undefined): boolean {
  if (value === undefined) return true;
  return Number.isSafeInteger(value) && value >= 1 && value <= 10000;
}

export const GET: RequestHandler = async ({ url, request, locals, cookies }) => {
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
  if (!validEpisodeContext(season) || !validEpisodeContext(episode)) {
    return json(
      { ok: false, error: { code: 'INVALID_REQUEST', message: 'The 4K Downloader request is invalid.' } },
      { status: 400, headers: NO_STORE },
    );
  }


  // Phase 1 (audit SEC-003/DL-5/STM-11): bounded per-identity rate limit —
  // this endpoint drives real upstream work (30-40s addon budgets / 4K API).
  const rateVerdict = checkRateLimit('downloader4k', clientIdentity(request.headers, locals.user?.id));
  if (!rateVerdict.allowed) {
    return json({ ok: false, error: { code: RATE_LIMITED_ERROR_CODE, message: RATE_LIMITED_MESSAGE } }, { status: 429, headers: { 'cache-control': 'no-store', 'retry-after': String(rateVerdict.retryAfterSeconds) } });
  }
  // Phase 1 (audit BL-5/DL-1): Adult Mode enforced at the server boundary.
  // The 4K adapter only ever sees the TMDB id, so the guard classifies the
  // title through the canonical content pipeline (cached detail path) and
  // blocks adult titles with the non-disclosing 404 before any fetch.
  await assertAdultDownloadAllowed(locals.supabase, locals.user, cookies, mediaType, downloaderContentId(mediaType, tmdbId));

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
