// ============================================================================
// Unified Live TV — Phase 2 ingestion/persistence service (server-only).
//
// Idempotent persistence of normalized source channels into the Phase 1
// unified model:
//
//   adapter result → PURE ingestion plan → bounded batch executor
//
// IDEMPOTENCY + SAFETY CONTRACT (Phase 2 brief §8):
//   * Source entries are keyed by the DB's own uniqueness
//     (source_id, source_channel_id); endpoints by (source_channel_id, url).
//     Re-running a refresh converges — repeated runs insert nothing new.
//   * Provenance preserved verbatim: the source's own channel id, display
//     metadata, tvg-id and bounded metadata ride along; nothing is invented.
//   * Admin-owned fields are NEVER touched by a refresh:
//       - livetv_source_channels.canonical_channel_id (mapping) and .enabled
//       - livetv_playback_endpoints.enabled and .ordering
//       - nothing in livetv_channels (canonical rows are admin-managed here)
//   * Conservative mapping: ingestion NEVER creates or alters canonical
//     mappings. New entries are born UNMAPPED. Name similarity never merges
//     anything (Phase 1 D-3 posture).
//   * No candidate rows: playback-candidate materialization is NOT an
//     ingestion concern — source-level default ordering remains available
//     (Phase 1 model) whenever a channel has no explicit candidates.
//   * Deletion safety: NOTHING is ever deleted by a refresh. Entries an
//     upstream temporarily omits are left untouched; endpoints that
//     disappeared are REPORTED (report-only stale strategy) — a transient
//     network/parse failure can never destroy data or flip enablement gates
//     behind an admin's back. Source removal/disablement is the DB's cascade
//     semantics (Phase 1), untouched here.
//   * Bounded batches with per-item error isolation: one failing row never
//     aborts the source's refresh (supabase-js/PostgREST has no
//     multi-statement transactions — convergence comes from idempotent
//     upsert semantics, so a failed refresh is always safe to re-run).
// ============================================================================

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database, Json } from '../supabase/database.types';
import type { NormalizedLivetvChannel } from './adapters/types';

// ---------------------------------------------------------------------------
// Row shapes read by the planner (structural mirrors; kept minimal)
// ---------------------------------------------------------------------------

export type ExistingSourceChannelRow = {
        id: string;
        source_id: string;
        source_channel_id: string;
        canonical_channel_id: string | null;
        name: string;
        category: string | null;
        logo_url: string | null;
        tvg_id: string | null;
        enabled: boolean;
        /** Stored bounded provenance (planner compares it for idempotency). */
        metadata?: Record<string, unknown> | null;
};

export type ExistingEndpointRow = {
        id: string;
        source_channel_id: string;
        endpoint_kind: string;
        stream_format: string | null;
        url: string;
        ordering: number;
        enabled: boolean;
        label: string | null;
};

// ---------------------------------------------------------------------------
// The pure plan
// ---------------------------------------------------------------------------

export type LivetvEntryPlan =
        | {
                  action: 'insert';
                  sourceChannelId: string;
                  name: string;
                  category: string | null;
                  logoUrl: string | null;
                  tvgId: string | null;
                  metadata: Record<string, unknown>;
                  endpointCount: number;
          }
        | {
                  action: 'update';
                  /** Existing row id (never re-keyed). */
                  rowId: string;
                  sourceChannelId: string;
                  name: string;
                  category: string | null;
                  logoUrl: string | null;
                  tvgId: string | null;
                  metadata: Record<string, unknown>;
                  endpointCount: number;
                  /** Admin-owned values this plan deliberately preserves. */
                  preserved: { canonicalChannelId: string | null; enabled: boolean };
                  /** True when at least one writable field actually changes (idempotency evidence). */
                  changes: boolean;
          };

export type LivetvEndpointPlan =
        | {
                  action: 'insert';
                  /** The entry's source_channel_id (resolved to a row id by the executor). */
                  entrySourceChannelId: string;
                  endpointKind: 'direct_stream' | 'embed_page';
                  streamFormat: 'dash' | 'hls' | null;
                  url: string;
                  ordering: number;
                  label: string | null;
          }
        | {
                  action: 'update';
                  rowId: string;
                  entrySourceChannelId: string;
                  url: string;
                  endpointKind: 'direct_stream' | 'embed_page';
                  streamFormat: 'dash' | 'hls' | null;
                  label: string | null;
                  preserved: { enabled: boolean; ordering: number };
                  changes: boolean;
          };

export type LivetvIngestionPlan = {
        sourceId: string;
        entries: LivetvEntryPlan[];
        endpoints: LivetvEndpointPlan[];
        /** Endpoints of upstream-present entries that the payload no longer lists (report-only). */
        endpointsMissingUpstream: { sourceChannelId: string; url: string }[];
        /** Entries stored for this source that the payload omitted (counted, never touched). */
        entriesMissingUpstream: number;
        counts: {
                discovered: number;
                entriesInserted: number;
                entriesUpdated: number;
                entriesUnchanged: number;
                endpointsInserted: number;
                endpointsUpdated: number;
                endpointsUnchanged: number;
        };
};

/** Order-insensitive deep-equality for the bounded flat metadata objects. */
function metadataEquals(a: Record<string, unknown> | null | undefined, b: Record<string, unknown>): boolean {
        const left = a ?? {};
        const leftKeys = Object.keys(left);
        const rightKeys = Object.keys(b);
        if (leftKeys.length !== rightKeys.length) return false;
        for (const key of rightKeys) {
                if (!(key in left)) return false;
                if (JSON.stringify(left[key]) !== JSON.stringify(b[key])) return false;
        }
        return true;
}

/**
 * Builds the idempotent, admin-preserving write plan for one source refresh.
 * PURE — no I/O, fully unit-testable. `existing` reflects the CURRENT rows
 * for this source (entries + their endpoints).
 */
export function planSourceIngestion(input: {
        sourceId: string;
        adapterChannels: readonly NormalizedLivetvChannel[];
        existingEntries: readonly ExistingSourceChannelRow[];
        existingEndpoints: readonly ExistingEndpointRow[];
}): LivetvIngestionPlan {
        const entriesBySourceChannelId = new Map<string, ExistingSourceChannelRow>();
        for (const entry of input.existingEntries) entriesBySourceChannelId.set(entry.source_channel_id, entry);

        const endpointsByEntryRowId = new Map<string, Map<string, ExistingEndpointRow>>();
        for (const endpoint of input.existingEndpoints) {
                let bucket = endpointsByEntryRowId.get(endpoint.source_channel_id);
                if (!bucket) {
                        bucket = new Map<string, ExistingEndpointRow>();
                        endpointsByEntryRowId.set(endpoint.source_channel_id, bucket);
                }
                bucket.set(endpoint.url, endpoint);
        }

        const entries: LivetvEntryPlan[] = [];
        const endpoints: LivetvEndpointPlan[] = [];
        const endpointsMissingUpstream: { sourceChannelId: string; url: string }[] = [];
        const seenEntryRowIds = new Set<string>();
        let entriesInserted = 0;
        let entriesUpdated = 0;
        let entriesUnchanged = 0;
        let endpointsInserted = 0;
        let endpointsUpdated = 0;
        let endpointsUnchanged = 0;

        for (const channel of input.adapterChannels) {
                const existing = entriesBySourceChannelId.get(channel.sourceChannelId);
                if (!existing) {
                        entries.push({
                                action: 'insert',
                                sourceChannelId: channel.sourceChannelId,
                                name: channel.name,
                                category: channel.category,
                                logoUrl: channel.logoUrl,
                                tvgId: channel.tvgId,
                                metadata: channel.metadata,
                                endpointCount: channel.endpoints.length
                        });
                        entriesInserted += 1;
                        for (const endpoint of channel.endpoints) {
                                endpoints.push({
                                        action: 'insert',
                                        entrySourceChannelId: channel.sourceChannelId,
                                        endpointKind: endpoint.endpointKind,
                                        streamFormat: endpoint.streamFormat,
                                        url: endpoint.url,
                                        ordering: endpoint.ordering,
                                        label: endpoint.label
                                });
                                endpointsInserted += 1;
                        }
                        continue;
                }

                seenEntryRowIds.add(existing.id);
                const changes =
                        existing.name !== channel.name ||
                        existing.category !== channel.category ||
                        existing.logo_url !== channel.logoUrl ||
                        existing.tvg_id !== channel.tvgId ||
                        !metadataEquals(existing.metadata, channel.metadata);
                entries.push({
                        action: 'update',
                        rowId: existing.id,
                        sourceChannelId: channel.sourceChannelId,
                        name: channel.name,
                        category: channel.category,
                        logoUrl: channel.logoUrl,
                        tvgId: channel.tvgId,
                        metadata: channel.metadata,
                        endpointCount: channel.endpoints.length,
                        preserved: { canonicalChannelId: existing.canonical_channel_id, enabled: existing.enabled },
                        changes
                });
                if (changes) entriesUpdated += 1;
                else entriesUnchanged += 1;

                // Endpoints of this entry — dedup by URL; classification/label
                // updated only when the adapter's (validated) values differ.
                const bucket = endpointsByEntryRowId.get(existing.id) ?? new Map<string, ExistingEndpointRow>();
                const seenUrls = new Set<string>();
                for (const endpoint of channel.endpoints) {
                        seenUrls.add(endpoint.url);
                        const existingEndpoint = bucket.get(endpoint.url);
                        if (!existingEndpoint) {
                                endpoints.push({
                                        action: 'insert',
                                        entrySourceChannelId: channel.sourceChannelId,
                                        endpointKind: endpoint.endpointKind,
                                        streamFormat: endpoint.streamFormat,
                                        url: endpoint.url,
                                        // Ordering is admin-owned after first insert; the
                                        // adapter's ordering only seeds NEW rows.
                                        ordering: endpoint.ordering,
                                        label: endpoint.label
                                });
                                endpointsInserted += 1;
                                continue;
                        }
                        const classificationChanged =
                                existingEndpoint.endpoint_kind !== endpoint.endpointKind ||
                                (existingEndpoint.stream_format ?? null) !== endpoint.streamFormat ||
                                (existingEndpoint.label ?? null) !== endpoint.label;
                        endpoints.push({
                                action: 'update',
                                rowId: existingEndpoint.id,
                                entrySourceChannelId: channel.sourceChannelId,
                                url: endpoint.url,
                                endpointKind: endpoint.endpointKind,
                                streamFormat: endpoint.streamFormat,
                                label: endpoint.label,
                                preserved: { enabled: existingEndpoint.enabled, ordering: existingEndpoint.ordering },
                                changes: classificationChanged
                        });
                        if (classificationChanged) endpointsUpdated += 1;
                        else endpointsUnchanged += 1;
                }
                // Report-only stale strategy: endpoints this upstream no longer
                // lists. Never mutated, never deleted.
                for (const [url] of bucket) {
                        if (!seenUrls.has(url)) endpointsMissingUpstream.push({ sourceChannelId: channel.sourceChannelId, url });
                }
        }

        // Entries the upstream omitted — counted, never touched.
        let entriesMissingUpstream = 0;
        for (const entry of input.existingEntries) {
                if (!seenEntryRowIds.has(entry.id)) entriesMissingUpstream += 1;
        }

        return {
                sourceId: input.sourceId,
                entries,
                endpoints,
                endpointsMissingUpstream,
                entriesMissingUpstream,
                counts: {
                        discovered: input.adapterChannels.length,
                        entriesInserted,
                        entriesUpdated,
                        entriesUnchanged,
                        endpointsInserted,
                        endpointsUpdated,
                        endpointsUnchanged
                }
        };
}

// ---------------------------------------------------------------------------
// The bounded batch executor
// ---------------------------------------------------------------------------

export type LivetvExecutionError = {
        scope: 'entry_insert' | 'entry_update' | 'endpoint_insert' | 'endpoint_update';
        sourceChannelId: string | null;
        url: string | null;
        message: string;
};

export type LivetvExecutionResult = {
        appliedEntryWrites: number;
        appliedEndpointWrites: number;
        errors: LivetvExecutionError[];
        /** Bounded batch size actually used (diagnostics). */
        batchSize: number;
};

export const LIVETV_INGESTION_BATCH_SIZE = 100;

function extractMessage(error: unknown): string {
        const message = (error as { message?: string })?.message;
        return typeof message === 'string' && message ? message.slice(0, 200) : 'database error';
}

/**
 * Applies the plan through a Supabase client with per-item error isolation.
 * Deterministic order (entries first, then endpoints — the endpoint FK needs
 * its entry row). Entry inserts return their row ids so endpoint inserts
 * resolve the FK without extra round-trips. A failing row is recorded and
 * skipped — never fatal for the remaining rows.
 */
export async function applySourceIngestion(client: SupabaseClient<Database>, plan: LivetvIngestionPlan, options: { batchSize?: number } = {}): Promise<LivetvExecutionResult> {
        const batchSize = options.batchSize ?? LIVETV_INGESTION_BATCH_SIZE;
        const errors: LivetvExecutionError[] = [];
        let appliedEntryWrites = 0;
        let appliedEndpointWrites = 0;

        /** source_channel_id → entry row id (existing + freshly inserted). */
        const entryRowIds = new Map<string, string>();
        for (const entry of plan.entries) {
                if (entry.action === 'update') entryRowIds.set(entry.sourceChannelId, entry.rowId);
        }

        // --- entry writes (bounded batches, deterministic order) ---
        for (let start = 0; start < plan.entries.length; start += batchSize) {
                const batch = plan.entries.slice(start, start + batchSize);
                for (const entryPlan of batch) {
                        if (entryPlan.action === 'insert') {
                                const { data, error } = await client
                                        .from('livetv_source_channels')
                                        .insert({
                                                source_id: plan.sourceId,
                                                source_channel_id: entryPlan.sourceChannelId,
                                                name: entryPlan.name,
                                                category: entryPlan.category,
                                                logo_url: entryPlan.logoUrl,
                                                tvg_id: entryPlan.tvgId,
                                                metadata: entryPlan.metadata as Json
                                                // canonical_channel_id stays NULL — conservative mapping.
                                        })
                                        .select('id')
                                        .single();
                                if (error || !data) {
                                        errors.push({ scope: 'entry_insert', sourceChannelId: entryPlan.sourceChannelId, url: null, message: error ? extractMessage(error) : 'insert returned no row' });
                                        continue;
                                }
                                entryRowIds.set(entryPlan.sourceChannelId, data.id);
                                appliedEntryWrites += 1;
                        } else if (entryPlan.action === 'update' && entryPlan.changes) {
                                const { error } = await client
                                        .from('livetv_source_channels')
                                        .update({
                                                name: entryPlan.name,
                                                category: entryPlan.category,
                                                logo_url: entryPlan.logoUrl,
                                                tvg_id: entryPlan.tvgId,
                                                metadata: entryPlan.metadata as Json
                                                // canonical_channel_id + enabled NEVER written.
                                        })
                                        .eq('id', entryPlan.rowId);
                                if (error) {
                                        errors.push({ scope: 'entry_update', sourceChannelId: entryPlan.sourceChannelId, url: null, message: extractMessage(error) });
                                        continue;
                                }
                                appliedEntryWrites += 1;
                        }
                }
        }

        // --- endpoint writes (bounded batches, deterministic order) ---
        for (let start = 0; start < plan.endpoints.length; start += batchSize) {
                const batch = plan.endpoints.slice(start, start + batchSize);
                for (const endpointPlan of batch) {
                        if (endpointPlan.action === 'insert') {
                                const entryRowId = entryRowIds.get(endpointPlan.entrySourceChannelId);
                                if (!entryRowId) {
                                        errors.push({ scope: 'endpoint_insert', sourceChannelId: endpointPlan.entrySourceChannelId, url: endpointPlan.url, message: 'entry row unavailable (entry insert failed)' });
                                        continue;
                                }
                                const { error } = await client.from('livetv_playback_endpoints').insert({
                                        source_channel_id: entryRowId,
                                        endpoint_kind: endpointPlan.endpointKind,
                                        stream_format: endpointPlan.streamFormat,
                                        url: endpointPlan.url,
                                        ordering: endpointPlan.ordering,
                                        label: endpointPlan.label
                                });
                                if (error) {
                                        errors.push({ scope: 'endpoint_insert', sourceChannelId: endpointPlan.entrySourceChannelId, url: endpointPlan.url, message: extractMessage(error) });
                                        continue;
                                }
                                appliedEndpointWrites += 1;
                        } else if (endpointPlan.action === 'update' && endpointPlan.changes) {
                                const { error } = await client
                                        .from('livetv_playback_endpoints')
                                        .update({
                                                endpoint_kind: endpointPlan.endpointKind,
                                                stream_format: endpointPlan.streamFormat,
                                                label: endpointPlan.label
                                                // enabled + ordering NEVER written.
                                        })
                                        .eq('id', endpointPlan.rowId);
                                if (error) {
                                        errors.push({ scope: 'endpoint_update', sourceChannelId: endpointPlan.entrySourceChannelId, url: endpointPlan.url, message: extractMessage(error) });
                                        continue;
                                }
                                appliedEndpointWrites += 1;
                        }
                }
        }

        return { appliedEntryWrites, appliedEndpointWrites, errors, batchSize };
}
