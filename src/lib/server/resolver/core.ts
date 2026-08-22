import { createDefaultAdapterIds, createDefaultAdapters } from './adapters';
import { ResolverError, asResolverError } from './errors';
import { normalizeContentIdentifiers } from './identifiers';
import { allowedEmbedOriginsFromCapabilities, isValidExpiry, validatePlaybackUrl } from './safe-url';
import type { ContentType, NormalizedMediaItem } from '$lib/server/content/types';
import type { ProviderAdapter, ResolverDependencies, ResolverRequest, SourceResult, TrustedResolutionConfig } from './types';
import { sandboxPolicyFromCapabilities } from '$lib/shared/sandbox-policy';
import type { IntegrationType } from '$lib/server/streaming/types';

const activeProviderStatuses = new Set(['active']);
const activeSourceStatuses = new Set(['active']);

function capabilityAllows(config: TrustedResolutionConfig, mediaType: ContentType): boolean {
  const sourceCapabilities = config.source.capabilities;
  const providerCapabilities = config.provider.capabilities;
  const sourceValue = sourceCapabilities && typeof sourceCapabilities === 'object' && !Array.isArray(sourceCapabilities) ? sourceCapabilities[mediaType] : undefined;
  const providerValue = providerCapabilities && typeof providerCapabilities === 'object' && !Array.isArray(providerCapabilities) ? providerCapabilities[mediaType] : undefined;
  return sourceValue !== false && providerValue !== false;
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
  const url = validatePlaybackUrl(result.url, result.type, allowedEmbedOriginsFromCapabilities(context.config.source.capabilities));
  return {
    type: result.type,
    url,
    providerId: context.config.provider.id,
    sourceId: context.config.source.id,
    mediaType: context.request.mediaType,
    subtitles: result.subtitles,
    qualities: result.qualities,
    audioTracks: result.audioTracks,
    headers: result.headers,
    expiresAt: result.expiresAt,
    sandboxPolicy: sandboxPolicyFromCapabilities(context.config.provider.capabilities, context.config.source.capabilities),
    metadata: { ...result.metadata, protocol: result.metadata?.protocol ?? result.protocol, sourceName: context.config.source.name, providerName: context.config.provider.name },
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
  if (!capabilityAllows(config, request.mediaType)) throw new ResolverError('UNSUPPORTED_MEDIA_TYPE');
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
    if (resolverError.code === 'INTERNAL_RESOLUTION_ERROR') console.error('[Resolver] adapter failure', resolverError.cause);
    throw resolverError;
  }
}
