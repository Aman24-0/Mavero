export type PlayerMode = 'source' | 'native';

export type PlayerModeResolutionPolicy = {
  aggregate: boolean;
  enableFallback: boolean;
};

export function parsePlayerMode(value: string | null | undefined): PlayerMode | null {
  return value === 'source' || value === 'native' ? value : null;
}

export function resolutionPolicyForPlayerMode(mode: PlayerMode, allowFallback = true): PlayerModeResolutionPolicy {
  return { aggregate: mode === 'native' && allowFallback, enableFallback: allowFallback };
}

export function withPlayerMode(pathname: string, currentSearchParams: URLSearchParams, mode: PlayerMode): string {
  const params = new URLSearchParams(currentSearchParams);
  params.set('player', mode);
  const query = params.toString();
  return `${pathname}${query ? `?${query}` : ''}`;
}
