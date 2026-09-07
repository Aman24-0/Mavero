import { getTmdbCollection, getTmdbDetail, getTmdbDiscover, getTmdbPopular, getTmdbTrendingMoviesByLanguage, searchTmdb, getTmdbSeason, getTmdbNowPlaying, getTmdbNewOnOtt, getTmdbPopularByLanguage, getTmdbTopRated, getTmdbGenreByLanguage, getTmdbAnimeMerged, getTmdbAdultShows, getTmdbAdultDiscover } from './adapters/tmdb';
import { emptyAdultDiscoverResult, type AdultDiscoverFilters } from './adult-discover';
import { media } from '$data/content';
import type { CollectionFilters, ContentDetail, ContentList, ContentSearchResult, ContentType, DiscoverLanguage, DiscoverRailFilters, DiscoverSectionKey, NormalizedMediaItem, SearchFilters } from './types';
import { ContentServiceError } from './types';

function fixtureSource(): NormalizedMediaItem['source'] {
  return { provider: 'fixtures', fetchedAt: new Date().toISOString() };
}

function fixturesFor(type: ContentType) {
  // Anime content now comes from TMDB (TMDB TV series flagged as anime via
  // genre 16 'Animation' + original_language 'ja'). Fixtures remain as a
  // last-resort fallback only — anime fixture items keep their original
  // `type: 'anime'` so the card UI and detail route preserve their identity,
  // but their `externalIds.tmdb` mirrors their fixture id (which is not a
  // real TMDB id, so resolver attempts on fixture anime return NOT_FOUND
  // rather than silently failing with a broken embed).
  return media.filter((item) => item.type === type).map((item) => ({ ...item, source: fixtureSource(), externalIds: { tmdb: item.id } } as NormalizedMediaItem));
}

function fixtureDetail(type: ContentType, id: string) {
  const item = media.find((candidate) => candidate.type === type && candidate.id === id);
  if (!item) return undefined;
  return { ...item, source: fixtureSource(), externalIds: { tmdb: item.id } } as NormalizedMediaItem;
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

// Anime is now a TMDB TV subtype. The TMDB adapter sets `isAnime === true`
// AND `animeFormat === 'series'` for TV series whose genre_ids include 16
// (Animation) and whose original_language is 'ja'. The discover/collection/
// popular rails for type === 'anime' load the TMDB TV rail and filter
// client-side to anime-flagged items. Anime movies (TMDB-tagged type ===
// 'movie' with isAnime === true + animeFormat === 'movie') are NOT included
// in the anime rail — they appear in the regular movie rails and play
// through the normal movie provider pipeline.
function isAnimeSeries(item: NormalizedMediaItem) {
  return item.isAnime === true && item.animeFormat !== 'movie';
}

function filterAnimeSeries(items: NormalizedMediaItem[]): NormalizedMediaItem[] {
  return items.filter(isAnimeSeries);
}

// BUG 4 fix: Adult content classification — centralized via isAdultContent.
// The service-layer isAdultItem delegates to the central classifier in
// adult-providers.ts, which checks: tags, provider IDs, and TMDB adult flag.
// For catalog items that don't have provider IDs available (list responses),
// it falls back to checking tags + TMDB adult flag (non-anime only).
import { isAdultContent, ensureAdultProvidersResolved } from './adult-providers';
import { getTmdbIndiaProviders } from './adapters/tmdb';
import { detailVerdict } from './search-classify';
import { filterSafeRailItems, shouldFilterDetailRecommendations, type RailCandidateRow } from './list-classify';
import { isDiscoverLanguageValue } from './types';

function isAdultItem(item: NormalizedMediaItem): boolean {
  // For list responses we don't have per-title provider IDs without N+1.
  // The isAdultContent classifier checks tags, TMDB adult flag (non-anime)
  // and the title's TV networks (verified adult network registry) —
  // networks are present on detail-shaped items; list items simply pass
  // undefined. Since the Phase 3 catalog migration, network-based
  // exclusion is done at the TMDB query level (without_networks) for TV;
  // movies keep the transitional watch-provider query exclusion.
  return isAdultContent(item.tags, undefined, undefined, item.isAnime, item.networks);
}

export async function discover(type: ContentType, page = 1): Promise<ContentList> {
  try {
    // Discover V2: anime now queries BOTH TMDB movie AND TMDB TV with
    // `with_genres=16` + `with_original_language='ja'`, filters to
    // isAnime === true, and merges. Anime movies keep type='movie';
    // anime series keep type='series'. This preserves the canonical
    // identity so cards / detail routes / resolver / playback all
    // continue to work unchanged.
    if (type === 'anime') return await getTmdbAnimeMerged('popularity', page);
    const result = await getTmdbDiscover(type, page);
    return { ...result, items: rankForExposure(result.items) };
  } catch (error) {
    if (!canFallback(error)) throw error;
    return { items: fixturesFor(type), page, hasNextPage: false, source: { provider: 'fixtures', fetchedAt: new Date().toISOString(), stale: true } };
  }
}

export async function collection(type: ContentType, page = 1, filters: CollectionFilters = {}): Promise<ContentList> {
  try {
    // Discover V2: anime collection now merges movie + TV anime.
    if (type === 'anime') return await getTmdbAnimeMerged(filters.sort === 'Top rated' ? 'top-rated' : 'popularity', page);
    const result = await getTmdbCollection(type, page, filters);
    return { ...result, items: rankForExposure(result.items, filters.sort === 'Top rated' ? 'top-rated' : filters.sort === 'Newest' ? 'newest' : 'for-you') };
  } catch (error) {
    if (!canFallback(error)) throw error;
    return { items: fixturesFor(type).slice(0, 20), page, hasNextPage: false, source: { provider: 'fixtures', fetchedAt: new Date().toISOString(), stale: true } };
  }
}

export async function popular(type: ContentType, page = 1): Promise<ContentList> {
  try {
    // Discover V2: anime popular now merges movie + TV anime.
    if (type === 'anime') return await getTmdbAnimeMerged('popularity', page);
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

export async function search(query: string, type?: ContentType, page = 1, filters: SearchFilters = {}, canAccessAdult = false): Promise<ContentSearchResult> {
  const normalized = query.trim();
  if (!normalized) return { query: normalized, items: [], page, hasNextPage: false, filters, source: fixtureSource() };
  // Phase 4: Adult-aware search. TMDB's /search endpoint supports NEITHER
  // without_watch_providers NOR without_networks, and search rows carry no
  // networks metadata — include_adult=false alone CANNOT be trusted. When
  // adult access is OFF, searchTmdb now classifies every candidate
  // server-side (TV via the cached detail path through the ONE central
  // classifier; movies via the cheap metadata path) with bounded
  // concurrency, fails CLOSED on uncertain classifications, and continues
  // upstream pages while the visible page is underfilled. When adult
  // access is ON (authorized), adult results MAY appear and the response
  // is exactly the pre-Phase-4 shape. Authorization is evaluated by the
  // CALLER (API route / SSR page) with the existing policy function — no
  // authorization redesign here (Phase 5).
  // The provider cache is still kept warm so the classifier's transitional
  // (movie-side) provider signal stays effective for detail classification.
  await ensureAdultProvidersResolved(() => getTmdbIndiaProviders());
  try {
    if (type === 'anime') {
      const result = await searchTmdb(normalized, 'series', page, filters, canAccessAdult);
      const items = applyAnimeFilters(filterAnimeSeries(result.items), filters);
      return { ...result, items, query: normalized, filters };
    }
    if (type === 'movie' || type === 'series') {
      const result = await searchTmdb(normalized, type, page, filters, canAccessAdult);
      return { ...result, query: normalized, filters };
    }
    const [movies, series] = await Promise.allSettled([
      searchTmdb(normalized, 'movie', page, filters, canAccessAdult),
      searchTmdb(normalized, 'series', page, filters, canAccessAdult),
    ]);
    const tmdbResults = [movies, series].filter((result): result is PromiseFulfilledResult<ContentList> => result.status === 'fulfilled');
    if (!tmdbResults.length) {
      const failure = [movies, series].find((result): result is PromiseRejectedResult => result.status === 'rejected')?.reason;
      throw failure instanceof ContentServiceError ? failure : new ContentServiceError('TMDB search is unavailable.', { code: 'UPSTREAM_ERROR', status: 502 });
    }
    const sources = tmdbResults.map((result) => result.value.source);
    const items = applyAnimeFilters(tmdbResults.flatMap((result) => result.value.items), filters);
    return { query: normalized, items, page, hasNextPage: tmdbResults.some((result) => result.value.hasNextPage), filters, source: { provider: sources.every((item) => item.provider === sources[0].provider) ? sources[0].provider : 'fixtures', fetchedAt: new Date().toISOString(), stale: sources.some((item) => item.stale) } };
  } catch (error) {
    if (!type && error instanceof ContentServiceError && canFallback(error)) throw error;
    if (!canFallback(error)) throw error;
    const items = media.filter((item) => `${item.title} ${item.genres.join(' ')}`.toLowerCase().includes(normalized.toLowerCase()) && (!type || item.type === type)).map((item) => ({ ...item, source: fixtureSource() } as NormalizedMediaItem));
    return { query: normalized, items, page, hasNextPage: false, filters, source: { provider: 'fixtures', fetchedAt: new Date().toISOString(), stale: true } };
  }
}

export async function getSeriesSeason(id: string, seasonNumber: number) {
  // Accept both 'series-{tmdbId}' and 'anime-{tmdbId}' IDs — anime series
  // are now TMDB TV series, so the same TMDB season endpoint serves both.
  const cleanId = id.replace(/^(series|anime)-/, '');
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
    // Anime is now backed by TMDB TV. The 'anime-' / 'series-' prefix is
    // stripped and the TMDB TV detail endpoint is queried. The returned
    // item has `type: 'series'` and `isAnime: true` (when genre 16 + 'ja'
    // match) so the card UI and resolver both treat it correctly.
    if (type === 'anime') return await getTmdbDetail('series', id.replace(/^(anime|series)-/, ''));
    return await getTmdbDetail(type, id.replace(/^(movie|series)-/, ''));
  } catch (error) {
    const fixture = fixtureDetail(type, id);
    if (fixture && (canFallback(error) || (error instanceof ContentServiceError && error.code === 'NOT_FOUND'))) return { ...fixture, source: { ...fixture.source, stale: true } };
    throw error;
  }
}

// Max simultaneous recommendation classifications per detail (bounded N+1;
// recommendations are <= 6 per detail — matches the rail concurrency).
const DETAIL_RECOMMENDATION_CONCURRENCY = 4;

/**
 * Phase 6 — detail recommendations leak fix.
 *
 * The TMDB detail response embeds `recommendations` (append_to_response).
 * Those rows are LIST-shaped: TV rows carry no networks[] and no reliable
 * adult flag, so an adult-network title can appear in a normal title's
 * recommendation strip — a direct bypass of every rail filter.
 *
 * `getDetailWithSafeRecommendations` is the CONSUMER-facing detail path
 * (detail pages + content API). It filters the recommendations of
 * non-adult parents through the ONE central classifier:
 *   - movie recs: cheap detail-path verdict (uniform; also picks up the
 *     transitional provider signal from the rec's cached detail),
 *   - TV recs: cached-detail verdict (network identity is authoritative).
 *   - adult AND uncertain recs are dropped — a normal surface must stay
 *     adult-free REGARDLESS of Adult Mode state (fail-closed).
 * Adult parents keep their recommendations unfiltered: that page is an
 * Adult-specific surface reachable only after the route-level authorization
 * guard, so its (possibly adult) recommendations are legitimate there.
 *
 * The decision input is the parent's CLASSIFICATION (a content fact), never
 * authorization — so the wrapper's output stays deterministic per content
 * and classification work flows through the shared cached detail path.
 *
 * Playback/resolver callers keep using `getDetail` directly: they never
 * surface recommendation strips, so no classification N+1 is added to the
 * playback path (protected area — untouched semantics).
 */
export async function getDetailWithSafeRecommendations(type: ContentType, id: string): Promise<ContentDetail> {
  const detail = await getDetail(type, id);
  if (!shouldFilterDetailRecommendations(detail.tags)) {
    // Adult parent -> Adult-specific surface (authorization enforced by the
    // route guard before this data is reachable). Recommendations pass.
    return detail;
  }
  const recommendations = detail.recommendations ?? [];
  if (recommendations.length === 0) return detail;
  // getTmdbDetail maps every recommendation with the PARENT's resolved type
  // (movie details recommend movies; TV details recommend TV), so one type
  // covers the whole strip.
  const recType = detail.type === 'movie' ? 'movie' : 'series';
  const rows: RailCandidateRow<NormalizedMediaItem>[] = recommendations.map((rec) => ({
    item: rec,
    mediaType: recType
  }));
  const result = await filterSafeRailItems(rows, {
    concurrency: DETAIL_RECOMMENDATION_CONCURRENCY,
    loadDetailVerdict: async (tmdbId) => {
      try {
        // Uniform detail-path verdict: reads the central classification
        // (flag + transitional provider signal for movies; authoritative
        // network signal for TV) from the shared, cached,
        // in-flight-deduplicated detail path.
        const recDetail = await getTmdbDetail(recType, tmdbId);
        return detailVerdict(recDetail.tags);
      } catch {
        return 'uncertain';
      }
    },
    tmdbIdOf: (item) => String(item.externalIds?.tmdb ?? item.id.replace(/^(movie|series)-/, '')),
    identityOf: (item) => `${item.type}:${item.id}`
  });
  return { ...detail, recommendations: result.items };
}

export function getFixtureContent(type: ContentType) {
  return fixturesFor(type);
}

// ============================================================
// Discover V2 — typed rail query builder.
//
// `discoverRail` is the single server-side entry point for the new
// data-driven Discover page. The browser sends a `DiscoverRailFilters`
// (section key + language + optional provider + page); the server maps
// the section key to the right TMDB endpoint + filters and returns a
// `ContentList`. The browser never sends raw TMDB paths or arbitrary
// filter values.
//
// CRITICAL: there is NO fixture fallback here. If the upstream TMDB
// query fails, the rail returns an empty list with `hasNextPage: false`
// so the page renders the section as unavailable rather than filling
// it with fake content. This is the contract the spec requires.
// ============================================================

const GENRE_ID_BY_SECTION: Record<Extract<DiscoverSectionKey, `genre-${string}`>, number> = {
  'genre-action': 28,
  'genre-adventure': 12,
  'genre-comedy': 35,
  'genre-crime': 80,
  'genre-thriller': 53,
  'genre-scifi': 878,
  'genre-drama': 18,
  'genre-horror': 27,
  'genre-romance': 10749,
};

export function isDiscoverSectionKey(value: string): value is DiscoverSectionKey {
  return value === 'theatre' || value === 'new-ott'
    || value === 'popular-movie' || value === 'popular-series' || value === 'popular-anime'
    || value === 'top-rated-movie' || value === 'top-rated-series' || value === 'top-rated-anime'
    || value === 'adult-shows'
    || /^genre-(action|adventure|comedy|crime|thriller|scifi|drama|horror|romance)$/.test(value);
}

export function isDiscoverLanguage(value: string): value is DiscoverLanguage {
  // Phase 7: the union guard moved to types.ts (single source shared with
  // the Adult Discover contract); this delegation keeps the service API
  // byte-compatible for every existing consumer.
  return isDiscoverLanguageValue(value);
}

export async function discoverRail(filters: DiscoverRailFilters, canAccessAdult = false): Promise<ContentList> {
  const section = filters.section;
  const language = filters.language;
  const page = Math.max(1, Math.min(Number(filters.page ?? 1) || 1, 20));
  try {
    switch (section) {
      case 'theatre':
        return await getTmdbNowPlaying(language, page);
      case 'new-ott':
        return await getTmdbNewOnOtt(filters.provider, language, page);
      case 'popular-movie':
        return await getTmdbPopularByLanguage('movie', language, page);
      case 'popular-series':
        return await getTmdbPopularByLanguage('series', language, page);
      case 'popular-anime':
        return await getTmdbAnimeMerged('popularity', page);
      case 'top-rated-movie':
        return await getTmdbTopRated('movie', language, page);
      case 'top-rated-series':
        return await getTmdbTopRated('series', language, page);
      case 'top-rated-anime':
        return await getTmdbAnimeMerged('top-rated', page);
      case 'adult-shows': {
        // Phase 8: server-side enforcement. If the caller has not
        // verified adult access, return an empty non-disclosing result.
        // The rail endpoint checks this BEFORE calling discoverRail,
        // but this is a defense-in-depth guard.
        if (!canAccessAdult) {
          return { items: [], page, hasNextPage: false, source: { provider: 'tmdb', fetchedAt: new Date().toISOString() } };
        }
        return await getTmdbAdultShows(filters.provider, page);
      }
      default: {
        // Genre sections.
        if (section in GENRE_ID_BY_SECTION) {
          const genreId = GENRE_ID_BY_SECTION[section as Extract<DiscoverSectionKey, `genre-${string}`>];
          return await getTmdbGenreByLanguage(genreId, language, page);
        }
        throw new ContentServiceError('Unknown Discover section.', { code: 'NOT_FOUND', status: 404 });
      }
    }
  } catch (error) {
    // NO fixture fallback — empty rail on failure, per the spec.
    if (error instanceof ContentServiceError && (error.code === 'CONFIG_MISSING' || error.code === 'NOT_FOUND')) throw error;
    return { items: [], page, hasNextPage: false, source: { provider: 'tmdb', fetchedAt: new Date().toISOString(), stale: true } };
  }
}

/**
 * Merged anime collection — used by the /discover/anime Explore page.
 *
 * Queries BOTH TMDB movie AND TMDB TV with `with_genres=16` +
 * `with_original_language=ja`, filters to isAnime === true, merges,
 * and dedupes by canonical type+id. Anime movies keep type='movie';
 * anime series keep type='series'. This preserves the canonical
 * identity so cards / detail routes / resolver / playback / My List
 * / progress / deletion all continue to work unchanged.
 *
 * `sort` selects between popularity and top-rated ranking.
 * `page` is 1-indexed; each page returns 10 unique anime titles.
 */
export async function discoverAnime(sort: 'popularity' | 'top-rated', page = 1): Promise<ContentList> {
  return discoverRail({ section: sort === 'top-rated' ? 'top-rated-anime' : 'popular-anime', language: 'all', page });
}

// ============================================================
// Phase 7 — dedicated Adult Discover catalog (service entry point).
//
// The AUTHORIZATION-AWARE wrapper the Adult Discover API route calls.
// Authorization is evaluated PER REQUEST by the route with the Phase 5
// policy function (canAccessAdultContent — fresh admin policy + verified
// preference; never cached, never client-controlled) and passed in as the
// `canAccessAdult` decision. This wrapper enforces the decision a SECOND
// time (defense-in-depth): an unauthorized call — including an internal
// caller that forgot the authorization step — gets the empty,
// non-disclosing Adult Discover result, never the catalog.
//
// NO fallback by construction: Adult Discover never degrades into the
// normal catalog or fixtures. Upstream failures propagate to the route's
// error handling (an error/empty response — never normal content in the
// Adult surface, never adult content in a normal surface).
// ============================================================
export async function adultDiscover(filters: AdultDiscoverFilters, canAccessAdult = false): Promise<ContentList> {
  // Defense-in-depth gate: without a per-request authorized decision the
  // Adult catalog is unavailable. The result is empty and non-disclosing —
  // identical for "admin OFF", "preference OFF" and any other deny reason.
  if (!canAccessAdult) {
    return emptyAdultDiscoverResult(filters.page);
  }
  return getTmdbAdultDiscover(filters);
}

export const contentServiceInternals = { fixturesFor, fixtureDetail, canFallback, audienceConfidence, rankForExposure, isUsableItem, uniqueUsableItems, selectFeatured };
