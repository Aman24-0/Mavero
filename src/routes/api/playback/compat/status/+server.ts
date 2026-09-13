import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { readJsonBody } from '$lib/server/http/body';
import { verifyCompatToken } from '$lib/server/streaming/stremio/session-tokens';
import { compatSessionSecret, mediaWorkerBaseUrl } from '$lib/server/streaming/stremio/session-env';

/**
 * MAVERO Player — compatibility session STATUS gateway (Phase 11, GOAL B7).
 *
 * The polling twin of `/api/playback/compat/manifest`. When the media
 * worker answers the first request with `ready:false` (a transcode is
 * still producing its first segments), the client polls THIS endpoint with
 * the SAME signed reference until the session reports `ready` (or a typed
 * failure). The worker URL never reaches the browser through this route —
 * only the conversion progress and the already-relayed playback session
 * data do.
 *
 * Responses:
 *   200 `{ ok: true, status: { ready, phase, progress, playback? } }`
 *   400 SESSION_EXPIRED / INVALID_REQUEST — expired, tampered reference
 *   503 COMPAT_UNAVAILABLE — no worker configured / worker unreachable
 */
const NO_STORE = { 'cache-control': 'no-store' } as const;

type CompatStatusRequestBody = { token?: unknown };

export const POST: RequestHandler = async ({ request, fetch }) => {
  const parsed = await readJsonBody<CompatStatusRequestBody>(request);
  if (!parsed.ok) {
    return json(
      { ok: false, error: { code: parsed.status === 413 ? 'PAYLOAD_TOO_LARGE' : 'INVALID_REQUEST', message: parsed.status === 413 ? parsed.message : 'The compatibility request is invalid.' } },
      { status: parsed.status, headers: NO_STORE },
    );
  }

  const secret = compatSessionSecret();
  const verification = verifyCompatToken(parsed.value?.token, secret);
  if (!verification.ok) {
    const expired = verification.reason === 'expired';
    return json(
      { ok: false, error: { code: expired ? 'SESSION_EXPIRED' : 'INVALID_REQUEST', message: expired ? 'This compatibility session expired. Choose the stream again.' : 'The compatibility request is invalid.' } },
      { status: 400, headers: NO_STORE },
    );
  }

  const worker = mediaWorkerBaseUrl();
  if (!worker) {
    return json(
      { ok: false, error: { code: 'COMPAT_UNAVAILABLE', message: 'This stream needs conversion that is not available yet. Try another stream.' } },
      { status: 503, headers: NO_STORE },
    );
  }

  try {
    const workerResponse = await fetch(`${worker}/api/v1/compat/status?token=${encodeURIComponent(parsed.value?.token as string)}`, {
      method: 'GET',
      signal: AbortSignal.timeout(10_000),
    });
    const workerPayload = (await workerResponse.json().catch(() => null)) as { ok?: boolean; status?: { ready?: unknown; status?: unknown; phase?: unknown; progress?: unknown; playback?: { kind?: unknown; url?: unknown; expiresAt?: unknown } }; error?: { code?: string; message?: string } } | null;
    if (!workerResponse.ok || !workerPayload?.ok || !workerPayload.status) {
      return json(
        { ok: false, error: { code: 'COMPAT_UNAVAILABLE', message: 'This stream could not be converted right now. Try another stream.' } },
        { status: 503, headers: NO_STORE },
      );
    }
    const status = workerPayload.status;
    const playback = status.playback && status.playback.kind === 'hls' && typeof status.playback.url === 'string' && status.playback.url.startsWith('https://')
      ? { kind: 'hls' as const, url: status.playback.url, ...(typeof status.playback.expiresAt === 'string' ? { expiresAt: status.playback.expiresAt } : {}), ready: true }
      : undefined;
    // Phase 12 (GOAL 6): a worker-reported CONVERSION FAILURE passes through
    // as a typed error so the client can STOP polling immediately instead of
    // burning its whole bounded deadline on a job that already failed.
    const failed = status.phase === 'failed' || status.status === 'failed';
    if (failed && !playback) {
      return json(
        { ok: false, error: { code: 'CONVERSION_FAILED', message: 'This stream could not be converted right now. Try another stream.' } },
        { headers: NO_STORE },
      );
    }
    return json(
      {
        ok: true,
        status: {
          ready: status.ready === true,
          ...(typeof status.status === 'string' ? { status: status.status } : {}),
          ...(typeof status.phase === 'string' ? { phase: status.phase } : {}),
          ...(typeof status.progress === 'number' && Number.isFinite(status.progress) ? { progress: status.progress } : {}),
          ...(playback ? { playback } : {}),
        },
      },
      { headers: NO_STORE },
    );
  } catch {
    return json(
      { ok: false, error: { code: 'COMPAT_UNAVAILABLE', message: 'This stream could not be converted right now. Try another stream.' } },
      { status: 503, headers: NO_STORE },
    );
  }
};
