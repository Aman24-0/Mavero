import { error } from '@sveltejs/kit';
import { getDetail } from '$lib/server/content/service';
import { toMediaItem } from '$lib/server/content/presenter';
import { canAccessAdultContent } from '$lib/server/content/adult-policy';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params, locals, cookies }) => {
  try {
    const detail = await getDetail('series', params.id);

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
