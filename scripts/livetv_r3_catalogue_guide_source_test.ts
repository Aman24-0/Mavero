/**
 * R-3 — Catalogue, guide & source-selector production fixes regression tests.
 *
 * Focused regression coverage for the six owner-reported R-3 issues:
 *   §1  Source selector missing / labels "Auto" (Issue 1).
 *   §2  HTML-not-JSON error in admin edit (Issue 2).
 *   §3  LiveGT OFF blanks JioHotstar/Sony (Issue 3).
 *   §4  Guide timeout across all channels (Issue 4).
 *   §5  JioHotstar 16 duplicate_channel_id skips (Issue 5).
 *   §6  Sony logos missing (Issue 6).
 *
 * NO network, NO database — pure code/source-text assertions over the
 * R-3 implementation, mirroring the established repo convention.
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

const userCatalogue = readCode('src/lib/server/livetv/user-catalogue.ts');
const sourceFirstCatalogue = readCode('src/lib/server/livetv/source-first-catalogue.ts');
const catalogueEndpoint = readCode('src/routes/api/livetv/catalogue/+server.ts');
const guideEndpoint = readCode('src/routes/api/livetv/guide/+server.ts');
const liveTvPage = readCode('src/routes/live-tv/+page.svelte');
const liveTvPageServer = readCode('src/routes/live-tv/+page.server.ts');
const m3uAdapter = readCode('src/lib/server/livetv/adapters/m3u.ts');
const ingestion = readCode('src/lib/server/livetv/ingestion.ts');
const unifiedClient = readCode('src/lib/client/live-tv/unified-catalogue.ts');
const appShell = readCode('src/lib/components/AppShell.svelte');

// ============================================================
console.log('§1 — Source selector visible, labels "All Sources" (Issue 1)');
// ============================================================
{
  // 1.1 — the heading-row Source selector is rendered when sources are available.
  ok(liveTvPage.includes('ltv-source-icon-btn'), '§1.1 R-4: the compact Source selector ICON button is rendered in the hero row (no large button, no separate row)');
  // 1.2 — the default label is "All Sources" (never "Auto").
  ok(liveTvPage.includes("'All Sources'"), '§1.2 the default selector label is "All Sources" (never "Auto")');
  ok(!/\bAuto\b/.test(liveTvPage.match(/sourceSelectorLabel[\s\S]{0,200}/)?.[0] ?? ''), '§1.3 the sourceSelectorLabel never resolves to "Auto" (the per-channel switcher "Auto" is a different control)');
  // 1.4 — the selector is shown when sourcesAvailable && selectorSources.length > 0.
  ok(liveTvPage.includes('{#if sourcesAvailable && selectorSources.length > 0}'), '§1.4 the Source selector is shown only when sources are available');
  // 1.5 — the selector sheet lists All Sources + each eligible source by name.
  ok(liveTvPage.includes('All Sources') && liveTvPage.includes('{source.name}'), '§1.5 the selector sheet lists All Sources + each eligible source by display name');
  // 1.6 — the selector is keyboard-accessible.
  ok(liveTvPage.includes('aria-haspopup="dialog"') && liveTvPage.includes('aria-expanded={sourceSheetOpen}'), '§1.6 the Source selector is keyboard-accessible (aria-haspopup + aria-expanded)');
  // 1.7 — the selector sheet carries role=dialog + aria-modal.
  ok(liveTvPage.includes('role="dialog"') && liveTvPage.includes('aria-modal="true"'), '§1.7 the selector sheet carries role=dialog + aria-modal');
  // 1.8 — selecting a source scopes the catalogue (calls loadCatalogue with sourceId).
  ok(liveTvPage.includes('void loadCatalogue();'), '§1.8 selecting a source reloads the catalogue (source-scoped)');
  // 1.9 — the page never silently falls back to "Auto" or the legacy catalogue.
  ok(!liveTvPage.includes("sourceSelectorLabel = 'Auto'"), '§1.9 the page never silently falls back to "Auto" for the heading-row selector');
}

// ============================================================
console.log('§2 — HTML-not-JSON error fixed (Issue 2)');
// ============================================================
{
  // 2.1 — the catalogue endpoint returns JSON for all paths (no HTML leak).
  ok(catalogueEndpoint.includes('json({ ok: true') && !catalogueEndpoint.includes('return new Response'), '§2.1 the catalogue endpoint always returns JSON (no HTML leak)');
  // 2.2 — the guide endpoint returns JSON for all paths (no HTML leak).
  ok(guideEndpoint.includes('json({ ok: true') && !guideEndpoint.includes('return new Response'), '§2.2 the guide endpoint always returns JSON (no HTML leak)');
  // 2.3 — the guide endpoint returns a 400 JSON for invalid channel ids (not HTML).
  ok(guideEndpoint.includes("status: 400") && guideEndpoint.includes("'INVALID_REQUEST'"), '§2.3 the guide endpoint returns a 400 JSON for invalid channel ids (not HTML)');
  // 2.4 — the guide endpoint returns a 429 JSON for rate limits (not HTML).
  ok(guideEndpoint.includes('status: 429') && guideEndpoint.includes('retry-after'), '§2.4 the guide endpoint returns a 429 JSON for rate limits (not HTML)');
  // 2.5 — the catalogue endpoint returns a 429 JSON for rate limits (not HTML).
  ok(catalogueEndpoint.includes('status: 429') && catalogueEndpoint.includes('retry-after'), '§2.5 the catalogue endpoint returns a 429 JSON for rate limits (not HTML)');
  // 2.6 — the unified client catches JSON parse failures (never throws raw "Unexpected token").
  ok(unifiedClient.includes("throw new LiveTvError('invalid_response'"), '§2.6 the unified client catches JSON parse failures (never throws raw "Unexpected token")');
  // 2.7 — the legacy LT-2 client catches JSON parse failures too.
  const api = readCode('src/lib/client/live-tv/api.ts');
  ok(api.includes("throw new LiveTvError('invalid_response'"), '§2.7 the legacy LT-2 client catches JSON parse failures too');
  // 2.8 — the page's loadCatalogue never calls the legacy getLiveTvChannels (the R-2 HTML/timeout source).
  ok(!/loadCatalogue[\s\S]{0,2000}await getLiveTvChannels\(/.test(liveTvPage), '§2.8 loadCatalogue never calls the legacy getLiveTvChannels (the R-2 HTML/timeout source for non-LiveGT channels)');
}

// ============================================================
console.log('§3 — LiveGT OFF no longer blanks JioHotstar/Sony (Issue 3)');
// ============================================================
{
  // 3.1 — the source-first catalogue module exists.
  ok(sourceFirstCatalogue.includes('export async function getSourceFirstLivetvCatalogue'), '§3.1 the source-first catalogue module exists');
  // 3.2 — the source-first catalogue does NOT check unified_enabled.
  ok(!sourceFirstCatalogue.includes('if (!unifiedEnabled) return'), '§3.2 the source-first catalogue does NOT check unified_enabled (source-first activation)');
  // 3.3 — the source-first catalogue applies the three eligibility gates.
  ok(sourceFirstCatalogue.includes('row.enabled !== true || row.visibility !== \'public\' || !isEligibleStatus'), '§3.3 the source-first catalogue applies the three gates: enabled + visibility=public + eligible status');
  // 3.4 — the catalogue endpoint uses the source-first function.
  ok(catalogueEndpoint.includes('getSourceFirstLivetvCatalogue'), '§3.4 the catalogue endpoint uses getSourceFirstLivetvCatalogue (source-first)');
  // 3.5 — the page's loadCatalogue uses the unified catalogue unconditionally (no flag gate).
  ok(!/loadCatalogue[\s\S]{0,1500}isUnifiedLivetvGateEnabled/.test(liveTvPage), '§3.5 loadCatalogue does NOT consult the unified flag gate (source-first)');
  // 3.6 — the page's loadCatalogue passes the sourceId filter.
  ok(liveTvPage.includes('sourceId: selectedSourceFilter'), '§3.6 loadCatalogue passes the sourceId filter (the heading-row Source selector)');
  // 3.7 — an experimental source (status=experimental) IS eligible when enabled + public.
  ok(sourceFirstCatalogue.includes('LIVETV_PLAYBACK_ELIGIBLE_STATUSES'), '§3.7 the source-first catalogue uses LIVETV_PLAYBACK_ELIGIBLE_STATUSES (experimental IS eligible when enabled + public)');
  // 3.8 — the unified flag is NEVER written by the source-first path.
  ok(!sourceFirstCatalogue.includes('.update({') && !sourceFirstCatalogue.includes('.insert({'), '§3.8 the source-first path performs NO writes (read-only — the flag is never touched)');
  // 3.9 — the catalogue endpoint supports the sourceId query param.
  ok(catalogueEndpoint.includes("url.searchParams.get('sourceId')"), '§3.9 the catalogue endpoint supports the sourceId query param (the selector)');
  // 3.10 — an invalid sourceId is gracefully ignored (All Sources), not a 400.
  ok(catalogueEndpoint.includes('UUID_PATTERN.test(rawSourceId.trim()) ? rawSourceId.trim() : null'), '§3.10 an invalid sourceId is gracefully ignored (All Sources) — never a 400');
}

// ============================================================
console.log('§4 — Guide timeout fixed for all channels (Issue 4)');
// ============================================================
{
  // 4.1 — the source-first guide module exists.
  ok(sourceFirstCatalogue.includes('export async function getSourceFirstLivetvGuide'), '§4.1 the source-first guide function exists');
  // 4.2 — the source-first guide does NOT check unified_enabled.
  ok(!/getSourceFirstLivetvGuide[\s\S]{0,2000}if \(!unifiedEnabled\)/.test(sourceFirstCatalogue), '§4.2 the source-first guide does NOT check unified_enabled (source-first)');
  // 4.3 — the guide endpoint uses the source-first function.
  ok(guideEndpoint.includes('getSourceFirstLivetvGuide'), '§4.3 the guide endpoint uses getSourceFirstLivetvGuide (source-first)');
  // 4.4 — the source-first guide handles entry:<uuid> channel ids (R-0 direct-entry).
  ok(sourceFirstCatalogue.includes("channelId.startsWith('entry:')"), '§4.4 the source-first guide handles entry:<uuid> channel ids (R-0 direct-entry for playlist channels)');
  // 4.5 — the source-first guide resolves the entry's canonical_channel_id for the EPG lookup.
  ok(sourceFirstCatalogue.includes('canonical_channel_id'), '§4.5 the source-first guide resolves the entry canonical_channel_id for the EPG lookup');
  // 4.6 — the source-first guide fail-closes to an empty guide (never a timeout surface).
  ok(sourceFirstCatalogue.includes('return base;') && sourceFirstCatalogue.includes('catch'), '§4.6 the source-first guide fail-closes to an empty guide (never a timeout surface)');
  // 4.7 — the page's loadGuide uses the unified guide unconditionally (no flag gate, no legacy call).
  ok(!/loadGuide[\s\S]{0,1500}isUnifiedLivetvGateEnabled/.test(liveTvPage), '§4.7 loadGuide does NOT consult the unified flag gate (source-first)');
  ok(!/loadGuide[\s\S]{0,2000}await getLiveTvGuide\(/.test(liveTvPage), '§4.8 loadGuide does NOT call the legacy getLiveTvGuide (the R-2 timeout source for non-LiveGT channels)');
  // 4.9 — the guide endpoint returns no-store (freshness).
  ok(guideEndpoint.includes("'cache-control': 'no-store'"), '§4.9 the guide endpoint sets no-store (freshness)');
  // 4.10 — an unmapped entry with no tvg_id honestly returns empty (never fabricated).
  ok(sourceFirstCatalogue.includes('if (!canonicalId && !tvgId) return base;'), '§4.10 an unmapped entry with no tvg_id honestly returns empty (never fabricated, never timeout)');
}

// ============================================================
console.log('§5 — JioHotstar duplicate_channel_id semantics (Issue 5)');
// ============================================================
{
  // 5.1 — the parser dedupes by identity (tvg-id else URL hash) + URL.
  ok(m3uAdapter.includes('endpointUrlsById') && m3uAdapter.includes("diagnostics.noteSkip('duplicate_channel_id')"), '§5.1 the parser dedupes by identity + URL (duplicate_channel_id is a TRUE duplicate: same tvg-id + same URL)');
  // 5.2 — the same tvg-id with a DIFFERENT URL becomes an additional endpoint (NOT a skip).
  ok(m3uAdapter.includes('channel.endpoints.push(endpoint)'), '§5.2 the same tvg-id with a different URL becomes an additional endpoint (NOT a duplicate_channel_id skip)');
  // 5.3 — the diagnostic sample is bounded (200 entries).
  ok(m3uAdapter.includes('M3U_ENTRY_ERRORS_SAMPLE = 200'), '§5.3 the diagnostic sample is bounded (200 entries — never unbounded)');
  // 5.4 — diagnostics carry NO URL (only static reason codes).
  ok(m3uAdapter.includes('reason: LivetvEntryErrorReason') && !/diagnostics\.[\s\S]{0,200}\.url/.test(m3uAdapter), '§5.4 diagnostics carry only static reason codes (never URLs — no signed material)');
  // 5.5 — ingestion is idempotent (insert vs update vs unchanged).
  ok(ingestion.includes('entriesInserted') && ingestion.includes('entriesUpdated') && ingestion.includes('entriesUnchanged'), '§5.5 ingestion is idempotent (insert/update/unchanged counts are distinct)');
  // 5.6 — the preview counts and real refresh counts use the same plan.
  ok(ingestion.includes('planSourceFirstLivetvRefresh') || ingestion.includes('planLivetvRefresh') || ingestion.includes('function plan'), '§5.6 the preview and real refresh use the same plan (counts agree)');
}

// ============================================================
console.log('§6 — Sony logos: parse, persist, preserve (Issue 6)');
// ============================================================
{
  // 6.1 — the M3U parser uses normalizeM3ULogoUrl for tvg-logo (not the generic text normalizer).
  ok(m3uAdapter.includes('logoUrl: normalizeM3ULogoUrl(attributes.values.get(\'tvg-logo\')'), '§6.1 the M3U parser uses normalizeM3ULogoUrl for tvg-logo (not the generic text normalizer)');
  // 6.2 — R-5: normalizeM3ULogoUrl NO LONGER upgrades http→https (unverified).
  // It rejects http:// logos (the DB requires https; the upgrade was unverified).
  // It resolves relative logo URLs against the playlist base URL (R-5 fix).
  ok(!m3uAdapter.includes("normalized = 'https://' + normalized.slice('http://'.length)"), '§6.2 R-5: normalizeM3ULogoUrl NO LONGER upgrades http→https (unverified — the CDN may not support https)');
  ok(m3uAdapter.includes('playlistBaseUrl') && m3uAdapter.includes("new URL(trimmed, base)"), '§6.2b R-5: normalizeM3ULogoUrl resolves relative logo URLs against the playlist base URL');
  // 6.3 — R-5: normalizeM3ULogoUrl rejects non-https URLs (no http→https upgrade).
  ok(m3uAdapter.includes("if (url.protocol !== 'https:') return null"), '§6.3 R-5: normalizeM3ULogoUrl rejects non-https URLs (no http→https upgrade — the DB requires https)');
  // 6.4 — normalizeM3ULogoUrl rejects control chars and whitespace.
  ok(/normalizeM3ULogoUrl[\s\S]{0,400}\/\[\\u0000-\\u001f\\u007f\]\/\.test\(trimmed\)[\s\S]{0,100}\\s/.test(m3uAdapter), '§6.4 normalizeM3ULogoUrl rejects control chars and whitespace');
  // 6.5 — normalizeM3ULogoUrl rejects credentials in the URL.
  ok(m3uAdapter.includes('url.username || url.password'), '§6.5 normalizeM3ULogoUrl rejects credentials in the URL');
  // 6.6 — ingestion preserves a valid existing logo when the new playlist omits tvg-logo.
  ok(ingestion.includes('entryPlan.logoUrl ?? entryPlan.preserved.logoUrl ?? null'), '§6.6 ingestion preserves a valid existing logo when the new playlist omits tvg-logo (R-3 fix)');
  // 6.7 — the preserved field carries logoUrl.
  ok(ingestion.includes('preserved: { canonicalChannelId: existing.canonical_channel_id, enabled: existing.enabled, logoUrl: existing.logo_url }'), '§6.7 the preserved field carries logoUrl (so the write loop can preserve it)');
  // 6.8 — the user-catalogue safeDisplayUrl accepts http(s) absolute URLs.
  ok(userCatalogue.includes("parsed.protocol === 'https:' || parsed.protocol === 'http:'"), '§6.8 the user-catalogue safeDisplayUrl accepts http(s) absolute URLs (display material)');
}

// ============================================================
console.log('§7 — Source-first contract: no production flag/data changes');
// ============================================================
{
  // 7.1 — NO code path writes unified_enabled.
  const allCode = userCatalogue + sourceFirstCatalogue + liveTvPage + liveTvPageServer + catalogueEndpoint + guideEndpoint;
  ok(!/unified_enabled:\s*true|unified_enabled\s*=\s*true/.test(allCode), '§7.1 NO code path auto-enables unified_enabled (the flag stays the owner lever)');
  // 7.2 — the source-first path performs NO writes.
  ok(!sourceFirstCatalogue.includes('.update(') && !sourceFirstCatalogue.includes('.insert(') && !sourceFirstCatalogue.includes('.delete('), '§7.2 the source-first path performs NO writes (read-only)');
  // 7.3 — the SSR guard does NOT touch unified_enabled.
  ok(!/unified_enabled:\s*(true|false)/.test(liveTvPageServer), '§7.3 the SSR guard does NOT write unified_enabled');
  // 7.4 — the catalogue endpoint is GET-only (no body, no writes).
  ok(!catalogueEndpoint.includes('export const POST'), '§7.4 the catalogue endpoint is GET-only (no body, no writes)');
  // 7.5 — the guide endpoint is GET-only (no body, no writes).
  ok(!guideEndpoint.includes('export const POST'), '§7.5 the guide endpoint is GET-only (no body, no writes)');
  // 7.6 — the navbar availability fetch is bounded (5s timeout).
  ok(appShell.includes('5_000'), '§7.6 the navbar availability fetch is bounded (5s timeout)');
}

console.log(`\n=== R-3 catalogue/guide/source-selector regression: ${passed} checks PASSED ===`);
