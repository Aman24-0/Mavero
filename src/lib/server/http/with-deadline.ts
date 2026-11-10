/**
 * Production-hardening round (2026-11) — STALL protection for load-path
 * Supabase reads.
 *
 * THE PROBLEM: every Supabase read in a SvelteKit load function is awaited
 * by the router. An ERROR is already handled everywhere (each helper and
 * caller has a documented fail-safe / fail-closed fallback), but a STALL —
 * a socket that never answers (flaky mobile network, half-open connection,
 * a wedged PostgREST edge) — is neither a resolution nor a rejection: the
 * promise stays pending FOREVER, the load function never returns, and the
 * SvelteKit router waits indefinitely. The user sees an infinite spinner
 * (the exact "navigation hangs / spinner never finishes" report) because
 * there is no socket-level timeout in supabase-js by default.
 *
 * THE FIX: race the read against a deadline. If the deadline wins, the
 * promise is abandoned (NOT cancelled — supabase-js will still settle it
 * eventually and its result is simply ignored) and the caller receives the
 * documented fallback:
 *   * value fallback  — the helper's own fail-safe shape (e.g. the all-null
 *     AppConfig);
 *   * throwing fallback — for helpers whose ERRORS are already caught by
 *     callers (public config → EMPTY_STREAMING_CONFIG; adult gate → the
 *     fail-closed 404). A stall then degrades EXACTLY like an error, which
 *     is the existing, documented contract.
 *
 * Unhandled-rejection safety: when the deadline wins, a rejection arriving
 * later on the abandoned promise would surface as an unhandled rejection.
 * The helper attaches a no-op catch to the original promise up front, so a
 * late rejection is always observed. When the promise SETTLES first, the
 * timer is cleared (no dangling timers on hot paths).
 */

/** Default deadline for load-path Supabase reads. Healthy reads are
 *  typically <100ms; 6s is ~10× that headroom while staying well under the
 *  8s content-provider (TMDB) ceiling and the 15s client resolver ceiling —
 *  a degraded read gives up BEFORE the user-perceived hang threshold. */
export const LOAD_READ_DEADLINE_MS = 6_000;

export function withDeadline<T>(
  promise: Promise<T> | PromiseLike<T>,
  deadlineMs: number,
  onTimeout: () => T
): Promise<T> {
  // Normalize thenables (supabase-js PostgREST builders are thenable, not
  // real Promises) and observe late rejections: one arriving AFTER the
  // deadline won must never become an unhandled rejection.
  const settled = Promise.resolve(promise);
  settled.catch(() => undefined);

  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(onTimeout()), deadlineMs);
  });

  return Promise.race([settled, deadline]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}
