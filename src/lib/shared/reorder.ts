/**
 * Task 13: shared 1-based position/reorder list helpers.
 *
 * Used by the admin category-sources reorder mode, the absolute addon
 * position workflow and the server-side services that persist them, so
 * the "move item to position N, shift everything else" semantics are
 * implemented exactly ONCE.
 *
 * All functions are pure — they never mutate their input. Positions are
 * 1-BASED in the UI/contract; database ordering stays 0-based where the
 * existing architecture already uses that convention.
 */

/** Clamps a 1-based position into 1..count (defensive; callers validate strictly). */
export function clampPosition(position: number, count: number): number {
  const safeCount = Math.max(count, 1);
  if (!Number.isFinite(position)) return 1;
  return Math.min(Math.max(Math.round(position), 1), safeCount);
}

/**
 * Moves the item at `fromIndex` to the 1-based `targetPosition`, shifting
 * every item in between by exactly one. Returns a NEW list.
 *
 *   A B C D E — move E to position 1 → E A B C D
 *   A B C D E — move A to position 5 → B C D E A
 *   A B C D E — move C to position 2 → A C B D E
 */
export function moveItemToPosition<T>(items: readonly T[], fromIndex: number, targetPosition: number): T[] {
  const list = [...items];
  if (fromIndex < 0 || fromIndex >= list.length) return list;
  const to = clampPosition(targetPosition, list.length) - 1;
  if (to === fromIndex) return list;
  const [moved] = list.splice(fromIndex, 1);
  list.splice(to, 0, moved);
  return list;
}

/**
 * Applies a set of 1-based position edits to an ordered id list.
 *
 * Each edit moves ONE item to its target position; items without an edit
 * keep their relative order and shift automatically. When several items
 * are edited at once the moves are applied deterministically in the
 * CURRENT rank order of the edited items, so a single edit produces
 * exactly the "move to position, shift the rest" result:
 *
 *   [A, B, C, D] + { D → 1 } → [D, A, B, C]
 *   [A, B, C, D] + { A → 4 } → [B, C, D, A]
 *   [A, B, C, D] + { C → 2 } → [A, C, B, D]
 *
 * The result is always a permutation of the input — duplicates can never
 * be created. Edits referencing unknown ids are ignored (defensive; the
 * server validates membership separately).
 */
export function applyPositionEdits(currentOrder: readonly string[], edits: ReadonlyArray<{ sourceId: string; position: number }>): string[] {
  const order = [...currentOrder];
  const targets = new Map(edits.map((edit) => [edit.sourceId, edit.position]));
  // Iterate the ORIGINAL order so multi-edit semantics are deterministic.
  for (const sourceId of currentOrder) {
    const target = targets.get(sourceId);
    if (target === undefined) continue;
    const from = order.indexOf(sourceId);
    if (from === -1) continue;
    const to = clampPosition(target, order.length) - 1;
    if (to === from) continue;
    order.splice(from, 1);
    order.splice(to, 0, sourceId);
  }
  return order;
}
