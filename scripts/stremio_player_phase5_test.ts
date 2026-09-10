import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { PlayerSource } from '$lib/shared/player';
import { isPlayablePlayerSource } from '$lib/shared/player-guards';
import { DirectPlayerAdapter } from '$lib/client/player/direct-adapter';
import { EmbedPlayerAdapter } from '$lib/client/player/embed-adapter';
import { createDefaultAdapterRegistry } from '$lib/client/player/adapter-registry';
import {
  HlsPlaybackEngine,
  HLS_ENGINE_EVENTS,
  HLS_RECOVERY_LIMITS,
  HLS_UNRECOVERABLE_MESSAGE,
  HLS_UNSUPPORTED_MESSAGE,
  looksLikeHlsUrl,
  isHlsMediaSource,
  supportsNativeHls,
  resolveDirectPlaybackMode,
  type HlsFactory,
  type HlsLike,
  type HlsEventData,
} from '$lib/client/player/hls-engine';

// Phase 5: Native HLS / direct playback engine tests.
//
// Scope: the hls.js integration behind the EXISTING direct `<video>` path:
//   A/B  dependency present + a STABLE (non-alpha/beta/canary) version
//   C/D  client-only boundary — no static import, no SSR execution
//   E–I  protocol routing (metadata protocol wins, .m3u8 fallback, native first)
//   J–P  engine lifecycle (create once / destroy / source-switch matrix)
//   Q    race protection (stale attach cannot take over)
//   R–U  bounded fatal-error recovery (network / media / unrecoverable)
//   V    autoplay rejection stays non-fatal
//   W–Z  metadata/duration/progress/seek propagation through the EXISTING
//        event flow (hls.js feeds the same <video> element)
//  AA–AD Media Session / PiP / fullscreen / Wake Lock untouched
//  AE–AH no proxy, no custom headers, no DRM bypass, no torrent path
//  AI–AK existing direct/embed adapters + provider resolver unchanged
//   AL   HLS URLs stay HTTPS-only under the existing playback validation
//  AM–AO cleanup: destroy on unmount, no duplicate listeners, no surviving
//        hls.js instance
// No test touches the real network or a real browser: hls.js is injected
// through a fake factory, the video element is a minimal fake.

let passed = 0;
function ok(condition: unknown, label: string) {
  assert.ok(condition, label);
  passed += 1;
}

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative: string) => readFileSync(path.join(REPO_ROOT, relative), 'utf8');

// ---------------------------------------------------------------------------
// Fakes — no real browser, no real hls.js, no network
// ---------------------------------------------------------------------------

class FakeHls implements HlsLike {
  static instances: FakeHls[] = [];
  readonly listeners = new Map<string, Array<(event: string, data?: HlsEventData) => void>>();
  readonly loadSourceCalls: string[] = [];
  readonly attachedMedia: unknown[] = [];
  startLoadCalls = 0;
  recoverMediaErrorCalls = 0;
  destroyCalls = 0;
  constructor(public readonly config?: Record<string, unknown>) {
    FakeHls.instances.push(this);
  }
  on(event: string, listener: (event: string, data?: HlsEventData) => void): void {
    const list = this.listeners.get(event) ?? [];
    list.push(listener);
    this.listeners.set(event, list);
  }
  off(_event: string, _listener: (event: string, data?: HlsEventData) => void): void {}
  loadSource(url: string): void {
    this.loadSourceCalls.push(url);
  }
  attachMedia(media: unknown): void {
    this.attachedMedia.push(media);
  }
  startLoad(): void {
    this.startLoadCalls += 1;
  }
  stopLoad(): void {}
  recoverMediaError(): void {
    this.recoverMediaErrorCalls += 1;
  }
  destroy(): void {
    this.destroyCalls += 1;
  }
  emit(event: string, data?: HlsEventData): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) listener(event, data);
  }
}

function makeFactory(sink: FakeHls[] = []): HlsFactory {
  return (config?: Record<string, unknown>) => {
    const instance = new FakeHls(config);
    sink.push(instance);
    return instance;
  };
}

function loaderOf(factory: HlsFactory | null): () => Promise<HlsFactory | null> {
  return async () => factory;
}

function deferredLoader(): { loader: () => Promise<HlsFactory | null>; resolve: (factory: HlsFactory | null) => void } {
  let resolve!: (factory: HlsFactory | null) => void;
  const promise = new Promise<HlsFactory | null>((res) => { resolve = res; });
  return { loader: () => promise, resolve };
}

function makeVideo(canPlayHls = ''): HTMLVideoElement {
  return {
    canPlayType: (type: string) => (type.toLowerCase().includes('mpegurl') ? canPlayHls : ''),
    removeAttribute() {},
    load() {},
    currentTime: 0,
  } as unknown as HTMLVideoElement;
}

function makeSource(overrides: Partial<PlayerSource> = {}): PlayerSource {
  return {
    type: 'direct',
    url: 'https://cdn.example/video.m3u8',
    providerId: '00000000-0000-4000-8000-000000000001',
    sourceId: 'stremio:addon-a:0',
    mediaType: 'movie',
    ...overrides,
  };
}

type EngineEvents = { states: string[]; fatalErrors: string[] };
function makeCallbacks(): { callbacks: Parameters<HlsPlaybackEngine['attach']>[2]; events: EngineEvents } {
  const events: EngineEvents = { states: [], fatalErrors: [] };
  return {
    callbacks: {
      onState: (state) => events.states.push(state),
      onFatalError: (message) => events.fatalErrors.push(message),
    },
    events,
  };
}

// ===========================================================================
// A/B — dependency present + stable version
// ===========================================================================

const packageJson = JSON.parse(read('package.json')) as { dependencies: Record<string, string>; scripts: Record<string, string> };

ok(typeof packageJson.dependencies['hls.js'] === 'string', 'A: hls.js is a runtime dependency (client-safe, not dev-only)');

const declaredVersion = packageJson.dependencies['hls.js'];
ok(/\d+\.\d+\.\d+/.test(declaredVersion), 'B: declared hls.js version is a concrete semver release');
ok(!/-(alpha|beta|canary|rc|next|experimental)/i.test(declaredVersion), 'B: declared hls.js version is NOT an alpha/beta/canary/experimental build');

const hlsPackageJson = JSON.parse(read('node_modules/hls.js/package.json')) as { version: string };
ok(hlsPackageJson.version === declaredVersion.replace(/^[\^~]/, ''), `B: installed hls.js ${hlsPackageJson.version} matches the declared version`);
ok(!/-(alpha|beta|canary|rc)/i.test(hlsPackageJson.version), 'B: installed hls.js is a stable release (no prerelease tag)');
ok(Number(hlsPackageJson.version.split('.')[0]) >= 1, 'B: installed hls.js is on the stable 1.x line');

// The lockfile must contain the same resolved version (internal consistency).
ok(read('pnpm-lock.yaml').includes(`hls.js@${hlsPackageJson.version}`) || read('pnpm-lock.yaml').includes(`'hls.js@${hlsPackageJson.version}'`), 'B: pnpm-lock.yaml resolves the same hls.js version');

// ===========================================================================
// C/D — client-only boundary + SSR safety
// ===========================================================================

const engineSource = read('src/lib/client/player/hls-engine.ts');
const viewportSource = read('src/lib/components/player/PlayerViewport.svelte');
const shellSource = read('src/lib/components/player/PlayerShell.svelte');
const playbackManagerSource = read('src/lib/client/player/PlaybackManager.ts');
const directAdapterSource = read('src/lib/client/player/direct-adapter.ts');

const staticImportPattern = /from\s+['"]hls\.js['"]/;
ok(!staticImportPattern.test(engineSource), 'C: hls-engine.ts has NO static hls.js import (dynamic import only)');
ok(!staticImportPattern.test(viewportSource), 'C: PlayerViewport never imports hls.js directly (only via the engine module)');
ok(!staticImportPattern.test(playbackManagerSource), 'C: PlaybackManager knows nothing about hls.js');
ok(!staticImportPattern.test(shellSource), 'C: PlayerShell knows nothing about hls.js');
ok(!staticImportPattern.test(directAdapterSource), 'C: DirectPlayerAdapter knows nothing about hls.js');

const dynamicImportOccurrences = [...engineSource.matchAll(/import\(\s*['"]hls\.js['"]\s*\)/g)].length;
ok(dynamicImportOccurrences === 1, 'C: exactly ONE dynamic import("hls.js") exists (in the engine loader)');

let serverFilesWithHls = 0;
for (const relative of ['src/lib/server/resolver/service.ts', 'src/lib/server/resolver/core.ts', 'src/lib/server/streaming/stremio/stream-resolver.ts', 'src/routes/api/playback/resolve/+server.ts', 'src/routes/api/playback/stremio/+server.ts']) {
  if (/['"]hls\.js['"]/.test(read(relative))) serverFilesWithHls += 1;
}
ok(serverFilesWithHls === 0, 'C: no server module (resolver / routes / stremio) references hls.js');

// D: importing + constructing the engine in plain Node (this test process)
// must be side-effect free — the very import at the top of this file proves
// no SSR-time browser globals are touched. Construction must not load hls.js.
const inertEngine = new HlsPlaybackEngine();
ok(inertEngine.isActive() === false, 'D: constructing the engine performs no work (no hls.js instantiation during import/SSR)');
ok(inertEngine.getInstance() === null, 'D: no hls.js instance exists before attach');
ok(engineSource.includes('let cachedFactoryPromise: Promise<HlsFactory | null> | null = null;'), 'D: the module loader memoizes its factory promise lazily (dynamic import only fires from a browser code path)');
// The hls.js construction must live INSIDE the async loader function (never
// evaluated at module import time — the SSR boundary).
const loaderBody = engineSource.slice(engineSource.indexOf('export async function defaultHlsModuleLoader'), engineSource.indexOf('let cachedFactoryPromise'));
ok(loaderBody.includes("import('hls.js')") && loaderBody.includes('new Hls(config)'), 'D: hls.js construction lives only inside the async module loader (never at module scope)');
ok(engineSource.includes('export function resetHlsFactoryCache()'), 'D: the loader cache is resettable (deterministic tests)');

// ===========================================================================
// E–G — protocol routing
// ===========================================================================

ok(isHlsMediaSource(makeSource({ metadata: { protocol: 'hls' } }), 'https://cdn.example/oddly-named-file'), 'E: metadata.protocol === "hls" routes to HLS even when the filename is ambiguous');
ok(isHlsMediaSource(makeSource({ url: 'https://cdn.example/video.mp4?x=.m3u8', metadata: { protocol: 'mp4' } }), 'https://cdn.example/video.mp4?x=.m3u8') === false, 'E: an EXPLICIT mp4 protocol wins over a misleading filename (no filename-only classification)');
ok(isHlsMediaSource(makeSource({ url: 'https://cdn.example/video.M3U8', metadata: { protocol: 'unknown' } }), 'https://cdn.example/video.M3U8'), 'F: .m3u8 fallback detection is case-insensitive (unknown protocol only)');
ok(looksLikeHlsUrl('https://cdn.example/stream.m3u8?token=abc'), 'F: .m3u8 detection ignores query strings');
ok(looksLikeHlsUrl('HTTPS://CDN.EXAMPLE/STREAM.M3U8'), 'F: .m3u8 detection ignores URL case');
ok(!looksLikeHlsUrl('https://cdn.example/video.mp4'), 'F: ordinary MP4 URLs are never classified as HLS');
ok(!looksLikeHlsUrl('https://cdn.example/video.webm'), 'F: WebM URLs are never classified as HLS');
ok(!looksLikeHlsUrl('not a url'), 'F: unparseable URLs are never classified as HLS');
ok(isHlsMediaSource(makeSource({ url: 'https://cdn.example/video.m3u8' }), 'https://cdn.example/video.m3u8'), 'F: a source with NO protocol metadata falls back to .m3u8 URL detection');
ok(!isHlsMediaSource(makeSource({ url: 'https://cdn.example/video.mp4', metadata: { protocol: 'mp4' } }), 'https://cdn.example/video.mp4'), 'G: explicit mp4 protocol routes to the EXISTING direct path');
ok(!isHlsMediaSource(makeSource({ url: 'https://cdn.example/video.mp4', metadata: { protocol: 'file' } }), 'https://cdn.example/video.mp4'), 'G: file protocol routes to the EXISTING direct path');
ok(!isHlsMediaSource(makeSource({ url: 'https://cdn.example/manifest.mpd', metadata: { protocol: 'dash' } }), 'https://cdn.example/manifest.mpd'), 'G: dash is NOT routed through the HLS engine (existing behavior preserved)');
ok(!isHlsMediaSource(makeSource({ url: 'https://cdn.example/video.mp4' }), 'https://cdn.example/video.mp4'), 'G: MP4 without metadata routes to the EXISTING direct path');

// ===========================================================================
// H/I — native HLS first, hls.js only as fallback
// ===========================================================================

ok(supportsNativeHls(makeVideo('probably')), 'H: canPlayType("application/vnd.apple.mpegurl") detects native HLS');
ok(supportsNativeHls(makeVideo('maybe')), 'H: canPlayType("application/x-mpegURL") detects native HLS');
ok(!supportsNativeHls(makeVideo('')), 'H: an empty canPlayType means NO native HLS');
ok(resolveDirectPlaybackMode(makeSource(), 'https://cdn.example/video.m3u8', makeVideo('probably')) === 'native', 'H: native-HLS browsers keep the EXISTING <video src> lifecycle (hls.js never loads)');
ok(resolveDirectPlaybackMode(makeSource(), 'https://cdn.example/video.m3u8', makeVideo('')) === 'hls-js', 'I: browsers without native HLS fall back to the hls.js engine');
ok(resolveDirectPlaybackMode(makeSource({ url: 'https://cdn.example/video.mp4', metadata: { protocol: 'mp4' } }), 'https://cdn.example/video.mp4', makeVideo('')) === 'native', 'I: MP4 stays on the native path even without native HLS support');

// ===========================================================================
// J/K — engine lifecycle: create once, destroy
// ===========================================================================

{
  const instances: FakeHls[] = [];
  const engine = new HlsPlaybackEngine({ hlsLoader: loaderOf(makeFactory(instances)) });
  const video = makeVideo('');
  const { callbacks, events } = makeCallbacks();
  await engine.attach(video, 'https://cdn.example/a.m3u8', callbacks);
  ok(instances.length === 1, 'J: exactly ONE hls.js instance is created per attach');
  ok(instances[0].attachedMedia.length === 1 && instances[0].attachedMedia[0] === video, 'J: the instance is attached to the SAME <video> element');
  ok(instances[0].loadSourceCalls[0] === 'https://cdn.example/a.m3u8', 'J: loadSource receives the source URL verbatim (no rewriting/proxying)');
  ok(instances[0].config === undefined, "J: hls.js runs with DEFAULT configuration (no overrides — spec §5)");
  ok(engine.isActive(), 'J: the engine reports active while attached');
  ok(events.states.includes('loading'), 'J: the generic loading state is exposed (no hls.js event names leak)');
  engine.destroy();
  ok(instances[0].destroyCalls === 1, 'K: destroy() destroys the hls.js instance exactly once');
  ok(!engine.isActive() && engine.getInstance() === null, 'K: after destroy the engine is inert and holds no instance');
}

// ===========================================================================
// L/M/N/O/P — source-switch matrix (old instance destroyed first)
// ===========================================================================

{
  // L: source switch destroys the previous instance.
  const instances: FakeHls[] = [];
  const engine = new HlsPlaybackEngine({ hlsLoader: loaderOf(makeFactory(instances)) });
  const video = makeVideo('');
  await engine.attach(video, 'https://cdn.example/a.m3u8');
  await engine.attach(video, 'https://cdn.example/b.m3u8');
  ok(instances.length === 2, 'L: a source switch creates a fresh hls.js instance');
  ok(instances[0].destroyCalls === 1, 'L: the previous hls.js instance was destroyed BEFORE the new attach took over');
  ok(instances[1].destroyCalls === 0 && engine.getInstance() === instances[1], 'L: only the newest instance stays attached (no double attach)');
  ok(instances[1].loadSourceCalls[0] === 'https://cdn.example/b.m3u8', 'L: the new instance loads the new source');
  engine.destroy();
}

{
  // M/N/O/P — the four switch transitions expressed through the SAME
  // routing + engine contract PlayerViewport uses.
  const hlsA = makeSource({ url: 'https://cdn.example/a.m3u8', metadata: { protocol: 'hls' } });
  const hlsB = makeSource({ url: 'https://cdn.example/b.m3u8', metadata: { protocol: 'hls' } });
  const mp4A = makeSource({ url: 'https://cdn.example/a.mp4', metadata: { protocol: 'mp4' } });
  const mp4B = makeSource({ url: 'https://cdn.example/b.mp4', metadata: { protocol: 'mp4' } });
  const video = makeVideo('');

  // M: HLS → HLS — engine re-attach, old instance destroyed, position
  // restore rides the existing pendingSeek → loadedmetadata flow.
  {
    const instances: FakeHls[] = [];
    const engine = new HlsPlaybackEngine({ hlsLoader: loaderOf(makeFactory(instances)) });
    ok(resolveDirectPlaybackMode(hlsA, hlsA.url!, video) === 'hls-js', 'M: source A routes to the engine');
    await engine.attach(video, hlsA.url!);
    ok(resolveDirectPlaybackMode(hlsB, hlsB.url!, video) === 'hls-js', 'M: source B routes to the engine too');
    await engine.attach(video, hlsB.url!);
    ok(instances[0].destroyCalls === 1 && engine.getInstance() === instances[1], 'M: HLS→HLS switch destroys the old instance and keeps exactly one');
    engine.destroy();
  }
  // N: HLS → MP4 — the engine is torn down; playback returns to the
  // native <video src> path (hlsEngineActive releases the src binding).
  {
    const instances: FakeHls[] = [];
    const engine = new HlsPlaybackEngine({ hlsLoader: loaderOf(makeFactory(instances)) });
    await engine.attach(video, hlsA.url!);
    ok(resolveDirectPlaybackMode(mp4A, mp4A.url!, video) === 'native', 'N: an MP4 target routes back to the native path');
    engine.destroy();
    ok(instances[0].destroyCalls === 1, 'N: HLS→MP4 switch destroys the engine instance (no hls.js left behind)');
  }
  // O: MP4 → HLS — a fresh engine attach for the HLS target.
  {
    const instances: FakeHls[] = [];
    const engine = new HlsPlaybackEngine({ hlsLoader: loaderOf(makeFactory(instances)) });
    ok(resolveDirectPlaybackMode(mp4A, mp4A.url!, video) === 'native', 'O: MP4 starts on the native path (no engine)');
    await engine.attach(video, hlsA.url!);
    ok(instances.length === 1 && instances[0].loadSourceCalls[0] === hlsA.url, 'O: MP4→HLS switch lazily creates exactly one engine instance');
    engine.destroy();
  }
  // P: MP4 → MP4 — pure native path; the engine (and hls.js) is never touched.
  {
    const instances: FakeHls[] = [];
    const engine = new HlsPlaybackEngine({ hlsLoader: loaderOf(makeFactory(instances)) });
    ok(resolveDirectPlaybackMode(mp4A, mp4A.url!, video) === 'native' && resolveDirectPlaybackMode(mp4B, mp4B.url!, video) === 'native', 'P: MP4→MP4 stays native end to end');
    ok(instances.length === 0 && !engine.isActive(), 'P: MP4→MP4 never creates an hls.js instance (no unnecessary loading)');
  }
}

// ===========================================================================
// Q — race protection: a stale attach can never take over
// ===========================================================================

{
  const video = makeVideo('');
  const events: string[] = [];
  // Stale attach aborted by destroy() while the module load is pending.
  {
    FakeHls.instances.length = 0;
    const deferred = deferredLoader();
    const engine = new HlsPlaybackEngine({ hlsLoader: deferred.loader });
    const attaching = engine.attach(video, 'https://cdn.example/slow.m3u8', {
      onFatalError: (m) => events.push(`fatal:${m}`),
      onState: (s) => events.push(`state:${s}`),
    });
    const eventsAtDestroy = events.length; // the sync 'loading' state fired at attach start
    engine.destroy(); // the user switched away before hls.js finished loading
    deferred.resolve(makeFactory());
    await attaching;
    ok(FakeHls.instances.length === 0, 'Q: a destroyed attach NEVER constructs an hls.js instance');
    ok(events.length === eventsAtDestroy, 'Q: a destroyed attach emits no further state/error callbacks');
    ok(!engine.isActive(), 'Q: the destroyed engine stays inert');
  }
  // Stale attach superseded by a newer attach on the SAME engine.
  {
    FakeHls.instances.length = 0;
    const deferred = deferredLoader();
    const engine = new HlsPlaybackEngine({ hlsLoader: deferred.loader });
    const first = engine.attach(video, 'https://cdn.example/a.m3u8');
    deferred.resolve(makeFactory());
    await first;
    const staleInstance = engine.getInstance()!;
    const instancesBeforeSecond = FakeHls.instances.length;
    const second = engine.attach(video, 'https://cdn.example/b.m3u8');
    // While the second attach is pending, the stale instance must already be gone.
    ok(engine.getInstance() === null, 'Q: a newer attach immediately detaches the previous instance');
    // A late event from the stale instance must be dropped.
    staleInstance.emit(HLS_ENGINE_EVENTS.error, { fatal: true, type: 'networkError' });
    await second;
    ok(engine.getInstance() !== staleInstance, 'Q: the second attach owns the engine afterwards');
    ok(staleInstance.destroyCalls === 1, 'Q: the superseded instance was destroyed by the newer attach');
    ok(FakeHls.instances.length === instancesBeforeSecond + 1, 'Q: only ONE live instance exists after the race resolves');
    engine.destroy();
  }
  // Stale events from a destroyed engine are dropped.
  {
    FakeHls.instances.length = 0;
    const engine = new HlsPlaybackEngine({ hlsLoader: loaderOf(makeFactory()) });
    await engine.attach(video, 'https://cdn.example/a.m3u8');
    const instance = engine.getInstance()!;
    engine.destroy();
    instance.emit(HLS_ENGINE_EVENTS.error, { fatal: true, type: 'mediaError' });
    instance.emit(HLS_ENGINE_EVENTS.manifestLoaded);
    ok(instance.recoverMediaErrorCalls === 0, 'Q: hls.js events after destroy() trigger no recovery (stale events dropped)');
  }
}

// ===========================================================================
// R/S/T/U — bounded fatal-error recovery
// ===========================================================================

{
  const instances: FakeHls[] = [];
  const engine = new HlsPlaybackEngine({ hlsLoader: loaderOf(makeFactory(instances)) });
  const { callbacks, events } = makeCallbacks();
  await engine.attach(makeVideo(''), 'https://cdn.example/a.m3u8', callbacks);
  const instance = engine.getInstance()!;

  // R: fatal network error → bounded startLoad recovery.
  instance.emit(HLS_ENGINE_EVENTS.error, { fatal: true, type: 'networkError', details: 'manifestLoadError' });
  ok(instance.startLoadCalls === 1, 'R: fatal NETWORK error triggers hls.startLoad() recovery');
  ok(events.fatalErrors.length === 0, 'R: a recoverable network error does NOT surface a player error');

  // S: fatal media error → recoverMediaError.
  instance.emit(HLS_ENGINE_EVENTS.error, { fatal: true, type: 'mediaError', details: 'bufferStalledError' });
  ok(instance.recoverMediaErrorCalls === 1, 'S: fatal MEDIA error triggers hls.recoverMediaError()');
  ok(events.fatalErrors.length === 0, 'S: a recoverable media error does NOT surface a player error');

  // T: recovery attempts are BOUNDED — then the error surfaces.
  instance.emit(HLS_ENGINE_EVENTS.error, { fatal: true, type: 'networkError' });
  instance.emit(HLS_ENGINE_EVENTS.error, { fatal: true, type: 'networkError' });
  ok(instance.startLoadCalls === HLS_RECOVERY_LIMITS.network, 'T: network recovery stops at the bounded limit');
  instance.emit(HLS_ENGINE_EVENTS.error, { fatal: true, type: 'networkError' });
  ok(instance.startLoadCalls === HLS_RECOVERY_LIMITS.network, 'T: no recovery attempts beyond the limit (no infinite retry loop)');
  ok(events.fatalErrors.length === 1 && events.fatalErrors[0] === HLS_UNRECOVERABLE_MESSAGE, 'T: after the recovery budget is exhausted a generic player error surfaces');
  ok(instance.destroyCalls === 1, 'T: the exhausted instance is destroyed (no zombie instance)');
  ok(!engine.isActive(), 'T: the engine goes inactive after unrecoverable failure');
  engine.destroy();
}

{
  // U: other fatal types fail immediately; non-fatal errors are ignored.
  const instances: FakeHls[] = [];
  const engine = new HlsPlaybackEngine({ hlsLoader: loaderOf(makeFactory(instances)) });
  const { callbacks, events } = makeCallbacks();
  await engine.attach(makeVideo(''), 'https://cdn.example/a.m3u8', callbacks);
  const instance = engine.getInstance()!;
  instance.emit(HLS_ENGINE_EVENTS.error, { fatal: true, type: 'otherError', details: 'manifestIncompatibleCodecsError' });
  ok(events.fatalErrors.length === 1, 'U: an unrecoverable fatal error surfaces immediately');
  ok(instance.destroyCalls === 1, 'U: the instance is destroyed when recovery is not applicable');
  engine.destroy();
}
{
  const instances: FakeHls[] = [];
  const engine = new HlsPlaybackEngine({ hlsLoader: loaderOf(makeFactory(instances)) });
  const { callbacks, events } = makeCallbacks();
  await engine.attach(makeVideo(''), 'https://cdn.example/a.m3u8', callbacks);
  const instance = engine.getInstance()!;
  instance.emit(HLS_ENGINE_EVENTS.error, { fatal: false, type: 'networkError', details: 'fragLoadError' });
  instance.emit(HLS_ENGINE_EVENTS.error, { fatal: false, type: 'mediaError', details: 'fragParsingError' });
  ok(instance.startLoadCalls === 0 && instance.recoverMediaErrorCalls === 0, 'U: non-fatal errors are left to hls.js internal handling');
  ok(events.fatalErrors.length === 0 && engine.isActive(), 'U: non-fatal errors never surface as player errors');
  engine.destroy();
}

// ===========================================================================
// V — autoplay rejection is non-fatal
// ===========================================================================

ok(shellSource.includes('async function togglePlay()') && shellSource.includes("errorMessage = 'Playback is ready. Tap Play to start it.'"), 'V: PlayerShell catches play() rejection and stays in a usable paused state (never a fatal source failure)');
ok(shellSource.includes("state = 'paused'") && !shellSource.includes('videoElement.play().then'), 'V: no autoplay loop — play() is only user-initiated / Media-Session-initiated');
ok(!/autoplay\s*[:=]\s*true/.test(viewportSource), 'V: the viewport never forces autoplay attribute');
{
  // The adapter command path also reports failure without throwing.
  const adapter = new DirectPlayerAdapter();
  const result = await adapter.play();
  ok(result.ok === false && result.reason === 'not-ready', 'V: play() on an unbound adapter returns a CommandResult (non-fatal contract)');
}

// ===========================================================================
// W/X/Y/Z — metadata/duration/progress/seek propagation through the
// EXISTING <video> event flow (hls.js feeds the same element)
// ===========================================================================

ok(viewportSource.includes("loadedmetadata: void") && viewportSource.includes("timeupdate: { currentTime: number; duration: number }"), 'W: PlayerViewport still dispatches the generic loadedmetadata/timeupdate events with duration');
ok(shellSource.includes('function handleLoadedMetadata()') && shellSource.includes('duration = Number.isFinite(videoElement.duration) ? videoElement.duration : duration;'), 'W: PlayerShell derives duration from the <video> element with a finite guard (hls.js VOD + live safe)');
ok(viewportSource.includes("on:timeupdate={() => dispatch('timeupdate', { currentTime: videoElement?.currentTime ?? 0, duration: videoElement?.duration || 0 })}"), 'X: currentTime/progress still propagate from the SAME <video> element (no second progress mechanism)');
ok(shellSource.includes('function handleTimeUpdate(') && shellSource.includes("emitProgress('progress')"), 'X: the existing 5s-gated progress reporting is intact');
ok(shellSource.includes('capturePendingSeek(pendingSeekState, currentTime, Date.now());') && shellSource.includes('videoElement.currentTime = applied;'), 'Y: the Phase 9 pending-seek controller captures position on switch and applies it once the media has a usable range (streaming restore included)');
ok(shellSource.includes('function emitProgress(') && shellSource.includes('completed: state === \'completed\' || (duration > 0 && currentTime / duration >= 0.9)'), 'Z: completion percentage is only computed for FINITE durations (live/unknown duration cannot create invalid progress)');
ok(shellSource.includes('if (!Number.isFinite(duration) || duration <= 0) return;'), 'Z: Media Session position state skips duration-less (live) streams');

// ===========================================================================
// AA–AD — Media Session / PiP / fullscreen / Wake Lock untouched
// ===========================================================================

ok(shellSource.includes('function setupMediaSession()') && shellSource.includes('setupMediaSession();') && shellSource.includes('function registerMediaSessionHandlers()'), 'AA: Media Session setup + action handlers are intact and still invoked from loadedmetadata');
ok(shellSource.includes("trySet('play'") && shellSource.includes("session.setActionHandler('seekto'"), 'AA: Media Session play/seekto handlers still target the SAME video element');
ok(viewportSource.includes('export function requestPictureInPicture()') && !viewportSource.includes('enterpictureinpicture'), 'AB: PlayerViewport still exposes requestPictureInPicture on the SAME video element (PiP intact)');
ok(shellSource.includes('function attachPipListeners(') && shellSource.includes("$: attachPipListeners(videoElement);"), 'AB: PiP listener attachment still tracks the SAME video element identity');
ok(shellSource.includes('async function toggleFullscreen()') && shellSource.includes('playerRoot?.requestFullscreen?.()'), 'AC: fullscreen still targets the player shell root (no second video element, no DOM moves)');
ok(shellSource.includes('async function acquireWakeLock()') && shellSource.includes('async function releaseWakeLock()') && shellSource.includes('function handleVisibilityChangeForWakeLock()'), 'AD: Wake Lock acquire/release + visibility handling are intact');
ok(shellSource.includes('function handlePlay()') && shellSource.includes('acquireWakeLock();') && shellSource.includes('function handlePause()') && shellSource.includes('releaseWakeLock();'), 'AD: Wake Lock is still acquired on play and released on pause/end/error');
ok(!/hls/i.test(shellSource), 'AD: PlayerShell contains zero hls-specific logic (it is an implementation detail below the shell)');

// ===========================================================================
// AE–AH — security pins: no proxy / headers / DRM / torrent
// ===========================================================================

ok(!/fetch\(|XMLHttpRequest|xhrSetup|fetchSetup/.test(engineSource), 'AE: the engine never fetches media itself — manifest/segment requests stay plain browser requests (no proxy)');
ok(!engineSource.includes('xhrSetup') && !engineSource.includes('fetchSetup') && !engineSource.toLowerCase().includes('authorization'), 'AF: no xhrSetup/fetchSetup/custom Authorization headers are configured');
ok(!/requestMediaKeySystemAccess|setMediaKeys|MediaKeys\b/i.test(engineSource + viewportSource), 'AG: no DRM/EME code — unsupported DRM fails through the normal error path');
ok(!/magnet|torrent|\.torrent|infohash|externalUrl/i.test(engineSource + read('src/lib/client/player/mavero-player.ts')), 'AH: no torrent/P2P/magnet/externalUrl playback path exists in the client player modules');
// AE second pin: no media-proxy ROUTE exists anywhere in the API surface
// (filesystem check — route segments named *proxy* would be the only way to
// proxy media through Mavero).
function listRouteFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listRouteFiles(full));
    else out.push(full);
  }
  return out;
}
const routeFiles = listRouteFiles(path.join(REPO_ROOT, 'src', 'routes'));
ok(routeFiles.every((file) => !/proxy/i.test(path.relative(path.join(REPO_ROOT, 'src', 'routes'), file))), 'AE: no media-proxy route exists in the API surface (filesystem pin)');

// ===========================================================================
// AI–AK — existing adapters / embed / provider resolver unchanged
// ===========================================================================

{
  const registry = createDefaultAdapterRegistry();
  const adapters = registry.list();
  ok(adapters[0] instanceof DirectPlayerAdapter, 'AI: DirectPlayerAdapter is still the FIRST registry entry');
  ok(adapters[0].canHandle(makeSource({ url: 'https://cdn.example/video.mp4', metadata: { protocol: 'mp4' } })), 'AI: the direct adapter still handles MP4 sources (unchanged predicate)');
  ok(adapters[0].canHandle(makeSource()), 'AI: the direct adapter still handles HLS sources (they ride the existing direct lifecycle)');
  ok(!(adapters[0] as unknown as { hlsEngine?: unknown }).hlsEngine, 'AI: the direct adapter itself owns no hls.js state (engine lives in the viewport, below the shell)');
  const embedSource = makeSource({ type: 'embed', url: 'https://unknown-provider.example/embed/550' });
  ok(registry.pickAdapter(embedSource) instanceof EmbedPlayerAdapter, 'AJ: embed sources still pick the generic embed adapter (unchanged)');
  ok(registry.pickAdapter(makeSource({ type: 'embed', url: 'https://vidsrc.wiki/embed/550' })) instanceof DirectPlayerAdapter === false, 'AJ: provider-specific embed adapters still match by origin (unchanged registry order)');
  ok(viewportSource.includes("{:else if source?.type === 'embed' && source.url}") && viewportSource.includes('sandbox={sandboxAttribute}') && viewportSource.includes('referrerpolicy="no-referrer"'), 'AJ: the embed iframe branch (sandbox + referrer policy) is byte-for-byte intact');
  ok(!/stremio|StreamResolver|stream-resolver/i.test(read('src/lib/server/resolver/service.ts') + read('src/lib/server/resolver/core.ts')), 'AK: the provider resolver still imports NOTHING from Stremio/hls (semantic isolation preserved)');
  ok(playbackManagerSource.includes("['mp4', 'file', 'hls', 'dash', 'unknown']") && !playbackManagerSource.includes("'hls.js'"), 'AK: the manager protocol whitelist already includes hls (unchanged) and the manager has no hls.js logic');
}

// ===========================================================================
// AL — HLS URLs stay HTTPS-only under the existing playback validation
// ===========================================================================

ok(isPlayablePlayerSource(makeSource({ url: 'https://cdn.example/video.m3u8', metadata: { protocol: 'hls' } })), 'AL: an HTTPS HLS source passes the existing shared guard');
ok(!isPlayablePlayerSource(makeSource({ url: 'http://cdn.example/video.m3u8', metadata: { protocol: 'hls' } })), 'AL: a plain-http HLS source is REJECTED by the existing guard (no weakened validation)');
ok(isPlayablePlayerSource(makeSource({ url: 'https://cdn.example/video.mp4', metadata: { protocol: 'mp4' } })) && !isPlayablePlayerSource(makeSource({ url: 'http://cdn.example/video.mp4' })), 'AL: the MP4 policy is untouched (same boundary for both protocols)');

// ===========================================================================
// AM/AN/AO — cleanup, listener hygiene, unmount
// ===========================================================================

ok(viewportSource.includes('onDestroy(teardownHlsEngine)'), 'AM: the viewport destroys the engine on component unmount');
ok(viewportSource.includes('function teardownHlsEngine()') && viewportSource.includes('hlsEngine.destroy();'), 'AM: teardown destroys the live engine instance and clears the engine state');
{
  // AN: listener hygiene — each purposeful listener attached exactly once
  // per instance; a fresh instance per attach means zero accumulation.
  const instances: FakeHls[] = [];
  const engine = new HlsPlaybackEngine({ hlsLoader: loaderOf(makeFactory(instances)) });
  await engine.attach(makeVideo(''), 'https://cdn.example/a.m3u8');
  await engine.attach(makeVideo(''), 'https://cdn.example/b.m3u8');
  // Phase 6 extended the purposeful set with manifestParsed + levelSwitched
  // (the sanctioned internal-quality surface — each still purposeful, never
  // speculative), so the expected set is the CURRENT minimal contract.
  const purposeful = [HLS_ENGINE_EVENTS.mediaAttached, HLS_ENGINE_EVENTS.manifestLoading, HLS_ENGINE_EVENTS.manifestLoaded, HLS_ENGINE_EVENTS.manifestParsed, HLS_ENGINE_EVENTS.levelSwitched, HLS_ENGINE_EVENTS.error];
  ok(instances[0].listeners.size === purposeful.length, 'AN: exactly the purposeful hls.js events are listened to (minimal set, no speculative listeners)');
  for (const event of purposeful) {
    ok((instances[0].listeners.get(event)?.length ?? 0) === 1, `AN: ${event} is registered exactly once`);
  }
  ok(instances[0].destroyCalls === 1, 'AN: the superseded instance is destroyed so its listeners can never double-fire');
  ok(instances[1].destroyCalls === 0, 'AN: only the current instance keeps live listeners');
  engine.destroy();
  ok(viewportSource.includes('if (hlsEngineActive && hlsEngineUrl === url) return;'), 'AN: the viewport wiring guard prevents duplicate attach/listener creation for the same URL');
}
{
  // AO: no hls.js instance survives unmount.
  const instances: FakeHls[] = [];
  const engine = new HlsPlaybackEngine({ hlsLoader: loaderOf(makeFactory(instances)) });
  await engine.attach(makeVideo(''), 'https://cdn.example/a.m3u8');
  engine.destroy();
  ok(instances[0].destroyCalls === 1 && engine.getInstance() === null && !engine.isActive(), 'AO: destroy() leaves no surviving hls.js instance, reference or activity');
  // An engine destroyed before attach can never start.
  FakeHls.instances.length = 0;
  const beforeAttach = new HlsPlaybackEngine({ hlsLoader: loaderOf(makeFactory()) });
  beforeAttach.destroy();
  await beforeAttach.attach(makeVideo(''), 'https://cdn.example/a.m3u8');
  ok(FakeHls.instances.length === 0, 'AO: an unmounted engine can never create a new hls.js instance');
}

// ===========================================================================
// Summary
// ===========================================================================

console.log(`stremio_player_phase5_test: ${passed} checks passed (hls.js ${hlsPackageJson.version}, stable channel)`);
