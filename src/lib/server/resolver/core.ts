import { createDefaultAdapterIds, createDefaultAdapters } from './adapters';
import { ResolverError, asResolverError } from './errors';
import { normalizeContentIdentifiers } from './identifiers';
import { allowedEmbedOriginsFromCapabilities, allowDynamicEmbedOriginsFromCapabilities, isValidExpiry, validatePlaybackUrl } from './safe-url';
import type { ContentType, NormalizedMediaItem } from '$lib/server/content/types';
import type { ProviderAdapter, ResolverDependencies, ResolverRequest, SourceResult, TrustedResolutionConfig } from './types';
import { sandboxPolicyFromCapabilities } from '$lib/shared/sandbox-policy';
import type { IntegrationType } from '$lib/server/streaming/types';

const activeProviderStatuses = new Set(['active']);
const activeSourceStatuses = new Set(['active']);

function capabilityAllows(config: TrustedResolutionConfig, mediaType: ContentType, content: NormalizedMediaItem): boolean {
  // Phase 7F+ (anime routing): accept the provider when EITHER:
  //   1. CANONICAL MATCH — the provider declares `mediaType` as supported.
  //      (Legacy behavior — e.g. VidSrc with `movie:true` for a movie request.)
  //   2. ANIME BRIDGE — when the content is anime-flagged AND the provider
  //      declares `anime:true`. This lets MegaPlay/Yenime (which declare
  //      `movie:false, series:false, anime:true`) accept a Demon Slayer
  //      movie (`type:'movie', isAnime:true`) without forcing the canonical
  //      content type to be mutated to `'anime'`.
  //
  // The canonical `content.type` and `request.mediaType` stay as
  // `'movie'`/`'series'` for TMDB-tagged anime — progress keys, My List,
  // and the URL all keep their original identity.
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
  if (!capabilityAllows(config, request.mediaType, content)) throw new ResolverError('UNSUPPORTED_MEDIA_TYPE');
  // Phase 7F+ (anime routing): the strict `content.type !== request.mediaType`
  // check is preserved. The canonical content type stays as `'movie'` or
  // `'series'` for TMDB-tagged anime (e.g. Demon Slayer: Infinity Castle is
  // `type:'movie', isAnime:true`). The anime-bridge in `capabilityAllows`
  // lets anime-capable providers (MegaPlay/Yenime) be eligible WITHOUT
  // mutating the canonical type — so progress keys, My List, Continue
  // Watching, and the URL all keep their original `movie`/`series` identity.
  if (content.type !== request.mediaType) throw new ResolverError('INVALID_REQUEST');

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
