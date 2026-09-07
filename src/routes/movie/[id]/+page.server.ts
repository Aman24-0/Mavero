import { error } from '@sveltejs/kit';
import { getDetail } from '$lib/server/content/service';
import { toMediaItem } from '$lib/server/content/presenter';
import { canAccessAdultContent } from '$lib/server/content/adult-policy';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params, locals }) => {
  try {
    const detail = await getDetail('movie', params.id);

    // Phase 10: SSR adult content guard. If the resolved item is adult,
    // enforce the centralized policy before exposing it via SSR.
    if (detail.tags?.includes('Adult')) {
      const { user } = await locals.safeGetSession();
      const canAccess = await canAccessAdultContent(locals.supabase, user);
      if (!canAccess) {
        throw error(404, 'Movie not found');
      }
    }

    return { item: toMediaItem(detail), recommendations: (detail.recommendations ?? []).map(toMediaItem) };
  } catch {
    throw error(404, 'Movie not found');
  }
};
