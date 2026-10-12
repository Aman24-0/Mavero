/**
 * Blue Velvet — direct HLS resolver adapter (2026-10 production integration).
 *
 * Blue Velvet is an API-resolved DIRECT HLS source (not an embed): the
 * server-side adapter queries the provider's JSON endpoint, validates the
 * returned master-playlist URL, and returns it through the existing direct
 * playback contract. The browser's existing HLS engine (hls.js via the
 * Video.js HlsJs integration in `src/lib/client/player/hls-engine.ts`)
 * handles loading, quality levels and audio tracks discovered dynamically
 * from the manifest — this adapter NEVER hardcodes qualities or audio
 * renditions.
 *
 * Verified upstream contract (live probes, 2026-10-12):
 *
 *   Movie:  GET https://zcdn.bluevelvet.space/cdn?tmdb={tmdbId}&type=movie
 *   TV:     GET https://zcdn.bluevelvet.space/cdn?tmdb={tmdbId}&type=tv&season={season}&episode={episode}
 *
 *   Responses observed:
 *     HTTP 200 {"ready":true,"url":"https://zcdn.bluevelvet.space/play/{token}/master.m3u8"}
 *     HTTP 202 {"ready":false,"status":"building"}   (content still preparing)
 *     HTTP 202 {"ready":false,"status":"queued"}
 *     HTTP 400 {"error":"need tmdb"}                 (missing parameters)
 *   Content-Type of success/error payloads: application/json.
 *
 *   The master playlist (application/vnd.apple.mpegurl) observed four
 *   video variants (3840x2160 / 1920x1080 / 1280x720 / 852x480) with muxed
 *   AAC audio and NO separate #EXT-X-MEDIA audio or subtitle renditions for
 *   the probed title. Renditions can vary per title — they are left to the
 *   HLS engine's dynamic discovery; nothing is advertised statically.
 *
 *   ⚠ CORS (verified live, see the integration report): the CDN echoes
 *   `access-control-allow-origin` ONLY for allowlisted origins (verified:
 *   https://cinecat.eu is allowlisted). Mavero's deployed origin
 *   (https://mavero1.netlify.app) receives NO ACAO on the API, master
 *   playlist, child playlists, segments, and OPTIONS preflight returns 403.
 *   Server-side resolution therefore succeeds, but BROWSER playback from
 *   Mavero's current deployment is blocked by upstream CORS until the
 *   provider allowlists the deployed origin. This is why the seeded source
 *   stays DISABLED: resolution and playback must both be verified end-to-end
 *   before an admin enables it. There is deliberately NO proxy/bypass —
 *   Mavero's security contract forbids an open proxy or CORS bypass.
 *
 * Validation model (strictest observed shape — never weakened):
 *
 *   * Request identifiers: TMDB id must be a positive integer string
 *     (1-16 digits, no leading zeros); TV requires season AND episode as
 *     positive integers. Upstream silently falls back to episode 1 when
 *     season/episode are absent — Mavero rejects those requests instead
 *     (MISSING_IDENTIFIER) so a malformed request can never silently play
 *     the wrong episode.
 *   * Endpoint host is a module CONSTANT — user input can only fill query
 *     parameter VALUES, through `URLSearchParams` (never string concat).
 *   * The endpoint URL passes the shared `validateProviderEndpoint` guard
 *     (HTTPS, no credentials, no private/loopback host).
 *   * The returned media URL must be HTTPS on the exact trusted Blue Velvet
 *     origin, path `/play/{token}/master.m3u8` with a conservative token
 *     charset, no query/hash, no credentials — then the shared
 *     `validatePlaybackUrl(…, 'direct')` guard (HTTPS-only, credentials,
 *     private-host SSRF matrix) runs on top. Shared validation is used, not
 *     modified.
 *   * Failures map to the EXISTING resolver error vocabulary so the bounded
 *     fallback walk, negative cache and provider cooldown behave exactly as
 *     for every other provider:
 *         ready:false / upstream 5xx / network error → RESOLUTION_UNAVAILABLE
 *         fetch timeout                              → RESOLUTION_TIMEOUT
 *         invalid JSON / wrong shape / upstream 4xx  → PROVIDER_RESPONSE_INVALID
 *         foreign host / http / bad path / creds     → INVALID_SOURCE_URL
 *         bad identifiers                            → MISSING_IDENTIFIER
 *
 * Title-unavailable classification (Player UI V2 Part 1, Phase 1C —
 * CONSERVATIVE, evidence-based; verified live 2026-10-12):
 *
 *   The Blue Velvet API has NO confirmed "title not available" response.
 *   Probes (read-only GET, /cdn):
 *     * fake TMDB id 999999999 (movie)  → 202 {"ready":false,"status":"queued"}
 *       — re-probed for >4 minutes, never leaves queued;
 *     * real show + nonexistent episode
 *       (tmdb 1399 S99E99)              → 202 {"ready":false,"status":"building"}
 *       cycling with "queued" across 30 s;
 *     * real available titles           → 200 {"ready":true,"url":…};
 *     * missing parameters              → 400 {"error":"need tmdb"}.
 *   Nonexistent content is therefore INDISTINGUISHABLE from content still
 *   being prepared — the CDN queues every requested id regardless of whether
 *   it will ever be served. The ONLY honest mapping is:
 *     * ready:false (queued/building) → RESOLUTION_UNAVAILABLE (retryable,
 *       falls through the bounded fallback walk to the next source — the
 *       existing, documented behavior; NEVER re-classified as a confirmed
 *       missing title);
 *     * everything else unchanged (outage/timeout/invalid/URL guards).
 *   The TITLE_NOT_AVAILABLE code exists in the shared resolver vocabulary
 *   for adapters whose verified contract DOES confirm a missing title; this
 *   adapter deliberately never emits it. Inventing a missing-title semantic
 *   from queued/building would contradict the verified API behavior.
 *
 * No playback URLs or tokens are logged anywhere in this adapter.
 */

import { ResolverError } from './errors';
import { validatePlaybackUrl, validateProviderEndpoint } from './safe-url';
import type { AdapterResult, ProviderAdapter, ResolverContext } from './types';

export const BLUEVELVET_ADAPTER_ID = 'blue-velvet' as const;

/**
 * The ONLY allowed Blue Velvet origin — both for the JSON API and for the
 * returned HLS master playlists (verified: the CDN serves both from this
 * origin). User input can never change this host.
 */
export const BLUEVELVET_ORIGIN = 'https://zcdn.bluevelvet.space' as const;

/**
 * Observed master-playlist shape: /play/{token}/master.m3u8 where the token
 * is an opaque signed blob (observed charset [A-Za-z0-9._-]). Anchored and
 * non-greedy by construction — no traversal, no extra segments, no query.
 */
const MASTER_PLAYLIST_PATH = /^\/play\/[A-Za-z0-9._-]+\/master\.m3u8$/;

/** Per-attempt budget for the upstream JSON API call (matches the TMDB fetch budget). */
const BLUEVELVET_FETCH_TIMEOUT_MS = 8_000;

/** TMDB ids are positive decimal integers, no leading zeros (TMDB canonical form). */
const TMDB_ID_PATTERN = /^[1-9][0-9]{0,15}$/;

/**
 * Validates the TMDB id supplied by the resolver context. Rejects missing,
 * empty, non-numeric, zero/negative-shaped and malformed values. Returns
 * the trimmed id. The identifiers come from TMDB via
 * `normalizeContentIdentifiers` — this guard is a safety net, never a
 * transformation.
 */
function requireTmdbId(raw: string | undefined): string {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!TMDB_ID_PATTERN.test(value)) throw new ResolverError('MISSING_IDENTIFIER');
  return value;
}

/**
 * Validates a season/episode number. TV episodes REQUIRE both. Rejects
 * missing, non-integer, zero and negative values — upstream would silently
 * serve episode 1 for absent numbers, which Mavero must never allow.
 */
function requirePositiveInt(raw: number | undefined): number {
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1) {
    throw new ResolverError('MISSING_IDENTIFIER');
  }
  return raw;
}

/**
 * Builds the fixed-origin API endpoint for the request using URL +
 * URLSearchParams (values are percent-encoded by the platform — never
 * concatenated into the URL string), then passes it through the shared
 * provider-endpoint guard (HTTPS, no credentials, non-private host).
 *
 * The builder is the SINGLE validation choke point for endpoint inputs:
 * the TMDB id and (for TV) season/episode are validated HERE, so a request
 * can never reach URL construction with a malformed identifier — regardless
 * of the caller.
 */
export function buildBlueVelvetEndpoint(tmdbId: string, type: 'movie' | 'tv', season?: number, episode?: number): string {
  const endpoint = new URL('/cdn', BLUEVELVET_ORIGIN);
  endpoint.searchParams.set('tmdb', requireTmdbId(tmdbId));
  endpoint.searchParams.set('type', type);
  if (type === 'tv') {
    endpoint.searchParams.set('season', String(requirePositiveInt(season)));
    endpoint.searchParams.set('episode', String(requirePositiveInt(episode)));
  }
  return validateProviderEndpoint(endpoint.toString());
}

/**
 * Validates the media URL returned by the Blue Velvet API against the
 * observed trusted contract: HTTPS on the exact Blue Velvet origin, master
 * playlist path shape, no credentials, no query/hash. Then the shared
 * direct-playback guard runs on top (HTTPS-only, credentials, private-host
 * matrix) — the shared layer is applied, never modified.
 */
export function validateBlueVelvetMediaUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ResolverError('INVALID_SOURCE_URL');
  }
  if (url.protocol !== 'https:') throw new ResolverError('INVALID_SOURCE_URL');
  if (url.username || url.password) throw new ResolverError('INVALID_SOURCE_URL');
  if (url.origin.toLowerCase() !== BLUEVELVET_ORIGIN) throw new ResolverError('INVALID_SOURCE_URL');
  if (!MASTER_PLAYLIST_PATH.test(url.pathname)) throw new ResolverError('INVALID_SOURCE_URL');
  if (url.search || url.hash) throw new ResolverError('INVALID_SOURCE_URL');
  return validatePlaybackUrl(url.toString(), 'direct');
}

type BlueVelvetResponse = { ready?: unknown; url?: unknown; status?: unknown; error?: unknown };

// ---------------------------------------------------------------------------
// Blue Velvet master-playlist variant discovery (Player V2 remaining fixes,
// 2026-10 — Issue: the HLS quality selector never appears for Blue Velvet).
//
// VERIFIED ROOT CAUSE (live probes 2026-10-13): the CDN returns the master
// playlist with NO `access-control-allow-origin` for Mavero's deployment
// origin, so the browser-side hls.js engine CANNOT read the manifest (its
// XHR is CORS-bound) and the engine — the only surface that exposes quality
// levels — never engages. Chromium-family browsers (including the user's
// Android device) report `canPlayType(HLS)='maybe'`, so playback runs on the
// NATIVE media-element path (no-cors — works), which exposes no level API
// and rendered NO quality selector at all.
//
// THE FIX within the existing architecture (no proxy, no engine replacement):
// the SERVER resolves the same master URL the browser would play and parses
// its `#EXT-X-STREAM-INF` variants into `SourceResult.qualities` — the
// EXISTING per-source quality list contract. The player's existing
// `qualities` selector then renders Auto (= the master, native ABR) + the
// real variants, and selection swaps the media URL with position
// preservation (the existing `setQuality` pending-seek path). Media-element
// loads stay no-cors exactly like today — nothing new is exposed to the
// browser, and the strict URL contract below keeps every variant URL on the
// SAME tokenized /play/{token}/ prefix of the SAME trusted origin.
//
// Degradation: ANY failure (timeout, HTTP error, non-playlist body, parse
// miss, validation rejection) yields NO qualities — resolution and playback
// continue exactly as before. Discovery never fabricates entries.
// ---------------------------------------------------------------------------

/** The master fetch must never delay resolution meaningfully. */
const BLUEVELVET_MASTER_FETCH_TIMEOUT_MS = 3_000;
/** A master playlist is tiny; the parse input is hard-capped anyway. */
const BLUEVELVET_MASTER_MAX_CHARS = 65_536;
/** Upper bound on advertised variants (the observed streams carry ≤ 6). */
const BLUEVELVET_MAX_VARIANTS = 16;

/**
 * One variant playlist path segment under the master's token prefix.
 * Observed shape: `/play/{token}/v{N}/index.m3u8` — every segment is
 * conservative `application/x-mpegURL`-safe text with no separators, no
 * traversal and no percent-encoding.
 */
const VARIANT_SEGMENT_PATTERN = /^[A-Za-z0-9._-]+$/;

/** One parsed `#EXT-X-STREAM-INF` attribute line + its URI line. */
type MasterVariantEntry = { url: URL; height?: number; bitrate?: number };

/**
 * Parses + validates the master playlist's variant entries. Pure; unit-tested
 * truth table. Every returned URL: HTTPS, the EXACT Blue Velvet origin, the
 * SAME `/play/{token}/` prefix as the master (a variant can never point at a
 * different token or resource class), safe path segments only, `.m3u8`, no
 * query/hash.
 */
export function parseBlueVelvetVariants(masterUrl: string, body: string): MasterVariantEntry[] {
  let master: URL;
  try {
    master = new URL(masterUrl);
  } catch {
    return [];
  }
  if (master.protocol !== 'https:' || master.origin.toLowerCase() !== BLUEVELVET_ORIGIN) return [];
  if (!MASTER_PLAYLIST_PATH.test(master.pathname)) return [];
  // The token prefix everything must stay under, e.g. "/play/{token}/".
  const tokenPrefix = master.pathname.slice(0, master.pathname.lastIndexOf('/') + 1);

  const lines = body.slice(0, BLUEVELVET_MASTER_MAX_CHARS).split(/\r?\n/);
  const variants: MasterVariantEntry[] = [];
  const seen = new Set<string>();
  let pending: { resolution?: string; bandwidth?: number } | null = null;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith('#EXT-X-STREAM-INF:')) {
      pending = {};
      // An attribute may sit right after the STREAM-INF colon (observed:
      // `#EXT-X-STREAM-INF:BANDWIDTH=…`) or after any comma.
      const resolution = /(?:^|[:,])\s*RESOLUTION=([0-9]+x[0-9]+)/i.exec(line);
      if (resolution) pending.resolution = resolution[1];
      const bandwidth = /(?:^|[:,])\s*BANDWIDTH=([0-9]+)/i.exec(line);
      if (bandwidth) pending.bandwidth = Number.parseInt(bandwidth[1], 10);
      continue;
    }
    if (line.startsWith('#')) {
      // Other tags (EXT-X-MEDIA, EXT-X-VERSION, …) never carry the next URI.
      continue;
    }
    // A URI line consumes the preceding STREAM-INF (if any).
    const attrs = pending;
    pending = null;
    if (!attrs) continue;
    if (variants.length >= BLUEVELVET_MAX_VARIANTS) break;
    let resolved: URL;
    try {
      resolved = new URL(line, master);
    } catch {
      continue;
    }
    if (resolved.protocol !== 'https:') continue;
    if (resolved.origin.toLowerCase() !== BLUEVELVET_ORIGIN) continue;
    if (resolved.search || resolved.hash) continue;
    // Same token prefix + safe segments + .m3u8 suffix.
    if (!resolved.pathname.startsWith(tokenPrefix)) continue;
    const suffix = resolved.pathname.slice(tokenPrefix.length);
    const segments = suffix.split('/');
    if (segments.length === 0 || !segments[segments.length - 1].endsWith('.m3u8')) continue;
    if (segments.some((segment) => segment.length === 0 || !VARIANT_SEGMENT_PATTERN.test(segment))) continue;
    const key = resolved.toString();
    if (seen.has(key)) continue;
    seen.add(key);
    let height: number | undefined;
    if (attrs.resolution) {
      const heightPart = Number.parseInt(attrs.resolution.split('x')[1] ?? '', 10);
      if (Number.isSafeInteger(heightPart) && heightPart > 0) height = heightPart;
    }
    variants.push({ url: resolved, ...(height !== undefined ? { height } : {}), ...(Number.isFinite(attrs.bandwidth) ? { bitrate: attrs.bandwidth } : {}) });
  }
  return variants;
}

/** Maps one parsed variant onto the shared QualitySource shape (safe label). */
function variantToQualitySource(entry: MasterVariantEntry): { url: string; label?: string; height?: number; bitrate?: number } {
  const url = entry.url.toString();
  // Label derivation mirrors the player's own safe engine labels: the
  // manifest RESOLUTION height is the honest presentation value (the
  // verified stream's "3840x2160" variant is "2160p" — never the coded
  // frame height); bitrate is the fallback. Neither → no label.
  if (typeof entry.height === 'number' && entry.height > 0) {
    return { url, label: `${entry.height}p`, height: entry.height, ...(Number.isFinite(entry.bitrate) ? { bitrate: entry.bitrate } : {}) };
  }
  if (typeof entry.bitrate === 'number' && Number.isFinite(entry.bitrate) && entry.bitrate > 0) {
    const kbps = Math.round(entry.bitrate / 1000);
    const label = kbps >= 1000 ? `${Number.isInteger(kbps / 1000) ? kbps / 1000 : Number((kbps / 1000).toFixed(1))} Mbps` : `${kbps} kbps`;
    return { url, label, bitrate: entry.bitrate };
  }
  return { url };
}

/**
 * Fetches + parses the master playlist into the shared quality list.
 * Exported for focused tests; the adapter calls this fire-and-degrade.
 * ANY failure resolves to an EMPTY list — resolution never fails because
 * variant discovery did.
 */
export async function discoverBlueVelvetVariants(masterUrl: string, fetchImpl: typeof fetch = fetch): Promise<ReturnType<typeof variantToQualitySource>[]> {
  try {
    const response = await fetchImpl(masterUrl, {
      signal: AbortSignal.timeout(BLUEVELVET_MASTER_FETCH_TIMEOUT_MS),
      headers: { accept: 'application/vnd.apple.mpegurl' },
      redirect: 'error',
    });
    if (!response.ok) return [];
    const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
    if (contentType && !contentType.includes('mpegurl')) return [];
    const body = await response.text();
    if (!body.includes('#EXTM3U')) return [];
    return parseBlueVelvetVariants(masterUrl, body)
      .map(variantToQualitySource)
      .sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0));
  } catch {
    return [];
  }
}

/**
 * Performs the upstream JSON API call and validates the response against
 * the observed contract. Exported for focused tests; production callers go
 * through the adapter below.
 */
export async function requestBlueVelvetMedia(endpoint: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  let response: Response;
  try {
    response = await fetchImpl(endpoint, {
      signal: AbortSignal.timeout(BLUEVELVET_FETCH_TIMEOUT_MS),
      headers: { accept: 'application/json' },
      redirect: 'error',
    });
  } catch (error) {
    // AbortSignal.timeout fires a TimeoutError DOMException; network
    // failures reject with TypeError. Both are upstream availability
    // problems — never fake success, never leak upstream details.
    if (error instanceof Error && error.name === 'TimeoutError') throw new ResolverError('RESOLUTION_TIMEOUT');
    throw new ResolverError('RESOLUTION_UNAVAILABLE', error);
  }

  if (response.status >= 200 && response.status < 300) {
    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.toLowerCase().includes('application/json')) throw new ResolverError('PROVIDER_RESPONSE_INVALID');
    let payload: BlueVelvetResponse;
    try {
      payload = (await response.json()) as BlueVelvetResponse;
    } catch {
      throw new ResolverError('PROVIDER_RESPONSE_INVALID');
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new ResolverError('PROVIDER_RESPONSE_INVALID');
    if (payload.ready === false) throw new ResolverError('RESOLUTION_UNAVAILABLE');
    if (payload.ready !== true) throw new ResolverError('PROVIDER_RESPONSE_INVALID');
    if (typeof payload.url !== 'string' || payload.url.length === 0) throw new ResolverError('PROVIDER_RESPONSE_INVALID');
    return validateBlueVelvetMediaUrl(payload.url);
  }

  // Non-2xx: upstream contract problems vs upstream availability problems.
  // Both are honest failures — the resolver's fallback machinery decides.
  if (response.status >= 400 && response.status < 500) throw new ResolverError('PROVIDER_RESPONSE_INVALID');
  throw new ResolverError('RESOLUTION_UNAVAILABLE');
}

export const blueVelvetProviderAdapter: ProviderAdapter = {
  integrationType: 'api',
  adapterId: BLUEVELVET_ADAPTER_ID,
  async resolve(context): Promise<AdapterResult> {
    // Defensive media-type gate (mirrors the vidsrc adapter): the resolver
    // pipeline only produces 'movie' | 'series' requests; anything else
    // must fail closed through the existing typed error.
    if (context.request.mediaType !== 'movie' && context.request.mediaType !== 'series') {
      throw new ResolverError('UNSUPPORTED_MEDIA_TYPE');
    }

    // Identity: TMDB id from the resolver context (never internal DB ids).
    const tmdbId = requireTmdbId(context.identifiers.tmdbId);

    // Endpoint construction: fixed host, validated inputs, encoded values.
    const endpoint = buildBlueVelvetEndpoint(
      tmdbId,
      context.request.mediaType === 'movie' ? 'movie' : 'tv',
      context.request.season,
      context.request.episode,
    );

    const safeUrl = await requestBlueVelvetMedia(endpoint);

    // Player V2 remaining fixes (2026-10): discover the master playlist's
    // REAL variants for the player's per-source quality list (see the block
    // comment above `parseBlueVelvetVariants`). Fire-and-degrade: any
    // failure leaves `qualities` absent and playback exactly as before.
    const qualities = await discoverBlueVelvetVariants(safeUrl);

    // Normal direct HLS result — the existing HLS engine owns playback,
    // quality selection and audio-track discovery from the manifest.
    // protocol: 'hls' is guaranteed by construction (the path regex
    // enforces a .m3u8 master playlist) and matches protocolForUrl's
    // classification. It is carried in metadata.protocol — the field the
    // resolver core propagates to the player (same convention as the
    // template adapter); the top-level AdapterResult.protocol mirrors it.
    return {
      type: 'direct',
      url: safeUrl,
      protocol: 'hls',
      metadata: {
        providerName: context.config.provider.name,
        sourceName: context.config.source.name,
        protocol: 'hls',
      },
      // Only attached when the manifest genuinely exposed variants — the
      // player's selector renders nothing for an empty list (never a
      // fabricated Auto-only menu).
      ...(qualities.length > 0 ? { qualities } : {}),
    };
  },
};
