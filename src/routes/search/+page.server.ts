import { getFixtureContent, search } from '$lib/server/content/service';
import { toMediaItem } from '$lib/server/content/presenter';
import { ContentServiceError, isContentType, type ContentType } from '$lib/server/content/types';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ url }) => {
  const query = url.searchParams.get('q')?.trim() ?? '';
  const typeValue = url.searchParams.get('type');
  const type = isContentType(typeValue) ? typeValue : undefined;

  if (!query) {
    const types: ContentType[] = type ? [type] : ['movie', 'series', 'anime'];
    const items = types.flatMap((entry) => getFixtureContent(entry)).map(toMediaItem);
    return { query, type, items, errorMessage: '' };
  }

  try {
    const result = await search(query, type);
    return { query: result.query, type, items: result.items.map(toMediaItem), errorMessage: '' };
  } catch (error) {
    const errorMessage = error instanceof ContentServiceError
      ? error.message
      : 'Search is temporarily unavailable. Please try again.';
    return { query, type, items: [], errorMessage };
  }
};
