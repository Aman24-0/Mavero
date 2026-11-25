export type HapticKind = 'light' | 'success' | 'destructive';

const patterns: Record<HapticKind, number | number[]> = {
  light: 8,
  success: [10, 18, 10],
  destructive: [16, 28, 16],
};

// Chrome blocks navigator.vibrate() until the user has interacted with the
// page (a "user activation" gesture). Calling it before that triggers a
// console "intervention" error: "Blocked call to navigator.vibrate because
// user hasn't tapped on the frame or any embedded frame yet."
// Track whether the user has interacted and silently skip the vibration if
// they haven't — the Lighthouse Best-Practices "errors-in-console" audit
// flags this intervention.
let userHasInteracted = false;

if (typeof window !== 'undefined') {
  const markInteracted = () => { userHasInteracted = true; };
  // pointerdown covers touch + mouse; keydown covers keyboard. Both use
  // { once: true } so they auto-remove after the first gesture — the flag
  // is permanent for the page lifetime.
  window.addEventListener('pointerdown', markInteracted, { passive: true, once: true });
  window.addEventListener('keydown', markInteracted, { passive: true, once: true });
}

export function haptic(kind: HapticKind = 'light'): boolean {
  if (typeof navigator === 'undefined' || typeof navigator.vibrate !== 'function') return false;
  // Skip silently until the first real user gesture — calling before that
  // triggers Chrome's "intervention" console error.
  if (!userHasInteracted) return false;
  try {
    return navigator.vibrate(patterns[kind]);
  } catch {
    return false;
  }
}
