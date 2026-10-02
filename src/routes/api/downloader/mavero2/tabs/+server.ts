import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { listCloudStreamDownloadTabs } from '$lib/server/cloudstream/downloader/service';
import { CloudStreamDownloaderError, downloaderErrorMessage, downloaderErrorStatus } from '$lib/server/cloudstream/downloader/errors';
import { assertAdultDownloadAllowed } from '$lib/server/content/adult-guard';
import type { ContentType } from '$lib/server/content/types';
import { RATE_LIMITED_ERROR_CODE, RATE_LIMITED_MESSAGE, checkRateLimit, clientIdentity } from '$lib/server/http/rate-limit';

/**
 * MAVERO DOWNLOADER 2 — extension TAB list endpoint (CS-3, plan §13/§26).
 *
 *   GET /api/downloader/mavero2/tabs?mediaType=movie&contentId=movie-123&tmdbId=123
 *   GET /api/downloader/mavero2/tabs?mediaType=series&contentId=series-94605&tmdbId=94605&season=1&episode=2
 *
 * Returns the eligible CloudStream source tab metadata ONLY — NO provider
 * fetches. The future CS-4 UI renders the tabs immediately in `loading`
 * state and fires `GET /api/downloader/mavero2/extension` per tab
 * independently (progressive pattern — the same flow the existing Stremio
 * downloader uses for its addon tabs).
 *
 * Eligibility (only eligible sources are listed): repository enabled +
 * extension enabled + adapter registered (code registry authority) +
 * media-type support. `enabled`/`compatible` are structurally true for every
 * returned tab — the ineligible ones are simply absent.
 *
 * SECURITY CONTRACT (mirrors the existing Mavero tabs endpoint):
 *   * no provider URLs, no extension configuration, no tokens — only safe
 *     display metadata (extensionId/internalName, display name, icon,
 *     supported media types);
 *   * extension config is read SERVER-SIDE via the admin client only;
 *   * `tmdbId` is a bounded sanity check; validation → rate limit → Adult
 *     Mode guard run BEFORE any catalog access;
 *   * NO caching (`no-store`): the enable/adapter state must stay fresh.
 */

const NO_STORE = { 'cache-control': 'no-store' } as const;

function validMediaType(value: string | null): value is ContentType {
  return value === 'movie' || value === 'series' || value === 'anime';
}

/** Season/episode bounds (audit API-17 convention): 1..10000 safe integers. */
function validEpisodeContext(value: number | undefined): boolean {
  if (value === undefined) return true;
  return Number.isSafeInteger(value) && value >= 1 && value <= 10000;
}

export const GET: RequestHandler = async ({ url, request, locals, cookies }) => {
  const mediaType = url.searchParams.get('mediaType');
  const contentId = url.searchParams.get('contentId')?.trim() ?? '';
  const tmdbId = url.searchParams.get('tmdbId')?.trim() ?? '';
  const seasonRaw = url.searchParams.get('season');
  const episodeRaw = url.searchParams.get('episode');
  const season = seasonRaw === null ? undefined : Number(seasonRaw);
  const episode = episodeRaw === null ? undefined : Number(episodeRaw);

  if (!validMediaType(mediaType) || !contentId || contentId.length > 200 || !tmdbId || !/^\d{1,12}$/.test(tmdbId)) {
    return json(
      { ok: false, error: { code: 'INVALID_REQUEST', message: downloaderErrorMessage('INVALID_REQUEST') } },
      { status: 400, headers: NO_STORE },
    );
  }
  if (!validEpisodeContext(season) || !validEpisodeContext(episode)) {
    return json(
      { ok: false, error: { code: 'INVALID_REQUEST', message: downloaderErrorMessage('INVALID_REQUEST') } },
      { status: 400, headers: NO_STORE },
    );
  }
  // Movie vs series-episode contract (mirrors the main mavero2 endpoint).
  if (mediaType === 'movie' && (season !== undefined || episode !== undefined)) {
    return json(
      { ok: false, error: { code: 'INVALID_REQUEST', message: downloaderErrorMessage('INVALID_REQUEST') } },
      { status: 400, headers: NO_STORE },
    );
  }
  if (mediaType !== 'movie' && (season === undefined || episode === undefined)) {
    return json(
      { ok: false, error: { code: 'INVALID_REQUEST', message: downloaderErrorMessage('INVALID_REQUEST') } },
      { status: 400, headers: NO_STORE },
    );
  }

  // Bounded per-identity rate limit — SEPARATE bucket from the Stremio
  // tabs endpoint so neither ecosystem can lock out the other.
  const rateVerdict = checkRateLimit('downloaderMavero2Tabs', clientIdentity(request.headers, locals.user?.id));
  if (!rateVerdict.allowed) {
    return json({ ok: false, error: { code: RATE_LIMITED_ERROR_CODE, message: RATE_LIMITED_MESSAGE } }, { status: 429, headers: { 'cache-control': 'no-store', 'retry-after': String(rateVerdict.retryAfterSeconds) } });
  }
  // Adult Mode enforced at the server boundary (non-disclosing 404; runs
  // BEFORE catalog access — never swallowed by the 503 catch below).
  await assertAdultDownloadAllowed(locals.supabase, locals.user, cookies, mediaType, contentId);

  try {
    // Lazily resolved admin client (the adult-guard pattern — see the main
    // mavero2 endpoint docblock).
    const { createSupabaseAdminClient } = await import('$lib/server/supabase/admin');
    const result = await listCloudStreamDownloadTabs(
      createSupabaseAdminClient(),
      {
        mediaType,
        contentId,
        ...(season !== undefined ? { season } : {}),
        ...(episode !== undefined ? { episode } : {}),
      },
    );
    return json(
      {
        ok: true,
        consideredExtensions: result.consideredExtensions,
        media: result.media,
        tabs: result.tabs,
      },
      { headers: NO_STORE },
    );
  } catch (error) {
    const typed = error instanceof CloudStreamDownloaderError ? error : null;
    const code = typed?.code ?? 'INTERNAL_ERROR';
    console.warn('[MaveroDownloader2/tabs] resolution failed', code);
    return json(
      { ok: false, error: { code, message: downloaderErrorMessage(code) } },
      { status: typed !== null ? downloaderErrorStatus(typed.code) : 503, headers: NO_STORE },
    );
  }
};
