// ============================================================================
// Unified Live TV — Phase 3 EPG retention (server-only, bounded, idempotent).
//
// POLICY (Phase 3 brief §9):
//   * ONE explicit rule: programme rows whose window has ENDED before the
//     cutoff (`now - retainPastMs`) are deleted in bounded batches. Rows
//     that are CURRENT (`start <= now < end`) or UPCOMING (`end >= now`)
//     are structurally unreachable by the sweep — the cutoff is strictly
//     in the past, so routine retention can never delete current or future
//     programmes.
//   * Bounded per run: a hard cap on batches and rows swept per call; the
//     sweep is idempotent and converges across repeated calls.
//   * Deletion is per-EPG-source (scoped) or global (no source filter) —
//     deleting one EPG source's stale rows must never touch another's data
//     beyond the same honest cutoff rule.
//   * The cutoff is validated (finite, sane bounds); a failed sweep leaves
//     data intact and is safe to re-run.
//   * No scheduler in Phase 3 — the sweep runs on demand (refresh path /
//     admin trigger); automated scheduling belongs to Phase 7.
// ============================================================================

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../../supabase/database.types';

/** Past programmes are retained this long after their end (honesty grace: "recently ended"). */
export const EPG_RETENTION_PAST_MS = 24 * 60 * 60 * 1000; // 24h

/** Rows deleted per batch and per sweep run (bounded work per call). */
export const EPG_RETENTION_BATCH_SIZE = 500;
export const EPG_RETENTION_MAX_BATCHES = 40; // ≤ 20 000 rows per sweep call; repeated calls converge

export type EpgRetentionResult = {
        /** Rows actually deleted by this call. */
        deleted: number;
        /** Batches consumed (diagnostics; 0 when nothing to do). */
        batches: number;
        /** The cutoff instant used (epoch ms; `now - retainPastMs`). */
        cutoffMs: number;
        /** True when the per-call batch budget was exhausted (re-run to continue). */
        exhausted: boolean;
};

/**
 * Sweeps expired programme rows. NEVER touches rows whose window ends at or
 * after the cutoff (current + upcoming are structurally unreachable). A row
 * id page is selected first, then deleted by explicit ids — no range scans
 * that could race with a concurrent import.
 */
export async function applyEpgRetention(client: SupabaseClient<Database>, options: { epgSourceId?: string; now?: number; retainPastMs?: number; batchSize?: number; maxBatches?: number } = {}): Promise<EpgRetentionResult> {
        const nowMs = options.now ?? Date.now();
        if (!Number.isFinite(nowMs)) throw new Error('Retention clock must be finite.');
        const retainPastMs = options.retainPastMs ?? EPG_RETENTION_PAST_MS;
        if (!Number.isFinite(retainPastMs) || retainPastMs < 0 || retainPastMs > 30 * 24 * 60 * 60 * 1000) {
                throw new Error('Retention window must be between 0 and 30 days.');
        }
        const batchSize = options.batchSize ?? EPG_RETENTION_BATCH_SIZE;
        const maxBatches = options.maxBatches ?? EPG_RETENTION_MAX_BATCHES;
        const cutoffMs = nowMs - retainPastMs;
        const cutoffIso = new Date(cutoffMs).toISOString();

        let deleted = 0;
        let batches = 0;
        let exhausted = false;

        while (batches < maxBatches) {
                let query = client
                        .from('livetv_epg_programmes')
                        .select('id')
                        .lt('end_at', cutoffIso)
                        .order('end_at', { ascending: true })
                        .limit(batchSize);
                if (options.epgSourceId) query = query.eq('epg_source_id', options.epgSourceId);
                const { data, error } = await query;
                if (error) throw new Error(`Retention sweep failed: ${String(error.message).slice(0, 200)}`);
                const rows = (data ?? []) as { id: string }[];
                if (rows.length === 0) break;
                batches += 1;

                const ids = rows.map((row) => row.id);
                let deleteQuery = client.from('livetv_epg_programmes').delete().in('id', ids);
                if (options.epgSourceId) deleteQuery = deleteQuery.eq('epg_source_id', options.epgSourceId);
                const { error: deleteError } = await deleteQuery;
                if (deleteError) throw new Error(`Retention deletion failed: ${String(deleteError.message).slice(0, 200)}`);
                deleted += ids.length;

                if (rows.length < batchSize) break;
        }
        exhausted = batches >= maxBatches;

        return { deleted, batches, cutoffMs, exhausted };
}
