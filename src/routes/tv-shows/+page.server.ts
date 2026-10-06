import { loadCollectionData } from '$lib/server/content/discover-load';
import type { PageServerLoad } from './$types';

// Navigation & Settings Redesign, Phase 1 — /tv-shows is the canonical
// TV-first destination (moved from /discover/series; the old path is a
// permanent compatibility redirect). Reuses the shared collection loader —
// no duplicate backend fetching, caching or pagination logic.
export const load: PageServerLoad = async ({ url }) => loadCollectionData('series', url);
