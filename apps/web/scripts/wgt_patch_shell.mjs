#!/usr/bin/env node
/**
 * MAVERO — wgt shell patcher (pack-time; runs on the BUILD OUTPUT only).
 *
 * The Tizen widget manager opens the app at <package root>/index.html
 * (config.xml `<content src="index.html"/>`). The built shell needs three
 * pack-time fixes that adapter-static cannot produce, because the widget
 * runs from a file:// origin (the production web app is never touched —
 * this script is only ever invoked by .github/workflows/build-wgt.yml):
 *
 * 1. RELATIVE ASSET PATHS. SvelteKit emits ABSOLUTE asset URLs in the
 *    fallback shell (`/_app/…`, `/favicon.ico`, `/manifest.webmanifest`,
 *    and the dynamic `import("/_app/env.js")` boot specifier). On a
 *    file:// origin an absolute path resolves against the FILESYSTEM
 *    ROOT, so every CSS/JS reference 404s, the SPA never boots and the
 *    TV shows a blank grey screen (observed on UA43AUE60AKLXL / Tizen
 *    6.0). `kit.paths.relative` does not rewrite the FALLBACK shell's
 *    links, so this script rewrites them: every `"/_app/` (and
 *    `'/​_app/`) string — attribute values and the inline boot script's
 *    dynamic import specifiers — becomes `./_app/`, and every
 *    `href="/` / `src="/` becomes `href="./` / `src="./` (root-relative
 *    references only — `//` protocol-relative URLs and remote
 *    `https://…` URLs are left alone).
 *
 * 1.5. HASH-ROUTER-FRIENDLY BOOT. The wgt build runs SvelteKit's hash
 *    router (kit.router.type = 'hash', see svelte.config.js): the route
 *    id comes from location.hash, so the app boots onto its HOME route
 *    from ANY install path and SPA navigation never touches the history
 *    URL APIs that file:// forbids. No pathname surgery is needed here —
 *    the shell's base global stays as kit emitted it.
 *
 * 2. BOOT URL NORMALIZATION (pre-existing). SvelteKit's router has no
 *    /index.html route — a tiny boot script rewrites the widget entry
 *    URL to the package root BEFORE the client router boots.
 *
 * 3. ON-SCREEN BOOT DIAGNOSTICS. A retail Samsung TV has NO devtools,
 *    no sdb, no console — a failed boot is a blank grey screen with zero
 *    information. A plain (classic, non-module) inline script at the
 *    very top of <head> installs:
 *      - a "Mavero booting…" banner painted immediately (distinguishes
 *        "nothing executed at all" from "CSS loaded but JS failed");
 *      - a full-screen error overlay fed by `window.onerror`-style
 *        events (message + source + stack), `unhandledrejection`, and
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

import { readFileSync, writeFileSync } from 'node:fs';
import process from 'node:process';

const target = process.argv[2];
if (!target) {
  console.error('wgt_patch_shell: ERROR — usage: node scripts/wgt_patch_shell.mjs <index.html>');
  process.exit(1);
}

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
// 1. Absolute → relative asset paths (the file:// blank-grey-screen fix).
// ---------------------------------------------------------------------------

// String literals pointing into /_app/ — both the attribute values and the
// dynamic import specifiers inside kit's inline boot script
// (import("/_app/env.js") → import("./_app/env.js")). Single-quoted variants
// are included for future-proofing; runtime fetch('/api/…') strings are NOT
// touched (only /_app/ is rewritten, never /api/ or other roots).
html = html.replaceAll('"/_app/', '"./_app/').replaceAll("'/_app/", "'./_app/");

// Root-relative attribute references (favicon, manifest, icons…). The
// (?!\/) guard keeps protocol-relative "//host" URLs untouched.
const attrRewrites = html.match(/\s(?:href|src)="\/(?!\/)/g);
html = html.replace(/\s(href|src)="\/(?!\/)/g, ' $1="./');
html = html.replace(/\s(href|src)='\/(?!\/)/g, " $1='./");

// ---------------------------------------------------------------------------
// 2. On-screen boot diagnostics (plain script, first thing in <head>).
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
// SvelteKit entry modules are evaluated, so the router reads the normalized
// location at boot. history.state is preserved (the router's own seeded
// state must survive). On engines that forbid replaceState across file://
// paths the guard catches the SecurityError and the shell stays on the
// literal /index.html URL — with relative asset paths both entry URLs
// resolve correctly anyway.
const bootScript = `<script>/* mavero-wgt-boot: normalize the Tizen widget entry URL (…/index.html) to the package root before the SvelteKit router boots */
try {
  if (/\\/index\\.html$/.test(location.pathname)) {
    history.replaceState(history.state, '', location.href.replace(/index\\.html$/, ''));
  }
} catch (e) {}</script>`;

html = html.replace('<head>', `<head>${bootOverlayScript}${bootScript}`);

// ---------------------------------------------------------------------------
// 3. Self-assertions — fail the CI job loudly instead of shipping a
//    blank-grey-screen widget.
// ---------------------------------------------------------------------------

const problems = [];
if (html.includes('"/_app/') || html.includes("'/_app/")) {
  problems.push('an absolute "/_app/" or \u0027/_app/\u0027 reference survived the rewrite');
}
if (!/href="\.\/_app\//.test(html)) {
  problems.push('no relative href="./_app/…" found — rewrite did not apply');
}
if (!html.includes('_app/immutable/entry/')) {
  problems.push('SvelteKit entry reference lost during rewrite');
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
  `wgt_patch_shell: patched the built shell — absolute asset paths rewritten ` +
    `(/_app/ strings + ${attrCount} href/src attributes), boot URL normalizer + ` +
    `on-screen boot diagnostics injected`
);
