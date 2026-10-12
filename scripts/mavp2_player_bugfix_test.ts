/**
 * MAVP-2 — Player Orientation, Controls Auto-Hide, Responsive Positioning &
 * Admin Calibration Bug Fixes. Regression suite for each audited root cause.
 *
 * MAVP-3 supersession (2026-10-11): §A was REWRITTEN for the MAVP-3 Issue 1
 * contract — the automatic landscape-first presentation (MAVP-2's click-time
 * request + shell mount adoption) was REMOVED; §A now asserts that NO
 * automatic orientation lock is reachable from ANY playback entry path while
 * the manual Landscape control stays intact. §C3 was updated for the MAVP-3
 * Issue 3 accent-token chip bar; §D22 for the composed placement+size inline
 * style (MAVP-3 Issue 5). The MAVP-3-dedicated suite lives in
 * `mavp3_player_bugfix_test.ts`.
 *
 * Sections:
 *   §A  NO automatic landscape on ANY playback entry path (MAVP-3) — the
 *       landscape-first module is deleted, no entry imports/calls it, the
 *       shell never auto-requests fullscreen/orientation, orientation lock
 *       survives ONLY inside the manual controllers; no iframe reload; no
 *       resolver involvement; resume chain intact.
 *   §B  Five-second auto-hide for ALL THREE controls — embed-session arming
 *       (the audited root cause: black-box embeds never armed the timer),
 *       embed-load arming, keyboard/TV activity signal, state resets, cleanup.
 *   §C  Source chip compact sizing — accent surface (theme tokens), compact
 *       hit area, content-aware truncated label, no layout shift/overlap.
 *   §D  Per-source Back-button positioning + independent portrait/landscape
 *       profiles — parser truth table, control/orientation isolation,
 *       renderer contract, Admin draft/reset structure.
 *   §E  Admin positioning validation — the EXACT reported save error is
 *       reproduced against the legacy transport and proven fixed by the
 *       structured JSON contract; strict validation preserved; legacy
 *       stored settings keep working.
 *   §F  Existing functionality protected — sandbox pipeline, resolver
 *       guards, iframe keying, keyboard contract, PiP quiet-exit.
 *
 * Deterministic: pure functions + source-level contract assertions. Never
 * the real network, never the real DB, never a real provider.
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';

import {
  PLAYER_CONTROLS_POSITION_CAPABILITY_KEY,
  controlsPlacementInlineStyle,
  controlsPositionFromCapabilities,
  parsePlayerControlsPosition,
  resolveControlPlacement,
  resolveLandscapeControlPlacement,
} from '$lib/shared/player-controls-position';
import { landscapeFirstEligible } from '$lib/client/player/landscape-first';
import { playerControlsPositionCapability } from '$lib/server/streaming/validation';

function read(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf8');
}

const shell = read('../src/lib/components/player/PlayerShell.svelte');
const viewport = read('../src/lib/components/player/PlayerViewport.svelte');
const watchPage = read('../src/routes/watch/[type]/[id]/+page.svelte');
const detailPage = read('../src/lib/components/DetailPage.svelte');
const mediaCard = read('../src/lib/components/MediaCard.svelte');
const spotlight = read('../src/lib/components/SpotlightCarousel.svelte');
const seasonEpisodes = read('../src/lib/components/SeasonEpisodes.svelte');
const adminPage = read('../src/routes/admin/system/api-sources/+page.svelte');
const validation = read('../src/lib/server/streaming/validation.ts');
const manager = read('../src/lib/client/player/PlaybackManager.ts');

/** Strip JS/Svelte/CSS comments so negative assertions test CODE, not docs. */
function codeOnly(source: string): string {
  return source
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
}
/** Extract the balanced-brace body that follows a `signature(...)` marker. */
function functionBody(source: string, marker: string, nextMarker: string): string {
  const start = source.indexOf(marker);
  const end = nextMarker ? source.indexOf(nextMarker, start + marker.length) : source.length;
  return start === -1 ? '' : source.slice(start, end === -1 ? source.length : end);
}

let section = '';
function section_ok(name: string) { section = name; }
function ok(condition: unknown, label: string) {
  assert.ok(condition, `[${section}] ${label}`);
}
function okEq<T>(actual: T, expected: T, label: string) {
  assert.deepEqual(actual, expected, `[${section}] ${label}`);
}
function form(...entries: [string, string][]): FormData {
  const fd = new FormData();
  for (const [key, value] of entries) fd.append(key, value);
  return fd;
}

// ============================================================================
// §A NO automatic landscape on any playback entry path (MAVP-3 Issue 1 —
//    supersedes the MAVP-2 landscape-first contract, which was removed)
// ============================================================================
section_ok('§A no automatic landscape');

const shellCode = codeOnly(shell);
const detailCode = codeOnly(detailPage);
const cardCode = codeOnly(mediaCard);
const spotlightCode = codeOnly(spotlight);
const episodesCode = codeOnly(seasonEpisodes);
const watchCode = codeOnly(watchPage);

// A1. The MAVP-2 landscape-first helper module is DELETED — the automatic
//     rotation entry point cannot be reached because the code no longer
//     exists (the module carried requestLandscapeFirstPresentation, the
//     eligibility gate, and the sessionStorage intent marker).
ok(!existsSync(new URL('../src/lib/client/player/landscape-first.ts', import.meta.url)), 'A1. landscape-first module deleted (automatic rotation removed at the root)');

// A2-A5. NO playback entry point imports or calls the removed helper —
//     detail page, content cards, spotlight hero, and episode links all open
//     playback in the device's EXISTING orientation.
ok(!/from '\$lib\/client\/player\/landscape-first'/.test(detailCode) && !/requestLandscapeFirstPresentation\(/.test(detailCode), 'A2. Detail page Play no longer requests a landscape presentation');
ok(!/from '\$lib\/client\/player\/landscape-first'/.test(cardCode) && !/requestLandscapeFirstPresentation\(/.test(cardCode), 'A3. Content-card Play no longer requests a landscape presentation');
ok(!/from '\$lib\/client\/player\/landscape-first'/.test(spotlightCode) && !/requestLandscapeFirstPresentation\(/.test(spotlightCode), 'A4. Spotlight hero Play no longer requests a landscape presentation');
ok(!/from '\$lib\/client\/player\/landscape-first'/.test(episodesCode) && !/requestLandscapeFirstPresentation\(/.test(episodesCode), 'A5. Episode-link Play no longer requests a landscape presentation');

// A6. The shell never auto-requests the presentation: no mount-time attempt,
//     no adoption path, no device-class eligibility gate, no intent marker.
ok(!/enterLandscapePresentation/.test(shellCode), 'A6. enterLandscapePresentation is gone from the shell');
ok(!/consumeLandscapeFirstIntent/.test(shellCode), 'A7. the landscape-first intent adoption path is gone');
ok(!/landscapeFirstEligible/.test(shellCode), 'A8. the device-class landscape eligibility gate is gone');
ok(!/export let deviceType/.test(shellCode) && !/deviceType=\{page\.data\.deviceType\}/.test(watchCode), 'A9. the deviceType prop (auto-landscape plumbing) is removed from the shell and the watch route');

// A10. THE CORE CONTRACT: orientation locks survive ONLY inside the MANUAL
//      controllers (toggleLandscape — the Landscape control; toggleFullscreen
//      — the F-key). No `lock('landscape')` call is reachable from playback
//      startup, route loading, or iframe mounting.
const toggleLandscapeBody = functionBody(shellCode, 'async function toggleLandscape()', 'async function toggleFullscreen()');
const toggleFullscreenBody = functionBody(shellCode, 'async function toggleFullscreen()', 'async function exitMaveroFullscreen');
ok(/lock\?\.\('landscape'\)/.test(toggleLandscapeBody), 'A10. the manual Landscape control still locks orientation (user-initiated only)');
ok(/orientationController\(\)\?\.lock\?\.\('landscape'\)/.test(toggleFullscreenBody), 'A11. the manual F-key fullscreen still locks orientation (user-initiated only)');
// MAVP-5 Issue 5 supersession: the intent-preserving restore routine
// (restoreLandscapePresentationOnce) re-issues the user's EXPLICIT
// presentation when a source switch provably dropped it (bounded, ONE
// attempt, requires the user's prior landscape intent). It is excluded
// alongside the manual controllers; its boundedness is asserted below —
// no automatic landscape path exists outside these three bodies.
const restoreBodyA = functionBody(shellCode, 'async function restoreLandscapePresentationOnce()', 'const handleKeydown');
const shellCodeWithoutManualControllers = shellCode.replace(toggleLandscapeBody, '').replace(toggleFullscreenBody, '').replace(restoreBodyA, '');
ok(!/lock\?\.\('landscape'\)/.test(shellCodeWithoutManualControllers), 'A12. NO orientation lock is reachable outside the two manual controllers and the MAVP-5 intent-preserving restore (no automatic landscape anywhere)');
ok(shell.includes('if (landscapeRestoreInFlight) return;') && shell.includes('LANDSCAPE_RESTORE_WINDOW_MS = 2000'),
  'A12-MAVP5 the restore is bounded (one attempt, documented window) and requires the user\u2019s prior landscape intent');
// A13. No PLAY entry path or watch-route code touches the orientation API.
//      (The detail page's OWN inline-trailer fullscreen lock — a separate,
//      user-initiated MAV-24 handler — is unrelated behavior and preserved;
//      this assertion pins it to that trailer function so a future entry-path
//      lock cannot hide behind it.)
ok(!/orientation\.lock|screen\.orientation/.test(cardCode + spotlightCode + episodesCode + watchCode), 'A13a. card/spotlight/episode entries and the watch route never touch the orientation API');
ok(!/orientation\.lock|screen\.orientation|requestFullscreen/.test(functionBody(detailPage, '<a class="play-btn"', '</a>\n')), 'A13b. the detail-page Play handler never requests fullscreen or orientation');
ok(/screen\.orientation/.test(functionBody(detailPage, 'async function enterTrailerFullscreen', 'async function exitTrailerFullscreen')), 'A13c-1. the trailer-fullscreen handler is the known user-initiated orientation user (preserved)');
const detailOrientationUses = [...detailCode.matchAll(/screen\.orientation/g)].map((match) => match.index ?? 0);
ok(detailOrientationUses.length > 0 && detailOrientationUses.every((idx) => idx > detailCode.indexOf('async function enterTrailerFullscreen')), 'A13c-2. ALL detail-page orientation use sits INSIDE the user-initiated trailer-fullscreen handlers (no playback-entry orientation code)');

// A14. The manual Landscape control itself is fully preserved (FAB markup,
//      enter/exit, aria state) — only the AUTOMATIC behaviour was removed.
ok(/class="control-fab landscape-fab"/.test(shell) && /aria-label=\{landscapeMode \? 'Exit landscape player' : 'Enter landscape player'\}/.test(shell), 'A14. the manual Landscape control remains available in the player');
ok(/async function toggleLandscape\(\)/.test(shellCode) && /orientation\?\.unlock\?\.\(\)/.test(toggleLandscapeBody), 'A15. return-to-portrait (unlock) preserved in the manual controller');

// A16. Orientation changes never reload the iframe or touch the resolver —
//      the iframe key is source/url/sandbox only.
ok(/iframeKey = `\$\{source\?\.sourceId \?\? 'empty'\}:\$\{source\?\.url \?\? ''\}:\$\{effectiveSandbox\}`/.test(viewport), 'A16. iframe key excludes orientation/position/visibility (no remount on orientation changes)');
ok(!/iframe\.src\s*=/.test(shell) && !/location\.reload/.test(shell), 'A17. shell never reassigns the iframe src or reloads');
ok(!/loadSource|\/api\/playback|resolveSource/.test(functionBody(shellCode, 'async function toggleLandscape()', 'async function toggleFullscreen()')), 'A18. the manual orientation controller never triggers source resolution');

// A19. Resume/selection dependencies byte-preserved (Phase 9 contract): the
//      orientation work cannot skip or reorder the progress chain.
ok(/progressReady && !selectedSourceId && sourceOptions\.length/.test(watchPage), 'A19. source selection still waits for the saved progress record');
ok(/progressReady && selectedSourceId && resolutionState === 'idle'/.test(watchPage), 'A20. resolver still starts exactly once per selected source');

// ============================================================================
// §B Five-second auto-hide for all three floating controls
// ============================================================================
section_ok('§B auto-hide');

// B1. THE ROOT CAUSE (audited): the arming condition previously knew only
//     `playing` (direct-video flag) and `embedPlaying` (provider postMessage
//     events — most black-box providers never post), so NO timer was ever
//     armed during a typical embed session. The shell-visible embed session
//     state now participates.
ok(/const embedSessionArms = source\?\.type === 'embed'/.test(shell), 'B1. embed session state participates in the auto-hide arming');
ok(/&& \(!embedEverPlayed \|\| embedPlaying\)/.test(shell), 'B2. provider-reported pause keeps the controls visible for event-posting embeds');
ok(/function handleEmbedLoad\(\) \{[\s\S]*?revealControls\(\);/.test(shell), 'B3. embed load arms the countdown — no further user activity required');

// B4. The single authoritative timer hides ALL THREE Mavero controls (back
//     FAB, control-fab-group, source chip share the controls-hidden state).
const revealStart = shell.indexOf('function revealControls()');
const revealEnd = shell.indexOf('function focusWithinMaveroControls');
const revealBody = shell.slice(revealStart, revealEnd);
ok(revealBody.includes("setTimeout") && revealBody.includes('5_000'), 'B4. single 5s timer body in revealControls');
ok((revealBody.match(/setTimeout/g) ?? []).length === 1, 'B5. exactly ONE timer body (no competing inactivity timers)');
ok(/class:controls-hidden=\{!controlsVisible\}/.test(shell) && /class:visible=\{controlsVisible\}/.test(shell), 'B6. back FAB, control group and chip are all driven by the SAME visibility state');
ok(/\.player-shell\.controls-hidden \.back-fab \{[^}]*pointer-events: none/.test(shell) && /\.player-shell\.controls-hidden \.source-chip \{[^}]*pointer-events: none/.test(shell) && /\.player-shell\.controls-hidden \.control-fab-group \{[^}]*pointer-events: none/.test(shell), 'B7. all three controls become non-interactive when hidden (no invisible click-intercepting layer)');

// B8. Activity signals: pointer (move/down), touch, keyboard focus AND raw
//     keydown (TV remotes navigate with non-Mavero keys).
ok(/playerRoot\?\.addEventListener\('pointermove', showControls/.test(shell) && /playerRoot\?\.addEventListener\('pointerdown', showControls/.test(shell) && /playerRoot\?\.addEventListener\('touchstart', showControls/.test(shell), 'B8. pointer + touch activity routes through revealControls');
ok(/document\.addEventListener\('focusin', handleFocusIn\)/.test(shell), 'B9. keyboard focus activity routes through revealControls');
const keydownStart = shell.indexOf('const handleKeydown = (event: KeyboardEvent) => {');
const keydownBody = shell.slice(keydownStart, keydownStart + 2200);
ok(/revealControls\(\);/.test(keydownBody), 'B10. ANY keypress outside editable surfaces is user activity (TV remote navigation reveals controls)');
ok(/target\?\.matches\('input, select, textarea, \[contenteditable="true"\]'\) return/.test(shell.replace(/\n/g, ' ')) || /if \(target\?\.matches\('input, select, textarea, \[contenteditable="true"\]'\)\) return;/.test(keydownBody), 'B11. typing guard preserved (typing never toggles the player)');

// B12. Media progress never resets the deadline (background playback cannot
//      keep the controls alive): revealControls is NOT called from
//      timeupdate/progress paths.
ok(!/handleTimeUpdate\(\)[\s\S]{0,200}revealControls/.test(shell.slice(shell.indexOf('function handleTimeUpdate'), shell.indexOf('function handleTimeUpdate') + 700)), 'B12. timeupdate does not reset the inactivity deadline');
ok(/embedEverPlayed = false;/.test(shell.split('// Phase 6 audit fix 2: reset embed playback state on source switch')[1]?.split('embedPlaybackSourceId = source.sourceId;')[0] ?? '') && /embedEverPlayed = false;/.test(shell.split('// Phase 6 audit fix 2: reset embed playback state on episode switch')[1]?.split('if (source?.sourceId) embedPlaybackSourceId')[0] ?? ''), 'B13. embed playback state resets on source AND episode switch (stale session cannot pin the timer)');

// B14. Full cleanup on route change / destroy (timers + listeners).
// Player UI V2 (Part 1, Phase 2) supersession: the cleanup body legitimately
// grew (gesture-controller + gesture-indicator teardown) — the scan window
// widens 1600 → 2000 chars. The asserted contract is unchanged: every timer
// and listener added in onMount is removed in the SAME cleanup.
// Player V2 corrections supersession (documented): the cleanup now also
// restores the pre-hold 2× speed, clears the seek-feedback timer, destroys
// the tap-gesture controller and STOPS the media session (the background-
// audio fix) — the window widens 2000 → 2400 chars; the contract (every
// timer and listener removed in the SAME cleanup) is unchanged.
const cleanupStart = shell.indexOf('return () => {', shell.indexOf('window.addEventListener(\'blur\', handleWindowBlur);'));
const cleanupBody = shell.slice(cleanupStart, cleanupStart + 2400);
ok(/if \(hideTimer\) clearTimeout\(hideTimer\)/.test(cleanupBody), 'B14. inactivity timer cleared on destroy');
ok(/orientationMediaQuery\.removeEventListener\('change', handleOrientationChange\)/.test(cleanupBody), 'B15. orientation profile listener removed on destroy (no leak across watch-route mounts)');
ok(/window\.removeEventListener\('keydown', handleKeydown\)/.test(cleanupBody) && /window\.removeEventListener\('blur', handleWindowBlur\)/.test(cleanupBody) && /document\.removeEventListener\('focusin', handleFocusIn\)/.test(cleanupBody), 'B16. keydown + iframe-blur + focusin listeners removed on destroy');

// B16b. Touch recovery path for cross-origin embeds: tapping the iframe
// takes focus → the parent window fires `blur` with the iframe as
// activeElement — the only honest cross-origin-safe tap signal. Non-iframe
// blurs (tab switches) are filtered; the iframe DOM is never touched.
// MAVP-4 supersession (documented): the SAME handler now ALSO dismisses the
// embed presentation gate (revealEmbedSurface) — the revealControls contract
// asserted here is UNCHANGED, only extended.
ok(/const handleWindowBlur = \(\) => \{\s*const active = document\.activeElement;\s*if \(active instanceof HTMLIFrameElement && playerRoot\?\.contains\(active\)\) \{\s*revealEmbedSurface\(\);\s*revealControls\(\);/.test(shell), 'B16b. iframe-tap (window blur + activeElement iframe) reveals the controls — touch recovery path for embeds (+ MAVP-4: dismisses the presentation gate)');
ok(/window\.addEventListener\('blur', handleWindowBlur\)/.test(shell), 'B16c. blur activity signal registered once in onMount');
ok(!shell.includes('contentWindow.addEventListener') && !shell.includes('iframe.contentDocument'), 'B16d. the blur path never touches the cross-origin iframe DOM');

// B17. Sheet/focus guards: an open sheet or focused control is never hidden.
ok(/!sourceMenuOpen && !episodeMenuOpen && !focusWithinMaveroControls\(\)/.test(revealBody), 'B17. sheet-open + keyboard-focus guards inside the timer callback');
// MAVP-5 Issue 4 supersession: the focus guard now also covers the dedicated
// episode chip (a Mavero-owned control surface that must never auto-hide).
ok(/\.back-fab, \.control-fab-group, \.source-chip, \.episode-chip, \.direct-controls-overlay, \.source-sheet, \.episode-sheet/.test(shell), 'B18. focus guard covers every Mavero-owned control surface (incl. the MAVP-5 episode chip)');

// ============================================================================
// §C Source chip — compact closed sizing
// ============================================================================
section_ok('§C source chip');

ok(/\.source-chip \{[^}]*background: transparent/.test(shell), 'C1. closed chip paints NO wide translucent slab (button surface transparent)');
ok(/\.source-chip-bar \{[^}]*width: 5px/.test(shell), 'C2. visible affordance stays the ~5px bar (reference: 4-6px)');
ok(/\.source-chip-bar \{[^}]*background: var\(--accent\)/.test(shell) && /\.source-chip-bar \{[^}]*backdrop-filter: blur\(12px\)/.test(shell), 'C3. accent surface carried by the bar itself (MAVP-3 Issue 3: theme tokens, no hardcoded dark slab)');
ok(!/\.source-chip-bar \{[^}]*rgba\(0,0,0/.test(shell), 'C3b. the chip bar no longer hardcodes a black slab (MAVP-3 Issue 3: accent tokens only)');
ok(/\.source-chip-label \{[^}]*color: var\(--accent\)/.test(shell) && /\.source-chip-label \{[^}]*background: var\(--accent-soft\)/.test(shell), 'C3c. the hover label uses the accent palette tokens (MAVP-3 Issue 3)');
ok(/\.source-chip \{[^}]*min-width: 44px/.test(shell) && /\.source-chip \{[^}]*min-height: 64px/.test(shell), 'C4. touch target preserved (>=44x64 hit area without visual bulk)');
ok(/\.source-chip \{[^}]*position: absolute/.test(shell) && /\.source-chip \{[^}]*top: 50%/.test(shell) && /\.source-chip \{[^}]*right: 0/.test(shell), 'C5. absolutely positioned at the right edge — expansion cannot shift layout or push controls off-screen');
ok(/\.source-chip-label \{[^}]*text-overflow: ellipsis/.test(shell) && /\.source-chip-label \{[^}]*max-width: min\(42vw, 220px\)/.test(shell), 'C6. label ellipsis-truncated at a bounded max-width (long source names cannot expand the chip)');
ok(/\{activeSourceOption\?\.name \|\| 'Source'\}/.test(shell), 'C7. label is content-aware (active source name)');
ok(/\.source-chip:hover \.source-chip-bar, \.source-chip:focus-visible \.source-chip-bar/.test(shell), 'C8. hover/focus affordance moved to the bar (no button-level slab)');
ok(/\.player-shell\.controls-hidden \.source-chip \{ opacity: 0/.test(shell), 'C9. chip still hides/reveals with the other controls');
ok(/\.source-chip \{[^}]*z-index: 12/.test(shell) && /\.sheet-overlay \{[^}]*z-index: 20/.test(shell), 'C10. chip remains below the sheets (never blocks provider controls)');
ok(/@media \(orientation: landscape\) and \(max-height: 500px\) \{[\s\S]*\.source-chip \{ min-height: 56px; \}/.test(shell), 'C11. landscape phone compaction preserved (56px hit height, 48px bar)');

// ============================================================================
// §D Per-source Back positioning + independent orientation profiles
// ============================================================================
section_ok('§D positioning profiles');

// D1. Parser: back section + legacy base + overrides, all total.
const parsedBack = parsePlayerControlsPosition({
  mode: 'custom',
  back: { portrait: { horizontal: { anchor: 'left', offsetPercent: 3 } } },
});
ok(parsedBack?.back?.portrait?.horizontal?.anchor === 'left', 'D1. back portrait profile parses');
okEq(parsePlayerControlsPosition({ mode: 'custom', back: 'bogus' })?.back ?? null, null, 'D2. malformed back section → null (total parser)');
okEq(parsePlayerControlsPosition({ mode: 'custom', back: { portrait: { horizontal: { anchor: 'up', offsetPercent: 5 } } } })?.back ?? null, null, 'D3. invalid back anchor → null');
okEq(parsePlayerControlsPosition({ mode: 'custom', back: { portrait: { horizontal: { anchor: 'left', offsetPercent: 999 } } } })?.back ?? null, null, 'D4. out-of-range back offset → null');
okEq(parsePlayerControlsPosition({ mode: 'custom', back: { portrait: { horizontal: { anchor: 'left', offsetPercent: Number.NaN } } } })?.back ?? null, null, 'D5. NaN back offset → null');
ok(parsePlayerControlsPosition({ mode: 'custom', back: { portrait: { horizontal: { anchor: 'left', offsetPercent: 0 } } } }) !== null, 'D6. zero offset is a valid back config (not treated as unset)');

// D7. CONTROL ISOLATION: the back control NEVER reads the landscape
//     control's axes — and vice versa (per-control independence).
const bothControls = parsePlayerControlsPosition({
  mode: 'custom',
  horizontal: { anchor: 'right', offsetPercent: 18 },
  vertical: { anchor: 'bottom', offsetPercent: 12 },
  back: { portrait: { horizontal: { anchor: 'left', offsetPercent: 3 } } },
});
okEq(resolveControlPlacement(bothControls, 'back', 'portrait').horizontal, { anchor: 'left', offsetPercent: 3 }, 'D7. back control resolves its OWN config');
okEq(resolveControlPlacement(bothControls, 'back', 'portrait').vertical, null, 'D8. back control never inherits the landscape control vertical axis');
okEq(resolveControlPlacement(bothControls, 'landscape', 'portrait').horizontal, { anchor: 'right', offsetPercent: 18 }, 'D9. landscape control keeps its legacy base axes');
okEq(resolveLandscapeControlPlacement(bothControls, 'portrait').horizontal?.anchor, 'right', 'D10. legacy resolver unchanged');

// D11. ORIENTATION ISOLATION: portrait coordinates never leak into landscape
//      and vice versa (for EITHER control).
const oriented = parsePlayerControlsPosition({
  mode: 'custom',
  portrait: { horizontal: { anchor: 'left', offsetPercent: 10 } },
  landscape: { horizontal: { anchor: 'right', offsetPercent: 55 } },
  back: {
    portrait: { vertical: { anchor: 'top', offsetPercent: 4 } },
    landscape: { vertical: { anchor: 'bottom', offsetPercent: 30 } },
  },
});
okEq(resolveControlPlacement(oriented, 'back', 'portrait').vertical, { anchor: 'top', offsetPercent: 4 }, 'D11. back portrait profile applies in portrait');
okEq(resolveControlPlacement(oriented, 'back', 'landscape').vertical, { anchor: 'bottom', offsetPercent: 30 }, 'D12. back landscape profile applies in landscape');
okEq(resolveControlPlacement(oriented, 'back', 'landscape').horizontal, null, 'D13. back landscape does not inherit the portrait horizontal axis');
okEq(resolveControlPlacement(oriented, 'landscape', 'portrait').horizontal, { anchor: 'left', offsetPercent: 10 }, 'D14. landscape control portrait override applies');
okEq(resolveControlPlacement(oriented, 'landscape', 'landscape').horizontal, { anchor: 'right', offsetPercent: 55 }, 'D15. landscape control landscape override applies');

// D16. AXIS INDEPENDENCE: each axis is its own object — mutating one parsed
//      axis object cannot affect the other axis / orientation profile.
const isolationSource = {
  mode: 'custom',
  back: {
    portrait: { horizontal: { anchor: 'left', offsetPercent: 5 }, vertical: { anchor: 'top', offsetPercent: 8 } },
    landscape: { horizontal: { anchor: 'right', offsetPercent: 2 } },
  },
};
const parsedIsolation = parsePlayerControlsPosition(isolationSource);
if (parsedIsolation?.back?.portrait?.horizontal) parsedIsolation.back.portrait.horizontal.offsetPercent = 77;
okEq((isolationSource.back as any).portrait.horizontal.offsetPercent, 5, 'D16. parser deep-copies — mutating a parsed axis never mutates the source config');
okEq(parsedIsolation?.back?.portrait?.vertical?.offsetPercent, 8, 'D17. vertical axis untouched by a horizontal mutation');

// D18. Renderer contract: back default = empty style (stylesheet top-left);
//      custom axes emit anchor-edge percentages.
okEq(controlsPlacementInlineStyle(resolveControlPlacement(null, 'back', 'portrait')), '', 'D18. unset back placement → stylesheet default (top-left, safe-area aware)');
ok(controlsPlacementInlineStyle({ horizontal: { anchor: 'left', offsetPercent: 3 }, vertical: { anchor: 'top', offsetPercent: 8 } }).includes('left:3%') && controlsPlacementInlineStyle({ horizontal: { anchor: 'left', offsetPercent: 3 }, vertical: { anchor: 'top', offsetPercent: 8 } }).includes('top:8%'), 'D19. back inline style emits independent H+V axis declarations');
ok(controlsPlacementInlineStyle({ horizontal: { anchor: 'center', offsetPercent: 50 }, vertical: null }).includes('translateX(-50%)'), 'D20. center anchor translates once (single transform source)');

// D21. The shell wires BOTH controls to the REAL viewport orientation.
ok(/orientationMediaQuery = window\.matchMedia\('\(orientation: landscape\)'\)/.test(shell) && /playerOrientation = e\.matches \? 'landscape' : 'portrait'/.test(shell), 'D21. position profiles follow the REAL viewport orientation (immediate on rotation)');
ok(/\$: backControlStyle = \[/.test(shell) && /controlsSizeInlineStyle\(activeSourceOption\?\.controlsPosition \?\? null, 'back', '--back-fab-size'\)/.test(shell), 'D22. back FAB placement + size derived from the ACTIVE source per orientation (MAVP-3: composed inline style)');
ok(/<button class="back-fab"[^>]*style=\{backControlStyle\}/.test(shell), 'D23. back FAB carries its per-source placement style');
ok(!/style=\{landscapeControlStyle\} type="button" aria-label=\{landscapeMode/.test(shell), 'D24. landscape FAB carries NO duplicate inline style');

// D25. Admin draft model: two controls × two orientations, per-control +
//      per-orientation resets, reset-all, JSON payload contract.
ok(/type ControlsControlDraft = \{ portrait: ControlsProfileDraft; landscape: ControlsProfileDraft \}/.test(adminPage), 'D25. Admin draft model has independent portrait/landscape profiles');
ok(/landscapeControl: emptyControlDraft\(\),\s*back: emptyControlDraft\(\)/.test(adminPage), 'D26. Admin draft covers BOTH controls independently');
// MAVP-6 (Issues 2+3) supersession of the MAVP-5 'episodes' reset union: the
// episode-chip position editor was REMOVED from the Admin source editor (the
// chip is fixed like the source chip), so the reset union covers EXACTLY the
// two positionable controls — the stricter shape.
ok(/function resetControlProfile\(control: 'landscapeControl' \| 'back', orientation: 'portrait' \| 'landscape'\)/.test(adminPage) && !/'episodes'/.test(codeOnly(adminPage).match(/function resetControlProfile[\s\S]{0,80}/)?.[0] ?? ''),
  'D27. per-control per-orientation reset exists (MAVP-6: exactly the two positionable controls)');
ok(/positionDraft\[control\]\[orientation\] = emptyProfileDraft\(\)/.test(adminPage), 'D28. resetting one profile touches ONLY that profile');
ok(/function resetAllControlsPosition\(\)/.test(adminPage), 'D29. reset-all exists');
ok(/readLegacyAxis\(custom\?\.back\?\.portrait\?\.horizontal/.test(adminPage) && !/custom\?\.back\?\.portrait\?\.horizontal \?\? custom\?\.horizontal/.test(adminPage), 'D30. back control NEVER prefills from the landscape control legacy base');
ok(/readLegacyAxis\(custom\?\.portrait\?\.horizontal \?\? custom\?\.horizontal/.test(adminPage), 'D31. landscape control prefills per-orientation from its legacy base (backward compatible)');

// ============================================================================
// §E Admin positioning validation — the exact reported error, reproduced
//    and fixed at the contract level
// ============================================================================
section_ok('§E admin validation');

// E1. REPRODUCTION of the reported save error against the LEGACY flat-field
//     transport: the old Admin sheet always rendered the four override
//     offset inputs bound to 0 while their anchor selects submitted "" —
//     so EVERY custom-mode save threw
//     "Player Controls Position offsets require a matching anchor."
assert.throws(
  () => playerControlsPositionCapability(form(
    ['controls_position_mode', 'custom'],
    ['controls_position_h_anchor', 'right'],
    ['controls_position_h_offset', '18'],
    ['controls_position_v_anchor', 'bottom'],
    ['controls_position_v_offset', '12'],
    ['controls_position_p_h_anchor', ''],
    ['controls_position_p_h_offset', '0'],
    ['controls_position_p_v_anchor', ''],
    ['controls_position_p_v_offset', '0'],
    ['controls_position_l_h_anchor', ''],
    ['controls_position_l_h_offset', '0'],
    ['controls_position_l_v_anchor', ''],
    ['controls_position_l_v_offset', '0'],
  )),
  /require a matching anchor/,
  'E1. exact reported error reproduced via the legacy flat-field transport',
);

// E2. THE FIX: the SAME logical configuration sent as the structured JSON
//     payload (what the rebuilt Admin sheet submits) validates and persists.
const jsonSameConfig = playerControlsPositionCapability(form(
  ['controls_position_mode', 'custom'],
  ['controls_position_json', JSON.stringify({
    mode: 'custom',
    portrait: { horizontal: { anchor: 'right', offsetPercent: 18 }, vertical: { anchor: 'bottom', offsetPercent: 12 } },
    landscape: { horizontal: { anchor: 'right', offsetPercent: 18 }, vertical: { anchor: 'bottom', offsetPercent: 12 } },
  })],
));
okEq(jsonSameConfig, {
  mode: 'custom',
  portrait: { horizontal: { anchor: 'right', offsetPercent: 18 }, vertical: { anchor: 'bottom', offsetPercent: 12 } },
  landscape: { horizontal: { anchor: 'right', offsetPercent: 18 }, vertical: { anchor: 'bottom', offsetPercent: 12 } },
}, 'E2. valid per-orientation configuration saves via the JSON contract');

// E3. The JSON contract is STRICT (server-side validation stays
//     authoritative): bad JSON, wrong types, out-of-range and invalid
//     anchors are all rejected with admin-facing messages.
assert.throws(() => playerControlsPositionCapability(form(['controls_position_json', '{not json'])), /must be valid JSON/, 'E3a. malformed JSON rejected');
assert.throws(() => playerControlsPositionCapability(form(['controls_position_json', JSON.stringify({ mode: 'custom', portrait: { horizontal: { anchor: 'diagonal', offsetPercent: 5 } } })])), /anchor is invalid/, 'E3b. invalid anchor rejected');
assert.throws(() => playerControlsPositionCapability(form(['controls_position_json', JSON.stringify({ mode: 'custom', back: { landscape: { vertical: { anchor: 'top', offsetPercent: 140 } } } })])), /between 0 and 100/, 'E3c. out-of-range back offset rejected');
assert.throws(() => playerControlsPositionCapability(form(['controls_position_json', JSON.stringify({ mode: 'custom', back: { portrait: { horizontal: { anchor: 'left', offsetPercent: 'x' } } } })])), /must be a number/, 'E3d. non-numeric back offset rejected');
assert.throws(() => playerControlsPositionCapability(form(['controls_position_json', JSON.stringify({ mode: 'sometimes' })])), /mode is invalid/, 'E3e. invalid mode rejected');
assert.throws(() => playerControlsPositionCapability(form(['controls_position_json', JSON.stringify({ mode: 'custom' })])), /at least one anchor/, 'E3f. empty custom payload rejected');
assert.throws(() => playerControlsPositionCapability(form(['controls_position_json', '[]'])), /must be a JSON object/, 'E3g. non-object payload rejected');

// E4. Back + landscape-control configs persist independently through the
//     JSON contract, and the "at least one anchor" rule accepts a back-only
//     configuration.
const backOnly = playerControlsPositionCapability(form(
  ['controls_position_json', JSON.stringify({ mode: 'custom', back: { portrait: { horizontal: { anchor: 'left', offsetPercent: 2 } } } })],
));
okEq((backOnly as Record<string, any>).back?.portrait?.horizontal, { anchor: 'left', offsetPercent: 2 }, 'E4. back-only custom config persists (rule not weakened)');
ok((backOnly as Record<string, any>).portrait === undefined && (backOnly as Record<string, any>).horizontal === undefined, 'E5. back-only save does NOT touch the landscape control axes');

// E6. Legacy transport still works for pre-MAVP-2 callers/tests, including
//     the portrait override path (E23 contract from the original suite).
const overrideSaved = playerControlsPositionCapability(form(
  ['controls_position_mode', 'custom'],
  ['controls_position_h_anchor', 'right'],
  ['controls_position_p_v_anchor', 'top'],
  ['controls_position_p_v_offset', '5'],
));
okEq((overrideSaved as Record<string, unknown>).portrait, { vertical: { anchor: 'top', offsetPercent: 5 } }, 'E6. legacy flat-field override path unchanged');

// E7. Empty JSON payload falls through to the mode field (default saves keep
//     overwriting stale custom configs through the merge).
okEq(playerControlsPositionCapability(form(['controls_position_json', '   '])), { mode: 'default' }, 'E7. empty payload → default via the mode field');
okEq(playerControlsPositionCapability(form(['controls_position_json', JSON.stringify({ mode: 'default' })])), { mode: 'default' }, 'E8. explicit default payload');

// E9. Persisted round-trip: whatever the server stores, the RUNTIME parser
//     reads back with identical placements (save/reload/preview
//     consistency).
const stored = playerControlsPositionCapability(form(
  ['controls_position_json', JSON.stringify({
    mode: 'custom',
    back: { portrait: { horizontal: { anchor: 'right', offsetPercent: 12 }, vertical: { anchor: 'top', offsetPercent: 6 } }, landscape: { horizontal: { anchor: 'left', offsetPercent: 1 } } },
  })],
)) as unknown;
const reloaded = controlsPositionFromCapabilities({ [PLAYER_CONTROLS_POSITION_CAPABILITY_KEY]: stored });
okEq(resolveControlPlacement(reloaded, 'back', 'portrait'), { horizontal: { anchor: 'right', offsetPercent: 12 }, vertical: { anchor: 'top', offsetPercent: 6 } }, 'E9a. back portrait survives store→reload');
okEq(resolveControlPlacement(reloaded, 'back', 'landscape'), { horizontal: { anchor: 'left', offsetPercent: 1 }, vertical: null }, 'E9b. back landscape survives store→reload');
okEq(resolveControlPlacement(reloaded, 'landscape', 'portrait'), { horizontal: null, vertical: null }, 'E9c. landscape control stays default when the save is back-only');

// E10. Legacy stored sources (pre-MAVP-2 base axes, no back section) keep
//      their exact placement — backward compatibility.
const legacyStored = controlsPositionFromCapabilities({
  [PLAYER_CONTROLS_POSITION_CAPABILITY_KEY]: { mode: 'custom', horizontal: { anchor: 'right', offsetPercent: 6 }, vertical: { anchor: 'bottom', offsetPercent: 22 } },
});
okEq(resolveControlPlacement(legacyStored, 'landscape', 'landscape'), { horizontal: { anchor: 'right', offsetPercent: 6 }, vertical: { anchor: 'bottom', offsetPercent: 22 } }, 'E10a. legacy base axes honored');
okEq(resolveControlPlacement(legacyStored, 'back', 'landscape'), { horizontal: null, vertical: null }, 'E10b. legacy source back control keeps its default');
okEq(controlsPositionFromCapabilities('bogus'), null, 'E10c. corrupted stored value → safe default');

// E11. The Admin sheet submits the structured payload and no longer renders
//      the bare-0 flat override inputs (the root cause surface is gone).
ok(/name="controls_position_json"/.test(adminPage), 'E11a. structured payload field present');
ok(!/name="controls_position_p_h_offset"/.test(adminPage) && !/name="controls_position_l_v_offset"/.test(adminPage), 'E11b. flat override offset inputs REMOVED (no bare-0-without-anchor submissions possible)');
ok(!/name="controls_position_h_offset"/.test(adminPage), 'E11c. flat base offset inputs removed');

// ============================================================================
// §F Existing functionality protected
// ============================================================================
section_ok('§F protected behavior');

ok(/resolveSandboxRuntime\(provider\?\.capabilities, source\.capabilities\)/.test(watchPage), 'F1. server-resolved sandbox pipeline untouched');
ok(/sandbox=\{sandboxAttribute\}/.test(viewport) && /allow="autoplay; fullscreen; picture-in-picture; encrypted-media"/.test(viewport), 'F2. iframe sandbox attribute + allow list untouched');
ok(/markPlayerMilestone\('mavero:resolver-request'\)/.test(manager) && /markPlayerMilestone\('mavero:resolver-response'\)/.test(manager), 'F3. resolver instrumentation preserved');
ok(/sessionWidthGuard|sessionId/.test(manager), 'F4. resolver session guards preserved');
ok(/document\.pictureInPictureElement === videoElement[\s\S]*?exitPipQuietly\(\)/.test(shell), 'F5. PiP cleanup on source switch preserved');
ok(/event\.key === 'f' \|\| event\.key === 'F'/.test(shell) && /event\.key === 's' \|\| event\.key === 'S'/.test(shell), 'F6. F/S keyboard contract preserved');
ok(/if \(event\.repeat\) return;/.test(shell), 'F7. key-repeat guard preserved');
ok(!shell.includes('documentPictureInPicture.requestWindow'), 'F8. Document PiP still never offered as a playback surface');

console.log('MAVP-2 player bug-fix regression tests passed (MAVP-3-superseded sections updated in place):');
console.log('  §A no automatic landscape: 20 checks (module deleted, all four entry points clean, locks only in manual controllers, resume chain intact)');
console.log('  §B auto-hide: 18 checks (embed-session arming root cause, embed-load arming, TV/keyboard activity, deadline protected from media events, full cleanup)');
console.log('  §C source chip: 13 checks (accent token surface, transparent hit area, content-aware truncated label, no layout shift)');
console.log('  §D positioning profiles: 31 checks (parser totals, control/orientation/axis isolation, renderer contract, Admin draft + resets)');
console.log('  §E admin validation: 18 checks (exact reported error reproduced + fixed via JSON contract, strict server gate, legacy compatibility, store/reload round-trip)');
console.log('  §F protected behavior: 8 checks (sandbox pipeline, resolver guards, PiP, keyboard contract)');
