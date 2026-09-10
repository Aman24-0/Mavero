import type { PlayerSource } from '$lib/shared/player';

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
 */

/** Minimal structural shape of the hls.js instance the engine needs. */
export type HlsLike = {
  loadSource(url: string): void;
  attachMedia(media: HTMLMediaElement): void;
  destroy(): void;
  startLoad(startPosition?: number): void;
  stopLoad(): void;
  recoverMediaError(): void;
  on(event: string, listener: (event: string, data?: HlsEventData) => void): void;
  off(event: string, listener: (event: string, data?: HlsEventData) => void): void;
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
  levelLoaded: 'hlsLevelLoaded',
  error: 'hlsError',
} as const;

export const HLS_UNRECOVERABLE_MESSAGE = 'This stream could not be played. Try another source.';
export const HLS_UNSUPPORTED_MESSAGE = 'HLS playback is not supported in this browser. Try another source.';

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
