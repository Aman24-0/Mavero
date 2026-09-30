/**
 * Phase 1 Analytics Foundation — event taxonomy.
 *
 * Single source of truth for the set of event names the analytics
 * system accepts. The DB CHECK constraint in
 * 20261008000000_analytics_foundation.sql mirrors this list exactly.
 *
 * Adding a new event:
 *   1. Add it to AnalyticsEventName below.
 *   2. Add it to the CHECK constraint via a follow-up migration.
 *   3. Add it to MEANINGFUL_ACTIVITY_EVENTS if it counts toward
 *      "active user" (see §11 of the canonical plan).
 *
 * The taxonomy is intentionally CLOSED. Unknown event names are
 * rejected at ingestion AND at the DB layer. This is auditable
 * friction: every taxonomy change is a migration.
 */

/**
 * The closed set of analytics event names. Mirrors
 * supabase/migrations/20261008000000_analytics_foundation.sql.
 */
export const ANALYTICS_EVENT_NAMES = [
  // Application / session
  'app_open',
  'session_start',
  'session_end',
  // Discovery
  'search',
  'search_result_open',
  'detail_open',
  // Playback
  'watch_start',
  'watch_progress',
  'watch_stop',
  'watch_complete',
  'playback_success',
  'playback_failed',
  // Provider
  'provider_selected',
  'provider_switched',
  // Authentication
  'signup_started',
  'signup_completed',
  'login',
  'logout',
  // Feature events
  'favorite_added',
  'favorite_removed',
  'mylist_open',
  'continue_watching_open',
  'download_started',
  'download_completed',
] as const;

export type AnalyticsEventName = (typeof ANALYTICS_EVENT_NAMES)[number];

/** Set form for O(1) lookup during validation. */
export const ANALYTICS_EVENT_NAME_SET: ReadonlySet<string> = new Set(ANALYTICS_EVENT_NAMES);

/** Returns true if the value is a known analytics event name. */
export function isAnalyticsEventName(value: unknown): value is AnalyticsEventName {
  return typeof value === 'string' && ANALYTICS_EVENT_NAME_SET.has(value);
}

/**
 * The canonical "meaningful activity" event list (per plan §11).
 *
 * A user is considered ACTIVE in a period if they performed at least
 * one of these events during that period. Pure page loads (app_open)
 * are intentionally excluded so refreshing the tab does not inflate
 * the active-user count.
 *
 * This list is centralized here so every later dashboard phase reads
 * from ONE definition rather than redefining "active" per page.
 */
export const MEANINGFUL_ACTIVITY_EVENTS: ReadonlySet<string> = new Set([
  'search',
  'search_result_open',
  'detail_open',
  'watch_start',
  'watch_progress',
  'watch_complete',
  'provider_selected',
  'provider_switched',
  'favorite_added',
  'favorite_removed',
  'mylist_open',
  'continue_watching_open',
  'download_started',
  'download_completed',
  'signup_completed',
  'login',
]);

/** Returns true if the event counts toward "active user". */
export function isMeaningfulActivityEvent(eventName: string): boolean {
  return MEANINGFUL_ACTIVITY_EVENTS.has(eventName);
}
