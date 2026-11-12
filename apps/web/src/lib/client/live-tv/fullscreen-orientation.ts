// LT-16 — Live TV mobile fullscreen orientation lock (coordination only).
//
// PURPOSE: when the Live TV player surface is fullscreen on a phone or
// tablet, request landscape orientation through the Screen Orientation
// API; when that fullscreen ends (or the player component is destroyed),
// release the lock so the device returns to its normal orientation.
// This is a pure ENHANCEMENT: every failure mode — API missing,
// lock() rejected or thrown, lock attempted outside fullscreen,
// desktop machines — degrades to exactly today's behavior. Orientation
// failures are NEVER playback errors and never block fullscreen.
//
// WHY A SEPARATE MODULE: LiveTvPlayer.svelte owns the fullscreen surface
// lifecycle, but the race bookkeeping below (late-resolving lock
// promises, enter/exit interleavings, destruction while pending) is
// stateful coordination that belongs in a pure, Node-testable unit —
// the repo's LT-15 convention (behavioral suites import the real module
// under Node, which also proves SSR import safety). The component wires
// this into its EXISTING fullscreenchange handler: no new listeners, no
// change to how fullscreen itself is requested or exited, no analytics
// change, no VOD player involvement.
//
// MOBILE DETECTION (capability-based, NO user-agent sniffing): a lock is
// attempted ONLY when ALL of these hold:
//   * screen.orientation exists and exposes lock() — the Screen
//     Orientation API. Absent on iOS/iPadOS Safari, where the
//     enhancement silently no-ops (fullscreen still works);
//   * matchMedia('(pointer: coarse)').matches — the PRIMARY pointer is
//     touch, i.e. a phone/tablet form factor. Desktop machines (fine
//     primary pointer) never attempt a lock — including touch-screen
//     laptops — per the directive that desktop fullscreen behavior must
//     remain untouched. This is the narrowly scoped mobile guard and
//     the reason it exists: without it, desktop Chrome would receive
//     orientation-lock calls that always reject;
//   * navigator.maxTouchPoints > 0 — belt-and-braces touch confirmation
//     (defends against exotic matchMedia results on set-top boxes).
//
// RACE SAFETY (the reason this module exists as a unit):
//   * A generation counter invalidates in-flight lock promises. A lock
//     that resolves after fullscreen exited (or after the component was
//     destroyed) is answered with a defensive unlock() — a late resolve
//     can re-apply a lock the exit path already released.
//   * A late resolve from an OLD session while a NEW fullscreen session
//     holds its own lock does NOT unlock — the newest lock governs.
//   * noteFullscreenGained is idempotent (duplicate fullscreenchange
//     events cannot stack lock attempts); noteFullscreenLost and
//     dispose() release everything and are safe to call repeatedly.
//   * lock()/unlock() are each wrapped: synchronous throws and rejected
//     promises are swallowed. No unhandled rejection can escape.
//
// SECURITY: no console calls, no storage, no network, no user data —
// only the Screen Orientation API and capability probes.

/**
 * The slice of `screen.orientation` this coordinator uses. Structural on
 * purpose: lock/unlock are OPTIONAL per browser (older Safari exposes
 * neither), and tests inject plain doubles.
 */
export interface LiveTvOrientationLike {
  /** Requests an orientation lock. Rejects when unsupported/declined. */
  lock?: (orientation: 'landscape') => Promise<void> | void;
  /** Releases a lock previously acquired through lock(). Safe no-op. */
  unlock?: () => void;
}

/**
 * Browser-capability surface the coordinator reads (injectable for
 * tests; the default reads the real globals lazily, never at import).
 */
export interface LiveTvOrientationEnv {
  /** `screen.orientation` if the browser exposes it. */
  orientation?: LiveTvOrientationLike | null;
  /** `window.matchMedia` if available (capability probes only). */
  matchMedia?: ((query: string) => { matches: boolean }) | null;
  /** `navigator.maxTouchPoints` if available. */
  maxTouchPoints?: number | null;
}

/**
 * Builds the real browser environment. SSR/Node-safe: with no `window`
 * global it returns an empty environment (no browser API is touched),
 * which makes every coordinator a harmless no-op on the server.
 */
export function defaultLiveTvOrientationEnv(): LiveTvOrientationEnv {
  if (typeof window === 'undefined') return {};
  const scope = window as Window & typeof globalThis;
  const orientation: LiveTvOrientationLike | null | undefined =
    scope.screen && scope.screen.orientation ? scope.screen.orientation : undefined;
  const matchMedia =
    typeof scope.matchMedia === 'function'
      ? (query: string) => scope.matchMedia(query)
      : undefined;
  const touchPoints =
    typeof scope.navigator?.maxTouchPoints === 'number' ? scope.navigator.maxTouchPoints : undefined;
  return { orientation, matchMedia, maxTouchPoints: touchPoints };
}

/**
 * Capability gate: should a landscape lock be ATTEMPTED at all here?
 *
 * True only on touch-primary devices (phones/tablets) that expose the
 * Screen Orientation API. False on every desktop (fine primary pointer,
 * even with a touch screen) and on browsers without lock support
 * (iOS/iPadOS Safari) — those keep today's fullscreen behavior exactly.
 * Pure function; never throws.
 */
export function canAttemptLandscapeLock(env: LiveTvOrientationEnv): boolean {
  if (typeof env.orientation?.lock !== 'function') return false; // no Screen Orientation API
  if (typeof env.matchMedia !== 'function') return false; // no capability probe possible
  let coarsePrimaryPointer = false;
  try {
    coarsePrimaryPointer = Boolean(env.matchMedia('(pointer: coarse)').matches);
  } catch {
    return false;
  }
  const touchPoints =
    typeof env.maxTouchPoints === 'number' && Number.isFinite(env.maxTouchPoints)
      ? env.maxTouchPoints
      : 0;
  return coarsePrimaryPointer && touchPoints > 0;
}

/** The coordinator the player component drives from its fullscreenchange handler. */
export interface LiveTvFullscreenOrientationCoordinator {
  /** Our player surface became fullscreen (or an element inside it did — the embed iframe path). */
  noteFullscreenGained(): void;
  /** Our player surface is no longer fullscreen (exit, or fullscreen moved elsewhere). */
  noteFullscreenLost(): void;
  /** Component teardown: release everything and ignore all future events. Idempotent. */
  dispose(): void;
}

/**
 * Creates the fullscreen-orientation coordinator. All orientation work
 * happens inside the callbacks below; construction itself touches no
 * browser API when `env` is supplied (tests) — and with the default env
 * it only READS capability surfaces, all of which are SSR-guarded.
 */
export function createLiveTvFullscreenOrientationCoordinator(
  env: LiveTvOrientationEnv = defaultLiveTvOrientationEnv()
): LiveTvFullscreenOrientationCoordinator {
  const capable = canAttemptLandscapeLock(env);
  let generation = 0; // invalidates stale async lock resolutions
  let fullscreenActive = false;
  let lockInFlight = false; // a lock() promise has not settled yet
  let lockedByUs = false; // a lock() promise RESOLVED (we hold a lock)
  let disposed = false;

  /** unlock() wrapped: never throws, always clears the held-lock flag. */
  function safeUnlock(): void {
    lockedByUs = false;
    try {
      env.orientation?.unlock?.();
    } catch {
      // unlock() is specified as a no-op when nothing is locked; a throw
      // means it is unsupported here — either way there is nothing to do.
    }
  }

  /** Fire-and-forget landscape lock with full stale-resolution handling. */
  function attemptLandscapeLock(): void {
    const myGeneration = generation;
    const lock = env.orientation?.lock;
    if (typeof lock !== 'function') return;
    lockInFlight = true;
    let promise: Promise<void>;
    try {
      promise = Promise.resolve(lock.call(env.orientation, 'landscape'));
    } catch {
      // Synchronous throw (some engines throw instead of rejecting).
      lockInFlight = false;
      return;
    }
    promise.then(
      () => {
        lockInFlight = false;
        if (disposed || myGeneration !== generation) {
          // STALE resolution: fullscreen already ended (or moved to a new
          // session) while this promise was in flight. If we are no
          // longer fullscreen — or the component is gone — a late resolve
          // can re-apply a lock the exit path already released, so unlock
          // defensively. If a NEWER fullscreen session is active, its own
          // lock attempt governs and must not be disturbed.
          if (!fullscreenActive || disposed) safeUnlock();
          return;
        }
        lockedByUs = true;
      },
      () => {
        // Rejected: unsupported on this device/browser, the OS rotation
        // lock is held, or fullscreen ended before the lock applied.
        // Orientation locking is an enhancement — swallow, never rethrow.
        lockInFlight = false;
      }
    );
  }

  return {
    noteFullscreenGained(): void {
      if (disposed || fullscreenActive) return; // no-op when dead or already active
      generation += 1;
      fullscreenActive = true;
      if (capable) attemptLandscapeLock();
    },

    noteFullscreenLost(): void {
      if (disposed) return; // dispose() already released everything
      generation += 1; // invalidate any in-flight lock promise
      fullscreenActive = false;
      // Release the lock if we hold one or if an attempt is still pending
      // (the pending promise's stale-resolution branch re-asserts this).
      if (lockInFlight || lockedByUs) safeUnlock();
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      generation += 1; // invalidate any in-flight lock promise
      fullscreenActive = false;
      if (lockInFlight || lockedByUs) safeUnlock();
    }
  };
}
