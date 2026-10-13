// Player V2 final remediation — RENDERED-DOM geometry QA.
//
// Builds the REAL PlayerControls.svelte through the project's own Vite +
// Svelte pipeline (the same compiler production uses) and mounts it in
// headless Chromium at the exact viewports from the real-device report,
// then MEASURES the rendered geometry:
//   * portrait 360/390/430 — the secondary controls fit ONE row (fullscreen
//     NOT wrapped onto its own row), the subtitle selector is compact (its
//     width serves the label, not a blank reservation), quality is present.
//   * landscape 844×390 — the row is ONE RIGHT-aligned group with fullscreen
//     inside it (remaining fixes 2026-10: the approved landscape alignment is
//     RIGHT; superseded the earlier left-aligned contract).
//   * single-level quality — the honest disabled control with the REAL label.
// This is the actual-DOM verification the audit demanded for Issue 1:
// flex-wrap behavior + native-select sizing cannot be proven from source.
import { resolvePlaywright } from './mav_resolve_playwright.mjs';
const { chromium } = await resolvePlaywright();
import { execSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = '/tmp/mavero-controls-qa-dist';

execSync(`./node_modules/.bin/vite build --config scripts/player_v2_dom_qa.vite.config.mjs`, { cwd: root, stdio: 'pipe' });

let passed = 0, failed = 0;
const check = (name, condition, detail = '') => {
  if (condition) { passed += 1; console.log(`  ok ${passed} - ${name}${detail ? ` — ${detail}` : ''}`); }
  else { failed += 1; console.log(`  FAIL - ${name}${detail ? ` — ${detail}` : ''}`); }
};

const browser = await chromium.launch();
// ES module scripts require http:// — file:// is blocked by Chromium.
const { createServer } = await import('node:http');
const server = createServer((req, res) => {
  const path = req.url === '/' ? '/index.html' : req.url.split('?')[0];
  const body = readFileSync(resolve(dist, path.slice(1)));
  res.writeHead(200, { 'content-type': path.endsWith('.html') ? 'text/html' : path.endsWith('.css') ? 'text/css' : 'text/javascript' });
  res.end(body);
});
await new Promise((done) => server.listen(4601, done));
const BASE = 'http://127.0.0.1:4601';
try {
  for (const viewport of [
    { name: 'portrait-360', width: 360, height: 780 },
    { name: 'portrait-390', width: 390, height: 844 },
    { name: 'portrait-430', width: 430, height: 932 },
    { name: 'landscape-844x390', width: 844, height: 390 },
  ]) {
    const page = await browser.newPage({ viewport: { width: viewport.width, height: viewport.height } });
    await page.goto(`${BASE}/index.html`, { waitUntil: 'networkidle' });
    await page.evaluate(() => window.mountControls({}));
    await page.waitForTimeout(150);
    const geo = await page.evaluate(() => {
      const row = document.querySelector('.secondary-row');
      if (!row) return { missing: true };
      const rowRect = row.getBoundingClientRect();
      const items = [...row.children].map((el) => { const r = el.getBoundingClientRect(); return { cls: el.className.split(' ')[0], left: r.left, right: r.right, top: r.top, height: r.height }; });
      const visible = items.filter((i) => i.height > 0);
      // Row grouping with a 4px tolerance (align-items center offsets can
      // differ by 1px between buttons and selects on the SAME line).
      const tops = visible.map((i) => i.top).sort((a, b) => a - b);
      let rowCount = 0;
      for (let index = 0; index < tops.length; index++) {
        if (index === 0 || tops[index] - tops[index - 1] > 4) rowCount += 1;
      }
      // Focused fixes (Issue 3) contract change: the subtitle control is a
      // BUTTON that opens Mavero's subtitle sheet (no native <select>). The
      // compactness contract now applies to the button itself.
      const subtitle = document.querySelector('.select-control.subtitles');
      const subRect = subtitle?.getBoundingClientRect();
      const quality = document.querySelector('.select-control.quality');
      const baseTop = visible[0].top;
      return {
        missing: false,
        rowCount,
        rowTop: Math.round(rowRect.top),
        subtitleWidth: subRect ? Math.round(subRect.width) : 0,
        qualityPresent: Boolean(quality),
        fullscreenOnFirstRow: Math.abs(visible[visible.length - 1].top - baseTop) <= 4,
        rowLeft: Math.round(Math.min(...visible.map((i) => i.left))),
        rowRight: Math.round(Math.max(...visible.map((i) => i.right))),
        viewportWidth: window.innerWidth,
      };
    });
    check(`${viewport.name}: the secondary row renders`, !geo.missing && geo.rowCount >= 1);
    const isLandscape = viewport.name.startsWith('landscape');
    if (!isLandscape) {
      check(`${viewport.name}: all secondary controls in ONE row (fullscreen NOT wrapped)`, geo.rowCount === 1, `distinct row tops: ${geo.rowCount}`);
      check(`${viewport.name}: fullscreen is on the SAME row as the group`, geo.fullscreenOnFirstRow);
      check(`${viewport.name}: subtitle control is compact (30..112px — no blank reservation, usable label)`, geo.subtitleWidth > 30 && geo.subtitleWidth <= 112, `control width: ${geo.subtitleWidth}px`);
      check(`${viewport.name}: quality control present in portrait`, geo.qualityPresent);
      check(`${viewport.name}: the row stays inside the viewport`, geo.rowLeft >= 0 && geo.rowRight <= geo.viewportWidth, `row ${geo.rowLeft}..${geo.rowRight} of ${geo.viewportWidth}`);
    } else {
      check(`${viewport.name}: all secondary controls in ONE non-wrapping row`, geo.rowCount === 1, `distinct row tops: ${geo.rowCount}`);
      check(`${viewport.name}: the group hugs the RIGHT edge (landscape right-alignment, remaining-fix contract)`, geo.viewportWidth - geo.rowRight <= 20, `group right gap: ${geo.viewportWidth - geo.rowRight}px`);
      check(`${viewport.name}: fullscreen remains INSIDE the group`, geo.fullscreenOnFirstRow);
      check(`${viewport.name}: the group does not stretch across the viewport (starts clear of the left edge)`, geo.rowLeft > 60, `group left: ${geo.rowLeft} of ${geo.viewportWidth}`);
      check(`${viewport.name}: quality control present in landscape`, geo.qualityPresent);
    }
    await page.close();
  }

  // Honest single-level quality state (Issue 6).
  // Focused fixes (Issue 3) contract change: the control is a DISABLED
  // BUTTON carrying the REAL level label (the sheet is never opened).
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.goto(`${BASE}/index.html`, { waitUntil: 'networkidle' });
  await page.evaluate(() => window.mountControls({ internalQualities: [{ id: '0', label: '720p' }] }));
  await page.waitForTimeout(120);
  const single = await page.evaluate(() => {
    const button = document.querySelector('.select-control.quality');
    return { present: Boolean(button), disabled: button?.disabled === true, label: button?.textContent?.trim() ?? '', opensSheet: button?.getAttribute('aria-haspopup') };
  });
  check('single-level manifest: the HONEST disabled quality control renders with the REAL label', single.present && single.disabled && single.label === '720p' && single.opensSheet === null, JSON.stringify(single));
  await page.evaluate(() => window.mountControls({ internalQualities: [] }));
  await page.waitForTimeout(120);
  const none = await page.evaluate(() => ({ quality: document.querySelector('.select-control.quality') ?? null }));
  check('zero levels (MP4/native): NO quality control renders (truthful absence)', none.quality === null);
  await page.close();
} finally {
  await browser.close();
  server.close();
}
console.log(`player_v2_final_remediation_dom_qa: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
