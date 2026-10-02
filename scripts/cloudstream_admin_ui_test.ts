import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';

// CS-1: Integrations admin UI contract tests (AC-001).
//
// Scope: the System → Integrations page becomes the single central
// integrations workspace with [ Add-on ] (Stremio, existing behavior
// unchanged) and [ Extension ] (CloudStream Extension Manager) tabs; the "+"
// button opens an Add Integration selector with [ Stremio ] [ CloudStream ]
// chips; the Stremio add flow is preserved verbatim behind the selector; the
// CloudStream repository flow exists; the admin nav is NOT modified; the CS-1
// migration follows the streaming_addons RLS precedent; and the CloudStream
// server domain contains NO dynamic code execution of remote data.

let passed = 0;
function ok(condition: unknown, label: string) {
  assert.ok(condition, label);
  passed += 1;
}

const pageServer = readFileSync(new URL('../src/routes/admin/system/integrations/+page.server.ts', import.meta.url), 'utf8');
const pageSvelte = readFileSync(new URL('../src/routes/admin/system/integrations/+page.svelte', import.meta.url), 'utf8');
const managerSvelte = readFileSync(new URL('../src/lib/components/admin2/AdminCloudStreamManager.svelte', import.meta.url), 'utf8');
const adminAppShell = readFileSync(new URL('../src/lib/components/admin2/AdminAppShell.svelte', import.meta.url), 'utf8');
const previewEndpoint = readFileSync(new URL('../src/routes/api/admin/integrations/cloudstream/preview/+server.ts', import.meta.url), 'utf8');
const migration = readFileSync(new URL('../supabase/migrations/20261101000000_cloudstream_cs1.sql', import.meta.url), 'utf8');
const databaseTypes = readFileSync(new URL('../src/lib/server/supabase/database.types.ts', import.meta.url), 'utf8');
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

// ---------------------------------------------------------------------------
// 1. Tab contract (AC-001): Add-on | Extension, URL-driven, default Add-on
// ---------------------------------------------------------------------------
{
  ok(/VALID_TABS\s*=\s*new Set\(\['addon',\s*'extension'\]\)/.test(pageServer), '1: server validates ?tab=addon|extension');
  ok(pageServer.includes("url.searchParams.get('tab') ?? 'addon'"), '1: default tab is Add-on (existing links keep the Stremio list)');
  ok(/throw error\(400,\s*'Invalid tab/.test(pageServer), '1: invalid tabs rejected server-side (VALID_TABS convention)');
  ok(pageSvelte.includes("label: 'Add-on', href: '?tab=addon'"), '1: Add-on tab link renders');
  ok(pageSvelte.includes("label: 'Extension', href: '?tab=extension'"), '1: Extension tab link renders');
  ok(pageSvelte.includes("active: tab === 'addon'"), '1: Add-on tab active state');
  ok(pageSvelte.includes("active: tab === 'extension'"), '1: Extension tab active state');
}

// ---------------------------------------------------------------------------
// 2. "+" button becomes the Add Integration selector
// ---------------------------------------------------------------------------
{
  ok(pageSvelte.includes('label="Add Integration"'), '2: "+" button relabeled to Add Integration');
  ok(pageSvelte.includes("title=\"Add Integration\"") || pageSvelte.includes('Add Integration'), '2: selector sheet titled Add Integration');
  ok(pageSvelte.includes("addKind: 'stremio' | 'cloudstream' | null"), '2: selector state models the two integration kinds');
  ok(/onclick=\{\(\) => \{ addKind = 'stremio'/.test(pageSvelte), '2: Stremio chip selects the Stremio flow');
  ok(/onclick=\{\(\) => \{ addKind = 'cloudstream'/.test(pageSvelte), '2: CloudStream chip selects the CloudStream flow');
  ok(pageSvelte.includes('>Stremio</span>'), '2: [ Stremio ] chip rendered');
  ok(pageSvelte.includes('>CloudStream</span>'), '2: [ CloudStream ] chip rendered');
}

// ---------------------------------------------------------------------------
// 3. Stremio add flow REGRESSION — preserved verbatim behind the selector
// ---------------------------------------------------------------------------
{
  // The existing preview endpoint + form action + input are all still there.
  ok(pageSvelte.includes("fetch('/api/admin/integrations/preview',"), '3: Stremio preview still uses the existing JSON endpoint');
  ok(pageSvelte.includes("body: JSON.stringify({ manifestUrl }),"), '3: Stremio preview still posts manifestUrl');
  ok(pageSvelte.includes('<span>Manifest URL</span>'), '3: Manifest URL field label preserved');
  ok(pageSvelte.includes('placeholder="https://example.com/manifest.json"'), '3: Manifest URL placeholder preserved');
  ok(pageSvelte.includes('action="?/confirmAddon"'), '3: ?/confirmAddon form action preserved');
  ok(pageSvelte.includes("name=\"manifestUrl\""), '3: manifestUrl hidden field preserved');

  // All seven pre-existing Stremio actions remain on the server.
  for (const action of ['previewAddon', 'confirmAddon', 'setEnabled', 'refreshAddon', 'setAddonPosition', 'deleteAddon', 'saveLinkTypes']) {
    ok(pageServer.includes(`${action}: async`), `3: existing Stremio action "${action}" preserved`);
  }
  ok(pageServer.includes('listAdminAddons(locals.supabase)'), '3: Add-on tab data load unchanged (listAdminAddons)');
}

// ---------------------------------------------------------------------------
// 4. CloudStream add flow + actions
// ---------------------------------------------------------------------------
{
  ok(pageSvelte.includes("fetch('/api/admin/integrations/cloudstream/preview',"), '4: CloudStream preview calls the new endpoint');
  ok(pageSvelte.includes("body: JSON.stringify({ repositoryUrl }),"), '4: CloudStream preview posts repositoryUrl');
  ok(pageSvelte.includes('<span>Repository URL</span>'), '4: Repository URL field rendered');
  ok(pageSvelte.includes('action="?/confirmCloudStreamRepository"'), '4: ?/confirmCloudStreamRepository form action');
  ok(pageSvelte.includes("name=\"repositoryUrl\""), '4: repositoryUrl hidden field');
  ok(pageSvelte.includes('AdminCloudStreamManager'), '4: Extension tab renders the isolated manager component');
  for (const action of ['confirmCloudStreamRepository', 'syncCloudStreamRepository', 'setCloudStreamRepositoryEnabled', 'deleteCloudStreamRepository', 'setCloudStreamExtensionEnabled']) {
    ok(pageServer.includes(`${action}: async`), `4: CloudStream action "${action}" exists`);
  }
  // Every CloudStream action redirects back to the Extension tab.
  const csActionBlocks = pageServer.split('confirmCloudStreamRepository: async')[1] ?? '';
  ok(csActionBlocks.includes('?tab=extension'), '4: CloudStream actions redirect to the Extension tab');
}

// ---------------------------------------------------------------------------
// 5. Extension tab manager component contracts
// ---------------------------------------------------------------------------
{
  ok(managerSvelte.includes("?/syncCloudStreamRepository"), '5: manager posts repository sync');
  ok(managerSvelte.includes("?/setCloudStreamRepositoryEnabled"), '5: manager posts repository enable/disable');
  ok(managerSvelte.includes("?/deleteCloudStreamRepository"), '5: manager posts repository delete');
  ok(managerSvelte.includes('confirm('), '5: destructive delete asks for confirmation');
  ok(managerSvelte.includes("?/setCloudStreamExtensionEnabled"), '5: manager posts extension enable/disable');
  ok(managerSvelte.includes("import type {\n    CloudStreamAdapterStatus,"), '5: manager consumes the SHARED type contract');
  ok(managerSvelte.includes('adapter_required'), '5: manager renders adapter compatibility states');
  // The manager must NOT introduce a second player/MPV/Share implementation.
  for (const forbidden of ['externalPlayerLaunchFor', 'mpv', 'shareActionFor', 'downloadActionFor']) {
    ok(!managerSvelte.includes(forbidden), `5: manager does NOT re-implement "${forbidden}"`);
  }
}

// ---------------------------------------------------------------------------
// 6. Admin navigation unchanged — NO new top-level nav item (AC-001)
// ---------------------------------------------------------------------------
{
  ok(!adminAppShell.includes('cloudstream'), '6: AdminAppShell has no CloudStream nav entry');
  ok(!adminAppShell.includes("id: 'extensions'"), '6: no new Extensions nav item');
  ok(adminAppShell.includes("{ id: 'integrations', label: 'Integrations', href: '/admin/system/integrations'"), '6: single System → Integrations entry remains');
  // No dedicated CloudStream admin route was created.
  const routesDir = new URL('../src/routes/admin/system/', import.meta.url);
  const entries = readdirSync(routesDir);
  ok(!entries.includes('cloudstream'), '6: no /admin/system/cloudstream route directory');
}

// ---------------------------------------------------------------------------
// 7. Preview API endpoint conventions
// ---------------------------------------------------------------------------
{
  ok(previewEndpoint.includes('requireAdmin'), '7: preview endpoint gated by requireAdmin');
  ok(previewEndpoint.includes('readJsonBody'), '7: preview endpoint reads a bounded JSON body');
  ok(previewEndpoint.includes("NO_STORE"), '7: preview endpoint sets no-store cache headers');
  ok(previewEndpoint.includes('CloudStreamRepositoryError'), '7: preview endpoint surfaces only the curated error taxonomy');
  ok(previewEndpoint.includes('previewRepository'), '7: preview endpoint delegates to the repository service');
}

// ---------------------------------------------------------------------------
// 8. Migration contract (streaming_addons precedent)
// ---------------------------------------------------------------------------
{
  ok(migration.includes('create table if not exists public.cloudstream_repositories'), '8: cloudstream_repositories created');
  ok(migration.includes('create table if not exists public.cloudstream_extensions'), '8: cloudstream_extensions created');
  ok(migration.includes('unique (repository_id, internal_name)'), '8: one extension row per internalName per repository');
  ok(migration.includes('on delete cascade'), '8: repository removal cascades to discovered extensions');
  ok(migration.includes('enable row level security'), '8: RLS enabled on both tables');
  ok(migration.includes('public.is_admin()'), '8: admin-only CRUD via is_admin() RLS policies');
  ok(migration.includes('revoke all on public.cloudstream_repositories from anon'), '8: anon revoked (repositories)');
  ok(migration.includes('revoke all on public.cloudstream_extensions from anon'), '8: anon revoked (extensions)');
  // Deliberately NO public SELECT policy and NO shared config-meta trigger.
  const noPublicSelect = !migration.includes('to anon') || !/for select\s+to anon/.test(migration);
  ok(noPublicSelect, '8: NO public/anon SELECT policy (server-side reads only)');
  // Strip SQL comments, then verify no functional statement touches the shared
  // config-version counters (the header only DOCUMENTS the decision).
  const migrationCode = migration
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n');
  ok(!/streaming_config_meta|download_providers_config_meta|bump_download_providers_config_version|refresh_streaming_public_config/i.test(migrationCode), '8: NO shared config-version counter bump (functional statements only)');
  ok(migration.includes("adapter_status text not null default 'adapter_required'"), '8: discovery never implies runtime compatibility (default adapter_required)');
  // Database types registered.
  ok(databaseTypes.includes('cloudstream_repositories: {'), '8: database types include cloudstream_repositories');
  ok(databaseTypes.includes('cloudstream_extensions: {'), '8: database types include cloudstream_extensions');
  ok(databaseTypes.includes('cloudstream_extensions_repository_id_fkey'), '8: FK relationship typed');
}

// ---------------------------------------------------------------------------
// 9. SECURITY — no dynamic code execution anywhere in the CloudStream domain
// ---------------------------------------------------------------------------
{
  const domainDir = new URL('../src/lib/server/cloudstream/', import.meta.url);
  const files: Array<[string, string]> = [];
  const walk = (dir: URL) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const child = new URL(`${entry.name}/`, dir);
      if (entry.isDirectory()) walk(child);
      else if (entry.name.endsWith('.ts')) files.push([entry.name, readFileSync(new URL(entry.name, dir), 'utf8')]);
    }
  };
  walk(domainDir);
  ok(files.length >= 8, `9: CloudStream server domain has ${files.length} modules`);
  for (const [name, source] of files) {
    ok(!/\beval\s*\(/.test(source), `9: ${name} contains no eval()`);
    ok(!/new Function\s*\(/.test(source), `9: ${name} contains no new Function()`);
    ok(!/\bimport\s*\(/.test(source), `9: ${name} contains no dynamic import()`);
  }
  // The only fetch entry point reuses fetchStremioManifest (D-006 — no
  // duplicate HTTP security layer).
  const fetchFacade = readFileSync(new URL('../src/lib/server/cloudstream/security/fetch.ts', import.meta.url), 'utf8');
  ok(fetchFacade.includes('fetchStremioManifest'), '9: security facade REUSES fetchStremioManifest (no duplicate SSRF layer)');
  // The adapter registry is code-owned. CS-1 kept it intentionally EMPTY;
  // CS-2 (per the CS-1 registry's own comment + plan §40.6/AC-003) fills it
  // with the three source-verified ports. Registry construction stays a
  // code-owned Map — no DB-configurable execution.
  const registry = readFileSync(new URL('../src/lib/server/cloudstream/adapters/registry.ts', import.meta.url), 'utf8');
  ok(registry.includes('new Map<string, MaveroCloudStreamAdapter>'), '9: adapter registry stays a code-owned Map (no DB-configurable execution)');
  ok(registry.includes('bollyflixAdapter') && registry.includes('moviesdriveAdapter') && registry.includes('vegamoviesAdapter'), '9: registry registers exactly the three CS-2 ported adapters');
}

// ---------------------------------------------------------------------------
// 10. Test registration in the pnpm test chain
// ---------------------------------------------------------------------------
{
  const testScript = String(pkg.scripts.test);
  ok(testScript.includes('scripts/cloudstream_repository_parse_test.ts'), '10: parse test registered in the chain');
  ok(testScript.includes('scripts/cloudstream_repository_sync_test.ts'), '10: sync test registered in the chain');
  ok(testScript.includes('scripts/cloudstream_admin_ui_test.ts'), '10: admin UI test registered in the chain');
}

// ---------------------------------------------------------------------------
// 11. Untouchable regression surface — key existing files untouched
// ---------------------------------------------------------------------------
{
  const stremioAddons = readFileSync(new URL('../src/lib/server/streaming/stremio/admin-addons.ts', import.meta.url), 'utf8');
  ok(stremioAddons.includes('export async function listAdminAddons'), '11: Stremio admin service intact');
  const streamActions = readFileSync(new URL('../src/lib/shared/stream-actions.ts', import.meta.url), 'utf8');
  ok(streamActions.length > 0, '11: shared stream action model untouched (present)');
  const manifestFetch = readFileSync(new URL('../src/lib/server/streaming/stremio/manifest-fetch.ts', import.meta.url), 'utf8');
  ok(manifestFetch.includes('export async function fetchStremioManifest'), '11: SSRF fetcher intact (reused, not modified)');
  ok(existsSync(new URL('../src/lib/server/downloader/json-service.ts', import.meta.url)), '11: generic JSON downloader intact');
  ok(existsSync(new URL('../src/lib/components/MaveroAddonDownload.svelte', import.meta.url)), '11: existing Mavero Downloader UI intact');
  // CS-1 does not touch the resolver / player providers (direct streaming).
  const resolverAdapters = readFileSync(new URL('../src/lib/server/resolver/adapters.ts', import.meta.url), 'utf8');
  ok(!resolverAdapters.includes('cloudstream'), '11: watch-page resolver has no CloudStream integration');
  ok(!pageSvelte.includes('mavero2'), '11: no Downloader 2 UI in CS-1');
}

console.log(`cloudstream_admin_ui_test: ${passed} checks passed`);
