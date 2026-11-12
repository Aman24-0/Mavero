import type { PlayerSource } from '$lib/shared/player';
import { TGVID_CAPABILITIES, type ProviderPlaybackCapabilities } from '../capabilities';
import type { AdapterLoadContext, CommandResult, PlayerProviderAdapter } from '../events';
import { PostMessageAdapterBase, extractNumber, safeParseMessage } from './post-message-utils';

/**
 * TGVID adapter — tgvid.lovable.app (2026-10 integration).
 *
 * Provider contract (VERIFIED against the official documentation at
 * https://tgvid.lovable.app/docs on 2026-10-16; see TGVID_CAPABILITIES for
 * the capability truth table):
 *
 *   URL:     https://tgvid.lovable.app/embed/movie/{tmdbId}
 *            https://tgvid.lovable.app/embed/tv/{tmdbId}/{season}/{episode}
 *   Resume:  ?t=<seconds> — "Start the video at a specific time … Overrides
 *            the saved resume position." Mavero's resume position wins over
 *            the provider-side saved position (never the reverse).
 *   Theming: ?color=<hex without '#'> — applied at load time from the live
 *            Mavero accent token (same pattern as VidStuck/VidRift).
 *   Language: ?lang=hi is baked into the seeded templates — the docs define
 *            lang as the preferred audio language and note Hindi-dub
 *            servers are listed first. Hindi availability per title is the
 *            PROVIDER's decision (its own server list is authoritative);
 *            Mavero never promises Hindi audio for every title.
 *   Episode isolation: the seeded templates set episodeSelector=false and
 *            autoplayNextEp=false so the iframe always plays exactly the
 *            episode Mavero resolved. Rationale: TGFLIX_EVENT carries
 *            tmdbId/mediaType but NO season/episode — an in-iframe episode
 *            switch would advance playback while Mavero's route, episode
 *            context and progress records still point at the previous
 *            episode, corrupting resume state. With the internal switchers
 *            off, episode navigation stays Mavero's (existing UI + route).
 *            back=false hides the provider's internal back button for the
 *            same reason Mavero hides ZXCStream's: navigation chrome is
 *            Mavero's shell (documented parameter, behavior verified by
 *            the docs' own example `?back=false`).
 *
 *   postMessage (player → parent, origin https://tgvid.lovable.app):
 *     {type:"TGFLIX_EVENT", event, currentTime, duration, paused, tmdbId,
 *      mediaType, source}. Normalized here:
 *       timeupdate → timeupdate {currentTime, duration?}
 *       pause      → timeupdate {currentTime?} THEN pause (position flush
 *                    accuracy — mirrors direct playback's timeupdate→pause)
 *       play|playing → play (+ buffering:false for `playing`)
 *       buffering  → buffering {value:true}
 *       seeked     → seeked {currentTime} (requires a finite currentTime)
 *       ended      → ended
 *       ready      → ready {duration?}
 *       error      → provider-error (FIXED generic message — the payload
 *                    documents no error detail field; nothing is invented)
 *       volume|source|state → acknowledged, never normalized (no parent-
 *                    facing counterpart; `state` is the response to a
 *                    getState command Mavero does not use).
 *
 *   Commands (parent → player): {type:"TGFLIX_CMD", cmd, value} posted to
 *     iframe.contentWindow with the EXACT target origin
 *     'https://tgvid.lovable.app' — the documentation's example uses "*"
 *     and Mavero deliberately does not. Documented cmds: play, pause,
 *     seek(seconds), volume(0-1), mute, unmute, getState. Mavero implements
 *     play/pause/seek/volume; getState is NOT implemented (no documented
 *     response correlation — a fabricated "current time" answer would
 *     violate the never-trust-unverified contract). A command is reported
 *     ok:true only after the postMessage call itself succeeded; success of
 *     the command INSIDE the embed is never assumed.
 *
 * Stale-event protection (in order):
 *   1. `destroyed` flag (base class) — the PlaybackManager destroys the
 *      adapter on every source change; late events die there.
 *   2. event.origin strict equality with the documented origin (base class).
 *   3. event.source — when both the active iframe ref and event.source are
 *      known, messages from any other frame are dropped.
 *   4. Content-tag validation: tmdbId/mediaType are parsed from the ACTIVE
 *      source URL at load time and every message's tags are compared against
 *      them — a mismatching message can never touch progress.
 *   5. Shape validation: unknown event names, non-finite/negative times and
 *      non-object payloads are silently dropped.
 */

const TGVID_ORIGIN = 'https://tgvid.lovable.app';

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

type TgvidMessage = {
  event?: unknown;
  currentTime?: unknown;
  duration?: unknown;
  tmdbId?: unknown;
  mediaType?: unknown;
};

function isTgvidMessage(value: unknown): value is TgvidMessage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return (value as Record<string, unknown>).type === 'TGFLIX_EVENT';
}

/** Numeric tag → canonical string ('number' | numeric string), else null. */
function tagToString(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'string' && value.length > 0) return value;
  return null;
}

/**
 * Parses the content tags embedded in an active TGVID source URL:
 *   /embed/movie/{tmdbId}        → { tmdbId, mediaType: 'movie' }
 *   /embed/tv/{tmdbId}/s/e       → { tmdbId, mediaType: 'tv' }
 * Returns null for URLs outside the documented shapes (never guessed).
 */
export function parseTgvidContentTags(url: string): { tmdbId: string; mediaType: 'movie' | 'tv' } | null {
  try {
    const parsed = new URL(url);
    if (parsed.origin.toLowerCase() !== TGVID_ORIGIN) return null;
    const segments = parsed.pathname.split('/').filter((segment) => segment.length > 0);
    // [ 'embed', 'movie'|'tv', tmdbId, ...season/episode ]
    if (segments.length < 3 || segments[0] !== 'embed') return null;
    const mediaType = segments[1];
    if (mediaType !== 'movie' && mediaType !== 'tv') return null;
    const tmdbId = segments[2];
    if (!/^\d{1,16}$/.test(tmdbId)) return null;
    return { tmdbId, mediaType };
  } catch {
    return null;
  }
}

export class TgvidPlayerAdapter extends PostMessageAdapterBase implements PlayerProviderAdapter {
  protected readonly origin = TGVID_ORIGIN;

  private iframe: HTMLIFrameElement | undefined;
  private expectedTags: { tmdbId: string; mediaType: 'movie' | 'tv' } | null = null;

  canHandle(source: PlayerSource): boolean {
    return this.canHandleByOrigin(source, TGVID_ORIGIN);
  }

  load(context: AdapterLoadContext): void {
    // Content tags come from the ACTIVE source URL — the same URL the
    // iframe was mounted with. Messages whose tags disagree are stale or
    // foreign and can never touch Mavero's progress.
    this.expectedTags = context.source.url ? parseTgvidContentTags(context.source.url) : null;
    this.startListening();
  }

  destroy(): void {
    this.stopListening();
    this.iframe = undefined;
    this.expectedTags = null;
  }

  getCapabilities(): ProviderPlaybackCapabilities {
    return TGVID_CAPABILITIES;
  }

  startAtParam(): string | null {
    return 't';
  }

  setIframe(iframe: HTMLIFrameElement): void {
    this.iframe = iframe;
  }

  /**
   * Dynamic accent color: TGVID's documented `color` parameter takes a hex
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

  /**
   * Posts one documented TGFLIX_CMD to the ACTIVE iframe's contentWindow
   * with the EXACT target origin (never '*'). Returns not-ready when the
   * iframe ref is absent/destroyed; ok:true only after the postMessage
   * call itself succeeded. Whether the embed APPLIES the command is the
   * provider's business — no success is ever assumed or faked.
   */
  private sendCommand(cmd: string, value?: number): CommandResult {
    const frame = this.iframe;
    if (this.destroyed || !frame || !frame.contentWindow) return { ok: false, reason: 'not-ready' };
    try {
      const payload: Record<string, unknown> = { type: 'TGFLIX_CMD', cmd };
      if (value !== undefined) payload.value = value;
      frame.contentWindow.postMessage(payload, TGVID_ORIGIN);
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: 'provider-error', message: error instanceof Error ? error.message : undefined };
    }
  }

  play(): Promise<CommandResult> {
    return Promise.resolve(this.sendCommand('play'));
  }

  pause(): Promise<CommandResult> {
    return Promise.resolve(this.sendCommand('pause'));
  }

  seek(seconds: number): Promise<CommandResult> {
    // Documented: seek takes seconds. Reject non-finite/negative values at
    // the boundary — never forward a malformed command to the provider.
    if (!Number.isFinite(seconds) || seconds < 0) return Promise.resolve({ ok: false, reason: 'unsupported' });
    return Promise.resolve(this.sendCommand('seek', Math.floor(seconds)));
  }

  setVolume(volume: number): Promise<CommandResult> {
    // Documented: volume is 0-1. Out-of-range values are rejected locally.
    if (!Number.isFinite(volume) || volume < 0 || volume > 1) return Promise.resolve({ ok: false, reason: 'unsupported' });
    return Promise.resolve(this.sendCommand('volume', volume));
  }

  protected handleMessage(event: MessageEvent): void {
    // event.source validation (task contract): when both sides are known,
    // only the ACTIVE iframe's contentWindow may address this adapter.
    const frame = this.iframe;
    if (frame && event.source && event.source !== frame.contentWindow) return;

    const message = safeParseMessage(event.data, isTgvidMessage);
    if (!message) return;

    // Content-tag validation — tmdbId/mediaType are documented payload
    // fields. When present they MUST match the active source's tags; a
    // mismatch marks a stale/foreign message and it is dropped wholesale.
    if (this.expectedTags) {
      const messageTmdb = tagToString(message.tmdbId);
      if (messageTmdb !== null && messageTmdb !== this.expectedTags.tmdbId) return;
      const messageMediaType = tagToString(message.mediaType);
      if (messageMediaType !== null && messageMediaType !== this.expectedTags.mediaType) return;
    }

    const eventName = typeof message.event === 'string' ? message.event : null;
    if (!eventName) return;
    const currentTime = extractNumber(message as unknown as Record<string, unknown>, 'currentTime');
    const duration = extractNumber(message as unknown as Record<string, unknown>, 'duration');

    switch (eventName) {
      case 'timeupdate': {
        if (currentTime === null) return;
        this.emit({ type: 'timeupdate', currentTime, duration: duration ?? undefined });
        return;
      }
      case 'pause': {
        // Flush the final position BEFORE the pause event so the existing
        // progress writer records the accurate timestamp (the same
        // timeupdate→pause ordering direct playback produces).
        if (currentTime !== null) this.emit({ type: 'timeupdate', currentTime, duration: duration ?? undefined });
        this.emit({ type: 'pause' });
        return;
      }
      case 'play': {
        this.emit({ type: 'play' });
        return;
      }
      case 'playing': {
        this.emit({ type: 'play' });
        this.emit({ type: 'buffering', value: false });
        return;
      }
      case 'buffering': {
        this.emit({ type: 'buffering', value: true });
        return;
      }
      case 'seeked': {
        if (currentTime === null) return;
        this.emit({ type: 'seeked', currentTime });
        return;
      }
      case 'ended': {
        this.emit({ type: 'ended' });
        return;
      }
      case 'ready': {
        this.emit({ type: 'ready', ...(duration !== null ? { duration } : {}) });
        return;
      }
      case 'error': {
        // Fixed generic message — the documented payload carries no error
        // detail field and none is invented.
        this.emit({ type: 'provider-error', message: 'TGVID reported a playback error.' });
        return;
      }
      default:
        // volume | source | state | unknown — acknowledged, never normalized.
        return;
    }
  }
}
