import { json } from '@sveltejs/kit';
import { getTmdbIndiaProviders, providerLogoUrl } from '$lib/server/content/adapters/tmdb';
import { contentErrorResponse } from '$lib/server/content/response';
import type { RequestHandler } from './$types';

// Returns the curated India OTT provider list (with TMDB logo URLs)
// for the Discover "New on OTT" dropdown. The list is built from real
// TMDB provider metadata (/watch/providers/{movie,tv}?watch_region=IN)
// — never from random Google favicons.
//
// Cache: 30 min TTL + 2 h SWR (ottProviderPolicy in tmdb.ts).
// Auth: public.

export const GET: RequestHandler = async () => {
  try {
    const providers = await getTmdbIndiaProviders();
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
