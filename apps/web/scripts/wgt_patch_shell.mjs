#!/usr/bin/env node
/**
 * MAVERO — wgt shell patcher (pack-time; runs on the BUILD OUTPUT only).
 *
 * The Tizen widget manager opens the app at <package root>/index.html
 * (config.xml `<content src="index.html"/>`). SvelteKit's router has no
 * /index.html route — the router would render the error page ("Page
 * unavailable") instead of the app. This script injects a tiny boot
 * script into the BUILT index.html that normalizes the URL to the
 * package root BEFORE the client router boots.
 *
 * It patches ONLY the widget build output — the production web app's
 * HTML (adapter-netlify SSR) is never touched, and this script is never
 * invoked by the Netlify build.
 *
 * Why a boot script and not app.html: app.html is shared with the
 * production build. Pack-time injection keeps the production artifact
 * byte-identical while giving the TV build exactly what it needs.
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
if (html.includes('mavero-wgt-boot')) {
  console.log('wgt_patch_shell: already patched — nothing to do');
  process.exit(0);
}

// Runs FIRST in <head>, before the SvelteKit entry modules are evaluated,
// so the router reads the normalized location at boot. history.state is
// preserved (the router's own seeded state must survive). On engines that
// forbid replaceState across file:// paths the guard catches the
// SecurityError and the shell stays on the literal /index.html URL (the
// router then renders its error page — a visible, debuggable state).
const bootScript = `<script>/* mavero-wgt-boot: normalize the Tizen widget entry URL (…/index.html) to the package root before the SvelteKit router boots */
try {
  if (/\\/index\\.html$/.test(location.pathname)) {
    history.replaceState(history.state, '', location.href.replace(/index\\.html$/, ''));
  }
} catch (e) {}</script>`;

html = html.replace('<head>', `<head>${bootScript}`);
writeFileSync(target, html);
console.log('wgt_patch_shell: boot URL-normalization script injected into the built shell');
