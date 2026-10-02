/**
 * MAVERO CloudStream shared type contracts (CS-1).
 *
 * Pure TYPE definitions shared between the CloudStream server domain
 * (`src/lib/server/cloudstream/**`) and the admin UI (Integrations Extension
 * tab + Add Integration CloudStream flow). Mirrors the `hosting-types`
 * convention: server services produce these views; admin components consume
 * them. NO runtime code lives here — importing this module is safe on both
 * the server and the client.
 *
 * SECURITY: these models carry catalog METADATA only. Plugin artifact URLs
 * (`pluginUrl`) are inert metadata — never fetched or executed.
 */

/** Repository sync health (plan §6.1). */
export type CloudStreamRepositoryStatus = 'active' | 'disabled' | 'error' | 'invalid';

/**
 * Mavero-side compatibility state (plan §6.2). 'disabled' is NOT stored —
 * it is derived from the extension `enabled` flag at display time.
 */
export type CloudStreamAdapterStatus = 'compatible' | 'adapter_required' | 'unsupported' | 'broken';

/** Administrator-facing safe view of one CloudStream repository. */
export type CloudStreamRepositoryView = {
  id: string;
  name: string;
  url: string;
  description: string | null;
  iconUrl: string | null;
  enabled: boolean;
  status: CloudStreamRepositoryStatus;
  extensionCount: number;
  lastSyncedAt: string | null;
  lastCheckedAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
};

/** Administrator-facing safe view of one discovered extension. */
export type CloudStreamExtensionView = {
  id: string;
  repositoryId: string;
  repositoryName: string;
  internalName: string;
  name: string | null;
  version: number | null;
  apiVersion: number | null;
  description: string | null;
  authors: string[];
  language: string | null;
  /** CloudStream TvType enum NAMES ('Movie', 'TvSeries', …). */
  tvTypes: string[];
  pluginUrl: string | null;
  pluginStatus: number | null;
  iconUrl: string | null;
  fileHash: string | null;
  fileSizeBytes: number | null;
  sourceUrl: string | null;
  enabled: boolean;
  adapterStatus: CloudStreamAdapterStatus;
  maveroAdapterId: string | null;
  adapterVersion: string | null;
  lastCheckedAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
};

/** Preview of an extension inside the repository add flow (no ids yet). */
export type CloudStreamExtensionPreview = {
  internalName: string;
  name: string | null;
  version: number | null;
  language: string | null;
  /** CloudStream TvType enum NAMES. */
  tvTypes: string[];
  adapterStatus: CloudStreamAdapterStatus;
};

/** Repository validate/preview result (validation only — NO persistence). */
export type CloudStreamRepositoryPreview = {
  /** The validated repository URL (echoed for the confirmation round-trip). */
  repositoryUrl: string;
  name: string;
  description: string | null;
  iconUrl: string | null;
  pluginListCount: number;
  extensionCount: number;
  extensions: CloudStreamExtensionPreview[];
  /** True when the extension list was truncated for the preview bound. */
  truncated: boolean;
};
