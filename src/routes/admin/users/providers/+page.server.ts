import type { PageServerLoad } from './$types';
import { requireAdmin } from '$lib/server/streaming/admin-auth';
import { fetchProviders } from '$lib/server/analytics/providers';
import { resolveRangeFromParams } from '$lib/shared/analytics-period';

/**
 * Phase 5 — Provider Analytics server load.
 *
 * Reads the date-range from URL search params, resolves the canonical
 * UTC date range, and fetches the consolidated provider analytics
 * data via `fetchProviders`.
 *
 * Authorization: `requireAdmin` is the first call — non-admins are
 * redirected to sign-in (or get a 403). RLS on `analytics_events` is
 * the second defense layer.
 *
 * URL state (URL-driven — refresh/share/back-button safe):
 *   - `?period=...` — date-range preset (default 30d).
 *   - `?from=...&to=...` — custom date range (when period=custom).
 */
export const load: PageServerLoad = async ({ locals, url }) => {
  await requireAdmin(locals, { redirectTo: '/admin/users/providers' });

  // Resolve the date range from URL params.
  const { range, preset, from, to } = resolveRangeFromParams(url.searchParams, '30d');

  // Fetch the consolidated provider analytics data. Never throws.
  const result = await fetchProviders(locals.supabase, range);

  return {
    result,
    range,
    preset,
    from,
    to,
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
