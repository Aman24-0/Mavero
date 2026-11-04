// Umami Cloud migration (Phase 3 — Event Migration, Client-Side).
//
// The old client pipeline (the dispatcher queueing batches to /api/events)
// is being replaced by Umami Cloud: the official script (loaded in
// src/app.html from cloud.umami.is, id injected from the
// PUBLIC_UMAMI_WEBSITE_ID env var) records page views automatically and
// exposes `window.umami.track(name, payload)` for custom events.
//
// This helper is the ONLY way app code touches Umami:
//   * SSR-SAFE  — `typeof window` guard: calls no-op during server render.
//   * LOAD-SAFE — the script is `defer`red; until it has loaded (or if it
//     is blocked by an ad-blocker / the env id is unset) `window.umami` is
//     simply absent and every call is a silent no-op. It can never throw
//     and never block playback — the exact reliability contract the old
//     dispatcher gave us.
//   * CONTRACT-STABLE — event names and payloads are UNCHANGED from the
//     Phase 1 taxonomy (src/lib/shared/analytics-taxonomy.ts), so the
//     admin dashboard (Phase 5) and any downstream consumer keep working.
//
// The backend dispatcher + /api/events ingest stay in place until the
// server-side migration phase (Phase 4/6) removes them — nothing here
// deletes or bypasses them.

/** The minimal slice of the Umami Cloud script API we rely on. */
type UmamiClient = {
  track: (eventName: string, data?: Record<string, unknown>) => void;
};

/** The `window.umami` global installed by the Umami Cloud script, or null. */
function umamiClient(): UmamiClient | null {
  if (typeof window === 'undefined') return null;
  return (window as unknown as { umami?: UmamiClient }).umami ?? null;
}

/**
 * Track a custom event with Umami Cloud. Fire-and-forget by contract:
 * never throws, never queues, never blocks — if Umami is not loaded yet
 * (or blocked) the event is simply dropped, exactly like the old
 * dispatcher's disabled-state no-op.
 */
export function umamiTrack(eventName: string, data?: Record<string, unknown>): void {
  umamiClient()?.track(eventName, data);
}
