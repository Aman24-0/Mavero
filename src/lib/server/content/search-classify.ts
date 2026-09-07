// Adult-aware search classification + page-continuation orchestrator
// (Adult Mode architecture rebuild, Phase 4).
//
// WHY THIS EXISTS
// ===============
// TMDB's /search/movie and /search/tv endpoints support NEITHER
// with/without_networks NOR with/without_watch_providers, and TV search
// rows carry no `networks[]` metadata. `include_adult=false` therefore
// CANNOT be trusted to keep adult-network titles (Ullu/Kooku/Atrangii
// originals are TMDB `adult=false`) out of unauthorized search results.
// Search must classify its candidates server-side (bounded-concurrency
// detail lookups) and filter before responding.
//
// This module is the PURE, synchronous-to-describe orchestration layer:
// no env access, no I/O of its own, no caches, no clocks, and — most
// importantly — NO authorization state. The TMDB adapter (adapters/tmdb.ts)
// wires the real upstream fetch and the real classification into it:
//
//   TMDB /search page  →  row post-filters  →  classifyCandidate (bounded)
//   →  verdict = 'adult' | 'safe' | 'uncertain'
//   →  adult excluded; uncertain EXCLUDED when filtering for unauthorized
//   →  page continuation while the visible page is underfilled
//   →  dedup by canonical identity  →  stop at pageSize / total_pages / cap
//
// SINGLE-CLASSIFIER RULE: verdicts never re-implement adult rules.
// `movieRowVerdict` delegates to the ONE central classifier
// (`isAdultContent` in adult-providers.ts). `detailVerdict` reads the
// classification that `getTmdbDetail` already produced through the same
// central classifier (verified adult network registry — adult-networks.ts
// is the only place network IDs exist). No IDs, arrays, or rules are
// duplicated here.
//
// FAIL-CLOSED CONTRACT: a candidate whose classification is 'uncertain'
// (e.g. its detail lookup failed) is EXCLUDED when results are being
// filtered for unauthorized search. Uncertainty is never mapped to
// "not adult". When Adult Mode is ON the adapter does not invoke this
// orchestrator at all (adult results MAY appear for authorized users),
// so classification failures cannot suppress authorized results.
//
// CLASSIFICATION CACHE: the adapter's detail classification flows through
// the existing cached detail path (`tmdb:detail:{type}:{id}` — content
// metadata only, in-flight deduplicated by cache.ts). Authorization is
// NEVER part of classification or its cache keys; the authorization
// decision happens AFTER classification, at the filtering/response layer.

import { isAdultContent } from './adult-providers';
import { mapWithConcurrency } from './concurrency';

export type CandidateVerdict = 'adult' | 'safe' | 'uncertain';

/**
 * Authorization-aware search mode (decided SERVER-SIDE from the existing
 * policy function — never from client input). Extracted as a pure function
 * so the branch decision itself is behaviorally testable:
 *   - 'authorized-passthrough': adult results MAY appear (Adult Mode ON for
 *     an authorized user) — no classification N+1, pre-Phase-4 shape.
 *   - 'classify-and-exclude': every candidate is classified (bounded N+1),
 *     adult AND uncertain candidates are excluded (fail-closed).
 */
export function searchFilterMode(canAccessAdult: boolean): 'authorized-passthrough' | 'classify-and-exclude' {
  return canAccessAdult ? 'authorized-passthrough' : 'classify-and-exclude';
}

export type UpstreamSearchPage<T> = { items: T[]; totalPages: number };

export type SafeSearchPageResult<T> = {
  /** Safe candidates collected for the visible page (deduped, <= pageSize). */
  items: T[];
  /** Upstream TMDB pages actually fetched for this visible page. */
  upstreamPagesFetched: number;
  /** The last upstream page fetched (1-indexed, >= startPage). */
  lastUpstreamPage: number;
  /** True when upstream pagination is exhausted (no further pages could help). */
  upstreamExhausted: boolean;
  /** Diagnostics: candidates excluded as adult / uncertain. */
  excludedAdult: number;
  excludedUncertain: number;
};

/**
 * Cheap movie-row verdict — the movie path of search classification.
 * Search rows carry no tags, no watch providers, and movies never carry
 * networks, so this is exactly the central classifier applied to
 * (tags, no providers, TMDB adult flag, isAnime, no networks): the flag
 * decides for non-anime rows and the anime exemption keeps recognized
 * anime safe. Never fetches anything.
 */
export function movieRowVerdict(input: {
  adult?: boolean;
  isAnime?: boolean;
  tags?: string[];
  networks?: Array<{ id: number; name: string }>;
}): CandidateVerdict {
  return isAdultContent(input.tags, undefined, input.adult, input.isAnime, input.networks) ? 'adult' : 'safe';
}

/**
 * Verdict for a candidate whose detail metadata has already been
 * classified by the central pipeline (getTmdbDetail runs isAdultContent
 * over networks[]/providers/adult/isAnime and tags the result 'Adult').
 * Reads ONLY content metadata — no authorization state exists here.
 */
export function detailVerdict(tags: string[] | undefined): CandidateVerdict {
  return tags?.includes('Adult') === true ? 'adult' : 'safe';
}

export type CollectSafePageOptions<T> = {
  /** 1-indexed upstream page to start from (usually the visible page). */
  startPage: number;
  /** Stop once this many safe candidates are collected (visible page size). */
  pageSize: number;
  /** HARD cap on upstream pages fetched per call — prevents excess load and loops. */
  maxUpstreamPages: number;
  /** Fail-closed: exclude 'uncertain' candidates (true when filtering for unauthorized search). */
  excludeUncertain: boolean;
  /** Bounded-concurrency limit for classifyCandidate calls (deterministic). */
  concurrency: number;
  /** Fetch one upstream page of post-processed candidate rows. May throw (caller contract). */
  fetchUpstreamPage: (page: number) => Promise<UpstreamSearchPage<T>>;
  /** Classify one candidate row. MUST NOT throw — return 'uncertain' on failure. */
  classifyCandidate: (item: T) => Promise<CandidateVerdict>;
  /** Canonical content identity for dedup (movie vs series + TMDB id). */
  identityOf: (item: T) => string;
};

/**
 * Collect one visible page of SAFE search results with page continuation.
 *
 * Guarantees:
 * - At most `maxUpstreamPages` upstream pages are fetched, and never a page
 *   beyond TMDB's `total_pages` (no infinite loops, no wasted requests).
 * - Candidate classification runs with at most `concurrency` promises in
 *   flight (bounded N+1 — never unbounded Promise.all, never sequential).
 * - Candidates classified 'adult' are dropped; 'uncertain' candidates are
 *   dropped when `excludeUncertain` is set (fail-closed for unauthorized
 *   search); duplicates (same canonical identity, across or within pages)
 *   are collected once.
 * - A page fetch failure propagates to the caller (the adapter/service
 *   contract handles it — partial-page fallback semantics stay unchanged).
 */
export async function collectSafeSearchPage<T>(opts: CollectSafePageOptions<T>): Promise<SafeSearchPageResult<T>> {
  const { startPage, pageSize, maxUpstreamPages, excludeUncertain, concurrency, fetchUpstreamPage, classifyCandidate, identityOf } = opts;
  const collected: T[] = [];
  const seen = new Set<string>();
  let totalPages = Math.max(1, startPage); // pessimistic until TMDB reports the real total
  let lastUpstreamPage = startPage - 1;
  let pagesFetched = 0;
  let excludedAdult = 0;
  let excludedUncertain = 0;
  let exhausted = false;

  while (collected.length < pageSize && pagesFetched < maxUpstreamPages && !exhausted) {
    const upstreamPage = lastUpstreamPage + 1;
    const pageResult = await fetchUpstreamPage(upstreamPage);
    pagesFetched += 1;
    lastUpstreamPage = upstreamPage;
    totalPages = Math.max(totalPages, Math.max(1, pageResult.totalPages ?? upstreamPage));
    // Exhausted when this was the final upstream page, or the page came
    // back empty (nothing further could contribute safe candidates).
    if (upstreamPage >= totalPages || pageResult.items.length === 0) exhausted = true;

    const rows = pageResult.items;
    const verdicts = await mapWithConcurrency(rows, classifyCandidate, concurrency);
    for (let index = 0; index < rows.length; index++) {
      const row = rows[index];
      const verdict = verdicts[index];
      if (verdict === 'adult') {
        excludedAdult += 1;
        continue;
      }
      if (verdict === 'uncertain') {
        excludedUncertain += 1;
        // Fail-closed: an uncertain candidate must not leak through
        // unauthorized search. Never mapped to "not adult".
        if (excludeUncertain) continue;
      }
      const identity = identityOf(row);
      if (seen.has(identity)) continue;
      seen.add(identity);
      collected.push(row);
      if (collected.length >= pageSize) break;
    }
  }

  return {
    items: collected,
    upstreamPagesFetched: pagesFetched,
    lastUpstreamPage,
    upstreamExhausted: exhausted,
    excludedAdult,
    excludedUncertain
  };
}
