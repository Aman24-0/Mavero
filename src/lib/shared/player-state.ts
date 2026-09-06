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
