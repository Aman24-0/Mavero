import type { PlayerSource } from '$lib/shared/player';
import { VIDLY_CAPABILITIES, type ProviderPlaybackCapabilities } from '../capabilities';
import type { AdapterLoadContext, PlayerProviderAdapter } from '../events';
import { PostMessageAdapterBase, extractNumber, safeParseMessage } from './post-message-utils';

/**
 * Vidly adapter — vidly.pro (2026-11-17 integration).
 *
 * Provider contract (DOCUMENTED on the provider's own site,
 * https://vidly.pro/ — read 2026-11-17; see VIDLY_CAPABILITIES for the
 * verification status of every field):
 *
 *   URL:   https://vidly.pro/movie/{tmdbId}
 *          https://vidly.pro/tv/{tmdbId}/{season}/{episode}
 *          (no API key; the player picks server + quality itself)
 *   Resume param: `t` (documented "start position in seconds"). Appended by
 *          the PlaybackManager from startAtParam() — never in the template.
 *   Theming: `color=<hex without '#'>` — the documented accent parameter,
 *          applied at LOAD time by finalizeEmbedUrl() from the live Mavero
 *          accent token (the same hook VidStuck and ZXCStream use). Theme
 *          changes land on the NEXT embed (re)mount: rewriting the URL
 *          mid-session would remount the iframe and disrupt playback.
 *   postMessage (player -> parent, origin https://vidly.pro):
 *     VIDLY_PLAYER_EVENT — { data: { event: 'play' | 'pause' |
 *       'timeupdate' | 'ended', currentTime, duration, tmdbId, mediaType,
 *       season, episode } }; timeupdate fires every 10 s while playing.
 *     SYNC_HISTORY — { data: { media_id, media_type, title, duration,
 *       watched } }, sent alongside every player event.
 *
 * Deliberate limits:
 *   - No seek/volume/quality/play/pause COMMAND protocol is documented, so
 *     this adapter exposes no command methods — only the documented event
 *     stream (capabilities reflect that).
 *   - SYNC_HISTORY is NOT normalized: the documented `watched` field's unit
 *     (seconds vs a boolean flag) is unspecified, and guessing it would
 *     write a wrong watch position into Mavero's progress pipeline.
 *     `duration` there is also not tied to a playback position. The
 *     authoritative position comes from VIDLY_PLAYER_EVENT.currentTime.
 *   - Everything is validated by origin (https://vidly.pro) and shape
 *     before use; unknown or future messages are silently dropped, never
 *     executed.
 */

const VIDLY_ORIGIN = 'https://vidly.pro';

/** Canonical Mavero accent CSS token (defined in src/app.css :root). */
const MAVERO_ACCENT_TOKEN = '--color-primary';

/** Extract a hex color (3/6/8 digits) from the accent token, without '#'. */
function accentColorWithoutHash(): string | null {
  try {
    if (typeof window === 'undefined' || typeof document === 'undefined') return null;
    const win = window as unknown as { getComputedStyle?: typeof getComputedStyle };
    if (typeof win.getComputedStyle !== 'function') return null;
    const raw = win.getComputedStyle(document.documentElement).getPropertyValue(MAVERO_ACCENT_TOKEN).trim();
    const normalized = raw.replace(/^#/, '').trim();
    if (/^([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(normalized)) return normalized;
    return null;
  } catch {
    return null;
  }
}

/** Shape guard: `{ type: 'VIDLY_PLAYER_EVENT', data: { event: string } }`. */
function isVidlyPlayerEvent(value: unknown): value is { type: 'VIDLY_PLAYER_EVENT'; data: Record<string, unknown> } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (record.type !== 'VIDLY_PLAYER_EVENT') return false;
  const data = record.data;
  return Boolean(data) && typeof data === 'object' && !Array.isArray(data);
}

export class VidlyPlayerAdapter extends PostMessageAdapterBase implements PlayerProviderAdapter {
  /** Strict origin gate: only the documented https://vidly.pro origin. */
  protected readonly origin = VIDLY_ORIGIN;

  canHandle(source: PlayerSource): boolean {
    return this.canHandleByOrigin(source, VIDLY_ORIGIN);
  }

  load(_context: AdapterLoadContext): void {
    this.startListening();
  }

  destroy(): void {
    this.stopListening();
  }

  getCapabilities(): ProviderPlaybackCapabilities {
    return VIDLY_CAPABILITIES;
  }

  /** Documented resume parameter: `t` (seconds). */
  startAtParam(): string | null {
    return 't';
  }

  /**
   * Dynamic accent color: Vidly's documented `color` parameter takes a hex
   * color WITHOUT '#'. Read from the canonical Mavero theme token at load
   * time — never hardcoded. Returns null (URL unchanged) outside a browser
   * or when the token is missing/invalid.
   */
  finalizeEmbedUrl(url: string): string | null {
    const accent = accentColorWithoutHash();
    if (!accent) return null;
    try {
      const parsed = new URL(url);
      parsed.searchParams.set('color', accent);
      return parsed.toString();
    } catch {
      return null;
    }
  }

  protected handleMessage(event: MessageEvent): void {
    const message = safeParseMessage(event.data, isVidlyPlayerEvent);
    if (!message) return;

    const data = message.data;
    const kind = data.event;
    if (typeof kind !== 'string') return;

    const duration = extractNumber(data, 'duration');

    switch (kind) {
      case 'play':
        this.emit({ type: 'play' });
        return;
      case 'pause':
        this.emit({ type: 'pause' });
        return;
      case 'ended':
        this.emit({ type: 'ended' });
        return;
      case 'timeupdate': {
        const currentTime = extractNumber(data, 'currentTime');
        if (currentTime === null) return;
        this.emit({ type: 'timeupdate', currentTime, duration: duration ?? undefined });
        return;
      }
      default:
        // Unknown/future event name — dropped, never trusted.
        return;
    }
  }
}
