import type { PlayerSource } from '$lib/shared/player';
import { VIDSTUCK_CAPABILITIES, type ProviderPlaybackCapabilities } from '../capabilities';
import type { AdapterLoadContext, PlayerProviderAdapter } from '../events';
import { PostMessageAdapterBase, extractNumber, safeParseMessage } from './post-message-utils';

/**
 * VidStuck adapter — vidstuck.cc (2026-10 domain migration from .xyz).
 *
 * Provider contract (re-verified live 2026-10-16; see VIDSTUCK_CAPABILITIES
 * for the full verification notes):
 *
 *   URL:   https://vidstuck.cc/embed/movie/{tmdbId}?branding=…&server=…&color=…
 *          https://vidstuck.cc/embed/tv/{tmdbId}/{season}/{episode}?…
 *          (VERIFIED live: the .cc embed URLs return HTTP 200 with ZERO
 *           redirects — the player STAYS on vidstuck.cc. The old
 *           vidstuck.xyz → embed.vidstuck.xyz redirect pair is DEAD —
 *           both .xyz hosts fail connections, so .cc is the ONLY origin:
 *           embed origin AND postMessage origin are the same host.)
 *   Resume param: progress (seconds) — verified live at the .xyz era:
 *          playback started at exactly 120s with progress=120, and the
 *          provider bundle seeds t.currentTime from it. The parameter is
 *          PRESERVED unchanged — the .cc page bundle still accepts the
 *          documented query parameters (verified 2026-10-16: branding,
 *          server, dubLang, dubType, loading, back are consumed by the
 *          app bundle; none rejected).
 *
 *   postMessage (player → parent, origin https://vidstuck.cc):
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
const VIDSTUCK_EMBED_ORIGIN = 'https://vidstuck.cc';
const VIDSTUCK_MESSAGE_ORIGIN = 'https://vidstuck.cc';

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
   * Message origin validation is STRICT: only the verified .cc origin
   * (https://vidstuck.cc). The 2026-10-16 live probe proved the embed stays
   * on vidstuck.cc with zero redirects (the old vidstuck.xyz →
   * embed.vidstuck.xyz redirect pair is dead), so the embed origin and the
   * message origin are THE SAME host — see canHandle.
   */
  protected readonly origin = VIDSTUCK_MESSAGE_ORIGIN;

  canHandle(source: PlayerSource): boolean {
    // The verified current host. (The dead .xyz hosts are intentionally NOT
    // matched — a .xyz URL can no longer reach a live player, and accepting
    // a dead origin would only produce a guaranteed playback error.)
    if (this.canHandleByOrigin(source, VIDSTUCK_EMBED_ORIGIN)) return true;
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
