import type { PlayerSource } from '$lib/shared/player';
import { MOVIESNEXUS_CAPABILITIES, type ProviderPlaybackCapabilities } from '../capabilities';
import type { AdapterLoadContext, PlayerProviderAdapter } from '../events';
import { PostMessageAdapterBase, extractNumber, safeParseMessage } from './post-message-utils';

/**
 * MoviesNexus adapter — moviesnexus.fun.
 *
 * Provider contract (verified 2026-09-26; see MOVIESNEXUS_CAPABILITIES for
 * the full verification notes):
 *
 *   URL:   https://www.moviesnexus.fun/movie/{tmdbId}[?sv=...&startAt=N]
 *          https://www.moviesnexus.fun/tv/{tmdbId}/{season}/{episode}[?sv=...&startAt=N]
 *   Resume param: startAt (seconds) — the documented canonical parameter.
 *
 *   postMessage (player → parent, origin https://www.moviesnexus.fun):
 *     PLAYER_PROGRESS           {currentTime, duration}          → timeupdate
 *     MOVIE_NEXUS_SERVERS       {servers:[{id,name}]}            → metadata only
 *     MOVIE_NEXUS_SERVER_FAILED {failedServerId}                 → metadata only
 *     PLAYER_FULLSCREEN_CHANGE  {isFullscreen}                   → metadata only
 *
 *   MOVIE_NEXUS_SERVERS / SERVER_FAILED / FULLSCREEN_CHANGE have NO mapping
 *   in the normalized PlayerEvent union (no metadata/fullscreen event type
 *   exists). Per the adapter contract they are silently acknowledged and
 *   dropped — never faked into another event. SERVER_FAILED is followed by
 *   the player's own automatic fallback to the next server (verified in the
 *   provider's bundle code), so it must NOT surface as a playback error.
 *
 *   The provider also accepts MOVIE_NEXUS_REQUEST_SERVERS (parent → player,
 *   discovered in the bundle code) — not used by Mavero; the iframe's own
 *   server UI remains the provider's domain.
 *
 * MoviesNexus exposes TWO Mavero sources (sv=4k and sv=multiaudio2) — both
 * resolve to this same adapter because canHandle matches by origin.
 */
const MOVIESNEXUS_ORIGIN = 'https://www.moviesnexus.fun';

type MoviesNexusMessage = {
  type?: unknown;
  currentTime?: unknown;
  duration?: unknown;
};

function isMoviesNexusMessage(value: unknown): value is MoviesNexusMessage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.type === 'string';
}

export class MoviesNexusPlayerAdapter extends PostMessageAdapterBase implements PlayerProviderAdapter {
  protected readonly origin = MOVIESNEXUS_ORIGIN;

  canHandle(source: PlayerSource): boolean {
    // Both Mavero sources (sv=4k, sv=multiaudio2) share this origin.
    return this.canHandleByOrigin(source, MOVIESNEXUS_ORIGIN);
  }

  load(_context: AdapterLoadContext): void {
    this.startListening();
  }

  destroy(): void {
    this.stopListening();
  }

  getCapabilities(): ProviderPlaybackCapabilities {
    return MOVIESNEXUS_CAPABILITIES;
  }

  startAtParam(): string | null { return 'startAt'; }

  protected handleMessage(event: MessageEvent): void {
    const message = safeParseMessage(event.data, isMoviesNexusMessage);
    if (!message) return;

    const messageType = message.type;
    if (messageType === 'PLAYER_PROGRESS') {
      // Documented payload: {currentTime, duration}. Validate defensively —
      // the value was not live-capturable from the verification environment.
      const currentTime = extractNumber(message as unknown as Record<string, unknown>, 'currentTime');
      if (currentTime === null) return;
      const duration = extractNumber(message as unknown as Record<string, unknown>, 'duration');
      this.emit({ type: 'timeupdate', currentTime, duration: duration ?? undefined });
      return;
    }

    // MOVIE_NEXUS_SERVERS / MOVIE_NEXUS_SERVER_FAILED / PLAYER_FULLSCREEN_CHANGE:
    // provider metadata with no PlayerEvent mapping — acknowledged, not faked.
    // Unknown message types are silently dropped (adapter contract).
  }
}
