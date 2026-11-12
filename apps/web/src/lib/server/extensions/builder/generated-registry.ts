/**
 * MAVERO — GENERATED permanent adapter registry (Permanent Adapter Plan
 * Phase 3 — plan §9/§16/D-P3-8).
 *
 * Binds READY Builder artifacts (persisted immutable rows) to executable
 * MaveroCloudStreamAdapter instances THROUGH the shared DSL interpreter —
 * a generated adapter behaves exactly like a native port inside the SAME
 * security model (bounded spec, SSRF-guarded context, deadline discipline).
 *
 * PRECEDENCE (plan §16): the NATIVE code registry always wins. This module
 * is consulted ONLY when the native registry has no binding for a row; the
 * Downloader 2 selection composes both through executableAdapterForExtension.
 *
 * INTEGRITY: every artifact row is re-validated (schema + sha256 over the
 * canonical serialization) BEFORE an adapter instance is produced; a
 * mismatched or malformed artifact yields null (honest — the row is never
 * executable through tampered data). Persisted rows are IMMUTABLE, so the
 * instance cache is keyed by (canonical key, adapter version) with a small
 * bounded TTL purely for memory hygiene.
 *
 * NO Builder access: this module reads ONLY persisted artifacts. The
 * Downloader 2 path resolves generated adapters from the DATABASE — the
 * external Builder is never contacted at resolution time (plan §3).
 */

import type { MaveroCloudStreamAdapter } from '$lib/server/cloudstream/types/runtime';
import {
  validateAdapterArtifact,
  type PermanentAdapterArtifact,
} from '$lib/shared/adapter-artifact';
import { verifyArtifactIntegrity } from './artifact-hash';
import { resolveMovieWithSpec, resolveEpisodeWithSpec } from './dsl-interpreter';

// ---------------------------------------------------------------------------
// Persisted artifact row (the migration's table shape — joined in code)
// ---------------------------------------------------------------------------

/** The immutable artifact row projection the catalog loader selects. */
export type GeneratedAdapterArtifactRow = {
  canonical_key: string;
  integration_type: string;
  provider_id: string;
  adapter_version: number;
  strategy: string;
  artifact: PermanentAdapterArtifact;
  artifact_hash: string;
};

// ---------------------------------------------------------------------------
// Bounded instance cache (immutable entries; TTL for hygiene only)
// ---------------------------------------------------------------------------

const CACHE_MAX_ENTRIES = 64;
const CACHE_TTL_MS = 5 * 60_000;

type CacheEntry = {
  adapter: MaveroCloudStreamAdapter | null;
  at: number;
};

const instanceCache = new Map<string, CacheEntry>();

// ---------------------------------------------------------------------------
// Artifact → adapter instance
// ---------------------------------------------------------------------------

/** Cache key for one immutable artifact version. */
function cacheKey(canonicalKey: string, adapterVersion: number): string {
  return `${canonicalKey}@${adapterVersion}`;
}

/**
 * Produces the executable adapter instance for one persisted artifact row
 * (or null when the row fails validation — never a partially-trusted
 * adapter). The instance is a thin closure over the shared interpreter:
 * all network I/O still flows through the per-resolution runtime context
 * the resolver creates (SSRF-guarded, deadline-bound).
 */
export function generatedAdapterFromArtifactRow(row: GeneratedAdapterArtifactRow): MaveroCloudStreamAdapter | null {
  const key = cacheKey(row.canonical_key, row.adapter_version);
  const now = Date.now();
  const cached = instanceCache.get(key);
  if (cached !== undefined && now - cached.at < CACHE_TTL_MS) {
    return cached.adapter;
  }

  const adapter = buildAdapterInstance(row);
  // Bounded insertion (oldest-evicted).
  if (instanceCache.size >= CACHE_MAX_ENTRIES) {
    const oldest = instanceCache.keys().next().value;
    if (oldest !== undefined) instanceCache.delete(oldest);
  }
  instanceCache.set(key, { adapter, at: now });
  return adapter;
}

/** Validation + instance construction (uncached path). */
function buildAdapterInstance(row: GeneratedAdapterArtifactRow): MaveroCloudStreamAdapter | null {
  // Identity coherence: the row's identity fields must match the artifact.
  if (row.artifact === null || typeof row.artifact !== 'object') return null;
  if (row.artifact.adapterId !== row.canonical_key) return null;
  if (row.artifact.adapterVersion !== row.adapter_version) return null;
  if (row.artifact.providerId !== row.provider_id) return null;
  if (row.artifact.strategy !== 'declarative') return null;

  // Schema re-validation (bounds + closed vocabularies — never trust the DB).
  const issues = validateAdapterArtifact(row.artifact);
  if (issues.length > 0) return null;

  // Integrity: sha256 over the canonical serialization must match the
  // persisted hash (tampered artifacts are refused BEFORE interpretation).
  if (!verifyArtifactIntegrity(row.artifact, row.artifact_hash)) return null;

  const artifact = row.artifact;
  // IDENTITY SEPARATION (§16): the generated instance's resolver id is the
  // CANONICAL KEY (e.g. 'nuvio:moviesdrive') — NEVER the bare provider id,
  // which could collide with a native cloudstream adapter of the same name
  // (native MoviesDrive vs generated nuvio MoviesDrive). Canonical keys are
  // integration-type-prefixed, so collisions are structurally impossible
  // and the native precedence needs no shadowing logic.
  const adapterId = artifact.adapterId;
  const displayName = artifact.providerName ?? artifact.providerId;
  const meta = {
    adapterId,
    displayName,
    sourceName: artifact.spec.output.sourceName,
  };

  const supportsMovie = artifact.mediaTypes.includes('movie');
  const supportsTv = artifact.mediaTypes.includes('tv');

  const adapter: MaveroCloudStreamAdapter = {
    id: adapterId,
    version: `generated-v${artifact.adapterVersion}`,
    displayName,
    language: artifact.language,
    supports: { movie: supportsMovie, series: supportsTv, anime: false },
    resolveMovie: (req, ctx) => resolveMovieWithSpec(artifact.spec, req, ctx, meta),
    ...(artifact.spec.episode !== undefined
      ? { resolveEpisode: (req, ctx) => resolveEpisodeWithSpec(artifact.spec, req, ctx, meta) }
      : {}),
  };
  return adapter;
}

/**
 * Builds the canonical-key → instance map over loaded artifact rows (the
 * Downloader 2 selection input). Rows that fail validation are skipped
 * (honest — the corresponding rows stay non-executable).
 *
 * DETERMINISM (Phase 5, Session 13): when more than one version of a
 * canonical key is supplied, the HIGHEST adapter_version binds — a fixed,
 * order-independent tie-break (the pre-fix first-wins binding depended on
 * caller row order, which is not guaranteed by any DB select). The catalog
 * loader supplies exactly the ACTIVE version per key (it filters by the
 * extension row's generated_adapter_version pointer, so rollback and
 * re-promotion are respected); the highest-version tie-break is pure
 * defense-in-depth so this function can never bind nondeterministically.
 */
export function buildGeneratedAdapterMap(
  rows: readonly GeneratedAdapterArtifactRow[],
): Map<string, MaveroCloudStreamAdapter> {
  const map = new Map<string, MaveroCloudStreamAdapter>();
  const bestVersion = new Map<string, number>();
  for (const row of rows) {
    const adapter = generatedAdapterFromArtifactRow(row);
    if (adapter === null) continue;
    const seenVersion = bestVersion.get(row.canonical_key);
    if (seenVersion === undefined || row.adapter_version > seenVersion) {
      bestVersion.set(row.canonical_key, row.adapter_version);
      map.set(row.canonical_key, adapter);
    }
  }
  return map;
}

/** Test hook: clears the instance cache (deterministic test isolation). */
export function clearGeneratedAdapterCache(): void {
  instanceCache.clear();
}
