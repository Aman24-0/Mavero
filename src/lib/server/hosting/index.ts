/**
 * Phase 3 — Hosting provider adapter module.
 *
 * Barrel export for the provider-neutral adapter interface, error
 * model, HTTP client, and concrete Vidara / Abyss adapters.
 *
 * Usage (server-only):
 *   import { VidaraAdapter, AbyssAdapter } from '$lib/server/hosting';
 *   import type { HostingProviderAdapter } from '$lib/server/hosting';
 */

export type {
  HostingProviderAdapter,
  HostingProviderKey,
  ProviderCapabilities,
  RemoteUploadType,
  ProviderAccountInfo,
  ProviderAssetInfo,
  ProviderFolderInfo,
  ProviderUploadResult,
  ProviderProcessingStatus,
  AssetLifecycleState,
  StatusMapper,
  HostingAdapterDeps,
  UploadFileParams,
  UploadRemoteParams,
  CreateFolderParams,
  UploadSubtitleParams,
} from './types';

export {
  HostingProviderError,
  asHostingError,
  classifyHttpError,
  isRetryable,
} from './errors';

export type { HostingErrorCode, HostingProviderErrorOptions } from './errors';

export {
  createHostingHttpFetcher,
  withRetry,
} from './http-client';

export type { HostingHttpRequest, HostingHttpResponse, HostingHttpFetcher } from './http-client';

export { VidaraAdapter } from './vidara/adapter';
export type { VidaraAdapterOptions } from './vidara/adapter';
export { createVidaraConfig, getVidaraConfigOrNull } from './vidara/config';
export type { VidaraConfig } from './vidara/config';

export { AbyssAdapter } from './abyss/adapter';
export type { AbyssAdapterOptions } from './abyss/adapter';
export { createAbyssConfig, getAbyssConfigOrNull } from './abyss/config';
export type { AbyssConfig } from './abyss/config';

// Phase 4 — hosting adapter registry.
export { getHostingAdapter, getHostingAdapterForProvider, getHostingAdapterKeys } from './registry';
