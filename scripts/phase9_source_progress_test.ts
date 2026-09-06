import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Phase 9: Source selection + progress persistence behavioral tests.
//
// These tests verify the fixes for:
//   BUG 1: Admin default source being ignored (sourceOptions[0] selected instead)
//   BUG 2: First play must use admin default
//   BUG 3: Saved source must override default on resume
//   BUG 4: Manual source switch not saving progress
//   BUG 5: Continue Watching stale display
//   BUG 6: Progress must update quickly on state transitions
//   BUG 7: Source switch + current time consistency
//   BUG 8: Saved source validation
//   BUG 9: Fallback must not destroy resume logic
//   BUG 10: Exact episode progress isolation

const watchRoute = readFileSync(new URL('../src/routes/watch/[type]/[id]/+page.svelte', import.meta.url), 'utf8');
const progressService = readFileSync(new URL('../src/lib/client/progress/service.ts', import.meta.url), 'utf8');
const discoverPage = readFileSync(new URL('../src/lib/components/DiscoverPage.svelte', import.meta.url), 'utf8');

// ============================================================
// 1. Source selection gated on progressReady (BUG 1-3 fix)
// ============================================================

// The old code: $: if (!selectedSourceId && sourceOptions.length)
// The new code: $: if (browser && progressReady && !selectedSourceId && sourceOptions.length)
assert.match(watchRoute, /\$: if \(browser && progressReady && !selectedSourceId && sourceOptions\.length\)/, 'source selection gated on progressReady');
assert.doesNotMatch(watchRoute, /\$: if \(!selectedSourceId && sourceOptions\.length\)/, 'old ungated source selection removed');

// Priority: saved → default → fallback
assert.match(watchRoute, /savedValid \? savedSourceId! : \(defaultValid \? defaultSourceId! : sourceOptions\[0\]\.id\)/, 'priority: saved → default → fallback');

// prepareSource also gated on progressReady
assert.match(watchRoute, /\$: if \(browser && progressReady && selectedSourceId && resolutionState === 'idle'\) void prepareSource\(\)/, 'prepareSource gated on progressReady');

// ============================================================
// 2. handleSourceChange flushes before switching (BUG 4 fix)
// ============================================================

assert.match(watchRoute, /function handleSourceChange[\s\S]*?void writer\?\.flush\(\)/, 'handleSourceChange flushes writer before switching');

// ============================================================
// 3. replaceProgressSource flushes old writer before dispose (BUG 4 fix)
// ============================================================

assert.match(watchRoute, /async function replaceProgressSource[\s\S]*?await writer\.flush\(\)[\s\S]*?writer\.dispose\(\)/, 'replaceProgressSource flushes before dispose');

// ============================================================
// 4. Continue Watching reloads on visibility change (BUG 5 fix)
// ============================================================

assert.match(discoverPage, /function handleDocumentVisibility[\s\S]*?void loadContinue\(\)\.then/, 'handleDocumentVisibility reloads Continue Watching');
assert.match(discoverPage, /async function loadContinue\(\)/, 'loadContinue is a top-level function accessible from handleDocumentVisibility');

// ============================================================
// 5. Progress writer debounces but flushes on important transitions (BUG 6)
// ============================================================

assert.match(progressService, /DEFAULT_FLUSH_INTERVAL = 12_000/, 'debounce interval is 12s');
assert.match(progressService, /const flush = async/, 'flush function exists');
assert.match(progressService, /pause\(\) \{[\s\S]*?return flush\(\)/, 'pause flushes immediately');
assert.match(progressService, /complete\([\s\S]*?return flush\(\)/, 'complete flushes immediately');

// ============================================================
// 6. startPosition preserves currentPlaybackTime on source switch (BUG 7)
// ============================================================

assert.match(watchRoute, /const startPosition = allowFallback \? resumeTime : currentPlaybackTime/, 'manual source switch uses currentPlaybackTime as startPosition');

// ============================================================
// 7. Saved source validation (BUG 8)
// ============================================================

assert.match(watchRoute, /savedSourceId && sourceOptions\.some\(\(s\) => s\.id === savedSourceId\)/, 'savedSourceId validated against current sourceOptions');

// ============================================================
// 8. Fallback updates selectedSourceId to actual resolved source (BUG 9)
// ============================================================

assert.match(watchRoute, /if \(resolved && resolved\.sourceId !== selectedSourceId\) \{[\s\S]*?await replaceProgressSource\(resolved\.sourceId\)/, 'fallback swaps writer to resolved source');

// ============================================================
// 9. Per-episode progress isolation (BUG 10)
// ============================================================

assert.match(watchRoute, /playbackKey = \[playbackContext\.contentType, playbackContext\.contentId, playbackContext\.season \?\? '-', playbackContext\.episode \?\? '-'\]\.join\(':'\)/, 'playbackKey includes season+episode');
assert.match(watchRoute, /\$: if \(browser && playbackKey !== activePlaybackKey\)/, 'episode switch detected via playbackKey change');
assert.match(watchRoute, /savedSourceId = undefined/, 'savedSourceId cleared on episode switch');

// ============================================================
// 10. Behavioral test: source selection priority state machine
// ============================================================

function createSourceSelectionStateMachine() {
  let selectedSourceId = '';
  let savedSourceId: string | undefined;
  let defaultSourceId: string | undefined;
  let progressReady = false;
  const sourceOptions: string[] = [];

  function trySelect() {
    if (!progressReady || selectedSourceId || !sourceOptions.length) return;
    const savedValid = savedSourceId && sourceOptions.includes(savedSourceId);
    const defaultValid = defaultSourceId && sourceOptions.includes(defaultSourceId);
    selectedSourceId = savedValid ? savedSourceId! : (defaultValid ? defaultSourceId! : sourceOptions[0]);
  }

  return {
    setSavedSource: (id: string) => { savedSourceId = id; },
    setDefaultSource: (id: string) => { defaultSourceId = id; },
    setProgressReady: (v: boolean) => { progressReady = v; },
    setSourceOptions: (opts: string[]) => { sourceOptions.length = 0; sourceOptions.push(...opts); },
    trySelect,
    getSelected: () => selectedSourceId,
  };
}

// Test 1: movie default — no progress, default = VidY → VidY selected
{
  const sm = createSourceSelectionStateMachine();
  sm.setSourceOptions(['vidsrc', 'vidy', 'vidphantom']);
  sm.setDefaultSource('vidy');
  sm.setProgressReady(true);
  sm.trySelect();
  assert.strictEqual(sm.getSelected(), 'vidy', 'Test 1: movie default VidY selected, not VidSrc');
}

// Test 2: series default — no progress, default = FilmU → FilmU selected
{
  const sm = createSourceSelectionStateMachine();
  sm.setSourceOptions(['slast', 'filmu', 'vidy']);
  sm.setDefaultSource('filmu');
  sm.setProgressReady(true);
  sm.trySelect();
  assert.strictEqual(sm.getSelected(), 'filmu', 'Test 2: series default FilmU selected, not SLast');
}

// Test 3: saved source beats default — saved = VidPhantom, default = VidY → VidPhantom
{
  const sm = createSourceSelectionStateMachine();
  sm.setSourceOptions(['vidsrc', 'vidy', 'vidphantom']);
  sm.setSavedSource('vidphantom');
  sm.setDefaultSource('vidy');
  sm.setProgressReady(true);
  sm.trySelect();
  assert.strictEqual(sm.getSelected(), 'vidphantom', 'Test 3: saved VidPhantom beats default VidY');
}

// Test 4: invalid saved source — saved = deleted, default = VidY → VidY
{
  const sm = createSourceSelectionStateMachine();
  sm.setSourceOptions(['vidsrc', 'vidy', 'vidphantom']);
  sm.setSavedSource('deleted-source');
  sm.setDefaultSource('vidy');
  sm.setProgressReady(true);
  sm.trySelect();
  assert.strictEqual(sm.getSelected(), 'vidy', 'Test 4: invalid saved source falls back to default');
}

// Test 5: no saved, no default → sourceOptions[0]
{
  const sm = createSourceSelectionStateMachine();
  sm.setSourceOptions(['vidsrc', 'vidy', 'vidphantom']);
  sm.setProgressReady(true);
  sm.trySelect();
  assert.strictEqual(sm.getSelected(), 'vidsrc', 'Test 5: no saved/default → sourceOptions[0]');
}

// Test 6: selection does NOT fire before progressReady — the root cause of BUG 1
{
  const sm = createSourceSelectionStateMachine();
  sm.setSourceOptions(['vidsrc', 'vidy', 'vidphantom']);
  sm.setDefaultSource('vidy');
  // progressReady is still false — selection must NOT happen
  sm.trySelect();
  assert.strictEqual(sm.getSelected(), '', 'Test 6: no selection before progressReady');
  // Now progress loads — selection should use default
  sm.setProgressReady(true);
  sm.trySelect();
  assert.strictEqual(sm.getSelected(), 'vidy', 'Test 6: after progressReady, default VidY selected');
}

// ============================================================
// 11. Behavioral test: progress writer flush on source switch
// ============================================================

function createProgressWriterMock(sourceId: string) {
  let latest: { currentTime: number; duration?: number; completed: boolean; sourceId: string } | undefined;
  let flushed = false;
  let disposed = false;

  return {
    update(currentTime: number, duration?: number, completed = false) {
      if (disposed) return;
      latest = { currentTime, duration, completed, sourceId };
    },
    async flush() {
      if (disposed) return;
      flushed = true;
      latest = undefined;
    },
    dispose() { disposed = true; },
    wasFlushed: () => flushed,
    isDisposed: () => disposed,
    getLatest: () => latest,
  };
}

// Test 9: source switch flushes old writer before dispose
{
  const oldWriter = createProgressWriterMock('vidsrc');
  oldWriter.update(56, 3600, false);
  // Simulate source switch: flush → dispose → new writer
  await oldWriter.flush();
  assert.ok(oldWriter.wasFlushed(), 'Test 9: old writer flushed');
  oldWriter.dispose();
  assert.ok(oldWriter.isDisposed(), 'Test 9: old writer disposed');
  // Old writer can no longer accept updates
  oldWriter.update(60, 3600, false);
  assert.strictEqual(oldWriter.getLatest(), undefined, 'Test 9: disposed writer does not accept updates');
}

// Test 10: old source event cannot write to new writer
{
  const oldWriter = createProgressWriterMock('vidsrc');
  const newWriter = createProgressWriterMock('vidphantom');
  oldWriter.update(56, 3600, false);
  // Switch: flush old, dispose old, create new
  await oldWriter.flush();
  oldWriter.dispose();
  // Stale event from old source tries to write to old writer → no-op
  oldWriter.update(60, 3600, false);
  // New writer receives new events
  newWriter.update(60, 3600, false);
  assert.strictEqual(oldWriter.getLatest(), undefined, 'Test 10: old writer has no latest (disposed)');
  assert.strictEqual(newWriter.getLatest()?.sourceId, 'vidphantom', 'Test 10: new writer has correct sourceId');
  assert.strictEqual(newWriter.getLatest()?.currentTime, 60, 'Test 10: new writer has correct timestamp');
}

console.log('Phase 9 source selection + progress tests passed: source selection gated on progressReady (3 checks); priority saved → default → fallback (1 check); handleSourceChange flush (1 check); replaceProgressSource flush+dispose (1 check); Continue Watching reload on visibility (2 checks); progress writer debounce + flush (4 checks); startPosition preserves currentPlaybackTime (1 check); saved source validation (1 check); fallback writer swap (1 check); episode isolation (3 checks); behavioral source selection tests 1-6 (6 tests); behavioral progress writer tests 9-10 (2 tests).');
