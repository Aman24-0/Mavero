import { error, redirect } from '@sveltejs/kit';
import { getDetail } from '$lib/server/content/service';
import { toMediaItem } from '$lib/server/content/presenter';
import { canAccessAdultContent } from '$lib/server/content/adult-policy';
import { isValidTmdbId, isLegacyPrefixedId, extractTmdbId } from '$lib/shared/routes';
import type { PageServerLoad } from './$types';

/**
 * Phase 5 — TV Series detail route.
 *
 * Public route: /tv-show/1396
 * Legacy route: /series/series-1396 (redirected)
 *
 * Accepts a bare TMDB ID (e.g. '1396'). Legacy prefixed IDs (e.g.
 * 'series-1396') are redirected to the canonical bare-ID form.
 *
 * Internally calls getDetail('series', id) which strips the prefix
 * and queries the TMDB /tv/{id} endpoint.
 */
export const load: PageServerLoad = async ({ params, locals, cookies, setHeaders }) => {
  const { id } = params;

  // Legacy prefixed ID → redirect to canonical bare-ID form.
  if (isLegacyPrefixedId(id)) {
    const bareId = extractTmdbId(id);
    if (bareId) {
      throw redirect(308, `/tv-show/${bareId}`);
    }
  }

  // Validate bare TMDB ID.
  if (!isValidTmdbId(id)) {
    throw error(404, 'TV series not found');
  }

  try {
    // getDetail('series', id) strips the prefix (if any) and queries TMDB.
    // For bare IDs, it passes through as-is.
    const detail = await getDetail('series', id);

    if (detail.tags?.includes('Adult')) {
      const user = locals.user;
      const canAccess = await canAccessAdultContent(locals.supabase, user, cookies);
      if (!canAccess) throw error(404, 'TV series not found');
    }

    setHeaders({ 'cache-control': 'private, max-age=60' });
    return { item: toMediaItem(detail), recommendations: [] };
  } catch {
    throw error(404, 'TV series not found');
  }
};
