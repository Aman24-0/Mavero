// MAVERO — LT-4 Live TV page / UI: deterministic regression suite.
//
// Covers the /live-tv page, the five Live TV UI components and the epg.ts
// display helpers, in the two styles this repo uses for UI phases:
//   * BEHAVIORAL sections drive the REAL pure modules (epg.ts + the LT-2
//     local utilities the page composes) under Node — which also proves SSR
//     safety (the devtool_protection_test argument used by LT-2/LT-3).
//   * SOURCE-CONTRACT sections (the phase5_player_ui_test convention) assert
//     the page's orchestration wiring: channel-switch ordering, stale-request
//     guards, safe-message-only error surfaces, guide independence, cleanup,
//     single-engine/single-video invariants, retry paths and security hygiene.
//
// NO real LiveGT network call, browser, DRM or Shaka package is involved.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
        determineCurrentProgramme,
        describeLivePosition,
        formatBehindLive,
        formatGuideClock,
        formatGuideDateTime,
        formatGuideGeneratedAt,
        programmeIsToday,
        programmeStatusAt,
        channelInitials
} from '$lib/client/live-tv/epg';
import {
        extractLiveTvCategories,
        filterLiveTvChannelsByCategory,
        filterLiveTvChannelsByQuery
} from '$lib/client/live-tv/api';
import type { LiveTvChannel, LiveTvGuide, LiveTvGuideProgramme } from '$lib/client/live-tv/types';

let passed = 0;
function ok(label: string): void {
        passed++;
        console.log(`  ok ${passed} - ${label}`);
}

const read = (p: string): string => readFileSync(new URL(p, import.meta.url), 'utf8');
const page = read('../src/routes/live-tv/+page.svelte');
const player = read('../src/lib/components/live-tv/LiveTvPlayer.svelte');
const card = read('../src/lib/components/live-tv/LiveTvChannelCard.svelte');
const categoryBar = read('../src/lib/components/live-tv/LiveTvCategoryBar.svelte');
const nowPlaying = read('../src/lib/components/live-tv/LiveTvNowPlaying.svelte');
const guideList = read('../src/lib/components/live-tv/LiveTvGuide.svelte');
const epgSource = read('../src/lib/client/live-tv/epg.ts');

// Comment-free projection of a source — used for ELEMENT counting so prose
// like "the caller-owned <video> element" in a comment is never mistaken for
// a rendered tag. Only line comments (leading //) and block comments are
// removed; CSS/strings are untouched (https:// never matches a leading //).
function stripComments(source: string): string {
        return source
                .replace(/\/\*[\s\S]*?\*\//g, '')
                .replace(/^[ \t]*\/\/[^\n]*$/gm, '');
}

// Isolate the selectChannel body for ordering assertions (immune to
// onDestroy/retry occurrences elsewhere in the file).
function sliceOf(source: string, startMarker: string, endMarker: string): string {
        const start = source.indexOf(startMarker);
        assert.ok(start !== -1, `marker not found: ${startMarker}`);
        const end = source.indexOf(endMarker, start);
        assert.ok(end !== -1, `end marker not found after ${startMarker}: ${endMarker}`);
        return source.slice(start, end);
}

const selectFlow = sliceOf(page, 'async function selectChannel', 'function retryPlayback');
const guideFlow = sliceOf(page, 'async function loadGuide', 'function retryGuide');
const destroyFlow = sliceOf(page, 'onDestroy(() => {', '</script>');

// Fixture helpers.
function programme(over: Partial<LiveTvGuideProgramme> = {}): LiveTvGuideProgramme {
        return {
                title: over.title ?? 'Test Show',
                startSeconds: over.startSeconds ?? 1000,
                stopSeconds: over.stopSeconds ?? 2000,
                ...over
        };
}

const NOW = 1_700_000_000; // fixed absolute instant for determinism

// ============================================================
// §1 Route & page contract
// ============================================================
{
        assert.match(page, /<h1 class="ltv-heading">/, 'page renders a primary heading');
        assert.match(page, /Live TV — Mavero<\/title>/, 'page title');
        assert.match(page, /aria-label="Live TV"/, 'hero section label');
        assert.match(page, /<LiveTvPlayer\s/, 'page mounts the player component');
        assert.match(page, /bind:video=\{videoEl\}/, 'page binds the player-owned video element');
        assert.doesNotMatch(stripComments(page), /<video[\s>]/, 'page never renders its own <video> element (comments excluded)');
        ok('route/page contract: heading, title, player mount, no stray <video>');
}

// ============================================================
// §2 Initial catalogue loading (LT-2 wiring only)
// ============================================================
{
        assert.match(page, /getLiveTvChannels,\s*\n\s*getLiveTvGuide,\s*\n\s*resolveLiveTvPlayback/);
        assert.match(page, /from '\$lib\/client\/live-tv\/api'/, 'catalogue comes from the LT-2 client only');
        assert.doesNotMatch(page, /livetgtv/i, 'no LiveGT hostname anywhere in the page');
        assert.doesNotMatch(page, /fetch\(/, 'no raw fetch in the page');
        assert.match(page, /onMount\(\(\) => \{\s*void loadCatalogue\(\);/, 'catalogue loads on mount');
        assert.match(page, /const list = await getLiveTvChannels\(\{ signal: controller\.signal \}\);/, 'catalogue request is signal-wired');
        assert.match(page, /aria-busy="true"/, 'loading state is announced (skeleton)');
        assert.match(page, /channel-skeleton/, 'skeleton cards render while loading');
        ok('initial catalogue loading: LT-2 call on mount, signal-wired, skeleton state');
}

// ============================================================
// §3 Catalogue error & empty states
// ============================================================
{
        assert.match(page, /catalogueState === 'error'/, 'catalogue error branch exists');
        assert.match(page, /<ErrorState/, 'catalogue failure renders the shared ErrorState surface');
        assert.match(page, /retry=\{loadCatalogue\}/, 'catalogue failure offers retry');
        assert.match(page, /catalogueMessage \?\? 'Live TV is unavailable right now\.'/, 'error text falls back to a fixed safe string');
        assert.match(page, /channels\.length === 0/, 'empty catalogue branch exists');
        assert.match(page, /No Live TV channels are currently available\./, 'empty catalogue explanation');
        assert.match(page, /onclick=\{\(\) => void loadCatalogue\(\)\}/, 'empty catalogue offers reload');
        ok('catalogue error & empty states with intentional retry');
}

// ============================================================
// §4 Categories — derived from data, All option, local filtering
// ============================================================
{
        // Behavioral: the page's categories come from the LT-2 extractor.
        const catalogue: LiveTvChannel[] = [
                { id: '1', name: 'A', category: 'Sports' },
                { id: '2', name: 'B', category: 'sports' },
                { id: '3', name: 'C', category: 'News' },
                { id: '4', name: 'D' },
                { id: '5', name: 'E', category: '' }
        ];
        const derived = extractLiveTvCategories(catalogue);
        assert.deepEqual(derived, ['Sports', 'sports', 'News'], 'categories derived from data (case preserved, stable order, no hardcoding)');
        assert.equal(filterLiveTvChannelsByCategory(catalogue, 'SPORTS').length, 2, 'local category filter is case-insensitive');
        assert.equal(filterLiveTvChannelsByCategory(catalogue, '').length, 5, 'empty category ("") returns everything — the All semantics');
        ok('category derivation + local case-insensitive filtering (LT-2 utilities)');

        assert.match(page, /const categories = \$derived\(extractLiveTvCategories\(channels\)\);/, 'page derives categories from the loaded catalogue');
        assert.match(categoryBar, /<span>All<\/span>/, 'category bar always offers All');
        assert.match(categoryBar, /aria-pressed=\{selected === ''\}/, 'All chip carries selection state');
        assert.match(categoryBar, /aria-pressed=\{selected === category\}/, 'category chips carry selection state');
        assert.match(categoryBar, /role="group" aria-label="Filter channels by category"/, 'category bar is labelled');
        assert.match(page, /applyCategory/, 'page applies category changes locally');
        assert.doesNotMatch(page, /category:\s/, 'page never issues remote category requests (local filtering is sufficient)');
        ok('category bar: All + data-derived chips, aria-pressed, local-only filtering');
}

// ============================================================
// §5 Search — local, case-insensitive, clearable
// ============================================================
{
        const catalogue: LiveTvChannel[] = [
                { id: '1', name: 'Star Sports 1' },
                { id: '2', name: 'STAR Sports 2' },
                { id: '3', name: 'Sony' }
        ];
        assert.equal(filterLiveTvChannelsByQuery(catalogue, 'star').length, 2, 'search is case-insensitive (LT-2 utility)');
        assert.equal(filterLiveTvChannelsByQuery(catalogue, 'sony').length, 1, 'substring search matches');
        assert.equal(filterLiveTvChannelsByQuery(catalogue, '').length, 3, 'empty query returns everything');

        assert.match(page, /filterLiveTvChannelsByQuery\(list, trimmed\)/, 'page composes local search over the filtered list');
        assert.doesNotMatch(page, /searchLiveTvChannels\(/, 'no per-keystroke remote search (local catalogue data is sufficient)');
        assert.match(page, /id="live-tv-channel-search"/, 'search input has a stable id');
        assert.match(page, /aria-label="Search channels"/, 'search input is labelled');
        assert.match(page, /aria-label="Clear channel search"/, 'clear action is labelled');
        assert.match(page, /searchInputEl\?\.focus\(\);/, 'clear returns focus to the input');
        assert.match(page, /No channels match your search\./, 'empty search result state exists');
        assert.match(page, /onclick=\{clearSearch\}>Clear search/, 'empty search offers clear');
        ok('search: local case-insensitive matching, labelled input, clear action, empty state');
}

// ============================================================
// §6 Channel selection & playback resolution (source contract)
// ============================================================
{
        assert.match(page, /onselect=\{\(c\) => void selectChannel\(c\)\}/, 'channel cards drive selectChannel');
        assert.match(selectFlow, /selectedChannel = channel;/, 'selection is adopted immediately');
        assert.match(selectFlow, /const resolution = await resolveLiveTvPlayback\(channel\.id, \{ signal: controller\.signal \}\);/, 'fresh LT-2 resolution, signal-wired');
        assert.match(selectFlow, /await eng\.load\(videoEl, resolution, \{ signal: controller\.signal \}\);/, 'resolution handed straight to the LT-3 engine load');
        assert.doesNotMatch(page, /\$state<.*Resolution/, 'resolution objects are never stored in reactive state');
        assert.doesNotMatch(selectFlow, /sources|drm/i, 'the select flow never touches sources/drm fields itself');
        assert.match(selectFlow, /resolving = true;/, 'resolving phase is signalled to the UI');
        assert.match(page, /const resolvingChannel = \$derived\(resolving \? selectedChannel : null\);/, 'resolving channel is derived for the player');
        ok('selection: fresh resolve -> engine.load, resolution never in reactive state');
}

// ============================================================
// §7 Channel switching & stale async protection (the critical path)
// ============================================================
{
        // Ordering inside selectChannel: abort previous -> destroy previous
        // engine -> resolve -> new engine -> load. (Plan §9 order.)
        const iAbort = selectFlow.indexOf('sessionController?.abort();');
        const iDestroy = selectFlow.indexOf('destroyEngineSafely(engine);');
        const iResolve = selectFlow.indexOf('await resolveLiveTvPlayback(');
        const iNewEngine = selectFlow.indexOf('new LiveTvPlaybackEngine()');
        const iLoad = selectFlow.indexOf('await eng.load(');
        assert.ok(iAbort !== -1 && iDestroy !== -1 && iResolve !== -1 && iNewEngine !== -1 && iLoad !== -1, 'all switch steps present');
        assert.ok(iAbort < iDestroy, 'previous selection aborted BEFORE anything else');
        assert.ok(iDestroy < iResolve, 'previous playback session destroyed BEFORE resolving the new one (plan §9)');
        assert.ok(iResolve < iNewEngine, 'new engine created only after a fresh resolution exists');
        assert.ok(iNewEngine < iLoad, 'load happens on the new engine instance');
        ok('switching order: abort previous -> destroy previous engine -> fresh resolve -> new engine -> load');

        // Stale guards: every continuation re-checks the sequence + abort state.
        const guard = /if \(seq !== sessionSeq \|\| controller\.signal\.aborted(?: \|\| isSilentAbort\(err\))?\) \{?\s*(?:destroyEngineSafely\(eng\);\s*)?return;/;
        assert.match(selectFlow.slice(iResolve), guard, 'post-resolve stale guard exists');
        assert.match(selectFlow.slice(iLoad), /if \(seq !== sessionSeq \|\| controller\.signal\.aborted\) \{/, 'post-load stale guard exists');
        assert.match(selectFlow, /isSilentAbort\(err\)/, 'aborted errors are classified silent (never surfaced)');
        assert.match(page, /function isSilentAbort[\s\S]*?kind === 'aborted'[\s\S]*?kind === 'aborted'/, 'both LT-2 and LT-3 abort kinds are silent');
        assert.match(page, /if \(engine === target\) engine = null;/, 'a late continuation can never null a newer session engine');
        ok('stale async protection: seq + abort guards on every continuation, silent aborts');
}

// ============================================================
// §8 Player lifecycle integration (component contract)
// ============================================================
{
        assert.match(player, /bind:this=\{videoRef\}/, 'player renders the video element');
        assert.match(player, /playsinline/, 'video plays inline on mobile');
        assert.match(player, /aria-label="Live TV stream"/, 'video element is labelled');
        assert.match(player, /\$effect\(\(\) => \{\s*video = videoRef;\s*\}\);/, 'element published to the page through the bindable');
        assert.match(player, /eng\.on\('statechange',/, 'player subscribes to engine state changes');
        assert.match(player, /eng\.on\('loaded',/, 'player subscribes to loaded (autoplay attempt)');
        assert.match(player, /eng\.on\('timeupdate',/, 'player subscribes to time updates');
        assert.match(player, /eng\.on\('error',/, 'player subscribes to mid-session errors');
        assert.match(player, /return \(\) => \{[\s\S]*?offState\(\);[\s\S]*?offLoaded\(\);[\s\S]*?offTime\(\);[\s\S]*?offError\(\);/, 'player unsubscribes on engine change');
        assert.match(player, /engineState = eng \? eng\.getState\(\) : 'idle';/, 'session UI state resets on engine change');
        assert.doesNotMatch(player, /from 'shaka-player'|from "shaka-player"/, 'player never imports Shaka');
        assert.doesNotMatch(player, /shaka\./, 'player never references Shaka APIs');
        assert.doesNotMatch(player, /getLiveTv|livetgtv/, 'player never calls LiveGT (LT-2 owns networking)');
        ok('player lifecycle: subscriptions, reset, teardown — engine contract only');
}

// ============================================================
// §9 Live/DVR UI honesty + autoplay-blocked handling
// ============================================================
{
        // Autoplay: blocked -> tap-to-play CTA, NOT an error; never auto-muted.
        assert.match(player, /err\.kind === 'autoplay_blocked'/, 'autoplay rejection is classified');
        assert.match(player, /autoplayBlocked = true; \/\/ stream stays loaded; NOT a failure/, 'autoplay block is not a stream failure');
        assert.match(player, /class="tap-play"/, 'tap-to-play CTA rendered');
        assert.match(player, /aria-label="Start playback"/, 'CTA is labelled');
        const autoplayBody = sliceOf(player, 'async function attemptAutoplay', 'function togglePlay');
        assert.doesNotMatch(autoplayBody, /setMuted|\.muted =/, 'the autoplay path never auto-mutes to bypass policy');

        // Seek UI exists ONLY under a real seek range; no fake VOD timeline.
        assert.match(player, /\{#if showSeek && seekRange\}/, 'seek control rendered only when a seek range exists');
        assert.match(player, /aria-label="Seek within the live window"/, 'seek control is labelled');
        assert.match(player, /const showSeek = \$derived\([\s\S]*?seekRange !== null[\s\S]*?seekRange\.end > seekRange\.start/, 'seek visibility requires a VALID range');
        assert.match(player, /\{#if showGoLive\}/, 'Go Live appears only behind the live edge');
        assert.match(player, /livePosition\.behindSeconds !== null/, 'Go Live gated on measurable behind-live distance');
        assert.match(player, /aria-label=\{engineState === 'playing' \? 'Pause' : 'Play'\}/, 'play/pause control is labelled');
        assert.match(player, /aria-label=\{muted \? 'Unmute' : 'Mute'\}/, 'mute control is labelled');
        assert.match(player, /aria-label="Volume"/, 'volume control is labelled');
        assert.match(player, /aria-label=\{isFullscreen \? 'Exit fullscreen' : 'Enter fullscreen'\}/, 'fullscreen control is labelled');
        assert.match(player, /canFullscreen/, 'fullscreen feature-detected');
        ok('live UI honesty: conditional seek/Go Live, labelled controls, autoplay block = CTA');
}

// ============================================================
// §10 Playback error UI & retry (fresh resolve only)
// ============================================================
{
        assert.match(player, /const displayError = \$derived\(sessionErrorMessage \?\? engineError\?\.message \?\? null\);/, 'error text comes ONLY from the safe tables');
        assert.match(player, /role="alert"/, 'error overlay is an alert');
        assert.match(player, /onclick=\{onretry\}/, 'error overlay offers retry');
        assert.match(page, /function retryPlayback\(\): void \{\s*if \(selectedChannel\) void selectChannel\(selectedChannel\);\s*\}/, 'retry re-runs the FULL flow (fresh resolve, never a reused resolution)');
        const safeMessageBody = sliceOf(page, 'function playbackSafeMessage', 'function guideSafeMessage');
        assert.match(safeMessageBody, /return FALLBACK_MESSAGE;/, 'unknown errors fall back to a fixed string');
        assert.doesNotMatch(safeMessageBody, /\$\{/, 'no interpolation anywhere in the safe-message mapping');
        assert.doesNotMatch(safeMessageBody, /String\(err\)/, 'unknown error text is never stringified');
        assert.match(page, /const FALLBACK_MESSAGE = 'Live TV is unavailable right now\.';/, 'fixed fallback text');
        assert.doesNotMatch(page, /sessionErrorMessage = `|sessionErrorMessage = err\.message/, 'error text only via the safe mapping');
        ok('playback error UI: safe-table text, alert role, retry = fresh resolve');
}

// ============================================================
// §11 Guide: loading/success/empty/failure — independent of playback
// ============================================================
{
        assert.match(guideFlow, /await getLiveTvGuide\(channel\.id, \{ signal: controller\.signal \}\);/, 'guide loaded per channel via LT-2');
        assert.match(guideFlow, /guideSeq/, 'guide requests carry their own sequence guard');
        // Independence: the guide flow never touches playback session state.
        assert.doesNotMatch(guideFlow, /engine|sessionErrorMessage|selectedChannel|resolving(?!\s*=)/, 'guide flow never mutates playback state');
        assert.match(selectFlow, /void loadGuide\(channel\);/, 'guide loading starts with the selection (parallel, non-blocking)');
        assert.doesNotMatch(selectFlow, /await loadGuide/, 'the page NEVER awaits the guide before playback');
        assert.match(page, /retryGuide/, 'guide retry exists');
        assert.match(page, /function retryGuide\(\): void \{\s*if \(selectedChannel\) void loadGuide\(selectedChannel\);\s*\}/, 'guide retry re-requests the guide only');
        assert.doesNotMatch(page, /await getLiveTvGuide[\s\S]{0,200}engine/, 'no guide-to-playback coupling');
        ok('guide independence: own controller/sequence, never awaited by playback, own retry');

        // Component states: loading / error / empty are all presentational.
        assert.match(nowPlaying, /\{#if loading\}/, 'now-playing loading state');
        assert.match(nowPlaying, /\{:else if errorMessage\}/, 'now-playing failure state');
        assert.match(page, /const GUIDE_FALLBACK_MESSAGE = 'Guide unavailable right now\.';/, 'fixed guide-failure fallback text (page-owned)');
        assert.match(nowPlaying, /No programme information for this channel right now\./, 'empty guide is a quiet valid state');
        assert.match(guideList, /No upcoming programmes listed for this channel right now\./, 'empty schedule is a quiet valid state');
        assert.match(nowPlaying, /aria-label="Now playing"/, 'now-playing article labelled');
        ok('guide component states: loading, retryable failure, valid empty');
}

// ============================================================
// §12 Current programme determination (behavioral — epg.ts)
// ============================================================
{
        const now = NOW;
        const past = programme({ title: 'Past', startSeconds: now - 7200, stopSeconds: now - 3600 });
        const current = programme({ title: 'Current', startSeconds: now - 600, stopSeconds: now + 1800 });
        const next = programme({ title: 'Next', startSeconds: now + 1800, stopSeconds: now + 5400 });
        const scheduleGuide: LiveTvGuide = {
                channelId: '1',
                nowPlaying: null,
                upNext: null,
                upcoming: [],
                schedule: [past, current, next]
        };
        // Window-scan fallback: provider nowPlaying missing.
        assert.equal(determineCurrentProgramme(scheduleGuide, now)?.title, 'Current', 'window scan finds the programme containing now');
        // Provider statement wins over the window scan.
        const providerGuide: LiveTvGuide = { ...scheduleGuide, nowPlaying: programme({ title: 'Provider', startSeconds: 1, stopSeconds: 2 }) };
        assert.equal(determineCurrentProgramme(providerGuide, now)?.title, 'Provider', 'provider nowPlaying is authoritative');
        // Boundaries: [start, stop) — exclusive end.
        assert.equal(determineCurrentProgramme(scheduleGuide, now - 600)?.title, 'Current', 'start boundary is inclusive');
        assert.equal(determineCurrentProgramme(scheduleGuide, now + 1800)?.title, 'Next', "Current's stop is exclusive AND Next's start is inclusive at the same instant");
        // Nothing matches -> null, never fabricated.
        assert.equal(determineCurrentProgramme(scheduleGuide, now + 100_000), null, 'no window match -> null (never invented)');
        assert.equal(determineCurrentProgramme(null, now), null, 'null guide -> null');
        assert.equal(determineCurrentProgramme(scheduleGuide, Number.NaN), null, 'invalid now -> null');

        assert.equal(programmeStatusAt(current, now), 'current', 'statusAt current');
        assert.equal(programmeStatusAt(past, now), 'past', 'statusAt past');
        assert.equal(programmeStatusAt(next, now), 'future', 'statusAt future');
        ok('current-programme determination: provider-first, [start,stop) windows, never fabricated');

        // Page wiring: the info line renders ONLY actual programme data.
        assert.match(page, /const currentProgramme = \$derived\(\s*guide \? determineCurrentProgramme\(guide, nowSeconds\) : null\s*\);/, 'info line uses actual guide data');
        assert.match(page, /\{#if currentProgramme\}\s*<span class="info-now">Now: \{currentProgramme\.title\}/, 'now line renders only when determinable');
        assert.match(page, /nowSeconds = Math\.floor\(Date\.now\(\) \/ 1000\)/, 'now is absolute Unix seconds (timezone-safe)');
        assert.match(page, /setInterval\(\(\) => \{\s*nowSeconds = Math\.floor\(Date\.now\(\) \/ 1000\);\s*\}, 30_000\);/, 'now ticker refreshes');
        ok('info line + ticker wiring (absolute time, no timezone assumption)');
}

// ============================================================
// §13 Missing logo & missing optional metadata
// ============================================================
{
        assert.equal(channelInitials('Star Sports'), 'SS', 'initials from first two words');
        assert.equal(channelInitials('Sony'), 'S', 'single word -> first letter');
        assert.equal(channelInitials(''), 'TV', 'empty name -> neutral fallback, never blank');
        assert.equal(channelInitials('a! b?'), 'AB', 'non-letters dropped, uppercased');
        assert.match(card, /onerror=\{\(\) => \{ logoFailed = true; \}\}/, 'logo load failure falls back to initials');
        assert.match(card, /loading="lazy"/, 'logos lazy-load');
        assert.match(card, /\{#if hasLogo\}/, 'logo surface conditional');
        assert.match(card, /class:placeholder=\{!hasLogo\}/, 'placeholder styling when no logo');
        assert.match(card, /\{#if channel\.category\}/, 'category renders only when present');
        assert.doesNotMatch(card, /language|region/i, 'no invented language/region metadata');
        assert.match(card, /aria-pressed=\{selected\}/, 'selected channel carries state');
        assert.match(card, /aria-label=\{`Watch \$\{channel\.name\}/, 'card action is labelled');
        assert.match(card, /type="button"/, 'channel cards are semantic buttons');
        ok('missing logo -> initials fallback; optional metadata never invented');
}

// ============================================================
// §14 Responsive & structural invariants
// ============================================================
{
        assert.match(player, /aspect-ratio: 16 \/ 9/, 'player keeps a 16:9 surface');
        assert.match(player, /overflow-x: auto/, 'control row scrolls within itself');
        assert.match(categoryBar, /overflow-x: auto/, 'category row scrolls within itself');
        assert.match(page, /\.channel-grid \{[\s\S]*?repeat\(auto-fill, minmax\(250px, 1fr\)\)/, 'channel grid is fluid');
        assert.match(page, /@media \(max-width: 640px\)[\s\S]*?\.channel-grid \{ grid-template-columns: 1fr; \}/, 'mobile grid is single-column (no horizontal overflow)');
        assert.match(page, /padding-bottom: 110px;/, 'page clears the mobile bottom nav');
        assert.match(player, /min-height: 34px|width: 40px; height: 40px;/, 'touch-sized controls');
        assert.match(page, /CHANNEL_BATCH = 60/, 'catalogue renders in bounded batches');
        assert.match(page, /IntersectionObserver/, 'batch growth is observer-driven');
        assert.match(page, /visibleChannels\.slice\(0, visibleLimit\)/, 'rendering is limit-bounded');
        ok('responsive invariants: 16:9, contained scroll, single-column mobile, batched rendering');
}

// ============================================================
// §15 Security — no secrets to persisted state / logs / errors / URLs
// ============================================================
{
        const uiSources = [page, player, card, categoryBar, nowPlaying, guideList, epgSource];
        for (const source of uiSources) {
                assert.doesNotMatch(source, /console\./, 'no console calls');
                assert.doesNotMatch(source, /localStorage|sessionStorage|indexedDB/i, 'no storage APIs');
                assert.doesNotMatch(source, /document\.cookie/, 'no cookie access');
                assert.doesNotMatch(source, /livetgtv/i, 'no LiveGT URLs built outside LT-2');
        }
        assert.doesNotMatch(page, /searchParams\.set|history\.pushState|goto\(`\/live-tv/, 'no URL params written (nothing sensitive can leak into the URL)');
        assert.doesNotMatch(epgSource, /keyId|\bkey\b|clearKeys/i, 'epg helpers never touch DRM material');
        assert.doesNotMatch(player, /keyId|clearKeys|\.drm\b/i, 'player never touches DRM fields');
        assert.doesNotMatch(player, /resolution\.sources|\.mpd|signed/i, 'player never reads playback sources');
        // The page hands the resolution straight to the engine and only keeps
        // catalogue metadata in state — no sources/drm fields anywhere.
        assert.doesNotMatch(page, /resolution\.sources|resolution\.drm|\.sources\b/i, 'page never reads source/DRM fields');
        ok('security: zero console/storage/cookie/LiveGT-URL/DRM-field surfaces in all UI sources');
}

// ============================================================
// §16 Cleanup on component destroy
// ============================================================
{
        assert.match(destroyFlow, /sessionController\?\.abort\(\);/, 'session controller aborted');
        assert.match(destroyFlow, /guideController\?\.abort\(\);/, 'guide controller aborted');
        assert.match(destroyFlow, /catalogueController\?\.abort\(\);/, 'catalogue controller aborted');
        assert.match(destroyFlow, /destroyEngineSafely\(engine\);/, 'engine destroyed');
        assert.match(destroyFlow, /clearInterval\(nowTicker\);/, 'ticker cleared');
        assert.match(destroyFlow, /sessionSeq \+= 1;/, 'session sequence invalidated');
        assert.match(destroyFlow, /guideSeq \+= 1;/, 'guide sequence invalidated');
        ok('onDestroy: all controllers aborted, engine destroyed, ticker cleared');
}

// ============================================================
// §17 No duplicate player instance (single engine, single video)
// ============================================================
{
        const engineCreations = page.match(/new LiveTvPlaybackEngine\(\)/g) ?? [];
        assert.equal(engineCreations.length, 1, 'exactly one engine construction site in the page');
        assert.doesNotMatch(player, /new LiveTvPlaybackEngine/, 'components never construct engines');
        const videoTags = [page, player, card, categoryBar, nowPlaying, guideList]
                .map((s) => stripComments(s).match(/<video[\s>]/g) ?? []).reduce((a, b) => a + b.length, 0);
        assert.equal(videoTags, 1, 'exactly one rendered <video> element across the Live TV UI');
        // The previous engine is destroyed before a new one is constructed —
        // proven structurally in §7 (destroy < new-engine ordering) and here
        // by the engine-identity guard.
        assert.match(page, /if \(engine === target\) engine = null;/, 'engine reference cleared under identity guard');
        ok('single engine construction site, single video element, identity-guarded teardown');
}

// ============================================================
// §18 epg display helpers (behavioral remainder)
// ============================================================
{
        // describeLivePosition — honest live-edge math.
        assert.deepEqual(describeLivePosition(null, 0), { atLiveEdge: true, behindSeconds: null }, 'no range -> at edge, no invented distance');
        assert.deepEqual(describeLivePosition({ start: 0, end: 1000 }, 990), { atLiveEdge: true, behindSeconds: null }, 'within threshold -> at edge');
        assert.deepEqual(describeLivePosition({ start: 0, end: 1000 }, 700), { atLiveEdge: false, behindSeconds: 300 }, 'behind by 300s');
        assert.deepEqual(describeLivePosition({ start: 0, end: 1000 }, 1200), { atLiveEdge: true, behindSeconds: null }, 'beyond the edge is not "behind"');
        assert.deepEqual(describeLivePosition({ start: 0, end: Number.NaN }, 5), { atLiveEdge: true, behindSeconds: null }, 'invalid range -> honest edge state');

        // formatBehindLive — deterministic labels.
        assert.equal(formatBehindLive(null), null, 'at edge -> no label');
        assert.equal(formatBehindLive(30), '30s behind live');
        assert.equal(formatBehindLive(72), '1m 12s behind live');
        assert.equal(formatBehindLive(65), '1m 5s behind live');
        assert.equal(formatBehindLive(3600), '1h behind live');
        assert.equal(formatBehindLive(7_200), '2h behind live');

        // formatGuideClock / DateTime — locale rendering, never fabricated.
        const clock = formatGuideClock(1_700_000_000);
        assert.ok(typeof clock === 'string' && clock.length > 0 && /\d/.test(clock), 'clock renders digits for a valid instant');
        assert.equal(formatGuideClock(Number.NaN), '—', 'invalid instant -> em dash');
        assert.equal(formatGuideDateTime(Number.NaN), '—', 'invalid datetime -> em dash');
        assert.notEqual(formatGuideClock(1_700_000_000), formatGuideClock(1_700_003_600), 'different instants render differently');

        // programmeIsToday.
        assert.equal(programmeIsToday(programme({ startSeconds: NOW }), NOW), true, 'same-day window');
        assert.equal(programmeIsToday(programme({ startSeconds: NOW - 48 * 3600 }), NOW), false, 'other-day window');
        assert.equal(programmeIsToday(programme({ startSeconds: NOW }), Number.NaN), false, 'invalid now -> false');

        // formatGuideGeneratedAt — only when a finite value exists.
        const noGenerated: LiveTvGuide = { channelId: '1', nowPlaying: null, upNext: null, upcoming: [], schedule: [] };
        assert.equal(formatGuideGeneratedAt(noGenerated), null, 'absent generatedAt -> null');
        assert.equal(formatGuideGeneratedAt(null), null, 'null guide -> null');
        const withGenerated: LiveTvGuide = { ...noGenerated, generatedAtSeconds: NOW };
        assert.ok(typeof formatGuideGeneratedAt(withGenerated) === 'string', 'finite generatedAt renders');

        // epg.ts never relies on provider display strings for logic.
        assert.doesNotMatch(stripComments(epgSource), /startDisplay|stopDisplay/, 'display strings are never parsed for decisions (comments excluded)');
        ok('live-edge math, behind-live labels, time rendering, generatedAt handling');
}

console.log(`\nLT-4 page/UI suite: ${passed} checks passed`);
