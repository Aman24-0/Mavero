import { loadExplorerData } from '$lib/server/content/explorer-load';
import { PUBLIC_CATALOG_CACHE } from '$lib/server/http/cache-headers';
import type { PageServerLoad } from './$types';

// MAVERO — Movies Explorer (Explorer redesign).
//
// Phase 1 made /movies a first-class route (moved from /discover/movies;
// the old path is a permanent compatibility redirect). The Explorer
// redesign now serves the dedicated Explorer experience (spotlight
// carousel + genre/language chips + Popular/Top Rated sections, or the
// filtered progressive feed) via loadExplorerData, which composes ONLY
// the existing cached TMDB loaders (no duplicate backend fetching).
// URL contract: ?genre=<name>&language=<code> (closed, validated
// per-type taxonomies) — shareable, refresh-safe, server-validated.
//
// Performance pass (Phase 1.2): the unfiltered Explorer payload is
// user-state-free — a short CDN cache window lets the Netlify edge serve
// the cached SSR HTML directly. Filtered views (?genre=…&language=…)
// are also user-state-free (same catalog for everyone), so the same
// cache policy applies; the URL query string becomes the natural cache
// key at the edge.
export const load: PageServerLoad = async ({ url, setHeaders }) => {
  setHeaders({ 'cache-control': PUBLIC_CATALOG_CACHE });
  return loadExplorerData('movie', url);
};
