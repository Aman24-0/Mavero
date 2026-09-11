import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { resolveSingleAddonDownload } from '$lib/server/streaming/stremio/addon-download-service';
import { StreamServiceError } from '$lib/server/streaming/stremio/stream-errors';
import { createSupabaseAdminClient } from '$lib/server/supabase/admin';
import type { ContentType } from '$lib/server/content/types';

/**
 * MAVERO Downloader — per-addon resolution endpoint (Phase 15, task §1/§2/§3).
 *
 *   GET /api/downloader/mavero/addon?mediaType=movie&contentId=movie-123&tmdbId=123&addon=<addon-id>
 *   GET /api/downloader/mavero/addon?mediaType=series&contentId=series-94605&tmdbId=94605&season=1&episode=2&addon=<addon-id>
 *
 * Resolves ONE addon with a bounded retry/backoff budget (task §3). The
 * frontend fires one such request per addon tab INDEPENDENTLY — successful
 * addons remain visible immediately, slow addons keep loading in the
 * background, a failed addon never resets other addons, and a Retry on one
 * addon re-fires ONLY that addon's request.
 *
 * Response shape:
 *
 *   { ok: true, group: { addonId, addonName, addonSlug, addonOrdering,
 *     status: 'loading'|'retrying'|'loaded'|'empty'|'unavailable',
 *     streams: [...], errorCode?, attempts? } }
 *
 * The five-state model (task §3):
 *   * `loading`     — never returned by THIS endpoint (the request is the
 *                     load); the frontend renders `loading` before firing.
 *   * `retrying`    — implicit during the in-flight request (the server is
 *                     doing bounded retries internally; the frontend sees
 *                     the final result, not intermediate retry states).
 *   * `loaded`      — addon responded and ≥1 direct link survived.
 *   * `empty`       — addon responded but nothing survived filtering
 *                     (honest zero, NOT a failure).
 *   * `unavailable` — addon request failed after exhausting the retry
 *                     budget (closed error code vocabulary).
 *
 * SECURITY CONTRACT (same as the batch endpoint):
 *   * the server fetches ONLY the addon stream LIST endpoint (existing
 *     SSRF guard); it NEVER fetches the returned media URLs;
 *   * the response contains ONLY safe presentation data — no manifest
 *     URLs, no addon configuration, no auth tokens, no internal SSRF
 *     detail, no raw upstream errors;
 *   * per-addon failures use the closed error-code vocabulary.
 */

const NO_STORE = { 'cache-control': 'no-store' } as const;

function validMediaType(value: string | null): value is ContentType {
  return value === 'movie' || value === 'series' || value === 'anime';
}

export const GET: RequestHandler = async ({ url }) => {
  const mediaType = url.searchParams.get('mediaType');
  const contentId = url.searchParams.get('contentId')?.trim() ?? '';
  const tmdbId = url.searchParams.get('tmdbId')?.trim() ?? '';
  const addonId = url.searchParams.get('addon')?.trim() ?? '';
  const seasonRaw = url.searchParams.get('season');
  const episodeRaw = url.searchParams.get('episode');
  const season = seasonRaw === null ? undefined : Number(seasonRaw);
  const episode = episodeRaw === null ? undefined : Number(episodeRaw);

  if (!validMediaType(mediaType) || !contentId || contentId.length > 200 || !tmdbId || tmdbId.length > 50 || !addonId || addonId.length > 200) {
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
    const group = await resolveSingleAddonDownload(createSupabaseAdminClient(), {
      mediaType,
      contentId,
      ...(season !== undefined ? { season } : {}),
      ...(episode !== undefined ? { episode } : {}),
    }, addonId);
    return json({ ok: true, group }, { headers: NO_STORE });
  } catch (error) {
    console.warn('[MaveroDownloader/addon] resolution failed', error instanceof StreamServiceError ? error.code : error);
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
