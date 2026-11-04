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
// server-side migration phase removes them — nothing here deletes or
// bypasses them.

// ── Phase 4 (server-event migration): pending auth events ──────────
//
// The old `login` / `signup_completed` events were SERVER-fired (the
// auth actions saw the Supabase response directly). The auth forms are
// plain POST forms (no `use:enhance`), so the client never observes the
// auth response — but the post-auth redirect DOES land on a freshly
// hydrated document whose sessionStorage still belongs to the same tab.
//
// The contract, therefore:
//   1. The sign-in page marks 'login', the sign-up page marks
//      'signup_completed' when the visitor submits (password or Google —
//      the marker is set synchronously in the submit handler, BEFORE the
//      browser navigates). It survives the OAuth roundtrip too.
//   2. The root layout's $effect consumes the marker the moment
//      `data.isAuthenticated` is true and emits the event through
//      umamiTrack. Consume-on-read makes it fire exactly once.
//
// An already-authenticated user who merely refreshes a page has NO
// marker → no spurious 'login' events. A failed submit leaves the
// marker until the next successful submit overwrites it (same-tab
// sessionStorage, so it cannot leak across tabs or devices).

const PENDING_AUTH_EVENT_KEY = 'mavero:umami-pending-auth-event';

export type PendingUmamiAuthEvent = 'login' | 'signup_completed';

/**
 * Record the auth event that should fire once the post-auth redirect
 * lands. Fire-and-forget by contract: sessionStorage may be unavailable
 * (privacy mode, SSR) — the marker is a best-effort analytics hint and
 * must never break the auth flow.
 */
export function markPendingUmamiAuthEvent(eventName: PendingUmamiAuthEvent): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.setItem(PENDING_AUTH_EVENT_KEY, eventName);
  } catch {
    // Private-browsing quota / storage-disabled — analytics only, ignore.
  }
}

/**
 * Read and CLEAR the pending auth marker. Returns null when no marker is
 * pending (including the already-authenticated-refresh case) — callers
 * emit nothing in that case. Consume-on-read guarantees at-most-once.
 */
export function consumePendingUmamiAuthEvent(): PendingUmamiAuthEvent | null {
  if (typeof window === 'undefined') return null;
  try {
    const value = window.sessionStorage.getItem(PENDING_AUTH_EVENT_KEY);
    if (value !== 'login' && value !== 'signup_completed') return null;
    window.sessionStorage.removeItem(PENDING_AUTH_EVENT_KEY);
    return value;
  } catch {
    return null;
  }
}

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
