import { ResolverError } from './errors';
import { resolveTemplate, templateForContext } from './template';
import { validatePlaybackUrl } from './safe-url';
import type { AdapterResult, ProviderAdapter, ResolverContext } from './types';

export const VIDSRC_ADAPTER_ID = 'vidsrc-embed';
export const VIDSRC_ORIGIN = 'https://vidsrc.wiki';

function assertVidsrcEmbedUrl(rawUrl: string, mediaType: ResolverContext['request']['mediaType']): string {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new ResolverError('INVALID_PROVIDER_ENDPOINT');
  }
  if (url.origin.toLowerCase() !== VIDSRC_ORIGIN) throw new ResolverError('INVALID_PROVIDER_ENDPOINT');
  const path = url.pathname.replace(/\/+$/, '');
  const expectedPrefix = mediaType === 'movie' ? '/embed/movie/' : mediaType === 'series' ? '/embed/tv/' : '';
  if (!expectedPrefix || !path.startsWith(expectedPrefix) || path.includes('..')) throw new ResolverError('INVALID_PROVIDER_ENDPOINT');
  return url.toString();
}

export const vidsrcProviderAdapter: ProviderAdapter = {
  integrationType: 'embed',
  adapterId: VIDSRC_ADAPTER_ID,
  async resolve(context): Promise<AdapterResult> {
    if (context.request.mediaType === 'anime') throw new ResolverError('UNSUPPORTED_MEDIA_TYPE');
    if (!context.identifiers.tmdbId) throw new ResolverError('MISSING_IDENTIFIER');
    const configuredTemplate = templateForContext(context);
    const expectedTemplate = context.request.mediaType === 'movie'
      ? `${VIDSRC_ORIGIN}/embed/movie/{tmdb_id}/`
      : `${VIDSRC_ORIGIN}/embed/tv/{tmdb_id}/{season}/{episode}/`;
    if (configuredTemplate !== expectedTemplate) throw new ResolverError('INVALID_TEMPLATE');
    const resolved = resolveTemplate(configuredTemplate, context);
    const safeUrl = validatePlaybackUrl(assertVidsrcEmbedUrl(resolved, context.request.mediaType), 'embed', [VIDSRC_ORIGIN]);
    return {
      type: 'embed',
      url: safeUrl,
      metadata: {
        providerName: context.config.provider.name,
        sourceName: context.config.source.name,
        note: 'Experimental Vidsrc embed. Provider-controlled player behavior, navigation, and advertising remain outside MAVERO control.'
      }
    };
  }
};
