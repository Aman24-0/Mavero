import type { PlayerSource } from '$lib/shared/player';

/**
 * Normalized provider playback capabilities.
 *
 * Phase 1 introduces the shape; concrete capability values are populated by
 * the adapter's `getCapabilities()` method. The values MUST be derived from
 * verified documentation per the Phase 0 audit matrix — never inferred from
 * the player UI. Phase 3 will populate these from per-provider source
 * configuration in the database.
 */
export type ProviderPlaybackCapabilities = {
  progressEvents: boolean;
  currentTime: boolean;
  duration: boolean;
  seek: boolean;
  startAt: boolean;
  play: boolean;
  pause: boolean;
  volume: boolean;
  subtitles: boolean;
  quality: boolean;
  fullscreen: boolean;
  pictureInPicture: boolean;
  postMessage: boolean;
  nextEpisode: boolean;
};

/**
 * Conservative defaults derived from the Phase 0 audit.
 *
 * Direct HTML5 `<video>` playback is fully observable by Mavero — every
 * capability is `true` except `nextEpisode` (which is a provider-side concept,
 * not a video-element concept) and `postMessage` (direct playback does not
 * emit postMessage events).
 *
 * Generic embed playback (the fallback before any provider-specific adapter
 * is registered) is treated as a black box — Mavero cannot observe or
 * command any of the embed's internals from the parent.
 *
 * Phase 3 will override these defaults with per-provider VERIFIED
 * capabilities from the matrix in the Phase 0 worklog entry.
 */
export const DIRECT_PLAYBACK_CAPABILITIES: ProviderPlaybackCapabilities = {
  progressEvents: true,
  currentTime: true,
  duration: true,
  seek: true,
  startAt: true,
  play: true,
  pause: true,
  volume: true,
  subtitles: true,
  quality: true,
  fullscreen: true,
  pictureInPicture: true,
  postMessage: false,
  nextEpisode: false,
};

export const EMBED_PLAYBACK_CAPABILITIES: ProviderPlaybackCapabilities = {
  progressEvents: false,
  currentTime: false,
  duration: false,
  seek: false,
  startAt: false,
  play: false,
  pause: false,
  volume: false,
  subtitles: false,
  quality: false,
  fullscreen: true,
  pictureInPicture: false,
  postMessage: false,
  nextEpisode: false,
};

/**
 * Pick the conservative default capabilities for a resolved source.
 *
 * Direct sources use the HTML5 video element capabilities; embed sources
 * default to the conservative "no observable internals" set until a
 * provider-specific adapter overrides them (Phase 3).
 */
export function defaultCapabilitiesForSource(source: PlayerSource | null): ProviderPlaybackCapabilities {
  if (!source) return EMBED_PLAYBACK_CAPABILITIES;
  return source.type === 'direct' ? DIRECT_PLAYBACK_CAPABILITIES : EMBED_PLAYBACK_CAPABILITIES;
}
