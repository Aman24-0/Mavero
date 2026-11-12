/**
 * MAVERO permanent adapter artifact integrity digest (Permanent Adapter
 * Plan Phase 3 — plan §9).
 *
 * The sha256 digest over the artifact's CANONICAL JSON serialization.
 * Lives in the server-side builder domain (not $lib/shared) because it
 * needs node:crypto — the shared artifact module stays browser-safe.
 *
 * BOTH sides import THIS module:
 *   * Mavero recomputes the hash before persisting an artifact and before
 *     interpreting a persisted artifact (a mismatched hash is rejected
 *     before interpretation — integrity is enforced at read time too).
 *   * The Builder computes the hash when it assembles the artifact.
 *
 * Importable from the standalone Builder (adapter-builder/) via the repo
 * tsconfig path alias under tsx — no SvelteKit virtual modules here.
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import { canonicalJson, type PermanentAdapterArtifact } from '$lib/shared/adapter-artifact';

/** sha256 hex over the canonical serialization of the artifact. */
export function artifactIntegrityHash(artifact: PermanentAdapterArtifact): string {
  return createHash('sha256').update(canonicalJson(artifact)).digest('hex');
}

/** Constant-time equality of two hex digests (both must be 64-char hex). */
export function digestsEqual(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== 64 || b.length !== 64) {
    return false;
  }
  try {
    return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
  } catch {
    return false;
  }
}

/** Verifies an artifact against an expected integrity hash (constant-time). */
export function verifyArtifactIntegrity(
  artifact: PermanentAdapterArtifact,
  expectedHash: string,
): boolean {
  return digestsEqual(artifactIntegrityHash(artifact), expectedHash);
}
