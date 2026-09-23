import { ResolverError } from './errors';
import { resolveTemplate, templateForContext } from './template';
import { validatePlaybackUrl, allowedEmbedOriginsFromCapabilities, allowDynamicEmbedOriginsFromCapabilities, protocolForUrl } from './safe-url';
import type { AdapterResult, ProviderAdapter, ResolverContext } from './types';
import type { IntegrationType } from '$lib/server/streaming/types';
import { vidsrcProviderAdapter } from './vidsrc';
import { vidlinkProviderAdapter } from './vidlink';
import type { Json } from '$lib/server/supabase/database.types';

function resultTypeFromCapabilities(context: ResolverContext): 'direct' | 'embed' {
  const sourceCapabilities = context.config.source.capabilities;
  const providerCapabilities = context.config.provider.capabilities;
  const sourceType = sourceCapabilities && typeof sourceCapabilities === 'object' && !Array.isArray(sourceCapabilities) ? sourceCapabilities.result_type : undefined;
  const providerType = providerCapabilities && typeof providerCapabilities === 'object' && !Array.isArray(providerCapabilities) ? providerCapabilities.result_type : undefined;
  return sourceType === 'direct' || providerType === 'direct' ? 'direct' : 'embed';
}

/**
 * Phase 8: effective embed origins = union(provider.allowed_embed_origins,
 * source.allowed_embed_origins). Provider values are authoritative;
 * source values are a backward-compatible fallback. Duplicates removed.
 */
function effectiveEmbedOrigins(providerCapabilities: Json, sourceCapabilities: Json): string[] {
  const providerOrigins = allowedEmbedOriginsFromCapabilities(providerCapabilities);
  const sourceOrigins = allowedEmbedOriginsFromCapabilities(sourceCapabilities);
  return [...new Set([...providerOrigins, ...sourceOrigins])];
}

/**
 * Phase 8: dynamic origins are allowed if EITHER provider or source
 * explicitly opts in.
 */
function effectiveAllowDynamic(providerCapabilities: Json, sourceCapabilities: Json): boolean {
  return allowDynamicEmbedOriginsFromCapabilities(providerCapabilities) || allowDynamicEmbedOriginsFromCapabilities(sourceCapabilities);
}

function templateResult(context: ResolverContext, resultType: 'direct' | 'embed'): AdapterResult {
  const url = resolveTemplate(templateForContext(context), context);
  const providerCaps = context.config.provider.capabilities as Json;
  const sourceCaps = context.config.source.capabilities as Json;
  const safeUrl = validatePlaybackUrl(
    url,
    resultType,
    effectiveEmbedOrigins(providerCaps, sourceCaps),
    effectiveAllowDynamic(providerCaps, sourceCaps)
  );
  return {
    type: resultType,
    url: safeUrl,
    protocol: resultType === 'direct' ? protocolForUrl(safeUrl) : undefined,
    metadata: { sourceName: context.config.source.name, providerName: context.config.provider.name, protocol: resultType === 'direct' ? protocolForUrl(safeUrl) : undefined },
  };
}

export const templateProviderAdapter: ProviderAdapter = {
  integrationType: 'template',
  async resolve(context) {
    return templateResult(context, resultTypeFromCapabilities(context));
  },
};

export const directProviderAdapter: ProviderAdapter = {
  integrationType: 'direct',
  async resolve(context) {
    return templateResult(context, 'direct');
  },
};

export const embedProviderAdapter: ProviderAdapter = {
  integrationType: 'embed',
  async resolve(context) {
    return templateResult(context, 'embed');
  },
};

export const apiProviderAdapter: ProviderAdapter = {
  integrationType: 'api',
  async resolve() {
    return null;
  },
};

export const customProviderAdapter: ProviderAdapter = {
  integrationType: 'custom',
  async resolve() {
    return null;
  },
};

export function createDefaultAdapters(): Record<IntegrationType, ProviderAdapter> {
  return { template: templateProviderAdapter, direct: directProviderAdapter, embed: embedProviderAdapter, api: apiProviderAdapter, custom: customProviderAdapter };
}

export function createDefaultAdapterIds(): Record<string, ProviderAdapter> {
  // Yenime was removed (anime-only MAL-embed provider is no longer
  // supported). Only VidSrc and VidLink adapter IDs remain registered.
  return {
    [vidsrcProviderAdapter.adapterId ?? 'vidsrc-embed']: vidsrcProviderAdapter,
    [vidlinkProviderAdapter.adapterId ?? 'vidlink-embed']: vidlinkProviderAdapter
  };
}

export function createMockAdapter(integrationType: IntegrationType, result: AdapterResult | null | (() => AdapterResult | null)): ProviderAdapter {
  return {
    integrationType,
    async resolve() {
      const value = typeof result === 'function' ? result() : result;
      if (value && (value.type !== 'direct' && value.type !== 'embed')) throw new ResolverError('PROVIDER_RESPONSE_INVALID');
      return value;
    },
  };
}

