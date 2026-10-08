// LT-9 + LT-11 — Signed query-auth propagation for LiveGT V1 (Live TV ONLY).
//
// ── LT-9 (DASH, production-proven in India) ─────────────────────────────
// PRODUCTION EVIDENCE (India Android Chrome, 2026-10-08, DevTools Network):
//   Star Gold HD (156): the LiveGT-resolved manifest URL carries the
//   short-lived signed query (`__hdnea__`); the manifest loads, playback
//   begins, and after ~3-4 seconds the Jio CDN rejects the DASH
//   media-segment requests with
//
//     HTTP 403  +  X-Error-Details: "No sub Token"  +  X-ErrType: auth-failure
//
//   The failing segment requests do NOT carry the signed query. Root cause:
//   DASH SegmentTemplate references are relative, and Shaka resolves them
//   per WHATWG against the manifest URL — which DROPS the manifest's query
//   string. Unless the MPD declares the DASH-IF UrlQueryInfo mechanism
//   (urn:mpeg:dash:urlparam:2014/2016), plain Shaka — including LiveGT's
//   own documented example — cannot satisfy the CDN's per-request token.
//   AFTER LT-9: India production confirms 156 plays continuously with the
//   media requests carrying `__hdnea__` (HTTP 200) — the mechanism is
//   correct and MUST be preserved.
//
// ── LT-11 (HLS generalization) ──────────────────────────────────────────
// EVIDENCE (2026-10-08, three independent sources):
//   1. MECHANISM (shaka-player 5.2.12 source, verified): the HLS parser
//      resolves variant-playlist and segment references through the SAME
//      `shaka.util.URL.resolveUris` (`new URL(relative, base)`) as DASH —
//      the master playlist's query is dropped for every relative child
//      reference, and the ONLY standard propagation mechanism is a
//      playlist-declared `#EXT-X-DEFINE:QUERYPARAM` (upstream's choice,
//      absent here). Variant/media playlists are requested as
//      RequestType.MANIFEST (hls_parser.js requestManifest_), segments as
//      RequestType.SEGMENT.
//   2. HOST POLICY (India production, LT-9): jiotvmblive.cdn.jio.com
//      enforces the per-request token on DASH segments ("No sub Token").
//      The HLSPartner HLS channels (e.g. B4U Music 183) sit on the SAME
//      host, and B4U fails in India production while the HLS control on a
//      DIFFERENT host (News18 Urdu 1500, nw18live) plays continuously.
//   3. REFERENCE DESIGN (LiveGT's own embed player, decoded from their
//      production bundles): their (currently dormant) Shaka player
//      propagates their credential to MANIFEST *and* SEGMENT requests for
//      both protocols via a networking request filter — i.e. query
//      propagation to HLS child requests is part of the upstream reference
//      design. (Their fallback tiers — a third-party proxy and the V2 API
//      — are OUT of Mavero's contract and are NOT used here.)
//
// THE FALLBACK (this module) — smallest correct Mavero-side fix:
//   A response filter identifies the manifest body (DASH `<MPD` or HLS
//   `#EXTM3U`) and records the final manifest URI; a request filter
//   appends ONLY the proven auth parameter(s) — byte-exact, from the
//   ALREADY-RESOLVED LiveGT V1 source URL — to SAME-ORIGIN requests that
//   lack them:
//     * RequestType.SEGMENT   — DASH (LT-9) and HLS (LT-11) sessions;
//     * RequestType.MANIFEST  — HLS sessions only (variant playlists; the
//       master itself already carries the query from the source URL, so
//       the already-present guard makes this a no-op for it).
//
// SECURITY CONSTRAINTS (all enforced structurally in this module):
//   * Allowlist: `__hdnea__` ONLY. Resolver census (LT-9, 30/30 sampled
//     channels): every V1 source URL carries exactly ["__hdnea__"] — no
//     other parameter is ever copied. No arbitrary query propagation.
//   * The token is never fetched anew, never persisted, never logged,
//     never placed in analytics, never exposed in errors (this module
//     has ZERO console calls and touches no storage APIs).
//   * DRM/license (LICENSE), KEY, timing and every other request type are
//     untouched — for BOTH protocols.
//   * Only the EXACT origin that served the manifest receives the
//     parameter — a request URL on any other origin/hostname is left
//     untouched (no cross-origin token leakage). For HLS the anchor is the
//     FIRST playlist response (the master); later media-playlist
//     responses never move it.
//   * Existing query parameters are preserved; an already-present auth
//     parameter is never duplicated or overwritten — so the standard
//     mechanisms (DASH-IF UrlQueryInfo, HLS #EXT-X-DEFINE:QUERYPARAM) and
//     playlist-embedded child queries always win and this fallback only
//     fills the gap.
//   * DASH sessions never gain MANIFEST-type propagation (an MPD request
//     is never rewritten — it already carries the signed query, and
//     failing manifests like the jiotvpllive 403 class are an upstream
//     authorization problem this module deliberately does not touch).
//
// The one data read here is the MANIFEST RESPONSE BODY (first bytes, to
// detect '<MPD' / '#EXTM3U') — this is Shaka's networking response, NOT
// Shaka's error object; the sniff result is a boolean and the bytes are
// never stored, logged, or emitted anywhere.

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
const AUTH_QUERY_PARAMS: readonly string[] = ['__hdnea__'];

/**
 * Per-session propagation state. Lives in runtime memory ONLY, for the
 * lifetime of one playback session: created from the already-resolved
 * source URL, mutated by the manifest response filter, garbage-collected
 * with the Shaka player (filters die with the player on teardown).
 */
export type MediaAuthSession = {
        /** The engine-known resolved source URL (signed — the token source). Never re-fetched. */
        readonly sourceUrl: string;
        /**
         * Final URI of the first identified manifest response (post-redirect)
         * — the same-origin anchor. For HLS this is the MASTER playlist;
         * later media-playlist responses never overwrite it.
         */
        manifestUri: string | null;
        /** True once a MANIFEST response body was identified as a DASH MPD. */
        isDash: boolean;
        /** True once a MANIFEST response body was identified as an HLS playlist. */
        isHls: boolean;
};

/** Create the per-session state from the already-resolved source URL. */
export function createMediaAuthSession(sourceUrl: string): MediaAuthSession {
        return { sourceUrl, manifestUri: null, isDash: false, isHls: false };
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
                if (AUTH_QUERY_PARAMS.includes(name)) parts.push(part);
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
 * start with '#EXTM3U' and are explicitly rejected (they are detected by
 * `looksLikeHlsPlaylist` instead).
 */
export function looksLikeDashManifest(data: unknown): boolean {
        const head = peekAscii(data).replace(/^\uFEFF/, '').trimStart();
        if (head.startsWith('#EXT')) return false; // HLS playlist
        return /<MPD[\s>]/.test(head.slice(0, 320)); // DASH root element
}

/**
 * True when a manifest response body looks like an HLS playlist (master OR
 * media — both start with '#EXTM3U'). Shaka requests both through
 * RequestType.MANIFEST (hls_parser.js requestManifest_), and BOTH need the
 * propagated query on token-enforcing CDNs (variant children resolve
 * against the master; segments against the variant).
 */
export function looksLikeHlsPlaylist(data: unknown): boolean {
        const head = peekAscii(data).replace(/^\uFEFF/, '').trimStart();
        return head.startsWith('#EXTM3U');
}

// ---------------------------------------------------------------------------
// Filter logic (pure — applied by the closures installed below).
// ---------------------------------------------------------------------------

/**
 * Append the proven auth query to ONE URL when the session is armed and
 * every safety condition holds. Shared core for segments and playlists.
 *
 * Returns the input UNCHANGED unless ALL of the following hold:
 *   1. the session is armed for the caller's request class (checked by the
 *      callers: SEGMENT → DASH or HLS; MANIFEST → HLS only);
 *   2. a manifest response URI is known (the same-origin anchor);
 *   3. the resolved source URL carries allowlisted auth parameter(s);
 *   4. the target URL does NOT already carry them (standard mechanisms —
 *      DASH-IF UrlQueryInfo / HLS #EXT-X-DEFINE:QUERYPARAM / embedded
 *      child queries — always win; never duplicated, never overwritten);
 *   5. the target URL shares the manifest's EXACT origin.
 */
function appendAuthQuery(url: string, session: MediaAuthSession): string {
        if (typeof url !== 'string' || url.length === 0) return url;
        if (!session.manifestUri) return url;
        const authParts = rawAuthQueryParts(session.sourceUrl);
        if (authParts.length === 0) return url;
        if (hasAuthQueryParam(url)) return url;
        if (!sameOrigin(url, session.manifestUri)) return url;
        const joiner = url.endsWith('?') ? '' : url.includes('?') ? '&' : '?';
        return url + joiner + authParts.join('&');
}

/**
 * Propagate the proven auth query to ONE media request URL (init/media
 * segments of DASH or HLS sessions). Pure.
 */
export function propagateMediaSegmentAuth(segmentUrl: string, session: MediaAuthSession): string {
        if (!session.isDash && !session.isHls) return segmentUrl;
        return appendAuthQuery(segmentUrl, session);
}

/**
 * Propagate the proven auth query to ONE HLS playlist URL (variant/media
 * playlists requested as MANIFEST type). DASH sessions are explicitly
 * unaffected — an MPD request already carries the signed query from the
 * source URL and is never rewritten. Pure.
 */
export function propagateHlsPlaylistAuth(playlistUrl: string, session: MediaAuthSession): string {
        if (!session.isHls) return playlistUrl;
        return appendAuthQuery(playlistUrl, session);
}

/**
 * Learn from a MANIFEST response: the delivery protocol (DASH MPD or HLS
 * playlist) and the same-origin anchor (the FIRST identified manifest
 * response — post-redirect; for HLS that is the master playlist, and later
 * media-playlist responses never move the anchor). No-op for every other
 * response type.
 */
export function applyMediaAuthManifestResponse(
        type: number,
        response: ShakaResponseLike | null | undefined,
        session: MediaAuthSession
): void {
        if (type !== SHAKA_REQUEST_TYPE.MANIFEST) return;
        const uri = typeof response?.uri === 'string' && response.uri.length > 0 ? response.uri : null;
        if (!uri) return;
        if (looksLikeDashManifest(response?.data)) {
                session.isDash = true;
                if (session.manifestUri === null) session.manifestUri = uri;
                return;
        }
        if (looksLikeHlsPlaylist(response?.data)) {
                session.isHls = true;
                if (session.manifestUri === null) session.manifestUri = uri;
        }
}

/**
 * Apply the fallback to a SEGMENT or HLS-playlist request (in place).
 * Every other request type — DRM/LICENSE, KEY, timing, … — is left
 * untouched, and MANIFEST-type requests are only ever modified for
 * HLS sessions (variant playlists).
 */
export function applyMediaAuthRequest(
        type: number,
        request: ShakaRequestLike | null | undefined,
        session: MediaAuthSession
): void {
        const uris = request?.uris;
        if (!Array.isArray(uris)) return;
        if (type === SHAKA_REQUEST_TYPE.SEGMENT) {
                for (let i = 0; i < uris.length; i++) {
                        const uri = uris[i] ?? '';
                        const next = propagateMediaSegmentAuth(uri, session);
                        if (next !== uri) uris[i] = next;
                }
                return;
        }
        if (type === SHAKA_REQUEST_TYPE.MANIFEST) {
                for (let i = 0; i < uris.length; i++) {
                        const uri = uris[i] ?? '';
                        const next = propagateHlsPlaylistAuth(uri, session);
                        if (next !== uri) uris[i] = next;
                }
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
export function installMediaAuthFilters(
        player: { getNetworkingEngine?: unknown } | null | undefined,
        sourceUrl: string
): MediaAuthSession | null {
        if (!player || typeof sourceUrl !== 'string' || sourceUrl.length === 0) return null;
        const session = createMediaAuthSession(sourceUrl);
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
                                applyMediaAuthManifestResponse(type, response, session);
                        } catch {
                                // a filter must NEVER break playback
                        }
                });
                netEngine.registerRequestFilter((type, request) => {
                        try {
                                applyMediaAuthRequest(type, request, session);
                        } catch {
                                // a filter must NEVER break playback
                        }
                });
                return session;
        } catch {
                return null;
        }
}
