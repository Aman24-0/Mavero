import assert from 'node:assert/strict';
import {
  applyPositionMove,
  validateRepositionSet,
  repositionDraftFromEntries,
  repositionDraftIsDirty,
} from '$lib/shared/bulk-reposition';

// Admin reposition — MOVE semantics for the dense 1..N list
// (category-source positions). 2026-11-17 regression suite.
//
// Reported bug: "category me reposition kar raha hun to new position apply
// nahi ho raha." Root cause pinned here: the dense contract requires the
// WHOLE set to be a distinct permutation of 1..N, so a single-row edit
// collided with the row already holding that position, the live validation
// reported a duplicate, the Apply button stayed disabled, and — because the
// hidden `ordered_source_ids` are only rendered for a VALID set — the form
// submitted nothing at all (verified: zero `rpc/reorder_category_sources`
// calls in the project's API logs).
//
// These tests pin BOTH halves of the fix:
//   1. `applyPositionMove` turns one keystroke into a complete, dense,
//      distinct permutation (insert-and-shift), so Apply is enabled at once.
//   2. The composed flow (move → validate) yields exactly the payload the
//      server action/RPC consumes.

const NAMES = ['Plutonium', 'Vanadium', 'Zirconium', 'Mercury', 'Neon', 'Copper', 'Tungsten', 'Cobalt', 'Vidly'];
const entries = NAMES.map((name, index) => ({ id: name, savedPosition: index + 1 }));
const dense = { maxPosition: entries.length };

function orderOf(drafts: Record<string, string>): string[] {
  return validateRepositionSet(entries, drafts, dense).orderedIds;
}

function draftsWith(overrides: Record<string, string>): Record<string, string> {
  return { ...repositionDraftFromEntries(entries), ...overrides };
}

// --- Baseline: the OLD behaviour (raw assignment) is what failed ---

{
  // A single edit typed straight into the draft map — exactly what the
  // pre-fix `oninput` handler did.
  const naive = draftsWith({ Tungsten: '1' });
  const validation = validateRepositionSet(entries, naive, dense);
  assert.equal(validation.valid, false, 'baseline: a single raw edit is INVALID (the reported bug)');
  assert.match(String(validation.setError), /Duplicate position: 1/, 'baseline: duplicate position is the blocker');
  assert.deepEqual(validation.orderedIds, [], 'baseline: no ordered ids → hidden payload empty → server gets nothing');
}

// --- Test 1: move UP (7 → 1) with one keystroke ---

{
  const moved = applyPositionMove(entries, repositionDraftFromEntries(entries), 'Tungsten', '1');
  assert.deepEqual(orderOf(moved), ['Tungsten', 'Plutonium', 'Vanadium', 'Zirconium', 'Mercury', 'Neon', 'Copper', 'Cobalt', 'Vidly'], 'test 1: Tungsten moves to the top, others shift down');
  assert.deepEqual(
    Object.fromEntries(NAMES.map((name) => [name, moved[name]])),
    { Tungsten: '1', Plutonium: '2', Vanadium: '3', Zirconium: '4', Mercury: '5', Neon: '6', Copper: '7', Cobalt: '8', Vidly: '9' },
    'test 1: the whole set stays a dense 1..N permutation',
  );
  const validation = validateRepositionSet(entries, moved, dense);
  assert.equal(validation.valid, true, 'test 1: the set is valid → Apply enabled immediately');
  assert.equal(validation.orderedIds.length, entries.length, 'test 1: the payload is complete');
}

// --- Test 2: move DOWN (1 → 3) with one keystroke ---

{
  const moved = applyPositionMove(entries, repositionDraftFromEntries(entries), 'Plutonium', '3');
  assert.deepEqual(orderOf(moved), ['Vanadium', 'Zirconium', 'Plutonium', 'Mercury', 'Neon', 'Copper', 'Tungsten', 'Cobalt', 'Vidly'], 'test 2: Plutonium lands third, the two rows above shift up');
  assert.equal(moved.Plutonium, '3');
  assert.equal(moved.Vanadium, '1');
  assert.equal(moved.Zirconium, '2');
  assert.equal(validateRepositionSet(entries, moved, dense).valid, true, 'test 2: valid set');
}

// --- Test 3: move to the SAME position is a no-op (not dirty) ---

{
  const moved = applyPositionMove(entries, repositionDraftFromEntries(entries), 'Mercury', '4');
  assert.deepEqual(moved, repositionDraftFromEntries(entries), 'test 3: identical drafts');
  assert.equal(repositionDraftIsDirty(entries, moved), false, 'test 3: Apply stays disabled (nothing changed)');
}

// --- Test 4: move to the LAST position ---

{
  const moved = applyPositionMove(entries, repositionDraftFromEntries(entries), 'Plutonium', '9');
  assert.deepEqual(orderOf(moved), ['Vanadium', 'Zirconium', 'Mercury', 'Neon', 'Copper', 'Tungsten', 'Cobalt', 'Vidly', 'Plutonium'], 'test 4: Plutonium moves to the end');
  assert.equal(moved.Plutonium, '9');
  assert.equal(moved.Vidly, '8');
}

// --- Test 5: unusable input is stored VERBATIM and nothing shifts ---

for (const [label, raw] of [
  ['blank', ''],
  ['zero', '0'],
  ['negative', '-2'],
  ['decimal', '1.5'],
  ['non-numeric', 'abc'],
  ['above the list length', '10'],
  ['whitespace', '   '],
] as const) {
  const moved = applyPositionMove(entries, repositionDraftFromEntries(entries), 'Tungsten', raw);
  assert.equal(moved.Tungsten, raw, `test 5 (${label}): the typed value is preserved verbatim, never clamped`);
  for (const name of NAMES.filter((name) => name !== 'Tungsten')) {
    assert.equal(moved[name], String(entries.find((entry) => entry.id === name)?.savedPosition), `test 5 (${label}): ${name} does not shift`);
  }
  const validation = validateRepositionSet(entries, moved, dense);
  assert.equal(validation.valid, false, `test 5 (${label}): validation surfaces the problem instead of silently fixing it`);
  assert.ok(validation.errors.Tungsten, `test 5 (${label}): the row carries an error message`);
}

// --- Test 6: chained moves stay dense and distinct (no drift) ---

{
  let drafts = repositionDraftFromEntries(entries);
  drafts = applyPositionMove(entries, drafts, 'Vidly', '1');
  drafts = applyPositionMove(entries, drafts, 'Plutonium', '5');
  drafts = applyPositionMove(entries, drafts, 'Neon', '9');
  const validation = validateRepositionSet(entries, drafts, dense);
  assert.equal(validation.valid, true, 'test 6: still valid after three moves');
  assert.deepEqual([...Object.values(drafts)].sort(), ['1', '2', '3', '4', '5', '6', '7', '8', '9'], 'test 6: still a dense 1..N permutation');
  assert.equal(validation.orderedIds.length, entries.length, 'test 6: payload complete');
  assert.deepEqual([...validation.orderedIds].sort(), [...NAMES].sort(), 'test 6: every row exactly once (the RPC completeness check)');
}

// --- Test 7: the exact 2026-11-17 report, end to end ---

{
  // Multi Audio as it stood in the DB: 9 sources, positions 1..9. The admin
  // wants Tungsten (7) first.
  const drafts = applyPositionMove(entries, repositionDraftFromEntries(entries), 'Tungsten', '1');
  const validation = validateRepositionSet(entries, drafts, dense);
  assert.equal(validation.valid, true, 'test 7: Apply is enabled after ONE keystroke');
  assert.equal(repositionDraftIsDirty(entries, drafts), true, 'test 7: the draft is dirty → Apply clickable');
  // This is what the form posts as repeated `ordered_source_ids` fields.
  assert.deepEqual(validation.orderedIds, ['Tungsten', 'Plutonium', 'Vanadium', 'Zirconium', 'Mercury', 'Neon', 'Copper', 'Cobalt', 'Vidly'], 'test 7: the posted order matches the intent');
}

// --- Test 8: unknown row id is ignored (never invents a row) ---

{
  const before = repositionDraftFromEntries(entries);
  const moved = applyPositionMove(entries, before, 'Not-A-Source', '2');
  assert.deepEqual(moved, { ...before, 'Not-A-Source': '2' }, 'test 8: unknown id only records its raw value, nothing shifts');
  assert.equal(validateRepositionSet(entries, moved, dense).valid, true, 'test 8: the known set stays valid');
}

console.log('admin_reposition_move_test: all assertions passed');
