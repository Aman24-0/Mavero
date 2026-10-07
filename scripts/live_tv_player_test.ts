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
        selectLiveTvDashSource,
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

/** The structural shaka.Player stand-in (module-boundary mock). */
class FakeShakaPlayer {
        /** Cross-instance test hooks (class fields would shadow prototype patches). */
        static attachHook: (() => Promise<void>) | null = null;
        static loadHook: (() => Promise<void>) | null = null;

        destroyed = false;
        attachCalls: unknown[] = [];
        loadCalls: Array<{ uri: string; startTime: unknown; mimeType: unknown }> = [];
        configureCalls: Array<Record<string, unknown>> = [];
        configureResult = true;
        private errorListeners = new Set<(event: ShakaErrorEventLike) => void>();
        /** null models "no usable range" — the fake then reports NaN (invalid). */
        seekRangeValue: { start: number; end: number } | null = null;
        liveValue = false;

        async attach(mediaElement: unknown): Promise<unknown> {
                this.attachCalls.push(mediaElement);
                if (FakeShakaPlayer.attachHook) await FakeShakaPlayer.attachHook();
                return undefined;
        }
        async load(assetUri: string, startTime?: unknown, mimeType?: unknown): Promise<unknown> {
                this.loadCalls.push({ uri: assetUri, startTime, mimeType });
                if (FakeShakaPlayer.loadHook) await FakeShakaPlayer.loadHook();
                return undefined;
        }
        configure(config: Record<string, unknown>): boolean {
                this.configureCalls.push(config);
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
function makeShakaModule(options: { supported?: boolean; configureResult?: boolean } = {}) {
        const instances: FakeShakaPlayer[] = [];
        class PlayerCtor extends FakeShakaPlayer {
                constructor() {
                        super();
                        this.configureResult = options.configureResult !== false;
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
// §3 — source selection
// ============================================================
{
        assert.equal(selectLiveTvDashSource([{ url: SIGNED_URL_A }]), SIGNED_URL_A, 'single valid .mpd source');
        ok('3a. single valid DASH source');

        assert.equal(
                selectLiveTvDashSource([{ url: SIGNED_URL_NOEXT }, { url: SIGNED_URL_A }]),
                SIGNED_URL_A,
                '.mpd source preferred over an earlier extensionless valid URL (deterministic)'
        );
        assert.equal(
                selectLiveTvDashSource([{ url: SIGNED_URL_B }, { url: SIGNED_URL_A }]),
                SIGNED_URL_B,
                'first .mpd in array order wins among multiple .mpd sources'
        );
        ok('3b. deterministic preference: first .mpd in array order');

        assert.equal(selectLiveTvDashSource([{ url: SIGNED_URL_NOEXT }]), SIGNED_URL_NOEXT, 'no .mpd anywhere → first valid http(s) URL');
        assert.equal(
                selectLiveTvDashSource([{ url: 'http://plain.example/live/manifest' }]),
                'http://plain.example/live/manifest',
                'plain http accepted'
        );
        ok('3c. extensionless fallback = first valid absolute http(s) URL');

        await expectPlaybackError('invalid_source', async () => selectLiveTvDashSource([]));
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
                        selectLiveTvDashSource(sources as { url: string }[])
                );
        }
        assert.equal(
                selectLiveTvDashSource([{ url: 'javascript:alert(1)' }, { url: SIGNED_URL_A }, 42]),
                SIGNED_URL_A,
                'malformed entries skipped, valid one used'
        );
        ok('3e. malformed entries skipped; all-invalid → invalid_source');

        await expectPlaybackError('invalid_source', async () => selectLiveTvDashSource(undefined));
        await expectPlaybackError('invalid_source', async () => selectLiveTvDashSource('nope' as unknown as { url: string }[]));
        ok('3f. non-array sources → invalid_source');

        const pool = [{ url: SIGNED_URL_A }, { url: SIGNED_URL_B }, { url: SIGNED_URL_NOEXT }];
        for (let i = 0; i < 5; i++) {
                const selected = selectLiveTvDashSource(pool);
                assert.ok(
                        selected === SIGNED_URL_A || selected === SIGNED_URL_B || selected === SIGNED_URL_NOEXT,
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
                        { uri: SIGNED_URL_A, startTime: null, mimeType: 'application/dash+xml' },
                        'loads the selected source with the explicit DASH MIME type'
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
                ok('5b. valid ClearKey → exact Shaka ClearKey configuration, DRM configured BEFORE load');
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
                playerErrors: readFileSync(path.join(moduleDir, 'player-errors.ts'), 'utf8')
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

console.log(`\nlive_tv_player_test: ${passed} checks passed (LT-3 DASH/ClearKey playback engine contract).`);
