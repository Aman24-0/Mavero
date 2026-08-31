import { ResolverError } from './errors';
import { validatePlaybackUrl } from './safe-url';
import type { AdapterResult, ProviderAdapter, ResolverContext } from './types';

/**
 * MAVERO Phase 7E — SuperEmbed provider adapter.
 *
 * SuperEmbed (https://www.superembed.stream/movie-streaming-api.html) exposes a
 * documented JSON API at `https://seapi.link/` that returns playable page URLs
 * for movies and TV episodes by IMDb or TMDB id. The API explicitly does NOT
 * return direct streaming-server URLs (m3u8/mp4); each result `url` is a
 * provider-hosted playable page that MAVERO renders through the existing
 * sandboxed embed iframe in `PlayerViewport.svelte`.
 *
 * Documented contract:
 *   Movie:   https://seapi.link/?type=tmdb&id={TMDB_ID}&max_results={N}
 *            https://seapi.link/?type=imdb&id={IMDB_ID}&max_results={N}
 *   TV:      https://seapi.link/?type=tmdb&id={TMDB_ID}&season={S}&episode={E}&max_results={N}
 *            https://seapi.link/?type=imdb&id={IMDB_ID}&season={S}&episode={E}&max_results={N}
 *
 * Constraints honored by this adapter:
 *   - No API key. No undocumented endpoints. No scraping. No proxying.
 *   - max_results is capped at 1 — MAVERO needs a single playable source, not a
 *     server menu. This also minimizes load on SuperEmbed's 10 req / 10 s rate
 *     limit per IP.
 *   - Returned URLs expire after 48 hours per the official docs. We tag every
 *     AdapterResult with `expiresAt` = (now + 48h - safety margin) so the
 *     existing resolver/player expiry gate refreshes URLs as needed.
 *   - An in-memory TTL cache (5 min, well below the 48h URL expiration)
 *     deduplicates concurrent and repeated resolutions for the same
 *     movie/episode, avoiding per-render API traffic.
 *   - 429 / 5xx / network / malformed responses are translated into controlled
 *     `ResolverError`s so the resolver fallback chain can move on to other
 *     providers without breaking.
 */

export const SUPEREMBED_ADAPTER_ID = 'superembed-api';
export const SUPEREMBED_API_ORIGIN = 'https://seapi.link';
const SUPEREMBED_TIMEOUT_MS = 8_000;
const SUPEREMBED_URL_TTL_MS = 48 * 60 * 60 * 1000; // 48 hours, per docs.
const SUPEREMBED_URL_SAFETY_MARGIN_MS = 5 * 60 * 1000; // refresh slightly before expiry.
const SUPEREMBED_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes — well below URL expiration.
const SUPEREMBED_MAX_RESULTS = 1;

type FetchImpl = typeof fetch;

type SuperEmbedResult = {
  server?: unknown;
  title?: unknown;
  quality?: unknown;
  size?: unknown;
  exact_match?: unknown;
  url?: unknown;
};

type SuperEmbedResponse = {
  message?: unknown;
  status?: unknown;
  title?: unknown;
  results?: unknown;
};

type CachedEntry = {
  result: AdapterResult;
  fetchedAt: number;
};

const cache = new Map<string, CachedEntry>();

/**
 * Test-only fetch injection. Tests cannot reach `seapi.link` (the host does not
 * resolve in CI), so we inject a fake `fetch` for deterministic coverage of the
 * success / empty / malformed / HTTP-error / rate-limit paths.
 */
let fetchOverride: FetchImpl | null = null;
export function setSuperEmbedFetchForTest(fetch: FetchImpl | null): void {
  fetchOverride = fetch;
  cache.clear();
}

function getFetch(): FetchImpl {
  return fetchOverride ?? globalThis.fetch;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isPositiveIntegerString(value: unknown): value is string {
  return typeof value === 'string' && /^[1-9][0-9]{0,18}$/.test(value);
}

function cleanId(value: string | undefined): string | undefined {
  if (!value) return undefined;
  // SuperEmbed accepts IMDb ids with or without `tt`; normalize by stripping it
  // so the request URL is deterministic. TMDB ids are numeric strings.
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (/^tt[0-9]{1,15}$/i.test(trimmed)) return trimmed.replace(/^tt/i, '');
  if (/^[1-9][0-9]{0,18}$/.test(trimmed)) return trimmed;
  return undefined;
}

function cacheKeyFor(context: ResolverContext): string | null {
  const { request, identifiers } = context;
  if (request.mediaType !== 'movie' && request.mediaType !== 'series') return null;
  const tmdb = cleanId(identifiers.tmdbId);
  const imdb = cleanId(identifiers.imdbId);
  // Prefer TMDB when available (matches the resolver's tmdb-first convention).
  const idPart = tmdb ? `tmdb:${tmdb}` : imdb ? `imdb:${imdb}` : null;
  if (!idPart) return null;
  if (request.mediaType === 'series') {
    if (!request.season || !request.episode) return null;
    return `series:${idPart}:s${request.season}:e${request.episode}`;
  }
  return `movie:${idPart}`;
}

function buildApiUrl(context: ResolverContext): string {
  const { request, identifiers } = context;
  const tmdb = cleanId(identifiers.tmdbId);
  const useTmdb = Boolean(tmdb);
  const id = useTmdb ? tmdb : cleanId(identifiers.imdbId);
  if (!id) throw new ResolverError('MISSING_IDENTIFIER');
  const params = new URLSearchParams();
  params.set('type', useTmdb ? 'tmdb' : 'imdb');
  params.set('id', id);
  if (request.mediaType === 'series') {
    if (!request.season || !request.episode) throw new ResolverError('MISSING_IDENTIFIER');
    params.set('season', String(request.season));
    params.set('episode', String(request.episode));
  }
  params.set('max_results', String(SUPEREMBED_MAX_RESULTS));
  return `${SUPEREMBED_API_ORIGIN}/?${params.toString()}`;
}

function parseQualityLabel(value: unknown): string | undefined {
  if (!isString(value)) return undefined;
  // SuperEmbed returns labels like "1080p", "720p", "4K", "HDR". Pass through
  // as a metadata note; do not fabricate numeric heights.
  return value.length <= 16 ? value : undefined;
}

function pickFirstResult(payload: SuperEmbedResponse): SuperEmbedResult | null {
  if (!isRecord(payload)) return null;
  const results = payload.results;
  if (!Array.isArray(results) || results.length === 0) return null;
  const first = results[0];
  return isRecord(first) ? (first as SuperEmbedResult) : null;
}

function toAdapterResult(context: ResolverContext, first: SuperEmbedResult, now: number): AdapterResult {
  if (!isString(first.url)) throw new ResolverError('PROVIDER_RESPONSE_INVALID');
  // SuperEmbed returns a playable page URL on an arbitrary player domain, so
  // we validate HTTPS + non-private-host here (the existing embed origin
  // allowlist is bypassed via the source capability `allow_dynamic_embed_origins`
  // in core.ts). The result type is `embed`, never `direct`, because the URL is
  // a playable page and the official API explicitly does not return direct
  // streaming-server URLs.
  const safeUrl = validatePlaybackUrl(first.url, 'embed', [], true);
  const metadata: AdapterResult['metadata'] = {
    providerName: context.config.provider.name,
    sourceName: context.config.source.name,
    note: 'SuperEmbed playable page returned by the documented seapi.link JSON API. MAVERO does not extract direct media URLs, scrape hosting servers, bypass ads, or proxy requests.',
  };
  const server = isString(first.server) ? first.server : undefined;
  const quality = parseQualityLabel(first.quality);
  if (server || quality) {
    metadata.title = [server, quality].filter(Boolean).join(' · ');
  }
  return {
    type: 'embed',
    url: safeUrl,
    expiresAt: new Date(now + SUPEREMBED_URL_TTL_MS - SUPEREMBED_URL_SAFETY_MARGIN_MS).toISOString(),
    metadata,
  };
}

async function fetchFromSuperEmbed(context: ResolverContext, apiUrl: string, now: number): Promise<AdapterResult | null> {
  const fetchImpl = getFetch();
  let response: Response;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SUPEREMBED_TIMEOUT_MS);
  try {
    response = await fetchImpl(apiUrl, {
      method: 'GET',
      signal: controller.signal,
      headers: { accept: 'application/json' },
      cache: 'no-store',
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw new ResolverError('RESOLUTION_UNAVAILABLE');
    throw new ResolverError('RESOLUTION_UNAVAILABLE', error);
  } finally {
    clearTimeout(timeout);
  }

  if (response.status === 429) {
    // Rate-limited per the documented 10/10s policy. Do NOT retry; let the
    // resolver fallback chain move on to other providers.
    throw new ResolverError('RESOLUTION_UNAVAILABLE');
  }
  if (!response.ok) {
    // 4xx/5xx → controlled failure. Don't leak upstream error bodies.
    throw new ResolverError('RESOLUTION_UNAVAILABLE');
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch (error) {
    throw new ResolverError('PROVIDER_RESPONSE_INVALID', error);
  }

  // SuperEmbed returns `{ message, status, results: [...] }`. The docs note that
  // empty results are returned when no source is available — surface that as a
  // controlled "no source" outcome (null) rather than a provider error.
  const first = pickFirstResult(payload as SuperEmbedResponse);
  if (!first) return null;
  return toAdapterResult(context, first, now);
}

export const superembedProviderAdapter: ProviderAdapter = {
  integrationType: 'api',
  adapterId: SUPEREMBED_ADAPTER_ID,
  async resolve(context): Promise<AdapterResult | null> {
    const { request } = context;
    if (request.mediaType !== 'movie' && request.mediaType !== 'series') {
      throw new ResolverError('UNSUPPORTED_MEDIA_TYPE');
    }
    if (request.mediaType === 'series' && (!request.season || !request.episode)) {
      throw new ResolverError('MISSING_IDENTIFIER');
    }
    const tmdb = cleanId(context.identifiers.tmdbId);
    const imdb = cleanId(context.identifiers.imdbId);
    if (!tmdb && !imdb) throw new ResolverError('MISSING_IDENTIFIER');

    const key = cacheKeyFor(context);
    if (!key) throw new ResolverError('MISSING_IDENTIFIER');

    const now = Date.now();
    const cached = cache.get(key);
    if (cached && now - cached.fetchedAt < SUPEREMBED_CACHE_TTL_MS && cached.result.expiresAt && Date.parse(cached.result.expiresAt) > now) {
      return cached.result;
    }

    const apiUrl = buildApiUrl(context);
    try {
      const result = await fetchFromSuperEmbed(context, apiUrl, now);
      if (result) cache.set(key, { result, fetchedAt: now });
      else cache.delete(key);
      return result;
    } catch (error) {
      // On failure, evict any stale entry so the next request retries fresh.
      cache.delete(key);
      throw error instanceof ResolverError ? error : new ResolverError('RESOLUTION_UNAVAILABLE', error);
    }
  },
};

/** Test-only: clear the in-memory cache between deterministic test cases. */
export function clearSuperEmbedCacheForTest(): void {
  cache.clear();
}
