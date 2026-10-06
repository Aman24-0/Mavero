import { loadDestinationData } from '$lib/server/content/discover-load';
import type { PageServerLoad } from './$types';

// Navigation & Settings Redesign, Phase 1 — /movies is the canonical
// movie-first destination (moved from /discover/movies; the old path is a
// permanent compatibility redirect). Phase 4 — the route now serves the
// rich cinematic destination page (hero + rails + full collection) via
// loadDestinationData, which composes ONLY the existing cached TMDB
// loaders (no duplicate backend fetching).
export const load: PageServerLoad = async ({ url }) => loadDestinationData('movie', url);
