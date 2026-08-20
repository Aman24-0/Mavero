import { env } from '$env/dynamic/private';
import { getOrSet } from '../cache';
import { asNumber, asString, asStringArray, fetchJson } from '../http';
import { ContentServiceError, type ContentList, type ContentSource, type NormalizedMediaItem } from '../types';

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
  return {
    id: `anime-${raw.id}`,
    title: titleOf(raw),
    nativeTitle: raw.title?.native ?? undefined,
    year: raw.seasonYear || raw.startDate?.year || new Date().getFullYear(),
    type: 'anime',
    maturity: raw.isAdult ? '16+' : '13+',
    runtime: runtime(raw.duration, raw.episodes),
    rating: Math.round((asNumber(raw.averageScore) / 10) * 10) / 10,
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

const detailQuery = `query ($id: Int!) {
  Media(id: $id, type: ANIME) { ${mediaFields} relations { edges { relationType node { id title { romaji english native } } } } }
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

export async function getAniListDetail(externalId: string): Promise<NormalizedMediaItem> {
  const numericId = Number(externalId);
  if (!Number.isInteger(numericId) || numericId <= 0) {
    throw new ContentServiceError('The AniList content identifier is invalid.', { code: 'NOT_FOUND', status: 404 });
  }
  const key = `anilist:detail:${numericId}`;
  const { value, stale } = await getOrSet(key, detailPolicy, async () => {
    const data = await aniListRequest<{ Media?: AniListMedia }>(detailQuery, { id: numericId });
    if (!data.Media) throw new ContentServiceError('The anime title was not found.', { code: 'NOT_FOUND', status: 404 });
    return mapAniList(data.Media);
  });
  return { ...value, source: { ...value.source, stale } };
}

export const anilistInternals = { mapAniList, stripDescription };
