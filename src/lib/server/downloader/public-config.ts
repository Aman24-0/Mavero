// MAVERO downloader public config reader.
//
// Mirrors the streaming public-config reader pattern:
//   * In-process cached snapshot keyed by (version, updatedAt).
//   * Cache invalidation is a pure function (clears the snapshot + version).
//   * Public output is sanitized: only enabled providers, only the fields
//     the browser iframe feature needs (no admin-only metadata, no secrets).
//
// Default-fallback rule:
//   - The DB enforces "at most one default" via a partial unique index.
//   - If the current default is disabled (admin mistake or a stale default
//     pointing at a now-disabled provider), the public reader transparently
//     promotes the first enabled provider by (ordering, name) to be the
//     effective default for the public output. The DB row is NOT mutated —
//     the admin still sees the disabled default in the admin UI and can fix
//     it. The public user simply never sees a broken default.
//   - If NO provider is enabled, the public output is an empty array. The
//     DetailPage hides the Download button entirely in that case (no error,
//     no broken UI).
//
// Independent cache: this cache is COMPLETELY separate from the streaming
// config cache. Mutating a streaming provider does NOT invalidate this
// cache, and vice versa. The two registries never share a version counter.

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '$lib/server/supabase/database.types';
import type { PublicDownloadProvider } from '$lib/shared/downloader';
import { MAVERO_DOWNLOADER_PROVIDER_ID, sortPublicDownloadProviders } from '$lib/shared/downloader';

type DownloadClient = SupabaseClient<Database>;

export type PublicDownloadConfig = {
  version: number;
  updatedAt: string;
  providers: PublicDownloadProvider[];
};

const EMPTY_CONFIG: PublicDownloadConfig = { version: 0, updatedAt: new Date(0).toISOString(), providers: [] };

let cached: PublicDownloadConfig | null = null;

/**
 * Invalidate the in-process cached downloader config.
 *
 * Called by the admin-service after every mutation. Also called by the
 * admin-service's setDefaultDownloadProvider. The DB-level
 * bump_download_providers_config_version() trigger additionally bumps the
 * version counter atomically — so even if this in-process invalidation is
 * missed (e.g. on a different server instance), the next public read sees a
 * different version number and re-fetches.
 */
export function invalidatePublicDownloadConfig(): void {
  cached = null;
}

/**
 * Convert a DB row to the sanitized public shape (camelCase fields, no
 * admin-only metadata, no created_at/updated_at).
 */
function toPublic(row: Database['public']['Tables']['download_providers']['Row']): PublicDownloadProvider {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    enabled: row.enabled,
    isDefault: row.is_default,
    ordering: row.ordering,
    icon: row.icon,
    description: row.description,
    supportsMovie: row.supports_movie,
    supportsTv: row.supports_tv,
    movieUrlTemplate: row.movie_url_template,
    tvUrlTemplate: row.tv_url_template,
  };
}

/**
 * Read the public download config.
 *
 * Public output contains ONLY enabled providers, sorted by:
 *   1. default first
 *   2. ordering ascending
 *   3. name ascending
 *
 * Default-fallback rule: if the configured default is disabled (or there is
 * no default), the first enabled provider by (ordering, name) is promoted
 * to default in the public output. The DB row is never mutated.
 */
export async function getPublicDownloadConfig(client: DownloadClient): Promise<PublicDownloadConfig> {
  const metaResult = await client
    .from('download_providers_config_meta')
    .select('version,updated_at')
    .eq('id', 1)
    .limit(1)
    .maybeSingle();
  if (metaResult.error) throw new Error(`Public downloader config version lookup failed: ${metaResult.error.message}`);

  const version = metaResult.data?.version ?? 1;
  const updatedAt = metaResult.data?.updated_at ?? new Date(0).toISOString();
  if (cached?.version === version && cached.updatedAt === updatedAt) return cached;

  const providersResult = await client
    .from('download_providers_public')
    .select('id,name,slug,description,icon,enabled,is_default,ordering,supports_movie,supports_tv,movie_url_template,tv_url_template')
    .eq('enabled', true);

  if (providersResult.error) throw new Error(`Public downloader config lookup failed: ${providersResult.error.message}`);

  const rows = (providersResult.data ?? []).filter(
    (row): row is NonNullable<typeof row> => Boolean(row && row.id && row.name && row.slug)
  );

  const providers: PublicDownloadProvider[] = rows.map((row) => toPublic(row as Database['public']['Tables']['download_providers']['Row']));

  // Default-fallback: if no provider is marked is_default (or the marked
  // default is disabled — which the public view already filters out, so we
  // only see enabled-defaults here), promote the first enabled by
  // (ordering, name). This is a pure in-memory projection; the DB row is
  // not mutated.
  const hasDefault = providers.some((provider) => provider.isDefault);
  if (!hasDefault && providers.length > 0) {
    const sorted = sortPublicDownloadProviders(providers.map((p) => ({ ...p, isDefault: false })));
    providers.forEach((p) => { p.isDefault = false; });
    if (sorted[0]) sorted[0].isDefault = true;
    // Re-sort with the new effective default.
    const finalSorted = sortPublicDownloadProviders(providers);
    cached = { version, updatedAt, providers: finalSorted };
    return cached;
  }

  cached = { version, updatedAt, providers: sortPublicDownloadProviders(providers) };
  return cached;
}

/**
 * Convenience: return an empty config instead of throwing when Supabase is
 * unavailable. Used by routes that want to degrade gracefully (e.g. SSR
 * load that must not 500 just because the downloader registry is briefly
 * unreachable).
 */
export async function getPublicDownloadConfigOrEmpty(client: DownloadClient): Promise<PublicDownloadConfig> {
  try {
    return await getPublicDownloadConfig(client);
  } catch (error) {
    console.error('[Downloader] Public configuration failed', error);
    return EMPTY_CONFIG;
  }
}

// ---------------------------------------------------------------------------
// Phase 19 — Mavero Downloader is now DB-managed.
//
// The migration seeds a 'mavero-downloader' row with placeholder URL templates
// (https://mavero.local/...) to satisfy the DB's HTTPS CHECK constraint. At
// read time the public-config endpoint rewrites those templates to the CURRENT
// request origin so the standalone deep-link pages resolve correctly.
//
// The old Phase 14 synthetic injection (withMaveroDownloaderProvider) is kept
// as a back-compat shim for tests, but the config endpoint NO LONGER calls it
// — the DB row is the source of truth. If the admin disables Mavero in the
// DB, it disappears from the public config (the synthetic injection would
// have ignored the enabled flag).
// ---------------------------------------------------------------------------

/** The stable id/slug of the Mavero Downloader provider (defined in $lib/shared/downloader). */
export { MAVERO_DOWNLOADER_PROVIDER_ID };

/**
 * Rewrites the Mavero Downloader URL templates to the current request origin.
 * The DB stores `https://mavero.local/...` (placeholder); this function
 * replaces it with the real origin so the deep-link pages resolve.
 *
 * If the row is NOT the Mavero Downloader, returns it unchanged.
 */
export function rewriteMaveroOrigin(provider: PublicDownloadProvider, origin: string): PublicDownloadProvider {
  if (provider.slug !== MAVERO_DOWNLOADER_PROVIDER_ID) return provider;
  return {
    ...provider,
    movieUrlTemplate: provider.movieUrlTemplate?.replace('https://mavero.local', origin) ?? `${origin}/watch/mavero-downloader/movie/{tmdbId}`,
    tvUrlTemplate: provider.tvUrlTemplate?.replace('https://mavero.local', origin) ?? `${origin}/watch/mavero-downloader/tv/{tmdbId}/{season}/{episode}`,
  };
}

/**
 * Rewrites ALL Mavero Downloader entries in a config to the current origin.
 */
export function rewriteMaveroOrigins(config: PublicDownloadConfig, origin: string): PublicDownloadConfig {
  return {
    ...config,
    providers: config.providers.map((p) => rewriteMaveroOrigin(p, origin)),
  };
}

/**
 * Phase 14 back-compat: builds the synthetic Mavero Downloader provider entry.
 * Phase 19: NO LONGER called by the config endpoint (the DB row is the source
 * of truth). Kept for test back-compat — tests that reference this function
 * still pass.
 */
export function builtinMaveroDownloaderProvider(origin: string): PublicDownloadProvider {
  return {
    id: MAVERO_DOWNLOADER_PROVIDER_ID,
    name: 'Mavero Downloader',
    slug: MAVERO_DOWNLOADER_PROVIDER_ID,
    enabled: true,
    isDefault: false,
    ordering: Number.MAX_SAFE_INTEGER,
    icon: null,
    description: 'Best direct links from enabled Stremio HTTP addons.',
    supportsMovie: true,
    supportsTv: true,
    movieUrlTemplate: `${origin}/watch/mavero-downloader/movie/{tmdbId}`,
    tvUrlTemplate: `${origin}/watch/mavero-downloader/tv/{tmdbId}/{season}/{episode}`,
  };
}

/**
 * Phase 14 back-compat: appends the synthetic provider to a config (dedupe-safe).
 * Phase 19: NO LONGER called by the config endpoint. Kept for test back-compat.
 */
export function withMaveroDownloaderProvider(config: PublicDownloadConfig, origin: string): PublicDownloadConfig {
  const builtin = builtinMaveroDownloaderProvider(origin);
  if (config.providers.some((provider) => provider.slug === builtin.slug)) return config;
  return { ...config, providers: [...config.providers, builtin] };
}
