import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * Phase 2-N — Dependency / repository hygiene.
 *
 * Two related findings from the audit:
 *
 *   1. The root package.json claimed `"node": ">=20.0.0"` but the
 *      repository's actual supported floor is Node 22 — Netlify pins
 *      NODE_VERSION=22, CI uses node-version: 22, and the media-worker
 *      subpackage requires `engines.node >=22.19`. Claiming Node 20
 *      support when the deployment + media-worker don't actually support
 *      it is misleading.
 *
 *   2. The project is pnpm-based (pnpm-lock.yaml is the active lockfile),
 *      but a stale package-lock.json (npm-format) was committed and not
 *      maintained — it hadn't been updated in many commits while
 *      pnpm-lock.yaml was kept current. The stale lockfile could confuse
 *      npm install users and drift further from pnpm-lock.yaml.
 */

let passed = 0;
function ok(condition: unknown, label: string) {
  assert.ok(condition, label);
  passed += 1;
  console.log(`  ok ${passed} - ${label}`);
}

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative: string) => readFileSync(path.join(REPO_ROOT, relative), 'utf8');

// ============================================================
// 1. Root package.json engines.node aligned with the actual supported floor.
// ============================================================
const rootPkg = JSON.parse(read('package.json'));
ok(rootPkg.engines && typeof rootPkg.engines.node === 'string', '1a. root package.json has engines.node');
ok(rootPkg.engines.node.startsWith('>=22.'), `1b. root engines.node is >=22.x (got ${rootPkg.engines.node})`);
ok(!rootPkg.engines.node.startsWith('>=20.'), '1c. root engines.node no longer claims Node 20 support');

// ============================================================
// 2. Netlify, CI, and media-worker all require Node 22 (consistent).
// ============================================================
const netlify = read('netlify.toml');
ok(/NODE_VERSION\s*=\s*"22"/.test(netlify), '2a. netlify.toml pins NODE_VERSION=22');

const ci = read('.github/workflows/ci.yml');
ok(/node-version:\s*22/.test(ci), '2b. CI workflow uses node-version: 22');

const mediaWorkerPkg = JSON.parse(read('apps/media-worker/package.json'));
ok(mediaWorkerPkg.engines && mediaWorkerPkg.engines.node.startsWith('>=22.'), `2c. media-worker engines.node is >=22.x (got ${mediaWorkerPkg.engines.node})`);

// ============================================================
// 3. README.md consistent with the actual supported floor.
// ============================================================
const readme = read('README.md');
ok(/Node\.js 22 or newer/.test(readme), '3a. README.md says "Node.js 22 or newer"');
ok(!/Node\.js 20 or newer/.test(readme), '3b. README.md no longer claims "Node.js 20 or newer"');

// DEPLOYMENT.md already said Node 22 (no change needed).
const deployment = read('DEPLOYMENT.md');
ok(/Node\.js 22 or newer/.test(deployment), '3c. DEPLOYMENT.md still says "Node.js 22 or newer" (already correct)');

// ============================================================
// 4. Stale package-lock.json removed.
// ============================================================
ok(!existsSync(path.join(REPO_ROOT, 'package-lock.json')), '4a. package-lock.json removed (stale npm-format lockfile)');

// pnpm-lock.yaml is preserved (the active lockfile).
ok(existsSync(path.join(REPO_ROOT, 'pnpm-lock.yaml')), '4b. pnpm-lock.yaml preserved (the active lockfile)');

// ============================================================
// 5. .gitignore excludes package-lock.json so it can't drift back in.
// ============================================================
const gitignore = read('.gitignore');
ok(/^package-lock\.json$/m.test(gitignore), '5a. .gitignore has a package-lock.json rule');
ok(/Phase 2-N/.test(gitignore), '5b. .gitignore annotates the rule with Phase 2-N comment');

// ============================================================
// 6. CI workflow still pins pnpm 10.30.3 (the packageManager pin).
// ============================================================
ok(/pnpm@10\.30\.3/.test(read('package.json')), '6a. root package.json packageManager pin is pnpm@10.30.3');
ok(/pnpm 10\.30\.3/.test(ci), '6b. CI workflow enforces pnpm 10.30.3');
ok(/10\.30\.3/.test(ci), '6c. CI verifies the pinned pnpm version');

console.log(`phase2_repo_hygiene_test: ${passed} checks passed (Phase 2-N Node engine + lockfile hygiene)`);
