// ============================================================================
// Unified Live TV — Phase 3 XMLTV parsing + document decoding (server-only).
//
//   (gzip?) bytes → UTF-8 text → bounded XMLTV parse → typed records
//
// PARSER SELECTION (Phase 3 brief §4.1 — "inspect and document the selected
// parser's actual configuration and behavior"):
//   The parser is **cheerio 1.0.0** (`load(text, { xml: true })` — the
//   htmlparser2 tokenizer in XML mode), an ALREADY-INSTALLED, maintained
//   dependency of this repository (no new package was added). Its verified
//   security-relevant behavior (probed against the installed version and
//   regression-pinned by the Phase 3 suite):
//     * It NEVER fetches anything: a DOCTYPE SYSTEM id is inert text —
//       external DTD resolution is structurally impossible.
//     * It does NOT process DTD entity declarations: custom entities
//       (billion-laughs style) remain literal text and are never expanded.
//       Only the predefined XML entities and numeric character references
//       are decoded (verified: `&amp;&lt;&gt;&apos;&quot;&#65;` → `&<>'"A`;
//       a DTD-defined `&lol;` stays `&lol;`).
//     * Deep nesting does not recurse per level (verified with a 5000-level
//       probe); nesting depth is additionally bounded by this module.
//     * Malformed XML does not throw (tolerant tokenizer) — therefore this
//       module performs its own EXPLICIT document-structure validation
//       (root element, required attributes, child shapes) and treats
//       structural violations as document-level failures.
//
// INPUT SAFETY (Phase 3 brief §4.1):
//   * Compression is detected by CONTENT (gzip magic bytes 1f 8b), never by
//     a filename extension or a content-type claim; invalid gzip and
//     decompression overflows fail with typed errors (zlib maxOutputLength).
//   * Separate budgets for compressed bytes (enforced by the shared guarded
//     fetcher) and decompressed bytes (enforced here via maxOutputLength).
//   * Bounded channel count, programme count, text length, attribute length
//     and total parse deadline; the caller's AbortSignal is honored.
//   * An XML declaration that names a non-UTF-8 encoding is a typed
//     document-level failure (bytes are decoded as UTF-8 per the XMLTV
//     convention; silently misreading other encodings is refused).
//   * URLs inside the document are NEVER fetched; nothing is ever executed.
//
// RECORD ISOLATION (brief §4.2):
//   * One malformed channel/programme is SKIPPED with a typed, bounded
//     diagnostic — the rest of the document survives.
//   * Document-level violations (missing/incorrect root, exceeded global
//     caps, deadline, decompression abuse) fail the ENTIRE document — no
//     partial snapshot is ever produced for persistence.
//
// NO FABRICATION: channel ids, names, icons, titles and windows are stored
// exactly as supplied (bounded); nothing is invented or normalized beyond
// whitespace trimming.
// ============================================================================

import { gunzipSync } from 'node:zlib';
import * as cheerio from 'cheerio';
import type { CheerioAPI } from 'cheerio';
import { XmltvTimestampError, parseXmltvTimestamp } from './time';

// ---------------------------------------------------------------------------
// Limits (documented policy; brief §4.1)
// ---------------------------------------------------------------------------

export type XmltvParseLimits = {
        /** Maximum decompressed document size (bytes). */
        maxDecompressedBytes: number;
        /** Maximum `<channel>` elements. */
        maxChannels: number;
        /** Maximum `<programme>` elements. */
        maxProgrammes: number;
        /** Maximum total parse duration (ms). */
        parseDeadlineMs: number;
        /** Maximum channel-id length (DB parity: livetv_epg_*.epg_channel_id). */
        maxChannelIdLength: number;
        /** Per-field text caps (DB parity with livetv_epg_programmes). */
        maxTitleLength: number;
        maxSubtitleLength: number;
        maxDescriptionLength: number;
        maxCategoryLength: number;
        /** Maximum XML nesting depth (document-level). */
        maxNestingDepth: number;
};

export const DEFAULT_XMLTV_LIMITS: Readonly<XmltvParseLimits> = Object.freeze({
        maxDecompressedBytes: 16 * 1024 * 1024, // 16 MiB decompressed
        maxChannels: 5_000,
        maxProgrammes: 50_000,
        parseDeadlineMs: 15_000,
        maxChannelIdLength: 200,
        maxTitleLength: 500,
        maxSubtitleLength: 500,
        maxDescriptionLength: 2_000,
        maxCategoryLength: 120,
        maxNestingDepth: 64
});

/** Maximum gzip-compressed input accepted by the decoder (the fetch layer enforces it too). */
export const XMLTV_MAX_COMPRESSED_BYTES = 12 * 1024 * 1024; // 12 MiB compressed

// ---------------------------------------------------------------------------
// Typed errors (document-level; messages are static and diagnostics-safe)
// ---------------------------------------------------------------------------

export type XmltvDocumentErrorKind =
        | 'empty_document'
        | 'invalid_gzip'
        | 'decompression_too_large'
        | 'unsupported_encoding'
        | 'structure_invalid'
        | 'channel_cap_exceeded'
        | 'programme_cap_exceeded'
        | 'nesting_too_deep'
        | 'parse_deadline_exceeded'
        | 'cancelled'
        | 'unexpected';

export class XmltvDocumentError extends Error {
        readonly kind: XmltvDocumentErrorKind;
        constructor(kind: XmltvDocumentErrorKind, message: string, options: { cause?: unknown } = {}) {
                super(message);
                this.name = 'XmltvDocumentError';
                this.kind = kind;
                if (options.cause !== undefined) (this as { cause?: unknown }).cause = options.cause;
        }
}

// ---------------------------------------------------------------------------
// Per-record diagnostics
// ---------------------------------------------------------------------------

export type XmltvRecordErrorReason =
        | 'missing_channel_id'
        | 'invalid_channel_id'
        | 'invalid_display_name'
        | 'missing_programme_channel'
        | 'invalid_programme_channel'
        | 'missing_start'
        | 'invalid_start'
        | 'missing_stop'
        | 'invalid_stop'
        | 'invalid_window_order'
        | 'missing_title'
        | 'invalid_title'
        | 'invalid_subtitle'
        | 'invalid_description'
        | 'invalid_category'
        | 'icon_url_rejected'
        | 'timezone_unresolvable';

export type XmltvRecordError = {
        /** Position of the record within the document (document order, 0-based). */
        recordIndex: number;
        /** The channel identity when it was readable (else null). */
        channelId: string | null;
        reason: XmltvRecordErrorReason;
};

export type XmltvDiagnostics = {
        channelsDiscovered: number;
        programmesDiscovered: number;
        channelsSkipped: number;
        programmesSkipped: number;
        /** Static reason → count (complete; not sampled). */
        skipReasons: Record<string, number>;
        /** Bounded sample of per-record skips (the counts above stay complete). */
        samples: XmltvRecordError[];
        /** Bounded, sanitized samples of REJECTED channel ids (mapping diagnostics; control chars stripped, ≤200 chars each). */
        invalidChannelIdSamples: string[];
};

export type XmltvChannel = {
        /** The guide's channel id, verbatim (bounded, no whitespace/control). */
        id: string;
        /** First bounded display name (source-provided; never invented). */
        displayName: string | null;
        /** Genuine source-supplied icon (https-only stored; http rejected with a counted reason). */
        iconUrl: string | null;
};

export type XmltvProgramme = {
        /** The guide's channel id, verbatim (matches an XmltvChannel.id or stands alone). */
        channelId: string;
        /** Absolute UTC window (epoch ms). start < end always. */
        startMs: number;
        endMs: number;
        title: string;
        subTitle: string | null;
        description: string | null;
        category: string | null;
        /** Genuine programme icon — only when supplied by the source. */
        iconUrl: string | null;
        /** Source language of the title, only when reliably present. */
        language: string | null;
        /** How the timestamps were resolved (provenance/diagnostics only). */
        timeResolution: 'explicit_offset' | 'default_timezone';
};

export type XmltvParseResult = {
        channels: XmltvChannel[];
        programmes: XmltvProgramme[];
        diagnostics: XmltvDiagnostics;
        /** The configured/actual timezone policy actually used per record. */
        counts: {
                explicitOffsetTimestamps: number;
                defaultTimezoneTimestamps: number;
        };
};

// ---------------------------------------------------------------------------
// Document decoding (gzip detection by CONTENT + UTF-8 + encoding policy)
// ---------------------------------------------------------------------------

const GZIP_MAGIC_0 = 0x1f;
const GZIP_MAGIC_1 = 0x8b;

function isProbablyGzip(bytes: Uint8Array): boolean {
        return bytes.length >= 2 && bytes[0] === GZIP_MAGIC_0 && bytes[1] === GZIP_MAGIC_1;
}

const UTF8_DECODER = new TextDecoder('utf-8', { fatal: false });

/**
 * Decodes a fetched XMLTV payload into parser-ready text.
 *   * gzip detected by magic bytes (never by extension/content-type);
 *   * decompression bounded by `limits.maxDecompressedBytes` (zlib
 *     maxOutputLength — a gzip bomb fails with a typed error);
 *   * an XML declaration naming a non-UTF-8 encoding fails with a typed
 *     error instead of being silently misread;
 *   * a UTF-8 BOM is tolerated and stripped.
 */
export function decodeXmltvPayload(bytes: Uint8Array, limits: Partial<XmltvParseLimits> = {}): string {
        const maxDecompressed = limits.maxDecompressedBytes ?? DEFAULT_XMLTV_LIMITS.maxDecompressedBytes;
        if (bytes.length === 0) throw new XmltvDocumentError('empty_document', 'The guide document is empty.');
        let text: string;
        if (isProbablyGzip(bytes)) {
                try {
                        const inflated = gunzipSync(bytes, { maxOutputLength: maxDecompressed });
                        // Node throws ERR_BUFFER_TOO_LARGE only when the OUTPUT would
                        // exceed the cap — re-check the actual size defensively.
                        if (inflated.byteLength > maxDecompressed) {
                                throw new XmltvDocumentError('decompression_too_large', 'The decompressed guide exceeds the configured size budget.');
                        }
                        text = UTF8_DECODER.decode(inflated);
                } catch (error) {
                        if (error instanceof XmltvDocumentError) throw error;
                        const code = (error as { code?: string })?.code;
                        if (code === 'ERR_BUFFER_TOO_LARGE') {
                                throw new XmltvDocumentError('decompression_too_large', 'The decompressed guide exceeds the configured size budget.');
                        }
                        throw new XmltvDocumentError('invalid_gzip', 'The guide payload is not valid gzip data.', { cause: error });
                }
        } else {
                if (bytes.byteLength > maxDecompressed) {
                        throw new XmltvDocumentError('decompression_too_large', 'The guide document exceeds the configured size budget.');
                }
                text = UTF8_DECODER.decode(bytes);
        }
        // Encoding policy: UTF-8 (or ASCII) only. A declaration naming any
        // other encoding is refused — the bytes were decoded as UTF-8 and
        // silently misreading another encoding would fabricate data.
        const declaration = /<\?xml\s+[^>]*encoding\s*=\s*["']([^"']+)["'][^>]*\?>/i.exec(text.slice(0, 512));
        if (declaration) {
                const encoding = declaration[1]!.trim().toLowerCase();
                if (encoding !== 'utf-8' && encoding !== 'utf8' && encoding !== 'us-ascii' && encoding !== 'ascii') {
                        throw new XmltvDocumentError('unsupported_encoding', 'The guide document declares an encoding other than UTF-8.');
                }
        }
        if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
        return text;
}

// ---------------------------------------------------------------------------
// Field helpers
// ---------------------------------------------------------------------------

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

function boundedText(raw: string | undefined, maxLen: number): string | null {
        if (raw === undefined) return null;
        const trimmed = raw.trim();
        if (!trimmed) return null;
        if (trimmed.length > maxLen) return null;
        if (CONTROL_CHARS.test(trimmed)) return null;
        return trimmed;
}

/** Channel id parity with the DB CHECK: 1..200, no whitespace, no control chars. */
function validChannelId(raw: string | undefined, maxLen: number): string | null {
        if (raw === undefined) return null;
        const trimmed = raw.trim();
        if (!trimmed || trimmed.length > maxLen) return null;
        if (/\s/.test(trimmed) || CONTROL_CHARS.test(trimmed)) return null;
        return trimmed;
}

/** Icon policy: genuine source-supplied URL, https-only, bounded (DB parity). */
function validIconUrl(raw: string | undefined): string | null {
        if (raw === undefined) return null;
        const trimmed = raw.trim();
        if (!trimmed || trimmed.length > 2048) return null;
        if (/\s/.test(trimmed) || CONTROL_CHARS.test(trimmed)) return null;
        if (!trimmed.startsWith('https://')) return null;
        try {
                const url = new URL(trimmed);
                if (url.username || url.password) return null;
        } catch {
                return null;
        }
        return trimmed;
}

/** Cheap document-order text of an element's first matching child. */
type XmltvElement = Parameters<CheerioAPI>[0];

function childText($: CheerioAPI, el: XmltvElement, tag: string, maxLen: number): string | null {
        const value = $(el).children(tag).first().text();
        return boundedText(value, maxLen);
}

/** Detects pathological nesting without walking the DOM twice. */
function hasExcessiveNesting(xml: string): boolean {
        // Depth counter over tag-open/close tokens — a bounded scan that
        // refuses documents nested far beyond any legitimate XMLTV shape.
        let depth = 0;
        const re = /<\/?([A-Za-z_][\w.:-]*)[^>]*?(\/?)>/g;
        let match: RegExpExecArray | null;
        while ((match = re.exec(xml)) !== null) {
                if (match[2] === '/') continue; // self-closing
                if (match[0][1] === '/') depth = Math.max(0, depth - 1);
                else {
                        depth += 1;
                        if (depth > DEFAULT_XMLTV_LIMITS.maxNestingDepth) return true;
                }
        }
        return false;
}

// ---------------------------------------------------------------------------
// The parser
// ---------------------------------------------------------------------------

export type XmltvParseOptions = {
        /** IANA timezone for timezone-less timestamps (null = reject them). */
        defaultTimezone?: string | null;
        limits?: Partial<XmltvParseLimits>;
        /** Deadline clock (injectable for deterministic tests). */
        now?: () => number;
        /** External cancellation — checked between records and around parsing. */
        signal?: AbortSignal;
};

const RECORD_ERROR_SAMPLE = 50;
const DEADLINE_CHECK_INTERVAL = 2_000;

export function parseXmltvDocument(xml: string, options: XmltvParseOptions = {}): XmltvParseResult {
        const limits: XmltvParseLimits = { ...DEFAULT_XMLTV_LIMITS, ...(options.limits ?? {}) };
        const defaultTimezone = options.defaultTimezone ?? null;
        const now = options.now ?? (() => Date.now());
        const startedAt = now();

        if (!xml || !xml.trim()) throw new XmltvDocumentError('empty_document', 'The guide document is empty.');
        if (hasExcessiveNesting(xml)) throw new XmltvDocumentError('nesting_too_deep', 'The guide document is nested too deeply.');
        if (options.signal?.aborted) throw new XmltvDocumentError('cancelled', 'The guide refresh was cancelled.');

        const $ = cheerio.load(xml, { xml: true });

        // Document-structure validation (the tokenizer is tolerant; THIS is
        // the strictness boundary): the root element must be `tv`.
        const rootChildren = $.root().children();
        const tv = rootChildren.filter((_, el) => ($(el).get(0)?.tagName ?? '').toLowerCase() === 'tv');
        if (tv.length !== 1) throw new XmltvDocumentError('structure_invalid', 'The guide document is not an XMLTV document (missing <tv> root).');

        const diagnostics: XmltvDiagnostics = {
                channelsDiscovered: 0,
                programmesDiscovered: 0,
                channelsSkipped: 0,
                programmesSkipped: 0,
                skipReasons: {},
                samples: [],
                invalidChannelIdSamples: []
        };
        const channels: XmltvChannel[] = [];
        const programmes: XmltvProgramme[] = [];
        let explicitOffsetTimestamps = 0;
        let defaultTimezoneTimestamps = 0;

        const countSkip = (kind: 'channel' | 'programme', reason: XmltvRecordErrorReason, recordIndex: number, channelId: string | null, rawId?: string): void => {
                diagnostics.skipReasons[reason] = (diagnostics.skipReasons[reason] ?? 0) + 1;
                if (kind === 'channel') diagnostics.channelsSkipped += 1;
                else diagnostics.programmesSkipped += 1;
                if (diagnostics.samples.length < RECORD_ERROR_SAMPLE) {
                        diagnostics.samples.push({ recordIndex, channelId, reason });
                }
                if (rawId !== undefined && diagnostics.invalidChannelIdSamples.length < RECORD_ERROR_SAMPLE) {
                        const sanitized = rawId.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 200);
                        if (sanitized && !diagnostics.invalidChannelIdSamples.includes(sanitized)) {
                                diagnostics.invalidChannelIdSamples.push(sanitized);
                        }
                }
        };

        // --- channels (document order, bounded) ---
        const channelEls = tv.children('channel').toArray();
        if (channelEls.length > limits.maxChannels) {
                throw new XmltvDocumentError('channel_cap_exceeded', 'The guide document exceeds the configured channel budget.');
        }
        for (let index = 0; index < channelEls.length; index += 1) {
                const el = channelEls[index]!;
                diagnostics.channelsDiscovered += 1;
                const id = validChannelId($(el).attr('id'), limits.maxChannelIdLength);
                if (!id) {
                        countSkip('channel', $(el).attr('id') === undefined ? 'missing_channel_id' : 'invalid_channel_id', index, null, $(el).attr('id'));
                        continue;
                }
                const displayName = childText($, el, 'display-name', 200);
                if (displayName === null && $(el).children('display-name').length > 0) {
                        // A present-but-invalid display name is a counted skip of the
                        // FIELD, not the record — the id is the identity (provenance
                        // honesty: names are display metadata, never identity).
                        countSkip('channel', 'invalid_display_name', index, id);
                }
                const iconRaw = $(el).children('icon').first().attr('src');
                let iconUrl = validIconUrl(iconRaw);
                if (iconUrl === null && iconRaw !== undefined && iconRaw.trim() !== '') {
                        countSkip('channel', 'icon_url_rejected', index, id);
                        iconUrl = null;
                }
                channels.push({ id, displayName, iconUrl });
        }

        // --- programmes (document order, bounded, per-record isolated) ---
        const programmeEls = tv.children('programme').toArray();
        if (programmeEls.length > limits.maxProgrammes) {
                throw new XmltvDocumentError('programme_cap_exceeded', 'The guide document exceeds the configured programme budget.');
        }
        for (let index = 0; index < programmeEls.length; index += 1) {
                if (index % DEADLINE_CHECK_INTERVAL === 0) {
                        if (options.signal?.aborted) throw new XmltvDocumentError('cancelled', 'The guide refresh was cancelled.');
                        if (now() - startedAt > limits.parseDeadlineMs) {
                                throw new XmltvDocumentError('parse_deadline_exceeded', 'The guide parse exceeded its time budget.');
                        }
                }
                const el = programmeEls[index]!;
                diagnostics.programmesDiscovered += 1;

                const channelId = validChannelId($(el).attr('channel'), limits.maxChannelIdLength);
                if (!channelId) {
                        countSkip('programme', $(el).attr('channel') === undefined ? 'missing_programme_channel' : 'invalid_programme_channel', index, null, $(el).attr('channel'));
                        continue;
                }

                const startAttr = $(el).attr('start');
                const stopAttr = $(el).attr('stop');
                if (startAttr === undefined) {
                        countSkip('programme', 'missing_start', index, channelId);
                        continue;
                }
                if (stopAttr === undefined) {
                        countSkip('programme', 'missing_stop', index, channelId);
                        continue;
                }
                let start: { epochMs: number; resolvedWith: 'explicit_offset' | 'default_timezone' };
                let stop: { epochMs: number; resolvedWith: 'explicit_offset' | 'default_timezone' };
                try {
                        start = parseXmltvTimestamp(startAttr, defaultTimezone);
                } catch (error) {
                        if (error instanceof XmltvTimestampError) {
                                countSkip('programme', error.reason === 'unknown_timezone' ? 'timezone_unresolvable' : 'invalid_start', index, channelId);
                                continue;
                        }
                        throw error;
                }
                try {
                        stop = parseXmltvTimestamp(stopAttr, defaultTimezone);
                } catch (error) {
                        if (error instanceof XmltvTimestampError) {
                                countSkip('programme', error.reason === 'unknown_timezone' ? 'timezone_unresolvable' : 'invalid_stop', index, channelId);
                                continue;
                        }
                        throw error;
                }
                if (!(start.epochMs < stop.epochMs)) {
                        countSkip('programme', 'invalid_window_order', index, channelId);
                        continue;
                }
                if (start.resolvedWith === 'explicit_offset') explicitOffsetTimestamps += 1;
                else defaultTimezoneTimestamps += 1;
                if (stop.resolvedWith === 'explicit_offset') explicitOffsetTimestamps += 1;
                else defaultTimezoneTimestamps += 1;

                const title = childText($, el, 'title', limits.maxTitleLength);
                if (title === null) {
                        countSkip('programme', $(el).children('title').length === 0 ? 'missing_title' : 'invalid_title', index, channelId);
                        continue;
                }
                const subTitle = childText($, el, 'sub-title', limits.maxSubtitleLength);
                if (subTitle === null && $(el).children('sub-title').length > 0) {
                        countSkip('programme', 'invalid_subtitle', index, channelId);
                }
                const description = childText($, el, 'desc', limits.maxDescriptionLength);
                if (description === null && $(el).children('desc').length > 0) {
                        countSkip('programme', 'invalid_description', index, channelId);
                }
                const category = childText($, el, 'category', limits.maxCategoryLength);
                if (category === null && $(el).children('category').length > 0) {
                        countSkip('programme', 'invalid_category', index, channelId);
                }
                const iconRaw = $(el).children('icon').first().attr('src');
                let iconUrl = validIconUrl(iconRaw);
                if (iconUrl === null && iconRaw !== undefined && iconRaw.trim() !== '') {
                        countSkip('programme', 'icon_url_rejected', index, channelId);
                        iconUrl = null;
                }
                // Source language: only when the title element genuinely carries one.
                const language = boundedText($(el).children('title').first().attr('lang'), 32);

                programmes.push({ channelId, startMs: start.epochMs, endMs: stop.epochMs, title, subTitle, description, category, iconUrl, language, timeResolution: start.resolvedWith });
        }

        return {
                channels,
                programmes,
                diagnostics,
                counts: { explicitOffsetTimestamps, defaultTimezoneTimestamps }
        };
}
