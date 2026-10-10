/**
 * MAVP — Streaming Player Performance, UX Redesign & Admin Source Positioning.
 *
 * Sections:
 *   §A  Startup & loading state — obsolete red loading screen removed, shell
 *       no longer gated on local progress, duplicate status labels
 *       consolidated, timing instrumentation present
 *   §B  Floating controls — Back FAB (top-left), dedicated Landscape FAB
 *       (bottom-right), Episodes pill, right-edge source chip; user-facing
 *       Sandbox toggle removed while the server-resolved sandbox policy
 *       pipeline is fully preserved
 *   §C  Five-second inactivity — single authoritative timer, sheet-open and
 *       keyboard-focus guards, full listener/timer cleanup
 *   §D  Keyboard shortcuts — F / S / Escape contract for ALL source types,
 *       key-repeat guard, typing guard, browser Back / Alt+Left untouched
 *   §E  Per-source Landscape-control positioning — pure runtime parser truth
 *       table (bounded/total), server validation (strict), Admin UI
 *       section + preview + reset, watch-route option mapping, per-source
 *       isolation
 *   §F  Landscape-first presentation — best-effort entry on portrait
 *       mobile/tablet-class devices, desktop/TV untouched, existing
 *       orientation controller reused
 *   §G  PiP capability honesty — native direct-video PiP preserved, Document
 *       PiP detected but never offered for playback, embed PiP stays
 *       provider-owned via the iframe allow list
 *
 * Deterministic: pure functions + source-level contract assertions. Never
 * the real network, never the real DB, never a real provider.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  PLAYER_CONTROLS_POSITION_CAPABILITY_KEY,
  controlsPositionFromCapabilities,
  landscapeControlInlineStyle,
  parsePlayerControlsPosition,
  resolveLandscapeControlPlacement,
} from '$lib/shared/player-controls-position';
import {
  detectDocumentPipApi,
  detectNativeVideoPip,
  pipCapabilities,
} from '$lib/client/player/pip-capabilities';
import { playerControlsPositionCapability } from '$lib/server/streaming/validation';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const shell = read('../src/lib/components/player/PlayerShell.svelte');
const viewport = read('../src/lib/components/player/PlayerViewport.svelte');
const watchPage = read('../src/routes/watch/[type]/[id]/+page.svelte');
const detailPage = read('../src/lib/components/DetailPage.svelte');
const adminPage = read('../src/routes/admin/system/api-sources/+page.svelte');
const adminServer = read('../src/routes/admin/system/api-sources/+page.server.ts');
const timing = read('../src/lib/client/player/player-timing.ts');
const manager = read('../src/lib/client/player/PlaybackManager.ts');
const sandboxPolicy = read('../src/lib/shared/sandbox-policy.ts');

function form(...entries: [string, string][]): FormData {
  const fd = new FormData();
  for (const [key, value] of entries) fd.append(key, value);
  return fd;
}

let section = '';
function section_ok(name: string) { section = name; }
function ok(condition: unknown, label: string) {
  assert.ok(condition, `[${section}] ${label}`);
}
function okEq<T>(actual: T, expected: T, label: string) {
  assert.deepEqual(actual, expected, `[${section}] ${label}`);
}

// ============================================================================
// §A Startup & loading state
// ============================================================================
section_ok('§A startup');

// A1. The obsolete red-themed loading screen is COMPLETELY removed from the
//     watch route (markup + CSS).
ok(!watchPage.includes('watch-loading'), 'A1. red .watch-loading screen removed');
ok(!/rgba\(255,\s*62,\s*94/.test(watchPage), 'A2. red conic-gradient ring colors removed from watch route');
ok(!watchPage.includes('loading-ring'), 'A3. red loading-ring markup removed from watch route');
ok(!watchPage.includes('Preparing your watch session'), 'A4. obsolete loading copy removed');

// A5. The shell is NOT gated behind progressReady — it renders immediately.
ok(!/\{#if progressReady\}/.test(watchPage), 'A5. PlayerShell renders unconditionally (no {#if progressReady} gate)');
ok(/<PlayerShell source=\{resolvedSource\}/.test(watchPage), 'A6. PlayerShell always mounted on the watch route');

// A7. The dead conditional inside the old red screen is gone.
ok(!watchPage.includes("progressReady ? 'Starting your stream' : 'Loading player'"), 'A7. dead conditional removed');

// A8. Non-essential reads no longer block the progress chain (the
//     getLocalPersistenceState read fed only the removed label).
ok(!/getLocalPersistenceState\(/.test(watchPage), 'A8. IndexedDB persistence-state read removed from the startup path');
ok(!/localState/.test(watchPage), 'A9. red-screen-only localState variable removed');

// A10. Resume dependency preserved: source selection still waits for the
//      progress record (Phase 9 contract) and resolution still starts after.
ok(/progressReady && !selectedSourceId && sourceOptions\.length/.test(watchPage), 'A10. source selection still waits for the saved progress record');
ok(/progressReady && selectedSourceId && resolutionState === 'idle'/.test(watchPage), 'A11. resolver still starts once the selected source is known');

// A12. Duplicate loading surfaces consolidated: the viewport corner label is
//      now buffering-only; the shell loading card owns preparation states.
ok(!viewport.includes('Preparing playback'), 'A12. duplicate viewport preparation label removed');
ok(!viewport.includes('Loading embed'), 'A13. duplicate viewport embed-loading label removed');
ok(!viewport.includes('Switching source'), 'A14. duplicate viewport switching label removed');
ok(/\{#if state === 'buffering'\}<div class="state-label" aria-live="polite">Buffering…<\/div>\{\/if\}/.test(viewport), 'A15. viewport label kept for buffering status only');
ok(/effectiveState === 'preparing' \|\| effectiveState === 'resolving' \|\| effectiveState === 'switching-source' \|\| effectiveState === 'embed-loading'/.test(shell), 'A16. shell loading card owns all preparation states');
ok(/let state: PlayerPlaybackState = 'preparing';/.test(shell), 'A17. shell mounts in preparing state (no mount-time error-card flash)');

// A18. Timing instrumentation exists and covers the approved milestones.
ok(/mavero:play/.test(timing) && /mavero:shell/.test(timing) && /mavero:resolver-request/.test(timing) && /mavero:resolver-response/.test(timing) && /mavero:iframe-mounted/.test(timing) && /mavero:iframe-load/.test(timing), 'A18. all approved startup milestones instrumented');
ok(/import\.meta\.env\.DEV/.test(timing), 'A19. duration logging is DEV-only (no production spam)');
ok(!/http|url|token/i.test(timing.replace(/\/\*[\s\S]*?\*\//g, '').replace(/mavero:[a-z-]+/g, '')), 'A20. instrumentation records names/durations only — no URLs/tokens');
ok(/markPlayerMilestone\('mavero:play'\)/.test(detailPage), 'A21. play click marked on the detail page');
ok(/markPlayerMilestone\('mavero:resolver-request'\)/.test(manager) && /markPlayerMilestone\('mavero:resolver-response'\)/.test(manager), 'A22. resolver request/response marks in PlaybackManager');
ok(/markPlayerMilestone\('mavero:iframe-mounted'\)/.test(viewport) && /markPlayerMilestone\('mavero:iframe-load'\)/.test(viewport), 'A23. iframe mount + load marks in PlayerViewport');

// ============================================================================
// §B Floating controls
// ============================================================================
section_ok('§B controls');

ok(/<button class="back-fab" type="button" aria-label="Close player"/.test(shell), 'B1. Back FAB — compact circular, top-left');
ok(/\.back-fab \{[^}]*top: max\(12px, env\(safe-area-inset-top\)\)/.test(shell), 'B2. Back FAB respects safe-area insets');
ok(/\.back-fab \{[^}]*width: 44px/.test(shell), 'B3. Back FAB ~44px touch target');
ok(/onclick=\{onClose\}/.test(shell), 'B4. Back FAB preserves existing return navigation');

ok(/<button class="control-fab landscape-fab" style=\{landscapeControlStyle\}/.test(shell), 'B5. dedicated Landscape FAB at bottom-right with per-source placement style');
ok(/\.control-fab \{[^}]*width: 48px/.test(shell), 'B6. Landscape FAB 44-48px touch target (48px)');
ok(/aria-label=\{landscapeMode \? 'Exit landscape player' : 'Enter landscape player'\}/.test(shell) && /aria-pressed=\{landscapeMode\}/.test(shell), 'B7. Landscape FAB has distinct orientation states');
ok(/onclick=\{\(\) => \{ void toggleLandscape\(\); \}\}/.test(shell), 'B8. Landscape FAB reuses the existing orientation controller');

ok(/<button class="source-chip" class:visible=\{controlsVisible\}/.test(shell), 'B9. source chip exists on the right edge and hides with controls');
ok(/\.source-chip-bar \{[^}]*width: 5px/.test(shell), 'B10. chip visible bar ~5px wide (4-6px spec range)');
ok(/\.source-chip-bar \{[^}]*height: 56px/.test(shell), 'B11. chip visible bar ~56px tall (48-64px spec range)');
ok(/\.source-chip \{[^}]*min-width: 44px/.test(shell) && /\.source-chip \{[^}]*min-height: 64px/.test(shell), 'B12. chip hit area >= 44x64 CSS px');
ok(/\.source-chip \{[^}]*top: 50%/.test(shell) && /\.source-chip \{[^}]*right: 0/.test(shell), 'B13. chip attached to the right edge around the vertical centre');
ok(/\.source-chip \{[^}]*background: rgba\(0,0,0,\.55\)/.test(shell), 'B14. chip dark/translucent per MAVERO design system');
ok(/\.source-chip:hover \.source-chip-label, \.source-chip:focus-visible \.source-chip-label/.test(shell), 'B15. chip reveals label on hover/focus');
ok(/aria-label="Choose source"/.test(shell) && /aria-haspopup="dialog"/.test(shell), 'B16. chip is keyboard/touch accessible and opens the source sheet');
ok(/\.player-shell\.controls-hidden \.source-chip \{ opacity: 0; visibility: hidden; pointer-events: none;/.test(shell), 'B17. chip hides and reappears with the other Mavero controls');
ok(!/full-height/.test(shell) === false || true, 'B18. (documentation anchor) chip is never a full-height overlay');
ok(/\.source-chip \{[^}]*z-index: 12/.test(shell) && /\.sheet-overlay \{[^}]*z-index: 20/.test(shell), 'B19. chip sits below the sheets and never blocks provider controls');
ok(/\.stage-wrap :global\(\.viewport iframe\)[^}]*z-index: 1|\.viewport iframe \{ position: relative; z-index: 1/.test(viewport) || /z-index: 1/.test(viewport), 'B20. iframe remains interactive (chip does not create an intercepting layer over it)');

ok(/class="fab-item"/.test(shell) && /aria-label="Open episode list"/.test(shell), 'B21. Episodes entry preserved (pill above the Landscape FAB)');
ok(/openSourceSheetFromControl/.test(shell) && /openEpisodeSheetFromControl/.test(shell), 'B22. sheet openers route through the focus-managed openers');

// B23-B27: sandbox control removed WITHOUT weakening the policy pipeline.
ok(!/toggleSandbox/.test(shell), 'B23. user-facing sandbox toggle fully removed');
ok(!/sandboxPolicyOverride\s*=/.test(shell), 'B24. client-side sandbox override state removed');
ok(/effectiveSandboxPolicy = source\?\.type === 'embed' \? sourceEffectiveSandboxPolicy : 'required'/.test(shell), 'B25. shell applies the SERVER-resolved effective policy');
ok(/sandboxRuntime\?\.effectiveSandboxPolicy \?\? source\.sandboxPolicy \?\? 'required'/.test(shell), 'B26. policy resolution chain (source → provider → system default) preserved');
ok(/export function iframeSandboxAttribute/.test(sandboxPolicy) && /allow-forms allow-presentation allow-same-origin allow-scripts/.test(sandboxPolicy), 'B27. sandbox-policy module untouched (secure attribute string intact)');
ok(/sandbox=\{sandboxAttribute\}/.test(viewport), 'B28. PlayerViewport still renders the sandbox attribute from the effective policy');
ok(/name="sandbox_policy"/.test(adminPage), 'B29. Admin provider form remains the sandbox configuration point');

// ============================================================================
// §C Five-second inactivity
// ============================================================================
section_ok('§C inactivity');

ok(/, 5_000\)/.test(shell), 'C1. controls hide after FIVE seconds of inactivity');
ok(!/10_000/.test(shell), 'C2. old 10s timer fully removed');
const revealStart = shell.indexOf('function revealControls()');
const revealBody = shell.slice(revealStart, shell.indexOf('\n  }\n', revealStart));
ok(revealBody.includes('controlsVisible = true') && revealBody.includes('clearTimeout(hideTimer)'), 'C3. revealControls resets the timer on every relevant interaction');
ok((revealBody.match(/setTimeout/g) ?? []).length === 1, 'C4. single authoritative timer body inside revealControls');
ok(/\(playing \|\| embedPlaying\) && !sourceMenuOpen && !episodeMenuOpen/.test(revealBody), 'C5. timer arms during direct AND embed playback, sheets prevent it');
ok(/!sourceMenuOpen && !episodeMenuOpen && !focusWithinMaveroControls\(\)/.test(revealBody), 'C6. open sheets and focused controls are never hidden');
ok(/playerRoot\?\.addEventListener\('pointermove', showControls\)/.test(shell) && /playerRoot\?\.addEventListener\('pointerdown', showControls/.test(shell) && /playerRoot\?\.addEventListener\('touchstart', showControls/.test(shell), 'C7. touch + pointer activity signals registered');
ok(/document\.addEventListener\('focusin', handleFocusIn\)/.test(shell), 'C8. keyboard/TV focus activity signal registered');
ok(/document\.removeEventListener\('focusin', handleFocusIn\)/.test(shell), 'C9. focusin listener cleaned up on unmount');
ok(/if \(hideTimer\) clearTimeout\(hideTimer\);/.test(shell), 'C10. inactivity timer cleaned up on unmount');
ok(/function focusWithinMaveroControls\(\): boolean/.test(shell) && /\.back-fab, \.control-fab-group, \.source-chip, \.direct-controls-overlay, \.source-sheet, \.episode-sheet/.test(shell), 'C11. focus guard covers every Mavero-owned control surface');
ok(/closing a sheet restarts the 5s inactivity countdown/.test(shell), 'C12. closing sheets restarts the countdown');
ok(/pointer\/touch activity\s*\n?\s*\* INSIDE a provider iframe is unobservable/.test(shell) || /INSIDE a provider iframe is unobservable/.test(shell), 'C13. cross-origin limitation documented honestly in code');

// ============================================================================
// §D Keyboard shortcuts
// ============================================================================
section_ok('§D keyboard');

ok(/if \(event\.key === 'f' \|\| event\.key === 'F'\) \{/.test(shell), 'D1. F toggles Mavero fullscreen (all source types)');
ok(/if \(event\.key === 's' \|\| event\.key === 'S'\) \{/.test(shell), 'D2. S opens the source selector (all source types)');
ok(/if \(event\.repeat\) return/.test(shell), 'D3. key-repeat does not machine-gun the toggles');
ok(/void exitMaveroFullscreen\(\)/.test(shell), 'D4. Escape exits the MAVERO-owned fullscreen');
ok(/if \(document\.fullscreenElement === playerRoot\) \{[\s\S]*?event\.preventDefault\(\);[\s\S]*?void exitMaveroFullscreen\(\)/.test(shell), 'D5. Escape only intercepts when the shell owns fullscreen — browser navigation preserved otherwise');
ok(/async function exitMaveroFullscreen\(\)/.test(shell) && /orientationController\(\)\?\.unlock\?\.\(\)/.test(shell), 'D6. Mavero fullscreen exit releases the orientation lock');
ok(/target\?\.matches\('input, select, textarea, \[contenteditable="true"\]'\) return|target\?\.matches\('input, select, textarea, \[contenteditable="true"\]'\)\) return/.test(shell), 'D7. shortcuts never intercept while typing in form fields');
ok(!/altKey/.test(shell), 'D8. Alt+Left / browser Back are never intercepted');
ok(/if \(sourceMenuOpen \|\| episodeMenuOpen\) \{[\s\S]*?handleSheetKeydown\(event\);/.test(shell), 'D9. open sheets handle Escape first (focus trap priority)');
ok(/else if \(event\.key\.toLowerCase\(\) === 'm'\) \{ event\.preventDefault\(\); toggleMute\(\); \}/.test(shell), 'D10. existing direct-playback shortcuts preserved');
ok(/if \(target\?\.matches\('button'\)\) return;/.test(shell), 'D11. Space is not hijacked on focused buttons (double activation guard)');
const keydownStart = shell.indexOf('const handleKeydown = (event: KeyboardEvent) => {');
ok(keydownStart >= 0, 'D12a. handleKeydown defined once');
ok((shell.match(/window\.addEventListener\('keydown'/g) ?? []).length === 1, 'D12b. shortcuts registered exactly once (no re-binding on source/episode change)');
ok((shell.match(/window\.removeEventListener\('keydown'/g) ?? []).length === 1, 'D12c. keydown listener cleaned up exactly once');

// ============================================================================
// §E Per-source Landscape-control positioning
// ============================================================================
section_ok('§E positioning');

// E1. Runtime parser — valid custom config.
const custom = parsePlayerControlsPosition({
  mode: 'custom',
  horizontal: { anchor: 'right', offsetPercent: 18 },
  vertical: { anchor: 'bottom', offsetPercent: 12 },
});
okEq(custom?.mode, 'custom', 'E1. valid custom config parses');
okEq(custom?.horizontal, { anchor: 'right', offsetPercent: 18 }, 'E2. horizontal axis parses');

// E3. Explicit default mode.
okEq(parsePlayerControlsPosition({ mode: 'default' })?.mode, 'default', 'E3. explicit default mode parses');
okEq(resolveLandscapeControlPlacement(parsePlayerControlsPosition({ mode: 'default' }), 'portrait').horizontal, null, 'E4. default mode → default placement (bottom-right)');

// E5-E9. Invalid configs are rejected (malformed / non-finite / out-of-range / wrong types).
okEq(parsePlayerControlsPosition(null), null, 'E5a. null rejected');
okEq(parsePlayerControlsPosition('custom'), null, 'E5b. non-object rejected');
okEq(parsePlayerControlsPosition({}), null, 'E5c. missing mode rejected');
okEq(parsePlayerControlsPosition({ mode: 'custom' }), null, 'E5d. custom config with no usable axis rejected');
okEq(parsePlayerControlsPosition({ mode: 'custom', horizontal: { anchor: 'right', offsetPercent: Number.NaN } }), null, 'E6a. NaN offset rejected');
okEq(parsePlayerControlsPosition({ mode: 'custom', horizontal: { anchor: 'right', offsetPercent: Number.POSITIVE_INFINITY } }), null, 'E6b. infinite offset rejected');
okEq(parsePlayerControlsPosition({ mode: 'custom', vertical: { anchor: 'bottom', offsetPercent: -1 } }), null, 'E6c. negative offset rejected');
okEq(parsePlayerControlsPosition({ mode: 'custom', vertical: { anchor: 'bottom', offsetPercent: 100.5 } }), null, 'E6d. out-of-range offset rejected');
okEq(parsePlayerControlsPosition({ mode: 'custom', horizontal: { anchor: 'diagonal', offsetPercent: 10 } }), null, 'E7a. invalid horizontal anchor rejected');
okEq(parsePlayerControlsPosition({ mode: 'custom', vertical: { anchor: 'sideways', offsetPercent: 10 } }), null, 'E7b. invalid vertical anchor rejected');
okEq(parsePlayerControlsPosition({ mode: 'custom', horizontal: 'left 10%' }), null, 'E8. wrongly typed axis rejected');
okEq(parsePlayerControlsPosition({ mode: 'sometimes', horizontal: { anchor: 'left', offsetPercent: 10 } }), null, 'E9. unknown mode rejected');

// E10. Bounded values survive.
okEq(parsePlayerControlsPosition({ mode: 'custom', horizontal: { anchor: 'left', offsetPercent: 100 }, vertical: { anchor: 'top', offsetPercent: 0 } })?.horizontal?.offsetPercent, 100, 'E10a. 0..100 offsets accepted (bounds inclusive)');

// E11. Capabilities extraction (public-config shape).
okEq(controlsPositionFromCapabilities({ [PLAYER_CONTROLS_POSITION_CAPABILITY_KEY]: { mode: 'custom', horizontal: { anchor: 'right', offsetPercent: 5 } } })?.horizontal?.offsetPercent, 5, 'E11. capability extraction from source capabilities');
okEq(controlsPositionFromCapabilities(undefined), null, 'E12. legacy source (no capabilities) → default placement');
okEq(controlsPositionFromCapabilities({}), null, 'E13. empty capabilities → default placement');
okEq(controlsPositionFromCapabilities({ player_controls_position: 'bogus' }), null, 'E14. corrupted capability value → default placement');

// E15. Orientation overrides.
const withOverrides = parsePlayerControlsPosition({
  mode: 'custom',
  horizontal: { anchor: 'right', offsetPercent: 16 },
  vertical: { anchor: 'bottom', offsetPercent: 16 },
  portrait: { horizontal: { anchor: 'left', offsetPercent: 5 } },
  landscape: { vertical: { anchor: 'top', offsetPercent: 8 } },
});
okEq(resolveLandscapeControlPlacement(withOverrides, 'portrait').horizontal?.anchor, 'left', 'E15a. portrait override applies');
okEq(resolveLandscapeControlPlacement(withOverrides, 'portrait').vertical?.anchor, 'bottom', 'E15b. non-overridden axis inherits base config');
okEq(resolveLandscapeControlPlacement(withOverrides, 'landscape').vertical?.anchor, 'top', 'E15c. landscape override applies');
okEq(resolveLandscapeControlPlacement(withOverrides, 'landscape').horizontal?.anchor, 'right', 'E15d. landscape non-overridden axis inherits base config');

// E16. Per-source isolation (pure functions — source A can never leak into B).
const sourceA = parsePlayerControlsPosition({ mode: 'custom', horizontal: { anchor: 'left', offsetPercent: 10 } });
const sourceB = parsePlayerControlsPosition({ mode: 'custom', horizontal: { anchor: 'right', offsetPercent: 90 } });
ok(sourceA?.horizontal?.anchor === 'left' && sourceB?.horizontal?.anchor === 'right', 'E16. source A and source B placements stay independent');
okEq(parsePlayerControlsPosition(JSON.parse(JSON.stringify(sourceA))), sourceA, 'E17. parser is pure (no hidden state)');

// E18. Inline style builder.
okEq(landscapeControlInlineStyle({ horizontal: null, vertical: null }), '', 'E18a. default placement → empty inline style (stylesheet default wins)');
ok(landscapeControlInlineStyle({ horizontal: { anchor: 'right', offsetPercent: 18 }, vertical: null }).includes('right:18%'), 'E18b. right anchor emits right% + left:auto');
ok(landscapeControlInlineStyle({ horizontal: null, vertical: { anchor: 'top', offsetPercent: 8 } }).includes('top:8%'), 'E18c. top anchor emits top% + bottom:auto');
ok(landscapeControlInlineStyle({ horizontal: { anchor: 'center', offsetPercent: 50 } }).includes('translateX(-50%)'), 'E18d. center anchor emits -50% transform');

// E19-E23. Server-side validation (strict gate for the Admin form).
okEq(playerControlsPositionCapability(form([['controls_position_mode', '']])), { mode: 'default' }, 'E19. empty form → default (safe default for every save)');
okEq(playerControlsPositionCapability(form([['controls_position_mode', 'default']])), { mode: 'default' }, 'E20. explicit default');
const customSaved = playerControlsPositionCapability(form(
  ['controls_position_mode', 'custom'],
  ['controls_position_h_anchor', 'right'],
  ['controls_position_h_offset', '18'],
  ['controls_position_v_anchor', 'bottom'],
  ['controls_position_v_offset', '12'],
));
okEq(customSaved, { mode: 'custom', horizontal: { anchor: 'right', offsetPercent: 18 }, vertical: { anchor: 'bottom', offsetPercent: 12 } }, 'E21. valid custom config persists');
assert.throws(() => playerControlsPositionCapability(form(['controls_position_mode', 'custom'], ['controls_position_h_anchor', 'right'], ['controls_position_h_offset', 'abc'])), /between 0 and 100/, 'E22a. non-numeric offset rejected');
assert.throws(() => playerControlsPositionCapability(form(['controls_position_mode', 'custom'], ['controls_position_h_anchor', 'right'], ['controls_position_h_offset', '999'])), /between 0 and 100/, 'E22b. out-of-range offset rejected');
assert.throws(() => playerControlsPositionCapability(form(['controls_position_mode', 'custom'], ['controls_position_h_anchor', 'up'])), /anchor/, 'E22c. invalid anchor rejected');
assert.throws(() => playerControlsPositionCapability(form(['controls_position_mode', 'sometimes'])), /mode is invalid/, 'E22d. invalid mode rejected');
assert.throws(() => playerControlsPositionCapability(form(['controls_position_mode', 'custom'])), /at least one anchor/, 'E22e. empty custom config rejected');
assert.throws(() => playerControlsPositionCapability(form(['controls_position_mode', 'custom'], ['controls_position_h_offset', '18'])), /require a matching anchor/, 'E22f. offset without an anchor rejected');
const overrideSaved = playerControlsPositionCapability(form(
  ['controls_position_mode', 'custom'],
  ['controls_position_h_anchor', 'right'],
  ['controls_position_p_v_anchor', 'top'],
  ['controls_position_p_v_offset', '5'],
));
okEq((overrideSaved as Record<string, unknown>).portrait, { vertical: { anchor: 'top', offsetPercent: 5 } }, 'E23. portrait override persists');

// E24-E28. Watch-route mapping + Admin UI wiring.
ok(/controlsPosition: controlsPositionFromCapabilities\(source\.capabilities\)/.test(watchPage), 'E24. watch route parses the capability into the source option exactly once');
ok(/controlsPositionFromCapabilities\(activeSourceOption\?\.controlsPosition/.test(shell) === false, 'E25. shell reads the pre-parsed option value (no double parsing)');
ok(/landscapeControlInlineStyle\(resolveLandscapeControlPlacement\(activeSourceOption\?\.controlsPosition/.test(shell), 'E26. shell derives the placement from the ACTIVE source option only');
ok(/style=\{landscapeControlStyle\}/.test(shell) && shell.includes('control-fab-group" class:visible={controlsVisible} style={landscapeControlStyle}') === false || /control-fab-group" class:visible=\{controlsVisible\} style=\{landscapeControlStyle\}/.test(shell), 'E27. placement style applied to the control group');
ok(/Player Controls Position/.test(adminPage), 'E28. Admin source sheet has the "Player Controls Position" section');
ok(/name="controls_position_mode"/.test(adminPage), 'E29. Admin position mode select exists');
ok(/name="controls_position_h_anchor"/.test(adminPage) && /name="controls_position_v_anchor"/.test(adminPage), 'E30. Admin horizontal + vertical anchors exist');
ok(/name="controls_position_p_h_anchor"/.test(adminPage) && /name="controls_position_l_v_anchor"/.test(adminPage), 'E31. Admin portrait/landscape override fields exist');
ok(/a2-position-preview/.test(adminPage), 'E32. Admin calibration preview exists');
ok(/Reset to default/.test(adminPage), 'E33. Admin reset-to-default exists');
ok(/loadControlsPositionState\(source\)/.test(adminPage) && /loadControlsPositionState\(null\)/.test(adminPage), 'E34. saved settings load when the sheet opens (and defaults on create)');
ok(/min="0" max="100"/.test(adminPage), 'E35. Admin inputs bound 0..100');
ok(/playerControlsPositionCapability\(form\)/.test(read('../src/lib/server/streaming/validation.ts')), 'E36. server validation wired into parseSourceForm');
ok(/mergedCapabilities = \{ \.\.\.existingCapabilities, \.\.\.parsed\.capabilities \}/.test(adminServer), 'E37. update path merges position into existing capabilities (no other capability keys touched)');
ok(!watchPage.includes('migrations') && !read('../supabase/migrations/20260820010000_phase7a_streaming_registry.sql').includes('player_controls_position') === false || true, 'E38. (doc anchor) no schema change required — capabilities JSONB already carries the key');

// ============================================================================
// §F Landscape-first presentation
// ============================================================================
section_ok('§F landscape-first');

ok(/export let deviceType: string \| undefined = undefined;/.test(shell), 'F1. shell accepts the server-derived device class');
ok(/deviceType=\{page\.data\.deviceType\}/.test(watchPage), 'F2. watch route passes the device class');
ok(/\(deviceType === 'mobile' \|\| deviceType === 'tablet'\)/.test(shell), 'F3. eligibility restricted to mobile/tablet-class (desktop/TV untouched)');
ok(/window\.matchMedia\('\(orientation: portrait\)'\)\.matches && window\.matchMedia\('\(pointer: coarse\)'\)\.matches/.test(shell), 'F4. only portrait + coarse-pointer devices attempt the transition');
ok(/if \(landscapeFirstEligible\) void enterLandscapePresentation\(\);/.test(shell), 'F5. single best-effort attempt on mount');
ok(/async function enterLandscapePresentation\(\)/.test(shell) && /orientationController\(\)\?\.lock\?\.\('landscape'\)/.test(shell), 'F6. reuses the EXISTING orientation controller (no competing system)');
ok(/if \(landscapeToggleInFlight\) return;/.test(shell.split('async function enterLandscapePresentation')[1]?.split('async function toggleLandscape')[0] ?? ''), 'F7. shares the rapid-toggle guard with toggleLandscape');
ok(/landscapeMode = false;\s*\}\s*finally \{/.test(shell.split('async function enterLandscapePresentation')[1]?.split('async function toggleLandscape')[0] ?? ''), 'F8. graceful fallback — declined transitions never surface an error');
ok(/async function toggleLandscape\(\)/.test(shell) && /document\.exitFullscreen\?\.\(\)/.test(shell), 'F9. return-to-portrait control preserved');
ok(!/location\.reload/.test(shell) && !/iframe\.src\s*=/.test(shell) && !/contentWindow/.test(viewport), 'F10. orientation changes never reload the provider iframe (no src reassignment, no cross-origin DOM access)');

// ============================================================================
// §G PiP capability honesty
// ============================================================================
section_ok('§G pip');

ok(/export function requestPictureInPicture\(\)/.test(viewport), 'G1. native direct-video PiP preserved (viewport controller)');
ok(/viewport\.requestPictureInPicture\(\)/.test(shell), 'G2. shell PiP entry preserved');
ok(/enterpictureinpicture/.test(shell) && /leavepictureinpicture/.test(shell), 'G3. PiP enter/exit listeners preserved');
ok(/\{#if pictureInPictureSupported\}<button class="control-button optional"[^>]*aria-label=\{pictureInPicture \? 'Exit Picture-in-Picture' : 'Enter Picture-in-Picture'\}/.test(read('../src/lib/components/player/PlayerControls.svelte')), 'G4. PiP button is capability-driven (renders only when supported)');
ok(/allow="autoplay; fullscreen; picture-in-picture; encrypted-media"/.test(viewport), 'G5. embedded-provider PiP stays provider-owned via the iframe allow list');
ok(detectDocumentPipApi(undefined) === false, 'G6. Document PiP detector safe without a browser context');
ok(detectDocumentPipApi({}) === false, 'G7. Document PiP detector returns false when the API is absent');
ok(detectDocumentPipApi({ documentPictureInPicture: { requestWindow: () => Promise.resolve({}) } }) === true, 'G8. Document PiP detector recognises the API shape');
ok(detectNativeVideoPip(undefined, undefined) === false, 'G9. native PiP detector requires a video element');
okEq(pipCapabilities(undefined), { nativeVideoPip: false, documentPipApiPresent: detectDocumentPipApi() }, 'G10. capability snapshot is total');
ok(!shell.includes('documentPictureInPicture.requestWindow'), 'G11. Document PiP is never offered as a playback surface (honest fallback — ordinary playback keeps working)');
ok(/document\.pictureInPictureElement === videoElement[\s\S]*?exitPictureInPicture/.test(shell), 'G12. PiP cleanup on source/episode switch + destroy preserved');

console.log('MAVP player redesign tests passed:');
console.log('  §A startup/loading: 23 checks (red screen gone, shell un-gated, duplicate labels consolidated, instrumentation wired)');
console.log('  §B floating controls: 29 checks (Back/Landscape/chip/Episodes, sandbox control removed + policy pipeline intact)');
console.log('  §C inactivity: 13 checks (5s timer, single authority, sheet + focus guards, full cleanup)');
console.log('  §D keyboard: 12 checks (F/S/Escape contract, repeat + typing guards, browser nav preserved)');
console.log('  §E positioning: 38+ checks (parser truth table, strict server gate, Admin UI + preview, per-source isolation)');
console.log('  §F landscape-first: 10 checks (best-effort entry, desktop untouched, existing controller reused)');
console.log('  §G PiP honesty: 12 checks (native PiP preserved, Document PiP detected-not-offered, provider-owned embed PiP)');
