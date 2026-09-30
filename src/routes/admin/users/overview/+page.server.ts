import type { PageServerLoad } from './$types';
import { requireAdmin } from '$lib/server/streaming/admin-auth';
import { fetchOverview, type TrendMode, type TrendMetric } from '$lib/server/analytics/overview';
import { resolveRangeFromParams, isAnalyticsPeriodPreset } from '$lib/shared/analytics-period';

/**
 * Phase 2 — Overview Dashboard server load.
 *
 * Reads the date-range + trend mode/metric from URL search params,
 * resolves the canonical UTC date range, fetches the consolidated
 * overview (metrics + trend + funnel) via the user-scoped admin client,
 * and returns everything to the page.
 *
 * The page re-fetches on navigation (URL change) so the date-range
 * picker and trend toggles drive new loads without client-side state.
 *
 * Error handling: `fetchOverview` NEVER throws — it returns a safe
 * empty shape with an `error` field on failure. The page renders an
 * error state when `error` is non-null. This satisfies the plan §27
 * requirement that analytics failures must not break core Mavero
 * functionality or expose database internals.
 */
export const load: PageServerLoad = async ({ locals, url }) => {
  await requireAdmin(locals, { redirectTo: '/admin/users/overview' });

  // Resolve the date range from URL params.
  const { range, preset, from, to } = resolveRangeFromParams(url.searchParams, '30d');

  // Resolve the trend mode + metric from URL params (with safe defaults).
  const trendModeParam = url.searchParams.get('mode') ?? 'all';
  const trendMetricParam = url.searchParams.get('metric') ?? 'users';
  const validModes: TrendMode[] = ['all', 'guest', 'logged-in', 'new', 'returning'];
  const validMetrics: TrendMetric[] = ['users', 'sessions', 'watch-starts'];
  const trendMode: TrendMode = validModes.includes(trendModeParam as TrendMode)
    ? (trendModeParam as TrendMode)
    : 'all';
  const trendMetric: TrendMetric = validMetrics.includes(trendMetricParam as TrendMetric)
    ? (trendMetricParam as TrendMetric)
    : 'users';

  // Fetch the consolidated overview. Never throws.
  const overview = await fetchOverview(locals.supabase, range, { trendMode, trendMetric });

  return {
    overview,
    range,
    preset,
    from,
    to,
    trendMode,
    trendMetric,
    // Expose the preset list + labels for the date-range picker.
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
