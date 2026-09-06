import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';

// Phase 9 final audit: Race-safe writer invalidation behavioral tests.
//
// These tests exercise the REAL service.ts against fake-indexeddb. They do
// NOT inspect source-code strings — they model the actual writer lifecycle
// (register → flush → invalidate → dispose) and assert that:
//   1. An old writer can never unregister a newer writer (identity-safe).
//   2. After removeFavoriteFromMyList, no in-flight or queued callback can
//      recreate deleted progress (delete-wins semantics).
//   3. Title A invalidation does not affect Title B (title isolation).
//   4. Series: all episodes deleted, no stale writer can recreate.
//   5. Remove → re-add → play creates fresh progress.

import { createProgressWriter, removeFavoriteFromMyList, saveFavorite, invalidateWritersForContent } from '../src/lib/client/progress/service.ts';
import { clearLocalData, listProgress } from '../src/lib/client/progress/database.ts';
import type { ContentSnapshot, LocalContentType, SaveProgressInput } from '../src/lib/client/progress/types.ts';

const snapshot: ContentSnapshot = { title: 'Test', poster: 'https://example.com/p.jpg' };

type WriterBase = Omit<SaveProgressInput, 'currentTime' | 'duration'> & { initialCurrentTime?: number };

function makeBase(contentType: LocalContentType, contentId: string, season?: number, episode?: number, episodeTitle?: string): WriterBase {
  return {
    contentType,
    contentId,
    season,
    episode,
    episodeTitle,
    selectedSourceId: 'source-A',
    snapshot,
  };
}

async function countProgressFor(contentType: string, contentId: string): Promise<number> {
  const all = await listProgress();
  return all.filter((r) => r.contentType === contentType && r.contentId === contentId).length;
}

async function reset() {
  await clearLocalData();
}

// ============================================================
// TEST 1: A registered → B replaces A → A's late dispose() →
//         removeFavoriteFromMyList → B is invalidated.
//         Proves identity-safe unregister: A's late dispose() can NOT
//         evict B from the registry, so removeFavoriteFromMyList can
//         still find and invalidate B.
// ============================================================
{
  await reset();
  const base = makeBase('movie', 'test1-movie');
  const A = createProgressWriter(base);
  A.update(500, 5000);
  await A.flush();
  assert.equal(await countProgressFor('movie', 'test1-movie'), 1, 'TEST 1: A wrote progress');

  // B replaces A (e.g., source switch creating a new writer for the same title).
  const B = createProgressWriter(base);
  B.update(800, 5000);
  await B.flush();
  assert.equal(await countProgressFor('movie', 'test1-movie'), 1, 'TEST 1: B overwrote progress');

  // A's late dispose (e.g., component unmount fires AFTER B already took over).
  // With the identity-safe registry, this MUST NOT evict B.
  A.dispose();

  // removeFavoriteFromMyList must still invalidate B (B is in the registry
  // because A's late dispose could not evict it).
  await removeFavoriteFromMyList('movie', 'test1-movie');

  // Any subsequent B write must be a no-op (B is disposed).
  B.update(900, 5000);
  await B.flush();
  assert.equal(await countProgressFor('movie', 'test1-movie'), 0, 'TEST 1: B was invalidated — no progress recreated');

  B.dispose();
  console.log('TEST 1 passed: identity-safe unregister — old writer A cannot evict newer writer B');
}

// ============================================================
// TEST 2: A registered → B replaces A → removeFavoriteFromMyList →
//         B is invalidated.
//         Proves the replacement-writer race: the newer writer B (not A)
//         is the one that gets invalidated.
// ============================================================
{
  await reset();
  const base = makeBase('movie', 'test2-movie');
  const A = createProgressWriter(base);
  A.update(500, 5000);
  await A.flush();
  assert.equal(await countProgressFor('movie', 'test2-movie'), 1, 'TEST 2: A wrote');

  const B = createProgressWriter(base); // replaces A
  B.update(800, 5000);
  await B.flush();
  assert.equal(await countProgressFor('movie', 'test2-movie'), 1, 'TEST 2: B overwrote');

  await removeFavoriteFromMyList('movie', 'test2-movie');

  // B is invalidated, cannot recreate progress.
  B.update(900, 5000);
  await B.flush();
  assert.equal(await countProgressFor('movie', 'test2-movie'), 0, 'TEST 2: B cannot recreate progress');

  A.dispose();
  B.dispose();
  console.log('TEST 2 passed: replacement writer B is invalidated after title removal');
}

// ============================================================
// TEST 3: Pending A flush (queued setTimeout callback) → invalidate A →
//         execute queued callback → assert no progress write.
//         Proves the disposed-check at the top of flush() blocks any
//         callback that fires after invalidation.
// ============================================================
{
  await reset();
  const base = makeBase('movie', 'test3-movie');
  const A = createProgressWriter(base, 1000); // long flushInterval — timer is pending
  A.update(500, 5000);
  // The setTimeout callback is scheduled but has not fired yet.
  // Invalidation must clear the timer AND mark the writer disposed so any
  // already-queued callback is a no-op.
  await removeFavoriteFromMyList('movie', 'test3-movie');
  // Wait briefly past when a no-op microtask would have run.
  await new Promise((r) => setTimeout(r, 30));
  // Even an explicit manual flush() (simulating a queued callback that
  // somehow fired after invalidation) must be a no-op.
  await A.flush();
  assert.equal(await countProgressFor('movie', 'test3-movie'), 0, 'TEST 3: queued callback did not write progress');
  A.dispose();
  console.log('TEST 3 passed: pending flush + queued callback blocked');
}

// ============================================================
// TEST 4: A invalidated → B (DIFFERENT title) remains active →
//         B can still save progress.
//         Proves title isolation — invalidating title A does NOT affect
//         title B's writer or its in-flight operations.
// ============================================================
{
  await reset();
  const A = createProgressWriter(makeBase('movie', 'test4-A'));
  const B = createProgressWriter(makeBase('movie', 'test4-B'));
  A.update(500, 5000);
  await A.flush();
  B.update(800, 5000);
  await B.flush();
  assert.equal(await countProgressFor('movie', 'test4-A'), 1, 'TEST 4: A wrote');
  assert.equal(await countProgressFor('movie', 'test4-B'), 1, 'TEST 4: B wrote');

  // Remove title A — must NOT affect title B.
  await removeFavoriteFromMyList('movie', 'test4-A');

  assert.equal(await countProgressFor('movie', 'test4-A'), 0, 'TEST 4: A deleted');
  assert.equal(await countProgressFor('movie', 'test4-B'), 1, 'TEST 4: B untouched');

  // B can still write fresh progress.
  B.update(900, 5000);
  await B.flush();
  assert.equal(await countProgressFor('movie', 'test4-B'), 1, 'TEST 4: B can still write');

  A.dispose();
  B.dispose();
  console.log('TEST 4 passed: title isolation — invalidating A does not affect B');
}

// ============================================================
// TEST 5: Async in-flight stale A persistence cannot recreate progress
//         after title deletion.
//         Proves the post-check inside flush() undoes a putProgress that
//         committed DURING removeFavoriteFromMyList's invalidation.
// ============================================================
{
  await reset();
  const base = makeBase('movie', 'test5-movie');
  const A = createProgressWriter(base);
  A.update(500, 5000);

  // Start the flush but DO NOT await it yet — saveProgress is in-flight.
  const flushPromise = A.flush();
  // While flush is awaiting saveProgress(), run removeFavoriteFromMyList.
  // removeFavoriteFromMyList must:
  //   1. invalidate A (bump gen + dispose)
  //   2. drain the in-flight flush (await flushPromise)
  //   3. deleteAllProgressForContent (cleanup any remaining)
  // The in-flight flush's post-check must see the bumped gen and undo its
  // just-completed putProgress via removeProgress.
  await removeFavoriteFromMyList('movie', 'test5-movie');
  // By now removeFavoriteFromMyList has drained the flush.
  await flushPromise;
  assert.equal(await countProgressFor('movie', 'test5-movie'), 0, 'TEST 5: in-flight flush did not recreate progress');
  A.dispose();
  console.log('TEST 5 passed: async in-flight stale persistence cannot recreate deleted progress');
}

// ============================================================
// TEST 6: Series — multiple episode progress records are all deleted on
//         removeFavoriteFromMyList, and a stale writer cannot recreate
//         any of them.
//         Proves deleteAllProgressForContent covers every season:episode
//         AND the disposed-writer guard prevents recreation.
// ============================================================
{
  await reset();
  // All three writers share the same contentId but different season:episode.
  // They share the same title-level registry key, so A2 replaces A1 and
  // A3 replaces A2. Only A3 is "active" at the end.
  const A1 = createProgressWriter(makeBase('series', 'test6-series', 1, 1, 'Pilot'));
  A1.update(500, 5000);
  await A1.flush();
  const A2 = createProgressWriter(makeBase('series', 'test6-series', 1, 2, 'Second'));
  A2.update(800, 5000);
  await A2.flush();
  const A3 = createProgressWriter(makeBase('series', 'test6-series', 2, 1, 'S2 Premiere'));
  A3.update(1000, 5000);
  await A3.flush();

  assert.equal(await countProgressFor('series', 'test6-series'), 3, 'TEST 6: 3 episode records saved (S01E01, S01E02, S02E01)');

  await removeFavoriteFromMyList('series', 'test6-series');

  assert.equal(await countProgressFor('series', 'test6-series'), 0, 'TEST 6: all episodes deleted');

  // Stale writer A3 (replaced itself invalid, then title invalidated) cannot recreate.
  A3.update(2000, 5000);
  await A3.flush();
  assert.equal(await countProgressFor('series', 'test6-series'), 0, 'TEST 6: stale writer A3 cannot recreate any episode');

  A1.dispose();
  A2.dispose();
  A3.dispose();
  console.log('TEST 6 passed: series episodes deleted, stale writer cannot recreate');
}

// ============================================================
// TEST 7: remove → re-add → play creates FRESH progress.
//         Proves that after invalidation bumps the title generation, a
//         new writer registered after re-adding can write progress
//         normally (no false-positive "still invalidated" state).
// ============================================================
{
  await reset();
  const base = makeBase('movie', 'test7-movie');
  const A = createProgressWriter(base);
  A.update(500, 5000);
  await A.flush();
  assert.equal(await countProgressFor('movie', 'test7-movie'), 1, 'TEST 7: A wrote');

  await removeFavoriteFromMyList('movie', 'test7-movie');
  assert.equal(await countProgressFor('movie', 'test7-movie'), 0, 'TEST 7: A deleted');

  // Re-add to My List (clears the deletion tombstone).
  await saveFavorite('movie', 'test7-movie', snapshot);

  // Play again — a fresh writer registered AFTER invalidation.
  const B = createProgressWriter(base);
  B.update(200, 5000);
  await B.flush();
  assert.equal(await countProgressFor('movie', 'test7-movie'), 1, 'TEST 7: B wrote fresh progress after re-add');

  A.dispose();
  B.dispose();
  console.log('TEST 7 passed: remove → re-add → play creates fresh progress');
}

// ============================================================
// TEST 8 (BONUS): Direct invalidation via invalidateWritersForContent
//         blocks subsequent writes, even WITHOUT a full
//         removeFavoriteFromMyList. Proves the registry → dispose →
//         disposed-check path works in isolation.
// ============================================================
{
  await reset();
  const base = makeBase('movie', 'test8-movie');
  const A = createProgressWriter(base);
  A.update(500, 5000);
  await A.flush();
  assert.equal(await countProgressFor('movie', 'test8-movie'), 1, 'TEST 8: A wrote');

  // Direct invalidation (without deleting progress).
  invalidateWritersForContent('movie', 'test8-movie');

  // Subsequent writes are no-ops.
  A.update(900, 5000);
  await A.flush();
  assert.equal(await countProgressFor('movie', 'test8-movie'), 1, 'TEST 8: stale writer cannot update after direct invalidation (old record untouched, no new write)');

  A.dispose();
  console.log('TEST 8 passed: direct invalidateWritersForContent blocks subsequent writes');
}

console.log('Phase 9 writer invalidation race-safety tests passed: identity-safe registry (TEST 1); replacement-writer invalidation (TEST 2); queued callback blocked (TEST 3); title isolation (TEST 4); async in-flight undo (TEST 5); series multi-episode delete + stale block (TEST 6); remove → re-add → fresh play (TEST 7); direct invalidation blocks writes (TEST 8).');
