import { search } from '$lib/server/content/service';
import { toMediaItem } from '$lib/server/content/presenter';
import { ContentServiceError, isContentType, type ContentType } from '$lib/server/content/types';
import { canAccessAdultContent } from '$lib/server/content/adult-policy';
import { PRIVATE_SHORT_CACHE } from '$lib/server/http/cache-headers';
import type { MediaItem } from '$data/content';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ url, locals, cookies, setHeaders }) => {
  // Performance pass (Phase 1.2): the Search page evaluates per-request
  // adult policy (canAccessAdultContent), so the response varies by user.
  // PRIVATE_SHORT_CACHE lets the browser cache the result for a short
  // window (Back navigation is instant) without leaking user-scoped
  // results into a shared CDN cache.
  setHeaders({ 'cache-control': PRIVATE_SHORT_CACHE });
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
    //
    // Phase 2-A: use hook-resolved locals.user (no second auth roundtrip).
    // Production-hardening round: the policy decision is passed as a
    // PROMISE so the Supabase policy read runs CONCURRENTLY with the
    // search service's own warm-up (provider-cache) + TMDB roundtrips
    // instead of strictly before them — the search service awaits it at
    // the boundary where it is first needed. The decision is unchanged
    // (same fail-closed server-side policy); only the sequencing moved.
    const user = locals.user;
    const result = await search(
      query, type, 1, {},
      canAccessAdultContent(locals.supabase, user, cookies)
    );
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
