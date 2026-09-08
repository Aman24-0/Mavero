import { json } from '@sveltejs/kit';
import { adultDiscover } from '$lib/server/content/service';
import {
  ADULT_DISCOVER_PROVIDER_ALL,
  isAdultDiscoverLanguage,
  isAdultDiscoverProvider,
  isAdultDiscoverSort,
  isAdultDiscoverType,
  parseAdultDiscoverPage
} from '$lib/server/content/adult-discover';
import { toMediaItem } from '$lib/server/content/presenter';
import { contentErrorResponse } from '$lib/server/content/response';
import { canAccessAdultContent } from '$lib/server/content/adult-policy';
import type { RequestHandler } from './$types';

// Phase 7 — dedicated Adult Discover catalog endpoint.
//
// This is the ONLY API surface of the Adult Discover catalog, and it is
// authorization-gated SERVER-SIDE before anything else happens:
//
//   1. Authorization is evaluated PER REQUEST with the Phase 5 policy
//      function (fresh admin policy read + verified user preference /
//      HMAC guest cookie). No client-supplied flag (`adult=true`,
//      `include_adult=true`, ...) can enable this catalog — query
//      parameters carry catalog filters only, never authorization.
//   2. Unauthorized requests get the NON-DISCLOSING 404: identical to any
//      missing endpoint/content. No Adult catalog shape, no policy
//      internals, no provider/network data, no hint that the surface
//      exists.
//   3. Authorized requests pass strict, closed-union validation before
//      anything reaches TMDB: type ('movie'|'series'), language (the
//      closed DiscoverLanguage union), sort (closed union), page (clamped)
//      and — post-release fix — an OPTIONAL provider filter that accepts
//      ONLY 'all' or a VERIFIED Adult registry key. The server maps the
//      key to the verified TMDB network id itself; raw ids
//      (`provider=2902`, `provider=999999`) and unverified/unknown keys
//      are rejected with 400 and can never reach TMDB. The filter means
//      Adult AND selected verified provider — never Adult OR provider —
//      and the ONE central classifier still re-verifies every candidate.
//   4. The dedicated service contract (service.adultDiscover) re-checks
//      the authorization decision (defense-in-depth) and calls the Adult
//      Discover adapter — never the normal Discover path, never fixtures.
//
// Response: existing normalized media items (presenter) + pagination
// metadata. No internal security metadata, no HMAC/policy internals, no
// Adult network IDs.
export const GET: RequestHandler = async ({ url, locals, cookies }) => {
  // ---- 1. Per-request server-side authorization (the only gate in). ----
  const { user } = await locals.safeGetSession();
  const canAccess = await canAccessAdultContent(locals.supabase, user, cookies);
  if (!canAccess) {
    // ---- 2. Non-disclosing 404 — indistinguishable from a missing route.
    return json({ ok: false, error: { code: 'NOT_FOUND', message: 'The requested catalog could not be found.' } }, { status: 404 });
  }

  // ---- 3. Strict closed-union validation + clamped pagination. ----
  // type defaults to 'series' (TV-first: the verified Adult networks are TV
  // networks; the movie side is the documented transitional source).
  const typeParam = url.searchParams.get('type') ?? 'series';
  if (!isAdultDiscoverType(typeParam)) {
    return json({ ok: false, error: { code: 'INVALID_TYPE', message: 'Unsupported catalog type.' } }, { status: 400 });
  }
  const languageParam = url.searchParams.get('language') ?? 'all';
  if (!isAdultDiscoverLanguage(languageParam)) {
    return json({ ok: false, error: { code: 'INVALID_LANGUAGE', message: 'Unknown language filter.' } }, { status: 400 });
  }
  const sortParam = url.searchParams.get('sort') ?? 'popularity';
  if (!isAdultDiscoverSort(sortParam)) {
    return json({ ok: false, error: { code: 'INVALID_SORT', message: 'Unsupported sort.' } }, { status: 400 });
  }
  // Closed-union provider filter (post-release fix): 'all' or a VERIFIED
  // Adult registry key. Raw network ids, unverified candidates and unknown
  // keys are rejected here — before any cache access or TMDB call.
  const providerParam = url.searchParams.get('provider') ?? ADULT_DISCOVER_PROVIDER_ALL;
  if (!isAdultDiscoverProvider(providerParam)) {
    return json({ ok: false, error: { code: 'INVALID_PROVIDER', message: 'Unknown provider filter.' } }, { status: 400 });
  }
  const page = parseAdultDiscoverPage(url.searchParams.get('page'));

  // ---- 4. Dedicated Adult catalog service (defense-in-depth inside). ----
  try {
    const result = await adultDiscover({ type: typeParam, language: languageParam, sort: sortParam, page, provider: providerParam }, canAccess);
    return json({
      ok: true,
      items: result.items.map(toMediaItem),
      page: result.page,
      hasNextPage: result.hasNextPage,
      type: typeParam,
      language: languageParam,
      sort: sortParam,
      provider: providerParam
    });
  } catch (error) {
    // Upstream failure -> error response. NEVER a fallback to the normal
    // catalog or fixtures (Adult Discover cannot degrade into normal
    // content, and normal surfaces never receive Adult content).
    return contentErrorResponse(error);
  }
};
