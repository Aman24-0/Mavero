/**
 * Player UI V2 (Part 2, Phase 4) — Google Cast (Web Sender) controller.
 *
 * Adds a native-feeling Cast action for COMPATIBLE direct-media sources.
 * Everything here follows the official Web Sender docs (read 2026-10-12,
 * developers.google.com/cast/docs/web_sender + /integrate + /media):
 *
 *   * The SDK is the Cast Application Framework (CAF) Web Sender, loaded
 *     lazily from `https://www.gstatic.com/cv/js/sender/v1/cast_sender.js?loadCastFramework=1`
 *     (the ONLY documented load path — never bundled, never npm-copied).
 *     Availability is announced by `window.__onGCastApiAvailable`.
 *   * Init: `cast.framework.CastContext.getInstance().setOptions({ receiverApplicationId })`
 *     using the DEFAULT_MEDIA_RECEIVER_APP_ID (no custom receiver, no
 *     registered app id, no secrets).
 *   * Sessions: `context.requestSession()` (device picker), `session.loadMedia(new LoadRequest(mediaInfo))`
 *     with `LoadRequest.currentTime` for position transfer, and the
 *     `RemotePlayer`/`RemotePlayerController` pair for remote state and
 *     play/pause/seek control.
 *
 * ELIGIBILITY (never claim compatibility without passing every gate):
 *   1. The active source is a DIRECT source with a Mavero-accessible URL —
 *      embed/iframe sources are structurally excluded (Mavero has no media
 *      URL to hand the receiver).
 *   2. The stream needs no request headers — a source bound to a Referer/
 *      Origin header can never play on a receiver (the receiver cannot send
 *      them) → ineligible.
 *   3. The media format is one the DEFAULT receiver supports (verified
 *      against docs/media: HLS + progressive MP4/WebM/MP2T; DRM is custom-
 *      receiver territory) — derived from the source protocol metadata and
 *      the URL extension. Unknown formats are ineligible, never guessed.
 *   4. The URL has not expired (same expiry semantics as sourceIsExpired).
 *   5. A browser CORS probe of the actual media URL succeeds — the receiver
 *      fetches the media ITSELF from a different origin, and adaptive
 *      streaming REQUIRES CORS per the docs. A failed/opaque probe means we
 *      cannot claim receiver accessibility → the Cast action stays hidden.
 *      (The probe is a lightweight HEAD with a 1-byte Range GET fallback —
 *      it never streams the media through Mavero.)
 *
 * CLEANLINESS: single lazy SDK load per page (module-level singleton with a
 * bounded timeout), single CastContext init, listeners registered once and
 * removed on destroy, no duplicate local+remote playback (the shell pauses
 * local playback before a session starts), bounded probe cache with TTL.
 *
 * HONESTY BOUNDARIES (documented in the final report):
 *   * Receiver-side playback was NOT verified against physical Cast
 *     hardware in this environment — all receiver interaction paths are
 *     unit-tested with a mocked SDK only.
 *   * Position transfer is best-effort via LoadRequest.currentTime (the
 *     documented mechanism); full continuous local↔remote sync is NOT
 *     claimed or implemented.
 *   * Receiver volume is controlled by the platform cast dialog; the shell's
 *     local volume UI intentionally does not pretend to control it.
 */

// ---------------------------------------------------------------------------
// Minimal structural types for the CAF surface this module touches. The real
// SDK is runtime-loaded from gstatic (no npm artifact exists in this repo),
// so these declarations keep the module type-safe WITHOUT inventing APIs —
// every member below mirrors the official reference (cast.framework docs).
// ---------------------------------------------------------------------------

export type CastMediaState = {
  currentTime: number;
  duration: number;
  playing: boolean;
  playerState: string;
  /** Display name of the connected receiver (e.g. "Living Room TV"). */
  deviceName: string;
};

export type CastControllerState = {
  /** SDK lifecycle: loading → available | unavailable (final for the page). */
  sdk: 'loading' | 'available' | 'unavailable';
  /** Session lifecycle derived from CastContext session/cast state events. */
  connection: 'disconnected' | 'connecting' | 'connected' | 'error';
  /** Mirrored remote media state (only meaningful while connected). */
  media: CastMediaState | null;
};

type CastSessionLike = {
  getSessionId?: () => string | null;
  getCastDevice?: () => { friendlyName?: string } | null;
  loadMedia: (request: unknown) => Promise<void>;
  getMediaSession?: () => { stop?: () => void } | null;
  endSession?: (stopCasting?: boolean) => void;
};

type CastContextLike = {
  setOptions: (options: Record<string, unknown>) => void;
  addEventListener: (type: string, handler: (event: { sessionState?: string; castState?: string; errorCode?: string }) => void) => void;
  removeEventListener: (type: string, handler: (event: { sessionState?: string; castState?: string; errorCode?: string }) => void) => void;
  requestSession: () => Promise<void>;
  getCurrentSession: () => CastSessionLike | null;
  endCurrentSession: (stopCasting?: boolean) => void;
};

type RemotePlayerLike = {
  currentTime: number;
  duration: number;
  isPaused: boolean;
  playerState: string;
  isConnected: boolean;
  canSeek: boolean;
  title?: string | null;
};

type RemotePlayerControllerLike = {
  addEventListener: (type: string, handler: (event: unknown) => void) => void;
  removeEventListener: (type: string, handler: (event: unknown) => void) => void;
  playOrPause: () => void;
  seek: () => void;
  stop: () => void;
};

type CastFrameworkLike = {
  CastContext: {
    getInstance: () => CastContextLike;
    CastStateEventType: Record<string, string>;
    SessionStateEventType: Record<string, string>;
    CastState: Record<string, string>;
    SessionState: Record<string, string>;
  };
  RemotePlayer: new () => RemotePlayerLike;
  RemotePlayerController: new (player: RemotePlayerLike) => RemotePlayerControllerLike;
};

type ChromeCastMediaLike = {
  MediaInfo: new (contentId: string, contentType?: string) => Record<string, unknown>;
  LoadRequest: new (mediaInfo: unknown) => Record<string, unknown>;
  DEFAULT_MEDIA_RECEIVER_APP_ID: string;
};

type CastGlobals = {
  cast?: { framework?: CastFrameworkLike };
  chrome?: { cast?: { media?: ChromeCastMediaLike } } & Record<string, unknown>;
  __onGCastApiAvailable?: ((available: boolean) => void) | null;
};

function castGlobals(): CastGlobals {
  return globalThis as unknown as CastGlobals;
}

// ---------------------------------------------------------------------------
// Eligibility — pure, fully unit-tested, NO browser APIs.
// ---------------------------------------------------------------------------

export type CastContentType = 'application/x-mpegurl' | 'application/dash+xml' | 'video/mp4' | 'video/webm';

export type CastEligibility =
  | { eligible: true; url: string; contentType: CastContentType }
  | { eligible: false; reason: 'no-source' | 'embed' | 'no-url' | 'header-bound' | 'unknown-format' | 'expired' };

/**
 * Static eligibility of a PlayerSource for the DEFAULT media receiver.
 * Derives the receiver contentType from the KNOWN protocol metadata or the
 * URL extension — never guesses beyond that (unknown → ineligible).
 */
export function evaluateCastEligibility(
  source: {
    type: string;
    url: string | null;
    headers?: { referer?: string; origin?: string };
    expiresAt?: string;
    metadata?: { protocol?: string };
  } | null,
  now = Date.now(),
): CastEligibility {
  if (!source) return { eligible: false, reason: 'no-source' };
  if (source.type !== 'direct') return { eligible: false, reason: 'embed' };
  if (!source.url) return { eligible: false, reason: 'no-url' };
  // A source whose playback depends on Referer/Origin headers can never be
  // played by a receiver (it cannot send them) — do not offer Cast.
  if (source.headers?.referer || source.headers?.origin) return { eligible: false, reason: 'header-bound' };
  if (source.expiresAt) {
    const timestamp = Date.parse(source.expiresAt);
    if (Number.isFinite(timestamp) && timestamp <= now) return { eligible: false, reason: 'expired' };
  }
  const contentType = castContentTypeFor(source.metadata?.protocol, source.url);
  if (!contentType) return { eligible: false, reason: 'unknown-format' };
  return { eligible: true, url: source.url, contentType };
}

/** Receiver media type for a KNOWN protocol or a concrete file extension. */
function castContentTypeFor(protocol: string | undefined, url: string): CastContentType | null {
  const cleanUrl = url.split('?')[0].toLowerCase();
  if (protocol === 'hls' || cleanUrl.endsWith('.m3u8')) return 'application/x-mpegurl';
  if (protocol === 'dash' || cleanUrl.endsWith('.mpd')) return 'application/dash+xml';
  if (protocol === 'mp4' || cleanUrl.endsWith('.mp4') || cleanUrl.endsWith('.m4v')) return 'video/mp4';
  if (cleanUrl.endsWith('.webm')) return 'video/webm';
  // A 'file' protocol only casts when the extension identifies the container
  // (handled above); anything else (unknown protocol, unrecognized
  // extension) is ineligible — we do not claim receiver compatibility for
  // formats we cannot identify.
  return null;
}

// ---------------------------------------------------------------------------
// CORS probe — verifies the actual media URL is cross-origin accessible.
// ---------------------------------------------------------------------------

const PROBE_TIMEOUT_MS = 6_000;
const PROBE_CACHE_MAX = 32;
const PROBE_CACHE_TTL_MS = 5 * 60 * 1000;

type ProbeCacheEntry = { ok: boolean; expiresAt: number };
const probeCache = new Map<string, ProbeCacheEntry>();
const probeInFlight = new Map<string, Promise<boolean>>();

/** Test seam: clear the probe cache. */
export function clearCastProbeCacheForTests(): void {
  probeCache.clear();
  probeInFlight.clear();
}

/**
 * Resolves true ONLY when the media URL is fetchable in CORS mode (the
 * receiver's requirement). Tries HEAD first, falls back to a 1-byte Range
 * GET (some media servers reject HEAD). Never fetches with credentials and
 * never proxies the media.
 */
export function probeMediaCastability(mediaUrl: string, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  const cached = probeCache.get(mediaUrl);
  if (cached && cached.expiresAt > Date.now()) return Promise.resolve(cached.ok);
  if (cached) probeCache.delete(mediaUrl);
  const pending = probeInFlight.get(mediaUrl);
  if (pending) return pending;

  const probe = (async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    try {
      const attempt = async (method: 'HEAD' | 'GET'): Promise<boolean> => {
        const response = await fetchImpl(mediaUrl, {
          method,
          mode: 'cors',
          credentials: 'omit',
          cache: 'no-store',
          signal: controller.signal,
          ...(method === 'GET' ? { headers: { range: 'bytes=0-0' } } : {}),
        });
        // A CORS-mode fetch that resolves already proves ACAO permitted the
        // origin; any resolved response (even 403/405) still proves the
        // response is CORS-readable, which is what the receiver needs.
        return response.type !== 'opaque';
      };
      if (await attempt('HEAD').catch(() => false)) return true;
      return await attempt('GET').catch(() => false);
    } catch {
      return false;
    } finally {
      clearTimeout(timeout);
      probeInFlight.delete(mediaUrl);
    }
  })();

  probeInFlight.set(mediaUrl, probe);
  void probe.then((ok) => {
    if (probeCache.size >= PROBE_CACHE_MAX) {
      const oldest = probeCache.keys().next().value;
      if (oldest !== undefined) probeCache.delete(oldest);
    }
    probeCache.set(mediaUrl, { ok, expiresAt: Date.now() + PROBE_CACHE_TTL_MS });
  });
  return probe;
}

// ---------------------------------------------------------------------------
// SDK loading — lazy, once per page, bounded.
// ---------------------------------------------------------------------------

const SDK_URL = 'https://www.gstatic.com/cv/js/sender/v1/cast_sender.js?loadCastFramework=1';
const SDK_LOAD_TIMEOUT_MS = 15_000;

export type CastScriptLoader = (src: string, onAvailable: (ok: boolean) => void) => void;

/** Default loader: __onGCastApiAvailable + script injection (per official docs). */
const defaultScriptLoader: CastScriptLoader = (src, onAvailable) => {
  const globals = castGlobals();
  if (globals.cast?.framework && globals.chrome?.cast?.media) {
    onAvailable(true);
    return;
  }
  globals.__onGCastApiAvailable = (available) => onAvailable(Boolean(available));
  const script = document.createElement('script');
  script.src = src;
  script.async = true;
  script.onerror = () => onAvailable(false);
  document.head.appendChild(script);
};

let sdkPromise: Promise<boolean> | null = null;

/**
 * Loads the CAF Web Sender SDK once per page. Resolves false when the SDK
 * is unavailable (non-supporting browser, blocked script, timeout) — the
 * caller then never renders the Cast action. The negative result is FINAL
 * for the page lifetime (the SDK does not appear late).
 */
export function loadCastSdk(loader: CastScriptLoader = defaultScriptLoader): Promise<boolean> {
  if (sdkPromise) return sdkPromise;
  sdkPromise = new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    try {
      loader(SDK_URL, (available) => {
        if (!available) return finish(false);
        const globals = castGlobals();
        finish(Boolean(globals.cast?.framework && globals.chrome?.cast?.media));
      });
    } catch {
      finish(false);
    }
    setTimeout(() => finish(false), SDK_LOAD_TIMEOUT_MS);
  });
  return sdkPromise;
}

/** Test seam: reset the module-level SDK singleton. */
export function resetCastSdkForTests(): void {
  sdkPromise = null;
}

// ---------------------------------------------------------------------------
// Controller — session lifecycle + remote state mirroring.
// ---------------------------------------------------------------------------

export type CastControllerOptions = {
  /** Called on every controller-state change (SDK, connection, media). */
  onStateChange: (state: CastControllerState) => void;
  /** Injected script loader (tests). */
  scriptLoader?: CastScriptLoader;
};

export type CastStartRequest = {
  url: string;
  contentType: string;
  title: string;
  /** Local playback position to transfer (seconds). */
  currentTime: number;
};

export type CastController = {
  /** Loads the SDK and initializes the CastContext (idempotent). */
  initialize: () => Promise<boolean>;
  /** Opens the device picker and loads the media on success. */
  requestCast: (request: CastStartRequest) => Promise<void>;
  /** True while a session is connected. */
  isConnected: () => boolean;
  /** Remote play/pause (RemotePlayerController.playOrPause). */
  toggleRemotePlay: () => void;
  /** Remote seek (RemotePlayer.currentTime + RemotePlayerController.seek). */
  remoteSeek: (time: number) => void;
  /** Stops the remote media and ends the session. */
  stopCasting: () => void;
  /** Removes listeners; the receiver session itself is left running. */
  destroy: () => void;
};

export function createCastController(options: CastControllerOptions): CastController {
  const { onStateChange } = options;
  const scriptLoader = options.scriptLoader ?? defaultScriptLoader;

  let state: CastControllerState = { sdk: 'loading', connection: 'disconnected', media: null };
  let context: CastContextLike | null = null;
  let remotePlayer: RemotePlayerLike | null = null;
  let remoteController: RemotePlayerControllerLike | null = null;
  let sessionListener: ((event: { sessionState?: string }) => void) | null = null;
  let remoteListener: ((event: unknown) => void) | null = null;
  let destroyed = false;

  function emit() {
    if (!destroyed) onStateChange({ ...state, media: state.media ? { ...state.media } : null });
  }

  function setPartial(partial: Partial<CastControllerState>) {
    state = { ...state, ...partial };
    emit();
  }

  function readRemoteMedia(deviceName: string): CastMediaState | null {
    if (!remotePlayer) return null;
    return {
      currentTime: Number.isFinite(remotePlayer.currentTime) ? remotePlayer.currentTime : 0,
      duration: Number.isFinite(remotePlayer.duration) ? remotePlayer.duration : 0,
      playing: !remotePlayer.isPaused && remotePlayer.playerState !== 'IDLE',
      playerState: String(remotePlayer.playerState ?? ''),
      deviceName,
    };
  }

  function handleSessionEvent(event: { sessionState?: string }) {
    if (destroyed) return;
    const states = castGlobals().cast?.framework?.CastContext.SessionState ?? {};
    switch (event.sessionState) {
      case states.SESSION_STARTING:
        setPartial({ connection: 'connecting' });
        break;
      case states.SESSION_STARTED:
      case states.SESSION_RESUMED: {
        const session = context?.getCurrentSession?.() ?? null;
        const deviceName = session?.getCastDevice?.()?.friendlyName ?? '';
        attachRemotePlayer(deviceName);
        setPartial({ connection: 'connected', media: readRemoteMedia(deviceName) });
        break;
      }
      case states.SESSION_START_FAILED:
        setPartial({ connection: 'error', media: null });
        break;
      case states.SESSION_ENDED:
      case states.SESSION_ENDING:
        detachRemotePlayer();
        setPartial({ connection: 'disconnected', media: null });
        break;
      default:
        break;
    }
  }

  function attachRemotePlayer(deviceName: string) {
    const framework = castGlobals().cast?.framework;
    if (!framework || remoteController) return; // never stack a second controller
    remotePlayer = new framework.RemotePlayer();
    remoteController = new framework.RemotePlayerController(remotePlayer);
    remoteListener = () => {
      if (destroyed) return;
      const media = readRemoteMedia(deviceName);
      if (media) setPartial({ media });
    };
    remoteController.addEventListener('ANY_CHANGE', remoteListener);
  }

  function detachRemotePlayer() {
    if (remoteController && remoteListener) {
      try { remoteController.removeEventListener('ANY_CHANGE', remoteListener); } catch { /* already detached */ }
    }
    remoteController = null;
    remotePlayer = null;
    remoteListener = null;
  }

  async function initialize(): Promise<boolean> {
    if (destroyed) return false;
    if (state.sdk === 'available' && context) return true;
    const available = await loadCastSdk(scriptLoader);
    if (destroyed) return false;
    const globals = castGlobals();
    const framework = globals.cast?.framework;
    const mediaNs = globals.chrome?.cast?.media;
    if (!available || !framework || !mediaNs) {
      setPartial({ sdk: 'unavailable' });
      return false;
    }
    context = framework.CastContext.getInstance();
    context.setOptions({
      receiverApplicationId: mediaNs.DEFAULT_MEDIA_RECEIVER_APP_ID,
      autoJoinPolicy: 'origin_scoped',
      language: 'en-US',
    });
    // Register ONCE; initialize() is idempotent and never stacks listeners.
    if (!sessionListener) {
      sessionListener = (event) => handleSessionEvent(event);
      context.addEventListener(framework.CastContext.SessionStateEventType?.SESSION_STATE_CHANGED ?? 'sessionstatechanged', sessionListener);
    }
    setPartial({ sdk: 'available' });
    return true;
  }

  async function requestCast(request: CastStartRequest): Promise<void> {
    if (destroyed || !context) throw new Error('cast-not-initialized');
    setPartial({ connection: 'connecting' });
    try {
      await context.requestSession();
    } catch (error) {
      // requestSession rejects when the user cancels the picker or no
      // device is available — surface a typed failure, restore idle state.
      if (state.connection === 'connecting') setPartial({ connection: 'disconnected' });
      throw error;
    }
    const session = context.getCurrentSession?.();
    if (!session) {
      if (state.connection === 'connecting') setPartial({ connection: 'disconnected' });
      throw new Error('cast-no-session');
    }
    const mediaNs = castGlobals().chrome?.cast?.media;
    if (!mediaNs) {
      if (state.connection === 'connecting') setPartial({ connection: 'disconnected' });
      throw new Error('cast-media-namespace-missing');
    }
    const mediaInfo = new mediaNs.MediaInfo(request.url, request.contentType);
    if (request.title) (mediaInfo as Record<string, unknown>).metadata = { metadataType: 0, title: request.title };
    const loadRequest = new mediaNs.LoadRequest(mediaInfo);
    // Position transfer (documented LoadRequest.currentTime contract).
    if (Number.isFinite(request.currentTime) && request.currentTime > 0) (loadRequest as Record<string, unknown>).currentTime = request.currentTime;
    (loadRequest as Record<string, unknown>).autoplay = true;
    try {
      await session.loadMedia(loadRequest);
    } catch (error) {
      if (state.connection === 'connecting') setPartial({ connection: 'disconnected' });
      throw error;
    }
  }

  function toggleRemotePlay() {
    if (remoteController) remoteController.playOrPause();
  }

  function remoteSeek(time: number) {
    if (!remotePlayer || !remoteController || !Number.isFinite(time)) return;
    remotePlayer.currentTime = Math.max(0, time);
    remoteController.seek();
  }

  function stopCasting() {
    const session = context?.getCurrentSession?.() ?? null;
    try { session?.getMediaSession?.()?.stop?.(); } catch { /* receiver already idle */ }
    try { context?.endCurrentSession(true); } catch { /* already ended */ }
    detachRemotePlayer();
    setPartial({ connection: 'disconnected', media: null });
  }

  function destroy() {
    destroyed = true;
    detachRemotePlayer();
    if (context && sessionListener) {
      const framework = castGlobals().cast?.framework;
      if (framework) {
        try { context.removeEventListener(framework.CastContext.SessionStateEventType?.SESSION_STATE_CHANGED ?? 'sessionstatechanged', sessionListener); } catch { /* already removed */ }
      }
    }
    sessionListener = null;
    context = null;
  }

  return { initialize, requestCast, isConnected: () => state.connection === 'connected', toggleRemotePlay, remoteSeek, stopCasting, destroy };
}
