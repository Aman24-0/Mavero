import type { Json, Tables, TablesInsert, TablesUpdate } from '$lib/server/supabase/database.types';
import { providerStatuses, integrationTypes, sourceVisibilities, identifierModes } from '$lib/shared/streaming';

export { providerStatuses, integrationTypes, sourceVisibilities, identifierModes };
export type ProviderStatus = (typeof providerStatuses)[number];
export type IntegrationType = (typeof integrationTypes)[number];
export type SourceVisibility = (typeof sourceVisibilities)[number];
export type IdentifierMode = (typeof identifierModes)[number];

export type StreamingProviderRow = Tables<'streaming_providers'>;
export type StreamingSourceRow = Tables<'streaming_sources'>;
export type StreamingCategoryRow = Tables<'streaming_categories'>;
export type StreamingSourceCategoryRow = Tables<'streaming_source_categories'>;
export type StreamingConfigMetaRow = Tables<'streaming_config_meta'>;

export type ProviderInsert = TablesInsert<'streaming_providers'>;
export type ProviderUpdate = TablesUpdate<'streaming_providers'>;
export type SourceInsert = TablesInsert<'streaming_sources'>;
export type SourceUpdate = TablesUpdate<'streaming_sources'>;
export type CategoryInsert = TablesInsert<'streaming_categories'>;
export type CategoryUpdate = TablesUpdate<'streaming_categories'>;

export type JsonObject = { [key: string]: Json | undefined };

export type AdminOverview = {
  providerCount: number;
  activeProviderCount: number;
  sourceCount: number;
  activeSourceCount: number;
  categoryCount: number;
  maintenanceCount: number;
  experimentalCount: number;
  configVersion: number;
  configUpdatedAt: string;
};

export type PublicStreamingProvider = Pick<StreamingProviderRow, 'id' | 'name' | 'slug' | 'description' | 'icon' | 'status' | 'enabled' | 'integration_type' | 'capabilities'>;
export type PublicStreamingSource = Pick<StreamingSourceRow, 'id' | 'provider_id' | 'name' | 'slug' | 'description' | 'enabled' | 'visibility' | 'status' | 'ordering' | 'integration_type' | 'capabilities' | 'identifier_mode' | 'language' | 'audio_languages' | 'subtitle_capability' | 'quality_capability'>;
export type PublicStreamingCategory = Pick<StreamingCategoryRow, 'id' | 'name' | 'slug' | 'description' | 'enabled' | 'ordering'>;

export type PublicStreamingConfig = {
  version: number;
  updatedAt: string;
  providers: PublicStreamingProvider[];
  sources: PublicStreamingSource[];
  categories: PublicStreamingCategory[];
  sourceCategories: StreamingSourceCategoryRow[];
};
