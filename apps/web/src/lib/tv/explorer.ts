/**
 * TV explorer data — Movies / TV Shows / Anime pages (widget build only).
 *
 * THE BUG (TV feedback B): the three Explorer pages rendered ONLY their
 * filter chips — their +page.server.ts loads are stashed in the static-SPA
 * .wgt, so `spotlight` / `sections` / `filteredItems` all arrived empty and
 * nothing below the chips could ever render. Their filter chips also
 * NAVIGATED (?genre=…) — a navigation the widget's hash router cannot serve
 * (no server) — instead of filtering in place.
 *
 * THE FIX: this module rebuilds the Explorer payload from the deployed
 * production API (all credential-less GETs, TV CORS opened header-only):
 *
 *   - /api/content/discover/{movie,series,anime}?page=N → the spotlight
 *     lineup + the Popular section (the SAME discover service the web
 *     Explorer load composes),
 *   - /api/explorer/feed?type=…&sort=top-rated&page=N → the Top Rated
 *     section + every filtered in-place feed page (the closed genre/
 *     language/sort taxonomy validated server-side, exactly like the web).
 *
 * FAILURE CONTRACT: never throws — empty sections / undefined feeds are the
 * honest fallbacks and the TV status strip surfaces the URL + error.
 */

import type { MediaItem, ContentType } from '$data/content';
import { IS_WGT_BUILD } from '$lib/shared/build-mode';
import { TV_API_BASE } from './api-base';
import { showTvStatus } from './status';

export type TvExplorerSection = {
  key: string;
  title: string;
  items: MediaItem[];
  page: number;
  hasNextPage: boolean;
  /** Where the next page comes from: the discover endpoint (Popular) or the
   *  explorer feed (Top Rated / sorted continuations). */
  source: 'discover' | 'feed';
  /** The content type the section's NEXT page is fetched for (feed source). */
  feedType?: ContentType;
  /** The sort the section's feed continuation carries (feed source). */
  sort?: string;
  /** Optional compat fields the server-composed sections carry — the
   *  ExplorerPage each-block renders both shapes through one union. */
  showMoreHref?: string;
  episodeBadges?: Record<string, string>;
};

export type TvExplorerFilters = { genre?: string; language?: string; sort?: string };

export type TvExplorerPage = {
  spotlight: MediaItem[];
  sections: TvExplorerSection[];
  errorMessage: string;
};

type DiscoverResponse = { ok?: boolean; items?: MediaItem[] };
type FeedResponse = { ok?: boolean; items?: MediaItem[]; page?: number; hasNextPage?: boolean; totalPages?: number };

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

/**
 * TV image-weight policy (the SAME contract discover-payload applies): the
 * API's `backdropHero` is a TMDB ORIGINAL-size image (1.3–5 MB) that the TV
 * hero <picture> would pick — six multi-MB downloads over TV WiFi were the
 * reported "spotlight shows no image". The TV serves 1080p: w1280
 * (~210 KB) is visually equivalent. Posters stay untouched.
 */
function downgradeHeroImages(item: MediaItem): MediaItem {
  if (!item || typeof item !== 'object') return item;
  const backdrop = typeof item.backdrop === 'string' ? item.backdrop : '';
  const fallback = backdrop || item.backdropSmall || item.poster;
  return { ...item, backdropHero: fallback || item.backdropHero };
}

const FEED_MAX_PAGE = 20;

/**
 * The Explorer page payload for one content type: the 6-slide spotlight
 * (discover page 1, hero-downgraded) + the Popular and Top Rated sections.
 */
export async function fetchTvExplorerPage(type: ContentType): Promise<TvExplorerPage> {
  const base = TV_API_BASE;
  const [popularResponse, topRatedResponse] = await Promise.all([
    fetchJsonGuarded(`${base}/api/content/discover/${encodeURIComponent(type)}?page=1`, `${type} discover`),
    fetchJsonGuarded(`${base}/api/explorer/feed?type=${encodeURIComponent(type)}&sort=top-rated&page=1`, `${type} top rated`)
  ]);

  const popularItems = itemsOf(popularResponse);
  const topRatedItems = itemsOf(topRatedResponse).map(downgradeHeroImages);
  const spotlight = popularItems.slice(0, 6).map(downgradeHeroImages);

  const sections: TvExplorerSection[] = [];
  if (popularItems.length) {
    sections.push({
      key: `${type}-popular`,
      title: 'Popular',
      items: popularItems,
      page: 1,
      // The discover endpoint carries no hasNextPage flag — a short page
      // (19 items after server-side filtering) is NOT the last one. The
      // loader governs exhaustion: a genuinely empty page N+1 flips
      // hasNextPage off and the rail end becomes a clean hard stop.
      hasNextPage: popularItems.length > 0,
      source: 'discover',
      feedType: type
    });
  }
  if (topRatedItems.length) {
    sections.push({
      key: `${type}-top-rated`,
      title: 'Top rated',
      items: topRatedItems,
      page: 1,
      hasNextPage: Boolean((topRatedResponse as FeedResponse | undefined)?.hasNextPage),
      source: 'feed',
      feedType: type,
      sort: 'top-rated'
    });
  }

  const hasAny = spotlight.length > 0 || sections.length > 0;
  return {
    spotlight,
    sections,
    errorMessage: hasAny ? '' : `${type} catalog is temporarily unavailable.`
  };
}

/**
 * ONE in-place filtered feed page for the Explorer results grid (the SAME
 * typed contract /api/explorer/feed validates server-side). Returns the
 * whole envelope so the caller can track pagination.
 */
export async function fetchTvExplorerFeed(
  type: ContentType,
  filters: TvExplorerFilters,
  page: number
): Promise<{ items: MediaItem[]; page: number; hasNextPage: boolean; totalPages?: number } | undefined> {
  if (!IS_WGT_BUILD) return undefined; // production: dead branch (compile-time flag)
  const params = new URLSearchParams({ type, page: String(Math.max(1, Math.min(page, FEED_MAX_PAGE))) });
  if (filters.genre) params.set('genre', filters.genre);
  if (filters.language && filters.language !== 'all') params.set('language', filters.language);
  if (filters.sort) params.set('sort', filters.sort);
  const response = (await fetchJsonGuarded(
    `${TV_API_BASE}/api/explorer/feed?${params.toString()}`,
    'explorer feed'
  )) as FeedResponse | undefined;
  if (!response?.ok) return undefined;
  const items = itemsOf(response).map(downgradeHeroImages);
  return {
    items,
    page: typeof response.page === 'number' ? response.page : page,
    hasNextPage: Boolean(response.hasNextPage),
    totalPages: typeof response.totalPages === 'number' ? response.totalPages : undefined
  };
}

/**
 * The trailing SHOW MORE loader for a TV section rail: fetches the section's
 * NEXT page (discover or explorer-feed), appends into the section state and
 * returns the newly-added items. Returns null when exhausted (the button
 * then hides — the row's end is a hard stop).
 */
export function tvSectionLoader(section: TvExplorerSection): () => Promise<MediaItem[] | null> {
  return async () => {
    if (!section.hasNextPage || section.page >= FEED_MAX_PAGE) return null;
    const next = section.page + 1;
    if (section.source === 'discover') {
      const response = (await fetchJsonGuarded(
        `${TV_API_BASE}/api/content/discover/${encodeURIComponent(section.feedType ?? 'movie')}?page=${next}`,
        'discover page'
      )) as DiscoverResponse | undefined;
      const items = itemsOf(response);
      if (!items.length) {
        section.hasNextPage = false;
        return null;
      }
      section.items = [...section.items, ...items];
      section.page = next;
      if (items.length < 20 || next >= FEED_MAX_PAGE) section.hasNextPage = false;
      return items;
    }
    const feed = await fetchTvExplorerFeed(section.feedType ?? 'movie', { sort: section.sort }, next);
    if (!feed || !feed.items.length) {
      section.hasNextPage = false;
      return null;
    }
    section.items = [...section.items, ...feed.items];
    section.page = feed.page;
    section.hasNextPage = feed.hasNextPage;
    return feed.items;
  };
}
