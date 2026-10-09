import { error } from '@sveltejs/kit';
import { getDetail } from '$lib/server/content/service';
import { toMediaItem } from '$lib/server/content/presenter';
import { canAccessAdultContent } from '$lib/server/content/adult-policy';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params, locals, cookies }) => {
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
    const detail = await getDetail('anime', params.id);

    // Phase 10: SSR adult content guard.
    if (detail.tags?.includes('Adult')) {
      // Phase 2-A: use hook-resolved locals.user (no second auth roundtrip).
      const user = locals.user;
      const canAccess = await canAccessAdultContent(locals.supabase, user, cookies);
      if (!canAccess) {
        throw error(404, 'Anime not found');
      }
    }

    // Recommendations load client-side (see above) — the server response
    // carries the parent only. toMediaItem maps an allowlist of card
    // fields, so the detail's raw embedded recommendation rows never
    // serialize into the page payload.
    return { item: toMediaItem(detail), recommendations: [] };
  } catch {
    throw error(404, 'Anime not found');
  }
};
