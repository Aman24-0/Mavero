// MAV-FOCUSED — Admin navigation DOM smoke test (2026-10).
//
// Builds a minimal Vite harness that mounts AdminAppShell in isolation
// and verifies the mobile bottom-nav has NO "More" item + the desktop
// sidebar carries every route. Does NOT require Supabase auth or a DB
// — AdminAppShell is a pure UI component (navGroups + mobileNav are
// hardcoded constants, not server-loaded).
//
// Uses Playwright + the project's Vite build (same pattern as
// scripts/player_sheets_dom_qa.mjs).
//
// PORTABILITY (MAV-FOCUSED fix, 2026-10): Playwright is resolved
// through the shared mav_resolve_playwright.mjs helper — no hardcoded
// machine-specific paths. Generated harness files + build output are
// cleaned up in a try/finally block even when assertions fail. The HTTP
// server binds to 127.0.0.1 on an ephemeral port and rejects path-
// traversal attempts.

import { resolvePlaywright } from './mav_resolve_playwright.mjs';
import { execSync } from 'node:child_process';
import { resolve, dirname, join, normalize, sep, extname } from 'node:path';
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Generated artifacts — cleaned up in the finally block.
const harnessDir = resolve(root, 'scripts/harness-admin-nav');
const distDir = resolve(root, '.cache/admin-nav-qa-dist');

let browser = null;
let httpServer = null;
let passed = 0;
let failed = 0;

function ok(condition, label) {
  if (condition) { passed += 1; console.log(`  ok ${passed} - ${label}`); }
  else { failed += 1; console.log(`  FAIL - ${label}`); }
}

function cleanupArtifacts() {
  // Remove ONLY the generated harness directory and build output.
  // Never touch unrelated files.
  try { rmSync(harnessDir, { recursive: true, force: true }); } catch { /* already gone */ }
  try { rmSync(distDir, { recursive: true, force: true }); } catch { /* already gone */ }
}

async function main() {
  // --- Resolve Playwright ---
  const { chromium } = await resolvePlaywright();

  // --- Generate harness files ---
  mkdirSync(harnessDir, { recursive: true });
  mkdirSync(resolve(harnessDir, 'stubs'), { recursive: true });
  mkdirSync(distDir, { recursive: true });

  writeFileSync(resolve(harnessDir, 'index.html'), `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Admin Nav QA</title>
</head>
<body>
  <div id="app"></div>
  <script type="module" src="./main.ts"></script>
</body>
</html>
`);

  writeFileSync(resolve(harnessDir, 'main.ts'), `
import { mount } from 'svelte';
import AdminAppShell from '../../src/lib/components/admin2/AdminAppShell.svelte';

const target = document.getElementById('app')!;
mount(AdminAppShell, {
  target,
  props: {
    children: () => '<div style="padding:20px;">QA content</div>',
  },
});
`);

  // Vite config — uses absolute paths injected via template strings.
  // The harnessDir is under the repo's scripts/ directory (gitignored
  // by the .gitignore pattern for scripts/harness-*).
  writeFileSync(resolve(harnessDir, 'vite.config.mjs'), `
import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { resolve } from 'path';

const harnessDir = ${JSON.stringify(harnessDir)};

export default defineConfig({
  root: harnessDir,
  plugins: [svelte()],
  resolve: {
    alias: {
      '$lib': resolve(harnessDir, '../../src/lib'),
      '$components': resolve(harnessDir, '../../src/lib/components'),
      '$app/state': resolve(harnessDir, './stubs/app-state.ts'),
      '$app/forms': resolve(harnessDir, './stubs/app-forms.ts'),
      '$app/navigation': resolve(harnessDir, './stubs/app-navigation.ts'),
      '$app/environment': resolve(harnessDir, './stubs/app-environment.ts'),
    },
  },
  build: {
    outDir: ${JSON.stringify(distDir)},
    emptyOutDir: true,
  },
});
`);

  writeFileSync(resolve(harnessDir, 'stubs/app-state.ts'), `
export const page = {
  url: new URL('http://localhost/admin'),
};
`);

  writeFileSync(resolve(harnessDir, 'stubs/app-forms.ts'), `
export function enhance() { return () => {}; }
export function applyAction() { return Promise.resolve(); }
`);

  writeFileSync(resolve(harnessDir, 'stubs/app-navigation.ts'), `
export function goto() {}
export function invalidate() { return Promise.resolve(); }
export function invalidateAll() { return Promise.resolve(); }
export function preloadData() {}
export function beforeNavigate() {}
export function afterNavigate() {}
export function onNavigate() {}
`);

  writeFileSync(resolve(harnessDir, 'stubs/app-environment.ts'), `
export const browser = true;
`);

  // --- Build ---
  console.log('Building admin nav harness…');
  execSync(`./node_modules/.bin/vite build --config ${resolve(harnessDir, 'vite.config.mjs')}`, {
    cwd: root,
    stdio: 'pipe',
    timeout: 60000,
  });

  // --- Launch browser ---
  browser = await chromium.launch();

  // --- HTTP server (loopback, ephemeral port, path-traversal-safe) ---
  const MIME = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.svg': 'image/svg+xml',
  };

  httpServer = createServer((req, res) => {
    // Strip query string + decode.
    const urlPath = decodeURIComponent((req.url ?? '/').split('?')[0]);
    // Normalize to prevent path traversal (e.g. /../../etc/passwd).
    const requestedPath = normalize(join(distDir, urlPath === '/' ? 'index.html' : urlPath));
    // Verify the resolved path is still within distDir.
    if (!requestedPath.startsWith(distDir + sep)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }
    if (!existsSync(requestedPath)) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    const mime = MIME[extname(requestedPath)] ?? 'application/octet-stream';
    res.writeHead(200, { 'content-type': mime });
    res.end(readFileSync(requestedPath));
  });

  await new Promise((r) => httpServer.listen(0, '127.0.0.1', r));
  const baseUrl = `http://127.0.0.1:${httpServer.address().port}`;

  // --- §1: Desktop sidebar carries every route ---
  console.log('\n§1 — Desktop sidebar carries every route');
  {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(`${baseUrl}/`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(200);

    const sidebarLinks = await page.evaluate(() => {
      return [...document.querySelectorAll('.a2-sidebar a[href]')].map((a) => a.getAttribute('href'));
    });
    ok(sidebarLinks.includes('/admin'), '1a. sidebar includes Overview (/admin)');
    ok(sidebarLinks.includes('/admin/media/library'), '1b. sidebar includes Media Library');
    ok(sidebarLinks.includes('/admin/media/missing'), '1c. sidebar includes Missing Media');
    ok(sidebarLinks.includes('/admin/hosting'), '1d. sidebar includes Hosting Control');
    ok(sidebarLinks.includes('/admin/system/api-sources'), '1e. sidebar includes API & Sources');
    ok(sidebarLinks.includes('/admin/system/content-rules'), '1f. sidebar includes Content Rules');
    ok(sidebarLinks.includes('/admin/system/downloads'), '1g. sidebar includes Downloads');
    ok(sidebarLinks.includes('/admin/system/integrations'), '1h. sidebar includes Integrations');
    ok(sidebarLinks.includes('/admin/analytics'), '1i. sidebar includes Analytics');
    await page.close();
  }

  // --- §2: Mobile bottom-nav has NO "More" item ---
  console.log('\n§2 — Mobile bottom-nav has NO "More" item');
  {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.goto(`${baseUrl}/`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(200);

    const bottomNavItems = await page.evaluate(() => {
      return [...document.querySelectorAll('.a2-bottom-nav .a2-bottom-item')].map((el) => ({
        label: el.querySelector('.a2-bottom-label')?.textContent?.trim() ?? '',
        href: el.getAttribute('href') ?? '',
        tagName: el.tagName.toLowerCase(),
      }));
    });
    ok(bottomNavItems.length === 4, `2a. bottom-nav has exactly 4 items — got ${bottomNavItems.length}`);
    ok(!bottomNavItems.some((i) => i.label.toLowerCase() === 'more'), '2b. no item labelled "More"');
    ok(!bottomNavItems.some((i) => i.href === '#more'), '2c. no item with href="#more"');
    ok(bottomNavItems.some((i) => i.label === 'Home'), '2d. Home item present');
    ok(bottomNavItems.some((i) => i.label === 'Media'), '2e. Media item present');
    ok(bottomNavItems.some((i) => i.label === 'Hosting'), '2f. Hosting item present');
    ok(bottomNavItems.some((i) => i.label === 'Analytics'), '2g. Analytics item present');

    const moreSheet = await page.evaluate(() => document.querySelector('.a2-more-sheet'));
    ok(moreSheet === null, '2h. no .a2-more-sheet in the DOM');
    const moreOverlay = await page.evaluate(() => document.querySelector('.a2-more-overlay'));
    ok(moreOverlay === null, '2i. no .a2-more-overlay in the DOM');

    await page.close();
  }

  // --- §3: Command palette (⌘K) still works ---
  console.log('\n§3 — Command palette (⌘K) still works');
  {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(`${baseUrl}/`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(200);

    await page.keyboard.down('Meta');
    await page.keyboard.press('k');
    await page.keyboard.up('Meta');
    await page.waitForTimeout(200);

    const commandOpen = await page.evaluate(() => {
      const dialog = document.querySelector('[role="dialog"]');
      return dialog !== null;
    });
    ok(commandOpen, '3a. ⌘K opens a dialog (command palette)');

    await page.close();
  }
}

try {
  await main();
} finally {
  // Deterministic cleanup — runs even on assertion failure or build error.
  if (browser) {
    try { await browser.close(); } catch { /* already closed */ }
  }
  if (httpServer) {
    try { httpServer.close(); } catch { /* already closed */ }
  }
  cleanupArtifacts();
}

console.log(`\nadmin_nav_dom_qa: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
