// Adult Discover catalog contract (Adult Mode architecture rebuild, Phase 7).
//
// WHY THIS EXISTS
// ===============
// Phase 7 adds a DEDICATED, authorization-gated Adult Discover catalog
// backend. Normal Discover (every rail, collection, trending and search
// surface) must stay adult-free REGARDLESS of Adult Mode state — Adult Mode
// ON never injects adult titles into normal rails (Phase 6 invariant). Adult
// content belongs ONLY to an explicitly authorized Adult surface, so the
// Adult catalog gets its OWN contract instead of an `includeAdult=true`
// flag threaded through generic Discover code. A caller can NEVER enable
// the Adult catalog through a query parameter — the only path in is the
// Phase 5 server-side authorization evaluated at the route layer.
//
//   NORMAL DISCOVER:  Adult excluded (always — content fact).
//   ADULT DISCOVER:   Adult included ONLY when authorized (per request).
//
// SOURCE BOUNDARY (server-controlled; no client input can alter it):
//   - TV:  /discover/tv with `with_networks=<verified adult network ids>`
//     (adult-catalog.ts -> adult-networks.ts — the ONLY place network IDs
//     exist). No JustWatch/watch-provider prerequisites: a verified adult
//     network title is adult catalog content even when TMDB adult=false and
//     even when it has no India watch-provider entry.
//   - Movie: /discover/movie has NO network filter in TMDB. The movie side
//     keeps the documented TRANSITIONAL watch-provider inclusion (resolved
//     adult provider names, watch_region=IN) — the same movie-side
//     architecture the central classifier already considers valid
//     (isAdultContent Signal 3). No title blacklists, no romance/drama/
//     mature/horror heuristics, no invented IDs. If nothing is verified,
//     the catalog is EMPTY (TV-first under-fill is the safe behavior).
//
// CLASSIFICATION DEFENSE-IN-DEPTH (asymmetric, fail-closed):
//   The query boundary is strong but not trusted blindly — upstream data
//   anomalies must not surface as Adult catalog entries. Every candidate is
//   classified through the ONE central classifier (isAdultContent via the
//   cached detail path) and ONLY candidates the classifier CONFIRMS as
//   adult are returned:
//     verdict 'adult'     -> confirmed -> returned.
//     verdict 'safe'      -> upstream anomaly vs the adult query -> dropped.
//     verdict 'uncertain' -> classification failure -> fail CLOSED -> dropped.
//   Uncertainty is never mapped to "adult" and a non-adult verdict is never
//   silently presented as Adult content. An under-filled catalog is the
//   accepted cost of the fail-closed contract.
//
// CACHE ISOLATION (structural):
//   Adult Discover responses live in their own cache namespace
//   (`tmdb:adult-discover:*` — see ADULT_DISCOVER_CACHE_NAMESPACE),
//   structurally disjoint from every normal Discover namespace
//   (`tmdb:discover:*`, `tmdb:popular-v2:*`, `tmdb:adult-shows:*`, ...) and
//   from search. No `cache[page] = authorized response` shape can leak in
//   either direction. The entries are CONTENT facts about the Adult catalog;
//   NO authorization decision is part of the key or the value, because NO
//   unauthorized request can reach the loader (the endpoint answers 404 and
//   the service answers empty BEFORE any cache access — the same precedent
//   as the Phase 3 `tmdb:adult-shows:` namespace, worklog section AA).
//   Classification itself flows through the shared content-keyed
//   `tmdb:detail:*` cache (content facts only — safe to share).
//
// NO AUTHORIZATION STATE (same contract as search-classify/list-classify):
//   This module validates input, builds keys, and classifies/filters
//   candidates. It performs NO authorization, reads NO env, imports NO
//   authorization module, and holds NO caches — importable and testable
//   under tsx. Authorization is evaluated per request by the caller
//   (endpoint -> canAccessAdultContent) and enforced a second time by the
//   service wrapper (empty result when not authorized).
//
// BOUNDED WORK:
//   Page continuation fetches at most ADULT_DISCOVER_MAX_UPSTREAM_PAGES
//   upstream pages per request and never walks past TMDB's total_pages;
//   classification runs through mapWithConcurrency with a deterministic
//   bound (ADULT_DISCOVER_CLASSIFY_CONCURRENCY). No unbounded crawling,
//   no recursion, no N+1 storms (detail lookups are cached + deduped).

import { mapWithConcurrency } from './concurrency';
import { movieRowVerdict, type CandidateVerdict, type UpstreamSearchPage } from './search-classify';
import { isDiscoverLanguageValue } from './types';
import type { ContentList, DiscoverLanguage } from './types';

// ============================================================
// Contract types — the closed filter surface of Adult Discover.
// There is deliberately NO network/provider field: the verified
// Adult network set is server-controlled and cannot be narrowed,
// widened, or replaced by client input.
// ============================================================

export type AdultDiscoverType = 'movie' | 'series';
export type AdultDiscoverSort = 'popularity' | 'newest' | 'top-rated';

export type AdultDiscoverFilters = {
  type: AdultDiscoverType;
  language: DiscoverLanguage;
  sort: AdultDiscoverSort;
  page: number;
};

// ============================================================
// Bounded constants (mirroring the Search/Phase 6 conventions).
// ============================================================

/** Visible page size — the Discover section convention (10 items). */
export const ADULT_DISCOVER_PAGE_SIZE = 10;
/** HARD cap on upstream pages fetched per request while filtering. */
export const ADULT_DISCOVER_MAX_UPSTREAM_PAGES = 3;
/** Max simultaneous detail classifications per request (Search/rail bound). */
export const ADULT_DISCOVER_CLASSIFY_CONCURRENCY = 4;
/** Inclusive upper bound for the requested page (repo Discover convention). */
export const ADULT_DISCOVER_PAGE_CLAMP_MAX = 20;
/**
 * Structural cache namespace of the Adult Discover catalog. Disjoint from
 * every normal Discover namespace by construction (string prefix).
 */
export const ADULT_DISCOVER_CACHE_NAMESPACE = 'tmdb:adult-discover';

// ============================================================
// Input validation (strict, closed unions — nothing reaches TMDB
// unrestricted; malformed input is rejected/clamped, never passed
// through).
// ============================================================

/** Strict catalog type guard: only 'movie' | 'series' are valid. */
export function isAdultDiscoverType(value: string | null | undefined): value is AdultDiscoverType {
  return value === 'movie' || value === 'series';
}

/** Strict sort guard: only the closed sort union is valid. */
export function isAdultDiscoverSort(value: string | null | undefined): value is AdultDiscoverSort {
  return value === 'popularity' || value === 'newest' || value === 'top-rated';
}

/**
 * Language guard for Adult Discover — the SAME closed DiscoverLanguage
 * union normal Discover uses (single source in types.ts). The language
 * filter can only ever NARROW the catalog: the mandatory Adult source
 * constraint is applied at the TMDB query level AND re-verified by the
 * classifier, so a language can never replace or dilute the Adult
 * condition (Adult AND language, never Adult OR language).
 */
export function isAdultDiscoverLanguage(value: string | null | undefined): value is DiscoverLanguage {
  return isDiscoverLanguageValue(value);
}

/**
 * Validate + clamp the requested page. Invalid input clamps to 1
 * (repo Discover convention); arbitrarily large values clamp to
 * ADULT_DISCOVER_PAGE_CLAMP_MAX so no `page=999999999` can walk the
 * upstream catalog unbounded.
 */
export function parseAdultDiscoverPage(value: string | null | undefined): number {
  const parsed = Number(value ?? 1);
  if (!Number.isFinite(parsed)) return 1;
  return Math.max(1, Math.min(Math.trunc(parsed), ADULT_DISCOVER_PAGE_CLAMP_MAX));
}

/**
 * TMDB sort_by for an Adult Discover query (pure; the date/vote-floor
 * refinements for 'newest'/'top-rated' are adapter concerns).
 */
export function adultDiscoverSortBy(sort: AdultDiscoverSort, type: AdultDiscoverType): string {
  if (sort === 'top-rated') return 'vote_average.desc';
  if (sort === 'newest') return type === 'movie' ? 'primary_release_date.desc' : 'first_air_date.desc';
  return 'popularity.desc';
}

// ============================================================
// Cache key construction (structural isolation).
// ============================================================

/**
 * Adult Discover response cache key. The applied source-inclusion values
 * (network inclusion for TV / provider inclusion for movies) are part of
 * the key so a registry change re-keys instead of serving stale-era
 * entries. The namespace prefix structurally separates these entries from
 * every normal Discover/search/adult-shows cache entry — the isolation is
 * the key format itself, not a convention.
 *
 * NO authorization dimension: only authorized requests can reach the
 * loader (endpoint 404 + service empty-result guard run BEFORE any cache
 * access), so there is no second context to isolate against — and the
 * authorization decision is never stored anywhere (per-request only).
 */
export function buildAdultDiscoverCacheKey(input: {
  type: AdultDiscoverType;
  language: DiscoverLanguage;
  sort: AdultDiscoverSort;
  page: number;
  networkInclusion?: string;
  providerInclusion?: string;
}): string {
  return `${ADULT_DISCOVER_CACHE_NAMESPACE}:${input.type}:${input.language}:${input.sort}:${input.page}:${input.networkInclusion ?? 'no-networks'}:${input.providerInclusion ?? 'no-providers'}`;
}

/**
 * The empty, non-disclosing Adult Discover result. Used by the service
 * wrapper for unauthorized/defense-in-depth calls and by the adapter when
 * nothing verified is available to query. NEVER a fixture/normal-catalog
 * fallback: the Adult catalog cannot degrade into normal content.
 */
export function emptyAdultDiscoverResult(page: number): ContentList {
  return { items: [], page, hasNextPage: false, source: { provider: 'tmdb', fetchedAt: new Date().toISOString() } };
}

// ============================================================
// Candidate classification (defense-in-depth; ONE central classifier).
// ============================================================

/**
 * One Adult Discover candidate as seen by the classifier: the normalized
 * item plus the cheap raw-row signals. `rawAdult` is TMDB's adult boolean
 * from the raw list row (normalized items do not carry it); `isAnime`
 * feeds the classifier's anime exemption (genre 16 + ja detection happens
 * in the adapter's mapTmdb — unchanged).
 */
export type AdultDiscoverCandidateRow<T> = {
  item: T;
  mediaType: AdultDiscoverType;
  rawAdult?: boolean;
  isAnime?: boolean;
};

/**
 * Adapter-injected verdict loader: reads the central classification from
 * the cached detail path (getTmdbDetail classifies via isAdultContent over
 * networks[]/providers/adult/isAnime and tags the result 'Adult'). MAY
 * throw — classifyAdultDiscoverRow maps any failure to 'uncertain'
 * (fail-closed contract).
 */
export type AdultDiscoverDetailVerdictLoader = (
  mediaType: AdultDiscoverType,
  tmdbId: string
) => Promise<CandidateVerdict>;

/**
 * Classify ONE Adult Discover candidate. Returns the verdict the collector
 * applies with the ADULT-SURFACE contract:
 *   'adult'     -> confirmed by the central classifier -> returned.
 *   'safe'      -> the classifier actively says non-adult -> anomaly.
 *   'uncertain' -> any classification failure -> fail closed.
 * MUST NOT throw.
 *
 * Movie rows use the cheap confirm-first path (Phase 4 movie contract):
 * the TMDB adult flag can CONFIRM adult (Signal 4, anime exemption
 * included via the central classifier) without any detail request — but it
 * can never DENY here, because the transitional provider signal (Signal 3)
 * lives in the detail. A non-confirming movie row therefore escalates to
 * the detail path. TV rows always classify through the detail path (list
 * rows carry no networks[] and adult=false proves nothing).
 */
export async function classifyAdultDiscoverRow<T>(
  row: AdultDiscoverCandidateRow<T>,
  loadDetailVerdict: AdultDiscoverDetailVerdictLoader,
  tmdbIdOf: (item: T) => string
): Promise<CandidateVerdict> {
  if (row.mediaType === 'movie') {
    // Cheap path through the ONE central classifier (movieRowVerdict ->
    // isAdultContent): can only CONFIRM ('adult'); a 'safe' cheap verdict
    // is not a denial in this context — escalate to the detail path.
    if (movieRowVerdict({ adult: row.rawAdult, isAnime: row.isAnime }) === 'adult') {
      return 'adult';
    }
  }
  try {
    return await loadDetailVerdict(row.mediaType, tmdbIdOf(row.item));
  } catch {
    // Fail-closed: a failed classification is never read as "adult enough"
    // nor as "not adult" — it is uncertainty, and the collector drops it.
    return 'uncertain';
  }
}

export type ConfirmedAdultPageResult<T> = {
  /** Confirmed-adult candidates for the visible page (deduped, <= pageSize). */
  items: AdultDiscoverCandidateRow<T>[];
  /** Upstream TMDB pages actually fetched for this visible page. */
  upstreamPagesFetched: number;
  /** True when upstream pagination is exhausted (no further pages could help). */
  upstreamExhausted: boolean;
  /** Diagnostics: candidates the classifier actively said are NOT adult (anomalies). */
  excludedNotAdult: number;
  /** Diagnostics: candidates dropped as classification-uncertain (fail-closed). */
  excludedUncertain: number;
};

/**
 * Collect one visible page of CONFIRMED-ADULT candidates with bounded page
 * continuation.
 *
 * Guarantees:
 * - ONLY 'adult' verdicts are collected. 'safe' (anomaly vs the adult
 *   source query) and 'uncertain' (classification failure) candidates are
 *   dropped — fail-closed in BOTH directions: unknown content never enters
 *   the Adult catalog, and classification failures never suppress the
 *   fail-closed contract.
 * - At most `maxUpstreamPages` upstream pages are fetched, and never a page
 *   beyond TMDB's `total_pages` (no infinite loops, no unbounded walking).
 * - Classification runs with at most `concurrency` promises in flight
 *   (bounded — never unbounded Promise.all, never sequential).
 * - Duplicates (same canonical identity, across or within pages) are
 *   collected once.
 * - A page fetch failure PROPAGATES to the caller: Adult Discover has NO
 *   fallback to the normal catalog and no fixture data — the caller turns
 *   the error into an error/empty response, never into normal content.
 */
export async function collectConfirmedAdultPage<T>(opts: {
  /** 1-indexed upstream page to start from (the requested page). */
  startPage: number;
  /** Stop once this many confirmed candidates are collected (visible page size). */
  pageSize: number;
  /** HARD cap on upstream pages fetched per call. */
  maxUpstreamPages: number;
  /** Bounded-concurrency limit for classification (deterministic). */
  concurrency: number;
  /** Fetch one upstream page of candidate rows. May throw (propagates). */
  fetchUpstreamPage: (page: number) => Promise<UpstreamSearchPage<AdultDiscoverCandidateRow<T>>>;
  /** Classify one candidate row. MUST NOT throw — returns the verdict. */
  classifyCandidate: (row: AdultDiscoverCandidateRow<T>) => Promise<CandidateVerdict>;
  /** Canonical content identity for dedup (movie vs series + TMDB id). */
  identityOf: (row: AdultDiscoverCandidateRow<T>) => string;
}): Promise<ConfirmedAdultPageResult<T>> {
  const { startPage, pageSize, maxUpstreamPages, concurrency, fetchUpstreamPage, classifyCandidate, identityOf } = opts;
  const collected: AdultDiscoverCandidateRow<T>[] = [];
  const seen = new Set<string>();
  let totalPages = Math.max(1, startPage); // pessimistic until TMDB reports the real total
  let lastUpstreamPage = startPage - 1;
  let pagesFetched = 0;
  let excludedNotAdult = 0;
  let excludedUncertain = 0;
  let exhausted = false;

  while (collected.length < pageSize && pagesFetched < maxUpstreamPages && !exhausted) {
    const upstreamPage = lastUpstreamPage + 1;
    const pageResult = await fetchUpstreamPage(upstreamPage);
    pagesFetched += 1;
    lastUpstreamPage = upstreamPage;
    totalPages = Math.max(totalPages, Math.max(1, pageResult.totalPages ?? upstreamPage));
    // Exhausted when this was the final upstream page, or the page came
    // back empty (nothing further could contribute confirmed candidates).
    if (upstreamPage >= totalPages || pageResult.items.length === 0) exhausted = true;

    const rows = pageResult.items;
    const verdicts = await mapWithConcurrency(rows, classifyCandidate, concurrency);
    for (let index = 0; index < rows.length; index++) {
      const row = rows[index];
      const verdict = verdicts[index];
      if (verdict === 'adult') {
        const identity = identityOf(row);
        if (seen.has(identity)) continue;
        seen.add(identity);
        collected.push(row);
        if (collected.length >= pageSize) break;
        continue;
      }
      if (verdict === 'uncertain') {
        // Fail-closed: an uncertain candidate must not enter the Adult
        // catalog. Never mapped to "adult" and never counted as confirmed.
        excludedUncertain += 1;
        continue;
      }
      // 'safe': the central classifier actively says this candidate is NOT
      // adult — an upstream/data anomaly against the adult source query.
      // It is not silently presented as Adult content; it is dropped.
      excludedNotAdult += 1;
    }
  }

  return {
    items: collected,
    upstreamPagesFetched: pagesFetched,
    upstreamExhausted: exhausted,
    excludedNotAdult,
    excludedUncertain
  };
}
