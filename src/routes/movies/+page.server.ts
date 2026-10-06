import { loadCollectionData } from '$lib/server/content/discover-load';
import type { PageServerLoad } from './$types';

// Navigation & Settings Redesign, Phase 1 — /movies is the canonical
// movie-first destination (moved from /discover/movies; the old path is a
// permanent compatibility redirect). Reuses the shared collection loader —
// no duplicate backend fetching, caching or pagination logic.
export const load: PageServerLoad = async ({ url }) => loadCollectionData('movie', url);
