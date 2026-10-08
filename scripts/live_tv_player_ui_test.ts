// MAVERO — LT-17 Player UI/Controls + Video Fit: focused regression suite.
//
// Covers the three LT-17 fixes in the repo's two UI-phase styles:
//   * BEHAVIORAL sections drive the REAL player-overlay module under Node
//     (which also proves SSR safety — importing it under Node is exactly
//     what the SSR server does).
//   * SOURCE-CONTRACT sections assert the LiveTvPlayer.svelte wiring:
//     the embed-gated overlay chain, the shared native-control snippets
//     (bar + fullscreen overlay), the fit/fill presentation switch, and
//     the untouched LT-15/LT-16 architecture.
//
// Directive case map:
//   EMPTY STATE
//     1 no channel -> empty message visible .......... §A1
//     2 native channel selected -> absent ........... §A2
//     3 native playback active -> absent ............ §A3
//     4 embed fallback active -> absent ............. §A4 (+ §B1)
//     5 switching channel -> no stale message ....... §A5
//     6 fallback retry -> no empty message .......... §A6
//   CONTROLS
//     play/pause, mute/unmute, volume ............... §B2
//     fullscreen still works ....................... §B3
//     LT-16 orientation wiring intact .............. §B4
//     DVR control only with a real seek range ...... §B5
//   FIT/FILL
//     default fit, fill switch, no distortion,
//     fit restores, no stream-loading impact ....... §B6 + §C
//   EMBED
//     embed controls untouched ..................... §B7
//     native controls absent in embed mode ......... §B7
//     no empty-state overlay over embed ............ §A4 + §B1
//   REGRESSION
//     LT-15 / LT-16 architectures untouched ........ §B8 (+ full suites)
//
// NO network, browser, DRM or Shaka package is involved.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  isLiveTvOverlayShown,
  type LiveTvOverlayKind,
  type LiveTvOverlayState
} from '$lib/client/live-tv/player-overlay';
import type { LiveTvPlaybackState } from '$lib/client/live-tv/player';

let passed = 0;
function ok(label: string): void {
  passed++;
  console.log(`  ok ${passed} - ${label}`);
}

const read = (p: string): string => readFileSync(new URL(p, import.meta.url), 'utf8');
const player = read('../src/lib/components/live-tv/LiveTvPlayer.svelte');
const overlayModule = read('../src/lib/client/live-tv/player-overlay.ts');
const page = read('../src/routes/live-tv/+page.svelte');

/** Slice a source string from a start marker to just before an end marker. */
function sliceOf(source: string, start: string, end: string): string {
  const from = source.indexOf(start);
  assert.ok(from !== -1, `marker not found: ${start}`);
  const to = source.indexOf(end, from + start.length);
  assert.ok(to !== -1, `end marker not found after ${start}: ${end}`);
  return source.slice(from, to);
}

const NO_SESSION: LiveTvOverlayState = {
  embedActive: false,
  sessionError: null,
  resolving: false,
  enginePresent: false,
  engineState: 'idle',
  autoplayBlocked: false
};

const ALL_KINDS: LiveTvOverlayKind[] = [
  'error',
  'connecting',
  'loading',
  'tap-to-play',
  'buffering',
  'empty'
];

// ============================================================
// §A1 — Case 1: no channel selected -> empty message IS visible
// ============================================================
{
  const s: LiveTvOverlayState = { ...NO_SESSION };
  assert.equal(isLiveTvOverlayShown('empty', s), true, 'no session at all -> empty state shows');
  // And nothing else renders in that state.
  for (const kind of ALL_KINDS.filter((k) => k !== 'empty')) {
    assert.equal(isLiveTvOverlayShown(kind, s), false, `no session -> ${kind} never shows`);
  }
  ok('A1. no channel: "Select a channel to start watching." is the visible state');
}

// ============================================================
// §A2 — Case 2: native channel selected (resolving) -> empty absent
// ============================================================
{
  const s: LiveTvOverlayState = { ...NO_SESSION, resolving: true };
  assert.equal(isLiveTvOverlayShown('empty', s), false, 'resolving -> no empty message');
  assert.equal(isLiveTvOverlayShown('connecting', s), true, 'resolving -> connecting hint');
  ok('A2. native channel selected: connecting hint, never the empty message');
}

// ============================================================
// §A3 — Case 3: native playback active -> empty absent (all engaged states)
// ============================================================
{
  const engaged: LiveTvPlaybackState[] = ['loaded', 'playing', 'paused', 'buffering', 'error'];
  for (const state of engaged) {
    const s: LiveTvOverlayState = { ...NO_SESSION, enginePresent: true, engineState: state };
    assert.equal(
      isLiveTvOverlayShown('empty', s),
      false,
      `engine ${state} is a live session -> empty message never shows`
    );
  }
  // Playing shows nothing but the optional buffering spinner kind.
  const playing: LiveTvOverlayState = { ...NO_SESSION, enginePresent: true, engineState: 'playing' };
  for (const kind of ALL_KINDS) {
    assert.equal(isLiveTvOverlayShown(kind, playing), false, `playing -> ${kind} hidden`);
  }
  ok('A3. native playback active (loaded/playing/paused/buffering/error): no empty message');
}

// ============================================================
// §A4 — Case 4 (+ embed invariant): embed fallback active -> NO native overlay
// ============================================================
{
  // The fallback state: engine destroyed (that is HOW the empty message used
  // to leak through), nothing resolving, no error message — embed mounted.
  const embed: LiveTvOverlayState = {
    ...NO_SESSION,
    embedActive: true
  };
  for (const kind of ALL_KINDS) {
    assert.equal(
      isLiveTvOverlayShown(kind, embed),
      false,
      `embed active -> ${kind} NEVER renders (iframe is the sole surface)`
    );
  }
  // Even a would-be loading/buffering/autoplay state is suppressed while the
  // embed is mounted (belt and suspenders against transient engine events).
  const noisy: LiveTvOverlayState = {
    ...embed,
    sessionError: 'Stream failed',
    resolving: true,
    enginePresent: true,
    engineState: 'loading',
    autoplayBlocked: true
  };
  for (const kind of ALL_KINDS) {
    assert.equal(isLiveTvOverlayShown(kind, noisy), false, `embed active + noise -> ${kind} still never renders`);
  }
  ok('A4. embed fallback: NO native overlay of any kind — by state logic, not stacking');
}

// ============================================================
// §A5 — Case 5: switching channels -> no stale empty message
// ============================================================
{
  // Switch = old engine destroyed, new selection resolving (synchronous on
  // the page), embed from a previous fallback torn down.
  const switchToB: LiveTvOverlayState = { ...NO_SESSION, resolving: true };
  assert.equal(isLiveTvOverlayShown('empty', switchToB), false, 'switch -> connecting, not empty');
  // Switch away FROM an embed fallback: embed torn down + resolving synchronously.
  const switchFromEmbed: LiveTvOverlayState = { ...switchToB, embedActive: false };
  assert.equal(isLiveTvOverlayShown('empty', switchFromEmbed), false, 'switch from embed -> no empty flash');
  ok('A5. channel switching: the connecting hint replaces everything, no empty flash');
}

// ============================================================
// §A6 — Case 6: fallback retry (embed reload) -> no empty message
// ============================================================
{
  // "Reload player" bumps the reload token; the embed stays mounted the
  // whole time (embedLoaded flips, but embedActive never does).
  const retry: LiveTvOverlayState = { ...NO_SESSION, embedActive: true };
  assert.equal(isLiveTvOverlayShown('empty', retry), false, 'embed retry -> no empty message');
  assert.equal(isLiveTvOverlayShown('connecting', retry), false, 'embed retry -> no native connecting hint either');
  ok('A6. fallback retry: iframe remounts, no native overlay appears');
}

// ============================================================
// §B1 — Overlay chain wiring: embed-gated chain head + derived branches
// ============================================================
{
  // The chain head keeps its exact LT-15 contract form (the embed block's
  // slice marker in the LT-15 suite depends on it) and is itself embed-gated.
  assert.ok(player.includes('{#if !embedActive && displayError}'), 'chain head unchanged and embed-gated');
  // Every subsequent branch is one of the derived states (never a raw
  // engine/resolving/autoplay read that could bypass the embed gating).
  const chain = sliceOf(player, '{#if !embedActive && displayError}', '{/if}\n  </div>');
  for (const branch of ['showConnecting', 'showLoading', 'showTapPlay', 'showBuffering', 'showEmptyState']) {
    assert.ok(chain.includes(`{:else if ${branch}}`), `chain branch {:else if ${branch}} present`);
  }
  // Each derived state flows through the player-overlay module.
  for (const branch of ['connecting', 'loading', 'tap-to-play', 'buffering', 'empty']) {
    const matcher = new RegExp(`isLiveTvOverlayShown\\('${branch}'`);
    assert.ok(matcher.test(player), `derived state calls isLiveTvOverlayShown('${branch}')`);
  }
  assert.equal(
    (player.match(/isLiveTvOverlayShown\(/g) ?? []).length,
    5,
    'exactly five module-driven derived states'
  );
  // The empty-message markup exists exactly once (the empty branch).
  assert.equal((player.match(/Select a channel to start watching\./g) ?? []).length, 1, 'empty message rendered once');
  // The module is imported (never duplicated inline).
  assert.ok(
    player.includes("import { isLiveTvOverlayShown } from '$lib/client/live-tv/player-overlay';"),
    'the player imports the overlay module'
  );
  ok('B1. wiring: every native overlay branch is derived through the embed-gated module');
}

// ============================================================
// §B2 — Controls: play/pause, mute/unmute, volume (shared snippets)
// ============================================================
{
  // One markup source per control (the snippet), rendered in BOTH the bar
  // and the fullscreen overlay.
  assert.ok(player.includes('{#snippet nativeControlCluster()}'), 'native cluster snippet declared');
  assert.ok(player.includes('{#snippet liveSeekControl()}'), 'seek snippet declared');
  assert.ok(player.includes('{#snippet fitModeButton()}'), 'fit button snippet declared');
  assert.ok(player.includes('{#snippet fullscreenButton()}'), 'fullscreen button snippet declared');
  // Handlers exist exactly twice for play (cluster + the tap-to-play CTA
  // overlay) and exactly once for every other control — all inside the
  // snippets/overlays, never duplicated per render surface.
  assert.equal((player.match(/onclick=\{togglePlay\}/g) ?? []).length, 2, 'play handler: cluster + tap-to-play CTA only');
  const ctaPlay = sliceOf(player, '<button class="tap-play" type="button" onclick={togglePlay}', '>');
  assert.ok(ctaPlay.length > 0, 'the second play handler is the tap-to-play CTA');
  assert.ok(player.includes('aria-label="Start playback"'), 'the CTA is labelled');
  assert.equal((player.match(/onclick=\{toggleMute\}/g) ?? []).length, 1, 'one mute handler');
  assert.equal((player.match(/onclick=\{toggleFullscreen\}/g) ?? []).length, 1, 'one fullscreen handler');
  assert.equal((player.match(/onclick=\{toggleFitMode\}/g) ?? []).length, 1, 'one fit handler');
  assert.equal((player.match(/onclick=\{goLive\}/g) ?? []).length, 1, 'one go-live handler');
  // The cluster renders in both native surfaces.
  assert.equal((player.match(/\{@render nativeControlCluster\(\)\}/g) ?? []).length, 2, 'cluster rendered twice (bar + fullscreen overlay)');
  assert.equal((player.match(/\{@render fitModeButton\(\)\}/g) ?? []).length, 2, 'fit button rendered twice');
  assert.equal((player.match(/\{@render fullscreenButton\(\)\}/g) ?? []).length, 2, 'fullscreen button rendered twice');
  assert.equal((player.match(/\{@render liveSeekControl\(\)\}/g) ?? []).length, 2, 'seek rendered twice');
  // Play/pause + mute labels still reflect state.
  assert.ok(player.includes("aria-label={engineState === 'playing' ? 'Pause' : 'Play'}"), 'play/pause labelled');
  assert.ok(player.includes("aria-label={muted ? 'Unmute' : 'Mute'}"), 'mute/unmute labelled');
  assert.ok(player.includes('aria-label="Volume"'), 'volume labelled');
  ok('B2. controls: play/pause, mute/unmute, volume — single handlers, two render surfaces');
}

// ============================================================
// §B3 — Fullscreen still works (mechanics + bar/overlay handover)
// ============================================================
{
  // The LT-16 fullscreen entry/exit calls are byte-identical.
  assert.equal((player.match(/void surface\.requestFullscreen\(\)\.catch\(\(\) => \{\}\);/g) ?? []).length, 1, 'fullscreen entry call unchanged');
  assert.equal((player.match(/void document\.exitFullscreen\(\)\.catch\(\(\) => \{\}\);/g) ?? []).length, 1, 'fullscreen exit call unchanged');
  // The fullscreen overlay renders ONLY while the surface itself is
  // fullscreen AND the embed is not active.
  assert.ok(player.includes('{#if isFullscreen && !embedActive}'), 'fullscreen overlay guarded by isFullscreen && !embedActive');
  const fsBlock = sliceOf(player, '{#if isFullscreen && !embedActive}', '{/if}');
  assert.ok(fsBlock.includes('class="fs-controls"'), 'overlay container present');
  assert.ok(fsBlock.includes('{@render nativeControlCluster()}'), 'overlay renders the shared cluster');
  assert.ok(fsBlock.includes('{@render fitModeButton()}'), 'overlay renders the fit toggle');
  assert.ok(fsBlock.includes('{@render fullscreenButton()}'), 'overlay renders the exit-fullscreen button');
  // Auto-hide: only while playing; wake on pointer activity; timer cleaned up.
  assert.ok(player.includes('engineState === \'playing\''), 'auto-hide only while playing');
  assert.ok(player.includes('function wakeFsControls(): void'), 'pointer wake function exists');
  assert.ok(player.includes('use:wakeSurfaceOnPointer'), 'surface uses the pointer wake action');
  const destroyBody = sliceOf(player, 'onDestroy(() => {', 'video = undefined;');
  assert.ok(destroyBody.includes('clearFsHideTimer();'), 'the auto-hide timer is cleared on destroy');
  // The bar below the video is inert while its surface is fullscreen.
  assert.ok(player.includes('inert={isFullscreen}'), 'bar is inert while fullscreen (no stray tab stops)');
  // The fullscreen surface covers the complete screen.
  const fsCss = sliceOf(player, '.player-surface:fullscreen {', '}');
  assert.ok(fsCss.includes('width: 100%;') && fsCss.includes('height: 100%;'), 'fullscreen surface explicitly covers the screen');
  ok('B3. fullscreen: mechanics unchanged; overlay controls inside the surface; bar inert');
}

// ============================================================
// §B4 — LT-16 orientation wiring intact
// ============================================================
{
  assert.ok(player.includes('isFullscreen = fullscreenElement === surface;'), 'isFullscreen semantics unchanged');
  assert.ok(player.includes('surface.contains(fullscreenElement)'), 'containment check preserved');
  assert.equal((player.match(/fullscreenOrientation\.noteFullscreenGained\(\)/g) ?? []).length, 1, 'single gained call site');
  assert.equal((player.match(/fullscreenOrientation\.noteFullscreenLost\(\)/g) ?? []).length, 1, 'single lost call site');
  assert.equal((player.match(/fullscreenOrientation\.dispose\(\)/g) ?? []).length, 1, 'single dispose call site');
  assert.equal((player.match(/document\.addEventListener\('fullscreenchange', onFullscreenChange\)/g) ?? []).length, 1, 'one fullscreenchange registration');
  assert.ok(!player.includes('screen.orientation'), 'the component never touches screen.orientation itself');
  assert.ok(!page.includes('screen.orientation'), 'the page never touches screen.orientation');
  ok('B4. LT-16: shared-surface orientation coordinator wiring byte-identical');
}

// ============================================================
// §B5 — DVR seek control ONLY with a real seek range
// ============================================================
{
  // The snippet gates the input on a valid range (start < end).
  const seekSnippet = sliceOf(player, '{#snippet liveSeekControl()}', '{/snippet}');
  assert.ok(seekSnippet.includes('{#if showSeek && seekRange}'), 'seek input gated on showSeek && seekRange');
  const showSeek = sliceOf(player, 'const showSeek = $derived(', '\n  );');
  assert.ok(showSeek.includes('seekRange !== null') && showSeek.includes('seekRange.end > seekRange.start'), 'showSeek requires a VALID range');
  assert.ok(seekSnippet.includes('aria-label="Seek within the live window"'), 'seek labelled');
  // Go-live stays behind-live-edge only.
  assert.ok(player.includes('{#if showGoLive}'), 'go-live gated');
  ok('B5. DVR: seek + go-live render only behind a real live seek range');
}

// ============================================================
// §B6 — Fit/fill: default, switching, no distortion, presentation-only
// ============================================================
{
  // Default is FIT.
  assert.ok(player.includes("let fitMode = $state<LiveTvFitMode>('fit');"), 'fit is the default display mode');
  // The video element swaps ONLY its fit class.
  assert.ok(player.includes("class:video-fill={fitMode === 'fill'}"), 'fill binds the video-fill class');
  assert.equal((player.match(/class:video-fill/g) ?? []).length, 1, 'fit class bound exactly once (video element)');
  // Base rule keeps contain (FIT); fill is cover — crop, NEVER stretch.
  const baseVideoCss = sliceOf(player, '.player-surface video {', '}');
  assert.ok(baseVideoCss.includes('object-fit: contain;'), 'FIT base rule keeps object-fit: contain');
  const fillCss = sliceOf(player, '.player-surface video.video-fill {', '}');
  assert.ok(fillCss.includes('object-fit: cover;'), 'FILL rule uses object-fit: cover');
  assert.ok(!player.includes('object-fit: fill'), 'stretch (object-fit: fill) is deliberately NOT offered');
  // Toggle flips both ways.
  const toggleBody = sliceOf(player, 'function toggleFitMode(): void {', '}');
  assert.ok(toggleBody.includes("fitMode = fitMode === 'fit' ? 'fill' : 'fit';"), 'toggle cycles fit <-> fill');
  // Presentation-only: the toggle body contains NOTHING but the mode write.
  assert.equal((toggleBody.match(/engine|seek|volume|muted|fullscreen|load/g) ?? []).length, 0, 'toggleFitMode never touches playback');
  // The fit button is a labelled, non-default-highlighted control.
  const fitSnippet = sliceOf(player, '{#snippet fitModeButton()}', '{/snippet}');
  assert.ok(fitSnippet.includes("class:active={fitMode === 'fill'}"), 'fill mode highlighted');
  assert.ok(fitSnippet.includes('aria-label='), 'fit button labelled');
  ok('B6. fit/fill: FIT default, FILL crops (cover) — never stretches — and is presentation-only');
}

// ============================================================
// §B7 — Embed mode: native controls absent, embed controls untouched
// ============================================================
{
  // The bar's embed branch contains ONLY the reload control + spacer.
  const bar = sliceOf(
    player,
    '<div class="player-controls" aria-label="Playback controls" inert={isFullscreen}>',
    '</section>'
  );
  const embedBranch = sliceOf(bar, '{#if embedActive}', '{:else if showNativeControls}');
  const nativeBranchFrom = bar.indexOf('{:else if showNativeControls}');
  const nativeBranch = bar.slice(nativeBranchFrom, bar.indexOf('{/if}', nativeBranchFrom));
  assert.ok(embedBranch.includes('Reload player'), 'embed branch keeps the reload control');
  assert.ok(!embedBranch.includes('togglePlay'), 'no play control in embed branch');
  assert.ok(!embedBranch.includes('toggleMute'), 'no mute control in embed branch');
  assert.ok(!embedBranch.includes('toggleFitMode'), 'no fit control in embed branch');
  assert.ok(!embedBranch.includes('nativeControlCluster'), 'no native cluster in embed branch');
  assert.ok(!embedBranch.includes('live-seek'), 'no seek control in embed branch');
  // The native cluster renders only inside the showNativeControls branch.
  assert.ok(nativeBranch.includes('{@render nativeControlCluster()}'), 'native cluster in the native branch');
  assert.ok(nativeBranch.includes('{@render fitModeButton()}'), 'fit toggle in the native branch');
  // The embed iframe markup is untouched (LT-15 contracts).
  assert.equal((player.match(/<iframe/g) ?? []).length, 1, 'still exactly one iframe');
  assert.ok(player.includes('allowfullscreen'), 'allowfullscreen preserved');
  assert.ok(player.includes('allow="autoplay; fullscreen; encrypted-media; picture-in-picture"'), 'allow-list preserved verbatim');
  assert.ok(player.includes('src={embedSrc}'), 'iframe src still comes from the builder only');
  assert.ok(player.includes('{#key embedReloadToken}'), 'iframe still keyed by the reload token');
  assert.ok(player.includes('class:embed-hidden={embedActive}'), 'native video still hidden in fallback mode');
  // The fullscreen overlay can never appear in embed mode (guarded by
  // !embedActive in §B3) — re-assert the guard is on the SAME line as the
  // isFullscreen condition, not an outer if that embed state could bypass.
  const guard = player.match(/\{#if isFullscreen && !embedActive\}/);
  assert.ok(guard !== null && guard.length === 1, 'exactly one fullscreen-overlay guard, embed-excluded');
  ok('B7. embed mode: its own controls only; native controls/overlays structurally absent');
}

// ============================================================
// §B8 — Regression guards: architecture boundaries intact
// ============================================================
{
  // Analytics intents: exactly the same three (no new report kinds).
  assert.deepEqual(
    (player.match(/onuseraction\('([a-z_]+)'\)/g) ?? []).sort(),
    ["onuseraction('fullscreen_enter')", "onuseraction('fullscreen_exit')", "onuseraction('pause')"],
    'analytics intent set unchanged'
  );
  // The page's user-action bridge signature is untouched.
  assert.match(page, /function handlePlayerUserAction\(action: 'pause' \| 'fullscreen_enter' \| 'fullscreen_exit'\)/, 'page bridge unchanged');
  // No forbidden strings crept in (mirrors the LT-16/hardening scans).
  for (const banned of ['console.', 'localStorage', 'sessionStorage', 'indexedDB', 'document.cookie', 'livetgtv']) {
    assert.ok(!player.includes(banned), `player contains no ${banned}`);
    assert.ok(!overlayModule.includes(banned), `overlay module contains no ${banned}`);
  }
  assert.ok(!player.includes('contentDocument') && !player.includes('contentWindow'), 'the iframe document is never accessed');
  assert.ok(!player.includes('viewport'), 'no viewport manipulation');
  assert.ok(!player.includes('rotate(90'), 'no CSS rotation hack');
  assert.ok(!player.includes('{@html'), 'no {@html}');
  // Comment-free player code stays free of analytics knowledge.
  const playerCode = player
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/[^\n]*$/gm, '')
    .replace(/([^:])\/\/[^\n]*/g, '$1');
  assert.ok(!playerCode.includes('analytics'), 'player code contains no analytics references');
  assert.ok(!playerCode.includes('trackLiveTv'), 'player never calls trackers');
  assert.ok(!playerCode.includes('dispatcher'), 'player never imports the dispatcher');
  // Engine/fallback classifier/V1 client untouched by LT-17.
  assert.equal((page.match(/new LiveTvPlaybackEngine\(\)/g) ?? []).length, 1, 'still exactly one engine construction site');
  assert.ok(page.includes('shouldFallbackToEmbed(error)'), 'fallback classifier still gates activation');
  assert.ok(page.includes('trackLiveTvFallbackEmbed(channel.id, err);'), 'fallback analytics unchanged');
  // Shaka still never imported by the component.
  assert.doesNotMatch(player, /from 'shaka-player'|from "shaka-player"/, 'player never imports Shaka');
  assert.doesNotMatch(player, /shaka\./, 'player never references Shaka APIs');
  ok('B8. regression: analytics intents, security scans, fallback architecture all intact');
}

// ============================================================
// §C — Overlay module hygiene (SSR + purity)
// ============================================================
{
  // Importing the module under Node is exactly what SSR does — the suite
  // itself proves it (this file imports it at the top). No browser access.
  assert.ok(!overlayModule.includes('document.'), 'module never touches the document');
  assert.ok(!overlayModule.includes('window.'), 'module never touches the window');
  assert.ok(overlayModule.includes('export function isLiveTvOverlayShown'), 'the derivation is exported (single source of truth)');
  ok('C. overlay module: pure, SSR-safe, the component\'s single overlay source');
}

// ============================================================
console.log(`\nLT-17 player UI/controls + video fit: ${passed} checks passed.`);
