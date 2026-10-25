// MAV-FOCUSED — Portable Playwright resolution helper (2026-10).
//
// The DOM QA scripts (admin_nav_dom_qa.mjs, player_sheets_dom_qa.mjs,
// etc.) need Playwright's `chromium` browser launcher. Playwright is NOT
// a project dependency in package.json — the environment provisions it
// as a global npm installation. This module provides a portable
// resolution strategy that tries multiple locations in order:
//
//   1. Project-local: `import('playwright')` — works if Playwright is
//      added as a devDependency in the future.
//   2. Global npm: `require.resolve('playwright')` — works when
//      Playwright is installed globally via `npm install -g playwright`.
//   3. NODE_PATH lookup: checks the `NODE_PATH` env var — works in
//      environments that set NODE_PATH to include the global modules.
//
// If none of these resolve, the helper throws a clear, actionable error
// with installation instructions — never a silent fallback to an
// arbitrary path.
//
// Usage:
//   import { resolvePlaywright } from './scripts/mav_resolve_playwright.mjs';
//   const { chromium } = await resolvePlaywright();

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/**
 * Resolve the Playwright module from any supported location.
 * Returns the module's exports (with `chromium`, `firefox`, `webkit`).
 *
 * @throws {Error} with installation instructions when Playwright cannot
 *   be resolved from any supported location.
 */
/**
 * Normalize the ESM-namespace produced by `await import(...)`.
 *
 * Portability defect fixed 2026-10 (PR #4 CI audit): strategies 2 and 4
 * resolve playwright to its ABSOLUTE CJS entry (index.js). Importing a
 * CJS file by path bypasses the package's `exports` map, so the returned
 * namespace only exposes the real module as `default`
 * (cjs-module-lexer cannot statically detect playwright's named exports):
 *   ns.chromium         === undefined
 *   ns.default.chromium === object
 * The GitHub runner (no /home/<user>/node_modules, no NODE_PATH) hits
 * exactly that path, and `const { chromium } = await resolvePlaywright()`
 * crashed with "Cannot read properties of undefined (reading 'launch')"
 * (CI run 39060293842, mav_task2_episode_sheet_dom_qa.mjs:295).
 * If the namespace lacks `chromium` but its `default` carries it, return
 * the default (the actual module.exports). True-ESM resolutions that
 * already expose `chromium` are returned untouched.
 */
function normalize(mod) {
  if (mod && mod.chromium) return mod;
  if (mod && mod.default && mod.default.chromium) return mod.default;
  return mod;
}

export async function resolvePlaywright() {
  // 1. Project-local import (ESM).
  try {
    return normalize(await import('playwright'));
  } catch {
    // Not installed locally — continue to fallbacks.
  }

  // 2. Global npm via require.resolve.
  try {
    const playwrightPath = require.resolve('playwright');
    return normalize(await import(playwrightPath));
  } catch {
    // Not found via require.resolve — continue.
  }

  // 3. NODE_PATH lookup (some environments set this).
  if (process.env.NODE_PATH) {
    const paths = process.env.NODE_PATH.split(':').filter(Boolean);
    for (const p of paths) {
      try {
        const candidate = require.resolve('playwright', { paths: [p] });
        return normalize(await import(candidate));
      } catch {
        // Try next path.
      }
    }
  }

  // 4. Common global installation locations (checked via require.resolve
  //    with the global path as a fallback base). This covers the
  //    /home/z/.npm-global/lib/node_modules pattern without hardcoding
  //    the specific user's home directory.
  const globalRoots = [
    // npm global root (the directory `npm root -g` returns).
    (() => { try { return require('child_process').execSync('npm root -g', { encoding: 'utf8', timeout: 2000 }).trim(); } catch { return null; } })(),
    // Common Linux/macOS global locations.
    '/usr/lib/node_modules',
    '/usr/local/lib/node_modules',
    '/opt/homebrew/lib/node_modules',
  ].filter(Boolean);

  for (const root of globalRoots) {
    try {
      const candidate = require.resolve('playwright', { paths: [root] });
      return normalize(await import(candidate));
    } catch {
      // Try next root.
    }
  }

  // All resolution attempts failed — throw with actionable instructions.
  throw new Error(
    'Playwright could not be resolved from any supported location.\n' +
    'The DOM QA scripts require Playwright to run headless Chromium.\n\n' +
    'To install Playwright:\n' +
    '  Option A (project-local, recommended): pnpm add -D playwright\n' +
    '  Option B (global): npm install -g playwright\n' +
    '  Option C (environment): set NODE_PATH to include the global modules directory\n\n' +
    'After installation, re-run the QA script.'
  );
}
