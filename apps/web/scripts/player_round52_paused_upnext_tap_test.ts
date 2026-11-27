/**
 * MAVERO — Round 52: five player fixes (F1–F5) — regression suite.
 *
 *   §1 F1 — SETTLED pause: the paused card and the C1 "paused = card only"
 *      chrome hiding are gated on `pausedSettled` (PlayerControls derives:
 *      !playing continuously for 400 ms, no sheet open, not switching — the
 *      shell's existing loading-card flag passed as `switching`), NEVER on
 *      raw `!playing`, so the transient pause a quality/audio/server engine
 *      reload fires can never flash the card or strip the chrome. Pressing
 *      play clears it immediately.
 *
 *   §2 F2 — PORTRAIT TOP-ROW FIT: PiP moved out of the utility zone into
 *      the bottom row's RIGHT group — utility keeps exactly Subtitles,
 *      Quality, Server, Cast, Lock; the right group order is Volume(left
 *      group), Audio, Display-mode, Speed, PiP, Fullscreen — PiP immediately
 *      LEFT of Fullscreen, one line at 360 px.
 *
 *   §3 F3 — BACK-CHIP ALIGNMENT: the back chip and the utility chips share
 *      the shell root's --pl-chrome-top / --pl-chip-size geometry tokens
 *      (same top offset, same height) in portrait AND landscape (the old
 *      standalone .back-fab.native top overrides are gone; the viewport
 *      overrides live on the ROOT token block).
 *
 *   §4 F4 — AUTO "UP NEXT": while PLAYING a series episode with a next
 *      episode and duration − currentTime ≤ 180 s, the up-next card (16:9
 *      still, UP NEXT label, title, S<n> · E<m>, Play pill → the existing
 *      episode-change path) shows on its own at the bottom-right as an
 *      absolute overlay (never shifts the timeline); seeking back above the
 *      threshold hides it; a sheet open or the lock hides it; movies never
 *      have a next episode so they never see it; while paused the card keeps
 *      showing exactly as before (the paused zone's instance of the SAME
 *      component).
 *
 *   §5 F5 — TAP TO TOGGLE: a single tap on the video surface toggles
 *      play/pause — fired by the tap controller ONLY after the (260 ms)
 *      double-tap window elapses without a second tap, so a double-tap seeks
 *      without toggling; buttons/chips/sheets/the card never toggle; locked
 *      taps stay inert (the enabled() gate); press-and-hold never toggles.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { createPlayerTapGestureController, DOUBLE_TAP_WINDOW_MS } from '$lib/client/player/touch/gestures';

const root = resolve(fileURLToPath(import.meta.url), '../..');
const read = (p: string) => readFileSync(resolve(root, p), 'utf-8');

const shell = read('src/lib/components/player/PlayerShell.svelte');
const controls = read('src/lib/components/player/PlayerControls.svelte');
const card = read('src/lib/components/player/PlayerUpNextCard.svelte');
const gestures = read('src/lib/client/player/touch/gestures.ts');

let passed = 0;
let failed = 0;
function ok(condition: unknown, label: string) {
  if (condition) { passed += 1; console.log(`  ok ${passed} - ${label}`); }
  else { failed += 1; console.log(`  FAIL - ${label}`); }
}
const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

// ===========================================================================
// §1 — F1: the SETTLED-pause derivation (no card flash on engine reloads).
// ===========================================================================
console.log('\n§1 — F1: settled pause (no card flash on switches)');
{
  ok(/const PAUSE_SETTLE_MS = 400;/.test(controls), '1a. the settle window is 400 ms (a transient engine-reload pause can never cross it)');
  ok(/if \(!playing && openSheet === null && !switching\) \{/.test(controls) && /if \(!playing && openSheet === null && !switching\) pausedSettled = true;/.test(controls), '1b. settled requires: not playing AND no sheet open AND not switching (checked when arming and again at fire time)');
  ok(/export let switching = false;/.test(controls), '1c. PlayerControls takes the optional switching prop (default false)');
  ok(/onDestroy\(\(\) => \{[\s\S]*?pausedSettleTimer[\s\S]*?\}\);/.test(controls), '1d. the settle timer is cleared in onDestroy');
  ok(/switching=\{switchingSource\}/.test(shell), '1e. the shell passes its EXISTING switching flag to PlayerControls');
  ok(/\$: switchingSource = effectiveState === 'preparing' \|\| effectiveState === 'resolving' \|\| effectiveState === 'switching-source' \|\| effectiveState === 'embed-loading';/.test(shell), '1f. switchingSource IS the loading-card condition (preparing | resolving | switching-source | embed-loading) — no second state machine');
  // The paused zone + the C1 card-only chrome hiding are gated on the settled
  // flag — never raw !playing.
  ok(/\{#if pausedSettled && !locked && safeDuration > 0/.test(controls), '1g. the paused zone renders only on a SETTLED pause (never raw !playing)');
  const beforeSheets = controls.slice(0, controls.indexOf('<!-- In-player selection sheets'));
  ok(beforeSheets.includes('{#if !pausedSettled && (title || metaLine)}') && (beforeSheets.match(/\{#if !pausedSettled\}\s*\n\s*<div class="(utility-zone|bottom-zone)">/g) ?? []).length === 2, '1h. the header zone, utility zone and bottom zone are ALL gated on !pausedSettled (the C1 card-only chrome hiding — the chrome stays during a quality switch, hides only after a settled pause)');
  ok(!/\{#if playing && \(title \|\| metaLine\)\}/.test(controls) && !/\{#if playing\}\s*\n\s*<div class="(utility|bottom)-zone">/.test(controls), '1i. no zone remains gated on raw `playing` (pressing play clears pausedSettled IMMEDIATELY — the chrome returns with no delay)');
}

// ===========================================================================
// §2 — F2: portrait top-row fit — PiP moved to the bottom row's right group.
// ===========================================================================
console.log('\n§2 — F2: portrait rows (utility zone fits, PiP left of Fullscreen)');
{
  const utilityStart = controls.indexOf('class="utility-zone"');
  const utilityEnd = controls.indexOf('class="bottom-zone"', utilityStart);
  const utility = controls.slice(utilityStart, utilityEnd);
  ok(!utility.includes('Picture-in-Picture') && !utility.includes('Display mode'), '2a. the utility zone no longer carries PiP or Display-mode');
  ok(utility.includes('aria-label={`Subtitles:') && utility.includes('select-control quality') && utility.includes('select-control server') && utility.includes('Cast to a device') && utility.includes('Lock player controls'), '2b. the utility zone keeps exactly: Subtitles, Quality, Server, Cast, Lock');
  const rightStart = controls.indexOf('class="right-controls"');
  const rightEnd = controls.indexOf('</div>', controls.indexOf("'Enter fullscreen'", rightStart)) + 6;
  const right = controls.slice(rightStart, rightEnd);
  const order = ['aria-label={`Audio track:', 'aria-label={`Display mode:', 'aria-label={`Playback speed', 'Enter Picture-in-Picture', "'Enter fullscreen'"];
  let cursor = 0;
  let orderOk = true;
  for (const marker of order) {
    const at = right.indexOf(marker, cursor);
    if (at < 0) { orderOk = false; break; }
    cursor = at;
  }
  ok(orderOk, '2c. the bottom-right group order: Audio, Display-mode, Speed, PiP, Fullscreen (PiP immediately LEFT of Fullscreen)');
  ok(/volume-control/.test(controls.slice(controls.indexOf('class="left-controls"'), controls.indexOf('class="right-controls"'))), '2d. the bottom-left group keeps Play, ±10 s, Volume');
  ok(/{#if !castActive && pictureInPictureSupported\}\s*<button class="control-button"[^>]*aria-label=\{pictureInPicture \? 'Exit Picture-in-Picture' : 'Enter Picture-in-Picture'\}/.test(controls), '2e. the PiP button keeps its capability + cast gate (moved, semantics unchanged)');
  ok(/\.utility-zone \{[\s\S]*?max-width: calc\(100vw - 24px\); \}/.test(controls) && /@media \(max-width: 640px\) \{[\s\S]*?\.utility-zone \{ gap: 4px; left: max\(56px, env\(safe-area-inset-left\)\); max-width: calc\(100vw - 68px\); \}/.test(controls), '2f. the utility zone keeps its nowrap + bounded-width contract at ≤640 px (the row fits 360 px with no clipping)');
  ok(/\.secondary-row \{ display: flex; align-items: center; flex-wrap: nowrap; justify-content: space-between; gap: 8px; \}/.test(controls), '2g. the bottom row stays ONE nowrap space-between row');
}

// ===========================================================================
// §3 — F3: back-chip alignment through the shared --pl-* geometry tokens.
// ===========================================================================
console.log('\n§3 — F3: back chip optically centred with the utility chips');
{
  ok(/\.player-shell \{[\s\S]*?--pl-chrome-top: max\(16px, env\(safe-area-inset-top\)\); --pl-chip-size: 40px;/.test(shell), '3a. the shell root owns the shared --pl-chrome-top + --pl-chip-size geometry tokens alongside the surface tokens');
  ok(/\.back-fab\.native \{ top: var\(--pl-chrome-top, max\(16px, env\(safe-area-inset-top\)\)\); left: max\(16px, env\(safe-area-inset-left\)\); width: var\(--pl-chip-size, 40px\); height: var\(--pl-chip-size, 40px\);/.test(shell), '3b. the back chip derives its TOP offset and SIZE from the shared tokens (same values the utility chips consume)');
  ok(/top: var\(--pl-chrome-top, max\(16px, env\(safe-area-inset-top\)\)\)/.test(controls), '3c. the utility zone derives the SAME top offset from --pl-chrome-top (inherited from the shell root)');
  ok(/\.select-control \{ display: inline-flex; align-items: center; gap: 8px; height: var\(--pl-chip-size, 40px\);/.test(controls), '3d. the utility chips derive their height from --pl-chip-size');
  ok(/\.utility-zone \.control-button \{ width: var\(--pl-chip-size, 40px\); min-width: var\(--pl-chip-size, 40px\); height: var\(--pl-chip-size, 40px\);/.test(controls), '3e. the utility icon squares derive their size from --pl-chip-size too');
  ok(/@media \(min-width: 900px\) \{\s*\.player-shell \{ --pl-chip-size: 44px; \}\s*\}/.test(shell), '3f. the ≥900px growth is ONE token override on the ROOT — the back chip AND the utility chips grow to 44px together');
  ok(/@media \(max-width: 640px\) \{[\s\S]*?\.player-shell \{ --pl-chrome-top: max\(12px, env\(safe-area-inset-top\)\); --pl-chip-size: 36px; \}/.test(shell), '3g. compact portrait: BOTH rows compact together (12px top floor + 36px chips, one token pair — alignment holds at 360px)');
  ok(/@media \(orientation: landscape\) and \(max-height: 500px\) \{\s*\.player-shell \{ --pl-chrome-top: max\(6px, env\(safe-area-inset-top\)\); \}/.test(shell), '3h. the landscape-phone block drops the SHARED top offset to the 6px corner floor for BOTH rows at once (the reported "back chip sits higher than the chips row" misalignment)');
  ok(!/\.back-fab\.native \{[^}]*top: max\(/.test(shell), '3i. NO standalone top offset remains on .back-fab.native (the old misaligned per-viewport magic numbers are gone)');
  ok(!/@media \(min-width: 900px\) \{[\s\S]{0,120}\.select-control \{ height: 44px; \}/.test(controls) && !/\.utility-zone \.control-button \{[^}]*44px/.test(controls), '3j. the old per-component 44px overrides are GONE from PlayerControls (the root token owns the growth)');
}

// ===========================================================================
// §4 — F4: the auto up-next card near the end of an episode.
// ===========================================================================
console.log('\n§4 — F4: auto up-next near the end');
{
  ok(/const UP_NEXT_REMAINING_S = 180;/.test(controls), '4a. the auto threshold is 180 s of remaining playback');
  ok(/\$: upNextAutoOpen = playing && upNext !== null && openSheet === null && !locked && safeDuration > 0 && safeDuration - currentTime <= UP_NEXT_REMAINING_S;/.test(controls), '4b. the auto card opens only while PLAYING (seeking back above the threshold hides it), with a next episode, no open sheet, not locked');
  ok(/\{#if upNextAutoOpen && upNext\}\s*\n\s*<PlayerUpNextCard \{upNext\} onUpNext=\{onUpNext\} variant="auto" \/>/.test(controls), '4c. the auto instance renders OUTSIDE the !pausedSettled zones (it shows WITH the normal chrome while playing)');
  ok(/\{#if upNext\}\s*\n\s*<PlayerUpNextCard \{upNext\} onUpNext=\{onUpNext\} \/>/.test(controls.slice(controls.indexOf('class="paused-zone"'), controls.indexOf('class="bottom-zone"'))), '4d. the paused zone keeps showing the SAME card component while paused (the existing paused behaviour stays)');
  ok(/class="upnext-card" class:auto=\{variant === 'auto'\}/.test(card), '4e. ONE card component serves both contexts (no duplicated markup that can drift)');
  ok(/\.upnext-still \{ aspect-ratio: 16 \/ 9;/.test(card) && /loading="lazy"/.test(card), '4f. the card carries the 16:9 fixed-aspect lazy still (no CLS)');
  ok(/UP NEXT<\/span>/.test(card) && /S\{upNext\.season\} · E\{String\(upNext\.episode\)\.padStart\(2, '0'\)\}/.test(card), '4g. the card carries the UP NEXT label, the episode title and the S<n> · E<m> meta');
  ok(/aria-label=\{`Play \$\{upNext\.title \|\| `episode \$\{upNext\.episode\}`\}`\}/.test(card), '4h. the Play pill keeps its aria-label');
  const autoRule = card.slice(card.indexOf('.upnext-card.auto {'), card.indexOf('}', card.indexOf('.upnext-card.auto {')));
  ok(autoRule.includes('bottom: calc(100px + env(safe-area-inset-bottom))') && !/position: (static|relative|fixed)/.test(autoRule), '4i. the auto card is an absolute bottom-right overlay ABOVE the bottom bar — it never shifts the timeline');
  ok(/@keyframes paused-card-in/.test(card), '4j. the card fades in on its own');
  ok(/\.upnext-card:not\(\.auto\) \{ position: static; \}/.test(card), '4k. portrait keeps the paused-zone column stack for the zone variant only (the auto card stays anchored)');
  ok(/source\?\.type === 'direct' && \(content\.type === 'series' \|\| content\.type === 'anime'\)/.test(shell), '4l. movies never produce a next-episode payload (movies NEVER see the card)');
  ok(/\.upnext-card`/.test(gestures), '4m. taps on the card are excluded from the tap controller (never toggle playback)');
}

// ===========================================================================
// §5 — F5: single tap toggles play/pause (behavioral, REAL controllers).
// ===========================================================================
console.log('\n§5 — F5: tap to toggle (behavioral)');
{
  ok(DOUBLE_TAP_WINDOW_MS === 260, '5a. the double-tap window is 260 ms (also the single-tap confirmation delay — one value so a double-tap can never race the toggle)');
  ok(!/Single taps have NO action/.test(gestures), '5b. the gestures module comment no longer says "Single taps have NO action"');
  ok(/onSingleTap\?: \(\) => void;/.test(gestures), '5c. the tap controller takes an OPTIONAL onSingleTap callback');
  ok(/onSingleTap: handleSingleTap,/.test(shell), '5d. the shell wires the tap controller to handleSingleTap');
  ok(/function handleSingleTap\(\) \{[\s\S]*?void togglePlay\(\);[\s\S]*?\}/.test(shell), '5e. a confirmed single tap toggles play/pause (guarded to ready direct sources)');
  ok(/enabled: \(\) => !touchLocked && source\?\.type === 'direct' && !sourceMenuOpen && !episodeMenuOpen && !controlsSheetsOpen && sourceReady && !castConnected,/.test(shell), '5f. locked / sheet / cast / embed states keep taps inert (the existing gate — the unlock FAB stays the only affordance)');

  type FakeTouch = { identifier: number; clientX: number; clientY: number };
  type FakeEvent = { changedTouches: FakeTouch[]; target: unknown };
  function fakeSurface() {
    const listeners = new Map<string, (event: FakeEvent) => void>();
    return {
      addEventListener(type: string, handler: (event: FakeEvent) => void) { listeners.set(type, handler); },
      removeEventListener(type: string) { listeners.delete(type); },
      clientWidth: 1000,
      fire(type: string, event: FakeEvent) { listeners.get(type)?.(event); },
    };
  }
  const touch = (id: number, x: number, y: number) => ({ identifier: id, clientX: x, clientY: y });

  {
    // A single tap toggles — but ONLY after the double-tap window elapses.
    const surface = fakeSurface();
    const events: string[] = [];
    const controller = createPlayerTapGestureController({
      surface: surface as unknown as HTMLElement,
      enabled: () => true,
      onDoubleTap: () => events.push('double'),
      onSingleTap: () => events.push('single'),
      onHoldStart: () => events.push('hold:start'),
      onHoldEnd: () => events.push('hold:end'),
      now: () => 1000,
    });
    surface.fire('touchstart', { changedTouches: [touch(1, 200, 300)], target: {} });
    surface.fire('touchend', { changedTouches: [touch(1, 200, 300)], target: {} });
    await sleep(120);
    ok(events.length === 0, '5g. inside the window the toggle is still pending (a second tap may still claim a double-tap)');
    await sleep(320);
    ok(events.length === 1 && events[0] === 'single', '5h. after the window elapses the toggle fires exactly once');
    controller.destroy();
  }
  {
    // A double-tap seeks and NEVER toggles.
    const surface = fakeSurface();
    const events: string[] = [];
    const controller = createPlayerTapGestureController({
      surface: surface as unknown as HTMLElement,
      enabled: () => true,
      onDoubleTap: () => events.push('double'),
      onSingleTap: () => events.push('single'),
      onHoldStart: () => {},
      onHoldEnd: () => {},
      now: () => 1000,
    });
    surface.fire('touchstart', { changedTouches: [touch(1, 200, 300)], target: {} });
    surface.fire('touchend', { changedTouches: [touch(1, 200, 300)], target: {} });
    surface.fire('touchstart', { changedTouches: [touch(2, 210, 300)], target: {} });
    surface.fire('touchend', { changedTouches: [touch(2, 210, 300)], target: {} });
    await sleep(320);
    ok(events.length === 1 && events[0] === 'double', '5i. a double-tap fires the seek and cancels the pending toggle (no spurious pause)');
    controller.destroy();
  }
  {
    // A hold (2× speed) never toggles playback.
    const surface = fakeSurface();
    const events: string[] = [];
    const controller = createPlayerTapGestureController({
      surface: surface as unknown as HTMLElement,
      enabled: () => true,
      onDoubleTap: () => events.push('double'),
      onSingleTap: () => events.push('single'),
      onHoldStart: () => events.push('hold:start'),
      onHoldEnd: () => events.push('hold:end'),
      now: () => 1000,
    });
    surface.fire('touchstart', { changedTouches: [touch(1, 700, 300)], target: {} });
    await sleep(560);
    surface.fire('touchend', { changedTouches: [touch(1, 700, 300)], target: {} });
    await sleep(320);
    ok(events.includes('hold:start') && events.includes('hold:end') && !events.includes('single'), '5j. press-and-hold runs the 2× speed contract and never toggles playback');
    controller.destroy();
  }
  {
    // Locked (enabled() false): taps stay inert.
    const surface = fakeSurface();
    const events: string[] = [];
    const controller = createPlayerTapGestureController({
      surface: surface as unknown as HTMLElement,
      enabled: () => false,
      onDoubleTap: () => events.push('double'),
      onSingleTap: () => events.push('single'),
      onHoldStart: () => {},
      onHoldEnd: () => {},
      now: () => 1000,
    });
    surface.fire('touchstart', { changedTouches: [touch(1, 200, 300)], target: {} });
    surface.fire('touchend', { changedTouches: [touch(1, 200, 300)], target: {} });
    await sleep(320);
    ok(events.length === 0, '5k. while the enabled() gate is false (touch lock, sheets, cast, embed) a tap NEVER toggles playback');
    controller.destroy();
  }
  {
    // A swipe that follows a tap cancels the pending toggle (the swipe owns
    // the touch; firing the toggle mid-gesture would fight the volume drag).
    const surface = fakeSurface();
    const events: string[] = [];
    const controller = createPlayerTapGestureController({
      surface: surface as unknown as HTMLElement,
      enabled: () => true,
      onDoubleTap: () => events.push('double'),
      onSingleTap: () => events.push('single'),
      onHoldStart: () => {},
      onHoldEnd: () => {},
      now: () => 1000,
    });
    surface.fire('touchstart', { changedTouches: [touch(1, 200, 300)], target: {} });
    surface.fire('touchend', { changedTouches: [touch(1, 200, 300)], target: {} });
    surface.fire('touchstart', { changedTouches: [touch(2, 800, 300)], target: {} });
    surface.fire('touchmove', { changedTouches: [touch(2, 800, 360)], target: {} });
    surface.fire('touchend', { changedTouches: [touch(2, 800, 360)], target: {} });
    await sleep(320);
    ok(!events.includes('single') && !events.includes('double'), '5l. a later touch (the swipe) cancels the pending single-tap toggle — gestures and taps never both fire');
    controller.destroy();
  }
}

console.log(`\nRound 52 player fixes: ${passed} passed, ${failed} failed (of ${passed + failed})`);
if (failed > 0) process.exit(1);
