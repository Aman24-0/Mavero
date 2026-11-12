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
 *   * Only touch pointers trigger gestures (Touch Events — desktop mouse
 *     interaction is untouched).
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
// Player V2 corrections (real-device feedback) — TAP gestures over the video
// surface: double-tap seek (left half = −10 s, right half = +10 s) and
// press-and-hold 2× playback.
//
// Arbitration contract (all unit-tested via the pure helpers):
//   * Taps on interactive surfaces (buttons, sliders, selects, sheets, the
//     seekbar, message cards) never trigger a tap gesture — the shared
//     interactive-target exclusion plus the tap-specific surfaces below.
//   * A touch that moves beyond the tap slop is a DRAG — it dies quietly
//     (the vertical-swipe controller owns it; no preventDefault, no fight).
//   * A hold activates only after HOLD_ACTIVATE_MS of stillness; any second
//     finger, movement, or the touch ending before activation cancels it.
//   * A double-tap requires two taps within DOUBLE_TAP_WINDOW_MS on the SAME
//     half; opposite-side taps never seek.
//   * The hold always restores the previous speed through onHoldEnd — on
//     release, cancel, second finger, touchcancel and destroy. The shell
//     additionally restores on lock/cast/source/episode switch/teardown.
//   * Single taps have NO action here (the shell's reveal listeners handle
//     them) — a double-tap can therefore never toggle show/hide twice.
// ---------------------------------------------------------------------------

/** Two taps within this window (ms) on the same half form a double-tap. */
export const DOUBLE_TAP_WINDOW_MS = 300;
/** Stillness duration (ms) before a press-and-hold activates 2×. */
export const HOLD_ACTIVATE_MS = 500;
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
const TAP_EXCLUDE_SELECTOR = `${INTERACTIVE_SELECTOR}, .sheet-overlay, .message-card, .completion-card, .loading-card, .gesture-indicator, .seek-feedback, .skip-intro-button, .unlock-fab, .back-fab, .source-chip, .episode-chip`;

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
  const { surface, enabled, onDoubleTap, onHoldStart, onHoldEnd } = options;
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
    endHold();
    activeTouchId = null;
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
    // half within the window; opposite sides never combine.
    const side = tapSideForX(startX, startWidth);
    if (!side) return;
    const timestamp = now();
    if (lastTapSide === side && timestamp - lastTapAt <= DOUBLE_TAP_WINDOW_MS) {
      lastTapAt = 0;
      lastTapSide = null;
      onDoubleTap(side === 'left' ? 'backward' : 'forward');
      return;
    }
    lastTapAt = timestamp;
    lastTapSide = side;
  }

  function handleTouchCancel() {
    // The OS interrupted the touch (incoming call, gesture navigation) —
    // never leave a pending tap or an engaged 2× hold behind.
    cancel();
  }

  surface.addEventListener('touchstart', handleTouchStart, { passive: true });
  surface.addEventListener('touchmove', handleTouchMove, { passive: true });
  surface.addEventListener('touchend', handleTouchEnd, { passive: true });
  surface.addEventListener('touchcancel', handleTouchCancel, { passive: true });

  return {
    cancel,
    destroy() {
      cancel();
      surface.removeEventListener('touchstart', handleTouchStart);
      surface.removeEventListener('touchmove', handleTouchMove);
      surface.removeEventListener('touchend', handleTouchEnd);
      surface.removeEventListener('touchcancel', handleTouchCancel);
    },
  };
}
