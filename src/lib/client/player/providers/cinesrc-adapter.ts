import type { PlayerSource } from '$lib/shared/player';
import { CINESRC_CAPABILITIES, type ProviderPlaybackCapabilities } from '../capabilities';
import type { AdapterLoadContext, CommandResult, PlayerProviderAdapter } from '../events';
import { PostMessageAdapterBase, extractNumber, safeParseMessage } from './post-message-utils';

/**
 * CineSrc adapter — Phase 3 reference implementation.
 *
 * CineSrc (cinesrc.st) is the ONLY provider with a VERIFIED full
 * bidirectional postMessage contract:
 *
 *   Events (player→parent):
 *     cinesrc:ready
 *     cinesrc:play
 *     cinesrc:pause
 *     cinesrc:timeupdate {currentTime, duration}
 *     cinesrc:seeking
 *     cinesrc:seeked
 *     cinesrc:ended
 *     cinesrc:volumechange
 *     cinesrc:ratechange
 *     cinesrc:loadedmetadata {duration}
 *     cinesrc:nextepisode
 *     cinesrc:skipintro
 *     cinesrc:sourceused
 *     cinesrc:close
 *     cinesrc:error
 *     cinesrc:response  (return channel for getter commands)
 *
 *   Commands (parent→player):
 *     {type:"cinesrc:command", command, args} posted to iframe.contentWindow
 *     Commands: play, pause, seek, setVolume, setMuted, setPlaybackRate,
 *     getCurrentTime, getDuration, getPaused.
 *     Getters return via the cinesrc:response event with a correlation id.
 *
 * URL params: ?t= (startAt), ?quality=, ?autonext=.
 * Origin: https://cinesrc.st
 *
 * This adapter is registered AHEAD of the generic EmbedPlayerAdapter in
 * the adapter registry. `canHandle()` matches by URL origin.
 */
const CINESRC_ORIGIN = 'https://cinesrc.st';

type CineSrcMessage = {
  type: string;
  currentTime?: unknown;
  duration?: unknown;
  id?: unknown;
  value?: unknown;
  error?: unknown;
  message?: unknown;
};

function isCineSrcMessage(value: unknown): value is CineSrcMessage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.type === 'string' && record.type.startsWith('cinesrc:');
}

type PendingResponse = {
  resolve: (value: CommandResult<unknown>) => void;
  timer: ReturnType<typeof setTimeout>;
};

export class CineSrcPlayerAdapter extends PostMessageAdapterBase implements PlayerProviderAdapter {
  protected readonly origin = CINESRC_ORIGIN;

  /**
   * Phase 3 fix: the iframe element reference. Set via `setIframe()`
   * after PlayerViewport renders the `<iframe>`. Commands are posted to
   * `iframe.contentWindow.postMessage(payload, origin)` — the documented
   * CineSrc API target. Until the iframe ref is available, commands
   * return `{ ok: false, reason: 'not-ready' }`.
   */
  private iframe: HTMLIFrameElement | null = null;

  /** Pending getter responses, keyed by command id. */
  private pendingResponses = new Map<number, PendingResponse>();

  /** Monotonic command id for request/response correlation. */
  private nextCommandId = 1;

  canHandle(source: PlayerSource): boolean {
    return this.canHandleByOrigin(source, CINESRC_ORIGIN);
  }

  load(_context: AdapterLoadContext): void {
    // The iframe element is NOT available at load time — it hasn't rendered
    // yet. PlayerViewport renders the `<iframe>` after the manager sets
    // `resolvedSource`, and PlayerShell's `handleEmbedLoad` forwards the
    // iframe ref via `onIframeReady` → `manager.setIframe()` →
    // `adapter.setIframe()`.
    void _context;
    this.startListening();
  }

  /**
   * Phase 3 fix: receive the iframe element reference from the manager.
   * Called after the iframe renders. Until this is called, commands
   * return `{ ok: false, reason: 'not-ready' }`.
   */
  setIframe(iframe: HTMLIFrameElement): void {
    this.iframe = iframe;
  }

  destroy(): void {
    // Clean up any pending getter responses.
    for (const [, pending] of this.pendingResponses) {
      clearTimeout(pending.timer);
      pending.resolve({ ok: false, reason: 'not-ready', message: 'Adapter destroyed.' });
    }
    this.pendingResponses.clear();
    this.stopListening();
    this.iframe = null;
  }

  getCapabilities(): ProviderPlaybackCapabilities {
    return CINESRC_CAPABILITIES;
  }

  // ----- Event handling (player → parent) -----

  protected handleMessage(event: MessageEvent): void {
    const message = safeParseMessage(event.data, isCineSrcMessage);
    if (!message) return;

    switch (message.type) {
      case 'cinesrc:ready':
        this.emit({ type: 'ready' });
        break;
      case 'cinesrc:play':
        this.emit({ type: 'play' });
        break;
      case 'cinesrc:pause':
        this.emit({ type: 'pause' });
        break;
      case 'cinesrc:timeupdate': {
        const currentTime = extractNumber(message, 'currentTime');
        const duration = extractNumber(message, 'duration');
        if (currentTime !== null) {
          this.emit({ type: 'timeupdate', currentTime, duration: duration ?? undefined });
        }
        break;
      }
      case 'cinesrc:loadedmetadata': {
        const duration = extractNumber(message, 'duration');
        if (duration !== null) this.emit({ type: 'ready', duration });
        break;
      }
      case 'cinesrc:seeking':
        this.emit({ type: 'seeking' });
        break;
      case 'cinesrc:seeked': {
        const currentTime = extractNumber(message, 'currentTime');
        if (currentTime !== null) this.emit({ type: 'seeked', currentTime });
        break;
      }
      case 'cinesrc:ended':
        this.emit({ type: 'ended' });
        break;
      case 'cinesrc:error': {
        const errorMessage = typeof message.message === 'string' ? message.message : 'CineSrc player error.';
        this.emit({ type: 'provider-error', message: errorMessage });
        break;
      }
      case 'cinesrc:response':
        this.handleResponse(message);
        break;
      // cinesrc:volumechange, cinesrc:ratechange, cinesrc:nextepisode,
      // cinesrc:skipintro, cinesrc:sourceused, cinesrc:close are acknowledged
      // but not normalized into a PlayerEvent in Phase 3 — they are
      // provider-specific notifications that don't map to the current
      // normalized event union. Phase 5+ may extend the event model.
      default:
        // Unrecognized cinesrc: event — silently drop (do NOT throw).
        break;
    }
  }

  /**
   * Handle a `cinesrc:response` message — resolve the pending getter
   * promise that matches the response id.
   */
  private handleResponse(message: CineSrcMessage): void {
    const id = typeof message.id === 'number' ? message.id : null;
    if (id === null) return;
    const pending = this.pendingResponses.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingResponses.delete(id);
    if (message.error) {
      pending.resolve({ ok: false, reason: 'provider-error', message: typeof message.error === 'string' ? message.error : 'Provider returned an error.' });
    } else {
      pending.resolve({ ok: true, value: message.value });
    }
  }

  // ----- Command methods (parent → player) -----

  /**
   * Send a JSON-RPC command to the CineSrc player. Posts to
   * `iframe.contentWindow.postMessage(payload, origin)` — the documented
   * CineSrc API target. Returns the command id (for getter correlation)
   * or null if the command could not be sent (adapter destroyed or
   * iframe/contentWindow not yet available).
   */
  private sendCommand(command: string, args: unknown[] = []): number | null {
    if (this.destroyed || !this.iframe) return null;
    const target = this.iframe.contentWindow;
    if (!target) return null;
    const id = this.nextCommandId++;
    const payload = { type: 'cinesrc:command', command, args, id };
    try {
      target.postMessage(payload, this.origin);
      return id;
    } catch {
      return null;
    }
  }

  /**
   * Send a getter command and await the `cinesrc:response` reply.
   * Times out after 5 seconds if the provider does not respond.
   */
  private sendGetter<T>(command: string): Promise<CommandResult<T>> {
    if (this.destroyed || !this.iframe) {
      return Promise.resolve({ ok: false, reason: 'not-ready' });
    }
    const id = this.sendCommand(command);
    if (id === null) {
      return Promise.resolve({ ok: false, reason: 'not-ready', message: 'iframe contentWindow not available.' });
    }
    return new Promise<CommandResult<T>>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingResponses.delete(id);
        resolve({ ok: false, reason: 'provider-error', message: 'Command timed out.' });
      }, 5000);
      this.pendingResponses.set(id, {
        resolve: (result) => {
          if (result.ok) {
            resolve({ ok: true, value: result.value as T });
          } else {
            resolve({ ok: false, reason: result.reason, message: result.message });
          }
        },
        timer,
      });
    });
  }

  async play(): Promise<CommandResult> {
    const id = this.sendCommand('play');
    if (id === null) return { ok: false, reason: 'not-ready' };
    return { ok: true };
  }

  async pause(): Promise<CommandResult> {
    const id = this.sendCommand('pause');
    if (id === null) return { ok: false, reason: 'not-ready' };
    return { ok: true };
  }

  async seek(seconds: number): Promise<CommandResult> {
    if (!Number.isFinite(seconds) || seconds < 0) return { ok: false, reason: 'provider-error', message: 'Invalid seek position.' };
    const id = this.sendCommand('seek', [seconds]);
    if (id === null) return { ok: false, reason: 'not-ready' };
    return { ok: true };
  }

  async getCurrentTime(): Promise<CommandResult<number>> {
    return this.sendGetter<number>('getCurrentTime');
  }

  async getDuration(): Promise<CommandResult<number>> {
    return this.sendGetter<number>('getDuration');
  }

  async setVolume(volume: number): Promise<CommandResult> {
    const clamped = Math.min(1, Math.max(0, volume));
    const id = this.sendCommand('setVolume', [clamped]);
    if (id === null) return { ok: false, reason: 'not-ready' };
    return { ok: true };
  }
}
