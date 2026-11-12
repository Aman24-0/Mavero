/**
 * MAV-25 WS6 — Downloader per-source automatic retry policy (pure logic).
 *
 * REQUIRED POLICY (per the approved spec):
 *   1. The existing initial fetch runs (add-on: per-addon endpoint —
 *      which internally carries a bounded server-side retry budget for
 *      TRANSIENT failures; plugin: the ONE-batch mavero2 endpoint).
 *   2. If it fails or produces zero valid, usable links, the source is
 *      automatically retried EXACTLY ONCE per logical load.
 *   3. A retry that yields valid links → the source renders normally.
 *   4. A retry that fails or still yields zero valid links → the source
 *      is HIDDEN from the source selector.
 *   5. If every source ends hidden, the panel shows a clear, recoverable
 *      empty/error state (a fresh logical load restores the budgets).
 *   6. One source's failure never cancels or blocks the others.
 *
 * AUTHORITATIVE RETRY LAYER (the Phase 0 audit result — prevents
 * accidental double-retries):
 *   * ADD-ON path: `/api/downloader/mavero/addon` ALREADY retries
 *     transient failures internally (addon-download-service:
 *     MAX_RETRY_ATTEMPTS = 1 → initial + 1 upstream attempt per
 *     request). A source that lands `unavailable` has therefore ALREADY
 *     consumed its full initial + one-retry budget — the client must
 *     NOT spend another attempt on it. The ONLY add-on case with retry
 *     budget left is the honest `empty` result (the server made one
 *     successful attempt and returned zero links — no server-side
 *     retry applies to empty): the client spends the policy's single
 *     automatic retry there.
 *   * PLUGIN path: neither `/api/downloader/mavero2` nor
 *     `/api/downloader/mavero2/extension` performs any automatic
 *     retry (verified in the audit — no retry/backoff code on that
 *     path). The client IS the authoritative retry layer: a failed or
 *     empty plugin source gets exactly one automatic retry through the
 *     existing per-extension endpoint.
 *   * MANUAL refresh (`retryAll` → a fresh `load()`) starts a NEW
 *     logical load with fresh budgets. Re-renders and reactive updates
 *     never re-arm a budget — the decision depends only on the source's
 *     recorded lifecycle flags, which are created fresh per load().
 *
 * This module is pure and Node-testable — no DOM, no network, no state.
 */

/** Minimal structural view of a normalized link (UnifiedLinkView). */
export type RetryPolicyLink = { url?: string; kind?: string };

/**
 * Whether a link list contains at least one VALID, USABLE link.
 *
 * Normalization already dropped malformed entries upstream (null/missing
 * url entries are ignored at mapping time); this is the final guard:
 * a link is usable only when its URL is a non-empty string. An empty
 * list, or a list of blank-URL entries, is NOT usable. Malformed
 * entries never make a source "loaded" and never block the retry
 * policy — they are simply not links.
 */
export function hasValidUsableLinks(links: RetryPolicyLink[] | undefined | null): boolean {
  if (!Array.isArray(links)) return false;
  return links.some((link) => typeof link?.url === 'string' && link.url.trim().length > 0);
}

/** The source states the panel's typed model uses (SourceStatus). */
export type RetryPolicySourceStatus = 'loading' | 'retrying' | 'loaded' | 'empty' | 'unavailable' | 'failed';

export type AutoRetryDecisionInput = {
  kind: 'addon' | 'plugin';
  status: RetryPolicySourceStatus;
  /** The source's normalized links (malformed entries already dropped). */
  links: RetryPolicyLink[] | undefined | null;
  /** Whether the policy's single automatic retry was already spent. */
  autoRetryDone: boolean;
  /** Whether a retry for this source is queued or in flight right now. */
  retryQueued: boolean;
  /** Whether the source is already hidden from the selector. */
  hidden: boolean;
};

/**
 * What the panel should do with a source whose resolution has settled.
 *
 *   'keep'       — render the source normally (has valid links).
 *   'auto-retry' — schedule the ONE automatic retry for this source.
 *   'hide'       — remove the source from the selector (its budget is
 *                  spent without yielding valid links).
 *   'wait'       — the source is still loading/queued/decided — do
 *                  nothing yet.
 */
export type AutoRetryDecision = 'keep' | 'auto-retry' | 'hide' | 'wait';

export function autoRetryDecision(input: AutoRetryDecisionInput): AutoRetryDecision {
  const { kind, status, links, autoRetryDone, retryQueued, hidden } = input;

  // Hidden sources stay hidden — a hidden source never re-enters the
  // selector within the same logical load.
  if (hidden) return 'wait';

  // Still resolving (or its retry is queued/in flight) — no decision yet.
  if (status === 'loading' || status === 'retrying' || retryQueued) return 'wait';

  // Any source with valid usable links renders normally — regardless of
  // the status label ('loaded' and the plugin 'empty'-with-links case).
  if (hasValidUsableLinks(links)) return 'keep';

  // Zero valid links after the initial fetch:
  if (!autoRetryDone) {
    // ADD-ON transient failure: the server endpoint already spent the
    // full initial + one-retry budget before answering 'unavailable' —
    // spending a client attempt would DOUBLE-retry. Hide immediately.
    if (kind === 'addon' && status === 'unavailable') return 'hide';
    // Every other zero-link outcome (add-on honest empty; plugin failed
    // or empty — the plugin path has NO server retry layer) still has
    // the policy's single automatic retry available.
    return 'auto-retry';
  }

  // The automatic retry was already spent and the source STILL has no
  // valid links — hide it.
  return 'hide';
}

/**
 * Deterministic fallback selection after the active source is hidden
 * (or when no source was ever selected).
 *
 * Picks the FIRST source — in the panel's global-position order (the
 * array order, which comes exclusively from the /sources payload
 * positions) — that is (a) not hidden, (b) not still loading, and
 * (c) holds at least one valid usable link. Returns null when no such
 * source exists (the caller renders the all-hidden recoverable state).
 * Deterministic, side-effect free, and never triggers fetches.
 */
export function selectFallbackSourceId(
  sources: Array<{ id: string; hidden?: boolean; status?: RetryPolicySourceStatus; links?: RetryPolicyLink[] | null }>
): string | null {
  for (const source of sources) {
    if (source.hidden) continue;
    if (source.status === 'loading' || source.status === 'retrying') continue;
    if (!hasValidUsableLinks(source.links)) continue;
    return source.id;
  }
  return null;
}

/**
 * The ordered list of source ids that currently qualify for the ONE
 * automatic retry. Order follows the array (global position order) so
 * the bounded scheduler drains deterministically. Duplicate-safe: each
 * id appears once.
 */
export function planAutoRetries(
  sources: Array<{
    id: string;
    kind: 'addon' | 'plugin';
    hidden?: boolean;
    status?: RetryPolicySourceStatus;
    links?: RetryPolicyLink[] | null;
    autoRetryDone?: boolean;
    retryQueued?: boolean;
  }>
): string[] {
  const plan: string[] = [];
  for (const source of sources) {
    const decision = autoRetryDecision({
      kind: source.kind,
      status: source.status ?? 'loading',
      links: source.links,
      autoRetryDone: source.autoRetryDone === true,
      retryQueued: source.retryQueued === true,
      hidden: source.hidden === true,
    });
    if (decision === 'auto-retry' && !plan.includes(source.id)) plan.push(source.id);
  }
  return plan;
}

/**
 * Bounded concurrency for the automatic retry scheduler. The panel can
 * carry ~10+ sources; a batch-wide plugin failure must never explode
 * into an unbounded burst of simultaneous per-extension requests. Two
 * concurrent retries keep the drain quick while staying polite to the
 * upstream resolvers.
 */
export const AUTO_RETRY_CONCURRENCY = 2;
