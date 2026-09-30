import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { loadJsonDownloadProvider, resolveJsonDownloadLinks, JSON_DOWNLOADER_TITLE_MAX_CHARS } from '$lib/server/downloader/json-service';
import { assertAdultDownloadAllowed, downloaderContentId } from '$lib/server/content/adult-guard';
import type { ContentType } from '$lib/server/content/types';
import { isContentType } from '$lib/server/content/types';
import { checkRateLimit, clientIdentity, RATE_LIMITED_ERROR_CODE, RATE_LIMITED_MESSAGE } from '$lib/server/http/rate-limit';
import { errorResponse } from '$lib/server/http/error-response';

/**
 * MAVERO generic JSON downloader — public endpoint for type='json' providers.
 *
 *   GET /api/downloader/json?providerId=<uuid>&mediaType=movie&tmdbId=123456
 *   GET /api/downloader/json?providerId=<uuid>&mediaType=tv&tmdbId=94605&season=1&episode=2
 *   GET /api/downloader/json?providerId=<uuid>&mediaType=movie&tmdbId=123456&title=<media title>
 *
 * Resolves the ADMIN-CONFIGURED URL template server-side, fetches the JSON
 * API through Mavero's SSRF-safe infrastructure, and returns ONLY the
 * normalized, sanitized link payload. The returned media/download URLs are
 * preserved verbatim — the browser's Download/Share actions use the EXACT
 * URL; the server NEVER fetches those media URLs.
 *
 * SECURITY:
 *   * The client NEVER supplies a URL — only providerId + media context.
 *     The URL always comes from the enabled registry row's template.
 *   * The optional `title` (bounded to JSON_DOWNLOADER_TITLE_MAX_CHARS)
 *     exists so templates using {titleSlug} can resolve. It is slugified
 *     SERVER-SIDE by the shared builder (slugifyTitle + encodeURIComponent
 *     — the value can only ever affect the placeholder's position inside
 *     the admin-configured HTTPS URL, never the scheme or host); a template
 *     needing a slug with no usable title fails as url-not-buildable.
 *   * The provider must be enabled AND type='json' AND support the requested
 *     media type — every violation is the SAME generic 404 (non-disclosing).
 *   * Bounded per-identity rate limit (downloaderJson, 20/min) BEFORE any
 *     upstream work.
 *   * Adult Mode enforced at the server boundary (non-disclosing 404 before
 *     any upstream fetch; identical to the 4K/mavero downloader endpoints).
 *   * The fetch itself (SSRF guard, bounded redirects, timeout, streamed
 *     size cap, JSON-only content type) lives in the shared manifest fetcher
 *     — this endpoint never reimplements it.
 *   * Errors are generic and non-disclosing — no upstream bodies, headers,
 *     or secrets ever reach the client.
 */

const NO_STORE = { 'cache-control': 'no-store' } as const;

/** Registry-shaped media type ('movie' | 'tv'). */
function validMediaType(value: string | null): value is 'movie' | 'tv' {
  return value === 'movie' || value === 'tv';
}

/** Season/episode bounds — mirrors the 4K endpoint contract (1..10000). */
function validEpisodeContext(value: number | undefined): boolean {
  if (value === undefined) return true;
  return Number.isSafeInteger(value) && value >= 1 && value <= 10000;
}

export const GET: RequestHandler = async ({ url, request, locals, cookies }) => {
  const providerId = url.searchParams.get('providerId')?.trim() ?? '';
  const mediaType = url.searchParams.get('mediaType');
  const contentTypeParam = url.searchParams.get('contentType');
  const tmdbId = url.searchParams.get('tmdbId')?.trim() ?? '';
  const seasonRaw = url.searchParams.get('season');
  const episodeRaw = url.searchParams.get('episode');
  const season = seasonRaw === null ? undefined : Number(seasonRaw);
  const episode = episodeRaw === null ? undefined : Number(episodeRaw);
  // Optional media title — required only when the provider's template uses
  // {titleSlug}. Bounded so a request cannot inflate the built URL; the
  // shared builder slugifies it server-side (never trusted verbatim).
  const titleParam = url.searchParams.get('title');

  // 1. Request validation. `contentType` (original app content type) is
  //    optional and used ONLY for the adult guard — it preserves the
  //    'anime' classification exactly like the 4K/mavero endpoints.
  if (
    !providerId || !/^[0-9a-f-]{36}$/i.test(providerId) ||
    !validMediaType(mediaType) ||
    !tmdbId || !/^\d{1,12}$/.test(tmdbId) ||
    (contentTypeParam !== null && !isContentType(contentTypeParam)) ||
    !validEpisodeContext(season) ||
    !validEpisodeContext(episode) ||
    (titleParam !== null && titleParam.length > JSON_DOWNLOADER_TITLE_MAX_CHARS)
  ) {
    return errorResponse('INVALID_REQUEST', 'The downloader request is invalid.', { status: 400 });
  }

  // 2. Bounded per-identity rate limit BEFORE any upstream/db work.
  const rateVerdict = checkRateLimit('downloaderJson', clientIdentity(request.headers, locals.user?.id));
  if (!rateVerdict.allowed) {
    return json(
      { ok: false, error: { code: RATE_LIMITED_ERROR_CODE, message: RATE_LIMITED_MESSAGE } },
      { status: 429, headers: { 'cache-control': 'no-store', 'retry-after': String(rateVerdict.retryAfterSeconds) } },
    );
  }

  // 3. Load the ENABLED provider from the downloader registry.
  let provider;
  try {
    provider = await loadJsonDownloadProvider(locals.supabase, providerId);
  } catch (error) {
    console.warn('[JsonDownloader] registry lookup failed', error);
    return errorResponse('DOWNLOADER_UNAVAILABLE', 'The downloader is temporarily unavailable.', { status: 503 });
  }
  if (!provider) {
    return errorResponse('NOT_FOUND', 'This downloader is not available.', { status: 404 });
  }

  // 4. Adult Mode guard at the server boundary — BEFORE any upstream fetch.
  // Its non-disclosing 404 must never be swallowed by a downstream 503
  // catch, so it runs outside the resolution try below.
  const guardType: ContentType = isContentType(contentTypeParam) ? contentTypeParam : mediaType === 'tv' ? 'series' : 'movie';
  await assertAdultDownloadAllowed(locals.supabase, locals.user, cookies, guardType, downloaderContentId(guardType, tmdbId));

  // 5. Resolve: verify type=json + capability, build the URL from the
  //    registry template, fetch SSRF-safe, normalize. Only the sanitized
  //    link payload is returned.
  try {
    const outcome = await resolveJsonDownloadLinks(provider, {
      mediaType,
      tmdbId,
      ...(titleParam ? { title: titleParam } : {}),
      ...(season !== undefined ? { season } : {}),
      ...(episode !== undefined ? { episode } : {}),
    });
    switch (outcome.status) {
      case 'ok':
        return json({ ok: true, links: outcome.links }, { headers: NO_STORE });
      case 'upstream-error':
        return errorResponse('DOWNLOADER_UPSTREAM', 'The downloader source is temporarily unavailable.', { status: 502 });
      case 'unavailable':
        return errorResponse('DOWNLOADER_UNAVAILABLE', 'The downloader is temporarily unavailable.', { status: 503 });
      case 'failed':
        // not-found / not-json / not-capable / url-not-buildable — one
        // generic non-disclosing 404 for every reason.
        return errorResponse('NOT_FOUND', 'This downloader is not available for this title.', { status: 404 });
    }
  } catch (error) {
    console.warn('[JsonDownloader] resolution failed', error);
    return errorResponse('DOWNLOADER_UNAVAILABLE', 'The downloader is temporarily unavailable.', { status: 503 });
  }
};
