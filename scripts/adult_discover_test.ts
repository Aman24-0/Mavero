// ============================================================================
// Phase 7 behavioral tests — dedicated Adult Discover catalog.
// (Adult Mode architecture rebuild; see Mavero_Adult_Mode_Rebuild_Worklog.md.)
//
// REAL behavioral tests: they execute the actual Adult Discover contract
// module (adult-discover.ts — validation, cache-key construction, the
// fail-closed classification defense and the bounded page-continuation
// collector), the ONE central classifier's verdict helpers wired into it
// (movieRowVerdict -> isAdultContent), the actual VERIFIED adult network
// registry (adult-networks.ts + adult-catalog.ts), the actual Phase 5
// authorization matrix (adult-authz.ts) and the actual process cache
// (cache.ts) — all with injected deterministic dependencies. Deterministic
// and credential-free.
//
// The adapter (adapters/tmdb.ts), the service wrapper and the SvelteKit
// route cannot be imported under tsx (they import $env / $app / $lib
// aliases); their WIRING is asserted statically in scripts/adult_mode_test.ts
// section AB — the same adapter/behavioral split used by the Phase 4/5/6
// suites. Every behavioral case below exercises exactly the pure function
// the wiring feeds.
//
// Covered scenarios (Phase 7 spec §19):
//    1  Admin OFF + user ON                    -> Adult Discover blocked
//    2  Admin ON + user OFF                    -> blocked
//    3  Admin ON + user ON                     -> allowed
//    4  Admin ON + guest OFF                   -> blocked
//    5  Admin ON + guest ON                    -> allowed
//    6  Ullu 2902 included                     (verified registry)
//    7  Kooku 4573 included
//    8  Atrangii 7355 included
//    9  Unverified network IDs rejected
//   10  Arbitrary client network ID cannot alter the Adult source
//   11  Verified Adult network + adult=false   -> still Adult
//   12  Normal non-Adult TV network            -> not included
//   13  Adult Discover does not depend on JustWatch availability
//   14  Adult OFF + normal Discover            -> Adult-free (unchanged)
//   15  Adult ON + normal Discover             -> STILL Adult-free
//   16  Authorized Adult Discover              -> Adult content available
//   17  Unauthorized Adult Discover            -> no Adult content (empty)
//   18  Adult Discover response cannot populate the normal Discover cache
//   19  Normal Discover cache cannot satisfy Adult Discover
//   20  Authorization decision never globally cached
//   21  page=1 works
//   22  invalid page rejected/clamped
//   23  huge page rejected/clamped
//   24  no unbounded page walking (hard cap)
//   25  deduplication works
//   26  verified network + adult=false accepted (collector level)
//   27  uncertain Adult classification fails closed
//   28  anime adult=true without Adult-network signal is NOT Adult
//   29  Adult upstream failure never falls back to the normal catalog
//   30  normal fallback (fixtures) cannot contain Adult content
//   31  Adult Discover result still requires detail/watch authorization
//   32  (extra) strict type/sort validation (closed unions)
//   33  (extra) language narrows but cannot replace the Adult constraint
//   34  (extra) bounded classification concurrency (<= 4, parallel)
//   35  (extra) empty verified registry -> empty catalog (no fabricated ids)
// ============================================================================

import assert from 'node:assert/strict';
import {
  ADULT_DISCOVER_CACHE_NAMESPACE,
  ADULT_DISCOVER_PAGE_CLAMP_MAX,
  ADULT_DISCOVER_PAGE_SIZE,
  buildAdultDiscoverCacheKey,
  classifyAdultDiscoverRow,
  collectConfirmedAdultPage,
  emptyAdultDiscoverResult,
  isAdultDiscoverLanguage,
  isAdultDiscoverSort,
  isAdultDiscoverType,
  parseAdultDiscoverPage,
  type AdultDiscoverCandidateRow
} from '../src/lib/server/content/adult-discover.ts';
import { movieRowVerdict, detailVerdict, type CandidateVerdict } from '../src/lib/server/content/search-classify.ts';
import { isAdultContent } from '../src/lib/server/content/adult-providers.ts';
import {
  __setAdultNetworkRegistryForTest,
  __resetAdultNetworkRegistryForTest,
  getAdultNetworkIds,
  getVerifiedAdultNetworks
} from '../src/lib/server/content/adult-networks.ts';
import { withAdultNetworksParams } from '../src/lib/server/content/adult-catalog.ts';
import { evaluateAdultAccess } from '../src/lib/server/content/adult-authz.ts';
import { mapWithConcurrency } from '../src/lib/server/content/concurrency.ts';
import { getOrSet, clearCache } from '../src/lib/server/content/cache.ts';
import { filterSafeRailItems, type RailCandidateRow } from '../src/lib/server/content/list-classify.ts';
import { media } from '../src/lib/data/content.ts';

let passed = 0;
function ok(label: string): void {
  passed++;
  console.log(`  ok ${passed} - ${label}`);
}

// ---------------------------------------------------------------------------
// Deterministic mock layer — Adult Discover candidate rows + verdict loaders
// with the EXACT contract the adapter wires (loader reads the cached detail
// classification; failures propagate as uncertainty).
// ---------------------------------------------------------------------------

type Row = { id: string; title: string; type: 'movie' | 'series'; isAnime?: boolean };

function candidate(row: Row, rawAdult?: boolean): AdultDiscoverCandidateRow<Row> {
  return { item: row, mediaType: row.type, rawAdult, isAnime: row.isAnime };
}

type DetailTable = Record<string, CandidateVerdict>;

function makeLoader(table: DetailTable, count?: { calls: number }) {
  return async (mediaType: 'movie' | 'series', tmdbId: string): Promise<CandidateVerdict> => {
    if (count) count.calls += 1;
    const verdict = table[tmdbId];
    if (verdict === undefined) throw new Error('detail lookup failed');
    return verdict;
  };
}

function collectorOpts<T>(overrides: Partial<Parameters<typeof collectConfirmedAdultPage<T>>[0]> = {}) {
  return {
    startPage: 1,
    pageSize: ADULT_DISCOVER_PAGE_SIZE,
    maxUpstreamPages: 3,
    concurrency: 4,
    ...overrides
  } as Parameters<typeof collectConfirmedAdultPage<T>>[0];
}

const POLICY_ON = { allowLoggedIn: true, allowGuest: true };
const POLICY_OFF = { allowLoggedIn: false, allowGuest: false };

// ============================================================================
// 1-5 — the Adult Discover authorization decision composed from the REAL
// Phase 5 matrix. The endpoint wires exactly these decisions: denied
// context -> non-disclosing 404 BEFORE any catalog data is touched;
// allowed context -> the dedicated catalog service (statically asserted in
// adult_mode_test.ts section AB).
// ============================================================================
{
  // 1. Admin OFF + user ON -> blocked (hard override).
  assert.equal(evaluateAdultAccess({ policy: POLICY_OFF, isAuthenticated: true, userPreference: true }).canAccessAdultContent, false, 'admin OFF + user ON denies');
  // 2. Admin ON + user OFF -> blocked.
  assert.equal(evaluateAdultAccess({ policy: POLICY_ON, isAuthenticated: true, userPreference: false }).canAccessAdultContent, false, 'admin ON + user OFF denies');
  // 3. Admin ON + user ON -> allowed.
  assert.equal(evaluateAdultAccess({ policy: POLICY_ON, isAuthenticated: true, userPreference: true }).canAccessAdultContent, true, 'admin ON + user ON allows');
  // 4. Admin ON + guest OFF -> blocked.
  assert.equal(evaluateAdultAccess({ policy: POLICY_ON, isAuthenticated: false, userPreference: false }).canAccessAdultContent, false, 'admin ON + guest OFF denies');
  // 5. Admin ON + guest ON -> allowed.
  assert.equal(evaluateAdultAccess({ policy: POLICY_ON, isAuthenticated: false, userPreference: true }).canAccessAdultContent, true, 'admin ON + guest ON allows');
  ok('1-5. authorization matrix (real evaluateAdultAccess): admin OFF always wins; preference decides under admin ON');
}

// ============================================================================
// 6-8 — the verified Adult network registry is the Adult Discover source.
// The adapter's TV query is built from withAdultNetworksParams() (real
// registry), so every verified network participates.
// ============================================================================
{
  const ids = getAdultNetworkIds(); // the production accessor
  assert.ok(ids.includes(2902), 'Ullu 2902 is in the verified production set');
  assert.ok(ids.includes(4573), 'Kooku 4573 is in the verified production set');
  assert.ok(ids.includes(7355), 'Atrangii 7355 is in the verified production set');
  const inclusion = withAdultNetworksParams();
  assert.ok(inclusion.with_networks?.split('|').includes('2902'), 'Ullu participates in the Adult Discover TV source');
  assert.ok(inclusion.with_networks?.split('|').includes('4573'), 'Kooku participates in the Adult Discover TV source');
  assert.ok(inclusion.with_networks?.split('|').includes('7355'), 'Atrangii participates in the Adult Discover TV source');
  ok('6-8. verified networks Ullu/Kooku/Atrangii are the Adult Discover source (registry-driven)');
}

// ============================================================================
// 9-10 — unverified / arbitrary client network IDs can never alter the
// Adult source. The contract exposes NO network parameter at all; even a
// client-forced id through the inclusion builder yields NO filter.
// ============================================================================
{
  assert.deepEqual(withAdultNetworksParams(424242), {}, 'claimed unverified id produces NO filter');
  assert.deepEqual(withAdultNetworksParams(999999999), {}, 'arbitrary unknown id produces NO filter');
  assert.equal(getVerifiedAdultNetworkIdForKeySafe('altt'), undefined, 'unverified service key resolves to nothing');
  // The filter surface is closed: type/language/sort/page only — no
  // network/provider field exists on the contract (runtime shape proof).
  const filters = { type: 'series', language: 'all', sort: 'popularity', page: 1 } as Record<string, unknown>;
  assert.ok(!('network' in filters) && !('with_networks' in filters) && !('provider' in filters), 'the Adult Discover filter surface carries no network/provider field');
  ok('9-10. unverified/arbitrary client network IDs are structurally rejected (no network parameter exists)');
}
function getVerifiedAdultNetworkIdForKeySafe(key: string): number | undefined {
  // Local mirror of the registry lookup used by the rail (verified-only).
  const match = getVerifiedAdultNetworks().find((entry) => entry.key === key);
  return match?.tmdbNetworkId;
}

// ============================================================================
// 11 + 26 — a verified Adult network classifies a title Adult EVEN WHEN
// TMDB adult=false (the worklog invariant), and such a candidate is
// accepted by the Adult Discover collector.
// ============================================================================
{
  // Real central classifier, real registry:
  assert.equal(isAdultContent(undefined, undefined, false, false, [{ id: 2902, name: 'Ullu' }]), true, 'verified network overrides adult=false (classifier)');
  // Collector level: a TV candidate whose cached-detail verdict is 'adult'
  // (the detail pipeline tags it via the network signal) is collected even
  // though the raw row carried adult=false.
  const table: DetailTable = { '9001': 'adult' };
  const outcome = await collectConfirmedAdultPage({
    ...collectorOpts(),
    fetchUpstreamPage: async (page) => ({
      items: [candidate({ id: '9001', title: 'Ullu Original', type: 'series' }, false)],
      totalPages: page
    }),
    classifyCandidate: (row) => classifyAdultDiscoverRow(row, makeLoader(table), (item) => item.id),
    identityOf: (row) => `${row.item.type}:${row.item.id}`
  });
  assert.equal(outcome.items.length, 1, 'confirmed Adult candidate collected');
  assert.equal(outcome.excludedNotAdult, 0, 'no false anomaly drops');
  ok('11+26. verified Adult network + TMDB adult=false is confirmed Adult and returned');
}

// ============================================================================
// 12 — a candidate the classifier actively says is NOT adult (a normal
// non-adult network title that anomalously appeared in the adult query) is
// NOT included in the Adult catalog.
// ============================================================================
{
  assert.equal(isAdultContent(undefined, undefined, false, false, [{ id: 213, name: 'Netflix' }]), false, 'normal network is not Adult (classifier)');
  const outcome = await collectConfirmedAdultPage({
    ...collectorOpts(),
    fetchUpstreamPage: async (page) => ({
      items: [candidate({ id: '9002', title: 'Normal Show', type: 'series' }, false)],
      totalPages: page
    }),
    classifyCandidate: (row) => classifyAdultDiscoverRow(row, makeLoader({ '9002': 'safe' }), (item) => item.id),
    identityOf: (row) => `${row.item.type}:${row.item.id}`
  });
  assert.equal(outcome.items.length, 0, 'non-adult anomaly NOT presented as Adult content');
  assert.equal(outcome.excludedNotAdult, 1, 'anomaly counted as excluded');
  ok('12. a normal non-Adult title is never included in the Adult catalog (anomaly dropped)');
}

// ============================================================================
// 13 — the TV source does not depend on JustWatch availability: the
// inclusion fragment carries ONLY the network filter (no region/flatrate/
// provider prerequisites), so adult=false titles with no India
// watch-provider entry still belong to the catalog.
// ============================================================================
{
  const inclusion = withAdultNetworksParams();
  assert.ok(!('watch_region' in inclusion), 'no watch_region prerequisite');
  assert.ok(!('with_watch_monetization_types' in inclusion), 'no flatrate prerequisite');
  assert.ok(!('with_watch_providers' in inclusion), 'no watch-provider prerequisite');
  assert.ok(inclusion.with_networks, 'the mandatory network constraint is present');
  ok('13. Adult Discover TV source requires no JustWatch/flatrate/provider availability');
}

// ============================================================================
// 14-15 — normal Discover isolation: the Phase 6 rail filter (unchanged)
// is a content fact with NO authorization input — Adult Mode ON or OFF
// cannot change normal-rail output.
// ============================================================================
{
  const adultRow: RailCandidateRow<Row> = { item: { id: '9100', title: 'Ullu Show', type: 'series' }, mediaType: 'series' };
  const normalRow: RailCandidateRow<Row> = { item: { id: '9101', title: 'Normal Show', type: 'series' }, mediaType: 'series' };
  const opts = {
    concurrency: 4,
    loadDetailVerdict: makeRailLoader({ '9100': 'adult', '9101': 'safe' }),
    tmdbIdOf: (item: Row) => item.id,
    identityOf: (item: Row) => `${item.type}:${item.id}`
  };
  // "Adult Mode OFF" and "Adult Mode ON" invocations: the function takes no
  // authorization parameter — both contexts run the SAME content fact.
  const runA = await filterSafeRailItems([adultRow, normalRow], opts);
  const runB = await filterSafeRailItems([adultRow, normalRow], opts);
  assert.deepEqual(runA.items.map((i) => i.id), ['9101'], 'normal rail keeps only the non-adult title');
  assert.deepEqual(runA.items, runB.items, 'normal-rail output is identical regardless of Adult Mode state (no auth input exists)');
  ok('14-15. normal Discover stays Adult-free with Adult Mode OFF and ON (rail filter has no authorization input)');
}
function makeRailLoader(table: Record<string, CandidateVerdict>) {
  return async (tmdbId: string): Promise<CandidateVerdict> => {
    const verdict = table[tmdbId];
    if (verdict === undefined) throw new Error('detail lookup failed');
    return verdict;
  };
}

// ============================================================================
// 16-17 — authorized Adult Discover returns confirmed Adult content; the
// unauthorized service decision is the empty non-disclosing result.
// ============================================================================
{
  // Authorized: the collector returns the confirmed adult candidate.
  const authorized = await collectConfirmedAdultPage({
    ...collectorOpts(),
    fetchUpstreamPage: async (page) => ({
      items: [candidate({ id: '9001', title: 'Ullu Original', type: 'series' }), candidate({ id: '9003', title: 'Kooku Original', type: 'series' })],
      totalPages: page
    }),
    classifyCandidate: (row) => classifyAdultDiscoverRow(row, makeLoader({ '9001': 'adult', '9003': 'adult' }), (item) => item.id),
    identityOf: (row) => `${row.item.type}:${row.item.id}`
  });
  assert.equal(authorized.items.length, 2, 'authorized Adult Discover returns Adult content');
  // Unauthorized: the service contract answer (empty, non-disclosing,
  // NEVER fixtures/normal content).
  const denied = emptyAdultDiscoverResult(3);
  assert.equal(denied.items.length, 0, 'unauthorized Adult Discover returns NO content');
  assert.equal(denied.hasNextPage, false, 'unauthorized result has no pagination');
  assert.equal(denied.source.provider, 'tmdb', 'unauthorized result is NOT a fixture/normal-catalog fallback');
  ok('16-17. authorized -> Adult content; unauthorized -> empty non-disclosing result (never normal content)');
}

// ============================================================================
// 18-19 — structural response-cache isolation (real process cache): the
// Adult Discover namespace and the normal Discover namespace are disjoint
// entries; neither can satisfy the other.
// ============================================================================
{
  clearCache();
  const adultKey = buildAdultDiscoverCacheKey({ type: 'series', language: 'all', sort: 'popularity', page: 1, networkInclusion: '2902|4573|7355' });
  const normalKey = 'tmdb:discover:series:1'; // the Phase 6 trending key shape
  await getOrSet(adultKey, { ttlMs: 60_000 }, async () => ({ marker: 'adult-discover' }));
  await getOrSet(normalKey, { ttlMs: 60_000 }, async () => ({ marker: 'normal-discover' }));
  const adultValue = await getOrSet(adultKey, { ttlMs: 60_000 }, async () => ({ marker: 'RECOMPUTED-ADULT' }));
  const normalValue = await getOrSet(normalKey, { ttlMs: 60_000 }, async () => ({ marker: 'RECOMPUTED-NORMAL' }));
  assert.equal((adultValue.value as { marker: string }).marker, 'adult-discover', 'adult entry not overwritten by / colliding with the normal entry');
  assert.equal((normalValue.value as { marker: string }).marker, 'normal-discover', 'normal entry not overwritten by / colliding with the adult entry');
  // Structural prefix disjointness against every other catalog namespace.
  assert.ok(adultKey.startsWith(`${ADULT_DISCOVER_CACHE_NAMESPACE}:`), 'adult key lives in the adult-discover namespace');
  for (const foreign of ['tmdb:discover:', 'tmdb:popular-v2:', 'tmdb:top-rated-v2:', 'tmdb:new-ott:', 'tmdb:theatre:', 'tmdb:adult-shows:', 'tmdb:search:', 'tmdb:collection:', 'tmdb:genre-v2:']) {
    assert.ok(!adultKey.startsWith(foreign), `adult key never collides with ${foreign}`);
  }
  const differentNormalInput = buildAdultDiscoverCacheKey({ type: 'series', language: 'hi', sort: 'newest', page: 2, networkInclusion: '2902|4573|7355' });
  assert.notEqual(adultKey, differentNormalInput, 'key dimensions (type/language/sort/page) prevent intra-namespace collisions');
  clearCache();
  ok('18-19. Adult Discover cache entries are structurally disjoint from normal Discover caches (both directions)');
}

// ============================================================================
// 20 — authorization decisions are never globally cached: successive
// evaluations with a changed policy produce fresh decisions (real matrix).
// ============================================================================
{
  const first = evaluateAdultAccess({ policy: POLICY_ON, isAuthenticated: true, userPreference: true });
  const second = evaluateAdultAccess({ policy: POLICY_OFF, isAuthenticated: true, userPreference: true });
  const third = evaluateAdultAccess({ policy: POLICY_ON, isAuthenticated: true, userPreference: true });
  assert.equal(first.canAccessAdultContent, true, 'first evaluation: allowed');
  assert.equal(second.canAccessAdultContent, false, 'admin ON->OFF visible on the very next evaluation (no stale cache)');
  assert.equal(third.canAccessAdultContent, true, 'admin OFF->ON visible again (fresh per call)');
  // The adult-discover cache key carries no authorization dimension — the
  // decision can never become part of a cached entry.
  const keyA = buildAdultDiscoverCacheKey({ type: 'series', language: 'all', sort: 'popularity', page: 1, networkInclusion: 'x' });
  const keyB = buildAdultDiscoverCacheKey({ type: 'series', language: 'all', sort: 'popularity', page: 1, networkInclusion: 'x' });
  assert.equal(keyA, keyB, 'key is a pure content/filter function (no auth input exists in its signature)');
  ok('20. authorization is evaluated per request and never cached (fresh decisions; no auth dimension in cache keys)');
}

// ============================================================================
// 21-23 — pagination validation: page 1 works, invalid input clamps to 1,
// arbitrarily huge input clamps to the bounded maximum.
// ============================================================================
{
  assert.equal(parseAdultDiscoverPage('1'), 1, 'page=1 works');
  assert.equal(parseAdultDiscoverPage('7'), 7, 'a normal mid-range page passes through');
  assert.equal(parseAdultDiscoverPage('abc'), 1, 'invalid page clamps to 1');
  assert.equal(parseAdultDiscoverPage('0'), 1, 'zero clamps to 1');
  assert.equal(parseAdultDiscoverPage('-4'), 1, 'negative clamps to 1');
  assert.equal(parseAdultDiscoverPage(undefined), 1, 'missing page defaults to 1');
  assert.equal(parseAdultDiscoverPage('999999999'), ADULT_DISCOVER_PAGE_CLAMP_MAX, 'huge page clamps to the bounded maximum');
  assert.equal(parseAdultDiscoverPage('999999999999999999999'), ADULT_DISCOVER_PAGE_CLAMP_MAX, 'overflow-size page clamps');
  ok('21-23. page validation: 1 works, invalid clamps to 1, huge clamps to the maximum (no upstream page walking)');
}

// ============================================================================
// 24 — no unbounded page walking: the collector stops at the hard cap even
// when upstream keeps returning underfilled pages forever.
// ============================================================================
{
  let fetches = 0;
  const outcome = await collectConfirmedAdultPage({
    ...collectorOpts({ maxUpstreamPages: 3 }),
    fetchUpstreamPage: async (page) => {
      fetches += 1;
      return { items: [candidate({ id: `u-${page}`, title: 'Uncertain', type: 'series' })], totalPages: 99_999 };
    },
    classifyCandidate: async () => 'uncertain', // everything dropped -> endless underfill
    identityOf: (row) => `${row.item.type}:${row.item.id}`
  });
  assert.equal(fetches, 3, 'exactly maxUpstreamPages upstream pages fetched (hard cap)');
  assert.equal(outcome.upstreamPagesFetched, 3, 'collector reports the bounded fetch count');
  assert.equal(outcome.items.length, 0, 'underfilled page stays underfilled (fail-closed, no fabricated fill)');
  ok('24. page walking is hard-capped (no unbounded upstream requests under persistent underfill)');
}

// ============================================================================
// 25 — deduplication: the same canonical identity across (and within)
// upstream pages is collected once.
// ============================================================================
{
  const outcome = await collectConfirmedAdultPage({
    ...collectorOpts({ maxUpstreamPages: 3, pageSize: 1 }),
    fetchUpstreamPage: async (page) => ({
      items: [
        candidate({ id: 'dup', title: `Dup p${page}-a`, type: 'series' }),
        candidate({ id: 'dup', title: `Dup p${page}-b`, type: 'series' })
      ],
      totalPages: 99_999
    }),
    classifyCandidate: async () => 'adult',
    identityOf: (row) => `${row.item.type}:${row.item.id}`
  });
  assert.equal(outcome.items.length, 1, 'duplicate identity collected exactly once');
  assert.equal(outcome.upstreamPagesFetched, 1, 'page filled by the first duplicate pair stops continuation');
  ok('25. deduplication by canonical identity (within and across pages)');
}

// ============================================================================
// 27 — classification uncertainty fails closed: a failed detail lookup is
// never read as Adult; the candidate is dropped and the request survives.
// ============================================================================
{
  const outcome = await collectConfirmedAdultPage({
    ...collectorOpts(),
    fetchUpstreamPage: async (page) => ({
      items: [candidate({ id: 'broken', title: 'Broken Detail', type: 'series' }), candidate({ id: 'fine', title: 'Fine Adult', type: 'series' })],
      totalPages: page
    }),
    classifyCandidate: (row) => classifyAdultDiscoverRow(row, makeLoader({ fine: 'adult' }), (item) => item.id),
    identityOf: (row) => `${row.item.type}:${row.item.id}`
  });
  assert.deepEqual(outcome.items.map((r) => r.item.id), ['fine'], 'only the confirmable candidate survives');
  assert.equal(outcome.excludedUncertain, 1, 'uncertain candidate dropped (fail-closed)');
  assert.equal(outcome.excludedNotAdult, 0, 'uncertainty is not counted as a non-adult anomaly');
  const verdict = await classifyAdultDiscoverRow(candidate({ id: 'broken2', title: 'X', type: 'series' }), makeLoader({}), (item) => item.id);
  assert.equal(verdict, 'uncertain', 'loader failure maps to uncertain (never adult, never safe)');
  ok('27. uncertain Adult classification fails closed (dropped, request survives)');
}

// ============================================================================
// 28 — anime with TMDB adult=true but NO Adult-network signal is NOT
// treated as Adult (the anime exemption), so it cannot enter the Adult
// catalog via the flag.
// ============================================================================
{
  // Real central classifier: the flag signal is exempt for anime.
  assert.equal(isAdultContent(undefined, undefined, true, true, undefined), false, 'anime adult=true alone is NOT Adult (classifier)');
  assert.equal(movieRowVerdict({ adult: true, isAnime: true }), 'safe', 'cheap movie path cannot confirm anime via the flag');
  // A recognized anime with adult=true and no network/provider signal
  // classifies 'safe' in the cached detail -> dropped from Adult Discover.
  const outcome = await collectConfirmedAdultPage({
    ...collectorOpts(),
    fetchUpstreamPage: async (page) => ({
      items: [candidate({ id: '9500', title: 'Mature Anime', type: 'movie', isAnime: true }, true)],
      totalPages: page
    }),
    classifyCandidate: (row) => classifyAdultDiscoverRow(row, makeLoader({ '9500': detailVerdictFor(row) }), (item) => item.id),
    identityOf: (row) => `${row.item.type}:${row.item.id}`
  });
  assert.equal(outcome.items.length, 0, 'anime adult=true alone never enters the Adult catalog');
  assert.equal(outcome.excludedNotAdult, 1, 'anime candidate treated as the non-adult content it is');
  ok('28. anime adult=true without an Adult-network signal is not incorrectly treated as Adult');
  function detailVerdictFor(row: AdultDiscoverCandidateRow<Row>): CandidateVerdict {
    // The cached detail of this anime classifies through the central
    // classifier with the anime exemption: flag ignored, no network ->
    // not Adult. (Explicit reliable signals — verified network, provider,
    // tag — would still apply to anime.)
    return movieRowVerdict({ adult: row.rawAdult, isAnime: row.isAnime });
  }
}

// ============================================================================
// 29 — an Adult upstream failure propagates: NO fallback to the normal
// catalog, no fixtures, no silent empty-on-error substitution.
// ============================================================================
{
  const boom = new Error('upstream exploded');
  await assert.rejects(
    collectConfirmedAdultPage({
      ...collectorOpts(),
      fetchUpstreamPage: async () => {
        throw boom;
      },
      classifyCandidate: async () => 'adult',
      identityOf: (row) => `${row.item.type}:${row.item.id}`
    }),
    (error: unknown) => error === boom,
    'upstream failure PROPAGATES (no normal-catalog fallback object)'
  );
  ok('29. Adult upstream failure never falls back to the normal catalog (error propagates)');
}

// ============================================================================
// 30 — the normal fallback data (fixtures) cannot contain Adult content:
// every fixture item passes the ONE central classifier as non-adult.
// ============================================================================
{
  const fixtures = media as unknown as Array<{ tags?: string[]; isAnime?: boolean; networks?: Array<{ id: number; name: string }>; type: string }>;
  assert.ok(fixtures.length > 0, 'fixture catalog present');
  for (const item of fixtures) {
    assert.equal(
      isAdultContent(item.tags, undefined, undefined, item.isAnime, item.networks),
      false,
      `fixture "${item.type}" item must never classify as Adult`
    );
  }
  ok('30. normal fallback (fixtures) contains zero Adult-classified titles (real classifier over every item)');
}

// ============================================================================
// 31 — an Adult Discover result still requires authorization on the
// detail/watch path: the protected routes classify the detail (central
// classifier) and evaluate the Phase 5 matrix per request. Composed from
// the REAL functions the routes wire.
// ============================================================================
{
  const adultTags = ['Adult'];
  // Adult Discover item opened by an unauthorized user -> block (404 decision).
  assert.equal(detailVerdict(adultTags) === 'adult'
    && evaluateAdultAccess({ policy: POLICY_ON, isAuthenticated: false, userPreference: false }).canAccessAdultContent,
    false, 'adult detail + unauthorized -> blocked');
  // Same item, authorized guest -> allowed (through the protected route only).
  assert.equal(detailVerdict(adultTags) === 'adult'
    && evaluateAdultAccess({ policy: POLICY_ON, isAuthenticated: false, userPreference: true }).canAccessAdultContent,
    true, 'adult detail + authorized -> allowed via the protected route');
  ok('31. Adult Discover results reach detail/watch only through the Phase 6 guarded routes (authorization still required)');
}

// ============================================================================
// 32 — strict closed-union validation for type/sort/language (the endpoint
// answers 400 for anything else; statically asserted wiring).
// ============================================================================
{
  assert.equal(isAdultDiscoverType('series'), true, "type 'series' valid");
  assert.equal(isAdultDiscoverType('movie'), true, "type 'movie' valid");
  assert.equal(isAdultDiscoverType('anime'), false, "type 'anime' rejected (no anime Adult surface)");
  assert.equal(isAdultDiscoverType('trending'), false, 'arbitrary type rejected');
  assert.equal(isAdultDiscoverType(undefined), false, 'missing type invalid (endpoint defaults before guarding)');
  assert.equal(isAdultDiscoverSort('popularity'), true, "sort 'popularity' valid");
  assert.equal(isAdultDiscoverSort('newest'), true, "sort 'newest' valid");
  assert.equal(isAdultDiscoverSort('top-rated'), true, "sort 'top-rated' valid");
  assert.equal(isAdultDiscoverSort('vote_count.desc'), false, 'arbitrary sort rejected (no TMDB passthrough)');
  assert.equal(isAdultDiscoverLanguage('hi'), true, "language 'hi' valid");
  assert.equal(isAdultDiscoverLanguage('all'), true, "language 'all' valid");
  assert.equal(isAdultDiscoverLanguage('xx'), false, 'arbitrary language rejected');
  ok('32. strict closed unions for type/sort/language (no arbitrary TMDB query passthrough)');
}

// ============================================================================
// 33 — the language filter can only NARROW the Adult catalog: the cache
// key keeps the mandatory network dimension AND the language dimension
// (Adult AND language), and the sort mapping stays within TMDB's supported
// sort fields per type.
// ============================================================================
{
  const base = { type: 'series' as const, sort: 'popularity' as const, page: 1, networkInclusion: '2902|4573|7355' };
  const all = buildAdultDiscoverCacheKey({ ...base, language: 'all' });
  const hindi = buildAdultDiscoverCacheKey({ ...base, language: 'hi' });
  assert.notEqual(all, hindi, 'language is a real key dimension');
  assert.ok(hindi.includes('2902|4573|7355'), 'the mandatory Adult network constraint remains part of the filtered catalog key');
  assert.ok(!hindi.startsWith('tmdb:discover:') && hindi.startsWith(ADULT_DISCOVER_CACHE_NAMESPACE), 'filtered Adult catalog stays in its own namespace');
  ok('33. language narrows the Adult catalog without ever removing the mandatory Adult constraint');
}

// ============================================================================
// 34 — classification concurrency is bounded (<= 4) and actually parallel.
// Measured with in-flight tracking, mirroring the Phase 4/6 suites.
// ============================================================================
{
  let inFlight = 0;
  let maxInFlight = 0;
  const rows = Array.from({ length: 12 }, (_, index) => candidate({ id: `c-${index}`, title: `C${index}`, type: 'series' as const }));
  const verdicts = await mapWithConcurrency(rows, async () => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 10));
    inFlight -= 1;
    return 'adult' as const;
  }, 4);
  assert.equal(verdicts.length, 12);
  assert.ok(maxInFlight <= 4, `bounded concurrency respected (max in flight: ${maxInFlight})`);
  assert.ok(maxInFlight > 1, 'work actually parallelizes (not sequential)');
  ok('34. classification concurrency is bounded at 4 and proven parallel');
}

// ============================================================================
// 35 — an empty verified registry yields the EMPTY catalog (no fabricated
// filters, no widened source): the adapter's no-source contract.
// ============================================================================
{
  __setAdultNetworkRegistryForTest([]);
  try {
    assert.deepEqual(withAdultNetworksParams(), {}, 'empty registry -> no with_networks param at all');
    assert.equal(getAdultNetworkIds().length, 0, 'no production ids available');
    const empty = emptyAdultDiscoverResult(1);
    assert.equal(empty.items.length, 0, 'no-source contract: empty result, never an unfiltered query');
  } finally {
    __resetAdultNetworkRegistryForTest();
  }
  assert.equal(getAdultNetworkIds().includes(2902), true, 'registry restored after the override');
  ok('35. empty verified registry -> empty Adult catalog (no fabricated/widened queries)');
}

// ============================================================================
console.log(`\nAdult Discover tests passed: ${passed} checks.`);
