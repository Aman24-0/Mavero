import type { Tables } from '$lib/server/supabase/database.types';

export const runtimeHealthStates = ['healthy', 'degraded', 'unhealthy', 'cooldown', 'unknown'] as const;
export type RuntimeHealthState = (typeof runtimeHealthStates)[number];

export const runtimeFailureTypes = [
  'resolution_failure',
  'provider_unavailable',
  'timeout',
  'embed_load_failure',
  'playback_failure',
  'network_failure',
  'invalid_response',
] as const;
export type RuntimeFailureType = (typeof runtimeFailureTypes)[number];

export type RuntimeHealthRow = Tables<'streaming_provider_health'>;

export type ProviderHealthSummary = {
  providerId: string;
  state: RuntimeHealthState;
  consecutiveFailures: number;
  successCount: number;
  failureCount: number;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastCheckedAt: string | null;
  cooldownUntil: string | null;
  sourceCount: number;
};

export const RUNTIME_HEALTH_THRESHOLDS = {
  unhealthyAfter: 3,
  cooldownAfter: 5,
  cooldownMs: 5 * 60 * 1000,
} as const;

function timeValue(value: string | null | undefined): number | null {
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

export function deriveRuntimeHealthState(row: Pick<RuntimeHealthRow, 'status' | 'consecutive_failures' | 'success_count' | 'last_checked_at' | 'cooldown_until'>, now = Date.now()): RuntimeHealthState {
  const cooldownUntil = timeValue(row.cooldown_until);
  if (cooldownUntil !== null && cooldownUntil > now) return 'cooldown';
  if (!row.last_checked_at) return 'unknown';
  if (row.consecutive_failures >= RUNTIME_HEALTH_THRESHOLDS.unhealthyAfter) return 'unhealthy';
  if (row.consecutive_failures > 0) return 'degraded';
  if (row.success_count > 0) return 'healthy';
  return row.status === 'unknown' ? 'unknown' : 'healthy';
}

export function isRuntimeHealthEligible(row: Pick<RuntimeHealthRow, 'status' | 'consecutive_failures' | 'success_count' | 'last_checked_at' | 'cooldown_until'>, now = Date.now()): boolean {
  const cooldownUntil = timeValue(row.cooldown_until);
  return cooldownUntil === null || cooldownUntil <= now;
}

export function nextHealthAfterSuccess(row: RuntimeHealthRow | null, checkedAt: string): RuntimeHealthRow {
  const base = row ?? {
    provider_id: '',
    source_id: '',
    status: 'unknown' as const,
    consecutive_failures: 0,
    success_count: 0,
    failure_count: 0,
    last_success_at: null,
    last_failure_at: null,
    last_checked_at: null,
    cooldown_until: null,
    last_failure_type: null,
    created_at: checkedAt,
    updated_at: checkedAt,
  };
  return {
    ...base,
    status: 'healthy',
    consecutive_failures: 0,
    success_count: base.success_count + 1,
    last_success_at: checkedAt,
    last_checked_at: checkedAt,
    cooldown_until: null,
    last_failure_type: null,
    updated_at: checkedAt,
  };
}

export function nextHealthAfterFailure(row: RuntimeHealthRow | null, failureType: RuntimeFailureType, checkedAt: string): RuntimeHealthRow {
  const base = row ?? {
    provider_id: '',
    source_id: '',
    status: 'unknown' as const,
    consecutive_failures: 0,
    success_count: 0,
    failure_count: 0,
    last_success_at: null,
    last_failure_at: null,
    last_checked_at: null,
    cooldown_until: null,
    last_failure_type: null,
    created_at: checkedAt,
    updated_at: checkedAt,
  };
  const consecutiveFailures = base.consecutive_failures + 1;
  const checkedTime = Date.parse(checkedAt);
  const cooldownUntil = consecutiveFailures >= RUNTIME_HEALTH_THRESHOLDS.cooldownAfter && Number.isFinite(checkedTime)
    ? new Date(checkedTime + RUNTIME_HEALTH_THRESHOLDS.cooldownMs).toISOString()
    : base.cooldown_until;
  return {
    ...base,
    status: consecutiveFailures >= RUNTIME_HEALTH_THRESHOLDS.cooldownAfter ? 'cooldown' : consecutiveFailures >= RUNTIME_HEALTH_THRESHOLDS.unhealthyAfter ? 'unhealthy' : 'degraded',
    consecutive_failures: consecutiveFailures,
    failure_count: base.failure_count + 1,
    last_failure_at: checkedAt,
    last_checked_at: checkedAt,
    cooldown_until: cooldownUntil,
    last_failure_type: failureType,
    updated_at: checkedAt,
  };
}

export function summarizeProviderHealth(rows: RuntimeHealthRow[], now = Date.now()): Record<string, ProviderHealthSummary> {
  const grouped = new Map<string, RuntimeHealthRow[]>();
  for (const row of rows) grouped.set(row.provider_id, [...(grouped.get(row.provider_id) ?? []), row]);
  const result: Record<string, ProviderHealthSummary> = {};
  for (const [providerId, providerRows] of grouped) {
    const states = providerRows.map((row) => deriveRuntimeHealthState(row, now));
    const state = states.includes('cooldown') ? 'cooldown' : states.includes('unhealthy') ? 'unhealthy' : states.includes('degraded') ? 'degraded' : states.includes('healthy') ? 'healthy' : 'unknown';
    const latest = (field: 'last_success_at' | 'last_failure_at' | 'last_checked_at' | 'cooldown_until') => providerRows.map((row) => row[field]).filter((value): value is string => Boolean(value)).sort().at(-1) ?? null;
    result[providerId] = {
      providerId,
      state,
      consecutiveFailures: Math.max(...providerRows.map((row) => row.consecutive_failures)),
      successCount: providerRows.reduce((total, row) => total + row.success_count, 0),
      failureCount: providerRows.reduce((total, row) => total + row.failure_count, 0),
      lastSuccessAt: latest('last_success_at'),
      lastFailureAt: latest('last_failure_at'),
      lastCheckedAt: latest('last_checked_at'),
      cooldownUntil: latest('cooldown_until'),
      sourceCount: providerRows.length,
    };
  }
  return result;
}
