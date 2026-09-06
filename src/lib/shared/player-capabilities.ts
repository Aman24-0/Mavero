import type { PlayerSource } from './player';

/**
 * Normalized provider playback capabilities.
 *
 * Phase 1 introduces the shape; concrete capability values are populated by
 * the adapter's `getCapabilities()` method. The values MUST be derived from
 * verified documentation per the Phase 0 audit matrix — never inferred from
 * the player UI. Phase 3 populates these from per-provider verified docs.
 *
 * Phase 7: this module is the single source of truth for the
 * `ProviderPlaybackCapabilities` type and per-provider capability constants.
 * Both client code (`src/lib/client/player/capabilities.ts`) and server code
 * (admin UI) import from here so the admin capability matrix displays the
 * exact same values the player uses at runtime.
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
 */
export function defaultCapabilitiesForSource(source: PlayerSource | null): ProviderPlaybackCapabilities {
  if (!source) return EMBED_PLAYBACK_CAPABILITIES;
  return source.type === 'direct' ? DIRECT_PLAYBACK_CAPABILITIES : EMBED_PLAYBACK_CAPABILITIES;
}

// ----- Phase 3: per-provider VERIFIED capability sets -----
//
// Each constant below is derived from the Phase 0 provider capability
// matrix. Capabilities are marked `true` ONLY when the provider's official
// documentation explicitly confirms the integration mechanism (a documented
// postMessage event name, a documented URL parameter, or a documented
// command API). UNKNOWN capabilities default to `false`.
//
// IMPORTANT: `(e)` in the Phase 0 matrix means "documented as an event
// (player→parent) but NOT as a parent command." For the capabilities model:
//   - If a provider posts `play`/`pause` as events, `progressEvents` =
//     `true` and `currentTime`/`duration` = `true` (if the event payload
//     includes them), but `play`/`pause` (as COMMANDS) = `false` because
//     the parent cannot command the provider to play/pause — it can only
//     OBSERVE the provider's own play/pause state changes.
//   - `seek` is `true` only when a parent→player seek COMMAND is documented
//     (not just a `seeked` event). Only CineSrc has this.

/**
 * VidSrc — vidsrc.io/vidsrc/docs.
 *
 * VERIFIED: PLAYER_EVENT postMessage with player_progress (currentTime),
 * player_duration, player_status (playing/paused/completed/seeked).
 * VERIFIED: ?startAt= URL param.
 * VERIFIED: autonext=1 (next episode).
 * VERIFIED: ?sub_url= / ?sub_lang= / ?sub_label= (subtitles via URL).
 * VERIFIED: fullscreen (allowfullscreen).
 * NOT VERIFIED: seek command (only a `seeked` event, no parent→player seek).
 * NOT VERIFIED: quality as parent command (in-player only).
 * NOT VERIFIED: PiP.
 *
 * play/pause as COMMANDS = false (VidSrc posts play/pause as EVENTS, but
 * the parent cannot command VidSrc to play/pause).
 */
export const VIDSRC_CAPABILITIES: ProviderPlaybackCapabilities = {
  progressEvents: true,
  currentTime: true,
  duration: true,
  seek: false,
  startAt: true,
  play: false,
  pause: false,
  volume: false,
  subtitles: true,
  quality: false,
  fullscreen: true,
  pictureInPicture: false,
  postMessage: true,
  nextEpisode: true,
};

/**
 * VidLink — vidlink.pro homepage "Api Documentation".
 *
 * VERIFIED: PLAYER_EVENT postMessage (play/pause/seeked/ended/timeupdate
 * with currentTime+duration).
 * VERIFIED: MEDIA_DATA postMessage (continue-watching).
 * VERIFIED: ?startAt= URL param.
 * VERIFIED: nextbutton= (next episode).
 * VERIFIED: ?sub_file= / ?sub_label= (subtitles via URL).
 * VERIFIED: fullscreen (allowfullscreen).
 * NOT VERIFIED: seek command (only a `seeked` event).
 * NOT VERIFIED: quality.
 * NOT VERIFIED: PiP.
 */
export const VIDLINK_CAPABILITIES: ProviderPlaybackCapabilities = {
  progressEvents: true,
  currentTime: true,
  duration: true,
  seek: false,
  startAt: true,
  play: false,
  pause: false,
  volume: false,
  subtitles: true,
  quality: false,
  fullscreen: true,
  pictureInPicture: false,
  postMessage: true,
  nextEpisode: true,
};

/**
 * VidY — vidy.st homepage "Docs".
 *
 * VERIFIED: PLAYER_EVENT postMessage (timeupdate/play/pause/ended with
 * currentTime+duration, posted as JSON STRINGS — need JSON.parse).
 * VERIFIED: MEDIA_DATA postMessage.
 * VERIFIED: ?progress= URL param (start at N seconds).
 * VERIFIED: ?nextEpisode= / ?episodeSelector= / ?autoplayNextEpisode=.
 * VERIFIED: fullscreen (allowfullscreen, allow="encrypted-media; autoplay").
 * NOT VERIFIED: seek command.
 * NOT VERIFIED: subtitles, quality, PiP.
 */
export const VIDY_CAPABILITIES: ProviderPlaybackCapabilities = {
  progressEvents: true,
  currentTime: true,
  duration: true,
  seek: false,
  startAt: true,
  play: false,
  pause: false,
  volume: false,
  subtitles: false,
  quality: false,
  fullscreen: true,
  pictureInPicture: false,
  postMessage: true,
  nextEpisode: true,
};

/**
 * Viduki — viduki.net homepage #api.
 *
 * VERIFIED: `viduki:all-servers-failed` postMessage (server-failover signal).
 * VERIFIED: MEDIA_DATA postMessage (progress.watched / progress.duration).
 * NOT VERIFIED: play/pause/ended events.
 * NOT VERIFIED: startAt URL param (resume handled via provider's localStorage).
 * NOT VERIFIED: seek, subtitles, quality, PiP, fullscreen.
 *
 * The `viduki:all-servers-failed` signal is used for V1→V2 fallback (already
 * handled in the watch route; Phase 3 moves it into this adapter).
 */
export const VIDUKI_CAPABILITIES: ProviderPlaybackCapabilities = {
  progressEvents: true,
  currentTime: true,
  duration: true,
  seek: false,
  startAt: false,
  play: false,
  pause: false,
  volume: false,
  subtitles: false,
  quality: false,
  fullscreen: false,
  pictureInPicture: false,
  postMessage: true,
  nextEpisode: false,
};

/**
 * CinemaOS — cinemaos.tech/embed.
 *
 * VERIFIED: PostMessage API exists ("Control playback and track progress
 * from your own page").
 * VERIFIED: ?autoNext= / ?autoPlay= URL params.
 * VERIFIED: fullscreen (allowfullscreen, allow="encrypted-media").
 * PARTIAL: play/pause control (docs say you CAN control playback, but
 * exact method names are in JS-rendered content that could not be extracted).
 *
 * Because the exact event payload structure is UNKNOWN (JS-rendered docs),
 * this adapter CANNOT parse specific messages. It registers a listener
 * but does not normalize events until the payload structure is verified.
 * Capabilities reflect this: postMessage = true, but currentTime/duration/
 * play/pause/seek = false (UNKNOWN → treated as false per the "unknown is
 * not supported" rule).
 */
export const CINEMAOS_CAPABILITIES: ProviderPlaybackCapabilities = {
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
  postMessage: true,
  nextEpisode: true,
};

/**
 * CineSrc — cinesrc.st/docs.
 *
 * VERIFIED: FULL bidirectional postMessage API.
 *   Events (player→parent): cinesrc:ready, cinesrc:play, cinesrc:pause,
 *     cinesrc:timeupdate {currentTime, duration}, cinesrc:seeking,
 *     cinesrc:seeked, cinesrc:ended, cinesrc:volumechange, cinesrc:ratechange,
 *     cinesrc:loadedmetadata {duration}, cinesrc:nextepisode, cinesrc:skipintro,
 *     cinesrc:sourceused, cinesrc:close, cinesrc:error, cinesrc:response.
 *   Commands (parent→player): JSON-RPC {type:"cinesrc:command", command, args}
 *     — play, pause, seek, setVolume, setMuted, setPlaybackRate,
 *     getCurrentTime, getDuration, getPaused. Getters return via
 *     cinesrc:response.
 * VERIFIED: ?t= URL param (startAt).
 * VERIFIED: ?quality= URL param.
 * VERIFIED: ?autonext= URL param (next episode).
 * VERIFIED: fullscreen (allowfullscreen, allow="autoplay; fullscreen;
 *   picture-in-picture").
 * VERIFIED: PiP (allow="picture-in-picture").
 * NOT VERIFIED: subtitles (not in the documented customization params).
 *
 * This is the ONLY provider with VERIFIED bidirectional commands. It serves
 * as the reference implementation for the Phase 3 adapter contract.
 */
export const CINESRC_CAPABILITIES: ProviderPlaybackCapabilities = {
  progressEvents: true,
  currentTime: true,
  duration: true,
  seek: true,
  startAt: true,
  play: true,
  pause: true,
  volume: true,
  subtitles: false,
  quality: true,
  fullscreen: true,
  pictureInPicture: true,
  postMessage: true,
  nextEpisode: true,
};

/**
 * VidAPI.qzz.io — vidapi.qzz.io homepage.
 *
 * VERIFIED: MEDIA_DATA postMessage (progress.watched / progress.duration /
 * progress.percentage).
 * VERIFIED: ?startAt= URL param.
 * VERIFIED: ?nextbutton= (next episode).
 * VERIFIED: ?sub_file= / ?sub_label= (subtitles via URL).
 * VERIFIED: fullscreen (allowfullscreen).
 * NOT VERIFIED: PLAYER_EVENT stream (unlike vidlink.pro sibling — VidAPI.qzz.io
 *   posts ONLY MEDIA_DATA, not play/pause/ended events).
 * NOT VERIFIED: seek, quality, PiP.
 *
 * play/pause = false (no play/pause events documented).
 */
export const VIDAPI_QZZ_CAPABILITIES: ProviderPlaybackCapabilities = {
  progressEvents: true,
  currentTime: true,
  duration: true,
  seek: false,
  startAt: true,
  play: false,
  pause: false,
  volume: false,
  subtitles: true,
  quality: false,
  fullscreen: true,
  pictureInPicture: false,
  postMessage: true,
  nextEpisode: true,
};

/**
 * VidPhantom — vidphantom.com (origin currently 522 / unreachable).
 *
 * PARTIAL: search-engine snippet confirms a "Player Events" postMessage
 * section with play/pause events. The full docs could not be retrieved
 * because the origin is unreachable (HTTP 522).
 *
 * Because the exact payload structure is UNKNOWN (only a search snippet),
 * this adapter CANNOT reliably parse messages. It registers a listener
 * but does not normalize events until the origin recovers and the full
 * docs are verified. All capabilities are conservative (false) except
 * `postMessage` (the snippet confirms the API exists).
 */
export const VIDPHANTOM_CAPABILITIES: ProviderPlaybackCapabilities = {
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
  fullscreen: false,
  pictureInPicture: false,
  postMessage: true,
  nextEpisode: false,
};

/**
 * Yenime — api.yenime.net (anime-only, MAL ID based).
 *
 * Verified from the official Yenime API homepage at https://api.yenime.net
 * and the player JS chunks. Yenime is built on top of MegaPlay's
 * infrastructure (docs say "direct megaplay extraction") and reuses
 * VidLink's `PLAYER_EVENT` postMessage protocol.
 *
 * VERIFIED: postMessage events (player→parent):
 *   { type: "PLAYER_EVENT", data: { event: "play"|"pause"|"seeked"|
 *     "ended"|"timeupdate"|"playing"|"waiting"|"error", currentTime,
 *     duration, mtmdbId, mediaType, season, episode } }
 * VERIFIED: `?startAt=N` URL parameter (documented at the API homepage
 *   "Query Parameters" section: `?startAt=90` → begin at 90 seconds).
 * VERIFIED: fullscreen (allowfullscreen set on the iframe).
 * VERIFIED: SUB/DUB is an in-player toggle button (no separate URL
 *   variants) — Mavero does NOT expose variant toggles for Yenime.
 * NOT VERIFIED: seek command (only a `seeked` event).
 * NOT VERIFIED: play/pause as commands (Yenime posts them as state
 *   changes, but the parent cannot command the player).
 * NOT VERIFIED: volume, subtitles, quality, PiP, nextEpisode.
 */
export const YENIME_CAPABILITIES: ProviderPlaybackCapabilities = {
  progressEvents: true,
  currentTime: true,
  duration: true,
  seek: false,
  startAt: true,
  play: false,
  pause: false,
  volume: false,
  subtitles: false,
  quality: false,
  fullscreen: true,
  pictureInPicture: false,
  postMessage: true,
  nextEpisode: false,
};

// ----- Phase 7: adapter_id → capabilities lookup -----
//
// The admin capability matrix uses this map to display per-adapter
// capability values. Providers with no registered adapter (generic template
// providers) have no entry here — the admin UI displays "Unknown" for those.
//
// IMPORTANT: do NOT "upgrade" capabilities based on assumptions. If a
// provider's docs are partial or unreachable, preserve the conservative
// values. The admin UI must distinguish:
//   SUPPORTED  (verified true)
//   UNSUPPORTED (verified false)
//   UNKNOWN    (no adapter registered / capability not verified)
//
// For providers with a registered adapter, the values below are the
// VERIFIED truth. For providers without a registered adapter, the admin UI
// shows UNKNOWN for all 14 fields (NOT unsupported).
//
// NOTE: The DB `capabilities` JSON column on `streaming_providers` and
// `streaming_sources` is a SEPARATE concept — it stores media-type support
// (movie/series/anime), sandbox policy, allowed origins, experimental flags,
// etc. The 14-field `ProviderPlaybackCapabilities` matrix below is a
// code-level truth derived from verified provider docs, NOT stored in the
// DB. Do not confuse these two capability systems.

export const PROVIDER_CAPABILITY_MAP: Record<string, ProviderPlaybackCapabilities> = {
  'vidsrc': VIDSRC_CAPABILITIES,
  'vidlink': VIDLINK_CAPABILITIES,
  'vidy': VIDY_CAPABILITIES,
  'viduki': VIDUKI_CAPABILITIES,
  'cinemaos': CINEMAOS_CAPABILITIES,
  'cinesrc': CINESRC_CAPABILITIES,
  'vidapi-qzz': VIDAPI_QZZ_CAPABILITIES,
  'vidphantom': VIDPHANTOM_CAPABILITIES,
  'yenime-embed': YENIME_CAPABILITIES,
};

/**
 * Look up playback capabilities for a given adapter_id. Returns `null` when
 * the adapter_id has no registered capability mapping — the admin UI should
 * display "Unknown" (NOT unsupported) in that case.
 */
export function lookupProviderCapabilities(adapterId: string | null | undefined): ProviderPlaybackCapabilities | null {
  if (!adapterId) return null;
  return PROVIDER_CAPABILITY_MAP[adapterId] ?? null;
}

/**
 * The ordered list of capability field keys, for display in the admin matrix.
 * Matches the order in `ProviderPlaybackCapabilities`.
 */
export const CAPABILITY_FIELDS: ReadonlyArray<keyof ProviderPlaybackCapabilities> = [
  'progressEvents',
  'currentTime',
  'duration',
  'seek',
  'startAt',
  'play',
  'pause',
  'volume',
  'subtitles',
  'quality',
  'fullscreen',
  'pictureInPicture',
  'postMessage',
  'nextEpisode',
];

/**
 * Human-readable labels for each capability field, for admin display.
 */
export const CAPABILITY_LABELS: Record<keyof ProviderPlaybackCapabilities, string> = {
  progressEvents: 'Progress Events',
  currentTime: 'Current Time',
  duration: 'Duration',
  seek: 'Seek',
  startAt: 'Start At',
  play: 'Play',
  pause: 'Pause',
  volume: 'Volume',
  subtitles: 'Subtitles',
  quality: 'Quality',
  fullscreen: 'Fullscreen',
  pictureInPicture: 'PiP',
  postMessage: 'PostMessage',
  nextEpisode: 'Next Episode',
};
