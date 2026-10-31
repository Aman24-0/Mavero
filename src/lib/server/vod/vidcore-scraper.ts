/**
 * DirectStream — vidcore.org scraper module (server-only, 2026-10 round 32).
 *
 * "Direct 2" — the multi-audio, MULTI-SERVER scraper. VidCore returns HLS
 * master playlists with multiple audio tracks (English, Hindi, etc.) that
 * hls.js automatically detects and exposes via the Audio menu.
 *
 * 2026-10 round 32 — MULTI-SERVER EXTRACTION: the CoorenLabs contract gives
 * VidCore's payload TWO stream arrays, and BOTH may be present:
 *
 *   {
 *     "sources": [ { "url": "…master.m3u8", "server": "Supreme", "type": "hls" }, … ],
 *     "streams": [ { "url": "…/720/index.m3u8", "name": "720p", "type": "hls" }, … ],
 *     "subtitles": [ … ]
 *   }
 *
 * `sources` entries are SERVER-addressed (one entry per upstream server —
 * Supreme, Prime, Horizon, …; the `server` field names it). `streams` entries
 * are the legacy shape (one entry per rendition of THAT provider's stream).
 * The scraper no longer picks the first working URL: it queries EVERY
 * configured provider IN PARALLEL, merges both arrays, and returns ONE
 * `ScraperSource` per valid HLS URL tagged with its server display name.
 * The resolver forwards the full list to the client (`metadata.servers`) so
 * the player can render the Server menu and fall back to the next server
 * when one dies.
 */

import { env as publicEnv } from '$env/dynamic/public';
import { ScraperError, type ScraperResult, type ScraperSource } from './vidsrc-scraper';

const FETCH_TIMEOUT_MS = 5_000;
const BROWSER_UA =
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const VIDCORE_ORIGIN = 'https://vidcore.org';

/** Hard bound on returned servers — mirrors the resolver's wire bounds. */
const MAX_SERVERS = 12;

/**
 * The list of VidCore sub-servers to query. ALL of them are queried (in
 * parallel) — the array order is the presentation/fallback priority for the
 * aggregated sources. New providers can be added here.
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

// ---------------------------------------------------------------------------
// Response contract (round 32): BOTH arrays are optional; `sources` entries
// carry the server name, `streams` entries are the legacy rendition shape.
// ---------------------------------------------------------------------------

type VidCoreStream = {
        url?: string;
        /** Legacy `streams` label ("720p", "1080p HD"). */
        name?: string;
        title?: string;
        label?: string;
        quality?: string;
        /** Server-addressed `sources` display name ("Supreme", "Prime"). */
        server?: string;
        /** Container/protocol hint ("hls", "mp4", "dash"). */
        type?: string;
};
type VidCoreApiResponse = {
        status?: string;
        sources?: VidCoreStream[];
        streams?: VidCoreStream[];
        subtitles?: Array<{ url?: string; lang?: string; code?: string }>;
};

/** One valid HLS URL + its resolved server display name + quality label. */
export type VidCoreServerSource = {
        url: string;
        server: string;
        quality: string;
};

/**
 * Derives the server DISPLAY name for a stream. Priority: the entry's own
 * `server` field (the `sources` shape) → the provider's display name
 * ('mb-andromeda' → 'Andromeda'). Never invented beyond title-casing the
 * provider slug the API itself addressed.
 */
function serverNameFor(entry: VidCoreStream, provider: string): string {
        const own = typeof entry.server === 'string' ? entry.server.trim() : '';
        if (own) return own;
        const slug = provider.replace(/^mb-/i, '').replace(/[-_]+/g, ' ').trim();
        if (!slug) return 'Default';
        return slug
                .split(' ')
                .map((word) => (word ? word.charAt(0).toUpperCase() + word.slice(1) : word))
                .join(' ');
}

function qualityLabelFor(entry: VidCoreStream): string {
        const candidates = [entry.quality, entry.name, entry.label, entry.title];
        for (const candidate of candidates) {
                const value = typeof candidate === 'string' ? candidate.trim() : '';
                if (value) return value;
        }
        return 'Auto';
}

/**
 * True when the entry is a usable HLS URL: an http(s) URL whose explicit
 * `type` (when present) is hls/undefined and which is not an obvious
 * progressive file. The HLS engine plays manifest URLs only — mp4/dash
 * entries from other servers are dropped, never coerced.
 */
function isValidHlsEntry(entry: VidCoreStream): entry is VidCoreStream & { url: string } {
        const url = typeof entry.url === 'string' ? entry.url.trim() : '';
        if (!url || !/^https?:\/\//i.test(url)) return false;
        const type = typeof entry.type === 'string' ? entry.type.trim().toLowerCase() : '';
        if (type && type !== 'hls' && type !== 'm3u8' && type !== 'application/vnd.apple.mpegurl') return false;
        return true;
}

/**
 * Round 32 master-playlist preference (kept from round 31): within one
 * provider's payload, master/index manifests carry the multi-audio tags.
 * They sort first; every other valid URL keeps its relative order.
 */
function preferMasterFirst(entries: Array<VidCoreStream & { url: string }>): Array<VidCoreStream & { url: string }> {
        const master = entries.filter((entry) => {
                const urlLower = entry.url.toLowerCase();
                return urlLower.includes('master') || urlLower.includes('index');
        });
        const rest = entries.filter((entry) => {
                const urlLower = entry.url.toLowerCase();
                return !(urlLower.includes('master') || urlLower.includes('index'));
        });
        return [...master, ...rest];
}

/**
 * Queries ONE provider and returns ALL of its valid HLS URLs (both the
 * `sources` and `streams` arrays are parsed; the arrays are merged with
 * `sources` first — they are the server-addressed entries the Server menu
 * presents). Returns an empty list when the provider is dead/empty — never
 * throws for provider-local failures (the aggregation tolerates dead servers).
 */
async function fetchVidCoreProviderSources(
        tmdbId: string,
        type: 'movie' | 'tv',
        provider: string,
        season: number | undefined,
        episode: number | undefined,
): Promise<{ sources: VidCoreServerSource[]; subtitles: string[] }> {
        const apiUrl = buildVidCoreApiUrl(tmdbId, type, provider, season, episode);
        console.log(`[vidcore-scraper] querying provider: ${provider}`);

        let rawBody: string;
        try {
                rawBody = await fetchJson(apiUrl, VIDCORE_ORIGIN + '/', `vidcore API (${provider})`);
        } catch (error) {
                console.warn(`[vidcore-scraper] provider ${provider} fetch failed:`, error instanceof Error ? error.message : error);
                return { sources: [], subtitles: [] };
        }

        let payload: VidCoreApiResponse;
        try {
                payload = JSON.parse(rawBody) as VidCoreApiResponse;
        } catch {
                console.warn(`[vidcore-scraper] provider ${provider} returned non-JSON. First 200 chars:`, rawBody.slice(0, 200));
                return { sources: [], subtitles: [] };
        }

        // Merge both arrays — `sources` (server-addressed) first, then the
        // legacy `streams`. Missing arrays are treated as empty, never coerced.
        const rawSources = Array.isArray(payload.sources) ? payload.sources : [];
        const rawStreams = Array.isArray(payload.streams) ? payload.streams : [];
        const merged = [...rawSources, ...rawStreams];

        const valid = preferMasterFirst(merged.filter(isValidHlsEntry));
        const seen = new Set<string>();
        const sources: VidCoreServerSource[] = [];
        for (const entry of valid) {
                if (sources.length >= MAX_SERVERS) break;
                const dedupeKey = entry.url.toLowerCase();
                if (seen.has(dedupeKey)) continue;
                seen.add(dedupeKey);
                sources.push({
                        url: entry.url,
                        server: serverNameFor(entry, provider),
                        quality: qualityLabelFor(entry),
                });
        }

        const subtitles = Array.isArray(payload.subtitles)
                ? payload.subtitles
                        .map((s) => (typeof s?.url === 'string' ? s.url.trim() : ''))
                        .filter((u) => u.length > 0)
                : [];

        if (sources.length === 0) {
                console.warn(`[vidcore-scraper] provider ${provider} returned no valid HLS streams.`);
        } else {
                console.log(`[vidcore-scraper] provider ${provider} OK: ${sources.length} stream(s) [${sources.map((s) => s.server).join(', ')}], ${subtitles.length} subtitles`);
        }
        return { sources, subtitles };
}

/**
 * The VidCore scrape (round 32). Queries EVERY provider IN PARALLEL, merges
 * the per-provider results in VIDCORE_PROVIDERS priority order (each
 * provider's master manifests first), and returns ONE source per valid HLS
 * URL with its server display name. sources[0] is the primary playback URL —
 * the same stream the old first-provider logic would have picked, so the
 * default path is unchanged — while the FULL list rides along for the
 * player's Server menu + per-server fallback.
 */
export async function scrapeVidCore(
        tmdbId: string,
        type: 'movie' | 'tv',
        season: number | undefined,
        episode: number | undefined,
): Promise<ScraperResult> {
        console.log(`[vidcore-scraper] starting: tmdb=${tmdbId} type=${type}${type === 'tv' ? ` s${season}e${episode}` : ''} providers=${VIDCORE_PROVIDERS.length} (parallel)`);

        // ALL providers at once — one 5s timeout total instead of one per
        // provider. A dead provider settles as { sources: [], subtitles: [] }.
        const settled = await Promise.allSettled(
                VIDCORE_PROVIDERS.map((provider) => fetchVidCoreProviderSources(tmdbId, type, provider, season, episode)),
        );

        // Aggregate in provider-priority order (allSettled preserves order).
        const seenUrls = new Set<string>();
        const collected: VidCoreServerSource[] = [];
        const subtitles: string[] = [];
        for (const outcome of settled) {
                if (outcome.status !== 'fulfilled') continue;
                for (const source of outcome.value.sources) {
                        if (collected.length >= MAX_SERVERS) break;
                        const dedupeKey = source.url.toLowerCase();
                        if (seenUrls.has(dedupeKey)) continue;
                        seenUrls.add(dedupeKey);
                        collected.push(source);
                }
                for (const subtitle of outcome.value.subtitles) {
                        if (subtitles.includes(subtitle)) continue;
                        subtitles.push(subtitle);
                }
        }

        if (collected.length === 0) {
                console.error(`[vidcore-scraper] ALL ${VIDCORE_PROVIDERS.length} providers failed or returned no valid HLS streams.`);
                throw new ScraperError('NO_SOURCES', `All VidCore servers failed (${VIDCORE_PROVIDERS.join(', ')}).`);
        }

        const sources: ScraperSource[] = collected.map((entry) => ({
                url: entry.url,
                quality: entry.quality,
                kind: 'direct',
                server: entry.server,
        }));

        console.log(`[vidcore-scraper] aggregated ${sources.length} server(s): ${collected.map((s) => s.server).join(', ')}`);
        return {
                sources,
                subtitles,
                referer: VIDCORE_ORIGIN + '/',
                provider: 'vidcore',
        };
}
