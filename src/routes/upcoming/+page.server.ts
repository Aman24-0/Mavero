import { loadUpcoming, parseUpcomingMonth, parseUpcomingType, parseUpcomingYear, upcomingYearOptions } from '$lib/server/content/upcoming';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ url }) => {
  const month = parseUpcomingMonth(url.searchParams.get('month'));
  const year = parseUpcomingYear(url.searchParams.get('year'));
  const type = parseUpcomingType(url.searchParams.get('type'));
  const result = await loadUpcoming({ month, year, type });
  return {
    items: result.items,
    filters: result.filters,
    errors: result.errors,
    errorMessage: result.errorMessage,
    yearOptions: upcomingYearOptions()
  };
};
