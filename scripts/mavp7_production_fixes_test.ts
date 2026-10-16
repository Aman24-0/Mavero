// ============================================================================
// MAVP-7 — Combined Production Fix: Watch Page 500 + Category Source
// Management — regression suite. Chain command after mavp6.
//
// Sections:
//   §1  Watch-page 500 (The Gentlemen Play):
//        The verified mechanism: MediaCard's Play anchor carried
//        `onclick={(e) => e.stopPropagation()}` which stopped the click from
//        reaching SvelteKit's delegated navigation listener (installed on a
//        container ANCESTOR — @sveltejs/kit's client runtime), so every Play
//        press fell back to a NATIVE full-page navigation and always executed
//        the entire SSR pipeline (hooks auth + layout + watch load) while SPA
//        browsing reused cached layout data (`uses: {}`). Tests: the
//        version-anchored Kit delegation contract (the mechanism the fix
//        relies on), the MediaCard navigation contract (Play carries NO click
//        handler; no ancestor card handler exists), and the watch route's
//        unchanged SSR/surface contract. The load's typed-outcome guarantees
//        are held by the mavp6 suite §1 (executed separately in the chain).
//   §2  Numeric source position (replaces Up/Down):
//        BEHAVIORAL tests of the REAL applyCategorySourcePositions service
//        over an in-memory Supabase fake: the task's exact example
//        (A,B,C,D,E — D→2 ⇒ A,D,B,C,E), first/last boundaries, intervening
//        shifts, out-of-range rejection with the list UNCHANGED, dense+unique
//        positions after apply AND after removal, persisted order stable on
//        re-read, removal never deletes the source record. Parser tests
//        reject 0/negative/non-numeric positions. Structural: the editor
//        renders the numeric input + Apply and carries NO Up/Down controls.
//   §3  Global assignment eligibility:
//        BEHAVIORAL: after removal a source is assignable again (appends
//        densely); the source RECORD survives removal (mapping table only).
//        Migration contract: deterministic dedup keeping the runtime
//        primary-assignment row (lowest category registry ordering) and the
//        guarded unique(source_id) constraint.
//
// Deterministic and credential-free: no network, no browser, no Supabase
// credentials (explicitly out of scope for this task).
// ============================================================================

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let checks = 0;
function ok(condition: unknown, message: string): void {
  checks += 1;
  assert.ok(condition, `FAIL: ${message}`);
}
function okEq<T>(actual: T, expected: T, message: string): void {
  checks += 1;
  assert.deepStrictEqual(actual, expected, `FAIL: ${message} (actual: ${JSON.stringify(actual)})`);
}
function read(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf8');
}
/** Strip block comments so structural regexes read CODE, not prose. */
function codeOnly(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '');
}
/** Strip HTML comments too (Svelte markup annotations). */
function markupOnly(source: string): string {
  return codeOnly(source).replace(/<!--[\s\S]*?-->/g, '');
}

// In-memory streaming_source_categories store + fluent Supabase fake
// (same contract as the mavp6 harness: select/eq/order/limit/maybeSingle,
// insert, update+eq, delete+eq, rpc fallback).
type MappingRow = { source_id: string; category_id: string; ordering: number };
function fakeClient(db: { mappings: MappingRow[]; tablesTouched: Set<string>; rpc?: (name: string, args: any) => Promise<{ error: any }> }) {
  function from(table: string) {
    db.tablesTouched.add(table);
    const state: { mode: 'select' | 'insert' | 'update' | 'delete' | null; payload: any; filters: Record<string, unknown>; orderCol: string | null; orderAsc: boolean; limitN: number | null } = { mode: null, payload: null, filters: {}, orderCol: null, orderAsc: true, limitN: null };
    const rowsFor = (): MappingRow[] => db.mappings.filter((row) => Object.entries(state.filters).every(([col, val]) => (row as any)[col] === val));
    async function execute(): Promise<{ data: any; error: any }> {
      if (state.mode === 'select') {
        let rows = rowsFor();
        if (state.orderCol) rows = rows.slice().sort((a, b) => ((a as any)[state.orderCol!] - (b as any)[state.orderCol!]) * (state.orderAsc ? 1 : -1));
        if (state.limitN !== null) rows = rows.slice(0, state.limitN);
        return { data: rows.map((row) => ({ ...row })), error: null };
      }
      if (state.mode === 'insert') { db.mappings.push({ ...(state.payload as MappingRow) }); return { data: null, error: null }; }
      if (state.mode === 'update') {
        for (const row of rowsFor()) Object.assign(row, state.payload);
        return { data: null, error: null };
      }
      if (state.mode === 'delete') {
        const doomed = rowsFor();
        for (const row of doomed) db.mappings.splice(db.mappings.indexOf(row), 1);
        return { data: null, error: null };
      }
      return { data: null, error: null };
    }
    const builder: any = {
      select: () => { state.mode = 'select'; return builder; },
      insert: (payload: unknown) => { state.mode = 'insert'; state.payload = payload; return builder; },
      update: (payload: unknown) => { state.mode = 'update'; state.payload = payload; return builder; },
      delete: () => { state.mode = 'delete'; return builder; },
      eq: (col: string, val: unknown) => { state.filters[col] = val; return builder; },
      order: (col: string, opts?: { ascending?: boolean }) => { state.orderCol = col; state.orderAsc = opts?.ascending !== false; return builder; },
      limit: (n: number) => { state.limitN = n; return builder; },
      maybeSingle: async () => {
        const { data, error } = await execute();
        const first = Array.isArray(data) ? (data[0] ?? null) : data;
        return { data: first, error };
      },
      then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => execute().then(resolve, reject),
    };
    return builder;
  }
  return {
    from,
    rpc: (name: string, args: any) => (db.rpc ? db.rpc(name, args) : Promise.resolve({ error: { code: '42883', message: 'function reorder_category_sources does not exist' } })),
  };
}

const CAT = '11111111-1111-1111-1111-111111111111';
const A = 'aaaaaaaa-1111-1111-1111-111111111111';
const B = 'bbbbbbbb-2222-2222-2222-222222222222';
const C = 'cccccccc-3333-3333-3333-333333333333';
const D = 'dddddddd-4444-4444-4444-444444444444';
const E = 'eeeeeeee-5555-5555-5555-555555555555';

const orderedDb = (ids: string[]) => ({ mappings: ids.map((source_id, ordering) => ({ source_id, category_id: CAT, ordering })) as MappingRow[], tablesTouched: new Set<string>() });
const currentOrder = (db: { mappings: MappingRow[] }) =>
  db.mappings.filter((row) => row.category_id === CAT).slice().sort((x, y) => x.ordering - y.ordering).map((row) => row.source_id);
const idOf = (letter: string) => ({ A, B, C, D, E } as Record<string, string>)[letter];
const lettersOf = (db: { mappings: MappingRow[] }) => {
  const byId: Record<string, string> = { [A]: 'A', [B]: 'B', [C]: 'C', [D]: 'D', [E]: 'E' };
  return currentOrder(db).map((id) => byId[id] ?? id).join(',');
};

// ---------------------------------------------------------------------------
// §1 — Watch-page 500: the navigation mechanism and its fix
// ---------------------------------------------------------------------------

{
  // The version-anchored delegation contract: SvelteKit installs its link
  // click handler on a CONTAINER ANCESTOR (delegation), so a click whose
  // propagation is stopped at the anchor NEVER reaches the router and falls
  // back to the browser's native navigation. Anchored to the installed
  // @sveltejs/kit so an upgrade that changes the mechanism must revisit this.
  {
    const kitClient = read('../node_modules/@sveltejs/kit/src/runtime/client/client.js');
    ok(kitClient.includes("container.addEventListener('click'"), 'I1: the installed @sveltejs/kit delegates link clicks on a container ANCESTOR (the mechanism this fix relies on)');
    ok(kitClient.includes('if (event.defaultPrevented) return;'), 'I1: the router skips clicks whose default was already prevented (why Play adds no preventDefault)');
  }

  // MediaCard navigation contract: the Play anchor carries NO click handler.
  {
    const card = markupOnly(read('../src/lib/components/MediaCard.svelte'));
    const playAnchor = card.slice(card.indexOf('class="mc-play"'), card.indexOf('class="mc-play"') + 400);
    ok(playAnchor.length > 0, 'I1: the Play anchor exists');
    ok(!/onclick/.test(playAnchor), 'I1: the Play anchor carries NO click handler (the router receives the event and performs the SPA navigation)');
    ok(!playAnchor.includes('stopPropagation') && !playAnchor.includes('preventDefault'), 'I1: Play neither stops propagation (which caused the native full-SSR navigations) nor prevents default (which would kill navigation entirely)');
    // The href semantics are unchanged: resumeHref preferred, returnTo appended.
    // Deep-audit: the watch fallback goes through the SHARED route helper
    // (watchPath — anime-aware) since Phase 5, not the inline template.
    ok(card.includes('item.resumeHref ?? watchPath(item.id, item.type, item.isAnime, item.animeFormat)'), 'I1: the Play target contract is unchanged (resumeHref preferred, shared watch-route fallback)');
    ok(card.includes('appendReturnTo(item.resumeHref'), 'I1: returnTo is still appended to the Play target');
    // Selectable mode still HIDES Play (batch selection cannot start playback).
    const selectableBranch = card.slice(card.indexOf('{#if selectable}'), card.indexOf('{:else}'));
    ok(selectableBranch.length > 0 && !selectableBranch.includes('mc-play'), 'I1: selection mode still hides the Play control');
  }

  // No ancestor card action can be triggered by the now-bubbling click:
  // the poster wrapper and card wrapper carry no click handlers, and the
  // selectable-mode backdrop anchor is non-interactive.
  {
    const card = markupOnly(read('../src/lib/components/MediaCard.svelte'));
    const posterDiv = card.slice(card.indexOf('<div class="mc-poster"'), card.indexOf('{#if selectable}'));
    ok(!/onclick/.test(posterDiv), 'I1: the poster wrapper has NO click handler (a Play click cannot trigger a card action)');
    ok(card.includes('mc-card-link-disabled { pointer-events: none;'), 'I1: the selectable backdrop anchor is non-interactive (pointer-events: none)');
    ok(!/class="mc-wrap"[^>]*onclick/.test(card), 'I1: the card wrapper has NO click handler');
  }

  // The watch route's server surface is unchanged by this task: SSR stays
  // enabled (native navigations render the page; SPA navigations fetch
  // __data.json) and the typed-outcome load is the mavp6 suite's contract.
  {
    const watchServer = codeOnly(read('../src/routes/watch/[type]/[id]/+page.server.ts'));
    ok(!/export\s+const\s+(ssr|csr)\s*=/.test(watchServer), 'I1: the watch route keeps its SSR/CSR configuration (no new render-mode exports)');
    const card = markupOnly(read('../src/lib/components/MediaCard.svelte'));
    ok(card.includes('<a class="mc-play" href={watchHref}'), 'I1: the Play anchor keeps its href-driven navigation (no javascript: or goto replacement)');
  }
}

// ---------------------------------------------------------------------------
// §2 — Numeric source position (Up/Down replaced)
// ---------------------------------------------------------------------------

{
  const service = (await import('../src/lib/server/streaming/admin-service.ts')) as any;
  const validation = (await import('../src/lib/server/streaming/validation.ts')) as any;

  // THE TASK'S EXACT EXAMPLE: A(1) B(2) C(3) D(4) E(5) — move D to 2 ⇒ A D B C E.
  {
    const db = orderedDb([A, B, C, D, E]);
    await service.applyCategorySourcePositions(fakeClient(db) as never, CAT, [{ sourceId: D, position: 2 }]);
    okEq(lettersOf(db), 'A,D,B,C,E', 'I2: move D to position 2 ⇒ A(1) D(2) B(3) C(4) E(5) — the task example, byte-for-byte');
  }
  // Move to FIRST.
  {
    const db = orderedDb([A, B, C, D, E]);
    await service.applyCategorySourcePositions(fakeClient(db) as never, CAT, [{ sourceId: C, position: 1 }]);
    okEq(lettersOf(db), 'C,A,B,D,E', 'I2: moving a middle source to position 1 makes it FIRST');
  }
  // Move to LAST (the task's "final position must make it last").
  {
    const db = orderedDb([A, B, C, D, E]);
    await service.applyCategorySourcePositions(fakeClient(db) as never, CAT, [{ sourceId: A, position: 5 }]);
    okEq(lettersOf(db), 'B,C,D,E,A', 'I2: moving the first source to the final position makes it LAST');
  }
  // Intervening sources shift by exactly one (middle → middle).
  {
    const db = orderedDb([A, B, C, D, E]);
    await service.applyCategorySourcePositions(fakeClient(db) as never, CAT, [{ sourceId: B, position: 4 }]);
    okEq(lettersOf(db), 'A,C,D,B,E', 'I2: a middle→middle move shifts every intervening source by exactly one');
  }
  // Re-applying the CURRENT position is a safe no-op.
  {
    const db = orderedDb([A, B, C]);
    await service.applyCategorySourcePositions(fakeClient(db) as never, CAT, [{ sourceId: B, position: 2 }]);
    okEq(lettersOf(db), 'A,B,C', 'I2: applying the current position changes nothing');
  }
  // Out-of-range: above the list length is REJECTED and the order is UNCHANGED.
  {
    const db = orderedDb([A, B, C]);
    let message = '';
    try { await service.applyCategorySourcePositions(fakeClient(db) as never, CAT, [{ sourceId: A, position: 4 }]); } catch (e) { message = (e as Error).message; }
    ok(/Positions run from 1 to 3/.test(message), 'I2: a position above the list length is rejected with the documented 1..N message');
    okEq(lettersOf(db), 'A,B,C', 'I2: the rejected reorder leaves the persisted order UNCHANGED');
  }
  // Membership: an unassigned/unknown source id is rejected before any write.
  {
    const db = orderedDb([A, B]);
    let message = '';
    try { await service.applyCategorySourcePositions(fakeClient(db) as never, CAT, [{ sourceId: E, position: 1 }]); } catch (e) { message = (e as Error).message; }
    ok(/not assigned to this category/.test(message), 'I2: a source that is not assigned to the category is rejected');
    okEq(lettersOf(db), 'A,B', 'I2: the membership rejection writes NOTHING');
  }
  // Positions stay CONSECUTIVE and UNIQUE after an apply (dense 0..N-1 storage).
  {
    const db = orderedDb([A, B, C, D, E]);
    await service.applyCategorySourcePositions(fakeClient(db) as never, CAT, [{ sourceId: E, position: 1 }]);
    okEq(db.mappings.filter((row) => row.category_id === CAT).map((row) => row.ordering).sort((a, b) => a - b), [0, 1, 2, 3, 4], 'I2: after a move the persisted orderings are dense and unique (0..N-1) — no gaps, no duplicates');
  }
  // Persisted order survives a re-read (fresh query = what the reopened editor renders).
  {
    const db = orderedDb([A, B, C, D, E]);
    await service.applyCategorySourcePositions(fakeClient(db) as never, CAT, [{ sourceId: D, position: 2 }]);
    const freshDb = { mappings: db.mappings.map((row) => ({ ...row })), tablesTouched: new Set<string>() };
    okEq(lettersOf(freshDb), 'A,D,B,C,E', 'I2: the persisted order re-reads as A D B C E (survives reopening the editor / a page refresh)');
  }
  // Reordering stays scoped to ONE category (other categories untouched).
  {
    const otherCat = '33333333-3333-3333-3333-333333333333';
    const db = orderedDb([A, B]);
    db.mappings.push({ source_id: A, category_id: otherCat, ordering: 0 });
    await service.applyCategorySourcePositions(fakeClient(db) as never, CAT, [{ sourceId: A, position: 2 }]);
    okEq(db.mappings.filter((row) => row.category_id === otherCat).map((row) => row.ordering), [0], 'I2: the reorder never touches another category\u2019s ordering');
  }
  // Parser: single-edit forms parse; 0 / negative / non-numeric are rejected.
  {
    const form = (entries: Record<string, string>) => {
      const fd = new FormData();
      for (const [key, value] of Object.entries(entries)) fd.append(key, value);
      return fd;
    };
    const parsed = validation.parseCategoryReorderForm(form({ category_id: CAT, [`position_${D}`]: '2' }));
    okEq(parsed, { categoryId: CAT, positions: [{ sourceId: D, position: 2 }] }, 'I2: a single-source numeric-position form parses to one target');
    for (const bad of ['0', '-1', '2.5', 'three', '']) {
      let threw = '';
      try { validation.parseCategoryReorderForm(form({ category_id: CAT, [`position_${D}`]: bad })); } catch (e) { threw = (e as Error).message; }
      ok(/positive whole number/.test(threw), `I2: position "${bad}" is rejected (positions below 1 and non-integers are invalid)`);
    }
  }
  // Structural (2026-10-16 round RE-PIN, Issue 5 — unified bulk reposition):
  // the per-row position+Apply forms were REPLACED by ONE Reposition editor
  // over the category's assigned rows. Every row still carries a numeric
  // position input keyed by its source id (the shared draft map), prefilled
  // with the SAVED position, bounds mirrored from the server contract,
  // per-source labels, an explicit Apply (disabled until the WHOLE set is
  // valid) — and the complete intended order is submitted in ONE request.
  {
    const page = markupOnly(read('../src/routes/admin/system/content-rules/+page.svelte'));
    ok(page.includes('sourceDrafts = { ...sourceDrafts, [entry.id]'), 'I2 (re-pinned 2026-10-16): each assigned row edits a numeric draft keyed by the source id');
    ok(page.includes('min="1" max={sourceRepositionEntries.length} step="1"'), 'I2 (re-pinned 2026-10-16): the input bounds mirror the server contract (1..list length)');
    ok(page.includes('aria-label={`Position for ${row?.name'), 'I2 (re-pinned 2026-10-16): the position input is labelled per source');
    ok(page.includes('action="?/reorderSourcesBulk"'), 'I2 (re-pinned 2026-10-16): the bulk form posts the complete intended order to reorderSourcesBulk');
    ok(page.includes('disabled={!sourceRepositionValidation?.valid'), 'I2 (re-pinned 2026-10-16): Apply is disabled until the WHOLE proposed set is valid (nothing persists until then)');
    ok(page.includes('repositionDraftFromEntries'), 'I2 (re-pinned 2026-10-16): the editor prefills the SAVED positions (never blank, never renumbered)');
    ok(!page.includes('Move up') && !page.includes('Move down'), 'I2: the obsolete Up/Down controls are removed');
    ok(!page.includes('reorderedIds') && !page.includes('assignedIds('), 'I2: no dead reorder helpers remain');
    ok(page.includes('category_id" value={editingCategory.id}'), 'I2: the position form carries the category id');
  }
}

// ---------------------------------------------------------------------------
// §3 — Global assignment eligibility
// ---------------------------------------------------------------------------

{
  const service = (await import('../src/lib/server/streaming/admin-service.ts')) as any;

  // Assign → remove → assign again: eligibility is restored by removal, and
  // the source RECORD is never deleted (mapping table only).
  {
    const db = orderedDb([]);
    await service.assignSourceToCategory(fakeClient(db) as never, A, CAT);
    okEq(currentOrder(db), [A], 'I3: a zero-assignment source can be assigned');
    const tablesAfterAssign = [...db.tablesTouched];
    await service.deleteSourceCategory(fakeClient(db) as never, A, CAT);
    okEq(db.mappings.length, 0, 'I3: removing the only assignment frees the source (it becomes assignable again)');
    ok([...db.tablesTouched].every((table) => table === 'streaming_source_categories'), 'I3: assign+remove touched ONLY the mapping table — the source RECORD itself was never deleted');
    void tablesAfterAssign;
    await service.assignSourceToCategory(fakeClient(db) as never, A, CAT);
    okEq(currentOrder(db), [A], 'I3: the freed source is assignable again and appends densely');
  }

  // UI eligibility: the picker filters from the GLOBAL mapping set.
  {
    const page = markupOnly(read('../src/routes/admin/system/content-rules/+page.svelte'));
    ok(page.includes('const assignedAnywhere = new Set((data.sourceCategories as any[]).map((sc) => sc.source_id));'), 'I3: the assign picker derives eligibility from ALL category assignments (global rule)');
    ok(page.includes('No unassigned sources remain'), 'I3: the picker shows a clear empty state when no unassigned sources remain');
    const server = codeOnly(read('../src/routes/admin/system/content-rules/+page.server.ts'));
    ok(server.includes('requireAdmin(locals'), 'I3: the mutation actions keep the admin authorization gate');
  }

  // Migration contract: deterministic dedup + guarded unique(source_id).
  {
    const migration = read('../supabase/migrations/20261012000000_source_category_unique_assignment.sql');
    ok(migration.includes('partition by ssc.source_id'), 'I3: the migration dedups per SOURCE (global uniqueness)');
    ok(migration.includes('order by c.ordering asc, ssc.ordering asc, ssc.created_at asc, ssc.category_id asc'), 'I3: the dedup keeps the runtime PRIMARY assignment (lowest category registry ordering first — the same rule the public config and player apply)');
    ok(migration.includes('add constraint streaming_source_categories_source_unique unique (source_id)'), 'I3: the migration adds the authoritative unique(source_id) constraint (closes the concurrent-assign race)');
    ok(migration.includes('if not exists (') && migration.includes('pg_constraint'), 'I3: the constraint addition is guarded (safe to re-run)');
    ok(migration.includes('rn > 1'), 'I3: only DUPLICATE rows beyond the primary assignment are removed — single assignments are never touched');
  }
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`MAVP-7 production-fix regression suite: ${checks} checks passed`);
