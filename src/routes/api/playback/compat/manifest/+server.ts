import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { readJsonBody } from '$lib/server/http/body';
import { verifyCompatToken } from '$lib/server/streaming/stremio/session-tokens';
import { compatSessionSecret, mediaWorkerBaseUrl } from '$lib/server/streaming/stremio/session-env';
import { validatePlaybackUrl } from '$lib/server/resolver/safe-url';

/**
 * MAVERO Player — compatibility gateway (Phase 10, GOALS 12–15).
 *
 * Hands a browser-compatible HLS session for streams whose codecs/container
 * the browser cannot play directly (MKV remux, HEVC transcode). The gateway
 * is STRUCTURALLY unable to become an open media proxy:
 *
 *   * the ONLY input is a signed compatibility reference minted by the
 *     addon resolution endpoint — the source URL travels INSIDE the token,
 *     so no client-supplied URL is ever accepted (GOAL 12/24);
 *   * the URL inside the token was already validated through the playback
 *     boundary at resolution time, and is re-validated here (defense in
 *     depth — HTTPS-only, credential-free, non-private host);
 *   * the gateway performs NO outbound fetch itself. It either forwards the
 *     signed job to the configured dedicated media worker
 *     (`MAVERO_MEDIA_WORKER_URL` — a separate FFmpeg service, see
 *     docs/compat-worker.md) or returns the typed COMPAT_UNAVAILABLE
 *     degradation. A Netlify serverless function is deliberately NOT used
 *     as a transcoder (GOAL 16).
 *
 * Responses:
 *   200 `{ ok: true, playback: { kind: 'hls', url } }` — worker-backed HLS
 *       session URL (worker-signed, expiring).
 *   503 COMPAT_UNAVAILABLE — no worker configured (or the worker is
 *       unreachable): the stream fails gracefully, all other streams stay
 *       available.
 *   400 SESSION_EXPIRED / INVALID_REQUEST — expired, tampered or mismatched
 *       reference.
 */
const NO_STORE = { 'cache-control': 'no-store' } as const;

type CompatRequestBody = { token?: unknown };

export const POST: RequestHandler = async ({ request, fetch }) => {
  const parsed = await readJsonBody<CompatRequestBody>(request);
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

  const payload = verification.payload;
  // Defense in depth: re-run the playback boundary on the token-carried URL.
  // A reference can only ever exist for a URL that already passed this check
  // at resolution time.
  try {
    validatePlaybackUrl(payload.u, 'direct');
  } catch {
    return json({ ok: false, error: { code: 'INVALID_REQUEST', message: 'The compatibility request is invalid.' } }, { status: 400, headers: NO_STORE });
  }

  const worker = mediaWorkerBaseUrl();
  if (!worker) {
    // Honest degradation (GOAL 16): never fake a transcode in a serverless
    // request. Direct playback of every other stream remains available.
    return json(
      { ok: false, error: { code: 'COMPAT_UNAVAILABLE', message: 'This stream needs conversion that is not available yet. Try another stream.' } },
      { status: 503, headers: NO_STORE },
    );
  }

  try {
    // Forward the SIGNED job — the worker independently verifies the token
    // with the shared secret (docs/compat-worker.md). Nothing client-
    // supplied is forwarded except the token itself.
    //
    // Phase 11 (GOAL B7): the worker answers as soon as the conversion job
    // is accepted and, when it can within its bounded wait, once the first
    // HLS segment is playable. `ready:false` means the job is still
    // encoding — the client keeps polling the status endpoint
    // (`/api/playback/compat/status`) with the SAME token; the playback URL
    // is stable and expires with the job either way.
    const workerResponse = await fetch(`${worker}/api/v1/compat/manifest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: parsed.value?.token }),
      // 9.5s — bounded BELOW the default 10s serverless function cap; the
      // worker's bounded first-segment wait (default 8s) fits inside it, and
      // anything longer is handled by the ready:false + status polling flow.
      signal: AbortSignal.timeout(9_500),
    });
    const workerPayload = (await workerResponse.json().catch(() => null)) as { ok?: boolean; playback?: { kind?: unknown; url?: unknown; expiresAt?: unknown; ready?: unknown }; error?: { code?: string; message?: string } } | null;
    if (!workerResponse.ok || !workerPayload?.ok || workerPayload.playback?.kind !== 'hls' || typeof workerPayload.playback?.url !== 'string' || !workerPayload.playback.url.startsWith('https://')) {
      return json(
        { ok: false, error: { code: 'COMPAT_UNAVAILABLE', message: 'This stream could not be converted right now. Try another stream.' } },
        { status: 503, headers: NO_STORE },
      );
    }
    const ready = workerPayload.playback.ready !== false;
    return json(
      {
        ok: true,
        playback: {
          kind: 'hls',
          url: workerPayload.playback.url,
          ...(typeof workerPayload.playback.expiresAt === 'string' ? { expiresAt: workerPayload.playback.expiresAt } : {}),
          ready,
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
