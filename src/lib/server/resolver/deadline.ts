import { ResolverError } from './errors';

/**
 * Phase 1 production hardening (audit PRV-09) — resolver overall deadline.
 *
 * Problem: /api/playback/resolve had NO overall request deadline. Individual
 * upstream operations have their own timeouts (TMDB fetch 8s, addon fetches
 * 10-30s), but a pathological dependency chain (several sequential DB reads,
 * a slow content load, the health flush) could still extend the whole
 * request without bound.
 *
 * This module adds ONE resolver-level deadline that COMPLEMENTS (never
 * replaces) the existing per-operation timeouts:
 *
 *   * `throwIfExpired()` — cheap checkpoint between phases/attempts;
 *   * `guard(work)` — races one async operation against the deadline. The
 *     losing operation is DRAINED (a rejection after the deadline fired can
 *     never become an unhandled rejection) and its value is discarded, so
 *     stale/aborted operations cannot overwrite later source results;
 *   * the deadline always produces the TYPED `RESOLUTION_TIMEOUT`
 *     ResolverError — never a generic timeout exception.
 *
 * Pure and dependency-free so the deadline behavior is fully testable under
 * tsx (service.ts itself is env-wired).
 */

/** Default overall budget for one public resolve request (ms). */
export const RESOLVER_OVERALL_DEADLINE_MS = 20_000;

export type ResolutionDeadline = {
  /** True once the deadline has fired. */
  readonly expired: boolean;
  /** Throws the typed RESOLUTION_TIMEOUT error when the deadline fired. */
  throwIfExpired(): void;
  /**
   * Races `work` against the deadline. On deadline expiry the typed error
   * wins, `work` keeps running detached but drained, and its eventual
   * result is discarded (stale operations cannot overwrite later results).
   */
  guard<T>(work: Promise<T>): Promise<T>;
  /** Stops the timer. MUST be called when the resolution settles. */
  dispose(): void;
};

export function createResolutionDeadline(deadlineMs: number = RESOLVER_OVERALL_DEADLINE_MS): ResolutionDeadline {
  let expired = false;
  let fireDeadline: (() => void) | undefined;

  // Rejects with the typed error exactly once, when the timer fires.
  const deadlinePromise = new Promise<never>((_, reject) => {
    fireDeadline = () => {
      expired = true;
      reject(new ResolverError('RESOLUTION_TIMEOUT'));
    };
  });
  // The deadline may fire with no guard in flight — never an unhandled rejection.
  deadlinePromise.catch(() => {});

  const timer = setTimeout(() => fireDeadline?.(), Math.max(1, deadlineMs));
  // A serverless request may settle before the deadline; do not hold the runtime.
  timer.unref?.();

  return {
    get expired() {
      return expired;
    },
    throwIfExpired(): void {
      if (expired) throw new ResolverError('RESOLUTION_TIMEOUT');
    },
    async guard<T>(work: Promise<T>): Promise<T> {
      // Drain the work promise up-front: if the deadline wins the race, a
      // later rejection of the detached work can never become unhandled.
      work.catch(() => {});
      return Promise.race([work, deadlinePromise]);
    },
    dispose(): void {
      clearTimeout(timer);
    },
  };
}
