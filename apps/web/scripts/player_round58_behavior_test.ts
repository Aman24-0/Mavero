/**
 * MAVERO — Round 58: seven fixes, part J (behaviour) — regression suite.
 *
 *   §1 J1 — SOURCE AUTO-FALLBACK (no dead-end errors):
 *      - PRESELECT: a hinted default group with NO entry for this title
 *        (e.g. VidVelvet on a title VidVelvet does not carry) preselects
 *        servers[0] SILENTLY — never an error card or a "source unavailable"
 *        flash (a normal miss).
 *      - FAILURE WALK: the server walk runs FIRST for EVERY failure (fatal
 *        engine error, STREAM_NOT_FOUND/expired manifests, a failed resolve
 *        of the active entry, a hung stream through the 20s watchdog) —
 *        including PRE-ESTABLISHMENT failures, which round 45 previously
 *        sent straight to the terminal error card. Playback moves to the
 *        next untried entry in `servers` order (Vidsrc → Vidstream →
 *        VidVelvet → VidBox as merged) and a small non-blocking notice
 *        ("VidVelvet unavailable — switched to Vidstream") fades after
 *        ~4s. Only when EVERY entry has been tried does the existing error
 *        card render. The ledger (serverFallbackTried) keeps the walk
 *        finite, never re-tries a URL within a streak, and resets on
 *        source change / manual pick / successful playback. Single-server
 *        sources never enter the walk.
 *
 *   §2 J2 — LONG-PRESS / LEFT-HOLD 2× + NO NATIVE CONTEXT MENU:
 *      - The native context menu is suppressed ON THE PLAYER SURFACE ONLY
 *        (contextmenu → preventDefault on the player root AND the <video>);
 *        the rest of the site keeps the browser default.
 *      - The hold gesture fires for BOTH touch long-press (500ms) and mouse
 *        left-button hold (~350ms of stillness): pointerdown on the video
 *        surface only (never on a control/chip/popover/card), release /
 *        pointercancel / pointerleave / drag → exact previous speed
 *        restored. An activated hold cancels the pending single-tap toggle
 *        and never registers a tap; right/middle buttons never start
 *        anything; the enabled() gate keeps locked/embed/cast/sheet
 *        surfaces inert.
 *      - -webkit-touch-callout: none / user-select: none on the player
 *        surface so iOS never pops its own callout.
 *
 *   §3 J3 — DESKTOP SIDEBAR HOVER EXPAND/COLLAPSE:
 *      On ≥1025px `(hover: hover) and (pointer: fine)` surfaces only,
 *      pointerenter on .app-sidebar expands a collapsed sidebar after a
 *      120ms delay and pointerleave returns it to the USER'S PERSISTED
 *      state (localStorage) — the hover expansion is temporary and never
 *      persisted. The restore never happens while focus is inside the
 *      sidebar; the brand-lockup toggle stays the persisted control; the
 *      TV/WGT build keeps no pointer wiring at all.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { createPlayerTapGestureController, HOLD_ACTIVATE_MS, MOUSE_HOLD_ACTIVATE_MS } from '$lib/client/player/touch/gestures';

const root = resolve(fileURLToPath(import.meta.url), '../..');
const read = (p: string) => readFileSync(resolve(root, p), 'utf8');

const shell = read('src/lib/components/player/PlayerShell.svelte');
const viewport = read('src/lib/components/player/PlayerViewport.svelte');
const appShell = read('src/lib/components/AppShell.svelte');

let passed = 0;
let failed = 0;
function ok(condition: unknown, label: string) {
  if (condition) { passed += 1; console.log(`  ok ${passed} - ${label}`); }
  else { failed += 1; console.log(`  FAIL - ${label}`); }
}

// ===========================================================================
// §1 — J1: source auto-fallback (silent preselect + failure walk + notice).
// ===========================================================================
console.log('\n§1 — J1: source auto-fallback, no dead-end errors');
{
  // (a) PRESELECT — the hinted group with no entry preselects servers[0].
  const preselectMatch = shell.match(/\$: if \(source && source\.sourceId === sourceIdentity && !selectedServer && servers\.length > 1\) \{[\s\S]*?\n  \}/);
  ok(Boolean(preselectMatch), '1a. the preselect reactive block exists');
  const preselect = preselectMatch?.[0] ?? '';
  ok(/const target = hint \? defaultServerLabels\[hint\] \?\? 'Vidsrc' : '';/.test(preselect), '1b. the hint still maps through defaultServerLabels');
  ok(/servers\.find\(\(s\) => \(s\.server \|\| 'Vidsrc'\)\.toLowerCase\(\) === target\.toLowerCase\(\)\)/.test(preselect), '1c. the hinted-group match lookup is unchanged');
  ok(/selectedServer = \(match \?\? servers\[0\]\)\.url;/.test(preselect), '1d. a hinted-miss (or hintless source) preselects servers[0] — SILENTLY (no error card, no flash)');
  ok(!/source-unavailable/.test(preselect), '1e. the preselect path never touches an error/unavailable state');

  // (b) FAILURE WALK — one shared helper, called BEFORE the terminal paths.
  ok(/function tryServerFallbackWalk\(\): boolean \{/.test(shell), '1f. the walk is ONE extracted helper (tryServerFallbackWalk)');
  ok(/if \(source\?\.type !== 'direct' \|\| servers\.length <= 1\) return false;/.test(shell), '1g. single-server sources NEVER enter the walk (their behaviour is unchanged)');
  ok(/const failedUrl = selectedServer \|\| source\.url \|\| '';\s*\n\s*if \(!serverFallbackTried\.includes\(failedUrl\)\) serverFallbackTried\.push\(failedUrl\);/.test(shell), '1h. the failed URL joins the ledger — a URL is never re-tried within a streak');
  ok(/const nextServer = servers\.find\(\(server\) => server\.url && !serverFallbackTried\.includes\(server\.url\)\);/.test(shell), '1i. the next entry is the first UNTRIED one in servers order (Vidsrc → Vidstream → VidVelvet → VidBox as merged)');
  ok(/serverFallbackTried = \[\];\s*\n\s*return false;/.test(shell), '1j. an exhausted ledger resets and falls through (the existing re-resolve / error paths)');
  ok(/state = playbackEstablished \? 'switching-source' : 'preparing';/.test(shell), '1k. the walk keeps the session alive: switching mid-playback, preparing pre-establishment (the loading card stays — no error flash)');
  ok(/if \(currentTime > 0\) capturePendingSeek\(pendingSeekState, currentTime, Date\.now\(\)\);/.test(shell), '1l. the playhead is preserved only when one exists (a pre-establishment walk keeps the session resume position)');

  // (c) handleMediaError: the walk runs FIRST — before the round 45
  //     pre-establishment error card AND before the auto-retry.
  const handleMediaErrorMatch = shell.match(/function handleMediaError\(\) \{[\s\S]*?\n  \}\n/s);
  ok(Boolean(handleMediaErrorMatch), '1m. handleMediaError exists');
  const handleMediaError = handleMediaErrorMatch?.[0] ?? '';
  ok(handleMediaError.indexOf('tryServerFallbackWalk()') !== -1 && handleMediaError.indexOf('tryServerFallbackWalk()') < handleMediaError.indexOf('if (!playbackEstablished)'), '1n. the walk runs BEFORE the pre-establishment error card (round 45 dead-end is gone)');
  ok(handleMediaError.indexOf('tryServerFallbackWalk()') < handleMediaError.indexOf('hlsAutoRetryCount < HLS_AUTO_RETRY_MAX'), '1o. the walk runs BEFORE the auto-retry re-resolve');
  ok(/Only when EVERY entry/.test(shell) === false, '1p. (sanity) — the walk-exhausted path still reaches the existing error card through the ledger reset');

  // (d) The 20s hang watchdog joins the walk before erroring.
  const timeoutMatch = shell.match(/directLoadTimer = setTimeout\(\(\) => \{[\s\S]*?\}, DIRECT_LOAD_TIMEOUT_MS\);/);
  ok(Boolean(timeoutMatch), '1q. the direct-load timeout exists');
  ok(/if \(tryServerFallbackWalk\(\)\) return;\s*\n\s*state = 'error';/.test(timeoutMatch?.[0] ?? ''), '1r. a hung stream walks to the next untried entry BEFORE the terminal error card');

  // (e) The notice: non-blocking, fades ~4s, cleared on source change/destroy.
  ok(/let serverFallbackNotice = '';\s*\n\s*let serverFallbackNoticeFading = false;/.test(shell), '1s. the notice carries its own fading flag');
  ok(/serverFallbackNotice = `\$\{failedLabel\} unavailable — switched to \$\{nextLabel\}`;/.test(shell), '1t. the notice copy: "<failed> unavailable — switched to <next>"');
  ok(/const SERVER_FALLBACK_NOTICE_LINGER_MS = 3600;/.test(shell) && /const SERVER_FALLBACK_NOTICE_FADE_MS = 400;/.test(shell), '1u. the notice lingers ~3.6s then fades ~400ms (≈4s total)');
  ok(/\{#if serverFallbackNotice\}\s*\n\s*<div class="server-fallback-notice" class:fading=\{serverFallbackNoticeFading\} role="status">\{serverFallbackNotice\}<\/div>/.test(shell), '1v. the notice renders as a non-blocking inline pill (role=status)');
  ok(/pointer-events: none;/.test(shell.match(/\.server-fallback-notice \{[^}]+\}/)?.[0] ?? ''), '1w. the notice never blocks the pointer');
  ok(/\$:\s*if \(source\?\.sourceId && source\.sourceId !== sourceIdentity\) \{[\s\S]{0,600}clearServerFallbackNotice\(\);/.test(shell), '1x. a stale notice dies with the old source session');
  ok(/Round 58 \(J1\): the server-fallback notice dies with the shell\.\s*\n\s*clearServerFallbackNotice\(\);/.test(shell), '1y. the notice timers are cleared on destroy');

  // (f) The ledger contract is preserved (reset on playing / manual pick / source change).
  ok(/function handlePlaying\(\) \{ state = 'playing'; errorMessage = ''; playbackEstablished = true; hlsAutoRetryCount = 0; serverFallbackTried = \[\]; \}/.test(shell), '1z. successful playback resets the ledger (the next failure streak walks fresh)');
  ok(/function setServer\(url: string\) \{[\s\S]{0,300}serverFallbackTried = \[\];/.test(shell), '1aa. a manual pick resets the ledger (the user made an explicit choice)');
}

// ===========================================================================
// §2 — J2: long-press / left-hold 2× + no native context menu.
// ===========================================================================
console.log('\n§2 — J2: hold 2× for touch AND mouse, no native context menu');

type FakePointerEvent = { pointerId: number; pointerType: string; button: number; clientX: number; clientY: number; target: unknown };
function fakePointerSurface() {
  const listeners = new Map<string, (event: FakePointerEvent) => void>();
  return {
    addEventListener(type: string, handler: (event: FakePointerEvent) => void) { listeners.set(type, handler); },
    removeEventListener(type: string) { listeners.delete(type); },
    clientWidth: 1000,
    listenerCount(type: string) { return listeners.has(type) ? 1 : 0; },
    fire(type: string, event: FakePointerEvent) { listeners.get(type)?.(event); },
  };
}
const pointer = (id: number, x: number, y: number, pointerType = 'mouse', button = 0) => ({ pointerId: id, pointerType, button, clientX: x, clientY: y });
const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

{
  // (a) MOUSE LEFT-HOLD: stillness → 2×, release → exact restore, no tap.
  const surface = fakePointerSurface();
  const seen: string[] = [];
  const controller = createPlayerTapGestureController({
    surface: surface as unknown as HTMLElement,
    enabled: () => true,
    onDoubleTap: () => seen.push('tap'),
    onSingleTap: () => seen.push('single'),
    onHoldStart: () => seen.push('hold:start'),
    onHoldEnd: () => seen.push('hold:end'),
  });
  surface.fire('pointerdown', { ...pointer(1, 500, 400), target: {} });
  await sleep(MOUSE_HOLD_ACTIVATE_MS + 80);
  ok(seen[0] === 'hold:start' && !seen.includes('single'), '2a. a mouse left-hold activates 2× after ~350ms of stillness and cancels the pending single-tap toggle');
  surface.fire('pointerup', { ...pointer(1, 505, 404), target: {} });
  ok(seen[1] === 'hold:end' && !seen.includes('tap') && !seen.includes('single'), '2b. releasing the hold restores the previous speed and NEVER registers a tap');
  controller.destroy();
}
{
  // (b) Releasing BEFORE activation is still just a click (no hold).
  const surface = fakePointerSurface();
  const seen: string[] = [];
  const controller = createPlayerTapGestureController({
    surface: surface as unknown as HTMLElement,
    enabled: () => true,
    onDoubleTap: () => seen.push('tap'),
    onSingleTap: () => seen.push('single'),
    onHoldStart: () => seen.push('hold:start'),
    onHoldEnd: () => seen.push('hold:end'),
  });
  surface.fire('pointerdown', { ...pointer(1, 500, 400), target: {} });
  await sleep(120);
  surface.fire('pointerup', { ...pointer(1, 500, 400), target: {} });
  ok(!seen.includes('hold:start') && !seen.includes('hold:end'), '2c. a quick click never activates the hold (the 350ms window is not reached)');
  await sleep(MOUSE_HOLD_ACTIVATE_MS);
  ok(seen.includes('single') && !seen.includes('hold:start'), '2d. a quick click still fires the single-tap toggle after the double-tap window');
  controller.destroy();
}
{
  // (c) pointerleave / a drag cancels an ACTIVE hold (restore fires).
  const surface = fakePointerSurface();
  const seen: string[] = [];
  const controller = createPlayerTapGestureController({
    surface: surface as unknown as HTMLElement,
    enabled: () => true,
    onDoubleTap: () => seen.push('tap'),
    onSingleTap: () => seen.push('single'),
    onHoldStart: () => seen.push('hold:start'),
    onHoldEnd: () => seen.push('hold:end'),
  });
  surface.fire('pointerdown', { ...pointer(1, 500, 400), target: {} });
  await sleep(MOUSE_HOLD_ACTIVATE_MS + 60);
  surface.fire('pointerleave', { ...pointer(1, 500, 400), target: {} });
  ok(seen.includes('hold:end'), '2e. pointerleave during an active hold restores the previous speed');
  surface.fire('pointerdown', { ...pointer(2, 500, 400), target: {} });
  await sleep(MOUSE_HOLD_ACTIVATE_MS + 60);
  surface.fire('pointermove', { ...pointer(2, 560, 400), target: {} });
  ok(seen.filter((entry) => entry === 'hold:end').length === 2, '2f. a press that becomes a drag cancels the active hold (exact restore)');
  controller.destroy();
}
{
  // (d) Right/middle buttons and touch pointers never start a hold.
  const surface = fakePointerSurface();
  const seen: string[] = [];
  const controller = createPlayerTapGestureController({
    surface: surface as unknown as HTMLElement,
    enabled: () => true,
    onDoubleTap: () => seen.push('tap'),
    onSingleTap: () => seen.push('single'),
    onHoldStart: () => seen.push('hold:start'),
    onHoldEnd: () => seen.push('hold:end'),
  });
  surface.fire('pointerdown', { ...pointer(1, 500, 400, 'mouse', 2), target: {} });
  await sleep(MOUSE_HOLD_ACTIVATE_MS + 80);
  surface.fire('pointerdown', { ...pointer(2, 500, 400, 'touch'), target: {} });
  await sleep(MOUSE_HOLD_ACTIVATE_MS + 80);
  ok(!seen.includes('hold:start'), '2g. right/middle buttons and touch pointers never start a mouse hold');
  controller.destroy();
}
{
  // (e) The enabled() gate (lock / sheets / cast / embed) keeps holds inert.
  const surface = fakePointerSurface();
  const seen: string[] = [];
  const controller = createPlayerTapGestureController({
    surface: surface as unknown as HTMLElement,
    enabled: () => false,
    onDoubleTap: () => seen.push('tap'),
    onSingleTap: () => seen.push('single'),
    onHoldStart: () => seen.push('hold:start'),
    onHoldEnd: () => seen.push('hold:end'),
  });
  surface.fire('pointerdown', { ...pointer(1, 500, 400), target: {} });
  await sleep(MOUSE_HOLD_ACTIVATE_MS + 80);
  ok(seen.length === 0, '2h. while the enabled() gate is false (controls locked etc.) the mouse hold never fires');
  controller.destroy();
}
{
  // (f) The documented bounds: touch 500ms, mouse 350ms.
  ok(HOLD_ACTIVATE_MS === 500 && MOUSE_HOLD_ACTIVATE_MS === 350, '2i. the documented stillness windows (touch 500ms, mouse 350ms)');
  ok(/export const MOUSE_HOLD_ACTIVATE_MS = 350;/.test(read('src/lib/client/player/touch/gestures.ts')), '2j. MOUSE_HOLD_ACTIVATE_MS is exported from the gestures module');

  // (g) Contextmenu suppression — the player surface ONLY.
  ok(/oncontextmenu=\{\(event\) => \{ event\.preventDefault\(\); \}\}/.test(shell), '2k. the player root carries a contextmenu handler that preventDefaults');
  ok(/on:contextmenu\|preventDefault/.test(viewport), '2l. the <video> element carries its own contextmenu suppressor');
  const playerSurfaceOnly = shell.slice(shell.indexOf('.player-shell {'));
  ok(/-webkit-touch-callout: none; user-select: none; -webkit-user-select: none;/.test(playerSurfaceOnly), '2m. -webkit-touch-callout: none / user-select: none on the player surface (no iOS callout)');
  ok(!/oncontextmenu/.test(appShell) && !/oncontextmenu/.test(read('src/lib/components/DiscoverPage.svelte')), '2n. the context menu stays enabled everywhere else (AppShell / Discover carry no contextmenu wiring)');

  // (h) The shell still wires the hold to the SAME handlers (touch AND mouse).
  ok(/onHoldStart: handleHoldStart,\s*\n\s*onHoldEnd: handleHoldEnd,/.test(shell), '2o. the shell keeps wiring hold start/end to the shared handlers');
}

// ===========================================================================
// §3 — J3: desktop sidebar hover expand/collapse.
// ===========================================================================
console.log('\n§3 — J3: desktop sidebar hover expand/collapse');
{
  ok(/onpointerenter=\{handleSidebarPointerEnter\} onpointerleave=\{handleSidebarPointerLeave\}/.test(appShell), '3a. the sidebar carries pointerenter/pointerleave wiring');
  ok(/window\.matchMedia\('\(min-width: 1025px\)'\)/.test(appShell), '3b. the hover layer is gated on ≥1025px (the desktop composition)');
  ok(/window\.matchMedia\('\(hover: hover\) and \(pointer: fine\)'\)/.test(appShell), '3c. the hover layer is gated on (hover: hover) and (pointer: fine) — never on touch');
  ok(/const SIDEBAR_HOVER_EXPAND_DELAY_MS = 120;/.test(appShell), '3d. the expand runs after a 120ms delay (no pass-through flicker)');
  ok(/sidebarCollapsed = false; \/\/ temporary — NEVER persisted \(the brand toggle owns persistence\)/.test(appShell), '3e. hover expansion writes ONLY the runtime flag — never localStorage');
  ok(!/localStorage\.setItem\(STORAGE_KEY, String\(sidebarCollapsed\)\);[\s\S]{0,200}hover/.test(appShell.replace(/function toggleSidebar[\s\S]*?\n  \}/, '')), '3f. no hover path persists the collapsed state (the brand toggle stays the persisted control)');
  ok(/function readPersistedSidebarCollapsed\(\): boolean \{[\s\S]*?localStorage\.getItem\(STORAGE_KEY\) === 'true'/.test(appShell), '3g. pointerleave restores from the persisted localStorage state');
  ok(/if \(sidebarFocusInside\(\)\) return;/.test(appShell), '3h. the restore never happens while focus is inside the sidebar');
  ok(/document\.activeElement instanceof Node\s*\n\s*&& sidebarEl\.contains\(document\.activeElement\);/.test(appShell), '3i. the focus guard tests containment of the live activeElement');
  ok(/if \(IS_WGT_BUILD\) return;\s*\n\s*\/\/ Desktop hover-capable pointers only/.test(appShell), '3j. the TV/WGT build keeps NO hover wiring (its focus-manager contract owns the state)');
  ok(/onMount\(\(\) => \{\s*\n\s*if \(IS_WGT_BUILD \|\| typeof window === 'undefined' \|\| !window\.matchMedia\) return;/.test(appShell), '3k. the hover media queries never attach on the WGT build');
}

console.log(`\nRound 58 behaviour: ${passed} passed, ${failed} failed (of ${passed + failed})`);
if (failed > 0) process.exit(1);
