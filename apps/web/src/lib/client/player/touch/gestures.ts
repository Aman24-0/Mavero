/**
 * Player UI V2 (Part 1, Phase 2) — touch gestures for the direct-video player.
 *
 * Two vertical-swipe gestures over the video surface, mirroring the familiar
 * mobile-player interaction model:
 *   * LEFT zone   → simulated player-video BRIGHTNESS (a black overlay whose
 *     opacity rises as the drag goes DOWN). This is purely a Mavero-rendered
 *     visual overlay — it never touches Android/iOS display-brightness APIs
 *     (none exist for web pages; the task explicitly forbids claiming system
 *     brightness control).
 *   * RIGHT zone  → player VOLUME through the EXISTING setVolume path
 *     (clamped 0..1; the shell's setVolume un-mutes when volume > 0, so the
 *     gesture respects and updates the mute state coherently).
 *
 * Gesture-safety contract (all enforced here, unit-tested via the pure
 * helpers below):
 *   * A TAP (movement under the threshold) is never a gesture — no action,
 *     no preventDefault; the shell's own reveal-controls listener still sees it.
 *   * A HORIZONTAL drag is never treated as a vertical gesture (ratio guard).
 *   * Gestures starting on interactive surfaces (buttons, sliders, selects,
 *     links, labelled controls) are ignored entirely.
 *   * Touch gestures are Touch-Events only; desktop adds the WHEEL controller
 *     (round 53 F1b — the same handlers/HUD, driven by the wheel, bound only
 *     on pointer-fine devices) and mouse CLICKS through the tap controller's
 *     pointer path (round 53 F1c — pointerType 'mouse' only, so a tap can
 *     never double-fire on hybrid devices).
 *   * One gesture at a time; multi-touch is ignored until all touches end.
 *   * `enabled()` is consulted on every gesture start — the shell gates on
 *     the touch lock, direct-source ownership and open sheets, so locking,
 *     provider switches and embeds can never leave a stale gesture surface.
 *   * `destroy()` removes every listener exactly once.
 */

/** Fraction of the surface width considered the LEFT / RIGHT gesture zones. */
export const GESTURE_ZONE_FRACTION = 0.32;
/** Minimum vertical movement (px) before a touch becomes a gesture. */
export const GESTURE_START_THRESHOLD_PX = 18;
/** A drag is vertical only when |dy| >= |dx| * this ratio at classification. */
export const GESTURE_VERTICALITY_RATIO = 1.25;
/** Full-axis drag length (px) that sweeps the value through its whole range. */
export const GESTURE_SWEEP_PX = 240;

/** Simulated brightness floor — the video never becomes fully black. */
export const BRIGHTNESS_MIN = 0.25;
export const BRIGHTNESS_MAX = 1;
/** Maximum dimming the overlay paints at the brightness floor. */
export const BRIGHTNESS_MAX_DIM = 0.82;

export type GestureKind = 'brightness' | 'volume';

export type GestureZone = 'left' | 'right' | 'none';

export type GestureClassification =
  | { kind: 'none' }
  | { kind: 'horizontal' }
  | { kind: 'gesture'; gesture: GestureKind; zone: GestureZone };

/**
 * Pure zone lookup for a touch START point. The zone is decided by where the
 * gesture BEGINS (not where the finger travels).
 */
export function gestureZoneForStart(startX: number, surfaceWidth: number, zoneFraction = GESTURE_ZONE_FRACTION): GestureZone {
  if (!Number.isFinite(startX) || !Number.isFinite(surfaceWidth) || surfaceWidth <= 0) return 'none';
  const zoneWidth = surfaceWidth * zoneFraction;
  if (startX <= zoneWidth) return 'left';
  if (startX >= surfaceWidth - zoneWidth) return 'right';
  return 'none';
}

/**
 * Pure classification of a drag. A touch is a GESTURE only when the vertical
 * movement crosses the threshold AND dominates the horizontal movement by the
 * verticality ratio. A dominant horizontal drag is classified 'horizontal'
 * (explicitly NOT a gesture — Mavero has no horizontal swipe action). Anything
 * below the threshold is still 'none' (a candidate tap).
 */
export function classifyDrag(
  dx: number,
  dy: number,
  zone: GestureZone,
  startThresholdPx = GESTURE_START_THRESHOLD_PX,
  verticalityRatio = GESTURE_VERTICALITY_RATIO,
): GestureClassification {
  const absX = Math.abs(dx);
  const absY = Math.abs(dy);
  if (absY < startThresholdPx && absX < startThresholdPx) return { kind: 'none' };
  if (absY >= startThresholdPx && absY >= absX * verticalityRatio) {
    if (zone === 'left') return { kind: 'gesture', gesture: 'brightness', zone };
    if (zone === 'right') return { kind: 'gesture', gesture: 'volume', zone };
    return { kind: 'none' };
  }
  if (absX >= startThresholdPx && absX > absY * verticalityRatio) return { kind: 'horizontal' };
  return { kind: 'none' };
}

/** Clamp the simulated brightness to the documented range. */
export function clampBrightness(value: number): number {
  if (!Number.isFinite(value)) return BRIGHTNESS_MAX;
  return Math.min(BRIGHTNESS_MAX, Math.max(BRIGHTNESS_MIN, value));
}

/** Delta (in value units) for a drag: up = increase, down = decrease. */
export function dragDelta(dyPx: number, sweepPx = GESTURE_SWEEP_PX): number {
  if (!Number.isFinite(dyPx) || !Number.isFinite(sweepPx) || sweepPx <= 0) return 0;
  return -dyPx / sweepPx;
}

/**
 * Overlay dim (0 = transparent) for a simulated brightness value. Linear in
 * the missing brightness, bounded by BRIGHTNESS_MAX_DIM so the video never
 * disappears entirely.
 */
export function brightnessDimOpacity(brightness: number): number {
  const clamped = clampBrightness(brightness);
  return Math.round((1 - clamped) / (1 - BRIGHTNESS_MIN) * BRIGHTNESS_MAX_DIM * 1000) / 1000;
}

/** Compact indicator percentage for the current value (whole numbers). */
export function gestureIndicatorPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(Math.min(1, Math.max(0, value)) * 100);
}

/** Selector matching every interactive surface a gesture must never own. */
const INTERACTIVE_SELECTOR = 'button, input, select, textarea, a, label, [role="button"], [role="slider"], [contenteditable="true"]';

export type GestureControllerOptions = {
  /** The surface the listeners attach to (the player root). */
  surface: HTMLElement;
  /**
   * Consulted on EVERY touchstart — when false the event is ignored. The
   * shell passes the touch-lock / direct-source / sheet-state gate here, so
   * state changes take effect without re-attaching listeners.
   */
  enabled: () => boolean;
  /** Brightness change (value delta, up = positive). */
  onBrightnessDelta: (delta: number) => void;
  /** Volume change (value delta, up = positive). */
  onVolumeDelta: (delta: number) => void;
  /** A recognized gesture started (kind) — the shell shows the indicator. */
  onGestureStart: (gesture: GestureKind) => void;
  /** The active gesture ended (kind, accumulated delta). */
  onGestureEnd: (gesture: GestureKind, totalDelta: number) => void;
  /** Surface width provider (overridable for tests). */
  surfaceWidth?: () => number;
};

export type PlayerGestureController = {
  destroy: () => void;
};

/**
 * Attach the gesture controller to a surface. Idempotent per instance: the
 * listener set is stored so destroy() removes exactly what was added.
 */
export function createPlayerGestureController(options: GestureControllerOptions): PlayerGestureController {
  const { surface, enabled, onBrightnessDelta, onVolumeDelta, onGestureStart, onGestureEnd } = options;
  const surfaceWidth = options.surfaceWidth ?? (() => surface.clientWidth || (typeof window !== 'undefined' ? window.innerWidth : 0));

  let activeTouchId: number | null = null;
  let startX = 0;
  let startY = 0;
  let zone: GestureZone = 'none';
  let classified: GestureClassification = { kind: 'none' };
  let totalDelta = 0;

  function reset() {
    activeTouchId = null;
    startX = 0;
    startY = 0;
    zone = 'none';
    classified = { kind: 'none' };
    totalDelta = 0;
  }

  function handleTouchStart(event: TouchEvent) {
    if (!enabled()) return;
    if (activeTouchId !== null) return; // one gesture at a time
    const touch = event.changedTouches[0];
    if (!touch) return;
    // Never own a gesture that begins on an interactive control. The Element
    // guard keeps the module safe in non-DOM runtimes (SSR / unit tests).
    const target = event.target;
    if (typeof Element !== 'undefined' && target instanceof Element && target.closest(INTERACTIVE_SELECTOR)) return;
    activeTouchId = touch.identifier;
    startX = touch.clientX;
    startY = touch.clientY;
    zone = gestureZoneForStart(startX, surfaceWidth());
    classified = { kind: 'none' };
    totalDelta = 0;
  }

  function handleTouchMove(event: TouchEvent) {
    if (activeTouchId === null) return;
    const touch = Array.from(event.changedTouches).find((candidate) => candidate.identifier === activeTouchId);
    if (!touch) return;
    const dx = touch.clientX - startX;
    const dy = touch.clientY - startY;
    if (classified.kind === 'none') {
      const next = classifyDrag(dx, dy, zone);
      if (next.kind === 'none') return;
      if (next.kind === 'horizontal') {
        // A horizontal drag is never a Mavero action — stop tracking it but
        // let the browser own the event (no preventDefault below).
        reset();
        return;
      }
      classified = next;
      totalDelta = 0;
      onGestureStart(next.gesture);
    }
    if (classified.kind === 'gesture') {
      // The gesture owns vertical movement — prevent scrolling/overscroll
      // interference while it is active.
      if (event.cancelable) event.preventDefault();
      const delta = dragDelta(dy);
      const applied = delta - totalDelta;
      totalDelta = delta;
      if (classified.gesture === 'brightness') onBrightnessDelta(applied);
      else onVolumeDelta(applied);
    }
  }

  function handleTouchEnd(event: TouchEvent) {
    if (activeTouchId === null) return;
    const touch = Array.from(event.changedTouches).find((candidate) => candidate.identifier === activeTouchId);
    if (!touch) return;
    // Capture the classification BEFORE reset() clears it (narrowing must be
    // done against the discriminated union itself, not a boolean flag).
    const wasGesture = classified.kind === 'gesture' ? classified.gesture : null;
    const delta = totalDelta;
    reset();
    if (wasGesture) onGestureEnd(wasGesture, delta);
  }

  surface.addEventListener('touchstart', handleTouchStart, { passive: true });
  surface.addEventListener('touchmove', handleTouchMove, { passive: false });
  surface.addEventListener('touchend', handleTouchEnd, { passive: true });
  surface.addEventListener('touchcancel', handleTouchEnd, { passive: true });

  return {
    destroy() {
      surface.removeEventListener('touchstart', handleTouchStart);
      surface.removeEventListener('touchmove', handleTouchMove);
      surface.removeEventListener('touchend', handleTouchEnd);
      surface.removeEventListener('touchcancel', handleTouchEnd);
    },
  };
}

// ---------------------------------------------------------------------------
// Round 53 (F1b) — DESKTOP WHEEL gestures: the SAME brightness/volume control
// the touch swipe owns, driven by the mouse wheel over the player surface.
//
//   * LEFT half of the surface → simulated BRIGHTNESS down/up;
//   * RIGHT half               → VOLUME down/up;
//   * wheel UP (negative deltaY) increases, wheel DOWN decreases — ≈2% of the
//     HUD range per notch (WHEEL_STEP), clamped 0–100 by the very SAME
//     handlers the touch path already feeds (clampBrightness / setVolume);
//   * `preventDefault()` on every owned notch so the page does not scroll
//     while the pointer is over the player (the shell gates the controller
//     OFF while a sheet is open, so a scrolling sheet body keeps scrolling);
//   * ONE HUD (the shell's gesture indicator) — onGestureStart shows it,
//     a quiet period of WHEEL_GESTURE_END_MS after the last notch ends the
//     gesture (onGestureEnd → the shell's ~600ms fade-out);
//   * The controller is created ONLY on `(pointer: fine)` devices (the shell's
//     matchMedia gate) — never on touch devices, where the swipe owns it.
// ---------------------------------------------------------------------------

/** Wheel step per notch in VALUE units (≈2% of the HUD range — matches the touch feel). */
export const WHEEL_STEP = 0.02;
/** The wheel split is the LEFT HALF vs the RIGHT HALF of the surface. */
export const WHEEL_ZONE_FRACTION = 0.5;
/** Quiet period (ms) after the last wheel notch that ends a wheel gesture. */
export const WHEEL_GESTURE_END_MS = 250;

/** Pure: which half of the surface the pointer is on for the wheel gesture. */
export function wheelZoneForX(x: number, surfaceWidth: number, zoneFraction = WHEEL_ZONE_FRACTION): GestureZone {
  if (!Number.isFinite(x) || !Number.isFinite(surfaceWidth) || surfaceWidth <= 0) return 'none';
  if (x < surfaceWidth * zoneFraction) return 'left';
  return 'right';
}

/** Pure: one wheel notch's value delta (up = positive, down = negative). */
export function wheelDelta(deltaY: number, step = WHEEL_STEP): number {
  if (!Number.isFinite(deltaY) || !Number.isFinite(step) || step <= 0 || deltaY === 0) return 0;
  return deltaY < 0 ? step : -step;
}

export type WheelGestureControllerOptions = {
  /** The surface the listener attaches to (the player root). */
  surface: HTMLElement;
  /** Consulted on EVERY wheel notch — when false the event is fully ignored. */
  enabled: () => boolean;
  /** Brightness change (value delta, up = positive) — the SAME handler touch feeds. */
  onBrightnessDelta: (delta: number) => void;
  /** Volume change (value delta, up = positive) — the SAME handler touch feeds. */
  onVolumeDelta: (delta: number) => void;
  /** A wheel gesture started (kind) — the SAME HUD the swipe shows. */
  onGestureStart: (gesture: GestureKind) => void;
  /** The wheel gesture ended (kind, accumulated delta). */
  onGestureEnd: (gesture: GestureKind, totalDelta: number) => void;
  /** Step per notch in value units (defaults to WHEEL_STEP). */
  step?: number;
  /** Surface width provider (overridable for tests). */
  surfaceWidth?: () => number;
};

/**
 * Attach the desktop wheel-gesture controller to a surface. Same idempotent
 * listener contract as the swipe/tap controllers; destroy() ends any active
 * gesture (the HUD hides through the shell's own end path) and removes the
 * listener exactly once.
 */
export function createPlayerWheelController(options: WheelGestureControllerOptions): PlayerGestureController {
  const { surface, enabled, onBrightnessDelta, onVolumeDelta, onGestureStart, onGestureEnd } = options;
  const step = options.step ?? WHEEL_STEP;
  const surfaceWidth = options.surfaceWidth ?? (() => surface.clientWidth || (typeof window !== 'undefined' ? window.innerWidth : 0));

  let active: { gesture: GestureKind; totalDelta: number } | null = null;
  let endTimer: ReturnType<typeof setTimeout> | undefined;

  function clearEndTimer() {
    if (endTimer !== undefined) {
      clearTimeout(endTimer);
      endTimer = undefined;
    }
  }

  function endGesture() {
    clearEndTimer();
    const finished = active;
    active = null;
    if (finished) onGestureEnd(finished.gesture, finished.totalDelta);
  }

  function handleWheel(event: WheelEvent) {
    if (!enabled()) return; // sheets open / locked / casting / embeds — the page keeps scrolling
    if (typeof event.deltaY !== 'number' || event.deltaY === 0) return;
    // The gesture owns the wheel while the pointer is over the player.
    if (event.cancelable) event.preventDefault();
    const gesture: GestureKind = wheelZoneForX(event.clientX, surfaceWidth()) === 'left' ? 'brightness' : 'volume';
    if (!active || active.gesture !== gesture) {
      // A zone switch ends the previous burst first (its HUD hides on its own
      // end path) — one gesture kind at a time.
      endGesture();
      active = { gesture, totalDelta: 0 };
      onGestureStart(gesture);
    }
    const delta = wheelDelta(event.deltaY, step);
    active.totalDelta += delta;
    if (gesture === 'brightness') onBrightnessDelta(delta);
    else onVolumeDelta(delta);
    // The gesture ends after a quiet period (there is no wheel-end event).
    clearEndTimer();
    endTimer = setTimeout(endGesture, WHEEL_GESTURE_END_MS);
  }

  surface.addEventListener('wheel', handleWheel, { passive: false });

  return {
    destroy() {
      endGesture();
      surface.removeEventListener('wheel', handleWheel);
    },
  };
}

// ---------------------------------------------------------------------------
// Player V2 corrections (real-device feedback) — TAP gestures over the video
// surface: double-tap seek (left half = −10 s, right half = +10 s),
// press-and-hold 2× playback, and single-tap play/pause toggle.
//
// Arbitration contract (all unit-tested via the pure helpers):
//   * Taps on interactive surfaces (buttons, sliders, selects, sheets, the
//     seekbar, message cards, the up-next card) never trigger a tap gesture —
//     the shared interactive-target exclusion plus the tap-specific surfaces
//     below.
//   * A touch that moves beyond the tap slop is a DRAG — it dies quietly
//     (the vertical-swipe controller owns it; no preventDefault, no fight).
//   * A hold activates only after HOLD_ACTIVATE_MS of stillness; any second
//     finger, movement, or the touch ending before activation cancels it.
//     Round 58 (J2) — the MOUSE left-button hold arms after
//     MOUSE_HOLD_ACTIVATE_MS of stillness and follows the SAME restore
//     contract (release / pointercancel / pointerleave / drag → onHoldEnd).
//   * A double-tap requires two taps within DOUBLE_TAP_WINDOW_MS on the SAME
//     half; opposite-side taps never seek.
//   * The hold always restores the previous speed through onHoldEnd — on
//     release, cancel, second finger, touchcancel and destroy. The shell
//     additionally restores on lock/cast/source/episode switch/teardown.
//   * Single tap TOGGLES play/pause through onSingleTap — but ONLY after the
//     double-tap window elapses without a second tap (round 52): the action
//     fires DOUBLE_TAP_WINDOW_MS after the tap's touchend, so a double-tap
//     can never cause a spurious toggle (the second tap cancels the pending
//     single-tap timer before it fires). A later touch that becomes a hold or
//     a drag also cancels the pending single tap. While the shell's `enabled`
//     gate is false (touch lock, embed ownership, open sheets, casting) taps
//     stay inert.
// ---------------------------------------------------------------------------

/**
 * Two taps within this window (ms) on the same half form a double-tap. Also
 * the confirmation delay before a single tap's toggle action fires (round 52:
 * the window and the single-tap delay are ONE value so the double-tap can
 * always cancel the pending toggle — 300 ms would have raced a 260 ms
 * single-tap delay).
 */
export const DOUBLE_TAP_WINDOW_MS = 260;
/** Stillness duration (ms) before a press-and-hold activates 2×. */
export const HOLD_ACTIVATE_MS = 500;
/**
 * Stillness duration (ms) before a MOUSE left-button hold activates 2×
 * (round 58 J2 — the desktop twin of the touch hold; shorter because a
 * mouse press is already precise, while the touch window stays 500 ms).
 */
export const MOUSE_HOLD_ACTIVATE_MS = 350;
/** Max movement (px) from the start point for a touch to remain a tap. */
export const TAP_SLOP_PX = 12;

export type TapSide = 'left' | 'right';
export type TapSeekDirection = 'backward' | 'forward';

/** Pure: which half of the surface the tap STARTED on (start-point rule). */
export function tapSideForX(startX: number, surfaceWidth: number): TapSide | null {
  if (!Number.isFinite(startX) || !Number.isFinite(surfaceWidth) || surfaceWidth <= 0) return null;
  return startX < surfaceWidth / 2 ? 'left' : 'right';
}

/** Pure: true while the touch has stayed within the tap slop (a tap, not a drag). */
export function withinTapSlop(dx: number, dy: number, slopPx = TAP_SLOP_PX): boolean {
  if (!Number.isFinite(dx) || !Number.isFinite(dy) || !Number.isFinite(slopPx) || slopPx < 0) return false;
  return Math.abs(dx) <= slopPx && Math.abs(dy) <= slopPx;
}

/** Interactive surfaces a tap gesture must never own (superset of the swipe rule). */
const TAP_EXCLUDE_SELECTOR = `${INTERACTIVE_SELECTOR}, .sheet-overlay, .option-sheet-overlay, .message-card, .completion-card, .loading-card, .gesture-indicator, .seek-feedback, .skip-intro-button, .unlock-fab, .back-fab, .source-chip, .episode-chip, .upnext-card`;

export type TapGestureControllerOptions = {
  /** The surface the listeners attach to (the player root). */
  surface: HTMLElement;
  /**
   * Consulted on EVERY touchstart — when false the event is ignored (touch
   * lock, embed ownership, open sheets, casting). State changes take effect
   * without re-attaching listeners.
   */
  enabled: () => boolean;
  /** A double-tap was recognized (side determines the seek direction). */
  onDoubleTap: (direction: TapSeekDirection) => void;
  /**
   * A SINGLE tap was confirmed: fired only after DOUBLE_TAP_WINDOW_MS elapses
   * without a second tap (round 52 — the shell toggles play/pause here).
   * Optional: consumers without the callback never arm the confirmation
   * timer, so existing integrations keep their exact behavior.
   */
  onSingleTap?: () => void;
  /** The press-and-hold activated (shell switches to 2×). */
  onHoldStart: () => void;
  /** The hold ended (shell restores the exact previous speed). */
  onHoldEnd: () => void;
  /** Wall clock (overridable for tests). */
  now?: () => number;
  /** Surface width provider (overridable for tests). */
  surfaceWidth?: () => number;
};

export type PlayerTapGestureController = {
  /**
   * Force-cancel any pending tap candidate / active hold. The hold's
   * onHoldEnd fires (speed restored) — safe to call at any time.
   */
  cancel: () => void;
  /** Removes every listener and cancels any pending gesture. */
  destroy: () => void;
};

/**
 * Attach the tap-gesture controller to a surface. Idempotent per instance:
 * destroy() removes exactly what was added and cancels pending state.
 */
export function createPlayerTapGestureController(options: TapGestureControllerOptions): PlayerTapGestureController {
  const { surface, enabled, onDoubleTap, onSingleTap, onHoldStart, onHoldEnd } = options;
  const surfaceWidth = options.surfaceWidth ?? (() => surface.clientWidth || (typeof window !== 'undefined' ? window.innerWidth : 0));
  const now = options.now ?? (() => Date.now());

  let activeTouchId: number | null = null;
  let startX = 0;
  let startY = 0;
  let startWidth = 0;
  let holdTimer: ReturnType<typeof setTimeout> | undefined;
  let holdActive = false;
  let lastTapAt = 0;
  let lastTapSide: TapSide | null = null;
  // Round 52 — the pending single-tap confirmation timer. Armed when a tap
  // ends without matching a double-tap; cancelled by the second tap of a
  // double-tap, by any later touchstart (which may still become the second
  // tap, a hold or a drag), and by cancel()/destroy(). When it fires, the
  // single-tap action runs — the double-tap window has fully elapsed.
  let singleTapTimer: ReturnType<typeof setTimeout> | undefined;

  function clearSingleTapTimer() {
    if (singleTapTimer) {
      clearTimeout(singleTapTimer);
      singleTapTimer = undefined;
    }
  }

  function armSingleTapTimer() {
    if (!onSingleTap) return;
    clearSingleTapTimer();
    singleTapTimer = setTimeout(() => {
      singleTapTimer = undefined;
      onSingleTap();
    }, DOUBLE_TAP_WINDOW_MS);
  }

  function clearHoldTimer() {
    if (holdTimer) {
      clearTimeout(holdTimer);
      holdTimer = undefined;
    }
  }

  function endHold() {
    if (!holdActive) return;
    holdActive = false;
    onHoldEnd();
  }

  function cancel() {
    clearHoldTimer();
    // Round 58 (J2) — a pending mouse hold dies with the touch paths too
    // (lock / cast / source switch / destroy cancel every gesture).
    clearPointerHoldTimer();
    // A cancelled pending tap never toggles playback (round 52).
    clearSingleTapTimer();
    endHold();
    activeTouchId = null;
    activePointerId = null;
  }

  function handleTouchStart(event: TouchEvent) {
    if (!enabled()) return;
    if (activeTouchId !== null) {
      // A second finger cancels everything (one gesture at a time — and a
      // hold must never survive a multi-touch interruption).
      cancel();
      return;
    }
    const touch = event.changedTouches[0];
    if (!touch) return;
    const target = event.target;
    if (typeof Element !== 'undefined' && target instanceof Element && target.closest(TAP_EXCLUDE_SELECTOR)) return;
    // A new touch ends any pending single-tap confirmation: it may become the
    // second tap of a double-tap, a hold or a drag — in every one of those
    // cases firing the previous tap's toggle would be wrong (round 52).
    clearSingleTapTimer();
    activeTouchId = touch.identifier;
    startX = touch.clientX;
    startY = touch.clientY;
    startWidth = surfaceWidth();
    clearHoldTimer();
    holdTimer = setTimeout(() => {
      holdTimer = undefined;
      if (activeTouchId === null) return; // touch already ended — never a hold
      holdActive = true;
      onHoldStart();
    }, HOLD_ACTIVATE_MS);
  }

  function handleTouchMove(event: TouchEvent) {
    if (activeTouchId === null) return;
    const touch = Array.from(event.changedTouches).find((candidate) => candidate.identifier === activeTouchId);
    if (!touch) return;
    if (!withinTapSlop(touch.clientX - startX, touch.clientY - startY)) {
      // The touch became a drag/swipe — the vertical-swipe controller owns
      // it. The pending tap/hold dies quietly; no event is claimed.
      cancel();
    }
  }

  function handleTouchEnd(event: TouchEvent) {
    if (activeTouchId === null) return;
    const touch = Array.from(event.changedTouches).find((candidate) => candidate.identifier === activeTouchId);
    if (!touch) return;
    const wasHold = holdActive;
    activeTouchId = null;
    clearHoldTimer();
    if (wasHold) {
      endHold();
      return;
    }
    // A tap (never moved beyond the slop): double-tap detection on the SAME
    // half within the window; opposite sides never combine. A matched
    // double-tap cancels the first tap's pending single-tap toggle; an
    // unmatched tap arms the single-tap confirmation timer (round 52).
    registerTap(startX, startWidth);
  }

  // Round 53 (F1c) — the shared TAP REGISTRATION (used by the touch end above
  // and by the desktop POINTER click below): double-tap detection on the SAME
  // half within DOUBLE_TAP_WINDOW_MS, else the single-tap confirmation timer.
  // One arbitration path — a mouse click behaves exactly like a tap.
  function registerTap(startX: number, startWidth: number) {
    const side = tapSideForX(startX, startWidth);
    if (!side) return;
    const timestamp = now();
    if (lastTapSide === side && timestamp - lastTapAt <= DOUBLE_TAP_WINDOW_MS) {
      lastTapAt = 0;
      lastTapSide = null;
      clearSingleTapTimer();
      onDoubleTap(side === 'left' ? 'backward' : 'forward');
      return;
    }
    lastTapAt = timestamp;
    lastTapSide = side;
    armSingleTapTimer();
  }

  function handleTouchCancel() {
    // The OS interrupted the touch (incoming call, gesture navigation) —
    // never leave a pending tap or an engaged 2× hold behind.
    cancel();
  }

  // -------------------------------------------------------------------------
  // Round 53 (F1c) — DESKTOP MOUSE clicks feed the SAME tap arbitration. The
  // pointer listeners only ever act on `pointerType === 'mouse'` primary
  // presses: touch pointers keep the Touch Events path above, so a tap can
  // never double-fire on hybrid devices. A click that stays within the tap
  // slop registers through the shared registerTap — a single click toggles
  // play/pause after the double-tap window, a double-click seeks ±10 s; a
  // click that becomes a drag (or leaves the surface before release) dies
  // quietly. The same interactive-target exclusion and `enabled` gate apply,
  // so buttons, chips, popovers, cards and locked/embed/cast states stay
  // inert exactly as with touch.
  //
  // Round 58 (J2) — the mouse LEFT-BUTTON HOLD joins the touch hold: after
  // MOUSE_HOLD_ACTIVATE_MS of stillness on the video surface the press
  // activates 2× (onHoldStart → the shell's hold indicator), and release /
  // pointercancel / pointerleave / becoming a drag restores the exact
  // previous speed (onHoldEnd). An activated hold cancels the pending
  // single-tap toggle (a hold can never both speed up AND toggle), and
  // right/middle buttons never start anything (pointerdown's button 0 gate).
  // -------------------------------------------------------------------------
  let activePointerId: number | null = null;
  let pointerStartX = 0;
  let pointerStartY = 0;
  let pointerStartWidth = 0;
  let pointerHoldTimer: ReturnType<typeof setTimeout> | undefined;

  function clearPointerHoldTimer() {
    if (pointerHoldTimer) {
      clearTimeout(pointerHoldTimer);
      pointerHoldTimer = undefined;
    }
  }

  /** Round 58 (J2) — the pointer twin of the touch cancel: every pending
   *  mouse candidate dies (hold timer, single-tap timer) and an ACTIVE hold
   *  restores the previous speed. */
  function pointerCancel() {
    clearPointerHoldTimer();
    clearSingleTapTimer();
    endHold();
    activePointerId = null;
  }

  function handlePointerDown(event: PointerEvent) {
    if (event.pointerType !== 'mouse' || event.button !== 0) return;
    if (!enabled()) return;
    if (activePointerId !== null) return; // one candidate at a time
    const target = event.target;
    if (typeof Element !== 'undefined' && target instanceof Element && target.closest(TAP_EXCLUDE_SELECTOR)) return;
    // A new press ends any pending single-tap confirmation: it may become
    // the second click of a double-click (same arbitration as touch).
    clearSingleTapTimer();
    activePointerId = event.pointerId;
    pointerStartX = event.clientX;
    pointerStartY = event.clientY;
    pointerStartWidth = surfaceWidth();
    // Round 58 (J2) — arm the mouse hold: ~350 ms of stillness on the video
    // surface (never on a control/chip/popover/card — excluded above) and
    // the press becomes a 2× hold.
    clearPointerHoldTimer();
    pointerHoldTimer = setTimeout(() => {
      pointerHoldTimer = undefined;
      if (activePointerId === null) return; // press already ended — never a hold
      // The hold owns this press — a pending single-tap toggle must not fire.
      clearSingleTapTimer();
      holdActive = true;
      onHoldStart();
    }, MOUSE_HOLD_ACTIVATE_MS);
  }

  function handlePointerMove(event: PointerEvent) {
    if (activePointerId === null || event.pointerId !== activePointerId) return;
    if (!withinTapSlop(event.clientX - pointerStartX, event.clientY - pointerStartY)) {
      // The press became a drag — it dies quietly (no click, no toggle, and
      // an active hold restores the speed, exactly like the touch path).
      pointerCancel();
    }
  }

  function handlePointerUp(event: PointerEvent) {
    if (activePointerId === null || event.pointerId !== activePointerId) return;
    activePointerId = null;
    clearPointerHoldTimer();
    if (event.pointerType !== 'mouse' || event.button !== 0) return;
    if (holdActive) {
      // Round 58 (J2) — releasing an active mouse hold restores the exact
      // previous speed and never registers a tap (the hold owned the press).
      endHold();
      return;
    }
    if (!withinTapSlop(event.clientX - pointerStartX, event.clientY - pointerStartY)) return;
    registerTap(pointerStartX, pointerStartWidth);
  }

  function handlePointerLeave(event: PointerEvent) {
    if (activePointerId === null || event.pointerId !== activePointerId) return;
    // The press left the surface before release — never a click; an active
    // hold restores the previous speed (round 58 J2).
    pointerCancel();
  }

  surface.addEventListener('touchstart', handleTouchStart, { passive: true });
  surface.addEventListener('touchmove', handleTouchMove, { passive: true });
  surface.addEventListener('touchend', handleTouchEnd, { passive: true });
  surface.addEventListener('touchcancel', handleTouchCancel, { passive: true });
  surface.addEventListener('pointerdown', handlePointerDown);
  surface.addEventListener('pointermove', handlePointerMove);
  surface.addEventListener('pointerup', handlePointerUp);
  surface.addEventListener('pointercancel', handlePointerLeave);
  surface.addEventListener('pointerleave', handlePointerLeave);

  return {
    cancel,
    destroy() {
      cancel();
      surface.removeEventListener('touchstart', handleTouchStart);
      surface.removeEventListener('touchmove', handleTouchMove);
      surface.removeEventListener('touchend', handleTouchEnd);
      surface.removeEventListener('touchcancel', handleTouchCancel);
      surface.removeEventListener('pointerdown', handlePointerDown);
      surface.removeEventListener('pointermove', handlePointerMove);
      surface.removeEventListener('pointerup', handlePointerUp);
      surface.removeEventListener('pointercancel', handlePointerLeave);
      surface.removeEventListener('pointerleave', handlePointerLeave);
    },
  };
}
