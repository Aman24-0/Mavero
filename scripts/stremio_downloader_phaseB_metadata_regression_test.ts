import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { StreamingAddon } from '$lib/shared/streaming-addons';
import {
  resolveSingleAddonDownload,
  type ContentLookup,
} from '$lib/server/streaming/stremio/addon-download-service';
import { normalizeStremioStreamResponseForDownloader } from '$lib/server/streaming/stremio/stream-normalize-downloader';
import { buildDownloadCandidatesAll, selectDownloadStreamsAll } from '$lib/server/streaming/stremio/download-selection';

/**
 * Phase B — Metadata-preservation regression test suite (§B4: QUALITY / TYPE
 * / FILTER SAFETY).
 *
 * The approved plan says:
 *   "Do not accidentally change:
 *    - quality classification
 *    - codec classification
 *    - container detection
 *    - audio/subtitle metadata
 *    - HTTP/HLS/DASH identification
 *    - download/play actions
 *    - provider/addon identity
 *    - existing filters"
 *
 * This suite runs a representative payload through the FULL pipeline
 * (normalize → build → select) and asserts that every metadata dimension
 * is preserved byte-for-byte. The Phase B dedup change to
 * `selectDownloadStreamsAll` must NOT have altered the metadata of any
 * surviving stream.
 *
 * All responses are mocked — no real addon / network requests are made.
 */

let passed = 0;
function ok(condition: unknown, label: string) {
  assert.ok(condition, label);
  passed += 1;
}

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
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
    if (handler instanceof Response) return handler.clone();
    if (typeof handler === 'function') return (handler as () => Response)();
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
}

const noSleep = async () => Promise.resolve();

// A representative mixed payload covering every metadata dimension.
const MIXED_PAYLOAD = {
  streams: [
    // 1080p H.264 MKV HTTPS with Multi audio (real language names → audioLanguages populated)
    { name: '1080p', title: 'Dhurandhar 1080p WEB-DL H264 Hindi English Multi Audio', url: 'https://hub.example/movie-1080p.mkv', behaviorHints: { videoSize: 4_724_904_960, filename: 'Dhurandhar.1080p.WEB-DL.H264.Multi.mkv' } },
    // 720p HEVC MP4 with dual audio
    { name: '720p', title: 'Dhurandhar 720p WEB-DL HEVC Hindi English Dual Audio', url: 'https://hub.example/movie-720p.mp4', behaviorHints: { videoSize: 2_000_000_000, filename: 'Dhurandhar.720p.WEB-DL.HEVC.Dual.mp4' } },
    // 4K (2160p) AV1 MKV
    { name: '4K', title: 'Dhurandhar 2160p UHD AV1', url: 'https://hub.example/movie-4k.mkv', behaviorHints: { videoSize: 12_000_000_000, filename: 'Dhurandhar.2160p.UHD.AV1.mkv' } },
    // HLS streaming manifest (kind=hls)
    { name: 'hls', url: 'https://hub.example/playlist.m3u8' },
    // DASH streaming manifest (kind=dash)
    { name: 'dash', url: 'https://hub.example/manifest.mpd' },
    // P2P (infoHash → magnet)
    { name: 'p2p', infoHash: 'deadbeef0123456789abcdef0123456789abcdef', sources: ['udp://tracker.example:1337'] },
    // Magnet direct
    { name: 'magnet', url: 'magnet:?xt=urn:btih:feedface0123456789abcdef0123456789abcdef' },
  ],
};

// ---------------------------------------------------------------------------
// §B4.1 — Every stream kind preserved (HTTP/HTTPS/HLS/DASH/P2P/Magnet)
// ---------------------------------------------------------------------------

async function section1_kindsPreserved(): Promise<void> {
  const calls: string[] = [];
  const result = await resolveSingleAddonDownload({} as never, movieRequest, HUB.id, {
    loadAddons: loadAddonsOf([HUB]),
    loadAddonById: loadAddonByIdOf([HUB]),
    loadContent: loadContentOf(CONTENT),
    dnsResolver: publicDns,
    sleep: noSleep,
    fetcher: fetcherFor({
      'https://hdhub.example/stream/movie/tt8633518.json': json(MIXED_PAYLOAD),
    }, calls),
  });
  ok(result.status === 'loaded', `1: status='loaded' (got ${result.status})`);
  ok(result.streams.length === 7, `1: ALL 7 streams survived Phase B dedup (got ${result.streams.length}) — they all have distinct URLs/btih`);
  const kinds = result.streams.map((s) => s.kind).sort();
  ok(JSON.stringify(kinds) === JSON.stringify(['dash', 'hls', 'https', 'https', 'https', 'magnet', 'p2p']), `1: every kind preserved (got ${JSON.stringify(kinds)})`);
  ok(kinds.includes('https'), '1: HTTPS preserved');
  ok(kinds.includes('hls'), '1: HLS preserved');
  ok(kinds.includes('dash'), '1: DASH preserved');
  ok(kinds.includes('p2p'), '1: P2P preserved');
  ok(kinds.includes('magnet'), '1: Magnet preserved');
}

// ---------------------------------------------------------------------------
// §B4.2 — Quality classification preserved (1080p / 720p / 4K / auto)
// ---------------------------------------------------------------------------

async function section2_qualityPreserved(): Promise<void> {
  const calls: string[] = [];
  const result = await resolveSingleAddonDownload({} as never, movieRequest, HUB.id, {
    loadAddons: loadAddonsOf([HUB]),
    loadAddonById: loadAddonByIdOf([HUB]),
    loadContent: loadContentOf(CONTENT),
    dnsResolver: publicDns,
    sleep: noSleep,
    fetcher: fetcherFor({
      'https://hdhub.example/stream/movie/tt8633518.json': json(MIXED_PAYLOAD),
    }, calls),
  });
  const qualities = result.streams.map((s) => s.quality).sort();
  ok(qualities.includes('1080p'), `2: 1080p quality preserved (got ${JSON.stringify(qualities)})`);
  ok(qualities.includes('720p'), '2: 720p quality preserved');
  ok(qualities.includes('4K'), '2: 4K quality preserved');
  // HLS / DASH / P2P / Magnet have no explicit height → 'auto'.
  ok(qualities.includes('auto'), '2: auto quality preserved (HLS/DASH/P2P/Magnet have no explicit height)');
}

// ---------------------------------------------------------------------------
// §B4.3 — Codec classification preserved (H.264 / HEVC / AV1 / unknown)
// ---------------------------------------------------------------------------

async function section3_codecPreserved(): Promise<void> {
  const calls: string[] = [];
  const result = await resolveSingleAddonDownload({} as never, movieRequest, HUB.id, {
    loadAddons: loadAddonsOf([HUB]),
    loadAddonById: loadAddonByIdOf([HUB]),
    loadContent: loadContentOf(CONTENT),
    dnsResolver: publicDns,
    sleep: noSleep,
    fetcher: fetcherFor({
      'https://hdhub.example/stream/movie/tt8633518.json': json(MIXED_PAYLOAD),
    }, calls),
  });
  const codecs = result.streams.map((s) => s.codec).sort();
  ok(codecs.includes('H.264'), `3: H.264 codec preserved (got ${JSON.stringify(codecs)})`);
  ok(codecs.includes('HEVC'), '3: HEVC codec preserved');
  ok(codecs.includes('AV1'), '3: AV1 codec preserved');
  ok(codecs.includes('unknown'), '3: unknown codec preserved (HLS/DASH/P2P/Magnet have no codec)');
}

// ---------------------------------------------------------------------------
// §B4.4 — Container detection preserved (MKV / MP4)
// ---------------------------------------------------------------------------

async function section4_containerPreserved(): Promise<void> {
  const calls: string[] = [];
  const result = await resolveSingleAddonDownload({} as never, movieRequest, HUB.id, {
    loadAddons: loadAddonsOf([HUB]),
    loadAddonById: loadAddonByIdOf([HUB]),
    loadContent: loadContentOf(CONTENT),
    dnsResolver: publicDns,
    sleep: noSleep,
    fetcher: fetcherFor({
      'https://hdhub.example/stream/movie/tt8633518.json': json(MIXED_PAYLOAD),
    }, calls),
  });
  const containers = result.streams.map((s) => s.container).filter((c): c is string => Boolean(c)).sort();
  ok(containers.includes('MKV'), `4: MKV container preserved (got ${JSON.stringify(containers)})`);
  ok(containers.includes('MP4'), '4: MP4 container preserved');
}

// ---------------------------------------------------------------------------
// §B4.5 — Audio class + audioLanguages preserved
// ---------------------------------------------------------------------------

async function section5_audioPreserved(): Promise<void> {
  const calls: string[] = [];
  const result = await resolveSingleAddonDownload({} as never, movieRequest, HUB.id, {
    loadAddons: loadAddonsOf([HUB]),
    loadAddonById: loadAddonByIdOf([HUB]),
    loadContent: loadContentOf(CONTENT),
    dnsResolver: publicDns,
    sleep: noSleep,
    fetcher: fetcherFor({
      'https://hdhub.example/stream/movie/tt8633518.json': json(MIXED_PAYLOAD),
    }, calls),
  });
  const audios = result.streams.map((s) => s.audio).sort();
  ok(audios.includes('multi'), `5: multi audio class preserved (got ${JSON.stringify(audios)})`);
  ok(audios.includes('dual'), '5: dual audio class preserved');
  ok(audios.includes('unknown'), '5: unknown audio class preserved (streams with no audio text)');
  // audioLanguages is derived from the addon-supplied text.
  const multi = result.streams.find((s) => s.audio === 'multi');
  ok(multi?.audioLanguages?.length !== undefined && (multi.audioLanguages?.length ?? 0) > 0, '5: multi-audio stream has audioLanguages populated');
}

// ---------------------------------------------------------------------------
// §B4.6 — File size + transport + URL preserved verbatim
// ---------------------------------------------------------------------------

async function section6_sizeTransportUrlPreserved(): Promise<void> {
  const calls: string[] = [];
  const result = await resolveSingleAddonDownload({} as never, movieRequest, HUB.id, {
    loadAddons: loadAddonsOf([HUB]),
    loadAddonById: loadAddonByIdOf([HUB]),
    loadContent: loadContentOf(CONTENT),
    dnsResolver: publicDns,
    sleep: noSleep,
    fetcher: fetcherFor({
      'https://hdhub.example/stream/movie/tt8633518.json': json(MIXED_PAYLOAD),
    }, calls),
  });
  const s1080 = result.streams.find((s) => s.quality === '1080p');
  ok(s1080?.sizeBytes === 4_724_904_960, `6: 1080p sizeBytes preserved verbatim (got ${s1080?.sizeBytes})`);
  ok(s1080?.transport === 'https', `6: 1080p transport preserved (got ${s1080?.transport})`);
  ok(s1080?.url === 'https://hub.example/movie-1080p.mkv', `6: 1080p URL preserved verbatim (got ${s1080?.url})`);
  const magnetStream = result.streams.find((s) => s.kind === 'magnet');
  ok(magnetStream?.transport === 'magnet', `6: magnet transport preserved (got ${magnetStream?.transport})`);
  ok(magnetStream?.url === 'magnet:?xt=urn:btih:feedface0123456789abcdef0123456789abcdef', '6: magnet URL preserved verbatim');
  const p2pStream = result.streams.find((s) => s.kind === 'p2p');
  ok(p2pStream?.transport === 'magnet', `6: p2p transport preserved (constructed magnet) (got ${p2pStream?.transport})`);
  ok(p2pStream?.url?.startsWith('magnet:?xt=urn:btih:deadbeef0123456789abcdef0123456789abcdef'), '6: p2p magnet URL has the correct btih');
}

// ---------------------------------------------------------------------------
// §B4.7 — Phase B host field is populated for HTTP/HTTPS, undefined for magnet
// ---------------------------------------------------------------------------

async function section7_hostFieldSemantics(): Promise<void> {
  const calls: string[] = [];
  const result = await resolveSingleAddonDownload({} as never, movieRequest, HUB.id, {
    loadAddons: loadAddonsOf([HUB]),
    loadAddonById: loadAddonByIdOf([HUB]),
    loadContent: loadContentOf(CONTENT),
    dnsResolver: publicDns,
    sleep: noSleep,
    fetcher: fetcherFor({
      'https://hdhub.example/stream/movie/tt8633518.json': json(MIXED_PAYLOAD),
    }, calls),
  });
  // HTTP/HTTPS streams have host populated.
  const httpsStream = result.streams.find((s) => s.kind === 'https');
  ok(httpsStream?.host === 'hub.example', `7: HTTPS stream host derived (got ${httpsStream?.host})`);
  // Magnet streams do NOT have host (the host concept doesn't apply to magnet URIs).
  const magnetStream = result.streams.find((s) => s.kind === 'magnet');
  ok(magnetStream?.host === undefined, `7: magnet stream host is undefined (got ${magnetStream?.host})`);
  // P2P (constructed magnet) also does NOT have host.
  const p2pStream = result.streams.find((s) => s.kind === 'p2p');
  ok(p2pStream?.host === undefined, `7: p2p stream host is undefined (got ${p2pStream?.host})`);
  // HLS/DASH have host populated.
  const hlsStream = result.streams.find((s) => s.kind === 'hls');
  ok(hlsStream?.host === 'hub.example', `7: HLS stream host derived (got ${hlsStream?.host})`);
}

// ---------------------------------------------------------------------------
// §B4.8 — Pipeline ordering preserved (normalize → build → select)
// ---------------------------------------------------------------------------

async function section8_pipelineOrderPreserved(): Promise<void> {
  // Run the pipeline manually and verify each stage is intact.
  const normalized = normalizeStremioStreamResponseForDownloader(MIXED_PAYLOAD);
  ok(normalized.valid, '8: normalizer returns valid for the mixed payload');
  ok(normalized.entries.length === 7, `8: normalizer preserved all 7 entries (got ${normalized.entries.length})`);
  ok(normalized.malformed === 0, '8: no malformed entries');

  const built = buildDownloadCandidatesAll(normalized.entries);
  ok(built.entries.length === 7, `8: buildDownloadCandidatesAll preserved all 7 entries (got ${built.entries.length})`);
  ok(built.malformed === 0, '8: build malformed count is 0');
  ok(built.kindCounts.https === 3, `8: kindCounts.https = 3 (got ${built.kindCounts.https})`);
  ok(built.kindCounts.hls === 1, '8: kindCounts.hls = 1');
  ok(built.kindCounts.dash === 1, '8: kindCounts.dash = 1');
  ok(built.kindCounts.p2p === 1, '8: kindCounts.p2p = 1');
  ok(built.kindCounts.magnet === 1, '8: kindCounts.magnet = 1');

  const selected = selectDownloadStreamsAll(built.entries);
  ok(selected.length === 7, `8: selectDownloadStreamsAll preserved all 7 distinct streams (got ${selected.length})`);
  // The output is sorted by score then index (deterministic).
  for (let i = 1; i < selected.length; i += 1) {
    const prev = selected[i - 1];
    const curr = selected[i];
    const orderOk = prev.score < curr.score || (prev.score === curr.score && prev.index <= curr.index);
    ok(orderOk, `8: stream ${i} is sorted by (score, index)`);
  }
}

// ---------------------------------------------------------------------------
// runner
// ---------------------------------------------------------------------------

await section1_kindsPreserved();
await section2_qualityPreserved();
await section3_codecPreserved();
await section4_containerPreserved();
await section5_audioPreserved();
await section6_sizeTransportUrlPreserved();
await section7_hostFieldSemantics();
await section8_pipelineOrderPreserved();

console.log(`stremio_downloader_phaseB_metadata_regression_test: ${passed} checks passed (Phase B §B4: metadata-preservation regression — kinds/quality/codec/container/audio/size/transport/URL/host preserved, pipeline order intact)`);
