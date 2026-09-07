import { json } from '@sveltejs/kit';
import { discoverRail } from '$lib/server/content/service';
import { isDiscoverLanguage, isDiscoverSectionKey } from '$lib/server/content/service';
import { toMediaItem } from '$lib/server/content/presenter';
import { contentErrorResponse } from '$lib/server/content/response';
import { canAccessAdultContent } from '$lib/server/content/adult-policy';
import type { RequestHandler } from './$types';

// Discover V2 rail endpoint.
//
// The browser sends a typed `DiscoverRailFilters` (section key + language
// + optional provider + page); the server maps the section key to the
// right TMDB endpoint + filters via `discoverRail()`. The browser never
// sends raw TMDB paths or arbitrary filter values — section keys are
// validated against a closed union, so this endpoint cannot be tricked
// into hitting an arbitrary TMDB URL.
//
// ADULT ENFORCEMENT: For the 'adult-shows' section, the server evaluates
// the central adult policy BEFORE calling discoverRail. If the user is
// not authorized for adult content, the endpoint returns an empty
// non-disclosing result (not a 403 — the frontend treats it as "section
// unavailable" and hides the rail). This is consistent with the existing
// API convention where unavailable sections return empty items.
//
// Cache: the underlying TMDB adapter caches each (section, language,
// provider, page) tuple via getOrSet. Adult section cache keys include
// the provider dimension so responses don't leak between providers.
// Normal rail cache keys include the adult-exclusion dimension so
// adult-excluded results don't leak into a context where adult content
// is expected.

export const GET: RequestHandler = async ({ url, locals, cookies }) => {
  const sectionParam = url.searchParams.get('section') ?? '';
  const languageParam = url.searchParams.get('language') ?? 'all';
  const provider = url.searchParams.get('provider') ?? undefined;
  const page = Math.max(1, Math.min(Number(url.searchParams.get('page') ?? 1) || 1, 20));

  if (!isDiscoverSectionKey(sectionParam)) {
    return json({ ok: false, error: { code: 'INVALID_SECTION', message: 'Unknown Discover section.' } }, { status: 400 });
  }
  if (!isDiscoverLanguage(languageParam)) {
    return json({ ok: false, error: { code: 'INVALID_LANGUAGE', message: 'Unknown language filter.' } }, { status: 400 });
  }
  const safeProvider = provider && provider.trim() && provider.length <= 80 ? provider.trim() : undefined;

  let canAccessAdult = false;
  if (sectionParam === 'adult-shows') {
    const { user } = await locals.safeGetSession();
    canAccessAdult = await canAccessAdultContent(locals.supabase, user, cookies);
    if (!canAccessAdult) {
      return json({ ok: true, items: [], page, hasNextPage: false, section: sectionParam, language: languageParam, provider: safeProvider ?? null });
    }
  }

  try {
    const result = await discoverRail({
      section: sectionParam,
      language: languageParam,
      provider: safeProvider,
      page
    }, canAccessAdult);
    return json({
      ok: true,
      items: result.items.map(toMediaItem),
      page: result.page,
      hasNextPage: result.hasNextPage,
      section: sectionParam,
      language: languageParam,
      provider: safeProvider ?? null
    });
  } catch (error) {
    return contentErrorResponse(error);
  }
};
