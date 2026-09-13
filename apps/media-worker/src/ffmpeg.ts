/**
 * MAVERO media worker — FFmpeg pipelines (Phase 11, GOALS B1–B3).
 *
 * TWO production conversion paths, chosen by the SIGNED job kind — never
 * by anything the client says:
 *
 *   remux (GOAL B1 — H.264/AAC-class video in MKV) — Phase 12 audio
 *   normalization:
 *     -map 0:v:0 -map 0:a:0? -c:v copy -c:a aac -b:a 160k -ac 2 -ar 48000
 *     VIDEO IS NEVER RE-ENCODED (stream copy is minutes-fast on any healthy
 *     CPU). `-c:a copy` is NOT safe for MKV sources: their audio is very
 *     often DTS / TrueHD / E-AC-3 / multichannel — codecs MSE cannot play,
 *     so a copied-audio "remux" produced an HLS stream that still failed in
 *     the browser. The audio is therefore NORMALIZED to browser-safe AAC
 *     160k stereo 48 kHz while the video bitstream stays untouched.
 *
 *   transcode (GOAL B2 — HEVC/H.265, 10-bit, legacy codecs, unsupported
 *   audio):
 *     -c:v libx264 -pix_fmt yuv420p -preset veryfast -crf 23
 *     -maxrate/-bufsize bounded -c:a aac -b:a 160k -ac 2
 *     10-bit input is converted to 8-bit yuv420p (the -10bit problem),
 *     audio is normalized to AAC stereo. Bitrate is bounded so a burst of
 *     jobs can never saturate the uplink.
 *
 * OUTPUT (GOAL B6): an HLS VOD playlist (`playlist.m3u8` + segments) inside
 * the job's own directory, written INCREMENTALLY — the first segments exist
 * long before the whole file is processed, so the player starts on a
 * partially-encoded file (GOAL 15 streaming) and seeking works because the
 * final playlist (written at completion) lists every segment.
 *
 * Every spawn is bounded: `-nostdin`, wall-clock kill timer, stderr parsed
 * for progress. No shell interpolation — argv arrays only.
 */

import { spawn } from 'node:child_process';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export type ProbeResult =
  | { ok: true; durationSeconds: number | null }
  | { ok: false; code: 'PROBE_FAILED' | 'TOO_LONG' };

export type FfmpegEvent =
  | { type: 'start' }
  | { type: 'progress'; seconds: number }
  | { type: 'done' }
  | { type: 'failed'; code: 'FFMPEG_FAILED' | 'FFMPEG_TIMEOUT' | 'OUTPUT_LIMIT'; message?: string };

const PROBE_TIMEOUT_MS = 30_000;

function ffmpegInputArg(url: URL): string {
  // http(s) input goes through as-is; this module is only ever called with
  // a validated https URL (validate.ts + tokens.ts ran before it).
  return url.toString();
}

/** Probes the input duration with ffprobe (bounded). */
export function probeInput(ffprobePath: string, url: URL, maxDurationSeconds: number): Promise<ProbeResult> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: ProbeResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      finish({ ok: false, code: 'PROBE_FAILED' });
    }, PROBE_TIMEOUT_MS);

    const child = spawn(ffprobePath, [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'json',
      ffmpegInputArg(url),
    ], { stdio: ['ignore', 'pipe', 'ignore'] });
    let stdout = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
      if (stdout.length > 64 * 1024) { try { child.kill('SIGKILL'); } catch { /* ignore */ } }
    });
    child.on('error', () => finish({ ok: false, code: 'PROBE_FAILED' }));
    child.on('close', (code) => {
      if (code !== 0) return finish({ ok: false, code: 'PROBE_FAILED' });
      try {
        const parsed = JSON.parse(stdout) as { format?: { duration?: string } };
        const raw = parsed.format?.duration;
        const duration = typeof raw === 'string' && raw.length ? Number.parseFloat(raw) : Number.NaN;
        if (Number.isFinite(duration) && duration > 0) {
          if (duration > maxDurationSeconds) return finish({ ok: false, code: 'TOO_LONG' });
          return finish({ ok: true, durationSeconds: duration });
        }
        // Unknown duration (some live-ish sources) — accepted; the hard -t
        // cap below still bounds the run.
        return finish({ ok: true, durationSeconds: null });
      } catch {
        return finish({ ok: false, code: 'PROBE_FAILED' });
      }
    });
  });
}

export type FfmpegRunOptions = {
  ffmpegPath: string;
  inputUrl: URL;
  outDir: string;
  kind: 'remux' | 'transcode';
  /** Hard output wall-clock cap (ms). */
  timeoutMs: number;
  /** Hard output size cap (bytes). */
  maxOutputBytes: number;
  /** Input duration from probe (seconds) — drives the hard -t cap when known. */
  durationSeconds: number | null;
  maxDurationSeconds: number;
  onEvent?: (event: FfmpegEvent) => void;
};

export type FfmpegRun = { promise: Promise<void>; kill: () => void };

const HLS_COMMON = [
  '-f', 'hls',
  '-hls_time', '4',
  '-hls_list_size', '0',
  '-hls_flags', 'independent_segments+temp_file',
];

/** Builds the argv for the job's conversion kind (argv arrays — no shell). */
export function buildFfmpegArgs(options: FfmpegRunOptions): string[] {
  const hardCapSeconds = Math.min(options.durationSeconds ?? options.maxDurationSeconds, options.maxDurationSeconds);
  const playlistPattern = `${options.outDir}/playlist.m3u8`;
  const segmentPattern = `${options.outDir}/seg-%05d.ts`;
  const args = [
    '-nostdin',
    '-hide_banner',
    '-loglevel', 'warning',
    '-i', ffmpegInputArg(options.inputUrl),
    '-map', '0:v:0',
    '-map', '0:a:0?',
    '-sn', '-dn', // no subtitle/data streams — browsers never consumed them
  ];
  if (options.kind === 'remux') {
    // GOAL B1 + Phase 12: video STREAM COPY (never re-encoded) + audio
    // NORMALIZED to browser-safe AAC stereo. A plain `-c:a copy` preserved
    // MKV-native DTS/TrueHD/E-AC-3/multichannel audio that MSE cannot
    // decode — the #1 reason remuxed MKV HLS "still would not play".
    args.push(
      '-c:v', 'copy',
      '-c:a', 'aac',
      '-b:a', '160k',
      '-ac', '2',
      '-ar', '48000',
      '-avoid_negative_ts', 'make_zero',
    );
  } else {
    // GOAL B2: broad-compatibility target — H.264 8-bit + AAC stereo.
    args.push(
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-crf', '23',
      '-maxrate', '4M',
      '-bufsize', '8M',
      '-pix_fmt', 'yuv420p',
      '-profile:v', 'main',
      '-level', '4.1',
      '-c:a', 'aac',
      '-b:a', '160k',
      '-ac', '2',
      '-ar', '48000',
    );
  }
  args.push(
    ...HLS_COMMON,
    '-hls_segment_filename', segmentPattern,
    '-t', String(Math.ceil(hardCapSeconds)),
    playlistPattern,
  );
  return args;
}

const PROGRESS_PATTERN = /time=(\d+):(\d{2}):(\d{2})/g;

/** Spawns the conversion. `promise` resolves when ffmpeg exits (any outcome). */
export function runFfmpeg(options: FfmpegRunOptions): FfmpegRun {
  const args = buildFfmpegArgs(options);
  options.onEvent?.({ type: 'start' });
  const child = spawn(options.ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderrTail = '';
  let killed = false;
  const kill = () => {
    killed = true;
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
  };
  const timer = setTimeout(() => {
    killed = true;
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
  }, options.timeoutMs);

  child.stderr?.on('data', (chunk: Buffer) => {
    stderrTail = (stderrTail + chunk.toString('utf8')).slice(-4000);
    let match: RegExpExecArray | null;
    PROGRESS_PATTERN.lastIndex = 0;
    while ((match = PROGRESS_PATTERN.exec(chunk.toString('utf8'))) !== null) {
      const seconds = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
      if (Number.isFinite(seconds)) options.onEvent?.({ type: 'progress', seconds });
    }
  });

  const promise = new Promise<void>((resolve) => {
    child.on('error', (error) => {
      clearTimeout(timer);
      options.onEvent?.({ type: 'failed', code: 'FFMPEG_FAILED', message: error.message });
      resolve();
    });
    child.on('close', async (code) => {
      clearTimeout(timer);
      if (killed) {
        options.onEvent?.({ type: 'failed', code: 'FFMPEG_TIMEOUT' });
        return resolve();
      }
      if (code !== 0) {
        options.onEvent?.({ type: 'failed', code: 'FFMPEG_FAILED', message: stderrTail.slice(-500) });
        return resolve();
      }
      // Output budget check (Phase 11 hardening): a job that produced more
      // than its byte cap (the duration probe lied / a huge remux source)
      // is failed and cleaned, NEVER served. The registry sweep re-checks
      // this periodically; this is the encode-exit enforcement point.
      try {
        const playlistStat = await stat(`${options.outDir}/playlist.m3u8`);
        void playlistStat;
        let totalBytes = 0;
        for (const entry of await readdir(options.outDir)) {
          const info = await stat(join(options.outDir, entry)).catch(() => null);
          if (info?.isFile()) totalBytes += info.size;
        }
        if (totalBytes > options.maxOutputBytes) {
          options.onEvent?.({ type: 'failed', code: 'OUTPUT_LIMIT', message: `output ${totalBytes} bytes exceeds the job budget` });
          return resolve();
        }
        options.onEvent?.({ type: 'done' });
      } catch {
        options.onEvent?.({ type: 'failed', code: 'FFMPEG_FAILED', message: 'no playlist produced' });
      }
      resolve();
    });
  });
  return { promise, kill };
}

/** File URL helper for local test inputs (documented; production uses https). */
export function fileUrlFor(path: string): URL {
  return pathToFileURL(path);
}
