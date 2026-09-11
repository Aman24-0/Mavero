/**
 * MAVERO media worker — job registry (Phase 11, GOAL B5; Phase 12 GOAL I).
 *
 * Lifecycle (Phase 12 — streaming readiness):
 *   queued → preparing (probe) → encoding → READY (first playlist + first
 *   playable segment on disk) → completed (ffmpeg exited cleanly) | ended
 *   (ffmpeg failed after playback was already possible) | failed.
 *
 * The job becomes `ready` AS SOON AS the output playlist and at least one
 * playable segment exist — FFmpeg KEEPS RUNNING in the background to
 * produce subsequent segments (Phase 11 waited for the ENTIRE movie to
 * finish before exposing the URL, which meant "Preparing stream…" for the
 * whole transcode).
 *
 * Policies enforced HERE (structural, not advisory):
 *   * concurrency cap — at most `maxConcurrentJobs` FFmpeg processes;
 *   * bounded queue — beyond `maxQueueDepth` the caller gets a typed BUSY
 *     answer (the MAVERO app surfaces "conversion unavailable right now"
 *     and the user picks another stream — no silent endless waiting);
 *   * IDEMPOTENCE — one signed reference maps to ONE job (hash of the
 *     token payload), so a player retry/poll reuses the SAME session
 *     instead of spawning duplicate encodes;
 *   * per-job disk budget — the sweep fails a job whose output exceeds
 *     `maxJobOutputBytes` (no unbounded temp files);
 *   * TTL — every job expires; expired jobs are killed, deleted and their
 *     URLs stop resolving (short-lived output, GOAL B5).
 */

import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rm, readdir, stat, statfs } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WorkerConfig } from './config.js';
import type { CompatTokenPayload } from './tokens.js';
import { assertResolvablePublicHost, validateJobUrl } from './validate.js';
import { probeInput, runFfmpeg, type FfmpegEvent } from './ffmpeg.js';

export type JobStatus = 'queued' | 'preparing' | 'encoding' | 'ready' | 'failed';
export type Job = {
  id: string;
  tokenHash: string;
  kind: 'remux' | 'transcode';
  url: string;
  /** Safe correlation fields from the signed payload (no URL). */
  sessionId: string;
  addonId: string;
  contentId: string;
  mediaType: string;
  status: JobStatus;
  phase: string;
  /** Encoded seconds so far (progress), when ffmpeg reports them. */
  progressSeconds: number;
  inputDurationSeconds: number | null;
  createdAt: number;
  expiresAt: number;
  error: string | null;
  outputBytes: number;
};

export type SubmitOutcome =
  | { outcome: 'existing'; job: Job }
  | { outcome: 'queued'; job: Job }
  | { outcome: 'busy'; code: 'BUSY' }
  | { outcome: 'rejected'; code: 'INVALID_URL' | 'BLOCKED_URL' | 'PROBE_FAILED' | 'TOO_LONG' };

export class JobRegistry {
  private readonly jobs = new Map<string, Job>();
  private readonly byTokenHash = new Map<string, string>();
  private readonly dirs = new Map<string, string>();
  private readonly running = new Set<string>();
  private readonly waiting: string[] = [];
  private readonly killers = new Map<string, () => void>();
  /** Poll cadence for the first-segment readiness watcher (ms). */
  private readonly readyPollMs = 500;
  private sweepTimer: NodeJS.Timeout | null = null;
  private encoder: ((job: Job, outDir: string) => { promise: Promise<void>; kill: () => void }) | null = null;

  constructor(private readonly config: WorkerConfig) {}

  /** Wires the actual encoder (avoids a circular import in server.ts). */
  registerEncoder(encoder: (job: Job, outDir: string) => { promise: Promise<void>; kill: () => void }): void {
    this.encoder = encoder;
  }

  snapshot(jobId: string): Job | null {
    const job = this.jobs.get(jobId);
    return job ? { ...job } : null;
  }

  findByToken(token: string): Job | null {
    const hash = this.hashToken(token);
    const id = this.byTokenHash.get(hash);
    return id ? this.snapshot(id) : null;
  }

  all(): Job[] {
    return [...this.jobs.values()].map((job) => ({ ...job }));
  }

  counts(): { active: number; queued: number } {
    return { active: this.running.size, queued: this.waiting.length };
  }

  private hashToken(token: string): string {
    // The token itself is never stored — only its SHA-256 identity.
    return createHash('sha256').update(token, 'utf8').digest('hex');
  }

  async submit(token: string, payload: CompatTokenPayload): Promise<SubmitOutcome> {
    const tokenHash = this.hashToken(token);
    const existingId = this.byTokenHash.get(tokenHash);
    if (existingId) {
      const existing = this.jobs.get(existingId);
      if (existing) return { outcome: 'existing', job: { ...existing } };
    }

    // Independent URL validation (defense in depth — the signature already
    // guarantees MAVERO minted it; the worker re-checks the boundary).
    const structural = validateJobUrl(payload.u);
    if (!structural.ok) return { outcome: 'rejected', code: structural.code };
    const dns = await assertResolvablePublicHost(structural.url);
    if (!dns.ok) return { outcome: 'rejected', code: dns.code };

    const counts = this.counts();
    if (counts.active >= this.config.maxConcurrentJobs && counts.queued >= this.config.maxQueueDepth) {
      return { outcome: 'busy', code: 'BUSY' };
    }

    // Free-disk gate (GOAL B5): a worker whose disk is below the configured
    // floor refuses NEW jobs (typed BUSY — the app surfaces "conversion
    // unavailable right now") instead of writing into a full volume.
    if (this.config.minFreeDiskBytes > 0) {
      const free = await this.freeDiskBytes();
      if (free !== null && free < this.config.minFreeDiskBytes) {
        return { outcome: 'busy', code: 'BUSY' };
      }
    }

    const id = randomUUID();
    const now = Date.now();
    const job: Job = {
      id,
      tokenHash,
      kind: payload.k,
      url: payload.u,
      sessionId: payload.s,
      addonId: payload.a,
      contentId: payload.c,
      mediaType: payload.m,
      status: 'queued',
      phase: 'queued',
      progressSeconds: 0,
      inputDurationSeconds: null,
      createdAt: now,
      expiresAt: now + this.config.jobTtlSeconds * 1000,
      error: null,
      outputBytes: 0,
    };
    const outDir = join(tmpdir(), 'mavero-media-worker', id);
    await mkdir(outDir, { recursive: true });
    this.jobs.set(id, job);
    this.byTokenHash.set(tokenHash, id);
    this.dirs.set(id, outDir);

    if (counts.active < this.config.maxConcurrentJobs) {
      this.start(job);
    } else {
      job.phase = 'queued';
      this.waiting.push(id);
    }
    return { outcome: 'queued', job: { ...job } };
  }

  private start(job: Job): void {
    this.running.add(job.id);
    void this.runJob(job);
  }

  private pump(): void {
    while (this.running.size < this.config.maxConcurrentJobs && this.waiting.length) {
      const next = this.waiting.shift();
      if (!next) break;
      const job = this.jobs.get(next);
      if (job && job.status === 'queued') this.start(job);
    }
  }

  private async runJob(job: Job): Promise<void> {
    job.status = 'preparing';
    job.phase = 'probing';
    let readyWatcher: NodeJS.Timeout | null = null;
    try {
      const probe = await probeInput(this.config.ffprobePath, new URL(job.url), this.config.maxInputDurationSeconds);
      if (probe.ok) {
        job.inputDurationSeconds = probe.durationSeconds;
      } else {
        this.fail(job, probe.code);
        return;
      }
      const outDir = this.dirs.get(job.id);
      if (!outDir || !this.encoder) {
        this.fail(job, 'PROBE_FAILED');
        return;
      }
      job.status = 'encoding';
      job.phase = job.kind === 'remux' ? 'remuxing' : 'transcoding';
      const onEvent = (event: FfmpegEvent) => {
        if (event.type === 'progress') {
          job.progressSeconds = event.seconds;
        } else if (event.type === 'failed') {
          this.fail(job, event.code, event.message);
        }
      };
      const run = this.encoder(job, outDir);
      this.killers.set(job.id, run.kill);
      // Phase 12 (GOAL I): readiness watcher. While FFmpeg encodes, poll the
      // job directory for the output playlist + a first playable segment;
      // the moment they exist the job becomes READY and the player may start
      // — FFmpeg continues producing subsequent segments in the background.
      // The watcher is cleared when the run settles (finally) and is a no-op
      // for jobs that already reached ready/failed.
      readyWatcher = setInterval(() => {
        if (job.status !== 'encoding') return;
        void this.playlistReady(outDir).then((ready) => {
          // Re-read the (mutable) status AFTER the async stat — TS's
          // narrowing of `job.status` does not survive the await.
          const statusNow: JobStatus = job.status;
          if (ready && statusNow === 'encoding') this.markReady(job);
        });
      }, this.readyPollMs);
      readyWatcher.unref();
      await run.promise;
      const statusAfterRun = job.status as JobStatus; // callbacks may have failed it
      if (statusAfterRun === 'failed') return;
      // Encode exited: verify the playlist exists and has at least one
      // playable entry. A failure BEFORE any playable segment → failed.
      const playlist = await this.playlistReady(outDir);
      if (!playlist) {
        this.fail(job, 'FFMPEG_FAILED', 'no playlist produced');
        return;
      }
      // Explicit widened re-reads — TS cannot see the encoder callbacks'
      // mutations of `job.status`, so its narrowing here is stale; the
      // `as JobStatus` cast restores the full union for the comparisons.
      const statusAfterPlaylist = job.status as JobStatus;
      if (statusAfterPlaylist !== 'ready') this.markReady(job);
      // The whole file is packaged now — expose the completed phase while
      // `ready` stays true (the URL keeps serving until the job TTL).
      const statusForPhase = job.status as JobStatus;
      if (statusForPhase === 'ready') job.phase = 'completed';
    } catch {
      this.fail(job, 'FFMPEG_FAILED');
    } finally {
      if (readyWatcher) clearInterval(readyWatcher);
      this.running.delete(job.id);
      this.pump();
    }
  }

  /** True when the playlist exists and references at least one segment. */
  async playlistReady(outDir: string): Promise<boolean> {
    try {
      const files = await readdir(outDir);
      if (!files.includes('playlist.m3u8')) return false;
      const content = await stat(`${outDir}/playlist.m3u8`);
      if (content.size < 40) return false; // header-only playlist
      const segment = files.find((file) => /^(seg-\d+\.ts|init\.mp4|seg-\d+\.m4s)$/.test(file));
      return Boolean(segment);
    } catch {
      return false;
    }
  }

  /**
   * Flips a job to READY exactly once. A failed job is NEVER upgraded
   * (failure before the first playable segment is terminal).
   */
  private markReady(job: Job): void {
    if (job.status === 'failed' || job.status === 'ready') return;
    job.status = 'ready';
    job.phase = 'ready';
  }

  /**
   * Marks a job failed — unless playback already became possible
   * (`status === 'ready'`, Phase 12 GOAL I): a late FFmpeg failure (crash
   * after the first segments, wall-clock timeout) must NOT destroy the
   * already-created playback state. The produced segments stay served until
   * the job TTL; the condition is exposed through the `ended` phase while
   * `ready` remains true, so an in-progress playback can surface an
   * appropriate state instead of losing the stream mid-watch.
   */
  private fail(job: Job, code: string, message?: string): void {
    if (job.status === 'failed') return;
    const error = message ? `${code}: ${message.slice(0, 200)}` : code;
    if (job.status === 'ready') {
      job.phase = 'ended';
      job.error = error;
      return;
    }
    job.status = 'failed';
    job.phase = 'failed';
    job.error = error;
    this.kill(job);
  }

  /**
   * Encoder-reported failure (wired from server.ts). Routed through the
   * SAME ready-aware policy as internal failures so a post-ready FFmpeg
   * event can never downgrade a playable job to `failed`.
   */
  reportEncoderFailure(job: Job, code: string, message?: string): void {
    this.fail(job, code, message);
  }

  dirFor(jobId: string): string | null {
    return this.dirs.get(jobId) ?? null;
  }

  /** Kills one running job's encoder (sweep / disk budget / expiry). */
  kill(job: Job): void {
    try {
      this.killers.get(job.id)?.();
    } catch {
      /* kill must never throw */
    }
  }

  /**
   * The cleanup sweep (GOAL B5): expires jobs (kill + delete), enforces the
   * per-job disk budget and removes orphaned directories from crashed runs.
   */
  async sweep(): Promise<void> {
    const now = Date.now();
    for (const job of [...this.jobs.values()]) {
      const expired = job.expiresAt <= now;
      const overBudget = job.outputBytes > this.config.maxJobOutputBytes;
      if (expired) {
        if (this.running.has(job.id)) {
          job.status = 'failed';
          job.phase = 'failed';
          job.error = 'JOB_EXPIRED';
          this.kill(job);
        }
        const dir = this.dirs.get(job.id);
        if (dir) {
          await rm(dir, { recursive: true, force: true }).catch(() => undefined);
          this.dirs.delete(job.id);
        }
        this.jobs.delete(job.id);
        this.byTokenHash.delete(job.tokenHash);
        const queueIndex = this.waiting.indexOf(job.id);
        if (queueIndex >= 0) this.waiting.splice(queueIndex, 1);
      } else if (overBudget && job.status !== 'failed') {
        this.fail(job, 'OUTPUT_LIMIT');
        const dir = this.dirs.get(job.id);
        if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
      } else if (job.status === 'ready' || job.status === 'failed') {
        // Refresh the output size for the budget check.
        const dir = this.dirs.get(job.id);
        if (dir) job.outputBytes = await this.dirSize(dir);
      } else {
        // Phase 11 hardening: refresh the size of IN-FLIGHT jobs too, so the
        // disk budget can fire DURING an encode (the ffmpeg -t cap bounds
        // output, but a lying probe or a huge remux must not fill the disk
        // between completion checks).
        const dir = this.dirs.get(job.id);
        if (dir) {
          job.outputBytes = await this.dirSize(dir);
          if (job.outputBytes > this.config.maxJobOutputBytes) {
            this.fail(job, 'OUTPUT_LIMIT');
            await rm(dir, { recursive: true, force: true }).catch(() => undefined);
          }
        }
      }
    }
    // Orphaned directories (worker crashed mid-job).
    const root = join(tmpdir(), 'mavero-media-worker');
    try {
      for (const entry of await readdir(root)) {
        if (![...this.jobs.values()].some((job) => this.dirs.get(job.id)?.endsWith(entry))) {
          await rm(join(root, entry), { recursive: true, force: true }).catch(() => undefined);
        }
      }
    } catch {
      /* root may not exist yet */
    }
  }

  private async dirSize(dir: string): Promise<number> {
    let total = 0;
    try {
      for (const file of await readdir(dir)) {
        const info = await stat(join(dir, file)).catch(() => null);
        if (info?.isFile()) total += info.size;
      }
    } catch {
      return 0;
    }
    return total;
  }

  /**
   * Free bytes on the volume hosting the job scratch root (Phase 11
   * hardening). `null` when the platform cannot report it — the gate then
   * stays open rather than blocking conversions on unsupported filesystems.
   */
  private async freeDiskBytes(): Promise<number | null> {
    try {
      const root = join(tmpdir(), 'mavero-media-worker');
      await mkdir(root, { recursive: true });
      const info = await statfs(root);
      return info.bavail * info.bsize;
    } catch {
      return null;
    }
  }

  startSweeper(): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => {
      void this.sweep().catch(() => undefined);
    }, this.config.cleanupIntervalMs);
    this.sweepTimer.unref();
  }

  stopSweeper(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
  }
}
