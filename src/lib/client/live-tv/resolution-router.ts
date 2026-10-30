// ============================================================================
// LT-P5 — Unified Live TV playback resolution router (client, Live TV only).
//
// The RUNTIME dispatcher of the unified architecture: given the ordered,
// eligible candidate list produced by the server (`/api/livetv/playback/
// resolve` — the Phase 1 registry's own ordering), attempt each candidate
// ONCE, in order, through the playback mechanism its ENDPOINT KIND demands:
//
//   direct_stream → the EXISTING direct-playback engine
//                   (LiveTvPlaybackEngine — untouched; builtin resolver
//                   candidates go through the EXISTING fresh signed
//                   resolution in api.ts, so `__hdnea__`/ClearKey/media-auth
//                   behave byte-exactly)
//   embed_page    → the EXISTING iframe embed integration (LT-15 semantics)
//
// The engine is NEVER a source or a priority candidate: it is derived from
// the endpoint kind (server-side by the Phase 1 registry table, mirrored
// structurally on the wire). An embed URL can never reach the direct path
// and a manifest can never be mounted as an iframe.
//
// DETERMINISTIC LIFECYCLE (one session per selection):
//   idle → resolving → attempting → playing → (fallback → attempting)*
//        → playing | exhausted
//
// RACE & FAILURE CONTRACT:
//   * Monotonic session token + per-attempt ids; every continuation
//     re-checks the token and the engine identity — a late event from a
//     previous channel/engine can never advance the new session (the
//     page's own seq guard wraps this one more time).
//   * Each candidate is attempted AT MOST ONCE per session; the FIRST fatal
//     failure settles the attempt (a per-attempt latch makes duplicate
//     media error events unable to double-advance). Explicit retry = a new
//     session (fresh candidate fetch — config may have changed).
//   * Advance policy REUSES the pinned LT-15 classifier
//     (`shouldFallbackToEmbed`): autoplay_blocked and aborted never
//     advance; buffering is a state, never an advance trigger; the engine's
//     normalized 'error' event is the single fatal-failure surface for
//     direct attempts (the same one-point architecture as the shipped page).
//   * Bounded waits everywhere: the candidate fetch (10s), each direct
//     attempt's startup watchdog (20s to reach readiness), each embed
//     attempt's load window (12s to the iframe load event).
//   * An EMBED attempt whose iframe fired its load event is TERMINAL for
//     the session (LT-15 semantics): the cross-origin embed owns its own
//     player UI, and nothing past the load event is observable from this
//     document — that limitation is honest and documented, not guessed at.
//   * Cleanup on advance/switch/destroy: engines destroyed, watchdogs
//     cleared, controllers aborted, iframe unmounted.
//
// FLAG GATE (rollback lever):
//   `isUnifiedEnabled()` reads the flag ONCE per page session (cached,
//   fail-closed to FALSE). While FALSE the router is never started and the
//   page's legacy path runs byte-identical.
//
// COMPAT RULES (documented, tested):
//   * `resolved: false` (nothing configured for the selection) → the page
//     runs its untouched legacy path — this keeps LiveGT playback working
//     at activation time before an admin maps anything.
//   * A candidate-list transport failure → the legacy path as well (a
//     transient resolution outage must never kill playback).
//   * `resolved: true` with an EMPTY list (managed channel, nothing
//     eligible) → the HONEST generic retryable error — no silent bypass of
//     admin intent.
//
// SECURITY:
//   * The ONLY candidate material ever used comes from the server's
//     validated response (registry config URLs re-validated https+absolute
//     here; the builtin embed URL is built by the EXISTING
//     `buildLiveTvEmbedUrl` — the single LiveGT URL-construction site). No
//     client-supplied URL is ever treated as a playback source.
//   * The internal diagnostic trail records kinds + candidate ids ONLY —
//     never URLs, tokens, signed material or raw provider data. Nothing
//     here logs (zero console calls), persists or caches a resolution.
//   * Analytics reuse the CLOSED taxonomy only (play / error /
//     fallback_embed), payload-safe by construction.
// ============================================================================

import { LiveTvPlaybackEngine, type LiveTvPlaybackState } from './player';
import { LiveTvError, isLiveTvError } from './errors';
import { LiveTvPlaybackError, shouldFallbackToEmbed } from './player-errors';
import { buildLiveTvEmbedUrl, resolveLiveTvPlayback } from './api';
import { trackLiveTvError, trackLiveTvFallbackEmbed, trackLiveTvPlay } from './analytics';
import { isLivetvProxyUrl, livetvStreamProxyUrl } from '$lib/shared/livetv-proxy';

// ---------------------------------------------------------------------------
// Wire mirrors (structurally identical to the server's playback-resolver
// types; the parity is pinned field-by-field by the Phase 5 service suite).
// ---------------------------------------------------------------------------

export type LivetvRouterEngine = 'shaka_media_player' | 'iframe_embed';

export type LivetvRouterCandidate = {
        candidateId: string;
        engine: LivetvRouterEngine;
        endpointKind: 'direct_stream' | 'embed_page';
        streamFormat: 'dash' | 'hls' | null;
        url: string | null;
        resolver: 'builtin_livegt_v1' | null;
        sourceChannelId: string | null;
        label: string | null;
        /** 2026-10 round 29 — DRM metadata (clearkey + cookie) for Jio CDN streams. */
        drm: { type: 'clearkey'; keyId: string; key: string; cookie: string | null } | null;
};

export type LivetvRouterResolution = {
        unifiedEnabled: boolean;
        resolved: boolean;
        mode: 'explicit' | 'default' | null;
        candidates: LivetvRouterCandidate[];
};

// ---------------------------------------------------------------------------
// Bounded constants.
// ---------------------------------------------------------------------------

/** Candidate-list fetch timeout (same conservative class as the LT-2 client). */
export const LIVETV_ROUTER_RESOLVE_TIMEOUT_MS = 10_000;
/** Direct-attempt startup watchdog: readiness must be reached within this. */
export const LIVETV_ROUTER_DIRECT_WATCHDOG_MS = 20_000;
/** Embed-attempt load window (the iframe load event must fire within this). */
export const LIVETV_ROUTER_EMBED_WINDOW_MS = 12_000;
/** Hard candidate cap (mirrors the server's own cap — defense in depth). */
export const LIVETV_ROUTER_MAX_CANDIDATES = 12;
/** Diagnostic-trail bound (kinds + ids only). */
const TRAIL_LIMIT = 64;

/** The fixed generic exhausted-state message (no interpolation, ever). */
export const LIVETV_ROUTER_EXHAUSTED_MESSAGE = 'This channel could not be played right now. Try again.';
/**
 * Distinct message for a managed channel with ZERO eligible candidates at all
 * (e.g. the source has no playback endpoints yet) — clearer than the generic
 * 'could not be played / retry' text, which implies a transient failure.
 */
export const LIVETV_ROUTER_NO_STREAM_MESSAGE = 'No stream available for this source.';
/**
 * Shown when the only remaining candidates are DASH streams on a CORS-blocked
 * CDN — DASH is not proxied (out of scope), so it cannot play in the browser.
 */
export const LIVETV_ROUTER_DASH_UNSUPPORTED_MESSAGE = 'This channel uses DASH, which this browser cannot play directly. Try another source.';

// ---------------------------------------------------------------------------
// The pure iframe-src guard (also used by the player component for its
// unified embed prop — the component renders ONLY a src that passes this).
// ---------------------------------------------------------------------------

/** https + absolute + bounded length. Mirrors the server-side re-validation. */
export function isSafeLivetvEmbedSrc(value: unknown): string | null {
        if (typeof value !== 'string' || value.length === 0 || value.length > 2048) return null;
        try {
                const parsed = new URL(value);
                return parsed.protocol === 'https:' ? value : null;
        } catch {
                return null;
        }
}

// ---------------------------------------------------------------------------
// Flag fetch (module-cached; fail-closed false).
// ---------------------------------------------------------------------------

const FLAG_CACHE_TTL_MS = 60_000;
let flagCache: { value: boolean; expiresAt: number } | null = null;

/** Test seam — clears the module-level flag cache. */
export function resetUnifiedFlagCacheForTests(): void {
        flagCache = null;
}

type Timers = {
        setTimeout(fn: () => void, ms: number): ReturnType<typeof setTimeout>;
        clearTimeout(handle: ReturnType<typeof setTimeout>): void;
};

// CRITICAL (Illegal invocation fix #2): these must NOT be the bare globals.
// They are stored on an object and called as `this.timers.setTimeout(...)`,
// which binds `this` to the timers object; browsers brand-check
// setTimeout/clearTimeout (this must be a Window/WorkerGlobalScope) and throw
// `TypeError: Illegal invocation` SYNCHRONOUSLY. In fetchCandidates the first
// timer call runs BEFORE the try block, so it escaped as a raw TypeError
// (kind 'unknown') and the resolve fetch was never issued — every source failed
// with no network request. Node does not brand-check, so the tsx suite passed.
// The arrow wrappers call the globals with the global (lexical) context.
const defaultTimers: Timers = {
        setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
        clearTimeout: (handle: ReturnType<typeof setTimeout>) => clearTimeout(handle)
};

// ---------------------------------------------------------------------------
// The shared unified-flag gate (ONE flag, ONE read, ONE cache).
// ---------------------------------------------------------------------------

/**
 * The ONE unified-flag read (module-cached, fail-closed FALSE — the legacy
 * path is always the safe direction). BOTH the router's session gate and the
 * Phase 6 catalogue/guide loaders share THIS implementation and THIS cache:
 * single-gate ownership (one flag, one read path, one TTL). The page itself
 * never fetches the flag (it consumes this export through the Live TV client
 * family instead — pinned by the Phase 5 page suite).
 */
export async function isUnifiedLivetvGateEnabled(
        fetchFn: typeof fetch = fetch,
        baseUrl = '',
        timers: Timers = defaultTimers
): Promise<boolean> {
        const now = Date.now();
        if (flagCache && flagCache.expiresAt > now) return flagCache.value;
        let value = false;
        try {
                const controller = new AbortController();
                const timer = timers.setTimeout(() => controller.abort(), LIVETV_ROUTER_RESOLVE_TIMEOUT_MS);
                try {
                        const response = await fetchFn(`${baseUrl}/api/livetv/playback/config`, { signal: controller.signal, headers: { accept: 'application/json' } });
                        if (response.ok) {
                                const body: unknown = await response.json();
                                if (isRecord(body) && typeof body.unifiedEnabled === 'boolean') value = body.unifiedEnabled;
                        }
                } finally {
                        timers.clearTimeout(timer);
                }
        } catch {
                value = false;
        }
        flagCache = { value, expiresAt: now + FLAG_CACHE_TTL_MS };
        return value;
}

// ---------------------------------------------------------------------------
// The router.
// ---------------------------------------------------------------------------

export type LiveTvRouterHandlers = {
        /** The active engine for the session (null between attempts/terminal). */
        onengine: (engine: LiveTvPlaybackEngine | null) => void;
        /** The session is resolving/attempting (drives the connecting overlay). */
        onresolving: (resolving: boolean) => void;
        /** Terminal safe message (exhausted); null clears it. */
        onsessionerror: (message: string | null) => void;
        /** Mount/unmount the unified embed iframe (a validated src or null). */
        onembed: (src: string | null) => void;
        /** First readiness of the session (the page records the recent row). */
        onplayed: () => void;
};

export type LiveTvRouterOptions = {
        handlers: LiveTvRouterHandlers;
        /** Injectable engine factory (tests); defaults to the real engine. */
        createEngine?: () => LiveTvPlaybackEngine;
        /** Injectable resolver call (tests); defaults to the real LT-2 client. */
        resolveLivegtPlayback?: typeof resolveLiveTvPlayback;
        /** Injectable fetch (tests); defaults to global fetch. */
        fetchFn?: typeof fetch;
        /** Injectable timers (tests); defaults to the global ones. */
        timers?: Timers;
        /** Injectable base origin for the two endpoints (tests). */
        baseUrl?: string;
        /** Absolute base of an external stream proxy (Cloudflare Worker); omit for same-origin. */
        streamProxyBase?: string;
};

/** Router lifecycle states (the Phase 5 brief's deterministic machine). */
export type LiveTvRouterState = 'idle' | 'resolving' | 'attempting' | 'playing' | 'fallback' | 'exhausted';

/** One diagnostic-trail entry (kinds + ids ONLY — never URLs or tokens). */
export type LiveTvRouterTrailEntry = {
        attemptId: string;
        candidateId: string;
        outcome: 'failed' | 'timeout' | 'skipped' | 'ready' | 'mounted' | 'aborted';
        detail: string;
};

type Attempt = {
        attemptId: string;
        candidate: LivetvRouterCandidate;
        kind: 'direct' | 'embed';
        settled: boolean;
        settle: (outcome: 'ready' | 'failed') => void;
};

export class LiveTvPlaybackRouter {
        private readonly handlers: LiveTvRouterHandlers;
        private readonly createEngine: () => LiveTvPlaybackEngine;
        private readonly resolveLivegt: typeof resolveLiveTvPlayback;
        private readonly fetchFn: typeof fetch;
        private readonly timers: Timers;
        private readonly baseUrl: string;
        /** Absolute base of an external stream proxy (e.g. a Cloudflare Worker); '' = same-origin. */
        private readonly streamProxyBase: string;

        /** Monotonic session token — the stale-guard root. */
        private sessionToken = 0;
        private state: LiveTvRouterState = 'idle';

        // Per-session data (valid only while the token matches).
        private controller: AbortController | null = null;
        private engine: LiveTvPlaybackEngine | null = null;
        private engineUnsub: (() => void) | null = null;
        private candidates: LivetvRouterCandidate[] = [];
        private attempted = new Set<string>();
        private playTracked = false;
        private playedReported = false;
        private embedMountedSrc: string | null = null;
        private embedLoaded = false;
        /** The session's most recent failure (drives the fallback-embed event). */
        private lastFailure: unknown = null;
        /** True once a candidate was skipped as DASH on a CORS-blocked CDN. */
        private sawDashBlocked = false;
        private trail: LiveTvRouterTrailEntry[] = [];

        /** The in-flight attempt (exactly one at a time). */
        private attempt: Attempt | null = null;

        constructor(options: LiveTvRouterOptions) {
                this.handlers = options.handlers;
                this.createEngine = options.createEngine ?? (() => new LiveTvPlaybackEngine());
                this.resolveLivegt = options.resolveLivegtPlayback ?? resolveLiveTvPlayback;
                // CRITICAL (Illegal invocation fix): NEVER store the bare global
                // `fetch`. Calling it later as `this.fetchFn(...)` binds `this` to
                // the router instance, and browsers brand-check `fetch` (its `this`
                // must be a Window/WorkerGlobalScope) — that throws
                // `TypeError: Illegal invocation` SYNCHRONOUSLY, before any network
                // request is sent, which the router then reports as a transport
                // failure ('legacy'). Node's undici fetch does NOT brand-check, which
                // is why the tsx test suite passed while production (browser) failed.
                // The arrow wrapper calls `fetch(...args)` with the global context.
                this.fetchFn = options.fetchFn ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
                this.timers = options.timers ?? defaultTimers;
                this.baseUrl = options.baseUrl ?? '';
                this.streamProxyBase = options.streamProxyBase ?? '';
        }

        /** The current lifecycle state (diagnostics/tests). */
        getState(): LiveTvRouterState {
                return this.state;
        }

        /** The bounded diagnostic trail (kinds + ids only). */
        getTrail(): readonly LiveTvRouterTrailEntry[] {
                return [...this.trail];
        }

        /**
         * Whether the unified router may run at all. Cached per page session,
         * fail-closed to FALSE (the legacy path is always the safe direction).
         * Delegates to the shared module gate (one flag read implementation).
         */
        async isUnifiedEnabled(): Promise<boolean> {
                return isUnifiedLivetvGateEnabled(this.fetchFn, this.baseUrl, this.timers);
        }

        /**
         * R-1 — READ-ONLY availability probe for one selection id (the
         * source-switch pre-check): resolves the selection through the same
         * bounded server endpoint and reports whether a usable candidate
         * list exists. NO session state is mutated — current playback is
         * never touched (a switch that cannot be resolved leaves the prior
         * stream intact). Fail-closed: transport errors, timeouts and
         * anything not explicitly available resolve false.
         */
        async probeSelection(selectionId: string, signal?: AbortSignal): Promise<boolean> {
                if (signal?.aborted) return false; // the caller already lost interest — fail closed
                try {
                        const controller = new AbortController();
                        const onExternalAbort = () => controller.abort();
                        if (signal) signal.addEventListener('abort', onExternalAbort, { once: true });
                        try {
                                const resolution = await this.fetchCandidates(selectionId, controller.signal);
                                return resolution.resolved && resolution.candidates.length > 0;
                        } finally {
                                if (signal) signal.removeEventListener('abort', onExternalAbort);
                        }
                } catch {
                        return false;
                }
        }

        /**
         * Run one playback session for the selected channel.
         *
         * Returns 'handled' when the router owns the session's outcome
         * (including the honest exhausted error) and 'legacy' when the page
         * must run its untouched legacy path instead (flag off, resolution
         * unavailable, or nothing configured for this selection).
         */
        async start(channel: { id: string; name: string }, video: HTMLVideoElement, signal?: AbortSignal): Promise<'handled' | 'legacy'> {
                // R-11 — Diagnostic logging to pinpoint the playback failure.
                // R-9 — UNIFIED PLAYBACK FOR ALL CATALOGUE IDS. After R-3, the
                // catalogue is ALWAYS source-first — ALL channel IDs are
                // registry-governed (entry:<uuid> for unmapped, canonical UUID
                // for mapped). The legacy LiveGT V1 API does NOT recognize
                // either ID type. The router must call fetchCandidates() for
                // ALL selections and let the server resolver decide what to
                // return.
                //
                // The unified_enabled flag is the owner's lever for the
                // BUILTIN LiveGT V1 VIRTUAL PAIR SYNTHESIS (server-side, in
                // the resolver). It does NOT gate the client-side router's
                // fetchCandidates call. When the flag is OFF:
                //   - entry: IDs → resolved by the entry's own endpoints (R-4)
                //   - canonical IDs → resolved: false (the resolver returns
                //     unresolvedWire(false) for the builtin path)
                // When the flag is ON:
                //   - entry: IDs → same
                //   - canonical IDs → resolved through the builtin virtual pair
                //     + default-mode ordering (source priority + endpoints)
                //
                // The 'legacy' return value is preserved ONLY for transport
                // failures and resolved: false (genuine "nothing configured").
                // The page shows an honest error for 'legacy' — it does NOT
                // call resolveLiveTvPlayback with a catalogue ID.

                // Teardown ANY previous session (duplicate-concurrent guard):
                // engines destroyed, timers cleared, iframe unmounted.
                this.teardownSession('superseded');

                const token = ++this.sessionToken;
                const controller = new AbortController();
                this.controller = controller;
                if (signal && !signal.aborted) {
                        const onExternalAbort = () => controller.abort();
                        signal.addEventListener('abort', onExternalAbort, { once: true });
                }
                this.candidates = [];
                this.attempted = new Set();
                this.playTracked = false;
                this.playedReported = false;
                this.embedMountedSrc = null;
                this.embedLoaded = false;
                this.lastFailure = null;
                this.sawDashBlocked = false;
                this.currentVideo = video;
                this.trail = [];
                this.setState('resolving');
                this.handlers.onsessionerror(null);
                this.handlers.onresolving(true);

                // External abort ends the whole session silently.
                const abortHandler = () => {
                        if (token !== this.sessionToken) return;
                        this.teardownSession('superseded');
                };
                controller.signal.addEventListener('abort', abortHandler, { once: true });

                // 1. The ordered candidate list (server-derived; bounded).
                let resolution: LivetvRouterResolution | null = null;
                try {
                        resolution = await this.fetchCandidates(channel.id, controller.signal);
                } catch (err) {
                        // Transport failure — fail-closed to the legacy path
                        // (documented compat rule; playback must not die with
                        // a transient resolution outage).
                        if (token !== this.sessionToken) return 'handled';
                        this.teardownSession('resolve_failed');
                        return 'legacy';
                }
                if (token !== this.sessionToken || controller.signal.aborted) return 'handled';

                if (!resolution.resolved) {
                        // Nothing configured for this selection — the documented
                        // legacy compatibility path keeps LiveGT playback alive.
                        this.setState('idle');
                        this.handlers.onresolving(false);
                        return 'legacy';
                }

                this.candidates = resolution.candidates.slice(0, LIVETV_ROUTER_MAX_CANDIDATES);
                if (this.candidates.length === 0) {
                        // Managed channel, nothing eligible — HONEST exhausted
                        // error (never a silent fallback that would bypass the
                        // admin's configuration intent).
                        this.handlers.onengine(null);
                        this.handlers.onresolving(false);
                        this.setState('exhausted');
                        // Nothing eligible is configured for this selection — a
                        // distinct, non-transient message (not 'try again').
                        this.handlers.onsessionerror(LIVETV_ROUTER_NO_STREAM_MESSAGE);
                        return 'handled';
                }

                // 2. Attempt each eligible candidate exactly once, in order.
                this.setState('attempting');
                await this.runCandidateLoop(token, channel, video, controller.signal);
                return 'handled';
        }

        /**
         * The embed iframe's load event (forwarded by the player component).
         * A loaded embed is the session's terminal success (LT-15 semantics).
         */
        noteEmbedLoaded(): void {
                this.embedLoaded = true;
                const current = this.attempt;
                if (!current || current.kind !== 'embed' || current.settled) return;
                if (this.engine) return; // an engine session owns the surface — not an embed
                this.trailPush({ attemptId: current.attemptId, candidateId: current.candidate.candidateId, outcome: 'ready', detail: 'embed_loaded' });
                current.settle('ready');
        }

        /** Cancel the current session and release everything (page teardown). */
        destroy(): void {
                this.teardownSession('destroyed');
                this.sessionToken += 1;
        }

        // -----------------------------------------------------------------
        // Session internals.
        // -----------------------------------------------------------------

        private setState(state: LiveTvRouterState): void {
                this.state = state;
        }

        private trailPush(entry: LiveTvRouterTrailEntry): void {
                this.trail.push(entry);
                if (this.trail.length > TRAIL_LIMIT) this.trail.splice(0, this.trail.length - TRAIL_LIMIT);
        }

        /**
         * The candidate loop: every candidate is attempted AT MOST ONCE, in
         * the server-derived order. `attempt()` resolves 'ready' (session
         * playing — stop) or 'failed' (advance). A mid-session fatal on a
         * PLAYING direct session re-enters this loop via `onEngineFatal`.
         */
        private async runCandidateLoop(token: number, channel: { id: string; name: string }, video: HTMLVideoElement, signal: AbortSignal): Promise<void> {
                for (;;) {
                        if (token !== this.sessionToken || signal.aborted) return;
                        const candidate = this.candidates.find((entry) => !this.attempted.has(entry.candidateId));
                        if (!candidate) {
                                // Every candidate failed — the generic retryable error.
                                this.teardownPlayback('exhausted');
                                this.handlers.onresolving(false);
                                this.setState('exhausted');
                                this.handlers.onsessionerror(this.sawDashBlocked ? LIVETV_ROUTER_DASH_UNSUPPORTED_MESSAGE : LIVETV_ROUTER_EXHAUSTED_MESSAGE);
                                return;
                        }
                        this.attempted.add(candidate.candidateId);
                        const outcome = await this.runAttempt(candidate, token, channel, video, signal);
                        this.attempt = null; // the attempt is settled — no deferred may dangle
                        if (token !== this.sessionToken || signal.aborted) return;
                        if (outcome === 'ready') {
                                this.handlers.onresolving(false);
                                this.setState('playing');
                                return;
                        }
                        if (this.state !== 'fallback') this.setState('fallback');
                }
        }

        private async fetchCandidates(channelId: string, signal: AbortSignal): Promise<LivetvRouterResolution> {
                if (signal.aborted) {
                        throw new LiveTvError('aborted', {});
                }
                // Bind the timers to LOCALS before use: `this.timers.setTimeout(...)`
                // binds `this` to the timers object, and browsers brand-check
                // setTimeout — that throws `TypeError: Illegal invocation` before the
                // fetch is ever issued. Locals keep the global context.
                const setT = this.timers.setTimeout;
                const clearT = this.timers.clearTimeout;
                const controller = new AbortController();
                let timedOut = false;
                const timer = setT(() => {
                        timedOut = true;
                        controller.abort();
                }, LIVETV_ROUTER_RESOLVE_TIMEOUT_MS);
                const onExternalAbort = () => controller.abort();
                signal.addEventListener('abort', onExternalAbort, { once: true });
                try {
                        const url = `${this.baseUrl}/api/livetv/playback/resolve?channelId=${encodeURIComponent(channelId)}`;
                        // Call via a local so a caller-injected unbound `fetch` cannot
                        // re-introduce the Illegal-invocation binding bug either.
                        const doFetch = this.fetchFn;
                        const response = await doFetch(url, { signal: controller.signal, headers: { accept: 'application/json' } });
                        if (!response.ok) {
                                const kind = response.status === 404 ? 'not_found' : response.status === 429 ? 'rate_limited' : 'server';
                                throw new LiveTvError(kind, { status: response.status });
                        }
                        // R-7 — Content-Type safety: reject HTML before .json().
                        const ct = response.headers.get('content-type') ?? '';
                        if (!ct.includes('json')) {
                                throw new LiveTvError('invalid_response', {});
                        }
                        const body: unknown = await response.json();
                        return normalizeRouterResolution(body);
                } catch (err) {
                        if (signal.aborted) throw new LiveTvError('aborted', {});
                        if (timedOut) throw new LiveTvError('timeout', {});
                        if (err instanceof LiveTvError) throw err;
                        throw new LiveTvError('network', {});
                } finally {
                        clearT(timer);
                        signal.removeEventListener('abort', onExternalAbort);
                }
        }

        // -----------------------------------------------------------------
        // One candidate attempt.
        // -----------------------------------------------------------------

        /**
         * One candidate attempt — resolves 'ready' or 'failed' exactly once.
         * Direct attempts settle via load-success / the engine's fatal error
         * event / the startup watchdog. Embed attempts settle via the
         * forwarded iframe load event / the bounded load window.
         */
        private async runAttempt(candidate: LivetvRouterCandidate, token: number, channel: { id: string; name: string }, video: HTMLVideoElement, signal: AbortSignal): Promise<'ready' | 'failed'> {
                const attemptId = `${token}:${this.attempted.size}`;
                return new Promise<'ready' | 'failed'>((resolve) => {
                        // The SINGLE settle latch: closure-owned, idempotent, and
                        // mirrored onto the attempt record for external guards.
                        let settled = false;
                        const settle = (outcome: 'ready' | 'failed') => {
                                if (settled) return;
                                settled = true;
                                const current = this.attempt;
                                if (current) current.settled = true;
                                this.clearWatchdog();
                                resolve(outcome);
                        };
                        const kind = candidate.endpointKind === 'embed_page' ? 'embed' : 'direct';
                        this.attempt = { attemptId, candidate, kind, settled: false, settle };

                        if (kind === 'embed') {
                                void this.beginEmbedAttempt(attemptId, candidate, channel, token, signal);
                        } else {
                                void this.beginDirectAttempt(attemptId, candidate, channel, video, token, signal);
                        }
                });
        }

        // -----------------------------------------------------------------
        // Direct attempts (the existing engine; existing fresh resolution).
        // -----------------------------------------------------------------

        private async beginDirectAttempt(attemptId: string, candidate: LivetvRouterCandidate, channel: { id: string; name: string }, video: HTMLVideoElement, token: number, signal: AbortSignal): Promise<void> {
                // 1. Produce the resolution for this candidate.
                let resolution: Parameters<LiveTvPlaybackEngine['load']>[1];
                if (candidate.resolver === 'builtin_livegt_v1') {
                        // The builtin's fresh-signed contract: the EXISTING LT-2
                        // client resolves (network, timeout, abort, normalization
                        // all unchanged). The result lives in this local only —
                        // never stored, never logged.
                        const sourceChannelId = candidate.sourceChannelId;
                        if (typeof sourceChannelId !== 'string' || sourceChannelId.length === 0) {
                                this.trailPush({ attemptId, candidateId: candidate.candidateId, outcome: 'skipped', detail: 'invalid_resolver_id' });
                                this.settleCurrent('failed');
                                return;
                        }
                        try {
                                resolution = await this.resolveLivegt(sourceChannelId, { signal });
                        } catch (err) {
                                if (token !== this.sessionToken || signal.aborted) {
                                        this.trailPush({ attemptId, candidateId: candidate.candidateId, outcome: 'aborted', detail: 'resolve_aborted' });
                                        this.settleCurrent('failed');
                                        return;
                                }
                                this.trailPush({ attemptId, candidateId: candidate.candidateId, outcome: 'failed', detail: `resolve:${isLiveTvError(err) ? err.kind : 'unknown'}` });
                                trackLiveTvError(channel.id, err);
                                this.lastFailure = err;
                                this.settleCurrent('failed');
                                return;
                        }
                } else {
                        // A registry endpoint: its CONFIG url (re-validated here —
                        // the server validated too; this is the player surface).
                        if (candidate.url === null || isSafeLivetvEmbedSrc(candidate.url) === null) {
                                this.trailPush({ attemptId, candidateId: candidate.candidateId, outcome: 'skipped', detail: 'invalid_endpoint_url' });
                                this.settleCurrent('failed');
                                return;
                        }
                        // 2026-10 round 6 — Task 2: DASH is now SUPPORTED. Shaka Player
                        // handles DASH manifests natively. DASH from a CORS-blocked CDN
                        // is routed through the Cloudflare Worker proxy (the Worker
                        // rewrites the MPD's BaseURL + segment URLs). HLS proxy routing
                        // is unchanged.
                        let mediaUrl = candidate.url;
                        if (isLivetvProxyUrl(mediaUrl)) {
                                // HLS or DASH from a CORS-blocked CDN → route via the proxy.
                                const origin = typeof location !== 'undefined' ? location.origin : '';
                                if (origin) mediaUrl = new URL(livetvStreamProxyUrl(mediaUrl, this.streamProxyBase), origin).toString();
                        }
                        resolution = { channel: { id: channel.id, name: channel.name }, sources: [{ url: mediaUrl }], drm: candidate.drm ?? null };
                }
                if (token !== this.sessionToken || signal.aborted) {
                        this.trailPush({ attemptId, candidateId: candidate.candidateId, outcome: 'aborted', detail: 'session_superseded' });
                        this.settleCurrent('failed');
                        return;
                }

                // 2. Tear down the previous surface, then load the EXISTING
                //    engine on the caller-owned element (exactly one engine).
                this.teardownPlayback(`advance:${attemptId}`);
                const engine = this.createEngine();
                this.engine = engine;
                this.handlers.onengine(engine);
                this.observeEngine(engine, channel, attemptId, candidate);

                // 3. The bounded startup watchdog.
                const watchdog = this.timers.setTimeout(() => {
                        if (this.engine !== engine) return;
                        const current = this.attempt;
                        if (!current || current.settled) return;
                        this.trailPush({ attemptId, candidateId: candidate.candidateId, outcome: 'timeout', detail: 'startup_watchdog' });
                        const timeoutError = new LiveTvError('timeout', {});
                        trackLiveTvError(channel.id, timeoutError);
                        this.lastFailure = timeoutError;
                        // Destroy the engine so the pending load cannot resolve later.
                        this.destroyEngine();
                        current.settle('failed');
                }, LIVETV_ROUTER_DIRECT_WATCHDOG_MS);
                this.watchdog = watchdog;

                // 4. Load. The engine's normalized 'error' event is the single
                //    fatal surface (observeEngine above); the load rejection is
                //    defensive-only (an aborted rejection is silence).
                try {
                        await engine.load(video, resolution, { signal });
                } catch (err) {
                        if (this.engine !== engine) return; // stale — already handled
                        const current = this.attempt;
                        if (!current || current.settled) return;
                        if (signal.aborted || token !== this.sessionToken) {
                                this.trailPush({ attemptId, candidateId: candidate.candidateId, outcome: 'aborted', detail: 'load_aborted' });
                                current.settle('failed');
                                return;
                        }
                        // Defensive: a rejection without the engine's 'error' event
                        // (never observed) still fails the attempt — classified
                        // through the same safe path, never interpolated.
                        this.trailPush({ attemptId, candidateId: candidate.candidateId, outcome: 'failed', detail: 'load_rejected' });
                        trackLiveTvError(channel.id, err);
                        this.lastFailure = err;
                        this.destroyEngine();
                        current.settle('failed');
                        return;
                }
                if (this.engine !== engine) return; // stale
                const current = this.attempt;
                if (!current || current.settled) return;
                // Loaded = readiness. First readiness reports the played row.
                this.clearWatchdog();
                this.trailPush({ attemptId, candidateId: candidate.candidateId, outcome: 'ready', detail: 'loaded' });
                if (!this.playedReported) {
                        this.playedReported = true;
                        this.handlers.onplayed();
                }
                current.settle('ready');
        }

        // -----------------------------------------------------------------
        // Embed attempts (the existing iframe integration; bounded window).
        // -----------------------------------------------------------------

        private async beginEmbedAttempt(attemptId: string, candidate: LivetvRouterCandidate, channel: { id: string; name: string }, token: number, signal: AbortSignal): Promise<void> {
                let src: string | null = null;
                if (candidate.resolver === 'builtin_livegt_v1') {
                        // The documented LiveGT embed contract — built by the
                        // EXISTING builder (the single URL-construction site);
                        // a non-numeric id yields null → the candidate is skipped.
                        src = buildLiveTvEmbedUrl(candidate.sourceChannelId);
                } else {
                        src = isSafeLivetvEmbedSrc(candidate.url);
                }
                if (src === null) {
                        this.trailPush({ attemptId, candidateId: candidate.candidateId, outcome: 'skipped', detail: 'invalid_embed_src' });
                        this.settleCurrent('failed');
                        return;
                }
                if (token !== this.sessionToken || signal.aborted) {
                        this.trailPush({ attemptId, candidateId: candidate.candidateId, outcome: 'aborted', detail: 'session_superseded' });
                        this.settleCurrent('failed');
                        return;
                }

                this.teardownPlayback(`advance:${attemptId}`);
                this.embedMountedSrc = src;
                this.embedLoaded = false;
                this.handlers.onembed(src);
                this.trailPush({ attemptId, candidateId: candidate.candidateId, outcome: 'mounted', detail: 'embed_mounted' });
                // The pinned LT-15 analytics: the embed fallback activating
                // AFTER a genuine failure carries the triggering failure. An
                // embed candidate attempted FIRST (admin-ordered) is a primary
                // selection, not a fallback — no event.
                if (this.lastFailure !== null) trackLiveTvFallbackEmbed(channel.id, this.lastFailure);

                // Bounded load window: the component forwards the iframe's load
                // event via noteEmbedLoaded(). A fired load = the session is
                // handed to the embed player (terminal success — LT-15).
                const window = this.timers.setTimeout(() => {
                        if (this.embedMountedSrc !== src) return; // already unmounted
                        const current = this.attempt;
                        if (!current || current.settled) return;
                        this.trailPush({ attemptId, candidateId: candidate.candidateId, outcome: 'timeout', detail: 'embed_load_window' });
                        const timeoutError = new LiveTvError('timeout', {});
                        trackLiveTvError(channel.id, timeoutError);
                        this.lastFailure = timeoutError;
                        this.unmountEmbed();
                        current.settle('failed');
                }, LIVETV_ROUTER_EMBED_WINDOW_MS);
                this.watchdog = window;
        }

        // -----------------------------------------------------------------
        // Engine observation (the session-level fatal path).
        // -----------------------------------------------------------------

        /**
         * Subscribe to the engine's normalized events for the duration of the
         * session. The 'error' event is the SINGLE fatal surface (load-phase
         * AND mid-session) — the same one-point architecture as the shipped
         * page. A fatal during an attempt settles it; a fatal while PLAYING
         * re-enters the candidate loop (automatic bounded recovery).
         */
        private observeEngine(engine: LiveTvPlaybackEngine, channel: { id: string; name: string }, attemptId: string, candidate: LivetvRouterCandidate): void {
                const offError = engine.on('error', (error: LiveTvPlaybackError) => {
                        if (this.engine !== engine) return; // stale engine identity
                        if (!shouldFallbackToEmbed(error)) return; // autoplay/aborted never advance
                        const current = this.attempt;
                        if (current && !current.settled) {
                                // Failure during the attempt (load-phase or early).
                                this.trailPush({ attemptId: current.attemptId, candidateId: current.candidate.candidateId, outcome: 'failed', detail: `engine:${error.kind}` });
                                trackLiveTvError(channel.id, error);
                                this.lastFailure = error;
                                this.destroyEngine();
                                current.settle('failed');
                                return;
                        }
                        // Mid-session fatal on a PLAYING session (no pending
                        // attempt): bounded automatic recovery — advance to the
                        // next eligible candidate of THIS session.
                        if (this.state === 'playing') {
                                this.trailPush({ attemptId, candidateId: candidate.candidateId, outcome: 'failed', detail: `engine_mid_session:${error.kind}` });
                                trackLiveTvError(channel.id, error);
                                this.lastFailure = error;
                                this.destroyEngine();
                                this.setState('fallback');
                                const token = this.sessionToken;
                                const controller = this.controller;
                                if (controller) {
                                        const activeChannel = { id: channel.id, name: channel.name };
                                        void this.runMidSessionAdvance(token, activeChannel, controller.signal);
                                }
                        }
                });
                const offState = engine.on('statechange', ({ state }: { state: LiveTvPlaybackState }) => {
                        if (this.engine !== engine) return;
                        if (state === 'playing' && !this.playTracked) {
                                this.playTracked = true;
                                trackLiveTvPlay(channel.id);
                        }
                });
                this.engineUnsub = () => {
                        offError();
                        offState();
                };
        }

        /**
         * Mid-session recovery: re-run the candidate loop for the REMAINING
         * candidates of the SAME session (each still at-most-once). Without
         * the video element (structurally unreachable — the session owns it)
         * recovery cannot reload, so it stops honestly.
         */
        private async runMidSessionAdvance(token: number, channel: { id: string; name: string }, signal: AbortSignal): Promise<void> {
                const video = this.currentVideo;
                if (!video) return;
                await this.runCandidateLoop(token, channel, video, signal);
        }

        /** The video element of the session (for mid-session recovery). */
        private currentVideo: HTMLVideoElement | null = null;

        // -----------------------------------------------------------------
        // Teardown helpers.
        // -----------------------------------------------------------------

        private watchdog: ReturnType<typeof setTimeout> | null = null;

        private clearWatchdog(): void {
                if (this.watchdog !== null) {
                        this.timers.clearTimeout(this.watchdog);
                        this.watchdog = null;
                }
        }

        private destroyEngine(): void {
                this.clearEngineSubscription();
                if (this.engine) {
                        const engine = this.engine;
                        this.engine = null;
                        this.handlers.onengine(null);
                        try {
                                void engine.destroy();
                        } catch {
                                // destroy is idempotent per the LT-3 contract; never throw.
                        }
                }
        }

        private clearEngineSubscription(): void {
                if (this.engineUnsub) {
                        try {
                                this.engineUnsub();
                        } catch {
                                // never throw
                        }
                        this.engineUnsub = null;
                }
        }

        private unmountEmbed(): void {
                if (this.embedMountedSrc !== null) {
                        this.embedMountedSrc = null;
                        this.embedLoaded = false;
                        this.handlers.onembed(null);
                }
        }

        /** Tear down playback surfaces but keep the session bookkeeping. */
        private teardownPlayback(reason: string): void {
                this.clearWatchdog();
                this.destroyEngine();
                this.unmountEmbed();
                this.trailPush({ attemptId: `${this.sessionToken}:end`, candidateId: '-', outcome: 'failed', detail: reason });
        }

        /** Full session teardown (bookkeeping + surfaces + state). */
        private teardownSession(reason: string): void {
                this.clearWatchdog();
                if (this.controller) {
                        try {
                                this.controller.abort();
                        } catch {
                                // never throw
                        }
                        this.controller = null;
                }
                this.destroyEngine();
                this.unmountEmbed();
                this.candidates = [];
                this.attempted.clear();
                // Settle ANY pending attempt — the loop's await must unwind even
                // when the underlying engine never rejects (the deferred is
                // router-owned; the session it belonged to is now superseded).
                const pending = this.attempt;
                this.attempt = null;
                this.currentVideo = null;
                if (pending && !pending.settled) {
                        pending.settled = true;
                        pending.settle('failed');
                }
                if (this.state !== 'idle') this.setState('idle');
                this.trailPush({ attemptId: `${this.sessionToken}:teardown`, candidateId: '-', outcome: 'failed', detail: reason });
        }

        private settleCurrent(outcome: 'ready' | 'failed'): void {
                const current = this.attempt;
                if (!current || current.settled) return;
                current.settle(outcome);
        }
}

// ---------------------------------------------------------------------------
// Wire normalization — malformed candidates are dropped, never coerced.
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
        return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeRouterCandidate(raw: unknown): LivetvRouterCandidate | null {
        if (!isRecord(raw)) return null;
        if (typeof raw.candidateId !== 'string' || raw.candidateId.length === 0 || raw.candidateId.length > 200) return null;
        if (raw.engine !== 'shaka_media_player' && raw.engine !== 'iframe_embed') return null;
        if (raw.endpointKind !== 'direct_stream' && raw.endpointKind !== 'embed_page') return null;
        if (raw.streamFormat !== null && raw.streamFormat !== 'dash' && raw.streamFormat !== 'hls') return null;
        if (raw.url !== null && typeof raw.url !== 'string') return null;
        if (raw.resolver !== null && raw.resolver !== 'builtin_livegt_v1') return null;
        if (raw.sourceChannelId !== null && typeof raw.sourceChannelId !== 'string') return null;
        if (raw.label !== null && typeof raw.label !== 'string') return null;
        // 2026-10 round 29 — extract DRM metadata (clearkey + cookie).
        let drm: LivetvRouterCandidate['drm'] = null;
        if (isRecord(raw.drm) && raw.drm.type === 'clearkey' && typeof raw.drm.keyId === 'string' && typeof raw.drm.key === 'string') {
                drm = { type: 'clearkey', keyId: raw.drm.keyId, key: raw.drm.key, cookie: typeof raw.drm.cookie === 'string' ? raw.drm.cookie : null };
        }
        const candidate: LivetvRouterCandidate = {
                candidateId: raw.candidateId,
                engine: raw.engine,
                endpointKind: raw.endpointKind,
                streamFormat: raw.streamFormat,
                url: raw.url,
                resolver: raw.resolver,
                sourceChannelId: raw.sourceChannelId,
                label: raw.label,
                drm
        };
        // Cross-field discipline (defense in depth — the server enforces the
        // same shape): a direct candidate carries EITHER the builtin resolver
        // contract OR a safe https url; same for an embed candidate.
        if (candidate.resolver === 'builtin_livegt_v1') {
                if (typeof candidate.sourceChannelId !== 'string' || candidate.sourceChannelId.length === 0) return null;
                return candidate;
        }
        if (candidate.url === null || isSafeLivetvEmbedSrc(candidate.url) === null) return null;
        return candidate;
}

function normalizeRouterResolution(body: unknown): LivetvRouterResolution {
        if (!isRecord(body) || body.ok !== true) throw new LiveTvError('invalid_response', {});
        if (typeof body.unifiedEnabled !== 'boolean' || typeof body.resolved !== 'boolean') {
                throw new LiveTvError('invalid_response', {});
        }
        if (body.mode !== null && body.mode !== 'explicit' && body.mode !== 'default') {
                throw new LiveTvError('invalid_response', {});
        }
        if (!Array.isArray(body.candidates)) throw new LiveTvError('invalid_response', {});
        const candidates: LivetvRouterCandidate[] = [];
        const seen = new Set<string>();
        for (const raw of body.candidates) {
                const candidate = normalizeRouterCandidate(raw);
                if (!candidate || seen.has(candidate.candidateId)) continue;
                seen.add(candidate.candidateId);
                candidates.push(candidate);
                if (candidates.length >= LIVETV_ROUTER_MAX_CANDIDATES) break;
        }
        return {
                unifiedEnabled: body.unifiedEnabled,
                resolved: body.resolved,
                mode: body.mode,
                candidates
        };
}
