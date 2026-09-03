import type { MediaItem } from '$data/content';
import type { NormalizedMediaItem } from './types';

export function toMediaItem(item: NormalizedMediaItem): MediaItem {
  return {
    id: item.id,
    title: item.title,
    year: item.year,
    type: item.type,
    maturity: item.maturity,
    runtime: item.runtime,
    rating: item.rating,
    genres: item.genres,
    description: item.description,
    poster: item.poster,
    posterSmall: item.posterSmall,
    backdrop: item.backdrop,
    backdropSmall: item.backdropSmall,
    accent: item.accent,
    progress: item.progress,
    progressLabel: item.progressLabel,
    status: item.status,
    episodes: item.episodes,
    seasons: item.seasons,
    tags: item.tags,
    trailerKey: item.trailerKey,
    cast: item.cast
  };
}
