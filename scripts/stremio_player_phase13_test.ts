import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, rmSync, mkdtempSync, chmodSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import type { PlayerQualityOption } from '$lib/shared/player';
import { bucketForHeight, audioClassFor, releaseClassFor, sizeFromText, rankOf, selectAddonStreams, MAX_STREAMS_PER_QUALITY, MAX_SELECTED_STREAMS_PER_ADDON, MAX_EQUIVALENT_RELEASES, QUALITY_DISPLAY_ORDER } from '$lib/shared/stream-selection';
import { classifyStreamCompatibility, compatibilityBadgeText } from '$lib/shared/media-compat';
import { validateAddonStreamPlaybackUrl } from '$lib/server/resolver/safe-url';
import { normalizeStremioStreamResponse } from '$lib/server/streaming/stremio/stream-normalize';
import { createAddonSession, resolveAddonToken, type ContentLookup } from '$lib/server/streaming/stremio/addon-session';
import { signAddonToken, signCompatToken } from '$lib/server/streaming/stremio/session-tokens';
import { mergeMaveroResults } from '$lib/client/player/mavero-progressive';
import { buildMaveroAddonTabs, defaultMaveroAddonTab, maveroStreamHeadline, orderMaveroStreamsForSheet, groupMaveroStreams } from '$lib/client/player/mavero-streams';
import { downloadAttributesFor } from '$lib/client/player/stream-actions';
import { resolveSandboxRuntime, iframeSandboxAttribute } from '$lib/shared/sandbox-policy';
import { JobRegistry } from '../apps/media-worker/src/jobs';
import { loadConfig } from '../apps/media-worker/src/config';
import type { StreamingAddon } from '$lib/shared/streaming-addons';

/**
 * Phase 13 test suite — the STREAM-SELECTION product layer.
 *
 *   A   Quality buckets: 480p / 720p / 1080p / 4K (2160p/UHD/4K), auto for
 *       unknown — never dozens of quality tabs.
 *   B   Audio: Dual Audio / Multi Audio / MULTI / "Hindi + English" /
 *       "Hindi English" outrank single-audio; "Hindi" ALONE stays single.
 *   C   Protocol: at the same quality, HLS outranks an incompatible MKV.
 *   D   Format: MP4/HLS outrank heavy download-oriented MKV releases.
 *   E   Heavy: Remux / BluRay Remux / huge sizes are demoted or hidden;
 *       "Download Only" is excluded outright.
 *   F   Direct-playable outranks conversion-required; conversion stays a
 *       selectable fallback (never auto-started).
 *       Phase 14 UPDATE: the PLAYER surface keeps ONLY addon HLS streams —
 *       direct files are isolated to the Mavero Downloader (its companion
 *       suite stremio_downloader_phase14_test.ts pins the download side).
 *   G   The compatibility worker is NOT invoked at discovery: resolving an
 *       addon mints signed references only — no worker fetch, no job.
 *   H   Retry determinism: a FAILED worker job + the same still-valid token
 *       creates a FRESH attempt (the Phase 12 "Source not available" bug).
 *   I   Pipe: a real Pipe-shaped manifest (multi idProperty + tt prefixes)
 *       serving cleartext http:// PixelDrain links is retained — Phase 14:
 *       on the DOWNLOAD surface (the player offers addon HLS only).
 *   J   Addon failure isolation: a failed addon never breaks the others.
 *   K   Tab counts equal the FINAL usable stream counts (post-selection).
 *   L   Sandbox: the source UI exposes the override + effective policy; the
 *       runtime hierarchy is unchanged.
 *   M   Download: the Opening… state exists; the ORIGINAL URL is preserved.
 *   N   HLS: a good HLS stream stays direct/native and leads the pool.
 */

let passed = 0;
function ok(condition: unknown, label: string) {
  assert.ok(condition, label);
  passed += 1;
}

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative: string) => readFileSync(path.join(REPO_ROOT, relative), 'utf8');
const SECRET = 'phase13-session-secret-0123456789abcdef';
const WORKER_SECRET = 'phase13-worker-secret-0123456789abcdef';
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const PIPE_ADDON: StreamingAddon = {
  id: '00000000-0000-4000-8000-13000000pipe',
  name: 'Pipe',
  slug: 'pipe',
  manifestUrl: 'https://pipe-addon.example/manifest.json',
  enabled: true,
  status: 'experimental',
  ordering: 2,
  supportedTypes: ['movie', 'series'],
  idPrefixes: ['tt'],
  resources: ['catalog', 'meta', 'stream'],
  capabilities: {
    supportsStream: true,
    manifestId: 'community.pipe',
    manifestVersion: '1.1.0',
    normalizedAt: new Date().toISOString(),
    streamTypes: ['movie', 'series'],
    streamIdPrefixes: ['tt'],
    idProperties: ['tmdb_id', 'imdb_id'],
  },
} as unknown as StreamingAddon;

const HUB_ADDON: StreamingAddon = {
  id: '00000000-0000-4000-8000-13000000hub0',
  name: 'HdHub',
  slug: 'hdhub',
  manifestUrl: 'https://hdhub.example/manifest.json',
  enabled: true,
  status: 'active',
  ordering: 0,
  supportedTypes: ['movie', 'series'],
  idPrefixes: ['tt'],
  resources: ['catalog', 'meta', 'stream'],
  capabilities: { supportsStream: true, manifestId: 'community.hdhub', normalizedAt: new Date().toISOString(), streamTypes: ['movie', 'series'], streamIdPrefixes: ['tt'], idProperties: ['imdb_id'] },
} as unknown as StreamingAddon;

const CONTENT: ContentLookup = { title: 'Dhurandhar: The Revenge', identifiers: { imdbId: 'tt8633518', tmdbId: '1094521' } };
const loadContentOf = (lookup: ContentLookup) => async () => lookup;
/** Mirrors the production server: play class comes from the shared classifier. */
const withPlay = <T extends { protocol?: string; container?: string; codec?: string; filename?: string; title?: string; description?: string; name?: string }>(input: T) => ({
  ...input,
  playClass: (() => {
    const verdict = classifyStreamCompatibility({ protocol: input.protocol, container: input.container, codec: input.codec, filename: input.filename, title: input.title, description: input.description, name: input.name });
    if (verdict.tier === 'DIRECT_PLAYABLE') return 'direct' as const;
    if (verdict.tier === 'DIRECT_UNCERTAIN') return 'uncertain' as const;
    if (verdict.tier === 'REMUX_REQUIRED') return 'remux' as const;
    if (verdict.tier === 'TRANSCODE_REQUIRED') return 'transcode' as const;
    return 'unsupported' as const;
  })(),
});

/**
 * The PRODUCTION pipeline shape: raw addon payload → normalizeStremioStreamResponse
 * (extracts height/codec/container/filename/audioLanguages from addon text) →
 * selection inputs + classifier play class. Tests that exercise selection with
 * anything less would not test the real pipeline.
 */
function selectionInputsFromPayload(payload: unknown) {
  return normalizeStremioStreamResponse(payload).streams.map((stream) => {
    const input = {
      url: stream.url,
      protocol: stream.protocol,
      container: stream.container,
      codec: stream.codec,
      filename: stream.filename,
      name: stream.name,
      title: stream.title,
      description: stream.description,
      ...(stream.audioLanguages?.length ? { audioLanguages: stream.audioLanguages } : {}),
      ...(stream.subtitles?.length ? { subtitleCount: stream.subtitles.length } : {}),
      ...(stream.videoSize !== undefined ? { videoSize: stream.videoSize } : {}),
      ...(stream.quality.height !== undefined ? { height: stream.quality.height } : {}),
    };
    const verdict = classifyStreamCompatibility({ protocol: stream.protocol, container: stream.container, codec: stream.codec, filename: stream.filename, title: stream.title, description: stream.description });
    const playClass = verdict.tier === 'DIRECT_PLAYABLE' ? 'direct' as const : verdict.tier === 'DIRECT_UNCERTAIN' ? 'uncertain' as const : verdict.tier === 'REMUX_REQUIRED' ? 'remux' as const : verdict.tier === 'TRANSCODE_REQUIRED' ? 'transcode' as const : 'unsupported' as const;
    return { ...input, playClass };
  });
}
function addonById(all: StreamingAddon[]) {
  return async (_client: unknown, id: string) => all.find((addon) => addon.id === id) ?? null;
}

/** A realistic PenguPlay-style raw payload: heavy, dual-audio, HLS mix. */
function penguPayload() {
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

function hubPayload() {
  return {
    streams: [
      { name: '1080p HLS', title: 'HLS', url: 'https://hub-cdn.example/hls/s1/index.m3u8?token=signed' },
      { name: '1080p', title: '1080p H.264 MP4 Hindi', url: 'https://hub-cdn.example/file/movie.mp4' },
    ],
  };
}

function addonTokenOf(session: Awaited<ReturnType<typeof createAddonSession>>, name: string): string {
  const token = session.addons.find((addon) => addon.name === name)?.token;
  assert.ok(typeof token === 'string' && token.length > 0);
  return token;
}

// ---------------------------------------------------------------------------
// A — quality buckets
// ---------------------------------------------------------------------------

function sectionA(): void {
  ok(bucketForHeight(1080) === '1080p' && bucketForHeight(720) === '720p' && bucketForHeight(480) === '480p', 'A: 1080p/720p/480p map to their buckets');
  ok(bucketForHeight(2160) === '4K' && bucketForHeight(1440) === '4K', 'A: 2160p/1440p fold into the 4K bucket');
  ok(bucketForHeight(360) === 'auto' && bucketForHeight(undefined) === 'auto', 'A: unknown/sub-480p stays `auto` (never a fake bucket)');
  // Text-driven heights ride normalization → bucket (4K/UHD/2160p).
  const normalized = normalizeStremioStreamResponse({
    streams: [
      { name: '4K', url: 'https://x.example/a.mkv' },
      { name: 'UHD', url: 'https://x.example/b.mkv' },
      { name: '2160p', url: 'https://x.example/c.mkv' },
      { name: '1080p', url: 'https://x.example/d.mkv' },
      { name: '720p', url: 'https://x.example/e.mkv' },
      { name: '480p', url: 'https://x.example/f.mkv' },
      { name: 'Movie night', url: 'https://x.example/g.mkv' },
    ],
  });
  const buckets = normalized.streams.map((stream) => bucketForHeight(stream.quality.height));
  ok(JSON.stringify(buckets) === JSON.stringify(['4K', '4K', '4K', '1080p', '720p', '480p', 'auto']), 'A: addon quality text normalizes into exactly the four buckets (+auto)');
  // A 30-stream addon collapses into a bounded, bucket-ordered candidate set.
  const raw = Array.from({ length: 30 }, (_, index) => ({
    url: `https://x.example/s${index}.mkv`,
    protocol: 'mp4',
    container: 'mkv',
    codec: 'h264',
    height: [1080, 720, 480, 2160][index % 4],
    title: index % 2 ? 'Dual Audio' : 'Hindi',
  }));
  const selection = selectAddonStreams(raw);
  ok(selection.length <= MAX_SELECTED_STREAMS_PER_ADDON, `A: ${raw.length} raw streams collapse to ≤ ${MAX_SELECTED_STREAMS_PER_ADDON} candidates`);
  ok(selection.length === 8, 'A: four buckets × best-two = 8 diverse candidates (30 raw in)');
  const bucketsInOrder = selection.map((entry) => entry.usability.bucket);
  const firstIndexOf = (bucket: string) => bucketsInOrder.indexOf(bucket as never);
  ok(QUALITY_DISPLAY_ORDER.slice(0, 4).every((bucket) => {
    const count = bucketsInOrder.filter((entry) => entry === bucket).length;
    return count === 0 || bucketsInOrder.lastIndexOf(bucket) - bucketsInOrder.indexOf(bucket) === count - 1;
  }), 'A: candidates of one bucket appear CONTIGUOUSLY (no dozens of quality tabs, grouped list)');
  ok(firstIndexOf('1080p') < firstIndexOf('720p') && firstIndexOf('720p') < firstIndexOf('480p') && firstIndexOf('480p') < firstIndexOf('4K'), 'A: bucket order is 1080p → 720p → 480p → 4K');
}

// ---------------------------------------------------------------------------
// B — audio preference
// ---------------------------------------------------------------------------

function sectionB(): void {
  ok(audioClassFor({ title: '1080p Dual Audio Hindi English' }) === 'dual', 'B: "Dual Audio" detects dual');
  ok(audioClassFor({ title: '1080p Dual-Audio' }) === 'dual', 'B: hyphenated Dual-Audio detects dual');
  ok(audioClassFor({ title: '1080p Multi Audio' }) === 'multi', 'B: "Multi Audio" detects multi');
  ok(audioClassFor({ title: 'Dhurandhar MULTI 1080p' }) === 'multi', 'B: standalone MULTI detects multi');
  ok(audioClassFor({ title: '1080p 2 Audio Hindi English' }) === 'multi', 'B: "2 Audio" counts as multi-class (multi outranks dual)');
  ok(audioClassFor({ title: '1080p Hindi + English' }) === 'dual', 'B: "Hindi + English" convention detects dual');
  ok(audioClassFor({ title: '1080p Hindi English' }) === 'dual', 'B: adjacent two-language "Hindi English" detects dual (task pattern list)');
  ok(audioClassFor({ title: '1080p Hindi' }) === 'single', 'B: "Hindi" ALONE is single audio — never invented into dual');
  ok(audioClassFor({ audioLanguages: ['Hindi', 'English'] }) === 'dual', 'B: structured 2-language metadata reads dual');
  ok(audioClassFor({ title: '1080p WEB-DL' }) === 'unknown', 'B: no audio signal stays unknown (never invented)');

  // Ranking influence: dual/multi outrank single at IDENTICAL format/quality.
  const dual = { url: 'https://x.example/dual.mp4', protocol: 'mp4', height: 1080, title: '1080p Dual Audio' };
  const single = { url: 'https://x.example/single.mp4', protocol: 'mp4', height: 1080, title: '1080p Hindi' };
  const multi = { url: 'https://x.example/multi.mp4', protocol: 'mp4', height: 1080, title: '1080p Multi Audio' };
  const ranked = selectAddonStreams([single, dual, multi].map(withPlay));
  ok(ranked[0]?.stream.url === multi.url, 'B: Multi Audio outranks Dual and single at the same quality/format');
  ok(ranked[1]?.stream.url === dual.url, 'B: Dual Audio outranks single audio at the same quality/format');
}

// ---------------------------------------------------------------------------
// C — protocol: HLS outranks incompatible MKV at the same quality
// ---------------------------------------------------------------------------

function sectionC(): void {
  const hls = { url: 'https://x.example/h.m3u8', protocol: 'hls', height: 1080, title: '1080p' };
  const hevcMkv = { url: 'https://x.example/hevc.mkv', protocol: 'unknown', container: 'mkv', codec: 'hevc', height: 1080, title: '1080p HEVC 10-bit' };
  const h264Mkv = { url: 'https://x.example/h264.mkv', protocol: 'unknown', container: 'mkv', codec: 'h264', height: 1080, title: '1080p H.264' };
  const ranked = selectAddonStreams([hevcMkv, h264Mkv, hls].map(withPlay));
  ok(ranked[0]?.stream.url === hls.url, 'C: HLS leads its quality bucket over BOTH MKV shapes');
  ok(ranked[1]?.stream.url === h264Mkv.url, 'C: the H.264 MKV (fast remux fallback) fills the second slot');
  ok(ranked.length === 2 && ranked.every((entry) => entry.stream.url !== hevcMkv.url), 'C: the HEVC transcode candidate is cut by the per-quality cap (noise reduction — the task §5 4th choice)');
  ok(rankOf({ ...h264Mkv, playClass: 'remux' }, 0).rank < rankOf({ ...hevcMkv, playClass: 'transcode' }, 1).rank, 'C: play classes order direct < remux < transcode (a remux fallback outranks a transcode fallback)');
}

// ---------------------------------------------------------------------------
// D/E — heavy download-oriented releases
// ---------------------------------------------------------------------------

function sectionDE(): void {
  ok(releaseClassFor({ title: 'Dhurandhar 1080p BluRay REMUX' }) === 'heavy', 'E: REMUX marker → heavy');
  ok(releaseClassFor({ title: 'Movie 2019 BluRay Remux 1080p' }) === 'heavy', 'E: BluRay Remux → heavy');
  ok(releaseClassFor({ title: 'Movie BDRemux 1080p' }) === 'heavy', 'E: BDRemux → heavy');
  ok(releaseClassFor({ title: 'Movie 2019 BluRay x264 1080p' }) === 'streaming', 'E: a normal BluRay ENCODE stays streaming (no over-filtering)');
  ok(releaseClassFor({ title: '10Gbps Download Only' }) === 'download-only', 'E: "10Gbps Download Only" → download-only');
  ok(releaseClassFor({ title: 'Download Only 1080p' }) === 'download-only', 'E: "Download Only" → download-only');
  ok(sizeFromText(['Dhurandhar 1080p 45.70 GB']) === Math.round(45.7 * 1024 ** 3), 'E: "45.70 GB" text parses to bytes');
  ok(releaseClassFor({ title: 'Dhurandhar 1080p 45.70 GB' }) === 'heavy', 'E: a stated 45.7 GB 1080p release is heavy');
  ok(releaseClassFor({ videoSize: 49_073_043_456, height: 1080 }) === 'heavy', 'E: a 45.7 GB videoSize at 1080p is heavy');
  ok(releaseClassFor({ videoSize: 4_724_904_960, height: 1080 }) === 'streaming', 'E: a 4.4 GB 1080p encode stays streaming');
  ok(releaseClassFor({ videoSize: 19_539_396_608, height: 2160 }) === 'streaming', 'E: an 18 GB 4K release stays streaming (generous 4K ceiling)');

  // Ranking: the 1080p remux never leads its bucket when a WEB-DL exists.
  const remux = { url: 'https://x.example/remux.mkv', protocol: 'unknown', container: 'mkv', codec: 'h264', height: 1080, title: '1080p BluRay REMUX Dual Audio 45.70 GB', videoSize: 49_073_043_456 };
  const webdl = { url: 'https://x.example/webdl.mp4', protocol: 'mp4', height: 1080, title: '1080p WEB-DL Dual Audio 4.40 GB', videoSize: 4_724_904_960 };
  const ranked = selectAddonStreams([remux, webdl].map(withPlay));
  ok(ranked[0]?.stream.url === webdl.url, 'D/E: the 4.4 GB streaming release outranks the 45.7 GB remux at 1080p');
  ok(ranked.every((entry) => entry.stream.url !== remux.url), 'D/E: the heavy remux is HIDDEN when a streaming alternative exists');

  // Download-only never reaches the user — even as the sole candidate.
  const downloadOnly = { url: 'https://x.example/dl.mkv', protocol: 'unknown', title: '10Gbps Download Only 45 GB' };
  ok(selectAddonStreams([downloadOnly].map(withPlay)).length === 0, 'E: a download-only-only addon resolves to NO candidates');

  // Heavy-only addon: heavy surfaces as the honest last resort (user decides).
  const heavyOnly = selectAddonStreams([remux].map(withPlay));
  ok(heavyOnly.length === 1 && heavyOnly[0]?.usability.release === 'heavy', 'E: a remux-only addon still offers its (single) fallback choice');

  // The realistic PenguPlay payload: 7 raw → a handful of final candidates,
  // remux + download-only gone (through the REAL normalization pipeline).
  const selection = selectAddonStreams(selectionInputsFromPayload(penguPayload()));
  const urls = selection.map((entry) => entry.stream.url);
  ok(!urls.includes('https://pengu.example/get/remux1080'), 'E: the PenguPlay 45.7 GB remux does not reach the final list');
  ok(!urls.includes('https://pengu.example/download/only'), 'E: the PenguPlay download-only entry does not reach the final list');
  ok(urls.includes('https://pengu.example/get/webdl1080'), 'E: the 4.4 GB dual-audio 1080p WEB-DL survives (the useful candidate)');
  ok(selection.length <= 8, `E: 7 raw PenguPlay streams → ${selection.length} final candidates (≤ ${MAX_SELECTED_STREAMS_PER_ADDON})`);
}

// ---------------------------------------------------------------------------
// F/G — direct first; worker NOT invoked at discovery
// ---------------------------------------------------------------------------

async function sectionFG(): Promise<void> {
  const client = {} as never;
  const fetchedUrls: string[] = [];
  const session = await createAddonSession(client, { mediaType: 'movie', contentId: 'content-13' }, {
    secret: SECRET,
    sessionId: 'session-13',
    loadAddons: async () => [HUB_ADDON, PIPE_ADDON],
    loadContent: loadContentOf(CONTENT),
  });
  ok(session.addons.length === 2, 'F/G: the session mints tokens for both addons');

  // The addon response is a PenguPlay-style mix: remux + HEVC + WEB-DL MKVs.
  const resolution = await resolveAddonToken(client, { sessionId: 'session-13', token: addonTokenOf(session, 'Pipe') }, { contentId: 'content-13', mediaType: 'movie' }, {
    secret: SECRET,
    loadAddonById: addonById([PIPE_ADDON]),
    loadContent: loadContentOf(CONTENT),
    dnsResolver: (async (hostname: string) => [{ address: '93.184.216.34', family: 4 }]) as never,
    fetcher: (async (url: string | URL) => {
      fetchedUrls.push(String(url));
      return new Response(JSON.stringify(penguPayload()), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch,
  });
  ok(resolution.result.status === 'ok', 'F/G: the mixed addon resolves ok');
  if (resolution.result.status !== 'ok') return;

  // G: discovery performed EXACTLY ONE outbound fetch — the addon endpoint.
  // No worker URL, no conversion job, no media HEAD/GET. The worker is
  // invoked ONLY when the user explicitly selects a fallback stream later.
  ok(fetchedUrls.length === 1 && fetchedUrls[0] === 'https://pipe-addon.example/stream/movie/tt8633518.json', 'G: discovery fetched ONLY the addon stream endpoint (no worker, no media probing)');
  ok(fetchedUrls.every((url) => !url.includes('/compat/') && !url.includes('media-worker')), 'G: no compatibility-worker request happens at discovery');

  // Phase 14 (external-downloader architecture): the PLAYER surface keeps
  // ONLY addon HLS streams. This PenguPlay-style payload (remux + HEVC +
  // WEB-DL MKVs) contains no HLS at all → the player offers ZERO streams.
  // Those direct files are NOT lost: the Mavero Downloader service ranks and
  // serves them (pinned behaviorally in stremio_downloader_phase14_test.ts).
  ok(resolution.result.streams.length === 0, 'F: the player offers ZERO direct-file streams (all isolated to the Mavero Downloader — Phase 14)');
  ok(resolution.result.streams.every((stream) => !stream.compat), 'F: isolation also means NO conversion references are minted for the player');

  // F (client half): the merged pool still LEADS with the best-ranked HLS
  // stream — the hub fixture (HLS + MP4) is filtered through the same
  // player-only-HLS reality before the merge, so auto-start is never a
  // conversion candidate (there are none anymore) and never a direct file.
  const hubResult = { key: 'addon-0', addonName: 'HdHub', ordering: 0, status: 'ok' as const, streams: hubPayload().streams.filter((stream) => stream.url.includes('.m3u8')).map((stream, index) => {
    const input = { url: stream.url, protocol: 'hls' as const, height: 1080 };
    return {
      source: { type: 'direct' as const, url: stream.url, providerId: 'p1', sourceId: `s${index}`, mediaType: 'movie' as const, qualities: [{ url: stream.url, label: '1080p' }], metadata: { protocol: 'hls' as const, providerName: 'HdHub' } },
      quality: { url: stream.url, label: '1080p', addonName: 'HdHub', usability: rankOf(withPlay(input), index) },
    };
  }) };
  const penguResult = { key: 'addon-1', addonName: 'Pipe', ordering: 2, status: 'ok' as const, streams: [] };
  const merged = mergeMaveroResults([hubResult, penguResult], { sourceId: 'mavero', sourceName: 'MAVERO Player', mediaType: 'movie' }, null);
  ok(merged?.qualities[0]?.url === 'https://hub-cdn.example/hls/s1/index.m3u8?token=signed', 'F: the merged pool LEADS with the direct HLS stream (auto-start is never a conversion)');
  ok(merged?.qualities.every((quality) => quality.url !== 'https://hub-cdn.example/file/movie.mp4'), 'F: the MP4 direct file from the same addon stays OUT of the player pool (Phase 14)');
}

// ---------------------------------------------------------------------------
// H — worker retry determinism
// ---------------------------------------------------------------------------

function writeFakeFfprobe(dir: string): string {
  const script = path.join(dir, 'fake-ffprobe.sh');
  writeFileSync(script, '#!/bin/sh\necho \'{"format":{"duration":"120"}}\'\n', { mode: 0o755 });
  chmodSync(script, 0o755);
  return script;
}

function workerConfig(fakeFfprobe: string) {
  return {
    ...loadConfig({ MAVERO_COMPAT_SESSION_SECRET: WORKER_SECRET, PUBLIC_BASE_URL: 'https://media-worker.example' }),
    secret: WORKER_SECRET,
    ffprobePath: fakeFfprobe,
    port: 0,
    jobTtlSeconds: 600,
    maxConcurrentJobs: 4,
    maxQueueDepth: 4,
    readyWaitMs: 50,
  };
}

const RETRY_URL = 'https://registry.npmjs.org/phase13-retry.mkv';

function retryToken() {
  return signCompatToken({ s: 'sess-13', a: 'addon-13', c: 'content-13', m: 'movie', u: RETRY_URL, k: 'remux', exp: Math.floor(Date.now() / 1000) + 600 }, WORKER_SECRET);
}

async function pollUntil(check: () => boolean, deadlineMs = 8000): Promise<boolean> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await delay(40);
  }
  return check();
}

async function sectionH(): Promise<void> {
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'phase13-worker-'));
  const registry = new JobRegistry(workerConfig(writeFakeFfprobe(scratch)));
  let attempt = 0;
  let releaseEncoder: (() => void) | null = null;
  registry.registerEncoder((_job, outDir) => {
    attempt += 1;
    if (attempt === 1) {
      // Attempt 1: fails BEFORE any playable segment (the production case:
      // a flaky source that produces nothing).
      return { promise: Promise.resolve(), kill: () => undefined };
    }
    // Attempt 2+: writes the first segment then waits on the gate.
    // ≥40 bytes: the registry treats a smaller playlist as header-only.
    writeFileSync(path.join(outDir, 'playlist.m3u8'), '#EXTM3U\n#EXT-X-VERSION:3\n#EXTINF:4.0,\nseg-00000.ts\n');
    writeFileSync(path.join(outDir, 'seg-00000.ts'), Buffer.alloc(2048, 1));
    return { promise: new Promise<void>((resolve) => { releaseEncoder = resolve; }), kill: () => undefined };
  });
  const token = retryToken();
  const first = await registry.submit(token, { v: 'cv1', s: 'sess-13', a: 'addon-13', c: 'content-13', m: 'movie', u: RETRY_URL, k: 'remux', exp: Math.floor(Date.now() / 1000) + 600 });
  assert.ok(first.outcome === 'queued');
  ok(await pollUntil(() => registry.snapshot(first.job.id)?.status === 'failed'), 'H: the first attempt fails BEFORE any playable segment');
  const failedId = first.job.id;

  // THE FIX: re-presenting the SAME still-valid token creates a FRESH
  // attempt instead of returning the dead failed job until TTL.
  const second = await registry.submit(token, { v: 'cv1', s: 'sess-13', a: 'addon-13', c: 'content-13', m: 'movie', u: RETRY_URL, k: 'remux', exp: Math.floor(Date.now() / 1000) + 600 });
  ok(second.outcome === 'queued', 'H: retrying a FAILED job with the same token queues a FRESH attempt (never the failed one)');
  assert.ok(second.outcome === 'queued');
  ok(second.job.id !== failedId, 'H: the retry is a NEW job identity (old attempt discarded)');
  const stale = await registry.submit(token, { v: 'cv1', s: 'sess-13', a: 'addon-13', c: 'content-13', m: 'movie', u: RETRY_URL, k: 'remux', exp: Math.floor(Date.now() / 1000) + 600 });
  ok(stale.outcome === 'existing' && stale.job.id === second.job.id, 'H: an in-flight job still dedupes (one live job per token)');

  if (releaseEncoder) releaseEncoder();
  ok(await pollUntil(() => registry.snapshot(second.job.id)?.status === 'ready'), 'H: the fresh attempt becomes READY (playlist + first segment)');
  registry.stopSweeper();
  rmSync(scratch, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// I — Pipe: cleartext http:// sources reach the FINAL list
// ---------------------------------------------------------------------------

function pipeHttpPayload() {
  return {
    streams: [
      { name: '1080p', title: 'Dhurandhar 1080p WEB-DL Dual Audio\nHindi + English\n4.40 GB\nPixelDrain', url: 'http://pixeldrain.example/api/file/ab12cd', behaviorHints: { videoSize: 4_724_904_960 } },
      { name: '720p', title: 'Dhurandhar 720p WEB-DL Dual Audio\nHindi + English\n1.90 GB\nPixelDrain', url: 'http://pixeldrain.example/api/file/cd34ef', behaviorHints: { videoSize: 2_040_109_056 } },
      { name: 'Torrent', title: 'magnet edition', infoHash: 'deadbeef' },
    ],
  };
}

async function sectionI(): Promise<void> {
  const client = {} as never;
  const session = await createAddonSession(client, { mediaType: 'movie', contentId: 'content-13' }, {
    secret: SECRET,
    sessionId: 'session-13',
    loadAddons: async () => [PIPE_ADDON],
    loadContent: loadContentOf(CONTENT),
  });
  ok(session.addons.length === 1 && session.addons[0]?.name === 'Pipe', 'I: the Pipe session token exists (multi-idProperty + tt-prefix manifest)');
  const requested: string[] = [];
  const resolution = await resolveAddonToken(client, { sessionId: 'session-13', token: addonTokenOf(session, 'Pipe') }, { contentId: 'content-13', mediaType: 'movie' }, {
    secret: SECRET,
    loadAddonById: addonById([PIPE_ADDON]),
    loadContent: loadContentOf(CONTENT),
    dnsResolver: (async (hostname: string) => [{ address: '93.184.216.34', family: 4 }]) as never,
    fetcher: (async (url: string | URL) => {
      requested.push(String(url));
      return new Response(JSON.stringify(pipeHttpPayload()), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch,
  });
  ok(requested[0] === 'https://pipe-addon.example/stream/movie/tt8633518.json', 'I: Pipe is called with the IMDb-namespaced endpoint (exactly what Stremio sends)');
  // Phase 14 (external-downloader architecture): Pipe's cleartext http
  // streams ARE retained — in the MAVERO DOWNLOADER surface, not the native
  // player. The player response stays an OK result with ZERO player streams
  // (direct files isolated; the magnet/infoHash entry rejected at normalize).
  // The downloader-side retention of BOTH http links is pinned behaviorally
  // in stremio_downloader_phase14_test.ts (section I-mirror).
  ok(resolution.result.status === 'ok' && resolution.result.streams.length === 0, 'I: Pipe resolves OK; its cleartext http DIRECT FILES are isolated from the native player (retained by the Mavero Downloader — Phase 14)');
  // Boundary precision: schemes/credentials/private hosts stay rejected.
  assert.throws(() => validateAddonStreamPlaybackUrl('ftp://x.example/a.mkv'), 'I: non-http schemes are still rejected');
  assert.throws(() => validateAddonStreamPlaybackUrl('https://user:pass@x.example/a.mkv'), 'I: credentialed URLs are still rejected');
  assert.throws(() => validateAddonStreamPlaybackUrl('http://192.168.1.10/a.mkv'), 'I: private hosts are still rejected');
  ok(validateAddonStreamPlaybackUrl('http://pixeldrain.example/api/file/ab12cd').startsWith('http://'), 'I: a public cleartext http URL passes the ADDON boundary');
}

// ---------------------------------------------------------------------------
// J/K — addon isolation + final-usable tab counts
// ---------------------------------------------------------------------------

function sectionJK(): void {
  const qualityOf = (url: string, addonName: string, usability?: PlayerQualityOption['usability']): PlayerQualityOption => ({ url, label: `${addonName} · 1080p`, addonName, ...(usability ? { usability } : {}) } as PlayerQualityOption);
  const sourceOf = (url: string, addonName: string) => ({ type: 'direct' as const, url, providerId: 'p', sourceId: url, mediaType: 'movie' as const, qualities: [{ url, label: '1080p' }], metadata: { protocol: 'mp4' as const, providerName: addonName } });

  // J: a failed addon result never removes the successful addons' streams.
  const failed = { key: 'addon-2', addonName: 'DesiFlix', ordering: 3, status: 'failed' as const, streams: [], errorCode: 'TIMEOUT' };
  const okHub = { key: 'addon-0', addonName: 'HdHub', ordering: 0, status: 'ok' as const, streams: [{ source: sourceOf('https://hub.example/a.m3u8', 'HdHub'), quality: qualityOf('https://hub.example/a.m3u8', 'HdHub') }] };
  const okPipe = { key: 'addon-1', addonName: 'Pipe', ordering: 2, status: 'ok' as const, streams: [{ source: sourceOf('http://pipe.example/1', 'Pipe'), quality: qualityOf('http://pipe.example/1', 'Pipe') }] };
  const merged = mergeMaveroResults([failed, okHub, okPipe], { sourceId: 'mavero', sourceName: 'MAVERO Player', mediaType: 'movie' }, null);
  ok(merged?.qualities.length === 2, 'J: the failed addon breaks NOTHING — both healthy addons contribute');

  // K: tab counts are the FINAL usable counts (server post-selection).
  const statuses = [
    { key: 'addon-0', addonName: 'HdHub', ordering: 0, status: 'ok' as const, streamCount: 2 },
    { key: 'addon-1', addonName: 'PenguPlay', ordering: 1, status: 'ok' as const, streamCount: 4 },
    { key: 'addon-2', addonName: 'Pipe', ordering: 2, status: 'ok' as const, streamCount: 2 },
    { key: 'addon-3', addonName: 'DesiFlix', ordering: 3, status: 'failed' as const, streamCount: 0 },
  ];
  const groups = groupMaveroStreams([qualityOf('https://h.example/1', 'HdHub'), qualityOf('https://h.example/2', 'HdHub'), qualityOf('http://p.example/1', 'PenguPlay')]);
  // The merge context supplies the REAL per-addon selected counts (K).
  const tabs = buildMaveroAddonTabs(
    statuses.map((status) => ({ ...status, streamCount: status.key === 'addon-0' ? groups.find((group) => group.addonName === 'HdHub')?.streams.length ?? 0 : status.streamCount })),
    groups,
  );
  ok(tabs.find((tab) => tab.name === 'HdHub')?.streamCount === 2, 'K: the HdHub tab count equals the SELECTED streams (2), not the raw 37');
  ok(tabs.find((tab) => tab.name === 'DesiFlix')?.status === 'failed', 'K: the failed addon keeps its tab (Failed — Retry), isolated from the counts');
  ok(defaultMaveroAddonTab(tabs, null) === 'HdHub', 'K: the first tab with usable streams is auto-selected');
}

// ---------------------------------------------------------------------------
// L — sandbox admin UX + runtime policy
// ---------------------------------------------------------------------------

function sectionL(): void {
  const providerUnrestricted = { sandbox_policy: 'unrestricted' };
  // Runtime hierarchy unchanged: effective unrestricted → NO attribute.
  const runtime = resolveSandboxRuntime(providerUnrestricted, { sandbox_policy: 'required' });
  ok(runtime.configuredSandboxPolicy === 'required' && runtime.providerSandboxPolicy === 'unrestricted' && runtime.effectiveSandboxPolicy === 'required', 'L: a source override WINS over the provider policy (effective = required) — hierarchy unchanged');
  ok(iframeSandboxAttribute('unrestricted') === undefined && iframeSandboxAttribute('required') !== undefined, 'L: the runtime contract is unchanged (unrestricted → no attribute, required → attribute)');
  // The source page now EXPOSES the override + effective policy for every source.
  const sourcesPage = read('src/routes/admin/sources/+page.svelte');
  ok(sourcesPage.includes('Sandbox policy (applies to embed playback)'), 'L: the source edit UI exposes the sandbox control for EVERY source');
  ok(sourcesPage.includes('Source override is active'), 'L: an active override is labeled as such (configured-vs-effective is visible)');
  ok(sourcesPage.includes('Configured:') && sourcesPage.includes('Effective:'), 'L: the page shows Configured AND Effective explicitly');
  ok(!sourcesPage.includes('(embed only)'), 'L: the misleading embed-only gating is gone');
  const providerPage = read('src/routes/admin/providers/+page.svelte');
  ok(providerPage.includes('outranks the provider policy at runtime'), 'L: the provider console still warns about outranking overrides');
}

// ---------------------------------------------------------------------------
// M — download state; N — HLS direct-first
// ---------------------------------------------------------------------------

function sectionMN(): void {
  // M: the ORIGINAL URL is preserved and the Opening… state exists.
  const attrs = downloadAttributesFor({ url: 'https://provider.example/download/123', filename: 'Movie.2026.mkv' } as PlayerQualityOption);
  ok(attrs?.href === 'https://provider.example/download/123', 'M: the download href is the ORIGINAL addon URL (unchanged)');
  const card = read('src/lib/components/player/MaveroStreamCard.svelte');
  ok(card.includes('openingDownload'), 'M: the card implements the download click state');
  ok(card.includes("openingDownload ? 'Opening…'"), 'M: the Opening… feedback exists');
  ok(card.includes('setTimeout(() => { openingDownload = false; }'), 'M: the Opening… state restores after a bounded timeout');
  ok(card.includes('if (openingDownload) return;'), 'M: duplicate rapid download clicks are suppressed');

  // N: a good HLS stream stays direct and leads the pool.
  ok(classifyStreamCompatibility({ protocol: 'hls' }).tier === 'DIRECT_PLAYABLE' && classifyStreamCompatibility({ protocol: 'hls' }).action === 'none', 'N: HLS classifies direct with NO conversion action');
  const hls = { url: 'https://x.example/live.m3u8', protocol: 'hls', height: 720, title: '720p' };
  const mp4 = { url: 'https://x.example/v.mp4', protocol: 'mp4', height: 720, title: '720p' };
  const hevc = { url: 'https://x.example/h.mkv', protocol: 'unknown', container: 'mkv', codec: 'hevc', height: 1080, title: '1080p HEVC 10-bit' };
  // Within an addon the TAB displays bucket-first (1080p → 720p, task §12);
  // the CROSS-addon auto-start pool is rank-ordered (play class dominates the
  // bucket), so a 720p direct HLS beats a 1080p conversion candidate.
  const ranked = selectAddonStreams([hevc, mp4, hls].map(withPlay));
  ok(ranked[0]?.stream.bucket !== undefined || ranked[0]?.usability.bucket === '1080p', 'N: the addon tab keeps bucket-grouped display order');
  ok(ranked.map((entry) => entry.usability.bucket).join('|') === '1080p|720p|720p', 'N: the tab order is 1080p first, then the 720p candidates');
  ok(rankOf({ ...hls, playClass: 'direct' as const }, 2).rank < rankOf({ ...hevc, playClass: 'transcode' as const }, 0).rank, 'N: rank orders direct above conversion across buckets (720p direct beats 1080p conversion globally)');
  const mergedN = mergeMaveroResults(
    [{ key: 'addon-0', addonName: 'Addon', ordering: 0, status: 'ok' as const, streams: [hevc, mp4, hls].map((input, index) => {
      const usability = rankOf(withPlay(input), index);
      return { source: { type: 'direct' as const, url: input.url, providerId: 'p', sourceId: input.url, mediaType: 'movie' as const, qualities: [{ url: input.url, label: 'q' }], metadata: { protocol: (input.protocol === 'hls' ? 'hls' : 'mp4') as 'hls' | 'mp4', providerName: 'Addon' } }, quality: { url: input.url, label: 'q', addonName: 'Addon', usability } };
    }) }],
    { sourceId: 'mavero', sourceName: 'MAVERO Player', mediaType: 'movie' },
    null,
  );
  ok(mergedN?.qualities[0]?.url === hls.url, 'N: the auto-start pool LEADS with the direct HLS (720p direct beats 1080p conversion)');
  ok(compatibilityBadgeText(classifyStreamCompatibility({ protocol: 'hls' }).tier) === null, 'N: a good HLS card shows NO badge');

  // Headline: "1080p • Dual Audio • HLS" from the usability verdict.
  const headlineStream = {
    url: 'https://x.example/live.m3u8', protocol: 'hls', height: 1080, title: 'Dual Audio',
    usability: { bucket: '1080p', audio: 'dual', release: 'streaming', play: 'direct', rank: 0 },
  } as PlayerQualityOption;
  ok(maveroStreamHeadline(headlineStream) === '1080p • Dual Audio • HLS', 'N: the card headline reads like a streaming player (1080p • Dual Audio • HLS)');
  ok(maveroStreamHeadline({ url: 'https://x.example/v.mp4' } as PlayerQualityOption) === null, 'N: without a verdict the headline falls back (no fabrication)');
  // Failed streams sink within an addon's sheet list (evidence-based demotion).
  const a = { url: 'https://x.example/a' } as PlayerQualityOption;
  const b = { url: 'https://x.example/b' } as PlayerQualityOption;
  const ordered = orderMaveroStreamsForSheet([a, b], [a.url]);
  ok(ordered[0]?.url === b.url && ordered[1]?.url === a.url, 'M: a stream that FAILED playback sinks to the bottom of the sheet (never poisoned — still listed)');
}

// ---------------------------------------------------------------------------
// runner
// ---------------------------------------------------------------------------

sectionA();
sectionB();
sectionC();
sectionDE();
sectionJK();
sectionL();
sectionMN();

await sectionFG();
await sectionH();
await sectionI();

console.log(`stremio_player_phase13_test: ${passed} checks passed (quality-first selection + audio preference + heavy filtering + worker fallback + retry + Pipe http + sandbox UX + download state)`);
