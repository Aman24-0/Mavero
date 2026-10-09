import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// MAVERO — Explorer Destinations UX/UI Contract
// (Navigation & Settings Redesign Phase 1 + the Explorer redesign).
//
// Regression contract for /movies, /tv-shows, /anime — the three
// first-class destinations, now rendered as dedicated Explorers
// (spotlight carousel + genre/language chips + Popular/Top Rated
// sections, or the filtered progressive feed):
//
//   NAV        — the three destinations render INSIDE the consumer
//                AppShell (sidebar + bottom nav): they are top-level
//                routes, not Discover children. The "← Discover" back
//                link is gone. /discover, /search, /my-list, /settings
//                keep AppShell; admin/watch/auth bare behavior unchanged.
//   REDIRECTS  — the legacy /discover/{movies,series,anime} paths are
//                permanent 308 redirects preserving the query string.
//   ROUTES     — one shared ExplorerPage serves all three destinations
//                (no duplicate canonical implementations).
//   FILTER     — genre/language chips build canonical shareable URLs,
//                reset to the feed's first page, and every value is
//                validated server-side against closed taxonomies.
//   RESULTS    — progressive/infinite loading with dedup, guarded
//                requests and a responsive first batch (the detailed
//                contracts live in explorer_page_test.ts).
//   RESPONSIVE — horizontally scrollable chip rows + 2-column mobile
//                grid + no overflow-prone layouts at 390/360px.
//   SCROLL     — root snapshot mechanism intact; no custom scroll stores.
//   ANIME      — anime shares the shell, keeps its identity, and no
//                legacy anime architecture is reintroduced.
//   TERMINOLOGY — "Series" is presented as "TV Shows" in destination
//                copy while the card badge pipeline (formatType) is
//                untouched.

let passed = 0;
function ok(message: string) {
  passed += 1;
  console.log(`  ok ${passed} - ${message}`);
}

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

const rootLayout = read('../src/routes/+layout.svelte');
const appShell = read('../src/lib/components/AppShell.svelte');
const explorerPage = read('../src/lib/components/ExplorerPage.svelte');
const spotlightCarousel = read('../src/lib/components/SpotlightCarousel.svelte');
const mediaCard = read('../src/lib/components/MediaCard.svelte');
const taxonomy = read('../src/lib/shared/explorer-taxonomy.ts');
const loader = read('../src/lib/server/content/explorer-load.ts');
const types = read('../src/lib/server/content/types.ts');
const tmdbAdapter = read('../src/lib/server/content/adapters/tmdb.ts');
const routes = {
  movies: read('../src/routes/movies/+page.svelte'),
  series: read('../src/routes/tv-shows/+page.svelte'),
  anime: read('../src/routes/anime/+page.svelte')
};
const legacyServers = {
  movies: read('../src/routes/discover/movies/+page.server.ts'),
  series: read('../src/routes/discover/series/+page.server.ts'),
  anime: read('../src/routes/discover/anime/+page.server.ts')
};

// ============================================================
// 1. NAV — first-class destinations render inside the consumer AppShell
// ============================================================
const bareBranch = rootLayout.match(/\{#if page\.url\.pathname[\s\S]*?\{:else\}/);
assert.ok(bareBranch, 'layout branch structure intact');
const bare = bareBranch![0];
assert.match(bare, /startsWith\('\/admin'\)/, '/admin bare behavior unchanged');
assert.match(bare, /startsWith\('\/watch\/'\)/, '/watch bare behavior unchanged');
// The old discover-sub-page bare-render exclusion is GONE — the new
// destinations are top-level consumer pages rendered inside AppShell.
assert.doesNotMatch(rootLayout, /discover\\\/\(movies\|series\|anime\)/, 'the discover sub-page bare-render exclusion regex is removed from the layout');
// The bare-render CONDITION itself must not mention the new destinations
// (comments may reference them for documentation — the condition is what
// decides rendering).
const bareCondition = bareBranch![0].match(/\{#if ([^}]+)\}/);
assert.ok(bareCondition, 'the bare-render condition expression is parseable');
assert.doesNotMatch(bareCondition![1], /'\/movies'|'\/tv-shows'|'\/anime'/, 'the new destinations are never bare-rendered (they render inside AppShell)');
const elseBranch = rootLayout.slice(rootLayout.indexOf('{:else}'), rootLayout.indexOf('{/if}'));
assert.match(elseBranch, /<AppShell currentPath=\{page\.url\.pathname\}/, 'the new destinations render inside AppShell');
assert.doesNotMatch(elseBranch, /showMobileNav/, 'MAV-21: global navigation is unconditional (no /settings opt-out)');
ok('1. /movies, /tv-shows, /anime render inside the consumer AppShell (no bare render)');

// ============================================================
// 2. NAV — AppShell carries the six destinations; no Discover dependency
// ============================================================
assert.match(appShell, /Discover[\s\S]*Movies[\s\S]*TV Shows[\s\S]*Anime[\s\S]*Live TV[\s\S]*Search/, 'consumer primary links: Discover/Movies/TV Shows/Anime/Live TV/Search (LT-1)');
assert.match(appShell, /class="mobile-nav"/, 'mobile bottom nav still defined for consumer pages');
assert.doesNotMatch(appShell, /\/admin|\/discover\/movies/, 'AppShell gains no route special cases (new destinations are normal AppShell pages)');
// The back link to Discover is gone — these are not child pages anymore,
// and the Explorer UI carries no Discover dependency.
assert.doesNotMatch(explorerPage, /back-link/, 'no "← Discover" back link in the Explorer shell');
assert.doesNotMatch(explorerPage, /href="\/discover"/, 'no Discover dependency remains in the Explorer shell');
ok('2. AppShell carries the six destinations; the Explorer shell has no Discover dependency');

// ============================================================
// 3. REDIRECTS — legacy paths redirect permanently, query preserved
// ============================================================
assert.match(legacyServers.movies, /throw redirect\(308, `\/movies\$\{url\.search\}`\)/, '/discover/movies → 308 /movies with query');
assert.match(legacyServers.series, /throw redirect\(308, `\/tv-shows\$\{url\.search\}`\)/, '/discover/series → 308 /tv-shows with query');
assert.match(legacyServers.anime, /throw redirect\(308, `\/anime\$\{url\.search\}`\)/, '/discover/anime → 308 /anime with query');
for (const [key, server] of Object.entries(legacyServers)) {
  assert.doesNotMatch(server, /loadCollectionData|loadExplorerData/, `${key} legacy route has no page loader (no duplicate implementation)`);
  assert.doesNotMatch(server, /export const actions/, `${key} legacy route exports no actions`);
}
ok('3. legacy routes are permanent query-preserving redirects with zero page implementation');

// ============================================================
// 4. ROUTES — the new paths use the shared ExplorerPage (one Explorer
//    per destination: spotlight + chips + sections / filtered feed)
// ============================================================
assert.match(routes.movies, /<ExplorerPage\s+type="movie"/, '/movies renders the shared ExplorerPage');
assert.match(routes.series, /<ExplorerPage\s+type="series"/, '/tv-shows renders the shared ExplorerPage');
assert.match(routes.anime, /<ExplorerPage\s+type="anime"/, '/anime renders the shared ExplorerPage');
assert.match(explorerPage, /<SpotlightCarousel items=\{spotlight\}/, 'the Explorer embeds the spotlight carousel');
assert.match(explorerPage, /<ContentRail title=\{section\.title\} items=\{section\.items\} href=\{section\.showMoreHref \|\| ''\} linkLabel="Show more" \/>/, 'unfiltered sections render through the existing ContentRail (+ the Follow-up task 2 Show-more CTA)');
assert.match(spotlightCarousel, /\/watch\/\$\{slide\.type\}\/\$\{slide\.id\}/, 'spotlight Play links to the existing watch route (playback preserved)');
for (const [key, src] of Object.entries(routes)) assert.match(src, /totalPages=\{data\.totalPages\}/, `${key} route passes totalPages through`);
ok('4. the three first-class routes reuse one shared ExplorerPage (spotlight + chips + sections/feed)');

// ============================================================
// 5. FILTER — canonical URLs, first-page reset, server-side safety
// ============================================================
assert.match(explorerPage, /void goto\(`\$\{page\.url\.pathname\}\$\{query \? `\?\$\{query\}` : ''\}`/, 'filter changes build a canonical shareable URL on the same path');
assert.match(explorerPage, /function updateFilters\(next: \{ genre\?: string; language\?: string; sort\?: string \}\)/, 'filter changes carry the Explorer dimensions (genre/language/sort)');
assert.match(explorerPage, /function clearAllFilters\(\)/, 'clear filters drops genre + language + sort');
assert.doesNotMatch(explorerPage, /localStorage|sessionStorage/, 'no browser persistence for filter state');
assert.match(loader, /isExplorerGenre\(type, genreParam\)/, 'genre values validated against the closed taxonomy (server-side)');
assert.match(loader, /isExplorerLanguage\(type, languageParam\)/, 'language values validated per type (server-side)');
assert.match(loader, /page >= 1 && page <= MAX_EXPLORER_FEED_PAGE \? page : 1/, 'out-of-range pages clamp safely to 1 (server-side)');
assert.doesNotMatch(explorerPage, /feedItems = feedItems\.filter\(item => item\.genres/, 'no client-side genre filtering — the server feed stays authoritative');
ok('5. filter behavior: canonical URLs, closed-taxonomy validation, server-side clamping');

// ============================================================
// 6. PROGRESSIVE RESULTS — infinite loading contracts (the old
//    prev/next pagination was replaced by the approved progressive UX)
// ============================================================
assert.match(explorerPage, /IntersectionObserver/, 'progressive loading uses an observer sentinel');
assert.match(explorerPage, /rootMargin: '600px 0px'/, 'the sentinel prefetches before it is fully visible');
assert.match(explorerPage, /if \(loadingMore \|\| !feedHasNext \|\| feedExhausted \|\| feedPage >= MAX_FEED_PAGE\) return;/, 'duplicate requests, rapid scrolls and the serving window are all guarded');
assert.match(explorerPage, /feedExhausted = true/, 'end-of-results is derived from hasNextPage/totalPages');
assert.match(explorerPage, /You've reached the end of the results\./, 'the end state is user-visible');
assert.match(types, /totalPages\?: number/, 'ContentList carries an optional, non-breaking totalPages');
assert.match(tmdbAdapter, /totalPages: result\.total_pages/, 'movie/series collection exposes the upstream total_pages');
// The anime merged path must NOT invent a total (spec: never invent N).
const animeMerged = tmdbAdapter.match(/export async function getTmdbAnimeMerged[\s\S]*?\n\}/);
assert.ok(animeMerged, 'getTmdbAnimeMerged source captured');
assert.doesNotMatch(animeMerged![0], /\btotalPages\b/, 'anime merged path does NOT report a total');
assert.match(loader, /MAX_EXPLORER_FEED_PAGE = 20/, 'the 1..20 serving window is a single named constant');
ok('6. progressive results: observer sentinel, dedup, request guards, honest end state (1..20 window)');

// ============================================================
// 7. RESPONSIVE — scrollable chip rows + grid discipline
// ============================================================
// Chips render from the shared taxonomy (no native selects, no new
// modal) and scroll horizontally within their own row.
assert.match(explorerPage, /import \{ EXPLORER_GENRES, EXPLORER_LANGUAGES, EXPLORER_SORT_TITLES, type ExplorerSort \} from '\$lib\/shared\/explorer-taxonomy';/, 'chips + sort labels come from the shared taxonomy module');
assert.doesNotMatch(explorerPage, /<select/, 'no native <select> elements');
assert.match(explorerPage, /\.chip-scroll \{[\s\S]*?overflow-x: auto/, 'chip rows scroll horizontally');
assert.match(explorerPage, /\.chip-scroll \{[\s\S]*?flex-wrap: nowrap/, 'chip rows never wrap (no vertical stacking on phones)');
assert.match(explorerPage, /\.chip-scroll::-webkit-scrollbar \{ display: none; \}/, 'chip rows hide their scrollbar (contained, no page-level overflow)');
assert.match(explorerPage, /\.filter-chip \{[\s\S]*?white-space: nowrap/, 'chips never wrap mid-label');
// Explorer results grid discipline.
assert.match(explorerPage, /\.explorer-grid :global\(\.mc-title\) \{[\s\S]*-webkit-line-clamp: 2/, 'card titles clamp to 2 lines (scoped to the results grid)');
assert.match(explorerPage, /\.explorer-grid :global\(\.mc-title\) \{[\s\S]*min-height: 2\.5em/, 'two-line title block reserved → uniform card heights');
assert.match(explorerPage, /@media \(max-width: 640px\)[\s\S]*?\.explorer-grid \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/, 'mobile grid stays 2 columns (never forced to 3)');
assert.match(explorerPage, /grid-template-columns: repeat\(auto-fill, minmax\(150px, 182px\)\)/, 'desktop grid keeps the responsive auto-fill');
assert.match(mediaCard, /\.mc-title \{ margin: 0/, 'MediaCard itself untouched (clamp is results-grid-scoped)');
// LT-18: the spotlight is a cinematic FULL-BLEED hero (Discover's design
// language) — it spans the complete viewport width at every breakpoint.
assert.match(spotlightCarousel, /\.spotlight \{[\s\S]*?width: 100%;/, 'the spotlight spans the full viewport width');
assert.match(spotlightCarousel, /@media \(max-width: 640px\)[\s\S]*?min-height: 66vh;/, 'mobile keeps a cinematic viewport-height hero');
// Sticky chips respect the shell (topbar offsets per breakpoint).
assert.match(explorerPage, /@media \(max-width: 640px\)[\s\S]*?\.explorer-filters \{ top: var\(--topbar-h-safe\)/, 'mobile: sticky chips sit below the sticky topbar (safe-area aware)');
assert.match(explorerPage, /@media \(min-width: 641px\) and \(max-width: 1024px\)[\s\S]*?\.explorer-filters \{ top: 72px; \}/, 'tablet: sticky chips sit below the sticky topbar');
assert.match(explorerPage, /@media \(min-width: 1025px\)[\s\S]*?\.explorer-filters \{ top: 0; \}/, 'desktop: sticky chips stick at the scroll container top (no sidebar collision)');
ok('7. responsive: scrollable chip rows, 2-col grid, 2-line titles, sticky offsets per breakpoint, full-bleed spotlight');

// ============================================================
// 8. EMPTY STATE — clear-filters action, error distinction kept
// ============================================================
const emptyState = read('../src/lib/components/EmptyState.svelte');
assert.match(emptyState, /export let onAction: \(\(\) => void\) \| undefined = undefined/, 'EmptyState keeps the optional in-place action (backward compatible)');
assert.match(explorerPage, /title="Nothing found"[\s\S]*?actionLabel="Clear filters"[\s\S]*?onAction=\{clearAllFilters\}/, 'filtered zero results → "Nothing found" + working Clear filters');
assert.match(explorerPage, /title="The signal is quiet\."/, 'upstream errors keep their distinct error state');
assert.match(explorerPage, /errorMessage \&\& feedItems\.length === 0\}[\s\S]*?\{:else if sameRouteNavigation\}/, 'error branch evaluated before empty-state branches (errors never shown as "no results")');
assert.doesNotMatch(explorerPage, /fake|fixture results|dummy/, 'no fake/fixture results injected for empty states');
ok('8. empty state: Clear filters works in place; upstream errors stay distinct; no fixture results');

// ============================================================
// 9. LOADING — same-route skeleton reuses existing components
// ============================================================
assert.match(explorerPage, /import SkeletonCard from '\$components\/SkeletonCard\.svelte';/, 'loading UX reuses SkeletonCard (no new architecture)');
assert.match(explorerPage, /sameRouteNavigation = \$derived\(\s*\n?\s*Boolean\(\s*\n?\s*navigating\.from &&\s*\n?\s*navigating\.to &&\s*\n?\s*navigating\.type !== 'popstate'/, 'skeleton only during same-route forward navigation (Back/Forward stays instant)');
assert.match(explorerPage, /aria-busy="true"/, 'skeleton grid is announced via aria-busy');
assert.match(explorerPage, /\{#each Array\(skeletonCount\) as _, index \(index\)\}<SkeletonCard compact \/>/, 'skeleton count mirrors the real grid (minimal layout shift)');
ok('9. loading: same-route skeleton from existing SkeletonCard; popstate Back/Forward untouched');

// ============================================================
// 10. SCROLL — root snapshot mechanism intact, no custom stores
// ============================================================
assert.match(rootLayout, /export const snapshot = \{/, 'root layout snapshot (capture/restore) intact');
assert.match(rootLayout, /requestAnimationFrame/, 'rAF-clamped restore intact');
assert.doesNotMatch(explorerPage, /window\.scrollTo|history\.back|history\.forward/, 'the Explorer adds no custom scroll manager');
ok('10. scroll: existing SvelteKit snapshot mechanism preserved; no custom scroll state');

// ============================================================
// 11. TERMINOLOGY — TV Shows rename in destination copy only
// ============================================================
assert.match(explorerPage, /DESTINATION_LABELS/, 'per-type label map exists (shared module)');
const labelsModule = read('../src/lib/shared/content-labels.ts');
const labelsBlock = labelsModule.match(/export const DESTINATION_LABELS: Record<ContentType, \{ plural: string; singular: string; prose: string; description: string \}> = \{([\s\S]*?)\};/);
assert.ok(labelsBlock, 'DESTINATION_LABELS source captured');
assert.match(labelsBlock![1], /series: \{\s*plural: 'TV Shows'/, 'series destination is presented as "TV Shows"');
assert.match(labelsBlock![1], /movie: \{\s*plural: 'Movies'/, 'movie destination is "Movies"');
assert.match(labelsBlock![1], /anime: \{\s*plural: 'Anime'/, 'anime destination stays "Anime" (never "Animes")');
assert.match(labelsModule, /export const DESTINATION_ROUTES: Record<ContentType, string> = \{\s*movie: '\/movies',\s*series: '\/tv-shows',\s*anime: '\/anime'\s*\}/, 'canonical routes map unchanged');
// The card badge pipeline is untouched — classification still says
// "Series" on cards (formatType), only destination copy is renamed.
assert.match(mediaCard, /formatType|formatBadges|isAnime/, 'card classification badges still flow through the existing pipeline');
assert.doesNotMatch(explorerPage + taxonomy, /AniList|anilist\.|Yenime|yenime|myanimelist/i, 'no legacy anime provider architecture reintroduced');
assert.doesNotMatch(explorerPage, /anime format/i, 'no anime format filter added');
ok('11. terminology: "TV Shows" in destination copy; card badge pipeline untouched');

// ============================================================
// 12. DATA SAFETY — additive-only backend surface
// ============================================================
assert.doesNotMatch(loader, /\badult\b/i, 'the explorer loader touches no adult logic');
// Positive assertions: the existing TMDB collection semantics are unchanged.
const getTmdbCollection = tmdbAdapter.match(/export async function getTmdbCollection[\s\S]*?\n\}/);
assert.ok(getTmdbCollection, 'getTmdbCollection source captured');
assert.match(getTmdbCollection![0], /without_networks: networkExclusion/, 'series adult-network exclusion unchanged');
assert.match(getTmdbCollection![0], /without_watch_providers/, 'movie watch-provider exclusion unchanged');
assert.match(getTmdbCollection![0], /include_adult: false/, 'include_adult: false unchanged');
assert.match(emptyState, /export let search = false/, 'EmptyState legacy props untouched');
ok('12. data safety: additive language dimension only; TMDB semantics, adult surface, schema untouched');

console.log(`\nExplorer destination UX regression tests passed (${passed} check groups).`);
