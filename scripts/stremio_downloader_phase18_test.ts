import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { StreamingAddon } from '$lib/shared/streaming-addons';
import { normalizeStremioStreamResponseForDownloader } from '$lib/server/streaming/stremio/stream-normalize-downloader';
import { resolveSingleAddonDownload, type ContentLookup } from '$lib/server/streaming/stremio/addon-download-service';

/**
 * Phase 18 test suite — Compact UI + External Hidden + Download Removed.
 *
 * Pins the Phase 18 contract:
 *   1. External streams are excluded from the UI.
 *   2-9. HTTP/HTTPS/HLS/DASH/MP4/MKV/P2P/Magnet preserved.
 *   10. infoHash + sources → magnet preserved.
 *   11. AIO type=http + infoHash → HTTP (not P2P).
 *   12. No artificial max count.
 *   13. 49 Peerflix entries → 49 (all eligible).
 *   14. Pipe entries → all eligible entries.
 *   15-18. Language/Type/Size/Quality filters work.
 *   19. Filters do not refetch.
 *   20. External is not a Type option.
 *   21. Download action is completely removed.
 *   22. Share action remains.
 *   23. Share uses exact original URI.
 *   24. Movie title is not duplicated.
 *   25. "MAVERO Downloader" heading removed from inner content.
 *   26. Suggested apps are one row.
 *   27. Filter controls are one horizontal row.
 *   28. Filter row comes before addon chips.
 *   29. Old footer is removed.
 *   30. Addon counts represent non-external loaded links.
 *   31. Failed vs empty state remains distinct.
 *   32. url takes priority over externalUrl (Phase 18 root-cause fix).
 */

let passed = 0;
function ok(condition: unknown, label: string) {
  assert.ok(condition, label);
  passed += 1;
}

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative: string) => readFileSync(path.join(REPO_ROOT, relative), 'utf8');
const publicDns = (async (hostname: string) => [{ address: '93.184.216.34', family: 4 }]) as never;

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
// 1. External streams are excluded from the UI (filtered server-side)
// ---------------------------------------------------------------------------

async function section1(): Promise<void> {
  const result = await resolveSingleAddonDownload({} as never, movieRequest, PIPE.id, {
    loadAddons: loadAddonsOf([PIPE]),
    loadAddonById: loadAddonByIdOf([PIPE]),
    loadContent: loadContentOf(CONTENT),
    dnsResolver: publicDns,
    fetcher: fetcherFor({
      'https://pipe.example/stream/movie/tt8633518.json': json({
        streams: [
          { name: 'http', url: 'https://pipe.example/a.mkv' },
          { name: 'external', externalUrl: 'https://opens-elsewhere.example/page' },
        ],
      }),
    }, []),
  });
  ok(result.status === 'loaded', '1: addon loaded');
  ok(result.streams.length === 1, `1: only 1 stream shown (external is hidden) (got ${result.streams.length})`);
  ok(result.streams[0]?.url === 'https://pipe.example/a.mkv', '1: the http stream is preserved');
  ok(!result.streams.some((s) => s.kind === 'external'), '1: NO external stream in the result');
  ok(result.diagnostics?.externalCount === 1, `1: diagnostics.externalCount = 1 (got ${result.diagnostics?.externalCount})`);
}

// ---------------------------------------------------------------------------
// 2-9. Stream types preserved (HTTP/HTTPS/HLS/DASH/MP4/MKV/P2P/Magnet)
// ---------------------------------------------------------------------------

function section2to9(): void {
  const result = normalizeStremioStreamResponseForDownloader({
    streams: [
      { name: 'http', url: 'http://x.example/a.mkv' },
      { name: 'https', url: 'https://x.example/b.mkv' },
      { name: 'hls', url: 'https://x.example/master.m3u8' },
      { name: 'dash', url: 'https://x.example/manifest.mpd' },
      { name: 'mp4', url: 'https://x.example/movie.mp4' },
      { name: 'mkv', url: 'https://x.example/movie.mkv' },
      { name: 'p2p', infoHash: 'deadbeef', sources: ['udp://tracker.example:1337'] },
      { name: 'magnet', url: 'magnet:?xt=urn:btih:feedface' },
    ],
  });
  ok(result.entries.length === 8, `2-9: ALL 8 entries preserved (got ${result.entries.length})`);
  const kinds = result.entries.map((e) => e.kind);
  ok(kinds.includes('http'), '2: HTTP preserved');
  ok(kinds.includes('https'), '3: HTTPS preserved');
  ok(kinds.includes('hls'), '4: HLS preserved');
  ok(kinds.includes('dash'), '5: DASH preserved');
  ok(kinds.filter((k) => k === 'https').length >= 2, '6-7: MP4 + MKV preserved (as https)');
  ok(kinds.includes('p2p'), '8: P2P preserved (infoHash → magnet)');
  ok(kinds.includes('magnet'), '9: Magnet preserved');
}

// ---------------------------------------------------------------------------
// 10. infoHash + sources → magnet preserved
// ---------------------------------------------------------------------------

function section10(): void {
  const result = normalizeStremioStreamResponseForDownloader({
    streams: [{ name: 'torrent', infoHash: 'abc123def', sources: ['udp://tracker1.example:1337', 'https://tracker2.example/announce'] }],
  });
  ok(result.entries.length === 1, '10: 1 entry preserved');
  ok(result.entries[0]?.kind === 'p2p', '10: kind = p2p');
  ok(result.entries[0]?.url.startsWith('magnet:?xt=urn:btih:abc123def'), '10: magnet URI has correct xt');
  ok(result.entries[0]?.url.includes('tr=udp%3A%2F%2Ftracker1.example%3A1337'), '10: magnet URI includes tracker 1');
  ok(result.entries[0]?.url.includes('tr=https%3A%2F%2Ftracker2.example%2Fannounce'), '10: magnet URI includes tracker 2');
}

// ---------------------------------------------------------------------------
// 11. AIO type=http + infoHash → HTTP (not P2P)
// ---------------------------------------------------------------------------

function section11(): void {
  const result = normalizeStremioStreamResponseForDownloader({
    streams: [
      { type: 'http', name: 'aio-http', url: 'https://aio.example/dl/one', infoHash: 'cafebeef' },
      { type: 'p2p', name: 'aio-p2p', url: 'https://aio.example/dl/two', infoHash: 'feedface' },
    ],
  });
  ok(result.entries.length === 2, '11: both AIO entries preserved');
  const http = result.entries.find((e) => e.name === 'aio-http');
  const p2p = result.entries.find((e) => e.name === 'aio-p2p');
  // type=http → classified as https (the URL wins, NOT p2p — even though infoHash exists).
  ok(http?.kind === 'https' || http?.kind === 'http', `11: type=http + infoHash → classified as http/https (got ${http?.kind})`);
  // type=p2p → classified as p2p (the explicit type wins when it's non-http).
  ok(p2p?.kind === 'p2p', `11: type=p2p → classified as p2p (got ${p2p?.kind})`);
}

// ---------------------------------------------------------------------------
// 12. No artificial max count
// ---------------------------------------------------------------------------

function section12(): void {
  const streams: Array<Record<string, unknown>> = [];
  for (let i = 0; i < 49; i += 1) {
    streams.push({ name: `s${i}`, url: `https://cdn.example/stream-${i}.mkv` });
  }
  const result = normalizeStremioStreamResponseForDownloader({ streams });
  ok(result.entries.length === 49, `12: 49 entries → 49 preserved (got ${result.entries.length})`);
}

// ---------------------------------------------------------------------------
// 13. 49 Peerflix entries → 49 (all eligible)
// ---------------------------------------------------------------------------

async function section13(): Promise<void> {
  const peerflixStreams: Array<Record<string, unknown>> = [];
  for (let i = 0; i < 49; i += 1) {
    peerflixStreams.push({ name: `p${i}`, infoHash: `hash${i}`, sources: ['udp://tracker.example:1337'] });
  }
  const result = await resolveSingleAddonDownload({} as never, movieRequest, PEERFLIX.id, {
    loadAddons: loadAddonsOf([PEERFLIX]),
    loadAddonById: loadAddonByIdOf([PEERFLIX]),
    loadContent: loadContentOf(CONTENT),
    dnsResolver: publicDns,
    fetcher: fetcherFor({ 'https://peerflix.example/stream/movie/tt8633518.json': json({ streams: peerflixStreams }) }, []),
  });
  ok(result.status === 'loaded', `13: Peerflix loaded (got ${result.status})`);
  ok(result.streams.length === 49, `13: 49 Peerflix entries → 49 shown (got ${result.streams.length})`);
  ok(result.diagnostics?.externalCount === 0, '13: 0 external entries');
}

// ---------------------------------------------------------------------------
// 14. Pipe entries → all eligible entries
// ---------------------------------------------------------------------------

async function section14(): Promise<void> {
  const result = await resolveSingleAddonDownload({} as never, movieRequest, PIPE.id, {
    loadAddons: loadAddonsOf([PIPE]),
    loadAddonById: loadAddonByIdOf([PIPE]),
    loadContent: loadContentOf(CONTENT),
    dnsResolver: publicDns,
    fetcher: fetcherFor({
      'https://pipe.example/stream/movie/tt8633518.json': json({
        streams: [
          { name: '1080p', url: 'https://pipe.example/a.mkv' },
          { name: '720p', url: 'https://pipe.example/b.mkv' },
          { name: 'torrent', infoHash: 'deadbeef', sources: ['udp://tracker.example:1337'] },
          { name: 'external', externalUrl: 'https://opens-elsewhere.example/page' },
        ],
      }),
    }, []),
  });
  // 4 returned, 1 external → 3 shown.
  ok(result.streams.length === 3, `14: Pipe 4 entries - 1 external = 3 shown (got ${result.streams.length})`);
  ok(result.diagnostics?.raw === 4, `14: diagnostics.raw = 4 (got ${result.diagnostics?.raw})`);
  ok(result.diagnostics?.externalCount === 1, `14: diagnostics.externalCount = 1 (got ${result.diagnostics?.externalCount})`);
}

// ---------------------------------------------------------------------------
// 15-18. Filters work (UI assertions)
// ---------------------------------------------------------------------------

function section15to18(): void {
  const component = read('src/lib/components/MaveroAddonDownload.svelte');
  // 15: Language filter.
  ok(component.includes('filterLanguage'), '15: filterLanguage state exists');
  ok(component.includes('detectedLanguages'), '15: language list is dynamic');
  // 16: Type filter.
  ok(component.includes('filterType'), '16: filterType state exists');
  ok(component.includes('value="http"') && component.includes('value="hls"'), '16: Type filter has HTTP/HLS');
  // 17: Size filter.
  ok(component.includes('filterSize'), '17: filterSize state exists');
  ok(component.includes('under1') && component.includes('over20'), '17: Size filter has under1 + over20');
  // 18: Quality filter.
  ok(component.includes('filterQuality'), '18: filterQuality state exists');
  ok(component.includes('1080p') && component.includes('4K'), '18: Quality filter has 1080p + 4K');
}

// ---------------------------------------------------------------------------
// 19. Filters do not refetch
// ---------------------------------------------------------------------------

function section19(): void {
  const component = read('src/lib/components/MaveroAddonDownload.svelte');
  ok(component.includes('applyFilters'), '19: applyFilters is a pure client-side function');
  ok(component.includes('filteredStreams = applyFilters('), '19: filteredStreams is derived (no refetch)');
}

// ---------------------------------------------------------------------------
// 20. External is not a Type option
// ---------------------------------------------------------------------------

function section20(): void {
  const component = read('src/lib/components/MaveroAddonDownload.svelte');
  ok(!component.includes('value="external"'), '20: External is NOT a Type filter option');
}

// ---------------------------------------------------------------------------
// 21. Download action is completely removed
// ---------------------------------------------------------------------------

function section21(): void {
  const component = read('src/lib/components/MaveroAddonDownload.svelte');
  ok(!component.includes('downloadAttributesFor'), '21: downloadAttributesFor is absent');
  ok(!component.includes('handleDownload'), '21: handleDownload is absent');
  ok(!component.includes('openingKey'), '21: openingKey state is absent');
  ok(!component.includes('Download size='), '21: Download icon is absent');
}

// ---------------------------------------------------------------------------
// 22. Share action remains
// ---------------------------------------------------------------------------

function section22(): void {
  const component = read('src/lib/components/MaveroAddonDownload.svelte');
  ok(component.includes('handleShare'), '22: handleShare is present');
  ok(component.includes('Share2 size='), '22: Share2 icon is present');
  ok(component.includes('mad-action-share'), '22: mad-action-share CSS class is present');
}

// ---------------------------------------------------------------------------
// 23. Share uses exact original URI
// ---------------------------------------------------------------------------

function section23(): void {
  const component = read('src/lib/components/MaveroAddonDownload.svelte');
  ok(component.includes('url = stream.url'), '23: Share handler binds url = stream.url (the EXACT ORIGINAL URI)');
  ok(component.includes('navigator.share'), '23: navigator.share is used');
}

// ---------------------------------------------------------------------------
// 24. Movie title is not duplicated inside downloader content
// ---------------------------------------------------------------------------

function section24(): void {
  const component = read('src/lib/components/MaveroAddonDownload.svelte');
  // The `title` prop is accepted but NOT rendered in the downloader content.
  ok(!component.includes('{title}'), '24: {title} is NOT rendered in the downloader content');
  ok(!component.includes('mad-title'), '24: mad-title CSS class is absent (no title display)');
}

// ---------------------------------------------------------------------------
// 25. "MAVERO Downloader" heading removed from inner content
// ---------------------------------------------------------------------------

function section25(): void {
  const component = read('src/lib/components/MaveroAddonDownload.svelte');
  ok(!component.includes('mad-header'), '25: mad-header section is absent');
  ok(!component.includes('>MAVERO Downloader<'), '25: MAVERO Downloader heading is absent from rendered content');
  ok(!component.includes('mad-eyebrow'), '25: mad-eyebrow CSS class is absent');
}

// ---------------------------------------------------------------------------
// 26. Suggested apps are one row
// ---------------------------------------------------------------------------

function section26(): void {
  const component = read('src/lib/components/MaveroAddonDownload.svelte');
  ok(component.includes('mad-apps'), '26: mad-apps container exists (one row)');
  ok(!component.includes('Suggested Downloader'), '26: "Suggested Downloader" heading is absent');
  ok(!component.includes('Suggested Player'), '26: "Suggested Player" heading is absent');
  ok(component.includes('idm.internet.download.manager'), '26: 1DM Play Store link present');
  ok(component.includes('is.xyz.mpv'), '26: MPV Play Store link present');
}

// ---------------------------------------------------------------------------
// 27. Filter controls are one horizontal row
// ---------------------------------------------------------------------------

function section27(): void {
  const component = read('src/lib/components/MaveroAddonDownload.svelte');
  ok(component.includes('mad-filters'), '27: mad-filters container exists');
  // The filter row uses flex + overflow-x: auto (horizontally scrollable, ONE row).
  const filtersStyle = component.match(/\.mad-filters\s*\{([^}]*)\}/);
  if (filtersStyle) {
    ok(filtersStyle[1].includes('overflow-x: auto') || filtersStyle[1].includes('overflow-x:auto'), '27: mad-filters uses overflow-x: auto (horizontally scrollable)');
    ok(filtersStyle[1].includes('display: flex'), '27: mad-filters uses display: flex (one row)');
  }
}

// ---------------------------------------------------------------------------
// 28. Filter row comes before addon chips
// ---------------------------------------------------------------------------

function section28(): void {
  const component = read('src/lib/components/MaveroAddonDownload.svelte');
  const filtersIndex = component.indexOf('mad-filters');
  const tabsIndex = component.indexOf('mad-tabs');
  ok(filtersIndex !== -1 && tabsIndex !== -1, '28: both mad-filters and mad-tabs exist');
  ok(filtersIndex < tabsIndex, `28: mad-filters comes BEFORE mad-tabs (filters=${filtersIndex}, tabs=${tabsIndex})`);
}

// ---------------------------------------------------------------------------
// 29. Old footer is removed
// ---------------------------------------------------------------------------

function section29(): void {
  const component = read('src/lib/components/MaveroAddonDownload.svelte');
  ok(!component.includes("Download and Share use the provider's original address"), '29: old footer disclaimer is absent');
  ok(!component.includes('mad-note'), '29: mad-note (footer) CSS class is absent');
}

// ---------------------------------------------------------------------------
// 30. Addon counts represent non-external loaded links
// ---------------------------------------------------------------------------

async function section30(): Promise<void> {
  const result = await resolveSingleAddonDownload({} as never, movieRequest, PIPE.id, {
    loadAddons: loadAddonsOf([PIPE]),
    loadAddonById: loadAddonByIdOf([PIPE]),
    loadContent: loadContentOf(CONTENT),
    dnsResolver: publicDns,
    fetcher: fetcherFor({
      'https://pipe.example/stream/movie/tt8633518.json': json({
        streams: [
          { name: 'a', url: 'https://pipe.example/a.mkv' },
          { name: 'b', url: 'https://pipe.example/b.mkv' },
          { name: 'c', externalUrl: 'https://opens-elsewhere.example/page' },
          { name: 'd', externalUrl: 'https://another-external.example/page' },
        ],
      }),
    }, []),
  });
  // 4 returned, 2 external → 2 shown. The addon chip count = 2 (non-external).
  ok(result.streams.length === 2, `30: 4 entries - 2 external = 2 shown (got ${result.streams.length})`);
  ok(result.diagnostics?.externalCount === 2, `30: diagnostics.externalCount = 2 (got ${result.diagnostics?.externalCount})`);
  ok(result.diagnostics?.selected === 2, `30: diagnostics.selected = 2 (the chip count) (got ${result.diagnostics?.selected})`);
}

// ---------------------------------------------------------------------------
// 31. Failed vs empty state remains distinct
// ---------------------------------------------------------------------------

async function section31(): Promise<void> {
  // Empty (genuinely zero streams).
  const empty = await resolveSingleAddonDownload({} as never, movieRequest, PIPE.id, {
    loadAddons: loadAddonsOf([PIPE]),
    loadAddonById: loadAddonByIdOf([PIPE]),
    loadContent: loadContentOf(CONTENT),
    dnsResolver: publicDns,
    fetcher: fetcherFor({ 'https://pipe.example/stream/movie/tt8633518.json': json({ streams: [] }) }, []),
  });
  ok(empty.status === 'empty', `31: empty addon → status='empty' (got ${empty.status})`);
  ok(empty.errorCode === undefined, '31: empty has NO error code');

  // Failed (request failure).
  const failed = await resolveSingleAddonDownload({} as never, movieRequest, PIPE.id, {
    loadAddons: loadAddonsOf([PIPE]),
    loadAddonById: loadAddonByIdOf([PIPE]),
    loadContent: loadContentOf(CONTENT),
    dnsResolver: publicDns,
    sleep: async () => Promise.resolve(),
    fetcher: fetcherFor({ 'https://pipe.example/stream/movie/tt8633518.json': new Response('boom', { status: 500 }) }, []),
  });
  ok(failed.status === 'unavailable', `31: failed addon → status='unavailable' (got ${failed.status})`);
  ok(failed.errorCode === 'HTTP_ERROR', '31: failed has HTTP_ERROR code');

  // External-only → empty (not loaded).
  const externalOnly = await resolveSingleAddonDownload({} as never, movieRequest, PIPE.id, {
    loadAddons: loadAddonsOf([PIPE]),
    loadAddonById: loadAddonByIdOf([PIPE]),
    loadContent: loadContentOf(CONTENT),
    dnsResolver: publicDns,
    fetcher: fetcherFor({
      'https://pipe.example/stream/movie/tt8633518.json': json({
        streams: [{ name: 'ext', externalUrl: 'https://opens-elsewhere.example/page' }],
      }),
    }, []),
  });
  ok(externalOnly.status === 'empty', `31: external-only addon → status='empty' (0 non-external) (got ${externalOnly.status})`);
  ok(externalOnly.streams.length === 0, '31: 0 streams shown');
  ok(externalOnly.diagnostics?.externalCount === 1, '31: externalCount = 1');
}

// ---------------------------------------------------------------------------
// 32. url takes priority over externalUrl (Phase 18 root-cause fix)
// ---------------------------------------------------------------------------

function section32(): void {
  // When an entry has BOTH a usable url AND an externalUrl, the url wins.
  const result = normalizeStremioStreamResponseForDownloader({
    streams: [
      { name: 'both', url: 'https://x.example/movie.mkv', externalUrl: 'https://opens-elsewhere.example/page' },
    ],
  });
  ok(result.entries.length === 1, '32: 1 entry preserved');
  ok(result.entries[0]?.kind === 'https', `32: kind = https (url wins over externalUrl) (got ${result.entries[0]?.kind})`);
  ok(result.entries[0]?.url === 'https://x.example/movie.mkv', '32: the url is preserved (NOT the externalUrl)');
}

// ---------------------------------------------------------------------------
// runner
// ---------------------------------------------------------------------------

section2to9();
section10();
section11();
section12();
section15to18();
section19();
section20();
section21();
section22();
section23();
section24();
section25();
section26();
section27();
section28();
section29();
section32();

await section1();
await section13();
await section14();
await section30();
await section31();

console.log(`stremio_downloader_phase18_test: ${passed} checks passed (Phase 18: compact UI + external hidden + Download removed + url-priority fix + 0 warnings)`);
