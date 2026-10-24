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
//     the EXISTING tables: a channel card is user-facing when it is enabled
//     AND backed by at least one `enabled` entry on a source that is
//     `enabled`, playback-eligible
//     (`LIVETV_PLAYBACK_ELIGIBLE_STATUSES`) and `visibility='public'`
//     (the column's documented user-facing exposure control; the seeded
//     builtin row is `public`, admin-created sources default to
//     `internal` and must be made public deliberately).
//   * R-0 ADDITIVE — safe SOURCE-ENTRY selection: UNMAPPED, enabled entries
//     of the SAME eligible public sources ALSO surface (as `entry:<rowId>`
//     rows). Without this, a real-world registry whose entries are not
//     canonically mapped (e.g. a freshly imported playlist) would produce an
//     EMPTY catalogue the moment the flag turns on — unmapped-ness alone
//     never meant the stream was invalid. The model is NOT weakened: no
//     mapping is fabricated, no name-SIMILARITY merging happens (Phase 1
//     D-3), mapped entries still render ONCE via their canonical channel
//     (never double-listed), every row keeps the bounded DTO (id/name/
//     category/logoUrl — no source config/URLs cross), and playback for
//     `entry:` selections is resolved by the Phase 5 resolver's
//     re-validated direct-entry path.
//   * R-1 ADDITIVE — deterministic GROUPING (the pure
//     `catalogue-groups.ts` model): equivalent channels from multiple
//     eligible sources collapse into ONE card. Identity precedence:
//     the canonical mapping (trusted) first, then EXACT normalized
//     display-name equality for unmapped entries (never fuzzy). Each card
//     may carry bounded, labeled per-source ALTERNATIVES (`sources`) —
//     the selection ids the resolver already accepts — so the player can
//     offer source switching without any new resolver surface.
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
import {
  MAX_CATALOGUE_GROUP_SOURCES,
  buildLivetvCatalogueGroups,
  type CatalogueGroupAlternative,
  type CatalogueGroupEntryRef,
  type CatalogueGroupSourceRef
} from './catalogue-groups';

// ---------------------------------------------------------------------------
// Catalogue wire contract (the ONLY data that ever crosses for the list).
// ---------------------------------------------------------------------------

/** One switchable source alternative (R-1) — a selection id + display label. */
export type LivetvCatalogueSourceWire = {
        /** The selection id that resolves THIS source's stream for the channel. */
        id: string;
        /** The source's admin display name (never config, URLs or slugs). */
        label: string;
};

export type LivetvCatalogueChannelWire = {
        /** The STABLE group id (UI keys, recents, selection). */
        id: string;
        name: string;
        category: string | null;
        logoUrl: string | null;
        /**
         * R-1 (ADDITIVE) — the bounded, preferred-first alternative playback
         * sources for this group (one per contributing source, ≤
         * MAX_CATALOGUE_GROUP_SOURCES). Present ONLY when at least two usable
         * alternatives exist (the player switcher is otherwise hidden).
         * Deliberate bounded extension of the DTO: labels are admin display
         * names; ids are the established `entry:` selection ids the resolver
         * already accepts. No config, URLs, slugs or visibility data crosses.
         */
        sources?: LivetvCatalogueSourceWire[];
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
/** Re-exported bound (the switcher payload size lives with the grouping model). */
export const MAX_CATALOGUE_SOURCE_ALTERNATIVES = MAX_CATALOGUE_GROUP_SOURCES;

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
// Public availability state (R-2 — authoritative source ON/OFF contract).
// ---------------------------------------------------------------------------

/**
 * The bounded public availability wire (R-2). Surfaces ONLY:
 *   * `available` — true iff at least ONE source contributes user-visible
 *     channels (enabled + playback-eligible status + visibility='public').
 *   * `sources` — the bounded list of eligible public sources (id + display
 *     name + a `builtin` marker) for the navbar/source-selector. The
 *     `builtin` flag is the ONLY property that distinguishes the seeded
 *     LiveGT V1 source from admin-created sources — it lets the page
 *     decide whether the legacy LiveGT V1 catalogue path is allowed
 *     (the legacy path is LiveGT-specific; an admin-created source OFF
 *     must NOT cause LiveGT channels to bypass the contract through the
 *     legacy fallback). NEVER config, URLs, slugs, capabilities,
 *     visibility/status labels, source_type, or any internal identity.
 *
 * Used by:
 *   * `/api/livetv/availability` — the public, rate-limited, no-store endpoint.
 *   * `/live-tv/+page.server.ts` — the SSR guard that returns an honest
 *     unavailable state when no eligible public source exists (so the legacy
 *     LiveGT catalogue is NEVER loaded against an owner's OFF decision).
 *   * `+layout.server.ts` — the navbar's link visibility (defense in depth
 *     on top of the route guard; the API/route enforcement is the authority).
 *
 * The function is PURELY a read; it owns no caching (the caller's endpoint
 * sets `no-store` so an owner's toggle reflects immediately). Fail-closed:
 * any read failure returns `available: false, sources: []` (the safe
 * direction is always "no Live TV right now").
 */
export type LivetvAvailabilitySourceWire = {
        /** The source's stable UUID — never the slug, never the config. */
        id: string;
        /** The admin display name (the only label material that crosses). */
        name: string;
        /**
         * R-2 — true iff this is the SEEDED built-in LiveGT V1 source. The
         * page uses this to decide whether the legacy LiveGT catalogue path
         * is allowed (the legacy path is LiveGT-specific and bypasses the
         * unified catalogue; an OFF LiveGT source must NEVER trigger it).
         */
        builtin: boolean;
};

export type LivetvAvailabilityWire = {
        available: boolean;
        sources: LivetvAvailabilitySourceWire[];
};

/** Bounded source load (the exposure candidate pool — same as the catalogue). */
const MAX_AVAILABILITY_SOURCES_LOAD = 500;

/**
 * R-2 — the authoritative public-availability read. A source contributes
 * user-visible channels ONLY when ALL of:
 *   * `enabled = true`           (the persisted ON/OFF control — the
 *                                 operational `status` NEVER overrides this)
 *   * `status` is playback-eligible  (LIVETV_PLAYBACK_ELIGIBLE_STATUSES)
 *   * `visibility = 'public'`    (the column's documented user-facing
 *                                 exposure control)
 *
 * The legacy LiveGT V1 catalogue path on `/live-tv` is gated on this read
 * via the SSR guard — a disabled LiveGT source can never again bypass the
 * owner's decision through the legacy fallback. The unified catalogue path
 * already enforced this in R-1; R-2 extends the contract to the legacy
 * path AND the navbar.
 */
export async function getLivetvAvailabilityState(client: SupabaseClient<Database>): Promise<LivetvAvailabilityWire> {
        try {
                const sourcesResult = await client
                        .from('livetv_sources')
                        .select('id,name,enabled,status,visibility,builtin,source_type')
                        .limit(MAX_AVAILABILITY_SOURCES_LOAD);
                if (sourcesResult.error) return { available: false, sources: [] };
                const rows = (sourcesResult.data ?? []) as { id: string; name: string; enabled: boolean; status: string; visibility: string; builtin: boolean; source_type: string }[];
                const sources: LivetvAvailabilitySourceWire[] = [];
                for (const row of rows) {
                        if (row.enabled !== true || row.visibility !== 'public' || !isEligibleStatus(String(row.status))) continue;
                        const id = nonEmptyString(row.id);
                        if (!id) continue;
                        const name = nonEmptyString(row.name) ?? id;
                        // The seeded LiveGT V1 source is identified by BOTH
                        // `builtin = true` AND `source_type = 'builtin_livegt_v1'`.
                        // The source_type itself never crosses the wire — only
                        // the boolean marker does.
                        const builtin = row.builtin === true && row.source_type === 'builtin_livegt_v1';
                        sources.push({ id, name, builtin });
                }
                return { available: sources.length > 0, sources };
        } catch {
                return { available: false, sources: [] };
        }
}

// ---------------------------------------------------------------------------
// Catalogue read.
// ---------------------------------------------------------------------------

/**
 * The merged, exposure-filtered CHANNEL GROUP catalogue (R-1).
 *
 * Flag off (or any read failure) ⇒ an empty list — the client stays on the
 * untouched legacy path (fail-closed; the flag is the rollback lever).
 *
 * R-1 evolution (ADDITIVE over R-0's direct-entry surface): equivalent
 * channels from multiple eligible sources now collapse into ONE card with
 * bounded, labeled per-source alternatives. The reads below are the SAME
 * bounded, exposure-filtered reads as before (plus the display/priority
 * columns the grouping model needs); the deterministic grouping itself is
 * the pure `buildLivetvCatalogueGroups` model — identity precedence:
 * canonical mapping first (trusted), then EXACT normalized name equality
 * for unmapped entries (never fuzzy). Mapped-to-disabled-canonical entries
 * contribute nothing (C1 preserved, R-0 parity).
 */
export async function getUnifiedLivetvCatalogue(client: SupabaseClient<Database>): Promise<LivetvCatalogueWire> {
        const unifiedEnabled = await isUnifiedLivetvEnabled(client);
        if (!unifiedEnabled) return { unifiedEnabled: false, channels: [], truncated: false };

        // 1. User-facing sources: enabled + playback-eligible + PUBLIC
        //    (visibility is the registry's user-facing exposure control).
        //    R-1: the read also carries the display/priority columns the
        //    grouping model needs (labels + deterministic preferred source).
        const sourcesResult = await client
                .from('livetv_sources')
                .select('id,name,slug,priority,enabled,status,visibility')
                .limit(MAX_SOURCES_LOAD);
        if (sourcesResult.error) return { unifiedEnabled: true, channels: [], truncated: false };
        const sourceRows = (sourcesResult.data ?? []) as { id: string; name: string; slug: string; priority: number; enabled: boolean; status: string; visibility: string }[];
        const sourceRefs: CatalogueGroupSourceRef[] = [];
        for (const row of sourceRows) {
                if (row.enabled !== true || row.visibility !== 'public' || !isEligibleStatus(String(row.status))) continue;
                const id = nonEmptyString(row.id);
                if (!id) continue; // unusable rows are dropped, never coerced
                sourceRefs.push({ id, name: nonEmptyString(row.name) ?? id, slug: nonEmptyString(row.slug) ?? '', priority: typeof row.priority === 'number' && Number.isFinite(row.priority) ? row.priority : 0 });
        }
        if (sourceRefs.length === 0) return { unifiedEnabled: true, channels: [], truncated: false };

        // 2. Enabled entries on those sources — the grouping candidate pool.
        //    Source attribution stays internal (provenance never crosses the
        //    wire — only the bounded DTO + labeled alternatives below cross).
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
                        mappedCanonicalIds.add(row.canonical_channel_id); // C1 pool (enabled-only read below)
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

        // 3. The ENABLED canonical channels hosting mapped entries
        //    (deterministically ordered, bounded — same read as R-0).
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

        // 4. The PURE deterministic grouping (identity precedence + preferred
        //    source + bounded labeled alternatives — plan §18.2).
        const { groups } = buildLivetvCatalogueGroups({
                sources: sourceRefs,
                entries: entryRefs,
                canonicals: canonicalRows.map((row) => ({ id: row.id, name: row.name, category: row.category, logoUrl: row.logo_url }))
        });
        if (groups.length === 0) return { unifiedEnabled: true, channels: [], truncated: false };

        // 5. Wire projection — the bounded DTO; `sources` present only when
        //    at least TWO usable alternatives exist (the switcher gate).
        const channels: LivetvCatalogueChannelWire[] = [];
        for (const group of groups) {
                const name = nonEmptyString(group.name);
                if (!name) continue; // unusable groups are dropped, never coerced
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

        // Honest truncation: the entry pool hit its load cap, or the combined
        // response hit the response bound (sliced to the bound, flagged).
        const truncated = entryRows.length >= MAX_MAPPED_ENTRIES_LOAD || groups.length > MAX_CATALOGUE_CHANNELS;
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
