import type { PlayerSource } from '$lib/shared/player';
import { VIDPHANTOM_CAPABILITIES, type ProviderPlaybackCapabilities } from '../capabilities';
import type { AdapterLoadContext, PlayerProviderAdapter } from '../events';
import { PostMessageAdapterBase, safeParseMessage } from './post-message-utils';

/**
 * VidPhantom adapter — Phase 3 (skeleton, PARTIAL).
 *
 * VidPhantom (vidphantom.com) has a documented "Player Events" postMessage
 * section (confirmed via a search-engine snippet) with play/pause events.
 * However, the full docs could not be retrieved because the origin returns
 * HTTP 522 (Cloudflare: origin server unreachable) on every fetch attempt
 * during the Phase 0 audit.
 *
 * Because the exact payload structure is UNKNOWN (only a search snippet
 * was available), this adapter CANNOT reliably parse messages. It registers
 * a listener but does NOT normalize any specific messages — all messages
 * are silently dropped until the origin recovers and the full docs are
 * verified.
 *
 * Capabilities reflect this conservative state:
 *   - postMessage = true (the snippet confirms the API exists).
 *   - Everything else = false (UNKNOWN → treated as false per the rule).
 *
 * Origin: https://vidphantom.com
 */
const VIDPHANTOM_ORIGIN = 'https://vidphantom.com';

// VidPhantom message shape is UNKNOWN — accept any object but do not normalize.
type VidPhantomMessage = Record<string, unknown>;

function isVidPhantomMessage(value: unknown): value is VidPhantomMessage {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class VidPhantomPlayerAdapter extends PostMessageAdapterBase implements PlayerProviderAdapter {
  protected readonly origin = VIDPHANTOM_ORIGIN;

  canHandle(source: PlayerSource): boolean {
    return this.canHandleByOrigin(source, VIDPHANTOM_ORIGIN);
  }

  load(_context: AdapterLoadContext): void {
    this.startListening();
  }

  destroy(): void {
    this.stopListening();
  }

  getCapabilities(): ProviderPlaybackCapabilities {
    return VIDPHANTOM_CAPABILITIES;
  }

  protected handleMessage(_event: MessageEvent): void {
    // Validate the message is an object but do NOT normalize — the exact
    // payload structure is UNKNOWN (only a search snippet was available).
    const _message = safeParseMessage(_event.data, isVidPhantomMessage);
    // Intentional no-op: VidPhantom's origin is currently 522 and the full
    // docs could not be verified. No events are normalized until the
    // payload structure is confirmed.
  }
}
