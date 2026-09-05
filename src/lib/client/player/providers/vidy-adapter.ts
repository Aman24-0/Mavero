import type { PlayerSource } from '$lib/shared/player';
import { VIDY_CAPABILITIES, type ProviderPlaybackCapabilities } from '../capabilities';
import type { AdapterLoadContext, PlayerProviderAdapter } from '../events';
import { PostMessageAdapterBase, extractNumber, extractString, safeParseMessage } from './post-message-utils';

/**
 * VidY adapter — Phase 3.
 *
 * VidY (vidy.st) posts messages as JSON STRINGS (not objects) — the
 * `safeParseMessage` helper handles this by attempting JSON.parse on
 * string data.
 *
 * Two message types:
 *
 *   1. PLAYER_EVENT (posted as a JSON string):
 *      {event:"timeupdate"|"play"|"pause"|"ended", currentTime, duration, ...}
 *      Note: NO `type` field — VidY posts the event object directly as a
 *      JSON string. The `event` field identifies the event type.
 *
 *   2. MEDIA_DATA:
 *      {type:"MEDIA_DATA", data:"<serialized local history>"} — continue-watching.
 *
 * VERIFIED events: timeupdate (currentTime + duration), play, pause, ended.
 * NOT VERIFIED: seek command.
 *
 * Origin: https://vidy.st (the configured embed domain per the migration).
 */
const VIDY_ORIGIN = 'https://vidy.st';

type VidYPlayerEvent = {
  event?: unknown;
  currentTime?: unknown;
  duration?: unknown;
};

type VidYMediaData = {
  type: string;
  data?: unknown;
};

function isVidYMessage(value: unknown): value is VidYPlayerEvent | VidYMediaData {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  // PLAYER_EVENT: has an `event` field (string).
  // MEDIA_DATA: has a `type` field === 'MEDIA_DATA'.
  return typeof record.event === 'string' || (typeof record.type === 'string' && record.type === 'MEDIA_DATA');
}

export class VidYPlayerAdapter extends PostMessageAdapterBase implements PlayerProviderAdapter {
  protected readonly origin = VIDY_ORIGIN;

  canHandle(source: PlayerSource): boolean {
    // VidY's configured URL is https://vidy.st/movie/{tmdb_id} — the origin
    // is https://vidy.st. Some references use www.vidy.st; we match either.
    if (this.canHandleByOrigin(source, 'https://vidy.st')) return true;
    if (this.canHandleByOrigin(source, 'https://www.vidy.st')) return true;
    return false;
  }

  load(_context: AdapterLoadContext): void {
    this.startListening();
  }

  destroy(): void {
    this.stopListening();
  }

  getCapabilities(): ProviderPlaybackCapabilities {
    return VIDY_CAPABILITIES;
  }

  protected handleMessage(event: MessageEvent): void {
    const message = safeParseMessage(event.data, isVidYMessage);
    if (!message) return;

    // Check if it's a MEDIA_DATA message.
    if ('type' in message && message.type === 'MEDIA_DATA') {
      // Continue-watching data — Phase 4 will consume it. Phase 3 acknowledges.
      return;
    }

    // Otherwise it's a PLAYER_EVENT (has an `event` field).
    const playerEvent = message as VidYPlayerEvent;
    const eventType = extractString(playerEvent, 'event');
    const currentTime = extractNumber(playerEvent, 'currentTime');
    const duration = extractNumber(playerEvent, 'duration');

    if (eventType === 'timeupdate' && currentTime !== null) {
      this.emit({ type: 'timeupdate', currentTime, duration: duration ?? undefined });
    } else if (eventType === 'play') {
      this.emit({ type: 'play' });
    } else if (eventType === 'pause') {
      this.emit({ type: 'pause' });
    } else if (eventType === 'ended') {
      this.emit({ type: 'ended' });
    }
  }
}
