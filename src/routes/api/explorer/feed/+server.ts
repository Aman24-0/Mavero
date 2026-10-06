import { json } from '@sveltejs/kit';
import { isContentType } from '$lib/server/content/types';
import { explorerFeed, hasExplorerFilters } from '$lib/server/content/explorer-load';
import { isExplorerGenre, isExplorerLanguage } from '$lib/shared/explorer-taxonomy';
import type { RequestHandler } from './$types';

// MAVERO — Explorer filtered-results feed (Movies / TV Shows / Anime
// Explorer redesign).
//
// Serves the client-side progressive/infinite results for an ACTIVE
// genre/language filter combination. The browser sends the SAME typed
// filter contract the page URL uses (closed genre taxonomy per type +
// closed language union) — validated here exactly like the page
// loader, so no invented TMDB ids or language codes can reach the
// upstream queries.
//
// Contract:
//   GET /api/explorer/feed?type=movie|series|anime&genre=<name>&language=<code>&page=1..20
//
//   - type is REQUIRED and validated against the closed ContentType union.
//   - genre is validated against the per-type Explorer genre list
//     (invalid → 400, mirroring the discover rail endpoint contract).
//   - language is validated against the per-type Explorer language list.
//   - page is clamped to the 1..20 serving window.
//   - At least one filter must be active (the unfiltered Explorer is
//     server-rendered sections, not this endpoint).
//
// Response: { ok, items: MediaItem[], page, hasNextPage, totalPages }.
// A failed upstream catalog returns ok:true with empty items + error
// (the same "section unavailable" convention as /api/discover/rail —
// the client shows the empty/error state, never fixtures).

export const GET: RequestHandler = async ({ url }) => {
  const typeParam = url.searchParams.get('type') ?? '';
  if (!isContentType(typeParam)) {
    return json({ ok: false, error: { code: 'INVALID_TYPE', message: 'Unknown Explorer content type.' } }, { status: 400 });
  }
  const genre = url.searchParams.get('genre')?.trim() || undefined;
  const language = url.searchParams.get('language')?.trim() || undefined;
  if (genre !== undefined && !isExplorerGenre(typeParam, genre)) {
    return json({ ok: false, error: { code: 'INVALID_GENRE', message: 'Unknown Explorer genre filter.' } }, { status: 400 });
  }
  if (language !== undefined && !isExplorerLanguage(typeParam, language)) {
    return json({ ok: false, error: { code: 'INVALID_LANGUAGE', message: 'Unknown Explorer language filter.' } }, { status: 400 });
  }
  const page = Math.max(1, Math.min(Number(url.searchParams.get('page') ?? 1) || 1, 20));
  const filters = { genre, language };

  if (!hasExplorerFilters(filters)) {
    return json({ ok: false, error: { code: 'NO_FILTERS', message: 'The Explorer feed requires an active genre or language filter.' } }, { status: 400 });
  }

  const result = await explorerFeed(typeParam, filters, page);
  return json({
    ok: true,
    items: result.items,
    page: result.page,
    hasNextPage: result.hasNextPage,
    totalPages: result.totalPages ?? null,
    ...(result.error ? { error: { code: 'UPSTREAM_ERROR', message: result.error } } : {})
  });
};
