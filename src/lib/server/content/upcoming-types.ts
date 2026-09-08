// Upcoming releases data model.
//
// A single normalized item representing an upcoming release event:
//   - a movie (TMDB) with a release date
//   - a TV series episode (TMDB) with an air date + season/episode numbers
//   - an anime episode (TMDB TV with genre 16 + original_language 'ja')
//     with an air date + episode number
//
// All fields are sourced from real upstream data. Episode numbers and
// dates are NEVER fabricated — if the upstream doesn't provide them,
// the field is omitted (undefined).

export type UpcomingType = 'movie' | 'series' | 'anime';

// India movie release channel (Phase F): a movie discovered through the
// theatrical (TMDB release types 2|3) and/or digital (release type 4)
// India query. Movies qualifying for BOTH render ONE card carrying both
// kinds — duplicates are merged by canonical TMDB ID.
export type UpcomingReleaseKind = 'theatrical' | 'digital';

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
  // movies only: India release channels this title qualified through
  // ('theatrical' and/or 'digital'). Present for every movie item.
  releaseKinds?: UpcomingReleaseKind[];
  source: 'tmdb';
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
