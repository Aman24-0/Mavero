/**
 * Discover cross-rail batch deduplication — pure logic, no TMDB imports.
 *
 * Phase 9: this file was extracted from `service.ts` so the batch logic
 * can be unit-tested WITHOUT loading the TMDB adapter chain (which
 * transitively imports SvelteKit's `$env/dynamic/private` virtual
 * module — unavailable outside the SvelteKit runtime).
 *
 * The `fetchRail` parameter is REQUIRED (not optional with a default).
 * Production callers pass the real `discoverRail` from `service.ts`.
 * Tests pass a mock fetcher.
 *
 * Cross-rail dedup contract:
 *   Each title appears in ONE primary Discover location only, based on
 * section priority. The global `seen` set is maintained across all
 * sections in priority order.
 *
 * Section priority (highest first):
 *   1. theatre
 *   2. new-ott
 *   3. popular-movie / popular-series / popular-anime
 *   4. top-rated-movie / top-rated-series / top-rated-anime
 *   5. genre-* (each genre rail, in GENRE_PRIORITY order)
 *
 * Canonical identity: `${mediaType}:${tmdbId}` — e.g. "movie:550".
 *
 * Genre assignment rule (deterministic):
 *   A title belonging to multiple TMDB genres is assigned to exactly
 *   ONE genre rail based on the first matching genre in GENRE_PRIORITY.
 *   A title REJECTED by its non-canonical genre rail is NOT added to
 *   `seen` — it remains available for its canonical genre rail.
 *
 * PAGE TRACKING (Phase 9):
 *   The returned `page` field reflects the ACTUAL last fetched page for
 *   each section, NOT always 1. If a section consumed pages 1, 2, 3 to
 *   fill itself, `page: 3` is returned. DiscoverSection uses this as
 *   its starting `currentPage` so that "Show More" computes
 *   `nextPage = currentPage + 1 = 4` and the rail endpoint fetches
 *   pages 4, 5, 6 — NEVER re-fetching already-consumed pages.
 *
 * PARALLELIZATION (F3):
 *   Page-1 fetches for ALL sections are independent — no section's
 *   page-1 result depends on another section's page-1 result. The
 *   dedup only matters when deciding which items to KEEP from each
 *   section's results. Therefore:
 *
 *   1. Fetch all 17 page-1 results concurrently (bounded concurrency).
 *   2. Process them sequentially in SECTION_PRIORITY order (same dedup
 *      logic as before — completion timing does NOT affect ordering).
 *   3. Only fetch continuation pages (2, 3) for sections that need
 *      more items after dedup — these are sequential per-section.
 *
 *   This reduces cold-batch latency from ~17× sequential TMDB roundtrips
 *   to ~1× (page-1 parallel) + bounded continuation (sequential, but
 *   only for sections that lost items to higher-priority rails).
 *
 *   Deterministic ordering is preserved because:
 *   - Page-1 results are fetched in parallel but PROCESSED in
 *     SECTION_PRIORITY order (the for-loop walks SECTION_PRIORITY,
 *     not completion order).
 *   - The `seen` set is populated in SECTION_PRIORITY order.
 *   - Continuation pages are fetched per-section only after the
 *     section's page-1 items have been deduped.
 */

import {
  SECTION_PRIORITY,
  shouldExcludeFromGenre,
  isGenreSection,
  canonicalKey,
} from './discover-dedup';
import type {
  ContentList,
  DiscoverLanguage,
  DiscoverRailFilters,
  DiscoverSectionKey,
  NormalizedMediaItem,
} from './types';

/**
 * Bounded concurrency for page-1 parallel fetches.
 * 6 is chosen to avoid exceeding TMDB rate limits while still
 * providing significant parallelism (17 sections / 6 concurrent =
 * ~3 waves instead of 17 sequential).
 */
const PAGE1_CONCURRENCY = 6;

/**
 * Runs lazy task functions with bounded concurrency.
 *
 * CRITICAL: accepts `() => Promise<T>` (lazy tasks), NOT `Promise<T>`
 * (already-started promises). This ensures the task function is only
 * INVOKED when a concurrency slot is available — preventing all 17
 * fetchRail calls from being in flight simultaneously.
 *
 * Returns results in the SAME ORDER as the input array (not completion order).
 */
async function boundedAll<T>(
  tasks: (() => Promise<T>)[],
  concurrency: number
): Promise<T[]> {
  if (tasks.length === 0) return [];
  const results: T[] = new Array(tasks.length);
  let nextIndex = 0;

  async function runNext(): Promise<void> {
    while (nextIndex < tasks.length) {
      const index = nextIndex++;
      // Invoke the task ONLY when a slot is available.
      results[index] = await tasks[index]();
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, () => runNext());
  await Promise.all(workers);
  return results;
}

/**
 * Cross-rail deduplicated discover batch.
 *
 * Fetches ALL non-adult Discover sections in priority order, maintaining
 * a global seen set so each title appears in ONE primary location only.
 *
 * For genre sections, a title is assigned to exactly ONE canonical genre
 * (first matching genre in priority order) — it does NOT appear in
 * every genre it belongs to.
 *
 * If a rail loses items to higher-priority rails, bounded continuation
 * (up to MAX_PAGES=3 pages) is used to fill the rail to a minimum of
 * TARGET_ITEMS=10 items when possible.
 *
 * Adult sections are NOT included in the batch — they remain independently
 * fetched by the existing per-rail endpoint.
 *
 * MAV-20 Phase E — `sections` response scoping:
 *   The dedup processing ALWAYS walks the FULL SECTION_PRIORITY list with
 *   the same global seen set (byte-identical dedup outcome regardless of
 *   scope). `sections`, when provided, only filters WHICH rails are
 *   returned to the caller. This lets the client fetch the batch in
 *   priority tiers — the first tier renders as soon as ITS sections are
 *   computed, while a concurrent tier-2 request processes the same full
 *   priority list (sharing the in-flight-deduplicated server caches) and
 *   returns the remaining rails. Because every scoped request sees the
 *   same seen-set prefix, tiered responses compose into exactly the same
 *   rails a single full-batch request would have returned.
 *
 *   SCOPING RULE (prefix short-circuit): a scoped request processes
 *   every section UP TO AND INCLUDING the LAST scoped section in
 *   SECTION_PRIORITY order — sections before the last scoped one are
 *   processed even when out of scope because their accepted items seed
 *   the global seen set the scoped sections' dedup depends on — and
 *   SKIPS every section after it entirely (lower-priority sections can
 *   never influence higher-priority ones, so skipping them is exact,
 *   not an approximation). A tier-1 request scoped to the priority
 *   PREFIX therefore returns after processing only its own sections.
 *
 * @param language   Discover language filter.
 * @param provider   OTT provider key (only meaningful for new-ott).
 * @param canAccessAdult Reserved for future use; batch does not include
 *                       adult sections.
 * @param fetchRail  REQUIRED rail fetcher. Production callers pass the
 *                   real `discoverRail` from `service.ts`. Tests pass
 *                   a mock to avoid hitting real TMDB.
 * @param sections   Optional subset of section keys to RETURN. The
 *                   processing prefix runs through the LAST scoped
 *                   section (dedup seeding); sections after it are
 *                   skipped. Unknown keys match nothing — a scope that
 *                   matches no section returns an empty rails object.
 */
export async function discoverBatchDeduped(
  language: DiscoverLanguage,
  provider: string | undefined,
  canAccessAdult: boolean,
  fetchRail: (filters: DiscoverRailFilters, canAccessAdult: boolean) => Promise<ContentList>,
  sections?: readonly string[]
): Promise<Record<string, { items: NormalizedMediaItem[]; page: number; hasNextPage: boolean }>> {
  const seen = new Set<string>();
  const results: Record<string, { items: NormalizedMediaItem[]; page: number; hasNextPage: boolean }> = {};
  const TARGET_ITEMS = 10;
  const MAX_PAGES = 3;

  // MAV-20 Phase E — resolve the response scope to a processing PREFIX
  // of SECTION_PRIORITY: everything up to the last scoped section runs
  // (out-of-scope sections still seed the seen set), everything after
  // the last scoped section is skipped entirely.
  const scopeSet = sections !== undefined && sections.length > 0 ? new Set(sections) : undefined;
  let lastScopedIndex = SECTION_PRIORITY.length - 1;
  if (scopeSet) {
    lastScopedIndex = -1;
    for (let i = 0; i < SECTION_PRIORITY.length; i++) {
      if (scopeSet.has(SECTION_PRIORITY[i])) lastScopedIndex = i;
    }
    if (lastScopedIndex === -1) return {}; // scope matches nothing — nothing to process
  }
  const processCount = lastScopedIndex + 1;

  // ============================================================
  // F3: Fetch page-1 for the sections being processed in parallel
  // (bounded). Page-1 fetches are independent — no section's page-1
  // result depends on another section's page-1 result. The dedup only
  // matters when deciding which items to KEEP.
  //
  // CRITICAL: pass LAZY TASK FUNCTIONS (() => Promise<T>), NOT
  // already-started promises. This ensures fetchRail is only INVOKED
  // when a concurrency slot is available — preventing all requests
  // from being in flight simultaneously.
  // ============================================================
  const page1Tasks = SECTION_PRIORITY.slice(0, processCount).map((section) => () =>
    fetchRail(
      { section: section as DiscoverSectionKey, language, provider, page: 1 },
      canAccessAdult
    ).catch(() => ({ items: [], page: 1, hasNextPage: false, source: 'error' } as unknown as ContentList))
  );
  const page1Results = await boundedAll(page1Tasks, PAGE1_CONCURRENCY);

  // ============================================================
  // Process page-1 results sequentially in SECTION_PRIORITY order.
  // This preserves deterministic ordering — completion timing does
  // NOT affect which items are kept or which section gets priority.
  // ============================================================
  for (let i = 0; i < processCount; i++) {
    const section = SECTION_PRIORITY[i];
    const page1Result = page1Results[i];

    let railItems: NormalizedMediaItem[] = [];
    let lastFetchedPage = 0;
    let hasNext = false;
    const sectionIsGenre = isGenreSection(section);

    // Process page-1 items through the dedup filter.
    lastFetchedPage = 1;
    for (const item of page1Result.items) {
      if (railItems.length >= 20) break; // cap per rail
      const key = canonicalKey(item);
      if (seen.has(key)) continue;      // A: already displayed
      if (sectionIsGenre && shouldExcludeFromGenre(item, section)) continue; // B: wrong genre
      // C: accept
      seen.add(key);
      railItems.push(item);
    }

    // Check if we need continuation pages.
    if (railItems.length >= TARGET_ITEMS || !page1Result.hasNextPage) {
      hasNext = page1Result.hasNextPage;
    } else {
      // Continuation: fetch pages 2..MAX_PAGES sequentially per section.
      // Only sections that lost items to higher-priority rails AND
      // have more pages available will fetch continuation pages.
      let currentPage = 2;
      hasNext = page1Result.hasNextPage;
      while (currentPage <= MAX_PAGES && railItems.length < TARGET_ITEMS && hasNext) {
        let result: ContentList;
        try {
          result = await fetchRail(
            { section: section as DiscoverSectionKey, language, provider, page: currentPage },
            canAccessAdult
          );
        } catch {
          break; // section failure isolation — stop fetching, keep what we have
        }
        lastFetchedPage = currentPage;

        for (const item of result.items) {
          if (railItems.length >= 20) break;
          const key = canonicalKey(item);
          if (seen.has(key)) continue;
          if (sectionIsGenre && shouldExcludeFromGenre(item, section)) continue;
          seen.add(key);
          railItems.push(item);
        }

        if (railItems.length >= TARGET_ITEMS || !result.hasNextPage) {
          hasNext = result.hasNextPage;
          break;
        }
        currentPage++;
        hasNext = result.hasNextPage;
      }
    }

    // MAV-20 Phase E — store the rail only when the section is in the
    // requested scope. Out-of-scope sections before the last scoped
    // section were still PROCESSED above (their accepted items are in
    // the seen set — the dedup seeding the scoped sections rely on).
    if (!scopeSet || scopeSet.has(section)) {
      results[section] = {
        items: railItems.slice(0, 20), // Cap at 20 per rail
        page: lastFetchedPage,
        hasNextPage: hasNext,
      };
    }
  }

  return results;
}
