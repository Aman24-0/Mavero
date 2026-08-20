import { getTmdbDetail, getTmdbDiscover, getTmdbPopular, getTmdbSeason, searchTmdb } from './adapters/tmdb';
import { getAniListDetail, getAniListDiscover, getAniListTrending, searchAniList } from './adapters/anilist';
import { media } from '$data/content';
import type { ContentDetail, ContentList, ContentSearchResult, ContentType, NormalizedMediaItem, SearchFilters } from './types';
import { ContentServiceError } from './types';

function fixtureSource(): NormalizedMediaItem['source'] {
  return { provider: 'fixtures', fetchedAt: new Date().toISOString() };
}

function fixturesFor(type: ContentType) {
  return media.filter((item) => item.type === type).map((item) => ({ ...item, source: fixtureSource(), externalIds: { [type === 'anime' ? 'anilist' : 'tmdb']: item.id } } as NormalizedMediaItem));
}

function fixtureDetail(type: ContentType, id: string) {
  const item = media.find((candidate) => candidate.type === type && candidate.id === id);
  if (!item) return undefined;
  return { ...item, source: fixtureSource(), externalIds: { [type === 'anime' ? 'anilist' : 'tmdb']: item.id } } as NormalizedMediaItem;
}

function isMissingConfig(error: unknown) {
  return error instanceof ContentServiceError && error.code === 'CONFIG_MISSING';
}

function canFallback(error: unknown) {
  return isMissingConfig(error) || (error instanceof ContentServiceError && ['UPSTREAM_ERROR', 'RATE_LIMITED', 'INVALID_RESPONSE'].includes(error.code));
}

export async function discover(type: ContentType, page = 1): Promise<ContentList> {
  try {
    if (type === 'anime') return await getAniListTrending(page);
    return await getTmdbDiscover(type, page);
  } catch (error) {
    if (!canFallback(error)) throw error;
    return { items: fixturesFor(type), page, hasNextPage: false, source: { provider: 'fixtures', fetchedAt: new Date().toISOString(), stale: true } };
  }
}

export async function popular(type: ContentType, page = 1): Promise<ContentList> {
  try {
    if (type === 'anime') return await getAniListDiscover(page);
    return await getTmdbPopular(type, page);
  } catch (error) {
    if (!canFallback(error)) throw error;
    return { items: fixturesFor(type), page, hasNextPage: false, source: { provider: 'fixtures', fetchedAt: new Date().toISOString(), stale: true } };
  }
}

function applyAnimeFilters(items: NormalizedMediaItem[], filters: SearchFilters) {
  let filtered = filters.genre ? items.filter((item) => item.genres.some((genre) => genre.toLowerCase() === filters.genre?.toLowerCase())) : [...items];
  if (filters.sort) filtered.sort((left, right) => (left.year - right.year) * (filters.sort === 'release-desc' ? -1 : 1));
  return filtered;
}

export async function search(query: string, type?: ContentType, page = 1, filters: SearchFilters = {}): Promise<ContentSearchResult> {
  const normalized = query.trim();
  if (!normalized) return { query: normalized, items: [], page, hasNextPage: false, filters, source: fixtureSource() };
  try {
    if (type === 'anime') {
      const result = await searchAniList(normalized, page);
      return { ...result, items: applyAnimeFilters(result.items, filters), query: normalized, filters };
    }
    if (type === 'movie' || type === 'series') {
      const result = await searchTmdb(normalized, type, page, filters);
      return { ...result, query: normalized, filters };
    }

    const [movies, series, anime] = await Promise.allSettled([searchTmdb(normalized, 'movie', page, filters), searchTmdb(normalized, 'series', page, filters), searchAniList(normalized, page)]);
    const tmdbResults = [movies, series].filter((result): result is PromiseFulfilledResult<ContentList> => result.status === 'fulfilled');
    const animeResults = anime.status === 'fulfilled' ? [anime] : [];
    if (!tmdbResults.length) {
      const failure = [movies, series].find((result): result is PromiseRejectedResult => result.status === 'rejected')?.reason;
      throw failure instanceof ContentServiceError ? failure : new ContentServiceError('TMDB search is unavailable.', { code: 'UPSTREAM_ERROR', status: 502 });
    }
    const fulfilled = [...tmdbResults, ...animeResults];
    const sources = fulfilled.map((result) => result.value.source);
    const items = applyAnimeFilters(fulfilled.flatMap((result) => result.value.items), filters);
    return { query: normalized, items, page, hasNextPage: fulfilled.some((result) => result.value.hasNextPage), filters, source: { provider: sources.every((item) => item.provider === sources[0].provider) ? sources[0].provider : 'fixtures', fetchedAt: new Date().toISOString(), stale: sources.some((item) => item.stale) } };
  } catch (error) {
    // In mixed "All" search, never present AniList/fixture data as if it were a successful TMDB catalog search.
    // Keep fixture fallback for explicit type searches and discovery/detail flows.
    if (!type && error instanceof ContentServiceError && canFallback(error)) throw error;
    if (!canFallback(error)) throw error;
    const items = media.filter((item) => `${item.title} ${item.genres.join(' ')}`.toLowerCase().includes(normalized.toLowerCase()) && (!type || item.type === type)).map((item) => ({ ...item, source: fixtureSource() } as NormalizedMediaItem));
    return { query: normalized, items, page, hasNextPage: false, filters, source: { provider: 'fixtures', fetchedAt: new Date().toISOString(), stale: true } };
  }
}

export async function getSeriesSeason(id: string, seasonNumber: number) {
  const cleanId = id.replace(/^series-/, '');
  if (/^\d+$/.test(cleanId)) return getTmdbSeason(cleanId, seasonNumber);
  const fixture = media.find((item) => item.type === 'series' && item.id === cleanId);
  const count = fixture?.episodes ?? 8;
  return {
    number: seasonNumber,
    title: `Season ${seasonNumber}`,
    episodeCount: count,
    episodes: Array.from({ length: count }, (_, index) => ({
      id: `${cleanId}-s${seasonNumber}-e${index + 1}`,
      number: index + 1,
      season: seasonNumber,
      title: `Episode ${index + 1}`,
      overview: fixture?.description,
      runtime: '44m'
    }))
  };
}

export async function getDetail(type: ContentType, id: string): Promise<ContentDetail> {
  try {
    if (type === 'anime') return await getAniListDetail(id.replace(/^anime-/, ''));
    return await getTmdbDetail(type, id.replace(/^(movie|series)-/, ''));
  } catch (error) {
    const fixture = fixtureDetail(type, id);
    if (fixture && (canFallback(error) || (error instanceof ContentServiceError && error.code === 'NOT_FOUND'))) return { ...fixture, source: { ...fixture.source, stale: true } };
    throw error;
  }
}

export function getFixtureContent(type: ContentType) {
  return fixturesFor(type);
}

export const contentServiceInternals = { fixturesFor, fixtureDetail, canFallback };
