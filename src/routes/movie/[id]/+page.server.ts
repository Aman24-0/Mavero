import { error, redirect } from '@sveltejs/kit';
import { getDetail } from '$lib/server/content/service';
import { toMediaItem } from '$lib/server/content/presenter';
import { canAccessAdultContent } from '$lib/server/content/adult-policy';
import { isValidTmdbId, isLegacyPrefixedId, extractTmdbId } from '$lib/shared/routes';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params, locals, cookies, setHeaders }) => {
  const { id } = params;

  // Phase 5: legacy prefixed ID (e.g. 'movie-278') → redirect to canonical
  // bare-ID form (/movie/278). This preserves backward compatibility with
  // any existing bookmarks, search-engine indexes, or internal links that
  // use the old prefixed form.
  if (isLegacyPrefixedId(id)) {
    const bareId = extractTmdbId(id);
    if (bareId) {
      throw redirect(308, `/movie/${bareId}`);
    }
  }

  // Phase 5: validate bare TMDB ID. Reject malformed IDs early.
  if (!isValidTmdbId(id)) {
    throw error(404, 'Movie not found');
  }

  // MAVP-5 (RC-7 — slow Back navigation from the player): the detail data
  // response carries a SHORT PRIVATE cache policy. The SvelteKit client
  // router honors it, so the history.back() navigation from the player
  // paints the detail page from the just-populated cache within the TTL
  // instead of re-executing this load (a serverless invocation + a possible
  // TMDB roundtrip) before every Back. TMDB detail data is effectively
  // static on a 60 s scale (the server-side content cache TTL is 30 min),
  // so freshness guarantees are unchanged; `private` keeps the payload out
  // of shared/CDN caches. The header is set on the SUCCESS path only
  // (directly before the return) so a thrown 404/adult-gate error response
  // is never cacheable.
  try {
    // MAV-20 Phase D — the page load fetches the PARENT detail only.
    //
    // The old load used getDetailWithSafeRecommendations, which runs the
    // per-recommendation classification N+1 (up to 6 cached detail
    // fetches) INLINE — every navigation to a detail page (including the
    // back-navigation from the player, the reported ~2-3s stall) waited
    // on it. The classified "You may also like" rail is now loaded
    // client-side after render through /api/content/recommendations,
    // which runs the EXACT same safety pipeline (the ONE central
    // classifier + the identical adult gate). The adult PARENT gate
    // below is unchanged — an unauthorized adult title still 404s at
    // the page level.
    const detail = await getDetail('movie', id);

    // Phase 10: SSR adult content guard.
    if (detail.tags?.includes('Adult')) {
      // Phase 2-A: use hook-resolved locals.user (no second auth roundtrip).
      const user = locals.user;
      const canAccess = await canAccessAdultContent(locals.supabase, user, cookies);
      if (!canAccess) {
        throw error(404, 'Movie not found');
      }
    }

    // Recommendations load client-side (see above) — the server response
    // carries the parent only. toMediaItem maps an allowlist of card
    // fields, so the detail's raw embedded recommendation rows never
    // serialize into the page payload.
    // MAVP-5 (RC-7): success-path-only cache policy (see the header comment).
    setHeaders({ 'cache-control': 'private, max-age=60' });
    return { item: toMediaItem(detail), recommendations: [] };
  } catch {
    throw error(404, 'Movie not found');
  }
};
