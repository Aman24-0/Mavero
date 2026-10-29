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
 */
function mapScraperError(error: ScraperError): ResolverError {
  switch (error.code) {
    case 'INVALID_PARAMS':
      return new ResolverError('MISSING_IDENTIFIER');
    case 'UPSTREAM_TIMEOUT':
      return new ResolverError('RESOLUTION_TIMEOUT');
    case 'NO_SOURCES':
    case 'SCRAPE_FAILED':
    default:
      return new ResolverError('RESOLUTION_UNAVAILABLE');
  }
}

/**
 * Builds the Worker-proxied URL for a raw m3u8 URL. The Worker adds the
 * required Referer server-side (the browser cannot set Referer).
 */
function buildProxiedUrl(rawM3u8: string, referer: string): string {
  const workerBase = (publicEnv.PUBLIC_STREAM_PROXY_URL ?? '').replace(/\/+$/, '');
  if (workerBase) {
    return `${workerBase}/?u=${encodeURIComponent(rawM3u8)}&r=${encodeURIComponent(referer)}`;
  }
  // Fallback: the in-app SvelteKit proxy. Same ?u=&r= contract.
  return `/api/livetv/stream-proxy?u=${encodeURIComponent(rawM3u8)}&r=${encodeURIComponent(referer)}`;
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
    let result;
    try {
      result = await scrapeVidsrc(
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

    // Wrap the raw m3u8 in a Worker-proxied URL (with the required Referer).
    // The Worker URL is what the browser's HLS engine loads — the Worker
    // adds the Referer server-side (the browser cannot set Referer).
    const rawM3u8 = result.sources[0]!.url;
    const proxiedUrl = buildProxiedUrl(rawM3u8, result.referer);

    // Validate the proxied URL. The Worker URL is https and not a private
    // host, so this passes. For the in-app fallback (`/api/livetv/stream-proxy`),
    // validatePlaybackUrl accepts same-origin relative URLs for embed type —
    // but for 'direct' type it requires https. The in-app proxy fallback is
    // a relative URL, which validatePlaybackUrl('direct') would reject. We
    // therefore only validate when the URL is absolute (the Worker case).
    let safeUrl: string;
    if (proxiedUrl.startsWith('https://')) {
      safeUrl = validatePlaybackUrl(proxiedUrl, 'direct');
    } else {
      // Same-origin relative URL (the in-app proxy fallback). Accept it —
      // the browser treats it as same-origin, and the proxy endpoint has
      // its own SSRF guard + allowlist.
      safeUrl = proxiedUrl;
    }

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
