import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// Regression coverage for the two bugs fixed in this commit:
//   BUG 1 — Search results disappear after Back navigation.
//   BUG 2 — Listing-page scroll position is lost after Back navigation.
//
// Both bugs share the same root cause: the app initialized local component
// state from `data`/`page.url` once at mount and never re-synced when
// navigation changed those inputs. The fix:
//   - Search page: an `$effect` re-syncs `query`/`type`/`results`/
//     `errorMessage` from `data` whenever navigation changes `data`.
//   - ScrollRestore component: a centralized module saves scroll
//     positions keyed by URL in `beforeNavigate`, calls
//     `disableScrollHandling()` in `onNavigate` for back-like navigations
//     that have a saved scroll, and restores the saved scroll in
//     `afterNavigate` (synchronously + rAF safety net).

const searchSource = await readFile(new URL('../src/routes/search/+page.svelte', import.meta.url), 'utf8');
const layoutSource = await readFile(new URL('../src/routes/+layout.svelte', import.meta.url), 'utf8');
const scrollRestoreSource = await readFile(new URL('../src/lib/components/ScrollRestore.svelte', import.meta.url), 'utf8');

// ============================================================================
// BUG 1 — Search state restoration after Back navigation
// ============================================================================
// The fix uses `$effect` + `untrack` to re-sync local state from `data`
// when navigation changes it, without taking a reactive dependency on the
// state variables being written (which would cause a feedback loop when
// the user types into the search input).
{
  assert.match(searchSource, /import \{ onDestroy, untrack \} from 'svelte'/,
    'Search page must import untrack from svelte for the data-sync effect');

  assert.match(searchSource, /\$effect\(\(\) => \{[\s\S]*?const nextQuery = data\.query/,
    'Search page must have an $effect that reads data.query');

  assert.match(searchSource, /untrack\(\(\) => \{[\s\S]*?if \(query !== nextQuery\) query = nextQuery/,
    'Search page $effect must write query inside untrack to avoid feedback loops');

  assert.match(searchSource, /if \(results !== nextItems\) results = nextItems/,
    'Search page $effect must sync results array from data.items');

  assert.match(searchSource, /if \(type !== nextType\) type = nextType/,
    'Search page $effect must sync type filter from data.type');

  assert.match(searchSource, /if \(errorMessage !== nextError\) errorMessage = nextError/,
    'Search page $effect must sync errorMessage from data.errorMessage');

  // The X clear button must still exist and clear the query.
  assert.match(searchSource, /function clearQuery\(\)/,
    'Search page must still have clearQuery function');
  assert.match(searchSource, /aria-label="Clear search"/,
    'Search page X button must retain aria-label');

  // The three-filter chip layout must be unchanged.
  assert.match(searchSource, /\{ value: 'All', label: 'All' \}/);
  assert.match(searchSource, /\{ value: 'Movie', label: 'Movie' \}/);
  assert.match(searchSource, /\{ value: 'TV Show', label: 'TV Show' \}/);

  // No Anime filter must be present.
  assert.doesNotMatch(searchSource, /\{ value: 'Anime'/,
    'Search page must NOT have an Anime filter chip');
  assert.doesNotMatch(searchSource, /type.*'All' \| 'Movies' \| 'Series' \| 'Anime'/,
    'Search page TypeFilter union must NOT include Anime');

  // No service/genre/sort/Clear-all filters must be present.
  assert.doesNotMatch(searchSource, /All services|All genres|Release date|Clear all/,
    'Search page must NOT have service/genre/sort/Clear-all filters');
}

// ============================================================================
// BUG 2 — Global listing-page scroll restoration after Back navigation
// ============================================================================
// The fix introduces a centralized ScrollRestore component mounted once in
// the root layout. It saves scroll positions keyed by URL in `beforeNavigate`
// and restores them on `popstate` (browser Back/Forward) and `goto` (in-page
// Back button like DetailPage's back-arrow icon) navigations.
{
  assert.match(layoutSource, /import ScrollRestore from '\$components\/ScrollRestore\.svelte'/,
    'Root layout must import ScrollRestore');
  assert.match(layoutSource, /<ScrollRestore \/>/,
    'Root layout must mount ScrollRestore');

  // ScrollRestore component contract
  assert.match(scrollRestoreSource, /import \{ beforeNavigate, onNavigate, afterNavigate, disableScrollHandling \} from '\$app\/navigation'/,
    'ScrollRestore must import beforeNavigate, onNavigate, afterNavigate, disableScrollHandling');

  // Save scroll on beforeNavigate keyed by URL.
  assert.match(scrollRestoreSource, /beforeNavigate\(\(navigation\) => \{[\s\S]*?if \(navigation\.from\) \{[\s\S]*?saveScroll\(navigation\.from\.url\)/,
    'ScrollRestore must save scroll for navigation.from.url in beforeNavigate');

  // The save is keyed by URL (pathname + search + hash), not by history index.
  assert.match(scrollRestoreSource, /function keyOf\(url[\s\S]*?return `\$\{url\.pathname\}\$\{url\.search\}\$\{url\.hash\}`/,
    'ScrollRestore must key scroll positions by pathname+search+hash');

  // onNavigate: disable SvelteKit autoscroll when there's a saved scroll
  // AND navigation is back-like (popstate or goto).
  assert.match(scrollRestoreSource, /onNavigate\(\(navigation\) => \{[\s\S]*?disableScrollHandling\(\)/,
    'ScrollRestore must call disableScrollHandling in onNavigate');

  // Only restore for back-like navigation types (popstate = browser Back/Fwd,
  // goto = programmatic Back like DetailPage back-arrow).
  assert.match(scrollRestoreSource, /function isBackLikeNavigation\(type: string\): boolean \{[\s\S]*?return type === 'popstate' \|\| type === 'goto'/,
    'ScrollRestore must treat popstate and goto as back-like');

  // afterNavigate: restore synchronously + rAF safety net.
  assert.match(scrollRestoreSource, /afterNavigate\(\(navigation\) => \{[\s\S]*?restoreScroll\(saved\)/,
    'ScrollRestore must restore scroll in afterNavigate');
  assert.match(scrollRestoreSource, /requestAnimationFrame\(\(\) => \{[\s\S]*?restoreScroll\(saved\)/,
    'ScrollRestore must re-restore on rAF for pages that grow after data load');

  // Don't restore when destination has a hash (let SvelteKit scrollIntoView).
  assert.match(scrollRestoreSource, /if \(toUrl\.hash\) return/,
    'ScrollRestore must skip restore when destination has a hash');

  // Don't restore on watch route (player has its own viewport handling).
  assert.match(scrollRestoreSource, /const SKIP_RESTORE_PREFIXES = \['\/watch\/'\]/,
    'ScrollRestore must skip restore for /watch/ routes');

  // LRU bound on the saved-positions map.
  assert.match(scrollRestoreSource, /const MAX_ENTRIES = 80/,
    'ScrollRestore must bound the scroll map to MAX_ENTRIES=80');
  assert.match(scrollRestoreSource, /while \(scrollMap\.size > MAX_ENTRIES\)/,
    'ScrollRestore must evict oldest entries when map exceeds MAX_ENTRIES');

  // Don't fight forward navigation (link/form/enter) — let SvelteKit scrollTo(0,0).
  // The isBackLikeNavigation check ensures forward navigation is NOT restored.
  assert.doesNotMatch(scrollRestoreSource, /type === 'link' \|\| type === 'form'/,
    'ScrollRestore must NOT treat link/form navigations as back-like');
}

console.log('Search-state-restoration and global scroll-restoration regression tests passed');
