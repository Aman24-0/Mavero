import assert from 'node:assert/strict';
import { resolveCloudStream, CLOUDSTREAM_ADAPTER_CONCURRENCY, CLOUDSTREAM_ADAPTER_TIMEOUT_MS, CLOUDSTREAM_RESOLUTION_TIMEOUT_MS } from '$lib/server/cloudstream/resolver/service';
import { fetchCloudStreamJson } from '$lib/server/cloudstream/security/fetch';
import { settleCloudStreamLoadingTabs, cloudStreamTabsLoading, type CloudStreamSourceTab } from '$lib/shared/cloudstream-download-view';
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

/**
 * Permanent Adapter Plan — Phase 1 suite: deadline propagation, bounded
 * execution, cancellation, failure isolation, and UI loading-state
 * termination for Mavero Downloader 2.
 *
 * Covers the Phase 1 root causes fixed in this phase:
 *   RC-1  fetchJson AbortSignal propagation (adapter deadline reaches JSON
 *         fetches — previously only the internal 10s cap applied),
 *   RC-2  resolveBaseUrl/urls.json deadline awareness,
 *   RC-3  per-adapter deadline as a PROMISE RACE (the worker settles even
 *         when adapter code never observes the signal),
 *   RC-5  external (client-disconnect) signal cancellation,
 *   UI    still-loading tabs always settle (no infinite spinners).
 *
 * Deterministic: mock fetchers only — the suite never touches the real
 * network. Elapsed-time assertions use generous upper bounds (2s) against
 * the pre-fix behavior (10s+ per hanging fetch), so they are stable on
 * slow CI machines while still proving deadline enforcement.
 */

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

/** A fetcher that NEVER settles and IGNORES signals (worst-case adapter code). */
function createNeverResolvingFetcher(): typeof fetch {
  return () => new Promise<Response>(() => {
    // No resolution path and no signal handling — the adapter promise can
    // never settle on its own. Only the Phase 1 deadline RACE terminates it.
  });
}

// ---------------------------------------------------------------------------
// A. Budget contract pins (the plan's documented limits are the code's limits)
// ---------------------------------------------------------------------------
{
  ok(CLOUDSTREAM_ADAPTER_TIMEOUT_MS === 30_000, 'A: per-adapter budget is 30s (plan §3)');
  ok(CLOUDSTREAM_RESOLUTION_TIMEOUT_MS === 40_000, 'A: overall budget is 40s (plan §3)');
  ok(CLOUDSTREAM_ADAPTER_CONCURRENCY === 4, 'A: bounded concurrency is 4 (plan §3)');
}

// ---------------------------------------------------------------------------
// B. Success path anchor (providers still resolve after the Phase 1 changes)
// ---------------------------------------------------------------------------
{
  resetCaches();
  const started = Date.now();
  const result = await resolveCloudStream(
    { media: BASE_MEDIA, adapterIds: ['Bollyflix', 'MoviesDrive', 'VegaMovies'] },
    { fetcher: createMockFetcher(fullRoutes()), dnsResolver: PUBLIC_DNS, adapterTimeoutMs: 5_000, overallTimeoutMs: 10_000 },
  );
  ok(result.groups.length === 3, 'B: one group per adapter');
  ok(result.groups.every((g) => g.status === 'loaded' && g.links.length > 0), 'B: all providers resolve with links');
  ok(Date.now() - started < 2_000, 'B: healthy resolution is fast');
}

// ---------------------------------------------------------------------------
// C. RC-1 — hanging JSON fetch is bounded by the ADAPTER deadline (not 10s)
// ---------------------------------------------------------------------------
{
  resetCaches();
  const routes = fullRoutes();
  const hanging = createHangingFetcher();
  const selectiveFetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    // ONLY the VegaMovies search.php JSON endpoint hangs.
    if (url.includes('vegamovies.test/search.php')) return hanging(input, init);
    return createMockFetcher(routes)(input, init);
  };
  const started = Date.now();
  const result = await resolveCloudStream(
    { media: BASE_MEDIA, adapterIds: ['Bollyflix', 'VegaMovies', 'MoviesDrive'] },
    { fetcher: selectiveFetcher, dnsResolver: PUBLIC_DNS, adapterTimeoutMs: 150, overallTimeoutMs: 10_000 },
  );
  const elapsed = Date.now() - started;
  const vega = result.groups.find((g) => g.adapterId === 'VegaMovies');
  ok(vega?.status === 'failed', 'C: hanging JSON provider marked failed');
  ok(vega?.failure?.category === 'TIMEOUT', `C: failure category is TIMEOUT (got ${vega?.failure?.category})`);
  ok(elapsed < 2_000, `C: adapter deadline ends the JSON hang in <2s (took ${elapsed}ms; pre-fix ~10s)`);
  const bolly = result.groups.find((g) => g.adapterId === 'Bollyflix');
  const drive = result.groups.find((g) => g.adapterId === 'MoviesDrive');
  ok(bolly?.status === 'loaded' && (bolly?.links.length ?? 0) > 0, 'C: partial results preserved (Bollyflix)');
  ok(drive?.status === 'loaded' && (drive?.links.length ?? 0) > 0, 'C: partial results preserved (MoviesDrive)');
}

// ---------------------------------------------------------------------------
// D. RC-1 unit — fetchCloudStreamJson aborts on the EXTERNAL signal
// ---------------------------------------------------------------------------
{
  resetCaches();
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 100);
  const started = Date.now();
  let timedOut = false;
  try {
    await fetchCloudStreamJson('https://example.test/doc.json', {
      fetcher: createHangingFetcher(),
      dnsResolver: PUBLIC_DNS,
      signal: controller.signal,
    });
  } catch (error) {
    timedOut = (error as { code?: string }).code === 'TIMEOUT';
  }
  const elapsed = Date.now() - started;
  ok(timedOut, 'D: external signal abort → TIMEOUT error code');
  ok(elapsed < 2_000, `D: external signal ends the JSON fetch in <2s (took ${elapsed}ms; pre-fix ~10s)`);
}

// ---------------------------------------------------------------------------
// E. RC-2 — hanging urls.json is bounded by the adapter deadline
// ---------------------------------------------------------------------------
{
  resetCaches();
  const routes = fullRoutes();
  const hanging = createHangingFetcher();
  const selectiveFetcher: typeof fetch = async (input, init) => {
    if (String(input) === DYNAMIC_URLS_URL) return hanging(input, init);
    return createMockFetcher(routes)(input, init);
  };
  const started = Date.now();
  const result = await resolveCloudStream(
    { media: BASE_MEDIA, adapterIds: ['Bollyflix'] },
    { fetcher: selectiveFetcher, dnsResolver: PUBLIC_DNS, adapterTimeoutMs: 150, overallTimeoutMs: 10_000 },
  );
  const elapsed = Date.now() - started;
  // urls.json hangs → the deadline aborts it → the fallback base is used →
  // every subsequent fetch on the ALREADY-aborted signal fails instantly →
  // the group is a bounded failure, never a 10s stall.
  const group = result.groups.find((g) => g.adapterId === 'Bollyflix');
  ok(group !== undefined && group.status === 'failed', 'E: hanging urls.json yields a bounded failed group');
  ok(elapsed < 2_000, `E: urls.json hang ends at the adapter deadline in <2s (took ${elapsed}ms; pre-fix ~10s)`);
}

// ---------------------------------------------------------------------------
// F. RC-3 — never-resolving adapter (signal-ignoring fetcher) still terminates
// ---------------------------------------------------------------------------
{
  resetCaches();
  const started = Date.now();
  const result = await resolveCloudStream(
    { media: BASE_MEDIA, adapterIds: ['Bollyflix', 'MoviesDrive', 'VegaMovies'] },
    { fetcher: createNeverResolvingFetcher(), dnsResolver: PUBLIC_DNS, adapterTimeoutMs: 150, overallTimeoutMs: 10_000 },
  );
  const elapsed = Date.now() - started;
  ok(result.groups.length === 3, 'F: every adapter produces a group');
  ok(result.groups.every((g) => g.status === 'failed'), 'F: never-resolving adapters → failed groups');
  ok(result.groups.every((g) => g.failure?.category === 'TIMEOUT'), 'F: failure category is TIMEOUT (deadline race)');
  ok(elapsed < 2_000, `F: the deadline RACE terminates the request in <2s (took ${elapsed}ms; pre-fix: hung forever)`);
}

// ---------------------------------------------------------------------------
// G. RC-5 — external (client-disconnect) signal cancels the resolution
// ---------------------------------------------------------------------------
{
  resetCaches();
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 100);
  const started = Date.now();
  const result = await resolveCloudStream(
    { media: BASE_MEDIA, adapterIds: ['Bollyflix', 'VegaMovies'] },
    { fetcher: createHangingFetcher(), dnsResolver: PUBLIC_DNS, adapterTimeoutMs: 30_000, overallTimeoutMs: 40_000, signal: controller.signal },
  );
  const elapsed = Date.now() - started;
  ok(result.groups.every((g) => g.failure?.category === 'TIMEOUT'), 'G: client-disconnect abort → TIMEOUT groups');
  ok(elapsed < 2_000, `G: external cancellation ends the request in <2s (took ${elapsed}ms; pre-fix: full 30s/40s budgets)`);
}

// ---------------------------------------------------------------------------
// H. Pre-aborted external signal → immediate bounded failure
// ---------------------------------------------------------------------------
{
  resetCaches();
  const controller = new AbortController();
  controller.abort();
  const started = Date.now();
  const result = await resolveCloudStream(
    { media: BASE_MEDIA, adapterIds: ['Bollyflix'] },
    { fetcher: createHangingFetcher(), dnsResolver: PUBLIC_DNS, adapterTimeoutMs: 30_000, overallTimeoutMs: 40_000, signal: controller.signal },
  );
  ok(result.groups.every((g) => g.failure?.category === 'TIMEOUT'), 'H: pre-aborted signal → immediate TIMEOUT group');
  ok(Date.now() - started < 500, 'H: pre-aborted request settles near-instantly');
}

// ---------------------------------------------------------------------------
// I. Overall budget clamps a longer per-adapter budget
// ---------------------------------------------------------------------------
{
  resetCaches();
  const started = Date.now();
  const result = await resolveCloudStream(
    { media: BASE_MEDIA, adapterIds: ['Bollyflix', 'VegaMovies', 'MoviesDrive'] },
    { fetcher: createHangingFetcher(), dnsResolver: PUBLIC_DNS, adapterTimeoutMs: 5_000, overallTimeoutMs: 300 },
  );
  const elapsed = Date.now() - started;
  ok(result.groups.every((g) => g.failure?.category === 'TIMEOUT'), 'I: overall deadline wins over the per-adapter budget');
  ok(elapsed < 2_000, `I: overall budget ends the request in <2s (took ${elapsed}ms; the 5s adapter budget never ran)`);
}

// ---------------------------------------------------------------------------
// J. Hanging extractor is deadline-bound and isolated
// ---------------------------------------------------------------------------
{
  resetCaches();
  const routes = fullRoutes();
  const hanging = createHangingFetcher();
  const selectiveFetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    // ONLY the HubCloud page fetch hangs (MoviesDrive's extractor).
    if (url.includes('hubcloud.test/dl/')) return hanging(input, init);
    return createMockFetcher(routes)(input, init);
  };
  const started = Date.now();
  const result = await resolveCloudStream(
    { media: BASE_MEDIA, adapterIds: ['Bollyflix', 'MoviesDrive'] },
    { fetcher: selectiveFetcher, dnsResolver: PUBLIC_DNS, adapterTimeoutMs: 1_500, overallTimeoutMs: 10_000 },
  );
  const elapsed = Date.now() - started;
  const bolly = result.groups.find((g) => g.adapterId === 'Bollyflix');
  const drive = result.groups.find((g) => g.adapterId === 'MoviesDrive');
  ok(bolly?.status === 'loaded' && (bolly?.links.length ?? 0) > 0, 'J: Bollyflix unaffected by the hanging extractor');
  // The hanging HubCloud page is bounded by the ADAPTER deadline (1.5s),
  // well under its own 10s page cap — and the failure is isolated.
  ok(drive !== undefined, 'J: MoviesDrive group present (failure isolated)');
  ok(drive?.status === 'failed' || drive?.status === 'empty', `J: extractor-failure provider classified honestly (got ${drive?.status})`);
  ok(elapsed < 4_000, `J: hanging extractor bounded by the adapter deadline, not the 10s page cap (took ${elapsed}ms)`);
}

// ---------------------------------------------------------------------------
// K. Concurrent requests are isolated (no cross-request cancellation)
// ---------------------------------------------------------------------------
{
  resetCaches();
  const hanging = createHangingFetcher();
  const p1 = resolveCloudStream(
    { media: BASE_MEDIA, adapterIds: ['Bollyflix'] },
    { fetcher: hanging, dnsResolver: PUBLIC_DNS, adapterTimeoutMs: 200, overallTimeoutMs: 1_000 },
  );
  const p2 = resolveCloudStream(
    // Distinct media identity (different tmdbId) — same fixture title.
    { media: { tmdbId: '999', title: BASE_MEDIA.title, year: BASE_MEDIA.year }, adapterIds: ['MoviesDrive'] },
    { fetcher: createMockFetcher(fullRoutes()), dnsResolver: PUBLIC_DNS, adapterTimeoutMs: 5_000, overallTimeoutMs: 10_000 },
  );
  const [r1, r2] = await Promise.all([p1, p2]);
  ok(r1.groups[0]?.failure?.category === 'TIMEOUT', 'K: hanging request times out on its own budget');
  ok(r2.groups[0]?.status === 'loaded' && (r2.groups[0]?.links.length ?? 0) > 0, 'K: concurrent healthy request unaffected (no AbortController sharing)');
  ok(r2.groups[0]?.adapterId === 'MoviesDrive' && r1.groups[0]?.adapterId === 'Bollyflix', 'K: results are not cross-contaminated');
}

// ---------------------------------------------------------------------------
// L. Malformed JSON response → controlled failure (not a hang/crash)
// ---------------------------------------------------------------------------
{
  resetCaches();
  const routes = routeTable({
    [DYNAMIC_URLS_URL]: {
      body: JSON.stringify({ vegamovies: 'https://vegamovies.test' }),
      contentType: JSON_ROUTE,
    },
    // The search endpoint returns HTML where JSON was promised.
    'https://vegamovies.test/search.php?q=Inception&page=1': { body: '<html>not json</html>', contentType: 'text/html' },
  });
  const result = await resolveCloudStream(
    { media: BASE_MEDIA, adapterIds: ['VegaMovies'] },
    { fetcher: createMockFetcher(routes), dnsResolver: PUBLIC_DNS, adapterTimeoutMs: 5_000, overallTimeoutMs: 10_000 },
  );
  const vega = result.groups.find((g) => g.adapterId === 'VegaMovies');
  ok(vega?.status === 'failed', 'L: malformed JSON response → failed group');
  ok(vega?.failure?.category === 'LOAD_FAILED', `L: malformed JSON classified as LOAD_FAILED (got ${vega?.failure?.category})`);
}

// ---------------------------------------------------------------------------
// M. UI — still-loading tabs always settle (no infinite spinners)
// ---------------------------------------------------------------------------
{
  const tabs: CloudStreamSourceTab[] = cloudStreamTabsLoading([
    { extensionId: 'Bollyflix', extensionName: 'BollyFlix', iconUrl: null, supportedMediaTypes: ['movie'], enabled: true, compatible: true },
    { extensionId: 'VegaMovies', extensionName: 'VegaMovies', iconUrl: null, supportedMediaTypes: ['movie'], enabled: true, compatible: true },
  ]);
  // One tab already settled as loaded (simulating a prior successful retry).
  const partiallyLoaded: CloudStreamSourceTab[] = [
    { ...tabs[0]!, status: 'loaded' as const, links: [{ url: 'https://x.test/f.mp4', kind: 'https' as const, provider: 'Bollyflix', sourceName: 'X' }] },
    tabs[1]!,
  ];
  const settled = settleCloudStreamLoadingTabs(partiallyLoaded, 'RATE_LIMITED');
  ok(settled[0]?.status === 'loaded' && (settled[0]?.links.length ?? 0) === 1, 'M: successful tabs are never reset by a failed batch');
  ok(settled[1]?.status === 'failed' && settled[1]?.errorCode === 'RATE_LIMITED', 'M: still-loading tab settles into the typed failure');
  const settledTimeout = settleCloudStreamLoadingTabs(tabs, 'PROVIDER_TIMEOUT');
  ok(settledTimeout.every((tab) => tab.status === 'failed' && tab.errorCode === 'PROVIDER_TIMEOUT'), 'M: timeout settles every loading tab');
  ok(settledTimeout.every((tab) => tab.links.length === 0), 'M: settled failures never invent links');
}

console.log(counter.summary('cloudstream_phase1_reliability_test'));
// The never-resolving-adapter test (F) intentionally leaves one dangling
// fetch promise + its 10s internal page timer (the deadline RACE settles the
// worker; the orphaned fetch is unobservable garbage). Exit cleanly instead
// of holding the process open for that timer — the repo's established
// convention (admin_reorder_test et al.).
process.exit(0);
