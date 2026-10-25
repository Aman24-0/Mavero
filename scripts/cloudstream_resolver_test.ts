import assert from 'node:assert/strict';
import { resolveCloudStream, mapBounded, CLOUDSTREAM_ADAPTER_CONCURRENCY } from '$lib/server/cloudstream/resolver/service';
import { lookupCloudStreamAdapterInstance } from '$lib/server/cloudstream/adapters/registry';
import { createMockFetcher, routeTable, PUBLIC_DNS, DYNAMIC_URLS_URL, JSON_ROUTE, resetCaches, createCounter, createHangingFetcher } from './cloudstream_cs2_helpers';
import {
  BOLLYFLIX_SEARCH_HTML,
  BOLLYFLIX_MOVIE_HTML,
  SIDEXFEE_HTML,
  GDFLIX_PAGE_HTML,
  GDFLIX_CF_PAGE_HTML,
  GDFLIX_FASTCLOUD_PAGE_HTML,
  MOVIESDRIVE_SEARCH_JSON,
  MOVIESDRIVE_MOVIE_HTML,
  MOVIESDRIVE_DL1_HTML,
  HUBCLOUD_PAGE_HTML,
  HUBCLOUD_CARD_HTML,
  VEGAMOVIES_SEARCH_JSON,
  VEGAMOVIES_MOVIE_HTML,
  VEGAMOVIES_GET_PAGE_HTML,
  VCLOUD_PAGE_HTML,
} from './cloudstream_cs2_helpers';

// CS-2 suite 4: the bounded orchestrator — bounded CONCURRENCY (test 10),
// provider TIMEOUT (test 9), PARTIAL-FAILURE isolation (test 13),
// diagnostics aggregation (test 14), and unsupported-adapter behavior
// (test 3). Deterministic: mock fetchers only.

const counter = createCounter();
const ok = (condition: unknown, label: string) => counter.ok(condition, label, assert.ok);

const BASE_MEDIA = { tmdbId: '27205', title: 'Inception', year: 2010 };

function fullRoutes(): ReturnType<typeof routeTable> {
  return routeTable({
    [DYNAMIC_URLS_URL]: {
      body: JSON.stringify({ bollyflix: 'https://bollyflix.test', moviesdrive: 'https://moviesdrive.test', vegamovies: 'https://vegamovies.test', gdflix: 'https://gdflix.test', hubcloud: 'https://hubcloud.test', vcloud: 'https://vcloud.test' }),
      contentType: JSON_ROUTE,
    },
    // Bollyflix
    'https://bollyflix.test/search/Inception/page/1/': { body: BOLLYFLIX_SEARCH_HTML },
    'https://bollyflix.test/inception-2010/': { body: BOLLYFLIX_MOVIE_HTML },
    'https://web.sidexfee.com/?id=QUJDREVG': { body: SIDEXFEE_HTML, contentType: 'text/plain' },
    // MoviesDrive
    'https://moviesdrive.test/search.php?q=Inception&page=1': { body: MOVIESDRIVE_SEARCH_JSON, contentType: JSON_ROUTE },
    'https://moviesdrive.test/inception-2010/': { body: MOVIESDRIVE_MOVIE_HTML },
    'https://moviesdrive.test/dl1/': { body: MOVIESDRIVE_DL1_HTML },
    'https://moviesdrive.test/dl2/': { body: MOVIESDRIVE_DL1_HTML },
    'https://hubcloud.test/dl/hub-1080': { body: HUBCLOUD_PAGE_HTML },
    'https://hubcloud.test/download/abc': { body: HUBCLOUD_CARD_HTML },
    // VegaMovies
    'https://vegamovies.test/search.php?q=Inception&page=1': { body: VEGAMOVIES_SEARCH_JSON, contentType: JSON_ROUTE },
    'https://vegamovies.test/inception-2010-hd/': { body: VEGAMOVIES_MOVIE_HTML },
    'https://vegamovies.test/get/1080p/': { body: VEGAMOVIES_GET_PAGE_HTML },
    'https://vegamovies.test/get/720p/': { body: VEGAMOVIES_GET_PAGE_HTML },
    'https://vcloud.test/file/vc-1080': { body: VCLOUD_PAGE_HTML },
    'https://vcloud.test/download/vc-abc': { body: HUBCLOUD_CARD_HTML },
    // GDFlix (shared extractor pages)
    'https://gdflix.test/file/inception-1080': { body: GDFLIX_PAGE_HTML },
    'https://gdflix.test/cf-index?type=1': { body: GDFLIX_CF_PAGE_HTML },
    'https://gdflix.test/cf-index?type=2': { body: GDFLIX_CF_PAGE_HTML },
    'https://gdflix.test/fast-cloud': { body: GDFLIX_FASTCLOUD_PAGE_HTML },
    'https://gdflix.test/instant/xyz': { status: 302, location: 'https://instant.test/dl?url=https://instantreal.test/file.mkv' },
    'https://fastdlserver.test/f/inception-1080': { status: 302, location: 'https://gdflix.test/file/inception-1080' },
  });
}

// ---------------------------------------------------------------------------
// A. Multi-provider movie resolution through the orchestrator (test 4)
// ---------------------------------------------------------------------------
{
  resetCaches();
  const result = await resolveCloudStream({
    media: BASE_MEDIA,
    adapterIds: ['Bollyflix', 'MoviesDrive', 'VegaMovies'],
  }, {
    fetcher: createMockFetcher(fullRoutes()),
    dnsResolver: PUBLIC_DNS,
    adapterTimeoutMs: 5_000,
    overallTimeoutMs: 10_000,
  });

  ok(result.groups.length === 3, 'A: one group per adapter');
  const loaded = result.groups.filter((g) => g.status === 'loaded');
  ok(loaded.length === 3, `A: all three providers loaded (got ${loaded.length})`);
  ok(result.groups.every((g) => g.links.length > 0), 'A: every group has links');
  ok(result.groups.some((g) => g.adapterId === 'Bollyflix' && g.links.some((l) => l.extractor === 'gdflix')), 'A: Bollyflix links carry gdflix attribution');
  ok(result.groups.some((g) => g.adapterId === 'MoviesDrive' && g.links.some((l) => l.extractor === 'hubcloud')), 'A: MoviesDrive links carry hubcloud attribution');
  ok(result.groups.some((g) => g.adapterId === 'VegaMovies' && g.links.some((l) => l.sourceName.includes('V-Cloud'))), 'A: VegaMovies links carry V-Cloud source labels');
  ok(result.durationMs >= 0, 'A: duration recorded');
  ok(result.groups.every((g) => g.links.every((l) => l.provider === g.adapterId)), 'A: link provider matches the group adapter');

  // Diagnostics aggregate adapter + extractor + fetch events.
  const adapterIds = new Set(result.diagnostics.map((e) => e.adapterId));
  ok(adapterIds.has('Bollyflix') && adapterIds.has('MoviesDrive') && adapterIds.has('VegaMovies'), 'A: diagnostics attributed per adapter');
  ok(result.diagnostics.some((e) => e.stage === 'resolve' && e.success === true), 'A: resolve events recorded');
  ok(result.diagnostics.some((e) => e.stage === 'extractor'), 'A: extractor events recorded');
}

// ---------------------------------------------------------------------------
// B. Bounded concurrency (test 10)
// ---------------------------------------------------------------------------
{
  // B1: unit-level — mapBounded never exceeds the concurrency limit.
  let inFlight = 0;
  let maxInFlight = 0;
  const items = Array.from({ length: 12 }, (_, i) => i);
  const out = await mapBounded(items, 4, async (item) => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 5 + (item % 3)));
    inFlight -= 1;
    return item * 2;
  });
  ok(out.length === 12 && out[11] === 22, 'B: mapBounded preserves results + order');
  ok(maxInFlight <= 4, `B: max in-flight ≤ 4 (observed ${maxInFlight})`);
  ok(maxInFlight >= 2, `B: work actually parallelized (observed ${maxInFlight})`);

  // B2: integration-level — the orchestrator caps in-flight adapters.
  resetCaches();
  let fetchesInFlight = 0;
  let fetchMaxInFlight = 0;
  const trackingFetcher: typeof fetch = async (input, init) => {
    fetchesInFlight += 1;
    fetchMaxInFlight = Math.max(fetchMaxInFlight, fetchesInFlight);
    await new Promise((resolve) => setTimeout(resolve, 15));
    fetchesInFlight -= 1;
    void init;
    const mock = createMockFetcher(fullRoutes());
    return mock(input, init);
  };
  await resolveCloudStream(
    { media: BASE_MEDIA, adapterIds: ['Bollyflix', 'MoviesDrive', 'VegaMovies'] },
    { fetcher: trackingFetcher, dnsResolver: PUBLIC_DNS, adapterTimeoutMs: 5_000, overallTimeoutMs: 20_000 },
  );
  ok(fetchMaxInFlight >= 3, `B: adapters resolve in parallel (observed ${fetchMaxInFlight} concurrent fetches)`);
  ok(fetchMaxInFlight <= CLOUDSTREAM_ADAPTER_CONCURRENCY * 2, 'B: concurrency stays bounded near the adapter limit (adapters + shared extractor fetches)');
}

// ---------------------------------------------------------------------------
// C. Provider timeout (test 9) — one provider hangs, deadline fires
// ---------------------------------------------------------------------------
{
  resetCaches();
  // Routes where ONLY VegaMovies search hangs (hanging fetcher for that URL).
  const routes = fullRoutes();
  const hanging = createHangingFetcher();
  const selectiveFetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.includes('vegamovies.test')) return hanging(input, init);
    return createMockFetcher(routes)(input, init);
  };
  const result = await resolveCloudStream(
    { media: BASE_MEDIA, adapterIds: ['Bollyflix', 'VegaMovies', 'MoviesDrive'] },
    { fetcher: selectiveFetcher, dnsResolver: PUBLIC_DNS, adapterTimeoutMs: 150, overallTimeoutMs: 10_000 },
  );

  const vega = result.groups.find((g) => g.adapterId === 'VegaMovies');
  ok(vega?.status === 'failed', 'C: hanging provider marked failed');
  ok(vega?.failure?.category === 'TIMEOUT', `C: failure category is TIMEOUT (got ${vega?.failure?.category})`);
  ok(vega?.links.length === 0, 'C: hanging provider yields no links');

  // The OTHER providers still succeeded.
  const bolly = result.groups.find((g) => g.adapterId === 'Bollyflix');
  const drive = result.groups.find((g) => g.adapterId === 'MoviesDrive');
  ok(bolly?.status === 'loaded' && (bolly?.links.length ?? 0) > 0, 'C: Bollyflix still loaded while VegaMovies timed out');
  ok(drive?.status === 'loaded' && (drive?.links.length ?? 0) > 0, 'C: MoviesDrive still loaded while VegaMovies timed out');
}

// ---------------------------------------------------------------------------
// D. One-provider failure must NOT destroy successful providers (test 13)
// ---------------------------------------------------------------------------
{
  resetCaches();
  // Provider A (Bollyflix) → search 500s (permanent HTTP failure);
  // Provider B (MoviesDrive) → success; Provider C (VegaMovies) → extractor
  // failure (V-Cloud page missing → no links).
  const routes = routeTable({
    [DYNAMIC_URLS_URL]: {
      body: JSON.stringify({ bollyflix: 'https://bollyflix.test', moviesdrive: 'https://moviesdrive.test', vegamovies: 'https://vegamovies.test', gdflix: 'https://gdflix.test', hubcloud: 'https://hubcloud.test', vcloud: 'https://vcloud.test' }),
      contentType: JSON_ROUTE,
    },
    // Bollyflix: search page fails with 500.
    'https://bollyflix.test/search/Inception/page/1/': { status: 500, body: 'boom' },
    // MoviesDrive: full happy path.
    'https://moviesdrive.test/search.php?q=Inception&page=1': { body: MOVIESDRIVE_SEARCH_JSON, contentType: JSON_ROUTE },
    'https://moviesdrive.test/inception-2010/': { body: MOVIESDRIVE_MOVIE_HTML },
    'https://moviesdrive.test/dl1/': { body: MOVIESDRIVE_DL1_HTML },
    'https://moviesdrive.test/dl2/': { body: MOVIESDRIVE_DL1_HTML },
    'https://gdflix.test/file/inception-1080': { body: GDFLIX_PAGE_HTML },
    'https://gdflix.test/cf-index?type=1': { body: GDFLIX_CF_PAGE_HTML },
    'https://gdflix.test/cf-index?type=2': { body: GDFLIX_CF_PAGE_HTML },
    'https://gdflix.test/fast-cloud': { body: GDFLIX_FASTCLOUD_PAGE_HTML },
    'https://gdflix.test/instant/xyz': { status: 302, location: 'https://instant.test/dl?url=https://instantreal.test/file.mkv' },
    'https://hubcloud.test/dl/hub-1080': { body: HUBCLOUD_PAGE_HTML },
    'https://hubcloud.test/download/abc': { body: HUBCLOUD_CARD_HTML },
    // VegaMovies: search + page OK, but the V-Cloud file page is missing
    // (extractor returns no links → EXTRACTOR_FAILED group).
    'https://vegamovies.test/search.php?q=Inception&page=1': { body: VEGAMOVIES_SEARCH_JSON, contentType: JSON_ROUTE },
    'https://vegamovies.test/inception-2010-hd/': { body: VEGAMOVIES_MOVIE_HTML },
    'https://vegamovies.test/get/1080p/': { body: VEGAMOVIES_GET_PAGE_HTML },
    'https://vegamovies.test/get/720p/': { body: VEGAMOVIES_GET_PAGE_HTML },
  });
  const result = await resolveCloudStream(
    { media: BASE_MEDIA, adapterIds: ['Bollyflix', 'MoviesDrive', 'VegaMovies'] },
    { fetcher: createMockFetcher(routes), dnsResolver: PUBLIC_DNS, adapterTimeoutMs: 5_000, overallTimeoutMs: 10_000 },
  );

  const bolly = result.groups.find((g) => g.adapterId === 'Bollyflix');
  const drive = result.groups.find((g) => g.adapterId === 'MoviesDrive');
  const vega = result.groups.find((g) => g.adapterId === 'VegaMovies');
  ok(bolly?.status === 'failed', `D: failed provider marked failed (got ${bolly?.status})`);
  ok(bolly?.failure?.category === 'LOAD_FAILED', 'D: HTTP search failure → LOAD_FAILED category');
  ok(drive?.status === 'loaded' && (drive?.links.length ?? 0) > 0, 'D: SUCCESSFUL provider result preserved (MoviesDrive loaded)');
  ok(vega?.failure?.category === 'EXTRACTOR_FAILED' || vega?.failure?.category === 'LOAD_FAILED', 'D: extractor-failure provider classified honestly');
  ok(result.groups.length === 3, 'D: every provider present in the result');
}

// ---------------------------------------------------------------------------
// E. Unsupported / unknown adapter behavior (test 3)
// ---------------------------------------------------------------------------
{
  resetCaches();
  const result = await resolveCloudStream(
    { media: BASE_MEDIA, adapterIds: ['CineStream', 'Moviesmod', 'NopeProvider'] },
    { fetcher: createMockFetcher(routeTable({})), dnsResolver: PUBLIC_DNS, adapterTimeoutMs: 1_000, overallTimeoutMs: 3_000 },
  );
  ok(result.groups.length === 3, 'E: every requested adapter id produces a group');
  ok(result.groups.every((g) => g.status === 'failed'), 'E: unregistered adapters → failed groups');
  ok(result.groups.every((g) => g.failure?.category === 'UNSUPPORTED'), 'E: unregistered adapters → UNSUPPORTED category');
  ok(result.groups.every((g) => g.links.length === 0), 'E: no links invented for unsupported adapters');
  ok(result.groups.every((g) => g.adapterName === g.adapterId), 'E: adapterName falls back to the id');
}

// ---------------------------------------------------------------------------
// F. Episode resolution through the orchestrator (tests 5+6)
// ---------------------------------------------------------------------------
{
  resetCaches();
  const routes = routeTable({
    [DYNAMIC_URLS_URL]: {
      body: JSON.stringify({ bollyflix: 'https://bollyflix.test', gdflix: 'https://gdflix.test' }),
      contentType: JSON_ROUTE,
    },
    'https://bollyflix.test/search/Dark/page/1/': {
      body: `<html><body><div class="post-cards"><article><a title="Download Dark Series Complete" href="https://bollyflix.test/dark-series/"><img src="/p.jpg"/></a></article></div></body></html>`,
    },
    'https://bollyflix.test/dark-series/': {
      body: `<html><head><title>Download Dark Series Complete</title></head><body><div><h2>Season 1</h2><p><a class="maxbutton-download-links" href="https://bollyflix.test/season1/">Download</a></p></div></body></html>`,
    },
    'https://bollyflix.test/season1/': {
      body: `<html><body><h3><a href="https://bollyflix.test/ep1/">Episode 1</a></h3><h3><a href="https://gdflix.test/file/ep2">Episode 2</a></h3><h3><a href="https://bollyflix.test/zip/">Zip</a></h3></body></html>`,
    },
    'https://gdflix.test/file/ep2': { body: GDFLIX_PAGE_HTML },
    'https://gdflix.test/cf-index?type=1': { body: GDFLIX_CF_PAGE_HTML },
    'https://gdflix.test/cf-index?type=2': { body: GDFLIX_CF_PAGE_HTML },
    'https://gdflix.test/fast-cloud': { body: GDFLIX_FASTCLOUD_PAGE_HTML },
    'https://gdflix.test/instant/xyz': { status: 302, location: 'https://instant.test/dl?url=https://instantreal.test/file.mkv' },
  });
  const result = await resolveCloudStream(
    { media: { tmdbId: '70523', title: 'Dark', year: 2017 }, season: 1, episode: 2, adapterIds: ['Bollyflix'] },
    { fetcher: createMockFetcher(routes), dnsResolver: PUBLIC_DNS, adapterTimeoutMs: 5_000, overallTimeoutMs: 10_000 },
  );
  ok(result.groups.length === 1, 'F: episode request routes to the adapter');
  ok(result.groups[0]?.status === 'loaded', 'F: episode resolved');
  ok((result.groups[0]?.links.length ?? 0) > 0, 'F: episode links present');
  // Episode identity is not treated as a movie: the resolver passes the
  // season/episode through (verified by the loaded state above; a movie
  // request against the same title would return UNSUPPORTED).
}

// ---------------------------------------------------------------------------
// G. Adapter id de-duplication + case-insensitivity
// ---------------------------------------------------------------------------
{
  resetCaches();
  const result = await resolveCloudStream(
    { media: BASE_MEDIA, adapterIds: ['bollyflix', 'Bollyflix', 'BOLLYFLIX', ' bollyflix '] },
    { fetcher: createMockFetcher(fullRoutes()), dnsResolver: PUBLIC_DNS, adapterTimeoutMs: 5_000, overallTimeoutMs: 10_000 },
  );
  ok(result.groups.length === 1, 'G: duplicate adapter ids collapse to one group');
  ok(result.groups[0]?.adapterId === 'Bollyflix', 'G: canonical adapter id used');

  const adapter = lookupCloudStreamAdapterInstance('Bollyflix');
  ok(adapter?.resolveEpisode !== undefined, 'G: registry instance carries resolveEpisode for orchestrator dispatch');
}

console.log(counter.summary('cloudstream_resolver_test'));
