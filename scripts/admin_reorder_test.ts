import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  applyCategorySourcePositions,
  assignSourceToCategory,
  deleteSource,
  deleteSourceCategory,
  reorderCategorySources,
} from '../src/lib/server/streaming/admin-service.ts';
import { moveAddon, setAddonPosition } from '../src/lib/server/streaming/stremio/admin-addons.ts';
import { StreamingValidationError, parseCategoryReorderForm, parseSourceAssignmentForm } from '../src/lib/server/streaming/validation.ts';
import { applyPositionEdits, clampPosition, moveItemToPosition } from '../src/lib/shared/reorder.ts';

// Task 13 — CATEGORY REORDER + ADDON ABSOLUTE REORDER + DELETE RELIABILITY.
//
// Coverage (spec cases 14–38 plus regressions):
//   * shared/reorder.ts behavioral helpers (the move-to-position semantics)
//   * Migration RPC contracts (atomicity, validation, two-phase renumber)
//   * Mock-DB behavioral tests for the admin services — the mock ENFORCES
//     unique(category_id, ordering) after EVERY write, so any intermediate
//     constraint violation in the fallback renumber fails the test loudly
//   * Route/action security + parsing contracts
//   * Watch-route category-ordering contract (player renders the admin's
//     category-specific order)
//
// All tests are offline (no live Supabase).

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

const migration = read('supabase/migrations/20261007000000_source_badge_icon_reorder.sql');
const adminServiceSource = read('src/lib/server/streaming/admin-service.ts');
const categoriesServer = read('src/routes/admin/categories/+page.server.ts');
const categoriesPage = read('src/routes/admin/categories/+page.svelte');
const addonsServer = read('src/routes/admin/addons/+page.server.ts');
const addonsPage = read('src/routes/admin/addons/+page.svelte');
const watchPage = read('src/routes/watch/[type]/[id]/+page.svelte');
const shell = read('src/lib/components/player/PlayerShell.svelte');

const CAT1 = '11111111-1111-4111-8111-111111111111';
const CAT2 = '22222222-2222-4222-8222-222222222222';
const src = (n: string) => `${String(n).padEnd(8, '0').slice(0, 8)}-0000-4000-8000-${String(n).padEnd(12, '0').slice(0, 12)}`;
const A = src('a1');
const B = src('b2');
const C = src('c3');
const D = src('d4');
const E = src('e5');
const S = src('f6');

// ============================================================
// 1. Shared reorder helpers (spec move semantics)
// ============================================================
{
  const L = ['A', 'B', 'C', 'D', 'E'];
  // moveItemToPosition — insert at position, shift the rest.
  assert.deepEqual(moveItemToPosition(L, 4, 1), ['E', 'A', 'B', 'C', 'D'], 'E → position 1');
  assert.deepEqual(moveItemToPosition(L, 0, 5), ['B', 'C', 'D', 'E', 'A'], 'A → position 5');
  assert.deepEqual(moveItemToPosition(L, 2, 2), ['A', 'C', 'B', 'D', 'E'], 'C → position 2');
  assert.deepEqual(moveItemToPosition(L, 1, 99), ['A', 'C', 'D', 'E', 'B'], 'out-of-range target is clamped defensively');
  assert.deepEqual(moveItemToPosition(L, -1, 1), L, 'invalid fromIndex is a no-op');
  assert.deepEqual(moveItemToPosition([], 0, 1), [], 'empty list is safe');
  assert.deepEqual(L, ['A', 'B', 'C', 'D', 'E'], 'inputs are never mutated');

  // applyPositionEdits — the category reorder derivation.
  assert.deepEqual(applyPositionEdits(['A', 'B', 'C', 'D'], [{ sourceId: 'D', position: 1 }]), ['D', 'A', 'B', 'C'], 'case 14: D → 1 gives D A B C');
  assert.deepEqual(applyPositionEdits(['A', 'B', 'C', 'D'], [{ sourceId: 'A', position: 4 }]), ['B', 'C', 'D', 'A'], 'case 15: A → 4 gives B C D A');
  assert.deepEqual(applyPositionEdits(['A', 'B', 'C', 'D'], [{ sourceId: 'C', position: 2 }]), ['A', 'C', 'B', 'D'], 'case 16: C → 2 gives A C B D');
  assert.deepEqual(applyPositionEdits(['A', 'B', 'C', 'D'], [{ sourceId: 'A', position: 1 }]), ['A', 'B', 'C', 'D'], 'same position is a no-op');
  // Multi-edit: deterministic sequential moves in current-rank order.
  assert.deepEqual(applyPositionEdits(['A', 'B', 'C'], [{ sourceId: 'A', position: 3 }, { sourceId: 'C', position: 1 }]), ['C', 'B', 'A'], 'multi-edit is deterministic');
  // Unknown ids are ignored; the result is always a permutation.
  assert.deepEqual(applyPositionEdits(['A', 'B'], [{ sourceId: 'X', position: 1 }]), ['A', 'B'], 'unknown ids ignored');
  const result = applyPositionEdits(['A', 'B', 'C', 'D', 'E'], [{ sourceId: 'E', position: 2 }, { sourceId: 'A', position: 5 }]);
  assert.deepEqual([...result].sort(), ['A', 'B', 'C', 'D', 'E'], 'result is always a permutation (no duplicates, no loss)');

  // clampPosition
  assert.equal(clampPosition(0, 5), 1, 'below-range clamps to 1');
  assert.equal(clampPosition(9, 5), 5, 'above-range clamps to count');
  assert.equal(clampPosition(3, 5), 3, 'in-range is unchanged');
  assert.equal(clampPosition(Number.NaN, 5), 1, 'NaN clamps to 1');
}

// ============================================================
// 2. Migration RPC contracts
// ============================================================
{
  // reorder_category_sources: atomic, admin-gated, fully validated.
  assert.match(migration, /create or replace function public\.reorder_category_sources\(\s*p_category_id uuid,\s*p_ordered_source_ids uuid\[\]\s*\)/, 'category reorder RPC signature');
  assert.match(migration, /if not \(select public\.is_admin\(\)\) then\s+raise exception 'You are not authorized to change the streaming registry\.'/, 'category reorder RPC enforces admin');
  assert.match(migration, /for update[\s\S]{0,200}Category not found/, 'category row is locked FOR UPDATE (concurrency-safe)');
  assert.match(migration, /Duplicate sources are not allowed/, 'duplicates rejected');
  assert.match(migration, /The reorder must include every source assigned to this category exactly once/, 'full-set requirement');
  assert.match(migration, /The reorder includes sources that are not assigned to this category/, 'cross-category ids rejected');
  assert.match(migration, /v_parking_base[\s\S]*?greatest\(1000000/, 'parking base computed above every existing ordering');
  assert.match(migration, /set ordering = v_parking_base \+ \(ids\.ord - 1\)/, 'phase 1 parks on unique high values');
  assert.match(migration, /set ordering = ids\.ord - 1/, 'phase 2 writes the final dense 0..N-1 numbering');
  assert.match(migration, /revoke all on function public\.reorder_category_sources\(uuid, uuid\[\]\) from public, anon, authenticated;/, 'RPC revoked from public/anon');
  assert.match(migration, /grant execute on function public\.reorder_category_sources\(uuid, uuid\[\]\) to authenticated;/, 'RPC granted to authenticated admins');

  // set_addon_position: absolute position, range-validated, deterministic.
  assert.match(migration, /create or replace function public\.set_addon_position\(\s*p_addon_id uuid,\s*p_position integer\s*\)/, 'addon position RPC signature');
  assert.match(migration, /if not \(select public\.is_admin\(\)\) then\s+raise exception 'You are not authorized to change the addon registry\.'/, 'addon position RPC enforces admin');
  assert.match(migration, /pg_advisory_xact_lock\(hashtext\('mavero:streaming_addons:reorder'\)\)/, 'advisory lock serializes addon reorder operations');
  assert.match(migration, /if p_position is null or p_position < 1 or p_position > v_total then\s+raise exception 'Position must be between 1 and %\.', v_total/, 'out-of-range positions REJECTED (not clamped)');
  assert.match(migration, /row_number\(\) over \(order by ordering, name, created_at\)/, 'deterministic order matches the listing/resolver sort');
  assert.match(migration, /when ranked\.id = p_addon_id then p_position - 1/, 'moved addon lands at the requested 0-based position');
  assert.match(migration, /ranked\.old_rank - 1/, 'items between old and target shift down');
  assert.match(migration, /ranked\.old_rank \+ 1/, 'items between target and old shift up');
  assert.match(migration, /and addon\.ordering <> new_order\.new_rank/, 'only changed orderings are written');
  assert.match(migration, /grant execute on function public\.set_addon_position\(uuid, integer\) to authenticated;/, 'addon RPC granted to authenticated admins');
}

// ============================================================
// 3. Mock Supabase client
// ============================================================
type MockRow = Record<string, unknown>;
type WriteRecord = { table: string; kind: 'insert' | 'update' | 'delete' | 'rpc'; id?: string; patch?: Record<string, unknown>; rpc?: { name: string; args: Record<string, unknown> } };

type MockOptions = {
  /** What client.rpc(...) returns. Default: "function does not exist" (42883) → fallback path. */
  rpc?: { data?: unknown; error: null | { code?: string; message?: string } };
  /** Force a database error on the FIRST delete against a table (e.g. FK restrict). */
  failFirstDelete?: { table: string; code: string };
  /** Enforce unique(category_id, ordering) after EVERY write (per-statement safety). */
  enforceUnique?: boolean;
};

function createMockDb(initial: Partial<Record<'streaming_source_categories' | 'streaming_sources' | 'streaming_addons', MockRow[]>>, options: MockOptions = {}) {
  const state: Record<string, MockRow[]> = {
    streaming_source_categories: (initial.streaming_source_categories ?? []).map((row) => ({ ...row })),
    streaming_sources: (initial.streaming_sources ?? []).map((row) => ({ ...row })),
    streaming_addons: (initial.streaming_addons ?? []).map((row) => ({ ...row })),
  };
  const writes: WriteRecord[] = [];

  function assertUniqueCategoryOrdering(when: string) {
    if (!options.enforceUnique) return;
    const seen = new Map<string, Set<number>>();
    for (const row of state.streaming_source_categories) {
      const category = String(row.category_id);
      const ordering = Number(row.ordering);
      if (!seen.has(category)) seen.set(category, new Set());
      const set = seen.get(category)!;
      if (set.has(ordering)) throw new Error(`MOCK-UNIQUE-VIOLATION (${when}): duplicate (category_id, ordering) = (${category}, ${ordering})`);
      set.add(ordering);
    }
  }

  const client = {
    _state: state,
    _writes: writes,
    from(table: string) {
      const filters: Array<{ column: string; value: unknown }> = [];
      const orders: Array<{ column: string; ascending: boolean }> = [];
      let limitCount: number | null = null;
      let shaping: 'single' | 'maybeSingle' | null = null;
      let op: 'select' | 'insert' | 'update' | 'delete' = 'select';
      let payload: unknown = null;

      const currentRows = () => {
        let rows = [...state[table]];
        for (const filter of filters) rows = rows.filter((row) => row[filter.column] === filter.value);
        for (const { column, ascending } of [...orders].reverse()) {
          rows.sort((a, b) => {
            const av = a[column];
            const bv = b[column];
            const cmp = av === bv ? 0 : av > bv ? 1 : -1;
            return ascending ? cmp : -cmp;
          });
        }
        if (limitCount !== null) rows = rows.slice(0, limitCount);
        return rows;
      };

      async function execute(): Promise<{ data: unknown; error: unknown }> {
        if (op === 'select') {
          const rows = currentRows().map((row) => ({ ...row }));
          if (shaping === 'single') return { data: rows[0] ?? null, error: null };
          if (shaping === 'maybeSingle') return { data: rows[0] ?? null, error: null };
          return { data: rows, error: null };
        }
        if (op === 'insert') {
          const row = { ...(payload as MockRow) };
          if (table === 'streaming_source_categories' && !row.created_at) row.created_at = '2026-10-07T00:00:00.000Z';
          state[table].push(row);
          writes.push({ table, kind: 'insert', patch: { ...(payload as MockRow) } });
          try {
            assertUniqueCategoryOrdering(`insert into ${table}`);
          } catch (error) {
            state[table].pop();
            return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint' } };
          }
          return { data: payload, error: null };
        }
        if (op === 'update') {
          const rows = currentRows();
          if (rows.length === 0) return { data: null, error: { code: 'PGRST116', message: 'JSON object requested' } };
          for (const row of rows) {
            Object.assign(row, payload as MockRow);
            writes.push({ table, kind: 'update', id: String(row.source_id ?? row.id ?? ''), patch: { ...(payload as MockRow) } });
            assertUniqueCategoryOrdering(`update on ${table} (row ${row.source_id ?? row.id})`);
          }
          return { data: rows[0] ?? null, error: null };
        }
        // delete
        if (options.failFirstDelete && options.failFirstDelete.table === table) {
          options.failFirstDelete = undefined; // only the first delete fails
          return { data: null, error: { code: options.failFirstDelete === undefined ? '23503' : '23503', message: 'update or delete on table violates foreign key constraint' } };
        }
        const rows = currentRows();
        state[table] = state[table].filter((row) => !rows.includes(row));
        for (const row of rows) writes.push({ table, kind: 'delete', id: String(row.source_id ?? row.id ?? '') });
        return { data: rows[0] ?? null, error: null };
      }

      const chain: Record<string, unknown> = {
        select() { return chain; },
        insert(value: unknown) { op = 'insert'; payload = value; return chain; },
        update(value: Record<string, unknown>) { op = 'update'; payload = value; return chain; },
        delete() { op = 'delete'; return chain; },
        eq(column: string, value: unknown) { filters.push({ column, value }); return chain; },
        order(column: string, opts?: { ascending?: boolean }) { orders.push({ column, ascending: opts?.ascending ?? true }); return chain; },
        limit(count: number) { limitCount = count; return chain; },
        maybeSingle() { shaping = 'maybeSingle'; return chain; },
        single() { shaping = 'single'; return chain; },
        then(resolve: (value: unknown) => void, reject: (reason?: unknown) => void) {
          execute().then(resolve, reject);
        },
      };
      return chain as unknown as Record<string, unknown>;
    },
    rpc(name: string, args: Record<string, unknown>) {
      writes.push({ table: '(rpc)', kind: 'rpc', rpc: { name, args: { ...args } } });
      const result = options.rpc ?? { data: null, error: { code: '42883', message: `function public.${name} does not exist` } };
      return Promise.resolve(result);
    },
  };
  return client as unknown as Parameters<typeof reorderCategorySources>[0] & {
    _state: Record<string, MockRow[]>;
    _writes: WriteRecord[];
  };
}

const mapping = (sourceId: string, categoryId: string, ordering: number): MockRow => ({ source_id: sourceId, category_id: categoryId, ordering, created_at: '2026-10-07T00:00:00.000Z' });
const sourceRow = (id: string, name: string, ordering: number): MockRow => ({ id, name, slug: name.toLowerCase(), ordering, enabled: true, visibility: 'public', status: 'active', provider_id: '33333333-3333-4333-8333-333333333333' });
const addonRow = (id: string, name: string, ordering: number): MockRow => ({
  id, name, slug: name.toLowerCase(), manifest_url: 'https://example.com/manifest.json', enabled: true, status: 'active',
  ordering, description: null, logo: null, version: '1.0.0', id_property: 'imdb_id', supported_types: ['movie'],
  id_prefixes: ['tt'], resources: ['stream'], last_checked_at: null, last_success_at: null, last_error: null,
  capabilities: {}, notes: null, created_at: '2026-10-07T00:00:00.000Z', updated_at: '2026-10-07T00:00:00.000Z',
});

const categoryOrder = (client: ReturnType<typeof createMockDb>, categoryId: string) =>
  client._state.streaming_source_categories.filter((row) => row.category_id === categoryId).sort((a, b) => Number(a.ordering) - Number(b.ordering)).map((row) => String(row.source_id));
const addonOrder = (client: ReturnType<typeof createMockDb>) =>
  client._state.streaming_addons.slice().sort((a, b) => Number(a.ordering) - Number(b.ordering)).map((row) => String(row.name));

const abcdMappings = () => [mapping(A, CAT1, 0), mapping(B, CAT1, 1), mapping(C, CAT1, 2), mapping(D, CAT1, 3)];

// ============================================================
// 4. Category reorder — fallback path (RPC missing), constraint-enforced
// ============================================================
{
  // Case 14: D → position 1 gives D A B C.
  const db = createMockDb({ streaming_source_categories: abcdMappings() }, { enforceUnique: true });
  await applyCategorySourcePositions(db as never, CAT1, [{ sourceId: D, position: 1 }]);
  assert.deepEqual(categoryOrder(db, CAT1), [D, A, B, C], 'case 14: D → 1 gives D A B C');
  assert.deepEqual(db._state.streaming_source_categories.map((row) => Number(row.ordering)).sort(), [0, 1, 2, 3], 'case 18: dense unique numbering after reorder');

  // Case 15: A → position 4 gives B C D A.
  const db2 = createMockDb({ streaming_source_categories: abcdMappings() }, { enforceUnique: true });
  await applyCategorySourcePositions(db2 as never, CAT1, [{ sourceId: A, position: 4 }]);
  assert.deepEqual(categoryOrder(db2, CAT1), [B, C, D, A], 'case 15: A → 4 gives B C D A');

  // Case 16: C → position 2 gives A C B D.
  const db3 = createMockDb({ streaming_source_categories: abcdMappings() }, { enforceUnique: true });
  await applyCategorySourcePositions(db3 as never, CAT1, [{ sourceId: C, position: 2 }]);
  assert.deepEqual(categoryOrder(db3, CAT1), [A, C, B, D], 'case 16: C → 2 gives A C B D');

  // Case 19: category reorder never writes streaming_sources (global ordering untouched).
  const db4 = createMockDb({ streaming_source_categories: abcdMappings(), streaming_sources: [sourceRow(A, 'A', 0), sourceRow(B, 'B', 1), sourceRow(C, 'C', 2), sourceRow(D, 'D', 3)] }, { enforceUnique: true });
  await applyCategorySourcePositions(db4 as never, CAT1, [{ sourceId: D, position: 1 }]);
  assert.ok(db4._writes.every((write) => write.table === 'streaming_source_categories' || write.table === '(rpc)'), 'case 19: only streaming_source_categories rows are written');
  assert.deepEqual(db4._state.streaming_sources.map((row) => Number(row.ordering)), [0, 1, 2, 3], 'case 19: streaming_sources.ordering is unchanged');

  // Case 20: reordering category 1 leaves the source's assignment in category 2 untouched.
  const db5 = createMockDb({ streaming_source_categories: [...abcdMappings(), mapping(A, CAT2, 2), mapping(B, CAT2, 0)] }, { enforceUnique: true });
  await applyCategorySourcePositions(db5 as never, CAT1, [{ sourceId: A, position: 4 }]);
  assert.deepEqual(categoryOrder(db5, CAT2), [B, A], 'case 20: other category order unchanged');
  assert.equal(db5._state.streaming_source_categories.find((row) => row.category_id === CAT2 && row.source_id === A)?.ordering, 2, 'case 20: other category ordering value untouched');

  // Case 21: empty category reorder is safe.
  const db6 = createMockDb({ streaming_source_categories: [] });
  await applyCategorySourcePositions(db6 as never, CAT1, []);
  assert.equal(db6._writes.filter((write) => write.kind !== 'rpc').length, 0, 'case 21: empty category reorder is a no-op');

  // Case 22: single-source category reorder is safe.
  const db7 = createMockDb({ streaming_source_categories: [mapping(A, CAT1, 0)] }, { enforceUnique: true });
  await applyCategorySourcePositions(db7 as never, CAT1, [{ sourceId: A, position: 1 }]);
  assert.deepEqual(categoryOrder(db7, CAT1), [A], 'case 22: single-source category stays intact');

  // Position beyond the end is rejected with a clear message.
  const db8 = createMockDb({ streaming_source_categories: abcdMappings() });
  await assert.rejects(() => applyCategorySourcePositions(db8 as never, CAT1, [{ sourceId: A, position: 5 }]), /Positions run from 1 to 4/, 'position > count rejected');

  // Foreign source ids (cross-category manipulation) are rejected.
  const db9 = createMockDb({ streaming_source_categories: abcdMappings() });
  await assert.rejects(() => applyCategorySourcePositions(db9 as never, CAT1, [{ sourceId: E, position: 1 }]), /not assigned to this category/, 'foreign source id rejected');

  // Duplicate ordered ids are rejected before any write.
  const db10 = createMockDb({ streaming_source_categories: abcdMappings() });
  await assert.rejects(() => reorderCategorySources(db10 as never, CAT1, [A, A, B, C]), /Duplicate sources/, 'duplicate ids rejected');
  assert.equal(db10._writes.filter((write) => write.kind !== 'rpc').length, 0, 'duplicate rejection happens before any write');

  // Partial lists are rejected (every source exactly once).
  const db11 = createMockDb({ streaming_source_categories: abcdMappings() });
  await assert.rejects(() => reorderCategorySources(db11 as never, CAT1, [A, B, C]), /must include every source/, 'partial set rejected');

  // Unknown ids are rejected.
  const db12 = createMockDb({ streaming_source_categories: abcdMappings() });
  await assert.rejects(() => reorderCategorySources(db12 as never, CAT1, [A, B, C, E]), /not assigned to this category/, 'unknown id rejected');

  // Legacy gaps self-heal: 0,2,4 renumbers to a dense 0..2.
  const db13 = createMockDb({ streaming_source_categories: [mapping(A, CAT1, 0), mapping(B, CAT1, 2), mapping(C, CAT1, 4)] }, { enforceUnique: true });
  await reorderCategorySources(db13 as never, CAT1, [C, B, A]);
  assert.deepEqual(db13._state.streaming_source_categories.map((row) => Number(row.ordering)).sort(), [0, 1, 2], 'legacy gaps renumber to dense 0..N-1');
}

// ============================================================
// 5. Category reorder — RPC primary path
// ============================================================
{
  // Successful RPC: called once with the derived order, no table writes.
  const db = createMockDb({ streaming_source_categories: abcdMappings() }, { rpc: { data: 4, error: null } });
  await applyCategorySourcePositions(db as never, CAT1, [{ sourceId: D, position: 1 }]);
  const rpcWrites = db._writes.filter((write) => write.kind === 'rpc');
  assert.equal(rpcWrites.length, 1, 'exactly one RPC call');
  assert.equal(rpcWrites[0]?.rpc?.name, 'reorder_category_sources', 'RPC name');
  assert.deepEqual((rpcWrites[0]?.rpc?.args as { p_ordered_source_ids: string[] }).p_ordered_source_ids, [D, A, B, C], 'RPC receives the derived order');
  assert.equal((rpcWrites[0]?.rpc?.args as { p_category_id: string }).p_category_id, CAT1, 'RPC receives the category');
  assert.equal(db._writes.filter((write) => write.kind !== 'rpc').length, 0, 'RPC success performs no direct table writes');

  // A genuine RPC error (auth) propagates — it is NOT treated as "missing".
  const db2 = createMockDb({ streaming_source_categories: abcdMappings() }, { rpc: { data: null, error: { code: '42501', message: 'You are not authorized to change the streaming registry.' } } });
  await assert.rejects(() => reorderCategorySources(db2 as never, CAT1, [A, B, C, D]), /not authorized/i, 'RPC authorization errors propagate');
}

// ============================================================
// 6. Assignment reliability (append + no-op + dense)
// ============================================================
{
  // Assign appends at the END with dense numbering.
  const db = createMockDb({ streaming_source_categories: [mapping(A, CAT1, 0), mapping(B, CAT1, 1)] }, { enforceUnique: true });
  await assignSourceToCategory(db as never, C, CAT1);
  assert.equal(db._state.streaming_source_categories.find((row) => row.source_id === C)?.ordering, 2, 'assignment appends at max + 1');
  // Re-assign is a no-op that preserves position.
  await assignSourceToCategory(db as never, A, CAT1);
  assert.equal(db._state.streaming_source_categories.filter((row) => row.category_id === CAT1).length, 3, 're-assign adds no duplicate row');
  assert.equal(db._state.streaming_source_categories.find((row) => row.source_id === A)?.ordering, 0, 're-assign preserves the current position');
  // Assign into an empty category starts at 0.
  const db2 = createMockDb({ streaming_source_categories: [] });
  await assignSourceToCategory(db2 as never, A, CAT2);
  assert.equal(db2._state.streaming_source_categories.find((row) => row.source_id === A)?.ordering, 0, 'first assignment starts at 0');
  // Validation contract (route-level parsing).
  const form = new FormData();
  form.set('source_id', A);
  form.set('category_id', CAT1);
  assert.deepEqual(parseSourceAssignmentForm(form), { source_id: A, category_id: CAT1 }, 'assignment form parses');
  const badForm = new FormData();
  badForm.set('source_id', 'nope');
  badForm.set('category_id', CAT1);
  assert.throws(() => parseSourceAssignmentForm(badForm), StreamingValidationError, 'assignment form rejects invalid uuid');
}

// ============================================================
// 7. Removal normalization (spec case 17 + 38)
// ============================================================
{
  // Case 17: removing B from A B C D leaves a DENSE A C D.
  const db = createMockDb({ streaming_source_categories: abcdMappings() }, { enforceUnique: true });
  await deleteSourceCategory(db as never, B, CAT1);
  assert.deepEqual(categoryOrder(db, CAT1), [A, C, D], 'case 17: removal leaves A C D');
  assert.deepEqual(db._state.streaming_source_categories.map((row) => Number(row.ordering)).sort(), [0, 1, 2], 'removal normalizes to dense 0..N-1');

  // Removing the LAST assignment needs no reorder writes (already dense).
  const db2 = createMockDb({ streaming_source_categories: [mapping(A, CAT1, 0), mapping(B, CAT1, 1), mapping(C, CAT1, 2), mapping(D, CAT1, 3)] }, { enforceUnique: true });
  await deleteSourceCategory(db2 as never, D, CAT1);
  assert.deepEqual(categoryOrder(db2, CAT1), [A, B, C], 'trailing removal leaves A B C');
  assert.equal(db2._writes.filter((write) => write.kind === 'update').length, 0, 'already-dense result writes no reorder updates');

  // Case 38: removing an assignment never deletes the global source.
  const db3 = createMockDb({ streaming_source_categories: [mapping(A, CAT1, 0)], streaming_sources: [sourceRow(A, 'A', 0)] });
  await deleteSourceCategory(db3 as never, A, CAT1);
  assert.equal(db3._state.streaming_sources.length, 1, 'case 38: the global source record survives assignment removal');
  assert.equal(db3._state.streaming_source_categories.length, 0, 'only the mapping row is gone');

  // Removing from an empty/foreign category is a no-op on data.
  const db4 = createMockDb({ streaming_source_categories: [mapping(A, CAT1, 0)] });
  await deleteSourceCategory(db4 as never, B, CAT1);
  assert.equal(db4._state.streaming_source_categories.length, 1, 'removing a non-assigned source changes nothing');
}

// ============================================================
// 8. Global source deletion (spec cases 32–37)
// ============================================================
{
  // Case 32/33: source WITH category assignments can be deleted; assignments cleaned safely.
  const db = createMockDb(
    {
      streaming_source_categories: [mapping(A, CAT1, 0), mapping(B, CAT1, 1), mapping(S, CAT1, 2), mapping(S, CAT2, 0), mapping(C, CAT2, 1)],
      streaming_sources: [sourceRow(A, 'A', 0), sourceRow(B, 'B', 1), sourceRow(S, 'S', 2), sourceRow(C, 'C', 3)],
    },
    { enforceUnique: true },
  );
  await deleteSource(db as never, S);
  assert.equal(db._state.streaming_sources.find((row) => row.id === S), undefined, 'case 32: the source is deleted');
  assert.ok(db._state.streaming_source_categories.every((row) => row.source_id !== S), 'case 33: all of its assignments are cleaned');
  assert.deepEqual(categoryOrder(db, CAT1), [A, B], 'affected category 1 re-normalized to dense order');
  assert.deepEqual(categoryOrder(db, CAT2), [C], 'affected category 2 re-normalized to dense order');
  // Case 34: unrelated categories/sources untouched.
  assert.equal(db._state.streaming_sources.length, 3, 'case 34: no unrelated sources were deleted');
  assert.ok(db._state.streaming_source_categories.every((row) => row.category_id === CAT1 || row.category_id === CAT2), 'no category rows were deleted (mappings only)');

  // Case 37: source with NO assignments still deletes.
  const db2 = createMockDb({ streaming_source_categories: [], streaming_sources: [sourceRow(A, 'A', 0)] });
  await deleteSource(db2 as never, A);
  assert.equal(db2._state.streaming_sources.length, 0, 'case 37: unassigned source deletes');

  // Unknown future dependency (FK restrict) surfaces a USEFUL error.
  const db3 = createMockDb(
    { streaming_source_categories: [], streaming_sources: [sourceRow(A, 'A', 0)] },
    { failFirstDelete: { table: 'streaming_sources', code: '23503' } },
  );
  await assert.rejects(() => deleteSource(db3 as never, A), /still referenced by another registry record/, 'FK-restrict delete surfaces a useful admin error');
  // Known dependencies are cleaned first (default_sources/health cascade in the schema).
  assert.match(read('supabase/migrations/20260906000000_phase2_default_sources.sql'), /source_id uuid not null references public\.streaming_sources\(id\) on delete cascade/, 'case 35: default sources cascade in the schema');
  assert.match(read('supabase/migrations/20260822000000_phase7f_provider_health.sql'), /source_id uuid not null references public\.streaming_sources\(id\) on delete cascade/, 'case 36: provider health cascades in the schema');
  assert.match(adminServiceSource, /streaming_default_sources and\s*\/\/\s*streaming_provider_health intentionally ON DELETE CASCADE/, 'deleteSource documents the intentional cascades');
}

// ============================================================
// 9. Addon absolute position — fallback path (RPC missing)
// ============================================================
{
  const ADDON_A = '33333333-3333-4333-8333-3333333333aa'.slice(0, 36);
  const build = () => createMockDb({
    streaming_addons: [
      addonRow(ADDON_A, 'A', 0),
      addonRow(src('b1').slice(0, 36), 'B', 1),
      addonRow(src('c2').slice(0, 36), 'C', 2),
      addonRow(src('d3').slice(0, 36), 'D', 3),
      addonRow(src('e4').slice(0, 36), 'E', 4),
    ],
  });
  const addonId = (db: ReturnType<typeof build>, name: string) => db._state.streaming_addons.find((row) => row.name === name)!.id as string;

  // Case 23: E → 1 gives E A B C D.
  const db = build();
  await setAddonPosition(db as never, addonId(db, 'E'), 1);
  assert.deepEqual(addonOrder(db), ['E', 'A', 'B', 'C', 'D'], 'case 23: E → 1 gives E A B C D');
  assert.deepEqual(db._state.streaming_addons.map((row) => Number(row.ordering)).sort(), [0, 1, 2, 3, 4], 'case 29: dense 0..N-1 numbering');

  // Case 24: A → 5 gives B C D E A.
  const db2 = build();
  await setAddonPosition(db2 as never, addonId(db2, 'A'), 5);
  assert.deepEqual(addonOrder(db2), ['B', 'C', 'D', 'E', 'A'], 'case 24: A → 5 gives B C D E A');

  // Case 25: C → 2 gives A C B D E.
  const db3 = build();
  await setAddonPosition(db3 as never, addonId(db3, 'C'), 2);
  assert.deepEqual(addonOrder(db3), ['A', 'C', 'B', 'D', 'E'], 'case 25: C → 2 gives A C B D E');

  // Case 26: invalid positions rejected.
  await assert.rejects(() => setAddonPosition(build() as never, ADDON_A, 0), /whole number starting at 1/, 'case 28: position < 1 rejected');
  await assert.rejects(() => setAddonPosition(build() as never, ADDON_A, -3), /whole number starting at 1/, 'negative position rejected');
  await assert.rejects(() => setAddonPosition(build() as never, ADDON_A, 1.5), /whole number starting at 1/, 'fractional position rejected');
  await assert.rejects(() => setAddonPosition(build() as never, ADDON_A, Number.NaN), /whole number starting at 1/, 'NaN position rejected');
  // Case 27: position > count handled correctly (clear rejection).
  await assert.rejects(() => setAddonPosition(build() as never, ADDON_A, 6), /between 1 and 5/, 'case 27: position > count rejected');

  // Invalid/unknown addon ids.
  await assert.rejects(() => setAddonPosition(build() as never, 'not-a-uuid', 1), StreamingValidationError, 'invalid addon id rejected');
  await assert.rejects(() => setAddonPosition(build() as never, src('ff'), 1), /Addon not found/, 'unknown addon id rejected');

  // Case 30: no duplicate ordering values after reorder.
  const db4 = build();
  await setAddonPosition(db4 as never, addonId(db4, 'D'), 2);
  const orderings = db4._state.streaming_addons.map((row) => Number(row.ordering));
  assert.equal(new Set(orderings).size, orderings.length, 'case 30: no duplicate ordering values');
  assert.deepEqual([...orderings].sort(), [0, 1, 2, 3, 4], 'renumbering is dense');

  // Legacy ties/gaps self-heal through the same path.
  const db5 = createMockDb({
    streaming_addons: [
      addonRow(ADDON_A, 'A', 0),
      addonRow(src('b1').slice(0, 36), 'B', 0),
      addonRow(src('c2').slice(0, 36), 'C', 7),
    ],
  });
  await setAddonPosition(db5 as never, ADDON_A, 3);
  assert.deepEqual(db5._state.streaming_addons.map((row) => Number(row.ordering)).sort(), [0, 1, 2], 'legacy ties/gaps renumber to dense 0..N-1');

  // moveAddon regression: quick adjacent move still works.
  const db6 = build();
  await moveAddon(db6 as never, addonId(db6, 'B'), 'up');
  assert.deepEqual(addonOrder(db6), ['B', 'A', 'C', 'D', 'E'], 'moveAddon up still works');

  // Case 31: the listing (resolver-consumed sort) reflects the new order.
  assert.match(read('src/lib/server/streaming/stremio/admin-addons.ts'), /order\('ordering', \{ ascending: true \}\)[\s\S]*?order\('name'[\s\S]*?order\('created_at'/, 'case 31: the listing keeps consuming the canonical ordering sort');
}

// ============================================================
// 10. Addon absolute position — RPC primary path
// ============================================================
{
  const ADDON_A = '44444444-4444-4444-8444-4444444444aa'.slice(0, 36);
  const db = createMockDb(
    { streaming_addons: [addonRow(ADDON_A, 'A', 0), addonRow(src('b1').slice(0, 36), 'B', 1), addonRow(src('c2').slice(0, 36), 'C', 2)] },
    { rpc: { data: 3, error: null } },
  );
  await setAddonPosition(db as never, ADDON_A, 2);
  const rpcWrites = db._writes.filter((write) => write.kind === 'rpc');
  assert.equal(rpcWrites.length, 1, 'exactly one RPC call');
  assert.equal(rpcWrites[0]?.rpc?.name, 'set_addon_position', 'RPC name');
  assert.deepEqual(rpcWrites[0]?.rpc?.args, { p_addon_id: ADDON_A, p_position: 2 }, 'RPC receives id + 1-based position');
  assert.equal(db._writes.filter((write) => write.kind !== 'rpc').length, 0, 'RPC success performs no direct table writes');

  // Genuine RPC errors propagate (not treated as "missing").
  const db2 = createMockDb(
    { streaming_addons: [addonRow(ADDON_A, 'A', 0)] },
    { rpc: { data: null, error: { code: '42501', message: 'You are not authorized to change the addon registry.' } } },
  );
  await assert.rejects(() => setAddonPosition(db2 as never, ADDON_A, 1), /not authorized/i, 'RPC authorization errors propagate');
}

// ============================================================
// 11. Category reorder form parsing (server-side validation)
// ============================================================
{
  const form = new FormData();
  form.set('category_id', CAT1);
  form.set('position_' + D, '1');
  form.set('position_' + A, '4');
  form.set('unrelated', 'ignore me');
  const parsed = parseCategoryReorderForm(form);
  assert.equal(parsed.categoryId, CAT1, 'category parsed');
  assert.equal(parsed.positions.length, 2, 'only position_ fields are collected');
  assert.deepEqual(parsed.positions.find((entry) => entry.sourceId === D), { sourceId: D, position: 1 }, 'position value parsed');

  const badCategory = new FormData();
  badCategory.set('category_id', 'nope');
  assert.throws(() => parseCategoryReorderForm(badCategory), StreamingValidationError, 'invalid category uuid rejected');

  const badSource = new FormData();
  badSource.set('category_id', CAT1);
  badSource.set('position_not-a-uuid', '1');
  assert.throws(() => parseCategoryReorderForm(badSource), StreamingValidationError, 'invalid position field name rejected');

  const badPosition = new FormData();
  badPosition.set('category_id', CAT1);
  badPosition.set('position_' + A, 'two');
  assert.throws(() => parseCategoryReorderForm(badPosition), StreamingValidationError, 'non-numeric position rejected');

  const zeroPosition = new FormData();
  zeroPosition.set('category_id', CAT1);
  zeroPosition.set('position_' + A, '0');
  assert.throws(() => parseCategoryReorderForm(zeroPosition), StreamingValidationError, 'position 0 rejected');

  const empty = new FormData();
  empty.set('category_id', CAT1);
  assert.deepEqual(parseCategoryReorderForm(empty), { categoryId: CAT1, positions: [] }, 'empty reorder is a valid no-op');
}

// ============================================================
// 12. Route/action security + wiring contracts
// ============================================================
{
  // Categories: both new and existing actions call requireAdmin.
  assert.match(categoriesServer, /assignSource: async \(\{ request, locals \}\) => \{[\s\S]*?await requireAdmin\(locals, \{ redirectTo: '\/admin\/categories' \}\)/, 'assignSource calls requireAdmin');
  assert.match(categoriesServer, /reorderSources: async \(\{ request, locals \}\) => \{[\s\S]*?await requireAdmin\(locals, \{ redirectTo: '\/admin\/categories' \}\)/, 'reorderSources calls requireAdmin');
  assert.match(categoriesServer, /removeSource: async \(\{ request, locals \}\) => \{[\s\S]*?await requireAdmin\(locals, \{ redirectTo: '\/admin\/categories' \}\)/, 'removeSource calls requireAdmin');
  assert.match(categoriesServer, /parseCategoryReorderForm[\s\S]*?applyCategorySourcePositions/, 'reorderSources derives order server-side');
  assert.match(categoriesServer, /parseSourceAssignmentForm[\s\S]*?assignSourceToCategory/, 'assignSource appends via the new service');
  assert.ok(!categoriesServer.includes('upsertSourceCategory'), 'the collision-prone client-ordering upsert is gone');
  assert.ok(!adminServiceSource.includes('export async function upsertSourceCategory'), 'admin-service no longer exports the ordering-collision-prone upsert');

  // Addons: the new action calls requireAdmin and validates the position.
  assert.match(addonsServer, /setAddonPosition: async \(\{ request, locals \}\) => \{[\s\S]*?await requireAdmin\(locals, \{ redirectTo: REDIRECT \}\)/, 'setAddonPosition calls requireAdmin');
  assert.ok(addonsServer.includes("/^\\d+$/.test(rawPosition)"), 'setAddonPosition validates the position format');
  assert.match(addonsServer, /await setAddonPosition\(locals\.supabase, form\.get\('id'\), position\)/, 'setAddonPosition delegates to the service');

  // Addons page: Reorder entry point + position form; Up/Down removed;
  // no fetch.
  assert.match(addonsPage, /openPositionSheet\(addon\)[\s\S]*?Reorder/, 'Reorder button per addon');
  assert.match(addonsPage, /action="\?\/setAddonPosition"/, 'position form posts to the new action');
  assert.match(addonsPage, /name="position"[\s\S]*?min="1"/, 'position input is constrained client-side');
  // Task 13 follow-up: the redundant per-card Up/Down quick-move forms are
  // gone from the page (Reorder is the single ordering UI). The moveAddon
  // server action + service remain pinned above/in phase7 as the API.
  assert.ok(!addonsPage.includes('?/moveAddon'), 'Up/Down quick-move forms removed from the addon card');
  assert.ok(!addonsPage.includes('aria-label={`Move '), 'icon-only Up/Down buttons removed from the addon card');
  assert.ok(!addonsPage.includes('fetch('), 'no client-side fetches');
  assert.ok(!addonsPage.includes('.sort(') && !addonsPage.includes('.order('), 'no client-side ordering logic');

  // Categories page: reorder mode with position inputs + save/cancel.
  assert.match(categoriesPage, /action="\?\/reorderSources"/, 'reorder form posts to the new action');
  assert.match(categoriesPage, /name=\{`position_\$\{mapping\.source_id\}`\}/, 'position fields are keyed by source id');
  assert.match(categoriesPage, />Save order</, 'Save order action');
  assert.match(categoriesPage, /onclick=\{cancelReorder\}/, 'Cancel exits reorder mode');
  assert.match(categoriesPage, /startReorder/, 'Reorder mode entry');
  // The ASSIGN form no longer has a manual ordering input (the category's own
  // edit form legitimately keeps its separate `ordering` field — that is
  // streaming_categories.ordering, a different concept).
  const assignFormMatch = categoriesPage.match(/class="assign-form"[\s\S]*?<\/form>/);
  assert.ok(assignFormMatch, 'assign form found');
  assert.ok(!assignFormMatch[0].includes('name="ordering"'), 'the manual ordering input is gone from the assign form');

  // Public config invalidation is wired through the existing mechanism only.
  assert.match(adminServiceSource, /import \{ invalidatePublicStreamingConfig \} from '\.\/public-config'/, 'admin-service keeps using the existing cache invalidation');
  assert.ok(!/from\('streaming_config_meta'\)\.(update|insert|delete)/.test(adminServiceSource), 'no direct config-meta writes (no second invalidation mechanism)');
}

// ============================================================
// 13. Player contract: category-specific order reaches the selector
// ============================================================
{
  // The watch route derives the option order from the CATEGORY-SPECIFIC
  // assignment ordering (this was previously lost — options rendered in
  // global source order inside every group).
  assert.match(watchPage, /primaryAssignmentBySourceId/, 'primary assignment map is built');
  assert.match(watchPage, /assignmentA\.ordering - assignmentB\.ordering/, 'same-group options compare by category-specific ordering');
  assert.match(watchPage, /groupFirstSeen/, 'group order follows first appearance in the global list');
  assert.match(watchPage, /return a\.index - b\.index;[\s\S]{0,120}\/\/ stable for ties/, 'sort is stable for ties/unassigned sources');
  assert.match(watchPage, /badge: isSourceBadge\(source\.badge\)/, 'badge mapping is present alongside the ordering fix');
  // PlayerShell grouping is unchanged: category groups + Other at the end.
  assert.match(shell, /const name = option\.categoryName \?\? 'Other'/, 'category grouping preserved');
  assert.match(shell, /groups\.push\(other\)/, 'Other still moves to the end');
  assert.match(shell, /groupedSourceOptions/, 'grouped options pipeline intact');
}

console.log('Task 13 admin reorder + delete reliability tests passed');
