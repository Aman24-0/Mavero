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
ok(/<AdminPage>/.test(libraryPage), 'A2a. AdminPage framework still wraps the content (header-less form)');
ok(/<AdminAppShell active="media-library">/.test(libraryPage), 'A2b. Admin Panel shell header RETAINED with its navigation');
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
console.log('§C — sticky toolbar + natural card scroll (no nested boxes)');
// ===========================================================================
const toolbarCss = mediaList.match(/\.toolbar \{[^}]+\}/)?.[0] ?? '';
ok(/position:\s*sticky/.test(toolbarCss), 'C1a. toolbar is position:sticky within the scrolling admin content region');
ok(/top:\s*var\(--a2-topbar-h-safe/.test(toolbarCss), 'C1b. sticky offset accounts for the fixed admin header height');
ok(/background:\s*var\(--a2-bg\)/.test(toolbarCss), 'C1c. opaque toolbar background (cards never show through)');
ok(/z-index:\s*30/.test(toolbarCss), 'C1d. toolbar z-index below the bottom nav (45) and dialogs (92+)');
const listCss = mediaList.match(/\.media-list \{[^}]+\}/)?.[0] ?? '';
const gridCss = mediaList.match(/\.media-grid \{[^}]+\}/)?.[0] ?? '';
ok(!/max-height/.test(listCss) && !/overflow-y/.test(listCss), 'C2a. list view: NO nested scroll container (natural scroll)');
ok(!/max-height/.test(gridCss) && !/overflow-y/.test(gridCss), 'C2b. grid view: NO nested scroll container (natural scroll)');
ok(!/overflow-x:\s*(scroll|auto)/.test(mediaList.replace(/overscroll-behavior-x[^;]*;/g, '')), 'C2c. no horizontal page overflow introduced');
// Infinite scroll survives the container change via the capture-phase
// window listener (sees BOTH the shell's .a2-main and the document).
ok(/addEventListener\('scroll', onWindowScroll, \{ capture: true, passive: true \}\)/.test(mediaList), 'C3a. capture-phase window scroll listener (both scroll architectures)');
ok(/checkCardsNearViewportBottom/.test(mediaList), 'C3b. proximity-based load-more (rect-based, container-agnostic)');
ok(/data-media-cards/.test(mediaList), 'C3c. cards area is identifiable for the proximity check');

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
