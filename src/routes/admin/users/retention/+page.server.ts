import type { PageServerLoad } from './$types';
import { requireAdmin } from '$lib/server/streaming/admin-auth';
import { fetchRetention, COHORT_TYPES, type CohortType } from '$lib/server/analytics/retention';
import { resolveRangeFromParams } from '$lib/shared/analytics-period';

/**
 * Phase 6 — Retention & Cohorts server load.
 *
 * Reads the date-range + cohort type from URL search params, resolves
 * the canonical UTC date range, and fetches the retention data.
 *
 * URL state:
 *   - `?period=...` — date-range preset (default 30d).
 *   - `?cohort=signup|first-use|first-watch` — cohort type (default signup).
 */
export const load: PageServerLoad = async ({ locals, url }) => {
  await requireAdmin(locals, { redirectTo: '/admin/users/retention' });

  const { range, preset, from, to } = resolveRangeFromParams(url.searchParams, '30d');

  const cohortParam = url.searchParams.get('cohort') ?? 'signup';
  const cohortType: CohortType = (COHORT_TYPES as readonly string[]).includes(cohortParam)
    ? (cohortParam as CohortType)
    : 'signup';

  const result = await fetchRetention(locals.supabase, range, cohortType);

  return {
    result,
    range,
    preset,
    from,
    to,
    cohortType,
    presetList: [
      { id: '24h', label: 'Last 24 Hours' },
      { id: '7d', label: 'Last 7 Days' },
      { id: '30d', label: 'Last 30 Days' },
      { id: '3m', label: 'Last 3 Months' },
      { id: '6m', label: 'Last 6 Months' },
      { id: '1y', label: 'Last 1 Year' },
    ] as const,
    cohortOptions: [
      { id: 'signup', label: 'Signup' },
      { id: 'first-use', label: 'First Use' },
      { id: 'first-watch', label: 'First Watch' },
    ] as const,
  };
};
