import type { PlayerQualityOption } from '$lib/shared/player';
import { classifyStreamCompatibility, compatibilityBadgeText, type MediaCompatibilityTier } from '$lib/shared/media-compat';

/**
 * MAVERO Player — compatibility client (Phase 10 GOALS 12–15, Phase 11
 * GOAL B7 — REAL conversion sessions).
 *
 * The client half of the controlled compatibility path. When the user picks
 * a stream the runtime layer (`media-capabilities.ts` + the shared
 * classifier) routes to remux/transcode, the player:
 *
 *   1. shows "Preparing stream…" (the direct URL is NOT played — it would
 *      fail in the browser), but direct playback stays available for every
 *      other stream;
 *   2. requests `POST /api/playback/compat/manifest` with the SIGNED
 *      reference that arrived WITH the stream (the client never submits a
 *      URL — the endpoint is structurally unable to act as an open proxy);
 *   3. when the session is not immediately ready (a transcode is still
 *      producing its first HLS segments) it POLLS the status endpoint with
 *      the SAME signed reference — bounded by a generous per-kind deadline;
 *   4. on success, plays the returned worker-backed streaming session URL
 *      through MAVERO's native player (HLS → Video.js HlsJsVideo);
 *   5. on degradation (no worker configured / conversion failure / expired
 *      reference / deadline exceeded), fails gracefully into the existing
 *      per-stream error state — every other stream remains selectable
 *      (GOAL 8 semantics).
 *
 * Client-only module: no top-level browser globals, no SSR side effects.
 */

/** Result of one compatibility session request. */
export type MaveroCompatResult =
  | { ok: true; kind: 'remux' | 'transcode'; workerUrl: string }
  | { ok: false; code: 'COMPAT_UNAVAILABLE' | 'SESSION_EXPIRED' | 'INVALID_REQUEST' | 'NETWORK'; message: string };

export const COMPAT_PREPARING_MESSAGE = 'Preparing stream…';
export const COMPAT_UNAVAILABLE_MESSAGE = 'This stream needs conversion that is not available yet. Try another stream.';
export const COMPAT_EXPIRED_MESSAGE = 'This compatibility session expired. Choose the stream again.';

/** Poll cadence + generous bounded deadlines (GOAL B7 — never infinite). */
export const COMPAT_POLL_INTERVAL_MS = 2_500;
export const COMPAT_REMUX_READY_TIMEOUT_MS = 150_000;
export const COMPAT_TRANSCODE_READY_TIMEOUT_MS = 540_000;

/** Structural payload of the compat endpoints (untrusted — narrowed below). */
type CompatPayload = { ok?: boolean; playback?: { kind?: unknown; url?: unknown; ready?: unknown }; error?: { code?: unknown; message?: unknown } };
type CompatStatusPayload = { ok?: boolean; status?: { ready?: unknown; phase?: unknown; progress?: unknown; playback?: { kind?: unknown; url?: unknown } }; error?: { code?: unknown; message?: unknown } };

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Extracts the playable HLS URL from BOTH payload shapes the endpoints
 * produce (Phase 12, GOAL 6):
 *   * top-level `payload.playback` (the manifest response), and
 *   * nested `payload.status.playback` (the polling status response).
 * The historical implementation read ONLY the top-level shape, so a status
 * response carrying the ready URL in its nested `status.playback` object
 * lost the URL and the client kept polling despite `ready: true`.
 * Requires `kind === 'hls'` and an https URL — a worker session URL is
 * always https (the worker's `publicBaseUrl` is validated at boot).
 */
function playbackUrlOf(payload: unknown): string | null {
  if (!isRecord(payload)) return null;
  const candidates: unknown[] = [payload.playback];
  if (isRecord(payload.status)) candidates.push(payload.status.playback);
  for (const candidate of candidates) {
    if (!isRecord(candidate)) continue;
    if (candidate.kind !== 'hls' || typeof candidate.url !== 'string' || !candidate.url.startsWith('https://')) continue;
    return candidate.url;
  }
  return null;
}

/**
 * True when the payload reports a TERMINAL failed session — either a typed
 * error envelope (the status gateway now maps a worker-reported conversion
 * failure to `CONVERSION_FAILED`) or a status object whose phase/status
 * says failed. Polling stops on the FIRST terminal answer.
 */
function isTerminalFailure(payload: unknown): boolean {
  if (!isRecord(payload)) return false;
  if (isRecord(payload.error)) {
    const code = payload.error.code;
    if (code === 'CONVERSION_FAILED' || code === 'COMPAT_UNAVAILABLE' || code === 'SESSION_EXPIRED') return true;
  }
  if (isRecord(payload.status)) {
    const status = payload.status;
    if (status.phase === 'failed' || status.status === 'failed') return true;
  }
  return false;
}

/**
 * Requests a compatible HLS session for a stream's signed reference and
 * waits (bounded polling) until the session is playable. Returns a typed
 * result — NEVER throws, never exposes internals.
 */
export async function requestMaveroCompatStream(token: string, kind: 'remux' | 'transcode', deps: { fetcher?: typeof fetch; pollIntervalMs?: number; timeoutMs?: number; signal?: AbortSignal } = {}): Promise<MaveroCompatResult> {
  const fetcher = deps.fetcher ?? fetch;
  const pollIntervalMs = deps.pollIntervalMs ?? COMPAT_POLL_INTERVAL_MS;
  const timeoutMs = deps.timeoutMs ?? (kind === 'remux' ? COMPAT_REMUX_READY_TIMEOUT_MS : COMPAT_TRANSCODE_READY_TIMEOUT_MS);
  const startedAt = Date.now();

  let payload: CompatPayload | null = null;
  try {
    const response = await fetcher('/api/playback/compat/manifest', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
      ...(deps.signal ? { signal: deps.signal } : {}),
    });
    payload = (await response.json().catch(() => null)) as CompatPayload | null;
  } catch {
    return { ok: false, code: 'NETWORK', message: COMPAT_UNAVAILABLE_MESSAGE };
  }
  if (payload?.ok === true && payload.error) {
    // Typed server-side rejection surfaced before any playback URL existed.
    const code = typeof payload.error.code === 'string' ? payload.error.code : 'COMPAT_UNAVAILABLE';
    if (code === 'SESSION_EXPIRED') return { ok: false, code: 'SESSION_EXPIRED', message: COMPAT_EXPIRED_MESSAGE };
    return { ok: false, code: 'COMPAT_UNAVAILABLE', message: COMPAT_UNAVAILABLE_MESSAGE };
  }

  const immediateUrl = payload?.ok === true && payload.playback?.ready !== false ? playbackUrlOf(payload) : null;
  if (immediateUrl) return { ok: true, kind, workerUrl: immediateUrl };
  if (payload && payload.ok !== true) {
    const code = isRecord(payload.error) && typeof payload.error.code === 'string' ? payload.error.code : 'COMPAT_UNAVAILABLE';
    if (code === 'SESSION_EXPIRED') return { ok: false, code: 'SESSION_EXPIRED', message: COMPAT_EXPIRED_MESSAGE };
    return { ok: false, code: 'COMPAT_UNAVAILABLE', message: COMPAT_UNAVAILABLE_MESSAGE };
  }

  // The session exists but is still encoding — poll the status endpoint
  // with the SAME signed reference until ready or deadline (GOAL B7).
  // Phase 12 (GOAL 6): the ready URL is re-read from EVERY status payload
  // (top-level OR nested `status.playback`) — the first terminal answer
  // (ready or failed) stops the loop; a single failed poll never aborts.
  const readyUrl = payload?.ok === true ? playbackUrlOf(payload) : null;
  while (Date.now() - startedAt < timeoutMs) {
    await delay(pollIntervalMs, deps.signal);
    if (deps.signal?.aborted) return { ok: false, code: 'NETWORK', message: COMPAT_UNAVAILABLE_MESSAGE };
    try {
      const statusResponse = await fetcher('/api/playback/compat/status', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token }),
        ...(deps.signal ? { signal: deps.signal } : {}),
      });
      const statusPayload = (await statusResponse.json().catch(() => null)) as CompatStatusPayload | null;
      if (!statusPayload) continue; // malformed poll answer — keep waiting
      if (statusPayload.ok !== true) {
        // Typed rejection: SESSION_EXPIRED / CONVERSION_FAILED /
        // COMPAT_UNAVAILABLE are all terminal — stop polling.
        const code = isRecord(statusPayload.error) && typeof statusPayload.error.code === 'string' ? statusPayload.error.code : 'COMPAT_UNAVAILABLE';
        if (code === 'SESSION_EXPIRED') return { ok: false, code: 'SESSION_EXPIRED', message: COMPAT_EXPIRED_MESSAGE };
        return { ok: false, code: 'COMPAT_UNAVAILABLE', message: COMPAT_UNAVAILABLE_MESSAGE };
      }
      const urlNow = readyUrl ?? playbackUrlOf(statusPayload);
      const readyNow = isRecord(statusPayload.status) && statusPayload.status.ready === true;
      if (readyNow && urlNow) return { ok: true, kind, workerUrl: urlNow };
      if (isTerminalFailure(statusPayload)) return { ok: false, code: 'COMPAT_UNAVAILABLE', message: COMPAT_UNAVAILABLE_MESSAGE };
    } catch {
      // A single failed poll must never abort the wait — keep polling.
    }
  }
  return { ok: false, code: 'COMPAT_UNAVAILABLE', message: 'This stream is taking too long to prepare. Try again or choose another stream.' };
}

/**
 * The compatibility badge for one stream card (GOAL 11 presentation):
 * derived ONLY from addon-supplied metadata through the shared classifier.
 * Phase 12 (GOAL B): ALL supplied text fields feed the classifier — an
 * extensionless URL whose title/name/description carries ".mkv" or
 * "HEVC"/"10-bit" must badge exactly like the filename-equivalent.
 * `null` renders nothing; badges are never fabricated.
 */
export function compatBadgeForStream(stream: PlayerQualityOption): string | null {
  const verdict = classifyStreamCompatibility({
    protocol: stream.protocol,
    container: stream.container,
    codec: stream.codec,
    filename: stream.filename,
    title: stream.title,
    description: stream.description,
  });
  return compatibilityBadgeText(verdict.tier);
}

/** Exposed for tests + the shell (tier lookup mirrors the badge logic). */
export function compatTierForStream(stream: PlayerQualityOption): MediaCompatibilityTier {
  return classifyStreamCompatibility({
    protocol: stream.protocol,
    container: stream.container,
    codec: stream.codec,
    filename: stream.filename,
    title: stream.title,
    description: stream.description,
  }).tier;
}
