/**
 * DirectStream — vidcore.org scraper module (server-only, 2026-10 round 27).
 *
 * "Direct 2" — the multi-audio scraper. VidCore returns HLS master playlists
 * with multiple audio tracks (English, Hindi, etc.) that hls.js automatically
 * detects and exposes via the Audio menu.
 *
 * 2026-10 round 27 — MULTI-PROVIDER SUPPORT: VidCore has multiple sub-servers
 * (Earth, Mars, Jupiter, etc.). We try each one until we get a working stream.
 * The provider list is tried in order; the first one that returns a valid
 * stream URL wins.
 */

import { env as publicEnv } from '$env/dynamic/public';
import { ScraperError, type ScraperResult, type ScraperSource } from './vidsrc-scraper';

const FETCH_TIMEOUT_MS = 5_000;
const BROWSER_UA =
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const VIDCORE_ORIGIN = 'https://vidcore.org';

/**
 * The list of VidCore sub-servers to try. The first one that returns a valid
 * stream URL wins. New providers can be added here.
 */
const VIDCORE_PROVIDERS = [
        'mb-earth',
        'mb-mars',
        'mb-jupiter',
        'mb-saturn',
        'mb-andromeda',
        'mb-nebula',
] as const;

/**
 * Generates the VidCore token: Base64-encoded JSON + ".own" suffix.
 */
export function generateVidCoreToken(tmdbId: string, type: 'movie' | 'tv', season?: number, episode?: number): string {
        const payload: Record<string, unknown> = {
                tmdbId: parseInt(tmdbId, 10),
                type,
                exp: 9999999999,
                own: 1,
        };
        if (type === 'tv' && season !== undefined && episode !== undefined) {
                payload.season = season;
                payload.episode = episode;
        }
        return Buffer.from(JSON.stringify(payload)).toString('base64') + '.own';
}

/**
 * Builds the VidCore API URL for a specific provider.
 */
export function buildVidCoreApiUrl(tmdbId: string, type: 'movie' | 'tv', provider: string, season?: number, episode?: number): string {
        const token = generateVidCoreToken(tmdbId, type, season, episode);
        const path = type === 'movie'
                ? `/api/source/movie/${tmdbId}`
                : `/api/source/tv/${tmdbId}`;
        const params = new URLSearchParams({
                token,
                provider,
                parent: '',
        });
        return `${VIDCORE_ORIGIN}${path}?${params.toString()}`;
}

/**
 * Fetches JSON from a URL with a 5s timeout. Uses the Worker proxy when
 * PUBLIC_STREAM_PROXY_URL is set (same pattern as the vidsrc scraper).
 */
async function fetchJson(url: string, referer: string, label: string): Promise<string> {
        const workerBase = (publicEnv.PUBLIC_STREAM_PROXY_URL ?? '').replace(/\/+$/, '');

        if (workerBase) {
                const workerUrl = `${workerBase}/?u=${encodeURIComponent(url)}&r=${encodeURIComponent(referer)}`;
                let response: Response;
                try {
                        const controller = new AbortController();
                        const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
                        try {
                                response = await fetch(workerUrl, { signal: controller.signal, redirect: 'follow' });
                        } finally {
                                clearTimeout(timer);
                        }
                } catch (error) {
                        if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
                                throw new ScraperError('UPSTREAM_TIMEOUT', `${label} timed out after ${FETCH_TIMEOUT_MS}ms (Worker).`);
                        }
                        throw new ScraperError('SCRAPE_FAILED', `${label} Worker network error: ${error instanceof Error ? error.message : 'unknown'}.`);
                }
                if (!response.ok) {
                        const bodyText = await response.text().catch(() => '');
                        console.error(`[vidcore-scraper] ${label} Worker HTTP ${response.status}. Body:`, bodyText.slice(0, 200));
                        throw new ScraperError('SCRAPE_FAILED', `${label} HTTP ${response.status}.`);
                }
                return response.text();
        }

        // Direct fetch (no Worker — local dev / test harness)
        let response: Response;
        try {
                const controller = new AbortController();
                const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
                try {
                        response = await fetch(url, {
                                signal: controller.signal,
                                headers: {
                                        'user-agent': BROWSER_UA,
                                        accept: 'application/json, text/plain, */*',
                                        'accept-language': 'en-US,en;q=0.9',
                                        'sec-fetch-dest': 'empty',
                                        'sec-fetch-mode': 'cors',
                                        'sec-fetch-site': 'same-site',
                                        referer,
                                },
                                redirect: 'follow',
                        });
                } finally {
                        clearTimeout(timer);
                }
        } catch (error) {
                if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
                        throw new ScraperError('UPSTREAM_TIMEOUT', `${label} timed out after ${FETCH_TIMEOUT_MS}ms.`);
                }
                throw new ScraperError('SCRAPE_FAILED', `${label} network error: ${error instanceof Error ? error.message : 'unknown'}.`);
        }
        if (!response.ok) {
                const bodyText = await response.text().catch(() => '');
                console.error(`[vidcore-scraper] ${label} HTTP ${response.status}. Body:`, bodyText.slice(0, 200));
                throw new ScraperError('SCRAPE_FAILED', `${label} HTTP ${response.status}.`);
        }
        return response.text();
}

type VidCoreStream = { url?: string; title?: string };
type VidCoreApiResponse = {
        status?: string;
        streams?: VidCoreStream[];
        subtitles?: Array<{ url?: string; lang?: string; code?: string }>;
};

/**
 * Tries a single VidCore provider. Returns the parsed response if it has
 * valid streams, or null if the provider is dead/empty.
 */
async function tryVidCoreProvider(
        tmdbId: string,
        type: 'movie' | 'tv',
        provider: string,
        season: number | undefined,
        episode: number | undefined,
): Promise<{ streamUrl: string; subtitles: string[]; provider: string } | null> {
        const apiUrl = buildVidCoreApiUrl(tmdbId, type, provider, season, episode);
        console.log(`[vidcore-scraper] trying provider: ${provider}`);

        let rawBody: string;
        try {
                rawBody = await fetchJson(apiUrl, VIDCORE_ORIGIN + '/', `vidcore API (${provider})`);
        } catch (error) {
                console.warn(`[vidcore-scraper] provider ${provider} fetch failed:`, error instanceof Error ? error.message : error);
                return null;
        }

        let payload: VidCoreApiResponse;
        try {
                payload = JSON.parse(rawBody) as VidCoreApiResponse;
        } catch {
                console.warn(`[vidcore-scraper] provider ${provider} returned non-JSON. First 200 chars:`, rawBody.slice(0, 200));
                return null;
        }

        const streams = payload.streams;
        if (!streams || streams.length === 0) {
                console.warn(`[vidcore-scraper] provider ${provider} returned no streams.`);
                return null;
        }

        // 2026-10 round 31 — Multi-audio extraction: prefer master playlists
        // (URLs containing "master" or "index" + .m3u8 extension). These
        // typically contain #EXT-X-MEDIA audio tags (English, Hindi, Telugu,
        // etc.) that hls.js detects and exposes via the Audio menu.
        // Fallback: first stream with a valid URL.
        const validStreams = streams.filter((s) => s.url && s.url.length > 0);
        if (validStreams.length === 0) {
                console.warn(`[vidcore-scraper] provider ${provider} streams have no valid URL.`);
                return null;
        }

        // Prefer master playlist (contains "master" or "index" in the URL path).
        const masterStream = validStreams.find((s) => {
                const urlLower = s.url!.toLowerCase();
                return urlLower.includes('master') || urlLower.includes('index');
        });
        const stream = masterStream ?? validStreams[0]!;

        const subtitles = (payload.subtitles ?? []).map((s) => s.url ?? '').filter((u) => u.length > 0);
        console.log(`[vidcore-scraper] provider ${provider} OK: stream=${stream.url!.slice(0, 80)}..., ${validStreams.length} streams, ${subtitles.length} subtitles${masterStream ? ' (master playlist preferred)' : ''}`);

        return { streamUrl: stream.url!, subtitles, provider };
}

/**
 * The VidCore scrape. Tries each provider in order until one returns a valid
 * stream. Returns the HLS stream URL + subtitles.
 */
export async function scrapeVidCore(
        tmdbId: string,
        type: 'movie' | 'tv',
        season: number | undefined,
        episode: number | undefined,
): Promise<ScraperResult> {
        console.log(`[vidcore-scraper] starting: tmdb=${tmdbId} type=${type}${type === 'tv' ? ` s${season}e${episode}` : ''}`);

        // Try each provider until one works.
        for (const provider of VIDCORE_PROVIDERS) {
                const result = await tryVidCoreProvider(tmdbId, type, provider, season, episode);
                if (result) {
                        const sources: ScraperSource[] = [{ url: result.streamUrl, quality: 'Auto', kind: 'direct' }];
                        return {
                                sources,
                                subtitles: result.subtitles,
                                referer: VIDCORE_ORIGIN + '/',
                                provider: 'vidcore',
                        };
                }
        }

        // All providers failed.
        console.error(`[vidcore-scraper] ALL ${VIDCORE_PROVIDERS.length} providers failed.`);
        throw new ScraperError('NO_SOURCES', `All VidCore providers failed (${VIDCORE_PROVIDERS.join(', ')}).`);
}
