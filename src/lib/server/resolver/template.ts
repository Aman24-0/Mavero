import { ResolverError } from './errors';
import { identifierForMode } from './identifiers';
import type { ResolverContext } from './types';

const allowedPlaceholders = new Set(['tmdb_id', 'imdb_id', 'anilist_id', 'mal_id', 'season', 'episode', 'content_id', 'slug']);

function valueForPlaceholder(key: string, context: ResolverContext): string | undefined {
  switch (key) {
    case 'season': return context.request.season?.toString();
    case 'episode': return context.request.episode?.toString();
    case 'tmdb_id': return context.identifiers.tmdbId;
    case 'imdb_id': return context.identifiers.imdbId;
    case 'anilist_id': return context.identifiers.anilistId;
    case 'mal_id': return context.identifiers.malId;
    case 'content_id': return context.identifiers.internalId;
    case 'slug': return context.identifiers.slug;
    default: return undefined;
  }
}

export function resolveTemplate(template: string | null | undefined, context: ResolverContext): string {
  if (!template || template.trim().length === 0 || /[\r\n]/.test(template)) throw new ResolverError('INVALID_TEMPLATE');
  return template.replace(/\{([^{}]+)\}/g, (whole, key: string) => {
    if (!allowedPlaceholders.has(key)) throw new ResolverError('INVALID_TEMPLATE');
    const value = valueForPlaceholder(key, context);
    if (!value) throw new ResolverError('MISSING_IDENTIFIER');
    return encodeURIComponent(value);
  });
}

export function templateForContext(context: ResolverContext): string | null {
  // Phase 7F+ v2: the resolver request's `mediaType` is the CANONICAL
  // playback type (derived from content.type + animeFormat by the watch
  // route). For AniList-native anime (type='anime'), mediaType is
  // 'movie' (animeFormat='movie') or 'series' (animeFormat='series').
  // For TMDB-tagged anime, mediaType is the TMDB type ('movie'/'series').
  //
  // This means normal providers (VidSrc/VidLink with `movie:true` or
  // `series:true`) use their canonical movie_template/series_template
  // even for anime-flagged content — the URL uses the TMDB ID. The
  // anime_template is only reached when the request's mediaType is
  // 'anime' (the legacy /anime/ route path).
  //
  // Anime-only providers (Yenime with `anime:true`) bypass this function
  // entirely — the Yenime adapter uses `anime_template` directly because
  // Yenime's identifier contract is MAL ID (not TMDB ID).
  if (context.request.mediaType === 'movie') return context.config.source.movie_template;
  if (context.request.mediaType === 'series') return context.config.source.series_template;
  return context.config.source.anime_template;
}

export function requiresConfiguredIdentifier(context: ResolverContext): boolean {
  return Boolean(identifierForMode(context.identifiers, context.config.source.identifier_mode));
}
