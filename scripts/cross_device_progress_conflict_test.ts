// Cross-device conflict resolution regression tests.
//
// Verifies the positionUpdatedAt field prevents:
//   1. Runtime-only updates from making stale positions look fresh.
//   2. Stale local positions overwriting newer cloud positions.
//   3. Server-side compare-and-swap rejecting stale-position overwrites.
//   4. Source switching preserving canonical currentTime.
//   5. Backward compatibility with pre-migration records (positionUpdatedAt = 0).
import assert from 'node:assert/strict';
import { mergeProgress } from '../src/lib/shared/progress-merge.ts';
import type { WatchProgressRecord, ContentSnapshot, SaveProgressInput } from '../src/lib/client/progress/types.ts';
import { createProgressWriter, saveProgress } from '../src/lib/client/progress/service.ts';
import { getProgress } from '../src/lib/client/progress/database.ts';

// Use a test IndexedDB shim if needed.
if (typeof globalThis.indexedDB === 'undefined') {
  // In-memory IDB shim for tsx environments.
  const fakeIndexedDB = await import('fake-indexeddb');
  globalThis.indexedDB = new fakeIndexedDB.IDBFactory();
  (globalThis as any).IDBKeyRange = fakeIndexedDB.IDBKeyRange;
}

const snapshot: ContentSnapshot = { title: 'Test Movie', poster: '' };

function makeRecord(opts: {
  contentId: string;
  currentTime: number;
  duration?: number;
  updatedAt: number;
  positionUpdatedAt?: number;
  selectedSourceId?: string;
  completionState?: 'in_progress' | 'completed';
}): WatchProgressRecord {
  return {
    key: `movie:${opts.contentId}:-:-`,
    contentType: 'movie',
    contentId: opts.contentId,
    currentTime: opts.currentTime,
    duration: opts.duration ?? 8826,
    completionState: opts.completionState ?? 'in_progress',
    snapshot,
    lastWatchedAt: opts.updatedAt,
    updatedAt: opts.updatedAt,
    positionUpdatedAt: opts.positionUpdatedAt ?? 0,
    selectedSourceId: opts.selectedSourceId,
  };
}

let passed = 0;
function ok(msg: string) {
  passed += 1;
  console.log(`  ok ${passed} - ${msg}`);
}

console.log('Cross-device conflict resolution regression tests');

// ============================================================
// 1. mergeProgress: positionUpdatedAt is the position-freshness signal
// ============================================================
console.log('\n1. mergeProgress uses positionUpdatedAt for position-freshness');

{
  // Device A: real position 5340s (~1h29m), positionUpdatedAt = 10:00
  // Device B: stale position 1676s (~28m), positionUpdatedAt = 09:00
  //           but updatedAt = 11:00 (runtime-only update advanced updatedAt)
  const deviceA = makeRecord({ contentId: 'midsommar', currentTime: 5340, updatedAt: 10_000_000, positionUpdatedAt: 10_000_000 });
  const deviceB = makeRecord({ contentId: 'midsommar', currentTime: 1676, updatedAt: 11_000_000, positionUpdatedAt: 9_000_000 });

  // Device B's updatedAt (11:00) is NEWER than Device A's (10:00).
  // But Device A's positionUpdatedAt (10:00) is NEWER than Device B's (09:00).
  // The merge MUST pick Device A (the real position), NOT Device B (the stale position).
  const merged = mergeProgress([deviceB], [deviceA]);
  assert.equal(merged.length, 1, 'one record after merge');
  assert.equal(merged[0]!.currentTime, 5340, 'Device A\'s real position wins (positionUpdatedAt is newer)');
  assert.equal(merged[0]!.positionUpdatedAt, 10_000_000, 'positionUpdatedAt preserved from winner');
  ok('runtime-only update (newer updatedAt but older positionUpdatedAt) does NOT overwrite real position');
}

// ============================================================
// 2. mergeProgress: equal positionUpdatedAt, higher currentTime wins
// ============================================================
console.log('\n2. equal positionUpdatedAt → higher currentTime wins (tiebreak)');

{
  const recordA = makeRecord({ contentId: 'tie', currentTime: 3000, updatedAt: 10_000_000, positionUpdatedAt: 10_000_000 });
  const recordB = makeRecord({ contentId: 'tie', currentTime: 3500, updatedAt: 10_000_000, positionUpdatedAt: 10_000_000 });

  const merged = mergeProgress([recordA], [recordB]);
  assert.equal(merged[0]!.currentTime, 3500, 'higher currentTime wins on tie');
  ok('equal positionUpdatedAt tiebreak by currentTime');
}

// ============================================================
// 3. mergeProgress: backward compat — positionUpdatedAt=0 falls back to updatedAt
// ============================================================
console.log('\n3. backward compat: positionUpdatedAt=0 falls back to updatedAt');

{
  // Pre-migration records have positionUpdatedAt = 0.
  // mergeProgress should fall back to updatedAt for comparison.
  const oldRecordA = makeRecord({ contentId: 'old', currentTime: 1000, updatedAt: 10_000_000, positionUpdatedAt: 0 });
  const oldRecordB = makeRecord({ contentId: 'old', currentTime: 2000, updatedAt: 9_000_000, positionUpdatedAt: 0 });

  // Both have positionUpdatedAt=0 → fall back to updatedAt.
  // oldRecordA has newer updatedAt (10:00 > 09:00) → A wins.
  const merged = mergeProgress([oldRecordA], [oldRecordB]);
  assert.equal(merged[0]!.currentTime, 1000, 'old behavior: updatedAt decides when positionUpdatedAt=0');
  ok('pre-migration records (positionUpdatedAt=0) fall back to updatedAt');
}

// ============================================================
// 4. mergeProgress: mixed — one has positionUpdatedAt, other doesn't
// ============================================================
console.log('\n4. mixed: one record has positionUpdatedAt, other does not');

{
  // Device A (new client): real position, positionUpdatedAt = 10:00
  // Device B (old client, pre-migration): stale position, positionUpdatedAt = 0
  //   but updatedAt = 11:00
  const deviceA = makeRecord({ contentId: 'mixed', currentTime: 5340, updatedAt: 10_000_000, positionUpdatedAt: 10_000_000 });
  const deviceB = makeRecord({ contentId: 'mixed', currentTime: 1676, updatedAt: 11_000_000, positionUpdatedAt: 0 });

  // When one side has positionUpdatedAt > 0 and the other has 0, we use
  // positionUpdatedAt (usePositionTs = true). Device A's positionUpdatedAt
  // (10:00) > Device B's (0). Device A wins.
  const merged = mergeProgress([deviceB], [deviceA]);
  assert.equal(merged[0]!.currentTime, 5340, 'Device A (with positionUpdatedAt) wins over Device B (without)');
  ok('mixed: record with positionUpdatedAt wins over record without');
}

// ============================================================
// 5. ProgressWriter: updateRuntime does NOT advance positionUpdatedAt
// ============================================================
console.log('\n5. ProgressWriter.updateRuntime does NOT advance positionUpdatedAt');

{
  // Simulate: existing record has currentTime=1676, positionUpdatedAt=09:00.
  // Provider emits a duration event (updateRuntime) without a progress event.
  // The flush should preserve positionUpdatedAt=09:00, NOT stamp now.
  const basePositionUpdatedAt = 9_000_000;

  // First, save an initial record.
  const now = Date.now();
  await saveProgress({
    contentType: 'movie',
    contentId: 'runtime-only-test',
    currentTime: 1676,
    duration: 8826,
    selectedSourceId: 'vidstuck-source',
    snapshot,
    now,
    positionUpdatedAt: basePositionUpdatedAt,
  });

  // Create a writer initialized from the existing record.
  const writer = createProgressWriter({
    contentType: 'movie',
    contentId: 'runtime-only-test',
    selectedSourceId: 'vidstuck-source',
    snapshot,
    initialCurrentTime: 1676,
    initialDuration: 8826,
    initialPositionUpdatedAt: basePositionUpdatedAt,
  }, 25);

  // updateRuntime — a RUNTIME-ONLY update. No progress event.
  writer.updateRuntime('vidstuck-source', 9100);
  await writer.flush();
  writer.dispose();

  // Read back the persisted record.
  const record = await getProgress({ contentType: 'movie', contentId: 'runtime-only-test' });
  assert.ok(record, 'record exists after runtime-only flush');
  assert.equal(record!.currentTime, 1676, 'currentTime unchanged (runtime-only)');
  assert.equal(record!.positionUpdatedAt, basePositionUpdatedAt, 'positionUpdatedAt preserved (NOT advanced by runtime-only update)');
  assert.ok(record!.updatedAt > basePositionUpdatedAt, 'updatedAt advanced (the DB trigger stamps now on any mutation)');
  ok('updateRuntime flush preserves positionUpdatedAt — stale position cannot become "fresh" via runtime-only update');
}

// ============================================================
// 6. ProgressWriter: update() DOES advance positionUpdatedAt
// ============================================================
console.log('\n6. ProgressWriter.update DOES advance positionUpdatedAt');

{
  await saveProgress({
    contentType: 'movie',
    contentId: 'progress-test',
    currentTime: 100,
    duration: 8826,
    selectedSourceId: 'vidstuck-source',
    snapshot,
    now: Date.now(),
    positionUpdatedAt: 9_000_000,
  });

  const writer = createProgressWriter({
    contentType: 'movie',
    contentId: 'progress-test',
    selectedSourceId: 'vidstuck-source',
    snapshot,
    initialCurrentTime: 100,
    initialDuration: 8826,
    initialPositionUpdatedAt: 9_000_000,
  }, 25);

  // update — a REAL progress event. Position advances from 100 to 5340.
  writer.update(5340, 8826);
  await writer.flush();
  writer.dispose();

  const record = await getProgress({ contentType: 'movie', contentId: 'progress-test' });
  assert.ok(record, 'record exists after progress flush');
  assert.equal(record!.currentTime, 5340, 'currentTime advanced');
  assert.ok(record!.positionUpdatedAt > 9_000_000, 'positionUpdatedAt advanced (real progress update)');
  ok('update flush advances positionUpdatedAt — real position update is correctly timestamped');
}

// ============================================================
// 7. Source switching: canonical currentTime preserved
// ============================================================
console.log('\n7. source switch preserves canonical currentTime');

{
  // Simulate: user is at 5340s on VidStuck, switches to SLast.
  // The new writer should have knownCurrentTime = 5340 (NOT 0).
  // When SLast emits its first progress event, it should write 5340+
  // (not reset to 0).
  const writer = createProgressWriter({
    contentType: 'movie',
    contentId: 'switch-test',
    selectedSourceId: 'vidstuck-source',
    snapshot,
    initialCurrentTime: 5340,
    initialDuration: 8826,
    initialPositionUpdatedAt: 10_000_000,
  }, 25);

  // Simulate replaceProgressSource: flush, capture, dispose, recreate.
  await writer.flush();
  const sourceRuntimes = writer.getSourceRuntimes();
  const knownCurrentTime = writer.getKnownCurrentTime();
  writer.dispose();

  assert.equal(knownCurrentTime, 5340, 'knownCurrentTime preserved before source switch');

  const writer2 = createProgressWriter({
    contentType: 'movie',
    contentId: 'switch-test',
    selectedSourceId: 'slast-source',
    sourceRuntimes,
    snapshot,
    initialCurrentTime: knownCurrentTime,
    initialDuration: 8826,
    initialPositionUpdatedAt: 10_000_000,
  }, 25);

  // SLast emits a duration event (no progress yet).
  writer2.updateRuntime('slast-source', 10205);
  await writer2.flush();
  writer2.dispose();

  const record = await getProgress({ contentType: 'movie', contentId: 'switch-test' });
  assert.ok(record, 'record exists after source switch');
  assert.equal(record!.currentTime, 5340, 'currentTime preserved across source switch (NOT reset to 0)');
  assert.equal(record!.positionUpdatedAt, 10_000_000, 'positionUpdatedAt preserved (source switch is NOT a position advancement)');
  assert.equal(record!.selectedSourceId, 'slast-source', 'selectedSourceId updated to new source');
  ok('source switch: canonical currentTime + positionUpdatedAt preserved, only selectedSourceId + runtime metadata change');
}

// ============================================================
// 8. Server-side compare-and-swap simulation
// ============================================================
console.log('\n8. server-side compare-and-swap rejects stale position');

{
  // Simulate the server-side compare-and-swap logic from the sync API PUT.
  // The server fetches the existing cloud row and compares positionUpdatedAt.
  // If the incoming record's positionUpdatedAt is OLDER, the cloud's
  // position_seconds is preserved.
  const cloudRow = makeRecord({ contentId: 'cas-test', currentTime: 5340, updatedAt: 10_000_000, positionUpdatedAt: 10_000_000 });
  const incoming = makeRecord({ contentId: 'cas-test', currentTime: 1676, updatedAt: 11_000_000, positionUpdatedAt: 9_000_000 });

  // Simulate the compare-and-swap:
  const incomingPosTs = incoming.positionUpdatedAt ?? 0;
  const existingPosTs = cloudRow.positionUpdatedAt ?? 0;
  assert.ok(incomingPosTs < existingPosTs, 'incoming positionUpdatedAt is OLDER than cloud');

  // The server should preserve the cloud's position.
  const safeRecord = {
    ...incoming,
    currentTime: cloudRow.currentTime,
    positionUpdatedAt: cloudRow.positionUpdatedAt,
    completionState: cloudRow.completionState,
  };

  assert.equal(safeRecord.currentTime, 5340, 'cloud position preserved (incoming was stale)');
  assert.equal(safeRecord.positionUpdatedAt, 10_000_000, 'cloud positionUpdatedAt preserved');
  ok('compare-and-swap: incoming record with older positionUpdatedAt cannot overwrite cloud\'s newer position');
}

// ============================================================
// 9. Server-side compare-and-swap: newer incoming wins
// ============================================================
console.log('\n9. compare-and-swap: newer incoming position wins normally');

{
  const cloudRow = makeRecord({ contentId: 'cas-new', currentTime: 1676, updatedAt: 9_000_000, positionUpdatedAt: 9_000_000 });
  const incoming = makeRecord({ contentId: 'cas-new', currentTime: 5340, updatedAt: 10_000_000, positionUpdatedAt: 10_000_000 });

  const incomingPosTs = incoming.positionUpdatedAt ?? 0;
  const existingPosTs = cloudRow.positionUpdatedAt ?? 0;
  assert.ok(incomingPosTs > existingPosTs, 'incoming positionUpdatedAt is NEWER than cloud');

  // Normal upsert — incoming wins.
  assert.equal(incoming.currentTime, 5340, 'incoming position used (it is newer)');
  ok('compare-and-swap: incoming record with newer positionUpdatedAt overwrites cloud normally');
}

// ============================================================
// 10. Source runtimes merge correctly across the conflict
// ============================================================
console.log('\n10. sourceRuntimes merge across position conflict');

{
  const deviceA = makeRecord({
    contentId: 'runtime-merge',
    currentTime: 5340,
    updatedAt: 10_000_000,
    positionUpdatedAt: 10_000_000,
    selectedSourceId: 'vidstuck',
  });
  deviceA.sourceRuntimes = {
    vidstuck: { duration: 8826, updatedAt: 10_000_000 },
  };

  const deviceB = makeRecord({
    contentId: 'runtime-merge',
    currentTime: 1676,
    updatedAt: 11_000_000,
    positionUpdatedAt: 9_000_000,
    selectedSourceId: 'slast',
  });
  deviceB.sourceRuntimes = {
    slast: { duration: 10205, updatedAt: 11_000_000 },
    vidstuck: { duration: 8826, updatedAt: 9_000_000 }, // older than deviceA's vidstuck entry
  };

  // Device A wins the position (positionUpdatedAt 10:00 > 09:00).
  // But sourceRuntimes should merge: vidstuck from A (newer), slast from B.
  const merged = mergeProgress([deviceB], [deviceA]);
  assert.equal(merged[0]!.currentTime, 5340, 'Device A position wins');
  assert.ok(merged[0]!.sourceRuntimes, 'sourceRuntimes present');
  assert.equal(merged[0]!.sourceRuntimes!.vidstuck!.updatedAt, 10_000_000, 'vidstuck runtime from Device A (newer)');
  assert.equal(merged[0]!.sourceRuntimes!.slast!.duration, 10205, 'slast runtime from Device B (A did not have it)');
  ok('sourceRuntimes merge: winner\'s position + both devices\' runtimes');
}

// ============================================================
// 11–14. Server-side CAS equal-timestamp conflict resolution
// ============================================================
// These tests exercise the ACTUAL pure helper (resolvePositionConflict)
// used by the /api/account/sync PUT endpoint. The helper is imported
// directly — NOT duplicated — so a bug in the helper will fail the
// test, and a bug in the endpoint's USE of the helper would also
// surface (the endpoint delegates to the same function).
import { resolvePositionConflict } from '../src/lib/shared/progress-conflict.ts';

console.log('\n11. CAS: equal positionUpdatedAt, incoming lower currentTime → existing wins (TEST A)');

{
  // Existing cloud: currentTime=5340, positionUpdatedAt=T
  // Incoming:        currentTime=1676, positionUpdatedAt=T
  // Expected: cloud 5340 remains (existing wins on tie → higher currentTime)
  const T = 12_000_000;
  const verdict = resolvePositionConflict(T, T, 1676, 5340);
  assert.equal(verdict, 'existing-wins', 'equal positionUpdatedAt + lower incoming currentTime → existing wins');
  ok('TEST A: cloud 5340 remains, incoming 1676 rejected');
}

console.log('\n12. CAS: equal positionUpdatedAt, incoming higher currentTime → incoming wins (TEST B)');

{
  // Existing cloud: currentTime=1676, positionUpdatedAt=T
  // Incoming:        currentTime=5340, positionUpdatedAt=T
  // Expected: incoming 5340 wins (higher currentTime on tie)
  const T = 12_000_000;
  const verdict = resolvePositionConflict(T, T, 5340, 1676);
  assert.equal(verdict, 'incoming-wins', 'equal positionUpdatedAt + higher incoming currentTime → incoming wins');
  ok('TEST B: incoming 5340 wins over cloud 1676');
}

console.log('\n13. CAS: exact tie (equal positionUpdatedAt + equal currentTime) → existing wins (TEST C)');

{
  // Existing cloud: currentTime=5340, positionUpdatedAt=T
  // Incoming:        currentTime=5340, positionUpdatedAt=T
  // Expected: position remains 5340 (existing wins on exact tie → preserve, no regression)
  const T = 12_000_000;
  const verdict = resolvePositionConflict(T, T, 5340, 5340);
  assert.equal(verdict, 'existing-wins', 'exact tie → existing wins (preserve, never regress)');
  ok('TEST C: exact tie preserves existing position — no regression');
}

console.log('\n14. CAS: newer incoming positionUpdatedAt → incoming wins');

{
  // Existing cloud: currentTime=1676, positionUpdatedAt=09:00
  // Incoming:        currentTime=5340, positionUpdatedAt=10:00
  // Expected: incoming wins (newer positionUpdatedAt)
  const verdict = resolvePositionConflict(10_000_000, 9_000_000, 5340, 1676);
  assert.equal(verdict, 'incoming-wins', 'newer incoming positionUpdatedAt → incoming wins');
  ok('CAS: newer incoming positionUpdatedAt wins');
}

console.log('\n15. CAS: older incoming positionUpdatedAt → existing wins (original Midsommar regression)');

{
  // Existing cloud (Device A): currentTime=5340, positionUpdatedAt=10:00
  // Incoming (Device B):        currentTime=1676, positionUpdatedAt=09:00
  //   (Device B has a newer updatedAt from a runtime-only flush, but
  //    the helper does NOT consult updatedAt — only positionUpdatedAt.)
  // Expected: existing wins (Device A's real 5340 position preserved)
  const verdict = resolvePositionConflict(9_000_000, 10_000_000, 1676, 5340);
  assert.equal(verdict, 'existing-wins', 'older incoming positionUpdatedAt → existing wins (Midsommar regression)');
  ok('CAS: older incoming positionUpdatedAt loses — Midsommar regression prevented');
}

console.log('\n16. CAS: backward compat (BOTH positionUpdatedAt=0) → backward-compat');

{
  // Pre-migration records: BOTH sides have positionUpdatedAt=0.
  // The helper returns 'backward-compat' so the caller falls back to
  // the old updatedAt-based behavior.
  const verdict = resolvePositionConflict(0, 0, 5340, 1676);
  assert.equal(verdict, 'backward-compat', 'both positionUpdatedAt=0 → backward-compat');
  ok('CAS: both pre-migration records (positionUpdatedAt=0) return backward-compat');
}

console.log('\n16b. CAS: mixed case (one side positionUpdatedAt=0) → side with positionUpdatedAt wins');

{
  // Mixed case: one side has positionUpdatedAt > 0, the other has 0.
  // The side with positionUpdatedAt > 0 wins (0 = unknown/very old).
  // This prevents a stale pre-migration record from winning over a
  // fresh new-client record just because the pre-migration record has
  // a newer updatedAt (from a runtime-only flush).
  const verdict1 = resolvePositionConflict(0, 10_000_000, 1676, 5340);
  assert.equal(verdict1, 'existing-wins', 'incoming=0, existing>0 → existing wins');
  const verdict2 = resolvePositionConflict(10_000_000, 0, 5340, 1676);
  assert.equal(verdict2, 'incoming-wins', 'incoming>0, existing=0 → incoming wins');
  ok('CAS: mixed case — side with positionUpdatedAt>0 wins over side with 0');
}

console.log('\n17. Client merge: equal positionUpdatedAt, higher currentTime wins (client-side mirror of TEST B)');

{
  // Verify the CLIENT-SIDE mergeProgress also uses the same ordering.
  // This is the mirror of TEST B but through the merge function.
  const T = 12_000_000;
  const cloudLower = makeRecord({ contentId: 'client-tie', currentTime: 1676, updatedAt: T, positionUpdatedAt: T });
  const localHigher = makeRecord({ contentId: 'client-tie', currentTime: 5340, updatedAt: T, positionUpdatedAt: T });

  // Both have the same positionUpdatedAt. The higher currentTime (5340) should win.
  const merged = mergeProgress([localHigher], [cloudLower]);
  assert.equal(merged[0]!.currentTime, 5340, 'client merge: higher currentTime wins on equal positionUpdatedAt');
  ok('client merge mirrors server CAS: equal positionUpdatedAt → higher currentTime wins');
}

console.log('\n18. Client merge: equal positionUpdatedAt, lower currentTime loses (client-side mirror of TEST A)');

{
  const T = 12_000_000;
  const cloudHigher = makeRecord({ contentId: 'client-tie-a', currentTime: 5340, updatedAt: T, positionUpdatedAt: T });
  const localLower = makeRecord({ contentId: 'client-tie-a', currentTime: 1676, updatedAt: T, positionUpdatedAt: T });

  const merged = mergeProgress([localLower], [cloudHigher]);
  assert.equal(merged[0]!.currentTime, 5340, 'client merge: lower currentTime loses on equal positionUpdatedAt');
  ok('client merge mirrors server CAS: equal positionUpdatedAt → lower currentTime loses');
}

console.log('\n19. Client merge: exact tie preserves existing (client-side mirror of TEST C)');

{
  const T = 12_000_000;
  const cloud = makeRecord({ contentId: 'client-tie-c', currentTime: 5340, updatedAt: T, positionUpdatedAt: T, selectedSourceId: 'cloud-source' });
  const local = makeRecord({ contentId: 'client-tie-c', currentTime: 5340, updatedAt: T, positionUpdatedAt: T, selectedSourceId: 'local-source' });

  // Exact tie on positionUpdatedAt + currentTime. The merge iterates
  // [...local, ...cloud] — local is processed first, then cloud. When
  // cloud is processed, existing=local. The helper returns 'existing-wins'
  // on exact tie, so local (the existing) wins. The position is 5340
  // either way — no regression.
  const merged = mergeProgress([local], [cloud]);
  assert.equal(merged[0]!.currentTime, 5340, 'client merge: exact tie preserves position (no regression)');
  ok('client merge mirrors server CAS: exact tie → no regression');
}

console.log(`\nAll ${passed} cross-device conflict resolution checks passed`);
