import { loadDiscoverData } from '$lib/server/content/discover-load';
import { PUBLIC_CATALOG_CACHE } from '$lib/server/http/cache-headers';
import type { PageServerLoad } from './$types';

// Performance pass (Phase 1.2): the Discover page payload is user-state-free
// (no per-user data, no Adult Mode dimension — TMDB's include_adult=false is
// enforced at the adapter layer). A short CDN cache window eliminates repeat
// upstream TMDB calls on every navigation. The server-side content cache
// (in-memory, 45 s TTL + 150 s SWR) is preserved; this HTTP header lets the
// Netlify edge CDN serve the cached SSR HTML directly, bypassing the function
// invocation entirely on repeated navigations.
export const load: PageServerLoad = async ({ setHeaders }) => {
  setHeaders({ 'cache-control': PUBLIC_CATALOG_CACHE });
  return loadDiscoverData();
};
