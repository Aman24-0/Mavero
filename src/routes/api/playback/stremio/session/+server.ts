import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { readJsonBody } from '$lib/server/http/body';
import { createSupabaseAdminClient } from '$lib/server/supabase/admin';
import { parseStremioPlaybackRequest } from '$lib/server/streaming/stremio/mavero-player-source';
import { createAddonSession } from '$lib/server/streaming/stremio/addon-session';
import { createSessionId } from '$lib/server/streaming/stremio/session-tokens';
import { stremioSessionSecret } from '$lib/server/streaming/stremio/session-env';
import { asStreamServiceError } from '$lib/server/streaming/stremio/stream-errors';

/**
 * MAVERO Player — progressive resolution SESSION endpoint (Phase 10, GOAL 1).
 *
 *   PLAY → POST /api/playback/stremio/session
 *        → one short-lived signed token per ELIGIBLE addon (+ safe display
 *          metadata) → the client fires ONE INDEPENDENT request per token
 *          against /api/playback/stremio/addon.
 *
 * Contract:
 *   * POST + JSON body with ONLY content identifiers (identical validation
 *     to the aggregate endpoint — `parseStremioPlaybackRequest`).
 *   * The response NEVER contains manifest URLs, private addon
 *     configuration, proxy headers or raw addon responses — only opaque
 *     tokens, display names and ordering (GOAL 1).
 *   * Tokens are signed, short-lived, bound to (session, addon, content,
 *     mediaType, season/episode) and unusable for arbitrary addon selection.
 *   * Zero eligible addons → `{ ok: true, session.addons: [] }` — a graceful
 *     empty session, never an error.
 */
const NO_STORE = { 'cache-control': 'no-store' } as const;

export const POST: RequestHandler = async ({ request }) => {
  const parsed = await readJsonBody<unknown>(request);
  if (!parsed.ok) {
    return json(
      { ok: false, error: { code: parsed.status === 413 ? 'PAYLOAD_TOO_LARGE' : 'INVALID_REQUEST', message: parsed.status === 413 ? parsed.message : 'The MAVERO Player request is invalid.' } },
      { status: parsed.status, headers: NO_STORE },
    );
  }

  const playbackRequest = parseStremioPlaybackRequest(parsed.value);
  if (!playbackRequest.ok) {
    return json({ ok: false, error: { code: 'INVALID_REQUEST', message: 'The MAVERO Player request is invalid.' } }, { status: 400, headers: NO_STORE });
  }

  const secret = stremioSessionSecret();
  if (!secret) {
    // Fail closed: no session tokens can be minted. The client surfaces the
    // same graceful unavailable state as a failed session.
    console.warn('[MaveroPlayer] session secret is not configured');
    return json({ ok: false, error: { code: 'SESSION_UNAVAILABLE', message: 'MAVERO Player could not start a resolution session right now.' } }, { status: 503, headers: NO_STORE });
  }

  const { mediaType, contentId, season, episode } = playbackRequest.request;
  try {
    const session = await createAddonSession(createSupabaseAdminClient(), { mediaType, contentId, ...(season !== undefined ? { season } : {}), ...(episode !== undefined ? { episode } : {}) }, { secret, sessionId: createSessionId() });
    return json({ ok: true, session }, { headers: NO_STORE });
  } catch (error) {
    const serviceError = asStreamServiceError(error);
    const invalid = serviceError.code === 'INVALID_REQUEST';
    console.warn('[MaveroPlayer] session creation failed', { code: invalid ? serviceError.code : 'SESSION_UNAVAILABLE' });
    return json(
      { ok: false, error: { code: invalid ? 'INVALID_REQUEST' : 'SESSION_UNAVAILABLE', message: invalid ? 'The MAVERO Player request is invalid.' : 'MAVERO Player could not start a resolution session right now.' } },
      { status: invalid ? 400 : 503, headers: NO_STORE },
    );
  }
};
