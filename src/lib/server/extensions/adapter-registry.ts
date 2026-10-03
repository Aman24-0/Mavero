/**
 * MAVERO unified PERMANENT ADAPTER REGISTRY (Permanent Adapter Plan Phase 2).
 *
 * One registry face over the two adapter sources that exist today and the
 * ones Phase 3 will add, WITHOUT creating a second resolver system:
 *
 *   ┌────────────────────────────────────────────────────────────────┐
 *   │ cloudstream_extensions row (the unified Extension catalog)     │
 *   │   integration_type: 'cloudstream' | 'nuvio'                    │
 *   │   adapter_state: native|generated|adapter_required|            │
 *   │                  runtime_required|failed|building|testing      │
 *   │   canonical key = `${integration_type}:${provider key}`        │
 *   └────────────────────────────────────────────────────────────────┘
 *        │                                    │
 *        ▼ code-owned instances               ▼ future Builder output
 *   lookupCloudStreamAdapterInstance      (Phase 3 — NOT implemented;
 *   (native, executable TODAY)             stays honestly non-executable)
 *
 * ARCHITECTURE (plan §4 + Phase 2 scope rules):
 *   * Canonical identity: `${type}:${lowercased provider key}` — the same
 *     provider never registers twice at resolution level; the same
 *     provider in MULTIPLE repositories stays multiple distinguishable
 *     catalog rows (repository-level identity) with ONE canonical key.
 *   * Native binding is TYPE-AWARE: ONLY cloudstream rows can bind a
 *     code-owned adapter. A Nuvio row whose provider id collides with a
 *     native adapter id (e.g. 'MoviesDrive' exists in both ecosystems)
 *     does NOT ride the CloudStream adapter — it stays adapter_required
 *     until a Nuvio adapter exists.
 *   * Phase 2 does NOT implement the Builder: the lifecycle state machine
 *     models CREATE_ADAPTER → BUILDING → TESTING → READY/FAILED, but
 *     every Builder transition REFUSES with BUILDER_UNAVAILABLE. No
 *     Render/Oracle call exists anywhere; nothing pretends an adapter
 *     was generated.
 *   * Execution readiness: only 'native' rows with a bound instance are
 *     executable today. 'generated' is representable but never executable
 *     in Phase 2 (no generation path exists — the honest refusal).
 *
 * SECURITY: this module never fetches anything and never executes remote
 * code. Nuvio module_url / CloudStream plugin_url stay inert metadata.
 */

import type { MaveroCloudStreamAdapter } from '$lib/server/cloudstream/types/runtime';
import { lookupCloudStreamAdapterInstance } from '$lib/server/cloudstream/adapters/registry';
import { canonicalMediaTypeFromTvType } from './nuvio';
import type {
  AdapterOperationalState,
  ExtensionIntegrationType,
  ExtensionMediaType,
  PermanentAdapterState,
} from '$lib/shared/extension-adapter-types';

// ---------------------------------------------------------------------------
// Canonical identity
// ---------------------------------------------------------------------------

/**
 * Deterministic canonical adapter identity for one extension row:
 * `${integration_type}:${lowercased provider key}` (e.g.
 * 'cloudstream:bollyflix', 'nuvio:moviesdrive'). Pure function — stable,
 * collision-free across integration types, and derivable from any row.
 */
export function canonicalAdapterKey(integrationType: ExtensionIntegrationType, providerKey: string): string {
  const normalized = providerKey.trim().toLowerCase();
  return `${integrationType}:${normalized}`;
}

/** The canonical key for a catalog row (internal_name / scraper id). */
export function canonicalAdapterKeyForRow(row: {
  integration_type: string;
  internal_name: string;
}): string {
  const type: ExtensionIntegrationType = row.integration_type === 'nuvio' ? 'nuvio' : 'cloudstream';
  return canonicalAdapterKey(type, row.internal_name);
}

// ---------------------------------------------------------------------------
// Type-aware adapter binding (the eligibility core)
// ---------------------------------------------------------------------------

/** Minimal row shape the registry reasons over (both catalog services satisfy it). */
export type ExtensionRegistryRow = {
  integration_type: string;
  internal_name: string;
};

/**
 * The EXECUTABLE adapter for one extension row, or null.
 *
 * Phase 2 truth table:
 *   cloudstream row + code-registered internalName → the native instance
 *   nuvio row (any id, even one colliding with a native adapter)  → null
 *   generated state (Phase 3+ writes)                              → null
 *   anything else                                                  → null
 *
 * Defensive normalization: any integration_type that is not explicitly
 * 'nuvio' is treated as 'cloudstream' (the column default) — a not-yet-
 * migrated row behaves exactly like the pre-Phase-2 catalog.
 *
 * This is the single place the Downloader 2 eligibility asks "can this row
 * execute a Mavero adapter?" — one source of truth, no parallel logic.
 */
export function executableAdapterForExtension(row: ExtensionRegistryRow): MaveroCloudStreamAdapter | null {
  if (row.integration_type === 'nuvio') return null;
  return lookupCloudStreamAdapterInstance(row.internal_name);
}

/** True when the row's canonical identity is bound to an executable adapter. */
export function extensionHasExecutableAdapter(row: ExtensionRegistryRow): boolean {
  return executableAdapterForExtension(row) !== null;
}

// ---------------------------------------------------------------------------
// Adapter lifecycle state (persisted derivation + display projection)
// ---------------------------------------------------------------------------

/** The Phase 3 Builder states — present in the model, unreachable in Phase 2. */
const BUILDER_STATES: ReadonlySet<PermanentAdapterState> = new Set(['building', 'testing', 'generated']);

/**
 * Derives the PERSISTED lifecycle state for a catalog row at sync time
 * (the snapshot written by reconcileExtensions):
 *
 *   cloudstream + code adapter bound   → 'native'
 *   cloudstream + plugin DOWN (2)      → 'runtime_required' (not convertible now)
 *   cloudstream + plugin BROKEN (3)    → 'runtime_required'
 *   nuvio (always, in Phase 2)         → 'adapter_required'
 *   persisted Builder outcome          → respected for non-native rows
 *     ('generated'/'failed' — Phase 3+ writes; Phase 2 never sets them)
 *
 * Native binding is type-aware (see executableAdapterForExtension), so a
 * Nuvio provider whose id matches a native adapter still derives
 * adapter_required — the honest state until a Nuvio adapter exists.
 */
export function deriveAdapterState(
  row: ExtensionRegistryRow & { plugin_status: number | null },
  persistedState: string | null,
): PermanentAdapterState {
  // A live native binding always wins over a stale persisted snapshot
  // (the same live-re-derivation discipline the CS-1 adapter_status uses).
  if (extensionHasExecutableAdapter(row)) return 'native';
  if (row.integration_type === 'cloudstream') {
    if (row.plugin_status === 2 || row.plugin_status === 3) return 'runtime_required';
  }
  // Respect persisted Builder outcomes the code registry cannot override
  // (Phase 3+ writes 'generated'/'failed'; Phase 2 writes neither).
  if (persistedState === 'generated' || persistedState === 'failed') return persistedState;
  return 'adapter_required';
}

/**
 * DERIVED operational state for display (never persisted — the CS-1
 * no-dual-source convention):
 *
 *   native/generated + enabled → 'active'   (participates in resolution)
 *   native/generated + disabled → 'disabled'
 *   everything else             → the persisted lifecycle state verbatim
 */
export function deriveOperationalAdapterState(
  row: ExtensionRegistryRow & { plugin_status: number | null; enabled: boolean },
  persistedState: string,
): AdapterOperationalState {
  const lifecycle = deriveAdapterState(row, persistedState);
  if (lifecycle === 'native' || lifecycle === 'generated') {
    return row.enabled ? 'active' : 'disabled';
  }
  return lifecycle;
}

// ---------------------------------------------------------------------------
// Media-type projection (canonical vocabulary, single derivation site)
// ---------------------------------------------------------------------------

/**
 * Canonical media support for a catalog row:
 *   cloudstream → derived LIVE from tv_types (enum names → movie/tv)
 *   nuvio       → the stored media_types snapshot (supportedTypes-derived)
 * Empty result = no known media support (never eligible — honest).
 */
export function effectiveMediaTypes(
  row: { integration_type: string; tv_types?: string[] | null; media_types?: string[] | null },
): ExtensionMediaType[] {
  if (row.integration_type === 'nuvio') {
    const stored = row.media_types ?? [];
    const result: ExtensionMediaType[] = [];
    for (const value of stored) {
      if ((value === 'movie' || value === 'tv') && !result.includes(value)) result.push(value);
    }
    return result;
  }
  const tvTypes = row.tv_types ?? [];
  const result: ExtensionMediaType[] = [];
  for (const tvType of tvTypes) {
    const canonical = canonicalMediaTypeFromTvType(tvType);
    if (canonical !== null && !result.includes(canonical)) result.push(canonical);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Lifecycle state machine (Phase 3 entry points, Phase 2 honest refusal)
// ---------------------------------------------------------------------------

/** Closed error code for refused lifecycle transitions. */
export const ADAPTER_BUILDER_UNAVAILABLE = 'BUILDER_UNAVAILABLE';

/** Valid lifecycle transitions (plan §4). Builder transitions exist in the model. */
const LIFECYCLE_TRANSITIONS: Readonly<Record<PermanentAdapterState, readonly PermanentAdapterState[]>> = {
  adapter_required: ['building', 'runtime_required'],
  building: ['testing', 'failed'],
  testing: ['generated', 'failed'],
  generated: ['failed'],
  failed: ['building'],
  runtime_required: [],
  native: [],
};

export class AdapterLifecycleError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'AdapterLifecycleError';
    this.code = code;
  }
}

/**
 * Whether a lifecycle transition is structurally valid (the model only —
 * validity says NOTHING about executability).
 */
export function isValidLifecycleTransition(from: PermanentAdapterState, to: PermanentAdapterState): boolean {
  return LIFECYCLE_TRANSITIONS[from]?.includes(to) ?? false;
}

/**
 * Requests a CREATE_ADAPTER (Builder) transition — the Phase 3 entry point.
 *
 * PHASE 2 BEHAVIOR (deliberate, honest): the Builder does not exist, so
 * EVERY builder transition REFUSES with BUILDER_UNAVAILABLE. No
 * Render/Oracle service is contacted, no state is mutated, and no adapter
 * generation is pretended. The entry point exists so the architecture and
 * admin data contract are ready for Phase 3 without another schema change.
 */
export function requestCreateAdapterTransition(
  from: PermanentAdapterState,
): { ok: false; code: typeof ADAPTER_BUILDER_UNAVAILABLE; message: string } {
  if (!isValidLifecycleTransition(from, 'building')) {
    return {
      ok: false,
      code: ADAPTER_BUILDER_UNAVAILABLE,
      message: `Adapter generation is not available from the ${from} state.`,
    };
  }
  return {
    ok: false,
    code: ADAPTER_BUILDER_UNAVAILABLE,
    message: 'Adapter generation is not available yet. The permanent adapter Builder arrives in a later phase.',
  };
}

// ---------------------------------------------------------------------------
// Registry lookup (canonical identity over a loaded catalog)
// ---------------------------------------------------------------------------

/**
 * One resolved registry entry: the catalog row projected onto the unified
 * registry contract (plan §4 field list). Produced from already-loaded
 * rows — this module NEVER queries the database itself (the catalog
 * services own the reads; fakes stay trivial in tests).
 */
export type PermanentAdapterRegistryEntry = {
  /** Canonical registry identity ('cloudstream:moviesdrive' | 'nuvio:…'). */
  canonicalKey: string;
  /** The extension row id (extension/provider identity). */
  extensionId: string;
  /** Owning repository id (repository identity). */
  repositoryId: string;
  integrationType: ExtensionIntegrationType;
  /** The provider key (internal_name / scraper id). */
  providerKey: string;
  /** Display name. */
  name: string | null;
  /** Persisted lifecycle state. */
  adapterState: PermanentAdapterState;
  /** Derived operational state (active/disabled projection). */
  operationalState: AdapterOperationalState;
  /** Canonical media support. */
  mediaTypes: ExtensionMediaType[];
  /** Bound executable adapter instance (native only; null otherwise). */
  executable: MaveroCloudStreamAdapter | null;
  /** Executable + enabled + repository-enabled → participates in resolution. */
  eligible: boolean;
  enabled: boolean;
  repositoryEnabled: boolean;
  /** Mavero adapter id when bound (the registry's adapter id field). */
  maveroAdapterId: string | null;
  /** Mavero adapter version when bound. */
  adapterVersion: string | null;
  /** Validation facts (Phase 3+; null in Phase 2). */
  lastTestedAt: string | null;
  lastTestError: string | null;
  /** Provenance: source/repository URL recorded with the row. */
  sourceUrl: string | null;
};

/** Minimal catalog input (satisfied by both the admin view rows and the downloader selection rows). */
export type RegistryCatalogRow = ExtensionRegistryRow & {
  id: string;
  repository_id: string;
  name: string | null;
  plugin_status: number | null;
  enabled: boolean;
  adapter_state: string;
  media_types?: string[] | null;
  tv_types?: string[] | null;
  mavero_adapter_id: string | null;
  adapter_version: string | null;
  last_tested_at?: string | null;
  last_test_error?: string | null;
  source_url?: string | null;
};

/** Projects one catalog row into the unified registry entry. */
export function toRegistryEntry(row: RegistryCatalogRow, repositoryEnabled: boolean): PermanentAdapterRegistryEntry {
  const integrationType: ExtensionIntegrationType = row.integration_type === 'nuvio' ? 'nuvio' : 'cloudstream';
  const adapter = executableAdapterForExtension(row);
  const operational = deriveOperationalAdapterState(row, row.adapter_state);
  const bound = adapter !== null;
  return {
    canonicalKey: canonicalAdapterKey(integrationType, row.internal_name),
    extensionId: row.id,
    repositoryId: row.repository_id,
    integrationType,
    providerKey: row.internal_name,
    name: row.name,
    adapterState: deriveAdapterState(row, row.adapter_state),
    operationalState: operational,
    mediaTypes: effectiveMediaTypes(row),
    executable: adapter,
    // Eligibility = the CS-3 5-condition contract expressed through the
    // registry: executable binding AND row enabled AND repository enabled.
    eligible: bound && row.enabled && repositoryEnabled,
    enabled: row.enabled,
    repositoryEnabled,
    maveroAdapterId: bound ? adapter!.id : null,
    adapterVersion: bound ? adapter!.version : null,
    lastTestedAt: row.last_tested_at ?? null,
    lastTestError: row.last_test_error ?? null,
    sourceUrl: row.source_url ?? null,
  };
}

/**
 * Registry lookup by CANONICAL identity over loaded rows. Rows are keyed
 * by canonical key; when the same provider appears in multiple
 * repositories (multiple rows, one canonical key), the FIRST row in the
 * given order wins deterministically — the caller passes catalog order
 * (repository creation → internal_name) so the pick is stable.
 *
 * "The same provider is not accidentally registered multiple times": the
 * returned map contains each canonical key exactly once.
 */
export function buildRegistryIndex(
  rows: readonly RegistryCatalogRow[],
  enabledRepositoryIds: ReadonlySet<string>,
): Map<string, PermanentAdapterRegistryEntry> {
  const index = new Map<string, PermanentAdapterRegistryEntry>();
  for (const row of rows) {
    const entry = toRegistryEntry(row, enabledRepositoryIds.has(row.repository_id));
    if (!index.has(entry.canonicalKey)) index.set(entry.canonicalKey, entry);
  }
  return index;
}

/** Looks up one canonical key inside a pre-built registry index. */
export function lookupRegistryEntry(
  index: Map<string, PermanentAdapterRegistryEntry>,
  canonicalKey: string,
): PermanentAdapterRegistryEntry | null {
  return index.get(canonicalKey) ?? null;
}

/** Lists the canonical keys (sorted, for deterministic tests/diagnostics). */
export function listCanonicalKeys(index: Map<string, PermanentAdapterRegistryEntry>): string[] {
  return [...index.keys()].sort();
}

/** Whether a state is a Builder state (reserved for Phase 3). */
export function isBuilderState(state: PermanentAdapterState): boolean {
  return BUILDER_STATES.has(state);
}
