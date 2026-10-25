// ============================================================================
// Unified Live TV — Phase 7 scheduled-refresh orchestration (server-only).
//
// The reusable scheduler: a PURE deterministic tick planner plus a bounded
// executor. The deployment mechanism (Netlify scheduled function or any
// external scheduler) reaches the executor through exactly TWO entrances:
//
//   * the secret-gated endpoint  POST /api/livetv/scheduler/tick
//     (shared secret from server-side env, timing-safe compare), and
//   * the generated Netlify scheduled function (scripts/livetv-scheduler-
//     entry.ts, emitted ONLY when LIVETV_SCHEDULER_CRON is configured at
//     build time — no env ⇒ no emitted function ⇒ NO hidden schedule).
//
// Both entrances run the SAME bounded tick; neither is active unless the
// owner configures it. The manual admin refresh action is completely
// separate (single-attempt, admin-authorized, rate-limited — untouched).
//
// BOUNDS (Phase 7 brief §3/§9):
//   * tick budget 8s — inside the Netlify synchronous-function cap; a
//     source that cannot start before the budget floor is DEFERRED (left
//     due; the next tick picks it up — refreshes are idempotent).
//   * ≤ 3 playlist/API sources + ≤ 2 EPG sources per tick, executed
//     SEQUENTIALLY (per-invocation global concurrency 1).
//   * per-source intervals: optional `refreshIntervalMinutes` (15..10080)
//     in the EXISTING config jsonb contract; default 720 (12h). No second
//     scheduler configuration table.
//   * deterministic per-source jitter (hash(slug)-derived, ±10% of the
//     interval, capped 30 min) desynchronizes upstream hits across sources
//     WITHOUT shared state.
//   * consecutive-failure backoff: the effective interval grows ×2 per
//     consecutive failure (capped ×8) — bounded retry storms across ticks;
//     in-run, ONE bounded retry (max 2 attempts, budget-gated) via the
//     shared retry policy for TRANSIENT failures only.
//   * duplicate/overlapping invocation protection: the per-instance
//     in-flight guard (keyed by resolved source id) PLUS a history-backed
//     duplicate window (a source attempted within the last 120s is
//     skipped) — the cross-instance guard.
//   * serverless honesty: instance-local state is per-instance, exactly
//     like the rate-limit module; the durable coordination surface is the
//     history table.
//   * NO playback interaction: the scheduler refreshes registry data only;
//     playback routing/fallback remains exclusively Phase 5's.
// ============================================================================

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../supabase/database.types';
import { timingSafeEqual, createHash } from 'node:crypto';
import { LIVETV_PLAYBACK_ELIGIBLE_STATUSES, type LivetvSourceStatus, type LivetvSourceType } from './registry';
import { livetvAdapterIdFor } from './adapters';
import { validateEpgSourceConfig } from './epg/guide-service';
import { refreshLivetvSource, type LivetvRefreshSourceOutcome } from './refresh-service';
import { refreshLivetvEpgSource, type LivetvEpgRefreshOutcome } from './epg/guide-service';
import { classifyLivetvFailureForRetry, computeLivetvRetryDelayMs, livetvJitterRandomForSeed, runLivetvWithBoundedRetries } from './retry';
import { getLivetvRefreshHistoryPage, summarizeLivetvSubjectHealth, applyLivetvHistoryRetention, type LivetvSubjectHealthSummary } from './history';

// ---------------------------------------------------------------------------
// Bounded policy constants (documented in docs/livetv/LIVETV_OPERATIONS.md)
// ---------------------------------------------------------------------------

export const LIVETV_SCHEDULER_DEFAULT_INTERVAL_MINUTES = 720; // 12h
export const LIVETV_SCHEDULER_MIN_INTERVAL_MINUTES = 15;
export const LIVETV_SCHEDULER_MAX_INTERVAL_MINUTES = 10_080; // 7 days
/** Wall-clock budget of ONE tick (inside the 10s sync-function cap). */
export const LIVETV_SCHEDULER_TICK_BUDGET_MS = 8_000;
/** Maximum playlist/API sources refreshed per tick. */
export const LIVETV_SCHEDULER_MAX_SOURCES_PER_TICK = 3;
/** Maximum EPG guide sources refreshed per tick. */
export const LIVETV_SCHEDULER_MAX_EPG_SOURCES_PER_TICK = 2;
/** Deterministic per-source jitter as a fraction of the interval. */
export const LIVETV_SCHEDULER_JITTER_RATIO = 0.1;
/** Hard cap on the absolute jitter added to a due date. */
export const LIVETV_SCHEDULER_MAX_JITTER_MS = 30 * 60_000;
/** A source attempted this recently is SKIPPED as a duplicate invocation. */
export const LIVETV_SCHEDULER_DUPLICATE_WINDOW_MS = 120_000;
/** In-run retry bounds (the ONE retry layer; see retry.ts). */
export const LIVETV_SCHEDULER_MAX_ATTEMPTS = 2;
export const LIVETV_SCHEDULER_MIN_ATTEMPT_SLICE_MS = 1_500;
/** Consecutive-failure backoff: ×2^k capped (applied to the interval). */
export const LIVETV_SCHEDULER_FAILURE_BACKOFF_CAP = 8;
/** Bound on the candidate load per tick (registry rows read for planning). */
export const LIVETV_SCHEDULER_MAX_CANDIDATES = 200;

// ---------------------------------------------------------------------------
// Secret verification (fail-closed, timing-safe)
// ---------------------------------------------------------------------------

/**
 * Verifies the scheduler shared secret. The secret lives ONLY in server-side
 * environment configuration (`LIVETV_SCHEDULER_SECRET`); it is never placed
 * in client code, URLs, logs, commits or documentation.
 *
 * Fail-closed: an unset/empty env means NO schedule can ever authenticate —
 * the endpoint reports "unconfigured" and rejects before any work.
 * Comparison is timing-safe (SHA-256 digests via timingSafeEqual).
 */
export function verifyLivetvSchedulerSecret(providedSecret: string | null | undefined, configuredSecret?: string): boolean {
        const expected = (configuredSecret ?? process.env['LIVETV_SCHEDULER_SECRET'] ?? '').trim();
        if (expected.length === 0) return false;
        const provided = (providedSecret ?? '').trim();
        if (provided.length === 0) return false;
        // Length-independent timing-safe comparison over fixed-size digests.
        const expectedDigest = createHash('sha256').update(expected).digest();
        const providedDigest = createHash('sha256').update(provided).digest();
        return timingSafeEqual(expectedDigest, providedDigest);
}

/** True when the deployment has a scheduler secret configured (boolean ONLY — never the secret). */
export function isLivetvSchedulerConfigured(configuredSecret?: string): boolean {
        return (configuredSecret ?? process.env['LIVETV_SCHEDULER_SECRET'] ?? '').trim().length > 0;
}

// ---------------------------------------------------------------------------
// Per-source interval resolution (the EXISTING config contract)
// ---------------------------------------------------------------------------

/**
 * Reads the optional `refreshIntervalMinutes` from a validated config
 * document (m3u_playlist / api_provider / builtin_livegt_v1 sources and EPG
 * sources). Defensive re-validation: anything invalid falls back to the
 * default interval — a bad config can never unbound the scheduler.
 */
export function livetvSchedulerIntervalMinutesFromConfig(config: unknown): number {
        const fallback = LIVETV_SCHEDULER_DEFAULT_INTERVAL_MINUTES;
        if (typeof config !== 'object' || config === null || Array.isArray(config)) return fallback;
        const raw = (config as Record<string, unknown>)['refreshIntervalMinutes'];
        if (raw === undefined || raw === null) return fallback;
        // Strict re-validation (parity with the registry validator): a
        // non-integer slipped into the jsonb falls back to the default —
        // the scheduler never rounds a value the config contract would
        // have rejected at write time.
        if (typeof raw !== 'number' || !Number.isFinite(raw) || !Number.isInteger(raw)) return fallback;
        if (raw < LIVETV_SCHEDULER_MIN_INTERVAL_MINUTES || raw > LIVETV_SCHEDULER_MAX_INTERVAL_MINUTES) return fallback;
        return raw;
}

// ---------------------------------------------------------------------------
// PURE tick planner (deterministic; fully unit-testable)
// ---------------------------------------------------------------------------

export type LivetvSchedulerCandidateKind = 'source' | 'epg_source';

export type LivetvSchedulerCandidate = {
        kind: LivetvSchedulerCandidateKind;
        id: string;
        slug: string;
        /** Resolved interval (minutes; validated/defensively bounded). */
        intervalMinutes: number;
        /** Epoch ms of the last recorded attempt (null = never attempted). */
        lastAttemptMs: number | null;
        /** Epoch ms of the last recorded success (diagnostics only). */
        lastSuccessMs: number | null;
        /** Trailing consecutive failure/timeout count (drives the backoff). */
        consecutiveFailures: number;
};

export type LivetvPlannedSubject = {
        kind: LivetvSchedulerCandidateKind;
        id: string;
        slug: string;
        /** When this subject became due (epoch ms; backoff+jitter applied). */
        dueAtMs: number;
        /** True when the duplicate window skipped it this tick. */
        duplicate: boolean;
};

export type LivetvTickPlan = {
        nowMs: number;
        /** Due subjects the tick WILL run (capped, most-overdue first). */
        planned: LivetvPlannedSubject[];
        /** Due subjects the tick would have run but had no capacity for. */
        skippedForCapacity: LivetvPlannedSubject[];
        /** Due subjects skipped by the duplicate window (recent attempt). */
        skippedDuplicates: LivetvPlannedSubject[];
        /** Not-yet-due subjects with their computed due dates. */
        deferred: Array<LivetvPlannedSubject & { dueInMs: number }>;
};

/**
 * Deterministically plans one tick. A candidate attempted within the
 * duplicate window is SKIPPED as a duplicate invocation (candidate-level —
 * independent of the due math; the cross-instance overlap guard). Otherwise
 * a subject is DUE when `now >= lastAttempt + effectiveInterval + jitter`
 * where the effective interval grows ×2 per consecutive failure (capped ×8)
 * and the jitter is hash(slug)-derived (±10% of the interval, capped 30 min).
 * Due subjects are ordered MOST-OVERDUE-FIRST (dueAt asc, then slug asc) and
 * capped by the per-kind tick limits. The same inputs always produce the
 * same plan.
 */
export function planLivetvSchedulerTick(options: { nowMs: number; candidates: LivetvSchedulerCandidate[]; maxSources?: number; maxEpgSources?: number; duplicateWindowMs?: number }): LivetvTickPlan {
        const nowMs = options.nowMs;
        const maxSources = Math.max(0, Math.floor(options.maxSources ?? LIVETV_SCHEDULER_MAX_SOURCES_PER_TICK));
        const maxEpgSources = Math.max(0, Math.floor(options.maxEpgSources ?? LIVETV_SCHEDULER_MAX_EPG_SOURCES_PER_TICK));
        const duplicateWindowMs = options.duplicateWindowMs ?? LIVETV_SCHEDULER_DUPLICATE_WINDOW_MS;

        const due: LivetvPlannedSubject[] = [];
        const deferred: Array<LivetvPlannedSubject & { dueInMs: number }> = [];
        const duplicates: LivetvPlannedSubject[] = [];

        for (const candidate of options.candidates) {
                const intervalMs = Math.max(1, candidate.intervalMinutes) * 60_000;
                // Consecutive-failure backoff: ×2^(k-1) capped — bounded, never
                // infinite; after the cap the source stays due at the stretched
                // interval (it still gets attempted, honestly).
                const backoffFactor = Math.min(Math.pow(2, Math.max(0, candidate.consecutiveFailures)), LIVETV_SCHEDULER_FAILURE_BACKOFF_CAP);
                const effectiveIntervalMs = Math.min(intervalMs * backoffFactor, LIVETV_SCHEDULER_MAX_INTERVAL_MINUTES * 60_000);
                // Deterministic jitter: ±JITTER_RATIO of the interval, capped.
                const random = livetvJitterRandomForSeed(`${candidate.kind}:${candidate.slug}`);
                const jitterMs = Math.min(random() * 2 * LIVETV_SCHEDULER_JITTER_RATIO * intervalMs, LIVETV_SCHEDULER_MAX_JITTER_MS);
                const baseDueMs = candidate.lastAttemptMs === null ? 0 : candidate.lastAttemptMs + effectiveIntervalMs + jitterMs;
                // No clamping: a future due date is DEFERRED (the interval +
                // backoff + jitter honesty), a past/zero one is due now.
                const dueAtMs = baseDueMs;
                // The duplicate window applies at CANDIDATE level (independent
                // of the due date): a subject attempted within the window is
                // skipped this tick even if the interval math says due — that
                // is the cross-instance duplicate-invocation protection (two
                // overlapping ticks, or a tick racing a manual refresh).
                const duplicate = candidate.lastAttemptMs !== null && nowMs - candidate.lastAttemptMs < duplicateWindowMs;
                const subject: LivetvPlannedSubject = { kind: candidate.kind, id: candidate.id, slug: candidate.slug, dueAtMs, duplicate };
                if (duplicate) {
                        duplicates.push(subject);
                } else if (dueAtMs <= nowMs) {
                        due.push(subject);
                } else {
                        deferred.push({ ...subject, dueInMs: dueAtMs - nowMs });
                }
        }

        // Deterministic order: most-overdue first, then slug.
        due.sort((a, b) => (a.dueAtMs !== b.dueAtMs ? a.dueAtMs - b.dueAtMs : a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
        deferred.sort((a, b) => (a.dueAtMs !== b.dueAtMs ? a.dueAtMs - b.dueAtMs : a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));

        const planned: LivetvPlannedSubject[] = [];
        const skippedForCapacity: LivetvPlannedSubject[] = [];
        const skippedDuplicates: LivetvPlannedSubject[] = duplicates;
        let sources = 0;
        let epgSources = 0;
        for (const subject of due) {
                const kindCap = subject.kind === 'source' ? maxSources : maxEpgSources;
                const used = subject.kind === 'source' ? sources : epgSources;
                if (used >= kindCap) {
                        skippedForCapacity.push(subject);
                        continue;
                }
                if (subject.kind === 'source') sources += 1;
                else epgSources += 1;
                planned.push(subject);
        }

        return { nowMs, planned, skippedForCapacity, skippedDuplicates, deferred };
}

// ---------------------------------------------------------------------------
// Bounded tick executor
// ---------------------------------------------------------------------------

export type LivetvSchedulerDeps = {
        fetcher?: typeof fetch;
        dnsResolver?: (host: string) => Promise<{ address: string; family: number }[]>;
        maxSources?: number;
        maxEpgSources?: number;
        budgetMs?: number;
        /** Injected sleep (tests use a recorder — CI never sleeps for real). */
        sleep?: (ms: number) => Promise<void>;
        /** Injected clock (fake-clock tests). */
        now?: () => number;
        /** External cancellation linked into every refresh deadline. */
        signal?: AbortSignal;
        /** Retention sweep override (tests); default ON at tick end. */
        retention?: boolean;
        /** History page size override (tests). */
        historyLimit?: number;
};

export type LivetvTickSubjectResult = {
        kind: LivetvSchedulerCandidateKind;
        id: string;
        slug: string;
        ok: boolean;
        status: string;
        attempts: number;
        correlationId: string;
        durationMs: number;
        errorCategory: string | null;
        deferred: boolean;
};

export type LivetvSchedulerTickResult = {
        ok: boolean;
        startedAt: string;
        finishedAt: string;
        durationMs: number;
        plannedSources: number;
        plannedEpgSources: number;
        deferredSources: number;
        deferredEpgSources: number;
        skippedDuplicates: number;
        /** Bounded per-subject results (≤ planned count; counts + categories ONLY). */
        results: LivetvTickSubjectResult[];
        /** Best-effort retention sweep outcome. */
        retentionDeleted: number | null;
};

function isoNow(now?: () => number): string {
        return new Date(now ? now() : Date.now()).toISOString();
}

/**
 * Executes ONE bounded scheduler tick: plan from the registry + durable
 * history, then refresh due subjects sequentially under the wall-clock
 * budget (one bounded retry per subject for transient failures). Never
 * throws — every failure is contained in the bounded summary. The tick
 * ends with a best-effort bounded history retention sweep.
 */
export async function executeLivetvSchedulerTick(client: SupabaseClient<Database>, deps: LivetvSchedulerDeps = {}): Promise<LivetvSchedulerTickResult> {
        const now = deps.now ?? Date.now;
        const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
        const budgetMs = Math.max(1_000, Math.min(deps.budgetMs ?? LIVETV_SCHEDULER_TICK_BUDGET_MS, 10_000));
        const startedMs = now();
        const startedAt = new Date(startedMs).toISOString();
        const deadlineMs = startedMs + budgetMs;

        const result: LivetvSchedulerTickResult = {
                ok: true,
                startedAt,
                finishedAt: startedAt,
                durationMs: 0,
                plannedSources: 0,
                plannedEpgSources: 0,
                deferredSources: 0,
                deferredEpgSources: 0,
                skippedDuplicates: 0,
                results: [],
                retentionDeleted: null
        };

        // --- 1. candidate loads (bounded) ---
        const sourcesResult = await client
                .from('livetv_sources')
                .select('id, slug, source_type, enabled, status, config')
                .order('priority', { ascending: true })
                .order('slug', { ascending: true })
                .limit(LIVETV_SCHEDULER_MAX_CANDIDATES);
        const epgResult = await client
                .from('livetv_epg_sources')
                .select('id, slug, enabled, status, config')
                .order('slug', { ascending: true })
                .limit(LIVETV_SCHEDULER_MAX_CANDIDATES);
        if (sourcesResult.error || epgResult.error) {
                result.ok = false;
                result.finishedAt = isoNow(now);
                result.durationMs = Math.max(0, now() - startedMs);
                return result;
        }

        // --- 2. durable history → per-subject health (bounded page) ---
        const historyRows = await getLivetvRefreshHistoryPage(client, { limit: deps.historyLimit ?? 300 });
        const health = new Map<string, LivetvSubjectHealthSummary>();
        for (const summary of summarizeLivetvSubjectHealth(historyRows)) {
                health.set(`${summary.subjectKind}:${summary.subjectId}`, summary);
        }

        // --- 3. candidate inputs (registry eligibility respected) ---
        const candidates: LivetvSchedulerCandidate[] = [];
        const sourceRows = (sourcesResult.data ?? []) as unknown as { id: string; slug: string; source_type: LivetvSourceType; enabled: boolean; status: LivetvSourceStatus; config: unknown }[];
        for (const row of sourceRows) {
                // Eligibility gates mirror the refresh service (S1/S2 + adapter
                // availability): disabled/unavailable/adapter-less sources are
                // NEVER scheduled.
                if (!row.enabled || !LIVETV_PLAYBACK_ELIGIBLE_STATUSES.has(row.status)) continue;
                if (livetvAdapterIdFor(row.source_type) === null) continue;
                const summary = health.get(`source:${row.id}`);
                candidates.push({
                        kind: 'source',
                        id: row.id,
                        slug: row.slug,
                        intervalMinutes: livetvSchedulerIntervalMinutesFromConfig(row.config),
                        lastAttemptMs: summary?.lastAttemptAt ? Date.parse(summary.lastAttemptAt) : null,
                        lastSuccessMs: summary?.lastSuccessAt ? Date.parse(summary.lastSuccessAt) : null,
                        consecutiveFailures: summary?.consecutiveFailures ?? 0
                });
        }
        const epgRows = (epgResult.data ?? []) as unknown as { id: string; slug: string; enabled: boolean; status: string; config: unknown }[];
        for (const row of epgRows) {
                if (!row.enabled || !LIVETV_PLAYBACK_ELIGIBLE_STATUSES.has(row.status as LivetvSourceStatus)) continue;
                // A structurally-invalid EPG config (e.g. a bad timezone) would
                // fail every refresh — the scheduler still attempts it honestly
                // (config validation stays the refresh service's job); only the
                // INTERVAL is defensively read here.
                try {
                        validateEpgSourceConfig(row.config);
                } catch {
                        // Invalid config ⇒ the refresh would fail deterministically;
                        // schedule it at the default interval so the failure and its
                        // history stay visible (never silently dropped).
                }
                const summary = health.get(`epg_source:${row.id}`);
                candidates.push({
                        kind: 'epg_source',
                        id: row.id,
                        slug: row.slug,
                        intervalMinutes: livetvSchedulerIntervalMinutesFromConfig(row.config),
                        lastAttemptMs: summary?.lastAttemptAt ? Date.parse(summary.lastAttemptAt) : null,
                        lastSuccessMs: summary?.lastSuccessAt ? Date.parse(summary.lastSuccessAt) : null,
                        consecutiveFailures: summary?.consecutiveFailures ?? 0
                });
        }

        // --- 4. deterministic plan ---
        const plan = planLivetvSchedulerTick({ nowMs: startedMs, candidates, maxSources: deps.maxSources, maxEpgSources: deps.maxEpgSources });
        result.plannedSources = plan.planned.filter((subject) => subject.kind === 'source').length;
        result.plannedEpgSources = plan.planned.filter((subject) => subject.kind === 'epg_source').length;
        result.deferredSources = plan.skippedForCapacity.filter((subject) => subject.kind === 'source').length + plan.deferred.filter((subject) => subject.kind === 'source').length;
        result.deferredEpgSources = plan.skippedForCapacity.filter((subject) => subject.kind === 'epg_source').length + plan.deferred.filter((subject) => subject.kind === 'epg_source').length;
        result.skippedDuplicates = plan.skippedDuplicates.length;

        // --- 5. execute (sequential; budget-gated; ONE bounded retry layer) ---
        for (const subject of plan.planned) {
                if (deps.signal?.aborted) break;
                const remainingMs = deadlineMs - now();
                if (remainingMs < LIVETV_SCHEDULER_MIN_ATTEMPT_SLICE_MS) break; // defer — never start what cannot finish
                const correlationId = crypto.randomUUID();

                if (subject.kind === 'source') {
                        const runResult = await runLivetvWithBoundedRetries<LivetvRefreshSourceOutcome>({
                                maxAttempts: LIVETV_SCHEDULER_MAX_ATTEMPTS,
                                totalBudgetMs: Math.max(1, deadlineMs - now()),
                                minAttemptSliceMs: LIVETV_SCHEDULER_MIN_ATTEMPT_SLICE_MS,
                                sleep,
                                now,
                                signal: deps.signal,
                                computeDelayMs: (attempt, retryAfterMs) => computeLivetvRetryDelayMs({ attempt, retryAfterMs, maxDelayMs: 2_000, random: livetvJitterRandomForSeed(`retry:${correlationId}:${attempt}`) }),
                                run: async (attempt) => {
                                        const outcome = await refreshLivetvSource(client, { id: subject.id }, {
                                                fetcher: deps.fetcher,
                                                dnsResolver: deps.dnsResolver,
                                                // The per-attempt deadline respects the tick budget.
                                                refreshTimeoutMs: Math.max(1, Math.min(45_000, deadlineMs - now())),
                                                signal: deps.signal,
                                                trigger: 'scheduled',
                                                correlationId,
                                                attemptNumber: attempt
                                        });
                                        const transient = !outcome.ok && classifyLivetvFailureForRetry(outcome.failure?.kind ?? 'unexpected', null) === 'transient';
                                        const retryAfterMs = null; // outcome taxonomy carries no fetch error surface here; Retry-After rides in-run only when classified from http_error below
                                        return { value: outcome, done: outcome.ok, transient, retryAfterMs };
                                }
                        });
                        const outcome = runResult.value;
                        result.results.push({
                                kind: subject.kind,
                                id: subject.id,
                                slug: subject.slug,
                                ok: outcome?.ok ?? false,
                                status: outcome?.ok ? 'success' : outcome?.failure?.kind ?? 'unexpected',
                                attempts: Math.max(1, runResult.attempts),
                                correlationId,
                                durationMs: outcome?.durationMs ?? 0,
                                errorCategory: outcome?.failure?.kind ?? null,
                                deferred: runResult.deferred
                        });
                } else {
                        const runResult = await runLivetvWithBoundedRetries<LivetvEpgRefreshOutcome>({
                                maxAttempts: LIVETV_SCHEDULER_MAX_ATTEMPTS,
                                totalBudgetMs: Math.max(1, deadlineMs - now()),
                                minAttemptSliceMs: LIVETV_SCHEDULER_MIN_ATTEMPT_SLICE_MS,
                                sleep,
                                now,
                                signal: deps.signal,
                                computeDelayMs: (attempt, retryAfterMs) => computeLivetvRetryDelayMs({ attempt, retryAfterMs, maxDelayMs: 2_000, random: livetvJitterRandomForSeed(`retry:${correlationId}:${attempt}`) }),
                                run: async (attempt) => {
                                        const outcome = await refreshLivetvEpgSource(client, { id: subject.id }, {
                                                fetcher: deps.fetcher,
                                                dnsResolver: deps.dnsResolver,
                                                refreshTimeoutMs: Math.max(1, Math.min(60_000, deadlineMs - now())),
                                                signal: deps.signal,
                                                trigger: 'scheduled',
                                                correlationId,
                                                attemptNumber: attempt
                                        });
                                        const transient = !outcome.ok && classifyLivetvFailureForRetry(outcome.failure?.kind ?? 'unexpected', null) === 'transient';
                                        return { value: outcome, done: outcome.ok, transient };
                                }
                        });
                        const outcome = runResult.value;
                        result.results.push({
                                kind: subject.kind,
                                id: subject.id,
                                slug: subject.slug,
                                ok: outcome?.ok ?? false,
                                status: outcome?.ok ? 'success' : outcome?.failure?.kind ?? 'unexpected',
                                attempts: Math.max(1, runResult.attempts),
                                correlationId,
                                durationMs: outcome?.durationMs ?? 0,
                                errorCategory: outcome?.failure?.kind ?? null,
                                deferred: runResult.deferred
                        });
                }
        }

        // --- 6. best-effort bounded retention sweep ---
        if (deps.retention !== false && !deps.signal?.aborted && deadlineMs - now() > 500) {
                try {
                        const retention = await applyLivetvHistoryRetention(client, { now: now() });
                        result.retentionDeleted = retention.deleted;
                } catch {
                        result.retentionDeleted = null;
                }
        }

        result.ok = result.results.every((entry) => entry.ok || entry.deferred);
        result.finishedAt = isoNow(now);
        result.durationMs = Math.max(0, now() - startedMs);
        return result;
}
