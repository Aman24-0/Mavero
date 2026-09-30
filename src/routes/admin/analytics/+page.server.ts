/**
 * Admin 2.0 — Phase H — Analytics workspace page server.
 *
 * Unified workspace for all analytics tabs. Loads the selected tab's data
 * + shared period state. Reuses existing analytics service functions —
 * no new backend APIs.
 */

import { requireAdmin } from '$lib/server/streaming/admin-auth';
import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { resolveRangeFromParams } from '$lib/shared/analytics-period';
import { fetchOverview } from '$lib/server/analytics/overview';
import { listUsers, type UserFilter } from '$lib/server/analytics/users';
import { fetchViewing } from '$lib/server/analytics/viewing';
import { fetchProviders } from '$lib/server/analytics/providers';
import { fetchRetention, type CohortType, COHORT_TYPES } from '$lib/server/analytics/retention';
import { createSupabaseAdminClient } from '$lib/server/supabase/admin';

const VALID_TABS = new Set(['overview', 'users', 'viewing', 'providers', 'retention']);

export const load: PageServerLoad = async ({ locals, url }) => {
  await requireAdmin(locals, { redirectTo: '/admin/analytics' });

  const tab = url.searchParams.get('tab') ?? 'overview';
  if (!VALID_TABS.has(tab)) {
    throw error(400, 'Invalid tab. Use ?tab=overview|users|viewing|providers|retention.');
  }

  const { range, preset, from, to } = resolveRangeFromParams(url.searchParams, '30d');
  const adminClient = createSupabaseAdminClient();

  // Initialize all tab data as null — only the active tab gets populated.
  let overview: any = null;
  let users: any = null;
  let viewing: any = null;
  let providers: any = null;
  let retention: any = null;
  let analyticsError: string | null = null;
  let overviewMode = 'all';
  let overviewMetric = 'users';
  let usersPage = 1;
  let usersQ = '';
  let usersFilter = 'all';
  let retentionCohort = 'signup';

  try {
    if (tab === 'overview') {
      overviewMode = url.searchParams.get('mode') ?? 'all';
      overviewMetric = url.searchParams.get('metric') ?? 'users';
      overview = await fetchOverview(adminClient, range, {
        trendMode: overviewMode as any,
        trendMetric: overviewMetric as any,
      });
    } else if (tab === 'users') {
      usersPage = Math.max(1, parseInt(url.searchParams.get('page') ?? '1', 10) || 1);
      usersQ = url.searchParams.get('q') ?? '';
      usersFilter = url.searchParams.get('filter') ?? 'all';
      users = await listUsers(
        locals.supabase,
        adminClient,
        { search: usersQ, filter: usersFilter as UserFilter, page: usersPage, pageSize: 25 },
        range.start,
        range.end,
      );
    } else if (tab === 'viewing') {
      viewing = await fetchViewing(adminClient, range);
    } else if (tab === 'providers') {
      providers = await fetchProviders(adminClient, range);
    } else if (tab === 'retention') {
      const cohortRaw = url.searchParams.get('cohort') ?? 'signup';
      retentionCohort = COHORT_TYPES.includes(cohortRaw as CohortType) ? cohortRaw : 'signup';
      retention = await fetchRetention(locals.supabase, range, retentionCohort as CohortType);
    }
  } catch (err) {
    analyticsError = err instanceof Error ? err.message : 'Analytics query failed.';
  }

  return {
    initialTab: tab,
    range,
    preset,
    from,
    to,
    overview,
    users,
    viewing,
    providers,
    retention,
    analyticsError,
    overviewMode,
    overviewMetric,
    usersPage,
    usersQ,
    usersFilter,
    retentionCohort,
  };
};
