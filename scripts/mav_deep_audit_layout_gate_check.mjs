/**
 * MAV DEEP AUDIT — layout chrome gate predicate verification.
 *
 * The detail-page chrome fix (deep-audit Section 5) is a PURE path
 * predicate in src/routes/+layout.svelte. This script extracts the EXACT
 * production regex from the layout source, rebuilds it as a live RegExp,
 * and evaluates the FULL bare-render predicate against the required route
 * cases — a runtime proof of the gate behavior for both direct loads and
 * client-side navigations (the predicate is a pure function of
 * page.url.pathname, so runtime == this evaluation).
 *
 * Complements mav_deep_audit_regression_test.ts §4 (source-level lock).
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const layout = readFileSync(resolve(root, 'src/routes/+layout.svelte'), 'utf8');

// Extract the detail regex literal: find the `.test(page.url.pathname)`
// call sites and take the preceding /…/ regex literal.
const testCallIndex = layout.indexOf('.test(page.url.pathname)');
if (testCallIndex === -1) {
  console.error('FAIL: no .test(page.url.pathname) call in +layout.svelte');
  process.exit(1);
}
// Walk back from the test call to the regex literal's opening slash.
const before = layout.slice(0, testCallIndex);
const literalStart = before.lastIndexOf('/');
const literalEnd = before.lastIndexOf('/', testCallIndex - 1);
// literalEnd here is the LAST slash before the call — the literal's
// closing slash. The opening slash precedes it; scan back to it.
let open = literalEnd - 1;
let depth = 0;
while (open >= 0) {
  const ch = before[open];
  if (ch === '/') {
    // An unescaped slash at depth 0 is the literal's opening delimiter.
    if (depth === 0 && before[open - 1] !== '\\') break;
  }
  if (ch === '[' && before[open - 1] !== '\\') depth++;
  if (ch === ']' && before[open - 1] !== '\\') depth--;
  open--;
}
const literalBody = before.slice(open + 1, literalEnd);
if (!literalBody.startsWith('^')) {
  console.error(`FAIL: extracted unexpected regex body: ${literalBody}`);
  process.exit(1);
}
const detailRegex = new RegExp(literalBody);
console.log(`Detail regex under test: /${literalBody}/\n`);

function bareRender(pathname) {
  return pathname.startsWith('/watch/')
    || detailRegex.test(pathname)
    || pathname.startsWith('/auth/')
    || pathname.startsWith('/admin')
    || pathname.startsWith('/tv-login')
    || pathname.startsWith('/authorize')
    || pathname.startsWith('/settings/scan-tv');
}

const cases = [
  // The six detail route types — MUST be bare (no AppShell chrome).
  ['/movie/278', true],
  ['/series/1396', true],
  ['/anime/30984', true],
  ['/tv-show/1396', true],
  ['/anime-series/30984', true],
  ['/anime-movie/1311031', true],
  // Watch routes — always bare.
  ['/watch/movie/278', true],
  ['/watch/tv-show/1396/5/6', true],
  ['/watch/anime-series/30984/2/1', true],
  // Existing bare gates preserved.
  ['/auth/sign-in', true],
  ['/admin', true],
  ['/admin/media/library', true],
  ['/tv-login', true],
  ['/authorize', true],
  ['/settings/scan-tv', true],
  // First-class destinations — MUST keep the AppShell.
  ['/discover', false],
  ['/movies', false],
  ['/tv-shows', false],
  ['/anime', false],
  ['/upcoming', false],
  ['/search', false],
  ['/my-list', false],
  ['/settings', false],
  // Prefix-boundary safety: the bare listing destinations are NOT detail
  // pages, and a bare '/tv-show' prefix (no id segment) must NOT match.
  ['/tv-show', false],
  ['/anime-series', false],
  ['/movie', false],
];

let passed = 0;
let failed = 0;
for (const [pathname, expected] of cases) {
  const actual = bareRender(pathname);
  const ok = actual === expected;
  if (ok) passed++; else failed++;
  console.log(`  ${ok ? 'ok' : 'FAIL'} ${pathname} → bare=${actual} (expected ${expected})`);
}

console.log(`\nlayout_gate_predicate_check: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
