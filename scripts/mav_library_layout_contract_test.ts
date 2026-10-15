/**
 * Task 2 regression (2026-10-15) — Media Library page layout redesign.
 *
 * Required layout (source-contract test — NO browser):
 *   1. Admin Panel header (shell) — retained, untouched.
 *   2. Search bar — full available row width.
 *   3. Controls row — Add File (left) + view toggle + filter (right).
 *   4. Media cards/list.
 *
 *   * The Media Library page heading + explanatory paragraph are REMOVED
 *     (AdminPage renders no header block when every header input is
 *     absent — the shell header is unaffected).
 *   * The toolbar is STICKY inside the scrolling admin content region;
 *     the cards scroll NATURALLY beneath it (no nested scroll containers).
 *   * The last row clears the fixed bottom navigation via the shell's
 *     existing .a2-main padding-bottom (no competing scroll boxes).
 *   * Safe-area insets, responsive breakpoints, filter/search/view-toggle/
 *     Add File/URL-driven initialFilters contracts all preserved.
 *
 * Run: pnpm exec tsx --tsconfig ./jsconfig.json scripts/mav_library_layout_contract_test.ts
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(path.resolve(__dirname, '..', rel), 'utf8');

let passed = 0;
let failed = 0;
function ok(cond: boolean, label: string): void {
  if (cond) { passed += 1; console.log(`  ok ${passed} - ${label}`); }
  else { failed += 1; console.log(`  FAIL ${passed + failed} - ${label}`); }
}

const libraryPage = read('src/routes/admin/media/library/+page.svelte');
const adminPage = read('src/lib/components/admin2/AdminPage.svelte');
const mediaList = read('src/lib/components/admin2/AdminMediaList.svelte');
const shell = read('src/lib/components/admin2/AdminAppShell.svelte');
const libraryPageServer = read('src/routes/admin/media/library/+page.server.ts');

// ===========================================================================
console.log('§A — heading + explanatory paragraph removed (shell header kept)');
// ===========================================================================
ok(!/eyebrow="Content"/.test(libraryPage), 'A1a. no page eyebrow');
ok(!/title="Media Library"/.test(libraryPage), 'A1b. no page title heading');
ok(!/description\(\)/.test(libraryPage) && !/snippet description/.test(libraryPage), 'A1c. no explanatory paragraph snippet');
ok(!/\{#snippet actions\(\)\}/.test(libraryPage), 'A1d. no page-level actions snippet (Add File moved into the toolbar)');
ok(/<AdminPage fill>/.test(libraryPage), 'A2a. AdminPage framework still wraps the content (header-less form, FILL mode)');
ok(/<AdminAppShell active="media-library" fill>/.test(libraryPage), 'A2b. Admin Panel shell header RETAINED with its navigation (fill mode)');
ok(/AdminMediaList/.test(libraryPage), 'A2c. the media list remains the sole content component');

// AdminPage skips the header block when EVERY header input is absent.
ok(/\{:else if eyebrow \|\| title \|\| description \|\| actions\}/.test(adminPage), 'A3a. AdminPage renders the header only when a header input exists');
ok(/title\?: string;/.test(adminPage), 'A3b. AdminPage title is optional (header-less pages allowed)');

// ===========================================================================
console.log('§B — toolbar order: search row, then controls row');
// ===========================================================================
const searchRowIdx = mediaList.indexOf('class="search-row"');
const controlsRowIdx = mediaList.indexOf('class="controls-row"');
const addFileIdx = mediaList.indexOf('class="add-file-btn"');
const controlsRightIdx = mediaList.indexOf('class="controls-right"');
const viewToggleIdx = mediaList.indexOf('class="view-toggle"');
const filterBtnIdx = mediaList.indexOf('class="filter-btn"');
const cardsIdx = mediaList.indexOf('class="media-grid"');
ok(searchRowIdx >= 0, 'B1a. toolbar has a dedicated search row');
ok(controlsRowIdx > searchRowIdx, 'B1b. controls row comes AFTER the search row');
ok(addFileIdx > controlsRowIdx && addFileIdx < controlsRightIdx, 'B1c. Add File is in the controls row, LEFT side');
ok(controlsRightIdx > controlsRowIdx, 'B1d. view toggle + filter are grouped right');
ok(viewToggleIdx > controlsRightIdx && filterBtnIdx > controlsRightIdx, 'B1e. view toggle + filter live in the right controls group');
ok(cardsIdx > filterBtnIdx, 'B1f. the cards/list render AFTER the toolbar');
ok(/<div class="search-input-wrap">[\s\S]*?aria-label="Search media library"/.test(mediaList), 'B2a. search keeps its accessible label');
ok(/function openAddWizard/.test(mediaList) && /onclick=\{openAddWizard\}/.test(mediaList), 'B2b. Add File opens the shared wizard');

// ===========================================================================
console.log('§C — FILL-MODE layout: static toolbar + ONE cards scroller');
// (2026-10-16 re-pin: the old position:sticky contract was REPLACED. On
//  mobile the shell's .a2-main keeps overflow-y:auto from its base rule
//  while `height:auto` lets the DOCUMENT scroll — an overflow ancestor is
//  the sticky scrollport even when it never scrolls, so the toolbar stuck
//  nothing and scrolled away with the page (the reported defect). The new
//  architecture: the library page opts into the shell's FILL MODE — the
//  toolbar is a STATIC flex block and the cards region below it is the
//  page's single scroll container, bounded by the real header/nav tokens.)
// ===========================================================================
const toolbarCss = mediaList.match(/\.toolbar \{[^}]+\}/)?.[0] ?? '';
ok(!/position:\s*sticky/.test(toolbarCss) && /position:\s*relative/.test(toolbarCss), 'C1a. toolbar is a STATIC block (fill-mode column) — never sticky, never scrolls away');
ok(/flex:\s*0 0 auto/.test(toolbarCss), 'C1b. toolbar keeps its natural height (flex: 0 0 auto) above the scroller');
ok(/background:\s*var\(--a2-bg\)/.test(toolbarCss), 'C1c. opaque toolbar background (cards never show through)');
ok(/z-index:\s*30/.test(toolbarCss), 'C1d. toolbar z-index below the bottom nav (45) and dialogs (92+)');
const sectionCss = mediaList.match(/\.media-library \{[^}]+\}/)?.[0] ?? '';
ok(/flex:\s*1 1 auto/.test(sectionCss) && /min-height:\s*0/.test(sectionCss), 'C1e. the library section fills the fill-mode page body (flex chain)');
// THE single scroll container: .cards-scroll, sibling AFTER the toolbar.
const scrollCss = mediaList.match(/\.cards-scroll \{[^}]+\}/)?.[0] ?? '';
const scrollIdx = mediaList.indexOf('class="cards-scroll"');
const toolbarIdx = mediaList.indexOf('class="toolbar"');
ok(/overflow-y:\s*auto/.test(scrollCss) && /flex:\s*1 1 auto/.test(scrollCss) && /min-height:\s*0/.test(scrollCss), 'C2a. the cards region is the ONE scroll container (overflow-y:auto, flex-sized)');
ok(scrollIdx > toolbarIdx, 'C2b. the scroller renders AFTER the toolbar — the first card can never be covered by it');
ok(/data-media-cards-scroll/.test(mediaList), 'C2c. the scroll container is identifiable (data attribute)');
ok(/overscroll-behavior:\s*contain/.test(scrollCss), 'C2d. scroll chaining contained inside the cards region');
// Both view modes render INSIDE the same single scroller (consistent
// scroll ownership across list/grid).
const listOpenIdx = mediaList.indexOf('<div class="media-list"');
const gridOpenIdx = mediaList.indexOf('<div class="media-grid"');
ok(scrollIdx < listOpenIdx && scrollIdx < gridOpenIdx, 'C2e. list AND grid render inside the SAME scroller (consistent scroll ownership)');
const listCss = mediaList.match(/\.media-list \{[^}]+\}/)?.[0] ?? '';
const gridCss = mediaList.match(/\.media-grid \{[^}]+\}/)?.[0] ?? '';
ok(!/max-height/.test(listCss) && !/overflow-y/.test(listCss), 'C2f. list view: no SECOND scroll box inside the scroller');
ok(!/max-height/.test(gridCss) && !/overflow-y/.test(gridCss), 'C2g. grid view: no SECOND scroll box inside the scroller');
ok(!/overflow-x:\s*(scroll|auto)/.test(mediaList.replace(/overscroll-behavior-x[^;]*;/g, '')), 'C2h. no horizontal page overflow introduced');
// The shell owns the fill-mode chain: exactly-viewport main + flex column
// workspace (heights derive from the REAL header/nav tokens, and the
// workspace top padding is removed so the search sits tight under the
// fixed admin header — the reported "large blank gap").
ok(/\.a2-shell \.a2-main-fill/.test(shell), 'C3a. the shell defines the fill-mode class chain');
ok(/height:\s*100dvh/.test(shell.match(/\.a2-shell \.a2-main-fill \{[^}]+\}/)?.[0] ?? '') && /overflow:\s*hidden/.test(shell.match(/\.a2-shell \.a2-main-fill \{[^}]+\}/)?.[0] ?? ''), 'C3b. fill-mode main is exactly 100dvh and NOT a scroller (overflow hidden)');
ok(/padding-top:\s*0/.test(shell.match(/\.a2-main-fill > \.a2-workspace \{[^}]+\}/)?.[0] ?? ''), 'C3c. fill-mode workspace drops its top padding (header→search gap closed)');
ok(/fill = false as boolean/.test(shell), 'C3d. fill mode is opt-in (other admin pages keep the default scroller)');
// Infinite scroll survives via the container onscroll + the capture-phase
// window listener (sees every scroller).
ok(/addEventListener\('scroll', onWindowScroll, \{ capture: true, passive: true \}\)/.test(mediaList), 'C3e. capture-phase window scroll listener (sees the cards scroller)');
ok(/checkCardsNearViewportBottom/.test(mediaList), 'C3f. proximity-based load-more (rect-based, container-agnostic)');
ok(/data-media-cards/.test(mediaList), 'C3g. cards area is identifiable for the proximity check');
ok(/onscroll=\{onScroll\}/.test(mediaList.match(/<div class="cards-scroll"[^>]*>/)?.[0] ?? ''), 'C3h. the scroller carries the load-more onscroll handler');

// ===========================================================================
console.log('§D — bottom-navigation clearance + safe areas');
// ===========================================================================
// The shell owns the clearance: .a2-main carries padding-bottom equal to
// the safe bottom-nav height on mobile, so the LAST row scrolls fully
// above the nav without any competing scroll container.
ok(/padding-bottom: var\(--a2-mobile-nav-h-safe\)/.test(shell), 'D1a. shell main region keeps bottom-nav clearance padding');
ok(/padding-bottom: env\(safe-area-inset-bottom, 0px\)/.test(shell), 'D1b. bottom nav respects safe-area insets');
ok(/--a2-mobile-nav-h-safe: calc\(/.test(read('src/app.css')), 'D1c. safe bottom-nav height variable defined globally');
// The library component itself must NOT hardcode its own bottom offset
// (that would create the obscured-last-row bug the old nested box had).
ok(!/padding-bottom:\s*calc\(100dvh/.test(mediaList), 'D1d. no local viewport-bottom padding hacks in the library');
ok(/@media \(max-width: 640px\)/.test(mediaList), 'D2a. responsive breakpoints preserved');

// ===========================================================================
console.log('§E — existing contracts preserved (search/filters/view/Add File/URL)');
// ===========================================================================
ok(/initialFilters=\{data\.initialFilters\}/.test(libraryPage), 'E1a. URL-driven initialFilters still passed to the list');
ok(/initialFilters/.test(libraryPageServer) && /url\.searchParams/.test(libraryPageServer), 'E1b. page server still parses URL params into initialFilters');
ok(/bind:value=\{searchQuery\}/.test(mediaList) && /oninput=\{onFilterChange\}/.test(mediaList), 'E2a. search input binding + debounce preserved');
ok(/openFilterSheet/.test(mediaList) && /applyFilters/.test(mediaList) && /clearFilters/.test(mediaList), 'E2b. filter sheet draft/apply/clear flow preserved');
ok(/toggleView\('list'\)/.test(mediaList) && /toggleView\('grid'\)/.test(mediaList), 'E2c. list/grid view toggle preserved');
ok(/mav-library-view/.test(mediaList), 'E2d. view-mode localStorage persistence preserved');
ok(/AdminEpisodeSheet/.test(mediaList) && /data-episode-sheet-opener/.test(mediaList), 'E2e. episode sheets + parent/episode hierarchy preserved');
ok(/toggleMenu/.test(mediaList), 'E2f. row/card action menus preserved');
ok(/loadList\(true\)/.test(mediaList) && /has_more/.test(mediaList), 'E2g. pagination contract preserved');
// The library page server loader is untouched by the layout change.
ok(/requireAdmin\(locals/.test(libraryPageServer) && /resolveHostingSources/.test(libraryPageServer), 'E3a. page server loader contract intact (admin + resolver)');

console.log(`\nmav_library_layout_contract_test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
