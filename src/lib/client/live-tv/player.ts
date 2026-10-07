// LT-3 — Live TV DASH/ClearKey playback engine (Shaka-backed, Live TV only).
//
// DOCUMENTED INTEGRATION CONTRACT (LiveGT V1 "Play it in your own player",
// audited 2026-10-08 against shaka-player 5.2.12 — see live-tv-worklog.md
// "DOCUMENTED SHAKA INTEGRATION AUDIT"):
//
//   const player = new shaka.Player();
//   await player.attach(video);
//   if (ch.drm) player.configure({ drm: { clearKeys: { [ch.drm.keyId]: ch.drm.key } } });
//   await player.load(ch.sources[0]);
//
// The engine reproduces this sequence EXACTLY (attach → configure → load,
// no explicit MIME type). The MIME argument was deliberately REMOVED: it
// forced the DASH parser on the ~13% of V1 channels whose single source is
// an HLS .m3u8 URL (manifest parse failure), while the documented bare
// load() lets Shaka sniff the URL extension and pick the correct parser
// (.mpd → DASH, .m3u8 → HLS). Init order and MIME were otherwise proven
// behaviorally neutral for .mpd channels (source-level + runtime proof in
// the worklog).
//
// A SMALL, ISOLATED playback engine for LiveGT V1 live channels, modeled
// on the existing HLS engine conventions (`src/lib/client/player/hls-engine.ts`).
// It is NOT a retrofit into the VOD player: PlaybackManager, PlayerShell,
// PlayerViewport, media-compat.ts (VOD DASH stays UNSUPPORTED), the HLS
// engine and every provider adapter are untouched. The plan's architecture
// (live-tv-plan.md §4/§5, decision D5):
//
//   LT-2 client (resolveLiveTvPlayback)
//          ↓  { channel, sources, drm }   (already resolved — the engine
//   LiveTvPlaybackEngine (THIS FILE)       never calls LiveGT itself)
//          ↓
//   Shaka Player  (browser-only, dynamic import)
//          ↓
//   caller-owned HTMLVideoElement  (MSE)
//
// OWNERSHIP:
//   The CALLER owns the `<video>` element (LT-4's component). The engine
//   attaches to it, wires listeners, drives playback and RELEASES it on
//   destroy — it never creates or hides video elements. Exactly ONE Shaka
//   player instance exists per engine at any time: every load() destroys
//   the previous session before the new one takes ownership, so two Shaka
//   instances can never control the same element.
//
// RACE PROTECTION (stale sessions / fast channel switching):
//   Every load()/destroy()/abort bumps an internal generation token. Any
//   async continuation (module load, attach, manifest load) checks the
//   token plus the instance identity before proceeding — a late completion
//   for channel A can never take control after the user switched to B.
//   Stale operations reject with kind 'aborted' and emit NO error events.
//
// NO AUTO-RETRY (plan §11):
//   One engine session operates on ONE resolved playback. Fatal failures
//   surface as a normalized `LiveTvPlaybackError` (state 'error'); the
//   CALLER (LT-4) decides whether to re-resolve fresh via LT-2. The engine
//   never re-fetches LiveGT playback URLs itself, so no infinite retry
//   loops can exist here.
//
// SECURITY (plan §10/§15):
//   * No proxying: the browser fetches the signed MPD/segments directly
//     from the LiveGT CDN (decision D3). No request filters, no custom
//     networking, no license servers — ClearKey config ONLY.
//   * ClearKey key/keyId and signed URLs exist in runtime memory only:
//     they are handed to Shaka's `configure()` and never written anywhere
//     else — no storage APIs, no analytics, no logging (this module has
//     ZERO console calls; the compiled Shaka build ships no log namespace,
//     verified against shaka-player 5.2.12).
//   * Shaka's error `message` FIELD is NEVER read (it may embed URIs); error
//     normalization uses only the numeric severity/category/code enums.
//
// SSR SAFETY (mandatory):
//   This module has NO top-level browser access. The compiled Shaka bundle
//   touches browser globals at EVALUATION time (verified: `self is not
//   defined` under Node), so it is loaded exclusively through a dynamic
//   `import()` inside `defaultShakaModuleLoader()` — a function called only
//   from browser code paths and guarded by an explicit runtime check.
//   Importing THIS module under Node/SSR is safe (the LT-3 test suite does
//   exactly that, proving it).

import type { LiveTvPlaybackResolution, LiveTvPlaybackSource } from './types';
import { LiveTvPlaybackError } from './player-errors';

// ---------------------------------------------------------------------------
// Structural Shaka types — Mavero-owned shapes, never shaka.* imports.
// ---------------------------------------------------------------------------
// The engine depends on these STRUCTURAL types only. The production loader
// casts the real shaka-player module to this shape; tests inject fakes of
// the same shape. No raw Shaka type ever leaves this module (LT-3 brief:
// UI components must not depend on shaka.Player / shaka.util / Shaka
// events).

/**
 * Subset of the Shaka error object the engine inspects. `severity`,
 * `category` and `code` are stable public enum NUMBERS. `message` and
 * `data` exist on the real object but are DELIBERATELY never read — they
 * may contain signed URLs or other upstream material.
 */
export type ShakaErrorLike = {
        severity?: unknown;
        category?: unknown;
        code?: unknown;
};

/** Shaka error event payload (`event.detail` on the 'error' FakeEvent). */
export type ShakaErrorEventLike = { detail?: ShakaErrorLike | null };

/**
 * Minimal structural surface of `shaka.Player` the engine drives.
 * Verified against shaka-player 5.2.12 typings:
 *   attach(mediaElement, initializeMediaSource?) → Promise
 *   load(assetUri, startTime?, mimeType?)        → Promise
 *   destroy()                                    → Promise
 *   configure(config)                            → boolean
 *   seekRange()                                  → { start, end }
 *   isLive() / getMediaElement() / addEventListener / removeEventListener
 */
export type ShakaPlayerLike = {
        attach(mediaElement: HTMLMediaElement): Promise<unknown>;
        load(assetUri: string, startTime?: number | null, mimeType?: string | null): Promise<unknown>;
        destroy(): Promise<unknown>;
        configure(config: Record<string, unknown>): boolean;
        seekRange(): { start: number; end: number };
        isLive(): boolean;
        getMediaElement(): HTMLMediaElement | null;
        addEventListener(type: 'error', listener: (event: ShakaErrorEventLike) => void): void;
        removeEventListener(type: 'error', listener: (event: ShakaErrorEventLike) => void): void;
};

/** Structural shape of the `shaka` module the engine consumes. */
export type ShakaModuleLike = {
        Player: (new () => ShakaPlayerLike) & { isBrowserSupported(): boolean };
        polyfill?: { installAll(): void };
};

/** Factory that resolves the Shaka module (tests inject fakes here). */
export type ShakaModuleLoader = () => Promise<ShakaModuleLike | null>;

// ---------------------------------------------------------------------------
// Verified Shaka public enum values (shaka-player 5.2.12, extracted from
// the installed package — these NUMBERS are the stable public error
// contract documented by Shaka; they are not secrets).
// ---------------------------------------------------------------------------

export const SHAKA_ERROR_SEVERITY = { RECOVERABLE: 1, CRITICAL: 2 } as const;
export const SHAKA_ERROR_CATEGORY = {
        NETWORK: 1,
        TEXT: 2,
        MEDIA: 3,
        MANIFEST: 4,
        STREAMING: 5,
        DRM: 6,
        PLAYER: 7
} as const;
export const SHAKA_ERROR_CODE = {
        BAD_HTTP_STATUS: 1001,
        HTTP_ERROR: 1002,
        TIMEOUT: 1003,
        MEDIA_SOURCE_OPERATION_FAILED: 3014,
        DASH_NO_COMMON_KEY_SYSTEM: 4008,
        CONTENT_UNSUPPORTED_BY_BROWSER: 4032,
        NO_RECOGNIZED_KEY_SYSTEMS: 6000,
        REQUESTED_KEY_SYSTEM_CONFIG_UNAVAILABLE: 6001,
        ENCRYPTED_CONTENT_WITHOUT_DRM_INFO: 6010,
        NO_LICENSE_SERVER_GIVEN: 6012,
        LOAD_INTERRUPTED: 7000,
        OPERATION_ABORTED: 7001
} as const;

/** DRM-system codes that indicate a protected-content playback failure. */
const DRM_SYSTEM_CODES = new Set<number>([
        SHAKA_ERROR_CODE.NO_RECOGNIZED_KEY_SYSTEMS,
        SHAKA_ERROR_CODE.REQUESTED_KEY_SYSTEM_CONFIG_UNAVAILABLE,
        SHAKA_ERROR_CODE.ENCRYPTED_CONTENT_WITHOUT_DRM_INFO,
        SHAKA_ERROR_CODE.NO_LICENSE_SERVER_GIVEN,
        SHAKA_ERROR_CODE.DASH_NO_COMMON_KEY_SYSTEM
]);

/**
 * Normalize a Shaka failure into the engine-neutral error model.
 *
 * Returns `null` for RECOVERABLE-severity errors — Shaka retries those
 * internally and the UI must not be disturbed. CRITICAL (or unknown
 * severity — treated defensively as fatal) errors map onto
 * `LiveTvPlaybackError` kinds:
 *
 *   CONTENT_UNSUPPORTED_BY_BROWSER            → unsupported_browser
 *   DRM category / DRM system codes            → drm_playback_failed
 *   NETWORK category during manifest load      → manifest_load_failed
 *   NETWORK category during playback           → network_failed
 *   MANIFEST category                          → manifest_load_failed
 *   LOAD_INTERRUPTED / OPERATION_ABORTED       → aborted (silent, no event)
 *   everything else (TEXT/MEDIA/STREAMING/…)   → playback_failed
 *
 * Only the numeric severity/category/code are read — never `message`.
 */
export function normalizeShakaError(raw: unknown, phase: 'load' | 'playback'): LiveTvPlaybackError | null {
        if (!raw || typeof raw !== 'object') return new LiveTvPlaybackError('playback_failed');
        const error = raw as ShakaErrorLike;
        const severity = typeof error.severity === 'number' ? error.severity : NaN;
        // Recoverable errors are handled inside Shaka — not surfaced.
        if (severity === SHAKA_ERROR_SEVERITY.RECOVERABLE) return null;
        const code = typeof error.code === 'number' ? error.code : NaN;
        const category = typeof error.category === 'number' ? error.category : NaN;

        if (code === SHAKA_ERROR_CODE.CONTENT_UNSUPPORTED_BY_BROWSER) {
                return new LiveTvPlaybackError('unsupported_browser', Number.isFinite(code) ? code : undefined);
        }
        if (category === SHAKA_ERROR_CATEGORY.DRM || (Number.isFinite(code) && DRM_SYSTEM_CODES.has(code))) {
                return new LiveTvPlaybackError('drm_playback_failed', Number.isFinite(code) ? code : undefined);
        }
        if (code === SHAKA_ERROR_CODE.LOAD_INTERRUPTED || code === SHAKA_ERROR_CODE.OPERATION_ABORTED) {
                return new LiveTvPlaybackError('aborted', Number.isFinite(code) ? code : undefined);
        }
        if (category === SHAKA_ERROR_CATEGORY.NETWORK) {
                return new LiveTvPlaybackError(
                        phase === 'load' ? 'manifest_load_failed' : 'network_failed',
                        Number.isFinite(code) ? code : undefined
                );
        }
        if (category === SHAKA_ERROR_CATEGORY.MANIFEST) {
                return new LiveTvPlaybackError('manifest_load_failed', Number.isFinite(code) ? code : undefined);
        }
        return new LiveTvPlaybackError('playback_failed', Number.isFinite(code) ? code : undefined);
}

// ---------------------------------------------------------------------------
// Module loader — browser-guarded, dynamic, memoized (hls-engine pattern).
// ---------------------------------------------------------------------------

/**
 * Resolve the Shaka module for ONE playback session.
 *
 * Returns `null` when Shaka is unavailable (non-browser runtime, failed
 * import, unexpected module shape) — the engine then surfaces a controlled
 * `unsupported_browser` error instead of crashing.
 *
 * BROWSER-ONLY: the compiled Shaka bundle touches browser globals at
 * module-evaluation time (`self`), so this function guards on the runtime
 * BEFORE importing and is only ever called from browser code paths.
 */
export async function defaultShakaModuleLoader(): Promise<ShakaModuleLike | null> {
        if (typeof window === 'undefined' || typeof document === 'undefined') return null;
        try {
                // Verified against shaka-player 5.2.12: the compiled build
                // exposes the namespace as the module default export.
                const mod = (await import('shaka-player')) as { default?: unknown };
                const shaka = mod.default;
                if (!shaka || typeof shaka !== 'object') return null;
                const candidate = shaka as { Player?: unknown; polyfill?: { installAll?: () => void } };
                if (typeof candidate.Player !== 'function') return null;
                // Idempotent browser polyfills (safe to call repeatedly).
                try {
                        candidate.polyfill?.installAll?.();
                } catch {
                        // polyfill failure is never fatal
                }
                return candidate as unknown as ShakaModuleLike;
        } catch {
                return null;
        }
}

/** Memoized loader promise (the dynamic import itself is also cached). */
let cachedModulePromise: Promise<ShakaModuleLike | null> | null = null;

/** Resolve (and memoize) the Shaka module. */
export function loadShakaModule(): Promise<ShakaModuleLike | null> {
        if (!cachedModulePromise) cachedModulePromise = defaultShakaModuleLoader();
        return cachedModulePromise;
}

/** Test-only reset for the memoized loader promise. */
export function resetShakaModuleCache(): void {
        cachedModulePromise = null;
}

// ---------------------------------------------------------------------------
// Capability checks (each reads ONE global, called only from browser paths).
// ---------------------------------------------------------------------------

/** True when running in a browser-like runtime (window + document exist). */
export function liveTvBrowserRuntimeAvailable(): boolean {
        return typeof window !== 'undefined' && typeof document !== 'undefined';
}

/** True when MediaSource exists (required for MSE-based DASH playback). */
export function liveTvMediaSourceAvailable(): boolean {
        return typeof MediaSource !== 'undefined';
}

/**
 * True when the EME entry point for ClearKey exists. Presence does NOT
 * guarantee a ClearKey CDM (Safari has the API but no ClearKey support —
 * LT-0 risk 3); that failure surfaces later as a controlled
 * `drm_playback_failed` error from Shaka.
 */
export function liveTvClearKeyEmeAvailable(): boolean {
        return (
                typeof navigator !== 'undefined' &&
                typeof (navigator as { requestMediaKeySystemAccess?: unknown }).requestMediaKeySystemAccess === 'function'
        );
}

// ---------------------------------------------------------------------------
// Source selection — deterministic, no fallbacks.
// ---------------------------------------------------------------------------

/** True for an absolute http(s) URL usable as a playback manifest source. */
function isUsableHttpUrl(value: unknown): value is string {
        if (typeof value !== 'string' || value.length === 0) return false;
        try {
                const parsed = new URL(value);
                return parsed.protocol === 'https:' || parsed.protocol === 'http:';
        } catch {
                return false;
        }
}

/**
 * Select THE playback source from a LiveGT resolution, deterministically.
 *
 * Rule (documented contract — LiveGT's own-player example loads
 * `ch.sources[0]`): return the FIRST valid absolute http(s) URL in source
 * order, exactly `sources[0]` for every observed V1 response (LT-8 census:
 * 118/118 sampled channels return exactly one source). No extension
 * preference — Shaka's own extension sniffing picks the right manifest
 * parser for both .mpd and .m3u8 sources when no MIME is forced.
 * No valid URL → `LiveTvPlaybackError('invalid_source')`.
 *
 * Never fabricates URLs; never reads `embed`/`watch` fields (not part of
 * `LiveTvPlaybackSource` — the type itself forbids the fallback).
 */
export function selectLiveTvPlaybackSource(sources: readonly LiveTvPlaybackSource[] | undefined): string {
        if (!Array.isArray(sources)) throw new LiveTvPlaybackError('invalid_source');
        for (const source of sources) {
                const url = source?.url;
                if (isUsableHttpUrl(url)) return url;
        }
        throw new LiveTvPlaybackError('invalid_source');
}

// ---------------------------------------------------------------------------
// Engine-neutral state + event model (LT-4's contract — no Shaka names).
// ---------------------------------------------------------------------------

/**
 * Engine lifecycle (LT-3 brief):
 *
 *   idle → loading → loaded → playing ⇄ paused
 *                    ↘ error          playing ⇄ buffering
 *   (any) → destroyed
 */
export type LiveTvPlaybackState =
        | 'idle'
        | 'loading'
        | 'loaded'
        | 'playing'
        | 'paused'
        | 'buffering'
        | 'error'
        | 'destroyed';

/** Normalized engine events (video-element semantics, never Shaka names). */
export type LiveTvEngineEventMap = {
        /** Engine state transition (fires only on actual changes). */
        statechange: { state: LiveTvPlaybackState; previous: LiveTvPlaybackState };
        /** Manifest loaded and the session is ready to play. */
        loaded: void;
        play: void;
        pause: void;
        /** Buffer underrun / startup stall (video 'waiting'). */
        buffering: void;
        /** Playback actually progressing (video 'playing'). */
        playing: void;
        /** Stream ended (state stays 'paused' — live streams rarely end). */
        ended: void;
        /** Fatal playback failure (never fired for 'aborted' kinds). */
        error: LiveTvPlaybackError;
        timeupdate: { currentTime: number };
        /** Duration became known / changed; null when unavailable (live). */
        durationchange: { duration: number | null };
        seeking: void;
        seeked: void;
};

export type LiveTvEngineEventName = keyof LiveTvEngineEventMap;
export type LiveTvEngineListener<K extends LiveTvEngineEventName> = (payload: LiveTvEngineEventMap[K]) => void;

/** Options for `LiveTvPlaybackEngine.load()`. */
export type LiveTvEngineLoadOptions = {
        /** Cancels the load (and cleanly abandons the session) when fired. */
        signal?: AbortSignal;
};

/** Options for the engine constructor. */
export type LiveTvPlaybackEngineOptions = {
        /** Injectable Shaka module loader (tests); defaults to the memoized dynamic import. */
        shakaLoader?: ShakaModuleLoader;
};

/** Normalized live-seek window (seconds, presentation timeline). */
export type LiveTvSeekRange = { start: number; end: number };

// ---------------------------------------------------------------------------
// The engine.
// ---------------------------------------------------------------------------

/**
 * Live TV DASH/ClearKey playback engine (one resolved playback session per
 * load; the caller owns the `<video>` element and decides when to re-resolve).
 */
export class LiveTvPlaybackEngine {
        private loader: ShakaModuleLoader;
        /** Session generation — bumped on load/destroy/abort; stale work drops. */
        private generation = 0;
        private player: ShakaPlayerLike | null = null;
        private video: HTMLVideoElement | null = null;
        private state: LiveTvPlaybackState = 'idle';
        private destroyed = false;
        private sessionChannelId: string | null = null;
        /** The CURRENT session's Shaka error listener (for exact removal). */
        private playerErrorHandler: ((event: ShakaErrorEventLike) => void) | null = null;
        private listeners = new Map<LiveTvEngineEventName, Set<(payload: unknown) => void>>();
        /** Video listeners of the CURRENT session (for exact removal). */
        private videoBindings: Array<{ video: HTMLVideoElement; name: string; handler: () => void }> = [];

        constructor(options: LiveTvPlaybackEngineOptions = {}) {
                this.loader = options.shakaLoader ?? loadShakaModule;
        }

        // ----- Event model ----------------------------------------------------

        /** Subscribe to a normalized engine event; returns an unsubscribe fn. */
        on<K extends LiveTvEngineEventName>(event: K, listener: LiveTvEngineListener<K>): () => void {
                let set = this.listeners.get(event);
                if (!set) {
                        set = new Set();
                        this.listeners.set(event, set);
                }
                set.add(listener as (payload: unknown) => void);
                return () => this.off(event, listener);
        }

        /** Unsubscribe (never throws for unknown listeners). */
        off<K extends LiveTvEngineEventName>(event: K, listener: LiveTvEngineListener<K>): void {
                this.listeners.get(event)?.delete(listener as (payload: unknown) => void);
        }

        private emit<K extends LiveTvEngineEventName>(event: K, payload: LiveTvEngineEventMap[K]): void {
                if (this.destroyed) return; // no events after destroy
                const set = this.listeners.get(event);
                if (!set) return;
                for (const listener of [...set]) {
                        try {
                                (listener as LiveTvEngineListener<K>)(payload);
                        } catch {
                                // listener errors must never break the engine
                        }
                }
        }

        private setState(next: LiveTvPlaybackState): void {
                if (this.destroyed) return;
                if (this.state === next) return;
                const previous = this.state;
                this.state = next;
                this.emit('statechange', { state: next, previous });
        }

        // ----- Introspection ---------------------------------------------------

        /** Current engine state (never a raw Shaka state). */
        getState(): LiveTvPlaybackState {
                return this.state;
        }

        /** The caller-owned video element of the active session, if any. */
        getVideoElement(): HTMLVideoElement | null {
                return this.video;
        }

        /** The channel id of the active session, or null. */
        getChannelId(): string | null {
                return this.sessionChannelId;
        }

        /** True while the active presentation is live. */
        isLive(): boolean {
                if (this.destroyed) return false;
                try {
                        if (this.player?.isLive()) return true;
                } catch {
                        // introspection must never throw
                }
                const duration = this.video?.duration;
                return duration === Infinity;
        }

        /**
         * Presentation duration in seconds, or null when unavailable.
         * Live DASH presentations report Infinity — null is returned and
         * NOTHING is fabricated (LT-4 renders no VOD timeline for live).
         */
        getDuration(): number | null {
                if (this.destroyed || !this.video) return null;
                const duration = this.video.duration;
                return typeof duration === 'number' && Number.isFinite(duration) && duration > 0 ? duration : null;
        }

        /** Current playback position in seconds (0 when unavailable). */
        getCurrentTime(): number {
                if (this.destroyed || !this.video) return 0;
                const time = this.video.currentTime;
                return typeof time === 'number' && Number.isFinite(time) ? Math.max(0, time) : 0;
        }

        /**
         * The live seek window when the presentation exposes one, else null.
         * Future "Go Live" support (LT-4): seek to `end` to return to the
         * live edge. Invalid/absent ranges return null — never invented.
         */
        getLiveSeekRange(): LiveTvSeekRange | null {
                if (this.destroyed || !this.player) return null;
                try {
                        const range = this.player.seekRange();
                        const start = Number(range?.start);
                        const end = Number(range?.end);
                        if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
                        return { start, end };
                } catch {
                        return null;
                }
        }

        // ----- Controls --------------------------------------------------------

        /**
         * Start playback. Rejections carry `LiveTvPlaybackError`:
         *   'aborted'          — engine destroyed / no session
         *   'autoplay_blocked' — the browser refused unmuted autoplay (NOT a
         *                        stream failure; the state stays untouched —
         *                        LT-4 shows a tap-to-play affordance)
         *   'playback_failed'  — any other play() rejection
         * The engine NEVER auto-mutes to bypass autoplay policy.
         */
        async play(): Promise<void> {
                if (this.destroyed) throw new LiveTvPlaybackError('aborted');
                const video = this.video;
                if (!video) throw new LiveTvPlaybackError('playback_failed');
                try {
                        await video.play();
                } catch (err) {
                        const name = (err as { name?: unknown })?.name;
                        if (name === 'NotAllowedError') throw new LiveTvPlaybackError('autoplay_blocked');
                        throw new LiveTvPlaybackError('playback_failed');
                }
        }

        /** Pause playback (no-op without an active session). */
        pause(): void {
                if (this.destroyed || !this.video) return;
                try {
                        this.video.pause();
                } catch {
                        // pause must never throw
                }
        }

        /**
         * Seek on the presentation timeline. Live presentations clamp to
         * the seek window (Go-Live range); finite-duration presentations
         * clamp to [0, duration]. When no seekable target exists the call
         * is a documented no-op — nothing is guessed.
         */
        seek(time: number): void {
                if (this.destroyed || !this.video || !Number.isFinite(time)) return;
                const target = Math.max(0, time);
                const range = this.getLiveSeekRange();
                if (range) {
                        try {
                                this.video.currentTime = Math.min(Math.max(target, range.start), range.end);
                        } catch {
                                // seek must never throw
                        }
                        return;
                }
                const duration = this.getDuration();
                if (duration !== null) {
                        try {
                                this.video.currentTime = Math.min(target, duration);
                        } catch {
                                // seek must never throw
                        }
                }
                // No seekable window and no finite duration → no-op.
        }

        /** Set volume [0..1] (clamped). */
        setVolume(value: number): void {
                if (this.destroyed || !this.video || !Number.isFinite(value)) return;
                this.video.volume = Math.min(1, Math.max(0, value));
        }

        /** Current volume [0..1] (0 without a session). */
        getVolume(): number {
                if (this.destroyed || !this.video) return 0;
                const volume = this.video.volume;
                return typeof volume === 'number' && Number.isFinite(volume) ? volume : 0;
        }

        /** Mute/unmute. */
        setMuted(muted: boolean): void {
                if (this.destroyed || !this.video) return;
                this.video.muted = Boolean(muted);
        }

        /** True while muted. */
        isMuted(): boolean {
                if (this.destroyed || !this.video) return false;
                return Boolean(this.video.muted);
        }

        // ----- Session lifecycle ------------------------------------------------

        /**
         * Load ONE resolved playback session onto a caller-owned video
         * element (LT-2 `resolveLiveTvPlayback()` output — the engine never
         * calls LiveGT itself).
         *
         * Sequence (documented LiveGT own-player contract): the previous
         * session is destroyed FIRST, then a NEW Shaka player takes
         * ownership of the element, ClearKey is configured when present, and
         * the first source is loaded bare — never two instances.
         *
         * Rejections carry `LiveTvPlaybackError`. Every failure EXCEPT
         * 'aborted' also sets state 'error' and emits ONE 'error' event;
         * aborts (destroy / supersession / signal) are silent.
         */
        async load(
                video: HTMLVideoElement,
                resolution: LiveTvPlaybackResolution,
                options: LiveTvEngineLoadOptions = {}
        ): Promise<void> {
                if (this.destroyed) throw new LiveTvPlaybackError('aborted');
                // Pre-aborted signal: nothing has started — reject silently,
                // leaving the previous session untouched (LT-2 semantics).
                if (options.signal?.aborted) throw new LiveTvPlaybackError('aborted');
                const generation = ++this.generation;

                // 1. Tear down the previous session (single-owner rule).
                this.teardownSession();

                // 2. Adopt the element + wire normalized video events.
                this.video = video;
                this.wireVideoEvents(video, generation);

                // 3. Validate the resolution shape (defense in depth — LT-2
                //    already guarantees this, the engine re-checks).
                try {
                        this.sessionChannelId = resolution?.channel?.id ?? null;
                } catch {
                        this.sessionChannelId = null;
                }
                if (!resolution || typeof resolution !== 'object') {
                        return this.failSession(new LiveTvPlaybackError('invalid_source'), generation);
                }
                let sourceUrl: string;
                try {
                        sourceUrl = selectLiveTvPlaybackSource(resolution.sources);
                } catch (err) {
                        return this.failSession(err instanceof LiveTvPlaybackError ? err : new LiveTvPlaybackError('invalid_source'), generation);
                }
                const drm = resolution.drm ?? null;
                if (drm !== null) {
                        // LT-2 only produces type:'clearkey', but the engine
                        // re-validates: unknown types or missing values are a
                        // controlled DRM configuration failure — never silent,
                        // never treated as unencrypted.
                        const type = (drm as { type?: unknown }).type;
                        const keyId = (drm as { keyId?: unknown }).keyId;
                        const key = (drm as { key?: unknown }).key;
                        if (type !== 'clearkey' || typeof keyId !== 'string' || keyId.length === 0 || typeof key !== 'string' || key.length === 0) {
                                return this.failSession(new LiveTvPlaybackError('drm_config_failed'), generation);
                        }
                }

                // 4. Capability gates.
                if (!liveTvBrowserRuntimeAvailable() || !liveTvMediaSourceAvailable()) {
                        return this.failSession(new LiveTvPlaybackError('unsupported_browser'), generation);
                }
                if (drm !== null && !liveTvClearKeyEmeAvailable()) {
                        return this.failSession(new LiveTvPlaybackError('unsupported_browser'), generation);
                }

                this.setState('loading');

                // External abort: cleanly abandon the session (no error event).
                const signal = options.signal;
                const onAbort = () => {
                        if (this.destroyed || generation !== this.generation) return;
                        this.generation += 1; // invalidate all pending work
                        this.teardownSession();
                        this.setState('idle');
                };
                signal?.addEventListener('abort', onAbort);

                try {
                        // 5. Resolve the (browser-only) Shaka module.
                        const module = await this.loader();
                        if (this.destroyed || generation !== this.generation) throw new LiveTvPlaybackError('aborted');
                        if (!module || typeof module.Player !== 'function') {
                                return this.failSession(new LiveTvPlaybackError('unsupported_browser'), generation);
                        }
                        if (!module.Player.isBrowserSupported()) {
                                return this.failSession(new LiveTvPlaybackError('unsupported_browser'), generation);
                        }

                        // 6. Create the player and take ownership.
                        const player = new module.Player();
                        this.player = player;
                        const onPlayerError = (event: ShakaErrorEventLike) => {
                                if (this.destroyed || generation !== this.generation || this.player !== player) return;
                                const normalized = normalizeShakaError(event?.detail, 'playback');
                                if (!normalized) return; // recoverable — Shaka retries internally
                                if (normalized.kind === 'aborted') return; // interruption — not fatal for the UI
                                // Event handlers must NEVER throw — apply the failure
                                // side-effects without rethrowing.
                                this.surfaceSessionFailure(normalized, generation);
                        };
                        this.playerErrorHandler = onPlayerError;
                        player.addEventListener('error', onPlayerError);

                        // 7. Attach to the caller's element FIRST, then configure
                        //    ClearKey, then load — the EXACT documented LiveGT
                        //    sequence (attach → configure → load). No explicit
                        //    MIME: Shaka sniffs .mpd/.m3u8 sources itself.
                        try {
                                await player.attach(video);
                        } catch (err) {
                                if (this.destroyed || generation !== this.generation) throw new LiveTvPlaybackError('aborted');
                                const normalized = normalizeShakaError(err, 'load');
                                if (normalized?.kind === 'aborted') throw new LiveTvPlaybackError('aborted', normalized.code);
                                if (
                                        normalized &&
                                        (normalized.kind === 'drm_playback_failed' ||
                                                normalized.kind === 'unsupported_browser' ||
                                                normalized.kind === 'manifest_load_failed')
                                ) {
                                        return this.failSession(normalized, generation);
                                }
                                // Unrecognized attach failure — initialization failure.
                                return this.failSession(new LiveTvPlaybackError('init_failed'), generation);
                        }
                        if (this.destroyed || generation !== this.generation) throw new LiveTvPlaybackError('aborted');

                        if (drm !== null) {
                                const clearKeys: Record<string, string> = {
                                        [(drm as { keyId: string }).keyId]: (drm as { key: string }).key
                                };
                                let configured = false;
                                try {
                                        configured = player.configure({ drm: { clearKeys } });
                                } catch {
                                        configured = false;
                                }
                                if (!configured) {
                                        return this.failSession(new LiveTvPlaybackError('drm_config_failed'), generation);
                                }
                        }

                        // 8. Load the selected source exactly as documented
                        //    (bare load — no startTime, no MIME).
                        try {
                                await player.load(sourceUrl);
                        } catch (err) {
                                if (this.destroyed || generation !== this.generation) throw new LiveTvPlaybackError('aborted');
                                const normalized = normalizeShakaError(err, 'load');
                                if (normalized?.kind === 'aborted') {
                                        // Shaka-internal interruption with a still-current
                                        // session (no engine invalidation preceded it) — the
                                        // load did not complete; settle back to idle.
                                        this.teardownSession();
                                        this.setState('idle');
                                        throw new LiveTvPlaybackError('aborted', normalized.code);
                                }
                                return this.failSession(
                                        normalized ?? new LiveTvPlaybackError('manifest_load_failed'),
                                        generation
                                );
                        }
                        if (this.destroyed || generation !== this.generation) throw new LiveTvPlaybackError('aborted');

                        // 9. Ready.
                        this.setState('loaded');
                        this.emit('loaded', undefined);
                } catch (err) {
                        if (err instanceof LiveTvPlaybackError) {
                                // Either a silent 'aborted' (destroy/supersession/signal)
                                // or a failure ALREADY surfaced by failSession (exactly one
                                // 'error' event + 'error' state) — rethrow as-is, never
                                // double-report.
                                throw err;
                        }
                        // Unexpected rejection — surface once through the normal path.
                        return this.failSession(new LiveTvPlaybackError('playback_failed'), generation);
                } finally {
                        signal?.removeEventListener('abort', onAbort);
                }
        }

        /**
         * Destroy the engine completely. Idempotent (double destroy never
         * throws). After destroy: no events are emitted, no pending async
         * work can mutate state, no Shaka instance remains active and the
         * video element is fully released (listeners removed).
         */
        destroy(): void {
                if (this.destroyed) return;
                this.destroyed = true;
                this.generation += 1;
                this.teardownSession();
                this.video = null;
                this.sessionChannelId = null;
                this.listeners.clear();
                this.state = 'destroyed'; // direct: statechange suppressed by destroyed flag
        }

        // ----- Internals ---------------------------------------------------------

        /**
         * Tear down the CURRENT session: destroy the Shaka player, remove
         * the session's video listeners, clear references. Never throws.
         */
        private teardownSession(): void {
                const player = this.player;
                this.player = null;
                this.sessionChannelId = null;
                const errorHandler = this.playerErrorHandler;
                this.playerErrorHandler = null;
                if (player) {
                        if (errorHandler) {
                                try {
                                        player.removeEventListener('error', errorHandler);
                                } catch {
                                        // removal must never throw
                                }
                        }
                        void player.destroy().catch(() => {
                                // destroy must never throw
                        });
                }
                for (const { video, name, handler } of this.videoBindings) {
                        try {
                                video.removeEventListener(name, handler);
                        } catch {
                                // removal must never throw
                        }
                }
                this.videoBindings = [];
        }

        /** Wire normalized video events for the session (generation-guarded). */
        private wireVideoEvents(video: HTMLVideoElement, generation: number): void {
                const guarded = (name: string, handler: () => void) => {
                        const wrapped = () => {
                                if (this.destroyed || generation !== this.generation) return;
                                handler();
                        };
                        this.videoBindings.push({ video, name, handler: wrapped });
                        video.addEventListener(name, wrapped);
                };

                guarded('timeupdate', () => {
                        this.emit('timeupdate', { currentTime: this.getCurrentTime() });
                });
                guarded('durationchange', () => {
                        this.emit('durationchange', { duration: this.getDuration() });
                });
                guarded('play', () => {
                        this.emit('play', undefined);
                        if (this.state === 'loaded' || this.state === 'paused' || this.state === 'buffering') {
                                this.setState('playing');
                        }
                });
                guarded('playing', () => {
                        this.emit('playing', undefined);
                        this.setState('playing');
                });
                guarded('waiting', () => {
                        this.emit('buffering', undefined);
                        if (this.state === 'playing' || this.state === 'paused') {
                                this.setState('buffering');
                        }
                });
                guarded('pause', () => {
                        this.emit('pause', undefined);
                        if (this.state === 'playing' || this.state === 'buffering') {
                                this.setState('paused');
                        }
                });
                guarded('ended', () => {
                        // No 'ended' STATE in the lifecycle — the event carries
                        // the signal, the engine settles into 'paused'.
                        this.emit('ended', undefined);
                        if (this.state === 'playing' || this.state === 'buffering') {
                                this.setState('paused');
                        }
                });
                guarded('seeking', () => {
                        this.emit('seeking', undefined);
                });
                guarded('seeked', () => {
                        this.emit('seeked', undefined);
                });
        }

        /**
         * Apply ONE fatal failure to the CURRENT session: teardown + 'error'
         * state + exactly one 'error' event. NEVER throws (safe for event
         * handlers). Returns false when the failure is stale (a newer session
         * owns the state) and nothing was surfaced.
         */
        private surfaceSessionFailure(error: LiveTvPlaybackError, generation: number): boolean {
                if (this.destroyed || generation !== this.generation) {
                        // Stale failure — the newer session owns the state.
                        return false;
                }
                this.teardownSession();
                this.setState('error');
                this.emit('error', error);
                return true;
        }

        /**
         * Fail the session (surfaced via surfaceSessionFailure) AND reject
         * load() with the same error. Always throws. No auto-retry — the
         * caller decides whether to re-resolve via LT-2 (plan §11).
         */
        private failSession(error: LiveTvPlaybackError, generation: number): never {
                if (!this.surfaceSessionFailure(error, generation)) {
                        throw new LiveTvPlaybackError('aborted', error.code);
                }
                throw error;
        }
}
