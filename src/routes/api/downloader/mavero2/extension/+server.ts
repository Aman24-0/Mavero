import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { resolveCloudStreamExtensionDownload } from '$lib/server/cloudstream/downloader/service';
import { CloudStreamDownloaderError, downloaderErrorMessage, downloaderErrorStatus } from '$lib/server/cloudstream/downloader/errors';
import { assertAdultDownloadAllowed } from '$lib/server/content/adult-guard';
import type { ContentType } from '$lib/server/content/types';
import { RATE_LIMITED_ERROR_CODE, RATE_LIMITED_MESSAGE, checkRateLimit, clientIdentity } from '$lib/server/http/rate-limit';

/**
 * MAVERO DOWNLOADER 2 — targeted extension resolution endpoint (CS-3, plan
 * §13/§26 task 4).
 *
 *   GET /api/downloader/mavero2/extension?extensionId=Bollyflix&mediaType=movie&contentId=movie-123&tmdbId=123
 *   GET /api/downloader/mavero2/extension?extensionId=Bollyflix&mediaType=series&contentId=series-94605&tmdbId=94605&season=1&episode=2
 *
 * Resolves ONE CloudStream extension for a title (the per-tab progressive
 * flow the future CS-4 UI fires independently per source tab). The
 * extensionId is resolved through the DB catalog + code adapter registry
 * BEFORE any adapter runs — arbitrary unregistered adapter ids are NEVER
 * executed.
 *
 * Validation-state failures return STRUCTURED envelope errors:
 *   EXTENSION_NOT_FOUND (404), EXTENSION_DISABLED (409),
 *   ADAPTER_NOT_AVAILABLE (409), UNSUPPORTED_MEDIA (400).
 * Resolution failures (timeout/extractor/network) are GROUP results
 * (`status: 'failed'` + closed error code) — partial-success contract.
 *
 * Response shape:
 *
 *   { ok: true, media, group: { extensionId, extensionName, status:
 *     'loaded'|'empty'|'failed', links: [...], errorCode?,
 *     errorMessage?, matchedTitle?, diagnostics? } }
 *
 * SECURITY CONTRACT (mirrors the existing per-addon mavero endpoint):
 *   * validation → rate limit → Adult Mode guard run BEFORE any resolution;
 *   * every adapter/extractor fetch goes through the CS-2 SSRF-guarded
 *     runtime; the server NEVER fetches the returned media URLs;
 *   * the response contains ONLY safe presentation data — no tokens, no
 *     provider configuration, no SSRF detail, no raw upstream errors;
 *   * NO caching (`no-store`): provider URLs are dynamic.
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
  const extensionId = url.searchParams.get('extensionId')?.trim() ?? '';
  const seasonRaw = url.searchParams.get('season');
  const episodeRaw = url.searchParams.get('episode');
  const season = seasonRaw === null ? undefined : Number(seasonRaw);
  const episode = episodeRaw === null ? undefined : Number(episodeRaw);

  if (
    !validMediaType(mediaType) || !contentId || contentId.length > 200
    || !tmdbId || !/^\d{1,12}$/.test(tmdbId) || !extensionId || extensionId.length > 200
  ) {
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
  // per-addon endpoint so neither ecosystem can lock out the other.
  const rateVerdict = checkRateLimit('downloaderMavero2Extension', clientIdentity(request.headers, locals.user?.id));
  if (!rateVerdict.allowed) {
    return json({ ok: false, error: { code: RATE_LIMITED_ERROR_CODE, message: RATE_LIMITED_MESSAGE } }, { status: 429, headers: { 'cache-control': 'no-store', 'retry-after': String(rateVerdict.retryAfterSeconds) } });
  }
  // Adult Mode enforced at the server boundary (non-disclosing 404; runs
  // BEFORE the extension lookup — never swallowed by the catch below).
  await assertAdultDownloadAllowed(locals.supabase, locals.user, cookies, mediaType, contentId);

  try {
    // Lazily resolved admin client (the adult-guard pattern — see the main
    // mavero2 endpoint docblock).
    const { createSupabaseAdminClient } = await import('$lib/server/supabase/admin');
    const result = await resolveCloudStreamExtensionDownload(
      createSupabaseAdminClient(),
      {
        mediaType,
        contentId,
        ...(season !== undefined ? { season } : {}),
        ...(episode !== undefined ? { episode } : {}),
      },
      extensionId,
    );
    return json({ ok: true, media: result.media, group: result.group }, { headers: NO_STORE });
  } catch (error) {
    const typed = error instanceof CloudStreamDownloaderError ? error : null;
    const code = typed?.code ?? 'INTERNAL_ERROR';
    console.warn('[MaveroDownloader2/extension] resolution failed', code);
    return json(
      { ok: false, error: { code, message: downloaderErrorMessage(code) } },
      { status: typed !== null ? downloaderErrorStatus(typed.code) : 503, headers: NO_STORE },
    );
  }
};
