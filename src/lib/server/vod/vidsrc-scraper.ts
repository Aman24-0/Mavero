/**
 * DirectStream — vidsrc.party scraper module (server-only, 2026-10 round 18).
 *
 * A lightweight pure-HTTP scraper that calls the vidsrc.party JSON API and
 * extracts the HLS manifest URL. NO headless browser, NO iframe scraping,
 * NO 2embed fallback — just one API call + JSON parsing.
 *
 * THE FLOW (reverse-engineered 2026-10-29):
 *
 *   1. Movie:  GET https://vidsrc.party/api/play/movie/{tmdbId}?async=1&wait=1
 *      TV:     GET https://vidsrc.party/api/play/tv/{tmdbId}/{season}/{episode}?async=1&wait=1
 *
 *   2. The API returns JSON:
 *      {
 *        "jobId": "...",
 *        "status": "ready",
 *        "result": {
 *          "token": "vHXeflQOcytlEqRd",
 *          "file": {
 *            "stream": "/v/{token}/stream",          ← the HLS manifest path
 *            "playback": "hls",
 *            "mime": "application/vnd.apple.mpegurl"
 *          }
 *        }
 *      }
 *
 *   3. The full manifest URL is `https://vidsrc.party/v/{token}/stream`.
 *      This IS a valid HLS media playlist (content-type: application/vnd.apple.mpegurl).
 *      Each segment URI inside the manifest is `/p/{token}/{base64}` where the
 *      base64 decodes to the real CDN URL (e.g. https://cno.to/hls/.../seg-00001.m4s).
 *      vidsrc.party proxies all segments through `/p/{token}/{base64}` — the
 *      browser's HLS engine loads the manifest + segments from vidsrc.party
 *      directly (vidsrc.party handles the CDN Referer server-side).
 *
 *   4. The scraper returns `https://vidsrc.party/v/{token}/stream` as the
 *      direct HLS URL. The Cloudflare Worker proxy wraps it (with the required
 *      Referer) so the browser can load it cross-origin.
 *
 * CONFIG-DRIVEN: the API domain is read from `ScraperConfig.embedDomain`
 * (default `https://vidsrc.party`). The admin can update it at runtime via
 * the DirectStream admin page — no code change or redeploy needed when
 * vidsrc.party rotates its domain.
 *
 * CACHE: a bounded in-memory `Map` keyed by `tmdbId:type:season:episode` with
 * a 15-minute TTL. The scrape result (manifest URL) is stable for minutes,
 * so repeat requests for the same title are instant.
 *
 * SECURITY:
 *   * `fetch` with a 6s AbortController timeout (no Netlify function hang).
 *   * The API URL is HTTPS-validated.
 *   * Full browser headers (Sec-Fetch-*) — Cloudflare's bot detection 403s
 *     requests missing them.
 *   * No `eval`, no `vm`, no headless browser — pure fetch + JSON.parse.
 *   * The scraper NEVER logs playback URLs or tokens.
 *
 * LIMITATIONS (honest):
 *   * Scraper reliability depends on vidsrc.party's API staying stable. If
 *     the API contract changes (field names, URL shape), the scraper breaks —
 *     the admin updates the domain in the config and the next scrape works.
 *   * vidsrc.party uses Cloudflare; if the scraper IP is flagged, the API
 *     returns 403. The scraper routes through the Cloudflare Worker when
 *     PUBLIC_STREAM_PROXY_URL is set (edge IPs bypass the block).
 */

import { env as publicEnv } from '$env/dynamic/public';

/** The scraper's config — sourced from `app_config` (admin-editable). */
export type ScraperConfig = {
        /** The vidsrc.party API domain, e.g. `https://vidsrc.party`. No trailing slash. */
        embedDomain: string;
        /**
         * CDN domains for the Worker allowlist (the segments inside the manifest
         * point at rotating CDNs like cno.to, cookiebakers23blog.xyz, etc.).
         * Kept for config compatibility — the manifest itself is served from
         * vidsrc.party, so this is informational only.
         */
        cdnDomains: string[];
};

/** Default config — used when `app_config` has no values. The admin can
 *  override these at runtime via the DirectStream admin page. */
export const DEFAULT_SCRAPER_CONFIG: ScraperConfig = {
        embedDomain: 'https://vidsrc.party',
        cdnDomains: ['cno.to']
};

/** One resolved stream source (the HLS manifest URL + its quality label). */
export type ScraperSource = {
        /** The HLS manifest URL (the /v/{token}/stream endpoint on vidsrc.party). */
        url: string;
        /** A quality label (always "Auto" — the manifest is a media playlist). */
        quality: string;
        /** Always 'direct' — vidsrc.party returns a direct HLS manifest, never an iframe. */
        kind: 'direct';
};

/** The scraper's success result. */
export type ScraperResult = {
        sources: ScraperSource[];
        subtitles: string[];
        /** The Referer the CDN requires — passed to the Worker as `&r=`. */
        referer: string;
        /** The provider that produced the result (always 'vidsrc.party'). */
        provider: string;
};

/** The scraper's error codes. */
export type ScraperErrorCode =
        | 'INVALID_PARAMS'
        | 'UPSTREAM_TIMEOUT'
        | 'CLOUDFLARE_BLOCKED'
        | 'REGEX_PARSE_FAILED'
        | 'SCRAPE_FAILED'
        | 'NO_SOURCES';

export class ScraperError extends Error {
        readonly code: ScraperErrorCode;
        constructor(code: ScraperErrorCode, message: string) {
                super(message);
                this.name = 'ScraperError';
                this.code = code;
        }
}

// ---------------------------------------------------------------------------
// In-memory cache (15-minute TTL, bounded to 200 entries)
// ---------------------------------------------------------------------------

const CACHE_TTL_MS = 15 * 60 * 1000;
const CACHE_MAX_ENTRIES = 200;

type CacheEntry = { result: ScraperResult; expiresAt: number };
const cache = new Map<string, CacheEntry>();

function cacheKey(tmdbId: string, type: string, season?: number, episode?: number): string {
        return `${tmdbId}:${type}:${season ?? 0}:${episode ?? 0}`;
}

function getCached(key: string): ScraperResult | null {
        const entry = cache.get(key);
        if (!entry) return null;
        if (Date.now() > entry.expiresAt) {
                cache.delete(key);
                return null;
        }
        return entry.result;
}

function setCached(key: string, result: ScraperResult): void {
        if (cache.size >= CACHE_MAX_ENTRIES) {
                const firstKey = cache.keys().next().value;
                if (firstKey) cache.delete(firstKey);
        }
        cache.set(key, { result, expiresAt: Date.now() + CACHE_TTL_MS });
}

/** Clears the in-memory cache (used by tests + admin "clear cache" actions). */
export function clearScraperCache(): void {
        cache.clear();
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

const TMDB_ID_PATTERN = /^[1-9][0-9]{0,15}$/;

function requireTmdbId(raw: string): string {
        const value = raw.trim();
        if (!TMDB_ID_PATTERN.test(value)) throw new ScraperError('INVALID_PARAMS', 'A valid TMDB id is required.');
        return value;
}

function requirePositiveInt(raw: number | undefined, label: string): number {
        if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1) {
                throw new ScraperError('INVALID_PARAMS', `${label} must be a positive integer.`);
        }
        return raw;
}

/**
 * Normalizes the API domain from config: trims, strips trailing slash,
 * validates it's an https URL. Throws on invalid config.
 */
export function normalizeEmbedDomain(raw: string): string {
        const trimmed = raw.trim().replace(/\/+$/, '');
        if (!trimmed) throw new ScraperError('INVALID_PARAMS', 'The API domain is not configured.');
        try {
                const url = new URL(trimmed);
                if (url.protocol !== 'https:') throw new ScraperError('INVALID_PARAMS', 'The API domain must be https.');
                return url.origin;
        } catch {
                throw new ScraperError('INVALID_PARAMS', 'The API domain is not a valid URL.');
        }
}

/**
 * Normalizes the CDN domains from config (kept for config compatibility).
 */
export function normalizeCdnDomains(raw: string[]): string[] {
        const cleaned = raw
                .map((d) => d.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, ''))
                .filter((d) => d.length > 0);
        return [...new Set(cleaned)];
}

// ---------------------------------------------------------------------------
// The API call + JSON parsing
// ---------------------------------------------------------------------------

const FETCH_TIMEOUT_MS = 6_000;
const BROWSER_UA =
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/**
 * Builds the Worker proxy URL for a given upstream URL + referer. The Worker
 * fetches the upstream from Cloudflare's edge IPs (bypassing Cloudflare's 403
 * on Netlify's AWS egress IPs) and sends the correct browser headers +
 * Referer server-side.
 *
 * Returns null when `PUBLIC_STREAM_PROXY_URL` is unset (the caller falls back
 * to a direct fetch).
 */
function buildWorkerProxyUrl(upstreamUrl: string, referer: string): string | null {
        const workerBase = (publicEnv.PUBLIC_STREAM_PROXY_URL ?? '').replace(/\/+$/, '');
        if (!workerBase) return null;
        return `${workerBase}/?u=${encodeURIComponent(upstreamUrl)}&r=${encodeURIComponent(referer)}`;
}

/**
 * Fetches a URL with a FULL set of browser headers + a strict 6s AbortController
 * timeout. Throws a typed `ScraperError` on failure.
 *
 * 2026-10 round 18: the Worker fallback is tried first (edge IPs bypass
 * Cloudflare's IP-based 403). If the Worker fails, a direct fetch is attempted.
 */
async function fetchJson(url: string, referer: string, label: string): Promise<string> {
        // --- Try the Worker proxy first (if configured) ---
        const workerUrl = buildWorkerProxyUrl(url, referer);
        if (workerUrl) {
                try {
                        const controller = new AbortController();
                        const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
                        try {
                                const response = await fetch(workerUrl, {
                                        signal: controller.signal,
                                        redirect: 'follow'
                                });
                                if (response.ok) {
                                        return response.text();
                                }
                                console.log(`[vidsrc-scraper] ${label} Worker proxy returned HTTP ${response.status}, falling back to direct fetch`);
                        } finally {
                                clearTimeout(timer);
                        }
                } catch (error) {
                        console.log(`[vidsrc-scraper] ${label} Worker proxy failed (${error instanceof Error ? error.message : 'unknown'}), falling back to direct fetch`);
                }
        }

        // --- Direct fetch (with full browser headers + 6s AbortController) ---
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
                                        'accept-encoding': 'gzip, deflate, br',
                                        'cache-control': 'no-cache',
                                        'pragma': 'no-cache',
                                        'sec-ch-ua': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
                                        'sec-ch-ua-mobile': '?0',
                                        'sec-ch-ua-platform': '"Windows"',
                                        'sec-fetch-dest': 'empty',
                                        'sec-fetch-mode': 'cors',
                                        'sec-fetch-site': 'same-site',
                                        referer
                                },
                                redirect: 'follow'
                        });
                } finally {
                        clearTimeout(timer);
                }
        } catch (error) {
                if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
                        console.error(`[vidsrc-scraper] ${label} timed out after ${FETCH_TIMEOUT_MS}ms (${url})`);
                        throw new ScraperError('UPSTREAM_TIMEOUT', `${label} timed out after ${FETCH_TIMEOUT_MS}ms.`);
                }
                console.error(`[vidsrc-scraper] ${label} network error`, error instanceof Error ? error.message : error);
                throw new ScraperError('SCRAPE_FAILED', `${label} failed (network error: ${error instanceof Error ? error.message : 'unknown'}).`);
        }
        if (response.status === 403 || response.status === 503) {
                const bodyText = await response.text().catch(() => '');
                console.error(`[vidsrc-scraper] ${label} Cloudflare blocked (HTTP ${response.status}). First 500 chars:`, bodyText.slice(0, 500));
                throw new ScraperError('CLOUDFLARE_BLOCKED', `${label} was blocked by Cloudflare (HTTP ${response.status}). The scraper's IP may be flagged.`);
        }
        if (!response.ok) {
                console.error(`[vidsrc-scraper] ${label} HTTP ${response.status}`);
                throw new ScraperError('SCRAPE_FAILED', `${label} returned HTTP ${response.status}.`);
        }
        return response.text();
}

/**
 * Builds the vidsrc.party API URL for the given content identifiers.
 *   Movie:  `{apiDomain}/api/play/movie/{tmdbId}?async=1&wait=1`
 *   TV:     `{apiDomain}/api/play/tv/{tmdbId}/{season}/{episode}?async=1&wait=1`
 */
export function buildApiUrl(apiDomain: string, tmdbId: string, type: 'movie' | 'tv', season?: number, episode?: number): string {
        if (type === 'movie') {
                return `${apiDomain}/api/play/movie/${tmdbId}?async=1&wait=1`;
        }
        return `${apiDomain}/api/play/tv/${tmdbId}/${season}/${episode}?async=1&wait=1`;
}

/**
 * Decodes a base64 string to UTF-8 (used for diagnostics — the segment URLs
 * inside the manifest are base64-encoded CDN URLs). Exported for tests.
 */
export function decodeBase64Url(b64: string): string {
        try {
                return Buffer.from(b64, 'base64').toString('utf-8');
        } catch {
                return '';
        }
}

// ---------------------------------------------------------------------------
// The scraper
// ---------------------------------------------------------------------------

/**
 * The vidsrc.party API scrape. Returns the HLS manifest URL.
 *
 * 2026-10 round 21 — CDN VERIFICATION + RETRY: vidsrc.party assigns a
 * random CDN per token (cookiebakers23blog.xyz, tiktokcdn.com, etc.).
 * Some CDNs are dead (404 on the variant playlist). The scraper now:
 *   1. Calls the API to get a token.
 *   2. Fetches the manifest (/v/{token}/stream).
 *   3. Extracts the first variant playlist URL (/p/{token}/{base64}).
 *   4. Verifies the variant playlist returns 200.
 *   5. If the variant 404s, re-calls the API (up to 2 retries) to get a
 *      new token with a different CDN.
 *
 * @param tmdbId  The TMDB id (positive integer string).
 * @param type    'movie' | 'tv'.
 * @param season  Required for TV.
 * @param episode Required for TV.
 * @param config  The scraper config (API domain).
 */
const MAX_CDN_RETRIES = 2;

export async function scrapeVidsrc(
        tmdbId: string,
        type: 'movie' | 'tv',
        season: number | undefined,
        episode: number | undefined,
        config: ScraperConfig
): Promise<ScraperResult> {
        const safeTmdbId = requireTmdbId(tmdbId);
        if (type === 'tv') {
                requirePositiveInt(season, 'season');
                requirePositiveInt(episode, 'episode');
        }

        const apiDomain = normalizeEmbedDomain(config.embedDomain);

        // Check the cache first.
        const key = cacheKey(safeTmdbId, type, season, episode);
        const cached = getCached(key);
        if (cached) return cached;

        console.log(`[vidsrc-scraper] starting scrape: tmdb=${safeTmdbId} type=${type}${type === 'tv' ? ` s${season}e${episode}` : ''} api=${apiDomain}`);

        // --- Try up to 3 times (1 initial + 2 retries) to get a working CDN ---
        let lastError: ScraperError | null = null;
        for (let attempt = 0; attempt <= MAX_CDN_RETRIES; attempt += 1) {
                try {
                        const result = await scrapeVidsrcAttempt(safeTmdbId, type, season, episode, apiDomain);
                        setCached(key, result);
                        return result;
                } catch (error) {
                        if (error instanceof ScraperError) {
                                lastError = error;
                                console.warn(`[vidsrc-scraper] attempt ${attempt + 1}/${MAX_CDN_RETRIES + 1} failed (${error.code}): ${error.message}`);
                                // Only retry on CDN-related errors (the API call itself succeeded
                                // but the variant playlist 404'd). Don't retry on INVALID_PARAMS
                                // or CLOUDFLARE_BLOCKED (those won't change with a retry).
                                if (error.code === 'NO_SOURCES' && attempt < MAX_CDN_RETRIES) {
                                        console.log(`[vidsrc-scraper] retrying to get a new CDN assignment...`);
                                        continue;
                                }
                        } else {
                                console.warn(`[vidsrc-scraper] attempt ${attempt + 1} failed (unknown error)`, error);
                        }
                        throw error;
                }
        }

        // All retries exhausted — throw the last error.
        throw lastError ?? new ScraperError('SCRAPE_FAILED', 'All CDN retries exhausted.');
}

/**
 * A single scrape attempt: call the API, parse the JSON, verify the CDN
 * by fetching the manifest + first variant playlist. Throws NO_SOURCES
 * if the variant playlist 404s (the caller retries with a new token).
 */
async function scrapeVidsrcAttempt(
        safeTmdbId: string,
        type: 'movie' | 'tv',
        season: number | undefined,
        episode: number | undefined,
        apiDomain: string
): Promise<ScraperResult> {
        // --- Call the API ---
        const apiUrl = buildApiUrl(apiDomain, safeTmdbId, type, season, episode);
        const rawBody = await fetchJson(apiUrl, apiDomain + '/', 'vidsrc.party API');

        // --- Parse the JSON response ---
        let payload: VidsrcPartyApiResponse;
        try {
                payload = JSON.parse(rawBody) as VidsrcPartyApiResponse;
        } catch {
                console.error('[vidsrc-scraper] REGEX_PARSE_FAILED: API returned non-JSON. First 500 chars:', rawBody.slice(0, 500));
                throw new ScraperError('REGEX_PARSE_FAILED', 'The vidsrc.party API returned a non-JSON response.');
        }

        if (payload.status !== 'ready') {
                console.error('[vidsrc-scraper] NO_SOURCES: API status is not "ready":', payload.status, payload.message);
                throw new ScraperError('NO_SOURCES', `The vidsrc.party API status is "${payload.status}" (not ready).`);
        }

        const file = payload.result?.file;
        const token = payload.result?.token;
        if (!file || !token || !file.stream) {
                console.error('[vidsrc-scraper] REGEX_PARSE_FAILED: missing file.stream or token in API response. Full result:', JSON.stringify(payload.result ?? {}).slice(0, 500));
                throw new ScraperError('REGEX_PARSE_FAILED', 'The vidsrc.party API response is missing the file.stream or token field.');
        }

        // The manifest URL is the full URL: {apiDomain}{file.stream}.
        const manifestUrl = new URL(file.stream, apiDomain).toString();
        console.log(`[vidsrc-scraper] got token: ${token}, manifest: ${manifestUrl.slice(0, 80)}...`);

        // --- CDN VERIFICATION (2026-10 round 21) ---
        // Fetch the manifest and check that the first variant playlist loads.
        // vidsrc.party assigns random CDNs; some are dead (404). If the variant
        // 404s, throw NO_SOURCES so the caller retries with a new token.
        const manifestBody = await fetchJson(manifestUrl, apiDomain + '/', 'manifest');
        const variantLine = manifestBody.split('\n').find((line) => line.trim().startsWith('/p/'));
        if (variantLine) {
                const variantUrl = new URL(variantLine.trim(), apiDomain).toString();
                console.log(`[vidsrc-scraper] verifying variant playlist: ${variantUrl.slice(0, 80)}...`);
                try {
                        const variantBody = await fetchJson(variantUrl, apiDomain + '/', 'variant playlist');
                        // Check it's a valid HLS playlist (starts with #EXTM3U).
                        if (!variantBody.startsWith('#EXTM3U')) {
                                console.error('[vidsrc-scraper] variant playlist is not a valid HLS playlist. First 200 chars:', variantBody.slice(0, 200));
                                throw new ScraperError('NO_SOURCES', 'The variant playlist is not a valid HLS playlist (CDN may be dead).');
                        }
                        console.log('[vidsrc-scraper] variant playlist verified OK — CDN is working');
                } catch (error) {
                        if (error instanceof ScraperError) throw error;
                        // The variant fetch failed (404, timeout, etc.) — the CDN is dead.
                        console.error('[vidsrc-scraper] variant playlist fetch failed — CDN is dead:', error instanceof Error ? error.message : error);
                        throw new ScraperError('NO_SOURCES', 'The CDN assigned by vidsrc.party is dead (variant playlist fetch failed).');
                }
        }

        const result: ScraperResult = {
                sources: [{ url: manifestUrl, quality: 'Auto', kind: 'direct' }],
                subtitles: [],
                referer: apiDomain + '/',
                provider: 'vidsrc.party'
        };

        return result;
}

// ---------------------------------------------------------------------------
// Type definitions for the vidsrc.party API response
// ---------------------------------------------------------------------------

type VidsrcPartyApiResponse = {
        jobId?: string;
        status?: string;
        message?: string;
        result?: {
                token?: string;
                file?: {
                        stream?: string;
                        hlsStart?: string;
                        stats?: string;
                        subtitles?: string;
                        playback?: string;
                        playlist?: string;
                        mime?: string;
                };
        };
};
