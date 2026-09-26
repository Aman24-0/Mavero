import type { PageServerLoad } from './$types';
import { requireAdmin } from '$lib/server/streaming/admin-auth';
import { listUsers, USER_FILTERS, type UserFilter } from '$lib/server/analytics/users';
import { createSupabaseAdminClient } from '$lib/server/supabase/admin';
import { resolveRangeFromParams } from '$lib/shared/analytics-period';

/**
 * Phase 3 — User Management list page server load.
 *
 * Reads search + filter + pagination from URL search params, resolves
 * the canonical UTC date range (for active/new/returning filter
 * computation), and fetches one page of users via `listUsers`.
 *
 * Authorization: `requireAdmin` is the first call — non-admins are
 * redirected to sign-in (or get a 403). RLS on `analytics_events` /
 * `analytics_sessions` is the second defense layer.
 *
 * URL state (the page is fully URL-driven — refresh/share/back-button safe):
 *   - `?q=<search>` — case-insensitive partial match on email OR display_name.
 *   - `?filter=all|active|new|returning` — user-type filter.
 *   - `?page=<n>` — 1-indexed page number (default 1).
 *   - `?pageSize=<n>` — page size (default 25, max 100).
 *   - `?period=...` — date-range preset (default 30d) for filter computation.
 */
export const load: PageServerLoad = async ({ locals, url }) => {
  await requireAdmin(locals, { redirectTo: '/admin/users' });

  // Resolve the date range (used for active/new/returning computation).
  const { range, preset, from, to } = resolveRangeFromParams(url.searchParams, '30d');

  // Parse search/filter/pagination params.
  const search = (url.searchParams.get('q') ?? '').trim().slice(0, 200);
  const filterParam = url.searchParams.get('filter') ?? 'all';
  const filter: UserFilter = (USER_FILTERS as readonly string[]).includes(filterParam)
    ? (filterParam as UserFilter)
    : 'all';
  const page = Math.max(1, Number(url.searchParams.get('page') ?? '1') || 1);
  const pageSize = Math.max(1, Math.min(100, Number(url.searchParams.get('pageSize') ?? '25') || 25));

  // Create the service-role admin client for profiles + auth.users access.
  // The requireAdmin gate above is the sole authz boundary; this client
  // bypasses RLS. Email lives in auth.users.email (protected `auth`
  // schema) and requires the service-role key to read.
  let adminClient;
  try {
    adminClient = createSupabaseAdminClient();
  } catch {
    return {
      result: { users: [], page, pageSize, total: 0, totalIsApproximate: false, error: 'Admin configuration is missing. User data is unavailable.', migrationPending: false },
      search,
      filter,
      page,
      pageSize,
      range,
      preset,
      from,
      to,
      filterOptions: [
        { id: 'all', label: 'All users' },
        { id: 'active', label: 'Active users' },
        { id: 'new', label: 'New users' },
        { id: 'returning', label: 'Returning users' },
      ] as const,
      presetList: [
        { id: '24h', label: 'Last 24 Hours' },
        { id: '7d', label: 'Last 7 Days' },
        { id: '30d', label: 'Last 30 Days' },
        { id: '3m', label: 'Last 3 Months' },
        { id: '6m', label: 'Last 6 Months' },
        { id: '1y', label: 'Last 1 Year' },
      ] as const,
    };
  }

  // Fetch the user list (never throws — returns safe empty shape on error).
  const result = await listUsers(
    locals.supabase,
    adminClient,
    { search, filter, page, pageSize },
    range.start,
    range.end
  );

  return {
    result,
    search,
    filter,
    page,
    pageSize,
    range,
    preset,
    from,
    to,
    filterOptions: [
      { id: 'all', label: 'All users' },
      { id: 'active', label: 'Active users' },
      { id: 'new', label: 'New users' },
      { id: 'returning', label: 'Returning users' },
    ] as const,
    presetList: [
      { id: '24h', label: 'Last 24 Hours' },
      { id: '7d', label: 'Last 7 Days' },
      { id: '30d', label: 'Last 30 Days' },
      { id: '3m', label: 'Last 3 Months' },
      { id: '6m', label: 'Last 6 Months' },
      { id: '1y', label: 'Last 1 Year' },
    ] as const,
  };
};
