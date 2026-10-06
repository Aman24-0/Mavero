import { loadDestinationData } from '$lib/server/content/discover-load';
import type { PageServerLoad } from './$types';

// Navigation & Settings Redesign, Phase 1 — /tv-shows is the canonical
// TV-first destination (moved from /discover/series; the old path is a
// permanent compatibility redirect). Phase 4 — the route now serves the
// rich cinematic destination page (hero + rails + full collection) via
// loadDestinationData, which composes ONLY the existing cached TMDB
// loaders (no duplicate backend fetching).
export const load: PageServerLoad = async ({ url }) => loadDestinationData('series', url);
