import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// MAVERO — Explorer pages contract (Movies / TV Shows / Anime Explorer
// redesign — the approved replacement for the Phase 4 destination
// pages). UPDATED for Follow-up task 2 (final UI/UX correction +
// responsive carousel hardening): sort/Show-more dimension, single
// Language All, label-less chip rows, hardened spotlight.
//
// Regression contract for the three dedicated Explorers:
//
//   SOURCE     — one ExplorerPage component serves all three routes
//                (spotlight + genre/language chips + Popular/Top Rated
//                sections, or the filtered progressive feed). One
//                loadExplorerData server loader + one /api/explorer/feed
//                endpoint compose ONLY the existing cached TMDB paths —
//                no new backend fetching, no duplicate page
//                implementations.
//   SPOTLIGHT  — exactly up to 6 slides, deterministic daily rotation
//                (recent ~30-day candidates first, popularity-scored,
//                sensible fallback fill), ~90% viewport width, 4-second
//                auto rotation, reduced-motion respected, Play/detail
//                routes preserved, honest fallback block.
//   CHIPS      — Genre + Language rows from the SHARED closed taxonomy
//                (real TMDB ids per media type; anime language row is
//                honestly All + Japanese), horizontally scrollable,
//                inactive initially, sticky while browsing results.
//   RESULTS    — the first batch is RESPONSIVE to grid capacity
//                (columns × visible rows, bounded 8..30 — NEVER a
//                hardcoded universal 20), then progressive/infinite
//                loading via the feed endpoint with dedup + guard
//                against duplicate requests.
//   SECTIONS   — unfiltered: Popular + Top Rated per type, rendered
//                through the existing ContentRail, cross-section
//                deduped server-side, empty sections omitted.
//   CLEANUP    — the old destination/collection UI (DestinationPage,
//                CollectionPage, FilterBar, filter-types) is REMOVED —
//                no old sections can render beneath the new Explorer.
//   DATA       — no fixtures, no schema/auth/session changes, existing
//                pagination/caching semantics preserved.

let passed = 0;
function ok(message: string) {
  passed += 1;
  console.log(`  ok ${passed} - ${message}`);
}

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

const loader = read('../src/lib/server/content/explorer-load.ts');
const heroSelect = read('../src/lib/server/content/hero-select.ts');
const taxonomy = read('../src/lib/shared/explorer-taxonomy.ts');
const explorerPage = read('../src/lib/components/ExplorerPage.svelte');
const spotlight = read('../src/lib/components/SpotlightCarousel.svelte');
const contentRail = read('../src/lib/components/ContentRail.svelte');
const labelsModule = read('../src/lib/shared/content-labels.ts');
const feedEndpoint = read('../src/routes/api/explorer/feed/+server.ts');
const routes = {
  movies: read('../src/routes/movies/+page.svelte'),
  series: read('../src/routes/tv-shows/+page.svelte'),
  anime: read('../src/routes/anime/+page.svelte')
};
const routeServers = {
  movies: read('../src/routes/movies/+page.server.ts'),
  series: read('../src/routes/tv-shows/+page.server.ts'),
  anime: read('../src/routes/anime/+page.server.ts')
};

// ============================================================
// 1. LOADER — composed from existing cached services only
// ============================================================
assert.match(loader, /export async function loadExplorerData\(type: ContentType, url: URL\)/, 'loadExplorerData exported');
for (const helper of ['collection(type, safePage, collectionFilters)', 'discover(type, 1)', 'popular(type, 1)', 'getTmdbAnimeMerged(']) {
  assert.ok(loader.includes(helper), `the explorer loader composes the existing service: ${helper}`);
}
assert.ok(loader.includes('getTmdbHeroMoviePool') && loader.includes('getTmdbHeroSeriesPool'), 'spotlight candidates reuse the existing cached hero pools');
assert.doesNotMatch(loader.slice(loader.indexOf('export async function loadExplorerData')), /tmdbRequest\(|fetch\(/, 'the page loader performs NO direct TMDB fetching (services only)');
assert.match(loader, /getOrSetValidated/, 'the spotlight uses the validated cache discipline (empty is never cached for the TTL)');
assert.match(loader, /SPOTLIGHT_CACHE_VERSION/, 'the spotlight cache key is versioned');
ok('1. loadExplorerData composes only existing cached services (no new backend fetching)');

// ============================================================
// 2. SPOTLIGHT — 6 slides, daily rotation, honest fallback
// ============================================================
assert.match(heroSelect, /export const SPOTLIGHT_SIZE = 6/, 'SPOTLIGHT_SIZE is the named constant 6');
assert.match(heroSelect, /export function selectSpotlightLineup/, 'the pure spotlight selector exists (unit-testable, no network)');
assert.match(heroSelect, /bucket % \(maxOffset \+ 1\)/, 'spotlight rotation is deterministic + bucket-based (same day stable, days differ)');
assert.match(heroSelect, /isFreshForHero\(item, activeSeriesIds, now\)/, 'fresh candidates reuse the existing 30-day/activity gates');
assert.match(heroSelect, /fallback\.slice\(0, SPOTLIGHT_SIZE - spotlight\.length\)/, 'sensible fallback fill tops up ONLY the remaining slots');
assert.match(loader, /slice\(0, SPOTLIGHT_SIZE\)/, 'the loader caps the lineup at 6 slides');
assert.match(spotlight, /const SPOTLIGHT_ROTATION_MS = 4000/, 'auto rotation is 4 seconds');
assert.match(spotlight, /MAX_SLIDES = 6/, 'the carousel rendering window is exactly 6 slides');
// LT-18: the carousel is now a cinematic FULL-BLEED hero (Discover's
// design language) — the old ~90% boxed card framing is gone.
assert.match(spotlight, /\.spotlight \{[\s\S]*?width: 100%;/, 'the carousel is a full-width cinematic hero');
assert.doesNotMatch(spotlight, /width: 90%;/, 'the old ~90% boxed width is gone');
assert.match(spotlight, /prefers-reduced-motion: reduce/, 'the carousel honors reduced motion');
assert.match(spotlight, /\/watch\/\$\{slide\.type\}\/\$\{slide\.id\}/, 'Play preserves the existing watch route pattern');
assert.match(spotlight, /href=\{\`\/\$\{slide\.type\}\/\$\{slide\.id\}\`/, 'More details preserves the existing detail route pattern');
assert.match(explorerPage, /explorer-hero-fallback/, 'honest fallback block when the catalog cannot supply a lineup');
assert.doesNotMatch(spotlight + loader, /Math\.random/, 'no render-time randomization (SSR/hydration stability)');
ok('2. spotlight: 6 slides, 4s rotation, deterministic daily selection, 30-day freshness, honest fallback');

// ============================================================
// 3. TAXONOMY — closed genre/language lists, real TMDB ids
// ============================================================
assert.match(taxonomy, /export const EXPLORER_GENRES: Record<ContentType, readonly ExplorerGenre\[\]>/, 'shared genre taxonomy exists');
assert.match(taxonomy, /export const EXPLORER_LANGUAGES: Record<ContentType, readonly ExplorerLanguageOption\[\]>/, 'shared language taxonomy exists');
assert.match(taxonomy, /export function isExplorerGenre\(/, 'closed-union genre validation exists');
assert.match(taxonomy, /export function isExplorerLanguage\(/, 'closed-union language validation exists');
// Real TMDB movie genre ids.
for (const [name, id] of [['Action', 28], ['Adventure', 12], ['Animation', 16], ['Comedy', 35], ['Sci-Fi', 878], ['Thriller', 53], ['Horror', 27], ['Fantasy', 14], ['Mystery', 9648], ['Romance', 10749], ['Drama', 18], ['Crime', 80]] as const) {
  assert.ok(taxonomy.includes(`{ name: '${name}', movieId: ${id} }`), `movie genre ${name} maps to the real TMDB id ${id}`);
}
// Real TMDB TV genre ids (differ from movie ids — never invented).
for (const [name, id] of [['Action & Adventure', 10759], ['Sci-Fi & Fantasy', 10765], ['Documentary', 99], ['Kids', 10762], ['Western', 37]] as const) {
  assert.ok(taxonomy.includes(`{ name: '${name}', seriesId: ${id} }`), `TV genre ${name} maps to the real TMDB id ${id}`);
}
// Production bug-fix task (2026-10): TV "Romance" (a movie-genre id that
// TMDB's TV taxonomy does not carry — empirically ~2-3 legacy rows,
// Romance+Hindi = zero) is REMOVED from the series list; the anime Romance
// entry keeps ONLY its movie side for the same reason.
assert.doesNotMatch(taxonomy, /\{ name: 'Romance', seriesId: 10749 \}/, 'series Romance removed — 10749 is not a TMDB TV-genre id (zero-result chip)');
assert.ok(taxonomy.includes("{ name: 'Romance', movieId: 10749 }"), 'movie Romance keeps the real movie-genre id');
// Anime maps per-side ids (movie vs TV taxonomy).
assert.ok(taxonomy.includes(`{ name: 'Action', movieId: 28, seriesId: 10759 }`), 'anime Action maps BOTH the movie and TV genre ids');
assert.ok(taxonomy.includes(`{ name: 'Horror', movieId: 27 }`), 'anime Horror skips the TV side (TMDB TV has no Horror genre — never an invented id)');
// Languages reuse the existing DiscoverLanguage union.
assert.match(taxonomy, /value: 'hi', label: 'Hindi'/, 'language chips reuse the existing Hindi code');
// Production bug-fix task (2026-10): the Anime Explorer exposes NO language
// filter (Japanese-only by the catalog contract) — the anime language list
// is EMPTY and the UI row is conditionally rendered (not CSS-hidden).
assert.match(taxonomy, /anime: \[\]/, 'anime has NO language options (Japanese-only contract — empty list)');
assert.doesNotMatch(taxonomy, /value: 'ja', label: 'Japanese'/, 'no anime Japanese chip remains (no language filter for anime)');
assert.doesNotMatch(taxonomy, /const ANIME_LANGUAGES/, 'the separate anime language list is REMOVED (single source: EXPLORER_LANGUAGES)');
// ~10-12 genres per type.
const movieGenreBlock = taxonomy.slice(taxonomy.indexOf('export const EXPLORER_GENRES'), taxonomy.indexOf('series: [', taxonomy.indexOf('export const EXPLORER_GENRES')));
const movieGenreCount = (movieGenreBlock.match(/movieId: \d+/g) ?? []).length;
assert.ok(movieGenreCount >= 10 && movieGenreCount <= 14, `movie genre options stay in the ~10-12 band (found ${movieGenreCount})`);
const genresIndex = taxonomy.indexOf('export const EXPLORER_GENRES');
const animeGenreBlock = taxonomy.slice(taxonomy.indexOf('anime: [', genresIndex));
const animeGenreCount = (animeGenreBlock.match(/name: '/g) ?? []).length;
assert.ok(animeGenreCount >= 8 && animeGenreCount <= 14, `anime genre options stay in the ~10-12 band (found ${animeGenreCount})`);
const seriesGenreBlock = taxonomy.slice(taxonomy.indexOf('series: [', genresIndex), taxonomy.indexOf('anime: [', genresIndex));
const seriesGenreCount = (seriesGenreBlock.match(/seriesId: \d+/g) ?? []).length;
assert.ok(seriesGenreCount >= 9 && seriesGenreCount <= 14, `TV genre options stay in the ~10-12 band after the Romance removal (found ${seriesGenreCount})`);
ok('3. taxonomy: closed per-type genre/language lists built from real TMDB ids + the existing language union');

// ============================================================
// 4. CHIPS — genre + language rows, sticky, accessible, URL-driven
//    (language row REMOVED for anime — 2026-10 production bug fix)
// ============================================================
assert.match(explorerPage, /EXPLORER_GENRES\[type\]/, 'the genre chips render from the shared taxonomy');
assert.match(explorerPage, /EXPLORER_LANGUAGES\[type\]/, 'the language chips render from the shared taxonomy');
assert.match(explorerPage, /\{#if languageOptions\.length > 0\}/, 'the language row renders ONLY for types with choosable languages (anime: none — removed, not hidden)');
assert.match(explorerPage, /data-chip-row="genre"[\s\S]*?data-chip-row="language"/, 'the Genre row renders ABOVE the Language row');
assert.match(explorerPage, /aria-label=\{`Filter \$\{labels\.prose\} by genre`\}/, 'the genre row is labeled');
assert.match(explorerPage, /aria-label=\{`Filter \$\{labels\.prose\} by language`\}/, 'the language row is labeled');
assert.match(explorerPage, /aria-pressed=\{!selectedGenre\}/, 'All chips expose pressed state (inactive by default)');
assert.match(explorerPage, /chip-scroll[\s\S]*?overflow-x: auto/, 'chip rows scroll horizontally on narrow screens');
assert.match(explorerPage, /\.chip-scroll::-webkit-scrollbar \{ display: none; \}/, 'chip rows hide their scrollbar (contained, no page overflow)');
assert.match(explorerPage, /\.filter-chip:focus-visible \{ outline: 2px solid var\(--color-focus\)/, 'chips keep focus-visible states');
assert.match(explorerPage, /position: sticky;\s*\n?\s*top: var\(--topbar-h-safe\)/, 'the chip block is sticky (mobile: below the sticky topbar)');
assert.match(explorerPage, /@media \(min-width: 641px\) and \(max-width: 1024px\)[\s\S]*?\.explorer-filters \{ top: 72px; \}/, 'tablet: chips stick below the 72px sticky topbar');
assert.match(explorerPage, /@media \(min-width: 1025px\)[\s\S]*?\.explorer-filters \{ top: 0; \}/, 'desktop: chips stick at the app-main scrollport top (no topbar)');
assert.match(explorerPage, /z-index: 30/, 'chip z-index sits below the topbar (they slide under it, never cover it)');
assert.match(explorerPage, /background: rgba\(5, 7, 8, \.92\)/, 'the sticky chip block has an opaque backdrop (readable over content)');
assert.doesNotMatch(explorerPage, /overflow(-y)?: (auto|scroll)!\s/, 'no second scroll container is introduced (sticky stays in normal flow)');
// URL is the filter source of truth — the existing app convention.
assert.match(explorerPage, /goto\(`\$\{page\.url\.pathname\}\$\{query \? `\?\$\{query\}` : ''\}`/, 'filter changes update the canonical shareable URL');
assert.match(explorerPage, /replaceState: true, noScroll: true, keepFocus: true/, 'filter changes replace state (no history pollution — the existing contract)');
ok('4. chips: two shared-taxonomy rows, sticky per breakpoint, accessible, URL-driven');

// ============================================================
// 5. FILTERED RESULTS — responsive first batch + infinite loading
// ============================================================
// NO universal hardcoded 20-per-request batch: the target is computed
// from the measured grid capacity and bounded.
assert.match(explorerPage, /const MIN_RESPONSIVE_TARGET = 8;/, 'responsive target lower bound is 8');
assert.match(explorerPage, /const MAX_RESPONSIVE_TARGET = 30;/, 'responsive target upper bound is 30 (bounded burst)');
assert.match(explorerPage, /computeResponsiveTarget\(\)/, 'the responsive target is computed from grid capacity');
assert.match(explorerPage, /gridTemplateColumns[\s\S]*?columnCount > 0\)[\s\S]*?columns = columnCount/, 'columns are measured from the ACTUAL rendered grid');
assert.match(explorerPage, /Math\.ceil\(availableHeight \/ rowHeight\)/, 'rows are derived from the available viewport height');
assert.match(explorerPage, /Math\.min\(Math\.max\(columns \* rows, MIN_RESPONSIVE_TARGET\), MAX_RESPONSIVE_TARGET\)/, 'target = columns × rows, clamped — never a hardcoded 20');
assert.doesNotMatch(explorerPage, /pageSize = 20|perPage = 20|batchSize = 20/, 'no hardcoded universal 20-result batch anywhere');
// Infinite loading contracts.
assert.match(explorerPage, /IntersectionObserver/, 'infinite scroll uses an IntersectionObserver sentinel');
assert.match(explorerPage, /new Set\(feedItems\.map\(itemKey\)\)/, 'appended pages are deduplicated by type:id');
assert.match(explorerPage, /if \(loadingMore \|\| !feedHasNext \|\| feedExhausted/, 'duplicate/rapid scroll requests are guarded');
assert.match(explorerPage, /requestSequence/, 'stale responses are discarded via a sequence token (rapid scrolling safety)');
assert.match(explorerPage, /feedExhausted = true/, 'end-of-results is tracked and rendered');
assert.match(explorerPage, /You've reached the end of the results\./, 'the end-of-results state is visible');
assert.match(explorerPage, /feedError/, 'load-more failures surface with a retry');
assert.match(explorerPage, /load-sentinel/, 'the sentinel element exists for the observer');
// Feed endpoint contract.
assert.match(feedEndpoint, /isContentType\(typeParam\)/, 'the feed validates the type union');
assert.match(feedEndpoint, /isExplorerGenre\(typeParam, genre\)/, 'the feed validates the genre taxonomy');
assert.match(feedEndpoint, /isExplorerLanguage\(typeParam, language\)/, 'the feed validates the language taxonomy');
assert.match(feedEndpoint, /hasExplorerFilters\(filters\)/, 'the feed requires an active filter (unfiltered browsing stays server-rendered)');
assert.match(feedEndpoint, /status: 400/, 'invalid filter values are rejected with 400 (closed contract)');
// Loader URL parsing.
assert.match(loader, /export function parseExplorerFilters\(url: URL, type: ContentType\)/, 'page URL filters are parsed server-side');
assert.match(loader, /isExplorerGenre\(type, genreParam\)/, 'page genre params are validated against the closed taxonomy');
assert.match(loader, /hasExplorerFilters\(filters\)/, 'the loader distinguishes filtered vs unfiltered state');
ok('5. filtered results: responsive first batch (columns × rows, bounded), infinite deduped loading via a validated feed endpoint');

// ============================================================
// 6. UNFILTERED SECTIONS — Popular + Top Rated, deduped, distinct
// ============================================================
// Follow-up task 2 (§10): every section rail carries the canonical
// Show-more CTA (header position, "Show more" label, the route's own
// ?sort= query state).
assert.match(explorerPage, /\{#each sections as section \(section\.key\)\}[\s\S]*?<ContentRail title=\{section\.title\} items=\{section\.items\} href=\{section\.showMoreHref \|\| ''\} linkLabel="Show more" \/>/, 'unfiltered sections render through the existing ContentRail with the Show-more CTA');
assert.match(loader, /key: 'popular'[\s\S]*?key: 'top-rated'/, 'the server composes exactly the Popular + Top Rated sections');
assert.match(loader, /SECTION_TITLES: Record<ContentType/, 'section titles are per-type');
assert.match(loader, /showMoreHref: `\$\{DESTINATION_ROUTES\[type\]\}\?sort=popular`/, 'Popular Show-more targets the canonical ?sort=popular route state');
assert.match(loader, /showMoreHref: `\$\{DESTINATION_ROUTES\[type\]\}\?sort=top-rated`/, 'Top Rated Show-more targets the canonical ?sort=top-rated route state');
assert.match(loader, /excludeSeen\(topRatedRail\.items, seen\)/, 'Top Rated is deduplicated against Popular (no title repeats across sections)');
assert.match(loader, /topRatedItems\.length < MIN_SECTION_ITEMS[\s\S]*?excludeSeen\(trending, new Set/, 'a dedup-thinned section is topped up with eligible non-duplicates');
assert.match(loader, /if \(popularItems\.length > 0\)/, 'empty sections are omitted (never an empty section)');
assert.match(loader, /sections: \[\] as ExplorerSection\[\]/, 'the filtered state returns NO sections (rails replaced by the filtered area — not stacked)');
// Discover stays distinct — the Explorer does NOT copy its section list.
const discoverSectionList = readFileSync(new URL('../src/lib/components/DiscoverPage.svelte', import.meta.url), 'utf8');
assert.doesNotMatch(explorerPage, /new-ott|theatre|popular-movie|popular-series|genre-action/, 'the Explorer does not copy Discover\u2019s section keys');
assert.ok(discoverSectionList.includes("key: 'new-ott'"), 'Discover keeps its own New on OTT section (untouched)');
assert.ok(discoverSectionList.includes("key: 'theatre'"), 'Discover keeps its own theatre section (untouched)');
ok('6. sections: Popular + Top Rated via ContentRail, cross-section dedup, Discover remains a distinct architecture');

// ============================================================
// 7. ROUTES — one component, one loader, three thin routes
// ============================================================
for (const [key, src] of Object.entries(routes)) {
  assert.match(src, /<ExplorerPage\s/, `${key} route renders ExplorerPage`);
  assert.match(src, /spotlight=\{data\.spotlight\}/, `${key} route passes the spotlight through`);
  assert.match(src, /filteredItems=\{data\.filteredItems\}/, `${key} route passes the filtered feed seed through`);
  assert.match(src, /filters=\{data\.filters\}/, `${key} route passes the filter state through`);
}
for (const [key, src] of Object.entries(routeServers)) {
  assert.match(src, /loadExplorerData\('[^']+', url\)/, `${key} server uses the shared explorer loader`);
}
ok('7. three thin routes over one shared component + loader (no duplicate implementations)');

// ============================================================
// 8. OLD UI CLEANUP — the Phase 4 destination UI is gone
// ============================================================
const fs = { exists: (p: string) => { try { readFileSync(new URL(p, import.meta.url)); return true; } catch { return false; } } };
assert.equal(fs.exists('../src/lib/components/DestinationPage.svelte'), false, 'DestinationPage.svelte is deleted');
assert.equal(fs.exists('../src/lib/components/CollectionPage.svelte'), false, 'CollectionPage.svelte is deleted (no old collection grid below the new UI)');
assert.equal(fs.exists('../src/lib/components/FilterBar.svelte'), false, 'FilterBar.svelte is deleted (no old filter chrome)');
assert.equal(fs.exists('../src/lib/components/filter-types.ts'), false, 'filter-types.ts is deleted');
const discoverLoad = read('../src/lib/server/content/discover-load.ts');
assert.doesNotMatch(discoverLoad, /export async function loadDestinationData/, 'the Phase 4 destination loader is removed from discover-load.ts');
assert.doesNotMatch(discoverLoad, /export async function loadCollectionData/, 'the paginated collection loader is removed from discover-load.ts');
assert.match(discoverLoad, /loadRail[\s\S]*?loadDiscoverData/, 'discover-load keeps ONLY what Discover still uses (loadRail etc.)');
ok('8. old UI cleanup: destination/collection/filter components + their loaders are fully removed');

// ============================================================
// 9. LABELS + A11Y + MOTION
// ============================================================
assert.match(labelsModule, /export const DESTINATION_LABELS/, 'shared label module exists');
assert.match(explorerPage, /DESTINATION_LABELS\[type\]/, 'the Explorer reads labels from the shared module');
assert.match(explorerPage, /<title>\{labels\.plural\} — Mavero<\/title>/, 'document titles derive from the shared labels');
assert.match(spotlight, /aria-roledescription="carousel"/, 'the spotlight is a real carousel landmark');
assert.match(spotlight, /role="tablist" aria-label="Choose spotlight title"/, 'carousel dots are a tablist with labels');
assert.match(spotlight, /aria-label="Previous spotlight title"[\s\S]*?aria-label="Next spotlight title"/, 'carousel prev/next buttons are labeled');
assert.match(spotlight, /min-height: 44px/, 'spotlight action buttons keep the 44px touch target');
assert.match(explorerPage, /aria-busy="true"/, 'skeleton loading is announced');
assert.match(explorerPage, /aria-live="polite"/, 'loading/end states are announced politely');
assert.match(explorerPage, /prefers-reduced-motion: reduce/, 'reduced motion is honored by the Explorer');
assert.match(explorerPage, /\.explorer-grid :global\(\.mc-title\) \{[\s\S]*-webkit-line-clamp: 2/, 'card titles keep the 2-line clamp in the results grid');
assert.match(explorerPage, /@media \(max-width: 640px\)[\s\S]*?\.explorer-grid \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/, 'mobile results grid stays 2 columns');
assert.match(explorerPage, /grid-template-columns: repeat\(auto-fill, minmax\(150px, 182px\)\)/, 'desktop grid keeps the responsive auto-fill');
ok('9. labels, a11y, motion and responsive grid contracts preserved');

// ============================================================
// 10. DATA SAFETY — no fixtures, existing semantics intact
// ============================================================
assert.doesNotMatch(explorerPage, /fixtureMedia/, 'the Explorer never renders fixture media');
assert.match(loader, /provider !== 'fixtures'/, 'fixture responses are treated as unavailable (honesty contract)');
assert.ok(contentRail.includes('role="list"'), 'ContentRail list semantics preserved');
assert.match(loader, /MAX_EXPLORER_FEED_PAGE = 20/, 'the feed keeps the 1..20 serving window (the existing pagination contract)');
// Follow-up task 2 (§10): the feed reuses the collection sort +
// language path (top-rated maps to the existing 'Top rated' ordering)
// and the popular Show-more continuation reuses the popular() service.
assert.match(loader, /sort: filters\.sort === 'top-rated' \? 'Top rated' : 'For you'/, 'the movie/series feed reuses the collection sort + language path');
assert.match(loader, /filters\.sort === 'popular' && !filters\.genre[\s\S]*?popular\(type, safePage\)/, 'the popular Show-more continuation reuses the existing popular() service');
assert.match(loader, /getTmdbAnimeMerged\(filters\.sort === 'top-rated' \? 'top-rated' : 'popularity', safePage, constraint\)/, 'the anime feed reuses the merged anime path with the per-side genre constraint');
ok('10. data safety: no fixtures, no schema changes, existing pagination/caching semantics reused');

console.log(`\nExplorer page tests passed (${passed} check groups).`);
