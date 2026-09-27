import { loadUpcomingPage, parseUpcomingStartDate, parseUpcomingType, serializeCursor } from '$lib/server/content/upcoming';
import { parseUpcomingLanguage } from '$lib/shared/upcoming-policy';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ url }) => {
  // F7-B: the canonical Upcoming date input is a single `startDate`
  // (YYYY-MM-DD) opening a fixed 30-calendar-day window. Strict parse:
  // missing/empty/malformed/impossible dates fail safe to TODAY's UTC
  // calendar date. The legacy month/year URL parameters are NO LONGER
  // accepted.
  const startDate = parseUpcomingStartDate(url.searchParams.get('startDate'));
  const type = parseUpcomingType(url.searchParams.get('type'));
  // Phase F.1 — language filter (TMDB ORIGINAL language). Strict parse:
  // missing/empty/unknown values fail safe to 'all' (no constraint).
  const language = parseUpcomingLanguage(url.searchParams.get('language'));
  // Page 1 — no incoming cursor (starts from scratch).
  const result = await loadUpcomingPage({ startDate, type, language }, 1);
  return {
    items: result.items,
    filters: result.filters,
    errors: result.errors,
    errorMessage: result.errorMessage,
    page: result.page,
    pageSize: result.pageSize,
    hasNextPage: result.hasNextPage,
    cursor: serializeCursor(result.cursor)
  };
};
