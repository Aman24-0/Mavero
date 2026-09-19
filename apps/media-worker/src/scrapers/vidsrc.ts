import {
  buildEmbedUrl,
  fetchEmbedPage,
  findM3u8Url,
  type ExtractParams,
  type ExtractResult,
} from './types.js';

/**
 * Phase 5 — VidSrc real scraper.
 *
 * Fetches the VidSrc embed page (https://vidsrc.sh/embed/movie/$id or
 * https://vidsrc.sh/embed/tv/$id/$season/$episode), spoofs a Chrome
 * User-Agent + Referer + Accept-Language to bypass basic blocks, and
 * parses the returned HTML / packed JavaScript for the raw .m3u8
 * master playlist URL.
 *
 * The function NEVER throws synchronously — every failure path
 * REJECTS with an `ExtractError` so the SSE handler in `server.ts`
 * can convert the rejection into a `{"status":"failed"}` event
 * without crashing the stream (Phase 2 contract preserved).
 */

const PROVIDER = 'VidSrc';
const EMBED_BASE = 'https://vidsrc.sh/embed/movie/$id';
const EMBED_BASE_TV = 'https://vidsrc.sh/embed/tv/$id/$season/$episode';

export async function extract(params: ExtractParams): Promise<ExtractResult> {
  const embedUrl =
    params.mediaType === 'series'
      ? buildEmbedUrl(EMBED_BASE_TV, params)
      : buildEmbedUrl(EMBED_BASE, params);

  let body: string;
  try {
    body = await fetchEmbedPage({ url: embedUrl });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'network error';
    return Promise.reject({ provider: PROVIDER, error: `fetch failed: ${message}` });
  }

  // VidSrc packs the playlist URL inside JavaScript blobs — look for any
  // .m3u8 occurrence and normalize to an absolute https URL.
  const streamUrl = findM3u8Url(body, new URL(embedUrl).origin);
  if (!streamUrl) {
    return Promise.reject({ provider: PROVIDER, error: 'no m3u8 found in embed page' });
  }

  return {
    provider: PROVIDER,
    url: streamUrl,
    type: 'hls',
  };
}
