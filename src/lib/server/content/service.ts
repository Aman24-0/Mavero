import { getTmdbCollection, getTmdbDetail, getTmdbDiscover, getTmdbPopular, getTmdbTrendingMoviesByLanguage, searchTmdb, getTmdbSeason } from './adapters/tmdb';
import { getAniListCollection, getAniListDetail, getAniListDiscover, getAniListTrending, searchAniList } from './adapters/anilist';
import { media } from '$data/content';
import type { CollectionFilters, ContentDetail, ContentList, ContentSearchResult, ContentType, NormalizedMediaItem, SearchFilters } from './types';
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

function boundedLog(value: number | undefined, divisor: number) {
  if (!value || value <= 0) return 0;
  return Math.min(1, Math.log10(value + 1) / divisor);
}

type RankableMedia = Pick<NormalizedMediaItem, 'id' | 'title' | 'year' | 'type' | 'rating' | 'genres' | 'description' | 'poster' | 'backdrop'> & Partial<Pick<NormalizedMediaItem, 'popularity' | 'voteCount'>>;

function audienceConfidence(item: RankableMedia) {
  const rating = Math.max(0, Math.min(1, item.rating / 10));
  const votes = boundedLog(item.voteCount, item.type === 'anime' ? 5 : 4.5);
  const popularity = boundedLog(item.popularity, item.type === 'anime' ? 5.5 : 3.5);
  return rating * 0.35 + votes * 0.35 + popularity * 0.30;
}

function isUsableItem(item: RankableMedia) {
  return Boolean(
    item.id.trim() &&
    item.title.trim() &&
    !/^untitled(?: anime)?$/i.test(item.title.trim()) &&
    ['movie', 'series', 'anime'].includes(item.type) &&
    (item.poster.trim() || item.backdrop.trim()) &&
    item.description.trim() &&
    Number.isFinite(item.rating) &&
    Number.isFinite(item.year) &&
    item.year > 1800
  );
}

function uniqueUsableItems<T extends RankableMedia>(items: T[]) {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (!isUsableItem(item)) return false;
    const key = `${item.type}:${item.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function rankForExposure(items: NormalizedMediaItem[], mode: 'for-you' | 'top-rated' | 'newest' = 'for-you') {
  return uniqueUsableItems(items).sort((left, right) => {
    if (mode === 'newest' && right.year !== left.year) return right.year - left.year;
    const score = audienceConfidence(right) - audienceConfidence(left);
    if (Math.abs(score) > 0.0001) return score;
    if (right.rating !== left.rating) return right.rating - left.rating;
    return left.title.localeCompare(right.title);
  });
}

function featuredConfidence(item: RankableMedia) {
  const overviewBonus = item.description.length >= 32 && !/no synopsis|no description/i.test(item.description) ? 0.08 : 0;
  const backdropBonus = item.backdrop ? 0.2 : 0;
  return audienceConfidence(item) + overviewBonus + backdropBonus;
}

export function selectFeatured<T extends RankableMedia>(items: T[]) {
  return uniqueUsableItems(items).sort((left, right) => {
    const score = featuredConfidence(right) - featuredConfidence(left);
    if (Math.abs(score) > 0.0001) return score;
    return left.title.localeCompare(right.title);
  })[0];
}

export async function discover(type: ContentType, page = 1): Promise<ContentList> {
  try {
    if (type === 'anime') {
      const result = await getAniListTrending(page);
      return { ...result, items: rankForExposure(result.items) };
    }
    const result = await getTmdbDiscover(type, page);
    return { ...result, items: rankForExposure(result.items) };
  } catch (error) {
    if (!canFallback(error)) throw error;
    return { items: fixturesFor(type), page, hasNextPage: false, source: { provider: 'fixtures', fetchedAt: new Date().toISOString(), stale: true } };
  }
}

export async function collection(type: ContentType, page = 1, filters: CollectionFilters = {}): Promise<ContentList> {
  try {
    if (type === 'anime') {
      const result = await getAniListCollection(page, filters);
      return { ...result, items: rankForExposure(result.items, filters.sort === 'Top rated' ? 'top-rated' : filters.sort === 'Newest' ? 'newest' : 'for-you') };
    }
    const result = await getTmdbCollection(type, page, filters);
    return { ...result, items: rankForExposure(result.items, filters.sort === 'Top rated' ? 'top-rated' : filters.sort === 'Newest' ? 'newest' : 'for-you') };
  } catch (error) {
    if (!canFallback(error)) throw error;
    return { items: fixturesFor(type).slice(0, 20), page, hasNextPage: false, source: { provider: 'fixtures', fetchedAt: new Date().toISOString(), stale: true } };
  }
}

export async function popular(type: ContentType, page = 1): Promise<ContentList> {
  try {
    if (type === 'anime') {
      const result = await getAniListDiscover(page);
      return { ...result, items: rankForExposure(result.items) };
    }
    const result = await getTmdbPopular(type, page);
    return { ...result, items: rankForExposure(result.items) };
  } catch (error) {
    if (!canFallback(error)) throw error;
    return { items: fixturesFor(type), page, hasNextPage: false, source: { provider: 'fixtures', fetchedAt: new Date().toISOString(), stale: true } };
  }
}

// Trending movies for one or more original languages (Discover "Trending
// Movies — Hindi" / "Trending Movies — Regional").
//
// - Movie only, popularity-ordered via the shared TMDB discover query
//   (getTmdbTrendingMoviesByLanguage), so TMDB filters server-side.
// - Multi-language rails (Indian regional languages) run one bounded,
//   cached query per language in parallel — TMDB has no multi-value
//   with_original_language filter — then merge, deduplicate by content id
//   and rank with the same recognition-aware ranking as every other rail.
// - Hindi exclusion for the Regional rail is by construction: the caller
//   never passes 'hi' in the language list, and each query is strictly
//   single-language, so the two rails cannot duplicate each other.
// - No fixture fallback here: a failure or empty result must never be
//   presented as catalog content — the caller hides the rail instead.
export async function trendingMoviesByLanguages(languages: string[], page = 1): Promise<ContentList> {
  const normalized = [...new Set(languages.map((language) => language.trim().toLowerCase()).filter(Boolean))];
  if (!normalized.length) {
    throw new ContentServiceError('No movie languages were requested.', { code: 'NOT_FOUND', status: 404 });
  }
  const results = await Promise.allSettled(normalized.map((language) => getTmdbTrendingMoviesByLanguage(language, page)));
  const fulfilled = results.filter((result): result is PromiseFulfilledResult<ContentList> => result.status === 'fulfilled').map((result) => result.value);
  if (!fulfilled.length) {
    const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')?.reason;
    throw failure instanceof ContentServiceError ? failure : new ContentServiceError('The content provider returned an upstream error.', { code: 'UPSTREAM_ERROR', status: 502 });
  }
  const seen = new Set<string>();
  const merged = fulfilled
    .flatMap((result) => result.items)
    .filter((item) => {
      if (seen.has(item.id)) return false;
      seen.add(item.id);
      return true;
    });
  merged.sort((left, right) => (right.popularity ?? 0) - (left.popularity ?? 0));
  return {
    items: rankForExposure(merged),
    page,
    hasNextPage: fulfilled.some((result) => result.hasNextPage),
    source: { ...fulfilled[0].source, stale: fulfilled.some((result) => result.source.stale) }
  };
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

export const contentServiceInternals = { fixturesFor, fixtureDetail, canFallback, audienceConfidence, rankForExposure, isUsableItem, uniqueUsableItems, selectFeatured };
