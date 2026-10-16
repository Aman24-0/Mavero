/**
 * Vixolity — direct HLS resolver adapter (2026-10 production integration).
 *
 * Vixolity is a DIRECT HLS source driven by IMDb ids: the playback URL is
 * constructed deterministically from the content's IMDb identifier — there
 * is NO upstream JSON API, NO scraping step and NO token exchange. The
 * supplied direct URL format IS the integration contract:
 *
 *   Movie:  https://ha.vixolity.com/vs/{imdbId}
 *   Series: https://ha.vixolity.com/vs/{imdbId}/s{season}/e{episode}
 *
 *   (Examples supplied with the contract — formatting references, not real
 *    content mappings: "/vs/tt1234567", "/vs/tt1234567/s1/e01",
 *    "/vs/tt1234567/s2/e12". Seasons render UNPADDED (s1, s2); episodes
 *    render with AT LEAST two digits (e01, e12, e123).)
 *
 * The adapter therefore does exactly three things — nothing more:
 *   1. Takes the IMDb id from the resolver context's external-id mapping
 *      (TMDB `external_ids.imdb` — populated by the existing TMDB content
 *      adapter). It NEVER substitutes a TMDB id into the IMDb position and
 *      NEVER fabricates an id: a missing/malformed IMDb id fails with the
 *      typed MISSING_IDENTIFIER error so the existing bounded fallback walk
 *      continues to the next source.
 *   2. Builds the URL on the FIXED module-constant origin with validated
 *      inputs (the id/season/episode can never alter the host), then runs
 *      the shared `validatePlaybackUrl(…, 'direct')` guard on top.
 *   3. Returns the direct result with `protocol: 'hls'` in metadata — the
 *      contract classifies Vixolity as a direct HLS provider and the URL
 *      itself carries no `.m3u8` extension, so the explicit protocol is
 *      what lets the client engine route playback through the EXISTING
 *      architecture: hls.js (lazy dynamic import, never forced globally)
 *      where native HLS is unavailable, native HLS where supported. Audio
 *      tracks and quality levels are discovered dynamically by that engine
 *      from each title's manifest — this adapter NEVER hardcodes renditions
 *      and never advertises qualities it has not seen.
 *
 * Why there is deliberately NO server-side playlist fetch/variant discovery
 * (unlike Blue Velvet): Blue Velvet's adapter validates an upstream JSON
 * API envelope and parses the master playlist server-side ONLY because its
 * verified CORS contract blocks the browser's hls.js from reading the
 * manifest. Vixolity's contract supplies the media URL directly — there is
 * no response envelope to validate, and no verified CORS restriction is
 * known for ha.vixolity.com. Inventing a server-side playlist probe would
 * add an undocumented upstream dependency to every resolve; the existing
 * engine already validates the playlist response at playback time (hls.js
 * recovery + fatal-error path → the player's existing error/retry/switch
 * flow). If live verification later shows a Blue-Velvet-style CORS block,
 * a follow-up can port the variant-discovery pattern WITHOUT contract
 * changes.
 *
 * Validation model (strictest observed shape — never weakened):
 *   * IMDb id: `tt` + 7-8 digits (IMDb canonical form). Anything else —
 *     including a bare TMDB numeric id, an empty value or traversal
 *     characters — is MISSING_IDENTIFIER (never URL-encoded into place).
 *   * Season/episode: positive integers (1-10000 per the resolver request
 *     validation). Series REQUIRE both; the episode is zero-padded to at
 *     least two digits; the season renders unpadded (verified examples).
 *   * Media URL: HTTPS on the EXACT trusted origin, path
 *     `/vs/{imdbId}[/s{season}/e{episode+}]`, no query, no hash, no
 *     credentials — then the shared direct-playback guard (HTTPS-only,
 *     credentials, private-host SSRF matrix). Shared validation is used,
 *     not modified.
 *   * Media type: only 'movie' | 'series' reach an adapter (the resolver
 *     pipeline normalizes anime to series); anything else fails closed.
 *
 * Failures map to the EXISTING resolver error vocabulary so the bounded
 * fallback walk, negative cache and provider cooldown behave exactly as
 * for every other provider:
 *     missing/malformed IMDb id            → MISSING_IDENTIFIER
 *     series without season/episode        → MISSING_IDENTIFIER
 *     unsupported media type               → UNSUPPORTED_MEDIA_TYPE
 *     foreign host / http / bad path/creds → INVALID_SOURCE_URL
 *
 * No playback URLs are logged anywhere in this adapter.
 */

import { ResolverError } from './errors';
import { validatePlaybackUrl } from './safe-url';
import type { AdapterResult, ProviderAdapter, ResolverContext } from './types';

export const VIXOLITY_ADAPTER_ID = 'vixolity' as const;

/**
 * The ONLY allowed Vixolity origin. User input (imdb id, season, episode)
 * can never change this host — it is a module constant, mirrored by the
 * `allowed_embed_origins`-independent direct validation below.
 */
export const VIXOLITY_ORIGIN = 'https://ha.vixolity.com' as const;

/**
 * IMDb identifier canonical form: `tt` + 7 or 8 digits. This is the strict
 * shape the provider path expects (`/vs/tt…`); it simultaneously guarantees
 * a TMDB numeric id can NEVER be substituted into the IMDb position.
 */
const IMDB_ID_PATTERN = /^tt\d{7,8}$/;

/**
 * Observed media path shape: `/vs/{imdbId}` for movies,
 * `/vs/{imdbId}/s{season}/e{episode}` for series (episode ≥ 2 digits).
 * Anchored — no traversal, no extra segments, no query.
 */
const MEDIA_PATH_PATTERN = /^\/vs\/tt\d{7,8}(\/s\d+\/e\d{2,})?$/;

/** Upper bound mirrors the resolver request's own season/episode validation. */
function requirePositiveInt(raw: number | undefined): number {
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1 || raw > 10000) {
    throw new ResolverError('MISSING_IDENTIFIER');
  }
  return raw;
}

/**
 * Validates the IMDb id supplied by the resolver context. Rejects missing,
 * empty, non-IMDb-shaped values (including bare TMDB numeric ids) — a
 * safety net over `normalizeContentIdentifiers`, never a transformation.
 */
export function requireImdbId(raw: string | undefined): string {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!IMDB_ID_PATTERN.test(value)) throw new ResolverError('MISSING_IDENTIFIER');
  return value;
}

/**
 * Builds the fixed-origin media URL for the request. Pure string assembly
 * over VALIDATED inputs (the id/season/episode patterns above make URL
 * injection impossible), then the full direct-playback validation runs.
 * Exported for focused tests; production callers go through the adapter.
 */
export function buildVixolityMediaUrl(
  imdbId: string,
  mediaType: 'movie' | 'series',
  season?: number,
  episode?: number,
): string {
  const id = requireImdbId(imdbId);
  let pathname: string;
  if (mediaType === 'movie') {
    pathname = `/vs/${id}`;
  } else {
    // Series REQUIRE both numbers — the provider path cannot address an
    // episode without them, and guessing episode 1 would silently play the
    // wrong content (the same failure mode Blue Velvet refuses).
    const s = requirePositiveInt(season);
    const e = requirePositiveInt(episode);
    pathname = `/vs/${id}/s${s}/e${String(e).padStart(2, '0')}`;
  }
  return validateVixolityMediaUrl(`${VIXOLITY_ORIGIN}${pathname}`);
}

/**
 * Validates a media URL against the verified contract: HTTPS, the EXACT
 * Vixolity origin, the `/vs/…` path shape, no credentials/query/hash. The
 * shared direct-playback guard runs on top — the shared layer is applied,
 * never modified.
 */
export function validateVixolityMediaUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ResolverError('INVALID_SOURCE_URL');
  }
  if (url.protocol !== 'https:') throw new ResolverError('INVALID_SOURCE_URL');
  if (url.username || url.password) throw new ResolverError('INVALID_SOURCE_URL');
  if (url.origin.toLowerCase() !== VIXOLITY_ORIGIN) throw new ResolverError('INVALID_SOURCE_URL');
  if (!MEDIA_PATH_PATTERN.test(url.pathname)) throw new ResolverError('INVALID_SOURCE_URL');
  if (url.search || url.hash) throw new ResolverError('INVALID_SOURCE_URL');
  return validatePlaybackUrl(url.toString(), 'direct');
}

export const vixolityProviderAdapter: ProviderAdapter = {
  integrationType: 'direct',
  adapterId: VIXOLITY_ADAPTER_ID,
  async resolve(context): Promise<AdapterResult> {
    // Defensive media-type gate (mirrors the bluevelvet/vidsrc adapters):
    // the resolver pipeline only produces 'movie' | 'series' requests;
    // anything else must fail closed through the existing typed error.
    if (context.request.mediaType !== 'movie' && context.request.mediaType !== 'series') {
      throw new ResolverError('UNSUPPORTED_MEDIA_TYPE');
    }

    // Identity: IMDb id from the resolver context (never internal DB ids,
    // never the TMDB id — the substitution is structurally impossible: a
    // TMDB id is numeric and IMDB_ID_PATTERN requires the tt-prefix).
    const imdbId = requireImdbId(context.identifiers.imdbId);

    const safeUrl = buildVixolityMediaUrl(
      imdbId,
      context.request.mediaType,
      context.request.season,
      context.request.episode,
    );

    // Direct HLS result — the existing HLS engine owns playback, audio-track
    // and quality discovery from the manifest (nothing is advertised
    // statically). protocol 'hls' is the contract's classification and is
    // carried in metadata.protocol — the field the resolver core propagates
    // to the player (same convention as the template adapter and Blue
    // Velvet); the top-level AdapterResult.protocol mirrors it.
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
