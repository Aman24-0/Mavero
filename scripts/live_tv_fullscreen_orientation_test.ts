// MAVERO — LT-16 Mobile Fullscreen Orientation: focused regression suite.
//
// Covers the LT-16 addition (landscape orientation lock while the Live TV
// player surface is fullscreen on a phone/tablet, released on exit) in the
// repo's two UI-phase styles:
//   * BEHAVIORAL sections drive the REAL coordinator module under Node
//     with injected fake capability environments — which also proves SSR
//     safety (importing the module under Node is exactly what the SSR
//     server does; the default environment must be inert there).
//   * SOURCE-CONTRACT sections assert the LiveTvPlayer.svelte wiring:
//     both playback modes (native video + LT-15 embed iframe) route
//     through the ONE shared surface's fullscreenchange handler, the
//     coordinator owns all orientation work, and the LT-15 fallback
//     architecture is untouched.
//
// The ten directive-mandated cases map to sections as follows:
//   1 mobile native fullscreen -> landscape ....... §A1 (+ §B1 wiring)
//   2 mobile embed fullscreen -> landscape ........ §A1 + §B1 (containment)
//   3 desktop -> NO orientation lock .............. §A2
//   4 orientation API unavailable -> still works .. §A3
//   5 lock() rejects -> playback/fullscreen fine .. §A4
//   6 fullscreen exit -> unlock when appropriate .. §A5
//   7 component destruction -> no lock remains .... §A6 (+ §B2)
//   8 rapid enter/exit -> no stale lock ........... §A7
//   9 channel switch -> no stale lock ............. §A8 + §B3
//  10 LT-15 fallback behavior unchanged ........... §B4 (+ gates: the
//                                                    full existing chain
//                                                    must stay green)
//
// NO network, browser, DRM or Shaka package is involved.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  canAttemptLandscapeLock,
  createLiveTvFullscreenOrientationCoordinator,
  defaultLiveTvOrientationEnv,
  type LiveTvOrientationEnv
} from '$lib/client/live-tv/fullscreen-orientation';

let passed = 0;
function ok(label: string): void {
  passed++;
  console.log(`  ok ${passed} - ${label}`);
}

const read = (p: string): string => readFileSync(new URL(p, import.meta.url), 'utf8');
const player = read('../src/lib/components/live-tv/LiveTvPlayer.svelte');
const page = read('../src/routes/live-tv/+page.svelte');
const orientationModule = read('../src/lib/client/live-tv/fullscreen-orientation.ts');

/** Let the microtask + macrotask queues settle (promise resolutions land). */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

// ============================================================
// Fake capability environments (behavioral sections)
// ============================================================
type LockMode = 'auto-resolve' | 'auto-reject' | 'throw-sync' | 'manual';

interface FakeOrientationEnv {
  env: LiveTvOrientationEnv;
  /** lock() arguments, one entry per call. */
  locks: string[];
  /** unlock() call count. */
  unlocks: number;
  /** Settle the i-th lock promise (manual mode). */
  settle: (index: number, outcome: 'resolve' | 'reject') => void;
}

/**
 * Builds an injectable environment. Defaults describe a normal Android
 * phone: coarse primary pointer, touch points present, Screen Orientation
 * API fully available.
 */
function fakeEnv(
  opts: {
    coarsePointer?: boolean;
    touchPoints?: number;
    withOrientationApi?: boolean;
    withLock?: boolean;
    withUnlock?: boolean;
    withMatchMedia?: boolean;
    lockMode?: LockMode;
  } = {}
): FakeOrientationEnv {
  const coarsePointer = opts.coarsePointer ?? true;
  const touchPoints = opts.touchPoints ?? 5;
  const lockMode = opts.lockMode ?? 'auto-resolve';
  const locks: string[] = [];
  const settlements: Array<(outcome: 'resolve' | 'reject') => void> = [];
  let unlocks = 0;
  const fake = {
    env: {
      orientation:
        opts.withOrientationApi === false
          ? undefined
          : {
              ...(opts.withLock === false
                ? {}
                : {
                    lock: (orientation: 'landscape'): Promise<void> => {
                      locks.push(orientation);
                      if (lockMode === 'throw-sync') throw new Error('sync unsupported');
                      if (lockMode === 'auto-reject') return Promise.reject(new Error('rejected'));
                      if (lockMode === 'manual') {
                        return new Promise<void>((resolve, reject) => {
                          settlements.push((outcome) =>
                            outcome === 'resolve' ? resolve() : reject(new Error('late reject'))
                          );
                        });
                      }
                      return Promise.resolve();
                    }
                  }),
              ...(opts.withUnlock === false ? {} : { unlock: () => void (unlocks += 1) })
            },
      matchMedia:
        opts.withMatchMedia === false
          ? undefined
          : (query: string) => ({ matches: query === '(pointer: coarse)' ? coarsePointer : false }),
      maxTouchPoints: touchPoints
    } as LiveTvOrientationEnv,
    locks,
    get unlocks() {
      return unlocks;
    },
    settle: (index: number, outcome: 'resolve' | 'reject') => settlements[index]?.(outcome)
  };
  return fake;
}

// ============================================================
// §A0 — SSR import safety + capability gate truth table
// ============================================================
{
  // Importing the real module under Node (done above) is exactly what the
  // SSR server does — no browser API was touched. The default environment
  // must be inert without a `window` (Node here).
  assert.deepEqual(defaultLiveTvOrientationEnv(), {}, 'default env is empty under Node (SSR-safe)');
  assert.equal(
    canAttemptLandscapeLock(defaultLiveTvOrientationEnv()),
    false,
    'the real default env never attempts a lock on the server'
  );

  // Capability truth table (pure function, never throws).
  const mobile = fakeEnv().env; // coarse + touch + full API
  const touchLaptop = fakeEnv({ coarsePointer: false, touchPoints: 10 }).env; // fine pointer, touch screen
  const noTouch = fakeEnv({ touchPoints: 0 }).env;
  const noOrientationApi = fakeEnv({ withOrientationApi: false }).env; // iOS/iPadOS Safari shape
  const noLockFn = fakeEnv({ withLock: false }).env; // orientation object without lock()
  const noMatchMedia = fakeEnv({ withMatchMedia: false }).env;
  assert.equal(canAttemptLandscapeLock(mobile), true, 'coarse pointer + touch + API => attempt');
  assert.equal(canAttemptLandscapeLock(touchLaptop), false, 'fine primary pointer (desktop/touch laptop) => NEVER attempt');
  assert.equal(canAttemptLandscapeLock(noTouch), false, 'coarse pointer but zero touch points => no attempt');
  assert.equal(canAttemptLandscapeLock(noOrientationApi), false, 'no Screen Orientation API => no attempt');
  assert.equal(canAttemptLandscapeLock(noLockFn), false, 'orientation object without lock() => no attempt');
  assert.equal(canAttemptLandscapeLock(noMatchMedia), false, 'no matchMedia capability probe => no attempt');
  // The module itself contains no console calls (repo convention).
  assert.ok(!orientationModule.includes('console.'), 'the orientation module never logs');
  ok('A0. SSR-safe import; capability gate truth table; module hygiene');
}

// ============================================================
// §A1 — Cases 1 + 2: mobile fullscreen (native OR embed) requests landscape
// ============================================================
{
  // The coordinator is playback-mode-agnostic: ONE noteFullscreenGained
  // per fullscreen session, whatever element inside the shared surface
  // the browser promoted (native surface via our button, or the embed
  // iframe via LiveGT's internal button — §B1 proves both route here).
  const f = fakeEnv({ lockMode: 'auto-resolve' });
  const c = createLiveTvFullscreenOrientationCoordinator(f.env);
  c.noteFullscreenGained();
  await flush();
  assert.deepEqual(f.locks, ['landscape'], 'lock("landscape") requested exactly once');
  assert.equal(f.unlocks, 0, 'nothing unlocked while fullscreen remains active');

  // Duplicate gained events (defensive) must not stack lock attempts.
  c.noteFullscreenGained();
  await flush();
  assert.equal(f.locks.length, 1, 'duplicate fullscreen-gained is idempotent');
  c.noteFullscreenLost();
  assert.equal(f.unlocks, 1, 'exit after a held lock unlocks exactly once');
  ok('A1. mobile fullscreen requests landscape once; duplicate gains are no-ops');
}

// ============================================================
// §A2 — Case 3: desktop never requests an orientation lock
// ============================================================
{
  // Touch laptop (touch points but FINE primary pointer) and pure desktop.
  for (const [label, opts] of [
    ['fine pointer + 10 touch points (touch laptop)', { coarsePointer: false, touchPoints: 10 }],
    ['fine pointer + 0 touch points (pure desktop)', { coarsePointer: false, touchPoints: 0 }]
  ] as const) {
    const f = fakeEnv(opts);
    const c = createLiveTvFullscreenOrientationCoordinator(f.env);
    c.noteFullscreenGained();
    await flush();
    c.noteFullscreenLost();
    c.dispose();
    assert.equal(f.locks.length, 0, `${label}: lock() never called`);
    assert.equal(f.unlocks, 0, `${label}: unlock() never called — zero orientation traffic`);
  }
  ok('A2. desktop fullscreen: zero orientation-lock traffic (behavior unchanged)');
}

// ============================================================
// §A3 — Case 4: orientation API unavailable => fullscreen still works
// ============================================================
{
  // iOS/iPadOS Safari shape: no screen.orientation at all.
  const f = fakeEnv({ withOrientationApi: false });
  const c = createLiveTvFullscreenOrientationCoordinator(f.env);
  c.noteFullscreenGained(); // must not throw
  await flush();
  c.noteFullscreenLost(); // must not throw
  c.dispose(); // must not throw
  assert.equal(f.unlocks, 0, 'unlock never called (nothing was ever locked)');
  assert.equal(f.locks.length, 0, 'lock never called');

  // Degenerate shape: orientation object exists but lock() is missing.
  const f2 = fakeEnv({ withLock: false });
  const c2 = createLiveTvFullscreenOrientationCoordinator(f2.env);
  c2.noteFullscreenGained();
  await flush();
  c2.noteFullscreenLost();
  assert.equal(f2.locks.length, 0, 'no lock function => no attempt');
  ok('A3. missing Screen Orientation API: coordinator is a silent no-op (fullscreen unaffected)');
}

// ============================================================
// §A4 — Case 5: lock() rejects or throws => no failure escapes
// ============================================================
{
  // Rejected lock promise: both promise handlers are attached by the
  // coordinator, so no unhandled rejection can escape. Measured with a
  // real process-level detector across a settle window.
  const f = fakeEnv({ lockMode: 'auto-reject' });
  const c = createLiveTvFullscreenOrientationCoordinator(f.env);
  const rejections: unknown[] = [];
  const onRejection = (reason: unknown) => void rejections.push(reason);
  process.on('unhandledRejection', onRejection);
  try {
    // Scenario 1: exit while the rejection is still pending.
    c.noteFullscreenGained();
    c.noteFullscreenLost();
    assert.equal(f.unlocks, 1, 'exit during a pending attempt still releases');
    await new Promise((resolve) => setTimeout(resolve, 25)); // settle
    assert.equal(f.unlocks, 1, 'the settled rejection adds no further unlock (nothing was locked)');
    // Scenario 2: destruction without an intervening exit.
    c.noteFullscreenGained();
    c.dispose();
    assert.equal(f.unlocks, 2, 'dispose releases the new outstanding attempt');
    await new Promise((resolve) => setTimeout(resolve, 25)); // settle
  } finally {
    process.off('unhandledRejection', onRejection);
  }
  assert.equal(rejections.length, 0, 'zero unhandled promise rejections');
  assert.equal(f.locks.length, 2, 'both lock attempts were made');

  // Synchronous throw from lock(): swallowed, lifecycle continues.
  const f2 = fakeEnv({ lockMode: 'throw-sync' });
  const c2 = createLiveTvFullscreenOrientationCoordinator(f2.env);
  c2.noteFullscreenGained(); // must not throw
  c2.noteFullscreenLost();
  await flush();
  assert.equal(f2.locks.length, 1, 'the attempt was made (then threw internally)');
  assert.equal(f2.unlocks, 0, 'never locked => nothing to release');
  ok('A4. rejected/thrown lock: swallowed, zero unhandled rejections, lifecycle intact');
}

// ============================================================
// §A5 — Case 6: fullscreen exit unlocks when appropriate
// ============================================================
{
  // Held lock -> exit -> unlock exactly once.
  const f = fakeEnv({ lockMode: 'auto-resolve' });
  const c = createLiveTvFullscreenOrientationCoordinator(f.env);
  c.noteFullscreenGained();
  await flush(); // lock resolved => held
  c.noteFullscreenLost();
  assert.equal(f.unlocks, 1, 'held lock released on exit');
  // A second lost (fullscreen churn elsewhere in the document) is inert.
  c.noteFullscreenLost();
  assert.equal(f.unlocks, 1, 'no double-unlock churn');
  ok('A5. exit releases a held landscape lock exactly once');
}

// ============================================================
// §A6 — Case 7: component destruction leaves no lock behind
// ============================================================
{
  // Destroyed while the lock promise is still pending.
  const f = fakeEnv({ lockMode: 'manual' });
  const c = createLiveTvFullscreenOrientationCoordinator(f.env);
  c.noteFullscreenGained();
  c.dispose(); // destruction while pending
  assert.equal(f.unlocks, 1, 'dispose releases the outstanding attempt');
  f.settle(0, 'resolve'); // the promise settles AFTER destruction
  await flush();
  assert.equal(f.unlocks, 2, 'late resolve after dispose is answered with a defensive unlock');
  // Everything after dispose is a no-op (no zombie locks).
  c.noteFullscreenGained();
  c.noteFullscreenLost();
  c.dispose();
  await flush();
  assert.equal(f.unlocks, 2, 'post-dispose events never lock again');
  assert.equal(f.locks.length, 1, 'post-dispose gained never attempts a lock');

  // Destroyed while a lock is HELD (resolved earlier).
  const f2 = fakeEnv({ lockMode: 'auto-resolve' });
  const c2 = createLiveTvFullscreenOrientationCoordinator(f2.env);
  c2.noteFullscreenGained();
  await flush(); // held
  c2.dispose();
  assert.equal(f2.unlocks, 1, 'dispose releases a held lock');
  ok('A6. destruction (pending or held lock) always ends unlocked');
}

// ============================================================
// §A7 — Case 8: rapid enter/exit leaves no stale lock
// ============================================================
{
  // Enter -> exit BEFORE the lock promise settles -> late resolve must be
  // answered with a defensive unlock (it can re-apply a lock the exit
  // path already released).
  const f = fakeEnv({ lockMode: 'manual' });
  const c = createLiveTvFullscreenOrientationCoordinator(f.env);
  c.noteFullscreenGained();
  assert.equal(f.locks.length, 1);
  c.noteFullscreenLost(); // rapid exit
  assert.equal(f.unlocks, 1, 'exit released while pending');
  f.settle(0, 'resolve'); // late resolve
  await flush();
  assert.equal(f.unlocks, 2, 'late resolve re-unlocked => no stale lock survives');

  // Enter -> exit -> enter (rapid churn): the OLD session's late resolve
  // must NOT unlock the NEW session's lock.
  const f2 = fakeEnv({ lockMode: 'manual' });
  const c2 = createLiveTvFullscreenOrientationCoordinator(f2.env);
  c2.noteFullscreenGained(); // session A attempt #0
  c2.noteFullscreenLost(); // unlock #1
  c2.noteFullscreenGained(); // session B attempt #1
  f2.settle(0, 'resolve'); // session A resolves late — stale
  await flush();
  assert.equal(f2.unlocks, 1, 'stale session-A resolve did NOT disturb session B');
  f2.settle(1, 'resolve'); // session B resolves — current
  await flush();
  assert.equal(f2.unlocks, 1, 'session B lock holds while fullscreen');
  c2.noteFullscreenLost();
  assert.equal(f2.unlocks, 2, 'session B exit releases its own lock');
  ok('A7. rapid enter/exit: late resolves are defensive-unlocked; live sessions are never disturbed');
}

// ============================================================
// §A8 — Case 9: channel switch never leaves an orientation lock
// ============================================================
{
  // A channel switch keeps the SAME surface fullscreen (the player
  // component persists; §B3 proves the switch paths never touch the
  // coordinator), so the lock legitimately HOLDS across the switch and
  // is released by the next fullscreen exit — never leaked.
  const f = fakeEnv({ lockMode: 'auto-resolve' });
  const c = createLiveTvFullscreenOrientationCoordinator(f.env);
  c.noteFullscreenGained();
  await flush(); // locked
  // ... channel switch happens here: NO coordinator events (surface persists)
  assert.equal(f.unlocks, 0, 'lock holds across a channel switch (still fullscreen)');
  assert.equal(f.locks.length, 1, 'no re-lock churn on switch');
  c.noteFullscreenLost(); // user exits fullscreen after the switch
  assert.equal(f.unlocks, 1, 'lock released on the post-switch exit');
  ok('A8. channel switch: lock persists only while fullscreen persists, then releases');
}

// ============================================================
// §B1 — Cases 1 + 2 wiring: one shared surface covers BOTH modes
// ============================================================
{
  // The coordinator comes from the dedicated module (single import).
  assert.ok(
    player.includes(
      "import { createLiveTvFullscreenOrientationCoordinator } from '$lib/client/live-tv/fullscreen-orientation';"
    ),
    'the player imports the coordinator factory from the live-tv module'
  );
  // Exactly ONE instantiation per component.
  assert.equal((player.match(/createLiveTvFullscreenOrientationCoordinator\(/g) ?? []).length, 1, 'exactly one coordinator instance');

  // The fullscreenchange handler keeps the EXACT former isFullscreen
  // semantics (button icon + analytics intent)...
  assert.ok(player.includes('isFullscreen = fullscreenElement === surface;'), 'isFullscreen semantics unchanged (surface identity)');

  // ...and additionally treats a fullscreen element INSIDE the surface as
  // our fullscreen — this is what routes the cross-origin embed's internal
  // fullscreen (the browser promotes the <iframe> element in this
  // document) through the SAME lock path as the native player.
  assert.ok(player.includes('surface.contains(fullscreenElement)'), 'containment check covers the embed iframe element');
  assert.ok(
    player.includes('if (surfaceFullscreen) fullscreenOrientation.noteFullscreenGained();'),
    'gained is driven by the containment result (both modes)'
  );
  assert.ok(
    player.includes('fullscreenOrientation.noteFullscreenLost();'),
    'any non-surface fullscreen state reports lost'
  );
  // The iframe's documented permissions are preserved verbatim.
  assert.ok(player.includes('allowfullscreen'), 'iframe allowfullscreen preserved');
  assert.ok(
    player.includes('allow="autoplay; fullscreen; encrypted-media; picture-in-picture"'),
    'iframe allow-list preserved verbatim'
  );
  // The cross-origin iframe is never reached into.
  assert.ok(!player.includes('contentDocument'), 'the iframe document is never accessed');
  assert.ok(!player.includes('contentWindow'), 'the iframe window is never accessed');
  ok('B1. native + embed fullscreen route through the one shared-surface handler');
}

// ============================================================
// §B2 — Case 7 wiring: teardown disposes the coordinator
// ============================================================
{
  const destroyBody = player.slice(player.indexOf('onDestroy(() => {'), player.indexOf('});', player.indexOf('onDestroy(() => {')));
  assert.ok(destroyBody.includes('fullscreenOrientation.dispose();'), 'onDestroy disposes the orientation coordinator');
  ok('B2. component teardown always releases the orientation lock');
}

// ============================================================
// §B3 — Case 9 wiring: orientation work is owned ONLY by the fullscreen lifecycle
// ============================================================
{
  // Exactly one call site each — inside onFullscreenChange — so channel
  // switches, retries, fallback activation, and every other player flow
  // can never lock/unlock orientation by themselves.
  assert.equal((player.match(/fullscreenOrientation\.noteFullscreenGained\(\)/g) ?? []).length, 1, 'single gained call site');
  assert.equal((player.match(/fullscreenOrientation\.noteFullscreenLost\(\)/g) ?? []).length, 1, 'single lost call site');
  assert.equal((player.match(/fullscreenOrientation\.dispose\(\)/g) ?? []).length, 1, 'single dispose call site');
  // The handler is still registered exactly once on the document, with cleanup.
  assert.equal((player.match(/document\.addEventListener\('fullscreenchange', onFullscreenChange\)/g) ?? []).length, 1, 'one fullscreenchange registration');
  assert.equal((player.match(/document\.removeEventListener\('fullscreenchange', onFullscreenChange\)/g) ?? []).length, 1, 'registration is cleaned up');
  // The component itself never touches the orientation API directly —
  // all capability gating and lock/unlock work lives in the module.
  assert.ok(!player.includes('screen.orientation'), 'the component never touches screen.orientation itself');
  assert.ok(!player.includes('.lock('), 'the component never calls lock() itself');
  assert.ok(!player.includes('.unlock('), 'the component never calls unlock() itself');
  // The page owns none of this either.
  assert.ok(!page.includes('fullscreenOrientation'), 'the page has no orientation wiring');
  assert.ok(!page.includes('screen.orientation'), 'the page never touches screen.orientation');
  ok('B3. orientation lifecycle is owned solely by the fullscreenchange handler');
}

// ============================================================
// §B4 — Case 10: the LT-15 fallback architecture is untouched
// ============================================================
{
  // Fullscreen request/exit mechanics are byte-for-byte the same calls.
  assert.equal((player.match(/void surface\.requestFullscreen\(\)\.catch\(\(\) => \{\}\);/g) ?? []).length, 1, 'fullscreen entry call unchanged');
  assert.equal((player.match(/void document\.exitFullscreen\(\)\.catch\(\(\) => \{\}\);/g) ?? []).length, 1, 'fullscreen exit call unchanged');
  // The user-action analytics intents are exactly the same set.
  assert.deepEqual(
    (player.match(/onuseraction\('([a-z_]+)'\)/g) ?? []).sort(),
    ["onuseraction('fullscreen_enter')", "onuseraction('fullscreen_exit')", "onuseraction('pause')"],
    'analytics intent set unchanged'
  );
  // The LT-15 embed fallback invariants are all intact.
  assert.equal((player.match(/<iframe/g) ?? []).length, 1, 'still exactly one iframe');
  assert.ok(!player.includes('{@html'), 'no {@html}');
  assert.ok(player.includes('src={embedSrc}'), 'iframe src still comes from the builder only');
  assert.ok(player.includes('class:embed-hidden={embedActive}'), 'native video still hidden in fallback mode');
  assert.ok(player.includes('{#key embedReloadToken}'), 'iframe still keyed by the reload token');
  assert.ok(player.includes('title="Live TV alternate player"'), 'iframe a11y title preserved');
  // No orientation-related hacks were introduced.
  assert.ok(!player.includes('rotate(90'), 'no CSS rotation hack');
  assert.ok(!player.includes('viewport'), 'no viewport meta manipulation');
  assert.ok(!player.includes('requestWakeLock'), 'no unrelated APIs dragged in');
  // The engine/fallback classifier/analytics modules are untouched by LT-16.
  const playerErrors = read('../src/lib/client/live-tv/player-errors.ts');
  assert.ok(playerErrors.includes('shouldFallbackToEmbed'), 'fallback classifier intact');
  ok('B4. LT-15 fallback architecture, fullscreen mechanics and analytics are unchanged');
}

console.log(`\nLT-16 mobile fullscreen orientation: ${passed} checks passed.`);
