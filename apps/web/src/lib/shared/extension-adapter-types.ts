/**
 * MAVERO unified Extension/adapter type contracts (Permanent Adapter Plan
 * Phase 2).
 *
 * Pure TYPE definitions shared between the unified extension server domain
 * (`src/lib/server/extensions/**`, `src/lib/server/cloudstream/**`) and the
 * admin Integrations UI (Extension tab). Mirrors the `cloudstream-types`
 * convention: server services produce these views; admin components consume
 * them. NO runtime code lives here — importing this module is safe on both
 * the server and the client.
 *
 * SCOPE (Phase 2 ONLY — architecture/registration/readiness):
 *   * The Extension catalog is UNIFIED: one catalog, two integration types
 *     (CloudStream + Nuvio), managed from the SAME Integrations → Extension
 *     tab. Nuvio never gets its own navigation or management system.
 *   * The adapter lifecycle states exist in the MODEL; the Phase 3 Builder
 *     does NOT exist yet, so no row is ever 'building'/'testing'/'generated'
 *     in Phase 2 and nothing pretends an adapter was generated.
 *
 * SECURITY: these models carry catalog METADATA only. Nuvio provider JS
 * module URLs (`moduleUrl`) are inert metadata — never fetched, never
 * executed (the same rule as CloudStream `.cs3` plugin URLs).
 */

// ---------------------------------------------------------------------------
// Integration identity
// ---------------------------------------------------------------------------

/**
 * The integration type of an Extension catalog row.
 * 'cloudstream' — CS.json repository (pluginLists → plugins.json)
 * 'nuvio'       — Nuvio manifest (scrapers[] provider list)
 */
export type ExtensionIntegrationType = 'cloudstream' | 'nuvio';

// ---------------------------------------------------------------------------
// Permanent adapter lifecycle (plan §4)
// ---------------------------------------------------------------------------

/**
 * PERSISTED adapter lifecycle state (the registry snapshot on the
 * extension row).
 *
 *   native           — a code-owned Mavero adapter is bound (cloudstream
 *                      rows only; Bollyflix/MoviesDrive/VegaMovies today)
 *   generated        — a Builder-generated permanent adapter exists
 *                      (Phase 3+; NOTHING sets this in Phase 2)
 *   adapter_required — no adapter yet (the honest default)
 *   runtime_required — not convertible; needs the native CloudStream
 *                      runtime (plugin self-reports DOWN/BROKEN, or a
 *                      future analyzer verdict)
 *   failed           — adapter generation attempted and failed (Phase 3+)
 *   building/testing — Phase 3 Builder build phases (reserved vocabulary;
 *                      NOTHING sets these in Phase 2)
 */
export type PermanentAdapterState =
  | 'native'
  | 'generated'
  | 'adapter_required'
  | 'runtime_required'
  | 'failed'
  | 'building'
  | 'testing';

/**
 * DERIVED operational state for display (never persisted — computed from
 * `enabled` at view time, the CS-1 no-dual-source-state convention):
 *
 *   active   — adapter present (native/generated) AND the row is enabled
 *              (participates in Downloader 2 resolution)
 *   disabled — adapter present AND the row is disabled
 *
 * All other states surface the persisted lifecycle state verbatim.
 */
export type AdapterOperationalState = PermanentAdapterState | 'active' | 'disabled';

/** Canonical media vocabulary for the unified registry ('movie' | 'tv'). */
export type ExtensionMediaType = 'movie' | 'tv';
