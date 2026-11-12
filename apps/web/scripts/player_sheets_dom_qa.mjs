// Focused player fixes (2026-10) — RENDERED-DOM QA for Issues 1–4.
//
// Runs the REAL components (project Vite+Svelte build) in headless Chromium:
//   * CONTROLS HARNESS (real PlayerControls + real PlayerSubtitleOverlay):
//       - Issue 3: every selection surface opens a Mavero sheet (no native
//         <select> popups); opening/selecting/dismissing (selection, Escape,
//         outside tap); focus restore; narrow-viewport fit + independent
//         scrolling for MANY tracks; the menu-open flag plumbs to the shell.
//       - Issues 1+2: the Subtitle Settings sheet — offset steppers with the
//         exact display contract ("-2.0s"/"0.0s"/"+2.0s"), reset-to-zero,
//         size stepper, position slider, colour swatches, border styles,
//         reset-all; every change dispatches onPrefs immediately.
//       - Issue 1 overlay: REAL rAF render loop against track/video doubles —
//         cue windows, delay/advance offset semantics, markup stripping,
//         suppression, cleanup.
//   * SHELL HARNESS (real PlayerShell): the loading indicator is TOP-CENTER
//     and never intersects the central Play/Pause cluster (Issue 4), leaves
//     on the ready (loadedmetadata) and error transitions, and never renders
//     together with the buffering corner note.
import { resolvePlaywright } from './mav_resolve_playwright.mjs';
import { execSync } from 'node:child_process';
import { resolve, dirname, normalize, join, sep } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const { chromium } = await resolvePlaywright();

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const controlsDist = '/tmp/mavero-controls-qa-dist';
const shellDist = '/tmp/mavero-shell-qa-dist';

execSync(`./node_modules/.bin/vite build --config scripts/player_v2_dom_qa.vite.config.mjs`, { cwd: root, stdio: 'pipe' });
execSync(`./node_modules/.bin/vite build --config scripts/player_shell_qa.vite.config.mjs`, { cwd: root, stdio: 'pipe' });

let passed = 0, failed = 0;
const check = (name, condition, detail = '') => {
  if (condition) { passed += 1; console.log(`  ok ${passed} - ${name}${detail ? ` — ${detail}` : ''}`); }
  else { failed += 1; console.log(`  FAIL - ${name}${detail ? ` — ${detail}` : ''}`); }
};

const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const { createServer } = await import('node:http');
const staticServer = (distDir, port, indexFile) => createServer((req, res) => {
  const rawPath = (req.url ?? '/').split('?')[0];
  const requestedFile = rawPath === '/' ? `/${indexFile}` : rawPath;
  // Normalize + verify the resolved path is within distDir (path-traversal guard).
  const fullPath = normalize(join(distDir, decodeURIComponent(requestedFile).slice(1)));
  if (!fullPath.startsWith(distDir + sep)) {
    res.writeHead(403); res.end('Forbidden');
    return;
  }
  try {
    const body = readFileSync(fullPath);
    res.writeHead(200, { 'content-type': fullPath.endsWith('.html') ? 'text/html' : fullPath.endsWith('.css') ? 'text/css' : 'text/javascript' });
    res.end(body);
  } catch {
    res.writeHead(404); res.end('nope');
  }
});
const controlsServer = staticServer(controlsDist, 0, 'index.html');
const shellServer = staticServer(shellDist, 0, 'shell.html');
await new Promise((done) => controlsServer.listen(0, '127.0.0.1', done));
await new Promise((done) => shellServer.listen(0, '127.0.0.1', done));
const CONTROLS = `http://127.0.0.1:${controlsServer.address().port}`;
const SHELL = `http://127.0.0.1:${shellServer.address().port}`;

const raf = (page, frames = 3) => page.evaluate((n) => new Promise((done) => {
  let left = n;
  const tick = () => (left-- <= 0 ? done() : requestAnimationFrame(tick));
  requestAnimationFrame(tick);
}), frames);

// Provisional track fixture for sheet tests.
const TRACKS = [
  { url: '/api/content/subtitles/vtt/movie/24428/English', label: 'English' },
  { url: '/api/content/subtitles/vtt/movie/24428/English2', label: 'English2' },
  { url: '/api/content/subtitles/vtt/movie/24428/Portuguese (BR)2', label: 'Portuguese (BR)2' },
];

try {
  // =========================================================================
  // §A — Issue 3: Mavero selection sheets (open / select / dismiss / flag).
  // =========================================================================
  console.log('\n§A — selection sheets (Issue 3)');
  {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.goto(`${CONTROLS}/index.html`, { waitUntil: 'networkidle' });
    await page.evaluate((tracks) => {
      window.__flags = { menu: [], subtitles: [], prefs: [] };
      window.mountControls({
        subtitles: tracks,
        subtitleNotice: '',
        onMenuOpenChange: (open) => window.__flags.menu.push(open),
        onSubtitle: (url) => window.__flags.subtitles.push(url),
        onSubtitlePreferences: (prefs) => window.__flags.prefs.push(prefs),
      });
    }, TRACKS);
    await page.waitForTimeout(120);

    // No native <select> popups anywhere on the control surface.
    const selects = await page.evaluate(() => document.querySelectorAll('.controls select').length);
    check('A1. ZERO native <select> popups remain on the player control surface', selects === 0, `count: ${selects}`);

    // Subtitle sheet: open → dialog renders with Off + the REAL tracks.
    await page.click('.select-control.subtitles');
    await page.waitForTimeout(120);
    let sheet = await page.evaluate(() => {
      const el = document.querySelector('.player-option-sheet');
      return { present: Boolean(el), role: el?.getAttribute('role'), modal: el?.getAttribute('aria-modal'), rows: [...(el?.querySelectorAll('.track-row') ?? [])].map((r) => r.textContent.trim()) };
    });
    check('A2. the subtitle control opens the Mavero sheet (role=dialog, aria-modal)', sheet.present && sheet.role === 'dialog' && sheet.modal === 'true', JSON.stringify(sheet.role));
    check('A3. the sheet lists Off + every REAL track (no fabricated options)', sheet.rows.length === TRACKS.length + 1 && sheet.rows[0].startsWith('Off') && sheet.rows.some((r) => r.includes('Portuguese (BR)2')), JSON.stringify(sheet.rows));

    // Selecting a track dispatches the SAME onSubtitle contract and closes.
    await page.click('.track-row:nth-child(2)');
    await page.waitForTimeout(120);
    const picked = await page.evaluate(() => ({
      fired: window.__flags.subtitles,
      closed: !document.querySelector('.player-option-sheet'),
      flags: window.__flags.menu,
      label: document.querySelector('.select-control.subtitles .control-label')?.textContent?.trim(),
    }));
    check('A4. selecting a track fires onSubtitle(track.url) and dismisses the sheet', picked.fired[0] === TRACKS[0].url && picked.closed, JSON.stringify(picked.fired));
    check('A5. the open flag reached the shell contract (true on open, false on close)', picked.flags[0] === true && picked.flags[1] === false, JSON.stringify(picked.flags));
    check('A6. the trigger label mirrors the selection', picked.label === 'English', picked.label);

    // Escape dismissal + focus restore to the trigger.
    await page.click('.select-control.subtitles');
    await page.waitForTimeout(120);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(120);
    const escapeState = await page.evaluate(() => ({
      closed: !document.querySelector('.player-option-sheet'),
      focus: document.activeElement?.className ?? '',
    }));
    check('A7. Escape dismisses the sheet and focus RESTORES to the trigger', escapeState.closed && /subtitles/.test(escapeState.focus), escapeState.focus.slice(0, 60));

    // Outside tap (overlay) dismissal.
    await page.click('.select-control.speed');
    await page.waitForTimeout(120);
    await page.mouse.click(20, 200);
    await page.waitForTimeout(120);
    check('A8. outside tap dismisses the sheet', await page.evaluate(() => !document.querySelector('.player-option-sheet')));

    // Quality / display / speed sheets pick real values through the old contracts.
    await page.click('.select-control.quality');
    await page.waitForTimeout(120);
    const qualityRows = await page.evaluate(() => [...document.querySelectorAll('.player-option-sheet .option-row strong')].map((el) => el.textContent.trim()));
    check('A9. the quality sheet lists Auto + the REAL manifest levels', qualityRows[0] === 'Auto' && qualityRows.includes('1080p') && qualityRows.includes('720p') && qualityRows.includes('480p'), JSON.stringify(qualityRows));
    await page.getByText('720p', { exact: true }).click();
    await page.waitForTimeout(120);
    const qualityPicked = await page.evaluate(() => ({ label: document.querySelector('.select-control.quality .control-label')?.textContent?.trim(), closed: !document.querySelector('.player-option-sheet') }));
    check('A10. picking 720p closes the sheet and mirrors the selection', qualityPicked.label === '720p' && qualityPicked.closed, JSON.stringify(qualityPicked));

    await page.click('.select-control.display-mode');
    await page.waitForTimeout(120);
    await page.getByText('Fill', { exact: true }).click();
    await page.waitForTimeout(120);
    check('A11. display mode selection flows through onDisplayMode', (await page.evaluate(() => document.querySelector('.select-control.display-mode .control-label')?.textContent?.trim())) === 'Fill');

    await page.click('.select-control.speed');
    await page.waitForTimeout(120);
    await page.getByText('1.5×', { exact: true }).click();
    await page.waitForTimeout(120);
    check('A12. speed selection flows through onPlaybackRate', (await page.evaluate(() => document.querySelector('.select-control.speed .control-label')?.textContent?.trim())) === '1.5×');
    await page.close();
  }

  // =========================================================================
  // §B — Issue 3: narrow viewport + many tracks (fit, scroll, safe areas).
  // =========================================================================
  console.log('\n§B — narrow viewport / many tracks');
  {
    const page = await browser.newPage({ viewport: { width: 360, height: 780 } });
    await page.goto(`${CONTROLS}/index.html`, { waitUntil: 'networkidle' });
    const manyTracks = Array.from({ length: 30 }, (_, i) => ({ url: `/t/${i}`, label: `Subtitle track number ${i + 1} with a fairly long descriptive label` }));
    await page.evaluate((tracks) => window.mountControls({ subtitles: tracks }), manyTracks);
    await page.waitForTimeout(120);
    await page.click('.select-control.subtitles');
    await page.waitForTimeout(150);
    const fit = await page.evaluate(() => {
      const sheet = document.querySelector('.player-option-sheet');
      const body = document.querySelector('.player-option-sheet .sheet-body');
      const rect = sheet.getBoundingClientRect();
      const style = getComputedStyle(body);
      return {
        left: rect.left, right: rect.right, width: rect.width,
        height: rect.height, viewportH: innerHeight, viewportW: innerWidth,
        scrollable: body.scrollHeight >= body.clientHeight && (style.overflowY === 'auto' || style.overflowY === 'scroll'),
        safePad: parseFloat(getComputedStyle(sheet).paddingBottom) >= 0,
        rowCount: document.querySelectorAll('.track-row').length,
      };
    });
    check('B1. the sheet fits the 360px viewport horizontally (no clipping)', fit.left >= 0 && fit.right <= fit.viewportW, `left ${Math.round(fit.left)} right ${Math.round(fit.right)}`);
    check('B2. the sheet respects the viewport height (≤62dvh)', fit.height <= fit.viewportH * 0.63, `height ${Math.round(fit.height)} of ${fit.viewportH}`);
    check('B3. all 30 REAL tracks render and the body scrolls independently', fit.rowCount === 31 && fit.scrollable, `rows ${fit.rowCount}`);
    check('B4. the sheet carries safe-area padding for the Android nav bar', fit.safePad);
    await page.close();
  }

  // =========================================================================
  // §C — Issues 1+2: Subtitle Settings controls.
  // =========================================================================
  console.log('\n§C — subtitle settings (offset / size / position / colour / border / reset)');
  {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.goto(`${CONTROLS}/index.html`, { waitUntil: 'networkidle' });
    await page.evaluate(() => {
      window.__prefs = [];
      window.mountControls({ subtitles: [{ url: '/t/en', label: 'English' }], onSubtitlePreferences: (prefs) => window.__prefs.push(prefs) });
    });
    await page.waitForTimeout(120);
    await page.click('.select-control.subtitles');
    await page.waitForTimeout(150);

    // MAV-FOCUSED Issue 2 (2026-10): the subtitle sheet now opens on the
    // Languages tab by default. Switch to the Settings tab before
    // exercising the offset / size / colour / border controls.
    const settingsTab = page.getByRole('tab', { name: /Settings/ });
    await settingsTab.click();
    await page.waitForTimeout(120);

    const offsetText = () => page.evaluate(() => document.querySelector('.step-value')?.textContent?.trim());
    check('C1. the offset displays the default exactly as "0.0s"', (await offsetText()) === '0.0s', await offsetText());
    await page.click('button[aria-label="Delay subtitles 0.5 seconds later"]');
    await page.click('button[aria-label="Delay subtitles 0.5 seconds later"]');
    check('C2. +0.5s steps display as "+1.0s" (positive = delayed)', (await offsetText()) === '+1.0s');
    const prefAfterPlus = await page.evaluate(() => window.__prefs[window.__prefs.length - 1]?.offsetSeconds);
    check('C3. every step dispatches onSubtitlePreferences immediately (live preview)', prefAfterPlus === 1, `offsetSeconds: ${prefAfterPlus}`);
    await page.click('button[aria-label="Show subtitles 0.5 seconds earlier"]');
    await page.click('button[aria-label="Show subtitles 0.5 seconds earlier"]');
    await page.click('button[aria-label="Show subtitles 0.5 seconds earlier"]');
    check('C4. negative steps display as "-0.5s" (negative = earlier)', (await offsetText()) === '-0.5s');
    await page.click('button[aria-label="Reset subtitle offset to zero"]');
    check('C5. the obvious reset-to-zero restores "0.0s"', (await offsetText()) === '0.0s');
    check('C6. the offset convention is spelled out in the UI', (await page.evaluate(() => document.body.textContent)).includes('Positive delays subtitles'));

    await page.click('button[aria-label="Increase subtitle text size"]');
    check('C7. the size stepper moves to 110%', (await page.evaluate(() => document.getElementById('mav-sub-size-value')?.textContent?.trim())) === '110%');
    const sliders = await page.evaluate(() => {
      const slider = document.querySelector('.pos-slider');
      return { present: Boolean(slider), min: slider?.min, max: slider?.max, bottom: document.body.textContent.includes('Bottom'), top: document.body.textContent.includes('Top') };
    });
    check('C8. the vertical position slider carries bottom→top semantics', sliders.present && sliders.min === '0' && sliders.max === '100' && sliders.bottom && sliders.top, JSON.stringify(sliders));
    const swatches = await page.evaluate(() => [...document.querySelectorAll('.swatch')].map((s) => ({ pressed: s.getAttribute('aria-pressed') === 'true' })));
    check('C9. five colour presets render with the selected state', swatches.length === 5 && swatches.filter((s) => s.pressed).length === 1, `count ${swatches.length}`);
    await page.click('button[aria-label="Subtitle colour Yellow"]');
    await page.getByRole('button', { name: 'Box', exact: true }).click();
    const stylePicked = await page.evaluate(() => window.__prefs[window.__prefs.length - 1]);
    check('C10. colour + border style selections flow through onPrefs', stylePicked?.color === 'yellow' && stylePicked?.borderStyle === 'box', JSON.stringify(stylePicked));
    await page.click('.reset-all');
    const afterReset = await page.evaluate(() => window.__prefs[window.__prefs.length - 1]);
    check('C11. Reset restores the DEFAULT appearance AND offset', afterReset?.offsetSeconds === 0 && afterReset?.sizeScale === 1 && afterReset?.color === 'white' && afterReset?.borderStyle === 'outline', JSON.stringify(afterReset));
    await page.close();
  }

  // =========================================================================
  // §D — Issue 1: the custom overlay render path (REAL rAF loop).
  // =========================================================================
  console.log('\n§D — subtitle overlay rendering (offset semantics, markup, cleanup)');
  {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.goto(`${CONTROLS}/index.html`, { waitUntil: 'networkidle' });
    const cues = [
      { startTime: 0, endTime: 4, text: 'First cue' },
      { startTime: 5, endTime: 9, text: '<i>Second</i> <v Narrator>cue</v>' },
      { startTime: 10, endTime: 14, text: 'line one\nline two' },
    ];
    await page.evaluate((track) => window.mountSubtitleOverlay({ track, video: { currentTime: 0 } }), { cues });
    await raf(page, 4);
    check('D1. the cue covering t=0 renders', (await page.evaluate(() => document.querySelector('.subtitle-text')?.textContent)) === 'First cue');

    // Positive offset DELAYS: t=0 with +2 s → the [0,4) cue shows at t≥2.
    await page.evaluate((track) => window.mountSubtitleOverlay({ track, video: { currentTime: 0 }, offsetSeconds: 2 }), { cues });
    await raf(page, 4);
    check('D2. a POSITIVE offset delays display (cue hidden before its shifted start)', (await page.evaluate(() => document.querySelector('.subtitle-text')?.textContent ?? '')) === '');
    await page.evaluate((track) => window.mountSubtitleOverlay({ track, video: { currentTime: 2 }, offsetSeconds: 2 }), { cues });
    await raf(page, 4);
    check('D3. with +2 s the [0,4) cue shows exactly at t=2 (delayed, not shifted content)', (await page.evaluate(() => document.querySelector('.subtitle-text')?.textContent)) === 'First cue');

    // Negative offset SHOWS EARLIER: t=3.5 with −1 s → the [5,9) cue… still
    // ahead; instead t=0 with −1 s pulls the [0,4) window to start at −1 —
    // visible, and t=3.9 would keep it. Use the [5,9) cue at t=4.5.
    await page.evaluate((track) => window.mountSubtitleOverlay({ track, video: { currentTime: 4.5 }, offsetSeconds: -1 }), { cues });
    await raf(page, 4);
    check('D4. a NEGATIVE offset shows the cue EARLIER ([5,9) visible at t=4.5)', (await page.evaluate(() => document.querySelector('.subtitle-text')?.textContent)) === 'Second cue');

    // Markup stripping + entities.
    await page.evaluate((track) => window.mountSubtitleOverlay({ track, video: { currentTime: 5 } }), { cues });
    await raf(page, 4);
    check('D5. cue markup is stripped (<i>, <v Name>) — plain text only', (await page.evaluate(() => document.querySelector('.subtitle-text')?.textContent)) === 'Second cue');
    await page.evaluate((track) => window.mountSubtitleOverlay({ track, video: { currentTime: 10 } }), { cues });
    await raf(page, 4);
    const multiline = await page.evaluate(() => ({ text: document.querySelector('.subtitle-text')?.textContent, style: getComputedStyle(document.querySelector('.subtitle-text')).whiteSpace }));
    check('D6. multi-line cues render with pre-line semantics', multiline.text === 'line one\nline two' && multiline.style === 'pre-line', JSON.stringify(multiline));

    // Cleanup: Off (null track) and suppression unmount the overlay.
    await page.evaluate(() => window.mountSubtitleOverlay({ track: null, video: { currentTime: 5 } }));
    await raf(page, 3);
    check('D7. Off (no track) renders nothing', (await page.evaluate(() => document.querySelector('.subtitle-overlay'))) === null);
    await page.evaluate((track) => window.mountSubtitleOverlay({ track, video: { currentTime: 10 }, suppressed: true }), { cues });
    await raf(page, 3);
    check('D8. OS suppression (PiP/native video fullscreen) hides the overlay (the OS paints)', (await page.evaluate(() => document.querySelector('.subtitle-overlay'))) === null);
    const overlayStyle = await page.evaluate((track) => {
      window.mountSubtitleOverlay({ track, video: { currentTime: 10 } }, );
      return new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => {
        const el = document.querySelector('.subtitle-overlay');
        done(el ? { pointerEvents: getComputedStyle(el).pointerEvents, ariaHidden: el.getAttribute('aria-hidden') } : null);
      })));
    }, { cues });
    check('D9. the overlay is pointer-transparent + aria-hidden (gestures keep working)', overlayStyle?.pointerEvents === 'none' && overlayStyle?.ariaHidden === 'true', JSON.stringify(overlayStyle));
    await page.close();
  }

  // =========================================================================
  // §E — Issue 4: loading indicator geometry + transitions (REAL shell).
  // =========================================================================
  console.log('\n§E — loading indicator vs central Play/Pause (real shell)');
  {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    // Hang the media request so the prepare session stays observable.
    await page.route('**/zcdn.bluevelvet.space/**', () => { /* hang: keeps the stream preparing */ });
    await page.goto(`${SHELL}/shell.html`, { waitUntil: 'networkidle' });
    await page.evaluate(() => window.mountShell({}));
    await page.waitForTimeout(400);
    const geo = await page.evaluate(() => {
      const card = document.querySelector('.loading-card');
      const cluster = document.querySelector('.center-cluster');
      const cardRect = card?.getBoundingClientRect();
      const clusterRect = cluster?.getBoundingClientRect();
      const vw = innerWidth;
      return {
        cardPresent: Boolean(card), clusterPresent: Boolean(cluster),
        cardTop: cardRect ? Math.round(cardRect.top) : null,
        cardBottom: cardRect ? Math.round(cardRect.bottom) : null,
        cardCenterX: cardRect ? Math.round(cardRect.left + cardRect.width / 2) : null,
        clusterTop: clusterRect ? Math.round(clusterRect.top) : null,
        clusterCenterX: clusterRect ? Math.round(clusterRect.left + clusterRect.width / 2) : null,
        overlap: cardRect && clusterRect ? !(cardRect.bottom <= clusterRect.top || cardRect.top >= clusterRect.bottom || cardRect.right <= clusterRect.left || cardRect.left >= clusterRect.right) : null,
        vw, bufferingNote: Boolean(document.querySelector('.state-label')),
        copy: card?.textContent ?? '',
      };
    });
    check('E1. the loading indicator renders while the source prepares', geo.cardPresent && geo.clusterPresent, `card=${geo.cardPresent} cluster=${geo.clusterPresent}`);
    // MAV-FOCUSED Issue 3 (2026-10): the loading card is now CENTERED in
    // the playback viewport (top: 50%; left: 50%; translate(-50%, -50%)) —
    // NOT at an arbitrary top offset. The previous top-center placement
    // was the screenshot's "Loading player… near the top of the screen".
    check('E2. it is CENTERED in the playback viewport (top: ~50%, centerX: ~50%)', geo.cardTop !== null && Math.abs(geo.cardTop - geo.clusterTop) <= 80 && Math.abs(geo.cardCenterX - geo.vw / 2) <= 8, `top ${geo.cardTop} (cluster top ${geo.clusterTop}), centerX ${geo.cardCenterX} of ${geo.vw}`);
    // The loading card z-index (7) stays BELOW the actionable controls
    // (back-fab z-index 12, unlock-fab z-index 12, the controls overlay
    // z-index 10) — the loading card never covers the back button or the
    // lock/subtitle/quality controls.
    const layering = await page.evaluate(() => {
      const card = document.querySelector('.loading-card');
      const backFab = document.querySelector('.back-fab');
      if (!card || !backFab) return null;
      const cardZ = Number(getComputedStyle(card).zIndex || 0);
      const backFabZ = Number(getComputedStyle(backFab).zIndex || 0);
      return { cardZ, backFabZ, backFabOnTop: backFabZ > cardZ };
    });
    check('E3. the loading card z-index stays BELOW the back-fab (back button stays interactive on top)', layering !== null && layering.backFabOnTop, `card z=${layering?.cardZ} back-fab z=${layering?.backFabZ}`);
    check('E4. active buffering is a DIFFERENT surface (no two loading indicators)', geo.bufferingNote === false && /Loading player|Starting your stream|Switching source/.test(geo.copy), `buffering note: ${geo.bufferingNote}`);

    // Ready transition: loadedmetadata flips the shell to paused → card leaves.
    await page.evaluate(() => {
      const video = document.querySelector('video');
      Object.defineProperty(video, 'duration', { value: 5340, configurable: true });
      video.dispatchEvent(new Event('loadedmetadata'));
    });
    await page.waitForTimeout(200);
    check('E5. the indicator LEAVES on the ready transition (loadedmetadata → paused)', await page.evaluate(() => !document.querySelector('.loading-card')));

    // Error transition: the media error card replaces loading (retry available).
    await page.evaluate(() => document.querySelector('video')?.dispatchEvent(new Event('error')));
    await page.waitForTimeout(200);
    const errorState = await page.evaluate(() => ({ card: Boolean(document.querySelector('.loading-card')), message: Boolean(document.querySelector('.message-card')), retry: Boolean(document.querySelector('.message-card .small-button')) }));
    check('E6. the error transition replaces the loading indicator (retry reachable)', errorState.card === false && errorState.message && errorState.retry, JSON.stringify(errorState));
    await page.close();
  }
} finally {
  await browser.close();
  controlsServer.close();
  shellServer.close();
}
console.log(`player_sheets_dom_qa: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
