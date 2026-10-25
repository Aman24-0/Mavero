import { error, redirect } from '@sveltejs/kit';
import { getDetail } from '$lib/server/content/service';
import { toMediaItem } from '$lib/server/content/presenter';
import { canAccessAdultContent } from '$lib/server/content/adult-policy';
import { isValidTmdbId } from '$lib/shared/routes';
import type { PageServerLoad } from './$types';

/**
 * Phase 5 — Anime Movie detail route.
 *
 * Public route: /anime-movie/1311031
 *
 * Accepts a bare TMDB ID. Anime movies are TMDB movie entries that are
 * classified as anime (genre 16 + original_language 'ja'). The TMDB
 * adapter sets isAnime=true + animeFormat='movie' for these titles.
 *
 * Internally calls getDetail('movie', id) — the SAME endpoint as regular
 * movies (/movie/{id}). The distinction between /movie/ and /anime-movie/
 * is a PUBLIC ROUTE convention only; both resolve to the same TMDB
 * /movie/{id} endpoint. The anime classification is determined by the
 * content's genres + original_language, NOT by the route.
 *
 * The /anime-movie/ route exists so that:
 *   1. Anime movies can be distinguished from regular movies in the URL
 *      (SEO + user clarity).
 *   2. The anime discover/explorer pages can link to /anime-movie/{id}
 *      instead of /movie/{id} for anime-classified movies.
 */
export const load: PageServerLoad = async ({ params, locals, cookies, setHeaders }) => {
  const { id } = params;

  if (!isValidTmdbId(id)) {
    throw error(404, 'Anime movie not found');
  }

  try {
    // Anime movies use the movie TMDB endpoint. The anime classification
    // (isAnime + animeFormat='movie') is determined by the TMDB adapter
    // from genre 16 + original_language 'ja' — NOT by this route.
    const detail = await getDetail('movie', id);

    if (detail.tags?.includes('Adult')) {
      const user = locals.user;
      const canAccess = await canAccessAdultContent(locals.supabase, user, cookies);
      if (!canAccess) throw error(404, 'Anime movie not found');
    }

    setHeaders({ 'cache-control': 'private, max-age=60' });
    return { item: toMediaItem(detail), recommendations: [] };
  } catch {
    throw error(404, 'Anime movie not found');
  }
};
