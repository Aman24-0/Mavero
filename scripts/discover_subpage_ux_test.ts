import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// MAVERO — Discover Collection Sub-Pages UX/UI Refinement.
//
// Regression contract for /discover/movies, /discover/series,
// /discover/anime (all rendering the shared CollectionPage):
//
//   NAV        — the three sub-pages render BARE (no consumer AppShell /
//                bottom nav — never hidden, never covered); /discover,
//                /search, /my-list, /profile keep AppShell; admin bare
//                behavior unchanged.
//   FILTER     — genre/year/sort changes reset to page 1, build canonical
//                shareable URLs, invalid values fail server-side-safe.
//   PAGINATION — previous/next + disabled state + query preservation +
//                "Page X of Y" only when the server provides a total.
//   RESPONSIVE — compact mobile filter control + 2-column grid + no
//                overflow-prone layouts at 390/360px, desktop unchanged.
//   SCROLL     — root snapshot mechanism intact; no custom scroll stores.
//   ANIME      — anime shares the refined shell, keeps its identity, and
//                no legacy anime architecture is reintroduced.

let passed = 0;
function ok(message: string) {
  passed += 1;
  console.log(`  ok ${passed} - ${message}`);
}

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

const rootLayout = read('../src/routes/+layout.svelte');
const appShell = read('../src/lib/components/AppShell.svelte');
const collection = read('../src/lib/components/CollectionPage.svelte');
const filterBar = read('../src/lib/components/FilterBar.svelte');
const dropdown = read('../src/lib/components/Dropdown.svelte');
const emptyState = read('../src/lib/components/EmptyState.svelte');
const mediaCard = read('../src/lib/components/MediaCard.svelte');
const loader = read('../src/lib/server/content/discover-load.ts');
const types = read('../src/lib/server/content/types.ts');
const tmdbAdapter = read('../src/lib/server/content/adapters/tmdb.ts');
const routes = {
  movies: read('../src/routes/discover/movies/+page.svelte'),
  series: read('../src/routes/discover/series/+page.svelte'),
  anime: read('../src/routes/discover/anime/+page.svelte')
};

// ============================================================
// 1. NAV — the three collection sub-routes render bare
// ============================================================
const bareBranch = rootLayout.match(/\{#if page\.url\.pathname[\s\S]*?\{:else\}/);
assert.ok(bareBranch, 'layout branch structure intact');
const bare = bareBranch![0];
assert.match(bare, /startsWith\('\/admin'\)/, '/admin bare behavior unchanged');
assert.match(bare, /startsWith\('\/watch\/'\)/, '/watch bare behavior unchanged');

// Extract the EXACT regex literal shipped in the layout and evaluate it
// against the routes that must / must not render bare.
const literalMatch = rootLayout.match(/\/\^\\\/discover\\\/\(movies\|series\|anime\)\\\/\?\$\//);
assert.ok(literalMatch, 'the bare branch contains the /discover/(movies|series|anime) exclusion regex literal');
const shippedRegex = new RegExp(literalMatch![0].slice(1, -1));
assert.ok(shippedRegex.test('/discover/movies'), '/discover/movies renders bare (no consumer nav)');
assert.ok(shippedRegex.test('/discover/series'), '/discover/series renders bare (no consumer nav)');
assert.ok(shippedRegex.test('/discover/anime'), '/discover/anime renders bare (no consumer nav)');
assert.ok(!shippedRegex.test('/discover'), '/discover itself KEEPS the consumer AppShell');
assert.ok(!shippedRegex.test('/search'), '/search unaffected');
assert.ok(!shippedRegex.test('/my-list'), '/my-list unaffected');
assert.ok(!shippedRegex.test('/profile'), '/profile unaffected');
assert.ok(!shippedRegexSource('/discover/movies/extra'), 'no nested discover paths are captured');

function shippedRegexSource(path: string) {
  return shippedRegex.test(path);
}
assert.ok(!shippedRegexSource('/settings'), '/settings unaffected');

assert.match(rootLayout, /must not render there[\s\S]*not hidden, not covered/i, 'admin not-hidden-not-covered contract intact');
assert.match(rootLayout, /never mounted on these three[\s\S]*not hidden, not covered, simply not rendered/, 'the discover sub-page contract is documented in the layout itself');
const elseBranch = rootLayout.slice(rootLayout.indexOf('{:else}'), rootLayout.indexOf('{/if}'));
assert.match(elseBranch, /<AppShell currentPath=\{page\.url\.pathname\}/, 'consumer pages still render inside AppShell');
assert.match(elseBranch, /showMobileNav=\{!page\.url\.pathname\.startsWith\('\/settings'\)\}/, '/settings opt-out unchanged');
ok('1. /discover/{movies,series,anime} render bare; /discover + all other consumers keep AppShell');

// ============================================================
// 2. NAV — AppShell untouched (no per-page special cases added)
// ============================================================
assert.match(appShell, /Discover[\s\S]*Search[\s\S]*My List[\s\S]*Profile/, 'consumer primary links unchanged');
assert.match(appShell, /class="mobile-nav"/, 'mobile bottom nav still defined for consumer pages');
assert.doesNotMatch(appShell, /\/admin|\/discover\/movies/, 'AppShell gains no route special cases (exclusion lives in the layout)');
ok('2. AppShell untouched — consumer navigation intact everywhere it belongs');

// ============================================================
// 3. FILTER — page reset, canonical URLs, server-side safety
// ============================================================
assert.match(collection, /params\.set\('page', '1'\)/, 'every filter change resets to page 1');
assert.match(collection, /void goto\(`\$\{page\.url\.pathname\}\$\{query \? `\?\$\{query\}` : ''\}`/, 'filter changes build a canonical shareable URL on the same path');
assert.match(collection, /function clearFilters\(\) \{ updateFilters\(\{ genre: 'All', sort: 'For you', year: 'All' \}\); \}/, 'clear filters drops genre/year/sort and returns to page 1');
assert.doesNotMatch(collection, /localStorage|sessionStorage/, 'no browser persistence for filter state');
assert.match(loader, /validCollectionSorts/, 'sort whitelist (server-side validation) intact');
assert.match(loader, /\\d\{4\}/, 'year values still validated as 4-digit (invalid values fail safe)');
assert.match(loader, /page <= MAX_COLLECTION_PAGE \? page : 1/, 'out-of-range pages clamp safely to 1 (server-side)');
assert.doesNotMatch(collection, /filteredItems/, 'no client-side filtering — server collection query stays authoritative');
ok('3. filter behavior preserved: page=1 reset, canonical URLs, server-side validation');

// ============================================================
// 4. PAGINATION — prev/next, disabled state, of-N, clamp parity
// ============================================================
assert.match(collection, /href=\{collectionHref\(currentPage - 1\)\}/, 'Previous link present');
assert.match(collection, /href=\{collectionHref\(currentPage \+ 1\)\}/, 'Next link present');
assert.match(collection, /class="pagination-link disabled"><ArrowLeft size=\{14\} \/> Previous/, 'disabled Previous rendered as a non-link span');
assert.match(collection, /hasNextPageSafe = hasNextPage && \(totalPages === undefined \|\| currentPage < totalPages\)/, 'Next disables at the server serving window (no page-21 wrap to page 1)');
assert.match(collection, /Page \{currentPage\} of \{totalPages\}/, '"Page X of Y" when a total is provided');
assert.match(collection, /totalPages !== undefined\}Page \{currentPage\} of \{totalPages\}\{:else\}Page \{currentPage\}/, 'falls back to plain "Page X" when no total exists (anime merged path)');
assert.match(collection, /const params = new URLSearchParams\(page\.url\.searchParams\)/, 'pagination preserves genre/year/sort query params');
assert.match(types, /totalPages\?: number/, 'ContentList carries an optional, non-breaking totalPages');
assert.match(tmdbAdapter, /totalPages: result\.total_pages/, 'movie/series collection exposes the upstream total_pages');

// The anime merged path must NOT invent a total (spec: never invent N).
const animeMerged = tmdbAdapter.match(/export async function getTmdbAnimeMerged[\s\S]*?\n\}/);
assert.ok(animeMerged, 'getTmdbAnimeMerged source captured');
assert.doesNotMatch(animeMerged![0], /\btotalPages\b/, 'anime merged path does NOT report a total');

assert.match(loader, /export const MAX_COLLECTION_PAGE = 20/, 'the 1..20 serving window is a single named constant');

// Behavioral check of the shipped clamp logic (extracted, TS-stripped,
// and evaluated with the shipped MAX_COLLECTION_PAGE constant).
const clampSource = loader.match(/function clampTotalPages\(value: unknown, page: number\): number \| undefined \{[\s\S]*?\n\}/);
assert.ok(clampSource, 'clampTotalPages helper present');
const maxPageMatch = loader.match(/export const MAX_COLLECTION_PAGE = (\d+)/);
assert.ok(maxPageMatch, 'MAX_COLLECTION_PAGE constant present');
const clampJs = clampSource![0].replace(/function clampTotalPages\(value: unknown, page: number\): number \| undefined/, 'function clampTotalPages(value, page)');
const clamp = new Function('MAX_COLLECTION_PAGE', `return ${clampJs};`)(Number(maxPageMatch![1])) as (value: unknown, page: number) => number | undefined;
assert.equal(clamp(500, 1), 20, 'TMDB total of 500 clamps to the 20-page serving window');
assert.equal(clamp(3, 2), 3, 'total never below the current page');
assert.equal(clamp(0, 1), undefined, 'nonsensical totals are not reported');
assert.equal(clamp(undefined, 1), undefined, 'missing total falls back to "Page X"');
assert.equal(clamp(Number.NaN, 1), undefined, 'NaN total falls back to "Page X"');
for (const [key, src] of Object.entries(routes)) assert.match(src, /totalPages=\{data\.totalPages\}/, `${key} route passes totalPages through`);
ok('4. pagination: prev/next + disabled + preserved query + safe of-N totals (clamped to the serving window)');

// ============================================================
// 5. RESPONSIVE — compact mobile filter control + grid discipline
// ============================================================
// FilterBar keeps the shared Dropdown (no native selects, no new modal).
assert.match(filterBar, /import Dropdown from '\$components\/Dropdown\.svelte'/, 'FilterBar reuses the shared Dropdown listbox');
assert.match(filterBar, /<Dropdown/, 'FilterBar renders shared Dropdown instances');
assert.doesNotMatch(filterBar, /<select/, 'no native <select> elements');
assert.match(filterBar, /filter-row-desktop[\s\S]*filter-genre[\s\S]*filter-year[\s\S]*filter-sort/, 'desktop keeps the full labelled Genre/Year/Sort bar');
assert.match(filterBar, /filters-toggle[\s\S]*aria-expanded=\{panelOpen\}[\s\S]*aria-controls="collection-filter-panel"/, 'mobile Filters toggle exposes expanded state + controlled surface');
assert.match(filterBar, /aria-label=\{activeFilterCount > 0 \? `Filters, \$\{activeFilterCount\} active` : 'Filters'\}/, 'Filters toggle carries an accessible name (with active count)');
assert.match(filterBar, /id="filter-sort-mobile" label="Sort" hideLabel/, 'mobile Sort dropdown hides its visual label');
assert.match(dropdown, /class:sr-only=\{hideLabel\}/, 'Dropdown hideLabel keeps the label in the accessibility tree (sr-only)');
assert.match(dropdown, /\.dropdown-label\.sr-only[\s\S]*clip: rect\(0 0 0 0\)/, 'sr-only pattern is a real visually-hidden implementation');
assert.match(filterBar, /id="filter-genre-mobile"[\s\S]*id="filter-year-mobile"/, 'mobile filter surface holds Genre + Year');
assert.match(filterBar, /@media \(max-width: 640px\)[\s\S]*\.filter-row-desktop \{ display: none; \}/, 'labelled bar is hidden on mobile');
assert.match(filterBar, /@media \(min-width: 641px\)[\s\S]*\.filter-row-mobile \{ display: none; \}/, 'compact control is hidden on desktop');
assert.match(filterBar, /\.filter-panel\[hidden\] \{ display: none; \}/, 'the collapsible surface actually hides via [hidden]');
assert.match(filterBar, /if \(!panelOpen \|\| event\.key !== 'Escape' \|\| event\.defaultPrevented\) return/, 'Escape closes the surface but never fights a nested Dropdown listbox Escape');
assert.match(filterBar, /panelOpen = false;[\s\S]*filtersToggle\?\.focus\(\)/, 'closing the surface returns focus to the Filters toggle');
assert.match(filterBar, /min-height: 38px/, 'Filters toggle keeps a comfortable touch target');
assert.match(filterBar, /grid-template-columns: minmax\(0, 1fr\) minmax\(0, 118px\)/, 'mobile primary row cannot overflow (minmax(0, …) tracks)');

// Collection shell: mobile efficiency + grid discipline.
assert.match(collection, /@media \(max-width: 640px\)[\s\S]*\.collection-heading \{ padding: 16px 0 12px; \}/, 'mobile heading rhythm tightened (content appears sooner)');
assert.match(collection, /\.collection-heading p \{[\s\S]*-webkit-line-clamp: 2/, 'mobile description limited to a short 2-line block');
assert.match(collection, /\.results-grid :global\(\.mc-title\) \{[\s\S]*-webkit-line-clamp: 2/, 'card titles clamp to 2 lines (scoped to the collection grid)');
assert.match(collection, /\.results-grid :global\(\.mc-title\) \{[\s\S]*min-height: 2\.5em/, 'two-line title block reserved → uniform card heights');
assert.match(collection, /@media \(max-width: 640px\)[\s\S]*\.results-grid \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/, 'mobile grid stays 2 columns (never forced to 3)');
assert.match(collection, /grid-template-columns: repeat\(auto-fill, minmax\(150px, 182px\)\)/, 'desktop grid unchanged (responsive auto-fill)');
assert.match(mediaCard, /\.mc-title \{ margin: 0/, 'MediaCard itself untouched (clamp is collection-scoped)');
assert.match(collection, /padding-bottom: calc\(26px \+ env\(safe-area-inset-bottom, 0px\)\)/, 'pagination keeps safe-area bottom spacing');
ok('5. responsive: compact mobile filter row, 2-col grid, 2-line titles, safe-area spacing, desktop preserved');

// ============================================================
// 6. EMPTY STATE — clear-filters action, error distinction kept
// ============================================================
assert.match(emptyState, /export let onAction: \(\(\) => void\) \| undefined = undefined/, 'EmptyState gains an optional in-place action (backward compatible)');
assert.match(emptyState, /\{#if onAction\}[\s\S]*<button class="btn btn-secondary" type="button" onclick=\{onAction\}>[\s\S]*\{:else\}[\s\S]*<a class="btn btn-secondary" href=\{actionHref\}/, 'href-based empty states unchanged; action-based renders a real button');
assert.match(collection, /title="Nothing found"[\s\S]*message="Try changing your filters or clear them to explore the full collection\."[\s\S]*actionLabel="Clear filters"[\s\S]*onAction=\{clearFilters\}/, 'filtered zero results → "Nothing found" + working Clear filters');
assert.match(collection, /title="The signal is quiet\."/, 'upstream errors keep their distinct error state');
assert.match(collection, /errorMessage\}[\s\S]*\{:else if sameRouteNavigation\}/, 'error branch evaluated before empty-state branches (errors never shown as "no results")');
assert.doesNotMatch(collection, /fake|fixture results|dummy/, 'no fake/fixture results injected for empty states');
ok('6. empty state: Clear filters works in place; upstream errors stay distinct; no fixture results');

// ============================================================
// 7. LOADING — same-route skeleton reuses existing components
// ============================================================
assert.match(collection, /import SkeletonCard from '\$components\/SkeletonCard\.svelte'/, 'loading UX reuses SkeletonCard (no new architecture)');
assert.match(collection, /sameRouteNavigation = Boolean\(navigating\.from && navigating\.to && navigating\.type !== 'popstate'/, 'skeleton only during same-route forward navigation (Back/Forward stays instant)');
assert.match(collection, /results-grid results-grid-loading" aria-busy="true"/, 'skeleton grid is announced via aria-busy');
assert.match(collection, /\{#each Array\(skeletonCount\) as _\}<SkeletonCard compact \/>/, 'skeleton count mirrors the real grid (minimal layout shift)');
assert.doesNotMatch(collection, /IntersectionObserver|MutationObserver/, 'no custom navigation interception or observers');
ok('7. loading: same-route skeleton from existing SkeletonCard; popstate Back/Forward untouched');

// ============================================================
// 8. SCROLL — root snapshot mechanism intact, no custom stores
// ============================================================
assert.match(rootLayout, /export const snapshot = \{/, 'root layout snapshot (capture/restore) intact');
assert.match(rootLayout, /requestAnimationFrame/, 'rAF-clamped restore intact');
assert.doesNotMatch(collection, /window\.scrollTo|history\.back|history\.forward/, 'CollectionPage adds no custom scroll manager');
assert.doesNotMatch(collection + filterBar, /localStorage|sessionStorage/, 'no storage-based scroll or filter state');
ok('8. scroll: existing SvelteKit snapshot mechanism preserved; no custom scroll state');

// ============================================================
// 9. ANIME — shared refined shell, identity kept, no legacy revival
// ============================================================
assert.match(routes.anime, /<CollectionPage type="anime"/, 'anime collection uses the shared CollectionPage shell');
assert.match(collection, /headingLabel = type === 'anime' \? 'Anime' : `\$\{label\}s`/, 'anime heading is "Anime in focus." (not "Animes")');
assert.match(collection, /\{headingLabel\} <em>in focus\.<\/em>/, 'all three collections share one consistent heading template');
assert.match(collection, /formatType/, 'anime identity still flows through the existing formatType/badge pipeline');
assert.doesNotMatch(collection + filterBar, /AniList|anilist\.|Yenime|yenime|myanimelist/i, 'no legacy anime provider architecture reintroduced');
assert.doesNotMatch(collection + filterBar, /anime format/i, 'no anime format filter added in this phase');
ok('9. anime: refined shared shell, correct heading, identity badges intact, zero legacy revival');

// ============================================================
// 10. DATA SAFETY — additive-only backend surface
// ============================================================
assert.doesNotMatch(loader, /\badult\b/i, 'collection loader touches no adult logic');
// Positive assertions: the existing TMDB collection semantics are unchanged.
const getTmdbCollection = tmdbAdapter.match(/export async function getTmdbCollection[\s\S]*?\n\}/);
assert.ok(getTmdbCollection, 'getTmdbCollection source captured');
assert.match(getTmdbCollection![0], /without_networks: networkExclusion/, 'series adult-network exclusion unchanged');
assert.match(getTmdbCollection![0], /without_watch_providers/, 'movie watch-provider exclusion unchanged');
assert.match(getTmdbCollection![0], /include_adult: false/, 'include_adult: false unchanged');
assert.match(collection, /export let totalPages: number \| undefined = undefined/, 'totalPages is an optional prop — callers not passing it are unaffected');
assert.match(emptyState, /export let search = false/, 'EmptyState legacy props untouched');
ok('10. data safety: additive totalPages contract only; TMDB semantics, adult surface, schema untouched');

console.log(`\nDiscover collection sub-page UX regression tests passed (${passed} check groups).`);
