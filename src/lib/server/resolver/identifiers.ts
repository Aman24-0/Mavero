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

  const season = positiveInteger(input.season, 'season');
  const episode = positiveInteger(input.episode, 'episode');
  if (input.mediaType === 'movie' && (season !== undefined || episode !== undefined)) throw new ResolverError('INVALID_REQUEST');
  if ((season === undefined) !== (episode === undefined)) throw new ResolverError('INVALID_REQUEST');

  const request: ResolverRequest = { sourceId: input.sourceId, contentId: input.contentId, mediaType: input.mediaType };
  if (season !== undefined) request.season = season;
  if (episode !== undefined) request.episode = episode;
  const fallbackFlag = typeof input.enableFallback === 'boolean' ? input.enableFallback : input.allowFallback;
  if (typeof fallbackFlag === 'boolean') request.allowFallback = fallbackFlag;
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
    anilistId: cleanExternalId(externalIds.anilist) ?? (content.source.provider === 'anilist' ? sourceExternalId : undefined),
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
