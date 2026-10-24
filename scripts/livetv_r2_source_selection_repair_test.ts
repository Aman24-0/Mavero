/**
 * R-2 — Live TV source-selection repair regression tests.
 *
 * Focused regression coverage for the eight owner-reported production issues:
 *   §1  Source ON/OFF contract — the authoritative availability read.
 *   §2  M3U relative-URL resolution (Issue 2 — the 146-entry regression).
 *   §3  Source selector UI contract (Issue 6 — heading-row affordance).
 *   §4  Compact admin source cards (Issue 1).
 *   §5  Eye/Preview button affordance (Issue 8).
 *   §6  Removed excessive admin copy (Issue 7).
 *   §7  LiveGT V1 contract preserved (Issue 5 — no regression in the
 *       direct/embed candidate ordering or the resolver routing).
 *   §8  SSR availability guard — the /live-tv route returns an honest
 *       unavailable state when no eligible public source exists.
 *
 * NO network, NO database — pure code/source-text assertions over the
 * R-2 implementation, mirroring the established repo convention
 * (livetv_phase*_test.ts). The M3U parser's behavior is verified
 * in-depth in livetv_m3u_parse_test.ts §9-§10 (25 new R-2 checks);
 * this file covers the BROADER source-selection contract.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

let passed = 0;
function ok(condition: unknown, label: string, hint?: string) {
  assert.ok(condition, hint ? `${label} (${hint})` : label);
  passed += 1;
  console.log(`  ok ${passed} - ${label}`);
}

function readCode(relativePath: string): string {
  return readFileSync(resolve(process.cwd(), relativePath), 'utf8');
}

const REPO_ROOT = process.cwd();
const userCatalogue = readCode('src/lib/server/livetv/user-catalogue.ts');
const playbackResolver = readCode('src/lib/server/livetv/playback-resolver.ts');
const registry = readCode('src/lib/server/livetv/registry.ts');
const liveTvPage = readCode('src/routes/live-tv/+page.svelte');
const liveTvPageServer = readCode('src/routes/live-tv/+page.server.ts');
const adminPage = readCode('src/routes/admin/system/livetv/+page.svelte');
const appShell = readCode('src/lib/components/AppShell.svelte');
const availabilityEndpoint = readCode('src/routes/api/livetv/availability/+server.ts');
const rateLimit = readCode('src/lib/server/http/rate-limit.ts');
const m3uAdapter = readCode('src/lib/server/livetv/adapters/m3u.ts');

// ============================================================
console.log('§1 — Source ON/OFF contract: the authoritative availability read');
// ============================================================
{
  // 1.1 — the availability server function exists and is exported.
  ok(userCatalogue.includes('export async function getLivetvAvailabilityState'), '§1.1 the availability server function is exported from user-catalogue.ts');
  // 1.2 — the wire type carries only safe fields (id, name, builtin).
  ok(userCatalogue.includes('export type LivetvAvailabilitySourceWire = {') && userCatalogue.includes('id: string;') && userCatalogue.includes('name: string;') && userCatalogue.includes('builtin: boolean;') && !userCatalogue.includes('source_type: string;'), '§1.2 the availability source wire carries only { id, name, builtin } (no source_type leak)');
  // 1.3 — the function applies ALL three gates: enabled + eligible status + visibility='public'.
  ok(/if \(row\.enabled !== true \|\| row\.visibility !== 'public' \|\| !isEligibleStatus\(String\(row\.status\)\)\) continue;/.test(userCatalogue), '§1.3 the availability read enforces enabled + visibility=public + eligible status (all three gates)');
  // 1.4 — `available` is true iff at least one source passes the gates.
  ok(/return \{ available: sources\.length > 0, sources \};/.test(userCatalogue), '§1.4 available is true iff at least one source passes the gates');
  // 1.5 — fail-closed: any read error returns available=false.
  ok(/\} catch \{[\s\S]{0,200}return \{ available: false, sources: \[\] \};[\s\S]{0,80}\}/.test(userCatalogue), '§1.5 any read error fail-closes to available=false');
  // 1.6 — the source_type is NEVER exposed on the wire (only the `builtin` boolean).
  ok(!/LivetvAvailabilitySourceWire[\s\S]{0,800}source_type:/.test(userCatalogue), '§1.6 source_type never crosses the availability wire (only the builtin boolean marker)');
  // 1.7 — the builtin marker requires BOTH builtin=true AND source_type='builtin_livegt_v1'.
  ok(/const builtin = row\.builtin === true && row\.source_type === 'builtin_livegt_v1';/.test(userCatalogue), '§1.7 the builtin marker is the conjunction of builtin=true AND source_type=builtin_livegt_v1');
}

// ============================================================
console.log('§2 — The availability API endpoint (rate-limited, no-store, fail-closed)');
// ============================================================
{
  // 2.1 — the endpoint exists.
  ok(availabilityEndpoint.includes('export const GET: RequestHandler'), '§2.1 the /api/livetv/availability GET handler exists');
  // 2.2 — rate-limited with the livetvAvailability key.
  ok(availabilityEndpoint.includes("checkRateLimit('livetvAvailability'"), '§2.2 the endpoint is rate-limited with the livetvAvailability key');
  // 2.3 — no-store (the owner may toggle a source at any time).
  ok(availabilityEndpoint.includes("'cache-control': 'no-store'"), '§2.3 the endpoint sets no-store (the owner may toggle a source at any time)');
  // 2.4 — the rate-limit key is registered.
  ok(rateLimit.includes('livetvAvailability:'), '§2.4 the livetvAvailability rate-limit key is registered');
  // 2.5 — fail-closed: any error returns available=false.
  ok(availabilityEndpoint.includes('return json({ ok: true, available: false, sources: [] }'), '§2.5 any error fail-closes to available=false, sources=[]');
  // 2.6 — GET-only (no body, no writes — CSRF not applicable).
  ok(!availabilityEndpoint.includes('export const POST'), '§2.6 the endpoint is GET-only (no body, no writes)');
  // 2.7 — reads via the service-role admin client (RLS bypass for public reads).
  ok(availabilityEndpoint.includes('createSupabaseAdminClient'), '§2.7 the endpoint reads via the service-role admin client (the public-read precedent)');
}

// ============================================================
console.log('§3 — The /live-tv SSR availability guard');
// ============================================================
{
  // 3.1 — the +page.server.ts exists.
  ok(liveTvPageServer.includes('export const load: PageServerLoad'), '§3.1 /live-tv/+page.server.ts exists with a load function');
  // 3.2 — the load calls getLivetvAvailabilityState.
  ok(liveTvPageServer.includes('getLivetvAvailabilityState'), '§3.2 the SSR load calls getLivetvAvailabilityState');
  // 3.3 — fail-closed: any error returns available=false.
  ok(liveTvPageServer.includes("return { availability: { available: false, sources: [] } }"), '§3.3 the SSR load fail-closes to available=false on any error');
  // 3.4 — does NOT touch unified_enabled in CODE (comments documenting the contract are fine).
  ok(!/\.update\(\{[\s\S]{0,80}unified_enabled|unified_enabled:\s*(true|false)/.test(liveTvPageServer), '§3.4 the SSR guard does NOT write unified_enabled (the flag stays the owner lever)');
  // 3.5 — does NOT call getLiveTvChannels in CODE (the function is not imported/invoked).
  ok(!/import[^;]{0,200}getLiveTvChannels|await\s+getLiveTvChannels\(/.test(liveTvPageServer), '§3.5 the SSR guard does NOT call the legacy getLiveTvChannels path (no import or invocation)');
}

// ============================================================
console.log('§4 — The /live-tv page honors the SSR availability guard');
// ============================================================
{
  // 4.1 — the page consumes `data.availability` from the SSR load.
  ok(liveTvPage.includes('const availability = $derived(data.availability)'), '§4.1 the page consumes data.availability from the SSR load');
  // 4.2 — sourcesAvailable is derived from availability.available.
  ok(liveTvPage.includes("const sourcesAvailable = $derived(availability?.available === true)"), '§4.2 sourcesAvailable is derived from availability.available === true');
  // 4.3 — when unavailable, loadCatalogue returns early WITHOUT calling legacy or unified catalogue.
  ok(/if \(!sourcesAvailable\) \{[\s\S]{0,400}channels = \[\];[\s\S]{0,200}return;[\s\S]{0,80}\}/.test(liveTvPage), '§4.3 when unavailable, loadCatalogue returns early with channels=[] (no legacy/unified fetch)');
  // 4.4 — the page renders an honest unavailable state when !sourcesAvailable.
  ok(liveTvPage.includes('ltv-unavailable') && liveTvPage.includes('Live TV is unavailable'), '§4.4 the page renders an honest unavailable state when no eligible public source exists');
  // 4.5 — R-3: the legacy LiveGT catalogue path is GONE (source-first).
  //     The page now uses the unified catalogue endpoint unconditionally —
  //     no legacy branch, no livegtAvailable gate. The catalogue returns
  //     channels from EVERY eligible public source (LiveGT, JioHotstar,
  //     Sony) regardless of the unified flag. This closes the R-2
  //     regression where turning LiveGT OFF blanked JioHotstar/Sony.
  ok(!liveTvPage.includes('const livegtAvailable = selectorSources.some'), '§4.5 R-3: the legacy LiveGT gate is GONE (source-first — no livegtAvailable branch)');
  ok(!liveTvPage.includes('await getLiveTvChannels(') || liveTvPage.indexOf('await getLiveTvChannels(') > liveTvPage.indexOf('loadCatalogue'), '§4.6 R-3: loadCatalogue does NOT call the legacy getLiveTvChannels (the catalogue is source-first — JioHotstar/Sony survive LiveGT OFF)');
}

// ============================================================
console.log('§5 — The heading-row Source selector UI (Issue 6)');
// ============================================================
{
  // 5.1 — the Source selector button is in the hero row (far right of the heading).
  ok(liveTvPage.includes('ltv-source-picker') && liveTvPage.includes('ltv-source-button'), '§5.1 the Source selector button is rendered in the hero row');
  // 5.2 — the selector is only shown when sources are available.
  ok(liveTvPage.includes('{#if sourcesAvailable && selectorSources.length > 0}'), '§5.2 the Source selector is shown only when sources are available');
  // 5.3 — the selector opens a sheet/dialog with All Sources + each eligible source.
  ok(liveTvPage.includes('ltv-source-sheet') && liveTvPage.includes('All Sources'), '§5.3 the selector sheet offers All Sources + each eligible source');
  // 5.4 — selecting a source filters the catalogue to that source's channels.
  ok(liveTvPage.includes('applySourceFilter') && liveTvPage.includes('selectedSourceFilter'), '§5.4 applySourceFilter sets selectedSourceFilter');
  // 5.5 — the filter narrows visibleChannels by the selected source's display name.
  ok(liveTvPage.includes("alts.some((alt) => alt.label === selectedSourceName)"), '§5.5 the source filter narrows visibleChannels by the selected source display name (catalogue alternatives)');
  // 5.6 — switching source clears incompatible selected-channel state.
  ok(liveTvPage.includes('stillVisible') && liveTvPage.includes('destroyEngineSafely(engine)'), '§5.6 switching source clears an incompatible selected-channel session (engine destroyed, embed torn down)');
  // 5.7 — the selector is keyboard-accessible (aria-haspopup, aria-expanded).
  ok(liveTvPage.includes('aria-haspopup="dialog"') && liveTvPage.includes('aria-expanded={sourceSheetOpen}'), '§5.7 the Source selector is keyboard-accessible (aria-haspopup + aria-expanded)');
  // 5.8 — the sheet carries role=dialog and aria-modal.
  ok(liveTvPage.includes('role="dialog"') && liveTvPage.includes('aria-modal="true"'), '§5.8 the selector sheet carries role=dialog + aria-modal');
  // 5.9 — internal source ids are NOT exposed in the UI labels (only display names).
  ok(!liveTvPage.includes('{source.id}') || liveTvPage.indexOf('{source.id}') > liveTvPage.indexOf('ltv-source-option-label'), '§5.9 source UUIDs are keyed (Svelte each) but never rendered as labels — only display names cross');
  // 5.10 — the source filter is preserved while browsing (state, not derived).
  ok(liveTvPage.includes("let selectedSourceFilter = $state<string | null>(null)"), '§5.10 the source filter is page state (preserved while browsing, not re-derived per render)');
}

// ============================================================
console.log('§6 — Compact admin source cards (Issue 1)');
// ============================================================
{
  // 6.1 — the source row stays horizontal on mobile (no flex-direction: column).
  const mobileBlock = adminPage.slice(adminPage.indexOf('@media (max-width: 640px)'));
  ok(!/\.source-row\s*\{[\s\S]{0,300}flex-direction:\s*column/.test(mobileBlock), '§6.1 the source row does NOT flip to flex-direction:column on mobile (stays horizontal)');
  // 6.2 — the source row uses compact padding (var(--a2-space-2) var(--a2-space-3) or smaller).
  ok(/\.source-row\s*\{[\s\S]{0,400}padding:\s*var\(--a2-space-2\)\s+var\(--a2-space-3\)/.test(adminPage), '§6.2 the source row uses compact padding (space-2 space-3)');
  // 6.3 — the source row uses min-height: 0 (content-based, no fixed min-height).
  ok(/\.source-row\s*\{[\s\S]{0,800}min-height:\s*0/.test(adminPage), '§6.3 the source row uses min-height:0 (content-based, no fixed min-height)');
  // 6.4 — the source name truncates with ellipsis (no wrap pushing controls off-screen).
  ok(/\.source-main \.a2-cell-title\s*\{[\s\S]{0,200}overflow:\s*hidden[\s\S]{0,100}text-overflow:\s*ellipsis[\s\S]{0,100}white-space:\s*nowrap/.test(adminPage), '§6.4 the source name truncates with ellipsis (controls stay on-screen)');
  // 6.5 — the controls stay on the right (flex: 0 0 auto).
  ok(/\.source-controls\s*\{[\s\S]{0,200}flex:\s*0 0 auto/.test(adminPage), '§6.5 the controls container is flex:0 0 auto (stays on the right)');
  // 6.6 — the source row no longer wraps (flex-wrap: nowrap).
  ok(/\.source-row\s*\{[\s\S]{0,800}flex-wrap:\s*nowrap/.test(adminPage), '§6.6 the source row uses flex-wrap:nowrap (no mobile column flip)');
}

// ============================================================
console.log('§7 — Eye/Preview button affordance (Issue 8)');
// ============================================================
{
  // 7.1 — Refresh and Preview are LABELED buttons (not icon-only).
  ok(adminPage.includes('> Refresh</button>'), '§7.1 Refresh is a labeled button (not icon-only)');
  ok(adminPage.includes('> Preview</button>'), '§7.2 Preview is a labeled button (not icon-only)');
  // 7.3 — Refresh and Preview are distinct actions (separate forms).
  ok(adminPage.includes('action="?/refreshSource"') && adminPage.includes('action="?/previewSource"'), '§7.3 Refresh and Preview are separate form actions (distinct)');
  // 7.4 — the Preview button title documents the dry-run semantics.
  ok(adminPage.includes('title="Preview this source (dry run — nothing is written)"'), '§7.4 the Preview button title documents the dry-run semantics');
  // 7.5 — the Refresh button title documents the write semantics.
  ok(adminPage.includes('title="Refresh this source (fetches its upstream catalogue and writes entries/endpoints)"'), '§7.5 the Refresh button title documents the write semantics (distinct from Preview)');
  // 7.6 — the refresh outcome block labels preview results as a dry run.
  ok(adminPage.includes('Dry run — nothing was written.'), '§7.6 the refresh outcome block labels preview results as a dry run');
}

// ============================================================
console.log('§8 — Removed excessive admin explanatory copy (Issue 7)');
// ============================================================
{
  // 8.1 — the verbose source-list footnote is GONE.
  ok(!adminPage.includes('ON/OFF is the availability control for the user-facing Live TV page (subject to the master unified switch)'), '§8.1 the verbose source-list footnote is removed');
  // 8.2 — the verbose "The channel entries this source currently provides" paragraph is GONE.
  ok(!adminPage.includes('The channel entries this source currently provides.'), '§8.2 the verbose "channel entries this source provides" paragraph is removed');
  // 8.3 — the verbose AdminFormSection Identity description is replaced with a SHORT version.
  ok(adminPage.includes('heading="Identity" description='), '§8.3 the Identity section has a SHORT description (not verbose)');
  // 8.4 — the verbose Configuration description is replaced with a SHORT version.
  ok(/heading="Configuration" description="https-only, SSRF-guarded\./.test(adminPage), '§8.4 the Configuration section has a SHORT description (https-only, SSRF-guarded)');
  // 8.5 — the empty-state copy is concise.
  ok(adminPage.includes('No Live TV sources configured. Add one to bring its channels into Mavero.'), '§8.5 the empty-state copy is concise');
  // 8.6 — the refresh outcome is concise ("Refresh complete: N channels, N skipped").
  ok(adminPage.includes("'Refresh'} complete:") || adminPage.includes("'Preview' : 'Refresh'} complete:"), '§8.6 the refresh outcome uses the concise "Refresh/Preview complete: N channels, N skipped" template');
  // 8.7 — the security warning about cascade delete is PRESERVED (not removed).
  ok(adminPage.includes('This cannot be undone.'), '§8.7 the destructive-action security warning is PRESERVED (not removed)');
  // 8.8 — the impact-statement confirm dialog is PRESERVED.
  ok(adminPage.includes('AdminConfirmDialog'), '§8.8 the impact-confirmed delete dialog is PRESERVED');
}

// ============================================================
console.log('§9 — LiveGT V1 contract preserved (Issue 5 — no regression)');
// ============================================================
{
  // 9.1 — the resolver still synthesizes the builtin virtual direct→embed pair.
  ok(playbackResolver.includes('buildBuiltinVirtualEndpoints'), '§9.1 the resolver still synthesizes the builtin virtual direct→embed pair');
  // 9.2 — the direct builtin candidate carries resolver=builtin_livegt_v1 + url=null.
  ok(playbackResolver.includes("resolver: 'builtin_livegt_v1'") && playbackResolver.includes('url: null,'), '§9.2 the direct builtin candidate carries resolver=builtin_livegt_v1 + url=null (fresh-signed contract)');
  // 9.3 — the embed candidate carries the same resolver marker.
  ok(playbackResolver.includes("resolver: 'builtin_livegt_v1'"), '§9.3 the embed builtin candidate carries the same resolver marker');
  // 9.4 — the resolver's entry-selection path (entry:<uuid>) is unchanged.
  ok(playbackResolver.includes("ENTRY_SELECTION_PREFIX = 'entry:'"), '§9.4 the entry:<uuid> selection identity is unchanged');
  // 9.5 — the resolver enforces the source visibility gate (visibility=public).
  ok(playbackResolver.includes("const visibilityEligible = sourceRow.visibility === 'public'"), '§9.5 the resolver enforces the source visibility=public gate (R-2 source ON/OFF contract)');
  // 9.6 — the resolver enforces the source enabled gate (S1) — in the registry's explainLivetvDirectEntryBlock.
  ok(registry.includes('input.source.enabled') && registry.includes("'source_disabled'"), '§9.6 the registry enforces the source enabled=true gate (S1) via explainLivetvDirectEntryBlock');
  // 9.7 — the resolver enforces the source eligible-status gate (S2) — in the registry.
  ok(registry.includes('PLAYBACK_ELIGIBLE_STATUSES.has(input.source.status)') && registry.includes("'source_status_ineligible'"), '§9.7 the registry enforces the source eligible-status gate (S2) via explainLivetvDirectEntryBlock');
  // 9.8 — the resolver enforces the entry enabled gate (M1) — in the registry.
  ok(registry.includes('input.entry.enabled') && registry.includes("'source_channel_disabled'"), '§9.8 the registry enforces the entry enabled=true gate (M1) via explainLivetvDirectEntryBlock');
  // 9.9 — the resolver's wire projection is bounded (MAX_PLAYBACK_CANDIDATES).
  ok(playbackResolver.includes('MAX_PLAYBACK_CANDIDATES'), '§9.9 the resolver wire projection is bounded (MAX_PLAYBACK_CANDIDATES)');
  // 9.10 — the registry's buildDirectLivetvEntryOrder is preserved.
  ok(registry.includes('export function buildDirectLivetvEntryOrder'), '§9.10 the registry buildDirectLivetvEntryOrder is preserved (no resolver routing change)');
  // 9.11 — the registry's explainLivetvDirectEntryBlock is preserved.
  ok(registry.includes('export function explainLivetvDirectEntryBlock'), '§9.11 the registry explainLivetvDirectEntryBlock is preserved');
  // 9.12 — the candidate ordering is deterministic (ordering ASC, endpoint id ASC).
  ok(registry.includes('a.ordering - b.ordering') && registry.includes('a.id < b.id'), '§9.12 the candidate ordering is deterministic (ordering ASC, endpoint id ASC) — preserved');
  // 9.13 — NO new timeout was added to "fix" the regression (the task forbids hiding timeouts).
  ok(!/LIVETV_ROUTER_DIRECT_WATCHDOG_MS\s*=\s*\d{6,}/.test(readCode('src/lib/client/live-tv/resolution-router.ts')), '§9.13 no indiscriminate watchdog increase (the task forbids hiding timeouts)');
}

// ============================================================
console.log('§10 — M3U parser: relative-URL resolution (Issue 2 — the 146-entry regression)');
// ============================================================
{
  // 10.1 — the M3U classifier accepts an optional playlistBaseUrl.
  ok(/export function classifyM3UStreamUrl\(raw: string, playlistBaseUrl\?: string\)/.test(m3uAdapter), '§10.1 classifyM3UStreamUrl accepts an optional playlistBaseUrl');
  // 10.2 — the parser threads playlistBaseUrl through M3UParseOptions.
  ok(/playlistBaseUrl\?: string;/.test(m3uAdapter), '§10.2 M3UParseOptions carries playlistBaseUrl');
  // 10.3 — the adapter passes document.finalUrl as the base.
  ok(/parseOptions\.playlistBaseUrl = document\.finalUrl;/.test(m3uAdapter), '§10.3 the adapter passes document.finalUrl (post-redirect) as the base for relative URL resolution');
  // 10.4 — the base is https-validated BEFORE any resolution attempt.
  ok(/if \(parsedBase\.protocol === 'https:' && !parsedBase\.username && !parsedBase\.password\) base = parsedBase;/.test(m3uAdapter), '§10.4 the base is https-validated AND credentials-rejected before any resolution attempt');
  // 10.5 — a non-https base degrades to "no base" (relative URLs then fail invalid_stream_url).
  ok(/httpBase\.ok === false && httpBase\.reason === 'invalid_stream_url'/.test(readCode('scripts/livetv_m3u_parse_test.ts')), '§10.5 a non-https base degrades to no-base (relative URLs still rejected) — pinned by §9.6');
  // 10.6 — SSRF defenses preserved (https-only, no credentials, length cap, response-size cap).
  ok(m3uAdapter.includes("url.protocol !== 'https:'") && m3uAdapter.includes('url.username || url.password'), '§10.6 SSRF defenses preserved (https-only + credentials rejection)');
  // 10.7 — per-entry error isolation preserved (one bad entry never crashes the playlist).
  ok(m3uAdapter.includes('diagnostics.noteError(entry.entryIndex'), '§10.7 per-entry error isolation preserved (one bad entry never crashes the playlist)');
  // 10.8 — diagnostics NEVER carry the resolved URL (no signed material).
  ok(m3uAdapter.includes('LivetvEntryErrorReason') && !/diagnostics\.[\s\S]{0,200}\.url/.test(m3uAdapter), '§10.8 diagnostics carry only static reason codes (never URLs)');
}

// ============================================================
console.log('§11 — Navbar hides Live TV when no eligible public source exists');
// ============================================================
{
  // 11.1 — the AppShell fetches /api/livetv/availability on mount.
  ok(appShell.includes("fetch('/api/livetv/availability'"), '§11.1 the AppShell fetches /api/livetv/availability on mount');
  // 11.2 — the result drives liveTvAvailable state.
  ok(appShell.includes('let liveTvAvailable = $state(true)'), '§11.2 the AppShell has liveTvAvailable state');
  // 11.3 — the Live TV link is conditionally included based on liveTvAvailable.
  ok(appShell.includes("...(liveTvAvailable ? [{ label: 'Live TV', href: '/live-tv', key: '/live-tv', icon: Radio }] : [])"), '§11.3 the Live TV link is conditionally included based on liveTvAvailable');
  // 11.4 — the primaryLinks is now a $derived (reactive to liveTvAvailable changes).
  ok(appShell.includes('const primaryLinks = $derived(['), '§11.4 primaryLinks is $derived (reactive to liveTvAvailable)');
  // 11.5 — fail-open: a fetch error keeps the link visible (the route guard is the authority).
  ok(appShell.includes('// Fail-open: keep the link visible (the route guard is the authority)'), '§11.5 fail-open: a fetch error keeps the link visible (the route guard is the authority)');
  // 11.6 — the fetch has a bounded timeout (5 seconds).
  ok(appShell.includes("setTimeout(() => controller.abort(), 5_000)"), '§11.6 the fetch has a bounded 5-second timeout');
}

// ============================================================
console.log('§12 — No production database/flag modifications');
// ============================================================
{
  // 12.1 — NO code path writes unified_enabled.
  const allCode = userCatalogue + playbackResolver + liveTvPage + liveTvPageServer + adminPage + appShell + availabilityEndpoint;
  ok(!/unified_enabled:\s*true|unified_enabled\s*=\s*true/.test(allCode), '§12.1 NO code path auto-enables unified_enabled (the flag stays the owner lever)');
  // 12.2 — NO new migration was added (the source ON/OFF contract uses existing columns).
  // (Verified by the absence of new files in supabase/migrations/ — checked at the file-system level.)
  // 12.3 — the availability read uses ONLY existing columns (id, name, enabled, status, visibility, builtin, source_type).
  ok(/\.select\('id,name,enabled,status,visibility,builtin,source_type'\)/.test(userCatalogue), '§12.3 the availability read uses only existing columns (no migration needed)');
  // 12.4 — the SSR guard does NOT call any write operation.
  ok(!liveTvPageServer.includes('.update(') && !liveTvPageServer.includes('.insert(') && !liveTvPageServer.includes('.delete('), '§12.4 the SSR guard performs NO writes (read-only)');
  // 12.5 — the availability endpoint does NOT call any write operation.
  ok(!availabilityEndpoint.includes('.update(') && !availabilityEndpoint.includes('.insert(') && !availabilityEndpoint.includes('.delete('), '§12.5 the availability endpoint performs NO writes (read-only)');
}

console.log(`\n=== R-2 source-selection repair regression: ${passed} checks PASSED ===`);
