#!/usr/bin/env node
/**
 * MAVERO — wgt SPA route preparation (BUILD_TARGET=wgt only).
 *
 * WHY THIS EXISTS
 * ===============
 * The Tizen .wgt is a static ZIP: no server runs on the TV. The web app's
 * 55 `+page.server.ts` / `+layout.server.ts` loads and 104 `+server.ts`
 * endpoints must therefore be ABSENT from the widget build — not merely
 * stubbed. Stubbing the module bodies (a vite transform) is NOT enough:
 * SvelteKit generates its route manifest from the FILES on disk, so a
 * route that HAS a `+page.server.ts` file is advertised as a
 * server-load route, and the client router requests `<url>/__data.json`
 * during hydration and SPA navigation. Inside the widget that request
 * fails (file:// origin, no server) and every navigation dies.
 *
 * Physically moving the server modules out of `src/routes` makes the
 * generated manifest a TRUE static-SPA manifest: pages with no server
 * load hydrate purely client-side, and the TV pages fetch their data
 * from the deployed production API (Stage 2 of the TV plan).
 *
 * The production (Netlify) build NEVER invokes this script — the stash
 * only happens inside the wgt packaging pipeline, between checkout and
 * `vite build`, and is restored immediately after (CI restores via a
 * bash EXIT trap even when the build fails).
 *
 * USAGE
 * =====
 *   node scripts/wgt_spa_prepare.mjs stash     # move server modules away
 *   node scripts/wgt_spa_prepare.mjs restore   # move them back
 *
 * SAFETY
 * ======
 * - Only files under src/routes matching the SvelteKit server-module
 *   naming (+page.server.*, +layout.server.*, +server.*) are touched.
 * - hooks.server.ts (outside src/routes) is NEVER touched.
 * - `stash` refuses to run twice (non-empty stash dir) so a crashed
 *   double-stash can never lose files; `restore` fails loudly if a
 *   target file already exists (conflict = manual attention needed).
 * - Everything is fs.renameSync (atomic within the repo volume).
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const WEB_ROOT = path.resolve(import.meta.dirname, '..');
const ROUTES_DIR = path.join(WEB_ROOT, 'src', 'routes');
const STASH_DIR = path.join(WEB_ROOT, '.wgt-spa-stash');
const MANIFEST = path.join(STASH_DIR, 'manifest.json');

function isServerModule(basename) {
  return (
    basename === '+server.ts' ||
    basename === '+server.js' ||
    basename.endsWith('.server.ts') ||
    basename.endsWith('.server.js')
  );
}

/** Collect every server module under src/routes (relative to WEB_ROOT). */
function collectServerModules() {
  const found = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      const st = statSync(full);
      if (st.isDirectory()) {
        walk(full);
      } else if (isServerModule(entry)) {
        found.push(path.relative(WEB_ROOT, full));
      }
    }
  };
  if (!existsSync(ROUTES_DIR)) {
    fail(`src/routes not found at ${ROUTES_DIR} — run from apps/web`);
  }
  walk(ROUTES_DIR);
  return found.sort();
}

function fail(message) {
  console.error(`wgt_spa_prepare: ERROR — ${message}`);
  process.exit(1);
}

const command = process.argv[2];

if (command === 'stash') {
  if (existsSync(STASH_DIR) && readdirSync(STASH_DIR).length > 0) {
    fail(
      `stash dir ${STASH_DIR} already exists and is non-empty. ` +
        'A previous stash never restored — run `node scripts/wgt_spa_prepare.mjs restore` first.'
    );
  }
  const modules = collectServerModules();
  if (modules.length === 0) {
    fail('no server modules found under src/routes — unexpected for this app');
  }
  for (const rel of modules) {
    const src = path.join(WEB_ROOT, rel);
    const dest = path.join(STASH_DIR, rel);
    mkdirSync(path.dirname(dest), { recursive: true });
    renameSync(src, dest);
  }
  // Post-condition: nothing matching the pattern may remain.
  const leftovers = collectServerModules();
  if (leftovers.length > 0) {
    fail(`stash incomplete — ${leftovers.length} server modules remain: ${leftovers.slice(0, 5).join(', ')}…`);
  }
  writeFileSync(MANIFEST, JSON.stringify({ stashedAt: new Date().toISOString(), modules }, null, 2) + '\n');
  console.log(`wgt_spa_prepare: stashed ${modules.length} server modules → .wgt-spa-stash/ (manifest.json written)`);
} else if (command === 'restore') {
  if (!existsSync(MANIFEST)) {
    // Nothing stashed — a clean restore of a never-stashed tree is a no-op.
    console.log('wgt_spa_prepare: no stash manifest found — nothing to restore');
    process.exit(0);
  }
  const { modules } = JSON.parse(readFileSync(MANIFEST, 'utf8'));
  for (const rel of modules) {
    const src = path.join(STASH_DIR, rel);
    const dest = path.join(WEB_ROOT, rel);
    if (!existsSync(src)) {
      fail(`stashed file missing: ${rel} — the stash was modified externally; restore manually from git`);
    }
    if (existsSync(dest)) {
      fail(`target already exists: ${rel} — refusing to overwrite (conflict)`);
    }
    mkdirSync(path.dirname(dest), { recursive: true });
    renameSync(src, dest);
  }
  rmSync(STASH_DIR, { recursive: true, force: true });
  console.log(`wgt_spa_prepare: restored ${modules.length} server modules (stash removed)`);
} else {
  fail(`unknown command "${command ?? ''}" — use "stash" or "restore"`);
}
