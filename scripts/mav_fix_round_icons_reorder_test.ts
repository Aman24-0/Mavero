/**
 * MAV Fix Round (2026-10-16) — icons/badges persistence, provider icon
 * upload, and the unified bulk reposition workflow.
 *
 * Covers the five issue groups' server contracts and UI wiring:
 *   Issue 2 — VidStuck .cc: covered by scripts/vidstuck_provider_test.ts
 *             (re-run in this chain); this suite pins the adapter-registry
 *             origin contract + the PlayerShell event.source defense.
 *   Issue 3 — source edit sheet icon/badge persistence (no-change ≠ erase).
 *   Issue 4 — provider icon upload through the EXISTING source pipeline.
 *   Issue 5 — bulk reposition validation (shared helper), bulk parsers,
 *             service-level completeness/uniqueness gates, actions, and the
 *             no-full-page-refresh UI wiring (use:enhance; per-sheet
 *             ordering fields removed).
 *
 * Run: pnpm exec tsx --tsconfig ./jsconfig.json scripts/mav_fix_round_icons_reorder_test.ts
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative: string) => readFileSync(path.join(REPO_ROOT, relative), 'utf8');

const {
  validateRepositionSet, repositionDraftFromEntries, repositionDraftIsDirty,
} = await import('$lib/shared/bulk-reposition');
const {
  parseSourceForm, parseProviderForm, parseBulkOrderedIds, parseBulkOrderings,
} = await import('$lib/server/streaming/validation');
const { reorderSourceOrderings, reorderCategoryOrderings } = await import('$lib/server/streaming/admin-service');

let passed = 0;
function ok(message: string) { passed += 1; console.log(`  ok ${passed} - ${message}`); }

// ---------------------------------------------------------------------------
// Minimal in-memory PostgREST fake (same shape as the retired admin_reorder
// test's client) — enough for reorderSourceOrderings/reorderCategoryOrderings.
// ---------------------------------------------------------------------------
type Row = Record<string, unknown>;
type WriteRecord = { table: string; kind: 'update'; id: string; patch: Row };

function createMockClient(tables: Record<string, Row[]>, opts: { failUpdateOn?: string } = {}) {
  const state: Record<string, Row[]> = Object.fromEntries(Object.entries(tables).map(([k, v]) => [k, v.map((r) => ({ ...r }))]));
  const writes: WriteRecord[] = [];
  const client = {
    _state: state,
    _writes: writes,
    from(table: string) {
      const filters: Array<{ column: string; value: unknown }> = [];
      let op: 'select' | 'update' = 'select';
      let payload: Row | null = null;
      const currentRows = () => {
        let rows = [...(state[table] ?? [])];
        for (const filter of filters) rows = rows.filter((row) => row[filter.column] === filter.value);
        return rows;
      };
      async function execute() {
        if (op === 'select') return { data: currentRows().map((row) => ({ ...row })), error: null };
        const rows = currentRows();
        if (opts.failUpdateOn && table === opts.failUpdateOn) {
          return { data: null, error: { code: 'PGRST116', message: 'mock failure' } };
        }
        for (const row of rows) {
          Object.assign(row, payload as Row);
          writes.push({ table, kind: 'update', id: String(row.id ?? ''), patch: { ...(payload as Row) } });
        }
        return { data: rows[0] ?? null, error: null };
      }
      const chain: Record<string, unknown> = {
        select(_cols?: string) { return chain; },
        update(value: Row) { op = 'update'; payload = value; return chain; },
        eq(column: string, value: unknown) { filters.push({ column, value }); return chain; },
        order() { return chain; },
        limit() { return chain; },
        maybeSingle() { return execute(); },
        single() { return execute(); },
        then(onFulfilled?: (value: unknown) => unknown, onRejected?: (error: unknown) => unknown) {
          return execute().then(onFulfilled, onRejected);
        },
      };
      return chain;
    },
  };
  return client;
}

// ===========================================================================
console.log('\n=== Issue 3 — source icon/badge persistence (no-change ≠ erase) ===\n');
{
  const storedPngIcon = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

  // Base form fields (as the sheet always submits them).
  function sourceForm(overrides: Record<string, string> = {}, files: Record<string, File> = {}) {
    const form = new FormData();
    form.set('provider_id', '00000000-0000-4000-8000-000000000001');
    form.set('name', 'Argon');
    form.set('slug', 'argon');
    form.set('description', 'Edited description'); // the UNRELATED field
    form.set('icon', '');
    form.set('badge', '');
    form.set('enabled', 'true');
    form.set('visibility', 'public');
    form.set('status', 'active');
    form.set('identifier_mode', 'imdb_id');
    form.set('language', '');
    form.set('movie_template', '');
    form.set('series_template', '');
    form.set('anime_template', '');
    form.set('notes', '');
    for (const [key, value] of Object.entries(overrides)) {
      if (value === '__DELETE__') form.delete(key); else form.set(key, value);
    }
    for (const [key, file] of Object.entries(files)) form.set(key, file);
    return form;
  }

  // 1) THE reported defect: upload-mode prefill submits icon='' with NO file.
  const untouchedEdit = await parseSourceForm(sourceForm(), { forUpdate: true });
  assert.equal(untouchedEdit.icon, undefined, 'empty icon on UPDATE = NO CHANGE (undefined)');
  ok('empty icon field on update → icon key undefined (the saved icon is never erased)');

  // 2) CREATE keeps the previous contract: empty → null (no icon).
  const createForm = await parseSourceForm(sourceForm(), { forUpdate: false });
  assert.equal(createForm.icon, null, 'empty icon on CREATE = null');
  ok('empty icon field on create → null (unchanged create contract)');

  // 3) Explicit removal flag → null on update.
  const removeEdit = await parseSourceForm(sourceForm({ icon_remove: 'true' }), { forUpdate: true });
  assert.equal(removeEdit.icon, null, 'icon_remove=true → null');
  ok('explicit icon_remove flag → null (deliberate removal persists)');

  // 4) Uploaded file wins over the submitted icon value.
  const pngBytes = Buffer.from('89504e470d0a1a0a0000000d494844520000000100000001080600000,hex', 'utf8');
  const pngFile = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])], 'icon.png', { type: 'image/png' });
  const uploadEdit = await parseSourceForm(sourceForm({ icon: 'https://example.com/other.png' }, { icon_file: pngFile }), { forUpdate: true });
  assert.ok(typeof uploadEdit.icon === 'string' && uploadEdit.icon.startsWith('data:image/png;base64,'), 'upload becomes a data URL');
  ok('uploaded file takes precedence over the URL field (upload wins)');
  void pngBytes;

  // 5) A non-empty submitted URL is validated + kept.
  const urlEdit = await parseSourceForm(sourceForm({ icon: 'https://example.com/icon.png' }), { forUpdate: true });
  assert.equal(urlEdit.icon, 'https://example.com/icon.png');
  ok('non-empty icon URL on update is validated and stored');

  // 6) A stored PNG data URL resubmitted verbatim revalidates byte-identical.
  const resubmit = await parseSourceForm(sourceForm({ icon: storedPngIcon }), { forUpdate: true });
  assert.equal(resubmit.icon, storedPngIcon);
  ok('stored PNG data URL resubmits byte-identical (re-edit prefill safe)');

  // 7) Ordering: absent field on update → undefined (the sheet no longer
  //    submits it — the bulk editor is authoritative); present → validated.
  const noOrdering = await parseSourceForm(sourceForm({ ordering: '__DELETE__' }), { forUpdate: true });
  assert.equal(noOrdering.ordering, undefined, 'absent ordering on update = no change');
  const withOrdering = await parseSourceForm(sourceForm({ ordering: '40' }), { forUpdate: true });
  assert.equal(withOrdering.ordering, 40);
  const createOrdering = await parseSourceForm(sourceForm({ ordering: '__DELETE__' }), { forUpdate: false });
  assert.equal(createOrdering.ordering, 0, 'create fallback stays 0');
  ok('ordering omitted on update → no change; present → validated; create default preserved');

  // 8) Badges: an untouched canonical value round-trips (chips serialize back).
  const badgeJson = JSON.stringify([{ id: 'ad-free', label: 'Ad-Free', variant: 'positive' }]);
  const badgeEdit = await parseSourceForm(sourceForm({ badge: badgeJson }), { forUpdate: true });
  assert.equal(badgeEdit.badge, badgeJson);
  ok('untouched badges serialize back to the stored canonical JSON (preserved)');

  // 9) The supabase-js write contract: undefined keys are DROPPED from the
  //    update payload (JSON.stringify) — the exact reason the no-change
  //    sentinel is `undefined`.
  const dropped = JSON.stringify({ name: 'Argon', icon: undefined, ordering: undefined, enabled: true });
  assert.ok(!dropped.includes('icon') && !dropped.includes('ordering'));
  ok('undefined icon/ordering keys vanish from the JSON payload (column untouched)');

  // 10) The updateSource action pins forUpdate:true.
  const server = read('src/routes/admin/system/api-sources/+page.server.ts');
  assert.ok(server.includes('parseSourceForm(form, { forUpdate: true })'));
  assert.ok(server.includes('parseProviderForm(form, { forUpdate: true })'));
  ok('updateSource/updateProvider actions use the forUpdate contract');
}

// ===========================================================================
console.log('\n=== Issue 4 — provider icon upload (reuses the source pipeline) ===\n');
{
  function providerForm(overrides: Record<string, string> = {}, files: Record<string, File> = {}) {
    const form = new FormData();
    form.set('name', 'VidStuck');
    form.set('slug', 'vidstuck');
    form.set('adapter_id', 'vidstuck');
    form.set('integration_type', 'template');
    form.set('status', 'active');
    form.set('enabled', 'true');
    form.set('sandbox_policy', 'unrestricted');
    form.set('capabilities', '{}');
    form.set('description', '');
    form.set('notes', '');
    form.set('icon', '');
    for (const [key, value] of Object.entries(overrides)) {
      if (value === '__DELETE__') form.delete(key); else form.set(key, value);
    }
    for (const [key, file] of Object.entries(files)) form.set(key, file);
    return form;
  }

  // URL-only providers keep working (create + update).
  const urlCreate = await parseProviderForm(providerForm({ icon: 'https://example.com/icon.svg' }));
  assert.equal(urlCreate.icon, 'https://example.com/icon.svg');
  ok('provider icon URL contract preserved (create)');
  const urlUpdate = await parseProviderForm(providerForm({ icon: 'https://example.com/icon.svg' }), { forUpdate: true });
  assert.equal(urlUpdate.icon, 'https://example.com/icon.svg');
  ok('provider icon URL contract preserved (update)');

  // Empty: create → null; update → NO CHANGE.
  assert.equal((await parseProviderForm(providerForm())).icon, null);
  assert.equal((await parseProviderForm(providerForm(), { forUpdate: true })).icon, undefined);
  ok('empty provider icon: create → null, update → no change (never erased)');

  // Explicit removal.
  assert.equal((await parseProviderForm(providerForm({ icon_remove: 'true' }), { forUpdate: true })).icon, null);
  ok('provider icon_remove flag → null (explicit removal)');

  // Upload wins; stored data URL revalidates.
  const pngFile = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])], 'p.png', { type: 'image/png' });
  const upload = await parseProviderForm(providerForm({ icon: 'https://example.com/icon.svg' }, { icon_file: pngFile }), { forUpdate: true });
  assert.ok(typeof upload.icon === 'string' && upload.icon.startsWith('data:image/png;base64,'));
  ok('provider upload wins over the URL and persists as a data URL');

  const storedDataUrl = 'data:image/svg+xml;base64,' + Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><rect width="4" height="4"/></svg>').toString('base64');
  const resubmit = await parseProviderForm(providerForm({ icon: storedDataUrl }), { forUpdate: true });
  assert.ok(typeof resubmit.icon === 'string' && resubmit.icon.startsWith('data:image/svg+xml;base64,'));
  ok('stored provider SVG data URL revalidates through the same sanitizer');

  // Invalid inputs rejected (no silent pass-through).
  await assert.rejects(() => parseProviderForm(providerForm({ icon: 'javascript:alert(1)' }), { forUpdate: true }));
  await assert.rejects(() => parseProviderForm(providerForm({ icon: 'data:text/html;base64,PGI+' }), { forUpdate: true }));
  ok('provider icon rejects non-URL text and non-image data URLs (no executables/HTML)');

  // Oversized PNG upload rejected (the shared source bound: 64 KB).
  const bigPng = new File([new Uint8Array(70 * 1024)], 'big.png', { type: 'image/png' });
  await assert.rejects(() => parseProviderForm(providerForm({}, { icon_file: bigPng }), { forUpdate: true }));
  ok('oversized provider upload rejected by the SHARED bound (64 KB)');

  // The provider sheet carries the upload input + preview + remove control.
  const page = read('src/routes/admin/system/api-sources/+page.svelte');
  assert.ok(page.includes('name="icon_file"'), 'provider sheet has an icon_file input');
  assert.ok(page.includes('providerIconPreviewUrl'), 'provider sheet renders the icon preview');
  assert.ok(page.includes('providerIconRemove'), 'provider sheet has the explicit remove control');
  assert.ok(page.includes('enctype="multipart/form-data"'), 'provider form is multipart');
  assert.ok(page.includes('/^(https?:\\/\\/|data:image\\/)'), 'provider rows render URL/data icons via <img>, emoji/text preserved');
  ok('provider sheet UI: URL field + upload + preview + explicit remove + <img> rendering');
}

// ===========================================================================
console.log('\n=== Issue 5 — bulk reposition (shared validation + parsers + service) ===\n');
{
  const entries = [
    { id: 'a', savedPosition: 1 },
    { id: 'b', savedPosition: 2 },
    { id: 'c', savedPosition: 3 },
  ];

  // Prefill = saved values verbatim; untouched draft is valid but not dirty.
  const prefill = repositionDraftFromEntries(entries);
  assert.deepEqual(prefill, { a: '1', b: '2', c: '3' });
  ok('reposition mode prefills every input with the SAVED position');
  assert.equal(repositionDraftIsDirty(entries, prefill), false);
  const oneChanged = { ...prefill, c: '1' };
  assert.equal(repositionDraftIsDirty(entries, oneChanged), true);
  ok('dirty tracking: untouched → not dirty; one edit → dirty');

  // Moving ONE item preserves every unchanged position (the intended order
  // is derived by sorting — a, c(1), b(2)... wait: c=1, a=1 → duplicate! Use
  // a distinct target: c → 2 collides with b... the SINGLE-item move must
  // keep uniqueness: b stays 2 and c becomes 1 — valid.
  const singleMove = validateRepositionSet(entries, { a: '1', b: '2', c: '1' }, { maxPosition: 3 });
  assert.equal(singleMove.valid, false, 'duplicate from a single edit is caught live');
  assert.equal(singleMove.setError, 'Duplicate position: 1. Every row needs a distinct position.');
  ok('a single edit that collides is flagged LIVE (never waits for a reload/db error)');

  const validMove = validateRepositionSet(entries, { a: '2', b: '3', c: '1' }, { maxPosition: 3 });
  assert.equal(validMove.valid, true);
  assert.deepEqual(validMove.orderedIds, ['c', 'a', 'b']);
  ok('a valid full set yields the complete intended order (sorted by position)');

  // Invalid shapes — every rule from the task's live-validation list.
  for (const [draft, why] of [
    [{ a: '', b: '2', c: '3' }, 'blank'],
    [{ a: '0', b: '2', c: '3' }, 'zero'],
    [{ a: '-1', b: '2', c: '3' }, 'negative'],
    [{ a: '1.5', b: '2', c: '3' }, 'decimal'],
    [{ a: 'one', b: '2', c: '3' }, 'non-numeric'],
  ] as Array<[Record<string, string>, string]>) {
    const result = validateRepositionSet(entries, draft, { maxPosition: 3 });
    assert.equal(result.valid, false, `${why} must be invalid`);
    assert.ok(result.setError, `${why} sets an inline error`);
    assert.ok(Object.values(result.errors).some((e) => e !== null), `${why} marks the field`);
  }
  ok('blank / zero / negative / decimal / non-numeric values are rejected live');

  // Dense 1..N contract (category sources): out-of-range rejected.
  const outOfRange = validateRepositionSet(entries, { a: '1', b: '2', c: '4' }, { maxPosition: 3 });
  assert.equal(outOfRange.valid, false);
  assert.match(outOfRange.setError ?? '', /Positions run from 1 to 3/);
  ok('dense contract rejects positions beyond the list length');

  // Global ordering contract: gaps + zero allowed, duplicates still rejected.
  const gapped = validateRepositionSet(
    [{ id: 'x', savedPosition: 0 }, { id: 'y', savedPosition: 40 }],
    { x: '0', y: '40' },
    { minPosition: 0 },
  );
  assert.equal(gapped.valid, true);
  const globalDup = validateRepositionSet(
    [{ id: 'x', savedPosition: 0 }, { id: 'y', savedPosition: 40 }],
    { x: '5', y: '5' },
    { minPosition: 0 },
  );
  assert.equal(globalDup.valid, false);
  ok('global contract permits gaps/zero but still rejects duplicates');

  // --- Form parsers ---
  const form = new FormData();
  form.append('ordered_source_ids', '00000000-0000-4000-8000-0000000000a1');
  form.append('ordered_source_ids', '00000000-0000-4000-8000-0000000000b2');
  assert.deepEqual(parseBulkOrderedIds(form, 'ordered_source_ids', 'Source order').length, 2);
  ok('parseBulkOrderedIds accepts the complete intended order');

  const dupForm = new FormData();
  dupForm.append('ordered_source_ids', '00000000-0000-4000-8000-0000000000a1');
  dupForm.append('ordered_source_ids', '00000000-0000-4000-8000-0000000000a1');
  assert.throws(() => parseBulkOrderedIds(dupForm, 'ordered_source_ids', 'Source order'));
  ok('parseBulkOrderedIds rejects duplicate entries');

  const orderingForm = new FormData();
  orderingForm.set('ordering_00000000-0000-4000-8000-0000000000a1', '0');
  orderingForm.set('ordering_00000000-0000-4000-8000-0000000000b2', '40');
  const orderings = parseBulkOrderings(orderingForm, 'ordering_', 'Source');
  assert.deepEqual(orderings, [
    { id: '00000000-0000-4000-8000-0000000000a1', ordering: 0 },
    { id: '00000000-0000-4000-8000-0000000000b2', ordering: 40 },
  ]);
  ok('parseBulkOrderings accepts the complete prefill set (0/gaps allowed)');

  assert.throws(() => parseBulkOrderings(new FormData(), 'ordering_', 'Source'));
  const badOrdering = new FormData();
  badOrdering.set('ordering_00000000-0000-4000-8000-0000000000a1', 'x');
  assert.throws(() => parseBulkOrderings(badOrdering, 'ordering_', 'Source'));
  ok('parseBulkOrderings rejects empty payloads and non-integer values');

  // --- Service-level gates (server re-validation; never trust the client) ---
  const mockSources = [
    { id: '00000000-0000-4000-8000-0000000000a1', ordering: 0 },
    { id: '00000000-0000-4000-8000-0000000000b2', ordering: 1 },
  ];
  const goodClient = createMockClient({ streaming_sources: mockSources, streaming_categories: [] });
  await reorderSourceOrderings(goodClient as never, [
    { sourceId: '00000000-0000-4000-8000-0000000000a1', ordering: 10 },
    { sourceId: '00000000-0000-4000-8000-0000000000b2', ordering: 20 },
  ]);
  assert.equal(goodClient._writes.length, 2);
  ok('valid bulk source ordering writes every row (server re-validated)');

  await assert.rejects(
    () => reorderSourceOrderings(createMockClient({ streaming_sources: mockSources, streaming_categories: [] }) as never, [
      { sourceId: '00000000-0000-4000-8000-0000000000a1', ordering: 5 },
    ]),
    /every configured source exactly once/,
  );
  ok('incomplete set rejected (missing rows)');

  await assert.rejects(
    () => reorderSourceOrderings(createMockClient({ streaming_sources: mockSources, streaming_categories: [] }) as never, [
      { sourceId: '00000000-0000-4000-8000-0000000000a1', ordering: 5 },
      { sourceId: '00000000-0000-4000-8000-0000000000zz9', ordering: 6 },
    ]),
    /do not exist/,
  );
  ok('unknown source id rejected');

  await assert.rejects(
    () => reorderSourceOrderings(createMockClient({ streaming_sources: mockSources, streaming_categories: [] }) as never, [
      { sourceId: '00000000-0000-4000-8000-0000000000a1', ordering: 5 },
      { sourceId: '00000000-0000-4000-8000-0000000000b2', ordering: 5 },
    ]),
    /Duplicate ordering value 5/,
  );
  ok('duplicate ordering values rejected server-side');

  const mockCategories = [
    { id: '00000000-0000-4000-8000-0000000000a1', ordering: 0 },
    { id: '00000000-0000-4000-8000-0000000000b2', ordering: 1 },
  ];
  const goodCategories = createMockClient({ streaming_sources: [], streaming_categories: mockCategories });
  await reorderCategoryOrderings(goodCategories as never, [
    { categoryId: '00000000-0000-4000-8000-0000000000b2', ordering: 0 },
    { categoryId: '00000000-0000-4000-8000-0000000000a1', ordering: 1 },
  ]);
  assert.equal(goodCategories._writes.length, 2);
  ok('valid bulk category ordering writes every row');

  await assert.rejects(
    () => reorderCategoryOrderings(createMockClient({ streaming_sources: [], streaming_categories: mockCategories }) as never, [
      { categoryId: '00000000-0000-4000-8000-0000000000a1', ordering: 0 },
    ]),
    /every configured category exactly once/,
  );
  ok('category reposition requires the complete set');

  // --- Actions + UI wiring ---
  // 2026-10 admin restructure: content-rules was DELETED. The category
  // bulk-reorder actions + UI moved WITH the Categories tab into
  // /admin/system/api-sources. The contracts below are now asserted
  // against api-sources (the new home) instead of content-rules.
  const apiServer = read('src/routes/admin/system/api-sources/+page.server.ts');
  assert.ok(apiServer.includes('reorderSourcesBulk'), 'bulk reorder action exists (migrated to api-sources)');
  assert.ok(apiServer.includes('parseBulkOrderedIds'), 'bulk action parses ordered ids');
  assert.ok(apiServer.includes('reorderCategorySources(locals.supabase'), 'bulk action uses the ATOMIC service/RPC');
  assert.ok(apiServer.includes('reorderCategories'), 'global category ordering action exists (migrated to api-sources)');
  assert.ok(apiServer.includes('parseCategoryForm(form, { forUpdate: true })'), 'category sheet save no longer clobbers ordering');
  assert.ok(apiServer.includes('reorderSourceOrderings'), 'global source ordering action uses the service');
  assert.ok(apiServer.includes('parseBulkOrderings'), 'global source ordering action parses ordering_<id> sets');
  ok('api-sources server: bulk + global ordering actions wired (categories migrated from content-rules)');

  const apiPage = read('src/routes/admin/system/api-sources/+page.svelte');
  // No full-page refresh: enhanced submissions everywhere on the mutation paths.
  assert.ok(apiPage.includes('use:enhance'), 'api-sources: mutations use use:enhance (no document reload)');
  assert.ok(!apiPage.includes('window.location.reload()'), 'api-sources: no window.location.reload()');
  assert.ok(apiPage.includes('?/reorderSourcesBulk'), 'api-sources: bulk submit target (categories tab)');
  assert.ok(apiPage.includes('?/reorderCategories'), 'api-sources: global category reorder target (categories tab)');
  assert.ok(apiPage.includes('repositionDraftFromEntries'), 'api-sources: prefill from saved values (categories tab)');
  assert.ok(apiPage.includes('validateRepositionSet'), 'api-sources: live shared validation (categories tab)');
  ok('api-sources UI (categories tab): enhanced in-place mutations + prefill + live validation');

  // Redundant per-row controls REMOVED where the bulk flow replaced them.
  assert.ok(!apiPage.includes('name={`position_${row.sourceId}`}' as string), 'per-row position+Apply forms are gone (category sources)');
  assert.ok(!/.a2-position-apply\s*\{/.test(apiPage), 'per-row Apply button styles are gone');
  assert.ok(!apiPage.includes('name="ordering"'), 'the source edit sheet no longer carries a global ordering field');
  assert.ok(!apiPage.includes('<span>Ordering</span>'), 'the category edit sheet no longer carries a global ordering field');
  ok('redundant per-row/per-sheet ordering controls removed (bulk editor is authoritative)');

  // The move-semantics single-row API stays a valid API (tests unchanged).
  // 2026-10 restructure: the action was renamed from `reorderSources` to
  // `moveCategorySource` on api-sources (the original `reorderSources`
  // name collided with the EXISTING source-list reorder action on the
  // same route). The contract — applyCategorySourcePositions — is
  // preserved; only the action name changed (no UI caller either way —
  // the interactive UI uses reorderSourcesBulk).
  assert.ok(apiServer.includes('applyCategorySourcePositions'), 'single-row move API preserved (contract/tests unchanged; action renamed to moveCategorySource to avoid collision)');
  ok('legacy single-row move action remains available (no test weakened)');
}

// ===========================================================================
console.log('\n=== Issue 2 — VidStuck .cc wiring pins (details in vidstuck_provider_test) ===\n');
{
  const registry = read('src/lib/client/player/adapter-registry.ts');
  assert.ok(registry.includes('vidstuck.cc'), 'adapter registry documents the .cc host');
  assert.ok(!/VIDSTUCK_\w*ORIGIN\s*=\s*'https:\/\/vidstuck\.xyz'/.test(read('src/lib/client/player/providers/vidstuck-adapter.ts')), 'no dead .xyz origin constant in the adapter');
  const shell = read('src/lib/components/player/PlayerShell.svelte');
  assert.ok(shell.includes('setActiveIframeWindowResolver'), 'PlayerShell registers the event.source defense');
  const base = read('src/lib/client/player/providers/post-message-utils.ts');
  assert.ok(base.includes('setActiveIframeWindowResolver'), 'base class exposes the resolver');
  assert.ok(base.includes('event.source !== expectedWindow'), 'messages from foreign windows are dropped');
  ok('event.source defense-in-depth wired (shell → base class)');
}

console.log(`\nMAV fix round tests passed: ${passed} checks (icons/badges persistence, provider icon upload, bulk reposition validation/parsers/service/UI, VidStuck wiring).`);
