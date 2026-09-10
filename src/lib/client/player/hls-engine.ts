import { PLAYER_AUTO_QUALITY_ID, type PlayerInternalQualityOption, type PlayerSource } from '$lib/shared/player';

/**
 * HLS playback engine — Phase 5, Phase 10 (Video.js ownership).
 *
 * A SMALL adapter for the EXISTING direct `<video>` path. This is NOT a new
 * player: PlayerShell, PlayerViewport, the PlaybackManager, the
 * DirectPlayerAdapter, progress/resume, quality switching, fullscreen, PiP,
 * Media Session and Wake Lock are untouched. The engine only owns the HLS
 * resource lifecycle for HLS sources that the browser cannot play natively:
 *
 *   PlaybackManager → PlayerShell → PlayerViewport
 *     → direct MP4 / native HLS  → existing `<video src>` path (unchanged)
 *     → non-native HLS           → THIS engine → SAME `<video>`
 *
 * PHASE 10 — VIDEO.JS IS THE SINGLE HLS OWNER (GOALS 7/8):
 *   The hls.js instance is created, attached, loaded and destroyed by the
 *   official Video.js v10 adapter (`@videojs/hlsjs-video` 10 RC — the
 *   `HlsJsVideo` integration documented at videojs.org). Mavero source code
 *   no longer imports `hls.js` anywhere: the engine constructs the Video.js
 *   `HlsJsAdapter` and drives it through its documented surface
 *   (attach/src/load + the `engine` property exposing the underlying hls.js
 *   instance). Exactly ONE owner exists — Video.js — so there can never be a
 *   second competing hls.js controller on the same media element. The
 *   previous direct-hls.js implementation of this file was REMOVED, not
 *   parallel-kept (no half integration).
 *
 *   What Mavero still owns here (policy, not engine): generation/race
 *   guards, bounded recovery limits, error classification, the engine-free
 *   quality surface, and the native-HLS routing decision
 *   (`resolveDirectPlaybackMode`).
 *
 * SSR BOUNDARY (spec §2/§30):
 *   * This module is CLIENT-ONLY. It contains no top-level browser globals
 *     and no top-level side effects, so importing it during SSR is safe.
 *   * The Video.js module is loaded exclusively through a dynamic ESM
 *     import inside `defaultHlsModuleLoader()` — it can never execute
 *     during SvelteKit SSR, server routes or server resolver code. No
 *     server module imports this file.
 *
 * OWNERSHIP (spec §7):
 *   PlayerViewport (the component that owns the `<video>` element) is the
 *   single owner of the engine. There is exactly ONE engine instance and
 *   therefore at most ONE live Video.js hls.js instance per video element at
 *   any time. The PlaybackManager and PlayerShell never see hls.js APIs.
 *
 * RACE PROTECTION (spec §8):
 *   Every `attach()` bumps an internal generation token. A slow
 *   initialization for source A is invalidated when the source switches to
 *   B (destroy/attach), and stale loader continuations or stale events can
 *   never reach the current video element or callbacks.
 *
 * ERROR HANDLING (spec §10):
 *   Bounded recovery only — fatal network errors get a small number of
 *   `startLoad()` retries, fatal media errors get one `recoverMediaError()`
 *   attempt; anything beyond that (and every other fatal type) destroys the
 *   adapter and surfaces a generic player error. No infinite retry loops.
 *
 * SECURITY (spec §24–§27):
 *   No proxying, no URL rewriting, no custom loader hooks (no request-header
 *   injection of any kind), no DRM/EME code. The Video.js adapter runs with
 *   ITS default hls.js configuration; Mavero passes no media-engine config
 *   overrides. Manifest/segment/key requests are plain browser requests
 *   subject to normal CORS.
 *
 * PHASE 6: the engine additionally exposes a MINIMAL, generic internal
 * quality-level API (`getQualityLevels/getQualityOptions`,
 * `getQualitySelection`, `setAutoQualityLevel`, `setQualityLevel`) so the
 * existing quality UI can offer AUTO + manifest levels for engine-driven
 * HLS. The API is hls.js-free (`PlayerInternalQualityOption` + the reserved
 * AUTO id only), switches levels SEAMLESSLY via `nextLevel` (never recreating
 * the engine), defaults to AUTO (no level is forced), and falls back to AUTO
 * on a failed switch request instead of destroying the instance.
 */

/** Minimal structural shape of one hls.js quality level (Phase 6). */
export type HlsLevelLike = {
  height?: number;
  bitrate?: number;
};

/**
 * Minimal structural shape of the hls.js instance the engine needs.
 *
 * Phase 10: this is the shape of the Video.js adapter's `engine` object
 * (the underlying hls.js 1.7.2 instance — verified against its typings).
 * Every real hls.js instance has these members, while existing test doubles
 * of the narrower interface keep compiling and the engine degrades to "no
 * quality UI" when they are absent.
 *
 * Level-switch semantics (hls.js 1.7.2, verified from its typings):
 *   * `nextLevel = n`   — switch asap WITHOUT interrupting playback
 *                         (seamless; spec §12 prefers this for manual
 *                         selection; also aborts stale fragment loads)
 *   * `nextLevel = -1`  — automatic level selection (the correct AUTO
 *                         mechanism — no magic numeric level, spec §34)
 *   * `autoLevelEnabled`— true while ABR is in control (the UI's mode
 *                         indicator, spec §33)
 * The engine deliberately does NOT touch `currentLevel` (it flushes the
 * buffer and interrupts playback) or `loadLevel` (conservative, delayed
 * effect) — `nextLevel` covers both AUTO and manual switching.
 */
export type HlsLike = {
  loadSource(url: string): void;
  attachMedia(media: HTMLMediaElement): void;
  destroy(): void;
  startLoad(startPosition?: number): void;
  stopLoad(): void;
  recoverMediaError(): void;
  on(event: string, listener: (event: string, data?: HlsEventData) => void): void;
  off(event: string, listener: (event: string, data?: HlsEventData) => void): void;
  /** All quality levels of the loaded manifest (Phase 6, optional). */
  readonly levels?: readonly HlsLevelLike[];
  /** True while automatic level selection (ABR) is enabled (Phase 6). */
  readonly autoLevelEnabled?: boolean;
  /** Index of the level currently playing (Phase 6, inspection only). */
  readonly currentLevel?: number;
  /** Seamless level switch target; `-1` re-enables AUTO (Phase 6). */
  nextLevel?: number;
  /**
   * Phase 10 (GOAL 18): addon/HLS-provided audio tracks (only present when
   * the stream actually carries alternate audio renditions). Never invented:
   * a mono-audio stream exposes none.
   */
  readonly audioTracks?: readonly HlsAudioTrackLike[];
  /** Selected audio track index (-1 = default); hls.js contract (optional). */
  audioTrack?: number;
};

/** One hls.js audio track (structural — hls.js `audioTracks` entries). */
export type HlsAudioTrackLike = {
  id: number;
  lang?: string;
  name?: string;
  default?: boolean;
};

/** Subset of the hls.js error payload the engine inspects. */
export type HlsEventData = {
  fatal?: boolean;
  type?: string;
  details?: string;
};

/**
 * Phase 10: the structural shape of the Video.js HlsJsAdapter surface the
 * facade drives. Only documented members — attach/detach/destroy, the src
 * property (assignment triggers the documented load request) and the
 * read-only `engine` property (the underlying hls.js instance, populated
 * once the MSE delegate is created).
 */
export type VideoJsAdapterLike = {
  attach(target: HTMLMediaElement): void;
  detach(): void;
  destroy(): void;
  src: string;
  readonly engine: HlsLike | null;
  addEventListener(type: string, listener: (event: Event) => void): void;
  removeEventListener(type: string, listener: (event: Event) => void): void;
};

/**
 * Phase 10: the structural shape of the `@videojs/hlsjs-video` module the
 * loader consumes. `HlsJsAdapter` constructs the Video.js adapter; `Hls`
 * is the underlying hls.js export (its `.isSupported()` gate and `.Events`
 * map are used by the facade).
 */
export type VideoJsHlsModule = {
  HlsJsAdapter: new () => VideoJsAdapterLike;
  Hls: { isSupported(): boolean; Events: Record<string, string> };
};

/**
 * Phase 10 factory: constructs the engine-facing instance for ONE playback.
 * The production factory builds the Video.js-backed facade below; tests
 * inject fakes of the same shape (unchanged since Phase 5).
 */
export type HlsFactory = (config?: Record<string, unknown>) => HlsLike;

/**
 * Loads the Video.js hlsjs-video ES module and adapts it to an
 * `HlsFactory`. Returns `null` when the module cannot be loaded (e.g. very
 * old browser) — the caller surfaces an unsupported-media error instead of
 * crashing.
 *
 * CLIENT-ONLY: called exclusively from browser code paths (PlayerViewport
 * wiring). The dynamic import is cached by the browser module system, and
 * the resolved factory is memoized here to avoid repeated module lookups.
 */
export type HlsModuleLoader = () => Promise<HlsFactory | null>;

/** hls.js engine event names mapped onto Video.js adapter lifecycle hooks. */
const VIDEO_JS_EVENTS = {
  /** Adapter hook fired right after the MSE delegate (+hls.js engine) exists. */
  loadstart: 'loadstart',
  /** Adapter hook for fatal errors (bridged by the adapter's error mixin). */
  error: 'error',
} as const;

/**
 * The Video.js-backed HlsLike facade (Phase 10). One facade = ONE
 * `HlsJsAdapter` = ONE hls.js instance, created and destroyed by Video.js:
 *
 *   engine.attach()        → facade created by the factory (adapter exists)
 *   facade.attachMedia(v)  → remembers the media element
 *   facade.loadSource(url) → adapter.attach(v) + adapter.src = url
 *                            → Video.js creates the MSE delegate + hls.js
 *                              instance, attaches, starts loading
 *   facade.destroy()       → adapter.destroy() (destroys the hls.js instance)
 *
 * Event subscriptions made BEFORE the underlying engine exists are buffered
 * and applied the moment the adapter reports its `loadstart` hook (the
 * documented point where `adapter.engine` is populated). Fatal errors arrive
 * through the adapter's own `error` events, carrying the original hls.js
 * error data (`event.error.data` — set by the adapter's error mixin), which
 * the engine's recovery policy consumes.
 */
class VideoJsHlsFacade implements HlsLike {
  private adapter: VideoJsAdapterLike;
  private events: Record<string, string>;
  private hls: VideoJsHlsModule['Hls'];
  private video: HTMLMediaElement | null = null;
  private engine: HlsLike | null = null;
  private buffered: Array<{ event: string; listener: (event: string, data?: HlsEventData) => void }> = [];
  /** 'hlsError' listeners — independent of the underlying engine lifecycle. */
  private errorListeners = new Set<(event: string, data?: HlsEventData) => void>();
  private adapterError = (event: Event) => {
    const data = (event as ErrorEvent).error?.data as HlsEventData | undefined;
    const payload = data ?? { fatal: true, type: 'otherError', details: 'adapter-error' };
    for (const listener of [...this.errorListeners]) {
      try {
        listener('hlsError', payload);
      } catch {
        // listener errors must never break the engine
      }
    }
  };
  private adapterLoadStart = () => {
    this.captureEngine();
  };

  constructor(module: VideoJsHlsModule) {
    this.events = module.Hls.Events;
    this.hls = module.Hls;
    this.adapter = new module.HlsJsAdapter();
    this.adapter.addEventListener(VIDEO_JS_EVENTS.loadstart, this.adapterLoadStart);
    this.adapter.addEventListener(VIDEO_JS_EVENTS.error, this.adapterError);
  }

  /** Test/inspection hook: the live hls.js instance owned by Video.js. */
  getUnderlyingEngine(): HlsLike | null {
    return this.engine;
  }

  attachMedia(media: HTMLMediaElement): void {
    this.video = media;
  }

  loadSource(url: string): void {
    if (!this.video) return;
    // Video.js decides MSE-vs-native itself; Mavero only reaches this path
    // for browsers without native HLS (PlayerViewport routing). A browser
    // with neither native HLS nor MSE cannot play the stream at all —
    // surface the fatal error instead of a doomed native attempt.
    if (typeof this.events.MANIFEST_PARSED !== 'string' || !this.hls.isSupported()) {
      this.dispatchError({ fatal: true, type: 'otherError', details: 'mse-unsupported' });
      return;
    }
    this.adapter.attach(this.video);
    // Documented contract: assigning src triggers the load request
    // (async microtask) — the `loadstart` hook then exposes `engine`.
    this.adapter.src = url;
  }

  destroy(): void {
    try {
      this.adapter.removeEventListener(VIDEO_JS_EVENTS.loadstart, this.adapterLoadStart);
      this.adapter.removeEventListener(VIDEO_JS_EVENTS.error, this.adapterError);
    } catch {
      // listener removal must never throw
    }
    try {
      // Video.js owns the hls.js instance lifecycle — destroy through it.
      this.adapter.destroy();
    } catch {
      // destroy must never throw — internals may already be torn down.
    }
    this.engine = null;
    this.video = null;
    this.buffered = [];
    this.errorListeners.clear();
  }

  startLoad(startPosition?: number): void {
    try {
      this.engine?.startLoad(startPosition);
    } catch {
      // recovery must never throw
    }
  }

  stopLoad(): void {
    try {
      this.engine?.stopLoad();
    } catch {
      // must never throw
    }
  }

  recoverMediaError(): void {
    try {
      this.engine?.recoverMediaError();
    } catch {
      // recovery must never throw
    }
  }

  on(event: string, listener: (event: string, data?: HlsEventData) => void): void {
    if (event === 'hlsError') {
      // Bridged via the adapter error listener — registered immediately,
      // independent of when the underlying engine appears.
      this.errorListeners.add(listener);
      return;
    }
    if (this.engine) this.subscribe(event, listener);
    else this.buffered.push({ event, listener });
  }

  off(event: string, listener: (event: string, data?: HlsEventData) => void): void {
    if (event === 'hlsError') {
      this.errorListeners.delete(listener);
      return;
    }
    this.buffered = this.buffered.filter((entry) => entry.listener !== listener || entry.event !== event);
    if (!this.engine) return;
    const target = this.hlsEventName(event);
    if (!target) return;
    try {
      this.engine.off(target, listener);
    } catch {
      // must never throw
    }
  }

  get levels(): readonly HlsLevelLike[] | undefined {
    return this.engine?.levels;
  }

  get autoLevelEnabled(): boolean | undefined {
    return this.engine?.autoLevelEnabled;
  }

  get currentLevel(): number | undefined {
    return this.engine?.currentLevel;
  }

  get nextLevel(): number | undefined {
    return this.engine?.nextLevel;
  }

  set nextLevel(value: number | undefined) {
    if (!this.engine || value === undefined) return;
    this.engine.nextLevel = value;
  }

  get audioTracks(): readonly HlsAudioTrackLike[] | undefined {
    return this.engine?.audioTracks;
  }

  get audioTrack(): number | undefined {
    return this.engine?.audioTrack;
  }

  set audioTrack(value: number | undefined) {
    if (!this.engine || value === undefined) return;
    this.engine.audioTrack = value;
  }

  /** Maps an engine event name onto the underlying hls.js event name. */
  private hlsEventName(event: string): string | null {
    switch (event) {
      case 'hlsMediaAttached': return this.events.MEDIA_ATTACHED ?? null;
      case 'hlsManifestLoading': return this.events.MANIFEST_LOADING ?? null;
      case 'hlsManifestLoaded': return this.events.MANIFEST_LOADED ?? null;
      case 'hlsManifestParsed': return this.events.MANIFEST_PARSED ?? null;
      case 'hlsLevelLoaded': return this.events.LEVEL_LOADED ?? null;
      case 'hlsLevelSwitched': return this.events.LEVEL_SWITCHED ?? null;
      // 'hlsError' is delivered through the ADAPTER's error events instead.
      default: return null;
    }
  }

  private dispatchError(data: HlsEventData): void {
    for (const listener of [...this.errorListeners]) {
      try {
        listener('hlsError', data);
      } catch {
        // listener errors must never break the engine
      }
    }
  }

  private subscribe(event: string, listener: (event: string, data?: HlsEventData) => void): void {
    const target = this.hlsEventName(event);
    if (!target) return;
    try {
      this.engine?.on(target, listener);
    } catch {
      // subscription must never throw
    }
  }

  /** Applies buffered subscriptions once Video.js exposes the hls.js engine. */
  private captureEngine(): void {
    const engine = this.adapter.engine;
    if (!engine || this.engine === engine) return;
    this.engine = engine;
    const pending = this.buffered;
    this.buffered = [];
    for (const entry of pending) this.subscribe(entry.event, entry.listener);
  }
}

export async function defaultHlsModuleLoader(): Promise<HlsFactory | null> {
  try {
    const mod = (await import('@videojs/hlsjs-video')) as unknown as { default?: unknown } & Record<string, unknown>;
    const AdapterCtor = mod.HlsJsAdapter;
    const HlsExport = mod.Hls as VideoJsHlsModule['Hls'] | undefined;
    if (typeof AdapterCtor !== 'function' || !HlsExport || typeof HlsExport.isSupported !== 'function' || !HlsExport.Events) return null;
    const module: VideoJsHlsModule = { HlsJsAdapter: AdapterCtor as new () => VideoJsAdapterLike, Hls: HlsExport };
    return () => new VideoJsHlsFacade(module);
  } catch {
    return null;
  }
}

/**
 * Memoized factory promise. The browser module system caches the dynamic
 * import itself; memoizing the promise additionally avoids repeated
 * resolution work when the user switches between several HLS sources.
 */
let cachedFactoryPromise: Promise<HlsFactory | null> | null = null;
export function loadHlsFactory(): Promise<HlsFactory | null> {
  if (!cachedFactoryPromise) cachedFactoryPromise = defaultHlsModuleLoader();
  return cachedFactoryPromise;
}
/** Test-only reset for the memoized factory promise. */
export function resetHlsFactoryCache(): void {
  cachedFactoryPromise = null;
}

// ---------------------------------------------------------------------------
// Protocol routing (spec §3/§4)
// ---------------------------------------------------------------------------

/**
 * True when the URL path ends with `.m3u8` (case-insensitive, query/hash
 * safe). Used ONLY as fallback detection when the normalized source carries
 * no usable protocol metadata — an explicit protocol always wins.
 */
export function looksLikeHlsUrl(url: string): boolean {
  try {
    return new URL(url).pathname.toLowerCase().endsWith('.m3u8');
  } catch {
    return false;
  }
}

/**
 * Decide whether a direct source is an HLS stream.
 *
 * Order of precedence (spec §3 — "Do NOT determine HLS solely from a
 * filename if the normalized source already contains protocol
 * information"):
 *   1. `metadata.protocol === 'hls'`  → HLS.
 *   2. any other EXPLICIT protocol ('mp4' | 'file' | 'dash') → not HLS.
 *   3. protocol missing/unknown → `.m3u8` URL fallback detection.
 *
 * An ordinary MP4 URL therefore never classifies as HLS.
 */
export function isHlsMediaSource(source: PlayerSource | null, url: string): boolean {
  const protocol = source?.metadata?.protocol;
  if (protocol === 'hls') return true;
  if (protocol && protocol !== 'unknown') return false;
  return looksLikeHlsUrl(url);
}

/**
 * Native HLS capability check (spec §4 — Safari/iOS path). Uses the
 * standard `canPlayType` probe for the HLS mime types. The Video.js engine
 * must NOT be loaded when native playback works.
 */
export function supportsNativeHls(video: Pick<HTMLMediaElement, 'canPlayType'>): boolean {
  return Boolean(
    video.canPlayType('application/vnd.apple.mpegurl') ||
    video.canPlayType('application/x-mpegURL'),
  );
}

/** How the current direct source should play on this browser. */
export type DirectPlaybackMode = 'native' | 'hls-js';

/**
 * Route a direct source:
 *   - non-HLS (MP4/WebM/file) → 'native'   (existing path, unchanged)
 *   - HLS + native support    → 'native'  (`video.src` path — existing lifecycle)
 *   - HLS + no native support → 'hls-js'  (this engine → Video.js adapter
 *                             takes over the `<video>` — the ONE HLS owner)
 */
export function resolveDirectPlaybackMode(source: PlayerSource | null, url: string, video: Pick<HTMLMediaElement, 'canPlayType'>): DirectPlaybackMode {
  if (!isHlsMediaSource(source, url)) return 'native';
  return supportsNativeHls(video) ? 'native' : 'hls-js';
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

/** Generic (engine-library-agnostic) engine states exposed to the viewport. */
export type HlsEngineState = 'loading' | 'manifest-loaded' | 'attached' | 'error';

export type HlsEngineCallbacks = {
  /** Generic state transitions — never engine-library event names. */
  onState?: (state: HlsEngineState) => void;
  /** Unrecoverable failure — the video cannot play this source. */
  onFatalError?: (message: string) => void;
  /**
   * Phase 6: the manifest's quality levels became known. Fired once per
   * attach when the manifest is parsed (single-level manifests yield a
   * one-entry list — the UI stays hidden for those).
   */
  onQualityLevels?: (levels: HlsEngineLevel[]) => void;
  /**
   * Phase 6: the internal quality MODE/level changed (level switch
   * completed). `selection` is the generic selection id — the reserved
   * AUTO id while ABR is in control, else the playing level index.
   */
  onQualitySelection?: (selection: string, levels: HlsEngineLevel[]) => void;
};

export type HlsEngineOptions = {
  /** Injectable module loader (tests); defaults to the dynamic import. */
  hlsLoader?: HlsModuleLoader;
};

/** Bounded recovery budget (spec §10 — no infinite retry loops). */
export const HLS_RECOVERY_LIMITS = { network: 2, media: 1 } as const;

/** Engine event names the facade listens to (purposeful subset only). */
export const HLS_ENGINE_EVENTS = {
  mediaAttached: 'hlsMediaAttached',
  manifestLoading: 'hlsManifestLoading',
  manifestLoaded: 'hlsManifestLoaded',
  manifestParsed: 'hlsManifestParsed',
  levelLoaded: 'hlsLevelLoaded',
  levelSwitched: 'hlsLevelSwitched',
  error: 'hlsError',
} as const;

export const HLS_UNRECOVERABLE_MESSAGE = 'This stream could not be played. Try another source.';
export const HLS_UNSUPPORTED_MESSAGE = 'HLS playback is not supported in this browser. Try another source.';

/**
 * One engine-agnostic internal quality level (Phase 6). `index` is the
 * hls.js level index (the selection key handed back to `setQualityLevel`);
 * `label` is pre-derived safe presentation text — the UI never derives
 * labels from engine objects itself.
 */
export type HlsEngineLevel = {
  index: number;
  height?: number;
  bitrate?: number;
  label: string;
};

/**
 * Safe quality label derivation for one hls.js level (spec §32):
 *   height 1080      → "1080p"
 *   bitrate 1500000  → "1.5 Mbps" / bitrate 800000 → "800 kbps"
 *   neither          → "Auto" (no misleading labels are ever produced)
 */
export function hlsLevelLabel(level: HlsLevelLike): string {
  if (typeof level?.height === 'number' && Number.isFinite(level.height) && level.height > 0) {
    return `${Math.round(level.height)}p`;
  }
  if (typeof level?.bitrate === 'number' && Number.isFinite(level.bitrate) && level.bitrate > 0) {
    const kbps = Math.round(level.bitrate / 1000);
    if (kbps >= 1000) {
      const mbps = kbps / 1000;
      return `${Number.isInteger(mbps) ? mbps : Number(mbps.toFixed(1))} Mbps`;
    }
    return `${kbps} kbps`;
  }
  return 'Auto';
}

/** Map a structural hls.js levels array onto engine-agnostic levels. */
function engineLevelsOf(levels: readonly HlsLevelLike[] | undefined): HlsEngineLevel[] {
  if (!Array.isArray(levels)) return [];
  return levels.map((level, index) => {
    const label = hlsLevelLabel(level);
    const height = typeof level?.height === 'number' && Number.isFinite(level.height) && level.height > 0 ? Math.round(level.height) : undefined;
    const bitrate = typeof level?.bitrate === 'number' && Number.isFinite(level.bitrate) && level.bitrate > 0 ? Math.round(level.bitrate) : undefined;
    return {
      index,
      label,
      ...(height !== undefined ? { height } : {}),
      ...(bitrate !== undefined ? { bitrate } : {}),
    };
  });
}

/** Engine-agnostic internal quality options (Phase 6 UI contract). */
function internalQualityOptionsOf(levels: HlsEngineLevel[]): PlayerInternalQualityOption[] {
  return levels.map((level) => ({ id: String(level.index), label: level.label }));
}

export class HlsPlaybackEngine {
  private loader: HlsModuleLoader;
  /** Generation token — bumped on every attach/destroy; stale continuations drop. */
  private generation = 0;
  private instance: HlsLike | null = null;
  private active = false;
  private destroyed = false;
  private networkRecoveries = 0;
  private mediaRecoveries = 0;

  constructor(options: HlsEngineOptions = {}) {
    this.loader = options.hlsLoader ?? loadHlsFactory;
  }

  /** True while an adapter instance is attached (or initializing) for a source. */
  isActive(): boolean {
    return this.active;
  }

  /** Test/inspection hook: the live engine-facing instance, if any. */
  getInstance(): HlsLike | null {
    return this.instance;
  }

  // ----- Phase 6: internal quality levels (generic, library-free surface) -----
  //
  // The UI (PlayerShell / PlayerControls) only ever sees
  // `PlayerInternalQualityOption` lists + the reserved AUTO id — never
  // hls.js types (`Hls.Level`, `Hls.Events`, …). When the instance predates
  // the quality surface (test doubles) or no instance is live, the getters
  // degrade gracefully to empty/AUTO.

  /** All quality levels of the loaded manifest, in manifest order. */
  getQualityLevels(): HlsEngineLevel[] {
    if (this.destroyed) return [];
    return engineLevelsOf(this.instance?.levels);
  }

  /**
   * The current generic selection id: AUTO while ABR is in control, else
   * the playing level index as a string. `null` when no instance is live.
   * The UI must reflect the actual selected MODE (spec §33/§34) — in AUTO
   * mode this stays AUTO even as ABR moves between levels.
   */
  getQualitySelection(): string | null {
    const instance = this.instance;
    if (!instance || this.destroyed) return null;
    if (instance.autoLevelEnabled === false) {
      const current = instance.currentLevel;
      if (typeof current === 'number' && Number.isSafeInteger(current) && current >= 0) return String(current);
    }
    return PLAYER_AUTO_QUALITY_ID;
  }

  /** Engine-agnostic quality options for the UI (empty when unavailable). */
  getQualityOptions(): PlayerInternalQualityOption[] {
    return internalQualityOptionsOf(this.getQualityLevels());
  }

  /**
   * Re-enable automatic level selection (spec §10). Uses the `nextLevel =
   * -1` AUTO mechanism — no magic numeric level (spec §34). Never throws.
   */
  setAutoQualityLevel(): void {
    const instance = this.instance;
    if (!instance || this.destroyed || instance.nextLevel === undefined) return;
    try {
      instance.nextLevel = -1;
    } catch {
      // Level API unavailable/failed — stay in the current mode; the ABR
      // default remains authoritative (never a fatal player error).
    }
  }

  /**
   * Select one quality level manually (spec §12). Uses the SEAMLESS
   * `nextLevel` switch — playback continues without a buffer flush, the
   * engine instance is NEVER recreated for an internal level change. On a
   * failed switch request the engine falls back to AUTO instead of
   * destroying the instance (spec §35) — only a genuinely unrecoverable
   * playback failure (the existing fatal-error path) surfaces an error.
   */
  setQualityLevel(index: number): void {
    const instance = this.instance;
    if (!instance || this.destroyed || instance.nextLevel === undefined) return;
    if (!Number.isSafeInteger(index) || index < 0 || index >= (instance.levels?.length ?? 0)) return;
    try {
      instance.nextLevel = index;
    } catch {
      try {
        instance.nextLevel = -1; // fall back to AUTO (spec §35)
      } catch {
        // give up silently — the ABR default remains authoritative
      }
    }
  }

  // ----- Phase 10 (GOAL 18): audio tracks — only when the stream HAS them -----

  /**
   * The stream's audio tracks, verbatim from the manifest/engine. EMPTY when
   * the stream has none (or the engine predates the surface) — the UI never
   * renders a selector for a single/unknown track set (never claims audio
   * can be switched when it cannot).
   */
  getAudioTracks(): HlsAudioTrackLike[] {
    const tracks = this.instance?.audioTracks;
    return Array.isArray(tracks) ? [...tracks] : [];
  }

  /** The currently playing audio track index, or null when unavailable. */
  getSelectedAudioTrack(): number | null {
    const current = this.instance?.audioTrack;
    return typeof current === 'number' && current >= 0 ? current : null;
  }

  /** Selects one audio track by engine index. Never recreates the engine. */
  selectAudioTrack(index: number): void {
    const instance = this.instance;
    if (!instance || this.destroyed) return;
    if (!Number.isSafeInteger(index) || index < 0 || index >= (instance.audioTracks?.length ?? 0)) return;
    try {
      instance.audioTrack = index;
    } catch {
      // selection failure is non-fatal — the current track keeps playing
    }
  }

  /**
   * Attach the engine to a video element and start loading `url` through
   * Video.js. Safe to call repeatedly for source switches: the previous
   * adapter is always destroyed first, so exactly ONE hls.js instance is
   * ever attached to the video element.
   */
  async attach(video: HTMLMediaElement, url: string, callbacks: HlsEngineCallbacks = {}): Promise<void> {
    this.generation += 1;
    const generation = this.generation;
    // Never allow two instances on the same video element.
    this.destroyInstance();
    this.networkRecoveries = 0;
    this.mediaRecoveries = 0;
    this.active = true;
    callbacks.onState?.('loading');

    const factory = await this.loader();
    // Stale attach: a newer attach/destroy superseded this one.
    if (this.destroyed || generation !== this.generation) return;
    if (!factory) {
      this.active = false;
      callbacks.onState?.('error');
      callbacks.onFatalError?.(HLS_UNSUPPORTED_MESSAGE);
      return;
    }

    // The Video.js-backed facade (or a test double of the same shape).
    const instance = factory();
    this.instance = instance;
    instance.on(HLS_ENGINE_EVENTS.manifestLoading, () => {
      if (generation !== this.generation || this.destroyed) return;
      callbacks.onState?.('loading');
    });
    instance.on(HLS_ENGINE_EVENTS.manifestLoaded, () => {
      if (generation !== this.generation || this.destroyed) return;
      callbacks.onState?.('manifest-loaded');
    });
    instance.on(HLS_ENGINE_EVENTS.mediaAttached, () => {
      if (generation !== this.generation || this.destroyed) return;
      callbacks.onState?.('attached');
    });
    instance.on(HLS_ENGINE_EVENTS.error, (_event, data) => {
      if (generation !== this.generation || this.destroyed) return;
      // The instance may already have been destroyed/replaced by an earlier
      // fatal failure (fail() tears it down) — late events from a destroyed
      // instance must not re-trigger recovery or surface a second error.
      if (this.instance !== instance) return;
      this.handleHlsError(data, callbacks);
    });
    // Phase 6: internal quality levels. The manifest-parsed event carries
    // the level list; the level-switched event confirms each completed
    // switch. Both are generation- AND instance-guarded like every other
    // listener, so a stale manifest/switch can never reach the current
    // video element or callbacks. AUTO stays untouched here — the engine
    // never writes a level unless the user explicitly selects one.
    instance.on(HLS_ENGINE_EVENTS.manifestParsed, () => {
      if (generation !== this.generation || this.destroyed) return;
      if (this.instance !== instance) return;
      callbacks.onQualityLevels?.(this.getQualityLevels());
    });
    instance.on(HLS_ENGINE_EVENTS.levelSwitched, () => {
      if (generation !== this.generation || this.destroyed) return;
      if (this.instance !== instance) return;
      callbacks.onQualitySelection?.(this.getQualitySelection() ?? PLAYER_AUTO_QUALITY_ID, this.getQualityLevels());
    });

    instance.attachMedia(video);
    instance.loadSource(url);
  }

  /**
   * Tear the engine down completely (component unmount / switch to native
   * playback). After `destroy()` the engine is inert: no stale event
   * or in-flight loader continuation can touch the video element. Video.js
   * owns the hls.js instance and destroys it through the adapter.
   */
  destroy(): void {
    this.destroyed = true;
    this.generation += 1;
    this.destroyInstance();
    this.active = false;
  }

  /** Destroy only the active instance (used before a new attach). */
  private destroyInstance(): void {
    const instance = this.instance;
    this.instance = null;
    if (!instance) return;
    try {
      instance.destroy();
    } catch {
      // destroy must never throw — internals may already be torn down.
    }
  }

  /**
   * Fatal/non-fatal classification with bounded recovery:
   *   fatal networkError → `startLoad()` retry, max HLS_RECOVERY_LIMITS.network
   *   fatal mediaError   → `recoverMediaError()`, max HLS_RECOVERY_LIMITS.media
   *   any other fatal    → immediate failure
   * Non-fatal errors are left to the engine's internal handling.
   */
  private handleHlsError(data: HlsEventData | undefined, callbacks: HlsEngineCallbacks): void {
    if (!data?.fatal) return; // non-fatal — the engine recovers internally
    if (data.type === 'networkError' && this.networkRecoveries < HLS_RECOVERY_LIMITS.network) {
      this.networkRecoveries += 1;
      try {
        this.instance?.startLoad();
        return;
      } catch {
        // fall through to failure below
      }
    } else if (data.type === 'mediaError' && this.mediaRecoveries < HLS_RECOVERY_LIMITS.media) {
      this.mediaRecoveries += 1;
      try {
        this.instance?.recoverMediaError();
        return;
      } catch {
        // fall through to failure below
      }
    }
    this.fail(callbacks, HLS_UNRECOVERABLE_MESSAGE);
  }

  /** Stop all recovery, destroy the instance and surface a generic error. */
  private fail(callbacks: HlsEngineCallbacks, message: string): void {
    this.destroyInstance();
    this.active = false;
    callbacks.onState?.('error');
    callbacks.onFatalError?.(message);
  }
}
