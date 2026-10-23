// ============================================================================
// Unified Live TV — Phase 7 bounded retry / backoff policy (server-only).
//
// THE ONE retry policy for the livetv pipeline. Design contracts (Phase 7
// brief §4):
//
//   * ONE layer — the retry loop exists ONLY where this module is called
//     (the Phase 7 scheduler for `trigger: 'scheduled'` runs). Adapters,
//     fetch-safe.ts and the refresh services NEVER retry internally, and
//     the manual admin refresh stays single-attempt — so retries can never
//     multiply across nested layers.
//   * TRANSIENT-ONLY — classification is explicit and conservative (see
//     classifyLivetvFailureForRetry). Validation failures, permanent 4xx,
//     unsupported formats, invalid configuration, authorization failures,
//     oversized/unsupported documents, parse failures and cancellations
//     are NEVER retried. http_error is transient ONLY for 429 and 5xx.
//   * BOUNDED — exponential backoff (base × 2^(attempt-1)) with seeded
//     jitter, a hard per-delay cap, a maximum attempt count and a total
//     elapsed-time budget. Retries never run indefinitely.
//   * CANCELLATION-HONORING — the caller's AbortSignal stops the loop
//     immediately; an abandoned operation cannot keep scheduling work.
//   * DETERMINISTIC IN TESTS — delay computation takes an injected random
//     source and the retry loop takes an injected sleep function, so CI
//     never sleeps for real backoff durations (fake-clock testing).
//   * 429 SAFETY — a `Retry-After` header is honored ONLY for 429
//     responses, parsed defensively (delta-seconds or HTTP-date), and
//     clamped to a bounded maximum; garbage values fall back to backoff.
//     (The header value reaches this module through the additive
//     `retryAfterMs` field on LivetvSourceFetchError — fetch-safe.ts.)
//   * NO PLAYBACK INTERACTION — the scheduler never retries playback
//     attempts; playback fallback remains governed exclusively by the
//     Phase 5 router.
// ============================================================================

import { createHash } from 'node:crypto';

/** The two-way retry verdict for one classified failure. */
export type LivetvRetryClassification = 'transient' | 'permanent';

/** Failure-kind vocabularies this policy classifies (both refresh services). */
export type LivetvClassifiableFailureKind =
        | 'lookup_failed'
        | 'source_not_found'
        | 'source_ineligible'
        | 'adapter_unavailable'
        | 'invalid_source_config'
        | 'invalid_url'
        | 'blocked_url'
        | 'timeout'
        | 'too_large'
        | 'http_error'
        | 'network'
        | 'unsupported_media_type'
        | 'invalid_payload'
        | 'parse_failed'
        | 'entry_cap_exceeded'
        | 'parse_deadline_exceeded'
        | 'cancelled'
        | 'refresh_in_progress'
        | 'unexpected'
        | 'epg_source_not_found'
        | 'epg_source_ineligible'
        | 'empty_document'
        | 'invalid_gzip'
        | 'decompression_too_large'
        | 'unsupported_encoding'
        | 'structure_invalid'
        | 'channel_cap_exceeded'
        | 'programme_cap_exceeded'
        | 'nesting_too_deep';

/**
 * Transient-vs-permanent classification.
 *
 * TRANSIENT (worth one bounded retry within a scheduled run):
 *   timeout .......... the request exceeded its budget (upstream slow — a
 *                      retry MAY succeed),
 *   network .......... resolution/connect/read failures (classic transient),
 *   lookup_failed .... a DATABASE read hiccup on the refresh path (the
 *                      registry itself is healthy; infrastructure transient),
 *   http_error ....... transient ONLY for 429 (rate limiting — Retry-After)
 *                      and 5xx (common upstream 5xx failures); every other
 *                      status is permanent.
 *
 * PERMANENT (retrying cannot help — fix the configuration or the data):
 *   invalid_source_config, invalid_url, blocked_url, source_not_found,
 *   epg_source_not_found, source_ineligible, epg_source_ineligible,
 *   adapter_unavailable, too_large, unsupported_media_type,
 *   invalid_payload, parse_failed, entry_cap_exceeded,
 *   parse_deadline_exceeded, empty_document, invalid_gzip,
 *   decompression_too_large, unsupported_encoding, structure_invalid,
 *   channel_cap_exceeded, programme_cap_exceeded, nesting_too_deep,
 *   unexpected (unknown — fail closed, do not loop),
 *   cancelled (the caller abandoned the run — never "retried" behind its
 *   back) and refresh_in_progress (another attempt already owns the source).
 */
export function classifyLivetvFailureForRetry(kind: string, httpStatus: number | null = null): LivetvRetryClassification {
        switch (kind) {
                case 'timeout':
                case 'network':
                case 'lookup_failed':
                        return 'transient';
                case 'http_error':
                        // 429 (rate limiting) and 5xx (upstream server errors) are
                        // the documented transient interpretations; every other
                        // status (401/403/404/410/…) is permanent.
                        if (httpStatus === 429 || (httpStatus !== null && httpStatus >= 500 && httpStatus <= 599)) {
                                return 'transient';
                        }
                        return 'permanent';
                default:
                        return 'permanent';
        }
}

/** Policy defaults (bounded; documented in the operations runbook). */
export const LIVETV_RETRY_BASE_DELAY_MS = 500;
/** Hard cap for ONE computed delay (module-level bound). */
export const LIVETV_RETRY_MAX_DELAY_MS = 30_000;
/** Hard cap for a `Retry-After` interpretation (anything larger is clamped). */
export const LIVETV_RETRY_MAX_RETRY_AFTER_MS = 60_000;
/** Bounded relative jitter applied to every computed delay (±25%). */
export const LIVETV_RETRY_JITTER_RATIO = 0.25;

export type LivetvRetryDelayOptions = {
        /** 1-based attempt that just failed (delay precedes attempt 2, 3, …). */
        attempt: number;
        baseDelayMs?: number;
        maxDelayMs?: number;
        jitterRatio?: number;
        /**
         * A bounded `Retry-After` interpretation in ms (from a 429 response).
         * When present and finite it REPLACES the backoff computation (still
         * clamped to maxDelayMs by the caller's bounds? no — to maxRetryAfterMs
         * here) with deterministic ±jitter applied on top.
         */
        retryAfterMs?: number | null;
        /**
         * Injected random source ∈ [0, 1) for deterministic tests. Defaults to
         * Math.random() in production.
         */
        random?: () => number;
};

/**
 * Computes ONE bounded delay. Exponential backoff (base × 2^(attempt-1),
 * capped) with symmetric relative jitter; a 429 `Retry-After` (already
 * clamped to LIVETV_RETRY_MAX_RETRY_AFTER_MS) replaces the base when given.
 * The result is always finite, >= 0, and <= maxDelayMs (or the Retry-After
 * clamp when a Retry-After was honored).
 */
export function computeLivetvRetryDelayMs(options: LivetvRetryDelayOptions): number {
        const attempt = Math.max(1, Math.floor(options.attempt || 1));
        const base = options.baseDelayMs ?? LIVETV_RETRY_BASE_DELAY_MS;
        const cap = options.maxDelayMs ?? LIVETV_RETRY_MAX_DELAY_MS;
        const jitterRatio = options.jitterRatio ?? LIVETV_RETRY_JITTER_RATIO;
        const random = options.random ?? Math.random;

        let delay: number;
        let bound: number;
        if (options.retryAfterMs != null && Number.isFinite(options.retryAfterMs) && options.retryAfterMs >= 0) {
                // Honor the upstream hint (clamped to the Retry-After cap), jittered.
                bound = LIVETV_RETRY_MAX_RETRY_AFTER_MS;
                delay = Math.min(options.retryAfterMs, bound);
        } else {
                bound = cap;
                delay = Math.min(base * Math.pow(2, attempt - 1), bound);
        }
        // Symmetric relative jitter: delay × [1 - r, 1 + r], then clamped to
        // the FINAL bound (the pre-jitter value must not silently absorb the
        // +jitter side).
        const jitter = (random() * 2 - 1) * jitterRatio;
        const result = Math.round(delay * (1 + jitter));
        if (!Number.isFinite(result) || result < 0) return 0;
        return Math.min(result, bound);
}

/**
 * Parses a `Retry-After` header value defensively. Accepts delta-seconds
 * (preferred) or an HTTP-date; anything else (garbage, negative, absurdly
 * large) is clamped or rejected. The result is ALWAYS bounded to
 * LIVETV_RETRY_MAX_RETRY_AFTER_MS — a hostile server cannot make the
 * scheduler sleep for hours. Returns null when the value must be ignored.
 */
export function parseLivetvRetryAfterMs(headerValue: string | null | undefined, nowMs: number = Date.now()): number | null {
        if (!headerValue) return null;
        const trimmed = headerValue.trim().slice(0, 64); // bounded parse input
        if (!trimmed) return null;
        if (/^\d{1,10}$/.test(trimmed)) {
                const seconds = Number(trimmed);
                if (!Number.isFinite(seconds) || seconds < 0) return null;
                return Math.min(seconds * 1000, LIVETV_RETRY_MAX_RETRY_AFTER_MS);
        }
        const dateMs = Date.parse(trimmed);
        // Require a time-of-day component — every HTTP-date form carries one;
        // this rejects garbage that V8's lenient fallback parser would
        // otherwise interpret as a year (e.g. "-5").
        if (!Number.isFinite(dateMs) || !/\d{1,2}:\d{2}/.test(trimmed)) return null;
        const delta = dateMs - nowMs;
        if (delta <= 0) return 0; // already elapsed — retry immediately (bounded)
        return Math.min(delta, LIVETV_RETRY_MAX_RETRY_AFTER_MS);
}

/**
 * Deterministic per-subject jitter seed derived from a stable identity
 * (the source slug). Used by the scheduler to desynchronize upstream hits
 * ACROSS sources without shared state: hash(slug) → [0, 1).
 */
export function livetvJitterRandomForSeed(seed: string): () => number {
        let counter = 0;
        return () => {
                const digest = createHash('sha256').update(`${seed}:${counter}`).digest();
                counter += 1;
                // 4 bytes → [0, 1).
                const value = digest.readUInt32BE(0) / 0x1_0000_0000;
                return value;
        };
}

export type LivetvRetryRunOptions<T> = {
        /**
         * Runs ONE attempt. Returns `{ value, done: true }` on success or
         * `{ value, done: false, transient, retryAfterMs? }` on a typed
         * failure (throwing aborts the run — the loop never catches
         * unexpected exceptions).
         */
        run: (attempt: number) => Promise<{ value: T; done: boolean; transient?: boolean; retryAfterMs?: number | null }>;
        /** Maximum attempts (>= 1; default 2 — one retry for transient failures). */
        maxAttempts?: number;
        /** Total elapsed-time budget (ms) across ALL attempts incl. delays. */
        totalBudgetMs: number;
        /** Injected sleep (tests pass a recorder; production uses setTimeout). */
        sleep: (ms: number) => Promise<void>;
        /** Monotonic-ish clock (injectable for fake clocks). */
        now?: () => number;
        /** External cancellation — checked before every attempt and delay. */
        signal?: AbortSignal;
        /** Delay computation override (tests inject deterministic delays). */
        computeDelayMs?: (attempt: number, retryAfterMs: number | null) => number;
        /** The smallest remaining slice (ms) under which a new attempt starts. */
        minAttemptSliceMs?: number;
};

export type LivetvRetryRunResult<T> = {
        value: T | null;
        attempts: number;
        /** True when the LAST attempt completed (done), of any classification. */
        done: boolean;
        /** True when the run stopped for budget/cancellation (retryable later). */
        deferred: boolean;
};

/**
 * Runs ONE logical operation with bounded retries. The loop:
 *   * never exceeds maxAttempts (default 2),
 *   * never exceeds totalBudgetMs INCLUDING delays,
 *   * retries only failures the caller classified transient,
 *   * honors a bounded Retry-After when the caller surfaced one,
 *   * stops immediately on external cancellation (deferred: true),
 *   * injects ALL timing (sleep/now) — deterministic in tests.
 */
export async function runLivetvWithBoundedRetries<T>(options: LivetvRetryRunOptions<T>): Promise<LivetvRetryRunResult<T>> {
        const maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? 2));
        const now = options.now ?? Date.now;
        const minAttemptSliceMs = options.minAttemptSliceMs ?? 250;
        const startedAt = now();

        let attempts = 0;
        let last: { value: T; done: boolean } | null = null;

        while (attempts < maxAttempts) {
                if (options.signal?.aborted) {
                        return { value: last?.value ?? null, attempts, done: false, deferred: true };
                }
                const remaining = options.totalBudgetMs - (now() - startedAt);
                if (remaining < minAttemptSliceMs) {
                        return { value: last?.value ?? null, attempts, done: false, deferred: true };
                }
                attempts += 1;
                const result = await options.run(attempts);
                last = { value: result.value, done: result.done };
                if (result.done) {
                        return { value: result.value, attempts, done: true, deferred: false };
                }
                if (attempts >= maxAttempts || !result.transient || options.signal?.aborted) {
                        break;
                }
                // Bounded inter-attempt delay; the budget gate keeps it honest.
                const delayMs = options.computeDelayMs
                        ? options.computeDelayMs(attempts, result.retryAfterMs ?? null)
                        : computeLivetvRetryDelayMs({ attempt: attempts, retryAfterMs: result.retryAfterMs ?? null });
                const remainingAfterAttempt = options.totalBudgetMs - (now() - startedAt);
                if (!Number.isFinite(delayMs) || delayMs <= 0) continue;
                if (delayMs + minAttemptSliceMs > remainingAfterAttempt) {
                        return { value: result.value, attempts, done: false, deferred: true };
                }
                await options.sleep(delayMs);
        }

        return { value: last?.value ?? null, attempts, done: last?.done ?? false, deferred: false };
}
