#!/usr/bin/env node
/**
 * MAVERO — wgt shell patcher (pack-time; runs on the BUILD OUTPUT only).
 *
 * The Tizen widget manager opens the app at <package root>/index.html
 * (config.xml `<content src="index.html"/>`). The built shell needs pack-time
 * fixes that adapter-static cannot produce, because the widget runs from a
 * file:// origin (the production web app is never touched — this script is
 * only ever invoked by .github/workflows/build-wgt.yml):
 *
 * 1. RELATIVE ASSET PATHS. SvelteKit emits ABSOLUTE asset URLs in the
 *    fallback shell (`/_app/…`, `/favicon.ico`, `/manifest.webmanifest`).
 *    On a file:// origin an absolute path resolves against the FILESYSTEM
 *    ROOT, so every CSS/JS reference 404s and the TV shows a blank grey
 *    screen (observed on UA43AUE60AKLXL / Tizen 6.0). `kit.paths.relative`
 *    does not rewrite the FALLBACK shell's links, so this script rewrites
 *    them: every `"/_app/` string and every `href="/` / `src="/` attribute
 *    becomes relative (root-relative references only — `//`
 *    protocol-relative and remote `https://…` URLs are left alone).
 *
 * 2. CLASSIC BOOT (the ES-modules fix — TV-verified). The Tizen web engine
 *    BLOCKS ES module loading from the widget's file:// origin (origin
 *    "null"): static `type="module"` scripts, dynamic `import()` calls and
 *    modulepreload links are all refused. The TV's boot-diagnostics overlay
 *    proved this ON DEVICE (the chunk files exist but are never executed),
 *    and the earlier AVPlay PoC proved plain CLASSIC scripts load fine.
 *    The wgt build therefore ships ONE classic IIFE bundle (app.js — see
 *    vite.config.ts `mavero-wgt-classic-bundle` + svelte.config.js
 *    bundleStrategy 'single'), and this script replaces SvelteKit's module
 *    bootstrap (`import("/_app/env.js")…import("/app.js")…`) with:
 *      - a CLASSIC inline script that installs the very globals the bundle
 *        reads (`window.__sveltekit_<hash> = { base, env }` — the dynamic
 *        public env module is inlined here as data, because the bundle can
 *        never runtime-import `_app/env.js` as an ES module), captures the
 *        SvelteKit mount element exactly like the original bootstrap did
 *        (`document.currentScript.parentElement`), and on DOMContentLoaded
 *        (which fires AFTER deferred classic scripts) calls the bundle's
 *        exported `start()` through the IIFE global `__mavero_wgt_app`;
 *      - `<script src="./app.js" defer></script>` — a plain classic script,
 *        which file:// origins always allow.
 *    It also strips every `modulepreload` link (they reference ES chunks
 *    the engine would refuse and would spam the boot overlay).
 *
 * 3. STYLESHEET LINK. With the single classic bundle (cssCodeSplit off,
 *    see vite.config.ts) all app CSS is emitted as ONE merged asset under
 *    `_app/immutable/assets/*.css`, which NOTHING references automatically
 *    in the fallback shell. This script injects a relative
 *    `<link rel="stylesheet">` for every emitted stylesheet.
 *
 * 4. NO ANALYTICS. The Umami Cloud loader lives in src/app.html (a plain
 *    template shared with production — it cannot carry a compile-time
 *    branch, and touching app.html would break the production build's
 *    byte-identity). On the TV the Umami script is worse than useless:
 *    its ES2020 syntax is a hard SyntaxError on the Tizen 6.0 engine
 *    (seen in the TV overlay) and the widget's null origin would beacon
 *    nothing anyway. This script removes the loader from the packed shell;
 *    build-wgt.yml asserts `cloud.umami.is` never survives.
 *
 * 5. ON-SCREEN BOOT DIAGNOSTICS. A retail Samsung TV has NO devtools, no
 *    sdb, no console — a failed boot is a blank grey screen with zero
 *    information. A plain (classic, non-module) inline script at the very
 *    top of <head> installs:
 *      - a "Mavero booting…" banner painted immediately (distinguishes
 *        "nothing executed at all" from "CSS loaded but JS failed");
 *      - a full-screen error overlay fed by `window.onerror`-style events
 *        (message + source + stack), `unhandledrejection`, and
 *        capture-phase resource load errors (<script>/<link>/<img>);
 *      - auto-hide of the banner the moment the SPA renders any element
 *        (MutationObserver — the static shell markup parsed at startup
 *        does NOT count), so a working app never stays behind it;
 *        late resource-load noise (e.g. analytics) is ignored once the
 *        app is running so a booted app is never covered;
 *      - Back/Escape dismissal of the overlay after the app has booted.
 *    Whatever fails on the TV, the failure text becomes readable on the
 *    screen itself.
 *
 * Usage: node scripts/wgt_patch_shell.mjs <path-to-built-index.html>
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const target = process.argv[2];
if (!target) {
  console.error('wgt_patch_shell: ERROR — usage: node scripts/wgt_patch_shell.mjs <index.html>');
  process.exit(1);
}

const shellDir = path.dirname(path.resolve(target));
let html = readFileSync(target, 'utf8');
if (!html.includes('<head>')) {
  console.error('wgt_patch_shell: ERROR — <head> not found in the built shell');
  process.exit(1);
}
if (html.includes('mavero-wgt-boot-overlay')) {
  console.log('wgt_patch_shell: already patched — nothing to do');
  process.exit(0);
}

// ---------------------------------------------------------------------------
// 1. NO ANALYTICS — remove the Umami Cloud loader (see header §4).
// ---------------------------------------------------------------------------

let umamiRemoved = 0;
html = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, (block) => {
  if (block.includes('cloud.umami.is')) {
    umamiRemoved += 1;
    return '';
  }
  return block;
});

// ---------------------------------------------------------------------------
// 2. CLASSIC BOOT — replace SvelteKit's module bootstrap (see header §2).
// ---------------------------------------------------------------------------

// Locate the module bootstrap: the (only) inline <script> that wires up the
// kit payload global and dynamically imports the entry modules.
const scriptBlocks = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)];
const bootstrapBlock = scriptBlocks.find((m) => /__sveltekit_[A-Za-z0-9]+\s*=/.test(m[1]));
if (!bootstrapBlock) {
  console.error(
    'wgt_patch_shell: ERROR — SvelteKit module bootstrap not found ' +
      '(no inline <script> containing the __sveltekit_<hash> payload global)'
  );
  process.exit(1);
}

const hashMatch = bootstrapBlock[1].match(/__sveltekit_([A-Za-z0-9]+)\s*=/);
if (!hashMatch) {
  console.error('wgt_patch_shell: ERROR — could not extract the __sveltekit_<hash> global name');
  process.exit(1);
}
const kitHash = hashMatch[1];

// Inline the dynamic public env as DATA. The bundle reads
// `__sveltekit_<hash>.env` — the original bootstrap filled it from a runtime
// ES-module import of _app/env.js, which file:// forbids. The generated
// env module is one line: `export const env={PUBLIC_…:"…",…}` — convert it
// to an object literal and embed it in the classic boot script.
const envJsPath = path.join(shellDir, '_app', 'env.js');
let envLiteral = '{}';
if (existsSync(envJsPath)) {
  const envSrc = readFileSync(envJsPath, 'utf8');
  const envMatch = envSrc.match(/export\s+const\s+env\s*=\s*(\{[\s\S]*\})/);
  if (!envMatch) {
    console.error(
      'wgt_patch_shell: ERROR — could not parse the generated env module ' +
        `(${path.relative(shellDir, envJsPath)}). Expected "export const env={…}".`
    );
    process.exit(1);
  }
  envLiteral = envMatch[1];
} else {
  console.log('wgt_patch_shell: note — no generated _app/env.js (no dynamic public env); env = {}');
}

// The classic boot script: plain ES2017-style code (no arrow functions,
// no optional chaining, no template literals — same discipline as the
// overlay script below), positioned EXACTLY where SvelteKit's bootstrap
// was (inside the %sveltekit.body% wrapper div) so the mount element is
// identical, and booting the IIFE bundle after the deferred classic
// script has executed (DOMContentLoaded always fires after defer).
const classicBootScript =
  `<script>/* mavero-wgt-classic-boot: ES modules are blocked on the widget's file:// origin ` +
  `(Tizen 6.0, origin "null" — TV-verified). This classic script installs the globals the ` +
  `bundle reads (window.__sveltekit_${kitHash} = { base, env } — the dynamic public env is ` +
  `inlined as data), captures the SvelteKit mount element exactly like the original module ` +
  `bootstrap did, and boots the single classic IIFE bundle (./app.js) after it has loaded. */\n` +
  `(function () {\n` +
  `  try {\n` +
  `    var g = window;\n` +
  `    g.__sveltekit_${kitHash} = {\n` +
  `      base: new URL('.', location).pathname.slice(0, -1),\n` +
  `      env: ${envLiteral}\n` +
  `    };\n` +
  `    g.__mavero_wgt_mount = document.currentScript ? document.currentScript.parentElement : null;\n` +
  `    g.addEventListener('DOMContentLoaded', function () {\n` +
  `      try {\n` +
  `        var app = g.__mavero_wgt_app;\n` +
  `        if (!app || typeof app.start !== 'function') {\n` +
  `          throw new Error('classic bundle did not expose __mavero_wgt_app.start()');\n` +
  `        }\n` +
  `        app.start(g.__mavero_wgt_mount);\n` +
  `      } catch (e) {\n` +
  `        setTimeout(function () { throw e; }, 0); /* surface on window.onerror (boot overlay) */\n` +
  `      }\n` +
  `    });\n` +
  `  } catch (e) {\n` +
  `    setTimeout(function () { throw e; }, 0);\n` +
  `  }\n` +
  `})();\n` +
  `</script>\n` +
  `<script src="./app.js" defer></script>`;

html = html.replace(bootstrapBlock[0], classicBootScript);

// Strip every modulepreload link — they preload ES chunks that the file://
// engine refuses (the TV overlay logged exactly this as "failed to load
// link") and would only add boot-overlay noise.
const modulePreloadCount = (html.match(/<link\b[^>]*\brel="modulepreload"[^>]*>/gi) || []).length;
html = html.replace(/<link\b[^>]*\brel="modulepreload"[^>]*>/gi, '');

// ---------------------------------------------------------------------------
// 3. STYLESHEET LINK(S) — link the merged CSS asset(s) (see header §3).
// ---------------------------------------------------------------------------

// cssCodeSplit is off for the single classic bundle, so every app stylesheet
// lands in _app/immutable/assets/. Nothing references them in the fallback
// shell (Vite emits the asset without a chunk linkage), so inject a relative
// <link rel="stylesheet"> for each one.
const assetsDir = path.join(shellDir, '_app', 'immutable', 'assets');
let cssLinks = '';
let cssCount = 0;
if (existsSync(assetsDir)) {
  const cssFiles = readdirSync(assetsDir).filter((f) => f.endsWith('.css')).sort();
  cssLinks = cssFiles
    .map((f) => `<link rel="stylesheet" href="./_app/immutable/assets/${f}" />`)
    .join('\n    ');
  cssCount = cssFiles.length;
}

// ---------------------------------------------------------------------------
// 4. Absolute → relative asset paths (the file:// blank-grey-screen fix).
// ---------------------------------------------------------------------------

// String literals pointing into /_app/ — attribute values and any remaining
// import specifiers. Single-quoted variants are included for future-
// proofing; runtime fetch('/api/…') strings are NOT touched (only /_app/ is
// rewritten, never /api/ or other roots).
html = html.replaceAll('"/_app/', '"./_app/').replaceAll("'/_app/", "'./_app/");

// Root-relative attribute references (favicon, manifest, icons…). The
// (?!\/) guard keeps protocol-relative "//host" URLs untouched.
const attrRewrites = html.match(/\s(?:href|src)="\/(?!\/)/g);
html = html.replace(/\s(href|src)="\/(?!\/)/g, ' $1="./');
html = html.replace(/\s(href|src)='\/(?!\/)/g, " $1='./");

// ---------------------------------------------------------------------------
// 5. On-screen boot diagnostics (plain script, first thing in <head>).
// ---------------------------------------------------------------------------

// Plain ES2017 — NO optional chaining / nullish coalescing / template
// literals: this script must run even on the old TV engine BEFORE any
// build-target downleveling question is settled. It registers FIRST so the
// error handlers are active before any asset starts loading.
const bootOverlayScript = `<script>/* mavero-wgt-boot-overlay: on-screen boot diagnostics for the TV (retail sets have no devtools/sdb logs). Registered before every asset so any boot failure becomes readable text on screen. */
(function () {
  if (window.__maveroBootDiag) return;
  window.__maveroBootDiag = true;
  var OVERLAY_ID = 'mavero-wgt-boot-overlay';
  var BANNER_ID = 'mavero-wgt-boot-banner';
  var booted = false;
  var overlayVisible = false;

  function make(tag, css, text) {
    var node = document.createElement(tag);
    node.setAttribute('style', css);
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  function hideBanner() {
    try {
      var b = document.getElementById(BANNER_ID);
      if (b) b.style.display = 'none';
    } catch (e) {}
  }

  function paint(kind, message, source, stack) {
    try {
      hideBanner();
      var ov = document.getElementById(OVERLAY_ID);
      if (!ov) {
        ov = make('div',
          'position:fixed;left:0;top:0;right:0;bottom:0;z-index:2147483647;background:#0b0f14;color:#d7e3ef;' +
            'font:13px/1.55 monospace;padding:22px;overflow:auto;white-space:pre-wrap;word-break:break-all;display:none;');
        ov.id = OVERLAY_ID;
        ov.appendChild(make('div', 'font-size:19px;font-weight:bold;color:#ff7b72;margin-bottom:10px;',
          'MAVERO boot error (TV diagnostics)'));
        (document.body || document.documentElement).appendChild(ov);
      }
      overlayVisible = true;
      var entry = make('div', 'border-top:1px solid #223142;padding:9px 0;margin-top:6px;');
      entry.appendChild(make('div', 'color:#ff7b72;font-weight:bold;',
        String(kind + (message ? ' — ' + message : '')).slice(0, 600)));
      if (source) entry.appendChild(make('div', 'color:#8fa8bf;margin-top:3px;', 'source: ' + String(source).slice(0, 600)));
      if (stack) entry.appendChild(make('div', 'color:#5f7386;font-size:11px;margin-top:4px;', String(stack).slice(0, 1600)));
      ov.appendChild(entry);
      ov.style.display = 'block';
    } catch (e) {}
  }

  // capture phase — resource load errors do not bubble to the window
  window.addEventListener('error', function (ev) {
    try {
      var t = ev.target;
      if (t && t !== window && t.tagName) {
        if (booted) return; // late noise (analytics trackers etc.) must not cover a working app
        var url = t.src || t.href || '(unknown url)';
        paint('failed to load ' + String(t.tagName).toLowerCase(), null, url, null);
        return;
      }
      paint('error', ev.message,
        ev.filename ? ev.filename + ' @ ' + ev.lineno + ':' + ev.colno : null,
        ev.error && ev.error.stack ? ev.error.stack : null);
    } catch (e) {}
  }, true);

  window.addEventListener('unhandledrejection', function (ev) {
    try {
      var r = ev && ev.reason;
      paint('unhandled rejection',
        r && (r.message || String(r)) ? r.message || String(r) : '(no reason)',
        null,
        r && r.stack ? r.stack : null);
    } catch (e) {}
  });

  // once the app is running, Back/Escape dismiss the overlay (it must not trap the UI)
  window.addEventListener('keydown', function (ev) {
    try {
      if (!overlayVisible || !booted) return;
      if (ev.keyCode === 10009 || ev.keyCode === 27 || ev.key === 'Back' || ev.key === 'Escape') {
        var ov = document.getElementById(OVERLAY_ID);
        if (ov) { ov.style.display = 'none'; overlayVisible = false; }
      }
    } catch (e) {}
  });

  // The SPA reports itself booted by rendering any element under the mount
  // wrapper. The static shell markup parsed at startup (direct children of
  // <body>) does NOT count; non-rendered elements (scripts/styles/…) never
  // count.
  function markBooted() {
    if (booted) return;
    booted = true;
    hideBanner();
  }
  try {
    if (typeof MutationObserver !== 'undefined') {
      var skip = { SCRIPT: 1, STYLE: 1, LINK: 1, META: 1, BASE: 1, TITLE: 1, NOSCRIPT: 1, TEMPLATE: 1 };
      new MutationObserver(function (muts) {
        if (booted) return;
        for (var i = 0; i < muts.length; i++) {
          var added = muts[i].addedNodes;
          for (var j = 0; j < added.length; j++) {
            var n = added[j];
            if (n.nodeType !== 1) continue;
            if (n.id === OVERLAY_ID || n.id === BANNER_ID) continue;
            if (skip[n.tagName]) continue;
            var p = n.parentNode;
            if (p && p.nodeType === 1 && p.tagName !== 'BODY' && p !== document.documentElement) {
              markBooted();
              return;
            }
          }
        }
      }).observe(document.documentElement, { childList: true, subtree: true });
    }
  } catch (e) {}

  // Visible from the first millisecond, before any stylesheet: distinguishes
  // "truly blank" from "CSS loaded but JS failed" on a TV with no devtools.
  try {
    var banner = make('div',
      'position:fixed;left:0;top:0;right:0;bottom:0;z-index:2147483646;background:#0b0f14;color:#8fa8bf;' +
        'display:flex;flex-direction:column;align-items:center;justify-content:center;font-family:sans-serif;');
    banner.id = BANNER_ID;
    banner.appendChild(make('div', 'font-size:30px;color:#eef4fa;letter-spacing:3px;font-weight:700;', 'MAVERO'));
    banner.appendChild(make('div', 'font-size:17px;margin-top:14px;', 'Mavero booting\\u2026'));
    banner.appendChild(make('div', 'font-size:12px;margin-top:26px;color:#41576d;', 'TV boot diagnostics active'));
    (document.body || document.documentElement).appendChild(banner);
  } catch (e) {}
})();
</script>`;

// Runs FIRST in <head> (right after the diagnostics script), before the
// bundle is evaluated, so the router reads the normalized location at boot.
// history.state is preserved (the router's own seeded state must survive).
// On engines that forbid replaceState across file:// paths the guard catches
// the SecurityError and the shell stays on the literal /index.html URL —
// with relative asset paths + the hash router both entry URLs resolve
// correctly anyway.
const bootScript = `<script>/* mavero-wgt-boot: normalize the Tizen widget entry URL (…/index.html) to the package root before the SvelteKit router boots */
try {
  if (/\\/index\\.html$/.test(location.pathname)) {
    history.replaceState(history.state, '', location.href.replace(/index\\.html$/, ''));
  }
} catch (e) {}</script>`;

const headInjection = cssCount > 0 ? `${bootOverlayScript}${bootScript}\n    ${cssLinks}` : `${bootOverlayScript}${bootScript}`;
html = html.replace('<head>', `<head>${headInjection}`);

// ---------------------------------------------------------------------------
// 6. Self-assertions — fail the CI job loudly instead of shipping a
//    blank-grey-screen widget.
// ---------------------------------------------------------------------------

const problems = [];
if (html.includes('"/_app/') || html.includes("'/_app/")) {
  problems.push('an absolute "/_app/" or \u0027/_app/\u0027 reference survived the rewrite');
}
if (!/href="\.\/_app\//.test(html)) {
  problems.push('no relative href="./_app/…" found — rewrite did not apply');
}
if (!html.includes('src="./app.js" defer')) {
  problems.push('no classic <script src="./app.js" defer> boot tag — the ES-module bootstrap was not replaced');
}
if (/type=["']module["']/i.test(html)) {
  problems.push('a type="module" script survived — ES modules are blocked on the TV file:// origin');
}
if (html.includes('import(')) {
  problems.push('a dynamic import( survived in the shell — blocked on the TV file:// origin');
}
if (html.includes('modulepreload')) {
  problems.push('a modulepreload link survived — ES-chunk preloads are refused on the TV');
}
if (!html.includes(`window.__sveltekit_${kitHash} =`)) {
  problems.push(`the classic env global (window.__sveltekit_${kitHash}) is missing`);
}
if (!html.includes('__mavero_wgt_app')) {
  problems.push('the boot script does not reference the IIFE global __mavero_wgt_app');
}
if (cssCount > 0 && !/href="\.\/_app\/immutable\/assets\/[^"]+\.css"/.test(html)) {
  problems.push('emitted stylesheet asset(s) are not linked from the shell — the TV would boot unstyled');
}
if (cssCount === 0) {
  problems.push('no stylesheet asset found under _app/immutable/assets — the TV would boot unstyled');
}
if (html.includes('cloud.umami.is')) {
  problems.push('the Umami Cloud loader survived — it SyntaxErrors on the TV engine and is useless on TV');
}
if (!html.includes('mavero-wgt-boot')) {
  problems.push('boot URL-normalization script missing');
}
if (!html.includes('mavero-wgt-boot-overlay')) {
  problems.push('boot-error overlay missing');
}
if (!html.includes('mavero-wgt-boot-banner')) {
  problems.push('boot banner missing');
}

if (problems.length > 0) {
  console.error('wgt_patch_shell: PATCH FAILED self-verification:');
  for (const p of problems) console.error('  - ' + p);
  process.exit(1);
}

writeFileSync(target, html);
const attrCount = attrRewrites ? attrRewrites.length : 0;
console.log(
  `wgt_patch_shell: patched the built shell — module bootstrap replaced with the classic ` +
    `boot (env global __sveltekit_${kitHash} + <script src="./app.js" defer>), ` +
    `${modulePreloadCount} modulepreload link(s) stripped, ${umamiRemoved} Umami loader ` +
    `block(s) removed, ${cssCount} stylesheet link(s) injected, absolute asset paths rewritten ` +
    `(/_app/ strings + ${attrCount} href/src attributes), boot URL normalizer + on-screen ` +
    `boot diagnostics injected`
);
