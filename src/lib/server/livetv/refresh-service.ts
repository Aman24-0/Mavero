// ============================================================================
// Unified Live TV — Phase 2 refresh service (server-only orchestration).
//
//   Manual/server trigger → eligibility gates → adapter run (bounded) →
//   idempotent ingestion → outcome report (counts + partial-failure
//   diagnostics)
//
// RELIABILITY CONTRACT (Phase 2 brief §9):
//   * Source enabled/status eligibility — mirrors the Phase 1 rule S1/S2
//     gates: a disabled source or a `disabled`/`unavailable` status is never
//     refreshed.
//   * Duplicate refresh prevention — a per-instance in-flight map keyed by
//     source id returns a typed `refresh_in_progress` outcome for a second
//     concurrent call (serverless honesty: per-instance, not global — the
//     same disclosure contract as the repo's rate-limit module).
//   * Bounded refresh duration — an overall deadline (AbortController) is
//     linked into every adapter fetch and the parser.
//   * One source failing never prevents other sources from refreshing —
//     per-source error isolation in the multi-source path.
//   * Failure taxonomy — fetch failure, invalid payload and individual
//     invalid entries are DISTINCT outcomes (kind + counts + bounded
//     samples). Diagnostics never contain credentials or secret-bearing
//     URLs.
//   * No accidental disabling — a refresh NEVER mutates
//     `livetv_sources.enabled`/`status` (or any admin-owned field).
//   * State reporting — the Phase 1 tables carry NO refresh/health columns,
//     so last-attempt/last-success are REPORTED (return value + a bounded
//     per-instance record consumed by the admin status API). A persistent
//     refresh-history schema is documented separately in the plan/worklog
//     for owner review — deliberately NOT implemented in Phase 2.
//   * No scheduler — Phase 2 supports manual/server-triggered refreshes
//     only (brief §9; plan Phase 7 owns scheduling).
// ============================================================================

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../supabase/database.types';
import { LIVETV_PLAYBACK_ELIGIBLE_STATUSES, type LivetvSourceStatus, type LivetvSourceType } from './registry';
import { requireLivetvAdapter, livetvAdapterIdFor } from './adapters';
import { LivetvAdapterError, type LivetvAdapterDeps, type LivetvEntryError } from './adapters/types';
import { planSourceIngestion, applySourceIngestion, type ExistingEndpointRow, type ExistingSourceChannelRow, type LivetvExecutionError, type LivetvIngestionPlan } from './ingestion';

// Re-export for route convenience (single import surface).
export { livetvAdapterIdFor };

/** Bounded defaults for one refresh run. */
export const LIVETV_REFRESH_TIMEOUT_MS = 45_000;
export const LIVETV_REFRESH_MAX_SOURCES_PER_RUN = 25;
/** Bound on stored entry/execution error samples in an outcome. */
const OUTCOME_ENTRY_ERROR_SAMPLE = 100;
const OUTCOME_EXECUTION_ERROR_SAMPLE = 50;

// ---------------------------------------------------------------------------
// Outcome types (the refresh report)
// ---------------------------------------------------------------------------

export type LivetvRefreshFailureKind =
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
        | 'unexpected';

export type LivetvRefreshCounts = {
        /** Entries the adapter normalized successfully. */
        discovered: number;
        /** Entries skipped by the adapter (validation failures + duplicates). */
        skipped: number;
        /** Rows whose DB write failed (per-item isolation). */
        failed: number;
        entriesInserted: number;
        entriesUpdated: number;
        endpointsInserted: number;
        endpointsUpdated: number;
        /** Report-only stale diagnostics (never mutated). */
        endpointsMissingUpstream: number;
        entriesMissingUpstream: number;
};

export type LivetvRefreshSourceOutcome = {
        sourceId: string;
        slug: string;
        sourceType: string;
        adapterId: string | null;
        startedAt: string;
        finishedAt: string;
        durationMs: number;
        ok: boolean;
        /** Typed, diagnostics-safe failure (static message; never a raw URL). */
        failure: { kind: LivetvRefreshFailureKind; message: string } | null;
        counts: LivetvRefreshCounts | null;
        /** Bounded adapter per-entry error sample (safe static reasons). */
        entryErrors: LivetvEntryError[] | null;
        /** Bounded per-item DB write failure sample. */
        ingestionErrors: Pick<LivetvExecutionError, 'scope' | 'sourceChannelId' | 'message'>[] | null;
        /** Skipped entries reason histogram (safe static reasons). */
        skippedReasons: Record<string, number> | null;
};

function nowIso(): string {
        return new Date().toISOString();
}

const ADAPTER_KIND_TO_REFRESH_KIND: Record<string, LivetvRefreshFailureKind> = {
        adapter_unavailable: 'adapter_unavailable',
        invalid_source_config: 'invalid_source_config',
        invalid_url: 'invalid_url',
        blocked_url: 'blocked_url',
        timeout: 'timeout',
        too_large: 'too_large',
        http_error: 'http_error',
        network: 'network',
        unsupported_media_type: 'unsupported_media_type',
        invalid_payload: 'invalid_payload',
        parse_failed: 'parse_failed',
        entry_cap_exceeded: 'entry_cap_exceeded',
        parse_deadline_exceeded: 'parse_deadline_exceeded',
        cancelled: 'cancelled',
        unexpected: 'unexpected'
};

// ---------------------------------------------------------------------------
// Bounded in-memory outcome record (per-instance; serverless honesty applies)
// ---------------------------------------------------------------------------

const MAX_RECORDED_OUTCOMES = 200;
const lastOutcomes = new Map<string, LivetvRefreshSourceOutcome>();

/** Test seam — clears the outcome record and the in-flight map. */
export function resetLivetvRefreshStateForTests(): void {
        lastOutcomes.clear();
        inFlight.clear();
}

/** Last recorded outcome per refreshed source (most recent first, bounded). */
export function getLivetvRefreshOutcomes(): LivetvRefreshSourceOutcome[] {
        return [...lastOutcomes.values()].sort((a, b) => (a.finishedAt < b.finishedAt ? 1 : -1));
}

function recordOutcome(outcome: LivetvRefreshSourceOutcome): void {
        if (lastOutcomes.size >= MAX_RECORDED_OUTCOMES && !lastOutcomes.has(outcome.sourceId)) {
                // Evict the oldest recorded source (insertion order).
                for (const key of lastOutcomes.keys()) {
                        lastOutcomes.delete(key);
                        break;
                }
        }
        lastOutcomes.set(outcome.sourceId, outcome);
}

// ---------------------------------------------------------------------------
// Duplicate-refresh prevention (per-instance)
// ---------------------------------------------------------------------------

const inFlight = new Map<string, Promise<LivetvRefreshSourceOutcome>>();

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

type SourceRow = {
        id: string;
        slug: string;
        source_type: LivetvSourceType;
        enabled: boolean;
        status: LivetvSourceStatus;
        config: unknown;
};

async function loadSourceRow(client: SupabaseClient<Database>, ref: { id?: string; slug?: string }): Promise<{ row: SourceRow | null; error: boolean }> {
        let query = client.from('livetv_sources').select('id, slug, source_type, enabled, status, config').limit(1);
        query = ref.id ? query.eq('id', ref.id) : query.eq('slug', ref.slug ?? '');
        const { data, error } = await query.maybeSingle();
        if (error) return { row: null, error: true };
        return { row: (data as SourceRow | null) ?? null, error: false };
}

async function loadExistingState(client: SupabaseClient<Database>, sourceId: string): Promise<{ entries: ExistingSourceChannelRow[]; endpoints: ExistingEndpointRow[]; error: boolean }> {
        const entriesResult = await client
                .from('livetv_source_channels')
                .select('id, source_id, source_channel_id, canonical_channel_id, name, category, logo_url, tvg_id, enabled, metadata')
                .eq('source_id', sourceId);
        if (entriesResult.error) return { entries: [], endpoints: [], error: true };
        const entries = (entriesResult.data ?? []) as unknown as ExistingSourceChannelRow[];

        // Endpoints are fetched for the whole table then filtered to this
        // source's entry rows (PostgREST has no cross-table filter; the
        // bounded column set keeps this cheap at Phase 2 scale).
        const endpointsResult = await client.from('livetv_playback_endpoints').select('id, source_channel_id, endpoint_kind, stream_format, url, ordering, enabled, label');
        if (endpointsResult.error) return { entries: [], endpoints: [], error: true };
        const entryRowIds = new Set(entries.map((entry) => entry.id));
        const endpoints = ((endpointsResult.data ?? []) as unknown as ExistingEndpointRow[]).filter((endpoint) => entryRowIds.has(endpoint.source_channel_id));
        return { entries, endpoints, error: false };
}

function failureOutcome(started: { at: string; ms: number }, row: { id: string; slug: string; source_type: string } | null, kind: LivetvRefreshFailureKind, message: string): LivetvRefreshSourceOutcome {
        return {
                sourceId: row?.id ?? 'unknown',
                slug: row?.slug ?? 'unknown',
                sourceType: row?.source_type ?? 'unknown',
                adapterId: null,
                startedAt: started.at,
                finishedAt: nowIso(),
                durationMs: Date.now() - started.ms,
                ok: false,
                failure: { kind, message },
                counts: null,
                entryErrors: null,
                ingestionErrors: null,
                skippedReasons: null
        };
}

function linkDeadline(deps: LivetvRefreshDeps, deadlineMs: number): { signal: AbortSignal; dispose: () => void } {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), deadlineMs);
        const external = deps.signal;
        if (external) {
                if (external.aborted) controller.abort();
                const onAbort = () => controller.abort();
                external.addEventListener('abort', onAbort, { once: true });
                return {
                        signal: controller.signal,
                        dispose: () => {
                                clearTimeout(timer);
                                external.removeEventListener('abort', onAbort);
                        }
                };
        }
        return {
                signal: controller.signal,
                dispose: () => clearTimeout(timer)
        };
}

// ---------------------------------------------------------------------------
// Single-source refresh
// ---------------------------------------------------------------------------

export type LivetvRefreshDeps = {
        fetcher?: typeof fetch;
        dnsResolver?: LivetvAdapterDeps['dnsResolver'];
        /** Overall deadline for the whole refresh (default 45s). */
        refreshTimeoutMs?: number;
        /** Per-fetch timeout budget passed to the adapter. */
        timeoutMs?: number;
        maxBytes?: number;
        maxRedirects?: number;
        /** External cancellation linked into the refresh deadline. */
        signal?: AbortSignal;
};

/**
 * Refreshes ONE source by id or slug. Never throws — every failure becomes a
 * typed outcome (safe to call from API routes). A concurrent second call for
 * the same source returns a typed `refresh_in_progress` outcome instead of
 * double-fetching upstream.
 */
export async function refreshLivetvSource(client: SupabaseClient<Database>, ref: { id?: string; slug?: string }, deps: LivetvRefreshDeps = {}): Promise<LivetvRefreshSourceOutcome> {
        const started = { at: nowIso(), ms: Date.now() };
        const inFlightKey = ref.id ?? ref.slug ?? '';

        const pending = inFlight.get(inFlightKey);
        if (pending) {
                return failureOutcome(started, null, 'refresh_in_progress', 'A refresh for this source is already in progress.');
        }

        const run = executeRefresh(client, started, ref, deps).finally(() => {
                inFlight.delete(inFlightKey);
        });
        // Registered synchronously in the same tick as the check above, so a
        // concurrent caller reliably observes it.
        inFlight.set(inFlightKey, run);
        const outcome = await run;
        recordOutcome(outcome);
        return outcome;
}

async function executeRefresh(client: SupabaseClient<Database>, started: { at: string; ms: number }, ref: { id?: string; slug?: string }, deps: LivetvRefreshDeps): Promise<LivetvRefreshSourceOutcome> {
        // --- lookup ---
        const loaded = await loadSourceRow(client, ref);
        if (loaded.error) {
                return failureOutcome(started, null, 'lookup_failed', 'The source lookup failed.');
        }
        if (!loaded.row) {
                return failureOutcome(started, null, 'source_not_found', 'The requested source does not exist.');
        }
        const row = loaded.row;

        // --- eligibility (Phase 1 rule S1/S2 parity) ---
        if (!row.enabled || !LIVETV_PLAYBACK_ELIGIBLE_STATUSES.has(row.status)) {
                return failureOutcome(started, row, 'source_ineligible', 'The source is not eligible for refresh (disabled or non-eligible status).');
        }

        // --- adapter availability ---
        const adapterId = livetvAdapterIdFor(row.source_type);
        if (!adapterId) {
                return failureOutcome(started, row, 'adapter_unavailable', 'No source adapter is available for this source type yet.');
        }
        const adapter = requireLivetvAdapter(row.source_type);

        // --- bounded adapter run ---
        const deadline = linkDeadline(deps, deps.refreshTimeoutMs ?? LIVETV_REFRESH_TIMEOUT_MS);
        let adapterResult;
        try {
                adapterResult = await adapter.run(
                        { id: row.id, slug: row.slug, sourceType: row.source_type, config: row.config },
                        {
                                fetcher: deps.fetcher,
                                dnsResolver: deps.dnsResolver,
                                timeoutMs: deps.timeoutMs,
                                maxBytes: deps.maxBytes,
                                maxRedirects: deps.maxRedirects,
                                signal: deadline.signal
                        }
                );
        } catch (error) {
                if (error instanceof LivetvAdapterError) {
                        const kind = ADAPTER_KIND_TO_REFRESH_KIND[error.kind] ?? 'unexpected';
                        return failureOutcome(started, row, kind, error.message);
                }
                return failureOutcome(started, row, 'unexpected', 'The source refresh failed unexpectedly.');
        } finally {
                deadline.dispose();
        }

        // --- idempotent ingestion ---
        const state = await loadExistingState(client, row.id);
        if (state.error) {
                return failureOutcome(started, row, 'lookup_failed', 'The source state lookup failed.');
        }
        const plan: LivetvIngestionPlan = planSourceIngestion({
                sourceId: row.id,
                adapterChannels: adapterResult.channels,
                existingEntries: state.entries,
                existingEndpoints: state.endpoints
        });
        const execution = await applySourceIngestion(client, plan);

        const counts: LivetvRefreshCounts = {
                discovered: plan.counts.discovered,
                skipped: adapterResult.diagnostics.skippedCount,
                failed: execution.errors.length,
                entriesInserted: plan.counts.entriesInserted,
                entriesUpdated: plan.counts.entriesUpdated,
                endpointsInserted: plan.counts.endpointsInserted,
                endpointsUpdated: plan.counts.endpointsUpdated,
                endpointsMissingUpstream: plan.endpointsMissingUpstream.length,
                entriesMissingUpstream: plan.entriesMissingUpstream
        };
        return {
                sourceId: row.id,
                slug: row.slug,
                sourceType: row.source_type,
                adapterId,
                startedAt: started.at,
                finishedAt: nowIso(),
                durationMs: Date.now() - started.ms,
                // The refresh "succeeded" when the fetch/parse/persist pipeline
                // completed; per-entry validation failures and per-item write
                // errors are partial-failure diagnostics, not a source failure.
                ok: true,
                failure: null,
                counts,
                entryErrors: adapterResult.diagnostics.entryErrors.slice(0, OUTCOME_ENTRY_ERROR_SAMPLE),
                ingestionErrors: execution.errors.slice(0, OUTCOME_EXECUTION_ERROR_SAMPLE).map(({ scope, sourceChannelId, message }) => ({ scope, sourceChannelId, message })),
                skippedReasons: adapterResult.diagnostics.skippedReasons
        };
}

// ---------------------------------------------------------------------------
// Multi-source refresh (per-source isolation)
// ---------------------------------------------------------------------------

export type LivetvRefreshAllOutcome = {
        startedAt: string;
        finishedAt: string;
        durationMs: number;
        /** How many eligible sources were considered (before the run cap). */
        eligibleSources: number;
        /** How many actually ran (bounded). */
        refreshedSources: number;
        outcomes: LivetvRefreshSourceOutcome[];
};

/**
 * Refreshes every ELIGIBLE source (enabled + eligible status + available
 * adapter), sequentially and per-source isolated. One failing source never
 * prevents the others. Bounded per run.
 */
export async function refreshAllEligibleLivetvSources(client: SupabaseClient<Database>, deps: LivetvRefreshDeps = {}): Promise<LivetvRefreshAllOutcome> {
        const started = { at: nowIso(), ms: Date.now() };
        const { data, error } = await client.from('livetv_sources').select('id, slug, source_type, enabled, status').order('priority', { ascending: true }).order('slug', { ascending: true });
        if (error) {
                return { startedAt: started.at, finishedAt: nowIso(), durationMs: Date.now() - started.ms, eligibleSources: 0, refreshedSources: 0, outcomes: [] };
        }
        const rows = (data ?? []) as unknown as { id: string; slug: string; source_type: LivetvSourceType; enabled: boolean; status: LivetvSourceStatus }[];
        const eligible = rows.filter((row) => row.enabled && LIVETV_PLAYBACK_ELIGIBLE_STATUSES.has(row.status) && livetvAdapterIdFor(row.source_type) !== null);

        const outcomes: LivetvRefreshSourceOutcome[] = [];
        const bounded = eligible.slice(0, LIVETV_REFRESH_MAX_SOURCES_PER_RUN);
        for (const row of bounded) {
                try {
                        outcomes.push(await refreshLivetvSource(client, { id: row.id }, deps));
                } catch {
                        // Defensive isolation — refreshLivetvSource never throws,
                        // but one source must never break the batch even if it did.
                        outcomes.push(failureOutcome(started, row, 'unexpected', 'The source refresh failed unexpectedly.'));
                }
        }
        return { startedAt: started.at, finishedAt: nowIso(), durationMs: Date.now() - started.ms, eligibleSources: eligible.length, refreshedSources: bounded.length, outcomes };
}

// ---------------------------------------------------------------------------
// Dry-run preview (fetch + normalize + plan; NO writes)
// ---------------------------------------------------------------------------

export type LivetvPreviewOutcome = {
        ok: boolean;
        failure: { kind: LivetvRefreshFailureKind; message: string } | null;
        adapterId: string | null;
        /** Plan counts (what a real refresh WOULD write). */
        counts: LivetvRefreshCounts | null;
        entryErrors: LivetvEntryError[] | null;
        skippedReasons: Record<string, number> | null;
        /** Endpoint-kind histogram of the normalized payload (safe; no URLs). */
        endpointKinds: Record<string, number> | null;
};

/**
 * Validates + fetches + normalizes + plans a source WITHOUT persisting
 * anything — the safe testing/validation surface for adapters (and the
 * future Phase 4 admin validation flow). Never throws. The response carries
 * counts and static reasons only — never an upstream URL.
 */
export async function previewLivetvSource(client: SupabaseClient<Database>, ref: { id?: string; slug?: string }, deps: LivetvRefreshDeps = {}): Promise<LivetvPreviewOutcome> {
        const loaded = await loadSourceRow(client, ref);
        if (loaded.error) return previewFailure('lookup_failed', 'The source lookup failed.');
        if (!loaded.row) return previewFailure('source_not_found', 'The requested source does not exist.');
        const row = loaded.row;
        if (!row.enabled || !LIVETV_PLAYBACK_ELIGIBLE_STATUSES.has(row.status)) {
                return previewFailure('source_ineligible', 'The source is not eligible (disabled or non-eligible status).');
        }
        const adapterId = livetvAdapterIdFor(row.source_type);
        if (!adapterId) return previewFailure('adapter_unavailable', 'No source adapter is available for this source type yet.');
        const adapter = requireLivetvAdapter(row.source_type);

        const deadline = linkDeadline(deps, deps.refreshTimeoutMs ?? LIVETV_REFRESH_TIMEOUT_MS);
        let adapterResult;
        try {
                adapterResult = await adapter.run(
                        { id: row.id, slug: row.slug, sourceType: row.source_type, config: row.config },
                        {
                                fetcher: deps.fetcher,
                                dnsResolver: deps.dnsResolver,
                                timeoutMs: deps.timeoutMs,
                                maxBytes: deps.maxBytes,
                                maxRedirects: deps.maxRedirects,
                                signal: deadline.signal
                        }
                );
        } catch (error) {
                if (error instanceof LivetvAdapterError) {
                        return previewFailure(ADAPTER_KIND_TO_REFRESH_KIND[error.kind] ?? 'unexpected', error.message, adapterId);
                }
                return previewFailure('unexpected', 'The source preview failed unexpectedly.', adapterId);
        } finally {
                deadline.dispose();
        }

        const state = await loadExistingState(client, row.id);
        if (state.error) return previewFailure('lookup_failed', 'The source state lookup failed.', adapterId);
        const plan = planSourceIngestion({ sourceId: row.id, adapterChannels: adapterResult.channels, existingEntries: state.entries, existingEndpoints: state.endpoints });

        const endpointKinds: Record<string, number> = {};
        for (const channel of adapterResult.channels) {
                for (const endpoint of channel.endpoints) {
                        const key = endpoint.endpointKind + (endpoint.streamFormat ? `:${endpoint.streamFormat}` : '');
                        endpointKinds[key] = (endpointKinds[key] ?? 0) + 1;
                }
        }

        return {
                ok: true,
                failure: null,
                adapterId,
                counts: {
                        discovered: plan.counts.discovered,
                        skipped: adapterResult.diagnostics.skippedCount,
                        failed: 0,
                        entriesInserted: plan.counts.entriesInserted,
                        entriesUpdated: plan.counts.entriesUpdated,
                        endpointsInserted: plan.counts.endpointsInserted,
                        endpointsUpdated: plan.counts.endpointsUpdated,
                        endpointsMissingUpstream: plan.endpointsMissingUpstream.length,
                        entriesMissingUpstream: plan.entriesMissingUpstream
                },
                entryErrors: adapterResult.diagnostics.entryErrors.slice(0, OUTCOME_ENTRY_ERROR_SAMPLE),
                skippedReasons: adapterResult.diagnostics.skippedReasons,
                endpointKinds
        };
}

function previewFailure(kind: LivetvRefreshFailureKind, message: string, adapterId: string | null = null): LivetvPreviewOutcome {
        return { ok: false, failure: { kind, message }, adapterId, counts: null, entryErrors: null, skippedReasons: null, endpointKinds: null };
}
