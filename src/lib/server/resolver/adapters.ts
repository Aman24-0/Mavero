import { ResolverError } from './errors';
import { resolveTemplate, templateForContext } from './template';
import { validatePlaybackUrl, allowedEmbedOriginsFromCapabilities, allowDynamicEmbedOriginsFromCapabilities, protocolForUrl } from './safe-url';
import type { AdapterResult, ProviderAdapter, ResolverContext } from './types';
import type { IntegrationType } from '$lib/server/streaming/types';
import { vidsrcProviderAdapter } from './vidsrc';
import { vidlinkProviderAdapter } from './vidlink';
import { createMaveroHostedAdapter, MAVERO_HOSTED_ADAPTER_ID_VIDARA, MAVERO_HOSTED_ADAPTER_ID_ABYSS } from './mavero-hosted';
import { blueVelvetProviderAdapter, BLUEVELVET_ADAPTER_ID } from './bluevelvet';
import { vixolityProviderAdapter, VIXOLITY_ADAPTER_ID } from './vixolity';
import { vidsrcScrapeProviderAdapter, VIDSRC_SCRAPE_ADAPTER_ID } from './vidsrc-scrape';
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
  //
  // Phase 7: Mavero-hosted adapters for Vidara ('vidara') and Abyss
  // ('abyss') are registered here. The adapter_id values match the
  // `streaming_providers.adapter_id` column set by Phase 4 migration
  // 20260928213822. The resolver's `adapterFor(config)` function in
  // core.ts dispatches to this map — adding the entries here is the
  // SINGLE integration point. The adapters query `media_assets` for
  // ready assets matching the canonical_key + provider_source_id and
  // return the provider's playback_url as an embed URL (provider-hosted
  // player, NOT a raw direct stream).
  return {
    [vidsrcProviderAdapter.adapterId ?? 'vidsrc-embed']: vidsrcProviderAdapter,
    [vidlinkProviderAdapter.adapterId ?? 'vidlink-embed']: vidlinkProviderAdapter,
    [MAVERO_HOSTED_ADAPTER_ID_VIDARA]: createMaveroHostedAdapter(MAVERO_HOSTED_ADAPTER_ID_VIDARA),
    [MAVERO_HOSTED_ADAPTER_ID_ABYSS]: createMaveroHostedAdapter(MAVERO_HOSTED_ADAPTER_ID_ABYSS),
    // Blue Velvet (2026-10): API-resolved direct HLS source. Registered
    // under the same adapter_id the provider migration sets on
    // streaming_providers.adapter_id — the resolver's adapterFor(config)
    // dispatches here. The source is seeded DISABLED until upstream CORS
    // allowlisting is verified (see bluevelvet.ts module doc).
    [BLUEVELVET_ADAPTER_ID]: blueVelvetProviderAdapter,
    // Vixolity (2026-10): IMDb-keyed direct HLS source. Registered under
    // the same adapter_id the provider migration sets on
    // streaming_providers.adapter_id — the resolver's adapterFor(config)
    // dispatches here. The source is seeded DISABLED until end-to-end
    // browser playback is verified (see vixolity.ts module doc).
    [VIXOLITY_ADAPTER_ID]: vixolityProviderAdapter,
    // DirectStream (2026-10 round 13): vidsrc scraper — extracts the real
    // .m3u8 from vidsrc's 3-hop embed chain and returns it as a direct HLS
    // source proxied through the Cloudflare Worker (the Worker adds the
    // required Referer server-side — the browser cannot set Referer). The
    // embed + CDN domains are config-driven (app_config) and editable at
    // /admin/system/direct-stream. Seeded DISABLED + experimental — the
    // admin enables it from the DirectStream page after verifying the
    // scraper domains.
    [VIDSRC_SCRAPE_ADAPTER_ID]: vidsrcScrapeProviderAdapter,
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

