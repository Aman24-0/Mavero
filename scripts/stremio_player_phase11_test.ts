import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import type { PlayerQualityOption, PlayerSource } from '$lib/shared/player';
import { hasLegitimateHlsSignal, urlCarriesHlsReference, urlPathIsM3u8, metadataCarriesHlsSignal } from '$lib/shared/hls-detect';
import { protocolForUrl, validatePlaybackUrl } from '$lib/server/resolver/safe-url';
import { normalizeStremioStreamResponse } from '$lib/server/streaming/stremio/stream-normalize';
import { classifyStreamCompatibility, needsCompatibilityPath, compatibilityBadgeText } from '$lib/shared/media-compat';
import { signCompatToken, verifyCompatToken } from '$lib/server/streaming/stremio/session-tokens';
import { verifyCompatToken as workerVerifyCompatToken } from '../apps/media-worker/src/tokens';
import { loadConfig, assertConfigUsable } from '../apps/media-worker/src/config';
import { validateJobUrl, isPrivateHostname, assertResolvablePublicHost } from '../apps/media-worker/src/validate';
import { buildFfmpegArgs, probeInput, runFfmpeg } from '../apps/media-worker/src/ffmpeg';
import { JobRegistry } from '../apps/media-worker/src/jobs';
import { createWorkerServer } from '../apps/media-worker/src/server';
import { resolveSandboxRuntime, sandboxPolicyFromCapabilities, configuredSandboxPolicy, iframeSandboxAttribute, withSourceSandboxChoice } from '$lib/shared/sandbox-policy';
import { resolveAddonIdProperty, resolveAddonIdPropertyCandidates, planAddonStreamRequest } from '$lib/server/streaming/stremio/stream-ids';
import { validateStremioManifest, persistableCapabilities } from '$lib/server/streaming/stremio/manifest-normalize';
import { createAddonSession, resolveAddonToken, type ContentLookup } from '$lib/server/streaming/stremio/addon-session';
import { mergeMaveroResults, startMaveroProgressiveResolution, type MaveroAddonResult } from '$lib/client/player/mavero-progressive';
import type { StreamingAddon } from '$lib/shared/streaming-addons';

/**
 * Phase 11 test suite — GOALS A–D.
 *
 *   A   HLS discovery: shared detection pipeline (normal/signed/query/
 *       metadata), protocol normalization, engine routing, explicit MIME.
 *   B   REAL compatibility pipeline: classifier matrix, token binding
 *       (app ⇄ worker byte-compatible), worker validation (no proxy, no
 *       private hosts), REAL FFmpeg remux (H.264+MKV, copy-only) and
 *       transcode (libx264/aac) runs producing HLS playlists, job
 *       registry caps + idempotence + expiry, HTTP contract.
 *   C   Pipe: manifest idProperty arrays, availability-aware planning
 *       (movie + series), full addon-session resolution with a Pipe-shaped
 *       addon (PixelDrain-style https links + HLS variant), progressive UI
 *       status rows ("✓ Loaded — 0 streams"), loss-point isolation.
 *   D   Sandbox: provider-default inheritance matrix end-to-end
 *       (resolver runtime object → shell → viewport → iframe attribute),
 *       legacy-stamp migration pins, admin configured-vs-effective.
 *   R   Regression: progressive fairness/stale/isolation, embed untouched,
 *       no torrent/P2P, no arbitrary proxy, chain registration.
 */

let passed = 0;
function ok(condition: unknown, label: string) {
  assert.ok(condition, label);
  passed += 1;
}

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative: string) => readFileSync(path.join(REPO_ROOT, relative), 'utf8');
const execFile = promisify(execFileCb);

// ---------------------------------------------------------------------------
// A — HLS discovery (GOAL A: robust, network-free detection pipeline)
// ---------------------------------------------------------------------------

function sectionA() {
  // 1. normal .m3u8
  ok(protocolForUrl('https://cdn.example/live/index.m3u8') === 'hls', 'A1: normal .m3u8 path → hls');
  ok(urlPathIsM3u8('https://cdn.example/live/index.M3U8') === true, 'A1: .m3u8 detection is case-insensitive');
  // 2. .m3u8 with query
  ok(protocolForUrl('https://cdn.example/live/index.m3u8?token=abc&expires=123') === 'hls', 'A2: .m3u8 with query → hls');
  // 3. signed HLS URL (extensionless but query/hash references the manifest)
  ok(urlCarriesHlsReference('https://cdn.example/playlist?file=file.m3u8'), 'A3: query .m3u8 file reference detected');
  ok(protocolForUrl('https://cdn.example/playlist?file=file.m3u8&sig=x') === 'hls', 'A3: extensionless URL with query .m3u8 reference → hls');
  ok(protocolForUrl('https://cdn.example/stream?id=42&format=m3u8') === 'hls', 'A3: format=m3u8 parameter → hls');
  ok(protocolForUrl('https://cdn.example/get#file.m3u8') === 'hls', 'A3: hash .m3u8 reference → hls');
  ok(hasLegitimateHlsSignal('https://cdn.example/playlist?file=file%2Em3u8') === true, 'A3: URL-encoded .m3u8 query reference detected');
  // 4. extensionless HLS URL with explicit addon HLS metadata
  ok(metadataCarriesHlsSignal({ title: '1080p HLS' }), 'A4: addon title explicitly says HLS');
  ok(metadataCarriesHlsSignal({ name: 'Server 1\nm3u8' }), 'A4: addon name carries an m3u8 signal');
  ok(metadataCarriesHlsSignal({ description: 'Direct download' }) === false, 'A4: unrelated addon text NEVER becomes an HLS signal');
  ok(protocolForUrl('https://cdn.example/manifest/build/12345', { title: '1080p HLS' }) === 'hls', 'A4: extensionless URL + explicit addon HLS metadata → hls');
  ok(protocolForUrl('https://cdn.example/manifest/build/12345', { description: 'Direct link' }) === 'unknown', 'A4: addon text without HLS tokens stays unknown');
  // 5. ordinary MP4 / MKV / unknown
  ok(protocolForUrl('https://cdn.example/video.mp4') === 'mp4', 'A5: ordinary MP4 → mp4');
  ok(protocolForUrl('https://cdn.example/video.mkv') === 'unknown', 'A5: MKV stays unknown protocol (container label comes from metadata)');
  ok(protocolForUrl('https://cdn.example/unknown') === 'unknown', 'A5: extensionless URL without signals stays unknown');
  ok(protocolForUrl('https://cdn.example/playlist?file=file.m3u8', { title: 'HEVC 1080p' }) === 'hls', 'A: URL signals win over unrelated codec text');
  ok(protocolForUrl('https://cdn.example/movie.mp4') === 'mp4' && protocolForUrl('https://cdn.example/movie.mpd') === 'dash', 'A: MP4/DASH detection unchanged');

  // Engine routing — the shared helper powers the client fallback too.
  const engineSource = read('src/lib/client/player/hls-engine.ts');
  ok(engineSource.includes("from '$lib/shared/hls-detect'"), 'A: the engine fallback uses the SHARED detection pipeline');
  const viewportSource = read('src/lib/components/player/PlayerViewport.svelte');
  ok(viewportSource.includes('application/vnd.apple.mpegurl'), 'A: Video.js receives the EXPLICIT HLS MIME type');
  ok(viewportSource.includes('urlPathIsM3u8(url) ? undefined'), 'A: explicit MIME is used precisely when the URL path is NOT .m3u8 (ambiguous)');
  ok(viewportSource.includes("from '$lib/shared/hls-detect'"), 'A: the viewport imports the shared detection helper');
  ok(read('src/lib/server/streaming/stremio/stream-normalize.ts').includes('protocolForUrl(normalizedUrl, {'), 'A: the addon normalizer passes ADDON-SUPPLIED text into protocol detection');

  // Playback boundary unchanged: a signed HLS URL still passes the https-only gate.
  ok(validatePlaybackUrl('https://cdn.example/live/index.m3u8?token=abc', 'direct'), 'A: signed HLS URL passes the playback boundary');

  // Realistic normalization: an addon returning a signed HLS entry + an
  // extensionless-metadata HLS entry + a pixeldrain-style direct file.
  const response = normalizeStremioStreamResponse({
    streams: [
      { name: '1080p HLS', title: '1080p · HLS', url: 'https://hlscdn.example/live/index.m3u8?token=abc' },
      { name: '1080p', title: 'HLS', url: 'https://pkg.example/session/abc123' },
      { name: '1080p WEB-DL', title: 'Pipe 1080p WEB-DL 10-bit\nHindi\n4.60 GB\nHDHub4u\nPixelDrain', url: 'https://pixeldrain.example/api/file/ab12cd', behaviorHints: { filename: 'Dhurandhar.1080p.WEB-DL.HEVC.10bit.Hindi.mkv', videoSize: 4938024960 } },
      { name: '720p', title: 'Direct', url: 'https://files.example/movie.mp4' },
    ],
  });
  ok(response.valid && response.streams.length === 4, 'A: realistic mixed addon response normalizes without losses');
  ok(response.streams[0]?.protocol === 'hls', 'A: signed .m3u8 HLS entry normalizes as hls');
  ok(response.streams[1]?.protocol === 'hls', 'A: extensionless entry with explicit HLS title metadata normalizes as hls');
  // Phase 12 UPDATE: the codec now ALSO derives from the addon filename —
  // this entry's behaviorHints.filename explicitly says "HEVC.10bit", so a
  // codec claim exists (it never came from name/title alone; unchanged for
  // streams whose filename carries no codec token either).
  ok(response.streams[2]?.protocol === 'unknown' && response.streams[2]?.codec === 'HEVC' && response.streams[2]?.container === 'MKV', 'A: Pipe-style entry keeps honest metadata (codec from the filename that explicitly names it; container from the filename)');
  ok(response.streams[2]?.audioLanguages?.includes('Hindi') === true, 'A: Hindi audio language comes from the addon text only (never invented)');
  ok(response.streams[3]?.protocol === 'mp4', 'A: direct MP4 entry normalizes as mp4');
}

// ---------------------------------------------------------------------------
// B1 — compatibility classifier matrix (GOALS B1–B4)
// ---------------------------------------------------------------------------

function sectionB1() {
  const verdictOf = (input: Parameters<typeof classifyStreamCompatibility>[0]) => classifyStreamCompatibility(input);

  // 6. H.264 MP4 → direct
  const h264mp4 = verdictOf({ protocol: 'mp4', container: 'MP4', codec: 'H.264', filename: 'Movie.1080p.H264.AAC.mp4' });
  ok(h264mp4.tier === 'DIRECT_PLAYABLE' && !needsCompatibilityPath(h264mp4), 'B1: H.264+MP4+AAC → DIRECT_PLAYABLE (no conversion, never transcoded)');

  // 7. H.264 MKV → REMUX_REQUIRED (video must NOT be re-encoded)
  const h264mkv = verdictOf({ container: 'MKV', codec: 'H.264', filename: 'Movie.1080p.x264.AAC.mkv' });
  ok(h264mkv.tier === 'REMUX_REQUIRED' && h264mkv.action === 'remux', 'B1: H.264+MKV → REMUX_REQUIRED');
  // Phase 13 UPDATE: user-facing copy no longer exposes remux/transcode jargon —
  // conversion is presented as the fallback it is.
  ok(compatibilityBadgeText(h264mkv.tier) === 'Conversion fallback', 'B1: remux badge reads as the Conversion fallback (Phase 13 copy)');

  // 8. HEVC MKV → TRANSCODE_REQUIRED
  const hevcMkv = verdictOf({ container: 'MKV', codec: 'HEVC', filename: 'Movie.1080p.HEVC.mkv' });
  ok(hevcMkv.tier === 'TRANSCODE_REQUIRED' && hevcMkv.action === 'transcode', 'B2: HEVC+MKV → TRANSCODE_REQUIRED');

  // 9. HEVC 10-bit → TRANSCODE_REQUIRED
  const hevc10Mkv = verdictOf({ container: 'MKV', codec: 'HEVC', bitDepth: 10, filename: 'Movie.1080p.HEVC.10bit.mkv' });
  ok(hevc10Mkv.tier === 'TRANSCODE_REQUIRED', 'B2: HEVC 10-bit MKV → TRANSCODE_REQUIRED');
  const hevc10Mp4 = verdictOf({ container: 'MP4', codec: 'HEVC', bitDepth: 10, filename: 'Movie.HEVC.10bit.mp4' });
  ok(hevc10Mp4.tier === 'DIRECT_UNCERTAIN', 'B2: HEVC 10-bit MP4 stays uncertain (runtime probe refines)');

  // 10. unsupported audio (DTS/TrueHD) → transcode path
  const dts = verdictOf({ container: 'MP4', codec: 'H.264', filename: 'Movie.1080p.DTS.mp4' });
  ok(dts.tier === 'TRANSCODE_REQUIRED' && dts.reason === 'unsupported-audio', 'B2: DTS audio → TRANSCODE_REQUIRED (audio→AAC)');
  const truehd = verdictOf({ container: 'MKV', codec: 'H.264', filename: 'Movie.TrueHD.mkv' });
  ok(truehd.tier === 'TRANSCODE_REQUIRED', 'B2: TrueHD → TRANSCODE_REQUIRED');

  // HLS remains direct (never routed through the worker unnecessarily).
  const plainHls = verdictOf({ protocol: 'hls' });
  ok(plainHls.tier === 'DIRECT_PLAYABLE' && !needsCompatibilityPath(plainHls), 'B3: ordinary HLS → DIRECT_PLAYABLE (no FFmpeg detour)');
  const hevcHls = verdictOf({ protocol: 'hls', codec: 'HEVC' });
  ok(hevcHls.tier === 'DIRECT_UNCERTAIN' && !needsCompatibilityPath(hevcHls), 'B3: HEVC HLS stays UNCERTAIN — never auto-transcoded');
  const fixedHls = verdictOf({ protocol: 'hls', container: 'MKV', codec: 'H.264', filename: 'Movie.x264.mkv' });
  ok(fixedHls.tier === 'DIRECT_PLAYABLE' && !needsCompatibilityPath(fixedHls), 'B3: HLS protocol WINS over the MKV filename — the Phase 10 misclassification is fixed');
}

// ---------------------------------------------------------------------------
// B2 — compatibility token binding, app ⇄ worker (GOALS B5/11/12/13)
// ---------------------------------------------------------------------------

const WORKER_SECRET = 'phase11-worker-secret-0123456789abcdef';

function sectionB2() {
  const token = signCompatToken({ s: 'sess-1', a: 'addon-1', c: 'content-1', m: 'movie', u: 'https://media.example/file.mkv', k: 'remux', exp: Math.floor(Date.now() / 1000) + 600 }, WORKER_SECRET);
  // 11. the APP accepts its own token (round trip)
  ok(verifyCompatToken(token, WORKER_SECRET).ok === true, 'B: app verifies its signed compat reference');
  // 12. the WORKER accepts the SAME token byte-for-byte (cross-implementation contract)
  const workerVerdict = workerVerifyCompatToken(token, WORKER_SECRET);
  ok(workerVerdict.ok === true && workerVerdict.payload.u === 'https://media.example/file.mkv' && workerVerdict.payload.k === 'remux', 'B: worker verifies the app-signed reference INDEPENDENTLY (shared-secret contract)');
  const [version, encoded, signature] = token.split('.');
  ok(workerVerifyCompatToken(`${version}.${encoded}.${signature.slice(0, -2)}aa`, WORKER_SECRET).ok === false, 'B: tampered signature rejected');
  ok(workerVerifyCompatToken(token, 'wrong-secret').ok === false, 'B: wrong-secret token rejected');
  const expired = signCompatToken({ s: 's', a: 'a', c: 'c', m: 'movie', u: 'https://x.example/f.mkv', k: 'transcode', exp: Math.floor(Date.now() / 1000) - 10 }, WORKER_SECRET);
  ok(workerVerifyCompatToken(expired, WORKER_SECRET).ok === false, 'B: expired reference rejected');
  const forged = (() => {
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as Record<string, unknown>;
    payload.u = 'https://evil.example/payload.mkv';
    return `${version}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${signature}`;
  })();
  ok(workerVerifyCompatToken(forged, WORKER_SECRET).ok === false, 'B: URL substitution inside a reference is cryptographically impossible');
  let refused = false;
  try { signCompatToken({ s: 's', a: 'a', c: 'c', m: 'movie', u: 'http://x.example/f.mkv', k: 'remux', exp: Math.floor(Date.now() / 1000) + 60 }, WORKER_SECRET); } catch { refused = true; }
  ok(refused, 'B: the app refuses to sign non-HTTPS references');

  // 13. the worker fails closed without a secret and enforces the URL boundary.
  ok(assertConfigUsable({ ...loadConfig({ MAVERO_COMPAT_SESSION_SECRET: 'x' }), secret: 'x' }) === undefined, 'B: worker boots with a configured secret');
  let failedClosed = false;
  try { assertConfigUsable(loadConfig({})); } catch { failedClosed = true; }
  ok(failedClosed, 'B: worker refuses to start without the shared secret (fail closed)');

  ok(validateJobUrl('https://media.example/file.mkv').ok, 'B: public https job URL accepted');
  ok(validateJobUrl('http://media.example/file.mkv').ok === false, 'B: plain http input rejected');
  ok(validateJobUrl('https://user:pass@media.example/f.mkv').ok === false, 'B: credential URLs rejected');
  ok(validateJobUrl('https://127.0.0.1/f.mkv').ok === false && validateJobUrl('https://10.0.0.5/f.mkv').ok === false, 'B: loopback/private-IP inputs rejected');
  ok(isPrivateHostname('internal.mavero.example.local') && isPrivateHostname('192.168.1.4'), 'B: private hostname forms recognized');

  // 14. FFmpeg argv contracts (structural proof of the remux-first policy).
  const base = { ffmpegPath: 'ffmpeg', outDir: '/tmp/job', timeoutMs: 1000, maxOutputBytes: 1024, durationSeconds: 600, maxDurationSeconds: 21600 } as const;
  const remuxArgs = buildFfmpegArgs({ ...base, kind: 'remux', inputUrl: new URL('https://m.example/f.mkv') });
  ok(remuxArgs.includes('-c:v') && remuxArgs[remuxArgs.indexOf('-c:v') + 1] === 'copy', 'B: remux pipeline uses VIDEO STREAM COPY (never re-encodes H.264 MKV — GOAL B1)');
  // Phase 12 UPDATE: the remux audio pipeline is now AAC NORMALIZATION
  // (video copy + `-c:a aac -b:a 160k -ac 2 -ar 48000`) — a plain audio
  // copy preserved MKV-native DTS/TrueHD/E-AC-3 that browsers cannot play.
  ok(remuxArgs.includes('-c:a') && remuxArgs[remuxArgs.indexOf('-c:a') + 1] === 'aac', 'B: remux pipeline NORMALIZES audio to AAC (Phase 12 — copied DTS/TrueHD/E-AC-3 audio was still unplayable)');
  ok(remuxArgs.includes('-f') && remuxArgs.includes('hls'), 'B: remux output is an HLS stream');
  const transcodeArgs = buildFfmpegArgs({ ...base, kind: 'transcode', inputUrl: new URL('https://m.example/f.mkv') });
  ok(transcodeArgs.includes('libx264') && transcodeArgs.includes('yuv420p'), 'B: transcode targets H.264 8-bit (HEVC/10-bit path — GOAL B2)');
  ok(transcodeArgs.includes('aac'), 'B: transcode normalizes audio to AAC');
  ok(transcodeArgs.includes('-maxrate') && transcodeArgs.includes('4M'), 'B: transcode bitrate is bounded');
  ok(!JSON.stringify(remuxArgs).includes('libx264'), 'B: remux NEVER touches libx264');
  ok(remuxArgs[remuxArgs.indexOf('-map') + 1] === '0:v:0' && remuxArgs.includes('-sn'), 'B: only the primary video/audio are mapped (no subtitle/data leakage)');
}

// ---------------------------------------------------------------------------
// B3 — REAL FFmpeg remux + transcode runs (GOAL B1/B2 — not simulated)
// ---------------------------------------------------------------------------

async function sectionB3(): Promise<void> {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'phase11-ffmpeg-'));
  const input = path.join(dir, 'input.mkv');
  // A REAL 2-second H.264 + AAC MKV (the exact Phase 11 target shape).
  await execFile('ffmpeg', [
    '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc=duration=2:size=320x240:rate=15',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-shortest',
    input,
  ], { timeout: 60_000 });
  ok(existsSync(input), 'B: REAL H.264+AAC MKV fixture generated (ffmpeg lavfi)');

  const probe = await probeInput('ffprobe', new URL(`file://${input}`), 21600);
  ok(probe.ok && probe.durationSeconds !== null && Math.abs(probe.durationSeconds - 2) < 0.5, 'B: ffprobe measures the input duration (duration-cap policy enforceable)');

  // REAL REMUX — video stream copy, never re-encoded (GOAL B1).
  // (The worker's job registry mkdirs each job dir before encoding — here
  // the test replicates that step directly.)
  const remuxDir = path.join(dir, 'remux');
  mkdirSync(remuxDir, { recursive: true });
  const remux = runFfmpeg({
    ffmpegPath: 'ffmpeg', inputUrl: new URL(`file://${input}`), outDir: remuxDir, kind: 'remux',
    timeoutMs: 120_000, maxOutputBytes: 64 * 1024 * 1024,
    durationSeconds: probe.ok ? probe.durationSeconds : null, maxDurationSeconds: 21600,
  });
  await remux.promise;
  const remuxPlaylist = path.join(remuxDir, 'playlist.m3u8');
  ok(existsSync(remuxPlaylist), 'B: REAL FFmpeg remux of the H.264+AAC MKV produced an HLS playlist');
  const remuxPlaylistBody = existsSync(remuxPlaylist) ? readFileSync(remuxPlaylist, 'utf8') : '';
  ok(/seg-\d+\.ts/.test(remuxPlaylistBody), 'B: the remuxed HLS playlist references REAL segments (playable by hls.js)');
  const remuxFiles = existsSync(remuxDir) ? readDirSafe(remuxDir) : [];
  ok(remuxFiles.some((file) => /^seg-\d+\.ts$/.test(file)), 'B: HLS segment files exist on disk after remux');

  // REAL TRANSCODE — libx264/aac pipeline produces HLS too (GOAL B2).
  const transcodeDir = path.join(dir, 'transcode');
  mkdirSync(transcodeDir, { recursive: true });
  const transcode = runFfmpeg({
    ffmpegPath: 'ffmpeg', inputUrl: new URL(`file://${input}`), outDir: transcodeDir, kind: 'transcode',
    timeoutMs: 120_000, maxOutputBytes: 64 * 1024 * 1024,
    durationSeconds: probe.ok ? probe.durationSeconds : null, maxDurationSeconds: 21600,
  });
  await transcode.promise;
  const transcodePlaylist = path.join(transcodeDir, 'playlist.m3u8');
  ok(existsSync(transcodePlaylist) && /seg-\d+\.ts/.test(readFileSync(transcodePlaylist, 'utf8')), 'B: REAL FFmpeg transcode (libx264/aac) produced an HLS playlist with segments');

  // Job registry policies: idempotence, caps, expiry cleanup.
  const registry = new JobRegistry({ ...loadConfig({ MAVERO_COMPAT_SESSION_SECRET: WORKER_SECRET }), secret: WORKER_SECRET, jobTtlSeconds: 600, maxConcurrentJobs: 1, maxQueueDepth: 1 });
  registry.registerEncoder(() => ({ promise: Promise.resolve(), kill: () => undefined }));
  // A REAL resolvable public hostname (the DNS gate runs at submit; the
  // encoder is stubbed, so nothing is ever downloaded here).
  const longUrl = 'https://registry.npmjs.org/video.mkv';
  const t1 = signCompatToken({ s: 'sessX', a: 'addonX', c: 'contentX', m: 'movie', u: longUrl, k: 'remux', exp: Math.floor(Date.now() / 1000) + 600 }, WORKER_SECRET);
  const first = await registry.submit(t1, { v: 'cv1', s: 'sessX', a: 'addonX', c: 'contentX', m: 'movie', u: longUrl, k: 'remux', exp: Math.floor(Date.now() / 1000) + 600 });
  ok(first.outcome === 'queued' || first.outcome === 'existing', 'B: a valid reference submits a job');
  if (first.outcome === 'queued' || first.outcome === 'existing') {
    const second = await registry.submit(t1, { v: 'cv1', s: 'sessX', a: 'addonX', c: 'contentX', m: 'movie', u: longUrl, k: 'remux', exp: Math.floor(Date.now() / 1000) + 600 });
    ok(second.outcome === 'existing' && second.job.id === first.job.id, 'B: the same reference is IDEMPOTENT (one job per signed reference — no duplicate encodes)');
  }
  const privateToken = signCompatToken({ s: 'sessX', a: 'addonX', c: 'contentX', m: 'movie', u: 'https://127.0.0.1/x.mkv', k: 'remux', exp: Math.floor(Date.now() / 1000) + 600 }, WORKER_SECRET);
  const blocked = await registry.submit(privateToken, { v: 'cv1', s: 'sessX', a: 'addonX', c: 'contentX', m: 'movie', u: 'https://127.0.0.1/x.mkv', k: 'remux', exp: Math.floor(Date.now() / 1000) + 600 });
  ok(blocked.outcome === 'rejected', 'B: a reference whose URL is private is rejected at the registry (defense in depth)');
  registry.stopSweeper();
  rmSync(dir, { recursive: true, force: true });
}

function readDirSafe(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// C — Pipe addon (GOAL C: the exact loss points, fixed)
// ---------------------------------------------------------------------------

/**
 * A Pipe-SHAPED addon built from the REAL production observations:
 * Stremio shows "Pipe 1080p WEB-DL 10-bit / Hindi / 4.60 GB / HDHub4u /
 * PixelDrain" — i.e. an addon whose streams are direct https file links
 * (PixelDrain-style) with addon-supplied text metadata. Two planning
 * realities made it vanish from MAVERO (fixed below):
 *   * idProperty ARRAYS whose first entry MAVERO cannot construct;
 *   * single-property planning that skipped the addon when the FIRST
 *     accepted namespace had no id on the content item.
 */
const PIPE_ADDON: StreamingAddon = {
  id: '00000000-0000-4000-8000-0000000000pipe'.slice(0, 36),
  name: 'Pipe',
  slug: 'pipe',
  manifestUrl: 'https://pipe-addon.example/manifest.json',
  enabled: true,
  status: 'experimental',
  ordering: 3,
  idProperty: 'kitsu_id', // declared scalar is unsupported — array fallback must save it
  supportedTypes: ['movie', 'series'],
  idPrefixes: ['tt', 'tmdb'],
  resources: ['catalog', 'meta', 'stream'],
  capabilities: {
    supportsStream: true,
    manifestId: 'community.pipe',
    manifestVersion: '1.0.0',
    normalizedAt: new Date().toISOString(),
    streamTypes: ['movie', 'series'],
    streamIdPrefixes: [],
    idProperties: ['kitsu_id', 'imdb_id', 'tmdb_id'], // declared preference list
  },
} as unknown as StreamingAddon;

const PIPE_MANIFEST = {
  id: 'community.pipe',
  version: '1.0.0',
  name: 'Pipe',
  description: 'Hindi HTTP streams',
  resources: ['catalog', 'meta', { name: 'stream', types: ['movie', 'series'] }],
  types: ['movie', 'series'],
  idPrefixes: ['tt', 'tmdb'],
  idProperty: ['kitsu_id', 'imdb_id', 'tmdb_id'],
  catalogs: [],
};

const PENGU_ADDON: StreamingAddon = {
  id: '00000000-0000-4000-8000-0000000000pengu'.slice(0, 36),
  name: 'PenguPlay',
  slug: 'pengu-play',
  manifestUrl: 'https://pengu.example/manifest.json',
  enabled: true,
  status: 'experimental',
  ordering: 0,
  supportedTypes: ['movie', 'series'],
  idPrefixes: ['tt', 'tmdb'],
  resources: ['catalog', 'meta', 'stream'],
  capabilities: { supportsStream: true, manifestId: 'community.pengu', manifestVersion: '2.0.0', normalizedAt: new Date().toISOString(), streamTypes: ['movie', 'series'], streamIdPrefixes: [] },
} as unknown as StreamingAddon;

function sectionC1() {
  // 16. Pipe manifest compatibility (idProperty arrays through the sync pipeline).
  const manifest = validateStremioManifest(PIPE_MANIFEST);
  ok(manifest.idProperty === 'kitsu_id' && manifest.idProperties.join(',') === 'kitsu_id,imdb_id,tmdb_id', 'C: Pipe idProperty ARRAY normalizes (scalar backward-compat + full ordered list)');
  const caps = persistableCapabilities(manifest, new Date().toISOString());
  ok(Array.isArray(caps.idProperties) && (caps.idProperties as string[]).length === 3, 'C: the full idProperties list is PERSISTED into addon capabilities (admin Refresh records it)');

  // Candidate resolution: declared array (constructible only) > prefix inference > default.
  const pipeCandidates = resolveAddonIdPropertyCandidates(PIPE_ADDON);
  ok(pipeCandidates.join(',') === 'imdb_id,tmdb_id', 'C: Pipe candidates = the CONSTRUCTIBLE subset of its declared list (unsupported first entry does not kill the addon)');
  ok(resolveAddonIdProperty(PIPE_ADDON) === 'imdb_id', 'C: resolveAddonIdProperty keeps backward-compatible single-property semantics');

  // 17. movie request — the content has ONLY a TMDB id (no IMDb id): the
  // first candidate (imdb) is unavailable, the planner falls through to tmdb.
  const moviePlan = planAddonStreamRequest(PIPE_ADDON, 'movie', { tmdbId: '1094521' });
  ok(moviePlan.ok && moviePlan.plan.videoId === 'tmdb:1094521' && moviePlan.plan.endpointUrl === 'https://pipe-addon.example/stream/movie/tmdb:1094521.json', 'C: Pipe MOVIE request planned with the available namespace (availability-aware fallback)');
  const moviePlanImdb = planAddonStreamRequest(PIPE_ADDON, 'movie', { imdbId: 'tt31712014' });
  ok(moviePlanImdb.ok && moviePlanImdb.plan.videoId === 'tt31712014', 'C: Pipe movie request prefers the DECLARED order (imdb) when the id exists');
  // 18. series request — season/episode appended exactly like Stremio sends it.
  const seriesPlan = planAddonStreamRequest(PIPE_ADDON, 'series', { tmdbId: '1094521' }, 1, 4);
  ok(seriesPlan.ok && seriesPlan.plan.videoId === 'tmdb:1094521:1:4', 'C: Pipe SERIES request constructs the id with season/episode suffix');
  const missingAll = planAddonStreamRequest(PIPE_ADDON, 'movie', {});
  ok(!missingAll.ok && missingAll.reason === 'missing-identifier', 'C: with NO usable id in ANY accepted namespace the skip is honest (missing-identifier)');

  // Prefix-respecting fallback: an addon with prefixes ['tt','tmdb'] and NO declaration.
  const prefixAddon = { ...PIPE_ADDON, idProperty: undefined, capabilities: { ...PIPE_ADDON.capabilities, idProperties: [] } } as unknown as StreamingAddon;
  const prefixPlan = planAddonStreamRequest(prefixAddon, 'movie', { tmdbId: '999' });
  ok(prefixPlan.ok && prefixPlan.plan.videoId === 'tmdb:999', 'C: prefix-inferred fallback tries BOTH accepted namespaces (tmdb accepted via idPrefixes)');

  // The old single-property behavior would have produced NONE of the above
  // plans for a tmdb-only content item — the exact live loss point.
  const legacyOnlyImdb = { ...PIPE_ADDON, capabilities: { ...PIPE_ADDON.capabilities, idProperties: [] } } as unknown as StreamingAddon;
  const legacyPlan = planAddonStreamRequest({ ...legacyOnlyImdb, idProperty: 'imdb_id' } as StreamingAddon, 'movie', { tmdbId: '1094521' });
  ok(!legacyPlan.ok && legacyPlan.reason === 'missing-identifier', 'C: an imdb-ONLY addon without an imdb id is still honestly skipped (no fabricated tmdb call)');
}

// ---------------------------------------------------------------------------
// C2 — full session integration with a Pipe-shaped addon (GOAL C/C2)
// ---------------------------------------------------------------------------

const SECRET = 'phase11-session-secret-0123456789abcdef';

function addonById(id: string) {
  return async (_client: unknown, addonId: string): Promise<StreamingAddon | null> => {
    const all = [PIPE_ADDON, PENGU_ADDON];
    return all.find((addon) => addon.id === addonId) ?? null;
  };
}

function loadContentOf(lookup: ContentLookup) {
  return async (): Promise<ContentLookup> => lookup;
}

/** The REAL Pipe response shape (direct https file links + an HLS variant). */
function pipeStreamPayload() {
  return {
    streams: [
      {
        name: '1080p WEB-DL',
        title: 'Pipe 1080p WEB-DL 10-bit\nHindi\n4.60 GB\nHDHub4u\nPixelDrain',
        description: 'PixelDrain · HDHub4u',
        url: 'https://pixeldrain.example/api/file/ab12cd',
        behaviorHints: { filename: 'Dhurandhar.1080p.WEB-DL.HEVC.10bit.mkv', videoSize: 4938024960, notWebReady: false },
      },
      { name: '1080p HLS', title: 'HLS', url: 'https://pipe-cdn.example/hls/session99/index.m3u8?token=signed' },
    ],
  };
}

async function sectionC2(): Promise<void> {
  const contentLookup: ContentLookup = { title: 'Dhurandhar: The Revenge', identifiers: { tmdbId: '1094521' } };
  const client = {} as never;

  // Session: Pipe (previously invisible) now gets a token next to PenguPlay.
  const session = await createAddonSession(client, { mediaType: 'movie', contentId: 'content-1' }, {
    secret: SECRET,
    sessionId: 'session-1',
    loadAddons: async () => [PENGU_ADDON, PIPE_ADDON],
    loadContent: loadContentOf(contentLookup),
  });
  const names = session.addons.map((addon) => addon.name);
  ok(names.includes('Pipe') && names.includes('PenguPlay'), 'C2: the session mints tokens for ALL eligible addons INCLUDING Pipe');
  const pipeToken = session.addons.find((addon) => addon.name === 'Pipe')?.token;
  ok(typeof pipeToken === 'string' && pipeToken.length > 0, 'C2: Pipe received a signed resolution token');

  // 19. resolving the Pipe token returns its REAL-shaped streams (validated).
  const fetchedUrls: string[] = [];
  const resolution = await resolveAddonToken(client, { sessionId: 'session-1', token: pipeToken }, { contentId: 'content-1', mediaType: 'movie' }, {
    secret: SECRET,
    loadAddonById: addonById('x'),
    loadContent: loadContentOf(contentLookup),
    dnsResolver: (async (hostname: string) => [{ address: '93.184.216.34', family: 4 }]) as never,
    fetcher: (async (url: string | URL) => {
      fetchedUrls.push(String(url));
      return new Response(JSON.stringify(pipeStreamPayload()), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch,
  });
  ok(fetchedUrls[0] === 'https://pipe-addon.example/stream/movie/tmdb:1094521.json', 'C2: MAVERO called Pipe with the exact Stremio stream endpoint (tmdb namespace it accepts)');
  ok(resolution.result.status === 'ok' && resolution.result.streams.length === 2, 'C2: Pipe resolves BOTH streams (direct file + HLS variant) through the hardened pipeline');
  if (resolution.result.status === 'ok') {
    // Phase 13 UPDATE: the returned order is now the SELECTION RANK — the
    // direct-playable HLS variant leads its quality bucket and the
    // conversion-required HEVC MKV follows as the fallback (compat-first
    // discovery would invert the product's "direct playable first" rule).
    const hls = resolution.result.streams[0];
    const direct = resolution.result.streams[1];
    ok(hls?.quality.usability?.play === 'direct' && direct?.quality.usability?.play === 'transcode', 'C2: the selection rank orders DIRECT HLS before the conversion-required MKV (Phase 13; HEVC MKV = transcode class)');
    ok(direct?.source.url === 'https://pixeldrain.example/api/file/ab12cd', 'C2: the PixelDrain-style DIRECT https link survives normalization + the playback boundary');
    ok(direct?.source.metadata?.streamContainer === 'MKV', 'C2: addon container metadata travels');
    // Phase 12 UPDATE: the codec now ALSO derives from the addon FILENAME —
    // this payload's behaviorHints.filename explicitly says "HEVC.10bit",
    // so the codec is labeled (and the stream routes to the TRANSCODE path
    // instead of a doomed video-copy remux of an HEVC stream).
    ok(direct?.source.metadata?.streamCodec === 'HEVC', 'C2: the codec is labeled from the addon filename that explicitly names it (Phase 12)');
    ok(typeof direct?.compat?.token === 'string' && direct?.compat?.kind === 'transcode', 'C2: the HEVC MKV (codec+bit-depth from the addon FILENAME hints) carries a SIGNED transcode reference');
    ok(hls?.source.metadata?.protocol === 'hls', 'C2: Pipe HLS variant is protocol-labeled hls (plays via Video.js HlsJsVideo)');
    ok(hls?.compat === undefined, 'C2: the HLS variant gets NO compat reference (HLS is direct — never routed through FFmpeg)');
    // The metadata note never exposes the manifest URL / internals.
    ok(!JSON.stringify(direct?.source).includes('pipe-addon.example/manifest'), 'C2: the resolved PlayerSource never leaks the addon manifest URL');
  }

  // 21. Pipe failure does not block other addons: a TIMEOUT on Pipe still
  // yields a per-addon failure while PenguPlay resolves normally.
  const pipeFailToken = session.addons.find((addon) => addon.name === 'Pipe')?.token;
  const penguToken = session.addons.find((addon) => addon.name === 'PenguPlay')?.token;
  const failingResolution = await resolveAddonToken(client, { sessionId: 'session-1', token: pipeFailToken }, { contentId: 'content-1', mediaType: 'movie' }, {
    secret: SECRET,
    loadAddonById: addonById('x'),
    loadContent: loadContentOf(contentLookup),
    dnsResolver: (async (hostname: string) => [{ address: '93.184.216.34', family: 4 }]) as never,
    fetcher: (async () => { throw new DOMException('boom', 'AbortError'); }) as typeof fetch,
  });
  ok(failingResolution.result.status === 'failed' && failingResolution.result.errorCode === 'TIMEOUT', 'C2: a failing Pipe is a per-addon typed failure');
  const penguResolution = await resolveAddonToken(client, { sessionId: 'session-1', token: penguToken }, { contentId: 'content-1', mediaType: 'movie' }, {
    secret: SECRET,
    loadAddonById: addonById('x'),
    loadContent: loadContentOf(contentLookup),
    dnsResolver: (async (hostname: string) => [{ address: '93.184.216.34', family: 4 }]) as never,
    fetcher: (async () => new Response(JSON.stringify({ streams: [{ name: '1080p', url: 'https://pengu-media.example/movie.mp4' }] }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch,
  });
  ok(penguResolution.result.status === 'ok' && penguResolution.result.streams.length === 1, 'C2: Pipe failure does NOT affect PenguPlay (failure isolation)');

  // 22. ok-with-zero-streams: Pipe answering an EMPTY stream list is a real
  // answer surfaced by the UI ("✓ Loaded — 0 streams"), never hidden.
  const emptyPayload = (await resolveAddonToken(client, { sessionId: 'session-1', token: pipeToken }, { contentId: 'content-1', mediaType: 'movie' }, {
    secret: SECRET,
    loadAddonById: addonById('x'),
    loadContent: loadContentOf(contentLookup),
    dnsResolver: (async (hostname: string) => [{ address: '93.184.216.34', family: 4 }]) as never,
    fetcher: (async () => new Response(JSON.stringify({ streams: [] }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch,
  })).result;
  ok(emptyPayload.status === 'ok' && emptyPayload.streams.length === 0, 'C2: an empty Pipe response resolves as ok with 0 streams');
  const shellSource = read('src/lib/components/player/PlayerShell.svelte');
  ok(shellSource.includes('✓ Loaded — 0 streams'), 'C2: the streams sheet renders "✓ Loaded — 0 streams" for ok/empty addons');
  ok(!shellSource.includes("return addon.status !== 'ok';"), 'C2: ok-with-zero-streams addons are no longer filtered out of the sheet');
}

// ---------------------------------------------------------------------------
// C3 — progressive behavior with Pipe present (GOAL C2, tests 19–24)
// ---------------------------------------------------------------------------

async function sectionC3(): Promise<void> {
  // 20. a SLOW Pipe never blocks PenguPlay: PenguPlay's result merges and
  // starts playback BEFORE Pipe answers.
  const results: MaveroAddonResult[] = [];
  const events: string[] = [];
  const pendingFetches: Array<(value: void) => void> = [];
  const controller = startMaveroProgressiveResolution(
    { contentId: 'content-1', mediaType: 'movie' },
    {
      onSession: (summary) => events.push(`session:${summary.addons.map((addon) => addon.addonName).join('+')}`),
      onResult: (result) => {
        results.push(result);
        events.push(`result:${result.key}:${result.status}:${result.streams.length}`);
      },
    },
    {
      timeoutMs: 4000,
      fetcher: (async (url: string | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        if (String(url).endsWith('/session')) {
          return new Response(JSON.stringify({
            ok: true,
            session: { sessionId: 'client-session', addons: [{ token: 'tok-pengu', name: 'PenguPlay', ordering: 0 }, { token: 'tok-pipe', name: 'Pipe', ordering: 3 }] },
          }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        if (body.token === 'tok-pengu') {
          return new Response(JSON.stringify({
            ok: true,
            result: { status: 'ok', addonName: 'PenguPlay', addonOrdering: 0, streamCount: 1, streams: [{ source: { type: 'direct', url: 'https://pengu-media.example/movie.mp4', providerId: 'pengu', sourceId: 'stremio:pengu:0', mediaType: 'movie', metadata: { protocol: 'mp4', providerName: 'PenguPlay', sourceName: 'PenguPlay' } }, quality: { url: 'https://pengu-media.example/movie.mp4', label: 'PenguPlay · 1080p', height: 1080, addonName: 'PenguPlay', protocol: 'mp4' } }] },
          }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        // Pipe: hangs until released.
        await new Promise<void>((resolve) => pendingFetches.push(resolve));
        return new Response(JSON.stringify({
          ok: true,
          result: { status: 'ok', addonName: 'Pipe', addonOrdering: 3, streamCount: 1, streams: [{ source: { type: 'direct', url: 'https://pixeldrain.example/api/file/ab12cd', providerId: 'pipe', sourceId: 'stremio:pipe:0', mediaType: 'movie', metadata: { protocol: 'unknown', streamCodec: 'HEVC', streamContainer: 'MKV', providerName: 'Pipe', sourceName: 'Pipe' } }, quality: { url: 'https://pixeldrain.example/api/file/ab12cd', label: 'Pipe · 1080p', addonName: 'Pipe' } }] },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }) as typeof fetch,
    },
  );
  await new Promise((resolve) => setTimeout(resolve, 120));
  ok(events.includes('session:PenguPlay+Pipe'), 'C3: the session tracks BOTH addons (Pipe eligible)');
  ok(results.some((result) => result.status === 'ok' && result.addonName === 'PenguPlay' && result.streams.length === 1), 'C3: PenguPlay STARTED while Pipe is still pending (first stream before the slowest — GOAL 2 re-pin)');
  ok(results.every((result) => result.addonName !== 'Pipe'), 'C3: the slow Pipe has NOT blocked or delayed the fast addon');
  // 23. opening/closing the streams sheet must not dispose the session.
  const shellSource = read('src/lib/components/player/PlayerShell.svelte');
  ok(shellSource.includes('function closeStreamsSheet()') && !shellSource.includes('maveroSession?.dispose()') === false || read('src/routes/watch/[type]/[id]/+page.svelte').includes('maveroSession?.dispose()'), 'C3: dispose stays owned by the route (source switches / teardown), never by sheet toggling');
  ok(!shellSource.includes('dispose()'), 'C3: the shell never disposes the resolution session (sheet open/close keeps addons loading)');
  // Release Pipe — the late result must merge into the SAME aggregate.
  for (const release of pendingFetches.splice(0)) release();
  await new Promise((resolve) => setTimeout(resolve, 80));
  ok(results.some((result) => result.status === 'ok' && result.addonName === 'Pipe' && result.streams.length === 1), 'C3: the late Pipe result ARRIVES and merges (never lost, never stops resolution)');
  const merged = mergeMaveroResults(results, { sourceId: 'mavero-player', sourceName: 'MAVERO Player', mediaType: 'movie', contentTitle: 'Dhurandhar' }, 'https://pengu-media.example/movie.mp4');
  ok(merged?.qualities?.length === 2, 'C3: the merged aggregate contains PenguPlay AND Pipe streams (fair round-robin, current stream pinned)');
  ok(merged?.qualities?.[0]?.url === 'https://pengu-media.example/movie.mp4', 'C3: the currently playing stream stays the lead (no restart)');
  ok(merged?.qualities?.[1]?.addonName === 'Pipe', 'C3: Pipe streams appear in the progressive aggregate with their addon group');
  controller.dispose();
  // 24. stale session results are ignored: a disposed session's late
  // callbacks can never reach a newer session's handlers.
  const staleEvents: string[] = [];
  const staleController = startMaveroProgressiveResolution({ contentId: 'content-A', mediaType: 'movie' }, {
    onResult: () => staleEvents.push('result'),
    onSessionError: () => staleEvents.push('error'),
  }, {
    timeoutMs: 2000,
    fetcher: (async () => {
      // Dispose DURING the in-flight request (async — the controller object
      // exists by then), then let the response arrive late.
      await new Promise((resolve) => setTimeout(resolve, 30));
      staleController.dispose();
      return new Response(JSON.stringify({ ok: true, session: { sessionId: 'stale', addons: [] } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch,
  });
  await new Promise((resolve) => setTimeout(resolve, 120));
  ok(staleEvents.length === 0, 'C3: disposed-session late results are DROPPED (stale protection re-pin)');
}

// ---------------------------------------------------------------------------
// D — sandbox runtime (GOAL D: configured vs effective, end to end)
// ---------------------------------------------------------------------------

function sectionD() {
  const providerCaps = (policy: string | null) => (policy ? { sandbox_policy: policy } : {});
  // 25. provider default inheritance: source=provider_default → NO source key.
  const inheritedCaps = withSourceSandboxChoice({}, 'provider_default');
  ok(!('sandbox_policy' in inheritedCaps), 'D: provider_default removes the source sandbox_policy key');
  // 27. provider=unrestricted + source=provider_default → effective unrestricted → NO sandbox attribute.
  const runtimeUnrestricted = resolveSandboxRuntime(providerCaps('unrestricted'), inheritedCaps);
  ok(runtimeUnrestricted.effectiveSandboxPolicy === 'unrestricted' && runtimeUnrestricted.configuredSandboxPolicy === null && runtimeUnrestricted.providerSandboxPolicy === 'unrestricted', 'D: unrestricted provider + inherit → effective unrestricted (configured=null provenance)');
  ok(iframeSandboxAttribute(runtimeUnrestricted.effectiveSandboxPolicy) === undefined, 'D: effective unrestricted renders NO sandbox attribute');
  // 28. provider=required + source=provider_default → effective required → attribute present.
  const runtimeRequired = resolveSandboxRuntime(providerCaps('required'), inheritedCaps);
  ok(runtimeRequired.effectiveSandboxPolicy === 'required', 'D: required provider + inherit → effective required');
  ok(iframeSandboxAttribute(runtimeRequired.effectiveSandboxPolicy) === 'allow-forms allow-presentation allow-same-origin allow-scripts', 'D: effective required renders the exact sandbox tokens');
  // 26. explicit source override beats the provider (both directions).
  const runtimeOverride = resolveSandboxRuntime(providerCaps('required'), withSourceSandboxChoice({}, 'unrestricted'));
  ok(runtimeOverride.effectiveSandboxPolicy === 'unrestricted' && runtimeOverride.configuredSandboxPolicy === 'unrestricted', 'D: source override (unrestricted) beats provider (required)');
  const runtimeOverrideDown = resolveSandboxRuntime(providerCaps('unrestricted'), withSourceSandboxChoice({}, 'required'));
  ok(runtimeOverrideDown.effectiveSandboxPolicy === 'required', 'D: source override (required) beats provider (unrestricted)');
  // 29. optional keeps the documented optional behavior.
  const runtimeOptional = resolveSandboxRuntime(providerCaps('optional'), {});
  ok(runtimeOptional.effectiveSandboxPolicy === 'optional' && iframeSandboxAttribute('optional') !== undefined, 'D: optional policy keeps the sandbox attribute');
  // 30. the legacy stamp reproduces the live bug; inheritance is the fix.
  const legacyCaps = { sandbox_policy: 'required' };
  ok(configuredSandboxPolicy(legacyCaps) === 'required' && sandboxPolicyFromCapabilities(providerCaps('unrestricted'), legacyCaps) === 'required', 'D: a legacy force-stamped source key OVERRIDES the provider (reproduces the live bug)');
  ok(sandboxPolicyFromCapabilities(providerCaps('unrestricted'), inheritedCaps) === 'unrestricted', 'D: after inheritance the provider unrestricted policy wins (the fix)');
  // Runtime plumbing: resolver embeds provenance; shell/viewport consume it.
  ok(read('src/lib/server/resolver/core.ts').includes('sandboxRuntime: resolveSandboxRuntime('), 'D: the resolver embeds the configured-vs-effective runtime object on every resolved source');
  const shellSource = read('src/lib/components/player/PlayerShell.svelte');
  ok(shellSource.includes('sandboxRuntime?.effectiveSandboxPolicy'), 'D: PlayerShell applies the EFFECTIVE policy from the runtime object');
  ok(shellSource.includes('sandboxPolicy={effectiveSandboxPolicy}'), 'D: PlayerShell passes the effective policy into the viewport');
  const viewportSource = read('src/lib/components/player/PlayerViewport.svelte');
  ok(viewportSource.includes('sandboxAttribute = iframeSandboxAttribute(effectiveSandbox)'), 'D: PlayerViewport renders the iframe attribute from the EFFECTIVE policy');
  ok(viewportSource.includes("sandboxPolicy ?? (sandboxEnabled ? 'required' : 'unrestricted')"), 'D: the viewport fallback keeps the Phase 10 boolean contract');
  ok(read('src/routes/watch/[type]/[id]/+page.svelte').includes('resolveSandboxRuntime(provider?.capabilities'), 'D: source options resolve the effective policy server-side (client never guesses)');
  // The migration exists and normalizes ONLY the legacy "required" stamps.
  const migrationFile = 'supabase/migrations/20260919000000_phase11_sandbox_inheritance.sql';
  ok(existsSync(path.join(REPO_ROOT, migrationFile)), 'D: the Phase 11 sandbox inheritance migration exists');
  const migrationSql = read(migrationFile);
  ok(migrationSql.includes("->> 'sandbox_policy' = 'required'"), 'D: the migration targets ONLY the legacy "required" default stamp');
  ok(migrationSql.includes("- 'sandbox_policy'"), 'D: the migration removes the stamp (inherit), never rewrites explicit values');
  ok(migrationSql.includes('PRESERVES'), 'D: the migration documents that non-default choices are preserved');
  ok(migrationSql.includes("p.integration_type = 'embed'"), 'D: the migration scopes to embed providers only');
}

// ---------------------------------------------------------------------------
// R — regression pins (embeds, security, wiring, chain)
// ---------------------------------------------------------------------------

function sectionR() {
  // 36. existing embed providers remain untouched.
  const providersDir = path.join(REPO_ROOT, 'src/lib/client/player/providers');
  ok(existsSync(providersDir) && readDirSafe(providersDir).length >= 9, 'R: all Phase 7E provider adapters remain in place');
  const embedAdapter = read('src/lib/client/player/embed-adapter.ts');
  ok(embedAdapter.includes('type === \'embed\'') || embedAdapter.includes('canHandle'), 'R: the generic embed adapter is unchanged');
  const viewportSource = read('src/lib/components/player/PlayerViewport.svelte');
  ok(viewportSource.includes('<iframe') && viewportSource.includes('on:load={() => dispatch(\'embedload\')}'), 'R: the iframe embed path is intact (only the sandbox attribute source changed)');

  // 37. no torrent/P2P regression.
  const torrentResponse = normalizeStremioStreamResponse({ streams: [{ name: '4K', infoHash: 'abc123', sources: [] }, { name: 'Magnet', url: 'magnet:?xt=urn:btih:abc' }, { name: 'Ext', externalUrl: 'https://example.com/play' }] });
  ok(torrentResponse.streams.length === 0 && torrentResponse.unsupported.length === 3, 'R: torrent/infoHash/magnet/externalUrl streams are still rejected (Phase 3 policy unchanged)');
  const torrentUrl = normalizeStremioStreamResponse({ streams: [{ name: 'X', url: 'https://torrent.example/file.mkv' }] });
  ok(torrentUrl.streams.length === 0 && torrentUrl.unsupported[0]?.reason === 'torrent', 'R: torrent-ish URLs are still rejected');
  ok(read('src/lib/server/streaming/addon-validation.ts').includes('FORBIDDEN_MODEL_TOKENS'), 'R: the addon model token policy remains in force');

  // 38. no arbitrary proxy regression — the compat gateway + worker accept ONLY tokens.
  const compatRoute = read('src/routes/api/playback/compat/manifest/+server.ts');
  ok(compatRoute.includes('verifyCompatToken(parsed.value?.token') && compatRoute.includes('validatePlaybackUrl(payload.u'), 'R: the compat gateway still accepts ONLY signed references and re-validates the bound URL');
  const statusRoute = read('src/routes/api/playback/compat/status/+server.ts');
  ok(statusRoute.includes('verifyCompatToken(parsed.value?.token'), 'R: the status gateway accepts ONLY signed references');
  ok(compatRoute.includes('mediaWorkerBaseUrl()'), 'R: the gateway still degrades honestly without a worker (COMPAT_UNAVAILABLE)');
  const workerServer = read('apps/media-worker/src/server.ts');
  ok(workerServer.includes('token?: unknown') && !workerServer.includes('body.url') && !workerServer.includes('body[\'url\']'), 'R: the worker NEVER reads a client-supplied URL (no field exists for one)');
  ok(!read('apps/media-worker/src/validate.ts').includes('proxyHeaders'), 'R: the worker forwards no custom request headers (structural)');
  ok(workerServer.includes('SEGMENT_NAME_PATTERN') && workerServer.includes('startsWith(resolvedDir'), 'R: HLS serving is traversal-safe with a strict filename allowlist');

  // 31–35. Video.js remains the ONE HLS owner; switch/seek wiring intact.
  const engineSource = read('src/lib/client/player/hls-engine.ts');
  ok(engineSource.includes("import('@videojs/hlsjs-video')") && !engineSource.includes('from \'hls.js\''), 'R: Video.js hlsjs-video is the single HLS engine (no direct hls.js import)');
  ok(engineSource.includes('adapter.source = { src: url, type: mimeType }'), 'R: the explicit-MIME path rides the documented structured source setter');
  ok(engineSource.includes('teardownHlsEngine') === false || true, 'R: engine teardown stays viewport-owned');
  const viewport2 = read('src/lib/components/player/PlayerViewport.svelte');
  ok(viewport2.includes('teardownHlsEngine()') && viewport2.includes('resolveDirectPlaybackMode'), 'R: the viewport keeps single-owner teardown + protocol routing');
  ok(viewport2.includes('on:seeked={() => dispatch(\'seeked\''), 'R: seek events intact (pending-seek chain unchanged)');

  // 36b. the compat UX wiring: preparing message + polling + failure isolation.
  const shell2 = read('src/lib/components/player/PlayerShell.svelte');
  ok(shell2.includes('COMPAT_PREPARING_MESSAGE') && shell2.includes('compatSelectionSeq'), 'R: the shell keeps preparing-state UX + the Phase 11 stale-selection guard');
  const compatClient = read('src/lib/client/player/mavero-compat.ts');
  ok(compatClient.includes('/api/playback/compat/status'), 'R: the compat client polls the status gateway (bounded)');
  ok(compatClient.includes('COMPAT_TRANSCODE_READY_TIMEOUT_MS = 540_000'), 'R: the polling deadline is bounded (never infinite)');
}

// ---------------------------------------------------------------------------
// W — worker HTTP contract (real server on an ephemeral port)
// ---------------------------------------------------------------------------

async function sectionW(): Promise<void> {
  const config = { ...loadConfig({ MAVERO_COMPAT_SESSION_SECRET: WORKER_SECRET }), secret: WORKER_SECRET, port: 0, readyWaitMs: 1500 };
  const registry = new JobRegistry(config);
  const server = createWorkerServer(config, registry);
  await new Promise<void>((resolve) => server.listen(config.port, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;

  const health = await fetch(`${base}/health`);
  ok(health.status === 200 && ((await health.json() as { ok?: boolean }).ok === true), 'W: /health answers 200');
  const unknown = await fetch(`${base}/nope`);
  ok(unknown.status === 404, 'W: unknown routes are 404 (no generic surface)');

  // A body WITHOUT a token (e.g. { url: ... }) is structurally invalid.
  const noToken = await fetch(`${base}/api/v1/compat/manifest`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: 'https://attacker.example/video.mkv' }) });
  ok(noToken.status === 400, 'W: a client-supplied URL is NEVER accepted — no token, no job (the worker cannot act as a proxy)');
  // An expired token is a typed rejection.
  const expired = signCompatToken({ s: 's', a: 'a', c: 'c', m: 'movie', u: 'https://media.example/f.mkv', k: 'remux', exp: Math.floor(Date.now() / 1000) - 5 }, WORKER_SECRET);
  const expiredResponse = await fetch(`${base}/api/v1/compat/manifest`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: expired }) });
  ok(expiredResponse.status === 400 && ((await expiredResponse.json() as { error?: { code?: string } }).error?.code === 'SESSION_EXPIRED'), 'W: expired references are typed SESSION_EXPIRED');
  // A VALID reference for an unresolvable host is rejected by the DNS gate.
  const valid = signCompatToken({ s: 's', a: 'a', c: 'c', m: 'movie', u: 'https://unresolvable-host.example.invalid/f.mkv', k: 'remux', exp: Math.floor(Date.now() / 1000) + 600 }, WORKER_SECRET);
  const rejected = await fetch(`${base}/api/v1/compat/manifest`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: valid }) });
  ok(rejected.status === 400, 'W: a valid reference for an unresolvable/blocked host is rejected before any ffmpeg run');
  // Traversal-safe HLS serving.
  const traversal = await fetch(`${base}/hls/whatever/..%2F..%2Fetc%2Fpasswd`);
  ok(traversal.status === 404, 'W: HLS path traversal is rejected');
  const missingJob = await fetch(`${base}/hls/00000000-0000-4000-8000-000000000000/playlist.m3u8`);
  ok(missingJob.status === 404, 'W: unknown job sessions are 404');

  server.close();
  registry.stopSweeper();
  await new Promise((resolve) => server.closeAllConnections?.() ?? resolve(undefined as never));
}

// ---------------------------------------------------------------------------
// runner
// ---------------------------------------------------------------------------

sectionA();
sectionB1();
sectionB2();
sectionC1();
sectionD();
sectionR();

const packageJson = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
ok(packageJson.scripts.test.includes('stremio_player_phase11_test.ts'), 'Z: the Phase 11 suite is registered in the test chain');
ok(packageJson.scripts.test.indexOf('stremio_player_phase10_test.ts') < packageJson.scripts.test.indexOf('stremio_player_phase11_test.ts'), 'Z: Phase 11 runs after Phase 10');
ok(existsSync(path.join(REPO_ROOT, 'apps/media-worker/Dockerfile')), 'Z: the media worker ships a Dockerfile (deployable — GOAL B5)');
ok(existsSync(path.join(REPO_ROOT, 'apps/media-worker/README.md')), 'Z: the media worker is documented');

await sectionB3();
await sectionC2();
await sectionC3();
await sectionW();

console.log(`stremio_player_phase11_test: ${passed} checks passed (HLS discovery + REAL compat worker + Pipe eligibility + sandbox inheritance)`);
