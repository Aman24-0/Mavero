import { error } from '@sveltejs/kit';
import { getDetailWithSafeRecommendations } from '$lib/server/content/service';
import { toMediaItem } from '$lib/server/content/presenter';
import { canAccessAdultContent } from '$lib/server/content/adult-policy';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params, locals, cookies }) => {
  try {
    // Phase 6: consumer detail path — recommendations of non-adult parents
    // are classified through the ONE central classifier and adult/uncertain
    // recs are dropped (a normal surface stays adult-free regardless of
    // Adult Mode state). Adult parents keep their recs (Adult-specific
    // surface, reachable only after the guard below).
    const detail = await getDetailWithSafeRecommendations('series', params.id);

    // Phase 10: SSR adult content guard.
    if (detail.tags?.includes('Adult')) {
      const { user } = await locals.safeGetSession();
      const canAccess = await canAccessAdultContent(locals.supabase, user, cookies);
      if (!canAccess) {
        throw error(404, 'Series not found');
      }
    }

    return { item: toMediaItem(detail), recommendations: (detail.recommendations ?? []).map(toMediaItem) };
  } catch {
    throw error(404, 'Series not found');
  }
};
