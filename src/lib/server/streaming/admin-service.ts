import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database, TablesInsert } from '$lib/server/supabase/database.types';
import { invalidatePublicStreamingConfig } from './public-config';
import type { CategoryInsert, CategoryUpdate, ProviderInsert, ProviderUpdate, SourceInsert, SourceUpdate, StreamingCategoryRow, StreamingProviderRow, StreamingSourceCategoryRow, StreamingSourceRow, AdminOverview, ProviderHealthSummary } from './types';
import { listProviderHealthSummaries as loadProviderHealthSummaries } from './health-service';

type StreamingClient = SupabaseClient<Database>;

type RegistryError = { code?: string; message?: string } | null;

function throwRegistryError(operation: string, registryError: RegistryError): never {
  if (registryError?.code === '23505') throw new Error('A record with this slug or ordering already exists.');
  if (registryError?.code === '23503') throw new Error('This record references a missing or dependent registry record.');
  if (registryError?.code === '23514') throw new Error('The configuration failed a database safety check.');
  if (registryError?.code === '42501') throw new Error('You are not authorized to change the streaming registry.');
  throw new Error(`${operation} failed. Please try again.`);
}

async function count(client: StreamingClient, table: 'streaming_providers' | 'streaming_sources' | 'streaming_categories', filters: Record<string, string> = {}) {
  let query = client.from(table).select('id', { count: 'exact', head: true });
  for (const [key, value] of Object.entries(filters)) query = query.eq(key, value);
  const { count: total, error } = await query;
  if (error) throwRegistryError(`Count ${table}`, error);
  return total ?? 0;
}

export async function getAdminOverview(client: StreamingClient): Promise<AdminOverview> {
  const [providerCount, activeProviderCount, sourceCount, activeSourceCount, categoryCount, maintenanceCount, experimentalCount, metaResult] = await Promise.all([
    count(client, 'streaming_providers'),
    count(client, 'streaming_providers', { enabled: 'true' }),
    count(client, 'streaming_sources'),
    count(client, 'streaming_sources', { enabled: 'true' }),
    count(client, 'streaming_categories'),
    client.from('streaming_providers').select('id', { count: 'exact', head: true }).eq('status', 'maintenance'),
    client.from('streaming_providers').select('id', { count: 'exact', head: true }).eq('status', 'experimental'),
    client.from('streaming_config_meta').select('version,updated_at').eq('id', 1).limit(1).maybeSingle(),
  ]);
  if (maintenanceCount.error) throwRegistryError('Read maintenance count', maintenanceCount.error);
  if (experimentalCount.error) throwRegistryError('Read experimental count', experimentalCount.error);
  if (metaResult.error) throwRegistryError('Read config version', metaResult.error);
  return {
    providerCount,
    activeProviderCount,
    sourceCount,
    activeSourceCount,
    categoryCount,
    maintenanceCount: maintenanceCount.count ?? 0,
    experimentalCount: experimentalCount.count ?? 0,
    configVersion: metaResult.data?.version ?? 1,
    configUpdatedAt: metaResult.data?.updated_at ?? new Date(0).toISOString(),
  };
}

export async function listAdminProviders(client: StreamingClient): Promise<StreamingProviderRow[]> {
  const { data, error } = await client.from('streaming_providers').select('*').order('name');
  if (error) throwRegistryError('List providers', error);
  return data ?? [];
}

export async function listProviderHealthSummaries(client: StreamingClient): Promise<Record<string, ProviderHealthSummary>> {
  return loadProviderHealthSummaries(client);
}

export async function listAdminSources(client: StreamingClient): Promise<StreamingSourceRow[]> {
  const { data, error } = await client.from('streaming_sources').select('*').order('ordering').order('name');
  if (error) throwRegistryError('List sources', error);
  return data ?? [];
}

export async function listAdminCategories(client: StreamingClient): Promise<StreamingCategoryRow[]> {
  const { data, error } = await client.from('streaming_categories').select('*').order('ordering').order('name');
  if (error) throwRegistryError('List categories', error);
  return data ?? [];
}

export async function listSourceCategories(client: StreamingClient): Promise<StreamingSourceCategoryRow[]> {
  const { data, error } = await client.from('streaming_source_categories').select('*').order('category_id').order('ordering');
  if (error) throwRegistryError('List source categories', error);
  return data ?? [];
}

export async function createProvider(client: StreamingClient, input: ProviderInsert) {
  const { data, error } = await client.from('streaming_providers').insert(input).select('*').single();
  if (error) throwRegistryError('Create provider', error);
  invalidatePublicStreamingConfig();
  return data;
}

export async function updateProvider(client: StreamingClient, id: string, input: ProviderUpdate) {
  const { data, error } = await client.from('streaming_providers').update(input).eq('id', id).select('*').single();
  if (error) throwRegistryError('Update provider', error);
  invalidatePublicStreamingConfig();
  return data;
}

export async function deleteProvider(client: StreamingClient, id: string) {
  const dependentSources = await count(client, 'streaming_sources', { provider_id: id });
  if (dependentSources > 0) throw new Error('This provider has dependent sources. Reassign or delete those sources before deleting the provider.');
  const { error } = await client.from('streaming_providers').delete().eq('id', id);
  if (error) throwRegistryError('Delete provider', error);
  invalidatePublicStreamingConfig();
}

export async function createSource(client: StreamingClient, input: SourceInsert) {
  const { data, error } = await client.from('streaming_sources').insert(input).select('*').single();
  if (error) throwRegistryError('Create source', error);
  invalidatePublicStreamingConfig();
  return data;
}

export async function updateSource(client: StreamingClient, id: string, input: SourceUpdate) {
  const { data, error } = await client.from('streaming_sources').update(input).eq('id', id).select('*').single();
  if (error) throwRegistryError('Update source', error);
  invalidatePublicStreamingConfig();
  return data;
}

export async function deleteSource(client: StreamingClient, id: string) {
  const { count: mappingCount, error: mappingError } = await client.from('streaming_source_categories').select('source_id', { count: 'exact', head: true }).eq('source_id', id);
  if (mappingError) throwRegistryError('Check source dependencies', mappingError);
  if ((mappingCount ?? 0) > 0) throw new Error('This source belongs to one or more categories. Remove its category assignments before deleting it.');
  const { error } = await client.from('streaming_sources').delete().eq('id', id);
  if (error) throwRegistryError('Delete source', error);
  invalidatePublicStreamingConfig();
}

export async function createCategory(client: StreamingClient, input: CategoryInsert) {
  const { data, error } = await client.from('streaming_categories').insert(input).select('*').single();
  if (error) throwRegistryError('Create category', error);
  invalidatePublicStreamingConfig();
  return data;
}

export async function updateCategory(client: StreamingClient, id: string, input: CategoryUpdate) {
  const { data, error } = await client.from('streaming_categories').update(input).eq('id', id).select('*').single();
  if (error) throwRegistryError('Update category', error);
  invalidatePublicStreamingConfig();
  return data;
}

export async function deleteCategory(client: StreamingClient, id: string) {
  const { count: mappingCount, error: mappingError } = await client.from('streaming_source_categories').select('category_id', { count: 'exact', head: true }).eq('category_id', id);
  if (mappingError) throwRegistryError('Check category dependencies', mappingError);
  if ((mappingCount ?? 0) > 0) throw new Error('This category has source assignments. Remove its sources before deleting the category.');
  const { error } = await client.from('streaming_categories').delete().eq('id', id);
  if (error) throwRegistryError('Delete category', error);
  invalidatePublicStreamingConfig();
}

export async function upsertSourceCategory(client: StreamingClient, input: TablesInsert<'streaming_source_categories'>) {
  const { data, error } = await client.from('streaming_source_categories').upsert(input, { onConflict: 'source_id,category_id' }).select('*').single();
  if (error) throwRegistryError('Assign source category', error);
  invalidatePublicStreamingConfig();
  return data;
}

export async function deleteSourceCategory(client: StreamingClient, sourceId: string, categoryId: string) {
  const { error } = await client.from('streaming_source_categories').delete().eq('source_id', sourceId).eq('category_id', categoryId);
  if (error) throwRegistryError('Remove source category', error);
  invalidatePublicStreamingConfig();
}
