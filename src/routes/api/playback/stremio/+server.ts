import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { readJsonBody } from '$lib/server/http/body';
import { getDetail } from '$lib/server/content/service';
import { createSupabaseAdminClient } from '$lib/server/supabase/admin';
import { normalizeContentIdentifiers } from '$lib/server/resolver/identifiers';
import type { ResolverRequest } from '$lib/server/resolver/types';
import { resolveStremioStreams } from '$lib/server/streaming/stremio/stream-resolver';
import { asStreamServiceError } from '$lib/server/streaming/stremio/stream-errors';
import { maveroPlayerSourceFromResolution, parseStremioPlaybackRequest } from '$lib/server/streaming/stremio/mavero-player-source';
import { MAVERO_PLAYER_SOURCE_ID } from '$lib/shared/mavero-player';

/**
 * MAVERO Player — Stremio playback resolution endpoint (Phase 4).
 *
 * The additive server branch behind the virtual "MAVERO Player" source:
 *
 *   MAVERO Player → POST /api/playback/stremio → Phase 3
 *   `resolveStremioStreams()` (enabled addons loaded from the DATABASE by
 *   the server itself) → normalized HTTP/HLS sources → the Phase 3
 *   PlayerSource adapter → ONE aggregate PlayerSource → the existing
 *   PlaybackManager `direct` path.
 *
 * Contract (mirrors `/api/playback/resolve` conventions):
 *   * POST + JSON body; the client supplies ONLY content identifiers
 *     (contentId, mediaType, season, episode) — never addon ids or manifest
 *     URLs. All addon configuration is loaded server-side from
 *     `streaming_addons` (service-role client — the table has no anon read
 *     by design).
 *   * Identifiers are normalized by the EXISTING content pipeline
 *     (`getDetail` + `normalizeContentIdentifiers`) — no duplicated id
 *     logic; anime uses the existing anime→series Stremio mapping.
 *   * Success: `{ ok: true, source: PlayerSource | null }` — `null` means
 *     no playable addon streams (graceful, never an error that could
 *     disturb the existing provider sources).
 *   * Per-addon failures never fail the request (Phase 3 isolation); only
 *     invalid requests (400) or resolution-infrastructure failures (503)
 *     return errors.
 *   * The response contains ONLY safe normalized PlayerSource data —
 *     never manifest URLs, raw addon responses, per-addon failure detail,
 *     proxy header values or torrent metadata. No stream caching (URLs
 *     expire).
 *   * The existing `/api/playback/resolve` endpoint and provider resolver
 *     are untouched — this route is a separate branch.
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

  const { mediaType, contentId, season, episode } = playbackRequest.request;

  let contentTitle: string | undefined;
  let identifiers: ReturnType<typeof normalizeContentIdentifiers>;
  try {
    const content = await getDetail(mediaType, contentId);
    contentTitle = content.title;
    // The virtual source request uses the stable virtual id as its
    // `sourceId` marker; identifier normalization only reads `contentId`.
    const resolverRequest: ResolverRequest = { sourceId: MAVERO_PLAYER_SOURCE_ID, contentId, mediaType };
    identifiers = normalizeContentIdentifiers(content, resolverRequest);
  } catch {
    return json({ ok: false, error: { code: 'CONTENT_UNAVAILABLE', message: 'This title could not be loaded for playback.' } }, { status: 502, headers: NO_STORE });
  }

  try {
    const resolution = await resolveStremioStreams(createSupabaseAdminClient(), {
      mediaType,
      identifiers: { imdbId: identifiers.imdbId, tmdbId: identifiers.tmdbId },
      ...(season !== undefined ? { season } : {}),
      ...(episode !== undefined ? { episode } : {}),
    });
    const source = maveroPlayerSourceFromResolution(resolution, contentTitle);
    return json({ ok: true, source }, { headers: NO_STORE });
  } catch (error) {
    const serviceError = asStreamServiceError(error);
    const invalid = serviceError.code === 'INVALID_REQUEST';
    console.warn('[MaveroPlayer] Stremio resolution failed', { code: invalid ? serviceError.code : 'RESOLUTION_UNAVAILABLE' });
    return json(
      { ok: false, error: { code: invalid ? 'INVALID_REQUEST' : 'RESOLUTION_UNAVAILABLE', message: invalid ? 'The MAVERO Player request is invalid.' : 'MAVERO Player could not resolve streams right now.' } },
      { status: invalid ? 400 : 503, headers: NO_STORE },
    );
  }
};
