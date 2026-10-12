import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  BRIGHTNESS_MAX,
  BRIGHTNESS_MAX_DIM,
  BRIGHTNESS_MIN,
  classifyDrag,
  clampBrightness,
  brightnessDimOpacity,
  createPlayerGestureController,
  dragDelta,
  gestureIndicatorPercent,
  gestureZoneForStart,
} from '$lib/client/player/touch/gestures';
import type { GestureKind } from '$lib/client/player/touch/gestures';

// Player UI V2 — Part 1, PHASE 2 regression suite (touch gestures + lock).
//
// §1  Pure gesture math — zone lookup, tap/swipe/horizontal classification,
//     brightness clamping, drag→delta mapping, overlay dim, indicator percent.
// §2  Controller behavior against a FAKE surface (no DOM) — vertical swipes,
//     horizontal rejection, taps, interactive-target exclusion, the enabled()
//     gate, one-gesture-at-a-time, preventDefault ownership, cleanup.
// §3  Shell contracts — single attach/destroy, lock/keyboard gating, overlay
//     semantics (simulated brightness only), indicator a11y, unlock reachability.

let checks = 0;
function ok(condition: boolean, label: string) {
  assert.ok(condition, label);
  checks += 1;
}

// ============================================================
// §1 — Pure gesture math
// ============================================================

// 1a. Zones (fraction 0.32 of a 1000px surface → [0, 320] left, [680, 1000] right).
ok(gestureZoneForStart(0, 1000) === 'left' && gestureZoneForStart(319, 1000) === 'left', '1a. left zone covers the left 32%');
ok(gestureZoneForStart(681, 1000) === 'right' && gestureZoneForStart(1000, 1000) === 'right', '1a. right zone covers the right 32%');
ok(gestureZoneForStart(500, 1000) === 'none', '1a. the center strip is gesture-neutral');
ok(gestureZoneForStart(Number.NaN, 1000) === 'none' && gestureZoneForStart(100, 0) === 'none', '1a. invalid inputs are gesture-neutral');

// 1b. Classification: tap vs vertical vs horizontal.
ok(classifyDrag(3, 5, 'left').kind === 'none', '1b. a small movement is a TAP — never a gesture');
ok(classifyDrag(10, 60, 'left').kind === 'gesture' && (classifyDrag(10, 60, 'left') as { gesture?: GestureKind }).gesture === 'brightness', '1b. left-zone vertical drag → brightness');
ok(classifyDrag(-8, 120, 'right').kind === 'gesture' && (classifyDrag(-8, 120, 'right') as { gesture?: GestureKind }).gesture === 'volume', '1b. right-zone vertical drag → volume');
ok(classifyDrag(0, 120, 'none').kind === 'none', '1b. vertical drag in the center zone is ignored');
ok(classifyDrag(120, 10, 'left').kind === 'horizontal', '1b. a horizontal drag is classified horizontal — NEVER a vertical gesture');
ok(classifyDrag(60, 60, 'left').kind === 'none', '1b. a 45° diagonal stays unclassified (verticality ratio guard)');

// 1c. Brightness clamping + mapping.
ok(clampBrightness(1.7) === BRIGHTNESS_MAX && clampBrightness(-2) === BRIGHTNESS_MIN, '1c. brightness clamps to [0.25, 1]');
ok(clampBrightness(Number.NaN) === BRIGHTNESS_MAX, '1c. NaN falls back to full brightness (never dark)');
ok(dragDelta(-240) === 1 && dragDelta(240) === -1, '1c. drag up increases, drag down decreases');
ok(brightnessDimOpacity(BRIGHTNESS_MAX) === 0, '1c. full brightness → transparent overlay');
ok(brightnessDimOpacity(BRIGHTNESS_MIN) === BRIGHTNESS_MAX_DIM, '1c. floor brightness → the bounded max dim (video never fully black)');
ok(brightnessDimOpacity(0.9) < brightnessDimOpacity(0.5), '1c. dimming grows monotonically as brightness falls');

// 1d. Indicator percent.
ok(gestureIndicatorPercent(0.456) === 46 && gestureIndicatorPercent(2) === 100 && gestureIndicatorPercent(-1) === 0, '1d. percent rounds and clamps to [0, 100]');

// ============================================================
// §2 — Controller behavior (fake surface)
// ============================================================

// The controller guards its interactive-target check behind `typeof Element`,
// which makes the module SSR-safe AND lets this suite install a fake Element
// class for Node (no DOM) — the same closest() contract the browser provides.
class FakeElement {
  constructor(private readonly interactive: boolean) {}
  closest(_selector: string): unknown {
    return this.interactive ? { fake: true } : null;
  }
}
(globalThis as { Element?: unknown }).Element = FakeElement;

type Listener = (event: unknown) => void;
type FakeSurface = {
  clientWidth: number;
  listeners: Map<string, Listener[]>;
  addEventListener: (type: string, listener: Listener) => void;
  removeEventListener: (type: string, listener: Listener) => void;
};

function createFakeSurface(): FakeSurface {
  const listeners = new Map<string, Listener[]>();
  return {
    clientWidth: 1000,
    listeners,
    addEventListener(type, listener) {
      const list = listeners.get(type) ?? [];
      list.push(listener);
      listeners.set(type, list);
    },
    removeEventListener(type, listener) {
      const list = listeners.get(type) ?? [];
      const index = list.indexOf(listener);
      if (index >= 0) list.splice(index, 1);
      listeners.set(type, list);
    },
  };
}

function fakeTouchEvent(opts: { identifier?: number; clientX: number; clientY: number; target?: unknown; cancelable?: boolean; predefault?: () => void }): unknown {
  return {
    changedTouches: [{ identifier: opts.identifier ?? 1, clientX: opts.clientX, clientY: opts.clientY }],
    target: opts.target ?? null,
    cancelable: opts.cancelable ?? false,
    preventDefault: opts.predefault ?? (() => {}),
  };
}

function dispatch(surface: FakeSurface, type: string, event: unknown) {
  for (const listener of [...(surface.listeners.get(type) ?? [])]) listener(event);
}

function createHarness(enabled = true) {
  const surface = createFakeSurface();
  let allow = enabled;
  const brightness: number[] = [];
  const volume: number[] = [];
  const starts: GestureKind[] = [];
  const ends: { gesture: GestureKind; delta: number }[] = [];
  const controller = createPlayerGestureController({
    surface: surface as unknown as HTMLElement,
    enabled: () => allow,
    onBrightnessDelta: (delta) => brightness.push(delta),
    onVolumeDelta: (delta) => volume.push(delta),
    onGestureStart: (gesture) => starts.push(gesture),
    onGestureEnd: (gesture, delta) => ends.push({ gesture, delta }),
    surfaceWidth: () => surface.clientWidth,
  });
  return {
    surface,
    brightness,
    volume,
    starts,
    ends,
    setEnabled(value: boolean) { allow = value; },
    controller,
  };
}

// 2a. Listener lifecycle — exactly the four touch listeners, removable.
{
  const harness = createHarness();
  const counts = ['touchstart', 'touchmove', 'touchend', 'touchcancel'].map((type) => harness.surface.listeners.get(type)?.length ?? 0);
  ok(counts.every((count) => count === 1), '2a. attach registers each touch listener exactly once');
  harness.controller.destroy();
  const after = ['touchstart', 'touchmove', 'touchend', 'touchcancel'].map((type) => harness.surface.listeners.get(type)?.length ?? 0);
  ok(after.every((count) => count === 0), '2a. destroy removes every listener');
}

// 2b. Right-zone vertical swipe up → volume increases; down → decreases.
{
  const harness = createHarness();
  dispatch(harness.surface, 'touchstart', fakeTouchEvent({ clientX: 900, clientY: 400 }));
  dispatch(harness.surface, 'touchmove', fakeTouchEvent({ clientX: 905, clientY: 340 })); // up 60px
  dispatch(harness.surface, 'touchmove', fakeTouchEvent({ clientX: 910, clientY: 280 })); // up 120px cumulative
  dispatch(harness.surface, 'touchend', fakeTouchEvent({ clientX: 910, clientY: 280 }));
  ok(harness.starts.length === 1 && harness.starts[0] === 'volume', '2b. right-zone swipe starts ONE volume gesture');
  ok(harness.volume.length === 2 && harness.volume.every((delta) => delta > 0), '2b. dragging up increases volume (per-move deltas positive)');
  ok(harness.ends.length === 1 && harness.ends[0].gesture === 'volume' && harness.ends[0].delta > 0, '2b. gesture end carries the accumulated positive delta');
  ok(harness.brightness.length === 0, '2b. the volume gesture never touches brightness');
}

{
  const harness = createHarness();
  dispatch(harness.surface, 'touchstart', fakeTouchEvent({ clientX: 100, clientY: 400 }));
  dispatch(harness.surface, 'touchmove', fakeTouchEvent({ clientX: 105, clientY: 500 })); // down 100px
  dispatch(harness.surface, 'touchend', fakeTouchEvent({ clientX: 105, clientY: 500 }));
  ok(harness.starts[0] === 'brightness' && harness.brightness[0] < 0, '2b. left-zone swipe down starts brightness and DECREASES it');
}

// 2c. Taps and horizontal drags never trigger gestures.
{
  const harness = createHarness();
  dispatch(harness.surface, 'touchstart', fakeTouchEvent({ clientX: 900, clientY: 400 }));
  dispatch(harness.surface, 'touchmove', fakeTouchEvent({ clientX: 902, clientY: 402 })); // tiny movement = tap candidate
  dispatch(harness.surface, 'touchend', fakeTouchEvent({ clientX: 902, clientY: 402 }));
  ok(harness.starts.length === 0 && harness.ends.length === 0 && harness.volume.length === 0, '2c. a tap is never a gesture');
}
{
  const harness = createHarness();
  dispatch(harness.surface, 'touchstart', fakeTouchEvent({ clientX: 500, clientY: 400 }));
  dispatch(harness.surface, 'touchmove', fakeTouchEvent({ clientX: 700, clientY: 395 })); // horizontal
  dispatch(harness.surface, 'touchend', fakeTouchEvent({ clientX: 700, clientY: 395 }));
  ok(harness.starts.length === 0 && harness.ends.length === 0, '2c. a horizontal drag is never a gesture');
}

// 2d. Gestures starting on interactive controls are ignored.
{
  const harness = createHarness();
  const buttonTarget = new FakeElement(true);
  dispatch(harness.surface, 'touchstart', fakeTouchEvent({ clientX: 900, clientY: 400, target: buttonTarget }));
  dispatch(harness.surface, 'touchmove', fakeTouchEvent({ clientX: 905, clientY: 300 }));
  dispatch(harness.surface, 'touchend', fakeTouchEvent({ clientX: 905, clientY: 300 }));
  ok(harness.starts.length === 0 && harness.volume.length === 0, '2d. a swipe starting on a button/slider is ignored');
  const videoTarget = new FakeElement(false);
  dispatch(harness.surface, 'touchstart', fakeTouchEvent({ clientX: 900, clientY: 400, target: videoTarget }));
  dispatch(harness.surface, 'touchmove', fakeTouchEvent({ clientX: 905, clientY: 300 }));
  ok(harness.starts.length === 1, '2d. the same swipe over the VIDEO surface starts normally');
  dispatch(harness.surface, 'touchend', fakeTouchEvent({ clientX: 905, clientY: 300 }));
}

// 2e. The enabled() gate (lock / embeds / sheets) blocks new gestures per-touch.
{
  const harness = createHarness(false);
  dispatch(harness.surface, 'touchstart', fakeTouchEvent({ clientX: 100, clientY: 400 }));
  dispatch(harness.surface, 'touchmove', fakeTouchEvent({ clientX: 100, clientY: 300 }));
  dispatch(harness.surface, 'touchend', fakeTouchEvent({ clientX: 100, clientY: 300 }));
  ok(harness.starts.length === 0, '2e. no gesture starts while enabled() is false (locked / embed / sheet)');
  harness.setEnabled(true);
  dispatch(harness.surface, 'touchstart', fakeTouchEvent({ clientX: 100, clientY: 400 }));
  dispatch(harness.surface, 'touchmove', fakeTouchEvent({ clientX: 100, clientY: 300 }));
  ok(harness.starts.length === 1, '2e. re-enabling takes effect WITHOUT re-attaching listeners');
}

// 2f. One gesture at a time; the second finger is ignored until the first ends.
{
  const harness = createHarness();
  dispatch(harness.surface, 'touchstart', fakeTouchEvent({ identifier: 1, clientX: 100, clientY: 400 }));
  dispatch(harness.surface, 'touchstart', fakeTouchEvent({ identifier: 2, clientX: 900, clientY: 400 })); // second finger
  dispatch(harness.surface, 'touchmove', fakeTouchEvent({ identifier: 2, clientX: 900, clientY: 300 })); // moves the SECOND touch
  dispatch(harness.surface, 'touchmove', fakeTouchEvent({ identifier: 1, clientX: 100, clientY: 300 }));
  ok(harness.starts.length === 1, '2f. only ONE gesture owns the surface at a time');
}

// 2g. The active gesture owns vertical movement (preventDefault when cancelable).
{
  const harness = createHarness();
  let prevented = 0;
  dispatch(harness.surface, 'touchstart', fakeTouchEvent({ clientX: 100, clientY: 400 }));
  dispatch(harness.surface, 'touchmove', fakeTouchEvent({ clientX: 100, clientY: 440, cancelable: true, predefault: () => { prevented += 1; } }));
  dispatch(harness.surface, 'touchmove', fakeTouchEvent({ clientX: 100, clientY: 430, cancelable: false, predefault: () => { prevented += 1; } }));
  ok(prevented === 1, '2g. preventDefault fires only for cancelable moves during an ACTIVE gesture (never for taps)');
}

// 2h. Re-attach after destroy is clean (no duplicate listeners).
{
  const harness = createHarness();
  harness.controller.destroy();
  const second = createPlayerGestureController({
    surface: harness.surface as unknown as HTMLElement,
    enabled: () => true,
    onBrightnessDelta: () => {},
    onVolumeDelta: () => {},
    onGestureStart: () => {},
    onGestureEnd: () => {},
  });
  const counts = ['touchstart', 'touchmove', 'touchend', 'touchcancel'].map((type) => harness.surface.listeners.get(type)?.length ?? 0);
  ok(counts.every((count) => count === 1), '2h. re-attach after destroy creates NO duplicate listeners');
  second.destroy();
}

// ============================================================
// §3 — Shell contracts
// ============================================================

const shell = readFileSync(resolve('src/lib/components/player/PlayerShell.svelte'), 'utf-8');

// 3a. One controller per mount, destroyed in cleanup.
ok((shell.match(/createPlayerGestureController\(/g) ?? []).length === 1, '3a. the gesture controller is created exactly once (in onMount)');
ok(/gestureController\?\.destroy\(\);/.test(shell), '3a. the controller is destroyed in the mount cleanup (no leak across mounts)');
// 3b. The enabled() gate composition.
ok(/enabled: \(\) => !touchLocked && source\?\.type === 'direct' && !sourceMenuOpen && !episodeMenuOpen && sourceReady/.test(shell), '3b. gestures are gated on the lock, DIRECT ownership, open sheets and source readiness');
// 3c. Brightness is a simulated overlay — never a system brightness API.
ok(/class="brightness-overlay" style=\{`opacity: \$\{brightnessDimOpacity\(brightness\)\}`\} aria-hidden="true"/.test(shell), '3c. the brightness overlay is a shell-rendered, aria-hidden visual layer');
ok(!/systemBrightness|display\.brightness|BrightnessAPI/i.test(shell), '3c. no system/display brightness API is referenced anywhere');
ok(/\.brightness-overlay \{ position: absolute; z-index: 5; inset: 0; background: #000; pointer-events: none;/.test(shell), '3c. the overlay is pointer-transparent and cannot block controls');
// 3d. Volume gestures route through the EXISTING setVolume path.
ok(/onVolumeDelta: \(delta\) => \{ setVolume\(volume \+ delta\); \}/.test(shell), '3d. volume gestures reuse the shell setVolume (mute state + Media Session preserved)');
// 3e. Touch lock — one toggle, controls suppressed, persistent unlock FAB.
ok(/function toggleTouchLock\(\)/.test(shell) && (shell.match(/function toggleTouchLock\(/g) ?? []).length === 1, '3e. exactly one lock toggle implementation');
ok(/function revealControls\(\) \{[\s\S]{0,500}?if \(touchLocked\) return;/.test(shell), '3e. auto-reveal is suppressed while locked');
ok(/\{#if touchLocked\}[\s\S]*?class="unlock-fab"/.test(shell), '3e. the unlock FAB renders while locked — the user can never be stranded');
ok(!/controls-hidden[\s\S]{0,40}unlock-fab/.test(shell), '3e. the unlock FAB is independent of the auto-hide cycle');
// 3f. Back is never blocked by the lock.
ok(/\.player-shell\.touch-locked \.back-fab \{ opacity: 1; visibility: visible; pointer-events: auto; \}/.test(shell), '3f. the Back FAB stays visible/clickable while locked');
// 3g. Keyboard shortcuts are disabled while locked (Escape fullscreen-exit kept).
ok(/if \(touchLocked\) \{[\s\S]*?event\.key === 'Escape'[\s\S]*?exitMaveroFullscreen[\s\S]*?return;/.test(shell), '3g. locked keyboard handling keeps only the Escape fullscreen exit');
// 3h. Indicator + announcement a11y.
ok(/class="gesture-indicator" aria-hidden="true"/.test(shell), '3h. the visual indicator is aria-hidden');
ok(/class="gesture-announcement" role="status" aria-live="polite"/.test(shell), '3h. completed gestures announce once through a polite live region');
// 3i. Skip Intro never renders while locked; gestures hide with sheets via enabled().
ok(/activeSkipSegment && source\?\.type === 'direct' && !touchLocked/.test(shell), '3i. the Skip Intro button is suppressed while touch-locked');

console.log(`player_ui_v2_phase2_test: ${checks} checks passed`);
