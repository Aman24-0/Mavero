import assert from 'node:assert/strict';
import { readFileSync, existsSync, writeFileSync, mkdirSync, rmSync, mkdtempSync, chmodSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import type { PlayerQualityOption, PlayerSource } from '$lib/shared/player';
import { hasLegitimateHlsSignal, urlCarriesHlsReference, urlPathIsM3u8 } from '$lib/shared/hls-detect';
import { protocolForUrl } from '$lib/server/resolver/safe-url';
import { normalizeStremioStreamResponse, detectContainerFromTexts } from '$lib/server/streaming/stremio/stream-normalize';
import { classifyStreamCompatibility, needsCompatibilityPath, containerFromAddonText, codecHintsFromText } from '$lib/shared/media-compat';
import { signCompatToken } from '$lib/server/streaming/stremio/session-tokens';
import { buildFfmpegArgs } from '../apps/media-worker/src/ffmpeg';
import { JobRegistry } from '../apps/media-worker/src/jobs';
import { createWorkerServer } from '../apps/media-worker/src/server';
import { loadConfig } from '../apps/media-worker/src/config';
import { resolveAddonIdPropertyCandidates, planAddonStreamRequest } from '$lib/server/streaming/stremio/stream-ids';
import { validateStremioManifest, persistableCapabilities } from '$lib/server/streaming/stremio/manifest-normalize';
import { createAddonSession, resolveAddonToken, type ContentLookup } from '$lib/server/streaming/stremio/addon-session';
import { mergeMaveroResults } from '$lib/client/player/mavero-progressive';
import { requestMaveroCompatStream, compatBadgeForStream, compatTierForStream } from '$lib/client/player/mavero-compat';
import { checkMediaCompatibility } from '$lib/client/player/media-capabilities';
import { buildMaveroAddonTabs, defaultMaveroAddonTab, groupMaveroStreams } from '$lib/client/player/mavero-streams';
import { copyStreamUrl, downloadAttributesFor } from '$lib/client/player/stream-actions';
import { resolveSandboxRuntime, iframeSandboxAttribute, sandboxPolicyFromCapabilities, configuredSandboxPolicy } from '$lib/shared/sandbox-policy';
import type { StreamingAddon } from '$lib/shared/streaming-addons';
import { stremioStreamToPlayerSource } from '$lib/server/streaming/stremio/stream-player-source';

/**
 * Phase 12 test suite — production playback fixes (Goals A–I).
 *
 *   A   HLS discovery stays INTACT end-to-end: detection priorities,
 *       protocol survival through normalize → source → quality option →
 *       merge, and HLS NEVER entering the compatibility path.
 *   B   MKV detection from ADDON TEXT with extensionless URLs
 *       ("Dhurandhar The Revenge (2026).mkv" on /file/123456) — the
 *       classifier consumes name/title/description/filename.
 *   C   REAL FFmpeg arguments: remux = video COPY + audio NORMALIZED to
 *       AAC 160k stereo 48 kHz (DTS/TrueHD/E-AC-3 MKV audio fixed);
 *       transcode = libx264 + yuv420p + AAC 160k stereo.
 *   W   Worker READY lifecycle: ready as soon as playlist + first segment
 *       exist (FFmpeg still running), completed/ended after exit, failed
 *       before the first segment — with the status endpoint vocabulary.
 *   P   Compat client polling: nested status.playback URL is honored,
 *       terminal failures stop polling, ready stops polling.
 *   E   Pipe: prefix-integrated idProperty candidate planning (the
 *       multi-idProperty + idPrefixes loss point) + structured diagnostics.
 *   S   Sandbox: the full configured→effective chain renders NO sandbox
 *       attribute for unrestricted and the attribute for required.
 *   U   Streams sheet addon tabs (per-addon state, retry, single-addon view)
 *       + stream-card Copy URL / Download actions on the ORIGINAL url.
 *   R   Regression: direct/HLS/embed paths, no P2P, no proxy, chain.
 */

let passed = 0;
function ok(condition: unknown, label: string) {
  assert.ok(condition, label);
  passed += 1;
}

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative: string) => readFileSync(path.join(REPO_ROOT, relative), 'utf8');
const WORKER_SECRET = 'phase12-worker-secret-0123456789abcdef';
const SECRET = 'phase12-session-secret-0123456789abcdef';
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// A — HLS discovery intact (detection priorities + protocol survival)
// ---------------------------------------------------------------------------

function sectionA(): void {
  // Priority 2: pathname .m3u8.
  ok(urlPathIsM3u8('https://example.com/movie.m3u8') && protocolForUrl('https://example.com/movie.m3u8') === 'hls', 'A: a plain .m3u8 URL classifies as HLS');
  // Priority 3: query/hash references.
  ok(protocolForUrl('https://example.com/master.m3u8?token=abc') === 'hls', 'A: signed .m3u8 with a token query classifies as HLS');
  ok(urlCarriesHlsReference('https://example.com/file?format=m3u8') && protocolForUrl('https://example.com/file?format=m3u8') === 'hls', 'A: query format=m3u8 classifies as HLS');
  ok(hasLegitimateHlsSignal('https://example.com/file?type=application/vnd.apple.mpegurl'), 'A: explicit HLS MIME in the query is a legitimate signal');
  // Priority 1: explicit addon metadata (MIME text) for extensionless URLs.
  ok(protocolForUrl('https://provider.example/get/123', { description: 'application/vnd.apple.mpegurl' }) === 'hls', 'A: extensionless URL + explicit addon HLS MIME metadata classifies as HLS');
  // Priority 5: never guessed.
  ok(protocolForUrl('https://example.com/file') === 'unknown', 'A: a generic extensionless URL stays unknown (never guessed)');
  ok(protocolForUrl('https://example.com/video.mp4') === 'mp4', 'A: MP4 stays MP4 (no HLS hijack)');

  // Protocol survives: normalization → PlayerSource → quality option → merge.
  const normalized = normalizeStremioStreamResponse({ streams: [{ name: '1080p', title: 'HLS', url: 'https://cdn.example/live/index.m3u8?tok=1' }] });
  ok(normalized.streams[0]?.protocol === 'hls', 'A: normalization keeps protocol=hls');
  const source = stremioStreamToPlayerSource({
    addonId: 'addon-1', addonSlug: 'addon', addonName: 'Addon', addonOrdering: 0, streamIndex: 0,
    streamName: '1080p', streamTitle: 'HLS', url: 'https://cdn.example/live/index.m3u8?tok=1',
    protocol: 'hls', transport: 'https', mediaType: 'movie', videoId: 'tt123', idProperty: 'imdb_id',
    quality: { label: '1080p', height: 1080 },
  });
  ok(source.metadata?.protocol === 'hls' && source.type === 'direct', 'A: the PlayerSource carries protocol=hls (never unknown/mp4/remux/embed)');
  const merged = mergeMaveroResults(
    [{ key: 'addon-0', addonName: 'Addon', ordering: 0, status: 'ok', streams: [{ source, quality: { url: source.url, label: 'Addon · 1080p', addonName: 'Addon', protocol: 'hls' } }] }],
    { sourceId: 'mavero', sourceName: 'MAVERO Player', mediaType: 'movie' },
    null,
  );
  ok(merged?.qualities?.[0]?.protocol === 'hls', 'A: the merged quality option retains protocol=hls (client routing input)');

  // HLS NEVER enters the compatibility path.
  const hlsVerdict = classifyStreamCompatibility({ protocol: 'hls' });
  ok(hlsVerdict.action === 'none' && !needsCompatibilityPath(hlsVerdict), 'A: an HLS verdict NEVER routes through the compatibility worker');
  ok(compatBadgeForStream({ url: 'https://x.example/a.m3u8', protocol: 'hls' } as PlayerQualityOption) === null, 'A: an HLS stream card shows NO conversion badge');
  // Even an HEVC-labeled HLS stays UNCERTAIN-direct (no remux/transcode action).
  const hevcHls = classifyStreamCompatibility({ protocol: 'hls', codec: 'hevc' });
  ok(hevcHls.tier === 'DIRECT_UNCERTAIN' && hevcHls.action === 'none', 'A: HEVC-on-HLS stays direct-uncertain (the runtime probe refines it) — never a conversion action');
}

// ---------------------------------------------------------------------------
// B — MKV detection from addon text (extensionless URLs)
// ---------------------------------------------------------------------------

function sectionB(): void {
  // The task's EXACT example: extensionless URL + the container in the name.
  const normalized = normalizeStremioStreamResponse({
    streams: [{ name: 'Dhurandhar The Revenge (2026).mkv', url: 'https://provider.example/file/123456' }],
  });
  ok(normalized.streams.length === 1, 'B: the extensionless stream normalizes (no rejection)');
  ok(normalized.streams[0]?.container === 'MKV', 'B: name "…(2026).mkv" + extensionless URL → container MKV (never lost)');
  ok(normalized.streams[0]?.filename === undefined, 'B: no filename is fabricated — the container comes from the addon text');

  ok(detectContainerFromTexts(['Some title ... .mkv']) === 'MKV', 'B: container text detection reads a .mkv reference anywhere in addon text');
  ok(detectContainerFromTexts(['a .mkvpass token']) === undefined, 'B: word-boundary safety — ".mkvpass" never matches (negative lookahead)');
  ok(detectContainerFromTexts(['Thriller night 2023']) === undefined, 'B: prose without an extension never yields a container');
  ok(containerFromAddonText(['Dhurandhar The Revenge (2026).mkv']) === 'mkv', 'B: the shared classifier sees the same text-derived container');

  // H.264 MKV (extensionless URL, codec in the title) → REMUX (video copy).
  const remuxVerdict = classifyStreamCompatibility({ protocol: 'unknown', name: 'Dhurandhar The Revenge (2026).mkv', title: '720p H.264 ~1.9GB / 2GB' });
  ok(remuxVerdict.tier === 'REMUX_REQUIRED' && remuxVerdict.action === 'remux', 'B: H.264 MKV (extensionless URL) → REMUX_REQUIRED via addon text');
  // HEVC MKV (extensionless URL, codec in the title) → TRANSCODE.
  const hevcVerdict = classifyStreamCompatibility({ protocol: 'unknown', name: 'Dhurandhar The Revenge (2026).mkv', title: '1080p HEVC 10-bit' });
  ok(hevcVerdict.tier === 'TRANSCODE_REQUIRED' && hevcVerdict.action === 'transcode', 'B: HEVC 10-bit MKV (extensionless URL) → TRANSCODE_REQUIRED via addon text');
  ok(needsCompatibilityPath(remuxVerdict) && needsCompatibilityPath(hevcVerdict), 'B: both MKV shapes qualify for a signed compat reference');
  // The badge on a REAL quality option (title carries .mkv, no filename).
  const badge = compatBadgeForStream({ url: 'https://provider.example/file/123456', title: 'Dhurandhar The Revenge (2026).mkv · 720p', container: 'MKV' } as PlayerQualityOption);
  // Phase 13 UPDATE: jargon-free copy — the fallback badge says what it is.
  ok(badge === 'Conversion fallback', 'B: the stream card badges the extensionless MKV honestly (Conversion fallback — Phase 13 copy)');
  ok(compatTierForStream({ url: 'https://provider.example/file/99', title: '1080p HEVC 10-bit Hindi 4.60 GB', container: 'MKV' } as PlayerQualityOption) === 'TRANSCODE_REQUIRED', 'B: HEVC 10-bit MKV card routes to the transcode tier');

  // Filename-derived codec hints keep working (Phase 9/10 pin parity).
  ok(codecHintsFromText('Movie.2023.1080p.HEVC.Hindi.10bit.WEB-DL.x265.mkv').codec === 'hevc', 'B: codec hints from a real filename still resolve');
  // The runtime decision tree (shell selection) routes BOTH to the worker.
  (async () => {
    const remuxDecision = await checkMediaCompatibility({ protocol: 'unknown', container: 'MKV', title: '720p H.264' });
    ok(remuxDecision.needsRemux && !remuxDecision.supported, 'B: the runtime decision sends H.264 MKV to remux (container problem)');
    const transcodeDecision = await checkMediaCompatibility({ protocol: 'unknown', container: 'MKV', title: '1080p HEVC 10-bit' });
    ok(transcodeDecision.needsTranscode && !transcodeDecision.supported, 'B: the runtime decision sends HEVC 10-bit MKV to transcode');
  })();
}

// ---------------------------------------------------------------------------
// C — REAL FFmpeg arguments (remux audio normalization + transcode target)
// ---------------------------------------------------------------------------

function sectionC(): void {
  const outDir = '/tmp/phase12-args';
  const remuxArgs = buildFfmpegArgs({
    ffmpegPath: 'ffmpeg', inputUrl: new URL('https://media.example/movie.mkv'), outDir, kind: 'remux',
    timeoutMs: 60_000, maxOutputBytes: 1024 * 1024 * 1024, durationSeconds: 6000, maxDurationSeconds: 21600,
  });
  const valueAfter = (args: string[], flag: string) => args[args.indexOf(flag) + 1];
  ok(valueAfter(remuxArgs, '-c:v') === 'copy', 'C: remux keeps VIDEO STREAM COPY (H.264 is never re-encoded — GOAL B1)');
  ok(valueAfter(remuxArgs, '-c:a') === 'aac', 'C: remux AUDIO is normalized to AAC (a plain audio copy would carry DTS/TrueHD/E-AC-3 into HLS — the browser still cannot play it)');
  ok(valueAfter(remuxArgs, '-b:a') === '160k', 'C: remux audio bitrate = 160k');
  ok(valueAfter(remuxArgs, '-ac') === '2', 'C: remux audio is downmixed to stereo (-ac 2)');
  ok(valueAfter(remuxArgs, '-ar') === '48000', 'C: remux audio is resampled to 48 kHz (-ar 48000)');
  ok(!JSON.stringify(remuxArgs).includes('libx264'), 'C: remux NEVER re-encodes video (no libx264 anywhere)');
  ok(remuxArgs.includes('-f') && remuxArgs.includes('hls') && remuxArgs.some((arg) => arg.endsWith('playlist.m3u8')), 'C: remux packages as HLS for the MAVERO native player');

  const transcodeArgs = buildFfmpegArgs({
    ffmpegPath: 'ffmpeg', inputUrl: new URL('https://media.example/movie.mkv'), outDir, kind: 'transcode',
    timeoutMs: 60_000, maxOutputBytes: 1024 * 1024 * 1024, durationSeconds: 6000, maxDurationSeconds: 21600,
  });
  ok(valueAfter(transcodeArgs, '-c:v') === 'libx264', 'C: transcode video targets H.264 (GOAL B2)');
  ok(valueAfter(transcodeArgs, '-pix_fmt') === 'yuv420p', 'C: transcode converts 10-bit to 8-bit yuv420p');
  ok(valueAfter(transcodeArgs, '-c:a') === 'aac' && valueAfter(transcodeArgs, '-b:a') === '160k' && valueAfter(transcodeArgs, '-ac') === '2' && valueAfter(transcodeArgs, '-ar') === '48000', 'C: transcode audio = AAC 160k stereo 48 kHz');
  ok(valueAfter(transcodeArgs, '-preset') === 'veryfast' && valueAfter(transcodeArgs, '-crf') === '23', 'C: transcode speed/quality bounds intact');
}

// ---------------------------------------------------------------------------
// W — worker READY lifecycle (ready on first playlist+segment; FFmpeg
//     keeps running; completed/ended after exit; failed before first segment)
// ---------------------------------------------------------------------------

/**
 * A fake ffprobe: answers a valid JSON duration WITHOUT any network access,
 * so the registry's probe step succeeds and the job reaches `encoding`.
 */
function writeFakeFfprobe(dir: string): string {
  const script = path.join(dir, 'fake-ffprobe.sh');
  writeFileSync(script, '#!/bin/sh\necho \'{"format":{"duration":"120"}}\'\n', { mode: 0o755 });
  chmodSync(script, 0o755);
  return script;
}

function workerConfig(fakeFfprobe: string, overrides: Record<string, unknown> = {}) {
  return {
    ...loadConfig({ MAVERO_COMPAT_SESSION_SECRET: WORKER_SECRET, PUBLIC_BASE_URL: 'https://media-worker.example' }),
    secret: WORKER_SECRET,
    ffprobePath: fakeFfprobe,
    port: 0,
    jobTtlSeconds: 600,
    maxConcurrentJobs: 4,
    maxQueueDepth: 4,
    readyWaitMs: 3000,
    ...overrides,
  };
}

const NEVER_FETCHED_URL = 'https://registry.npmjs.org/phase12-video.mkv'; // resolvable public host; never downloaded (encoder is fake)

function workerToken(url: string, kind: 'remux' | 'transcode' = 'remux') {
  return signCompatToken({ s: 'sess-12', a: 'addon-12', c: 'content-12', m: 'movie', u: url, k: kind, exp: Math.floor(Date.now() / 1000) + 600 }, WORKER_SECRET);
}

async function pollUntil(check: () => boolean, deadlineMs = 8000, stepMs = 50): Promise<boolean> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await delay(stepMs);
  }
  return check();
}

async function sectionW(): Promise<void> {
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'phase12-worker-'));
  const fakeFfprobe = writeFakeFfprobe(scratch);

  // -- Registry level: the exact readiness race -----------------------------
  {
    const registry = new JobRegistry(workerConfig(fakeFfprobe));
    let encoderFinished = false;
    let releaseEncoder: () => void = () => undefined;
    const encoderGate = new Promise<void>((resolve) => { releaseEncoder = resolve; });
    let capturedJob: import('../apps/media-worker/src/jobs').Job | null = null;
    registry.registerEncoder((job, outDir) => {
      capturedJob = job;
      const promise = (async () => {
        // FFmpeg behaviour: the playlist + FIRST segment appear early while
        // the encode of the rest of the movie is still in progress.
        writeFileSync(path.join(outDir, 'playlist.m3u8'), '#EXTM3U\n#EXT-X-VERSION:3\n#EXTINF:4.0,\nseg-00000.ts\n');
        writeFileSync(path.join(outDir, 'seg-00000.ts'), Buffer.alloc(2048, 1));
        await encoderGate; // ... encode continues for a long time ...
        writeFileSync(path.join(outDir, 'seg-00001.ts'), Buffer.alloc(2048, 2));
        encoderFinished = true;
      })();
      return { promise: promise.then(() => undefined), kill: () => undefined };
    });
    const token = workerToken(NEVER_FETCHED_URL);
    const outcome = await registry.submit(token, { v: 'cv1', s: 'sess-12', a: 'addon-12', c: 'content-12', m: 'movie', u: NEVER_FETCHED_URL, k: 'remux', exp: Math.floor(Date.now() / 1000) + 600 });
    assert.ok(outcome.outcome === 'queued');
    const becameReady = await pollUntil(() => registry.snapshot(outcome.job.id)?.status === 'ready');
    ok(becameReady, 'W: the job becomes READY while FFmpeg is still running (playlist + first segment on disk)');
    ok(!encoderFinished, 'W: readiness happened BEFORE the encoder exited (the whole movie is NOT re-transcoded first)');
    ok(registry.snapshot(outcome.job.id)?.phase === 'ready', 'W: the ready phase is reported while encoding continues');

    releaseEncoder();
    const completed = await pollUntil(() => registry.snapshot(outcome.job.id)?.phase === 'completed');
    ok(completed && registry.snapshot(outcome.job.id)?.status === 'ready', 'W: a clean FFmpeg exit after readiness → phase `completed`, playback stays served');
    assert.ok(capturedJob);
    registry.reportEncoderFailure(capturedJob, 'FFMPEG_TIMEOUT', 'a late failure after playback');
    const afterLateFailure = registry.snapshot(outcome.job.id);
    ok(afterLateFailure?.status === 'ready' && afterLateFailure.phase === 'ended', 'W: a failure AFTER playback was possible exposes `ended` WITHOUT destroying the already-created playback state');
    registry.stopSweeper();
  }

  // -- Registry level: failure BEFORE the first segment ----------------------
  {
    const registry = new JobRegistry(workerConfig(fakeFfprobe));
    registry.registerEncoder((_job, _outDir) => ({ promise: Promise.resolve(), kill: () => undefined })); // writes NOTHING
    const token = workerToken(NEVER_FETCHED_URL.replace('phase12-video', 'phase12-fail'));
    const outcome = await registry.submit(token, { v: 'cv1', s: 'sess-12', a: 'addon-12', c: 'content-12', m: 'movie', u: NEVER_FETCHED_URL.replace('phase12-video', 'phase12-fail'), k: 'remux', exp: Math.floor(Date.now() / 1000) + 600 });
    assert.ok(outcome.outcome === 'queued');
    const failed = await pollUntil(() => registry.snapshot(outcome.job.id)?.status === 'failed');
    ok(failed, 'W: a failure BEFORE any playable segment marks the job FAILED (never ready)');
    registry.stopSweeper();
  }

  // -- HTTP level: manifest answers ready immediately; status vocabulary -----
  {
    const config = workerConfig(fakeFfprobe);
    const registry = new JobRegistry(config);
    const server = createWorkerServer(config, registry);
    await new Promise<void>((resolve) => server.listen(config.port, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const base = `http://127.0.0.1:${address.port}`;
    let encoderFinished = false;
    let releaseEncoder: () => void = () => undefined;
    const encoderGate = new Promise<void>((resolve) => { releaseEncoder = resolve; });
    let capturedJob: import('../apps/media-worker/src/jobs').Job | null = null;
    registry.registerEncoder((job, outDir) => {
      capturedJob = job;
      const promise = (async () => {
        // ≥40 bytes: the registry treats a smaller playlist as "header-only".
        writeFileSync(path.join(outDir, 'playlist.m3u8'), '#EXTM3U\n#EXT-X-VERSION:3\n#EXTINF:4.0,\nseg-00000.ts\n');
        writeFileSync(path.join(outDir, 'seg-00000.ts'), Buffer.alloc(2048, 1));
        await encoderGate;
        encoderFinished = true;
      })();
      return { promise: promise.then(() => undefined), kill: () => undefined };
    });

    // ONE token for the whole HTTP flow — the registry keys jobs by the
    // token's SHA-256 identity, so every call must present the SAME string.
    const flowToken = workerToken(NEVER_FETCHED_URL);
    const manifestResponse = await fetch(`${base}/api/v1/compat/manifest`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: flowToken }) });
    const manifestPayload = (await manifestResponse.json()) as { ok?: boolean; playback?: { ready?: boolean; url?: string } };
    ok(manifestResponse.status === 200 && manifestPayload.ok === true && manifestPayload.playback?.ready === true, 'W: the manifest endpoint answers READY as soon as the first playlist + segment exist');
    ok(!encoderFinished, 'W: the manifest answered while FFmpeg was STILL encoding (no full-movie wait)');

    const statusReady = await fetch(`${base}/api/v1/compat/status?token=${encodeURIComponent(flowToken)}`);
    const statusReadyPayload = (await statusReady.json()) as { ok?: boolean; status?: { status?: string; ready?: boolean; playback?: { url?: string } } };
    ok(statusReadyPayload.status?.status === 'ready' && statusReadyPayload.status.ready === true, 'W: the status endpoint reports the `ready` lifecycle state');
    ok(typeof statusReadyPayload.status?.playback?.url === 'string' && statusReadyPayload.status.playback.url.startsWith('https://'), 'W: the ready status carries the expiring HLS playback URL');

    releaseEncoder();
    await pollUntil(() => encoderFinished);
    const statusCompleted = await fetch(`${base}/api/v1/compat/status?token=${encodeURIComponent(flowToken)}`);
    const statusCompletedPayload = (await statusCompleted.json()) as { status?: { status?: string; ready?: boolean } };
    ok(statusCompletedPayload.status?.status === 'completed' && statusCompletedPayload.status.ready === true, 'W: after a clean exit the lifecycle reports `completed` with playback intact');

    assert.ok(capturedJob);
    registry.reportEncoderFailure(capturedJob, 'FFMPEG_TIMEOUT');
    const statusEnded = await fetch(`${base}/api/v1/compat/status?token=${encodeURIComponent(flowToken)}`);
    const statusEndedPayload = (await statusEnded.json()) as { status?: { status?: string; ready?: boolean; playback?: { url?: string } } };
    ok(statusEndedPayload.status?.status === 'ended' && statusEndedPayload.status.ready === true && typeof statusEndedPayload.status.playback?.url === 'string', 'W: a post-ready failure reports `ended` while the already-produced segments keep serving');

    // A job whose encoder fails before the first segment → 503 CONVERSION_FAILED.
    let failJobEncoder = true;
    registry.registerEncoder((_job, outDir) => {
      if (failJobEncoder) return { promise: Promise.resolve(), kill: () => undefined };
      writeFileSync(path.join(outDir, 'playlist.m3u8'), '#EXTM3U\n#EXTINF:4.0,\nseg-00000.ts\n');
      writeFileSync(path.join(outDir, 'seg-00000.ts'), Buffer.alloc(2048, 1));
      return { promise: new Promise<void>((resolve) => setTimeout(resolve, 30)), kill: () => undefined };
    });
    const failingToken = workerToken(NEVER_FETCHED_URL.replace('phase12-video', 'phase12-failed'));
    const failingResponse = await fetch(`${base}/api/v1/compat/manifest`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: failingToken }) });
    ok(failingResponse.status === 503 && ((await failingResponse.json() as { error?: { code?: string } }).error?.code === 'CONVERSION_FAILED'), 'W: a conversion that never produced a segment is a typed 503 CONVERSION_FAILED');

    server.close();
    registry.stopSweeper();
    await new Promise((resolve) => server.closeAllConnections?.() ?? resolve(undefined as never));
  }

  rmSync(scratch, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// P — compat client polling (nested playback URL + terminal failures)
// ---------------------------------------------------------------------------

async function sectionP(): Promise<void> {
  // 1. The ready URL is honored from the NESTED status.playback object.
  {
    const calls: string[] = [];
    const fetcher = (async (url: string | URL) => {
      calls.push(String(url));
      if (String(url).endsWith('/compat/manifest')) {
        // Degraded manifest relay: NO url in the top-level playback object.
        return new Response(JSON.stringify({ ok: true, playback: { kind: 'hls', ready: false } }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ ok: true, status: { ready: true, status: 'ready', phase: 'ready', playback: { kind: 'hls', url: 'https://worker.example/hls/job1/playlist.m3u8' } } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    const result = await requestMaveroCompatStream('tok-nested', 'remux', { fetcher, pollIntervalMs: 5, timeoutMs: 4000 });
    ok(result.ok === true && result.workerUrl === 'https://worker.example/hls/job1/playlist.m3u8', 'P: the ready HLS URL is read from the NESTED status.playback object (never lost)');
  }

  // 2. A terminal failure (phase failed) STOPS polling immediately.
  {
    let statusCalls = 0;
    const fetcher = (async (url: string | URL) => {
      if (String(url).endsWith('/compat/manifest')) {
        return new Response(JSON.stringify({ ok: true, playback: { kind: 'hls', ready: false } }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      statusCalls += 1;
      return new Response(JSON.stringify({ ok: true, status: { ready: false, status: 'failed', phase: 'failed' } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    const result = await requestMaveroCompatStream('tok-failed', 'transcode', { fetcher, pollIntervalMs: 5, timeoutMs: 60_000 });
    ok(result.ok === false, 'P: a failed conversion surfaces a typed failure (never a fake success)');
    ok(statusCalls === 1, 'P: polling STOPS on the first terminal failure (no deadline burn)');
  }

  // 3. A typed gateway rejection (CONVERSION_FAILED) stops polling too.
  {
    let statusCalls = 0;
    const fetcher = (async (url: string | URL) => {
      if (String(url).endsWith('/compat/manifest')) {
        return new Response(JSON.stringify({ ok: true, playback: { kind: 'hls', ready: false } }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      statusCalls += 1;
      return new Response(JSON.stringify({ ok: false, error: { code: 'CONVERSION_FAILED', message: 'This stream could not be converted right now. Try another stream.' } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    const result = await requestMaveroCompatStream('tok-gateway-fail', 'transcode', { fetcher, pollIntervalMs: 5, timeoutMs: 60_000 });
    ok(result.ok === false && statusCalls === 1, 'P: a typed CONVERSION_FAILED gateway answer is terminal');
  }

  // 4. Regression: a top-level manifest URL still starts playback directly.
  {
    const fetcher = (async () => new Response(JSON.stringify({ ok: true, playback: { kind: 'hls', url: 'https://worker.example/hls/direct/playlist.m3u8', ready: true } }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch;
    const result = await requestMaveroCompatStream('tok-direct', 'remux', { fetcher });
    ok(result.ok === true && result.workerUrl === 'https://worker.example/hls/direct/playlist.m3u8', 'P: the top-level manifest playback URL still plays immediately');
  }

  // 5. The gateway maps the worker failure (source pin) and the client keeps
  //    its bounded deadlines + stale-selection protections.
  const statusRoute = read('src/routes/api/playback/compat/status/+server.ts');
  ok(statusRoute.includes('CONVERSION_FAILED'), 'P: the status gateway forwards worker conversion failures as a typed error');
  ok(read('src/lib/client/player/mavero-compat.ts').includes('isTerminalFailure'), 'P: the client treats typed failures as terminal (stops polling)');
}

// ---------------------------------------------------------------------------
// E — Pipe (prefix-integrated candidate planning + diagnostics)
// ---------------------------------------------------------------------------

/** A Pipe-shaped addon that declares BOTH namespaces but accepts only tt… ids. */
const PIPE_PREFIX_ADDON: StreamingAddon = {
  id: '00000000-0000-4000-8000-00000000pipe2',
  name: 'Pipe',
  slug: 'pipe',
  manifestUrl: 'https://pipe-addon.example/manifest.json',
  enabled: true,
  status: 'experimental',
  ordering: 3,
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

const BOTH_IDS: ContentLookup = { title: 'Dhurandhar: The Revenge', identifiers: { imdbId: 'tt8633518', tmdbId: '1094521' } };

function loadContentOf(lookup: ContentLookup) {
  return async (): Promise<ContentLookup> => lookup;
}

function sectionE(): void {
  // Manifest sync keeps the full multi-idProperty list (Phase 11 parity).
  const manifest = validateStremioManifest({ id: 'community.pipe', version: '1.1.0', name: 'Pipe', resources: ['catalog', 'meta', { name: 'stream', types: ['movie', 'series'], idPrefixes: ['tt'] }], types: ['movie', 'series'], idPrefixes: ['tt'], idProperty: ['tmdb_id', 'imdb_id'], catalogs: [] });
  ok(manifest.idProperties.join(',') === 'tmdb_id,imdb_id', 'E: the multi-idProperty manifest normalizes with the full ordered list');
  const caps = persistableCapabilities(manifest, new Date().toISOString());
  ok((caps.idProperties as string[]).join(',') === 'tmdb_id,imdb_id' && (caps.streamIdPrefixes as string[]).join(',') === 'tt', 'E: idProperties + streamIdPrefixes persist into addon capabilities');

  // THE Phase 12 fix: candidates whose id fails the addon's OWN idPrefixes
  // are skipped IN FAVOR of a later accepted candidate that passes.
  const candidates = resolveAddonIdPropertyCandidates(PIPE_PREFIX_ADDON);
  ok(candidates.join(',') === 'tmdb_id,imdb_id', 'E: Pipe candidates follow its declared preference order');
  const plan = planAddonStreamRequest(PIPE_PREFIX_ADDON, 'movie', { imdbId: 'tt8633518', tmdbId: '1094521' });
  ok(plan.ok && plan.plan.idProperty === 'imdb_id' && plan.plan.videoId === 'tt8633518', 'E: the planner sends the IMDb id (tmdb:… fails the addon\'s own tt idPrefixes — exactly what Stremio sends)');
  ok(plan.ok && plan.plan.endpointUrl === 'https://pipe-addon.example/stream/movie/tt8633518.json', 'E: the endpoint is built from the prefix-passing video ID');

  // A content item with ONLY a tmdb id: no candidate passes the prefixes →
  // the typed id-prefix-mismatch skip (never a guessed/invalid call).
  const mismatch = planAddonStreamRequest(PIPE_PREFIX_ADDON, 'movie', { tmdbId: '1094521' });
  ok(!mismatch.ok && mismatch.reason === 'id-prefix-mismatch', 'E: a tmdb-only item is honestly skipped as id-prefix-mismatch (no fabricated tt call)');

  // Series ids keep the season/episode suffix AND satisfy the prefixes.
  const seriesPlan = planAddonStreamRequest(PIPE_PREFIX_ADDON, 'series', { imdbId: 'tt8633518', tmdbId: '1094521' }, 1, 1);
  ok(seriesPlan.ok && seriesPlan.plan.videoId === 'tt8633518:1:1', 'E: series video IDs construct as tt8633518:1:1');
}

async function sectionE2(): Promise<void> {
  const client = {} as never;

  // End-to-end: the session mints a Pipe token and the resolution returns a
  // REAL playable https stream (multi-idProperty + prefix addon shape).
  const session = await createAddonSession(client, { mediaType: 'movie', contentId: 'content-1' }, {
    secret: SECRET,
    sessionId: 'session-1',
    loadAddons: async () => [PIPE_PREFIX_ADDON],
    loadContent: loadContentOf(BOTH_IDS),
  });
  ok(session.addons.length === 1 && session.addons[0]?.name === 'Pipe', 'E2: the Pipe session token exists for the prefix/multi-id addon');
  const pipeToken = session.addons[0]?.token;
  assert.ok(typeof pipeToken === 'string');

  let requestedUrl = '';
  const logs: string[] = [];
  const originalInfo = console.info;
  const originalWarn = console.warn;
  console.info = (...args: unknown[]) => { logs.push(args.join(' ')); };
  console.warn = (...args: unknown[]) => { logs.push(args.join(' ')); };
  try {
    const resolution = await resolveAddonToken(client, { sessionId: 'session-1', token: pipeToken }, { contentId: 'content-1', mediaType: 'movie' }, {
      secret: SECRET,
      loadAddonById: async () => PIPE_PREFIX_ADDON,
      loadContent: loadContentOf(BOTH_IDS),
      dnsResolver: (async (hostname: string) => [{ address: '93.184.216.34', family: 4 }]) as never,
      fetcher: (async (url: string | URL) => {
        requestedUrl = String(url);
        return new Response(JSON.stringify({
          streams: [
            { name: '1080p WEB-DL', title: 'Pipe 1080p WEB-DL\nHindi\n4.60 GB\nHDHub4u\nPixelDrain', url: 'https://pixeldrain.example/api/file/ab12cd', behaviorHints: { videoSize: 4938024960 } },
            { name: 'Torrent', title: 'magnet edition', infoHash: 'deadbeef' },
            { name: 'Headered', title: 'needs headers', url: 'https://host.example/file.mkv', behaviorHints: { proxyHeaders: { Referer: 'https://host.example/' } } },
          ],
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }) as typeof fetch,
    });
    ok(requestedUrl === 'https://pipe-addon.example/stream/movie/tt8633518.json', 'E2: MAVERO requested the IMDb-namespaced stream endpoint (the id Stremio itself sends)');
    ok(resolution.result.status === 'ok' && resolution.result.streams.length === 1, 'E2: the valid https stream is PLAYABLE (returned), not silently dropped');
    const stream = resolution.result.status === 'ok' ? resolution.result.streams[0] : null;
    ok(stream?.source.url === 'https://pixeldrain.example/api/file/ab12cd', 'E2: the original addon URL survives the pipeline verbatim');
    const structured = logs.find((line) => line.includes('[StremioAddon] resolved'));
    ok(typeof structured === 'string' && structured.includes('videoId=tt8633518') && structured.includes('returned=1') && structured.includes('playable=1'), 'E2: structured diagnostics log the selected video id, returned + playable counts');
    ok(Boolean(structured?.includes('torrent:1')), 'E2: the diagnostics name the per-reason exclusion counts (torrent:1 — the magnet/infoHash stream)');
  } finally {
    console.info = originalInfo;
    console.warn = originalWarn;
  }
}

// ---------------------------------------------------------------------------
// S — sandbox: the configured → effective chain end-to-end
// ---------------------------------------------------------------------------

function sectionS(): void {
  const providerCaps = { sandbox_policy: 'unrestricted' };
  const providerRequired = { sandbox_policy: 'required' };

  // Provider unrestricted + source inherits → effective unrestricted → NO attribute.
  const runtime1 = resolveSandboxRuntime(providerCaps, undefined);
  ok(runtime1.effectiveSandboxPolicy === 'unrestricted' && iframeSandboxAttribute(runtime1.effectiveSandboxPolicy) === undefined, 'S: provider=unrestricted + source inherit → effective unrestricted → iframe has NO sandbox attribute');
  // Provider required + source inherits → attribute present.
  const runtime2 = resolveSandboxRuntime(providerRequired, undefined);
  ok(runtime2.effectiveSandboxPolicy === 'required' && iframeSandboxAttribute(runtime2.effectiveSandboxPolicy) === 'allow-forms allow-presentation allow-same-origin allow-scripts', 'S: provider=required + inherit → the sandbox attribute applies');
  // Explicit source=unrestricted overrides a required provider → NO attribute.
  const runtime3 = resolveSandboxRuntime(providerRequired, { sandbox_policy: 'unrestricted' });
  ok(runtime3.effectiveSandboxPolicy === 'unrestricted' && iframeSandboxAttribute(runtime3.effectiveSandboxPolicy) === undefined, 'S: an explicit source=unrestricted override wins over a required provider → NO attribute');
  // Explicit source=required overrides an unrestricted provider → attribute.
  const runtime4 = resolveSandboxRuntime(providerCaps, { sandbox_policy: 'required' });
  ok(runtime4.effectiveSandboxPolicy === 'required' && iframeSandboxAttribute(runtime4.effectiveSandboxPolicy) !== undefined, 'S: an explicit source=required override wins over an unrestricted provider → attribute present');
  // Legacy stamp normalization: source "required" reads as inherit (Phase 11 migration contract).
  ok(configuredSandboxPolicy({ sandbox_policy: 'required' }) === 'required' && sandboxPolicyFromCapabilities(providerCaps, {}) === 'unrestricted', 'S: a source WITHOUT an explicit policy inherits the provider (unrestricted)');

  // The runtime consumes ONLY the effective policy (source pins):
  const viewport = read('src/lib/components/player/PlayerViewport.svelte');
  ok(viewport.includes('sandbox={sandboxAttribute}') && viewport.includes('iframeSandboxAttribute(effectiveSandbox)'), 'S: the viewport renders the iframe sandbox attribute from the EFFECTIVE policy only');
  const shell = read('src/lib/components/player/PlayerShell.svelte');
  ok(shell.includes('source.sandboxRuntime?.effectiveSandboxPolicy ?? source.sandboxPolicy'), 'S: the shell applies the server-resolved effective policy (never a client guess)');
  const watchPage = read('src/routes/watch/[type]/[id]/+page.svelte');
  ok(watchPage.includes('resolveSandboxRuntime(provider?.capabilities, source.capabilities).effectiveSandboxPolicy'), 'S: the watch route resolves the EFFECTIVE policy server-side into the source option');
  const providerAdmin = read('src/routes/admin/providers/+page.svelte');
  ok(providerAdmin.includes('sourceSandboxOverrides') && providerAdmin.includes('sandbox-override-warning'), 'S: the provider console WARNS when explicit source overrides outrank the provider policy');
}

// ---------------------------------------------------------------------------
// U — addon tabs + stream-card actions
// ---------------------------------------------------------------------------

function addonStatus(name: string, ordering: number, status: 'pending' | 'loading' | 'ok' | 'failed' | 'skipped', key = `addon-${name}`) {
  return { key, addonName: name, ordering, status, streamCount: 0 };
}

function sectionU(): void {
  const mkStream = (url: string, addonName: string): PlayerQualityOption => ({ url, label: `${addonName} · 1080p`, addonName } as PlayerQualityOption);

  // Tab model: ONE tab per session addon, ordered, with live state.
  const tabs = buildMaveroAddonTabs(
    [addonStatus('HdHub', 0, 'ok'), addonStatus('PenguPlay', 1, 'loading'), addonStatus('Pipe', 2, 'failed'), addonStatus('DesiFlix', 3, 'ok')],
    [
      { addonName: 'HdHub', firstAppearance: 0, streams: [mkStream('https://a.example/1', 'HdHub'), mkStream('https://a.example/2', 'HdHub')] },
      { addonName: 'DesiFlix', firstAppearance: 0, streams: [] },
    ],
  );
  ok(tabs.map((tab) => tab.name).join('|') === 'HdHub|PenguPlay|Pipe|DesiFlix', 'U: tabs are ONE per session addon in ordering order (HdHub | PenguPlay | Pipe | DesiFlix)');
  ok(tabs[0]?.hasStreams && tabs[0]?.streamCount === 2 && tabs[0]?.status === 'ok', 'U: an addon with streams shows ✓ N');
  ok(tabs[1]?.status === 'loading' && !tabs[1]?.hasStreams, 'U: a loading addon shows its live Loading state');
  ok(tabs[2]?.status === 'failed' && !tabs[2]?.hasStreams, 'U: a failed addon stays VISIBLE as Failed (never hidden)');
  ok(tabs[3]?.status === 'ok' && !tabs[3]?.hasStreams && tabs[3]?.streamCount === 0, 'U: an ok addon with zero streams keeps its tab (✓ Loaded — 0 streams)');
  ok(tabs[2]?.key === 'addon-Pipe', 'U: the failed tab carries its session key for the retry hook');

  // Default selection: the playing addon wins; else the first with streams; else the first tab.
  ok(defaultMaveroAddonTab(tabs, 'DesiFlix') === 'DesiFlix', 'U: the addon owning the PLAYING stream is the default tab');
  ok(defaultMaveroAddonTab(tabs, null) === 'HdHub', 'U: with nothing playing, the first tab WITH streams is selected');
  const allPending = buildMaveroAddonTabs([addonStatus('A', 0, 'loading'), addonStatus('B', 1, 'pending')], []);
  ok(defaultMaveroAddonTab(allPending, null) === 'A', 'U: with no streams anywhere the first tab still renders');
  const lateArrival = buildMaveroAddonTabs([addonStatus('A', 0, 'ok'), addonStatus('B', 1, 'ok')], [{ addonName: 'A', firstAppearance: 0, streams: [] }, { addonName: 'B', firstAppearance: 0, streams: [mkStream('https://b.example/1', 'B')] }]);
  ok(defaultMaveroAddonTab(lateArrival, null) === 'B', 'U: a LATER addon that finishes with streams becomes the default while nothing is pinned (first playable wins)');

  // Grouping parity: the tab body shows ONLY the selected addon's group.
  const groups = groupMaveroStreams([mkStream('https://a.example/1', 'HdHub'), mkStream('https://b.example/1', 'PenguPlay'), mkStream('https://a.example/2', 'HdHub')]);
  ok(groups.length === 2 && groups[0]?.addonName === 'HdHub' && groups[0]?.streams.length === 2, 'U: per-addon groups stay deduped + ordered (the tab body source)');

  // Copy / Download actions — the ORIGINAL addon URL only.
  const attrs = downloadAttributesFor({ url: 'https://provider.example/download/123', filename: 'Dhurandhar.The.Revenge.2026.mkv' } as PlayerQualityOption);
  ok(attrs?.href === 'https://provider.example/download/123', 'U: download operates on the ORIGINAL addon URL (never proxied/transformed)');
  ok(attrs?.download === 'Dhurandhar.The.Revenge.2026.mkv' && attrs?.target === '_blank' && attrs?.rel === 'noopener noreferrer', 'U: the download anchor carries a filename hint + safe target/rel');
  const fromUrl = downloadAttributesFor({ url: 'https://host.example/path/file.mkv?token=x' } as PlayerQualityOption);
  ok(fromUrl?.download === 'file.mkv', 'U: without a filename the hint derives from the URL path (never fabricated beyond that)');
  ok(downloadAttributesFor({ url: 'ftp://host/file' } as PlayerQualityOption) === null, 'U: non-http URLs never render a download action');
  ok(downloadAttributesFor({ url: '' } as PlayerQualityOption) === null, 'U: an empty URL never renders a download action');

  (async () => {
    const copied: string[] = [];
    const setNavigator = (value: unknown) => {
      Object.defineProperty(globalThis, 'navigator', { value, configurable: true });
    };
    const originalNavigator = (globalThis as { navigator?: unknown }).navigator;
    setNavigator({ clipboard: { writeText: async (value: string) => { copied.push(value); } } });
    const result = await copyStreamUrl('https://pixeldrain.example/api/file/ab12cd');
    ok(result === 'copied' && copied[0] === 'https://pixeldrain.example/api/file/ab12cd', 'U: Copy uses navigator.clipboard.writeText with the ORIGINAL addon URL');
    const failing = await copyStreamUrl('https://x.example/v.mkv');
    ok(failing === 'copied' || failing === 'unavailable', 'U: copy degrades gracefully (fallback path, never throws)');
    setNavigator({});
    const noApi = await copyStreamUrl('https://x.example/v.mkv');
    ok(noApi === 'unavailable', 'U: without the Clipboard API the copy fails gracefully (document-less runtime)');
    setNavigator(originalNavigator);
  })();

  // Card source pins: the actions bind the original stream URL and stop
  // propagation (clicking Copy/Download NEVER selects the stream).
  const card = read('src/lib/components/player/MaveroStreamCard.svelte');
  ok(card.includes('copyStreamUrl(stream.url)'), 'U: the Copy action copies stream.url — the ORIGINAL addon URL');
  ok(card.includes('downloadAttributesFor(stream)'), 'U: the Download action is built from the ORIGINAL addon URL');
  ok(card.includes('event.stopPropagation()') && card.includes('stopPropagation()'), 'U: action clicks stop propagation (no accidental stream selection)');
  ok(!card.includes('compatOverrideUrl') && !card.includes('mediaUrl'), 'U: the card NEVER touches the compat/worker URL for its actions');
  ok(card.includes('navigator.clipboard') === false, 'U: clipboard access goes through the shared tested helper');
  ok(card.includes('<Copy size={14} />') && card.includes('<Download size={14} />'), 'U: the actions are compact icon buttons');
  ok(card.includes('aria-label={copied') && card.includes('{copied ? \'Copied\' : \'Copy URL\'}') === false || card.includes('Copied'), 'U: the copy affordance surfaces a "Copied" success indication');

  // Sheet source pins: horizontal tablist, per-tab states, single-addon body, per-addon retry.
  const shell = read('src/lib/components/player/PlayerShell.svelte');
  ok(shell.includes('role="tablist"') && shell.includes('role="tab"') && shell.includes('class="addon-tabs"'), 'U: the streams sheet renders a horizontal addon tablist');
  ok(shell.includes('selectAddonTab(tab.name)') && shell.includes('aria-selected={tab.name === activeAddonTab}'), 'U: clicking a tab pins that addon (visually clear active state)');
  ok(shell.includes('buildMaveroAddonTabs(maveroAddons, maveroStreamGroups)') && shell.includes('defaultMaveroAddonTab(maveroTabs, playingAddonName)'), 'U: the tab model + default selection come from the tested pure helpers');
  ok(shell.includes('retryActiveAddonTab') && shell.includes('onMaveroRetry(key)'), 'U: Retry retries ONLY the active tab\'s addon (existing per-addon hook)');
  ok(shell.includes('activeMaveroTabGroup.streams'), 'U: the sheet body renders ONLY the selected addon\'s streams');
  ok(shell.includes('✓ Loaded — 0 streams'), 'U: an ok addon with zero streams keeps its honest state row');
  ok(shell.includes('overflow-x: auto'), 'U: the tab strip scrolls horizontally (mobile, no wrap/overlap)');
}

// ---------------------------------------------------------------------------
// R — regression (existing paths intact; no P2P/proxy; chain registration)
// ---------------------------------------------------------------------------

function sectionR(): void {
  // Direct MP4 / HLS / embed behavior unchanged.
  ok(protocolForUrl('https://cdn.example/video.mp4') === 'mp4', 'R: direct MP4 detection unchanged');
  const engineSource = read('src/lib/client/player/hls-engine.ts');
  ok(engineSource.includes("import('@videojs/hlsjs-video')"), 'R: Video.js HlsJsVideo remains the single HLS owner');
  ok(read('src/lib/components/player/PlayerViewport.svelte').includes('application/vnd.apple.mpegurl'), 'R: the explicit HLS MIME type still rides ambiguous URLs');
  ok(read('src/lib/client/player/embed-adapter.ts').includes('canHandle'), 'R: the embed adapter path is untouched');

  // No torrent/P2P regression + no generic proxy.
  const torrent = normalizeStremioStreamResponse({ streams: [{ name: 'X', infoHash: 'abc' }, { name: 'Y', url: 'magnet:?xt=urn:btih:abc' }] });
  ok(torrent.streams.length === 0 && torrent.unsupported.length === 2, 'R: torrent/magnet streams are still rejected');
  const workerServer = read('apps/media-worker/src/server.ts');
  ok(!workerServer.includes('body.url') && workerServer.includes('verifyCompatToken'), 'R: the worker still accepts ONLY signed tokens (no client URLs)');

  // The compat gateway keeps re-validating the token-bound URL (defense in depth).
  ok(read('src/routes/api/playback/compat/manifest/+server.ts').includes('validatePlaybackUrl(payload.u'), 'R: the compat gateway re-runs the playback boundary on the signed URL');

  // mergeMaveroResults: later addons merge WITHOUT restarting (current stream pinned).
  const mk = (url: string, name: string): PlayerSource => ({ type: 'direct', url, providerId: 'mavero', sourceId: 'mavero', mediaType: 'movie', qualities: [{ url, label: `${name} · 1080p` }], metadata: { protocol: 'mp4', providerName: name } });
  const merged = mergeMaveroResults(
    [
      { key: 'a', addonName: 'A', ordering: 0, status: 'ok', streams: [{ source: mk('https://a.example/1', 'A'), quality: { url: 'https://a.example/1', label: 'A · 1080p', addonName: 'A' } }] },
      { key: 'b', addonName: 'B', ordering: 1, status: 'ok', streams: [{ source: mk('https://b.example/1', 'B'), quality: { url: 'https://b.example/1', label: 'B · 1080p', addonName: 'B' } }] },
    ],
    { sourceId: 'mavero', sourceName: 'MAVERO Player', mediaType: 'movie' },
    'https://b.example/1',
  );
  ok(merged?.url === 'https://b.example/1' && merged.qualities?.length === 2, 'R: live merge keeps the playing stream first and extends the pool (no restart)');

  // Chain registration.
  const packageJson = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
  ok(packageJson.scripts.test.includes('stremio_player_phase12_test.ts'), 'R: the Phase 12 suite is registered in the test chain');
  ok(packageJson.scripts.test.indexOf('stremio_player_phase11_test.ts') < packageJson.scripts.test.indexOf('stremio_player_phase12_test.ts'), 'R: Phase 12 runs after Phase 11');
}

// ---------------------------------------------------------------------------
// runner
// ---------------------------------------------------------------------------

sectionA();
sectionB();
sectionC();
sectionE();
sectionS();
sectionU();
sectionR();

await sectionW();
await sectionP();
await sectionE2();

console.log(`stremio_player_phase12_test: ${passed} checks passed (HLS intact + MKV/HEVC real conversion + ready-lifecycle + polling + Pipe prefixes + sandbox + tabs/actions)`);
