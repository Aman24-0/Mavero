import type { PlayerSource } from '$lib/shared/player';
import { CINEMAOS_CAPABILITIES, type ProviderPlaybackCapabilities } from '../capabilities';
import type { AdapterLoadContext, PlayerProviderAdapter } from '../events';
import { PostMessageAdapterBase, safeParseMessage } from './post-message-utils';

/**
 * CinemaOS adapter — Phase 3 (skeleton).
 *
 * CinemaOS (cinemaos.tech) documents a "PostMessage API" section on its
 * embed page (cinemaos.tech/embed) with the claim "Control playback and
 * track progress from your own page." The docs confirm ?autoNext= and
 * ?autoPlay= URL params, and fullscreen is supported (allowfullscreen,
 * allow="encrypted-media").
 *
 * HOWEVER: the detailed event tables and method names are JS-rendered
 * (client-side React content) and could not be extracted via server-side
 * fetch during the Phase 0 audit. The exact payload structure for
 * postMessage events is UNKNOWN.
 *
 * This adapter registers a `window.message` listener scoped to the
 * CinemaOS origin, but does NOT normalize any specific messages because
 * the message shape is unverified. All messages are silently dropped
 * until the payload structure is confirmed.
 *
 * Capabilities reflect this conservative state:
 *   - postMessage = true (the API exists — docs confirm it).
 *   - nextEpisode = true (autoNext URL param is documented).
 *   - fullscreen = true (allowfullscreen is documented).
 *   - Everything else = false (UNKNOWN → treated as false per the rule).
 *
 * Origin: https://cinemaos.tech
 */
const CINEMAOS_ORIGIN = 'https://cinemaos.tech';

// CinemaOS message shape is UNKNOWN — accept any object with a `type` field
// but do not normalize it. This validates that the message is structured
// (not arbitrary data) but does not claim to understand its meaning.
type CinemaOSMessage = { type: string };

function isCinemaOSMessage(value: unknown): value is CinemaOSMessage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.type === 'string';
}

export class CinemaOSPlayerAdapter extends PostMessageAdapterBase implements PlayerProviderAdapter {
  protected readonly origin = CINEMAOS_ORIGIN;

  canHandle(source: PlayerSource): boolean {
    return this.canHandleByOrigin(source, CINEMAOS_ORIGIN);
  }

  load(_context: AdapterLoadContext): void {
    this.startListening();
  }

  destroy(): void {
    this.stopListening();
  }

  getCapabilities(): ProviderPlaybackCapabilities {
    return CINEMAOS_CAPABILITIES;
  }

  protected handleMessage(_event: MessageEvent): void {
    // Validate the message is a structured object (has a `type` string field)
    // but do NOT normalize — the exact payload structure is UNKNOWN.
    // Silently drop recognized-but-unverified messages.
    const _message = safeParseMessage(_event.data, isCinemaOSMessage);
    // Intentional no-op: the CinemaOS API exists but the exact event names
    // and payload structure could not be extracted from the JS-rendered
    // docs. Phase 5+ may revisit if the docs become server-extractable.
  }
}
