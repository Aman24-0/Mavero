import { normalizeCandidate } from './normalization';
import { genericDiscoveryDetectors } from './detectors';
import type { DiscoveryRegistry, DiscoveryResolver, MediaCandidate, NormalizedStreamResult, UniversalResolverContext } from './types';

const genericResolver: DiscoveryResolver = {
  id: 'generic-public-media',
  name: 'Generic public media resolver',
  priority: 10,
  timeoutMs: 2500,
  enabled: true,
  supportedMediaTypes: ['movie', 'series', 'anime'],
  urlPatterns: ['*'],
  supports: (candidate) => candidate.type !== 'embed' || candidate.url.startsWith('https://'),
  async resolve(candidate) {
    return normalizeCandidate(candidate);
  },
};

export function createDefaultDiscoveryRegistry(): DiscoveryRegistry {
  return {
    detectors: genericDiscoveryDetectors,
    resolvers: [genericResolver],
  };
}

export function createDiscoveryRegistry(detectors: DiscoveryRegistry['detectors'], resolvers: DiscoveryRegistry['resolvers'] = [genericResolver]): DiscoveryRegistry {
  return {
    detectors: [...detectors],
    resolvers: [...resolvers].sort((left, right) => left.priority - right.priority || left.id.localeCompare(right.id)),
  };
}

export function resolverCandidates(registry: DiscoveryRegistry, candidates: MediaCandidate[], context: UniversalResolverContext): Array<{ resolver: DiscoveryResolver; candidate: MediaCandidate }> {
  const pairs: Array<{ resolver: DiscoveryResolver; candidate: MediaCandidate }> = [];
  for (const resolver of registry.resolvers) {
    if (resolver.enabled === false) continue;
    for (const candidate of candidates) {
      if (resolver.supports(candidate, context)) pairs.push({ resolver, candidate });
    }
  }
  return pairs;
}

export async function resolveCandidateWithRegistry(resolver: DiscoveryResolver, candidate: MediaCandidate, context: UniversalResolverContext, timeout: (work: Promise<NormalizedStreamResult | null>, timeoutMs: number, signal: AbortSignal) => Promise<NormalizedStreamResult | null>): Promise<NormalizedStreamResult | null> {
  return timeout(resolver.resolve(candidate, context), resolver.timeoutMs, context.signal);
}
