import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '$lib/server/supabase/database.types';
import { buildDownloadUrl, type DownloadMediaType } from '$lib/shared/downloader';
import { fetchStremioManifest } from '$lib/server/streaming/stremio/manifest-fetch';
import type { SafeDnsResolver } from '$lib/server/streaming/stremio/ssrf';
import { ManifestServiceError } from '$lib/server/streaming/stremio/errors';
import { normalizeJsonDownloadPayload, type NormalizedJsonDownloadLink } from './json-normalize';

/**
 * MAVERO generic JSON downloader service (type = 'json' providers).
 *
 * Orchestrates the server-side resolution for JSON API downloaders:
 *   1. Load the ENABLED provider from the downloader registry (public view —
 *      disabled providers are invisible here).
 *   2. Verify the provider is type 'json' and supports the requested media
 *      type.
 *   3. Build the API URL with the EXISTING shared template builder
 *      (buildDownloadUrl — the same code path every embed provider uses).
 *   4. Fetch the configured API endpoint server-side through Mavero's
 *      EXISTING SSRF-safe infrastructure (fetchStremioManifest): HTTPS-only,
 *      credentials rejected, localhost/private/metadata destinations blocked
 *      (synchronously AND via DNS resolution of every address), bounded
 *      redirects each re-validated, overall timeout, response size capped
 *      while streaming, JSON parsed only after the bounded body is obtained.
 *   5. Normalize the document with the generic normalizer and return ONLY
 *      the sanitized link payload.
 *
 * SECURITY BOUNDARY (this is NOT a generic SSRF proxy):
 *   * The client NEVER supplies a URL — only providerId + media context.
 *     The URL is always built from the ADMIN-CONFIGURED template in the
 *     registry.
 *   * Only the configured JSON API endpoint is fetched. The returned
 *     media/download URLs are NEVER fetched server-side — they are passed
 *     through to the browser verbatim (Download/Share use the exact URL).
 *   * Upstream failures surface as generic, non-disclosing outcomes — no
 *     upstream bodies, headers, or secrets ever reach the client.
 */

type DownloadClient = SupabaseClient<Database>;

/** Per-request timeout for the JSON API fetch (JSON documents are small). */
export const JSON_DOWNLOADER_TIMEOUT_MS = 15_000;
/** Maximum response body size (1 MiB — mirrors the 4K adapter). */
export const JSON_DOWNLOADER_MAX_BYTES = 1_048_576;
/** Bounded redirect hops, each re-validated by the shared fetcher. */
export const JSON_DOWNLOADER_MAX_REDIRECTS = 3;

/** The registry fields the JSON resolution needs (subset of the public row). */
export type JsonDownloaderProvider = {
  id: string;
  name: string;
  slug: string;
  /** Raw column value — 'json' is verified by resolveJsonDownloadLinks. */
  type: string;
  supportsMovie: boolean;
  supportsTv: boolean;
  movieUrlTemplate: string | null;
  tvUrlTemplate: string | null;
};

/** The client-supplied media context (NO raw URLs — never accepted). */
export type JsonDownloadRequest = {
  mediaType: DownloadMediaType;
  tmdbId: string;
  season?: number;
  episode?: number;
};

/** Injectable dependencies so tests never hit the network or a database. */
export type JsonDownloadDeps = {
  fetcher?: typeof fetch;
  dnsResolver?: SafeDnsResolver;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
};

/**
 * Typed failure reasons — the endpoint maps every one of these to a generic,
 * non-disclosing response; tests assert them directly.
 */
export type JsonDownloadFailureReason =
  | 'not-found' // no enabled provider with this id
  | 'not-json' // provider exists but is not type 'json'
  | 'not-capable' // provider does not support the requested media type
  | 'url-not-buildable'; // template cannot resolve for this item (e.g. missing season)

export type JsonDownloadOutcome =
  | { status: 'ok'; links: NormalizedJsonDownloadLink[] }
  | { status: 'failed'; reason: JsonDownloadFailureReason }
  /** The configured API explicitly reported failure (ok=false / error). */
  | { status: 'upstream-error' }
  /** The fetch/parse failed (timeout, too large, blocked, HTTP error, bad JSON). */
  | { status: 'unavailable' };

/**
 * Loads an ENABLED provider from the downloader registry public view.
 * Returns null when the provider does not exist or is disabled — both are
 * the same non-disclosing "not found" to the caller.
 */
export async function loadJsonDownloadProvider(client: DownloadClient, providerId: string): Promise<JsonDownloaderProvider | null> {
  const { data, error } = await client
    .from('download_providers_public')
    .select('id,name,slug,type,supports_movie,supports_tv,movie_url_template,tv_url_template')
    .eq('id', providerId)
    .eq('enabled', true)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return {
    id: data.id,
    name: data.name,
    slug: data.slug,
    type: data.type,
    supportsMovie: data.supports_movie,
    supportsTv: data.supports_tv,
    movieUrlTemplate: data.movie_url_template,
    tvUrlTemplate: data.tv_url_template,
  };
}

/**
 * Resolves ONE json-type provider into a normalized list of download links.
 *
 * Checks (in order): type === 'json' → media capability → URL buildability.
 * Then fetches the configured endpoint through the SSRF-safe fetcher and
 * normalizes the document. Never throws for provider/fetch/parse problems —
 * every failure is a typed outcome the endpoint maps to a generic response.
 */
export async function resolveJsonDownloadLinks(
  provider: JsonDownloaderProvider,
  request: JsonDownloadRequest,
  deps: JsonDownloadDeps = {}
): Promise<JsonDownloadOutcome> {
  // 2. The provider must be a json-type downloader. An embed provider's URL
  //    is an HTML page — fetching and parsing it as JSON here would be wrong,
  //    and iframing a json provider is exactly what this type forbids.
  if (provider.type !== 'json') {
    return { status: 'failed', reason: 'not-json' };
  }

  // 3. Media capability.
  const capable = request.mediaType === 'movie' ? provider.supportsMovie : provider.supportsTv;
  if (!capable) {
    return { status: 'failed', reason: 'not-capable' };
  }

  // 4. Build the URL with the EXISTING shared template builder (same code
  //    path as the embed flow — placeholder substitution + HTTPS check).
  const apiUrl = buildDownloadUrl(provider, {
    mediaType: request.mediaType,
    tmdbId: request.tmdbId,
    season: request.season,
    episode: request.episode,
  });
  if (!apiUrl) {
    return { status: 'failed', reason: 'url-not-buildable' };
  }

  // 5. Fetch through the SSRF-safe infrastructure (every hop re-validated,
  //    bounded redirects, timeout, streamed size cap, JSON-only content).
  let body: unknown;
  try {
    const result = await fetchStremioManifest(apiUrl, {
      ...(deps.fetcher ? { fetcher: deps.fetcher } : {}),
      ...(deps.dnsResolver ? { dnsResolver: deps.dnsResolver } : {}),
      timeoutMs: deps.timeoutMs ?? JSON_DOWNLOADER_TIMEOUT_MS,
      maxBytes: deps.maxBytes ?? JSON_DOWNLOADER_MAX_BYTES,
      maxRedirects: deps.maxRedirects ?? JSON_DOWNLOADER_MAX_REDIRECTS,
    });
    body = result.body;
  } catch (error) {
    // Safe, code-only diagnostics (no upstream bodies, no addresses).
    const code = error instanceof ManifestServiceError ? error.code : 'UNEXPECTED';
    console.warn(`[JsonDownloader] API fetch failed (${code}) for provider ${provider.slug}`);
    return { status: 'unavailable' };
  }

  // 6. Normalize. An explicit ok=false/error document is a generic upstream
  //    failure; a valid document with no recognizable links is a clean empty
  //    success (the UI shows the "no links" state — never an iframe).
  const normalized = normalizeJsonDownloadPayload(body);
  if (normalized.upstreamError) {
    console.info(`[JsonDownloader] provider ${provider.slug} reported an upstream error`);
    return { status: 'upstream-error' };
  }
  console.info(`[JsonDownloader] provider ${provider.slug} resolved ${normalized.links.length} link(s), malformed=${normalized.malformed}`);
  return { status: 'ok', links: normalized.links };
}
