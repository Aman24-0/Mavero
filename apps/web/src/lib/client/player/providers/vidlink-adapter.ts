import type { PlayerSource } from '$lib/shared/player';
import { VIDLINK_CAPABILITIES, type ProviderPlaybackCapabilities } from '../capabilities';
import type { AdapterLoadContext, PlayerProviderAdapter } from '../events';
import { PostMessageAdapterBase, extractNumber, extractString, safeParseMessage } from './post-message-utils';

/**
 * VidLink adapter — Phase 3.
 *
 * VidLink (vidlink.pro) posts two message types:
 *
 *   1. PLAYER_EVENT:
 *      {type:"PLAYER_EVENT", data:{event:"play"|"pause"|"seeked"|"ended"|"timeupdate",
 *       currentTime, duration, mtmdbId, mediaType, season?, episode?}}
 *
 *   2. MEDIA_DATA:
 *      {type:"MEDIA_DATA", data:"<serialized local history>"} — continue-watching
 *      data that VidLink stores in localStorage. Phase 4 will use this for
 *      progress; Phase 3 normalizes the PLAYER_EVENT stream only.
 *
 * VERIFIED events: play, pause, seeked, ended, timeupdate (with currentTime +
 * duration).
 * NOT VERIFIED: seek command (only a `seeked` event — no parent→player seek).
 * NOT VERIFIED: play/pause as commands (VidLink posts them as state changes).
 *
 * Origin: https://vidlink.pro
 */
const VIDLINK_ORIGIN = 'https://vidlink.pro';

type VidLinkMessage = {
  type: string;
  data?: unknown;
};

type VidLinkPlayerData = {
  event?: unknown;
  currentTime?: unknown;
  duration?: unknown;
};

function isVidLinkMessage(value: unknown): value is VidLinkMessage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.type === 'string' && (record.type === 'PLAYER_EVENT' || record.type === 'MEDIA_DATA');
}

export class VidLinkPlayerAdapter extends PostMessageAdapterBase implements PlayerProviderAdapter {
  protected readonly origin = VIDLINK_ORIGIN;

  canHandle(source: PlayerSource): boolean {
    return this.canHandleByOrigin(source, VIDLINK_ORIGIN);
  }

  load(_context: AdapterLoadContext): void {
    this.startListening();
  }

  destroy(): void {
    this.stopListening();
  }

  getCapabilities(): ProviderPlaybackCapabilities {
    return VIDLINK_CAPABILITIES;
  }

  startAtParam(): string | null { return 'startAt'; }

  protected handleMessage(event: MessageEvent): void {
    const message = safeParseMessage(event.data, isVidLinkMessage);
    if (!message) return;

    if (message.type === 'MEDIA_DATA') {
      // MEDIA_DATA is continue-watching data — Phase 4 will consume it for
      // progress persistence. Phase 3 acknowledges it but does not emit a
      // normalized event (it is not a playback state change).
      return;
    }

    // PLAYER_EVENT
    const data = message.data;
    if (!data || typeof data !== 'object' || Array.isArray(data)) return;
    const playerData = data as VidLinkPlayerData;

    const eventType = extractString(playerData, 'event');
    const currentTime = extractNumber(playerData, 'currentTime');
    const duration = extractNumber(playerData, 'duration');

    if (eventType === 'timeupdate' && currentTime !== null) {
      this.emit({ type: 'timeupdate', currentTime, duration: duration ?? undefined });
    } else if (eventType === 'play') {
      this.emit({ type: 'play' });
    } else if (eventType === 'pause') {
      this.emit({ type: 'pause' });
    } else if (eventType === 'seeked' && currentTime !== null) {
      this.emit({ type: 'seeked', currentTime });
    } else if (eventType === 'ended') {
      this.emit({ type: 'ended' });
    }
  }
}
