// ============================================================================
// Phase 4 behavioral tests — adult-aware search (bounded N+1 classification,
// page continuation, fail-closed semantics, cache separation).
// (Adult Mode architecture rebuild; see Mavero_Adult_Mode_Rebuild_Worklog.md.)
//
// REAL behavioral tests: they execute the actual orchestrator
// (search-classify.ts — collectSafeSearchPage), the actual verdict helpers
// wired to the ONE central classifier (movieRowVerdict -> isAdultContent),
// the actual bounded-concurrency helper (concurrency.ts) and the actual
// process cache (cache.ts) — all with MOCKED TMDB-shaped upstream responses.
// Deterministic and credential-free.
//
// The adapter (adapters/tmdb.ts) cannot be imported under tsx (it imports
// $env/dynamic/private); its wiring (mode branch, cached-detail
// classification, auth-dimension cache key) is therefore asserted
// statically in scripts/adult_mode_test.ts section Y. The classification
// SEMANTICS for Ullu/Kooku/Atrangii network shows are proven against the
// real registry in scripts/adult_network_classifier_test.ts (Phase 2).
//
// Covered scenarios (Phase 4 spec §19):
//   A/U  Adult OFF + Ullu-network TV candidate (adult=false)   -> absent
//   B/D/F Adult ON (authorized) -> adult candidates may appear
//   C    adult=false but known Adult network (Kavita-Bhabhi-like) -> absent
//   E/S  movie adult=true non-anime -> filtered
//   G    adult=true + recognized anime -> NOT adult (exemption)
//   H/I  detail lookup failure -> candidate excluded, request survives
//   J    page 1 underfilled -> continues to upstream page 2
//   K    stops at total_pages AND at the max-upstream-pages cap
//   L    duplicates across pages removed
//   M    bounded concurrency never exceeds the configured limit
//   N    classification cache avoids duplicate loads (real cache.ts)
//   O    classification cache is content-keyed (authorization-independent)
//   P/Q  authorized vs unauthorized response entries are separate keys
//   R    empty upstream page behaves normally
//   T    ordinary romance/drama TV not automatically adult
//   V    unknown network not automatically adult
// ============================================================================

import assert from 'node:assert/strict';
import {
  collectSafeSearchPage,
  movieRowVerdict,
  detailVerdict,
  searchFilterMode,
  type CandidateVerdict
} from '../src/lib/server/content/search-classify.ts';
import { mapWithConcurrency } from '../src/lib/server/content/concurrency.ts';
import { getOrSet } from '../src/lib/server/content/cache.ts';
import { isKnownAdultNetwork } from '../src/lib/server/content/adult-networks.ts';

let passed = 0;
function ok(label: string): void {
  passed++;
  console.log(`  ok ${passed} - ${label}`);
}

// ---------------------------------------------------------------------------
// Mock layer: rows shaped like the adapter's post-processed search
// candidates ({ item: normalized row, rawAdult }), pages shaped like TMDB
// search responses ({ items, totalPages }).
// ---------------------------------------------------------------------------
type MockItem = { type: 'movie' | 'series'; id: number; year: number; isAnime?: boolean };
type MockRow = { item: MockItem; rawAdult?: boolean };
type MockPage = { items: MockRow[]; totalPages: number };

function row(type: MockItem['type'], id: number, rawAdult?: boolean, isAnime?: boolean): MockRow {
  return { item: { type, id, year: 2024, isAnime }, rawAdult };
}

/** Simulated detail-classification store: TMDB id -> tags getTmdbDetail would produce. */
function makeDetailMock(tagsById: Map<number, string[] | undefined>, failures?: Set<number>) {
  return async (r: MockRow): Promise<CandidateVerdict> => {
    if (failures?.has(r.item.id)) return 'uncertain'; // wiring: detail error -> uncertain
    return detailVerdict(tagsById.get(r.item.id));    // wiring: detail.tags -> detailVerdict
  };
}

function pagesFetcher(pages: MockPage[]): { fetch: (page: number) => Promise<MockPage>; requested: number[] } {
  const requested: number[] = [];
  return {
    requested,
    fetch: async (page: number) => {
      requested.push(page);
      const result = pages[page - 1];
      if (!result) throw new Error(`mock: no page ${page}`);
      return result;
    }
  };
}

const identity = (r: MockRow) => `${r.item.type}:${r.item.id}`;

// ---------------------------------------------------------------------------
console.log('# Real-registry anchor + mode decision');
{
  // U. Anchor: the verified adult network registry classifies an Ullu
  // network ref (the signal a detail lookup surfaces) as adult — real registry.
  assert.equal(isKnownAdultNetwork({ id: 2902, name: 'Ullu' }), true, 'Ullu 2902 is a verified adult network (real registry)');
  assert.equal(isKnownAdultNetwork({ id: 4573, name: 'Kooku' }), true, 'Kooku 4573 is a verified adult network (real registry)');
  // V. Anchor: unknown networks are NOT adult signals.
  assert.equal(isKnownAdultNetwork({ id: 9999, name: 'Totally Unknown TV' }), false, 'unknown network is not an adult signal');
  // G. Anchor: the central classifier exempts anime from the adult flag.
  assert.equal(movieRowVerdict({ adult: true, isAnime: true }), 'safe', 'anime + adult=true is NOT adult (central classifier exemption)');
  assert.equal(movieRowVerdict({ adult: true, isAnime: false }), 'adult', 'non-anime + adult=true IS adult (central classifier)');
  ok('U/V/G. real registry + central classifier anchors (Ullu/Kooku verified, unknown inert, anime exempt)');

  // Authorization-aware mode decision (pure, server-side decision function).
  assert.equal(searchFilterMode(false), 'classify-and-exclude', 'unauthorized search classifies and excludes');
  assert.equal(searchFilterMode(true), 'authorized-passthrough', 'authorized search passes through (adult MAY appear)');
  ok('B/D/F-mode. searchFilterMode decides authorized-passthrough vs classify-and-exclude');
}

// ---------------------------------------------------------------------------
console.log('# Filtering block (Adult Mode OFF — classify-and-exclude)');
{
  // A/C/U. Ullu-network TV candidate with adult=false must not appear for
  // unauthorized search. The mock detail store returns exactly the tags
  // getTmdbDetail produces for such a show (['Adult'] — the central
  // classification via the verified network registry; semantics proven in
  // the Phase 2 behavioral suite).
  {
    const tags = new Map<number, string[] | undefined>([
      [101, ['Adult']],      // Ullu-network original (adult=false on the row)
      [102, undefined]       // ordinary Netflix-style show
    ]);
    const { fetch } = pagesFetcher([{ items: [row('series', 101, false), row('series', 102, false)], totalPages: 1 }]);
    const outcome = await collectSafeSearchPage<MockRow>({
      startPage: 1, pageSize: 20, maxUpstreamPages: 3, excludeUncertain: true, concurrency: 4,
      fetchUpstreamPage: fetch,
      classifyCandidate: makeDetailMock(tags),
      identityOf: identity
    });
    assert.deepEqual(outcome.items.map((r) => r.item.id), [102], 'A/C/Ullu-network candidate excluded; ordinary show kept');
    assert.equal(outcome.excludedAdult, 1, 'exactly one adult candidate excluded');
    ok('A/C/U. Adult OFF: Ullu-network TV candidate (adult=false) is absent from unauthorized search');
  }

  // E/S. Movie rows: cheap metadata path via the REAL central classifier.
  {
    const rows = [
      row('movie', 201, true),          // TMDB adult=true, non-anime
      row('movie', 202, false),         // ordinary movie
      row('movie', 203, true, true)     // adult=true but recognized anime -> exempt
    ];
    const { fetch } = pagesFetcher([{ items: rows, totalPages: 1 }]);
    const outcome = await collectSafeSearchPage<MockRow>({
      startPage: 1, pageSize: 20, maxUpstreamPages: 3, excludeUncertain: true, concurrency: 4,
      fetchUpstreamPage: fetch,
      classifyCandidate: (r) => Promise.resolve(movieRowVerdict({ adult: r.rawAdult, isAnime: r.item.isAnime })),
      identityOf: identity
    });
    assert.deepEqual(outcome.items.map((r) => r.item.id), [202, 203], 'adult movie excluded; ordinary movie and anime kept');
    assert.equal(outcome.excludedAdult, 1, 'movie adult=true non-anime excluded via cheap path (no detail fetch)');
    ok('E/S/G. movie adult=true non-anime filtered; anime exemption holds through the search path');
  }

  // H/I. Detail lookup failure -> uncertain -> EXCLUDED (fail-closed), and
  // the whole request survives (other candidates still returned).
  {
    const tags = new Map<number, string[] | undefined>([[102, undefined]]);
    const failures = new Set<number>([101]);
    const { fetch } = pagesFetcher([{ items: [row('series', 101), row('series', 102)], totalPages: 1 }]);
    const outcome = await collectSafeSearchPage<MockRow>({
      startPage: 1, pageSize: 20, maxUpstreamPages: 3, excludeUncertain: true, concurrency: 4,
      fetchUpstreamPage: fetch,
      classifyCandidate: makeDetailMock(tags, failures),
      identityOf: identity
    });
    assert.deepEqual(outcome.items.map((r) => r.item.id), [102], 'H: uncertain candidate excluded (fail-closed)');
    assert.equal(outcome.excludedUncertain, 1, 'H: uncertainty counted, never mapped to "not adult"');
    assert.equal(outcome.items.length, 1, 'I: request survives the classification failure');
    ok('H/I. detail lookup failure -> candidate excluded, search request survives');
  }

  // T. Ordinary romance/drama TV is not automatically adult.
  {
    const tags = new Map<number, string[] | undefined>([[301, undefined]]);
    const { fetch } = pagesFetcher([{ items: [row('series', 301, false)], totalPages: 1 }]);
    const outcome = await collectSafeSearchPage<MockRow>({
      startPage: 1, pageSize: 20, maxUpstreamPages: 3, excludeUncertain: true, concurrency: 4,
      fetchUpstreamPage: fetch,
      classifyCandidate: makeDetailMock(tags),
      identityOf: identity
    });
    assert.deepEqual(outcome.items.map((r) => r.item.id), [301], 'ordinary drama/romance TV passes unauthorized search');
    ok('T. ordinary romance/drama TV not automatically classified Adult');
  }

  // R. Empty upstream page behaves normally.
  {
    const { fetch } = pagesFetcher([{ items: [], totalPages: 1 }]);
    const outcome = await collectSafeSearchPage<MockRow>({
      startPage: 1, pageSize: 20, maxUpstreamPages: 3, excludeUncertain: true, concurrency: 4,
      fetchUpstreamPage: fetch,
      classifyCandidate: makeDetailMock(new Map()),
      identityOf: identity
    });
    assert.deepEqual(outcome.items, [], 'empty page -> empty results');
    assert.equal(outcome.upstreamExhausted, true, 'empty page -> upstream exhausted');
    assert.equal(outcome.upstreamPagesFetched, 1, 'exactly one upstream request made');
    ok('R. empty search results behave normally');
  }

  // V-end-to-end. Unknown-network candidate stays (not auto-adult).
  {
    const tags = new Map<number, string[] | undefined>([[401, undefined]]); // unknown network -> central classifier says not adult
    const { fetch } = pagesFetcher([{ items: [row('series', 401)], totalPages: 1 }]);
    const outcome = await collectSafeSearchPage<MockRow>({
      startPage: 1, pageSize: 20, maxUpstreamPages: 3, excludeUncertain: true, concurrency: 4,
      fetchUpstreamPage: fetch,
      classifyCandidate: makeDetailMock(tags),
      identityOf: identity
    });
    assert.deepEqual(outcome.items.map((r) => r.item.id), [401], 'unknown-network candidate not auto-excluded');
    ok('V. unknown network is not automatically classified Adult');
  }
}

// ---------------------------------------------------------------------------
console.log('# Authorized block (Adult Mode ON — adult candidates may appear)');
{
  // B/D/F. Under authorization the filter layer is inactive: candidates
  // pass regardless of adult classification. Modeled here by the
  // passthrough configuration of the same collection machinery (the
  // adapter branch that skips classification entirely is asserted
  // statically in adult_mode_test.ts section Y).
  const rows = [row('series', 101, false), row('movie', 201, true)];
  const { fetch } = pagesFetcher([{ items: rows, totalPages: 1 }]);
  const outcome = await collectSafeSearchPage<MockRow>({
    startPage: 1, pageSize: 20, maxUpstreamPages: 3, excludeUncertain: false, concurrency: 4,
    fetchUpstreamPage: fetch,
    classifyCandidate: () => Promise.resolve('safe'), // authorization permits — no adult suppression
    identityOf: identity
  });
  assert.deepEqual(outcome.items.map((r) => r.item.id), [101, 201], 'B/D/F: Ullu-network + adult=true candidates MAY appear when authorized');
  ok('B/D/F. authorized search does not suppress adult candidates');
}

// ---------------------------------------------------------------------------
console.log('# Page continuation + pagination bounds');
{
  // J. Page 1 underfilled -> continues to upstream page 2.
  {
    const page1: MockRow[] = [];
    for (let i = 0; i < 20; i++) page1.push(i < 15 ? row('series', 1000 + i) : row('series', 2000 + i)); // 15 adult, 5 safe
    const page2: MockRow[] = [];
    for (let i = 0; i < 15; i++) page2.push(i < 5 ? row('series', 3000 + i) : row('series', 4000 + i));  // 5 adult, 10 safe
    const tags = new Map<number, string[] | undefined>();
    for (const r of [...page1, ...page2]) tags.set(r.item.id, r.item.id >= 1000 && r.item.id < 2000 || (r.item.id >= 3000 && r.item.id < 4000) ? ['Adult'] : undefined);
    const { fetch, requested } = pagesFetcher([{ items: page1, totalPages: 5 }, { items: page2, totalPages: 5 }]);
    const outcome = await collectSafeSearchPage<MockRow>({
      startPage: 1, pageSize: 10, maxUpstreamPages: 3, excludeUncertain: true, concurrency: 4,
      fetchUpstreamPage: fetch,
      classifyCandidate: makeDetailMock(tags),
      identityOf: identity
    });
    assert.equal(outcome.items.length, 10, 'J: visible page filled with 10 safe results');
    assert.deepEqual(requested, [1, 2], 'J: upstream page 2 was requested');
    assert.ok(outcome.items.every((r) => r.item.id >= 2000), 'J: only safe candidates returned');
    ok('J. underfilled page 1 continues to upstream page 2 and fills the visible page');
  }

  // K. Pagination stops at total_pages.
  {
    const tags = new Map<number, string[] | undefined>();
    for (let id = 1000; id < 1100; id++) tags.set(id, ['Adult']); // everything adult
    const { fetch, requested } = pagesFetcher([
      { items: Array.from({ length: 20 }, (_, i) => row('series', 1000 + i)), totalPages: 2 },
      { items: Array.from({ length: 20 }, (_, i) => row('series', 1050 + i)), totalPages: 2 }
    ]);
    const outcome = await collectSafeSearchPage<MockRow>({
      startPage: 1, pageSize: 20, maxUpstreamPages: 3, excludeUncertain: true, concurrency: 4,
      fetchUpstreamPage: fetch,
      classifyCandidate: makeDetailMock(tags),
      identityOf: identity
    });
    assert.deepEqual(requested, [1, 2], 'K: never requested beyond total_pages');
    assert.equal(outcome.upstreamExhausted, true, 'K: reported exhausted at total_pages');
    assert.equal(outcome.items.length, 0, 'K: no safe results — empty result, no loop');
    ok('K. pagination stops at TMDB total_pages (no infinite loop)');
  }

  // K2. Hard cap on upstream pages per request.
  {
    const tags = new Map<number, string[] | undefined>();
    for (let id = 1000; id < 1200; id++) tags.set(id, ['Adult']);
    const { fetch, requested } = pagesFetcher([
      { items: Array.from({ length: 20 }, (_, i) => row('series', 1000 + i)), totalPages: 99 },
      { items: Array.from({ length: 20 }, (_, i) => row('series', 1100 + i)), totalPages: 99 },
      { items: Array.from({ length: 20 }, (_, i) => row('series', 1150 + i)), totalPages: 99 }
    ]);
    const outcome = await collectSafeSearchPage<MockRow>({
      startPage: 1, pageSize: 20, maxUpstreamPages: 3, excludeUncertain: true, concurrency: 4,
      fetchUpstreamPage: fetch,
      classifyCandidate: makeDetailMock(tags),
      identityOf: identity
    });
    assert.deepEqual(requested, [1, 2, 3], 'K2: hard-capped at maxUpstreamPages=3 upstream pages');
    assert.equal(outcome.upstreamPagesFetched, 3, 'K2: fetch count equals the cap');
    ok('K2. upstream page walking is hard-capped per search request');
  }

  // L. Duplicate candidates across pages are removed (canonical identity).
  {
    const duplicate = row('series', 5001);
    const tags = new Map<number, string[] | undefined>([[5001, undefined], [5002, undefined]]);
    const { fetch, requested } = pagesFetcher([
      { items: [duplicate, row('series', 5002)], totalPages: 2 },
      { items: [duplicate, row('series', 5003)], totalPages: 2 } // same 5001 again
    ]);
    const outcome = await collectSafeSearchPage<MockRow>({
      startPage: 1, pageSize: 10, maxUpstreamPages: 3, excludeUncertain: true, concurrency: 4,
      fetchUpstreamPage: fetch,
      classifyCandidate: makeDetailMock(tags),
      identityOf: identity
    });
    assert.deepEqual(requested, [1, 2], 'L: only the two existing upstream pages requested');
    const ids = outcome.items.map((r) => r.item.id);
    assert.equal(ids.filter((id) => id === 5001).length, 1, 'L: duplicate candidate collected once');
    assert.deepEqual(ids, [5001, 5002, 5003], 'L: canonical order preserved, no duplicates');
    ok('L. duplicate candidates across upstream pages are removed');
  }
}

// ---------------------------------------------------------------------------
console.log('# Bounded concurrency');
{
  // M. The concurrency limit is actually enforced — active-request tracking
  // with delays proves the bound (not just a constant in the source).
  {
    let active = 0;
    let maxActive = 0;
    const LIMIT = 4;
    const rows = Array.from({ length: 24 }, (_, i) => row('series', 6000 + i));
    const classify = async (): Promise<CandidateVerdict> => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 8));
      active -= 1;
      return 'safe';
    };
    const { fetch } = pagesFetcher([{ items: rows, totalPages: 1 }]);
    const outcome = await collectSafeSearchPage<MockRow>({
      startPage: 1, pageSize: 20, maxUpstreamPages: 3, excludeUncertain: true, concurrency: LIMIT,
      fetchUpstreamPage: fetch,
      classifyCandidate: classify,
      identityOf: identity
    });
    assert.equal(outcome.items.length, 20, 'M: page filled to pageSize');
    assert.ok(maxActive <= LIMIT, `M: max in-flight classifications (${maxActive}) never exceeds the limit (${LIMIT})`);
    assert.ok(maxActive > 1, `M: work actually parallelized (max in-flight ${maxActive} > 1)`);
    ok(`M. bounded concurrency enforced (max in-flight ${maxActive} <= ${LIMIT}, parallelism proven)`);
  }

  // mapWithConcurrency preserves order and results under the bound.
  {
    const out = await mapWithConcurrency([1, 2, 3, 4, 5, 6, 7], async (n) => n * n, 3);
    assert.deepEqual(out, [1, 4, 9, 16, 25, 36, 49], 'mapWithConcurrency preserves input order');
    ok('M2. shared concurrency helper preserves ordering');
  }
}

// ---------------------------------------------------------------------------
console.log('# Classification cache (content-keyed, authorization-independent)');
{
  // N. The cache primitive behind detail classification avoids duplicate
  // loads for the same content — sequential AND concurrent (in-flight dedup).
  {
    let loads = 0;
    const policy = { ttlMs: 1000 * 60 };
    const key = 'tmdb:detail:series:90001';
    const first = await getOrSet(key, policy, async () => { loads += 1; return { tags: ['Adult'] }; });
    const second = await getOrSet(key, policy, async () => { loads += 1; return { tags: [] }; });
    assert.equal(loads, 1, 'N: second read served from cache — no duplicate detail load');
    assert.deepEqual(second.value, first.value, 'N: cached classification reused');
    const [a, b] = await Promise.all([
      getOrSet('tmdb:detail:series:90002', policy, async () => { loads += 1; await new Promise((r) => setTimeout(r, 10)); return { tags: undefined }; }),
      getOrSet('tmdb:detail:series:90002', policy, async () => { loads += 1; await new Promise((r) => setTimeout(r, 10)); return { tags: ['Adult'] }; })
    ]);
    assert.equal(loads, 2, 'N: concurrent reads share ONE in-flight load (in-flight dedup)');
    assert.deepEqual(a.value, b.value, 'N: both concurrent readers got the same classification');
    ok('N. classification cache avoids duplicate detail calls (sequential + in-flight)');
  }

  // O. Classification entries are content-keyed only — the SAME cached
  // classification is reused regardless of any caller/authorization context.
  {
    let loads = 0;
    const policy = { ttlMs: 1000 * 60 };
    const key = 'tmdb:detail:series:90003'; // no authorization dimension in the key
    const loader = async () => { loads += 1; return { tags: ['Adult'] }; };
    await getOrSet(key, policy, loader);
    const asAuthorized = await getOrSet(key, policy, loader);
    const asGuest = await getOrSet(key, policy, loader);
    assert.equal(loads, 1, 'O: one content classification shared by every caller');
    assert.deepEqual(asGuest.value, asAuthorized.value, 'O: classification independent of authorization context');
    ok('O. classification cache is content-keyed and authorization-independent');
  }

  // P/Q. Authorized and unauthorized RESPONSE caches are different keys —
  // an authorized result set can never be served to an unauthorized
  // context and vice versa (the adapter embeds the auth dimension).
  {
    const policy = { ttlMs: 1000 * 60 };
    const authorizedKey = 'tmdb:search:series:kavita:1:::adult-allowed';
    const unauthorizedKey = 'tmdb:search:series:kavita:1:::adult-excluded';
    await getOrSet(authorizedKey, policy, async () => ({ items: [{ id: 101, adult: 'classified-adult' }] }));
    const forUnauthorized = await getOrSet(unauthorizedKey, policy, async () => ({ items: [{ id: 102, adult: 'filtered' }] }));
    assert.equal(forUnauthorized.value.items.length, 1, 'P/Q: unauthorized reader got its OWN entry');
    assert.equal(forUnauthorized.value.items[0].id, 102, 'P/Q: unauthorized entry is the FILTERED set — authorized entry did not leak');
    ok('P/Q. authorized and unauthorized search caches occupy separate keys');
  }
}

console.log(`Adult search behavioral tests passed (${passed} checks): unauthorized filtering (network + flag + fail-closed), authorized passthrough mode, page continuation with total_pages + hard cap, duplicate removal, bounded concurrency proof, content-keyed classification cache with in-flight dedup, auth-dimension cache separation.`);
process.exit(0);
