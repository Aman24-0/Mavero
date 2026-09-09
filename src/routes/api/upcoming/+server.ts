import { json } from '@sveltejs/kit';
import { loadUpcomingPage, parseUpcomingMonth, parseUpcomingType, parseUpcomingYear, serializeCursor } from '$lib/server/content/upcoming';
import { UpcomingCursorError } from '$lib/server/content/upcoming-cursor';
import { parseUpcomingLanguage } from '$lib/shared/upcoming-policy';
import type { RequestHandler } from './$types';

// Upcoming pagination API endpoint (v2 — compact cursor + server-side
// snapshot continuation).
//
// The cursor is a COMPACT transport token (see
// $lib/server/content/upcoming-cursor.ts): it never carries
// UpcomingItem payloads, so the URL stays small no matter how many
// events the month contains. Continuation state lives on the server:
// movie pagination continues through the deterministic chronological
// candidate stream; series/anime/all paginate by offset into
// materialized server-side snapshots built on the existing source-level
// caches.
//
// Cursor problems are NEVER silently absorbed:
//   - malformed / unknown-version cursor  -> 400 INVALID_CURSOR
//   - cursor issued for different filters -> 409 CURSOR_FILTER_MISMATCH
//   - stream identity mismatch (results   -> 409 CURSOR_STALE
//     changed under the cursor)
// The client restarts through the explicit deterministic mechanism —
// the server never silently converts an invalid cursor into page 1.
//
// Upstream failures return a structured retryable response (ok:false +
// code UPSTREAM, 503) with the cursor position untouched — a transient
// failure never permanently marks the source exhausted. Internal stack
// traces are never exposed.

export const GET: RequestHandler = async ({ url }) => {
  const month = parseUpcomingMonth(url.searchParams.get('month'));
  const year = parseUpcomingYear(url.searchParams.get('year'));
  const type = parseUpcomingType(url.searchParams.get('type'));
  const language = parseUpcomingLanguage(url.searchParams.get('language'));
  // Informational only — the cursor carries the authoritative
  // continuation position, so the page number can never cause a
  // restart or a duplicate slice.
  const page = Math.max(1, Math.floor(Number(url.searchParams.get('page')) || 1));
  const cursor = url.searchParams.get('cursor');

  try {
    const result = await loadUpcomingPage({ month, year, type, language }, page, cursor);
    // A complete upstream failure for the requested mode is a real
    // failure — surfaced as a structured retryable response, never as a
    // silently empty "end of results" page.
    if (result.errorMessage) {
      return json({
        ok: false,
        error: { code: 'UPSTREAM', message: result.errorMessage },
        page,
        pageSize: result.pageSize,
        errors: result.errors
      }, { status: 503 });
    }
    return json({
      ok: true,
      items: result.items,
      page: result.page,
      pageSize: result.pageSize,
      hasNextPage: result.hasNextPage,
      cursor: serializeCursor(result.cursor),
      errors: result.errors
    });
  } catch (error) {
    if (error instanceof UpcomingCursorError) {
      const code = error.reason === 'filter-mismatch'
        ? 'CURSOR_FILTER_MISMATCH'
        : error.reason === 'stale'
          ? 'CURSOR_STALE'
          : 'INVALID_CURSOR';
      const status = code === 'INVALID_CURSOR' ? 400 : 409;
      console.warn(`[API /upcoming] ${code}: ${error.message}`);
      return json({
        ok: false,
        error: {
          code,
          message: 'This results page has expired. The list will restart cleanly from the first page.'
        }
      }, { status });
    }
    console.error('[API /upcoming] Failed', error);
    return json({
      ok: false,
      error: { code: 'UPSTREAM', message: 'Upcoming releases are temporarily unavailable.' }
    }, { status: 503 });
  }
};
