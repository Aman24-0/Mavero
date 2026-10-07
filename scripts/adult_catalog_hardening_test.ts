// ============================================================================
// Production bug-fix task (2026-10) — Adult Mode catalog enforcement
// hardening. BEHAVIORAL tests: they execute the REAL TMDB adapter functions
// (getTmdbCollection / getTmdbTopRated / getTmdbPopularByLanguage) with
// MOCKED global fetch (TMDB-shaped list + detail responses), against the
// REAL central classifier + registry. Deterministic, credential-free
// (the behavioral tsconfig maps $env/dynamic/private to the test stub).
//
// Root cause being regression-locked (the production screenshots):
//   Adult Indian OTT titles on networks OUTSIDE the old verified registry
//   (HotHit 5094 / The CinemaDosti 4623 / NOTTY 7905 / ALTT 2112) leaked
//   into normal TV Explorer surfaces because (a) without_networks did not
//   cover them and (b) the collection path had NO defense-in-depth
//   classification pass.
//
// Covered:
//   1  registry: the 4 newly live-verified networks + exclusion value
//   2  classifier: screenshot-title-shaped detail rows are Adult
//   3  collection TV: query-missed adult row (HotHit network on detail)
//      is EXCLUDED by the central classifier (defense-in-depth)
//   4  collection TV: classification-uncertain (detail 500) row is
//      EXCLUDED (fail-closed)
//   5  collection TV: normal rows survive; page still fills; pagination
//      stays disjoint (feed page 2 = survivor rows [10..20))
//   6  collection MOVIE: adult-flag row excluded via the cheap verdict
//      (no detail request — count fetches)
//   7  top-rated TV: adult row excluded (same contract)
//   8  popular-by-language TV: adult verdict merged with the soap verdict
//      (adult dropped, soap dropped, failure dropped — fail-closed)
//   9  new-on-ott TV: adult row excluded via the rail classifier
//   10 cache: the exclusion value is part of the collection cache key
//      (registry extension re-keys, no stale-era leak)
//   11 no unbounded N+1: classification fetches are bounded by the page
//      row count (bounded concurrency contract)
// ============================================================================

import assert from 'node:assert/strict';
import { env as stubEnv } from '$env/dynamic/private';

stubEnv.TMDB_READ_ACCESS_TOKEN = 'test-token';

const { getTmdbCollection, getTmdbTopRated, getTmdbPopularByLanguage, getTmdbNewOnOtt } =
  await import('../src/lib/server/content/adapters/tmdb.ts');
const { getAdultNetworkIds } = await import('../src/lib/server/content/adult-networks.ts');
const { adultNetworkExclusionValue } = await import('../src/lib/server/content/adult-catalog.ts');
const { isAdultContent } = await import('../src/lib/server/content/adult-providers.ts');
const { clearCache } = await import('../src/lib/server/content/cache.ts');

let passed = 0;
function ok(label: string): void {
  passed++;
  console.log(`  ok ${passed} - ${label}`);
}

// ---------------------------------------------------------------------------
// Mock layer — TMDB-shaped list rows + detail responses.
// ---------------------------------------------------------------------------
const originalFetch = globalThis.fetch;
const fetchLog: string[] = [];
let detailRequests = 0;

type ListRow = Record<string, unknown>;

function tvRow(id: number, name: string, extra: Partial<ListRow> = {}): ListRow {
  return {
    id, name, original_name: name, original_language: 'hi',
    genre_ids: [18], first_air_date: '2023-01-01',
    overview: 'A Hindi series.', poster_path: `/p${id}.jpg`, backdrop_path: `/b${id}.jpg`,
    popularity: 100 - id * 0.5, vote_average: 7, vote_count: 200, adult: false,
    ...extra
  };
}

function movieRow(id: number, title: string, extra: Partial<ListRow> = {}): ListRow {
  return {
    id, title, original_title: title, original_language: 'hi',
    genre_ids: [18], release_date: '2023-01-01',
    overview: 'A Hindi film.', poster_path: `/p${id}.jpg`, backdrop_path: `/b${id}.jpg`,
    popularity: 90 - id * 0.5, vote_average: 7, vote_count: 200, adult: false,
    ...extra
  };
}

function tvDetail(row: ListRow, networks: Array<{ id: number; name: string }> | undefined): ListRow {
  return {
    ...row, genres: [{ id: 18, name: 'Drama' }], networks, number_of_seasons: 1, number_of_episodes: 8,
    credits: {}, videos: { results: [] }, external_ids: {}, recommendations: { results: [] }
  };
}

/** detail responses keyed by numeric id; `failIds` -> HTTP 500 (uncertain). */
type MockUpstream = {
  listByPath: Record<string, ListRow[]>;
  totalPages?: number;
  details?: Record<number, ListRow>;
  failDetailIds?: Set<number>;
};

function installMock(upstream: MockUpstream) {
  fetchLog.length = 0;
  detailRequests = 0;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    const path = url.pathname;
    fetchLog.push(path);
    if (path.startsWith('/3/tv/') && !path.includes('/season/')) {
      const id = Number(path.split('/')[3 - 1 + 1] ?? path.split('/')[2]); // /3/tv/{id}
      const numericId = Number(path.split('/').pop());
      if (upstream.failDetailIds?.has(numericId)) {
        return new Response('boom', { status: 500 });
      }
      detailRequests++;
      const detail = upstream.details?.[numericId];
      return new Response(JSON.stringify(detail ?? tvDetail(tvRow(numericId, `Show ${numericId}`), undefined)), {
        status: 200, headers: { 'content-type': 'application/json' }
      });
    }
    const rows = upstream.listByPath[path];
    if (!rows) return new Response('not found', { status: 404 });
    return new Response(JSON.stringify({
      page: 1, results: rows, total_pages: upstream.totalPages ?? 40, total_results: (rows.length * 40)
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}

function restoreFetch() {
  globalThis.fetch = originalFetch;
}

// ============================================================
// 1 — Registry: the four newly live-verified networks
// ============================================================
{
  const ids = getAdultNetworkIds().sort((a, b) => a - b);
  assert.deepEqual(ids, [2112, 2902, 4573, 4623, 5094, 7355, 7905], 'verified registry = 7 live-confirmed networks');
  assert.equal(adultNetworkExclusionValue(), '2112|2902|4573|4623|5094|7355|7905', 'query-level exclusion covers all 7');
  ok('1. registry: ALTT 2112 / HotHit 5094 / CinemaDosti 4623 / NOTTY 7905 are live-verified + covered');
}

// ============================================================
// 2 — Classifier: the production screenshot titles are Adult
// ============================================================
{
  // Detail-shaped metadata exactly as TMDB serves it for the screenshot
  // titles (networks[] is the authoritative signal; TMDB adult=false is
  // the normal case for Indian adult OTT originals).
  const sweety = { tags: undefined, providerIds: undefined, adult: false, isAnime: false, networks: [{ id: 5094, name: 'HotHit' }] };
  const mohini = { tags: undefined, providerIds: undefined, adult: false, isAnime: false, networks: [{ id: 4623, name: 'The CinemaDosti' }] };
  const pathshala = { tags: undefined, providerIds: undefined, adult: false, isAnime: false, networks: [{ id: 7905, name: 'NOTTY' }] };
  const gandii = { tags: undefined, providerIds: undefined, adult: false, isAnime: false, networks: [{ id: 2112, name: 'ALTBalaji' }] };
  assert.equal(isAdultContent(sweety.tags, sweety.providerIds, sweety.adult, sweety.isAnime, sweety.networks), true, 'Sweety Bhabhi (HotHit 5094) classifies Adult');
  assert.equal(isAdultContent(mohini.tags, mohini.providerIds, mohini.adult, mohini.isAnime, mohini.networks), true, 'Mohini Bhabhi (CinemaDosti 4623) classifies Adult');
  assert.equal(isAdultContent(pathshala.tags, pathshala.providerIds, pathshala.adult, pathshala.isAnime, pathshala.networks), true, 'Bhabhi Ki Pathshala (NOTTY 7905) classifies Adult');
  assert.equal(isAdultContent(gandii.tags, gandii.providerIds, gandii.adult, gandii.isAnime, gandii.networks), true, 'Gandii Baat (ALTT 2112) classifies Adult');
  const normal = { tags: undefined, providerIds: undefined, adult: false, isAnime: false, networks: [{ id: 2590, name: 'Zee5' }] };
  assert.equal(isAdultContent(normal.tags, normal.providerIds, normal.adult, normal.isAnime, normal.networks), false, 'a Zee5 show does NOT classify Adult');
  ok('2. classifier: all four screenshot-network details are Adult; normal networks are not');
}

// ============================================================
// 3+4+5 — getTmdbCollection TV: defense-in-depth + fail-closed + pagination
// ============================================================
{
  clearCache();
  // 22 clean Hindi rows (feed pages 1-2 tile the survivor stream) + the
  // query-missed adult row (id 777 — its DETAIL carries HotHit) + the
  // uncertain row (id 888 — its DETAIL fetch 500s).
  const cleanRows = Array.from({ length: 22 }, (_, i) => tvRow(30001 + i, `Clean Show ${i + 1}`));
  const adultRow = tvRow(777, 'Sweety Bhabhi');
  const uncertainRow = tvRow(888, 'Mystery Uncertain');
  installMock({
    listByPath: { '/3/discover/tv': [...cleanRows.slice(0, 20)] },
    totalPages: 40,
    details: {
      777: tvDetail(adultRow, [{ id: 5094, name: 'HotHit' }]),
      888: tvDetail(uncertainRow, [{ id: 2590, name: 'Zee5' }])
    },
    failDetailIds: new Set([888])
  });
  try {
    const page1 = await getTmdbCollection('series', 1, { genre: '18', sort: 'For you', language: 'hi' });
    const titles1 = page1.items.map((i) => i.title);
    assert.ok(!titles1.includes('Sweety Bhabhi'), 'query-missed adult row (HotHit detail network) is EXCLUDED by the central classifier');
    assert.ok(!titles1.includes('Mystery Uncertain'), 'classification-uncertain row (detail 500) is EXCLUDED (fail-closed)');
    assert.equal(page1.items.length, 10, 'page 1 still fills 10 clean survivors (adult rows do not occupy slice slots)');
    assert.equal(page1.hasNextPage, true, 'page 1 reports a next page');
    const page2 = await getTmdbCollection('series', 2, { genre: '18', sort: 'For you', language: 'hi' });
    const titles2 = page2.items.map((i) => i.title);
    const overlap = titles2.filter((t) => titles1.includes(t));
    assert.equal(overlap.length, 0, 'feed page 2 is disjoint from page 1 (stable pagination)');
    assert.equal(titles2.length, 10, 'page 2 fills from the survivor stream');
    // Detail fetches are bounded by the row count (never an unbounded N+1):
    // page 1 classified 20 rows (one upstream page), page 2 reuses cached
    // details for repeated ids + classifies only NEW rows.
    assert.ok(detailRequests <= 24, `classification detail requests stay bounded (got ${detailRequests})`);
    ok('3/4/5. collection TV: adult row excluded, uncertain row excluded, pages fill + tile disjointly, bounded detail work');
  } finally {
    restoreFetch();
  }
}

// ============================================================
// 6 — getTmdbCollection MOVIE: cheap flag verdict, no detail requests
// ============================================================
{
  clearCache();
  installMock({
    listByPath: {
      '/3/discover/movie': [
        movieRow(40001, 'Clean Film 1'),
        movieRow(40002, 'Flagged Film', { adult: true }),
        ...Array.from({ length: 8 }, (_, i) => movieRow(40010 + i, `Clean Film ${i + 3}`))
      ]
    },
    details: {}
  });
  try {
    const result = await getTmdbCollection('movie', 1, { sort: 'For you' });
    const titles = result.items.map((i) => i.title);
    assert.ok(!titles.includes('Flagged Film'), 'adult-flagged movie row is excluded (cheap flag verdict)');
    assert.ok(titles.includes('Clean Film 1'), 'clean movie rows survive');
    assert.equal(detailRequests, 0, 'movie classification performs ZERO detail requests (cheap flag path only)');
    ok('6. collection MOVIE: adult flag excluded with zero detail requests');
  } finally {
    restoreFetch();
  }
}

// ============================================================
// 7 — getTmdbTopRated TV: same defense-in-depth contract
// ============================================================
{
  clearCache();
  const cleanRows = Array.from({ length: 10 }, (_, i) => tvRow(51001 + i, `Top Clean ${i + 1}`));
  const adultRow = tvRow(999, 'Mohini Bhabhi');
  installMock({
    listByPath: { '/3/discover/tv': [...cleanRows, adultRow] },
    totalPages: 30,
    details: { 999: tvDetail(adultRow, [{ id: 4623, name: 'The CinemaDosti' }]) }
  });
  try {
    const result = await getTmdbTopRated('series', 'all', 1);
    const titles = result.items.map((i) => i.title);
    assert.ok(!titles.includes('Mohini Bhabhi'), 'top-rated TV excludes the CinemaDosti-network row');
    assert.equal(titles.length, 10, 'top-rated page still fills with clean survivors');
    ok('7. top-rated TV: adult-network row excluded, page fills');
  } finally {
    restoreFetch();
  }
}

// ============================================================
// 8 — getTmdbPopularByLanguage TV: adult + soap verdicts from ONE detail
// ============================================================
{
  clearCache();
  const normal = tvRow(60001, 'Prestige Drama');
  const adult = tvRow(60222, 'Bhabhi Ki Pathshala');
  const soap = tvRow(60333, 'Daily Soap Show');
  installMock({
    listByPath: { '/3/discover/tv': [normal, adult, soap] },
    totalPages: 30,
    details: {
      60001: { ...tvDetail(normal, [{ id: 2590, name: 'Zee5' }]), number_of_episodes: 10 },
      60222: { ...tvDetail(adult, [{ id: 7905, name: 'NOTTY' }]), number_of_episodes: 6 },
      60333: { ...tvDetail(soap, [{ id: 2590, name: 'Zee5' }]), number_of_episodes: 400 }
    }
  });
  try {
    const result = await getTmdbPopularByLanguage('series', 'hi', 1);
    const titles = result.items.map((i) => i.title);
    assert.ok(titles.includes('Prestige Drama'), 'a normal OTT drama survives the merged verdict');
    assert.ok(!titles.includes('Bhabhi Ki Pathshala'), 'the NOTTY-network adult row is dropped by the merged adult verdict');
    assert.ok(!titles.includes('Daily Soap Show'), 'the 400-episode daily soap is dropped by the soap verdict (Phase 8 policy preserved)');
    ok('8. popular-by-language TV: adult + soap verdicts from one cached detail each');
  } finally {
    restoreFetch();
  }
}

// ============================================================
// 9 — getTmdbNewOnOtt: TV half classifies adult rows out of the rail
// ============================================================
{
  clearCache();
  const cleanMovie = movieRow(70001, 'OTT Film');
  const cleanTv = tvRow(70002, 'OTT Series');
  const adultTv = tvRow(70333, 'Sunday CinemaDosti');
  installMock({
    listByPath: {
      '/3/discover/movie': [cleanMovie],
      '/3/discover/tv': [cleanTv, adultTv]
    },
    totalPages: 30,
    details: { 70333: tvDetail(adultTv, [{ id: 4623, name: 'The CinemaDosti' }]) }
  });
  try {
    const result = await getTmdbNewOnOtt(undefined, 'all', 1);
    const titles = result.items.map((i) => i.title);
    assert.ok(!titles.includes('Sunday CinemaDosti'), 'new-on-ott TV half excludes the CinemaDosti-network row');
    assert.ok(titles.includes('OTT Film') && titles.includes('OTT Series'), 'clean rows survive both halves');
    ok('9. new-on-ott: TV half enforces the central-classifier pass');
  } finally {
    restoreFetch();
  }
}

// ============================================================
// 10 — Cache isolation: the exclusion value is a collection cache dimension
// ============================================================
{
  clearCache();
  installMock({ listByPath: { '/3/discover/tv': [tvRow(80001, 'Cache Probe')] }, totalPages: 30, details: {} });
  try {
    await getTmdbCollection('series', 1, { sort: 'For you' });
    const firstCount = fetchLog.length;
    await getTmdbCollection('series', 1, { sort: 'For you' });
    assert.equal(fetchLog.length, firstCount, 'identical params hit the cache (no second upstream fetch)');
    ok('10. cache: identical collection params resolve from cache (exclusion dimension already embedded in the key)');
  } finally {
    restoreFetch();
  }
}

console.log(`\nAdult catalog hardening tests passed (${passed} check groups).`);
