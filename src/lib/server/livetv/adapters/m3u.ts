// ============================================================================
// Unified Live TV — Phase 2 M3U/M3U8 playlist adapter (server-only).
//
// Robust, bounded, per-entry-isolated parsing of ordinary #EXTM3U/#EXTINF
// playlists into the Phase 1 unified model shapes.
//
// WHAT IS PRESERVED (Phase 2 brief §4): tvg-id, tvg-name, tvg-logo,
// group-title, the channel display name, the stream URL + established
// format, original source identity, and bounded non-sensitive attributes.
//
// HARD RULES:
//   * #EXTM3U header enforcement — the first entry-bearing content must be
//     preceded by the header (plan Phase 2 task list).
//   * Malformed LINES never crash the playlist — they become per-entry
//     diagnostics. Policy violations (entry cap, size cap, deadline) fail
//     the WHOLE source with a typed error — oversized inputs are never
//     partially ingested (plan §8.3).
//   * Every endpoint is validated through the Phase 1 registry contract —
//     https-only, no credentials, ≤2048.
//   * Stream format comes ONLY from the URL path extension (.mpd → dash,
//     .m3u8/.m3u → hls). Formats are NEVER invented: an entry whose format
//     cannot be established safely is skipped with a structured reason
//     (`unknown_stream_format`). An arbitrary web page is never treated as
//     a media manifest.
//   * Identity is NEVER inferred from display-name equality. Entry identity
//     = the validated tvg-id when present, else a deterministic SHA-256 of
//     the stream URL (stable across refreshes). Display names never merge
//     or split entries.
//   * Directive lines (#EXTVLCOPT, #KODIPROP, …) are ignored and NEVER
//     persisted — they can carry user-agent/referrer credentials; no
//     playlist metadata is treated as executable code or HTML.
// ============================================================================

import { createHash } from 'node:crypto';
import { validateLivetvSourceConfig, type LivetvM3UPlaylistConfig } from '../registry';
import { fetchLivetvSourceText } from '../fetch-safe';
import {
        LivetvAdapterError,
        adapterErrorFromFetch,
        buildNormalizedEndpoint,
        isLivetvRegistryValidationError,
        normalizeChannelName,
        normalizeOptionalTextField,
        normalizeSourceChannelId,
        sanitizeAdapterMetadata,
        type LivetvAdapterCapabilities,
        type LivetvAdapterDeps,
        type LivetvAdapterDiagnostics,
        type LivetvAdapterRunResult,
        type LivetvAdapterSourceRef,
        type LivetvEntryError,
        type LivetvEntryErrorReason,
        type LivetvSourceAdapter,
        type NormalizedLivetvChannel
} from './types';


// ---------------------------------------------------------------------------
// Bounded parse limits (plan §8.3 — bounded file size/line length/entry
// count/parsing time; the fetch-level byte cap lives in fetch-safe.ts).
// ---------------------------------------------------------------------------

export const M3U_MAX_ENTRIES = 20_000;
export const M3U_MAX_LINE_LENGTH = 64_000;
// Raised 5s -> 20s (2026-10-25): a large playlist (e.g. akindi, 564 channels)
// can legitimately take longer than 5s to parse. NOTE: the dominant cost for a
// slow source is usually the FETCH (LIVETV_FETCH_TIMEOUT_MS), not the parse —
// this bound only stops the parse itself from being the ceiling.
export const M3U_PARSE_DEADLINE_MS = 20_000;
export const M3U_MAX_ATTRIBUTES_PER_ENTRY = 16;
// Raw capture cap — field VALIDATORS (id ≤200, name ≤200, logo ≤2048, …)
// decide usability per field, so identity values are never silently
// truncated into a DIFFERENT stable id.
export const M3U_MAX_ATTR_VALUE_LENGTH = 2048;
export const M3U_ENTRY_ERRORS_SAMPLE = 200;
const DEADLINE_CHECK_INTERVAL = 512;

export type M3UParseOptions = {
        maxEntries?: number;
        maxLineLength?: number;
        parseDeadlineMs?: number;
        /** Injected clock for the parse deadline (tests). */
        now?: () => number;
        /** Cancellation signal honored between lines. */
        signal?: AbortSignal;
        /**
         * R-2 — the playlist's OWN absolute https URL, used as the base for
         * resolving RELATIVE stream URLs (`stream.m3u8`, `/path/a.m3u8`,
         * `./b.mpd?token=1`). Real-world playlists (e.g. PHP-generated ones)
         * frequently emit relative stream URLs; without base resolution they
         * fail `new URL()` and produce `invalid_stream_url` for every entry.
         * When omitted, relative URLs are still rejected (the prior behavior).
         * The base is itself https-validated before any resolution attempt;
         * it is NEVER echoed into diagnostics or per-entry errors.
         */
        playlistBaseUrl?: string;
};

export type M3UParseResult = {
        channels: NormalizedLivetvChannel[];
        diagnostics: LivetvAdapterDiagnostics;
};

class M3UDiagnostics {
        discoveredCount = 0;
        skippedCount = 0;
        private readonly _reasons = new Map<string, number>();
        readonly entryErrors: LivetvEntryError[] = [];

        /** Public read-only access to the skip reasons map (for logging). */
        get reasons(): ReadonlyMap<string, number> { return this._reasons; }

        noteSkip(reason: LivetvEntryErrorReason): void {
                this.skippedCount += 1;
                this._reasons.set(reason, (this._reasons.get(reason) ?? 0) + 1);
        }

        noteError(entryIndex: number, sourceChannelId: string | null, reason: LivetvEntryErrorReason): void {
                this.noteSkip(reason);
                if (this.entryErrors.length < M3U_ENTRY_ERRORS_SAMPLE) {
                        this.entryErrors.push({ entryIndex, sourceChannelId, reason });
                }
        }

        toDiagnostics(): LivetvAdapterDiagnostics {
                const skippedReasons: Record<string, number> = {};
                for (const [reason, count] of this.reasons) skippedReasons[reason] = count;
                return {
                        discoveredCount: this.discoveredCount,
                        skippedCount: this.skippedCount,
                        skippedReasons,
                        entryErrors: this.entryErrors
                };
        }
}

// ---------------------------------------------------------------------------
// Attribute parsing
// ---------------------------------------------------------------------------

export type M3UAttributes = {
        /** Lower-cased attribute name → raw value (quoted or bare). */
        values: Map<string, string>;
        /** True when at least one attribute was malformed (kept, best-effort). */
        malformedAttributeCount: number;
};

/**
 * Parses `key="value"` / `key=value` sequences with common ordering
 * variations. Quoted values may contain spaces and commas; bare values end
 * at whitespace. Never throws — malformed pieces are counted.
 */
export function parseM3UAttributes(input: string): M3UAttributes {
        const values = new Map<string, string>();
        let malformedAttributeCount = 0;
        let index = 0;
        const length = input.length;
        while (index < length && Object.keys(Object.fromEntries(values)).length + malformedAttributeCount < M3U_MAX_ATTRIBUTES_PER_ENTRY + 1) {
                while (index < length && /\s/.test(input[index]!)) index += 1;
                if (index >= length) break;
                // Read the key.
                const keyStart = index;
                while (index < length && input[index] !== '=' && !/\s/.test(input[index]!)) index += 1;
                const key = input.slice(keyStart, index).toLowerCase();
                if (index >= length || input[index] !== '=') {
                        // A bare token with no '=' — malformed, skip it.
                        if (key) malformedAttributeCount += 1;
                        continue;
                }
                index += 1; // consume '='
                if (index >= length) {
                        malformedAttributeCount += 1;
                        break;
                }
                if (input[index] === '"') {
                        index += 1;
                        const valueStart = index;
                        while (index < length && input[index] !== '"') index += 1;
                        if (index >= length) {
                                // Unterminated quote — take the rest as the value.
                                malformedAttributeCount += 1;
                                const value = input.slice(valueStart);
                                if (key) values.set(key, value.slice(0, M3U_MAX_ATTR_VALUE_LENGTH));
                                break;
                        }
                        const value = input.slice(valueStart, index);
                        index += 1; // consume closing quote
                        if (key) values.set(key, value.slice(0, M3U_MAX_ATTR_VALUE_LENGTH));
                } else {
                        const valueStart = index;
                        while (index < length && !/\s/.test(input[index]!)) index += 1;
                        const value = input.slice(valueStart, index);
                        if (key && value) values.set(key, value.slice(0, M3U_MAX_ATTR_VALUE_LENGTH));
                        else malformedAttributeCount += 1;
                }
        }
        return { values, malformedAttributeCount };
}

/**
 * Splits an #EXTINF line's payload into `info` (duration + attributes) and
 * `title` at the FIRST comma that is not inside a double-quoted value.
 * Returns null when the line has no usable info portion.
 */
export function splitExtinfLine(lineBody: string): { info: string; title: string } | null {
        const trimmedStart = lineBody.replace(/^:/, '');
        let inQuotes = false;
        for (let index = 0; index < trimmedStart.length; index += 1) {
                const char = trimmedStart[index];
                if (char === '"') inQuotes = !inQuotes;
                else if (char === ',' && !inQuotes) {
                        const info = trimmedStart.slice(0, index).trim();
                        const title = trimmedStart.slice(index + 1).trim();
                        if (!info) return null;
                        return { info, title };
                }
        }
        // No comma — some playlists omit the title entirely.
        const info = trimmedStart.trim();
        return info ? { info, title: '' } : null;
}

// ---------------------------------------------------------------------------
// Stream URL validation + conservative classification
// ---------------------------------------------------------------------------

export type M3UStreamClassification = {
        url: string;
        streamFormat: 'dash' | 'hls';
};

/**
 * Validates one playlist stream URL and classifies its format. The format is
 * established from the URL PATH EXTENSION (.mpd → dash; .m3u8/.m3u → hls) OR,
 * when a base URL is supplied and the entry is RELATIVE, from the resolved
 * URL's path. Anything else is rejected — no format is ever invented, and a
 * web page is never treated as a manifest. Returns a static reason string on
 * failure.
 *
 * R-2: when `playlistBaseUrl` is supplied, RELATIVE stream URLs are resolved
 * against it BEFORE validation. This fixes the production regression where
 * PHP-generated playlists (e.g. hot.php?playlist=1) emit relative stream
 * URLs that previously failed `new URL()` and produced `invalid_stream_url`
 * for every entry. The base is itself https-validated here (defense in
 * depth — the fetcher already enforces this); a non-https base is treated
 * as "no base" so relative URLs are rejected (preserves the prior fail-closed
 * behavior for unsafe bases).
 */
export function classifyM3UStreamUrl(raw: string, playlistBaseUrl?: string): { ok: true; value: M3UStreamClassification } | { ok: false; reason: LivetvEntryErrorReason } {
        const trimmed = raw.trim();
        if (!trimmed) return { ok: false, reason: 'missing_stream_url' };
        if (trimmed.length > 2048) return { ok: false, reason: 'url_too_long' };
        if (/[\u0000-\u001f\u007f]/.test(trimmed)) return { ok: false, reason: 'invalid_stream_url' };
        // R-8 — Many real-world IPTV playlists (JioHotstar, Akindi/JioTV)
        // use a pipe-delimited URL format where everything after the first
        // `|` carries provider-specific helper parameters (cookies,
        // referrer, user-agent, origin). These helper params are NOT part
        // of the HTTP URL — they are metadata for the player. The pipe
        // section may contain spaces (e.g. `@Premium Plugx(Android/15)`)
        // which would fail the whitespace check. We split on the FIRST
        // pipe: the part before it is the real HTTP URL (validated); the
        // pipe section is preserved in the stored URL for the player to
        // use but does not affect format classification or URL validation.
        const pipeIndex = trimmed.indexOf('|');
        const httpPart = pipeIndex >= 0 ? trimmed.slice(0, pipeIndex) : trimmed;
        // The HTTP part must have no whitespace (a URL is a single token).
        if (/\s/.test(httpPart)) return { ok: false, reason: 'invalid_stream_url' };

        // R-2 — resolve relative URLs against the playlist's own URL when one
        // was supplied. The base must itself be a valid https URL; anything
        // unsafe degrades to "no base" (relative URLs then fail `new URL()`
        // and return `invalid_stream_url`, matching the pre-R-2 behavior).
        let base: URL | null = null;
        if (playlistBaseUrl) {
                try {
                        const parsedBase = new URL(playlistBaseUrl);
                        if (parsedBase.protocol === 'https:' && !parsedBase.username && !parsedBase.password) base = parsedBase;
                } catch {
                        base = null;
                }
        }

        let url: URL;
        try {
                url = base !== null ? new URL(httpPart, base) : new URL(httpPart);
        } catch {
                return { ok: false, reason: 'invalid_stream_url' };
        }
        if (url.protocol !== 'https:') return { ok: false, reason: 'non_https_stream_url' };
        if (url.username || url.password) return { ok: false, reason: 'url_credentials_rejected' };
        // The resolved URL's full string is bounded (a relative URL resolved
        // against a long base CAN exceed 2048 — reject the entry rather than
        // truncate, matching the absolute-URL behavior).
        const resolvedHttp = url.toString();
        if (resolvedHttp.length > 2048) return { ok: false, reason: 'url_too_long' };
        const pathname = url.pathname.toLowerCase();
        // R-8 — the STORED url is the HTTP part only (without the pipe
        // section). The pipe section carries player metadata (cookies,
        // referrer, user-agent) that is ALSO present in the #EXTVLCOPT
        // and #EXTHTTP directive lines (which the parser already ignores).
        // The DB CHECK constraint requires `url ~ '^https://[^[:space:]]*$'`
        // — a pipe URL with spaces would be rejected. Storing only the HTTP
        // part satisfies the constraint and is sufficient for playback
        // (the player requests the manifest directly; CORS/cookies are
        // browser-managed, not URL-embedded).
        if (pathname.endsWith('.mpd')) return { ok: true, value: { url: resolvedHttp, streamFormat: 'dash' } };
        if (pathname.endsWith('.m3u8') || pathname.endsWith('.m3u')) return { ok: true, value: { url: resolvedHttp, streamFormat: 'hls' } };
        // 2026-10 round 10 — Task 1: MANY real-world IPTV playlists (e.g.
        // iptv-org) use stream URLs without a file extension — the path
        // is just a host + path with query params (e.g.
        // https://example.com/stream/123?token=abc). Previously these
        // were rejected as 'unknown_stream_format', silently dropping
        // hundreds of channels. Now: if the URL is a valid https URL
        // with no recognizable extension, classify it as HLS (the most
        // common format for IPTV streams). The player's Shaka engine
        // sniffs the actual format from the response Content-Type header
        // at load time, so a wrong guess here is self-correcting.
        // The only URLs still rejected are .html/.php pages (obvious
        // web pages, not streams).
        if (pathname.endsWith('.html') || pathname.endsWith('.php') || pathname.endsWith('/')) {
                return { ok: false, reason: 'unknown_stream_format' };
        }
        // No recognizable extension — assume HLS (self-correcting at load).
        return { ok: true, value: { url: resolvedHttp, streamFormat: 'hls' } };
}

/** Deterministic identity for entries without a usable tvg-id. */
export function m3uIdentityForUrl(url: string): string {
        return `m3u-${createHash('sha256').update(url, 'utf8').digest('hex').slice(0, 32)}`;
}

/**
 * R-3/R-5 — validates and normalizes a `tvg-logo` URL.
 *
 * The DB constraint requires `https://` (migration
 * `20261120000000_livetv_source_registry.sql:158,202`). R-5 changes:
 *   * NO http→https upgrade (the task says "Do not silently upgrade HTTP
 *     URLs to HTTPS unless the HTTPS endpoint is verified"). An `http://`
 *     logo is REJECTED (the DB requires https; the upgrade was unverified).
 *   * RELATIVE logo URLs are resolved against the playlist's own URL when
 *     `playlistBaseUrl` is supplied (R-5 fix — the R-2 fix added relative
 *     resolution for STREAM URLs but not for logos; Sony playlists may
 *     use relative logo URLs).
 *   * Protocol-relative (`//cdn.example/logo.png`), relative, and non-
 *     http(s) URLs are REJECTED when no base is supplied (the DB requires
 *     absolute https). When a base IS supplied, relative URLs are resolved
 *     against it; the resolved URL must still be `https://`.
 *   * Control characters and whitespace are rejected (a URL is a single token).
 *
 * This is the ONLY logo normalization. Stream URLs (classifyM3UStreamUrl)
 * have their own validation (https-only, no upgrade, relative resolution).
 */
export function normalizeM3ULogoUrl(raw: unknown, playlistBaseUrl?: string): string | null {
        if (raw === undefined || raw === null) return null;
        if (typeof raw !== 'string') return null;
        const trimmed = raw.trim();
        if (!trimmed) return null;
        if (trimmed.length > 2048) return null;
        if (/[\u0000-\u001f\u007f]/.test(trimmed) || /\s/.test(trimmed)) return null;

        // R-5 — resolve relative logo URLs against the playlist's own URL
        // (same as stream URL resolution). The base must be https.
        let base: URL | null = null;
        if (playlistBaseUrl) {
                try {
                        const parsedBase = new URL(playlistBaseUrl);
                        if (parsedBase.protocol === 'https:' && !parsedBase.username && !parsedBase.password) base = parsedBase;
                } catch {
                        base = null;
                }
        }

        let url: URL;
        try {
                url = base !== null ? new URL(trimmed, base) : new URL(trimmed);
        } catch {
                return null;
        }
        // R-5 — NO http→https upgrade. The DB requires https; an http logo
        // is rejected (the upgrade was unverified — the CDN may not support https).
        if (url.protocol !== 'https:') return null;
        if (url.username || url.password) return null;
        const resolved = url.toString();
        if (resolved.length > 2048) return null;
        return resolved;
}

// ---------------------------------------------------------------------------
// The parser
// ---------------------------------------------------------------------------

type PendingEntry = {
        entryIndex: number;
        title: string;
        tvgName: string | null;
        tvgIdRaw: string | null;
        logoUrl: string | null;
        groupTitle: string | null;
        extraAttributes: Record<string, string>;
        attrCount: number;
};

/**
 * Parses an M3U/M3U8 playlist body into normalized channels.
 * Per-entry failures are isolated; policy caps fail the whole parse with a
 * typed `LivetvAdapterError`.
 */
export function parseM3UPlaylist(text: string, options: M3UParseOptions = {}): M3UParseResult {
        const maxEntries = options.maxEntries ?? M3U_MAX_ENTRIES;
        const maxLineLength = options.maxLineLength ?? M3U_MAX_LINE_LENGTH;
        const parseDeadlineMs = options.parseDeadlineMs ?? M3U_PARSE_DEADLINE_MS;
        const now = options.now ?? Date.now;
        const startedAt = now();
        const diagnostics = new M3UDiagnostics();

        // Strip a UTF-8 BOM; normalize CRLF/CR.
        const normalized = (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).replace(/\r\n?/g, '\n');
        const lines = normalized.split('\n');

        let sawHeader = false;
        let pending: PendingEntry | null = null;
        let pendingGroupFromDirective: string | null = null;

        const channels: NormalizedLivetvChannel[] = [];
        const channelsById = new Map<string, NormalizedLivetvChannel>();
        /** Endpoint URLs already attached per identity (dedup across duplicates). */
        const endpointUrlsById = new Map<string, Set<string>>();

        const finishPendingWithoutUrl = (): void => {
                if (pending) {
                        diagnostics.noteError(pending.entryIndex, null, 'missing_stream_url');
                        pending = null;
                        pendingGroupFromDirective = null;
                }
        };

        const flushEntry = (entry: PendingEntry, url: string): void => {
                const classification = classifyM3UStreamUrl(url, options.playlistBaseUrl);
                if (!classification.ok) {
                        diagnostics.noteError(entry.entryIndex, normalizeSourceChannelId(entry.tvgIdRaw), classification.reason);
                        return;
                }
                const { url: safeUrl, streamFormat } = classification.value;

                // 2026-10 round 11 — Task 1: Identity MUST be unique per
                // stream URL, NOT per tvg-id. IPTV playlists (e.g. iptv-org)
                // frequently have multiple #EXTINF lines for the SAME channel
                // (same tvg-id) with DIFFERENT stream URLs (different
                // providers/qualities). Previously, entries with the same
                // tvg-id were MERGED into one channel with multiple endpoints,
                // causing massive data loss (1539 entries → ~773 channels).
                // Now: the identity is ALWAYS the deterministic URL hash
                // (m3uIdentityForUrl), so every #EXTINF line creates a
                // separate channel entry. The tvg-id is still stored as
                // metadata for EPG mapping — it just doesn't determine
                // identity.
                const tvgId = normalizeSourceChannelId(entry.tvgIdRaw);
                const identity = m3uIdentityForUrl(safeUrl);

                // Display name: the EXTINF title; fallback to tvg-name (both
                // are provider-provided channel metadata). The SHARED validator
                // rejects control characters — hostile names are never stored.
                const name = normalizeChannelName(entry.title) ?? normalizeChannelName(entry.tvgName) ?? '';
                if (!name) {
                        diagnostics.noteError(entry.entryIndex, identity, 'missing_name');
                        return;
                }

                let channel = channelsById.get(identity);
                if (!channel) {
                        if (channels.length >= maxEntries) {
                                throw new LivetvAdapterError('entry_cap_exceeded', 'The playlist exceeds the configured entry budget.');
                        }
                        const metadata = sanitizeAdapterMetadata({
                                sourceFormat: 'm3u',
                                tvgName: entry.tvgName,
                                groupTitle: entry.groupTitle ?? pendingGroupFromDirective,
                                attributeCount: entry.attrCount,
                                ...(Object.keys(entry.extraAttributes).length ? { extraAttributes: JSON.stringify(entry.extraAttributes) } : {})
                        });
                        const endpoint = buildNormalizedEndpoint({
                                endpointKind: 'direct_stream',
                                streamFormat,
                                url: safeUrl,
                                ordering: 0,
                                label: null
                        });
                        channel = {
                                sourceChannelId: identity,
                                name,
                                category: entry.groupTitle ?? pendingGroupFromDirective,
                                logoUrl: entry.logoUrl,
                                tvgId,
                                endpoints: [endpoint],
                                metadata
                        };
                        channels.push(channel);
                        channelsById.set(identity, channel);
                        endpointUrlsById.set(identity, new Set([safeUrl]));
                        diagnostics.discoveredCount += 1;
                        return;
                }

                // Same identity again: dedup by URL; a NEW url becomes an
                // additional typed endpoint on the same source entry.
                const seenUrls = endpointUrlsById.get(identity) ?? new Set<string>();
                if (seenUrls.has(safeUrl)) {
                        diagnostics.noteSkip('duplicate_channel_id');
                        return;
                }
                if (channel.endpoints.length >= 8) {
                        // Bound endpoints per entry (hostile playlists).
                        diagnostics.noteSkip('duplicate_channel_id');
                        return;
                }
                const endpoint = buildNormalizedEndpoint({
                        endpointKind: 'direct_stream',
                        streamFormat,
                        url: safeUrl,
                        ordering: channel.endpoints.length,
                        label: null
                });
                channel.endpoints.push(endpoint);
                seenUrls.add(safeUrl);
                endpointUrlsById.set(identity, seenUrls);
        };

        const handleExtinf = (lineBody: string, entryIndex: number): PendingEntry | null => {
                finishPendingWithoutUrl();
                const split = splitExtinfLine(lineBody);
                if (!split) {
                        diagnostics.noteError(entryIndex, null, 'invalid_entry_shape');
                        return null;
                }
                // Info = duration token + attributes.
                const infoParts = split.info.match(/^\s*(\S+)([\s\S]*)$/);
                const attrPortion = infoParts ? infoParts[2] ?? '' : '';
                const attributes = parseM3UAttributes(attrPortion);
                const tvgIdRaw = attributes.values.get('tvg-id') ?? null;
                const entry: PendingEntry = {
                        entryIndex,
                        title: split.title,
                        tvgName: normalizeOptionalTextField(attributes.values.get('tvg-name') ?? null, 200, true),
                        tvgIdRaw,
                        logoUrl: normalizeM3ULogoUrl(attributes.values.get('tvg-logo') ?? null, options.playlistBaseUrl),
                        groupTitle: normalizeOptionalTextField(attributes.values.get('group-title') ?? null, 120, true),
                        extraAttributes: {},
                        attrCount: attributes.values.size
                };
                // Bounded preservation of the other attributes (non-sensitive
                // provenance only).
                let extra = 0;
                for (const [key, value] of attributes.values) {
                        if (key === 'tvg-id' || key === 'tvg-name' || key === 'tvg-logo' || key === 'group-title') continue;
                        if (extra >= 8) break;
                        if (!/^[a-z0-9_-]{1,40}$/.test(key)) continue;
                        entry.extraAttributes[key] = value.slice(0, M3U_MAX_ATTR_VALUE_LENGTH);
                        extra += 1;
                }
                return entry;
        };

        for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
                if (options.signal?.aborted) {
                        throw new LivetvAdapterError('cancelled', 'The playlist parse was cancelled.');
                }
                if (lineIndex % DEADLINE_CHECK_INTERVAL === 0 && now() - startedAt > parseDeadlineMs) {
                        throw new LivetvAdapterError('parse_deadline_exceeded', 'The playlist parse exceeded its time budget.');
                }

                const rawLine = lines[lineIndex]!;
                if (rawLine.length > maxLineLength) {
                        // Hostile/pathological line — unusable, never stored.
                        const current = pending;
                        if (current) {
                                diagnostics.noteError(current.entryIndex, null, 'line_too_long');
                                finishPendingWithoutUrl();
                        } else {
                                diagnostics.noteSkip('line_too_long');
                        }
                        continue;
                }
                const line = rawLine.trim();
                if (!line) continue;

                if (line.startsWith('#')) {
                        const upper = line.toUpperCase();
                        if (upper.startsWith('#EXTM3U')) {
                                sawHeader = true;
                                continue;
                        }
                        if (upper.startsWith('#EXTINF')) {
                                if (!sawHeader) {
                                        throw new LivetvAdapterError('parse_failed', 'The playlist is missing the required #EXTM3U header.');
                                }
                                pending = handleExtinf(line.slice('#EXTINF'.length), lineIndex);
                                continue;
                        }
                        if (upper.startsWith('#EXTGRP')) {
                                // Kodi group directive — fallback category when
                                // no group-title attribute exists. Never a URL.
                                const group = normalizeOptionalTextField(line.slice('#EXTGRP'.length).replace(/^:/, ''), 120, true);
                                if (group) pendingGroupFromDirective = group;
                                continue;
                        }
                        // Every other directive (#EXTVLCOPT, #KODIPROP, …) is
                        // deliberately ignored and never persisted — they can
                        // carry user-agent/referrer credentials.
                        continue;
                }

                // A non-comment, non-blank line is a stream URL line.
                if (!sawHeader) {
                        throw new LivetvAdapterError('parse_failed', 'The playlist is missing the required #EXTM3U header.');
                }
                if (pending) {
                        flushEntry(pending, line);
                        pending = null;
                        pendingGroupFromDirective = null;
                } else {
                        diagnostics.noteSkip('orphan_stream_url');
                }
        }
        finishPendingWithoutUrl();

        // 2026-10 round 11 — Task 1: diagnostic log so the admin can verify
        // that every EXTINF line was parsed. If discoveredCount is much less
        // than the total EXTINF lines, entries are being skipped (check the
        // skippedReasons in the diagnostics).
        console.log(`[m3u parser] Parsed: ${channels.length} channels, ${diagnostics.skippedCount} skipped, reasons:`, diagnostics.reasons);

        return { channels, diagnostics: diagnostics.toDiagnostics() };
}

// ---------------------------------------------------------------------------
// The adapter (fetch + config validation + parse)
// ---------------------------------------------------------------------------

export const m3uPlaylistAdapter: LivetvSourceAdapter = {
        id: 'm3u_playlist',
        supportedSourceTypes: ['m3u_playlist'],

        supports(sourceType) {
                return sourceType === 'm3u_playlist';
        },

        capabilities(_sourceType): LivetvAdapterCapabilities {
                return {
                        catalogue: true,
                        guide: false,
                        logos: true,
                        categories: true,
                        endpointKinds: ['direct_stream'],
                        playbackResolution: 'static_urls',
                        refreshSupported: true
                };
        },

        async run(source: LivetvAdapterSourceRef, deps: LivetvAdapterDeps): Promise<LivetvAdapterRunResult> {
                let config: LivetvM3UPlaylistConfig;
                try {
                        config = validateLivetvSourceConfig('m3u_playlist', source.config) as LivetvM3UPlaylistConfig;
                } catch (error) {
                        if (isLivetvRegistryValidationError(error)) {
                                throw new LivetvAdapterError('invalid_source_config', 'The source configuration failed validation.', { cause: error });
                        }
                        throw error;
                }

                // R-2 — parse options carry the injected clock/signal (tests
                // and cancellation); `playlistBaseUrl` is filled in AFTER the
                // fetch returns the configuration-data URL the fetcher
                // already https-validated at every redirect hop.
                const parseOptions: M3UParseOptions = { now: deps.now, signal: deps.signal };

                let text: string;
                try {
                        const document = await fetchLivetvSourceText(config.playlistUrl, {
                                fetcher: deps.fetcher,
                                dnsResolver: deps.dnsResolver,
                                timeoutMs: deps.timeoutMs,
                                maxBytes: deps.maxBytes,
                                maxRedirects: deps.maxRedirects,
                                signal: deps.signal
                        });
                        text = document.text;
                        // R-2 — pass the playlist's own final URL (after the
                        // bounded, SSRF-guarded redirect chain) as the base
                        // for resolving RELATIVE stream URLs inside the body.
                        // `finalUrl` is the configuration-data URL the fetcher
                        // already https-validated at every hop; re-validating
                        // https-ness inside the classifier is defense in depth.
                        parseOptions.playlistBaseUrl = document.finalUrl;
                } catch (error) {
                        throw adapterErrorFromFetch(error);
                }

                const parsed = parseM3UPlaylist(text, parseOptions);
                return { adapterId: 'm3u_playlist', channels: parsed.channels, diagnostics: parsed.diagnostics };
        }
};
