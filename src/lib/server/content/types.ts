export type ContentType = 'movie' | 'series' | 'anime';
export type ContentProvider = 'tmdb' | 'anilist' | 'fixtures';

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
