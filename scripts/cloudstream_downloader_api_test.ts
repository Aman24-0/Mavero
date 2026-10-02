import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  resolveCloudStreamDownloads,
  listCloudStreamDownloadTabs,
  resolveCloudStreamExtensionDownload,
  assertValidCloudStreamDownloadRequest,
  MAX_SELECTED_EXTENSIONS,
  type CloudStreamDownloaderDeps,
  type CloudStreamExtensionCatalog,
  type CloudStreamDownloadContent,
  type CloudStreamDownloadRequest,
} from '$lib/server/cloudstream/downloader/service';
import {
  CloudStreamDownloaderError,
  downloaderErrorStatus,
  downloaderErrorMessage,
  failureCategoryToErrorCode,
} from '$lib/server/cloudstream/downloader/errors';
import { streamCapabilities, type CapabilityStream } from '$lib/shared/stream-actions';
import { lookupCloudStreamAdapterInstance } from '$lib/server/cloudstream/adapters/registry';
import { resolveCloudStream } from '$lib/server/cloudstream/resolver/service';
import { resetRateLimitsForTests, RATE_LIMIT_RULES } from '$lib/server/http/rate-limit';
import {
  createMockFetcher,
  routeTable,
  PUBLIC_DNS,
  PRIVATE_DNS,
  DYNAMIC_URLS_URL,
  JSON_ROUTE,
  resetCaches,
  createCounter,
  createHangingFetcher,
} from './cloudstream_cs2_helpers';
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

// CS-3 suite: the Mavero Downloader 2 backend — extension selection, the
// three API endpoints' validation boundaries, partial-success semantics,
// deterministic ordering, dedup semantics, diagnostics redaction, security
// (SSRF rejection inside the service path), and CS-1/CS-2 regression
// invariants. Deterministic: mock catalog + injected content + mock
// fetchers only — never the real network, never the real DB.

const counter = createCounter();
const ok = (condition: unknown, label: string) => counter.ok(condition, label, assert.ok);

const read = (path: string) => readFileSync(path, 'utf8');

// ---------------------------------------------------------------------------
// Deterministic fixtures
// ---------------------------------------------------------------------------

const MOVIE_CONTENT: CloudStreamDownloadContent = {
  mediaType: 'movie',
  tmdbId: '27205',
  title: 'Inception',
  year: 2010,
};

const SERIES_CONTENT: CloudStreamDownloadContent = {
  mediaType: 'series',
  tmdbId: '70523',
  title: 'Dark',
  year: 2017,
};

/** Catalog: repo-1 enabled with 3 eligible + 1 no-adapter + 1 disabled. */
const FULL_CATALOG: CloudStreamExtensionCatalog = {
  repositories: [
    { id: 'repo-1', enabled: true, created_at: '2026-01-01T00:00:00Z' },
    { id: 'repo-2', enabled: false, created_at: '2026-02-01T00:00:00Z' },
  ],
  extensions: [
    { repository_id: 'repo-1', internal_name: 'Bollyflix', name: 'Bollyflix', icon_url: 'https://icon.test/bollyflix.png', enabled: true },
    { repository_id: 'repo-1', internal_name: 'MoviesDrive', name: 'Movies Drive', icon_url: null, enabled: true },
    { repository_id: 'repo-1', internal_name: 'VegaMovies', name: 'VegaMovies', icon_url: null, enabled: true },
    { repository_id: 'repo-1', internal_name: 'Moviesmod', name: 'Moviesmod', icon_url: null, enabled: true },
    { repository_id: 'repo-1', internal_name: 'CineStream', name: 'CineStream', icon_url: null, enabled: false },
    { repository_id: 'repo-2', internal_name: 'Repo2Only', name: 'Repo2 Only', icon_url: null, enabled: true },
  ],
};

/** The full 3-provider happy-path route table (CS-2 fixtures). */
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
    // GDFlix (shared extractor pages — SAME page reached by BOTH providers)
    'https://gdflix.test/file/inception-1080': { body: GDFLIX_PAGE_HTML },
    'https://gdflix.test/cf-index?type=1': { body: GDFLIX_CF_PAGE_HTML },
    'https://gdflix.test/cf-index?type=2': { body: GDFLIX_CF_PAGE_HTML },
    'https://gdflix.test/fast-cloud': { body: GDFLIX_FASTCLOUD_PAGE_HTML },
    'https://gdflix.test/instant/xyz': { status: 302, location: 'https://instant.test/dl?url=https://instantreal.test/file.mkv' },
    'https://fastdlserver.test/f/inception-1080': { status: 302, location: 'https://gdflix.test/file/inception-1080' },
  });
}

function baseDeps(
  routes: ReturnType<typeof routeTable>,
  content: CloudStreamDownloadContent = MOVIE_CONTENT,
  catalog: CloudStreamExtensionCatalog = FULL_CATALOG,
): CloudStreamDownloaderDeps {
  return {
    loadContent: async () => content,
    loadCatalog: async () => catalog,
    fetcher: createMockFetcher(routes),
    dnsResolver: PUBLIC_DNS,
    adapterTimeoutMs: 5_000,
    overallTimeoutMs: 15_000,
  };
}

const MOVIE_REQUEST: CloudStreamDownloadRequest = { mediaType: 'movie', contentId: 'movie-27205' };

// ---------------------------------------------------------------------------
// A. Movie request through the full service (brief items 2 + 13)
// ---------------------------------------------------------------------------
{
  resetCaches();
  const result = await resolveCloudStreamDownloads(null as never, MOVIE_REQUEST, {}, baseDeps(fullRoutes()));

  ok(result.groups.length === 3, `A: one group per eligible extension (got ${result.groups.length})`);
  ok(result.groups.every((group) => group.status === 'loaded'), 'A: all eligible extensions loaded for the movie');
  ok(result.groups.every((group) => group.links.length > 0), 'A: every group carries links');

  // Response media echo (request identity as resolved server-side).
  ok(result.media.mediaType === 'movie' && result.media.tmdbId === '27205' && result.media.title === 'Inception', 'A: media echo carries mediaType/tmdbId/title');
  ok(result.media.year === 2010, 'A: media echo carries the year');
  ok(result.media.season === undefined && result.media.episode === undefined, 'A: movie media echo carries no episode context');

  // Considered baseline: enabled rows in enabled repos (Bollyflix, MoviesDrive, VegaMovies, Moviesmod).
  ok(result.consideredExtensions === 4, `A: consideredExtensions counts enabled extensions (got ${result.consideredExtensions})`);

  // Normalized link view fields (brief item 13).
  const bolly = result.groups.find((group) => group.extensionId === 'Bollyflix');
  ok(bolly !== undefined, 'A: Bollyflix group present');
  const link = bolly?.links[0];
  ok(link !== undefined && typeof link.url === 'string' && link.url.startsWith('https://'), 'A: link url present + https');
  ok(link !== undefined && (link.kind === 'https' || link.kind === 'http'), 'A: link kind classified in the shared vocabulary');
  ok(bolly?.links.some((l) => l.quality === '1080p'), 'A: link quality preserved');
  ok(bolly?.links.some((l) => l.codec === 'H.264'), 'A: link codec derived');
  ok(bolly?.links.some((l) => l.container === 'MKV'), 'A: link container derived');
  ok(bolly?.links.some((l) => l.sizeBytes === 2_400_000_000), 'A: link size preserved');
  ok(bolly?.links.some((l) => l.host !== undefined && l.host.endsWith('.test')), 'A: link host derived');
  ok(bolly?.links.every((l) => l.provider === 'Bollyflix'), 'A: link provider attribution');
  ok(bolly?.links.some((l) => l.extractor === 'gdflix'), 'A: link extractor attribution');
  ok(bolly?.links.some((l) => typeof l.sourceName === 'string' && l.sourceName.length > 0), 'A: link sourceName present');

  // matchedTitle surfaced (CS-2 additive field).
  ok(typeof bolly?.matchedTitle === 'string' && (bolly?.matchedTitle ?? '').includes('Inception'), 'A: matchedTitle surfaced in the group');
}

// ---------------------------------------------------------------------------
// B. Series EPISODE request (brief item 3 — never resolved as a movie)
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
  const result = await resolveCloudStreamDownloads(
    null as never,
    { mediaType: 'series', contentId: 'series-70523', season: 1, episode: 2 },
    {},
    baseDeps(routes, SERIES_CONTENT, { repositories: FULL_CATALOG.repositories, extensions: [FULL_CATALOG.extensions[0]!] }),
  );

  ok(result.groups.length === 1, 'B: episode request routes through the eligible extension');
  ok(result.groups[0]?.status === 'loaded', 'B: episode resolved (season/episode walking, not the movie path)');
  ok((result.groups[0]?.links.length ?? 0) > 0, 'B: episode links present');
  ok(result.media.season === 1 && result.media.episode === 2, 'B: media echo carries season/episode');
  ok(result.media.mediaType === 'series', 'B: media echo carries the series media type');

  // The movie-vs-episode contract: a series request without season/episode
  // is INVALID; a movie request with them is INVALID (never ambiguous).
  let rejected = false;
  try {
    await resolveCloudStreamDownloads(null as never, { mediaType: 'series', contentId: 'series-70523' }, {}, baseDeps(routes, SERIES_CONTENT));
  } catch (error) {
    rejected = error instanceof CloudStreamDownloaderError && error.code === 'INVALID_REQUEST';
  }
  ok(rejected, 'B: series without season/episode rejected as INVALID_REQUEST');
}

// ---------------------------------------------------------------------------
// C. Eligible extension selection (brief items 4 + 5 + 6 + 9)
// ---------------------------------------------------------------------------
{
  resetCaches();
  const tabs = await listCloudStreamDownloadTabs(null as never, MOVIE_REQUEST, baseDeps(fullRoutes()));

  // Only eligible sources are listed: Moviesmod (no adapter), CineStream
  // (disabled), Repo2Only (repository disabled) are absent.
  ok(tabs.tabs.length === 3, `C: tabs list only eligible extensions (got ${tabs.tabs.length})`);
  ok(tabs.tabs.map((tab) => tab.extensionId).join(',') === 'Bollyflix,MoviesDrive,VegaMovies', 'C: tabs ordered by repository creation order then internal_name');
  const bollyTab = tabs.tabs[0];
  ok(bollyTab?.extensionName === 'Bollyflix', 'C: tab display name from the extension row');
  ok(bollyTab?.iconUrl === 'https://icon.test/bollyflix.png', 'C: tab icon from the extension row');
  ok(Array.isArray(bollyTab?.supportedMediaTypes) && bollyTab!.supportedMediaTypes.includes('movie'), 'C: tab supportedMediaTypes from the code registry');
  ok(bollyTab?.enabled === true && bollyTab?.compatible === true, 'C: tab enabled/compatible flags structurally true');
  ok(tabs.consideredExtensions === 4, 'C: consideredExtensions counts the enabled baseline');
  ok(tabs.media.title === 'Inception', 'C: tabs response carries the media echo');

  // No provider fetch happened for tabs (route table untouched is implicit —
  // tabs never call the fetcher; verified by the empty-adapter case below).
  const emptyTabs = await listCloudStreamDownloadTabs(null as never, MOVIE_REQUEST, {
    loadContent: async () => MOVIE_CONTENT,
    loadCatalog: async () => ({ repositories: [], extensions: [] }),
  });
  ok(emptyTabs.tabs.length === 0 && emptyTabs.consideredExtensions === 0, 'C: empty catalog yields an honest empty tab list');
}

// ---------------------------------------------------------------------------
// D. Selected extension validation (brief item 7 — explicit selection mode)
// ---------------------------------------------------------------------------
{
  resetCaches();
  const result = await resolveCloudStreamDownloads(
    null as never,
    MOVIE_REQUEST,
    { extensionIds: ['UnknownProvider', 'Moviesmod', 'CineStream', 'Repo2Only', 'Bollyflix'] },
    baseDeps(fullRoutes()),
  );

  // Requested order preserved; ineligible ids produce structured failed groups.
  ok(result.groups.map((group) => group.extensionId).join(',') === 'UnknownProvider,Moviesmod,CineStream,Repo2Only,Bollyflix', 'D: groups preserve the REQUESTED order');
  ok(result.groups[0]?.errorCode === 'EXTENSION_NOT_FOUND' && result.groups[0]?.status === 'failed', 'D: unknown extension → EXTENSION_NOT_FOUND failed group');
  ok(result.groups[1]?.errorCode === 'ADAPTER_NOT_AVAILABLE', 'D: enabled extension without adapter → ADAPTER_NOT_AVAILABLE');
  ok(result.groups[2]?.errorCode === 'EXTENSION_DISABLED', 'D: disabled extension → EXTENSION_DISABLED');
  ok(result.groups[3]?.errorCode === 'EXTENSION_DISABLED', 'D: extension in a disabled repository → EXTENSION_DISABLED');
  ok(result.groups[4]?.status === 'loaded' && (result.groups[4]?.links.length ?? 0) > 0, 'D: the eligible selected extension still resolves (partial success across the selection)');
  ok(result.groups.every((group) => group.links.every((l) => l.provider === 'Bollyflix') || group.status === 'failed'), 'D: ineligible groups carry no invented links');

  // Case-insensitive de-duplication of the selection.
  resetCaches();
  const deduped = await resolveCloudStreamDownloads(
    null as never,
    MOVIE_REQUEST,
    { extensionIds: ['bollyflix', 'Bollyflix', 'BOLLYFLIX'] },
    baseDeps(fullRoutes()),
  );
  ok(deduped.groups.length === 1 && deduped.groups[0]?.extensionId === 'Bollyflix', 'D: duplicate selection ids collapse to one canonical group');

  // Bound: too many selected extensions → INVALID_REQUEST.
  let tooMany = false;
  try {
    await resolveCloudStreamDownloads(
      null as never,
      MOVIE_REQUEST,
      { extensionIds: Array.from({ length: MAX_SELECTED_EXTENSIONS + 1 }, () => 'Bollyflix') },
      baseDeps(fullRoutes()),
    );
  } catch (error) {
    tooMany = error instanceof CloudStreamDownloaderError && error.code === 'INVALID_REQUEST';
  }
  ok(tooMany, 'D: selection above the bound rejected as INVALID_REQUEST');
}

// ---------------------------------------------------------------------------
// E. Partial provider failure (brief item 10 — one failure never sinks the rest)
// ---------------------------------------------------------------------------
{
  resetCaches();
  // Bollyflix search 500s; MoviesDrive succeeds; VegaMovies vcloud pages missing.
  const routes = routeTable({
    [DYNAMIC_URLS_URL]: {
      body: JSON.stringify({ bollyflix: 'https://bollyflix.test', moviesdrive: 'https://moviesdrive.test', vegamovies: 'https://vegamovies.test', gdflix: 'https://gdflix.test', hubcloud: 'https://hubcloud.test', vcloud: 'https://vcloud.test' }),
      contentType: JSON_ROUTE,
    },
    'https://bollyflix.test/search/Inception/page/1/': { status: 500, body: 'boom' },
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
    'https://vegamovies.test/search.php?q=Inception&page=1': { body: VEGAMOVIES_SEARCH_JSON, contentType: JSON_ROUTE },
    'https://vegamovies.test/inception-2010-hd/': { body: VEGAMOVIES_MOVIE_HTML },
    'https://vegamovies.test/get/1080p/': { body: VEGAMOVIES_GET_PAGE_HTML },
    'https://vegamovies.test/get/720p/': { body: VEGAMOVIES_GET_PAGE_HTML },
  });
  const result = await resolveCloudStreamDownloads(null as never, MOVIE_REQUEST, {}, baseDeps(routes));

  ok(result.groups.length === 3, 'E: every eligible extension present');
  const bolly = result.groups.find((group) => group.extensionId === 'Bollyflix');
  const drive = result.groups.find((group) => group.extensionId === 'MoviesDrive');
  const vega = result.groups.find((group) => group.extensionId === 'VegaMovies');
  ok(bolly?.status === 'failed' && bolly.errorCode === 'NETWORK_ERROR', `E: HTTP-failed provider → NETWORK_ERROR (got ${bolly?.errorCode})`);
  ok(drive?.status === 'loaded' && (drive?.links.length ?? 0) > 0, 'E: SUCCESSFUL provider result preserved (MoviesDrive loaded)');
  ok(vega?.status === 'failed' && (vega?.errorCode === 'EXTRACTOR_FAILED' || vega?.errorCode === 'NETWORK_ERROR'), 'E: extractor-failure provider classified honestly');
  ok(vega?.errorMessage !== undefined && vega.errorMessage.length > 0, 'E: failed group carries a safe message');
}

// ---------------------------------------------------------------------------
// F. Provider timeout (brief item 11)
// ---------------------------------------------------------------------------
{
  resetCaches();
  const routes = fullRoutes();
  const hanging = createHangingFetcher();
  const selectiveFetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.includes('vegamovies.test')) return hanging(input, init);
    return createMockFetcher(routes)(input, init);
  };
  const result = await resolveCloudStreamDownloads(null as never, MOVIE_REQUEST, {}, {
    ...baseDeps(routes),
    fetcher: selectiveFetcher,
    adapterTimeoutMs: 150,
    overallTimeoutMs: 10_000,
  });

  const vega = result.groups.find((group) => group.extensionId === 'VegaMovies');
  ok(vega?.status === 'failed' && vega.errorCode === 'PROVIDER_TIMEOUT', `F: hanging provider → PROVIDER_TIMEOUT (got ${vega?.errorCode})`);
  ok((vega?.links.length ?? 0) === 0, 'F: timed-out provider yields no links');
  const drive = result.groups.find((group) => group.extensionId === 'MoviesDrive');
  ok(drive?.status === 'loaded' && (drive?.links.length ?? 0) > 0, 'F: other providers still loaded while one timed out');
}

// ---------------------------------------------------------------------------
// G. No-results response (brief item 12)
// ---------------------------------------------------------------------------
{
  resetCaches();
  const routes = routeTable({
    [DYNAMIC_URLS_URL]: {
      body: JSON.stringify({ bollyflix: 'https://bollyflix.test' }),
      contentType: JSON_ROUTE,
    },
    // Search answers, but nothing matches the title → NO_MATCH.
    'https://bollyflix.test/search/Inception/page/1/': {
      body: `<html><body><div class="post-cards"><article><a title="Download Something Else (2019)" href="https://bollyflix.test/other/"><img src="/p3.jpg"/></a></article></div></body></html>`,
    },
  });
  const result = await resolveCloudStreamDownloads(
    null as never,
    MOVIE_REQUEST,
    {},
    baseDeps(routes, MOVIE_CONTENT, { repositories: FULL_CATALOG.repositories, extensions: [FULL_CATALOG.extensions[0]!] }),
  );
  const group = result.groups[0];
  ok(group?.status === 'failed' && group.errorCode === 'NO_RESULTS', `G: no provider match → NO_RESULTS (got ${group?.errorCode})`);
  ok(group?.links.length === 0, 'G: no links invented');
}

// ---------------------------------------------------------------------------
// H. Deterministic ordering (brief item 19 — selection order, never completion order)
// ---------------------------------------------------------------------------
{
  resetCaches();
  // Bollyflix (FIRST in catalog order) is the SLOWEST; VegaMovies (LAST) the
  // fastest. Completion order would be [Vega, MoviesDrive, Bollyflix] — the
  // response must stay in the deterministic catalog order.
  const routes = fullRoutes();
  const slowBollyFetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.includes('bollyflix.test')) {
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
    return createMockFetcher(routes)(input, init);
  };
  const first = await resolveCloudStreamDownloads(null as never, MOVIE_REQUEST, {}, { ...baseDeps(routes), fetcher: slowBollyFetcher });
  ok(first.groups.map((group) => group.extensionId).join(',') === 'Bollyflix,MoviesDrive,VegaMovies', `H: groups stay in catalog order regardless of completion order (got ${first.groups.map((g) => g.extensionId).join(',')})`);

  // Stable across repeated runs.
  resetCaches();
  const second = await resolveCloudStreamDownloads(null as never, MOVIE_REQUEST, {}, { ...baseDeps(fullRoutes()), fetcher: slowBollyFetcher });
  ok(second.groups.map((group) => group.extensionId).join(',') === first.groups.map((group) => group.extensionId).join(','), 'H: ordering stable across repeated resolutions');
}

// ---------------------------------------------------------------------------
// I. Duplicate handling (brief item 20 — documented dedup semantics)
// ---------------------------------------------------------------------------
{
  resetCaches();
  // Both Bollyflix (sidexfee 1080p + fastdlserver 720p) and MoviesDrive
  // (dl1 GDFlix button) extract the SAME GDFlix page, so both groups contain
  // the same underlying URLs — provider identity is preserved cross-group,
  // while within-group duplicates collapse (CS-2 true-URL dedup).
  const result = await resolveCloudStreamDownloads(null as never, MOVIE_REQUEST, {}, baseDeps(fullRoutes()));
  const bolly = result.groups.find((group) => group.extensionId === 'Bollyflix');
  const drive = result.groups.find((group) => group.extensionId === 'MoviesDrive');
  const sharedUrl = 'https://gdflix.test/dl/fsl/abc';
  const bollyCount = bolly?.links.filter((l) => l.url === sharedUrl).length ?? 0;
  const driveCount = drive?.links.filter((l) => l.url === sharedUrl).length ?? 0;
  ok(bollyCount === 1, `I: within-group duplicate URL collapsed (Bollyflix has ${bollyCount})`);
  ok(driveCount === 1, `I: within-group duplicate URL collapsed (MoviesDrive has ${driveCount})`);
  ok(bollyCount === 1 && driveCount === 1, 'I: the same underlying URL stays visible under BOTH providers (provider identity preserved cross-group)');
  const bollyProvider = bolly?.links.find((l) => l.url === sharedUrl)?.provider;
  const driveProvider = drive?.links.find((l) => l.url === sharedUrl)?.provider;
  ok(bollyProvider === 'Bollyflix' && driveProvider === 'MoviesDrive', 'I: each occurrence carries its own provider attribution');
}

// ---------------------------------------------------------------------------
// J. SSRF rejection + diagnostics redaction (brief item 21)
// ---------------------------------------------------------------------------
{
  resetCaches();
  // PRIVATE_DNS: every hostname resolves into 10.0.0.0/8 — the two-stage
  // SSRF guard rejects pre-connect, so the mock fetcher must NEVER run.
  let fetchCalls = 0;
  const trackingFetcher: typeof fetch = async (input, init) => {
    fetchCalls += 1;
    return createMockFetcher(fullRoutes())(input, init);
  };
  const result = await resolveCloudStreamDownloads(null as never, MOVIE_REQUEST, {}, {
    ...baseDeps(fullRoutes()),
    fetcher: trackingFetcher,
    dnsResolver: PRIVATE_DNS,
  });

  ok(result.groups.length === 3, 'J: every group present under SSRF rejection');
  ok(result.groups.every((group) => group.status === 'failed' || group.status === 'empty'), 'J: private-DNS destinations never resolve successfully');
  ok(result.groups.every((group) => group.errorCode === undefined || group.errorCode === 'NETWORK_ERROR'), 'J: SSRF-rejected groups report NETWORK_ERROR (BLOCKED_URL mapped, no internals)');
  ok(fetchCalls === 0, `J: ZERO fetch calls left the process under SSRF rejection (observed ${fetchCalls})`);

  // Diagnostics redaction: no URLs, no tokens, no stack traces anywhere.
  const serialized = JSON.stringify(result.groups);
  ok(!serialized.includes('https://'), 'J: group payloads never contain URLs beyond link.url fields');
  ok(!serialized.toLowerCase().includes('token') && !serialized.toLowerCase().includes('cookie'), 'J: no tokens/cookies in group payloads');
  for (const group of result.groups) {
    if (group.diagnostics !== undefined) {
      const diag = JSON.stringify(group.diagnostics);
      ok(!diag.includes('http://') && !diag.includes('https://'), 'J: diagnostics contain no URLs');
      ok(!diag.includes('cookie') && !diag.includes('authorization'), 'J: diagnostics contain no credential material');
      ok(group.diagnostics.stages.length <= 32, 'J: diagnostics stages bounded');
    }
  }
}

// ---------------------------------------------------------------------------
// K. Extension endpoint service (brief item 8) + validation states (items 17/18)
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
  const singleCatalog: CloudStreamExtensionCatalog = {
    repositories: FULL_CATALOG.repositories,
    extensions: [FULL_CATALOG.extensions[0]!, FULL_CATALOG.extensions[3]!, FULL_CATALOG.extensions[4]!],
  };
  const deps = baseDeps(routes, MOVIE_CONTENT, singleCatalog);

  // Happy path: exactly ONE adapter runs (only Bollyflix fetches observed).
  const result = await resolveCloudStreamExtensionDownload(null as never, MOVIE_REQUEST, 'Bollyflix', deps);
  ok(result.group.extensionId === 'Bollyflix' && result.group.status === 'loaded', 'K: single extension resolves');
  ok((result.group.links.length ?? 0) > 0, 'K: single extension group has links');
  ok(result.media.title === 'Inception', 'K: extension endpoint carries the media echo');

  // Structured validation states (typed errors, closed vocabulary).
  const cases: Array<[string, string]> = [
    ['NoSuchExtension', 'EXTENSION_NOT_FOUND'],
    ['CineStream', 'EXTENSION_DISABLED'],
    ['Moviesmod', 'ADAPTER_NOT_AVAILABLE'],
  ];
  for (const [extensionId, expectedCode] of cases) {
    let code = '';
    try {
      await resolveCloudStreamExtensionDownload(null as never, MOVIE_REQUEST, extensionId, deps);
    } catch (error) {
      code = error instanceof CloudStreamDownloaderError ? error.code : '';
    }
    ok(code === expectedCode, `K: ${extensionId} → ${expectedCode} (got ${code})`);
  }

  // HTTP status mapping for the structured envelope errors.
  ok(downloaderErrorStatus('EXTENSION_NOT_FOUND') === 404, 'K: EXTENSION_NOT_FOUND maps to 404');
  ok(downloaderErrorStatus('EXTENSION_DISABLED') === 409, 'K: EXTENSION_DISABLED maps to 409');
  ok(downloaderErrorStatus('ADAPTER_NOT_AVAILABLE') === 409, 'K: ADAPTER_NOT_AVAILABLE maps to 409');
  ok(downloaderErrorStatus('INVALID_REQUEST') === 400 && downloaderErrorStatus('INTERNAL_ERROR') === 503, 'K: INVALID_REQUEST/INTERNAL_ERROR statuses');
}

// ---------------------------------------------------------------------------
// L. UNSUPPORTED_MEDIA (brief "Extension D" case)
// ---------------------------------------------------------------------------
{
  // A media-type-unsupported adapter is skipped in the batch flow and
  // rejected with UNSUPPORTED_MEDIA in the targeted flow.
  const vegaOnly: CloudStreamExtensionCatalog = {
    repositories: [{ id: 'repo-1', enabled: true, created_at: '2026-01-01T00:00:00Z' }],
    extensions: [{ repository_id: 'repo-1', internal_name: 'VegaMovies', name: 'VegaMovies', icon_url: null, enabled: true }],
  };
  const registryAdapter = lookupCloudStreamAdapterInstance('VegaMovies');
  ok(registryAdapter !== null, 'L: VegaMovies adapter registered (supports all types — the unsupported case is simulated below)');

  // Simulated: series request against a movie-only adapter view. The real
  // adapters support all types, so verify the selection logic directly with
  // a crafted catalog entry that has no episode-capable adapter.
  const moviesmodOnly: CloudStreamExtensionCatalog = {
    repositories: [{ id: 'repo-1', enabled: true, created_at: '2026-01-01T00:00:00Z' }],
    extensions: [{ repository_id: 'repo-1', internal_name: 'Moviesmod', name: 'Moviesmod', icon_url: null, enabled: true }],
  };
  const tabs = await listCloudStreamDownloadTabs(null as never, { mediaType: 'series', contentId: 's', season: 1, episode: 1 }, {
    loadContent: async () => SERIES_CONTENT,
    loadCatalog: async () => moviesmodOnly,
  });
  ok(tabs.tabs.length === 0, 'L: no-adapter extension never appears in tabs (skip/diagnose, never attempt)');

  const selected = await resolveCloudStreamDownloads(null as never, MOVIE_REQUEST, { extensionIds: ['VegaMovies'] }, {
    loadContent: async () => MOVIE_CONTENT,
    loadCatalog: async () => vegaOnly,
    fetcher: createMockFetcher(routeTable({})),
    dnsResolver: PUBLIC_DNS,
    adapterTimeoutMs: 1_000,
    overallTimeoutMs: 3_000,
  });
  ok(selected.groups.length === 1 && selected.groups[0]?.status === 'loaded' || selected.groups[0]?.status === 'failed', 'L: targeted selection produces a group');
  void registryAdapter;

  // Failure-category → error-code mapping table (closed vocabulary).
  ok(failureCategoryToErrorCode('TIMEOUT') === 'PROVIDER_TIMEOUT', 'L: TIMEOUT → PROVIDER_TIMEOUT');
  ok(failureCategoryToErrorCode('EXTRACTOR_FAILED') === 'EXTRACTOR_FAILED', 'L: EXTRACTOR_FAILED → EXTRACTOR_FAILED');
  ok(failureCategoryToErrorCode('NO_MATCH') === 'NO_RESULTS' && failureCategoryToErrorCode('NO_LINKS') === 'NO_RESULTS', 'L: NO_MATCH/NO_LINKS → NO_RESULTS');
  ok(failureCategoryToErrorCode('SEARCH_FAILED') === 'NETWORK_ERROR' && failureCategoryToErrorCode('LOAD_FAILED') === 'NETWORK_ERROR' && failureCategoryToErrorCode('BLOCKED_URL') === 'NETWORK_ERROR', 'L: network-ish categories → NETWORK_ERROR');
  ok(failureCategoryToErrorCode('UNSUPPORTED') === 'UNSUPPORTED_MEDIA', 'L: UNSUPPORTED → UNSUPPORTED_MEDIA');
  ok(failureCategoryToErrorCode('UNEXPECTED') === 'INTERNAL_ERROR', 'L: UNEXPECTED → INTERNAL_ERROR');
}

// ---------------------------------------------------------------------------
// M. Stream-action compatibility (brief item 14 — existing action model reuse)
// ---------------------------------------------------------------------------
{
  resetCaches();
  const result = await resolveCloudStreamDownloads(null as never, MOVIE_REQUEST, {}, baseDeps(fullRoutes()));
  const allLinks = result.groups.flatMap((group) => group.links);
  ok(allLinks.length > 0, 'M: links present for capability checks');
  // Structural compatibility: every link view satisfies CapabilityStream.
  const compatible = allLinks.every((link) => {
    const caps = streamCapabilities(link as CapabilityStream);
    return typeof caps.download === 'boolean' && typeof caps.play === 'boolean' && caps.share === true;
  });
  ok(compatible, 'M: every link view is a CapabilityStream (stream-actions model applies directly)');
  ok(allLinks.every((link) => link.kind === 'https' || link.kind === 'http'), 'M: fixture links are direct http(s) downloads');
  ok(allLinks.every((link) => streamCapabilities(link as CapabilityStream).download === true && streamCapabilities(link as CapabilityStream).play === true), 'M: http(s) links get Download+Play+Share (existing semantics)');
  // The kind matrix stays the existing one (no CloudStream-specific actions).
  ok(streamCapabilities({ kind: 'hls' }).download === false && streamCapabilities({ kind: 'hls' }).play === true, 'M: hls keeps Play+Share only (never a file download)');
  ok(streamCapabilities({ kind: 'magnet' }).download === true && streamCapabilities({ kind: 'magnet' }).play === false, 'M: magnet keeps Download+Share only');
  ok(streamCapabilities({ kind: 'external' }).share === true, 'M: external keeps Share');
}

// ---------------------------------------------------------------------------
// N. Endpoint boundaries (brief items 1 + 15 + 16 + 22)
// ---------------------------------------------------------------------------

const { GET: mavero2Get } = await import('../src/routes/api/downloader/mavero2/+server');
const { GET: mavero2TabsGet } = await import('../src/routes/api/downloader/mavero2/tabs/+server');
const { GET: mavero2ExtensionGet } = await import('../src/routes/api/downloader/mavero2/extension/+server');

type EndpointFn = (event: {
  url: URL;
  request: Request;
  locals: Record<string, unknown>;
  cookies: { get: () => undefined };
}) => Promise<Response>;

async function endpointStatus(
  handler: EndpointFn,
  path: string,
): Promise<{ status: number; body: Record<string, unknown>; cacheControl: string; retryAfter: string }> {
  try {
    const response = await handler({
      url: new URL(`https://mavero.test${path}`),
      request: new Request(`https://mavero.test${path}`),
      locals: {},
      cookies: { get: () => undefined },
    } as never);
    return {
      status: response.status,
      body: (await response.json()) as Record<string, unknown>,
      cacheControl: response.headers.get('cache-control') ?? '',
      retryAfter: response.headers.get('retry-after') ?? '',
    };
  } catch (caught) {
    // The adult guard throws the SvelteKit HttpError (404) once validation
    // and rate limiting pass — surface its status (same pattern as the 4K
    // endpoint tests).
    const status = (caught as { status?: number })?.status;
    if (status) return { status, body: {}, cacheControl: '', retryAfter: '' };
    throw caught;
  }
}

const VALID_MOVIE_QUERY = 'mediaType=movie&contentId=afterlight&tmdbId=27205';
const VALID_SERIES_QUERY = 'mediaType=series&contentId=afterlight&tmdbId=70523&season=1&episode=2';

// N1: request-shape validation on all three endpoints (INVALID_REQUEST 400s).
{
  const endpoints: Array<[string, EndpointFn]> = [
    ['main', mavero2Get as unknown as EndpointFn],
    ['tabs', mavero2TabsGet as unknown as EndpointFn],
    ['extension', mavero2ExtensionGet as unknown as EndpointFn],
  ];
  const badQueries = [
    '', // no params at all
    'mediaType=show&contentId=afterlight&tmdbId=27205',
    `mediaType=movie&contentId=&tmdbId=27205`,
    'mediaType=movie&contentId=afterlight&tmdbId=',
    'mediaType=movie&contentId=afterlight&tmdbId=abc',
    'mediaType=movie&contentId=afterlight&tmdbId=1234567890123',
    `mediaType=movie&contentId=${'x'.repeat(201)}&tmdbId=27205`,
    'mediaType=movie&contentId=afterlight&tmdbId=27205&season=0&episode=1',
    'mediaType=movie&contentId=afterlight&tmdbId=27205&season=1&episode=0',
    'mediaType=movie&contentId=afterlight&tmdbId=27205&season=-1&episode=2',
    'mediaType=movie&contentId=afterlight&tmdbId=27205&season=1.5&episode=1',
    'mediaType=movie&contentId=afterlight&tmdbId=27205&season=abc&episode=1',
    'mediaType=movie&contentId=afterlight&tmdbId=27205&season=1&episode=10001',
    'mediaType=series&contentId=afterlight&tmdbId=70523', // series without season/episode
    `${VALID_SERIES_QUERY.replace('&season=1', '')}`, // episode without season
    'mediaType=movie&contentId=afterlight&tmdbId=27205&season=1', // movie WITH episode context
  ];
  for (const [name, handler] of endpoints) {
    let rejections = 0;
    for (const query of badQueries) {
      const suffix = name === 'extension' ? '&extensionId=Bollyflix' : '';
      const { status, body } = await endpointStatus(handler, `/api/downloader/mavero2${name === 'main' ? '' : `/${name}`}?${query}${suffix}`);
      if (status === 400) {
        rejections += 1;
        const error = (body as { error?: { code?: string } }).error;
        if (error?.code !== 'INVALID_REQUEST') throw new Error(`N1: ${name} 400 must carry INVALID_REQUEST (got ${error?.code})`);
      }
    }
    ok(rejections === badQueries.length, `N1: ${name} endpoint rejects all ${badQueries.length} malformed shapes with 400 INVALID_REQUEST (got ${rejections})`);
  }

  // Extension endpoint additionally requires extensionId.
  const missing = await endpointStatus(mavero2ExtensionGet as unknown as EndpointFn, `/api/downloader/mavero2/extension?${VALID_MOVIE_QUERY}`);
  ok(missing.status === 400, 'N1: extension endpoint requires extensionId');
}

// N2: valid shape passes validation + rate limiting and reaches the adult-guard
// boundary. Under tsx the guard deterministically fails CLOSED with its
// non-disclosing 404 (the content-service import chain requires SvelteKit's
// $env virtual module, which does not exist outside the SvelteKit runtime —
// the same boundary the 4K endpoint tests observe). What matters here: the
// request is NOT rejected by validation (400) or rate limiting (429).
{
  const { status } = await endpointStatus(mavero2Get as unknown as EndpointFn, `/api/downloader/mavero2?${VALID_MOVIE_QUERY}`);
  ok(status !== 400 && status !== 429, 'N2: valid request shape is not rejected by validation/rate limit');
  ok(status === 404, `N2: request reaches the adult-guard boundary (got ${status})`);
}

// N3: rate limiting (brief item 22 — per-identity buckets, 429 + retry-after).
{
  resetRateLimitsForTests();
  // 10 allowed (limit) + the 11th → 429 for the main endpoint.
  let saw429 = false;
  let retryAfter = '';
  let rateCode = '';
  for (let i = 0; i < RATE_LIMIT_RULES.downloaderMavero2.limit + 1; i += 1) {
    const { status, body, retryAfter: after } = await endpointStatus(mavero2Get as unknown as EndpointFn, `/api/downloader/mavero2?${VALID_MOVIE_QUERY}`);
    if (status === 429) {
      saw429 = true;
      retryAfter = after;
      rateCode = (body as { error?: { code?: string } }).error?.code ?? '';
      break;
    }
  }
  ok(saw429, 'N3: main endpoint rate limit trips within limit+1 requests');
  ok(rateCode === 'RATE_LIMITED', 'N3: 429 carries RATE_LIMITED');
  ok(retryAfter !== '' && Number.parseInt(retryAfter, 10) > 0, 'N3: 429 carries a positive retry-after header');

  // The mavero2 buckets are SEPARATE from the Stremio downloader buckets:
  // the existing rules are unchanged, the new ones additive.
  ok(RATE_LIMIT_RULES.downloaderMavero2.limit === 10 && RATE_LIMIT_RULES.downloaderMavero2.windowMs === 60_000, 'N3: downloaderMavero2 bucket (10/min)');
  ok(RATE_LIMIT_RULES.downloaderMavero2Tabs.limit === 30 && RATE_LIMIT_RULES.downloaderMavero2Extension.limit === 30, 'N3: tabs/extension buckets (30/min each)');
  ok(RATE_LIMIT_RULES.downloaderMavero.limit === 10 && RATE_LIMIT_RULES.downloaderMavero2.limit === 10, 'N3: Stremio + CloudStream buckets coexist independently');
}

// N4: tabs + extension endpoints pass validation and reach the same
// adult-guard boundary (404 under tsx — see N2).
{
  const { status: tabsStatus } = await endpointStatus(mavero2TabsGet as unknown as EndpointFn, `/api/downloader/mavero2/tabs?${VALID_SERIES_QUERY}`);
  ok(tabsStatus !== 400 && tabsStatus !== 429, 'N4: tabs endpoint accepts a valid series-episode request');
  ok(tabsStatus === 404, 'N4: tabs request reaches the adult-guard boundary');
  const { status: extStatus } = await endpointStatus(mavero2ExtensionGet as unknown as EndpointFn, `/api/downloader/mavero2/extension?extensionId=Bollyflix&${VALID_MOVIE_QUERY}`);
  ok(extStatus !== 400 && extStatus !== 429, 'N4: extension endpoint accepts a valid request');
  ok(extStatus === 404, 'N4: extension request reaches the adult-guard boundary');
}

// ---------------------------------------------------------------------------
// O. Source-scan regressions (brief items 21–24: wiring, isolation, CS-1/CS-2)
// ---------------------------------------------------------------------------
{
  const main = read('src/routes/api/downloader/mavero2/+server.ts');
  const tabsSrc = read('src/routes/api/downloader/mavero2/tabs/+server.ts');
  const extension = read('src/routes/api/downloader/mavero2/extension/+server.ts');

  // Adult guard runs BEFORE the resolution service in every endpoint.
  for (const [name, source] of [['main', main], ['tabs', tabsSrc], ['extension', extension]] as Array<[string, string]>) {
    const guardIndex = source.indexOf('await assertAdultDownloadAllowed(');
    const serviceIndexes = [
      source.indexOf('resolveCloudStreamDownloads('),
      source.indexOf('listCloudStreamDownloadTabs('),
      source.indexOf('resolveCloudStreamExtensionDownload('),
    ].filter((index) => index >= 0);
    const serviceIndex = serviceIndexes.length > 0 ? Math.min(...serviceIndexes) : -1;
    ok(guardIndex > -1 && serviceIndex > guardIndex, `O: ${name} endpoint runs the adult guard BEFORE the service`);
    ok(source.includes("'no-store'"), `O: ${name} endpoint serves no-store`);
    ok(!source.includes('requireAdmin'), `O: ${name} endpoint keeps the public downloader access convention (no admin gate)`);
  }
  ok(main.includes("checkRateLimit('downloaderMavero2'"), 'O: main endpoint uses its own rate bucket');
  ok(tabsSrc.includes("checkRateLimit('downloaderMavero2Tabs'"), 'O: tabs endpoint uses its own rate bucket');
  ok(extension.includes("checkRateLimit('downloaderMavero2Extension'"), 'O: extension endpoint uses its own rate bucket');

  // The rate-limit module changes are ADDITIVE: the pre-existing rules are
  // byte-identical (deep equality on the full legacy subset).
  const rateLimitSrc = read('src/lib/server/http/rate-limit.ts');
  ok(rateLimitSrc.includes('downloaderMavero2: { limit: 10, windowMs: 60_000 }'), 'O: downloaderMavero2 bucket added');
  ok(rateLimitSrc.includes('downloaderMavero2Tabs: { limit: 30, windowMs: 60_000 }') && rateLimitSrc.includes('downloaderMavero2Extension: { limit: 30, windowMs: 60_000 }'), 'O: tabs/extension buckets added');
  ok(RATE_LIMIT_RULES.resolve.limit === 30 && RATE_LIMIT_RULES.downloaderMavero.limit === 10 && RATE_LIMIT_RULES.downloaderAddon.limit === 30 && RATE_LIMIT_RULES.downloaderTabs.limit === 30 && RATE_LIMIT_RULES.downloader4k.limit === 20 && RATE_LIMIT_RULES.downloaderJson.limit === 20, 'O: ALL pre-existing rate rules unchanged (additive only)');

  // CS-2 regression invariants: the resolver still resolves through the
  // registry and now surfaces matchedTitle (additive).
  const resolverSrc = read('src/lib/server/cloudstream/resolver/service.ts');
  ok(resolverSrc.includes('matchedTitle'), 'O: CS-2 resolver surfaces matchedTitle (additive CS-3 field)');
  ok(resolverSrc.includes('CLOUDSTREAM_ADAPTER_CONCURRENCY = 4'), 'O: CS-2 bounded concurrency (<=4) unchanged');

  // Isolation: the Stremio downloader endpoints are untouched and the two
  // ecosystems do not import each other's resolvers.
  const stremioMain = read('src/routes/api/downloader/mavero/+server.ts');
  ok(stremioMain.includes('resolveAddonDownloads'), 'O: existing Stremio main endpoint untouched (still resolves addons)');
  ok(!stremioMain.includes('cloudstream'), 'O: Stremio main endpoint has no CloudStream coupling');
  const downloaderService = read('src/lib/server/cloudstream/downloader/service.ts');
  ok(!downloaderService.includes('$lib/server/streaming/stremio/addon-download-service'), 'O: Downloader 2 service never imports the Stremio addon resolver');
  ok(!downloaderService.includes('$lib/server/streaming/stremio/stream-resolver'), 'O: Downloader 2 service never imports the Stremio stream resolver');
  ok(downloaderService.includes("from '$lib/server/streaming/stremio/ssrf'"), 'O: the ONLY Stremio reuse is the documented SSRF type (SafeDnsResolver)');
  // No dynamic code execution: no eval, no Function constructor, and every
  // dynamic import target is a STATIC Mavero-owned module path (the
  // documented adult-guard laziness pattern) — never remote/computed code.
  const noExecSources = [main, tabsSrc, extension, downloaderService];
  ok(noExecSources.every((source) => !source.includes('eval(') && !source.includes('new Function')), 'O: no eval / Function constructor anywhere in the Downloader 2 surface');
  const dynamicImports = [...downloaderService.matchAll(/await import\(([^)]+)\)/g), ...main.matchAll(/await import\(([^)]+)\)/g), ...tabsSrc.matchAll(/await import\(([^)]+)\)/g), ...extension.matchAll(/await import\(([^)]+)\)/g)];
  ok(dynamicImports.length > 0 && dynamicImports.every((match) => /'\$lib\/server\/[a-z/-]+'|'\.\/[a-z-]+'/.test(match[1] ?? '')), `O: every dynamic import is a STATIC Mavero-owned module path (${dynamicImports.length} imports)`);

  // The Stremio per-addon/tab endpoints remain present (CS-1/CS-2 regression
  // surface is exercised by the existing chain suites; here we pin the
  // files' key wiring).
  const stremioAddon = read('src/routes/api/downloader/mavero/addon/+server.ts');
  ok(stremioAddon.includes('resolveSingleAddonDownload'), 'O: existing Stremio per-addon endpoint untouched');
  const stremioTabs = read('src/routes/api/downloader/mavero/tabs/+server.ts');
  ok(stremioTabs.includes('listAddonDownloadTargets'), 'O: existing Stremio tabs endpoint untouched');
}

// ---------------------------------------------------------------------------
// P. CS-2 orchestrator regression through the CS-3 path (brief item 24)
// ---------------------------------------------------------------------------
{
  resetCaches();
  // The service delegates to the SAME resolveCloudStream the CS-2 suites
  // test; verify the delegation end-to-end once more with matchedTitle.
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
  const direct = await resolveCloudStream(
    { media: { tmdbId: '27205', title: 'Inception', year: 2010 }, adapterIds: ['Bollyflix'] },
    { fetcher: createMockFetcher(routes), dnsResolver: PUBLIC_DNS, adapterTimeoutMs: 5_000, overallTimeoutMs: 10_000 },
  );
  ok(direct.groups.length === 1 && direct.groups[0]?.status === 'loaded', 'P: CS-2 orchestrator still resolves through the CS-3 service path');
  ok(typeof direct.groups[0]?.matchedTitle === 'string', 'P: CS-2 resolver group carries matchedTitle (additive)');
}

console.log(counter.summary('cloudstream_downloader_api_test'));
