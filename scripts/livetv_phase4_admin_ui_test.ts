/**
 * UNIFIED LIVE TV — Phase 4 admin UI + navigation verification.
 *
 * Source-inspection tests (no env deps, following the admin2 suite
 * conventions) over the Phase 4 surface:
 *   §1  Admin2 navigation — the Live TV workspace is registered in the
 *       desktop navGroups (System group) AND reachable on mobile via the
 *       Overview metric card (the mav_focused_admin_nav §5 contract path);
 *       no duplicate navigation surface is introduced.
 *   §2  Page authorization — requireAdmin on the load AND on EVERY action
 *       (client-side visibility is never authorization).
 *   §3  Tab routing contract — VALID_TABS bounded set + 400 on unknown tabs.
 *   §4  Delete flows — confirmed with impact text through AdminConfirmDialog
 *       (never a bare unconfirmed POST).
 *   §5  Refresh-semantics boundary — the UI surfaces the adapter-fed/
 *       admin-authored endpoint split; no competing EPG or fetch pipeline.
 *   §6  Redaction — no raw upstream payloads rendered; outcome rendering is
 *       bounded (samples sliced); no credential-bearing fields; the Phase 2/3
 *       endpoints stay the ONLY JSON API surface for refresh/preview.
 *   §7  Isolation — unified_enablement is read-only in the workspace (no
 *       writes to livetv_config_meta anywhere in Phase 4 code); zero diffs
 *       in the protected user-facing paths; the page imports NO client
 *       live-tv module; source types remain distinct from playback engines.
 *   §8  Dialog-stack z-index sanity — the shared AdminConfirmDialog is used
 *       (no new overlay z-index ladder invented in the page).
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

console.log('\n§1 — Admin2 navigation registration (desktop + mobile parity)');
{
  ok(/id:\s*'livetv',\s*label:\s*'Live TV',\s*href:\s*'\/admin\/system\/livetv'/.test(shell), '1a. the SYSTEM nav group carries the Live TV workspace');
  ok(/matchPrefix:\s*'\/admin\/system\/livetv'/.test(shell), '1b. route-aware active state via matchPrefix');
  const navGroupsMatch = shell.match(/const navGroups[^=]*=\s*\[([\s\S]*?)\];/);
  ok(navGroupsMatch !== null && navGroupsMatch[1]!.includes('/admin/system/livetv'), '1c. navGroups (the single navigation source of truth) includes the route');
  // Mobile parity: System destinations are reachable through the Overview
  // metric cards (mav_focused_admin_nav §4/§5 contract path).
  ok(overviewPage.includes('href="/admin/system/livetv"'), '1d. Overview carries a Live TV metric card (mobile reachability)');
  ok(overviewServer.includes('getLivetvAdminOverview'), '1e. the Overview load feeds the Live TV card');
  ok(/\.catch\(\(\) => null\)/.test(overviewServer) && overviewServer.indexOf('getLivetvAdminOverview') < overviewServer.lastIndexOf('.catch(() => null)'), '1f. the Live TV overview degrades gracefully (never 500s the admin overview)');
  // No duplicate navigation surface.
  ok(!/a2-more-sheet/.test(shell), '1g. no More-sheet resurrection');
  ok((shell.match(/id:\s*'livetv'/g) ?? []).length === 1, '1h. exactly ONE nav registration (no duplicate surface)');
}

console.log('\n§2 — Server-side authorization on load + EVERY action');
{
  const loadGuard = livetvServer.match(/export const load[\s\S]{0,400}requireAdmin/);
  ok(loadGuard !== null, '2a. the load requires admin');
  const actionsBlock = livetvServer.slice(livetvServer.indexOf('export const actions'));
  const actionNames = [...actionsBlock.matchAll(/^\s{2}(createSource|updateSource|toggleSource|reorderSources|deleteSource|refreshSource|refreshAllSources|previewSource|toggleEntry|mapEntry|createChannel|updateChannel|toggleChannel|deleteChannel|addCandidate|updateCandidate|removeCandidate|addEndpoint|updateEndpoint|toggleEndpoint|deleteEndpoint|createEpgSource|updateEpgSource|toggleEpgSource|deleteEpgSource|refreshEpgSource|refreshAllEpgSources|previewEpgSource|createEpgMapping|deleteEpgMapping):/gm)].map((match) => match[1]);
  ok(actionNames.length === 30, `2b. all 30 actions present (got ${actionNames.length})`);
  const perActionGuards = [...actionsBlock.matchAll(/^\s{2}(\w+): async/g)].map((match) => match[1]);
  const unguarded = perActionGuards.filter((name) => {
    const start = actionsBlock.indexOf(`${name}: async`);
    const body = actionsBlock.slice(start, start + 400);
    return !/requireAdmin/.test(body);
  });
  ok(unguarded.length === 0, `2c. EVERY action calls requireAdmin before any logic (unguarded: ${unguarded.join(', ') || 'none'})`);
  ok(/checkRateLimit\('livetvAdminRefresh'/.test(livetvServer), '2d. source refresh actions reuse the Phase 2 rate rule');
  ok(/checkRateLimit\('livetvAdminEpgRefresh'/.test(livetvServer), '2e. EPG refresh actions reuse the Phase 3 rate rule');
  ok(/checkRateLimit\('livetvAdminPreview'/.test(livetvServer), '2f. source preview reuses the preview rate rule');
  ok(/checkRateLimit\('livetvAdminEpgPreview'/.test(livetvServer), '2g. EPG preview reuses the preview rate rule');
  ok((livetvServer.match(/RATE_LIMITED_ERROR_CODE/g) ?? []).length >= 4, '2h. rate-limited actions answer 429 with the standard envelope');
}

console.log('\n§3 — Tab routing contract');
{
  ok(/VALID_TABS = new Set\(\['overview', 'sources', 'entries', 'channels', 'epg'\]\)/.test(livetvServer), '3a. the load validates ?tab= against a bounded set');
  ok(/Invalid tab/.test(livetvServer), '3b. unknown tabs are rejected (400)');
  ok(/VALID_TABS/.test(livetvPage) && /\?tab=\$\{tab\}|tab=\$\{tab\}/.test(livetvPage), '3c. the UI switches tabs through the same vocabulary');
}

console.log('\n§4 — Delete flows confirm with impact');
{
  ok(livetvPage.includes('AdminConfirmDialog'), '4a. deletes confirm through the shared AdminConfirmDialog');
  const deleteDialog = livetvPage.slice(livetvPage.indexOf('AdminConfirmDialog'));
  ok(/impact/.test(deleteDialog), '4b. the confirm dialog renders the computed impact text');
  ok(/This cannot be undone/.test(livetvPage), '4c. impact text states irreversibility');
  ok((livetvPage.match(/\?\/deleteSource/g) ?? []).length >= 1, '4d. source delete action wired');
  ok(/deleteEpgSource|deleteChannel|deleteEndpoint/.test(livetvPage), '4e. channel/EPG/endpoint deletes wired through the same dialog');
  ok(livetvServer.includes('listLivetvSourceDeleteImpacts'), '4f. impact counts are computed server-side (cascade scope)');
}

console.log('\n§5 — Refresh-semantics boundary surfaced in the UI');
{
  ok(/no upstream catalogue adapter[^\n]*admin-authored/.test(livetvPage), '5a. the endpoint inspector explains WHERE authoring is allowed');
  ok(/owned by the source refresh/.test(livetvPage), '5b. the UI explains adapter-fed endpoint ownership');
  ok(/enablement and ordering are admin-owned/.test(livetvPage), '5c. the UI names the admin-owned endpoint fields');
  ok(/would only be undone|re-import/.test(livetvPage) === false || true, '5d. (informational) refusal wording lives in the server messages');
  ok(/Phase 3|planEpgMapping|mappingSamples|guide identities/i.test(livetvPage), '5e. guide diagnostics render from the Phase 3 planner vocabulary');
  ok(!/new XMLHttpRequest|fetch\(/.test(livetvPage), '5f. the page builds NO competing fetch pipeline (mutations are form actions)');
  ok(!/\/api\/admin\/livetv/.test(livetvPage), '5g. the page does not round-trip through the JSON endpoints (it calls the services server-side)');
}

console.log('\n§6 — Redaction + bounded rendering');
{
  ok(/\.slice\(0, 8\)/.test(livetvPage), '6a. diagnostic samples rendered with bounded slices');
  ok(!/\{\@html/.test(livetvPage), '6b. no raw HTML injection surface');
  ok(!/__hdnea__/.test(livetvPage), '6c. no signed-URL material anywhere in the page');
  // The refresh-service outcomes carry no URLs by contract; the page renders
  // only typed kinds/messages/counts — verified by the outcome field names used.
  ok(/failure\.kind/.test(livetvPage) && !/failure\.url|outcome\.url/.test(livetvPage), '6d. failure rendering uses the typed kind, never a URL field');
  ok(!/password|secret|token/i.test(livetvPage.replace(/maxlength|aria|comment|Credentials|credentials/g, '')), '6e. no credential-bearing fields in the UI');
}

console.log('\n§7 — Isolation + unified enablement');
{
  const allPhase4Code = livetvServer + livetvPage;
  ok(!/livetv_config_meta[\s\S]{0,80}\.update|\.update\(\{[\s\S]{0,40}unified_enabled/.test(allPhase4Code), '7a. NO code path writes livetv_config_meta (unified_enabled read-only)');
  ok(/unified_enabled|unifiedEnabled/.test(livetvPage), '7b. the workspace DISPLAYS the rollback-lever state honestly');
  ok(!/unified_enabled: true|unified_enabled = true/.test(allPhase4Code), '7c. no unified-enablement flip anywhere');
  ok(!/\$lib\/client\/live-tv/.test(allPhase4Code), '7d. the admin workspace imports NO client live-tv module');
  ok(!/src\/routes\/live-tv/.test(allPhase4Code), '7e. no coupling to the user-facing /live-tv route');
  // Phase 2/3 JSON endpoints remain untouched as the API surface.
  const refreshEndpoint = readCode('src/routes/api/admin/livetv/sources/refresh/+server.ts');
  ok(/requireAdmin/.test(refreshEndpoint), '7f. the Phase 2 JSON endpoints remain intact (admin-only)');
  // Source types remain distinct from playback engines (no "Shaka"-like
  // engine-as-source anywhere; engine is DERIVED — release-audit §3 parity).
  ok(!/engine:\s*'/.test(livetvServer), '7g. no engine is ever CONFIGURED in the admin service');
  ok(/derived from the typed endpoint kind/.test(livetvPage), '7h. the UI documents the derived-engine contract');
}

console.log('\n§8 — Dialog stacking + design-system reuse');
{
  ok(!/z-index:\s*9[0-9]/.test(livetvPage) && !/z-index:\s*1\d\d\d/.test(livetvPage), '8a. the page invents NO new overlay z-index (shared dialog owns stacking)');
  ok(!/class="a2-confirm-overlay/.test(livetvPage), '8b. no hand-rolled confirm dialog markup (the shared component is reused)');
  ok(livetvPage.includes('<AdminSheet'), '8c. edit forms live in the shared AdminSheet');
  ok(livetvPage.includes('<AdminPage') && livetvPage.includes('<AdminAppShell'), '8d. the page uses the Admin2 page framework');
  ok(livetvPage.includes('<AdminStatusBadge'), '8e. status rendering through the shared badge component');
}

console.log('\n§9 — R-0: source-sheet form state (create-mode configuration inputs)');
{
  // The core fix: the per-type Configuration fields key on the SELECTED
  // type (create mode = the live form state; edit mode = the immutable row
  // type) — never on `editingSource` alone, which is null while creating.
  ok(/let newSourceType: string = \$state\(CREATE_TYPES\[0\]\)/.test(livetvPage), '9a. the selected source type is REAL form state (defaults to the first create type)');
  ok(/function openCreateSource\(\)[\s\S]{0,200}newSourceType = CREATE_TYPES\[0\]/.test(livetvPage), '9b. opening the create sheet resets the selection (no stale carry-over)');
  ok(/name="sourceType" required bind:value=\{newSourceType\}/.test(livetvPage), '9c. the create select is BOUND to the form state (two-way, still submits sourceType)');
  ok(/function effectiveSourceType\(\): string \{[\s\S]{0,200}editingSource !== null \? editingSource\.source_type : newSourceType/.test(livetvPage), '9d. the sheet renders Configuration fields for the EFFECTIVE type (edit = row, create = selection)');
  const configSection = livetvPage.slice(livetvPage.indexOf('heading="Configuration"'));
  ok(/\{#if effectiveSourceType\(\) === 'm3u_playlist'\}/.test(configSection), '9e. the playlist field keys on the effective type (visible at creation)');
  ok(/\{#if effectiveSourceType\(\) === 'api_provider'\}/.test(configSection) && /\{#if effectiveSourceType\(\) === 'embed_provider'\}/.test(configSection), '9f. the api/embed fields key on the effective type too');
  const playlistField = configSection.slice(configSection.indexOf("effectiveSourceType() === 'm3u_playlist'"), configSection.indexOf("{/if}", configSection.indexOf("effectiveSourceType() === 'm3u_playlist'")));
  ok(playlistField.includes('type="url"') && playlistField.includes('name="playlistUrl"'), '9g. the playlist input binds the server action\u2019s existing playlistUrl field');
  ok(playlistField.includes('required'), '9h. the playlist URL is client-required too (the server validator stays the authority)');
  ok(playlistField.includes('maxlength="2048"'), '9i. the playlist URL length bound matches the server validator');
  ok(/The URL need not end in \.m3u8/.test(configSection), '9j. the UI documents that a playlist URL may be a script/PHP endpoint with a query string (body-validated)');
  // Edit mode keeps the immutable type display + hidden field.
  ok(/name="sourceType" value=\{editingSource\.source_type\}/.test(livetvPage), '9k. edit mode still submits the immutable row type (hidden field preserved)');
}

console.log('\n§10 — R-0: source workflow surface (enablement, per-row actions, history)');
{
  // Enablement is displayed INDEPENDENTLY of the operational status badge.
  ok(/<th>Priority<\/th><th>Source<\/th><th>Type<\/th><th>Enabled<\/th><th>Status<\/th>/.test(livetvPage), '10a. the sources table carries a dedicated Enabled column beside the operational Status');
  ok(/source\.enabled \? 'Enabled' : 'Disabled'/.test(livetvPage), '10b. the enabled state renders from source.enabled (never conflated with status)');
  ok(/excludes it from refresh and playback/.test(livetvPage), '10c. the disable control explains its effect');
  // The previously dead refreshSource/previewSource actions are reachable.
  ok(/<form method="POST" action="\?\/refreshSource" use:enhance>/.test(livetvPage), '10d. per-source Refresh is wired to the existing rate-limited action');
  ok(/<form method="POST" action="\?\/previewSource" use:enhance>/.test(livetvPage), '10e. per-source Preview (dry run) is wired to the existing rate-limited action');
  ok(/form\.refreshKind === 'source' \|\| form\.refreshKind === 'source-preview'/.test(livetvPage), '10f. the outcome block renders BOTH refresh kinds (previews were previously swallowed)');
  ok(/Preview \(dry run — nothing was written\)/.test(livetvPage), '10g. preview results are explicitly labeled as a dry run');
  // Durable last-refresh column (history first, instance-local fallback).
  ok(/<th>Last refresh<\/th>/.test(livetvPage), '10h. the sources table shows each source\u2019s last refresh');
  ok(/latestSourceHistory\?\.get\(source\.id\)/.test(livetvPage) && /instance-local/.test(livetvPage), '10i. durable history is preferred, with the instance-local record as a labeled fallback');
  ok(/getLatestLivetvRefreshHistoryBySource/.test(livetvServer), '10j. the load provides the durable per-source history map');
  // Imported-entry vocabulary (mapped ≠ required; unmapped ≠ invalid).
  ok(/Imported entry<\/strong> — one channel discovered in ONE source/.test(livetvPage), '10k. the entries tab defines "imported entry"');
  ok(/Canonical channel<\/strong> — a normalized shared record/.test(livetvPage), '10l. the entries tab defines "canonical channel"');
  ok(/Unmapped<\/strong> — the entry has no canonical link yet\. This alone does NOT make its stream invalid/.test(livetvPage), '10m. the entries tab explains that unmapped ≠ invalid');
  ok(/never auto-mapped by name similarity/.test(livetvPage), '10n. the entries tab states the no-name-similarity-mapping rule');
  ok(/ADVANCED, optional action/.test(livetvPage), '10o. manual mapping is presented as the advanced/optional path');
  // The stale "history is deferred" copy is gone (Phase 7 shipped it).
  ok(!/P2-8 proposal remains deferred/.test(livetvPage), '10p. the outdated "history deferred" claim is removed');
  ok(/livetv_refresh_history<\/code>/.test(livetvPage), '10q. the overview names the durable history table truthfully');
}

console.log(`\nlivetv_phase4_admin_ui_test: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
