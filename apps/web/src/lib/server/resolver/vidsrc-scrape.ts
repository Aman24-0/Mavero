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
 *      /admin/system/api-sources — the embed domain + CDN domains are
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
// VidCore/multi-stream REMOVED (round 36) — the multi-stream-vidcore source row
// was deleted from Supabase; the scraper and all references are purged.
// Round 36 — the rivestream adapter is called in-adapter to merge both
// sources into one grouped server list.
// Round 37 — VidPlay (NovaHD) REMOVED: the NovaHD API is behind Cloudflare's
// JS challenge and returns 403 server-side; the adapter + merge are purged.
// Round 38 — VidPlay (ThugTV): the thugtv adapter is called the same way
// (in-adapter merge — no new streaming_providers row, the new upstream
// lives INSIDE this vidsrc-scrape adapter like Rivestream/Vidstream).
// Round 40 — the Rivestream + VidPlay resolves run CONCURRENTLY
// (Promise.allSettled): a slow or failing ThugTV retry no longer adds its
// full backoff+attempt time to every resolve (observed 8.2s end-to-end).
// Round 41 — VidStart (ThugTV media API): the vidstart adapter joins the
// SAME concurrent merge (three adapters now). Merge order is the FIXED
// sequence Vidstream first, then VidPlay, then VidStart. VidStart exposes
// a single multi-quality / multi-audio HLS master (one server entry, no
// qualities/language — hls.js reads the levels from the manifest) and
// contributes no subtitles.
import { rivestreamAdapter } from './rivestream';
import { thugtvAdapter } from './thugtv';
import { vidstartAdapter } from './vidstart';

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
    // Round 36 — per-source toggles + default server. Read from app_config.
    let vidsrcEnabled = true;
    let vidstreamEnabled = true;
    // Round 38 — VidPlay (ThugTV) toggle + 'vidplay' default server.
    let thugtvEnabled = true;
    // Round 41 — VidStart (ThugTV media) toggle + 'vidstart' default server.
    let vidstartEnabled = true;
    let defaultServerPref = 'vidstream';
    try {
      const client = createSupabaseAdminClient();
      const scraperState = await getScraperConfig(client);
      config = scraperState.config;
      enabled = scraperState.enabled;
      // Read per-source toggles + default server from the same client.
      const { data: cfgRow } = await client.from('app_config').select('*').eq('id', 1).single();
      const cfgAny = cfgRow as Record<string, unknown> | null;
      if (cfgAny) {
        if (typeof cfgAny.direct_stream_vidsrc_enabled === 'boolean') vidsrcEnabled = cfgAny.direct_stream_vidsrc_enabled;
        if (typeof cfgAny.direct_stream_vidstream_enabled === 'boolean') vidstreamEnabled = cfgAny.direct_stream_vidstream_enabled;
        if (typeof cfgAny.direct_stream_thugtv_enabled === 'boolean') thugtvEnabled = cfgAny.direct_stream_thugtv_enabled;
        if (typeof cfgAny.direct_stream_vidstart_enabled === 'boolean') vidstartEnabled = cfgAny.direct_stream_vidstart_enabled;
        if (typeof cfgAny.direct_stream_default_server === 'string') {
          const val = cfgAny.direct_stream_default_server;
          if (val === 'vidstream' || val === 'vidsrc' || val === 'vidplay' || val === 'vidstart') defaultServerPref = val;
        }
      }
    } catch {
      // Config read failed — stay disabled (fail closed).
    }

    // The global enable gate. The admin can disable the scraper from the
    // DirectStream admin page without touching the streaming_sources row.
    if (!enabled) {
      throw new ResolverError('SOURCE_DISABLED');
    }

    // Scrape.
    // Round 36 — per-source toggles gate the scrape + merge.
    const sourceSlug = context.config.source.slug ?? '';
    let result: Awaited<ReturnType<typeof scrapeVidsrc>> | null = null;
    let firstSource: { url: string; quality?: string; server?: string; language?: string } | null = null;
    let resultReferer = '';

    if (vidsrcEnabled) {
      try {
        result = await scrapeVidsrc(
            tmdbId,
            context.request.mediaType === 'movie' ? 'movie' : 'tv',
            season,
            episode,
            config
          );
        if (result && result.sources.length > 0) {
          firstSource = result.sources[0]!;
          resultReferer = result.referer ?? '';
        }
      } catch (error) {
        if (!vidstreamEnabled) {
          // Vidsrc failed and Vidstream is disabled — propagate the error.
          if (error instanceof ScraperError) throw mapScraperError(error);
          throw new ResolverError('RESOLUTION_UNAVAILABLE', error);
        }
        // Vidsrc failed but Vidstream is enabled — continue to Vidstream.
      }
    }

    if (!firstSource && !vidstreamEnabled) {
      throw new ResolverError('RESOLUTION_UNAVAILABLE');
    }

    // 2026-10 round 32/33 — MULTI-SERVER WIRE: every scraped source becomes a
    // playback candidate. `url` stays the FIRST source (validated below —
    // the primary stream, unchanged from the pre-round behaviour), and the
    // FULL ordered list rides `metadata.servers` so the player can render
    // the Server menu and auto-fall-back when a server dies. Each entry is
    // wrapped through the SAME buildPlaybackUrl path as the primary (Worker
    // proxy + Referer) and https-validated before it is exposed; anything
    // that fails validation is dropped, never coerced. The label composes
    // the server name with its audio language ("Tethys (English)",
    // "Enceladus (Hindi)") — the celestial roster's per-server language.
    const servers: Array<{ url: string; label: string; server?: string; language?: string; qualities?: Array<{ label: string; url: string }> }> = [];
    if (vidsrcEnabled && result && result.sources) {
      for (const scraped of result.sources) {
        if (servers.length >= 28) break;
        const candidateUrl = buildPlaybackUrl(scraped.url, resultReferer);
        try {
          validatePlaybackUrl(candidateUrl, 'direct');
        } catch {
          continue;
        }
        const serverName = typeof scraped.server === 'string' && scraped.server.trim() ? scraped.server.trim() : '';
        const language = typeof scraped.language === 'string' ? scraped.language.trim() : '';
        const label = serverName
          ? (language && !serverName.toLowerCase().includes(language.toLowerCase()) ? `${serverName} (${language})` : serverName)
          : scraped.quality || 'Server';
        servers.push({ url: candidateUrl, label, server: 'Vidsrc' });
      }
    }

    // Round 40/41 — PARALLEL FETCH: the Rivestream, VidPlay (ThugTV) and
    // VidStart (ThugTV media) resolves run CONCURRENTLY
    // (Promise.allSettled) — the old sequential form let a failing ThugTV
    // retry add its full backoff+attempt time to every resolve (observed
    // 8.2s end-to-end). A rejected promise logs the same warn line as
    // before and never blocks the other groups. Entries are still
    // appended in the FIXED order Vidstream first, then VidPlay, then
    // VidStart.
    let rivestreamSubtitles: Array<{ url: string; language?: string; label?: string }> | undefined;
    let thugtvSubtitles: Array<{ url: string; language?: string; label?: string }> | undefined;
    const [rivOut, thuOut, vidOut] = await Promise.allSettled([
      vidstreamEnabled ? rivestreamAdapter.resolve(context) : Promise.resolve(null),
      thugtvEnabled ? thugtvAdapter.resolve(context) : Promise.resolve(null),
      vidstartEnabled ? vidstartAdapter.resolve(context) : Promise.resolve(null),
    ]);

    // Vidstream (Rivestream) first — same merge as round 36. If
    // Rivestream failed, omit its entries entirely (never block Vidsrc).
    const rivestreamResult = rivOut.status === 'fulfilled' ? rivOut.value : null;
    if (rivestreamResult?.metadata?.servers) {
      // TEMPORARY DIAGNOSTIC (one deploy) — log the incoming Vidstream
      // server count so we can compare it with the [rivestream] sources
      // line. If this is 1 but [rivestream] sources says N>1, the merge
      // loop is dropping entries; if this is 0 but [rivestream] sources
      // says N>0, the adapter returned no servers.
      console.info('[direct-stream] rivestream entries', rivestreamResult.metadata.servers.length);
      for (const srv of rivestreamResult.metadata.servers) {
        if (servers.length >= 28) break;
        servers.push({
          url: srv.url,
          label: srv.label,
          server: srv.server,
          language: srv.language,
          qualities: srv.qualities,
        });
      }
      rivestreamSubtitles = rivestreamResult.subtitles;
    }
    if (rivOut.status === 'rejected') {
      // Rivestream failure is non-blocking, but log it so any pre-fetch
      // throw (bad context field, missing env, etc.) is visible in the
      // Netlify log instead of being silently swallowed.
      console.warn('[direct-stream] rivestream merge failed —', rivOut.reason instanceof Error ? rivOut.reason.message : String(rivOut.reason));
    }

    // VidPlay (ThugTV) second — same merge as round 38. If ThugTV failed,
    // omit its entries entirely (never block Vidsrc/Vidstream).
    const thugtvResult = thuOut.status === 'fulfilled' ? thuOut.value : null;
    if (thugtvResult?.metadata?.servers) {
      for (const srv of thugtvResult.metadata.servers) {
        if (servers.length >= 28) break;
        servers.push({
          url: srv.url,
          label: srv.label,
          server: srv.server,
          language: srv.language,
          qualities: srv.qualities,
        });
      }
      thugtvSubtitles = thugtvResult.subtitles;
    }
    if (thuOut.status === 'rejected') {
      // ThugTV failure is non-blocking, but log it so any pre-fetch
      // throw is visible in the Netlify log instead of being silently
      // swallowed.
      console.warn('[direct-stream] thugtv merge failed —', thuOut.reason instanceof Error ? thuOut.reason.message : String(thuOut.reason));
    }

    // VidStart (ThugTV media) third — round 41. If VidStart failed, omit
    // its entry entirely (never block Vidsrc/Vidstream/VidPlay). The entry
    // carries NO qualities/language: the single HLS master already carries
    // the quality variants + audio renditions, and hls.js builds the
    // Quality/Audio menus from the manifest.
    const vidstartResult = vidOut.status === 'fulfilled' ? vidOut.value : null;
    if (vidstartResult?.metadata?.servers) {
      for (const srv of vidstartResult.metadata.servers) {
        if (servers.length >= 28) break;
        servers.push({
          url: srv.url,
          label: srv.label,
          server: srv.server,
        });
      }
    }
    if (vidOut.status === 'rejected') {
      // VidStart failure is non-blocking, but log it so any pre-fetch
      // throw is visible in the Netlify log instead of being silently
      // swallowed.
      console.warn('[direct-stream] vidstart merge failed —', vidOut.reason instanceof Error ? vidOut.reason.message : String(vidOut.reason));
    }

    // Round 36 A4 / Round 38/41 — temporary diagnostic: log the server count +
    // group breakdown (now four groups).
    const vidsrcCount = servers.filter((s) => (s.server || 'Vidsrc') === 'Vidsrc').length;
    const vidstreamCount = servers.filter((s) => s.server === 'Vidstream').length;
    const vidplayCount = servers.filter((s) => s.server === 'VidPlay').length;
    const vidstartCount = servers.filter((s) => s.server === 'VidStart').length;
    console.warn('[direct-stream] resolve complete — servers:', servers.length, '(Vidsrc:', vidsrcCount, 'Vidstream:', vidstreamCount, 'VidPlay:', vidplayCount, 'VidStart:', vidstartCount, ')');

    // Round 36 — determine the primary URL. If Vidsrc is available, use its
    // first source. If only Vidstream is available, use the first Vidstream
    // server's URL.
    let primaryUrl: string;
    if (firstSource) {
      primaryUrl = buildPlaybackUrl(firstSource.url, resultReferer);
    } else if (servers.length > 0) {
      primaryUrl = servers[0].url;
    } else {
      throw new ResolverError('RESOLUTION_UNAVAILABLE');
    }
    const safeUrl = validatePlaybackUrl(primaryUrl, 'direct');

    // Round 38 — Rivestream + VidPlay (ThugTV) captions, concatenated in
    // group order (Vidstream first, VidPlay second); included only when
    // at least one group produced tracks.
    const mergedSubtitles = [...(rivestreamSubtitles ?? []), ...(thugtvSubtitles ?? [])];

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
        // Round 36 C / Round 38/41 — the default server from app_config, clamped
        // to an enabled source: if the configured default is disabled, fall
        // back to the other enabled one. Clamp order: vidstart → vidplay →
        // vidstream → vidsrc; the final fallback is unchanged.
        defaultServer: (() => {
          if (defaultServerPref === 'vidstart' && vidstartEnabled) return 'vidstart';
          if (defaultServerPref === 'vidplay' && thugtvEnabled) return 'vidplay';
          if (defaultServerPref === 'vidstream' && vidstreamEnabled) return 'vidstream';
          if (defaultServerPref === 'vidsrc' && vidsrcEnabled) return 'vidsrc';
          // Configured default is disabled — fall back to the other enabled one.
          return vidstreamEnabled ? 'vidstream' : 'vidsrc';
        })(),
        // Round 32/33 — ALL VidCore celestial servers (Earth / Tethys /
        // Enceladus / … with their per-server audio language on the label).
        // servers[0].url is the same proxied URL as `url` — the player's
        // Server menu uses it as the highlighted default row.
        // Round 36 — Vidstream (Rivestream) entries are appended with
        // server: 'Vidstream', label = language name, qualities = per-lang.
        ...(servers.length > 0 ? { servers } : {}),
      },
      // Round 36/38 — Rivestream + VidPlay captions (VTT) merged into subtitles.
      ...(mergedSubtitles.length > 0 ? { subtitles: mergedSubtitles } : {}),
    };
  },
};
