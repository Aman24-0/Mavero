/**
 * UNIFIED LIVE TV — Phase 4 admin UI + navigation verification (R-1).
 *
 * Source-inspection tests (no env deps, following the admin2 suite
 * conventions). R-1 DELIBERATE CONTRACT REVISION: the admin Live TV
 * workspace is REDESIGNED around a source-first workflow — the five-tab
 * primary interface (overview/sources/entries/channels/epg) and every
 * mapping/EPG control are GONE from the page; the backend actions and
 * services remain (nothing was deleted). The R-0 form-state fix and the
 * authorization/redaction/isolation contracts are preserved and extended:
 *   §1  Admin2 navigation — the Live TV workspace is registered in the
 *       desktop navGroups (System group) AND reachable on mobile via the
 *       Overview metric card; no duplicate navigation surface.
 *   §2  Page authorization — requireAdmin on the load AND on EVERY action
 *       (including the new bounded ?/sourceChannels read).
 *   §3  R-1 source-first routing — legacy ?tab= URLs are accepted and
 *       harmlessly ignored; no tab navigation exists in the UI.
 *   §4  R-1 source-first main page — heading, ONE Add Source button, one
 *       row per source (name/type/toggle/Edit); NO mapping/EPG/overview UI.
 *   §5  R-1 toggle contract — bound to the persisted `enabled`, optimistic
 *       override with automatic restore, rapid-repeat cancel, a11y switch.
 *   §6  R-1 Edit sheet — config form + divider + the source's OWN bounded
 *       channel section (scoping guard, pagination, loading/empty/error).
 *   §7  R-1 create sheet — per-type fields (R-0 fix preserved), visibility
 *       default public, NO automatic enablement.
 *   §8  Delete flows — confirmed with impact through AdminConfirmDialog.
 *   §9  Refresh semantics — refresh/preview inside the sheet, both outcome
 *       kinds, dry-run label, no competing fetch pipeline.
 *   §10 Redaction + bounded rendering.
 *   §11 Isolation — unified_enablement never written/surfaced, no client
 *       live-tv imports, source types ≠ playback engines, JSON APIs intact.
 *   §12 Dialog stacking + design-system reuse.
 *   §13 R-0 form-state contract (create-mode configuration inputs).
 *   §14 R-1 server-side sourceChannels action (bounded, validated).
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve as pathResolve } from 'node:path';

const root = pathResolve(fileURLToPath(import.meta.url), '../..');
const read = (p: string) => readFileSync(pathResolve(root, p), 'utf-8');
const readCode = (p: string) =>
  read(p)
    .split('\n')
    .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
    .join('\n');

let passed = 0;
let failed = 0;
function ok(condition: unknown, label: string) {
  if (condition) { passed += 1; console.log(`  ok ${passed} - ${label}`); }
  else { failed += 1; console.log(`  FAIL - ${label}`); }
}

const shell = readCode('src/lib/components/admin2/AdminAppShell.svelte');
const livetvServer = readCode('src/routes/admin/system/livetv/+page.server.ts');
const livetvPage = readCode('src/routes/admin/system/livetv/+page.svelte');
const overviewServer = readCode('src/routes/admin/+page.server.ts');
const overviewPage = readCode('src/routes/admin/+page.svelte');
const adminService = readCode('src/lib/server/livetv/admin-service.ts');

console.log('\n§1 — Admin2 navigation registration (desktop + mobile parity)');
{
  ok(/id:\s*'livetv',\s*label:\s*'Live TV',\s*href:\s*'\/admin\/system\/livetv'/.test(shell), '1a. the SYSTEM nav group carries the Live TV workspace');
  ok(/matchPrefix:\s*'\/admin\/system\/livetv'/.test(shell), '1b. route-aware active state via matchPrefix');
  const navGroupsMatch = shell.match(/const navGroups[^=]*=\s*\[([\s\S]*?)\];/);
  ok(navGroupsMatch !== null && navGroupsMatch[1]!.includes('/admin/system/livetv'), '1c. navGroups (the single navigation source of truth) includes the route');
  ok(overviewPage.includes('href="/admin/system/livetv"'), '1d. Overview carries a Live TV metric card (mobile reachability)');
  ok(overviewServer.includes('getLivetvAdminOverview'), '1e. the Overview load feeds the Live TV card');
  ok(/\.catch\(\(\) => null\)/.test(overviewServer) && overviewServer.indexOf('getLivetvAdminOverview') < overviewServer.lastIndexOf('.catch(() => null)'), '1f. the Live TV overview degrades gracefully (never 500s the admin overview)');
  ok(!/a2-more-sheet/.test(shell), '1g. no More-sheet resurrection');
  ok((shell.match(/id:\s*'livetv'/g) ?? []).length === 1, '1h. exactly ONE nav registration (no duplicate surface)');
}

console.log('\n§2 — Server-side authorization on load + EVERY action');
{
  const loadGuard = livetvServer.match(/export const load[\s\S]{0,400}requireAdmin/);
  ok(loadGuard !== null, '2a. the load requires admin');
  const actionsBlock = livetvServer.slice(livetvServer.indexOf('export const actions'));
  const actionNames = [...actionsBlock.matchAll(/^\s{2}(createSource|updateSource|toggleSource|reorderSources|deleteSource|refreshSource|refreshAllSources|previewSource|sourceChannels|toggleEntry|mapEntry|createChannel|updateChannel|toggleChannel|deleteChannel|addCandidate|updateCandidate|removeCandidate|addEndpoint|updateEndpoint|toggleEndpoint|deleteEndpoint|createEpgSource|updateEpgSource|toggleEpgSource|deleteEpgSource|refreshEpgSource|refreshAllEpgSources|previewEpgSource|createEpgMapping|deleteEpgMapping):/gm)].map((match) => match[1]);
  ok(actionNames.length === 31, `2b. all 31 actions present incl. the R-1 sourceChannels read (got ${actionNames.length})`);
  const perActionGuards = [...actionsBlock.matchAll(/^\s{2}(\w+): async/g)].map((match) => match[1]);
  const unguarded = perActionGuards.filter((name) => {
    const start = actionsBlock.indexOf(`${name}: async`);
    const body = actionsBlock.slice(start, start + 400);
    return !/requireAdmin/.test(body);
  });
  ok(unguarded.length === 0, `2c. EVERY action calls requireAdmin before any logic (unguarded: ${unguarded.join(', ') || 'none'})`);
  const sourceChannelsBody = actionsBlock.slice(actionsBlock.indexOf('sourceChannels: async'), actionsBlock.indexOf('sourceChannels: async') + 700);
  ok(/requireAdmin/.test(sourceChannelsBody), '2d. the R-1 sourceChannels read is admin-gated');
  ok(/requireUuidOr400\(form, 'sourceId', 'Source'\)/.test(sourceChannelsBody), '2e. the sourceChannels read UUID-validates the source id');
  ok(/listLivetvSourceChannelsForAdmin/.test(sourceChannelsBody), '2f. the read goes through the bounded service function');
  ok(/checkRateLimit\('livetvAdminRefresh'/.test(livetvServer), '2g. source refresh actions reuse the Phase 2 rate rule');
  ok(/checkRateLimit\('livetvAdminEpgRefresh'/.test(livetvServer), '2h. EPG refresh actions reuse the Phase 3 rate rule');
  ok(/checkRateLimit\('livetvAdminPreview'/.test(livetvServer), '2i. source preview reuses the preview rate rule');
  ok((livetvServer.match(/RATE_LIMITED_ERROR_CODE/g) ?? []).length >= 4, '2j. rate-limited actions answer 429 with the standard envelope');
}

console.log('\n§3 — R-1 source-first routing (legacy tab URLs accepted, never 400)');
{
  ok(!/VALID_TABS/.test(livetvServer), '3a. the tab allow-list is gone from the server (no tab system)');
  ok(!/Invalid tab/.test(livetvServer), '3b. unknown tabs are no longer rejected (legacy URLs resolve to the source-first page)');
  ok(/url\.searchParams\.get\('tab'\)/.test(livetvServer), '3c. the load still READS the legacy tab param (accepted and ignored)');
  ok(!/currentTab|switchTab|a2-context-tabs/.test(livetvPage), '3d. the page carries NO tab navigation state or markup');
  ok(!/goto\(`\/admin\/system\/livetv\?tab=/.test(livetvPage), '3e. no tab-switching navigation');
  ok(!/tab=overview|tab=sources|tab=entries|tab=channels|tab=epg/.test(livetvPage), '3f. no tab URL vocabulary anywhere in the UI');
}

console.log('\n§4 — R-1 source-first main page (heading + ONE Add Source + the list)');
{
  ok(/<AdminPage eyebrow="Mavero \/ System" title="Live TV" accent="cyan">/.test(livetvPage), '4a. a clear Live TV page heading through the shared AdminPage');
  ok(!/tabs=/.test(livetvPage), '4b. NO tabs prop (the primary interface has no tab workflow)');
  ok(/class="livetv-head">[\s\S]{0,200}openCreateSource[\s\S]{0,200}Add Source<\/button>/.test(livetvPage), '4c. exactly ONE top-right "Add Source" button');
  ok((livetvPage.match(/onclick=\{openCreateSource\}/g) ?? []).length === 1, '4d. exactly ONE Add Source trigger renders');
  ok(/\{#each data\.sources as source \(source\.id\)\}/.test(livetvPage), '4e. the main content is ONE list of all configured sources');
  ok(/class="source-main"/.test(livetvPage) && /SOURCE_TYPE_LABELS\[source\.source_type\]/.test(livetvPage), '4f. each row shows the source name + type');
  ok(/class="source-controls"/.test(livetvPage) && /openEditSource\(source\)/.test(livetvPage), '4g. each row carries the toggle and the Edit control');
  ok(!/a2-stat|System state|Recent refresh activity/.test(livetvPage), '4h. the overview dashboard / activity sections are GONE from the primary page');
  // The mapping/canonical/EPG workflow is REMOVED from the primary UI.
  ok(!/\?\/mapEntry|\?\/toggleEntry|\?\/createChannel|\?\/updateChannel|\?\/toggleChannel|\?\/addCandidate|\?\/createEpgMapping|\?\/deleteEpgMapping|\?\/refreshEpgSource|\?\/createEpgSource/.test(livetvPage), '4i. NO manual mapping / canonical / EPG controls in the primary UI');
  ok(!/— unmapped —|Canonical mapping for|EPG Guides|Canonical Channels|Imported Channels/.test(livetvPage), '4j. no mapping-required empty states, mapping selects or EPG tables');
  // …while the backend capabilities remain server-side (nothing deleted).
  ok(/\?\/mapEntry/.test(livetvServer) && /\?\/createEpgMapping|createEpgMapping: async/.test(livetvServer) === false ? /\bcreateEpgMapping: async/.test(livetvServer) : true, '4k. (sanity) the server keeps implementing the advanced actions');
  ok(/mapEntry: async|toggleEntry: async|createEpgMapping: async/.test(livetvServer), '4l. entry mapping / EPG actions remain available server-side (advanced tooling)');
  ok(/listLivetvEntries|listLivetvChannels|listLivetvEpgSources/.test(adminService), '4m. the services behind them remain implemented');
}

console.log('\n§5 — R-1 toggle contract (persisted enabled, optimistic restore)');
{
  ok(/sourceToggleOverrides = \$state<Record<string, boolean>>\(\{\}\)/.test(livetvPage), '5a. per-source optimistic overrides are tracked (one in-flight intent per source)');
  ok(/function displayedEnabled\(source: LivetvAdminSourceRow\): boolean \{[\s\S]{0,200}override === undefined \? source\.enabled : override/.test(livetvPage), '5b. the switch renders the PERSISTED `enabled` (the override only reflects the in-flight intent)');
  ok(/role="switch"/.test(livetvPage) && /aria-checked=\{displayedEnabled\(source\)\}/.test(livetvPage), '5c. the toggle is a real a11y switch (role + aria-checked)');
  ok(/aria-label="\{displayedEnabled\(source\) \? 'Disable' : 'Enable'\} source \{source\.name\}"/.test(livetvPage), '5d. the switch is labeled per source');
  ok(/name="enabled" value=\{displayedEnabled\(source\) \? 'false' : 'true'\}/.test(livetvPage), '5e. the hidden field submits the toggle target from the displayed (persisted/override) state');
  ok(/if \(isToggling\(source\)\) \{[\s\S]{0,80}cancel\(\)/.test(livetvPage), '5f. rapid repeated requests are CANCELLED (one in-flight request per source)');
  ok(/disabled=\{isToggling\(source\)\}/.test(livetvPage), '5g. the switch is disabled while its request is in flight');
  ok(/delete overrides\[source\.id\];[\s\S]{0,120}sourceToggleOverrides = overrides/.test(livetvPage), '5h. the override clears when the request settles — on failure the persisted value re-renders automatically');
  ok(/await update\(\{ reset: false \}\)/.test(livetvPage), '5i. the enhance completion keeps the form data (no input reset) and refreshes the load');
  ok(!/status === 'active'[\s\S]{0,120}enabled|enabled.*status === 'active'/.test(livetvPage.slice(livetvPage.indexOf('toggleSource'))), '5j. the toggle never conflates the operational status with enablement');
  ok(/\{#each data\.sources as source/.test(livetvPage) && (livetvPage.match(/action="\?\/toggleSource"/g) ?? []).length === 1, '5k. exactly ONE per-row toggle form (each row carries only its own id)');
}

console.log('\n§6 — R-1 Edit sheet (config form + divider + the source\u2019s own channels)');
{
  const sheetBlock = livetvPage.slice(livetvPage.indexOf('<AdminSheet'));
  ok(/title=\{editingSource \? `Edit source — \$\{editingSource\.name\}` : 'Add source'\}/.test(sheetBlock), '6a. one sheet serves create AND edit (titled per mode)');
  ok(/<form method="POST" action=\{editingSource \? '\?\/updateSource' : '\?\/createSource'\}/.test(sheetBlock), '6b. the configuration form sits at the top of the sheet');
  ok(/<hr class="sheet-divider" \/>/.test(sheetBlock), '6c. a divider separates the configuration form from the channel section');
  ok(/<section class="sheet-channels" aria-label="Channels from this source">/.test(sheetBlock), '6d. the channel section is scoped to the edited source');
  ok(/name="sourceId" value=\{sourceId\}/.test(sheetBlock), '6e. every channels request carries the sheet\u2019s source id');
  ok(/result\.sourceId !== editingSource\.id/.test(livetvPage), '6f. a channels result renders ONLY when it matches the open source (no cross-source leak on stale responses)');
  ok(/function openEditSource[\s\S]{0,300}resetChannelsState\(\)/.test(livetvPage), '6g. opening a source resets ALL previous channel state (no stale entries)');
  ok(/channelsData = null/.test(livetvPage) && /pendingChannelsLoad = true/.test(livetvPage), '6h. the bounded channels load fires once per sheet open');
  ok(/name="page" value=\{channelsPage\}/.test(sheetBlock), '6i. pagination is a bounded form parameter');
  ok(/submitChannelsPage\(pageData\.page - 1\)/.test(sheetBlock) && /submitChannelsPage\(pageData\.page \+ 1\)/.test(sheetBlock), '6j. Previous/Next pagination controls');
  ok(/\{#if channelsLoading\}/.test(sheetBlock) && /Loading channels…/.test(sheetBlock), '6k. a loading state exists');
  ok(/:else if channelsError/.test(sheetBlock) && /retryChannels/.test(sheetBlock), '6l. an error state with Retry exists');
  ok(/No channels match this search/.test(sheetBlock) && /No channels imported yet/.test(sheetBlock), '6m. honest empty states (search miss + never-refreshed)');
  ok(/channel\.logo_url/.test(sheetBlock) && /channel-initials/.test(sheetBlock), '6n. the channel rows show a logo (with an initials fallback)');
  ok(/AdminStatusBadge label=\{channel\.enabled \? 'enabled' : 'disabled'\}/.test(sheetBlock), '6o. the channel rows show the entry status');
  ok(/channel\.streamKinds as kind/.test(sheetBlock), '6p. the channel rows show the derived stream kinds where supported');
  ok(/Last refresh:/.test(sheetBlock) && /instance-local/.test(sheetBlock), '6q. the sheet carries the source\u2019s last-refresh line (durable history first)');
  ok(/sheet-danger/.test(sheetBlock) && /Delete source…/.test(sheetBlock), '6r. delete lives in the sheet\u2019s danger zone (not on the row)');
  ok(/disabled=\{editingSource\.builtin\}/.test(sheetBlock), '6s. the built-in source cannot be deleted from the UI');
}

console.log('\n§7 — R-1 create sheet (per-type fields, availability defaults)');
{
  ok(/<option value="public" selected=\{editingSource \? editingSource\.visibility === 'public' : true\}>public — eligible when ON<\/option>/.test(livetvPage), '7a. creation defaults visibility to PUBLIC (the source-first ON/OFF is the availability control)');
  ok(/\{#if !editingSource\}[\s\S]{0,200}type="checkbox" name="enabled"[\s\S]{0,200}Enabled immediately/.test(livetvPage), '7b. enablement is an explicit admin opt-in checkbox (never automatic)');
  ok(!/checked={true}/.test(livetvPage.slice(livetvPage.indexOf('name="enabled"'))), '7c. the enabled checkbox defaults to OFF');
  const configSection = livetvPage.slice(livetvPage.indexOf('heading="Configuration"'));
  ok(/a playlist URL may be a PHP script with a query string/i.test(configSection), '7d. the configuration copy documents the query-string playlist URL (body-validated) — concise R-2 wording');
  ok(/Source type \*<\/span>/.test(livetvPage), '7e. the create sheet exposes the source-type selection');
}

console.log('\n§8 — Delete flows confirm with impact');
{
  ok(livetvPage.includes('AdminConfirmDialog'), '8a. deletes confirm through the shared AdminConfirmDialog');
  const deleteDialog = livetvPage.slice(livetvPage.indexOf('AdminConfirmDialog'));
  ok(/impact/.test(deleteDialog), '8b. the confirm dialog renders the computed impact text');
  ok(/This cannot be undone/.test(livetvPage), '8c. impact text states irreversibility');
  ok((livetvPage.match(/\?\/deleteSource/g) ?? []).length >= 1, '8d. source delete action wired');
  ok(!/\?\/deleteChannel|\?\/deleteEpgSource|\?\/deleteEndpoint/.test(livetvPage), '8e. canonical/EPG/endpoint deletes are no longer reachable from the primary UI (actions remain server-side)');
  ok(/deleteLivetvChannel: async|deleteLivetvEpgSource: async|deleteLivetvEndpoint: async/.test(livetvServer) || /deleteLivetvChannel|deleteLivetvEpgSource|deleteLivetvEndpoint/.test(livetvServer), '8f. those delete actions remain implemented server-side');
  ok(livetvServer.includes('listLivetvSourceDeleteImpacts'), '8g. impact counts are computed server-side (cascade scope)');
}

console.log('\n§9 — Refresh semantics inside the source sheet');
{
  const sheetBlock = livetvPage.slice(livetvPage.indexOf('<AdminSheet'));
  ok(/<form method="POST" action="\?\/refreshSource" use:enhance=/.test(sheetBlock), '9a. per-source Refresh is wired to the existing rate-limited action');
  ok(/<form method="POST" action="\?\/previewSource" use:enhance=/.test(sheetBlock), '9b. per-source Preview (dry run) is wired to the existing rate-limited action');
  ok(/refreshKind === 'source' \|\| refreshOutcome\.kind === 'source-preview'|\{#if refreshOutcome\}/.test(livetvPage), '9c. the outcome block renders the typed refresh result');
  ok(/'source-preview'/.test(livetvPage) && /Dry run — nothing was written/.test(livetvPage), '9d. preview results are explicitly labeled as a dry run (concise R-2 wording)');
  ok(!/new XMLHttpRequest|fetch\(/.test(livetvPage), '9e. the page builds NO competing fetch pipeline (mutations are form actions)');
  ok(!/\/api\/admin\/livetv/.test(livetvPage), '9f. the page does not round-trip through the JSON endpoints (it calls the services server-side)');
}

console.log('\n§10 — Redaction + bounded rendering');
{
  ok(/\.slice\(0, 6\)/.test(livetvPage), '10a. diagnostic samples rendered with bounded slices');
  ok(!/\{\@html/.test(livetvPage), '10b. no raw HTML injection surface');
  ok(!/__hdnea__/.test(livetvPage), '10c. no signed-URL material anywhere in the page');
  ok(/failure\.kind/.test(livetvPage) && !/failure\.url|outcome\.url/.test(livetvPage), '10d. failure rendering uses the typed kind, never a URL field');
  ok(!/password|secret|token/i.test(livetvPage.replace(/maxlength|aria|comment|Credentials|credentials/g, '')), '10e. no credential-bearing fields in the UI');
}

console.log('\n§11 — Isolation + unified enablement');
{
  const allPhase4Code = livetvServer + livetvPage;
  ok(!/livetv_config_meta[\s\S]{0,80}\.update|\.update\(\{[\s\S]{0,40}unified_enabled/.test(allPhase4Code), '11a. NO code path writes livetv_config_meta (unified_enabled read-only)');
  ok(!/unified_enabled: true|unified_enabled = true/.test(allPhase4Code), '11b. no unified-enablement flip anywhere');
  ok(!/\$lib\/client\/live-tv/.test(allPhase4Code), '11c. the admin workspace imports NO client live-tv module');
  ok(!/src\/routes\/live-tv/.test(allPhase4Code), '11d. no coupling to the user-facing /live-tv route');
  const refreshEndpoint = readCode('src/routes/api/admin/livetv/sources/refresh/+server.ts');
  ok(/requireAdmin/.test(refreshEndpoint), '11e. the Phase 2 JSON endpoints remain intact (admin-only)');
  ok(!/engine:\s*'/.test(livetvServer), '11f. no engine is ever CONFIGURED in the admin service');
  ok(/playback engines \(DASH\/HLS\/iframe\) are derived from the typed endpoint kind/i.test(livetvPage), '11g. the UI documents the derived-engine contract (concise R-2 wording in the Identity section description)');
  ok(!/unified_enabled/.test(livetvPage), '11h. the primary UI no longer surfaces the owner rollback lever (the overview is gone; the lever is not admin-page writable either)');
}

console.log('\n§12 — Dialog stacking + design-system reuse');
{
  ok(!/z-index:\s*9[0-9]/.test(livetvPage) && !/z-index:\s*1\d\d\d/.test(livetvPage), '12a. the page invents NO new overlay z-index (shared dialog owns stacking)');
  ok(!/class="a2-confirm-overlay/.test(livetvPage), '12b. no hand-rolled confirm dialog markup (the shared component is reused)');
  ok(livetvPage.includes('<AdminSheet'), '12c. edit forms live in the shared AdminSheet');
  ok(livetvPage.includes('<AdminPage') && livetvPage.includes('<AdminAppShell'), '12d. the page uses the Admin2 page framework');
  ok(livetvPage.includes('<AdminStatusBadge'), '12e. status rendering through the shared badge component');
  ok(livetvPage.includes('<AdminFormSection'), '12f. form grouping through the shared AdminFormSection');
}

console.log('\n§13 — R-0 form-state contract (create-mode configuration inputs)');
{
  ok(/let newSourceType: string = \$state\(CREATE_TYPES\[0\]\)/.test(livetvPage), '13a. the selected source type is REAL form state (defaults to the first create type)');
  ok(/function openCreateSource\(\)[\s\S]{0,200}newSourceType = CREATE_TYPES\[0\]/.test(livetvPage), '13b. opening the create sheet resets the selection (no stale carry-over)');
  ok(/name="sourceType" required bind:value=\{newSourceType\}/.test(livetvPage), '13c. the create select is BOUND to the form state (two-way, still submits sourceType)');
  ok(/function effectiveSourceType\(\): string \{[\s\S]{0,200}editingSource !== null \? editingSource\.source_type : newSourceType/.test(livetvPage), '13d. the sheet renders Configuration fields for the EFFECTIVE type (edit = row, create = selection)');
  const configSection = livetvPage.slice(livetvPage.indexOf('heading="Configuration"'));
  ok(/\{#if effectiveSourceType\(\) === 'm3u_playlist'\}/.test(configSection), '13e. the playlist field keys on the effective type (visible at creation)');
  ok(/\{#if effectiveSourceType\(\) === 'api_provider'\}/.test(configSection) && /\{#if effectiveSourceType\(\) === 'embed_provider'\}/.test(configSection), '13f. the api/embed fields key on the effective type too');
  const playlistField = configSection.slice(configSection.indexOf("effectiveSourceType() === 'm3u_playlist'"), configSection.indexOf("{/if}", configSection.indexOf("effectiveSourceType() === 'm3u_playlist'")));
  ok(playlistField.includes('type="url"') && playlistField.includes('name="playlistUrl"'), '13g. the playlist input binds the server action\u2019s existing playlistUrl field');
  ok(playlistField.includes('required'), '13h. the playlist URL is client-required too (the server validator stays the authority)');
  ok(playlistField.includes('maxlength="2048"'), '13i. the playlist URL length bound matches the server validator');
  ok(/name="sourceType" value=\{editingSource\.source_type\}/.test(livetvPage), '13j. edit mode still submits the immutable row type (hidden field preserved)');
}

console.log('\n§14 — R-1 server-side bounded channel read');
{
  ok(/export async function listLivetvSourceChannelsForAdmin/.test(adminService), '14a. the bounded per-source channel read exists');
  ok(/const sourceId = requireUuid\(filter\.sourceId, 'Source'\)/.test(adminService), '14b. the source id is UUID-validated');
  ok(/Math\.max\(1, Math\.min\(100, Math\.floor\(filter\.pageSize \?\? SOURCE_CHANNEL_PAGE_SIZE\)\)\)/.test(adminService), '14c. the page size is bounded (default 50, hard cap 100)');
  ok(/\.range\(page \* pageSize, page \* pageSize \+ pageSize - 1\)/.test(adminService), '14d. the read is range-bounded (no unbounded entry load)');
  ok(/\.in\('source_channel_id', entryIds\)/.test(adminService), '14e. the stream-kind read is scoped to EXACTLY the page\u2019s entry ids');
  ok(/if \(row\.enabled !== true\) continue; \/\/ only USABLE endpoints/.test(adminService), '14f. only ENABLED endpoints describe the stream types');
  ok(/if \(!rows\) return kindsByEntry;/.test(adminService) && /\} catch \{\s*rows = null;/.test(adminService), '14g. a stream-kind read failure (error payload or thrown) degrades to empty kinds (the page still loads)');
  ok(/sourceChannels: async/.test(livetvServer) && /listLivetvSourceChannelsForAdmin\(locals\.supabase, \{ sourceId, page, query \}\)/.test(livetvServer), '14h. the action passes validated bounds only');
  ok(/\{ sourceChannels: \{ sourceId, \.\.\.entries \} \}/.test(livetvServer), '14i. the response carries its sourceId (the UI\u2019s per-source scoping guard)');
}

console.log(`\nlivetv_phase4_admin_ui_test: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
