import { json } from '@sveltejs/kit';
import { loadUpcomingPage, parseCursor, parseUpcomingMonth, parseUpcomingType, parseUpcomingYear, serializeCursor } from '$lib/server/content/upcoming';
import { parseUpcomingLanguage } from '$lib/shared/upcoming-policy';
import type { RequestHandler } from './$types';

// Upcoming pagination API endpoint (cursor-based).
//
// Each request processes only SOURCE_CANDIDATE_BATCH candidates per
// source (movie/series/anime), starting from the cursor position.
// The cursor is a serializable JSON object returned in the response
// and passed back in the next request's `cursor` query param.
//
// The server NEVER restarts from candidate 0 on page 2+ — it continues
// from where the previous request left off.

export const GET: RequestHandler = async ({ url }) => {
  try {
    const month = parseUpcomingMonth(url.searchParams.get('month'));
    const year = parseUpcomingYear(url.searchParams.get('year'));
    const type = parseUpcomingType(url.searchParams.get('type'));
    const language = parseUpcomingLanguage(url.searchParams.get('language'));
    const page = Math.max(1, Number(url.searchParams.get('page')) || 1);
    const cursor = parseCursor(url.searchParams.get('cursor'));
    const result = await loadUpcomingPage({ month, year, type, language }, page, cursor);
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
    console.error('[API /upcoming] Failed', error);
    return json({ ok: false, error: { message: 'Upcoming releases are temporarily unavailable.' } }, { status: 503 });
  }
};
