/**
 * TV watch-route data — PLAY CRASH FIX (widget build only).
 *
 * THE BUG (TV feedback 0 — critical): pressing PLAY on a movie threw
 *   Uncaught TypeError: Cannot read property 'id' of undefined (app.js)
 * because the watch route's +page.server.ts is STASHED in the static-SPA
 * .wgt: `data.item` / `data.streamingConfig` / `data.episodes` were all
 * undefined, and the page's reactive chain (`item.id`, `item.isAnime`,
 * `data.streamingConfig.categories`, …) dereferenced them on init.
 *
 * THE FIX: this module rebuilds the EXACT page-load shape
 *   { item, streamingConfig, episodes }
 * from the deployed production API before the player mounts:
 *   - detail      → /api/tv/content/[type]/[id]  (the same toMediaItem
 *                   projection the web watch load returns, incl. seasonsData)
 *   - config      → /api/streaming/config        (public, credential-less;
 *                   TV CORS opened header-only for this path)
 *   - episodes    → derived client-side from item.seasonsData — the SAME
 *                   fallback the shared watch-loader uses when the season
 *                   fetch returns nothing (watch-loader.ts:242).
 *
 * FAILURE CONTRACT: never throws — `undefined` on any failure. The route
 * renders a TV standby/error card and Back still works; the Play press can
 * NEVER crash the app again.
 */

import type { MediaItem, Episode } from '$data/content';
import { IS_WGT_BUILD } from '$lib/shared/build-mode';
import { TV_API_BASE } from './api-base';
import { showTvStatus } from './status';
import { fetchTvDetail, type TvDetailType } from './detail';

type StreamingConfigResponse = {
  ok?: boolean;
  config?: {
    version?: number;
    updatedAt?: string;
    providers?: unknown[];
    sources?: unknown[];
    categories?: unknown[];
    sourceCategories?: unknown[];
    defaults?: Record<string, string>;
    defaultsOrder?: Record<string, string[]>;
  };
};

/** The subset of the watch page-load shape the route's reactive chain reads. */
export type TvWatchData = {
  item: MediaItem;
  streamingConfig: NonNullable<StreamingConfigResponse['config']>;
  episodes: Episode[];
};

/** Public route type ('movie' | 'tv-show' | 'anime-movie' | 'anime-series' |
 *  legacy 'series' | 'anime') → the TV detail endpoint's type union. */
function tvDetailTypeFor(routeType: string): TvDetailType {
  switch (routeType) {
    case 'tv-show':
    case 'series':
      return 'series';
    case 'anime':
    case 'anime-series':
      return 'anime';
    case 'anime-movie':
    case 'movie':
    default:
      return 'movie';
  }
}

/** Guarded JSON GET — undefined on ANY failure (mirrors discover-payload). */
async function fetchJsonGuarded(url: string, what: string): Promise<unknown | undefined> {
  try {
    const controller = new AbortController();
    const abortTimer = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(url, { signal: controller.signal, headers: { accept: 'application/json' } });
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

const EMPTY_STREAMING_CONFIG = {
  version: 1 as const,
  updatedAt: '1970-01-01T00:00:00.000Z',
  providers: [],
  sources: [],
  categories: [],
  sourceCategories: [],
  defaults: {},
  defaultsOrder: {}
};

/**
 * Fetch the watch page-load shape for a route type + id. NEVER throws —
 * undefined means "could not load" (the route shows its standby/error card
 * and the app keeps running).
 */
export async function fetchTvWatchData(
  routeType: string,
  id: string
): Promise<TvWatchData | undefined> {
  if (!IS_WGT_BUILD) return undefined; // production: dead branch (compile-time flag)
  if (!routeType || !id) return undefined;

  const detailType = tvDetailTypeFor(routeType);
  // Detail + streaming config in PARALLEL (the page load's Promise.all shape).
  const [item, configResponse] = await Promise.all([
    fetchTvDetail(detailType, id),
    fetchJsonGuarded(`${TV_API_BASE}/api/streaming/config`, 'streaming config') as Promise<StreamingConfigResponse | undefined>
  ]);
  if (!item) return undefined; // the standby card + Back are the fallback

  const config = configResponse?.ok && configResponse.config ? configResponse.config : EMPTY_STREAMING_CONFIG;
  // Episodes: the SAME client-side fallback the shared watch-loader uses —
  // the detail payload's seasonsData flattened (movie → no seasonsData → []).
  let episodes: Episode[] = [];
  try {
    episodes = item.seasonsData?.flatMap((season) => season.episodes ?? []) ?? [];
  } catch {
    episodes = [];
  }
  return { item, streamingConfig: config, episodes };
}
