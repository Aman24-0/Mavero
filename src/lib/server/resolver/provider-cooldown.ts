// Phase 3-D (audit OBS-4) — Bounded provider cooldown / circuit breaker.
//
// Problem: when a provider repeatedly fails (e.g. upstream is down, or
// the provider's API is returning errors), the resolver kept sending
// attempts on every request. Under load this drove cascading failures
// — every request paid the latency of attempting a provider that was
// already known to be failing.
//
// Fix: a small bounded in-process provider cooldown. After a provider
// accumulates CONSECUTIVE failures beyond a threshold, the cooldown
// temporarily marks it ineligible. Subsequent resolution attempts
// skip the cooling-down provider (the existing ranking layer already
// filters ineligible candidates). A controlled PROBE request is
// allowed through periodically — if it succeeds, the provider
// recovers; if it fails, the cooldown extends.
//
// CRITICAL DISTINCTIONS:
//
//   1. PROCESS-LOCAL — NOT GLOBAL. Each Netlify function instance has
//      its OWN cooldown state; there is no cross-instance coordination.
//      A globally-distributed circuit breaker would require Redis or
//      similar infrastructure (out of scope for Phase 3). The cooldown
//      is still valuable: within a single function instance, repeated
//      failures from the same provider skip the upstream call.
//
//   2. NO CROSS-USER POISONING. The cooldown is keyed by PROVIDER ID
//      only — NEVER by user. One user's failures cool down the
//      provider for ALL users on the SAME function instance (which is
//      correct — a provider that's failing for one user is likely
//      failing for all). Recovery is automatic (probe success), so a
//      cooled-down provider cannot stay cooled forever.
//
//   3. BOUNDED. The provider state table is a Map keyed by provider
//      id — the size is bounded by the number of providers (small,
//      dozens at most). Consecutive failure counts are bounded by the
//      threshold (5) — they don't accumulate without bound. Cooldown
//      expiry is bounded by the cooldown duration (30s).
//
//   4. TRANSIENT-vs-PERMANENT. The cooldown distinguishes:
//        * TRANSIENT failures (network, timeout, 5xx): counted toward
//          the cooldown threshold. Recovery is automatic on probe
//          success.
//        * DETERMINISTIC failures (INVALID_TEMPLATE, UNSUPPORTED_MEDIA_TYPE):
//          NOT counted toward the cooldown threshold. These are NOT
//          provider-health issues — they're "this source cannot serve
//          this content" outcomes, which the NEGATIVE CACHE handles.
//
//   5. RECOVERY. A cooled-down provider receives a PROBE request every
//      `probeIntervalMs` (default 15s). If the probe succeeds, the
//      consecutive-failure count resets and the provider recovers
//      immediately. If the probe fails, the cooldown extends. This
//      means a recovered provider starts serving traffic again
//      within ~15s, not after the full cooldown duration.
//
//   6. NO STATE ACCUMULATION. The provider state is reset on
//      process start (cold start). There is NO persistent state —
//      a fresh function instance starts with no cooldowns.

const FAILURE_THRESHOLD = 5; // 5 consecutive transient failures → cooldown
const COOLDOWN_MS = 30_000; // 30 seconds
const PROBE_INTERVAL_MS = 15_000; // a probe every 15s during cooldown

type ProviderState = {
  /** Consecutive transient failure count. Resets on any success. */
  consecutiveFailures: number;
  /** When the cooldown started (epoch ms), or 0 when not cooling down. */
  cooldownStartedAt: number;
  /** When the next probe is allowed (epoch ms). */
  nextProbeAt: number;
};

const states = new Map<string, ProviderState>();

/**
 * The set of resolver error codes that are TRANSIENT (counted toward
 * the cooldown threshold). Deterministic "this source cannot serve
 * this content" outcomes are NOT counted — they're handled by the
 * negative cache, not the cooldown.
 */
const TRANSIENT_FAILURE_CODES = new Set<string>([
  'RESOLUTION_TIMEOUT',
  'INTERNAL_RESOLUTION_ERROR',
  'INVALID_SOURCE_URL', // the provider returned a URL that failed validation — could be transient (the provider's URL generation had a one-off bug)
  'INVALID_PROVIDER_ENDPOINT', // endpoint misconfiguration that might be a transient DNS/routing issue
  'PROVIDER_RESPONSE_INVALID', // malformed response — could be a transient partial response
]);

/**
 * Returns true if the resolver error code is a TRANSIENT failure
 * (counted toward the cooldown threshold). Deterministic outcomes
 * (UNSUPPORTED_MEDIA_TYPE, MISSING_IDENTIFIER, RESOLUTION_UNAVAILABLE,
 * PROVIDER_DISABLED, SOURCE_DISABLED, etc.) return false.
 */
export function isTransientFailure(code: string): boolean {
  return TRANSIENT_FAILURE_CODES.has(code);
}

function getState(providerId: string): ProviderState {
  let state = states.get(providerId);
  if (!state) {
    state = { consecutiveFailures: 0, cooldownStartedAt: 0, nextProbeAt: 0 };
    states.set(providerId, state);
  }
  return state;
}

/**
 * Returns true when the provider is currently eligible to receive
 * resolution attempts. A provider in cooldown is eligible ONLY for a
 * probe (the nextProbeAt check); a healthy provider is always eligible.
 *
 * The caller (the resolver fallback loop) consults this before
 * attempting a candidate. A `false` return means "skip this candidate
 * — the provider is cooling down and the next probe isn't due yet".
 */
export function isProviderEligible(providerId: string, now: number = Date.now()): boolean {
  const state = states.get(providerId);
  if (!state || state.cooldownStartedAt === 0) return true;
  // In cooldown: eligible only if a probe is due.
  return now >= state.nextProbeAt;
}

/**
 * Returns true when the provider is in cooldown AND a probe is due
 * (the resolver should attempt the provider even though it's cooling
 * down, because the probe might recover it).
 */
export function isProbeDue(providerId: string, now: number = Date.now()): boolean {
  const state = states.get(providerId);
  if (!state || state.cooldownStartedAt === 0) return false;
  return now >= state.nextProbeAt;
}

/**
 * Records a success for the provider. Resets the consecutive-failure
 * count and clears any cooldown — a single successful resolution
 * fully recovers the provider immediately.
 */
export function recordProviderSuccess(providerId: string, now: number = Date.now()): void {
  const state = getState(providerId);
  state.consecutiveFailures = 0;
  state.cooldownStartedAt = 0;
  state.nextProbeAt = 0;
}

/**
 * Records a transient failure for the provider. Increments the
 * consecutive-failure count; when it crosses the threshold, starts
 * the cooldown. While in cooldown, a failed probe extends the
 * cooldown (resets nextProbeAt to now + PROBE_INTERVAL_MS).
 *
 * DETERMINISTIC failures (UNSUPPORTED_MEDIA_TYPE, etc.) are NOT
 * recorded here — the caller should check `isTransientFailure(code)`
 * before calling this function. Calling with a non-transient code is
 * a no-op (defensive — the function does nothing).
 */
export function recordProviderFailure(providerId: string, code: string, now: number = Date.now()): void {
  if (!isTransientFailure(code)) return; // deterministic failures do NOT create state
  const state = getState(providerId);
  state.consecutiveFailures += 1;
  if (state.consecutiveFailures >= FAILURE_THRESHOLD && state.cooldownStartedAt === 0) {
    state.cooldownStartedAt = now;
    state.nextProbeAt = now + PROBE_INTERVAL_MS;
  } else if (state.cooldownStartedAt !== 0) {
    // Already in cooldown: a failed probe extends the next-probe time.
    state.nextProbeAt = now + PROBE_INTERVAL_MS;
  }
  // Cooldown auto-expires: if the cooldown started more than COOLDOWN_MS
  // ago and no probe has succeeded, the provider is force-recovered
  // (treated as eligible again). This bounds the worst-case cooldown
  // to COOLDOWN_MS — a provider cannot stay cooled forever even if no
  // probe attempts succeed.
  if (state.cooldownStartedAt !== 0 && now - state.cooldownStartedAt > COOLDOWN_MS) {
    state.consecutiveFailures = 0;
    state.cooldownStartedAt = 0;
    state.nextProbeAt = 0;
  }
}

/**
 * Clears all cooldown state — for tests, and for admin "reset provider
 * health" operations.
 */
export function clearProviderCooldowns(): void {
  states.clear();
}

/**
 * Clears the cooldown for a specific provider (e.g. when an admin
 * reconfigures it).
 */
export function clearProviderCooldown(providerId: string): void {
  states.delete(providerId);
}

/** Diagnostics — for tests and ops dashboards. */
export function providerCooldownStats(): {
  providers: number;
  coolingDown: number;
  threshold: number;
  cooldownMs: number;
  probeIntervalMs: number;
} {
  let coolingDown = 0;
  const now = Date.now();
  for (const state of states.values()) {
    if (state.cooldownStartedAt !== 0 && now - state.cooldownStartedAt <= COOLDOWN_MS) {
      coolingDown += 1;
    }
  }
  return {
    providers: states.size,
    coolingDown,
    threshold: FAILURE_THRESHOLD,
    cooldownMs: COOLDOWN_MS,
    probeIntervalMs: PROBE_INTERVAL_MS,
  };
}

// Test-only exports for behavioral verification.
export const __test = {
  get FAILURE_THRESHOLD() { return FAILURE_THRESHOLD; },
  get COOLDOWN_MS() { return COOLDOWN_MS; },
  get PROBE_INTERVAL_MS() { return PROBE_INTERVAL_MS; },
  getState(providerId: string): ProviderState | undefined {
    return states.get(providerId);
  },
  // Force a provider into cooldown state for testing recovery paths.
  forceCooldown(providerId: string, now: number = Date.now()): void {
    const state = getState(providerId);
    state.consecutiveFailures = FAILURE_THRESHOLD;
    state.cooldownStartedAt = now;
    state.nextProbeAt = now + PROBE_INTERVAL_MS;
  }
};
