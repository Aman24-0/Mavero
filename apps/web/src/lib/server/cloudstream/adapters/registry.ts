/**
 * MAVERO CloudStream code-owned adapter registry (CS-1 → CS-2).
 *
 * Plan §6.3 / §40.3 (decision D-007): adapters are CODE-OWNED. This registry
 * maps a CloudStream `internalName` to its Mavero-native adapter INSTANCE.
 * There is deliberately NO DB-configurable adapter execution — a remote
 * repository can never install executable code into Mavero.
 *
 * CS-2 STATUS: the registry now contains the FIRST REAL adapter ports
 * (Bollyflix, MoviesDrive, VegaMovies — source-verified ports, see AC-003
 * and plan §40.6). `deriveAdapterStatus` therefore reports `compatible`
 * for exactly those three internal names; every other discovered extension
 * honestly remains `adapter_required` (or `unsupported`/`broken` when the
 * plugin self-reports DOWN/BROKEN). Metadata discovery is NOT runtime
 * compatibility (plan §18 — Adapter Lifecycle): Moviesmod (CloudflareKiller
 * dependency) and CineStream (50+-provider aggregator) are verified NOT
 * portable and are deliberately absent from this registry.
 */

import type { CloudStreamAdapterStatus } from '../types';
import type { MaveroCloudStreamAdapter } from '../types/runtime';
import { bollyflixAdapter } from './bollyflix';
import { moviesdriveAdapter } from './moviesdrive';
import { vegamoviesAdapter } from './vegamovies';

/** Adapter metadata exposed by the registry (CS-1 surface, unchanged shape). */
export type RegisteredCloudStreamAdapter = {
  /** Matches cloudstream_extensions.internal_name (case-insensitive). */
  id: string;
  /** Mavero adapter version (separate from the plugin version — plan §18). */
  version: string;
};

/**
 * Code-owned registry: internalName (lowercase) -> adapter INSTANCE.
 * Filled in CS-2 with the three source-verified provider ports (AC-003).
 */
const ADAPTER_INSTANCES: readonly MaveroCloudStreamAdapter[] = [
  bollyflixAdapter,
  moviesdriveAdapter,
  vegamoviesAdapter,
];

/** Lowercase lookup map (single source of truth for identity matching). */
const ADAPTERS: ReadonlyMap<string, MaveroCloudStreamAdapter> = new Map<string, MaveroCloudStreamAdapter>(
  ADAPTER_INSTANCES.map((adapter) => [adapter.id.toLowerCase(), adapter] as const),
);

/** Case-insensitive lookup of a registered adapter INSTANCE (CS-2 runtime). */
export function lookupCloudStreamAdapterInstance(internalName: string): MaveroCloudStreamAdapter | null {
  if (typeof internalName !== 'string' || internalName.length === 0) return null;
  return ADAPTERS.get(internalName.trim().toLowerCase()) ?? null;
}

/** Case-insensitive metadata lookup (CS-1 admin surface, unchanged shape). */
export function lookupCloudStreamAdapter(internalName: string): RegisteredCloudStreamAdapter | null {
  const instance = lookupCloudStreamAdapterInstance(internalName);
  if (instance === null) return null;
  return { id: instance.id, version: instance.version };
}

/** All registered adapter instances (read-only view for tests/diagnostics). */
export function listCloudStreamAdapters(): readonly MaveroCloudStreamAdapter[] {
  return ADAPTER_INSTANCES;
}

/**
 * Derives the persisted `adapter_status` for a discovered extension.
 *
 * Precedence (most specific first):
 *   1. plugin self-reports BROKEN (3) → 'broken'
 *   2. plugin self-reports DOWN (2)   → 'unsupported'
 *   3. a Mavero adapter is registered → 'compatible'
 *   4. otherwise                      → 'adapter_required'
 *
 * Never claims compatibility merely because metadata parsed. When a Mavero
 * adapter IS registered, compatibility is real: the adapter is a verified
 * port of this provider's actual logic (CS-2, AC-003).
 */
export function deriveAdapterStatus(internalName: string, pluginStatus: number | null): CloudStreamAdapterStatus {
  if (pluginStatus === 3) return 'broken';
  if (pluginStatus === 2) return 'unsupported';
  if (lookupCloudStreamAdapter(internalName) !== null) return 'compatible';
  return 'adapter_required';
}
