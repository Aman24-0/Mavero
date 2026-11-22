import { loadExplorerData } from '$lib/server/content/explorer-load';
import { PUBLIC_CATALOG_CACHE } from '$lib/server/http/cache-headers';
import type { PageServerLoad } from './$types';

// MAVERO — Anime Explorer (Explorer redesign).
//
// Phase 1 made /anime a first-class route (moved from /discover/anime;
// the old path is a permanent compatibility redirect). The /anime/[id]
// detail route is untouched and keeps working — SvelteKit allows the
// index page and the [id] child to coexist. The Explorer redesign now
// serves the dedicated Explorer experience (spotlight carousel +
// genre/language chips + Popular/Top Rated sections, or the filtered
// progressive feed) via loadExplorerData, which composes ONLY the
// existing cached TMDB loaders (no duplicate backend fetching).
// URL contract: ?genre=<name>&language=<code> (closed, validated
// per-type taxonomies — the anime language row honestly offers
// All + Japanese only: the app's anime classifier is genre 16 +
// original_language 'ja', so no other language code is truthful).
//
// Performance pass (Phase 1.2): CDN cache — see /movies for rationale.
export const load: PageServerLoad = async ({ url, setHeaders }) => {
  setHeaders({ 'cache-control': PUBLIC_CATALOG_CACHE });
  return loadExplorerData('anime', url);
};
