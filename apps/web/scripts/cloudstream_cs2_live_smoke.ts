/**
 * CS-2 MANUAL live smoke test — resolves a real movie through a real
 * provider adapter against the LIVE sites (network!).
 *
 * This is NOT part of the deterministic `pnpm test` chain (same policy as
 * the CS-1 `verify:cloudstream-repo` smoke): the CI suites must never
 * depend on external websites. Run it manually:
 *
 *   pnpm run verify:cloudstream-runtime
 *
 * It exercises the FULL runtime path: dynamic domain resolution (urls.json)
 * → provider search → page load → link discovery → extractor resolution →
 * normalized links. Failures are reported per provider with categories.
 */

import { resolveCloudStream } from '$lib/server/cloudstream/resolver/service';
import { listCloudStreamAdapters } from '$lib/server/cloudstream/adapters/registry';
import { dynamicUrls } from '$lib/server/cloudstream/runtime/dynamic-urls';

function log(label: string, value: unknown) {
  console.log(`  ${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}`);
}

async function main() {
  console.log('CS-2 LIVE SMOKE — real network resolution (manual command)');
  console.log('='.repeat(64));

  // 1. Dynamic domain resolution.
  const urls = await dynamicUrls();
  const keys = ['bollyflix', 'moviesdrive', 'vegamovies', 'gdflix', 'hubcloud', 'vcloud'];
  console.log('\n[1] Dynamic domains (urls.json):');
  for (const key of keys) {
    log(key, urls.get(key) ?? '(missing — fallback base will be used)');
  }

  // 2. Registry state.
  console.log('\n[2] Registered adapters:');
  for (const adapter of listCloudStreamAdapters()) {
    log(adapter.id, `v${adapter.version} movie=${adapter.supports.movie} series=${adapter.supports.series}`);
  }

  // 3. Resolve a well-known movie through every adapter.
  const title = process.argv[2] ?? 'Inception';
  const year = process.argv[3] ? Number.parseInt(process.argv[3], 10) : 2010;
  console.log(`\n[3] Movie resolution: "${title}" (${year}) through all adapters…`);
  const result = await resolveCloudStream({
    media: { tmdbId: 'live-smoke', title, ...(Number.isInteger(year) ? { year } : {}) },
    adapterIds: listCloudStreamAdapters().map((adapter) => adapter.id),
  });

  let anyLinks = false;
  for (const group of result.groups) {
    console.log(`\n  ${group.adapterName}: ${group.status.toUpperCase()}`);
    if (group.failure) log('failure', `${group.failure.category} — ${group.failure.message}`);
    log('link count', group.links.length);
    for (const link of group.links.slice(0, 5)) {
      log(`    [${link.sourceName}] ${link.quality ?? '?'}${link.sizeBytes ? ` ${(link.sizeBytes / 1e9).toFixed(1)}GB` : ''}`, link.url.slice(0, 110));
    }
    if (group.links.length > 5) log('    …', `${group.links.length - 5} more`);
    anyLinks = anyLinks || group.links.length > 0;
  }

  console.log(`\n[4] Diagnostics: ${result.diagnostics.length} events, resolution took ${result.durationMs}ms`);
  const failures = result.diagnostics.filter((e) => !e.success);
  for (const event of failures.slice(0, 10)) {
    log('failed event', `${event.adapterId}/${event.stage}${event.extractorId ? `/${event.extractorId}` : ''} ${event.failureCategory ?? ''} ${event.httpStatus ?? ''}`);
  }

  console.log('\n' + '='.repeat(64));
  if (anyLinks) {
    console.log('LIVE SMOKE: PASS — at least one provider resolved real links.');
  } else {
    console.log('LIVE SMOKE: ZERO LINKS — check the per-provider failures above.');
    console.log('(Sites rotate domains frequently; the dynamic urls.json lookup');
    console.log(' should track them. Persistent zero = provider site changed.');
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error('LIVE SMOKE CRASHED:', error);
  process.exitCode = 1;
});
