import { getOrSet } from '../cache';
import { fetchJson } from '../http';
import { env } from '$env/dynamic/private';

/**
 * TMDB ID resolver for AniList-native anime — Phase 7F+ v2.
 *
 * AniList provides AniList + MAL IDs but NOT TMDB IDs. Normal providers
 * (VidSrc, VidLink) require TMDB IDs. This module resolves the TMDB ID
 * by searching TMDB by title, using the anime's year and format (movie
 * vs TV) to narrow the search.
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
  results?: { id?: number; title?: string; name?: string; original_title?: string; original_name?: string; release_date?: string; first_air_date?: string; genre_ids?: number[]; poster_path?: string | null; backdrop_path?: string | null }[];
};

function requireCredentials(): { token: string; apiKey: string } | null {
  const token = env.TMDB_READ_ACCESS_TOKEN;
  const apiKey = env.TMDB_API_KEY;
  if (!token && !apiKey) return null;
  return { token: token ?? '', apiKey: apiKey ?? '' };
}

async function tmdbSearch(query: string, type: 'movie' | 'tv'): Promise<TmdbSearchResult | null> {
  const creds = requireCredentials();
  if (!creds) return null;

  const url = new URL(`${TMDB_API_BASE}/search/${type}`);
  url.searchParams.set('query', query);
  url.searchParams.set('include_adult', 'false');
  url.searchParams.set('language', 'en-US');

  const headers: Record<string, string> = { accept: 'application/json' };
  if (creds.token) {
    headers.authorization = `Bearer ${creds.token}`;
  } else {
    url.searchParams.set('api_key', creds.apiKey);
  }

  try {
    return await fetchJson<TmdbSearchResult>(url.toString(), { headers, timeoutMs: 8000 });
  } catch {
    return null;
  }
}

/**
 * Find the TMDB ID for an anime title by searching TMDB.
 *
 * @param title The anime title (English preferred, from AniList).
 * @param year The anime's year (for disambiguation).
 * @param animeFormat The anime format ('movie' or 'series'). Determines whether
 *   to search TMDB's /search/movie or /search/tv endpoint.
 * @returns The TMDB ID as a string, or `undefined` if no match found.
 */
export async function findTmdbIdByTitle(title: string, year?: number, animeFormat?: 'movie' | 'series'): Promise<string | undefined> {
  const normalized = title.trim();
  if (!normalized) return undefined;

  // Default to 'series' for anime without an explicit format (most anime are TV).
  const searchType: 'movie' | 'tv' = animeFormat === 'movie' ? 'movie' : 'tv';
  const cacheKey = `tmdb-id-resolver:${searchType}:${normalized.toLowerCase()}:${year ?? ''}`;

  const { value } = await getOrSet(cacheKey, resolverPolicy, async () => {
    const result = await tmdbSearch(normalized, searchType);
    if (!result?.results?.length) return undefined;

    // Prefer results whose release year matches the anime's year.
    // If no year match, fall back to the first (highest popularity) result.
    const items = result.results.filter((item) => typeof item.id === 'number' && item.id > 0);
    if (!items.length) return undefined;

    const byYear = year
      ? items.find((item) => {
          const dateStr = searchType === 'movie' ? item.release_date : item.first_air_date;
          const itemYear = Number(dateStr?.slice(0, 4));
          return Number.isFinite(itemYear) && itemYear === year;
        })
      : undefined;

    const match = byYear ?? items[0];
    return String(match.id);
  });

  return value;
}
