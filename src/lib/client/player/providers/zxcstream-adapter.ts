import type { PlayerSource } from '$lib/shared/player';
import { ZXCSTREAM_CAPABILITIES, type ProviderPlaybackCapabilities } from '../capabilities';
import type { PlayerProviderAdapter } from '../events';
import { PostMessageAdapterBase } from './post-message-utils';

/**
 * ZXCStream adapter — zxcstream.cc (2026-10 integration).
 *
 * Provider contract (VERIFIED against the provider's own in-site API
 * documentation on 2026-10-16; see ZXCSTREAM_CAPABILITIES):
 *
 *   URL:    https://zxcstream.cc/player/movie/{tmdbId}
 *           https://zxcstream.cc/player/tv/{tmdbId}/{season}/{episode}
 *   Params (seeded templates): dubLang=hi (documented Hindi value; the
 *           provider falls back to the original audio when a title has no
 *           Hindi dub — its own language response/UI stays authoritative,
 *           Mavero never promises Hindi audio), server=1 (documented
 *           "favorite server" example value). Deliberately NOT sent:
 *           domainAd (documented intro splash — unwanted), autoplay
 *           (documented MUTED autoplay — conflicts with Mavero's player
 *           UX), back (documented to SHOW the provider's back button when
 *           set; the documented default omits it and Mavero owns
 *           navigation chrome).
 *   Theming: color=<hex without '#'> — applied at LOAD time by this
 *           adapter's finalizeEmbedUrl hook from the live Mavero accent
 *           token (the documented accent parameter; same pattern as
 *           VidStuck's color hook).
 *
 * There is NO documented postMessage/event protocol and NO documented
 * startAt/resume parameter — so this adapter does not normalize events
 * (the base-class listener simply drops every message that fails the
 * strict origin + shape validation) and does not implement startAtParam.
 * The adapter exists for exactly two purposes: origin-identified registration
 * in the player adapter registry and the runtime `color` hook. Theme changes
 * are picked up on the NEXT embed (re)mount — re-writing the URL mid-session
 * would remount the iframe and disrupt playback, which the integration
 * contract forbids.
 */

const ZXCSTREAM_ORIGIN = 'https://zxcstream.cc';

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

export class ZxcStreamPlayerAdapter extends PostMessageAdapterBase implements PlayerProviderAdapter {
  protected readonly origin = ZXCSTREAM_ORIGIN;

  canHandle(source: PlayerSource): boolean {
    return this.canHandleByOrigin(source, ZXCSTREAM_ORIGIN);
  }

  load(): void {
    // Listener lifecycle only: no documented provider messages exist, so
    // nothing is normalized. Every message that reaches handleMessage
    // (origin-validated by the base class) is dropped by the no-op below.
    this.startListening();
  }

  destroy(): void {
    this.stopListening();
  }

  getCapabilities(): ProviderPlaybackCapabilities {
    return ZXCSTREAM_CAPABILITIES;
  }

  /**
   * Dynamic accent color: ZXCStream's documented `color` parameter takes a
   * hex color WITHOUT '#'. Read from the canonical Mavero theme token at
   * load time — never hardcoded. Returns null (URL unchanged) outside a
   * browser or when the token is missing/invalid.
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

  protected handleMessage(_event: MessageEvent): void {
    // No documented message protocol — nothing to normalize. Unknown or
    // future provider messages are silently dropped (never executed,
    // never trusted).
  }
}
