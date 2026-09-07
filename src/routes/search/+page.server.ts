import { search } from '$lib/server/content/service';
import { toMediaItem } from '$lib/server/content/presenter';
import { ContentServiceError, isContentType, type ContentType } from '$lib/server/content/types';
import { canAccessAdultContent } from '$lib/server/content/adult-policy';
import type { MediaItem } from '$data/content';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ url, locals, cookies }) => {
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
    // Phase 4: SSR/API parity — the SSR search page evaluates the SAME
    // server-side adult policy as /api/content/search and passes the
    // decision down, so authorized users see consistent results on both
    // paths. Classification + filtering still happen server-side in the
    // content layer; the client is never trusted.
    const { user } = await locals.safeGetSession();
    const canAccessAdult = await canAccessAdultContent(locals.supabase, user, cookies);
    const result = await search(query, type, 1, {}, canAccessAdult);
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
