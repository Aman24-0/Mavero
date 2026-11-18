/**
 * TV discover payload — STAGE 2 data wiring (widget build only).
 *
 * The static-SPA .wgt has NO server: the root (/) and /discover server
 * loads are stashed, so the pages receive `data = {}` and DiscoverPage
 * renders its honest empty state ("The shelves are quiet."). This module
 * rebuilds the EXACT props DiscoverPage consumes from the DEPLOYED
 * production API (cross-origin; every endpoint answers
 * `Access-Control-Allow-Origin: *`):
 *
 *   - /api/content/discover/movie | series | anime  → the trending rails
 *     (the same `discover()` service the web server load composes), and
 *   - /api/tv/home                                  → the TV rails
 *     (trending-movies / current-airing / popular-series) used both as a
 *     series fallback and as the M/S/M/S hero lineup source.
 *
 * The hero lineup mirrors the server's contract: up to 3 movies and 3
 * series in strict alternating order — DiscoverPage derives the hero
 * carousel DIRECTLY from `heroItems` and the featured item is its head.
 *
 * FAILURE CONTRACT: never throws. Every fetch is individually guarded; a
 * failed source degrades (rail fallbacks, honest errorMessage) and the
 * failure is surfaced via the TV status strip (URL + error) — the page's
 * empty-state remains the fallback when everything fails.
 */

import type { MediaItem } from '$data/content';
import { TV_API_BASE } from './api-base';
import { showTvStatus } from './status';

export type TvDiscoverPayload = {
  featuredItem: MediaItem | undefined;
  heroItems: MediaItem[];
  movies: MediaItem[];
  series: MediaItem[];
  anime: MediaItem[];
  errorMessage: string;
};

type TvHomeRail = { key?: string; title?: string; items?: MediaItem[] };
type TvHomeResponse = { ok?: boolean; rails?: TvHomeRail[] };
type DiscoverResponse = { ok?: boolean; items?: MediaItem[] };

/** Bounded JSON GET with a per-call failure guard. Returns undefined on ANY failure. */
async function fetchJsonGuarded(url: string, what: string): Promise<unknown | undefined> {
  try {
    const controller = new AbortController();
    const abortTimer = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: { accept: 'application/json' }
      });
      if (!response.ok) {
        showTvStatus(`TV data: ${what} failed (HTTP ${response.status})`, url);
        return undefined;
      }
      return (await response.json()) as unknown;
    } finally {
      clearTimeout(abortTimer);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    showTvStatus(`TV data: ${what} failed (${message})`, url);
    return undefined;
  }
}

function itemsOf(response: unknown): MediaItem[] {
  try {
    const payload = response as DiscoverResponse | undefined;
    const items = payload?.items;
    if (!payload?.ok || !Array.isArray(items)) return [];
    return items.filter((item): item is MediaItem => Boolean(item && typeof item === 'object'));
  } catch {
    return [];
  }
}

function railOf(response: unknown, key: string): MediaItem[] {
  try {
    const payload = response as TvHomeResponse | undefined;
    if (!payload?.ok || !Array.isArray(payload.rails)) return [];
    const rail = payload.rails.find((r) => r && r.key === key);
    if (!rail || !Array.isArray(rail.items)) return [];
    return rail.items.filter((item): item is MediaItem => Boolean(item && typeof item === 'object'));
  } catch {
    return [];
  }
}

/** Strict M/S/M/S/M/S hero lineup — up to 3 movies + 3 series, alternating. */
function buildHeroLineup(movies: MediaItem[], series: MediaItem[]): MediaItem[] {
  const heroItems: MediaItem[] = [];
  for (let i = 0; i < 3; i++) {
    if (movies[i]) heroItems.push(movies[i]);
    if (series[i]) heroItems.push(series[i]);
  }
  return heroItems;
}

function dedupeById(items: MediaItem[]): MediaItem[] {
  const seen = new Set<string>();
  const out: MediaItem[] = [];
  for (const item of items) {
    const key = `${item.type}:${item.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

export async function fetchTvDiscoverPayload(): Promise<TvDiscoverPayload> {
  const base = TV_API_BASE;
  const [home, discoverMovies, discoverSeries, discoverAnime] = await Promise.all([
    fetchJsonGuarded(`${base}/api/tv/home`, 'home rails'),
    fetchJsonGuarded(`${base}/api/content/discover/movie?page=1`, 'trending movies'),
    fetchJsonGuarded(`${base}/api/content/discover/series?page=1`, 'trending series'),
    fetchJsonGuarded(`${base}/api/content/discover/anime?page=1`, 'trending anime')
  ]);

  const homeMovies = railOf(home, 'trending-movies');
  const homeAiring = railOf(home, 'current-airing');
  const homePopularSeries = railOf(home, 'popular-series');

  // Rails: the discover endpoints are the primary source (same service the
  // web server load composes); the TV rails are the per-type fallback.
  const movies = itemsOf(discoverMovies).length ? itemsOf(discoverMovies) : homeMovies;
  const seriesFromDiscover = itemsOf(discoverSeries);
  const series = seriesFromDiscover.length
    ? seriesFromDiscover
    : dedupeById([...homeAiring, ...homePopularSeries]);
  const anime = itemsOf(discoverAnime);

  const heroItems = buildHeroLineup(movies, series);
  const hasAnyContent = movies.length > 0 || series.length > 0 || anime.length > 0 || heroItems.length > 0;

  return {
    featuredItem: heroItems[0],
    heroItems,
    movies,
    series,
    anime,
    errorMessage: hasAnyContent ? '' : 'The live catalog is temporarily unavailable. Please check the network connection and try again.'
  };
}
