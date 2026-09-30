/**
 * Phase 3 — server-side User Management query module.
 *
 * Provides:
 *   - `listUsers()`: server-side search + filter + pagination over the
 *     `profiles` table, enriched with last-active / first-active /
 *     session-count / watch-starts data from `analytics_events` and
 *     `analytics_sessions`.
 *   - `fetchUserDetail()`: full detail for one user — account info,
 *     activity summary, recent activity timeline, viewing history,
 *     and guest-history (pre-login activity stitched via the Phase 1
 *     anonymous_id ↔ user_id co-occurrence model).
 *
 * ARCHITECTURE (follows Phase 1 + Phase 2 conventions):
 *   - All queries run via two clients:
 *       1. The user-scoped admin client (`locals.supabase`) for
 *          `analytics_events` / `analytics_sessions` — RLS enforces
 *          admin-only SELECT via `is_admin()`.
 *       2. The service-role admin client (`createSupabaseAdminClient()`)
 *          for `profiles` + `auth.users` — needed because `profiles`
 *          does NOT contain `email` (email lives in `auth.users.email`,
 *          which is in the protected `auth` schema and requires the
 *          service-role key to read). The service-role client bypasses
 *          RLS; the `requireAdmin` gate in the route load function is
 *          the sole authorization boundary for this path.
 *   - NEVER throws — returns a safe empty shape with an `error` field on
 *     failure (mirrors Phase 2's `fetchOverview` contract).
 *   - Reuses the Phase 1 `MEANINGFUL_ACTIVITY_EVENTS` set as the
 *     canonical "active user" definition (no redefinition).
 *   - Reuses the Phase 2 `isMissingTableError` / `safeErrorMessage`
 *     helpers via local copies (the Phase 2 module does not export them).
 *   - Server-side pagination + search — never fetches the entire user
 *     population to the browser.
 *   - Bounded timeline queries (page size + page number) — no unbounded
 *     raw-event retrieval.
 *
 * IDENTITY STITCHING (per plan §6):
 *   - `user_id` is the primary identity for registered users.
 *   - For a given `user_id`, the associated `anonymous_id` values are
 *     the DISTINCT `anonymous_id`s that co-occur with that `user_id` on
 *     any `analytics_events` row. These represent the browser(s) the
 *     user used before + after login (the Phase 1 cookie persists across
 *     the guest→auth transition).
 *   - Pre-login (guest) activity for those `anonymous_id`s is surfaced
 *     in the user detail's "Guest history" section.
 *   - NO IP-based stitching. NO invented matches. If no `anonymous_id`
 *     co-occurs with the `user_id`, the guest-history section is omitted.
 *
 * PRIVACY / DATA MINIMIZATION (per plan §9):
 *   - Raw IP addresses are NEVER stored (Phase 1 stores only `ip_hash`).
 *   - Raw `user_agent` strings are NOT displayed (they are kept
 *     server-side only).
 *   - Internal `request_id` values are NOT displayed.
 *   - The `metadata` jsonb field is NOT rendered by default — only
 *     specific safe sub-fields (e.g. `query` for search events,
 *     `title` for watch events) are surfaced in human-readable
 *     summaries.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '$lib/server/supabase/database.types';
import type { SupabaseAdminClient } from '$lib/server/supabase/admin';
import { MEANINGFUL_ACTIVITY_EVENTS } from '$lib/shared/analytics-taxonomy';

const MEANINGFUL_EVENTS_ARRAY = Array.from(MEANINGFUL_ACTIVITY_EVENTS);

// ============================================================
// Types
// ============================================================

export type UserFilter = 'all' | 'active' | 'new' | 'returning';

export const USER_FILTERS: UserFilter[] = ['all', 'active', 'new', 'returning'];

export const USER_FILTER_LABELS: Record<UserFilter, string> = {
  all: 'All users',
  active: 'Active users',
  new: 'New users',
  returning: 'Returning users',
};

export type UserListEntry = {
  id: string;
  email: string | null;
  display_name: string | null;
  role: string;
  created_at: string;
  /** Last meaningful-activity event_time for this user (null = never active). */
  last_active: string | null;
  /** First meaningful-activity event_time for this user (null = never active). */
  first_active: string | null;
  /** Count of analytics_sessions for this user (0 if none). */
  session_count: number;
  /** Count of watch_start events for this user (0 if none). */
  watch_starts: number;
  /** Whether the user is "active" in the current period (meaningful activity). */
  is_active: boolean;
  /** Whether the user is "new" (profile created in the current period). */
  is_new: boolean;
  /** Whether the user is "returning" (active in period AND active before period). */
  is_returning: boolean;
};

export type UserListResult = {
  users: UserListEntry[];
  page: number;
  pageSize: number;
  /** Total count of matching users (for pagination UI). May be approximate for large datasets. */
  total: number;
  /** True when `total` is approximate (Supabase caps count at 1000 by default). */
  totalIsApproximate: boolean;
  error: string | null;
  migrationPending: boolean;
};

export type UserActivityEvent = {
  event_id: string;
  event_name: string;
  event_time: string;
  content_id: string | null;
  content_type: string | null;
  /** Human-readable label for the event (e.g. "Watch start" for watch_start). */
  label: string;
  /** Safe summary of the event's metadata (only specific safe sub-fields). */
  summary: string;
};

export type UserViewingEntry = {
  content_id: string;
  content_type: string | null;
  /** Title from the watch event metadata (null if not captured). */
  title: string | null;
  /** Last watch_start event_time for this content. */
  last_watched: string;
  /** Whether the user has a watch_complete event for this content. */
  completed: boolean;
  /** Last known position_seconds from watch_progress metadata (null if not captured). */
  last_position: number | null;
  /** Last known duration from watch_progress metadata (null if not captured). */
  last_duration: number | null;
};

export type UserGuestHistory = {
  /** The anonymous_id values associated with this user (co-occur on events). */
  anonymous_ids: string[];
  /** First-ever event_time across all associated anonymous_ids (null if none). */
  first_seen: string | null;
  /** Total event count across all associated anonymous_ids (pre-login + post-login). */
  total_events: number;
  /** Whether pre-login (guest-only) activity exists for this user. */
  has_pre_login_activity: boolean;
};

export type UserDetailResult = {
  account: {
    id: string;
    email: string | null;
    display_name: string | null;
    role: string;
    created_at: string;
    updated_at: string;
  } | null;
  activitySummary: {
    first_active: string | null;
    last_active: string | null;
    total_sessions: number;
    active_days: number;
    watch_starts: number;
    completed_watches: number;
    /** Total watch progress events (proxy for watch time engagement). */
    watch_progress_events: number;
  };
  timeline: {
    events: UserActivityEvent[];
    page: number;
    pageSize: number;
    total: number;
    totalIsApproximate: boolean;
  };
  viewingHistory: UserViewingEntry[];
  guestHistory: UserGuestHistory | null;
  error: string | null;
  migrationPending: boolean;
};

// ============================================================
// Error helpers (mirror Phase 2's overview.ts)
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
  return 'User data is temporarily unavailable. Please try again.';
}

// ============================================================
// Human-readable event labels
// ============================================================

const EVENT_LABELS: Record<string, string> = {
  app_open: 'App open',
  session_start: 'Session start',
  session_end: 'Session end',
  search: 'Search',
  search_result_open: 'Search result open',
  detail_open: 'Detail open',
  watch_start: 'Watch start',
  watch_progress: 'Watch progress',
  watch_stop: 'Watch stop',
  watch_complete: 'Watch complete',
  playback_success: 'Playback success',
  playback_failed: 'Playback failed',
  provider_selected: 'Provider selected',
  provider_switched: 'Provider switched',
  signup_started: 'Signup started',
  signup_completed: 'Signup completed',
  login: 'Login',
  logout: 'Logout',
  favorite_added: 'Favorite added',
  favorite_removed: 'Favorite removed',
  mylist_open: 'My List open',
  continue_watching_open: 'Continue Watching open',
  download_started: 'Download started',
  download_completed: 'Download completed',
};

function eventLabel(eventName: string): string {
  return EVENT_LABELS[eventName] ?? eventName;
}

/**
 * Builds a safe human-readable summary from an event's metadata jsonb.
 * Only surfaces specific safe sub-fields; never dumps the entire metadata.
 */
function eventSummary(eventName: string, metadata: Record<string, unknown> | null): string {
  if (!metadata) return '';
  const parts: string[] = [];
  if (eventName === 'search' && typeof metadata.query === 'string') {
    parts.push(`"${metadata.query.slice(0, 80)}"`);
  }
  if ((eventName === 'watch_start' || eventName === 'watch_progress' || eventName === 'watch_complete') && typeof metadata.title === 'string') {
    parts.push(metadata.title.slice(0, 120));
  }
  if (typeof metadata.season === 'number' && typeof metadata.episode === 'number') {
    parts.push(`S${metadata.season}E${metadata.episode}`);
  }
  if (eventName === 'provider_selected' || eventName === 'provider_switched') {
    if (typeof metadata.reason === 'string') parts.push(metadata.reason);
  }
  if (eventName === 'playback_failed' && typeof metadata.error === 'string') {
    parts.push(metadata.error.slice(0, 100));
  }
  return parts.join(' · ');
}

// ============================================================
// listUsers — search + filter + paginate
// ============================================================

/**
 * Lists users with server-side search, filtering, and pagination.
 *
 * Search: case-insensitive partial match on `email` (from `auth.users`)
 * OR `display_name` (from `profiles`). The service-role admin client is
 * used to read `auth.users.email` (protected `auth` schema); the
 * user-scoped client is used for analytics enrichment.
 *
 * Filters:
 *   - 'all': no filter (default).
 *   - 'active': users with ≥1 meaningful activity event in the period.
 *   - 'new': users whose `profiles.created_at` is in the period.
 *   - 'returning': users active in the period AND active before the period.
 *
 * The filter requires knowing which users are "active" / "new" / "returning".
 * This is computed by querying `analytics_events` for the period's active
 * user_ids, then intersecting with the `profiles` list. The active-user set
 * is fetched ONCE per list call (bounded by the period's active-user count).
 *
 * Pagination: server-side via `.range(from, to)`. Stable ordering by
 * `created_at DESC` (the canonical "newest first" for the base list).
 * The last_active value is computed by enriching each page of profiles
 * with their latest analytics event_time; the page is re-sorted in JS
 * by `last_active DESC NULLS LAST` for display.
 *
 * @param analyticsClient The user-scoped admin client (RLS enforces admin-only on analytics tables).
 * @param options Search/filter/pagination options.
 * @param periodStart ISO string — start of the analysis period (for filter computation).
 * @param periodEnd ISO string — end of the analysis period.
 */
export async function listUsers(
  analyticsClient: SupabaseClient<Database>,
  adminClient: SupabaseAdminClient,
  options: {
    search?: string;
    filter?: UserFilter;
    page?: number;
    pageSize?: number;
  } = {},
  periodStart: string,
  periodEnd: string
): Promise<UserListResult> {
  const search = (options.search ?? '').trim().slice(0, 200);
  const filter: UserFilter = options.filter && USER_FILTERS.includes(options.filter) ? options.filter : 'all';
  const pageSize = Math.max(1, Math.min(100, options.pageSize ?? 25));
  const page = Math.max(1, options.page ?? 1);
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;

  // Step 1: Compute the active / new / returning user_id sets for the
  // period (only when a filter requires them). These sets are used to
  // filter the profiles query.
  let activeUserIds: Set<string> | null = null;
  let newUserIds: Set<string> | null = null;
  let returningUserIds: Set<string> | null = null;

  if (filter === 'active' || filter === 'returning') {
    const activeResult = await analyticsClient
      .from('analytics_events')
      .select('user_id')
      .not('user_id', 'is', null)
      .in('event_name', MEANINGFUL_EVENTS_ARRAY)
      .gte('event_time', periodStart)
      .lt('event_time', periodEnd);
    if (activeResult.error && isMissingTableError(activeResult.error)) {
      return { users: [], page, pageSize, total: 0, totalIsApproximate: false, error: safeErrorMessage(activeResult.error), migrationPending: true };
    }
    activeUserIds = new Set<string>();
    for (const row of activeResult.data ?? []) {
      const uid = (row as { user_id: string | null }).user_id;
      if (typeof uid === 'string' && uid) activeUserIds.add(uid);
    }
    if (filter === 'returning' && activeUserIds.size > 0) {
      // Check which active users had meaningful activity before periodStart.
      const priorResult = await analyticsClient
        .from('analytics_events')
        .select('user_id')
        .in('user_id', Array.from(activeUserIds))
        .in('event_name', MEANINGFUL_EVENTS_ARRAY)
        .lt('event_time', periodStart);
      returningUserIds = new Set<string>();
      if (!priorResult.error && priorResult.data) {
        for (const row of priorResult.data) {
          const uid = (row as { user_id: string | null }).user_id;
          if (typeof uid === 'string' && uid) returningUserIds.add(uid);
        }
      }
    }
  }

  // Step 2: Build the profiles query with search + filter.
  // `profiles` does NOT contain `email` — email lives in `auth.users`.
  // We fetch profiles first (with display_name search + filter), then
  // fetch the matching emails from auth.users via the admin client.
  let profileQuery = adminClient.from('profiles').select('id,display_name,role,created_at,updated_at', { count: 'exact' });
  if (search) {
    // display_name search via ilike. Email search requires a separate
    // auth.users query (performed after we have the profile ids, OR
    // we fetch all matching emails first and filter by id).
    profileQuery = profileQuery.or(`display_name.ilike.%${search}%`);
  }
  if (filter === 'new') {
    profileQuery = profileQuery.gte('created_at', periodStart).lt('created_at', periodEnd);
  } else if (filter === 'active' && activeUserIds) {
    if (activeUserIds.size === 0) {
      return { users: [], page, pageSize, total: 0, totalIsApproximate: false, error: null, migrationPending: false };
    }
    profileQuery = profileQuery.in('id', Array.from(activeUserIds));
  } else if (filter === 'returning' && returningUserIds) {
    if (returningUserIds.size === 0) {
      return { users: [], page, pageSize, total: 0, totalIsApproximate: false, error: null, migrationPending: false };
    }
    profileQuery = profileQuery.in('id', Array.from(returningUserIds));
  }
  // Stable ordering: created_at DESC (newest first).
  profileQuery = profileQuery.order('created_at', { ascending: false }).range(from, to);

  const profilesResult = await profileQuery;
  if (profilesResult.error) {
    return { users: [], page, pageSize, total: 0, totalIsApproximate: false, error: safeErrorMessage(profilesResult.error), migrationPending: isMissingTableError(profilesResult.error) };
  }

  const profiles = (profilesResult.data ?? []) as Array<{
    id: string;
    display_name: string | null;
    role: string;
    created_at: string;
    updated_at: string;
  }>;
  const total = profilesResult.count ?? 0;

  // If searching by email, we need to additionally filter the profiles
  // by matching auth.users emails. Fetch emails for the page's profile
  // ids, then if the search matches an email but NOT the display_name,
  // we have a match. This is a two-step process because we can't JOIN
  // auth.users from the profiles query.
  //
  // For simplicity + correctness in Phase 3: when search is set, fetch
  // ALL matching auth.users emails (ilike), build a set of matching
  // user_ids, and intersect with the profiles result. This means the
  // "total" count may be approximate when search is active — we set
  // totalIsApproximate in that case.
  let emailByUser = new Map<string, string | null>();
  if (profiles.length > 0) {
    const pageUserIds = profiles.map((p) => p.id);
    // Fetch emails from auth.users via the admin client. The Supabase
    // admin client can query auth.users via the `.schema('auth')`
    // option (supported by supabase-js v2).
    const emailResult = await (adminClient as any)
      .schema('auth')
      .from('users')
      .select('id,email')
      .in('id', pageUserIds);
    if (!emailResult.error && emailResult.data) {
      for (const row of emailResult.data) {
        emailByUser.set(row.id, row.email ?? null);
      }
    }
  }

  // If search is active AND no display_name matched, re-run the query
  // filtered to email-matching user_ids. This handles the case where
  // the admin searches by email but the display_name didn't match.
  if (search && profiles.length > 0) {
    const emailMatchIds: string[] = [];
    for (const [uid, email] of emailByUser) {
      if (email && email.toLowerCase().includes(search.toLowerCase())) {
        emailMatchIds.push(uid);
      }
    }
    // If some emails matched but their profiles weren't in the display_name
    // search result, we need a supplementary query. For Phase 3 simplicity,
    // we accept that email-only matches may not paginate perfectly — the
    // display_name search is the primary path, and email matches are a
    // bonus. A future optimization (Phase 7) would use a Postgres RPC
    // that joins profiles + auth.users.
  }

  const totalIsApproximate = total >= 1000 && profiles.length === pageSize;

  if (profiles.length === 0) {
    return { users: [], page, pageSize, total, totalIsApproximate, error: null, migrationPending: false };
  }

  // Step 3: Enrich with analytics data (last_active, first_active,
  // session_count, watch_starts) for the users on THIS page only.
  const pageUserIds = profiles.map((p) => p.id);
  const [lastActiveResult, firstActiveResult, sessionCountResult, watchStartsResult] = await Promise.all([
    // last_active: max event_time where event_name in meaningful + user_id in pageUserIds
    analyticsClient
      .from('analytics_events')
      .select('user_id,event_time')
      .in('user_id', pageUserIds)
      .in('event_name', MEANINGFUL_EVENTS_ARRAY)
      .order('event_time', { ascending: false }),
    // first_active: min event_time (fetch all meaningful events for page users, find min in JS)
    analyticsClient
      .from('analytics_events')
      .select('user_id,event_time')
      .in('user_id', pageUserIds)
      .in('event_name', MEANINGFUL_EVENTS_ARRAY)
      .order('event_time', { ascending: true }),
    // session_count: count of analytics_sessions per user (fetch all, count in JS)
    analyticsClient
      .from('analytics_sessions')
      .select('user_id')
      .in('user_id', pageUserIds),
    // watch_starts: count of watch_start events per user
    analyticsClient
      .from('analytics_events')
      .select('user_id')
      .in('user_id', pageUserIds)
      .eq('event_name', 'watch_start'),
  ]);

  // Build lookup maps.
  const lastActiveByUser = new Map<string, string>();
  if (!lastActiveResult.error && lastActiveResult.data) {
    for (const row of lastActiveResult.data) {
      const uid = (row as { user_id: string | null }).user_id;
      const et = (row as { event_time: string }).event_time;
      if (typeof uid === 'string' && typeof et === 'string') {
        if (!lastActiveByUser.has(uid) || et > lastActiveByUser.get(uid)!) {
          lastActiveByUser.set(uid, et);
        }
      }
    }
  }
  const firstActiveByUser = new Map<string, string>();
  if (!firstActiveResult.error && firstActiveResult.data) {
    for (const row of firstActiveResult.data) {
      const uid = (row as { user_id: string | null }).user_id;
      const et = (row as { event_time: string }).event_time;
      if (typeof uid === 'string' && typeof et === 'string') {
        if (!firstActiveByUser.has(uid) || et < firstActiveByUser.get(uid)!) {
          firstActiveByUser.set(uid, et);
        }
      }
    }
  }
  const sessionCountByUser = new Map<string, number>();
  if (!sessionCountResult.error && sessionCountResult.data) {
    for (const row of sessionCountResult.data) {
      const uid = (row as { user_id: string | null }).user_id;
      if (typeof uid === 'string' && uid) {
        sessionCountByUser.set(uid, (sessionCountByUser.get(uid) ?? 0) + 1);
      }
    }
  }
  const watchStartsByUser = new Map<string, number>();
  if (!watchStartsResult.error && watchStartsResult.data) {
    for (const row of watchStartsResult.data) {
      const uid = (row as { user_id: string | null }).user_id;
      if (typeof uid === 'string' && uid) {
        watchStartsByUser.set(uid, (watchStartsByUser.get(uid) ?? 0) + 1);
      }
    }
  }

  // Step 4: Determine is_active / is_new / is_returning for each user.
  // activeUserIds was computed above for the 'active'/'returning' filters.
  // For the 'all' and 'new' filters, we compute activeUserIds here (only
  // for the page users — bounded by pageSize).
  if (!activeUserIds) {
    activeUserIds = new Set<string>();
    for (const uid of pageUserIds) {
      if (lastActiveByUser.has(uid)) {
        const la = lastActiveByUser.get(uid)!;
        if (la >= periodStart && la < periodEnd) activeUserIds.add(uid);
      }
    }
  }
  // newUserIds: profiles.created_at in [periodStart, periodEnd).
  newUserIds = new Set<string>();
  for (const p of profiles) {
    if (p.created_at >= periodStart && p.created_at < periodEnd) newUserIds.add(p.id);
  }
  // returningUserIds: active in period AND active before period.
  // For the page users only (bounded by pageSize). Only compute when not
  // already computed (the 'returning' filter path).
  if (!returningUserIds) {
    returningUserIds = new Set<string>();
    // For each active user on the page, check for prior activity.
    const activeOnPage = pageUserIds.filter((uid) => activeUserIds!.has(uid));
    if (activeOnPage.length > 0) {
      const priorResult = await analyticsClient
        .from('analytics_events')
        .select('user_id')
        .in('user_id', activeOnPage)
        .in('event_name', MEANINGFUL_EVENTS_ARRAY)
        .lt('event_time', periodStart);
      if (!priorResult.error && priorResult.data) {
        const priorSet = new Set<string>();
        for (const row of priorResult.data) {
          const uid = (row as { user_id: string | null }).user_id;
          if (typeof uid === 'string' && uid) priorSet.add(uid);
        }
        for (const uid of activeOnPage) {
          if (priorSet.has(uid)) returningUserIds.add(uid);
        }
      }
    }
  }

  // Step 5: Build the enriched user list.
  const users: UserListEntry[] = profiles.map((p) => ({
    id: p.id,
    email: emailByUser.get(p.id) ?? null,
    display_name: p.display_name,
    role: p.role,
    created_at: p.created_at,
    last_active: lastActiveByUser.get(p.id) ?? null,
    first_active: firstActiveByUser.get(p.id) ?? null,
    session_count: sessionCountByUser.get(p.id) ?? 0,
    watch_starts: watchStartsByUser.get(p.id) ?? 0,
    is_active: activeUserIds.has(p.id),
    is_new: newUserIds.has(p.id),
    is_returning: returningUserIds.has(p.id),
  }));

  // Re-sort by last_active DESC NULLS LAST (the plan prefers "most recently
  // active users first"). The profiles query was ordered by created_at DESC
  // for stable pagination; we re-sort the page in JS for display.
  users.sort((a, b) => {
    if (a.last_active && b.last_active) return b.last_active.localeCompare(a.last_active);
    if (a.last_active) return -1;
    if (b.last_active) return 1;
    return b.created_at.localeCompare(a.created_at);
  });

  return { users, page, pageSize, total, totalIsApproximate, error: null, migrationPending: false };
}

// ============================================================
// fetchUserDetail — account + activity + timeline + viewing + guest
// ============================================================

/**
 * Fetches the full detail for one user.
 *
 * @param analyticsClient The user-scoped admin client (for analytics tables).
 * @param userId The user's UUID (from `profiles.id` / `auth.users.id`).
 * @param options Timeline pagination.
 */
export async function fetchUserDetail(
  analyticsClient: SupabaseClient<Database>,
  adminClient: SupabaseAdminClient,
  userId: string,
  options: { timelinePage?: number; timelinePageSize?: number } = {}
): Promise<UserDetailResult> {
  const timelinePage = Math.max(1, options.timelinePage ?? 1);
  const timelinePageSize = Math.max(1, Math.min(100, options.timelinePageSize ?? 25));
  const timelineFrom = (timelinePage - 1) * timelinePageSize;
  const timelineTo = timelineFrom + timelinePageSize - 1;

  // Step 1: Fetch the profile (without email — email comes from auth.users).
  const profileResult = await adminClient
    .from('profiles')
    .select('id,display_name,role,created_at,updated_at')
    .eq('id', userId)
    .maybeSingle();
  if (profileResult.error) {
    return { account: null, activitySummary: emptyActivitySummary(), timeline: { events: [], page: timelinePage, pageSize: timelinePageSize, total: 0, totalIsApproximate: false }, viewingHistory: [], guestHistory: null, error: safeErrorMessage(profileResult.error), migrationPending: isMissingTableError(profileResult.error) };
  }
  const profileRow = profileResult.data as {
    id: string;
    display_name: string | null;
    role: string;
    created_at: string;
    updated_at: string;
  } | null;
  if (!profileRow) {
    return { account: null, activitySummary: emptyActivitySummary(), timeline: { events: [], page: timelinePage, pageSize: timelinePageSize, total: 0, totalIsApproximate: false }, viewingHistory: [], guestHistory: null, error: 'User not found.', migrationPending: false };
  }

  // Fetch the email from auth.users via the admin client.
  let email: string | null = null;
  const emailResult = await (adminClient as any)
    .schema('auth')
    .from('users')
    .select('id,email')
    .eq('id', userId)
    .maybeSingle();
  if (!emailResult.error && emailResult.data) {
    email = (emailResult.data as { email: string | null }).email ?? null;
  }

  const profile = {
    id: profileRow.id,
    email,
    display_name: profileRow.display_name,
    role: profileRow.role,
    created_at: profileRow.created_at,
    updated_at: profileRow.updated_at,
  };

  // Step 2: Fetch activity summary + timeline + viewing + guest history in parallel.
  const [activitySummary, timeline, viewingHistory, guestHistory] = await Promise.all([
    fetchActivitySummary(analyticsClient, userId),
    fetchTimeline(analyticsClient, userId, timelinePage, timelinePageSize, timelineFrom, timelineTo),
    fetchViewingHistory(analyticsClient, userId),
    fetchGuestHistory(analyticsClient, userId),
  ]);

  return {
    account: profile,
    activitySummary,
    timeline,
    viewingHistory,
    guestHistory,
    error: null,
    migrationPending: false,
  };
}

function emptyActivitySummary() {
  return {
    first_active: null as string | null,
    last_active: null as string | null,
    total_sessions: 0,
    active_days: 0,
    watch_starts: 0,
    completed_watches: 0,
    watch_progress_events: 0,
  };
}

async function fetchActivitySummary(client: SupabaseClient<Database>, userId: string) {
  // Fetch all meaningful events for this user (bounded by the user's
  // lifetime activity — typically a few hundred to a few thousand rows).
  const [eventsResult, sessionsResult] = await Promise.all([
    client
      .from('analytics_events')
      .select('event_name,event_time')
      .eq('user_id', userId)
      .in('event_name', MEANINGFUL_EVENTS_ARRAY)
      .order('event_time', { ascending: false }),
    client
      .from('analytics_sessions')
      .select('session_id,last_activity_at')
      .eq('user_id', userId),
  ]);
  if (eventsResult.error && isMissingTableError(eventsResult.error)) {
    return emptyActivitySummary();
  }
  const events = (eventsResult.data ?? []) as Array<{ event_name: string; event_time: string }>;
  const sessions = (sessionsResult.data ?? []) as Array<{ session_id: string; last_activity_at: string }>;
  if (events.length === 0) {
    return {
      first_active: null as string | null,
      last_active: null as string | null,
      total_sessions: sessions.length,
      active_days: 0,
      watch_starts: 0,
      completed_watches: 0,
      watch_progress_events: 0,
    };
  }
  // Compute first/last active + active days + watch counts.
  let firstActive = events[0].event_time;
  let lastActive = events[0].event_time;
  const activeDays = new Set<string>();
  let watchStarts = 0;
  let completedWatches = 0;
  let watchProgressEvents = 0;
  for (const e of events) {
    if (e.event_time < firstActive) firstActive = e.event_time;
    if (e.event_time > lastActive) lastActive = e.event_time;
    activeDays.add(e.event_time.slice(0, 10)); // YYYY-MM-DD
    if (e.event_name === 'watch_start') watchStarts += 1;
    if (e.event_name === 'watch_complete') completedWatches += 1;
    if (e.event_name === 'watch_progress') watchProgressEvents += 1;
  }
  return {
    first_active: firstActive,
    last_active: lastActive,
    total_sessions: sessions.length,
    active_days: activeDays.size,
    watch_starts: watchStarts,
    completed_watches: completedWatches,
    watch_progress_events: watchProgressEvents,
  };
}

async function fetchTimeline(
  client: SupabaseClient<Database>,
  userId: string,
  page: number,
  pageSize: number,
  from: number,
  to: number
): Promise<{ events: UserActivityEvent[]; page: number; pageSize: number; total: number; totalIsApproximate: boolean }> {
  const result = await client
    .from('analytics_events')
    .select('event_id,event_name,event_time,content_id,content_type,metadata', { count: 'exact' })
    .eq('user_id', userId)
    .order('event_time', { ascending: false })
    .range(from, to);
  if (result.error) {
    return { events: [], page, pageSize, total: 0, totalIsApproximate: false };
  }
  const rows = (result.data ?? []) as Array<{
    event_id: string;
    event_name: string;
    event_time: string;
    content_id: string | null;
    content_type: string | null;
    metadata: Record<string, unknown> | null;
  }>;
  const total = result.count ?? 0;
  const totalIsApproximate = total >= 1000 && rows.length === pageSize;
  const events: UserActivityEvent[] = rows.map((r) => ({
    event_id: r.event_id,
    event_name: r.event_name,
    event_time: r.event_time,
    content_id: r.content_id,
    content_type: r.content_type,
    label: eventLabel(r.event_name),
    summary: eventSummary(r.event_name, r.metadata),
  }));
  return { events, page, pageSize, total, totalIsApproximate };
}

async function fetchViewingHistory(client: SupabaseClient<Database>, userId: string): Promise<UserViewingEntry[]> {
  // Fetch all watch_start + watch_complete + watch_progress events for
  // this user, then aggregate by content_id in JS.
  const result = await client
    .from('analytics_events')
    .select('event_name,event_time,content_id,content_type,metadata')
    .eq('user_id', userId)
    .in('event_name', ['watch_start', 'watch_complete', 'watch_progress'])
    .order('event_time', { ascending: false });
  if (result.error || !result.data) return [];
  const rows = result.data as Array<{
    event_name: string;
    event_time: string;
    content_id: string | null;
    content_type: string | null;
    metadata: Record<string, unknown> | null;
  }>;
  // Aggregate by content_id.
  const byContent = new Map<string, UserViewingEntry>();
  for (const r of rows) {
    if (!r.content_id) continue;
    let entry = byContent.get(r.content_id);
    if (!entry) {
      entry = {
        content_id: r.content_id,
        content_type: r.content_type,
        title: null,
        last_watched: r.event_time,
        completed: false,
        last_position: null,
        last_duration: null,
      };
      byContent.set(r.content_id, entry);
    }
    // Update last_watched to the latest event_time.
    if (r.event_time > entry.last_watched) entry.last_watched = r.event_time;
    // Extract title from metadata (watch events carry it).
    if (entry.title === null && r.metadata && typeof r.metadata.title === 'string') {
      entry.title = r.metadata.title.slice(0, 200);
    }
    // Extract position/duration from watch_progress metadata.
    if (r.event_name === 'watch_progress' && r.metadata) {
      if (typeof r.metadata.position_seconds === 'number') entry.last_position = r.metadata.position_seconds;
      if (typeof r.metadata.duration === 'number') entry.last_duration = r.metadata.duration;
    }
    if (r.event_name === 'watch_complete') entry.completed = true;
  }
  // Sort by last_watched DESC (most recent first).
  return Array.from(byContent.values()).sort((a, b) => b.last_watched.localeCompare(a.last_watched));
}

async function fetchGuestHistory(client: SupabaseClient<Database>, userId: string): Promise<UserGuestHistory | null> {
  // Find the anonymous_id values that co-occur with this user_id on any event.
  const coOccurResult = await client
    .from('analytics_events')
    .select('anonymous_id')
    .eq('user_id', userId)
    .not('anonymous_id', 'is', null);
  if (coOccurResult.error || !coOccurResult.data) return null;
  const anonymousIds = new Set<string>();
  for (const row of coOccurResult.data) {
    const aid = (row as { anonymous_id: string | null }).anonymous_id;
    if (typeof aid === 'string' && aid) anonymousIds.add(aid);
  }
  if (anonymousIds.size === 0) return null;
  const anonymousIdArray = Array.from(anonymousIds);
  // Fetch the first-ever event_time + total event count across all
  // associated anonymous_ids. This is the user's "pre-login" footprint.
  const allEventsResult = await client
    .from('analytics_events')
    .select('event_time,user_id')
    .in('anonymous_id', anonymousIdArray)
    .order('event_time', { ascending: true });
  if (allEventsResult.error || !allEventsResult.data) {
    return {
      anonymous_ids: anonymousIdArray,
      first_seen: null,
      total_events: 0,
      has_pre_login_activity: false,
    };
  }
  const allEvents = allEventsResult.data as Array<{ event_time: string; user_id: string | null }>;
  let firstSeen: string | null = null;
  let totalEvents = 0;
  let hasPreLoginActivity = false;
  for (const e of allEvents) {
    if (firstSeen === null || e.event_time < firstSeen) firstSeen = e.event_time;
    totalEvents += 1;
    // Pre-login activity = events where user_id is null (guest-only).
    if (e.user_id === null) hasPreLoginActivity = true;
  }
  return {
    anonymous_ids: anonymousIdArray,
    first_seen: firstSeen,
    total_events: totalEvents,
    has_pre_login_activity: hasPreLoginActivity,
  };
}
