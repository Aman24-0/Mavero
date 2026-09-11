import { createDefaultAdapterIds, createDefaultAdapters } from './adapters';
import { ResolverError, asResolverError } from './errors';
import { normalizeContentIdentifiers } from './identifiers';
import { allowedEmbedOriginsFromCapabilities, allowDynamicEmbedOriginsFromCapabilities, isValidExpiry, validatePlaybackUrl } from './safe-url';
import type { ContentType, NormalizedMediaItem } from '$lib/server/content/types';
import type { ProviderAdapter, ResolverDependencies, ResolverRequest, SourceResult, TrustedResolutionConfig } from './types';
import { sandboxPolicyFromCapabilities, resolveSandboxRuntime } from '$lib/shared/sandbox-policy';
import type { IntegrationType } from '$lib/server/streaming/types';

const activeProviderStatuses = new Set(['active']);
const activeSourceStatuses = new Set(['active']);

function capabilityAllows(config: TrustedResolutionConfig, mediaType: ContentType): boolean {
  // Anime is no longer a separate playback path — anime content (TMDB TV
  // series flagged as anime via genre 16 + 'ja') now flows through the
  // normal movie/series pipeline. The resolver request's `mediaType` is
  // always one of 'movie' | 'series' (anime-only content URLs are no
  // longer produced by the UI). A provider is eligible when its
  // capabilities JSON does not explicitly set `mediaType` to `false`.
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
    // Phase 11 (GOAL D): the full configured-vs-effective provenance. The
    // runtime (PlayerShell/PlayerViewport) applies ONLY
    // `effectiveSandboxPolicy` — a provider-level "unrestricted" now
    // reaches the iframe even when the admin console is read at the
    // provider level — while `configured`/`provider` keep the audit trail
    // (null = inherit) for admin surfaces and tests.
    sandboxRuntime: resolveSandboxRuntime(context.config.provider.capabilities, context.config.source.capabilities),
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
  // Strict capability + identity check: the resolver request's mediaType
  // must match the loaded content's type AND the provider must declare
  // that mediaType as supported. Anime no longer bypasses this check —
  // anime content has type='series' (or 'movie' for anime movies) and is
  // resolved via the normal movie/series provider pipeline.
  if (content.type !== request.mediaType) throw new ResolverError('INVALID_REQUEST');
  if (!capabilityAllows(config, request.mediaType)) throw new ResolverError('UNSUPPORTED_MEDIA_TYPE');

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
