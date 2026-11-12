import { isContentType, isValidContentId, type ContentType, type NormalizedMediaItem } from '../content/types';
import { ResolverError } from './errors';
import type { ContentIdentifiers, ResolverMediaType, ResolverRequest } from './types';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function positiveInteger(value: unknown, label: string): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0 || value > 10000) throw new ResolverError('INVALID_REQUEST');
  return value;
}

export function parseResolverRequest(input: unknown): ResolverRequest {
  if (!isRecord(input) || typeof input.sourceId !== 'string' || !uuidPattern.test(input.sourceId)) throw new ResolverError('INVALID_REQUEST');
  if (typeof input.contentId !== 'string' || !isValidContentId(input.contentId)) throw new ResolverError('INVALID_REQUEST');
  if (typeof input.mediaType !== 'string' || !isContentType(input.mediaType)) throw new ResolverError('INVALID_REQUEST');

  // PROVIDER CONTRACT NORMALIZATION (deep-audit Section 3):
  //
  // The public route identity ('anime-series' / 'anime-movie') is a URL/SEO
  // concept and NEVER reaches an upstream endpoint. The provider playback
  // pipeline speaks only 'movie' | 'series' — anime IS TMDB TV (genre 16 +
  // original_language 'ja'), so a legacy 'anime' mediaType is normalized to
  // the SERIES contract here instead of failing the strict content-type
  // identity check in resolveSourceFromConfig (content.type === 'series'
  // !== 'anime' → INVALID_REQUEST — the demonstrated "The playback request
  // is invalid" root cause for anime-series playback).
  //
  // Season/episode semantics are unchanged: anime series use the TV
  // contract (TMDB TV id + season + episode); anime movies already flow
  // through the movie contract. The internal Mavero identity ('anime' in
  // media_items/content_type and progress records) is NOT affected — this
  // mapping exists only inside the resolver request boundary.
  const mediaType: ContentType = input.mediaType === 'anime' ? 'series' : input.mediaType;

  const season = positiveInteger(input.season, 'season');
  const episode = positiveInteger(input.episode, 'episode');
  if (mediaType === 'movie' && (season !== undefined || episode !== undefined)) throw new ResolverError('INVALID_REQUEST');
  if ((season === undefined) !== (episode === undefined)) throw new ResolverError('INVALID_REQUEST');

  const request: ResolverRequest = { sourceId: input.sourceId, contentId: input.contentId, mediaType };
  if (season !== undefined) request.season = season;
  if (episode !== undefined) request.episode = episode;
  const fallbackFlag = typeof input.enableFallback === 'boolean' ? input.enableFallback : input.allowFallback;
  if (typeof fallbackFlag === 'boolean') request.allowFallback = fallbackFlag;
  // Phase 2: optional admin-configured default source. Validated as a UUID
  // if present; the resolver's fallback walker uses it as a sort hint. The
  // default may be absent, in which case the existing ranking-only order
  // applies (Phase 1 behavior).
  if (typeof input.defaultSourceId === 'string' && uuidPattern.test(input.defaultSourceId)) {
    request.defaultSourceId = input.defaultSourceId;
  }
  // MAVP-5 (Issue 6): the ORDERED default sources (primary → secondary →
  // tertiary). Strictly validated: each entry must be a UUID, at most
  // three, all distinct; anything malformed drops the whole list (the
  // request stays valid — the resolver just proceeds without ordered
  // defaults, exactly as it does when no default is configured). A legacy
  // `defaultSourceId` becomes a one-entry order when the array is absent.
  if (Array.isArray(input.defaultSourceIds)) {
    const rawIds = input.defaultSourceIds;
    if (rawIds.length <= 3 && rawIds.every((id) => typeof id === 'string' && uuidPattern.test(id)) && new Set(rawIds).size === rawIds.length) {
      request.defaultSourceIds = rawIds as string[];
    }
  }
  if (!request.defaultSourceIds && request.defaultSourceId) {
    request.defaultSourceIds = [request.defaultSourceId];
  }
  // Phase 7F (MegaPlay): optional playback variant. Lowercased, length-bounded
  // (e.g. 'sub' or 'dub'). Adapters that do not support variants ignore it.
  if (typeof input.variant === 'string' && input.variant.length > 0 && input.variant.length <= 16 && /^[a-z0-9_-]+$/i.test(input.variant)) {
    request.variant = input.variant.toLowerCase();
  }
  return request;
}

function cleanExternalId(value: string | undefined): string | undefined {
  return value && /^[a-zA-Z0-9._:-]{1,120}$/.test(value) ? value : undefined;
}

export function normalizeContentIdentifiers(content: NormalizedMediaItem, request: ResolverRequest): ContentIdentifiers {
  const externalIds = content.externalIds ?? {};
  const sourceExternalId = cleanExternalId(content.source.externalId);
  const ids: ContentIdentifiers = {
    internalId: content.id,
    slug: request.contentId,
    tmdbId: cleanExternalId(externalIds.tmdb) ?? (content.source.provider === 'tmdb' ? sourceExternalId : undefined),
    imdbId: cleanExternalId(externalIds.imdb),
    anilistId: cleanExternalId(externalIds.anilist),
    malId: cleanExternalId(externalIds.mal),
  };
  return ids;
}

export function identifierForMode(ids: ContentIdentifiers, mode: string): string | undefined {
  switch (mode) {
    case 'tmdb_id': return ids.tmdbId;
    case 'imdb_id': return ids.imdbId;
    case 'anilist_id': return ids.anilistId;
    case 'mal_id': return ids.malId;
    case 'slug': return ids.slug;
    case 'custom': return ids.internalId;
    default: return undefined;
  }
}

export function validateEpisodeScope(mediaType: ResolverMediaType, season?: number, episode?: number): void {
  if (mediaType === 'movie' && (season !== undefined || episode !== undefined)) throw new ResolverError('INVALID_REQUEST');
  if ((season === undefined) !== (episode === undefined)) throw new ResolverError('INVALID_REQUEST');
}
