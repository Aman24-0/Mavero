/**
 * Task 5 (2026-10-15) — Missing Media demand poster enrichment.
 *
 * Pure, testable core of the Missing Media page loader's poster
 * enrichment: demand rows carry no poster, but the canonical media_items
 * row for the SAME identity (parent series/anime for episodic demands,
 * the movie row for movie demands) persists poster_path on every link
 * (migration 20261015000000). This matcher reuses it so the Link Media
 * wizard shows the title's poster exactly like the normal Media Library
 * Add File flow.
 *
 * Matching rules:
 *   - EXACT (tmdb_id, content_type) match on TOP-LEVEL rows only
 *     (season/episode null) — no cross-type fallback (a series demand
 *     never picks up an anime parent's poster and vice versa).
 *   - No matching row → poster_path stays null (the wizard then
 *     backfills from the content detail endpoints — never invented).
 */

export type DemandLike = {
  tmdb_id?: unknown;
  content_type?: unknown;
  poster_path?: unknown;
};

export type PosterRow = {
  tmdb_id: string;
  content_type: string;
  poster_path: string | null;
};

/**
 * Attaches `poster_path` to every demand row in place (null when no
 * canonical row exists). `posterRows` are the batched top-level
 * media_items lookups for the demand tmdb ids.
 */
export function attachPosterPathsToDemands<T extends DemandLike>(demands: T[], posterRows: PosterRow[]): void {
  const posterByKey = new Map<string, string>();
  for (const row of posterRows) {
    if (row.poster_path) {
      // Exact content-type match; the LAST write wins (one row per
      // (tmdb_id, content_type) pair by canonical identity).
      posterByKey.set(`${row.tmdb_id}:${row.content_type}`, row.poster_path);
    }
  }
  for (const demand of demands) {
    const key = `${String(demand.tmdb_id ?? '')}:${String(demand.content_type ?? '')}`;
    demand.poster_path = posterByKey.get(key) ?? null;
  }
}
