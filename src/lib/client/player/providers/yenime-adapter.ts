import type { PlayerSource } from '$lib/shared/player';
import { YENIME_CAPABILITIES, type ProviderPlaybackCapabilities } from '../capabilities';
import type { AdapterLoadContext, PlayerProviderAdapter } from '../events';
import { PostMessageAdapterBase, extractNumber, extractString, safeParseMessage } from './post-message-utils';

/**
 * Yenime player adapter — Phase 7F+.
 *
 * Yenime (https://api.yenime.net) is an anime-only embed provider that
 * uses the same `PLAYER_EVENT` postMessage protocol as VidLink (verified
 * by inspecting the Yenime player JS chunks at
 * https://api.yenime.net/_next/static/chunks/23-b5c2ac231c8eb63d.js).
 *
 * The player posts:
 *
 *   { type: "PLAYER_EVENT", data: { event, currentTime, duration,
 *     mtmdbId, mediaType, season, episode } }
 *
 * where `event` is one of: "play", "pause", "seeked", "ended",
 * "timeupdate", "playing", "waiting", "error".
 *
 * This is identical to VidLink's protocol — Yenime is built on top of
 * MegaPlay's infrastructure (the docs explicitly say "direct megaplay
 * extraction") and reuses the same event emitter.
 *
 * VERIFIED capabilities (from the Yenime player HTML + JS):
 *   - postMessage PLAYER_EVENT stream with currentTime + duration
 *   - play/pause/seeked/ended/timeupdate/playing/waiting/error events
 *   - startAt URL parameter (documented at /api homepage "Query Parameters"
 *     section: `?startAt=90` → begin playback from N seconds)
 *   - fullscreen (allowfullscreen set on the iframe)
 *
 * NOT VERIFIED:
 *   - seek COMMAND (only a `seeked` event, no parent→player seek)
 *   - play/pause as COMMANDS (Yenime posts them as state changes, but
 *     the parent cannot command the player to play/pause)
 *   - volume as a command (the player has a volume slider, but no
 *     documented parent→player API)
 *   - subtitles, quality, PiP, nextEpisode
 *
 * SUB/DUB: handled INTERNALLY by the Yenime player (it has a "Toggle
 * SUB/DUB" button with title="Toggle SUB/DUB"). Mavero does NOT expose
 * variant toggles for Yenime — the user toggles audio inside the iframe.
 *
 * Origin: https://api.yenime.net
 */

const YENIME_ORIGIN = 'https://api.yenime.net';

type YenimeMessage = {
  type?: unknown;
  data?: unknown;
};

type YenimePlayerData = {
  event?: unknown;
  currentTime?: unknown;
  duration?: unknown;
};

function isYenimeMessage(value: unknown): value is YenimeMessage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.type === 'string' && (record.type === 'PLAYER_EVENT' || record.type === 'MEDIA_DATA');
}

export class YenimePlayerAdapter extends PostMessageAdapterBase implements PlayerProviderAdapter {
  protected readonly origin = YENIME_ORIGIN;

  canHandle(source: PlayerSource): boolean {
    return this.canHandleByOrigin(source, YENIME_ORIGIN);
  }

  load(_context: AdapterLoadContext): void {
    this.startListening();
  }

  destroy(): void {
    this.stopListening();
  }

  getCapabilities(): ProviderPlaybackCapabilities {
    return YENIME_CAPABILITIES;
  }

  // VERIFIED: Yenime documents `?startAt=N` in its API "Query Parameters"
  // section. The PlaybackManager appends this when a resume position
  // exists and the adapter's capabilities.startAt === true.
  startAtParam(): string | null { return 'startAt'; }

  protected handleMessage(event: MessageEvent): void {
    const message = safeParseMessage(event.data, isYenimeMessage);
    if (!message) return;

    if (message.type === 'MEDIA_DATA') {
      // MEDIA_DATA is continue-watching data (same as VidLink). Phase 4
      // will consume it for progress persistence; for now we acknowledge
      // but do not emit a normalized event.
      return;
    }

    // PLAYER_EVENT
    const data = message.data;
    if (!data || typeof data !== 'object' || Array.isArray(data)) return;
    const playerData = data as YenimePlayerData;

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
    } else if (eventType === 'error') {
      this.emit({ type: 'provider-error', message: 'Yenime reported a playback error.' });
    }
    // 'playing' and 'waiting' events are acknowledged but not normalized
    // into a PlayerEvent — the PlaybackManager does not have a 'playing'
    // or 'waiting' event in its union (it uses 'buffering' + a boolean).
    // Phase 5+ may extend the event model to consume these.
  }
}
