import type { RequestHandler } from './$types';

// ============================================================================
// MAV-22 — Same-origin artwork proxy for the Detail Page dynamic palette.
//
// WHY THIS EXISTS: the palette engine samples artwork pixels in a canvas,
// which requires CORS-readable bytes. The production artwork CDN
// (image.tmdb.org) serves images WITHOUT Access-Control-Allow-Origin, so
// a direct canvas read is impossible (tainted canvas). The <img> hero
// loads stay no-cors and direct — ONLY palette sampling goes through
// this proxy, same-origin, so getImageData is safe.
//
// SECURITY CONTRACT:
//   * STRICT allowlist — only the two artwork hosts the app already
//     renders: image.tmdb.org with a /t/p/ path (no query) and
//     images.unsplash.com (fixture/QA imagery). Every other URL is
//     rejected with 400 before any fetch — no open proxy, no SSRF.
//   * IMAGE-ONLY passthrough — the upstream response is forwarded only
//     when its content-type is image/*; anything else is a 502.
//   * BOUNDED — AbortController timeout, no credentials/cookies
//     forwarded, and a small in-process in-flight cap so a burst of
//     detail visits cannot fan out unbounded upstream requests
//     (excess → 503, retryable).
//   * CACHEABLE — immutable artwork (TMDB size-locked paths never
//     change) gets a long public TTL so each URL is fetched once per
//     client/CDN edge, not per detail visit.
// ============================================================================

const ALLOWED_HOSTS: ReadonlyMap<string, (pathname: string, search: string) => boolean> = new Map([
  // TMDB image CDN: size-locked path prefix, no query string.
  ['image.tmdb.org', (pathname, search) => pathname.startsWith('/t/p/') && search === ''],
  // Unsplash (fixture imagery used by the local QA fixtures).
  ['images.unsplash.com', (pathname) => pathname.length > 1]
]);

const UPSTREAM_TIMEOUT_MS = 8000;
const MAX_IN_FLIGHT = 8;

let inFlight = 0;

function validateTarget(rawUrl: string): URL | null {
  let target: URL;
  try {
    target = new URL(rawUrl);
  } catch {
    return null;
  }
  if (target.protocol !== 'https:') return null;
  const predicate = ALLOWED_HOSTS.get(target.host);
  if (!predicate) return null;
  if (!predicate(target.pathname, target.search)) return null;
  return target;
}

export const GET: RequestHandler = async ({ url }) => {
  const raw = url.searchParams.get('url');
  if (!raw) {
    return new Response('Missing artwork url', { status: 400 });
  }
  const target = validateTarget(raw);
  if (!target) {
    // Honest, non-disclosing rejection — the proxy serves nothing
    // outside the artwork allowlist.
    return new Response('Unsupported artwork url', { status: 400 });
  }

  if (inFlight >= MAX_IN_FLIGHT) {
    return new Response('Artwork proxy busy', { status: 503, headers: { 'retry-after': '2' } });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  inFlight += 1;

  try {
    const upstream = await fetch(target, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { accept: 'image/avif,image/webp,image/jpeg,image/png,*/*' }
    });

    const contentType = upstream.headers.get('content-type') ?? '';
    if (!upstream.ok || !contentType.startsWith('image/')) {
      return new Response('Artwork unavailable', { status: 502 });
    }

    const headers = new Headers({
      'content-type': contentType,
      // TMDB /t/p/ paths are immutable per size; Unsplash URLs carry the
      // transform params in the query (part of the cache identity).
      'cache-control': 'public, max-age=604800, stale-while-revalidate=86400'
    });
    const contentLength = upstream.headers.get('content-length');
    if (contentLength) headers.set('content-length', contentLength);

    return new Response(upstream.body, { status: 200, headers });
  } catch {
    return new Response('Artwork fetch failed', { status: 502 });
  } finally {
    clearTimeout(timeout);
    inFlight -= 1;
  }
};
