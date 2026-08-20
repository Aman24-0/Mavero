import { getTmdbDetail, getTmdbDiscover, searchTmdb } from './adapters/tmdb';
import { getAniListDetail, getAniListDiscover, searchAniList } from './adapters/anilist';
import { media } from '$data/content';
import type { ContentList, ContentSearchResult, ContentType, NormalizedMediaItem } from './types';
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
    if (type === 'anime') return await getAniListDiscover(page);
    return await getTmdbDiscover(type, page);
  } catch (error) {
    if (!canFallback(error)) throw error;
    return { items: fixturesFor(type), page, hasNextPage: false, source: { provider: 'fixtures', fetchedAt: new Date().toISOString(), stale: true } };
  }
}

export async function search(query: string, type?: ContentType, page = 1): Promise<ContentSearchResult> {
  const normalized = query.trim();
  if (!normalized) return { query: normalized, items: [], page, hasNextPage: false, source: fixtureSource() };
  try {
    if (type === 'anime') {
      const result = await searchAniList(normalized, page);
      return { ...result, query: normalized };
    }
    if (type === 'movie' || type === 'series') {
      const result = await searchTmdb(normalized, type, page);
      return { ...result, query: normalized };
    }

    const [movies, series, anime] = await Promise.allSettled([searchTmdb(normalized, 'movie', page), searchTmdb(normalized, 'series', page), searchAniList(normalized, page)]);
    const fulfilled = [movies, series, anime].filter((result): result is PromiseFulfilledResult<ContentList> => result.status === 'fulfilled');
    if (!fulfilled.length) throw new ContentServiceError('All content providers failed during search.', { code: 'UPSTREAM_ERROR', status: 502 });
    const sources = fulfilled.map((result) => result.value.source);
    return { query: normalized, items: fulfilled.flatMap((result) => result.value.items), page, hasNextPage: fulfilled.some((result) => result.value.hasNextPage), source: { provider: sources.every((item) => item.provider === sources[0].provider) ? sources[0].provider : 'fixtures', fetchedAt: new Date().toISOString(), stale: sources.some((item) => item.stale) } };
  } catch (error) {
    if (!canFallback(error)) throw error;
    const items = media.filter((item) => `${item.title} ${item.genres.join(' ')}`.toLowerCase().includes(normalized.toLowerCase()) && (!type || item.type === type)).map((item) => ({ ...item, source: fixtureSource() } as NormalizedMediaItem));
    return { query: normalized, items, page, hasNextPage: false, source: { provider: 'fixtures', fetchedAt: new Date().toISOString(), stale: true } };
  }
}

export async function getDetail(type: ContentType, id: string): Promise<NormalizedMediaItem> {
  try {
    if (type === 'anime') return await getAniListDetail(id.replace(/^anime-/, ''));
    return await getTmdbDetail(type, id.replace(/^(movie|series)-/, ''));
  } catch (error) {
    const fixture = fixtureDetail(type, id);
    if (fixture && canFallback(error)) return { ...fixture, source: { ...fixture.source, stale: true } };
    throw error;
  }
}

export function getFixtureContent(type: ContentType) {
  return fixturesFor(type);
}

export const contentServiceInternals = { fixturesFor, fixtureDetail, canFallback };
