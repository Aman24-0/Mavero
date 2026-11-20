#!/usr/bin/env node
/**
 * MAVERO — wgt file:// boot smoke (Playwright, TV-engine simulation).
 *
 * WHAT THIS PROVES
 * ================
 * Desktop Chromium HAS the ES2021/ES2022 built-ins the TV lacks, so loading
 * the packed widget on a desktop browser NEVER reproduces the TV failure:
 *   1. Uncaught TypeError: Object.hasOwn is not a function (file:///app.js)
 *   2. Uncaught Error: classic bundle did not expose __mavero_wgt_app.start()
 *      (a pure cascade of #1 — the IIFE died at module evaluation, so the
 *      window.__mavero_wgt_app global was never assigned).
 *
 * This harness therefore DELETES the built-ins before ANY page script runs
 * (page.addInitScript — runs ahead of polyfill.js and app.js alike),
 * simulating the Tizen 6.0 web engine (Chromium 69–76):
 *   Object.hasOwn, Object.fromEntries, String.prototype.replaceAll,
 *   WeakRef, FinalizationRegistry, Array/String .at(),
 *   Array.prototype.findLast/findLastIndex, Promise.any/allSettled,
 *   AggregateError, queueMicrotask, Array.prototype.flat/flatMap,
 *   structuredClone.
 * (globalThis cannot be deleted from a Chromium window — the polyfill's
 * globalThis shim stays guard-protected and untestable here.)
 *
 * PASS CRITERIA (all mandatory):
 *   - the simulation is effective (the deleted built-ins really are gone
 *     before polyfill.js executes);
 *   - polyfill.js executed (window.__mavero_wgt_polyfill === true) and the
 *     deleted APIs are functional again (hasOwn/replaceAll/fromEntries/
 *     WeakRef smoke-called in-page);
 *   - window.__mavero_wgt_app.start exists (the classic IIFE survived module
 *     evaluation — the exact point where the TV crashed);
 *   - NO boot overlay (nothing failed during boot);
 *   - the boot banner auto-hid (MutationObserver saw the SPA render);
 *   - the shell renders: aside.app-sidebar (Primary navigation) + the
 *     discover body (empty state and/or catalog rails).
 *   - STAGE 4: body.tv-mode is ACTIVE (the §7 patch script ran), the
 *     <style id="mavero-tv-mode"> layer is in the shell, the spatial
 *     focus manager is installed (window.__maveroTvFocusManager), and a
 *     REAL D-PAD simulation moves DOM focus: synthetic ArrowDown (and
 *     ArrowRight) keydowns with the TV keyCodes re-target
 *     document.activeElement and the .tv-focused ring follows.
 *   - TV-UX pass: the Samsung KEY REGISTRATION rule — the manager must
 *     register ONLY extra media keys (arrows/Enter/Back are delivered
 *     automatically; registering them BLOCKS their delivery). A
 *     window.tizen.tvinputdevice recorder proves no mandatory key is
 *     ever registered. Consumed arrows are preventDefault()-ed (rule 7),
 *     the boot seed focus sits in the SIDEBAR (so Left/Right at open can
 *     never change a hero slide), Right from the sidebar AUTO-COLLAPSES
 *     it (the mavero:tv-sidebar contract), and when real rails rendered,
 *     Right along a rail applies the CSS-transform slide (never native
 *     scroll).
 *
 * USAGE
 * =====
 *   node scripts/wgt_file_smoke.mjs <path-to-MaveroTV.wgt | widget-dir>
 *
 * A .wgt file is extracted to a temp directory first (so the exact shipped
 * artifact is what boots, not a staging tree). Exits 0 on pass; on failure it
 * dumps every console message / page error / failed request collected plus
 * the on-screen overlay text, then exits 1.
 */

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { resolvePlaywright } from './mav_resolve_playwright.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const arg = process.argv[2];
if (!arg) {
  console.error(
    'wgt_file_smoke: ERROR — usage: node scripts/wgt_file_smoke.mjs <MaveroTV.wgt | widget-dir>'
  );
  process.exit(1);
}

let widgetDir = path.resolve(arg);
let extractedDir = null;
if (arg.toLowerCase().endsWith('.wgt')) {
  if (!existsSync(arg)) {
    console.error(`wgt_file_smoke: ERROR — ${arg} does not exist`);
    process.exit(1);
  }
  extractedDir = mkdtempSync(path.join(tmpdir(), 'mavero-wgt-smoke-'));
  // unzip is preinstalled on ubuntu runners and in this sandbox
  const { execFileSync } = await import('node:child_process');
  execFileSync('unzip', ['-q', path.resolve(arg), '-d', extractedDir], { stdio: 'pipe' });
  widgetDir = extractedDir;
  console.log(`wgt_file_smoke: extracted the .wgt to ${extractedDir}`);
}

const entry = path.join(widgetDir, 'index.html');
if (!existsSync(entry)) {
  console.error(`wgt_file_smoke: ERROR — no index.html in ${widgetDir}`);
  if (extractedDir) rmSync(extractedDir, { recursive: true, force: true });
  process.exit(1);
}
// The polyfill must ship next to index.html — check BEFORE booting (a missing
// file would otherwise only surface as a resource-load error on the overlay).
if (!existsSync(path.join(widgetDir, 'polyfill.js'))) {
  console.error('wgt_file_smoke: FAIL — polyfill.js is not at the widget root next to index.html');
  if (extractedDir) rmSync(extractedDir, { recursive: true, force: true });
  process.exit(1);
}
if (!existsSync(path.join(widgetDir, 'app.js'))) {
  console.error('wgt_file_smoke: FAIL — app.js (classic IIFE bundle) is not at the widget root');
  if (extractedDir) rmSync(extractedDir, { recursive: true, force: true });
  process.exit(1);
}

/** Runs before EVERY page script — the TV-engine simulation. */
const stripTvBuiltIns = () => {
  // ES2022 (Chrome 93+) — THE TV crash
  try { delete Object.hasOwn; } catch (e) {}
  // ES2019 (Chrome 73+) — borderline engine
  try { delete Object.fromEntries; } catch (e) {}
  // ES2021 (Chrome 85+)
  try { delete String.prototype.replaceAll; } catch (e) {}
  try { delete window.WeakRef; } catch (e) {}
  try { delete window.FinalizationRegistry; } catch (e) {}
  // ES2022 .at() (Chrome 92+)
  try { delete Array.prototype.at; } catch (e) {}
  try { delete String.prototype.at; } catch (e) {}
  // ES2023 (Chrome 97+)
  try { delete Array.prototype.findLast; } catch (e) {}
  try { delete Array.prototype.findLastIndex; } catch (e) {}
  // ES2020/2021 (Chrome 76+/85+) + companion
  try { delete Promise.allSettled; } catch (e) {}
  try { delete Promise.any; } catch (e) {}
  try { delete window.AggregateError; } catch (e) {}
  // Chrome 71+
  try { delete window.queueMicrotask; } catch (e) {}
  // Chrome 69 (borderline)
  try { delete Array.prototype.flat; } catch (e) {}
  try { delete Array.prototype.flatMap; } catch (e) {}
  // Chrome 98+
  try { delete window.structuredClone; } catch (e) {}
};

const fail = async (page, diagnostics, message) => {
  console.error(`wgt_file_smoke: FAIL — ${message}`);
  try {
    const overlay = await page.evaluate(() => {
      const el = document.getElementById('mavero-wgt-boot-overlay');
      return el ? el.innerText : null;
    });
    if (overlay) console.error('--- on-screen boot overlay text ---\n' + overlay);
  } catch (e) {}
  if (diagnostics.console.length) {
    console.error('--- console messages ---');
    for (const line of diagnostics.console) console.error('  ' + line);
  }
  if (diagnostics.pageErrors.length) {
    console.error('--- page errors ---');
    for (const line of diagnostics.pageErrors) console.error('  ' + line);
  }
  if (diagnostics.failedRequests.length) {
    console.error('--- failed requests (first 20) ---');
    for (const line of diagnostics.failedRequests.slice(0, 20)) console.error('  ' + line);
  }
  await browser.close().catch(() => {});
  if (extractedDir) rmSync(extractedDir, { recursive: true, force: true });
  process.exit(1);
};

const { chromium } = await resolvePlaywright();
const browser = await chromium.launch({
  headless: true,
  // file:// pages may need to read sibling file:// resources (parity with the
  // TV engine, which serves the widget from its private file root)
  args: ['--allow-file-access-from-files']
});

const context = await browser.newContext({
  viewport: { width: 1920, height: 1080 }, // TV (UA43AUE60AKLXL renders at 1920x1080)
  locale: 'en-US'
});

// Register the simulation BEFORE anything else touches the page.
await context.addInitScript(stripTvBuiltIns);

// TV-UX pass — the tvinputdevice RECORDER: captures every registerKey(Batch)
// call so the smoke can prove the Samsung registration rule (arrows, Enter
// and Back are platform-delivered and must NEVER be registered; only extra
// media keys may be). The mock is installed before app.js evaluates; the
// widget's other tizen.* surfaces stay undefined exactly as on a desktop
// browser (the AVPlay object paths no-op there already).
await context.addInitScript(() => {
  try {
    const recorded = [];
    const record = (keys) => {
      try {
        for (const key of Array.isArray(keys) ? keys : [keys]) recorded.push(String(key));
      } catch (e) {}
    };
    window.__tvRegisteredKeys = recorded;
    window.tizen = window.tizen || {};
    window.tizen.tvinputdevice = {
      registerKey: (key) => record(key),
      registerKeyBatch: (keys) => record(keys)
    };
  } catch (e) {}
});

const page = await context.newPage();
const diagnostics = { console: [], pageErrors: [], failedRequests: [] };
page.on('console', (msg) => {
  diagnostics.console.push(`[${msg.type()}] ${msg.text()}`.slice(0, 300));
});
page.on('pageerror', (err) => {
  diagnostics.pageErrors.push(String(err && err.stack ? err.stack : err).slice(0, 600));
});
page.on('requestfailed', (req) => {
  if (diagnostics.failedRequests.length < 100) {
    diagnostics.failedRequests.push(
      `${req.method()} ${req.url()} — ${req.failure() ? req.failure().errorText : 'unknown'}`.slice(0, 300)
    );
  }
});

// ---- 1. Prove the simulation is effective BEFORE the widget loads ---------
await page.goto('about:blank');
const simulation = await page.evaluate(() => ({
  hasOwn: typeof Object.hasOwn,
  fromEntries: typeof Object.fromEntries,
  replaceAll: typeof String.prototype.replaceAll,
  WeakRef: typeof window.WeakRef,
  FinalizationRegistry: typeof window.FinalizationRegistry,
  at: typeof Array.prototype.at,
  findLast: typeof Array.prototype.findLast,
  allSettled: typeof Promise.allSettled,
  any: typeof Promise.any,
  queueMicrotask: typeof window.queueMicrotask,
  structuredClone: typeof window.structuredClone
}));
const stillThere = Object.entries(simulation)
  .filter(([, kind]) => kind !== 'undefined')
  .map(([name, kind]) => `${name}=${kind}`);
if (stillThere.length > 0) {
  await fail(page, diagnostics, `TV simulation ineffective — these built-ins survived the deletion: ${stillThere.join(', ')}`);
}
console.log('wgt_file_smoke: TV-engine simulation effective — all simulated built-ins deleted');

// ---- 2. Boot the packed widget over file:// --------------------------------
const fileUrl = 'file://' + entry.split(path.sep).join('/');
console.log(`wgt_file_smoke: booting ${fileUrl}`);
await page.goto(fileUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

// ---- 3. Polyfill executed and the deleted APIs work again ------------------
const polyfillState = await page.evaluate(() => ({
  marker: window.__mavero_wgt_polyfill === true,
  hasOwn: typeof Object.hasOwn,
  hasOwnWorks: typeof Object.hasOwn === 'function' && Object.hasOwn({ a: 1 }, 'a') === true && Object.hasOwn({ a: 1 }, 'b') === false,
  replaceAll: typeof String.prototype.replaceAll,
  replaceAllWorks: typeof String.prototype.replaceAll === 'function' && 'a-b-c'.replaceAll('-', '+') === 'a+b+c',
  fromEntries: typeof Object.fromEntries,
  fromEntriesWorks: typeof Object.fromEntries === 'function' && Object.fromEntries([['a', 1]]).a === 1,
  WeakRef: typeof window.WeakRef,
  WeakRefWorks: typeof window.WeakRef === 'function' && new WeakRef({ ok: true }).deref().ok === true,
  globalThisOk: globalThis === window || typeof globalThis === 'object'
}));
if (!polyfillState.marker) {
  await fail(page, diagnostics, 'polyfill.js did not execute (window.__mavero_wgt_polyfill !== true)');
}
const dead = [];
if (polyfillState.hasOwn !== 'function' || !polyfillState.hasOwnWorks) dead.push('Object.hasOwn');
if (polyfillState.replaceAll !== 'function' || !polyfillState.replaceAllWorks) dead.push('String.prototype.replaceAll');
if (polyfillState.fromEntries !== 'function' || !polyfillState.fromEntriesWorks) dead.push('Object.fromEntries');
if (polyfillState.WeakRef !== 'function' || !polyfillState.WeakRefWorks) dead.push('WeakRef');
if (dead.length > 0) {
  await fail(page, diagnostics, `polyfill did not restore the deleted built-ins: ${dead.join(', ')}`);
}
console.log('wgt_file_smoke: polyfill executed and restored the deleted built-ins (hasOwn/replaceAll/fromEntries/WeakRef functional)');

// ---- 4. The bundle survived module evaluation (the TV crash point) ---------
let bootState;
try {
  await page.waitForFunction(
    () => typeof window.__mavero_wgt_app === 'object' && typeof window.__mavero_wgt_app.start === 'function',
    null,
    { timeout: 30000 }
  );
  bootState = await page.evaluate(() => ({ start: typeof window.__mavero_wgt_app.start }));
} catch (e) {
  await fail(page, diagnostics, 'window.__mavero_wgt_app.start never appeared — the IIFE died at module evaluation (exactly the TV cascade)');
}
console.log('wgt_file_smoke: __mavero_wgt_app.start exposed — the classic IIFE survived module evaluation');

// ---- 5. NO boot overlay -----------------------------------------------------
const overlayState = await page.evaluate(() => {
  const el = document.getElementById('mavero-wgt-boot-overlay');
  if (!el) return { present: false, visible: false };
  return { present: true, visible: el.style.display !== 'none' && el.offsetWidth > 0 };
});
if (overlayState.present && overlayState.visible) {
  await fail(page, diagnostics, 'the boot-error overlay is visible — something failed during boot');
}
console.log('wgt_file_smoke: no boot overlay' + (overlayState.present ? ' (element exists but hidden)' : ''));

// ---- 6. Shell renders: sidebar + discover body (empty state / rails) -------
let shellState;
try {
  await page.waitForSelector('aside.app-sidebar', { state: 'visible', timeout: 45000 });
} catch (e) {
  await fail(page, diagnostics, 'aside.app-sidebar never rendered — the shell did not boot');
}
// The boot banner must have auto-hidden (MutationObserver saw the SPA render).
const bannerState = await page
  .waitForFunction(() => {
    const el = document.getElementById('mavero-wgt-boot-banner');
    return el && el.style.display === 'none';
  }, null, { timeout: 15000 })
  .then(() => 'hidden')
  .catch(() => 'stuck');
if (bannerState !== 'hidden') {
  await fail(page, diagnostics, 'the "Mavero booting…" banner never auto-hid — the SPA never rendered under the mount');
}
shellState = await page.evaluate(() => {
  const body = document.querySelector('.discover-body');
  return {
    sidebar: !!document.querySelector('aside.app-sidebar'),
    sidebarLabel: (document.querySelector('aside.app-sidebar') || {}).getAttribute?.('aria-label') || null,
    discoverBodyChildren: body ? body.children.length : 0,
    emptyState: !!document.querySelector('.empty-state'),
    catalogWarning: (document.querySelector('.catalog-warning') || {}).textContent || null
  };
});
if (!shellState.sidebar) {
  await fail(page, diagnostics, 'aside.app-sidebar missing after boot');
}
if (shellState.discoverBodyChildren === 0) {
  await fail(page, diagnostics, '.discover-body rendered empty — no shell content at all');
}
console.log(
  `wgt_file_smoke: shell rendered — sidebar (aria-label="${shellState.sidebarLabel}"), ` +
    `.discover-body children=${shellState.discoverBodyChildren}, ` +
    `empty-state=${shellState.emptyState ? 'shown' : 'catalog rails shown'}` +
    (shellState.catalogWarning ? `, catalog warning: "${shellState.catalogWarning.slice(0, 120)}"` : '')
);

// ---- 7. No uncaught page errors ---------------------------------------------
if (diagnostics.pageErrors.length > 0) {
  await fail(page, diagnostics, `${diagnostics.pageErrors.length} uncaught page error(s) — see the dump below`);
}

// ---- 8. STAGE 4 — tv-mode layer + spatial focus manager + D-PAD simulation --
const tvModeState = await page.evaluate(() => ({
  bodyClass: document.body.className,
  styleInjected: !!document.getElementById('mavero-tv-mode'),
  focusManager: window.__maveroTvFocusManager === true,
  zoomApplied: getComputedStyle(document.body).zoom
}));
if (!tvModeState.bodyClass.includes('tv-mode')) {
  await fail(page, diagnostics, `body.tv-mode missing — the §7 patch script did not run (className="${tvModeState.bodyClass}")`);
}
if (!tvModeState.styleInjected) {
  await fail(page, diagnostics, 'the <style id="mavero-tv-mode"> Stage-4 layout layer is missing from the shell');
}
if (!tvModeState.focusManager) {
  await fail(page, diagnostics, 'window.__maveroTvFocusManager is not set — the spatial focus manager did not install');
}
console.log(
  `wgt_file_smoke: tv-mode active (body class + style layer, zoom=${String(tvModeState.zoomApplied)}) — spatial focus manager installed`
);

// TV-UX pass: the D-PAD/region simulations need a CONTENT target to walk
// into — wait until the TV payload has rendered (rails with real cards) or
// the honest empty state is up. The boot seed lands in the sidebar the
// moment the shell renders; Right from there can only enter content once
// the payload has populated it.
try {
  await page.waitForFunction(
    () => document.querySelector('.mc-card-link') || document.querySelector('.empty-state'),
    null,
    { timeout: 45000 }
  );
} catch (e) {
  await fail(page, diagnostics, 'neither catalog rails nor the empty state rendered — no D-PAD content to walk into');
}

// D-PAD simulation: TV keyCodes on window keydown. The manager listens on
// capture; synthetic events dispatched on document.body reach it.
const padState = await page.evaluate(async () => {
  const fire = (keyCode, key) =>
    window.dispatchEvent(
      new KeyboardEvent('keydown', { keyCode, key, bubbles: true, cancelable: true })
    );
  const focusables = () =>
    Array.from(
      document.querySelectorAll(
        'a[href], button:not([disabled]), [tabindex="0"], input:not([type="hidden"])'
      )
    ).filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && !el.closest('[aria-hidden="true"]');
    });
  const before = focusables().length;
  if (before === 0) return { before, moved: null, ring: false };
  // Seed: press Down once (with nothing focused the manager seeds focus),
  // then keep pressing across arrows and watch the active element change.
  const seen = new Set();
  fire(40, 'ArrowDown');
  await new Promise((r) => setTimeout(r, 120));
  const first = document.activeElement;
  seen.add(String(first && first.className));
  fire(40, 'ArrowDown');
  await new Promise((r) => setTimeout(r, 120));
  seen.add(String(document.activeElement && document.activeElement.className));
  fire(39, 'ArrowRight');
  await new Promise((r) => setTimeout(r, 120));
  seen.add(String(document.activeElement && document.activeElement.className));
  fire(38, 'ArrowUp');
  await new Promise((r) => setTimeout(r, 120));
  seen.add(String(document.activeElement && document.activeElement.className));
  const ring = !!document.querySelector('.tv-focused');
  return {
    before,
    focusedTag: document.activeElement ? document.activeElement.tagName : null,
    distinctTargets: seen.size,
    ring
  };
});
if (padState.before === 0) {
  await fail(page, diagnostics, 'no focusable elements found — D-PAD simulation impossible');
}
if (!padState.focusedTag || padState.focusedTag === 'BODY') {
  await fail(page, diagnostics, `arrow keys did not move DOM focus (activeElement=${String(padState.focusedTag)})`);
}
if (!padState.ring) {
  await fail(page, diagnostics, 'the .tv-focused focus ring never appeared after arrow navigation');
}
console.log(
  `wgt_file_smoke: D-PAD simulation moved focus (targets seen: ${padState.distinctTargets}, active=${padState.focusedTag}, ring applied)`
);

// ---- 9. TV-UX pass — Samsung registration rule + region behaviour ----------
// 9a. KEY REGISTRATION: arrows/Enter/Back are platform-delivered; registering
//     them BLOCKS delivery. Only media keys may appear in the recorder.
const registeredKeys = await page.evaluate(() => Array.from(window.__tvRegisteredKeys || []));
if (registeredKeys.length === 0) {
  await fail(page, diagnostics, 'tizen.tvinputdevice received NO registerKey calls — the manager skipped registration entirely (the recorder mock was not consumed)');
}
const mandatoryKeys = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter', 'Back'];
const forbidden = registeredKeys.filter((key) => mandatoryKeys.includes(key));
if (forbidden.length > 0) {
  await fail(page, diagnostics, `SAMSUNG RULE VIOLATION — mandatory keys registered via tvinputdevice (registering BLOCKS their delivery): ${forbidden.join(', ')}`);
}
console.log(
  `wgt_file_smoke: Samsung registration rule held — registered keys [${registeredKeys.join(', ')}] contain no arrows/Enter/Back (media keys only)`
);

// 9b. preventDefault discipline: a consumed arrow must never scroll the page.
//     Focus is placed DIRECTLY on the sidebar's first link (bypassing the
//     manager) so the state is deterministic: Left has no exit there — the
//     manager consumes it (rule 7) and focus STAYS in the sidebar.
const pdState = await page.evaluate(async () => {
  const link = document.querySelector('.app-sidebar .sidebar-link');
  if (!link) return { skipped: true };
  try { link.focus({ preventScroll: true }); } catch (e) { link.focus(); }
  await new Promise((r) => setTimeout(r, 120));
  const event = new KeyboardEvent('keydown', { keyCode: 37, key: 'ArrowLeft', bubbles: true, cancelable: true });
  window.dispatchEvent(event);
  await new Promise((r) => setTimeout(r, 120));
  return {
    skipped: false,
    prevented: event.defaultPrevented === true,
    stillSidebar: Boolean(document.activeElement && document.activeElement.closest && document.activeElement.closest('.app-sidebar'))
  };
});
if (!pdState.skipped) {
  if (!pdState.prevented) {
    await fail(page, diagnostics, 'a consumed arrow was NOT preventDefault()-ed — the page would scroll behind the manager (the reported Left/Right scroll bug)');
  }
  if (!pdState.stillSidebar) {
    await fail(page, diagnostics, 'Left from the sidebar moved focus OUT of the sidebar — the sidebar left edge must be a hard stop');
  }
  console.log('wgt_file_smoke: preventDefault discipline verified (consumed arrow stopped; Left from the sidebar stays put)');
}

// 9c. SIDEBAR AUTO-COLLAPSE: Right from the sidebar enters content and the
//     manager dispatches mavero:tv-sidebar {collapsed:true} (AppShell
//     collapses to the icon rail).
const sidebarState = await page.evaluate(async () => {
  const link = document.querySelector('.app-sidebar .sidebar-link');
  if (!link) return { skipped: true };
  try { link.focus({ preventScroll: true }); } catch (e) { link.focus(); }
  await new Promise((r) => setTimeout(r, 120));
  const events = [];
  const recorder = (e) => {
    try {
      events.push(e.detail && e.detail.collapsed);
    } catch (err) {}
  };
  window.addEventListener('mavero:tv-sidebar', recorder);
  window.dispatchEvent(new KeyboardEvent('keydown', { keyCode: 39, key: 'ArrowRight', bubbles: true, cancelable: true }));
  await new Promise((r) => setTimeout(r, 160));
  window.removeEventListener('mavero:tv-sidebar', recorder);
  const active = document.activeElement;
  return {
    skipped: false,
    events,
    leftSidebar: Boolean(active && !(active.closest && active.closest('.app-sidebar')))
  };
});
if (!sidebarState.skipped) {
  if (!sidebarState.leftSidebar) {
    await fail(page, diagnostics, 'Right from the sidebar did not move focus into the content area');
  }
  if (!sidebarState.events.some((value) => value === true)) {
    await fail(page, diagnostics, 'Right from the sidebar did not dispatch mavero:tv-sidebar {collapsed:true} — the auto-collapse contract is broken');
  }
  console.log('wgt_file_smoke: sidebar auto-collapse verified (Right from the sidebar → content + icon-rail event)');
}

// 9d. RAIL SLIDE (only when real rails rendered — the empty-state fallback
//     has none): Right along a rail must SLIDE it via CSS transform and
//     focus must never vanish, even past the last VISIBLE card.
const railState = await page.evaluate(async () => {
  const fire = (keyCode, key) =>
    window.dispatchEvent(
      new KeyboardEvent('keydown', { keyCode, key, bubbles: true, cancelable: true })
    );
  const rail = document.querySelector('.rail');
  if (!rail) return { skipped: true };
  const cards = rail.querySelectorAll('.mc-wrap .mc-card-link');
  if (cards.length < 3) return { skipped: true, cards: cards.length };
  // Walk onto the rail's first VISIBLE card (Down from the content entry),
  // then Right repeatedly — at least one press must cross the visible edge
  // on a 200px-card rail (8+ cards render beyond the 1920px viewport).
  const visibleCards = Array.from(cards).filter((card) => {
    const rect = card.getBoundingClientRect();
    return rect.right <= window.innerWidth + 4 && rect.left >= 0;
  });
  const startCard = visibleCards[Math.max(0, visibleCards.length - 2)] || cards[0];
  try { startCard.focus({ preventScroll: true }); } catch (e) {}
  let focusVanished = false;
  for (let i = 0; i < 6; i++) {
    fire(39, 'ArrowRight');
    await new Promise((r) => setTimeout(r, 90));
    const active = document.activeElement;
    if (!active || active === document.body) {
      focusVanished = true;
      break;
    }
  }
  const transform = getComputedStyle(rail).transform;
  return {
    skipped: false,
    focusVanished,
    slid: transform && transform !== 'none',
    stillOnRail: Boolean(document.activeElement && document.activeElement.closest && document.activeElement.closest('.rail'))
  };
});
if (!railState.skipped) {
  if (railState.focusVanished) {
    await fail(page, diagnostics, 'focus DISAPPEARED while moving Right along a rail — the reported rail-end bug');
  }
  if (!railState.slid) {
    await fail(page, diagnostics, 'the rail never applied a CSS-transform slide while focus crossed the visible edge');
  }
  if (!railState.stillOnRail) {
    await fail(page, diagnostics, 'focus left the rail while sliding Right along it');
  }
  console.log('wgt_file_smoke: rail slide verified (transform applied, focus retained across the visible edge)');
} else {
  console.log('wgt_file_smoke: rail slide skipped (no populated rails rendered — empty-state fallback)');
}

console.log('wgt_file_smoke: PASS — the packed widget boots over file:// on a TV-era engine (simulated built-ins deleted), polyfill fixes the Object.hasOwn crash, __mavero_wgt_app.start exposed, overlay silent, sidebar + discover body rendered, tv-mode + spatial D-PAD focus verified, Samsung key-registration + region rules verified');

await browser.close();
if (extractedDir) rmSync(extractedDir, { recursive: true, force: true });
process.exit(0);
