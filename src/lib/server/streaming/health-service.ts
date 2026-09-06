import type { SupabaseClient } from '@supabase/supabase-js';
import { asResolverError } from '$lib/server/resolver/errors';
import type { Database } from '$lib/server/supabase/database.types';
import {
  deriveRuntimeHealthState,
  isRuntimeHealthEligible,
  nextHealthAfterFailure,
  nextHealthAfterSuccess,
  summarizeProviderHealth,
  type ProviderHealthSummary,
  type RuntimeFailureType,
  type RuntimeHealthRow,
} from './health';

export type HealthClient = SupabaseClient<Database>;

function nowIso() { return new Date().toISOString(); }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function runtimeFailureType(error: unknown): RuntimeFailureType | null {
  const resolverError = asResolverError(error);
  switch (resolverError.code) {
    case 'INVALID_TEMPLATE':
    case 'INVALID_PROVIDER_ENDPOINT':
    case 'INVALID_SOURCE_URL':
    case 'PROVIDER_RESPONSE_INVALID':
    case 'SOURCE_EXPIRED':
      return 'invalid_response';
    case 'RESOLUTION_UNAVAILABLE':
      return 'provider_unavailable';
    case 'INTERNAL_RESOLUTION_ERROR':
      return 'resolution_failure';
    case 'PROVIDER_DISABLED':
    case 'SOURCE_DISABLED':
    case 'SOURCE_MAINTENANCE':
    case 'UNSUPPORTED_MEDIA_TYPE':
    case 'MISSING_IDENTIFIER':
    case 'INVALID_REQUEST':
    case 'PROVIDER_NOT_FOUND':
    case 'SOURCE_NOT_FOUND':
      return null;
    default:
      return 'resolution_failure';
  }
}

async function loadRow(client: HealthClient, providerId: string, sourceId: string): Promise<RuntimeHealthRow | null> {
  const { data, error } = await client
    .from('streaming_provider_health')
    .select('*')
    .eq('provider_id', providerId)
    .eq('source_id', sourceId)
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function upsertRow(client: HealthClient, row: RuntimeHealthRow): Promise<void> {
  const { error } = await client
    .from('streaming_provider_health')
    .upsert(row, { onConflict: 'provider_id,source_id' });
  if (error) throw error;
}

export async function recordRuntimeSuccess(client: HealthClient, providerId: string, sourceId: string, checkedAt = nowIso()): Promise<void> {
  try {
    const next = nextHealthAfterSuccess(await loadRow(client, providerId, sourceId), checkedAt);
    next.provider_id = providerId;
    next.source_id = sourceId;
    await upsertRow(client, next);
  } catch (error) {
    console.warn('[ProviderHealth] success update unavailable', error);
  }
}

export async function recordRuntimeFailure(client: HealthClient, providerId: string, sourceId: string, error: unknown, checkedAt = nowIso()): Promise<void> {
  const failureType = runtimeFailureType(error);
  if (!failureType) return;
  try {
    const next = nextHealthAfterFailure(await loadRow(client, providerId, sourceId), failureType, checkedAt);
    next.provider_id = providerId;
    next.source_id = sourceId;
    await upsertRow(client, next);
  } catch (healthError) {
    console.warn('[ProviderHealth] failure update unavailable', healthError);
  }
}

export async function isRuntimeSourceEligible(client: HealthClient, providerId: string, sourceId: string, now = Date.now()): Promise<boolean> {
  try {
    const row = await loadRow(client, providerId, sourceId);
    return !row || isRuntimeHealthEligible(row, now);
  } catch (error) {
    console.warn('[ProviderHealth] eligibility check unavailable', error);
    return true;
  }
}

export async function loadSourceHealthMap(client: HealthClient, sourceIds: string[]): Promise<Map<string, RuntimeHealthRow>> {
  if (!sourceIds.length) return new Map();
  const { data, error } = await client.from('streaming_provider_health').select('*').in('source_id', sourceIds).limit(2000);
  if (error) throw error;
  return new Map((data ?? []).map((row) => [row.source_id, row]));
}

export async function listProviderHealth(client: HealthClient, providerIds?: string[]): Promise<RuntimeHealthRow[]> {
  let query = client.from('streaming_provider_health').select('*').order('updated_at', { ascending: false }).limit(2000);
  if (providerIds?.length) query = query.in('provider_id', providerIds);
  const { data, error } = await query;
  if (error) throw error;
  return data ?? [];
}

export async function listProviderHealthSummaries(client: HealthClient, providerIds?: string[]): Promise<Record<string, ProviderHealthSummary>> {
  try {
    return summarizeProviderHealth(await listProviderHealth(client, providerIds));
  } catch (error) {
    console.warn('[ProviderHealth] admin summary unavailable', error);
    return {};
  }
}

export function publicHealthLabel(summary: ProviderHealthSummary | undefined): string {
  if (!summary) return 'Unknown';
  return summary.state[0].toUpperCase() + summary.state.slice(1);
}

export function healthSummaryFromRows(rows: RuntimeHealthRow[]): Record<string, ProviderHealthSummary> {
  return summarizeProviderHealth(rows);
}

export function healthRowState(row: RuntimeHealthRow): string {
  return deriveRuntimeHealthState(row);
}

export function parseHealthRows(value: unknown): RuntimeHealthRow[] {
  return Array.isArray(value) && value.every(isRecord) ? value as unknown as RuntimeHealthRow[] : [];
}
