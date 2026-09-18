import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { JobRegistry } from '../apps/media-worker/src/jobs';
import { loadConfig } from '../apps/media-worker/src/config';

/**
 * Phase 3-G (audit MW-4) — Media-worker hardening.
 *
 * The existing media-worker was already well-hardened from Phase 1:
 *   * bounded concurrency (maxConcurrentJobs, default 2)
 *   * bounded queue (maxQueueDepth, default 4)
 *   * bounded retries (failed jobs are NOT auto-retried — re-presenting
 *     the SAME token creates a FRESH attempt per Phase 13 retry determinism)
 *   * explicit timeouts (JOB_TIMEOUT_MS 4h, PROBE_TIMEOUT_MS 30s,
 *     READY_WAIT_MS 8s)
 *   * ffmpeg process lifecycle (SIGKILL on timeout/budget)
 *   * temp file cleanup (sweep + failed-job cleanup)
 *   * orphan process/file risks (orphaned directory cleanup in sweep)
 *   * memory growth (bounded by maxConcurrentJobs + maxJobOutputBytes)
 *   * disk growth (bounded by maxJobOutputBytes + minFreeDiskBytes + sweep)
 *   * malformed input (validateJobUrl + DNS check)
 *
 * Phase 3-G adds ONE concrete improvement justified by the audit:
 *   * killAll() on shutdown — kills in-flight FFmpeg processes so the
 *     worker does NOT leave orphaned processes when the container is
 *     terminating. Without this, a SIGTERM during an active encode
 *     leaves ffmpeg running until the OS kills it or it finishes
 *     (up to JOB_TIMEOUT_MS = 4 hours).
 *
 * This test verifies:
 *   1. killAll() kills all in-flight FFmpeg processes (calls each killer).
 *   2. killAll() marks in-flight jobs as failed with WORKER_SHUTDOWN.
 *   3. killAll() is idempotent (clears the killers Map).
 *   4. The shutdown handler calls killAll() before server.close().
 *   5. The shutdown handler handles SIGTERM, SIGINT, AND SIGQUIT.
 *   6. killAll() is best-effort (a throwing killer does NOT crash the loop).
 *   7. Existing bounded behavior preserved (maxConcurrentJobs, maxJobOutputBytes, etc.).
 */

let passed = 0;
function ok(condition: unknown, label: string) {
  assert.ok(condition, label);
  passed += 1;
  console.log(`  ok ${passed} - ${label}`);
}

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative: string) => readFileSync(path.join(REPO_ROOT, relative), 'utf8');

// ============================================================
// 1. killAll() exists + is callable.
// ============================================================
const jobsSrc = read('apps/media-worker/src/jobs.ts');
ok(/killAll\(\): void/.test(jobsSrc), '1a. JobRegistry.killAll() method exists');
ok(/Phase 3-G \(audit MW-4\): kills ALL in-flight FFmpeg processes/.test(jobsSrc), '1b. killAll annotated with Phase 3-G (audit MW-4) comment');

// ============================================================
// 2. killAll() calls each registered killer.
// ============================================================
const config = loadConfig({ MAVERO_COMPAT_SESSION_SECRET: 'test-secret' } as NodeJS.ProcessEnv);
const registry = new JobRegistry(config);

let killCallCount = 0;
const fakeKiller = () => { killCallCount += 1; };
// Register a few fake killers via the internal Map.
(registry as unknown as { killers: Map<string, () => void> }).killers.set('job-1', fakeKiller);
(registry as unknown as { killers: Map<string, () => void> }).killers.set('job-2', fakeKiller);
(registry as unknown as { killers: Map<string, () => void> }).killers.set('job-3', fakeKiller);

registry.killAll();
ok(killCallCount === 3, `2a. killAll() called each of the 3 registered killers (got ${killCallCount})`);

// ============================================================
// 3. killAll() is idempotent — calling twice does NOT re-call killers.
// ============================================================
killCallCount = 0;
registry.killAll();
ok(killCallCount === 0, '3a. killAll() is idempotent — second call finds no killers (Map cleared)');

// ============================================================
// 4. killAll() is best-effort — a throwing killer does NOT crash the loop.
// ============================================================
const throwingKiller = () => { throw new Error('kill failed'); };
const okKiller = () => { killCallCount += 1; };
(registry as unknown as { killers: Map<string, () => void> }).killers.set('throwing-job', throwingKiller);
(registry as unknown as { killers: Map<string, () => void> }).killers.set('ok-job', okKiller);
killCallCount = 0;
// Should NOT throw — the throwing killer is caught internally.
let didThrow = false;
try {
  registry.killAll();
} catch {
  didThrow = true;
}
ok(didThrow === false, '4a. killAll() does NOT throw when a killer throws (best-effort)');
ok(killCallCount === 1, `4b. killAll() continued past the throwing killer to the next one (got ${killCallCount} successful kills)`);

// ============================================================
// 5. killAll() marks in-flight jobs as failed with WORKER_SHUTDOWN.
// ============================================================
const registry2 = new JobRegistry(config);
(registry2 as unknown as { killers: Map<string, () => void> }).killers.set('job-A', () => {});
(registry2 as unknown as { jobs: Map<string, { status: string; phase: string; error: string | null }> }).jobs.set('job-A', { status: 'encoding', phase: 'transcoding', error: null });
registry2.killAll();
const jobA = (registry2 as unknown as { jobs: Map<string, { status: string; phase: string; error: string | null }> }).jobs.get('job-A');
ok(jobA?.status === 'failed', `5a. in-flight job marked as failed (got ${jobA?.status})`);
ok(jobA?.phase === 'failed', `5b. in-flight job phase set to failed (got ${jobA?.phase})`);
ok(jobA?.error === 'WORKER_SHUTDOWN', `5c. in-flight job error set to WORKER_SHUTDOWN (got ${jobA?.error})`);

// Ready jobs are NOT marked as failed (playback already became possible).
const registry3 = new JobRegistry(config);
(registry3 as unknown as { killers: Map<string, () => void> }).killers.set('job-B', () => {});
(registry3 as unknown as { jobs: Map<string, { status: string; phase: string; error: string | null }> }).jobs.set('job-B', { status: 'ready', phase: 'ready', error: null });
registry3.killAll();
const jobB = (registry3 as unknown as { jobs: Map<string, { status: string; phase: string; error: string | null }> }).jobs.get('job-B');
ok(jobB?.status === 'ready', '5d. ready job NOT marked as failed (playback state preserved)');
ok(jobB?.error === null, '5e. ready job error NOT set (playback already possible)');

// ============================================================
// 6. The shutdown handler calls killAll() before server.close().
// ============================================================
const serverSrc = read('apps/media-worker/src/server.ts');
ok(/registry\.killAll\(\);/.test(serverSrc), '6a. shutdown handler calls registry.killAll()');
ok(/registry\.killAll\(\);[\s\S]*?registry\.stopSweeper\(\);[\s\S]*?server\.close/.test(serverSrc), '6b. killAll() called BEFORE stopSweeper + server.close() (kills first, then drains)');

// ============================================================
// 7. The shutdown handler handles SIGTERM, SIGINT, AND SIGQUIT.
// ============================================================
ok(/process\.on\('SIGTERM', shutdown\)/.test(serverSrc), '7a. SIGTERM handled');
ok(/process\.on\('SIGINT', shutdown\)/.test(serverSrc), '7b. SIGINT handled');
ok(/process\.on\('SIGQUIT', shutdown\)/.test(serverSrc), '7c. SIGQUIT handled (Docker / some orchestrators)');

// ============================================================
// 8. Existing bounded behavior preserved (no regression).
// ============================================================
ok(/maxConcurrentJobs: intEnv\('MEDIA_WORKER_MAX_CONCURRENT_JOBS', 2, 1, 16\)/.test(read('apps/media-worker/src/config.ts')), '8a. maxConcurrentJobs bounded [1, 16] (default 2) — preserved');
ok(/maxQueueDepth: intEnv\('MEDIA_WORKER_MAX_QUEUE_DEPTH', 4, 0, 32\)/.test(read('apps/media-worker/src/config.ts')), '8b. maxQueueDepth bounded [0, 32] (default 4) — preserved');
ok(/maxJobOutputBytes: intEnv\('MEDIA_WORKER_MAX_OUTPUT_MB', 4096, 64, 1024 \* 1024\) \* 1024 \* 1024/.test(read('apps/media-worker/src/config.ts')), '8c. maxJobOutputBytes bounded (default 4 GiB) — preserved');
ok(/maxInputDurationSeconds: floatEnv\('MEDIA_WORKER_MAX_INPUT_HOURS', 6, 0\.25, 24\) \* 3600/.test(read('apps/media-worker/src/config.ts')), '8d. maxInputDurationSeconds bounded [0.25h, 24h] (default 6h) — preserved');
ok(/jobTtlSeconds: intEnv\('MEDIA_WORKER_JOB_TTL_SECONDS', 3 \* 3600, 600, 24 \* 3600\)/.test(read('apps/media-worker/src/config.ts')), '8e. jobTtlSeconds bounded [10min, 24h] (default 3h) — preserved');
ok(/minFreeDiskBytes: intEnv\('MEDIA_WORKER_MIN_FREE_GB', 2, 0, 1024\) \* 1024 \* 1024 \* 1024/.test(read('apps/media-worker/src/config.ts')), '8f. minFreeDiskBytes bounded (default 2 GiB) — preserved');

// ============================================================
// 9. Existing ffmpeg lifecycle + cleanup preserved (no regression).
// ============================================================
ok(/SIGKILL/.test(read('apps/media-worker/src/ffmpeg.ts')), '9a. ffmpeg SIGKILL on timeout preserved');
ok(/OUTPUT_LIMIT/.test(read('apps/media-worker/src/ffmpeg.ts')), '9b. ffmpeg output budget check preserved');
ok(/failed-job output cleanup/.test(jobsSrc), '9c. prompt failed-job cleanup preserved (Phase 1 MW-3)');
ok(/Orphaned directories/.test(jobsSrc), '9d. orphaned directory cleanup preserved');
ok(/free-disk gate/.test(jobsSrc) || /minFreeDiskBytes/.test(jobsSrc), '9e. free-disk gate preserved');

// ============================================================
// 10. The config secret is REQUIRED (fail closed) — preserved.
// ============================================================
ok(/MAVERO_COMPAT_SESSION_SECRET \(or MAVERO_STREMIO_SESSION_SECRET\) is required — refusing to start \(fail closed\)/.test(read('apps/media-worker/src/config.ts')), '10a. secret required (fail closed) — preserved');

console.log(`phase3_media_worker_hardening_test: ${passed} checks passed (Phase 3-G media-worker hardening)`);
