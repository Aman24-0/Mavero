import { loadUpcomingPage, parseUpcomingMonth, parseUpcomingType, parseUpcomingYear, serializeCursor, upcomingYearOptions } from '$lib/server/content/upcoming';
import { parseUpcomingLanguage } from '$lib/shared/upcoming-policy';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ url }) => {
  const month = parseUpcomingMonth(url.searchParams.get('month'));
  const year = parseUpcomingYear(url.searchParams.get('year'));
  const type = parseUpcomingType(url.searchParams.get('type'));
  // Phase F.1 — language filter (TMDB ORIGINAL language). Strict parse:
  // missing/empty/unknown values fail safe to 'all' (no constraint).
  const language = parseUpcomingLanguage(url.searchParams.get('language'));
  // Page 1 — no incoming cursor (starts from scratch).
  const result = await loadUpcomingPage({ month, year, type, language }, 1);
  return {
    items: result.items,
    filters: result.filters,
    errors: result.errors,
    errorMessage: result.errorMessage,
    yearOptions: upcomingYearOptions(),
    page: result.page,
    pageSize: result.pageSize,
    hasNextPage: result.hasNextPage,
    cursor: serializeCursor(result.cursor)
  };
};
