import type { PlayerEpisode, PlayerEpisodeTarget, PlayerPlaybackState, PlayerSource, PlayerSourceOption } from './player';
import { isEmbedOriginAllowed, isPlayablePlayerSource, sourceIsExpired } from './player-guards';

export function stateForSource(source: PlayerSource | null, now = Date.now()): PlayerPlaybackState {
  if (!source) return 'source-unavailable';
  if (!isPlayablePlayerSource(source) || sourceIsExpired(source, now)) return 'source-unavailable';
  if (source.type === 'embed') return isEmbedOriginAllowed(source) ? 'embed-loading' : 'embed-unavailable';
  const protocol = source.metadata?.protocol;
  if (protocol && !['mp4', 'file', 'hls', 'dash', 'unknown'].includes(protocol)) return 'unsupported-format';
  return 'preparing';
}

export function clampSeek(value: number, duration: number) {
  if (!Number.isFinite(value)) return 0;
  if (!Number.isFinite(duration) || duration <= 0) return Math.max(0, value);
  return Math.min(duration, Math.max(0, value));
}

export function adjacentSource(options: PlayerSourceOption[], currentSourceId: string | undefined, delta: -1 | 1) {
  if (!currentSourceId) return undefined;
  const index = options.findIndex((option) => option.id === currentSourceId);
  if (index < 0) return undefined;
  return options[index + delta]?.id;
}

export function adjacentEpisode(episodes: PlayerEpisode[], current: PlayerEpisodeTarget | null, delta: -1 | 1) {
  if (!current) return undefined;
  const index = episodes.findIndex((episode) => episode.season === current.season && episode.number === current.episode);
  if (index < 0) return undefined;
  const next = episodes[index + delta];
  return next ? { season: next.season, episode: next.number, title: next.title } : undefined;
}

/**
 * VidRift next-up context: compute the AUTHORITATIVE next episode for the
 * current one, from Mavero's own episode data (never guessed from the
 * provider side).
 *
 * Returns a TRI-STATE:
 *   - `{ season, episode }` — the next episode. Within the loaded season
 *     this is the exact next list entry; at a season finale it is the next
 *     season's first episode, but ONLY when a further season is known to
 *     exist (`totalSeasons`, TMDB's season count with specials excluded).
 *   - `null` — the series finale: there is NO next episode (the caller
 *     forwards `next: null` so the provider's next-up affordance is cleared
 *     instead of showing a fake next episode).
 *   - `undefined` — UNKNOWN: no episode context, or the current episode is
 *     not in the loaded episode list (e.g. the season fetch failed). The
 *     caller must NOT take over episodes in this state — the provider
 *     self-drives and the caller follows the provider's own episode
 *     message.
 */
export function nextEpisodeTarget(
  episodes: PlayerEpisode[],
  current: PlayerEpisodeTarget | null,
  totalSeasons?: number,
): PlayerEpisodeTarget | null | undefined {
  if (!current) return undefined;
  const index = episodes.findIndex((episode) => episode.season === current.season && episode.number === current.episode);
  if (index < 0) return undefined;
  const next = episodes[index + 1];
  if (next) return { season: next.season, episode: next.number, title: next.title };
  // Season finale — the next season's first episode only when one exists.
  if (typeof totalSeasons === 'number' && Number.isFinite(totalSeasons) && current.season < totalSeasons) {
    return { season: current.season + 1, episode: 1 };
  }
  // Series finale (or season count unknown — conservative: no next).
  return null;
}
