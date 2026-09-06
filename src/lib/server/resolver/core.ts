import { createDefaultAdapterIds, createDefaultAdapters } from './adapters';
import { ResolverError, asResolverError } from './errors';
import { normalizeContentIdentifiers } from './identifiers';
import { allowedEmbedOriginsFromCapabilities, allowDynamicEmbedOriginsFromCapabilities, isValidExpiry, validatePlaybackUrl } from './safe-url';
import { getCanonicalPlaybackMediaType, isAnimeWithFormat } from './anime-routing';
import type { ContentType, NormalizedMediaItem } from '$lib/server/content/types';
import type { ProviderAdapter, ResolverDependencies, ResolverRequest, SourceResult, TrustedResolutionConfig } from './types';
import { sandboxPolicyFromCapabilities } from '$lib/shared/sandbox-policy';
import type { IntegrationType } from '$lib/server/streaming/types';

const activeProviderStatuses = new Set(['active']);
const activeSourceStatuses = new Set(['active']);

function capabilityAllows(config: TrustedResolutionConfig, mediaType: ContentType, content: NormalizedMediaItem): boolean {
  // Phase 7F+ v2: a provider is eligible when EITHER:
  //   1. CANONICAL MATCH — the provider declares `mediaType` as supported.
  //   2. ANIME BRIDGE — content is anime-flagged AND the provider declares
  //      `anime:true`. This lets anime-only providers (Yenime) accept
  //      anime content regardless of the canonical type.
  //
  // The canonical mediaType is derived from content.type + animeFormat:
  //   - TMDB movie → 'movie'
  //   - TMDB series → 'series'
  //   - AniList anime (animeFormat=movie) → 'movie'
  //   - AniList anime (animeFormat=series or undefined) → 'series'
  //
  // This means a normal movie provider (VidSrc with movie:true) is eligible
  // for an AniList-native anime movie (type='anime', animeFormat='movie')
  // because the canonical mediaType is 'movie'. The anime-bridge additionally
  // lets Yenime (anime:true only) be eligible for the same content.
  const sourceCapabilities = config.source.capabilities;
  const providerCapabilities = config.provider.capabilities;
  const sourceValue = sourceCapabilities && typeof sourceCapabilities === 'object' && !Array.isArray(sourceCapabilities) ? sourceCapabilities[mediaType] : undefined;
  const providerValue = providerCapabilities && typeof providerCapabilities === 'object' && !Array.isArray(providerCapabilities) ? providerCapabilities[mediaType] : undefined;
  if (sourceValue !== false && providerValue !== false) return true;
  if (content.isAnime === true) {
    const sourceAnimeValue = sourceCapabilities && typeof sourceCapabilities === 'object' && !Array.isArray(sourceCapabilities) ? sourceCapabilities.anime : undefined;
    const providerAnimeValue = providerCapabilities && typeof providerCapabilities === 'object' && !Array.isArray(providerCapabilities) ? providerCapabilities.anime : undefined;
    if (sourceAnimeValue !== false && providerAnimeValue !== false) return true;
  }
  return false;
}

function experimentalPlaybackAllowed(config: TrustedResolutionConfig): boolean {
  const sourceCapabilities = config.source.capabilities;
  const providerCapabilities = config.provider.capabilities;
  const sourceValue = sourceCapabilities && typeof sourceCapabilities === 'object' && !Array.isArray(sourceCapabilities) ? sourceCapabilities.allow_experimental_playback : undefined;
  const providerValue = providerCapabilities && typeof providerCapabilities === 'object' && !Array.isArray(providerCapabilities) ? providerCapabilities.allow_experimental_playback : undefined;
  return sourceValue === true || providerValue === true;
}

function providerStatusAllowsPlayback(config: TrustedResolutionConfig): boolean {
  return activeProviderStatuses.has(config.provider.status)
    || (config.provider.status === 'experimental' && experimentalPlaybackAllowed(config));
}

function adapterFor(config: TrustedResolutionConfig, dependencies: ResolverDependencies): ProviderAdapter | undefined {
  const type = (config.source.integration_type ?? config.provider.integration_type) as IntegrationType;
  const adapterId = config.provider.adapter_id;
  return (adapterId ? dependencies.adaptersById?.[adapterId] ?? createDefaultAdapterIds()[adapterId] : undefined)
    ?? dependencies.adapters?.[type]
    ?? createDefaultAdapters()[type];
}

function resultFromAdapter(result: Awaited<ReturnType<ProviderAdapter['resolve']>>, context: Parameters<ProviderAdapter['resolve']>[0]): SourceResult {
  if (!result || (result.type !== 'direct' && result.type !== 'embed') || typeof result.url !== 'string') throw new ResolverError('PROVIDER_RESPONSE_INVALID');
  if (result.expiresAt && !isValidExpiry(result.expiresAt)) throw new ResolverError('SOURCE_EXPIRED');
  const sourceCapabilities = context.config.source.capabilities;
  const allowDynamic = allowDynamicEmbedOriginsFromCapabilities(sourceCapabilities);
  const url = validatePlaybackUrl(result.url, result.type, allowedEmbedOriginsFromCapabilities(sourceCapabilities), allowDynamic);
  return {
    type: result.type,
    url,
    providerId: context.config.provider.id,
    sourceId: context.config.source.id,
    mediaType: context.request.mediaType,
    subtitles: result.subtitles,
    qualities: result.qualities,
    headers: result.headers,
    expiresAt: result.expiresAt,
    sandboxPolicy: sandboxPolicyFromCapabilities(context.config.provider.capabilities, context.config.source.capabilities),
    metadata: { ...result.metadata, sourceName: context.config.source.name, providerName: context.config.provider.name },
  };
}

export async function resolveSourceFromConfig(request: ResolverRequest, config: TrustedResolutionConfig, content: NormalizedMediaItem, dependencies: ResolverDependencies = {}): Promise<SourceResult> {
  if (!config.provider) throw new ResolverError('PROVIDER_NOT_FOUND');
  if (!config.source) throw new ResolverError('SOURCE_NOT_FOUND');
  if (config.source.provider_id !== config.provider.id) throw new ResolverError('PROVIDER_RESPONSE_INVALID');
  if (!config.provider.enabled) throw new ResolverError('PROVIDER_DISABLED');
  if (!providerStatusAllowsPlayback(config)) throw new ResolverError('PROVIDER_DISABLED');
  if (!config.source.enabled) throw new ResolverError('SOURCE_DISABLED');
  if (config.source.visibility !== 'public') throw new ResolverError('SOURCE_DISABLED');
  if (!activeSourceStatuses.has(config.source.status) && !experimentalPlaybackAllowed(config)) throw new ResolverError('SOURCE_MAINTENANCE');
  // Phase 7F+ v2: derive the canonical playback mediaType from content.type +
  // animeFormat. For AniList-native anime (type='anime'), this maps:
  //   animeFormat='movie' → 'movie'
  //   animeFormat='series' → 'series'
  // This lets normal providers (VidSrc/VidLink with movie:true/series:true)
  // be eligible for anime content. The anime-bridge in capabilityAllows
  // additionally lets anime-only providers (Yenime with anime:true) be eligible.
  const canonicalMediaType = getCanonicalPlaybackMediaType(content);
  if (!capabilityAllows(config, canonicalMediaType, content)) throw new ResolverError('UNSUPPORTED_MEDIA_TYPE');
  // Phase 7F+ v2: the strict `content.type !== request.mediaType` check is
  // relaxed for anime. The resolver accepts:
  //   1. request.mediaType matches the canonical playback type (movie/series
  //      derived from content.type + animeFormat).
  //   2. request.mediaType is 'anime' AND content.type is 'anime' (the
  //      AniList-native /anime/ route path — legacy compatibility).
  //   3. content.isAnime === true AND the canonical type matches
  //      (the anime-bridge path — TMDB-tagged anime with mediaType=movie/series).
  if (request.mediaType !== canonicalMediaType
    && !(request.mediaType === 'anime' && content.type === 'anime')
    && !isAnimeWithFormat(content, canonicalMediaType)) throw new ResolverError('INVALID_REQUEST');

  const context = { request, content, identifiers: normalizeContentIdentifiers(content, request), config };
  const adapter = adapterFor(config, dependencies);
  if (!adapter) throw new ResolverError('RESOLUTION_UNAVAILABLE');

  try {
    const adapterResult = await adapter.resolve(context);
    if (!adapterResult) return { type: 'unavailable', url: null, providerId: config.provider.id, sourceId: config.source.id, mediaType: request.mediaType, error: new ResolverError('RESOLUTION_UNAVAILABLE').toShape() };
    return resultFromAdapter(adapterResult, context);
  } catch (error) {
    const resolverError = asResolverError(error);
    if (resolverError.code === 'INTERNAL_RESOLUTION_ERROR') console.error('[Resolver] adapter failure', { code: resolverError.code, providerId: config.provider.id, sourceId: config.source.id });
    throw resolverError;
  }
}
