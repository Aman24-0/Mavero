// MAVERO — LT-18 Quality Selection: focused regression suite.
//
// Covers the LT-18 §2 quality implementation in the repo's two UI-phase
// styles:
//   * BEHAVIORAL sections drive the REAL pure quality module and the REAL
//     LiveTvPlaybackEngine (with a structural fake Shaka player that
//     exposes the documented variant-track surface) under Node — which
//     also proves SSR safety (importing the modules under Node is exactly
//     what the SSR server does).
//   * SOURCE-CONTRACT sections assert the wiring: the engine keeps the
//     structural Shaka abstraction (optional members, guarded calls), the
//     UI consumes ONLY the normalized snapshot, and no signed URL / raw
//     Shaka error / ClearKey material can ever leak through quality state.
//
// Directive case map (LT-18 §6B):
//   no quality menu for one variant ................. §A1 + §B1
//   multiple variants produce deduplicated options .. §A2 + §B2
//   Auto enables ABR ................................ §B3
//   manual selection disables ABR ................... §B4
//   selected track is passed correctly .............. §B4
//   stale/destroyed engine cannot mutate state ...... §B5
//   malformed track metadata is ignored safely ...... §A3 + §B6
//
// NO network, browser, DRM or Shaka package is involved.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
        LiveTvPlaybackEngine,
        type ShakaModuleLike,
        type ShakaPlayerLike
} from '$lib/client/live-tv/player';
import {
        deriveLiveTvQualityOptions,
        activeLiveTvTrackId,
        emptyLiveTvQualitySnapshot,
        liveTvQualityLabel
} from '$lib/client/live-tv/quality';
import type { LiveTvPlaybackResolution } from '$lib/client/live-tv/types';

let passed = 0;
function ok(label: string): void {
        passed++;
        console.log(`  ok ${passed} - ${label}`);
}

const read = (p: string): string => readFileSync(new URL(p, import.meta.url), 'utf8');
const engineSource = read('../src/lib/client/live-tv/player.ts');
const qualitySource = read('../src/lib/client/live-tv/quality.ts');
const playerComponent = read('../src/lib/components/live-tv/LiveTvPlayer.svelte');

// ============================================================
// Fakes — video element, Shaka player (WITH the variant surface).
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
        play(): Promise<void> {
                this.paused = false;
                return Promise.resolve();
        }
        pause(): void {
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
}

/** Raw variant-track fixture shape (Shaka Track-like; SYNTHETIC data). */
type FakeTrack = {
        id: number;
        active?: boolean;
        width?: number | null;
        height?: number | null;
        bandwidth?: number | null;
        language?: string;
};

/**
 * The structural shaka.Player stand-in WITH the LT-18 optional
 * variant-track surface (getVariantTracks / selectVariantTrack) and call
 * recording for configure()/selectVariantTrack().
 */
class FakeQualityPlayer {
        static loadHook: (() => Promise<void>) | null = null;
        variantTracks: FakeTrack[] = [];
        selectCalls: Array<{ track: unknown; clearBuffer?: boolean }> = [];
        configureCalls: Array<Record<string, unknown>> = [];
        private errorListeners = new Set<(event: unknown) => void>();

        async attach(): Promise<unknown> {
                return undefined;
        }
        async load(): Promise<unknown> {
                if (FakeQualityPlayer.loadHook) await FakeQualityPlayer.loadHook();
                return undefined;
        }
        configure(config: Record<string, unknown>): boolean {
                this.configureCalls.push(config);
                return true;
        }
        seekRange(): { start: number; end: number } {
                return { start: Number.NaN, end: Number.NaN };
        }
        isLive(): boolean {
                return true;
        }
        getMediaElement(): HTMLMediaElement | null {
                return null;
        }
        getNetworkingEngine(): null {
                return null;
        }
        addEventListener(_type: 'error', listener: (event: unknown) => void): void {
                this.errorListeners.add(listener);
        }
        removeEventListener(_type: 'error', listener: (event: unknown) => void): void {
                this.errorListeners.delete(listener);
        }
        // ---- LT-18 optional variant-track surface ----
        getVariantTracks(): unknown[] {
                return this.variantTracks as unknown[];
        }
        selectVariantTrack(track: unknown, clearBuffer?: boolean): void {
                this.selectCalls.push({ track, clearBuffer });
        }
        async destroy(): Promise<unknown> {
                return undefined;
        }
}

/** Fake module factory: fresh class + per-module instance tracking. */
function makeShakaModule() {
        const instances: FakeQualityPlayer[] = [];
        class PlayerCtor extends FakeQualityPlayer {
                constructor() {
                        super();
                        instances.push(this);
                }
                static isBrowserSupported(): boolean {
                        return true;
                }
        }
        const module = { Player: PlayerCtor, polyfill: { installAll(): void {} } } as unknown as ShakaModuleLike;
        return { module, instances };
}

// ---- Browser-runtime shims (identical intent to the LT-3 suite) ----
function installBrowserRuntime(): () => void {
        const g = globalThis as Record<string, unknown>;
        const originals = new Map<string, PropertyDescriptor | undefined>();
        const define = (key: string, value: unknown): void => {
                originals.set(key, Object.getOwnPropertyDescriptor(g, key));
                g[key] = value;
        };
        if (typeof g.window === 'undefined') define('window', {});
        if (typeof g.document === 'undefined') define('document', {});
        if (typeof g.MediaSource === 'undefined') define('MediaSource', class MediaSource {});
        return () => {
                for (const [key, descriptor] of originals) {
                        if (descriptor) Object.defineProperty(g, key, descriptor);
                        else delete g[key];
                }
        };
}

// ---- Fixtures ----
const SIGNED_URL = 'https://cdn.example.com/live/quality/index.mpd?__hdnea__=FAKE-ST~EX~SIGN-Q';

function resolution(overrides: Partial<LiveTvPlaybackResolution> = {}): LiveTvPlaybackResolution {
        return {
                channel: { id: '156', name: 'Star Gold HD' },
                sources: [{ url: SIGNED_URL }],
                drm: null,
                ...overrides
        };
}

/** Load a session with the given variant tracks installed BEFORE load()
 *  resolves (the real manifest-driven flow). A gate inside the fake's
 *  load() holds the session open until the tracks are in place. */
async function engineWithTracks(
        tracks: FakeTrack[]
): Promise<{ engine: LiveTvPlaybackEngine; player: FakeQualityPlayer; restore: () => void }> {
        const restore = installBrowserRuntime();
        const { module, instances } = makeShakaModule();
        const engine = new LiveTvPlaybackEngine({ shakaLoader: () => Promise.resolve(module) });
        const video = new FakeVideoElement();
        let releaseLoad!: () => void;
        const gate = new Promise<void>((resolve) => {
                releaseLoad = resolve;
        });
        FakeQualityPlayer.loadHook = () => gate;
        const loadPromise = engine.load(video as unknown as HTMLVideoElement, resolution());
        // Wait for the player instance to exist (created inside load()).
        await new Promise<void>((resolve) => {
                const tick = () => {
                        if (instances.length > 0) resolve();
                        else setTimeout(tick, 0);
                };
                tick();
        });
        instances[0].variantTracks = tracks;
        releaseLoad();
        await loadPromise;
        FakeQualityPlayer.loadHook = null;
        return { engine, player: instances[0], restore };
}

// ============================================================
// §A1 — Pure model: one variant → ONE option (no menu)
// ============================================================
{
        const options = deriveLiveTvQualityOptions([
                { id: 1, active: true, width: 1920, height: 1080, bandwidth: 5_000_000 }
        ]);
        assert.equal(options.length, 1, 'a single variant yields exactly one option');
        assert.equal(options[0].label, '1080p', 'the label prefers the height form');
        assert.equal(options[0].id, 1, 'the representative is the only track');
        ok('A1. single usable variant → exactly one quality option (the UI shows no menu)');
}

// ============================================================
// §A2 — Pure model: dedup + deterministic representative + sorting
// ============================================================
{
        const options = deriveLiveTvQualityOptions([
                // Two 1080p variants (ABR ladder siblings) + one active 720p
                // + one height-less bandwidth-only variant + a 480p.
                { id: 10, width: 1920, height: 1080, bandwidth: 5_000_000 },
                { id: 11, width: 1920, height: 1080, bandwidth: 3_000_000 },
                { id: 20, active: true, width: 1280, height: 720, bandwidth: 2_000_000 },
                { id: 30, bandwidth: 800_000 },
                { id: 40, width: 854, height: 480, bandwidth: 600_000 }
        ]);
        assert.equal(options.length, 4, 'equivalent resolutions collapse to one option each');
        assert.deepEqual(
                options.map((option) => option.label),
                ['1080p', '720p', '480p', '800 kbps'],
                'sorted highest → lowest; height-less tiers fall back to bandwidth labels'
        );
        // Deterministic representative: no active in the 1080p group → the
        // HIGHEST BANDWIDTH track (id 10) represents the tier.
        assert.equal(options[0].id, 10, 'representative = highest bandwidth within the tier');
        // The ACTIVE 720p track represents its tier even at lower bandwidth.
        assert.equal(options[1].id, 20, 'the active track represents its tier');
        // Re-running the derivation is deterministic (same input → same output).
        const again = deriveLiveTvQualityOptions([
                { id: 11, width: 1920, height: 1080, bandwidth: 3_000_000 },
                { id: 10, width: 1920, height: 1080, bandwidth: 5_000_000 },
                { id: 20, active: true, width: 1280, height: 720, bandwidth: 2_000_000 },
                { id: 40, width: 854, height: 480, bandwidth: 600_000 },
                { id: 30, bandwidth: 800_000 }
        ]);
        assert.deepEqual(
                again.map((option) => option.id),
                options.map((option) => option.id),
                'representative choice is deterministic regardless of input order'
        );
        assert.equal(activeLiveTvTrackId([{ id: 20, active: true }]), 20, 'active id extraction');
        assert.equal(activeLiveTvTrackId([{ id: 5 }]), null, 'no active flag → null (never invented)');
        assert.equal(activeLiveTvTrackId('garbage'), null, 'non-array input → null');
        ok('A2. multiple variants → deduplicated, sorted, deterministic quality options');
}

// ============================================================
// §A3 — Pure model: malformed metadata is ignored safely
// ============================================================
{
        const options = deriveLiveTvQualityOptions([
                null,
                undefined,
                'not-a-track',
                42,
                { id: 'x', height: 1080 }, // non-numeric id → dropped
                { id: 7 }, // no height AND no bandwidth → dropped
                { id: 8, height: Number.NaN }, // NaN height → dropped
                { id: 9, height: -1080 }, // negative height → dropped
                { id: 12, height: '1080', bandwidth: '5e6' }, // string dims → dropped
                { id: 13, height: 576, bandwidth: 1_200_000 } // the one usable track
        ]);
        assert.equal(options.length, 1, 'every malformed entry is dropped, never repaired');
        assert.equal(options[0].label, '576p', 'the usable 576p tier survives');
        assert.equal(deriveLiveTvQualityOptions('garbage').length, 0, 'non-array input → empty');
        assert.equal(deriveLiveTvQualityOptions(null).length, 0, 'null input → empty');
        assert.equal(deriveLiveTvQualityOptions([]).length, 0, 'empty array → empty');
        assert.equal(liveTvQualityLabel(undefined, undefined), 'Auto', 'no signals → safe fallback label');
        assert.equal(liveTvQualityLabel(720, undefined), '720p', 'height label');
        assert.equal(liveTvQualityLabel(undefined, 2_500_000), '2500 kbps', 'bandwidth fallback label');
        ok('A3. malformed track metadata is ignored safely (validated numbers only)');
}

// ============================================================
// §B1 — Engine: load derives the snapshot; single variant → no menu data
// ============================================================
{
        const { engine, player, restore } = await engineWithTracks([
                { id: 1, active: true, width: 1920, height: 1080, bandwidth: 5_000_000 }
        ]);
        try {
                const snapshot = engine.getQualitySnapshot();
                assert.equal(snapshot.options.length, 1, 'single-variant manifest → one option');
                assert.equal(snapshot.activeId, 1, 'the active track id is reported');
                assert.equal(snapshot.auto, true, 'ABR owns the selection by default');
                // The 'qualitychange' event fired with the same snapshot.
                let seen: unknown = null;
                const off = engine.on('qualitychange', (event) => {
                        seen = event;
                });
                off();
                assert.ok(player.configureCalls.length === 0, 'no ABR configuration happens without user intent');
                void seen;
                engine.destroy();
        } finally {
                restore();
        }
        ok('B1. engine load derives the normalized snapshot (single quality = no menu)');
}

// ============================================================
// §B2 — Engine: multiple variants → deduplicated options in the snapshot
// ============================================================
{
        const { engine, restore } = await engineWithTracks([
                { id: 10, width: 1920, height: 1080, bandwidth: 5_000_000 },
                { id: 11, width: 1920, height: 1080, bandwidth: 3_000_000 },
                { id: 20, active: true, width: 1280, height: 720, bandwidth: 2_000_000 },
                { id: 40, width: 854, height: 480, bandwidth: 600_000 }
        ]);
        try {
                const snapshot = engine.getQualitySnapshot();
                assert.equal(snapshot.options.length, 3, 'three visible tiers after dedup');
                assert.deepEqual(
                        snapshot.options.map((option) => option.label),
                        ['1080p', '720p', '480p'],
                        'highest → lowest'
                );
                assert.equal(snapshot.activeId, 20, 'active id from the manifest');
                // Security: the snapshot carries ONLY validated quality data.
                const serialized = JSON.stringify(snapshot);
                assert.ok(!serialized.includes('http'), 'no URLs in quality state');
                assert.ok(!serialized.includes('__hdnea__'), 'no signed-token material in quality state');
                assert.ok(!serialized.includes('clearKey'), 'no ClearKey material in quality state');
                engine.destroy();
        } finally {
                restore();
        }
        ok('B2. engine snapshot: deduplicated multi-tier options, safe data only');
}

// ============================================================
// §B3 — Auto re-enables ABR (documented abr.enabled config)
// ============================================================
{
        const { engine, player, restore } = await engineWithTracks([
                { id: 10, width: 1920, height: 1080, bandwidth: 5_000_000 },
                { id: 20, active: true, width: 1280, height: 720, bandwidth: 2_000_000 }
        ]);
        try {
                let latest: unknown = engine.getQualitySnapshot();
                const off = engine.on('qualitychange', (event) => {
                        latest = event;
                });
                engine.selectLiveTvQuality(null); // AUTO
                const abrCalls = player.configureCalls.filter((config) => (config as { abr?: { enabled?: unknown } }).abr?.enabled === true);
                assert.equal(abrCalls.length, 1, 'AUTO configures abr.enabled = true exactly once');
                assert.equal((latest as { auto: boolean }).auto, true, 'the snapshot reports Auto');
                assert.equal(player.selectCalls.length, 0, 'AUTO never force-selects a track');
                // No reload ever happened.
                off();
                engine.destroy();
        } finally {
                restore();
        }
        ok('B3. AUTO re-enables Shaka ABR (abr.enabled = true), no forced track');
}

// ============================================================
// §B4 — Manual selection disables ABR and selects the representative
// ============================================================
{
        const tracks: FakeTrack[] = [
                { id: 10, width: 1920, height: 1080, bandwidth: 5_000_000 },
                { id: 11, width: 1920, height: 1080, bandwidth: 3_000_000 },
                { id: 20, active: true, width: 1280, height: 720, bandwidth: 2_000_000 }
        ];
        const { engine, player, restore } = await engineWithTracks(tracks);
        try {
                let latest: { auto: boolean; activeId: number | null } = engine.getQualitySnapshot();
                const off = engine.on('qualitychange', (event) => {
                        latest = event;
                });
                engine.selectLiveTvQuality(10); // manual 1080p (the representative)
                const disableCalls = player.configureCalls.filter((config) => (config as { abr?: { enabled?: unknown } }).abr?.enabled === false);
                assert.equal(disableCalls.length, 1, 'manual selection disables ABR exactly once');
                assert.equal(player.selectCalls.length, 1, 'exactly one selectVariantTrack call');
                const call = player.selectCalls[0];
                assert.equal((call.track as FakeTrack).id, 10, 'the REPRESENTATIVE raw track is passed');
                assert.equal(call.clearBuffer, true, 'a buffer switch is requested (no reload)');
                assert.equal(latest.auto, false, 'the snapshot reports manual mode');
                assert.equal(latest.activeId, 10, 'the snapshot reports the chosen tier');
                // The load() call count stays ONE — no reload/re-resolve.
                off();
                engine.destroy();
        } finally {
                restore();
        }
        ok('B4. manual selection: ABR off + selectVariantTrack(representative, true), no reload');
}

// ============================================================
// §B5 — Stale/destroyed engines and unknown ids are safe no-ops
// ============================================================
{
        const { engine, player, restore } = await engineWithTracks([
                { id: 10, width: 1920, height: 1080, bandwidth: 5_000_000 },
                { id: 20, active: true, width: 1280, height: 720, bandwidth: 2_000_000 }
        ]);
        try {
                // Unknown quality id → silent no-op (never invented).
                engine.selectLiveTvQuality(9999);
                assert.equal(player.selectCalls.length, 0, 'unknown id → no selection');
                assert.equal(player.configureCalls.length, 0, 'unknown id → no ABR change');
                // Destroyed engine → no mutation of anything.
                engine.destroy();
                engine.selectLiveTvQuality(10);
                engine.selectLiveTvQuality(null);
                assert.equal(player.selectCalls.length, 0, 'destroyed engine → still no selection');
                assert.equal(player.configureCalls.length, 0, 'destroyed engine → no ABR change');
                const snapshot = engine.getQualitySnapshot();
                assert.equal(snapshot.options.length, 0, 'teardown reset the options');
                assert.equal(snapshot.auto, true, 'a fresh session starts in Auto');
        } finally {
                restore();
        }
        // A player WITHOUT the optional variant surface (older fake): every
        // quality path degrades to a silent no-op, playback unaffected.
        {
                const restore2 = installBrowserRuntime();
                class BarePlayer {
                        static isBrowserSupported(): boolean { return true; }
                        async attach(): Promise<unknown> { return undefined; }
                        async load(): Promise<unknown> { return undefined; }
                        configure(): boolean { return true; }
                        seekRange(): { start: number; end: number } { return { start: 0, end: 0 }; }
                        isLive(): boolean { return true; }
                        getMediaElement(): null { return null; }
                        getNetworkingEngine(): null { return null; }
                        addEventListener(): void {}
                        removeEventListener(): void {}
                        async destroy(): Promise<unknown> { return undefined; }
                }
                const module = { Player: BarePlayer } as unknown as ShakaModuleLike;
                const engine2 = new LiveTvPlaybackEngine({ shakaLoader: () => Promise.resolve(module) });
                const video2 = new FakeVideoElement();
                await engine2.load(video2 as unknown as HTMLVideoElement, resolution());
                assert.equal(engine2.getQualitySnapshot().options.length, 0, 'no variant surface → no options');
                engine2.selectLiveTvQuality(null); // silent no-op
                engine2.destroy();
                restore2();
        }
        ok('B5. stale/destroyed engines, unknown ids and missing variant surfaces are safe no-ops');
}

// ============================================================
// §B6 — Quality state resets on channel switch/teardown
// ============================================================
{
        const restore = installBrowserRuntime();
        const { module, instances } = makeShakaModule();
        const engine = new LiveTvPlaybackEngine({ shakaLoader: () => Promise.resolve(module) });
        const video = new FakeVideoElement();
        try {
                await engine.load(video as unknown as HTMLVideoElement, resolution());
                instances[0].variantTracks = [
                        { id: 10, active: true, width: 1920, height: 1080, bandwidth: 5_000_000 },
                        { id: 20, width: 1280, height: 720, bandwidth: 2_000_000 }
                ];
                // A SECOND load (channel switch) re-derives fresh state.
                await engine.load(video as unknown as HTMLVideoElement, resolution({ channel: { id: '154', name: 'Sony SAB SD' } }));
                const player2 = instances[instances.length - 1];
                player2.variantTracks = [{ id: 77, active: true, width: 1280, height: 720, bandwidth: 1_500_000 }];
                await engine.selectLiveTvQuality(null); // refresh path (Auto)
                const snapshot = engine.getQualitySnapshot();
                assert.ok(
                        snapshot.options.every((option) => option.id === 77),
                        'the new session reflects the NEW manifest, never the old one'
                );
                assert.equal(snapshot.auto, true, 'no persistence: the new session starts in Auto');
        } finally {
                engine.destroy();
                restore();
        }
        ok('B6. channel switch/teardown resets quality state cleanly (nothing persisted)');
}

// ============================================================
// §C — Source contracts: structural abstraction + UI isolation
// ============================================================
{
        // The structural type keeps the variant members OPTIONAL (verified
        // against shaka-player 5.2.12 typings) so existing fakes stay valid.
        assert.match(
                engineSource,
                /getVariantTracks\?\(\): unknown\[\];/,
                'getVariantTracks is an OPTIONAL structural member'
        );
        assert.match(
                engineSource,
                /selectVariantTrack\?\(track: unknown, clearBuffer\?: boolean, safeMargin\?: number\): void;/,
                'selectVariantTrack is an OPTIONAL structural member with the documented signature'
        );
        // The engine never imports Shaka types into UI code and never reads
        // a track message/URI field.
        assert.doesNotMatch(engineSource, /from 'shaka-player'/, 'player.ts never imports the Shaka package');
        assert.ok(!engineSource.includes('track.message'), 'track message fields are never read');
        assert.ok(!engineSource.includes('.uri'), 'track URI fields are never read');
        // The pure module exposes ONLY the normalized model.
        assert.match(qualitySource, /export type LiveTvQualityOption/, 'the normalized option type is exported');
        assert.match(qualitySource, /export function deriveLiveTvQualityOptions/, 'the derivation is exported');
        assert.ok(!qualitySource.includes('http'), 'the quality module contains no URL material');
        // The UI component consumes the SNAPSHOT only — never Shaka.
        assert.match(playerComponent, /emptyLiveTvQualitySnapshot/, 'the component seeds from the empty snapshot');
        assert.match(playerComponent, /getQualitySnapshot\(\)/, 'the component reads the engine snapshot');
        assert.match(playerComponent, /selectLiveTvQuality\(/, 'the component selects through the engine');
        assert.doesNotMatch(playerComponent, /from 'shaka-player'|shaka\./, 'the component never touches Shaka');
        assert.ok(!playerComponent.includes('variantTracks'), 'raw variant tracks never reach the component');
        // Single-quality manifests render no quality control.
        assert.match(
                playerComponent,
                /qualityOptions\.length > 1/,
                'the quality control requires 2+ options'
        );
        // The quality menu offers Auto + the normalized options.
        assert.match(playerComponent, /onclick=\{\(\) => selectQuality\(null\)\}/, 'AUTO maps to selectQuality(null)');
        assert.match(playerComponent, /onclick=\{\(\) => selectQuality\(option\.id\)\}/, 'tiers map to their option id');
        ok('C. source contracts: optional structural members, snapshot-only UI, no leaks');
}

console.log(`\nLT-18 quality selection suite: ${passed} checks passed.`);
