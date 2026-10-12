import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// ============================================================================
// Player UI V2 — Part 2, PHASE 5 regression suite: actual stream runtime and
// progress consistency. Behavioral tests against fake-indexeddb (the project
// convention) — REAL service/presenter/merge functions, not string matching.
//
// CONTRACT: the player timeline, progress %, remaining-time labels, resume
// validation and completion all use the ACTUAL playback duration reported by
// the active media — NEVER the catalog's TMDB runtime (which remains display
// metadata only, carried on record.snapshot.runtime).
//
// §1  Save/clamp guards — NaN/Infinity/0/negative durations; explicit-only
//     completion.
// §2  ProgressWriter — actual stream durations; initially-unknown → finite;
//     invalid reports never poison; runtime-only persistence; per-source
//     runtimes across source switches.
// §3  Presenter — Continue Watching + My List percentages from ACTUAL data.
// §4  Merge — local/cloud conflict resolution preserved; sourceRuntimes merge.
// §5  Resume — shorter alternate cut clamps on save; load never discards.
// §6  Shell + watch-route duration guards (source-level, the Phase 5 fixes).
// ============================================================================

let checks = 0;
function ok(condition: unknown, label: string) {
  assert.ok(condition, label);
  checks += 1;
}

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative: string) => readFileSync(path.join(REPO_ROOT, relative), 'utf8');

import { createProgressWriter, getRuntimeForSource, progressLabel, progressPercent, COMPLETION_THRESHOLD, saveProgress } from '../src/lib/client/progress/service.ts';
import { clampTime, completionFor } from '../src/lib/client/progress/types.ts';
import { clearLocalData, getProgress } from '../src/lib/client/progress/database.ts';
import { favoriteToMedia, getLatestResumeTarget, progressToMedia } from '../src/lib/client/progress/presenter.ts';
import { continueWatchingRecords, mergeProgress } from '../src/lib/shared/progress-merge.ts';
import { favoriteKey, type ContentSnapshot, type WatchProgressRecord } from '../src/lib/client/progress/types.ts';

const catalogRuntimeSnapshot: ContentSnapshot = { title: 'Test Movie', runtime: '2h' };

async function reset() {
  await clearLocalData();
}

// ============================================================
// §1 — save/clamp guards
// ============================================================

ok(clampTime(120, 3600).duration === 3600 && clampTime(120, 3600).currentTime === 120, '1a. valid values pass through');
ok(clampTime(Number.NaN, 3600).currentTime === 0, '1b. NaN position clamps to 0');
ok(clampTime(-5, 3600).currentTime === 0, '1b. negative position clamps to 0');
ok(clampTime(120, Number.NaN).duration === 0, '1c. NaN duration is not adopted');
ok(clampTime(120, Infinity).duration === 0, '1c. Infinity (live/unbounded) is NOT treated as a VOD duration');
ok(clampTime(120, 0).duration === 0, '1c. zero duration is not adopted');
ok(clampTime(120, -10).duration === 0, '1c. negative duration is not adopted');
ok(clampTime(4000, 3600).currentTime === 3600, '1d. position beyond the ACTUAL duration clamps to it');
ok(completionFor(3599, 3600, false) === 'in_progress', '1e. 99.9% watched is NOT completed (explicit-only completion)');
ok(completionFor(100, 3600, true) === 'completed', '1e. only the explicit ended event completes');
ok(COMPLETION_THRESHOLD === 1.0, '1e. the deprecated threshold constant stays inert');

{
  await reset();
  // A NaN/Infinity duration cannot survive a real saveProgress either.
  await saveProgress({ contentType: 'movie', contentId: 'guard', currentTime: 60, duration: Number.NaN, snapshot: catalogRuntimeSnapshot, now: 1000 });
  await saveProgress({ contentType: 'movie', contentId: 'guard', currentTime: 120, duration: Infinity, snapshot: catalogRuntimeSnapshot, now: 2000 });
  const stored = await getProgress({ contentType: 'movie', contentId: 'guard' });
  ok(stored?.duration === 0, '1f. a persisted record from a live/unbounded stream keeps duration 0 (never Infinity)');
}

// ============================================================
// §2 — ProgressWriter: actual stream durations
// ============================================================

{
  await reset();
  // 2a. A stream that runs SHORTER than the catalog runtime (alternate cut:
  // 45 min actual vs "2h" catalog). The record must carry 2700, never 7200.
  const writer = createProgressWriter({ key: 'movie:cut', contentType: 'movie', contentId: 'cut', snapshot: catalogRuntimeSnapshot });
  writer.update(600, 2700, false);
  writer.update(1200, 2700, false);
  await writer.flush();
  const stored = await getProgress({ contentType: 'movie', contentId: 'cut' });
  ok(stored?.duration === 2700, '2a. the record duration is the ACTUAL stream duration (2700s), NOT the catalog runtime (2h)');
  ok(stored?.snapshot.runtime === '2h', '2a. the catalog runtime remains display metadata, untouched');
  ok(getRuntimeForSource(stored!, stored!.selectedSourceId) === 2700, '2a. getRuntimeForSource basis = actual duration');
  await writer.dispose();
}
{
  await reset();
  // 2b. Initially unknown duration becoming finite; later invalid reports.
  const writer = createProgressWriter({ key: 'movie:late', contentType: 'movie', contentId: 'late', snapshot: catalogRuntimeSnapshot });
  writer.update(60, undefined, false); // duration not yet known
  await writer.flush();
  let stored = await getProgress({ contentType: 'movie', contentId: 'late' });
  ok(stored?.duration === 0, '2b. before the media reports a duration the record stays duration-less (no invention)');
  writer.update(120, 5400, false); // loadedmetadata: actual = 5400s (longer cut)
  writer.update(300, Number.NaN, false);
  writer.update(400, Infinity, false);
  writer.update(500, 0, false);
  writer.update(600, -50, false);
  await writer.flush();
  stored = await getProgress({ contentType: 'movie', contentId: 'late' });
  ok(stored?.duration === 5400, '2b. a finite actual duration persists; NaN/Infinity/0/negative reports never overwrite it');
  await writer.dispose();
}
{
  await reset();
  // 2c. Runtime-only persistence before any timeupdate (BUG #9 class).
  const writer = createProgressWriter({ key: 'movie:early', contentType: 'movie', contentId: 'early', snapshot: catalogRuntimeSnapshot });
  writer.updateRuntime('src-a', 2400);
  await writer.flush();
  const stored = await getProgress({ contentType: 'movie', contentId: 'early' });
  ok(stored?.duration === 2400, '2c. a duration-only report persists even without a position update');
  ok(stored?.sourceRuntimes?.['src-a']?.duration === 2400, '2c. the duration is attributed to the reporting source');
  ok(stored?.currentTime === 0 && stored?.positionUpdatedAt === 0, '2c. a runtime-only flush does not fake position freshness (cross-device rule intact)');
  await writer.dispose();
}
{
  await reset();
  // 2d. Source switches accumulate per-source runtimes (different cuts).
  const writerA = createProgressWriter({ key: 'movie:cuts', contentType: 'movie', contentId: 'cuts', snapshot: catalogRuntimeSnapshot, selectedSourceId: 'src-a' });
  writerA.update(300, 3000, false);
  await writerA.flush();
  const runtimesA = writerA.getSourceRuntimes();
  const knownTime = writerA.getKnownCurrentTime();
  await writerA.dispose();
  // Switch to source B: its stream is a longer cut (4200s).
  const writerB = createProgressWriter({ key: 'movie:cuts', contentType: 'movie', contentId: 'cuts', snapshot: catalogRuntimeSnapshot, selectedSourceId: 'src-b', sourceRuntimes: { ...runtimesA, 'src-a': { duration: 3000, updatedAt: 1 } }, initialCurrentTime: knownTime, initialDuration: 3000 });
  writerB.updateRuntime('src-b', 4200);
  writerB.update(knownTime, 4200, false);
  await writerB.flush();
  const stored = await getProgress({ contentType: 'movie', contentId: 'cuts' });
  ok(stored?.sourceRuntimes?.['src-a']?.duration === 3000, '2d. source A runtime survives the switch (accumulated, not erased)');
  ok(stored?.sourceRuntimes?.['src-b']?.duration === 4200, '2d. source B carries its OWN actual duration');
  ok(stored?.selectedSourceId === 'src-b' && getRuntimeForSource(stored!, 'src-b') === 4200, '2d. the active source basis is its own stream duration (no cross-source bleed)');
  await writerB.dispose();
}

// ============================================================
// §3 — presenter: Continue Watching + My List from ACTUAL data
// ============================================================

{
  // A stream that differs from the catalog runtime: 12:30 watched of a
  // 25:00 actual stream, catalog says "1h".
  const actual = {
    key: favoriteKey('movie', 'short'),
    contentType: 'movie' as const,
    contentId: 'short',
    currentTime: 750,
    duration: 1500,
    completionState: 'in_progress' as const,
    snapshot: catalogRuntimeSnapshot,
    lastWatchedAt: 1000,
    updatedAt: 1000,
    positionUpdatedAt: 1000,
    selectedSourceId: 's1',
    sourceRuntimes: { s1: { duration: 1500, updatedAt: 5 } },
  } satisfies WatchProgressRecord;
  ok(progressPercent(actual) === 50, '3a. Continue Watching % = position / ACTUAL stream duration (50%), never position / catalog runtime (750/7200≈10%)');
  ok(progressLabel(actual) === '13m left', '3a. remaining time derives from the actual duration');
  const media = progressToMedia(actual);
  ok(media.progress === 50 && media.progressLabel === '13m left', '3a. progressToMedia exposes the actual-duration percentage to Continue Watching rows');
  // My List presentation: real progress only when BOTH position and duration exist.
  const favorite = { key: favoriteKey('movie', 'short'), contentType: 'movie' as const, contentId: 'short', snapshot: catalogRuntimeSnapshot, status: 'watching' as const, createdAt: 1, updatedAt: 2 };
  const watching = favoriteToMedia(favorite, [actual]);
  ok(watching.progress === 50, '3b. My List shows the actual-duration percentage for watching titles');
  const noData = favoriteToMedia(favorite, [{ ...actual, currentTime: 0, duration: 0 }]);
  ok(noData.progress === undefined && noData.progressLabel === undefined, '3b. a zero-progress/zero-duration record fabricates NO percentage or label');
  // Continue Watching aggregation uses the same basis.
  const continueWatching = continueWatchingRecords([actual], []);
  ok(continueWatching.length === 1 && progressPercent(continueWatching[0]) === 50, '3c. the Continue Watching row derives from the actual-duration record');
  ok(getLatestResumeTarget('movie', 'short', [{ ...actual, completionState: 'completed' }]) === undefined, '3d. completed records are not resume targets');
}

// ============================================================
// §4 — merge: local/cloud records + sourceRuntimes
// ============================================================

{
  const local: WatchProgressRecord = { key: 'movie:9', contentType: 'movie', contentId: '9', currentTime: 500, duration: 3600, completionState: 'in_progress', snapshot: catalogRuntimeSnapshot, lastWatchedAt: 100, updatedAt: 100, positionUpdatedAt: 100 };
  const cloud: WatchProgressRecord = { key: 'movie:9', contentType: 'movie', contentId: '9', currentTime: 900, duration: 3600, completionState: 'in_progress', snapshot: catalogRuntimeSnapshot, lastWatchedAt: 200, updatedAt: 200, positionUpdatedAt: 200, sourceRuntimes: { 'src-c': { duration: 3600, updatedAt: 10 } } };
  const merged = mergeProgress([local], [cloud]);
  ok(merged.length === 1 && merged[0].currentTime === 900, '4a. the fresher position (cloud) wins — established positionUpdatedAt ordering preserved');
  ok(merged[0].sourceRuntimes?.['src-c']?.duration === 3600, '4a. the winner carries merged sourceRuntimes from both sides');
  const mergedBack = mergeProgress([cloud], [local]);
  ok(mergedBack[0].currentTime === 900, '4a. merge is order-independent (same verdict)');
  // Backward-compat records (positionUpdatedAt=0) keep the legacy ordering.
  const legacyLocal: WatchProgressRecord = { ...local, currentTime: 100, updatedAt: 50, positionUpdatedAt: 0 };
  const legacyCloud: WatchProgressRecord = { ...cloud, currentTime: 50, updatedAt: 60, positionUpdatedAt: 0, sourceRuntimes: undefined };
  const legacy = mergeProgress([legacyLocal], [legacyCloud]);
  ok(legacy[0].currentTime === 50, '4b. legacy records (no positionUpdatedAt) still resolve by updatedAt');
}

// ============================================================
// §5 — resume: shorter alternate cut
// ============================================================

{
  await reset();
  // Saved 50:00 on a 60:00 cut; the user reopens on a 45:00 alternate.
  // At LOAD the record is returned verbatim (no discard — rule 11).
  await saveProgress({ contentType: 'movie', contentId: 'cutvariance', currentTime: 3000, duration: 3600, snapshot: catalogRuntimeSnapshot, now: 1000 });
  const storedBefore = await getProgress({ contentType: 'movie', contentId: 'cutvariance' });
  ok(storedBefore?.currentTime === 3000, '5a. the record exists with its original position');
  // A real save on the shorter cut clamps to THAT stream's actual duration —
  // position and duration become consistent again (50:00 > 45:00 cannot persist).
  await saveProgress({ contentType: 'movie', contentId: 'cutvariance', currentTime: 3100, duration: 2700, snapshot: catalogRuntimeSnapshot, now: 2000 });
  const storedAfter = await getProgress({ contentType: 'movie', contentId: 'cutvariance' });
  ok(storedAfter?.currentTime === 2700 && storedAfter?.duration === 2700, '5b. a save on a shorter alternate cut clamps to the actual duration (no impossible position, no catalog substitution)');
  // A small cut variance (recap/intro difference) never destroys the record.
  await saveProgress({ contentType: 'movie', contentId: 'cutvariance', currentTime: 2600, duration: 2700, snapshot: catalogRuntimeSnapshot, now: 3000 });
  const storedSmall = await getProgress({ contentType: 'movie', contentId: 'cutvariance' });
  ok(storedSmall?.currentTime === 2600, '5c. a position within the actual duration is preserved as-is (progress from a different cut is not discarded)');
}

// ============================================================
// §6 — shell + watch-route duration guards (the Phase 5 fixes)
// ============================================================

const shell = read('src/lib/components/player/PlayerShell.svelte');
const watchPage = read('src/routes/watch/[type]/[id]/+page.svelte');
const controls = read('src/lib/components/player/PlayerControls.svelte');

ok(/if \(Number\.isFinite\(event\.detail\.duration\) && event\.detail\.duration > 0\) duration = event\.detail\.duration;/.test(shell), '6a. shell timeupdate adopts only FINITE positive durations (Infinity/NaN/0 rejected — live media never becomes the VOD duration)');
ok(/duration = Number\.isFinite\(videoElement\.duration\) \? videoElement\.duration : duration;/.test(shell), '6b. loadedmetadata keeps the last known duration for non-finite element reports');
ok(/if \(Number\.isFinite\(media\.duration\) && media\.duration > 0\) duration = media\.duration;/.test(shell), '6c. the cast mirror adopts only finite positive remote durations');
ok(/duration = 0;[\s\S]{0,300}savedSourceId = undefined;/.test(watchPage), '6d. an episode switch resets the stale duration before the new episode reports its own');
ok(/safeDuration = Number\.isFinite\(duration\) && duration > 0 \? duration : 0/.test(controls), '6e. the timeline treats non-finite/zero duration as "unknown" (safe seek range)');
ok(/const durationSec = duration > 0 \? duration : null;/.test(shell), '6f. the intro lookup still keys on the ACTUAL media duration only (Part 1 contract intact)');
// The catalog runtime must never be written into a duration field anywhere
// in the two files (display metadata only flows through snapshot.runtime).
ok(!/duration\s*=\s*[^;\n]*item\.runtime/.test(watchPage), '6g. the watch route never assigns the catalog runtime to a duration');
ok(!/duration\s*=\s*[^;\n]*content\.runtime/.test(shell), '6g. the shell never assigns the catalog runtime to a duration');

console.log(`progress_duration_test: ${checks} checks passed`);
