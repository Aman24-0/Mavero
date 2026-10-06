import type { ContentType } from '$data/content';
import type { DiscoverLanguage } from '$lib/server/content/types';

// ============================================================
// MAVERO — Explorer taxonomy (Movies / TV Shows / Anime Explorers).
//
// ONE shared source of truth for the Explorer genre + language chip
// rows AND the server-side filter validation. The browser never
// invents filter values: the chips render from these lists, and the
// explorer loader / feed endpoint validate incoming URL/API values
// against the SAME closed sets — an invalid value cannot reach TMDB.
//
// GENRE IDS ARE REAL TMDB GENRE IDS — per media type, because TMDB
// movie and TV taxonomies differ (movie: 28 Action / 878 Sci-Fi;
// TV: 10759 Action & Adventure / 10765 Sci-Fi & Fantasy). Anime
// queries BOTH the movie and TV discover endpoints (the merged
// path), so each anime genre maps to an id PER side; when a side
// has no equivalent genre, that side is skipped (never queried
// with an invented id).
//
// LANGUAGES reuse the EXISTING DiscoverLanguage union and labels —
// the app's supported original-language codes. Anime is detected
// as genre 16 + original_language 'ja' by the ONE central anime
// classifier, so the anime catalog is entirely Japanese: the anime
// language row honestly offers All + Japanese only (any other code
// would either return nothing or break the classifier contract).
//
// Follow-up task 2 (§7): 'all' is NOT a language — it is the
// no-filter state, rendered by the row's dedicated synthetic "All"
// chip in ExplorerPage. The old lists ALSO carried { value: 'all' }
// here, so the renderer produced TWO "All" chips (synthetic + data).
// The data/render contract is fixed at the source: the option lists
// contain only CHOICEABLE languages. URL values of language=all
// continue to validate-then-degrade to "no filter" (the loader treats
// a value that fails the closed-union check as absent — identical
// semantics, since hasExplorerFilters always treated 'all' as
// inactive).
// ============================================================

export type ExplorerGenre = {
  /** Chip label + URL/API value. */
  name: string;
  /** TMDB movie-genre id (movie + anime-movie queries). */
  movieId?: number;
  /** TMDB TV-genre id (series + anime-series queries). */
  seriesId?: number;
};

export type ExplorerLanguageOption = { value: DiscoverLanguage; label: string };

export const EXPLORER_GENRES: Record<ContentType, readonly ExplorerGenre[]> = {
  movie: [
    { name: 'Action', movieId: 28 },
    { name: 'Adventure', movieId: 12 },
    { name: 'Animation', movieId: 16 },
    { name: 'Comedy', movieId: 35 },
    { name: 'Crime', movieId: 80 },
    { name: 'Drama', movieId: 18 },
    { name: 'Fantasy', movieId: 14 },
    { name: 'Horror', movieId: 27 },
    { name: 'Mystery', movieId: 9648 },
    { name: 'Romance', movieId: 10749 },
    { name: 'Sci-Fi', movieId: 878 },
    { name: 'Thriller', movieId: 53 }
  ],
  series: [
    { name: 'Action & Adventure', seriesId: 10759 },
    { name: 'Animation', seriesId: 16 },
    { name: 'Comedy', seriesId: 35 },
    { name: 'Crime', seriesId: 80 },
    { name: 'Documentary', seriesId: 99 },
    { name: 'Drama', seriesId: 18 },
    { name: 'Family', seriesId: 10751 },
    { name: 'Kids', seriesId: 10762 },
    { name: 'Mystery', seriesId: 9648 },
    { name: 'Romance', seriesId: 10749 },
    { name: 'Sci-Fi & Fantasy', seriesId: 10765 },
    { name: 'Western', seriesId: 37 }
  ],
  anime: [
    { name: 'Action', movieId: 28, seriesId: 10759 },
    { name: 'Adventure', movieId: 12, seriesId: 10759 },
    { name: 'Comedy', movieId: 35, seriesId: 35 },
    { name: 'Crime', movieId: 80, seriesId: 80 },
    { name: 'Drama', movieId: 18, seriesId: 18 },
    { name: 'Family', movieId: 10751, seriesId: 10751 },
    { name: 'Horror', movieId: 27 },
    { name: 'Mystery', movieId: 9648, seriesId: 9648 },
    { name: 'Romance', movieId: 10749, seriesId: 10749 },
    { name: 'Sci-Fi & Fantasy', movieId: 878, seriesId: 10765 }
  ]
};

// Follow-up task 2 (§7): EXACTLY the choosable languages — 'all' is
// the row's synthetic no-filter chip, never a list entry (one All).
const MOVIE_SERIES_LANGUAGES: readonly ExplorerLanguageOption[] = [
  { value: 'en', label: 'English' },
  { value: 'hi', label: 'Hindi' },
  { value: 'ta', label: 'Tamil' },
  { value: 'te', label: 'Telugu' },
  { value: 'ml', label: 'Malayalam' },
  { value: 'kn', label: 'Kannada' },
  { value: 'other', label: 'Other languages' }
];

const ANIME_LANGUAGES: readonly ExplorerLanguageOption[] = [
  { value: 'ja', label: 'Japanese' }
];

// ============================================================
// Follow-up task 2 (§10) — the Show-more SORT dimension.
//
// "Show more →" on the Popular / Top Rated rails must lead to the
// correct FULL collection state. The canonical route/query mechanism
// is the Explorer route's own URL contract — the same mechanism the
// legacy collection route used to carry (?sort=Top%20rated), now as a
// closed two-value union mapped onto the EXISTING service calls
// (popular(type, page) and collection(type, page, { sort: 'Top
// rated' })) — no new backend endpoint, no invented services.
// ============================================================

export type ExplorerSort = 'popular' | 'top-rated';

export const EXPLORER_SORTS: readonly ExplorerSort[] = ['popular', 'top-rated'];

export const EXPLORER_SORT_TITLES: Record<ExplorerSort, string> = {
  popular: 'Popular',
  'top-rated': 'Top rated'
};

/** Closed-union sort validation (URL/API values must match exactly). */
export function isExplorerSort(value: string | null | undefined): value is ExplorerSort {
  return value === 'popular' || value === 'top-rated';
}

export const EXPLORER_LANGUAGES: Record<ContentType, readonly ExplorerLanguageOption[]> = {
  movie: MOVIE_SERIES_LANGUAGES,
  series: MOVIE_SERIES_LANGUAGES,
  anime: ANIME_LANGUAGES
};

/** Closed-union genre validation (URL/API values must match a chip exactly). */
export function isExplorerGenre(type: ContentType, value: string | null | undefined): value is string {
  return typeof value === 'string' && value.length > 0 && EXPLORER_GENRES[type].some((genre) => genre.name === value);
}

/** Closed-union language validation per type (anime only allows ja). */
export function isExplorerLanguage(type: ContentType, value: string | null | undefined): value is DiscoverLanguage {
  if (typeof value !== 'string' || value.length === 0) return false;
  return EXPLORER_LANGUAGES[type].some((option) => option.value === value);
}

/** Resolve a validated genre name to the TMDB id for the movie/series query. */
export function explorerGenreId(type: 'movie' | 'series', name: string): number | undefined {
  return EXPLORER_GENRES[type].find((genre) => genre.name === name)?.[type === 'movie' ? 'movieId' : 'seriesId'];
}
