import { json } from '@sveltejs/kit';
import { discoverRail } from '$lib/server/content/service';
import { isDiscoverLanguage, isDiscoverSectionKey } from '$lib/server/content/service';
import { toMediaItem } from '$lib/server/content/presenter';
import { contentErrorResponse } from '$lib/server/content/response';
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
// Cache: the underlying TMDB adapter caches each (section, language,
// provider, page) tuple via getOrSet with a 4 min TTL + 10 min SWR.
// The browser-side DiscoverSection component also memoizes in-flight
// requests to avoid duplicate calls during rapid dropdown switches.
//
// Auth: public (TMDB data is not user-scoped). No Supabase session is
// required — the endpoint never reads the user's library, progress, or
// history.

export const GET: RequestHandler = async ({ url }) => {
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
  // Provider is optional; if present it must be a non-empty bounded string.
  // The server resolves the provider key to a TMDB provider_id via the
  // cached India provider list — an unknown key is treated as "All OTT".
  const safeProvider = provider && provider.trim() && provider.length <= 80 ? provider.trim() : undefined;

  try {
    const result = await discoverRail({
      section: sectionParam,
      language: languageParam,
      provider: safeProvider,
      page
    });
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
