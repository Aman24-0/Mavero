import { search } from '$lib/server/content/service';
import { toMediaItem } from '$lib/server/content/presenter';
import { ContentServiceError, isContentType, type ContentType } from '$lib/server/content/types';
import type { MediaItem } from '$data/content';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ url }) => {
  const query = url.searchParams.get('q')?.trim() ?? '';
  const typeValue = url.searchParams.get('type');
  const type = isContentType(typeValue) ? typeValue : undefined;

  // Search has one purpose: find something. When there is no query we
  // return an empty result list — the page renders a focused empty-search
  // state. Discovery rails live on /discover and are not duplicated here.
  //
  // The Search page no longer surfaces service/genre/sort filter UI —
  // only `q` and `type` (movie | series) come from the page. The shared
  // /api/content/search endpoint still accepts the other filter params for
  // any future API consumers, but the page itself doesn't send them.
  if (!query) {
    return {
      query, type,
      items: [] as MediaItem[],
      errorMessage: ''
    };
  }

  try {
    const result = await search(query, type, 1);
    return {
      query: result.query, type,
      items: result.items.map(toMediaItem),
      errorMessage: ''
    };
  } catch (error) {
    const errorMessage = error instanceof ContentServiceError
      ? error.message
      : 'Search is temporarily unavailable. Please try again.';
    return {
      query, type,
      items: [] as MediaItem[],
      errorMessage
    };
  }
};
