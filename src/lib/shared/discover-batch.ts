/**
 * Discover batch state machine — pure client-safe decision logic.
 *
 * Phase 9: extracted from `$lib/server/content/discover-dedup.ts` because
 * `DiscoverSection.svelte` is a client component and cannot import from
 * `$lib/server/*` (SvelteKit's guard rejects the import at build time
 * to prevent leaking server-only code into the browser bundle).
 *
 * This file lives in `$lib/shared/` so it is safe to import from BOTH
 * client and server code. It contains NO server-only logic — just the
 * pure decision tree for how a Discover section should react to the
 * batch lifecycle (pending → success | failed).
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
