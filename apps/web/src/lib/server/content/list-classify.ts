// Adult-aware LIST-rail classification (Adult Mode architecture rebuild,
// Phase 6 — direct enforcement + unsupported catalog paths).
//
// WHY THIS EXISTS
// ===============
// Phase 3 migrated every TMDB catalog path that SUPPORTS network/provider
// filters to query-level exclusion (`without_networks` for TV, transitional
// `without_watch_providers` for movies). The remaining TMDB endpoints do NOT
// support such filters:
//
//   /trending/{movie,tv}/week   (getTmdbDiscover — home + discover hero)
//   /{movie,tv}/popular         (getTmdbPopular — legacy popular)
//   /movie/now_playing          (getTmdbNowPlaying — theatre rail)
//   /{type}/{id}/recommendations via detail append_to_response
//
// Their rows carry NO `networks[]` (TV) and — for TV — no reliable `adult`
// flag either (verified Indian adult OTT originals are TMDB adult=false).
// Query params cannot fix this (the endpoints reject the filters), so —
// exactly like Phase 4 Search — each candidate must be CLASSIFIED
// server-side through the ONE central classifier and the adult candidates
// removed before the list is served.
//
// SINGLE-CLASSIFIER RULE (identical to search-classify.ts): verdicts never
// re-implement adult rules.
//   - Movie rows: the cheap flag path (`movieRowVerdict` → isAdultContent)
//     — list rows carry the TMDB adult boolean, movies have no network
//     identity, and the anime exemption lives inside the central classifier.
//     This is the Phase 4 movie-side contract, reused verbatim.
//   - TV rows: the authoritative network signal requires the detail
//     response, so the adapter injects a loader that reads the central
//     classification from the CACHED detail path (`tmdb:detail:*` — the same
//     cache Search uses; 30 min TTL, in-flight deduplicated). Failures are
//     'uncertain'.
//
// FAIL-CLOSED CONTRACT (normal rails): these rails are NORMAL catalog
// surfaces — they must stay adult-free REGARDLESS of Adult Mode state
// (Adult Mode ON only authorizes Adult-specific surfaces; it never injects
// adult titles into normal rails). Therefore 'uncertain' candidates are
// ALWAYS excluded here — not only when some caller is unauthorized. There
// is deliberately NO authorization parameter in this module: these are
// content facts, safe to cache, with no request-specific dimension.
//
// NO AUTHORIZATION STATE: this module performs classification and filtering
// only. Authorization (canAccessAdultContent — adult-policy.ts) is evaluated
// per request at the route/service layer and NEVER enters this module, its
// inputs, or any cache key it feeds. That separation is what keeps the
// filtered lists global-safe cache entries.
//
// BOUNDED WORK: callers classify at most one upstream page's worth of rows
// (20) or one detail's recommendation set (6), through mapWithConcurrency
// (deterministic bound) with deduplication by canonical content identity.
// No page continuation is performed here — unsupported rails keep TMDB's
// natural pagination semantics (a page shows the non-adult subset of that
// upstream page) and never walk extra upstream pages to "refill".

import { mapWithConcurrency } from './concurrency';
import { movieRowVerdict, detailVerdict, type CandidateVerdict } from './search-classify';

/**
 * One list candidate as seen by the rail classifier: the normalized item
 * plus the cheap signals available on its raw list row.
 * - `mediaType` routes the verdict: movies classify from the row flag,
 *   TV rows need the detail path (network identity).
 * - `rawAdult` is the TMDB adult boolean from the raw row (movies).
 */
export type RailCandidateRow<T> = {
  item: T;
  mediaType: 'movie' | 'series';
  rawAdult?: boolean;
};

/**
 * Adapter-injected verdict loader for TV candidates. Reads the central
 * classification from the cached detail path. MUST NOT throw — return
 * 'uncertain' on any failure (fail-closed contract).
 */
export type DetailVerdictLoader = (tmdbId: string) => Promise<CandidateVerdict>;

/**
 * Classify ONE rail candidate through the central classifier.
 * MUST NOT throw: any loader failure is reported as 'uncertain' and the
 * caller excludes it (fail-closed for normal rails).
 *
 * - Movies: cheap flag verdict via the ONE central classifier
 *   (movieRowVerdict → isAdultContent; anime exemption included).
 * - TV: the adapter's detail-path verdict loader (network identity is
 *   authoritative; list rows carry no networks[]).
 */
export async function classifyRailCandidate<T>(
  row: RailCandidateRow<T>,
  loadDetailVerdict: DetailVerdictLoader,
  tmdbIdOf: (item: T) => string
): Promise<CandidateVerdict> {
  if (row.mediaType === 'movie') {
    return movieRowVerdict({ adult: row.rawAdult, isAnime: undefined });
  }
  try {
    return await loadDetailVerdict(tmdbIdOf(row.item));
  } catch {
    // Defensive double-net: the loader contract says it never throws, but
    // a throwing loader must still fail CLOSED, never crash the rail and
    // never be read as "not adult".
    return 'uncertain';
  }
}

export type SafeRailFilterResult<T> = {
  /** Safe (non-adult, non-uncertain) candidates, input order, deduped. */
  items: T[];
  /** Diagnostics: candidates excluded as classified-adult. */
  excludedAdult: number;
  /** Diagnostics: candidates excluded as classification-uncertain (fail-closed). */
  excludedUncertain: number;
};

/**
 * Filter one page of list candidates down to its safe (adult-free) subset.
 *
 * Guarantees:
 * - Adult candidates are dropped; 'uncertain' candidates are dropped
 *   (normal rails are adult-free regardless of Adult Mode state).
 * - Classification runs with at most `concurrency` promises in flight
 *   (bounded — never unbounded Promise.all, never sequential).
 * - Duplicates (same canonical identity, within the page) are collected
 *   once — a duplicated row cannot bypass or double-count classification.
 * - Output preserves the input order of the surviving candidates.
 */
export async function filterSafeRailItems<T>(
  rows: RailCandidateRow<T>[],
  opts: {
    concurrency: number;
    loadDetailVerdict: DetailVerdictLoader;
    tmdbIdOf: (item: T) => string;
    identityOf: (item: T) => string;
  }
): Promise<SafeRailFilterResult<T>> {
  const { concurrency, loadDetailVerdict, tmdbIdOf, identityOf } = opts;
  const verdicts = await mapWithConcurrency(
    rows,
    (row) => classifyRailCandidate(row, loadDetailVerdict, tmdbIdOf),
    concurrency
  );
  const items: T[] = [];
  const seen = new Set<string>();
  let excludedAdult = 0;
  let excludedUncertain = 0;
  for (let index = 0; index < rows.length; index++) {
    const verdict = verdicts[index];
    if (verdict === 'adult') {
      excludedAdult += 1;
      continue;
    }
    if (verdict === 'uncertain') {
      // Fail-closed: an uncertain candidate must not reach a normal rail.
      // Never mapped to "not adult" (that would be a leakage path).
      excludedUncertain += 1;
      continue;
    }
    const identity = identityOf(rows[index].item);
    if (seen.has(identity)) continue;
    seen.add(identity);
    items.push(rows[index].item);
  }
  return { items, excludedAdult, excludedUncertain };
}

/**
 * Whether a detail response's recommendations must be filtered before the
 * detail reaches a consumer.
 *
 * The decision is a pure CONTENT fact (no authorization input — it MUST NOT
 * depend on who is asking, so the result stays cache-safe):
 *   - Parent classified ADULT   -> the page is an Adult-specific surface.
 *     Only authorization-checked requests can reach it (route guards), so
 *     its recommendations may be adult and pass through unfiltered.
 *   - Parent classified non-adult -> the page is a NORMAL surface, which
 *     must remain adult-free REGARDLESS of Adult Mode state. Filter.
 *   - Parent tags missing/absent  -> treated as non-adult (the central
 *     classifier already tagged genuinely-adult details 'Adult' at the
 *     detail-classification step; absence of the tag on a successfully
 *     classified detail is a legitimate "not adult").
 */
export function shouldFilterDetailRecommendations(parentTags: string[] | undefined): boolean {
  return detailVerdict(parentTags) !== 'adult';
}
