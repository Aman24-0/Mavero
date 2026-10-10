/**
 * Player startup instrumentation — MAVERO player redesign (Phase 1).
 *
 * Narrowly-scoped milestone timing for the watch-route playback lifecycle.
 * Uses the browser Performance API only; no URLs, tokens, session secrets,
 * provider endpoints or personal data are ever recorded — milestone names
 * and durations only.
 *
 * Milestones (in expected order):
 *   mavero:play              — Play link activated on a detail page
 *   mavero:shell             — PlayerShell mounted (player shell visible)
 *   mavero:resolver-request  — POST /api/playback/resolve dispatched
 *   mavero:resolver-response — resolver response received (headers read)
 *   mavero:iframe-mounted    — embed <iframe> entered the DOM (URL ready)
 *   mavero:iframe-load       — embed iframe fired `load`
 *
 * An iframe `load` event is NOT proof of provider playback — the shell
 * treats it as an embed-DOM signal only (existing behaviour, preserved).
 *
 * Durations are surfaced through performance.measure + a DEV-only
 * console.debug; production builds stay silent (marks are still recorded
 * so a performance panel can inspect them).
 */

export type PlayerTimingMilestone =
  | 'mavero:play'
  | 'mavero:shell'
  | 'mavero:resolver-request'
  | 'mavero:resolver-response'
  | 'mavero:iframe-mounted'
  | 'mavero:iframe-load';

const MEASURE_SUFFIX = '_since_play';

function performanceAvailable(): boolean {
  return typeof window !== 'undefined' && typeof performance !== 'undefined' && typeof performance.mark === 'function';
}

/** Record a lifecycle milestone. Safe no-op outside the browser. */
export function markPlayerMilestone(milestone: PlayerTimingMilestone): void {
  if (!performanceAvailable()) return;
  try {
    performance.mark(milestone);
  } catch {
    // Some engines throw on duplicate/invalid marks — instrumentation must never break playback.
  }
}

/**
 * Measure the canonical startup spans from the play-click mark. Returns the
 * durations in ms (null when the endpoint mark or the play mark is missing).
 * DEV-only console.debug surfacing — no production logging.
 */
export function measurePlayerStartup(): Record<string, number | null> {
  const spans: Record<string, number | null> = {};
  if (!performanceAvailable()) return spans;
  const endpoints: PlayerTimingMilestone[] = [
    'mavero:shell',
    'mavero:resolver-request',
    'mavero:resolver-response',
    'mavero:iframe-mounted',
    'mavero:iframe-load',
  ];
  for (const endpoint of endpoints) {
    const name = `${endpoint}${MEASURE_SUFFIX}`;
    try {
      // Remove an existing measure of the same name first (idempotent re-runs).
      performance.measure(name, 'mavero:play', endpoint);
      const entries = performance.getEntriesByName(name);
      const last = entries[entries.length - 1];
      spans[name] = last ? Math.round(last.duration * 10) / 10 : null;
    } catch {
      spans[name] = null; // play mark absent (deep link) or endpoint not reached
    }
  }
  if (import.meta.env.DEV) {
    const reached = Object.entries(spans)
      .filter(([, value]) => value !== null)
      .map(([name, value]) => `${name}=${value}ms`)
      .join(' ');
    if (reached) console.debug(`[player-startup] ${reached}`);
  }
  return spans;
}
