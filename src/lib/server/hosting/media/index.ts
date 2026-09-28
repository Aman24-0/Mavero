/**
 * Phase 5 — Canonical media/folder service barrel export.
 */

export { CanonicalMediaService } from './service';
export type {
  EnsureMovieInput,
  EnsureSeriesInput,
  EnsureEpisodeInput,
  EnsureAnimeInput,
  EnsureAnimeEpisodeInput,
} from './service';

export { MediaServiceError } from './errors';
export type { MediaServiceErrorCode } from './errors';

export {
  movieCanonicalKey,
  seriesCanonicalKey,
  episodeCanonicalKey,
  rootMoviesKey,
  rootSeriesKey,
  rootAnimeKey,
  movieYearFolderKey,
  movieFolderKey,
  seriesFolderKey,
  seasonFolderKey,
  episodeFolderKey,
  animeFolderKey,
  animeSeasonFolderKey,
  animeEpisodeFolderKey,
} from './canonical-key';

export { sanitizeFolderName, seasonFolderName, episodeFolderName } from './slug';
