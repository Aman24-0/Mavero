import { discover, popular } from './service';
import { toMediaItem } from './presenter';
import type { ContentType, ContentList } from './types';
import type { MediaItem } from '$data/content';

type RailResult = { items: MediaItem[]; error?: string };
type RailKind = 'trending' | 'popular';

async function loadRail(type: ContentType, kind: RailKind): Promise<RailResult> {
  try {
    const result: ContentList = kind === 'popular' ? await popular(type, 1) : await discover(type, 1);
    if (result.source.provider === 'fixtures') {
      return { items: [], error: `${type === 'anime' ? 'Anime' : type === 'movie' ? 'Movie' : 'Series'} catalog is temporarily unavailable.` };
    }
    return { items: result.items.map(toMediaItem) };
  } catch {
    return { items: [], error: `${type === 'anime' ? 'Anime' : type === 'movie' ? 'Movie' : 'Series'} catalog is temporarily unavailable.` };
  }
}

export async function loadCollectionData(type: ContentType) {
  const rail = await loadRail(type, 'trending');
  return { items: rail.items, type, errorMessage: rail.error };
}

export async function loadDiscoverData() {
  const [trendingMovies, trendingSeries, trendingAnime, popularMovies, popularSeries, popularAnime] = await Promise.all([
    loadRail('movie', 'trending'),
    loadRail('series', 'trending'),
    loadRail('anime', 'trending'),
    loadRail('movie', 'popular'),
    loadRail('series', 'popular'),
    loadRail('anime', 'popular')
  ]);
  const errors = [trendingMovies, trendingSeries, trendingAnime, popularMovies, popularSeries, popularAnime].flatMap((rail) => rail.error ? [rail.error] : []);
  return {
    movies: trendingMovies.items,
    series: trendingSeries.items,
    anime: trendingAnime.items,
    popularMovies: popularMovies.items,
    popularSeries: popularSeries.items,
    popularAnime: popularAnime.items,
    featured: trendingMovies.items[0] ?? trendingSeries.items[0] ?? trendingAnime.items[0],
    errorMessage: errors.length ? `${[...new Set(errors)].join(' ')} Check the server catalog configuration and try again.` : undefined
  };
}
