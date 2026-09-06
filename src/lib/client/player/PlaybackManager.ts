import type { PlayerSource, PlayerPlaybackState } from '$lib/shared/player';
import { isEmbedOriginAllowed, isPlayablePlayerSource, sourceIsExpired } from '$lib/shared/player-guards';
import type { ProviderPlaybackCapabilities } from './capabilities';
import { EMBED_PLAYBACK_CAPABILITIES } from './capabilities';
import { PlayerAdapterRegistry, createDefaultAdapterRegistry } from './adapter-registry';
import type { AdapterLoadContext, CommandResult, PlayerEvent, PlayerEventHandler, PlayerProviderAdapter } from './events';

/**
 * PlaybackManager — Phase 1.
 *
 * The single authoritative owner of playback session state. Coordinates:
 *   - source lifecycle (resolve → prepare → ready → playing → ended/error → destroy)
 *   - source switching (capture state → destroy old session → load new → ready)
 *   - adapter lifecycle (pick adapter, load, register handler, destroy on switch)
 *   - normalized playback events (translate adapter events into state)
 *   - resolver invocation boundary (POST /api/playback/resolve via fetch)
 *   - progress integration boundary (exposes normalized events for the
 *     watch route's ProgressWriter — the writer itself is NOT moved into
 *     the manager in Phase 1; that is a Phase 4 concern)
 *
 * REACTIVE STATE MODEL:
 *   The class is a plain `.ts` module (NOT `.svelte.ts`) so it can be
 *   imported and unit-tested in tsx scripts without the Svelte compiler.
 *   PlayerShell consumes it via a Svelte 5 `$state`-wrapped snapshot
 *   that it keeps in sync by subscribing via `subscribe()`.
 *
 * RACE-CONDITION PROTECTION:
 *   - `sessionId` — incremented on every `loadSource()` call. Late events
 *     from a prior session are dropped by checking
 *     `event.sessionId === this.sessionId`.
 *   - `active` — flipped to `false` by `dispose()`. All public methods
 *     short-circuit when `!active`.
 *   - `abortController` — aborts the in-flight `/api/playback/resolve`
 *     fetch when a new load is initiated or the manager is disposed.
 *
 * PHASE 1 SCOPE — what the manager does NOT do:
 *   - It does NOT implement the new Phase 2 default-provider or
 *     automatic-fallback policy. The watch route still selects the
 *     initial source by `sourceOptions[0].id` (admin ordering). The
 *     manager invokes `/api/playback/resolve` with `enableFallback`
 *     controlled by the watch route — exactly as Phase 0.
 *   - It does NOT register postMessage listeners. The Viduki V1→V2
 *     listener remains in the watch route for Phase 1.
 *   - It does NOT own the ProgressWriter. The watch route's existing
 *     `writer.update()`/`flush()` calls are preserved. The manager only
 *     exposes normalized events/state that the watch route can subscribe
 *     to via `subscribe()`.
 *   - It does NOT issue commands to the adapter (play/pause/seek). The
 *     adapter contract is Phase 1-minimal (load/destroy/onEvent). Phase 3
 *     will add commands.
 *
 * PHASE 1 BACKWARDS-COMPAT PATH:
 *   PlayerShell accepts an optional `manager` prop. When present,
 *   PlayerShell reads `manager.getState()` for the playback state snapshot
 *   and delegates lifecycle events to the manager. When absent,
 *   PlayerShell behaves exactly as Phase 0 (existing legacy call sites
 *   that don't construct a manager keep working).
 */
export type PlaybackManagerState = {
  /** The currently-resolved source, or null while resolving/idle/errored. */
  source: PlayerSource | null;
  /** The current playback state — derived from adapter events + load state. */
  state: PlayerPlaybackState;
  /** True while a resolution request is in flight. */
  resolving: boolean;
  /** Current playback position in seconds (direct sources only; embeds report 0). */
  currentTime: number;
  /** Total duration in seconds (direct sources only; embeds report 0). */
  duration: number;
  /** Buffered-ahead in seconds (direct sources only). */
  buffered: number;
  /** True while the underlying media is playing. */
  playing: boolean;
  /** True while the underlying media is buffering. */
  buffering: boolean;
  /** Pending seek target applied on the next `ready` event (direct sources). */
  pendingSeek: number;
  /** Human-readable error message; empty when no error. */
  errorMessage: string;
  /** Resolver error code (e.g. 'UNSUPPORTED_MEDIA_TYPE'); empty when no error. */
  errorCode: string;
  /** Resolver state — mirrors the watch route's Phase 0 resolutionState. */
  resolutionState: ResolutionState;
  /** Human-readable resolution message shown in the loading UI. */
  resolutionMessage: string;
  /** Capabilities of the active adapter for the current source. */
  capabilities: ProviderPlaybackCapabilities;
};

export type ResolutionState =
  | 'idle'
  | 'resolving'
  | 'ready'
  | 'provider-error'
  | 'unsupported'
  | 'unavailable'
  | 'network-error';

export type PlaybackManagerSnapshot = Readonly<PlaybackManagerState>;

export type PlaybackManagerOptions = {
  /** Custom adapter registry (defaults to direct + generic embed). */
  registry?: PlayerAdapterRegistry;
  /** Custom fetcher for tests; defaults to global `fetch`. */
  fetcher?: typeof fetch;
};

/**
 * Internal session book-keeping. The `id` is the race-condition guard —
 * every `loadSource()` increments `this.sessionId`; late events from a prior
 * session are dropped by comparing `session.id === this.sessionId`.
 */
type Session = {
  id: number;
  source: PlayerSource | null;
  adapter: PlayerProviderAdapter | null;
  unsubscribe: (() => void) | null;
  abortController: AbortController | null;
};

const INITIAL_STATE: PlaybackManagerState = {
  source: null,
  state: 'initial-loading',
  resolving: false,
  currentTime: 0,
  duration: 0,
  buffered: 0,
  playing: false,
  buffering: false,
  pendingSeek: 0,
  errorMessage: '',
  errorCode: '',
  resolutionState: 'idle',
  resolutionMessage: '',
  capabilities: EMBED_PLAYBACK_CAPABILITIES,
};

export class PlaybackManager {
  /** Internal mutable state. Read externally via `getState()` only. */
  private _state: PlaybackManagerState = { ...INITIAL_STATE };

  /** External state subscribers (PlayerShell + watch route). */
  private subscribers = new Set<(snapshot: PlaybackManagerSnapshot) => void>();

  /** External event subscribers (e.g. the watch route's progress writer). */
  private eventSubscribers = new Set<PlayerEventHandler>();

  /** Active session book-keeping. */
  private session: Session = {
    id: 0,
    source: null,
    adapter: null,
    unsubscribe: null,
    abortController: null,
  };

  /** Incremented on every `loadSource()`. Used as the race-condition guard. */
  private sessionId = 0;

  /** Flipped to false by `dispose()`. All public methods short-circuit when inactive. */
  private active = true;

  /** Adapter registry (defaults to direct + generic embed). */
  private registry: PlayerAdapterRegistry;

  /** Fetcher (overridable for tests). */
  private fetcher: typeof fetch;

  constructor(options: PlaybackManagerOptions = {}) {
    this.registry = options.registry ?? createDefaultAdapterRegistry();
    this.fetcher = options.fetcher ?? fetch;
  }

  // ----- Snapshot + subscription -----

  /** Readonly snapshot of the current playback state. */
  getState(): PlaybackManagerSnapshot {
    return this._state;
  }

  /** Convenience getter for the currently-resolved source (or null). */
  getSource(): PlayerSource | null {
    return this._state.source;
  }

  /** Convenience getter for `resolving`. */
  isResolving(): boolean {
    return this._state.resolving;
  }

  /** Convenience getter for the current playback state value. */
  getPlaybackState(): PlayerPlaybackState {
    return this._state.state;
  }

  /**
   * Subscribe to state snapshots. The subscriber is invoked synchronously
   * on every state change. Returns an unsubscribe function.
   *
   * PlayerShell uses this to keep its Svelte 5 `$state`-wrapped local
   * snapshot in sync with the manager.
   */
  subscribe(subscriber: (snapshot: PlaybackManagerSnapshot) => void): () => void {
    this.subscribers.add(subscriber);
    // Emit the current snapshot immediately so the subscriber initializes.
    subscriber(this._state);
    return () => {
      this.subscribers.delete(subscriber);
    };
  }

  /**
   * Subscribe to normalized playback events. Returns an unsubscribe function.
   * The watch route uses this to forward events to its ProgressWriter.
   */
  onEvent(handler: PlayerEventHandler): () => void {
    this.eventSubscribers.add(handler);
    return () => {
      this.eventSubscribers.delete(handler);
    };
  }

  // ----- Session lifecycle -----

  /**
   * Resolve and load a source. This is the ONLY entry point for source
   * resolution — the watch route calls it instead of inlining the fetch.
   *
   * Race-condition-safe: increments `sessionId` first, then captures it
   * locally. Any later invocation (or a late event from a prior session)
   * is dropped by comparing `sessionId === this.sessionId`.
   *
   * @param request  Resolver request payload.
   * @param startPosition  Optional seek target applied on `ready` (direct sources).
   * @param allowFallback  Whether the resolver may walk the fallback candidate list.
   */
  async loadSource(
    request: ResolverRequest,
    startPosition = 0,
    allowFallback = true,
  ): Promise<void> {
    if (!this.active) return;
    const sessionId = ++this.sessionId;

    // Abort any in-flight resolution.
    this.session.abortController?.abort();
    const controller = new AbortController();
    this.session.abortController = controller;

    // Phase 8: resolver timeout. If the fetch hangs, abort it after
    // RESOLVER_TIMEOUT_MS so the player leaves the `resolving` state.
    // The timeout is cleared on success, failure, or intentional abort.
    // We track `timedOut` to distinguish a timeout-abort from an intentional
    // source-switch abort — the latter should be silently dropped (the new
    // source is loading), while the former should show an error.
    const RESOLVER_TIMEOUT_MS = 15000;
    let timedOut = false;
    const timeoutId = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, RESOLVER_TIMEOUT_MS);

    // Tear down the previous session's adapter before starting a new one.
    await this.destroySession(sessionId);

    if (!this.active || sessionId !== this.sessionId) return;

    // Reset transient state for the new session.
    this.patch(sessionId, {
      resolving: true,
      source: null,
      state: 'resolving',
      currentTime: 0,
      duration: 0,
      buffered: 0,
      playing: false,
      buffering: false,
      pendingSeek: startPosition,
      errorMessage: '',
      errorCode: '',
      resolutionState: 'resolving',
      resolutionMessage: 'Resolving a safe playback source…',
      capabilities: EMBED_PLAYBACK_CAPABILITIES,
    });

    try {
      const body: Record<string, unknown> = {
        sourceId: request.sourceId,
        contentId: request.contentId,
        mediaType: request.mediaType,
        enableFallback: allowFallback,
      };
      if (request.season !== undefined) body.season = request.season;
      if (request.episode !== undefined) body.episode = request.episode;
      // Phase 2: forward the admin-configured default source id so the
      // resolver can sort it to the front of the fallback candidate list.
      // Only forwarded when allowFallback is true (manual source switches
      // pass allowFallback=false and do not want the default forced back).
      if (allowFallback && request.defaultSourceId) body.defaultSourceId = request.defaultSourceId;
      // Phase 7F (MegaPlay): forward the user-selected playback variant
      // (e.g. 'sub' or 'dub'). Adapters that do not support variants
      // ignore this field. MegaPlay's resolver adapter substitutes the
      // URL path segment based on this value.
      if (request.variant) body.variant = request.variant;
      const response = await this.fetcher('/api/playback/resolve', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const payload = (await response.json()) as { ok?: boolean; source?: unknown; error?: { code?: string; message?: string } };
      if (!this.active || sessionId !== this.sessionId) return;

      const safeSource = normalizePlayerSource(payload.source);
      if (!response.ok || !payload.ok || !safeSource) {
        const code = payload.error?.code ?? '';
        const message = payload.error?.message ?? 'This source is currently unavailable.';
        throw new ResolverError(code || 'RESOLUTION_UNAVAILABLE', message);
      }

      // Pick an adapter and load it.
      const adapter = this.registry.pickAdapter(safeSource);
      if (!adapter) {
        throw new ResolverError('RESOLUTION_UNAVAILABLE', 'No player adapter is available for this source.');
      }

      // Re-check after every await — late returns from a stale session
      // must not mutate the current state.
      if (!this.active || sessionId !== this.sessionId) return;

      this.session.source = safeSource;
      this.session.adapter = adapter;

      const capabilities = adapter.getCapabilities();
      const initialPlaybackState = stateForSource(safeSource);

      // Register the adapter event handler BEFORE calling load(), so events
      // emitted during load() reach the manager.
      this.session.unsubscribe = adapter.onEvent?.((event) => this.handleAdapterEvent(sessionId, event)) ?? null;

      const loadContext: AdapterLoadContext = {
        source: safeSource,
        videoElement: request.videoElement,
        startPosition,
      };

      // Allow sync load (returns void) or async load (returns Promise).
      await adapter.load(loadContext);

      if (!this.active || sessionId !== this.sessionId) return;

      // Phase 4: append startAt URL parameter to embed URLs when:
      //   - the adapter supports startAt (capabilities.startAt === true)
      //   - the adapter exposes a startAtParam() (e.g. 'startAt', 't', 'progress')
      //   - a resume position (startPosition) was provided and is > 0
      //   - the position is valid (finite, non-negative, < duration if known)
      // This lets embed providers that document startAt support resume
      // without Mavero needing to seek via postMessage (which most providers
      // don't support as a command).
      let resolvedSource = safeSource;
      if (startPosition > 0 && capabilities.startAt) {
        const param = adapter.startAtParam?.();
        if (param) {
          const clampedPosition = Math.floor(startPosition);
          if (clampedPosition > 0 && Number.isFinite(clampedPosition)) {
            try {
              const url = new URL(safeSource.url!);
              // Don't append if the URL already has the param (idempotency).
              if (!url.searchParams.has(param)) {
                url.searchParams.set(param, String(clampedPosition));
                resolvedSource = { ...safeSource, url: url.toString() };
              }
            } catch {
              // URL parsing failed — use the original URL without startAt.
            }
          }
        }
      }

      this.patch(sessionId, {
        source: resolvedSource,
        resolving: false,
        state: initialPlaybackState,
        resolutionState: 'ready',
        resolutionMessage: resolvedSource.type === 'direct' ? 'MAVERO direct playback is ready.' : 'Provider embed is ready inside the MAVERO shell.',
        capabilities,
      });
      // Phase 8: clear the resolver timeout on successful resolution.
      clearTimeout(timeoutId);
    } catch (error) {
      // Phase 8: clear the resolver timeout on any error path.
      clearTimeout(timeoutId);
      if (!this.active || sessionId !== this.sessionId) return;
      // Phase 8: distinguish timeout-abort from intentional source-switch abort.
      // An intentional abort (new loadSource call) silently drops the old session.
      // A timeout abort shows a user-facing error so the player isn't stuck.
      if (error instanceof DOMException && error.name === 'AbortError') {
        if (timedOut) {
          // Resolver timed out — show a user-facing error.
          this.patch(sessionId, {
            source: null,
            resolving: false,
            state: 'provider-error',
            errorCode: '',
            errorMessage: 'This source is taking too long to respond.',
            resolutionState: 'provider-error',
            resolutionMessage: 'This source is taking too long to respond.',
          });
        }
        return; // Aborted (intentional or timeout).
      }
      let resolutionState: ResolutionState;
      let playbackState: PlayerPlaybackState;
      let errorCode = '';
      let message: string;
      if (error instanceof ResolverError) {
        // Resolver returned an error payload with a known code.
        errorCode = error.code;
        message = error.message;
        resolutionState = errorCode === 'UNSUPPORTED_MEDIA_TYPE'
          ? 'unsupported'
          : errorCode === 'SOURCE_DISABLED' || errorCode === 'PROVIDER_DISABLED' || errorCode === 'SOURCE_MAINTENANCE' || errorCode === 'RESOLUTION_UNAVAILABLE'
            ? 'unavailable'
            : 'provider-error';
        playbackState = resolutionState === 'unsupported' ? 'unsupported' : resolutionState === 'unavailable' ? 'unavailable' : 'provider-error';
      } else {
        // Network-layer failure (fetch threw, server unreachable, etc.).
        // Distinguished from a resolver-returned error: this is a transport
        // issue, not a provider availability issue.
        errorCode = '';
        message = errorMessageOf(error);
        resolutionState = 'network-error';
        playbackState = 'provider-error';
      }
      this.patch(sessionId, {
        source: null,
        resolving: false,
        state: playbackState,
        errorCode,
        errorMessage: message,
        resolutionState,
        resolutionMessage: message,
      });
    } finally {
      if (sessionId === this.sessionId) {
        this.session.abortController = null;
      }
    }
  }

  /**
   * Tear down the active session. Called by:
   *   - `loadSource()` before starting a new session.
   *   - `dispose()` on route unmount.
   *
   * The adapter's `destroy()` is awaited; once it returns, no further
   * events from that adapter can reach the manager (the unsubscribe is
   * also called as a belt-and-braces measure).
   */
  async destroySession(sessionId = this.sessionId): Promise<void> {
    const session = this.session;
    if (session.id !== sessionId && sessionId !== this.sessionId) return;
    try {
      session.unsubscribe?.();
    } catch { /* unsubscribe must never throw */ }
    session.unsubscribe = null;
    try {
      await session.adapter?.destroy?.();
    } catch { /* adapter destroy must never throw */ }
    session.adapter = null;
    session.source = null;
  }

  /**
   * Reset the manager to its initial state. The watch route calls this
   * when the playbackKey changes (e.g. episode switch) so the next
   * `loadSource()` starts fresh.
   */
  reset(): void {
    if (!this.active) return;
    this.sessionId += 1; // Invalidate any in-flight session.
    void this.destroySession(this.sessionId);
    this.patch(this.sessionId, { ...INITIAL_STATE });
  }

  /**
   * Dispose the manager entirely. Called by the watch route's `onDestroy`.
   * After `dispose()`, every public method is a no-op.
   */
  dispose(): void {
    this.active = false;
    this.sessionId += 1;
    this.session.abortController?.abort();
    void this.destroySession(this.sessionId);
    this.subscribers.clear();
    this.eventSubscribers.clear();
  }

  // ----- Adapter event dispatch (forward PlayerViewport DOM events to adapter) -----

  /**
   * Forward a normalized event from PlayerViewport (DOM events on `<video>`
   * or `<iframe>`) to the active adapter. The adapter translates it to a
   * normalized PlayerEvent and calls `handleAdapterEvent()`.
   *
   * This indirection exists so Phase 3 provider-specific adapters can
   * translate provider postMessage payloads into the same normalized
   * event stream — PlayerShell and the watch route do not need to know
   * which adapter is active.
   *
   * PlayerShell calls `manager.dispatchViewportEvent({ type: 'loadedmetadata' })`
   * (or similar) on every DOM event from PlayerViewport.
   */
  dispatchViewportEvent(event: ViewportEvent): void {
    if (!this.active) return;
    const session = this.session;
    if (!session.adapter) return;

    // Translate the viewport DOM event to a normalized PlayerEvent.
    const playerEvent = translateViewportEvent(event, session.source, this._state);
    if (!playerEvent) return;

    // For the direct adapter, emit through the adapter so its handler
    // (registered via onEvent) receives it. For embed, only `load` is
    // emitted — the adapter's `emit()` method is the bridge.
    if ('emit' in session.adapter && typeof (session.adapter as { emit?: (e: PlayerEvent) => void }).emit === 'function') {
      (session.adapter as { emit: (e: PlayerEvent) => void }).emit(playerEvent);
    } else {
      // Adapters without an `emit` method (future Phase 3 adapters that
      // own their own listeners) handle the event internally — skip.
    }
  }

  // ----- Phase 3: capability-aware command forwarding -----
  //
  // The manager exposes play/pause/seek/getCurrentTime/getDuration/setVolume
  // methods that:
  //   1. Check the active adapter's capabilities via `getCapabilities()`.
  //   2. If the capability is `false`, return `{ ok: false, reason: 'unsupported' }`
  //      WITHOUT calling the adapter — the caller should NOT fake local state.
  //   3. If the capability is `true` and the adapter implements the command
  //      method, delegate to the adapter.
  //   4. If the adapter does NOT implement the command method (it's optional
  //      in the interface), return `{ ok: false, reason: 'unsupported' }`.
  //
  // Race-condition-safe: commands are no-ops if the manager is disposed or
  // no active session exists.

  /**
   * Check if the active adapter supports a given capability. Returns `false`
   * if no adapter is active or the manager is disposed.
   */
  hasCapability(capability: keyof ProviderPlaybackCapabilities): boolean {
    if (!this.active) return false;
    return Boolean(this.session.adapter?.getCapabilities()[capability]);
  }

  /**
   * Get the capabilities of the active adapter. Returns the conservative
   * EMBED_PLAYBACK_CAPABILITIES if no adapter is active.
   */
  getActiveCapabilities(): ProviderPlaybackCapabilities {
    if (!this.active || !this.session.adapter) return EMBED_PLAYBACK_CAPABILITIES;
    return this.session.adapter.getCapabilities();
  }

  async play(): Promise<CommandResult> {
    if (!this.active || !this.session.adapter) return { ok: false, reason: 'not-ready' };
    if (!this.session.adapter.getCapabilities().play) return { ok: false, reason: 'unsupported' };
    if (!this.session.adapter.play) return { ok: false, reason: 'unsupported' };
    return this.session.adapter.play();
  }

  async pause(): Promise<CommandResult> {
    if (!this.active || !this.session.adapter) return { ok: false, reason: 'not-ready' };
    if (!this.session.adapter.getCapabilities().pause) return { ok: false, reason: 'unsupported' };
    if (!this.session.adapter.pause) return { ok: false, reason: 'unsupported' };
    return this.session.adapter.pause();
  }

  async seek(seconds: number): Promise<CommandResult> {
    if (!this.active || !this.session.adapter) return { ok: false, reason: 'not-ready' };
    if (!this.session.adapter.getCapabilities().seek) return { ok: false, reason: 'unsupported' };
    if (!this.session.adapter.seek) return { ok: false, reason: 'unsupported' };
    return this.session.adapter.seek(seconds);
  }

  async getCurrentTime(): Promise<CommandResult<number>> {
    if (!this.active || !this.session.adapter) return { ok: false, reason: 'not-ready' };
    if (!this.session.adapter.getCapabilities().currentTime) return { ok: false, reason: 'unsupported' };
    if (!this.session.adapter.getCurrentTime) return { ok: false, reason: 'unsupported' };
    return this.session.adapter.getCurrentTime();
  }

  async getDuration(): Promise<CommandResult<number>> {
    if (!this.active || !this.session.adapter) return { ok: false, reason: 'not-ready' };
    if (!this.session.adapter.getCapabilities().duration) return { ok: false, reason: 'unsupported' };
    if (!this.session.adapter.getDuration) return { ok: false, reason: 'unsupported' };
    return this.session.adapter.getDuration();
  }

  async setVolume(volume: number): Promise<CommandResult> {
    if (!this.active || !this.session.adapter) return { ok: false, reason: 'not-ready' };
    if (!this.session.adapter.getCapabilities().volume) return { ok: false, reason: 'unsupported' };
    if (!this.session.adapter.setVolume) return { ok: false, reason: 'unsupported' };
    return this.session.adapter.setVolume(volume);
  }

  /**
   * Phase 3 fix: provide the iframe element reference to the active adapter.
   * Called by the watch route after the iframe renders (via PlayerShell's
   * `onIframeReady` callback). CineSrc's adapter stores the ref so its
   * `sendCommand()` can post to `iframe.contentWindow.postMessage(payload,
   * origin)` — the documented CineSrc API target.
   *
   * Race-condition-safe: only forwards to the current session's adapter.
   */
  setIframe(iframe: HTMLIFrameElement): void {
    if (!this.active) return;
    const session = this.session;
    if (!session.adapter) return;
    try { session.adapter.setIframe?.(iframe); } catch { /* adapters must never throw */ }
  }

  // ----- Internal: handle normalized adapter events -----

  /**
   * Apply a normalized PlayerEvent to the internal state. Called by the
   * adapter when it emits an event (either via its own listeners, or via
   * the `emit()` bridge from `dispatchViewportEvent()`).
   *
   * Race-condition-safe: drops the event if the session id does not match.
   */
  private handleAdapterEvent(sessionId: number, event: PlayerEvent): void {
    if (!this.active || sessionId !== this.sessionId) return;
    const current = this._state;
    const patch: Partial<PlaybackManagerState> = {};

    switch (event.type) {
      case 'load':
        // Adapter signalled its surface loaded. For direct sources this
        // is redundant with `ready`; for embeds it is the only signal.
        if (current.source?.type === 'embed' && current.state === 'embed-loading') {
          patch.state = 'playing';
          patch.errorMessage = '';
        }
        break;
      case 'ready':
        if (typeof event.duration === 'number' && Number.isFinite(event.duration)) patch.duration = event.duration;
        patch.state = 'paused';
        patch.buffering = false;
        break;
      case 'play':
        patch.playing = true;
        patch.state = 'playing';
        patch.errorMessage = '';
        break;
      case 'pause':
        patch.playing = false;
        if (current.state !== 'completed') patch.state = 'paused';
        break;
      case 'buffering':
        patch.buffering = event.value;
        if (event.value) patch.state = 'buffering';
        else if (current.state === 'buffering') patch.state = current.playing ? 'playing' : 'paused';
        break;
      case 'timeupdate':
        patch.currentTime = event.currentTime;
        if (typeof event.duration === 'number' && Number.isFinite(event.duration) && event.duration > 0) patch.duration = event.duration;
        break;
      case 'duration':
        if (Number.isFinite(event.duration) && event.duration > 0) patch.duration = event.duration;
        break;
      case 'seeking':
        patch.state = 'seeking';
        break;
      case 'seeked':
        patch.currentTime = event.currentTime;
        patch.state = current.playing ? 'playing' : 'paused';
        break;
      case 'ended':
        patch.playing = false;
        patch.state = 'completed';
        break;
      case 'error':
        patch.playing = false;
        patch.state = 'error';
        patch.errorMessage = event.message ?? 'Playback could not be started.';
        break;
      case 'provider-error':
        patch.state = 'provider-error';
        patch.errorMessage = event.message;
        if (event.code) patch.errorCode = event.code;
        break;
    }

    if (Object.keys(patch).length === 0) return;
    this.patch(sessionId, patch);
    // Notify external event subscribers (watch route's progress writer, etc.).
    for (const subscriber of this.eventSubscribers) {
      try { subscriber(event); } catch { /* subscribers must never throw */ }
    }
  }

  // ----- Internal: state patch + race-condition guard + subscriber notification -----

  /**
   * Apply a partial patch to the internal state. Race-condition-safe:
   * drops the patch if `sessionId !== this.sessionId`. After patching,
   * notifies every state subscriber with the new snapshot.
   */
  private patch(sessionId: number, patch: Partial<PlaybackManagerState>): void {
    if (!this.active || sessionId !== this.sessionId) return;
    this._state = { ...this._state, ...patch };
    for (const subscriber of this.subscribers) {
      try { subscriber(this._state); } catch { /* subscribers must never throw */ }
    }
  }
}

// ----- Helpers (exported for test use) -----

export type ResolverRequest = {
  sourceId: string;
  contentId: string;
  mediaType: 'movie' | 'series' | 'anime';
  season?: number;
  episode?: number;
  /** The bound HTMLVideoElement from PlayerViewport (direct sources only). */
  videoElement?: HTMLVideoElement;
  /**
   * Phase 2: admin-configured per-content-type default source id. Forwarded
   * to `/api/playback/resolve` so the resolver can sort it to the front of
   * the fallback candidate list. Only forwarded when `allowFallback` is true
   * (manual source switches do not want the default forced back). When
   * absent, the resolver uses the existing ranking-only order (Phase 1
   * behavior).
   */
  defaultSourceId?: string;
  /**
   * Phase 7F (MegaPlay): optional playback variant requested by the user
   * (e.g. 'sub' or 'dub'). Forwarded to `/api/playback/resolve`. Only
   * consumed by adapters that support variants (currently only MegaPlay's
   * anime resolver). Other adapters silently ignore it.
   */
  variant?: string;
};

export class ResolverError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'ResolverError';
    this.code = code;
  }
}

function errorMessageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return 'The provider could not be reached. Try again or choose another server.';
}

function normalizePlayerSource(value: unknown): PlayerSource | null {
  if (!value || typeof value !== 'object') return null;
  const source = value as Partial<PlayerSource>;
  if (source.type !== 'direct' && source.type !== 'embed') return null;
  if (typeof source.url !== 'string' || !source.url) return null;
  if (typeof source.sourceId !== 'string' || typeof source.providerId !== 'string') return null;
  return source as PlayerSource;
}

function stateForSource(source: PlayerSource, now = Date.now()): PlayerPlaybackState {
  if (!isPlayablePlayerSource(source) || sourceIsExpired(source, now)) return 'source-unavailable';
  if (source.type === 'embed') return isEmbedOriginAllowed(source) ? 'embed-loading' : 'embed-unavailable';
  const protocol = source.metadata?.protocol;
  if (protocol && !['mp4', 'file', 'hls', 'dash', 'unknown'].includes(protocol)) return 'unsupported-format';
  return 'preparing';
}

/**
 * DOM events PlayerViewport dispatches to PlayerShell today (Phase 0).
 * PlayerShell forwards them to the manager via `dispatchViewportEvent()`.
 *
 * Phase 3 will extend this when provider-specific adapters listen for
 * their own postMessage events directly (those do not flow through here).
 */
export type ViewportEvent =
  | { type: 'loadedmetadata'; currentTime: number; duration: number }
  | { type: 'timeupdate'; currentTime: number; duration: number }
  | { type: 'play' }
  | { type: 'pause' }
  | { type: 'waiting' }
  | { type: 'playing' }
  | { type: 'seeking' }
  | { type: 'seeked'; currentTime: number }
  | { type: 'ended' }
  | { type: 'error' }
  | { type: 'embedload' };

function translateViewportEvent(event: ViewportEvent, source: PlayerSource | null, _state: PlaybackManagerState): PlayerEvent | null {
  switch (event.type) {
    case 'loadedmetadata':
      return { type: 'ready', duration: event.duration };
    case 'timeupdate':
      return { type: 'timeupdate', currentTime: event.currentTime, duration: event.duration };
    case 'play':
      return { type: 'play' };
    case 'pause':
      return { type: 'pause' };
    case 'waiting':
      return { type: 'buffering', value: true };
    case 'playing':
      return { type: 'buffering', value: false };
    case 'seeking':
      return { type: 'seeking' };
    case 'seeked':
      return { type: 'seeked', currentTime: event.currentTime };
    case 'ended':
      return { type: 'ended' };
    case 'error':
      return { type: 'error', message: 'Playback could not be started. Try again or choose another source.' };
    case 'embedload':
      return source?.type === 'embed' ? { type: 'load' } : null;
    default:
      return null;
  }
}
