import type { PlayerQualityOption } from '$lib/shared/player';
import { classifyStreamCompatibility, compatibilityBadgeText, type MediaCompatibilityTier } from '$lib/shared/media-compat';

/**
 * MAVERO Player — compatibility client (Phase 10, GOALS 12–15).
 *
 * The client half of the controlled compatibility path. When the user picks
 * a stream the runtime layer (`media-capabilities.ts` + the shared
 * classifier) routes to remux/transcode, the player:
 *
 *   1. shows "Preparing compatible stream…" (the direct URL is NOT played —
 *      it would fail in the browser), but direct playback stays available
 *      for every other stream;
 *   2. requests `POST /api/playback/compat/manifest` with the SIGNED
 *      reference that arrived WITH the stream (the client never submits a
 *      URL — the endpoint is structurally unable to act as an open proxy);
 *   3. on success, plays the returned worker-backed streaming session URL;
 *   4. on degradation (no worker configured / worker failure / expired
 *      reference), fails gracefully into the existing per-stream error
 *      state — every other stream remains selectable (GOAL 8 semantics).
 *
 * Client-only module: no top-level browser globals, no SSR side effects.
 */

/** Result of one compatibility session request. */
export type MaveroCompatResult =
  | { ok: true; kind: 'remux' | 'transcode'; workerUrl: string }
  | { ok: false; code: 'COMPAT_UNAVAILABLE' | 'SESSION_EXPIRED' | 'INVALID_REQUEST' | 'NETWORK'; message: string };

export const COMPAT_PREPARING_MESSAGE = 'Preparing compatible stream…';
export const COMPAT_UNAVAILABLE_MESSAGE = 'This stream needs conversion that is not available yet. Try another stream.';
export const COMPAT_EXPIRED_MESSAGE = 'This compatibility session expired. Choose the stream again.';

/** Structural payload of the compat endpoint (untrusted — narrowed below). */
type CompatPayload = { ok?: boolean; playback?: { kind?: unknown; url?: unknown }; error?: { code?: unknown; message?: unknown } };

/**
 * Requests a compatible HLS session for a stream's signed reference.
 * Returns a typed result — NEVER throws, never exposes internals.
 */
export async function requestMaveroCompatStream(token: string, kind: 'remux' | 'transcode', deps: { fetcher?: typeof fetch } = {}): Promise<MaveroCompatResult> {
  const fetcher = deps.fetcher ?? fetch;
  let payload: CompatPayload | null = null;
  let status = 0;
  try {
    const response = await fetcher('/api/playback/compat/manifest', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    status = response.status;
    payload = (await response.json().catch(() => null)) as CompatPayload | null;
  } catch {
    return { ok: false, code: 'NETWORK', message: COMPAT_UNAVAILABLE_MESSAGE };
  }
  if (payload?.ok === true && payload.playback?.kind === 'hls' && typeof payload.playback.url === 'string' && payload.playback.url.startsWith('https://')) {
    return { ok: true, kind, workerUrl: payload.playback.url };
  }
  const code = typeof payload?.error?.code === 'string' ? payload.error.code : 'COMPAT_UNAVAILABLE';
  if (code === 'SESSION_EXPIRED') return { ok: false, code: 'SESSION_EXPIRED', message: COMPAT_EXPIRED_MESSAGE };
  return { ok: false, code: 'COMPAT_UNAVAILABLE', message: COMPAT_UNAVAILABLE_MESSAGE };
}

/**
 * The compatibility badge for one stream card (GOAL 11 presentation):
 * derived ONLY from addon-supplied metadata through the shared classifier.
 * `null` when the stream needs no badge — badges are never fabricated.
 */
export function compatBadgeForStream(stream: PlayerQualityOption): string | null {
  const verdict = classifyStreamCompatibility({
    protocol: stream.protocol,
    container: stream.container,
    codec: stream.codec,
    filename: stream.filename,
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
  }).tier;
}
