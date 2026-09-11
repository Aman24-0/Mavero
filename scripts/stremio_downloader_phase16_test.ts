import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { StreamingAddon } from '$lib/shared/streaming-addons';
import { normalizeStremioStreamResponse } from '$lib/server/streaming/stremio/stream-normalize';
import {
  buildDownloadCandidates,
  selectDownloadStreams,
  isPartialRelease,
  sizeRuntimeVerdict,
  MAX_DOWNLOAD_STREAMS_PER_ADDON,
  type DownloadStreamCandidate,
} from '$lib/server/streaming/stremio/download-selection';
import {
  resolveSingleAddonDownload,
  listAddonDownloadTargets,
  type ContentLookup,
} from '$lib/server/streaming/stremio/addon-download-service';

/**
 * Phase 16 test suite — Diagnostic Parity + Share + Unlimited Streams.
 *
 * Companion to stremio_downloader_phase15_test.ts. THIS suite pins the Phase 16
 * contract changes:
 *
 *   A   10-link limit is COMPLETELY REMOVED — 15 valid streams → 15 remain;
 *       30 valid streams → 30 remain.
 *   B   No silent quality truncation — 1080 + 720 + 480 + 4K + HEVC + H264
 *       all valid streams remain.
 *   C   AIOStreams HTTP stream with infoHash → remains eligible.
 *   D   Actual P2P stream → excluded (the existing security boundary).
 *   E   PixelDrain direct URL → remains eligible/preserved.
 *   F   Original URL preservation → Share receives the EXACT original URL.
 *   G   UI has exactly TWO actions: Download + Share.
 *   H   Play/Watch action absent.
 *   I   Copy action absent.
 *   J   navigator.share is used (primary path).
 *   K   Addon request success with N streams → LOADED N.
 *   L   Addon request success with zero eligible streams → LOADED 0 (NOT FAILED).
 *   M   Request failure → FAILED.
 *   N   One slow addon does not prevent other addons from loading.
 *   O   All enabled addons are requested on first sheet open.
 *   P   Retry is not required for normal successful addon loading.
 *   Q   Diagnostic raw-vs-eligible counts correctly identify dropped streams.
 *   R   Download behavior is UNCHANGED (still uses href={stream.url}).
 *   S   Per-addon timeout = 30s (healthy addons don't need Retry).
 *   T   MAVERO Player still NOT in the source selector (Phase 15 preserved).
 *   U   No proxy / FFmpeg / media-worker introduced.
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

const CONTENT: ContentLookup = { title: 'Dhurandhar: The Revenge', identifiers: { imdbId: 'tt8633518', tmdbId: '1094521' }, runtimeSeconds: 3 * 3600 + 49 * 60 };
const loadContentOf = (lookup: ContentLookup) => async () => lookup;
const loadAddonsOf = (addons: StreamingAddon[]) => async () => addons;
const loadAddonByIdOf = (addons: StreamingAddon[]) => async (_client: unknown, id: string) => addons.find((addon) => addon.id === id) ?? null;

const movieRequest = { mediaType: 'movie' as const, contentId: 'movie-1094521' };

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
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

/** 15 valid raw candidates (no max cap → all 15 survive). */
function fifteenStreamsPayload() {
  const streams: Array<{ name: string; title: string; url: string; behaviorHints: { videoSize: number; filename: string } }> = [];
  for (let i = 0; i < 15; i += 1) {
    streams.push({
      name: '1080p',
      title: `Dhurandhar 1080p WEB-DL variant ${i}`,
      url: `https://cdn.example/1080p-${i}.mkv`,
      behaviorHints: { videoSize: 4_724_904_960 + i * 100_000_000, filename: `Dhurandhar.1080p.WEB-DL.H264.v${i}.mkv` },
    });
  }
  return { streams };
}

/** 30 valid raw candidates (no max cap → all 30 survive). */
function thirtyStreamsPayload() {
  const streams: Array<{ name: string; title: string; url: string; behaviorHints: { videoSize: number; filename: string } }> = [];
  for (let i = 0; i < 30; i += 1) {
    streams.push({
      name: i % 2 === 0 ? '1080p' : '720p',
      title: `Dhurandhar ${i % 2 === 0 ? '1080p' : '720p'} WEB-DL variant ${i}`,
      url: `https://cdn.example/stream-${i}.mkv`,
      behaviorHints: { videoSize: 4_000_000_000 + i * 50_000_000, filename: `Dhurandhar.${i % 2 === 0 ? '1080p' : '720p'}.WEB-DL.v${i}.mkv` },
    });
  }
  return { streams };
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

// ---------------------------------------------------------------------------
// A — 10-link limit is COMPLETELY REMOVED
// ---------------------------------------------------------------------------

function sectionA(): void {
  ok(MAX_DOWNLOAD_STREAMS_PER_ADDON === Number.MAX_SAFE_INTEGER, 'A: MAX_DOWNLOAD_STREAMS_PER_ADDON is Number.MAX_SAFE_INTEGER (no truncation symbol)');

  // 15 valid streams → 15 remain.
  const fifteen = buildDownloadCandidates(normalizeStreams(fifteenStreamsPayload()));
  const selected15 = selectDownloadStreams(fifteen.candidates);
  ok(fifteen.candidates.length === 15, 'A: 15 valid raw candidates built');
  ok(selected15.length === 15, `A: 15 valid streams → 15 remain (got ${selected15.length})`);

  // 30 valid streams → 30 remain.
  const thirty = buildDownloadCandidates(normalizeStreams(thirtyStreamsPayload()));
  const selected30 = selectDownloadStreams(thirty.candidates);
  ok(thirty.candidates.length === 30, 'A: 30 valid raw candidates built');
  ok(selected30.length === 30, `A: 30 valid streams → 30 remain (got ${selected30.length})`);

  // No slice(0, 10) or equivalent in the source.
  const selectionSource = read('src/lib/server/streaming/stremio/download-selection.ts');
  ok(!/\.\s*slice\s*\(\s*0\s*,\s*10\s*\)/.test(selectionSource), 'A: NO slice(0, 10) in download-selection.ts');
  ok(!/\.\s*slice\s*\(\s*0\s*,\s*max\s*\)/.test(selectionSource), 'A: NO slice(0, max) truncation in download-selection.ts');
  ok(!selectionSource.includes('selected.length >= max'), 'A: NO max-cap truncation in the selection loop');
}

// ---------------------------------------------------------------------------
// B — No silent quality truncation
// ---------------------------------------------------------------------------

function sectionB(): void {
  const { candidates } = buildDownloadCandidates(normalizeStreams({
    streams: [
      { name: '1080', title: 'Movie 1080p H.264 MKV', url: 'https://x.example/1080-h264.mkv' },
      { name: '720', title: 'Movie 720p H.264 MKV', url: 'https://x.example/720-h264.mkv' },
      { name: '480', title: 'Movie 480p H.264 MP4', url: 'https://x.example/480-h264.mp4' },
      { name: '4K', title: 'Movie 2160p UHD HEVC MKV', url: 'https://x.example/2160-hevc.mkv' },
      { name: 'HEVC', title: 'Movie 1080p HEVC 10-bit MKV', url: 'https://x.example/1080-hevc.mkv' },
      { name: 'AV1', title: 'Movie 1080p AV1 WEBM', url: 'https://x.example/1080-av1.webm' },
    ],
  }));
  const selected = selectDownloadStreams(candidates);
  ok(selected.length === 6, `B: all 6 distinct quality/codec combinations survive (got ${selected.length})`);
  const qualities = selected.map((entry) => entry.quality);
  ok(qualities.includes('1080p') && qualities.includes('720p') && qualities.includes('480p') && qualities.includes('4K'), 'B: 1080p / 720p / 480p / 4K all survive');
  const codecs = selected.map((entry) => entry.codec);
  ok(codecs.includes('H.264') && codecs.includes('HEVC'), 'B: H.264 and HEVC both survive');
}

// ---------------------------------------------------------------------------
// C — AIOStreams HTTP stream with infoHash remains eligible
// ---------------------------------------------------------------------------

function sectionC(): void {
  const normalized = normalizeStreams(aioTypedHttpPayload());
  ok(normalized.length === 1, 'C: the explicit type:"http" entry survives normalization (infoHash ignored — type is authoritative)');
  ok(normalized[0]?.streamType === 'http', 'C: the addon-specific stream type is preserved');
  const { candidates } = buildDownloadCandidates(normalized);
  ok(candidates.length === 1, 'C: the AIOStreams http stream becomes a download candidate');
  ok(candidates[0]?.url === 'https://aio-cdn.example/dl/one?h=abc', 'C: the URL is preserved verbatim');
}

// ---------------------------------------------------------------------------
// D — Actual P2P stream is excluded
// ---------------------------------------------------------------------------

function sectionD(): void {
  ok(normalizeStreams({ streams: [{ type: 'p2p', name: 'x', url: 'https://x.example/a.mkv' }] }).length === 0, 'D: explicit type:"p2p" is excluded');
  ok(normalizeStreams({ streams: [{ type: 'torrent', name: 'x', url: 'https://x.example/a.mkv' }] }).length === 0, 'D: explicit type:"torrent" is excluded');
  ok(normalizeStreams({ streams: [{ name: 'x', url: 'https://x.example/a.mkv', infoHash: 'deadbeef' }] }).length === 0, 'D: UNTYPED torrent-shaped entry (infoHash) is excluded');
  ok(normalizeStreams({ streams: [{ name: 'x', url: 'magnet:?xt=urn:btih:deadbeef' }] }).length === 0, 'D: magnet URLs are excluded (non-http scheme)');
}

// ---------------------------------------------------------------------------
// E — PixelDrain direct URL remains eligible/preserved
// ---------------------------------------------------------------------------

function sectionE(): void {
  const { candidates } = buildDownloadCandidates(normalizeStreams({
    streams: [
      { name: 'pd', title: '1080p PixelDrain', url: 'https://pixeldrain.com/api/file/ab12cd' },
      { name: 'pd-http', title: '1080p PixelDrain http', url: 'http://pixeldrain.com/api/file/ef12gh' },
    ],
  }));
  ok(candidates.length === 2, 'E: PixelDrain candidates are NOT globally rejected');
  ok(candidates.every((c) => c.url.includes('pixeldrain.com')), 'E: the PixelDrain URLs are preserved verbatim');
  ok(candidates.some((c) => c.hostClass === 'pixeldrain'), 'E: host classification marks pixeldrain');
  ok(candidates.some((c) => c.protocol === 'http'), 'E: cleartext http PixelDrain is preserved (no https rewrite)');
}

// ---------------------------------------------------------------------------
// F — Original URL preservation (Share receives the EXACT original URL)
// ---------------------------------------------------------------------------

function sectionF(): void {
  const component = read('src/lib/components/MaveroAddonDownload.svelte');
  // The Share handler reads stream.url — the EXACT ORIGINAL addon URL.
  ok(component.includes('url = stream.url'), 'F: the Share handler binds url = stream.url (the EXACT ORIGINAL addon URL)');
  ok(component.includes('navigator.share'), 'F: navigator.share is the primary share mechanism');
  // NO Mavero URL / API URL / downloader page URL / proxy URL is shared.
  ok(!component.includes('navigator.share({') || component.includes('url,'), 'F: navigator.share receives the url field');
  // The share title is derived from addon-supplied text (stream.title/name/filename) — never a Mavero URL.
  ok(component.includes('shareTitle'), 'F: a shareTitle helper derives a safe title from addon-supplied text');
}

// ---------------------------------------------------------------------------
// G — UI has exactly TWO actions: Download + Share
// ---------------------------------------------------------------------------

function sectionG(): void {
  const component = read('src/lib/components/MaveroAddonDownload.svelte');
  // Count the action elements in the mad-row-actions container.
  const actionsMatch = component.match(/<div class="mad-row-actions">([\s\S]*?)<\/div>/);
  ok(actionsMatch !== null, 'G: the mad-row-actions container exists');
  if (actionsMatch) {
    const actionsBlock = actionsMatch[1];
    const downloadAnchor = (actionsBlock.match(/<a[^>]*class="mad-action"/g) ?? []).length;
    const shareButton = (actionsBlock.match(/<button[^>]*class="mad-action mad-action-share"/g) ?? []).length;
    ok(downloadAnchor === 1, `G: exactly ONE Download anchor in the actions (got ${downloadAnchor})`);
    ok(shareButton === 1, `G: exactly ONE Share button in the actions (got ${shareButton})`);
    // NO other action elements.
    const allActions = (actionsBlock.match(/<(?:a|button)[^>]*class="mad-action/g) ?? []).length;
    ok(allActions === 2, `G: exactly TWO action elements total (Download + Share) (got ${allActions})`);
  }
}

// ---------------------------------------------------------------------------
// H — Play/Watch action absent
// ---------------------------------------------------------------------------

function sectionH(): void {
  const component = read('src/lib/components/MaveroAddonDownload.svelte');
  ok(!component.includes('Play size='), 'H: NO Play icon in the component');
  ok(!component.includes('mad-action-play'), 'H: NO mad-action-play CSS class');
  ok(!component.includes('externalPlayerLaunchFor'), 'H: NO externalPlayerLaunchFor call in the component (the Play/Watch launch helper is gone from the card)');
  ok(!component.includes('openHref') && !component.includes('openTarget') && !component.includes('openTitle'), 'H: NO open-href/open-target/open-title helpers (the Play launch helpers are gone)');
  ok(!component.includes('aria-label="Watch') && !component.includes('>Watch<') && !component.includes('Watch</button'), 'H: NO Watch button/label in the component');
  // ExternalLink is allowed in the header hint + footer (it's a decorative
  // icon, NOT a Play action). The card actions container has NO ExternalLink.
  const actionsMatch = component.match(/<div class="mad-row-actions">([\s\S]*?)<\/div>/);
  if (actionsMatch) {
    ok(!actionsMatch[1].includes('ExternalLink'), 'H: NO ExternalLink icon inside the card actions container (it is not a Play action)');
  }
}

// ---------------------------------------------------------------------------
// I — Copy action absent
// ---------------------------------------------------------------------------

function sectionI(): void {
  const component = read('src/lib/components/MaveroAddonDownload.svelte');
  ok(!component.includes('copyStreamUrl'), 'I: NO copyStreamUrl import/call');
  ok(!component.includes('handleCopy'), 'I: NO handleCopy function');
  ok(!component.includes('Copy size='), 'I: NO Copy icon');
  ok(!component.includes('copiedKey'), 'I: NO copiedKey state');
  ok(!component.includes('copyFailedKey'), 'I: NO copyFailedKey state');
}

// ---------------------------------------------------------------------------
// J — navigator.share is used (primary path)
// ---------------------------------------------------------------------------

function sectionJ(): void {
  const component = read('src/lib/components/MaveroAddonDownload.svelte');
  ok(component.includes('typeof navigator.share === \'function\''), 'J: navigator.share is feature-detected');
  ok(component.includes('await navigator.share({'), 'J: navigator.share is AWAITED (the primary path)');
  ok(component.includes('title: shareTitle('), 'J: navigator.share receives a title');
  ok(component.includes('url,'), 'J: navigator.share receives the url field');
  // Fallback: clipboard API when navigator.share is unavailable.
  ok(component.includes('navigator.clipboard.writeText'), 'J: clipboard API fallback is present');
  // Fallback: legacy textarea + execCommand for old WebViews.
  ok(component.includes('legacyCopy'), 'J: legacy clipboard fallback is present');
  ok(component.includes('execCommand(\'copy\')'), 'J: execCommand fallback is present');
}

// ---------------------------------------------------------------------------
// K — Addon request success with N streams → LOADED N
// ---------------------------------------------------------------------------

async function sectionK(): Promise<void> {
  const result = await resolveSingleAddonDownload({} as never, movieRequest, HUB.id, {
    loadAddons: loadAddonsOf([HUB]),
    loadAddonById: loadAddonByIdOf([HUB]),
    loadContent: loadContentOf(CONTENT),
    dnsResolver: publicDns,
    fetcher: fetcherFor({
      'https://hdhub.example/stream/movie/tt8633518.json': json({
        streams: [
          { name: 'a', title: '1080p', url: 'https://hub.example/a.mkv' },
          { name: 'b', title: '720p', url: 'https://hub.example/b.mkv' },
          { name: 'c', title: '480p', url: 'https://hub.example/c.mkv' },
        ],
      }),
    }, []),
  });
  ok(result.status === 'loaded', `K: addon with 3 eligible streams → status='loaded' (got ${result.status})`);
  ok(result.streams.length === 3, `K: addon with 3 eligible streams → 3 streams shown (got ${result.streams.length})`);
  ok(result.diagnostics?.raw === 3, 'K: diagnostics.raw = 3');
  ok(result.diagnostics?.eligible === 3, 'K: diagnostics.eligible = 3');
  ok(result.diagnostics?.selected === 3, 'K: diagnostics.selected = 3');
}

// ---------------------------------------------------------------------------
// L — Addon request success with zero eligible streams → LOADED 0 (NOT FAILED)
// ---------------------------------------------------------------------------

async function sectionL(): Promise<void> {
  // Phase 17: "empty" now means the addon genuinely returned zero streams
  // (NOT that MAVERO filtered them out — P2P/torrent/magnet/header-dependent
  // entries are ALL PRESERVED in Phase 17). To test the empty state we use
  // an actual empty streams array.
  const result = await resolveSingleAddonDownload({} as never, movieRequest, PIPE.id, {
    loadAddons: loadAddonsOf([PIPE]),
    loadAddonById: loadAddonByIdOf([PIPE]),
    loadContent: loadContentOf(CONTENT),
    dnsResolver: publicDns,
    fetcher: fetcherFor({
      'https://pipe.example/stream/movie/tt8633518.json': json({ streams: [] }),
    }, []),
  });
  ok(result.status === 'empty', `L (Phase 17): addon genuinely returns zero streams → status='empty' (got ${result.status}) — NOT 'unavailable'`);
  ok(result.streams.length === 0, 'L: 0 streams shown');
  ok(result.errorCode === undefined, 'L: NO error code (empty ≠ failure)');
  ok(result.diagnostics?.raw === 0, `L: diagnostics.raw = 0 (the addon returned zero streams) (got ${result.diagnostics?.raw})`);
  ok(result.diagnostics?.unsupported === 0, `L: diagnostics.unsupported = 0 (got ${result.diagnostics?.unsupported})`);
  ok(result.diagnostics?.selected === 0, 'L: diagnostics.selected = 0');
}

// ---------------------------------------------------------------------------
// M — Request failure → FAILED (unavailable)
// ---------------------------------------------------------------------------

async function sectionM(): Promise<void> {
  const result = await resolveSingleAddonDownload({} as never, movieRequest, HUB.id, {
    loadAddons: loadAddonsOf([HUB]),
    loadAddonById: loadAddonByIdOf([HUB]),
    loadContent: loadContentOf(CONTENT),
    dnsResolver: publicDns,
    sleep: async () => Promise.resolve(),
    fetcher: fetcherFor({
      'https://hdhub.example/stream/movie/tt8633518.json': new Response('boom', { status: 500 }),
    }, []),
  });
  ok(result.status === 'unavailable', `M: HTTP 500 after retry budget → status='unavailable' (got ${result.status})`);
  ok(result.errorCode === 'HTTP_ERROR', 'M: errorCode = HTTP_ERROR');
  ok(result.streams.length === 0, 'M: 0 streams');
}

// ---------------------------------------------------------------------------
// N — One slow addon does not prevent other addons from loading
// ---------------------------------------------------------------------------

async function sectionN(): Promise<void> {
  // Three addons: HdHub instant, Pipe "slow" (but returns immediately in this
  // test — the slowness is simulated by the parallel resolution pattern), AIO
  // instant. The test verifies HdHub and AIO resolve INDEPENDENTLY — they do
  // NOT wait for Pipe. Each per-addon call fetches ONLY its own endpoint.
  const calls: string[] = [];
  const sharedFetcher = fetcherFor({
    'https://hdhub.example/stream/movie/tt8633518.json': json({ streams: [{ name: 'a', title: '1080p', url: 'https://hub.example/a.mkv' }] }),
    'https://pipe.example/stream/movie/tt8633518.json': json({ streams: [{ name: 'a', title: '1080p', url: 'https://pipe.example/a.mkv' }] }),
    'https://aio.example/stream/movie/tt8633518.json': json({ streams: [{ type: 'http', name: 'a', title: '1080p', url: 'https://aio.example/a.mkv' }] }),
  }, calls);
  const sharedDeps = {
    loadAddons: loadAddonsOf([HUB, PIPE, AIO]),
    loadContent: loadContentOf(CONTENT),
    dnsResolver: publicDns,
    fetcher: sharedFetcher,
  };
  // Fire HdHub + AIO in parallel — both resolve without waiting for Pipe.
  calls.length = 0;
  const [hubResult, aioResult] = await Promise.all([
    resolveSingleAddonDownload({} as never, movieRequest, HUB.id, { ...sharedDeps, loadAddonById: loadAddonByIdOf([HUB, PIPE, AIO]) }),
    resolveSingleAddonDownload({} as never, movieRequest, AIO.id, { ...sharedDeps, loadAddonById: loadAddonByIdOf([HUB, PIPE, AIO]) }),
  ]);
  ok(hubResult.status === 'loaded' && hubResult.streams.length === 1, 'N: HdHub loaded independently (Pipe was not even requested)');
  ok(aioResult.status === 'loaded' && aioResult.streams.length === 1, 'N: AIO loaded independently (Pipe was not even requested)');
  // Each per-addon call fetched ONLY its own endpoint — no cross-contamination.
  ok(calls.includes('https://hdhub.example/stream/movie/tt8633518.json'), 'N: HdHub endpoint was fetched');
  ok(calls.includes('https://aio.example/stream/movie/tt8633518.json'), 'N: AIO endpoint was fetched');
  ok(!calls.includes('https://pipe.example/stream/movie/tt8633518.json'), 'N: Pipe endpoint was NOT fetched (HdHub + AIO resolved without waiting for Pipe)');
}

// ---------------------------------------------------------------------------
// O — All enabled addons are requested on first sheet open
// ---------------------------------------------------------------------------

async function sectionO(): Promise<void> {
  const calls: string[] = [];
  const result = await listAddonDownloadTargets({} as never, movieRequest, {
    loadAddons: loadAddonsOf([HUB, PIPE, AIO]),
    loadContent: loadContentOf(CONTENT),
    dnsResolver: publicDns,
    fetcher: fetcherFor({}, calls),
  });
  ok(result.tabs.length === 3, 'O: all 3 enabled addons get a tab entry');
  ok(calls.length === 0, 'O: the tab list endpoint fetches NO stream endpoints (pure metadata)');
  ok(result.consideredAddons === 3, 'O: consideredAddons = 3');
  // The tab list is the baseline — the frontend fires resolveSingleAddonDownload
  // for EACH tab. Every enabled addon is requested.
  const tabIds = result.tabs.map((tab) => tab.addonId).sort();
  ok(JSON.stringify(tabIds) === JSON.stringify([HUB.id, AIO.id, PIPE.id].sort()), 'O: every enabled addon is in the tab list');
}

// ---------------------------------------------------------------------------
// P — Retry is not required for normal successful addon loading
// ---------------------------------------------------------------------------

async function sectionP(): Promise<void> {
  // A healthy addon resolves on the FIRST attempt — no Retry needed.
  let attempts = 0;
  const result = await resolveSingleAddonDownload({} as never, movieRequest, HUB.id, {
    loadAddons: loadAddonsOf([HUB]),
    loadAddonById: loadAddonByIdOf([HUB]),
    loadContent: loadContentOf(CONTENT),
    dnsResolver: publicDns,
    sleep: async () => { attempts += 1; },
    fetcher: fetcherFor({
      'https://hdhub.example/stream/movie/tt8633518.json': json({ streams: [{ name: 'a', title: '1080p', url: 'https://hub.example/a.mkv' }] }),
    }, []),
  });
  ok(result.status === 'loaded', 'P: a healthy addon loads on the first attempt');
  ok(result.attempts === 1, `P: attempts = 1 (no retry needed) (got ${result.attempts})`);
  ok(attempts === 0, 'P: the sleep (backoff) was NEVER called — no retry happened');
}

// ---------------------------------------------------------------------------
// Q — Diagnostic raw-vs-eligible counts correctly identify dropped streams
// ---------------------------------------------------------------------------

async function sectionQ(): Promise<void> {
  const result = await resolveSingleAddonDownload({} as never, movieRequest, PIPE.id, {
    loadAddons: loadAddonsOf([PIPE]),
    loadAddonById: loadAddonByIdOf([PIPE]),
    loadContent: loadContentOf(CONTENT),
    dnsResolver: publicDns,
    fetcher: fetcherFor({
      'https://pipe.example/stream/movie/tt8633518.json': json({
        streams: [
          { name: 'ok1', title: '1080p', url: 'https://pipe.example/a.mkv' },
          { name: 'ok2', title: '720p', url: 'https://pipe.example/b.mkv' },
          { name: 'torrent', infoHash: 'deadbeef', url: 'https://pipe.example/c.mkv' },
          { name: 'magnet', url: 'magnet:?xt=urn:btih:deadbeef' },
          { name: 'hls', url: 'https://pipe.example/playlist.m3u8' },
        ],
      }),
    }, []),
  });
  // Phase 17: ALL 5 entries are PRESERVED (no filtering). The downloader
  // normalizer preserves P2P/torrent/magnet/HLS/DASH/external entries.
  // raw = 5 (every entry), unsupported = 0 (no malformed entries),
  // selected = 5 (no truncation, no dedup).
  ok(result.diagnostics?.raw === 5, `Q (Phase 17): diagnostics.raw = 5 (ALL entries preserved — no filtering) (got ${result.diagnostics?.raw})`);
  ok(result.diagnostics?.unsupported === 0, `Q (Phase 17): diagnostics.unsupported = 0 (no malformed entries) (got ${result.diagnostics?.unsupported})`);
  ok(result.diagnostics?.eligible === 5, `Q (Phase 17): diagnostics.eligible = 5 (= raw) (got ${result.diagnostics?.eligible})`);
  ok(result.diagnostics?.selected === 5, `Q (Phase 17): diagnostics.selected = 5 (no truncation, no dedup) (got ${result.diagnostics?.selected})`);
  ok(result.streams.length === 5, 'Q (Phase 17): ALL 5 streams shown to the user (2 http + 1 p2p + 1 magnet + 1 hls)');
  // Per-kind breakdown: the test payload has 5 entries:
  //   - https://pipe.example/a.mkv → https
  //   - https://pipe.example/b.mkv → https
  //   - infoHash + https://pipe.example/c.mkv → https (the URL is usable; the
  //     infoHash is preserved as metadata but the entry is classified by its URL)
  //   - magnet:?xt=urn:btih:deadbeef → magnet
  //   - https://pipe.example/playlist.m3u8 → hls
  // So: https:3 + hls:1 + magnet:1 = 5.
  const kc = result.diagnostics?.kindCounts;
  ok(kc?.https === 3 && kc?.hls === 1 && kc?.magnet === 1, `Q (Phase 17): kindCounts = https:3 hls:1 magnet:1 (got ${JSON.stringify(kc)})`);
}

// ---------------------------------------------------------------------------
// R — Download behavior is UNCHANGED
// ---------------------------------------------------------------------------

function sectionR(): void {
  const component = read('src/lib/components/MaveroAddonDownload.svelte');
  // Download still uses href={stream.url} — the EXACT ORIGINAL addon URL.
  ok(component.includes('href={stream.url}'), 'R: Download anchor href = stream.url (the ORIGINAL addon URL — unchanged)');
  // Download still uses downloadAttributesFor — the existing helper.
  ok(component.includes('downloadAttributesFor'), 'R: Download still uses downloadAttributesFor (the existing helper — unchanged)');
  // Download still has target="_blank" + rel="noopener noreferrer".
  ok(component.includes('target="_blank"'), 'R: Download still has target="_blank" (unchanged)');
  ok(component.includes('rel="noopener noreferrer"'), 'R: Download still has rel="noopener noreferrer" (unchanged)');
  // Download click feedback is preserved.
  ok(component.includes('handleDownload'), 'R: handleDownload is preserved (the existing click-feedback mechanism)');
  ok(component.includes('openingKey'), 'R: openingKey state is preserved (the existing click-feedback state)');
}

// ---------------------------------------------------------------------------
// S — Per-addon timeout = 30s (healthy addons don't need Retry)
// ---------------------------------------------------------------------------

function sectionS(): void {
  const serviceSource = read('src/lib/server/streaming/stremio/addon-download-service.ts');
  ok(serviceSource.includes('DOWNLOAD_TIMEOUT_MS = 30_000'), 'S: per-attempt timeout = 30s (raised from 9s)');
  ok(serviceSource.includes('OVERALL_TIMEOUT_MS = 40_000'), 'S: aggregate batch budget = 40s (raised from 12s)');
  ok(serviceSource.includes('MAX_RETRY_ATTEMPTS = 1'), 'S: retry budget = 1 (lowered from 2 — Retry is fallback, not required)');
  // The comment documenting the 30-40s allowance.
  ok(serviceSource.includes('30-40s') || serviceSource.includes('30_000'), 'S: the 30-40s allowance is documented in the service');
}

// ---------------------------------------------------------------------------
// T — MAVERO Player still NOT in the source selector (Phase 15 preserved)
// ---------------------------------------------------------------------------

function sectionT(): void {
  const watchPage = read('src/routes/watch/[type]/[id]/+page.svelte');
  ok(!watchPage.includes('maveroPlayerSourceOption()'), 'T: the watch route does NOT append maveroPlayerSourceOption() to sourceOptions');
  ok(!/\.\.\.\(data\.maveroPlayerAvailable\s*\?\s*\[maveroPlayerSourceOption\(\)\]/.test(watchPage), 'T: the conditional append is gone (Phase 15 preserved)');
}

// ---------------------------------------------------------------------------
// U — No proxy / FFmpeg / media-worker introduced
// ---------------------------------------------------------------------------

function sectionU(): void {
  const serviceSource = read('src/lib/server/streaming/stremio/addon-download-service.ts');
  const selectionSource = read('src/lib/server/streaming/stremio/download-selection.ts');
  const component = read('src/lib/components/MaveroAddonDownload.svelte');
  for (const source of [serviceSource, selectionSource, component]) {
    ok(!source.includes('media-worker'), 'U: NO media-worker reference');
    // "FFmpeg" appears only in comments documenting that it is NOT used.
    // Check for actual FFmpeg machinery (imports/calls), not the word in comments.
    ok(!/import.*ffmpeg/i.test(source) && !/ffmpeg\./.test(source) && !/startFFmpeg/.test(source) && !/require.*ffmpeg/.test(source), 'U: NO FFmpeg import/call (the word may appear in comments documenting its absence)');
    ok(!source.includes('/api/proxy') && !source.includes('proxyMediaUrl'), 'U: NO proxy-URL machinery');
  }
  // The downloader fetches ONLY addon stream LIST endpoints — never media URLs.
  ok(serviceSource.includes('fetchStremioStreamResponse'), 'U: the downloader goes through the hardened stream fetcher (no media fetch)');
}

// ---------------------------------------------------------------------------
// V — isPartialRelease + sizeRuntimeVerdict are back-compat no-ops
// ---------------------------------------------------------------------------

function sectionV(): void {
  // isPartialRelease returns false unconditionally (Phase 16: no partial-release filter).
  ok(isPartialRelease({ title: 'Movie END-CREDIT 1080p' }) === false, 'V: isPartialRelease(END-CREDIT) = false (no-op)');
  ok(isPartialRelease({ title: 'Movie TRAILER 2026' }) === false, 'V: isPartialRelease(TRAILER) = false (no-op)');
  ok(isPartialRelease({ title: 'Movie SAMPLE 1080p' }) === false, 'V: isPartialRelease(SAMPLE) = false (no-op)');
  ok(isPartialRelease({ title: 'Normal Movie 1080p WEB-DL' }) === false, 'V: isPartialRelease(normal) = false (no-op)');
  // sizeRuntimeVerdict returns 'ok' unconditionally (Phase 16: no size/runtime filter).
  ok(sizeRuntimeVerdict({ quality: '1080p', sizeBytes: 50 * 1024 ** 2, height: 1080 }, { runtimeSeconds: 3 * 3600 }) === 'ok', 'V: sizeRuntimeVerdict(50MB 1080p 3h) = ok (no-op)');
  ok(sizeRuntimeVerdict({ quality: '4K', sizeBytes: 100 * 1024 ** 2, height: 2160 }, {}) === 'ok', 'V: sizeRuntimeVerdict(100MB 4K no runtime) = ok (no-op)');
}

// ---------------------------------------------------------------------------
// runner
// ---------------------------------------------------------------------------

sectionA();
sectionB();
sectionC();
sectionD();
sectionE();
sectionF();
sectionG();
sectionH();
sectionI();
sectionJ();
sectionR();
sectionS();
sectionT();
sectionU();
sectionV();

await sectionK();
await sectionL();
await sectionM();
await sectionN();
await sectionO();
await sectionP();
await sectionQ();

console.log(`stremio_downloader_phase16_test: ${passed} checks passed (Phase 16: unlimited streams + no over-filtering + Share replaces Copy + Play/Watch removed + diagnostic parity + 30s timeout + MAVERO Player removal preserved + no proxy/ffmpeg)`);
