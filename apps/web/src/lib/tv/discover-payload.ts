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
 * STAGE 4 ADDITIONS (all widget-only):
 *   - HERO IMAGE WEIGHT. The API's `backdropHero` is a TMDB ORIGINAL-size
 *     image (1.3+ MB each; the web pays it on a big pipe). On the TV the
 *     hero <picture> selected it at (min-width: 641px) — six multi-MB
 *     downloads over TV WiFi was the direct cause of the "spotlight shows
 *     no image" + "~10 s to first data" feedback. Every TV item's
 *     backdropHero is therefore DOWNgraded to the w1280 backdrop (~210 KB,
 *     still sharp at 1080p) — the rails keep w342/w500 posters untouched.
 *   - IN-MEMORY TTL CACHE + IN-FLIGHT DEDUPE. Module-level state: a fresh
 *     payload (≤3 min) is served instantly; concurrent callers share one
 *     in-flight fetch; failed payloads are never cached (the next call
 *     retries). This is what makes back-navigation instant on the TV.
 *   - BOOT PREFETCH. `prefetchTvDiscoverPayload()` is invoked at bundle
 *     evaluation (hooks.client.ts) — the payload is already in flight (or
 *     already cached) by the time DiscoverPage mounts, so the TV shows
 *     real rails as early as the network allows.
 *
 * FAILURE CONTRACT: never throws. Every fetch is individually guarded; a
 * failed source degrades (rail fallbacks, honest errorMessage) and the
 * failure is surfaced via the TV status strip (URL + error) — the page's
 * empty-state remains the fallback when everything fails.
 */

import type { MediaItem } from '$data/content';
import { IS_WGT_BUILD } from '$lib/shared/build-mode';
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

// ---------------------------------------------------------------------------
// STAGE 4 — TV image-weight policy.
//
// `backdropHero` from the API points at TMDB `t/p/original/` — 1.3–5 MB per
// slide. The TV hero <picture> picks it on every viewport ≥641px, so the
// spotlight backdrop arrived seconds (or never, on WiFi) after the text —
// the reported "hero shows title/description but NO image". The TV serves
// 1080p screens: w1280 (~210 KB) is visually equivalent there. Downgrading
// the TV payload's backdropHero keeps the shared <picture> markup and the
// production web app untouched while every TV hero loads w1280.
// ---------------------------------------------------------------------------
function downgradeHeroImages(item: MediaItem): MediaItem {
  if (!item || typeof item !== 'object') return item;
  const backdrop = typeof item.backdrop === 'string' ? item.backdrop : '';
  const fallback = backdrop || item.backdropSmall || item.poster;
  return { ...item, backdropHero: fallback || item.backdropHero };
}

function normalizeItems(items: MediaItem[]): MediaItem[] {
  return items.map(downgradeHeroImages);
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
  const movies = normalizeItems(itemsOf(discoverMovies).length ? itemsOf(discoverMovies) : homeMovies);
  const seriesFromDiscover = itemsOf(discoverSeries);
  const series = normalizeItems(
    seriesFromDiscover.length ? seriesFromDiscover : dedupeById([...homeAiring, ...homePopularSeries])
  );
  const anime = normalizeItems(itemsOf(discoverAnime));

  const heroItems = normalizeItems(buildHeroLineup(movies, series));
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

// ---------------------------------------------------------------------------
// STAGE 4 — TTL cache + in-flight dedupe + boot prefetch.
//
// The Stage-2 TV feedback measured ~10 s from launch to first rails. The
// endpoint roundtrips are ~1–2 s; the rest was hydration ordering + six
// original-size hero downloads. The cache shaves every reload/back-nav, the
// in-flight promise dedupes the boot prefetch with the page's own mount
// fetch, and the prefetch call at bundle evaluation overlaps the network
// with the entire boot chain.
// ---------------------------------------------------------------------------

const PAYLOAD_TTL_MS = 180000; // 3 min — matches the web app's batch rail TTL

let cachedPayload: TvDiscoverPayload | null = null;
let cachedAt = 0;
let inFlight: Promise<TvDiscoverPayload> | null = null;

function isFresh(): boolean {
  return cachedPayload !== null && Date.now() - cachedAt < PAYLOAD_TTL_MS;
}

/** Cache-backed payload fetch — shared by the boot prefetch and page loads. */
export function fetchTvDiscoverPayloadCached(): Promise<TvDiscoverPayload> {
  if (isFresh()) return Promise.resolve(cachedPayload as TvDiscoverPayload);
  if (inFlight) return inFlight;
  inFlight = fetchTvDiscoverPayload()
    .then((payload) => {
      // Only SUCCESSFUL payloads are cached — a total failure (errorMessage
      // set, nothing loaded) must retry on the next call, not stick for 3 min.
      if (!payload.errorMessage) {
        cachedPayload = payload;
        cachedAt = Date.now();
      }
      return payload;
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

/** Fire-and-forget boot prefetch (hooks.client.ts). Never throws. */
export function prefetchTvDiscoverPayload(): void {
  if (!IS_WGT_BUILD) return; // production: dead branch (compile-time flag)
  try {
    void fetchTvDiscoverPayloadCached().catch(() => undefined);
  } catch {
    /* the prefetch must never break boot */
  }
}
