// MAVP-6 (Issue 1) — Client-side SvelteKit error hook.
//
// SvelteKit renders "+error.svelte" with the generic status 500 / message
// "Internal Error" whenever an UNEXPECTED error escapes the client router —
// including the SPA navigation failure this task's Issue 1 reports: the
// watch route's `__data.json` request failing at the transport level (a
// Netlify function instance dying mid-request or a connection reset produces
// exactly the reported "MAVERO / 500 — The signal dropped. — Internal
// Error" screen while a retry (fresh instance) succeeds).
//
// Until MAVP-6 this project had NO hooks.client.ts, so that surface left
// zero diagnostics. This hook adds the missing trace WITHOUT changing any
// user-visible behavior:
//   * The hook returns void — SvelteKit's default error page handling
//     (status/message semantics, +error.svelte rendering, retry affordances)
//     is preserved byte-for-byte. Nothing is masked or re-typed.
//   * All reporting work is delegated to the pure reporter
//     ($lib/client/error-reporting) — class-only, no message/stack/query,
//     never throws, no network calls.
//   * No new dependencies, no $app/* imports — the module stays importable
//     under tsx so behavioral tests execute the REAL hook.
//
// SECURITY: never logs tokens, cookies, session material, the error message,
// or the stack. The route id + pathname are the correlation keys.

import { reportClientUnexpectedError } from '$lib/client/error-reporting';

type ClientHandleErrorInput = {
  error: unknown;
  event?: { routeId?: string | null; url?: URL | { pathname?: string | null } | null } | null;
};

export const handleError = (input: ClientHandleErrorInput): void => {
  // Defensive field extraction — the hook must tolerate any event shape
  // SvelteKit hands it (route hooks run during failure paths; assuming a
  // shape here would risk a secondary exception inside the error handler).
  let event: { routeId?: string | null; url?: { pathname?: string | null } | null } | null = null;
  try {
    const rawEvent = input?.event;
    if (rawEvent && typeof rawEvent === 'object') {
      event = {
        routeId: typeof rawEvent.routeId === 'string' ? rawEvent.routeId : null,
        url: rawEvent.url instanceof URL
          ? { pathname: rawEvent.url.pathname }
          : rawEvent.url && typeof rawEvent.url === 'object' && typeof (rawEvent.url as { pathname?: unknown }).pathname === 'string'
            ? { pathname: (rawEvent.url as { pathname: string }).pathname }
            : null
      };
    }
  } catch {
    event = null;
  }
  reportClientUnexpectedError(input?.error, event);
  // Returning void deliberately: SvelteKit's default status/message handling
  // (500 + "Internal Error" for unexpected errors) stays exactly as before.
};
