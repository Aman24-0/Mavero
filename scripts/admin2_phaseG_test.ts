import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/**
 * Admin 2.0 — Phase G contracts.
 *
 * Phase G is the System / Configuration Consolidation: unified workspaces
 * for API & Sources, Content Rules, Downloads, and Integrations.
 *
 * This test pins the contracts that Phase H+ will depend on.
 */

let passed = 0;
function ok(message: string) {
  passed += 1;
  console.log(`  ok ${passed} - ${message}`);
}

// ============================================================
// Source files under test
// ============================================================

const apiSourcesPage = readFileSync(new URL('../src/routes/admin/system/api-sources/+page.svelte', import.meta.url), 'utf8');
const apiSourcesServer = readFileSync(new URL('../src/routes/admin/system/api-sources/+page.server.ts', import.meta.url), 'utf8');
const contentRulesPage = readFileSync(new URL('../src/routes/admin/system/content-rules/+page.svelte', import.meta.url), 'utf8');
const contentRulesServer = readFileSync(new URL('../src/routes/admin/system/content-rules/+page.server.ts', import.meta.url), 'utf8');
const downloadsPage = readFileSync(new URL('../src/routes/admin/system/downloads/+page.svelte', import.meta.url), 'utf8');
const downloadsServer = readFileSync(new URL('../src/routes/admin/system/downloads/+page.server.ts', import.meta.url), 'utf8');
const integrationsPage = readFileSync(new URL('../src/routes/admin/system/integrations/+page.svelte', import.meta.url), 'utf8');
const integrationsServer = readFileSync(new URL('../src/routes/admin/system/integrations/+page.server.ts', import.meta.url), 'utf8');

const adminAppShell = readFileSync(new URL('../src/lib/components/admin2/AdminAppShell.svelte', import.meta.url), 'utf8');

// ============================================================
// 1. API & Sources navigation
// ============================================================

assert.match(adminAppShell, /id: 'api-sources', label: 'API & Sources', href: '\/admin\/system\/api-sources'/, 'nav has API & Sources');
assert.match(adminAppShell, /matchPrefix: '\/admin\/system\/api-sources'/, 'API & Sources has matchPrefix');
ok('1a. API & Sources nav item points to /admin/system/api-sources');

assert.match(apiSourcesPage, /AdminAppShell/, 'API & Sources page uses AdminAppShell');
assert.match(apiSourcesPage, /AdminPage/, 'API & Sources page uses AdminPage');
ok('1b. API & Sources page uses Admin 2.0 shell');

// ============================================================
// 2. Providers migration
// ============================================================

assert.match(apiSourcesPage, /Providers/, 'API & Sources page has Providers tab');
assert.match(apiSourcesServer, /listAdminProviders/, 'API & Sources server loads providers via existing service');
assert.match(apiSourcesServer, /listProviderHealthSummaries/, 'API & Sources server loads health summaries');
assert.match(apiSourcesServer, /lookupProviderCapabilities/, 'API & Sources server loads capability map');
ok('2a. Providers data loaded from existing admin-service (no new backend)');

// Phase 1: provider rows show identity (name + adapter id + integration + sandbox)
assert.match(apiSourcesPage, /a2-provider-row/, 'Providers tab renders provider rows');
assert.match(apiSourcesPage, /a2-provider-row-name/, 'row shows provider name');
assert.match(apiSourcesPage, /a2-provider-row-meta/, 'row shows provider meta');
assert.match(apiSourcesPage, /adapter_id/, 'row shows adapter id (in meta)');
ok('2b. Provider rows show identity + adapter id (Phase 1 — rows replace cards)');

// ============================================================
// 3. Provider CRUD (in-workspace — Phase 1)
//
// Phase 1 removed the legacy /admin/providers link. Full CRUD now lives
// in this workspace's +page.server.ts as createProvider / updateProvider /
// toggleProvider / deleteProvider actions.
// ============================================================

// Phase 1: no href/goto link to the legacy /admin/providers page (full CRUD is in-workspace).
// (The page header comment may still reference the legacy route name as historical context.)
assert.doesNotMatch(apiSourcesPage, /href=("|')\/admin\/providers/, 'API & Sources has no href link to legacy provider registry (Phase 1)');
assert.doesNotMatch(apiSourcesPage, /goto\('\/admin\/providers/, 'API & Sources has no goto() to legacy provider registry (Phase 1)');
assert.match(apiSourcesServer, /createProvider/, 'server has createProvider action');
assert.match(apiSourcesServer, /updateProvider/, 'server has updateProvider action');
assert.match(apiSourcesServer, /toggleProvider/, 'server has toggleProvider action');
assert.match(apiSourcesServer, /deleteProvider/, 'server has deleteProvider action');
ok('3a. Provider full CRUD lives in the workspace (Phase 1 — no legacy link)');

// ============================================================
// 4. Provider secret redaction
// ============================================================

// The page server loads providers via listAdminProviders which returns DB rows
// but the page never renders raw capabilities JSON or API keys.
assert.doesNotMatch(apiSourcesPage, /api_key|apiKey|VIDARA_API_KEY|ABYSS_API_KEY|password|jwt/i, 'page does NOT expose any secret fields');
ok('4a. Provider page does NOT expose any secret fields');

// ============================================================
// 5. Provider capabilities
// ============================================================

assert.match(apiSourcesPage, /CAPABILITY_FIELDS/, 'page uses shared CAPABILITY_FIELDS');
assert.match(apiSourcesPage, /CAPABILITY_LABELS/, 'page uses shared CAPABILITY_LABELS');
assert.match(apiSourcesPage, /capabilityState/, 'page has capabilityState helper');
ok('5a. Provider capabilities come from shared player-capabilities module (no duplication)');

// ============================================================
// 6. Sources listing
// ============================================================

assert.match(apiSourcesPage, /Sources/, 'API & Sources page has Sources tab');
assert.match(apiSourcesServer, /listAdminSources/, 'API & Sources server loads sources via existing service');
// Phase 1: source rows (was a2-source-table — replaced by a2-source-list of rows)
assert.match(apiSourcesPage, /a2-source-list/, 'Sources tab renders source list');
ok('6a. Sources listed from existing admin-service');

// ============================================================
// 7. Source/provider relationship
// ============================================================

assert.match(apiSourcesPage, /providerForSource/, 'page has providerForSource helper');
assert.match(apiSourcesPage, /provider\?.name/, 'source table shows provider name');
ok('7a. Source/provider relationship is clear in the UI');

// ============================================================
// 8. Source CRUD (in-workspace — Phase 1)
//
// Phase 1 removed the legacy /admin/sources link. Full CRUD now lives
// in this workspace's +page.server.ts as createSource / updateSource /
// toggleSource / deleteSource actions.
// ============================================================

// Phase 1: no href/goto link to the legacy /admin/sources page (full CRUD is in-workspace).
// (The page header comment may still reference the legacy route name as historical context.)
assert.doesNotMatch(apiSourcesPage, /href=("|')\/admin\/sources/, 'API & Sources has no href link to legacy source registry (Phase 1)');
assert.doesNotMatch(apiSourcesPage, /goto\('\/admin\/sources/, 'API & Sources has no goto() to legacy source registry (Phase 1)');
assert.match(apiSourcesServer, /createSource/, 'server has createSource action');
assert.match(apiSourcesServer, /updateSource/, 'server has updateSource action');
assert.match(apiSourcesServer, /toggleSource/, 'server has toggleSource action');
assert.match(apiSourcesServer, /deleteSource/, 'server has deleteSource action');
ok('8a. Source full CRUD lives in the workspace (Phase 1 — no legacy link)');

// ============================================================
// 9. Defaults sheet
// ============================================================

assert.match(apiSourcesPage, /defaultsOpen/, 'API & Sources has defaults sheet state');
// Phase 1: defaults sheet uses generic a2-sheet classes (a2-sheet / a2-sheet-head / a2-sheet-body)
assert.match(apiSourcesPage, /a2-sheet\b/, 'Defaults sheet renders (a2-sheet container)');
assert.match(apiSourcesPage, /a2-sheet-head/, 'Defaults sheet has a2-sheet-head');
assert.match(apiSourcesPage, /Default Sources/, 'Defaults sheet titled "Default Sources"');
// Phase 1: the old a2-defaults-sheet / a2-defaults-head / a2-legacy-link classes are gone.
assert.doesNotMatch(apiSourcesPage, /a2-defaults-sheet/, 'legacy a2-defaults-sheet class removed (Phase 1)');
assert.doesNotMatch(apiSourcesPage, /a2-defaults-head/, 'legacy a2-defaults-head class removed (Phase 1)');
assert.doesNotMatch(apiSourcesPage, /a2-legacy-link/, 'no a2-legacy-link class (Phase 1 — full CRUD in-workspace)');
ok('9a. Defaults sheet exists in API & Sources workspace (Phase 1 — a2-sheet classes)');

// ============================================================
// 10. Defaults persistence
// ============================================================

assert.match(apiSourcesServer, /saveDefault/, 'server has saveDefault action');
assert.match(apiSourcesServer, /clearDefault/, 'server has clearDefault action');
assert.match(apiSourcesServer, /upsertDefaultSource/, 'saveDefault calls existing upsertDefaultSource');
assert.match(apiSourcesServer, /clearDefaultSource/, 'clearDefault calls existing clearDefaultSource');
ok('10a. Defaults persistence uses existing admin-service (no new backend)');

// ============================================================
// 11. Defaults runtime integration
// ============================================================

assert.match(apiSourcesServer, /upsertDefaultSource|clearDefaultSource/, 'defaults actions call existing service which invalidates public config cache');
ok('11a. Defaults changes flow through existing service → invalidates cache → affects resolver');

// ============================================================
// 12. Content Rules navigation
// ============================================================

assert.match(adminAppShell, /id: 'content-rules', label: 'Content Rules', href: '\/admin\/system\/content-rules'/, 'nav has Content Rules');
assert.match(adminAppShell, /matchPrefix: '\/admin\/system\/content-rules'/, 'Content Rules has matchPrefix');
ok('12a. Content Rules nav item points to /admin/system/content-rules');

assert.match(contentRulesPage, /AdminAppShell/, 'Content Rules page uses AdminAppShell');
assert.match(contentRulesPage, /AdminPage/, 'Content Rules page uses AdminPage');
ok('12b. Content Rules page uses Admin 2.0 shell');

// ============================================================
// 13. Categories
// ============================================================

assert.match(contentRulesPage, /Categories/, 'Content Rules has Categories tab');
assert.match(contentRulesServer, /listAdminCategories/, 'Content Rules server loads categories via existing service');
assert.match(contentRulesServer, /listSourceCategories/, 'Content Rules server loads source-category mappings');
// Phase 1: category rows (was a2-category-table — now a2-category-list of rows)
assert.match(contentRulesPage, /a2-category-list/, 'Categories tab renders category list');
ok('13a. Categories loaded from existing admin-service');

// ============================================================
// 14. Feature Control
// ============================================================

assert.match(contentRulesPage, /Feature Control/, 'Content Rules has Feature Control tab');
assert.match(contentRulesPage, /Adult Mode Policy/, 'Feature Control shows Adult Mode Policy section');
ok('14a. Feature Control tab exists in Content Rules workspace');

// ============================================================
// 15. Feature persistence
// ============================================================

assert.match(contentRulesPage, /\/api\/admin\/adult-mode/, 'Feature Control uses existing adult-mode API');
assert.match(contentRulesPage, /togglePolicy/, 'Feature Control has togglePolicy function');
assert.match(contentRulesPage, /PUT/, 'Feature Control sends PUT to update policy');
ok('15a. Feature persistence uses existing /api/admin/adult-mode endpoint');

// ============================================================
// 16. Feature runtime integration
// ============================================================

assert.match(contentRulesPage, /allowLoggedIn/, 'Feature Control toggles allowLoggedIn');
assert.match(contentRulesPage, /allowGuest/, 'Feature Control toggles allowGuest');
ok('16a. Feature toggles map to real runtime policy fields');

// ============================================================
// 17. Feature Control auth fix (Phase G)
// ============================================================

// Phase G fix: the legacy /admin/feature-control had NO +page.server.ts
// (no SSR auth gate). The new /admin/system/content-rules HAS a server
// loader with requireAdmin.
assert.match(contentRulesServer, /requireAdmin/, 'Content Rules server requires admin (fixes feature-control auth gap)');
ok('17a. Feature Control now has SSR auth gate via Content Rules page server (Phase G fix)');

// ============================================================
// 18. Downloads
// ============================================================

assert.match(adminAppShell, /id: 'downloads', label: 'Downloads', href: '\/admin\/system\/downloads'/, 'nav has Downloads');
assert.match(downloadsPage, /AdminAppShell/, 'Downloads page uses AdminAppShell');
assert.match(downloadsServer, /listAdminDownloadProviders/, 'Downloads server uses existing downloader admin-service');
// Phase 1: downloader rows (was a2-dl-table — now a2-dl-list of rows)
assert.match(downloadsPage, /a2-dl-list/, 'Downloads page renders downloader list');
ok('18a. Downloads workspace uses existing downloader service');

// ============================================================
// 19. Downloader configuration (in-workspace — Phase 1)
//
// Phase 1 moved full CRUD into the workspace. The page renders
// type, enabled state, default badge, and CRUD actions directly
// (no legacy /admin/downloaders link).
// ============================================================

assert.match(downloadsPage, /data-type=/, 'Downloads shows provider type (embed/json)');
assert.match(downloadsPage, /data-enabled=/, 'Downloads shows enabled state');
assert.doesNotMatch(downloadsPage, /href=("|')\/admin\/downloaders/, 'Downloads has no href link to legacy registry (Phase 1)');
assert.match(downloadsServer, /createProvider/, 'Downloads server has createProvider action');
assert.match(downloadsServer, /updateProvider/, 'Downloads server has updateProvider action');
assert.match(downloadsServer, /toggleProvider/, 'Downloads server has toggleProvider action');
assert.match(downloadsServer, /deleteProvider/, 'Downloads server has deleteProvider action');
ok('19a. Downloader configuration shows type + enabled, with full CRUD in-workspace (Phase 1)');

// ============================================================
// 20. Integrations
// ============================================================

assert.match(adminAppShell, /id: 'integrations', label: 'Integrations', href: '\/admin\/system\/integrations'/, 'nav has Integrations');
assert.match(integrationsPage, /AdminAppShell/, 'Integrations page uses AdminAppShell');
assert.match(integrationsServer, /listAdminAddons/, 'Integrations server uses existing Stremio admin-addons service');
assert.match(integrationsPage, /a2-addon-list/, 'Integrations page renders addon list');
ok('20a. Integrations workspace uses existing Stremio addon service');

// ============================================================
// 21. Stremio configuration
// ============================================================

assert.match(integrationsPage, /addon.name/, 'Integrations shows addon name');
assert.match(integrationsPage, /addon.version/, 'Integrations shows addon version');
assert.match(integrationsPage, /addon.enabled/, 'Integrations shows enabled state');
// Phase 1: full CRUD in-workspace (no legacy /admin/addons link)
assert.doesNotMatch(integrationsPage, /href=("|')\/admin\/addons/, 'Integrations has no href link to legacy addon registry (Phase 1)');
assert.match(integrationsServer, /previewAddon/, 'Integrations server has previewAddon action');
assert.match(integrationsServer, /createAddon/, 'Integrations server has createAddon action');
assert.match(integrationsServer, /setEnabled/, 'Integrations server has setEnabled action');
assert.match(integrationsServer, /deleteAddon/, 'Integrations server has deleteAddon action');
ok('21a. Stremio configuration shows addon identity with full CRUD in-workspace (Phase 1)');

// ============================================================
// 22. Admin authorization
// ============================================================

assert.match(apiSourcesServer, /requireAdmin/, 'API & Sources server requires admin');
assert.match(contentRulesServer, /requireAdmin/, 'Content Rules server requires admin');
assert.match(downloadsServer, /requireAdmin/, 'Downloads server requires admin');
assert.match(integrationsServer, /requireAdmin/, 'Integrations server requires admin');
ok('22a. All 4 new system workspace servers require admin');

// ============================================================
// 23. Route active state
// ============================================================

assert.match(adminAppShell, /matchPrefix: '\/admin\/system\/api-sources'/, 'API & Sources uses matchPrefix');
assert.match(adminAppShell, /matchPrefix: '\/admin\/system\/content-rules'/, 'Content Rules uses matchPrefix');
assert.match(adminAppShell, /matchPrefix: '\/admin\/system\/downloads'/, 'Downloads uses matchPrefix');
assert.match(adminAppShell, /matchPrefix: '\/admin\/system\/integrations'/, 'Integrations uses matchPrefix');
ok('23a. All 4 system workspaces have matchPrefix for route-aware active state');

// ============================================================
// 24. Command menu
// ============================================================

// The command menu is populated from navGroups — since the System group
// now has the 4 new items, they'll appear in the command menu automatically.
assert.match(adminAppShell, /AdminCommandMenu/, 'AdminAppShell imports AdminCommandMenu');
// Phase 2: the topbar Configure dropdown was removed entirely (the empty
// configItems array was the only thing keeping the dropdown rendered). The
// command menu no longer needs configItems — it accepts an optional
// configItems prop that defaults to [].
assert.doesNotMatch(adminAppShell, /a2-config-btn/, 'Phase 2: Configure dropdown button removed');
assert.doesNotMatch(adminAppShell, /a2-config-pop/, 'Phase 2: Configure dropdown popup removed');
ok('24a. Command menu populated from nav groups (includes new system items)');

// ============================================================
// 25. Config items retired (Phase 2: dropdown fully removed)
// ============================================================

// Phase 1 retired configItems by setting it to []. Phase 2 went further:
// the empty configItems array AND the topbar Configure dropdown button
// are both removed (the dropdown was rendering as an empty popup — dead UI).
// AdminAppShell no longer defines configItems at all.
assert.doesNotMatch(adminAppShell, /const configItems/, 'Phase 2: configItems declaration removed (dropdown fully retired)');
ok('25a. Config items (Defaults + Feature Control) retired — consolidated into workspaces; Configure dropdown fully removed (Phase 2)');

// ============================================================
// 26. Mobile navigation
// ============================================================

assert.match(adminAppShell, /mobileNav/, 'AdminAppShell has mobile nav');
assert.match(adminAppShell, /More/, 'Mobile nav has More item');
ok('26a. Mobile navigation preserved (More sheet shows all nav groups)');

// ============================================================
// 27. Loading states
// ============================================================

// API & Sources page loads data server-side (SSR) — no client loading state needed
assert.match(apiSourcesServer, /Promise\.all/, 'API & Sources server parallel-loads data');
ok('27a. API & Sources server-side loads (no client loading state needed)');

// ============================================================
// 28. Empty states
// ============================================================

assert.match(apiSourcesPage, /No providers configured/, 'API & Sources has providers empty state');
assert.match(apiSourcesPage, /No sources configured/, 'API & Sources has sources empty state');
assert.match(contentRulesPage, /No categories configured/, 'Content Rules has categories empty state');
assert.match(downloadsPage, /No downloaders/, 'Downloads has empty state');
assert.match(integrationsPage, /No integrations/, 'Integrations has empty state');
ok('28a. All 5 workspaces have distinct empty states');

// ============================================================
// 29. Error states
// ============================================================

assert.match(contentRulesPage, /a2-features-error/, 'Feature Control has error state');
assert.match(contentRulesPage, /a2-features-retry/, 'Feature Control has retry button');
ok('29a. Feature Control has error state + retry');

// ============================================================
// 30. No secret leakage
// ============================================================

assert.doesNotMatch(apiSourcesPage, /api_key|apiKey|VIDARA_API_KEY|ABYSS_API_KEY|password|jwt/i, 'API & Sources page has no secrets');
assert.doesNotMatch(contentRulesPage, /api_key|apiKey|password|jwt/i, 'Content Rules page has no secrets');
assert.doesNotMatch(downloadsPage, /api_key|apiKey|password|jwt/i, 'Downloads page has no secrets');
assert.doesNotMatch(integrationsPage, /api_key|apiKey|password|jwt/i, 'Integrations page has no secrets');
ok('30a. No secret leakage in any new workspace page');

// ============================================================
// 31. No duplicate configuration logic
// ============================================================

// All workspaces reuse existing services — no new CRUD logic
assert.match(apiSourcesServer, /listAdminProviders.*listAdminSources.*listAdminDefaults/s, 'API & Sources reuses 3 existing service functions');
assert.match(contentRulesServer, /listAdminCategories.*listAdminSources.*listSourceCategories/s, 'Content Rules reuses 3 existing service functions');
assert.match(downloadsServer, /listAdminDownloadProviders/, 'Downloads reuses existing downloader service');
assert.match(integrationsServer, /listAdminAddons/, 'Integrations reuses existing Stremio addon service');
ok('31a. All workspaces reuse existing services (no duplicate configuration logic)');

// ============================================================
// 32. Resolver regression
// ============================================================

// The resolver uses the public config which is invalidated by the existing
// admin-service mutations. Phase G does NOT change any service logic.
const resolverHosted = readFileSync(new URL('../src/lib/server/resolver/mavero-hosted.ts', import.meta.url), 'utf8');
assert.match(resolverHosted, /mavero_status.*available/, 'resolver still gates on mavero_status=available');
assert.match(resolverHosted, /status.*ready/, 'resolver still gates on status=ready');
ok('32a. Resolver gating preserved (Phase G does not touch resolver)');

// ============================================================
// 33. Hosting/configuration separation
// ============================================================

// Phase E Hosting Control is at /admin/hosting (operational)
// Phase G System configuration is at /admin/system/* (configuration)
// They are different routes with different purposes.
assert.match(adminAppShell, /id: 'hosting'.*href: '\/admin\/hosting'/s, 'Hosting Control is at /admin/hosting (Phase E — operational)');
assert.match(adminAppShell, /id: 'api-sources'.*href: '\/admin\/system\/api-sources'/s, 'API & Sources is at /admin/system/api-sources (Phase G — configuration)');
ok('33a. Hosting (Phase E, operational) and System (Phase G, configuration) are separate workspaces');

console.log(`\nAdmin 2.0 Phase G tests passed (${passed} check groups).`);
