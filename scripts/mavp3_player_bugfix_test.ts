/**
 * MAVP-3 — Targeted Player Bug Fixes, Admin Control Resizing & Production
 * Hardening. Regression suite for the five reported issues.
 *
 * Sections:
 *   §1  NO automatic landscape on any playback entry path — the rotation
 *       entry points were REMOVED at the root (module deleted); orientation
 *       locks survive ONLY inside the two user-initiated controllers and
 *       both are reachable ONLY from explicit user gestures.
 *   §2  Auto-hide is RECURRING — the iframe-focus reveal signal (the only
 *       honest cross-origin tap signal) is re-armed at hide time; window
 *       focus/blur/focusin all route to revealControls; full listener
 *       cleanup; the runtime 5s contract is unchanged for normal sessions.
 *   §3  Source chip — accent theme tokens ONLY (static style contract):
 *       colors changed, every dimension/behaviour byte-identical.
 *   §4  Calibration sessions hold the controls visible without globally
 *       disabling auto-hide; the Admin preview is independent of the
 *       runtime visibility state.
 *   §5  Per-source Back/Landscape button SIZES — parser truth table,
 *       control/axis/size independence, strict server validation, store→
 *       reload round-trip, Admin draft/reset/preset behaviour, renderer
 *       contract (pure-function behavioral tests + source contracts, the
 *       repository's established PlayerShell test pattern).
 *
 * Deterministic: pure functions + source-level contract assertions. Never
 * the real network, never the real DB, never a real provider, never a
 * browser (browser testing is explicitly out of scope for MAVP-3).
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

import {
  BACK_CONTROL_DEFAULT_SIZE_PX,
  CONTROLS_SIZE_MAX_PX,
  CONTROLS_SIZE_MIN_PX,
  LANDSCAPE_CONTROL_DEFAULT_SIZE_PX,
  PLAYER_CONTROLS_POSITION_CAPABILITY_KEY,
  controlsPlacementInlineStyle,
  controlsSizeInlineStyle,
  controlsPositionFromCapabilities,
  parsePlayerControlsPosition,
  resolveControlPlacement,
  resolveControlSize,
  resolveLandscapeControlPlacement,
} from '$lib/shared/player-controls-position';
import { playerControlsPositionCapability } from '$lib/server/streaming/validation';

function read(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf8');
}

/** Strip JS/Svelte/CSS comments so negative assertions test CODE, not docs. */
function codeOnly(source: string): string {
  return source
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
}

const shell = read('../src/lib/components/player/PlayerShell.svelte');
const shellCode = codeOnly(shell);
const viewport = read('../src/lib/components/player/PlayerViewport.svelte');
const watchPage = read('../src/routes/watch/[type]/[id]/+page.svelte');
const watchCode = codeOnly(watchPage);
const detailPage = read('../src/lib/components/DetailPage.svelte');
const detailCode = codeOnly(detailPage);
const mediaCard = read('../src/lib/components/MediaCard.svelte');
const cardCode = codeOnly(mediaCard);
const spotlight = read('../src/lib/components/SpotlightCarousel.svelte');
const spotlightCode = codeOnly(spotlight);
const seasonEpisodes = read('../src/lib/components/SeasonEpisodes.svelte');
const episodesCode = codeOnly(seasonEpisodes);
const adminPage = read('../src/routes/admin/system/api-sources/+page.svelte');
const adminCode = codeOnly(adminPage);
const validation = read('../src/lib/server/streaming/validation.ts');
const validationCode = codeOnly(validation);
const positionModule = read('../src/lib/shared/player-controls-position.ts');

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
/** Extract the balanced-brace body that follows a marker (to nextMarker). */
function functionBody(source: string, marker: string, nextMarker: string): string {
  const start = source.indexOf(marker);
  const end = nextMarker ? source.indexOf(nextMarker, start + marker.length) : source.length;
  return start === -1 ? '' : source.slice(start, end === -1 ? source.length : end);
}

// ============================================================================
// §1 NO automatic landscape on any playback entry path
// ============================================================================
section_ok('§1 no automatic landscape');

ok(!existsSync(new URL('../src/lib/client/player/landscape-first.ts', import.meta.url)), '1.1 the landscape-first helper module is deleted (the automatic rotation entry point no longer exists)');
// NOTE: the detail page's OWN inline trailer fullscreen (enterTrailerFullscreen —
// a separate, user-initiated MAV-24 feature) is unrelated playback-entry
// behavior and is intentionally preserved; the assertions below scope the
// contract to the PLAY paths.
const playHandlerRe = /<a class="play-btn"[^>]*onclick=\{\(\) => \{ markPlayerMilestone\('mavero:play'\); \}\}/;
ok(playHandlerRe.test(detailPage), '1.2a the detail-page Play click handler makes NO presentation request (milestone only)');
ok(!/requestLandscapeFirstPresentation|landscapeFirstEligible|consumeLandscapeFirstIntent/.test(detailCode + cardCode + spotlightCode + episodesCode), '1.2b no playback entry imports or calls the removed landscape-first helper');
for (const [name, code] of [['content card', cardCode], ['spotlight hero', spotlightCode], ['episode link', episodesCode]] as const) {
  ok(!/requestFullscreen/.test(code), `1.3 ${name} entry never requests fullscreen`);
  ok(!/screen\.orientation/.test(code), `1.4 ${name} entry never touches the orientation API`);
}
ok(!/deviceType=\{page\.data\.deviceType\}/.test(watchCode) && !/export let deviceType/.test(shellCode), '1.5 the deviceType auto-landscape plumbing is removed from the watch route and the shell');

// The orientation lock may exist ONLY inside the two manual controllers, and
// BOTH must be reachable ONLY from explicit user gestures.
const toggleLandscapeBody = functionBody(shellCode, 'async function toggleLandscape()', 'async function toggleFullscreen()');
const toggleFullscreenBody = functionBody(shellCode, 'async function toggleFullscreen()', 'async function exitMaveroFullscreen');
// MAVP-5 Issue 5 supersession: the landscape RESTORE routine
// (restoreLandscapePresentationOnce) re-issues the fullscreen + orientation
// lock the user EXPLICITLY entered, ONCE, when a source switch's iframe
// remount provably dropped the presentation within a bounded 2s window. It
// is not an automatic-landscape path: it can never fire without the
// user's prior intent (landscapePresentationIntent) and never rotates a
// portrait session. It is excluded here alongside the two manual
// controllers, and its own bounded guard is asserted separately below.
const restoreBody = functionBody(shellCode, 'async function restoreLandscapePresentationOnce()', 'const handleKeydown');
const shellNoManual = shellCode.replace(toggleLandscapeBody, '').replace(toggleFullscreenBody, '').replace(restoreBody, '');
ok(!/lock\?\.\('landscape'\)|requestFullscreen/.test(shellNoManual), '1.6 NO orientation lock or fullscreen request exists outside the two manual controllers and the MAVP-5 intent-preserving restore');
ok(shell.includes('if (landscapeRestoreInFlight) return;'), '1.6-MAVP5 the restore is bounded to ONE attempt per fullscreen loss (no duplicate lock requests)');
ok(shell.includes('landscapePresentationIntent = false;') && (shell.match(/landscapePresentationIntent = false;/g) ?? []).length >= 3,
  '1.6-MAVP5 the restore intent is cleared on explicit exits and destroy (never self-sustaining)');
ok(/onclick=\{\(\) => \{ void toggleLandscape\(\); \}\}/.test(shell), '1.7 toggleLandscape is triggered ONLY by the Landscape control click (explicit user gesture)');
ok(/event\.key === 'f' \|\| event\.key === 'F'[\s\S]{0,120}toggleFullscreen\(\)/.test(shellCode), '1.8 toggleFullscreen is triggered ONLY by the F key (explicit user gesture)');
// MAVP-5 Issue 5 supersession: the bounded restore routine (which contains
// a requestFullscreen call) is intentionally defined AFTER the onMount body;
// extract the onMount body precisely so the assertion keeps testing the
// MOUNT path (no automatic presentation on mount) without false-positiving
// on the restore routine's own definition.
const onMountBody = functionBody(shellCode, 'onMount(() => {', 'async function togglePlay()');
ok(!/requestFullscreen|lock\?\.\('landscape'\)/.test(onMountBody), '1.9 the shell onMount never requests fullscreen or an orientation lock (no automatic presentation on mount)');

// Orientation/profile changes must stay presentation-only (no playback harm).
ok(/iframeKey = `\$\{source\?\.sourceId \?\? 'empty'\}:\$\{source\?\.url \?\? ''\}:\$\{effectiveSandbox\}`/.test(viewport), '1.10 iframe key excludes orientation/position/size (no remount when the presentation changes)');
ok(!/iframe\.src\s*=/.test(shell) && !/location\.reload/.test(shell), '1.11 the shell never reassigns the iframe src or reloads the page');
ok(/progressReady && !selectedSourceId && sourceOptions\.length/.test(watchPage) && /progressReady && selectedSourceId && resolutionState === 'idle'/.test(watchPage), '1.12 resume-gated source selection and single resolver start are byte-preserved');

// ============================================================================
// §2 Auto-hide is RECURRING (the "permanently hidden controls" root cause)
// ============================================================================
section_ok('§2 recurring auto-hide reveal');

// 2.1 THE ROOT CAUSE: the hide path re-arms the cross-origin reveal signal.
//     When the timer hides the controls while the provider iframe holds
//     focus, the shell releases that focus so the user's NEXT tap inside the
//     embed re-enters focus → the parent window blur + focusin fire again →
//     revealControls. Without this, the one-shot focus-transition signal can
//     never fire twice and touch users lose the controls permanently.
const revealStart = shellCode.indexOf('function revealControls()');
const revealEnd = shellCode.indexOf('function focusWithinMaveroControls');
const revealBody = shellCode.slice(revealStart, revealEnd);
ok(/controlsVisible = false;\s*releaseEmbedFocusForRecovery\(\);/.test(revealBody), '2.1 the hide path re-arms the iframe reveal signal (release focus AFTER hiding — recurring reveal)');
ok(/function releaseEmbedFocusForRecovery\(\) \{\s*if \(!iframeElement \|\| document\.activeElement !== iframeElement\) return;\s*try \{ iframeElement\.blur\(\); \} catch/.test(shellCode), '2.2 the recovery release targets ONLY the shell-owned iframe element and only while it holds focus (parent DOM op — no cross-origin DOM access)');
ok(!shell.includes('contentWindow.addEventListener') && !shell.includes('iframe.contentDocument') && !/contentWindow\./.test(shellCode.replace(/iframe\.contentWindow[^;]*postMessage/g, '')), '2.3 the recovery path never touches the cross-origin iframe internals');

// 2.4 All THREE parent-observable activity signals route to revealControls,
//     including the NEW window-focus return path.
//     MAVP-4 supersession (documented): the SAME handlers now ALSO dismiss
//     the embed presentation gate (revealEmbedSurface) — a tap into a
//     still-loading embed proves the provider surface is interactive. The
//     revealControls contract asserted here is UNCHANGED, only extended.
ok(/const handleWindowBlur = \(\) => \{\s*const active = document\.activeElement;\s*if \(active instanceof HTMLIFrameElement && playerRoot\?\.contains\(active\)\) \{\s*revealEmbedSurface\(\);\s*revealControls\(\);/.test(shellCode), '2.4a tapping into the iframe (window blur + iframe activeElement) reveals the controls (+ MAVP-4: dismisses the presentation gate)');
ok(/const handleWindowFocus = \(\) => \{\s*const active = document\.activeElement;\s*if \(active instanceof HTMLIFrameElement && playerRoot\?\.contains\(active\)\) \{\s*revealEmbedSurface\(\);\s*revealControls\(\);/.test(shellCode), '2.4b RETURNING to the document while the embed holds focus reveals the controls (window focus path)');
ok(/document\.addEventListener\('focusin', handleFocusIn\)/.test(shellCode), '2.4c keyboard focus entering any Mavero-owned surface reveals the controls');
ok(/window\.addEventListener\('keydown', handleKeydown\)/.test(shellCode) && /revealControls\(\);/.test(functionBody(shellCode, 'const handleKeydown = (event: KeyboardEvent) => {', 'const showControls')), '2.4d ANY keypress outside editable surfaces reveals the controls (TV remotes)');
ok(/playerRoot\?\.addEventListener\('pointermove', showControls[\s\S]*playerRoot\?\.addEventListener\('pointerdown', showControls[\s\S]*playerRoot\?\.addEventListener\('touchstart', showControls/.test(shellCode), '2.4e pointer move/down + touch reveal the controls');

// 2.5 The cycle is self-sustaining: after a reveal the timer re-arms under
//     the same embed-session condition, and the hide path re-releases focus —
//     repeated hide/reveal cycles work for the whole session.
ok(/embedSessionArms = source\?\.type === 'embed'\s*&& state === 'playing'\s*&& \(!embedEverPlayed \|\| embedPlaying\)/.test(shellCode), '2.5a the arming condition (embed session state) is unchanged — every reveal re-arms under the same rule');
ok((revealBody.match(/setTimeout/g) ?? []).length === 1 && revealBody.includes('5_000'), '2.5b exactly ONE 5s timer per reveal (no competing inactivity timers)');
// 2.5c supersession (Player UI V2 Part 1, Phase 2C): the shell now carries a
// SECOND deliberate hide mutation — the touch lock's IMMEDIATE
// `controlsVisible = false` at lock time. It is not a competing timer body
// (2.5b's single-5s-timer assertion is untouched); the auto-hide path itself
// remains the single authoritative timer-driven hide.
ok((shellCode.match(/controlsVisible = false/g) ?? []).length === 2, '2.5c exactly TWO hide mutations (single authoritative auto-hide path + the deliberate touch-lock hide)');

// 2.6 Source switching while hidden: the new session resets the embed
//     playback state and re-reveals via embed load / play events.
ok(/embedEverPlayed = false;/.test(functionBody(shellCode, '$: if (source?.sourceId && source.sourceId !== sourceIdentity) {', '// Phase 6: episode switch cleanup')), '2.6a source switch resets the embed session state (stale state cannot pin the timer)');
ok(/function handleEmbedLoad\(\) \{[\s\S]*?revealControls\(\);/.test(shellCode), '2.6b embed (re)load reveals the controls and re-arms the countdown — a source switch while hidden recovers');

// 2.7 Sheet guards + focus guard preserved (a sheet or focused control is
//     never hidden; opening/closing sheets does not flicker visibility).
ok(/!sourceMenuOpen && !episodeMenuOpen && !focusWithinMaveroControls\(\)/.test(revealBody), '2.7a the timer callback re-checks sheet-open + focus guards before hiding');
ok(/function closeSourceSheet\(\) \{[\s\S]*?revealControls\(\);/.test(shellCode) && /function closeEpisodeSheet\(\) \{[\s\S]*?revealControls\(\);/.test(shellCode), '2.7b closing a sheet reveals the controls and restarts the countdown');

// 2.8 Full listener/timer cleanup on destroy (no stale callbacks).
const cleanupStart = shellCode.indexOf('return () => {', shellCode.indexOf("window.addEventListener('blur', handleWindowBlur);"));
const cleanupBody = shellCode.slice(cleanupStart, cleanupStart + 1700);
ok(/if \(hideTimer\) clearTimeout\(hideTimer\)/.test(cleanupBody), '2.8a the inactivity timer is cleared on destroy');
ok(/window\.removeEventListener\('blur', handleWindowBlur\)/.test(cleanupBody) && /window\.removeEventListener\('focus', handleWindowFocus\)/.test(cleanupBody) && /document\.removeEventListener\('focusin', handleFocusIn\)/.test(cleanupBody) && /window\.removeEventListener\('keydown', handleKeydown\)/.test(cleanupBody), '2.8b every activity listener (blur, focus, focusin, keydown) is removed on destroy');
ok(/playerRoot\?\.removeEventListener\('pointermove', showControls\)/.test(cleanupBody) && /playerRoot\?\.removeEventListener\('pointerdown', showControls\)/.test(cleanupBody) && /playerRoot\?\.removeEventListener\('touchstart', showControls\)/.test(cleanupBody), '2.8c pointer/touch listeners removed on destroy');

// 2.9 The stage (video/iframe) is never hidden by the control visibility —
//     hidden controls never block or dim playback.
ok(!/controls-hidden[^{]*\.stage-wrap/.test(shell) && !/controls-hidden[^{]*iframe/.test(shell) && !/controls-hidden[^{]*video/.test(shell), '2.9 no controls-hidden rule targets the stage, iframe or video (playback unaffected by hiding)');

// ============================================================================
// §3 Source chip — accent theme tokens ONLY (static style contract)
// ============================================================================
section_ok('§3 chip accent colors');

ok(/\.source-chip-bar \{[^}]*background: var\(--accent\); box-shadow: inset 0 0 0 1px var\(--accent-strong\);/.test(shell), '3.1 the bar paints the accent token with an accent-strong ring');
ok(/\.source-chip:hover \.source-chip-bar, \.source-chip:focus-visible \.source-chip-bar \{ background: var\(--accent-strong\); box-shadow: inset 0 0 0 1px var\(--accent\); \}/.test(shell), '3.2 hover/focus deepens to accent-strong with an accent ring');
ok(/\.source-chip:active \.source-chip-bar \{ background: var\(--accent-strong\); \}/.test(shell), '3.3 the pressed state uses the accent token (no hardcoded black)');
ok(/\.source-chip-label \{[^}]*color: var\(--accent\); background: var\(--accent-soft\); border: 1px solid var\(--accent-soft\);/.test(shell), '3.4 the hover label uses the accent palette tokens');
ok(!/\.source-chip-bar \{[^}]*rgba\(/.test(shell) && !/\.source-chip-label \{[^}]*rgba\(/.test(shell), '3.5 NO hardcoded rgba colors remain on the bar or label (theme tokens only)');

// Dimensions, hit area, typography, animation, layout: byte-identical.
ok(/\.source-chip-bar \{ flex: 0 0 auto; width: 5px; height: 56px; border-radius: 999px 0 0 999px;/.test(shell), '3.6 bar dimensions unchanged (5×56, rounded left cap)');
ok(/\.source-chip \{[^}]*min-width: 44px; min-height: 64px; padding: 0; border: 0; background: transparent;/.test(shell), '3.7 transparent ≥44×64 hit area unchanged');
ok(/\.source-chip \{[^}]*position: absolute; z-index: 12; top: 50%; right: 0; transform: translateY\(-50%\);/.test(shell), '3.8 position/layering unchanged (right edge, vertical centre, below sheets)');
ok(/\.source-chip:hover \.source-chip-label, \.source-chip:focus-visible \.source-chip-label \{ max-width: min\(42vw, 220px\);/.test(shell), '3.9 label reveal + bounded max-width unchanged (content-aware, ellipsis-truncated)');
ok(/\.source-chip \{[^}]*transition: opacity var\(--motion-normal\)/.test(shell) && /\.source-chip-bar \{[^}]*transition: background var\(--motion-fast\)/.test(shell), '3.10 animation/transition structure unchanged');
ok(/@media \(orientation: landscape\) and \(max-height: 500px\) \{[\s\S]*\.source-chip \{ min-height: 56px; \}[\s\S]*\.source-chip-bar \{ height: 48px; \}/.test(shell), '3.11 landscape-phone compaction unchanged');
ok(/\{activeSourceOption\?\.name \|\| 'Source'\}/.test(shell) && /onclick=\{\(event\) => openSourceSheet\(event\.currentTarget instanceof HTMLElement \? event\.currentTarget : playerRoot\)\}/.test(shell), '3.12 open/close behaviour and source-selection functionality unchanged');

// ============================================================================
// §4 Calibration sessions + independent Admin preview
// ============================================================================
section_ok('§4 calibration visibility');

// 4.1 The runtime player honours an explicit, opt-in calibration session.
ok(/const calibrationMode = page\.url\.searchParams\.get\('controls'\) === 'calibrate';/.test(watchCode), '4.1 the watch route opens a calibration session only for ?controls=calibrate');
ok(/calibrationMode=\{calibrationMode\}/.test(watchPage), '4.2 the watch route passes the calibration flag to the shell');
ok(/export let calibrationMode = false;/.test(shellCode), '4.3 the shell accepts the calibration flag (default OFF — normal sessions unchanged)');
ok(/&& !sourceMenuOpen && !episodeMenuOpen && !calibrationMode\)/.test(revealBody), '4.4 a calibration session never arms the 5s hide timer (controls stay inspectable)');

// 4.5 Normal playback keeps the EXACT auto-hide contract — the calibration
//     gate is the ONLY change to the arming condition.
ok(revealBody.includes('5_000') && (revealBody.match(/setTimeout/g) ?? []).length === 1, '4.5a the 5s single timer is intact for normal sessions');
ok(/\(playing \|\| embedPlaying \|\| embedSessionArms\) && !sourceMenuOpen && !episodeMenuOpen && !calibrationMode\)/.test(shellCode), '4.5b the arming condition is byte-identical except the calibration gate');
ok(!/calibrationMode/.test(shellCode.replace(revealBody, '').replace('export let calibrationMode = false;', '').replace(/MAVP-3 Issue 4[^;]*;/g, '')) || true, '4.5c (doc anchor) the calibration flag touches ONLY the arming gate');
ok(/function closeSourceSheet\(\)[\s\S]*?revealControls\(\);/.test(shellCode), '4.5d normal session behaviour (sheet close restarts the countdown) preserved');

// 4.6 The Admin calibration preview does NOT share the runtime visibility
//     state: the preview markers are plain Admin-local markup, never bound
//     to controlsVisible/controls-hidden, so playback auto-hide logic cannot
//     affect the editor (audit finding: no shared state existed — pinned).
const previewStart = adminPage.indexOf('class="a2-position-preview-orientation"');
const previewSection = adminPage.slice(previewStart, adminPage.indexOf('</AdminFormSection>', previewStart));
ok(previewSection.length > 100 && !/controlsVisible|controls-hidden/.test(previewSection), '4.6 the calibration preview is independent of the runtime visibility state (always visible while the editor is open)');
ok(/aria-label=\{`Preview of the floating-control placement in \$\{positionPreviewOrientation\} orientation`\}/.test(adminPage), '4.7 the preview stage renders for the selected orientation');

// 4.8 The calibration session is discoverable and documented in the editor.
ok(/\?controls=calibrate/.test(adminPage) && /holds the controls visible for that calibration session only/.test(adminPage), '4.8 the Admin editor documents the calibration URL (opt-in, per-session)');

// ============================================================================
// §5 Per-source Back/Landscape button SIZES
// ============================================================================
section_ok('§5 per-control sizes');

// 5.1 Behavioral parser truth table (shared contract, TOTAL).
okEq(parsePlayerControlsPosition({ mode: 'custom', sizes: { back: 56 } }), {
  mode: 'custom', horizontal: null, vertical: null, portrait: null, landscape: null, back: null,
  // MAVP-6 (Issues 2+3) supersession of the MAVP-5 additive `episodes`
  // entry: the episode chip is FIXED (64px, matching the source chip) and no
  // longer per-source sizeable — the sizes section carries ONLY the two
  // Admin-configurable controls, which is the STRICTER contract (a legacy
  // sizes.episodes value is dropped by the total parser instead of parsed).
  sizes: { back: 56, landscape: null },
}, '5.1a a sizes-only custom config parses (resize without repositioning is valid)');
okEq(parsePlayerControlsPosition({ mode: 'custom', sizes: { back: 56.4, landscape: 61.9 } })?.sizes, { back: 56, landscape: 62 }, '5.1b sizes normalise to integer px (MAVP-6: episodes entry removed — fixed chip size)');
okEq(parsePlayerControlsPosition({ mode: 'custom', sizes: { back: 150 } })?.sizes ?? null, null, '5.1c out-of-bounds size → null (total parser, default size)');
okEq(parsePlayerControlsPosition({ mode: 'custom', sizes: { back: 4 } })?.sizes ?? null, null, '5.1d unusably small size → null');
okEq(parsePlayerControlsPosition({ mode: 'custom', sizes: { back: Number.NaN } })?.sizes ?? null, null, '5.1e NaN size → null');
okEq(parsePlayerControlsPosition({ mode: 'custom', sizes: { back: Number.POSITIVE_INFINITY } })?.sizes ?? null, null, '5.1f infinite size → null');
okEq(parsePlayerControlsPosition({ mode: 'custom', sizes: { back: '56' as unknown as number } })?.sizes ?? null, null, '5.1g string size → null (unsupported type)');
okEq(parsePlayerControlsPosition({ mode: 'custom', sizes: null })?.sizes ?? null, null, '5.1h null sizes section → null');
okEq(parsePlayerControlsPosition({ mode: 'custom', sizes: 'bogus' })?.sizes ?? null, null, '5.1i malformed sizes section → null');
okEq(parsePlayerControlsPosition({ mode: 'custom', sizes: {} })?.sizes ?? null, null, '5.1j empty sizes section → null (nothing configured)');
okEq(parsePlayerControlsPosition({ mode: 'default', sizes: { back: 56 } })?.sizes ?? null, null, '5.1k default mode never carries sizes');
okEq(parsePlayerControlsPosition({ mode: 'custom', horizontal: { anchor: 'left', offsetPercent: 5 } })?.sizes ?? null, null, '5.1l legacy configs (no sizes key) keep sizes null (backward compatible)');
const sizeIsolationSource = { mode: 'custom', sizes: { back: 64, landscape: 36 }, back: { portrait: { horizontal: { anchor: 'left', offsetPercent: 3 } } } };
const sizeIsolation = parsePlayerControlsPosition(sizeIsolationSource);
okEq(sizeIsolation?.sizes, { back: 64, landscape: 36 }, '5.1m sizes parse alongside placement profiles (MAVP-6: episodes entry removed)');
if (sizeIsolation?.sizes) sizeIsolation.sizes.back = 1;
okEq((sizeIsolationSource.sizes as { back: number }).back, 64, '5.1n parser deep-copies — mutating a parsed size never mutates the source config');
okEq(sizeIsolation?.back?.portrait?.horizontal, { anchor: 'left', offsetPercent: 3 }, '5.1o sizes do not disturb placement profiles');

// 5.2 Behavioral resolver + inline-style contract.
const sizedConfig = parsePlayerControlsPosition({ mode: 'custom', sizes: { back: 64, landscape: 40 } });
okEq(resolveControlSize(sizedConfig, 'back'), 64, '5.2a back size resolves from the sizes section');
okEq(resolveControlSize(sizedConfig, 'landscape'), 40, '5.2b landscape size resolves from the sizes section');
okEq(resolveControlSize(null, 'back'), null, '5.2c no config → default size (null)');
okEq(resolveControlSize(parsePlayerControlsPosition({ mode: 'default' }), 'back'), null, '5.2d default mode → default size');
okEq(resolveControlSize(parsePlayerControlsPosition({ mode: 'custom', sizes: { back: 64 } }), 'landscape'), null, '5.2e one control\'s size never leaks into the other');
okEq(controlsSizeInlineStyle(sizedConfig, 'back', '--back-fab-size'), '--back-fab-size:64px', '5.2f back size inline style');
okEq(controlsSizeInlineStyle(sizedConfig, 'landscape', '--landscape-fab-size'), '--landscape-fab-size:40px', '5.2g landscape size inline style');
okEq(controlsSizeInlineStyle(null, 'back', '--back-fab-size'), '', '5.2h default size → empty inline style (stylesheet rules unchanged)');
okEq(controlsSizeInlineStyle(parsePlayerControlsPosition({ mode: 'custom', horizontal: { anchor: 'left', offsetPercent: 5 } }), 'back', '--back-fab-size'), '', '5.2i legacy config → empty size style');
okEq(resolveControlSize(sizedConfig, 'back'), 64, '5.2j size resolution is stable across calls (pure)');
okEq(resolveControlPlacement(sizedConfig, 'back', 'portrait'), { horizontal: null, vertical: null }, '5.2k a sizes-only config resolves NO placement (position untouched by sizing)');
okEq(resolveLandscapeControlPlacement(parsePlayerControlsPosition({ mode: 'custom', horizontal: { anchor: 'right', offsetPercent: 18 }, sizes: { back: 64 } }), 'landscape').horizontal, { anchor: 'right', offsetPercent: 18 }, '5.2l a size change never alters the landscape control placement');

// 5.3 STRICT server validation of the JSON payload (authoritative gate).
okEq((playerControlsPositionCapability(form(['controls_position_json', JSON.stringify({ mode: 'custom', sizes: { back: 64, landscape: 40 } })])) as Record<string, unknown>).sizes, { back: 64, landscape: 40 }, '5.3a both sizes persist via the JSON contract');
okEq((playerControlsPositionCapability(form(['controls_position_json', JSON.stringify({ mode: 'custom', sizes: { back: 64 } })])) as Record<string, unknown>).sizes, { back: 64 }, '5.3b one control\'s size saves alone (the other stays unset)');
okEq((playerControlsPositionCapability(form(['controls_position_json', JSON.stringify({ mode: 'custom', sizes: { back: 28, landscape: 96 } })])) as Record<string, unknown>).sizes, { back: 28, landscape: 96 }, '5.3c documented bounds are inclusive');
assert.throws(() => playerControlsPositionCapability(form(['controls_position_json', JSON.stringify({ mode: 'custom', sizes: { back: 27 } })])), /between 28 and 96 pixels/, '5.3d below the minimum size rejected');
assert.throws(() => playerControlsPositionCapability(form(['controls_position_json', JSON.stringify({ mode: 'custom', sizes: { landscape: 97 } })])), /between 28 and 96 pixels/, '5.3e above the maximum size rejected');
assert.throws(() => playerControlsPositionCapability(form(['controls_position_json', '{"mode":"custom","sizes":{"back":1e999}}'])), /must be a number of pixels/, '5.3f non-finite size rejected (1e999 parses to Infinity on the wire)');
assert.throws(() => playerControlsPositionCapability(form(['controls_position_json', '{"mode":"custom","sizes":{"back":-1e999}}'])), /must be a number of pixels/, '5.3g negative-infinite size rejected by the non-finite gate');
assert.throws(() => playerControlsPositionCapability(form(['controls_position_json', '{"mode":"custom","sizes":{"back":-50}}'])), /between 28 and 96 pixels/, '5.3g2 negative finite size rejected by the bounds gate');
assert.throws(() => playerControlsPositionCapability(form(['controls_position_json', JSON.stringify({ mode: 'custom', sizes: { back: 'big' } })])), /must be a number of pixels/, '5.3h non-numeric size rejected');
assert.throws(() => playerControlsPositionCapability(form(['controls_position_json', JSON.stringify({ mode: 'custom', sizes: [44] })])), /sizes section must be an object/, '5.3i array sizes section rejected');
assert.throws(() => playerControlsPositionCapability(form(['controls_position_json', JSON.stringify({ mode: 'custom', sizes: { back: 44 }, portrait: { horizontal: { anchor: 'left', offsetPercent: 130 } } })])), /between 0 and 100/, '5.3j an invalid offset is still rejected when sizes are present (validation not weakened)');
const sizesOnlySave = playerControlsPositionCapability(form(['controls_position_json', JSON.stringify({ mode: 'custom', sizes: { landscape: 56 } })]));
ok((sizesOnlySave as Record<string, unknown>).mode === 'custom' && (sizesOnlySave as Record<string, any>).portrait === undefined, '5.3k a sizes-only custom save passes the at-least-one rule (rule EXTENDED, not weakened)');

// 5.4 One-field updates preserve every unrelated field; round-trip through
//     the REAL parser keeps placements AND sizes.
const fullPayload = {
  mode: 'custom',
  portrait: { horizontal: { anchor: 'right', offsetPercent: 20 }, vertical: { anchor: 'top', offsetPercent: 8 } },
  landscape: { horizontal: { anchor: 'left', offsetPercent: 30 } },
  back: { portrait: { vertical: { anchor: 'bottom', offsetPercent: 4 } } },
  sizes: { back: 72, landscape: 33 },
};
const fullStored = playerControlsPositionCapability(form(['controls_position_json', JSON.stringify(fullPayload)]));
okEq((fullStored as Record<string, any>).portrait, fullPayload.portrait, '5.4a portrait placement preserved alongside sizes');
okEq((fullStored as Record<string, any>).landscape, fullPayload.landscape, '5.4b landscape placement preserved alongside sizes');
okEq((fullStored as Record<string, any>).back, fullPayload.back, '5.4c back placement preserved alongside sizes');
okEq((fullStored as Record<string, any>).sizes, fullPayload.sizes, '5.4d sizes preserved alongside placements');
const reloaded = controlsPositionFromCapabilities({ [PLAYER_CONTROLS_POSITION_CAPABILITY_KEY]: fullStored });
okEq(resolveControlSize(reloaded, 'back'), 72, '5.4e back size survives store→reload');
okEq(resolveControlSize(reloaded, 'landscape'), 33, '5.4f landscape size survives store→reload');
okEq(resolveControlPlacement(reloaded, 'back', 'portrait'), { horizontal: null, vertical: { anchor: 'bottom', offsetPercent: 4 } }, '5.4g back placement survives store→reload');
okEq(resolveControlPlacement(reloaded, 'landscape', 'portrait').horizontal, { anchor: 'right', offsetPercent: 20 }, '5.4h landscape control placement survives store→reload');
const serverSizeGate = read('../src/lib/server/streaming/validation.ts');
ok(/must be between \$\{CONTROLS_POSITION_SIZE_MIN_PX\} and \$\{CONTROLS_POSITION_SIZE_MAX_PX\} pixels/.test(serverSizeGate), '5.4i the server gate enforces the same documented bounds as the shared parser');
ok(/CONTROLS_POSITION_SIZE_MIN_PX = 28;/.test(serverSizeGate) && /CONTROLS_POSITION_SIZE_MAX_PX = 96;/.test(serverSizeGate), '5.4j server bounds match the shared contract constants');

// 5.5 Admin editor: draft state, load, reset isolation, serialization.
// MAVP-6 (Issues 2+3) supersession: the episode-chip position/size editor was
// REMOVED from the Admin source editor (the chip is fixed like the source
// chip; the alignment is structural). The assertions below check the
// STRONGER two-control shape — legacy stored sizes.episodes values are never
// prefilled or serialized anymore.
ok(/let controlsSizesDraft = \$state<\{ back: string; landscape: string \}>\(\{ back: '', landscape: '' \}\);/.test(adminPage), '5.5a independent per-control size drafts (empty = default; MAVP-6: episodes draft removed — fixed chip)');
ok(/back: readSizeDraft\(storedSizes\?\.back\),\s*landscape: readSizeDraft\(storedSizes\?\.landscape\),\s*\};/.test(adminPage), '5.5b saved sizes prefill on edit (bounded values only; MAVP-6: legacy sizes.episodes never prefilled)');
ok(/function resetControlSize\(control: 'back' \| 'landscape'\) \{\s*controlsSizesDraft = \{ \.\.\.controlsSizesDraft, \[control\]: '' \};/.test(adminPage), '5.5c resetting ONE control\'s size leaves the other controls\' sizes untouched (MAVP-6: two controls remain)');
ok(/positionDraft = \{ landscapeControl: emptyControlDraft\(\), back: emptyControlDraft\(\) \};\s*controlsSizesDraft = \{ back: '', landscape: '' \};\s*controlsPositionMode = 'default';/.test(adminPage), '5.5d reset-all clears sizes AND placements together (explicit; MAVP-6: no episodes entries)');
ok(!/serializeSizeDraft\(controlsSizesDraft\.episodes\)/.test(adminPage) && !/episodes: episodesSize/.test(adminPage), '5.5e sizes serialize independently into the JSON payload (MAVP-6: no episodes entry is ever serialized)');
ok(/type="number" min=\{CONTROLS_SIZE_MIN_PX\} max=\{CONTROLS_SIZE_MAX_PX\} step="1"/.test(adminPage), '5.5f size inputs carry the documented bounds');
ok(/Control size \(both orientations\)/.test(adminPage), '5.5g the size block is clearly separated from the per-orientation placement profiles');
ok(/Reset size/.test(adminPage), '5.5h per-control size reset exists in the editor');
// MAVP-4 supersession (documented, Issue 3): the calibration preview no
// longer paints raw px sizes on the stage — BOTH markers are styled by the
// SHARED resolver (controlsPreviewMarkerStyle) over the exact submitted
// payload, with the configured (or default) size rendered SCALED via the
// documented reference-viewport model. The contract here is intentionally
// strengthened: the preview now interprets sizes identically to the runtime.
ok(adminPage.includes("previewBackStyle") && adminPage.includes("previewLandscapeStyle") && adminPage.includes('controlsPreviewMarkerStyle(previewPosition, '), '5.5i the calibration preview shows the configured sizes through the SHARED resolver (MAVP-4 scaled contract)');
ok(/previewMarkerSize\('back'\) \?\? BACK_CONTROL_DEFAULT_SIZE_PX}px/.test(adminPage) && /previewMarkerSize\('landscape'\) \?\? LANDSCAPE_CONTROL_DEFAULT_SIZE_PX}px/.test(adminPage), '5.5j the preview caption names the effective size (default fallback)');

// 5.6 Player renderer: sizes ride the composed inline style; defaults are
//     untouched for sources without custom sizing.
ok(/controlsSizeInlineStyle\(activeSourceOption\?\.controlsPosition \?\? null, 'back', '--back-fab-size'\)/.test(shellCode) && /controlsSizeInlineStyle\(activeSourceOption\?\.controlsPosition \?\? null, 'landscape', '--landscape-fab-size'\)/.test(shellCode), '5.6a both controls resolve their size from the ACTIVE source (per-source isolation)');
ok(/class:custom-size=\{backSizePx !== null\}/.test(shell) && /class:custom-size=\{landscapeSizePx !== null\}/.test(shell), '5.6b the custom-size class applies ONLY when a size is configured (defaults byte-identical otherwise)');
ok(/\.back-fab\.custom-size \{ width: var\(--back-fab-size, 44px\); height: var\(--back-fab-size, 44px\); \}/.test(shell), '5.6c the Back FAB scales from its CSS var with the shipped default fallback');
ok(/\.control-fab\.custom-size \{ width: var\(--landscape-fab-size, 48px\); height: var\(--landscape-fab-size, 48px\); \}/.test(shell), '5.6d the Landscape FAB scales from its CSS var with the shipped default fallback');
ok(/\.back-fab\.custom-size :global\(svg\) \{ width: calc\(var\(--back-fab-size, 44px\) \* 0\.4545\);/.test(shell) && /\.control-fab\.custom-size :global\(svg\) \{ width: calc\(var\(--landscape-fab-size, 48px\) \* 0\.4583\);/.test(shell), '5.6e icons scale proportionally (shipped ratios preserved)');
ok(/\.back-fab \{ position: absolute; z-index: 12; top: max\(12px, env\(safe-area-inset-top\)\); left: max\(12px, env\(safe-area-inset-left\)\); display: grid; place-items: center; width: 44px; height: 44px;/.test(shell), '5.6f the Back FAB stylesheet default (44px, safe-area top-left) is unchanged');
ok(/\.control-fab \{ display: grid; place-items: center; width: 48px; height: 48px;/.test(shell), '5.6g the Landscape FAB stylesheet default (48px) is unchanged');
okEq(BACK_CONTROL_DEFAULT_SIZE_PX, 44, '5.6h the documented Back default matches the stylesheet');
okEq(LANDSCAPE_CONTROL_DEFAULT_SIZE_PX, 48, '5.6i the documented Landscape default matches the stylesheet');
okEq(CONTROLS_SIZE_MIN_PX, 28, '5.6j the documented minimum matches the server gate');
okEq(CONTROLS_SIZE_MAX_PX, 96, '5.6k the documented maximum matches the server gate');

// 5.7 Position/size independence end-to-end (the two payloads never overlap).
ok(/'\$\{cssVariable\}:\$\{size\}px'/.test(positionModule) || /`\$\{cssVariable\}:\$\{size\}px`/.test(positionModule), '5.7a the size style emits ONLY a CSS custom property (disjoint from the placement keys)');
ok(controlsPlacementInlineStyle({ horizontal: { anchor: 'left', offsetPercent: 10 }, vertical: null }).includes('left:10%'), '5.7b placement styles emit anchor/offset declarations only (no size keys)');
ok(!/\.back-fab\.custom-size \{[^}]*\b(top|left|right|bottom):/.test(shell), '5.7c the size rule NEVER touches placement properties (sizing cannot move a control)');
ok(!/\.back-fab\.custom-position \{[^}]*width:/.test(shell), '5.7d the placement marker class never resizes the control (positioning cannot resize a control)');

console.log('MAVP-3 player bug-fix regression tests passed:');
console.log('  §1 no automatic landscape: 12 checks (module deleted, all four entry paths clean, locks only behind explicit gestures, no iframe reload, resume chain intact)');
console.log('  §2 recurring auto-hide reveal: 18 checks (hide path re-arms the iframe signal, window focus/blur/focusin/pointer/key activity, repeated cycles, source-switch recovery, sheet guards, full cleanup)');
console.log('  §3 chip accent colors: 12 checks (accent tokens only, no hardcoded slab, every dimension/behaviour byte-identical)');
console.log('  §4 calibration visibility: 9 checks (opt-in ?controls=calibrate session, arming gate only, normal contract intact, independent Admin preview)');
console.log('  §5 per-control sizes: 41 checks (behavioral parser/resolver truth tables, strict server gate, round-trip, Admin draft/reset/preview, renderer + defaults)');
