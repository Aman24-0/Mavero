import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { StreamingAddon } from '$lib/shared/streaming-addons';
import {
  resolveSingleAddonDownload,
  type ContentLookup,
} from '$lib/server/streaming/stremio/addon-download-service';
import { MAX_DOWNLOAD_STREAMS_PER_ADDON } from '$lib/server/streaming/stremio/download-selection';

/**
 * Phase A — Addon Reliability & Stremio Parity test suite.
 *
 * This suite pins the Phase A reliability contract from the
 * Mavero_Downloader_Approved_Plan (§A3 + §A4 + §A5 + §A7 + §A8 + §A9 + §A10):
 *
 *   §A3  Transient failures (timeout / network / HTTP 5xx) qualify for ONE
 *         bounded retry. Permanent 4xx / INVALID_RESPONSE / INVALID_JSON do NOT.
 *   §A4  A valid response with ZERO usable streams is treated as a transient
 *         empty result — the addon is retried ONCE. If the second attempt
 *         returns streams → `loaded`; if it returns zero again → `empty`
 *         (final — no further retry).
 *   §A5  State semantics: `loaded` / `empty` / `unavailable` are the three
 *         terminal states returned by the per-addon endpoint; `retrying` is
 *         implicit (the server retries internally before returning). The
 *         `attempts` field exposes the bounded attempt count.
 *   §A7  The 10 scenarios required by the plan:
 *          1. first attempt loaded → no retry
 *          2. transient fail → retry → loaded
 *          3. timeout → retry → loaded
 *          4. empty → retry → loaded (the A4 main scenario)
 *          5. empty → retry → empty (final empty, no further retry)
 *          6. HTTP 5xx → retry → loaded
 *          7. permanent 4xx → no retry
 *          8. one addon fails while others succeed (failure isolation)
 *          9. concurrent addons — retry of one does not block/fail others
 *         10. retry count bounded — exactly maxRetries + 1 attempts max
 *   §A8  Retry log lines carry a `reason` discriminator
 *         (transient-error | empty-result) so observability can tell them
 *         apart without inspecting URLs / tokens.
 *   §A9  No massive timeout / concurrency / retry inflation.
 *   §A10 Backward-compatible API surface (status / attempts / errorCode
 *         fields unchanged).
 *
 * All responses are mocked — no real addon / network requests are made.
 */

let passed = 0;
function ok(condition: unknown, label: string) {
  assert.ok(condition, label);
  passed += 1;
}

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative: string) => readFileSync(path.join(REPO_ROOT, relative), 'utf8');
const publicDns = (async (hostname: string) => [{ address: '93.184.216.34', family: 4 }]) as never;

// ---------------------------------------------------------------------------
// Fixtures (mirror the existing phase16/18 test fixtures)
// ---------------------------------------------------------------------------

function addonFixture(overrides: Partial<StreamingAddon> & { id: string; name: string; slug: string; manifestUrl: string }): StreamingAddon {
  return {
    enabled: true,
    status: 'experimental',
    ordering: 0,
    supportedTypes: ['movie', 'series'],
    idPrefixes: ['tt'],
    resources: ['catalog', 'meta', 'stream'],
    capabilities: {
      supportsStream: true,
      manifestId: `community.${overrides.slug}`,
      normalizedAt: new Date().toISOString(),
      streamTypes: ['movie', 'series'],
      streamIdPrefixes: ['tt'],
      idProperties: ['imdb_id'],
    },
    ...overrides,
  } as unknown as StreamingAddon;
}

const HUB = addonFixture({ id: '00000000-0000-4000-8000-14000000hub0', name: 'HdHub', slug: 'hdhub', manifestUrl: 'https://hdhub.example/manifest.json', ordering: 0 });
const PIPE = addonFixture({ id: '00000000-0000-4000-8000-14000000pipe', name: 'Pipe', slug: 'pipe', manifestUrl: 'https://pipe.example/manifest.json', ordering: 2 });
const AIO = addonFixture({ id: '00000000-0000-4000-8000-14000000aio0', name: 'AIOStreams', slug: 'aiostreams', manifestUrl: 'https://aio.example/manifest.json', ordering: 3 });

const CONTENT: ContentLookup = { title: 'Dhurandhar: The Revenge', identifiers: { imdbId: 'tt8633518', tmdbId: '1094521' }, runtimeSeconds: 3 * 3600 + 49 * 60 };
const loadContentOf = (lookup: ContentLookup) => async () => lookup;
const loadAddonsOf = (addons: StreamingAddon[]) => async () => addons;
const loadAddonByIdOf = (addons: StreamingAddon[]) => async (_client: unknown, id: string) => addons.find((addon) => addon.id === id) ?? null;

const movieRequest = { mediaType: 'movie' as const, contentId: 'movie-1094521' };

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
}

/**
 * Test fetcher — returns a CLONE of the stored Response on each call so
 * the retry path (which fires the fetcher more than once for the same URL)
 * gets a fresh body stream every time. Mirrors how a real fetch behaves.
 */
function fetcherFor(routes: Record<string, unknown>, calls: string[]): typeof fetch {
  return (async (url: string | URL) => {
    const key = String(url);
    calls.push(key);
    const handler = routes[key] ?? routes['*'];
    if (handler instanceof Response) return handler.clone();
    if (typeof handler === 'function') return (handler as () => Response)();
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
}

/**
 * Sequence fetcher — for each URL, returns responses[0] on the first call,
 * responses[1] on the second call, etc. The LAST response is sticky for any
 * further calls. Used by tests that need the addon to behave differently
 * on attempt 1 vs attempt 2 (e.g. 5xx then 200-OK-with-streams).
 */
function sequenceFetcher(routes: Record<string, Response[]>, calls: string[]): typeof fetch {
  const indices: Record<string, number> = {};
  return (async (url: string | URL) => {
    const key = String(url);
    calls.push(key);
    const arr = routes[key];
    if (!arr || arr.length === 0) return new Response('not found', { status: 404 });
    const idx = indices[key] ?? 0;
    indices[key] = idx + 1;
    const response = arr[Math.min(idx, arr.length - 1)];
    return response.clone();
  }) as typeof fetch;
}

const noSleep = async () => Promise.resolve();

// ---------------------------------------------------------------------------
// §A7.1 — First attempt succeeds with streams → no retry.
// ---------------------------------------------------------------------------

async function section1(): Promise<void> {
  let sleepCalls = 0;
  const calls: string[] = [];
  const result = await resolveSingleAddonDownload({} as never, movieRequest, HUB.id, {
    loadAddons: loadAddonsOf([HUB]),
    loadAddonById: loadAddonByIdOf([HUB]),
    loadContent: loadContentOf(CONTENT),
    dnsResolver: publicDns,
    sleep: async () => { sleepCalls += 1; },
    fetcher: fetcherFor({
      'https://hdhub.example/stream/movie/tt8633518.json': json({
        streams: [
          { name: 'a', title: '1080p', url: 'https://hub.example/a.mkv' },
          { name: 'b', title: '720p', url: 'https://hub.example/b.mkv' },
        ],
      }),
    }, calls),
  });
  ok(result.status === 'loaded', `1: first-attempt loaded → status='loaded' (got ${result.status})`);
  ok(result.streams.length === 2, `1: 2 streams survived (got ${result.streams.length})`);
  ok(result.attempts === 1, `1: attempts = 1 (no retry) (got ${result.attempts})`);
  ok(sleepCalls === 0, `1: sleep (backoff) NEVER called (got ${sleepCalls})`);
  ok(calls.length === 1, `1: fetcher called ONCE (got ${calls.length})`);
  ok(result.errorCode === undefined, '1: NO error code on success');
}

// ---------------------------------------------------------------------------
// §A7.2 — First attempt transiently fails, second succeeds → loaded.
// ---------------------------------------------------------------------------

async function section2(): Promise<void> {
  let sleepCalls = 0;
  const calls: string[] = [];
  const result = await resolveSingleAddonDownload({} as never, movieRequest, HUB.id, {
    loadAddons: loadAddonsOf([HUB]),
    loadAddonById: loadAddonByIdOf([HUB]),
    loadContent: loadContentOf(CONTENT),
    dnsResolver: publicDns,
    sleep: async () => { sleepCalls += 1; },
    fetcher: sequenceFetcher({
      'https://hdhub.example/stream/movie/tt8633518.json': [
        new Response('boom', { status: 500 }),
        json({ streams: [{ name: 'a', title: '1080p', url: 'https://hub.example/a.mkv' }] }),
      ],
    }, calls),
  });
  ok(result.status === 'loaded', `2: transient fail then success → status='loaded' (got ${result.status})`);
  ok(result.streams.length === 1, `2: 1 stream survived (got ${result.streams.length})`);
  ok(result.attempts === 2, `2: attempts = 2 (one retry) (got ${result.attempts})`);
  ok(sleepCalls === 1, `2: sleep (backoff) called once (got ${sleepCalls})`);
  ok(calls.length === 2, `2: fetcher called twice (got ${calls.length})`);
  ok(result.errorCode === undefined, '2: NO error code on success');
}

// ---------------------------------------------------------------------------
// §A7.3 — First attempt times out, second succeeds → loaded.
//
// The fetcher throws a TypeError on the first call (simulating a network
// failure / timeout per the toStreamServiceError mapping in stream-fetch.ts)
// and returns streams on the second call.
// ---------------------------------------------------------------------------

async function section3(): Promise<void> {
  let sleepCalls = 0;
  const calls: string[] = [];
  let callCount = 0;
  const fetcher = (async (url: string | URL) => {
    const key = String(url);
    calls.push(key);
    callCount += 1;
    if (callCount === 1) {
      // Simulate a network-layer failure — stream-fetch.ts maps TypeError
      // to StreamServiceError('NETWORK'), which is in RETRYABLE_ERROR_CODES.
      throw new TypeError('network failed');
    }
    return json({ streams: [{ name: 'a', title: '1080p', url: 'https://hub.example/a.mkv' }] });
  }) as typeof fetch;
  const result = await resolveSingleAddonDownload({} as never, movieRequest, HUB.id, {
    loadAddons: loadAddonsOf([HUB]),
    loadAddonById: loadAddonByIdOf([HUB]),
    loadContent: loadContentOf(CONTENT),
    dnsResolver: publicDns,
    sleep: async () => { sleepCalls += 1; },
    fetcher,
  });
  ok(result.status === 'loaded', `3: transient network failure then success → status='loaded' (got ${result.status})`);
  ok(result.streams.length === 1, `3: 1 stream survived (got ${result.streams.length})`);
  ok(result.attempts === 2, `3: attempts = 2 (one retry) (got ${result.attempts})`);
  ok(sleepCalls === 1, `3: sleep (backoff) called once (got ${sleepCalls})`);
}

// ---------------------------------------------------------------------------
// §A7.4 — First attempt returns valid response with ZERO streams,
//         second returns streams → final loaded result.
//
// This is the MAIN A4 scenario: an addon may return 0 streams on the first
// call but streams on the second (Stremio itself exhibits this). The
// downloader must NOT finalize "empty" on the first attempt — it must retry
// once and surface the streams if the second attempt succeeds.
// ---------------------------------------------------------------------------

async function section4(): Promise<void> {
  let sleepCalls = 0;
  const calls: string[] = [];
  const result = await resolveSingleAddonDownload({} as never, movieRequest, PIPE.id, {
    loadAddons: loadAddonsOf([PIPE]),
    loadAddonById: loadAddonByIdOf([PIPE]),
    loadContent: loadContentOf(CONTENT),
    dnsResolver: publicDns,
    sleep: async () => { sleepCalls += 1; },
    fetcher: sequenceFetcher({
      'https://pipe.example/stream/movie/tt8633518.json': [
        json({ streams: [] }),
        json({ streams: [{ name: 'a', title: '1080p', url: 'https://pipe.example/a.mkv' }] }),
      ],
    }, calls),
  });
  ok(result.status === 'loaded', `4: empty then streams → status='loaded' (got ${result.status}) — NOT 'empty'`);
  ok(result.streams.length === 1, `4: 1 stream survived (got ${result.streams.length})`);
  ok(result.attempts === 2, `4: attempts = 2 (one empty-result retry) (got ${result.attempts})`);
  ok(sleepCalls === 1, `4: sleep (backoff) called once (got ${sleepCalls})`);
  ok(calls.length === 2, `4: fetcher called twice (got ${calls.length})`);
  ok(result.errorCode === undefined, '4: NO error code on success');
  // Diagnostics carry the LAST attempt's counts (raw=1, selected=1).
  ok(result.diagnostics?.raw === 1, `4: diagnostics.raw = 1 (from the 2nd attempt) (got ${result.diagnostics?.raw})`);
  ok(result.diagnostics?.selected === 1, `4: diagnostics.selected = 1 (got ${result.diagnostics?.selected})`);
}

// ---------------------------------------------------------------------------
// §A7.5 — First attempt returns zero streams, second also returns zero
//         → final empty result (no further retry).
//
// The empty-result retry is BOUNDED: if the second attempt is also empty,
// the addon is finalized as 'empty' (NOT retried further, NOT marked as
// 'unavailable').
// ---------------------------------------------------------------------------

async function section5(): Promise<void> {
  let sleepCalls = 0;
  const calls: string[] = [];
  const result = await resolveSingleAddonDownload({} as never, movieRequest, PIPE.id, {
    loadAddons: loadAddonsOf([PIPE]),
    loadAddonById: loadAddonByIdOf([PIPE]),
    loadContent: loadContentOf(CONTENT),
    dnsResolver: publicDns,
    sleep: async () => { sleepCalls += 1; },
    fetcher: fetcherFor({
      'https://pipe.example/stream/movie/tt8633518.json': json({ streams: [] }),
    }, calls),
  });
  ok(result.status === 'empty', `5: empty then empty → status='empty' (got ${result.status}) — NOT 'unavailable'`);
  ok(result.streams.length === 0, '5: 0 streams shown');
  ok(result.attempts === 2, `5: attempts = 2 (one retry, then stop) (got ${result.attempts})`);
  ok(sleepCalls === 1, `5: sleep (backoff) called once (got ${sleepCalls})`);
  ok(calls.length === 2, `5: fetcher called twice (got ${calls.length})`);
  ok(result.errorCode === undefined, `5: NO error code on honest empty (got ${result.errorCode})`);
  ok(result.diagnostics?.raw === 0, `5: diagnostics.raw = 0 (got ${result.diagnostics?.raw})`);
  ok(result.diagnostics?.selected === 0, '5: diagnostics.selected = 0');
}

// ---------------------------------------------------------------------------
// §A7.6 — First attempt transient HTTP 5xx, second succeeds → loaded.
// ---------------------------------------------------------------------------

async function section6(): Promise<void> {
  let sleepCalls = 0;
  const calls: string[] = [];
  const result = await resolveSingleAddonDownload({} as never, movieRequest, HUB.id, {
    loadAddons: loadAddonsOf([HUB]),
    loadAddonById: loadAddonByIdOf([HUB]),
    loadContent: loadContentOf(CONTENT),
    dnsResolver: publicDns,
    sleep: async () => { sleepCalls += 1; },
    fetcher: sequenceFetcher({
      'https://hdhub.example/stream/movie/tt8633518.json': [
        new Response('server error', { status: 503 }),
        json({ streams: [{ name: 'a', title: '1080p', url: 'https://hub.example/a.mkv' }] }),
      ],
    }, calls),
  });
  ok(result.status === 'loaded', `6: HTTP 503 then success → status='loaded' (got ${result.status})`);
  ok(result.streams.length === 1, `6: 1 stream survived (got ${result.streams.length})`);
  ok(result.attempts === 2, `6: attempts = 2 (one retry) (got ${result.attempts})`);
  ok(sleepCalls === 1, `6: sleep (backoff) called once (got ${sleepCalls})`);
  ok(calls.length === 2, `6: fetcher called twice (got ${calls.length})`);
  ok(result.errorCode === undefined, '6: NO error code on success');
}

// ---------------------------------------------------------------------------
// §A7.7 — Permanent 4xx → NO unnecessary retry.
//
// A 4xx response is NOT a transient failure — the addon is rejecting the
// request (auth, not-found, bad-request). Retrying would just produce the
// same 4xx again, so the downloader must NOT retry.
// ---------------------------------------------------------------------------

async function section7(): Promise<void> {
  let sleepCalls = 0;
  const calls: string[] = [];
  const result = await resolveSingleAddonDownload({} as never, movieRequest, HUB.id, {
    loadAddons: loadAddonsOf([HUB]),
    loadAddonById: loadAddonByIdOf([HUB]),
    loadContent: loadContentOf(CONTENT),
    dnsResolver: publicDns,
    sleep: async () => { sleepCalls += 1; },
    fetcher: fetcherFor({
      'https://hdhub.example/stream/movie/tt8633518.json': new Response('not found', { status: 404 }),
    }, calls),
  });
  ok(result.status === 'unavailable', `7: permanent 4xx → status='unavailable' (got ${result.status})`);
  ok(result.errorCode === 'HTTP_ERROR', `7: errorCode = HTTP_ERROR (got ${result.errorCode})`);
  ok(result.attempts === 1, `7: attempts = 1 (NO retry) (got ${result.attempts})`);
  ok(sleepCalls === 0, `7: sleep (backoff) NEVER called (got ${sleepCalls})`);
  ok(calls.length === 1, `7: fetcher called ONCE (got ${calls.length})`);
  ok(result.streams.length === 0, '7: 0 streams');
}

// ---------------------------------------------------------------------------
// §A7.8 — One addon fails while other addons succeed → successful addons
//         remain successful (failure isolation).
//
// The downloader resolves each addon INDEPENDENTLY through the per-addon
// endpoint. A failing addon must NOT propagate its failure to other addons.
// ---------------------------------------------------------------------------

async function section8(): Promise<void> {
  const calls: string[] = [];
  const sharedFetcher = fetcherFor({
    'https://hdhub.example/stream/movie/tt8633518.json': json({ streams: [{ name: 'a', title: '1080p', url: 'https://hub.example/a.mkv' }] }),
    'https://pipe.example/stream/movie/tt8633518.json': new Response('boom', { status: 500 }),
    'https://aio.example/stream/movie/tt8633518.json': json({ streams: [{ type: 'http', name: 'a', title: '1080p', url: 'https://aio.example/a.mkv' }] }),
  }, calls);
  const sharedDeps = {
    loadAddons: loadAddonsOf([HUB, PIPE, AIO]),
    loadContent: loadContentOf(CONTENT),
    dnsResolver: publicDns,
    sleep: noSleep,
    fetcher: sharedFetcher,
  };
  const [hubResult, pipeResult, aioResult] = await Promise.all([
    resolveSingleAddonDownload({} as never, movieRequest, HUB.id, { ...sharedDeps, loadAddonById: loadAddonByIdOf([HUB, PIPE, AIO]) }),
    resolveSingleAddonDownload({} as never, movieRequest, PIPE.id, { ...sharedDeps, loadAddonById: loadAddonByIdOf([HUB, PIPE, AIO]) }),
    resolveSingleAddonDownload({} as never, movieRequest, AIO.id, { ...sharedDeps, loadAddonById: loadAddonByIdOf([HUB, PIPE, AIO]) }),
  ]);
  ok(hubResult.status === 'loaded' && hubResult.streams.length === 1, `8: HdHub loaded (got ${hubResult.status})`);
  ok(aioResult.status === 'loaded' && aioResult.streams.length === 1, `8: AIO loaded (got ${aioResult.status})`);
  ok(pipeResult.status === 'unavailable', `8: Pipe unavailable (got ${pipeResult.status})`);
  ok(pipeResult.errorCode === 'HTTP_ERROR', `8: Pipe errorCode = HTTP_ERROR (got ${pipeResult.errorCode})`);
  ok(pipeResult.attempts === 2, `8: Pipe retried once before giving up (got ${pipeResult.attempts})`);
  // The failing addon was fetched twice (initial + retry); the successful addons were fetched once each.
  const hubCalls = calls.filter((c) => c === 'https://hdhub.example/stream/movie/tt8633518.json').length;
  const pipeCalls = calls.filter((c) => c === 'https://pipe.example/stream/movie/tt8633518.json').length;
  const aioCalls = calls.filter((c) => c === 'https://aio.example/stream/movie/tt8633518.json').length;
  ok(hubCalls === 1, `8: HdHub fetched once (got ${hubCalls})`);
  ok(aioCalls === 1, `8: AIO fetched once (got ${aioCalls})`);
  ok(pipeCalls === 2, `8: Pipe fetched twice (initial + retry) (got ${pipeCalls})`);
}

// ---------------------------------------------------------------------------
// §A7.9 — Multiple addons resolving concurrently → retry of one addon
//         does NOT block or fail the others.
//
// Three addons fire in parallel. Pipe returns empty on the first attempt
// and streams on the second (exercises the A4 empty-result retry). HdHub
// and AIO succeed on the first attempt. The retry of Pipe must NOT delay
// or fail HdHub/AIO — they complete with their final state independently.
// ---------------------------------------------------------------------------

async function section9(): Promise<void> {
  const calls: string[] = [];
  const callOrder: string[] = [];
  const sharedFetcher = sequenceFetcher({
    'https://hdhub.example/stream/movie/tt8633518.json': [
      json({ streams: [{ name: 'a', title: '1080p', url: 'https://hub.example/a.mkv' }] }),
    ],
    'https://pipe.example/stream/movie/tt8633518.json': [
      json({ streams: [] }),
      json({ streams: [{ name: 'a', title: '1080p', url: 'https://pipe.example/a.mkv' }] }),
    ],
    'https://aio.example/stream/movie/tt8633518.json': [
      json({ streams: [{ type: 'http', name: 'a', title: '1080p', url: 'https://aio.example/a.mkv' }] }),
    ],
  }, calls);
  // Wrap the fetcher to record the call order across all addons.
  const recordingFetcher = (async (url: string | URL) => {
    const key = String(url);
    callOrder.push(key);
    return sharedFetcher(url, { signal: new AbortController().signal } as RequestInit) as Promise<Response>;
  }) as typeof fetch;
  const sharedDeps = {
    loadAddons: loadAddonsOf([HUB, PIPE, AIO]),
    loadContent: loadContentOf(CONTENT),
    dnsResolver: publicDns,
    sleep: noSleep,
    fetcher: recordingFetcher,
  };
  const [hubResult, pipeResult, aioResult] = await Promise.all([
    resolveSingleAddonDownload({} as never, movieRequest, HUB.id, { ...sharedDeps, loadAddonById: loadAddonByIdOf([HUB, PIPE, AIO]) }),
    resolveSingleAddonDownload({} as never, movieRequest, PIPE.id, { ...sharedDeps, loadAddonById: loadAddonByIdOf([HUB, PIPE, AIO]) }),
    resolveSingleAddonDownload({} as never, movieRequest, AIO.id, { ...sharedDeps, loadAddonById: loadAddonByIdOf([HUB, PIPE, AIO]) }),
  ]);
  ok(hubResult.status === 'loaded' && hubResult.streams.length === 1, `9: HdHub loaded independently of Pipe's retry (got ${hubResult.status})`);
  ok(hubResult.attempts === 1, `9: HdHub attempts = 1 (no retry needed) (got ${hubResult.attempts})`);
  ok(aioResult.status === 'loaded' && aioResult.streams.length === 1, `9: AIO loaded independently of Pipe's retry (got ${aioResult.status})`);
  ok(aioResult.attempts === 1, `9: AIO attempts = 1 (no retry needed) (got ${aioResult.attempts})`);
  ok(pipeResult.status === 'loaded' && pipeResult.streams.length === 1, `9: Pipe loaded after empty-result retry (got ${pipeResult.status})`);
  ok(pipeResult.attempts === 2, `9: Pipe attempts = 2 (one retry) (got ${pipeResult.attempts})`);
  // Pipe's retry did not cause HdHub or AIO to fail — they are loaded.
  ok(hubResult.errorCode === undefined && aioResult.errorCode === undefined, '9: NO error code on HdHub/AIO (Pipe retry did not propagate)');
  // Verify the fetcher was called for each addon's URL — Pipe twice, others once.
  const hubCalls = callOrder.filter((c) => c === 'https://hdhub.example/stream/movie/tt8633518.json').length;
  const pipeCalls = callOrder.filter((c) => c === 'https://pipe.example/stream/movie/tt8633518.json').length;
  const aioCalls = callOrder.filter((c) => c === 'https://aio.example/stream/movie/tt8633518.json').length;
  ok(hubCalls === 1, `9: HdHub fetched once (got ${hubCalls})`);
  ok(aioCalls === 1, `9: AIO fetched once (got ${aioCalls})`);
  ok(pipeCalls === 2, `9: Pipe fetched twice (initial + retry) (got ${pipeCalls})`);
}

// ---------------------------------------------------------------------------
// §A7.10 — Retry count remains bounded → exactly the intended maximum
//          number of attempts.
//
// Default budget: MAX_RETRY_ATTEMPTS = 1, so the loop runs at most 2 times
// (1 initial + 1 retry). Even with a transient error on EVERY attempt,
// the addon never exceeds 2 total attempts.
// ---------------------------------------------------------------------------

async function section10(): Promise<void> {
  let sleepCalls = 0;
  const calls: string[] = [];
  const result = await resolveSingleAddonDownload({} as never, movieRequest, HUB.id, {
    loadAddons: loadAddonsOf([HUB]),
    loadAddonById: loadAddonByIdOf([HUB]),
    loadContent: loadContentOf(CONTENT),
    dnsResolver: publicDns,
    sleep: async () => { sleepCalls += 1; },
    fetcher: fetcherFor({
      'https://hdhub.example/stream/movie/tt8633518.json': new Response('boom', { status: 500 }),
    }, calls),
  });
  ok(result.status === 'unavailable', `10: persistent 5xx → status='unavailable' (got ${result.status})`);
  ok(result.errorCode === 'HTTP_ERROR', `10: errorCode = HTTP_ERROR (got ${result.errorCode})`);
  ok(result.attempts === 2, `10: attempts = 2 EXACTLY (1 initial + 1 retry) (got ${result.attempts})`);
  ok(sleepCalls === 1, `10: sleep (backoff) called EXACTLY once (got ${sleepCalls}) — no infinite loop`);
  ok(calls.length === 2, `10: fetcher called EXACTLY twice (got ${calls.length}) — bounded`);
  // Verify the bound is also enforced for the empty-result retry path.
  let emptySleepCalls = 0;
  const emptyCalls: string[] = [];
  const emptyResult = await resolveSingleAddonDownload({} as never, movieRequest, PIPE.id, {
    loadAddons: loadAddonsOf([PIPE]),
    loadAddonById: loadAddonByIdOf([PIPE]),
    loadContent: loadContentOf(CONTENT),
    dnsResolver: publicDns,
    sleep: async () => { emptySleepCalls += 1; },
    fetcher: fetcherFor({
      'https://pipe.example/stream/movie/tt8633518.json': json({ streams: [] }),
    }, emptyCalls),
  });
  ok(emptyResult.status === 'empty', `10: persistent empty → status='empty' (got ${emptyResult.status})`);
  ok(emptyResult.attempts === 2, `10: empty attempts = 2 EXACTLY (1 initial + 1 retry) (got ${emptyResult.attempts})`);
  ok(emptySleepCalls === 1, `10: empty sleep (backoff) called EXACTLY once (got ${emptySleepCalls})`);
  ok(emptyCalls.length === 2, `10: empty fetcher called EXACTLY twice (got ${emptyCalls.length})`);
}

// ---------------------------------------------------------------------------
// §A8 + §A10 — Structured retry logging + backward-compatible API.
// ---------------------------------------------------------------------------

function sectionA8A10(): void {
  const serviceSource = read('src/lib/server/streaming/stremio/addon-download-service.ts');
  // §A8: retry log lines carry a `reason` discriminator so observability can
  // distinguish transient-error retries from empty-result retries. The source
  // defines the two reason literals and includes them in the log template.
  ok(serviceSource.includes("'transient-error'"), 'A8: source defines the transient-error reason literal');
  ok(serviceSource.includes("'empty-result'"), 'A8: source defines the empty-result reason literal');
  ok(serviceSource.includes('reason=${reason}'), 'A8: retry log line includes reason=${reason} discriminator');
  // §A10: the API contract is unchanged. The state model is still
  // 'loading' | 'retrying' | 'loaded' | 'empty' | 'unavailable'.
  ok(serviceSource.includes("'loading' | 'retrying' | 'loaded' | 'empty' | 'unavailable'"), 'A10: state model unchanged');
  // The attempts field is still exposed.
  ok(serviceSource.includes('attempts?: number') || serviceSource.includes('attempts: number'), 'A10: attempts field exposed');
  // The errorCode field is still present (only when status='unavailable').
  ok(serviceSource.includes('errorCode?: StreamErrorCode'), 'A10: errorCode field still present');
  // §A9: no massive timeout / concurrency inflation.
  ok(serviceSource.includes('MAX_RETRY_ATTEMPTS = 1'), 'A9: retry budget stays at 1 (no inflation)');
  ok(serviceSource.includes('DOWNLOAD_TIMEOUT_MS = 30_000'), 'A9: per-attempt timeout stays at 30s');
  ok(serviceSource.includes('ADDON_CONCURRENCY = 4'), 'A9: concurrency pool stays at 4');
  // §A4: the empty-result retry is bounded — empty status qualifies for retry
  // only when canRetry (attempt <= maxRetries). The check is in the source.
  ok(serviceSource.includes("isEmptyResult = result.status === 'empty'"), 'A4: isEmptyResult discriminator is in the source');
  ok(serviceSource.includes('canRetry = attempt <= maxRetries'), 'A4: canRetry bound is in the source');
  // The "empty" path does NOT set an errorCode (honest zero — not a failure).
  ok(serviceSource.includes("lastStatus === 'empty'"), 'A5: empty path returns honest empty (no errorCode)');
  // The MAX_DOWNLOAD_STREAMS_PER_ADDON cap is preserved (no truncation in Phase A).
  ok(MAX_DOWNLOAD_STREAMS_PER_ADDON === Number.MAX_SAFE_INTEGER, 'A10: MAX_DOWNLOAD_STREAMS_PER_ADDON unchanged (no truncation)');
}

// ---------------------------------------------------------------------------
// runner
// ---------------------------------------------------------------------------

sectionA8A10();

await section1();
await section2();
await section3();
await section4();
await section5();
await section6();
await section7();
await section8();
await section9();
await section10();

console.log(`stremio_downloader_phaseA_reliability_test: ${passed} checks passed (Phase A: transient retry + empty-result retry + state semantics + bounded budget + structured retry logging + backward-compatible API)`);
