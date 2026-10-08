// LT-9 — Signed DASH query-auth propagation for LiveGT V1 (Live TV ONLY).
//
// PRODUCTION EVIDENCE (India Android Chrome, 2026-10-08, DevTools Network):
//   Star Gold HD (156): the LiveGT-resolved manifest URL carries the
//   short-lived signed query (`__hdnea__`); the manifest loads, playback
//   begins, and after ~3-4 seconds the Jio CDN rejects the DASH
//   media-segment requests with
//
//     HTTP 403  +  X-Error-Details: "No sub Token"  +  X-ErrType: auth-failure
//
//   The failing segment requests do NOT carry the signed query. Root cause
//   (established in LT-8, now confirmed by production evidence): DASH
//   SegmentTemplate references are relative, and Shaka resolves them per
//   WHATWG against the manifest URL — which DROPS the manifest's query
//   string. Unless the MPD declares the DASH-IF UrlQueryInfo mechanism
//   (urn:mpeg:dash:urlparam:2014/2016), plain Shaka — including LiveGT's
//   own documented example — cannot satisfy the CDN's per-request token.
//
// THE FALLBACK (this module) — smallest correct Mavero-side fix:
//   A response filter identifies DASH manifests (body sniff) and records
//   the final manifest URI; a request filter appends ONLY the proven
//   auth parameter(s) — byte-exact, from the ALREADY-RESOLVED LiveGT V1
//   source URL — to SAME-ORIGIN DASH SEGMENT requests that lack them.
//
// SECURITY CONSTRAINTS (all enforced structurally in this module):
//   * Allowlist: `__hdnea__` ONLY. Resolver census (LT-9, 30/30 sampled
//     channels): every V1 source URL carries exactly ["__hdnea__"] — no
//     other parameter is ever copied. No arbitrary query propagation.
//   * The token is never fetched anew, never persisted, never logged,
//     never placed in analytics, never exposed in errors (this module
//     has ZERO console calls and touches no storage APIs).
//   * Only RequestType.SEGMENT is ever modified — DRM/license (LICENSE),
//     KEY, manifest, timing and every other request type are untouched.
//   * Only the EXACT origin that served the DASH manifest receives the
//     parameter — a segment URL on any other origin/hostname is left
//     untouched (no cross-origin token leakage).
//   * Existing query parameters on the segment request are preserved;
//     an already-present auth parameter is never duplicated or
//     overwritten — so DASH-IF UrlQueryInfo (standard) handling always
//     wins and this fallback only fills the gap.
//   * HLS is NEVER affected: the fallback activates only after a
//     manifest response body was identified as a DASH MPD (HLS playlists
//     start with '#EXTM3U' and are explicitly rejected). Production
//     proof of scope: HLS channels (e.g. News18 Urdu 1500) play fine.
//
// The one data read here is the MANIFEST RESPONSE BODY (first bytes, to
// detect '<MPD') — this is Shaka's networking response, NOT Shaka's
// error object; the sniff result is a boolean and the bytes are never
// stored, logged, or emitted anywhere.

/**
 * Shaka NetworkingEngine RequestType values (shaka-player 5.2.12 public
 * enum — stable numbers, verified against the installed typings; these
 * are documented API constants, not secrets).
 */
export const SHAKA_REQUEST_TYPE = {
        MANIFEST: 0,
        SEGMENT: 1,
        LICENSE: 2
} as const;

/** Structural subset of `shaka.extern.Request` the filters touch. */
export type ShakaRequestLike = {
        uris: string[];
};

/** Structural subset of `shaka.extern.Response` the filters read. */
export type ShakaResponseLike = {
        data?: ArrayBuffer | ArrayBufferView | null;
        uri?: string | null;
};

/** Structural subset of `shaka.net.NetworkingEngine` used by the engine. */
export type ShakaNetworkingEngineLike = {
        registerRequestFilter(filter: (type: number, request: ShakaRequestLike) => void): void;
        registerResponseFilter(filter: (type: number, response: ShakaResponseLike) => void): void;
};

/**
 * Authentication/signing query parameter NAMES proven necessary by the
 * LiveGT V1 resolver + Jio CDN delivery (India production evidence
 * 2026-10-08: segment 403 "No sub Token"; LT-9 resolver census: 30/30
 * sampled source URLs carry exactly ["__hdnea__"]). Deliberately NOT
 * exported — nothing outside this module can widen the allowlist.
 */
const DASH_AUTH_QUERY_PARAMS: readonly string[] = ['__hdnea__'];

/**
 * Per-session propagation state. Lives in runtime memory ONLY, for the
 * lifetime of one playback session: created from the already-resolved
 * source URL, mutated by the manifest response filter, garbage-collected
 * with the Shaka player (filters die with the player on teardown).
 */
export type DashAuthSession = {
        /** The engine-known resolved source URL (signed — the token source). Never re-fetched. */
        readonly sourceUrl: string;
        /** Final URI of the DASH manifest response (post-redirect) — the base Shaka resolves relative segment refs against. */
        manifestUri: string | null;
        /** True once a MANIFEST response body was identified as a DASH MPD. */
        isDash: boolean;
};

/** Create the per-session state from the already-resolved source URL. */
export function createDashAuthSession(sourceUrl: string): DashAuthSession {
        return { sourceUrl, manifestUri: null, isDash: false };
}

// ---------------------------------------------------------------------------
// Pure helpers (all byte-exact — no decode/re-encode of signed material).
// ---------------------------------------------------------------------------

/**
 * The RAW allowlisted query parts (e.g. `__hdnea__=<exactly-as-resolved>`)
 * of a URL. Splitting on '&' and matching only the NAME keeps the signed
 * value byte-for-byte identical to the resolver string — it is never
 * decoded and re-encoded (which could alter '%'/'='/'~' semantics).
 */
function rawAuthQueryParts(url: string): string[] {
        if (typeof url !== 'string') return [];
        const qIndex = url.indexOf('?');
        if (qIndex === -1) return [];
        const query = url.slice(qIndex + 1);
        const hashIndex = query.indexOf('#');
        const rawQuery = hashIndex === -1 ? query : query.slice(0, hashIndex);
        const parts: string[] = [];
        for (const part of rawQuery.split('&')) {
                if (part === '') continue;
                const name = part.split('=', 1)[0];
                if (DASH_AUTH_QUERY_PARAMS.includes(name)) parts.push(part);
        }
        return parts;
}

/** True when the URL already carries any allowlisted auth parameter. */
function hasAuthQueryParam(url: string): boolean {
        return rawAuthQueryParts(url).length > 0;
}

/** True when both URLs parse and share the EXACT origin (scheme+host+port). */
function sameOrigin(a: string, b: string): boolean {
        try {
                return new URL(a).origin === new URL(b).origin;
        } catch {
                return false;
        }
}

/** Decode the first bytes of a response body as ASCII text ('' if unavailable). */
function peekAscii(data: unknown, maxBytes = 512): string {
        try {
                let bytes: Uint8Array;
                if (data instanceof ArrayBuffer) {
                        bytes = new Uint8Array(data, 0, Math.min(maxBytes, data.byteLength));
                } else if (ArrayBuffer.isView(data)) {
                        const view = data as ArrayBufferView;
                        bytes = new Uint8Array(view.buffer, view.byteOffset, Math.min(maxBytes, view.byteLength));
                } else {
                        return '';
                }
                let out = '';
                for (let i = 0; i < bytes.length; i++) {
                        const byte = bytes[i] ?? 0;
                        if (byte === 0) break; // manifests are text; stop at binary
                        out += String.fromCharCode(byte);
                }
                return out;
        } catch {
                return '';
        }
}

/**
 * True when a manifest response body looks like a DASH MPD. HLS playlists
 * start with '#EXTM3U' and are explicitly rejected — the fallback NEVER
 * applies to HLS delivery (production HLS channels play; propagation for
 * HLS is out of scope until independently proven necessary).
 */
export function looksLikeDashManifest(data: unknown): boolean {
        const head = peekAscii(data).replace(/^\uFEFF/, '').trimStart();
        if (head.startsWith('#EXT')) return false; // HLS playlist
        return /<MPD[\s>]/.test(head.slice(0, 320)); // DASH root element
}

// ---------------------------------------------------------------------------
// Filter logic (pure — applied by the closures installed below).
// ---------------------------------------------------------------------------

/**
 * Propagate the proven auth query to ONE DASH segment URL.
 *
 * Returns the input UNCHANGED unless ALL of the following hold:
 *   1. the session's manifest was identified as DASH (never HLS/unknown);
 *   2. a manifest response URI is known (the same-origin anchor);
 *   3. the resolved source URL carries allowlisted auth parameter(s);
 *   4. the segment URL does NOT already carry them (standard DASH-IF
 *      UrlQueryInfo handling wins — never duplicated, never overwritten);
 *   5. the segment URL shares the manifest's EXACT origin.
 */
export function propagateDashSegmentAuth(segmentUrl: string, session: DashAuthSession): string {
        if (typeof segmentUrl !== 'string' || segmentUrl.length === 0) return segmentUrl;
        if (!session.isDash || !session.manifestUri) return segmentUrl;
        const authParts = rawAuthQueryParts(session.sourceUrl);
        if (authParts.length === 0) return segmentUrl;
        if (hasAuthQueryParam(segmentUrl)) return segmentUrl;
        if (!sameOrigin(segmentUrl, session.manifestUri)) return segmentUrl;
        const joiner = segmentUrl.endsWith('?') ? '' : segmentUrl.includes('?') ? '&' : '?';
        return segmentUrl + joiner + authParts.join('&');
}

/**
 * Learn from a MANIFEST response: whether the content is DASH, and the
 * final manifest URI (the base Shaka used to resolve relative segment
 * references — post-redirect). No-op for every other response type.
 */
export function applyDashAuthManifestResponse(
        type: number,
        response: ShakaResponseLike | null | undefined,
        session: DashAuthSession
): void {
        if (type !== SHAKA_REQUEST_TYPE.MANIFEST) return;
        const uri = typeof response?.uri === 'string' && response.uri.length > 0 ? response.uri : null;
        if (!uri) return;
        if (!looksLikeDashManifest(response?.data)) return;
        session.isDash = true;
        session.manifestUri = uri;
}

/**
 * Apply the fallback to a SEGMENT request (in place). Every other request
 * type — DRM/LICENSE, KEY, manifest, timing, … — is left untouched.
 */
export function applyDashAuthSegmentRequest(
        type: number,
        request: ShakaRequestLike | null | undefined,
        session: DashAuthSession
): void {
        if (type !== SHAKA_REQUEST_TYPE.SEGMENT) return;
        const uris = request?.uris;
        if (!Array.isArray(uris)) return;
        for (let i = 0; i < uris.length; i++) {
                const uri = uris[i] ?? '';
                const next = propagateDashSegmentAuth(uri, session);
                if (next !== uri) uris[i] = next;
        }
}

// ---------------------------------------------------------------------------
// Installation — the ONLY entry point the playback engine uses.
// ---------------------------------------------------------------------------

/**
 * Install the two networking filters on a Shaka player for ONE session
 * (called between player creation and `load()` so the manifest response
 * is observed). Totally defensive: when the player exposes no networking
 * engine (or anything throws), NOTHING is installed and playback behaves
 * exactly as documented — the fallback is strictly best-effort.
 *
 * The filters live and die with the player instance (the engine destroys
 * the player on teardown/switch); the session state never leaves memory.
 * Returns the session (for tests) or null when nothing was installed.
 */
export function installDashAuthFilters(
        player: { getNetworkingEngine?: unknown } | null | undefined,
        sourceUrl: string
): DashAuthSession | null {
        if (!player || typeof sourceUrl !== 'string' || sourceUrl.length === 0) return null;
        const session = createDashAuthSession(sourceUrl);
        try {
                const getter = player.getNetworkingEngine;
                if (typeof getter !== 'function') return null;
                const netEngine = (getter as () => ShakaNetworkingEngineLike | null | undefined).call(player);
                if (
                        !netEngine ||
                        typeof netEngine.registerRequestFilter !== 'function' ||
                        typeof netEngine.registerResponseFilter !== 'function'
                ) {
                        return null;
                }
                netEngine.registerResponseFilter((type, response) => {
                        try {
                                applyDashAuthManifestResponse(type, response, session);
                        } catch {
                                // a filter must NEVER break playback
                        }
                });
                netEngine.registerRequestFilter((type, request) => {
                        try {
                                applyDashAuthSegmentRequest(type, request, session);
                        } catch {
                                // a filter must NEVER break playback
                        }
                });
                return session;
        } catch {
                return null;
        }
}
