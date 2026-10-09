import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { discoverBatchDeduped } from '../src/lib/server/content/discover-batch';
import { fetchBatchWithCache, getCachedBatch, setCachedBatch, clearRailCache, __test as railCacheTest } from '../src/lib/client/discover/rail-cache';
import { EXPLORER_GENRES } from '../src/lib/shared/explorer-taxonomy';
import type { ContentList, DiscoverRailFilters, NormalizedMediaItem } from '../src/lib/server/content/types';

/**
 * MAV-20 regression suite — Discover rail consolidation (Movie / TV Shows /
 * Anime chips), inline Show More endcap, tiered batch performance,
 * back-navigation + scroll restoration policy, and the player-back latency
 * fix (recommendations off the navigation critical path).
 *
 * Mix of behavioral tests (the pure scoped-batch logic with a mock
 * fetchRail; the client batch cache with fake timers-free TTL control via
 * the now parameter; the in-app history detection with a stubbed window)
 * and source-contract tests (the repo's established convention).
 */

const repoRoot = new URL('../', import.meta.url).pathname;
const read = (rel: string) => readFile(path.join(repoRoot, rel), 'utf8');

const discoverPage = await read('src/lib/components/DiscoverPage.svelte');
const discoverSection = await read('src/lib/components/DiscoverSection.svelte');
const adultSection = await read('src/lib/components/AdultDiscoverSection.svelte');
const service = await read('src/lib/server/content/service.ts');
const tmdb = await read('src/lib/server/content/adapters/tmdb.ts');
const railEndpoint = await read('src/routes/api/discover/rail/+server.ts');
const batchEndpoint = await read('src/routes/api/discover/batch/+server.ts');
const navigation = await read('src/lib/shared/navigation.ts');
const layout = await read('src/routes/+layout.svelte');
const detailPage = await read('src/lib/components/DetailPage.svelte');
const watchPage = await read('src/routes/watch/[type]/[id]/+page.svelte');
const spotlight = await read('src/lib/components/SpotlightCarousel.svelte');
const explorerPage = await read('src/lib/components/ExplorerPage.svelte');
const movieRoute = await read('src/routes/movie/[id]/+page.svelte');
const moviesRoute = await read('src/routes/movies/+page.svelte');
const tvShowsRoute = await read('src/routes/tv-shows/+page.svelte');
const animeRoute = await read('src/routes/anime/+page.svelte');
const movieServer = await read('src/routes/movie/[id]/+page.server.ts');
const seriesServer = await read('src/routes/series/[id]/+page.server.ts');
const animeServer = await read('src/routes/anime/[id]/+page.server.ts');
const recEndpoint = await read('src/routes/api/content/recommendations/[type]/[id]/+server.ts');
const upcomingPage = await read('src/routes/upcoming/+page.svelte');
const railCache = await read('src/lib/client/discover/rail-cache.ts');

let passed = 0;
function ok(condition: unknown, label: string) {
  assert.ok(condition, label);
  passed += 1;
}

// ============================================================
// Helpers — mock fetchRail for the scoped-batch behavioral tests
// ============================================================
function makeItem(type: string, id: string, genres: number[] = []): NormalizedMediaItem {
  return {
    id: `${type}-${id}`,
    title: `Title ${id}`,
    year: 2024,
    type: type as 'movie' | 'series',
    genres: [],
    description: '',
    poster: '',
    backdrop: '',
    tmdbGenreIds: genres,
    externalIds: { tmdb: id },
  } as unknown as NormalizedMediaItem;
}

const ALL_SECTIONS = [
  'theatre', 'new-ott', 'popular-movie', 'popular-series', 'popular-anime',
  'top-rated-movie', 'top-rated-series', 'top-rated-anime',
  'genre-action', 'genre-adventure', 'genre-crime', 'genre-thriller',
  'genre-scifi', 'genre-comedy', 'genre-drama', 'genre-horror', 'genre-romance'
];

function createCountingFetchRail(
  sectionData: Record<string, NormalizedMediaItem[]>,
  fetchLog: string[]
): (filters: DiscoverRailFilters, canAccessAdult: boolean) => Promise<ContentList> {
  return async (filters: DiscoverRailFilters) => {
    fetchLog.push(`${filters.section}:${filters.page}`);
    return {
      items: sectionData[filters.section] ?? [makeItem('movie', `${filters.section}-x`)],
      page: filters.page ?? 1,
      hasNextPage: false,
      source: 'mock' as unknown as ContentList['source'],
    };
  };
}

// ============================================================
// A. Discover rail consolidation — datasets + chip wiring
// ============================================================
{
  // A1. Popular: the three chips select the EXISTING per-type datasets.
  ok(discoverPage.includes("movie: { section: 'popular-movie' }"), 'A1a. Popular Movie chip → popular-movie (existing dataset)');
  ok(discoverPage.includes("series: { section: 'popular-series' }"), 'A1b. Popular TV Shows chip → popular-series (existing dataset)');
  ok(discoverPage.includes("anime: { section: 'popular-anime' }"), 'A1c. Popular Anime chip → popular-anime (existing dataset)');

  // A2. Top Rated: the three chips select the EXISTING per-type datasets —
  // never the popular dataset, never a fabricated combined list.
  ok(discoverPage.includes("movie: { section: 'top-rated-movie' }"), 'A2a. Top Rated Movie chip → top-rated-movie');
  ok(discoverPage.includes("series: { section: 'top-rated-series' }"), 'A2b. Top Rated TV Shows chip → top-rated-series');
  ok(discoverPage.includes("anime: { section: 'top-rated-anime' }"), 'A2c. Top Rated Anime chip → top-rated-anime');

  // A3. New on OTT: chips scope the SAME OTT query per type; the provider
  // dropdown stays on the family (providerFilter: true).
  ok(/key: 'new-ott',\s*\n\s*title: 'New on OTT',\s*\n\s*typeChips: true,\s*\n\s*languageFilter: false,\s*\n\s*providerFilter: true/.test(discoverPage), 'A3a. New on OTT family: chips + the existing OTT provider dropdown');
  ok(tmdb.includes("export async function getTmdbNewOnOttTyped("), 'A3b. typed New on OTT adapter exists (movie/TV halves of the existing query)');
  ok(tmdb.includes("export async function getTmdbNewOnOttAnime("), 'A3c. anime New on OTT adapter exists (genre 16 + ja + the same OTT params)');
  ok(/case 'new-ott':[\s\S]*?getTmdbNewOnOttTyped\('movie'/.test(service), 'A3d. Movie chip → the movie half of the OTT query');
  ok(/case 'new-ott':[\s\S]*?getTmdbNewOnOttTyped\('series'/.test(service), 'A3e. TV Shows chip → the TV half of the OTT query');
  ok(/case 'new-ott':[\s\S]*?getTmdbNewOnOttAnime\(filters\.provider/.test(service), 'A3f. Anime chip → the anime OTT query (provider filter preserved)');
  ok(/case 'new-ott':\s*\n\s*\/\/ MAV-20[\s\S]*?return await getTmdbNewOnOtt\(filters\.provider, language, page\);/.test(service), 'A3g. the legacy mixed OTT rail remains available (no-type contract unchanged)');

  // A4. Genre chips: the REAL TMDB TV genre ids from the shared Explorer
  // taxonomy; sections without a TV genre are omitted (honest empty rail,
  // never an invented id).
  const tvGenreMapMatch = service.match(/const TV_GENRE_ID_BY_DISCOVER_SECTION[\s\S]*?\};/);
  ok(Boolean(tvGenreMapMatch), 'A4a. TV genre mapping table exists in the service');
  if (tvGenreMapMatch) {
    const table = tvGenreMapMatch[0];
    const expectedTv: Record<string, number | undefined> = {
      'genre-action': 10759, 'genre-adventure': 10759, 'genre-comedy': 35,
      'genre-crime': 80, 'genre-scifi': 10765, 'genre-drama': 18,
      'genre-thriller': undefined, 'genre-horror': undefined, 'genre-romance': undefined
    };
    for (const [section, expectedId] of Object.entries(expectedTv)) {
      if (expectedId === undefined) {
        ok(!table.includes(`'${section}'`), `A4b. ${section}: no TV genre id (TMDB has none — omitted, honest empty state)`);
      } else {
        ok(table.includes(`'${section}': ${expectedId}`), `A4c. ${section}: TV genre id ${expectedId} (from EXPLORER_GENRES.series)`);
      }
    }
    // Cross-check the ids against the SHARED taxonomy (the one source of truth).
    const seriesGenres = EXPLORER_GENRES.series;
    ok(seriesGenres.some((g) => g.name === 'Action & Adventure' && g.seriesId === 10759), 'A4d. taxonomy cross-check: TV Action & Adventure = 10759');
    ok(seriesGenres.some((g) => g.name === 'Sci-Fi & Fantasy' && g.seriesId === 10765), 'A4e. taxonomy cross-check: TV Sci-Fi & Fantasy = 10765');
    ok(!seriesGenres.some((g) => g.name === 'Thriller' || g.name === 'Horror' || g.name === 'Romance'), 'A4f. taxonomy cross-check: NO Thriller/Horror/Romance TV genre exists');
  }

  // A5. Anime genre chips: the per-side constraints from the shared anime
  // taxonomy; genre-thriller has no anime equivalent (omitted).
  const animeGenreMapMatch = service.match(/const ANIME_GENRE_BY_DISCOVER_SECTION[\s\S]*?\};/);
  ok(Boolean(animeGenreMapMatch), 'A5a. anime genre constraint table exists in the service');
  if (animeGenreMapMatch) {
    const table = animeGenreMapMatch[0];
    ok(table.includes("'genre-action': { movieGenreId: 28, tvGenreId: 10759 }"), 'A5b. genre-action anime: movie 28 / TV 10759 (per-side taxonomy)');
    ok(table.includes("'genre-scifi': { movieGenreId: 878, tvGenreId: 10765 }"), 'A5c. genre-scifi anime: movie 878 / TV 10765');
    ok(table.includes("'genre-horror': { movieGenreId: 27 }"), 'A5d. genre-horror anime: movie-side only');
    ok(table.includes("'genre-romance': { movieGenreId: 10749 }"), 'A5e. genre-romance anime: movie-side only');
    ok(!table.includes("'genre-thriller'"), 'A5f. genre-thriller: no anime equivalent — omitted (honest empty state)');
    const animeGenres = EXPLORER_GENRES.anime;
    ok(animeGenres.some((g) => g.name === 'Action' && g.movieId === 28 && g.seriesId === 10759), 'A5g. taxonomy cross-check: anime Action 28/10759');
    ok(!animeGenres.some((g) => g.name === 'Thriller'), 'A5h. taxonomy cross-check: no anime Thriller in the established taxonomy');
  }

  // A6. The honest-empty contract: sections with no genre for a type return
  // an empty rail — never fixtures, never a fabricated closest-match.
  ok(/if \(tvGenreId === undefined\) return emptyRailResult\(page\);/.test(service), 'A6a. no TV genre → emptyRailResult (honest empty)');
  ok(/if \(!constraint\) return emptyRailResult\(page\);/.test(service), 'A6b. no anime constraint → emptyRailResult (honest empty)');
  ok(discoverSection.includes('No titles available right now.'), 'A6c. DiscoverSection renders the proper empty state');

  // A7. Rail endpoint: the type dimension is a CLOSED union, and only the
  // sections that support it accept it (400 otherwise — no silent honoring).
  ok(railEndpoint.includes("isDiscoverRailType(typeParam)"), 'A7a. rail endpoint validates the type against the closed union');
  ok(railEndpoint.includes("const supportsType = sectionParam === 'new-ott' ||"), 'A7b. only new-ott + genre sections accept a type filter (genre pattern check)');
  ok(railEndpoint.includes("INVALID_TYPE"), 'A7c. invalid type / unsupported section → 400 (closed contract)');

  // A8. The batch's new-ott entry is the MOVIE variant (the default chip).
  ok(/filters\.section === 'new-ott' && filters\.type === undefined\s*\?\s*\{ \.\.\.filters, type: 'movie' \}/.test(service), 'A8. batch new-ott = the Movie chip dataset (default)');

  // A9. Anime variants render NO language dropdown (the anime catalog is
  // Japanese by construction — the Anime Explorer precedent).
  ok(/languageFilter=\{fam\.languageFilter && variantType !== 'anime'\}/.test(discoverPage), 'A9. anime chip variants render no language dropdown');
  ok(/viewAllHref=\{\(fam\.key === 'popular' \|\| fam\.key === 'top-rated'\) && variantType === 'anime' \? '\/anime' : ''\}/.test(discoverPage), 'A9b. the anime View-all link targets the first-class /anime route (anime chip only)');

  // A10. The hero carousel is untouched (Phase B preserve contract).
  ok(discoverPage.includes('GALLERY_ROTATION_MS = 4000'), 'A10a. hero autoplay cadence unchanged (4s)');
  ok(discoverPage.includes('aria-roledescription="carousel"'), 'A10b. hero carousel semantics unchanged');
  ok(/featuredItems = \$derived\(\s*heroItems/.test(discoverPage), 'A10c. hero lineage contract unchanged (server heroItems, no fallback)');
}

// ============================================================
// B. Tiered scoped batches — behavioral (pure discover-batch logic)
// ============================================================
{
  const TIER1 = ['theatre', 'new-ott', 'popular-movie', 'popular-series', 'popular-anime'];
  const TIER2 = ALL_SECTIONS.filter((s) => !TIER1.includes(s));

  // Shared item across tiers proves the seen-set prefix is replayed.
  const sharedItem = makeItem('movie', '777', [28]);
  const sectionData: Record<string, NormalizedMediaItem[]> = {
    theatre: [sharedItem, makeItem('movie', '100')],
    'new-ott': [makeItem('movie', '101')],
    'popular-movie': [sharedItem, makeItem('movie', '102')],
    'popular-series': [makeItem('series', '103')],
    'genre-action': [sharedItem, makeItem('movie', '104')]
  };

  // B1. Tier 1 (priority prefix): returns ONLY its sections and never
  // fetches the sections after the last scoped one.
  {
    const fetchLog: string[] = [];
    const rails = await discoverBatchDeduped('all', undefined, false, createCountingFetchRail(sectionData, fetchLog), TIER1);
    ok(Object.keys(rails).sort().join(',') === [...TIER1].sort().join(','), 'B1a. tier-1 scope returns exactly the tier-1 rails');
    ok(fetchLog.every((entry) => TIER1.includes(entry.split(':')[0])), 'B1b. tier-1 scope never fetches beyond the last scoped section (prefix short-circuit)');
    ok(fetchLog.length === TIER1.length, `B1c. tier-1 scope fetches exactly its ${TIER1.length} page-1s (no continuation, no seeding beyond scope)`);
    const popularIds = rails['popular-movie'].items.map((i) => i.id);
    ok(!popularIds.includes('movie-777'), 'B1d. tier-1 dedup: the theatre-claimed item stays out of popular-movie');
  }

  // B2. Tier 2: processes the tier-1 prefix (dedup seeding) and returns
  // ONLY the tier-2 rails — with the same seen-set the full batch has.
  {
    const fetchLog: string[] = [];
    const rails = await discoverBatchDeduped('all', undefined, false, createCountingFetchRail(sectionData, fetchLog), TIER2);
    ok(Object.keys(rails).every((key) => TIER2.includes(key)), 'B2a. tier-2 scope returns only tier-2 rails');
    ok(!Object.keys(rails).includes('theatre'), 'B2b. the seeding sections are NOT returned');
    ok(fetchLog.some((entry) => entry.startsWith('theatre:')), 'B2c. tier-2 scope still PROCESSES the tier-1 prefix (dedup seeding)');
    const actionIds = rails['genre-action'].items.map((i) => i.id);
    ok(!actionIds.includes('movie-777'), 'B2d. tier-2 dedup: the theatre-claimed item stays out of genre-action (same seen-set prefix)');
  }

  // B3. The two tiers COMPOSE into exactly the full batch's rails.
  {
    const fetchLog: string[] = [];
    const full = await discoverBatchDeduped('all', undefined, false, createCountingFetchRail(sectionData, []), undefined);
    const tier1Rails = await discoverBatchDeduped('all', undefined, false, createCountingFetchRail(sectionData, fetchLog), TIER1);
    const tier2Rails = await discoverBatchDeduped('all', undefined, false, createCountingFetchRail(sectionData, fetchLog), TIER2);
    const composed = { ...tier1Rails, ...tier2Rails };
    const fullKeys = Object.keys(full).sort().join(',');
    const composedKeys = Object.keys(composed).sort().join(',');
    ok(fullKeys === composedKeys, 'B3a. tier-1 + tier-2 compose to exactly the full batch sections');
    let identical = true;
    for (const key of Object.keys(full)) {
      const a = JSON.stringify(full[key]);
      const b = JSON.stringify(composed[key]);
      if (a !== b) { identical = false; break; }
    }
    ok(identical, 'B3b. every composed rail is IDENTICAL to the full batch entry (byte-equal dedup outcome)');
  }

  // B4. A scope matching nothing returns an empty rails object without
  // fetching anything.
  {
    const fetchLog: string[] = [];
    const rails = await discoverBatchDeduped('all', undefined, false, createCountingFetchRail(sectionData, fetchLog), ['unknown-section']);
    ok(Object.keys(rails).length === 0, 'B4a. unknown scope → empty rails');
    ok(fetchLog.length === 0, 'B4b. unknown scope → zero fetches');
  }

  // B5. The batch endpoint validates the sections scope (closed union,
  // adult-shows rejected, bounded) and passes it through.
  ok(batchEndpoint.includes("isDiscoverSectionKey(value)"), 'B5a. batch endpoint validates section keys against the closed union');
  ok(batchEndpoint.includes("value === 'adult-shows'"), 'B5b. adult-shows cannot be scoped (batch excludes adult sections)');
  ok(batchEndpoint.includes(".slice(0, 32)"), 'B5c. sections scope is bounded (max 32)');
  ok(/discoverBatchDeduped\(languageParam, safeProvider, false, safeSections\)/.test(batchEndpoint), 'B5d. the scope is passed to the batch builder');

  // B6. The client fires BOTH tiers in parallel and renders each family on
  // its own tier's arrival (independent statuses).
  ok(/TIER1_SECTIONS = 'theatre,new-ott,popular-movie,popular-series,popular-anime'/.test(discoverPage), 'B6a. tier 1 = theatre + new-ott + the Popular family (priority prefix)');
  ok(/tier1Status = \$state<'pending' \| 'success' \| 'failed'>\('pending'\)/.test(discoverPage) && /tier2Status = \$state<'pending' \| 'success' \| 'failed'>\('pending'\)/.test(discoverPage), 'B6b. the two tiers have INDEPENDENT statuses');
  ok(/void fetchBatchTier\(batchTierUrl\(TIER1_SECTIONS\)\)[\s\S]*?void fetchBatchTier\(batchTierUrl\(TIER2_SECTIONS\)\)/.test(discoverPage), 'B6c. both tier requests fire in parallel (no await between them)');
  ok(/return TIER2_KEYS\.has\(variant\.section\) \? tier2Status : tier1Status;/.test(discoverPage), 'B6d. a batch-backed variant observes ITS tier status (one slow tier cannot block the other)');
}

// ============================================================
// C. Chip switching — state isolation by construction
// ============================================================
{
  // C1. The parent re-keys DiscoverSection on chip switch: a switch is a
  // FRESH mount — items/pagination/loading/error cannot leak.
  ok(/{#key `\$\{fam\.key\}:\$\{selectedTypeFor\(fam\)\}`}/.test(discoverPage), 'C1a. DiscoverSection is re-keyed on chip switch (fresh state by construction)');
  ok(/function selectType\(familyKey: string, type: DiscoverRailType\) \{\s*if \(\(selectedTypes\[familyKey\] \?\? 'movie'\) === type\) return;/.test(discoverPage), 'C1b. selecting the already-active chip is a no-op');

  // C2. Non-batch variants (new-ott/genre TV+anime chips) wait for BOTH
  // tiers, then fetch independently WITH the cross-rail exclude list.
  ok(/if \(variant\.type !== undefined\) \{\s*return tier1Status === 'pending' \|\| tier2Status === 'pending' \? 'pending' : 'failed';/.test(discoverPage), 'C2a. non-batch variants wait for both tiers (complete exclude list) then fetch independently');

  // C3. DiscoverSection's independent first load carries the exclude list.
  ok(/const url = railUrl\(1, excludeIds\);/.test(discoverSection), "C3a. loadFirst independent fetch includes the cross-rail excludeIds");
  // C4. The type dimension is part of the rail URL → the client rail cache
  // key isolates variants (no cross-type cache leakage).
  ok(/if \(requestType\) params\.set\('type', requestType\);/.test(discoverSection), 'C4a. requestType is part of the rail URL (cache-key isolation)');
  ok(/getCachedRail<MediaItem>\(url, page\.data\.user\?\.id\)/.test(discoverSection), 'C4b. rail cache reads stay per-user keyed');

  // C5. Language switch semantics preserved (reset to page 1, replace).
  ok(discoverSection.includes('function changeLanguage'), 'C5a. language switch handler preserved');
  ok(/filterChanged = true;[\s\S]*?void loadFirst\(\);/.test(discoverSection), 'C5b. language switch resets pagination and refetches');
}

// ============================================================
// D. Inline Show More endcap
// ============================================================
{
  // D1. The endcap is the LAST item INSIDE the rail grid, after the cards.
  ok(/\{#each items as item \(item\.type \+ ':' \+ item\.id\)\}[\s\S]*?<MediaCard \{item\} \/>[\s\S]*?\{#if hasNextPage\}[\s\S]*?<div class="rail-endcap">/.test(discoverSection), 'D1a. DiscoverSection: the endcap renders after the cards, inside the rail');
  ok(adultSection.includes('class="rail-endcap"'), 'D1b. AdultDiscoverSection uses the same endcap pattern');
  // D2. NO separate below-rail Show More button remains anywhere.
  ok(!/<button\s+class="show-more"/.test(discoverSection), 'D2a. DiscoverSection: no separate Show More row remains');
  ok(!/<button\s+class="show-more"/.test(adultSection), 'D2b. AdultDiscoverSection: no separate Show More row remains');
  // D3. Concurrent-click + state guards preserved.
  ok(/if \(loading \|\| loadingMore \|\| !hasNextPage\) return;/.test(discoverSection), 'D3a. loadMore guards against duplicate concurrent requests');
  ok(/disabled=\{loadingMore\}/.test(discoverSection), 'D3b. the endcap is disabled while loading');
  // D4. Append-dedupe preserved (seen set over excludes + current items).
  ok(/const seen = new Set\(allExclude\);[\s\S]*?if \(!seen\.has\(key\)\) \{[\s\S]*?items = \[\.\.\.items, item\];/.test(discoverSection), 'D4a. pagination appends deduplicated items');
  // D5. Exhaustion removes the endcap (hasNextPage guard).
  ok(/\{#if hasNextPage\}[\s\S]*<div class="rail-endcap">/.test(discoverSection), 'D5a. the endcap only renders while more pages exist (removed on exhaustion)');
  // D6. Failure keeps the loaded items; the SAME endcap becomes Retry.
  ok(/aria-label=\{showMoreError \? `Retry loading more \$\{title\}` : `Show more \$\{title\}`\}/.test(discoverSection), 'D6a. the endcap turns into the inline retry control on failure');
  // D7. The Explorer page pagination is UNTOUCHED (infinite scroll, no endcap).
  ok(!explorerPage.includes('rail-endcap'), 'D7a. ExplorerPage pagination untouched (no endcap added)');
  ok(explorerPage.includes('IntersectionObserver'), 'D7b. Explorer infinite scroll intact');
  // D8. The endcap is not a fake poster: no artwork, dashed outline, real
  // button semantics.
  ok(/border: 1px dashed/.test(discoverSection), 'D8a. the endcap is a dashed glass panel (visually not a poster card)');
  ok(/aria-hidden="true"/.test(discoverSection), 'D8b. the endcap icon is decorative (the button carries the label)');
}

// ============================================================
// E. Back navigation — the single coherent policy
// ============================================================
{
  // E1. The shared policy exists and tracks the app's OWN navigations.
  ok(/export function recordInAppNavigation\(/.test(navigation), 'E1a. recordInAppNavigation exported (root layout reports in-app navs)');
  ok(/export function hasInAppHistoryEntry\(\)/.test(navigation), 'E1b. hasInAppHistoryEntry exported');
  ok(/export function navigateBackOr\(/.test(navigation), 'E1c. navigateBackOr exported (the ONE back policy)');
  ok(navigation.includes("history.state['sveltekit:history'] index is NOT"), 'E1g. documented: SvelteKit history index is Date.now()-seeded (unusable for first-entry detection)');
  ok(/afterNavigate\(\(\{ from \}\) => \{[\s\S]*?recordInAppNavigation/.test(layout), 'E1h. the root layout wires afterNavigate to the navigation tracker');

  // Behavioral: the in-app origin flag is driven by recordInAppNavigation.
  const originalWindow = (globalThis as Record<string, unknown>).window;
  try {
    (globalThis as Record<string, unknown>).window = {
      history: { state: { 'sveltekit:history': Date.now() }, back: () => {} },
      addEventListener: () => {}, removeEventListener: () => {}
    };
    const nav = await import('../src/lib/shared/navigation');
    // Fresh document: no in-app navigation recorded (deep-link state).
    nav.recordInAppNavigation(null);
    ok(nav.hasInAppHistoryEntry() === false, 'E1d. behavioral: no recorded in-app nav (deep link) → no in-app previous entry');
    // The root layout records every completed client-side navigation.
    nav.recordInAppNavigation('/discover');
    ok(nav.hasInAppHistoryEntry() === true, 'E1e. behavioral: a recorded in-app nav → in-app previous entry exists');
    ok(nav.lastInAppOrigin() === '/discover', 'E1f. behavioral: the origin URL is tracked for diagnostics');
    // Back to the fresh-document state.
    nav.recordInAppNavigation(null);
    ok(nav.hasInAppHistoryEntry() === false, 'E1i. behavioral: initial-load afterNavigate(from=null) resets to no-origin');
  } finally {
    if (originalWindow === undefined) delete (globalThis as Record<string, unknown>).window;
    else (globalThis as Record<string, unknown>).window = originalWindow;
  }

  // E2. navigateBackOr: no in-app entry → fallback runs WITHOUT calling back().
  {
    const originalWindow = (globalThis as Record<string, unknown>).window;
    let backCalls = 0;
    let fallbackRan = false;
    try {
      (globalThis as Record<string, unknown>).window = {
        history: { state: { 'sveltekit:history': Date.now() }, back: () => { backCalls += 1; } },
        addEventListener: () => {}, removeEventListener: () => {}
      };
      const nav = await import('../src/lib/shared/navigation');
      nav.recordInAppNavigation(null);
      nav.navigateBackOr(() => { fallbackRan = true; });
      ok(backCalls === 0 && fallbackRan, 'E2a. behavioral: deep link → straight to fallback, no back() attempt');
    } finally {
      if (originalWindow === undefined) delete (globalThis as Record<string, unknown>).window;
      else (globalThis as Record<string, unknown>).window = originalWindow;
    }
  }

  // E3. navigateBackOr: with an in-app entry, popstate firing means no fallback.
  {
    const originalWindow = (globalThis as Record<string, unknown>).window;
    let fallbackRan = false;
    let popstateHandler: (() => void) | undefined;
    try {
      (globalThis as Record<string, unknown>).window = {
        history: {
          state: { 'sveltekit:history': Date.now() },
          // Real browsers fire popstate for a same-document traversal as a
          // task queued by the traversal itself — it lands BEFORE an
          // independent setTimeout(0) registered earlier. Microtasks model
          // that ordering in the stub (they run before timers).
          back: () => { queueMicrotask(() => popstateHandler?.()); }
        },
        addEventListener: (_: string, handler: () => void) => { popstateHandler = handler; },
        removeEventListener: () => {}
      };
      const nav = await import('../src/lib/shared/navigation');
      nav.recordInAppNavigation('/movies');
      nav.navigateBackOr(() => { fallbackRan = true; });
      await new Promise((resolve) => setTimeout(resolve, 20));
      ok(!fallbackRan, 'E3a. behavioral: popstate fired → the fallback did NOT run (no double navigation)');
    } finally {
      if (originalWindow === undefined) delete (globalThis as Record<string, unknown>).window;
      else (globalThis as Record<string, unknown>).window = originalWindow;
    }
  }

  // E4. DetailPage.goBack: delegates to the policy; from-aware fallback.
  ok(/navigateBackOr\(\(\) => \{/.test(detailPage), 'E4a. DetailPage back control uses the shared policy');
  ok(/const fallbackDestination = validReturnTo \?\? '\/discover';/.test(detailPage), 'E4b. fallback destination is from-aware with /discover as the final default');
  ok(!/goto\('\/discover', \{ replaceState: true, keepFocus: true \}\);\s*\n\s*\}\s*\n/.test(detailPage), 'E4c. no unconditional hardcoded /discover replaceState remains');

  // E5. The watch player close: REAL back navigation + immediate progress
  // flush (fire-and-forget — never blocks the navigation).
  ok(/void writer\?\.pause\(\);\s*\n\s*const returnTo = safeReturnTo/.test(watchPage), 'E5a. closePlayer initiates the final progress flush BEFORE navigating (fire-and-forget)');
  ok(/navigateBackOr\(\(\) => \{\s*\n\s*void goto\(fallbackDestination, \{ replaceState: true, keepFocus: true \}\);/.test(watchPage), 'E5b. closePlayer uses history.back() with the detail+from fallback');
  // Scope to closePlayer's own body: the old always-replaceState goto close
  // (the duplicate-detail-entry root cause) must be gone from THE CLOSE PATH.
  const closePlayerBody = watchPage.slice(watchPage.indexOf('function closePlayer()'), watchPage.indexOf('function openDetails()'));
  ok(!/void goto\(destination, \{ replaceState: true, keepFocus: true \}\);/.test(closePlayerBody), 'E5c. the old always-replaceState goto close is gone (no more duplicate detail entries)');
  ok(/beforeunload|pagehide/.test(watchPage), 'E5d. the pagehide/beforeunload progress flushes remain (durable writes)');

  // E6. Hero links carry the origin (the wrong-destination root cause).
  ok(/appendReturnTo\(`\/watch\/\$\{slide\.item\.type\}\/\$\{slide\.item\.id\}\`, heroOrigin\)/.test(discoverPage), 'E6a. Discover hero Play carries the origin');
  ok(/appendReturnTo\(`\/\$\{slide\.item\.type\}\/\$\{slide\.item\.id\}\`, heroOrigin\)/.test(discoverPage), 'E6b. Discover hero See More carries the origin');
  ok(/appendReturnTo\(`\/watch\/\$\{slide\.type\}\/\$\{slide\.id\}\`, returnTo\)/.test(spotlight), 'E6c. Explorer spotlight Play carries the origin');
  ok(/appendReturnTo\(`\/\$\{slide\.type\}\/\$\{slide\.id\}\`, returnTo\)/.test(spotlight), 'E6d. Explorer spotlight More details carries the origin');
  ok(/returnTo=\{explorerOrigin\}/.test(explorerPage), 'E6e. ExplorerPage passes its origin (page + filter state) to the spotlight');
  ok(/\$derived\(`\$\{page\.url\.pathname\}\$\{page\.url\.search\}\$\{page\.url\.hash\}`\)/.test(explorerPage), 'E6f. the Explorer origin includes query + hash (filter state)');

  // E7. Upcoming filter changes no longer push history entries.
  ok(/goto\(`\$\{page\.url\.pathname\}\?\$\{params\.toString\(\)\}`, \{ replaceState: true, keepFocus: true, noScroll: true \}\)/.test(upcomingPage), 'E7. Upcoming filter changes use replaceState (the Explorer convention)');

  // E8. Root snapshot: BOTH scrollers, instant, content-driven restore.
  ok(/mainTop: main\?\.scrollTop \?\? 0/.test(layout), 'E8a. capture reads the desktop .app-main scroller too');
  ok(/behavior: 'instant'/.test(layout), 'E8b. restores are instant (smooth scroll-behavior never animates a restore)');
  ok(/const waitForContent = \(\) => \{/.test(layout), 'E8c. content-driven rAF loop (not an arbitrary fixed timeout)');
  ok(/frames >= FRAME_BUDGET/.test(layout), 'E8d. the loop is bounded (frame budget)');
  ok(/main\.scrollTo\(\{ top:/.test(layout), 'E8e. the desktop scroller is restored (desktop back-nav no longer lands at the top)');

  // E9. Explorer feed snapshots: the accumulated infinite-scroll state is
  // preserved on back-nav (the Upcoming/Search architecture).
  ok(/registerFeedSnapshot\?\.\(\{/.test(explorerPage), 'E9a. ExplorerPage registers feed capture/restore handlers');
  ok(/lastSeed = filteredItems;/.test(explorerPage), 'E9b. restore consumes the server seed (the re-seed effect cannot clobber the restored accumulation)');
  ok(/requestSequence \+= 1;/.test(explorerPage), 'E9c. restore invalidates in-flight appends (stale-response protection)');
  for (const [name, src] of [['movies', moviesRoute], ['tv-shows', tvShowsRoute], ['anime', animeRoute]] as const) {
    ok(/export const snapshot = \{/.test(src), `E9d. /${name} exports the route-level snapshot`);
    ok(/registerFeedSnapshot=\{\(handlers\) => \(feedSnapshot = handlers\)\}/.test(src), `E9e. /${name} delegates its snapshot to the ExplorerPage handlers`);
  }

  // E10. Detail loads: the classification N+1 is OFF the navigation
  // critical path; the classified rail loads through the SAME safe pipeline.
  for (const [name, src] of [['movie', movieServer], ['series', seriesServer], ['anime', animeServer]] as const) {
    ok(/const detail = await getDetail\('/.test(src), `E10a. /${name} page load fetches the PARENT detail only (fast navigation)`);
    ok(!/await getDetailWithSafeRecommendations/.test(src), `E10b. /${name} page load no longer runs the recommendation classification N+1 inline`);
    ok(/canAccessAdultContent/.test(src), `E10c. /${name} adult gate preserved`);
    ok(/recommendations: \[\]/.test(src), `E10d. /${name} returns no SSR recommendations (client-side rail)`);
  }
  ok(/getDetailWithSafeRecommendations\(params\.type, params\.id\)/.test(recEndpoint), 'E10e. the recommendations endpoint uses the SAME rec-safe consumer path');
  ok(/canAccessAdultContent/.test(recEndpoint) && /status: 404/.test(recEndpoint), 'E10f. the recommendations endpoint keeps the identical adult gate (non-disclosing 404)');
  ok(!/recordServerEvent/.test(recEndpoint), 'E10g. the recommendations endpoint records no detail_open (rail continuation, not a detail open)');
  ok(/\/api\/content\/recommendations\/\$\{type\}\/\$\{encodeURIComponent\(item\.id\)\}/.test(detailPage), 'E10h. DetailPage fetches the classified rail client-side');
  ok(/recommendationState === 'loading'/.test(detailPage) && /SkeletonCard/.test(detailPage), 'E10i. the rec rail renders a skeleton while loading');
  ok(!/media\.filter\(\(candidate\) => candidate\.id !== item\.id/.test(detailPage), 'E10j. the fixture fallback for the rec rail is gone (honest empty)');
  ok(/getCachedRail<MediaItem>\(url, page\.data\.user\?\.id\)/.test(detailPage), 'E10k. the rec rail reuses the per-user client cache (instant back-nav)');

  // E11. The watch route's own load (arrival) still runs its parallel
  // detail + streaming config pipeline (no playback regression).
  ok(/getDetail\(params\.type, params\.id\)/.test(await read('src/routes/watch/[type]/[id]/+page.server.ts')), 'E11. the watch route load still resolves detail directly (playback path untouched)');
}

// ============================================================
// F. Continue Watching local-first + batch cache (behavioral)
// ============================================================
{
  // F1. Local-first paint: the local canonical records render immediately;
  // the cloud-authoritative refresh replaces them when the sync lands.
  ok(/void getContinueWatching\(\)\.then\(\(records\) => \{/.test(discoverPage), 'F1a. onMount paints the LOCAL canonical progress records first');
  ok(/if \(cancelled\) return;\s*\n\s*localContinueItems = records\.map\(progressToMedia\);\s*\n\s*localContinueLoaded = true;/.test(discoverPage), 'F1b. the local-first paint sets the reactive states');
  ok(/try \{ return await getContinueWatching\(\); \} catch \{ return \[\]; \}/.test(discoverPage), 'F1c. a transient sync failure degrades to the LOCAL records (rail not wiped)');
  ok(/syncAuthenticatedState\(\); return continueWatchingRecords\(cloud\.progress, cloud\.favorites\)/.test(discoverPage), 'F1d. the cloud refresh uses the EXISTING canonical records + merge semantics (no parallel store)');

  // F2. Behavioral: the batch client cache (per-user, TTL, in-flight dedup,
  // failures never cached).
  clearRailCache();
  const tierUrl = '/api/discover/batch?language=all&sections=tier1';
  setCachedBatch(tierUrl, 'user-a', { 'theatre': { items: [{ id: 'movie-1' }], page: 1, hasNextPage: true } });
  const cachedA = getCachedBatch(tierUrl, 'user-a');
  ok(Boolean(cachedA && cachedA['theatre']), 'F2a. behavioral: a cached tier is served back');
  ok(getCachedBatch(tierUrl, 'user-b') === undefined, 'F2b. behavioral: cache keys are per-user (no cross-user leakage)');
  ok(getCachedBatch(tierUrl, 'user-a', Date.now() + railCacheTest.DEFAULT_TTL_MS + 1000) === undefined, 'F2c. behavioral: expired entries are evicted (TTL)');
  ok(getCachedBatch(tierUrl, null) === undefined, 'F2d. behavioral: guest keys are isolated from user keys');

  // In-flight dedup: two concurrent fetchBatchWithCache calls share ONE fetch.
  clearRailCache();
  let fetchCount = 0;
  const slowFetcher = async () => {
    fetchCount += 1;
    await new Promise((resolve) => setTimeout(resolve, 25));
    return { 'theatre': { items: [], page: 1, hasNextPage: false } };
  };
  const [a, b] = await Promise.all([
    fetchBatchWithCache(tierUrl, 'user-a', slowFetcher),
    fetchBatchWithCache(tierUrl, 'user-a', slowFetcher)
  ]);
  ok(fetchCount === 1, 'F2e. behavioral: concurrent mounts share the in-flight request (no duplicate fetch)');
  ok(a['theatre'] && b['theatre'], 'F2f. behavioral: both callers receive the shared result');

  // Failures are never cached.
  clearRailCache();
  let failCount = 0;
  const failingFetcher = async () => {
    failCount += 1;
    throw new Error('network down');
  };
  await fetchBatchWithCache(tierUrl, 'user-a', failingFetcher).catch(() => undefined);
  await fetchBatchWithCache(tierUrl, 'user-a', failingFetcher).catch(() => undefined);
  ok(failCount === 2, 'F2g. behavioral: failures are never cached (each mount retries cold)');
  ok(getCachedBatch(tierUrl, 'user-a') === undefined, 'F2h. behavioral: a failed tier leaves no cache entry');

  // F3. clearRailCache clears batch entries too (sign-out hygiene).
  clearRailCache();
  setCachedBatch(tierUrl, 'user-a', { 'theatre': { items: [], page: 1, hasNextPage: false } });
  clearRailCache();
  ok(getCachedBatch(tierUrl, 'user-a') === undefined, 'F3. clearRailCache evicts batch entries (sign-out isolation)');

  // F4. The batch cache is bounded (LRU).
  clearRailCache();
  for (let i = 0; i < 10; i += 1) {
    setCachedBatch(`/api/discover/batch?sections=t${i}`, 'user-a', {});
  }
  const stats = (await import('../src/lib/client/discover/rail-cache')).railCacheStats();
  ok(stats.batchEntries <= 8, 'F4. behavioral: the batch cache is LRU-bounded (8 entries)');

  // F5. The DiscoverPage routes its tier fetches through the shared cache.
  ok(/fetchBatchWithCache\(url, page\.data\.user\?\.id, async \(\) => \{/.test(discoverPage), 'F5. the tier fetches flow through the per-user batch cache (in-flight dedup + TTL)');

  // F6. My List's own path is untouched (the fast pattern reference).
  const myList = await read('src/routes/my-list/+page.svelte');
  ok(/Promise\.all\(\[getLocalFavorites\(\), getLocalProgressRecords\(\), listFavoriteDeletions\(\), statePromise\]\)/.test(myList), 'F6. My List loading path unchanged (still the local-first reference)');
}

console.log(`MAV-20 regression suite: ${passed} checks passed — Discover rail consolidation (datasets, genre taxonomy, closed type contract, batch movie default); tiered scoped batches (prefix short-circuit, dedup seeding, tier composition, endpoint validation); chip state isolation (re-key remount, exclude-list independence, cache-key isolation); inline Show More endcap (in-rail placement, no separate row, guards, dedupe, exhaustion, honest non-poster design); back navigation (shared policy + in-app index detection, player close via real history with non-blocking progress flush, origin-carrying hero links, both-scroller instant content-driven scroll restore, Explorer feed snapshots, recommendations off the critical path with the same safety pipeline); Continue Watching local-first + batch client cache (per-user TTL, in-flight dedup, failures uncached, LRU bound).`);
