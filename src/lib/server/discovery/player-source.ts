import type { PlayerSource } from '$lib/shared/player';
import type { ResolverMediaType } from '$lib/server/resolver/types';
import type { NormalizedStreamResult, PlayerCompatibleDiscoverySource } from './types';

export function toPlayerCompatibleSource(stream: NormalizedStreamResult, mediaType: ResolverMediaType, index = 0): PlayerCompatibleDiscoverySource {
  return {
    type: stream.type,
    url: stream.url,
    providerId: `universal:${stream.resolverId}`,
    sourceId: `universal:${stream.id}:${index}`,
    mediaType,
    subtitles: stream.subtitles,
    headers: stream.headers,
    metadata: {
      sourceName: stream.resolverId,
      providerName: 'MAVERO Universal Resolver',
      protocol: stream.protocol,
      note: `Discovered via ${stream.discoveryMethod}; confidence ${stream.confidence.toFixed(2)}${stream.quality !== 'unknown' ? `; quality ${stream.quality}p` : ''}`,
    },
  };
}

export function toPlayerSources(streams: NormalizedStreamResult[], mediaType: ResolverMediaType): PlayerSource[] {
  return streams.map((stream, index) => toPlayerCompatibleSource(stream, mediaType, index) as PlayerSource);
}
