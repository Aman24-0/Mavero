/**
 * Phase 6 — server-side Retention & Cohorts query module.
 *
 * Provides:
 *   - `fetchRetention()`: cohort table + summary for the selected
 *     cohort type (signup / first-use / first-watch), with D1/D7/D30
 *     retention rates.
 *   - `fetchBehavioralCohorts()`: overlapping behavioral cohort counts
 *     (Watched, Searched, Favorited, Provider Switcher) for the
 *     selected period.
 *
 * ARCHITECTURE (follows Phase 1–5 conventions):
 *   - All queries run via the user-scoped admin client (`locals.supabase`).
 *     RLS on `analytics_events` enforces admin-only SELECT via `is_admin()`.
 *   - NEVER throws — returns a safe empty shape with an `error` field on
 *     failure (mirrors Phase 2–5 contracts).
 *   - Reuses the Phase 1 `MEANINGFUL_ACTIVITY_EVENTS` set as the
 *     canonical "meaningful activity" definition (no redefinition).
 *   - Reuses the Phase 2 `isMissingTableError` / `safeErrorMessage`
 *     helpers via local copies.
 *   - Uses `profiles.created_at` as the signup cohort anchor (per Phase 3
 *     which established this as the canonical account creation timestamp).
 *
 * COHORT DEFINITIONS (per plan §4):
 *
 *   A. **Signup Cohort** — anchor = `profiles.created_at` (account
 *      creation date). Identity = `user_id` (authenticated users only).
 *      Return activity = meaningful events with `user_id IS NOT NULL`
 *      after the cohort date. Guest retention is NOT supported (cookie
 *      expiry makes anonymous_id unreliable for multi-day retention —
 *      documented as unavailable per plan §14).
 *
 *   B. **First-Use Cohort** — anchor = earliest meaningful event per
 *      `user_id`. Return activity = subsequent meaningful events.
 *
 *   C. **First-Watch Cohort** — anchor = earliest `watch_start` event
 *      per `user_id`. Return activity = subsequent meaningful events.
 *
 * D1/D7/D30 CALCULATION (per plan §6–§7):
 *   - **Calendar-day UTC model.** D1 = meaningful activity on the
 *     calendar day that is +1 day after the cohort date. D7 = +7 days.
 *     D30 = +30 days. This is consistent with the Phase 2 UTC
 *     convention.
 *   - **retention_rate = retained_users / eligible_cohort_users**.
 *     Both numerator and denominator are unique `user_id` values.
 *   - **Eligibility**: a cohort day-N is "eligible" only if
 *     `cohort_date + N days <= today (UTC)`. Otherwise the cell shows
 *     "Not yet eligible" (—), NOT 0% (per plan §9).
 *
 * IDENTITY (per plan §14):
 *   - Authenticated only (`user_id`) for Phase 6.
 *   - Guest retention via `anonymous_id` is unreliable (cookie expiry,
 *     no cross-device stitching) → documented as unavailable.
 *   - NO IP-based identity.
 *
 * PRIVACY (per plan §25–§26):
 *   - All output is aggregate (cohort sizes, retention counts).
 *   - No raw IP/UA/request_id displayed.
 *   - No anonymous IDs displayed.
 *   - No drill-down from tiny cohorts to individual users.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '$lib/server/supabase/database.types';
import { MEANINGFUL_ACTIVITY_EVENTS } from '$lib/shared/analytics-taxonomy';
import type { AnalyticsDateRange } from '$lib/shared/analytics-period';

const MEANINGFUL_EVENTS_ARRAY = Array.from(MEANINGFUL_ACTIVITY_EVENTS);

// ============================================================
// Types
// ============================================================

export type CohortType = 'signup' | 'first-use' | 'first-watch';

export const COHORT_TYPES: CohortType[] = ['signup', 'first-use', 'first-watch'];

export const COHORT_TYPE_LABELS: Record<CohortType, string> = {
  signup: 'Signup',
  'first-use': 'First Use',
  'first-watch': 'First Watch',
};

export type CohortRow = {
  /** Cohort date (YYYY-MM-DD, UTC). */
  cohortDate: string;
  /** Number of users in the cohort. */
  cohortSize: number;
  /** D1 retained count (null = not yet eligible). */
  d1Retained: number | null;
  /** D1 retention % (null = not yet eligible). */
  d1Rate: number | null;
  /** D7 retained count (null = not yet eligible). */
  d7Retained: number | null;
  /** D7 retention % (null = not yet eligible). */
  d7Rate: number | null;
  /** D30 retained count (null = not yet eligible). */
  d30Retained: number | null;
  /** D30 retention % (null = not yet eligible). */
  d30Rate: number | null;
};

export type RetentionSummary = {
  /** Total cohort users across all cohort dates in the range. */
  totalCohortUsers: number;
  /** Weighted D1 retention % across eligible cohorts (null = no eligible cohorts). */
  d1Rate: number | null;
  /** Weighted D7 retention % across eligible cohorts. */
  d7Rate: number | null;
  /** Weighted D30 retention % across eligible cohorts. */
  d30Rate: number | null;
};

export type BehavioralCohort = {
  id: string;
  label: string;
  description: string;
  /** Number of unique users in this cohort. */
  userCount: number;
};

export type RetentionResult = {
  cohortType: CohortType;
  cohorts: CohortRow[];
  summary: RetentionSummary;
  behavioralCohorts: BehavioralCohort[];
  error: string | null;
  migrationPending: boolean;
};

// ============================================================
// Error helpers (mirror Phase 2–5)
// ============================================================

function isMissingTableError(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  const code = error.code ?? '';
  const message = error.message ?? '';
  return code === '42P01' || code === 'PGRST205' || code === 'PGRST202' || /does not exist/i.test(message);
}

function safeErrorMessage(error: { code?: string; message?: string } | null): string {
  if (!error) return 'Unknown error.';
  if (isMissingTableError(error)) {
    return 'Analytics tables are not available. The Phase 1 migration may not be applied.';
  }
  return 'Analytics data is temporarily unavailable. Please try again.';
}

// ============================================================
// Date helpers (UTC calendar-day model)
// ============================================================

/** Returns the UTC YYYY-MM-DD for an ISO timestamp. */
function utcDateKey(iso: string): string {
  return iso.slice(0, 10);
}

/** Returns the UTC YYYY-MM-DD for today. */
function todayUtcKey(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Adds N days to a YYYY-MM-DD string, returns YYYY-MM-DD. */
function addDays(dateKey: string, n: number): string {
  const d = new Date(dateKey + 'T00:00:00.000Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Returns the start-of-day ISO for a YYYY-MM-DD (00:00:00.000Z). */
function startOfDay(dateKey: string): string {
  return dateKey + 'T00:00:00.000Z';
}

/** Returns the end-of-day ISO for a YYYY-MM-DD (23:59:59.999Z). */
function endOfDay(dateKey: string): string {
  return dateKey + 'T23:59:59.999Z';
}

// ============================================================
// fetchRetention — top-level entry point
// ============================================================

/**
 * Fetches the complete Retention & Cohorts dashboard data for the
 * given date range and cohort type. NEVER throws.
 *
 * @param client The user-scoped admin client (RLS enforces admin-only).
 * @param range The canonical UTC date range (determines which cohort dates are displayed).
 * @param cohortType Which cohort anchor to use.
 */
export async function fetchRetention(
  client: SupabaseClient<Database>,
  range: AnalyticsDateRange,
  cohortType: CohortType
): Promise<RetentionResult> {
  const today = todayUtcKey();

  // Step 1: Determine the cohort anchor for each user.
  // - signup: profiles.created_at
  // - first-use: earliest meaningful event per user_id
  // - first-watch: earliest watch_start event per user_id
  const anchorByUser = await fetchCohortAnchors(client, range, cohortType);
  if (anchorByUser.error) {
    return { cohortType, cohorts: [], summary: emptySummary(), behavioralCohorts: [], error: anchorByUser.error, migrationPending: anchorByUser.migrationPending };
  }

  // Step 2: Group users by cohort date (YYYY-MM-DD).
  const cohortsByDate = new Map<string, Set<string>>();
  for (const [userId, anchorIso] of anchorByUser.anchors) {
    const dateKey = utcDateKey(anchorIso);
    let set = cohortsByDate.get(dateKey);
    if (!set) {
      set = new Set<string>();
      cohortsByDate.set(dateKey, set);
    }
    set.add(userId);
  }

  // Step 3: For each cohort date, check D1/D7/D30 retention.
  // We need to know which users were active on each target day.
  // Instead of querying per-day (N+1), we fetch ALL meaningful events
  // in the range [cohortStart, range.end + 30 days] and build a
  // per-user-per-day activity map in JS. This is bounded by the
  // period's event volume.
  const allCohortUserIds = new Set<string>();
  for (const set of cohortsByDate.values()) {
    for (const uid of set) allCohortUserIds.add(uid);
  }

  if (allCohortUserIds.size === 0) {
    // No cohort users — return empty result with behavioral cohorts.
    const behavioralCohorts = await fetchBehavioralCohorts(client, range);
    return { cohortType, cohorts: [], summary: emptySummary(), behavioralCohorts, error: null, migrationPending: false };
  }

  // Fetch all meaningful events for the cohort users, from the earliest
  // cohort date to range.end + 30 days (to capture D30 windows).
  const earliestCohortDate = Array.from(cohortsByDate.keys()).sort()[0];
  const retentionWindowEnd = addDays(utcDateKey(range.end), 30);
  const activityResult = await client
    .from('analytics_events')
    .select('user_id,event_time')
    .in('user_id', Array.from(allCohortUserIds))
    .in('event_name', MEANINGFUL_EVENTS_ARRAY)
    .not('user_id', 'is', null)
    .gte('event_time', startOfDay(earliestCohortDate))
    .lt('event_time', endOfDay(retentionWindowEnd));

  if (activityResult.error) {
    return { cohortType, cohorts: [], summary: emptySummary(), behavioralCohorts: [], error: safeErrorMessage(activityResult.error), migrationPending: isMissingTableError(activityResult.error) };
  }

  // Build per-user-per-day activity map: userId → Set<YYYY-MM-DD>.
  const activityByUserDay = new Map<string, Set<string>>();
  for (const row of (activityResult.data ?? []) as Array<{ user_id: string | null; event_time: string }>) {
    if (!row.user_id) continue;
    const dayKey = utcDateKey(row.event_time);
    let days = activityByUserDay.get(row.user_id);
    if (!days) {
      days = new Set<string>();
      activityByUserDay.set(row.user_id, days);
    }
    days.add(dayKey);
  }

  // Step 4: Build the cohort table.
  const cohortRows: CohortRow[] = [];
  let totalCohortUsers = 0;
  let totalD1Retained = 0;
  let totalD1Eligible = 0;
  let totalD7Retained = 0;
  let totalD7Eligible = 0;
  let totalD30Retained = 0;
  let totalD30Eligible = 0;

  for (const [cohortDate, userSet] of cohortsByDate) {
    const cohortSize = userSet.size;
    totalCohortUsers += cohortSize;

    // D1: activity on cohortDate + 1 day.
    const d1Target = addDays(cohortDate, 1);
    const d1Eligible = d1Target <= today;
    let d1Retained = 0;
    if (d1Eligible) {
      totalD1Eligible += cohortSize;
      for (const userId of userSet) {
        const days = activityByUserDay.get(userId);
        if (days && days.has(d1Target)) d1Retained += 1;
      }
      totalD1Retained += d1Retained;
    }

    // D7: activity on cohortDate + 7 days.
    const d7Target = addDays(cohortDate, 7);
    const d7Eligible = d7Target <= today;
    let d7Retained = 0;
    if (d7Eligible) {
      totalD7Eligible += cohortSize;
      for (const userId of userSet) {
        const days = activityByUserDay.get(userId);
        if (days && days.has(d7Target)) d7Retained += 1;
      }
      totalD7Retained += d7Retained;
    }

    // D30: activity on cohortDate + 30 days.
    const d30Target = addDays(cohortDate, 30);
    const d30Eligible = d30Target <= today;
    let d30Retained = 0;
    if (d30Eligible) {
      totalD30Eligible += cohortSize;
      for (const userId of userSet) {
        const days = activityByUserDay.get(userId);
        if (days && days.has(d30Target)) d30Retained += 1;
      }
      totalD30Retained += d30Retained;
    }

    cohortRows.push({
      cohortDate,
      cohortSize,
      d1Retained: d1Eligible ? d1Retained : null,
      d1Rate: d1Eligible && cohortSize > 0 ? Math.round((d1Retained / cohortSize) * 1000) / 10 : null,
      d7Retained: d7Eligible ? d7Retained : null,
      d7Rate: d7Eligible && cohortSize > 0 ? Math.round((d7Retained / cohortSize) * 1000) / 10 : null,
      d30Retained: d30Eligible ? d30Retained : null,
      d30Rate: d30Eligible && cohortSize > 0 ? Math.round((d30Retained / cohortSize) * 1000) / 10 : null,
    });
  }

  // Sort cohorts by date descending (newest first).
  cohortRows.sort((a, b) => b.cohortDate.localeCompare(a.cohortDate));

  // Step 5: Build summary (weighted retention rates).
  const summary: RetentionSummary = {
    totalCohortUsers,
    d1Rate: totalD1Eligible > 0 ? Math.round((totalD1Retained / totalD1Eligible) * 1000) / 10 : null,
    d7Rate: totalD7Eligible > 0 ? Math.round((totalD7Retained / totalD7Eligible) * 1000) / 10 : null,
    d30Rate: totalD30Eligible > 0 ? Math.round((totalD30Retained / totalD30Eligible) * 1000) / 10 : null,
  };

  // Step 6: Fetch behavioral cohorts.
  const behavioralCohorts = await fetchBehavioralCohorts(client, range);

  return {
    cohortType,
    cohorts: cohortRows,
    summary,
    behavioralCohorts,
    error: null,
    migrationPending: false,
  };
}

function emptySummary(): RetentionSummary {
  return { totalCohortUsers: 0, d1Rate: null, d7Rate: null, d30Rate: null };
}

// ============================================================
// Cohort anchor resolution
// ============================================================

type AnchorResult = { anchors: Map<string, string>; error: string | null; migrationPending: boolean };

/**
 * Fetches the cohort anchor timestamp for each user, based on the
 * cohort type.
 *
 * - signup: profiles.created_at (queried via the user-scoped client
 *   — RLS allows admins to read all profiles via is_admin()).
 * - first-use: earliest meaningful event per user_id.
 * - first-watch: earliest watch_start event per user_id.
 *
 * Only users whose anchor falls within [range.start, range.end) are
 * included — these form the cohort population for the selected period.
 */
async function fetchCohortAnchors(
  client: SupabaseClient<Database>,
  range: AnalyticsDateRange,
  cohortType: CohortType
): Promise<AnchorResult> {
  if (cohortType === 'signup') {
    // Fetch profiles created in the period. RLS allows admin SELECT
    // via is_admin().
    const result = await client
      .from('profiles')
      .select('id,created_at')
      .gte('created_at', range.start)
      .lt('created_at', range.end);
    if (result.error) {
      return { anchors: new Map(), error: safeErrorMessage(result.error), migrationPending: false };
    }
    const anchors = new Map<string, string>();
    for (const row of (result.data ?? []) as Array<{ id: string; created_at: string }>) {
      anchors.set(row.id, row.created_at);
    }
    return { anchors, error: null, migrationPending: false };
  }

  // first-use or first-watch: fetch events and find the earliest per user.
  const eventName = cohortType === 'first-use' ? MEANINGFUL_EVENTS_ARRAY : ['watch_start'];
  const result = await client
    .from('analytics_events')
    .select('user_id,event_time')
    .in('event_name', eventName)
    .not('user_id', 'is', null)
    .order('event_time', { ascending: true });

  if (result.error && isMissingTableError(result.error)) {
    return { anchors: new Map(), error: safeErrorMessage(result.error), migrationPending: true };
  }
  if (result.error) {
    return { anchors: new Map(), error: safeErrorMessage(result.error), migrationPending: false };
  }

  // Find the earliest event per user, then filter to those whose
  // earliest event falls within [range.start, range.end).
  const earliestByUser = new Map<string, string>();
  for (const row of (result.data ?? []) as Array<{ user_id: string | null; event_time: string }>) {
    if (!row.user_id) continue;
    const existing = earliestByUser.get(row.user_id);
    if (!existing || row.event_time < existing) {
      earliestByUser.set(row.user_id, row.event_time);
    }
  }

  const anchors = new Map<string, string>();
  for (const [userId, earliest] of earliestByUser) {
    if (earliest >= range.start && earliest < range.end) {
      anchors.set(userId, earliest);
    }
  }

  return { anchors, error: null, migrationPending: false };
}

// ============================================================
// Behavioral cohorts
// ============================================================

/**
 * Fetches overlapping behavioral cohort counts for the selected period.
 *
 * Cohorts (per plan §15):
 * - Watched: ≥1 watch_start in the period.
 * - Searched: ≥1 search in the period.
 * - Favorited: ≥1 favorite_added in the period.
 * - Provider Switcher: ≥1 provider_switched in the period.
 *
 * These cohorts OVERLAP — a user can be in multiple (per plan §16).
 */
async function fetchBehavioralCohorts(
  client: SupabaseClient<Database>,
  range: AnalyticsDateRange
): Promise<BehavioralCohort[]> {
  // Fetch all relevant events in the period, project only user_id.
  const [watchRes, searchRes, favRes, switchRes] = await Promise.all([
    client
      .from('analytics_events')
      .select('user_id')
      .eq('event_name', 'watch_start')
      .not('user_id', 'is', null)
      .gte('event_time', range.start)
      .lt('event_time', range.end),
    client
      .from('analytics_events')
      .select('user_id')
      .eq('event_name', 'search')
      .not('user_id', 'is', null)
      .gte('event_time', range.start)
      .lt('event_time', range.end),
    client
      .from('analytics_events')
      .select('user_id')
      .eq('event_name', 'favorite_added')
      .not('user_id', 'is', null)
      .gte('event_time', range.start)
      .lt('event_time', range.end),
    client
      .from('analytics_events')
      .select('user_id')
      .eq('event_name', 'provider_switched')
      .not('user_id', 'is', null)
      .gte('event_time', range.start)
      .lt('event_time', range.end),
  ]);

  const countUniqueUsers = (data: Array<{ user_id: string | null }> | null): number => {
    if (!data) return 0;
    const seen = new Set<string>();
    for (const row of data) {
      if (row.user_id) seen.add(row.user_id);
    }
    return seen.size;
  };

  return [
    {
      id: 'watched',
      label: 'Watched',
      description: '≥1 watch_start in the period',
      userCount: countUniqueUsers(watchRes.data as any),
    },
    {
      id: 'searched',
      label: 'Searched',
      description: '≥1 search in the period',
      userCount: countUniqueUsers(searchRes.data as any),
    },
    {
      id: 'favorited',
      label: 'Favorited',
      description: '≥1 favorite_added in the period',
      userCount: countUniqueUsers(favRes.data as any),
    },
    {
      id: 'provider-switcher',
      label: 'Provider Switcher',
      description: '≥1 provider_switched in the period',
      userCount: countUniqueUsers(switchRes.data as any),
    },
  ];
}
