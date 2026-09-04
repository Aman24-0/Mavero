// Upcoming releases data model.
//
// A single normalized item representing an upcoming release event:
//   - a movie (TMDB) with a release date
//   - a TV series episode (TMDB) with an air date + season/episode numbers
//   - an anime episode (AniList) with an airing date + episode number
//
// All fields are sourced from real upstream data. Episode numbers and
// dates are NEVER fabricated — if the upstream doesn't provide them,
// the field is omitted (undefined).

export type UpcomingType = 'movie' | 'series' | 'anime';

export type UpcomingProvider = {
  id: number;
  name: string;
  logo: string;
};

export type UpcomingItem = {
  id: string;
  type: UpcomingType;
  title: string;
  poster: string;
  backdrop?: string;
  date: string;        // ISO date string (YYYY-MM-DD)
  timestamp: number;   // unix ms for sorting/grouping
  season?: number;     // series/anime only
  episode?: number;    // series/anime only
  episodeTitle?: string; // series/anime only
  providers?: UpcomingProvider[]; // series only (TMDB flatrate, IN region)
  year?: number;
  rating?: number;
  genres?: string[];
  source: 'tmdb' | 'anilist';
};

export type UpcomingFilters = {
  month: number;   // 1-12
  year: number;    // e.g. 2026
  type: 'all' | UpcomingType;
};

export type UpcomingResult = {
  items: UpcomingItem[];
  filters: UpcomingFilters;
  errors: string[];   // partial-failure messages (empty when fully successful)
  errorMessage?: string; // present only when everything failed
};

export type UpcomingDiagnostics = {
  filters: UpcomingFilters;
  region: string;
  movieCount: number;
  seriesCount: number;
  animeCount: number;
  errors: string[];
};
