// MAVERO downloader registry server types.
//
// Mirrors the streaming registry's type pattern but stays fully isolated —
// no shared imports from streaming types so a refactor of one cannot break
// the other.

import type { Tables, TablesInsert, TablesUpdate } from '$lib/server/supabase/database.types';
import type { PublicDownloadProvider } from '$lib/shared/downloader';

export type DownloadProviderRow = Tables<'download_providers'>;
export type DownloadProviderConfigMetaRow = Tables<'download_providers_config_meta'>;
export type DownloadProviderInsert = TablesInsert<'download_providers'>;
export type DownloadProviderUpdate = TablesUpdate<'download_providers'>;

/**
 * Admin overview shape returned by the /admin/downloaders page. Counts +
 * config version for the small card on the Admin Overview too.
 */
export type DownloadersAdminOverview = {
  providerCount: number;
  enabledCount: number;
  defaultCount: number;
  configVersion: number;
  configUpdatedAt: string;
};

/**
 * Re-export the public provider type so server modules can stay consistent
 * with the shared contract.
 */
export type { PublicDownloadProvider };

/**
 * Sanitized projection used by the public config reader. Defined here so the
 * admin-service can reuse it when previewing what the public sees.
 */
export const PUBLIC_PROVIDER_FIELDS = [
  'id',
  'name',
  'slug',
  'description',
  'icon',
  'enabled',
  'is_default',
  'ordering',
  'supports_movie',
  'supports_tv',
  'movie_url_template',
  'tv_url_template',
] as const;
