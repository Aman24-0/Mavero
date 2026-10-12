/**
 * Shared canonical-URL policy (Player V2 remaining fixes + technical SEO
 * remediation, 2026-10).
 *
 * ROOT CAUSE FIXED: every canonical / og:url / sitemap location was derived
 * from the REQUEST's origin (`page.url.origin` / `url.origin`). Netlify
 * serves the app on BOTH the production domain (maveroweb.space) and
 * deployment subdomains, and a forged Host header reaches SSR unchanged —
 * so canonical URLs were request-dependent and self-referencing at whatever
 * host served the request (verified live: production robots.txt even pointed
 * its sitemap line at the old netlify host).
 *
 * POLICY (single source of truth):
 *   * Every canonical URL, og:url and sitemap <loc> uses this constant as
 *     the HOST. The request can contribute the PATHNAME only.
 *   * `/` and `/discover` render the same Discover experience; `/discover`
 *     is a deliberate duplicate of the homepage and canonicalizes to `/`
 *     (the bare production origin). `/discover` is therefore EXCLUDED from
 *     the sitemap and is NOT redirected (AppShell's brand lockup, empty
 *     states and back-destination deep links navigate to it directly).
 *   * Collection pages (/movies, /tv-shows, /anime) and detail pages
 *     canonicalize to their OWN production pathname (they are distinct
 *     public pages, and the sitemap lists the collections).
 *   * Detail-page sitemap entries: the production catalog is a live TMDB
 *     pass-through (no local table of catalogued titles), so there is NO
 *     reliable production source from which to enumerate detail URLs — the
 *     sitemap ships the verified static public pages only and says so.
 */

/** The ONLY host canonical URLs may carry. */
export const PRODUCTION_ORIGIN = 'https://maveroweb.space';

/**
 * Canonical URL for a site-relative pathname. The pathname is bounded to
 * site-absolute form; any query/hash suffix is stripped — canonicals never
 * carry request parameters.
 */
export function canonicalHref(pathname: string): string {
  const path = pathname.startsWith('/') ? pathname : `/${pathname}`;
  const clean = path.split(/[?#]/, 1)[0] || '/';
  return `${PRODUCTION_ORIGIN}${clean === '/' ? '' : clean}`;
}
