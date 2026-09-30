// Pure position-conflict-resolution helper for cross-device progress sync.
//
// This is the CANONICAL ordering used by BOTH:
//   - the client-side mergeProgress() (src/lib/shared/progress-merge.ts)
//   - the server-side compare-and-swap in /api/account/sync PUT
//
// Having ONE shared, pure, testable helper guarantees the client and
// server agree on which record's playback position wins. The previous
// implementation had the client correctly using positionUpdatedAt +
// currentTime tiebreak, but the server only checked `<` (strictly
// less-than) — equal timestamps fell through to a blind upsert, which
// let a stale lower-position record overwrite a real higher-position
// record when both had the same positionUpdatedAt.
//
// Ordering (deterministic):
//   1. Higher positionUpdatedAt wins.
//   2. If positionUpdatedAt is equal, higher currentTime wins.
//   3. If both are equal, the EXISTING (cloud) record wins (preserve
//      existing position — never regress).
//
// Backward compatibility:
//   - When BOTH sides have positionUpdatedAt = 0 (both are pre-migration
//     records), the helper returns 'backward-compat' so the caller can
//     fall back to the old updatedAt-based behavior.
//   - When ONE side has positionUpdatedAt > 0 and the other has 0
//     (mixed: new-client record vs pre-migration record), the side with
//     positionUpdatedAt > 0 WINS. A 0 value means "unknown / very old" —
//     the side with a real timestamp is authoritative. This prevents a
//     stale pre-migration record from winning over a fresh new-client
//     record just because the pre-migration record has a newer updatedAt
//     (from a runtime-only flush that the old client couldn't distinguish).

export type PositionConflictResult =
  | 'incoming-wins'
  | 'existing-wins'
  | 'backward-compat';

/**
 * Determine which record's playback position wins a cross-device conflict.
 *
 * @param incomingPosTs  - the incoming record's positionUpdatedAt (0 if unknown)
 * @param existingPosTs  - the existing (cloud) record's positionUpdatedAt (0 if unknown)
 * @param incomingCurrentTime - the incoming record's currentTime
 * @param existingCurrentTime - the existing record's currentTime
 * @returns 'incoming-wins' | 'existing-wins' | 'backward-compat'
 *
 * When the result is 'backward-compat', the caller should fall back to
 * the old behavior (blind upsert / updatedAt comparison) for
 * pre-migration records.
 *
 * Mixed-case handling: when ONE side has positionUpdatedAt > 0 and the
 * other has 0 (pre-migration record mixed with a new record), the side
 * with positionUpdatedAt > 0 WINS. A 0 value means "unknown / very old"
 * — the side with a real timestamp is authoritative. This prevents a
 * stale pre-migration record from winning over a fresh new-client record
 * just because the pre-migration record has a newer updatedAt (from a
 * runtime-only flush that the old client couldn't distinguish).
 */
export function resolvePositionConflict(
  incomingPosTs: number,
  existingPosTs: number,
  incomingCurrentTime: number,
  existingCurrentTime: number,
): PositionConflictResult {
  // Full backward compat: BOTH sides have positionUpdatedAt = 0
  // (both are pre-migration records). Fall back to the old behavior.
  if (incomingPosTs === 0 && existingPosTs === 0) {
    return 'backward-compat';
  }

  // Mixed case: one side has positionUpdatedAt > 0, the other has 0.
  // The side with positionUpdatedAt > 0 wins (0 = unknown/very old).
  if (incomingPosTs > 0 && existingPosTs === 0) return 'incoming-wins';
  if (existingPosTs > 0 && incomingPosTs === 0) return 'existing-wins';

  // Both sides have positionUpdatedAt > 0 — normal conflict resolution.
  // 1. Higher positionUpdatedAt wins.
  if (incomingPosTs > existingPosTs) return 'incoming-wins';
  if (incomingPosTs < existingPosTs) return 'existing-wins';

  // 2. Equal positionUpdatedAt → higher currentTime wins.
  if (incomingCurrentTime > existingCurrentTime) return 'incoming-wins';
  if (incomingCurrentTime < existingCurrentTime) return 'existing-wins';

  // 3. Exact tie on both positionUpdatedAt AND currentTime → preserve
  // existing (cloud) position. Never regress.
  return 'existing-wins';
}
