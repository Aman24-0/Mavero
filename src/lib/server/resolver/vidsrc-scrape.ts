/**
 * DirectStream — vidsrc scraper resolver adapter (2026-10 round 13).
 *
 * This adapter is the bridge between the existing resolver pipeline and the
 * new vidsrc scraper module. When the user selects the "DirectStream" source
 * (seeded by migration 20261029000000), the resolver's `adapterFor()` dispatches
 * here (the provider's `adapter_id` is `'vidsrc-scrape'`).
 *
 * The adapter:
 *   1. Reads the scraper config from `app_config` (admin-editable at
 *      /admin/system/direct-stream — the embed domain + CDN domains are
 *      config-driven so domain rotations don't need a code change).
 *   2. Calls `scrapeVidsrc()` to extract the real `.m3u8` URL from vidsrc's
 *      3-hop embed chain.
 *   3. Wraps the raw m3u8 in a Worker-proxied URL (with the required Referer
 *      baked in as `&r=`). The browser cannot set `Referer` (it's a forbidden
 *      header), so the Cloudflare Worker adds it server-side — this is the
 *      ONLY way to play vidsrc streams in the browser.
 *   4. Returns a `direct` HLS source — the existing HLS engine (hls.js via
 *      Video.js) handles playback, quality levels and audio tracks. No
 *      PlayerShell or engine changes are needed.
 *
 * WHY A SEPARATE ADAPTER (not the template adapter): the scraper does real
 * upstream work (3 HTTP hops) that the template adapter cannot express. The
 * result URL is a Worker URL (not the provider's templated URL), and the
 * `protocol: 'hls'` metadata must be set explicitly (the Worker URL has no
 * `.m3u8` extension, so `protocolForUrl()` would return `undefined`).
 *
 * ERROR MAPPING: the scraper's `ScraperError` codes map to the resolver's
 * existing typed error vocabulary so the bounded fallback walk, negative
 * cache and provider cooldown behave exactly as for every other provider:
 *   * INVALID_PARAMS          → MISSING_IDENTIFIER (the resolver request was
 *                               malformed — the resolver should never produce
 *                               this, but fail closed just in case)
 *   * UPSTREAM_TIMEOUT        → RESOLUTION_TIMEOUT
 *   * SCRAPE_FAILED           → RESOLUTION_UNAVAILABLE (retryable — the
 *                               bounded fallback walk continues to the next
 *                               source)
 *   * NO_SOURCES              → RESOLUTION_UNAVAILABLE (the title may exist
 *                               on another source)
 *
 * SECURITY: the adapter NEVER logs playback URLs or tokens. The scrape runs
 * server-side (no CORS); the returned URL is a Worker URL (permissive CORS).
 */

import { ResolverError } from './errors';
import { validatePlaybackUrl } from './safe-url';
import type { AdapterResult, ProviderAdapter, ResolverContext } from './types';
import { env as publicEnv } from '$env/dynamic/public';
import { createSupabaseAdminClient } from '$lib/server/supabase/admin';
import { getScraperConfig } from '$lib/server/app-config';
import { scrapeVidsrc, ScraperError, DEFAULT_SCRAPER_CONFIG } from '$lib/server/vod/vidsrc-scraper';
import { scrapeVidCore } from '$lib/server/vod/vidcore-scraper';

export const VIDSRC_SCRAPE_ADAPTER_ID = 'vidsrc-scrape' as const;

/** TMDB ids are positive decimal integers, no leading zeros (TMDB canonical form). */
const TMDB_ID_PATTERN = /^[1-9][0-9]{0,15}$/;

function requireTmdbId(raw: string | undefined): string {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!TMDB_ID_PATTERN.test(value)) throw new ResolverError('MISSING_IDENTIFIER');
  return value;
}

function requirePositiveInt(raw: number | undefined): number {
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1) {
    throw new ResolverError('MISSING_IDENTIFIER');
  }
  return raw;
}

/**
 * Maps a `ScraperError` to the resolver's typed error vocabulary. The
 * resolver's bounded fallback walk, negative cache and provider cooldown
 * behave exactly as for every other provider.
 *
 * 2026-10 round 19 — each error code now has a SPECIFIC user-facing message
 * so the user knows exactly WHY the stream failed (not just the code).
 */
function mapScraperError(error: ScraperError): ResolverError {
  switch (error.code) {
    case 'INVALID_PARAMS':
      return new ResolverError('MISSING_IDENTIFIER');
    case 'UPSTREAM_TIMEOUT':
      console.error('[vidsrc-scrape] scraper timed out.', error.message);
      return overrideMessage(new ResolverError('RESOLUTION_TIMEOUT'), 'DirectStream timed out. The video provider took too long to respond. Please try again or select another source.');
    case 'CLOUDFLARE_BLOCKED':
      console.error('[vidsrc-scrape] Cloudflare blocked the scraper. The scraper IP may be flagged.', error.message);
      return overrideMessage(new ResolverError('RESOLUTION_UNAVAILABLE'), 'CDN blocked: the video provider is blocking requests. Please try another source.');
    case 'REGEX_PARSE_FAILED':
      console.error('[vidsrc-scrape] API response parsing failed (vidsrc.party contract may have changed).', error.message);
      return overrideMessage(new ResolverError('RESOLUTION_UNAVAILABLE'), 'DirectStream unavailable: the video provider changed its API. Please try another source.');
    case 'NO_SOURCES':
      console.error('[vidsrc-scrape] no sources found.', error.message);
      return overrideMessage(new ResolverError('RESOLUTION_UNAVAILABLE'), 'Stream expired or unavailable. Please try again or select another source.');
    case 'SCRAPE_FAILED':
    default:
      console.error('[vidsrc-scrape] scrape failed.', error.code, error.message);
      return overrideMessage(new ResolverError('RESOLUTION_UNAVAILABLE'), 'DirectStream unavailable. Please try another source.');
  }
}

/**
 * Overrides the `message` on a `ResolverError` so the player UI shows a
 * DirectStream-specific message instead of the generic shared one. The
 * `code` and `status` are preserved (so the bounded fallback walk, negative
 * cache and provider cooldown behave correctly).
 */
function overrideMessage(error: ResolverError, message: string): ResolverError {
  Object.defineProperty(error, 'message', { value: message, configurable: true, writable: true });
  return error;
}

/**
 * Builds the playback URL for the resolver result.
 *
 * 2026-10 round 19 — the resolver returns the RAW vidsrc.party manifest URL
 * (https://vidsrc.party/v/{token}/stream) and lets the CLIENT-SIDE player
 * route it through the proxy. This mirrors how Live TV works: the resolver
 * returns the raw CDN URL, and the client's `wireHlsEngine` checks
 * `isLivetvProxyUrl()` and wraps it in the proxy URL (Worker or in-app).
 *
 * WHY NOT wrap it server-side? The resolver core's `validatePlaybackUrl`
 * rejects relative URLs (like `/api/livetv/stream-proxy?u=...`) for `direct`
 * type sources — it only accepts absolute https URLs. Wrapping it server-side
 * with the Worker URL works, but only when `PUBLIC_STREAM_PROXY_URL` is set.
 * When it's NOT set, the in-app proxy fallback is a relative URL that the
 * resolver core rejects with INVALID_SOURCE_URL. Returning the raw URL +
 * routing client-side works in ALL cases.
 *
 * The Worker URL is still used when `PUBLIC_STREAM_PROXY_URL` is set (the
 * resolver wraps it server-side so the client doesn't need to know about
 * the proxy). When it's NOT set, the raw URL is returned and the client's
 * `wireHlsEngine` routes it through the in-app proxy.
 */
function buildPlaybackUrl(rawManifestUrl: string, _referer: string): string {
  const workerBase = (publicEnv.PUBLIC_STREAM_PROXY_URL ?? '').replace(/\/+$/, '');
  if (workerBase) {
    // Worker configured — wrap server-side (the Worker adds CORS + Referer).
    return `${workerBase}/?u=${encodeURIComponent(rawManifestUrl)}&r=${encodeURIComponent(_referer)}`;
  }
  // No Worker — return the raw URL. The client-side wireHlsEngine will route
  // it through the in-app proxy (/api/livetv/stream-proxy) via the
  // isLivetvProxyUrl() check (same as Live TV does).
  return rawManifestUrl;
}

export const vidsrcScrapeProviderAdapter: ProviderAdapter = {
  integrationType: 'api',
  adapterId: VIDSRC_SCRAPE_ADAPTER_ID,
  async resolve(context): Promise<AdapterResult> {
    // Defensive media-type gate (mirrors bluevelvet/vixolity): the resolver
    // pipeline only produces 'movie' | 'series' requests; anything else
    // fails closed through the existing typed error.
    if (context.request.mediaType !== 'movie' && context.request.mediaType !== 'series') {
      throw new ResolverError('UNSUPPORTED_MEDIA_TYPE');
    }

    // Identity: TMDB id from the resolver context (never internal DB ids).
    const tmdbId = requireTmdbId(context.identifiers.tmdbId);

    // Season/episode for TV.
    let season: number | undefined;
    let episode: number | undefined;
    if (context.request.mediaType === 'series') {
      season = requirePositiveInt(context.request.season);
      episode = requirePositiveInt(context.request.episode);
    }

    // Read the scraper config from app_config. Falls back to defaults on
    // any read error — the scraper is always usable.
    let config = DEFAULT_SCRAPER_CONFIG;
    let enabled = false;
    try {
      const client = createSupabaseAdminClient();
      const scraperState = await getScraperConfig(client);
      config = scraperState.config;
      enabled = scraperState.enabled;
    } catch {
      // Config read failed — stay disabled (fail closed).
    }

    // The global enable gate. The admin can disable the scraper from the
    // DirectStream admin page without touching the streaming_sources row.
    if (!enabled) {
      throw new ResolverError('SOURCE_DISABLED');
    }

    // Scrape.
    // 2026-10 round 30 — route by SOURCE SLUG (not variant). The source slug
    // is on the config.source (the streaming_sources row). Two sources share
    // the same adapter:
    //   'direct-stream-vidsrc' → scrapeVidsrc() (DirectStream / vidsrc.party)
    //   'multi-stream-vidcore' → scrapeVidCore() (Multi Stream / vidcore.org)
    // Also check the variant for backward compat (old scraper sheet used variant).
    const sourceSlug = context.config.source.slug ?? '';
    const useVidCore = sourceSlug === 'multi-stream-vidcore' || context.request.variant === 'vidcore';
    let result;
    try {
      result = useVidCore
        ? await scrapeVidCore(
            tmdbId,
            context.request.mediaType === 'movie' ? 'movie' : 'tv',
            season,
            episode
          )
        : await scrapeVidsrc(
            tmdbId,
            context.request.mediaType === 'movie' ? 'movie' : 'tv',
            season,
            episode,
            config
          );
    } catch (error) {
      if (error instanceof ScraperError) throw mapScraperError(error);
      throw new ResolverError('RESOLUTION_UNAVAILABLE', error);
    }

    if (result.sources.length === 0) {
      throw new ResolverError('RESOLUTION_UNAVAILABLE');
    }

    const firstSource = result.sources[0]!;

    // 2026-10 round 19 — build the playback URL. When the Worker is
    // configured, wrap the manifest URL server-side (the Worker adds CORS
    // + Referer). When it's NOT configured, return the raw vidsrc.party URL
    // — the client-side wireHlsEngine will route it through the in-app proxy
    // via the isLivetvProxyUrl() check (same as Live TV).
    const playbackUrl = buildPlaybackUrl(firstSource.url, result.referer);

    // Validate the playback URL. The Worker URL is https and not a private
    // host, so this passes. The raw vidsrc.party URL is also https and passes.
    // Both are absolute https URLs — validatePlaybackUrl('direct') accepts them.
    const safeUrl = validatePlaybackUrl(playbackUrl, 'direct');

    // Direct HLS result — the existing HLS engine owns playback, quality
    // levels and audio-track discovery from the manifest. protocol: 'hls'
    // is set explicitly because the Worker URL has no .m3u8 extension (the
    // engine's extension sniff would return undefined).
    return {
      type: 'direct',
      url: safeUrl,
      protocol: 'hls',
      metadata: {
        providerName: context.config.provider.name,
        sourceName: context.config.source.name,
        protocol: 'hls',
      },
    };
  },
};
