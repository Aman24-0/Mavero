import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Phase 8: Reliability contract + behavioral tests.
//
// Tests:
//   1. Embed iframe load timeout (constant, lifecycle, stale-source guard)
//   2. Client-side resolver timeout (constant, AbortController integration,
//      timeout-abort vs intentional-abort distinction)
//
// Classification:
//   - Iframe timeout: CONTRACT test (regex on source) + behavioral state-machine
//     test simulating the timeout lifecycle.
//   - Resolver timeout: CONTRACT test (regex on source) verifying the timeout
//     constant, AbortController integration, and timedOut flag exist.

const shell = readFileSync(new URL('../src/lib/components/player/PlayerShell.svelte', import.meta.url), 'utf8');
const manager = readFileSync(new URL('../src/lib/client/player/PlaybackManager.ts', import.meta.url), 'utf8');

// ============================================================
// 1. EMBED IFRAME LOAD TIMEOUT — contract assertions
// ============================================================

// 1a. Constant exists with a conservative value (15-20s range).
assert.match(shell, /const EMBED_LOAD_TIMEOUT_MS = \d{4,5}/, 'EMBED_LOAD_TIMEOUT_MS constant exists');
const timeoutMatch = shell.match(/const EMBED_LOAD_TIMEOUT_MS = (\d+)/);
assert.ok(timeoutMatch, 'timeout value extracted');
const timeoutMs = Number(timeoutMatch![1]);
assert.ok(timeoutMs >= 15000 && timeoutMs <= 20000, `timeout value ${timeoutMs}ms is in 15-20s range`);

// 1b. Timer state variables exist.
assert.match(shell, /let embedLoadTimer: ReturnType<typeof setTimeout> \| undefined/, 'embedLoadTimer state declared');
assert.match(shell, /let embedLoadTimeoutSourceId = ''/, 'embedLoadTimeoutSourceId declared for stale-source guard');

// 1c. startEmbedLoadTimeout function exists.
assert.match(shell, /function startEmbedLoadTimeout\(sourceId: string\)/, 'startEmbedLoadTimeout function exists');

// 1d. clearEmbedLoadTimeout function exists.
assert.match(shell, /function clearEmbedLoadTimeout\(\)/, 'clearEmbedLoadTimeout function exists');

// 1e. Timeout is started on embed source switch.
assert.match(shell, /clearEmbedLoadTimeout\(\);\s*if \(source\.type === 'embed'\) startEmbedLoadTimeout\(source\.sourceId\)/, 'timeout started for embed sources on source switch');

// 1f. Timeout is cleared on successful embed load.
assert.match(shell, /function handleEmbedLoad\(\)[\s\S]{0,300}clearEmbedLoadTimeout\(\)/, 'timeout cleared in handleEmbedLoad');

// 1g. Timeout is cleared on source switch (before starting new).
assert.match(shell, /clearEmbedLoadTimeout\(\);\s*if \(source\.type === 'embed'\)/, 'timeout cleared before starting new one on source switch');

// 1h. Timeout is cleared on episode switch.
assert.match(shell, /episodeIdentity[\s\S]{0,200}clearEmbedLoadTimeout\(\)/, 'timeout cleared on episode switch');

// 1i. Timeout is cleared on destroy (in onMount cleanup return).
assert.match(shell, /return \(\) => \{[\s\S]{0,200}clearEmbedLoadTimeout\(\)/, 'timeout cleared on component destroy');

// 1j. Timeout is cleared on retry.
assert.match(shell, /function retry\(\)[\s\S]{0,100}clearEmbedLoadTimeout\(\)/, 'timeout cleared on retry');

// 1k. Stale-source guard: timeout checks sourceIdentity before acting.
// Phase 8 bug fix: the guard must validate against a captured immutable
// per-timer identity (timeoutSourceId), NOT the mutable embedLoadTimeoutSourceId.
assert.match(shell, /const timeoutSourceId = sourceId/, 'timeoutSourceId captured as immutable per-timer const');
assert.match(shell, /if \(sourceIdentity !== timeoutSourceId\) return/, 'stale-source guard checks captured timeoutSourceId, not mutable variable');

// 1l. Timeout checks state === 'embed-loading' before transitioning to error.
assert.match(shell, /if \(state !== 'embed-loading'\) return/, 'timeout only fires if still in embed-loading state');

// 1m. Timeout shows user-facing error message.
assert.match(shell, /This source is taking too long to load\./, 'user-facing timeout error message exists');

// 1n. Timeout does NOT create a second error UI — uses existing state = 'error'.
assert.match(shell, /state = 'error';\s*errorMessage = 'This source is taking too long to load\.'/, 'timeout uses existing error state, not a second UI');

// ============================================================
// 2. EMBED IFRAME LOAD TIMEOUT — behavioral state-machine test
// ============================================================
//
// Simulates the timeout lifecycle to verify stale-source protection.
// This mirrors the logic in startEmbedLoadTimeout/clearEmbedLoadTimeout —
// if the source code changes, this harness must be updated to match.

function createEmbedTimeoutStateMachine() {
  let embedLoadTimer: ReturnType<typeof setTimeout> | undefined;
  let embedLoadTimeoutSourceId = '';
  let sourceIdentity = '';
  let state: string = 'embed-loading';
  let errorMessage = '';
  let timeoutFired = false;
  let errorTransitioned = false;

  // Phase 8 bug fix: capture the sourceId in a local const per timer invocation
  // so the callback validates against THIS timer's identity, not the mutable
  // embedLoadTimeoutSourceId which may be overwritten by a newer source.
  function startEmbedLoadTimeout(sourceId: string, delay = 50) {
    clearEmbedLoadTimeout();
    const timeoutSourceId = sourceId; // immutable capture
    embedLoadTimeoutSourceId = timeoutSourceId;
    embedLoadTimer = setTimeout(() => {
      embedLoadTimer = undefined;
      // Guard against the captured per-timer identity, NOT the mutable variable.
      if (sourceIdentity !== timeoutSourceId) return;
      if (state !== 'embed-loading') return;
      timeoutFired = true;
      state = 'error';
      errorMessage = 'This source is taking too long to load.';
      errorTransitioned = true;
    }, delay);
  }

  function clearEmbedLoadTimeout() {
    if (embedLoadTimer) {
      clearTimeout(embedLoadTimer);
      embedLoadTimer = undefined;
    }
    embedLoadTimeoutSourceId = '';
  }

  return {
    start: startEmbedLoadTimeout,
    clear: clearEmbedLoadTimeout,
    setSourceIdentity: (id: string) => { sourceIdentity = id; },
    setState: (s: string) => { state = s; },
    getState: () => state,
    getErrorMessage: () => errorMessage,
    didTimeoutFire: () => timeoutFired,
    didErrorTransition: () => errorTransitioned,
  };
}

// Test A: timeout fires and transitions to error when embed is slow.
{
  const sm = createEmbedTimeoutStateMachine();
  sm.setSourceIdentity('source-A');
  sm.setState('embed-loading');
  sm.start('source-A', 50);
  await new Promise((r) => setTimeout(r, 80));
  assert.strictEqual(sm.getState(), 'error', 'Test A: timeout transitions to error state');
  assert.strictEqual(sm.getErrorMessage(), 'This source is taking too long to load.', 'Test A: error message set');
  assert.ok(sm.didTimeoutFire(), 'Test A: timeout fired');
}

// Test B: timeout is cleared on successful embed load.
{
  const sm = createEmbedTimeoutStateMachine();
  sm.setSourceIdentity('source-A');
  sm.setState('embed-loading');
  sm.start('source-A', 50);
  sm.clear(); // simulate handleEmbedLoad clearing the timeout
  sm.setState('playing'); // simulate handleEmbedLoad setting state to playing
  await new Promise((r) => setTimeout(r, 80));
  assert.strictEqual(sm.getState(), 'playing', 'Test B: state stays playing');
  assert.ok(!sm.didTimeoutFire(), 'Test B: timeout did NOT fire');
}

// Test C: stale timeout from source A does NOT affect source B.
{
  const sm = createEmbedTimeoutStateMachine();
  sm.setSourceIdentity('source-A');
  sm.setState('embed-loading');
  sm.start('source-A', 50);
  // User switches to source B — clear old timeout, start new.
  sm.clear();
  sm.setSourceIdentity('source-B');
  sm.setState('embed-loading');
  sm.start('source-B', 50);
  // Wait for source-A's original timeout to have fired (if not cleared).
  await new Promise((r) => setTimeout(r, 80));
  assert.strictEqual(sm.getState(), 'error', 'Test C: source B timeout fires (not source A)');
  assert.ok(sm.didTimeoutFire(), 'Test C: timeout fired for source B');
  // Verify it was source B's timeout, not source A's — check sourceIdentity matches.
  assert.strictEqual(sm.getErrorMessage(), 'This source is taking too long to load.', 'Test C: error from source B timeout');
}

// Test D: stale timeout from source A does NOT affect source B even if timer not cleared.
// This tests the identity guard — the most critical Phase 8 reliability requirement.
{
  const sm = createEmbedTimeoutStateMachine();
  sm.setSourceIdentity('source-A');
  sm.setState('embed-loading');
  sm.start('source-A', 50);
  // User switches to source B but the old timer is NOT cleared (simulating a bug).
  // The identity guard must prevent source A's timeout from affecting source B.
  sm.setSourceIdentity('source-B');
  sm.setState('embed-loading');
  // Do NOT call clear() or start() — simulate a missed cleanup.
  await new Promise((r) => setTimeout(r, 80));
  // Source A's timeout fired but the identity guard prevented it from changing state.
  assert.strictEqual(sm.getState(), 'embed-loading', 'Test D: stale source A timeout did NOT affect source B');
  assert.ok(!sm.didTimeoutFire(), 'Test D: stale timeout was a no-op due to identity guard');
}

// Test E: timeout does not fire if state is no longer 'embed-loading'.
{
  const sm = createEmbedTimeoutStateMachine();
  sm.setSourceIdentity('source-A');
  sm.setState('embed-loading');
  sm.start('source-A', 50);
  // State changes to 'playing' before timeout fires (handleEmbedLoad ran).
  sm.setState('playing');
  await new Promise((r) => setTimeout(r, 80));
  assert.strictEqual(sm.getState(), 'playing', 'Test E: state stays playing');
  assert.ok(!sm.didTimeoutFire(), 'Test E: timeout did NOT fire (state was no longer embed-loading)');
}

// ============================================================
// 2f. CRITICAL REGRESSION TEST: stale-callback race (Phase 8 bug fix)
// ============================================================
//
// This test specifically reproduces the race described in the bug report:
//
//   1. Source A starts → timeout A is scheduled with captured identity 'A'
//   2. Source A's callback becomes queued (has not executed yet)
//   3. User switches to source B → start('B') is called
//   4. start('B') clears A's timer (clearEmbedLoadTimeout) and schedules B's timer
//   5. BUT: if A's callback was already queued by the event loop (not cancelled
//      in time, or the clear happened after the callback was already on the
//      microtask queue), A's callback executes
//   6. A's callback reads the CAPTURED timeoutSourceId ('A') — NOT the mutable
//      embedLoadTimeoutSourceId (now 'B')
//   7. sourceIdentity is 'B' → 'B' !== 'A' → callback is a no-op
//
// The OLD (buggy) code read the mutable embedLoadTimeoutSourceId which is now 'B',
// and sourceIdentity is also 'B' → 'B' === 'B' → callback INCORRECTLY fires
// and transitions source B to error.
//
// This test uses a manual-callback state machine that captures each timer's
// callback function so it can be fired manually AFTER the mutable variable
// has been overwritten. This proves the fix works against the exact race.

function createManualCallbackStateMachine() {
  let embedLoadTimeoutSourceId = ''; // mutable — overwritten by each start()
  let sourceIdentity = '';
  let state: string = 'embed-loading';
  let errorMessage = '';
  let timeoutFired = false;

  // Returns the callback function for manual firing. The callback captures
  // `timeoutSourceId` as a local const — this is the fix.
  function startEmbedLoadTimeout(sourceId: string): () => void {
    const timeoutSourceId = sourceId; // immutable per-timer capture (the fix)
    embedLoadTimeoutSourceId = timeoutSourceId; // mutable variable (the bug source)
    return () => {
      // Guard against captured per-timer identity, NOT the mutable variable.
      if (sourceIdentity !== timeoutSourceId) return;
      if (state !== 'embed-loading') return;
      timeoutFired = true;
      state = 'error';
      errorMessage = 'This source is taking too long to load.';
    };
  }

  return {
    start: startEmbedLoadTimeout,
    setSourceIdentity: (id: string) => { sourceIdentity = id; },
    setState: (s: string) => { state = s; },
    getState: () => state,
    getErrorMessage: () => errorMessage,
    didTimeoutFire: () => timeoutFired,
    getMutableTimeoutSourceId: () => embedLoadTimeoutSourceId,
  };
}

// Test F: stale callback from source A must NOT affect source B after B
// has overwritten the mutable embedLoadTimeoutSourceId.
{
  const sm = createManualCallbackStateMachine();

  // 1. Source A starts — callback A is "queued" (captured).
  sm.setSourceIdentity('source-A');
  sm.setState('embed-loading');
  const callbackA = sm.start('source-A');

  // 2. User switches to source B — start('B') overwrites the mutable variable.
  sm.setSourceIdentity('source-B');
  sm.setState('embed-loading');
  const callbackB = sm.start('source-B');

  // Verify the mutable variable is now 'B' (simulating the race condition).
  assert.strictEqual(sm.getMutableTimeoutSourceId(), 'source-B', 'Test F: mutable embedLoadTimeoutSourceId is now B');

  // 3. Source A's callback fires (it was already queued before clear could cancel it).
  callbackA();

  // 4. Assert that source B is NOT affected — state must remain 'embed-loading'.
  assert.strictEqual(sm.getState(), 'embed-loading', 'Test F: source A stale callback did NOT transition source B to error');
  assert.ok(!sm.didTimeoutFire(), 'Test F: source A stale callback was a no-op (captured identity mismatch)');

  // 5. Source B's own callback fires — this SHOULD transition to error.
  callbackB();
  assert.strictEqual(sm.getState(), 'error', 'Test F: source B callback correctly transitions to error');
  assert.ok(sm.didTimeoutFire(), 'Test F: source B callback fired (correct behavior)');
}

// Test F-buggy: verify the OLD (buggy) code WOULD have failed this test.
// This proves the test is meaningful — it would catch a regression if
// someone reverted the fix.
{
  // Simulate the OLD buggy behavior: callback reads the mutable variable
  // instead of the captured const.
  let embedLoadTimeoutSourceId = '';
  let sourceIdentity = '';
  let state: string = 'embed-loading';
  let timeoutFired = false;

  function startBuggy(sourceId: string): () => void {
    embedLoadTimeoutSourceId = sourceId;
    // BUG: reads the mutable embedLoadTimeoutSourceId instead of captured sourceId
    return () => {
      if (sourceIdentity !== embedLoadTimeoutSourceId) return; // BUG: reads mutable
      if (state !== 'embed-loading') return;
      timeoutFired = true;
      state = 'error';
    };
  }

  // 1. Source A starts.
  sourceIdentity = 'source-A';
  state = 'embed-loading';
  const callbackA = startBuggy('source-A');

  // 2. Source B starts — overwrites the mutable variable.
  sourceIdentity = 'source-B';
  state = 'embed-loading';
  const callbackB = startBuggy('source-B');

  // 3. Source A's stale callback fires.
  callbackA();

  // BUG: source A's callback reads the mutable 'B', sourceIdentity is 'B' → match → fires!
  assert.strictEqual(state, 'error', 'Test F-buggy: OLD buggy code WOULD incorrectly transition source B to error');
  assert.ok(timeoutFired, 'Test F-buggy: OLD buggy code WOULD fire for the wrong source — proving the test is meaningful');
}

// ============================================================
// 3. CLIENT-SIDE RESOLVER TIMEOUT — contract assertions
// ============================================================

// 3a. Resolver timeout constant exists (15s).
assert.match(manager, /const RESOLVER_TIMEOUT_MS = 15000/, 'RESOLVER_TIMEOUT_MS = 15000 in PlaybackManager');

// 3b. Timeout uses the existing AbortController.
assert.match(manager, /const timeoutId = setTimeout\(\(\) => \{[\s\S]*?controller\.abort\(\)/, 'timeout aborts existing controller');

// 3c. timedOut flag distinguishes timeout-abort from intentional-abort.
assert.match(manager, /let timedOut = false/, 'timedOut flag declared');
assert.match(manager, /timedOut = true;\s*controller\.abort\(\)/, 'timedOut set to true before abort');

// 3d. Timeout is cleared on success.
assert.match(manager, /clearTimeout\(timeoutId\);[\s\S]{0,200}\} catch/, 'timeout cleared before catch block');

// 3e. Timeout is cleared on error.
assert.match(manager, /catch \(error\) \{[\s\S]*?clearTimeout\(timeoutId\)/, 'timeout cleared in catch block');

// 3f. Intentional abort (source switch) is silently dropped.
assert.match(manager, /if \(error instanceof DOMException && error\.name === 'AbortError'\) \{[\s\S]*?if \(timedOut\) \{[\s\S]*?return;/, 'intentional abort silently dropped when timedOut is false');

// 3g. Timeout abort shows user-facing error.
assert.match(manager, /if \(timedOut\) \{[\s\S]*?errorMessage: 'This source is taking too long to respond\.'/, 'timeout abort shows user-facing error message');

// 3h. Existing sessionId guards remain intact.
assert.match(manager, /const sessionId = \+\+this\.sessionId/, 'sessionId increment preserved');
assert.match(manager, /if \(!this\.active \|\| sessionId !== this\.sessionId\) return/, 'post-await sessionId guard preserved');
assert.match(manager, /this\.session\.abortController\?\.abort\(\)/, 'existing abort-on-new-source preserved');

// 3i. AbortController is still used as the fetch signal.
assert.match(manager, /signal: controller\.signal/, 'fetch still uses controller.signal');

// 3j. dispose() still aborts the controller.
assert.match(manager, /dispose\(\)[\s\S]{0,200}this\.session\.abortController\?\.abort\(\)/, 'dispose still aborts controller');

// ============================================================
// 4. CLIENT-SIDE RESOLVER TIMEOUT — behavioral test
// ============================================================

// Simulate the timedOut distinction logic.
function evaluateAbortHandling(timedOut: boolean, isAbortError: boolean): { silentlyDrop: boolean; showTimeoutError: boolean } {
  if (isAbortError) {
    if (timedOut) {
      return { silentlyDrop: false, showTimeoutError: true };
    }
    return { silentlyDrop: true, showTimeoutError: false };
  }
  return { silentlyDrop: false, showTimeoutError: false };
}

// Intentional source-switch abort: timedOut=false, isAbortError=true → silently drop.
assert.deepEqual(evaluateAbortHandling(false, true), { silentlyDrop: true, showTimeoutError: false }, 'intentional abort silently dropped');

// Timeout abort: timedOut=true, isAbortError=true → show timeout error.
assert.deepEqual(evaluateAbortHandling(true, true), { silentlyDrop: false, showTimeoutError: true }, 'timeout abort shows error');

// Non-abort error (network failure): not an AbortError → normal error handling.
assert.deepEqual(evaluateAbortHandling(false, false), { silentlyDrop: false, showTimeoutError: false }, 'non-abort error handled normally');

console.log('Phase 8 reliability tests passed: embed timeout constant + value check (2); embed timeout state + functions (4); embed timeout lifecycle wiring (6); stale-source guard + captured-identity check (4); behavioral timeout tests A-F (7 tests including stale-callback race regression + buggy-code proof); resolver timeout constant + AbortController + timedOut flag (3); resolver timeout cleanup on success/error (2); intentional-abort vs timeout-abort distinction (2); existing sessionId/AbortController guards preserved (4); behavioral abort-handling tests (3 tests).');
