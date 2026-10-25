import type { PlayerSource } from '$lib/shared/player';
import { VIDRIFT_CAPABILITIES, type ProviderPlaybackCapabilities } from '../capabilities';
import type { AdapterLoadContext, PlayerProviderAdapter } from '../events';
import { PostMessageAdapterBase, extractNumber, safeParseMessage } from './post-message-utils';

/**
 * VidRift adapter — embed.vidrift.net (https://vidrift.net/docs).
 *
 * Provider contract (verified from the official documentation):
 *
 *   URL:   https://embed.vidrift.net/embed/movie/{tmdbId}
 *          https://embed.vidrift.net/embed/tv/{tmdbId}/{season}/{episode}
 *          (anime is TV content under the hood — the TV shape with the
 *           show's TMDB id; the legacy embed.vidrift.in host serves the
 *           same player but Mavero uses the CANONICAL .net origin only —
 *           a .in-configured source would fall through to the generic
 *           embed adapter, never to this adapter's .net-only listener)
 *
 *   Approved static params (DB template, never overridden here):
 *     brand=MAVERO · showTitle=1 · watermark=1 (reuses brandLogo) ·
 *     hide=fullscreen (ONLY fullscreen — Mavero owns fullscreen).
 *   Deliberately absent (documented defaults preserved): poster, exit,
 *     uiScale, controlBg, font, muted, autoplay, layout, mobileSheets.
 *
 *   Dynamic params (finalizeEmbedUrl — runtime values, never hardcoded):
 *     brandLogo={MAVERO_ORIGIN}/icons/favicon-32.png (the deployed Mavero
 *       origin serving Mavero's own static favicon asset — no GitHub
 *       dependency, no hardcoded domain)
 *     brandColor=<live --color-primary token, 6-digit hex without '#'>
 *
 *   postMessage (player → parent, origin https://embed.vidrift.net; all
 *   player messages carry tmdbId, mediaType, season, episode):
 *     vidrift:progress {currentTime, duration} — every 5s while playing
 *     vidrift:paused {currentTime} — pause, by the viewer or at the end
 *     vidrift:unpaused {currentTime} — started or resumed
 *     vidrift:ended — playback reached the end
 *     vidrift:nextup — once, 30s before the end (informational — dropped)
 *     vidrift:nextup-play — Up Next countdown/click fired (only sent once
 *       the page has sent vidrift:nextup-info)
 *     vidrift:episode {season, episode} — the player moved to a specific
 *       episode itself; the iframe swaps right after
 *     vidrift:ui-visible / vidrift:ui-hidden / vidrift:exit /
 *       vidrift:mobile-panel — acknowledged, dropped (Mavero renders no
 *       overlay UI, exit is disabled, mobileSheets stays OFF)
 *
 *   postMessage (parent → player, target origin https://embed.vidrift.net):
 *     vidrift:resume {currentTime} — the DOCUMENTED resume mechanism (NOT a
 *       URL parameter): "Safe to send before the video is ready; it is
 *       applied once it is." Delivered at three points for reliability —
 *       setIframe (early best-effort), the iframe 'load' event (player
 *       page definitely up), and the first message received from the
 *       player (channel proven live). All sends are idempotent seeks to
 *       the same position and stop once playback has reported a position
 *       at/after the resume point (never fights forward playback).
 *     vidrift:nextup-info {next: {season, episode} | null} — take over
 *       episodes with Mavero's authoritative next-episode context
 *       (undefined context = never sent: movies, or episode data
 *       unavailable — the player self-drives and Mavero follows via
 *       vidrift:episode).
 *
 *   Resume is NOT a URL parameter — startAtParam() returns null and the
 *   PlaybackManager's startAt URL-param path stays dormant for VidRift.
 *
 *   Stale/foreign-message defense: every message's tmdbId (and, for
 *   current-episode messages, season/episode) is checked against the
 *   loaded embed URL's own content tag — a message about a different
 *   title or episode than the one Mavero loaded is dropped, so an
 *   internally-swapped or stale iframe can never leak another episode's
 *   position into the current progress record.
 */
const VIDRIFT_ORIGIN = 'https://embed.vidrift.net';

/** Canonical Mavero accent CSS token (defined in src/app.css :root). */
const MAVERO_ACCENT_TOKEN = '--color-primary';

type VidRiftMessage = Record<string, unknown>;

function isVidRiftMessage(value: unknown): value is VidRiftMessage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.type === 'string' && record.type.startsWith('vidrift:');
}

/** The content identity of the loaded embed URL (parsed from the path). */
type VidRiftContentTag = { tmdbId: string; season?: number; episode?: number };

function parseVidRiftContentTag(url: string): VidRiftContentTag | null {
  try {
    const parsed = new URL(url);
    if (parsed.origin !== VIDRIFT_ORIGIN) return null;
    const segments = parsed.pathname.split('/').filter(Boolean);
    if (segments[0] !== 'embed') return null;
    if (segments[1] === 'movie' && segments.length === 3) {
      return /^[0-9]+$/.test(segments[2]) ? { tmdbId: segments[2] } : null;
    }
    if (segments[1] === 'tv' && segments.length === 5) {
      if (!/^[0-9]+$/.test(segments[2])) return null;
      const season = Number(segments[3]);
      const episode = Number(segments[4]);
      if (!Number.isInteger(season) || season < 1) return null;
      if (!Number.isInteger(episode) || episode < 1) return null;
      return { tmdbId: segments[2], season, episode };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * The Mavero logo URL for brandLogo/watermark: Mavero's OWN deployed
 * origin serving Mavero's own static favicon asset. Never GitHub, never a
 * hardcoded production domain. VidRift requires an https URL — non-https
 * origins (local http dev) omit the parameter (VidRift would ignore it).
 */
function maveroBrandLogoUrl(): string | null {
  try {
    if (typeof window === 'undefined' || !window.location) return null;
    const origin = window.location.origin;
    if (typeof origin !== 'string' || !origin.startsWith('https://')) return null;
    return `${origin}/icons/favicon-32.png`;
  } catch {
    return null;
  }
}

/**
 * The brandColor value: read from the CANONICAL live Mavero accent token
 * at load time (never hardcoded), normalized to VidRift's documented
 * 6-digit hex WITHOUT '#'. 3-digit shorthand is expanded and an alpha
 * channel is dropped — the visual value is preserved exactly.
 */
function vidriftBrandColor(): string | null {
  try {
    if (typeof window === 'undefined' || typeof document === 'undefined') return null;
    const win = window as unknown as { getComputedStyle?: typeof getComputedStyle };
    if (typeof win.getComputedStyle !== 'function') return null;
    const raw = win.getComputedStyle(document.documentElement).getPropertyValue(MAVERO_ACCENT_TOKEN).trim().replace(/^#/, '').trim();
    if (/^[0-9a-fA-F]{6}$/.test(raw)) return raw.toLowerCase();
    if (/^[0-9a-fA-F]{3}$/.test(raw)) return raw.toLowerCase().split('').map((digit) => digit + digit).join('');
    if (/^[0-9a-fA-F]{8}$/.test(raw)) return raw.toLowerCase().slice(0, 6);
    return null;
  } catch {
    return null;
  }
}

export class VidRiftPlayerAdapter extends PostMessageAdapterBase implements PlayerProviderAdapter {
  protected readonly origin = VIDRIFT_ORIGIN;

  /** The iframe element reference (set via setIframe after it renders). */
  private iframe: HTMLIFrameElement | null = null;

  /** One-time-per-iframe 'load' listener (removed in destroy). */
  private iframeLoadListener: (() => void) | null = null;

  /** The resume position for this session (0 = fresh start). */
  private startPosition = 0;

  /** Authoritative next-episode context (undefined = do not take over). */
  private nextEpisodeContext: { season: number; episode: number } | null | undefined = undefined;

  /** The loaded URL's content identity (foreign-message defense). */
  private contentTag: VidRiftContentTag | null = null;

  /** The last position the player reported (null before the first one). */
  private lastObservedTime: number | null = null;

  /** True once any message from the player has been received. */
  private playerAlive = false;

  canHandle(source: PlayerSource): boolean {
    // Canonical origin only. The documented legacy embed.vidrift.in host
    // is deliberately NOT matched — a .in source stays on the generic
    // black-box embed adapter rather than reaching this adapter's
    // .net-only message listener.
    return this.canHandleByOrigin(source, VIDRIFT_ORIGIN);
  }

  load(context: AdapterLoadContext): void {
    const requested = context.startPosition;
    this.startPosition = typeof requested === 'number' && Number.isFinite(requested) && requested > 0 ? requested : 0;
    this.nextEpisodeContext = context.nextEpisode;
    this.contentTag = typeof context.source.url === 'string' ? parseVidRiftContentTag(context.source.url) : null;
    this.lastObservedTime = null;
    this.playerAlive = false;
    this.startListening();
  }

  /**
   * Receive the iframe element reference from the manager (after the
   * iframe renders). Sends the early best-effort resume/nextup-info and
   * registers a one-time 'load' listener — the player page is definitely
   * loaded when it fires, so the documented messages are (re)delivered
   * then. The docs' "once the iframe has loaded" guidance for
   * vidrift:nextup-info maps to exactly this point.
   */
  setIframe(iframe: HTMLIFrameElement): void {
    this.iframe = iframe;
    this.sendResume();
    this.sendNextUpInfo();
    try {
      this.iframeLoadListener = () => {
        this.sendResume();
        this.sendNextUpInfo();
      };
      iframe.addEventListener('load', this.iframeLoadListener);
    } catch {
      /* must never throw */
    }
  }

  destroy(): void {
    if (this.iframe && this.iframeLoadListener) {
      try {
        this.iframe.removeEventListener('load', this.iframeLoadListener);
      } catch {
        /* must never throw */
      }
    }
    this.iframeLoadListener = null;
    this.iframe = null;
    this.stopListening();
  }

  getCapabilities(): ProviderPlaybackCapabilities {
    return VIDRIFT_CAPABILITIES;
  }

  /**
   * VidRift's documented resume mechanism is the `vidrift:resume`
   * postMessage — NOT a URL parameter. Returning null keeps the
   * PlaybackManager's startAt URL-param path dormant; the adapter sends
   * the documented message itself.
   */
  startAtParam(): string | null {
    return null;
  }

  /**
   * Dynamic brand parameters: brandLogo (Mavero's own deployed origin
   * serving its static favicon) and brandColor (the LIVE Mavero accent
   * token). Both are runtime values the static DB template cannot
   * express. Pure function of the input URL; returns null (URL unchanged)
   * outside a browser or when neither value is available. The manager
   * re-validates the result as an absolute http(s) URL.
   */
  finalizeEmbedUrl(url: string): string | null {
    const brandLogo = maveroBrandLogoUrl();
    const brandColor = vidriftBrandColor();
    if (!brandLogo && !brandColor) return null;
    try {
      const parsed = new URL(url);
      if (brandLogo) parsed.searchParams.set('brandLogo', brandLogo);
      if (brandColor) parsed.searchParams.set('brandColor', brandColor);
      return parsed.toString();
    } catch {
      return null;
    }
  }

  // ----- Parent → Player messages -----

  /** Post a message to the player with the EXACT documented target origin. */
  private postToPlayer(payload: Record<string, unknown>): void {
    if (this.destroyed) return;
    const target = this.iframe?.contentWindow;
    if (!target) return;
    try {
      target.postMessage(payload, VIDRIFT_ORIGIN);
    } catch {
      /* must never throw */
    }
  }

  /**
   * Send the documented resume seek. Idempotent (a repeated seek to the
   * same position is harmless) and self-limiting: once the player has
   * reported a position at/after the resume point, the resume has been
   * applied (or playback legitimately passed it) and is never re-sent —
   * the adapter never drags playback backwards.
   */
  private sendResume(): void {
    if (this.destroyed || this.startPosition <= 0) return;
    if (this.lastObservedTime !== null && this.lastObservedTime >= this.startPosition - 1) return;
    this.postToPlayer({ type: 'vidrift:resume', currentTime: Math.floor(this.startPosition) });
  }

  /**
   * Send the documented episode takeover. Never sent when the context is
   * undefined (movies / no episode data — the player self-drives);
   * `next: null` on the series finale clears the provider's next-up
   * affordance instead of showing a fake next episode.
   */
  private sendNextUpInfo(): void {
    if (this.destroyed || this.nextEpisodeContext === undefined) return;
    const next = this.nextEpisodeContext === null
      ? null
      : { season: this.nextEpisodeContext.season, episode: this.nextEpisodeContext.episode };
    this.postToPlayer({ type: 'vidrift:nextup-info', next });
  }

  // ----- Player → Parent messages -----

  /**
   * Foreign/stale-message defense. tmdbId is always checked against the
   * loaded URL's tag. season/episode are checked for CURRENT-episode
   * messages (progress/paused/unpaused/ended/nextup-play); the
   * vidrift:episode message is exempt because its season/episode describe
   * the episode the player is moving TO.
   */
  private messageMatchesContent(message: VidRiftMessage, isTargetMessage: boolean): boolean {
    if (!this.contentTag) return true; // URL not parseable — origin check already passed
    const rawTmdb = message.tmdbId;
    if (rawTmdb !== undefined && rawTmdb !== null && String(rawTmdb) !== this.contentTag.tmdbId) return false;
    if (!isTargetMessage) {
      const season = message.season;
      const episode = message.episode;
      if (typeof season === 'number' && this.contentTag.season !== undefined && season !== this.contentTag.season) return false;
      if (typeof episode === 'number' && this.contentTag.episode !== undefined && episode !== this.contentTag.episode) return false;
    }
    return true;
  }

  protected handleMessage(event: MessageEvent): void {
    const message = safeParseMessage(event.data, isVidRiftMessage);
    if (!message) return;

    // First contact from the player — its message listener is proven
    // live, so re-attempt delivery of the documented parent→player
    // messages (both idempotent).
    if (!this.playerAlive) {
      this.playerAlive = true;
      this.sendResume();
      this.sendNextUpInfo();
    }

    if (!this.messageMatchesContent(message, message.type === 'vidrift:episode')) return;

    switch (message.type) {
      case 'vidrift:progress': {
        const currentTime = extractNumber(message, 'currentTime');
        if (currentTime === null) return;
        const duration = extractNumber(message, 'duration');
        this.lastObservedTime = currentTime;
        this.emit({ type: 'timeupdate', currentTime, duration: duration ?? undefined });
        return;
      }
      case 'vidrift:paused': {
        const currentTime = extractNumber(message, 'currentTime');
        if (currentTime !== null) this.lastObservedTime = currentTime;
        this.emit({ type: 'pause' });
        return;
      }
      case 'vidrift:unpaused': {
        const currentTime = extractNumber(message, 'currentTime');
        if (currentTime !== null) this.lastObservedTime = currentTime;
        this.emit({ type: 'play' });
        return;
      }
      case 'vidrift:ended': {
        this.emit({ type: 'ended' });
        return;
      }
      case 'vidrift:nextup-play': {
        // The viewer finished this episode (Up Next countdown or an
        // explicit Play Next click). Complete the EXISTING progress
        // pipeline first (the normalized 'ended' event → writer.complete —
        // the episode must not linger as a nearly-complete resume
        // position), then signal the watch route to navigate through its
        // existing episode navigation. The provider does not echo the
        // next target — Mavero's own nextEpisode context is authoritative.
        this.emit({ type: 'ended' });
        this.emit({ type: 'next-episode' });
        return;
      }
      case 'vidrift:episode': {
        // The player moved itself to a specific episode (in-player list —
        // which normally "steps aside" once nextup-info is sent; this is
        // the defensive path). Mavero navigates to MATCH it so playback
        // context and progress can never desync; the watch route validates
        // the target against Mavero's own episode data before navigating.
        const season = extractNumber(message, 'season');
        const episode = extractNumber(message, 'episode');
        if (season === null || episode === null || !Number.isInteger(season) || !Number.isInteger(episode) || season < 1 || episode < 1) return;
        this.emit({ type: 'next-episode', season, episode });
        return;
      }
      // vidrift:ui-visible / vidrift:ui-hidden / vidrift:nextup /
      // vidrift:exit / vidrift:mobile-panel: documented, acknowledged,
      // not normalized — Mavero renders no overlay UI over the player,
      // exit is disabled, and mobileSheets stays OFF.
      default:
        return;
    }
  }
}
