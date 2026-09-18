// Phase 3-F (audit OBS-6) — Watch history bounded retention.
//
// Application-level helper for the `prune_old_watch_history(retention_days)`
// SECURITY DEFINER function defined in
// supabase/migrations/20260922000000_phase3_watch_history_retention.sql.
//
// The function is callable from the service-role client (admin trigger)
// OR from Supabase's scheduled reminders / pg_cron (the recommended
// production path — see the migration SQL for the full contract).
//
// This helper exists for:
//   1. Manual admin triggers (e.g. an admin "prune now" button);
//   2. Tests (to verify the retention boundary behavior);
//   3. Future integration with a Supabase scheduled reminder that calls
//      the function via an HTTP edge function (when that infra exists).
//
// IMPORTANT: this helper does NOT run on user-facing requests. Production
// cleanup should run via Supabase scheduled infrastructure, NOT inside
// a SvelteKit endpoint. The helper is exported for admin/test use only.

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '$lib/server/supabase/database.types';

export const DEFAULT_WATCH_HISTORY_RETENTION_DAYS = 180;

/**
 * Minimum retention window. A retention shorter than this would delete
 * recent history that a user might reasonably expect to see. The clamp
 * in the SQL function enforces this server-side too (defense in depth).
 */
export const MIN_WATCH_HISTORY_RETENTION_DAYS = 1;

/**
 * Maximum retention window. A retention longer than 10 years offers no
 * practical benefit and would allow unbounded growth. The clamp in the
 * SQL function enforces this server-side too.
 */
export const MAX_WATCH_HISTORY_RETENTION_DAYS = 3650;

/**
 * Prunes watch_history rows older than `retentionDays`.
 *
 * Calls the `prune_old_watch_history(retention_days)` SECURITY DEFINER
 * function. The function is SECURITY DEFINER so it bypasses RLS — but
 * it only DELETES old rows (no cross-user data leak, no schema change).
 *
 * Requirements:
 *   * The caller MUST use the service-role client (the function is
 *     granted to `authenticated`, but RLS would prevent a user from
 *     deleting other users' rows — the service-role client bypasses
 *     RLS, which is what we want for a global prune).
 *   * `retentionDays` is clamped to [1, 3650] by the SQL function
 *     (defense in depth — the application clamp here matches).
 *
 * Returns the count of deleted rows (for ops dashboards).
 */
export async function pruneWatchHistory(
  client: SupabaseClient<Database>,
  retentionDays: number = DEFAULT_WATCH_HISTORY_RETENTION_DAYS
): Promise<number> {
  const clamped = Math.max(
    MIN_WATCH_HISTORY_RETENTION_DAYS,
    Math.min(MAX_WATCH_HISTORY_RETENTION_DAYS, Math.floor(retentionDays))
  );
  const { data, error } = await client.rpc('prune_old_watch_history', { retention_days: clamped });
  if (error) {
    throw error;
  }
  return typeof data === 'number' ? data : 0;
}
