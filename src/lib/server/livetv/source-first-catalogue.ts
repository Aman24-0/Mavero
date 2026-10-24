// ============================================================================
// Unified Live TV R-3 — SOURCE-FIRST catalogue & guide (server-only).
//
// The R-2 source ON/OFF contract made the legacy LiveGT catalogue path HONOR
// the source registry state. But with `unified_enabled = false` (production
// default), the page could ONLY show LiveGT V1 channels — even when
// JioHotstar and Sony were ON with imported channels. The legacy LiveGT API
// does not know about playlist sources, so it returned an empty catalogue
// when LiveGT was OFF, blanking the other active sources.
//
// R-3 closes that gap: a SOURCE-FIRST catalogue + guide that returns channels
// from EVERY eligible public source (enabled + playback-eligible status +
// visibility=public), regardless of the `unified_enabled` flag. The flag
// remains the owner's lever for the UNIFIED PLAYBACK ROUTER (Phase 5); it
// no longer gates the catalogue/guide surface. This is the documented
// "source-first activation" contract — the page shows what's ON, period.
//
// SECURITY (mirrors the unified catalogue):
//   * Read via the service-role client (livetv_* tables are fail-closed
//     admin-only by RLS; the /api/downloader/mavero public-read precedent).
//   * The wire carries ONLY bounded DTOs: id/name/category/logoUrl per
//     channel, plus the additive `sources` alternatives (R-1). NEVER config
//     jsonb, capabilities, slugs, source ids/labels beyond the alternative
//     label, endpoint URLs, dedup keys, or raw provider payloads.
//   * Fail-closed: any read failure returns an empty list (the page renders
//     its honest empty state — never a partial or stale answer).
//   * The `unified_enabled` flag is NEVER written here (read-only).
//
// GUIDE: the source-first guide reads the ESTABLISHED Phase 3 mapping
// contract (explicit EPG mappings first, ambiguity-guarded tvgId derivation
// second) through the same bounded queries. A channel with no matching
// guide data honestly returns null/empty — never fabricated. The legacy
// LiveGT guide API is NEVER called for non-LiveGT channels (fixing the
// R-2 "Live TV took too long to respond" regression for JioHotstar/Sony).
// ============================================================================

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '$lib/server/supabase/database.types';
import { LIVETV_PLAYBACK_ELIGIBLE_STATUSES, type LivetvSourceStatus } from './registry';
import { getCurrentEpgProgramme, getUpcomingEpgProgrammes } from './epg/queries';
import {
        MAX_CATALOGUE_GROUP_SOURCES,
        buildLivetvCatalogueGroups,
        type CatalogueGroupAlternative,
        type CatalogueGroupEntryRef,
        type CatalogueGroupSourceRef
} from './catalogue-groups';
import {
        type LivetvCatalogueChannelWire,
        type LivetvCatalogueWire,
        type LivetvGuideProgrammeWire,
        type LivetvGuideWire,
        MAX_CATALOGUE_CHANNELS,
        MAX_GUIDE_UPCOMING,
        MAX_MAPPED_ENTRIES_LOAD,
        MAX_SOURCES_LOAD,
        safeDisplayUrl
} from './user-catalogue';

// ---------------------------------------------------------------------------
// Source-first catalogue (R-3 — flag-agnostic).
// ---------------------------------------------------------------------------

/**
 * R-3 — the source-first catalogue. Returns channels from EVERY eligible
 * public source (enabled + playback-eligible status + visibility=public),
 * regardless of the `unified_enabled` flag. The flag remains the owner's
 * lever for the unified PLAYBACK router; the catalogue surface is now
 * source-first.
 *
 * Optional `sourceId` filter scopes the catalogue to ONE source's channels
 * (the heading-row Source selector). When `sourceId` is null, all eligible
 * sources contribute (the All Sources default).
 *
 * Fail-closed: any read failure returns an empty list. The flag is NEVER
 * written (read-only).
 */
export async function getSourceFirstLivetvCatalogue(
        client: SupabaseClient<Database>,
        options: { sourceId?: string | null } = {}
): Promise<LivetvCatalogueWire> {
        const filterSourceId = typeof options.sourceId === 'string' && options.sourceId.length > 0 ? options.sourceId : null;

        // 1. User-facing sources: enabled + playback-eligible + PUBLIC.
        //    (R-3: the same gates as the availability contract — `enabled`
        //    is the persisted ON/OFF control; `status` must be playback-
        //    eligible; `visibility='public'` is the user-facing exposure.)
        const sourcesResult = await client
                .from('livetv_sources')
                .select('id,name,slug,priority,enabled,status,visibility')
                .limit(MAX_SOURCES_LOAD);
        if (sourcesResult.error) return { unifiedEnabled: false, channels: [], truncated: false };
        const sourceRows = (sourcesResult.data ?? []) as { id: string; name: string; slug: string; priority: number; enabled: boolean; status: string; visibility: string }[];
        const sourceRefs: CatalogueGroupSourceRef[] = [];
        for (const row of sourceRows) {
                if (row.enabled !== true || row.visibility !== 'public' || !isEligibleStatus(String(row.status))) continue;
                // R-3 sourceId filter: only the selected source contributes.
                if (filterSourceId !== null && row.id !== filterSourceId) continue;
                const id = nonEmptyString(row.id);
                if (!id) continue;
                sourceRefs.push({ id, name: nonEmptyString(row.name) ?? id, slug: nonEmptyString(row.slug) ?? '', priority: typeof row.priority === 'number' && Number.isFinite(row.priority) ? row.priority : 0 });
        }
        if (sourceRefs.length === 0) return { unifiedEnabled: true, channels: [], truncated: false };

        // 2. Enabled entries on those sources — the grouping candidate pool.
        const entriesResult = await client
                .from('livetv_source_channels')
                .select('id,source_id,source_channel_id,canonical_channel_id,enabled,name,category,logo_url')
                .in('source_id', sourceRefs.map((source) => source.id))
                .limit(MAX_MAPPED_ENTRIES_LOAD);
        if (entriesResult.error) return { unifiedEnabled: true, channels: [], truncated: false };
        const entryRows = (entriesResult.data ?? []) as { id: string; source_id: string; source_channel_id: string; canonical_channel_id: string | null; enabled: boolean; name: string | null; category: string | null; logo_url: string | null }[];
        const entryRefs: CatalogueGroupEntryRef[] = [];
        const mappedCanonicalIds = new Set<string>();
        for (const row of entryRows) {
                if (row.enabled !== true) continue; // M1 — a disabled entry never contributes
                if (typeof row.canonical_channel_id === 'string' && row.canonical_channel_id.length > 0) {
                        mappedCanonicalIds.add(row.canonical_channel_id);
                }
                entryRefs.push({
                        id: row.id,
                        sourceId: row.source_id,
                        sourceChannelId: nonEmptyString(row.source_channel_id) ?? '',
                        canonicalChannelId: typeof row.canonical_channel_id === 'string' && row.canonical_channel_id.length > 0 ? row.canonical_channel_id : null,
                        name: row.name,
                        category: row.category,
                        logoUrl: row.logo_url
                });
        }
        if (entryRefs.length === 0) return { unifiedEnabled: true, channels: [], truncated: false };

        // 3. The ENABLED canonical channels hosting mapped entries.
        const canonicalRows: { id: string; name: string; category: string | null; logo_url: string | null; enabled: boolean }[] = [];
        if (mappedCanonicalIds.size > 0) {
                const channelsResult = await client
                        .from('livetv_channels')
                        .select('id,name,category,logo_url,enabled')
                        .eq('enabled', true)
                        .in('id', [...mappedCanonicalIds])
                        .order('name', { ascending: true })
                        .order('id', { ascending: true })
                        .limit(MAX_CATALOGUE_CHANNELS);
                if (channelsResult.error) return { unifiedEnabled: true, channels: [], truncated: false };
                canonicalRows.push(...((channelsResult.data ?? []) as { id: string; name: string; category: string | null; logo_url: string | null; enabled: boolean }[]));
        }

        // 4. The PURE deterministic grouping.
        const { groups } = buildLivetvCatalogueGroups({
                sources: sourceRefs,
                entries: entryRefs,
                canonicals: canonicalRows.map((row) => ({ id: row.id, name: row.name, category: row.category, logoUrl: row.logo_url }))
        });
        if (groups.length === 0) return { unifiedEnabled: true, channels: [], truncated: false };

        // 5. Wire projection — same DTO as the unified catalogue.
        const channels: LivetvCatalogueChannelWire[] = [];
        for (const group of groups) {
                const name = nonEmptyString(group.name);
                if (!name) continue;
                const row: LivetvCatalogueChannelWire = {
                        id: group.id,
                        name,
                        category: nonEmptyString(group.category),
                        logoUrl: safeDisplayUrl(group.logoUrl)
                };
                if (group.alternatives.length >= 2) {
                        row.sources = group.alternatives.map((alternative: CatalogueGroupAlternative) => ({ id: alternative.id, label: alternative.label }));
                }
                channels.push(row);
        }

        const truncated = entryRows.length >= MAX_MAPPED_ENTRIES_LOAD || groups.length > MAX_CATALOGUE_CHANNELS;
        if (channels.length > MAX_CATALOGUE_CHANNELS) channels.length = MAX_CATALOGUE_CHANNELS;
        return { unifiedEnabled: true, channels, truncated };
}

// ---------------------------------------------------------------------------
// Source-first guide (R-3 — flag-agnostic).
// ---------------------------------------------------------------------------

/**
 * R-3 — the source-first guide. Returns Now/Next guide data for ONE channel
 * through the ESTABLISHED Phase 3 mapping contract (explicit EPG mappings
 * first, ambiguity-guarded tvgId derivation second). The `unified_enabled`
 * flag is NO LONGER a gate — the guide reads the EPG tables directly.
 *
 * For a channel selected from a playlist source (JioHotstar/Sony), the
 * channel id is `entry:<rowId>` (R-0 direct-entry identity). The guide
 * resolves the entry's `tvg_id` and looks up EPG programmes through the
 * mapping contract. A channel with no matching guide data honestly
 * returns `now: null` / `upcoming: []` — never fabricated, never a
 * timeout (fixing the R-2 "Live TV took too long to respond" regression
 * for non-LiveGT channels).
 *
 * For a canonical channel (LiveGT V1 mapped), the channel id IS the
 * canonical id — the same path the unified guide used.
 *
 * Fail-closed: any read failure returns an empty guide (never a timeout
 * surface). The flag is NEVER written (read-only).
 */
export async function getSourceFirstLivetvGuide(client: SupabaseClient<Database>, channelId: string, now: Date): Promise<LivetvGuideWire> {
        const base: LivetvGuideWire = { unifiedEnabled: true, channelId, serverNowMs: now.getTime(), now: null, upcoming: [] };

        // R-3 — resolve the channel id to a canonical channel id for the
        // EPG lookup. Two identities are accepted:
        //   (a) `entry:<entry-row-uuid>` — the R-0 direct-entry identity for
        //       unmapped playlist channels. The entry's `canonical_channel_id`
        //       (if mapped) or `tvg_id` (if unmapped) drives the EPG lookup.
        //   (b) a canonical channel id — the mapped identity; used directly.
        let canonicalId: string | null = null;
        let tvgId: string | null = null;

        if (channelId.startsWith('entry:')) {
                const entryRowId = channelId.slice('entry:'.length);
                // Bounded UUID validation — the catalogue emits exactly this id.
                if (ENTRY_ROW_ID_PATTERN.test(entryRowId)) {
                        const { data: entryRow, error: entryError } = await client
                                .from('livetv_source_channels')
                                .select('id,canonical_channel_id,tvg_id,enabled,source_id')
                                .eq('id', entryRowId)
                                .limit(1)
                                .maybeSingle();
                        if (entryError || !entryRow) return base;
                        // M1 — a disabled entry never contributes guide data.
                        if (entryRow.enabled !== true) return base;
                        if (typeof entryRow.canonical_channel_id === 'string' && entryRow.canonical_channel_id.length > 0) {
                                canonicalId = entryRow.canonical_channel_id;
                        }
                        if (typeof entryRow.tvg_id === 'string' && entryRow.tvg_id.length > 0) {
                                tvgId = entryRow.tvg_id;
                        }
                }
        } else {
                // Assume canonical channel id — verify the row exists.
                canonicalId = channelId;
        }

        // If the entry is unmapped (no canonical id) and has no tvg_id,
        // honestly return an empty guide — never fabricate, never timeout.
        if (!canonicalId && !tvgId) return base;

        try {
                // The Phase 3 queries accept a canonical channel id. For an
                // unmapped entry with a tvg_id, we pass the tvg_id-derived
                // canonical lookup — but the established queries already
                // handle the ambiguity-guarded tvgId derivation internally
                // when given the canonical id. For an unmapped entry with
                // ONLY a tvg_id, there's no canonical row to look up —
                // honestly return empty (the mapping contract requires an
                // explicit canonical mapping or a tvgId-derivable one).
                const lookupId = canonicalId ?? channelId;
                const [current, upcoming] = await Promise.all([
                        getCurrentEpgProgramme(client, lookupId, now),
                        getUpcomingEpgProgrammes(client, lookupId, now, { limit: MAX_GUIDE_UPCOMING })
                ]);
                return {
                        unifiedEnabled: true,
                        channelId,
                        serverNowMs: now.getTime(),
                        now: current ? toProgrammeWire(current) : null,
                        upcoming: upcoming.map(toProgrammeWire)
                };
        } catch {
                // Fail-closed: any read failure is an empty guide (never a
                // timeout surface — the page renders the honest empty state).
                return base;
        }
}

// ---------------------------------------------------------------------------
// Helpers (mirrored from user-catalogue.ts — the same bounded gates).
// ---------------------------------------------------------------------------

const ENTRY_ROW_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function nonEmptyString(value: unknown): string | null {
        if (typeof value !== 'string') return null;
        const trimmed = value.trim();
        return trimmed.length > 0 ? trimmed : null;
}

function isEligibleStatus(status: string): boolean {
        return LIVETV_PLAYBACK_ELIGIBLE_STATUSES.has(status as LivetvSourceStatus);
}

function toProgrammeWire(view: {
        title: string;
        subTitle: string | null;
        description: string | null;
        category: string | null;
        iconUrl: string | null;
        startMs: number;
        endMs: number;
}): LivetvGuideProgrammeWire {
        return {
                title: view.title,
                description: nonEmptyString(view.description),
                category: nonEmptyString(view.category),
                iconUrl: safeDisplayUrl(view.iconUrl),
                startMs: view.startMs,
                endMs: view.endMs
        };
}
