/**
 * Phase 3 3-E (repository-cleanup plan §5 group 3-E) — stub-context pin.
 *
 * The Phase 0 audit flagged the three stub directories (env-stubs / stubs /
 * executor-shims) as "overlapping". The fresh 3-E evidence sweep proved the
 * opposite: the same-named stubs are DELIBERATELY DIFFERENT implementations
 * for different resolution contexts (svelte-check/tsx surface, hermetic
 * behavioral runs, production executor bundle). Physical consolidation was
 * REJECTED on that evidence (audit §8 marks all three load-bearing); the
 * consolidation delivered is the mapping table in
 * `scripts/env-stubs/README.md` plus THIS pin, which freezes:
 *
 *   §1  the three `$env/dynamic/private` semantics stay distinct
 *       (behavioral = empty, executor = process.env, env-stubs = mirror +
 *       injection merge) — a "dedup" that merged any two would fail here;
 *   §2  the two `$app/environment` variants stay distinct
 *       (behavioral `version = 'test-stub'`, jsconfig `version = ''`);
 *   §3  every tsconfig/script mapping in the table points at a file that
 *       EXISTS (catches a stub move that forgot its consumers).
 *
 * Deterministic: constant imports + config-file reads only.
 */

import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// NOTE: the three $env/dynamic/private implementations are imported by
// RELATIVE path (not the alias) on purpose — the pin must load the concrete
// files, not whatever the runner's tsconfig maps the alias to.
import { env as BEHAVIORAL_ENV } from './stubs/env-dynamic-private.ts';
import { env as EXECUTOR_ENV } from './executor-shims/env-dynamic-private.ts';
import { env as GENERAL_ENV } from './env-stubs/dynamic-private.ts';
import { version as BEHAVIORAL_VERSION } from './stubs/app-environment.ts';
import { version as GENERAL_VERSION } from './env-stubs/app-environment.ts';

let checks = 0;
function ok(condition: boolean, label: string) {
  assert.ok(condition, label);
  checks += 1;
}

// --- §1 three distinct $env/dynamic/private semantics ------------------------

ok(Object.keys(BEHAVIORAL_ENV).length === 0, '§1: behavioral stub env is EMPTY (hermetic — no host leakage)');
ok(EXECUTOR_ENV === process.env, '§1: executor shim env IS process.env (production function semantics)');
ok(GENERAL_ENV !== process.env && Object.prototype.isPrototypeOf.call(Object.prototype, GENERAL_ENV),
  '§1: env-stubs env is a snapshot object (mirrors process.env at import time, not a reference)');
// The injection merge: the upcoming-pipeline suites deliver their fake TMDB
// token through globalThis.__MAVERO_UPCOMING_TEST_ENV__ (read at import).
// Without the injection key present the mirror still equals process.env:
ok(
  Object.entries(process.env).every(([k, v]) => GENERAL_ENV[k] === v),
  '§1: env-stubs env mirrors every process.env entry (injection merge preserves the mirror semantics)',
);

// --- §2 two distinct $app/environment variants -------------------------------

ok(BEHAVIORAL_VERSION === 'test-stub', "§2: behavioral app-environment version is 'test-stub'");
ok(GENERAL_VERSION === '', '§2: jsconfig app-environment version is the empty string (production posture)');

// --- §3 every documented mapping target exists -------------------------------

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAPPING_TARGETS: Array<{ config: string; file: string }> = [
  { config: 'jsconfig.json', file: 'scripts/env-stubs/dynamic-private.ts' },
  { config: 'jsconfig.json', file: 'scripts/env-stubs/dynamic-public.ts' },
  { config: 'jsconfig.json', file: 'scripts/env-stubs/app-environment.ts' },
  { config: 'jsconfig.json', file: 'scripts/env-stubs/app-navigation.ts' },
  { config: 'jsconfig.json', file: 'scripts/env-stubs/app-forms.ts' },
  { config: 'tsconfig.behavioral.json', file: 'scripts/stubs/env-dynamic-private.ts' },
  { config: 'tsconfig.behavioral.json', file: 'scripts/stubs/app-environment.ts' },
];

for (const { config, file } of MAPPING_TARGETS) {
  const configSrc = readFileSync(path.join(REPO_ROOT, config), 'utf8');
  ok(configSrc.includes(file.replace('scripts/', '')) || configSrc.includes(file),
    `§3: ${config} still maps to ${file}`);
  ok(existsSync(path.join(REPO_ROOT, file)), `§3: mapping target exists: ${file}`);
}

const buildExecutor = readFileSync(path.join(REPO_ROOT, 'scripts/build_executor_function.mjs'), 'utf8');
ok(buildExecutor.includes("path.join(repoRoot, 'scripts', 'executor-shims', 'env-dynamic-private.ts')"),
  '§3: build_executor_function.mjs still aliases $env/dynamic/private to the executor shim');
ok(existsSync(path.join(REPO_ROOT, 'scripts/executor-shims/env-dynamic-private.ts')),
  '§3: executor shim file exists');

console.log(`ok - stub_contexts: ${checks} checks passed (three distinct stub contexts + mapping table intact)`);
if (checks !== 22) {
  throw new Error(`expected 22 checks, saw ${checks}`);
}
