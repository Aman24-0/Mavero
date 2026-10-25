import assert from 'node:assert/strict';
import { bollyflixAdapter } from '$lib/server/cloudstream/adapters/bollyflix';
import { moviesdriveAdapter } from '$lib/server/cloudstream/adapters/moviesdrive';
import { vegamoviesAdapter } from '$lib/server/cloudstream/adapters/vegamovies';
import { createCloudStreamRuntimeContext } from '$lib/server/cloudstream/runtime/context';
import { createMockFetcher, routeTable, PUBLIC_DNS, DYNAMIC_URLS_URL, JSON_ROUTE, HTML_ROUTE, resetCaches, createCounter } from './cloudstream_cs2_helpers';
import {
  BOLLYFLIX_SEARCH_HTML,
  BOLLYFLIX_MOVIE_HTML,
  BOLLYFLIX_SERIES_HTML,
  BOLLYFLIX_SEASON_PAGE_HTML,
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
  VEGAMOVIES_SERIES_HTML,
  VEGAMOVIES_EPISODE_PAGE_HTML,
  VCLOUD_PAGE_HTML,
} from './cloudstream_cs2_helpers';

// CS-2 suite 3: MOVIE resolution (test 4), SERIES/EPISODE resolution
// (tests 5+6) for all three ported providers against deterministic fixture
// pages. No network.

const counter = createCounter();
const ok = (condition: unknown, label: string) => counter.ok(condition, label, assert.ok);

const BASE_REQUEST = { tmdbId: '27205', title: 'Inception', year: 2010 };

function makeSignal(): AbortSignal {
  return new AbortController().signal;
}

// ---------------------------------------------------------------------------
// A. Bollyflix movie resolution (test 4)
// ---------------------------------------------------------------------------
{
  resetCaches();
  const routes = routeTable({
    [DYNAMIC_URLS_URL]: { body: JSON.stringify({ bollyflix: 'https://bollyflix.test', gdflix: 'https://gdflix.test' }), contentType: JSON_ROUTE },
    'https://bollyflix.test/search/Inception/page/1/': { body: BOLLYFLIX_SEARCH_HTML },
    'https://bollyflix.test/inception-2010/': { body: BOLLYFLIX_MOVIE_HTML },
    'https://web.sidexfee.com/?id=QUJDREVG': { body: SIDEXFEE_HTML, contentType: 'text/plain' },
    'https://gdflix.test/file/inception-1080': { body: GDFLIX_PAGE_HTML },
    'https://gdflix.test/cf-index?type=1': { body: GDFLIX_CF_PAGE_HTML },
    'https://gdflix.test/cf-index?type=2': { body: GDFLIX_CF_PAGE_HTML },
    'https://gdflix.test/fast-cloud': { body: GDFLIX_FASTCLOUD_PAGE_HTML },
    'https://gdflix.test/instant/xyz': { status: 302, location: 'https://instant.test/dl?url=https://instantreal.test/file.mkv' },
    'https://fastdlserver.test/f/inception-1080': { status: 302, location: 'https://gdflix.test/file/inception-1080' },
  });
  const ctx = createCloudStreamRuntimeContext({
    adapterId: 'Bollyflix',
    signal: makeSignal(),
    fetcher: createMockFetcher(routes),
    dnsResolver: PUBLIC_DNS,
  });

  const result = await bollyflixAdapter.resolveMovie({ ...BASE_REQUEST, deadline: makeSignal() }, ctx);
  ok(result.links.length >= 5, `A: Bollyflix movie resolution produced links (got ${result.links.length})`);
  ok(result.failure === undefined, 'A: no failure on success');
  ok(result.matchedTitle !== undefined && result.matchedTitle.includes('Inception'), 'A: matched title surfaced');
  const urls = result.links.map((l) => l.url);
  ok(urls.includes('https://gdflix.test/dl/fsl/abc'), 'A: bypassed sidexfee link extracted through GDFlix');
  ok(urls.includes('https://pixeldrain.com/api/file/abc123?download'), 'A: pixeldrain conversion reached the result');
  ok(result.links.every((l) => l.provider === 'Bollyflix'), 'A: every link attributed to Bollyflix');
  ok(result.links.every((l) => l.kind === 'https'), 'A: link kinds classified');
  ok(result.links.some((l) => l.quality === '1080p'), 'A: quality preserved');
  ok(result.links.some((l) => l.sizeBytes === 2_400_000_000), 'A: size preserved');
  ok(result.links.some((l) => l.codec === 'H.264'), 'A: codec derived');
  ok(result.links.some((l) => l.container === 'MKV'), 'A: container derived');

  // Diagnostics captured the full path.
  const events = ctx.diagnostics.events();
  ok(events.some((e) => e.stage === 'bypass' && e.success === true), 'A: sidexfee bypass event recorded');
  ok(events.some((e) => e.stage === 'extractor' && e.extractorId === 'gdflix'), 'A: extractor event recorded');
  ok(events.some((e) => e.stage === 'load' && e.success === true), 'A: page load event recorded');
}

// ---------------------------------------------------------------------------
// B. Bollyflix episode resolution (tests 5+6)
// ---------------------------------------------------------------------------
{
  resetCaches();
  const routes = routeTable({
    [DYNAMIC_URLS_URL]: { body: JSON.stringify({ bollyflix: 'https://bollyflix.test', gdflix: 'https://gdflix.test' }), contentType: JSON_ROUTE },
    'https://bollyflix.test/search/Dark/page/1/': {
      body: `<html><body><div class="post-cards"><article><a title="Download Dark Series Complete" href="https://bollyflix.test/dark-series/"><img src="/p.jpg"/></a></article></div></body></html>`,
    },
    'https://bollyflix.test/dark-series/': { body: BOLLYFLIX_SERIES_HTML },
    'https://bollyflix.test/season1/': { body: BOLLYFLIX_SEASON_PAGE_HTML },
    'https://gdflix.test/file/ep1': { body: GDFLIX_PAGE_HTML },
    'https://gdflix.test/file/ep2': { body: GDFLIX_PAGE_HTML },
    'https://gdflix.test/cf-index?type=1': { body: GDFLIX_CF_PAGE_HTML },
    'https://gdflix.test/cf-index?type=2': { body: GDFLIX_CF_PAGE_HTML },
    'https://gdflix.test/fast-cloud': { body: GDFLIX_FASTCLOUD_PAGE_HTML },
    'https://gdflix.test/instant/xyz': { status: 302, location: 'https://instant.test/dl?url=https://instantreal.test/file.mkv' },
  });
  const ctx = createCloudStreamRuntimeContext({
    adapterId: 'Bollyflix',
    signal: makeSignal(),
    fetcher: createMockFetcher(routes),
    dnsResolver: PUBLIC_DNS,
  });

  // Episode 2 → the second h3 > a on the season page (Zip excluded).
  const ep2 = await bollyflixAdapter.resolveEpisode?.({ ...BASE_REQUEST, title: 'Dark', year: 2017, deadline: makeSignal(), season: 1, episode: 2 }, ctx);
  ok(ep2 !== undefined, 'B: Bollyflix adapter implements resolveEpisode');
  ok((ep2?.links.length ?? 0) >= 5, 'B: episode 2 resolved through the season page');

  // Episode 1 → the first episode link.
  const ep1 = await bollyflixAdapter.resolveEpisode?.({ ...BASE_REQUEST, title: 'Dark', year: 2017, deadline: makeSignal(), season: 1, episode: 1 }, ctx);
  ok((ep1?.links.length ?? 0) >= 5, 'B: episode 1 resolved');

  // Episode 99 → beyond the list → honest NO_LINKS.
  const ep99 = await bollyflixAdapter.resolveEpisode?.({ ...BASE_REQUEST, title: 'Dark', year: 2017, deadline: makeSignal(), season: 1, episode: 99 }, ctx);
  ok(ep99?.failure?.category === 'NO_LINKS', 'B: nonexistent episode → NO_LINKS (honest)');

  // Series identity is NOT treated as a movie (movie request against a
  // series title yields UNSUPPORTED, never fake movie links).
  const movieAgainstSeries = await bollyflixAdapter.resolveMovie({ ...BASE_REQUEST, title: 'Dark', year: 2017, deadline: makeSignal() }, ctx);
  ok(movieAgainstSeries.failure?.category === 'UNSUPPORTED', 'B: movie request against a series page → UNSUPPORTED');
  ok(movieAgainstSeries.links.length === 0, 'B: no movie links invented for a series');
}

// ---------------------------------------------------------------------------
// C. MoviesDrive movie resolution (search.php JSON API)
// ---------------------------------------------------------------------------
{
  resetCaches();
  const routes = routeTable({
    [DYNAMIC_URLS_URL]: { body: JSON.stringify({ moviesdrive: 'https://moviesdrive.test', gdflix: 'https://gdflix.test', hubcloud: 'https://hubcloud.test' }), contentType: JSON_ROUTE },
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
  });
  const ctx = createCloudStreamRuntimeContext({
    adapterId: 'MoviesDrive',
    signal: makeSignal(),
    fetcher: createMockFetcher(routes),
    dnsResolver: PUBLIC_DNS,
  });

  const result = await moviesdriveAdapter.resolveMovie({ ...BASE_REQUEST, deadline: makeSignal() }, ctx);
  ok(result.links.length >= 5, `C: MoviesDrive movie resolution produced links (got ${result.links.length})`);
  const urls = result.links.map((l) => l.url);
  ok(urls.includes('https://gdflix.test/dl/fsl/abc'), 'C: GDFlix-extracted link present');
  ok(urls.some((u) => u.startsWith('https://fsl.hubcloud.test') || u.startsWith('https://buzz.hubcloud.test')), 'C: HubCloud-extracted link present');
  ok(result.links.every((l) => l.provider === 'MoviesDrive'), 'C: provider attribution');

  // Search failure → NO_MATCH.
  const emptySearchRoutes = routeTable({
    [DYNAMIC_URLS_URL]: { body: JSON.stringify({ moviesdrive: 'https://moviesdrive.test' }), contentType: JSON_ROUTE },
    'https://moviesdrive.test/search.php?q=Inception&page=1': { body: JSON.stringify({ hits: [] }), contentType: JSON_ROUTE },
  });
  const noMatchCtx = createCloudStreamRuntimeContext({
    adapterId: 'MoviesDrive',
    signal: makeSignal(),
    fetcher: createMockFetcher(emptySearchRoutes),
    dnsResolver: PUBLIC_DNS,
  });
  const noMatch = await moviesdriveAdapter.resolveMovie({ ...BASE_REQUEST, deadline: makeSignal() }, noMatchCtx);
  ok(noMatch.failure?.category === 'NO_MATCH', 'C: empty search → NO_MATCH');
}

// ---------------------------------------------------------------------------
// D. MoviesDrive episode resolution (span Ep + next-sibling walk)
// ---------------------------------------------------------------------------
{
  resetCaches();
  const spanEpisodePage = `
  <html><body>
    <div><h4>Season 1</h4></div>
    <div>
      <p><span>Ep01</span> Episode 1</p>
      <p><a href="https://hubcloud.test/dl/e1">HubCloud E1</a></p>
      <p><span>Ep02</span> Episode 2</p>
      <p><a href="https://hubcloud.test/dl/e2">HubCloud E2</a></p>
    </div>
  </body></html>`;
  const routes = routeTable({
    [DYNAMIC_URLS_URL]: { body: JSON.stringify({ moviesdrive: 'https://moviesdrive.test', hubcloud: 'https://hubcloud.test' }), contentType: JSON_ROUTE },
    'https://moviesdrive.test/search.php?q=Dark&page=1': {
      body: JSON.stringify({ hits: [{ document: { permalink: '/dark-series/', post_title: 'Dark Series Season 1 1080p', post_thumbnail: 'https://img.test/d.jpg' } }] }),
      contentType: JSON_ROUTE,
    },
    'https://moviesdrive.test/dark-series/': {
      body: `<html><head><title>Download Dark Series Season 1</title></head><body><div><h3>Season 1</h3><h5><a href="https://moviesdrive.test/eps/">Season 1 Episodes</a></h5></div></body></html>`,
    },
    'https://moviesdrive.test/eps/': { body: spanEpisodePage },
    'https://hubcloud.test/dl/e1': { body: HUBCLOUD_PAGE_HTML },
    'https://hubcloud.test/dl/e2': { body: '<html><body><script>var url = \'/download/e2\';</script></body></html>' },
    'https://hubcloud.test/download/abc': { body: HUBCLOUD_CARD_HTML },
    'https://hubcloud.test/download/e2': { body: '<html><body><div class="card-header">Dark S01E02 1080p</div><i id="size">1.4 GB</i><h2><a class="btn" href="https://fsl.hubcloud.test/file-e2">FSL Server</a></h2></body></html>' },
  });
  const ctx = createCloudStreamRuntimeContext({
    adapterId: 'MoviesDrive',
    signal: makeSignal(),
    fetcher: createMockFetcher(routes),
    dnsResolver: PUBLIC_DNS,
  });

  const ep1 = await moviesdriveAdapter.resolveEpisode?.({ ...BASE_REQUEST, title: 'Dark', year: 2017, deadline: makeSignal(), season: 1, episode: 1 }, ctx);
  ok((ep1?.links.length ?? 0) > 0, 'D: MoviesDrive episode 1 resolved via span walk');
  const ep2 = await moviesdriveAdapter.resolveEpisode?.({ ...BASE_REQUEST, title: 'Dark', year: 2017, deadline: makeSignal(), season: 1, episode: 2 }, ctx);
  ok((ep2?.links.length ?? 0) > 0, 'D: MoviesDrive episode 2 resolved via span walk');
  ok(ep1?.links[0]?.url !== ep2?.links[0]?.url, 'D: episode 1 and 2 produce different source links');
}

// ---------------------------------------------------------------------------
// E. VegaMovies movie resolution (V-Cloud flow)
// ---------------------------------------------------------------------------
{
  resetCaches();
  const routes = routeTable({
    [DYNAMIC_URLS_URL]: { body: JSON.stringify({ vegamovies: 'https://vegamovies.test', vcloud: 'https://vcloud.test' }), contentType: JSON_ROUTE },
    'https://vegamovies.test/search.php?q=Inception&page=1': { body: VEGAMOVIES_SEARCH_JSON, contentType: JSON_ROUTE },
    'https://vegamovies.test/inception-2010-hd/': { body: VEGAMOVIES_MOVIE_HTML },
    'https://vegamovies.test/get/1080p/': { body: VEGAMOVIES_GET_PAGE_HTML },
    'https://vegamovies.test/get/720p/': { body: VEGAMOVIES_GET_PAGE_HTML },
    'https://vcloud.test/file/vc-1080': { body: VCLOUD_PAGE_HTML },
    'https://vcloud.test/download/vc-abc': { body: HUBCLOUD_CARD_HTML },
  });
  const ctx = createCloudStreamRuntimeContext({
    adapterId: 'VegaMovies',
    signal: makeSignal(),
    fetcher: createMockFetcher(routes),
    dnsResolver: PUBLIC_DNS,
  });

  const result = await vegamoviesAdapter.resolveMovie({ ...BASE_REQUEST, deadline: makeSignal() }, ctx);
  ok(result.links.length >= 2, `E: VegaMovies movie resolution produced links (got ${result.links.length})`);
  ok(result.links.every((l) => l.extractor === 'hubcloud'), 'E: vcloud links resolved by the hubcloud port');
  ok(result.links.some((l) => l.sourceName.startsWith('V-Cloud')), 'E: V-Cloud source labels');
  ok(result.links.every((l) => l.provider === 'VegaMovies'), 'E: provider attribution');
}

// ---------------------------------------------------------------------------
// F. VegaMovies episode resolution (quality-tag + V-Cloud/Episode link flow)
// ---------------------------------------------------------------------------
{
  resetCaches();
  const routes = routeTable({
    [DYNAMIC_URLS_URL]: { body: JSON.stringify({ vegamovies: 'https://vegamovies.test', vcloud: 'https://vcloud.test' }), contentType: JSON_ROUTE },
    'https://vegamovies.test/search.php?q=Dark&page=1': {
      body: JSON.stringify({ hits: [{ document: { permalink: '/dark-2017/', post_title: 'Download Dark 2017 Season 1', post_thumbnail: 'https://img.test/v.jpg' } }] }),
      contentType: JSON_ROUTE,
    },
    'https://vegamovies.test/dark-2017/': { body: VEGAMOVIES_SERIES_HTML },
    'https://vegamovies.test/ep-pack/s1/': { body: VEGAMOVIES_EPISODE_PAGE_HTML },
    'https://vegamovies.test/gd/s1/': { body: VEGAMOVIES_EPISODE_PAGE_HTML },
    'https://vcloud.test/file/dark-s1e1': { body: '<html><body><script>var url = atob(atob(\'TDJSdmQyNXNiMkZrTDNaakxXUmhjbXN4\'));</script></body></html>' },
    'https://vcloud.test/file/dark-s1e2': { body: '<html><body><script>var url = atob(atob(\'TDJSdmQyNXNiMkZrTDNaakxXUmhjbXN5\'));</script></body></html>' },
    'https://vcloud.test/download/vc-dark1': { body: HUBCLOUD_CARD_HTML },
    'https://vcloud.test/download/vc-dark2': { body: '<html><body><div class="card-header">Dark S01E02 1080p</div><i id="size">1.4 GB</i><h2><a class="btn" href="https://fsl.hubcloud.test/file-d2">FSL Server</a></h2></body></html>' },
  });
  const ctx = createCloudStreamRuntimeContext({
    adapterId: 'VegaMovies',
    signal: makeSignal(),
    fetcher: createMockFetcher(routes),
    dnsResolver: PUBLIC_DNS,
  });

  const ep1 = await vegamoviesAdapter.resolveEpisode?.({ ...BASE_REQUEST, title: 'Dark', year: 2017, deadline: makeSignal(), season: 1, episode: 1 }, ctx);
  ok((ep1?.links.length ?? 0) > 0, 'F: VegaMovies episode 1 resolved via V-Cloud positional index');
  const ep2 = await vegamoviesAdapter.resolveEpisode?.({ ...BASE_REQUEST, title: 'Dark', year: 2017, deadline: makeSignal(), season: 1, episode: 2 }, ctx);
  ok((ep2?.links.length ?? 0) > 0, 'F: VegaMovies episode 2 resolved');
  ok(ep1?.links[0]?.url !== ep2?.links[0]?.url, 'F: episodes 1 and 2 differ');

  const wrongSeason = await vegamoviesAdapter.resolveEpisode?.({ ...BASE_REQUEST, title: 'Dark', year: 2017, deadline: makeSignal(), season: 5, episode: 1 }, ctx);
  ok(wrongSeason?.failure?.category === 'NO_LINKS', 'F: unknown season → NO_LINKS');

  // Movie request against a series page → UNSUPPORTED.
  const movieAgainstSeries = await vegamoviesAdapter.resolveMovie({ ...BASE_REQUEST, title: 'Dark', year: 2017, deadline: makeSignal() }, ctx);
  ok(movieAgainstSeries.failure?.category === 'UNSUPPORTED', 'F: movie request against series → UNSUPPORTED');
}

// ---------------------------------------------------------------------------
// G. Adapter failure surfaces (honest categories)
// ---------------------------------------------------------------------------
{
  resetCaches();
  const routes = routeTable({}); // everything 404s
  const ctx = createCloudStreamRuntimeContext({
    adapterId: 'Bollyflix',
    signal: makeSignal(),
    fetcher: createMockFetcher(routes),
    dnsResolver: PUBLIC_DNS,
  });
  const result = await bollyflixAdapter.resolveMovie({ ...BASE_REQUEST, deadline: makeSignal() }, ctx);
  ok(result.links.length === 0, 'G: search failure yields no links');
  ok(result.failure !== undefined, 'G: failure surfaced (search unreachable)');
}

console.log(counter.summary('cloudstream_adapters_test'));
void HTML_ROUTE;
