/**
 * MAVERO — Round 53: seven player changes, part F (behaviour) — regression suite.
 *
 *   §1 F1 — GESTURE HUD + DESKTOP GESTURES: (a) the brightness/volume HUD is
 *      its own centred pill BELOW the top control row (top edge = top-row
 *      bottom + 12px via the shared --pl-* geometry tokens; ≤260px wide,
 *      40px tall, radius 12, glass, icon + 4px bar + percentage) and FADES
 *      OUT ~600ms after the gesture ends; (b) a desktop WHEEL controller
 *      drives the SAME handlers + SAME HUD (left half = brightness, right
 *      half = volume, ≈2% per notch clamped 0–100, preventDefault so the
 *      page never scrolls under the pointer) and is bound ONLY on
 *      (pointer: fine) devices; (c) mouse CLICKS feed the SAME single-tap
 *      arbitration through pointer events (pointerType 'mouse' only — a
 *      desktop click toggles play/pause exactly like a tap; buttons, chips,
 *      popovers and cards never toggle).
 *
 *   §2 F2 — HOVER-TO-OPEN SHEETS (desktop only): on (hover: hover) and
 *      (pointer: fine), pointing at a chip that opens a sheet opens it after
 *      120ms; leaving BOTH the chip and the open panel closes a
 *      hover-opened sheet after 220ms (round 56 H1: GEOMETRY zone — chip
 *      rect ∪ panel rect, 8px inflated, window pointermove; pointerout
 *      retired); click / keyboard keep working; hover-open never fires
 *      while a gesture is active, while locked, or on touch devices.
 *
 *   §3 F3 — KEYBOARD SHORTCUTS: Space/K → play/pause, ←/→ → ∓10s through
 *      the existing step handlers, ignored while focus is inside an
 *      input/slider/text field or an open sheet; aria-keyshortcuts on the
 *      play (Space) and the two seek (ArrowLeft/ArrowRight) buttons.
 *
 *   §4 F4 — AUTOPLAY ON OPEN: the first playable direct source starts
 *      playback on its own (normal play() → ONE muted retry → stay paused,
 *      never throw, never loop); a user pause within the first second and
 *      an explicit back/forward navigation suppress it.
 *
 *   §5 F5 — BOTTOM ROW ORDER: the left group is −10s, PLAY/PAUSE, +10s,
 *      Volume(+slider) — Play/Pause BETWEEN the two seek buttons.
 *
 *   §6 F6 — RIGHT TIME LABEL TOGGLE: the right-hand time label is a real
 *      button flipping total ↔ remaining ("−MM:SS"), aria-pressed state,
 *      session-only; the left (elapsed) label is unchanged.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { createPlayerTapGestureController, createPlayerWheelController, DOUBLE_TAP_WINDOW_MS, WHEEL_STEP, wheelDelta, wheelZoneForX } from '$lib/client/player/touch/gestures';

const root = resolve(fileURLToPath(import.meta.url), '../..');
const read = (p: string) => readFileSync(resolve(root, p), 'utf-8');

const shell = read('src/lib/components/player/PlayerShell.svelte');
const controls = read('src/lib/components/player/PlayerControls.svelte');
const gestures = read('src/lib/client/player/touch/gestures.ts');

let passed = 0;
let failed = 0;
function ok(condition: unknown, label: string) {
  if (condition) { passed += 1; console.log(`  ok ${passed} - ${label}`); }
  else { failed += 1; console.log(`  FAIL - ${label}`); }
}
const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

// ===========================================================================
// §1 — F1: HUD position/fade + desktop wheel + mouse click gestures.
// ===========================================================================
console.log('\n§1 — F1: gesture HUD below the top row; wheel + mouse click gestures');
{
  // (a) HUD geometry + fade.
  const hudRule = shell.slice(shell.indexOf('.gesture-indicator {'), shell.indexOf('.gesture-indicator.fading'));
  ok(/top: calc\(var\(--pl-chrome-top, max\(16px, env\(safe-area-inset-top\)\)\) \+ var\(--pl-chip-size, 40px\) \+ 12px\)/.test(hudRule), '1a. the HUD top edge = top-row bottom + 12px (shared --pl-chrome-top + --pl-chip-size tokens — it never touches a control row)');
  ok(/left: 50%; transform: translateX\(-50%\)/.test(hudRule), '1b. the HUD is horizontally CENTRED');
  ok(/height: 40px;/.test(hudRule) && /max-width: 260px;/.test(hudRule) && /border-radius: 12px;/.test(hudRule), '1c. the HUD is 40px tall, ≤260px wide, radius 12 (its own pill, glass surface)');
  ok(/class:fading=\{gestureIndicatorFading\} class="gesture-indicator" aria-hidden="true"/.test(shell), '1d. the HUD carries the fade class + stays aria-hidden');
  ok(/\.gesture-indicator\.fading \{ opacity: 0; \}/.test(shell) && /transition: opacity 180ms/.test(shell), '1e. the HUD FADES OUT (opacity transition), never blinks');
  ok(/const GESTURE_HUD_LINGER_MS = 600;/.test(shell), '1f. the fade begins ~600ms after the gesture ends');
  ok(/@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.brightness-overlay, \.gesture-indicator, \.gesture-indicator-bar > span/.test(shell), '1g. reduced motion drops the HUD fade transition');

  // (b) Wheel controller — pure helpers.
  ok(/export const WHEEL_STEP = 0\.02;/.test(gestures), '1h. the wheel step is ≈2% per notch (matches the touch feel)');
  ok(wheelZoneForX(100, 1000) === 'left' && wheelZoneForX(900, 1000) === 'right' && wheelZoneForX(500, 1000) === 'right', '1i. the wheel split is the LEFT half vs the RIGHT half');
  ok(wheelDelta(-100) === WHEEL_STEP && wheelDelta(100) === -WHEEL_STEP && wheelDelta(0) === 0, '1j. wheel up increases, wheel down decreases');
  ok(/createPlayerWheelController\(\{[\s\S]*?onBrightnessDelta: \(delta\) => \{ brightness = clampBrightness\(brightness \+ delta\); \},[\s\S]*?onVolumeDelta: \(delta\) => \{ setVolume\(volume \+ delta\); \},/.test(shell), '1k. the wheel drives the SAME brightness/volume handlers the touch swipe feeds');
  ok(/window\.matchMedia\('\(pointer: fine\)'\)\.matches[\s\S]*?wheelGestureController = createPlayerWheelController/.test(shell), '1l. the wheel controller is bound ONLY on (pointer: fine) devices — never on touch');
  ok(/surface\.addEventListener\('wheel', handleWheel, \{ passive: false \}\);/.test(gestures), '1m. the wheel listener is non-passive (preventDefault is possible)');
  ok(/if \(event\.cancelable\) event\.preventDefault\(\);/.test(gestures), '1n. every owned wheel notch preventDefaults — the page never scrolls under the pointer');

  // (b) Wheel controller — behavioral, REAL controller on a fake surface.
  type FakeWheelEvent = { deltaY: number; clientX: number; cancelable: boolean; preventDefault(): void };
  function fakeWheelSurface() {
    const listeners = new Map<string, (event: FakeWheelEvent) => void>();
    let prevented = 0;
    return {
      addEventListener(type: string, handler: (event: FakeWheelEvent) => void) { listeners.set(type, handler); },
      removeEventListener(type: string) { listeners.delete(type); },
      clientWidth: 1000,
      fire(type: string, event: FakeWheelEvent) { listeners.get(type)?.(event); },
      preventedCount: () => prevented,
      event(deltaY: number, clientX: number): FakeWheelEvent {
        return { deltaY, clientX, cancelable: true, preventDefault() { prevented += 1; } };
      },
    };
  }
  {
    // Left half → brightness, right half → volume; HUD shows; page never scrolls.
    const surface = fakeWheelSurface();
    const events: string[] = [];
    const controller = createPlayerWheelController({
      surface: surface as unknown as HTMLElement,
      enabled: () => true,
      onBrightnessDelta: (delta) => { events.push(`brightness:${delta.toFixed(3)}`); },
      onVolumeDelta: (delta) => { events.push(`volume:${delta.toFixed(3)}`); },
      onGestureStart: (kind) => { events.push(`start:${kind}`); },
      onGestureEnd: (kind, total) => { events.push(`end:${kind}:${total.toFixed(3)}`); },
    });
    surface.fire('wheel', surface.event(-100, 200)); // up, left half
    surface.fire('wheel', surface.event(-100, 200));
    surface.fire('wheel', surface.event(100, 900)); // down, right half
    ok(events[0] === 'start:brightness' && events.slice(1, 3).every((entry) => entry === 'brightness:0.020'), '1o. wheel up over the LEFT half raises brightness ≈2% per notch');
    ok(events.some((entry) => entry === 'volume:-0.020'), '1p. wheel down over the RIGHT half lowers volume ≈2% per notch');
    ok(surface.preventedCount() === 3, '1q. every owned notch preventDefault()s (the page does not scroll)');
    ok(/start:brightness/.test(events.join(',')) && /end:brightness:0\.040/.test(events.join(',')), '1r. the SAME HUD lifecycle fires (start on the first notch, end after the quiet period)');
    await sleep(400);
    ok(/end:volume:-0\.020/.test(events.join(',')), '1s. each wheel burst ends after the quiet period (exactly one gesture announcement)');
    controller.destroy();
  }
  {
    // The enabled() gate keeps the page scrolling (no preventDefault).
    const surface = fakeWheelSurface();
    const controller = createPlayerWheelController({
      surface: surface as unknown as HTMLElement,
      enabled: () => false,
      onBrightnessDelta: () => {},
      onVolumeDelta: () => {},
      onGestureStart: () => {},
      onGestureEnd: () => {},
    });
    surface.fire('wheel', surface.event(-100, 200));
    ok(surface.preventedCount() === 0, '1t. while the gate is false (sheets open / locked / cast / embed) the wheel is untouched — scrollable surfaces keep scrolling');
    controller.destroy();
  }

  // (c) Mouse clicks feed the SAME tap arbitration (pointerType 'mouse' only).
  type FakePointerEvent = { pointerId: number; pointerType: string; button: number; clientX: number; clientY: number; target: unknown };
  function fakePointerSurface() {
    const listeners = new Map<string, (event: FakePointerEvent) => void>();
    return {
      addEventListener(type: string, handler: (event: FakePointerEvent) => void) { listeners.set(type, handler); },
      removeEventListener(type: string) { listeners.delete(type); },
      clientWidth: 1000,
      fire(type: string, event: FakePointerEvent) { listeners.get(type)?.(event); },
    };
  }
  const pointer = (id: number, x: number, y: number, pointerType = 'mouse') => ({ pointerId: id, pointerType, button: 0, clientX: x, clientY: y });
  {
    // A single desktop CLICK toggles play/pause after the double-tap window.
    const surface = fakePointerSurface();
    const events: string[] = [];
    const controller = createPlayerTapGestureController({
      surface: surface as unknown as HTMLElement,
      enabled: () => true,
      onDoubleTap: () => events.push('double'),
      onSingleTap: () => events.push('single'),
      onHoldStart: () => events.push('hold:start'),
      onHoldEnd: () => events.push('hold:end'),
      now: () => 1000,
    });
    surface.fire('pointerdown', { ...pointer(1, 200, 300), target: {} });
    surface.fire('pointerup', { ...pointer(1, 200, 300), target: {} });
    await sleep(120);
    ok(events.length === 0, '1u. inside the window the click toggle is still pending (a double-click may still claim it)');
    await sleep(320);
    ok(events.length === 1 && events[0] === 'single', '1v. a desktop click fires the single-tap toggle exactly like a tap');
    controller.destroy();
  }
  {
    // A desktop DOUBLE-CLICK seeks ±10s and never toggles.
    const surface = fakePointerSurface();
    const events: string[] = [];
    const controller = createPlayerTapGestureController({
      surface: surface as unknown as HTMLElement,
      enabled: () => true,
      onDoubleTap: () => events.push('double'),
      onSingleTap: () => events.push('single'),
      onHoldStart: () => {},
      onHoldEnd: () => {},
      now: () => 1000,
    });
    surface.fire('pointerdown', { ...pointer(1, 800, 300), target: {} });
    surface.fire('pointerup', { ...pointer(1, 800, 300), target: {} });
    surface.fire('pointerdown', { ...pointer(2, 810, 300), target: {} });
    surface.fire('pointerup', { ...pointer(2, 810, 300), target: {} });
    await sleep(DOUBLE_TAP_WINDOW_MS + 80);
    ok(events.length === 1 && events[0] === 'double', '1w. a double-click seeks (same-half arbitration) without toggling');
    controller.destroy();
  }
  {
    // Touch pointers NEVER take the pointer path (no double-fire) — and a
    // mouse drag (beyond the slop) dies quietly.
    const surface = fakePointerSurface();
    const events: string[] = [];
    const controller = createPlayerTapGestureController({
      surface: surface as unknown as HTMLElement,
      enabled: () => true,
      onDoubleTap: () => events.push('double'),
      onSingleTap: () => events.push('single'),
      onHoldStart: () => {},
      onHoldEnd: () => {},
      now: () => 1000,
    });
    surface.fire('pointerdown', { ...pointer(1, 200, 300, 'touch'), target: {} });
    surface.fire('pointerup', { ...pointer(1, 200, 300, 'touch'), target: {} });
    await sleep(DOUBLE_TAP_WINDOW_MS + 80);
    ok(events.length === 0, '1x. pointerType "touch" never takes the mouse path (hybrid devices can never double-fire)');
    surface.fire('pointerdown', { ...pointer(2, 200, 300), target: {} });
    surface.fire('pointermove', { ...pointer(2, 260, 300), target: {} });
    surface.fire('pointerup', { ...pointer(2, 260, 300), target: {} });
    await sleep(DOUBLE_TAP_WINDOW_MS + 80);
    ok(events.length === 0, '1y. a mouse press that becomes a drag never toggles playback');
    controller.destroy();
  }
  ok(/handleSingleTap,/.test(shell) && /onSingleTap: handleSingleTap,/.test(shell), '1z. the shell keeps wiring the single-tap toggle (touch AND mouse reach it)');
}

// ===========================================================================
// §2 — F2: hover-to-open sheets (desktop only).
// ===========================================================================
console.log('\n§2 — F2: hover-to-open sheets (desktop only)');
{
  ok(/window\.matchMedia\('\(hover: hover\) and \(pointer: fine\)'\)/.test(controls), '2a. hover-open is gated on (hover: hover) and (pointer: fine) — never on touch devices');
  ok(/const HOVER_OPEN_DELAY_MS = 120;/.test(controls) && /const HOVER_CLOSE_DELAY_MS = 220;/.test(controls), '2b. the hover-open delay is 120ms and the leave-close delay is 220ms (round 56 H1: 200→220 with the geometry zone)');
  ok(/function openMenu\(kind: 'subtitles' \| 'quality' \| 'audio' \| 'servers' \| 'speed' \| 'display', viaHover = false\)/.test(controls), '2c. openMenu tracks HOW the sheet opened (hover vs click)');
  ok(/if \(openSheet === null \|\| !sheetOpenedByHover \|\| sheetClosing\) return;/.test(controls), '2d. only a HOVER-opened sheet auto-closes on pointer leave — click keeps its exact semantics (round 56 H1: the geometry watch gates on sheetOpenedByHover)');
  ok(/target\.closest\('\.sheet-trigger'\)/.test(controls) && !/closest\('\.sheet-trigger, \.player-option-sheet'\)/.test(controls), '2e. (round 56 H1) DOM matching is ONLY the open trigger chip (.sheet-trigger) — the panel joined the GEOMETRY zone (chip rect ∪ panel rect, 8px inflated), so the popover overlay can never feed the open/close loop');
  ok(/return hoverCapable && !locked && !gestureActive && !sheetClosing;/.test(controls), '2f. hover-open never fires while locked, while a gesture is active, or mid-close');
  ok(/onpointerover=\{handleHoverOver\}/.test(controls) && !/onpointerout=/.test(controls), '2g. (round 56 H1) hover-open is delegated via pointerover ONLY — the close side is the window pointermove GEOMETRY watch, never pointerout (the overlay sits on top of the chip and used to loop the sheet open/close)');
  ok(/export let gestureActive = false;/.test(controls) && /gestureActive=\{gestureIndicator !== null \|\| holdSpeedActive\}/.test(shell), '2h. the shell feeds its live gesture flag into the controls (hover stands down mid-gesture)');
  for (const kind of ['subtitles', 'quality', 'servers', 'audio', 'speed', 'display']) {
    ok(controls.includes(`data-sheet="${kind}"`), `2i. the ${kind} trigger carries data-sheet="${kind}" (hover target)`);
  }
  ok(/aria-label=\{`Subtitles: \$\{subtitleButtonLabel\}/.test(controls) && /onclick=\{\(\) => openMenu\('subtitles'\)\}/.test(controls), '2j. CLICK still opens (touch and mouse) — the literal onclick openMenu calls are untouched');
  ok(/onDestroy\(\(\) => \{[\s\S]*?clearHoverTimers\(\);[\s\S]*?stopHoverCloseWatch\(\);[\s\S]*?removeEventListener\('change', hoverMediaListener\)/.test(controls), '2k. the hover timers, the geometry close watch and the matchMedia listener are cleaned up in onDestroy');
}

// ===========================================================================
// §3 — F3: keyboard shortcuts + aria-keyshortcuts.
// ===========================================================================
console.log('\n§3 — F3: keyboard shortcuts + aria-keyshortcuts');
{
  ok(/if \(event\.key === ' ' \|\| event\.key\.toLowerCase\(\) === 'k'\) \{ event\.preventDefault\(\); void togglePlay\(\); \}/.test(shell), '3a. Space (or K) toggles play/pause');
  ok(/else if \(event\.key === 'ArrowLeft'\) \{ event\.preventDefault\(\); seekBy\(-10\); \}/.test(shell) && /else if \(event\.key === 'ArrowRight'\) \{ event\.preventDefault\(\); seekBy\(10\); \}/.test(shell), '3b. ArrowLeft/ArrowRight step ∓10s through the EXISTING step handler (seekBy)');
  ok(/if \(target\?\.matches\('input, select, textarea, \[contenteditable="true"\]'\)\) return;/.test(shell), '3c. the shortcuts ignore focus inside inputs/sliders/text fields (a range input is an input)');
  ok(/if \(controlsSheetsOpen\) return;/.test(shell) && /if \(sourceMenuOpen \|\| episodeMenuOpen\) \{[\s\S]*?handleSheetKeydown\(event\);/.test(shell), '3d. an open sheet owns the keyboard (typing/space inside it never leaks to the player)');
  ok(/aria-keyshortcuts="Space"/.test(controls), '3e. the play button carries aria-keyshortcuts="Space"');
  ok(/aria-label="Seek backward 10 seconds" aria-keyshortcuts="ArrowLeft"/.test(controls) && /aria-label="Seek forward 10 seconds" aria-keyshortcuts="ArrowRight"/.test(controls), '3f. the two seek buttons carry aria-keyshortcuts="ArrowLeft"/"ArrowRight"');
  ok(/aria-label=\{playing \? 'Pause' : 'Play'\}/.test(controls), '3g. the play button keeps its aria-label (nothing renamed)');
}

// ===========================================================================
// §4 — F4: autoplay on open.
// ===========================================================================
console.log('\n§4 — F4: autoplay on open');
{
  ok(/async function attemptOpenAutoplay\(\): Promise<void> \{/.test(shell), '4a. the autoplay attempt exists in the shell');
  ok(/void attemptOpenAutoplay\(\);/.test(shell.slice(shell.indexOf('function handleLoadedMetadata'))), '4b. it fires when the playable source resolves (loadedmetadata)');
  ok(/let autoplayAttempted = false;/.test(shell) && /if \(autoplayAttempted\) return;\s*\n\s*autoplayAttempted = true;/.test(shell), '4c. exactly ONE attempt per mount (never a loop)');
  ok(/await videoElement\.play\(\);[\s\S]*?catch[\s\S]*?ONE retry muted/.test(shell) || (/try \{\s*\n\s*await videoElement\.play\(\);/.test(shell) && /videoElement\.muted = true;\s*\n\s*muted = true;\s*\n\s*await videoElement\.play\(\);/.test(shell)), '4d. a normal play() is attempted first, then ONE muted retry (autoplay policy)');
  ok(/if \(Date\.now\(\) - shellOpenedAt < AUTOPLAY_USER_PAUSE_WINDOW_MS\) autoplaySuppressed = true;/.test(shell) && /const AUTOPLAY_USER_PAUSE_WINDOW_MS = 1000;/.test(shell), '4e. a user pause within the first second suppresses autoplay for good (never fights the user)');
  ok(/navEntry\.type === 'back_forward'/.test(shell), '4f. an explicit back/forward navigation skips autoplay (navigated back to a paused state)');
  ok(/autoplaySuppressed \|\| !videoElement\.paused/.test(shell), '4g. the muted retry re-checks the user intent (a pause during the first attempt wins)');
  ok(/videoElement\.muted = wasMuted;\s*\n\s*muted = wasMuted;/.test(shell), '4h. a fully rejected attempt restores the user\'s mute state and stays paused on the card');
  ok(/if \(!videoElement \|\| !sourceReady \|\| source\?\.type !== 'direct' \|\| castConnected\) return;/.test(shell), '4i. autoplay only ever touches a playable DIRECT source (embeds/cast manage themselves)');
}

// ===========================================================================
// §5 — F5: bottom row order.
// ===========================================================================
console.log('\n§5 — F5: bottom row order (−10 · Play · +10 · Volume)');
{
  const left = controls.slice(controls.indexOf('class="left-controls"'), controls.indexOf('class="right-controls"'));
  const order = ['Seek backward 10 seconds', "aria-label={playing ? 'Pause' : 'Play'}", 'Seek forward 10 seconds', 'volume-control'];
  let cursor = 0;
  let orderOk = true;
  for (const marker of order) {
    const at = left.indexOf(marker, cursor);
    if (at < 0) { orderOk = false; break; }
    cursor = at;
  }
  ok(orderOk, '5a. the left group order is −10s, PLAY/PAUSE, +10s, Volume(+slider) — Play sits BETWEEN the seek buttons');
  ok(/onStep\(-10\)/.test(controls) && /onStep\(10\)/.test(controls) && /onclick=\{onTogglePlay\}/.test(controls), '5b. the same handlers drive the moved buttons (aria-labels + handlers unchanged)');
}

// ===========================================================================
// §6 — F6: the right time label toggles total ↔ remaining.
// ===========================================================================
console.log('\n§6 — F6: right time label toggle (total ↔ remaining)');
{
  ok(/let durationMode: 'total' \| 'remaining' = 'total';/.test(controls), '6a. session-only mode state (no persistence), default = total');
  ok(/durationMode === 'remaining' && safeDuration > 0/.test(controls) && /`−\$\{formatPlayerTime\(Math\.max\(0, safeDuration - currentTime\)\)\}`/.test(controls), '6b. remaining mode shows "−MM:SS" (duration − currentTime)');
  ok(/<button class="time-label duration-toggle" type="button" aria-pressed=\{durationMode === 'remaining'\}/.test(controls), '6c. a real <button> with aria-pressed state');
  ok(/aria-label=\{durationMode === 'total' \? 'Show remaining time' : 'Show total duration'\}/.test(controls), '6d. the aria-label describes the toggle');
  ok(/onclick=\{toggleDurationMode\}/.test(controls), '6e. clicking flips the mode');
  ok(/class="time-label" aria-live="off">\{formatPlayerTime\(currentTime\)\}<\/span>/.test(controls), '6f. the LEFT (elapsed) label is unchanged');
}

console.log(`\nRound 53 player behaviour: ${passed} passed, ${failed} failed (of ${passed + failed})`);
if (failed > 0) process.exit(1);
