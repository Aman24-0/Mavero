// ============================================================================
// DirectStream — VOD scraper endpoint (2026-10 round 13).
//
// GET /api/vod/scrape?tmdb_id={id}&type={movie|tv}&season={s}&episode={e}
//
// Calls the scrapeVidsrc() module to extract the real .m3u8 URL from vidsrc's
// 3-hop embed chain, then returns the Worker-proxied URL (with the required
// Referer baked in as &r=) so the client can hand it straight to the HLS
// engine. The browser cannot set Referer (it's a forbidden header), so the
// Cloudflare Worker adds it server-side — this is the ONLY way to play vidsrc
// streams in the browser.
//
// SECURITY: rate-limited, admin-config-gated (the scraper must be enabled in
// app_config). The scrape runs server-side (no CORS); the returned URL is a
// Worker URL (permissive CORS). No playback URLs or tokens are logged.
//
// The config (embed domain, CDN domains) is read from app_config — the admin
// can update domains at runtime via /admin/system/direct-stream without a
// code change or redeploy.
// ============================================================================

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { env as publicEnv } from '$env/dynamic/public';
import { createSupabaseAdminClient } from '$lib/server/supabase/admin';
import { getScraperConfig } from '$lib/server/app-config';
import { scrapeVidsrc, ScraperError, DEFAULT_SCRAPER_CONFIG, type ScraperSource } from '$lib/server/vod/vidsrc-scraper';
import { scrapeVidCore } from '$lib/server/vod/vidcore-scraper';
import {
        checkRateLimit,
        clientIdentity,
        RATE_LIMITED_ERROR_CODE,
        RATE_LIMITED_MESSAGE
} from '$lib/server/http/rate-limit';

const NO_STORE = { 'cache-control': 'no-store' } as const;
const TMDB_ID_PATTERN = /^[1-9][0-9]{0,15}$/;

function fail(status: number, code: string, message: string): Response {
        return json({ ok: false, error: { code, message } }, { status, headers: NO_STORE });
}

/**
 * Builds the playback URL for the API response.
 *
 * 2026-10 round 19 — when the Worker is configured, wrap the manifest URL
 * server-side (the Worker adds CORS + Referer). When it's NOT configured,
 * return the raw vidsrc.party URL — the client-side player routes it through
 * the in-app proxy via the isLivetvProxyUrl() check (same as Live TV).
 */
function buildPlaybackUrl(rawManifestUrl: string, referer: string): string {
        const workerBase = (publicEnv.PUBLIC_STREAM_PROXY_URL ?? '').replace(/\/+$/, '');
        if (workerBase) {
                return `${workerBase}/?u=${encodeURIComponent(rawManifestUrl)}&r=${encodeURIComponent(referer)}`;
        }
        // No Worker — return the raw URL. The client-side player will route
        // it through the in-app proxy via isLivetvProxyUrl().
        return rawManifestUrl;
}

export const GET: RequestHandler = async ({ request, url, locals }) => {
        const verdict = checkRateLimit('vodScrape', clientIdentity(request.headers, locals.user?.id));
        if (!verdict.allowed) {
                return json(
                        { ok: false, error: { code: RATE_LIMITED_ERROR_CODE, message: RATE_LIMITED_MESSAGE } },
                        { status: 429, headers: { ...NO_STORE, 'retry-after': String(verdict.retryAfterSeconds) } }
                );
        }

        // --- Parse + validate query params ---
        const tmdbId = url.searchParams.get('tmdb_id') ?? '';
        const type = url.searchParams.get('type') ?? '';
        const seasonStr = url.searchParams.get('season') ?? '';
        const episodeStr = url.searchParams.get('episode') ?? '';

        if (!TMDB_ID_PATTERN.test(tmdbId)) {
                return fail(400, 'INVALID_PARAMS', 'A valid tmdb_id is required.');
        }
        if (type !== 'movie' && type !== 'tv') {
                return fail(400, 'INVALID_PARAMS', 'type must be "movie" or "tv".');
        }

        let season: number | undefined;
        let episode: number | undefined;
        if (type === 'tv') {
                season = Number(seasonStr);
                episode = Number(episodeStr);
                if (!Number.isInteger(season) || season < 1 || !Number.isInteger(episode) || episode < 1) {
                        return fail(400, 'INVALID_PARAMS', 'TV requests require valid season and episode numbers.');
                }
        }

        // --- Read the scraper config from app_config ---
        let config = DEFAULT_SCRAPER_CONFIG;
        let enabled = false;
        try {
                const client = createSupabaseAdminClient();
                const scraperState = await getScraperConfig(client);
                config = scraperState.config;
                enabled = scraperState.enabled;
        } catch {
                // If the config read fails, fall back to defaults but stay
                // disabled — the admin must explicitly enable the scraper.
        }

        // The global enable gate. The admin can disable the scraper from the
        // DirectStream admin page without touching the streaming_sources row.
        if (!enabled) {
                return fail(503, 'SCRAPER_DISABLED', 'The DirectStream scraper is disabled. Enable it in /admin/system/direct-stream.');
        }

        // --- Parse the source parameter (vidsrc = Direct 1, vidcore = Direct 2) ---
        const source = url.searchParams.get('source') ?? 'vidsrc';

        // --- Scrape ---
        try {
                // 2026-10 round 26 — route to the correct scraper based on ?source=.
                // vidsrc (default) = Direct 1 (vidsrc.party), vidcore = Direct 2 (vidcore.org).
                const result = source === 'vidcore'
                        ? await scrapeVidCore(tmdbId, type, season, episode)
                        : await scrapeVidsrc(tmdbId, type, season, episode, config);

                // Build the playback URL. When the Worker is configured, wrap
                // server-side. When not, return the raw URL (the client-side
                // player routes it through the in-app proxy).
                // 2026-10 round 32 — the `server` display name rides along so
                // scraper consumers (admin source test, future UIs) can show
                // WHICH VidCore server each URL belongs to.
                const proxiedSources: ScraperSource[] = result.sources.map((s) => ({
                        url: buildPlaybackUrl(s.url, result.referer),
                        quality: s.quality,
                        kind: s.kind,
                        ...(typeof s.server === 'string' && s.server ? { server: s.server } : {})
                }));
                return json({
                        ok: true,
                        data: {
                                sources: proxiedSources,
                                subtitles: result.subtitles,
                                referer: result.referer,
                                provider: result.provider,
                                timestamp: new Date().toISOString(),
                                cacheTtl: 900
                        }
                }, { headers: NO_STORE });
        } catch (error) {
                if (error instanceof ScraperError) {
                        // Return the EXACT error message + code so the UI can debug it.
                        const status = error.code === 'INVALID_PARAMS' ? 400
                                : error.code === 'UPSTREAM_TIMEOUT' ? 504
                                : error.code === 'NO_SOURCES' ? 404
                                : error.code === 'CLOUDFLARE_BLOCKED' ? 502
                                : error.code === 'REGEX_PARSE_FAILED' ? 502
                                : 502;
                        console.error(`[vod/scrape] ${error.code}: ${error.message}`);
                        return fail(status, error.code, error.message);
                }
                console.error('[vod/scrape] unexpected error', error instanceof Error ? error.message : error);
                return fail(500, 'SCRAPE_FAILED', 'The scraper encountered an unexpected error.');
        }
};
