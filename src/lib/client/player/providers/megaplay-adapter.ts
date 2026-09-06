import type { PlayerSource } from '$lib/shared/player';
import { MEGAPLAY_CAPABILITIES, type ProviderPlaybackCapabilities } from '../capabilities';
import type { AdapterLoadContext, PlayerProviderAdapter } from '../events';
import { PostMessageAdapterBase, extractNumber, extractString, safeParseMessage } from './post-message-utils';

/**
 * MegaPlay player adapter — Phase 7F.
 *
 * MegaPlay (https://megaplay.buzz) is an anime-only embed provider. The
 * official API docs (https://megaplay.buzz/api) document the following
 * postMessage events (player → parent):
 *
 *   1. { event: "time", time: number, duration: number, percent: number }
 *      — progress update. NOTE: the field is `time`, NOT `currentTime`.
 *        The `watching-log` form uses `currentTime`.
 *
 *   2. { event: "complete" } — playback ended.
 *
 *   3. { event: "error" } — playback failure (missing episode, deleted
 *      file, etc.). MegaPlay returns HTTP 200 even for missing content
 *      (it serves a "We're Sorry" 410 page inside the iframe), so this
 *      event is the runtime signal that the variant/episode is
 *      unavailable. When this fires, the watch route's fallback walker
 *      tries the next eligible anime source.
 *
 *   4. { type: "watching-log", currentTime: number, duration: number }
 *      — alternate progress event with the standard `currentTime` key.
 *
 *   5. { channel: "megacloud", ... } — debugging channel. Acknowledged
 *      but not normalized into a PlayerEvent.
 *
 * The docs explicitly mention that messages may arrive as JSON STRINGS
 * (the example listener does `if (typeof data === "string") data =
 * JSON.parse(data)`). `safeParseMessage()` handles both shapes.
 *
 * Origin: https://megaplay.buzz
 *
 * The adapter does NOT support any commands (no play, pause, seek,
 * setVolume). The docs only document events, not parent→player commands.
 * Capabilities reflect this — only `progressEvents`, `currentTime`,
 * `duration`, `fullscreen`, and `postMessage` are true.
 *
 * startAt is NOT supported — MegaPlay does not document a URL parameter
 * for resume. Playback always starts at 0. Mavero tracks progress
 * locally via the `time` event and the existing ProgressWriter.
 */

const MEGAPLAY_ORIGIN = 'https://megaplay.buzz';

type MegaPlayMessage = {
  // The `event`-form messages (time/complete/error).
  event?: unknown;
  // The `type`-form messages (watching-log). Some MegaPlay messages use
  // `type` instead of `event`.
  type?: unknown;
  // `time` event payload.
  time?: unknown;
  // `watching-log` payload uses `currentTime`.
  currentTime?: unknown;
  duration?: unknown;
  percent?: unknown;
  // Debugging channel — acknowledged, not normalized.
  channel?: unknown;
};

function isMegaPlayMessage(value: unknown): value is MegaPlayMessage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  // Accept any message that has at least one of `event`, `type`, or `channel`.
  // This is intentionally permissive at the type-guard level — the
  // handleMessage() switch then validates the specific value.
  return typeof record.event === 'string' || typeof record.type === 'string' || typeof record.channel === 'string';
}

export class MegaPlayPlayerAdapter extends PostMessageAdapterBase implements PlayerProviderAdapter {
  protected readonly origin = MEGAPLAY_ORIGIN;

  canHandle(source: PlayerSource): boolean {
    return this.canHandleByOrigin(source, MEGAPLAY_ORIGIN);
  }

  load(_context: AdapterLoadContext): void {
    this.startListening();
  }

  destroy(): void {
    this.stopListening();
  }

  getCapabilities(): ProviderPlaybackCapabilities {
    return MEGAPLAY_CAPABILITIES;
  }

  // MegaPlay does not document a startAt URL parameter.
  startAtParam(): string | null { return null; }

  protected handleMessage(event: MessageEvent): void {
    const message = safeParseMessage(event.data, isMegaPlayMessage);
    if (!message) return;

    // Debugging channel — acknowledged, not normalized.
    if (typeof message.channel === 'string' && message.channel === 'megacloud') {
      return;
    }

    // `event`-form messages: time, complete, error.
    const eventType = extractString(message, 'event');
    if (eventType === 'time') {
      // NOTE: MegaPlay's `time` event uses `time` for the current position,
      // NOT `currentTime`. The `watching-log` form uses `currentTime`.
      const currentTime = extractNumber(message, 'time');
      const duration = extractNumber(message, 'duration');
      if (currentTime !== null) {
        this.emit({ type: 'timeupdate', currentTime, duration: duration ?? undefined });
      }
      return;
    }
    if (eventType === 'complete') {
      this.emit({ type: 'ended' });
      return;
    }
    if (eventType === 'error') {
      this.emit({ type: 'provider-error', message: 'MegaPlay reported a playback error.' });
      return;
    }

    // `type`-form messages: watching-log.
    const typeValue = extractString(message, 'type');
    if (typeValue === 'watching-log') {
      const currentTime = extractNumber(message, 'currentTime');
      const duration = extractNumber(message, 'duration');
      if (currentTime !== null) {
        this.emit({ type: 'timeupdate', currentTime, duration: duration ?? undefined });
      }
      return;
    }

    // Unknown message shape — silently drop (do NOT throw).
  }
}
