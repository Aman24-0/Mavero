import type { PlayerSource } from '$lib/shared/player';
import { isPlayablePlayerSource } from '$lib/shared/player-guards';

/**
 * MAVERO Player — client resolution helper (Phase 4).
 *
 * Thin POST wrapper for the dedicated `/api/playback/stremio` endpoint.
 * The client supplies ONLY content identifiers; every piece of Stremio
 * configuration (manifest URLs, addon eligibility, ordering) stays
 * server-side. The response is validated through the EXISTING shared
 * `isPlayablePlayerSource` guard before it may reach the player — a
 * source that fails the guard (e.g. a non-HTTPS url) is reported as an
 * unavailable resolution, never loaded.
 */

export type MaveroPlayerRequest = {
  contentId: string;
  mediaType: 'movie' | 'series' | 'anime';
  season?: number;
  episode?: number;
};

export type MaveroPlayerResolution =
  | { ok: true; source: PlayerSource }
  | { ok: false; code: string; message: string };

const NO_STREAMS_MESSAGE = 'No playable streams are available from MAVERO Player right now.';
const NETWORK_MESSAGE = 'MAVERO Player could not be reached. Try again or choose another source.';

export async function resolveMaveroPlayerSource(
  request: MaveroPlayerRequest,
  deps: { fetcher?: typeof fetch; signal?: AbortSignal } = {},
): Promise<MaveroPlayerResolution> {
  const fetcher = deps.fetcher ?? fetch;
  let response: Response;
  try {
    const body: Record<string, unknown> = { contentId: request.contentId, mediaType: request.mediaType };
    if (request.season !== undefined) body.season = request.season;
    if (request.episode !== undefined) body.episode = request.episode;
    response = await fetcher('/api/playback/stremio', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: deps.signal,
    });
  } catch {
    return { ok: false, code: 'NETWORK', message: NETWORK_MESSAGE };
  }

  let payload: { ok?: boolean; source?: unknown; error?: { code?: string; message?: string } };
  try {
    payload = (await response.json()) as typeof payload;
  } catch {
    return { ok: false, code: 'NETWORK', message: NETWORK_MESSAGE };
  }

  if (!response.ok || !payload.ok) {
    return {
      ok: false,
      code: payload.error?.code ?? 'NETWORK',
      message: payload.error?.message ?? NETWORK_MESSAGE,
    };
  }

  // `source: null` = zero playable addon streams — a graceful empty result,
  // never a transport failure.
  if (!payload.source) {
    return { ok: false, code: 'NO_STREAMS', message: NO_STREAMS_MESSAGE };
  }

  if (!isPlayablePlayerSource(payload.source)) {
    return { ok: false, code: 'NO_STREAMS', message: NO_STREAMS_MESSAGE };
  }

  return { ok: true, source: payload.source };
}
