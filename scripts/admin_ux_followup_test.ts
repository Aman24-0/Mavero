// Task 13 FOLLOW-UP — admin Sources/Categories/Addons UX fixes.
//
// Covers the five follow-up issues:
//   A. Category assignment delete: the "Source is required." failure was a
//      form-field mismatch in the removeSource action (parseId read `id`
//      while the UI posts `source_id`). Pins the fix + the behavioral
//      contract: correct ids flow through, wrong/missing ids are rejected,
//      the global source survives, ordering stays valid.
//   B. Assignment picker: Mavero-themed radio picker showing where every
//      source is already assigned (current/other/unassigned), derived once
//      client-side from already-loaded rows (no N+1 queries).
//   C. Addons: Up/Down buttons removed, Reorder remains the single ordering
//      UI, card action layout cleaned up; the moveAddon action/service stay
//      available server-side (unchanged).
//
// All tests are offline (no live Supabase).

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { deleteSourceCategory } from '../src/lib/server/streaming/admin-service.ts';
import { StreamingValidationError, parseSourceAssignmentForm } from '../src/lib/server/streaming/validation.ts';
import { categoryMembershipsBySource, orderMembershipsForPicker } from '../src/lib/shared/source-assignment.ts';

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

const categoriesServer = read('src/routes/admin/categories/+page.server.ts');
const categoriesPage = read('src/routes/admin/categories/+page.svelte');
const addonsServer = read('src/routes/admin/addons/+page.server.ts');
const addonsPage = read('src/routes/admin/addons/+page.svelte');

const CAT1 = '11111111-1111-4111-8111-111111111111';
const CAT2 = '22222222-2222-4222-8222-222222222222';
const CAT3 = '33333333-3333-4333-8333-333333333333';
const GONE = '44444444-4444-4444-8444-444444444444'; // category row that does not exist
const src = (n: string) => `${String(n).padEnd(8, '0').slice(0, 8)}-0000-4000-8000-${String(n).padEnd(12, '0').slice(0, 12)}`;
const A = src('a1');
const B = src('b2');
const C = src('c3');
const D = src('d4');

// ============================================================
// A. Category assignment deletion — the exact regression
// ============================================================
{
  // A1: the removeSource action parses `source_id` + `category_id` through
  // the SHARED assignment parser (same validation as assignSource). The old
  // bug: `parseId(form, 'Source')` read form field `id`, which the delete
  // form never posts → "Source is required." on every removal.
  assert.match(
    categoriesServer,
    /removeSource: async \(\{ request, locals \}\) => \{[\s\S]*?const assignment = parseSourceAssignmentForm\(await request\.formData\(\)\);[\s\S]*?await deleteSourceCategory\(locals\.supabase, assignment\.source_id, assignment\.category_id\);/,
    'A: removeSource parses source_id + category_id via the shared assignment parser and delegates both ids',
  );
  assert.ok(
    !/removeSource: async[\s\S]*?parseId\(form, 'Source'\)/.test(categoriesServer),
    'A: removeSource never parses the source from the wrong `id` form field again',
  );
  assert.match(
    categoriesServer,
    /removeSource: async \(\{ request, locals \}\) => \{[\s\S]*?await requireAdmin\(locals, \{ redirectTo: '\/admin\/categories' \}\)/,
    'A: removeSource still re-verifies admin authorization',
  );
  // The action must keep its friendly failure mapping (no raw errors).
  assert.match(categoriesServer, /Unable to remove source assignment\./, 'A: removeSource keeps the friendly failure message');

  // A2: the UI delete form posts BOTH identifiers the route expects.
  assert.match(
    categoriesPage,
    /action="\?\/removeSource"[\s\S]*?name="source_id" value=\{mapping\.source_id\}[\s\S]*?name="category_id" value=\{assignCategory\.id\}/,
    'A: the X button posts source_id + category_id to removeSource',
  );

  // A3: wrong/missing ids are rejected by the parser (validation intact).
  const good = new FormData();
  good.set('source_id', A);
  good.set('category_id', CAT1);
  assert.deepEqual(parseSourceAssignmentForm(good), { source_id: A, category_id: CAT1 }, 'A: valid ids parse');

  const missingSource = new FormData();
  missingSource.set('category_id', CAT1);
  assert.throws(() => parseSourceAssignmentForm(missingSource), (error: unknown) => error instanceof StreamingValidationError && error.message === 'Source is required.', 'A: missing source_id rejected with the exact friendly message');

  const missingCategory = new FormData();
  missingCategory.set('source_id', A);
  assert.throws(() => parseSourceAssignmentForm(missingCategory), (error: unknown) => error instanceof StreamingValidationError && error.message === 'Category is required.', 'A: missing category_id rejected');

  const badSource = new FormData();
  badSource.set('source_id', 'not-a-uuid');
  badSource.set('category_id', CAT1);
  assert.throws(() => parseSourceAssignmentForm(badSource), (error: unknown) => error instanceof StreamingValidationError && error.message === 'Source is invalid.', 'A: malformed source id rejected');

  const badCategory = new FormData();
  badCategory.set('source_id', A);
  badCategory.set('category_id', 'nope');
  assert.throws(() => parseSourceAssignmentForm(badCategory), (error: unknown) => error instanceof StreamingValidationError && error.message === 'Category is invalid.', 'A: malformed category id rejected');

  // A4: behavioral — deleteSourceCategory removes ONLY the mapping row and
  // normalizes the remaining category ordering (spy client, RPC success
  // path). It must never touch the global streaming_sources table.
  const spyDelete = createSpyClient({
    streaming_source_categories: [
      { source_id: A, category_id: CAT1, ordering: 0 },
      { source_id: B, category_id: CAT1, ordering: 1 },
      { source_id: C, category_id: CAT1, ordering: 2 },
      { source_id: A, category_id: CAT2, ordering: 0 },
    ],
  });
  await deleteSourceCategory(spyDelete.client as never, B, CAT1);

  const mappingDelete = spyDelete.calls.filter((call) => call.op === 'delete');
  assert.equal(mappingDelete.length, 1, 'A: exactly one delete operation');
  assert.equal(mappingDelete[0].table, 'streaming_source_categories', 'A: the delete targets the mapping table');
  assert.deepEqual(mappingDelete[0].filters, { source_id: B, category_id: CAT1 }, 'A: the delete is scoped to (source_id, category_id)');
  assert.equal(
    spyDelete.calls.filter((call) => call.table === 'streaming_sources').length,
    0,
    'A: the global streaming_sources table is never touched (the source survives)',
  );
  // B was in the middle → remaining A(0) C(2) must be re-normalized through
  // the reorder RPC with the dense order [A, C].
  const reorderRpc = spyDelete.calls.find((call) => call.op === 'rpc');
  assert.ok(reorderRpc, 'A: non-dense remainder triggers the normalize reorder');
  assert.equal(reorderRpc.rpc?.name, 'reorder_category_sources', 'A: normalization goes through the existing atomic RPC');
  assert.deepEqual(reorderRpc.rpc?.args.p_ordered_source_ids, [A, C], 'A: normalization writes the dense remaining order');
  assert.equal(reorderRpc.rpc?.args.p_category_id, CAT1, 'A: normalization only touches the edited category');
  // CAT2's assignment of A is untouched by the CAT1 removal.
  assert.equal(
    spyDelete.calls.filter((call) => call.op === 'update' && call.filters.category_id === CAT2).length,
    0,
    'A: other categories are not reordered',
  );

  // A5: behavioral — already-dense remainder writes nothing extra.
  const spyDense = createSpyClient({
    streaming_source_categories: [
      { source_id: A, category_id: CAT1, ordering: 0 },
      { source_id: B, category_id: CAT1, ordering: 1 },
    ],
  });
  await deleteSourceCategory(spyDense.client as never, B, CAT1);
  assert.equal(
    spyDense.calls.filter((call) => call.op === 'rpc' || call.op === 'update').length,
    0,
    'A: dense remainder (trailing removal) triggers no reorder writes',
  );

  // A6: behavioral — a database error on the mapping delete surfaces the
  // curated registry error (never a raw driver message).
  const spyFail = createSpyClient({ streaming_source_categories: [] }, { failDelete: { code: '42501' } });
  await assert.rejects(
    () => deleteSourceCategory(spyFail.client as never, A, CAT1),
    (error: unknown) => error instanceof Error && error.message === 'You are not authorized to change the streaming registry.',
    'A: mapping-delete failures surface the curated admin error',
  );
}

// ============================================================
// B. Assignment picker — membership visibility + Mavero theming
// ============================================================
{
  // B1: shared derivation — sourceId → categories, registry order.
  const categories = [
    { id: CAT1, name: 'Multi Audio' },
    { id: CAT2, name: 'Org Audio' },
    { id: CAT3, name: 'Subtitled' },
  ];
  const mappings = [
    { source_id: A, category_id: CAT2 }, // A: Org Audio + Multi Audio
    { source_id: A, category_id: CAT1 },
    { source_id: B, category_id: CAT1 }, // B: Multi Audio only
    { source_id: C, category_id: GONE }, // C: mapping to a missing category row
    // D: no mappings at all
  ];
  const memberships = categoryMembershipsBySource(mappings, categories);
  assert.deepEqual(
    memberships.get(A)?.map((entry) => entry.name),
    ['Multi Audio', 'Org Audio'],
    'B: multi-category source lists ALL its categories in registry order',
  );
  assert.deepEqual(
    memberships.get(B)?.map((entry) => entry.name),
    ['Multi Audio'],
    'B: source assigned only elsewhere lists that category',
  );
  assert.deepEqual(memberships.get(C), undefined, 'B: mappings to unknown categories are skipped safely (no blank chip)');
  assert.deepEqual(memberships.get(D), undefined, 'B: unassigned source has no memberships');

  // B2: picker ordering — current category first, others keep registry order.
  assert.deepEqual(
    orderMembershipsForPicker(memberships.get(A) ?? [], CAT2).map((entry) => entry.name),
    ['Org Audio', 'Multi Audio'],
    'B: the current category chip renders first',
  );
  assert.deepEqual(
    orderMembershipsForPicker(memberships.get(B) ?? [], CAT2).map((entry) => entry.name),
    ['Multi Audio'],
    'B: other-category order is preserved for sources not in the current category',
  );
  assert.deepEqual(orderMembershipsForPicker([], CAT1), [], 'B: empty membership list is safe');
  assert.deepEqual(orderMembershipsForPicker(memberships.get(A) ?? [], undefined).map((entry) => entry.name), ['Multi Audio', 'Org Audio'], 'B: missing current category keeps registry order');

  // B3: the picker is derived from already-loaded page data — no client
  // fetches, no per-source queries (the page only reads data.*).
  assert.match(categoriesPage, /import \{ categoryMembershipsBySource, orderMembershipsForPicker \} from '\$lib\/shared\/source-assignment';/, 'B: the page uses the shared derivation helper');
  assert.match(categoriesPage, /const membershipsBySourceId = \$derived\(categoryMembershipsBySource\(data\.sourceCategories, data\.categories\)\)/, 'B: memberships derived once from the loaded rows');
  assert.ok(!categoriesPage.includes('fetch('), 'B: no client-side fetches on the categories page');

  // B4: Mavero-themed picker structure — real radios, no native select.
  assert.match(categoriesPage, /<div class="picker-list" role="radiogroup" aria-labelledby="source-picker-heading">/, 'B: picker is a labeled radiogroup');
  assert.match(categoriesPage, /type="radio"[\s\S]{0,120}name="source_id"[\s\S]{0,120}value=\{source\.id\}/, 'B: real radio inputs carry the source ids (native form semantics)');
  assert.match(categoriesPage, /bind:group=\{pickedSourceId\}/, 'B: selection is bound to picker state');
  const assignForm = categoriesPage.match(/class="assign-form"[\s\S]*?<\/form>/);
  assert.ok(assignForm, 'B: assign form found');
  assert.ok(!assignForm[0].includes('<select'), 'B: no browser-native select in the assign form');
  assert.match(categoriesPage, /disabled=\{!pickedSourceId\}/, 'B: Assign stays disabled until a source is picked');

  // B5: current-category membership is marked as TEXT (not color-only) and
  // duplicate assignment is prevented via the native disabled radio.
  assert.match(categoriesPage, /\{category\.name\} · Current/, 'B: current-category chip carries a readable Current label');
  assert.match(categoriesPage, /disabled=\{assignedHere\}/, 'B: sources already in the current category cannot be re-assigned');
  assert.match(categoriesPage, /const assignedHere = currentSourceIds\.has\(source\.id\)/, 'B: assigned-here state derives from the current category assignments only');

  // B6: sources assigned ELSEWHERE stay assignable (only the current
  // category disables the radio) — the disabled flag is bound to
  // assignedHere, never to memberships length or other-category presence.
  const disabledPin = categoriesPage.match(/disabled=\{assignedHere\}/g);
  assert.ok(disabledPin && disabledPin.length === 1, 'B: exactly one disabled binding — no other condition can block assignment');
  assert.ok(!categoriesPage.includes('disabled={memberships.length'), 'B: being assigned elsewhere never disables a picker row');

  // B7: unassigned state is explicit text.
  assert.match(categoriesPage, /Not assigned/, 'B: unassigned sources show the Not assigned state');

  // B8: picker rows render the source icon + badge chip.
  assert.match(categoriesPage, /<span class="picker-icon" aria-hidden="true"><SourceIcon icon=\{source\.icon\} size=\{16\} \/><\/span>/, 'B: picker rows render the source icon');
  assert.match(categoriesPage, /\{#if badge\}<span class="row-badge" data-badge=\{source\.badge\}>\{badge\}<\/span>\{\/if\}/, 'B: picker rows render the badge chip when present');

  // B9: keyboard/a11y — the custom radios keep focus-visible styling.
  assert.match(categoriesPage, /\.picker-radio:focus-visible \{ outline: 2px solid var\(--color-focus\); outline-offset: 2px; \}/, 'B: picker radios expose a visible focus ring');
}

// ============================================================
// C. Addons — Up/Down removed, Reorder stays, layout cleaned
// ============================================================
{
  // C1: the Up/Down controls are gone from every card.
  assert.ok(!addonsPage.includes('?/moveAddon'), 'C: no moveAddon form remains on the addon card');
  assert.ok(!addonsPage.includes('aria-label={`Move '), 'C: icon-only up/down buttons are gone');
  assert.ok(!addonsPage.includes('mini-btn-icon'), 'C: the icon-only button style is gone (no dead CSS)');

  // C2: the kept action set — Disable/Enable, Refresh, Reorder, Remove.
  for (const action of ['?/setEnabled', '?/refreshAddon', '?/deleteAddon']) {
    assert.ok(addonsPage.includes(action), `C: ${action} remains on the card`);
  }
  assert.match(addonsPage, /openPositionSheet\(addon\)[\s\S]*?Reorder/, 'C: Reorder remains the per-card ordering entry point');
  assert.match(addonsPage, /action="\?\/setAddonPosition"/, 'C: the position sheet posts to setAddonPosition');
  assert.match(addonsPage, /aria-label=\{`Reorder \$\{addon\.name\}`\}/, 'C: Reorder stays labeled for assistive tech');
  assert.match(addonsPage, /aria-label=\{`Remove \$\{addon\.name\}`\}/, 'C: Remove stays labeled for assistive tech');
  assert.match(addonsPage, /Remove addon\?/, 'C: destructive confirmation kept');

  // C3: Remove is visually separated as destructive.
  assert.match(addonsPage, /class="inline-form action-remove"/, 'C: Remove sits in its own destructive group');
  assert.match(addonsPage, /\.action-remove \{ margin-left: 4px; \}/, 'C: Remove carries extra separation');

  // C4: card layout — single-row actions on desktop, full-line left-aligned
  // wrap on mobile.
  assert.match(addonsPage, /\.record-actions \{[\s\S]*?flex-wrap: wrap;/, 'C: actions wrap only when the viewport requires it');
  assert.match(addonsPage, /\.record-actions \{[\s\S]*?margin-left: auto;/, 'C: actions align right on desktop (no empty left space)');
  assert.match(addonsPage, /\.record-actions \{[\s\S]*?gap: 6px;/, 'C: consistent action spacing');
  assert.match(
    addonsPage,
    /@media \(max-width: 640px\) \{[\s\S]*?\.record-actions \{ flex: 1 1 100%; justify-content: flex-start; margin-left: 0; \}/,
    'C: mobile puts the actions on their own full line, left-aligned',
  );

  // C5: the moveAddon ACTION + service remain available server-side
  // (unchanged API — the UI simply no longer renders it).
  assert.match(addonsServer, /moveAddon: async \(\{ request, locals \}\) => \{[\s\S]*?await requireAdmin\(locals, \{ redirectTo: REDIRECT \}\)/, 'C: the moveAddon server action is unchanged and still admin-gated');
  const requireAdminCount = addonsServer.split('await requireAdmin(locals').length - 1;
  assert.equal(requireAdminCount, 9, 'C: load + all 8 mutations still verify admin authorization (9 call sites)');

  // C6: the reordering service itself is untouched (regression pin on the
  // canonical absolute-position action delegating to the service).
  assert.match(addonsServer, /await setAddonPosition\(locals\.supabase, form\.get\('id'\), position\)/, 'C: setAddonPosition still delegates to the service');
}

// ============================================================
// Compact spy client — records every call; supports the exact chains
// deleteSourceCategory uses (delete.eq.eq, select.eq.order, rpc). The
// reorder RPC succeeds by default so normalization completes in one call.
// ============================================================
type SpyCall = {
  table: string;
  op: 'select' | 'insert' | 'update' | 'delete' | 'rpc';
  filters: Record<string, unknown>;
  patch?: Record<string, unknown>;
  rpc?: { name: string; args: Record<string, unknown> };
};

function createSpyClient(
  initial: { streaming_source_categories?: Array<{ source_id: string; category_id: string; ordering: number }> },
  options: { failDelete?: { code: string } } = {},
) {
  const rows = (initial.streaming_source_categories ?? []).map((row) => ({ ...row }));
  const calls: SpyCall[] = [];

  const client = {
    _calls: calls,
    rpc(name: string, args: Record<string, unknown>) {
      calls.push({ table: 'rpc', op: 'rpc', filters: {}, rpc: { name, args } });
      return Promise.resolve({ data: null, error: null });
    },
    from(table: string) {
      const filters: Array<[string, unknown]> = [];
      const orders: string[] = [];
      let op: SpyCall['op'] = 'select';
      let patch: Record<string, unknown> | undefined;
      const record = () => calls.push({ table, op, filters: Object.fromEntries(filters), patch });
      const chain = {
        select() { op = 'select'; return chain; },
        order(column: string) { orders.push(column); return chain; },
        eq(column: string, value: unknown) { filters.push([column, value]); return chain; },
        update(next: Record<string, unknown>) { op = 'update'; patch = next; return chain; },
        delete() { op = 'delete'; return chain; },
        then(resolve: (value: unknown) => void, reject: (reason: unknown) => void) {
          // Promise-style terminal: applies the operation to `rows`.
          try {
            if (op === 'delete') {
              if (options.failDelete) {
                resolve({ data: null, error: { code: options.failDelete.code } });
                return;
              }
              record();
              for (let index = rows.length - 1; index >= 0; index -= 1) {
                const row = rows[index];
                if (filters.every(([column, value]) => row[column as keyof typeof row] === value)) rows.splice(index, 1);
              }
              resolve({ data: null, error: null });
              return;
            }
            if (op === 'update') {
              record();
              for (const row of rows) {
                if (filters.every(([column, value]) => row[column as keyof typeof row] === value)) Object.assign(row, patch ?? {});
              }
              resolve({ data: null, error: null });
              return;
            }
            // select
            let result = rows.filter((row) => filters.every(([column, value]) => row[column as keyof typeof row] === value));
            for (const column of [...orders].reverse()) result = [...result].sort((a, b) => Number(a[column as keyof typeof a]) - Number(b[column as keyof typeof b]));
            calls.push({ table, op: 'select', filters: Object.fromEntries(filters) });
            resolve({ data: result.map((row) => ({ ...row })), error: null });
          } catch (error) {
            reject(error);
          }
        },
      };
      return chain;
    },
  };
  return { client, calls };
}

console.log('Task 13 follow-up admin UX tests passed');
