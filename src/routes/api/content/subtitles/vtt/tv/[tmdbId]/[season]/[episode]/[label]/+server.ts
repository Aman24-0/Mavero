import type { RequestHandler } from './$types';
import { buildUpstreamVttUrl, fetchUpstreamVttText, validateLabelParam, validatePositiveIntParam, validateTmdbIdParam } from '$lib/server/subtitles/vdrk';

// ============================================================================
// Player UI V2 (Part 1, Phase 3A) — SAME-ORIGIN VTT proxy (TV EPISODE).
//
// Serves /api/content/subtitles/vtt/tv/{tmdbId}/{season}/{episode}/{label}
// for the player's external WebVTT <track> elements. See
// $lib/server/subtitles/vdrk.ts for the full security contract: path-segment
// inputs only (season/episode validated as positive integers — Mavero never
// silently falls back to another episode), strict label validation, fixed
// upstream origin, text/vtt-only passthrough, timeout + size caps, bounded
// TTL cache. NOT a generic URL proxy.
// ============================================================================

export const GET: RequestHandler = async ({ params }) => {
  const tmdbId = validateTmdbIdParam(params.tmdbId ?? '');
  const season = validatePositiveIntParam(params.season ?? '');
  const episode = validatePositiveIntParam(params.episode ?? '');
  const label = validateLabelParam(params.label ?? '');
  if (tmdbId === null || season === null || episode === null || label === null) {
    return new Response('Invalid subtitle request', { status: 400 });
  }
  const upstream = buildUpstreamVttUrl('tv', tmdbId, label, season, episode);
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
