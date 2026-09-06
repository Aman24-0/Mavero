import { getOrSet } from '../cache';
import { tmdbRequest } from './tmdb';
import { env } from '$env/dynamic/private';

/**
 * TMDB ID resolver for AniList-native anime — Phase 7F+ v2/v3.
 *
 * AniList provides AniList + MAL IDs but NOT TMDB IDs. Normal providers
 * (VidSrc, VidLink) require TMDB or IMDb IDs. This module resolves the TMDB ID
 * by searching TMDB by title, using the anime's year and format (movie
 * vs TV) to narrow the search. After finding the TMDB ID, it also fetches
 * the IMDb external ID (via TMDB's /movie/{id}/external_ids or
 * /tv/{id}/external_ids endpoint) so providers that use identifier_mode='imdb_id'
 * can also resolve.
 *
 * Results are cached for 24 hours (anime-to-TMDB mappings rarely change).
 * Stale-while-revalidate is 7 days.
 *
 * IMPORTANT: This module uses the shared `tmdbRequest` function from the main
 * TMDB adapter (tmdb.ts) — NOT a separate fetch. This ensures the same
 * authentication, 401/403 fallback, and error handling as the main adapter.
 * A previous version used its own `fetchJson` calls with Bearer-only auth,
 * which silently failed when the production TMDB credential was a v3 API key
 * (a common Netlify misconfiguration that the main adapter handles via
 * 401→api_key fallback).
 */

const resolverPolicy = { ttlMs: 1000 * 60 * 60 * 24, staleWhileRevalidateMs: 1000 * 60 * 60 * 24 * 7 };

type TmdbSearchItem = {
  id?: number;
  title?: string;
  name?: string;
  original_title?: string;
  original_name?: string;
  release_date?: string;
  first_air_date?: string;
  genre_ids?: number[];
  poster_path?: string | null;
  backdrop_path?: string | null;
  overview?: string;
  vote_average?: number;
  popularity?: number;
};

type TmdbSearchResult = {
  page?: number;
  total_pages?: number;
  total_results?: number;
  results?: TmdbSearchItem[];
};

type TmdbExternalIds = {
  imdb_id?: string | null;
};

function requireCredentials(): boolean {
  return Boolean(env.TMDB_READ_ACCESS_TOKEN || env.TMDB_API_KEY);
}

async function tmdbSearch(query: string, type: 'movie' | 'tv'): Promise<TmdbSearchResult | null> {
  if (!requireCredentials()) return null;

  try {
    return await tmdbRequest<TmdbSearchResult>(`/search/${type}`, {
      query,
      include_adult: 'false',
      language: 'en-US'
    });
  } catch {
    return null;
  }
}

async function tmdbExternalIds(tmdbId: string, type: 'movie' | 'tv'): Promise<string | undefined> {
  if (!requireCredentials()) return undefined;

  try {
    const result = await tmdbRequest<TmdbExternalIds>(`/${type}/${tmdbId}/external_ids`);
    return result.imdb_id || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Normalize a title for comparison. Lowercases, trims, removes common
 * suffixes/particles that differ between AniList and TMDB.
 */
function normalizeTitle(title: string): string {
  return title.toLowerCase().trim()
    .replace(/\(.*?\)/g, '') // Remove parentheticals like "(2011)"
    .replace(/:.*$/, '') // Remove subtitles after colon
    .replace(/season \d+/g, '')
    .replace(/part \d+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export type TmdbResolution = {
  tmdbId?: string;
  imdbId?: string;
};

/**
 * Find the TMDB ID for an anime title by searching TMDB.
 *
 * Uses title + year matching to find the correct result. After finding
 * the TMDB ID, also fetches the IMDb external ID so providers with
 * identifier_mode='imdb_id' can resolve.
 *
 * @param title The anime title (English preferred, from AniList).
 * @param year The anime's year (for disambiguation).
 * @param animeFormat The anime format ('movie' or 'series'). Determines whether
 *   to search TMDB's /search/movie or /search/tv endpoint.
 * @returns `{ tmdbId, imdbId }` — both may be undefined if no match found.
 */
export async function findTmdbIdByTitle(title: string, year?: number, animeFormat?: 'movie' | 'series'): Promise<string | undefined> {
  const resolution = await findTmdbResolution(title, year, animeFormat);
  return resolution.tmdbId;
}

/**
 * Full TMDB resolution: finds TMDB ID + IMDb ID for an anime title.
 * Used by the AniList adapter to populate externalIds.tmdb and externalIds.imdb.
 */
export async function findTmdbResolution(title: string, year?: number, animeFormat?: 'movie' | 'series'): Promise<TmdbResolution> {
  const normalized = title.trim();
  if (!normalized) return {};

  // Default to 'tv' for anime without an explicit format (most anime are TV).
  const searchType: 'movie' | 'tv' = animeFormat === 'movie' ? 'movie' : 'tv';
  const cacheKey = `tmdb-resolution:${searchType}:${normalized.toLowerCase()}:${year ?? ''}`;

  const { value } = await getOrSet(cacheKey, resolverPolicy, async () => {
    const result = await tmdbSearch(normalized, searchType);
    if (!result?.results?.length) return {} as TmdbResolution;

    const items = result.results.filter((item) => typeof item.id === 'number' && item.id > 0);
    if (!items.length) return {} as TmdbResolution;

    const normalizedSearch = normalizeTitle(normalized);

    // Scoring: prefer exact title match + year match, then exact title, then year, then popularity.
    let bestMatch: TmdbSearchItem | undefined;
    let bestScore = -1;

    for (const item of items) {
      const itemTitle = normalizeTitle(item.name || item.title || item.original_name || item.original_title || '');
      const dateStr = searchType === 'movie' ? item.release_date : item.first_air_date;
      const itemYear = Number(dateStr?.slice(0, 4));

      let score = 0;
      // Exact title match
      if (itemTitle === normalizedSearch) score += 100;
      // Title contains the search term
      else if (itemTitle.includes(normalizedSearch)) score += 50;
      else if (normalizedSearch.includes(itemTitle) && itemTitle.length >= 3) score += 30;

      // Year match (exact)
      if (year && Number.isFinite(itemYear) && itemYear === year) score += 40;
      // Year within 1 year (for season start date differences)
      else if (year && Number.isFinite(itemYear) && Math.abs(itemYear - year) <= 1) score += 20;

      // Popularity bonus (prefer more popular results)
      const popularity = Number(item.popularity) || 0;
      score += Math.min(popularity / 100, 10);

      if (score > bestScore) {
        bestScore = score;
        bestMatch = item;
      }
    }

    if (!bestMatch || bestScore < 30) {
      // No confident match — don't return a wrong ID
      return {} as TmdbResolution;
    }

    const tmdbId = String(bestMatch.id);

    // Fetch IMDb ID from TMDB external_ids endpoint
    let imdbId: string | undefined;
    try {
      imdbId = await tmdbExternalIds(tmdbId, searchType);
    } catch {
      // IMDb lookup is best-effort
    }

    return { tmdbId, imdbId } as TmdbResolution;
  });

  return value;
}
