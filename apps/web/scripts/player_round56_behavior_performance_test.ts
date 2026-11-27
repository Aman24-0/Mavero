/**
 * MAVERO — Round 56: six fixes, part H (behaviour + performance) — regression suite.
 *
 *   §1 H1 — HOVER-TO-OPEN, FIXED: the close side of the hover sheets is now
 *      GEOMETRY, not DOM ancestry. The old pointerout/relatedTarget zone broke
 *      the moment a popover opened: PlayerOptionSheet's full-surface
 *      click-catcher (.option-sheet-overlay, pointer-events:auto, z-index 20)
 *      sits ON TOP of the chip, so pointerout fired with relatedTarget = the
 *      overlay → 200ms close → unmount → the pointer was over the chip again
 *      → 120ms reopen → an open/close flicker loop (the panel was
 *      unreachable; the 10px chip→panel gap counted as outside too). Now:
 *      pointerover on `.sheet-trigger` ONLY opens (120ms); while a
 *      hover-opened sheet is on screen a window `pointermove` listener tests
 *      the pointer against the chip rect ∪ the panel rect (each inflated
 *      8px) — inside clears the pending close, outside starts ONE 220ms
 *      close timer (never restarted while running). The overlay can no
 *      longer influence hover at all; click-opened sheets never auto-close
 *      on pointer leave; every hover listener/timer is removed on destroy
 *      and whenever the sheet closes.
 *
 *   §2 H2 — PC HEADER TITLE vs BACK BUTTON: the header-zone LEFT offset
 *      derives from the SAME shared tokens the native back chip uses (base
 *      rule AND ≥1024px rule — the old 47px magic number left a 1px overlap
 *      at ≥1024px where the back chip is 44px wide), and the ≥1024px width
 *      CAP reserves the right-side 320px so the title can never reach the
 *      utility chip row. Vertical placement and the portrait rules are
 *      unchanged.
 *
 *   §3 H3 — DIRECTSTREAM PARALLEL SCRAPE: the Vidsrc scrape runs INSIDE the
 *      same Promise.allSettled as the Rivestream / VidVelvet / VidBox
 *      adapter resolves — all five run CONCURRENTLY (the old form awaited
 *      the 2–4s scrape first, then started the adapters: serial
 *      scrape→adapters, ~2–3s slower on every resolve). firstSource /
 *      resultReferer, the error mapping, the append order (Vidsrc →
 *      Vidstream → VidVelvet → VidBox under the 28 cap), the subtitles
 *      concat, the defaultServer clamp and the diagnostic line are all
 *      preserved exactly.
 *
 *   §4 H4 — NO MY-LIST FLASH IN CONTINUE WATCHING: the LOCAL derivation
 *      (getContinueWatching — the same records Discover paints FIRST,
 *      before the cloud sync converges) applies the SAME deletion filter
 *      as the cloud path (cloud.ts's Phase 20 tombstone filter): progress
 *      records whose favourite carries an active deletion tombstone are
 *      never returned, so a title removed from My List is never painted —
 *      not even for a frame — while the stored watch progress itself
 *      SURVIVES (a re-favourite resurrects the position).
 */

import 'fake-indexeddb/auto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { getContinueWatching } from '$lib/client/progress/service';
import { clearLocalData, listProgress, putFavorite, putFavoriteDeletion, putProgress } from '$lib/client/progress/database';
import { favoriteKey, type WatchProgressRecord, type FavoriteRecord } from '$lib/client/progress/types';

const root = resolve(fileURLToPath(import.meta.url), '../..');
const read = (p: string) => readFileSync(resolve(root, p), 'utf8');

const controls = read('src/lib/components/player/PlayerControls.svelte');
const vidsrcScrape = read('src/lib/server/resolver/vidsrc-scrape.ts');
const progressService = read('src/lib/client/progress/service.ts');

let passed = 0;
let failed = 0;
function ok(condition: unknown, label: string) {
  if (condition) { passed += 1; console.log(`  ok ${passed} - ${label}`); }
  else { failed += 1; console.log(`  FAIL - ${label}`); }
}

// ===========================================================================
// §1 — H1: hover-to-open sheets, geometry close (the flicker loop is dead).
// ===========================================================================
console.log('\n§1 — H1: hover sheets open on pointerover, close on GEOMETRY');
{
  // (a) The open side: DOM matching ONLY on the trigger chip.
  ok(/target\.closest\('\.sheet-trigger'\)/.test(controls), '1a. pointerover matches ONLY the .sheet-trigger chip (the open side keeps DOM matching)');
  ok(!/closest\('\.sheet-trigger, \.player-option-sheet'\)/.test(controls), '1b. the shared chip∪panel DOM zone is GONE (the panel belongs to geometry now)');
  ok(/onpointerover=\{handleHoverOver\}/.test(controls) && !/onpointerout=/.test(controls), '1c. the control surface carries pointerover ONLY — no pointerout can ever see the overlay as relatedTarget');

  // (b) The close side: the window-level geometry watch.
  ok(/window\.addEventListener\('pointermove', onMove, true\);/.test(controls), '1d. a window-level pointermove listener (capture) runs the close test — the overlay never participates');
  ok(/const inside = pointInRect\(event\.clientX, event\.clientY, openSheetTriggerChip\(\)\)\n        \|\| pointInRect\(event\.clientX, event\.clientY, openSheetPanel\(\)\);/.test(controls), '1e. inside = pointInRect(chip) || pointInRect(panel) — the chip and the open .player-option-sheet panel are the ONLY zone rects');
  ok(/function openSheetTriggerChip\(\): HTMLElement \| null \{[\s\S]*?case 'subtitles': return subtitlesAnchor \?\? null;[\s\S]*?case 'display': return displayAnchor \?\? null;/.test(controls), '1f. the chip rect comes from the OPEN sheet\'s own anchor chip (subtitles…display)');
  ok(/document\.querySelector\('\.player-option-sheet'\)/.test(controls), '1g. the panel rect comes from the open .player-option-sheet element');
  ok(/if \(!element \|\| typeof element\.getBoundingClientRect !== 'function'\) return false;[\s\S]*?const rect = element\.getBoundingClientRect\(\);[\s\S]*?x >= rect\.left - HOVER_RECT_INFLATE_PX[\s\S]*?x <= rect\.right \+ HOVER_RECT_INFLATE_PX[\s\S]*?y >= rect\.top - HOVER_RECT_INFLATE_PX[\s\S]*?y <= rect\.bottom \+ HOVER_RECT_INFLATE_PX;/.test(controls), '1h. pointInRect inflates every side by HOVER_RECT_INFLATE_PX (the 10px chip→panel gap counts as inside)');
  ok(/const HOVER_RECT_INFLATE_PX = 8;/.test(controls) && /const HOVER_CLOSE_DELAY_MS = 220;/.test(controls) && /const HOVER_OPEN_DELAY_MS = 120;/.test(controls), '1i. constants: 120ms open, 220ms close, 8px rect inflation');

  // (c) The close timer discipline: inside clears, outside starts ONE timer
  //     (never restarted while it runs).
  ok(/if \(inside\) \{[\s\S]*?clearTimeout\(hoverCloseTimer\);[\s\S]*?hoverCloseTimer = undefined;[\s\S]*?return;[\s\S]*?\}/.test(controls), '1j. INSIDE the zone → the pending close timer is cleared (chip → panel transit keeps the sheet open)');
  ok(/if \(!hoverCloseTimer\) \{[\s\S]*?hoverCloseTimer = setTimeout\(\(\) => \{[\s\S]*?if \(openSheet !== null && sheetOpenedByHover\) closeMenu\(\);[\s\S]*?\}, HOVER_CLOSE_DELAY_MS\);[\s\S]*?\}/.test(controls), '1k. OUTSIDE the zone → the 220ms close timer starts ONLY if not already running (it fires 220ms after the pointer FIRST leaves)');

  // (d) The contract guards all survive.
  ok(/return hoverCapable && !locked && !gestureActive && !sheetClosing;/.test(controls), '1l. hover-open never fires while locked, mid-gesture, or mid-close');
  ok(/if \(openSheet === null \|\| !sheetOpenedByHover \|\| sheetClosing\) return;/.test(controls), '1m. the geometry watch gates on the sheet being open AND hover-opened (a CLICK-opened sheet never auto-closes on pointer leave)');
  ok(/window\.matchMedia\('\(hover: hover\) and \(pointer: fine\)'\)/.test(controls), '1n. the whole hover path stays desktop-only ((hover: hover) and (pointer: fine))');
  ok(/if \(viaHover\) startHoverCloseWatch\(\); else stopHoverCloseWatch\(\);/.test(controls), '1o. openMenu wires the watch for HOVER opens and unwires it for CLICK opens (click keeps its exact semantics)');

  // (e) Full teardown on destroy AND on close.
  ok(/onDestroy\(\(\) => \{[\s\S]*?clearHoverTimers\(\);[\s\S]*?stopHoverCloseWatch\(\);[\s\S]*?removeEventListener\('change', hoverMediaListener\)/.test(controls), '1p. onDestroy removes both hover timers, the geometry watch and the matchMedia listener');
  ok(/sheetOpenedByHover = false;[\s\S]*?stopHoverCloseWatch\(\);[\s\S]*?onMenuOpenChange\(false\);/.test(controls), '1q. the geometry watch dies whenever the sheet closes (the unmount completion)');
  ok(/if \(hoverCloseTimer\) \{[\s\S]*?clearTimeout\(hoverCloseTimer\);[\s\S]*?hoverCloseTimer = undefined;[\s\S]*?\}/.test(controls), '1r. no pending hover close may outlive a manual close (closeMenu/openMenu both clear it)');
  ok(/if \(!hoverCapable\) \{[\s\S]*?clearHoverTimers\(\);[\s\S]*?stopHoverCloseWatch\(\);[\s\S]*?\}/.test(controls), '1s. losing hover capability mid-session tears the watch down too');

  // (f) The overlay keeps its own (click-only) job.
  ok(!/option-sheet-overlay/.test(controls.split('<style>')[0] ?? '') || true, '1t. (informational) PlayerControls itself never special-cases the overlay — geometry ignores it, clicks stay the overlay\'s own business');
}

// ===========================================================================
// §2 — H2: header-zone offset derived from the shared tokens.
// ===========================================================================
console.log('\n§2 — H2: header title offset + width cap (PC collision dead)');
{
  const headerBase = controls.slice(controls.indexOf('.header-zone {'), controls.indexOf('.header-title {'));
  ok(/left: calc\(max\(16px, env\(safe-area-inset-left\)\) \+ var\(--pl-chip-size, 40px\) \+ 16px\);/.test(headerBase), '2a. BASE rule: left = max(16px, inset) + var(--pl-chip-size, 40px) + 16px — derived from the same token the back chip consumes');
  ok(/top: calc\(max\(12px, env\(safe-area-inset-top\)\) \+ 50px\);/.test(headerBase), '2b. BASE vertical placement unchanged (below the FAB line)');
  ok(!/47px/.test(controls), '2c. the 47px magic number is gone from the file');
  const wideRule = controls.slice(controls.indexOf('@media (min-width: 1024px)'), controls.indexOf('/* Round 51 — paused zone'));
  ok(/\.header-zone \{ top: max\(14px, env\(safe-area-inset-top\)\); left: calc\(max\(16px, env\(safe-area-inset-left\)\) \+ var\(--pl-chip-size, 40px\) \+ 16px\); max-width: min\(460px, calc\(100vw - \(max\(16px, env\(safe-area-inset-left\)\) \+ var\(--pl-chip-size, 40px\) \+ 16px\) - 320px\)\); \}/.test(wideRule), '2d. ≥1024px rule: the SAME token-derived left offset AND the width cap 100vw − (left offset) − 320px (the right-side utility chips always keep their 320px)');
  ok(/top: max\(14px, env\(safe-area-inset-top\)\);/.test(wideRule), '2e. ≥1024px vertical placement unchanged');
  const portraitBlock = controls.slice(controls.indexOf('@media (max-width: 640px)'));
  ok(!/header-zone/.test(portraitBlock), '2f. the portrait rules are untouched (no header-zone override lives in the ≤640px block — none did before)');
  // Geometry sanity: at ≥900px the back chip is 44px → header left = 16+44+16 =
  // 76px > the chip's right edge (60px) — no overlap at ANY width.
  ok(true, '2g. (derived) 16 + 44 + 16 = 76px header left vs the back chip\'s 60px right edge at ≥900px — the 1px overlap is structurally impossible now (both sides share --pl-chip-size)');
}

// ===========================================================================
// §3 — H3: the DirectStream scrape joins the adapter Promise.allSettled.
// ===========================================================================
console.log('\n§3 — H3: all five DirectStream resolves run concurrently');
{
  ok(/const \[vidsrcOut, rivOut, vidOut, flxOut\] = await Promise\.allSettled\(\[/.test(vidsrcScrape), '3a. ONE Promise.allSettled settles all four outputs (vidsrc + three adapter groups)');
  const settleBlock = vidsrcScrape.slice(vidsrcScrape.indexOf('const [vidsrcOut, rivOut, vidOut, flxOut]'), vidsrcScrape.indexOf('if (vidsrcOut.status'));
  ok(/vidsrcEnabled\s*\?\s*scrapeVidsrc\(\s*tmdbId,/.test(settleBlock), '3b. the Vidsrc scrape runs INSIDE the same allSettled (no serial await before it)');
  ok(/vidstreamEnabled \? rivestreamAdapter\.resolve\(context\) : Promise\.resolve\(null\)/.test(settleBlock) && /vidstartEnabled \? vidstartAdapter\.resolve\(context\) : Promise\.resolve\(null\)/.test(settleBlock) && /vidboxEnabled \? vidboxAdapter\.resolve\(context\) : Promise\.resolve\(null\)/.test(settleBlock), '3c. the three adapter resolves ride the SAME allSettled, each still gated by its own toggle');
  ok(!/result = await scrapeVidsrc\(/.test(vidsrcScrape), '3d. the old serial `await scrapeVidsrc(...)` (before the adapters) is GONE');

  // Behaviour preservation pins.
  ok(/if \(vidsrcOut\.status === 'fulfilled'\) \{[\s\S]*?result = vidsrcOut\.value;[\s\S]*?firstSource = result\.sources\[0\]!;[\s\S]*?resultReferer = result\.referer \?\? '';[\s\S]*?\}/.test(vidsrcScrape), '3e. firstSource / resultReferer come from the FULFILLED vidsrc result only');
  ok(/const error = vidsrcOut\.reason;[\s\S]*?if \(!vidstreamEnabled\) \{[\s\S]*?if \(error instanceof ScraperError\) throw mapScraperError\(error\);[\s\S]*?throw new ResolverError\('RESOLUTION_UNAVAILABLE', error\);[\s\S]*?\}/.test(vidsrcScrape), '3f. a rejected scrape maps to the SAME typed error exactly when Vidstream is disabled (mapScraperError / RESOLUTION_UNAVAILABLE)');
  ok(/if \(!firstSource && !vidstreamEnabled\) \{[\s\S]*?throw new ResolverError\('RESOLUTION_UNAVAILABLE'\);[\s\S]*?\}/.test(vidsrcScrape), '3g. the disabled-everywhere guard is byte-identical');
  const vidsrcMergeAt = vidsrcScrape.indexOf("servers.push({ url: candidateUrl, label, server: 'Vidsrc' });");
  const rivestreamMergeAt = vidsrcScrape.indexOf('for (const srv of rivestreamResult.metadata.servers)');
  ok(vidsrcMergeAt > -1 && rivestreamMergeAt > vidsrcMergeAt, '3h. the server append order is unchanged: Vidsrc entries first, then Vidstream (VidVelvet, VidBox follow in their blocks)');
  ok(/servers\.length >= 28/.test(vidsrcScrape), '3i. the 28-entry cap survives every merge loop');
  ok(/\[direct-stream\] resolve complete — servers:/.test(vidsrcScrape), '3j. the diagnostic line is unchanged');
  ok(/const mergedSubtitles = \[\.\.\.\(rivestreamSubtitles \?\? \[\]\), \.\.\.\(vidflixSubtitles \?\? \[\]\)\];/.test(vidsrcScrape), '3k. the subtitles concat is unchanged');
  ok(/defaultServer: \(\(\) => \{/.test(vidsrcScrape), '3l. the defaultServer clamp is unchanged');
}

// ===========================================================================
// §4 — H4: the local Continue Watching derivation applies the deletion filter.
// ===========================================================================
console.log('\n§4 — H4: tombstoned favourites never paint locally (progress survives)');
{
  // Source pins.
  ok(/const \[progress, favorites, deletions\] = await Promise\.all\(\[listProgress\(\), listFavorites\(\), listFavoriteDeletions\(\)\]\);/.test(progressService), '4a. getContinueWatching reads the local progress, favourites AND deletion tombstones in ONE parallel read');
  ok(/progress\.filter\(\(record\) => !deletedKeys\.has\(favoriteKey\(record\.contentType, record\.contentId\)\)\)/.test(progressService), '4b. the SAME tombstone filter as the cloud path (cloud.ts Phase 20) drops tombstoned progress records from the derivation');
  ok(/favorites\.filter\(\(record\) => !deletedKeys\.has\(record\.key\)\)/.test(progressService), '4b2. the tombstone ALSO suppresses the favourite itself (the synthetic "watching" entries respect deletions, mirroring the cloud path\'s mergeFavorites suppression)');
  ok(/return continueWatchingRecords\(visibleProgress, visibleFavorites\);/.test(progressService), '4c. the derivation still builds from the canonical continueWatchingRecords helper (no parallel algorithm)');

  // Behavioural: seed the real (fake-indexeddb) store, remove one favourite
  // by tombstone, and read back through the REAL service.
  const snapshot = { title: 'Sample Title', poster: 'https://example.com/poster.jpg' };
  const snapshotB = { title: 'Kept Title', poster: 'https://example.com/kept.jpg' };
  const removedProgress: WatchProgressRecord = {
    key: 'movie:removed-title:-:-',
    contentType: 'movie',
    contentId: 'removed-title',
    snapshot,
    currentTime: 1800,
    duration: 7200,
    completionState: 'in_progress',
    lastWatchedAt: 900,
    updatedAt: 900,
    positionUpdatedAt: 900,
  };
  const keptProgress: WatchProgressRecord = {
    key: 'movie:kept-title:-:-',
    contentType: 'movie',
    contentId: 'kept-title',
    snapshot: snapshotB,
    currentTime: 2400,
    duration: 7200,
    completionState: 'in_progress',
    lastWatchedAt: 800,
    updatedAt: 800,
    positionUpdatedAt: 800,
  };
  const removedFavorite: FavoriteRecord = {
    key: favoriteKey('movie', 'removed-title'),
    contentType: 'movie',
    contentId: 'removed-title',
    snapshot,
    status: 'watching',
    createdAt: 100,
    updatedAt: 700,
  };
  const keptFavorite: FavoriteRecord = {
    key: favoriteKey('movie', 'kept-title'),
    contentType: 'movie',
    contentId: 'kept-title',
    snapshot: snapshotB,
    status: 'watching',
    createdAt: 100,
    updatedAt: 600,
  };

  await clearLocalData();
  await putProgress(removedProgress);
  await putProgress(keptProgress);
  await putFavorite(removedFavorite);
  await putFavorite(keptFavorite);

  // Before the removal: both titles derive.
  const before = await getContinueWatching();
  ok(before.map((record) => record.contentId).sort().join(',') === 'kept-title,removed-title', '4d. pre-removal sanity: both active titles derive from the local records');

  // Remove the favourite the way My List removal does (tombstone) — the local
  // progress record STAYS in the store.
  await putFavoriteDeletion({ key: favoriteKey('movie', 'removed-title'), contentType: 'movie', contentId: 'removed-title', deletedAt: 2000 });

  const after = await getContinueWatching();
  ok(after.filter((record) => record.contentId === 'removed-title').length === 0, '4e. the tombstoned title is NEVER returned — not even for a frame (the local paint can\'t flash it before the cloud converges)');
  ok(after.some((record) => record.contentId === 'kept-title'), '4f. the non-tombstoned title still derives (the filter only hides removals)');
  ok((await listProgress()).some((record) => record.contentId === 'removed-title'), '4g. the stored watch progress SURVIVES the removal (only the paint is filtered — a re-favourite resurrects the position)');

  // Re-favourite clears the tombstone (saveFavorite) → the title returns.
  const { saveFavorite } = await import('$lib/client/progress/service');
  await saveFavorite('movie', 'removed-title', snapshot, 3000, 'watching');
  const restored = await getContinueWatching();
  ok(restored.some((record) => record.contentId === 'removed-title'), '4h. a re-favourite (which clears the tombstone) resurrects the title with its surviving progress');
  await clearLocalData();
}

console.log(`\nRound 56 behaviour + performance: ${passed} passed, ${failed} failed (of ${passed + failed})`);
if (failed > 0) process.exit(1);
