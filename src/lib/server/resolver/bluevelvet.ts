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
    };
  },
};
