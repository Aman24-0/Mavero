import { loadExplorerData } from '$lib/server/content/explorer-load';
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
export const load: PageServerLoad = async ({ url }) => loadExplorerData('movie', url);
