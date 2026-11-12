// MAVERO — Node ESM loader hook for hosting regression tests.
//
// The SvelteKit virtual modules `$env/dynamic/private` and
// `$env/dynamic/public` only resolve inside a SvelteKit runtime. The
// SvelteKit path aliases `$lib`, `$lib/*`, `$components`, `$data`,
// `$styles` only resolve through tsconfig paths (which tsx does not
// honor for runtime imports outside the SvelteKit build).
//
// The hosting regression tests dynamically import the real adapter /
// service modules (e.g. `await import('../src/lib/server/hosting/control/service')`)
// which transitively import `$env/dynamic/private` (for the Vidara/Abyss
// API keys) and `$lib/*` (for shared types/helpers). Outside a SvelteKit
// runtime, Node throws `ERR_MODULE_NOT_FOUND: Cannot find package '$env'`
// or `Cannot find package '$lib'`.
//
// This loader intercepts:
//   * `$env/dynamic/private` + `$env/dynamic/public` → stub to process.env.
//   * `$lib/*`, `$components/*`, `$data/*`, `$styles/*` → remap to
//     `src/lib/*`, `src/lib/components/*`, `src/lib/data/*`,
//     `src/lib/styles/*` under the repo root.
//
// Usage:
//   NODE_OPTIONS="--import tsx --import ./scripts/mav_hosting_test_loader.mjs" \
//     node scripts/<test>.ts
//
// (tsx respects --import for its own register hook chain.)

import { fileURLToPath } from 'node:url';
import { dirname, resolve as pathResolve } from 'node:path';

const DYNAMIC_PRIVATE_SPEC = '$env/dynamic/private';
const DYNAMIC_PUBLIC_SPEC = '$env/dynamic/public';

// Repo root = the directory that contains scripts/ + src/.
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = pathResolve(__dirname, '..');

const envStubSource = `
// The stub exposes \`env\` as a Proxy over process.env so reads of any
// env var return the current value (tests may set env vars AFTER the
// module is imported). Writes go to process.env too.
export const env = new Proxy({}, {
  get(_target, prop) {
    if (typeof prop !== 'string') return undefined;
    return process.env[prop];
  },
  ownKeys() {
    return Reflect.ownKeys(process.env);
  },
  getOwnPropertyDescriptor(_target, prop) {
    if (typeof prop !== 'string' || !(prop in process.env)) return undefined;
    return { enumerable: true, configurable: true, value: process.env[prop], writable: true };
  },
  has(_target, prop) {
    if (typeof prop !== 'string') return false;
    return prop in process.env;
  },
});
`;

// Map SvelteKit path aliases to their on-disk locations under REPO_ROOT.
const ALIAS_MAP = [
  { prefix: '$lib/', resolve: (rest) => pathResolve(REPO_ROOT, 'src/lib', rest) },
  { prefix: '$components/', resolve: (rest) => pathResolve(REPO_ROOT, 'src/lib/components', rest) },
  { prefix: '$data/', resolve: (rest) => pathResolve(REPO_ROOT, 'src/lib/data', rest) },
  { prefix: '$styles/', resolve: (rest) => pathResolve(REPO_ROOT, 'src/lib/styles', rest) },
  // Bare aliases (no trailing slash) — match exactly.
  { prefix: '$lib', exact: true, resolve: () => pathResolve(REPO_ROOT, 'src/lib') },
  { prefix: '$components', exact: true, resolve: () => pathResolve(REPO_ROOT, 'src/lib/components') },
  { prefix: '$data', exact: true, resolve: () => pathResolve(REPO_ROOT, 'src/lib/data') },
  { prefix: '$styles', exact: true, resolve: () => pathResolve(REPO_ROOT, 'src/lib/styles') },
];

function resolveAlias(specifier) {
  for (const alias of ALIAS_MAP) {
    if (alias.exact) {
      if (specifier === alias.prefix) return alias.resolve();
      continue;
    }
    if (specifier.startsWith(alias.prefix)) {
      const rest = specifier.slice(alias.prefix.length);
      return alias.resolve(rest);
    }
  }
  return null;
}

export async function resolve(specifier, context, nextResolve) {
  if (specifier === DYNAMIC_PRIVATE_SPEC || specifier === DYNAMIC_PUBLIC_SPEC) {
    return {
      url: `data:text/javascript,${encodeURIComponent(envStubSource)}`,
      shortCircuit: true,
    };
  }
  const aliasTarget = resolveAlias(specifier);
  if (aliasTarget) {
    // Re-resolve the on-disk path through Node's default resolver so the
    // file extension + index resolution works (e.g. `$lib/server/hosting/errors`
    // → `.../errors.ts` or `.../errors/index.ts`).
    return nextResolve(aliasTarget, { ...context, skipSelf: true });
  }
  return nextResolve(specifier, context);
}

