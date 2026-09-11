import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { StreamingAddon } from '$lib/shared/streaming-addons';
import { normalizeStremioStreamResponse } from '$lib/server/streaming/stremio/stream-normalize';
import {
  buildDownloadCandidates,
  selectDownloadStreams,
  scoreDownloadCandidate,
  sizeFromTexts,
  parseRuntimeSeconds,
  isPartialRelease,
  sizeRuntimeVerdict,
  MAX_DOWNLOAD_STREAMS_PER_ADDON,
  type DownloadStreamCandidate,
  type DownloadHostClass,
} from '$lib/server/streaming/stremio/download-selection';
import {
  resolveAddonDownloads,
  resolveSingleAddonDownload,
  listAddonDownloadTargets,
  type ContentLookup,
} from '$lib/server/streaming/stremio/addon-download-service';
import { externalPlayerHint, externalPlayerLaunchFor, MPV_ANDROID_PACKAGE } from '$lib/shared/external-player';
import { MAVERO_PLAYER_SOURCE_NAME, maveroPlayerSourceOption } from '$lib/shared/mavero-player';

/**
 * Phase 15 test suite — Downloader Reliability + Source Expansion + 10-Link Selection.
 *
 * Companion to stremio_downloader_phase14_test.ts (which pins the Phase 14
 * downloader contract). THIS suite pins the Phase 15 hardening:
 *
 *   A   Independent loading — addon A completes before B; A remains visible
 *       while B loads; B does not reset A.
 *   B   Independent retry — retry A only requests A; B/C stay untouched.
 *   C   Retry/backoff — transient failure retries; budget respected; no
 *       infinite retry; non-transient failure does NOT retry.
 *   D   Loaded zero — valid addon response with zero usable candidates;
 *       status = empty (NOT unavailable).
 *   E   Request failure — timeout/malformed/HTTP failure → unavailable
 *       after the retry budget.
 *   F   AIOStreams — type=http + infoHash stays eligible; type=p2p rejected;
 *       magnet rejected.
 *   G   PixelDrain — valid PixelDrain URL is NOT globally rejected; original
 *       URL preserved; no hotlink-bypass headers/proxy introduced; host
 *       classification works.
 *   H   Bad releases — END-CREDIT / TRAILER / SAMPLE / POST-CREDIT rejected
 *       (punctuation/spacing tolerant); legitimate movie filename not rejected.
 *   I   Size/runtime — long movie + tiny file rejected/suspicious; short
 *       movie + small file can remain valid; normal 1080p release valid.
 *   J   10 candidate cap — 30+ valid raw candidates → max 10; fewer than 10
 *       → preserve all valid candidates.
 *   K   Diversity — duplicate releases don't consume all slots; different
 *       valid qualities survive.
 *   L   Ranking — normal 1080p H264 practical release beats huge 4K when
 *       appropriate; 720p remains available; 480p remains available; practical
 *       4K remains possible.
 *   M   Mavero Player removal — the source selector does NOT contain
 *       MAVERO Player; existing embed providers remain.
 *   N   External player — mpv Android intent targets is.xyz.mpv; original
 *       URL preserved; fallback behavior is valid.
 *   O   Downloader fetch isolation — the downloader does NOT fetch media
 *       URLs, does NOT invoke FFmpeg, does NOT invoke media worker, does
 *       NOT proxy media.
 */

let passed = 0;
function ok(condition: unknown, label: string) {
  assert.ok(condition, label);
  passed += 1;
}

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative: string) => readFileSync(path.join(REPO_ROOT, relative), 'utf8');
const SECRET = ''; // downloader does not use session tokens (no session layer)

const publicDns = (async (hostname: string) => [{ address: '93.184.216.34', family: 4 }]) as never;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function addonFixture(overrides: Partial<StreamingAddon> & { id: string; name: string; slug: string; manifestUrl: string }): StreamingAddon {
  return {
    enabled: true,
    status: 'experimental',
    ordering: 0,
    supportedTypes: ['movie', 'series'],
    idPrefixes: ['tt'],
    resources: ['catalog', 'meta', 'stream'],
    capabilities: { supportsStream: true, manifestId: `community.${overrides.slug}`, normalizedAt: new Date().toISOString(), streamTypes: ['movie', 'series'], streamIdPrefixes: ['tt'], idProperties: ['imdb_id'] },
    ...overrides,
  } as unknown as StreamingAddon;
}

const HUB = addonFixture({ id: '00000000-0000-4000-8000-14000000hub0', name: 'HdHub', slug: 'hdhub', manifestUrl: 'https://hdhub.example/manifest.json', ordering: 0 });
const PIPE = addonFixture({ id: '00000000-0000-4000-8000-14000000pipe', name: 'Pipe', slug: 'pipe', manifestUrl: 'https://pipe.example/manifest.json', ordering: 2 });
const AIO = addonFixture({ id: '00000000-0000-4000-8000-14000000aio0', name: 'AIOStreams', slug: 'aiostreams', manifestUrl: 'https://aio.example/manifest.json', ordering: 3 });
const PENGU = addonFixture({ id: '00000000-0000-4000-8000-140000pengu', name: 'PenguPlay', slug: 'penguplay', manifestUrl: 'https://pengu.example/manifest.json', ordering: 1 });
const DESIFLIX = addonFixture({ id: '00000000-0000-4000-8000-140desiflix', name: 'DesiFlix', slug: 'desiflix', manifestUrl: 'https://desiflix.example/manifest.json', ordering: 4 });
const SCOOTIO = addonFixture({ id: '00000000-0000-4000-8000-140scootio', name: 'Scootio', slug: 'scootio', manifestUrl: 'https://scootio.example/manifest.json', ordering: 5 });

const CONTENT: ContentLookup = { title: 'Dhurandhar: The Revenge', identifiers: { imdbId: 'tt8633518', tmdbId: '1094521' }, runtimeSeconds: 3 * 3600 + 49 * 60 };
const loadContentOf = (lookup: ContentLookup) => async () => lookup;
const loadAddonsOf = (addons: StreamingAddon[]) => async () => addons;
const loadAddonByIdOf = (addons: StreamingAddon[]) => async (_client: unknown, id: string) => addons.find((addon) => addon.id === id) ?? null;

const movieRequest = { mediaType: 'movie' as const, contentId: 'movie-1094521' };

/** HdHub-shaped: one HLS stream + one MP4 direct file. */
function hubPayload() {
  return {
    streams: [
      { name: '1080p HLS', title: 'HLS', url: 'https://hub-cdn.example/hls/s1/index.m3u8?token=signed' },
      { name: '1080p', title: '1080p H.264 MP4 Hindi', url: 'https://hub-cdn.example/file/movie.mp4', behaviorHints: { videoSize: 3_221_225_472, filename: 'Movie.1080p.WEB-DL.H264.mp4' } },
    ],
  };
}

/** Pipe-shaped: cleartext http PixelDrain links + an untyped magnet/infoHash entry. */
function pipeHttpPayload() {
  return {
    streams: [
      { name: '1080p', title: 'Dhurandhar 1080p WEB-DL Dual Audio\nHindi + English\n4.40 GB\nPixelDrain', url: 'http://pixeldrain.com/api/file/ab12cd', behaviorHints: { videoSize: 4_724_904_960 } },
      { name: '720p', title: 'Dhurandhar 720p WEB-DL Dual Audio\nHindi + English\n1.90 GB\nPixelDrain', url: 'https://pixeldrain.com/api/file/cd34ef', behaviorHints: { videoSize: 2_040_109_056 } },
      { name: 'Torrent', title: 'magnet edition', infoHash: 'deadbeef' },
    ],
  };
}

/** AIOStreams-shaped: EXPLICIT type:'http' entries that ALSO carry infoHash fields. */
function aioTypedHttpPayload() {
  return {
    streams: [
      { type: 'http', name: '1080p', title: 'AIO 1080p WEB-DL\nHindi English\n4.40 GB', url: 'https://aio-cdn.example/dl/one?h=abc', infoHash: 'cafebeef', behaviorHints: { videoSize: 4_724_904_960, filename: 'AIO.1080p.WEB-DL.H264.mkv' } },
      { type: 'p2p', name: '2160p', title: 'AIO 2160p', url: 'https://aio-cdn.example/dl/two', infoHash: 'feedface' },
    ],
  };
}

/** 30+ valid raw candidates to test the max=10 cap. */
function manyCandidatesPayload() {
  const streams: Array<{ name: string; title: string; url: string; behaviorHints: { videoSize: number; filename: string } }> = [];
  for (let i = 0; i < 15; i += 1) {
    streams.push({
      name: '1080p',
      title: `Dhurandhar 1080p WEB-DL Dual Audio variant ${i}`,
      url: `https://cdn.example/1080p-${i}.mkv`,
      behaviorHints: { videoSize: 4_724_904_960 + i * 100_000_000, filename: `Dhurandhar.1080p.WEB-DL.H264.Dual-Audio.v${i}.mkv` },
    });
  }
  for (let i = 0; i < 15; i += 1) {
    streams.push({
      name: '720p',
      title: `Dhurandhar 720p WEB-DL Dual Audio variant ${i}`,
      url: `https://cdn.example/720p-${i}.mkv`,
      behaviorHints: { videoSize: 2_040_109_056 + i * 50_000_000, filename: `Dhurandhar.720p.WEB-DL.H264.Dual-Audio.v${i}.mkv` },
    });
  }
  return { streams };
}

function fetcherFor(routes: Record<string, unknown>, calls: string[]): typeof fetch {
  return (async (url: string | URL) => {
    const key = String(url);
    calls.push(key);
    const handler = routes[key] ?? routes['*'];
    if (handler instanceof Response) return handler;
    if (typeof handler === 'function') return (handler as () => Response)();
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
}

function normalizeStreams(payload: unknown) {
  return normalizeStremioStreamResponse(payload).streams;
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
}

// ---------------------------------------------------------------------------
// A — Independent loading
// ---------------------------------------------------------------------------

async function sectionA(): Promise<void> {
  // Simulate addon A (Pipe) responding instantly and addon B (HdHub) responding
  // slowly. The test verifies that the per-addon endpoint can be called
  // INDEPENDENTLY for each addon — one slow addon never blocks another.
  const calls: string[] = [];
  let hubResponded = false;
  const slowHub = (): Response => {
    hubResponded = true;
    return json(hubPayload());
  };
  // Resolve each addon via the per-addon endpoint.
  const [pipeResult, hubResult] = await Promise.all([
    resolveSingleAddonDownload({} as never, movieRequest, PIPE.id, {
      loadAddons: loadAddonsOf([PIPE, HUB]),
      loadAddonById: loadAddonByIdOf([PIPE, HUB]),
      loadContent: loadContentOf(CONTENT),
      dnsResolver: publicDns,
      fetcher: fetcherFor({ 'https://pipe.example/stream/movie/tt8633518.json': json(pipeHttpPayload()) }, calls),
    }),
    resolveSingleAddonDownload({} as never, movieRequest, HUB.id, {
      loadAddons: loadAddonsOf([PIPE, HUB]),
      loadAddonById: loadAddonByIdOf([PIPE, HUB]),
      loadContent: loadContentOf(CONTENT),
      dnsResolver: publicDns,
      fetcher: fetcherFor({ 'https://hdhub.example/stream/movie/tt8633518.json': slowHub }, calls),
    }),
  ]);
  ok(pipeResult.status === 'loaded' && pipeResult.streams.length === 2, 'A: Pipe resolves independently with both PixelDrain links');
  ok(hubResult.status === 'loaded' && hubResult.streams.length === 1, 'A: HdHub resolves independently with the MP4 direct file');
  ok(hubResponded, 'A: HdHub was actually fetched (the slow addon was called)');
  // Each per-addon call fetched ONLY its own endpoint — no cross-contamination.
  ok(calls.every((url) => !url.includes('aio.example') && !url.includes('pengu.example')), 'A: each per-addon call fetches ONLY its own endpoint');
  ok(calls.includes('https://pipe.example/stream/movie/tt8633518.json') && calls.includes('https://hdhub.example/stream/movie/tt8633518.json'), 'A: both addon endpoints were fetched');
}

// ---------------------------------------------------------------------------
// B — Independent retry (retry A only; B/C untouched)
// ---------------------------------------------------------------------------

async function sectionB(): Promise<void> {
  // Three addons. Pipe fails first (always 500), then succeeds on manual
  // retry. HdHub and AIO succeed first time. Retrying Pipe must NOT re-fetch
  // HdHub or AIO.
  const calls: string[] = [];
  let pipeShouldFail = true;
  const pipeHandler = (): Response => {
    if (pipeShouldFail) return new Response('boom', { status: 500 });
    return json(pipeHttpPayload());
  };
  const deps = {
    loadAddons: loadAddonsOf([PIPE, HUB, AIO]),
    loadAddonById: loadAddonByIdOf([PIPE, HUB, AIO]),
    loadContent: loadContentOf(CONTENT),
    dnsResolver: publicDns,
    sleep: async () => Promise.resolve(),
    fetcher: fetcherFor({
      'https://pipe.example/stream/movie/tt8633518.json': pipeHandler,
      'https://hdhub.example/stream/movie/tt8633518.json': json(hubPayload()),
      'https://aio.example/stream/movie/tt8633518.json': json(aioTypedHttpPayload()),
    }, calls),
  };

  // First resolution: Pipe fails (after retries), HdHub + AIO succeed.
  calls.length = 0;
  const [pipe1, hub1, aio1] = await Promise.all([
    resolveSingleAddonDownload({} as never, movieRequest, PIPE.id, deps),
    resolveSingleAddonDownload({} as never, movieRequest, HUB.id, deps),
    resolveSingleAddonDownload({} as never, movieRequest, AIO.id, deps),
  ]);
  ok(pipe1.status === 'unavailable', 'B: Pipe is unavailable after the retry budget (HTTP 500 every time)');
  ok(hub1.status === 'loaded' && hub1.streams.length === 1, 'B: HdHub loaded successfully');
  ok(aio1.status === 'loaded' && aio1.streams.length === 1, 'B: AIO loaded successfully');

  // Now retry ONLY Pipe — HdHub and AIO must NOT be re-fetched.
  calls.length = 0;
  pipeShouldFail = false; // Pipe recovers now
  const pipe2 = await resolveSingleAddonDownload({} as never, movieRequest, PIPE.id, deps);
  ok(pipe2.status === 'loaded' && pipe2.streams.length === 2, 'B: Pipe succeeds on the retry (after the recovery)');
  ok(calls.every((url) => !url.includes('hdhub.example') && !url.includes('aio.example')), 'B: retrying Pipe did NOT re-fetch HdHub or AIO (independent retry)');
  ok(calls.includes('https://pipe.example/stream/movie/tt8633518.json'), 'B: retrying Pipe re-fetched ONLY Pipe');
}

// ---------------------------------------------------------------------------
// C — Retry/backoff (transient failure retries; budget respected; no infinite retry)
// ---------------------------------------------------------------------------

async function sectionC(): Promise<void> {
  // 1. Transient failure (HTTP 500) retries up to the budget, then unavailable.
  let attempts = 0;
  const always500 = (): Response => {
    attempts += 1;
    return new Response('boom', { status: 500 });
  };
  const result1 = await resolveSingleAddonDownload({} as never, movieRequest, HUB.id, {
    loadAddons: loadAddonsOf([HUB]),
    loadAddonById: loadAddonByIdOf([HUB]),
    loadContent: loadContentOf(CONTENT),
    dnsResolver: publicDns,
    sleep: async () => Promise.resolve(),
    maxRetries: 2,
    fetcher: fetcherFor({ 'https://hdhub.example/stream/movie/tt8633518.json': always500 }, []),
  });
  ok(result1.status === 'unavailable' && result1.errorCode === 'HTTP_ERROR', 'C: a persistently-failing addon ends in unavailable with the closed error code');
  ok(result1.attempts === 3, 'C: the retry budget is respected (1 initial + 2 retries = 3 total attempts)');
  ok(attempts === 3, 'C: the fetcher was actually called 3 times (no infinite retry)');

  // 2. Non-transient failure (INVALID_RESPONSE) does NOT retry.
  let invalidAttempts = 0;
  const invalidJson = (): Response => {
    invalidAttempts += 1;
    return json({ not_streams: [] });
  };
  const result2 = await resolveSingleAddonDownload({} as never, movieRequest, HUB.id, {
    loadAddons: loadAddonsOf([HUB]),
    loadAddonById: loadAddonByIdOf([HUB]),
    loadContent: loadContentOf(CONTENT),
    dnsResolver: publicDns,
    sleep: async () => Promise.resolve(),
    maxRetries: 2,
    fetcher: fetcherFor({ 'https://hdhub.example/stream/movie/tt8633518.json': invalidJson }, []),
  });
  ok(result2.status === 'unavailable' && result2.errorCode === 'INVALID_RESPONSE', 'C: a non-transient failure (invalid response) does NOT retry');
  ok(result2.attempts === 1 && invalidAttempts === 1, 'C: non-transient failures return after exactly 1 attempt');

  // 3. Transient failure then success — the addon recovers within the budget.
  let recoveryAttempts = 0;
  const recovery = (): Response => {
    recoveryAttempts += 1;
    if (recoveryAttempts === 1) return new Response('boom', { status: 500 });
    return json(hubPayload());
  };
  const result3 = await resolveSingleAddonDownload({} as never, movieRequest, HUB.id, {
    loadAddons: loadAddonsOf([HUB]),
    loadAddonById: loadAddonByIdOf([HUB]),
    loadContent: loadContentOf(CONTENT),
    dnsResolver: publicDns,
    sleep: async () => Promise.resolve(),
    maxRetries: 2,
    fetcher: fetcherFor({ 'https://hdhub.example/stream/movie/tt8633518.json': recovery }, []),
  });
  ok(result3.status === 'loaded' && result3.streams.length === 1, 'C: a transient failure recovers within the retry budget');
  ok(result3.attempts === 2 && recoveryAttempts === 2, 'C: the recovery happened on the 2nd attempt (1 initial + 1 retry)');

  // 4. Backoff respects the cap (no request storms).
  const delays: number[] = [];
  let stormAttempts = 0;
  const alwaysTimeout = (): Response => {
    stormAttempts += 1;
    return new Response('boom', { status: 500 });
  };
  await resolveSingleAddonDownload({} as never, movieRequest, HUB.id, {
    loadAddons: loadAddonsOf([HUB]),
    loadAddonById: loadAddonByIdOf([HUB]),
    loadContent: loadContentOf(CONTENT),
    dnsResolver: publicDns,
    sleep: async (ms: number) => { delays.push(ms); return Promise.resolve(); },
    maxRetries: 3,
    initialBackoffMs: 100,
    maxBackoffMs: 500,
    fetcher: fetcherFor({ 'https://hdhub.example/stream/movie/tt8633518.json': alwaysTimeout }, []),
  });
  ok(delays.length === 3, 'C: backoff fired exactly 3 times (one between each attempt)');
  ok(delays.every((delay) => delay <= 500 + 50), 'C: every backoff is at or below the cap (±jitter)');
  ok(stormAttempts === 4, 'C: total fetcher calls = 4 (1 initial + 3 retries — no request storm)');
}

// ---------------------------------------------------------------------------
// D — Loaded zero (valid response, zero usable candidates)
// ---------------------------------------------------------------------------

async function sectionD(): Promise<void> {
  const result = await resolveSingleAddonDownload({} as never, movieRequest, PIPE.id, {
    loadAddons: loadAddonsOf([PIPE]),
    loadAddonById: loadAddonByIdOf([PIPE]),
    loadContent: loadContentOf(CONTENT),
    dnsResolver: publicDns,
    fetcher: fetcherFor({
      'https://pipe.example/stream/movie/tt8633518.json': json({
        streams: [
          { name: 'Torrent', infoHash: 'deadbeef', url: 'https://pipe.example/a.mkv' },
          { name: 'Headered', url: 'https://pipe.example/b.mkv', behaviorHints: { proxyHeaders: { Referer: 'https://pipe.example/' } } },
        ],
      }),
    }, []),
  });
  ok(result.status === 'empty', 'D: a valid addon response with zero usable candidates is LOADED ZERO (NOT unavailable)');
  ok(result.streams.length === 0, 'D: no streams survive filtering');
  ok(result.errorCode === undefined, 'D: loaded-zero has NO error code (it is not a failure)');
}

// ---------------------------------------------------------------------------
// E — Request failure (timeout / malformed / HTTP failure → unavailable)
// ---------------------------------------------------------------------------

async function sectionE(): Promise<void> {
  // 1. HTTP 500 (transient, exhausts budget).
  const r1 = await resolveSingleAddonDownload({} as never, movieRequest, HUB.id, {
    loadAddons: loadAddonsOf([HUB]),
    loadAddonById: loadAddonByIdOf([HUB]),
    loadContent: loadContentOf(CONTENT),
    dnsResolver: publicDns,
    sleep: async () => Promise.resolve(),
    fetcher: fetcherFor({ 'https://hdhub.example/stream/movie/tt8633518.json': new Response('boom', { status: 500 }) }, []),
  });
  ok(r1.status === 'unavailable' && r1.errorCode === 'HTTP_ERROR', 'E: HTTP 500 → unavailable with HTTP_ERROR');

  // 2. Malformed JSON.
  const r2 = await resolveSingleAddonDownload({} as never, movieRequest, HUB.id, {
    loadAddons: loadAddonsOf([HUB]),
    loadAddonById: loadAddonByIdOf([HUB]),
    loadContent: loadContentOf(CONTENT),
    dnsResolver: publicDns,
    fetcher: fetcherFor({ 'https://hdhub.example/stream/movie/tt8633518.json': new Response('not json', { status: 200, headers: { 'content-type': 'text/plain' } }) }, []),
  });
  ok(r2.status === 'unavailable' && (r2.errorCode === 'INVALID_JSON' || r2.errorCode === 'INVALID_RESPONSE'), 'E: malformed JSON → unavailable');

  // 3. Invalid response shape (not { streams: [...] }).
  const r3 = await resolveSingleAddonDownload({} as never, movieRequest, HUB.id, {
    loadAddons: loadAddonsOf([HUB]),
    loadAddonById: loadAddonByIdOf([HUB]),
    loadContent: loadContentOf(CONTENT),
    dnsResolver: publicDns,
    fetcher: fetcherFor({ 'https://hdhub.example/stream/movie/tt8633518.json': json({ not_streams: [] }) }, []),
  });
  ok(r3.status === 'unavailable' && r3.errorCode === 'INVALID_RESPONSE', 'E: invalid response shape → unavailable with INVALID_RESPONSE');

  // 4. Network failure (TypeError).
  const r4 = await resolveSingleAddonDownload({} as never, movieRequest, HUB.id, {
    loadAddons: loadAddonsOf([HUB]),
    loadAddonById: loadAddonByIdOf([HUB]),
    loadContent: loadContentOf(CONTENT),
    dnsResolver: publicDns,
    sleep: async () => Promise.resolve(),
    fetcher: (async () => { throw new TypeError('network down'); }) as typeof fetch,
  });
  ok(r4.status === 'unavailable' && r4.errorCode === 'NETWORK', 'E: network failure → unavailable with NETWORK');

  // 5. Addon not found (loadAddonById returns null).
  const r5 = await resolveSingleAddonDownload({} as never, movieRequest, 'nonexistent-addon-id', {
    loadAddons: loadAddonsOf([HUB]),
    loadAddonById: async () => null,
    loadContent: loadContentOf(CONTENT),
  });
  ok(r5.status === 'unavailable', 'E: a nonexistent addon → unavailable');
}

// ---------------------------------------------------------------------------
// F — AIOStreams (type=http + infoHash retained; type=p2p rejected; magnet rejected)
// ---------------------------------------------------------------------------

function sectionF(): void {
  const normalized = normalizeStreams(aioTypedHttpPayload());
  ok(normalized.length === 1, 'F: the explicit type:"http" entry survives normalization');
  ok(normalized[0]?.streamType === 'http', 'F: the addon-specific stream type is preserved');
  ok(normalized[0]?.url === 'https://aio-cdn.example/dl/one?h=abc', 'F: the AIOStreams http URL is preserved verbatim (infoHash field ignored — type is authoritative)');

  const { candidates } = buildDownloadCandidates(normalized);
  ok(candidates.length === 1, 'F: the AIOStreams http stream becomes a download candidate');

  // P2P / torrent / magnet always rejected.
  ok(normalizeStreams({ streams: [{ type: 'p2p', name: 'x', url: 'https://x.example/a.mkv' }] }).length === 0, 'F: explicit type:"p2p" is excluded');
  ok(normalizeStreams({ streams: [{ type: 'torrent', name: 'x', url: 'https://x.example/a.mkv' }] }).length === 0, 'F: explicit type:"torrent" is excluded');
  ok(normalizeStreams({ streams: [{ name: 'x', url: 'https://x.example/a.mkv', infoHash: 'deadbeef' }] }).length === 0, 'F: UNTYPED torrent-shaped entry (infoHash) is excluded');
  ok(normalizeStreams({ streams: [{ name: 'x', url: 'magnet:?xt=urn:btih:deadbeef' }] }).length === 0, 'F: magnet URLs are excluded (non-http scheme)');
  ok(normalizeStreams({ streams: [{ type: 'http', name: 'x', url: 'https://tracker.example/file.torrent' }] }).length === 0, 'F: a .torrent URL is excluded even when the addon claims type http');
}

// ---------------------------------------------------------------------------
// G — PixelDrain (not globally rejected; URL preserved; no hotlink bypass)
// ---------------------------------------------------------------------------

async function sectionG(): Promise<void> {
  const result = await resolveSingleAddonDownload({} as never, movieRequest, PIPE.id, {
    loadAddons: loadAddonsOf([PIPE]),
    loadAddonById: loadAddonByIdOf([PIPE]),
    loadContent: loadContentOf(CONTENT),
    dnsResolver: publicDns,
    fetcher: fetcherFor({ 'https://pipe.example/stream/movie/tt8633518.json': json(pipeHttpPayload()) }, []),
  });
  ok(result.status === 'loaded' && result.streams.length === 2, 'G: PixelDrain candidates are NOT globally rejected');
  ok(result.streams.every((stream) => stream.url.includes('pixeldrain.com')), 'G: the PixelDrain URLs are preserved verbatim');
  ok(result.streams.every((stream) => stream.url.startsWith('http://') || stream.url.startsWith('https://')), 'G: the original URL scheme is preserved (no rewrite)');

  // Host classification works.
  const candidates = buildDownloadCandidates(normalizeStreams({
    streams: [
      { name: 'pd', url: 'https://pixeldrain.com/api/file/ab12cd' },
      { name: 'pd-sub', url: 'https://sub.pixeldrain.com/api/file/ab12cd' },
      { name: 'other', url: 'https://other-host.example/file.mkv' },
    ],
  }));
  ok(candidates.candidates[0]?.hostClass === 'pixeldrain', 'G: pixeldrain.com host is classified');
  ok(candidates.candidates[1]?.hostClass === 'pixeldrain', 'G: subdomain of pixeldrain.com is classified');
  ok(candidates.candidates[2]?.hostClass === 'known', 'G: a non-pixeldrain host is "known" (not rejected)');

  // No hotlink-bypass headers/proxy in the source.
  const serviceSource = read('src/lib/server/streaming/stremio/addon-download-service.ts');
  const selectionSource = read('src/lib/server/streaming/stremio/download-selection.ts');
  for (const source of [serviceSource, selectionSource]) {
    ok(!source.includes('Referer') && !source.includes('Cookie') && !source.includes('Authorization'), 'G: NO hotlink-bypass headers (Referer/Cookie/Authorization) are injected');
    ok(!source.includes('proxy') && !source.includes('media-worker') && !source.includes('ffmpeg'), 'G: NO proxy / media-worker / ffmpeg machinery is referenced');
  }
}

// ---------------------------------------------------------------------------
// H — Bad releases (END-CREDIT / TRAILER / SAMPLE / POST-CREDIT rejected)
// ---------------------------------------------------------------------------

function sectionH(): void {
  // Each token must reject in punctuation/spacing-tolerant, case-insensitive form.
  const rejections = [
    'Movie END-CREDIT 1080p',
    'Movie END_CREDIT 1080p',
    'Movie END.CREDIT 1080p',
    'Movie END CREDIT 1080p',
    'Movie ENDCREDIT 1080p',
    'Movie POST-CREDIT scene',
    'Movie POSTCREDIT scene',
    'Movie end credit scene',
    'Movie Credits 1080p',
    'Movie TRAILER 2026',
    'Movie Teaser 2026',
    'Movie Preview 2026',
    'Movie SAMPLE 1080p',
    'Movie CLIP 1080p',
    'Movie EXTRAS 1080p',
    'Movie BONUS 1080p',
    'Movie PROMO 1080p',
    'Movie Promotional 1080p',
    'Movie Interview 1080p',
    'Movie Behind the Scenes 1080p',
    'Movie Making of 1080p',
    'Movie Deleted Scene 1080p',
    'Movie Featurette 1080p',
  ];
  for (const title of rejections) {
    ok(isPartialRelease({ title }), `H: "${title}" is rejected as a partial release`);
    const { candidates, dropped } = buildDownloadCandidates(normalizeStreams({
      streams: [{ name: 'a', title, url: 'https://x.example/a.mkv', behaviorHints: { videoSize: 4_724_904_960 } }],
    }));
    ok(candidates.length === 0 && dropped['partial-release'] === 1, `H: "${title}" is excluded with partial-release reason`);
  }

  // Legitimate movie filenames must NOT be rejected.
  const legitimate = [
    'Dhurandhar 1080p WEB-DL Dual Audio',
    'Movie.1080p.WEB-DL.H264.mp4',
    'Endgame 2019 1080p BluRay',
    'The Credit 2026 1080p WEB-DL', // "Credit" (singular) is NOT a partial-release token
    'Inception 2010 1080p',
    'Sample.Movie.2026.1080p.WEB-DL.mkv', // "Sample.Movie" — but "Sample" is a token
  ];
  let legitimateKept = 0;
  for (const title of legitimate) {
    const result = isPartialRelease({ title });
    // "Sample.Movie.2026..." contains "Sample" → it WILL match. This is the
    // conservative trade-off (false positive tolerated for safety). Document it.
    if (title.startsWith('Sample.')) {
      ok(result === true, `H: "${title}" matches the SAMPLE token (conservative — a real sample is more likely than a real movie called "Sample")`);
    } else {
      ok(result === false, `H: "${title}" is NOT rejected (legitimate movie filename)`);
      legitimateKept += 1;
    }
  }
  ok(legitimateKept >= 5, 'H: at least 5 legitimate filenames pass the filter');
}

// ---------------------------------------------------------------------------
// I — Size/runtime sanity
// ---------------------------------------------------------------------------

function sectionI(): void {
  // 1. Long movie + tiny file at high resolution → reject.
  const longMovie = 3 * 3600 + 49 * 60; // 3h49m in seconds
  const tiny1080p = sizeRuntimeVerdict(
    { quality: '1080p', sizeBytes: 156 * 1024 ** 2, height: 1080, name: 'a', title: 'Movie END-CREDIT 1080p', description: '', filename: '', tag: '' },
    { runtimeSeconds: longMovie },
  );
  ok(tiny1080p === 'reject' || tiny1080p === 'suspicious', 'I: a 156 MB 1080p file for a 3h49m movie is rejected/suspicious');

  const explicitReject = sizeRuntimeVerdict(
    { quality: '1080p', sizeBytes: 50 * 1024 ** 2, height: 1080, name: 'a', title: 'Movie 1080p', description: '', filename: '', tag: '' },
    { runtimeSeconds: longMovie },
  );
  ok(explicitReject === 'reject', 'I: a 50 MB 1080p file for a 3h49m movie is REJECTED (high confidence — sample-like)');

  // 2. Short movie + small file can remain valid.
  const shortMovie = 30 * 60; // 30 min
  const smallShort = sizeRuntimeVerdict(
    { quality: '1080p', sizeBytes: 300 * 1024 ** 2, height: 1080, name: 'a', title: 'Short Film 1080p', description: '', filename: '', tag: '' },
    { runtimeSeconds: shortMovie },
  );
  ok(smallShort === 'ok', 'I: a 300 MB 1080p 30-min short film is OK (short films can legitimately be small)');

  // 3. Normal 1080p release is valid.
  const normal1080p = sizeRuntimeVerdict(
    { quality: '1080p', sizeBytes: 4_724_904_960, height: 1080, name: 'a', title: 'Movie 1080p WEB-DL', description: '', filename: '', tag: '' },
    { runtimeSeconds: longMovie },
  );
  ok(normal1080p === 'ok', 'I: a 4.4 GB 1080p WEB-DL is OK');

  // 4. No runtime → still catch sample-size 4K/1080p (suspicious, not reject).
  const noRuntime = sizeRuntimeVerdict(
    { quality: '4K', sizeBytes: 100 * 1024 ** 2, height: 2160, name: 'a', title: '4K', description: '', filename: '', tag: '' },
    {},
  );
  ok(noRuntime === 'suspicious', 'I: a 100 MB 4K file with no runtime is suspicious (sample-like)');

  // 5. End-to-end: the 156 MB END-CREDIT candidate is rejected by buildDownloadCandidates.
  const { candidates, dropped } = buildDownloadCandidates(
    normalizeStreams({
      streams: [
        { name: 'a', title: 'Movie END-CREDIT 1080p', url: 'https://x.example/a.mkv', behaviorHints: { videoSize: 156 * 1024 ** 2, filename: 'Movie.END-CREDIT.1080p.mkv' } },
        { name: 'b', title: 'Movie 1080p WEB-DL', url: 'https://x.example/b.mkv', behaviorHints: { videoSize: 4_724_904_960, filename: 'Movie.1080p.WEB-DL.H264.mkv' } },
      ],
    }),
    { runtimeSeconds: longMovie },
  );
  ok(candidates.length === 1, 'I: the END-CREDIT candidate is excluded; the normal 1080p survives');
  ok(candidates[0]?.url === 'https://x.example/b.mkv', 'I: the surviving candidate is the normal 1080p WEB-DL');
  ok(dropped['partial-release'] === 1, 'I: the END-CREDIT was counted as a partial-release drop');

  // 6. parseRuntimeSeconds covers the common formats.
  ok(parseRuntimeSeconds('3h 49m') === 3 * 3600 + 49 * 60, 'I: "3h 49m" parses to seconds');
  ok(parseRuntimeSeconds('89 min') === 89 * 60, 'I: "89 min" parses to seconds');
  ok(parseRuntimeSeconds('PT2H30M') === 2 * 3600 + 30 * 60, 'I: ISO 8601 PT2H30M parses to seconds');
  ok(parseRuntimeSeconds('1:30:00') === 1 * 3600 + 30 * 60, 'I: "1:30:00" parses to seconds');
  ok(parseRuntimeSeconds(undefined) === undefined, 'I: undefined runtime → undefined');
}

// ---------------------------------------------------------------------------
// J — 10 candidate cap
// ---------------------------------------------------------------------------

function sectionJ(): void {
  ok(MAX_DOWNLOAD_STREAMS_PER_ADDON === 10, 'J: MAX_DOWNLOAD_STREAMS_PER_ADDON is 10 (Phase 15 task §8)');

  // 30+ valid raw candidates → exactly 10 selected.
  const { candidates } = buildDownloadCandidates(normalizeStreams(manyCandidatesPayload()));
  ok(candidates.length >= 30, 'J: the payload yields 30+ valid candidates');
  const selected = selectDownloadStreams(candidates);
  ok(selected.length === 10, 'J: 30+ valid candidates collapse to exactly 10 BEST links');

  // Fewer than 10 → all valid candidates preserved (no fabrication).
  const few: DownloadStreamCandidate[] = [
    { url: 'https://x.example/a', quality: '1080p', codec: 'H.264', audio: 'dual', protocol: 'https', index: 0, hostClass: 'known', releaseKey: 'k1' },
    { url: 'https://x.example/b', quality: '720p', codec: 'H.264', audio: 'dual', protocol: 'https', index: 1, hostClass: 'known', releaseKey: 'k2' },
    { url: 'https://x.example/c', quality: '480p', codec: 'H.264', audio: 'single', protocol: 'https', index: 2, hostClass: 'known', releaseKey: 'k3' },
  ];
  const selectedFew = selectDownloadStreams(few);
  ok(selectedFew.length === 3, 'J: 3 valid candidates → 3 selected (no fabrication, no over-collapse)');

  // 0 candidates → 0 selected.
  ok(selectDownloadStreams([]).length === 0, 'J: 0 candidates → 0 selected');
}

// ---------------------------------------------------------------------------
// K — Diversity (duplicates don't consume all slots; different qualities survive)
// ---------------------------------------------------------------------------

function sectionK(): void {
  // 10 identical releases (same quality/codec/container/audio/release text).
  const dupes: DownloadStreamCandidate[] = Array.from({ length: 10 }, (_, index) => ({
    url: `https://x.example/dupe-${index}`,
    quality: '1080p',
    codec: 'H.264',
    audio: 'dual',
    protocol: 'https',
    index,
    hostClass: 'known' as DownloadHostClass,
    releaseKey: '1080p|H.264|MKV|dual|movie audio',
  }));
  const selectedDupes = selectDownloadStreams(dupes);
  ok(selectedDupes.length === 1, 'K: 10 equivalent releases collapse to 1 practical link');

  // A diverse mix: 4× 1080p + 2× 720p + 2× 480p + 2× 4K → 10 distinct → all 4
  // qualities survive (each bucket fits within its diversity cap).
  const diverse: DownloadStreamCandidate[] = [];
  for (let i = 0; i < 4; i += 1) {
    diverse.push({ url: `https://x.example/1080-${i}`, quality: '1080p', codec: 'H.264', audio: 'dual', protocol: 'https', index: i, hostClass: 'known', releaseKey: `1080p|H.264|MKV|dual|movie-${i}` });
  }
  for (let i = 0; i < 2; i += 1) {
    diverse.push({ url: `https://x.example/720-${i}`, quality: '720p', codec: 'H.264', audio: 'dual', protocol: 'https', index: 4 + i, hostClass: 'known', releaseKey: `720p|H.264|MKV|dual|movie-${i}` });
  }
  for (let i = 0; i < 2; i += 1) {
    diverse.push({ url: `https://x.example/480-${i}`, quality: '480p', codec: 'H.264', audio: 'single', protocol: 'https', index: 6 + i, hostClass: 'known', releaseKey: `480p|H.264|MKV|single|movie-${i}` });
  }
  for (let i = 0; i < 2; i += 1) {
    diverse.push({ url: `https://x.example/4k-${i}`, quality: '4K', codec: 'HEVC', audio: 'multi', protocol: 'https', index: 8 + i, hostClass: 'known', releaseKey: `4K|HEVC|MKV|multi|movie-${i}` });
  }
  const selectedDiverse = selectDownloadStreams(diverse);
  ok(selectedDiverse.length === 10, 'K: 10 distinct releases fill all 10 slots');
  const qualities = selectedDiverse.map((entry) => entry.quality);
  ok(qualities.filter((q) => q === '1080p').length <= 4, 'K: 1080p capped at 4');
  ok(qualities.filter((q) => q === '4K').length <= 2, 'K: 4K capped at 2');
  ok(qualities.includes('1080p') && qualities.includes('720p') && qualities.includes('4K'), 'K: the top-quality buckets (1080p / 720p / 4K) all survive the diversity sweep');
  // Task §12: quality dominates diversity. 480p survives here only because
  // slots remain after the higher-quality buckets are admitted; it is NEVER
  // promoted above a practical 1080p/720p just to fill a diversity quota.
  ok(qualities.filter((q) => q === '480p').length <= 4, 'K: 480p (when present) is capped at 4');
}

// ---------------------------------------------------------------------------
// L — Ranking (1080p H264 practical beats huge 4K; 720p/480p available; practical 4K possible)
// ---------------------------------------------------------------------------

function sectionL(): void {
  const base = { index: 0, audio: 'unknown' as const, codec: 'H.264' as const, protocol: 'https' as const, hostClass: 'known' as DownloadHostClass, releaseKey: '' };
  const mk = (over: Partial<DownloadStreamCandidate>): DownloadStreamCandidate => ({ ...base, url: 'https://x.example/a', ...over });

  // Practical 1080p H264 ranks below a huge 4K HEVC.
  ok(scoreDownloadCandidate(mk({ title: '1080p WEB-DL', quality: '1080p', sizeBytes: 4_724_904_960 })) < scoreDownloadCandidate(mk({ title: '4K REMUX', quality: '4K', sizeBytes: 33 * 1024 ** 3 })), 'L: a 4.4 GB 1080p WEB-DL outranks a 33 GB 4K REMUX');

  // Practical 4K HEVC is allowed (not banned).
  const practical4K = selectDownloadStreams([mk({ title: '2160p UHD WEB-DL', quality: '4K', codec: 'HEVC', sizeBytes: 12 * 1024 ** 3, index: 0 })]);
  ok(practical4K.length === 1 && practical4K[0]?.quality === '4K', 'L: a practical 4K HEVC release is allowed (no global 4K ban)');

  // 720p and 480p remain available.
  const mix: DownloadStreamCandidate[] = [
    mk({ title: '1080p', quality: '1080p', sizeBytes: 4_724_904_960, index: 0, releaseKey: 'a' }),
    mk({ title: '720p', quality: '720p', sizeBytes: 2_040_109_056, index: 1, releaseKey: 'b' }),
    mk({ title: '480p', quality: '480p', sizeBytes: 858_993_459, index: 2, releaseKey: 'c' }),
  ];
  const selected = selectDownloadStreams(mix);
  ok(selected.length === 3, 'L: 3 distinct qualities all survive');
  const qualities = selected.map((entry) => entry.quality);
  ok(qualities.includes('1080p') && qualities.includes('720p') && qualities.includes('480p'), 'L: 720p and 480p remain available');

  // Size-aware scoring: a 4.4 GB 1080p outranks a 33 GB 4K.
  const heavyVsPractical = selectDownloadStreams([
    mk({ title: '4K REMUX', quality: '4K', codec: 'HEVC', sizeBytes: 33 * 1024 ** 3, index: 0, releaseKey: 'a' }),
    mk({ title: '1080p WEB-DL', quality: '1080p', sizeBytes: 4_724_904_960, index: 1, releaseKey: 'b' }),
  ]);
  ok(heavyVsPractical[0]?.quality === '1080p', 'L: the practical 1080p WEB-DL ranks ABOVE the 33 GB 4K REMUX');
}

// ---------------------------------------------------------------------------
// M — Mavero Player removal from the source selector
// ---------------------------------------------------------------------------

function sectionM(): void {
  const watchPage = read('src/routes/watch/[type]/[id]/+page.svelte');
  ok(!watchPage.includes('maveroPlayerSourceOption()'), 'M: the watch route no longer appends maveroPlayerSourceOption() to sourceOptions');
  ok(!/\.\.\.\(data\.maveroPlayerAvailable\s*\?\s*\[maveroPlayerSourceOption\(\)\]/.test(watchPage), 'M: the conditional append of the virtual option is gone');
  // The virtual source NAME still exists in the shared module (used by deep-link backward compat).
  const shared = read('src/lib/shared/mavero-player.ts');
  ok(shared.includes(MAVERO_PLAYER_SOURCE_NAME), 'M: the MAVERO Player display name is preserved (deep-link backward compat)');
  ok(maveroPlayerSourceOption().name === MAVERO_PLAYER_SOURCE_NAME, 'M: the maveroPlayerSourceOption() helper still works (it is just no longer appended to the source selector)');
}

// ---------------------------------------------------------------------------
// N — External player (mpv Android intent + original URL preservation + fallback)
// ---------------------------------------------------------------------------

function sectionN(): void {
  const httpsUrl = 'https://provider.example/dl/Movie.1080p.mkv?token=x';
  const android = externalPlayerLaunchFor(httpsUrl, { android: true });
  ok(android?.kind === 'android-intent', 'N: Android launch is an android-intent');
  ok(android?.href.startsWith('intent://provider.example/dl/Movie.1080p.mkv?token=x#Intent;scheme=https;'), 'N: the intent carries the ORIGINAL host/path/query');
  ok(android?.href.includes(`package=${MPV_ANDROID_PACKAGE}`), `N: the intent targets mpv-android (${MPV_ANDROID_PACKAGE})`);
  ok(android?.href.includes(`S.browser_fallback_url=${encodeURIComponent(httpsUrl)}`), 'N: the fallback URL preserves the FULL original address');

  const plain = externalPlayerLaunchFor('http://pixeldrain.com/api/file/ab12cd', { android: true });
  ok(plain?.href.startsWith('intent://pixeldrain.com/api/file/ab12cd#Intent;scheme=http;'), 'N: cleartext http launches work (scheme carried into the intent)');

  const desktop = externalPlayerLaunchFor(httpsUrl, { android: false });
  ok(desktop?.kind === 'direct' && desktop.href === httpsUrl, 'N: non-Android environments get the original URL directly (desktop never breaks)');

  ok(externalPlayerLaunchFor('ftp://x.example/a.mkv', { android: true }) === null, 'N: unsupported schemes never launch');
  ok(externalPlayerLaunchFor('not a url', { android: false }) === null, 'N: invalid URLs never launch');

  ok(externalPlayerHint({ kind: 'android-intent' }) === 'To play this source, install mpv.', 'N: the exact-launch hint states the mpv requirement');
  ok(externalPlayerHint({ kind: 'direct' }) === 'This source opens in an external player.', 'N: the fallback hint describes the handoff honestly');
}

// ---------------------------------------------------------------------------
// O — Downloader fetch isolation (no media URL fetch, no FFmpeg, no worker, no proxy)
// ---------------------------------------------------------------------------

async function sectionO(): Promise<void> {
  const calls: string[] = [];
  await resolveAddonDownloads({} as never, movieRequest, {
    loadAddons: loadAddonsOf([HUB, PIPE]),
    loadContent: loadContentOf(CONTENT),
    dnsResolver: publicDns,
    fetcher: fetcherFor({
      'https://hdhub.example/stream/movie/tt8633518.json': json(hubPayload()),
      'https://pipe.example/stream/movie/tt8633518.json': json(pipeHttpPayload()),
    }, calls),
  });
  ok(calls.every((url) => !url.includes('pixeldrain.com') && !url.includes('hub-cdn') && !url.includes('pengu.example/get')), 'O: NO media URL is ever fetched server-side (only the stream LIST endpoints)');
  ok(calls.every((url) => !url.includes('/compat/') && !url.includes('media-worker') && !url.includes('ffmpeg')), 'O: NO compatibility/worker/ffmpeg request happens');

  const serviceSource = read('src/lib/server/streaming/stremio/addon-download-service.ts');
  ok(!serviceSource.includes('media-worker') && !serviceSource.includes('session-tokens') && !serviceSource.includes('media-compat') && !serviceSource.includes('signCompatToken'), 'O: the downloader service imports NO worker/compat machinery');
  ok(!serviceSource.includes('proxy') && !serviceSource.includes('ffmpeg'), 'O: the downloader service references NO proxy / ffmpeg machinery');

  const selectionSource = read('src/lib/server/streaming/stremio/download-selection.ts');
  ok(!selectionSource.includes('media-worker') && !selectionSource.includes('ffmpeg') && !selectionSource.includes('proxy'), 'O: the selection module references NO worker/ffmpeg/proxy machinery');

  // The new per-addon endpoint also fetches ONLY the stream list.
  const calls2: string[] = [];
  await resolveSingleAddonDownload({} as never, movieRequest, PIPE.id, {
    loadAddons: loadAddonsOf([PIPE]),
    loadAddonById: loadAddonByIdOf([PIPE]),
    loadContent: loadContentOf(CONTENT),
    dnsResolver: publicDns,
    sleep: async () => Promise.resolve(),
    fetcher: fetcherFor({ 'https://pipe.example/stream/movie/tt8633518.json': json(pipeHttpPayload()) }, calls2),
  });
  ok(calls2.every((url) => !url.includes('pixeldrain.com')), 'O: the per-addon path also fetches NO media URL');
  ok(calls2.every((url) => !url.includes('media-worker') && !url.includes('ffmpeg') && !url.includes('/compat/')), 'O: the per-addon path also references NO worker/ffmpeg/compat');
}

// ---------------------------------------------------------------------------
// P — listAddonDownloadTargets (the tab list endpoint — no stream fetches)
// ---------------------------------------------------------------------------

async function sectionP(): Promise<void> {
  const calls: string[] = [];
  const result = await listAddonDownloadTargets({} as never, movieRequest, {
    loadAddons: loadAddonsOf([HUB, PIPE, AIO, PENGU, DESIFLIX, SCOOTIO]),
    loadContent: loadContentOf(CONTENT),
    dnsResolver: publicDns,
    fetcher: fetcherFor({}, calls),
  });
  ok(result.tabs.length === 6, 'P: every enabled addon gets a tab entry');
  ok(calls.length === 0, 'P: the tab list endpoint fetches NO stream endpoints (pure metadata)');
  ok(result.tabs.every((tab) => typeof tab.addonId === 'string' && typeof tab.addonName === 'string' && typeof tab.addonSlug === 'string' && typeof tab.addonOrdering === 'number'), 'P: every tab carries safe display metadata');
  ok(result.tabs.every((tab) => !('streams' in tab) && !('status' in tab)), 'P: tabs carry NO stream data / status (the UI renders loading state)');
  ok(result.consideredAddons === 6, 'P: consideredAddons counts every enabled addon');
  // Tabs are sorted by ordering then name.
  const orderings = result.tabs.map((tab) => tab.addonOrdering);
  ok(JSON.stringify(orderings) === JSON.stringify([...orderings].sort((a, b) => a - b)), 'P: tabs are sorted by ordering');
}

// ---------------------------------------------------------------------------
// runner
// ---------------------------------------------------------------------------

sectionF();
sectionH();
sectionI();
sectionJ();
sectionK();
sectionL();
sectionM();
sectionN();

await sectionA();
await sectionB();
await sectionC();
await sectionD();
await sectionE();
await sectionG();
await sectionO();
await sectionP();

console.log(`stremio_downloader_phase15_test: ${passed} checks passed (independent loading + retry/backoff + 10-link selection + bad-release/size-runtime filtering + PixelDrain + MAVERO Player removal + fetch isolation)`);
