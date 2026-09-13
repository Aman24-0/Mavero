/**
 * MAVERO media worker — HTTP server (Phase 11, GOAL B5/B6).
 *
 * THREE endpoints — nothing else. The worker is NOT a proxy and has NO
 * generic fetch/route surface:
 *
 *   GET  /health                       liveness + capacity (no secrets).
 *   POST /api/v1/compat/manifest      accepts ONLY { token } — a signed
 *                                      compatibility reference minted by
 *                                      the MAVERO app. Verifies it, starts
 *                                      the conversion and answers with the
 *                                      expiring HLS session URL once the
 *                                      first segment is playable (or
 *                                      ready:false if still encoding).
 *   GET  /api/v1/compat/status        polling twin of the above (same
 *                                      token) — { ready, phase, progress }.
 *   GET  /hls/:jobId/:file             serves the job's playlist/segments
 *                                      while the job is alive. The jobId is
 *                                      an unguessable UUID; expired jobs
 *                                      answer 410 and their files are
 *                                      deleted by the sweeper.
 *
 * STRUCTURAL SECURITY:
 *   * POST body is size-capped and must be JSON `{ token }` — a URL sent
 *     by a client is NEVER read (there is no field for it);
 *   * no arbitrary header forwarding anywhere (the token has no headers);
 *   * /hls/ paths are validated against a strict filename allowlist and
 *     resolved inside the job directory (no traversal);
 *   * CORS on /hls/ is open BY DESIGN (the player fetches media directly),
 *     but the URLs are unguessable and expire with the job.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { basename, join, resolve, sep } from 'node:path';
import { assertConfigUsable, loadConfig, type WorkerConfig } from './config.js';
import { verifyCompatToken } from './tokens.js';
import { JobRegistry, type Job } from './jobs.js';
import { runFfmpeg } from './ffmpeg.js';
import { logger } from './logger.js';

const MAX_BODY_BYTES = 16 * 1024;
const JOB_TIMEOUT_MS = 4 * 3600 * 1000; // hard wall-clock cap per ffmpeg run

const SEGMENT_CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.ts': 'video/mp2t',
  '.m4s': 'video/iso.segment',
  '.mp4': 'video/mp4',
  '.init': 'video/mp4',
};

const SEGMENT_NAME_PATTERN = /^(playlist\.m3u8|seg-\d+\.ts|seg-\d+\.m4s|init\.mp4)$/;

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  response.end(body);
}

function readJsonBody(request: IncomingMessage): Promise<{ ok: true; value: unknown } | { ok: false; code: 'PAYLOAD_TOO_LARGE' | 'INVALID_JSON' }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let done = false;
    const finish = (result: { ok: true; value: unknown } | { ok: false; code: 'PAYLOAD_TOO_LARGE' | 'INVALID_JSON' }) => {
      if (done) return;
      done = true;
      resolve(result);
    };
    request.on('data', (chunk: Buffer) => {
      total += chunk.byteLength;
      if (total > MAX_BODY_BYTES) {
        finish({ ok: false, code: 'PAYLOAD_TOO_LARGE' });
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      try {
        finish({ ok: true, value: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
      } catch {
        finish({ ok: false, code: 'INVALID_JSON' });
      }
    });
    request.on('error', () => finish({ ok: false, code: 'INVALID_JSON' }));
  });
}

function jobPayloadOf(job: Job, config: WorkerConfig): { kind: 'hls'; url: string; expiresAt: string; ready: boolean } {
  return {
    kind: 'hls',
    url: `${config.publicBaseUrl}/hls/${job.id}/playlist.m3u8`,
    expiresAt: new Date(job.expiresAt).toISOString(),
    ready: job.status === 'ready',
  };
}

/**
 * Phase 12 (GOAL I): the required lifecycle vocabulary the status endpoint
 * reports — `queued` → `processing` → `ready` → `completed` (or `ended`
 * when FFmpeg failed after playback was already possible) / `failed`.
 * `ready` and `completed`/`ended` all keep `playback.ready === true`.
 */
function lifecycleStatusOf(job: Job): 'queued' | 'processing' | 'ready' | 'completed' | 'ended' | 'failed' {
  if (job.status === 'queued' || job.status === 'preparing' || job.status === 'encoding') return job.status === 'queued' ? 'queued' : 'processing';
  if (job.status === 'failed') return 'failed';
  if (job.phase === 'completed') return 'completed';
  if (job.phase === 'ended') return 'ended';
  return 'ready';
}

export function createWorkerServer(config: WorkerConfig, registry: JobRegistry) {
  registry.registerEncoder((job, outDir) =>
    runFfmpeg({
      ffmpegPath: config.ffmpegPath,
      inputUrl: new URL(job.url),
      outDir,
      kind: job.kind,
      timeoutMs: JOB_TIMEOUT_MS,
      maxOutputBytes: config.maxJobOutputBytes,
      durationSeconds: job.inputDurationSeconds,
      maxDurationSeconds: config.maxInputDurationSeconds,
      onEvent: (event) => {
        if (event.type === 'progress') job.progressSeconds = event.seconds;
        if (event.type === 'failed') {
          // Phase 12 (GOAL I): routed through the registry's ready-aware
          // policy — a failure AFTER the job already became playable marks
          // the `ended` phase and keeps the produced segments served; only
          // a failure before the first playable segment fails the job.
          registry.reportEncoderFailure(job, event.code, event.message);
        }
      },
    }),
  );

  async function handleManifest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const parsed = await readJsonBody(request);
    if (!parsed.ok) {
      return sendJson(response, parsed.code === 'PAYLOAD_TOO_LARGE' ? 413 : 400, { ok: false, error: { code: 'INVALID_REQUEST', message: 'The compatibility request is invalid.' } });
    }
    const body = parsed.value as { token?: unknown } | null;
    const token = body && typeof body === 'object' ? body.token : undefined;
    const verification = verifyCompatToken(token, config.secret);
    if (!verification.ok) {
      const status = verification.reason === 'expired' ? 400 : 400;
      const code = verification.reason === 'expired' ? 'SESSION_EXPIRED' : 'INVALID_REQUEST';
      logger.warn('manifest rejected', { reason: verification.reason });
      return sendJson(response, status, { ok: false, error: { code, message: code === 'SESSION_EXPIRED' ? 'This compatibility session expired. Choose the stream again.' : 'The compatibility request is invalid.' } });
    }
    const payload = verification.payload;
    const outcome = await registry.submit(token as string, payload);
    if (outcome.outcome === 'rejected') {
      logger.warn('job rejected', { code: outcome.code });
      return sendJson(response, 400, { ok: false, error: { code: 'INVALID_REQUEST', message: 'The compatibility request is invalid.' } });
    }
    if (outcome.outcome === 'busy') {
      return sendJson(response, 503, { ok: false, error: { code: 'COMPAT_BUSY', message: 'Conversion capacity is busy right now. Try again shortly or choose another stream.' } });
    }
    const job = outcome.job;
    logger.info('job accepted', { jobId: job.id, kind: job.kind, outcome: outcome.outcome, addon: job.addonId.slice(0, 8) });

    // Bounded wait for first-segment readiness (streaming start — GOAL 15):
    // remux copy usually produces segments within seconds; transcode may
    // need longer, in which case ready:false + polling (status endpoint)
    // takes over.
    const deadline = Date.now() + config.readyWaitMs;
    let snapshot = registry.snapshot(job.id) ?? job;
    while (Date.now() < deadline) {
      snapshot = registry.snapshot(job.id) ?? snapshot;
      if (snapshot.status === 'ready' || snapshot.status === 'failed') break;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
    }
    snapshot = registry.snapshot(job.id) ?? snapshot;
    if (snapshot.status === 'failed') {
      return sendJson(response, 503, { ok: false, error: { code: 'CONVERSION_FAILED', message: 'This stream could not be converted right now. Try another stream.' } });
    }
    return sendJson(response, 200, { ok: true, playback: jobPayloadOf(snapshot, config) });
  }

  async function handleStatus(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    const token = url.searchParams.get('token');
    const verification = verifyCompatToken(token, config.secret);
    if (!verification.ok) {
      return sendJson(response, 400, { ok: false, error: { code: verification.reason === 'expired' ? 'SESSION_EXPIRED' : 'INVALID_REQUEST', message: 'The compatibility request is invalid.' } });
    }
    const job = registry.findByToken(token as string);
    if (!job) {
      return sendJson(response, 404, { ok: false, error: { code: 'NOT_FOUND', message: 'No conversion session exists for this reference.' } });
    }
    if (job.status === 'failed') {
      return sendJson(response, 200, { ok: true, status: { status: 'failed', ready: false, phase: 'failed', progress: null, error: 'CONVERSION_FAILED' } });
    }
    const lifecycle = lifecycleStatusOf(job);
    return sendJson(response, 200, {
      ok: true,
      status: {
        status: lifecycle,
        ready: job.status === 'ready',
        phase: job.phase,
        progress: job.inputDurationSeconds ? Math.min(0.99, job.progressSeconds / job.inputDurationSeconds) : null,
        playback: job.status === 'ready' ? jobPayloadOf(job, config) : undefined,
      },
    });
  }

  async function handleHls(response: ServerResponse, jobId: string, file: string): Promise<void> {
    // Strict name allowlist + containment (no traversal, no dotfiles).
    const cleanFile = basename(file);
    if (!SEGMENT_NAME_PATTERN.test(cleanFile)) {
      return sendJson(response, 404, { ok: false, error: { code: 'NOT_FOUND' } });
    }
    const job = registry.snapshot(jobId);
    if (!job) {
      return sendJson(response, 404, { ok: false, error: { code: 'NOT_FOUND' } });
    }
    if (job.expiresAt <= Date.now()) {
      return sendJson(response, 410, { ok: false, error: { code: 'SESSION_EXPIRED' } });
    }
    const dir = registry.dirFor(jobId);
    if (!dir) return sendJson(response, 404, { ok: false, error: { code: 'NOT_FOUND' } });
    const resolvedDir = resolve(dir);
    const filePath = resolve(join(dir, cleanFile));
    if (!filePath.startsWith(resolvedDir + sep)) return sendJson(response, 404, { ok: false, error: { code: 'NOT_FOUND' } });
    try {
      const info = await stat(filePath);
      if (!info.isFile()) throw new Error('not a file');
      const contentType = SEGMENT_CONTENT_TYPES[cleanFile.slice(cleanFile.lastIndexOf('.'))] ?? 'application/octet-stream';
      response.writeHead(200, {
        'content-type': contentType,
        'content-length': info.size,
        // Playlists must not be cached while the encode is in progress;
        // segments are immutable but the URLs expire anyway.
        'cache-control': cleanFile.endsWith('.m3u8') ? 'no-store' : 'private, max-age=3600',
        'access-control-allow-origin': '*',
      });
      createReadStream(filePath).pipe(response);
    } catch {
      // A segment ffmpeg has not written yet — tell hls.js to retry.
      response.writeHead(404, { 'access-control-allow-origin': '*' });
      response.end();
    }
  }

  const server = createServer((request, response) => {
    const started = Date.now();
    const url = new URL(request.url ?? '/', 'http://internal');
    const finishLog = () => {
      logger.info('request', { method: request.method, path: url.pathname, ms: Date.now() - started });
    };
    response.on('finish', finishLog);

    if (request.method === 'GET' && url.pathname === '/health') {
      return sendJson(response, 200, { ok: true, jobs: registry.counts(), uptimeSeconds: Math.floor(process.uptime()) });
    }
    if (request.method === 'POST' && url.pathname === '/api/v1/compat/manifest') {
      void handleManifest(request, response).catch(() => sendJson(response, 500, { ok: false, error: { code: 'INTERNAL', message: 'Unexpected worker error.' } }));
      return;
    }
    if (request.method === 'GET' && url.pathname === '/api/v1/compat/status') {
      void handleStatus(request, response, url).catch(() => sendJson(response, 500, { ok: false, error: { code: 'INTERNAL', message: 'Unexpected worker error.' } }));
      return;
    }
    const hlsMatch = /^\/hls\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)$/.exec(url.pathname);
    if (request.method === 'GET' && hlsMatch) {
      void handleHls(response, hlsMatch[1] as string, hlsMatch[2] as string).catch(() => response.destroy());
      return;
    }
    if (request.method === 'OPTIONS' && url.pathname.startsWith('/hls/')) {
      response.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-headers': 'range,origin',
        'access-control-allow-methods': 'GET',
      });
      return response.end();
    }
    sendJson(response, 404, { ok: false, error: { code: 'NOT_FOUND' } });
  });
  return server;
}

export function main(): void {
  const config = loadConfig();
  assertConfigUsable(config);
  const registry = new JobRegistry(config);
  const server = createWorkerServer(config, registry);
  registry.startSweeper();
  server.listen(config.port, () => {
    logger.info('media-worker listening', { port: config.port, publicBaseUrl: config.publicBaseUrl });
  });
  const shutdown = () => {
    logger.info('media-worker shutting down');
    registry.stopSweeper();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5_000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

// Boot only when executed directly (imported by tests without side effects).
if (process.argv[1] && (process.argv[1].endsWith('server.ts') || process.argv[1].endsWith('server.js'))) {
  main();
}
