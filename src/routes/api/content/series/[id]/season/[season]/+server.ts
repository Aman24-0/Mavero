import { json } from '@sveltejs/kit';
import { getDetail, getSeriesSeason } from '$lib/server/content/service';
import { contentErrorResponse } from '$lib/server/content/response';
import { isValidContentId } from '$lib/server/content/types';
import { canAccessAdultContent } from '$lib/server/content/adult-policy';
import { detailVerdict } from '$lib/server/content/search-classify';
import type { RequestHandler } from './$types';

// Phase 6 — season episode data is PROTECTED content.
//
// The season endpoint returns episode metadata for any TMDB TV id. Without
// a guard it is a direct bypass of the watch-page guard (an adult title's
// episodes could be fetched without ever opening /watch/...). The parent
// title is classified by the ONE central classifier (getDetail -> central
// isAdultContent over networks/providers/adult/isAnime) and the CURRENT
// REQUEST's authorization is evaluated with the Phase 5 policy function —
// per request, never cached, never client-controlled.
//
// Fail-closed contract: for TMDB-backed ids a FAILED parent classification
// is 'uncertain' — the request is answered with the same non-disclosing 404
// as forbidden content, never with unclassified episode data. Fixture ids
// (the static fallback catalog, which contains no adult titles) skip the
// TMDB classification and stay available — legitimate availability is
// preserved for clearly non-adult content.
export const GET: RequestHandler = async ({ params, locals, cookies }) => {
  const season = Number(params.season);
  if (!isValidContentId(params.id) || !Number.isInteger(season) || season < 0 || season > 99) {
    return json({ ok: false, error: { code: 'INVALID_SEASON', message: 'Unsupported series season.' } }, { status: 400 });
  }

  // Parent classification guard (TMDB-backed ids only; fixtures are the
  // static normal-content fallback and need no classification).
  const cleanId = params.id.replace(/^(series|anime)-/, '');
  if (/^\d+$/.test(cleanId)) {
    try {
      const parentType = params.id.startsWith('anime-') ? 'anime' : 'series';
      const parent = await getDetail(parentType, params.id);
      if (detailVerdict(parent.tags) === 'adult') {
        const { user } = await locals.safeGetSession();
        const canAccess = await canAccessAdultContent(locals.supabase, user, cookies);
        if (!canAccess) {
          // Non-disclosing: identical to a season whose series does not
          // exist — no title, no Adult classification, no episode data.
          return json({ ok: false, error: { code: 'NOT_FOUND', message: 'The requested season could not be found.' } }, { status: 404 });
        }
      }
    } catch {
      // Fail-closed: the parent could not be classified (upstream failure)
      // -> the episode data is not served. Same non-disclosing 404.
      return json({ ok: false, error: { code: 'NOT_FOUND', message: 'The requested season could not be found.' } }, { status: 404 });
    }
  }

  try {
    // All content IDs (series-*, anime-*) now resolve via the TMDB TV season
    // endpoint. getSeriesSeason strips both 'series-' and 'anime-' prefixes
    // and queries /tv/{tmdbId}/season/{n}. Anime is no longer routed
    // through a separate Jikan-based episode guide.
    const result = await getSeriesSeason(params.id, season);
    return json({ ok: true, season: result });
  } catch (error) {
    return contentErrorResponse(error);
  }
};
