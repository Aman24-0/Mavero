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

import { chromium } from '/home/z/.npm-global/lib/node_modules/playwright/index.mjs';
import { execSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const distDir = '/tmp/mavero-admin-nav-qa-dist';

// Build a minimal Vite harness that imports AdminAppShell + renders it.
const harnessDir = resolve(root, 'scripts/harness-admin-nav');
mkdirSync(harnessDir, { recursive: true });
mkdirSync(distDir, { recursive: true });

// The harness HTML.
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

// The harness entry — mount AdminAppShell with a snippet child.
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

// Vite config for the harness build.
writeFileSync(resolve(harnessDir, 'vite.config.mjs'), `
import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { resolve } from 'path';

const harnessDir = '${harnessDir}';

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
    outDir: '${distDir}',
    emptyOutDir: true,
  },
});
`);

// Stub for $app/state (page.url).
mkdirSync(resolve(harnessDir, 'stubs'), { recursive: true });
writeFileSync(resolve(harnessDir, 'stubs/app-state.ts'), `
export const page = {
  url: new URL('http://localhost/admin'),
};
`);

// Stub for $app/forms (enhance + applyAction).
writeFileSync(resolve(harnessDir, 'stubs/app-forms.ts'), `
export function enhance() { return () => {}; }
export function applyAction() { return Promise.resolve(); }
`);

// Stub for $app/navigation.
writeFileSync(resolve(harnessDir, 'stubs/app-navigation.ts'), `
export function goto() {}
export function invalidate() { return Promise.resolve(); }
export function invalidateAll() { return Promise.resolve(); }
export function preloadData() {}
export function beforeNavigate() {}
export function afterNavigate() {}
export function onNavigate() {}
`);

// Stub for $app/environment.
writeFileSync(resolve(harnessDir, 'stubs/app-environment.ts'), `
export const browser = true;
`);

// Build.
console.log('Building admin nav harness…');
try {
  execSync(`./node_modules/.bin/vite build --config ${resolve(harnessDir, 'vite.config.mjs')}`, {
    cwd: root,
    stdio: 'pipe',
    timeout: 60000,
  });
} catch (err) {
  console.error('Vite build failed:', err.stderr?.toString() ?? err.message);
  process.exit(1);
}

// Playwright smoke test.
const browser = await chromium.launch();
let passed = 0;
let failed = 0;
function ok(condition, label) {
  if (condition) { passed += 1; console.log(`  ok ${passed} - ${label}`); }
  else { failed += 1; console.log(`  FAIL - ${label}`); }
}

// Serve the built files over HTTP (file:// is blocked by CORS for
// module scripts). Use a simple inline HTTP server.
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { extname } from 'node:path';

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
};

const httpServer = createServer((req, res) => {
  let filePath = req.url === '/' ? '/index.html' : req.url;
  const fullPath = resolve(distDir, filePath.slice(1));
  if (!existsSync(fullPath)) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }
  const mime = MIME[extname(fullPath)] ?? 'application/octet-stream';
  res.writeHead(200, { 'content-type': mime });
  res.end(readFileSync(fullPath));
});
await new Promise((r) => httpServer.listen(0, r));
const httpPort = httpServer.address().port;
const baseUrl = `http://localhost:${httpPort}`;

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

  // No More sheet overlay/sheet in the DOM.
  const moreSheet = await page.evaluate(() => document.querySelector('.a2-more-sheet'));
  ok(moreSheet === null, '2h. no .a2-more-sheet in the DOM');
  const moreOverlay = await page.evaluate(() => document.querySelector('.a2-more-overlay'));
  ok(moreOverlay === null, '2i. no .a2-more-overlay in the DOM');

  await page.close();
}

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

await browser.close();
console.log(`\nadmin_nav_dom_qa: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
