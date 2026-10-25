// MAVERO — LT-18 Live TV Player UI + Page Redesign: focused regression suite.
//
// Covers the LT-18 §1 (ONE in-surface control system), §3 (embed-only
// embed mode), §4 (page redesign: toolbar / filter sheet / guide sheet /
// channel list) with the LT-19 updates (category-only filter; single
// guide list) in the repo's two UI-phase
// styles:
//   * BEHAVIORAL sections drive the REAL pure modules (the LT-2 local
//     utilities) under Node — which also proves SSR safety.
//   * SOURCE-CONTRACT sections assert the component/page wiring.
//
// Directive case map (LT-18 §6A/§6C/§6D/§6E):
//   portrait controls inside surface .............. §A1
//   fullscreen controls inside surface ............ §A2
//   landscape control ordering .................... §A3
//   portrait hides FIT/FILL ....................... §A4
//   fullscreen shows FIT/FILL ..................... §A4
//   LIVE in seek row / right side .................. §A3
//   no native controls in embed mode .............. §A5
//   no Mavero reload button in embed mode ......... §A5
//   no Mavero fullscreen button in embed mode ..... §A5
//   native controls return after embed ............ §A6
//   filter sheet: category-only / compose / reset / active ......... §C
//                (LT-19: the Language section is REMOVED — the original
//                 provider category taxonomy is the only dimension)
//   guide sheet: single list / honest current / state reuse /
//                no refetch / no-channel / retry .. §D
//                (LT-19: the Now Playing + Up Next cards are REMOVED)
//   page ordering: title → player → toolbar → channels; sheets are
//                overlays .......................... §E
//
// NO network, browser, DRM or Shaka package is involved.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
        extractLiveTvCategories,
        filterLiveTvChannelsByCategory,
        filterLiveTvChannelsByQuery
} from '$lib/client/live-tv/api';
import type { LiveTvChannel } from '$lib/client/live-tv/types';

let passed = 0;
function ok(label: string): void {
        passed++;
        console.log(`  ok ${passed} - ${label}`);
}

const read = (p: string): string => readFileSync(new URL(p, import.meta.url), 'utf8');
const player = read('../src/lib/components/live-tv/LiveTvPlayer.svelte');
const page = read('../src/routes/live-tv/+page.svelte');
const filterSheet = read('../src/lib/components/live-tv/LiveTvFilterSheet.svelte');
const guideSheet = read('../src/lib/components/live-tv/LiveTvGuideSheet.svelte');
const apiSource = read('../src/lib/client/live-tv/api.ts');

/** Slice a source string from a start marker to just before an end marker. */
function sliceOf(source: string, start: string, end: string): string {
        const from = source.indexOf(start);
        assert.ok(from !== -1, `marker not found: ${start}`);
        const to = source.indexOf(end, from + start.length);
        assert.ok(to !== -1, `end marker not found after ${start}: ${end}`);
        return source.slice(from, to);
}

// ============================================================
// §A1/§A2 — ONE control system INSIDE the player surface (both modes)
// ============================================================
{
        // The external .player-controls bar is GONE.
        assert.ok(!player.includes('class="player-controls"'), 'the external control bar is removed');
        assert.ok(!player.includes('aria-label="Playback controls"'), 'the old bar label is removed');
        assert.ok(!player.includes('.player-controls {'), 'the old bar CSS is removed');
        // The ONE control system lives inside the player surface div, after
        // the video element and the overlays.
        const surfaceBlock = sliceOf(player, '<div\n    class="player-surface"', '\n</section>');
        assert.ok(surfaceBlock.includes('<video'), 'the surface contains the video element');
        const controlSystemAt = surfaceBlock.indexOf('class="surface-controls"');
        const videoAt = surfaceBlock.indexOf('<video');
        assert.ok(controlSystemAt > videoAt, 'the control system renders INSIDE the surface, above the video');
        // ONE control container — no second implementation for fullscreen.
        assert.equal(
                (player.match(/class="surface-controls"/g) ?? []).length,
                1,
                'exactly ONE control-system container (shared by both modes)'
        );
        assert.ok(
                !player.includes('fs-controls'),
                'the old separate fullscreen overlay implementation is gone'
        );
        // It renders through ONE branch: showControlSystem (native mode only).
        assert.ok(player.includes('{#if showControlSystem}'), 'the single render branch is showControlSystem');
        // Auto-hide + pointer wake apply in BOTH modes (not gated on fullscreen).
        assert.ok(player.includes('function scheduleControlsHide(): void'), 'auto-hide scheduler exists');
        const hideBody = sliceOf(player, 'function scheduleControlsHide(): void {', '\n  }');
        assert.ok(!hideBody.includes('isFullscreen'), 'auto-hide is NOT fullscreen-gated (both modes)');
        // An OPEN quality menu blocks auto-hide (never yanked from the user).
        assert.ok(
                hideBody.includes('!qualityMenuOpen'),
                'an open quality menu blocks auto-hide'
        );
        assert.ok(player.includes('function wakeControls(): void'), 'pointer wake exists');
        const wakeBody = sliceOf(player, 'function wakeControls(): void {', '\n  }');
        assert.ok(!wakeBody.includes('isFullscreen'), 'pointer wake is NOT fullscreen-gated (both modes)');
        // Fullscreen EXPANDS the same system via CSS (the :fullscreen rules).
        assert.ok(
                player.includes('.player-surface:fullscreen .surface-controls'),
                'fullscreen styling extends the SAME control system'
        );
        // Scrim + safe-area + 44px targets.
        const controlsCss = sliceOf(player, '.surface-controls {', '\n  }');
        assert.ok(controlsCss.includes('linear-gradient'), 'a readability scrim backs the controls');
        assert.ok(
                controlsCss.includes('env(safe-area-inset-bottom, 0px)'),
                'safe-area insets are respected'
        );
        assert.ok(player.includes('width: 44px; height: 44px;'), '44px minimum touch targets');
        ok('A1/A2. ONE responsive control system inside .player-surface in BOTH modes');
}

// ============================================================
// §A3 — Landscape layout ordering (seek row + main row)
// ============================================================
{
        const system = sliceOf(player, '<div class="surface-controls"', '{/if}');
        // The seek row comes FIRST, the main row SECOND.
        const seekRowAt = system.indexOf('class="ctl-seek-row"');
        const mainRowAt = system.indexOf('class="ctl-main-row"');
        assert.ok(seekRowAt !== -1 && mainRowAt !== -1, 'both rows exist');
        assert.ok(seekRowAt < mainRowAt, 'the seek row sits above the main row');
        // The seek row contains the seek control + the LIVE status cluster
        // (badge / behind label / Go live) at its right end.
        const seekRow = sliceOf(system, 'class="ctl-seek-row"', '</div>');
        assert.ok(seekRow.includes('{@render liveSeekControl()}'), 'the seek bar renders in the seek row');
        assert.ok(seekRow.includes('{@render liveStatusControl()}'), 'the LIVE cluster renders in the seek row');
        assert.ok(
                seekRow.indexOf('{@render liveSeekControl()}') < seekRow.indexOf('{@render liveStatusControl()}'),
                'LIVE sits at the RIGHT END of the seek row (after the seek bar)'
        );
        // The live-status snippet owns the badge + Go live (moved out of the
        // playback cluster).
        const statusSnippet = sliceOf(player, '{#snippet liveStatusControl()}', '{/snippet}');
        assert.ok(statusSnippet.includes('live-badge'), 'the LIVE badge lives in the seek-row cluster');
        assert.ok(statusSnippet.includes('Go live'), 'Go live lives in the seek-row cluster');
        const clusterSnippet = sliceOf(player, '{#snippet nativeControlCluster()}', '{/snippet}');
        assert.ok(!clusterSnippet.includes('live-badge'), 'the playback cluster no longer carries the LIVE badge');
        // The main row: play + mute + volume on the LEFT; quality + fit +
        // fullscreen on the RIGHT (nothing utility-ish in the middle).
        const mainRow = sliceOf(system, 'class="ctl-main-row"', '</div>');
        const order = [
                mainRow.indexOf('{@render nativeControlCluster()}'),
                mainRow.indexOf('<span class="ctl-spacer"'),
                mainRow.indexOf('{@render qualityControl()}'),
                mainRow.indexOf('{@render fitModeButton()}'),
                mainRow.indexOf('{@render fullscreenButton()}')
        ];
        for (const at of order) assert.ok(at !== -1, 'main row member present');
        assert.ok(
                order[0] < order[1] && order[1] < order[2] && order[2] < order[3] && order[3] < order[4],
                'main row order: [play/mute/volume] … [quality] [fit/fill] [fullscreen]'
        );
        // The volume slider stays with the mute control in the cluster.
        assert.ok(clusterSnippet.includes('aria-label="Volume"'), 'the volume slider sits in the left cluster');
        ok('A3. landscape layout: [seek][LIVE] row above [play][volume][slider] … [quality][fit][fullscreen]');
}

// ============================================================
// §A4 — Portrait hides FIT/FILL; fullscreen shows it
// ============================================================
{
        // The fit snippet is gated on isFullscreen — the normal portrait
        // player never renders it.
        const fitSnippet = sliceOf(player, '{#snippet fitModeButton()}', '{/snippet}');
        assert.ok(
                fitSnippet.includes('{#if isFullscreen && controlsEnabled}'),
                'the FIT/FILL control renders ONLY while fullscreen'
        );
        // The fullscreen button + quality render in BOTH modes (not gated).
        const fsSnippet = sliceOf(player, '{#snippet fullscreenButton()}', '{/snippet}');
        assert.ok(!fsSnippet.includes('isFullscreen &&') || fsSnippet.includes("aria-label={isFullscreen"), 'fullscreen button renders in both modes');
        const qualitySnippet = sliceOf(player, '{#snippet qualityControl()}', '{/snippet}');
        assert.ok(
                qualitySnippet.includes('{#if controlsEnabled && showQualityControl}'),
                'the quality control renders in both modes, only behind 2+ tiers'
        );
        assert.ok(
                player.includes('const showQualityControl = $derived(qualityOptions.length > 1);'),
                'the 2+ tier gate is the single quality visibility rule'
        );
        ok('A4. portrait hides FIT/FILL; fullscreen shows it; quality/fullscreen in both');
}

// ============================================================
// §A5 — Embed mode is EMBED-ONLY (no Mavero controls at all)
// ============================================================
{
        // The control system is branch-gated on !embedActive via
        // showControlSystem.
        const showControlLine = player.match(/const showControlSystem = \$derived\((.*)\);/)?.[1] ?? '';
        assert.ok(
                showControlLine.includes('!embedActive') && showControlLine.includes('sessionEngaged'),
                'showControlSystem excludes embed mode by construction'
        );
        // The component contains NO embed-branch controls at all: the old
        // "Reload player" button and the embed-mode bar are gone.
        assert.ok(!player.includes('Reload player'), 'NO Mavero reload button anywhere (embed included)');
        assert.ok(!player.includes('Reload the alternate player'), 'no embed reload control either');
        // The only remaining onretry use is the NATIVE error overlay.
        assert.equal((player.match(/onclick=\{onretry\}/g) ?? []).length, 1, 'onretry is wired only to the native error overlay');
        const errorOverlay = sliceOf(player, '{#if !embedActive && displayError}', '{/if}');
        assert.ok(errorOverlay.includes('onclick={onretry}'), 'the retry control belongs to the native error overlay');
        // The fullscreen BUTTON cannot render in embed mode (only reachable
        // through the control system branch).
        assert.ok(
                !sliceOf(player, '{#if embedSrc}', '{/if}').includes('toggleFullscreen'),
                'the embed block contains no fullscreen control'
        );
        // The iframe keeps the documented LT-15 contract untouched.
        assert.equal((player.match(/<iframe/g) ?? []).length, 1, 'still exactly one iframe');
        assert.ok(player.includes('allowfullscreen'), 'allowfullscreen preserved');
        assert.ok(
                player.includes('allow="autoplay; fullscreen; encrypted-media; picture-in-picture"'),
                'allow-list preserved verbatim'
        );
        assert.ok(player.includes('src={embedSrc}'), 'iframe src still comes from the builder only');
        assert.ok(player.includes('{#key embedReloadToken}'), 'iframe still keyed by the reload token');
        ok('A5. embed mode: the iframe is the ONLY player UI — no reload/fullscreen/native controls');
}

// ============================================================
// §A6 — Native controls return after switching away from embed
// ============================================================
{
        // Switching channels: the page tears the fallback down and starts a
        // fresh native session (resolving → engine → engaged). The control
        // system derives purely from that state, so it returns with the
        // session — and the embed frame unmounts with embedChannelId=null.
        const showControlLine2 = player.match(/const showControlSystem = \$derived\((.*)\);/)?.[1] ?? '';
        assert.ok(showControlLine2.includes('!displayError'), 'an engaged native session with no error shows controls');
        // The page reset (LT-15 §B6 ordering) still drives the unmount.
        assert.ok(page.includes('embedFallbackChannelId = null;'), 'the page clears the fallback on every new selection');
        assert.ok(
                page.includes('embedChannelId={embedFallbackChannelId}'),
                'the component receives the page fallback state'
        );
        ok('A6. switching away from embed: fresh native session -> control system returns, iframe unmounts');
}

// ============================================================
// §C — Filter sheet (truthful filters, composition, reset, active state)
// ============================================================
{
        // ---- Behavioral (LT-19): the ORIGINAL provider category taxonomy is
        //      the ONLY filter dimension. Language-like values the provider
        //      supplies as categories (English, Tamil, Gujarati, …) are
        //      ordinary category options — never reinterpreted. ----
        const catalogue: LiveTvChannel[] = [
                { id: '1', name: 'Star Gold HD', category: 'Movies' },   // genre category
                { id: '2', name: 'Sun TV HD', category: 'Tamil' },        // language-as-category
                { id: '3', name: 'CNN NEWS18', category: 'English' },     // language-as-category
                { id: '4', name: 'Sony Yay Tamil', category: 'Tamil' },   // language-as-category
                { id: '5', name: 'Aastha' },                              // no category
                { id: '6', name: 'Zee Marathi', category: 'Marathi' }     // language-as-category
        ];
        // Categories derive from the data VERBATIM (original spellings,
        // stable first-appearance order; language-like values appear as
        // ordinary categories).
        assert.deepEqual(
                extractLiveTvCategories(catalogue),
                ['Movies', 'Tamil', 'English', 'Marathi'],
                'categories are the ORIGINAL provider values in stable first-appearance order — language-like ones included verbatim'
        );
        assert.deepEqual(extractLiveTvCategories([]), [], 'empty catalogue -> no chips');
        // The category filter matches those channels case-insensitively.
        assert.deepEqual(
                filterLiveTvChannelsByCategory(catalogue, 'tamil').map((c) => c.id),
                ['2', '4'],
                'category filter is case-insensitive and exact on the provider value'
        );
        assert.equal(filterLiveTvChannelsByCategory(catalogue, '').length, 6, 'empty category = All semantics');
        // Category + search compose (the page's exact order).
        let list = filterLiveTvChannelsByCategory(catalogue, 'Tamil');
        list = filterLiveTvChannelsByQuery(list, 'sun');
        assert.deepEqual(list.map((c) => c.id), ['2'], 'search composes over the filtered list');

        // ---- Source (LT-19): the language model is FULLY REMOVED. ----
        // No language map, no language derivation, no language filter — the
        // category value is carried verbatim and nothing else is classified.
        assert.ok(!apiSource.includes('LIVE_TV_LANGUAGE_CATEGORIES'), 'no language category map');
        assert.ok(!apiSource.includes('liveTvLanguageFromCategory'), 'no language derivation helper');
        assert.ok(!apiSource.includes('extractLiveTvLanguages'), 'no language extraction');
        assert.ok(!apiSource.includes('filterLiveTvChannelsByLanguage'), 'no language filter');
        assert.ok(!apiSource.includes('language:'), 'no language assignment anywhere in the API layer');
        const typesSource = read('../src/lib/client/live-tv/types.ts');
        assert.ok(!typesSource.includes('language'), 'the channel type carries NO language field');
        const normalizer = sliceOf(apiSource, 'function normalizeChannelEntry(', 'function normalizeChannelList');
        assert.ok(
                normalizer.includes('channel.category = raw.category;'),
                'the catalogue normalizer carries the category VERBATIM'
        );

        // ---- Source: the sheet is category-only; applies immediately;
        //      Apply closes; Reset clears. ----
        assert.ok(
                filterSheet.includes('onselect={onselectcategory}'),
                'the sheet routes category chips straight to the page handler'
        );
        assert.ok(!filterSheet.includes('languages'), 'NO language list prop');
        assert.ok(!filterSheet.includes('selectedLanguage'), 'NO selected-language prop');
        assert.ok(!filterSheet.includes('onselectlanguage'), 'NO language selection handler');
        assert.ok(!filterSheet.includes('ltv-language'), 'NO language section styles');
        assert.ok(!filterSheet.includes('ltv-chip'), 'NO language chip styles');
        assert.ok(!filterSheet.includes('Filter by language'), 'NO language section');
        assert.ok(page.includes('onselectcategory={applyCategory}'), 'the page wires immediate category application');
        assert.ok(!page.includes('applyLanguage'), 'the page has NO language handler');
        assert.ok(page.includes('function resetFilters(): void'), 'reset exists');
        const resetBody = sliceOf(page, 'function resetFilters(): void {', '\n  }');
        assert.ok(resetBody.includes("category = ''"), 'reset clears the filter');
        assert.ok(!resetBody.includes('language'), 'reset touches NO language (the dimension is gone)');
        assert.ok(filterSheet.includes('onclick={onclose}'), 'Apply closes the sheet');
        const categoryBar = read('../src/lib/components/live-tv/LiveTvCategoryBar.svelte');
        assert.ok(categoryBar.includes('aria-pressed'), 'chips carry selection state (LiveTvCategoryBar)');
        assert.ok(filterSheet.includes('aria-modal="true"'), 'the sheet is a modal dialog');
        assert.ok(filterSheet.includes("event.key === 'Escape'"), 'Escape closes the sheet');
        // Active-filter state on the toolbar button.
        assert.ok(page.includes('class:active={filtersActive}'), 'the Filter button reflects active filters');
        assert.ok(page.includes('{activeFilterCount}'), 'the Filter button shows the active count');
        const countBody = sliceOf(page, 'const activeFilterCount = $derived(', '\n  );');
        assert.ok(countBody.includes('category') && !countBody.includes('language'), 'the count covers the category dimension ONLY');
        // No URL params / no network for filtering.
        assert.ok(!filterSheet.includes('fetch('), 'the filter sheet never fetches');
        assert.ok(!filterSheet.includes('searchParams'), 'the filter sheet never writes URL params');
        ok('C. filter sheet: category-only (original provider taxonomy), immediate apply, compose, reset, active state');
}

// ============================================================
// §D — Guide sheet (contents, state reuse, no refetch, no-channel, retry)
// ============================================================
{
        // LT-19 — the FULL GUIDE (LiveTvGuide) is the SINGLE source of
        // programme cards: ONE continuous list whose current programme is
        // marked honestly. The duplicate Now Playing / Up Next cards are
        // GONE.
        assert.ok(!guideSheet.includes('LiveTvNowPlaying'), 'NO separate Now Playing / Up Next component in the sheet');
        assert.ok(guideSheet.includes('<LiveTvGuide'), 'the FULL GUIDE renders inside the sheet');
        // Exactly ONE programme-card source inside the sheet body.
        const sheetBody = sliceOf(guideSheet, 'class="sheet-body"', '</div>');
        assert.equal(
                (sheetBody.match(/<LiveTv[A-Z][A-Za-z]*/g) ?? []).length,
                1,
                'exactly ONE guide component in the sheet body (LiveTvGuide)'
        );
        // The list marks the current programme ONLY by real [start, stop)
        // timing — never by list position, never when data is absent/stale.
        const guideList = read('../src/lib/components/live-tv/LiveTvGuide.svelte');
        assert.ok(guideList.includes("programmeStatusAt(entry, nowSeconds) === 'current'"), 'the current marker is time-window derived');
        assert.ok(guideList.includes('On air'), 'the current programme is visibly marked');
        assert.ok(guideList.includes('{#if status === \'current\'}'), 'the marker renders ONLY for the real current entry');
        // Finished programmes are filtered, upcoming kept in the SAME list.
        assert.ok(guideList.includes('entry.stopSeconds <= now'), 'finished programmes are omitted');
        assert.ok(guideList.includes('live.sort((a, b) => a.startSeconds - b.startSeconds)'), 'one continuous start-sorted list');
        // The component file itself is deleted (no orphaned duplicate UI).
        let orphanExists = true;
        try { readFileSync(new URL('../src/lib/components/live-tv/LiveTvNowPlaying.svelte', import.meta.url), 'utf8'); } catch { orphanExists = false; }
        assert.ok(!orphanExists, 'the orphaned LiveTvNowPlaying component file is deleted');
        // It renders the page's EXISTING guide state — never fetches.
        assert.ok(guideSheet.includes('{guide}'), 'the sheet renders the page guide state');
        assert.ok(guideSheet.includes('{loading}'), 'the sheet renders the page loading state');
        assert.ok(guideSheet.includes('{errorMessage}'), 'the sheet renders the page error state');
        assert.ok(guideSheet.includes('{onretry}'), 'the sheet reuses the page retry');
        assert.ok(guideSheet.includes('{nowSeconds}'), 'the sheet forwards the page clock (the honest current marker)');
        assert.ok(!guideSheet.includes('getLiveTvGuide'), 'the sheet NEVER calls the guide API');
        assert.ok(!guideSheet.includes('loadGuide'), 'the sheet NEVER triggers a page guide load');
        assert.ok(!guideSheet.includes('fetch('), 'the sheet never fetches');
        // Opening the sheet never refetches: the page wires only open state.
        assert.ok(page.includes('guideSheetOpen = true'), 'the Guide button only opens the sheet');
        const guideSheetProps = sliceOf(page, '<LiveTvGuideSheet', '/>');
        assert.ok(guideSheetProps.includes('open={guideSheetOpen}'), 'the sheet open state is page-owned');
        assert.ok(guideSheetProps.includes('onretry={retryGuide}'), 'retry routes to the existing retryGuide');
        // Closing never touches playback.
        assert.ok(guideSheet.includes('aria-modal="true"'), 'the sheet is a modal dialog');
        assert.ok(guideSheet.includes("event.key === 'Escape'"), 'Escape closes the sheet');
        // No channel selected -> the Guide button is disabled (no fake data).
        assert.ok(page.includes('disabled={!selectedChannel}'), 'the Guide button is disabled without a channel');
        // The page-level guide flow is unchanged (LT-4 independence).
        assert.ok(page.includes('function retryGuide(): void {'), 'the page retry survives');
        assert.ok(page.includes('void loadGuide(channel);'), 'guide loads with the selection');
        ok('D. guide sheet: single continuous guide list with honest current marking, existing state, no refetch, no-channel disabled, retry kept');
}

// ============================================================
// §E — Page ordering: title → player → toolbar → channels; sheets overlay
// ============================================================
{
        const titleAt = page.indexOf('<h1 class="ltv-heading">');
        const playerAt = page.indexOf('<LiveTvPlayer');
        const toolbarAt = page.indexOf('class="ltv-toolbar"');
        const channelsAt = page.indexOf('class="ltv-channels"');
        for (const at of [titleAt, playerAt, toolbarAt, channelsAt]) assert.ok(at !== -1, 'page section present');
        assert.ok(titleAt < playerAt, 'the title precedes the player');
        assert.ok(playerAt < toolbarAt, 'the player precedes the toolbar');
        assert.ok(toolbarAt < channelsAt, 'the toolbar precedes the channels');
        // The permanent category chip row is GONE from the page.
        assert.ok(!page.includes('LiveTvCategoryBar'), 'no category bar import on the page');
        assert.ok(!page.includes('ltv-categories'), 'no permanent category row section');
        assert.ok(!page.includes('<LiveTvNowPlaying'), 'no permanent Now Playing section');
        assert.ok(!/<LiveTvGuide[\s>]/.test(page), 'no permanent Guide section (only the Guide sheet)');
        // The toolbar is one row: search + Filter + Guide.
        const toolbar = sliceOf(page, 'class="ltv-toolbar"', '</section>');
        assert.ok(toolbar.includes('role="search"'), 'the search box is in the toolbar');
        assert.ok(toolbar.includes('aria-label="Filter channels"'), 'the Filter button is in the toolbar');
        assert.ok(toolbar.includes('aria-label="Channel guide"'), 'the Guide button is in the toolbar');
        const searchAt = toolbar.indexOf('class="ltv-search"');
        const filterAt = toolbar.indexOf('aria-label="Filter channels"');
        const guideAt = toolbar.indexOf('aria-label="Channel guide"');
        assert.ok(searchAt !== -1 && filterAt !== -1 && guideAt !== -1, 'toolbar members present');
        assert.ok(searchAt < filterAt && filterAt < guideAt, 'toolbar order: search, Filter, Guide');
        // The toolbar CSS keeps them on ONE row with the search flexing.
        const toolbarCss = sliceOf(page, '.ltv-toolbar {', '\n  }');
        assert.ok(toolbarCss.includes('display: flex'), 'the toolbar is a flex row');
        const searchCss = sliceOf(page, '.ltv-search {', '\n  }');
        assert.ok(searchCss.includes('flex: 1 1 auto') && searchCss.includes('min-width: 0'), 'the search takes the majority width and can shrink');
        // The sheets render AFTER the page body (overlays, not sections).
        const filterSheetAt = page.indexOf('<LiveTvFilterSheet');
        const guideSheetAt = page.indexOf('<LiveTvGuideSheet');
        const bodyEndAt = page.indexOf('</div>\n</div>', channelsAt);
        assert.ok(filterSheetAt > bodyEndAt, 'the filter sheet mounts after the page body (overlay)');
        assert.ok(guideSheetAt > bodyEndAt, 'the guide sheet mounts after the page body (overlay)');
        assert.ok(filterSheet.includes('position: fixed'), 'the filter sheet is a fixed overlay');
        assert.ok(guideSheet.includes('position: fixed'), 'the guide sheet is a fixed overlay');
        // The channel list keeps the incremental-rendering contracts.
        assert.ok(page.includes('CHANNEL_BATCH = 60'), 'bounded batches survive');
        assert.ok(page.includes('IntersectionObserver'), 'the sentinel observer survives');
        assert.ok(page.includes('visibleChannels.slice(0, visibleLimit)'), 'rendering stays limit-bounded');
        assert.ok(page.includes('{visibleChannels.length} of {channels.length}'), 'the count reflects the FILTERED result');
        ok('E. page ordering: title -> player -> toolbar(search/filter/guide) -> channels; sheets are overlays');
}

// ============================================================
// §F — Security scans over the NEW components (the §15 pattern)
// ============================================================
{
        const sources = [player, filterSheet, guideSheet];
        for (const source of sources) {
                assert.ok(!source.includes('console.'), 'no console calls');
                assert.ok(!/localStorage|sessionStorage|indexedDB/i.test(source), 'no storage APIs');
                assert.ok(!source.includes('document.cookie'), 'no cookie access');
                assert.ok(!source.includes('livetgtv'), 'no LiveGT URLs built outside LT-2');
        }
        // The sheets never touch playback/DRM material.
        for (const source of [filterSheet, guideSheet]) {
                assert.ok(!source.includes('keyId'), 'no DRM key material');
                assert.ok(!source.includes('clearKeys'), 'no ClearKey material');
                assert.ok(!source.includes('resolution.'), 'no playback resolution fields');
        }
        ok('F. security: the new sheet components pass the UI source scans');
}

console.log(`\nLT-18 player UI + page redesign suite: ${passed} checks passed.`);
