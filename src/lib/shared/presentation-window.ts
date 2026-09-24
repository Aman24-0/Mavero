/**
 * Mavero Downloader — presentation window / Show More (Phase E V2).
 *
 * Implements the smart initial selection: for each quality bucket,
 * pick the BEST HTTPS candidate for the initial presentation window. The
 * remaining valid streams stay available via Show More.
 *
 * The input array MUST already be sorted by the server's ranking
 * (`buildDownloadCandidatesAll` sorts by score, best first). This module
 * does NOT re-rank — it groups by quality and picks the best HTTPS
 * candidate per group, falling back to the best non-HTTPS candidate
 * when no HTTPS exists for that quality.
 *
 * Different hosting servers remain independently usable — the initial
 * window picks ONE per quality, but the remaining streams (including
 * other hosts for the same quality) stay in the "remaining" list.
 *
 * No streams are permanently deleted — the full collection is preserved
 * and accessible via Show More.
 *
 * Pure module: no DOM, no network, no Svelte, no server imports.
 */

/** Minimal stream shape the presentation window needs. */
export type PresentableStream = {
  url: string;
  kind: string;
  quality: string;
};

export type PresentationResult<T> = {
  initial: T[];
  remaining: T[];
  total: number;
};

/**
 * Selects the initial presentation window: the best HTTPS candidate per
 * quality bucket. Falls back to the best non-HTTPS candidate when no HTTPS
 * exists for that quality.
 *
 * The input MUST be sorted by score (best first) — the server already does
 * this via `buildDownloadCandidatesAll`.
 */
export function selectPresentationWindow<T extends PresentableStream>(streams: T[]): PresentationResult<T> {
  if (streams.length === 0) return { initial: [], remaining: [], total: 0 };

  // Group by quality, preserving sort order within each group.
  const byQuality = new Map<string, T[]>();
  for (const s of streams) {
    const q = s.quality || 'auto';
    if (!byQuality.has(q)) byQuality.set(q, []);
    byQuality.get(q)!.push(s);
  }

  const initial: T[] = [];
  const remaining: T[] = [];
  // Track selected items by reference to avoid removing the wrong one
  // when two streams share a URL (after dedup they won't, but defensive).
  const selected = new Set<T>();

  for (const [, group] of byQuality) {
    // Find the best HTTPS candidate in this quality group.
    // Phase E final: HTTP IS NOT HTTPS. Only kind === 'https' qualifies.
    // If no HTTPS candidate exists, fall back to the best valid non-HTTP candidate.
    const httpsCandidate = group.find((s) => s.kind === 'https');
    const best = httpsCandidate ?? group[0];
    if (best) {
      initial.push(best);
      selected.add(best);
    }
    // Remaining = everything in this group except the selected one.
    for (const s of group) {
      if (s === best) continue;
      remaining.push(s);
    }
  }

  // Preserve the original sort order for both initial and remaining.
  initial.sort((a, b) => streams.indexOf(a) - streams.indexOf(b));
  remaining.sort((a, b) => streams.indexOf(a) - streams.indexOf(b));

  return {
    initial,
    remaining,
    total: streams.length,
  };
}

/** How many streams to reveal per "Show More" click. */
export const SHOW_MORE_BATCH_SIZE = 10;

/**
 * Appends the next batch of remaining streams to the visible list.
 * Returns the new visible list + the new remaining list.
 */
export function showMoreBatch<T>(visible: T[], remaining: T[], batchSize: number = SHOW_MORE_BATCH_SIZE): { visible: T[]; remaining: T[] } {
  const batch = remaining.slice(0, batchSize);
  return {
    visible: [...visible, ...batch],
    remaining: remaining.slice(batchSize),
  };
}
