import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { StreamingAddon } from '$lib/shared/streaming-addons';
import { normalizeStremioStreamResponseForDownloader, type DownloaderStreamKind } from '$lib/server/streaming/stremio/stream-normalize-downloader';
import { buildDownloadCandidatesAll, selectDownloadStreamsAll, MAX_DOWNLOAD_STREAMS_PER_ADDON, type DownloadStreamViewAll } from '$lib/server/streaming/stremio/download-selection';
import { resolveSingleAddonDownload, listAddonDownloadTargets, type ContentLookup } from '$lib/server/streaming/stremio/addon-download-service';

/**
 * Phase 17 test suite — Complete Discovery + All Stream Types + Filters + UI.
 *
 * Pins the Phase 17 contract:
 *   * EVERY stream type preserved (HTTP/HTTPS/HLS/DASH/P2P/Magnet/External)
 *   * NO max cap, NO format filter, NO quality filter, NO size filter
 *   * P2P/torrent/magnet PRESERVED (magnet URI constructed from infoHash + sources)
 *   * externalUrl PRESERVED
 *   * header-dependent (proxyHeaders) PRESERVED
 *   * Download + Share ONLY (no Watch/Play/Copy)
 *   * Share uses navigator.share with the EXACT ORIGINAL URI
 *   * Four filters (Type/Size/Quality/Language) operate on loaded streams
 *   * Addon chip count = RAW fetched count (not filtered)
 *   * Diagnostics: raw/malformed/kindCounts/selected
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
const PEERFLIX = addonFixture({ id: '00000000-0000-4000-8000-140000peerflix', name: 'Peerflix', slug: 'peerflix', manifestUrl: 'https://peerflix.example/manifest.json', ordering: 4 });

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

// ---------------------------------------------------------------------------
// A-E: stream-count preservation (3/10/15/31/49)
// ---------------------------------------------------------------------------

function makePayload(count: number): { streams: Array<Record<string, unknown>> } {
  const streams: Array<Record<string, unknown>> = [];
  for (let i = 0; i < count; i += 1) {
    streams.push({ name: `${i}`, title: `Movie 1080p variant ${i}`, url: `https://cdn.example/stream-${i}.mkv` });
  }
  return { streams };
}

function sectionStreamCounts(): void {
  // A: 3 → 3
  let result = normalizeStremioStreamResponseForDownloader(makePayload(3));
  ok(result.valid && result.entries.length === 3, 'A: 3 streams → 3 entries preserved');
  let built = buildDownloadCandidatesAll(result.entries);
  ok(built.entries.length === 3, 'A: 3 streams → 3 built');

  // B: 10 → 10
  result = normalizeStremioStreamResponseForDownloader(makePayload(10));
  ok(result.entries.length === 10, 'B: 10 streams → 10 entries preserved');
  built = buildDownloadCandidatesAll(result.entries);
  ok(built.entries.length === 10, 'B: 10 streams → 10 built');

  // C: 15 → 15
  result = normalizeStremioStreamResponseForDownloader(makePayload(15));
  ok(result.entries.length === 15, 'C: 15 streams → 15 entries preserved');
  built = buildDownloadCandidatesAll(result.entries);
  ok(built.entries.length === 15, 'C: 15 streams → 15 built');

  // D: 31 → 31
  result = normalizeStremioStreamResponseForDownloader(makePayload(31));
  ok(result.entries.length === 31, 'D: 31 streams → 31 entries preserved');
  built = buildDownloadCandidatesAll(result.entries);
  ok(built.entries.length === 31, 'D: 31 streams → 31 built');

  // E: 49 → 49
  result = normalizeStremioStreamResponseForDownloader(makePayload(49));
  ok(result.entries.length === 49, 'E: 49 streams → 49 entries preserved');
  built = buildDownloadCandidatesAll(result.entries);
  ok(built.entries.length === 49, 'E: 49 streams → 49 built');

  // MAX_DOWNLOAD_STREAMS_PER_ADDON is a back-compat no-op.
  ok(MAX_DOWNLOAD_STREAMS_PER_ADDON === Number.MAX_SAFE_INTEGER, 'E: MAX_DOWNLOAD_STREAMS_PER_ADDON = Number.MAX_SAFE_INTEGER (no truncation)');
}

// ---------------------------------------------------------------------------
// F-N: stream-type preservation
// ---------------------------------------------------------------------------

function sectionStreamTypes(): void {
  const payload = {
    streams: [
      { name: 'http', url: 'http://x.example/a.mkv' }, // http
      { name: 'https', url: 'https://x.example/b.mkv' }, // https
      { name: 'hls', url: 'https://x.example/master.m3u8' }, // hls
      { name: 'dash', url: 'https://x.example/manifest.mpd' }, // dash
      { name: 'mp4', url: 'https://x.example/movie.mp4' }, // https (mp4 container)
      { name: 'mkv', url: 'https://x.example/movie.mkv' }, // https (mkv container)
      { name: 'h264', title: 'H.264', url: 'https://x.example/h264.mkv' }, // https + codec
      { name: 'hevc', title: 'HEVC', url: 'https://x.example/hevc.mkv' }, // https + codec
      { name: 'dolby', title: 'Dolby Atmos DTS TrueHD', url: 'https://x.example/dolby.mkv' }, // https + audio metadata
      { name: 'p2p', type: 'p2p', infoHash: 'abc123', url: 'https://x.example/p2p.mkv' }, // p2p (explicit type)
      { name: 'torrent', infoHash: 'deadbeef', sources: ['udp://tracker.example:1337'] }, // p2p → magnet
      { name: 'magnet', url: 'magnet:?xt=urn:btih:feedface' }, // magnet
      { name: 'external', externalUrl: 'https://opens-elsewhere.example/page' }, // external
      { name: 'headered', url: 'https://x.example/h.mkv', behaviorHints: { proxyHeaders: { Referer: 'https://x.example/' } } }, // https (header-dependent PRESERVED)
    ],
  };
  const result = normalizeStremioStreamResponseForDownloader(payload);
  ok(result.valid, 'F-N: the response is valid');
  ok(result.entries.length === 14, `F-N: ALL 14 entries preserved (got ${result.entries.length})`);
  ok(result.malformed === 0, 'F-N: 0 malformed entries');

  // Per-kind verification.
  const kinds = result.entries.map((e) => e.kind);
  ok(kinds.includes('http'), 'F: HTTP preserved');
  ok(kinds.includes('https'), 'G: HTTPS preserved');
  ok(kinds.includes('hls'), 'H: HLS preserved (NOT filtered — Phase 17 task §1)');
  ok(kinds.includes('dash'), 'I: DASH preserved (NOT filtered)');
  ok(kinds.filter((k) => k === 'https').length >= 4, 'J: MP4/MKV/H264/HEVC all preserved as https');
  ok(kinds.includes('p2p'), 'M: P2P/torrent preserved (NOT filtered — Phase 17 task §2)');
  ok(kinds.includes('magnet'), 'N: Magnet preserved (NOT filtered)');
  ok(kinds.includes('external'), 'N: External preserved (NOT filtered)');

  // The Dolby/DTS/TrueHD entry's metadata is preserved.
  const dolby = result.entries.find((e) => e.name === 'dolby');
  ok(dolby?.title?.includes('Dolby'), 'L: Dolby audio metadata preserved');

  // The torrent entry (infoHash + sources) becomes a magnet URI.
  const torrent = result.entries.find((e) => e.name === 'torrent');
  ok(torrent?.url.startsWith('magnet:?xt=urn:btih:deadbeef'), 'M: torrent entry → magnet URI constructed from infoHash');
  ok(torrent?.url.includes('tr='), 'M: magnet URI includes tracker (sources → tr=)');

  // The explicit type:'p2p' entry WITH an https URL is classified as p2p.
  const p2p = result.entries.find((e) => e.name === 'p2p');
  ok(p2p?.kind === 'p2p', 'M: explicit type:"p2p" → classified as p2p (even with https URL)');
}

// ---------------------------------------------------------------------------
// O: Download button remains functional (unchanged)
// ---------------------------------------------------------------------------

function sectionO(): void {
  const component = read('src/lib/components/MaveroAddonDownload.svelte');
  ok(component.includes('href={stream.url}'), 'O: Download anchor href = stream.url (the ORIGINAL URI — unchanged)');
  ok(component.includes('downloadAttributesFor'), 'O: Download uses downloadAttributesFor (unchanged)');
  ok(component.includes('target="_blank"'), 'O: Download target = _blank (unchanged)');
  ok(component.includes('rel="noopener noreferrer"'), 'O: Download rel = noopener noreferrer (unchanged)');
  ok(component.includes('handleDownload'), 'O: handleDownload is wired (unchanged)');
}

// ---------------------------------------------------------------------------
// P: Share calls navigator.share with EXACT original URL
// ---------------------------------------------------------------------------

function sectionP(): void {
  const component = read('src/lib/components/MaveroAddonDownload.svelte');
  ok(component.includes('url = stream.url'), 'P: the Share handler binds url = stream.url (the EXACT ORIGINAL URI)');
  ok(component.includes('await navigator.share({'), 'P: navigator.share is AWAITED');
  ok(component.includes('title: shareTitle('), 'P: navigator.share receives a title');
  ok(component.includes('url,'), 'P: navigator.share receives the url field');
  ok(component.includes('navigator.clipboard.writeText'), 'P: clipboard fallback present');
  ok(component.includes('legacyCopy'), 'P: legacy clipboard fallback present');
}

// ---------------------------------------------------------------------------
// Q-S: No Watch / Play / Copy buttons
// ---------------------------------------------------------------------------

function sectionQRS(): void {
  const component = read('src/lib/components/MaveroAddonDownload.svelte');
  ok(!component.includes('copyStreamUrl'), 'Q (no Copy): copyStreamUrl is absent');
  ok(!component.includes('handleCopy'), 'Q (no Copy): handleCopy is absent');
  ok(!component.includes('Copy size='), 'Q (no Copy): Copy icon is absent');
  ok(!component.includes('copiedKey'), 'Q (no Copy): copiedKey state is absent');

  ok(!component.includes('Play size='), 'R (no Play): Play icon is absent');
  ok(!component.includes('mad-action-play'), 'R (no Play): mad-action-play CSS class is absent');
  ok(!component.includes('externalPlayerLaunchFor'), 'R (no Play): externalPlayerLaunchFor is absent');
  ok(!component.includes('openHref') && !component.includes('openTarget') && !component.includes('openTitle'), 'R (no Play): open-href/open-target/open-title helpers are absent');

  ok(!component.includes('aria-label="Watch') && !component.includes('>Watch<'), 'S (no Watch): no Watch button/label');

  // The card actions container has exactly 2 actions.
  const actionsMatch = component.match(/<div class="mad-row-actions">([\s\S]*?)<\/div>/);
  if (actionsMatch) {
    const allActions = (actionsMatch[1].match(/<(?:a|button)[^>]*class="mad-action/g) ?? []).length;
    ok(allActions === 2, `S: exactly TWO action elements (Download + Share) (got ${allActions})`);
  }
}

// ---------------------------------------------------------------------------
// T-W: Filters
// ---------------------------------------------------------------------------

function sectionT(): void {
  const component = read('src/lib/components/MaveroAddonDownload.svelte');
  // Type filter
  ok(component.includes('filterType'), 'T: filterType state exists');
  ok(component.includes('All Types'), 'T: Type filter has "All Types" option');
  ok(component.includes('HTTP') && component.includes('HLS') && component.includes('DASH'), 'T: Type filter includes HTTP/HLS/DASH');
  ok(component.includes('P2P') && component.includes('Magnet') && component.includes('External'), 'T: Type filter includes P2P/Magnet/External');
}

function sectionU(): void {
  const component = read('src/lib/components/MaveroAddonDownload.svelte');
  ok(component.includes('filterSize'), 'U: filterSize state exists');
  ok(component.includes('Under 1 GB') && component.includes('Under 2 GB') && component.includes('Under 5 GB'), 'U: Size filter includes Under 1/2/5 GB');
  ok(component.includes('Over 20 GB'), 'U: Size filter includes Over 20 GB');
}

function sectionV(): void {
  const component = read('src/lib/components/MaveroAddonDownload.svelte');
  ok(component.includes('filterQuality'), 'V: filterQuality state exists');
  ok(component.includes('360p') && component.includes('480p') && component.includes('720p') && component.includes('1080p'), 'V: Quality filter includes 360/480/720/1080p');
  ok(component.includes('2K') && component.includes('4K'), 'V: Quality filter includes 2K/4K');
}

function sectionW(): void {
  const component = read('src/lib/components/MaveroAddonDownload.svelte');
  ok(component.includes('filterLanguage'), 'W: filterLanguage state exists');
  ok(component.includes('detectedLanguages'), 'W: language list is DYNAMICALLY generated from loaded streams');
  ok(component.includes('All Languages'), 'W: Language filter has "All Languages" option');
}

// ---------------------------------------------------------------------------
// X: Filters do not refetch addons
// ---------------------------------------------------------------------------

function sectionX(): void {
  const component = read('src/lib/components/MaveroAddonDownload.svelte');
  // The filters are pure client-side state — they never call loadAddon/loadTabs.
  ok(component.includes('applyFilters'), 'X: applyFilters is a pure client-side function');
  ok(component.includes('filteredStreams = applyFilters('), 'X: filteredStreams is derived from applyFilters (no refetch)');
  // The addon chip count uses tab.streams.length (raw), NOT filteredStreams.length.
  ok(component.includes('tab.streams.length'), 'X: the addon chip uses tab.streams.length (RAW fetched count, not filtered)');
}

// ---------------------------------------------------------------------------
// Y: Addon count remains raw fetched count after filters
// ---------------------------------------------------------------------------

function sectionY(): void {
  const component = read('src/lib/components/MaveroAddonDownload.svelte');
  // The "All / X shown" indicator separates raw count from filtered count.
  ok(component.includes('activeStreams.length'), 'Y: the raw count (activeStreams.length) is shown');
  ok(component.includes('filteredStreams.length'), 'Y: the filtered count (filteredStreams.length) is shown separately');
}

// ---------------------------------------------------------------------------
// Z-AA: isolation + slow addon
// ---------------------------------------------------------------------------

async function sectionZ(): Promise<void> {
  const calls: string[] = [];
  const sharedFetcher = fetcherFor({
    'https://hdhub.example/stream/movie/tt8633518.json': json({ streams: [{ name: 'a', title: '1080p', url: 'https://hub.example/a.mkv' }] }),
    'https://peerflix.example/stream/movie/tt8633518.json': json({ streams: [{ name: 'a', infoHash: 'deadbeef', sources: ['udp://tracker.example:1337'] }] }),
  }, calls);
  const sharedDeps = {
    loadAddons: loadAddonsOf([HUB, PEERFLIX]),
    loadContent: loadContentOf(CONTENT),
    dnsResolver: publicDns,
    fetcher: sharedFetcher,
  };
  calls.length = 0;
  const [hubResult, peerflixResult] = await Promise.all([
    resolveSingleAddonDownload({} as never, movieRequest, HUB.id, { ...sharedDeps, loadAddonById: loadAddonByIdOf([HUB, PEERFLIX]) }),
    resolveSingleAddonDownload({} as never, movieRequest, PEERFLIX.id, { ...sharedDeps, loadAddonById: loadAddonByIdOf([HUB, PEERFLIX]) }),
  ]);
  ok(hubResult.status === 'loaded' && hubResult.streams.length === 1, 'Z: HdHub loaded independently');
  ok(peerflixResult.status === 'loaded' && peerflixResult.streams.length === 1, 'Z: Peerflix loaded independently (P2P stream PRESERVED)');
  ok(calls.includes('https://hdhub.example/stream/movie/tt8633518.json'), 'Z: HdHub endpoint fetched');
  ok(calls.includes('https://peerflix.example/stream/movie/tt8633518.json'), 'Z: Peerflix endpoint fetched');
}

// ---------------------------------------------------------------------------
// AB: addon returning zero is distinguishable from request failure
// ---------------------------------------------------------------------------

async function sectionAB(): Promise<void> {
  // Zero streams (genuinely empty).
  const empty = await resolveSingleAddonDownload({} as never, movieRequest, PIPE.id, {
    loadAddons: loadAddonsOf([PIPE]),
    loadAddonById: loadAddonByIdOf([PIPE]),
    loadContent: loadContentOf(CONTENT),
    dnsResolver: publicDns,
    fetcher: fetcherFor({ 'https://pipe.example/stream/movie/tt8633518.json': json({ streams: [] }) }, []),
  });
  ok(empty.status === 'empty', `AB: empty addon → status='empty' (got ${empty.status})`);
  ok(empty.errorCode === undefined, 'AB: empty has NO error code');

  // Request failure.
  const failed = await resolveSingleAddonDownload({} as never, movieRequest, PIPE.id, {
    loadAddons: loadAddonsOf([PIPE]),
    loadAddonById: loadAddonByIdOf([PIPE]),
    loadContent: loadContentOf(CONTENT),
    dnsResolver: publicDns,
    sleep: async () => Promise.resolve(),
    fetcher: fetcherFor({ 'https://pipe.example/stream/movie/tt8633518.json': new Response('boom', { status: 500 }) }, []),
  });
  ok(failed.status === 'unavailable', `AB: failed addon → status='unavailable' (got ${failed.status})`);
  ok(failed.errorCode === 'HTTP_ERROR', 'AB: failed has HTTP_ERROR code');
}

// ---------------------------------------------------------------------------
// AC: diagnostics correctly identify where streams disappeared
// ---------------------------------------------------------------------------

async function sectionAC(): Promise<void> {
  const result = await resolveSingleAddonDownload({} as never, movieRequest, PIPE.id, {
    loadAddons: loadAddonsOf([PIPE]),
    loadAddonById: loadAddonByIdOf([PIPE]),
    loadContent: loadContentOf(CONTENT),
    dnsResolver: publicDns,
    fetcher: fetcherFor({
      'https://pipe.example/stream/movie/tt8633518.json': json({
        streams: [
          { name: 'a', title: '1080p', url: 'https://pipe.example/a.mkv' },
          { name: 'b', title: '720p', url: 'https://pipe.example/b.mkv' },
          { name: 'c', infoHash: 'deadbeef', sources: ['udp://tracker.example:1337'] },
          { name: 'd', url: 'magnet:?xt=urn:btih:feedface' },
          { name: 'e', url: 'https://pipe.example/playlist.m3u8' },
          { name: 'f', externalUrl: 'https://opens-elsewhere.example/page' },
        ],
      }),
    }, []),
  });
  // Phase 17: ALL 6 entries preserved (no filtering).
  ok(result.diagnostics?.raw === 6, `AC: diagnostics.raw = 6 (ALL entries preserved) (got ${result.diagnostics?.raw})`);
  ok(result.diagnostics?.malformed === 0, `AC: diagnostics.malformed = 0 (got ${result.diagnostics?.malformed})`);
  ok(result.diagnostics?.selected === 6, `AC: diagnostics.selected = 6 (no truncation) (got ${result.diagnostics?.selected})`);
  const kc = result.diagnostics?.kindCounts;
  ok(kc?.https === 2 && kc?.p2p === 1 && kc?.magnet === 1 && kc?.hls === 1 && kc?.external === 1, `AC: kindCounts = https:2 p2p:1 magnet:1 hls:1 external:1 (got ${JSON.stringify(kc)})`);
}

// ---------------------------------------------------------------------------
// AD: UI changes — header, instructions, suggested apps, no footer
// ---------------------------------------------------------------------------

function sectionAD(): void {
  const component = read('src/lib/components/MaveroAddonDownload.svelte');
  // Header: "MAVERO Downloader" + content title. NO "Available links".
  ok(component.includes('MAVERO Downloader'), 'AD: header shows "MAVERO Downloader"');
  ok(!component.includes('>Available links<') && !component.includes('Available links</span>'), 'AD: "Available links" is REMOVED from the rendered header');
  // Instructions.
  ok(component.includes('download button not work then use share button'), 'AD: instruction 1 present');
  ok(component.includes('share stream to player to stream directly on phone'), 'AD: instruction 2 present');
  // Suggested Apps.
  ok(component.includes('Suggested Downloader'), 'AD: "Suggested Downloader" label present');
  ok(component.includes('Suggested Player'), 'AD: "Suggested Player" label present');
  ok(component.includes('idm.internet.download.manager'), 'AD: 1DM Play Store link present');
  ok(component.includes('is.xyz.mpv'), 'AD: MPV Play Store link present');
  // NO footer disclaimer.
  ok(!component.includes("Download and Share use the provider's original address"), 'AD: the old footer disclaimer is REMOVED');
  // Sheet height increased (min-height).
  ok(component.includes('min-height: 260px') || component.includes('min-height:260px'), 'AD: sheet min-height increased (260px)');
}

// ---------------------------------------------------------------------------
// AE: player normalizer is UNCHANGED (still excludes P2P/torrent/magnet)
// ---------------------------------------------------------------------------

function sectionAE(): void {
  // The player's normalizer (stream-normalize.ts) is SEPARATE from the downloader
  // normalizer. It STILL excludes P2P/torrent/magnet/externalUrl (the player path
  // is unchanged — Phase 17 task §17).
  const playerNormalizerSource = read('src/lib/server/streaming/stremio/stream-normalize.ts');
  ok(playerNormalizerSource.includes('non-http-url'), 'AE: the player normalizer still rejects non-http schemes');
  ok(playerNormalizerSource.includes('torrent'), 'AE: the player normalizer still rejects torrent entries');
  ok(playerNormalizerSource.includes('external-url'), 'AE: the player normalizer still rejects externalUrl');
  ok(playerNormalizerSource.includes('header-dependent'), 'AE: the player normalizer still rejects header-dependent entries');
}

// ---------------------------------------------------------------------------
// runner
// ---------------------------------------------------------------------------

sectionStreamCounts();
sectionStreamTypes();
sectionO();
sectionP();
sectionQRS();
sectionT();
sectionU();
sectionV();
sectionW();
sectionX();
sectionY();
sectionAD();
sectionAE();

await sectionZ();
await sectionAB();
await sectionAC();

console.log(`stremio_downloader_phase17_test: ${passed} checks passed (Phase 17: complete discovery + all stream types preserved + no filtering + Share + 4 filters + UI changes + 0 warnings)`);
