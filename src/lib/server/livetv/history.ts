// ============================================================================
// Unified Live TV — Phase 7 persistent refresh history (server-only).
//
// The durable half of the Phase 2 P2-8 proposal, realized where the Phase 7
// scheduler makes it load-bearing. ONE row per refresh ATTEMPT is appended
// to `livetv_refresh_history` (migration 20261122000000) for scheduled AND
// manual triggers; the per-instance in-memory outcome records of the
// refresh services remain the immediate UI surface (compatibility path).
//
// CONTRACTS:
//   * BEST-EFFORT, NEVER LOAD-BEARING FOR CORRECTNESS — a history write
//     failure NEVER fails a refresh; the caller learns through the
//     `historyPersisted` flag on the outcome (deterministic drill #10).
//   * SANITIZED BY THE WRITER — only typed outcome fields become rows;
//     every free-text value passes sanitizeLivetvDiagnosticText and the
//     DB CHECK caps bound it again. No credentials, signed URLs, raw
//     provider responses or payload bodies can be persisted.
//   * ADMIN-ONLY CONSUMPTION — rows are read exclusively by the
//     admin-only diagnostics surfaces (the ops status endpoint) and the
//     scheduler planner; the RLS posture of the table is admin-all.
//   * BOUNDED — every read carries an explicit limit; retention sweeps
//     delete in bounded batches (the epg/retention.ts conventions) so the
//     table can never grow without bound.
//   * HISTORY SURVIVES DELETION — rows carry (subject_kind, subject_id)
//     with NO foreign key plus a bounded slug snapshot; a subject that no
//     longer resolves is reported honestly as a deleted source.
// ============================================================================

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../supabase/database.types';
import { sanitizeLivetvDiagnosticText } from './redact';
import type { LivetvRefreshSourceOutcome } from './refresh-service';
import type { LivetvEpgRefreshOutcome } from './epg/guide-service';

/** Default retention window for history rows (30 days). */
export const LIVETV_HISTORY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
/** Rows deleted per batch and per sweep call (bounded work; epg/retention parity). */
export const LIVETV_HISTORY_RETENTION_BATCH_SIZE = 500;
export const LIVETV_HISTORY_RETENTION_MAX_BATCHES = 40;
/** Hard bound on any history page read (admin diagnostics + planner). */
export const LIVETV_HISTORY_MAX_PAGE = 300;

export type LivetvRefreshHistoryInsert = Database['public']['Tables']['livetv_refresh_history']['Insert'];

export type LivetvHistoryTrigger = 'scheduled' | 'manual';

// ---------------------------------------------------------------------------
// Outcome → sanitized history row (the ONLY writer path into the table)
// ---------------------------------------------------------------------------

type HistoryStatus = 'success' | 'partial' | 'failure' | 'timeout' | 'cancelled' | 'skipped';

const SKIPPED_KINDS = new Set(['refresh_in_progress', 'source_ineligible', 'source_not_found', 'epg_source_ineligible', 'epg_source_not_found']);

function statusForOutcome(outcome: { ok: boolean; failure: { kind: string } | null; errorCount: number }): HistoryStatus {
        if (outcome.ok) return outcome.errorCount > 0 ? 'partial' : 'success';
        const kind = outcome.failure?.kind ?? 'unexpected';
        if (kind === 'timeout') return 'timeout';
        if (kind === 'cancelled') return 'cancelled';
        if (SKIPPED_KINDS.has(kind)) return 'skipped';
        return 'failure';
}

function boundedDurationMs(durationMs: number): number {
        if (!Number.isFinite(durationMs) || durationMs < 0) return 0;
        return Math.min(Math.round(durationMs), 3_600_000);
}

function boundedIso(value: string | undefined | null): string | null {
        if (!value) return null;
        const ms = Date.parse(value);
        if (!Number.isFinite(ms)) return null;
        return new Date(ms).toISOString();
}

/** Builds the sanitized history row for ONE playlist/API source attempt. */
export function livetvHistoryRowFromSourceOutcome(outcome: LivetvRefreshSourceOutcome, hints: { trigger: LivetvHistoryTrigger; correlationId: string; attemptNumber: number }): LivetvRefreshHistoryInsert | null {
        const subjectId = outcome.sourceId;
        // A row needs a real subject identity; unresolved lookups (unknown id)
        // have nothing honest to attribute and are not recorded.
        if (!subjectId || subjectId === 'unknown') return null;
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(subjectId)) return null;
        const counts = outcome.counts;
        const errorCount = counts?.failed ?? 0;
        const status = statusForOutcome({ ok: outcome.ok, failure: outcome.failure, errorCount });
        return {
                subject_kind: 'source',
                subject_id: subjectId,
                subject_slug: sanitizeLivetvDiagnosticText(outcome.slug, 120),
                operation: 'refresh',
                trigger_type: hints.trigger,
                correlation_id: hints.correlationId,
                attempt_count: Math.min(Math.max(1, Math.floor(hints.attemptNumber || 1)), 10),
                status,
                imported_count: clampCount((counts?.entriesInserted ?? 0) + (counts?.endpointsInserted ?? 0)),
                updated_count: clampCount((counts?.entriesUpdated ?? 0) + (counts?.endpointsUpdated ?? 0)),
                skipped_count: clampCount(counts?.skipped ?? 0),
                error_count: clampCount(errorCount),
                error_category: outcome.failure ? sanitizeLivetvDiagnosticText(outcome.failure.kind, 60) : null,
                error_message: outcome.failure ? sanitizeLivetvDiagnosticText(outcome.failure.message, 240) : null,
                duration_ms: boundedDurationMs(outcome.durationMs),
                started_at: boundedIso(outcome.startedAt) ?? new Date().toISOString(),
                finished_at: boundedIso(outcome.finishedAt)
        };
}

/** Builds the sanitized history row for ONE EPG guide-source attempt. */
export function livetvHistoryRowFromEpgOutcome(outcome: LivetvEpgRefreshOutcome, hints: { trigger: LivetvHistoryTrigger; correlationId: string; attemptNumber: number }): LivetvRefreshHistoryInsert | null {
        const subjectId = outcome.epgSourceId;
        if (!subjectId || subjectId === 'unknown') return null;
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(subjectId)) return null;
        const counts = outcome.counts;
        const errorCount = counts?.programmesFailed ?? 0;
        const status = statusForOutcome({ ok: outcome.ok, failure: outcome.failure, errorCount });
        return {
                subject_kind: 'epg_source',
                subject_id: subjectId,
                subject_slug: sanitizeLivetvDiagnosticText(outcome.slug, 120),
                operation: 'epg_refresh',
                trigger_type: hints.trigger,
                correlation_id: hints.correlationId,
                attempt_count: Math.min(Math.max(1, Math.floor(hints.attemptNumber || 1)), 10),
                status,
                imported_count: clampCount(counts?.programmesInserted ?? 0),
                updated_count: clampCount(counts?.programmesUpdated ?? 0),
                skipped_count: clampCount((counts?.programmesSkipped ?? 0) + (counts?.programmesSkippedInvalid ?? 0)),
                error_count: clampCount(errorCount),
                error_category: outcome.failure ? sanitizeLivetvDiagnosticText(outcome.failure.kind, 60) : null,
                error_message: outcome.failure ? sanitizeLivetvDiagnosticText(outcome.failure.message, 240) : null,
                duration_ms: boundedDurationMs(outcome.durationMs),
                started_at: boundedIso(outcome.startedAt) ?? new Date().toISOString(),
                finished_at: boundedIso(outcome.finishedAt)
        };
}

function clampCount(value: number): number {
        if (!Number.isFinite(value) || value < 0) return 0;
        return Math.min(Math.round(value), 1_000_000);
}

/**
 * Persists ONE history row. NEVER throws and NEVER fails a refresh: any
 * database problem resolves to `false` (the caller surfaces that through
 * the outcome's additive `historyPersisted` flag and moves on).
 */
export async function recordLivetvRefreshHistory(client: SupabaseClient<Database>, row: LivetvRefreshHistoryInsert | null): Promise<boolean> {
        if (!row) return false;
        try {
                const { error } = await client.from('livetv_refresh_history').insert(row);
                return !error;
        } catch {
                return false;
        }
}

// ---------------------------------------------------------------------------
// Bounded reads (admin diagnostics + scheduler planner)
// ---------------------------------------------------------------------------

export type LivetvRefreshHistoryRow = Database['public']['Tables']['livetv_refresh_history']['Row'];

/** Reads the newest history rows (bounded page, newest first). Never throws. */
export async function getLivetvRefreshHistoryPage(client: SupabaseClient<Database>, options: { limit?: number; subjectKind?: 'source' | 'epg_source'; subjectId?: string } = {}): Promise<LivetvRefreshHistoryRow[]> {
        const limit = Math.min(Math.max(1, Math.floor(options.limit ?? 100)), LIVETV_HISTORY_MAX_PAGE);
        try {
                let query = client
                        .from('livetv_refresh_history')
                        .select('id, subject_kind, subject_id, subject_slug, operation, trigger_type, correlation_id, attempt_count, status, imported_count, updated_count, skipped_count, error_count, error_category, error_message, duration_ms, started_at, finished_at, created_at')
                        .order('started_at', { ascending: false })
                        .limit(limit);
                if (options.subjectKind) query = query.eq('subject_kind', options.subjectKind);
                if (options.subjectId) query = query.eq('subject_id', options.subjectId);
                const { data, error } = await query;
                if (error) return [];
                return (data ?? []) as unknown as LivetvRefreshHistoryRow[];
        } catch {
                return [];
        }
}

export type LivetvSubjectHealthSummary = {
        subjectKind: 'source' | 'epg_source';
        subjectId: string;
        /** Latest slug snapshot (bounded; honest after source deletion). */
        slug: string;
        lastAttemptAt: string | null;
        lastSuccessAt: string | null;
        /** Trailing run of failure/timeout attempts (skips do not count). */
        consecutiveFailures: number;
        /** Sanitized taxonomy category of the most recent failure/timeout. */
        lastErrorCategory: string | null;
        lastStatus: HistoryStatus | null;
};

/**
 * Aggregates per-subject refresh health from the newest history page
 * (bounded: at most LIVETV_HISTORY_MAX_PAGE rows are read; grouping happens
 * in memory). Subjects are returned STALEST-FIRST (oldest last attempt
 * first) so the diagnostics surface leads with the neglected sources.
 */
export function summarizeLivetvSubjectHealth(rows: LivetvRefreshHistoryRow[]): LivetvSubjectHealthSummary[] {
        const bySubject = new Map<string, LivetvSubjectHealthSummary & { streakClosed: boolean }>();
        for (const row of rows) {
                // Rows arrive newest-first; the FIRST occurrence per subject is
                // the most recent attempt.
                const key = `${row.subject_kind}:${row.subject_id}`;
                let summary = bySubject.get(key);
                if (!summary) {
                        summary = {
                                subjectKind: row.subject_kind as 'source' | 'epg_source',
                                subjectId: row.subject_id,
                                slug: row.subject_slug,
                                lastAttemptAt: row.started_at,
                                lastSuccessAt: null,
                                consecutiveFailures: 0,
                                lastErrorCategory: null,
                                lastStatus: row.status as HistoryStatus,
                                streakClosed: false
                        };
                        bySubject.set(key, summary);
                }
                const successLike = row.status === 'success' || row.status === 'partial';
                if (!summary.lastSuccessAt && successLike) {
                        summary.lastSuccessAt = row.started_at;
                }
                // The CONSECUTIVE-failure streak counts only the failures since
                // the newest success (newest-first scan; a success closes the
                // streak). The category diagnostic is kept regardless — it
                // remains the most recent failure/timeout category on the page.
                if (row.status === 'failure' || row.status === 'timeout') {
                        if (!summary.streakClosed) summary.consecutiveFailures += 1;
                        if (!summary.lastErrorCategory && row.error_category) {
                                summary.lastErrorCategory = row.error_category;
                        }
                }
                if (successLike) summary.streakClosed = true;
        }
        const summaries = [...bySubject.values()].map(({ streakClosed, ...summary }) => summary);
        summaries.sort((a, b) => {
                const aMs = a.lastAttemptAt ? Date.parse(a.lastAttemptAt) : 0;
                const bMs = b.lastAttemptAt ? Date.parse(b.lastAttemptAt) : 0;
                if (aMs !== bMs) return aMs - bMs;
                return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
        });
        return summaries;
}

// ---------------------------------------------------------------------------
// Bounded retention sweep (epg/retention.ts conventions)
// ---------------------------------------------------------------------------

export type LivetvHistoryRetentionResult = {
        deleted: number;
        batches: number;
        cutoffMs: number;
        exhausted: boolean;
};

/**
 * Deletes history rows older than the cutoff (`now - retainMs`) in bounded
 * id-paged batches. Idempotent and convergent across repeated calls; a
 * failed sweep leaves data intact and is safe to re-run.
 */
export async function applyLivetvHistoryRetention(client: SupabaseClient<Database>, options: { now?: number; retainMs?: number; batchSize?: number; maxBatches?: number } = {}): Promise<LivetvHistoryRetentionResult> {
        const nowMs = options.now ?? Date.now();
        if (!Number.isFinite(nowMs)) throw new Error('Retention clock must be finite.');
        const retainMs = options.retainMs ?? LIVETV_HISTORY_RETENTION_MS;
        if (!Number.isFinite(retainMs) || retainMs < 60 * 60 * 1000 || retainMs > 90 * 24 * 60 * 60 * 1000) {
                throw new Error('Retention window must be between 1 hour and 90 days.');
        }
        const batchSize = options.batchSize ?? LIVETV_HISTORY_RETENTION_BATCH_SIZE;
        const maxBatches = options.maxBatches ?? LIVETV_HISTORY_RETENTION_MAX_BATCHES;
        const cutoffMs = nowMs - retainMs;
        const cutoffIso = new Date(cutoffMs).toISOString();

        let deleted = 0;
        let batches = 0;
        while (batches < maxBatches) {
                const { data, error } = await client
                        .from('livetv_refresh_history')
                        .select('id')
                        .lt('started_at', cutoffIso)
                        .order('started_at', { ascending: true })
                        .limit(batchSize);
                if (error) throw new Error(`History retention sweep failed: ${String(error.message).slice(0, 200)}`);
                const rows = (data ?? []) as { id: string }[];
                if (rows.length === 0) break;
                batches += 1;
                const ids = rows.map((row) => row.id);
                const { error: deleteError } = await client.from('livetv_refresh_history').delete().in('id', ids);
                if (deleteError) throw new Error(`History retention deletion failed: ${String(deleteError.message).slice(0, 200)}`);
                deleted += ids.length;
                if (rows.length < batchSize) break;
        }
        return { deleted, batches, cutoffMs, exhausted: batches >= maxBatches };
}
