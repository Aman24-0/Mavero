import {
  buildEmbedUrl,
  fetchEmbedPage,
  findMediaUrl,
  type ExtractError,
  type ExtractParams,
  type ExtractResult,
} from './types.js';

/**
 * VidSrc real extractor — fetches the embed page with spoofed
 * browser headers, parses the response for an m3u8 / mp4 URL using
 * the multi-stage `findMediaUrl` parser, and returns a typed
 * `ExtractResult`.
 *
 * NEVER throws synchronously — every failure path rejects with a
 * typed `ExtractError` so the SSE handler's `.catch()` can convert
 * it into a `{"status":"failed"}` event without crashing the stream.
 *
 * Honors the caller's `AbortSignal` so a client disconnect cancels
 * the in-flight fetch.
 */

const PROVIDER = 'VidSrc';
const EMBED_BASE = 'https://vidsrc.sh/embed/movie/$id';
const EMBED_BASE_TV = 'https://vidsrc.sh/embed/tv/$id/$season/$episode';

export async function extract(
  params: ExtractParams,
  options: { signal?: AbortSignal } = {},
): Promise<ExtractResult> {
  const embedUrl =
    params.mediaType === 'series'
      ? buildEmbedUrl(EMBED_BASE_TV, params)
      : buildEmbedUrl(EMBED_BASE, params);

  let body: string;
  try {
    body = await fetchEmbedPage({ url: embedUrl, signal: options.signal });
  } catch (error) {
    // fetchEmbedPage rejects with an ExtractError-shaped object.
    const err = error as ExtractError;
    throw { provider: PROVIDER, category: err.category ?? 'NETWORK_ERROR', error: err.error ?? 'fetch failed' } satisfies ExtractError;
  }

  const parsed = findMediaUrl(body, new URL(embedUrl).origin);
  if (!parsed) {
    throw { provider: PROVIDER, category: 'NO_STREAM', error: 'no playable stream found in embed page' } satisfies ExtractError;
  }

  return {
    provider: PROVIDER,
    url: parsed.url,
    type: parsed.type,
  };
}
