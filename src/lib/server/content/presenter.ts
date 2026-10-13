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
    // MAV-FOCUSED Issue 4 (2026-10): forward the per-season metadata
    // (number + airDate + episodeCount) so SeasonEpisodes can filter
    // out announced / future seasons from the season selector. Was
    // previously dropped by the allowlist — the count alone was
    // forwarded (item.seasons), which is what caused Black Clover S2
    // and The Gentlemen S3 (announced but unreleased) to render as
    // empty placeholder tabs with fake episode rows.
    seasonsData: item.seasonsData,
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
