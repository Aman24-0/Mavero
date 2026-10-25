/**
 * Player V2 CORRECTIONS regression suite (real-device feedback fixes).
 *
 * Covers every reported issue class and its fix:
 *   §1  Approved three-zone layout on the SHELL (Back top-left always,
 *       Landscape FAB embed-only, full-shell pointer-transparent control
 *       overlay, seek-feedback + hold surfaces).
 *   §2  Playback lifecycle — the reported "audio continues after Back" and
 *       "PiP close leaves audio" root cause: the shell cleanup now STOPS the
 *       media session (exit PiP → pause → release src) and can never leave
 *       a 2× hold engaged across teardown.
 *   §3  Tap gestures — double-tap seek (left −10 s / right +10 s) and
 *       press-and-hold 2× with EXACT restore: behavioral tests against the
 *       real controller with a fake touch surface.
 *   §4  Honest subtitle/intro feature states (always-rendered subtitle menu
 *       with empty/error notice, typed status machine, safe diagnostics,
 *       typed intro failure kinds).
 *   §5  Display modes (Fit/Fill/Stretch) — CSS-only object-fit on the direct
 *       video, control absent for embeds.
 *   §6  Quality selector usable on phones (no display:none anywhere).
 *   §7  Icon/label details (recognizable rotate-square seek icons, single
 *       speed renderer, finite time values, no duplicated fullscreen).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createPlayerTapGestureController, tapSideForX, withinTapSlop, DOUBLE_TAP_WINDOW_MS, HOLD_ACTIVATE_MS, TAP_SLOP_PX } from '$lib/client/player/touch/gestures';
import { createIntroLookup } from '$lib/client/player/intro/intro-client';

const shell = readFileSync(resolve('src/lib/components/player/PlayerShell.svelte'), 'utf-8');
const controls = readFileSync(resolve('src/lib/components/player/PlayerControls.svelte'), 'utf-8');
const subtitleSheet = readFileSync(resolve('src/lib/components/player/PlayerSubtitleSheet.svelte'), 'utf-8');
const viewport = readFileSync(resolve('src/lib/components/player/PlayerViewport.svelte'), 'utf-8');
const gestures = readFileSync(resolve('src/lib/client/player/touch/gestures.ts'), 'utf-8');
const introClient = readFileSync(resolve('src/lib/client/player/intro/intro-client.ts'), 'utf-8');

let checks = 0;
function ok(condition: boolean, label: string) {
  assert.ok(condition, label);
  checks += 1;
}

// ============================================================
// §1 — Approved layout: shell surfaces
// ============================================================

ok(!/\{#if[^\n]*blueVelvetActive/.test(shell), '1. no Blue Velvet layout exception remains in the shell (one approved layout)');
ok(/<button class="back-fab"/.test(shell) && /aria-label="Close player"/.test(shell), '1. the Back control is the shell top-left FAB (unconditional)');
ok(/\{#if source\?\.type === 'embed'\}\s*\n\s*<div class="control-fab-group"/.test(shell), '1. the floating Landscape FAB group renders only for embed sources');
ok(/\.direct-controls-overlay \{ position: absolute; z-index: 10; inset: 0; opacity: 1; transition: opacity var\(--motion-normal\) var\(--ease-out\); pointer-events: none; \}/.test(shell), '1. the direct-controls overlay is a full-shell, pointer-transparent surface (taps reach the video for gestures/reveal)');
ok(/\.direct-controls-overlay:not\(\.visible\) :global\(\*\) \{ pointer-events: none !important; \}/.test(shell), '1. hidden controls are fully non-interactive (no invisible hit targets)');
ok(/class="seek-feedback"/.test(shell) && /seekFeedback === 'backward' \? '−10' : '\+10'/.test(shell), '1. the double-tap seek feedback pill renders direction + amount');
ok(/class="gesture-indicator hold-indicator"/.test(shell) && /holdSpeedActive/.test(shell), '1. the press-and-hold 2× indicator exists');
ok(/\{displayMode\}/.test(shell) && /onDisplayMode=\{setDisplayMode\}/.test(shell), '1. the shell threads displayMode into the viewport and the controls');
ok(/subtitleNotice=\{externalSubtitleNotice\}/.test(shell), '1. the shell threads the honest subtitle notice into the controls');
ok(/class="utility-zone"/.test(controls) && /class="center-cluster"/.test(controls) && /class="bottom-zone"/.test(controls), '1. PlayerControls carries the three approved zones');

// ============================================================
// §2 — Playback lifecycle: Back / PiP / teardown stop the media session
// ============================================================

// The cleanup body must STOP the media session in this exact order:
// exit PiP (the PiP window would keep the element alive) → pause → release src.
const cleanupIdx = shell.indexOf('document.documentElement.removeAttribute(\'data-player-open\')');
const cleanupBody = cleanupIdx > -1 ? shell.slice(cleanupIdx, shell.indexOf('landscapePresentationIntent = false;', cleanupIdx)) : '';
ok(cleanupBody.length > 0, '2. the onMount cleanup body is located');
// [2026-10 Phase-5 SSR guard] 79f2f2c added the `browser &&` guard to
// every document.pictureInPictureElement access (the sibling reactive
// statements DO execute during SSR of watch pages). The cleanup guard
// is behavior-neutral (onMount teardown only runs client-side) — the
// assertion still requires the exact PiP-exit branch tied to the video
// element, before the media stop.
ok(/if \(browser && document\.pictureInPictureElement === videoElement\) exitPipQuietly\(\);/.test(cleanupBody), '2. cleanup exits PiP (the window must not keep the element alive across navigation; SSR-guarded since Phase 5)');
ok(cleanupBody.indexOf('exitPipQuietly()') < cleanupBody.indexOf('videoElement.pause()'), '2. PiP exits BEFORE the media stop (window released first)');
ok(/if \(videoElement\) \{\s*try \{ videoElement\.pause\(\); \} catch \{ \/\* already stopped \*\/ \}\s*try \{\s*videoElement\.removeAttribute\('src'\);\s*videoElement\.load\(\);\s*\} catch \{ \/\* element already reset \*\/ \}\s*\}/.test(cleanupBody), '2. cleanup PAUSES the element and RELEASES the resource (removeAttribute src + load) — a detached <video> keeps playing otherwise (the reported background-audio bug)');
ok(/removeAttribute\('src'\)/.test(cleanupBody) && /videoElement\.load\(\)/.test(cleanupBody), '2. the media resource is released (no detached streaming after Back)');
ok(/handleHoldEnd\(\);\s*\n\s*if \(seekFeedbackTimer\) clearTimeout\(seekFeedbackTimer\);/.test(shell), '2. teardown restores the pre-hold speed BEFORE the tap controller dies');
ok(/tapGestureController\?\.destroy\(\);\s*\n\s*tapGestureController = null;/.test(shell), '2. the tap gesture controller is destroyed with the shell');
ok(/engineQuality = null;\s*\n\s*\/\/ Player V2 corrections: an in-flight tap gesture belongs to the OLD\s*\n\s*\/\/ source session — cancel it \(restores 2× if a hold was active\)\.\s*\n\s*tapGestureController\?\.cancel\(\);/.test(shell), '2. a SOURCE switch cancels the old session tap gesture (restores 2×)');
ok(/an episode switch ends the previous session's[\s\S]{0,120}tapGestureController\?\.cancel\(\);/.test(shell), '2. an EPISODE switch cancels the old session tap gesture');
ok(/tapGestureController\?\.cancel\(\);\s*\n\s*controlsVisible = false;/.test(shell), '2. engaging the touch lock cancels any pending tap gesture (2× never survives a lock)');
ok(/handleHoldEnd\(\);\s*\n\s*if \(videoElement && !videoElement\.paused\) \{/.test(shell), '2. starting a Cast session ends any active 2× hold (local-surface gesture)');

// ============================================================
// §3 — Tap gestures: double-tap seek + press-and-hold 2× (behavioral)
// ============================================================

ok(tapSideForX(0, 1000) === 'left' && tapSideForX(499, 1000) === 'left', '3. tapSideForX: the left half is the backward zone');
ok(tapSideForX(500, 1000) === 'right' && tapSideForX(999, 1000) === 'right', '3. tapSideForX: the right half is the forward zone');
ok(tapSideForX(100, 0) === null && tapSideForX(Number.NaN, 100) === null, '3. tapSideForX: degenerate widths/non-finite input are safe');
ok(withinTapSlop(0, 0) === true && withinTapSlop(12, 0) === true, '3. withinTapSlop: movement up to the slop stays a tap');
ok(withinTapSlop(13, 0) === false && withinTapSlop(0, -13) === false, '3. withinTapSlop: beyond the slop is a drag (the swipe controller owns it)');
ok(DOUBLE_TAP_WINDOW_MS === 300 && HOLD_ACTIVATE_MS === 500 && TAP_SLOP_PX === 12, '3. documented policy bounds (double-tap window, hold activation, tap slop)');

type FakeTouch = { identifier: number; clientX: number; clientY: number };
type FakeEvent = { changedTouches: FakeTouch[]; target: unknown; preventDefault?: () => void };
function fakeSurface() {
  const listeners = new Map<string, (event: FakeEvent) => void>();
  const removed = new Set<string>();
  return {
    addEventListener(type: string, handler: (event: FakeEvent) => void) { listeners.set(type, handler); },
    removeEventListener(type: string) { removed.add(type); listeners.delete(type); },
    clientWidth: 1000,
    fire(type: string, event: FakeEvent) { listeners.get(type)?.(event); },
    listenerCount: (type: string) => (listeners.has(type) ? 1 : 0),
    removedCount: () => removed.size,
  };
}
function touch(id: number, x: number, y: number): FakeTouch {
  return { identifier: id, clientX: x, clientY: y };
}

{
  // Double-tap LEFT → backward.
  const surface = fakeSurface();
  const seen: string[] = [];
  let clock = 1000;
  const controller = createPlayerTapGestureController({
    surface: surface as unknown as HTMLElement,
    enabled: () => true,
    onDoubleTap: (direction) => seen.push(`tap:${direction}`),
    onHoldStart: () => seen.push('hold:start'),
    onHoldEnd: () => seen.push('hold:end'),
    now: () => clock,
  });
  surface.fire('touchstart', { changedTouches: [touch(1, 180, 300)], target: {} });
  surface.fire('touchend', { changedTouches: [touch(1, 180, 300)], target: {} });
  clock += 120;
  surface.fire('touchstart', { changedTouches: [touch(2, 190, 305)], target: {} });
  surface.fire('touchend', { changedTouches: [touch(2, 190, 305)], target: {} });
  ok(seen.length === 1 && seen[0] === 'tap:backward', '3. double-tap on the LEFT half seeks BACKWARD 10 s');
  controller.destroy();
}
{
  // Double-tap RIGHT → forward; opposite sides never combine.
  const surface = fakeSurface();
  const seen: string[] = [];
  let clock = 1000;
  const controller = createPlayerTapGestureController({
    surface: surface as unknown as HTMLElement,
    enabled: () => true,
    onDoubleTap: (direction) => seen.push(direction),
    onHoldStart: () => {},
    onHoldEnd: () => {},
    now: () => clock,
  });
  surface.fire('touchstart', { changedTouches: [touch(1, 850, 300)], target: {} });
  surface.fire('touchend', { changedTouches: [touch(1, 850, 300)], target: {} });
  clock += 200;
  surface.fire('touchstart', { changedTouches: [touch(2, 860, 290)], target: {} });
  surface.fire('touchend', { changedTouches: [touch(2, 860, 290)], target: {} });
  ok(seen.length === 1 && seen[0] === 'forward', '3. double-tap on the RIGHT half seeks FORWARD 10 s');
  surface.fire('touchstart', { changedTouches: [touch(3, 850, 300)], target: {} });
  surface.fire('touchend', { changedTouches: [touch(3, 850, 300)], target: {} });
  clock += 100;
  surface.fire('touchstart', { changedTouches: [touch(4, 150, 300)], target: {} });
  surface.fire('touchend', { changedTouches: [touch(4, 150, 300)], target: {} });
  ok(seen.length === 1, '3. opposite-side taps never combine into a seek');
  controller.destroy();
}
{
  // Beyond the double-tap window → single taps only.
  const surface = fakeSurface();
  let taps = 0;
  let clock = 1000;
  const controller = createPlayerTapGestureController({
    surface: surface as unknown as HTMLElement,
    enabled: () => true,
    onDoubleTap: () => { taps += 1; },
    onHoldStart: () => {},
    onHoldEnd: () => {},
    now: () => clock,
  });
  surface.fire('touchstart', { changedTouches: [touch(1, 200, 300)], target: {} });
  surface.fire('touchend', { changedTouches: [touch(1, 200, 300)], target: {} });
  clock += DOUBLE_TAP_WINDOW_MS + 1;
  surface.fire('touchstart', { changedTouches: [touch(2, 200, 300)], target: {} });
  surface.fire('touchend', { changedTouches: [touch(2, 200, 300)], target: {} });
  ok(taps === 0, '3. two taps beyond the double-tap window never seek');
  controller.destroy();
}
{
  // Movement beyond the slop cancels the pending tap (a swipe is not a tap).
  const surface = fakeSurface();
  let taps = 0;
  let clock = 1000;
  const controller = createPlayerTapGestureController({
    surface: surface as unknown as HTMLElement,
    enabled: () => true,
    onDoubleTap: () => { taps += 1; },
    onHoldStart: () => {},
    onHoldEnd: () => {},
    now: () => clock,
  });
  surface.fire('touchstart', { changedTouches: [touch(1, 200, 300)], target: {} });
  surface.fire('touchmove', { changedTouches: [touch(1, 200, 340)], target: {} });
  surface.fire('touchend', { changedTouches: [touch(1, 200, 340)], target: {} });
  surface.fire('touchstart', { changedTouches: [touch(2, 200, 300)], target: {} });
  surface.fire('touchend', { changedTouches: [touch(2, 200, 300)], target: {} });
  ok(taps === 0, '3. a swipe followed by a tap never produces a double-tap seek (vertical-swipe arbitration)');
  controller.destroy();
}
{
  // Press-and-hold → 2×; release → restore (real timers, bounded waits).
  const surface = fakeSurface();
  const seen: string[] = [];
  const controller = createPlayerTapGestureController({
    surface: surface as unknown as HTMLElement,
    enabled: () => true,
    onDoubleTap: () => seen.push('tap'),
    onHoldStart: () => seen.push('hold:start'),
    onHoldEnd: () => seen.push('hold:end'),
  });
  const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
  surface.fire('touchstart', { changedTouches: [touch(1, 500, 400)], target: {} });
  await sleep(HOLD_ACTIVATE_MS + 80);
  ok(seen[0] === 'hold:start', '3. press-and-hold activates 2× after the stillness window');
  surface.fire('touchmove', { changedTouches: [touch(1, 505, 404)], target: {} });
  ok(seen.length === 1, '3. micro-movement within the slop does NOT cancel an active hold');
  surface.fire('touchend', { changedTouches: [touch(1, 505, 404)], target: {} });
  ok(seen[1] === 'hold:end' && seen.length === 2, '3. releasing the hold restores the previous speed (exact restore)');
  surface.fire('touchend', { changedTouches: [touch(1, 505, 404)], target: {} });
  ok(seen.length === 2, '3. a stray duplicate touchend after teardown is inert');
  controller.destroy();
}
{
  // Releasing BEFORE the hold activates → a tap, never a hold.
  const surface = fakeSurface();
  const seen: string[] = [];
  let clock = 1000;
  const controller = createPlayerTapGestureController({
    surface: surface as unknown as HTMLElement,
    enabled: () => true,
    onDoubleTap: () => seen.push('tap'),
    onHoldStart: () => seen.push('hold:start'),
    onHoldEnd: () => seen.push('hold:end'),
    now: () => clock,
  });
  surface.fire('touchstart', { changedTouches: [touch(1, 500, 400)], target: {} });
  surface.fire('touchend', { changedTouches: [touch(1, 500, 400)], target: {} });
  ok(!seen.includes('hold:start') && !seen.includes('hold:end'), '3. a quick tap never activates the 2× hold');
  controller.destroy();
}
{
  // touchcancel during an active hold → restore (a missed release event can
  // never leave the player at 2×).
  const surface = fakeSurface();
  const seen: string[] = [];
  const controller = createPlayerTapGestureController({
    surface: surface as unknown as HTMLElement,
    enabled: () => true,
    onDoubleTap: () => seen.push('tap'),
    onHoldStart: () => seen.push('hold:start'),
    onHoldEnd: () => seen.push('hold:end'),
  });
  const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
  surface.fire('touchstart', { changedTouches: [touch(1, 500, 400)], target: {} });
  await sleep(HOLD_ACTIVATE_MS + 60);
  surface.fire('touchcancel', { changedTouches: [touch(1, 500, 400)], target: {} });
  ok(seen.includes('hold:start') && seen.includes('hold:end'), '3. touchcancel during a hold restores the speed (interruption safety)');
  controller.destroy();
}
{
  // A second finger cancels the hold; cancel() is idempotent.
  const surface = fakeSurface();
  const seen: string[] = [];
  const controller = createPlayerTapGestureController({
    surface: surface as unknown as HTMLElement,
    enabled: () => true,
    onDoubleTap: () => seen.push('tap'),
    onHoldStart: () => seen.push('hold:start'),
    onHoldEnd: () => seen.push('hold:end'),
  });
  const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
  surface.fire('touchstart', { changedTouches: [touch(1, 500, 400)], target: {} });
  await sleep(HOLD_ACTIVATE_MS + 60);
  surface.fire('touchstart', { changedTouches: [touch(2, 300, 400)], target: {} });
  ok(seen.filter((entry) => entry === 'hold:end').length === 1, '3. a second finger ends the hold (multi-touch interruption restores speed)');
  controller.cancel();
  controller.cancel();
  ok(seen.filter((entry) => entry === 'hold:end').length === 1, '3. cancel() is idempotent (no double restore)');
  controller.destroy();
}
{
  // destroy during an active hold → restore + listeners removed.
  const surface = fakeSurface();
  const seen: string[] = [];
  const controller = createPlayerTapGestureController({
    surface: surface as unknown as HTMLElement,
    enabled: () => true,
    onDoubleTap: () => seen.push('tap'),
    onHoldStart: () => seen.push('hold:start'),
    onHoldEnd: () => seen.push('hold:end'),
  });
  const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
  surface.fire('touchstart', { changedTouches: [touch(1, 500, 400)], target: {} });
  await sleep(HOLD_ACTIVATE_MS + 60);
  controller.destroy();
  ok(seen.includes('hold:end'), '3. destroy during a hold restores the speed (route change / unmount safety)');
  ok(surface.removedCount() === 4 && surface.listenerCount('touchstart') === 0 && surface.listenerCount('touchmove') === 0, '3. destroy removes exactly the four listeners (no duplicates across mount cycles)');
  surface.fire('touchstart', { changedTouches: [touch(9, 500, 400)], target: {} });
  surface.fire('touchend', { changedTouches: [touch(9, 500, 400)], target: {} });
  ok(!seen.includes('tap'), '3. no events are handled after destroy (no stale gesture surface)');
}
{
  // enabled() false + locked semantics: nothing fires.
  const surface = fakeSurface();
  const seen: string[] = [];
  let enabled = false;
  const controller = createPlayerTapGestureController({
    surface: surface as unknown as HTMLElement,
    enabled: () => enabled,
    onDoubleTap: () => seen.push('tap'),
    onHoldStart: () => seen.push('hold:start'),
    onHoldEnd: () => seen.push('hold:end'),
  });
  surface.fire('touchstart', { changedTouches: [touch(1, 200, 300)], target: {} });
  surface.fire('touchend', { changedTouches: [touch(1, 200, 300)], target: {} });
  enabled = true;
  surface.fire('touchend', { changedTouches: [touch(1, 200, 300)], target: {} });
  ok(seen.length === 0, '3. the per-touch enabled() gate (touch lock / embed / sheets / cast) suppresses everything');
  controller.destroy();
}
{
  // Interactive-target exclusion: taps on buttons/selects/sheets never seek.
  class FakeElement {
    closest(selector: string) {
      return selector.includes('button') ? (this as unknown as object) : null;
    }
  }
  const originalElement = (globalThis as { Element?: unknown }).Element;
  (globalThis as { Element?: unknown }).Element = FakeElement;
  try {
    const surface = fakeSurface();
    const seen: string[] = [];
    let clock = 1000;
    const controller = createPlayerTapGestureController({
      surface: surface as unknown as HTMLElement,
      enabled: () => true,
      onDoubleTap: () => seen.push('tap'),
      onHoldStart: () => seen.push('hold:start'),
      onHoldEnd: () => seen.push('hold:end'),
      now: () => clock,
    });
    const onButton = new FakeElement();
    surface.fire('touchstart', { changedTouches: [touch(1, 200, 300)], target: onButton });
    surface.fire('touchend', { changedTouches: [touch(1, 200, 300)], target: onButton });
    clock += 100;
    surface.fire('touchstart', { changedTouches: [touch(2, 200, 300)], target: onButton });
    surface.fire('touchend', { changedTouches: [touch(2, 200, 300)], target: onButton });
    ok(seen.length === 0, '3. taps on buttons/menus/seekbar never trigger a double-tap or a hold');
    controller.destroy();
  } finally {
    (globalThis as { Element?: unknown }).Element = originalElement;
  }
}

// Shell wiring of the tap controller.
ok(/tapGestureController = createPlayerTapGestureController\(\{/.test(shell), '3. the shell creates the tap controller in onMount');
ok(/onDoubleTap: handleDoubleTap,\s*\n\s*onHoldStart: handleHoldStart,\s*\n\s*onHoldEnd: handleHoldEnd,/.test(shell), '3. the shell wires double-tap → seek + feedback and hold → 2×/restore');
ok(/function handleDoubleTap\(direction: TapSeekDirection\) \{[\s\S]{0,200}seekBy\(direction === 'backward' \? -10 : 10\);/.test(shell), '3. double-tap seeks ±10 s through the existing clamped shell seek');
ok(/function handleHoldStart\(\) \{[\s\S]{0,220}setPlaybackRate\(2\);/.test(shell), '3. the hold sets 2× through the EXISTING speed path (select stays correct, single label)');
ok(/function handleHoldEnd\(\) \{[\s\S]{0,200}setPlaybackRate\(savedPlaybackRate\);/.test(shell), '3. release restores the EXACT pre-hold speed');
ok(/enabled: \(\) => !touchLocked && source\?\.type === 'direct' && !sourceMenuOpen && !episodeMenuOpen && !controlsSheetsOpen && sourceReady && !castConnected,\s*\n\s*onDoubleTap/.test(shell), '3. the tap gate mirrors the swipe gate (lock / direct ownership / sheets / cast)');

// ============================================================
// §4 — Honest subtitle/intro feature states
// ============================================================

// The subtitle menu ALWAYS renders (never hidden behind a tracks-length gate).
ok(!/\{#if subtitles\.length\}<label class="select-control" aria-label="Subtitles">/.test(controls), '4. the subtitle control is NOT gated on the tracks list (always rendered)');
// CONTRACT CHANGE (focused fixes, Issue 3): the subtitle <option> list became
// the Mavero Subtitle Settings sheet — Off remains the FIRST selectable entry
// and the honest notice renders as a non-selectable status row inside it.
ok(/aria-label=\{`Subtitles: \$\{subtitleButtonLabel\}/.test(controls), '4. the subtitle menu always renders (sheet-trigger contract)');
ok(/class="track-row" class:selected=\{selectedSubtitle === ''\}[\s\S]{0,240}<strong>Off<\/strong>/.test(subtitleSheet), '4. the subtitle menu always offers Off (first sheet entry)');
ok(/\{#if !tracks\.length && notice\}[\s\S]{0,160}class="notice-row"[\s\S]{0,80}\{notice\}/.test(subtitleSheet), '4. an empty/failed lookup shows the honest state notice INSIDE the sheet (never a fake track)');
ok(/externalSubtitleStatus: 'loading' \| 'ready' \| 'empty' \| 'failed' = 'loading'/.test(shell), '4. the shell carries the typed subtitle feature-state machine');
ok(/externalSubtitleNotice = result\.tracks\.length \? '' : 'No subtitles available';/.test(shell), '4. empty API result → "No subtitles available" (distinguishable from success)');
ok(/externalSubtitleStatus = 'failed';\s*\n\s*externalSubtitleNotice = 'Subtitles unavailable';/.test(shell), '4. a failed lookup → "Subtitles unavailable" (errors are never silently swallowed)');
ok(/externalSubtitleNotice = 'Checking subtitles…';/.test(shell), '4. the in-flight state is visible ("request has not completed")');
ok(/console\.info\(`\[mavero:subtitles\]/.test(shell), '4. safe subtitle diagnostics are logged (state + counts + typed failure kind)');
ok(!/console\.info\(`\[mavero:subtitles\][^`]*\$\{result\.tracks\[0\]|console\.info\(`\[mavero:subtitles\][^`]*proxyPath/.test(shell), '4. subtitle diagnostics never log URLs or provider payloads');
ok(/error=\$\{result\.error\}/.test(shell), '4. the typed failure kind (network/timeout/invalid-response) reaches the diagnostic line');

// Intro states.
ok(/introStatus: 'waiting-duration' \| 'loading' \| 'available' \| 'no-data' \| 'unavailable' = 'waiting-duration'/.test(shell), '4. the shell carries the typed intro feature-state machine (waiting → loading → available/no-data/unavailable)');
ok(/errorKind: 'api' \| 'timeout' \| 'invalid' \| 'network' \| null;/.test(introClient), '4. the intro lookup exposes the TYPED failure kind (no-data ≠ failed)');
ok(/error instanceof TheIntroDbApiError\s*\?\s*'api'/.test(introClient), '4. API errors (incl. rate limits / Cloudflare blocks) are typed as api');
ok(/error instanceof Error && error\.name === 'AbortError'\s*\?\s*'timeout'/.test(introClient), '4. timeouts are typed as timeout');
ok(/console\.info\(`\[mavero:intro\]/.test(shell), '4. safe intro diagnostics are logged (state + typed kind)');
ok(/\{#if activeSkipSegment && source\?\.type === 'direct' && !touchLocked && !castConnected\}/.test(shell), '4. Skip Intro renders ONLY with a verified in-segment playhead (never a fake button)');

// Behavioral: typed error kinds through the REAL lookup with mocked fetch.
function introFetch(raw: unknown, opts?: { status?: number; fail?: boolean }) {
  return (async () => {
    if (opts?.fail) throw new Error('getaddrinfo ENOTFOUND api.theintrodb.org');
    const status = opts?.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: 'OK',
      headers: { get: () => 'application/json' },
      text: async () => JSON.stringify(raw),
    };
  }) as unknown as typeof fetch;
}
{
  const lookup = createIntroLookup(introFetch({}, { fail: true }));
  const result = await lookup.getIntroSegments({ kind: 'movie', tmdbId: 278, durationSec: 7200 }, 'movie:278');
  ok(result.segments.length === 0 && result.empty && result.errorKind === 'network', '4. a network failure → typed "network" kind (degrades to no skip button, never blocks playback)');
  lookup.clearForTests();
}
{
  const lookup = createIntroLookup(introFetch({ error: 'Failed to retrieve submissions' }, { status: 500 }));
  const result = await lookup.getIntroSegments({ kind: 'movie', tmdbId: 278, durationSec: 7200 }, 'movie:278');
  ok(result.segments.length === 0 && result.errorKind === 'api', '4. an upstream 5xx → typed "api" kind');
  lookup.clearForTests();
}
{
  const lookup = createIntroLookup(introFetch({ tvdb_id: 77111, type: 'movie', intro: [{ start_ms: 5_000, end_ms: 20_000 }] }));
  const result = await lookup.getIntroSegments({ kind: 'movie', tmdbId: 278, durationSec: 7200 }, 'movie:278');
  ok(result.segments.length === 1 && result.segments[0].startSec === 5 && result.segments[0].endSec === 20 && result.errorKind === null, '4. a valid response → converted seconds (ms→s at the boundary) + null errorKind');
  lookup.clearForTests();
}

// ============================================================
// §5 — Display modes (Fit/Fill/Stretch)
// ============================================================

ok(/export let displayMode: 'fit' \| 'fill' \| 'stretch' = 'fit';/.test(viewport), '5. the viewport carries the typed display mode (default Fit = the historical contain)');
ok(/class:display-fill=\{displayMode === 'fill'\}/.test(viewport) && /class:display-stretch=\{displayMode === 'stretch'\}/.test(viewport), '5. the video element receives the mode classes');
ok(/\.viewport video\.display-fill \{ object-fit: cover; \}/.test(viewport), '5. Fill → object-fit: cover (aspect preserved, crop allowed)');
ok(/\.viewport video\.display-stretch \{ object-fit: fill; \}/.test(viewport), '5. Stretch → object-fit: fill (both axes, distortion allowed)');
ok(/\.viewport video, \.viewport iframe \{ position: relative; z-index: 1; width: 100%; height: 100%; min-height: inherit; border: 0; object-fit: contain;/.test(viewport), '5. the default stays Fit → object-fit: contain');
ok(/\.viewport iframe[^{]*\{ display: block; \}/.test(viewport) && !/iframe[^{]*display-fill/.test(viewport), '5. iframes are untouched (embed providers keep their own presentation — honest unavailability)');
ok(/function setDisplayMode\(mode: 'fit' \| 'fill' \| 'stretch'\) \{\s*\n\s*displayMode = mode;\s*\n\s*\}/.test(shell), '5. switching modes is CSS-only state (never restarts the stream or resets the playhead)');

// ============================================================
// §6 — Quality selector usable everywhere
// ============================================================

ok(!/\.quality \{ display: none/.test(controls) && !/\.volume-input, \.quality \{ display: none/.test(controls), '6. no rule hides the quality control on phones (the reported regression)');
// CONTRACT CHANGE (focused fixes, Issue 3): the quality options moved from
// <option> elements to the qualityMode option array feeding the sheet — the
// AUTO option + the REAL manifest levels are unchanged in substance.
ok(/qualityMode = internalQualities\.length > 1 \? 'internal' : qualities\.length > 1 \? 'stream' : 'none'/.test(controls) && /\{ id: PLAYER_AUTO_QUALITY_ID, label: 'Auto', selected: selectedInternalQuality === PLAYER_AUTO_QUALITY_ID \}/.test(controls), '6. engine HLS levels keep the AUTO option + real manifest levels (sheet option array)');
ok(/ qualities\.length > 1/.test(controls), '6. the per-stream quality fallback is retained');

// ============================================================
// §7 — Icon/label details
// ============================================================

ok(/aria-label="Seek backward 10 seconds"[\s\S]{0,120}RotateCcwSquare/.test(controls), '7. the backward control uses a correctly oriented rewind icon + meaningful name');
ok(/aria-label="Seek forward 10 seconds"[\s\S]{0,120}RotateCwSquare/.test(controls), '7. the forward control uses a correctly oriented forward icon + meaningful name');
ok(/aria-label=\{playing \? 'Pause' : 'Play'\}/.test(controls), '7. play/pause label reflects the actual media state');
ok((controls.match(/\{speed\}×/g) ?? []).length === 1, '7. the selected speed renders exactly once (no "1× 1×")');
ok(/Number\.isFinite\(duration\) && duration > 0 \? duration : 0/.test(controls), '7. time/duration use finite, valid values only (safeDuration guard)');
ok((controls.match(/aria-label="Seek playback"/g) ?? []).length === 1, '7. exactly one interactive seekbar');

console.log(`player_v2_corrections_test: ${checks} checks passed`);
