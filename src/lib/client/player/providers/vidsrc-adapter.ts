import type { PlayerSource } from '$lib/shared/player';
import { VIDSRC_CAPABILITIES, type ProviderPlaybackCapabilities } from '../capabilities';
import type { AdapterLoadContext, PlayerProviderAdapter } from '../events';
import { PostMessageAdapterBase, extractNumber, extractString, safeParseMessage } from './post-message-utils';

/**
 * VidSrc adapter — Phase 3.
 *
 * VidSrc (vidsrc.wiki, documented on vidsrc.io) posts PLAYER_EVENT messages:
 *   {type:"PLAYER_EVENT", data:{player_info:{imdb,tmdb,mediaType,season,episode},
 *    player_status, player_progress, player_duration}}
 *
 * player_status: "playing" (≈every 5s), "paused", "completed", "seeked".
 * player_progress: currentTime in seconds.
 * player_duration: total duration in seconds.
 *
 * VERIFIED events: play (player_status="playing"), pause (player_status="paused"),
 * ended (player_status="completed"), timeupdate (player_progress + player_duration),
 * seeked (player_status="seeked").
 *
 * NOT VERIFIED: seek command (only a `seeked` event — no parent→player seek).
 * NOT VERIFIED: play/pause as commands (VidSrc posts them as state changes,
 * not as commands the parent can invoke).
 *
 * Origin: https://vidsrc.wiki (the configured embed domain).
 */
const VIDSRC_ORIGIN = 'https://vidsrc.wiki';

type VidSrcPlayerEvent = {
  type: string;
  data?: unknown;
};

type VidSrcPlayerData = {
  player_status?: unknown;
  player_progress?: unknown;
  player_duration?: unknown;
};

function isVidSrcPlayerEvent(value: unknown): value is VidSrcPlayerEvent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.type === 'PLAYER_EVENT';
}

export class VidSrcPlayerAdapter extends PostMessageAdapterBase implements PlayerProviderAdapter {
  protected readonly origin = VIDSRC_ORIGIN;

  canHandle(source: PlayerSource): boolean {
    return this.canHandleByOrigin(source, VIDSRC_ORIGIN);
  }

  load(_context: AdapterLoadContext): void {
    this.startListening();
  }

  destroy(): void {
    this.stopListening();
  }

  getCapabilities(): ProviderPlaybackCapabilities {
    return VIDSRC_CAPABILITIES;
  }

  startAtParam(): string | null { return 'startAt'; }

  protected handleMessage(event: MessageEvent): void {
    const message = safeParseMessage(event.data, isVidSrcPlayerEvent);
    if (!message) return;

    const data = message.data;
    if (!data || typeof data !== 'object' || Array.isArray(data)) return;
    const playerData = data as VidSrcPlayerData;

    const status = extractString(playerData, 'player_status');
    const progress = extractNumber(playerData, 'player_progress');
    const duration = extractNumber(playerData, 'player_duration');

    // Emit timeupdate whenever we have a progress value.
    if (progress !== null) {
      this.emit({ type: 'timeupdate', currentTime: progress, duration: duration ?? undefined });
    }

    // Map player_status to play/pause/ended/seeked events.
    if (status === 'playing') {
      this.emit({ type: 'play' });
    } else if (status === 'paused') {
      this.emit({ type: 'pause' });
    } else if (status === 'completed') {
      this.emit({ type: 'ended' });
    } else if (status === 'seeked') {
      // VidSrc posts a `seeked` status (no currentTime in the status field
      // itself — the currentTime comes from player_progress above).
      if (progress !== null) {
        this.emit({ type: 'seeked', currentTime: progress });
      }
    }
  }
}
