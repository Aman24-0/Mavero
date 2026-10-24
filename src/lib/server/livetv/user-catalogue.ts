// ============================================================================
// Unified Live TV Phase 6 — user-facing catalogue & guide reads (SERVER).
//
//   GET /api/livetv/catalogue → the merged, exposure-filtered canonical list
//   GET /api/livetv/guide?channelId=<canonicalId> → Now/Next via Phase 3
//
// This module is the USER-FACING read half of the EXISTING Phase 1 registry
// and Phase 3 guide model. It owns NO second registry, NO second EPG
// pipeline and NO ordering logic of its own:
//
//   * Catalogue exposure = the registry contract's own rules, applied to
//     the EXISTING tables: a canonical channel is user-facing when it is
//     `enabled` AND at least one of its mapped source entries is `enabled`
//     on a source that is `enabled`, playback-eligible
//     (`LIVETV_PLAYBACK_ELIGIBLE_STATUSES`) and `visibility='public'`
//     (the column's documented user-facing exposure control; the seeded
//     builtin row is `public`, admin-created sources default to
//     `internal` and must be made public deliberately).
//   * R-0 ADDITIVE — safe SOURCE-ENTRY selection: UNMAPPED, enabled entries
//     of the SAME eligible public sources ALSO surface (as `entry:<rowId>`
//     rows after the canonical rows). Without this, a real-world registry
//     whose entries are not canonically mapped (e.g. a freshly imported
//     playlist) would produce an EMPTY catalogue the moment the flag turns
//     on — unmapped-ness alone never meant the stream was invalid. The
//     model is NOT weakened: no mapping is fabricated, no name-similarity
//     merging happens (Phase 1 D-3), mapped entries still render ONCE via
//     their canonical channel (never double-listed), every row keeps the
//     bounded DTO (id/name/category/logoUrl only — no source identity
//     crosses), and playback for `entry:` selections is resolved by the
//     Phase 5 resolver's re-validated direct-entry path.
//   * Canonical PK uniqueness makes duplicate rendering structurally
//     impossible: several source entries mapping to one canonical channel
//     collapse into ONE row (the entries are never listed themselves).
//   * Guide data comes ONLY from the Phase 3 query helpers
//     (`getCurrentEpgProgramme` / `getUpcomingEpgProgrammes` — explicit
//     mappings first, ambiguity-guarded tvgId second). A channel with no
//     matching guide data honestly returns null/empty — nothing is ever
//     fabricated, no display-name matching is performed, and the browser
//     never fetches or parses XMLTV.
//
// SECURITY / RESPONSE DISCIPLINE (mirrors the Phase 5 playback wire):
//   * Every `livetv_*` table is fail-closed admin-only by RLS, so both
//     reads go through the SERVICE-ROLE client at the route (the
//     established /api/downloader/mavero public-read precedent) and this
//     module returns ONLY the bounded DTOs below — never config jsonb,
//     capabilities, slugs, source ids/labels, endpoint URLs, dedup keys,
//     notes, visibility metadata, or EPG-source identities.
//   * Flag reads reuse the Phase 5 cached `isUnifiedLivetvEnabled`
//     (fail-closed FALSE ⇒ an empty catalogue/guide; the legacy page path
//     is the safe direction).
//   * Logo values are carried ONLY as http(s) absolute URLs (anything else
//     degrades to null — the client renders its existing initials
//     fallback; nothing is ever invented).
//   * Zero upstream fetching happens here (pure DB reads). Playback stays
//     browser-direct; no media proxy is created or needed.
// ============================================================================

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '$lib/server/supabase/database.types';
import { LIVETV_PLAYBACK_ELIGIBLE_STATUSES, type LivetvSourceStatus } from './registry';
import { isUnifiedLivetvEnabled } from './playback-resolver';
import { getCurrentEpgProgramme, getUpcomingEpgProgrammes } from './epg/queries';

// ---------------------------------------------------------------------------
// Catalogue wire contract (the ONLY data that ever crosses for the list).
// ---------------------------------------------------------------------------

export type LivetvCatalogueChannelWire = {
        /** The STABLE canonical channel id (UI keys, recents, selection). */
        id: string;
        name: string;
        category: string | null;
        logoUrl: string | null;
};

export type LivetvCatalogueWire = {
        unifiedEnabled: boolean;
        channels: LivetvCatalogueChannelWire[];
        /** True when eligible channels exist beyond the bounded response. */
        truncated: boolean;
};

/** Hard response bound (bounded payload regardless of registry size). */
export const MAX_CATALOGUE_CHANNELS = 2000;
/** Bounded mapped-entry load (the exposure candidate pool). */
const MAX_MAPPED_ENTRIES_LOAD = 5000;
/** Bounded source load (the exposure source pool). */
const MAX_SOURCES_LOAD = 500;

/** Stable selection-id prefix for direct source-entry rows (R-0). */
export const LIVETV_ENTRY_SELECTION_PREFIX = 'entry:';

// ---------------------------------------------------------------------------
// Guide wire contract (the ONLY data that ever crosses for the guide).
// ---------------------------------------------------------------------------

export type LivetvGuideProgrammeWire = {
        title: string;
        description: string | null;
        category: string | null;
        /** Genuine programme artwork from the guide; null when absent. */
        iconUrl: string | null;
        /** Absolute UTC instant (epoch ms) — the Phase 3 timestamp policy. */
        startMs: number;
        endMs: number;
};

export type LivetvGuideWire = {
        unifiedEnabled: boolean;
        channelId: string;
        /** Server clock at read time (absolute UTC instant, epoch ms). */
        serverNowMs: number;
        /** The programme on air, or null (honest gap — never fabricated). */
        now: LivetvGuideProgrammeWire | null;
        /** Upcoming programmes, deterministic start order, bounded. */
        upcoming: LivetvGuideProgrammeWire[];
};

/** Upcoming programme bound (the guide sheet is a bounded "from now" list). */
export const MAX_GUIDE_UPCOMING = 24;

// ---------------------------------------------------------------------------
// Narrowing helpers (explicit, one-directional, fail-closed row drops).
// ---------------------------------------------------------------------------

function nonEmptyString(value: unknown): string | null {
        if (typeof value !== 'string') return null;
        const trimmed = value.trim();
        return trimmed.length > 0 ? trimmed : null;
}

/** Only http(s) absolute URLs are usable display material; else null. */
function safeDisplayUrl(value: unknown): string | null {
        const raw = nonEmptyString(value);
        if (!raw || raw.length > 2048) return null;
        try {
                const parsed = new URL(raw);
                return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? raw : null;
        } catch {
                return null;
        }
}

function isEligibleStatus(status: string): boolean {
        return LIVETV_PLAYBACK_ELIGIBLE_STATUSES.has(status as LivetvSourceStatus);
}

// ---------------------------------------------------------------------------
// Catalogue read.
// ---------------------------------------------------------------------------

/**
 * The merged, exposure-filtered canonical channel catalogue.
 *
 * Flag off (or any read failure) ⇒ an empty list — the client stays on the
 * untouched legacy path (fail-closed; the flag is the rollback lever).
 */
export async function getUnifiedLivetvCatalogue(client: SupabaseClient<Database>): Promise<LivetvCatalogueWire> {
        const unifiedEnabled = await isUnifiedLivetvEnabled(client);
        if (!unifiedEnabled) return { unifiedEnabled: false, channels: [], truncated: false };

        // 1. User-facing sources: enabled + playback-eligible + PUBLIC
        //    (visibility is the registry's user-facing exposure control).
        const sourcesResult = await client
                .from('livetv_sources')
                .select('id,enabled,status,visibility')
                .limit(MAX_SOURCES_LOAD);
        if (sourcesResult.error) return { unifiedEnabled: true, channels: [], truncated: false };
        const sourceRows = (sourcesResult.data ?? []) as { id: string; enabled: boolean; status: string; visibility: string }[];
        const publicSourceIds = sourceRows
                .filter((row) => row.enabled === true && row.visibility === 'public' && isEligibleStatus(String(row.status)))
                .map((row) => row.id);
        if (publicSourceIds.length === 0) return { unifiedEnabled: true, channels: [], truncated: false };

        // 2. Enabled entries on those sources — mapped ones expose their
        //    canonical ids; UNMAPPED ones (R-0) become direct source-entry
        //    rows. Entries' source attribution stays internal (provenance
        //    never crosses the wire — see the DTO discipline above).
        const entriesResult = await client
                .from('livetv_source_channels')
                .select('id,source_id,canonical_channel_id,enabled,name,category,logo_url')
                .in('source_id', publicSourceIds)
                .limit(MAX_MAPPED_ENTRIES_LOAD);
        if (entriesResult.error) return { unifiedEnabled: true, channels: [], truncated: false };
        const entryRows = (entriesResult.data ?? []) as { id: string; canonical_channel_id: string | null; enabled: boolean; source_id: string; name: string | null; category: string | null; logo_url: string | null }[];
        const exposedIds = new Set<string>();
        const directEntryRows: LivetvCatalogueChannelWire[] = [];
        for (const row of entryRows) {
                if (row.enabled !== true) continue;
                if (typeof row.canonical_channel_id === 'string' && row.canonical_channel_id.length > 0) {
                        exposedIds.add(row.canonical_channel_id);
                        continue; // mapped — contributes through its canonical channel ONLY (never double-listed)
                }
                // R-0 — unmapped: a bounded, display-safe source-entry row.
                // The stable selection id is the entry ROW id (globally unique
                // uuid, namespaced so it can never collide with a canonical
                // channel id); unusable rows are dropped, never coerced.
                const name = nonEmptyString(row.name);
                if (!name) continue;
                directEntryRows.push({
                        id: `${LIVETV_ENTRY_SELECTION_PREFIX}${row.id}`,
                        name,
                        category: nonEmptyString(row.category),
                        logoUrl: safeDisplayUrl(row.logo_url)
                });
        }
        if (exposedIds.size === 0 && directEntryRows.length === 0) return { unifiedEnabled: true, channels: [], truncated: false };

        // 3. The enabled canonical channels, deterministically ordered
        //    (name ASC, then id ASC) and bounded.
        const channelRows: { id: string; name: string; category: string | null; logo_url: string | null; enabled: boolean }[] = [];
        if (exposedIds.size > 0) {
                const channelsResult = await client
                        .from('livetv_channels')
                        .select('id,name,category,logo_url,enabled')
                        .eq('enabled', true)
                        .in('id', [...exposedIds])
                        .order('name', { ascending: true })
                        .order('id', { ascending: true })
                        .limit(MAX_CATALOGUE_CHANNELS);
                if (channelsResult.error) return { unifiedEnabled: true, channels: [], truncated: false };
                channelRows.push(...((channelsResult.data ?? []) as { id: string; name: string; category: string | null; logo_url: string | null; enabled: boolean }[]));
        }

        const channels: LivetvCatalogueChannelWire[] = [];
        for (const row of channelRows) {
                const id = nonEmptyString(row.id);
                const name = nonEmptyString(row.name);
                if (!id || !name) continue; // unusable rows are dropped, never coerced
                channels.push({
                        id,
                        name,
                        category: nonEmptyString(row.category),
                        logoUrl: safeDisplayUrl(row.logo_url)
                });
        }

        // R-0 — the direct source-entry rows, deterministically ordered
        // (name ASC, then row id ASC) and appended AFTER the canonical rows
        // (canonical channels remain the stable leading surface).
        directEntryRows.sort((a, b) => (a.name === b.name ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : a.name < b.name ? -1 : 1));
        channels.push(...directEntryRows);

        // Honest truncation: the entry pool hit its load cap, or the combined
        // response hit the response bound (sliced to the bound, flagged).
        const truncated = entryRows.length >= MAX_MAPPED_ENTRIES_LOAD || channelRows.length >= MAX_CATALOGUE_CHANNELS || channels.length > MAX_CATALOGUE_CHANNELS;
        if (channels.length > MAX_CATALOGUE_CHANNELS) channels.length = MAX_CATALOGUE_CHANNELS;
        return { unifiedEnabled: true, channels, truncated };
}

// ---------------------------------------------------------------------------
// Guide read (Phase 3 mapping contract ONLY).
// ---------------------------------------------------------------------------

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

/**
 * Now/Next guide data for ONE canonical channel through the ESTABLISHED
 * Phase 3 mapping contract (explicit EPG mappings first, ambiguity-guarded
 * tvgId derivation second). Missing/unmatched/stale guide data honestly
 * yields `now: null` / `upcoming: []` — never a fabricated programme, never
 * a display-name guess, never a browser-side XMLTV fetch.
 */
export async function getUnifiedLivetvGuide(client: SupabaseClient<Database>, channelId: string, now: Date): Promise<LivetvGuideWire> {
        const unifiedEnabled = await isUnifiedLivetvEnabled(client);
        const base: LivetvGuideWire = { unifiedEnabled, channelId, serverNowMs: now.getTime(), now: null, upcoming: [] };
        if (!unifiedEnabled) return base;

        const [current, upcoming] = await Promise.all([
                getCurrentEpgProgramme(client, channelId, now),
                getUpcomingEpgProgrammes(client, channelId, now, { limit: MAX_GUIDE_UPCOMING })
        ]);

        return {
                unifiedEnabled: true,
                channelId,
                serverNowMs: now.getTime(),
                now: current ? toProgrammeWire(current) : null,
                upcoming: upcoming.map(toProgrammeWire)
        };
}
