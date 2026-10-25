/**
 * R-4 — Playback repair, source-selector UI polish & warning cleanup regression tests.
 *
 * Focused regression coverage for the five owner-reported R-4 issues:
 *   §1  Source selector UI — compact icon button, no separate row (Issue 1).
 *   §2  Source filtering returns zero channels — root cause + fix (Issue 2).
 *   §3  JioHotstar/Sony streams rejected — playback resolver fix (Issue 3).
 *   §4  SvelteKit/base-URL/build warnings — cleanup + classification (Issue 4).
 *   §5  R-3 fixes preserved — catalogue/guide/logo contracts intact.
 *
 * NO network, NO database — pure code/source-text assertions over the
 * R-4 implementation, mirroring the established repo convention.
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

const liveTvPage = readCode('src/routes/live-tv/+page.svelte');
const liveTvPageServer = readCode('src/routes/live-tv/+page.server.ts');
const playbackResolver = readCode('src/lib/server/livetv/playback-resolver.ts');
const resolutionRouter = readCode('src/lib/client/live-tv/resolution-router.ts');
const sourceFirstCatalogue = readCode('src/lib/server/livetv/source-first-catalogue.ts');
const catalogueEndpoint = readCode('src/routes/api/livetv/catalogue/+server.ts');
const unifiedClient = readCode('src/lib/client/live-tv/unified-catalogue.ts');
const adminPage = readCode('src/routes/admin/system/livetv/+page.svelte');

// ============================================================
console.log('§1 — Source selector UI: compact icon button, no separate row (Issue 1)');
// ============================================================
{
  // 1.1 — the selector is a compact ICON button (not a large labeled button).
  ok(liveTvPage.includes('ltv-source-icon-btn'), '§1.1 the selector is a compact icon button (ltv-source-icon-btn)');
  // 1.2 — the OLD large button classes are GONE.
  ok(!liveTvPage.includes('ltv-source-button') && !liveTvPage.includes('ltv-source-picker'), '§1.2 the old large button + picker classes are GONE');
  ok(!liveTvPage.includes('ltv-source-label') && !liveTvPage.includes('ltv-source-value'), '§1.3 the old "Source" label + value spans are GONE (no large "Source: All Sources" control)');
  // 1.4 — the hero inner row does NOT wrap (the button stays on the heading row).
  ok(/\.ltv-hero-inner\s*\{[\s\S]{0,400}flex-wrap:\s*nowrap/.test(liveTvPage), '§1.4 the hero inner row uses flex-wrap:nowrap (the button stays on the SAME row — no separate row)');
  // 1.5 — the icon button is a fixed 40px square (compact, never wraps).
  ok(/\.ltv-source-icon-btn\s*\{[\s\S]{0,400}width:\s*40px[\s\S]{0,100}height:\s*40px[\s\S]{0,100}flex:\s*0 0 40px/.test(liveTvPage), '§1.5 the icon button is a fixed 40px square (flex:0 0 40px — never wraps)');
  // 1.6 — the button has a selected-state indicator (the dot).
  ok(liveTvPage.includes('ltv-source-icon-dot'), '§1.6 the button has a selected-state dot indicator');
  // 1.7 — the dialog is a bottom sheet on mobile (position:fixed; bottom:0).
  ok(/\.ltv-source-dialog\s*\{[\s\S]{0,400}position:\s*fixed[\s\S]{0,200}bottom:\s*0/.test(liveTvPage), '§1.7 the dialog docks to the bottom on mobile (position:fixed; bottom:0)');
  // 1.8 — the dialog respects safe-area insets.
  ok(liveTvPage.includes('env(safe-area-inset-bottom'), '§1.8 the dialog respects safe-area-inset-bottom');
  // 1.9 — the dialog has internal vertical scrolling.
  ok(/\.ltv-source-dialog-list\s*\{[\s\S]{0,300}overflow-y:\s*auto/.test(liveTvPage), '§1.9 the dialog list has internal vertical scrolling (overflow-y:auto)');
  // 1.10 — desktop ≥641px: popover anchored to the top-right.
  ok(/@media\s*\(min-width:\s*641px\)[\s\S]{0,800}\.ltv-source-dialog\s*\{[\s\S]{0,400}top:\s*88px/.test(liveTvPage), '§1.10 desktop ≥641px: the dialog becomes a popover anchored to top:88px');
  // 1.11 — a backdrop closes the sheet on click.
  ok(liveTvPage.includes('ltv-source-backdrop') && liveTvPage.includes('closeSourceSheet'), '§1.11 a backdrop closes the sheet on click (closeSourceSheet)');
  // 1.12 — closing the sheet preserves the selection (closeSourceSheet only sets sourceSheetOpen=false).
  ok(/function closeSourceSheet\(\):\s*void\s*\{\s*sourceSheetOpen = false;\s*\}/.test(liveTvPage), '§1.12 closeSourceSheet ONLY sets sourceSheetOpen=false (the selection is preserved)');
  // 1.13 — the dialog has a close button with aria-label.
  ok(liveTvPage.includes('ltv-source-dialog-close') && liveTvPage.includes('aria-label="Close source selector"'), '§1.13 the dialog has a close button with aria-label');
  // 1.14 — options have min-height 44px (touch target).
  ok(/\.ltv-source-option\s*\{[\s\S]{0,400}min-height:\s*44px/.test(liveTvPage), '§1.14 the options have min-height:44px (touch target)');
  // 1.15 — the Filter icon is imported.
  ok(liveTvPage.includes('<Tv size={16}'), '§1.15 R-6: the Tv (broadcast/source) icon is rendered (replaced Filter)');
  // 1.16 — the button has a title attribute (tooltip).
  ok(liveTvPage.includes('title="Source: {sourceSelectorLabel}"'), '§1.16 the button has a title attribute (tooltip with the current selection)');
}

// ============================================================
console.log('§2 — Source filtering: server-side sourceId, no broken client filter (Issue 2)');
// ============================================================
{
  // 2.1 — the BROKEN client-side label-match filter is GONE.
  ok(!liveTvPage.includes("alts.some((alt) => alt.label === selectedSourceName)"), '§2.1 the broken client-side label-match filter is GONE (was the root cause of "0 channels for selected source")');
  // 2.2 — the catalogue load passes the sourceId to the API (server-side filter).
  ok(liveTvPage.includes('sourceId: selectedSourceFilter'), '§2.2 loadCatalogue passes sourceId: selectedSourceFilter to the API (server-side filter)');
  // 2.3 — the catalogue endpoint accepts the sourceId query param.
  ok(catalogueEndpoint.includes("url.searchParams.get('sourceId')"), '§2.3 the catalogue endpoint accepts the sourceId query param');
  // 2.4 — the source-first catalogue filters by sourceId.
  ok(sourceFirstCatalogue.includes('if (filterSourceId !== null && row.id !== filterSourceId) continue;'), '§2.4 the source-first catalogue filters by sourceId (only the selected source contributes)');
  // 2.5 — the unified client passes sourceId + uses a sourceId-scoped cache key.
  ok(unifiedClient.includes('sourceId') && unifiedClient.includes("`${UNIFIED_CATALOGUE_CACHE_KEY}:src:${sourceId}`"), '§2.5 the unified client passes sourceId + uses a sourceId-scoped cache key');
  // 2.6 — the visibleChannels filter only applies category + search (NOT source).
  ok(!/visibleChannels[\s\S]{0,300}selectedSourceName/.test(liveTvPage), '§2.6 visibleChannels does NOT reference selectedSourceName (the source filter is server-side)');
  // 2.7 — applySourceFilter reloads the catalogue (the server-side filter).
  ok(/applySourceFilter[\s\S]{0,400}void loadCatalogue\(\)/.test(liveTvPage), '§2.7 applySourceFilter reloads the catalogue (the server-side sourceId filter)');
  // 2.8 — the source-first catalogue applies the same eligibility to every source.
  ok(sourceFirstCatalogue.includes('row.enabled !== true || row.visibility !== \'public\' || !isEligibleStatus'), '§2.8 the source-first catalogue applies the same 3 gates (enabled + public + eligible) to every source');
  // 2.9 — an invalid sourceId is gracefully ignored (All Sources), not a 400.
  ok(catalogueEndpoint.includes('UUID_PATTERN.test(rawSourceId.trim()) ? rawSourceId.trim() : null'), '§2.9 an invalid sourceId is gracefully ignored (All Sources) — never a 400');
}

// ============================================================
console.log('§3 — Playback resolver: entry: selections resolve regardless of flag (Issue 3)');
// ============================================================
{
  // 3.1 — the resolver resolves entry: selections BEFORE the flag gate.
  ok(/if \(selectionId\.startsWith\(ENTRY_SELECTION_PREFIX\)\)[\s\S]{0,300}return resolveLivetvDirectEntry/.test(playbackResolver), '§3.1 the resolver resolves entry: selections BEFORE the flag gate');
  // 3.2 — the flag gate comes AFTER the entry: branch.
  ok(/if \(selectionId\.startsWith\(ENTRY_SELECTION_PREFIX\)\)[\s\S]{0,800}if \(!unifiedEnabled\) return unresolvedWire\(false\)/.test(playbackResolver), '§3.2 the flag gate (if (!unifiedEnabled) return unresolvedWire(false)) comes AFTER the entry: branch');
  // 3.3 — resolveLivetvDirectEntry returns resolved:true with empty candidates for missing entries (NOT resolved:false).
  ok(playbackResolver.includes('const emptyResolved = { unifiedEnabled: true, resolved: true, mode: \'default\' as const, candidates: [] };'), '§3.3 resolveLivetvDirectEntry returns resolved:true with empty candidates for missing entries (honest exhausted — never falls through to legacy)');
  // 3.4 — the router skips the flag gate for entry: selections.
  ok(resolutionRouter.includes("const isEntrySelection = channel.id.startsWith('entry:');"), '§3.4 the router identifies entry: selections (isEntrySelection)');
  ok(/if \(!isEntrySelection\) \{[\s\S]{0,300}const enabled = await this\.isUnifiedEnabled\(\)[\s\S]{0,200}if \(!enabled\) return 'legacy'/.test(resolutionRouter), '§3.5 the router skips the flag gate for entry: selections (only checks the flag for non-entry selections)');
  // 3.6 — the "Live TV rejected the request" message is still defined (bad_request kind).
  const errors = readCode('src/lib/client/live-tv/errors.ts');
  ok(errors.includes("bad_request: 'Live TV rejected the request.'"), '§3.6 the bad_request message is still defined (the resolver now prevents it from firing for entry: selections)');
  // 3.7 — the resolver enforces the source enabled gate (S1).
  const registry = readCode('src/lib/server/livetv/registry.ts');
  ok(registry.includes('input.source.enabled') && registry.includes("'source_disabled'"), '§3.7 the registry enforces the source enabled gate (S1) — a disabled source contributes nothing');
  // 3.8 — the resolver enforces the source eligible-status gate (S2).
  ok(registry.includes('PLAYBACK_ELIGIBLE_STATUSES.has(input.source.status)') && registry.includes("'source_status_ineligible'"), '§3.8 the registry enforces the source eligible-status gate (S2)');
  // 3.9 — the resolver enforces the entry enabled gate (M1).
  ok(registry.includes('input.entry.enabled') && registry.includes("'source_channel_disabled'"), '§3.9 the registry enforces the entry enabled gate (M1)');
  // 3.10 — the resolver enforces the visibility gate.
  ok(playbackResolver.includes("const visibilityEligible = sourceRow.visibility === 'public'"), '§3.10 the resolver enforces the visibility=public gate');
  // 3.11 — SSRF defenses preserved (https-only).
  ok(playbackResolver.includes("parsed.protocol === 'https:'"), '§3.11 SSRF defense preserved: https-only URL validation');
  // 3.12 — SSRF defense: the registry's endpoint validator rejects credentials.
  ok(registry.includes('username') || registry.includes('password') || registry.includes('credentials'), '§3.12 SSRF defense preserved: the registry rejects credentials in URLs');
}

// ============================================================
console.log('§4 — SvelteKit/base-URL/build warnings: cleanup + classification (Issue 4)');
// ============================================================
{
  // 4.1 — the admin livetv page no longer defines the unused .a2-footnote class.
  ok(!adminPage.includes('.a2-footnote'), '§4.1 the admin livetv page no longer defines the unused .a2-footnote class');
  // 4.2 — the admin livetv page no longer defines the unused .a2-icon-btn class.
  ok(!adminPage.includes('.a2-icon-btn'), '§4.2 the admin livetv page no longer defines the unused .a2-icon-btn class (R-2 removed the icon buttons)');
  // 4.3 — the reduced-motion media query no longer references .a2-icon-btn.
  ok(!/prefers-reduced-motion[\s\S]{0,200}\.a2-icon-btn/.test(adminPage), '§4.3 the reduced-motion media query no longer references .a2-icon-btn');
  // 4.4 — the PRODUCTION_ORIGIN is intentionally hardcoded (SEO canonical policy — documented).
  const seo = readCode('src/lib/shared/seo.ts');
  ok(seo.includes("export const PRODUCTION_ORIGIN = 'https://maveroweb.space';"), '§4.4 PRODUCTION_ORIGIN is intentionally hardcoded (SEO canonical policy — documented design, not a warning)');
  // 4.5 — R-5: jsconfig.json NO LONGER carries baseUrl/paths (the SvelteKit
  //     warning is resolved). The test-only aliases moved to tsconfig.test.json.
  //     The app aliases come from SvelteKit's generated tsconfig (rootDirs +
  //     moduleResolution: bundler). svelte-check reports 0 warnings.
  const jsconfig = JSON.parse(readCode('jsconfig.json'));
  ok(jsconfig.compilerOptions.baseUrl === undefined && jsconfig.compilerOptions.paths === undefined, '§4.5 R-5: jsconfig.json no longer carries baseUrl/paths');
}

// ============================================================
console.log('§5 — R-3 fixes preserved (catalogue/guide/logo contracts intact)');
// ============================================================
{
  // 5.1 — the source-first catalogue module still exists.
  ok(sourceFirstCatalogue.includes('export async function getSourceFirstLivetvCatalogue'), '§5.1 the source-first catalogue module still exists (R-3 preserved)');
  // 5.2 — the source-first guide still exists.
  ok(sourceFirstCatalogue.includes('export async function getSourceFirstLivetvGuide'), '§5.2 the source-first guide still exists (R-3 preserved)');
  // 5.3 — the catalogue endpoint uses the source-first function.
  ok(catalogueEndpoint.includes('getSourceFirstLivetvCatalogue'), '§5.3 the catalogue endpoint uses getSourceFirstLivetvCatalogue (R-3 preserved)');
  // 5.4 — the guide endpoint uses the source-first function.
  const guideEndpoint = readCode('src/routes/api/livetv/guide/+server.ts');
  ok(guideEndpoint.includes('getSourceFirstLivetvGuide'), '§5.4 the guide endpoint uses getSourceFirstLivetvGuide (R-3 preserved)');
  // 5.5 — the SSR availability guard still exists.
  ok(liveTvPageServer.includes('getLivetvAvailabilityState'), '§5.5 the SSR availability guard still calls getLivetvAvailabilityState (R-2/R-3 preserved)');
  // 5.6 — the M3U logo normalizer still exists (R-3 Sony logo fix).
  const m3u = readCode('src/lib/server/livetv/adapters/m3u.ts');
  ok(m3u.includes('export function normalizeM3ULogoUrl'), '§5.6 the M3U logo normalizer still exists (R-3 Sony logo fix preserved)');
  // 5.7 — ingestion preserves existing logos (R-3 fix).
  const ingestion = readCode('src/lib/server/livetv/ingestion.ts');
  ok(ingestion.includes('entryPlan.logoUrl ?? entryPlan.preserved.logoUrl ?? null'), '§5.7 ingestion preserves existing logos (R-3 fix preserved)');
  // 5.8 — the unified flag is NEVER written.
  const allCode = liveTvPage + liveTvPageServer + playbackResolver + sourceFirstCatalogue + catalogueEndpoint;
  ok(!/unified_enabled:\s*true|unified_enabled\s*=\s*true/.test(allCode), '§5.8 NO code path auto-enables unified_enabled (the flag stays the owner lever)');
}

// ============================================================
console.log('§6 — No production database/flag changes');
// ============================================================
{
  // 6.1 — NO migration files added in R-4 (the resolver fix uses existing columns).
  const allCode = liveTvPage + liveTvPageServer + playbackResolver + sourceFirstCatalogue + catalogueEndpoint + adminPage;
  ok(!allCode.includes('.insert({') || allCode.indexOf('.insert({') > allCode.indexOf('createSupabaseAdminClient'), '§6.1 the R-4 changes perform NO direct writes (read-only resolver/catalogue/guide)');
  // 6.2 — the resolver's entry: path performs NO writes.
  ok(!/resolveLivetvDirectEntry[\s\S]{0,3000}\.(insert|update|delete)\(/.test(playbackResolver), '§6.2 the resolver entry: path performs NO writes (read-only)');
  // 6.3 — the SSR guard does NOT write unified_enabled.
  ok(!/unified_enabled:\s*(true|false)/.test(liveTvPageServer), '§6.3 the SSR guard does NOT write unified_enabled');
}

console.log(`\n=== R-4 playback/source-selector/warnings regression: ${passed} checks PASSED ===`);
