// MAVERO — LT-3 Live TV DASH/ClearKey playback engine: deterministic suite.
//
// Drives the REAL engine (src/lib/client/live-tv/player.ts + player-errors.ts)
// against in-process fakes:
//   * FakeVideoElement — the caller-owned <video> (engine never creates one)
//   * FakeShakaPlayer / fake module — injected through the engine's loader
//     option (the Shaka package is NEVER loaded by this suite; mocking stays
//     at the module boundary, package internals untouched)
//   * browser-runtime shims (window/document/MediaSource/navigator) installed
//     ONLY where a positive capability path is exercised, restored after
//
// NO real browser, DRM, CDN or LiveGT call happens anywhere in this file.
// Importing the engine modules under Node also proves SSR safety (no
// top-level browser access — the devtool_protection_test argument).
//
// Coverage map (LT-3 brief §TESTING):
//   §1  playback error model (kinds, safe messages, guard, code passthrough)
//   §2  normalizeShakaError mapping (severity/categories/codes/phases)
//   §3  source selection (deterministic, malformed, empty, no fallbacks)
//   §4  module loader + SSR safety + capability gating
//   §5  load lifecycle + DRM validation/configuration
//   §6  controls (play/pause/seek/volume/mute/autoplay)
//   §7  live behavior (isLive, duration, seek range, time normalization)
//   §8  channel switching + stale-session protection
//   §9  destroy semantics (idempotent, cleanup, abort, no post-destroy work)
//   §10 normalized video events + state transitions
//   §11 security (no secrets in errors, no persistence, no LiveGT calls,
//       Shaka never statically imported, error.message never read)
//   §12 LT-2 contract compatibility

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
        LiveTvPlaybackEngine,
        normalizeShakaError,
        selectLiveTvPlaybackSource,
        loadShakaModule,
        resetShakaModuleCache,
        defaultShakaModuleLoader,
        liveTvBrowserRuntimeAvailable,
        liveTvMediaSourceAvailable,
        liveTvClearKeyEmeAvailable,
        SHAKA_ERROR_CATEGORY,
        SHAKA_ERROR_CODE,
        SHAKA_ERROR_SEVERITY,
        type ShakaErrorEventLike,
        type ShakaErrorLike,
        type ShakaModuleLike
} from '$lib/client/live-tv/player';
import {
        applyMediaAuthManifestResponse,
        applyMediaAuthRequest,
        createMediaAuthSession,
        installMediaAuthFilters,
        looksLikeDashManifest,
        looksLikeHlsPlaylist,
        propagateHlsPlaylistAuth,
        propagateMediaSegmentAuth,
        SHAKA_REQUEST_TYPE,
        type MediaAuthSession
} from '$lib/client/live-tv/media-auth';
import {
        LiveTvPlaybackError,
        isLiveTvPlaybackError,
        type LiveTvPlaybackErrorKind
} from '$lib/client/live-tv/player-errors';
import type { LiveTvPlaybackResolution } from '$lib/client/live-tv/types';

let passed = 0;
function ok(label: string): void {
        passed++;
        console.log(`  ok ${passed} - ${label}`);
}

// ============================================================
// Fakes — video element, Shaka player, Shaka module, runtime.
// ============================================================

type VideoHandler = () => void;

/** Caller-owned <video> stand-in (the engine must never create one). */
class FakeVideoElement {
        private listeners = new Map<string, Set<VideoHandler>>();
        currentTime = 0;
        duration: number = Number.NaN;
        volume = 1;
        muted = false;
        paused = true;
        playCalls = 0;
        pauseCalls = 0;
        playImpl: () => Promise<void> = async () => {
                this.paused = false;
        };

        play(): Promise<void> {
                this.playCalls += 1;
                return this.playImpl();
        }
        pause(): void {
                this.pauseCalls += 1;
                this.paused = true;
        }
        addEventListener(name: string, handler: VideoHandler): void {
                let set = this.listeners.get(name);
                if (!set) {
                        set = new Set();
                        this.listeners.set(name, set);
                }
                set.add(handler);
        }
        removeEventListener(name: string, handler: VideoHandler): void {
                this.listeners.get(name)?.delete(handler);
        }
        listenerCount(): number {
                let total = 0;
                for (const set of this.listeners.values()) total += set.size;
                return total;
        }
        emit(name: string): void {
                for (const handler of [...(this.listeners.get(name) ?? [])]) handler();
        }
}

/** Fake shaka.net.NetworkingEngine — captures the LT-9 filters. */
class FakeNetworkingEngine {
        requestFilters: Array<(type: number, request: { uris: string[] }) => void> = [];
        responseFilters: Array<(type: number, response: unknown) => void> = [];
        registerRequestFilter(filter: (type: number, request: { uris: string[] }) => void): void {
                this.requestFilters.push(filter);
        }
        registerResponseFilter(filter: (type: number, response: unknown) => void): void {
                this.responseFilters.push(filter);
        }
        emitRequest(type: number, request: { uris: string[] }): void {
                for (const filter of [...this.requestFilters]) filter(type, request);
        }
        emitResponse(type: number, response: unknown): void {
                for (const filter of [...this.responseFilters]) filter(type, response);
        }
}

/** The structural shaka.Player stand-in (module-boundary mock). */
class FakeShakaPlayer {
        /** Cross-instance test hooks (class fields would shadow prototype patches). */
        static attachHook: (() => Promise<void>) | null = null;
        static loadHook: (() => Promise<void>) | null = null;

        destroyed = false;
        attachCalls: unknown[] = [];
        loadCalls: Array<{ uri: string; startTime: unknown; mimeType: unknown }> = [];
        configureCalls: Array<Record<string, unknown>> = [];
        /** Cross-method call order ('attach' | 'configure' | 'load' | 'destroy'). */
        callLog: string[] = [];
        configureResult = true;
        /** LT-9: the fake networking engine (null models "player without one"). */
        networking: FakeNetworkingEngine | null = new FakeNetworkingEngine();
        private errorListeners = new Set<(event: ShakaErrorEventLike) => void>();
        /** null models "no usable range" — the fake then reports NaN (invalid). */
        seekRangeValue: { start: number; end: number } | null = null;
        liveValue = false;

        async attach(mediaElement: unknown): Promise<unknown> {
                this.attachCalls.push(mediaElement);
                this.callLog.push('attach');
                if (FakeShakaPlayer.attachHook) await FakeShakaPlayer.attachHook();
                return undefined;
        }
        async load(assetUri: string, startTime?: unknown, mimeType?: unknown): Promise<unknown> {
                this.loadCalls.push({ uri: assetUri, startTime, mimeType });
                this.callLog.push('load');
                if (FakeShakaPlayer.loadHook) await FakeShakaPlayer.loadHook();
                return undefined;
        }
        configure(config: Record<string, unknown>): boolean {
                this.configureCalls.push(config);
                this.callLog.push('configure');
                return this.configureResult;
        }
        seekRange(): { start: number; end: number } {
                return this.seekRangeValue ?? { start: Number.NaN, end: Number.NaN };
        }
        isLive(): boolean {
                return this.liveValue;
        }
        getMediaElement(): unknown {
                return this.attachCalls[0] ?? null;
        }
        getNetworkingEngine(): FakeNetworkingEngine | null {
                return this.networking;
        }
        addEventListener(_type: 'error', listener: (event: ShakaErrorEventLike) => void): void {
                this.errorListeners.add(listener);
        }
        removeEventListener(_type: 'error', listener: (event: ShakaErrorEventLike) => void): void {
                this.errorListeners.delete(listener);
        }
        async destroy(): Promise<unknown> {
                this.destroyed = true;
                return undefined;
        }
        errorListenerCount(): number {
                return this.errorListeners.size;
        }
        emitError(detail: ShakaErrorLike): void {
                for (const listener of [...this.errorListeners]) listener({ detail });
        }
}

/** Fake module factory: fresh class + per-module instance tracking. */
function makeShakaModule(
        options: { supported?: boolean; configureResult?: boolean; noNetworkingEngine?: boolean } = {}
) {
        const instances: FakeShakaPlayer[] = [];
        class PlayerCtor extends FakeShakaPlayer {
                constructor() {
                        super();
                        this.configureResult = options.configureResult !== false;
                        if (options.noNetworkingEngine) this.networking = null;
                        instances.push(this);
                }
                static isBrowserSupported(): boolean {
                        return options.supported !== false;
                }
        }
        const module = {
                Player: PlayerCtor,
                polyfill: { installAll(): void {} }
        } as unknown as ShakaModuleLike;
        return { module, instances };
}

/** Manual promise for late/controlled continuations. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
        let resolve!: (value: T) => void;
        let reject!: (error: unknown) => void;
        const promise = new Promise<T>((res, rej) => {
                resolve = res;
                reject = rej;
        });
        return { promise, resolve, reject };
}

/** Installs minimal browser globals; returns a restore function. */
function installBrowserRuntime(options: { eme?: boolean } = {}): () => void {
        const g = globalThis as Record<string, unknown>;
        const originals = new Map<string, PropertyDescriptor | undefined>();
        const define = (key: string, value: unknown): void => {
                originals.set(key, Object.getOwnPropertyDescriptor(g, key));
                // Node 24's `navigator` is a getter-only global — plain
                // assignment throws, so always install via defineProperty.
                Object.defineProperty(g, key, { value, writable: true, configurable: true });
        };
        if (!liveTvBrowserRuntimeAvailable()) define('window', {});
        if (typeof document === 'undefined') define('document', {});
        if (!liveTvMediaSourceAvailable()) define('MediaSource', class MediaSource {});
        if (options.eme) {
                const base = (typeof navigator !== 'undefined' ? (navigator as object) : {}) as Record<string, unknown>;
                define('navigator', { ...base, requestMediaKeySystemAccess: async () => {
                        throw new Error('not implemented');
                } });
        }
        return () => {
                for (const [key, descriptor] of originals) {
                        if (descriptor) Object.defineProperty(g, key, descriptor);
                        else delete g[key];
                }
        };
}

// ============================================================
// Fixtures — SYNTHETIC stand-ins (never real signed data).
// ============================================================

const SIGNED_URL_A = 'https://cdn.example.com/live/aaa/index.mpd?__hdnea__=FAKE-ST~EX~SIGN-A';
const SIGNED_URL_B = 'https://cdn.example.com/live/bbb/index.mpd?__hdnea__=FAKE-ST~EX~SIGN-B';
const SIGNED_URL_NOEXT = 'https://cdn.example.com/live/ccc/manifest?__hdnea__=FAKE-ST~EX~SIGN-C';
const SIGNED_URL_M3U8 = 'https://cdn.example.com/live/ddd/HLSPartner/index.m3u8?__hdnea__=FAKE-ST~EX~SIGN-D';
const FIXTURE_KEY_ID = '11112222333344445555666677778888';
const FIXTURE_KEY = '9999aaaabbbbccccddddeeeeffff0000';

function resolution(overrides: Partial<LiveTvPlaybackResolution> = {}): LiveTvPlaybackResolution {
        return {
                channel: { id: '143', name: 'CNBC TV18 Prime' },
                sources: [{ url: SIGNED_URL_A }],
                drm: null,
                ...overrides
        };
}

async function expectPlaybackError(
        kind: LiveTvPlaybackErrorKind,
        fn: () => Promise<unknown>
): Promise<LiveTvPlaybackError> {
        try {
                await fn();
        } catch (err) {
                assert.ok(isLiveTvPlaybackError(err), `expected LiveTvPlaybackError, got: ${String(err)}`);
                assert.equal(err.kind, kind, `expected kind "${kind}", got "${err.kind}"`);
                return err;
        }
        assert.fail(`expected LiveTvPlaybackError kind "${kind}", but the call resolved`);
}

// ============================================================
// §1 — playback error model
// ============================================================
{
        const kinds: LiveTvPlaybackErrorKind[] = [
                'invalid_source',
                'init_failed',
                'manifest_load_failed',
                'drm_config_failed',
                'drm_playback_failed',
                'network_failed',
                'unsupported_browser',
                'autoplay_blocked',
                'aborted',
                'playback_failed'
        ];
        const messages = new Set<string>();
        for (const kind of kinds) {
                const err = new LiveTvPlaybackError(kind);
                assert.equal(err.name, 'LiveTvPlaybackError');
                assert.equal(err.kind, kind);
                assert.ok(err.message.length > 0, `safe message for "${kind}" is non-empty`);
                assert.ok(err.code === undefined, 'no code by default');
                messages.add(err.message);
        }
        assert.equal(messages.size, kinds.length, 'every kind has a DISTINCT safe message');
        ok('1a. all 10 kinds carry distinct non-empty fixed safe messages');

        const withCode = new LiveTvPlaybackError('manifest_load_failed', SHAKA_ERROR_CODE.BAD_HTTP_STATUS);
        assert.equal(withCode.code, 1001, 'numeric engine code is preserved');
        assert.equal(new LiveTvPlaybackError('playback_failed', Number.NaN).code, undefined, 'non-finite codes are dropped');
        ok('1b. numeric code passthrough (stable enum value only)');

        assert.equal(isLiveTvPlaybackError(new LiveTvPlaybackError('aborted')), true);
        assert.equal(isLiveTvPlaybackError(new Error('x')), false);
        assert.equal(isLiveTvPlaybackError(null), false);
        assert.equal(isLiveTvPlaybackError('x'), false);
        ok('1c. isLiveTvPlaybackError guard');
}

// ============================================================
// §2 — normalizeShakaError mapping
// ============================================================
{
        const shakaError = (severity: number, category: number, code: number): ShakaErrorLike => ({ severity, category, code });

        assert.equal(normalizeShakaError(shakaError(SHAKA_ERROR_SEVERITY.RECOVERABLE, SHAKA_ERROR_CATEGORY.NETWORK, 1002), 'load'), null, 'recoverable → null (Shaka retries internally)');
        ok('2a. RECOVERABLE severity is never surfaced');

        const unsupported = normalizeShakaError(
                shakaError(SHAKA_ERROR_SEVERITY.CRITICAL, SHAKA_ERROR_CATEGORY.MANIFEST, SHAKA_ERROR_CODE.CONTENT_UNSUPPORTED_BY_BROWSER),
                'playback'
        );
        assert.equal(unsupported?.kind, 'unsupported_browser');
        assert.equal(unsupported?.code, 4032);
        ok('2b. CONTENT_UNSUPPORTED_BY_BROWSER → unsupported_browser (code preserved)');

        assert.equal(normalizeShakaError(shakaError(2, SHAKA_ERROR_CATEGORY.DRM, 6002), 'playback')?.kind, 'drm_playback_failed', 'DRM category → drm_playback_failed');
        for (const code of [
                SHAKA_ERROR_CODE.NO_RECOGNIZED_KEY_SYSTEMS,
                SHAKA_ERROR_CODE.REQUESTED_KEY_SYSTEM_CONFIG_UNAVAILABLE,
                SHAKA_ERROR_CODE.ENCRYPTED_CONTENT_WITHOUT_DRM_INFO,
                SHAKA_ERROR_CODE.NO_LICENSE_SERVER_GIVEN,
                SHAKA_ERROR_CODE.DASH_NO_COMMON_KEY_SYSTEM
        ]) {
                const mapped = normalizeShakaError(shakaError(2, SHAKA_ERROR_CATEGORY.MANIFEST, code), 'playback');
                assert.equal(mapped?.kind, 'drm_playback_failed', `DRM system code ${code} → drm_playback_failed`);
        }
        ok('2c. DRM category + all DRM system codes → drm_playback_failed');

        assert.equal(normalizeShakaError(shakaError(2, SHAKA_ERROR_CATEGORY.NETWORK, SHAKA_ERROR_CODE.BAD_HTTP_STATUS), 'load')?.kind, 'manifest_load_failed', 'network during load → manifest_load_failed');
        assert.equal(normalizeShakaError(shakaError(2, SHAKA_ERROR_CATEGORY.NETWORK, SHAKA_ERROR_CODE.HTTP_ERROR), 'playback')?.kind, 'network_failed', 'network during playback → network_failed');
        assert.equal(normalizeShakaError(shakaError(2, SHAKA_ERROR_CATEGORY.MANIFEST, 4000), 'playback')?.kind, 'manifest_load_failed', 'manifest category → manifest_load_failed');
        ok('2d. NETWORK phase split + MANIFEST category');

        assert.equal(normalizeShakaError(shakaError(2, SHAKA_ERROR_CATEGORY.PLAYER, SHAKA_ERROR_CODE.LOAD_INTERRUPTED), 'load')?.kind, 'aborted', 'LOAD_INTERRUPTED → aborted');
        assert.equal(normalizeShakaError(shakaError(2, SHAKA_ERROR_CATEGORY.PLAYER, SHAKA_ERROR_CODE.OPERATION_ABORTED), 'playback')?.kind, 'aborted', 'OPERATION_ABORTED → aborted');
        ok('2e. LOAD_INTERRUPTED / OPERATION_ABORTED → aborted');

        assert.equal(normalizeShakaError(shakaError(2, SHAKA_ERROR_CATEGORY.MEDIA, 3014), 'playback')?.kind, 'playback_failed', 'MEDIA → playback_failed');
        assert.equal(normalizeShakaError(shakaError(2, SHAKA_ERROR_CATEGORY.STREAMING, 5000), 'playback')?.kind, 'playback_failed', 'STREAMING → playback_failed');
        assert.equal(normalizeShakaError(shakaError(2, SHAKA_ERROR_CATEGORY.PLAYER, 7002), 'playback')?.kind, 'playback_failed', 'PLAYER → playback_failed');
        assert.equal(normalizeShakaError(shakaError(2, SHAKA_ERROR_CATEGORY.TEXT, 2000), 'playback')?.kind, 'playback_failed', 'TEXT → playback_failed');
        assert.equal(normalizeShakaError(shakaError(2, 999, 9999), 'playback')?.kind, 'playback_failed', 'unknown category/code → playback_failed');
        ok('2f. MEDIA/STREAMING/PLAYER/TEXT/unknown → playback_failed');

        const nonObject = normalizeShakaError(new Error('https://signed.example/secret.mpd?token=xyz'), 'load');
        assert.equal(nonObject?.kind, 'playback_failed');
        assert.ok(!nonObject?.message.includes('signed.example'), 'upstream message text NEVER interpolated');
        const payload = { severity: 2, category: 1, code: 1001, message: 'bad status for https://cdn.example.com/signed.mpd?token=SECRET' };
        const leaked = normalizeShakaError(payload, 'load');
        assert.ok(!leaked?.message.includes('SECRET') && !leaked?.message.includes('cdn.example.com'), 'safe table message only');
        ok('2g. non-object errors + message-text isolation (safe table only)');
}

// ============================================================
// §3 — source selection (documented sources[0] contract)
// ============================================================
{
        assert.equal(selectLiveTvPlaybackSource([{ url: SIGNED_URL_A }]), SIGNED_URL_A, 'single valid source returned verbatim');
        assert.equal(selectLiveTvPlaybackSource([{ url: SIGNED_URL_M3U8 }]), SIGNED_URL_M3U8, 'single valid .m3u8 (HLS) source returned verbatim');
        ok('3a. single valid source (DASH and HLS shapes)');

        assert.equal(
                selectLiveTvPlaybackSource([{ url: SIGNED_URL_NOEXT }, { url: SIGNED_URL_A }]),
                SIGNED_URL_NOEXT,
                'FIRST valid source wins even when a later source is .mpd (documented ch.sources[0] contract)'
        );
        assert.equal(
                selectLiveTvPlaybackSource([{ url: SIGNED_URL_M3U8 }, { url: SIGNED_URL_A }]),
                SIGNED_URL_M3U8,
                'FIRST valid source wins even when a later source is .mpd (HLS-first, documented contract)'
        );
        assert.equal(
                selectLiveTvPlaybackSource([{ url: SIGNED_URL_B }, { url: SIGNED_URL_A }]),
                SIGNED_URL_B,
                'first source in array order wins among multiple .mpd sources'
        );
        ok('3b. documented sources[0] semantics: first valid source in array order');

        assert.equal(
                selectLiveTvPlaybackSource([{ url: 'http://plain.example/live/manifest' }]),
                'http://plain.example/live/manifest',
                'plain http accepted'
        );
        ok('3c. extensionless/http(s) sources accepted (no extension preference)');

        await expectPlaybackError('invalid_source', async () => selectLiveTvPlaybackSource([]));
        ok('3d. empty sources → invalid_source');

        const malformed: unknown[] = [
                'javascript:alert(1)',
                'ftp://x/y.mpd',
                'not a url',
                '',
                42,
                null,
                { url: 'javascript:alert(1)' },
                { url: '' },
                {}
        ];
        for (const sources of [malformed, [], [{ url: 'javascript:alert(1)' }]]) {
                await expectPlaybackError('invalid_source', async () =>
                        selectLiveTvPlaybackSource(sources as { url: string }[])
                );
        }
        assert.equal(
                selectLiveTvPlaybackSource([{ url: 'javascript:alert(1)' }, { url: SIGNED_URL_A }, 42]),
                SIGNED_URL_A,
                'malformed entries skipped, valid one used'
        );
        ok('3e. malformed entries skipped; all-invalid → invalid_source');

        await expectPlaybackError('invalid_source', async () => selectLiveTvPlaybackSource(undefined));
        await expectPlaybackError('invalid_source', async () => selectLiveTvPlaybackSource('nope' as unknown as { url: string }[]));
        ok('3f. non-array sources → invalid_source');

        const pool = [{ url: SIGNED_URL_A }, { url: SIGNED_URL_B }, { url: SIGNED_URL_NOEXT }, { url: SIGNED_URL_M3U8 }];
        for (let i = 0; i < 5; i++) {
                const selected = selectLiveTvPlaybackSource(pool);
                assert.ok(
                        selected === SIGNED_URL_A || selected === SIGNED_URL_B || selected === SIGNED_URL_NOEXT || selected === SIGNED_URL_M3U8,
                        'selection is always one of the INPUT sources'
                );
        }
        ok('3g. never fabricates a URL (always an input source; embed/watch cannot exist in the type)');
}

// ============================================================
// §4 — module loader, SSR safety, capability gating
// ============================================================
{
        // Under Node (no window) the REAL production loader must refuse to
        // even import Shaka — this is the SSR-safety proof.
        const before = liveTvBrowserRuntimeAvailable();
        assert.equal(before, false, 'suite runs without a browser runtime by default');
        const loaded = await defaultShakaModuleLoader();
        assert.equal(loaded, null, 'default loader returns null outside a browser (Shaka never imported under SSR)');
        ok('4a. defaultShakaModuleLoader browser guard (SSR never imports Shaka)');

        resetShakaModuleCache();
        const first = loadShakaModule();
        const second = loadShakaModule();
        assert.equal(first, second, 'loader promise is memoized');
        assert.equal(await first, null, 'memoized loader still browser-guarded');
        resetShakaModuleCache();
        ok('4b. loadShakaModule memoization + reset');
}

{
        // Engine construction must be browser-free (SSR-safe import + init).
        new LiveTvPlaybackEngine();
        ok('4c. engine constructs without a browser runtime (SSR-safe)');
}

{
        const restore = installBrowserRuntime();
        try {
                const { module, instances } = makeShakaModule();
                let loaderCalls = 0;
                const engine = new LiveTvPlaybackEngine({
                        shakaLoader: async () => {
                                loaderCalls += 1;
                                return module;
                        }
                });
                const video = new FakeVideoElement();
                const errors: LiveTvPlaybackError[] = [];
                engine.on('error', (error) => errors.push(error));

                await engine.load(video as unknown as HTMLVideoElement, resolution());
                assert.equal(engine.getState(), 'loaded', 'positive path works with runtime shims + fake module');
                assert.equal(instances.length, 1);
                assert.equal(errors.length, 0);
                engine.destroy();
        } finally {
                restore();
        }
        ok('4d. positive capability path (window/document/MediaSource + fake module)');
}

{
        // Capability gate 1: no browser runtime → controlled error, loader
        // NEVER called (Shaka is not even requested under SSR).
        let loaderCalls = 0;
        const engine = new LiveTvPlaybackEngine({
                shakaLoader: async () => {
                        loaderCalls += 1;
                        return makeShakaModule().module;
                }
        });
        const video = new FakeVideoElement();
        const errors: LiveTvPlaybackError[] = [];
        engine.on('error', (error) => errors.push(error));
        await expectPlaybackError('unsupported_browser', () => engine.load(video as unknown as HTMLVideoElement, resolution()));
        assert.equal(loaderCalls, 0, 'no browser runtime → Shaka module never requested');
        assert.equal(engine.getState(), 'error');
        assert.equal(errors.length, 1, 'exactly one error event');
        engine.destroy();
        ok('4e. no browser runtime → unsupported_browser, Shaka never requested');
}

{
        const restore = installBrowserRuntime(); // window/document present, MediaSource shimmed
        try {
                // MediaSource missing → unsupported.
                const savedMediaSource = (globalThis as Record<string, unknown>).MediaSource;
                delete (globalThis as Record<string, unknown>).MediaSource;
                const engine = new LiveTvPlaybackEngine({ shakaLoader: async () => makeShakaModule().module });
                const video = new FakeVideoElement();
                await expectPlaybackError('unsupported_browser', () => engine.load(video as unknown as HTMLVideoElement, resolution()));
                assert.equal(engine.getState(), 'error');
                engine.destroy();
                (globalThis as Record<string, unknown>).MediaSource = savedMediaSource;
                ok('4f. MediaSource unavailable → unsupported_browser');
        } finally {
                restore();
        }
}

{
        const restore = installBrowserRuntime(); // navigator has NO requestMediaKeySystemAccess here
        try {
                const engine = new LiveTvPlaybackEngine({ shakaLoader: async () => makeShakaModule().module });
                const video = new FakeVideoElement();
                // DRM session without EME → controlled unsupported error.
                await expectPlaybackError('unsupported_browser', () =>
                        engine.load(video as unknown as HTMLVideoElement, resolution({ drm: { type: 'clearkey', keyId: FIXTURE_KEY_ID, key: FIXTURE_KEY } }))
                );
                assert.equal(engine.getState(), 'error');
                engine.destroy();

                // The same runtime WITHOUT DRM is fine (EME not required).
                const engine2 = new LiveTvPlaybackEngine({ shakaLoader: async () => makeShakaModule().module });
                await engine2.load(video as unknown as HTMLVideoElement, resolution({ drm: null }));
                assert.equal(engine2.getState(), 'loaded', 'unencrypted DASH needs no EME');
                engine2.destroy();
                ok('4g. ClearKey requires EME; unencrypted DASH does not');
        } finally {
                restore();
        }
}

{
        const restore = installBrowserRuntime();
        try {
                // Loader null (import failed / unexpected shape) → unsupported.
                const engine = new LiveTvPlaybackEngine({ shakaLoader: async () => null });
                await expectPlaybackError('unsupported_browser', () =>
                        engine.load(new FakeVideoElement() as unknown as HTMLVideoElement, resolution())
                );
                ok('4h. loader null → unsupported_browser');

                // isBrowserSupported() false → unsupported.
                const unsupportedModule = makeShakaModule({ supported: false });
                const engine2 = new LiveTvPlaybackEngine({ shakaLoader: async () => unsupportedModule.module });
                await expectPlaybackError('unsupported_browser', () =>
                        engine2.load(new FakeVideoElement() as unknown as HTMLVideoElement, resolution())
                );
                assert.equal(unsupportedModule.instances.length, 0, 'no player constructed when unsupported');
                ok('4i. Player.isBrowserSupported() false → unsupported_browser, no instance created');
                engine.destroy();
                engine2.destroy();
        } finally {
                restore();
        }
}

// ============================================================
// §5 — load lifecycle + DRM validation/configuration
// ============================================================
{
        const restore = installBrowserRuntime();
        try {
                const { module, instances } = makeShakaModule();
                const engine = new LiveTvPlaybackEngine({ shakaLoader: async () => module });
                const video = new FakeVideoElement();
                const states: Array<{ state: string; previous: string }> = [];
                let loadedEvents = 0;
                const errors: LiveTvPlaybackError[] = [];
                engine.on('statechange', (payload) => states.push({ state: payload.state, previous: payload.previous }));
                engine.on('loaded', () => {
                        loadedEvents += 1;
                });
                engine.on('error', (error) => errors.push(error));

                await engine.load(video as unknown as HTMLVideoElement, resolution());

                assert.deepEqual(
                        states.map((entry) => entry.state),
                        ['loading', 'loaded'],
                        'idle → loading → loaded (statechange on every transition)'
                );
                assert.equal(loadedEvents, 1, 'one loaded event');
                assert.equal(errors.length, 0);
                assert.equal(instances.length, 1, 'exactly ONE Shaka instance');
                const player = instances[0] as FakeShakaPlayer;
                assert.equal(player.attachCalls[0], video, 'attached to the CALLER-OWNED element');
                assert.deepEqual(
                        player.loadCalls[0],
                        { uri: SIGNED_URL_A, startTime: undefined, mimeType: undefined },
                        'loads the first source BARE (documented load(ch.sources[0]) — no startTime, no MIME)'
                );
                assert.deepEqual(
                        player.callLog,
                        ['attach', 'load'],
                        'non-DRM documented order: attach → load (no configure call)'
                );
                assert.equal(player.configureCalls.length, 0, 'no DRM → no configure call');
                assert.equal(player.destroyed, false);
                assert.equal(engine.getState(), 'loaded');
                assert.equal(engine.getVideoElement(), video as unknown as HTMLVideoElement);
                assert.equal(engine.getChannelId(), '143');
                engine.destroy();
                ok('5a. successful non-DRM load: states, single instance, attach + load contract');
        } finally {
                restore();
        }
}

{
        const restore = installBrowserRuntime({ eme: true });
        try {
                const { module, instances } = makeShakaModule();
                const engine = new LiveTvPlaybackEngine({ shakaLoader: async () => module });
                const video = new FakeVideoElement();
                const errors: LiveTvPlaybackError[] = [];
                engine.on('error', (error) => errors.push(error));

                await engine.load(
                        video as unknown as HTMLVideoElement,
                        resolution({ drm: { type: 'clearkey', keyId: FIXTURE_KEY_ID, key: FIXTURE_KEY } })
                );

                assert.equal(engine.getState(), 'loaded');
                assert.equal(errors.length, 0);
                const player = instances[0] as FakeShakaPlayer;
                assert.equal(player.configureCalls.length, 1, 'exactly one configure call for ClearKey');
                assert.deepEqual(
                        player.configureCalls[0],
                        { drm: { clearKeys: { [FIXTURE_KEY_ID]: FIXTURE_KEY } } },
                        'documented Shaka ClearKey config shape {drm:{clearKeys:{keyId:key}}}'
                );
                assert.ok(
                        !JSON.stringify(player.configureCalls[0]).includes(SIGNED_URL_A),
                        'configure payload contains no manifest URL'
                );
                assert.ok(player.loadCalls.length === 1, 'load happens after DRM configuration');
                assert.deepEqual(
                        player.callLog,
                        ['attach', 'configure', 'load'],
                        'documented Shaka call order: attach → configure → load'
                );
                assert.deepEqual(
                        player.loadCalls[0],
                        { uri: SIGNED_URL_A, startTime: undefined, mimeType: undefined },
                        'DRM session also loads BARE (no MIME)'
                );
                ok('5b. valid ClearKey → exact Shaka ClearKey configuration, documented attach→configure→load order');
                engine.destroy();
        } finally {
                restore();
        }
}

{
        const restore = installBrowserRuntime({ eme: true });
        try {
                // configure() returning false → drm_config_failed.
                const { module, instances } = makeShakaModule({ configureResult: false });
                const engine = new LiveTvPlaybackEngine({ shakaLoader: async () => module });
                const video = new FakeVideoElement();
                const errors: LiveTvPlaybackError[] = [];
                engine.on('error', (error) => errors.push(error));
                await expectPlaybackError('drm_config_failed', () =>
                        engine.load(
                                video as unknown as HTMLVideoElement,
                                resolution({ drm: { type: 'clearkey', keyId: FIXTURE_KEY_ID, key: FIXTURE_KEY } })
                        )
                );
                assert.equal(engine.getState(), 'error');
                assert.equal(errors.length, 1, 'exactly one error event');
                assert.equal((instances[0] as FakeShakaPlayer).configureCalls.length, 1, 'configure was attempted');
                assert.equal((instances[0] as FakeShakaPlayer).destroyed, true, 'player destroyed after config failure');
                ok('5c. Shaka configure() rejection → drm_config_failed, player torn down');
                engine.destroy();
        } finally {
                restore();
        }
}

{
        const restore = installBrowserRuntime({ eme: true });
        try {
                // Malformed/unsupported DRM objects → controlled drm_config_failed
                // BEFORE any player/module work.
                let loaderCalls = 0;
                const { module, instances } = makeShakaModule();
                const engine = new LiveTvPlaybackEngine({
                        shakaLoader: async () => {
                                loaderCalls += 1;
                                return module;
                        }
                });
                const video = new FakeVideoElement();
                const badDrms: unknown[] = [
                        { type: 'widevine', keyId: FIXTURE_KEY_ID, key: FIXTURE_KEY },
                        { type: 'clearkey', keyId: '', key: FIXTURE_KEY },
                        { type: 'clearkey', keyId: FIXTURE_KEY_ID, key: '' },
                        { type: 'clearkey' },
                        { type: 123, keyId: FIXTURE_KEY_ID, key: FIXTURE_KEY }
                ];
                for (const drm of badDrms) {
                        await expectPlaybackError('drm_config_failed', () =>
                                engine.load(video as unknown as HTMLVideoElement, resolution({ drm: drm as never }))
                        );
                }
                assert.equal(loaderCalls, 0, 'DRM validation fails BEFORE the module is even requested');
                assert.equal(instances.length, 0, 'no player constructed for invalid DRM');
                ok('5d. invalid/unsupported DRM → drm_config_failed (never silent, never treated as ClearKey)');
                engine.destroy();
        } finally {
                restore();
        }
}

{
        const restore = installBrowserRuntime();
        try {
                // Attach failure (unrecognized error) → init_failed.
                const { module, instances } = makeShakaModule();
                const engine = new LiveTvPlaybackEngine({ shakaLoader: async () => module });
                const video = new FakeVideoElement();
                const errors: LiveTvPlaybackError[] = [];
                engine.on('error', (error) => errors.push(error));
                const deferredAttach = deferred<void>();
                FakeShakaPlayer.attachHook = () => deferredAttach.promise;
                const loadPromise = engine.load(video as unknown as HTMLVideoElement, resolution());
                deferredAttach.reject(new Error('attach exploded'));
                await expectPlaybackError('init_failed', () => loadPromise);
                assert.equal(errors.length, 1);
                assert.equal((instances[0] as FakeShakaPlayer).destroyed, true);
                ok('5e. attach failure → init_failed, player destroyed');
                engine.destroy();
        } finally {
                FakeShakaPlayer.attachHook = null;
                restore();
        }
}

{
        const restore = installBrowserRuntime();
        try {
                // Manifest load rejection (shaka network error) → manifest_load_failed.
                const { module, instances } = makeShakaModule();
                const engine = new LiveTvPlaybackEngine({ shakaLoader: async () => module });
                const video = new FakeVideoElement();
                const errors: LiveTvPlaybackError[] = [];
                engine.on('error', (error) => errors.push(error));
                const deferredLoad = deferred<void>();
                FakeShakaPlayer.loadHook = () => deferredLoad.promise;
                const loadPromise = engine.load(video as unknown as HTMLVideoElement, resolution());
                deferredLoad.reject({
                        severity: SHAKA_ERROR_SEVERITY.CRITICAL,
                        category: SHAKA_ERROR_CATEGORY.NETWORK,
                        code: SHAKA_ERROR_CODE.BAD_HTTP_STATUS
                });
                const err = await expectPlaybackError('manifest_load_failed', () => loadPromise);
                assert.equal(err.code, 1001, 'numeric code preserved');
                assert.equal(engine.getState(), 'error');
                assert.equal(errors.length, 1, 'exactly ONE error event (no double reporting)');
                assert.deepEqual(errors[0]?.kind, 'manifest_load_failed');
                assert.equal((instances[0] as FakeShakaPlayer).destroyed, true, 'failed session destroyed');
                FakeShakaPlayer.loadHook = null;
                ok('5f. manifest load failure → manifest_load_failed (one event + rejection, session destroyed)');
                engine.destroy();
        } finally {
                restore();
        }
}

// ============================================================
// §6 — controls (play/pause/seek/volume/mute/autoplay)
// ============================================================
{
        const restore = installBrowserRuntime();
        try {
                const { module } = makeShakaModule();
                const engine = new LiveTvPlaybackEngine({ shakaLoader: async () => module });
                const video = new FakeVideoElement();
                await engine.load(video as unknown as HTMLVideoElement, resolution());

                await engine.play();
                assert.equal(video.playCalls, 1);
                video.emit('play');
                assert.equal(engine.getState(), 'playing', "video 'play' event → playing state");
                video.emit('playing');
                assert.equal(engine.getState(), 'playing');
                ok('6a. play() + play/playing events → playing');

                engine.pause();
                assert.equal(video.pauseCalls, 1);
                video.emit('pause');
                assert.equal(engine.getState(), 'paused');
                ok('6b. pause() + pause event → paused');

                // Autoplay rejection: NOT a stream failure (state untouched, no error event).
                const autoplayErrors: LiveTvPlaybackError[] = [];
                engine.on('error', (error) => autoplayErrors.push(error));
                video.playImpl = () =>
                        Promise.reject(Object.assign(new Error('autoplay blocked'), { name: 'NotAllowedError' }));
                await expectPlaybackError('autoplay_blocked', () => engine.play());
                assert.equal(engine.getState(), 'paused', 'autoplay rejection does NOT set error state');
                assert.equal(autoplayErrors.length, 0, 'autoplay rejection emits NO error event');
                video.playImpl = async () => {
                        video.paused = false;
                };
                ok('6c. autoplay blocked → controlled rejection, state untouched, no error event');

                // Live seek range clamping.
                (engine as unknown as { player: FakeShakaPlayer }).player.seekRangeValue = { start: 100, end: 200 };
                engine.seek(500);
                assert.equal(video.currentTime, 200, 'seek clamped to live edge');
                engine.seek(50);
                assert.equal(video.currentTime, 100, 'seek clamped to window start');
                engine.seek(150);
                assert.equal(video.currentTime, 150, 'in-range seek passes through');
                ok('6d. live seek clamped to the seek window');

                // VOD-style clamping (no live range, finite duration).
                (engine as unknown as { player: FakeShakaPlayer }).player.seekRangeValue = { start: Number.NaN, end: Number.NaN };
                (engine as unknown as { player: FakeShakaPlayer }).player.liveValue = false;
                video.duration = 60;
                engine.seek(70);
                assert.equal(video.currentTime, 60, 'VOD seek clamped to duration');
                engine.seek(-5);
                assert.equal(video.currentTime, 0, 'VOD seek clamped to 0');
                ok('6e. VOD seek clamped to [0, duration]');

                // No seekable target → no-op.
                video.duration = Number.NaN;
                video.currentTime = 7;
                engine.seek(50);
                assert.equal(video.currentTime, 7, 'no live range + no duration → documented no-op');
                ok('6f. unseekable presentation → seek is a no-op');

                engine.setVolume(0.5);
                assert.equal(video.volume, 0.5);
                engine.setVolume(5);
                assert.equal(video.volume, 1, 'volume clamped to 1');
                engine.setVolume(-1);
                assert.equal(video.volume, 0, 'volume clamped to 0');
                assert.equal(engine.getVolume(), 0);
                engine.setMuted(true);
                assert.equal(video.muted, true);
                assert.equal(engine.isMuted(), true);
                engine.setMuted(false);
                assert.equal(engine.isMuted(), false);
                ok('6g. volume/mute passthrough with clamping');
                engine.destroy();
        } finally {
                restore();
        }
}

{
        // play() without a session / destroyed engine.
        const engine = new LiveTvPlaybackEngine({ shakaLoader: async () => null });
        await expectPlaybackError('playback_failed', () => engine.play());
        engine.destroy();
        await expectPlaybackError('aborted', () => engine.play());
        ok('6h. play() with no session → playback_failed; destroyed → aborted');
}

// ============================================================
// §7 — live behavior
// ============================================================
{
        const restore = installBrowserRuntime();
        try {
                const { module } = makeShakaModule();
                const engine = new LiveTvPlaybackEngine({ shakaLoader: async () => module });
                const video = new FakeVideoElement();
                await engine.load(video as unknown as HTMLVideoElement, resolution());
                const player = (engine as unknown as { player: FakeShakaPlayer }).player;

                player.liveValue = true;
                assert.equal(engine.isLive(), true, 'player.isLive() → true');
                player.liveValue = false;
                video.duration = Infinity;
                assert.equal(engine.isLive(), true, 'Infinity duration fallback → live');
                ok('7a. isLive (player flag + duration fallback)');

                assert.equal(engine.getDuration(), null, 'live duration → null (never fabricated)');
                const durations: Array<number | null> = [];
                engine.on('durationchange', (payload) => durations.push(payload.duration));
                video.emit('durationchange');
                assert.deepEqual(durations, [null], 'durationchange event payload null for live');
                video.duration = 3600;
                video.emit('durationchange');
                assert.deepEqual(durations, [null, 3600], 'finite duration reported');
                assert.equal(engine.getDuration(), 3600);
                ok('7b. live duration → null; finite duration → value (no fabrication)');

                player.seekRangeValue = { start: 1000, end: 2000 };
                assert.deepEqual(engine.getLiveSeekRange(), { start: 1000, end: 2000 }, 'live seek window normalized');
                player.seekRangeValue = { start: 2000, end: 1000 };
                assert.equal(engine.getLiveSeekRange(), null, 'invalid range (end < start) → null');
                player.seekRangeValue = { start: Number.NaN, end: 2000 };
                assert.equal(engine.getLiveSeekRange(), null, 'non-finite range → null');
                player.seekRangeValue = null;
                assert.equal(engine.getLiveSeekRange(), null, 'no range → null (Go-Live UI renders nothing)');
                ok('7c. getLiveSeekRange normalization (valid/invalid/absent)');

                video.currentTime = 42.5;
                assert.equal(engine.getCurrentTime(), 42.5);
                video.currentTime = Number.NaN;
                assert.equal(engine.getCurrentTime(), 0, 'NaN currentTime normalizes to 0');
                ok('7d. currentTime normalization');
                engine.destroy();
        } finally {
                restore();
        }
}

// ============================================================
// §8 — channel switching + stale-session protection
// ============================================================
{
        const restore = installBrowserRuntime();
        try {
                const { module, instances } = makeShakaModule();
                const engine = new LiveTvPlaybackEngine({ shakaLoader: async () => module });
                const video = new FakeVideoElement();
                const errors: LiveTvPlaybackError[] = [];
                engine.on('error', (error) => errors.push(error));

                // A hangs inside player.load().
                const deferredA = deferred<void>();
                FakeShakaPlayer.loadHook = () => deferredA.promise;
                const promiseA = engine.load(video as unknown as HTMLVideoElement, resolution({ channel: { id: '111', name: 'A' }, sources: [{ url: SIGNED_URL_A }] }));
                await new Promise((resolve) => setTimeout(resolve, 5)); // let A reach player.load

                // User switches to B; B completes.
                FakeShakaPlayer.loadHook = null;
                await engine.load(video as unknown as HTMLVideoElement, resolution({ channel: { id: '222', name: 'B' }, sources: [{ url: SIGNED_URL_B }] }));
                assert.equal(engine.getState(), 'loaded', 'B loaded');
                assert.equal(engine.getChannelId(), '222', 'current session is B');

                // A completes LATE — must be ignored (no control, no error).
                deferredA.resolve();
                await expectPlaybackError('aborted', () => promiseA);
                assert.equal(engine.getState(), 'loaded', 'late A completion cannot touch state');
                assert.equal(engine.getChannelId(), '222', 'late A completion cannot switch identity');
                assert.equal(errors.length, 0, 'no error surfaced for the stale session');
                const playerA = instances[0] as FakeShakaPlayer;
                const playerB = instances[1] as FakeShakaPlayer;
                assert.equal(playerA.destroyed, true, 'old Shaka instance destroyed');
                assert.equal(playerB.destroyed, false, 'new Shaka instance active');
                assert.equal(playerA.errorListenerCount(), 0, 'stale error listener removed');
                assert.equal(instances.filter((instance) => !instance.destroyed).length, 1, 'EXACTLY ONE active Shaka instance');
                ok('8a. A→B switch: late A completion ignored, old instance destroyed, one owner');

                // Stale A errors after B took over → ignored.
                playerA.emitError({ severity: SHAKA_ERROR_SEVERITY.CRITICAL, category: SHAKA_ERROR_CATEGORY.NETWORK, code: 1002 });
                assert.equal(errors.length, 0, 'stale session error never surfaces');
                assert.equal(engine.getState(), 'loaded');
                ok('8b. stale A error ignored (no error event, state untouched)');

                // Reload on the SAME engine (channel B → C).
                await engine.load(video as unknown as HTMLVideoElement, resolution({ channel: { id: '333', name: 'C' }, sources: [{ url: SIGNED_URL_A }] }));
                assert.equal(engine.getState(), 'loaded');
                assert.equal(engine.getChannelId(), '333');
                assert.equal(playerB.destroyed, true, 'B destroyed by the reload');
                assert.equal(instances.filter((instance) => !instance.destroyed).length, 1, 'still exactly one active instance');
                ok('8c. reload on the same engine (single owner preserved)');
                engine.destroy();
        } finally {
                FakeShakaPlayer.loadHook = null;
                restore();
        }
}

// ============================================================
// §9 — destroy semantics, abort support
// ============================================================
{
        const restore = installBrowserRuntime();
        try {
                const { module, instances } = makeShakaModule();
                const engine = new LiveTvPlaybackEngine({ shakaLoader: async () => module });
                const video = new FakeVideoElement();
                const errors: LiveTvPlaybackError[] = [];
                engine.on('error', (error) => errors.push(error));

                // destroy() during an in-flight load.
                const deferredLoad = deferred<void>();
                FakeShakaPlayer.loadHook = () => deferredLoad.promise;
                const loadPromise = engine.load(video as unknown as HTMLVideoElement, resolution());
                await new Promise((resolve) => setTimeout(resolve, 5));
                engine.destroy();
                deferredLoad.resolve();
                await expectPlaybackError('aborted', () => loadPromise);
                assert.equal(errors.length, 0, 'destroy never surfaces an error event');
                assert.equal((instances[0] as FakeShakaPlayer).destroyed, true, 'pending session destroyed');
                ok('9a. destroy during load → aborted rejection, session destroyed, no error event');

                // Double destroy + post-destroy inertness.
                engine.destroy();
                engine.destroy();
                assert.equal(engine.getState(), 'destroyed');
                ok('9b. double destroy never throws');

                assert.equal(engine.getVideoElement(), null);
                assert.equal(engine.getChannelId(), null);
                assert.equal(engine.getDuration(), null);
                assert.equal(engine.isLive(), false);
                assert.equal(engine.getCurrentTime(), 0);
                assert.equal(engine.getLiveSeekRange(), null);
                ok('9c. post-destroy introspection is inert');

                let postDestroyEvents = 0;
                engine.on('play', () => {
                        postDestroyEvents += 1;
                });
                video.emit('play');
                video.emit('timeupdate');
                assert.equal(postDestroyEvents, 0, 'no events after destroy');
                assert.equal(video.listenerCount(), 0, 'ALL video listeners removed on destroy');
                ok('9d. no events after destroy; every video listener removed');

                await expectPlaybackError('aborted', () => engine.load(video as unknown as HTMLVideoElement, resolution()));
                ok('9e. load() after destroy → aborted');
                FakeShakaPlayer.loadHook = null;
        } finally {
                FakeShakaPlayer.loadHook = null;
                restore();
        }
}

{
        const restore = installBrowserRuntime();
        try {
                const { module, instances } = makeShakaModule();
                const engine = new LiveTvPlaybackEngine({ shakaLoader: async () => module });
                const video = new FakeVideoElement();
                const errors: LiveTvPlaybackError[] = [];
                engine.on('error', (error) => errors.push(error));

                // Abort DURING load: signal fires while player.load hangs.
                const deferredLoad = deferred<void>();
                FakeShakaPlayer.loadHook = () => deferredLoad.promise;
                const controller = new AbortController();
                const loadPromise = engine.load(video as unknown as HTMLVideoElement, resolution(), { signal: controller.signal });
                await new Promise((resolve) => setTimeout(resolve, 5));
                controller.abort();
                deferredLoad.resolve(); // release the pending continuation
                await expectPlaybackError('aborted', () => loadPromise);
                assert.equal(errors.length, 0, 'abort is not an error');
                assert.equal(engine.getState(), 'idle', 'abort settles back to idle');
                assert.equal((instances[0] as FakeShakaPlayer).destroyed, true, 'aborted session destroyed');
                assert.equal(video.listenerCount(), 0, 'aborted session video listeners removed');
                deferredLoad.resolve();
                ok('9f. AbortSignal during load → clean abandonment (idle, no error, destroyed)');

                // Pre-aborted signal → immediate rejection, previous session untouched.
                await engine.load(video as unknown as HTMLVideoElement, resolution());
                const preAborted = new AbortController();
                preAborted.abort();
                await expectPlaybackError('aborted', () =>
                        engine.load(video as unknown as HTMLVideoElement, resolution({ channel: { id: '999', name: 'X' } }), { signal: preAborted.signal })
                );
                assert.equal(engine.getState(), 'loaded', 'previous session untouched by a pre-aborted load');
                assert.equal(engine.getChannelId(), '143');
                ok('9g. pre-aborted signal → immediate aborted rejection, previous session intact');
                engine.destroy();
        } finally {
                FakeShakaPlayer.loadHook = null;
                restore();
        }
}

// ============================================================
// §10 — normalized video events + state transitions
// ============================================================
{
        const restore = installBrowserRuntime();
        try {
                const { module } = makeShakaModule();
                const engine = new LiveTvPlaybackEngine({ shakaLoader: async () => module });
                const video = new FakeVideoElement();
                const received: string[] = [];
                const payloads: Record<string, unknown[]> = {};
                const track = <K extends keyof Record<string, unknown>>(name: string): void => {
                        payloads[name] = [];
                        engine.on(name as 'play', ((payload: unknown) => {
                                received.push(name);
                                payloads[name]?.push(payload);
                        }) as () => void);
                };
                track('play');
                track('pause');
                track('buffering');
                track('playing');
                track('ended');
                track('seeking');
                track('seeked');
                track('timeupdate');
                track('durationchange');

                await engine.load(video as unknown as HTMLVideoElement, resolution());
                video.currentTime = 12;
                video.emit('timeupdate');
                video.duration = 1800;
                video.emit('durationchange');
                video.emit('play');
                video.emit('playing');
                video.emit('seeking');
                video.emit('seeked');
                video.emit('waiting'); // buffering
                video.emit('playing');
                video.emit('pause');
                video.emit('ended');

                assert.deepEqual(received, [
                        'timeupdate',
                        'durationchange',
                        'play',
                        'playing',
                        'seeking',
                        'seeked',
                        'buffering',
                        'playing',
                        'pause',
                        'ended'
                ], 'every normalized event fires exactly once per video event');
                assert.deepEqual(payloads['timeupdate'], [{ currentTime: 12 }], 'timeupdate payload');
                assert.deepEqual(payloads['durationchange'], [{ duration: 1800 }], 'durationchange payload');
                ok('10a. normalized event forwarding with payloads (no Shaka names)');

                const stateTrace: string[] = [];
                stateTrace.push(engine.getState()); // paused — §10a's 'ended' settled the engine here
                video.emit('play');
                video.emit('playing');
                stateTrace.push(engine.getState()); // playing
                video.emit('waiting');
                stateTrace.push(engine.getState()); // buffering
                video.emit('playing');
                stateTrace.push(engine.getState()); // playing
                video.emit('ended');
                stateTrace.push(engine.getState()); // paused (no 'ended' STATE)
                assert.deepEqual(stateTrace, ['paused', 'playing', 'buffering', 'playing', 'paused'], 'paused → playing ⇄ buffering → playing → paused transitions');
                ok('10b. buffering round-trip + ended settles to paused (no ended state)');

                const transitions: Array<{ state: string; previous: string }> = [];
                engine.on('statechange', (payload) => transitions.push({ state: payload.state, previous: payload.previous }));
                video.emit('play');
                video.emit('playing');
                video.emit('playing'); // duplicate — no transition
                assert.deepEqual(transitions, [{ state: 'playing', previous: 'paused' }], 'statechange fires only on real changes, with previous state');
                ok('10c. statechange payloads {state, previous}; no duplicate transitions');
                engine.destroy();
        } finally {
                restore();
        }
}

// ============================================================
// §11 — security (source-contract scan + behavioral guarantees)
// ============================================================
{
        const here = path.dirname(fileURLToPath(import.meta.url));
        const moduleDir = path.resolve(here, '../src/lib/client/live-tv');
        const sources: Record<string, string> = {
                player: readFileSync(path.join(moduleDir, 'player.ts'), 'utf8'),
                playerErrors: readFileSync(path.join(moduleDir, 'player-errors.ts'), 'utf8'),
                dashAuth: readFileSync(path.join(moduleDir, 'media-auth.ts'), 'utf8')
        };
        const all = Object.values(sources).join('\n');

        assert.ok(!/console\./.test(all), 'zero console calls — nothing (keys/URLs) can be logged');
        assert.ok(!/localStorage\.|sessionStorage\.|indexedDB\./i.test(all), 'no persistent storage APIs');
        assert.ok(!/@supabase|createClient/.test(all), 'no Supabase usage');
        ok('11a. no logging, no persistence APIs, no Supabase in the playback modules');

        assert.ok(!all.includes('livetgtv.lovable.app'), 'engine never calls LiveGT (no hostname)');
        assert.ok(!all.includes('/api/public'), 'engine never builds LiveGT API paths (LT-2 client owns all LiveGT calls)');
        ok('11b. engine performs zero LiveGT calls');

        // Shaka is only referenced through the dynamic import INSIDE the
        // browser-guarded loader — never a static/top-level import.
        assert.ok(!/^import .*shaka-player/m.test(sources.player ?? ''), 'no static shaka-player import');
        assert.ok(!/^import type .*shaka-player/m.test(sources.player ?? ''), 'no type-level shaka-player import either');
        assert.ok((sources.player?.match(/import\('shaka-player'\)/g) ?? []).length === 1, 'exactly one dynamic import (inside the loader)');
        assert.ok(!/from 'shaka-player'/.test(all), 'no module specifier imports of shaka-player');
        ok('11c. Shaka loaded ONLY via the browser-guarded dynamic import');

        assert.ok(!/\.message\b/.test(all), "Shaka's error.message (may embed URIs) is never read anywhere");
        assert.ok(!/\.data\b/.test(sources.player ?? ''), 'Shaka error.data (may embed URIs/tokens) is never read');
        ok('11d. Shaka error message/data fields never read (numbers only)');

        // No top-level (module-evaluation-time) browser global access: the
        // suite itself imports the module under Node (§4c) — plus the source
        // keeps every global read inside function bodies.
        const topLevelGlobals = (sources.player ?? '').split('\n').filter((line) => /^(window|document|navigator|MediaSource)\b/.test(line));
        assert.deepEqual(topLevelGlobals, [], 'no module-scope browser global statements');
        ok('11e. no module-evaluation-time browser global access (SSR-safe source shape)');
}

{
        // Behavioral secret-hygiene: fixture secrets never appear in any
        // error string produced by the engine's failure paths.
        const restore = installBrowserRuntime({ eme: true });
        try {
                const secrets = [FIXTURE_KEY_ID, FIXTURE_KEY, SIGNED_URL_A, '__hdnea__', 'FAKE-ST'];
                const observed: string[] = [];
                const record = (err: unknown): void => {
                        observed.push(String(err));
                };

                // (a) DRM configuration failure with fixture secrets in flight.
                const drmModule = makeShakaModule({ configureResult: false });
                const drmEngine = new LiveTvPlaybackEngine({ shakaLoader: async () => drmModule.module });
                drmEngine.on('error', record);
                await drmEngine
                        .load(
                                new FakeVideoElement() as unknown as HTMLVideoElement,
                                resolution({ drm: { type: 'clearkey', keyId: FIXTURE_KEY_ID, key: FIXTURE_KEY } })
                        )
                        .then(
                                () => assert.fail('expected rejection'),
                                record
                        );

                // (b) Manifest failure whose raw Shaka payload "message" embeds
                //     the signed URL (the engine must never read it).
                const manifestModule = makeShakaModule();
                FakeShakaPlayer.loadHook = () =>
                        Promise.reject({ severity: 2, category: 1, code: 1001, message: `failed for ${SIGNED_URL_A}` });
                const manifestEngine = new LiveTvPlaybackEngine({ shakaLoader: async () => manifestModule.module });
                manifestEngine.on('error', record);
                await manifestEngine
                        .load(new FakeVideoElement() as unknown as HTMLVideoElement, resolution())
                        .then(
                                () => assert.fail('expected rejection'),
                                record
                        );

                // (c) DRM playback failure whose raw payload "message" embeds
                //     the fixture key.
                FakeShakaPlayer.loadHook = null;
                const drmFailModule = makeShakaModule();
                const drmFailEngine = new LiveTvPlaybackEngine({ shakaLoader: async () => drmFailModule.module });
                drmFailEngine.on('error', record);
                await drmFailEngine.load(
                        new FakeVideoElement() as unknown as HTMLVideoElement,
                        resolution({ drm: { type: 'clearkey', keyId: FIXTURE_KEY_ID, key: FIXTURE_KEY } })
                );
                const current = (drmFailEngine as unknown as { player: FakeShakaPlayer }).player;
                current.emitError({ severity: 2, category: 6, code: 6000, message: `key ${FIXTURE_KEY}` });
                await new Promise((resolve) => setTimeout(resolve, 5));

                // (d) Model-level errors for completeness.
                observed.push(String(new LiveTvPlaybackError('drm_config_failed')));
                observed.push(String(new LiveTvPlaybackError('drm_playback_failed')));

                assert.ok(observed.length >= 5, 'multiple failure paths exercised');
                for (const text of observed) {
                        for (const secret of secrets) {
                                assert.ok(!text.includes(secret), `secret material must never appear in error strings (found "${secret}")`);
                        }
                }
                FakeShakaPlayer.loadHook = null;
                drmEngine.destroy();
                manifestEngine.destroy();
                drmFailEngine.destroy();
                ok('11f. no key/keyId/signed-URL/token in ANY error string across failure paths');
        } finally {
                FakeShakaPlayer.loadHook = null;
                restore();
        }
}

// ============================================================
// §12 — LT-2 contract compatibility
// ============================================================
{
        const restore = installBrowserRuntime({ eme: true }); // §12a carries ClearKey DRM
        try {
                // The engine consumes resolveLiveTvPlayback()'s exact output
                // shape — { channel, sources, drm } — with no re-mapping.
                const { module } = makeShakaModule();
                const engine = new LiveTvPlaybackEngine({ shakaLoader: async () => module });
                const video = new FakeVideoElement();
                const lt2Output: LiveTvPlaybackResolution = {
                        channel: { id: '143', name: 'CNBC TV18 Prime', category: 'English', logo: 'https://img.example.com/cnbc.png' },
                        sources: [{ url: SIGNED_URL_A }, { url: SIGNED_URL_B }],
                        drm: { type: 'clearkey', keyId: FIXTURE_KEY_ID, key: FIXTURE_KEY }
                };
                await engine.load(video as unknown as HTMLVideoElement, lt2Output);
                assert.equal(engine.getState(), 'loaded');
                const player = (engine as unknown as { player: FakeShakaPlayer }).player;
                assert.equal(player.loadCalls[0]?.uri, SIGNED_URL_A, 'first source selected (deterministic)');
                assert.equal(player.configureCalls.length, 1, 'ClearKey configured from the LT-2 drm object');
                engine.destroy();
                ok('12a. consumes the exact LT-2 resolution shape (multi-source + ClearKey)');

                // The playback error model stays separate from the LT-2 data
                // error model (different classes, different kinds, both guards).
                const playbackErr = new LiveTvPlaybackError('aborted');
                assert.equal(isLiveTvPlaybackError(playbackErr), true);
                assert.equal(playbackErr instanceof Error, true);
                ok('12b. playback error model is engine-internal and self-contained');
        } finally {
                restore();
        }
}

// ============================================================
// §13 — documented LiveGT own-player contract regression (2026-10-08 audit)
//
// Locks the EXACT documented integration sequence against regressions:
//   new shaka.Player() → await attach(video) → if (drm) configure(clearKeys)
//   → await load(sources[0])   [bare load — NO explicit MIME type]
//
// The audit proved (worklog "DOCUMENTED SHAKA INTEGRATION AUDIT"):
//   * forcing 'application/dash+xml' broke every HLS-source channel
//     (~13% of the V1 catalogue — .m3u8 sources) with a guaranteed
//     manifest-parse failure, while the documented bare load() lets
//     Shaka sniff .mpd/.m3u8 itself and play both;
//   * init order and source selection were behaviorally neutral for
//     .mpd channels — the fixtures below pin them to the documented
//     contract anyway (defense in depth).
// Fixtures are SYNTHETIC stand-ins: real host/path STRUCTURE observed in
// the audited resolver responses, FAKE token values, never fetched.
// ============================================================
{
        const restore = installBrowserRuntime({ eme: true });
        try {
                // Structural fixture: Star Gold HD (156) — jiotvmblive, _MOB,
                // .mpd, ClearKey present (observed shape; token is fake).
                const STAR_GOLD_URL = 'https://jiotvmblive.cdn.jio.com/bpk-tv/Star_Gold_HD_MOB/WDVLive/index.mpd?__hdnea__=FAKE-TOKEN-156';
                const { module, instances } = makeShakaModule();
                const engine = new LiveTvPlaybackEngine({ shakaLoader: async () => module });
                const video = new FakeVideoElement();
                await engine.load(video as unknown as HTMLVideoElement, {
                        channel: { id: '156', name: 'Star Gold HD', category: 'Movies' },
                        sources: [{ url: STAR_GOLD_URL }],
                        drm: { type: 'clearkey', keyId: FIXTURE_KEY_ID, key: FIXTURE_KEY }
                });
                const player = instances[0] as FakeShakaPlayer;
                assert.equal(player.loadCalls[0]?.uri, STAR_GOLD_URL, '156: sources[0] passed to Shaka VERBATIM (no URL alteration)');
                assert.equal(player.loadCalls[0]?.mimeType, undefined, '156: bare load — NO explicit MIME');
                assert.deepEqual(player.callLog, ['attach', 'configure', 'load'], '156: documented order attach → configure → load');
                engine.destroy();
                ok('13a. Star Gold HD 156 path: verbatim sources[0], bare load, documented order');
        } finally {
                restore();
        }
}

{
        const restore = installBrowserRuntime();
        try {
                // Structural fixture: Zee Cinema HD (165) — jiotvpllive, _BTS,
                // .mpd, drm ABSENT (observed shape; token is fake).
                const ZEE_CINEMA_URL = 'https://jiotvpllive.cdn.jio.com/bpk-tv/ZeeCinemaHD_BTS/WDVLive/index.mpd?__hdnea__=FAKE-TOKEN-165';
                const { module, instances } = makeShakaModule();
                const engine = new LiveTvPlaybackEngine({ shakaLoader: async () => module });
                const video = new FakeVideoElement();
                await engine.load(video as unknown as HTMLVideoElement, {
                        channel: { id: '165', name: 'Zee Cinema HD', category: 'Movies' },
                        sources: [{ url: ZEE_CINEMA_URL }],
                        drm: null
                });
                const player = instances[0] as FakeShakaPlayer;
                assert.equal(player.loadCalls[0]?.uri, ZEE_CINEMA_URL, '165: sources[0] passed to Shaka VERBATIM');
                assert.equal(player.loadCalls[0]?.mimeType, undefined, '165: bare load — NO explicit MIME');
                assert.equal(player.loadCalls[0]?.startTime, undefined, '165: no startTime');
                assert.deepEqual(player.callLog, ['attach', 'load'], '165: no DRM → attach → load, configure NEVER called');
                engine.destroy();
                ok('13b. Zee Cinema HD 165 path: verbatim sources[0], bare load, no configure call');
        } finally {
                restore();
        }
}

{
        const restore = installBrowserRuntime({ eme: true });
        try {
                // Control fixture: CNBC TV18 Prime (143) — the docs' own example
                // channel; same jiotvmblive/_MOB/.mpd/ClearKey shape as 156.
                const CNBC_URL = 'https://jiotvmblive.cdn.jio.com/bpk-tv/CNBCTV18Prime_MOB/WDVLive/index.mpd?__hdnea__=FAKE-TOKEN-143';
                const { module, instances } = makeShakaModule();
                const engine = new LiveTvPlaybackEngine({ shakaLoader: async () => module });
                const video = new FakeVideoElement();
                await engine.load(video as unknown as HTMLVideoElement, {
                        channel: { id: '143', name: 'CNBC TV18 Prime', category: 'English' },
                        sources: [{ url: CNBC_URL }],
                        drm: { type: 'clearkey', keyId: FIXTURE_KEY_ID, key: FIXTURE_KEY }
                });
                const player = instances[0] as FakeShakaPlayer;
                assert.equal(player.loadCalls[0]?.uri, CNBC_URL, '143: sources[0] verbatim');
                assert.equal(player.loadCalls[0]?.mimeType, undefined, '143: bare load');
                assert.deepEqual(player.callLog, ['attach', 'configure', 'load'], '143: documented order');
                engine.destroy();
                ok('13c. CNBC TV18 Prime 143 control path: documented contract');
        } finally {
                restore();
        }
}

{
        const restore = installBrowserRuntime();
        try {
                // THE DEFECT LOCK — HLS-source channels (~13% of the V1
                // catalogue, e.g. 9X Tashan 732 / News18 Urdu 1500 shapes):
                // sources[0] ends in .m3u8. The documented bare load lets
                // Shaka sniff the extension and pick its HLS parser; an
                // explicit 'application/dash+xml' (the removed defect) forced
                // the DASH parser onto HLS content → guaranteed
                // manifest_load_failed. This test fails if a MIME argument
                // ever comes back.
                const HLS_URL = 'https://jiotvmblive.cdn.jio.com/bpk-tv/9xTashan/HLSPartner/index.m3u8?__hdnea__=FAKE-TOKEN-HLS';
                const { module, instances } = makeShakaModule();
                const engine = new LiveTvPlaybackEngine({ shakaLoader: async () => module });
                const video = new FakeVideoElement();
                await engine.load(video as unknown as HTMLVideoElement, {
                        channel: { id: '732', name: '9X Tashan' },
                        sources: [{ url: HLS_URL }],
                        drm: null
                });
                const player = instances[0] as FakeShakaPlayer;
                assert.equal(player.loadCalls[0]?.uri, HLS_URL, 'HLS channel: sources[0] verbatim');
                assert.equal(player.loadCalls[0]?.mimeType, undefined, 'HLS channel: load MUST be bare — an explicit dash MIME is the removed defect');
                assert.notEqual(player.loadCalls[0]?.mimeType, 'application/dash+xml', 'HLS channel: forced dash MIME would guarantee manifest_load_failed');
                engine.destroy();
                ok('13d. HLS-source channels load bare (extension sniffing) — defect lock');
        } finally {
                restore();
        }
}

{
        // No-URL-alteration lock across every fixture shape: the exact
        // resolver string (path + query) is what Shaka receives — the engine
        // never rewrites, re-encodes, or strips signed query parameters.
        const cases = [
                SIGNED_URL_A,
                SIGNED_URL_B,
                SIGNED_URL_NOEXT,
                SIGNED_URL_M3U8,
                'https://jiotvmblive.cdn.jio.com/bpk-tv/Star_Gold_HD_MOB/WDVLive/index.mpd?__hdnea__=FAKE-156'
        ];
        for (const url of cases) {
                assert.equal(selectLiveTvPlaybackSource([{ url }]), url, `selection returns the input string byte-for-byte: ${new URL(url).pathname}`);
        }
        ok('13e. no URL alteration — signed query strings survive selection byte-for-byte');
}

// ============================================================
// §14 — LT-9 signed DASH query-auth propagation regression
//
// India production evidence (2026-10-08): Star Gold HD (156) manifest
// loads (signed `__hdnea__` query), playback begins, then Jio CDN
// media-segment requests WITHOUT the query fail 403 "No sub Token"
// (X-ErrType: auth-failure) ~3-4s in; HLS channels (News18 Urdu 1500,
// nw18live, .m3u8) play continuously — the failure is DASH-segment
// specific. Root cause (LT-8 mechanism, now production-confirmed):
// DASH relative SegmentTemplate refs resolve per WHATWG and DROP the
// manifest query; without DASH-IF UrlQueryInfo in the MPD, plain Shaka
// (including the documented example) cannot satisfy the CDN.
//
// The fix (media-auth.ts, formerly dash-auth.ts — LT-11 generalized):
// response filter learns "is DASH" + final
// manifest URI; request filter appends ONLY `__hdnea__` (allowlist —
// census 30/30 source URLs carry exactly that param), byte-exact from
// the already-resolved source URL, to SAME-ORIGIN SEGMENT requests
// that lack it. Everything else untouched.
//
// Fixtures are SYNTHETIC: real observed host/path STRUCTURE, FAKE
// token values, never fetched. Token-bearing fixture values must
// never appear in any engine output (14j/14k).
// ============================================================
{
        // 14a — requirement 2: Star Gold/Jio-style relative DASH segment
        // requests receive the required auth query (byte-exact token).
        const STAR_GOLD_URL = 'https://jiotvmblive.cdn.jio.com/bpk-tv/Star_Gold_HD_MOB/WDVLive/index.mpd?__hdnea__=FAKE-TOKEN-156';
        const STAR_GOLD_SEGMENT = 'https://jiotvmblive.cdn.jio.com/bpk-tv/Star_Gold_HD_MOB/WDVLive/dash/Star_Gold_HD_MOB-audio_1000.dash';
        const session = createMediaAuthSession(STAR_GOLD_URL);
        applyMediaAuthManifestResponse(SHAKA_REQUEST_TYPE.MANIFEST, {
                data: new TextEncoder().encode('<?xml version="1.0" encoding="utf-8"?>\n<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static">').buffer,
                uri: STAR_GOLD_URL
        }, session);
        assert.equal(session.isDash, true, '14a setup: MPD body identified as DASH');
        assert.equal(session.manifestUri, STAR_GOLD_URL, '14a setup: final manifest URI recorded');
        const propagated = propagateMediaSegmentAuth(STAR_GOLD_SEGMENT, session);
        assert.equal(propagated, `${STAR_GOLD_SEGMENT}?__hdnea__=FAKE-TOKEN-156`, '14a: same-origin relative DASH segment gains the signed query byte-exact');
        // The same-origin base is the POST-REDIRECT manifest URI (Shaka's
        // resolution base), which may differ from the source URL's origin.
        const redirected = createMediaAuthSession(STAR_GOLD_URL);
        applyMediaAuthManifestResponse(SHAKA_REQUEST_TYPE.MANIFEST, {
                data: new TextEncoder().encode('<?xml version="1.0"?><MPD profiles="urn:mpeg:dash:profile:isoff-live:2011">').buffer,
                uri: 'https://jiotvmblive.cdn.jio.com/bpk-tv/Star_Gold_HD_MOB/WDVLive/redirected.mpd'
        }, redirected);
        assert.equal(
                propagateMediaSegmentAuth('https://jiotvmblive.cdn.jio.com/bpk-tv/Star_Gold_HD_MOB/WDVLive/dash/seg_1.dash', redirected),
                'https://jiotvmblive.cdn.jio.com/bpk-tv/Star_Gold_HD_MOB/WDVLive/dash/seg_1.dash?__hdnea__=FAKE-TOKEN-156',
                '14a: post-redirect manifest URI is the same-origin anchor'
        );
        ok('14a. Jio-style relative DASH segment requests receive the required auth query');
}

{
        // 14b — requirement 3: existing query parameters on the segment
        // request are preserved (appended, never replaced).
        const session = createMediaAuthSession('https://cdn.example.com/live/index.mpd?__hdnea__=FAKE-TOKEN');
        applyMediaAuthManifestResponse(SHAKA_REQUEST_TYPE.MANIFEST, {
                data: new TextEncoder().encode('<?xml version="1.0"?><MPD>').buffer,
                uri: 'https://cdn.example.com/live/index.mpd'
        }, session);
        const out = propagateMediaSegmentAuth('https://cdn.example.com/live/seg.dash?foo=1&bar=2', session);
        assert.equal(out, 'https://cdn.example.com/live/seg.dash?foo=1&bar=2&__hdnea__=FAKE-TOKEN', '14b: existing params kept, auth appended');
        // Empty-query edge: URL ending in bare '?'.
        assert.equal(
                propagateMediaSegmentAuth('https://cdn.example.com/live/seg.dash?', session),
                'https://cdn.example.com/live/seg.dash?__hdnea__=FAKE-TOKEN',
                '14b: bare-? joiner handled'
        );
        ok('14b. existing segment query parameters preserved');
}

{
        // 14c — requirement 4 + standards-first: a segment URL that already
        // carries the auth parameter (standard DASH-IF UrlQueryInfo handling)
        // is NEVER duplicated or overwritten — the standard mechanism wins.
        const session = createMediaAuthSession('https://cdn.example.com/live/index.mpd?__hdnea__=FAKE-A');
        applyMediaAuthManifestResponse(SHAKA_REQUEST_TYPE.MANIFEST, {
                data: new TextEncoder().encode('<?xml version="1.0"?><MPD>').buffer,
                uri: 'https://cdn.example.com/live/index.mpd'
        }, session);
        assert.equal(
                propagateMediaSegmentAuth('https://cdn.example.com/live/seg.m4s?__hdnea__=STANDARD-HANDLED', session),
                'https://cdn.example.com/live/seg.m4s?__hdnea__=STANDARD-HANDLED',
                '14c: already-present auth param respected (UrlQueryInfo wins)'
        );
        assert.equal(
                propagateMediaSegmentAuth('https://cdn.example.com/live/seg.m4s?x=1&__hdnea__=Y', session),
                'https://cdn.example.com/live/seg.m4s?x=1&__hdnea__=Y',
                '14c: no duplicate appended when present mid-query'
        );
        ok('14c. no duplication/overwrite — standard UrlQueryInfo handling wins');
}

{
        // 14d — requirement 5: the token is NEVER propagated to another
        // origin/hostname (cross-origin leak lock).
        const session = createMediaAuthSession('https://jiotvmblive.cdn.jio.com/bpk-tv/x/index.mpd?__hdnea__=FAKE-TOKEN');
        applyMediaAuthManifestResponse(SHAKA_REQUEST_TYPE.MANIFEST, {
                data: new TextEncoder().encode('<?xml version="1.0"?><MPD>').buffer,
                uri: 'https://jiotvmblive.cdn.jio.com/bpk-tv/x/index.mpd'
        }, session);
        const foreign = [
                'https://jiotvmlive.cdn.jio.com/bpk-tv/x/dash/seg.dash', // different HOST
                'https://example.com/seg.dash', // unrelated origin
                'https://jiotvmblive.cdn.jio.com:8443/seg.dash', // different PORT
                'http://jiotvmblive.cdn.jio.com/seg.dash', // different SCHEME
                '/relative/seg.dash', // unparseable as absolute — never touched
                ''
        ];
        for (const url of foreign) {
                assert.equal(propagateMediaSegmentAuth(url, session), url, `14d: foreign/unparseable URL untouched (${url.slice(0, 48) || '(empty)'})`);
        }
        ok('14d. no token propagation to any other origin/hostname/port');
}

{
        // 14e — requirement 8 (EVOLVED by LT-11 §15): the manifest
        // DETECTION remains protocol-precise — an HLS playlist body is
        // NEVER identified as DASH (and vice versa). Since LT-11, HLS
        // sessions have their OWN deliberately-designed propagation
        // (same-origin variant playlists + segments) — that behavior is
        // specified and regression-locked in §15 below; this block now
        // locks only the detection boundary.
        const HLS_URL = 'https://nw18live.cdn.jio.com/bpk-tv/News18_Urdu_NW18_MOB/output01/index.m3u8?__hdnea__=FAKE-TOKEN-1500';
        const session = createMediaAuthSession(HLS_URL);
        applyMediaAuthManifestResponse(SHAKA_REQUEST_TYPE.MANIFEST, {
                data: new TextEncoder().encode('#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-STREAM-INF:BANDWIDTH=216000\nmedia_video.m3u8').buffer,
                uri: HLS_URL
        }, session);
        assert.equal(session.isDash, false, '14e: HLS playlist body NOT identified as DASH');
        assert.equal(session.isHls, true, '14e: HLS playlist body identified as HLS (LT-11)');
        assert.equal(session.manifestUri, HLS_URL, '14e: master playlist URI recorded as the anchor (LT-11)');
        // A DASH session is never armed by an HLS body nor vice versa.
        const dashOnly = createMediaAuthSession('https://cdn.example.com/live/index.mpd?__hdnea__=FAKE-T');
        applyMediaAuthManifestResponse(SHAKA_REQUEST_TYPE.MANIFEST, {
                data: new TextEncoder().encode('<?xml version="1.0"?><MPD>').buffer,
                uri: 'https://cdn.example.com/live/index.mpd'
        }, dashOnly);
        assert.equal(dashOnly.isDash, true, '14e: MPD body identified as DASH');
        assert.equal(dashOnly.isHls, false, '14e: MPD body NOT identified as HLS');
        // Manifest-detection unit checks (incl. binary/empty/garbage).
        assert.equal(looksLikeDashManifest(new TextEncoder().encode('<?xml version="1.0" encoding="utf-8"?>\n<MPD xmlns="urn:mpeg:dash:schema:mpd:2011">').buffer), true, '14e: MPD prolog detected');
        assert.equal(looksLikeDashManifest(new TextEncoder().encode('<MPD type="dynamic">').buffer), true, '14e: MPD without prolog detected');
        assert.equal(looksLikeDashManifest(new TextEncoder().encode('#EXTM3U').buffer), false, '14e: HLS rejected by DASH detector');
        assert.equal(looksLikeDashManifest(new TextEncoder().encode('').buffer), false, '14e: empty rejected');
        assert.equal(looksLikeDashManifest(new Uint8Array([0, 1, 2, 3]).buffer), false, '14e: binary rejected');
        assert.equal(looksLikeDashManifest(new Uint8Array([0x3c, 0x4d, 0x50, 0x44, 0x20])), true, '14e: MPD via view (not ArrayBuffer)');
        assert.equal(looksLikeDashManifest(null), false, '14e: null rejected');
        // HLS detector unit checks.
        assert.equal(looksLikeHlsPlaylist(new TextEncoder().encode('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nv.m3u8').buffer), true, '14e: HLS master detected');
        assert.equal(looksLikeHlsPlaylist(new TextEncoder().encode('#EXTM3U\n#EXT-X-VERSION:3\n#EXTINF:4,\nseg0.ts').buffer), true, '14e: HLS media playlist detected');
        assert.equal(looksLikeHlsPlaylist(new TextEncoder().encode('<?xml version="1.0"?><MPD>').buffer), false, '14e: MPD rejected by HLS detector');
        assert.equal(looksLikeHlsPlaylist(new Uint8Array([0, 1, 2]).buffer), false, '14e: binary rejected by HLS detector');
        assert.equal(looksLikeHlsPlaylist(null), false, '14e: null rejected by HLS detector');
        ok('14e. protocol detection is precise: DASH and HLS detectors are mutually exclusive');
}

{
        // 14f — requirement 6 + scope (DASH sessions): ONLY
        // RequestType.SEGMENT is modified. DRM/LICENSE, KEY, MANIFEST,
        // timing and unknown types are untouched (ClearKey license material
        // never receives CDN tokens; the MPD request itself already carries
        // the signed query and is never rewritten). HLS-session MANIFEST
        // propagation is a deliberate LT-11 addition — covered in §15e.
        const session = createMediaAuthSession('https://cdn.example.com/live/index.mpd?__hdnea__=FAKE-TOKEN');
        applyMediaAuthManifestResponse(SHAKA_REQUEST_TYPE.MANIFEST, {
                data: new TextEncoder().encode('<?xml version="1.0"?><MPD>').buffer,
                uri: 'https://cdn.example.com/live/index.mpd'
        }, session);
        const types: Array<[number, string]> = [
                [SHAKA_REQUEST_TYPE.MANIFEST, 'MANIFEST'],
                [SHAKA_REQUEST_TYPE.LICENSE, 'LICENSE'],
                [6, 'KEY'],
                [4, 'TIMING'],
                [99, 'UNKNOWN']
        ];
        for (const [type, label] of types) {
                const req = { uris: ['https://cdn.example.com/live/whatever'] };
                applyMediaAuthRequest(type, req, session);
                assert.equal(req.uris[0], 'https://cdn.example.com/live/whatever', `14f: ${label} request untouched`);
        }
        const seg = { uris: ['https://cdn.example.com/live/seg.m4s'] };
        applyMediaAuthRequest(SHAKA_REQUEST_TYPE.SEGMENT, seg, session);
        assert.equal(seg.uris[0], 'https://cdn.example.com/live/seg.m4s?__hdnea__=FAKE-TOKEN', '14f: SEGMENT request is the only modified type (DASH)');
        // Multiple candidate uris (Shaka fallback list) — each judged independently.
        const multi = {
                uris: ['https://cdn.example.com/live/a.m4s', 'https://other.example.com/b.m4s', 'https://cdn.example.com/live/c.m4s?__hdnea__=K']
        };
        applyMediaAuthRequest(SHAKA_REQUEST_TYPE.SEGMENT, multi, session);
        assert.deepEqual(multi.uris, [
                'https://cdn.example.com/live/a.m4s?__hdnea__=FAKE-TOKEN',
                'https://other.example.com/b.m4s',
                'https://cdn.example.com/live/c.m4s?__hdnea__=K'
        ], '14f: per-uri independent judgment (same-origin + not-already-present)');
        ok('14f. DASH sessions: only SEGMENT requests modified; DRM/license/manifest/timing untouched');
}

{
        // 14g — requirement 1: successful channels are unaffected.
        // (a) Unsigned sources (no allowlisted param) — nothing to propagate.
        const unsigned = createMediaAuthSession('https://times-ott-live.akamaized.net/live/index.mpd');
        applyMediaAuthManifestResponse(SHAKA_REQUEST_TYPE.MANIFEST, {
                data: new TextEncoder().encode('<?xml version="1.0"?><MPD>').buffer,
                uri: 'https://times-ott-live.akamaized.net/live/index.mpd'
        }, unsigned);
        assert.equal(
                propagateMediaSegmentAuth('https://times-ott-live.akamaized.net/live/seg.m4s', unsigned),
                'https://times-ott-live.akamaized.net/live/seg.m4s',
                '14g: unsigned channel untouched'
        );
        // (b) Non-auth query params on the SOURCE are never copied (allowlist).
        const extra = createMediaAuthSession('https://cdn.example.com/live/index.mpd?foo=1&__hdnea__=FAKE-T&bar=2');
        applyMediaAuthManifestResponse(SHAKA_REQUEST_TYPE.MANIFEST, {
                data: new TextEncoder().encode('<?xml version="1.0"?><MPD>').buffer,
                uri: 'https://cdn.example.com/live/index.mpd'
        }, extra);
        assert.equal(
                propagateMediaSegmentAuth('https://cdn.example.com/live/seg.m4s', extra),
                'https://cdn.example.com/live/seg.m4s?__hdnea__=FAKE-T',
                '14g: ONLY the allowlisted auth param propagates (foo/bar never copied)'
        );
        // (c) Non-MANIFEST response types never arm the session.
        const neverArmed = createMediaAuthSession('https://cdn.example.com/live/index.mpd?__hdnea__=FAKE-T');
        applyMediaAuthManifestResponse(SHAKA_REQUEST_TYPE.SEGMENT, {
                data: new TextEncoder().encode('<?xml version="1.0"?><MPD>').buffer,
                uri: 'https://cdn.example.com/live/index.mpd'
        }, neverArmed);
        assert.equal(neverArmed.isDash, false, '14g: a SEGMENT response never arms the fallback');
        ok('14g. successful channels unaffected; only proven auth param propagates');
}

{
        // 14h — requirements 9+10+11: engine integration. The documented
        // contract (attach → configure ClearKey → bare load) is UNCHANGED with
        // the filters active; exactly one request + one response filter are
        // installed per session and the full propagation path works through
        // the real engine wiring.
        const restore = installBrowserRuntime({ eme: true });
        try {
                const STAR_GOLD_URL = 'https://jiotvmblive.cdn.jio.com/bpk-tv/Star_Gold_HD_MOB/WDVLive/index.mpd?__hdnea__=FAKE-TOKEN-156';
                const { module, instances } = makeShakaModule();
                const engine = new LiveTvPlaybackEngine({ shakaLoader: async () => module });
                const video = new FakeVideoElement();
                await engine.load(video as unknown as HTMLVideoElement, {
                        channel: { id: '156', name: 'Star Gold HD', category: 'Movies' },
                        sources: [{ url: STAR_GOLD_URL }],
                        drm: { type: 'clearkey', keyId: FIXTURE_KEY_ID, key: FIXTURE_KEY }
                });
                const player = instances[0] as FakeShakaPlayer;
                // Documented contract intact (requirements 9/10/11 + §13 locks).
                assert.equal(player.loadCalls[0]?.uri, STAR_GOLD_URL, '14h: sources[0] verbatim');
                assert.equal(player.loadCalls[0]?.mimeType, undefined, '14h: bare load — no MIME (no LT-8 regression)');
                assert.deepEqual(player.callLog, ['attach', 'configure', 'load'], '14h: documented order intact with filters installed');
                assert.deepEqual(player.configureCalls[0], { drm: { clearKeys: { [FIXTURE_KEY_ID]: FIXTURE_KEY } } }, '14h: ClearKey configured via the documented drm.clearKeys shape');
                // Filters: exactly one of each, installed before load.
                assert.equal(player.networking?.requestFilters.length, 1, '14h: exactly one request filter');
                assert.equal(player.networking?.responseFilters.length, 1, '14h: exactly one response filter');
                assert.ok(player.callLog.indexOf('load') === player.callLog.length - 1, '14h: filters installed before load (load is last call)');
                // Drive the real wiring: manifest response → segment + license requests.
                player.networking?.emitResponse(SHAKA_REQUEST_TYPE.MANIFEST, {
                        data: new TextEncoder().encode('<?xml version="1.0" encoding="utf-8"?>\n<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="dynamic">').buffer,
                        uri: STAR_GOLD_URL
                });
                const seg = { uris: ['https://jiotvmblive.cdn.jio.com/bpk-tv/Star_Gold_HD_MOB/WDVLive/dash/Star_Gold_HD_MOB-video_2000.dash'] };
                player.networking?.emitRequest(SHAKA_REQUEST_TYPE.SEGMENT, seg);
                assert.equal(
                        seg.uris[0],
                        'https://jiotvmblive.cdn.jio.com/bpk-tv/Star_Gold_HD_MOB/WDVLive/dash/Star_Gold_HD_MOB-video_2000.dash?__hdnea__=FAKE-TOKEN-156',
                        '14h: Star Gold segment request carries the signed query through the real engine wiring'
                );
                const license = { uris: ['https://license.example.com/clearkey?kid=abc'] };
                player.networking?.emitRequest(SHAKA_REQUEST_TYPE.LICENSE, license);
                assert.equal(license.uris[0], 'https://license.example.com/clearkey?kid=abc', '14h: license request untouched');
                engine.destroy();
        } finally {
                restore();
        }
        ok('14h. engine integration: documented contract unchanged, filters wired, 156 segment carries token');
}

{
        // 14i — session isolation: each load() gets a FRESH player + FRESH
        // filters; the previous player (and its filters) die on teardown and
        // can never affect the new session (channel-switch safety).
        const restore = installBrowserRuntime();
        try {
                const URL_A = 'https://jiotvmblive.cdn.jio.com/bpk-tv/Star_Gold_HD_MOB/WDVLive/index.mpd?__hdnea__=FAKE-A';
                const URL_B = 'https://jiotvpllive.cdn.jio.com/bpk-tv/ZeeCinemaHD_BTS/WDVLive/index.mpd?__hdnea__=FAKE-B';
                const { module, instances } = makeShakaModule();
                const engine = new LiveTvPlaybackEngine({ shakaLoader: async () => module });
                const video = new FakeVideoElement();
                await engine.load(video as unknown as HTMLVideoElement, { channel: { id: '156', name: 'A' }, sources: [{ url: URL_A }], drm: null });
                await engine.load(video as unknown as HTMLVideoElement, { channel: { id: '165', name: 'B' }, sources: [{ url: URL_B }], drm: null });
                const first = instances[0] as FakeShakaPlayer;
                const second = instances[1] as FakeShakaPlayer;
                assert.equal(first.destroyed, true, '14i: first player destroyed on switch');
                assert.equal(first.networking === second.networking, false, '14i: distinct networking engines per session');
                // Arming the OLD session's filters must not arm the new session.
                first.networking?.emitResponse(SHAKA_REQUEST_TYPE.MANIFEST, {
                        data: new TextEncoder().encode('<?xml version="1.0"?><MPD>').buffer,
                        uri: URL_A
                });
                const req = { uris: ['https://jiotvpllive.cdn.jio.com/bpk-tv/ZeeCinemaHD_BTS/WDVLive/dash/zee-video_1.dash'] };
                second.networking?.emitRequest(SHAKA_REQUEST_TYPE.SEGMENT, req);
                assert.equal(
                        req.uris[0],
                        'https://jiotvpllive.cdn.jio.com/bpk-tv/ZeeCinemaHD_BTS/WDVLive/dash/zee-video_1.dash',
                        '14i: new session unarmed until ITS manifest response arrives (old session cannot arm it)'
                );
                second.networking?.emitResponse(SHAKA_REQUEST_TYPE.MANIFEST, {
                        data: new TextEncoder().encode('<?xml version="1.0"?><MPD>').buffer,
                        uri: URL_B
                });
                const req2 = { uris: ['https://jiotvpllive.cdn.jio.com/bpk-tv/ZeeCinemaHD_BTS/WDVLive/dash/zee-video_1.dash'] };
                second.networking?.emitRequest(SHAKA_REQUEST_TYPE.SEGMENT, req2);
                assert.equal(req2.uris[0], 'https://jiotvpllive.cdn.jio.com/bpk-tv/ZeeCinemaHD_BTS/WDVLive/dash/zee-video_1.dash?__hdnea__=FAKE-B', '14i: new session propagates its OWN token only');
                engine.destroy();
        } finally {
                restore();
        }
        ok('14i. session isolation: fresh filters per load, no cross-session token leakage');
}

{
        // 14j — requirement 7: the token is never logged/exposed. Behavioral:
        // with propagation armed, every engine failure path produces payloads
        // free of the token (and of '__hdnea__' entirely).
        const restore = installBrowserRuntime({ eme: true });
        try {
                const TOKEN = 'FAKE-TOKEN-SECRET-156';
                const SIGNED = `https://jiotvmblive.cdn.jio.com/bpk-tv/Star_Gold_HD_MOB/WDVLive/index.mpd?__hdnea__=${TOKEN}`;
                const { module, instances } = makeShakaModule();
                const engine = new LiveTvPlaybackEngine({ shakaLoader: async () => module });
                const observed: string[] = [];
                engine.on('error', (err) => observed.push(String(err)));
                await engine.load(new FakeVideoElement() as unknown as HTMLVideoElement, {
                        channel: { id: '156', name: 'Star Gold HD' },
                        sources: [{ url: SIGNED }],
                        drm: { type: 'clearkey', keyId: FIXTURE_KEY_ID, key: FIXTURE_KEY }
                });
                const player = instances[0] as FakeShakaPlayer;
                player.networking?.emitResponse(SHAKA_REQUEST_TYPE.MANIFEST, {
                        data: new TextEncoder().encode('<?xml version="1.0"?><MPD>').buffer,
                        uri: SIGNED
                });
                const seg = { uris: ['https://jiotvmblive.cdn.jio.com/bpk-tv/Star_Gold_HD_MOB/WDVLive/dash/s.dash'] };
                player.networking?.emitRequest(SHAKA_REQUEST_TYPE.SEGMENT, seg);
                assert.ok(seg.uris[0]?.includes(TOKEN), '14j setup: propagation active (token in the in-memory request only)');
                // Mid-session network failure — the exact production path.
                player.emitError({ severity: 2, category: 1, code: 1001, message: `GET ${seg.uris[0]} failed` });
                await new Promise((resolve) => setTimeout(resolve, 5));
                assert.equal(engine.getState(), 'error', '14j: network failure surfaced (production path)');
                assert.ok(observed.length >= 1, '14j: error event observed');
                for (const text of observed) {
                        assert.ok(!text.includes(TOKEN), '14j: token never in error payloads');
                        assert.ok(!text.includes('__hdnea__'), '14j: param name never in error payloads');
                }
                engine.destroy();
        } finally {
                restore();
        }
        ok('14j. token never logged or exposed through any engine failure path');
}

{
        // 14k — requirement 7 (source level): media-auth.ts hygiene — the
        // module cannot log, persist, or transmit anything.
        const here = path.dirname(fileURLToPath(import.meta.url));
        const moduleDir = path.resolve(here, '../src/lib/client/live-tv');
        const src = readFileSync(path.join(moduleDir, 'media-auth.ts'), 'utf8');
        assert.ok(!/console\./.test(src), '14k: zero console calls');
        assert.ok(!/localStorage\.|sessionStorage\.|indexedDB\./i.test(src), '14k: no storage APIs');
        assert.ok(!/fetch\(|XMLHttpRequest|sendBeacon/.test(src), '14k: never fetches/transmits (no new token acquisition)');
        assert.ok(!src.includes('livetgtv.lovable.app'), '14k: no LiveGT hostname');
        assert.ok(!/\/api\/public/.test(src), '14k: no LiveGT API paths');
        assert.ok(!/@supabase|createClient/.test(src), '14k: no Supabase');
        assert.ok(!/from 'shaka-player'|import\('shaka-player'\)/.test(src), '14k: no shaka imports (pure module)');
        assert.ok(!/\.message\b/.test(src), '14k: never reads error.message');
        // The allowlist is exactly the one proven parameter.
        const allowlist = src.match(/AUTH_QUERY_PARAMS[^=]*=\s*\[([^\]]*)\]/)?.[1] ?? '';
        assert.ok(allowlist.includes("'__hdnea__'") && !allowlist.includes("'hdnea'"), "14k: allowlist is exactly ['__hdnea__']");
        ok('14k. media-auth.ts source hygiene: no logging/persistence/fetching/leakage surface');
}

{
        // 14l — defensive installation: anything missing/throwing leaves
        // playback EXACTLY as documented (fallback strictly best-effort).
        assert.equal(installMediaAuthFilters(null, 'https://x/y.mpd?__hdnea__=T'), null, '14l: null player → no install');
        assert.equal(installMediaAuthFilters({}, 'https://x/y.mpd?__hdnea__=T'), null, '14l: no getNetworkingEngine → no install');
        assert.equal(
                installMediaAuthFilters({ getNetworkingEngine: () => null }, 'https://x/y.mpd?__hdnea__=T'),
                null,
                '14l: null engine → no install'
        );
        assert.equal(
                installMediaAuthFilters(
                        {
                                getNetworkingEngine: () => {
                                        throw new Error('boom');
                                }
                        },
                        'https://x/y.mpd?__hdnea__=T'
                ),
                null,
                '14l: throwing getter → no install (never breaks playback)'
        );
        assert.equal(installMediaAuthFilters({ getNetworkingEngine: () => ({}) as object }, 'https://x/y.mpd?__hdnea__=T'), null, '14l: malformed engine → no install');
        const restore = installBrowserRuntime();
        try {
                // A player WITHOUT a networking engine still loads exactly as
                // documented (LT-8 contract preserved when the fallback can't arm).
                const { module, instances } = makeShakaModule({ noNetworkingEngine: true });
                const engine = new LiveTvPlaybackEngine({ shakaLoader: async () => module });
                await engine.load(new FakeVideoElement() as unknown as HTMLVideoElement, resolution());
                const player = instances[0] as FakeShakaPlayer;
                assert.equal(player.loadCalls[0]?.mimeType, undefined, '14l: bare load preserved');
                assert.deepEqual(player.callLog, ['attach', 'load'], '14l: documented sequence preserved');
                assert.equal(engine.getState(), 'loaded', '14l: session loaded without filters');
                engine.destroy();
        } finally {
                restore();
        }
        ok('14l. fallback installation is best-effort; documented playback unaffected without it');
}

// ============================================================
// §15 — LT-11 generic HLS query-auth propagation regression
//
// India production evidence (2026-10-08, LT-10/LT-11): B4U Music (183)
// — HLS on jiotvmblive.cdn.jio.com (HLSPartner) — FAILS in India, while
// the HLS control on a DIFFERENT host (News18 Urdu 1500, nw18live) plays
// continuously and DASH on the SAME host needed segment tokens (LT-9,
// production-proven). Mechanism (shaka-player 5.2.12 source, verified):
// the HLS parser resolves variant/segment refs through the SAME
// resolveUris → new URL(relative, base) — the master's `__hdnea__` query
// is dropped for every relative child ref; the only standard HLS
// propagation is a playlist-declared #EXT-X-DEFINE:QUERYPARAM (upstream's
// choice, absent). Reference design (LiveGT's own embed player, decoded
// from their production bundles): their Shaka request filter propagates
// their credential to MANIFEST and SEGMENT requests for BOTH protocols.
//
// The LT-11 fix (media-auth.ts): HLS master-playlist response arms an
// HLS session; the SAME-ORIGIN variant playlists (RequestType.MANIFEST)
// and segments (RequestType.SEGMENT) gain the allowlisted auth param —
// byte-exact from the resolved source URL, never duplicated, never
// cross-origin. The MASTER itself already carries the query from the
// source URL (already-present guard → no-op).
//
// Fixtures are SYNTHETIC: real observed host/path STRUCTURE, FAKE token
// values, never fetched.
// ============================================================
{
        // 15a — B4U-class: HLS master arms the session; same-origin variant
        // playlist (MANIFEST type) and media segment (SEGMENT type) requests
        // gain the auth query byte-exact.
        const B4U_URL = 'https://jiotvmblive.cdn.jio.com/bpk-tv/b4u_music/HLSPartner/index.m3u8?__hdnea__=FAKE-TOKEN-183';
        const session = createMediaAuthSession(B4U_URL);
        applyMediaAuthManifestResponse(SHAKA_REQUEST_TYPE.MANIFEST, {
                data: new TextEncoder().encode('#EXTM3U\n#EXT-X-VERSION:6\n#EXT-X-STREAM-INF:BANDWIDTH=722000,RESOLUTION=640x360\nb4u_music_360p/index.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=1456000,RESOLUTION=854x480\nb4u_music_480p/index.m3u8').buffer,
                uri: B4U_URL
        }, session);
        assert.equal(session.isHls, true, '15a: HLS master body identified');
        assert.equal(session.manifestUri, B4U_URL, '15a: master playlist is the anchor');
        assert.equal(
                propagateHlsPlaylistAuth('https://jiotvmblive.cdn.jio.com/bpk-tv/b4u_music/HLSPartner/b4u_music_480p/index.m3u8', session),
                'https://jiotvmblive.cdn.jio.com/bpk-tv/b4u_music/HLSPartner/b4u_music_480p/index.m3u8?__hdnea__=FAKE-TOKEN-183',
                '15a: same-origin variant playlist (MANIFEST type) gains the signed query'
        );
        assert.equal(
                propagateMediaSegmentAuth('https://jiotvmblive.cdn.jio.com/bpk-tv/b4u_music/HLSPartner/b4u_music_480p/seg-1000.ts', session),
                'https://jiotvmblive.cdn.jio.com/bpk-tv/b4u_music/HLSPartner/b4u_music_480p/seg-1000.ts?__hdnea__=FAKE-TOKEN-183',
                '15a: same-origin HLS media segment (SEGMENT type) gains the signed query'
        );
        ok('15a. B4U-class HLS: variant playlists and segments receive the required auth query');
}

{
        // 15b — the master's own MANIFEST request and existing query
        // parameters are never rewritten: the master already carries the
        // signed query from the source URL (already-present guard), and any
        // pre-existing params on child requests are preserved.
        const MASTER = 'https://jiotvmblive.cdn.jio.com/bpk-tv/b4u_music/HLSPartner/index.m3u8?__hdnea__=FAKE-TOKEN-183';
        const session = createMediaAuthSession(MASTER);
        applyMediaAuthManifestResponse(SHAKA_REQUEST_TYPE.MANIFEST, {
                data: new TextEncoder().encode('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nv.m3u8').buffer,
                uri: MASTER
        }, session);
        assert.equal(propagateHlsPlaylistAuth(MASTER, session), MASTER, '15b: master request (already signed) never rewritten/duplicated');
        assert.equal(
                propagateHlsPlaylistAuth('https://jiotvmblive.cdn.jio.com/bpk-tv/b4u_music/HLSPartner/v.m3u8?foo=1', session),
                'https://jiotvmblive.cdn.jio.com/bpk-tv/b4u_music/HLSPartner/v.m3u8?foo=1&__hdnea__=FAKE-TOKEN-183',
                '15b: existing variant params kept, auth appended'
        );
        assert.equal(
                propagateMediaSegmentAuth('https://jiotvmblive.cdn.jio.com/bpk-tv/b4u_music/HLSPartner/seg.ts?', session),
                'https://jiotvmblive.cdn.jio.com/bpk-tv/b4u_music/HLSPartner/seg.ts?__hdnea__=FAKE-TOKEN-183',
                '15b: bare-? joiner handled for segments'
        );
        ok('15b. signed master never rewritten; existing child params preserved');
}

{
        // 15c — standard mechanism wins: a child URL that already carries
        // the auth param (absolute child URLs with their own query, or a
        // playlist-declared #EXT-X-DEFINE:QUERYPARAM) is never duplicated.
        const session = createMediaAuthSession('https://jiotvmblive.cdn.jio.com/bpk-tv/b4u_music/HLSPartner/index.m3u8?__hdnea__=FAKE-A');
        applyMediaAuthManifestResponse(SHAKA_REQUEST_TYPE.MANIFEST, {
                data: new TextEncoder().encode('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nv.m3u8').buffer,
                uri: 'https://jiotvmblive.cdn.jio.com/bpk-tv/b4u_music/HLSPartner/index.m3u8'
        }, session);
        assert.equal(
                propagateHlsPlaylistAuth('https://jiotvmblive.cdn.jio.com/bpk-tv/b4u_music/HLSPartner/v.m3u8?__hdnea__=STANDARD-HANDLED', session),
                'https://jiotvmblive.cdn.jio.com/bpk-tv/b4u_music/HLSPartner/v.m3u8?__hdnea__=STANDARD-HANDLED',
                '15c: already-present auth param respected (EXT-X-DEFINE/absolute child query wins)'
        );
        assert.equal(
                propagateMediaSegmentAuth('https://jiotvmblive.cdn.jio.com/bpk-tv/b4u_music/HLSPartner/seg.ts?x=1&__hdnea__=Y', session),
                'https://jiotvmblive.cdn.jio.com/bpk-tv/b4u_music/HLSPartner/seg.ts?x=1&__hdnea__=Y',
                '15c: no duplicate appended mid-query'
        );
        ok('15c. no duplication/overwrite — standard HLS mechanisms always win');
}

{
        // 15d — cross-origin lock: the token NEVER propagates to another
        // origin/hostname/port — not to variant playlists, not to segments,
        // and not to another CDN's URL appearing inside the playlist.
        const session = createMediaAuthSession('https://jiotvmblive.cdn.jio.com/bpk-tv/b4u_music/HLSPartner/index.m3u8?__hdnea__=FAKE-TOKEN');
        applyMediaAuthManifestResponse(SHAKA_REQUEST_TYPE.MANIFEST, {
                data: new TextEncoder().encode('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nv.m3u8').buffer,
                uri: 'https://jiotvmblive.cdn.jio.com/bpk-tv/b4u_music/HLSPartner/index.m3u8'
        }, session);
        const foreign = [
                'https://jiotvmlive.cdn.jio.com/bpk-tv/x/v.m3u8',
                'https://example.com/playlist.m3u8',
                'https://jiotvmblive.cdn.jio.com:8443/v.m3u8',
                'https://license.example.com/drm',
                '/relative/seg.ts',
                ''
        ];
        for (const url of foreign) {
                assert.equal(propagateHlsPlaylistAuth(url, session), url, `15d: foreign playlist URL untouched (${url.slice(0, 48) || '(empty)'})`);
                assert.equal(propagateMediaSegmentAuth(url, session), url, `15d: foreign segment URL untouched (${url.slice(0, 48) || '(empty)'})`);
        }
        ok('15d. no token propagation to any other origin/hostname/port (HLS)');
}

{
        // 15e — request-type scope for HLS sessions: variant playlists
        // (MANIFEST) and media segments (SEGMENT) are the ONLY modified
        // types. DRM/LICENSE, KEY, timing, unknown — untouched. And DASH
        // sessions NEVER gain MANIFEST-type propagation (an MPD request is
        // never rewritten; the jiotvpllive 403 class stays an upstream
        // concern the fallback deliberately does not touch).
        const hls = createMediaAuthSession('https://jiotvmblive.cdn.jio.com/bpk-tv/b4u_music/HLSPartner/index.m3u8?__hdnea__=FAKE-H');
        applyMediaAuthManifestResponse(SHAKA_REQUEST_TYPE.MANIFEST, {
                data: new TextEncoder().encode('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nv.m3u8').buffer,
                uri: 'https://jiotvmblive.cdn.jio.com/bpk-tv/b4u_music/HLSPartner/index.m3u8'
        }, hls);
        for (const [type, label] of [
                [SHAKA_REQUEST_TYPE.LICENSE, 'LICENSE'],
                [6, 'KEY'],
                [4, 'TIMING'],
                [99, 'UNKNOWN']
        ] as Array<[number, string]>) {
                const req = { uris: ['https://jiotvmblive.cdn.jio.com/bpk-tv/b4u_music/HLSPartner/whatever'] };
                applyMediaAuthRequest(type, req, hls);
                assert.equal(req.uris[0], 'https://jiotvmblive.cdn.jio.com/bpk-tv/b4u_music/HLSPartner/whatever', `15e: HLS session ${label} request untouched`);
        }
        const variant = { uris: ['https://jiotvmblive.cdn.jio.com/bpk-tv/b4u_music/HLSPartner/v.m3u8'] };
        applyMediaAuthRequest(SHAKA_REQUEST_TYPE.MANIFEST, variant, hls);
        assert.equal(variant.uris[0], 'https://jiotvmblive.cdn.jio.com/bpk-tv/b4u_music/HLSPartner/v.m3u8?__hdnea__=FAKE-H', '15e: HLS session MANIFEST (variant) request is modified');
        const dash = createMediaAuthSession('https://jiotvmblive.cdn.jio.com/bpk-tv/Star_Gold_HD_MOB/WDVLive/index.mpd?__hdnea__=FAKE-D');
        applyMediaAuthManifestResponse(SHAKA_REQUEST_TYPE.MANIFEST, {
                data: new TextEncoder().encode('<?xml version="1.0"?><MPD>').buffer,
                uri: 'https://jiotvmblive.cdn.jio.com/bpk-tv/Star_Gold_HD_MOB/WDVLive/index.mpd'
        }, dash);
        const mpdReq = { uris: ['https://jiotvmblive.cdn.jio.com/bpk-tv/Star_Gold_HD_MOB/WDVLive/other.mpd'] };
        applyMediaAuthRequest(SHAKA_REQUEST_TYPE.MANIFEST, mpdReq, dash);
        assert.equal(mpdReq.uris[0], 'https://jiotvmblive.cdn.jio.com/bpk-tv/Star_Gold_HD_MOB/WDVLive/other.mpd', '15e: DASH session MANIFEST request never modified (LT-9 boundary preserved)');
        ok('15e. HLS sessions modify MANIFEST(variant)+SEGMENT only; DASH sessions never touch MANIFEST');
}

{
        // 15f — unsigned HLS channels are unaffected (nothing to
        // propagate), and a media-playlist-direct source (no master)
        // still arms the session and propagates to its segments.
        const unsigned = createMediaAuthSession('https://cdn.example.com/live/index.m3u8');
        applyMediaAuthManifestResponse(SHAKA_REQUEST_TYPE.MANIFEST, {
                data: new TextEncoder().encode('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nv.m3u8').buffer,
                uri: 'https://cdn.example.com/live/index.m3u8'
        }, unsigned);
        assert.equal(
                propagateMediaSegmentAuth('https://cdn.example.com/live/seg.ts', unsigned),
                'https://cdn.example.com/live/seg.ts',
                '15f: unsigned HLS channel untouched'
        );
        const mediaDirect = createMediaAuthSession('https://nw18live.cdn.jio.com/bpk-tv/x/output01/index.m3u8?__hdnea__=FAKE-M');
        applyMediaAuthManifestResponse(SHAKA_REQUEST_TYPE.MANIFEST, {
                data: new TextEncoder().encode('#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:4\n#EXTINF:4.0,\nseg_001.ts\n#EXT-X-ENDLIST').buffer,
                uri: 'https://nw18live.cdn.jio.com/bpk-tv/x/output01/index.m3u8'
        }, mediaDirect);
        assert.equal(mediaDirect.isHls, true, '15f: media-playlist-direct body identified as HLS');
        assert.equal(
                propagateMediaSegmentAuth('https://nw18live.cdn.jio.com/bpk-tv/x/output01/seg_001.ts', mediaDirect),
                'https://nw18live.cdn.jio.com/bpk-tv/x/output01/seg_001.ts?__hdnea__=FAKE-M',
                '15f: media-playlist-direct session propagates to segments'
        );
        ok('15f. unsigned channels untouched; media-playlist-direct sessions supported');
}

{
        // 15g — anchor stability: later media-playlist responses (fetched
        // as MANIFEST type during live sliding-window updates) NEVER move
        // the same-origin anchor; a non-MANIFEST response never arms;
        // a redirect on the master is honored (first identified response).
        const session = createMediaAuthSession('https://jiotvmblive.cdn.jio.com/bpk-tv/b4u_music/HLSPartner/index.m3u8?__hdnea__=FAKE-T');
        applyMediaAuthManifestResponse(SHAKA_REQUEST_TYPE.MANIFEST, {
                data: new TextEncoder().encode('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nv.m3u8').buffer,
                uri: 'https://jiotvmblive.cdn.jio.com/bpk-tv/b4u_music/HLSPartner/index.m3u8'
        }, session);
        // A later media-playlist response on ANOTHER origin must not move the anchor.
        applyMediaAuthManifestResponse(SHAKA_REQUEST_TYPE.MANIFEST, {
                data: new TextEncoder().encode('#EXTM3U\n#EXTINF:4,\nseg.ts').buffer,
                uri: 'https://other-origin.example.com/v.m3u8'
        }, session);
        assert.equal(session.manifestUri, 'https://jiotvmblive.cdn.jio.com/bpk-tv/b4u_music/HLSPartner/index.m3u8', '15g: media-playlist response never moves the anchor');
        // Segment-type responses never arm anything.
        const notArmed = createMediaAuthSession('https://cdn.example.com/live/index.m3u8?__hdnea__=FAKE-T');
        applyMediaAuthManifestResponse(SHAKA_REQUEST_TYPE.SEGMENT, {
                data: new TextEncoder().encode('#EXTM3U\n#EXTINF:4,\nseg.ts').buffer,
                uri: 'https://cdn.example.com/live/index.m3u8'
        }, notArmed);
        assert.equal(notArmed.isHls, false, '15g: SEGMENT response never arms the session');
        ok('15g. anchor stability: first identified playlist response anchors the session');
}

{
        // 15h — engine integration (HLS): the documented contract (attach →
        // bare load; no DRM configured when none is supplied) is unchanged
        // with the filters active, and the full HLS propagation path works
        // through the real engine wiring: master response → variant playlist
        // + segment requests carry the token; license untouched.
        const restore = installBrowserRuntime();
        try {
                const B4U_URL = 'https://jiotvmblive.cdn.jio.com/bpk-tv/b4u_music/HLSPartner/index.m3u8?__hdnea__=FAKE-TOKEN-183';
                const { module, instances } = makeShakaModule();
                const engine = new LiveTvPlaybackEngine({ shakaLoader: async () => module });
                const video = new FakeVideoElement();
                await engine.load(video as unknown as HTMLVideoElement, {
                        channel: { id: '183', name: 'B4U Music', category: 'Music' },
                        sources: [{ url: B4U_URL }],
                        drm: null
                });
                const player = instances[0] as FakeShakaPlayer;
                // Documented contract intact.
                assert.equal(player.loadCalls[0]?.uri, B4U_URL, '15h: sources[0] verbatim');
                assert.equal(player.loadCalls[0]?.mimeType, undefined, '15h: bare load — no MIME');
                assert.deepEqual(player.callLog, ['attach', 'load'], '15h: documented order intact (no configure — no DRM supplied)');
                assert.equal(player.configureCalls.length, 0, '15h: ClearKey NOT configured when drm is null');
                // Filters: exactly one of each.
                assert.equal(player.networking?.requestFilters.length, 1, '15h: exactly one request filter');
                assert.equal(player.networking?.responseFilters.length, 1, '15h: exactly one response filter');
                // Drive the wiring: master playlist response → variant + segment requests.
                player.networking?.emitResponse(SHAKA_REQUEST_TYPE.MANIFEST, {
                        data: new TextEncoder().encode('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1456000,RESOLUTION=854x480\nb4u_music_480p/index.m3u8').buffer,
                        uri: B4U_URL
                });
                const variant = { uris: ['https://jiotvmblive.cdn.jio.com/bpk-tv/b4u_music/HLSPartner/b4u_music_480p/index.m3u8'] };
                player.networking?.emitRequest(SHAKA_REQUEST_TYPE.MANIFEST, variant);
                assert.equal(
                        variant.uris[0],
                        'https://jiotvmblive.cdn.jio.com/bpk-tv/b4u_music/HLSPartner/b4u_music_480p/index.m3u8?__hdnea__=FAKE-TOKEN-183',
                        '15h: variant playlist request carries the signed query through the real engine wiring'
                );
                const seg = { uris: ['https://jiotvmblive.cdn.jio.com/bpk-tv/b4u_music/HLSPartner/b4u_music_480p/media-1000.ts'] };
                player.networking?.emitRequest(SHAKA_REQUEST_TYPE.SEGMENT, seg);
                assert.equal(
                        seg.uris[0],
                        'https://jiotvmblive.cdn.jio.com/bpk-tv/b4u_music/HLSPartner/b4u_music_480p/media-1000.ts?__hdnea__=FAKE-TOKEN-183',
                        '15h: HLS segment request carries the signed query through the real engine wiring'
                );
                const license = { uris: ['https://license.example.com/clearkey'] };
                player.networking?.emitRequest(SHAKA_REQUEST_TYPE.LICENSE, license);
                assert.equal(license.uris[0], 'https://license.example.com/clearkey', '15h: license request untouched');
                engine.destroy();
        } finally {
                restore();
        }
        ok('15h. engine integration: documented contract unchanged, HLS filters wired, variant+segment carry token');
}

{
        // 15i — LT-9 DASH production behavior is preserved end-to-end after
        // the LT-11 generalization (the Star Gold evidence case).
        const restore = installBrowserRuntime({ eme: true });
        try {
                const STAR_GOLD_URL = 'https://jiotvmblive.cdn.jio.com/bpk-tv/Star_Gold_HD_MOB/WDVLive/index.mpd?__hdnea__=FAKE-TOKEN-156';
                const { module, instances } = makeShakaModule();
                const engine = new LiveTvPlaybackEngine({ shakaLoader: async () => module });
                await engine.load(new FakeVideoElement() as unknown as HTMLVideoElement, {
                        channel: { id: '156', name: 'Star Gold HD' },
                        sources: [{ url: STAR_GOLD_URL }],
                        drm: { type: 'clearkey', keyId: FIXTURE_KEY_ID, key: FIXTURE_KEY }
                });
                const player = instances[0] as FakeShakaPlayer;
                player.networking?.emitResponse(SHAKA_REQUEST_TYPE.MANIFEST, {
                        data: new TextEncoder().encode('<?xml version="1.0"?><MPD type="dynamic">').buffer,
                        uri: STAR_GOLD_URL
                });
                const seg = { uris: ['https://jiotvmblive.cdn.jio.com/bpk-tv/Star_Gold_HD_MOB/WDVLive/dash/Star_Gold_HD_MOB-video_2000.dash'] };
                player.networking?.emitRequest(SHAKA_REQUEST_TYPE.SEGMENT, seg);
                assert.equal(
                        seg.uris[0],
                        'https://jiotvmblive.cdn.jio.com/bpk-tv/Star_Gold_HD_MOB/WDVLive/dash/Star_Gold_HD_MOB-video_2000.dash?__hdnea__=FAKE-TOKEN-156',
                        '15i: LT-9 DASH segment propagation preserved after the LT-11 generalization'
                );
                // The session was armed as DASH (not HLS): a MANIFEST-type
                // request stays untouched for it (LT-9 boundary).
                const mpdReq = { uris: ['https://jiotvmblive.cdn.jio.com/bpk-tv/Star_Gold_HD_MOB/WDVLive/sub.mpd'] };
                player.networking?.emitRequest(SHAKA_REQUEST_TYPE.MANIFEST, mpdReq);
                assert.equal(mpdReq.uris[0], 'https://jiotvmblive.cdn.jio.com/bpk-tv/Star_Gold_HD_MOB/WDVLive/sub.mpd', '15i: session armed as DASH — MANIFEST requests untouched');
                engine.destroy();
        } finally {
                restore();
        }
        ok('15i. LT-9 DASH propagation behavior preserved byte-for-byte after generalization');
}

console.log(`\nlive_tv_player_test: ${passed} checks passed (LT-3 DASH/ClearKey + LT-9 DASH auth + LT-11 HLS auth).`);
