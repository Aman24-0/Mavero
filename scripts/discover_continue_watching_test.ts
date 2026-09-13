// ============================================================================
// PHASE E — Continue Watching regression test (Discover rail).
//
// Root cause this test guards against:
//   DiscoverPage.svelte declared `localContinueLoaded` / `localContinueItems`
//   as plain `let` while a Svelte 5 `$derived` reads them. In runes mode a
//   plain `let` is NOT reactive (assignments compile to plain JS writes, the
//   derived tracks nothing), so after the async loadContinue() resolve the
//   derived never re-evaluated and `{#if localContinue.length}` stayed false
//   forever — the rail silently disappeared even though My List rendered the
//   same records (My List declares its state with $state).
//
// Part 1 (behavioral): canonical `continueWatchingRecords` semantics —
//   active progress, manual-watching fallback with zero progress, completed
//   exclusion, dedupe, ordering, guest/local derivation, presenter mapping.
// Part 2 (reactivity contract): the exact DiscoverPage runes declarations
//   that make the async load path reach the rendered rail. These assertions
//   FAIL on the pre-fix file, so the regression cannot silently return.
// ============================================================================
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { readFile } from 'node:fs/promises';
import { continueWatchingRecords } from '../src/lib/shared/progress-merge.ts';
import { getContinueWatching } from '../src/lib/client/progress/service.ts';
import { clearLocalData, listProgress, putFavorite, putProgress } from '../src/lib/client/progress/database.ts';
import { progressToMedia } from '../src/lib/client/progress/presenter.ts';
import type { FavoriteRecord, WatchProgressRecord } from '../src/lib/client/progress/types.ts';

// ============================================================================
// Part 1 — canonical Continue Watching derivation (shared source of truth).
// ============================================================================

const snapshot = { title: 'Sample Title', poster: 'https://example.com/poster.jpg' };
const snapshotB = { title: 'Manual Watch', poster: 'https://example.com/manual.jpg' };
const snapshotC = { title: 'Finished Show', poster: 'https://example.com/finished.jpg' };
const snapshotD = { title: 'Both Sources', poster: 'https://example.com/both.jpg' };

const activeProgress: WatchProgressRecord = {
  key: 'movie:sample-title:-:-',
  contentType: 'movie',
  contentId: 'sample-title',
  snapshot,
  currentTime: 3600, // 26% of a ~3h52m movie (matches the realistic production record shape)
  duration: 13944,
  completionState: 'in_progress',
  lastWatchedAt: 900,
  updatedAt: 900,
};

const completedProgress: WatchProgressRecord = {
  key: 'series:finished-show:1:2',
  contentType: 'series',
  contentId: 'finished-show',
  season: 1,
  episode: 2,
  snapshot: snapshotC,
  currentTime: 3000,
  duration: 3000,
  completionState: 'completed',
  lastWatchedAt: 950,
  updatedAt: 950,
};

const watchingFavoriteWithZeroProgress: FavoriteRecord = {
  key: 'movie:manual-watch',
  contentType: 'movie',
  contentId: 'manual-watch',
  snapshot: snapshotB,
  status: 'watching',
  createdAt: 100,
  updatedAt: 990,
};

const watchingFavoriteForActiveProgress: FavoriteRecord = {
  key: 'movie:sample-title',
  contentType: 'movie',
  contentId: 'sample-title',
  snapshot,
  status: 'watching',
  createdAt: 100,
  updatedAt: 890,
};

const plannedFavorite: FavoriteRecord = {
  key: 'movie:planned-title',
  contentType: 'movie',
  contentId: 'planned-title',
  snapshot: { title: 'Planned Title', poster: 'https://example.com/planned.jpg' },
  status: 'planned',
  createdAt: 100,
  updatedAt: 980,
};

{
  // 1. Valid active progress produces a Continue Watching record.
  const records = continueWatchingRecords([activeProgress], []);
  assert.equal(records.length, 1, 'active progress must produce Continue Watching');
  assert.equal(records[0]?.contentId, 'sample-title');
  assert.equal(records[0]?.completionState, 'in_progress');

  // 2. A manually marked "watching" favorite with ZERO progress still
  //    produces a Continue Watching entry (the production report case).
  const manual = continueWatchingRecords([], [watchingFavoriteWithZeroProgress]);
  assert.equal(manual.length, 1, 'watching favorite with zero progress must appear via manual fallback');
  assert.equal(manual[0]?.contentId, 'manual-watch');
  assert.equal(manual[0]?.currentTime, 0);
  assert.equal(manual[0]?.completionState, 'in_progress');

  // 3. Completed progress is excluded from Continue Watching.
  const completedOnly = continueWatchingRecords([completedProgress], []);
  assert.equal(completedOnly.length, 0, 'completed progress must NOT appear');

  // 4. Progress with currentTime <= 0 is not active progress.
  const zeroProgress: WatchProgressRecord = { ...activeProgress, currentTime: 0, lastWatchedAt: 900, updatedAt: 900 };
  assert.equal(continueWatchingRecords([zeroProgress], []).length, 0, 'zero-currentTime progress without a watching favorite must NOT appear');

  // 5. A "planned" favorite is not Continue Watching.
  assert.equal(continueWatchingRecords([], [plannedFavorite]).length, 0, 'planned favorite must NOT appear');

  // 6. Dedupe: a title with BOTH a watching favorite and active progress
  //    appears exactly once (no duplicate rail cards).
  const both = continueWatchingRecords([activeProgress], [watchingFavoriteForActiveProgress]);
  assert.equal(both.length, 1, 'duplicate title must be deduplicated');
  assert.equal(both[0]?.contentId, 'sample-title');

  // 7. Newest activity first.
  const ordered = continueWatchingRecords(
    [activeProgress, completedProgress],
    [watchingFavoriteWithZeroProgress, watchingFavoriteForActiveProgress],
  );
  const stamps = ordered.map((record) => record.lastWatchedAt);
  assert.deepEqual([...stamps].sort((a, b) => b - a), stamps, 'records sorted by lastWatchedAt descending');
  assert.equal(ordered[0]?.contentId, 'manual-watch', 'most recent activity first');

  // 8. Presenter mapping: records convert to MediaItem with resume context.
  const media = progressToMedia(continueWatchingRecords([activeProgress], [])[0]!);
  assert.equal(media.title, 'Sample Title');
  assert.equal(media.type, 'movie');
  assert.equal(media.resumeHref, '/watch/movie/sample-title');
  assert.ok(typeof media.progress === 'number', 'progress percent present');
  assert.equal(media.progress, Math.min(100, Math.round((3600 / 13944) * 100)), 'progress percent reflects real watch fraction');
  const manualMedia = progressToMedia(continueWatchingRecords([], [watchingFavoriteWithZeroProgress])[0]!);
  assert.equal(manualMedia.progress ?? 0, 0, 'zero-progress fallback renders 0 percent without crashing');
}

{
  // 9. Guest / local behavior: getContinueWatching derives from the LOCAL
  //    IndexedDB state only — no Supabase dependency for guests.
  await clearLocalData();
  await putProgress(activeProgress);
  await putFavorite(watchingFavoriteWithZeroProgress);
  await putFavorite(plannedFavorite);
  const local = await getContinueWatching();
  assert.equal(local.length, 2, 'guest derivation: active progress + manual watching only');
  assert.deepEqual(
    local.map((record) => record.contentId).sort(),
    ['manual-watch', 'sample-title'],
    'planned favorite excluded from guest Continue Watching',
  );
  assert.equal((await listProgress()).length, 1, 'local progress untouched by derivation');
  await clearLocalData();
}

// ============================================================================
// Part 2 — DiscoverPage reactivity contract (the actual Phase E regression).
// ============================================================================

const discoverPage = await readFile(new URL('../src/lib/components/DiscoverPage.svelte', import.meta.url), 'utf8');

{
  // A. The async-load state MUST be $state — plain `let` silently breaks the
  //    $derived chain and leaves the rail empty. This is the exact regression.
  assert.match(discoverPage, /let localContinueLoaded = \$state\(false\)/, 'localContinueLoaded must be $state (runes reactivity)');
  assert.doesNotMatch(discoverPage, /let localContinueLoaded = false;/, 'plain-let localContinueLoaded regression must not return');
  assert.match(discoverPage, /let localContinueItems = \$state<MediaItem\[\]>\(\[\]\)/, 'localContinueItems must be $state (runes reactivity)');
  assert.doesNotMatch(discoverPage, /let localContinueItems: MediaItem\[\] = \[\];/, 'plain-let localContinueItems regression must not return');

  // B. The derived chain that feeds the rail conditional stays intact.
  assert.match(discoverPage, /let localContinue = \$derived\(localContinueLoaded \? localContinueItems : \[\]\)/, 'localContinue derived from loaded state');
  assert.match(discoverPage, /\{#if localContinue\.length\}<ContentRail title="Continue watching"/, 'rail renders only from derived records — never hardcoded');
  assert.match(discoverPage, /href="\/my-list\?status=watching"/, 'rail view-all target unchanged');

  // C. Authenticated flow consumes syncAuthenticatedState() and feeds the
  //    canonical derivation — no second Continue Watching algorithm.
  assert.match(discoverPage, /async function loadContinue\(\)/, 'loadContinue exists');
  assert.match(discoverPage, /if \(page\.data\.user\) \{ const cloud = await syncAuthenticatedState\(\); return continueWatchingRecords\(cloud\.progress, cloud\.favorites\); \}/, 'authenticated path derives from synced cloud state');
  assert.match(discoverPage, /return getContinueWatching\(\);/, 'guest path uses the local derivation service');
  assert.doesNotMatch(discoverPage, /completionState|currentTime|lastWatchedAt/, 'DiscoverPage must NOT inline progress-merge logic');
  assert.match(discoverPage, /localContinueItems = records\.map\(progressToMedia\)/, 'records convert through the shared presenter');

  // D. Initial load + Phase 9 refresh protections all assign the reactive state.
  assert.match(discoverPage, /void loadContinue\(\)\.then\(\(records\) => \{ if \(cancelled\) return; localContinueItems = records\.map\(progressToMedia\); localContinueLoaded = true; \}\);/, 'onMount assigns both reactive states');
  assert.match(discoverPage, /document\.addEventListener\('visibilitychange', handleDocumentVisibility\)/, 'visibilitychange reload intact');
  assert.match(discoverPage, /window\.addEventListener\('pageshow', handlePageShow\)/, 'pageshow/BFCache reload intact');
  assert.match(discoverPage, /void loadContinue\(\)\.then\(\(records\) => \{ if \(destroyed\) return; localContinueItems = records\.map\(progressToMedia\); \}\);/, 'visibility/pageshow handlers refresh the reactive items');

  // E. No polling / request loops introduced for Continue Watching.
  assert.doesNotMatch(discoverPage, /setInterval/, 'no polling intervals on Discover');
}

console.log('Discover Continue Watching regression tests passed: canonical derivation (active progress, manual-watching zero-progress fallback, completed/zero/planned exclusion, dedupe, ordering, presenter mapping, guest-local path) + DiscoverPage runes reactivity contract ($state declarations, derived chain, rail conditional, authenticated sync consumption, Phase 9 visibility/BFCache reloads, no polling).');
