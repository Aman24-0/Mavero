import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// MAVERO — Search Route Performance Regression Test
//
// BUG 3: Opening /search took ~1–1.25s even with no query/results.
// Root cause: the Search page eagerly imported MediaCard (which pulls
// in lucide icons, IntersectionObserver, navigation helpers) even
// though the initial empty state doesn't need it.
//
// FIX: MediaCard is now lazily imported via dynamic import() when
// results first appear. The initial empty Search route chunk is
// smaller, so the empty Search page becomes interactive faster.

let passed = 0;
function ok(message: string) {
  passed += 1;
  console.log(`  ok ${passed} - ${message}`);
}

const searchPageSource = readFileSync(new URL('../src/routes/search/+page.svelte', import.meta.url), 'utf8');
const searchServerSource = readFileSync(new URL('../src/routes/search/+page.server.ts', import.meta.url), 'utf8');

// ============================================================
// 1. MediaCard is NOT eagerly imported
// ============================================================
console.log('\n1. MediaCard not eagerly imported');

// The old eager import: `import MediaCard from '$components/MediaCard.svelte'`
// must NOT be present.
assert.doesNotMatch(searchPageSource, /^import MediaCard from '\$components\/MediaCard\.svelte'/m,
  'Search page does NOT eagerly import MediaCard');
ok('MediaCard is NOT eagerly imported on the Search route');

// ============================================================
// 2. MediaCard is lazily imported via dynamic import()
// ============================================================
console.log('\n2. MediaCard lazily imported');

assert.match(searchPageSource, /let MediaCardComponent: any = null/,
  'MediaCardComponent state variable exists');
assert.match(searchPageSource, /async function loadMediaCard\(\)/,
  'loadMediaCard function exists');
assert.match(searchPageSource, /const mod = await import\('\$components\/MediaCard\.svelte'\)/,
  'loadMediaCard uses dynamic import() for MediaCard');
assert.match(searchPageSource, /MediaCardComponent = mod\.default/,
  'loadMediaCard assigns the default export');
ok('MediaCard is lazily imported via dynamic import()');

// ============================================================
// 3. Lazy import triggered when results appear
// ============================================================
console.log('\n3. Lazy import triggered on results');

assert.match(searchPageSource, /\$effect\(\(\) => \{[\s\S]*?if \(visibleResults\.length > 0\) void loadMediaCard\(\)/,
  '$effect triggers loadMediaCard when visibleResults.length > 0');
ok('Lazy import fires when results first appear');

// ============================================================
// 4. Template uses MediaCardComponent (not eager MediaCard)
// ============================================================
console.log('\n4. Template uses lazy component');

assert.match(searchPageSource, /\{#if MediaCardComponent\}/,
  'template guards on MediaCardComponent being loaded');
assert.match(searchPageSource, /<MediaCardComponent \{item\} compact \/>/,
  'template renders MediaCardComponent (not eager MediaCard)');
ok('Template uses the lazily-loaded MediaCardComponent');

// ============================================================
// 5. Empty query SSR returns without content search
// ============================================================
console.log('\n5. Empty query SSR returns immediately');

assert.match(searchServerSource, /if \(!query\) \{[\s\S]*?return \{[\s\S]*?items: \[\]/,
  'empty query returns items: [] without calling search()');
// The search() call must be AFTER the empty-query early return, so it
// only runs when there IS a query.
const emptyReturnIdx = searchServerSource.indexOf('if (!query)');
const searchCallIdx = searchServerSource.indexOf('await search(');
assert.ok(emptyReturnIdx >= 0 && searchCallIdx >= 0 && searchCallIdx > emptyReturnIdx,
  'search() is called AFTER the empty-query early return (never for empty query)');
ok('Empty query SSR path does NOT call content search');

// ============================================================
// 6. No artificial delay
// ============================================================
console.log('\n6. No artificial delay');

const searchPageNoComments = searchPageSource.replace(/\/\/[^\n]*/g, '');
// No setTimeout with > 500ms in the Search page (the existing 340ms
// debounce for search input is acceptable — it's not a startup delay).
const setTimeouts = [...searchPageNoComments.matchAll(/setTimeout\([^,]+, (\d+)\)/g)];
for (const m of setTimeouts) {
  const ms = Number(m[1]);
  assert.ok(ms <= 500,
    `setTimeout delay ${ms}ms is <= 500ms (not an artificial startup delay)`);
}
ok('No artificial multi-second startup delay');

// ============================================================
// 7. No navigation interference
// ============================================================
console.log('\n7. No navigation interference');

assert.doesNotMatch(searchPageNoComments, /history\.back/,
  'no history.back()');
assert.doesNotMatch(searchPageNoComments, /history\.pushState/,
  'no history.pushState()');
assert.doesNotMatch(searchPageNoComments, /popstate/,
  'no popstate listener');
ok('Search route does not interfere with navigation');

// ============================================================
// 8. Existing snapshot preserved
// ============================================================
console.log('\n8. Existing snapshot preserved');

assert.match(searchPageSource, /export const snapshot = \{/,
  'Search page snapshot preserved');
assert.match(searchPageSource, /capture:[\s\S]*?query/,
  'snapshot.capture still includes query');
assert.match(searchPageSource, /capture:[\s\S]*?type/,
  'snapshot.capture still includes type');
assert.match(searchPageSource, /capture:[\s\S]*?results/,
  'snapshot.capture still includes results');
ok('Search page snapshot (query/type/results) preserved');

// ============================================================
// 9. ScrollToTop still imported (not deferred — it's lightweight)
// ============================================================
console.log('\n9. ScrollToTop still imported');

assert.match(searchPageSource, /import ScrollToTop from '\$components\/ScrollToTop\.svelte'/,
  'ScrollToTop still eagerly imported (lightweight, no heavy dependency tree)');
ok('ScrollToTop preserved (lightweight, no deferral needed)');

console.log(`\nSearch performance tests passed (${passed} check groups).`);
