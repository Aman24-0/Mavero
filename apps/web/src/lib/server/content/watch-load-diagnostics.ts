// MAVP-6 (Issue 1) — Stage-tagged failure diagnostics for the watch route's
// server load degradation boundaries.
//
// WHY THIS EXISTS
// ===============
// The user-visible production failure ("MAVERO / 500 — The signal dropped.")
// on series card-play had no server-side trace: every degradation boundary in
// the watch load converted a failure into its typed outcome SILENTLY (detail
// -> 404, streaming config -> empty default, season -> null). A transient
// infrastructure failure (TMDB timeout/rate limit, Supabase rejection) is
// therefore indistinguishable from a genuinely missing title in any operator
// diagnostics — the next occurrence identifies neither the failing stage nor
// the failure class.
//
// This module is the ONE place that turns a boundary failure into a SAFE,
// STRUCTURED log line:
//   * stage   — WHICH degradation boundary fired ('watch:detail',
//               'watch:streaming-config', 'watch:season', 'watch:assembly').
//   * class   — the failure class (content-unresolved / upstream / config /
//               unexpected), derived from the error's shape, so a 404 that is
//               really an infrastructure failure stays actionable.
//   * code    — the ContentServiceError code when present (NOT_FOUND,
//               UPSTREAM_ERROR, RATE_LIMITED, CONFIG_MISSING, …).
//
// SECURITY CONTRACT (matches src/lib/server/http/log.ts):
//   * NEVER logs the error message, stack, URL, query, title id or user id —
//     only the fixed stage literal and the error class/code strings.
//   * Never throws: a diagnostics failure must never change the load's typed
//     outcome (the caller's catch proceeds exactly as before).
//   * Pure: the logger is injected, so behavioral tests can execute the real
//     classification truth table without SvelteKit or network access.
//
// SCOPE HONESTY: this module does NOT claim to fix a production incident —
// production logs were not available to the MAVP-6 task and the deployed
// Netlify commit is not recorded in the repository. It closes the
// observability gap so the NEXT occurrence identifies the failing stage (the
// exact remediation the task mandates when logs are unavailable).

import { ContentServiceError } from './types';

export type WatchLoadStage = 'watch:detail' | 'watch:streaming-config' | 'watch:season' | 'watch:assembly';

export type WatchLoadFailureClass = 'content-unresolved' | 'upstream' | 'config' | 'unexpected';

export type WatchLoadFailureDescription = {
  stage: WatchLoadStage;
  errorClass: WatchLoadFailureClass;
  code: string;
};

/** Codes whose failure is a transient upstream (TMDB/network) condition. */
const UPSTREAM_CODES = new Set(['UPSTREAM_ERROR', 'RATE_LIMITED', 'INVALID_RESPONSE', 'TIMEOUT']);

/**
 * Classify one degradation-boundary failure into the safe diagnostic shape.
 * Pure — same input always yields the same description, never throws, and
 * never reads anything from the error beyond its class and public code.
 */
export function describeWatchLoadFailure(stage: WatchLoadStage, error: unknown): WatchLoadFailureDescription {
  if (error instanceof ContentServiceError) {
    if (error.code === 'NOT_FOUND') return { stage, errorClass: 'content-unresolved', code: error.code };
    if (error.code === 'CONFIG_MISSING') return { stage, errorClass: 'config', code: error.code };
    if (UPSTREAM_CODES.has(error.code)) return { stage, errorClass: 'upstream', code: error.code };
  }
  return { stage, errorClass: 'unexpected', code: '' };
}

/**
 * Emit the safe structured log line for one degraded watch-load boundary.
 * Contract: NEVER throws and NEVER mutates the caller's error handling — the
 * caller's typed outcome (404 / empty config / null) follows unchanged.
 * The logger is injected (the structured server logger in production; a
 * recording sink in tests).
 */
export function logWatchLoadStageFailure(logger: { error: (msg: string, fields?: Record<string, unknown>) => void }, stage: WatchLoadStage, error: unknown): void {
  try {
    const description = describeWatchLoadFailure(stage, error);
    logger.error('watch load stage degraded', {
      stage: description.stage,
      errorClass: description.errorClass,
      code: description.code
    });
  } catch {
    // Diagnostics must never alter the load's outcome — even a broken logger
    // sink is absorbed here.
  }
}
