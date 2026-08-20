import { discover } from './service';
import { toMediaItem } from './presenter';
import type { ContentType } from './types';
import type { MediaItem } from '$data/content';

type RailResult = { items: MediaItem[]; error?: string };

async function loadRail(type: ContentType): Promise<RailResult> {
  try {
    const result = await discover(type, 1);
    if (result.source.provider === 'fixtures') {
      return { items: [], error: `${type === 'anime' ? 'Anime' : type === 'movie' ? 'Movie' : 'Series'} catalog is temporarily unavailable.` };
    }
    return { items: result.items.map(toMediaItem) };
  } catch {
    return { items: [], error: `${type === 'anime' ? 'Anime' : type === 'movie' ? 'Movie' : 'Series'} catalog is temporarily unavailable.` };
  }
}

export async function loadCollectionData(type: ContentType) {
  const rail = await loadRail(type);
  return { items: rail.items, type, errorMessage: rail.error };
}

export async function loadDiscoverData() {
  const [movieRail, seriesRail, animeRail] = await Promise.all([loadRail('movie'), loadRail('series'), loadRail('anime')]);
  const movies = movieRail.items;
  const series = seriesRail.items;
  const anime = animeRail.items;
  const errors = [movieRail.error, seriesRail.error, animeRail.error].filter(Boolean);
  return {
    movies,
    series,
    anime,
    featured: movies[0] ?? series[0] ?? anime[0],
    errorMessage: errors.length ? `${errors.join(' ')} Check the server catalog configuration and try again.` : undefined
  };
}
