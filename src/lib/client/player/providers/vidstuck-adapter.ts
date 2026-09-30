import type { PlayerSource } from '$lib/shared/player';
import { VIDSTUCK_CAPABILITIES, type ProviderPlaybackCapabilities } from '../capabilities';
import type { AdapterLoadContext, PlayerProviderAdapter } from '../events';
import { PostMessageAdapterBase, extractNumber, safeParseMessage } from './post-message-utils';

/**
 * VidStuck adapter — vidstuck.xyz / embed.vidstuck.xyz.
 *
 * Provider contract (verified 2026-09-26; see VIDSTUCK_CAPABILITIES for the
 * full verification notes):
 *
 *   URL:   https://vidstuck.xyz/embed/movie/{tmdbId}?branding=…&server=…&color=…
 *          https://vidstuck.xyz/embed/tv/{tmdbId}/{season}/{episode}?…
 *          (the documented vidstuck.xyz embed URL 302-redirects to
 *           embed.vidstuck.xyz, which is the origin that sends messages)
 *   Resume param: progress (seconds) — verified live: playback started at
 *          exactly 120s with progress=120, and the provider bundle seeds
 *          t.currentTime from it.
 *
 *   postMessage (player → parent, origin https://embed.vidstuck.xyz):
 *     VIDEO_PROGRESS — LIVE/BUNDLE form (object):
 *       {type:"VIDEO_PROGRESS", payload:{currentTime, duration, tmdbId,
 *        media_type, season, episode}}
 *     VIDEO_PROGRESS — DOCUMENTED legacy form (JSON string):
 *       {id, type:"movie"|"tv"|"anime", progress, timestamp, duration,
 *        season, episode}
 *     Both are mapped to the normalized `timeupdate` event. Only
 *     currentTime/duration are consumed — season/episode context stays
 *     canonical in the watch route's playback context, never re-derived
 *     from provider messages.
 *
 *   No play/pause/ended/seek events are documented or observed → completion
 *   keeps Mavero's explicit ended-event semantics (no heuristic).
 *
 *   VidStuck's internal server selection (andromeda/centaurus/atlas/milkyway,
 *   provider-internal) stays INSIDE the iframe — Mavero exposes exactly ONE
 *   VidStuck source and never models internal servers as Mavero sources.
 *   `server=centaurus` only seeds the default internal server.
 */
const VIDSTUCK_EMBED_ORIGIN = 'https://vidstuck.xyz';
const VIDSTUCK_MESSAGE_ORIGIN = 'https://embed.vidstuck.xyz';

/** Canonical Mavero accent CSS token (defined in src/app.css :root). */
const MAVERO_ACCENT_TOKEN = '--color-primary';

type VidStuckMessage = Record<string, unknown>;

function isVidStuckMessage(value: unknown): value is VidStuckMessage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  // Live/bundle form: {type:"VIDEO_PROGRESS", payload:{...}}.
  if (record.type === 'VIDEO_PROGRESS') return true;
  // Documented legacy form (posted as a JSON string): progress message with
  // a content-type discriminator and a numeric timestamp position.
  if (typeof record.timestamp === 'number' && typeof record.type === 'string'
    && (record.type === 'movie' || record.type === 'tv' || record.type === 'anime')) return true;
  return false;
}

/** Extract a hex color (3/6/8 digits) from a CSS token value, without '#'. */
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

export class VidStuckPlayerAdapter extends PostMessageAdapterBase implements PlayerProviderAdapter {
  /**
   * Message origin validation is STRICT: only the post-redirect origin that
   * was observed sending messages (https://embed.vidstuck.xyz). The embed
   * URL itself uses the documented https://vidstuck.xyz host — see canHandle.
   */
  protected readonly origin = VIDSTUCK_MESSAGE_ORIGIN;

  canHandle(source: PlayerSource): boolean {
    // Documented embed host (302-redirects to embed.vidstuck.xyz) and the
    // post-redirect host, in case a source is configured with it directly.
    if (this.canHandleByOrigin(source, VIDSTUCK_EMBED_ORIGIN)) return true;
    if (this.canHandleByOrigin(source, VIDSTUCK_MESSAGE_ORIGIN)) return true;
    return false;
  }

  load(_context: AdapterLoadContext): void {
    this.startListening();
  }

  destroy(): void {
    this.stopListening();
  }

  getCapabilities(): ProviderPlaybackCapabilities {
    return VIDSTUCK_CAPABILITIES;
  }

  startAtParam(): string | null { return 'progress'; }

  /**
   * Dynamic accent color: VidStuck's documented `color` parameter takes a
   * hex color WITHOUT '#'. The value is read from the canonical Mavero
   * theme token at load time — never hardcoded. Returns null (URL
   * unchanged) outside a browser or when the token is missing/invalid.
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
    const message = safeParseMessage(event.data, isVidStuckMessage);
    if (!message) return;

    if (message.type === 'VIDEO_PROGRESS') {
      // Live/bundle form: numbers live inside `payload`.
      const payload = message.payload;
      if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
        const inner = payload as Record<string, unknown>;
        const currentTime = extractNumber(inner, 'currentTime');
        if (currentTime === null) return;
        const duration = extractNumber(inner, 'duration');
        this.emit({ type: 'timeupdate', currentTime, duration: duration ?? undefined });
        return;
      }
      // Degenerate VIDEO_PROGRESS without a payload object — drop.
      return;
    }

    // Documented legacy form: `timestamp` is the playback position.
    const currentTime = extractNumber(message, 'timestamp');
    if (currentTime === null) return;
    const duration = extractNumber(message, 'duration');
    this.emit({ type: 'timeupdate', currentTime, duration: duration ?? undefined });
  }
}
