/**
 * Mavero Downloader — admin-controlled link-type visibility (Phase E V2).
 *
 * Administrators can configure which stream/link types are exposed to the
 * Mavero Downloader UI per addon. The configuration is stored in the addon's
 * `capabilities` jsonb column under the key `downloaderLinkTypes`.
 *
 * DEFAULT (backwards-compatible): when `downloaderLinkTypes` is absent,
 * ALL link types are enabled. Existing addons do not lose streams.
 *
 * The configuration controls what the downloader EXPOSES — it does NOT
 * change addon discovery or what the addon returns. Raw streams are still
 * normalized/classified by the existing pipeline; the admin setting filters
 * the presentation set only.
 *
 * Pure module: no DOM, no network, no Svelte, no server imports.
 */

import type { StreamKind } from './stream-actions';

/** The link types an admin can toggle. Mirrors DownloaderStreamKind minus 'external'. */
export type DownloadLinkType = 'http' | 'https' | 'hls' | 'dash' | 'p2p' | 'magnet';

/** All supported link types (for iteration in admin UI). */
export const ALL_DOWNLOAD_LINK_TYPES: readonly DownloadLinkType[] = ['http', 'https', 'hls', 'dash', 'p2p', 'magnet'];

/** Human-readable label for each link type (admin UI + card transport label). */
export function linkTypeLabel(type: DownloadLinkType): string {
  switch (type) {
    case 'http': return 'HTTP';
    case 'https': return 'HTTPS';
    case 'hls': return 'HLS';
    case 'dash': return 'DASH';
    case 'p2p': return 'P2P';
    case 'magnet': return 'Magnet';
  }
}

/** Short category label for each link type (card transport label). */
export function linkTypeCategory(type: DownloadLinkType): string {
  switch (type) {
    case 'http': return 'Direct';
    case 'https': return 'Direct';
    case 'hls': return 'Stream';
    case 'dash': return 'Stream';
    case 'p2p': return 'Torrent';
    case 'magnet': return 'Torrent';
  }
}

/** Description for the admin UI. */
export function linkTypeDescription(type: DownloadLinkType): string {
  switch (type) {
    case 'http': return 'Direct media/download source';
    case 'https': return 'Direct media/download source';
    case 'hls': return 'Streaming manifest';
    case 'dash': return 'Streaming manifest';
    case 'p2p': return 'Torrent source';
    case 'magnet': return 'Torrent source';
  }
}

/** The config object stored in capabilities.downloaderLinkTypes. */
export type DownloadLinkTypesConfig = Record<DownloadLinkType, boolean>;

/** Default config: ALL types enabled (backwards-compatible). */
export const DEFAULT_LINK_TYPES_CONFIG: DownloadLinkTypesConfig = {
  http: true,
  https: true,
  hls: true,
  dash: true,
  p2p: true,
  magnet: true,
};

/**
 * Extracts the downloader link-types config from an addon's capabilities object.
 * Returns the default (all enabled) when the config is absent or malformed.
 */
export function getLinkTypesConfig(capabilities: Record<string, unknown> | undefined | null): DownloadLinkTypesConfig {
  if (!capabilities || typeof capabilities !== 'object') return { ...DEFAULT_LINK_TYPES_CONFIG };
  const raw = capabilities.downloaderLinkTypes;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ...DEFAULT_LINK_TYPES_CONFIG };
  const obj = raw as Record<string, unknown>;
  const config: DownloadLinkTypesConfig = { ...DEFAULT_LINK_TYPES_CONFIG };
  for (const type of ALL_DOWNLOAD_LINK_TYPES) {
    const value = obj[type];
    if (typeof value === 'boolean') config[type] = value;
  }
  return config;
}

/**
 * Checks whether a stream kind is allowed by the config.
 * 'external' is NOT controlled by admin config (it's hidden by Phase 18).
 */
export function isLinkTypeAllowed(kind: StreamKind, config: DownloadLinkTypesConfig): boolean {
  if (kind === 'external') return false; // Phase 18: external always hidden
  return config[kind as DownloadLinkType] ?? true; // default: allowed
}

/**
 * Filters a list of stream kinds to only those allowed by the config.
 * Returns a new array (does not mutate input).
 */
export function filterAllowedKinds(kinds: StreamKind[], config: DownloadLinkTypesConfig): StreamKind[] {
  return kinds.filter((k) => isLinkTypeAllowed(k, config));
}
