import { PLAYER_AUTO_QUALITY_ID, type PlayerInternalQualityOption, type PlayerSource } from '$lib/shared/player';

/**
 * HLS playback engine — Phase 5.
 *
 * A SMALL adapter around hls.js for the EXISTING direct `<video>` path.
 * This is NOT a new player: PlayerShell, PlayerViewport, the
 * PlaybackManager, the DirectPlayerAdapter, progress/resume, quality
 * switching, fullscreen, PiP, Media Session and Wake Lock are untouched.
 * The engine only owns the hls.js instance lifecycle for HLS sources that
 * the browser cannot play natively:
 *
 *   PlaybackManager → PlayerShell → PlayerViewport
 *     → direct MP4 / native HLS  → existing `<video src>` path (unchanged)
 *     → non-native HLS           → THIS engine → hls.js → same `<video>`
 *
 * SSR BOUNDARY (spec §2/§30):
 *   * This module is CLIENT-ONLY. It contains no top-level browser globals
 *     and no top-level side effects, so importing it during SSR is safe.
 *   * hls.js is loaded exclusively through a dynamic ESM import inside
 *     `defaultHlsModuleLoader()` — it can never execute during SvelteKit
 *     SSR, server routes or server resolver code. No server module imports
 *     this file.
 *
 * OWNERSHIP (spec §7):
 *   PlayerViewport (the component that owns the `<video>` element) is the
 *   single owner of the engine. There is exactly ONE engine instance and
 *   therefore at most ONE live hls.js instance per video element at any
 *   time. The PlaybackManager and PlayerShell never see hls.js APIs.
 *
 * RACE PROTECTION (spec §8):
 *   Every `attach()` bumps an internal generation token. A slow
 *   initialization for source A is invalidated when the source switches to
 *   B (destroy/attach), and stale loader continuations or stale hls.js
 *   events can never reach the current video element or callbacks.
 *
 * ERROR HANDLING (spec §10):
 *   Bounded recovery only — fatal network errors get a small number of
 *   `startLoad()` retries, fatal media errors get one `recoverMediaError()`
 *   attempt; anything beyond that (and every other fatal type) destroys the
 *   instance and surfaces a generic player error. No infinite retry loops.
 *
 * SECURITY (spec §24–§27):
 *   No proxying, no URL rewriting, no custom loader hooks (no request-header
 *   injection of any kind), no DRM/EME code. hls.js runs with its DEFAULT
 *   configuration — nothing is overridden in Phase 5 (no concrete Mavero
 *   requirement identified), so manifest/segment/key requests are plain
 *   browser requests subject to normal CORS.
 *
 * PHASE 6: the engine additionally exposes a MINIMAL, generic internal
 * quality-level API (`getQualityLevels/getQualityOptions`,
 * `getQualitySelection`, `setAutoQualityLevel`, `setQualityLevel`) so the
 * existing quality UI can offer AUTO + manifest levels for engine-driven
 * HLS. The API is hls.js-free (`PlayerInternalQualityOption` + the
 * reserved AUTO id only), switches levels SEAMLESSLY via `nextLevel`
 * (never recreating the engine), defaults to AUTO (no level is forced),
 * and falls back to AUTO on a failed switch request instead of destroying
 * the instance.
 */

/** Minimal structural shape of one hls.js quality level (Phase 6). */
export type HlsLevelLike = {
  height?: number;
  bitrate?: number;
};

/**
 * Minimal structural shape of the hls.js instance the engine needs.
 *
 * Phase 6 adds the internal quality-level surface as OPTIONAL members
 * (`levels`, `autoLevelEnabled`, `currentLevel`, `nextLevel`): every real
 * hls.js 1.7.2 instance has them (verified against its typings), while
 * existing test doubles of the narrower Phase 5 interface keep compiling
 * and the engine degrades to "no quality UI" when they are absent.
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
};

/** Subset of the hls.js error payload the engine inspects. */
export type HlsEventData = {
  fatal?: boolean;
  type?: string;
  details?: string;
};

/** Factory that constructs an hls.js instance (injectable for tests). */
export type HlsFactory = (config?: Record<string, unknown>) => HlsLike;

/**
 * Loads the hls.js ES module and adapts it to an `HlsFactory`. Returns
 * `null` when the module cannot be loaded (e.g. very old browser) — the
 * caller surfaces an unsupported-media error instead of crashing.
 *
 * CLIENT-ONLY: called exclusively from browser code paths (PlayerViewport
 * wiring). The dynamic import is cached by the browser module system, and
 * the resolved factory is memoized here to avoid repeated module lookups.
 */
export type HlsModuleLoader = () => Promise<HlsFactory | null>;

export async function defaultHlsModuleLoader(): Promise<HlsFactory | null> {
  try {
    const mod = (await import('hls.js')) as unknown as { default?: unknown } & Record<string, unknown>;
    const ctor = typeof mod === 'function' ? mod : mod.default;
    if (typeof ctor !== 'function') return null;
    const Hls = ctor as new (config?: Record<string, unknown>) => HlsLike;
    return (config?: Record<string, unknown>) => new Hls(config);
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
 * standard `canPlayType` probe for the HLS mime types. hls.js must NOT be
 * loaded when native playback works.
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
 *   - HLS + no native support → 'hls-js'  (this engine takes over the `<video>`)
 */
export function resolveDirectPlaybackMode(source: PlayerSource | null, url: string, video: Pick<HTMLMediaElement, 'canPlayType'>): DirectPlaybackMode {
  if (!isHlsMediaSource(source, url)) return 'native';
  return supportsNativeHls(video) ? 'native' : 'hls-js';
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

/** Generic (hls.js-agnostic) engine states exposed to the viewport. */
export type HlsEngineState = 'loading' | 'manifest-loaded' | 'attached' | 'error';

export type HlsEngineCallbacks = {
  /** Generic state transitions — never hls.js event names. */
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
   * Phase 6: the internal quality MODE/level changed (hls.js level switch
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

/** hls.js event names the engine listens to (subset, purposeful only). */
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
 * labels from hls.js objects itself.
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

  /** True while an hls.js instance is attached (or initializing) for a source. */
  isActive(): boolean {
    return this.active;
  }

  /** Test/inspection hook: the live hls.js instance, if any. */
  getInstance(): HlsLike | null {
    return this.instance;
  }

  // ----- Phase 6: internal quality levels (generic, hls.js-free surface) -----
  //
  // The UI (PlayerShell / PlayerControls) only ever sees
  // `PlayerInternalQualityOption` lists + the reserved AUTO id — never
  // `Hls.Level`, `Hls.Events` or any other hls.js type (spec §31). When the
  // instance predates the quality surface (Phase 5 test doubles) or no
  // instance is live, the getters degrade gracefully to empty/AUTO.

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

  /**
   * Attach the engine to a video element and start loading `url` through
   * hls.js. Safe to call repeatedly for source switches: the previous
   * instance is always destroyed first, so exactly ONE hls.js instance is
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

    // hls.js runs with its DEFAULT configuration — no Mavero-specific
    // overrides were identified for Phase 5 (spec §5).
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
   * playback). After `destroy()` the engine is inert: no stale hls.js event
   * or in-flight loader continuation can touch the video element.
   */
  destroy(): void {
    this.destroyed = true;
    this.generation += 1;
    this.destroyInstance();
    this.active = false;
  }

  /** Destroy only the hls.js instance (used before a new attach). */
  private destroyInstance(): void {
    const instance = this.instance;
    this.instance = null;
    if (!instance) return;
    try {
      instance.destroy();
    } catch {
      // destroy must never throw — hls.js internals may already be torn down.
    }
  }

  /**
   * Fatal/non-fatal classification with bounded recovery:
   *   fatal networkError → `startLoad()` retry, max HLS_RECOVERY_LIMITS.network
   *   fatal mediaError   → `recoverMediaError()`, max HLS_RECOVERY_LIMITS.media
   *   any other fatal    → immediate failure
   * Non-fatal errors are left to hls.js' internal handling.
   */
  private handleHlsError(data: HlsEventData | undefined, callbacks: HlsEngineCallbacks): void {
    if (!data?.fatal) return; // non-fatal — hls.js recovers internally
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
