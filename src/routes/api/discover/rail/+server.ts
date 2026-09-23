import { json } from '@sveltejs/kit';
import { discoverRail } from '$lib/server/content/service';
import { isDiscoverLanguage, isDiscoverSectionKey } from '$lib/server/content/service';
import { toMediaItem } from '$lib/server/content/presenter';
import { contentErrorResponse } from '$lib/server/content/response';
import { canAccessAdultContent } from '$lib/server/content/adult-policy';
import { canonicalKey, filterSeen } from '$lib/server/content/discover-dedup';
import type { RequestHandler } from './$types';
import type { NormalizedMediaItem } from '$lib/server/content/types';

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
// DEDUP SUPPORT: The `exclude` query parameter accepts a comma-separated
// list of canonical IDs (e.g. "movie:550,series:1399") to filter out
// from the response. This is used by Show More continuation to avoid
// re-introducing items already displayed in higher-priority rails. The
// server fetches up to 3 pages with bounded continuation when too many
// items are filtered out.

export const GET: RequestHandler = async ({ url, locals, cookies }) => {
  const sectionParam = url.searchParams.get('section') ?? '';
  const languageParam = url.searchParams.get('language') ?? 'all';
  const provider = url.searchParams.get('provider') ?? undefined;
  const page = Math.max(1, Math.min(Number(url.searchParams.get('page') ?? 1) || 1, 20));
  const excludeParam = url.searchParams.get('exclude') ?? '';

  if (!isDiscoverSectionKey(sectionParam)) {
    return json({ ok: false, error: { code: 'INVALID_SECTION', message: 'Unknown Discover section.' } }, { status: 400 });
  }
  if (!isDiscoverLanguage(languageParam)) {
    return json({ ok: false, error: { code: 'INVALID_LANGUAGE', message: 'Unknown language filter.' } }, { status: 400 });
  }
  const safeProvider = provider && provider.trim() && provider.length <= 80 ? provider.trim() : undefined;

  // Parse the exclude list into a Set for O(1) lookup.
  const excludeSet = new Set(
    excludeParam.split(',')
      .map(s => s.trim())
      .filter(s => s.length > 0 && s.length <= 100)
      .slice(0, 500) // bounded — prevent abuse
  );

  let canAccessAdult = false;
  if (sectionParam === 'adult-shows') {
    const user = locals.user;
    canAccessAdult = await canAccessAdultContent(locals.supabase, user, cookies);
    if (!canAccessAdult) {
      return json({ ok: true, items: [], page, hasNextPage: false, section: sectionParam, language: languageParam, provider: safeProvider ?? null });
    }
  }

  try {
    // If no exclude list, use the simple path (backward-compatible).
    if (excludeSet.size === 0) {
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
    }

    // With exclude list: fetch with bounded continuation (up to 3 pages).
    const TARGET_ITEMS = 10;
    const MAX_PAGES = 3;
    let collected: NormalizedMediaItem[] = [];
    let currentPage = page;
    let lastHasNext = false;

    while (currentPage <= page + MAX_PAGES - 1) {
      const result = await discoverRail({
        section: sectionParam,
        language: languageParam,
        provider: safeProvider,
        page: currentPage
      }, canAccessAdult);

      const filtered = filterSeen(result.items, excludeSet);
      collected.push(...filtered);

      if (collected.length >= TARGET_ITEMS || !result.hasNextPage) {
        lastHasNext = result.hasNextPage;
        break;
      }
      currentPage++;
      lastHasNext = result.hasNextPage;
    }

    return json({
      ok: true,
      items: collected.slice(0, 20).map(toMediaItem),
      page,
      hasNextPage: lastHasNext,
      section: sectionParam,
      language: languageParam,
      provider: safeProvider ?? null
    });
  } catch (error) {
    return contentErrorResponse(error);
  }
};
