import { json } from '@sveltejs/kit';
import { getAnimeSeason, getSeriesSeason, getDetail } from '$lib/server/content/service';
import { contentErrorResponse } from '$lib/server/content/response';
import { isValidContentId } from '$lib/server/content/types';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ params }) => {
  const season = Number(params.season);
  if (!isValidContentId(params.id) || !Number.isInteger(season) || season < 0 || season > 99) {
    return json({ ok: false, error: { code: 'INVALID_SEASON', message: 'Unsupported series season.' } }, { status: 400 });
  }
  try {
    // Phase 7F+ (anime routing): if the ID is an anime ID (starts with
    // 'anime-'), fetch the episode guide via Jikan (MyAnimeList API).
    // This handles both /anime/ route content (type='anime') and
    // TMDB-tagged anime series (type='series', isAnime=true) that
    // are displayed via the /series/ route but need anime episode data.
    if (params.id.startsWith('anime-')) {
      // Load the full item to get externalIds.mal and episodes count.
      const item = await getDetail('anime', params.id);
      const result = await getAnimeSeason(item, season);
      return json({ ok: true, season: result });
    }
    const result = await getSeriesSeason(params.id, season);
    return json({ ok: true, season: result });
  } catch (error) {
    return contentErrorResponse(error);
  }
};
