import { canonicalHref } from '$lib/shared/seo';
import type { RequestHandler } from './$types';

// Technical SEO remediation (Player V2 remaining fixes, 2026-10):
//
// ROOT CAUSES FIXED (verified live against production 2026-10-13):
//   1. The sitemap imported the FIXTURE catalog (`$lib/data/content`) and
//      emitted every demo entry (afterlight, the-last-signal, emberline, …)
//      as an indexable detail URL — the live production sitemap carried ten
//      sample titles that are not the production catalog.
//   2. Locations were built from `url.origin` — the REQUEST's host. Netlify
//      serves the same build from the production domain AND deployment
//      subdomains, so the emitted host followed whatever host served the
//      request (and a forged Host header would self-canonicalize).
//   3. `/discover` was listed although the DiscoverPage canonicalizes
//      `/discover` to the homepage (`/`) — a sitemap entry that tells
//      search engines "index this" while the page itself declares "I am a
//      duplicate of /".
//   4. The homepage `/` itself was missing.
//
// POLICY NOW (see $lib/shared/seo.ts):
//   * One fixed production origin for every <loc> — the request can never
//     influence the emitted host.
//   * ONLY verified, public, canonical, indexable pages: the homepage and
//     the three first-class collection destinations. The legacy
//     /discover/{movies,series,anime} child pages are permanent 308
//     redirects and must never appear.
//   * `/discover` is a deliberate duplicate of `/` (its canonical points
//     there) — excluded from the sitemap.
//   * DETAIL PAGES: the production catalog is a live TMDB pass-through with
//     no local table of catalogued titles, so there is NO reliable
//     production source from which to enumerate detail URLs. Rather than
//     invent a catalog, expose private data or guess media records, the
//     sitemap ships the verified static public pages only. Known limitation
//     (documented in the remediation report): dynamic detail URLs are
//     discovered by crawling, not by this sitemap.
//   * XML escaping + dedup are retained from the previous implementation.

const escapeXml = (value: string) => value.replace(/[<>&'\"]/g, (character) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[character] ?? character);

export const GET: RequestHandler = () => {
  const paths = new Set(['/', '/movies', '/tv-shows', '/anime']);
  const body = [...paths].map((path) => `  <url><loc>${escapeXml(canonicalHref(path))}</loc></url>`).join('\n');
  return new Response(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>`, { headers: { 'content-type': 'application/xml; charset=utf-8', 'cache-control': 'public, max-age=3600, stale-while-revalidate=86400' } });
};
