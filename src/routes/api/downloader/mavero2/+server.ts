import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { resolveCloudStreamDownloads, MAX_SELECTED_EXTENSIONS } from '$lib/server/cloudstream/downloader/service';
import { CloudStreamDownloaderError, downloaderErrorMessage, downloaderErrorStatus } from '$lib/server/cloudstream/downloader/errors';
import { assertAdultDownloadAllowed } from '$lib/server/content/adult-guard';
import type { ContentType } from '$lib/server/content/types';
import { RATE_LIMITED_ERROR_CODE, RATE_LIMITED_MESSAGE, checkRateLimit, clientIdentity } from '$lib/server/http/rate-limit';

/**
 * MAVERO DOWNLOADER 2 — public endpoint (CS-3, plan §13/§26/§40.3).
 *
 *   GET /api/downloader/mavero2?mediaType=movie&contentId=movie-123&tmdbId=123
 *   GET /api/downloader/mavero2?mediaType=series&contentId=series-94605&tmdbId=94605&season=1&episode=2
 *   GET /api/downloader/mavero2?…&extensions=Bollyflix,MoviesDrive   (explicit selection)
 *
 * Resolves the ELIGIBLE CloudStream extensions for ONE title through the
 * CS-2 bounded orchestrator and returns per-extension groups:
 *
 *   { ok: true, consideredExtensions, media, groups: [ { extensionId,
 *     extensionName, status: 'loaded'|'empty'|'failed', links: [...],
 *     errorCode?, errorMessage?, matchedTitle?, diagnostics? } ] }
 *
 * PARTIAL SUCCESS: one failing provider NEVER fails the request — Bollyflix
 * success + MoviesDrive timeout + VegaMovies extractor failure still
 * returns the Bollyflix results (allSettled isolation, plan §26 task 10).
 *
 * SECURITY CONTRACT (mirrors the existing Mavero downloader endpoints):
 *   * validation → rate limit → Adult Mode guard run BEFORE any resolution;
 *   * extension config is read SERVER-SIDE via the admin client (no public
 *     cloudstream_* read path); client-supplied extension ids are resolved
 *     through the DB + code registry — never trusted, never executed raw;
 *   * every adapter/extractor fetch goes through the CS-2 SSRF-guarded
 *     runtime (two-stage guard + connect-time re-validation — plan §10.4);
 *   * the response contains ONLY safe presentation data + redaction-safe
 *     diagnostics — no tokens, cookies, provider credentials, SSRF detail,
 *     or raw upstream errors; per-extension failures use the closed
 *     error-code vocabulary;
 *   * `tmdbId` is a bounded sanity check; the resolution id comes from the
 *     canonical content pipeline (same semantics as /api/downloader/mavero).
 *   * NO caching: providers rotate domains and URLs expire — every response
 *     is fresh (`no-store`; documented decision, plan §40.7).
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

/** Parses the optional explicit extension selection list (comma-separated). */
function parseExtensionSelection(raw: string | null): string[] | undefined {
  if (raw === null) return undefined;
  const parts = raw
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0 && part.length <= 200);
  if (parts.length === 0) return undefined;
  return parts;
}

export const GET: RequestHandler = async ({ url, request, locals, cookies }) => {
  const mediaType = url.searchParams.get('mediaType');
  const contentId = url.searchParams.get('contentId')?.trim() ?? '';
  const tmdbId = url.searchParams.get('tmdbId')?.trim() ?? '';
  const seasonRaw = url.searchParams.get('season');
  const episodeRaw = url.searchParams.get('episode');
  const season = seasonRaw === null ? undefined : Number(seasonRaw);
  const episode = episodeRaw === null ? undefined : Number(episodeRaw);
  const extensions = parseExtensionSelection(url.searchParams.get('extensions'));

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
  // The request contract distinguishes movie vs series episode (plan §13):
  // movies must NOT carry episode context; series/anime require BOTH.
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
  if (extensions !== undefined && extensions.length > MAX_SELECTED_EXTENSIONS) {
    return json(
      { ok: false, error: { code: 'INVALID_REQUEST', message: downloaderErrorMessage('INVALID_REQUEST') } },
      { status: 400, headers: NO_STORE },
    );
  }

  // Bounded per-identity rate limit (audit SEC-003 convention): each call
  // can spend the 30-40s CS-2 upstream budgets. SEPARATE bucket from the
  // Stremio downloader so neither ecosystem can lock out the other.
  const rateVerdict = checkRateLimit('downloaderMavero2', clientIdentity(request.headers, locals.user?.id));
  if (!rateVerdict.allowed) {
    return json({ ok: false, error: { code: RATE_LIMITED_ERROR_CODE, message: RATE_LIMITED_MESSAGE } }, { status: 429, headers: { 'cache-control': 'no-store', 'retry-after': String(rateVerdict.retryAfterSeconds) } });
  }
  // Adult Mode enforced at the server boundary (audit BL-5/DL-1): the SAME
  // non-disclosing 404 as the detail flow, BEFORE any resolution — the
  // HttpError must never be swallowed by the 503 catch below.
  await assertAdultDownloadAllowed(locals.supabase, locals.user, cookies, mediaType, contentId);

  try {
    // Lazily resolved admin client (the adult-guard pattern: production
    // wiring without a top-level $env dependency — testability without
    // behavior drift). Extension config is read server-side only.
    const { createSupabaseAdminClient } = await import('$lib/server/supabase/admin');
    const result = await resolveCloudStreamDownloads(
      createSupabaseAdminClient(),
      {
        mediaType,
        contentId,
        ...(season !== undefined ? { season } : {}),
        ...(episode !== undefined ? { episode } : {}),
      },
      extensions !== undefined ? { extensionIds: extensions } : {},
      // Permanent Adapter Plan Phase 1: an abandoned client request cancels
      // the server-side resolution (the overall deadline controller links
      // this signal). The 30s/40s budgets still bound the response path.
      { signal: request.signal },
    );
    return json(
      {
        ok: true,
        consideredExtensions: result.consideredExtensions,
        media: result.media,
        groups: result.groups,
      },
      { headers: NO_STORE },
    );
  } catch (error) {
    const typed = error instanceof CloudStreamDownloaderError ? error : null;
    const code = typed?.code ?? 'INTERNAL_ERROR';
    console.warn('[MaveroDownloader2] resolution failed', code);
    return json(
      { ok: false, error: { code, message: downloaderErrorMessage(code) } },
      { status: typed !== null ? downloaderErrorStatus(typed.code) : 503, headers: NO_STORE },
    );
  }
};
