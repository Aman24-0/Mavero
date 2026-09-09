import { loadUpcomingPage, parseUpcomingMonth, parseUpcomingType, parseUpcomingYear, upcomingYearOptions, UPCOMING_PAGE_SIZE } from '$lib/server/content/upcoming';
import { parseUpcomingLanguage } from '$lib/shared/upcoming-policy';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ url }) => {
  const month = parseUpcomingMonth(url.searchParams.get('month'));
  const year = parseUpcomingYear(url.searchParams.get('year'));
  const type = parseUpcomingType(url.searchParams.get('type'));
  // Phase F.1 — language filter (TMDB ORIGINAL language). Strict parse:
  // missing/empty/unknown values fail safe to 'all' (no constraint).
  const language = parseUpcomingLanguage(url.searchParams.get('language'));
  // BUG 2 FIX: return only the first page (~24 items) from SSR.
  // Subsequent pages are loaded via /api/upcoming infinite scroll.
  const result = await loadUpcomingPage({ month, year, type, language }, 1);
  return {
    items: result.items,
    filters: result.filters,
    errors: result.errors,
    errorMessage: result.errorMessage,
    yearOptions: upcomingYearOptions(),
    page: result.page,
    pageSize: result.pageSize,
    hasNextPage: result.hasNextPage
  };
};
