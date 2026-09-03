import { search, discover, popular, selectFeatured } from '$lib/server/content/service';
import { toMediaItem } from '$lib/server/content/presenter';
import { ContentServiceError, isContentType, type ContentType, type SearchFilters, type SearchSort } from '$lib/server/content/types';
import type { MediaItem } from '$data/content';
import type { PageServerLoad } from './$types';

type DiscoveryPayload = {
  featured: MediaItem | undefined;
  trendingMovies: MediaItem[];
  trendingSeries: MediaItem[];
  trendingAnime: MediaItem[];
  popularMovies: MediaItem[];
  popularSeries: MediaItem[];
};

async function safeRail(loader: () => Promise<{ items: import('$lib/server/content/types').NormalizedMediaItem[]; source: { provider: string } }>): Promise<MediaItem[]> {
  try {
    const result = await loader();
    if (result.source.provider === 'fixtures') return [];
    return result.items.map(toMediaItem);
  } catch {
    return [];
  }
}

export const load: PageServerLoad = async ({ url }) => {
  const query = url.searchParams.get('q')?.trim() ?? '';
  const typeValue = url.searchParams.get('type');
  const type = isContentType(typeValue) ? typeValue : undefined;
  const sortValue = url.searchParams.get('sort');
  const filters: SearchFilters = {
    ott: url.searchParams.get('ott') || undefined,
    genre: url.searchParams.get('genre') || undefined,
    sort: sortValue === 'release-asc' || sortValue === 'release-desc' ? sortValue as SearchSort : undefined
  };

  // Discovery rails shown when there is no active query. These reuse the
  // exact same loaders as Discover so the empty-search state never feels
  // like a dead end. Failures degrade to an empty array silently.
  const [trendingMovies, trendingSeries, trendingAnime, popularMovies, popularSeries] = await Promise.all([
    safeRail(() => discover('movie')),
    safeRail(() => discover('series')),
    safeRail(() => discover('anime')),
    safeRail(() => popular('movie')),
    safeRail(() => popular('series'))
  ]);
  // selectFeatured operates on NormalizedMediaItem; rebuild from raw rails.
  // We can re-derive a featured pick by selecting the first trending item
  // of any type — simple, real, no fake data.
  const featuredPick = trendingMovies[0] ?? trendingSeries[0] ?? trendingAnime[0] ?? undefined;

  const discovery: DiscoveryPayload = {
    featured: featuredPick,
    trendingMovies, trendingSeries, trendingAnime,
    popularMovies, popularSeries
  };

  if (!query) {
    return {
      query, type, filters,
      items: [] as MediaItem[],
      errorMessage: '',
      discovery
    };
  }

  try {
    const result = await search(query, type, 1, filters);
    return {
      query: result.query, type, filters,
      items: result.items.map(toMediaItem),
      errorMessage: '',
      discovery
    };
  } catch (error) {
    const errorMessage = error instanceof ContentServiceError
      ? error.message
      : 'Search is temporarily unavailable. Please try again.';
    return {
      query, type, filters,
      items: [] as MediaItem[],
      errorMessage,
      discovery
    };
  }
};
