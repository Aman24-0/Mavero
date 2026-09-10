import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { readJsonBody } from '$lib/server/http/body';
import { createSupabaseAdminClient } from '$lib/server/supabase/admin';
import { parseStremioPlaybackRequest } from '$lib/server/streaming/stremio/mavero-player-source';
import { resolveAddonToken } from '$lib/server/streaming/stremio/addon-session';
import { compatSessionSecret, stremioSessionSecret } from '$lib/server/streaming/stremio/session-env';
import { asStreamServiceError } from '$lib/server/streaming/stremio/stream-errors';

/**
 * MAVERO Player — per-addon resolution endpoint (Phase 10, GOALS 1–6).
 *
 * ONE independent request per addon token. The client fires these in
 * parallel and merges results as they arrive — a slow or failed addon can
 * never delay or break another one (GOAL 2/6/8).
 *
 * Contract:
 *   * POST + JSON body: `{ sessionId, token }` ONLY — the token is the
 *     opaque signed authorization minted by the session endpoint; the
 *     client supplies NO addon id, NO URL, NO configuration.
 *   * The content context (contentId/mediaType/season/episode) rides the
 *     SAME strict validation as every other MAVERO playback request and is
 *     cross-checked against the token's signature (GOAL 5 stale binding).
 *   * Success: `{ ok: true, result: { status: 'ok', streams: [...] } }` —
 *     or `{ status: 'skipped' | 'failed' }` for per-addon outcomes that
 *     must NOT fail the session (GOAL 6/8 isolation).
 *   * Streams are already validated through the playback boundary, capped
 *     per addon, and carry rich addon-supplied metadata (Phase 9 model) —
 *     never manifest URLs, raw addon responses or internal diagnostics.
 *   * 400/503 responses are reserved for request-shape and infrastructure
 *     failures (expired/mismatched tokens → 400 with a session-expired
 *     code the client maps onto a fresh-session retry).
 */
const NO_STORE = { 'cache-control': 'no-store' } as const;

export const POST: RequestHandler = async ({ request }) => {
  const parsed = await readJsonBody<unknown>(request);
  if (!parsed.ok) {
    return json(
      { ok: false, error: { code: parsed.status === 413 ? 'PAYLOAD_TOO_LARGE' : 'INVALID_REQUEST', message: parsed.status === 413 ? parsed.message : 'The addon resolution request is invalid.' } },
      { status: parsed.status, headers: NO_STORE },
    );
  }

  const playbackRequest = parseStremioPlaybackRequest(parsed.value);
  if (!playbackRequest.ok) {
    return json({ ok: false, error: { code: 'INVALID_REQUEST', message: 'The addon resolution request is invalid.' } }, { status: 400, headers: NO_STORE });
  }

  const secret = stremioSessionSecret();
  if (!secret) {
    console.warn('[MaveroAddon] session secret is not configured');
    return json({ ok: false, error: { code: 'SESSION_UNAVAILABLE', message: 'MAVERO Player could not resolve addons right now.' } }, { status: 503, headers: NO_STORE });
  }

  const { mediaType, contentId, season, episode } = playbackRequest.request;
  try {
    const { result } = await resolveAddonToken(
      createSupabaseAdminClient(),
      parsed.value,
      { mediaType, contentId, ...(season !== undefined ? { season } : {}), ...(episode !== undefined ? { episode } : {}) },
      { secret, compatSecret: compatSessionSecret() },
    );
    return json({ ok: true, result }, { headers: NO_STORE });
  } catch (error) {
    const serviceError = asStreamServiceError(error);
    const invalid = serviceError.code === 'INVALID_REQUEST';
    console.warn('[MaveroAddon] addon resolution failed', { code: invalid ? serviceError.code : 'RESOLUTION_UNAVAILABLE' });
    return json(
      { ok: false, error: { code: invalid ? 'SESSION_EXPIRED' : 'RESOLUTION_UNAVAILABLE', message: serviceError.message } },
      { status: invalid ? 400 : 503, headers: NO_STORE },
    );
  }
};
