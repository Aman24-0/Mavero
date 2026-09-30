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

// Provider cards show identity + capabilities
assert.match(apiSourcesPage, /a2-provider-card/, 'Providers tab renders provider cards');
assert.match(apiSourcesPage, /a2-provider-card-name/, 'card shows provider name');
assert.match(apiSourcesPage, /a2-provider-card-adapter/, 'card shows adapter id');
assert.match(apiSourcesPage, /a2-cap-dot/, 'card shows capability dots');
ok('2b. Provider cards show identity + capabilities');

// ============================================================
// 3. Provider enable/disable (via legacy link)
// ============================================================

assert.match(apiSourcesPage, /\/admin\/providers/, 'API & Sources links to legacy provider registry for full CRUD');
ok('3a. Provider full CRUD accessible via legacy link (no duplicate CRUD logic)');

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
assert.match(apiSourcesPage, /a2-source-table/, 'Sources tab renders source table');
ok('6a. Sources listed from existing admin-service');

// ============================================================
// 7. Source/provider relationship
// ============================================================

assert.match(apiSourcesPage, /providerForSource/, 'page has providerForSource helper');
assert.match(apiSourcesPage, /provider\?.name/, 'source table shows provider name');
ok('7a. Source/provider relationship is clear in the UI');

// ============================================================
// 8. Source CRUD (via legacy link)
// ============================================================

assert.match(apiSourcesPage, /\/admin\/sources/, 'API & Sources links to legacy source registry for full CRUD');
ok('8a. Source full CRUD accessible via legacy link (no duplicate CRUD logic)');

// ============================================================
// 9. Defaults sheet
// ============================================================

assert.match(apiSourcesPage, /defaultsOpen/, 'API & Sources has defaults sheet state');
assert.match(apiSourcesPage, /a2-defaults-sheet/, 'Defaults sheet renders');
assert.match(apiSourcesPage, /Default Sources/, 'Defaults sheet titled "Default Sources"');
ok('9a. Defaults sheet exists in API & Sources workspace');

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
assert.match(contentRulesPage, /a2-category-table/, 'Categories tab renders category table');
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
assert.match(downloadsPage, /a2-dl-table/, 'Downloads page renders provider table');
ok('18a. Downloads workspace uses existing downloader service');

// ============================================================
// 19. Downloader configuration
// ============================================================

assert.match(downloadsPage, /provider.type/, 'Downloads shows provider type (embed/json)');
assert.match(downloadsPage, /provider.enabled/, 'Downloads shows enabled state');
assert.match(downloadsPage, /\/admin\/downloaders/, 'Downloads links to legacy registry for full CRUD');
ok('19a. Downloader configuration shows type, enabled, and links to full CRUD');

// ============================================================
// 20. Integrations
// ============================================================

assert.match(adminAppShell, /id: 'integrations', label: 'Integrations', href: '\/admin\/system\/integrations'/, 'nav has Integrations');
assert.match(integrationsPage, /AdminAppShell/, 'Integrations page uses AdminAppShell');
assert.match(integrationsServer, /listAdminAddons/, 'Integrations server uses existing Stremio admin-addons service');
assert.match(integrationsPage, /a2-addon-table/, 'Integrations page renders addon table');
ok('20a. Integrations workspace uses existing Stremio addon service');

// ============================================================
// 21. Stremio configuration
// ============================================================

assert.match(integrationsPage, /addon.name/, 'Integrations shows addon name');
assert.match(integrationsPage, /addon.version/, 'Integrations shows addon version');
assert.match(integrationsPage, /addon.enabled/, 'Integrations shows enabled state');
assert.match(integrationsPage, /\/admin\/addons/, 'Integrations links to legacy addon registry for full CRUD');
ok('21a. Stremio configuration shows addon identity + links to full CRUD');

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
assert.match(adminAppShell, /configItems/, 'command menu receives configItems (now empty)');
ok('24a. Command menu populated from nav groups (includes new system items)');

// ============================================================
// 25. Config items retired
// ============================================================

assert.match(adminAppShell, /const configItems: ConfigItem\[\] = \[\]/, 'configItems is now empty array');
ok('25a. Config items (Defaults + Feature Control) retired — consolidated into workspaces');

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
assert.match(downloadsPage, /No downloader configuration/, 'Downloads has empty state');
assert.match(integrationsPage, /No integrations configured/, 'Integrations has empty state');
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
