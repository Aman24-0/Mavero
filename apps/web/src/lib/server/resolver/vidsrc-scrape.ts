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
// Round 45 — VidPlay (ThugTV, api.thugtv.online) REMOVED again, this time
// PERMANENTLY: the API is behind a Cloudflare challenge it never clears.
// Round 40 — the Rivestream + VidVelvet resolves run CONCURRENTLY
// (Promise.allSettled): a slow or failing retry no longer adds its
// full backoff+attempt time to every resolve (observed 8.2s end-to-end).
// Round 41 — VidVelvet (ThugTV media API): the vidstart adapter joins the
// SAME concurrent merge. Merge order is the FIXED sequence Vidstream
// first, then VidVelvet. VidVelvet exposes a single multi-quality /
// multi-audio HLS master (one server entry, no qualities/language — hls.js
// reads the levels from the manifest) and contributes no subtitles.
// Round 42 — the stream.hls.lol mbox adapter joins the SAME concurrent
// merge (three adapters now), appended LAST. Round 45 display-rename
// VidFlix → VidBox (the file is vidbox.ts; the app_config gate column
// direct_stream_vidflix_enabled and the stored 'vidflix' defaultServer key
// stay unchanged — display-only rename). Each VidBox track is its own
// DASH (.mpd) manifest with its own audio — one server row per audio
// language (protocol 'dash', no qualities — the VOD DASH engine reads
// the MPD's real levels), plus .srt subtitles converted to VTT through
// the same-origin /api/content/subtitles/vtt/proxy endpoint.
import { rivestreamAdapter } from './rivestream';
import { vidstartAdapter } from './vidstart';
import { vidboxAdapter } from './vidbox';

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
    // Round 41 — VidVelvet (ThugTV media) toggle + 'vidstart' default server.
    let vidstartEnabled = true;
    // Round 42 — VidBox (stream.hls.lol DASH; display-renamed from VidFlix in
    // round 45) toggle + 'vidflix' default server. The stored config key
    // stays the internal 'vidflix' (direct_stream_vidflix_enabled — display-only rename).
    let vidboxEnabled = true;
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
        if (typeof cfgAny.direct_stream_vidstart_enabled === 'boolean') vidstartEnabled = cfgAny.direct_stream_vidstart_enabled;
        if (typeof cfgAny.direct_stream_vidflix_enabled === 'boolean') vidboxEnabled = cfgAny.direct_stream_vidflix_enabled;
        if (typeof cfgAny.direct_stream_default_server === 'string') {
          const val = cfgAny.direct_stream_default_server;
          if (val === 'vidstream' || val === 'vidsrc' || val === 'vidstart' || val === 'vidflix') defaultServerPref = val;
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
    const servers: Array<{ url: string; label: string; server?: string; language?: string; qualities?: Array<{ label: string; url: string }>; protocol?: 'hls' | 'dash' }> = [];
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

    // Round 40/41/42 — PARALLEL FETCH: the Rivestream, VidVelvet (ThugTV
    // media) and VidBox (stream.hls.lol DASH) resolves run CONCURRENTLY
    // (Promise.allSettled) — the old sequential form let a failing retry
    // add its full backoff+attempt time to every resolve (observed 8.2s
    // end-to-end). A rejected promise logs the same warn line as before
    // and never blocks the other groups. Entries are still appended in
    // the FIXED order Vidstream first, then VidVelvet, then VidBox.
    let rivestreamSubtitles: Array<{ url: string; language?: string; label?: string }> | undefined;
    let vidflixSubtitles: Array<{ url: string; language?: string; label?: string }> | undefined;
    const [rivOut, vidOut, flxOut] = await Promise.allSettled([
      vidstreamEnabled ? rivestreamAdapter.resolve(context) : Promise.resolve(null),
      vidstartEnabled ? vidstartAdapter.resolve(context) : Promise.resolve(null),
      vidboxEnabled ? vidboxAdapter.resolve(context) : Promise.resolve(null),
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

    // VidPlay (api.thugtv.online) removed in round 45 — permanently behind
    // a Cloudflare challenge. (Its merge block used to sit here.)

    // VidVelvet (ThugTV media) second — round 41. If VidVelvet failed, omit
    // its entry entirely (never block Vidsrc/Vidstream). The entry
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
      // VidVelvet failure is non-blocking, but log it so any pre-fetch
      // throw is visible in the Netlify log instead of being silently
      // swallowed.
      console.warn('[direct-stream] vidstart merge failed —', vidOut.reason instanceof Error ? vidOut.reason.message : String(vidOut.reason));
    }

    // VidBox (stream.hls.lol DASH; display-renamed from VidFlix in round 45)
    // third — round 42. If VidBox failed, omit its rows entirely (never
    // block the other groups). Each row is ONE DASH (.mpd) manifest for
    // one audio language (protocol 'dash', no qualities — the VOD DASH
    // engine reads the MPD's real levels); its .srt subtitles ride the
    // same-origin VTT-converting proxy.
    const vidboxResult = flxOut.status === 'fulfilled' ? flxOut.value : null;
    if (vidboxResult?.metadata?.servers) {
      for (const srv of vidboxResult.metadata.servers) {
        if (servers.length >= 28) break;
        servers.push({
          url: srv.url,
          label: srv.label,
          server: srv.server,
          protocol: srv.protocol,
        });
      }
      vidflixSubtitles = vidboxResult.subtitles;
    }
    if (flxOut.status === 'rejected') {
      // VidBox failure is non-blocking, but log it so any pre-fetch
      // throw is visible in the Netlify log instead of being silently
      // swallowed.
      console.warn('[direct-stream] vidbox merge failed —', flxOut.reason instanceof Error ? flxOut.reason.message : String(flxOut.reason));
    }

    // Round 36 A4 / Round 41/42/45 — temporary diagnostic: log the server
    // count + group breakdown (four groups after the round 45 VidPlay
    // removal + VidFlix→VidBox display rename — the filter matches the
    // RENAMED server tags).
    const vidsrcCount = servers.filter((s) => (s.server || 'Vidsrc') === 'Vidsrc').length;
    const vidstreamCount = servers.filter((s) => s.server === 'Vidstream').length;
    const vidvelvetCount = servers.filter((s) => s.server === 'VidVelvet').length;
    const vidboxCount = servers.filter((s) => s.server === 'VidBox').length;
    console.warn('[direct-stream] resolve complete — servers:', servers.length, '(Vidsrc:', vidsrcCount, 'Vidstream:', vidstreamCount, 'VidVelvet:', vidvelvetCount, 'VidBox:', vidboxCount, ')');

    // Round 36 — determine the primary URL. If Vidsrc is available, use its
    // first source. If only Vidstream is available, use the first Vidstream
    // server's URL.
    // Round 42 — the primary's PROTOCOL follows its group: 'dash' when the
    // primary URL comes from the VidBox group (servers[0] is a VidBox
    // row), else 'hls' as before — never hardcoded, because a server
    // switch (hls ↔ dash) honours the selected entry's own protocol.
    let primaryUrl: string;
    let primaryProtocol: 'hls' | 'dash' = 'hls';
    if (firstSource) {
      primaryUrl = buildPlaybackUrl(firstSource.url, resultReferer);
    } else if (servers.length > 0) {
      primaryUrl = servers[0].url;
      if (servers[0].server === 'VidBox') primaryProtocol = 'dash';
    } else {
      throw new ResolverError('RESOLUTION_UNAVAILABLE');
    }
    const safeUrl = validatePlaybackUrl(primaryUrl, 'direct');

    // Round 36 — Rivestream + VidBox (stream.hls.lol) captions, concatenated
    // in group order (Vidstream first, VidBox last); included only when at
    // least one group produced tracks. Round 42 — VidBox's proxied .srt→VTT
    // tracks are concatenated in the SAME group order.
    const mergedSubtitles = [...(rivestreamSubtitles ?? []), ...(vidflixSubtitles ?? [])];

    // Direct result — the HLS engine owns playback for hls sources and
    // the VOD DASH engine for dash (VidBox) sources; quality levels and
    // audio-track discovery always come from the manifest. Round 42 —
    // protocol is set explicitly (primaryProtocol — 'dash' exactly when
    // the primary URL comes from the VidBox group) because the Worker URL
    // has no .m3u8/.mpd extension (the engine's extension sniff would
    // return undefined).
    return {
      type: 'direct',
      url: safeUrl,
      protocol: primaryProtocol,
      metadata: {
        providerName: context.config.provider.name,
        sourceName: context.config.source.name,
        protocol: primaryProtocol,
        // Round 36 C / Round 41/42/45 — the default server from app_config, clamped
        // to an enabled source: if the configured default is disabled, fall
        // back to the other enabled one. Clamp order: vidflix → vidstart →
        // vidstream → vidsrc; the final fallback is unchanged. (The stored
        // 'vidflix' key IS the VidBox group — display-only rename in round 45.)
        defaultServer: (() => {
          if (defaultServerPref === 'vidflix' && vidboxEnabled) return 'vidflix';
          if (defaultServerPref === 'vidstart' && vidstartEnabled) return 'vidstart';
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
        // Round 42 — VidBox entries carry protocol: 'dash' (one row per
        // audio language, each its own .mpd).
        ...(servers.length > 0 ? { servers } : {}),
      },
      // Round 36/42 — Rivestream + VidBox captions (VTT) merged with
      // VidBox's proxied SRT→VTT tracks into subtitles.
      ...(mergedSubtitles.length > 0 ? { subtitles: mergedSubtitles } : {}),
    };
  },
};
