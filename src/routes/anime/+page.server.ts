import { loadCollectionData } from '$lib/server/content/discover-load';
import type { PageServerLoad } from './$types';

// Navigation & Settings Redesign, Phase 1 — /anime is the canonical anime
// destination (moved from /discover/anime; the old path is a permanent
// compatibility redirect). The /anime/[id] detail route is untouched and
// keeps working — SvelteKit allows the index page and the [id] child to
// coexist. Reuses the shared collection loader — no duplicate backend
// fetching, caching or pagination logic.
export const load: PageServerLoad = async ({ url }) => loadCollectionData('anime', url);
