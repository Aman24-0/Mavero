import type { RequestHandler } from './$types';
import { buildUpstreamVttUrl, fetchUpstreamVttText, validateLabelParam, validateTmdbIdParam } from '$lib/server/subtitles/vdrk';

// ============================================================================
// Player UI V2 (Part 1, Phase 3A) — SAME-ORIGIN VTT proxy (MOVIE).
//
// Serves /api/content/subtitles/vtt/movie/{tmdbId}/{label} for the player's
// external WebVTT <track> elements. See $lib/server/subtitles/vdrk.ts for the
// full security contract: path-segment-only inputs, strict validation, fixed
// upstream origin, text/vtt-only passthrough, timeout + size caps, bounded
// TTL cache. This is NOT a generic URL proxy — every byte of the upstream URL
// is rebuilt from validated parts.
// ============================================================================

export const GET: RequestHandler = async ({ params }) => {
  const tmdbId = validateTmdbIdParam(params.tmdbId ?? '');
  const label = validateLabelParam(params.label ?? '');
  if (tmdbId === null || label === null) {
    return new Response('Invalid subtitle request', { status: 400 });
  }
  const upstream = buildUpstreamVttUrl('movie', tmdbId, label);
  const result = await fetchUpstreamVttText(upstream);
  if (!result.ok) {
    return new Response('Subtitle unavailable', { status: result.status, headers: result.status === 503 ? { 'retry-after': '2' } : {} });
  }
  return new Response(result.text, {
    status: 200,
    headers: {
      'content-type': 'text/vtt; charset=utf-8',
      'cache-control': 'public, max-age=3600',
    },
  });
};
