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
  // India flatrate (subscription) providers, region IN only:
  //   - series: TMDB /tv/{id}/watch/providers -> results.IN.flatrate
  //   - movie:  TMDB /movie/{id}/watch/providers -> results.IN.flatrate,
  //             present ONLY when the movie's selected-month India
  //             releaseKinds include 'digital' (an OTT release)
  providers?: UpcomingProvider[];
  year?: number;
  rating?: number;
  genres?: string[];
  // movies only: the ACTUAL India release channels for the selected
  // month, derived from /movie/{id}/release_dates country IN events
  // (release types 2|3 -> theatrical, 4 -> digital). Present for every
  // movie item that survived validation.
  releaseKinds?: UpcomingReleaseKind[];
  source: 'tmdb';
};

export type UpcomingFilters = {
  month: number;   // 1-12
  year: number;    // e.g. 2026
  type: 'all' | UpcomingType;
  // TMDB ORIGINAL language filter (NOT dubbed-audio language).
  // 'all' = no language constraint; otherwise a canonical ISO-639-1
  // code from UPCOMING_LANGUAGE_OPTIONS (en/hi/ta/.../fr). Parsed
  // strictly server-side; invalid values fail safe to 'all'.
  language: string;
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
