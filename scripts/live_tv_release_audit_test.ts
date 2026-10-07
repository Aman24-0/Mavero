// MAVERO — LT-6 Final Release Audit: focused release-invariant suite.
//
// Locks the invariants decided/verified during the LT-6 release audit so
// they cannot silently regress after release:
//   * §1  Test-chain integration (the LT-6 decision): the four Live TV
//         focused suites + THIS suite are part of `pnpm test`
//   * §2  VOD boundary lock: media-compat still maps VOD DASH →
//         UNSUPPORTED (Live TV never retrofitted DASH into the VOD player)
//   * §3  Shaka isolation: 'shaka' appears ONLY inside Live TV-owned
//         paths (client/live-tv, components/live-tv, routes/live-tv)
//   * §4  LiveGT isolation: the LiveGT hostname lives ONLY in the LT-2
//         client (single base-URL source; no server/proxy code touches it)
//   * §5  Migration invariants: the LT-5 analytics taxonomy migration
//         exists, carries the 7 live_tv events, and creates NO tables
//   * §6  Shaka loading stays dynamic-only in the engine source (the
//         browser-guarded loader is load-bearing for SSR safety)
//
// NO network, browser, DRM or Shaka package is involved.

import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';

let passed = 0;
function ok(label: string): void {
  passed++;
  console.log(`  ok ${passed} - ${label}`);
}

const read = (p: string): string => readFileSync(new URL(p, import.meta.url), 'utf8');
const packageJson = JSON.parse(read('../package.json')) as { scripts: { test: string } };
const testChain = packageJson.scripts.test;

// ============================================================
// §1 Test-chain integration (the LT-6 chaining decision)
// ============================================================
{
  const chained = [
    'scripts/live_tv_client_test.ts', // LT-2
    'scripts/live_tv_player_test.ts', // LT-3
    'scripts/live_tv_page_test.ts', // LT-4
    'scripts/live_tv_hardening_test.ts', // LT-5
    'scripts/live_tv_release_audit_test.ts' // LT-6 (this suite)
  ];
  for (const script of chained) {
    assert.ok(testChain.includes(script), `${script} is chained into pnpm test`);
  }
  // They are invoked with the repo-standard tsx + jsconfig convention.
  for (const script of chained) {
    assert.ok(
      testChain.includes(`pnpm exec tsx --tsconfig ./jsconfig.json ${script}`),
      `${script} uses the standard tsx invocation`
    );
  }
  // The real-browser/manual QA probes are NOT in the chain (brief §16).
  for (const manual of ['lt5_census.ts', 'lt5_151_variance.ts']) {
    assert.ok(!testChain.includes(manual), `${manual} (network probe) must never be chained`);
  }
  ok('all five Live TV suites are chained into pnpm test; network probes are not');
}

// ============================================================
// §2 VOD boundary lock — VOD DASH remains UNSUPPORTED
// ============================================================
{
  const mediaCompat = read('../src/lib/shared/media-compat.ts');
  assert.match(
    mediaCompat,
    /if \(protocol === 'dash'\) return \{ tier: 'UNSUPPORTED', action: 'none', reason: 'dash-unsupported' \};/,
    'media-compat still maps VOD DASH to UNSUPPORTED'
  );
  ok('VOD boundary: the VOD player still refuses DASH (Live TV owns the only DASH path)');
}

// ============================================================
// §3 Shaka isolation — 'shaka' only inside Live TV paths
// ============================================================
{
  // Prefixes RELATIVE TO src/ (the walk computes src-relative paths).
  const LIVE_TV_DIRS = ['lib/client/live-tv', 'lib/components/live-tv', 'routes/live-tv'];
  const SRC_ROOT = new URL('../src', import.meta.url).pathname;
  const files: string[] = [];
  const collect = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) collect(full);
      else if (/\.(ts|svelte|js)$/.test(entry)) files.push(full);
    }
  };
  collect(SRC_ROOT);
  const offenders: string[] = [];
  for (const file of files) {
    const rel = relative(SRC_ROOT, file).replaceAll('\\', '/');
    if (LIVE_TV_DIRS.some((d) => rel.startsWith(d + '/'))) continue;
    if (readFileSync(file, 'utf8').toLowerCase().includes('shaka')) offenders.push(rel);
  }
  assert.deepEqual(offenders, [], 'no file outside Live TV paths mentions Shaka');
  ok('Shaka isolation: zero shaka references outside Live TV (VOD/HLS/server untouched)');
}

// ============================================================
// §4 LiveGT isolation — hostname only in the LT-2 client
// ============================================================
{
  const SRC_ROOT = new URL('../src', import.meta.url).pathname;
  const files: string[] = [];
  const collect = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) collect(full);
      else if (/\.(ts|svelte|js)$/.test(entry)) files.push(full);
    }
  };
  collect(SRC_ROOT);
  const offenders: string[] = [];
  for (const file of files) {
    const rel = relative(SRC_ROOT, file).replaceAll('\\', '/');
    if (rel === 'lib/client/live-tv/api.ts') continue;
    if (readFileSync(file, 'utf8').toLowerCase().includes('livetgtv')) offenders.push(rel);
  }
  assert.deepEqual(offenders, [], 'livetgtv appears only in api.ts');
  ok('LiveGT isolation: the LiveGT hostname exists only in the LT-2 client (no proxy/server surface)');
}

// ============================================================
// §5 Migration invariants — taxonomy extension only
// ============================================================
{
  const migrationPath = new URL('../supabase/migrations/20261103000000_live_tv_analytics_events.sql', import.meta.url);
  assert.ok(existsSync(migrationPath), 'the LT-5 analytics migration exists');
  const sql = readFileSync(migrationPath, 'utf8');
  for (const event of [
    'live_tv_open',
    'live_tv_channel_select',
    'live_tv_channel_switch',
    'live_tv_play',
    'live_tv_pause',
    'live_tv_error',
    'live_tv_fullscreen'
  ]) {
    assert.ok(sql.includes(`'${event}'`), `${event} in the CHECK constraint`);
  }
  assert.ok(!/create\s+table/i.test(sql), 'the migration creates no tables');
  assert.ok(!/create\s+index/i.test(sql), 'the migration creates no indexes');
  assert.ok(/alter table public\.analytics_events/.test(sql), 'it only widens the analytics CHECK constraint');
  ok('migration: taxonomy CHECK widening only — 7 events, no tables, no Live TV schema');
}

// ============================================================
// §6 Shaka loading stays dynamic-only in the engine
// ============================================================
{
  const engineSource = read('../src/lib/client/live-tv/player.ts');
  // The ONLY way Shaka enters the app: the dynamic import inside the
  // browser-guarded loader.
  const dynamicImports = engineSource.match(/import\('shaka-player'\)/g) ?? [];
  assert.equal(dynamicImports.length, 1, 'exactly one dynamic shaka import');
  assert.match(
    engineSource,
    /typeof window === 'undefined' \|\| typeof document === 'undefined'/,
    'the loader guards on browser globals BEFORE importing'
  );
  // No static import anywhere in the engine source.
  assert.doesNotMatch(engineSource, /^import .*shaka/m, 'no static shaka import');
  assert.doesNotMatch(engineSource, /from 'shaka-player'/, "no 'from shaka-player' import");
  ok('Shaka loading: browser-guarded dynamic import only (SSR can never evaluate Shaka)');
}

console.log(`\nLT-6 release audit suite: ${passed}/${passed} checks PASS`);
