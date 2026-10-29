/**
 * DirectStream — vidsrc.sh scraper module (server-only, 2026-10 round 13).
 *
 * A lightweight pure-HTTP scraper that extracts the real `.m3u8` HLS URL from
 * vidsrc's multi-hop embed chain:
 *
 *   1. Embed page   →  `https://{embedDomain}/embed/{movie|tv}/{tmdbId}[/s/e]`
 *      contains an `<iframe src="https://{cdnDomain}/rcp/{id}">`.
 *   2. RCP page     →  `https://{cdnDomain}/rcp/{id}`
 *      contains inline JS pointing to `/prorcp/{hash}` (a base64-ish hash).
 *   3. prorcp page  →  `https://{cdnDomain}/prorcp/{hash}`
 *      contains a `file: "…"` JS field whose value is the m3u8 URL, possibly
 *      with `{v1}`–`{v5}` placeholders that must be resolved to the real CDN
 *      domains, and possibly multiple `or`-separated fallback URLs.
 *
 * CONFIG-DRIVEN: the embed domain and CDN domain(s) are read from the supplied
 * `ScraperConfig` (sourced from `app_config` by the API endpoint / resolver
 * adapter), so a domain rotation does NOT require a code change or redeploy —
 * the admin updates the values in the DirectStream admin page.
 *
 * CACHE: a bounded in-memory `Map` keyed by `tmdbId:type:season:episode` with
 * a 15-minute TTL. The scrape result (m3u8 + referer) is stable for minutes,
 * so repeat requests for the same title are instant and the upstream is not
 * hammered (rate-limit protection).
 *
 * SECURITY:
 *   * `fetch` with `redirect: 'error'` (no redirect following — the embed
 *     domain is admin-configured and must be the real origin).
 *   * All fetched URLs are HTTPS-validated via `new URL()`.
 *   * The CDN Referer is set on the upstream fetch (server-side — the browser
 *     cannot set Referer, which is why playback goes through the Cloudflare
 *     Worker proxy).
 *   * No `eval`, no `vm`, no headless browser — pure regex over the HTML/JS.
 *   * The scraper NEVER logs playback URLs or tokens.
 *
 * LIMITATIONS (honest):
 *   * Scraper reliability is LOW/MEDIUM — vidsrc rotates domains frequently.
 *     When the embed/CDN domain changes, the admin updates the config and the
 *     next scrape works. The scraper will break periodically; budget for it.
 *   * Subtitles from vidsrc are UNRELIABLE — the `subtitles` array is often
 *     empty. Plan for a separate subtitle source (OpenSubtitles / VDRK).
 *   * vidsrc blocks VPN/proxy IPs — Netlify Functions run on AWS and may be
 *     blocked. Mitigation: the resolver falls back to the next source, OR
 *     the scraper routes its fetches through the Cloudflare Worker (edge IPs
 *     that bypass Cloudflare's IP block — see fetchText below).
 */

import { env as publicEnv } from '$env/dynamic/public';

/** The scraper's config — sourced from `app_config` (admin-editable). */
export type ScraperConfig = {
        /** The vidsrc embed front domain, e.g. `https://vidsrc.sh`. No trailing slash. */
        embedDomain: string;
        /**
         * Comma-separated CDN domains used to resolve the `{v1}`–`{v5}` placeholders
         * in the prorcp `file:` field. The FIRST domain is `{v1}`, the second is
         * `{v2}`, etc. e.g. `cloudnestra.com,neonhorizonworkshops.com`.
         */
        cdnDomains: string[];
};

/** Default config — used when `app_config` has no values. The admin can
 *  override these at runtime via the DirectStream admin page. */
export const DEFAULT_SCRAPER_CONFIG: ScraperConfig = {
        embedDomain: 'https://vidsrc.sh',
        cdnDomains: ['cloudnestra.com']
};

/** One resolved stream source (a proxied m3u8 URL + its quality label). */
export type ScraperSource = {
        /** The raw m3u8 URL extracted from vidsrc (pre-proxy), OR an embed iframe URL from 2embed. */
        url: string;
        /** A quality label (always "Auto" — vidsrc does not expose quality names). */
        quality: string;
        /** 'direct' for an m3u8 URL (HLS via the Worker proxy), 'embed' for an iframe URL (2embed fallback). */
        kind: 'direct' | 'embed';
};

/** The scraper's success result. */
export type ScraperResult = {
        sources: ScraperSource[];
        subtitles: string[];
        /** The Referer the CDN requires — passed to the Worker as `&r=`. */
        referer: string;
        /** The CDN domain the m3u8 was resolved to (for diagnostics). */
        provider: string;
};

/** The scraper's error codes. */
export type ScraperErrorCode =
        | 'INVALID_PARAMS'
        | 'UPSTREAM_TIMEOUT'
        | 'CLOUDFLARE_BLOCKED'
        | 'REGEX_PARSE_FAILED'
        | 'SCRAPE_FAILED'
        | 'NO_SOURCES'
        | 'FALLBACK_FAILED';

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
        // Bounded eviction: if the cache is full, drop the oldest entry.
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
 * Normalizes the embed domain from config: trims, strips trailing slash,
 * validates it's an https URL. Throws on invalid config.
 */
export function normalizeEmbedDomain(raw: string): string {
        const trimmed = raw.trim().replace(/\/+$/, '');
        if (!trimmed) throw new ScraperError('INVALID_PARAMS', 'The embed domain is not configured.');
        try {
                const url = new URL(trimmed);
                if (url.protocol !== 'https:') throw new ScraperError('INVALID_PARAMS', 'The embed domain must be https.');
                return url.origin;
        } catch {
                throw new ScraperError('INVALID_PARAMS', 'The embed domain is not a valid URL.');
        }
}

/**
 * Normalizes the CDN domains from config: trims, lowercases, strips protocol
 * and path (host-only), drops empties. Returns at least one or throws.
 */
export function normalizeCdnDomains(raw: string[]): string[] {
        const cleaned = raw
                .map((d) => d.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, ''))
                .filter((d) => d.length > 0);
        // Deduplicate while preserving order.
        return [...new Set(cleaned)];
}

// ---------------------------------------------------------------------------
// The 3-hop extraction
// ---------------------------------------------------------------------------

const FETCH_TIMEOUT_MS = 6_000;
const BROWSER_UA =
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/** Regex to find the iframe src in the embed page HTML. */
const IFRAME_SRC_PATTERN = /<iframe[^>]+src=["']([^"']+)["']/i;

/** Regex to find the prorcp hash in the RCP page. */
const PRORCP_HASH_PATTERN = /\/prorcp\/([a-zA-Z0-9=+/]+)/;

/** Regex to find the `file: "..."` field in the prorcp page. */
const FILE_FIELD_PATTERN = /file:\s*["']([^"']+)["']/;

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
 * Fetches a URL with a FULL set of browser headers (Cloudflare blocks
 * server-side requests that lack Sec-Fetch-* headers). Throws a typed
 * `ScraperError` on failure:
 *   * `UPSTREAM_TIMEOUT` — the fetch timed out (6s strict).
 *   * `CLOUDFLARE_BLOCKED` — HTTP 403/503 (Cloudflare challenge/block).
 *   * `SCRAPE_FAILED` — network error or other non-OK HTTP status.
 *
 * 2026-10 round 16 — STRICT 6s TIMEOUT via AbortController. The previous
 * `AbortSignal.timeout` was unreliable on some runtimes; AbortController
 * is the standard, well-supported way to enforce a hard deadline. If VidSrc
 * takes longer than 6s, the fetch is aborted immediately and the scraper
 * fails fast (no Netlify function hang).
 *
 * 2026-10 round 15 — WORKER FALLBACK: if `PUBLIC_STREAM_PROXY_URL` is set,
 * route the fetch through the Cloudflare Worker (edge IPs bypass Cloudflare's
 * IP-based 403). If the Worker returns a non-OK status, fall back to a direct
 * fetch as a last resort.
 */
async function fetchText(url: string, referer: string, label: string): Promise<string> {
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
                                        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
                                        'accept-language': 'en-US,en;q=0.9',
                                        'accept-encoding': 'gzip, deflate, br',
                                        'cache-control': 'no-cache',
                                        'pragma': 'no-cache',
                                        'sec-ch-ua': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
                                        'sec-ch-ua-mobile': '?0',
                                        'sec-ch-ua-platform': '"Windows"',
                                        'sec-fetch-dest': 'document',
                                        'sec-fetch-mode': 'navigate',
                                        'sec-fetch-site': 'same-origin',
                                        'sec-fetch-user': '?1',
                                        'upgrade-insecure-requests': '1',
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
                // Cloudflare challenge / bot block. Log the first 500 chars of
                // the body so we can see if it's a Cloudflare challenge page.
                const bodyText = await response.text().catch(() => '');
                console.error(`[vidsrc-scraper] ${label} Cloudflare blocked (HTTP ${response.status}). First 500 chars of response:`, bodyText.slice(0, 500));
                throw new ScraperError('CLOUDFLARE_BLOCKED', `${label} was blocked by Cloudflare (HTTP ${response.status}). The scraper's IP may be flagged.`);
        }
        if (!response.ok) {
                console.error(`[vidsrc-scraper] ${label} HTTP ${response.status}`);
                throw new ScraperError('SCRAPE_FAILED', `${label} returned HTTP ${response.status}.`);
        }
        return response.text();
}

/**
 * Builds the embed URL for the given content identifiers.
 *   Movie:  `{embedDomain}/embed/movie/{tmdbId}`
 *   TV:     `{embedDomain}/embed/tv/{tmdbId}/{season}/{episode}`
 */
export function buildEmbedUrl(embedDomain: string, tmdbId: string, type: 'movie' | 'tv', season?: number, episode?: number): string {
        if (type === 'movie') {
                return `${embedDomain}/embed/movie/${tmdbId}`;
        }
        return `${embedDomain}/embed/tv/${tmdbId}/${season}/${episode}`;
}

/**
 * Resolves the `{v1}`–`{v5}` placeholders in a raw m3u8 URL template using
 * the supplied CDN domains. `{v1}` → first domain, `{v2}` → second, etc.
 * Returns the resolved URL, or null if a placeholder has no matching domain.
 */
export function resolveM3u8Placeholders(rawTemplate: string, cdnDomains: string[]): string | null {
        let resolved = rawTemplate;
        for (let i = 0; i < cdnDomains.length; i += 1) {
                const placeholder = `{v${i + 1}}`;
                resolved = resolved.split(placeholder).join(cdnDomains[i]!);
        }
        // If any placeholder remains unresolved, the URL is unusable.
        if (/\{v\d+\}/.test(resolved)) return null;
        // Prepend https:// if the template was host-relative (no scheme).
        if (!/^https?:\/\//i.test(resolved)) {
                resolved = `https://${resolved}`;
        }
        // Validate the final URL is https.
        try {
                const url = new URL(resolved);
                if (url.protocol !== 'https:') return null;
                return url.toString();
        } catch {
                return null;
        }
}

/**
 * Parses the prorcp page's `file:` field. The field may contain multiple
 * `or`-separated URL templates (fallbacks). Each is resolved against the
 * CDN domain map. Returns the list of resolved m3u8 URLs (deduped).
 */
export function parseProrcpFileField(rawFileValue: string, cdnDomains: string[]): string[] {
        const templates = rawFileValue.split(/\s+or\s+/i);
        const urls: string[] = [];
        const seen = new Set<string>();
        for (const template of templates) {
                const trimmed = template.trim();
                if (!trimmed) continue;
                const resolved = resolveM3u8Placeholders(trimmed, cdnDomains);
                if (!resolved) continue;
                if (seen.has(resolved)) continue;
                seen.add(resolved);
                urls.push(resolved);
        }
        return urls;
}

/**
 * Extracts the prorcp hash from the RCP page body. Returns null if not found.
 */
export function extractProrcpHash(rcpBody: string): string | null {
        const match = rcpBody.match(PRORCP_HASH_PATTERN);
        return match ? match[1]! : null;
}

/**
 * Extracts the iframe src (the RCP URL) from the embed page HTML. Returns
 * null if no iframe is found.
 */
export function extractIframeSrc(embedBody: string): string | null {
        const match = embedBody.match(IFRAME_SRC_PATTERN);
        return match ? match[1]! : null;
}

/**
 * Extracts the `file:` field value from the prorcp page body. Returns null
 * if not found.
 */
export function extractFileField(prorcpBody: string): string | null {
        const match = prorcpBody.match(FILE_FIELD_PATTERN);
        return match ? match[1]! : null;
}

/**
 * The full 3-hop scrape. Returns the resolved sources + the CDN referer.
 *
 * 2026-10 round 16 — 2EMBED FALLBACK: if vidsrc fails (any ScraperError),
 * the scraper catches the error and tries 2embed.cc as a fallback. 2embed
 * returns an embed iframe URL (not a direct m3u8), so the fallback result
 * has `kind: 'embed'` sources. The resolver adapter returns the embed URL
 * as an `embed` source (the player renders it in an iframe).
 *
 * @param tmdbId  The TMDB id (positive integer string).
 * @param type    'movie' | 'tv'.
 * @param season  Required for TV.
 * @param episode Required for TV.
 * @param config  The scraper config (embed domain + CDN domains).
 */
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

        const embedDomain = normalizeEmbedDomain(config.embedDomain);
        const cdnDomains = normalizeCdnDomains(config.cdnDomains);
        if (cdnDomains.length === 0) {
                throw new ScraperError('INVALID_PARAMS', 'At least one CDN domain must be configured.');
        }

        // Check the cache first.
        const key = cacheKey(safeTmdbId, type, season, episode);
        const cached = getCached(key);
        if (cached) return cached;

        // --- Try vidsrc first ---
        let vidsrcError: ScraperError | null = null;
        try {
                const result = await scrapeVidsrcPrimary(safeTmdbId, type, season, episode, embedDomain, cdnDomains);
                setCached(key, result);
                return result;
        } catch (error) {
                if (error instanceof ScraperError) {
                        vidsrcError = error;
                        console.warn(`[vidsrc-scraper] vidsrc failed (${error.code}), trying 2embed fallback...`);
                } else {
                        console.warn('[vidsrc-scraper] vidsrc failed (unknown error), trying 2embed fallback...');
                        vidsrcError = new ScraperError('SCRAPE_FAILED', error instanceof Error ? error.message : 'unknown');
                }
        }

        // --- 2embed fallback ---
        try {
                const fallbackResult = await scrape2embed(safeTmdbId, type, season, episode);
                setCached(key, fallbackResult);
                return fallbackResult;
        } catch (fallbackErr) {
                if (fallbackErr instanceof ScraperError) {
                        console.error(`[vidsrc-scraper] 2embed fallback also failed (${fallbackErr.code}): ${fallbackErr.message}`);
                } else {
                        console.error('[vidsrc-scraper] 2embed fallback failed (unknown error)', fallbackErr);
                }
                // Both providers failed — throw the ORIGINAL vidsrc error (it's
                // the primary provider; its error is the most actionable).
                throw vidsrcError;
        }
}

/**
 * The primary vidsrc 3-hop scrape (embed → rcp → prorcp). Throws ScraperError
 * on any failure. Extracted from scrapeVidsrc so the fallback wrapper above
 * can catch its errors cleanly.
 */
async function scrapeVidsrcPrimary(
        safeTmdbId: string,
        type: 'movie' | 'tv',
        season: number | undefined,
        episode: number | undefined,
        embedDomain: string,
        cdnDomains: string[]
): Promise<ScraperResult> {
        console.log(`[vidsrc-scraper] starting scrape: tmdb=${safeTmdbId} type=${type}${type === 'tv' ? ` s${season}e${episode}` : ''} embed=${embedDomain}`);

        // --- Hop 1: embed page → find the iframe src (RCP URL) ---
        const embedUrl = buildEmbedUrl(embedDomain, safeTmdbId, type, season, episode);
        const embedBody = await fetchText(embedUrl, embedDomain + '/', 'embed page');
        const rcpUrl = extractIframeSrc(embedBody);
        if (!rcpUrl) {
                console.error('[vidsrc-scraper] REGEX_PARSE_FAILED: no iframe in embed page. First 500 chars:', embedBody.slice(0, 500));
                throw new ScraperError('REGEX_PARSE_FAILED', 'The embed page did not contain an iframe (vidsrc markup may have changed).');
        }

        // The RCP URL's origin is the CDN domain for the Referer on hop 3.
        let rcpOrigin: string;
        try {
                rcpOrigin = new URL(rcpUrl).origin;
        } catch {
                console.error('[vidsrc-scraper] REGEX_PARSE_FAILED: malformed iframe URL:', rcpUrl);
                throw new ScraperError('REGEX_PARSE_FAILED', 'The embed page returned a malformed iframe URL.');
        }
        console.log(`[vidsrc-scraper] hop 1 ok: rcp origin = ${rcpOrigin}`);

        // --- Hop 2: RCP page → find the prorcp hash ---
        const rcpBody = await fetchText(rcpUrl, embedUrl, 'rcp page');
        const prorcpHash = extractProrcpHash(rcpBody);
        if (!prorcpHash) {
                console.error('[vidsrc-scraper] REGEX_PARSE_FAILED: no prorcp hash in RCP page. First 500 chars:', rcpBody.slice(0, 500));
                throw new ScraperError('REGEX_PARSE_FAILED', 'The RCP page did not contain a prorcp hash (vidsrc markup may have changed).');
        }
        const prorcpUrl = `${rcpOrigin}/prorcp/${prorcpHash}`;
        console.log(`[vidsrc-scraper] hop 2 ok: prorcp hash = ${prorcpHash.slice(0, 16)}...`);

        // --- Hop 3: prorcp page → find the file: field → resolve placeholders ---
        const prorcpBody = await fetchText(prorcpUrl, rcpUrl, 'prorcp page');
        const fileValue = extractFileField(prorcpBody);
        if (!fileValue) {
                console.error('[vidsrc-scraper] NO_SOURCES: no file: field in prorcp page. First 500 chars:', prorcpBody.slice(0, 500));
                throw new ScraperError('NO_SOURCES', 'The prorcp page did not contain a file: field (no stream available).');
        }

        const m3u8Urls = parseProrcpFileField(fileValue, cdnDomains);
        if (m3u8Urls.length === 0) {
                console.error('[vidsrc-scraper] NO_SOURCES: could not resolve m3u8 from file: field. file value:', fileValue.slice(0, 200), 'cdn domains:', cdnDomains);
                throw new ScraperError('NO_SOURCES', 'No m3u8 URL could be resolved from the prorcp page (CDN domain mismatch).');
        }
        console.log(`[vidsrc-scraper] hop 3 ok: ${m3u8Urls.length} m3u8 URL(s) resolved. First: ${m3u8Urls[0]!.slice(0, 80)}...`);

        // The referer the CDN requires for playback. This is the rcpOrigin
        // (the CDN domain that served the prorcp page) — confirmed by
        // @definisi/vidsrc-scraper + CinePro reference implementations.
        const referer = rcpOrigin + '/';

        return {
                sources: m3u8Urls.map((url) => ({ url, quality: 'Auto', kind: 'direct' as const })),
                subtitles: [],
                referer,
                provider: 'vidsrc'
        };
}

// ---------------------------------------------------------------------------
// 2embed.cc fallback (2026-10 round 16)
// ---------------------------------------------------------------------------

/** The 2embed.cc base origin. */
const TWOEMBED_ORIGIN = 'https://www.2embed.cc';

/**
 * Builds the 2embed URL for the given content identifiers.
 *   Movie:  `https://www.2embed.cc/embed/{tmdbId}`
 *   TV:     `https://www.2embed.cc/embedtv/{tmdbId}&s={season}&e={episode}`
 */
export function build2embedUrl(tmdbId: string, type: 'movie' | 'tv', season?: number, episode?: number): string {
        if (type === 'movie') {
                return `${TWOEMBED_ORIGIN}/embed/${tmdbId}`;
        }
        return `${TWOEMBED_ORIGIN}/embedtv/${tmdbId}&s=${season}&e=${episode}`;
}

/**
 * The 2embed fallback scrape. 2embed returns an HTML page with an iframe
 * pointing at a player (e.g. 2embed's own player, or a third-party embed).
 * We extract the iframe src and return it as an `embed` source — the player
 * renders it in an iframe (no HLS extraction, no Worker proxy needed).
 *
 * If no iframe is found, throws REGEX_PARSE_FAILED. If the fetch fails,
 * throws the same ScraperError codes as the primary scraper (CLOUDFLARE_BLOCKED,
 * UPSTREAM_TIMEOUT, SCRAPE_FAILED).
 */
async function scrape2embed(
        tmdbId: string,
        type: 'movie' | 'tv',
        season: number | undefined,
        episode: number | undefined
): Promise<ScraperResult> {
        const url = build2embedUrl(tmdbId, type, season, episode);
        console.log(`[vidsrc-scraper] 2embed fallback: fetching ${url}`);
        const body = await fetchText(url, TWOEMBED_ORIGIN + '/', '2embed page');

        // 2embed's page contains one or more iframes pointing at players.
        // Extract ALL iframe srcs and return the first valid https one.
        const iframeSrcs = extractAllIframeSrcs(body);
        if (iframeSrcs.length === 0) {
                console.error('[vidsrc-scraper] 2embed REGEX_PARSE_FAILED: no iframe in 2embed page. First 500 chars:', body.slice(0, 500));
                throw new ScraperError('REGEX_PARSE_FAILED', 'The 2embed page did not contain an iframe.');
        }

        // Find the first https iframe URL (2embed sometimes uses relative URLs
        // or protocol-relative URLs — resolve them against the 2embed origin).
        for (const src of iframeSrcs) {
                try {
                        const resolved = new URL(src, TWOEMBED_ORIGIN);
                        if (resolved.protocol === 'https:' && !resolved.username && !resolved.password) {
                                console.log(`[vidsrc-scraper] 2embed fallback ok: iframe URL = ${resolved.toString().slice(0, 80)}...`);
                                return {
                                        sources: [{ url: resolved.toString(), quality: 'Auto', kind: 'embed' as const }],
                                        subtitles: [],
                                        referer: TWOEMBED_ORIGIN + '/',
                                        provider: '2embed'
                                };
                        }
                } catch {
                        // skip malformed
                }
        }

        console.error('[vidsrc-scraper] 2embed NO_SOURCES: no valid https iframe URL found. Iframes:', iframeSrcs.slice(0, 3));
        throw new ScraperError('NO_SOURCES', 'No valid embed iframe URL found in the 2embed page.');
}

/**
 * Extracts ALL iframe src attributes from an HTML body. Returns an array of
 * raw src values (may be relative or absolute). Used by the 2embed fallback.
 */
export function extractAllIframeSrcs(html: string): string[] {
        const srcs: string[] = [];
        const pattern = /<iframe[^>]+src=["']([^"']+)["']/gi;
        let match: RegExpExecArray | null;
        while ((match = pattern.exec(html)) !== null) {
                if (match[1]) srcs.push(match[1]);
        }
        return srcs;
}
