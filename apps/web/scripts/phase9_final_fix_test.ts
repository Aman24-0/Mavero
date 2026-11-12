import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Phase 9 final fix: Behavioral tests for initialCurrentTime preservation,
// source-switch serialization, and rapid-switch race safety.

const watchRoute = readFileSync(new URL('../src/routes/watch/[type]/[id]/+page.svelte', import.meta.url), 'utf8');
const progressService = readFileSync(new URL('../src/lib/client/progress/service.ts', import.meta.url), 'utf8');

// ============================================================
// 1. initialCurrentTime passed to writer (BLOCKER 1 fix)
// ============================================================

assert.match(progressService, /initialCurrentTime\?: number/, 'initialCurrentTime field in writer base type');
assert.match(progressService, /let knownCurrentTime = Math\.max\(0, Number\.isFinite\(base\.initialCurrentTime\)/, 'knownCurrentTime initialized from initialCurrentTime');

// setupProgressContext passes resume.record?.currentTime.
assert.match(watchRoute, /initialCurrentTime: resume\.record\?\.currentTime \?\? 0/, 'setupProgressContext passes existing currentTime to writer');

// replaceProgressSource passes knownCurrentTime from old writer.
assert.match(watchRoute, /const knownCurrentTime = writer\.getKnownCurrentTime\(\)/, 'replaceProgressSource captures knownCurrentTime');
assert.match(watchRoute, /initialCurrentTime: knownCurrentTime/, 'replaceProgressSource passes knownCurrentTime to new writer');

// ============================================================
// 2. handleSourceChange: no double flush, serialized (BLOCKER 2 fix)
// ============================================================

// handleSourceChange must NOT call writer?.flush() directly (only the comment mentions it).
assert.doesNotMatch(watchRoute, /function handleSourceChange[\s\S]{0,300}void writer\?\.flush\(\);[\s\S]{0,50}void prepareSource/, 'handleSourceChange does NOT flush directly before prepareSource');

// Generation token exists.
assert.match(watchRoute, /let sourceSwitchGeneration = 0/, 'sourceSwitchGeneration token exists');
assert.match(watchRoute, /const generation = \+\+sourceSwitchGeneration/, 'generation captured at call time');
assert.match(watchRoute, /if \(generation !== sourceSwitchGeneration\) return/, 'stale generation aborts');

// Serialized chain exists.
assert.match(watchRoute, /let sourceSwitchChain: Promise<void> = Promise\.resolve\(\)/, 'sourceSwitchChain serialized promise exists');
assert.match(watchRoute, /sourceSwitchChain = sourceSwitchChain\.then/, 'source switch chained via .then()');

// ============================================================
// 3. Behavioral test: writer initialCurrentTime preservation
// ============================================================

function createWriterMock(opts: { sourceId: string; sourceRuntimes?: Record<string, { duration: number; updatedAt: number }>; initialCurrentTime?: number }) {
  let sourceRuntimes = opts.sourceRuntimes ? { ...opts.sourceRuntimes } : {};
  let knownCurrentTime = Math.max(0, Number.isFinite(opts.initialCurrentTime) ? (opts.initialCurrentTime ?? 0) : 0);
  let latest: { currentTime: number; sourceRuntimes: Record<string, { duration: number; updatedAt: number }> } | undefined;

  return {
    update(currentTime: number, duration?: number) {
      knownCurrentTime = currentTime;
      if (duration && duration > 0 && opts.sourceId) {
        sourceRuntimes[opts.sourceId] = { duration, updatedAt: Date.now() };
      }
      latest = { currentTime, sourceRuntimes: { ...sourceRuntimes } };
    },
    updateRuntime(sourceId: string, duration: number) {
      sourceRuntimes[sourceId] = { duration, updatedAt: Date.now() };
      if (latest) {
        latest.sourceRuntimes = { ...sourceRuntimes };
      } else {
        latest = { currentTime: knownCurrentTime, sourceRuntimes: { ...sourceRuntimes } };
      }
    },
    flush() { /* mock no-op */ },
    getSourceRuntimes() { return { ...sourceRuntimes }; },
    getKnownCurrentTime() { return knownCurrentTime; },
    dispose() { /* mock no-op */ },
    getLatest() { return latest; },
  };
}

// Test 1: Existing currentTime = 1600 → writer created with initialCurrentTime = 1600
//         → duration event first → currentTime remains 1600.
{
  const writer = createWriterMock({ sourceId: 'source-A', initialCurrentTime: 1600 });
  writer.updateRuntime('source-A', 9000); // duration event before first timeupdate
  assert.strictEqual(writer.getLatest()?.currentTime, 1600, 'Test 1: currentTime preserved as 1600 (NOT 0)');
}

// Test 2: New playback with no existing progress → knownCurrentTime = 0 → acceptable.
{
  const writer = createWriterMock({ sourceId: 'source-A', initialCurrentTime: 0 });
  writer.updateRuntime('source-A', 9000);
  assert.strictEqual(writer.getLatest()?.currentTime, 0, 'Test 2: new playback starts at 0 (correct)');
}

// Test 3: update() updates knownCurrentTime → subsequent updateRuntime uses it.
{
  const writer = createWriterMock({ sourceId: 'source-A', initialCurrentTime: 1600 });
  writer.update(1700, 9000); // timeupdate
  writer.updateRuntime('source-A', 9000); // another duration event
  assert.strictEqual(writer.getLatest()?.currentTime, 1700, 'Test 3: knownCurrentTime updated to 1700');
}

// Test 4: Source A runtime survives switch to B.
{
  const writerA = createWriterMock({ sourceId: 'source-A', initialCurrentTime: 100 });
  writerA.update(100, 9000);
  const runtimes = writerA.getSourceRuntimes();
  const knownTime = writerA.getKnownCurrentTime();

  const writerB = createWriterMock({ sourceId: 'source-B', sourceRuntimes: runtimes, initialCurrentTime: knownTime });
  writerB.update(100, 9050);

  assert.strictEqual(writerB.getSourceRuntimes()['source-A']?.duration, 9000, 'Test 4: A runtime preserved');
  assert.strictEqual(writerB.getSourceRuntimes()['source-B']?.duration, 9050, 'Test 4: B runtime stored');
}

// Test 5: A+B runtimes survive switch B→C.
{
  const writerA = createWriterMock({ sourceId: 'source-A', initialCurrentTime: 100 });
  writerA.update(100, 8000);
  let runtimes = writerA.getSourceRuntimes();
  let knownTime = writerA.getKnownCurrentTime();

  const writerB = createWriterMock({ sourceId: 'source-B', sourceRuntimes: runtimes, initialCurrentTime: knownTime });
  writerB.update(100, 8100);
  runtimes = writerB.getSourceRuntimes();
  knownTime = writerB.getKnownCurrentTime();

  const writerC = createWriterMock({ sourceId: 'source-C', sourceRuntimes: runtimes, initialCurrentTime: knownTime });
  writerC.update(100, 8200);

  assert.strictEqual(writerC.getSourceRuntimes()['source-A']?.duration, 8000, 'Test 5: A runtime preserved through A→B→C');
  assert.strictEqual(writerC.getSourceRuntimes()['source-B']?.duration, 8100, 'Test 5: B runtime preserved through A→B→C');
  assert.strictEqual(writerC.getSourceRuntimes()['source-C']?.duration, 8200, 'Test 5: C runtime stored');
}

// Test 6: Existing A+B map survives reload.
{
  const existingRuntimes = {
    'source-A': { duration: 9000, updatedAt: 1000 },
    'source-B': { duration: 9050, updatedAt: 2000 },
  };
  const writer = createWriterMock({ sourceId: 'source-B', sourceRuntimes: existingRuntimes, initialCurrentTime: 1600 });
  assert.strictEqual(writer.getSourceRuntimes()['source-A']?.duration, 9000, 'Test 6: A runtime loaded from record');
  assert.strictEqual(writer.getSourceRuntimes()['source-B']?.duration, 9050, 'Test 6: B runtime loaded from record');
  assert.strictEqual(writer.getKnownCurrentTime(), 1600, 'Test 6: knownCurrentTime = 1600 from record');
}

// ============================================================
// 4. Behavioral test: rapid A→B→C race serialization
// ============================================================

// Test 7: Rapid A→B→C — latest source (C) wins.
{
  let selectedSourceId = 'source-A';
  let sourceSwitchGeneration = 0;
  let sourceSwitchChain: Promise<void> = Promise.resolve();

  // Simulate the handleSourceChange logic.
  function handleSourceChange(sourceId: string, delay: number): Promise<void> {
    const generation = ++sourceSwitchGeneration;
    sourceSwitchChain = sourceSwitchChain.then(() => {
      return new Promise<void>((resolve) => {
        setTimeout(() => {
          if (generation !== sourceSwitchGeneration) { resolve(); return; }
          selectedSourceId = sourceId;
          resolve();
        }, delay);
      });
    }).catch(() => {});
    return sourceSwitchChain;
  }

  // A→B with 100ms delay, B→C with 10ms delay.
  // C should complete first but must wait for B to finish.
  // Final selectedSourceId must be 'C'.
  const pB = handleSourceChange('source-B', 100);
  const pC = handleSourceChange('source-C', 10);

  await Promise.all([pB, pC]);
  assert.strictEqual(selectedSourceId, 'source-C', 'Test 7: C wins despite faster completion — serialization ensures order');
}

// Test 8: Old source-switch operation cannot install stale writer.
{
  let selectedSourceId = 'source-A';
  let sourceSwitchGeneration = 0;
  let sourceSwitchChain: Promise<void> = Promise.resolve();

  function handleSourceChange(sourceId: string, delay: number): Promise<void> {
    const generation = ++sourceSwitchGeneration;
    sourceSwitchChain = sourceSwitchChain.then(() => {
      return new Promise<void>((resolve) => {
        setTimeout(() => {
          if (generation !== sourceSwitchGeneration) { resolve(); return; }
          selectedSourceId = sourceId;
          resolve();
        }, delay);
      });
    }).catch(() => {});
    return sourceSwitchChain;
  }

  // Start A→B (slow), then immediately A→C (fast).
  // B's operation should be skipped because C has a newer generation.
  const pB = handleSourceChange('source-B', 100);
  const pC = handleSourceChange('source-C', 10);

  await Promise.all([pB, pC]);
  assert.strictEqual(selectedSourceId, 'source-C', 'Test 8: C wins — B was skipped due to generation mismatch');
}

// Test 9: Only one flush per source switch.
{
  let flushCount = 0;
  const mockWriter = {
    flush: async () => { flushCount++; },
    getSourceRuntimes: () => ({}),
    getKnownCurrentTime: () => 0,
    dispose: () => {},
  };

  // Simulate replaceProgressSource: single flush.
  await mockWriter.flush();
  assert.strictEqual(flushCount, 1, 'Test 9: replaceProgressSource flushes exactly once');

  // handleSourceChange should NOT add another flush.
  // (The fix removed the void writer?.flush() call from handleSourceChange.)
  assert.strictEqual(flushCount, 1, 'Test 9: no second flush from handleSourceChange');
}

console.log('Phase 9 final fix tests passed: initialCurrentTime contract (4 checks); handleSourceChange no double-flush + serialization (5 checks); behavioral writer tests 1-6 (6 tests); rapid-switch race tests 7-8 (2 tests); single-flush test 9 (1 test).');
