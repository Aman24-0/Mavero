import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { requireAdmin } from '$lib/server/streaming/admin-auth';
import { fetchUserDetail } from '$lib/server/analytics/users';
import { createSupabaseAdminClient } from '$lib/server/supabase/admin';

/**
 * Phase 3 — User Detail server load.
 *
 * Fetches the full detail for one user: account info, activity summary,
 * recent activity timeline (paginated), viewing history, and guest
 * history (pre-login activity stitched via the Phase 1 anonymous_id ↔
 * user_id co-occurrence model).
 *
 * Authorization: `requireAdmin` is the first call. RLS on
 * `analytics_events` / `analytics_sessions` / `profiles` is the second
 * defense layer.
 *
 * URL state:
 *   - `?page=<n>` — timeline page number (default 1).
 *   - `?pageSize=<n>` — timeline page size (default 25, max 100).
 *
 * The userId comes from the route params (validated as a UUID).
 */
export const load: PageServerLoad = async ({ locals, params, url }) => {
  await requireAdmin(locals, { redirectTo: `/admin/users/${params.userId}` });

  // Validate userId is a UUID (defensive — SvelteKit route matches anything).
  const userId = params.userId;
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!UUID_RE.test(userId)) {
    throw error(400, 'Invalid user identifier.');
  }

  // Parse timeline pagination.
  const timelinePage = Math.max(1, Number(url.searchParams.get('page') ?? '1') || 1);
  const timelinePageSize = Math.max(1, Math.min(100, Number(url.searchParams.get('pageSize') ?? '25') || 25));

  // Create the service-role admin client for profiles + auth.users access.
  let adminClient;
  try {
    adminClient = createSupabaseAdminClient();
  } catch {
    return {
      result: {
        account: null,
        activitySummary: { first_active: null, last_active: null, total_sessions: 0, active_days: 0, watch_starts: 0, completed_watches: 0, watch_progress_events: 0 },
        timeline: { events: [], page: timelinePage, pageSize: timelinePageSize, total: 0, totalIsApproximate: false },
        viewingHistory: [],
        guestHistory: null,
        error: 'Admin configuration is missing. User data is unavailable.',
        migrationPending: false,
      },
      userId,
      timelinePage,
      timelinePageSize,
    };
  }

  // Fetch the user detail (never throws — returns safe empty shape on error).
  const result = await fetchUserDetail(locals.supabase, adminClient, userId, { timelinePage, timelinePageSize });

  // If the user was not found AND there was no analytics error, return 404.
  // (A missing-profile with a real analytics error returns the error state
  // instead of a 404, so the admin sees the error message.)
  if (!result.account && !result.error) {
    throw error(404, 'User not found.');
  }

  return {
    result,
    userId,
    timelinePage,
    timelinePageSize,
  };
};
