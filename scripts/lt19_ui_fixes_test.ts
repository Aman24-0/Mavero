// MAVERO — LT-19 Targeted UI Bug Fixes: focused regression suite.
//
// Three production UI bugs, three minimal root-cause fixes:
//   §1  Live TV Filter sheet is CATEGORY-ONLY — the Language section and its
//       exclusive plumbing are REMOVED. The original LiveGT V1 provider
//       `category` taxonomy is the single filter dimension (English/Tamil/
//       Gujarati… stay as ordinary category options, verbatim).
//   §2  Guide sheet = ONE continuous programme list (LiveTvGuide is the
//       single source of programme cards; the duplicate Now Playing / Up
//       Next cards are gone). The current programme is marked ONLY by real
//       [start, stop) timing.
//   §3  Global header + bottom nav scroll drift (Chrome-Android fixed-layer
//       re-anchoring failures during URL-bar transitions):
//       (a) .mobile-nav is centered WITHOUT a transform (edge anchoring +
//           auto margins — pixel-identical, transform-free);
//       (b) the ≤640px topbar joins the tablet range's STICKY pattern and
//           the coupled .app-main padding-top compensation is gone.
//
// Source-contract style (same as the sibling UI suites): NO network,
// browser, DRM or Shaka package is involved. Geometry is verified live in
// the browser QA pass (Playwright over the production build) — this suite
// pins the structural contracts that make that geometry hold.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

let passed = 0;
function ok(label: string): void {
        passed++;
        console.log(`  ok ${passed} - ${label}`);
}

const read = (p: string): string => readFileSync(new URL(p, import.meta.url), 'utf8');
const appShell = read('../src/lib/components/AppShell.svelte');
const appCss = read('../src/app.css');
const explorerPage = read('../src/lib/components/ExplorerPage.svelte');
const filterSheet = read('../src/lib/components/live-tv/LiveTvFilterSheet.svelte');
const guideSheet = read('../src/lib/components/live-tv/LiveTvGuideSheet.svelte');
const guideList = read('../src/lib/components/live-tv/LiveTvGuide.svelte');
const apiSource = read('../src/lib/client/live-tv/api.ts');
const page = read('../src/routes/live-tv/+page.svelte');

/** Slice a source string from a start marker to just before an end marker. */
function sliceOf(source: string, start: string, end: string): string {
        const from = source.indexOf(start);
        assert.ok(from !== -1, `marker not found: ${start}`);
        const to = source.indexOf(end, from + start.length);
        assert.ok(to !== -1, `end marker not found after ${start}: ${end}`);
        return source.slice(from, to);
}

// ============================================================
// §1 — Filter sheet: category-only (original provider taxonomy)
// ============================================================
{
        // The sheet renders ONE filter section: the category bar. The
        // Language section, its props and its styles are gone entirely.
        assert.ok(!filterSheet.includes('Filter by language'), 'no Language section heading');
        assert.ok(!filterSheet.includes('aria-label="Filter channels by language"'), 'no language group');
        assert.ok(!filterSheet.includes('ltv-language-bar'), 'no language bar styles');
        assert.ok(!filterSheet.includes('ltv-chip'), 'no language chip styles');
        assert.ok(!filterSheet.includes('languages'), 'no languages prop anywhere in the sheet');
        assert.ok(!filterSheet.includes('selectedLanguage'), 'no selectedLanguage prop');
        assert.ok(!filterSheet.includes('onselectlanguage'), 'no language selection handler');
        // The category section survives intact — original values verbatim,
        // rendered through the existing category bar (selected-chip
        // highlighting lives there).
        const categoryBar = read('../src/lib/components/live-tv/LiveTvCategoryBar.svelte');
        assert.ok(filterSheet.includes('aria-label="Filter by category"'), 'the category section survives');
        assert.ok(filterSheet.includes('onselect={onselectcategory}'), 'category chips still route to the page handler');
        assert.ok(categoryBar.includes('aria-pressed'), 'selected-chip highlighting survives (LiveTvCategoryBar)');
        assert.ok(filterSheet.includes('All'), 'the All option survives');
        // All/reset/apply semantics survive on the ONE dimension.
        assert.ok(filterSheet.includes('onclick={onreset}'), 'Reset survives');
        assert.ok(filterSheet.includes('onclick={onclose}'), 'Apply still acknowledges and closes');

        // The page: no language state, no language in the active counts, no
        // language in the visible-channel pipeline.
        assert.ok(!page.includes("let language = $state('')"), 'no language state');
        assert.ok(!page.includes('applyLanguage'), 'no language handler');
        assert.ok(!page.includes('filterLiveTvChannelsByLanguage'), 'no language filter in the pipeline');
        assert.ok(!page.includes('extractLiveTvLanguages'), 'no language derivation on the page');
        const visible = sliceOf(page, 'const visibleChannels = $derived.by(() => {', '\n  });');
        assert.ok(visible.includes('filterLiveTvChannelsByCategory') && visible.includes('filterLiveTvChannelsByQuery'), 'visible = category + search compose');
        assert.ok(!visible.includes('language'), 'no language stage in the pipeline');
        // Search + category still compose; count is category-only.
        const count = sliceOf(page, 'const activeFilterCount = $derived(', '\n  ');
        assert.ok(count.includes('category ? 1 : 0'), 'the active count is the category dimension only');

        // The API layer: category carried VERBATIM in BOTH normalize paths,
        // no language model anywhere.
        const normalizer = sliceOf(apiSource, 'function normalizeChannelEntry(', 'function normalizeChannelList');
        assert.ok(normalizer.includes('channel.category = raw.category;'), 'catalogue path: category verbatim');
        const resolution = sliceOf(apiSource, 'export async function resolveLiveTvPlayback', '\n}');
        assert.ok(resolution.includes('channel.category = body.category;'), 'resolution path: category verbatim');
        assert.ok(!apiSource.includes('LIVE_TV_LANGUAGE_CATEGORIES'), 'no language map');
        assert.ok(!apiSource.includes('Language'), 'no language concept anywhere in the API layer');
        ok('1. filter sheet is category-only: Language section + plumbing fully removed, original taxonomy verbatim');
}

// ============================================================
// §2 — Guide sheet: ONE continuous list, honest current marking
// ============================================================
{
        // The sheet renders exactly ONE programme-card source: LiveTvGuide.
        assert.ok(!guideSheet.includes('LiveTvNowPlaying'), 'no Now Playing / Up Next component');
        assert.ok(!guideSheet.includes('Now Playing'), 'no Now Playing UI text');
        assert.ok(!guideSheet.includes('Up Next'), 'no Up Next UI text');
        assert.ok(guideSheet.includes('<LiveTvGuide'), 'LiveTvGuide renders inside the sheet');
        const body = sliceOf(guideSheet, 'class="sheet-body"', '</div>');
        assert.equal(
                (body.match(/<LiveTv[A-Z][A-Za-z]*/g) ?? []).length,
                1,
                'exactly ONE programme component in the sheet body'
        );
        // The orphaned component file is deleted.
        let orphan = true;
        try { readFileSync(new URL('../src/lib/components/live-tv/LiveTvNowPlaying.svelte', import.meta.url), 'utf8'); } catch { orphan = false; }
        assert.ok(!orphan, 'the LiveTvNowPlaying file is deleted from the repo');

        // The list itself marks the current programme ONLY by real timing:
        // never the first item by position, never when data is absent/stale.
        assert.ok(guideList.includes("programmeStatusAt(entry, nowSeconds) === 'current'"), 'current detection is time-window based');
        assert.ok(guideList.includes("aria-label=\"Currently on air\""), 'the current programme carries an honest label');
        assert.ok(guideList.includes('{#if status === \'current\'}'), 'the marker renders only for the real current entry');
        assert.ok(guideList.includes('entry.stopSeconds <= now'), 'finished programmes are omitted (stale data never marked)');
        assert.ok(guideList.includes('live.sort((a, b) => a.startSeconds - b.startSeconds)'), 'ONE continuous start-sorted list (upcoming included)');
        // No new API surface: the sheet still only reuses page state.
        assert.ok(!guideSheet.includes('getLiveTvGuide'), 'the sheet never calls the guide API');
        assert.ok(!guideSheet.includes('fetch('), 'the sheet never fetches');
        // Preserved presentation contracts inside the single list.
        assert.ok(guideList.includes('{entry.description}'), 'descriptions survive');
        assert.ok(guideList.includes('{entry.category}'), 'category labels survive');
        assert.ok(guideList.includes('{timeLabel(entry)}'), 'time labels survive');
        assert.ok(guideList.includes('aria-busy="true"'), 'loading state survives');
        assert.ok(guideList.includes('role="alert"'), 'error state survives');
        assert.ok(guideList.includes('role="status"'), 'empty state survives');
        ok('2. guide sheet: single continuous list (LiveTvGuide), honest [start, stop) current marking, no refetch');
}

// ============================================================
// §3a — Bottom nav: transform-free centering (the Chrome-Android
//        fixed-layer re-anchor fix)
// ============================================================
{
        // The pill rule: position fixed + EDGE anchoring + auto margins.
        // (Slice inside the ≤1024px block — the base .mobile-nav rule is
        // just `display: none` for the desktop range.)
        const tabletRange = sliceOf(appShell, '@media (max-width: 1024px) {', '@media (max-width: 640px) {');
        const pill = sliceOf(tabletRange, '.mobile-nav {', '}');
        assert.ok(pill.includes('position: fixed'), 'the pill stays a fixed overlay');
        assert.ok(pill.includes('left: 0'), 'anchored to the left edge');
        assert.ok(pill.includes('right: 0'), 'anchored to the right edge');
        assert.ok(pill.includes('margin-inline: auto'), 'centered by auto margins (transform-free)');
        assert.ok(pill.includes('bottom: calc(14px + env(safe-area-inset-bottom, 0px))'), 'the bottom offset + safe-area rule survives verbatim');
        assert.ok(pill.includes('width: min(calc(100% - 24px), 480px)'), 'the width rule survives verbatim');
        assert.ok(pill.includes('z-index: 50'), 'the stacking order survives');
        // THE fix: NO transform on the fixed layer anywhere in the file.
        assert.ok(!appShell.includes('translateX(-50%)'), 'the translateX(-50%) centering transform is GONE');
        assert.ok(!pill.includes('transform'), 'the pill rule carries no transform at all');
        // No other rule re-introduces a transform on the nav chrome (the
        // desktop sidebar hover nudge is in-flow sidebar content, NOT fixed
        // chrome — it is allowed and asserted below for clarity).
        const mobileNavRules = appShell.match(/\.mobile-nav[^{]*\{[^}]*\}/g) ?? [];
        for (const rule of mobileNavRules) {
                assert.ok(!rule.includes('transform'), `no transform on: ${rule.slice(0, 40)}…`);
        }
        assert.ok(appShell.includes('.sidebar-link:hover'), 'the desktop sidebar hover nudge (in-flow, unrelated) is untouched');
        ok('3a. bottom nav: edge-anchored + auto-margin centering, zero transforms on the fixed layer');
}

// ============================================================
// §3b — Phone topbar: the tablet range's sticky pattern
// ============================================================
{
        // The ≤1024px base rule is the ONE sticky topbar pattern for the
        // whole mobile + tablet range.
        const tabletBlock = sliceOf(appShell, '@media (max-width: 1024px) {', '@media (max-width: 640px) {');
        const tabletTopbar = sliceOf(tabletBlock, '.topbar {', '}');
        assert.ok(tabletTopbar.includes('position: sticky'), 'the base topbar rule is sticky');
        assert.ok(tabletTopbar.includes('top: 0'), 'pinned to the viewport top');
        assert.ok(tabletTopbar.includes('z-index: 40'), 'stacking order intact');

        // The ≤640px override keeps ONLY the phone geometry — it no longer
        // switches to position:fixed and no longer couples a padding
        // compensation.
        const phoneBlock = sliceOf(appShell, '@media (max-width: 640px) {', '@media (min-width: 1025px) {');
        const phoneTopbar = sliceOf(phoneBlock, '.topbar {', '}');
        assert.ok(!phoneTopbar.includes('position: fixed'), 'the phone topbar is NOT fixed (sticky from the base rule)');
        assert.ok(!phoneTopbar.includes('left: 0'), 'no fixed-position edge rules');
        assert.ok(!phoneTopbar.includes('width: 100%'), 'no fixed-width rule (sticky stretches with the flow)');
        assert.ok(phoneTopbar.includes('height: var(--topbar-h-safe)'), 'the phone height rule survives verbatim');
        assert.ok(phoneTopbar.includes('padding: env(safe-area-inset-top, 0px) 16px 0'), 'the safe-area padding rule survives verbatim');
        // The compensation is gone — the in-flow topbar provides the offset.
        assert.ok(!appShell.includes('padding-top: var(--shell-content-top)'), 'the .app-main padding-top compensation is REMOVED');

        // The safe-area height token survives in app.css (the geometry the
        // Explorer chips stick beneath).
        assert.ok(appCss.includes('--topbar-h-safe: calc(var(--topbar-h) + env(safe-area-inset-top, 0px));'), 'the safe-area height token survives');
        // Explorer chips still stick below exactly the topbar height.
        assert.ok(explorerPage.includes('top: var(--topbar-h-safe)'), 'Explorer chips still stick below the topbar height');
        // The desktop range is untouched (header account control fixed at the
        // top-right — no transform there either).
        const desktopBlock = sliceOf(appShell, '@media (min-width: 1025px) {', '</style>');
        const headerAccount = sliceOf(desktopBlock, '.header-account {', '}');
        assert.ok(headerAccount.includes('position: fixed'), 'the desktop account control keeps its fixed position');
        assert.ok(!headerAccount.includes('transform'), 'the desktop account control carries no transform');
        ok('3b. phone topbar: sticky like the tablet range, geometry verbatim, compensation removed, desktop untouched');
}

// ============================================================
// §3c — The fix is PURE CSS: no scroll listeners, no direction
//        detection, no JS behavior added to the shell
// ============================================================
{
        const scriptBlock = sliceOf(appShell, '<script lang="ts">', '</script>');
        assert.ok(!scriptBlock.includes('scroll'), 'no scroll handling in the shell script');
        assert.ok(!scriptBlock.includes('visualViewport'), 'no visualViewport handling');
        assert.ok(!scriptBlock.includes('URL bar'), 'no URL-bar heuristics');
        // The shell's only animation stays the mount fade (opacity — not a
        // containing-block transform on the chrome).
        assert.ok(scriptBlock.includes('gsap.fromTo(shell, { opacity: 0 }'), 'the mount fade is unchanged');
        // The nav model is untouched: six destinations, both compositions.
        assert.ok(appShell.includes("href: '/discover'"), 'Discover link survives');
        assert.ok(appShell.includes("href: '/live-tv'"), 'Live TV link survives');
        assert.ok(appShell.includes("href: '/search'"), 'Search link survives');
        assert.ok(appShell.includes('aria-label="Mobile navigation"'), 'the nav keeps its accessible name');
        ok('3c. pure-CSS fix: no scroll listeners or heuristics added; nav model untouched');
}

console.log(`\nLT-19 targeted UI fixes suite: ${passed} checks passed.`);
