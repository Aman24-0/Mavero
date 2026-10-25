/**
 * UNIFIED LIVE TV — Phase 7 bounded retry/backoff policy (deterministic).
 *
 * Covers (Phase 7 brief §4 + required regression areas #4/#5/#6/#7):
 *   §1  transient/permanent classification matrix (both refresh taxonomies)
 *   §2  bounded exponential backoff math (caps, jitter bounds, determinism)
 *   §3  Retry-After parsing (delta-seconds, HTTP-date, garbage, clamping)
 *   §4  fetch-safe 429 Retry-After surfacing (additive hook)
 *   §5  runLivetvWithBoundedRetries: max attempts, total budget,
 *       transient-only, cancellation, fake-clock/no-real-sleep
 *
 * NO network, NO real sleeps (every delay is injected/recorded).
 */

import assert from 'node:assert/strict';
import { fetchLivetvSourceText, LivetvSourceFetchError } from '../src/lib/server/livetv/fetch-safe';
import {
        LIVETV_RETRY_MAX_DELAY_MS,
        LIVETV_RETRY_MAX_RETRY_AFTER_MS,
        classifyLivetvFailureForRetry,
        computeLivetvRetryDelayMs,
        livetvJitterRandomForSeed,
        parseLivetvRetryAfterMs,
        runLivetvWithBoundedRetries
} from '../src/lib/server/livetv/retry';

let passed = 0;
function ok(condition: unknown, label: string, hint?: string) {
        assert.ok(condition, hint ? `${label} (${hint})` : label);
        passed += 1;
        console.log(`  ok ${passed} - ${label}`);
}

async function main() {
        // ------------------------------------------------------------------
        console.log('§1 — transient/permanent classification matrix');
        // ------------------------------------------------------------------
        {
                for (const kind of ['timeout', 'network', 'lookup_failed']) {
                        ok(classifyLivetvFailureForRetry(kind) === 'transient', `§1.1 ${kind} is transient`);
                }
                ok(classifyLivetvFailureForRetry('http_error', 429) === 'transient', '§1.2 http_error 429 is transient');
                for (const status of [500, 502, 503, 504, 599]) {
                        ok(classifyLivetvFailureForRetry('http_error', status) === 'transient', `§1.3 http_error ${status} is transient`);
                }
                for (const status of [400, 401, 403, 404, 410, 422, 451]) {
                        ok(classifyLivetvFailureForRetry('http_error', status) === 'permanent', `§1.4 http_error ${status} is permanent`);
                }
                ok(classifyLivetvFailureForRetry('http_error') === 'permanent', '§1.5 http_error without status is permanent (fail closed)');
                for (const kind of ['invalid_source_config', 'invalid_url', 'blocked_url', 'source_not_found', 'source_ineligible', 'epg_source_not_found', 'epg_source_ineligible', 'adapter_unavailable', 'too_large', 'unsupported_media_type', 'invalid_payload', 'parse_failed', 'entry_cap_exceeded', 'parse_deadline_exceeded', 'empty_document', 'invalid_gzip', 'decompression_too_large', 'unsupported_encoding', 'structure_invalid', 'channel_cap_exceeded', 'programme_cap_exceeded', 'nesting_too_deep', 'unexpected']) {
                        ok(classifyLivetvFailureForRetry(kind) === 'permanent', `§1.6 ${kind} is permanent`);
                }
                ok(classifyLivetvFailureForRetry('cancelled') === 'permanent', '§1.7 cancelled is NEVER retried');
                ok(classifyLivetvFailureForRetry('refresh_in_progress') === 'permanent', '§1.8 refresh_in_progress is never retried');
                ok(classifyLivetvFailureForRetry('some_unknown_kind') === 'permanent', '§1.9 unknown kinds fail closed (permanent)');
        }

        // ------------------------------------------------------------------
        console.log('§2 — bounded exponential backoff math');
        // ------------------------------------------------------------------
        {
                ok(computeLivetvRetryDelayMs({ attempt: 1, random: () => 0.5 }) === Math.round(500 * 1), '§2.1 attempt 1 = base (zero jitter at 0.5)');
                ok(computeLivetvRetryDelayMs({ attempt: 2, random: () => 0.5 }) === 1000, '§2.2 attempt 2 = 2×base');
                ok(computeLivetvRetryDelayMs({ attempt: 3, random: () => 0.5 }) === 2000, '§2.3 attempt 3 = 4×base');
                ok(computeLivetvRetryDelayMs({ attempt: 10, random: () => 0.5 }) === LIVETV_RETRY_MAX_DELAY_MS, '§2.4 exponential growth is capped');
                ok(computeLivetvRetryDelayMs({ attempt: 1, random: () => 0 }) === Math.round(500 * 0.75), '§2.5 jitter lower bound (−25%)');
                ok(computeLivetvRetryDelayMs({ attempt: 1, random: () => 0.999999 }) === Math.round(500 * 1.25), '§2.6 jitter upper bound (+25%)');
                const deterministic = (seed: number) => computeLivetvRetryDelayMs({ attempt: 2, random: livetvJitterRandomForSeed(`seed-${seed}`) });
                ok(deterministic(1) === deterministic(1), '§2.7 seeded jitter is deterministic for the same seed');
                ok(deterministic(1) !== deterministic(2), '§2.8 different seeds diverge (cross-source desync)');
                for (let i = 0; i < 50; i += 1) {
                        const d = computeLivetvRetryDelayMs({ attempt: 4, random: Math.random });
                        if (d < 0 || d > LIVETV_RETRY_MAX_DELAY_MS) {
                                ok(false, `§2.9 delay out of bounds: ${d}`);
                                break;
                        }
                }
                ok(true, '§2.9 50 random delays all within [0, cap]');
                ok(computeLivetvRetryDelayMs({ attempt: 1, retryAfterMs: 5000, random: () => 0.5 }) === 5000, '§2.10 Retry-After replaces the backoff base');
                ok(computeLivetvRetryDelayMs({ attempt: 1, retryAfterMs: LIVETV_RETRY_MAX_RETRY_AFTER_MS + 999999, random: () => 0.5 }) === LIVETV_RETRY_MAX_RETRY_AFTER_MS, '§2.11 Retry-After is clamped to the module cap');
                ok(computeLivetvRetryDelayMs({ attempt: 1, retryAfterMs: null, random: () => 0.5 }) === 500, '§2.12 null Retry-After falls back to backoff');
                ok(computeLivetvRetryDelayMs({ attempt: 0, random: () => 0.5 }) === 500, '§2.13 attempt 0 is normalized to 1');
                ok(computeLivetvRetryDelayMs({ attempt: 1, retryAfterMs: 0, random: () => 0.5 }) === 0, '§2.14 zero Retry-After is honored (immediate retry)');
        }

        // ------------------------------------------------------------------
        console.log('§3 — Retry-After header parsing (bounded + safe)');
        // ------------------------------------------------------------------
        {
                ok(parseLivetvRetryAfterMs('30') === 30_000, '§3.1 delta-seconds parse');
                ok(parseLivetvRetryAfterMs('0') === 0, '§3.2 zero delta honored');
                ok(parseLivetvRetryAfterMs('99999999') === LIVETV_RETRY_MAX_RETRY_AFTER_MS, '§3.3 absurd delta clamped to 60s (hostile server bound)');
                ok(parseLivetvRetryAfterMs('-5') === null, '§3.4 negative delta rejected');
                ok(parseLivetvRetryAfterMs('soon') === null, '§3.5 garbage rejected');
                ok(parseLivetvRetryAfterMs('') === null, '§3.6 empty rejected');
                ok(parseLivetvRetryAfterMs(null) === null, '§3.7 absent header → null');
                const future = new Date(Date.now() + 10_000).toUTCString();
                const parsed = parseLivetvRetryAfterMs(future) ?? -1;
                ok(parsed > 0 && parsed <= 10_500, '§3.8 HTTP-date parses into a bounded delta', String(parsed));
                ok(parseLivetvRetryAfterMs(new Date(Date.now() - 60_000).toUTCString()) === 0, '§3.9 elapsed HTTP-date → immediate retry');
                ok(parseLivetvRetryAfterMs('x'.repeat(500)) === null, '§3.10 overlong garbage rejected (bounded parse input)');
        }

        // ------------------------------------------------------------------
        console.log('§4 — fetch-safe 429 Retry-After surfacing (additive hook)');
        // ------------------------------------------------------------------
        {
                const okResolver = async () => [{ address: '93.184.216.34', family: 4 as const }];
                const fetch429WithHeader = (async (_url: unknown, init?: { signal?: AbortSignal }) => {
                        return new Response('rate limited', { status: 429, headers: { 'retry-after': '7' }, signal: init?.signal }) as unknown as Response;
                }) as unknown as typeof fetch;
                try {
                        await fetchLivetvSourceText('https://upstream.example/feed.m3u8', { fetcher: fetch429WithHeader, dnsResolver: okResolver });
                        ok(false, '§4.1 429 must throw');
                } catch (error) {
                        ok(error instanceof LivetvSourceFetchError && error.kind === 'http_error', '§4.1 a 429 becomes a typed http_error');
                        ok(error instanceof LivetvSourceFetchError && error.httpStatus === 429, '§4.2 the status is carried');
                        ok(error instanceof LivetvSourceFetchError && error.retryAfterMs === 7_000, '§4.3 the bounded Retry-After hint is surfaced');
                }
                const fetch429NoHeader = (async () => new Response('rate limited', { status: 429 }) as unknown as Response) as unknown as typeof fetch;
                try {
                        await fetchLivetvSourceText('https://upstream.example/feed.m3u8', { fetcher: fetch429NoHeader, dnsResolver: okResolver });
                        ok(false, '§4.4 429 without header must still throw');
                } catch (error) {
                        ok(error instanceof LivetvSourceFetchError && error.retryAfterMs === null, '§4.4 missing Retry-After → null (caller falls back to backoff)');
                }
                const fetch500 = (async () => new Response('boom', { status: 500 }) as unknown as Response) as unknown as typeof fetch;
                try {
                        await fetchLivetvSourceText('https://upstream.example/feed.m3u8', { fetcher: fetch500, dnsResolver: okResolver });
                        ok(false, '§4.5 500 must throw');
                } catch (error) {
                        ok(error instanceof LivetvSourceFetchError && error.kind === 'http_error' && error.httpStatus === 500 && error.retryAfterMs === null, '§4.5 5xx carries NO Retry-After (429-only hook)');
                }
                const fetch404 = (async () => new Response('nope', { status: 404 }) as unknown as Response) as unknown as typeof fetch;
                try {
                        await fetchLivetvSourceText('https://upstream.example/feed.m3u8', { fetcher: fetch404, dnsResolver: okResolver });
                        ok(false, '§4.6 404 must throw');
                } catch (error) {
                        ok(error instanceof LivetvSourceFetchError && error.httpStatus === 404 && error.retryAfterMs === null, '§4.6 404 carries NO Retry-After');
                }
        }

        // ------------------------------------------------------------------
        console.log('§5 — runLivetvWithBoundedRetries (bounded, cancel-honoring, no real sleeps)');
        // ------------------------------------------------------------------
        {
                // §5.1 max attempts honored (fake sleep records, never blocks).
                const slept: number[] = [];
                let attempts = 0;
                const run1 = await runLivetvWithBoundedRetries<{ ok: boolean }>({
                        totalBudgetMs: 60_000,
                        sleep: async (ms) => {
                                slept.push(ms);
                        },
                        computeDelayMs: () => 500,
                        run: async (attempt) => {
                                attempts = attempt;
                                return { value: { ok: false }, done: false, transient: true };
                        }
                });
                ok(run1.attempts === 2 && attempts === 2 && !run1.done, '§5.1 stops at maxAttempts (2 by default)');
                ok(slept.length === 1 && slept[0] === 500, '§5.2 exactly ONE bounded delay between the two attempts');

                // §5.2 permanent failures are never retried.
                let attempts2 = 0;
                const run2 = await runLivetvWithBoundedRetries<{ ok: boolean }>({
                        totalBudgetMs: 60_000,
                        sleep: async () => {
                                ok(false, '§5.3 permanent failure must not sleep');
                        },
                        run: async () => {
                                attempts2 += 1;
                                return { value: { ok: false }, done: false, transient: false };
                        }
                });
                ok(run2.attempts === 1 && attempts2 === 1, '§5.3 a permanent failure runs exactly one attempt');

                // §5.3 total budget bounds the run even with generous maxAttempts.
                let now = 0;
                const run3 = await runLivetvWithBoundedRetries<{ ok: boolean }>({
                        maxAttempts: 50,
                        totalBudgetMs: 5_000,
                        now: () => now,
                        sleep: async (ms) => {
                                now += ms;
                        },
                        computeDelayMs: () => 2_000,
                        run: async () => ({ value: { ok: false }, done: false, transient: true })
                });
                ok(run3.attempts < 50 && run3.deferred, '§5.4 the elapsed-time budget terminates the loop (deferred for a later tick)');

                // §5.4 cancellation stops the loop immediately.
                const controller = new AbortController();
                controller.abort();
                let attempts4 = 0;
                const run4 = await runLivetvWithBoundedRetries<{ ok: boolean }>({
                        totalBudgetMs: 60_000,
                        signal: controller.signal,
                        sleep: async () => {},
                        run: async () => {
                                attempts4 += 1;
                                return { value: { ok: false }, done: false, transient: true };
                        }
                });
                ok(run4.deferred && attempts4 === 0, '§5.5 a pre-aborted signal runs ZERO attempts (no post-abandonment work)');

                // §5.5 success on a later attempt completes.
                let attempts5 = 0;
                const run5 = await runLivetvWithBoundedRetries<{ ok: boolean }>({
                        totalBudgetMs: 60_000,
                        sleep: async () => {},
                        run: async (attempt) => {
                                attempts5 = attempt;
                                return attempt < 2 ? { value: { ok: false }, done: false, transient: true } : { value: { ok: true }, done: true };
                        }
                });
                ok(run5.done && run5.value?.ok === true && attempts5 === 2, '§5.6 a transient failure then success completes with the retry value');

                // §5.6 the budget gate refuses to start an attempt that cannot fit.
                now = 0;
                let attempts6 = 0;
                const run6 = await runLivetvWithBoundedRetries<{ ok: boolean }>({
                        totalBudgetMs: 100,
                        minAttemptSliceMs: 250,
                        now: () => now,
                        sleep: async () => {},
                        run: async () => {
                                attempts6 += 1;
                                return { value: { ok: false }, done: false, transient: true };
                        }
                });
                ok(run6.deferred && attempts6 === 0, '§5.7 a budget too small for the minimum slice runs nothing (honest deferral)');

                // §5.7 Retry-After computed delay is bounded by the budget gate.
                now = 0;
                const run7 = await runLivetvWithBoundedRetries<{ ok: boolean }>({
                        totalBudgetMs: 3_000,
                        now: () => now,
                        sleep: async (ms) => {
                                now += ms;
                        },
                        run: async () => ({ value: { ok: false }, done: false, transient: true, retryAfterMs: 2_900 }),
                        computeDelayMs: (_attempt, retryAfterMs) => retryAfterMs ?? 0
                });
                ok(run7.deferred, '§5.8 a Retry-After delay that would blow the budget defers instead of sleeping past it');
        }

        console.log(`\n=== livetv Phase 7 retry-policy verification: ${passed} checks PASSED ===`);
}

main().catch((error) => {
        console.error(error);
        process.exit(1);
});
