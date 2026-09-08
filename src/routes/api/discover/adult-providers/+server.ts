import { json } from '@sveltejs/kit';
import { getVerifiedAdultNetworkOptions } from '$lib/server/content/adult-networks';
import { providerLogoUrl } from '$lib/server/content/adapters/tmdb';
import { canAccessAdultContent } from '$lib/server/content/adult-policy';
import type { RequestHandler } from './$types';

// Returns the VERIFIED Adult network list for the authorized "Indian Adult
// Shows" provider dropdown (post-release fix).
//
// Source of truth: the central adult TV NETWORK registry
// (adult-networks.ts) — the SAME verified registry the classifier and the
// Adult catalog queries use. Only VERIFIED entries (live-confirmed TMDB
// network id > 0) are returned; unverified candidates are structurally
// excluded and never exposed. Logos are the registry's captured TMDB
// network logo paths served through the SAME image CDN convention as
// provider logos (image.tmdb.org) — no arbitrary remote hosts, no
// fabricated ids.
//
// The keys returned here are exactly the values the closed-union
// `provider` parameter of /api/content/adult-discover accepts (plus
// 'all') — the client can only ever echo back a verified key, and the
// server re-validates it per request.
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
  const providers = getVerifiedAdultNetworkOptions();
  return json({
    ok: true,
    providers: providers.map((p) => ({
      key: p.key,
      name: p.name,
      logoUrl: providerLogoUrl(p.logoPath)
    }))
  });
};
