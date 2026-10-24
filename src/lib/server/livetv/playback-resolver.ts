// ============================================================================
// Unified Live TV Phase 5 — playback candidate resolution (SERVER).
//
//   GET /api/livetv/playback/config  → { unifiedEnabled }
//   GET /api/livetv/playback/resolve?channelId=<selectionId>
//                                    → ordered, eligible, redacted candidates
//
// This module is the RUNTIME half of the Phase 1 registry: it loads the
// persisted configuration rows and hands them to the PURE Phase 1 resolution
// functions (`resolveLivetvPlaybackOrder` — explicit vs default mode, the
// seven enablement gates, deterministic tie-breaking). It owns NO ordering
// logic of its own and adds NO second registry.
//
// THE BUILTIN LIVEGT INTEGRATION (the documented schema-gap answer):
//   The builtin source's direct stream is a FRESH-SIGNED RESOLUTION CONTRACT
//   (P2 worklog: "resolution-based direct + embed candidates is the Phase 5
//   design space") — `livetv_playback_endpoints.url` is NOT NULL, so a
//   builtin direct endpoint row is unrepresentable. Rather than a migration,
//   this resolver synthesizes the builtin's candidate pair (direct → embed)
//   for a MAPPED+ENABLED builtin entry and injects them as VIRTUAL endpoints
//   into `buildDefaultLivetvOrder` — the registry's own default-mode
//   mechanics position them by source priority (the seeded builtin row has
//   priority 0; admins reorder sources in the Phase 4 UI; nothing is
//   hardcoded first). EXPLICIT mode stays registry-pure: candidate rows are
//   the authoritative list and the builtin contributes nothing (a future
//   additive `resolver` column is the recorded option if mid-list explicit
//   positioning is ever needed).
//
// SECURITY:
//   * The livetv_* tables are fail-closed admin-only (RLS). The public
//     endpoints call this module with the SERVICE-ROLE client (the
//     established /api/downloader/mavero precedent for public reads of
//     admin-governed config) and return ONLY the bounded wire projection
//     below — never config jsonb, capabilities, slugs, source ids, labels
//     beyond the endpoint label, or any signed/fresh material.
//   * Every candidate URL is re-validated https+absolute here (fail-closed:
//     a non-https stored endpoint is SKIPPED, never returned) — the registry
//     validators already enforce this at write time; this is defense in
//     depth for the playback surface.
//   * The flag read fails CLOSED to false on any error — the client then
//     runs the untouched legacy path. False is always the safe direction.
//   * NO fetching happens in this module (pure DB reads + pure ordering).
//     Playback stays browser-direct (no proxy is created or needed).
//
// ISOLATION: shares no types with VOD `PlayerSource` shapes; the existing
// LiveGT client, the direct-playback engine and the embed fallback are NOT
// re-implemented or imported here — the wire's `engine` field is DERIVED by
// the Phase 1 registry (`playbackEngineForEndpoint`) and is consumed by the
// client router to pick between the two EXISTING playback mechanisms.
// ============================================================================

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '$lib/server/supabase/database.types';
import {
        LIVETV_ENDPOINT_KINDS,
        LIVETV_PLAYBACK_ELIGIBLE_STATUSES,
        LIVETV_SOURCE_STATUSES,
        LIVETV_SOURCE_TYPES,
        LIVETV_STREAM_FORMATS,
        buildDirectLivetvEntryOrder,
        type LivetvCandidateRecord,
        type LivetvEndpointRef,
        type LivetvEndpointKind,
        type LivetvSourceRef,
        type LivetvSourceChannelRef,
        type LivetvSourceStatus,
        type LivetvSourceType,
        type LivetvStreamFormat,
        type LivetvDefaultOrderInput
} from './registry';
import { resolveLivetvPlaybackOrder } from './registry';

// ---------------------------------------------------------------------------
// Wire contract (the ONLY data that ever crosses to the client router).
// ---------------------------------------------------------------------------

/** The direct playback engine string — mirrors registry LIVETV_PLAYBACK_ENGINES. */
export type LivetvWireEngine = 'shaka_media_player' | 'iframe_embed';

/** One playback candidate on the wire — bounded, redacted, display-safe. */
export type LivetvPlaybackCandidateWire = {
        /** Stable attempt key (registry row id, `default:<endpointId>` or a virtual id). */
        candidateId: string;
        /** DERIVED from the endpoint kind by the Phase 1 registry — never configured. */
        engine: LivetvWireEngine;
        endpointKind: LivetvEndpointKind;
        streamFormat: LivetvStreamFormat | null;
        /**
         * The CONFIG endpoint URL (https, validated again here). null for the
         * synthesized builtin candidates — their playback material is produced
         * at play time by the EXISTING client modules (fresh-signed direct
         * resolution / the documented embed URL builder). Never a signed URL.
         */
        url: string | null;
        /** Set ONLY for the synthesized builtin pair — the approved adapter contract. */
        resolver: 'builtin_livegt_v1' | null;
        /** The builtin entry's source channel id (a public catalogue id) for resolver candidates. */
        sourceChannelId: string | null;
        /** Optional human label from the endpoint row (display-only). */
        label: string | null;
};

export type LivetvPlaybackResolutionWire = {
        unifiedEnabled: boolean;
        /**
         * true  → the selection IS under unified management (candidates are
         *         authoritative, possibly empty = honest "nothing eligible").
         * false → nothing is configured for this selection: the client runs
         *         the documented legacy compatibility path for it.
         */
        resolved: boolean;
        mode: 'explicit' | 'default' | null;
        candidates: LivetvPlaybackCandidateWire[];
};

/** Hard cap on candidates returned (bounded response regardless of config size). */
export const MAX_PLAYBACK_CANDIDATES = 12;

/** Bounded read guards (a single channel realistically has a handful of rows). */
const MAX_ENTRIES_PER_CHANNEL = 200;
const MAX_ENDPOINTS_PER_LOAD = 400;
const MAX_CANDIDATE_ROWS_PER_CHANNEL = 200;

// ---------------------------------------------------------------------------
// Flag read (unified_enabled) — cached, fail-closed.
// ---------------------------------------------------------------------------

const FLAG_CACHE_TTL_MS = 30_000;
let flagCache: { value: boolean; expiresAt: number } | null = null;

/** Test seam — clears the module-level flag cache. */
export function resetLivetvPlaybackFlagCacheForTests(): void {
        flagCache = null;
}

/**
 * Read `livetv_config_meta.unified_enabled` (row id 1). Fail-closed: ANY
 * error (missing table, RLS surprise, network) resolves to FALSE so the
 * client always falls back to the untouched legacy path. Cached 30s — the
 * flag is the owner's rollback lever, not a hot value.
 */
export async function isUnifiedLivetvEnabled(client: SupabaseClient<Database>, now = Date.now()): Promise<boolean> {
        if (flagCache && flagCache.expiresAt > now) return flagCache.value;
        let value = false;
        try {
                const { data, error } = await client
                        .from('livetv_config_meta')
                        .select('unified_enabled')
                        .eq('id', 1)
                        .limit(1)
                        .maybeSingle();
                // A missing row (data === null) means "never configured" → false.
                if (!error && data && typeof data.unified_enabled === 'boolean') value = data.unified_enabled;
        } catch {
                value = false;
        }
        flagCache = { value, expiresAt: now + FLAG_CACHE_TTL_MS };
        return value;
}

// ---------------------------------------------------------------------------
// Row → registry-ref mapping (explicit, one-directional, narrowing).
// The generated Database types carry plain `string` for the CHECK-constrained
// vocabularies — every value is narrowed against the registry's closed sets
// and anything invalid is dropped (fail-closed), never coerced.
// ---------------------------------------------------------------------------

function narrowSourceType(value: string): LivetvSourceType | null {
        return (LIVETV_SOURCE_TYPES as readonly string[]).includes(value) ? (value as LivetvSourceType) : null;
}

function narrowSourceStatus(value: string): LivetvSourceStatus | null {
        return (LIVETV_SOURCE_STATUSES as readonly string[]).includes(value) ? (value as LivetvSourceStatus) : null;
}

function narrowEndpointKind(value: string): LivetvEndpointKind | null {
        return (LIVETV_ENDPOINT_KINDS as readonly string[]).includes(value) ? (value as LivetvEndpointKind) : null;
}

function narrowStreamFormat(value: string | null): LivetvStreamFormat | null {
        if (value === null) return null;
        return (LIVETV_STREAM_FORMATS as readonly string[]).includes(value) ? (value as LivetvStreamFormat) : null;
}

/** https + absolute + bounded length — the playback-surface re-validation. */
function isSafePlaybackUrl(value: string): boolean {
        if (typeof value !== 'string' || value.length === 0 || value.length > 2048) return false;
        try {
                const parsed = new URL(value);
                return parsed.protocol === 'https:';
        } catch {
                return false;
        }
}

type SourceRow = Database['public']['Tables']['livetv_sources']['Row'];
type ChannelRow = Database['public']['Tables']['livetv_channels']['Row'];
type SourceChannelRow = Database['public']['Tables']['livetv_source_channels']['Row'];
type EndpointRow = Database['public']['Tables']['livetv_playback_endpoints']['Row'];
type CandidateRow = Database['public']['Tables']['livetv_playback_candidates']['Row'];

function toSourceRef(row: SourceRow): LivetvSourceRef | null {
        const sourceType = narrowSourceType(row.source_type);
        const status = narrowSourceStatus(row.status);
        if (!sourceType || !status) return null;
        return {
                id: row.id,
                slug: row.slug,
                sourceType,
                enabled: row.enabled === true,
                status,
                priority: typeof row.priority === 'number' && Number.isFinite(row.priority) ? row.priority : 0
        };
}

function toSourceChannelRef(row: SourceChannelRow): LivetvSourceChannelRef {
        return {
                id: row.id,
                sourceId: row.source_id,
                sourceChannelId: row.source_channel_id,
                canonicalChannelId: row.canonical_channel_id ?? null,
                enabled: row.enabled === true
        };
}

/**
 * Map one endpoint row to its registry ref. Returns null when the row is
 * unusable for playback: unknown kind/format vocabulary, or a URL that fails
 * the https re-validation (a broken config row must never reach the player).
 */
function toEndpointRef(row: EndpointRow): LivetvEndpointRef | null {
        const kind = narrowEndpointKind(row.endpoint_kind);
        if (!kind) return null;
        const streamFormat = narrowStreamFormat(row.stream_format ?? null);
        if (!isSafePlaybackUrl(row.url)) return null;
        return {
                id: row.id,
                sourceChannelId: row.source_channel_id,
                kind,
                streamFormat,
                url: row.url,
                ordering: typeof row.ordering === 'number' && Number.isFinite(row.ordering) ? row.ordering : 0,
                enabled: row.enabled === true,
                label: row.label ?? null
        };
}

// ---------------------------------------------------------------------------
// Builtin synthesis — the virtual endpoint pair for a mapped builtin entry.
// ---------------------------------------------------------------------------

const BUILTIN_SOURCE_TYPE = 'builtin_livegt_v1';
/** Virtual endpoint ids carry the `virtual:` prefix — never real row ids. */
const VIRTUAL_ID_PREFIX = 'virtual:';

/**
 * R-0 — the direct ENTRY selection identity: `entry:<entry-row-uuid>`.
 * Emitted by the unified catalogue for UNMAPPED entries (safe source-entry
 * selection); resolved below WITHOUT touching the canonical mapping model.
 */
const ENTRY_SELECTION_PREFIX = 'entry:';
const ENTRY_ROW_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type VirtualPair = { direct: LivetvEndpointRef; embed: LivetvEndpointRef };

function buildBuiltinVirtualEndpoints(entry: LivetvSourceChannelRef): VirtualPair {
        // `url` is a required registry field; virtual endpoints carry an empty
        // string that NEVER reaches the wire (the wire mapping replaces these
        // two candidates with the resolver marker + null url). The entry's
        // enablement is the endpoint enablement (M1 covers the entry gate).
        return {
                direct: {
                        id: `${VIRTUAL_ID_PREFIX}${entry.id}:direct`,
                        sourceChannelId: entry.id,
                        kind: 'direct_stream',
                        streamFormat: 'dash',
                        url: '',
                        ordering: 0,
                        enabled: entry.enabled,
                        // The label is deliberately null: nothing synthetic is displayed.
                        label: null
                },
                embed: {
                        id: `${VIRTUAL_ID_PREFIX}${entry.id}:embed`,
                        sourceChannelId: entry.id,
                        kind: 'embed_page',
                        streamFormat: null,
                        url: '',
                        ordering: 1,
                        enabled: entry.enabled,
                        label: null
                }
        };
}

// ---------------------------------------------------------------------------
// Resolution.
// ---------------------------------------------------------------------------

/** Shape of the never-resolvable response (flag off / nothing configured). */
function unresolvedWire(unifiedEnabled: boolean): LivetvPlaybackResolutionWire {
        return { unifiedEnabled, resolved: false, mode: null, candidates: [] };
}

/**
 * Resolve the ordered, eligible playback candidates for one selected channel.
 *
 * `selectionId` is the channel identity the user selected. TWO identities
 * are accepted (Phase 6, additive — the mapping model itself is unchanged):
 *   (a) the builtin source's mapped entry source-channel id (the Phase 5
 *       LiveGT-catalogue selection — behavior byte-identical), or
 *   (b) the canonical channel id itself (the Phase 6 unified-catalogue
 *       selection).
 * The conservative Phase 1 mapping model is preserved: an entry that exists
 * but is UNMAPPED (M0) is NOT under unified management, and an id matching
 * NEITHER identity resolves `resolved:false` (the client's documented
 * legacy compatibility path — never a fake candidate list).
 */
/**
 * R-0 — direct ENTRY resolution (identity (c): `entry:<entry-row-uuid>`).
 *
 * Resolves ONE selected source entry DIRECTLY — the safe source-entry path
 * that keeps UNMAPPED entries playable (the canonical path requires M0).
 * The gates are re-enforced here from the loaded rows, never trusted from
 * the catalogue:
 *
 *   * flag OFF        → handled by the caller (resolved:false) — unchanged.
 *   * source row      → enabled + playback-eligible status + `visibility
 *                       ='public'` (catalogue exposure parity — a direct
 *                       entry selection can never bypass visibility).
 *   * entry row       → enabled (M1).
 *   * endpoints       → for the builtin source, the SAME synthesized virtual
 *                       direct→embed pair as the canonical path (its entries
 *                       carry no endpoint rows by design); for every other
 *                       source the entry's OWN endpoint rows, https
 *                       re-validated (fail-closed), ordered by the registry's
 *                       pure `buildDirectLivetvEntryOrder` (S1/S2/M1/E1).
 *   * bounded         → ≤ MAX_PLAYBACK_CANDIDATES candidates, mode 'default'
 *                       (an unmapped entry cannot have explicit candidate
 *                       rows — those reference canonical channels).
 *
 * Fail-closed: an unknown/garbage/blocked selection resolves `resolved:false`
 * (the client's documented legacy compatibility path) — never a fake
 * candidate list, never an error surface.
 */
async function resolveLivetvDirectEntry(client: SupabaseClient<Database>, entryRowId: string, unifiedEnabled: boolean): Promise<LivetvPlaybackResolutionWire> {
        // R-4 — for an `entry:<uuid>` selection, the resolver is the
        // AUTHORITY (the legacy LiveGT API doesn't recognize entry: ids).
        // A missing/disabled entry or source returns `resolved: true` with
        // an EMPTY candidate list (the honest "nothing eligible" answer),
        // NEVER `resolved: false` (which would make the client fall through
        // to the legacy path → "Live TV rejected the request").
        const emptyResolved = { unifiedEnabled: true, resolved: true, mode: 'default' as const, candidates: [] };

        // 1. The entry row (by its PRIMARY KEY — the catalogue emits exactly this id).
        const entryResult = await client
                .from('livetv_source_channels')
                .select('id,source_id,source_channel_id,canonical_channel_id,enabled')
                .eq('id', entryRowId)
                .limit(1)
                .maybeSingle();
        if (entryResult.error) return emptyResolved;
        const entryRow = entryResult.data as SourceChannelRow | null;
        if (!entryRow) return emptyResolved;
        const entryRef = toSourceChannelRef(entryRow);

        // 2. The entry's source row — the full gate context, visibility included.
        const sourceResult = await client
                .from('livetv_sources')
                .select('id,slug,name,source_type,builtin,enabled,status,priority,visibility,capabilities,config,description')
                .eq('id', entryRow.source_id)
                .limit(1)
                .maybeSingle();
        if (sourceResult.error) return emptyResolved;
        const sourceRow = sourceResult.data as SourceRow | null;
        if (!sourceRow) return emptyResolved;
        const sourceRef = toSourceRef(sourceRow);
        if (!sourceRef) return emptyResolved;
        // Catalogue exposure parity: only PUBLIC sources' entries were
        // surfaced. A selection must not resolve past a visibility change —
        // but it also must never fall to the legacy path (a registry-governed
        // entry id means nothing to the legacy client), so this is the honest
        // managed-empty answer, matching the disabled-source/entry gates.
        const visibilityEligible = sourceRow.visibility === 'public';

        // 3. The entry's endpoints: the builtin's synthesized pair, or its own rows.
        const isBuiltin = sourceRow.source_type === BUILTIN_SOURCE_TYPE && sourceRow.builtin === true;
        const endpoints: LivetvEndpointRef[] = [];
        if (isBuiltin) {
                const pair = buildBuiltinVirtualEndpoints(entryRef);
                endpoints.push(pair.direct, pair.embed);
        } else {
                const endpointsResult = await client
                        .from('livetv_playback_endpoints')
                        .select('id,source_channel_id,endpoint_kind,stream_format,url,ordering,enabled,label')
                        .eq('source_channel_id', entryRow.id)
                        .limit(MAX_ENDPOINTS_PER_LOAD);
                if (endpointsResult.error) return emptyResolved;
                for (const row of (endpointsResult.data ?? []) as EndpointRow[]) {
                        const ref = toEndpointRef(row);
                        if (ref) endpoints.push(ref);
                }
        }

        // 4. The PURE registry ordering (S1/S2/M1/E1 — a disabled source or
        //    entry, or a visibility-lost selection, contributes an EMPTY
        //    managed list, never an error and never a legacy fallback).
        const ordered = visibilityEligible
                ? buildDirectLivetvEntryOrder({ source: sourceRef, entry: entryRef, endpoints })
                : [];

        // 5. Wire projection — virtual-aware, bounded, redacted.
        const candidates: LivetvPlaybackCandidateWire[] = [];
        for (const candidate of ordered) {
                if (candidates.length >= MAX_PLAYBACK_CANDIDATES) break;
                if (candidate.endpointId.startsWith(VIRTUAL_ID_PREFIX)) {
                        candidates.push({
                                candidateId: candidate.candidateId,
                                engine: candidate.engine === 'iframe_embed' ? 'iframe_embed' : 'shaka_media_player',
                                endpointKind: candidate.endpointKind,
                                streamFormat: candidate.streamFormat,
                                url: null,
                                resolver: 'builtin_livegt_v1',
                                sourceChannelId: entryRow.source_channel_id,
                                label: null
                        });
                        continue;
                }
                candidates.push({
                        candidateId: candidate.candidateId,
                        engine: candidate.engine === 'iframe_embed' ? 'iframe_embed' : 'shaka_media_player',
                        endpointKind: candidate.endpointKind,
                        streamFormat: candidate.streamFormat,
                        url: candidate.endpointUrl,
                        resolver: null,
                        sourceChannelId: null,
                        label: candidate.endpointLabel
                });
        }
        return { unifiedEnabled: true, resolved: true, mode: 'default', candidates };
}

export async function resolveLivetvPlaybackForSelection(
        client: SupabaseClient<Database>,
        selectionId: string
): Promise<LivetvPlaybackResolutionWire> {
        const unifiedEnabled = await isUnifiedLivetvEnabled(client);

        // R-4 — SOURCE-FIRST playback for direct entry selections. An
        // `entry:<uuid>` identity is a REGISTRY-GOVERNED reference to a
        // specific `livetv_source_channels` row. It is NOT a LiveGT V1
        // channel id — the legacy LiveGT API does not recognize it (it
        // returns HTML 404 → "Live TV rejected the request"). The
        // `unified_enabled` flag is the owner's lever for the UNIFIED
        // PLAYBACK ROUTER (the LiveGT V1 canonical path + the builtin
        // virtual pair synthesis); it must NOT gate the resolution of a
        // playlist source's own endpoint rows. The source's own
        // enabled + eligible-status + visibility + entry-enabled gates
        // (re-enforced inside resolveLivetvDirectEntry) are the authority.
        //
        // This closes the R-3 regression where JioHotstar/Sony channels
        // (entry:<uuid>) were rejected with "Live TV rejected the request"
        // when unified_enabled was FALSE (production default): the resolver
        // returned unresolvedWire(false) → the page fell through to the
        // legacy LT-2 client → LiveGT V1 returned 404 for the entry id.
        if (selectionId.startsWith(ENTRY_SELECTION_PREFIX)) {
                const entryRowId = selectionId.slice(ENTRY_SELECTION_PREFIX.length);
                if (!ENTRY_ROW_ID_PATTERN.test(entryRowId)) return unresolvedWire(unifiedEnabled);
                return resolveLivetvDirectEntry(client, entryRowId, unifiedEnabled);
        }

        // The canonical path (mapped entries + the builtin virtual pair)
        // remains flag-gated — the flag is the owner's lever for the
        // unified playback router. A canonical selection with the flag OFF
        // resolves unresolvedWire(false) → the page's legacy fallback
        // handles it (the legacy LiveGT client recognizes canonical ids).
        if (!unifiedEnabled) return unresolvedWire(false);

        // 1. The builtin source row (seeded; builtin flag is the identity).
        const { data: builtinRow, error: builtinError } = await client
                .from('livetv_sources')
                .select('id,slug,name,source_type,builtin,enabled,status,priority,visibility,capabilities,config,description')
                .eq('source_type', BUILTIN_SOURCE_TYPE)
                .eq('builtin', true)
                .limit(1)
                .maybeSingle();
        if (builtinError || !builtinRow) return unresolvedWire(unifiedEnabled);

        // 2. The builtin entry for the selection — must be MAPPED to a
        //    canonical channel (M0). Unmapped selections are NOT under
        //    unified management → legacy compatibility path client-side.
        const { data: entryRow, error: entryError } = await client
                .from('livetv_source_channels')
                .select('id,source_id,source_channel_id,canonical_channel_id,enabled')
                .eq('source_id', builtinRow.id)
                .eq('source_channel_id', selectionId)
                .limit(1)
                .maybeSingle();
        if (entryError) return unresolvedWire(unifiedEnabled);
        if (entryRow && !entryRow.canonical_channel_id) return unresolvedWire(unifiedEnabled);

        // 3. The canonical channel (FK guarantees existence; a missing row is
        //    treated as not-managed → legacy path, never a fake error).
        //    Phase 6: when the selection did NOT match a builtin entry, it is
        //    accepted as the CANONICAL channel id itself (the unified
        //    catalogue's stable id). An id matching neither identity (no
        //    entry, no channel row) resolves `resolved:false` — unchanged.
        let channelId: string;
        if (entryRow && entryRow.canonical_channel_id) {
                channelId = entryRow.canonical_channel_id;
        } else {
                channelId = selectionId;
        }
        const { data: channelRow, error: channelError } = await client
                .from('livetv_channels')
                .select('id,name,category,logo_url,dedup_key,enabled')
                .eq('id', channelId)
                .limit(1)
                .maybeSingle();
        if (channelError || !channelRow) return unresolvedWire(unifiedEnabled);

        // 4. Load the full candidate context for THIS canonical channel only.
        //    The channel's mapped entries load FIRST; the endpoints query is
        //    then scoped to exactly those entry ids — cross-channel endpoints
        //    are never even read (the DB trigger guards candidates; this
        //    guards endpoints the same way).
        const entriesResult = await client
                .from('livetv_source_channels')
                .select('id,source_id,source_channel_id,canonical_channel_id,enabled')
                .eq('canonical_channel_id', channelId)
                .limit(MAX_ENTRIES_PER_CHANNEL);
        if (entriesResult.error) return unresolvedWire(unifiedEnabled);
        const entryRows = (entriesResult.data ?? []) as SourceChannelRow[];

        const [sourcesResult, endpointsResult, candidatesResult] = await Promise.all([
                client
                        .from('livetv_sources')
                        .select('id,slug,name,source_type,builtin,enabled,status,priority,visibility,capabilities,config,description')
                        .order('priority')
                        .order('slug')
                        .limit(MAX_ENTRIES_PER_CHANNEL),
                client
                        .from('livetv_playback_endpoints')
                        .select('id,source_channel_id,endpoint_kind,stream_format,url,ordering,enabled,label')
                        .in(
                                'source_channel_id',
                                // Scoped to THIS channel's entries — cross-channel
                                // endpoints are never even read (the DB trigger guards
                                // candidates; this guards endpoints the same way).
                                entryRows.map((entry) => entry.id)
                        )
                        .limit(MAX_ENDPOINTS_PER_LOAD),
                client
                        .from('livetv_playback_candidates')
                        .select('id,channel_id,endpoint_id,priority,enabled,created_at')
                        .eq('channel_id', channelId)
                        .limit(MAX_CANDIDATE_ROWS_PER_CHANNEL)
        ]);
        const firstError = sourcesResult.error ?? endpointsResult.error ?? candidatesResult.error;
        if (firstError) {
                // A read failure is a failure — fail-closed to the legacy path
                // (resolved:false) rather than an empty "managed" answer.
                return unresolvedWire(unifiedEnabled);
        }

        const sourceRows = (sourcesResult.data ?? []) as SourceRow[];
        const endpointRows = (endpointsResult.data ?? []) as EndpointRow[];
        const candidateRows = (candidatesResult.data ?? []) as CandidateRow[];

        // Narrow everything; unusable rows are dropped (fail-closed).
        const sources: LivetvSourceRef[] = [];
        for (const row of sourceRows) {
                const ref = toSourceRef(row);
                if (ref) sources.push(ref);
        }
        const sourceChannels: LivetvSourceChannelRef[] = entryRows.map(toSourceChannelRef);
        const endpoints: LivetvEndpointRef[] = [];
        for (const row of endpointRows) {
                const ref = toEndpointRef(row);
                if (ref) endpoints.push(ref);
        }

        // Explicit-mode records: join each candidate row with its endpoint,
        // entry and source (all DB-guaranteed FKs; a dangling join drops the
        // candidate defensively).
        const endpointById = new Map(endpoints.map((endpoint) => [endpoint.id, endpoint]));
        const entryById = new Map(sourceChannels.map((entry) => [entry.id, entry]));
        const sourceById = new Map(sources.map((source) => [source.id, source]));
        const explicitRecords: LivetvCandidateRecord[] = [];
        for (const row of candidateRows) {
                if (row.channel_id !== channelId) continue; // cross-channel guard (defense in depth)
                const endpoint = endpointById.get(row.endpoint_id);
                if (!endpoint) continue;
                const entry = entryById.get(endpoint.sourceChannelId);
                if (!entry) continue;
                const source = sourceById.get(entry.sourceId);
                if (!source) continue;
                explicitRecords.push({
                        candidate: {
                                rowId: row.id,
                                channelId: row.channel_id,
                                endpointId: row.endpoint_id,
                                priority: typeof row.priority === 'number' && Number.isFinite(row.priority) ? row.priority : 0,
                                enabled: row.enabled === true,
                                createdAt: typeof row.created_at === 'string' ? row.created_at : ''
                        },
                        endpoint,
                        sourceChannel: entry,
                        source,
                        channelEnabled: channelRow.enabled === true
                });
        }

        // Default-mode inputs: the registry derives the order from source
        // priorities. The builtin's virtual pair is injected ONLY in default
        // mode (explicit rows are authoritative and cannot reference it).
        // The entry feeding the pair is the selection-matched builtin entry
        // when the selection came through it (Phase 5 — byte-identical),
        // otherwise the channel's mapped builtin entry with the smallest
        // source_channel_id (deterministic; Phase 6 canonical selections).
        type SelectionEntryRow = {
                id: string;
                source_id: string;
                source_channel_id: string;
                canonical_channel_id: string | null;
                enabled: boolean;
        };
        let builtinEntryForPair: SelectionEntryRow | null = entryRow ?? null;
        if (!builtinEntryForPair) {
                for (const row of entryRows) {
                        if (row.source_id !== builtinRow.id) continue;
                        if (row.canonical_channel_id !== channelId) continue;
                        if (builtinEntryForPair === null || row.source_channel_id < builtinEntryForPair.source_channel_id) {
                                builtinEntryForPair = row;
                        }
                }
        }
        const mutableEndpoints: LivetvEndpointRef[] = [...endpoints];
        if (explicitRecords.length === 0) {
                const builtinSource = sources.find((source) => source.id === builtinRow.id);
                const builtinEntry = builtinEntryForPair ? sourceChannels.find((entry) => entry.id === builtinEntryForPair.id) : undefined;
                const builtinEligible =
                        builtinSource !== undefined &&
                        LIVETV_PLAYBACK_ELIGIBLE_STATUSES.has(builtinSource.status) &&
                        builtinSource.enabled;
                if (builtinEligible && builtinEntry) {
                        const pair = buildBuiltinVirtualEndpoints(builtinEntry);
                        mutableEndpoints.push(pair.direct, pair.embed);
                }
        }
        const defaults: LivetvDefaultOrderInput = { channelEnabled: channelRow.enabled === true, sources, sourceChannels, endpoints: mutableEndpoints };

        // 5. The PURE Phase 1 resolution (gates + ordering + engine derivation).
        const resolution = resolveLivetvPlaybackOrder({ channelId, explicitRecords, defaults });

        // 6. Wire projection — bounded, redacted, virtual-aware.
        // The virtual builtin pair's `sourceChannelId` is the builtin ENTRY's
        // source channel id (the public LiveGT catalogue id the EXISTING
        // client modules resolve/build with). In the Phase 5 entry-selection
        // flow that IS the selectionId; for Phase 6 canonical selections it
        // is the mapped entry's id — never the canonical UUID.
        const virtualSourceChannelId = builtinEntryForPair ? builtinEntryForPair.source_channel_id : selectionId;
        const candidates: LivetvPlaybackCandidateWire[] = [];
        for (const candidate of resolution.candidates) {
                if (candidates.length >= MAX_PLAYBACK_CANDIDATES) break;
                if (candidate.endpointId.startsWith(VIRTUAL_ID_PREFIX)) {
                        // The synthesized builtin pair: resolver marker + the public
                        // catalogue id; NO url ever crosses (playback material is
                        // produced by the EXISTING client modules at play time).
                        candidates.push({
                                candidateId: candidate.candidateId,
                                engine: candidate.engine === 'iframe_embed' ? 'iframe_embed' : 'shaka_media_player',
                                endpointKind: candidate.endpointKind,
                                streamFormat: candidate.streamFormat,
                                url: null,
                                resolver: 'builtin_livegt_v1',
                                sourceChannelId: virtualSourceChannelId,
                                label: null
                        });
                        continue;
                }
                candidates.push({
                        candidateId: candidate.candidateId,
                        engine: candidate.engine === 'iframe_embed' ? 'iframe_embed' : 'shaka_media_player',
                        endpointKind: candidate.endpointKind,
                        streamFormat: candidate.streamFormat,
                        // The registry ref already passed the https re-validation.
                        url: candidate.endpointUrl,
                        resolver: null,
                        sourceChannelId: null,
                        label: candidate.endpointLabel
                });
        }

        return { unifiedEnabled: true, resolved: true, mode: resolution.mode, candidates };
}
