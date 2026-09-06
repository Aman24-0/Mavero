import type { PlayerSource } from '$lib/shared/player';
import { VIDAPI_QZZ_CAPABILITIES, type ProviderPlaybackCapabilities } from '../capabilities';
import type { AdapterLoadContext, PlayerProviderAdapter } from '../events';
import { PostMessageAdapterBase, extractNumber, safeParseMessage } from './post-message-utils';

/**
 * VidAPI.qzz.io adapter — Phase 3.
 *
 * VidAPI.qzz.io posts MEDIA_DATA messages:
 *   {type:"MEDIA_DATA", data:{id, type:"movie",
 *    progress:{watched:1194, duration:6360, percentage:18.7}}}
 *
 * Unlike its sibling vidlink.pro, VidAPI.qzz.io does NOT post a PLAYER_EVENT
 * stream — only MEDIA_DATA. This means no play/pause/ended events are
 * available. The adapter normalizes the progress data into timeupdate events.
 *
 * VERIFIED events: timeupdate (progress.watched) + duration (progress.duration).
 * NOT VERIFIED: play/pause/ended (no PLAYER_EVENT stream documented).
 * NOT VERIFIED: seek command.
 *
 * Origin: https://vidapi.qzz.io
 */
const VIDAPI_QZZ_ORIGIN = 'https://vidapi.qzz.io';

type VidApiQzzMessage = {
  type: string;
  data?: unknown;
};

type VidApiQzzMediaData = {
  progress?: unknown;
};

type VidApiQzzProgress = {
  watched?: unknown;
  duration?: unknown;
};

function isVidApiQzzMessage(value: unknown): value is VidApiQzzMessage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.type === 'MEDIA_DATA';
}

export class VidApiQzzPlayerAdapter extends PostMessageAdapterBase implements PlayerProviderAdapter {
  protected readonly origin = VIDAPI_QZZ_ORIGIN;

  canHandle(source: PlayerSource): boolean {
    return this.canHandleByOrigin(source, VIDAPI_QZZ_ORIGIN);
  }

  load(_context: AdapterLoadContext): void {
    this.startListening();
  }

  destroy(): void {
    this.stopListening();
  }

  getCapabilities(): ProviderPlaybackCapabilities {
    return VIDAPI_QZZ_CAPABILITIES;
  }

  startAtParam(): string | null { return 'startAt'; }

  protected handleMessage(event: MessageEvent): void {
    const message = safeParseMessage(event.data, isVidApiQzzMessage);
    if (!message) return;

    const data = message.data;
    if (!data || typeof data !== 'object' || Array.isArray(data)) return;
    const mediaData = data as VidApiQzzMediaData;
    const progress = mediaData.progress;
    if (!progress || typeof progress !== 'object' || Array.isArray(progress)) return;
    const progressData = progress as VidApiQzzProgress;
    const watched = extractNumber(progressData, 'watched');
    const duration = extractNumber(progressData, 'duration');
    if (watched !== null) {
      this.emit({ type: 'timeupdate', currentTime: watched, duration: duration ?? undefined });
    }
  }
}
