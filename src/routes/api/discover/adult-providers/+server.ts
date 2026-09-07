import { json } from '@sveltejs/kit';
import { getVerifiedAdultProviders } from '$lib/server/content/adapters/tmdb';
import { providerLogoUrl } from '$lib/server/content/adapters/tmdb';
import { canAccessAdultContent } from '$lib/server/content/adult-policy';
import type { RequestHandler } from './$types';

// Returns the verified adult OTT provider list for the Indian Adult Shows
// dropdown. Only providers that have been verified against the live TMDB
// India provider catalog are returned — no fabricated IDs.
//
// Adult enforcement: this endpoint checks the central adult policy BEFORE
// returning provider data. If the user is not authorized for adult content,
// it returns an empty list (non-disclosing).

export const GET: RequestHandler = async ({ locals, cookies }) => {
  const { user } = await locals.safeGetSession();
  const canAccess = await canAccessAdultContent(locals.supabase, user, cookies);
  if (!canAccess) {
    return json({ ok: true, providers: [] });
  }
  const providers = await getVerifiedAdultProviders();
  return json({
    ok: true,
    providers: providers.map((p) => ({
      key: p.key,
      name: p.name,
      tmdbProviderId: p.tmdbProviderId,
      logoUrl: providerLogoUrl(p.logoPath)
    }))
  });
};
