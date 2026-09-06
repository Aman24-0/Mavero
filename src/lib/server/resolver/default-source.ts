import type { TrustedResolutionConfig } from './types';

/**
 * Phase 2: reorder the fallback candidate list so the admin-configured
 * default source (if any) is first. Returns the input array unchanged when
 * no default is configured or the default is not in the candidate list
 * (e.g. the default source is disabled, internal, or in maintenance — in
 * which case the public config reader already omitted it from the public
 * sources list, and `loadTrustedFallbackCandidates` will not have included
 * it either).
 *
 * IMPORTANT: this function does NOT mutate health scores, does NOT inject
 * the default into the list if it isn't already there, and does NOT skip
 * the ranking gates. It only reorders within the list so the default wins
 * the `sourceOrder ASC` tiebreaker in `rankProviderSourceList`'s sort.
 *
 * This module is separated from `service.ts` so it can be imported by
 * Phase 2 contract tests without pulling in the `$env/dynamic/private`
 * SvelteKit virtual module (which is not resolvable under tsx).
 */
export function applyDefaultSourceOrdering(configs: TrustedResolutionConfig[], defaultSourceId: string | undefined): TrustedResolutionConfig[] {
  if (!defaultSourceId || configs.length <= 1) return configs;
  const defaultIndex = configs.findIndex((config) => config.source.id === defaultSourceId);
  if (defaultIndex <= 0) return configs; // Already first, or not in the list.
  // Move the default to the front; preserve the relative order of the rest.
  const reordered: TrustedResolutionConfig[] = [configs[defaultIndex]];
  for (let i = 0; i < configs.length; i += 1) {
    if (i !== defaultIndex) reordered.push(configs[i]);
  }
  return reordered;
}
