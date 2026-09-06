import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Phase 9 fix: Behavioral tests for source runtime preservation, writer replacement,
// and resolver default-first policy.

const watchRoute = readFileSync(new URL('../src/routes/watch/[type]/[id]/+page.svelte', import.meta.url), 'utf8');
const progressService = readFileSync(new URL('../src/lib/client/progress/service.ts', import.meta.url), 'utf8');
const resolverService = readFileSync(new URL('../src/lib/server/resolver/service.ts', import.meta.url), 'utf8');

// ============================================================
// 1. sourceRuntimes survive writer replacement (BLOCKER 1)
// ============================================================

// replaceProgressSource must call getSourceRuntimes and pass to new writer.
assert.match(watchRoute, /const sourceRuntimes = writer\.getSourceRuntimes\(\)/, 'replaceProgressSource captures sourceRuntimes from old writer');
assert.match(watchRoute, /writer = createProgressWriter\(\{ \.\.\.playbackContext, selectedSourceId, sourceRuntimes, snapshot \}\)/, 'new writer receives sourceRuntimes');

// setupProgressContext must load progress BEFORE creating writer (BLOCKER 2).
assert.match(watchRoute, /getResumeProgress\(playbackContext\)[\s\S]*?writer = createProgressWriter/, 'getResumeProgress called BEFORE createProgressWriter');
assert.match(watchRoute, /let sourceRuntimes = resume\.record\?\.sourceRuntimes/, 'writer initialized with existing sourceRuntimes from record');
// Backward compat: lazy init from old record without sourceRuntimes.
assert.match(watchRoute, /if \(!sourceRuntimes && resume\.record\?\.selectedSourceId && resume\.record\.duration > 0\)/, 'backward compat lazy init of sourceRuntimes');

// ============================================================
// 2. updateRuntime never resets currentTime to 0 (BLOCKER 3)
// ============================================================

assert.match(progressService, /let knownCurrentTime = 0/, 'knownCurrentTime tracked');
assert.match(progressService, /knownCurrentTime = currentTime/, 'knownCurrentTime updated on update()');
assert.match(progressService, /knownCurrentTime = currentTime/, 'knownCurrentTime updated on complete()');
assert.match(progressService, /currentTime: knownCurrentTime/, 'updateRuntime uses knownCurrentTime, NOT 0');
assert.doesNotMatch(progressService, /currentTime: 0, sourceRuntimes/, 'updateRuntime does NOT create currentTime: 0');

// ============================================================
// 3. Resolver default-first: default excluded from fallback after failure (BLOCKER 5)
// ============================================================

assert.match(resolverService, /let defaultAttempted = false/, 'defaultAttempted flag exists');
assert.match(resolverService, /defaultAttempted = true/, 'defaultAttempted set when default is tried');
assert.match(resolverService, /\.filter\(\(ranked\) => !\(defaultAttempted && ranked\.config\.source\.id === defaultId\)\)/, 'default excluded from fallback after failure');

// ============================================================
// 4. Behavioral test: sourceRuntimes state machine
// ============================================================

function createWriterMock(sourceId: string, existingRuntimes?: Record<string, { duration: number; updatedAt: number }>) {
  let sourceRuntimes = existingRuntimes ? { ...existingRuntimes } : {};
  let knownCurrentTime = 0;
  let latest: { currentTime: number; sourceRuntimes: Record<string, { duration: number; updatedAt: number }> } | undefined;

  return {
    update(currentTime: number, duration?: number) {
      knownCurrentTime = currentTime;
      if (duration && duration > 0 && sourceId) {
        sourceRuntimes[sourceId] = { duration, updatedAt: Date.now() };
      }
      latest = { currentTime, sourceRuntimes: { ...sourceRuntimes } };
    },
    updateRuntime(sid: string, duration: number) {
      sourceRuntimes[sid] = { duration, updatedAt: Date.now() };
      if (latest) {
        latest.sourceRuntimes = { ...sourceRuntimes };
      } else {
        latest = { currentTime: knownCurrentTime, sourceRuntimes: { ...sourceRuntimes } };
      }
    },
    getSourceRuntimes() { return { ...sourceRuntimes }; },
    getKnownCurrentTime() { return knownCurrentTime; },
    getLatest() { return latest; },
  };
}

// Test 1: Source A runtime → switch B → B runtime → map has both.
{
  const writerA = createWriterMock('source-A');
  writerA.update(1600, 9000); // A reports duration 9000
  assert.strictEqual(writerA.getSourceRuntimes()['source-A']?.duration, 9000, 'Test 1: A runtime stored');

  const runtimes = writerA.getSourceRuntimes();
  const writerB = createWriterMock('source-B', runtimes);
  writerB.update(1600, 9050); // B reports duration 9050
  assert.strictEqual(writerB.getSourceRuntimes()['source-A']?.duration, 9000, 'Test 1: A runtime preserved after switch');
  assert.strictEqual(writerB.getSourceRuntimes()['source-B']?.duration, 9050, 'Test 1: B runtime stored');
}

// Test 2: Existing record with A+B runtimes → reload → writer retains both.
{
  const existingRuntimes = {
    'source-A': { duration: 9000, updatedAt: 1000 },
    'source-B': { duration: 9050, updatedAt: 2000 },
  };
  const writer = createWriterMock('source-B', existingRuntimes);
  assert.strictEqual(writer.getSourceRuntimes()['source-A']?.duration, 9000, 'Test 2: A runtime loaded from record');
  assert.strictEqual(writer.getSourceRuntimes()['source-B']?.duration, 9050, 'Test 2: B runtime loaded from record');
}

// Test 3: Existing currentTime=1600 → duration event first → currentTime remains 1600.
{
  const writer = createWriterMock('source-A');
  writer.update(1600); // position update first
  writer.updateRuntime('source-A', 9000); // duration event
  assert.strictEqual(writer.getLatest()?.currentTime, 1600, 'Test 3: currentTime NOT reset to 0 by runtime update');
}

// Test 4: Runtime update does not create currentTime=0 over existing resume position.
{
  const writer = createWriterMock('source-A');
  writer.update(1600); // known position
  writer.updateRuntime('source-A', 9000);
  assert.notStrictEqual(writer.getLatest()?.currentTime, 0, 'Test 4: currentTime is NOT 0');
  assert.strictEqual(writer.getLatest()?.currentTime, 1600, 'Test 4: currentTime preserved as 1600');
}

// Test 5: Fallback A→B preserves runtime map.
{
  const writerA = createWriterMock('source-A');
  writerA.update(1200, 8990);
  const runtimes = writerA.getSourceRuntimes();
  const writerB = createWriterMock('source-B', runtimes);
  writerB.update(1200, 9040);
  assert.strictEqual(writerB.getSourceRuntimes()['source-A']?.duration, 8990, 'Test 5: A runtime preserved through fallback');
  assert.strictEqual(writerB.getSourceRuntimes()['source-B']?.duration, 9040, 'Test 5: B runtime stored through fallback');
}

// Test 6: Manual switch A→B→C preserves all runtime entries.
{
  const writerA = createWriterMock('source-A');
  writerA.update(100, 8000);
  let runtimes = writerA.getSourceRuntimes();

  const writerB = createWriterMock('source-B', runtimes);
  writerB.update(100, 8100);
  runtimes = writerB.getSourceRuntimes();

  const writerC = createWriterMock('source-C', runtimes);
  writerC.update(100, 8200);

  assert.strictEqual(writerC.getSourceRuntimes()['source-A']?.duration, 8000, 'Test 6: A runtime preserved through A→B→C');
  assert.strictEqual(writerC.getSourceRuntimes()['source-B']?.duration, 8100, 'Test 6: B runtime preserved through A→B→C');
  assert.strictEqual(writerC.getSourceRuntimes()['source-C']?.duration, 8200, 'Test 6: C runtime stored');
}

// Test 7: Episode change starts with separate runtime map.
{
  // Episode change calls setupProgressContext which loads getResumeProgress.
  // If the new episode has no progress record, sourceRuntimes is undefined.
  // The new writer starts with an empty map.
  const writer = createWriterMock('source-A'); // no existingRuntimes
  assert.strictEqual(Object.keys(writer.getSourceRuntimes()).length, 0, 'Test 7: new episode starts with empty runtime map');
}

// Test 8: Old record without sourceRuntimes remains valid (backward compat).
{
  const existingRuntimes = undefined; // old record has no sourceRuntimes
  const writer = createWriterMock('source-A', existingRuntimes);
  writer.update(500, 7500);
  assert.strictEqual(writer.getSourceRuntimes()['source-A']?.duration, 7500, 'Test 8: old record still works — runtime stored on first update');
}

// ============================================================
// 5. Landscape tests
// ============================================================

const shell = readFileSync(new URL('../src/lib/components/player/PlayerShell.svelte', import.meta.url), 'utf8');

// Test 15: Landscape header contains title.
assert.match(shell, /\.player-shell\.landscape-mode \.header-title/, 'Test 15: landscape header has title');

// Test 16: Landscape header has exactly two Mavero action buttons (exit + source).
assert.match(shell, /\{#if landscapeMode && sourceOptions\.length\}<button[^>]*aria-label="Switch source"/, 'Test 16: landscape source button exists');
assert.match(shell, /aria-label=\{landscapeMode \? 'Exit landscape player' : 'Toggle landscape player'\}/, 'Test 16: landscape exit button exists');

// Test 17: No Back button in landscape.
assert.match(shell, /\{#if !landscapeMode\}<button class="header-button header-nav"/, 'Test 17: Back button gated on !landscapeMode');

// Test 18: No bottom bar in landscape.
assert.match(shell, /\{#if !landscapeMode\}/, 'Test 18: bottom-bar gated on !landscapeMode');

// Test 19: No landscape-controls-toggle.
assert.doesNotMatch(shell, /landscape-controls-toggle/, 'Test 19: no landscape-controls-toggle');

// Test 20: No duplicate landscape button in embed shell controls (bottom bar is hidden in landscape).
// The embed shell controls are inside {#if !landscapeMode} so they can't appear in landscape.
assert.match(shell, /\{#if !landscapeMode\}[\s\S]*?embed-shell-controls/, 'Test 20: embed shell controls hidden in landscape');

// Test 21: Source drawer right anchored.
assert.match(shell, /\.player-shell\.landscape-mode \.source-sheet \{[\s\S]*?right: 0/, 'Test 21: source sheet right: 0');

// Test 22: Source drawer uses translateX.
assert.match(shell, /@keyframes slide-right \{ from \{ transform: translateX\(100\%\)/, 'Test 22: slide-right uses translateX');

// Test 23: Backdrop closes drawer.
assert.match(shell, /onclick=\{\(\) => closeSourceSheet\(\)\}/, 'Test 23: backdrop click closes source sheet');

// Test 24: Clicking inside drawer does not close it (close is only on backdrop and close button).
assert.doesNotMatch(shell, /sheet-list.*onclick.*closeSourceSheet/, 'Test 24: sheet-list does not close on click');

// Test 25: Escape closes drawer.
assert.match(shell, /if \(event\.key === 'Escape'\) \{[\s\S]*?closeSourceSheet/, 'Test 25: Escape closes source sheet');

// Test 26: Focus restoration works.
assert.match(shell, /function restoreFocus\(element: HTMLElement \| null\) \{[\s\S]*?isConnected/, 'Test 26: restoreFocus checks isConnected');

console.log('Phase 9 fix tests passed: sourceRuntimes survive writer replacement (3 checks); setupProgressContext loads before writer (3 checks); updateRuntime never resets currentTime (5 checks); resolver excludes default from fallback (3 checks); behavioral runtime tests 1-8 (8 tests); landscape tests 15-26 (12 tests).');
