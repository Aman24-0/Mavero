import { getOrSet } from '../cache';
import { asNumber, asString, fetchJson } from '../http';
import { ContentServiceError, type Episode, type Season } from '../types';

/**
 * Jikan (MyAnimeList unofficial REST API) adapter — Phase 7F+.
 *
 * Used to fetch real anime episode metadata (title, synopsis, air date,
 * thumbnail) that AniList does not expose. AniList provides only an
 * `episodes: number` count; Jikan provides the actual episode objects.
 *
 * API: https://api.jikan.moe/v4/anime/{mal_id}/episodes?page=N
 *
 * Pagination: Jikan returns up to ~100 episodes per page. Long-running
 * anime (e.g. Hunter x Hunter with 148 episodes) require multiple pages.
 * This adapter fetches ALL pages up to a safe cap (10 pages = ~1000
 * episodes) to avoid unbounded requests.
 *
 * Caching: results are cached for 24 hours (anime episode lists rarely
 * change once a series finishes airing). Stale-while-revalidate is 7
 * days so a Jikan outage degrades gracefully.
 *
 * Rate limiting: Jikan has a 3 requests/second rate limit (60/min).
 * The page-by-page fetch uses sequential awaits (not Promise.all) to
 * stay under the limit. The cache ensures repeated requests for the
 * same anime don't hit Jikan at all.
 */

const JIKAN_API_BASE = 'https://api.jikan.moe/v4';
const episodePolicy = { ttlMs: 1000 * 60 * 60 * 24, staleWhileRevalidateMs: 1000 * 60 * 60 * 24 * 7 }; // 24h fresh, 7d stale
const MAX_PAGES = 10; // Safety cap — ~1000 episodes max

type JikanEpisode = {
  mal_id: number;
  title?: string | null;
  title_japanese?: string | null;
  title_romanji?: string | null;
  synopsis?: string | null;
  aired?: string | null;
  runtime?: number | null;
  // Jikan v4 episode images — may be null or an object with .jpg.image_url
  images?: { jpg?: { image_url?: string | null } | null } | null;
  filler?: boolean | null;
  recap?: boolean | null;
};

type JikanEpisodesResponse = {
  data?: JikanEpisode[];
  pagination?: {
    last_visible_page?: number;
    has_next_page?: boolean | null;
    items?: { count?: number; total?: number; per_page?: number };
  };
};

function mapJikanEpisode(raw: JikanEpisode, seasonNumber: number): Episode {
  const number = Number(raw.mal_id);
  return {
    id: `s${seasonNumber}e${number}`,
    number: Number.isFinite(number) && number > 0 ? number : 0,
    season: seasonNumber,
    title: asString(raw.title_romanji || raw.title, asString(raw.title, `Episode ${number}`)),
    overview: asString(raw.synopsis) || undefined,
    airDate: raw.aired ?? undefined,
    runtime: raw.runtime ? `${raw.runtime}m` : undefined,
    still: raw.images?.jpg?.image_url ?? undefined
  };
}

/**
 * Fetch all episodes for an anime via Jikan, paginated.
 * Returns a Season object with all episodes (treated as Season 1
 * since Jikan doesn't expose a traditional season structure).
 *
 * Returns `null` when Jikan has no episode data (e.g. the MAL ID
 * is missing, the anime is a movie, or Jikan is unavailable). The
 * caller should fall back to a generated episode list based on the
 * AniList `episodes: number` count.
 */
export async function getJikanAnimeSeason(malId: string): Promise<Season | null> {
  const numericId = Number(malId);
  if (!Number.isInteger(numericId) || numericId <= 0) return null;

  const cacheKey = `jikan:episodes:${numericId}`;
  const { value, stale } = await getOrSet(cacheKey, episodePolicy, async () => {
    const allEpisodes: JikanEpisode[] = [];
    let page = 1;
    let hasNextPage = true;

    while (hasNextPage && page <= MAX_PAGES) {
      const url = `${JIKAN_API_BASE}/anime/${numericId}/episodes?page=${page}`;
      const response = await fetchJson<JikanEpisodesResponse>(url, { timeoutMs: 10000 });
      const episodes = response.data ?? [];
      allEpisodes.push(...episodes);

      hasNextPage = Boolean(response.pagination?.has_next_page);
      page += 1;

      // If this page returned no episodes, stop to avoid infinite loops.
      if (!episodes.length) break;
    }

    if (!allEpisodes.length) return null;

    // Sort by episode number ascending (Jikan returns mal_id as the
    // episode number).
    const sorted = allEpisodes
      .filter((ep) => Number.isFinite(Number(ep.mal_id)) && Number(ep.mal_id) > 0)
      .sort((a, b) => Number(a.mal_id) - Number(b.mal_id));

    const mappedEpisodes: Episode[] = sorted.map((ep) => mapJikanEpisode(ep, 1));

    return {
      number: 1,
      title: 'Season 1',
      episodeCount: mappedEpisodes.length,
      episodes: mappedEpisodes
    };
  });

  if (stale && value) {
    return { ...value, episodes: value.episodes?.map((e) => ({ ...e })) };
  }
  return value;
}

/**
 * Generate a fallback episode list when Jikan metadata is unavailable.
 * Uses the AniList `episodes: number` count to create generic
 * "Episode 1" ... "Episode N" entries so the UI can still render an
 * episode guide and the player can navigate episodes.
 *
 * This is ONLY a fallback — real metadata comes from Jikan when
 * available.
 */
export function generateFallbackEpisodes(count: number, seasonNumber = 1): Episode[] {
  const safeCount = Math.max(0, Math.min(count, 1000));
  if (safeCount === 0) return [];
  return Array.from({ length: safeCount }, (_, index) => ({
    id: `s${seasonNumber}e${index + 1}`,
    number: index + 1,
    season: seasonNumber,
    title: `Episode ${index + 1}`,
    overview: undefined,
    airDate: undefined,
    runtime: undefined,
    still: undefined
  }));
}

export const jikanInternals = { mapJikanEpisode, generateFallbackEpisodes };
