/**
 * DirectStream — vidcore.org scraper module (server-only, 2026-10 round 26).
 *
 * "Direct 2" — the multi-audio scraper. VidCore returns HLS master playlists
 * with multiple audio tracks (English, Hindi, etc.) that hls.js automatically
 * detects and exposes via the Audio menu.
 *
 * THE FLOW (reverse-engineered 2026-10-30):
 *
 *   1. Generate a token: Base64-encoded JSON + ".own" suffix.
 *      payload = { tmdbId: 278, type: 'movie', exp: 9999999999, own: 1 }
 *      token = Buffer.from(JSON.stringify(payload)).toString('base64') + '.own'
 *      (For TV: add season + episode to the payload, use type: 'tv')
 *
 *   2. Call the API:
 *      Movie:  GET https://vidcore.org/api/source/movie/{tmdbId}?token={token}&provider=mb-andromeda&parent=
 *      TV:     GET https://vidcore.org/api/source/tv/{tmdbId}?token={token}&provider=mb-andromeda&parent=
 *
 *   3. The API returns JSON:
 *      {
 *        "status": "ok",
 *        "streams": [{ "url": "https://.../master.m3u8", "title": "...", ... }],
 *        "subtitles": [{ "url": "https://.../en.vtt", "lang": "English", "code": "eng" }, ...]
 *      }
 *
 *   4. Return streams[0].url as a direct HLS source, with subtitles attached.
 *
 * SECURITY:
 *   * fetch with a 5s AbortController timeout (via the shared fetchJson).
 *   * The Worker proxy is used when PUBLIC_STREAM_PROXY_URL is set (bypasses
 *     Cloudflare IP blocks on Netlify's AWS egress).
 *   * No eval, no vm, no headless browser.
 */

import { env as publicEnv } from '$env/dynamic/public';
import { ScraperError, type ScraperResult, type ScraperSource } from './vidsrc-scraper';

const FETCH_TIMEOUT_MS = 5_000;
const BROWSER_UA =
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const VIDCORE_ORIGIN = 'https://vidcore.org';

/**
 * Generates the VidCore token: Base64-encoded JSON + ".own" suffix.
 * The token is a self-signed JSON blob with a far-future expiry.
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
 * Builds the VidCore API URL.
 */
export function buildVidCoreApiUrl(tmdbId: string, type: 'movie' | 'tv', season?: number, episode?: number): string {
        const token = generateVidCoreToken(tmdbId, type, season, episode);
        const path = type === 'movie'
                ? `/api/source/movie/${tmdbId}`
                : `/api/source/tv/${tmdbId}`;
        const params = new URLSearchParams({
                token,
                provider: 'mb-andromeda',
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
                console.log(`[vidcore-scraper] ${label}: fetching via Worker proxy`);
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
                        if (response.status === 403 || response.status === 503) {
                                throw new ScraperError('CLOUDFLARE_BLOCKED', `${label} Cloudflare blocked (HTTP ${response.status}).`);
                        }
                        throw new ScraperError('SCRAPE_FAILED', `${label} HTTP ${response.status}. Body: ${bodyText.slice(0, 100)}`);
                }
                return response.text();
        }

        // Direct fetch (no Worker — local dev / test harness)
        console.log(`[vidcore-scraper] ${label}: fetching directly`);
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
                throw new ScraperError('SCRAPE_FAILED', `${label} HTTP ${response.status}. Body: ${bodyText.slice(0, 100)}`);
        }
        return response.text();
}

type VidCoreApiResponse = {
        status?: string;
        streams?: Array<{ url?: string; title?: string }>;
        subtitles?: Array<{ url?: string; lang?: string; code?: string }>;
};

/**
 * The VidCore scrape. Returns the HLS stream URL + subtitles.
 */
export async function scrapeVidCore(
        tmdbId: string,
        type: 'movie' | 'tv',
        season: number | undefined,
        episode: number | undefined,
): Promise<ScraperResult> {
        console.log(`[vidcore-scraper] starting: tmdb=${tmdbId} type=${type}${type === 'tv' ? ` s${season}e${episode}` : ''}`);

        const apiUrl = buildVidCoreApiUrl(tmdbId, type, season, episode);
        const rawBody = await fetchJson(apiUrl, VIDCORE_ORIGIN + '/', 'vidcore API');

        let payload: VidCoreApiResponse;
        try {
                payload = JSON.parse(rawBody) as VidCoreApiResponse;
        } catch {
                console.error('[vidcore-scraper] non-JSON response. First 500 chars:', rawBody.slice(0, 500));
                throw new ScraperError('REGEX_PARSE_FAILED', 'VidCore API returned non-JSON.');
        }

        const streams = payload.streams;
        if (!streams || streams.length === 0 || !streams[0]?.url) {
                console.error('[vidcore-scraper] NO_SOURCES: no streams in response. Full:', JSON.stringify(payload).slice(0, 500));
                throw new ScraperError('NO_SOURCES', 'VidCore API returned no streams.');
        }

        const streamUrl = streams[0].url;
        const subtitles = (payload.subtitles ?? []).map((s) => s.url ?? '').filter((u) => u.length > 0);

        console.log(`[vidcore-scraper] ok: stream=${streamUrl.slice(0, 80)}..., ${subtitles.length} subtitles`);

        const sources: ScraperSource[] = [{ url: streamUrl, quality: 'Auto', kind: 'direct' }];

        return {
                sources,
                subtitles,
                referer: VIDCORE_ORIGIN + '/',
                provider: 'vidcore',
        };
}
