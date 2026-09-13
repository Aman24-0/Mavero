/**
 * MAVERO media worker — environment configuration (Phase 11, GOAL B5).
 *
 * Every limit is a deliberate production policy, not decoration:
 *
 *   * CONCURRENCY — FFmpeg is CPU/IO heavy; the worker refuses to run an
 *     unbounded number of jobs (excess jobs queue; a full queue is a
 *     typed BUSY answer, never an OOM).
 *   * DISK — every job has a hard output byte budget; exceeding it fails
 *     the job and triggers cleanup (no unbounded temp files, GOAL 15).
 *   * DURATION — the input duration is probed with ffprobe and capped
 *     before any ffmpeg run (protects the worker from absurd inputs).
 *   * TTL — jobs and their HLS output EXPIRE; the sweeper deletes
 *     expired files and kills dead-line-exceeded processes.
 *
 * The secret is REQUIRED (fail closed): the worker never starts without
 * `MAVERO_COMPAT_SESSION_SECRET` — the SAME secret the MAVERO app signs
 * compatibility references with (`session-env.ts`). A worker without it
 * could not verify a single job, so booting one would be pointless and
 * dangerous.
 */

function intEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(value) || value < min || value > max) return fallback;
  return value;
}

function floatEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number.parseFloat(raw);
  if (!Number.isFinite(value) || value < min || value > max) return fallback;
  return value;
}

function requiredSecret(): string {
  const secret = process.env.MAVERO_COMPAT_SESSION_SECRET ?? process.env.MAVERO_STREMIO_SESSION_SECRET ?? '';
  return secret.trim();
}

export type WorkerConfig = {
  port: number;
  /** HMAC secret shared with the MAVERO app (compat references). REQUIRED. */
  secret: string;
  /**
   * Public base URL the player uses to reach this worker's HLS output
   * (e.g. https://media-worker.example.com). MUST be https in production —
   * the playback page is https, and mixed content would break playback.
   * Defaults to `http://127.0.0.1:${port}` for local development.
   */
  publicBaseUrl: string;
  /** Maximum number of FFmpeg processes running at once. */
  maxConcurrentJobs: number;
  /** Maximum jobs waiting to start (BUSY beyond this). */
  maxQueueDepth: number;
  /** Per-job output byte budget (bytes). */
  maxJobOutputBytes: number;
  /** Maximum input duration accepted (seconds). */
  maxInputDurationSeconds: number;
  /** Job time-to-live after creation (seconds) — output URLs expire with it. */
  jobTtlSeconds: number;
  /** How long the manifest endpoint waits for first-segment readiness (ms). */
  readyWaitMs: number;
  /** Cleanup sweep interval (ms). */
  cleanupIntervalMs: number;
  /** ffmpeg/ffprobe binary names (overridable for NixOS-style setups). */
  ffmpegPath: string;
  ffprobePath: string;
  /** Minimum free disk bytes required before starting a job. */
  minFreeDiskBytes: number;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const port = intEnv('PORT', 8787, 1, 65535);
  const publicBaseUrl = (env.PUBLIC_BASE_URL ?? env.MAVERO_MEDIA_WORKER_PUBLIC_URL ?? '').trim().replace(/\/+$/, '') || `http://127.0.0.1:${port}`;
  return {
    port,
    secret: requiredSecret(),
    publicBaseUrl,
    maxConcurrentJobs: intEnv('MEDIA_WORKER_MAX_CONCURRENT_JOBS', 2, 1, 16),
    maxQueueDepth: intEnv('MEDIA_WORKER_MAX_QUEUE_DEPTH', 4, 0, 32),
    maxJobOutputBytes: intEnv('MEDIA_WORKER_MAX_OUTPUT_MB', 4096, 64, 1024 * 1024) * 1024 * 1024,
    maxInputDurationSeconds: floatEnv('MEDIA_WORKER_MAX_INPUT_HOURS', 6, 0.25, 24) * 3600,
    jobTtlSeconds: intEnv('MEDIA_WORKER_JOB_TTL_SECONDS', 3 * 3600, 600, 24 * 3600),
    readyWaitMs: intEnv('MEDIA_WORKER_READY_WAIT_MS', 8_000, 1_000, 25_000),
    cleanupIntervalMs: intEnv('MEDIA_WORKER_CLEANUP_INTERVAL_MS', 60_000, 10_000, 600_000),
    ffmpegPath: env.FFMPEG_PATH ?? 'ffmpeg',
    ffprobePath: env.FFPROBE_PATH ?? 'ffprobe',
    minFreeDiskBytes: intEnv('MEDIA_WORKER_MIN_FREE_GB', 2, 0, 1024) * 1024 * 1024 * 1024,
  };
}

/** Validates the configured secret at boot — a worker cannot run without one. */
export function assertConfigUsable(config: WorkerConfig): void {
  if (!config.secret) {
    throw new Error('media-worker: MAVERO_COMPAT_SESSION_SECRET (or MAVERO_STREMIO_SESSION_SECRET) is required — refusing to start (fail closed).');
  }
  if (config.publicBaseUrl.startsWith('http://') && !/^http:\/\/(127\.0\.0\.1|localhost|\[::1\])/.test(config.publicBaseUrl)) {
    console.warn(JSON.stringify({ level: 'warn', msg: 'PUBLIC_BASE_URL is not https — browsers on https pages cannot play mixed-content output', publicBaseUrl: config.publicBaseUrl }));
  }
}
