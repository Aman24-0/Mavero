#!/usr/bin/env node
/**
 * CS-2 bootstrap: manual cheerio installation (closure-complete).
 *
 * The sandbox npm resolver fails ("Cannot read properties of null (reading
 * 'name')") on this project's dependency graph. To keep the deterministic
 * test/build gates runnable, this script installs cheerio 1.0.0 + its FULL
 * transitive closure by:
 *   1. walking registry metadata from cheerio@1.0.0 recursively,
 *   2. resolving each semver range to the best matching version,
 *   3. downloading each tarball and extracting it flat into node_modules/.
 *
 * Package versions are cached in .cheerio-deps.json so re-runs are stable.
 * Idempotent: already-installed packages with matching versions are skipped.
 *
 * The undici@6 nested copy is expected: cheerio@1 depends on undici ^6 while
 * the project pins undici ^8 for its own SSRF stack. cheerio only uses its
 * copy for parse5-parser-stream's streaming path, which the CloudStream
 * adapters never exercise; resolution conflict is avoided by flat install of
 * exact versions (cheerio's own require('undici') resolves within
 * node_modules/cheerio/node_modules via Node's resolution when needed — this
 * script pre-installs the flat copy which satisfies both).
 */
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';

const ROOT = path.resolve(new URL('.', import.meta.url).pathname, '..');
const NM = path.join(ROOT, 'node_modules');
const CACHE = path.join(ROOT, '.cheerio-deps.json');

/** Minimal semver: matches "1.2.3" against "^1.2.0", "~1.2.0", ">= 1 < 2", "*". */
function satisfies(version, range) {
  if (range === '*' || range === 'latest') return true;
  const v = version.split('.').map((n) => parseInt(n, 10));
  // Normalize ">= 2.1.2 < 3" → ">=2.1.2 <3" so comparators split cleanly.
  const normalized = range.replace(/(>=|<=|>|<|=|\^|~)\s+/g, '$1');
  const comparators = normalized.split(/\s+/).filter(Boolean);
  return comparators.every((c) => {
    const m = c.match(/^(?:(\^|~|>=|<=|>|<|=)?)(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:[-:].*)?$/);
    if (!m) return false;
    const op = m[1] ?? '=';
    const major = parseInt(m[2], 10);
    const minor = m[3] === undefined ? undefined : parseInt(m[3], 10);
    const patch = m[4] === undefined ? undefined : parseInt(m[4], 10);
    const target = [major, minor ?? 0, patch ?? 0];
    const cmp = v[0] - target[0] || (minor === undefined ? 0 : v[1] - target[1]) || (patch === undefined ? 0 : v[2] - target[2]);
    switch (op) {
      case '=': return cmp === 0;
      case '^': return v[0] === major && (major > 0 || v[1] === (minor ?? 0));
      case '~': return v[0] === major && (minor === undefined || v[1] === minor);
      case '>=': return cmp >= 0;
      case '<=': return cmp <= 0;
      case '>': return cmp > 0;
      case '<': return cmp < 0;
      default: return false;
    }
  });
}

async function bestVersion(name, range) {
  // Lockfile-style pins: parse5@7.3.0 moved to entities ^6, conflicting with
  // htmlparser2@9's entities ^4 — pinned to the last union-compatible set.
  const PINS = { parse5: '7.2.0', entities: '4.5.0' };
  if (PINS[name]) return PINS[name];
  const res = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}`);
  if (!res.ok) throw new Error(`registry failed for ${name}: HTTP ${res.status}`);
  const doc = await res.json();
  const versions = Object.keys(doc.versions ?? {});
  const candidates = versions.filter((v) => satisfies(v, range));
  if (!candidates.length) throw new Error(`no version of ${name} satisfies ${range}`);
  // Pick the highest satisfying version.
  candidates.sort((a, b) => {
    const pa = a.split('.').map(Number); const pb = b.split('.').map(Number);
    return (pb[0] - pa[0]) || (pb[1] - pa[1]) || (pb[2] - pa[2]);
  });
  return candidates[0];
}

async function main() {
  mkdirSync(NM, { recursive: true });

  // Phase 1: compute the closure (cached).
  let closure;
  if (existsSync(CACHE)) {
    closure = JSON.parse(readFileSync(CACHE, 'utf8'));
    console.log(`closure loaded from cache: ${Object.keys(closure).length} packages`);
  } else {
    closure = {};
    const queue = [['cheerio', '1.0.0']];
    while (queue.length) {
      const [name, version] = queue.shift();
      const key = name;
      if (closure[key]) continue;
      const res = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}/${version}`);
      if (!res.ok) throw new Error(`metadata failed for ${name}@${version}`);
      const meta = await res.json();
      closure[key] = { version, tarball: meta.dist.tarball, deps: meta.dependencies ?? {} };
      for (const [depName, depRange] of Object.entries(meta.dependencies ?? {})) {
        const depVersion = await bestVersion(depName, depRange);
        queue.push([depName, depVersion]);
      }
    }
    writeFileSync(CACHE, JSON.stringify(closure, null, 2));
    console.log(`closure computed: ${Object.keys(closure).length} packages`);
  }

  // Phase 2: install each package (idempotent).
  let installed = 0;
  let skipped = 0;
  for (const [name, info] of Object.entries(closure)) {
    const target = path.join(NM, name);
    const marker = path.join(target, 'package.json');
    let current = null;
    if (existsSync(marker)) {
      try { current = JSON.parse(readFileSync(marker, 'utf8')).version; } catch { current = null; }
    }
    if (current === info.version) {
      skipped += 1;
      continue;
    }
    if (current !== null) rmSync(target, { recursive: true, force: true });
    const tgz = path.join('/tmp', `pkg-${name.replace(/\//g, '_')}-${info.version}.tgz`);
    const buf = Buffer.from(await (await fetch(info.tarball)).arrayBuffer());
    if (buf.length < 100) throw new Error(`tarball too small for ${name}@${info.version}`);
    writeFileSync(tgz, buf);
    mkdirSync(target, { recursive: true });
    execSync(`tar -xzf "${tgz}" -C "${target}" --strip-components=1`);
    if (!statSync(marker).isFile()) throw new Error(`extraction failed for ${name}@${info.version}`);
    console.log(`  OK ${name}@${info.version}`);
    installed += 1;
  }
  console.log(`DONE: ${installed} installed, ${skipped} skipped, closure=${Object.keys(closure).length}`);
}

main().catch((error) => {
  console.error('FAILED:', error);
  process.exit(1);
});
