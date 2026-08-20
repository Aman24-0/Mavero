import { search } from '$lib/server/content/service';
import { toMediaItem } from '$lib/server/content/presenter';
import { ContentServiceError, isContentType, type ContentType, type SearchFilters, type SearchSort } from '$lib/server/content/types';
import type { PageServerLoad } from './$types';

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

  if (!query) return { query, type, filters, items: [], errorMessage: '' };

  try {
    const result = await search(query, type, 1, filters);
    return { query: result.query, type, filters, items: result.items.map(toMediaItem), errorMessage: '' };
  } catch (error) {
    const errorMessage = error instanceof ContentServiceError
      ? error.message
      : 'Search is temporarily unavailable. Please try again.';
    return { query, type, filters, items: [], errorMessage };
  }
};
