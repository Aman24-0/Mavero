/**
 * DirectStream — vidsrc.to scraper module (server-only, 2026-10 round 13).
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
 *     blocked. Mitigation: the resolver falls back to the next source.
 */

/** The scraper's config — sourced from `app_config` (admin-editable). */
export type ScraperConfig = {
        /** The vidsrc embed front domain, e.g. `https://vidsrc.to`. No trailing slash. */
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
        embedDomain: 'https://vidsrc.to',
        cdnDomains: ['cloudnestra.com']
};

/** One resolved stream source (a proxied m3u8 URL + its quality label). */
export type ScraperSource = {
        /** The raw m3u8 URL extracted from vidsrc (pre-proxy). */
        url: string;
        /** A quality label (always "Auto" — vidsrc does not expose quality names). */
        quality: string;
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

const FETCH_TIMEOUT_MS = 8_000;
const BROWSER_UA =
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/** Regex to find the iframe src in the embed page HTML. */
const IFRAME_SRC_PATTERN = /<iframe[^>]+src=["']([^"']+)["']/i;

/** Regex to find the prorcp hash in the RCP page. */
const PRORCP_HASH_PATTERN = /\/prorcp\/([a-zA-Z0-9=+/]+)/;

/** Regex to find the `file: "..."` field in the prorcp page. */
const FILE_FIELD_PATTERN = /file:\s*["']([^"']+)["']/;

/**
 * Fetches a URL with the desktop Chrome UA + the given Referer. Throws a
 * `ScraperError('UPSTREAM_TIMEOUT')` on timeout or `ScraperError('SCRAPE_FAILED')`
 * on network error. Returns the response text.
 */
async function fetchText(url: string, referer: string, label: string): Promise<string> {
        let response: Response;
        try {
                response = await fetch(url, {
                        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
                        headers: {
                                'user-agent': BROWSER_UA,
                                accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                                'accept-language': 'en-US,en;q=0.9',
                                referer
                        },
                        redirect: 'error'
                });
        } catch (error) {
                if (error instanceof Error && error.name === 'TimeoutError') {
                        throw new ScraperError('UPSTREAM_TIMEOUT', `${label} timed out.`);
                }
                throw new ScraperError('SCRAPE_FAILED', `${label} failed (network error).`);
        }
        if (!response.ok) {
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

        // --- Hop 1: embed page → find the iframe src (RCP URL) ---
        const embedUrl = buildEmbedUrl(embedDomain, safeTmdbId, type, season, episode);
        const embedBody = await fetchText(embedUrl, embedDomain + '/', 'embed page');
        const rcpUrl = extractIframeSrc(embedBody);
        if (!rcpUrl) {
                throw new ScraperError('SCRAPE_FAILED', 'The embed page did not contain an iframe (vidsrc markup may have changed).');
        }

        // The RCP URL's origin is the CDN domain for the Referer on hop 3.
        let rcpOrigin: string;
        try {
                rcpOrigin = new URL(rcpUrl).origin;
        } catch {
                throw new ScraperError('SCRAPE_FAILED', 'The embed page returned a malformed iframe URL.');
        }

        // --- Hop 2: RCP page → find the prorcp hash ---
        const rcpBody = await fetchText(rcpUrl, embedUrl, 'rcp page');
        const prorcpHash = extractProrcpHash(rcpBody);
        if (!prorcpHash) {
                throw new ScraperError('SCRAPE_FAILED', 'The RCP page did not contain a prorcp hash (vidsrc markup may have changed).');
        }
        const prorcpUrl = `${rcpOrigin}/prorcp/${prorcpHash}`;

        // --- Hop 3: prorcp page → find the file: field → resolve placeholders ---
        const prorcpBody = await fetchText(prorcpUrl, rcpUrl, 'prorcp page');
        const fileValue = extractFileField(prorcpBody);
        if (!fileValue) {
                throw new ScraperError('NO_SOURCES', 'The prorcp page did not contain a file: field (no stream available).');
        }

        const m3u8Urls = parseProrcpFileField(fileValue, cdnDomains);
        if (m3u8Urls.length === 0) {
                throw new ScraperError('NO_SOURCES', 'No m3u8 URL could be resolved from the prorcp page.');
        }

        // The referer the CDN requires for playback. This is the rcpOrigin
        // (the CDN domain that served the prorcp page) — confirmed by
        // @definisi/vidsrc-scraper + CinePro reference implementations.
        const referer = rcpOrigin + '/';

        const result: ScraperResult = {
                sources: m3u8Urls.map((url) => ({ url, quality: 'Auto' })),
                subtitles: [],
                referer,
                provider: 'vidsrc'
        };

        setCached(key, result);
        return result;
}
