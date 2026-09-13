import type { PlayerSourceOption } from './player';

/**
 * MAVERO Player — the virtual playback source that aggregates every
 * eligible ENABLED Stremio HTTP addon (Phase 4).
 *
 * "MAVERO Player" is ONE logical source in the existing source selector.
 * It is NOT backed by a `streaming_sources` row and it does NOT replace
 * the provider/embed/direct system — it is an additional, additive branch:
 *
 *   MAVERO Player (virtual)
 *     → /api/playback/stremio (server-side Stremio resolution)
 *     → Phase 3 stream resolver → normalized HTTP/HLS sources
 *     → the existing PlayerSource `direct` model
 *     → the existing PlaybackManager / native player path
 *
 * IDENTITY STRATEGY (Phase 4 spec):
 *   * The virtual source id is the fixed, stable string
 *     `MAVERO_PLAYER_SOURCE_ID`. It is deliberately NOT a UUID: the
 *     existing `parseResolverRequest()` UUID requirement rejects it, so
 *     the virtual source can never be confused with — nor injected into —
 *     the real `streaming_sources` id space of `/api/playback/resolve`.
 *   * Individual resolved addon streams keep the Phase 3 identity inside
 *     the aggregate source: `providerId` = real `streaming_addons` row id,
 *     `sourceId` = deterministic `stremio:{slug}:{index}` key (see
 *     `stream-player-source.ts`). The client never sees manifest URLs or
 *     raw addon responses — only already-normalized PlayerSource data.
 *
 * Client-safe (shared): this module carries identity + the source-sheet
 * option shape only. All Stremio resolution stays server-side.
 */

/** Stable virtual source id — deliberately not a UUID (see above). */
export const MAVERO_PLAYER_SOURCE_ID = 'mavero-player';

/** Display name of the aggregate virtual source. */
export const MAVERO_PLAYER_SOURCE_NAME = 'MAVERO Player';

/** Integration marker shown in the source sheet (`· stremio`). */
export const MAVERO_PLAYER_INTEGRATION_TYPE = 'stremio';

/** True when the value IS the virtual MAVERO Player source id. */
export function isMaveroPlayerSourceId(value: string | null | undefined): value is typeof MAVERO_PLAYER_SOURCE_ID {
  return value === MAVERO_PLAYER_SOURCE_ID;
}

/**
 * The single virtual entry appended to the watch route's source options
 * (server-gated by `data.maveroPlayerAvailable`). Uses the EXISTING
 * `PlayerSourceOption` selection model — no second option representation.
 */
export function maveroPlayerSourceOption(): PlayerSourceOption {
  return {
    id: MAVERO_PLAYER_SOURCE_ID,
    name: MAVERO_PLAYER_SOURCE_NAME,
    status: 'available',
    integrationType: MAVERO_PLAYER_INTEGRATION_TYPE,
  };
}
