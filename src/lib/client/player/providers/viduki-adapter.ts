import type { PlayerSource } from '$lib/shared/player';
import { VIDUKI_CAPABILITIES, type ProviderPlaybackCapabilities } from '../capabilities';
import type { AdapterLoadContext, PlayerProviderAdapter, PlayerEvent } from '../events';
import { PostMessageAdapterBase, extractNumber, extractString, safeParseMessage } from './post-message-utils';

/**
 * Viduki adapter — Phase 3.
 *
 * Viduki (www.viduki.net) posts two message types:
 *
 *   1. viduki:all-servers-failed:
 *      {type:"viduki:all-servers-failed", source:"viduki-api-1",
 *       stage:"initial"|"manual-switch"|"playback-error", status, message,
 *       media:{type,tmdbid,season?,episode?}}
 *
 *      This signal tells the parent that ALL backend servers in the current
 *      Viduki API version have failed. The watch route's existing V1→V2
 *      fallback listener handles this by switching to the sibling V2 source.
 *      Phase 3 moves the listener INTO this adapter, but the fallback ACTION
 *      (switching source) remains in the watch route — the adapter emits a
 *      `provider-error` event that the manager/watch-route can react to.
 *
 *   2. MEDIA_DATA:
 *      {type:"MEDIA_DATA", data:{id, type, title, poster_path, backdrop_path,
 *       progress:{watched, duration}, ...}}
 *
 *      Contains progress.watched (currentTime) and progress.duration.
 *
 * VERIFIED events: provider-error (via all-servers-failed), timeupdate +
 * duration (via MEDIA_DATA.progress).
 * NOT VERIFIED: play/pause/ended events (not documented).
 * NOT VERIFIED: startAt URL param.
 *
 * Origin: https://www.viduki.net
 */
const VIDUKI_ORIGIN = 'https://www.viduki.net';

type VidukiMessage = {
  type: string;
  data?: unknown;
  source?: unknown;
  stage?: unknown;
  status?: unknown;
  message?: unknown;
};

type VidukiMediaData = {
  progress?: unknown;
};

type VidukiProgress = {
  watched?: unknown;
  duration?: unknown;
};

function isVidukiMessage(value: unknown): value is VidukiMessage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.type === 'string' && (record.type === 'viduki:all-servers-failed' || record.type === 'MEDIA_DATA');
}

export class VidukiPlayerAdapter extends PostMessageAdapterBase implements PlayerProviderAdapter {
  protected readonly origin = VIDUKI_ORIGIN;

  canHandle(source: PlayerSource): boolean {
    return this.canHandleByOrigin(source, VIDUKI_ORIGIN);
  }

  load(_context: AdapterLoadContext): void {
    this.startListening();
  }

  destroy(): void {
    this.stopListening();
  }

  getCapabilities(): ProviderPlaybackCapabilities {
    return VIDUKI_CAPABILITIES;
  }

  protected handleMessage(event: MessageEvent): void {
    const message = safeParseMessage(event.data, isVidukiMessage);
    if (!message) return;

    if (message.type === 'viduki:all-servers-failed') {
      // Emit a provider-error event so the watch route can trigger the
      // V1→V2 fallback. The watch route's existing listener checks for
      // this message type directly — but Phase 3 normalizes it through
      // the adapter event stream so the manager can also react.
      //
      // IMPORTANT: the existing V1→V2 fallback listener in the watch route
      // remains active (not removed in Phase 3) to preserve exact Phase 1
      // behavior. Both the watch route listener AND this adapter will
      // receive the message — the watch route handles the source switch,
      // and this adapter emits a normalized provider-error event that the
      // manager surfaces in state.
      const stage = extractString(message, 'stage');
      const statusMessage = extractString(message, 'message');
      this.emit({
        type: 'provider-error',
        message: `All Viduki servers failed${stage ? ` (stage: ${stage})` : ''}.${statusMessage ? ` ${statusMessage}` : ''}`,
        code: 'viduki:all-servers-failed',
      } as PlayerEvent);
      return;
    }

    if (message.type === 'MEDIA_DATA') {
      const data = message.data;
      if (!data || typeof data !== 'object' || Array.isArray(data)) return;
      const mediaData = data as VidukiMediaData;
      const progress = mediaData.progress;
      if (!progress || typeof progress !== 'object' || Array.isArray(progress)) return;
      const progressData = progress as VidukiProgress;
      const watched = extractNumber(progressData, 'watched');
      const duration = extractNumber(progressData, 'duration');
      if (watched !== null) {
        this.emit({ type: 'timeupdate', currentTime: watched, duration: duration ?? undefined });
      }
    }
  }
}
