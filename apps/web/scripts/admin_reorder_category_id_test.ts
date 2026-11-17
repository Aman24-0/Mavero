import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseCategoryId, StreamingValidationError } from '$lib/server/streaming/validation';

// Admin reposition — the CATEGORY-ID contract of the bulk reorder action.
// 2026-11-17 regression suite (second defect found behind the first one).
//
// Reported: after the move-semantics fix made the reposition form submit for
// the first time, every Apply came back with "Category is required."
//
// Root cause: the sheet's reposition form carries the category as
// `category_id` (the same sheet's category EDIT form owns `id`), while the
// shared `parseId()` reads `id`. `?/reorderSourcesBulk` therefore parsed an
// empty id and rejected the request before it could reach the RPC. Nothing
// server-side had changed — the mismatch had simply never been reached,
// because before the fix the form produced no payload at all.

const CATEGORY = '6c84696c-5bed-4634-adda-dbb6e5d7d4bc';

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

// --- Test 1: the shipped payload (`category_id`) parses ---

assert.equal(parseCategoryId(form({ category_id: CATEGORY })), CATEGORY, 'test 1: category_id is accepted (the shipped client payload)');

// --- Test 2: `id` still works (legacy API / other callers) ---

assert.equal(parseCategoryId(form({ id: CATEGORY })), CATEGORY, 'test 2: id remains accepted as a fallback');

// --- Test 3: category_id wins when both are present ---

assert.equal(
  parseCategoryId(form({ category_id: CATEGORY, id: '00000000-0000-4000-8000-000000000000' })),
  CATEGORY,
  'test 3: category_id takes precedence',
);

// --- Test 4: surrounding whitespace is trimmed ---

assert.equal(parseCategoryId(form({ category_id: `  ${CATEGORY}\n` })), CATEGORY, 'test 4: value is trimmed');

// --- Test 5: the exact reported message for a missing field ---

for (const [label, fields] of [
  ['no field at all', {}],
  ['empty category_id', { category_id: '' }],
  ['blank category_id', { category_id: '   ' }],
  ['empty id', { id: '' }],
] as const) {
  assert.throws(
    () => parseCategoryId(form(fields)),
    (error: unknown) => error instanceof StreamingValidationError && error.message === 'Category is required.',
    `test 5 (${label}): "Category is required." — never a silent pass`,
  );
}

// --- Test 6: shape and length rules are the shared ones (no drift) ---

assert.throws(
  () => parseCategoryId(form({ category_id: 'not-a-uuid' })),
  (error: unknown) => error instanceof StreamingValidationError && error.message === 'Category is invalid.',
  'test 6: malformed ids are rejected with the shared message',
);
assert.throws(
  () => parseCategoryId(form({ category_id: 'a'.repeat(81) })),
  (error: unknown) => error instanceof StreamingValidationError && error.message === 'Category must be 80 characters or fewer.',
  'test 6: the 80-character cap is the shared one',
);

// --- Test 7: custom labels keep the shared message shape ---

assert.throws(
  () => parseCategoryId(form({}), 'Collection'),
  (error: unknown) => error instanceof StreamingValidationError && error.message === 'Collection is required.',
  'test 7: the label is honoured',
);

// --- Test 8: the action actually uses the new parser (regression pin) ---

{
  const actionSource = readFileSync(resolve('src/routes/admin/system/api-sources/+page.server.ts'), 'utf-8');
  const bulkStart = actionSource.indexOf('reorderSourcesBulk: async');
  assert.ok(bulkStart > -1, 'test 8: the bulk reorder action exists');
  const bulkBody = actionSource.slice(bulkStart, actionSource.indexOf('reorderCategories: async', bulkStart));
  assert.ok(bulkBody.includes('parseCategoryId(form)'), 'test 8: the bulk action parses the category via parseCategoryId');
  assert.ok(!bulkBody.includes("parseId(form, 'Category')"), 'test 8: the id-reading parseId call is gone from the bulk action');
  assert.ok(actionSource.includes('parseCategoryId, StreamingValidationError'), 'test 8: parseCategoryId is imported');
}

// --- Test 9: the sheet's reposition form still sends category_id ---

{
  const pageSource = readFileSync(resolve('src/routes/admin/system/api-sources/+page.svelte'), 'utf-8');
  const formStart = pageSource.indexOf('action="?/reorderSourcesBulk"');
  assert.ok(formStart > -1, 'test 9: the reposition form targets ?/reorderSourcesBulk');
  const formBody = pageSource.slice(formStart, pageSource.indexOf('</form>', formStart));
  assert.ok(formBody.includes('name="category_id"'), 'test 9: the form posts category_id (matches the parser)');
  assert.ok(formBody.includes('name="ordered_source_ids"'), 'test 9: the form posts the derived order');
}

console.log('admin_reorder_category_id_test: all assertions passed');
