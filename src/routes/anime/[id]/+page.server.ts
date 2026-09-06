import { error } from '@sveltejs/kit';
import { getDetail } from '$lib/server/content/service';
import { toMediaItem } from '$lib/server/content/presenter';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params }) => {
  try {
    // Anime content now comes from TMDB TV. The /anime/{id} route is kept
    // for backward compatibility with deep links — getDetail('anime', id)
    // strips the optional 'anime-' / 'series-' prefix and queries the TMDB
    // /tv/{tmdbId} endpoint. The returned item has type='series' (so the
    // DetailPage renders with the canonical Series template) and
    // isAnime=true when genre 16 + 'ja' match (so the Anime badge is shown).
    const detail = await getDetail('anime', params.id);
    return { item: toMediaItem(detail), recommendations: (detail.recommendations ?? []).map(toMediaItem) };
  } catch {
    throw error(404, 'Anime not found');
  }
};
