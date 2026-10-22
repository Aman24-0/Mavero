// ============================================================================
// Unified Live TV — Phase 3 server-side guide query helpers (server-only).
//
// Source-agnostic current/upcoming programme lookups over the persisted
// guide data. These helpers are NOT wired into the user-facing /live-tv page
// (the existing LiveGT client EPG contract is untouched — Phase 3 brief
// §10); they are the Phase 5/6 integration surface.
//
// RESOLUTION (deterministic, honest):
//   1. EXPLICIT admin mappings (`livetv_epg_channel_mappings`) first.
//   2. tvgId auto-match second: the canonical channel's mapped source
//      entries contribute their `tvg_id` values; a tvg_id participates ONLY
//      when no OTHER canonical channel's entries claim the same identity
//      (ambiguity guard — an ambiguous identity serves nothing rather than
//      guessing). Ids are matched verbatim (stored values are already
//      trimmed/validated; exotic spellings need explicit mappings).
//   3. Multiple targets resolve in a documented order (explicit before
//      tvgid, then stable id ordering); the first target yielding data
//      wins — guide provenance is returned with every row.
//
// SEMANTICS (brief §10):
//   * current  : start <= now < end — the most specific window wins
//                (latest start_at), ties broken deterministically
//                (earliest end_at, then title) so overlapping programmes
//                can never produce nondeterministic results.
//   * upcoming : start > now, stable UTC ordering (start, end, title),
//                bounded limit, optional horizon.
//   * Gaps return empty results — no programme is ever fabricated, and a
//   * channel with no usable guide renders the honest empty state.
//   * `now` is an EXPLICIT argument (deterministic tests; no live clock
//   * inside the helpers).
// ============================================================================

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../../supabase/database.types';
import { LIVETV_PLAYBACK_ELIGIBLE_STATUSES, type LivetvSourceStatus } from '../registry';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type EpgProgrammeView = {
        /** Canonical channel the guide data was resolved for. */
        channelId: string;
        /** Guide provenance (which EPG source + guide identity supplied the row). */
        epgSourceId: string;
        epgChannelId: string;
        /** How the guide identity was tied to the channel. */
        mappingSource: 'explicit' | 'tvgid';
        /** Absolute UTC window (epoch ms). */
        startMs: number;
        endMs: number;
        title: string;
        subTitle: string | null;
        description: string | null;
        category: string | null;
        /** Genuine programme artwork — only when the guide supplied it. */
        iconUrl: string | null;
        /** Source language when reliably present. */
        language: string | null;
};

export type EpgTarget = {
        epgSourceId: string;
        epgChannelIds: string[];
        mappingSource: 'explicit' | 'tvgid';
};

// ---------------------------------------------------------------------------
// Target resolution
// ---------------------------------------------------------------------------

type MappingRow = { epg_source_id: string; epg_channel_id: string };
type SourceChannelRow = { tvg_id: string | null; canonical_channel_id: string | null };
type EpgSourceRow = { id: string; enabled: boolean; status: string };

function statusEligible(status: string): boolean {
        return LIVETV_PLAYBACK_ELIGIBLE_STATUSES.has(status as LivetvSourceStatus);
}

/**
 * Resolves the guide targets for one canonical channel. Bounded queries;
 * ambiguity is resolved by EXCLUSION (an identity claimed by more than one
 * canonical channel never serves guide data).
 */
export async function resolveEpgTargets(client: SupabaseClient<Database>, channelId: string): Promise<EpgTarget[]> {
        if (!channelId) return [];

        // 1. Explicit mappings for this channel.
        const mappingsResult = await client.from('livetv_epg_channel_mappings').select('epg_source_id, epg_channel_id').eq('channel_id', channelId);
        const mappingRows = ((mappingsResult.data ?? []) as unknown as MappingRow[]).filter((row) => row.epg_source_id && row.epg_channel_id);

        // Eligible EPG sources only.
        const sourceIds = [...new Set(mappingRows.map((row) => row.epg_source_id))];
        let eligibleSourceIds = new Set<string>();
        if (sourceIds.length > 0) {
                const sourcesResult = await client.from('livetv_epg_sources').select('id, enabled, status').in('id', sourceIds);
                const sourceRows = (sourcesResult.data ?? []) as unknown as EpgSourceRow[];
                eligibleSourceIds = new Set(sourceRows.filter((row) => row.enabled && statusEligible(row.status)).map((row) => row.id));
        }
        const explicitBySource = new Map<string, string[]>();
        for (const row of mappingRows) {
                if (!eligibleSourceIds.has(row.epg_source_id)) continue;
                let bucket = explicitBySource.get(row.epg_source_id);
                if (!bucket) {
                        bucket = [];
                        explicitBySource.set(row.epg_source_id, bucket);
                }
                if (!bucket.includes(row.epg_channel_id)) bucket.push(row.epg_channel_id);
        }

        // 2. tvgId auto-match (only for channels WITHOUT an explicit mapping
        // on the source in question — explicit always wins).
        const tvgTargets = new Map<string, string[]>();
        const entriesResult = await client.from('livetv_source_channels').select('tvg_id, canonical_channel_id').eq('canonical_channel_id', channelId);
        const entries = (entriesResult.data ?? []) as unknown as SourceChannelRow[];
        const tvgIds = [...new Set(entries.map((entry) => entry.tvg_id).filter((value): value is string => typeof value === 'string' && value.length > 0))];
        if (tvgIds.length > 0) {
                // Ambiguity guard: identities claimed by a DIFFERENT canonical channel never serve data.
                const claimsResult = await client.from('livetv_source_channels').select('tvg_id, canonical_channel_id').in('tvg_id', tvgIds);
                const claims = (claimsResult.data ?? []) as unknown as SourceChannelRow[];
                const contested = new Set<string>();
                for (const claim of claims) {
                        if (claim.tvg_id && claim.canonical_channel_id && claim.canonical_channel_id !== channelId) contested.add(claim.tvg_id);
                }
                const safeTvgIds = tvgIds.filter((tvg) => !contested.has(tvg));
                // Which eligible EPG sources actually carry these identities? The
                // programmes table is the guide's presence proof — probe it with a
                // 1-row existence check per source (bounded by the source count).
                if (safeTvgIds.length > 0) {
                        const allSourcesResult = await client.from('livetv_epg_sources').select('id, enabled, status').eq('enabled', true);
                        const allSources = (allSourcesResult.data ?? []) as unknown as EpgSourceRow[];
                        for (const source of allSources) {
                                if (!statusEligible(source.status)) continue;
                                if (explicitBySource.has(source.id)) continue; // explicit mapping wins per source
                                const probe = await client
                                        .from('livetv_epg_programmes')
                                        .select('epg_channel_id')
                                        .eq('epg_source_id', source.id)
                                        .in('epg_channel_id', safeTvgIds)
                                        .limit(1);
                                const probeRows = (probe.data ?? []) as unknown as { epg_channel_id: string }[];
                                if (probeRows.length > 0) {
                                        tvgTargets.set(source.id, [...new Set(probeRows.map((row) => row.epg_channel_id))]);
                                }
                        }
                }
        }

        // Deterministic target order: explicit first, then tvgid; stable id
        // ordering inside each group.
        const targets: EpgTarget[] = [];
        for (const epgSourceId of [...explicitBySource.keys()].sort()) {
                targets.push({ epgSourceId, epgChannelIds: (explicitBySource.get(epgSourceId) ?? []).sort(), mappingSource: 'explicit' });
        }
        for (const epgSourceId of [...tvgTargets.keys()].sort()) {
                targets.push({ epgSourceId, epgChannelIds: (tvgTargets.get(epgSourceId) ?? []).sort(), mappingSource: 'tvgid' });
        }
        return targets;
}

// ---------------------------------------------------------------------------
// Current / upcoming lookups
// ---------------------------------------------------------------------------

function toView(row: Record<string, unknown>, target: EpgTarget, channelId: string): EpgProgrammeView {
        return {
                channelId,
                epgSourceId: target.epgSourceId,
                epgChannelId: String(row['epg_channel_id'] ?? target.epgChannelIds[0] ?? ''),
                mappingSource: target.mappingSource,
                startMs: Date.parse(String(row['start_at'])),
                endMs: Date.parse(String(row['end_at'])),
                title: String(row['title'] ?? ''),
                subTitle: (row['sub_title'] as string | null) ?? null,
                description: (row['description'] as string | null) ?? null,
                category: (row['category'] as string | null) ?? null,
                iconUrl: (row['icon_url'] as string | null) ?? null,
                language: (row['language'] as string | null) ?? null
        };
}

/**
 * The programme currently on air for one canonical channel, from persisted
 * guide data only. `now` is explicit (deterministic). Returns null when no
 * target guide covers the channel or no window contains `now` — never a
 * fabricated programme, never fake progress.
 */
export async function getCurrentEpgProgramme(client: SupabaseClient<Database>, channelId: string, now: Date): Promise<EpgProgrammeView | null> {
        const nowIso = new Date(now.getTime()).toISOString();
        const targets = await resolveEpgTargets(client, channelId);
        for (const target of targets) {
                const result = await client
                        .from('livetv_epg_programmes')
                        .select('epg_channel_id, start_at, end_at, title, sub_title, description, category, icon_url, language')
                        .eq('epg_source_id', target.epgSourceId)
                        .in('epg_channel_id', target.epgChannelIds)
                        .lte('start_at', nowIso)
                        .gt('end_at', nowIso)
                        .order('start_at', { ascending: false })
                        .order('end_at', { ascending: true })
                        .order('title', { ascending: true })
                        .limit(1);
                const rows = (result.data ?? []) as unknown as Record<string, unknown>[];
                if (rows.length > 0) return toView(rows[0]!, target, channelId);
        }
        return null;
}

export type EpgUpcomingOptions = {
        /** Maximum rows (1-50; default 5). */
        limit?: number;
        /** Only programmes starting within this many ms of `now` (optional). */
        horizonMs?: number;
};

/**
 * Upcoming programmes for one canonical channel, stable UTC ordering
 * (start, end, title). Gaps in guide coverage honestly return fewer rows.
 * The programme currently on air is not included (it is `current`).
 */
export async function getUpcomingEpgProgrammes(client: SupabaseClient<Database>, channelId: string, now: Date, options: EpgUpcomingOptions = {}): Promise<EpgProgrammeView[]> {
        const limit = Math.max(1, Math.min(50, Math.floor(options.limit ?? 5)));
        const nowIso = new Date(now.getTime()).toISOString();
        const horizonIso = options.horizonMs !== undefined ? new Date(now.getTime() + options.horizonMs).toISOString() : null;
        const targets = await resolveEpgTargets(client, channelId);
        for (const target of targets) {
                let query = client
                        .from('livetv_epg_programmes')
                        .select('epg_channel_id, start_at, end_at, title, sub_title, description, category, icon_url, language')
                        .eq('epg_source_id', target.epgSourceId)
                        .in('epg_channel_id', target.epgChannelIds)
                        .gt('start_at', nowIso)
                        .order('start_at', { ascending: true })
                        .order('end_at', { ascending: true })
                        .order('title', { ascending: true })
                        .limit(limit);
                if (horizonIso) query = query.lte('start_at', horizonIso);
                const result = await query;
                const rows = (result.data ?? []) as unknown as Record<string, unknown>[];
                if (rows.length > 0) return rows.map((row) => toView(row, target, channelId));
        }
        return [];
}
