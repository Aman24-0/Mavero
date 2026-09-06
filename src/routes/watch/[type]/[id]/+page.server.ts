import { error } from '@sveltejs/kit';
import { getDetail, getSeriesSeason } from '$lib/server/content/service';
import { getPublicStreamingConfig } from '$lib/server/streaming/public-config';
import { toMediaItem } from '$lib/server/content/presenter';
import { isContentType } from '$lib/server/content/types';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params, locals, url }) => {
  if (!isContentType(params.type)) throw error(404, 'Unsupported content type');
  try {
    // Anime content is now backed by TMDB TV. getDetail('anime', id) maps
    // internally to the TMDB /tv/{id} endpoint and returns an item with
    // type='series' + isAnime=true (when genre 16 + 'ja' match).
    const item = await getDetail(params.type, params.id);
    let episodes = item.seasonsData?.flatMap((season) => season.episodes ?? []) ?? [];
    // For series AND anime series, fetch the explicit season episode list
    // via TMDB. Anime movies (animeFormat === 'movie') have no episode
    // guide — the player just plays the movie file.
    const isSeriesLike = params.type === 'series'
      || (item.isAnime === true && item.animeFormat !== 'movie')
      || params.type === 'anime';
    if (isSeriesLike) {
      const seasonNumber = Number(url.searchParams.get('season') || '') || 1;
      try {
        const season = await getSeriesSeason(params.id, seasonNumber);
        episodes = season.episodes ?? episodes;
      } catch {
        // Episode navigation stays optional when the provider cannot load a season.
      }
    }
    let streamingConfig;
    try {
      streamingConfig = await getPublicStreamingConfig(locals.supabase);
    } catch {
      streamingConfig = { version: 1, updatedAt: new Date(0).toISOString(), providers: [], sources: [], categories: [], sourceCategories: [], defaults: {} };
    }
    return { item: toMediaItem(item), streamingConfig, episodes };
  } catch {
    throw error(404, 'Title not found');
  }
};
