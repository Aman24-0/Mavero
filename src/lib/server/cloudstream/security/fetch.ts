/**
 * MAVERO CloudStream repository manager — SSRF-safe JSON fetch facade (CS-1).
 *
 * This is a THIN FACADE over the repository's canonical SSRF-safe bounded
 * JSON fetcher `fetchStremioManifest` (decision D-006 / plan §40.2). The
 * generic JSON downloader already reuses the same primitive — CloudStream
 * does NOT duplicate the HTTP security layer.
 *
 * Guarantees inherited verbatim from `fetchStremioManifest`:
 *   * http(s) only; credentials rejected; hostname blocklist; IP-literal
 *     coverage incl. IPv4-compact/IPv6/NAT64; DNS resolution of EVERY
 *     address; connect-time re-validation via the SSRF-safe undici Agent;
 *     bounded redirects with every hop re-validated; overall timeout;
 *     streamed response-size cap; JSON-only content type.
 *
 * CloudStream-specific bounds (plan §40.3):
 *   * 10s per-document timeout, 1 MiB per document, max 3 redirects.
 *
 * SECURITY: this facade is used ONLY for repository index documents
 * (CS.json) and plugin-list documents (plugins.json). It is NEVER called
 * with a `.cs3` artifact URL — those are metadata only and never fetched.
 */

import { fetchStremioManifest, type ManifestFetchResult, type ManifestFetchDeps } from '$lib/server/streaming/stremio/manifest-fetch';
import { ManifestServiceError } from '$lib/server/streaming/stremio/errors';
import type { SafeDnsResolver } from '$lib/server/streaming/stremio/ssrf';
import { CloudStreamRepositoryError } from '../repository/errors';

/** Per-document timeout (plan §40.3: 10s per document). */
export const CLOUDSTREAM_DOC_TIMEOUT_MS = 10_000;
/** Per-document response-size cap (plan §40.3: 1 MiB). */
export const CLOUDSTREAM_DOC_MAX_BYTES = 1_048_576;
/** Bounded redirects (manifest-fetch default). */
export const CLOUDSTREAM_MAX_REDIRECTS = 3;

export type CloudStreamFetchDeps = {
  fetcher?: typeof fetch;
  dnsResolver?: SafeDnsResolver;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  /** External deadline (Permanent Adapter Plan Phase 1) — linked into the internal controller. */
  signal?: AbortSignal;
};

/**
 * Fetches one CloudStream JSON document (CS.json / plugins.json) through the
 * SSRF-safe pipeline and returns the parsed JSON body. Errors are translated
 * into the CloudStream error taxonomy with safe, curated messages.
 */
export async function fetchCloudStreamJson(rawUrl: string, deps: CloudStreamFetchDeps = {}): Promise<ManifestFetchResult> {
  const fetchDeps: ManifestFetchDeps = {
    ...(deps.fetcher !== undefined ? { fetcher: deps.fetcher } : {}),
    ...(deps.dnsResolver !== undefined ? { dnsResolver: deps.dnsResolver } : {}),
    timeoutMs: deps.timeoutMs ?? CLOUDSTREAM_DOC_TIMEOUT_MS,
    maxBytes: deps.maxBytes ?? CLOUDSTREAM_DOC_MAX_BYTES,
    maxRedirects: deps.maxRedirects ?? CLOUDSTREAM_MAX_REDIRECTS,
    ...(deps.signal !== undefined ? { signal: deps.signal } : {}),
  };
  try {
    return await fetchStremioManifest(rawUrl, fetchDeps);
  } catch (error) {
    throw translateFetchError(error);
  }
}

/** Maps the manifest-fetch error union onto the CloudStream taxonomy. */
function translateFetchError(error: unknown): CloudStreamRepositoryError {
  if (error instanceof ManifestServiceError) {
    switch (error.code) {
      case 'INVALID_URL':
        return new CloudStreamRepositoryError('INVALID_URL', { message: 'The CloudStream repository URL is not a valid URL.', cause: error });
      case 'BLOCKED_URL':
        return new CloudStreamRepositoryError('BLOCKED_URL', { message: 'The CloudStream repository URL points to a destination that is not allowed.', cause: error });
      case 'TIMEOUT':
        return new CloudStreamRepositoryError('TIMEOUT', { cause: error });
      case 'NETWORK':
        return new CloudStreamRepositoryError('NETWORK', { cause: error });
      case 'HTTP_ERROR':
        return new CloudStreamRepositoryError('HTTP_ERROR', { httpStatus: error.httpStatus, cause: error });
      case 'TOO_LARGE':
        return new CloudStreamRepositoryError('TOO_LARGE', { cause: error });
      case 'INVALID_JSON':
        return new CloudStreamRepositoryError('INVALID_JSON', { cause: error });
      default:
        return new CloudStreamRepositoryError('UNEXPECTED', { cause: error });
    }
  }
  return new CloudStreamRepositoryError('UNEXPECTED', { cause: error });
}
