import { getOrSet } from '../cache';
import { fetchJson } from '../http';
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
 * This is a best-effort lookup. If TMDB is unavailable, has no API key
 * configured, or returns no match, the function returns `undefined`.
 * The caller (AniList adapter) leaves `externalIds.tmdb` undefined, and
 * normal providers return `MISSING_IDENTIFIER` — the fallback walker
 * then tries Yenime (which uses MAL ID).
 */

const TMDB_API_BASE = 'https://api.themoviedb.org/3';
const resolverPolicy = { ttlMs: 1000 * 60 * 60 * 24, staleWhileRevalidateMs: 1000 * 60 * 60 * 24 * 7 };

type TmdbSearchResult = {
  page?: number;
  total_pages?: number;
  total_results?: number;
  results?: { id?: number; title?: string; name?: string; original_title?: string; original_name?: string; release_date?: string; first_air_date?: string; genre_ids?: number[]; poster_path?: string | null; backdrop_path?: string | null; overview?: string; vote_average?: number; popularity?: number }[];
};

type TmdbExternalIds = {
  imdb_id?: string | null;
};

function requireCredentials(): { token: string; apiKey: string } | null {
  const token = env.TMDB_READ_ACCESS_TOKEN;
  const apiKey = env.TMDB_API_KEY;
  if (!token && !apiKey) return null;
  return { token: token ?? '', apiKey: apiKey ?? '' };
}

function buildUrl(path: string, params: Record<string, string> = {}): URL {
  const url = new URL(`${TMDB_API_BASE}${path}`);
  const creds = requireCredentials();
  if (creds?.token) {
    // Bearer token auth (v4)
  } else if (creds?.apiKey) {
    url.searchParams.set('api_key', creds.apiKey);
  }
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return url;
}

function authHeaders(): Record<string, string> {
  const creds = requireCredentials();
  const headers: Record<string, string> = { accept: 'application/json' };
  if (creds?.token) {
    headers.authorization = `Bearer ${creds.token}`;
  }
  return headers;
}

async function tmdbSearch(query: string, type: 'movie' | 'tv'): Promise<TmdbSearchResult | null> {
  if (!requireCredentials()) return null;

  const url = buildUrl(`/search/${type}`, {
    query,
    include_adult: 'false',
    language: 'en-US'
  });

  try {
    return await fetchJson<TmdbSearchResult>(url.toString(), { headers: authHeaders(), timeoutMs: 8000 });
  } catch {
    return null;
  }
}

async function tmdbExternalIds(tmdbId: string, type: 'movie' | 'tv'): Promise<string | undefined> {
  if (!requireCredentials()) return undefined;

  const url = buildUrl(`/${type}/${tmdbId}/external_ids`);

  try {
    const result = await fetchJson<TmdbExternalIds>(url.toString(), { headers: authHeaders(), timeoutMs: 8000 });
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
    let bestMatch: typeof items[0] | undefined;
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
