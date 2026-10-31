/**
 * DirectStream — vidcore.org scraper module (server-only, 2026-10 round 33).
 *
 * "Direct 2" — the multi-audio, MULTI-SERVER scraper. VidCore returns HLS
 * master playlists that hls.js automatically detects and exposes via the
 * Audio menu.
 *
 * 2026-10 round 32 — MULTI-SERVER EXTRACTION: VidCore's payload carries TWO
 * stream arrays, and BOTH may be present:
 *
 *   {
 *     "sources": [ { "url": "…master.m3u8", "server": "Tethys", "type": "hls" }, … ],
 *     "streams": [ { "url": "…/720/index.m3u8", "name": "720p", "type": "hls" }, … ],
 *     "subtitles": [ … ]
 *   }
 *
 * `sources` entries are SERVER-addressed (one entry per upstream server; the
 * `server` field names it). `streams` entries are the legacy shape (one entry
 * per rendition of THAT provider's stream). The scraper queries EVERY
 * configured provider IN PARALLEL, merges both arrays, and returns ONE
 * `ScraperSource` per valid HLS URL tagged with its server display name.
 * The resolver forwards the full list to the client (`metadata.servers`) so
 * the player can render the Server menu and fall back to the next server
 * when one dies.
 *
 * 2026-10 round 33 — THE CELESTIAL ROSTER (verified against the live
 * vidcore.org embed player): VidCore's servers are NOT named after branding
 * words — they are named after PLANETS AND MOONS, and the AUDIO LANGUAGE is
 * bound to the server ("Enceladus" and "Hyperion" serve Hindi, "Callisto"
 * serves Telugu, the rest serve English). The provider roster below is the
 * FULL verified list (28 sub-servers, slug form `mb-<name>`) — querying all
 * of them in parallel is how every language and every server reaches the
 * player's Server menu. Each returned source also carries a `language`
 * (parsed from the API when attached, the verified roster otherwise) so the
 * Server menu can render "Tethys (English)" / "Enceladus (Hindi)".
 */

import { env as publicEnv } from '$env/dynamic/public';
import { ScraperError, type ScraperResult, type ScraperSource } from './vidsrc-scraper';

const FETCH_TIMEOUT_MS = 10_000;
const BROWSER_UA =
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const VIDCORE_ORIGIN = 'https://vidcore.org';

/**
 * Hard bound on returned servers — mirrors the resolver's wire bounds. The
 * verified celestial roster has 28 members; the bound covers ALL of them
 * ("extract ALL servers") while still bounding a hostile payload.
 */
const MAX_SERVERS = 28;

/**
 * The FULL verified VidCore server roster (2026-10 round 33, extracted from
 * the live vidcore.org embed player's server selector). Every entry is one
 * upstream sub-server queried in parallel; the array order is the player's
 * presentation/fallback priority (planets first, then moons). The audio
 * language is bound to the server — `VIDCORE_SERVER_LANGUAGES` below is the
 * verified language for every roster entry.
 */
const VIDCORE_PROVIDERS = [
        'mb-earth',
        'mb-mars',
        'mb-jupiter',
        'mb-neptune',
        'mb-saturn',
        'mb-venus',
        'mb-mercury',
        'mb-uranus',
        'mb-titan',
        'mb-europa',
        'mb-ganymede',
        'mb-io',
        'mb-triton',
        'mb-charon',
        'mb-phobos',
        'mb-deimos',
        'mb-oberon',
        'mb-titania',
        'mb-umbriel',
        'mb-ariel',
        'mb-rhea',
        'mb-iapetus',
        'mb-dione',
        'mb-tethys',
        'mb-enceladus',
        'mb-callisto',
        'mb-hyperion',
        'mb-mimas',
] as const;

/** The canonical display name of one roster entry ('mb-enceladus' → 'Enceladus'). */
function rosterNameFor(provider: string): string {
        return provider
                .replace(/^mb-/i, '')
                .split('-')
                .map((word) => (word ? word.charAt(0).toUpperCase() + word.slice(1) : word))
                .join(' ');
}

/**
 * The VERIFIED audio language of every roster server (round 33). The embed
 * player's server selector labels them directly: Enceladus and Hyperion
 * serve Hindi, Callisto serves Telugu, every other roster member serves
 * English. Used when the API response does not attach the language itself —
 * the Server menu can then still render "Enceladus (Hindi)".
 */
const VIDCORE_SERVER_LANGUAGES: Readonly<Record<string, string>> = Object.freeze({
        'Enceladus': 'Hindi',
        'Hyperion': 'Hindi',
        'Callisto': 'Telugu',
        'Earth': 'English',
        'Mars': 'English',
        'Jupiter': 'English',
        'Neptune': 'English',
        'Saturn': 'English',
        'Venus': 'English',
        'Mercury': 'English',
        'Uranus': 'English',
        'Titan': 'English',
        'Europa': 'English',
        'Ganymede': 'English',
        'Io': 'English',
        'Triton': 'English',
        'Charon': 'English',
        'Phobos': 'English',
        'Deimos': 'English',
        'Oberon': 'English',
        'Titania': 'English',
        'Umbriel': 'English',
        'Ariel': 'English',
        'Rhea': 'English',
        'Iapetus': 'English',
        'Dione': 'English',
        'Tethys': 'English',
        'Mimas': 'English'
});

/**
 * The verified audio language of a roster provider ('mb-enceladus' →
 * 'Hindi'), or '' when the provider is not part of the verified roster.
 */
function rosterLanguageFor(provider: string): string {
        return VIDCORE_SERVER_LANGUAGES[rosterNameFor(provider)] ?? '';
}

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
 * Fetches JSON from a URL with a 10s timeout (2026-11 round 34 — raised from
 * 5s: vidcore.org/api/source/... regularly answers in >5s under load, which
 * made every VidCore source surface as "This source isn't available". When
 * VidCore fails completely the scraper throws the typed NO_SOURCES error so
 * the player falls back to the next source). Uses the Worker proxy when
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
        /** Server-addressed `sources` display name ("Tethys", "Enceladus (Hindi)"). */
        server?: string;
        /** Audio language, when the API attaches it separately ("Hindi"). */
        language?: string;
        /** Alternative language field some VidCore shapes use. */
        lang?: string;
        /** Container/protocol hint ("hls", "mp4", "dash"). */
        type?: string;
};
type VidCoreApiResponse = {
        status?: string;
        sources?: VidCoreStream[];
        streams?: VidCoreStream[];
        subtitles?: Array<{ url?: string; lang?: string; code?: string }>;
};

/** One valid HLS URL + its resolved server display name + language + quality label. */
export type VidCoreServerSource = {
        url: string;
        server: string;
        /** Audio language served by this server ('' = unknown — never invented). */
        language: string;
        quality: string;
};

/**
 * Round 33 — splits a "Enceladus (Hindi)" server string into its bare NAME
 * and its attached LANGUAGE. The parenthetical is accepted as a language
 * only when it reads like one (letters/spaces, ≤ 24 chars) — a quality or
 * note parenthetical never becomes a language. Returns null when the entry
 * carries no parenthetical.
 */
function splitAttachedLanguage(rawServer: string): { name: string; language: string } | null {
        const match = /^(.*?)\s*\(([^()]{1,24})\)\s*$/.exec(rawServer);
        if (!match) return null;
        const name = match[1]!.trim();
        const language = match[2]!.trim();
        if (!name || !/^[A-Za-z][A-Za-z /+-]*$/.test(language)) return null;
        return { name, language: titleCaseLanguage(language) };
}

/** Canonical language casing ('english' → 'English', 'portuguese (br)' stays parenthesized). */
function titleCaseLanguage(language: string): string {
        return language
                .split(/\s+/)
                .map((word) => (word ? word.charAt(0).toUpperCase() + word.slice(1) : word))
                .join(' ');
}

/**
 * Derives the server DISPLAY NAME for a stream. Priority: the entry's own
 * `server` field minus any "(language)" parenthetical (the `sources` shape)
 * → the provider's roster display name ('mb-enceladus' → 'Enceladus').
 * Never invented beyond the roster casing of the provider slug the API
 * itself addressed.
 */
function serverNameFor(entry: VidCoreStream, provider: string): string {
        const own = typeof entry.server === 'string' ? entry.server.trim() : '';
        if (own) return splitAttachedLanguage(own)?.name ?? own;
        const rosterName = rosterNameFor(provider);
        return rosterName || 'Default';
}

/**
 * Round 33 — resolves a stream's AUDIO LANGUAGE. Priority: a "(Hindi)"
 * parenthetical on the `server` field → an explicit `language`/`lang`
 * field on the entry → the VERIFIED roster language for the server name →
 * (no server field at all) the verified roster language for the provider
 * slug. When the API names a server that is NOT on the roster, the language
 * stays '' — unknown is honest, an invented language is not.
 */
function languageFor(entry: VidCoreStream, provider: string): string {
        const own = typeof entry.server === 'string' ? entry.server.trim() : '';
        if (own) {
            const attached = splitAttachedLanguage(own);
            if (attached) return attached.language;
        }
        for (const field of [entry.language, entry.lang]) {
            const value = typeof field === 'string' ? field.trim() : '';
            if (value) return titleCaseLanguage(value);
        }
        if (own) {
            // The API named THIS server — its own name decides. The lookup
            // tolerates a trailing parenthetical annotation ("Mars (4K HDR)"
            // → base name "Mars"); an unknown (non-roster) name stays
            // language-less.
            const baseName = own.replace(/\s*\([^()]{1,24}\)\s*$/, '').trim();
            return VIDCORE_SERVER_LANGUAGES[own]
                ?? VIDCORE_SERVER_LANGUAGES[titleCaseLanguage(own.toLowerCase())]
                ?? (baseName ? VIDCORE_SERVER_LANGUAGES[baseName] ?? VIDCORE_SERVER_LANGUAGES[titleCaseLanguage(baseName.toLowerCase())] ?? '' : '');
        }
        // No server field at all — the entry IS the provider's stream, and
        // the provider's verified roster language applies.
        return rosterLanguageFor(provider);
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
                        language: languageFor(entry, provider),
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
                console.log(`[vidcore-scraper] provider ${provider} OK: ${sources.length} stream(s) [${sources.map((s) => (s.language ? `${s.server} (${s.language})` : s.server)).join(', ')}], ${subtitles.length} subtitles`);
        }
        return { sources, subtitles };
}

/**
 * The VidCore scrape (round 33). Queries EVERY roster provider IN PARALLEL
 * (the FULL 28-member celestial roster — planets + moons, every audio
 * language), merges the per-provider results in VIDCORE_PROVIDERS priority
 * order (each provider's master manifests first), and returns ONE source
 * per valid HLS URL with its server display name + audio language.
 * sources[0] is the primary playback URL — the same stream the old
 * first-provider logic would have picked, so the default path is unchanged
 * — while the FULL list rides along for the player's Server menu +
 * per-server fallback.
 */
export async function scrapeVidCore(
        tmdbId: string,
        type: 'movie' | 'tv',
        season: number | undefined,
        episode: number | undefined,
): Promise<ScraperResult> {
        console.log(`[vidcore-scraper] starting: tmdb=${tmdbId} type=${type}${type === 'tv' ? ` s${season}e${episode}` : ''} providers=${VIDCORE_PROVIDERS.length} (parallel)`);

        // ALL providers at once — one 10s timeout total instead of one per
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
                language: entry.language,
        }));

        console.log(`[vidcore-scraper] aggregated ${sources.length} server(s): ${collected.map((s) => (s.language ? `${s.server} (${s.language})` : s.server)).join(', ')}`);
        return {
                sources,
                subtitles,
                referer: VIDCORE_ORIGIN + '/',
                provider: 'vidcore',
        };
}
