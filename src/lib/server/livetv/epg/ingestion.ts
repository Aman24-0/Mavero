// ============================================================================
// Unified Live TV — Phase 3 EPG ingestion/persistence (server-only).
//
//   parsed+validated guide programmes → PURE ingestion plan → bounded batch
//   upserts (keyed by the DB's own uniqueness)
//
// IDEMPOTENCY + SAFETY CONTRACT (Phase 3 brief §8):
//   * Identity: (epg_source_id, epg_channel_id, start_at, end_at) — the DB
//     unique constraint is THE idempotency mechanism. A repeat import of
//     unchanged input plans ZERO writes (every record lands "unchanged")
//     and the executor therefore performs zero writes.
//   * Parsing, mapping/planning and persistence are SEPARATE stages: the
//     plan is pure and fully validated before the first write. A document-
//     level parser failure (global cap, malformed structure, decompression
//     abuse) throws BEFORE any persistence — no partial snapshot is ever
//     written for a globally invalid document.
//   * NOTHING is deleted by a refresh. The last good guide is never erased
//     before (or by) a replacement: a failed/cancelled refresh leaves every
//     existing row untouched, and guide data the upstream stops publishing
//     is only ever REPORTED (`programmesMissingUpstream`) until the bounded
//     retention sweep ages it out. A transient failure can therefore never
//     destroy the guide.
//   * Atomicity honesty (brief §8): supabase-js/PostgREST has NO multi-
//     statement transaction. This design does not need one for safety —
//     inserts and updates are convergent upserts, so any interrupted run is
//     safe to re-run and converges. There is NO atomic snapshot switch and
//     none is claimed: readers never see an empty guide mid-refresh (rows
//     are only added/updated in place), which is the strongest guarantee
//     available under this API and is documented as such.
//   * Programme rows carry NO admin-owned fields (unlike playback
//     endpoints): the row is fully source-derived data, so an upsert never
//     clobbers admin state. Explicit channel MAPPINGS are a different table
//     and are NEVER written by ingestion.
//   * Bounded batches (500 rows) with per-item error isolation on batch
//     failure — one bad row never aborts the import.
// ============================================================================

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../../supabase/database.types';
import type { XmltvProgramme } from './xmltv';

// ---------------------------------------------------------------------------
// Row shapes read by the planner (structural mirrors; kept minimal)
// ---------------------------------------------------------------------------

export type ExistingEpgProgrammeRow = {
        id: string;
        epg_source_id: string;
        epg_channel_id: string;
        /** Absolute UTC instants (epoch ms) — converted from the timestamptz read. */
        startMs: number;
        endMs: number;
        title: string;
        sub_title: string | null;
        description: string | null;
        category: string | null;
        icon_url: string | null;
        language: string | null;
};

// ---------------------------------------------------------------------------
// The pure plan
// ---------------------------------------------------------------------------

export type PlannedEpgProgrammeWrite = {
        epg_source_id: string;
        epg_channel_id: string;
        /** ISO-8601 UTC strings (timestamptz wire format). */
        start_at: string;
        end_at: string;
        title: string;
        sub_title: string | null;
        description: string | null;
        category: string | null;
        icon_url: string | null;
        language: string | null;
};

export type EpgGuideIngestionPlan = {
        epgSourceId: string;
        /** Upserts to apply (inserts + changed rows; unchanged rows are NEVER included). */
        upserts: PlannedEpgProgrammeWrite[];
        /** How many of the upserts are brand-new rows (vs field changes). */
        inserts: number;
        updates: number;
        /** Records identical to stored state — zero writes. */
        unchanged: number;
        /** Records the planner rejected defensively (parser already gates these). */
        skipped: number;
        /**
         * Existing rows inside the imported window whose key the payload no
         * longer lists — REPORT-ONLY (counted, never deleted, never disabled).
         */
        programmesMissingUpstream: number;
        /** The imported window (diagnostics; bounds the existing-state read). */
        window: { startMs: number; endMs: number } | null;
        counts: {
                discovered: number;
                inserted: number;
                updated: number;
                unchanged: number;
                skipped: number;
        };
};

function programmeKey(channelId: string, startMs: number, endMs: number): string {
        return `${channelId}\u0000${startMs}\u0000${endMs}`;
}

function rowFromProgramme(epgSourceId: string, programme: XmltvProgramme): PlannedEpgProgrammeWrite {
        return {
                epg_source_id: epgSourceId,
                epg_channel_id: programme.channelId,
                start_at: new Date(programme.startMs).toISOString(),
                end_at: new Date(programme.endMs).toISOString(),
                title: programme.title,
                sub_title: programme.subTitle,
                description: programme.description,
                category: programme.category,
                icon_url: programme.iconUrl,
                language: programme.language
        };
}

/**
 * Builds the idempotent write plan for one guide import. PURE — no I/O,
 * fully unit-testable. `existing` reflects the CURRENT programme rows for
 * this EPG source inside the import window (loaded by the caller).
 */
export function planGuideIngestion(input: {
        epgSourceId: string;
        programmes: readonly XmltvProgramme[];
        existingRows: readonly ExistingEpgProgrammeRow[];
}): EpgGuideIngestionPlan {
        const existingByKey = new Map<string, ExistingEpgProgrammeRow>();
        for (const row of input.existingRows) {
                existingByKey.set(programmeKey(row.epg_channel_id, row.startMs, row.endMs), row);
        }

        const upserts: PlannedEpgProgrammeWrite[] = [];
        let inserts = 0;
        let updates = 0;
        let unchanged = 0;
        let skipped = 0;
        let minStart = Number.POSITIVE_INFINITY;
        let maxEnd = Number.NEGATIVE_INFINITY;
        const payloadKeys = new Set<string>();

        for (const programme of input.programmes) {
                // Defensive re-validation (the parser guarantees these; a violation
                // here is skipped and counted rather than written).
                if (
                        !programme.channelId ||
                        !programme.title ||
                        !Number.isFinite(programme.startMs) ||
                        !Number.isFinite(programme.endMs) ||
                        programme.startMs >= programme.endMs
                ) {
                        skipped += 1;
                        continue;
                }
                minStart = Math.min(minStart, programme.startMs);
                maxEnd = Math.max(maxEnd, programme.endMs);

                const key = programmeKey(programme.channelId, programme.startMs, programme.endMs);
                payloadKeys.add(key);
                const existing = existingByKey.get(key);
                if (!existing) {
                        upserts.push(rowFromProgramme(input.epgSourceId, programme));
                        inserts += 1;
                        continue;
                }
                const changed =
                        existing.title !== programme.title ||
                        existing.sub_title !== programme.subTitle ||
                        existing.description !== programme.description ||
                        existing.category !== programme.category ||
                        existing.icon_url !== programme.iconUrl ||
                        existing.language !== programme.language;
                if (changed) {
                        upserts.push(rowFromProgramme(input.epgSourceId, programme));
                        updates += 1;
                } else {
                        unchanged += 1;
                }
        }

        // Report-only stale diagnostics: rows the payload no longer lists.
        let programmesMissingUpstream = 0;
        for (const row of input.existingRows) {
                if (!payloadKeys.has(programmeKey(row.epg_channel_id, row.startMs, row.endMs))) programmesMissingUpstream += 1;
        }

        return {
                epgSourceId: input.epgSourceId,
                upserts,
                inserts,
                updates,
                unchanged,
                skipped,
                programmesMissingUpstream,
                window: Number.isFinite(minStart) && Number.isFinite(maxEnd) ? { startMs: minStart, endMs: maxEnd } : null,
                counts: {
                        discovered: input.programmes.length,
                        inserted: inserts,
                        updated: updates,
                        unchanged,
                        skipped
                }
        };
}

// ---------------------------------------------------------------------------
// The bounded batch executor
// ---------------------------------------------------------------------------

export type EpgExecutionError = {
        scope: 'programme_upsert';
        epgChannelId: string | null;
        message: string;
};

export type EpgExecutionResult = {
        appliedWrites: number;
        errors: EpgExecutionError[];
        /** Batch size actually used (diagnostics). */
        batchSize: number;
};

export const EPG_INGESTION_BATCH_SIZE = 500;

function extractMessage(error: unknown): string {
        const message = (error as { message?: string })?.message;
        return typeof message === 'string' && message ? message.slice(0, 200) : 'database error';
}

/**
 * Applies the plan through a Supabase client: bounded batch upserts keyed by
 * the DB uniqueness, with per-item retry isolation when a batch fails. A
 * failed row is recorded and skipped — never fatal for the remaining rows.
 * Re-running converges (unchanged rows are never in the plan).
 *
 * Phase 7: an optional `signal` (the refresh deadline/cancellation) is
 * checked between BATCHES — once the caller has abandoned the run, no
 * further database mutations are started by this executor. Writes already
 * applied are complete, idempotent upserts; a re-run converges.
 */
export async function applyGuideIngestion(client: SupabaseClient<Database>, plan: EpgGuideIngestionPlan, options: { batchSize?: number; signal?: AbortSignal } = {}): Promise<EpgExecutionResult> {
        const batchSize = options.batchSize ?? EPG_INGESTION_BATCH_SIZE;
        const errors: EpgExecutionError[] = [];
        let appliedWrites = 0;

        for (let start = 0; start < plan.upserts.length; start += batchSize) {
                if (options.signal?.aborted) {
                        errors.push({ scope: 'programme_upsert', epgChannelId: '', message: 'guide ingestion cancelled before a batch (caller deadline elapsed)' });
                        return { appliedWrites, errors, batchSize };
                }
                const batch = plan.upserts.slice(start, start + batchSize);
                const { error } = await client
                        .from('livetv_epg_programmes')
                        .upsert(batch as unknown as never, { onConflict: 'epg_source_id,epg_channel_id,start_at,end_at' });
                if (!error) {
                        appliedWrites += batch.length;
                        continue;
                }
                // Batch failed — fall back to per-item writes to isolate the
                // offending row(s) without losing the rest of the batch.
                for (const row of batch) {
                        const { error: itemError } = await client
                                .from('livetv_epg_programmes')
                                .upsert([row] as unknown as never, { onConflict: 'epg_source_id,epg_channel_id,start_at,end_at' });
                        if (itemError) {
                                errors.push({ scope: 'programme_upsert', epgChannelId: row.epg_channel_id, message: extractMessage(itemError) });
                                continue;
                        }
                        appliedWrites += 1;
                }
                if (errors.length >= 200) break; // bounded error sample; the run stays safe to re-run
        }

        return { appliedWrites, errors, batchSize };
}
