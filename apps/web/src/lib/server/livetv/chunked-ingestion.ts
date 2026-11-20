import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '$lib/server/supabase/database.types';
import { parseM3UPlaylist } from './adapters/m3u';
import type { NormalizedLivetvChannel } from './adapters/types';
import {
        planSourceIngestion,
        applySourceIngestion,
        type ExistingSourceChannelRow,
        type ExistingEndpointRow
} from './ingestion';

/**
 * Chunked Live TV ingestion — the fix for large playlists (e.g. akindi, ~648
 * channels) that exceed the Netlify fetch timeout when ingested in one shot.
 * The BROWSER downloads the playlist (no serverless timeout), splits it into
 * ~50-channel chunks, and POSTs each chunk here.
 *
 * NON-PRUNING: `planSourceIngestion` is report-only for omitted entries and
 * `applySourceIngestion` only inserts/updates — never deletes.
 *
 * RESILIENT + SCOPED + BULLETPROOF:
 *  - Existing state is read ONLY for the chunk's own channels (not the whole
 *    endpoints table). Reading the full table every chunk got heavier as the
 *    table grew — that is what made later chunks (e.g. #18) time out.
 *  - A whole-chunk parse failure falls back to per-entry parsing and SKIPS bad
 *    entries; a DB error on one row is collected and the rest still save; and
 *    the entire ingest is wrapped so it returns a result instead of throwing
 *    (so one bad chunk never aborts the browser's save loop).
 *  - 2026-10 round 12: if the NORMAL flow (loadExisting → plan → apply)
 *    fails entirely (e.g. DB timeout on the .in() query), the chunk is
 *    RETRIED with an insert-only plan (empty existing). Per-row error
 *    isolation in applySourceIngestion catches duplicate-key conflicts so
 *    no channels are lost. Only if the fallback ALSO fails is the chunk
 *    abandoned (reported as errors but never thrown).
 */

const MAX_CHUNK_ENTRIES = 5_000;

export type LivetvChunkIngestResult = {
        parsed: number;
        entryWrites: number;
        endpointWrites: number;
        errors: number;
};

function splitEntries(text: string): string[] {
        const lines = text.split(/\r?\n/);
        const entries: string[] = [];
        let current: string[] = [];
        for (const line of lines) {
                if (line.startsWith('#EXTINF')) {
                        if (current.length) entries.push(current.join('\n'));
                        current = [line];
                } else if (current.length) {
                        current.push(line);
                }
        }
        if (current.length) entries.push(current.join('\n'));
        return entries;
}

function parseChunkResilient(text: string): NormalizedLivetvChannel[] {
        try {
                return parseM3UPlaylist(text, { maxEntries: MAX_CHUNK_ENTRIES }).channels;
        } catch {
                const channels: NormalizedLivetvChannel[] = [];
                for (const block of splitEntries(text)) {
                        try {
                                const parsed = parseM3UPlaylist(`#EXTM3U\n${block}`, { maxEntries: 4 });
                                for (const channel of parsed.channels) channels.push(channel);
                        } catch {
                                // skip this bad entry, keep going
                        }
                }
                return channels;
        }
}

/** Existing rows for ONLY the given channels (bounded to the chunk). */
async function loadExistingForChannels(
        client: SupabaseClient<Database>,
        sourceId: string,
        sourceChannelIds: string[]
): Promise<{ entries: ExistingSourceChannelRow[]; endpoints: ExistingEndpointRow[] }> {
        if (sourceChannelIds.length === 0) return { entries: [], endpoints: [] };

        const entriesResult = await client
                .from('livetv_source_channels')
                .select('id, source_id, source_channel_id, canonical_channel_id, name, category, logo_url, tvg_id, enabled, metadata')
                .eq('source_id', sourceId)
                .in('source_channel_id', sourceChannelIds);
        if (entriesResult.error) throw new Error(entriesResult.error.message);
        const entries = (entriesResult.data ?? []) as unknown as ExistingSourceChannelRow[];

        const entryRowIds = entries.map((entry) => entry.id);
        let endpoints: ExistingEndpointRow[] = [];
        if (entryRowIds.length > 0) {
                const endpointsResult = await client
                        .from('livetv_playback_endpoints')
                        .select('id, source_channel_id, endpoint_kind, stream_format, url, ordering, enabled, label')
                        .in('source_channel_id', entryRowIds);
                if (endpointsResult.error) throw new Error(endpointsResult.error.message);
                endpoints = (endpointsResult.data ?? []) as unknown as ExistingEndpointRow[];
        }

        return { entries, endpoints };
}

export async function ingestLivetvChunk(
        client: SupabaseClient<Database>,
        params: { sourceId: string; text: string }
): Promise<LivetvChunkIngestResult> {
        const channels = parseChunkResilient(params.text);
        if (channels.length === 0) {
                // 2026-10 round 10 — Task 1: log when a chunk yields ZERO
                // channels so the admin can see why channels are missing.
                console.warn('[livetv ingest-chunk] chunk yielded 0 channels (parse returned empty)');
                return { parsed: 0, entryWrites: 0, endpointWrites: 0, errors: 0 };
        }

        // --- Normal flow: load existing → plan → apply (with per-row isolation) ---
        try {
                const { entries, endpoints } = await loadExistingForChannels(
                        client,
                        params.sourceId,
                        channels.map((channel) => channel.sourceChannelId)
                );
                const plan = planSourceIngestion({
                        sourceId: params.sourceId,
                        adapterChannels: channels,
                        existingEntries: entries,
                        existingEndpoints: endpoints
                });
                const result = await applySourceIngestion(client, plan);
                // 2026-10 round 10 — Task 1: log per-entry errors so the admin
                // can see exactly WHY a channel was skipped (DB constraint,
                // string too long, etc.).
                if (result.errors.length > 0) {
                        console.error(`[livetv ingest-chunk] ${result.errors.length} entry errors:`, result.errors.slice(0, 5));
                }
                return {
                        parsed: channels.length,
                        entryWrites: result.appliedEntryWrites,
                        endpointWrites: result.appliedEndpointWrites,
                        errors: result.errors.length
                };
        } catch (error) {
                // 2026-10 round 12 — BULLETPROOF FALLBACK: if the normal flow
                // fails (e.g. loadExistingForChannels timed out on a large
                // .in() query, or the DB was momentarily unavailable), retry
                // with an INSERT-ONLY plan (empty existing entries/endpoints).
                // This means: treat every channel as NEW and let the DB's
                // uniqueness constraint catch true duplicates (per-row error
                // isolation in applySourceIngestion skips the duplicate and
                // continues with the rest). This prevents a single DB hiccup
                // from losing an ENTIRE chunk of channels.
                const reason = error instanceof Error ? error.message : String(error);
                console.warn(`[livetv ingest-chunk] normal flow failed (${reason}); retrying with insert-only fallback for ${channels.length} channels`);

                try {
                        const fallbackPlan = planSourceIngestion({
                                sourceId: params.sourceId,
                                adapterChannels: channels,
                                existingEntries: [],
                                existingEndpoints: []
                        });
                        const fallbackResult = await applySourceIngestion(client, fallbackPlan);
                        if (fallbackResult.errors.length > 0) {
                                console.error(`[livetv ingest-chunk] fallback: ${fallbackResult.errors.length} entry errors:`, fallbackResult.errors.slice(0, 5));
                        }
                        console.log(`[livetv ingest-chunk] fallback complete: ${fallbackResult.appliedEntryWrites} entries, ${fallbackResult.appliedEndpointWrites} endpoints written`);
                        return {
                                parsed: channels.length,
                                entryWrites: fallbackResult.appliedEntryWrites,
                                endpointWrites: fallbackResult.appliedEndpointWrites,
                                errors: fallbackResult.errors.length
                        };
                } catch (fallbackError) {
                        // Both the normal flow AND the fallback failed — this is
                        // a catastrophic DB failure. Report the chunk as failed
                        // but never throw (the browser's save loop must continue
                        // with the next chunk).
                        const fallbackReason = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
                        console.error(`[livetv ingest-chunk] fallback ALSO failed (${fallbackReason}); chunk abandoned`);
                        return { parsed: channels.length, entryWrites: 0, endpointWrites: 0, errors: channels.length };
                }
        }
}
