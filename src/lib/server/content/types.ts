export type ContentType = 'movie' | 'series' | 'anime';
export type ContentProvider = 'tmdb' | 'fixtures';

export type ContentSource = {
  provider: ContentProvider;
  externalId?: string;
  fetchedAt: string;
  stale?: boolean;
};

export type Episode = {
  id: string;
  number: number;
  season: number;
  title: string;
  overview?: string;
  airDate?: string;
  runtime?: string;
  still?: string;
};

export type CastMember = {
  id: string;
  name: string;
  character?: string;
  photo?: string;
};

export type Season = {
  number: number;
  title: string;
  episodeCount: number;
  airDate?: string;
  poster?: string;
  episodes?: Episode[];
};

export type NormalizedMediaItem = {
  id: string;
  title: string;
  year: number;
  type: ContentType;
  /**
   * True when this title is anime. TMDB marks Demon Slayer: Infinity
   * Castle as `type: 'movie'` and Attack on Titan as `type: 'series'`,
   * but both are anime — detected via genre 16 'Animation' + original
   * language 'ja'. The card UI uses `isAnime` to render an ANIME badge
   * alongside the canonical Movie/Series badge. Anime content is resolved
   * via the normal movie/series provider pipeline (no anime-specific
   * routing) — `isAnime` is purely a UI/categorization hint.
   */
  isAnime?: boolean;
  /**
   * The anime-specific format ('movie' or 'series'). Set when
   * `isAnime === true`. The card UI renders both ANIME (top-left) and
   * MOVIE/SERIES (top-right) badges using `isAnime` + `animeFormat`
   * (or `type` if animeFormat is absent).
   */
  animeFormat?: 'movie' | 'series';
  maturity?: string;
  runtime: string;
  rating: number;
  popularity?: number;
  voteCount?: number;
  genres: string[];
  description: string;
  poster: string;
  posterSmall?: string;
  backdrop: string;
  backdropSmall?: string;
  backdropHero?: string;
  accent: string;
  progress?: number;
  progressLabel?: string;
  status?: string;
  episodes?: number;
  seasons?: number;
  tags?: string[];
  source: ContentSource;
  externalIds?: {
    tmdb?: string;
    imdb?: string;
    anilist?: string;
    mal?: string;
  };
  seasonsData?: Season[];
  nativeTitle?: string;
  trailerKey?: string;
  cast?: CastMember[];
};

export type ContentDetail = NormalizedMediaItem & {
  recommendations?: NormalizedMediaItem[];
};

export type ContentList = {
  items: NormalizedMediaItem[];
  page: number;
  hasNextPage: boolean;
  source: ContentSource;
};

export type SearchSort = 'release-asc' | 'release-desc';
export type CollectionSort = 'For you' | 'Top rated' | 'Newest';

export type CollectionFilters = {
  genre?: string;
  year?: string;
  sort?: CollectionSort;
};

export type SearchFilters = {
  ott?: string;
  genre?: string;
  sort?: SearchSort;
};

// ============================================================
// Discover V2 — India-first catalog dimensions.
//
// The Discover page is now data-driven: each section has a stable
// `DiscoverSectionKey` and (for language-filterable sections) a
// `DiscoverLanguage` filter. The server's `discoverRail()` builder
// is the single source of truth for which TMDB endpoint + filters
// correspond to each section key — the browser never sends raw TMDB
// paths or arbitrary filter values.
//
// "All" is genuinely mixed: it issues ONE unfiltered catalog query
// (no language-bucket concatenation). India-first prioritization
// comes from `region=IN` / `watch_region=IN` / theatre availability,
// NOT from artificially reordering the All result.
// ============================================================

export type DiscoverLanguage =
  | 'all'
  | 'hi'    // Hindi
  | 'en'    // English
  | 'ta'    // Tamil
  | 'te'    // Telugu
  | 'ml'    // Malayalam
  | 'kn'    // Kannada
  | 'other'; // every TMDB original_language NOT in the above 6

export type DiscoverSectionKey =
  | 'theatre'
  | 'new-ott'
  | 'popular-movie'
  | 'popular-series'
  | 'popular-anime'
  | 'top-rated-movie'
  | 'top-rated-series'
  | 'top-rated-anime'
  | 'genre-action'
  | 'genre-adventure'
  | 'genre-comedy'
  | 'genre-crime'
  | 'genre-thriller'
  | 'genre-scifi'
  | 'genre-drama'
  | 'genre-horror'
  | 'genre-romance';

export type DiscoverRailFilters = {
  section: DiscoverSectionKey;
  language: DiscoverLanguage;
  // OTT provider id (TMDB provider_id) — only meaningful for section='new-ott'.
  // Empty string means "All OTT" (mixed across all India providers).
  provider?: string;
  page?: number;
};

export type DiscoverProvider = {
  providerId: number;
  name: string;
  logoPath: string | null;
  // Stable URL-safe key derived from the provider name, used as the
  // `provider` query param so the client never sends raw ids.
  key: string;
};

export type ContentSearchResult = ContentList & {
  query: string;
  filters?: SearchFilters;
};

export type ContentErrorCode = 'CONFIG_MISSING' | 'UPSTREAM_ERROR' | 'RATE_LIMITED' | 'INVALID_RESPONSE' | 'NOT_FOUND';

export class ContentServiceError extends Error {
  code: ContentErrorCode;
  status: number;
  retryAfter?: number;

  constructor(message: string, options: { code: ContentErrorCode; status?: number; retryAfter?: number }) {
    super(message);
    this.name = 'ContentServiceError';
    this.code = options.code;
    this.status = options.status ?? 502;
    this.retryAfter = options.retryAfter;
  }
}

export function isContentType(value: string | null | undefined): value is ContentType {
  return value === 'movie' || value === 'series' || value === 'anime';
}

export function isValidContentId(value: string | null | undefined) {
  return Boolean(value && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(value));
}
