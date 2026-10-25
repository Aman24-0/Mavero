/**
 * MAVERO Adapter Builder — build-time runtime context (plan §8/§10).
 *
 * The Builder runs generated DSL specs through the SAME interpreter +
 * the SAME runtime context implementation the Mavero production runtime
 * uses (test-what-you-ship, D-P3-3): `createCloudStreamRuntimeContext`
 * already provides the SSRF-guarded, deadline-bound, diagnostics-aware
 * surface. This module only wraps it with BUILD-TIME budgets (tighter
 * timeouts + smaller response caps than production defaults) so a build
 * can never burn more than its configured limits.
 *
 * Importable under tsx via the repo tsconfig path alias (no SvelteKit
 * virtual modules).
 */

import { createCloudStreamRuntimeContext } from '$lib/server/cloudstream/runtime/context';
import type { CloudStreamRuntimeContext } from '$lib/server/cloudstream/types/runtime';
import type { SafeDnsResolver } from '$lib/server/streaming/stremio/ssrf';

/** Build-time fetch budgets (tighter than the runtime defaults). */
export const BUILDER_CONTEXT_TIMEOUT_MS = 10_000;
export const BUILDER_CONTEXT_MAX_BYTES = 2 * 1_048_576;

export type BuilderContextDeps = {
  adapterId: string;
  signal: AbortSignal;
  /** Injectable fetcher (tests never touch the real network). */
  fetcher?: typeof fetch;
  /** Injectable DNS resolver (tests). */
  dnsResolver?: SafeDnsResolver;
  /** Per-fetch timeout override. */
  timeoutMs?: number;
  /** Per-fetch response cap override. */
  maxBytes?: number;
  /** Injectable clock (tests). */
  now?: () => number;
};

/**
 * Creates one build-time runtime context for DSL verification. One context
 * per build (per candidate spec) — same isolation discipline as the
 * production resolver (one context per adapter resolution).
 */
export function createBuilderRuntimeContext(deps: BuilderContextDeps): CloudStreamRuntimeContext {
  return createCloudStreamRuntimeContext({
    adapterId: deps.adapterId,
    signal: deps.signal,
    ...(deps.fetcher !== undefined ? { fetcher: deps.fetcher } : {}),
    ...(deps.dnsResolver !== undefined ? { dnsResolver: deps.dnsResolver } : {}),
    timeoutMs: deps.timeoutMs ?? BUILDER_CONTEXT_TIMEOUT_MS,
    maxBytes: deps.maxBytes ?? BUILDER_CONTEXT_MAX_BYTES,
    ...(deps.now !== undefined ? { now: deps.now } : {}),
  });
}
