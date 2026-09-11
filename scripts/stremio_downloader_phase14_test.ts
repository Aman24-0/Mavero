import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { StreamingAddon } from '$lib/shared/streaming-addons';
import { normalizeStremioStreamResponse } from '$lib/server/streaming/stremio/stream-normalize';
import { buildDownloadCandidates, selectDownloadStreams, scoreDownloadCandidate, sizeFromTexts, MAX_DOWNLOAD_STREAMS_PER_ADDON, type DownloadStreamCandidate } from '$lib/server/streaming/stremio/download-selection';
import { resolveAddonDownloads } from '$lib/server/streaming/stremio/addon-download-service';
import { builtinMaveroDownloaderProvider, withMaveroDownloaderProvider } from '$lib/server/downloader/public-config';
import { createAddonSession, resolveAddonToken, type ContentLookup } from '$lib/server/streaming/stremio/addon-session';
import { externalPlayerHint, externalPlayerLaunchFor, isAndroidUserAgent, MPV_ANDROID_PACKAGE } from '$lib/shared/external-player';

/**
 * Phase 14 test suite — the MAVERO DOWNLOADER / external-player product
 * layer. Companion to stremio_player_phase13_test.ts (which pins the PLAYER
 * side: HLS-only addon surface). THIS suite pins the DOWNLOADER side:
 *
 *   A   The native player keeps addon HLS (HdHub unchanged) while direct
 *       files from the SAME payload are isolated from playback.
 *   B   Direct files ARE offered by the downloader with their metadata.
 *   C   Pipe cleartext http:// streams reach the downloader list (the
 *       "✓ 0" bug cannot recur on the download surface).
 *   D   AIOStreams-style explicit `type: 'http'` entries are retained EVEN
 *       when legacy infoHash fields are present (type-aware P2P detection).
 *   E   P2P/torrent streams stay excluded (type:'p2p', untyped infoHash,
 *       magnet URLs, .torrent paths).
 *   F   externalUrl-only entries are excluded.
 *   G   proxyHeaders (header-dependent) streams stay excluded.
 *   H/I Cleartext http AND https media URLs are both allowed (verbatim).
 *   J   At most 4 BEST links per addon; quality diversity; never the first
 *       four by arrival.
 *   K   Equivalent releases deduplicate.
 *   L   Addon states are distinct: REQUEST FAILED (typed) ≠ LOADED ZERO,
 *       and one failed addon never breaks another. No playback failure is
 *       ever implied (the downloader never plays anything).
 *   M/N Copy URL + Download operate on the ORIGINAL addon URL (no proxy,
 *       no rewrite, no signed Mavero media URL).
 *   O   External player: mpv-android VIEW intent on Android (package
 *       is.xyz.mpv + browser_fallback_url), graceful direct link elsewhere.
 *   P   HLS/DASH manifests and non-video files are never download links.
 *   Q   Ranking policy: 1080p-first, size-aware, CAM/TS penalties, heavy
 *       demotion (still shown when alone), download-only never, deterministic.
 *   R   The downloader path performs NO media fetch and NO FFmpeg/worker
 *       call — only addon stream-list endpoints.
 *   S   The built-in provider is injected into the public downloader config
 *       (last, never default, dedupe-safe).
 *   T   The API view carries ONLY safe presentation data (no manifest URLs,
 *       no header names, no raw upstream errors).
 */

let passed = 0;
function ok(condition: unknown, label: string) {
  assert.ok(condition, label);
  passed += 1;
}

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative: string) => readFileSync(path.join(REPO_ROOT, relative), 'utf8');
const SECRET = 'phase14-session-secret-0123456789abcdef';
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

const CONTENT: ContentLookup = { title: 'Dhurandhar: The Revenge', identifiers: { imdbId: 'tt8633518', tmdbId: '1094521' } };
const loadContentOf = (lookup: ContentLookup) => async () => lookup;
const loadAddonsOf = (addons: StreamingAddon[]) => async () => addons;

/** HdHub-shaped: one HLS stream + one MP4 direct file. */
function hubPayload() {
  return {
    streams: [
      { name: '1080p HLS', title: 'HLS', url: 'https://hub-cdn.example/hls/s1/index.m3u8?token=signed' },
      { name: '1080p', title: '1080p H.264 MP4 Hindi', url: 'https://hub-cdn.example/file/movie.mp4', behaviorHints: { videoSize: 3_221_225_472, filename: 'Movie.1080p.WEB-DL.H264.mp4' } },
    ],
  };
}

/** PenguPlay-shaped: a rich direct-file mix (remux / HEVC / WEB-DL / 4K / download-only). */
function penguDirectPayload() {
  return {
    streams: [
      { name: '1080p', title: 'Dhurandhar 1080p BluRay REMUX Dual Audio\nHindi + English\n45.70 GB', url: 'https://pengu.example/get/remux1080', behaviorHints: { videoSize: 49_073_043_456 } },
      { name: '1080p', title: 'Dhurandhar 1080p WEB-DL Dual Audio\nHindi + English\n4.40 GB', url: 'https://pengu.example/get/webdl1080', behaviorHints: { videoSize: 4_724_904_960, filename: 'Dhurandhar.1080p.WEB-DL.H264.Dual-Audio.mkv' } },
      { name: '1080p', title: 'Dhurandhar 1080p HEVC 10-bit\nHindi\n3.10 GB', url: 'https://pengu.example/get/hevc1080', behaviorHints: { videoSize: 3_329_303_552, filename: 'Dhurandhar.1080p.HEVC.10bit.mkv' } },
      { name: '720p', title: 'Dhurandhar 720p WEB-DL Dual Audio\nHindi + English\n1.90 GB', url: 'https://pengu.example/get/webdl720', behaviorHints: { videoSize: 2_040_109_056 } },
      { name: '480p', title: 'Dhurandhar 480p WEB-DL Dual Audio\nHindi + English\n0.80 GB', url: 'https://pengu.example/get/webdl480', behaviorHints: { videoSize: 858_993_459 } },
      { name: '2160p', title: 'Dhurandhar 2160p UHD Multi Audio\nHindi English Tamil\n18.20 GB', url: 'https://pengu.example/get/uhd2160', behaviorHints: { videoSize: 19_539_396_608 } },
      { name: 'Download', title: '10Gbps Download Only\n45 GB untouched', url: 'https://pengu.example/download/only' },
    ],
  };
}

/** Pipe-shaped: cleartext http PixelDrain links + an untyped magnet/infoHash entry. */
function pipeHttpPayload() {
  return {
    streams: [
      { name: '1080p', title: 'Dhurandhar 1080p WEB-DL Dual Audio\nHindi + English\n4.40 GB\nPixelDrain', url: 'http://pixeldrain.example/api/file/ab12cd', behaviorHints: { videoSize: 4_724_904_960 } },
      { name: '720p', title: 'Dhurandhar 720p WEB-DL Dual Audio\nHindi + English\n1.90 GB\nPixelDrain', url: 'http://pixeldrain.example/api/file/cd34ef', behaviorHints: { videoSize: 2_040_109_056 } },
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

const movieRequest = { mediaType: 'movie' as const, contentId: 'movie-1094521', };

function normalizeStreams(payload: unknown) {
  return normalizeStremioStreamResponse(payload).streams;
}

// ---------------------------------------------------------------------------
// A — the native player keeps addon HLS; direct files are isolated
// ---------------------------------------------------------------------------

async function sectionA(): Promise<void> {
  const client = {} as never;
  const session = await createAddonSession(client, { mediaType: 'movie', contentId: 'movie-1094521' }, {
    secret: SECRET,
    sessionId: 'session-14',
    loadAddons: loadAddonsOf([HUB]),
    loadContent: loadContentOf(CONTENT),
  });
  const token = session.addons.find((addon) => addon.name === 'HdHub')?.token;
  ok(typeof token === 'string' && token.length > 0, 'A: the HdHub session token exists');
  const resolution = await resolveAddonToken(client, { sessionId: 'session-14', token: token as string }, { contentId: 'movie-1094521', mediaType: 'movie' }, {
    secret: SECRET,
    loadAddonById: async () => HUB,
    loadContent: loadContentOf(CONTENT),
    dnsResolver: publicDns,
    fetcher: fetcherFor({ 'https://hdhub.example/stream/movie/tt8633518.json': new Response(JSON.stringify(hubPayload()), { status: 200, headers: { 'content-type': 'application/json' } }) }, []),
  });
  ok(resolution.result.status === 'ok' && resolution.result.streams.length === 1, 'A: the PLAYER keeps the addon HLS stream (native HLS path unchanged — HdHub)');
  if (resolution.result.status === 'ok') {
    ok(resolution.result.streams[0]?.source.metadata?.protocol === 'hls', 'A: the player stream is the HLS variant');
    ok(!JSON.stringify(resolution.result.streams).includes('movie.mp4'), 'A: the direct file from the SAME payload never reaches the player');
  }
}

// ---------------------------------------------------------------------------
// B/C — the downloader offers direct files (Pipe http retention + metadata)
// ---------------------------------------------------------------------------

async function sectionBC(): Promise<void> {
  const calls: string[] = [];
  const result = await resolveAddonDownloads({} as never, movieRequest, {
    loadAddons: loadAddonsOf([PIPE, HUB]),
    loadContent: loadContentOf(CONTENT),
    dnsResolver: publicDns,
    fetcher: fetcherFor({
      'https://pipe.example/stream/movie/tt8633518.json': new Response(JSON.stringify(pipeHttpPayload()), { status: 200, headers: { 'content-type': 'application/json' } }),
      'https://hdhub.example/stream/movie/tt8633518.json': new Response(JSON.stringify(hubPayload()), { status: 200, headers: { 'content-type': 'application/json' } }),
    }, calls),
  });
  ok(result.consideredAddons === 2 && result.groups.length === 2, 'B: every enabled addon gets a group');
  const pipe = result.groups.find((group) => group.addonName === 'Pipe');
  const hub = result.groups.find((group) => group.addonName === 'HdHub');
  // Phase 17 (task §1/§2): P2P/torrent streams are PRESERVED as magnet entries.
  // Pipe now returns 3 streams: 2 HTTP PixelDrain + 1 P2P (magnet from infoHash).
  ok(pipe?.status === 'loaded' && pipe.streams.length === 3, 'C (Phase 17): Pipe is LOADED with ALL 3 streams (2 HTTP PixelDrain + 1 P2P/magnet — no filtering)');
  const pipeHttp = pipe?.streams.filter((s) => s.url.startsWith('http://')) ?? [];
  ok(pipeHttp.length === 2 && pipeHttp.every((s) => s.url.startsWith('http://')), 'C: the 2 cleartext http PixelDrain URLs are preserved verbatim (no silent https rewrite, no proxy)');
  const pipeP2p = pipe?.streams.filter((s) => s.kind === 'p2p' || s.kind === 'magnet') ?? [];
  ok(pipeP2p.length === 1 && pipeP2p[0]?.url.startsWith('magnet:'), 'C (Phase 17): the torrent entry is PRESERVED as a magnet URI (infoHash → magnet construction)');
  // HdHub: 1 HLS + 1 MP4. Phase 17: BOTH preserved (HLS is no longer filtered).
  ok(hub?.status === 'loaded' && hub.streams.length === 2, 'B (Phase 17): HdHub offers BOTH streams (MP4 + HLS — no format filtering)');
  ok(hub?.streams.some((s) => s.url === 'https://hub-cdn.example/file/movie.mp4'), 'B: the MP4 direct file is preserved');
  ok(hub?.streams.some((s) => s.url.includes('.m3u8')), 'B (Phase 17): the HLS manifest is ALSO preserved (HLS is no longer filtered — task §1)');
  ok(hub?.streams[0]?.container === 'MP4' || hub?.streams[0]?.filename === 'Movie.1080p.WEB-DL.H264.mp4', 'B: addon-supplied metadata travels with the link');
  ok(calls.every((url) => url.includes('/stream/movie/tt8633518.json')), 'R: the service fetched ONLY addon stream-list endpoints');
}

// ---------------------------------------------------------------------------
// D/E — type-aware P2P detection (AIOStreams stream.type)
// ---------------------------------------------------------------------------

function sectionDE(): void {
  const normalized = normalizeStreams(aioTypedHttpPayload());
  ok(normalized.length === 1, 'D: the explicit type:"http" entry survives normalization (the player normalizer)');
  ok(normalized[0]?.streamType === 'http', 'D: the addon-specific stream type is preserved on the normalized model');
  ok(normalized[0]?.url === 'https://aio-cdn.example/dl/one?h=abc', 'D: the AIOStreams http URL is preserved verbatim (infoHash field ignored — type is authoritative)');
  const { candidates } = buildDownloadCandidates(normalized);
  // Phase 16 (task §4/§5): no max cap, no over-filtering — the AIOStreams
  // http stream is an eligible direct HTTP(S) link and survives as a
  // candidate. The old `download-only` skip reason was REMOVED (it silently
  // dropped legitimate streams that Stremio shows).
  ok(candidates.length === 1, 'D: the AIOStreams http stream becomes a download candidate (Phase 16: no over-filtering)');

  // Phase 17: the player normalizer STILL excludes P2P/torrent/magnet (the
  // player path is unchanged). The DOWNLOADER normalizer preserves them.
  const p2p = normalizeStreams({ streams: [{ type: 'p2p', name: 'x', url: 'https://x.example/a.mkv' }] });
  ok(p2p.length === 0, 'E (player normalizer): an explicit type:"p2p" stream is excluded from the PLAYER path (unchanged)');
  const untypedInfoHash = normalizeStreams({ streams: [{ name: 'x', url: 'https://x.example/a.mkv', infoHash: 'deadbeef' }] });
  ok(untypedInfoHash.length === 0, 'E (player normalizer): an UNTYPED torrent-shaped entry (infoHash) is excluded from the PLAYER path (unchanged)');
  const magnet = normalizeStreams({ streams: [{ name: 'x', url: 'magnet:?xt=urn:btih:deadbeef' }] });
  ok(magnet.length === 0, 'E (player normalizer): magnet URLs are excluded from the PLAYER path (non-http scheme)');
  const torrentUrl = normalizeStreams({ streams: [{ type: 'http', name: 'x', url: 'https://tracker.example/file.torrent' }] });
  ok(torrentUrl.length === 0, 'E (player normalizer): a .torrent URL is excluded even when the addon claims type http (URL tokens always win)');
  const availability = normalizeStreams({ streams: [{ name: 'x', tag: 'CAM', availability: 1, url: 'https://x.example/a.mkv' }] });
  ok(availability[0]?.availability === 1 && availability[0]?.tag === 'CAM', 'D: standard Stremio availability + tag are preserved');
}

// ---------------------------------------------------------------------------
// F/G — externalUrl + proxyHeaders stay excluded
// ---------------------------------------------------------------------------

function sectionFG(): void {
  // Phase 17: the PLAYER normalizer still excludes externalUrl + proxyHeaders.
  // The DOWNLOADER normalizer preserves them (Phase 17 task §1/§2).
  const external = normalizeStreams({ streams: [{ name: 'x', externalUrl: 'https://opens-elsewhere.example/page' }] });
  ok(external.length === 0, 'F (player normalizer): externalUrl-only entries are excluded from the PLAYER path (unchanged)');
  const headered = normalizeStreams({ streams: [{ name: 'x', url: 'https://x.example/a.mkv', behaviorHints: { proxyHeaders: { Referer: 'https://x.example/' } } }] });
  ok(headered.length === 0, 'G (player normalizer): proxyHeaders (header-dependent) streams are excluded from the PLAYER path (unchanged)');
  const clean = normalizeStreams({ streams: [{ name: 'x', url: 'https://x.example/a.mkv' }] });
  ok(clean.length === 1, 'F/G: clean entries pass (no over-filtering)');
}

// ---------------------------------------------------------------------------
// H/I — http + https both allowed at the downloader boundary
// ---------------------------------------------------------------------------

async function sectionHI(): Promise<void> {
  const { candidates } = buildDownloadCandidates(normalizeStreams({
    streams: [
      { name: 'http', url: 'http://pixeldrain.example/api/file/ab12cd' },
      { name: 'https', url: 'https://pixeldrain.example/api/file/ef12gh' },
    ],
  }));
  ok(candidates.length === 2, 'H/I: BOTH cleartext http and https media URLs are accepted');
  ok(candidates[0]?.protocol === 'http' && candidates[1]?.protocol === 'https', 'H/I: the transport is recorded per stream');
  const privateHost = buildDownloadCandidates(normalizeStreams({ streams: [{ name: 'x', url: 'http://192.168.1.10/a.mkv' }] }));
  ok(privateHost.candidates.length === 0 && privateHost.dropped['playback-boundary'] === 1, 'H/I: private/loopback hosts are still rejected at the downloader boundary');
}

// ---------------------------------------------------------------------------
// J/K — Phase 16: NO max cap, NO diversity cap, ALL eligible streams survive
// ---------------------------------------------------------------------------
// Phase 16 (task §4/§5): the previous MAX_DOWNLOAD_STREAMS_PER_ADDON=10
// cap and per-quality diversity caps (4K≤2, others≤4) have been REMOVED.
// The downloader is now a diagnostic surface for comparing MAVERO's stream
// discovery against Stremio — every eligible direct HTTP(S) stream the
// addon returned is preserved. The 7-stream pengu payload now yields ALL 6
// eligible candidates (the download-only entry is ALSO preserved — it is
// an eligible direct HTTP(S) link, even if its text says "Download Only").

async function sectionJK(): Promise<void> {
  const result = await resolveAddonDownloads({} as never, movieRequest, {
    loadAddons: loadAddonsOf([HUB]),
    loadContent: loadContentOf(CONTENT),
    dnsResolver: publicDns,
    fetcher: fetcherFor({ 'https://hdhub.example/stream/movie/tt8633518.json': new Response(JSON.stringify(penguDirectPayload()), { status: 200, headers: { 'content-type': 'application/json' } }) }, []),
  });
  const hub = result.groups[0];
  // Phase 16: NO truncation — the 7-stream payload yields ALL eligible
  // candidates (the download-only entry is preserved too — it is a direct
  // HTTP(S) link). The HLS manifest stays excluded (it is a playlist, not
  // a movie file — the existing security boundary).
  ok(hub?.status === 'loaded', 'J: the direct-file payload is loaded');
  ok((hub?.streams.length ?? 0) >= 6, 'J: Phase 16 — at least 6 of the 7 pengu streams survive (no max=10 truncation, no download-only filter)');
  const urls = hub?.streams.map((stream) => stream.url) ?? [];
  ok(urls.includes('https://pengu.example/get/webdl1080'), 'J: the 4.4 GB dual-audio 1080p WEB-DL (the most practical link) leads');
  // Phase 16: the "Download Only" entry is NOW PRESERVED (it is a direct
  // HTTP(S) link — the user decides, not the pipeline). The old hard-
  // exclusion was silently dropping streams that Stremio shows.
  ok(urls.includes('https://pengu.example/download/only'), 'J: Phase 16 — the download-only entry is PRESERVED (no over-filtering)');
  // Heavy demotion (preserved): the 45.7 GB remux still ranks BELOW the
  // practical 1080p WEB-DL (heavy penalty in the scoring, never exclusion).
  if (urls.includes('https://pengu.example/get/remux1080')) {
    const remuxIndex = urls.indexOf('https://pengu.example/get/remux1080');
    const webdlIndex = urls.indexOf('https://pengu.example/get/webdl1080');
    ok(webdlIndex < remuxIndex, 'Q: the 45.7 GB remux ranks BELOW the practical 1080p WEB-DL (heavy demotion, not heavy exclusion)');
  }
  ok(new Set(urls).size === urls.length, 'K: no duplicate URLs in the selection (true-duplicate-URL dedup preserved)');
  // Phase 16: NO diversity cap. The 4K and 1080p buckets can hold as many
  // candidates as the addon returned.
  const qualities = hub?.streams.map((stream) => stream.quality) ?? [];
  ok(qualities.filter((quality) => quality === '4K').length >= 1, 'J: Phase 16 — 4K candidates are preserved (no 4K≤2 cap)');
  ok(qualities.filter((quality) => quality === '1080p').length >= 1, 'J: Phase 16 — 1080p candidates are preserved (no 1080p≤4 cap)');

  // True-duplicate-URL dedup (Phase 16: the ONLY dedup that remains — same
  // scheme + host + path + query = the same stream offered twice). Two
  // DIFFERENT URLs with the same release text stay distinct.
  const twins = buildDownloadCandidates(normalizeStreams({
    streams: [
      { name: 'a', title: 'Movie 1080p WEB-DL H.264 Dual Audio', url: 'https://x.example/a.mkv' },
      { name: 'b', title: 'Movie 1080p WEB-DL H.264 Dual Audio', url: 'https://x.example/b.mkv' },
      { name: 'c', title: 'Movie 720p WEB-DL H.264 Dual Audio', url: 'https://x.example/c.mkv' },
    ],
  })).candidates;
  const selected = selectDownloadStreams(twins);
  ok(selected.length === 3, 'K: Phase 16 — three DISTINCT URLs survive (no equivalent-release dedup, only true-duplicate-URL dedup)');
  ok(selected.some((entry) => entry.quality === '720p'), 'K: the distinct 720p release survives');

  // Determinism: identical input → identical output (run twice).
  const again = selectDownloadStreams(twins);
  ok(JSON.stringify(again.map((entry) => entry.url)) === JSON.stringify(selected.map((entry) => entry.url)), 'J: the selection is deterministic (same input, same order)');
}

// ---------------------------------------------------------------------------
// L — state model: failed ≠ empty; isolation across addons
// ---------------------------------------------------------------------------

async function sectionL(): Promise<void> {
  const result = await resolveAddonDownloads({} as never, movieRequest, {
    loadAddons: loadAddonsOf([HUB, PIPE]),
    loadContent: loadContentOf(CONTENT),
    dnsResolver: publicDns,
    fetcher: fetcherFor({
      // HdHub: request-level failure (HTTP 500).
      'https://hdhub.example/stream/movie/tt8633518.json': new Response('boom', { status: 500 }),
      // Pipe: responds fine with a GENUINELY EMPTY streams array (Phase 17:
      // "empty" now means the addon returned zero streams — not that MAVERO
      // filtered them out. P2P/torrent/magnet/header-dependent entries are
      // all PRESERVED in Phase 17, so to test the empty state we use an
      // actual empty array).
      'https://pipe.example/stream/movie/tt8633518.json': new Response(JSON.stringify({ streams: [] }), { status: 200, headers: { 'content-type': 'application/json' } }),
    }, []),
  });
  const hub = result.groups.find((group) => group.addonName === 'HdHub');
  const pipe = result.groups.find((group) => group.addonName === 'Pipe');
  ok(hub?.status === 'failed' && typeof hub.errorCode === 'string' && hub.streams.length === 0, 'L: REQUEST FAILED is its own state (typed closed error code, no stream data)');
  ok(hub?.errorCode === 'HTTP_ERROR', 'L: the failure code uses the closed vocabulary (HTTP_ERROR)');
  ok(pipe?.status === 'empty' && pipe.streams.length === 0 && pipe.errorCode === undefined, 'L (Phase 17): LOADED ZERO = the addon genuinely returned zero streams (NOT that MAVERO filtered them)');
  ok(hub?.status === 'failed' && pipe?.status === 'empty', 'L: one addon failure never breaks the other addon group');
  ok(!JSON.stringify(result.groups).includes('boom'), 'T: raw upstream error text never reaches the response');
}

// ---------------------------------------------------------------------------
// M/N/O — actions: copy/download original URL; external-player launch
// ---------------------------------------------------------------------------

function sectionMNO(): void {
  // Phase 16 (task §1/§3/§15/§16): the downloader card now has exactly TWO
  // actions — Download + Share. The previous Play/Watch + Copy actions
  // have been REMOVED. Share uses navigator.share() with the EXACT ORIGINAL
  // addon URL (the same URL the old Copy button copied).
  const component = read('src/lib/components/MaveroAddonDownload.svelte');
  ok(!component.includes('copyStreamUrl'), 'M (Phase 16): Copy action is REMOVED from the downloader card');
  ok(!component.includes('Play size='), 'M (Phase 16): Play/Watch action is REMOVED from the downloader card');
  ok(!component.includes('mad-action-play'), 'M (Phase 16): the mad-action-play CSS class is gone (no Play button)');
  ok(component.includes('href={stream.url}'), 'N: Download navigates the ORIGINAL addon URL (unchanged)');
  ok(component.includes('navigator.share'), 'M (Phase 16): Share uses navigator.share() with the original URL');
  ok(component.includes('Share2 size='), 'M (Phase 16): the Share button is present (lucide Share2 icon)');
  ok(!component.includes('/api/playback/compat') && !component.includes('media-worker'), 'M/N: the downloader UI references NO compat/worker path');
  ok(component.includes('MAVERO Downloader'), 'M (Phase 17): the header shows "MAVERO Downloader" (no "Available links")');

  // External player launch (pure helper — preserved for back-compat, used
  // by the standalone deep-link pages and the /api/downloader/mavero flow).
  const httpsUrl = 'https://provider.example/dl/Movie.1080p.mkv?token=x';
  const android = externalPlayerLaunchFor(httpsUrl, { android: true });
  ok(android?.kind === 'android-intent' && android.href.startsWith('intent://provider.example/dl/Movie.1080p.mkv?token=x#Intent;scheme=https;'), 'O: the Android launch is a VIEW intent carrying the ORIGINAL host/path/query');
  ok(android?.href.includes(`package=${MPV_ANDROID_PACKAGE}`), `O: the intent targets mpv-android (${MPV_ANDROID_PACKAGE})`);
  ok(android?.href.includes(`S.browser_fallback_url=${encodeURIComponent(httpsUrl)}`), 'O: the fallback URL preserves the FULL original address (graceful when mpv is NOT installed)');
  const plain = externalPlayerLaunchFor('http://pixeldrain.example/api/file/ab12cd', { android: true });
  ok(plain?.href.startsWith('intent://pixeldrain.example/api/file/ab12cd#Intent;scheme=http;') === true, 'O: cleartext http launches work (scheme carried into the intent)');
  const desktop = externalPlayerLaunchFor(httpsUrl, { android: false });
  ok(desktop?.kind === 'direct' && desktop.href === httpsUrl, 'O: non-Android environments get the original URL directly (desktop browsers never break)');
  ok(externalPlayerLaunchFor('ftp://x.example/a.mkv', { android: true }) === null, 'O: unsupported schemes never launch');
  ok(externalPlayerLaunchFor('not a url', { android: false }) === null, 'O: invalid URLs never launch');
  ok(externalPlayerHint({ kind: 'android-intent' }) === 'To play this source, install mpv.', 'O: the exact-launch hint states the mpv requirement');
  ok(externalPlayerHint({ kind: 'direct' }) === 'This source opens in an external player.', 'O: the fallback hint describes the handoff honestly');
  ok(isAndroidUserAgent('Mozilla/5.0 (Linux; Android 14; Pixel 8)') && !isAndroidUserAgent('Mozilla/5.0 (Windows NT 10.0)'), 'O: Android detection is best-effort by user agent');
}

// ---------------------------------------------------------------------------
// P/Q — candidate policy details
// ---------------------------------------------------------------------------

function sectionPQ(): void {
  // Manifests and non-video files are never downloads.
  const excluded = buildDownloadCandidates(normalizeStreams({
    streams: [
      { name: 'hls', url: 'https://x.example/master.m3u8' },
      { name: 'hls-text', title: 'HLS playlist', url: 'https://x.example/playlist' },
      { name: 'dash', url: 'https://x.example/manifest.mpd' },
      { name: 'dash-text', title: 'MPEG-DASH', url: 'https://x.example/stream' },
      { name: 'sub', url: 'https://x.example/subs.srt' },
      { name: 'img', url: 'https://x.example/img', behaviorHints: { filename: 'poster.jpg' } },
    ],
  }));
  ok(excluded.candidates.length === 0, 'P: HLS/DASH manifests and non-video files are excluded from the download list');
  ok(excluded.dropped['streaming-manifest'] >= 3, 'P: manifest exclusions are counted as streaming-manifest drops');
  ok(excluded.dropped['non-video'] >= 2, 'P: non-video exclusions are counted');

  // Size parsing + scoring policy.
  ok(sizeFromTexts(['Dhurandhar 1080p 45.70 GB']) === Math.round(45.7 * 1024 ** 3), 'Q: "45.70 GB" text parses to bytes');
  ok(sizeFromTexts(['4.40 GB']) === Math.round(4.4 * 1024 ** 3), 'Q: decimal GB text parses (the shared helper requires ≥10 GB — downloads parse any size)');
  const base = { index: 0, audio: 'unknown' as const, codec: 'H.264' as const, quality: '1080p' as const, protocol: 'https' as const, hostClass: 'known' as const, releaseKey: '' };
  const mk = (over: Partial<DownloadStreamCandidate>): DownloadStreamCandidate => ({ ...base, url: 'https://x.example/a', ...over });
  ok(scoreDownloadCandidate(mk({ title: '1080p WEB-DL Dual Audio', sizeBytes: 4_724_904_960 })) < scoreDownloadCandidate(mk({ title: '1080p BluRay REMUX Dual Audio', sizeBytes: 49_073_043_456 })), 'Q: a 4.4 GB WEB-DL outranks a 45.7 GB REMUX at 1080p');
  ok(scoreDownloadCandidate(mk({ title: '1080p WEB-DL', sizeBytes: 4_724_904_960 })) < scoreDownloadCandidate(mk({ title: '1080p CAM', sizeBytes: 4_724_904_960 })), 'Q: CAM releases are penalized');
  ok(scoreDownloadCandidate(mk({ title: '1080p', container: 'MKV' })) < scoreDownloadCandidate(mk({ title: '1080p' })), 'Q: known metadata (container/filename) earns a bonus');
  ok(scoreDownloadCandidate(mk({ title: '1080p Multi Audio', audio: 'multi' })) < scoreDownloadCandidate(mk({ title: '1080p Hindi', audio: 'single' })), 'Q: Multi Audio outranks single audio at the same quality/format');
  ok(scoreDownloadCandidate(mk({ title: '1080p', quality: '4K', sizeBytes: 33 * 1024 ** 3 })) > scoreDownloadCandidate(mk({ title: '1080p WEB-DL', sizeBytes: 4_724_904_960 })), 'Q: a 33 GB 4K never outranks a normal 1080p file');
  ok(scoreDownloadCandidate(mk({ title: '1080p', quality: 'auto' })) > scoreDownloadCandidate(mk({ title: '1080p', quality: '480p' })), 'Q: auto/unknown ranks below every known bucket');

  // No over-filtering: HEVC-only / 4K-only / http-only addons still surface.
  const hevcOnly = selectDownloadStreams(buildDownloadCandidates(normalizeStreams({ streams: [{ name: 'a', title: '1080p HEVC 10-bit', url: 'https://x.example/hevc.mkv' }] })).candidates);
  ok(hevcOnly.length === 1 && hevcOnly[0]?.codec === 'HEVC', 'Q: an HEVC-only addon still offers its link');
  const fourKOnly = selectDownloadStreams(buildDownloadCandidates(normalizeStreams({ streams: [{ name: 'a', title: '2160p UHD', url: 'https://x.example/uhd.mkv' }] })).candidates);
  ok(fourKOnly.length === 1 && fourKOnly[0]?.quality === '4K', 'Q: a 4K-only addon still offers its link');
  const httpOnly = selectDownloadStreams(buildDownloadCandidates(normalizeStreams({ streams: [{ name: 'a', title: '1080p', url: 'http://x.example/a.mkv' }] })).candidates);
  ok(httpOnly.length === 1 && httpOnly[0]?.protocol === 'http', 'Q: an http-only addon still offers its link (HTTPS is a preference, never a requirement)');

  // Phase 16 (task §5): the "Download Only" entry is NOW PRESERVED — it is
  // a direct HTTP(S) link and the user decides, not the pipeline. The old
  // hard-exclusion was silently dropping streams that Stremio shows.
  const onlyDownload = buildDownloadCandidates(normalizeStreams({ streams: [{ name: 'a', title: '10Gbps Download Only', url: 'https://x.example/dl.mkv' }] }));
  ok(onlyDownload.candidates.length === 1, 'Q (Phase 16): a download-only-marked addon STILL resolves to a candidate (no over-filtering)');
  // A heavy remux-only addon still surfaces its (single) honest choice.
  const heavyOnly = selectDownloadStreams(buildDownloadCandidates(normalizeStreams({ streams: [{ name: 'a', title: '1080p BluRay REMUX', url: 'https://x.example/remux.mkv', behaviorHints: { videoSize: 49_073_043_456 } }] })).candidates);
  ok(heavyOnly.length === 1, 'Q: a heavy-only addon still surfaces its fallback choice (no over-filtering)');
}

// ---------------------------------------------------------------------------
// R — no media fetch, no worker, no FFmpeg from the downloader path
// ---------------------------------------------------------------------------

async function sectionR(): Promise<void> {
  const calls: string[] = [];
  await resolveAddonDownloads({} as never, movieRequest, {
    loadAddons: loadAddonsOf([HUB, PIPE]),
    loadContent: loadContentOf(CONTENT),
    dnsResolver: publicDns,
    fetcher: fetcherFor({
      'https://hdhub.example/stream/movie/tt8633518.json': new Response(JSON.stringify(hubPayload()), { status: 200, headers: { 'content-type': 'application/json' } }),
      'https://pipe.example/stream/movie/tt8633518.json': new Response(JSON.stringify(pipeHttpPayload()), { status: 200, headers: { 'content-type': 'application/json' } }),
    }, calls),
  });
  ok(calls.every((url) => !url.includes('pixeldrain') && !url.includes('hub-cdn') && !url.includes('pengu.example/get')), 'R: NO media URL is ever fetched server-side (only the stream LIST endpoints)');
  ok(calls.every((url) => !url.includes('/compat/') && !url.includes('media-worker')), 'R: NO compatibility/worker request happens');
  const serviceSource = read('src/lib/server/streaming/stremio/addon-download-service.ts');
  ok(!serviceSource.includes('../apps/media-worker') && !serviceSource.includes('session-tokens') && !serviceSource.includes('media-compat') && !serviceSource.includes('signCompatToken'), 'R: the downloader service imports NO worker/compat machinery (FFmpeg is unreachable)');
  ok(!serviceSource.includes('fetchStremioStreamResponse') === false, 'R: the service goes through the hardened stream fetcher');
}

// ---------------------------------------------------------------------------
// S — public config injection of the built-in provider
// ---------------------------------------------------------------------------

function sectionS(): void {
  const origin = 'https://mavero.app';
  const provider = builtinMaveroDownloaderProvider(origin);
  ok(provider.id === 'mavero-downloader' && provider.slug === 'mavero-downloader', 'S: the built-in provider has a stable id/slug');
  ok(provider.supportsMovie && provider.supportsTv && !provider.isDefault && provider.ordering === Number.MAX_SAFE_INTEGER, 'S: it supports both types, is never the default, sorts LAST');
  ok(provider.movieUrlTemplate === `${origin}/watch/mavero-downloader/movie/{tmdbId}` && provider.tvUrlTemplate === `${origin}/watch/mavero-downloader/tv/{tmdbId}/{season}/{episode}`, 'S: its templates deep-link the standalone pages on the CURRENT origin');
  const config = { version: 1, updatedAt: 'now', providers: [{ id: 'db-1', name: 'Cineverse', slug: 'cineverse', enabled: true, isDefault: true, ordering: 1, icon: null, description: null, supportsMovie: true, supportsTv: true, movieUrlTemplate: 'https://x.example/{tmdbId}', tvUrlTemplate: 'https://x.example/{tmdbId}/{season}/{episode}' }] };
  const injected = withMaveroDownloaderProvider(config as never, origin);
  ok(injected.providers.length === 2 && injected.providers[injected.providers.length - 1]?.slug === 'mavero-downloader', 'S: the built-in provider is appended to the public config');
  ok(withMaveroDownloaderProvider(injected as never, origin).providers.length === 2, 'S: injection is dedupe-safe (idempotent)');
  const routeSource = read('src/routes/api/downloader/config/+server.ts');
  ok(routeSource.includes('withMaveroDownloaderProvider'), 'S: the public config endpoint actually injects the built-in provider');
}

// ---------------------------------------------------------------------------
// T — the API view is presentation-safe + episode scoping
// ---------------------------------------------------------------------------

async function sectionT(): Promise<void> {
  const result = await resolveAddonDownloads({} as never, movieRequest, {
    loadAddons: loadAddonsOf([PIPE]),
    loadContent: loadContentOf(CONTENT),
    dnsResolver: publicDns,
    fetcher: fetcherFor({ 'https://pipe.example/stream/movie/tt8633518.json': new Response(JSON.stringify(pipeHttpPayload()), { status: 200, headers: { 'content-type': 'application/json' } }) }, []),
  });
  const serialized = JSON.stringify(result.groups);
  ok(!serialized.includes('manifest') && !serialized.includes('proxyHeaders') && !serialized.includes('Referer'), 'T: the view never leaks manifest URLs, header names or configuration');
  ok(result.groups[0]?.streams.every((stream) => typeof stream.url === 'string' && typeof stream.quality === 'string' && typeof stream.confidence === 'string'), 'T: streams carry the presentation contract (url/quality/confidence)');
  ok(result.groups[0]?.streams.every((stream) => !('index' in stream) && !('score' in stream)), 'T: internal ranking fields (index/score) never reach the view');

  // Episode scoping: series requests require safe season/episode integers.
  await assert.rejects(
    () => resolveAddonDownloads({} as never, { mediaType: 'series', contentId: 'series-94605' }, { loadAddons: loadAddonsOf([]), loadContent: loadContentOf(CONTENT) }),
    (error: unknown) => error instanceof Error && (error as { code?: string }).code === 'INVALID_REQUEST',
    'T: a series request without season/episode is INVALID_REQUEST (400)',
  );
  // An ineligible addon is EMPTY (never FAILED) — honest zero, not an error.
  const ineligible = addonFixture({ id: '00000000-0000-4000-8000-14000000cat9', name: 'CatalogOnly', slug: 'catalog-only', manifestUrl: 'https://cat.example/manifest.json', resources: ['catalog', 'meta'], capabilities: { supportsStream: false, manifestId: 'c.x', manifestVersion: '1.0.0', normalizedAt: 'now', streamTypes: [], streamIdPrefixes: [] } } as never);
  const emptyResult = await resolveAddonDownloads({} as never, movieRequest, {
    loadAddons: loadAddonsOf([ineligible]),
    loadContent: loadContentOf(CONTENT),
    dnsResolver: publicDns,
    fetcher: fetcherFor({}, []),
  });
  ok(emptyResult.groups[0]?.status === 'empty' && emptyResult.groups[0]?.errorCode === undefined, 'T: an ineligible addon is LOADED ZERO (never a request failure)');
}

// ---------------------------------------------------------------------------
// runner
// ---------------------------------------------------------------------------

sectionDE();
sectionFG();
sectionMNO();
sectionPQ();
sectionS();

await sectionA();
await sectionBC();
await sectionHI();
await sectionJK();
await sectionL();
await sectionR();
await sectionT();

console.log(`stremio_downloader_phase14_test: ${passed} checks passed (downloader selection + external player + state model + config injection + no-media-fetch/FFmpeg isolation)`);
