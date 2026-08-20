import { ResolverError } from './errors';
import { resolveTemplate, templateForContext } from './template';
import { validatePlaybackUrl, allowedEmbedOriginsFromCapabilities, protocolForUrl } from './safe-url';
import type { AdapterResult, ProviderAdapter, ResolverContext } from './types';
import type { IntegrationType } from '$lib/server/streaming/types';
import { vidsrcProviderAdapter } from './vidsrc';

function resultTypeFromCapabilities(context: ResolverContext): 'direct' | 'embed' {
  const sourceCapabilities = context.config.source.capabilities;
  const providerCapabilities = context.config.provider.capabilities;
  const sourceType = sourceCapabilities && typeof sourceCapabilities === 'object' && !Array.isArray(sourceCapabilities) ? sourceCapabilities.result_type : undefined;
  const providerType = providerCapabilities && typeof providerCapabilities === 'object' && !Array.isArray(providerCapabilities) ? providerCapabilities.result_type : undefined;
  return sourceType === 'direct' || providerType === 'direct' ? 'direct' : 'embed';
}

function templateResult(context: ResolverContext, resultType: 'direct' | 'embed'): AdapterResult {
  const url = resolveTemplate(templateForContext(context), context);
  const safeUrl = validatePlaybackUrl(url, resultType, allowedEmbedOriginsFromCapabilities(context.config.source.capabilities));
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
  return { [vidsrcProviderAdapter.adapterId ?? 'vidsrc-embed']: vidsrcProviderAdapter };
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
