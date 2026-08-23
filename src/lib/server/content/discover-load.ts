import { collection, discover, popular, selectFeatured } from './service';
import { toMediaItem } from './presenter';
import type { CollectionFilters, CollectionSort, ContentType, ContentList } from './types';
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

const validCollectionSorts: CollectionSort[] = ['For you', 'Top rated', 'Newest'];

function parseCollectionPage(value: string | null) {
  const page = Number(value);
  return Number.isInteger(page) && page >= 1 && page <= 20 ? page : 1;
}

function parseCollectionFilters(url: URL): CollectionFilters {
  const genre = url.searchParams.get('genre')?.trim() || undefined;
  const yearValue = url.searchParams.get('year')?.trim() || undefined;
  const year = yearValue && /^\d{4}$/.test(yearValue) ? yearValue : undefined;
  const sortValue = url.searchParams.get('sort')?.trim();
  const sort = validCollectionSorts.includes(sortValue as CollectionSort) ? sortValue as CollectionSort : undefined;
  return { genre, year, sort };
}

export async function loadCollectionData(type: ContentType, url: URL) {
  const page = parseCollectionPage(url.searchParams.get('page'));
  const filters = parseCollectionFilters(url);
  try {
    const result = await collection(type, page, filters);
    if (result.source.provider === 'fixtures') {
      return { items: [], type, page: result.page, hasNextPage: false, filters, errorMessage: `${type === 'anime' ? 'Anime' : type === 'movie' ? 'Movie' : 'Series'} catalog is temporarily unavailable.` };
    }
    return { items: result.items.map(toMediaItem), type, page: result.page, hasNextPage: result.hasNextPage, filters, errorMessage: undefined };
  } catch {
    return { items: [], type, page, hasNextPage: false, filters, errorMessage: `${type === 'anime' ? 'Anime' : type === 'movie' ? 'Movie' : 'Series'} catalog is temporarily unavailable.` };
  }
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
    featured: selectFeatured([...trendingMovies.items, ...trendingSeries.items, ...trendingAnime.items]),
    errorMessage: errors.length ? `${[...new Set(errors)].join(' ')} Check the server catalog configuration and try again.` : undefined
  };
}
