// MAVP-6 (Issue 1) — Client-side unexpected-error reporting.
//
// WHY THIS EXISTS
// ===============
// "MAVERO / 500 — The signal dropped. — Internal Error" on series card-play
// is SvelteKit's UNEXPECTED-ERROR surface: when the watch route's SPA data
// request (`__data.json`) fails at the transport level — a function instance
// dying mid-request, a connection reset, or any non-SvelteKit response — the
// client router renders the generic 500 error page WITHOUT ever reaching a
// server hook. Until MAVP-6 the client had NO `hooks.client.ts` at all, so
// this exact surface left ZERO diagnostics: an occurrence today is invisible
// in both the browser console (nothing structured is emitted) and any server
// log (the failure never travels).
//
// This module is the pure reporting core the new `src/hooks.client.ts`
// `handleError` delegates to. Contract:
//   * NEVER throws — reporting must not break the error page that is already
//     being rendered (the whole body is guarded).
//   * Class-only content: the error's class/name and, when safely derivable,
//     the route id and pathname. NEVER the error message, stack, query string,
//     cookies or any token-bearing value. The route/path lets an operator
//     correlate a client 500 with the server-side stage lines emitted by
//     src/lib/server/content/watch-load-diagnostics.ts.
//   * No network calls: the report is a structured console line (captured by
//     browser diagnostics / any installed client collectors) — reporting must
//     not depend on, or wait for, another endpoint.
//   * Pure and importable under tsx (no $app/* imports), so behavioral tests
//     execute the real reporter.

export type ClientErrorEventHint = {
  routeId?: string | null;
  url?: { pathname?: string | null } | null;
};

export type ClientErrorReport = {
  errorClass: string;
  routeId: string | null;
  path: string | null;
};

/**
 * Derive the safe diagnostic fields for one unexpected client error.
 * Pure — same inputs always yield the same report; never throws.
 */
export function describeClientError(error: unknown, event?: ClientErrorEventHint | null): ClientErrorReport {
  let errorClass = 'unknown';
  try {
    if (error instanceof Error) {
      errorClass = error.name || 'Error';
    } else if (typeof error === 'string' && error.trim()) {
      // SvelteKit can surface thrown non-Error values — class only, never the value.
      errorClass = 'non-error-thrown';
    }
  } catch {
    errorClass = 'unknown';
  }
  let routeId: string | null = null;
  let path: string | null = null;
  try {
    routeId = typeof event?.routeId === 'string' && event.routeId ? event.routeId : null;
    const pathname = event?.url?.pathname;
    path = typeof pathname === 'string' && pathname ? pathname : null;
  } catch {
    routeId = null;
    path = null;
  }
  return { errorClass, routeId, path };
}

/**
 * Emit the safe structured console line for one unexpected client error.
 * NEVER throws and NEVER logs message/stack/query — see the module contract.
 */
export function reportClientUnexpectedError(error: unknown, event?: ClientErrorEventHint | null): void {
  try {
    const report = describeClientError(error, event);
    // One JSON-ish line, mirroring the server logger's field discipline
    // (class-only, no message, no stack, no query).
    console.error(JSON.stringify({
      msg: 'unexpected client error (SvelteKit client router surface)',
      errorClass: report.errorClass,
      routeId: report.routeId,
      path: report.path
    }));
  } catch {
    // Reporting must never break the error page being rendered.
  }
}
