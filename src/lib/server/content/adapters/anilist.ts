import { env } from '$env/dynamic/private';
import { getOrSet } from '../cache';
import { asNumber, asString, asStringArray, fetchJson } from '../http';
import { ContentServiceError, type CollectionFilters, type ContentDetail, type ContentList, type ContentSource, type NormalizedMediaItem } from '../types';

type AniListMedia = {
  id: number;
  idMal?: number | null;
  title?: { romaji?: string | null; english?: string | null; native?: string | null };
  description?: string | null;
  startDate?: { year?: number | null } | null;
  season?: string | null;
  seasonYear?: number | null;
  format?: string | null;
  status?: string | null;
  episodes?: number | null;
  duration?: number | null;
  averageScore?: number | null;
  popularity?: number | null;
  genres?: string[] | null;
  coverImage?: { extraLarge?: string | null; large?: string | null; medium?: string | null; color?: string | null } | null;
  bannerImage?: string | null;
  countryOfOrigin?: string | null;
  isAdult?: boolean | null;
  siteUrl?: string | null;
  nextAiringEpisode?: { episode?: number | null; airingAt?: number | null } | null;
  trailer?: { id?: string | null; site?: string | null } | null;
  relations?: { edges?: { relationType?: string; node?: AniListMedia }[] } | null;
};
type AniListPage = { Page?: { pageInfo?: { currentPage?: number; hasNextPage?: boolean; lastPage?: number }; media?: AniListMedia[] } };
type AniListResponse<T> = { data?: T; errors?: { message?: string }[] };

const API_URL = env.ANILIST_API_URL || 'https://graphql.anilist.co';
const listPolicy = { ttlMs: 1000 * 60 * 6, staleWhileRevalidateMs: 1000 * 60 * 20 };
const detailPolicy = { ttlMs: 1000 * 60 * 30, staleWhileRevalidateMs: 1000 * 60 * 60 * 4 };

const mediaFields = `
  id
  idMal
  title { romaji english native }
  description(asHtml: false)
  startDate { year }
  season
  seasonYear
  format
  status
  episodes
  duration
  averageScore
  popularity
  genres
  coverImage { extraLarge large medium color }
  bannerImage
  countryOfOrigin
  isAdult
  siteUrl
  nextAiringEpisode { episode airingAt }
  trailer { id site }
`;

function source(externalId?: string): ContentSource {
  return { provider: 'anilist', externalId, fetchedAt: new Date().toISOString() };
}

function runtime(minutes: number | null | undefined, episodes: number | null | undefined) {
  if (episodes && episodes > 0) return `${episodes} episodes`;
  if (minutes && minutes > 0) return `${minutes}m episodes`;
  return 'Anime';
}

function titleOf(media: AniListMedia) {
  return media.title?.english || media.title?.romaji || media.title?.native || 'Untitled anime';
}

function stripDescription(value: string | null | undefined) {
  return asString(value).replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
}

function mapAniList(raw: AniListMedia, tag?: string): NormalizedMediaItem {
  const isAiring = raw.status === 'RELEASING';
  const genres = asStringArray(raw.genres);
  const primaryColor = raw.coverImage?.color || '#9b87f5';
  // Phase 7F+ (anime routing): AniList's `format` field tells us the
  // anime-specific format. 'MOVIE' → 'movie' (e.g. Demon Slayer: Mugen
  // Train, Jujutsu Kaisen 0). Everything else (TV, TV_SHORT, ONA, OVA,
  // SPECIAL) is treated as 'series' for card-badge purposes. This
  // preserves the legacy single-'Anime' badge for the /anime route
  // while still exposing the format for the resolver pipeline.
  const animeFormat: 'movie' | 'series' | undefined =
    raw.format === 'MOVIE' ? 'movie'
      : raw.format === 'TV' || raw.format === 'TV_SHORT' || raw.format === 'ONA' || raw.format === 'OVA' || raw.format === 'SPECIAL' ? 'series'
        : undefined;
  return {
    id: `anime-${raw.id}`,
    title: titleOf(raw),
    nativeTitle: raw.title?.native ?? undefined,
    year: raw.seasonYear || raw.startDate?.year || new Date().getFullYear(),
    type: 'anime',
    isAnime: true,
    animeFormat,
    maturity: raw.isAdult ? '16+' : '13+',
    runtime: runtime(raw.duration, raw.episodes),
    rating: Math.round((asNumber(raw.averageScore) / 10) * 10) / 10,
    popularity: asNumber(raw.popularity),
    voteCount: asNumber(raw.popularity),
    genres: genres.length ? genres.slice(0, 4) : ['Anime'],
    description: stripDescription(raw.description) || 'No synopsis is available yet.',
    poster: raw.coverImage?.extraLarge || raw.coverImage?.large || raw.coverImage?.medium || '',
    backdrop: raw.bannerImage || raw.coverImage?.extraLarge || raw.coverImage?.large || '',
    accent: primaryColor,
    status: isAiring ? 'Currently airing' : raw.status ? raw.status.toLowerCase().replaceAll('_', ' ') : undefined,
    episodes: raw.episodes ?? undefined,
    tags: tag ? [tag] : isAiring ? ['New episode'] : undefined,
    source: source(String(raw.id)),
    externalIds: { anilist: String(raw.id), mal: raw.idMal ? String(raw.idMal) : undefined },
    trailerKey: raw.trailer?.site === 'youtube' ? raw.trailer.id ?? undefined : undefined
  };
}

async function aniListRequest<T>(query: string, variables: Record<string, unknown>) {
  const response = await fetchJson<AniListResponse<T>>(API_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables })
  });
  if (response.errors?.length) {
    throw new ContentServiceError('AniList returned a GraphQL error.', { code: 'UPSTREAM_ERROR', status: 502 });
  }
  if (!response.data) {
    throw new ContentServiceError('AniList returned no data.', { code: 'INVALID_RESPONSE', status: 502 });
  }
  return response.data;
}

const listQuery = `query ($page: Int, $search: String, $season: MediaSeason, $seasonYear: Int) {
  Page(page: $page, perPage: 18) {
    pageInfo { currentPage hasNextPage lastPage }
    media(type: ANIME, search: $search, season: $season, seasonYear: $seasonYear, sort: [POPULARITY_DESC, SCORE_DESC], isAdult: false) { ${mediaFields} }
  }
}`;

const trendingQuery = `query ($page: Int) {
  Page(page: $page, perPage: 18) {
    pageInfo { currentPage hasNextPage lastPage }
    media(type: ANIME, sort: [TRENDING_DESC, SCORE_DESC], isAdult: false) { ${mediaFields} }
  }
}`;

const collectionQuery = `query ($page: Int, $genre: String, $seasonYear: Int, $sort: [MediaSort!]) {
  Page(page: $page, perPage: 20) {
    pageInfo { currentPage hasNextPage lastPage }
    media(type: ANIME, genre: $genre, seasonYear: $seasonYear, sort: $sort, isAdult: false) { ${mediaFields} }
  }
}`;

const detailQuery = `query ($id: Int!) {
  Media(id: $id, type: ANIME) { ${mediaFields} relations { edges { relationType node { ${mediaFields} } } } }
}`;

export async function getAniListDiscover(page = 1): Promise<ContentList> {
  const key = `anilist:discover:${page}`;
  const { value, stale } = await getOrSet(key, listPolicy, async () => {
    const data = await aniListRequest<AniListPage>(listQuery, { page });
    const pageData = data.Page;
    const items = (pageData?.media ?? []).filter((item) => item.coverImage?.large || item.coverImage?.extraLarge).map((item) => mapAniList(item, 'Popular anime'));
    return { items, page: pageData?.pageInfo?.currentPage ?? page, hasNextPage: Boolean(pageData?.pageInfo?.hasNextPage), source: source() };
  });
  return { ...value, source: { ...value.source, stale } };
}

export async function getAniListTrending(page = 1): Promise<ContentList> {
  const key = `anilist:trending:${page}`;
  const { value, stale } = await getOrSet(key, listPolicy, async () => {
    const data = await aniListRequest<AniListPage>(trendingQuery, { page });
    const pageData = data.Page;
    const items = (pageData?.media ?? []).filter((item) => item.coverImage?.large || item.coverImage?.extraLarge).map((item) => mapAniList(item, 'Trending anime'));
    return { items, page: pageData?.pageInfo?.currentPage ?? page, hasNextPage: Boolean(pageData?.pageInfo?.hasNextPage), source: source() };
  });
  return { ...value, source: { ...value.source, stale } };
}

export async function getAniListCollection(page = 1, filters: CollectionFilters = {}): Promise<ContentList> {
  const seasonYear = filters.year && /^\d{4}$/.test(filters.year) ? Number(filters.year) : undefined;
  const sort = filters.sort === 'Top rated'
    ? ['SCORE_DESC', 'POPULARITY_DESC']
    : filters.sort === 'Newest'
      ? ['START_DATE_DESC', 'POPULARITY_DESC']
      : ['POPULARITY_DESC', 'SCORE_DESC'];
  const key = `anilist:collection:${page}:${filters.genre ?? ''}:${seasonYear ?? ''}:${filters.sort ?? ''}`;
  const { value, stale } = await getOrSet(key, listPolicy, async () => {
    const data = await aniListRequest<AniListPage>(collectionQuery, { page, genre: filters.genre || undefined, seasonYear, sort });
    const pageData = data.Page;
    const items = (pageData?.media ?? []).filter((item) => item.coverImage?.large || item.coverImage?.extraLarge).map((item) => mapAniList(item, 'Anime collection'));
    return { items, page: pageData?.pageInfo?.currentPage ?? page, hasNextPage: Boolean(pageData?.pageInfo?.hasNextPage), source: source() };
  });
  return { ...value, source: { ...value.source, stale } };
}

export async function searchAniList(query: string, page = 1): Promise<ContentList> {
  const normalized = query.trim();
  const key = `anilist:search:${normalized.toLowerCase()}:${page}`;
  const { value, stale } = await getOrSet(key, { ttlMs: 1000 * 60 * 2, staleWhileRevalidateMs: 1000 * 60 * 5 }, async () => {
    const data = await aniListRequest<AniListPage>(listQuery, { page, search: normalized });
    const pageData = data.Page;
    const items = (pageData?.media ?? []).filter((item) => item.coverImage?.large || item.coverImage?.extraLarge).map((item) => mapAniList(item));
    return { items, page: pageData?.pageInfo?.currentPage ?? page, hasNextPage: Boolean(pageData?.pageInfo?.hasNextPage), source: source() };
  });
  return { ...value, source: { ...value.source, stale } };
}

export async function getAniListDetail(externalId: string): Promise<ContentDetail> {
  const numericId = Number(externalId);
  if (!Number.isInteger(numericId) || numericId <= 0) {
    throw new ContentServiceError('The AniList content identifier is invalid.', { code: 'NOT_FOUND', status: 404 });
  }
  const key = `anilist:detail:${numericId}`;
  const { value, stale } = await getOrSet(key, detailPolicy, async () => {
    const data = await aniListRequest<{ Media?: AniListMedia }>(detailQuery, { id: numericId });
    if (!data.Media) throw new ContentServiceError('The anime title was not found.', { code: 'NOT_FOUND', status: 404 });
    const item = mapAniList(data.Media);
    // Phase 7F+ v3: look up TMDB ID AND IMDb ID for AniList-native anime so
    // normal providers (VidSrc/VidLink) can resolve via TMDB or IMDb ID.
    // This is a best-effort, cached title search with scoring-based matching.
    // If TMDB is unavailable or no confident match is found, the IDs stay
    // undefined and normal providers return MISSING_IDENTIFIER — the fallback
    // walker then tries Yenime (which uses MAL ID).
    if (!item.externalIds?.tmdb) {
      try {
        const { findTmdbResolution } = await import('./tmdb-id-resolver');
        const resolution = await findTmdbResolution(item.title, item.year, item.animeFormat);
        if (resolution.tmdbId || resolution.imdbId) {
          item.externalIds = {
            ...(item.externalIds ?? {}),
            ...(resolution.tmdbId ? { tmdb: resolution.tmdbId } : {}),
            ...(resolution.imdbId ? { imdb: resolution.imdbId } : {})
          };
        }
      } catch {
        // TMDB lookup is best-effort. If it fails, the item is returned
        // without TMDB/IMDb IDs. Normal providers will return
        // MISSING_IDENTIFIER, and the fallback walker tries Yenime.
      }
    }
    const recommendations = (data.Media.relations?.edges ?? []).filter((edge) => edge.node && ['SEQUEL', 'PREQUEL', 'SIDE_STORY', 'SPIN_OFF'].includes(edge.relationType ?? '')).slice(0, 6).map((edge) => mapAniList(edge.node!, 'Related anime'));
    return { ...item, recommendations };
  });
  return { ...value, source: { ...value.source, stale } };
}

/**
 * Phase 7F+ (anime routing): best-effort lookup of AniList + MAL IDs for a
 * TMDB-tagged anime title. Used by the resolver pipeline when a TMDB-tagged
 * anime movie (e.g. Demon Slayer: Infinity Castle) or anime series (e.g.
 * Attack on Titan) needs to reach an anime-only provider (MegaPlay/Yenime)
 * that requires an anime-specific identifier.
 *
 * Performs a single AniList GraphQL `Page(search: title, type: ANIME)` query
 * and returns the first match's AniList ID and MAL ID. Cached via the
 * standard AniList cache (list policy: 6 minutes fresh, 20 minutes stale).
 *
 * Returns `{ anilist: undefined, mal: undefined }` when no match is found
 * — the caller (resolver) then returns `MISSING_IDENTIFIER` for providers
 * that require an anime ID, and the fallback walker tries the next
 * eligible provider.
 *
 * This is a best-effort lookup. Title collisions (rare but possible) are
 * mitigated by the AniList search algorithm which ranks by popularity.
 * A wrong match would still produce a playable embed, just for the wrong
 * anime — the user can manually switch providers.
 */
export async function findAniListByTitle(title: string, year?: number): Promise<{ anilist?: string; mal?: string }> {
  const normalized = title.trim();
  if (!normalized) return {};
  const cacheKey = `anilist:by-title:${normalized.toLowerCase()}:${year ?? ''}`;
  const { value } = await getOrSet(cacheKey, listPolicy, async () => {
    const data = await aniListRequest<AniListPage>(listQuery, { page: 1, search: normalized });
    const pageData = data.Page;
    const media = pageData?.media ?? [];
    if (!media.length) return { anilist: undefined, mal: undefined };
    // Prefer exact year match if available, else fall back to the first
    // popularity-ranked result.
    const byYear = year ? media.find((item) => item.seasonYear === year || item.startDate?.year === year) : undefined;
    const match = byYear ?? media[0];
    return { anilist: String(match.id), mal: match.idMal ? String(match.idMal) : undefined };
  });
  return value;
}

export const anilistInternals = { mapAniList, stripDescription };
