// ============================================================================
// Phase 6 behavioral tests — direct enforcement, unsupported catalog paths,
// cache isolation. (Adult Mode architecture rebuild; see
// Mavero_Adult_Mode_Rebuild_Worklog.md.)
//
// REAL behavioral tests: they execute the actual list-rail classification
// orchestrator (list-classify.ts — filterSafeRailItems /
// classifyRailCandidate / shouldFilterDetailRecommendations), the actual
// verdict helpers wired to the ONE central classifier (movieRowVerdict /
// detailVerdict -> isAdultContent), the actual authorization matrix
// (adult-authz.ts — evaluateAdultAccess), the actual registry-backed
// network signal (adult-networks.ts + adult-providers.ts) and the actual
// process cache (cache.ts) — all with injected deterministic dependencies.
// Deterministic and credential-free.
//
// The adapter (adapters/tmdb.ts), the service wrapper and the SvelteKit
// routes cannot be imported under tsx (they import $env / $app / $lib
// aliases); their WIRING is asserted statically in scripts/adult_mode_test.ts
// section AA — the same adapter/behavioral split used by the Phase 4/5
// suites. Every behavioral case below exercises exactly the pure function
// the wiring feeds: e.g. the theatre rail drops candidates through
// filterSafeRailItems (case 9 exercises that function directly).
//
// Covered scenarios (Phase 6 spec §17):
//    1  Unauthorized Adult TV detail            -> block (404 decision)
//    2  Authorized Adult TV detail              -> allowed
//    3  Admin OFF + user ON                     -> blocked (hard override)
//    4  Adult network + TMDB adult=false        -> classified Adult
//    5  Normal title                            -> allowed
//    6  Classification failure                  -> fail closed (excluded)
//    7  Adult title from trending               -> filtered
//    8  Adult title from legacy popular         -> filtered
//    9  Adult title from theatre                -> filtered
//   10  Adult title from upcoming (movie path)  -> filtered
//   11  Adult title from genre path             -> filtered
//   12  Adult title from recommendations        -> filtered
//   13  Adult title from related/similar        -> filtered
//   14  Anime adult=true, no network signal     -> NOT Adult (exemption)
//   15  Adult-authorized response reused for Adult OFF -> impossible (keys)
//   16  Adult OFF result suppressing authorized surface -> impossible (keys)
//   17  Authorization decision is request-scoped -> fresh per call
//   18  Classification metadata cache shared safely -> content-keyed
//   19  Cache keys structurally distinguish contexts -> exact key shape
//   20  Fallback fixtures cannot introduce Adult titles -> all safe
//   21  Failed classification never leaks the candidate -> dropped
//   22  Duplicate candidates cannot bypass classification -> deduped
//   23  (extra) rail classification bounded concurrency <= 4
//   24  (extra) recommendation filter decision: adult parent keeps recs
// ============================================================================

import assert from 'node:assert/strict';
import {
  filterSafeRailItems,
  classifyRailCandidate,
  shouldFilterDetailRecommendations,
  type RailCandidateRow
} from '../src/lib/server/content/list-classify.ts';
import {
  movieRowVerdict,
  detailVerdict,
  buildSearchCacheKey,
  SEARCH_CACHE_AUTH_DIMENSIONS,
  type CandidateVerdict
} from '../src/lib/server/content/search-classify.ts';
import { evaluateAdultAccess } from '../src/lib/server/content/adult-authz.ts';
import { isAdultContent } from '../src/lib/server/content/adult-providers.ts';
import { isKnownAdultNetwork } from '../src/lib/server/content/adult-networks.ts';
import { mapWithConcurrency } from '../src/lib/server/content/concurrency.ts';
import { getOrSet, clearCache } from '../src/lib/server/content/cache.ts';
import { media } from '../src/lib/data/content.ts';

let passed = 0;
function ok(label: string): void {
  passed++;
  console.log(`  ok ${passed} - ${label}`);
}

// ---------------------------------------------------------------------------
// Deterministic mock layer.
//
// detail-verdict loaders simulate the cached-detail classification path: an
// adult-network TV title's cached detail carries the classifier's 'Adult'
// tag; an ordinary title's detail does not; a failed lookup reports
// 'uncertain' (the exact contract the adapter's railDetailVerdictLoader and
// classifySearchRow implement).
// ---------------------------------------------------------------------------

type MockDetailTable = Record<string, CandidateVerdict>;

function makeDetailLoader(table: MockDetailTable) {
  return async (tmdbId: string): Promise<CandidateVerdict> => {
    const verdict = table[tmdbId];
    if (verdict === undefined) throw new Error('detail lookup failed');
    return verdict;
  };
}

type Row = { id: string; title: string };

function tvRow(id: string, title: string): RailCandidateRow<Row> {
  return { item: { id, title }, mediaType: 'series' };
}

function movieRowWithFlag(id: string, title: string, adult?: boolean): RailCandidateRow<Row> {
  return { item: { id, title }, mediaType: 'movie', rawAdult: adult };
}

const noAdultDetail: MockDetailTable = {};

// A Ullu/Kooku/Atrangii-shaped TV detail: the central classifier tagged it
// 'Adult' because of its VERIFIED network (TMDB adult=false is irrelevant).
const adultNetworkDetail: MockDetailTable = { '9001': 'adult' };

// ---------------------------------------------------------------------------
// Shared filter options (deterministic, credential-free).
// ---------------------------------------------------------------------------

function filterOpts(table: MockDetailTable) {
  return {
    concurrency: 4,
    loadDetailVerdict: makeDetailLoader(table),
    tmdbIdOf: (item: Row) => item.id,
    identityOf: (item: Row) => `series:${item.id}`
  };
}

// ============================================================================
// 1-3 + 5 — the direct watch/detail decision composed from the REAL
// classifier verdict reader and the REAL authorization matrix. The watch
// route + season endpoint wire exactly these two functions (statically
// asserted in adult_mode_test.ts section AA): adult-classified detail AND
// !canAccessAdultContent -> non-disclosing 404.
// ============================================================================
{
  const adultTags = ['Adult'];
  const normalTags: string[] | undefined = undefined;

  // 1. Unauthorized Adult TV -> block.
  {
    const ctx = evaluateAdultAccess({
      policy: { allowLoggedIn: true, allowGuest: true },
      isAuthenticated: false,
      userPreference: false // guest preference OFF (or unverifiable cookie)
    });
    const blocked = detailVerdict(adultTags) === 'adult' && !ctx.canAccessAdultContent;
    assert.equal(detailVerdict(adultTags), 'adult');
    assert.equal(ctx.canAccessAdultContent, false);
    assert.equal(blocked, true);
    ok('1. unauthorized Adult TV watch/detail request is BLOCKED (non-disclosing 404 decision)');
  }

  // 2. Authorized Adult TV -> allowed.
  {
    const ctx = evaluateAdultAccess({
      policy: { allowLoggedIn: true, allowGuest: true },
      isAuthenticated: true,
      userPreference: true
    });
    const blocked = detailVerdict(adultTags) === 'adult' && !ctx.canAccessAdultContent;
    assert.equal(ctx.canAccessAdultContent, true);
    assert.equal(blocked, false);
    ok('2. authorized Adult TV watch/detail request is ALLOWED');
  }

  // 3. Admin OFF + user ON -> blocked (admin policy hard override).
  {
    const ctx = evaluateAdultAccess({
      policy: { allowLoggedIn: false, allowGuest: false },
      isAuthenticated: true,
      userPreference: true
    });
    const blocked = detailVerdict(adultTags) === 'adult' && !ctx.canAccessAdultContent;
    assert.equal(ctx.canAccessAdultContent, false);
    assert.equal(blocked, true);
    ok('3. Admin OFF + user preference ON is BLOCKED (admin hard override)');
  }

  // 5. Normal title -> allowed for anyone.
  {
    const guestCtx = evaluateAdultAccess({
      policy: { allowLoggedIn: false, allowGuest: false },
      isAuthenticated: false,
      userPreference: false
    });
    const blocked = detailVerdict(normalTags) === 'adult' && !guestCtx.canAccessAdultContent;
    assert.equal(detailVerdict(normalTags), 'safe');
    assert.equal(blocked, false);
    ok('5. normal (non-adult) title is allowed regardless of authorization');
  }
}

// ============================================================================
// 4 — verified adult network + TMDB adult=false -> Adult (REAL registry).
// ============================================================================
{
  assert.equal(isKnownAdultNetwork({ id: 2902, name: 'Ullu' }), true, 'Ullu network is verified in the real registry');
  // TV detail-shaped classification: adult=false, no providers, non-anime.
  const flaggedFalse = isAdultContent(undefined, undefined, false, false, [{ id: 2902, name: 'Ullu' }]);
  assert.equal(flaggedFalse, true);
  // The same verdict through the cached-detail tag read.
  assert.equal(detailVerdict(['Adult']), 'adult');
  ok('4. verified adult network (Ullu=2902) classifies Adult even with TMDB adult=false');
}

// ============================================================================
// 6 + 21 — classification failure fails CLOSED on Adult-sensitive paths.
// ============================================================================
{
  // A TV candidate whose detail lookup FAILS is 'uncertain' and MUST be
  // excluded from every normal rail (never mapped to "not adult").
  const rows = [
    tvRow('2001', 'Reliable Ordinary Show'),
    tvRow('3001', 'Failing Lookup Show')
  ];
  const table: MockDetailTable = { '2001': 'safe' }; // 3001 is absent -> lookup throws
  const result = await filterSafeRailItems(rows, filterOpts(table));
  assert.deepEqual(result.items.map((item) => item.id), ['2001']);
  assert.equal(result.excludedUncertain, 1);
  assert.equal(result.excludedAdult, 0);
  ok('6. classification failure on a normal rail fails CLOSED (candidate excluded)');
  ok('21. failed Adult classification does NOT leak the candidate (dropped, not kept)');
}

// ============================================================================
// 7 — trending rail: adult TV (network signal) + adult-flag movie filtered.
// ============================================================================
{
  const rows: RailCandidateRow<Row>[] = [
    { ...tvRow('9001', 'Ullu-style Adult Serial'), mediaType: 'series' },
    { ...movieRowWithFlag('4001', 'Ordinary Blockbuster', false), mediaType: 'movie' },
    { ...movieRowWithFlag('4002', 'Adult-flagged Movie', true), mediaType: 'movie' },
    tvRow('2002', 'Ordinary Trending Show')
  ];
  const table: MockDetailTable = { ...adultNetworkDetail, '2002': 'safe' };
  const result = await filterSafeRailItems(rows, { ...filterOpts(table), identityOf: (item) => item.id });
  assert.deepEqual(result.items.map((item) => item.id), ['4001', '2002'], 'TMDB order preserved, adult rows gone');
  assert.equal(result.excludedAdult, 2);
  ok('7. adult titles from TRENDING are filtered (network TV + flag movie)');
}

// ============================================================================
// 8 — legacy popular rail: same classification contract.
// ============================================================================
{
  const rows: RailCandidateRow<Row>[] = [
    tvRow('9001', 'Adult Serial On Legacy Popular'),
    tvRow('2003', 'Ordinary Popular Show')
  ];
  const table: MockDetailTable = { ...adultNetworkDetail, '2003': 'safe' };
  const result = await filterSafeRailItems(rows, { ...filterOpts(table), identityOf: (item) => item.id });
  assert.deepEqual(result.items.map((item) => item.id), ['2003']);
  assert.equal(result.excludedAdult, 1);
  ok('8. adult title from LEGACY POPULAR is filtered (network TV signal)');
}

// ============================================================================
// 9 — theatre rail: /movie/now_playing rows are movie rows -> the cheap flag
// path via the central classifier (the exact function the adapter feeds).
// ============================================================================
{
  const rows: RailCandidateRow<Row>[] = [
    movieRowWithFlag('5001', 'Normal Theatre Release', false),
    movieRowWithFlag('5002', 'Adult-flagged Theatre Release', true)
  ];
  const result = await filterSafeRailItems(rows, { ...filterOpts(noAdultDetail), identityOf: (item) => item.id });
  assert.deepEqual(result.items.map((item) => item.id), ['5001']);
  assert.equal(result.excludedAdult, 1);
  // Direct proof of the exact wiring: movieRowVerdict routes the flag.
  assert.equal(movieRowVerdict({ adult: true }), 'adult');
  ok('9. adult title from THEATRE (now_playing) is filtered via the flag verdict');
}

// ============================================================================
// 10 — upcoming movies path: the module classifies rows with
// movieRowVerdict({adult, isAnime}) — the same function exercised here.
// (The upcoming series path classifies via isAdultContent over detail
// networks — covered by case 4's classifier call shape.)
// ============================================================================
{
  assert.equal(movieRowVerdict({ adult: true, isAnime: false }), 'adult');
  assert.equal(movieRowVerdict({ adult: true, isAnime: true }), 'safe'); // anime exemption
  // Upcoming-series-shaped classifier call (raw detail networks).
  assert.equal(isAdultContent(undefined, undefined, undefined, false, [{ id: 4573, name: 'Kooku' }]), true);
  ok('10. upcoming rails filter adult titles (flag path + network path through the ONE classifier)');
}

// ============================================================================
// 11 — genre rails: movie rows with the flag path (the genre rail is
// movie-only; the region-corrected provider exclusion + this filter apply).
// ============================================================================
{
  const rows: RailCandidateRow<Row>[] = [
    movieRowWithFlag('6001', 'Romance Genre Movie (normal)', false),
    movieRowWithFlag('6002', 'Adult Genre Movie', true)
  ];
  const result = await filterSafeRailItems(rows, { ...filterOpts(noAdultDetail), identityOf: (item) => item.id });
  assert.deepEqual(result.items.map((item) => item.id), ['6001']);
  // No genre heuristic: romance is NOT adult, and a normal romance title
  // survives while the adult FLAGGED one is dropped — classification, not
  // genre assumptions.
  assert.equal(movieRowVerdict({ adult: false }), 'safe');
  ok('11. adult title from GENRE path is filtered (no romance/mature genre heuristics)');
}

// ============================================================================
// 12 + 13 + 24 — detail recommendations: non-adult parent -> recs filtered;
// adult parent -> recs kept (Adult-specific surface). The same mechanism
// covers related/similar strips (they flow through the detail response).
// ============================================================================
{
  assert.equal(shouldFilterDetailRecommendations(undefined), true, 'unclassified parent = normal surface');
  assert.equal(shouldFilterDetailRecommendations([]), true);
  assert.equal(shouldFilterDetailRecommendations(['Recommended']), true);
  assert.equal(shouldFilterDetailRecommendations(['Adult']), false);
  ok('12. recommendation filtering decided by the parent CLASSIFICATION (content fact)');
  ok('24. adult parent keeps its recommendations (Adult-specific surface, guard-gated)');

  // The rec strip of a NORMAL parent: adult-network TV rec + flag movie rec
  // dropped; safe recs kept in order.
  const rows: RailCandidateRow<Row>[] = [
    { ...tvRow('9001', 'Adult Rec'), mediaType: 'series' },
    { ...movieRowWithFlag('7001', 'Safe Rec Movie', false), mediaType: 'movie' },
    { ...movieRowWithFlag('7002', 'Adult Rec Movie', true), mediaType: 'movie' },
    { ...tvRow('2004', 'Safe Rec Show'), mediaType: 'series' }
  ];
  const table: MockDetailTable = { ...adultNetworkDetail, '2004': 'safe' };
  const result = await filterSafeRailItems(rows, { ...filterOpts(table), identityOf: (item) => item.id });
  assert.deepEqual(result.items.map((item) => item.id), ['7001', '2004']);
  assert.equal(result.excludedAdult, 2);
  ok('13. adult titles from recommendation/related strips are filtered (normal surface)');
}

// ============================================================================
// 14 — anime exemption preserved end-to-end (REAL classifier).
// ============================================================================
{
  // adult=true + recognized anime (genre 16 + ja) -> NOT adult.
  assert.equal(isAdultContent(undefined, undefined, true, true, undefined), false);
  assert.equal(movieRowVerdict({ adult: true, isAnime: true }), 'safe');
  // BUT an explicit adult-network signal still applies to anime content.
  assert.equal(isAdultContent(undefined, undefined, true, true, [{ id: 7355, name: 'Atrangii' }]), true);
  ok('14. anime with adult=true but no adult-network signal is NOT Adult (exemption intact)');
}

// ============================================================================
// 15/16/19 — cache isolation: the authorization decision is PART of the
// search response cache key (structural, not conventional).
// ============================================================================
{
  clearCache();
  const base = { type: 'series', query: 'Kavita', page: 1 } as const;
  const authorizedKey = buildSearchCacheKey({ ...base, canAccessAdult: true });
  const unauthorizedKey = buildSearchCacheKey({ ...base, canAccessAdult: false });
  // Exact structural shape — BYTE-COMPATIBLE with the pre-Phase-6 inline
  // construction (`tmdb:search:${type}:${query}:${page}:${ott}:${genre}:${sort}:${dim}`,
  // page 1 and all filters empty -> four colons between page and dimension).
  const legacyInlineAuthorized = `tmdb:search:series:kavita:1:${''}:${''}:${''}:adult-allowed`;
  assert.equal(authorizedKey, legacyInlineAuthorized);
  assert.equal(authorizedKey, 'tmdb:search:series:kavita:1::::adult-allowed');
  assert.equal(unauthorizedKey, 'tmdb:search:series:kavita:1::::adult-excluded');
  assert.notEqual(authorizedKey, unauthorizedKey);
  assert.equal(SEARCH_CACHE_AUTH_DIMENSIONS.allowed, 'adult-allowed');
  assert.equal(SEARCH_CACHE_AUTH_DIMENSIONS.excluded, 'adult-excluded');
  ok('19. search cache keys STRUCTURALLY distinguish authorized vs unauthorized contexts');

  // Behavioral: two contexts sharing ONE process cache read DIFFERENT
  // entries — an adult-allowed response can never be served to an
  // adult-excluded request and vice versa.
  await getOrSet(authorizedKey, { ttlMs: 10000 }, async () => ({ marker: 'authorized-response', items: ['adult-title'] }));
  await getOrSet(unauthorizedKey, { ttlMs: 10000 }, async () => ({ marker: 'unauthorized-response', items: [] }));
  const asUnauthorized = await getOrSet(authorizedKey, { ttlMs: 10000 }, async () => ({ marker: 'recomputed', items: [] }));
  const asAuthorized = await getOrSet(unauthorizedKey, { ttlMs: 10000 }, async () => ({ marker: 'recomputed', items: [] }));
  assert.equal((asUnauthorized.value as { marker: string }).marker, 'authorized-response');
  assert.equal((asAuthorized.value as { marker: string }).marker, 'unauthorized-response');
  ok('15. an Adult-authorized cached response cannot be served to an Adult-OFF context');
  ok('16. an Adult-OFF cached result cannot suppress an authorized Adult surface');

  // Same inputs -> same key (deterministic); different query/page/segment ->
  // different key (no accidental collisions between content contexts).
  assert.equal(buildSearchCacheKey({ ...base, canAccessAdult: true }), authorizedKey);
  assert.notEqual(buildSearchCacheKey({ ...base, page: 2, canAccessAdult: true }), authorizedKey);
  ok('19b. cache key builder is deterministic and collision-free across inputs');
}

// ============================================================================
// 17 — authorization is request-scoped: the matrix function holds NO state,
// so fresh inputs always yield fresh decisions (the Phase 5 anti-cache
// proof, re-bound for the Phase 6 enforcement paths that consume it).
// ============================================================================
{
  const flipAdmin = { allowLoggedIn: false, allowGuest: false };
  const allowAdmin = { allowLoggedIn: true, allowGuest: true };
  const first = evaluateAdultAccess({ policy: allowAdmin, isAuthenticated: true, userPreference: true });
  const second = evaluateAdultAccess({ policy: flipAdmin, isAuthenticated: true, userPreference: true });
  const third = evaluateAdultAccess({ policy: allowAdmin, isAuthenticated: true, userPreference: true });
  assert.equal(first.canAccessAdultContent, true);
  assert.equal(second.canAccessAdultContent, false);
  assert.equal(third.canAccessAdultContent, true, 'previous decisions never contaminate fresh evaluations');
  ok('17. authorization decisions are request-scoped (no cross-request leakage)');
}

// ============================================================================
// 18 — classification metadata is a CONTENT fact: same content -> same
// verdict, independent of any request context, so the shared detail cache
// is safe. The REAL process cache serves the same content value to both
// simulated contexts under its content key.
// ============================================================================
{
  clearCache();
  const contentKey = 'tmdb:detail:series:9001';
  let loads = 0;
  const loader = async () => {
    loads += 1;
    return { tags: ['Adult'] };
  };
  const contextA = await getOrSet(contentKey, { ttlMs: 10000 }, loader);
  const contextB = await getOrSet(contentKey, { ttlMs: 10000 }, loader);
  assert.equal(loads, 1, 'content-keyed classification loads once and is shared');
  assert.deepEqual(contextA.value, contextB.value);
  assert.equal(detailVerdict((contextA.value as { tags: string[] }).tags), 'adult');
  assert.equal(detailVerdict((contextB.value as { tags: string[] }).tags), 'adult');
  ok('18. classification metadata cache is content-keyed and safely shareable');
}

// ============================================================================
// 20 — fallback fixtures can never introduce Adult titles into normal
// surfaces: every fixture classifies as NOT adult through the REAL central
// classifier (list-shaped inputs: tags only, no providers/networks).
// ============================================================================
{
  for (const fixture of media) {
    const isAnime = fixture.type === 'anime';
    const adult = isAdultContent(fixture.tags, undefined, undefined, isAnime, undefined);
    assert.equal(adult, false, `fixture ${fixture.id} must not classify as adult`);
  }
  assert.ok(media.length > 0);
  ok('20. fallback fixture content contains NO Adult titles (fail-safe static catalog)');
}

// ============================================================================
// 22 — duplicate candidates cannot bypass classification: an adult row and
// a safe row sharing one identity yield exactly one safe item; duplicates
// of safe rows are collected once.
// ============================================================================
{
  const rows: RailCandidateRow<Row>[] = [
    tvRow('9001', 'Adult Duplicate'),
    tvRow('9001', 'Adult Duplicate (again)'),
    tvRow('2005', 'Safe Duplicate'),
    tvRow('2005', 'Safe Duplicate (again)')
  ];
  const table: MockDetailTable = { ...adultNetworkDetail, '2005': 'safe' };
  const result = await filterSafeRailItems(rows, filterOpts(table));
  assert.deepEqual(result.items.map((item) => item.id), ['2005'], 'dupes collapse to one safe item');
  assert.equal(result.excludedAdult, 2, 'both adult duplicates were classified adult, not just one');
  ok('22. duplicate candidates cannot bypass classification (classified + deduped)');
}

// ============================================================================
// 23 — (extra) bounded concurrency: with N workers started, at most
// `concurrency` verdict loads are ever in flight (Phase 4 contract, now
// proven for the rail filter too).
// ============================================================================
{
  let inFlight = 0;
  let maxInFlight = 0;
  const boundedLoader = async (tmdbId: string): Promise<CandidateVerdict> => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 5));
    inFlight -= 1;
    return noAdultDetail[tmdbId] ?? 'safe';
  };
  const rows = Array.from({ length: 20 }, (_, index) => tvRow(String(10000 + index), `Show ${index}`));
  const result = await filterSafeRailItems(rows, {
    concurrency: 4,
    loadDetailVerdict: boundedLoader,
    tmdbIdOf: (item) => item.id,
    identityOf: (item) => item.id
  });
  assert.equal(result.items.length, 20);
  assert.ok(maxInFlight <= 4, `max in-flight (${maxInFlight}) must stay <= 4`);
  // And the shared mapper keeps the same bound directly.
  let directMax = 0;
  let directInFlight = 0;
  await mapWithConcurrency(rows, async () => {
    directInFlight += 1;
    directMax = Math.max(directMax, directInFlight);
    await new Promise((resolve) => setTimeout(resolve, 2));
    directInFlight -= 1;
  }, 4);
  assert.ok(directMax <= 4, `shared mapper bound violated (${directMax})`);
  ok('23. rail classification is bounded (max 4 detail loads in flight)');
}

// ============================================================================
// (extra) classifyRailCandidate: movie rows never hit the detail loader;
// TV rows always do; a THROWING loader still fails closed to 'uncertain'.
// ============================================================================
{
  let loaderCalls = 0;
  const countingLoader = async (): Promise<CandidateVerdict> => {
    loaderCalls += 1;
    return 'safe';
  };
  const movieVerdict = await classifyRailCandidate(movieRowWithFlag('8001', 'Movie', false), countingLoader, (item) => item.id);
  assert.equal(movieVerdict, 'safe');
  assert.equal(loaderCalls, 0, 'movie rows classify from the flag without detail lookups');
  await classifyRailCandidate(tvRow('8002', 'Show'), countingLoader, (item) => item.id);
  assert.equal(loaderCalls, 1, 'TV rows classify through the detail verdict loader');
  const throwingLoader = async (): Promise<CandidateVerdict> => {
    throw new Error('boom');
  };
  const uncertain = await classifyRailCandidate(tvRow('8003', 'Broken Show'), throwingLoader, (item) => item.id);
  assert.equal(uncertain, 'uncertain', 'a throwing loader fails CLOSED (never "not adult")');
  ok('25. rail verdict routing: movies = flag path, TV = detail path, failures = uncertain');
}

// ============================================================================
console.log(`\nAdult Phase 6 enforcement tests passed: ${passed} checks.`);
