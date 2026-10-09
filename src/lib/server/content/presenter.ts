import type { MediaItem } from '$data/content';
import type { NormalizedMediaItem } from './types';

export function toMediaItem(item: NormalizedMediaItem): MediaItem {
  return {
    id: item.id,
    title: item.title,
    year: item.year,
    releaseDate: item.releaseDate,
    type: item.type,
    isAnime: item.isAnime,
    animeFormat: item.animeFormat,
    maturity: item.maturity,
    runtime: item.runtime,
    rating: item.rating,
    genres: item.genres,
    description: item.description,
    poster: item.poster,
    posterSmall: item.posterSmall,
    backdrop: item.backdrop,
    backdropSmall: item.backdropSmall,
    backdropHero: item.backdropHero,
    accent: item.accent,
    progress: item.progress,
    progressLabel: item.progressLabel,
    status: item.status,
    episodes: item.episodes,
    seasons: item.seasons,
    tags: item.tags,
    trailerKey: item.trailerKey,
    cast: item.cast,
    externalIds: item.externalIds,
    streamingProviders: item.streamingProviders,
    // MAV-21: detail-path enrichment — director (movies) + creators
    // (series) ride the SAME detail payload; maturity carries the
    // honest TMDB certification (never the old hardcoded badge).
    director: item.director,
    creators: item.creators,
    originalLanguage: item.originalLanguage,
    popularity: item.popularity,
    voteCount: item.voteCount
  };
}
