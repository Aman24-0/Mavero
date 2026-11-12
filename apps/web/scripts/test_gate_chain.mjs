// Task-A chain reorganization (2026-10) — single source of truth for
// reading the regression gate's composition.
//
// package.json's "test" script is now a chain of GROUP scripts
// (test:core, test:admin, test:providers, …) instead of one flat && chain
// of per-suite commands. Test-composition pins (suite registration,
// ordering, invocation conventions, absence of deleted/manual suites)
// must match against the FULLY EXPANDED per-suite chain — matching the
// group chain alone would silently weaken them.
//
// Usage (from any script/*_test.ts):
//   import { testGateCommands, testGateText } from './test_gate_chain.mjs';
//   const chainText = testGateText();          // commands joined by '\n'
//   const chainCmds = testGateCommands();      // array of commands
import { readFileSync } from 'node:fs';

const GROUP_RE = /^pnpm run (test:[\w:-]+)$/;

/** Expand the "test" gate into its full per-suite command list. */
export function testGateCommands() {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const expand = (script, depth = 0) => String(script)
    .split('&&')
    .map((c) => c.trim())
    .filter(Boolean)
    .flatMap((cmd) => {
      const m = GROUP_RE.exec(cmd);
      if (m && depth < 5 && pkg.scripts[m[1]]) return expand(pkg.scripts[m[1]], depth + 1);
      return [cmd];
    });
  return expand(pkg.scripts.test);
}

/** The expanded gate as one text blob (for `.includes()`-style pins). */
export function testGateText() {
  return testGateCommands().join('\n');
}
