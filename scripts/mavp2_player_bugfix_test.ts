/**
 * MAVP-2 — Player Orientation, Controls Auto-Hide, Responsive Positioning &
 * Admin Calibration Bug Fixes. Regression suite for each audited root cause.
 *
 * Sections:
 *   §A  Landscape-first playback for EVERY entry point — click-time
 *       presentation (freshest user activation) + shell adoption; no
 *       duplicate/competing orientation requests; no iframe reload; no
 *       resolver involvement.
 *   §B  Five-second auto-hide for ALL THREE controls — embed-session arming
 *       (the audited root cause: black-box embeds never armed the timer),
 *       embed-load arming, keyboard/TV activity signal, state resets, cleanup.
 *   §C  Source chip compact sizing — bar-carried surface, transparent hit
 *       area, content-aware truncated label, no layout shift/overlap.
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
const landscapeFirstModule = read('../src/lib/client/player/landscape-first.ts');
const adminPage = read('../src/routes/admin/system/api-sources/+page.svelte');
const validation = read('../src/lib/server/streaming/validation.ts');
const manager = read('../src/lib/client/player/PlaybackManager.ts');

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
// §A Landscape-first playback for every entry point
// ============================================================================
section_ok('§A landscape-first');

// A1. The shared helper exists and gates on the server-derived device class
//     + portrait + coarse pointer — the SAME eligibility as the shell's
//     mount fallback (one eligibility definition, no divergent rules).
ok(/export function landscapeFirstEligible\(/.test(landscapeFirstModule), 'A1. shared eligibility helper exported');
ok(/deviceType !== 'mobile' && deviceType !== 'tablet'/.test(landscapeFirstModule), 'A2. desktop/TV devices are never eligible');
ok(/matchMedia\('\(orientation: portrait\)'\)/.test(landscapeFirstModule) && /matchMedia\('\(pointer: coarse\)'\)/.test(landscapeFirstModule), 'A3. eligibility requires portrait + coarse pointer');
okEq(landscapeFirstEligible('mobile'), false, 'A4. non-browser context (SSR/test) is never eligible — no crash');
okEq(landscapeFirstEligible('desktop'), false, 'A5. desktop class rejected');
okEq(landscapeFirstEligible(undefined), false, 'A6. missing device class rejected');

// A7. The presentation is initiated at PLAY-CLICK time on EVERY entry point —
//     detail page, content cards, spotlight hero, and episode links. This is
//     the root-cause fix: the click handler holds the freshest transient
//     user activation, which previously expired during slow watch-route
//     loads (most often from cards, which have no hover-preloaded data).
ok(/requestLandscapeFirstPresentation\(page\.data\.deviceType\)/.test(detailPage), 'A7. Detail page Play initiates the presentation at click time');
ok(/requestLandscapeFirstPresentation\(page\.data\.deviceType\)/.test(mediaCard), 'A8. Content-card Play initiates the presentation at click time');
ok(/requestLandscapeFirstPresentation\(page\.data\.deviceType\)/.test(spotlight), 'A9. Spotlight hero Play initiates the presentation at click time');
ok(/requestLandscapeFirstPresentation\(page\.data\.deviceType\)/.test(seasonEpisodes), 'A10. Episode-link Play initiates the presentation at click time');
ok(/onclick=\{\(e\) => \{ e\.stopPropagation\(\); requestLandscapeFirstPresentation/.test(mediaCard), 'A11. card play handler stays non-navigating (stopPropagation preserved)');
ok(/markPlayerMilestone\('mavero:play'\); requestLandscapeFirstPresentation/.test(detailPage), 'A12. detail play handler keeps the startup milestone');

// A13. The helper never navigates and never blocks the Play click: the
//      fullscreen/lock chain is fire-and-forget with silent catches
//      (orientation rejection cannot block or error the navigation).
ok(/\.catch\(\(\) => \{ \/\* declined/.test(landscapeFirstModule), 'A13. orientation/fullscreen rejection is swallowed (playback never blocked)');
ok(!/goto|href|location\.assign|location\.replace/.test(landscapeFirstModule), 'A14. the helper performs no navigation of its own');

// A15. The shell ADOPTS the click-time presentation instead of issuing
//      duplicate fullscreen/orientation requests (root-cause guard:
//      "avoid duplicate or competing orientation requests").
ok(/document\.fullscreenElement && consumeLandscapeFirstIntent\(\)/.test(shell), 'A15. shell adopts the click-time presentation when it is already active');
const adoptBranch = shell.split('async function enterLandscapePresentation')[1]?.split('async function toggleLandscape')[0] ?? '';
ok(!/playerRoot\?\.requestFullscreen/.test(adoptBranch.split('await playerRoot?.requestFullscreen')[0] ?? ''), 'A16. adopt branch runs BEFORE any new requestFullscreen (no duplicate request)');
ok(/!String\(screen\.orientation\?\.type \?\? ''\)\.startsWith\('landscape'\)/.test(adoptBranch), 'A17. orientation lock only (re)requested when the device is not already landscape');
ok(/consumeLandscapeFirstIntent\(\); \/\/ stale marker/.test(shell), 'A18. stale intent markers are consumed exactly once (never leak into a later entry)');
ok(/if \(landscapeFirstEligible\) void enterLandscapePresentation\(\);/.test(shell), 'A19. mount-time attempt remains as the fallback (entries without a click gesture)');

// A20. Orientation changes never reload the iframe or touch the resolver —
//      the iframe key is source/url/sandbox only, and the landscape-first
//      module never resolves sources or mutates manager state.
ok(/iframeKey = `\$\{source\?\.sourceId \?\? 'empty'\}:\$\{source\?\.url \?\? ''\}:\$\{effectiveSandbox\}`/.test(viewport), 'A20. iframe key excludes orientation/position/visibility (no remount on orientation changes)');
ok(!/iframe\.src\s*=/.test(shell) && !/location\.reload/.test(shell), 'A21. shell never reassigns the iframe src or reloads');
ok(!/loadSource|\/api\/playback|resolveSource/.test(landscapeFirstModule), 'A22. landscape-first never triggers source resolution');
ok(!/manager\.|dispatchViewportEvent/.test(landscapeFirstModule), 'A23. landscape-first never touches the PlaybackManager (no duplicate resolver requests possible)');

// A24. Resume/selection dependencies byte-preserved (Phase 9 contract): the
//      orientation work cannot skip or reorder the progress chain.
ok(/progressReady && !selectedSourceId && sourceOptions\.length/.test(watchPage), 'A24. source selection still waits for the saved progress record');
ok(/progressReady && selectedSourceId && resolutionState === 'idle'/.test(watchPage), 'A25. resolver still starts exactly once per selected source');

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
const cleanupStart = shell.indexOf('return () => {', shell.indexOf('window.addEventListener(\'blur\', handleWindowBlur);'));
const cleanupBody = shell.slice(cleanupStart, cleanupStart + 1600);
ok(/if \(hideTimer\) clearTimeout\(hideTimer\)/.test(cleanupBody), 'B14. inactivity timer cleared on destroy');
ok(/orientationMediaQuery\.removeEventListener\('change', handleOrientationChange\)/.test(cleanupBody), 'B15. orientation profile listener removed on destroy (no leak across watch-route mounts)');
ok(/window\.removeEventListener\('keydown', handleKeydown\)/.test(cleanupBody) && /window\.removeEventListener\('blur', handleWindowBlur\)/.test(cleanupBody) && /document\.removeEventListener\('focusin', handleFocusIn\)/.test(cleanupBody), 'B16. keydown + iframe-blur + focusin listeners removed on destroy');

// B16b. Touch recovery path for cross-origin embeds: tapping the iframe
// takes focus → the parent window fires `blur` with the iframe as
// activeElement — the only honest cross-origin-safe tap signal. Non-iframe
// blurs (tab switches) are filtered; the iframe DOM is never touched.
ok(/const handleWindowBlur = \(\) => \{\s*const active = document\.activeElement;\s*if \(active instanceof HTMLIFrameElement && playerRoot\?\.contains\(active\)\) revealControls\(\);/.test(shell), 'B16b. iframe-tap (window blur + activeElement iframe) reveals the controls — touch recovery path for embeds');
ok(/window\.addEventListener\('blur', handleWindowBlur\)/.test(shell), 'B16c. blur activity signal registered once in onMount');
ok(!shell.includes('contentWindow.addEventListener') && !shell.includes('iframe.contentDocument'), 'B16d. the blur path never touches the cross-origin iframe DOM');

// B17. Sheet/focus guards: an open sheet or focused control is never hidden.
ok(/!sourceMenuOpen && !episodeMenuOpen && !focusWithinMaveroControls\(\)/.test(revealBody), 'B17. sheet-open + keyboard-focus guards inside the timer callback');
ok(/\.back-fab, \.control-fab-group, \.source-chip, \.direct-controls-overlay, \.source-sheet, \.episode-sheet/.test(shell), 'B18. focus guard covers every Mavero-owned control surface');

// ============================================================================
// §C Source chip — compact closed sizing
// ============================================================================
section_ok('§C source chip');

ok(/\.source-chip \{[^}]*background: transparent/.test(shell), 'C1. closed chip paints NO wide translucent slab (button surface transparent)');
ok(/\.source-chip-bar \{[^}]*width: 5px/.test(shell), 'C2. visible affordance stays the ~5px bar (reference: 4-6px)');
ok(/\.source-chip-bar \{[^}]*background: rgba\(0,0,0,\.55\)/.test(shell) && /\.source-chip-bar \{[^}]*backdrop-filter: blur\(12px\)/.test(shell), 'C3. dark translucent surface carried by the bar itself');
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
ok(/\$: backControlStyle = controlsPlacementInlineStyle\(resolveControlPlacement\(activeSourceOption\?\.controlsPosition \?\? null, 'back', playerOrientation\)\)/.test(shell), 'D22. back FAB placement derived from the ACTIVE source per orientation');
ok(/<button class="back-fab"[^>]*style=\{backControlStyle\}/.test(shell), 'D23. back FAB carries its per-source placement style');
ok(!/style=\{landscapeControlStyle\} type="button" aria-label=\{landscapeMode/.test(shell), 'D24. landscape FAB carries NO duplicate inline style');

// D25. Admin draft model: two controls × two orientations, per-control +
//      per-orientation resets, reset-all, JSON payload contract.
ok(/type ControlsControlDraft = \{ portrait: ControlsProfileDraft; landscape: ControlsProfileDraft \}/.test(adminPage), 'D25. Admin draft model has independent portrait/landscape profiles');
ok(/landscapeControl: emptyControlDraft\(\),\s*back: emptyControlDraft\(\)/.test(adminPage), 'D26. Admin draft covers BOTH controls independently');
ok(/function resetControlProfile\(control: 'landscapeControl' \| 'back', orientation: 'portrait' \| 'landscape'\)/.test(adminPage), 'D27. per-control per-orientation reset exists');
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

console.log('MAVP-2 player bug-fix regression tests passed:');
console.log('  §A landscape-first: 25 checks (click-time presentation on all four entry points, shell adoption, no duplicate orientation requests, no iframe reload, resume chain intact)');
console.log('  §B auto-hide: 18 checks (embed-session arming root cause, embed-load arming, TV/keyboard activity, deadline protected from media events, full cleanup)');
console.log('  §C source chip: 11 checks (bar-carried surface, transparent hit area, content-aware truncated label, no layout shift)');
console.log('  §D positioning profiles: 31 checks (parser totals, control/orientation/axis isolation, renderer contract, Admin draft + resets)');
console.log('  §E admin validation: 18 checks (exact reported error reproduced + fixed via JSON contract, strict server gate, legacy compatibility, store/reload round-trip)');
console.log('  §F protected behavior: 8 checks (sandbox pipeline, resolver guards, PiP, keyboard contract)');
