/**
 * MAVERO CloudStream code-owned adapter registry (CS-1).
 *
 * Plan §6.3 / §40.3 (decision D-007): adapters are CODE-OWNED. This registry
 * maps a CloudStream `internalName` to its Mavero-native adapter. There is
 * deliberately NO DB-configurable adapter execution — a remote repository
 * can never install executable code into Mavero.
 *
 * CS-1 STATUS: the registry is INTENTIONALLY EMPTY. No CloudStream provider
 * has been ported yet — that is CS-2's job (plan §17/§25). The CS-1 lookup
 * therefore classifies every discovered extension as `adapter_required`
 * (or `unsupported`/`broken` when the plugin self-reports DOWN/BROKEN),
 * which is the honest state: metadata discovery is NOT runtime compatibility
 * (plan §18 — Adapter Lifecycle).
 *
 * CS-2 will extend the ADAPTERS map with the first ported providers; the
 * `deriveAdapterStatus` classification below then automatically starts
 * reporting `compatible` for those internal names.
 */

import type { CloudStreamAdapterStatus } from '../types';

/** Adapter metadata exposed by the registry (CS-2 will add instances). */
export type RegisteredCloudStreamAdapter = {
  /** Matches cloudstream_extensions.internal_name (case-insensitive). */
  id: string;
  /** Mavero adapter version (separate from the plugin version — plan §18). */
  version: string;
};

/**
 * Code-owned registry: internalName (lowercase) -> adapter metadata.
 * EMPTY in CS-1 by design.
 */
const ADAPTERS: ReadonlyMap<string, RegisteredCloudStreamAdapter> = new Map<string, RegisteredCloudStreamAdapter>([]);

/** Case-insensitive lookup of a registered adapter for an internalName. */
export function lookupCloudStreamAdapter(internalName: string): RegisteredCloudStreamAdapter | null {
  if (typeof internalName !== 'string' || internalName.length === 0) return null;
  return ADAPTERS.get(internalName.trim().toLowerCase()) ?? null;
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
 * Never claims compatibility merely because metadata parsed.
 */
export function deriveAdapterStatus(internalName: string, pluginStatus: number | null): CloudStreamAdapterStatus {
  if (pluginStatus === 3) return 'broken';
  if (pluginStatus === 2) return 'unsupported';
  if (lookupCloudStreamAdapter(internalName) !== null) return 'compatible';
  return 'adapter_required';
}
