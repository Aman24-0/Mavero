import { ResolverError } from './errors';
import { resolveTemplate, templateForContext } from './template';
import { validatePlaybackUrl } from './safe-url';
import type { AdapterResult, ProviderAdapter, ResolverContext } from './types';

export const VIDLINK_ADAPTER_ID = 'vidlink-embed';
export const VIDLINK_ORIGIN = 'https://vidlink.pro';

function assertVidlinkEmbedUrl(rawUrl: string, mediaType: ResolverContext['request']['mediaType']): string {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new ResolverError('INVALID_PROVIDER_ENDPOINT');
  }

  if (url.origin.toLowerCase() !== VIDLINK_ORIGIN) throw new ResolverError('INVALID_PROVIDER_ENDPOINT');

  const path = url.pathname.replace(/\/+$/, '');
  const expectedPrefix = mediaType === 'movie' ? '/movie/' : mediaType === 'series' ? '/tv/' : '/anime/';
  if (!path.startsWith(expectedPrefix) || path.includes('..')) throw new ResolverError('INVALID_PROVIDER_ENDPOINT');

  return url.toString();
}

function expectedTemplate(mediaType: ResolverContext['request']['mediaType']): string {
  if (mediaType === 'movie') return `${VIDLINK_ORIGIN}/movie/{tmdb_id}`;
  if (mediaType === 'series') return `${VIDLINK_ORIGIN}/tv/{tmdb_id}/{season}/{episode}`;
  return `${VIDLINK_ORIGIN}/anime/{mal_id}/{episode}/sub`;
}

export const vidlinkProviderAdapter: ProviderAdapter = {
  integrationType: 'embed',
  adapterId: VIDLINK_ADAPTER_ID,
  async resolve(context): Promise<AdapterResult> {
    if (context.request.mediaType === 'anime' && !context.identifiers.malId) {
      throw new ResolverError('MISSING_IDENTIFIER');
    }

    if (context.request.mediaType !== 'anime' && !context.identifiers.tmdbId) {
      throw new ResolverError('MISSING_IDENTIFIER');
    }

    if (context.request.mediaType === 'anime' && !context.request.episode) {
      throw new ResolverError('MISSING_IDENTIFIER');
    }

    const configuredTemplate = templateForContext(context);
    if (configuredTemplate !== expectedTemplate(context.request.mediaType)) {
      throw new ResolverError('INVALID_TEMPLATE');
    }

    const resolved = resolveTemplate(configuredTemplate, context);
    const safeUrl = validatePlaybackUrl(
      assertVidlinkEmbedUrl(resolved, context.request.mediaType),
      'embed',
      [VIDLINK_ORIGIN]
    );

    return {
      type: 'embed',
      url: safeUrl,
      metadata: {
        providerName: context.config.provider.name,
        sourceName: context.config.source.name,
        note: 'Experimental VidLink embed. MAVERO does not use provider redirects, arbitrary API overrides, or provider-specific progress storage.'
      }
    };
  }
};
