import { error, redirect } from '@sveltejs/kit';
import { getDetail } from '$lib/server/content/service';
import { toMediaItem } from '$lib/server/content/presenter';
import { canAccessAdultContent } from '$lib/server/content/adult-policy';
import { isValidTmdbId, isLegacyPrefixedId, extractTmdbId } from '$lib/shared/routes';
import type { PageServerLoad } from './$types';

/**
 * Phase 5 — Anime Series detail route.
 *
 * Public route: /anime-series/30984
 * Legacy route: /anime/anime-30984 (redirected)
 *
 * Accepts a bare TMDB ID (e.g. '30984'). Legacy prefixed IDs (e.g.
 * 'anime-30984') are redirected to the canonical bare-ID form.
 *
 * Internally calls getDetail('anime', id) which strips the prefix,
 * queries the TMDB /tv/{id} endpoint, and sets isAnime=true based on
 * genre 16 + original_language 'ja'.
 */
export const load: PageServerLoad = async ({ params, locals, cookies, setHeaders }) => {
  const { id } = params;

  // Legacy prefixed ID → redirect to canonical bare-ID form.
  if (isLegacyPrefixedId(id)) {
    const bareId = extractTmdbId(id);
    if (bareId) {
      throw redirect(308, `/anime-series/${bareId}`);
    }
  }

  if (!isValidTmdbId(id)) {
    throw error(404, 'Anime series not found');
  }

  try {
    const detail = await getDetail('anime', id);

    if (detail.tags?.includes('Adult')) {
      const user = locals.user;
      const canAccess = await canAccessAdultContent(locals.supabase, user, cookies);
      if (!canAccess) throw error(404, 'Anime series not found');
    }

    setHeaders({ 'cache-control': 'private, max-age=60' });
    return { item: toMediaItem(detail), recommendations: [] };
  } catch {
    throw error(404, 'Anime series not found');
  }
};
