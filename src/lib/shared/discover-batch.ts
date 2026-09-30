/**
 * Discover batch state machine + cross-rail canonical priority — pure
 * client-safe decision logic.
 *
 * Phase 9: extracted from `$lib/server/content/discover-dedup.ts` because
 * `DiscoverSection.svelte` and `DiscoverPage.svelte` are client components
 * and cannot import from `$lib/server/*` (SvelteKit's guard rejects the
 * import at build time to prevent leaking server-only code into the
 * browser bundle).
 *
 * This file lives in `$lib/shared/` so it is safe to import from BOTH
 * client and server code. It contains NO server-only logic — just the
 * pure decision tree for how a Discover section should react to the
 * batch lifecycle (pending → success | failed) and the canonical
 * section priority used by BOTH the server dedup loop AND the client
 * Show More exclude list computation.
 *
 * CRITICAL INVARIANT — CANONICAL PRIORITY ≠ VISUAL UI ORDER:
 *   The server dedup walks sections in SECTION_PRIORITY order:
 *
 *     theatre → new-ott → popular-* → top-rated-* →
 *     genre-action → genre-adventure → genre-crime →
 *     genre-thriller → genre-scifi → genre-comedy →
 *     genre-drama → genre-horror → genre-romance
 *
 *   The visual UI order in DiscoverPage is DIFFERENT (Comedy appears
 *   before Crime/Thriller/Sci-Fi in the rendered page). The visual
 *   order is intentional and MUST NOT change.
 *
 *   For Show More exclude lists to honor the SAME canonical priority as
 *   the server, `excludeIdsFor(sectionKey)` on the client MUST walk
 *   SECTION_PRIORITY (this shared constant), NOT the visual UI order.
 *   Otherwise Show More on genre-comedy would not exclude IDs from
 *   genre-crime / genre-thriller / genre-scifi (which are higher
 *   canonical priority but rendered visually below comedy), and the
 *   same canonical ID could be reintroduced by Show More — breaking
 *   the cross-rail dedup invariant.
 *
 * Decision tree (in order):
 *   1. filterChanged       → 'fetch'      (user changed language/provider)
 *   2. batch pending       → 'wait'       (batch not yet resolved)
 *   3. batch failed        → 'fetch'      (independent fetch allowed)
 *   4. batch success + not-yet-consumed → 'use-batch'
 *        (consume initialItems EVEN IF EMPTY; preserve initialHasNextPage
 *         and initialPage so Show More starts from the correct continuation)
 *   5. batch success + already consumed  → 'fetch'
 *        (only happens on retry after a transient error)
 *
 * CRITICAL CORRECTNESS INVARIANT:
 *   An empty successful batch MUST be consumed as 'use-batch' (NOT 'fetch').
 *   Falling back to an independent /api/discover/rail fetch when the batch
 *   returned items: [] would BYPASS the global cross-rail dedup contract —
 *   the independent fetch has no knowledge of items already displayed in
 *   higher-priority rails. Only a FAILED batch permits independent fetch.
 *
 * The previous bug was inferring batch readiness from `initialItems.length > 0`,
 * which incorrectly treated empty successful rails as "batch not ready" and
 * fell back to independent fetching. This file makes the state transition
 * unambiguous via the explicit `BatchResolution` state.
 */

/**
 * Canonical section priority — the SERVER dedup order.
 *
 * Lower index = higher priority. The server `discoverBatchDeduped()` loop
 * walks sections in this exact order, maintaining a global `seen` set so
 * each canonical ID appears in exactly ONE rail (the highest-priority rail
 * that accepts it).
 *
 * THIS ORDER MUST MATCH the server's `SECTION_PRIORITY` in
 * `$lib/server/content/discover-dedup.ts`. The server file re-exports
 * this constant so there is a single source of truth.
 *
 * The visual UI order in DiscoverPage.svelte is DIFFERENT — Comedy is
 * rendered before Crime/Thriller/Sci-Fi. The visual order is intentional
 * (matches the spec's "spectacle-first" UX) and MUST NOT change.
 *
 * For Show More exclude lists, the client MUST walk SECTION_PRIORITY
 * (not the visual order) so that an item accepted into a higher-priority
 * rail that appears VISUALLY BELOW the current section is still
 * excluded from Show More.
 *
 * Concrete example:
 *   Movie X is accepted into genre-crime (canonical priority index 10).
 *   genre-comedy is canonical priority index 12 (lower priority than crime).
 *   But genre-comedy is VISUALLY rendered at index 11 — BEFORE genre-crime.
 *
 *   excludeIdsFor('genre-comedy') MUST include Movie X even though
 *   genre-crime appears visually below genre-comedy. Walking
 *   SECTION_PRIORITY ensures genre-crime (index 10) is visited BEFORE
 *   genre-comedy (index 12), so Movie X is in the exclude list when
 *   genre-comedy's Show More runs.
 */
export const SECTION_PRIORITY: readonly string[] = [
  'theatre',
  'new-ott',
  'popular-movie',
  'popular-series',
  'popular-anime',
  'top-rated-movie',
  'top-rated-series',
  'top-rated-anime',
  'genre-action',
  'genre-adventure',
  'genre-crime',
  'genre-thriller',
  'genre-scifi',
  'genre-comedy',
  'genre-drama',
  'genre-horror',
  'genre-romance',
] as const;

/**
 * Batch lifecycle states. DiscoverPage owns this state and propagates it
 * to each DiscoverSection via the `batchStatus` prop.
 *
 *   pending → success | failed
 *
 *   pending: batch request is in-flight; sections MUST wait and MUST NOT
 *            independently fetch /api/discover/rail.
 *   success: batch resolved; each section consumes its rail result
 *            (EVEN IF items.length === 0). No independent fetch.
 *   failed:  batch rejected (network error, parse error, non-OK response);
 *            sections MAY fall back to independent /api/discover/rail fetch.
 */
export type BatchResolution = 'pending' | 'success' | 'failed';

/**
 * Discriminated union representing the load decision for a Discover section.
 *
 *   wait       — show loading skeleton; do NOT fetch independently.
 *   use-batch  — consume the batch result (initialItems + initialHasNextPage +
 *                initialPage). Even an empty initialItems is authoritative.
 *   fetch      — independent /api/discover/rail fetch is permitted.
 */
export type SectionLoadDecision =
  | { kind: 'wait' }
  | {
      kind: 'use-batch';
      /** Authoritative hasNextPage from the batch — NOT inferred from item count. */
      hasNextPage: boolean;
      /** Actual last-fetched page from the batch — Show More resumes from page+1. */
      page: number;
    }
  | { kind: 'fetch' };

/**
 * Input shape for `decideSectionLoad`. The caller passes the current batch
 * state, the section's internal flags (filterChanged, usedInitialItems),
 * and the authoritative batch fields (initialHasNextPage, initialPage).
 *
 * `initialItems` is intentionally NOT in the output `use-batch` decision —
 * the caller already has the prop and just needs to know whether to use it.
 * This keeps the decision function free of large object copies.
 */
export type DecideSectionLoadInput = {
  batchStatus: BatchResolution;
  filterChanged: boolean;
  usedInitialItems: boolean;
  /** Whether the batch reports more pages exist for this section. */
  initialHasNextPage: boolean;
  /** Actual last page the batch consumed for this section (1, 2, or 3). */
  initialPage: number;
};

/**
 * Pure decision function for how a DiscoverSection should load its initial
 * page. No I/O, no side effects — unit-testable without rendering the
 * Svelte component.
 *
 * See `SectionLoadDecision` for the decision tree.
 */
export function decideSectionLoad(opts: DecideSectionLoadInput): SectionLoadDecision {
  // 1. Filter changed → never reuse stale batch data.
  if (opts.filterChanged) return { kind: 'fetch' };

  // 2. Batch pending → wait for resolution.
  if (opts.batchStatus === 'pending') return { kind: 'wait' };

  // 3. Batch failed → fall back to independent fetch.
  if (opts.batchStatus === 'failed') return { kind: 'fetch' };

  // 4. Batch success + not-yet-consumed → use batch result, EVEN IF EMPTY.
  //    This is the critical correctness invariant: an empty successful
  //    batch is NOT a signal to fetch independently — the cross-rail
  //    dedup contract requires the section to honor the authoritative
  //    dataset, even when it is empty.
  if (!opts.usedInitialItems) {
    return {
      kind: 'use-batch',
      hasNextPage: opts.initialHasNextPage,
      page: opts.initialPage,
    };
  }

  // 5. Batch success + already consumed → independent fetch (retry path).
  return { kind: 'fetch' };
}

// ============================================================
// Cross-rail exclude-list computation — canonical priority aware.
//
// Phase 9 fix: `excludeIdsFor(sectionKey)` previously walked the visual
// UI SECTIONS array, which has Comedy rendered before Crime/Thriller/
// Sci-Fi. This was WRONG — the server dedup walks SECTION_PRIORITY
// (canonical server order), where Crime/Thriller/Sci-Fi come BEFORE
// Comedy. Walking the visual order caused Show More on Comedy to NOT
// exclude items already accepted into Crime/Thriller/Sci-Fi —
// reintroducing duplicates and breaking the cross-rail invariant.
//
// `canonicalExcludeIds()` is the pure, client-safe helper that walks
// SECTION_PRIORITY (the SAME canonical order used by the server
// `discoverBatchDeduped()` loop). DiscoverPage.svelte uses this instead
// of the visual order.
//
// For an item accepted into a higher-priority rail that appears
// VISUALLY BELOW the current section (e.g. Movie X in genre-crime, which
// is canonical priority 10 but visual index 11 — AFTER Comedy at visual
// index 10 but canonical priority 12), `canonicalExcludeIds()` ensures
// Movie X is in the exclude list when genre-comedy's Show More runs.
// ============================================================

/**
 * Shape of a batch rail entry as seen by the client. The item's
 * `externalIds.tmdb` is used for canonical identity (matches server
 * `canonicalKey()`).
 */
export type BatchRailItem = {
  type: string;
  id: string | number;
  externalIds?: { tmdb?: string };
};

/**
 * Compute the canonical exclude IDs for a section's Show More request.
 *
 * Walks SECTION_PRIORITY (server canonical order), collecting canonical
 * IDs from EVERY section that appears BEFORE `sectionKey` in that
 * order — REGARDLESS of where the section appears in the visual UI.
 *
 * This ensures:
 *   - genre-comedy's exclude list INCLUDES IDs from genre-action,
 *     genre-adventure, genre-crime, genre-thriller, genre-scifi
 *     (all higher canonical priority than comedy, even though
 *     genre-crime/genre-thriller/genre-scifi appear visually AFTER
 *     comedy in the rendered page).
 *   - genre-drama's exclude list INCLUDES all 5 higher-priority genres
 *     AND genre-comedy.
 *
 * The server /api/discover/rail endpoint receives this list as the
 * `exclude` query parameter, and filters those canonical IDs out of
 * its TMDB response — preventing Show More from reintroducing items
 * that are already displayed in any higher-priority rail.
 *
 * @param sectionKey    The section whose Show More is running.
 * @param batchRails    Map of all batch rail results (key → items + page + hasNextPage).
 * @returns             Canonical IDs (`${type}:${tmdbId}`) of items in
 *                      higher-priority rails, in SECTION_PRIORITY order.
 */
export function canonicalExcludeIds(
  sectionKey: string,
  batchRails: Record<string, { items: BatchRailItem[]; page: number; hasNextPage: boolean } | undefined>
): string[] {
  const ids: string[] = [];
  for (const section of SECTION_PRIORITY) {
    if (section === sectionKey) break;
    const rail = batchRails[section];
    if (rail) {
      for (const item of rail.items) {
        // Use TMDB numeric ID when available — matches server canonicalKey().
        const tmdbId = item.externalIds?.tmdb;
        ids.push(`${item.type}:${tmdbId ?? item.id}`);
      }
    }
  }
  return ids;
}
