import { json } from '@sveltejs/kit';
import { getTmdbIndiaProviders, providerLogoUrl } from '$lib/server/content/adapters/tmdb';
import { contentErrorResponse } from '$lib/server/content/response';
import { PUBLIC_CATALOG_CACHE } from '$lib/server/http/cache-headers';
import type { RequestHandler } from './$types';

// Returns the curated India OTT provider list (with TMDB logo URLs)
// for the Discover "New on OTT" dropdown. The list is built from real
// TMDB provider metadata (/watch/providers/{movie,tv}?watch_region=IN)
// — never from random Google favicons.
//
// Cache: 30 min TTL + 2 h SWR (ottProviderPolicy in tmdb.ts) at the
// adapter layer; the HTTP layer adds PUBLIC_CATALOG_CACHE so the CDN
// can serve the response across users.
// Auth: public — no user state, no Adult Mode dimension.

export const GET: RequestHandler = async ({ setHeaders }) => {
  try {
    const providers = await getTmdbIndiaProviders();
    // Phase 2-C: this response carries no user/adult dimension — safe to
    // cache publicly at the CDN. Short max-age keeps user-facing refresh
    // current; s-maxage serves from the CDN for 4 minutes, then SWR
    // refreshes in the background.
    setHeaders({ 'cache-control': PUBLIC_CATALOG_CACHE });
    return json({
      ok: true,
      providers: providers.map((p) => ({
        providerId: p.providerId,
        name: p.name,
        key: p.key,
        logoUrl: providerLogoUrl(p.logoPath)
      }))
    });
  } catch (error) {
    return contentErrorResponse(error);
  }
};
