/**
 * Phase 4 — server-side Viewing & Discovery analytics query module.
 *
 * Consolidated server-side queries for the User Management → Viewing
 * dashboard. Provides viewing metrics (unique viewers, watch starts,
 * completed watches, watch time, movies vs series), content rankings
 * (most watched/started/completed), genre breakdown, and discovery/
 * search analytics (total searches, unique searchers, most searched
 * queries, no-result searches).
 *
 * ARCHITECTURE (follows Phase 1 + Phase 2 + Phase 3 conventions):
 *   - All queries run via the user-scoped admin client (`locals.supabase`).
 *     RLS on `analytics_events` enforces admin-only SELECT via `is_admin()`.
 *   - NEVER throws — returns a safe empty shape with an `error` field on
 *     failure (mirrors Phase 2's `fetchOverview` and Phase 3's
 *     `listUsers`/`fetchUserDetail` contracts).
 *   - Reuses the Phase 1 `MEANINGFUL_ACTIVITY_EVENTS` set where
 *     appropriate (no redefinition).
 *   - Reuses the Phase 2 `isMissingTableError` / `safeErrorMessage`
 *     helpers via local copies.
 *   - Content metadata (title, genres) is resolved via the existing
 *     `getDetail(type, id)` helper from `src/lib/server/content/service.ts`.
 *     This is bounded to the top-N content IDs to avoid N+1 queries.
 *
 * METRIC DEFINITIONS (per plan §5–§17):
 *
 *   - **Unique Viewers**: unique identity (`user_id` for authenticated
 *     events, `anonymous_id` for guest events) across `watch_start`
 *     events in the period. A user is counted ONCE per period regardless
 *     of how many watch_start events they generated.
 *
 *   - **Watch Starts**: count of `watch_start` events in the period.
 *     NOT deduplicated — each watch_start is a separate playback
 *     initiation (per plan §6).
 *
 *   - **Completed Watches**: count of `watch_complete` events in the
 *     period. Uses the EXPLICIT `watch_complete` event — NO 90%
 *     threshold, NO inference from `watch_progress` (per plan §7).
 *
 *   - **Watch Time**: APPROXIMATE. Computed from `watch_progress` event
 *     metadata (`position_seconds` + `duration`). For each (content_id,
 *     identity) pair, the MAX `position_seconds` is taken as the
 *     "furthest point reached", then summed across all pairs. This is
 *     an approximation because: (a) it assumes linear progress (no
 *     seeking backward), (b) it counts the furthest point, not actual
 *     watch time, (c) it does not account for pause/leave time. The
 *     metric is labeled "approximate" in the UI per plan §8.
 *
 *   - **Movies vs Series**: breakdown by `content_type` field on
 *     watch_start / watch_complete events. Values: `movie`, `series`,
 *     `anime`. Unknown/null content_type is placed in an "Other" bucket
 *     (per plan §9 — never silently classified as movie or series).
 *
 *   - **Most Watched / Most Started / Most Completed**: content_id
 *     ranking by watch_start count / watch_start count / watch_complete
 *     count respectively. Title + type resolved via `getDetail()`.
 *     Bounded to top 20 to avoid N+1 metadata resolution.
 *
 *   - **Trending**: descriptive ranking only — watch_start count in
 *     the selected period. NO proprietary "trend score" (per plan §13).
 *     The same ranking as "Most Started" but presented as "Trending in
 *     the selected period" to communicate the transparent definition.
 *
 *   - **Genre Analytics**: for the top-N most-watched content IDs,
 *     resolve genres via `getDetail()` and aggregate watch_start count
 *     by genre. Bounded to top 20 content IDs (per plan §14 — no
 *     metadata duplication; join existing canonical content metadata).
 *
 *   - **Search Total**: count of `search` events in the period.
 *   - **Unique Searchers**: unique identity across `search` events.
 *   - **Most Searched Queries**: aggregate `search` event metadata
 *     `query` field, trimmed + lowercased for aggregation (per plan
 *     §18). Bounded to top 20.
 *   - **No-Result Searches**: count of `search` events where metadata
 *     `result_count === 0` (per plan §17 — the search event stores
 *     `result_count` in metadata, so no-result CAN be determined).
 *
 * PRIVACY / DATA MINIMIZATION (per plan §16):
 *   - Raw IP addresses: never stored (Phase 1) and never displayed.
 *   - Raw user_agent: not selected or displayed.
 *   - Internal request_id: not selected or displayed.
 *   - Anonymous IDs: not displayed (used only for dedup counting).
 *   - Search queries: shown only as aggregate text (no user identity
 *     alongside search terms).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '$lib/server/supabase/database.types';
import type { AnalyticsDateRange } from '$lib/shared/analytics-period';

// `getDetail` is imported lazily inside `resolveContentTitles` /
// `computeGenreBreakdown` to avoid pulling the TMDB adapter (which
// imports `$env/dynamic/private`) into the module's top-level import
// graph. This keeps the module importable by `tsx` in the test
// environment (where `$env` is not available).

// ============================================================
// Types
// ============================================================

export type ViewingMetrics = {
  uniqueViewers: number;
  watchStarts: number;
  completedWatches: number;
  /** Approximate watch time in seconds (from watch_progress max position_seconds). Labeled "approximate". */
  watchTimeSeconds: number | null;
  movieWatchStarts: number;
  seriesWatchStarts: number;
  animeWatchStarts: number;
  otherWatchStarts: number;
  movieCompletedWatches: number;
  seriesCompletedWatches: number;
  animeCompletedWatches: number;
  otherCompletedWatches: number;
};

export type ContentRankingEntry = {
  content_id: string;
  content_type: string | null;
  /** Title resolved via getDetail(); null if unresolvable. */
  title: string | null;
  /** Count of the ranking metric (watch_starts or watch_completes). */
  count: number;
  /** Unique viewers for this content. */
  unique_viewers: number;
};

export type GenreEntry = {
  genre: string;
  watch_starts: number;
  /** Null = not computed (Phase 7: per-genre unique viewers requires analytics_daily). */
  unique_viewers: number | null;
};

export type SearchMetrics = {
  totalSearches: number;
  uniqueSearchers: number;
  noResultSearches: number;
  topQueries: Array<{ query: string; count: number; no_result_count: number }>;
};

export type ViewingResult = {
  metrics: ViewingMetrics;
  mostStarted: ContentRankingEntry[];
  mostCompleted: ContentRankingEntry[];
  mostWatched: ContentRankingEntry[];
  trending: ContentRankingEntry[];
  genres: GenreEntry[];
  search: SearchMetrics;
  error: string | null;
  migrationPending: boolean;
};

// ============================================================
// Error helpers (mirror Phase 2/3)
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

/**
 * Returns the canonical identity for a row: `user_id` if present,
 * otherwise `anonymous_id`. Used for unique-viewer deduplication.
 */
function rowIdentity(row: { user_id?: string | null; anonymous_id?: string | null }): string | null {
  if (typeof row.user_id === 'string' && row.user_id) return `u:${row.user_id}`;
  if (typeof row.anonymous_id === 'string' && row.anonymous_id) return `a:${row.anonymous_id}`;
  return null;
}

// ============================================================
// fetchViewing — top-level entry point
// ============================================================

const TOP_CONTENT_LIMIT = 20;
const TOP_QUERIES_LIMIT = 20;

/**
 * Fetches the complete Viewing & Discovery dashboard data for the
 * given date range. Runs all queries in parallel where possible.
 * NEVER throws — returns a safe empty shape on error.
 */
export async function fetchViewing(
  client: SupabaseClient<Database>,
  range: AnalyticsDateRange
): Promise<ViewingResult> {
  // Fetch all watch_start + watch_complete + watch_progress + search
  // events in the period. We project only the required columns to
  // minimize the payload. The query is bounded by the date range
  // (using the Phase 1 indexes: event_name_time_idx, event_time_idx).
  const [watchStartsRes, watchCompletesRes, watchProgressRes, searchRes] = await Promise.all([
    client
      .from('analytics_events')
      .select('user_id,anonymous_id,content_id,content_type')
      .eq('event_name', 'watch_start')
      .gte('event_time', range.start)
      .lt('event_time', range.end),
    client
      .from('analytics_events')
      .select('user_id,anonymous_id,content_id,content_type')
      .eq('event_name', 'watch_complete')
      .gte('event_time', range.start)
      .lt('event_time', range.end),
    client
      .from('analytics_events')
      .select('user_id,anonymous_id,content_id,metadata')
      .eq('event_name', 'watch_progress')
      .gte('event_time', range.start)
      .lt('event_time', range.end),
    client
      .from('analytics_events')
      .select('user_id,anonymous_id,metadata')
      .eq('event_name', 'search')
      .gte('event_time', range.start)
      .lt('event_time', range.end),
  ]);

  // Check for missing-table error first.
  const firstError = watchStartsRes.error ?? watchCompletesRes.error ?? watchProgressRes.error ?? searchRes.error;
  if (firstError && isMissingTableError(firstError)) {
    return { ...emptyViewingResult(), error: safeErrorMessage(firstError), migrationPending: true };
  }
  if (watchStartsRes.error || watchCompletesRes.error || watchProgressRes.error || searchRes.error) {
    const err = watchStartsRes.error ?? watchCompletesRes.error ?? watchProgressRes.error ?? searchRes.error;
    return { ...emptyViewingResult(), error: safeErrorMessage(err), migrationPending: false };
  }

  const watchStarts = (watchStartsRes.data ?? []) as Array<{ user_id: string | null; anonymous_id: string | null; content_id: string | null; content_type: string | null }>;
  const watchCompletes = (watchCompletesRes.data ?? []) as Array<{ user_id: string | null; anonymous_id: string | null; content_id: string | null; content_type: string | null }>;
  const watchProgress = (watchProgressRes.data ?? []) as Array<{ user_id: string | null; anonymous_id: string | null; content_id: string | null; metadata: Record<string, unknown> | null }>;
  const searchEvents = (searchRes.data ?? []) as Array<{ user_id: string | null; anonymous_id: string | null; metadata: Record<string, unknown> | null }>;

  // ---- Viewing metrics ----
  const uniqueViewers = new Set<string>();
  for (const e of watchStarts) {
    const id = rowIdentity(e);
    if (id) uniqueViewers.add(id);
  }

  const watchTimeSeconds = computeApproximateWatchTime(watchProgress);

  const metrics: ViewingMetrics = {
    uniqueViewers: uniqueViewers.size,
    watchStarts: watchStarts.length,
    completedWatches: watchCompletes.length,
    watchTimeSeconds,
    movieWatchStarts: 0,
    seriesWatchStarts: 0,
    animeWatchStarts: 0,
    otherWatchStarts: 0,
    movieCompletedWatches: 0,
    seriesCompletedWatches: 0,
    animeCompletedWatches: 0,
    otherCompletedWatches: 0,
  };
  for (const e of watchStarts) {
    if (e.content_type === 'movie') metrics.movieWatchStarts += 1;
    else if (e.content_type === 'series') metrics.seriesWatchStarts += 1;
    else if (e.content_type === 'anime') metrics.animeWatchStarts += 1;
    else metrics.otherWatchStarts += 1;
  }
  for (const e of watchCompletes) {
    if (e.content_type === 'movie') metrics.movieCompletedWatches += 1;
    else if (e.content_type === 'series') metrics.seriesCompletedWatches += 1;
    else if (e.content_type === 'anime') metrics.animeCompletedWatches += 1;
    else metrics.otherCompletedWatches += 1;
  }

  // ---- Content rankings ----
  const mostStarted = rankContent(watchStarts).slice(0, TOP_CONTENT_LIMIT);
  const mostCompleted = rankContent(watchCompletes).slice(0, TOP_CONTENT_LIMIT);
  // "Most Watched" = unique viewers per content (per plan §10 — "which
  // titles are receiving the most viewing activity"). We use unique
  // viewers as the ranking metric for Most Watched, and watch_starts
  // for Most Started (per plan §11).
  const mostWatched = rankContentByUniqueViewers(watchStarts).slice(0, TOP_CONTENT_LIMIT);
  // "Trending" = watch_starts in the selected period (transparent
  // descriptive ranking, no proprietary score — per plan §13). Same
  // data as Most Started but presented as "Trending in the selected
  // period" to communicate the transparent definition.
  const trending = mostStarted;

  // Resolve titles for the top content entries (bounded to avoid N+1).
  const allTopContentIds = new Set<string>();
  for (const entry of [...mostStarted, ...mostCompleted, ...mostWatched]) {
    if (entry.content_id) allTopContentIds.add(entry.content_id);
  }
  const titleByContent = await resolveContentTitles(allTopContentIds);
  for (const entry of [...mostStarted, ...mostCompleted, ...mostWatched]) {
    entry.title = entry.content_id ? (titleByContent.get(entry.content_id) ?? null) : null;
  }

  // ---- Genre analytics (bounded to top content) ----
  const genres = await computeGenreBreakdown(mostStarted, titleByContent);

  // ---- Search / Discovery analytics ----
  const search = computeSearchMetrics(searchEvents);

  return {
    metrics,
    mostStarted,
    mostCompleted,
    mostWatched,
    trending,
    genres,
    search,
    error: null,
    migrationPending: false,
  };
}

function emptyViewingResult(): ViewingResult {
  return {
    metrics: {
      uniqueViewers: 0,
      watchStarts: 0,
      completedWatches: 0,
      watchTimeSeconds: null,
      movieWatchStarts: 0,
      seriesWatchStarts: 0,
      animeWatchStarts: 0,
      otherWatchStarts: 0,
      movieCompletedWatches: 0,
      seriesCompletedWatches: 0,
      animeCompletedWatches: 0,
      otherCompletedWatches: 0,
    },
    mostStarted: [],
    mostCompleted: [],
    mostWatched: [],
    trending: [],
    genres: [],
    search: { totalSearches: 0, uniqueSearchers: 0, noResultSearches: 0, topQueries: [] },
    error: null,
    migrationPending: false,
  };
}

// ============================================================
// Watch time — approximate (per plan §8)
// ============================================================

/**
 * Computes APPROXIMATE watch time from watch_progress events.
 *
 * For each (content_id, identity) pair, takes the MAX `position_seconds`
 * from the metadata. Sums these maxes across all pairs. This is an
 * approximation because it assumes linear progress and counts the
 * furthest point reached, not actual watch time.
 *
 * Returns null if no watch_progress events have position_seconds
 * metadata (the "not available" case per plan §8).
 */
function computeApproximateWatchTime(
  watchProgress: Array<{ user_id: string | null; anonymous_id: string | null; content_id: string | null; metadata: Record<string, unknown> | null }>
): number | null {
  if (watchProgress.length === 0) return null;
  // Map: `${identity}::${content_id}` -> max position_seconds.
  const maxByPair = new Map<string, number>();
  let hasAnyPosition = false;
  for (const e of watchProgress) {
    if (!e.content_id) continue;
    const identity = rowIdentity(e);
    if (!identity) continue;
    const position = e.metadata?.position_seconds;
    if (typeof position !== 'number' || !isFinite(position) || position < 0) continue;
    hasAnyPosition = true;
    const key = `${identity}::${e.content_id}`;
    const existing = maxByPair.get(key);
    if (existing === undefined || position > existing) {
      maxByPair.set(key, position);
    }
  }
  if (!hasAnyPosition) return null;
  let total = 0;
  for (const v of maxByPair.values()) total += v;
  return total;
}

// ============================================================
// Content ranking
// ============================================================

/**
 * Ranks content by event count (watch_start or watch_complete).
 * Returns entries sorted by count DESC.
 */
function rankContent(
  events: Array<{ user_id: string | null; anonymous_id: string | null; content_id: string | null; content_type: string | null }>
): ContentRankingEntry[] {
  const byContent = new Map<string, { count: number; viewers: Set<string>; content_type: string | null }>();
  for (const e of events) {
    if (!e.content_id) continue;
    let entry = byContent.get(e.content_id);
    if (!entry) {
      entry = { count: 0, viewers: new Set(), content_type: e.content_type };
      byContent.set(e.content_id, entry);
    }
    entry.count += 1;
    const identity = rowIdentity(e);
    if (identity) entry.viewers.add(identity);
  }
  return Array.from(byContent.entries())
    .map(([content_id, e]) => ({
      content_id,
      content_type: e.content_type,
      title: null, // resolved later
      count: e.count,
      unique_viewers: e.viewers.size,
    }))
    .sort((a, b) => b.count - a.count || b.unique_viewers - a.unique_viewers);
}

/**
 * Ranks content by unique viewers (for "Most Watched").
 */
function rankContentByUniqueViewers(
  events: Array<{ user_id: string | null; anonymous_id: string | null; content_id: string | null; content_type: string | null }>
): ContentRankingEntry[] {
  const byContent = new Map<string, { viewers: Set<string>; count: number; content_type: string | null }>();
  for (const e of events) {
    if (!e.content_id) continue;
    let entry = byContent.get(e.content_id);
    if (!entry) {
      entry = { viewers: new Set(), count: 0, content_type: e.content_type };
      byContent.set(e.content_id, entry);
    }
    entry.count += 1;
    const identity = rowIdentity(e);
    if (identity) entry.viewers.add(identity);
  }
  return Array.from(byContent.entries())
    .map(([content_id, e]) => ({
      content_id,
      content_type: e.content_type,
      title: null,
      count: e.count,
      unique_viewers: e.viewers.size,
    }))
    .sort((a, b) => b.unique_viewers - a.unique_viewers || b.count - a.count);
}

// ============================================================
// Content title resolution (bounded to avoid N+1)
// ============================================================

/**
 * Resolves titles for a set of content_ids via the existing
 * `getDetail(type, id)` helper. Bounded by the set size (callers
 * pass ≤ TOP_CONTENT_LIMIT * 3 ids). Returns a map of content_id ->
 * title. Unresolvable content_ids are omitted (the caller falls back
 * to "Unknown title").
 *
 * The content_id format is `${type}-${tmdbId}` (e.g. `movie-550`).
 * `getDetail` expects the type + the id with the prefix stripped.
 */
async function resolveContentTitles(contentIds: Set<string>): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  if (contentIds.size === 0) return result;
  // Lazy import — avoids pulling $env into the test module graph. The
  // import itself may fail in environments where $env is not available
  // (e.g. tsx tests); in that case we return an empty map and the
  // caller falls back to "Unknown title".
  let getDetail: ((type: 'movie' | 'series' | 'anime', id: string) => Promise<{ title?: string }>) | null = null;
  try {
    ({ getDetail } = await import('$lib/server/content/service'));
  } catch {
    return result;
  }
  if (!getDetail) return result;
  // Resolve in parallel but bounded. The set is ≤ 60 entries (3 lists
  // * 20 each), so this is safe. For larger sets a bounded-concurrency
  // queue would be needed (deferred to Phase 7).
  const entries = Array.from(contentIds);
  const resolutions = await Promise.all(
    entries.map(async (contentId) => {
      try {
        // Parse content_id: "movie-550" -> type="movie", id="550".
        const match = contentId.match(/^(movie|series|anime)-(.+)$/);
        if (!match) return [contentId, null] as const;
        const [, type, id] = match;
        const detail = await getDetail(type as 'movie' | 'series' | 'anime', id);
        return [contentId, detail?.title ?? null] as const;
      } catch {
        return [contentId, null] as const;
      }
    })
  );
  for (const [contentId, title] of resolutions) {
    if (title) result.set(contentId, title);
  }
  return result;
}

// ============================================================
// Genre breakdown (bounded to top content)
// ============================================================

/**
 * Computes genre breakdown from the top-started content list.
 * Resolves genres via `getDetail()` for the top content IDs, then
 * aggregates watch_start count by genre.
 *
 * Per plan §14: "Do NOT duplicate TMDB/content metadata into the
 * analytics event schema just for this phase. Prefer joining existing
 * canonical content metadata." We join via getDetail() at query time.
 */
async function computeGenreBreakdown(
  topStarted: ContentRankingEntry[],
  titleByContent: Map<string, string>
): Promise<GenreEntry[]> {
  if (topStarted.length === 0) return [];
  // Lazy import — avoids pulling $env into the test module graph.
  let getDetail: ((type: 'movie' | 'series' | 'anime', id: string) => Promise<{ genres?: string[] }>) | null = null;
  try {
    ({ getDetail } = await import('$lib/server/content/service'));
  } catch {
    // Import failed (e.g. test environment without $env) — return
    // an "Unknown" genre bucket with the total watch starts.
    return [{ genre: 'Unknown', watch_starts: topStarted.reduce((sum, e) => sum + e.count, 0), unique_viewers: 0 }];
  }
  if (!getDetail) return [];
  // Resolve genres for the top content IDs. We reuse the same
  // getDetail() call — but since resolveContentTitles only returned
  // titles, we need to re-fetch for genres. To stay bounded, we only
  // resolve genres for the top 20 (already bounded by TOP_CONTENT_LIMIT).
  const genreByContent = new Map<string, string[]>();
  const contentIds = topStarted.map((e) => e.content_id).filter(Boolean);
  const resolutions = await Promise.all(
    contentIds.map(async (contentId) => {
      try {
        const match = contentId.match(/^(movie|series|anime)-(.+)$/);
        if (!match) return [contentId, []] as const;
        const [, type, id] = match;
        const detail = await getDetail(type as 'movie' | 'series' | 'anime', id);
        return [contentId, detail?.genres ?? []] as const;
      } catch {
        return [contentId, []] as const;
      }
    })
  );
  for (const [contentId, genres] of resolutions) {
    genreByContent.set(contentId, [...genres]);
  }

  // Aggregate watch_starts by genre.
  const byGenre = new Map<string, { watch_starts: number; viewers: Set<string> }>();
  // We need the viewer set per content to attribute to genres. Re-rank
  // with viewer identity tracking — but we only have the aggregated
  // ContentRankingEntry (which has unique_viewers count, not the set).
  // For Phase 4 we approximate: sum watch_starts by genre. Unique
  // viewers by genre would require the raw event data (deferred to
  // Phase 7 with analytics_daily for precise per-genre unique counts).
  for (const entry of topStarted) {
    const genres = genreByContent.get(entry.content_id) ?? [];
    if (genres.length === 0) {
      // No genre info — bucket as "Unknown".
      const g = byGenre.get('Unknown') ?? { watch_starts: 0, viewers: new Set() };
      g.watch_starts += entry.count;
      byGenre.set('Unknown', g);
    } else {
      for (const genre of genres) {
        const g = byGenre.get(genre) ?? { watch_starts: 0, viewers: new Set() };
        g.watch_starts += entry.count;
        byGenre.set(genre, g);
      }
    }
  }
  // Phase 7 fix: unique_viewers per genre is not computed (the
  // aggregation works from the ranked content list, not per-genre
  // viewer sets). Return null instead of 0 to honestly represent
  // "not computed" rather than misleadingly implying "zero viewers".
  // The UI does not display this field, but the API contract should
  // be honest.
  return Array.from(byGenre.entries())
    .map(([genre, e]) => ({ genre, watch_starts: e.watch_starts, unique_viewers: null }))
    .sort((a, b) => b.watch_starts - a.watch_starts);
}

// ============================================================
// Search / Discovery metrics
// ============================================================

function computeSearchMetrics(
  searchEvents: Array<{ user_id: string | null; anonymous_id: string | null; metadata: Record<string, unknown> | null }>
): SearchMetrics {
  const uniqueSearchers = new Set<string>();
  const queryCounts = new Map<string, { count: number; no_result_count: number }>();
  let noResultSearches = 0;

  for (const e of searchEvents) {
    const identity = rowIdentity(e);
    if (identity) uniqueSearchers.add(identity);

    const query = typeof e.metadata?.query === 'string' ? e.metadata.query : null;
    const resultCount = e.metadata?.result_count;
    const isNoResult = typeof resultCount === 'number' && resultCount === 0;
    if (isNoResult) noResultSearches += 1;

    if (query) {
      // Normalize: trim + lowercase for aggregation (per plan §18).
      const normalized = query.trim().toLowerCase();
      if (normalized) {
        const existing = queryCounts.get(normalized) ?? { count: 0, no_result_count: 0 };
        existing.count += 1;
        if (isNoResult) existing.no_result_count += 1;
        queryCounts.set(normalized, existing);
      }
    }
  }

  const topQueries = Array.from(queryCounts.entries())
    .map(([query, e]) => ({ query, count: e.count, no_result_count: e.no_result_count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, TOP_QUERIES_LIMIT);

  return {
    totalSearches: searchEvents.length,
    uniqueSearchers: uniqueSearchers.size,
    noResultSearches,
    topQueries,
  };
}
