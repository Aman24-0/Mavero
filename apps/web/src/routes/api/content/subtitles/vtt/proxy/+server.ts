import type { RequestHandler } from './$types';
import {
  decodeVidflixSubtitleUrl,
  fetchVidflixSubtitleText,
  isWebVttBody,
  srtToWebVtt,
} from '$lib/server/subtitles/vidflix';

// ============================================================================
// Round 42 (2026-11) — VidFlix SAME-ORIGIN SRT→VTT subtitle proxy.
//
// Serves /api/content/subtitles/vtt/proxy?u=<base64url(absolute https url)>
// for the player's external WebVTT <track> elements. See
// $lib/server/subtitles/vidflix.ts for the full security contract: opaque
// base64url input ONLY, decoded host must be EXACTLY
// cacdn.hakunaymatata.com (the VidFlix subtitle CDN), https-only, no
// cross-host redirects (redirect: 'error'), 5s timeout + streamed 2 MB
// size cap, SRT→VTT conversion for non-WEBVTT bodies. NOT a generic URL
// proxy — the VDRK subtitle routes' security posture, applied to one host.
// ============================================================================

export const GET: RequestHandler = async ({ url }) => {
  const upstream = decodeVidflixSubtitleUrl(url.searchParams.get('u'));
  if (upstream === null) {
    return new Response('Invalid subtitle request', { status: 400 });
  }
  const result = await fetchVidflixSubtitleText(upstream);
  if (!result.ok) {
    return new Response('Subtitle unavailable', { status: result.status, headers: result.status === 504 ? { 'retry-after': '2' } : {} });
  }
  // A body that already starts with WEBVTT passes through as-is; anything
  // else (SRT) is converted: numeric cue indices dropped, the ',' decimal
  // separator in timestamp lines replaced with '.', "WEBVTT\n\n" prepended.
  const body = isWebVttBody(result.text) ? result.text : srtToWebVtt(result.text);
  return new Response(body, {
    status: 200,
    headers: {
      'content-type': 'text/vtt; charset=utf-8',
      'cache-control': 'public, max-age=300',
    },
  });
};
