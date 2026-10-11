/**
 * Landscape-first playback presentation — MAVP-2 Phase 1.
 *
 * ROOT CAUSE (audited): the previous implementation attempted the landscape
 * presentation (fullscreen + `screen.orientation.lock('landscape')`) from
 * PlayerShell's onMount — AFTER the watch route's async server data load.
 * `requestFullscreen()` requires TRANSIENT USER ACTIVATION, which browsers
 * expire after ~5 seconds (Chrome) or on the next task boundary. When the
 * route load was slow (typical for content-card entries, which have no
 * hover-preloaded route data, and intermittent for detail-page entries on
 * mobile networks), the activation had already expired by the time the shell
 * mounted → the fullscreen request was rejected → the player stayed in
 * portrait. Entry-point inconsistency was a TIMING artifact, not a
 * lifecycle difference: both entries navigate to the same /watch route.
 *
 * FIX: the presentation is initiated at the PLAY CLICK — the point of
 * freshest, guaranteed user activation — synchronously inside the click
 * handler, on an element that already exists (document.documentElement).
 * A short-lived intent marker (sessionStorage, TTL-bounded) lets the shell
 * ADOPT the already-active presentation at mount instead of issuing
 * duplicate fullscreen/orientation requests. The shell's existing
 * mount-time attempt remains as the fallback for entries without a click
 * (e.g. the programmatic `?autoplay=1` navigation), exactly as before.
 *
 * Every step is best-effort and silent: unsupported platforms (iOS Safari),
 * declined locks, and expired activations fall back to the visible
 * Landscape control. Desktop/TV devices are never eligible. No iframe is
 * touched; orientation changes are CSS + Screen Orientation API only.
 */

const INTENT_STORAGE_KEY = 'mavero:landscape-first-intent';
/** Intent TTL — must comfortably exceed a slow route load but expire before
 *  an unrelated later Play click could inherit a stale presentation. */
const INTENT_TTL_MS = 15_000;

export type LandscapeFirstDeviceType = string | null | undefined;

type OrientationControllerLike = ScreenOrientation & {
  lock?: (value: 'landscape') => Promise<void>;
  unlock?: () => void;
};

/**
 * Landscape-first eligibility — shared by the click-time helper and the
 * shell's mount fallback so both paths apply IDENTICAL gates:
 * mobile/tablet-class devices (server-derived UA class) currently held in
 * portrait with a coarse pointer. Desktop and TV are never eligible.
 */
export function landscapeFirstEligible(deviceType: LandscapeFirstDeviceType): boolean {
  if (deviceType !== 'mobile' && deviceType !== 'tablet') return false;
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  try {
    return window.matchMedia('(orientation: portrait)').matches && window.matchMedia('(pointer: coarse)').matches;
  } catch {
    return false;
  }
}

/**
 * Initiate the landscape presentation at PLAY-CLICK time (freshest transient
 * user activation). Best-effort: fullscreen on the document element, then the
 * landscape orientation lock once fullscreen is granted. Every failure is
 * silently swallowed — the shell's mount attempt and the Landscape control
 * remain the fallbacks. Records a TTL-bounded intent marker so the shell can
 * adopt the presentation instead of re-requesting it.
 */
export function requestLandscapeFirstPresentation(deviceType: LandscapeFirstDeviceType): void {
  if (!landscapeFirstEligible(deviceType)) return;
  try {
    sessionStorage.setItem(INTENT_STORAGE_KEY, String(Date.now()));
  } catch { /* storage unavailable — the shell still adopts via fullscreen state */ }
  try {
    const element = document.documentElement;
    const request = element?.requestFullscreen?.bind(element);
    if (!request) return; // e.g. iOS Safari — no element fullscreen; honest fallback
    void Promise.resolve(request())
      .then(() => {
        const orientation = (typeof screen !== 'undefined' ? screen.orientation : undefined) as OrientationControllerLike | undefined;
        return orientation?.lock?.('landscape');
      })
      .catch(() => { /* declined (expired activation, unsupported platform) — graceful fallback */ });
  } catch { /* presentation is optional — never block the Play navigation */ }
}

/**
 * Consume the intent marker (shell mount). Returns true only when a fresh
 * (TTL-bounded) intent exists. The marker is always cleared — consumed
 * intents can never leak into a later, unrelated Play entry.
 */
export function consumeLandscapeFirstIntent(): boolean {
  try {
    const raw = sessionStorage.getItem(INTENT_STORAGE_KEY);
    sessionStorage.removeItem(INTENT_STORAGE_KEY);
    if (!raw) return false;
    const at = Number(raw);
    if (!Number.isFinite(at)) return false;
    const age = Date.now() - at;
    return age >= 0 && age <= INTENT_TTL_MS;
  } catch {
    return false;
  }
}

/** Test seam: whether an intent marker is currently stored (no TTL check). */
export function landscapeFirstIntentStored(): boolean {
  try {
    return sessionStorage.getItem(INTENT_STORAGE_KEY) !== null;
  } catch {
    return false;
  }
}
