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

/**
 * MAVP-5 (Issue 6): ordered-default variant. Moves EVERY configured default
 * to the front of the candidate list, in the given attempt order (primary →
 * secondary → tertiary), preserving the relative order of the remaining
 * candidates. Idempotent and additive-only: defaults not present in the
 * list are ignored (never injected); the ranking gates still apply to every
 * candidate. The single-id function above remains the exact behavior for a
 * one-element order (and stays exported for the Phase 2 contract tests).
 */
export function applyOrderedDefaultSourceOrdering(configs: TrustedResolutionConfig[], defaultSourceIds: readonly string[] | undefined): TrustedResolutionConfig[] {
  if (!defaultSourceIds || defaultSourceIds.length === 0 || configs.length <= 1) return configs;
  const orderedDefaults = [...defaultSourceIds].reverse(); // front-insert from the last so the first ends up first
  const remaining = [...configs];
  const reordered: TrustedResolutionConfig[] = [];
  for (const defaultId of orderedDefaults) {
    const index = remaining.findIndex((config) => config.source.id === defaultId);
    if (index === -1) continue; // Not in the candidate list — never injected.
    reordered.unshift(remaining.splice(index, 1)[0]);
  }
  // `reordered` holds the defaults in attempt order (each unshift placed its
  // predecessor in front), followed by the untouched remainder — except when
  // NO default was found, in which case the input is returned unchanged.
  if (!reordered.length) return configs;
  return [...reordered, ...remaining];
}
