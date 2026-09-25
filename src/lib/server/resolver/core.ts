import { createDefaultAdapterIds, createDefaultAdapters } from './adapters';
import { ResolverError, asResolverError } from './errors';
import { normalizeContentIdentifiers } from './identifiers';
import { allowedEmbedOriginsFromCapabilities, allowDynamicEmbedOriginsFromCapabilities, isValidExpiry, validatePlaybackUrl } from './safe-url';
import type { ContentType, NormalizedMediaItem } from '$lib/server/content/types';
import type { ProviderAdapter, ResolverDependencies, ResolverRequest, SourceResult, TrustedResolutionConfig } from './types';
import { sandboxPolicyFromCapabilities, resolveSandboxRuntime } from '$lib/shared/sandbox-policy';
import type { IntegrationType } from '$lib/server/streaming/types';
import { createEmbedToken } from '$lib/server/embed-gateway/token';

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

function resultFromAdapter(result: Awaited<ReturnType<ProviderAdapter['resolve']>>, context: Parameters<ProviderAdapter['resolve']>[0], embedSecret: string): SourceResult {
  if (!result || (result.type !== 'direct' && result.type !== 'embed') || typeof result.url !== 'string') throw new ResolverError('PROVIDER_RESPONSE_INVALID');
  if (result.expiresAt && !isValidExpiry(result.expiresAt)) throw new ResolverError('SOURCE_EXPIRED');
  // Phase 8: effective embed origins = union(provider, source).
  // Provider values are authoritative; source values are backward-compatible fallback.
  const providerCaps = context.config.provider.capabilities;
  const sourceCaps = context.config.source.capabilities;
  const providerOrigins = allowedEmbedOriginsFromCapabilities(providerCaps);
  const sourceOrigins = allowedEmbedOriginsFromCapabilities(sourceCaps);
  const effectiveOrigins = [...new Set([...providerOrigins, ...sourceOrigins])];
  const allowDynamic = allowDynamicEmbedOriginsFromCapabilities(providerCaps) || allowDynamicEmbedOriginsFromCapabilities(sourceCaps);
  const url = validatePlaybackUrl(result.url, result.type, effectiveOrigins, allowDynamic);

  // Embed Gateway: for embed sources, wrap the provider URL into a
  // Mavero-owned opaque gateway URL. The provider URL is AES-256-GCM
  // encrypted inside the token — the browser cannot decrypt it. The
  // iframe's `src` attribute in the DOM becomes
  // `/api/embed/session/<encrypted-token>` — NOT the provider URL.
  //
  // The gateway endpoint decrypts the token server-side and returns an
  // HTML page with a JavaScript redirect to the provider URL. This
  // preserves the provider's origin for postMessage (the iframe
  // navigates to the provider origin, not Mavero).
  //
  // For direct sources, the URL is returned unchanged (no gateway).
  // If the token creation fails (missing secret), the resolver falls
  // back to the raw URL — playback still works, just without URL hiding.
  let gatewayUrl = url;
  let providerOrigin: string | undefined;
  if (result.type === 'embed') {
    try {
      providerOrigin = new URL(url).origin;
    } catch {
      providerOrigin = undefined;
    }
    const token = createEmbedToken({
      url,
      origin: providerOrigin ?? '',
      sourceId: context.config.source.id,
      providerId: context.config.provider.id,
      contentId: context.request.contentId,
      mediaType: context.request.mediaType,
      season: context.request.season,
      episode: context.request.episode,
    }, embedSecret);
    if (token) {
      gatewayUrl = `/api/embed/session/${token}`;
    }
    // If token creation fails (no secret configured), gatewayUrl stays
    // as the raw URL — playback still works, just without URL hiding.
  }

  return {
    type: result.type,
    url: gatewayUrl,
    providerId: context.config.provider.id,
    sourceId: context.config.source.id,
    mediaType: context.request.mediaType,
    subtitles: result.subtitles,
    qualities: result.qualities,
    headers: result.headers,
    expiresAt: result.expiresAt,
    sandboxPolicy: sandboxPolicyFromCapabilities(context.config.provider.capabilities, context.config.source.capabilities),
    sandboxRuntime: resolveSandboxRuntime(context.config.provider.capabilities, context.config.source.capabilities),
    metadata: {
      ...result.metadata,
      sourceName: context.config.source.name,
      providerName: context.config.provider.name,
      // Embed Gateway: pass the provider origin to the client for
      // adapter selection. This is NOT the full provider URL — just
      // the origin (e.g. `https://vidlink.pro`), which is already
      // hardcoded in each adapter. No new information is leaked.
      ...(providerOrigin ? { providerOrigin } : {}),
    },
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
    // Embed Gateway: resolve the signing secret. Use the injected value
    // if provided, or lazily load from the env module. The lazy import
    // avoids breaking tsx test scripts (which can't resolve
    // `$env/dynamic/private`). In the SvelteKit runtime, the dynamic
    // import succeeds. In tsx tests, it fails → empty secret → no
    // gateway URL → resolver returns the raw provider URL (tests unchanged).
    let embedSecret = dependencies.embedGatewaySecret ?? '';
    if (!embedSecret) {
      try {
        const envModule = await import('$lib/server/embed-gateway/env');
        embedSecret = envModule.embedGatewaySecret();
      } catch {
        embedSecret = '';
      }
    }
    return resultFromAdapter(adapterResult, context, embedSecret);
  } catch (error) {
    const resolverError = asResolverError(error);
    if (resolverError.code === 'INTERNAL_RESOLUTION_ERROR') console.error('[Resolver] adapter failure', { code: resolverError.code, providerId: config.provider.id, sourceId: config.source.id });
    throw resolverError;
  }
}
