import { json } from '@sveltejs/kit';
import { search } from '$lib/server/content/service';
import { contentErrorResponse } from '$lib/server/content/response';
import { isContentType, type SearchFilters, type SearchSort } from '$lib/server/content/types';
import { canAccessAdultContent } from '$lib/server/content/adult-policy';
import { RATE_LIMITED_ERROR_CODE, RATE_LIMITED_MESSAGE, checkRateLimit, clientIdentity } from '$lib/server/http/rate-limit';
import { recordServerEvent } from '$lib/server/analytics/ingest';
import { createSupabaseAdminClient } from '$lib/server/supabase/admin';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ url, request, locals, cookies }) => {
  const query = url.searchParams.get('q')?.trim() ?? '';
  const typeParam = url.searchParams.get('type');
  const type = isContentType(typeParam) ? typeParam : undefined;
  const page = Math.max(1, Math.min(Number(url.searchParams.get('page') ?? 1) || 1, 20));
  const sortValue = url.searchParams.get('sort');
  const filters: SearchFilters = {
    ott: url.searchParams.get('ott') || undefined,
    genre: url.searchParams.get('genre') || undefined,
    sort: sortValue === 'release-asc' || sortValue === 'release-desc' ? sortValue as SearchSort : undefined
  };

  if (query.length > 120) {
    return json({ ok: false, error: { code: 'INVALID_QUERY', message: 'Search query is too long.' } }, { status: 400 });
  }

  // Phase 1 (audit SEC-003): bounded per-identity rate limit — search drives
  // TMDB classification work per query.
  const rateVerdict = checkRateLimit('search', clientIdentity(request.headers, locals.user?.id));
  if (!rateVerdict.allowed) {
    return json({ ok: false, error: { code: RATE_LIMITED_ERROR_CODE, message: RATE_LIMITED_MESSAGE } }, { status: 429, headers: { 'retry-after': String(rateVerdict.retryAfterSeconds) } });
  }

  // Phase 2-A (audit PERF-001): the server hook already resolved auth and
  // stored the result on `locals.user`. Reading it directly avoids a second
  // Supabase Auth network roundtrip (getSession + getUser) on every search.
  // Safe because: identity is the only input needed here — `canAccessAdultContent`
  // re-evaluates the per-request policy from the verified user + cookie, and
  // never trusts a client-supplied flag.
  const user = locals.user;
  const canAccessAdult = await canAccessAdultContent(locals.supabase, user, cookies);

  try {
    const result = await search(query, type, page, filters, canAccessAdult);

    // Phase 1 Analytics Foundation — server-authoritative `search` event.
    // Only meaningful searches (non-empty query, successful response) are
    // recorded. The event is emitted fire-and-forget with a bounded timeout;
    // failures are logged but never break the search response. anonymous_id
    // is taken from the server-issued cookie (locals.anonymousId); user_id
    // from locals.user. Both are server-derived — never client-supplied.
    if (query.length > 0 && locals.anonymousId) {
      try {
        const admin = createSupabaseAdminClient();
        void recordServerEvent(
          admin,
          {
            event_id: crypto.randomUUID(),
            event_name: 'search',
            anonymous_id: locals.anonymousId,
            user_id: user?.id ?? null,
            metadata: {
              query: query.slice(0, 120),
              type: type ?? null,
              page,
              result_count: result?.items?.length ?? 0,
              has_next_page: result?.hasNextPage ?? false,
            },
          },
          { requestId: locals.requestId }
        );
      } catch {
        // Analytics must not break search — silently ignore.
      }
    }

    return json({ ok: true, ...result });
  } catch (error) {
    return contentErrorResponse(error);
  }
};
