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

// India movie release channel (release-kind ENRICHMENT): derived from
// the OPTIONAL /movie/{id}/release_dates lookup — country IN events of
// release types 2|3 (theatrical) and/or 4 (digital) inside the selected
// month. Discovery (region=IN + with_release_country=IN + release_date
// window) is what qualifies a movie; this enrichment only labels the
// card. Movies qualifying for BOTH kinds render ONE card carrying both.
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
  //   - movie:  TMDB /movie/{id}/watch/providers -> results.IN.flatrate
  // Provider data is its own truth source (its own lookup, never a
  // gating signal): icons render whenever India flatrate availability
  // exists, and a provider lookup failure hides the icons but never
  // removes the item.
  providers?: UpcomingProvider[];
  year?: number;
  rating?: number;
  genres?: string[];
  // movies only: the release-kind ENRICHMENT for the selected month,
  // derived from the OPTIONAL /movie/{id}/release_dates country IN
  // events (release types 2|3 -> theatrical, 4 -> digital). Present
  // ONLY when the enrichment confirmed in-month India events — a
  // missing/failed/event-less enrichment is omitted (undefined) and the
  // movie still renders (discovery is what qualifies a movie).
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
