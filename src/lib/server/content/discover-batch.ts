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
 *   section priority. The global `seen` set is maintained across all
 *   sections in priority order.
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
 * @param language   Discover language filter.
 * @param provider   OTT provider key (only meaningful for new-ott).
 * @param canAccessAdult Reserved for future use; batch does not include
 *                       adult sections.
 * @param fetchRail  REQUIRED rail fetcher. Production callers pass the
 *                   real `discoverRail` from `service.ts`. Tests pass
 *                   a mock to avoid hitting real TMDB.
 */
export async function discoverBatchDeduped(
  language: DiscoverLanguage,
  provider: string | undefined,
  canAccessAdult: boolean,
  fetchRail: (filters: DiscoverRailFilters, canAccessAdult: boolean) => Promise<ContentList>
): Promise<Record<string, { items: NormalizedMediaItem[]; page: number; hasNextPage: boolean }>> {
  const seen = new Set<string>();
  const results: Record<string, { items: NormalizedMediaItem[]; page: number; hasNextPage: boolean }> = {};
  const TARGET_ITEMS = 10;
  const MAX_PAGES = 3;

  for (const section of SECTION_PRIORITY) {
    let railItems: NormalizedMediaItem[] = [];
    let currentPage = 1;
    // Phase 9 fix: track the ACTUAL last fetched page so Show More can
    // resume from the correct continuation page. Previously this was
    // hardcoded to 1, which caused Show More to re-fetch pages that
    // the batch had already consumed.
    let lastFetchedPage = 0;
    let hasNext = false;
    const sectionIsGenre = isGenreSection(section);

    while (currentPage <= MAX_PAGES) {
      const result = await fetchRail(
        { section: section as DiscoverSectionKey, language, provider, page: currentPage },
        canAccessAdult
      );
      lastFetchedPage = currentPage;

      // Phase 8 fix: the dedup algorithm must NOT use filterSeen() for
      // genre sections because filterSeen() adds items to the seen set
      // BEFORE genre eligibility is checked. An item that is rejected
      // by canonical genre assignment must NOT occupy a slot in seen —
      // it must remain available for its correct canonical genre rail.
      //
      // Correct algorithm per item:
      //   A. canonical ID already in seen? → reject (already displayed)
      //   B. section is genre + canonical genre ≠ this section? → reject
      //      WITHOUT adding to seen (it belongs to a different genre rail)
      //   C. otherwise → accept + add canonical ID to seen
      for (const item of result.items) {
        if (railItems.length >= 20) break; // cap per rail
        const key = canonicalKey(item);
        if (seen.has(key)) continue;      // A: already displayed
        if (sectionIsGenre && shouldExcludeFromGenre(item, section)) continue; // B: wrong genre
        // C: accept
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

    results[section] = {
      items: railItems.slice(0, 20), // Cap at 20 per rail
      // Phase 9 fix: return the ACTUAL last fetched page, not always 1.
      // If the loop iterated through pages 1, 2, 3 to fill the rail,
      // lastFetchedPage = 3. If the loop only fetched page 1,
      // lastFetchedPage = 1. Show More uses this to compute
      // nextPage = currentPage + 1, ensuring it never re-fetches
      // already-consumed pages.
      page: lastFetchedPage,
      hasNextPage: hasNext,
    };
  }

  return results;
}
