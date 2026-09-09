import { json } from '@sveltejs/kit';
import { loadUpcomingPage, parseUpcomingMonth, parseUpcomingType, parseUpcomingYear } from '$lib/server/content/upcoming';
import { parseUpcomingLanguage } from '$lib/shared/upcoming-policy';
import type { RequestHandler } from './$types';

// Upcoming pagination API endpoint.
//
// Returns one page (~24 items) of Upcoming items for the given filters
// + page number. The full result set is cached per filter combination,
// so page 2+ return instantly without re-fetching from TMDB.
//
// Used by the Upcoming page's IntersectionObserver infinite scroll.

export const GET: RequestHandler = async ({ url }) => {
  try {
    const month = parseUpcomingMonth(url.searchParams.get('month'));
    const year = parseUpcomingYear(url.searchParams.get('year'));
    const type = parseUpcomingType(url.searchParams.get('type'));
    const language = parseUpcomingLanguage(url.searchParams.get('language'));
    const page = Math.max(1, Number(url.searchParams.get('page')) || 1);
    const result = await loadUpcomingPage({ month, year, type, language }, page);
    return json({
      ok: true,
      items: result.items,
      page: result.page,
      pageSize: result.pageSize,
      hasNextPage: result.hasNextPage,
      errors: result.errors
    });
  } catch (error) {
    console.error('[API /upcoming] Failed', error);
    return json({ ok: false, error: { message: 'Upcoming releases are temporarily unavailable.' } }, { status: 503 });
  }
};
