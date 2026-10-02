/**
 * CS-3 MANUAL live smoke test — exercises the Mavero Downloader 2 backend
 * against the LIVE database + LIVE provider sites (network!).
 *
 * This is NOT part of the deterministic `pnpm test` chain (same policy as
 * the CS-1/CS-2 smokes): CI must never depend on external websites or the
 * live database. Run it manually:
 *
 *   SUPABASE_URL=https://<ref>.supabase.co \
 *   SUPABASE_SERVICE_ROLE_KEY=<service-role-key> \
 *   pnpm run verify:cloudstream-downloader [Title] [Year]
 *
 * Phases:
 *   [1] REAL DB catalog → tabs through the REAL service (honest eligibility
 *       report — if no repository/extension is enabled, tabs are empty).
 *   [2] REAL resolution through the REAL service + LIVE provider network.
 *       When the live DB has no eligible extensions, a synthetic catalog
 *       (the three registered extensions, enabled) is injected so the FULL
 *       service path still runs against the live sites — clearly labeled.
 */

import { createClient } from '@supabase/supabase-js';
import type { Database } from '$lib/server/supabase/database.types';
import {
  listCloudStreamDownloadTabs,
  resolveCloudStreamDownloads,
  type CloudStreamExtensionCatalog,
} from '$lib/server/cloudstream/downloader/service';
import { listCloudStreamAdapters } from '$lib/server/cloudstream/adapters/registry';

function log(label: string, value: unknown) {
  console.log(`  ${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}`);
}

async function main() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) {
    console.error('CS-3 LIVE SMOKE: SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are required.');
    process.exitCode = 1;
    return;
  }
  // Direct client construction (the $env/dynamic/private module only exists
  // inside the SvelteKit runtime; scripts read process.env).
  const client = createClient<Database>(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });

  const title = process.argv[2] ?? 'Inception';
  const year = process.argv[3] ? Number.parseInt(process.argv[3], 10) : 2010;
  const media = { mediaType: 'movie' as const, tmdbId: '27205', title, ...(Number.isInteger(year) ? { year } : {}) };

  console.log('CS-3 LIVE SMOKE — Mavero Downloader 2 backend (manual command)');
  console.log('='.repeat(64));

  // [1] Real DB catalog → tabs (honest eligibility state).
  console.log('\n[1] Tabs through the REAL service + REAL database:');
  const tabs = await listCloudStreamDownloadTabs(client, {
    mediaType: 'movie',
    contentId: `movie-${media.tmdbId}`,
  }, {
    // The content pipeline needs the SvelteKit $env module; inject the same
    // facts the pipeline would resolve for the smoke title.
    loadContent: async () => ({ ...media }),
  });
  log('consideredExtensions', tabs.consideredExtensions);
  for (const tab of tabs.tabs) {
    log(`tab ${tab.extensionId}`, `${tab.extensionName} media=[${tab.supportedMediaTypes.join(',')}] icon=${tab.iconUrl ? 'yes' : 'no'}`);
  }
  if (tabs.tabs.length === 0) {
    console.log('  (live catalog has no eligible extensions — add + sync + enable a');
    console.log('   repository in System → Integrations → Extension to see tabs.)');
  }

  // [2] Real resolution through the service + live provider network.
  const useLiveCatalog = tabs.tabs.length > 0;
  console.log(`\n[2] Movie resolution "${title}" (${year}) through the service${useLiveCatalog ? ' (live DB catalog)' : ' (injected catalog — live DB has none enabled)'}:`);
  const syntheticCatalog: CloudStreamExtensionCatalog = {
    repositories: [{ id: 'live-smoke-repo', enabled: true, created_at: '2026-01-01T00:00:00Z' }],
    extensions: listCloudStreamAdapters().map((adapter) => ({
      repository_id: 'live-smoke-repo',
      internal_name: adapter.id,
      name: adapter.displayName,
      icon_url: null,
      enabled: true,
    })),
  };
  const result = await resolveCloudStreamDownloads(client, {
    mediaType: 'movie',
    contentId: `movie-${media.tmdbId}`,
  }, {}, {
    loadContent: async () => ({ ...media }),
    ...(useLiveCatalog ? {} : { loadCatalog: async () => syntheticCatalog }),
  });

  let anyLinks = false;
  for (const group of result.groups) {
    console.log(`\n  ${group.extensionName}: ${group.status.toUpperCase()}`);
    if (group.errorCode !== undefined) log('error', `${group.errorCode} — ${group.errorMessage ?? ''}`);
    if (group.matchedTitle !== undefined) log('matchedTitle', group.matchedTitle);
    log('link count', group.links.length);
    for (const link of group.links.slice(0, 5)) {
      log(`    [${link.sourceName}] ${link.quality ?? '?'}${link.sizeBytes ? ` ${(link.sizeBytes / 1e9).toFixed(1)}GB` : ''}`, link.url.slice(0, 110));
    }
    if (group.links.length > 5) log('    …', `${group.links.length - 5} more`);
    anyLinks = anyLinks || group.links.length > 0;
  }

  console.log(`\n[3] Response contract: groups=${result.groups.length} considered=${result.consideredExtensions} media=${result.media.title}`);
  const diagnostics = result.groups.filter((group) => group.diagnostics !== undefined);
  log('groups with diagnostics', diagnostics.length);
  log('total duration sample (ms)', diagnostics[0]?.diagnostics?.durationMs ?? 0);

  console.log('\n' + '='.repeat(64));
  if (anyLinks) {
    console.log('LIVE SMOKE: PASS — the Downloader 2 backend resolved real links.');
  } else {
    console.log('LIVE SMOKE: ZERO LINKS — check the per-extension failures above.');
    console.log('(Providers rotate domains and sites enforce bot protection;');
    console.log(' the deterministic suites + CS-2 smoke cover the logic paths.)');
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error('LIVE SMOKE CRASHED:', error);
  process.exitCode = 1;
});
