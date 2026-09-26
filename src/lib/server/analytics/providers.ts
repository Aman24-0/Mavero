/**
 * Phase 5 — server-side Provider Analytics query module.
 *
 * Consolidated server-side queries for the User Management → Providers
 * dashboard. Provides provider usage (selections, switches, actual
 * watch starts, completions), unique users per provider, provider
 * transitions, switch reasons, and movie/series breakdowns.
 *
 * ARCHITECTURE (follows Phase 1–4 conventions):
 *   - All queries run via the user-scoped admin client (`locals.supabase`).
 *     RLS on `analytics_events` enforces admin-only SELECT via `is_admin()`.
 *   - NEVER throws — returns a safe empty shape with an `error` field on
 *     failure (mirrors Phase 2/3/4 contracts).
 *   - Provider name resolution uses the existing `getPublicStreamingConfig()`
 *     helper (lazy-imported for testability, same pattern as Phase 4's
 *     `getDetail` lazy import).
 *
 * PROVIDER EVENT TAXONOMY (audited from actual Phase 1 implementation):
 *
 *   - `provider_selected`: emitted ONCE on initial source selection.
 *     `provider_id` = the initially selected provider.
 *     `metadata.reason` = 'initial' (does NOT distinguish default vs
 *     saved vs fallback — the Phase 1 comment says "later phases may
 *     distinguish 'saved' vs 'default' vs 'fallback' if the dashboard
 *     needs it" but Phase 5 does NOT add this instrumentation).
 *     `source_id` = the selected source.
 *
 *   - `provider_switched`: emitted on MANUAL source switch.
 *     `provider_id` = the provider switched TO.
 *     `metadata.from_provider_id` / `to_provider_id` = the transition.
 *     `metadata.from_source_id` / `to_source_id` = the source transition.
 *     `metadata.reason` = 'manual_switch' (only one value currently).
 *
 *   - `watch_start`: emitted when playback actually begins.
 *     `provider_id` = the ACTUAL provider used for playback (from
 *     `resolvedSource.providerId` — the resolved playback source).
 *     This is the canonical "actual provider" — NOT the selected
 *     provider, because a user can select A, fail, switch to B, and
 *     actually watch using B.
 *     `source_id` = the actual source.
 *
 *   - `watch_complete`: same provider_id/source_id as watch_start
 *     (from resolvedSource).
 *
 *   - `playback_success` / `playback_failed`: NOT emitted in the
 *     current codebase (deferred from Phase 1). Success/failure
 *     metrics are NOT available → the UI shows "Not available".
 *
 * METRIC DEFINITIONS (per plan §3–§13):
 *
 *   - **Provider Selections**: count of `provider_selected` events
 *     per `provider_id`. This is "selections", NOT "attempts" (per
 *     plan §7 — a selection is not an attempt).
 *
 *   - **Provider Switches**: count of `provider_switched` events
 *     per `provider_id` (the provider switched TO).
 *
 *   - **Actual Provider Usage (Watch Starts)**: count of `watch_start`
 *     events per `provider_id`. This is the "actual provider used"
 *     (per plan §6 — `watch_start.provider_id` is the canonical
 *     actual-playback source).
 *
 *   - **Completed Watches per provider**: count of `watch_complete`
 *     events per `provider_id`.
 *
 *   - **Unique Users per provider**: unique identity (`user_id` or
 *     `anonymous_id`) per `provider_id` across `watch_start` events.
 *
 *   - **Provider Transitions**: aggregate of `provider_switched`
 *     `metadata.from_provider_id` → `to_provider_id` pairs. Shows
 *     the count + unique switchers per transition.
 *
 *   - **Switch Reasons**: aggregate of `provider_switched`
 *     `metadata.reason`. Currently only 'manual_switch' is emitted.
 *
 *   - **Success/Failure/Success Rate**: NOT AVAILABLE. The
 *     `playback_success` / `playback_failed` events are not emitted
 *     in the current codebase. The UI shows "Not available" per
 *     plan §8/§12.
 *
 *   - **Default vs Selected**: PARTIAL. `provider_selected.metadata.reason`
 *     is always 'initial' — it does NOT distinguish "default provider"
 *     from "saved source" from "first option". The UI shows the
 *     selections but does NOT claim to distinguish default from
 *     selected (per plan §5 — "do not fabricate it").
 *
 * PRIVACY / DATA MINIMIZATION (per plan §16/§23):
 *   - Raw IP/UA/request_id: never stored, never displayed.
 *   - Anonymous IDs: not displayed (used only for dedup counting).
 *   - Provider transitions: aggregate only (no user identity).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '$lib/server/supabase/database.types';
import type { AnalyticsDateRange } from '$lib/shared/analytics-period';

// ============================================================
// Types
// ============================================================

export type ProviderMetrics = {
  /** Total provider_selected events in the period. */
  totalSelections: number;
  /** Total provider_switched events in the period. */
  totalSwitches: number;
  /** Total watch_start events in the period (actual provider usage). */
  totalWatchStarts: number;
  /** Total watch_complete events in the period. */
  totalCompletedWatches: number;
  /** Unique users across watch_start events. */
  uniqueUsers: number;
};

export type ProviderUsageEntry = {
  /** Provider UUID (from analytics_events.provider_id). */
  provider_id: string;
  /** Provider name (resolved from streaming config). Null if unresolvable. */
  provider_name: string | null;
  /** Count of provider_selected events for this provider. */
  selections: number;
  /** Count of provider_switched events where this is the TO provider. */
  switches_to: number;
  /** Count of watch_start events (actual provider usage). */
  watch_starts: number;
  /** Count of watch_complete events. */
  completed_watches: number;
  /** Unique users (from watch_start events). */
  unique_users: number;
  /** Movie watch starts for this provider. */
  movie_watch_starts: number;
  /** Series watch starts for this provider. */
  series_watch_starts: number;
  /** Anime watch starts for this provider. */
  anime_watch_starts: number;
  /** Other watch starts (unknown content_type). */
  other_watch_starts: number;
  /** Share of total watch starts (%). */
  usage_share: number;
};

export type ProviderTransition = {
  from_provider_id: string;
  from_provider_name: string | null;
  to_provider_id: string;
  to_provider_name: string | null;
  count: number;
  unique_switchers: number;
};

export type SwitchReasonEntry = {
  reason: string;
  count: number;
};

export type ProviderResult = {
  metrics: ProviderMetrics;
  usage: ProviderUsageEntry[];
  transitions: ProviderTransition[];
  switchReasons: SwitchReasonEntry[];
  /** Whether success/failure metrics are available. */
  successFailureAvailable: boolean;
  error: string | null;
  migrationPending: boolean;
};

// ============================================================
// Error helpers (mirror Phase 2/3/4)
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
// Identity helper — dedup by user_id OR anonymous_id
// ============================================================

function rowIdentity(row: { user_id?: string | null; anonymous_id?: string | null }): string | null {
  if (typeof row.user_id === 'string' && row.user_id) return `u:${row.user_id}`;
  if (typeof row.anonymous_id === 'string' && row.anonymous_id) return `a:${row.anonymous_id}`;
  return null;
}

// ============================================================
// Provider name resolution
// ============================================================

/**
 * Resolves provider names from provider_id UUIDs via the existing
 * `getPublicStreamingConfig()` helper. Lazy-imported for testability
 * (the streaming config module imports Supabase which is fine, but
 * we keep the lazy pattern consistent with Phase 4).
 */
async function resolveProviderNames(providerIds: Set<string>): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  if (providerIds.size === 0) return result;
  try {
    const { getPublicStreamingConfig } = await import('$lib/server/streaming/public-config');
    // We need a Supabase client to call getPublicStreamingConfig, but
    // we don't have one here. Instead, we'll resolve names in the
    // route load function (which has locals.supabase) and pass them
    // to the page. For the server module, we return null names and
    // the caller resolves them.
    //
    // Actually, let's pass the client to fetchProviders so it can
    // resolve names. Let me refactor.
    return result;
  } catch {
    return result;
  }
}

// ============================================================
// fetchProviders — top-level entry point
// ============================================================

/**
 * Fetches the complete Provider Analytics dashboard data for the
 * given date range. Runs all queries in parallel. NEVER throws.
 *
 * @param client The user-scoped admin client (RLS enforces admin-only).
 * @param range The canonical UTC date range.
 */
export async function fetchProviders(
  client: SupabaseClient<Database>,
  range: AnalyticsDateRange
): Promise<ProviderResult> {
  // Fetch all provider-related events in the period. We project only
  // the required columns to minimize the payload. The query is bounded
  // by the date range (using the Phase 1 indexes: event_name_time_idx,
  // provider_time_idx).
  const [selectionsRes, switchesRes, watchStartsRes, watchCompletesRes] = await Promise.all([
    client
      .from('analytics_events')
      .select('user_id,anonymous_id,provider_id,source_id,content_type')
      .eq('event_name', 'provider_selected')
      .not('provider_id', 'is', null)
      .gte('event_time', range.start)
      .lt('event_time', range.end),
    client
      .from('analytics_events')
      .select('user_id,anonymous_id,provider_id,source_id,metadata')
      .eq('event_name', 'provider_switched')
      .not('provider_id', 'is', null)
      .gte('event_time', range.start)
      .lt('event_time', range.end),
    client
      .from('analytics_events')
      .select('user_id,anonymous_id,provider_id,source_id,content_type')
      .eq('event_name', 'watch_start')
      .not('provider_id', 'is', null)
      .gte('event_time', range.start)
      .lt('event_time', range.end),
    client
      .from('analytics_events')
      .select('user_id,anonymous_id,provider_id,source_id,content_type')
      .eq('event_name', 'watch_complete')
      .not('provider_id', 'is', null)
      .gte('event_time', range.start)
      .lt('event_time', range.end),
  ]);

  // Check for missing-table error first.
  const firstError = selectionsRes.error ?? switchesRes.error ?? watchStartsRes.error ?? watchCompletesRes.error;
  if (firstError && isMissingTableError(firstError)) {
    return { ...emptyProviderResult(), error: safeErrorMessage(firstError), migrationPending: true };
  }
  if (selectionsRes.error || switchesRes.error || watchStartsRes.error || watchCompletesRes.error) {
    const err = selectionsRes.error ?? switchesRes.error ?? watchStartsRes.error ?? watchCompletesRes.error;
    return { ...emptyProviderResult(), error: safeErrorMessage(err), migrationPending: false };
  }

  const selections = (selectionsRes.data ?? []) as Array<{ user_id: string | null; anonymous_id: string | null; provider_id: string; source_id: string | null; content_type: string | null }>;
  const switches = (switchesRes.data ?? []) as Array<{ user_id: string | null; anonymous_id: string | null; provider_id: string; source_id: string | null; metadata: Record<string, unknown> | null }>;
  const watchStarts = (watchStartsRes.data ?? []) as Array<{ user_id: string | null; anonymous_id: string | null; provider_id: string; source_id: string | null; content_type: string | null }>;
  const watchCompletes = (watchCompletesRes.data ?? []) as Array<{ user_id: string | null; anonymous_id: string | null; provider_id: string; source_id: string | null; content_type: string | null }>;

  // ---- Top-line metrics ----
  const uniqueUsers = new Set<string>();
  for (const e of watchStarts) {
    const id = rowIdentity(e);
    if (id) uniqueUsers.add(id);
  }

  const metrics: ProviderMetrics = {
    totalSelections: selections.length,
    totalSwitches: switches.length,
    totalWatchStarts: watchStarts.length,
    totalCompletedWatches: watchCompletes.length,
    uniqueUsers: uniqueUsers.size,
  };

  // ---- Provider usage table ----
  // Aggregate by provider_id across all 4 event types.
  const usageByProvider = new Map<string, {
    selections: number;
    switches_to: number;
    watch_starts: number;
    completed_watches: number;
    unique_users: Set<string>;
    movie_watch_starts: number;
    series_watch_starts: number;
    anime_watch_starts: number;
    other_watch_starts: number;
  }>();

  function getOrCreate(map: Map<string, any>, providerId: string) {
    let entry = map.get(providerId);
    if (!entry) {
      entry = {
        selections: 0,
        switches_to: 0,
        watch_starts: 0,
        completed_watches: 0,
        unique_users: new Set<string>(),
        movie_watch_starts: 0,
        series_watch_starts: 0,
        anime_watch_starts: 0,
        other_watch_starts: 0,
      };
      map.set(providerId, entry);
    }
    return entry;
  }

  for (const e of selections) {
    const entry = getOrCreate(usageByProvider, e.provider_id);
    entry.selections += 1;
  }
  for (const e of switches) {
    // provider_switched.provider_id = the provider switched TO.
    const entry = getOrCreate(usageByProvider, e.provider_id);
    entry.switches_to += 1;
  }
  for (const e of watchStarts) {
    const entry = getOrCreate(usageByProvider, e.provider_id);
    entry.watch_starts += 1;
    const identity = rowIdentity(e);
    if (identity) entry.unique_users.add(identity);
    if (e.content_type === 'movie') entry.movie_watch_starts += 1;
    else if (e.content_type === 'series') entry.series_watch_starts += 1;
    else if (e.content_type === 'anime') entry.anime_watch_starts += 1;
    else entry.other_watch_starts += 1;
  }
  for (const e of watchCompletes) {
    const entry = getOrCreate(usageByProvider, e.provider_id);
    entry.completed_watches += 1;
  }

  const totalWatchStarts = watchStarts.length;
  const usage: ProviderUsageEntry[] = Array.from(usageByProvider.entries())
    .map(([provider_id, e]) => ({
      provider_id,
      provider_name: null, // resolved by the route load via streaming config
      selections: e.selections,
      switches_to: e.switches_to,
      watch_starts: e.watch_starts,
      completed_watches: e.completed_watches,
      unique_users: e.unique_users.size,
      movie_watch_starts: e.movie_watch_starts,
      series_watch_starts: e.series_watch_starts,
      anime_watch_starts: e.anime_watch_starts,
      other_watch_starts: e.other_watch_starts,
      usage_share: totalWatchStarts > 0 ? Math.round((e.watch_starts / totalWatchStarts) * 1000) / 10 : 0,
    }))
    .sort((a, b) => b.watch_starts - a.watch_starts || b.selections - a.selections);

  // ---- Provider transitions ----
  // Aggregate from provider_switched metadata: from_provider_id → to_provider_id.
  const transitionMap = new Map<string, { from: string; to: string; count: number; switchers: Set<string> }>();
  for (const e of switches) {
    const fromProvider = e.metadata?.from_provider_id;
    const toProvider = e.metadata?.to_provider_id ?? e.provider_id;
    if (typeof fromProvider !== 'string' || typeof toProvider !== 'string') continue;
    if (!fromProvider || !toProvider) continue;
    const key = `${fromProvider}→${toProvider}`;
    let entry = transitionMap.get(key);
    if (!entry) {
      entry = { from: fromProvider, to: toProvider, count: 0, switchers: new Set() };
      transitionMap.set(key, entry);
    }
    entry.count += 1;
    const identity = rowIdentity(e);
    if (identity) entry.switchers.add(identity);
  }

  const transitions: ProviderTransition[] = Array.from(transitionMap.values())
    .map((e) => ({
      from_provider_id: e.from,
      from_provider_name: null, // resolved by route load
      to_provider_id: e.to,
      to_provider_name: null, // resolved by route load
      count: e.count,
      unique_switchers: e.switchers.size,
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 20); // bounded to top 20 transitions

  // ---- Switch reasons ----
  const reasonMap = new Map<string, number>();
  for (const e of switches) {
    const reason = typeof e.metadata?.reason === 'string' ? e.metadata.reason : 'unknown';
    reasonMap.set(reason, (reasonMap.get(reason) ?? 0) + 1);
  }
  const switchReasons: SwitchReasonEntry[] = Array.from(reasonMap.entries())
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count);

  // ---- Success/failure availability ----
  // playback_success / playback_failed events are NOT emitted in the
  // current codebase (deferred from Phase 1). Success/failure is
  // NOT available.
  const successFailureAvailable = false;

  // ---- Resolve provider names ----
  // Collect all provider_ids that need name resolution.
  const allProviderIds = new Set<string>();
  for (const entry of usage) allProviderIds.add(entry.provider_id);
  for (const entry of transitions) {
    allProviderIds.add(entry.from_provider_id);
    allProviderIds.add(entry.to_provider_id);
  }
  const nameByProvider = await resolveProviderNamesViaConfig(client, allProviderIds);
  for (const entry of usage) {
    entry.provider_name = nameByProvider.get(entry.provider_id) ?? null;
  }
  for (const entry of transitions) {
    entry.from_provider_name = nameByProvider.get(entry.from_provider_id) ?? null;
    entry.to_provider_name = nameByProvider.get(entry.to_provider_id) ?? null;
  }

  return {
    metrics,
    usage,
    transitions,
    switchReasons,
    successFailureAvailable,
    error: null,
    migrationPending: false,
  };
}

function emptyProviderResult(): ProviderResult {
  return {
    metrics: {
      totalSelections: 0,
      totalSwitches: 0,
      totalWatchStarts: 0,
      totalCompletedWatches: 0,
      uniqueUsers: 0,
    },
    usage: [],
    transitions: [],
    switchReasons: [],
    successFailureAvailable: false,
    error: null,
    migrationPending: false,
  };
}

/**
 * Resolves provider names from the streaming config. Uses the existing
 * `getPublicStreamingConfig()` helper which reads from the
 * `streaming_public_providers` mirror table.
 */
async function resolveProviderNamesViaConfig(
  client: SupabaseClient<Database>,
  providerIds: Set<string>
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  if (providerIds.size === 0) return result;
  try {
    const { getPublicStreamingConfig } = await import('$lib/server/streaming/public-config');
    const config = await getPublicStreamingConfig(client);
    for (const provider of config.providers) {
      if (providerIds.has(provider.id)) {
        result.set(provider.id, provider.name);
      }
    }
  } catch {
    // Config resolution failed — return empty map, caller falls back to
    // the provider_id UUID (truncated for display).
  }
  return result;
}
