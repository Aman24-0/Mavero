import { discover, popular } from '$lib/server/content/service';
import { getTmdbCurrentAiring } from '$lib/server/content/adapters/tmdb';
import { toMediaItem } from '$lib/server/content/presenter';
import { formatLatestEpisodeBadge } from '$lib/server/content/explorer-load';
import { RATE_LIMITED_ERROR_CODE, RATE_LIMITED_MESSAGE, checkRateLimit, clientIdentity } from '$lib/server/http/rate-limit';
import { PUBLIC_CATALOG_CACHE } from '$lib/server/http/cache-headers';
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

// ============================================================
// GET /api/tv/home — the Mavero TV journey's home rails (Phase 7).
//
// The Tizen .wgt is a static SPA: `+page.server.ts` cannot run
// on-device (the widget server has no server routes), so the TV
// home's universal load fetches THIS endpoint instead. It composes
// the EXACT same cached catalog services the old /tv server load
// used — discover() (Trending), popular() (Popular) and the
// getTmdbCurrentAiring adapter (Current Airing) — with zero new
// backend fetching. Every loader follows the established failure
// guards: an upstream outage degrades that rail to undefined
// (graceful hide), never an empty shell of fake data.
//
// CORS: the request arrives from the TV's widget origin (cross-origin
// to this deployment) as a simple, credential-less GET. An open
// `Access-Control-Allow-Origin: *` is safe here — the response is
// identical for every visitor (public catalog data, no auth, no
// adult dimension), matching the Phase 2-C caching contract of the
// other public catalog endpoints. Simple GETs need no preflight.
// ============================================================

// TMDB list pages return 20 titles; a TV viewport comfortably rows
// through ~12 before the horizontal crawl feels endless on a remote.
// The slice happens SERVER-SIDE so the payload (posters included)
// stays small for living-room devices on slow links.
const TV_RAIL_DEPTH = 12;

// CORS for the TV widget origin (public, credential-less GETs only).
const TV_CORS_HEADERS: Record<string, string> = {
  'access-control-allow-origin': '*'
};

type RailItem = ReturnType<typeof toMediaItem>;

type TvRailResponse = {
  key: string;
  title: string;
  items: RailItem[];
  episodeBadges?: Record<string, string>;
};

function itemKey(item: RailItem): string {
  return `${item.type}:${item.id}`;
}

// "Trending movies" — the same discover('movie', 1) call the Discover
// page's trending rail uses (cached, fixtures-guarded).
async function loadTrendingMoviesRail(): Promise<TvRailResponse | undefined> {
  try {
    const result = await discover('movie', 1);
    if (result.source.provider === 'fixtures') return undefined;
    return { key: 'trending-movies', title: 'Trending movies', items: result.items.map(toMediaItem) };
  } catch {
    return undefined;
  }
}

// "Current Airing" — the cached getTmdbCurrentAiring('series') adapter
// (on_the_air pages → cached-detail enrichment → newest-first), the
// SAME source the TV Shows Explorer's topmost rail composes. Latest-
// episode badges ride along so a D-pad row shows "S2 E5 · Today" style
// facts. Empty upstream / TMDB outage / missing credentials → hidden.
async function loadCurrentAiringRail(): Promise<TvRailResponse | undefined> {
  try {
    const result = await getTmdbCurrentAiring('series');
    if (result.items.length === 0) return undefined; // graceful hide
    const episodeBadges: Record<string, string> = {};
    for (const [key, info] of Object.entries(result.latestEpisodes)) {
      episodeBadges[key] = formatLatestEpisodeBadge(info);
    }
    return { key: 'current-airing', title: 'Current Airing', items: result.items.map(toMediaItem), episodeBadges };
  } catch {
    return undefined;
  }
}

// "Popular TV shows" — the same popular('series', 1) call the Explorer
// sections use, deduped against the rails above (the Explorer's
// no-repeat contract: a title shown in an earlier rail is not repeated
// in a later one — here Current Airing wins over Popular).
async function loadPopularSeriesRail(seen: Set<string>): Promise<TvRailResponse | undefined> {
  try {
    const result = await popular('series', 1);
    if (result.source.provider === 'fixtures') return undefined;
    const items = result.items.map(toMediaItem).filter((item) => !seen.has(itemKey(item)));
    if (items.length === 0) return undefined;
    return { key: 'popular-series', title: 'Popular TV shows', items };
  } catch {
    return undefined;
  }
}

export const GET: RequestHandler = async ({ request, locals }) => {
  // Security/perf: bounded per-identity rate limit (each call fans out to
  // TMDB). TV requests carry no session — they rate-limit as anonymous.
  const rateVerdict = checkRateLimit('contentBrowse', clientIdentity(request.headers, locals.user?.id));
  if (!rateVerdict.allowed) {
    return json(
      { ok: false, error: { code: RATE_LIMITED_ERROR_CODE, message: RATE_LIMITED_MESSAGE } },
      { status: 429, headers: { 'retry-after': String(rateVerdict.retryAfterSeconds), ...TV_CORS_HEADERS } }
    );
  }

  const [trending, airing] = await Promise.all([loadTrendingMoviesRail(), loadCurrentAiringRail()]);

  // No-repeat set BEFORE the Popular fetch (Current Airing is the
  // topmost series rail, same precedence as the Explorer sections).
  const seen = new Set<string>();
  trending?.items.forEach((item) => seen.add(itemKey(item)));
  airing?.items.forEach((item) => seen.add(itemKey(item)));
  const popularSeries = await loadPopularSeriesRail(seen);

  const rails = [trending, airing, popularSeries]
    .filter((rail): rail is TvRailResponse => Boolean(rail))
    .map((rail) => ({ ...rail, items: rail.items.slice(0, TV_RAIL_DEPTH) }));

  return json(
    {
      ok: true,
      // All rails failed → transient catalog outage (fixtures guard /
      // upstream outage). The client renders its honest empty state.
      rails
    },
    { headers: { 'cache-control': PUBLIC_CATALOG_CACHE, ...TV_CORS_HEADERS } }
  );
};
