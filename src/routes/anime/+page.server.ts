import { loadDestinationData } from '$lib/server/content/discover-load';
import type { PageServerLoad } from './$types';

// Navigation & Settings Redesign, Phase 1 — /anime is the canonical anime
// destination (moved from /discover/anime; the old path is a permanent
// compatibility redirect). The /anime/[id] detail route is untouched and
// keeps working — SvelteKit allows the index page and the [id] child to
// coexist. Phase 4 — the route now serves the rich cinematic destination
// page (hero + rails + full collection) via loadDestinationData, which
// composes ONLY the existing cached TMDB loaders (no duplicate backend
// fetching).
export const load: PageServerLoad = async ({ url }) => loadDestinationData('anime', url);
