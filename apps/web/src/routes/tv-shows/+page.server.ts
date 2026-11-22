import { loadExplorerData } from '$lib/server/content/explorer-load';
import { PUBLIC_CATALOG_CACHE } from '$lib/server/http/cache-headers';
import type { PageServerLoad } from './$types';

// MAVERO — TV Shows Explorer (Explorer redesign).
//
// Phase 1 made /tv-shows a first-class route (moved from /discover/series;
// the old path is a permanent compatibility redirect). The Explorer
// redesign now serves the dedicated Explorer experience (spotlight
// carousel + genre/language chips + Popular/Top Rated sections, or the
// filtered progressive feed) via loadExplorerData, which composes ONLY
// the existing cached TMDB loaders (no duplicate backend fetching).
// URL contract: ?genre=<name>&language=<code> (closed, validated
// per-type taxonomies) — shareable, refresh-safe, server-validated.
//
// Performance pass (Phase 1.2): CDN cache — see /movies for rationale.
export const load: PageServerLoad = async ({ url, setHeaders }) => {
  setHeaders({ 'cache-control': PUBLIC_CATALOG_CACHE });
  return loadExplorerData('series', url);
};
