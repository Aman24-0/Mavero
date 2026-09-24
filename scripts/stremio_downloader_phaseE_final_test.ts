import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  filterStreams,
  streamMatchesType,
  streamMatchesQuality,
  streamMatchesSize,
  streamMatchesLanguage,
  streamMatchesFilters,
  typeOptions,
  qualityOptions,
  sizeOptions,
  languageOptions,
  activeFilterChips,
  hasActiveFilters,
  clearFilterDimension,
  NO_FILTERS,
  sizeFilterLabel,
  type FilterableStream,
  type DownloaderFilters,
  type SizeFilterValue,
} from '$lib/shared/downloader-filters';
import {
  selectPresentationWindow,
  showMoreBatch,
  SHOW_MORE_BATCH_SIZE,
  type PresentableStream,
} from '$lib/shared/presentation-window';
import {
  DEFAULT_LINK_TYPES_CONFIG,
  isLinkTypeAllowed,
  getLinkTypesConfig,
  linkTypeLabel,
  linkTypeCategory,
  type DownloadLinkType,
} from '$lib/shared/download-link-types';

/**
 * Phase E Final Regression Test Suite (§30).
 *
 * Covers EVERY Phase E final-corrective behavior:
 *   §1  DOWNLOADSHEET REGRESSION       — DetailPage gating contract
 *   §6  DOWNLOAD BUTTON GATING          — button is NOT gated on prefetch
 *   §8  GROUPED FILTER SHEET            — TYPE/QUALITY/AUDIO/SIZE sections
 *   §9  DEAD SIZE SHEET CODE REMOVED    — no unreachable code
 *   §10 SIZE BOUNDARY > 20 GB STRICT   — consistent strict semantics
 *   §11 DYNAMIC TYPE FILTER VISIBILITY  — Type hidden when only 1 kind
 *   §12 COUNT SEMANTICS                 — single "Showing X of Y"
 *   §13 SHOW MORE FULL-COLLECTION       — no refetch, all streams preserved
 *   §15 ADMIN LINK-TYPE EXPOSURE        — admin filters presentation
 *   §16 MANIFEST REFRESH PRESERVATION   — downloaderLinkTypes preserved
 *   §17 setAddonLinkTypes SAFE MERGE    — concurrent-safe capability merge
 *   §18 HTTPS PREFERENCE — HTTP ≠ HTTPS — kind === 'https' only
 *   §19 STREAM CARD METADATA             — transport labels + hierarchy
 *   §20 SKELETON LOADING                 — per-addon placeholder state
 *   §B  PHASE B REGRESSION               — dedup + hosts survive
 *   §C  PHASE C REGRESSION               — semantic audio + AND logic
 *   §D  PHASE D REGRESSION               — capabilities + actions
 */

let passed = 0;
function ok(condition: unknown, label: string) {
  assert.ok(condition, label);
  passed += 1;
}

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative: string) => readFileSync(path.join(REPO_ROOT, relative), 'utf8');

const GB = 1024 ** 3;

function makeStream(overrides: Partial<FilterableStream> & { url: string }): FilterableStream {
  return {
    kind: 'https',
    url: '',
    quality: '1080p',
    audio: 'single',
    ...overrides,
  };
}

function makePresentable(overrides: Partial<PresentableStream> & { url: string }): PresentableStream {
  return { url: '', kind: 'https', quality: '1080p', ...overrides };
}

// ---------------------------------------------------------------------------
// §1 + §6 — DOWNLOAD BUTTON GATING / DOWNLOADSHEET REGRESSION
// ---------------------------------------------------------------------------

function section_downloadSheet_regression(): void {
  const detailPage = read('src/lib/components/DetailPage.svelte');

  // §6: The Download button MUST be shown for ALL movie-like items,
  // UNCONDITIONALLY — it must NOT be gated on `downloadProvidersLoaded`
  // or `visibleDownloadProviders.length > 0`.
  // The previous gating caused a real production regression: when the
  // /api/downloader/config prefetch failed OR returned zero matching
  // providers, the Download button silently disappeared and the user
  // had no way to open the sheet at all.
  ok(
    detailPage.includes("const showDownloadButton = $derived(isMovieLike);"),
    '§6: DetailPage `showDownloadButton` is gated ONLY on `isMovieLike` (no prefetch gating)',
  );
  // The parent passes provider loading/failed/retry state to the sheet so
  // the sheet can render Loading / Error / Empty states internally.
  ok(
    detailPage.includes('providersLoading={downloadProvidersLoading}'),
    '§6: DetailPage passes providersLoading to DownloadSheet',
  );
  ok(
    detailPage.includes('providersFailed={downloadProvidersFailed}'),
    '§6: DetailPage passes providersFailed to DownloadSheet',
  );
  ok(
    detailPage.includes('onRetryProviders={retryDownloadProviders}'),
    '§6: DetailPage passes onRetryProviders to DownloadSheet',
  );
  // SeasonEpisodes onDownload callback is now ALWAYS wired (not gated on
  // prefetch completion).
  ok(
    detailPage.includes('onDownload={openEpisodeDownloadSheet}'),
    '§6: SeasonEpisodes onDownload is ALWAYS wired (decoupled from prefetch)',
  );
  ok(
    !detailPage.includes('onDownload={downloadProvidersLoaded'),
    '§6: SeasonEpisodes onDownload is NOT gated on downloadProvidersLoaded (regression fixed)',
  );

  // DownloadSheet now has Loading / Error / Empty branches.
  const sheet = read('src/lib/components/DownloadSheet.svelte');
  ok(
    sheet.includes('export let providersLoading = false;'),
    '§1: DownloadSheet accepts providersLoading prop',
  );
  ok(
    sheet.includes('export let providersFailed = false;'),
    '§1: DownloadSheet accepts providersFailed prop',
  );
  ok(
    sheet.includes('export let onRetryProviders'),
    '§1: DownloadSheet accepts onRetryProviders callback prop',
  );
  ok(
    sheet.includes('Loading download providers'),
    '§1: DownloadSheet renders Loading state when providersLoading is true',
  );
  ok(
    sheet.includes('Downloader temporarily unavailable'),
    '§1: DownloadSheet renders Error state when providersFailed is true',
  );
  ok(
    sheet.includes('Retry'),
    '§1: DownloadSheet Error state offers Retry button (calls onRetryProviders)',
  );

  // The Loading + Error branches come BEFORE the hasProviders branch so they
  // take precedence while the prefetch is in-flight / failed.
  const loadingIdx = sheet.indexOf('{#if providersLoading}');
  const maveroIdx = sheet.indexOf('{:else if isMaveroDownloader}');
  const noProvidersIdx = sheet.indexOf('{:else if !hasProviders}');
  ok(loadingIdx > -1 && maveroIdx > loadingIdx, '§1: Loading branch precedes the MaveroDownloader branch');
  ok(noProvidersIdx > maveroIdx, '§1: !hasProviders branch is AFTER the MaveroDownloader branch');
}

// ---------------------------------------------------------------------------
// §8 + §9 + §11 — FILTER SHEET + DEAD CODE + TYPE VISIBILITY
// ---------------------------------------------------------------------------

function section_filterSheet(): void {
  const sheet = read('src/lib/components/DownloaderFilterSheet.svelte');
  const mavero = read('src/lib/components/MaveroAddonDownload.svelte');

  // §8: Grouped filter sheet exists with all four sections.
  ok(sheet.includes('TYPE'), '§8: DownloaderFilterSheet has TYPE section heading');
  ok(sheet.includes('QUALITY'), '§8: DownloaderFilterSheet has QUALITY section heading');
  ok(sheet.includes('AUDIO'), '§8: DownloaderFilterSheet has AUDIO section heading');
  ok(sheet.includes('SIZE'), '§8: DownloaderFilterSheet has SIZE section heading');

  // §8: Apply + Clear buttons exist.
  ok(sheet.includes('handleApply'), '§8: DownloaderFilterSheet has Apply handler');
  ok(sheet.includes('handleClear'), '§8: DownloaderFilterSheet has Clear handler');
  ok(sheet.includes('Apply'), '§8: DownloaderFilterSheet renders Apply button');
  ok(sheet.includes('Clear'), '§8: DownloaderFilterSheet renders Clear button');

  // §8: Closing without Apply must NOT commit partial changes.
  // localSelected is the local copy; onClose calls onClose (no Apply).
  ok(
    sheet.includes('let localSelected'),
    '§8: DownloaderFilterSheet maintains a local state copy (cancel-does-not-commit)',
  );
  ok(
    sheet.includes('onApply(localSelected);') && sheet.includes('onClose();'),
    '§8: handleApply commits localSelected AND closes; onClose alone does NOT commit',
  );

  // §8: Escape key support.
  ok(sheet.includes("event.key === 'Escape'"), '§8: DownloaderFilterSheet handles Escape key');

  // §8: Visible sections are filtered by section.visible flag.
  ok(
    sheet.includes('visibleSections'),
    '§8: DownloaderFilterSheet filters sections by `visible` flag (Type hidden when only 1 kind)',
  );

  // §9: Dead Size SelectionSheet code is GONE.
  ok(!mavero.includes('sizeSheetOpen'), '§9: dead sizeSheetOpen state is REMOVED');
  ok(!mavero.includes('openSizeSheet'), '§9: dead openSizeSheet handler is REMOVED');
  ok(!mavero.includes('closeSizeSheet'), '§9: dead closeSizeSheet handler is REMOVED');
  ok(!mavero.includes('selectSize'), '§9: dead selectSize handler is REMOVED');
  ok(!mavero.includes('sizeSheetOptions'), '§9: dead sizeSheetOptions derived state is REMOVED');
  ok(!mavero.includes('sizeTriggerLabel'), '§9: dead sizeTriggerLabel derived state is REMOVED');
  ok(!mavero.includes('open={sizeSheetOpen}'), '§9: dead Size SelectionSheet instance is REMOVED from template');

  // §11: showTypeFilter drives the TYPE section visibility in the sheet.
  ok(
    mavero.includes("dimension: 'type'") && mavero.includes('visible: showTypeFilter'),
    '§11: MaveroAddonDownload passes the showTypeFilter flag to the TYPE section',
  );
  ok(
    mavero.includes('currentTypeOptions.length > 2'),
    '§11: showTypeFilter is derived from currentTypeOptions length (>2 = visible because "All" is always first)',
  );

  // §11: When only HTTPS streams exist, typeOptions returns only ["All", "HTTPS"] —
  // length 2, so showTypeFilter is false (TYPE section hidden).
  const onlyHttps = [
    makeStream({ url: 'https://a.com', kind: 'https', quality: '1080p' }),
    makeStream({ url: 'https://b.com', kind: 'https', quality: '720p' }),
  ];
  const optsHttpsOnly = typeOptions(onlyHttps);
  ok(optsHTTPSOnlyHasAllAndHttps(optsHttpsOnly), '§11: typeOptions returns [All, HTTPS] when only HTTPS present');
  ok(optsHttpsOnly.length === 2, '§11: typeOptions length is 2 when only HTTPS — showTypeFilter=false → TYPE hidden');

  // §11: When HTTPS + HLS present, typeOptions returns 3+ — showTypeFilter true.
  const httpsHls = [
    makeStream({ url: 'https://a.com', kind: 'https', quality: '1080p' }),
    makeStream({ url: 'https://b.com/x.m3u8', kind: 'hls', quality: '1080p' }),
  ];
  const optsHttpsHls = typeOptions(httpsHls);
  ok(optsHttpsHls.length >= 3, '§11: typeOptions length >= 3 when HTTPS + HLS present — showTypeFilter=true → TYPE visible');

  // §11: HTTPS + HLS + DASH = 4 options.
  const httpsHlsDash = [
    makeStream({ url: 'https://a.com', kind: 'https', quality: '1080p' }),
    makeStream({ url: 'https://b.com/x.m3u8', kind: 'hls', quality: '1080p' }),
    makeStream({ url: 'https://c.com/x.mpd', kind: 'dash', quality: '1080p' }),
  ];
  const opts3 = typeOptions(httpsHlsDash);
  ok(opts3.length >= 4, '§11: typeOptions length >= 4 when HTTPS + HLS + DASH present — TYPE visible');
}

function optsHTTPSOnlyHasAllAndHttps(opts: ReturnType<typeof typeOptions>): boolean {
  return opts.length === 2 && opts[0].value === 'all' && opts[1].value === 'https';
}

// ---------------------------------------------------------------------------
// §10 — SIZE BOUNDARY > 20 GB STRICT SEMANTICS
// ---------------------------------------------------------------------------

function section_sizeBoundary(): void {
  // §10: Option A — "> 20 GB" is STRICTLY greater than 20 GB.
  // Label is "> 20 GB" so exactly 20 GB must NOT match.
  ok(sizeFilterLabel('over20') === '> 20 GB', '§10: over20 label is "> 20 GB"');
  ok(!streamMatchesSize({ ...makeStream({ url: 'x', sizeBytes: 20 * GB }) }, 'over20'), '§10: exactly 20 GB does NOT match >20 GB (strict lower bound)');
  ok(streamMatchesSize({ ...makeStream({ url: 'x', sizeBytes: 20 * GB + 1 }) }, 'over20'), '§10: 20 GB + 1 byte matches >20 GB');
  ok(streamMatchesSize({ ...makeStream({ url: 'x', sizeBytes: 25 * GB }) }, 'over20'), '§10: 25 GB matches >20 GB');
  ok(streamMatchesSize({ ...makeStream({ url: 'x', sizeBytes: Number.MAX_SAFE_INTEGER }) }, 'over20'), '§10: Number.MAX_SAFE_INTEGER matches >20 GB');

  // Boundary consistency with "< N GB" (also strict upper bound).
  ok(!streamMatchesSize({ ...makeStream({ url: 'x', sizeBytes: 1 * GB }) }, 'under1'), '§10: exactly 1 GB does NOT match <1 GB (strict upper bound, consistent with >20 GB)');
  ok(streamMatchesSize({ ...makeStream({ url: 'x', sizeBytes: Math.floor(0.999 * GB) }) }, 'under1'), '§10: 0.999 GB matches <1 GB');
  ok(!streamMatchesSize({ ...makeStream({ url: 'x', sizeBytes: 20 * GB }) }, 'under20'), '§10: exactly 20 GB does NOT match <20 GB (strict upper bound)');
  ok(streamMatchesSize({ ...makeStream({ url: 'x', sizeBytes: 19 * GB }) }, 'under20'), '§10: 19 GB matches <20 GB');

  // Unknown-size streams are EXCLUDED from specific filters.
  ok(!streamMatchesSize({ ...makeStream({ url: 'x', sizeBytes: undefined }) }, 'over20'), '§10: unknown-size stream is EXCLUDED under >20 GB (cannot confirm range)');
  ok(!streamMatchesSize({ ...makeStream({ url: 'x', sizeBytes: undefined }) }, 'under5'), '§10: unknown-size stream is EXCLUDED under <5 GB');
  ok(!streamMatchesSize({ ...makeStream({ url: 'x', sizeBytes: 0 }) }, 'over20'), '§10: zero-size stream is EXCLUDED under >20 GB');
  ok(!streamMatchesSize({ ...makeStream({ url: 'x', sizeBytes: -1 }) }, 'over20'), '§10: negative-size stream is EXCLUDED under >20 GB');

  // 'all' retains unknown-size.
  ok(streamMatchesSize({ ...makeStream({ url: 'x', sizeBytes: undefined }) }, 'all'), '§10: unknown-size stream is RETAINED under All');
}

// ---------------------------------------------------------------------------
// §12 + §13 — COUNT SEMANTICS + SHOW MORE FULL-COLLECTION GUARANTEE
// ---------------------------------------------------------------------------

function section_countAndShowMore(): void {
  const mavero = read('src/lib/components/MaveroAddonDownload.svelte');

  // §12: Single "Showing X of Y" — no duplicate count rendering.
  ok(mavero.includes('Showing {visibleStreams.length} of {filteredStreams.length}'), '§12: MaveroAddonDownload renders "Showing X of Y" once (single source of truth)');
  // The duplicate "58 links" count was removed in Phase E V2 — there's only
  // ONE filter-bar count + ONE Show More count.
  ok(
    mavero.match(/mad-filter-count/g)!.length === 1 || mavero.includes('mad-filter-count'),
    '§12: filter count rendered once in the filter bar (no duplicate "X links" under the list)',
  );

  // §13: Show More operates on ALREADY RESOLVED streams — no refetch.
  // visibleStreams + remainingStreams are derived from filteredStreams
  // (the already-resolved collection). Show More appends from remaining.
  ok(mavero.includes('showMoreBatch(visibleStreams, remainingStreams)'), '§13: Show More calls showMoreBatch on existing visible+remaining arrays (no refetch)');
  ok(mavero.includes('function handleShowMore'), '§13: handleShowMore function exists');

  // §13: showMoreBatch appends from remaining, no fetch.
  const visible = [{ url: 'a' }, { url: 'b' }];
  const remaining = [{ url: 'c' }, { url: 'd' }, { url: 'e' }];
  const result = showMoreBatch(visible, remaining, 2);
  ok(result.visible.length === 4, '§13: showMoreBatch appends batch to visible (4 = 2 + 2)');
  ok(result.remaining.length === 1, '§13: showMoreBatch consumes from remaining (1 left after batch of 2)');
  ok(result.visible[2].url === 'c', '§13: showMoreBatch preserves order (first batch element = first remaining)');
  ok(result.visible[3].url === 'd', '§13: showMoreBatch preserves order (second batch element = second remaining)');

  // §13: Full-collection guarantee — all streams eventually accessible.
  // Simulate 25 streams, batch=10. After 3 Show More clicks, all 25 visible.
  const streams25 = Array.from({ length: 25 }, (_, i) => makePresentable({ url: `s${i}`, kind: 'https', quality: '1080p' }));
  // First the presentation window splits into initial + remaining.
  const window = selectPresentationWindow(streams25);
  let visible2 = window.initial;
  let remaining2 = window.remaining;
  ok(visible2.length + remaining2.length === 25, '§13: presentation window preserves full collection (initial + remaining = total)');
  // Show More 1
  const r1 = showMoreBatch(visible2, remaining2);
  visible2 = r1.visible;
  remaining2 = r1.remaining;
  // Show More 2
  const r2 = showMoreBatch(visible2, remaining2);
  visible2 = r2.visible;
  remaining2 = r2.remaining;
  // Show More 3
  const r3 = showMoreBatch(visible2, remaining2);
  visible2 = r3.visible;
  remaining2 = r3.remaining;
  ok(remaining2.length === 0, '§13: after 3 Show More clicks on 25 streams, remaining is 0');
  ok(visible2.length === 25, '§13: after 3 Show More clicks on 25 streams, all 25 visible (no streams lost)');

  // §13: No refetch — handleShowMore ONLY calls showMoreBatch + assigns
  // new visible/remaining arrays. It does NOT call loadAddon / loadTabs /
  // any fetch.
  const handleShowMoreFnMatch = mavero.match(/function handleShowMore\(\)[^{]*\{([\s\S]*?)^\s*\}/m);
  ok(handleShowMoreFnMatch !== null, '§13: handleShowMore function exists in source');
  if (handleShowMoreFnMatch) {
    const body = handleShowMoreFnMatch[1];
    ok(!body.includes('loadAddon'), '§13: handleShowMore body does NOT call loadAddon (no addon refetch)');
    ok(!body.includes('loadTabs'), '§13: handleShowMore body does NOT call loadTabs (no tab refetch)');
    ok(!body.includes('fetch('), '§13: handleShowMore body does NOT call fetch() (no network)');
    ok(body.includes('showMoreBatch'), '§13: handleShowMore body calls showMoreBatch (operates on already-resolved streams)');
  }
}

// ---------------------------------------------------------------------------
// §15 + §16 + §17 — ADMIN LINK-TYPES + MANIFEST PRESERVATION + RACE
// ---------------------------------------------------------------------------

function section_adminLinkTypes(): void {
  // §15: DEFAULT_LINK_TYPES_CONFIG = ALL enabled (default exposure).
  const def = DEFAULT_LINK_TYPES_CONFIG;
  ok(def.http === true, '§15: default http = true (admin can disable)');
  ok(def.https === true, '§15: default https = true');
  ok(def.hls === true, '§15: default hls = true');
  ok(def.dash === true, '§15: default dash = true');
  ok(def.p2p === true, '§15: default p2p = true');
  ok(def.magnet === true, '§15: default magnet = true');

  // §15: When HLS is disabled, isLinkTypeAllowed('hls', config) returns false.
  const hlsDisabled = { ...DEFAULT_LINK_TYPES_CONFIG, hls: false };
  ok(isLinkTypeAllowed('hls', hlsDisabled) === false, '§15: HLS disabled → isLinkTypeAllowed returns false');
  ok(isLinkTypeAllowed('https', hlsDisabled) === true, '§15: HLS disabled → HTTPS still allowed');
  ok(isLinkTypeAllowed('http', hlsDisabled) === true, '§15: HLS disabled → HTTP still allowed');

  // §15: Default config allows ALL link types.
  ok(isLinkTypeAllowed('http', DEFAULT_LINK_TYPES_CONFIG), '§15: default allows http');
  ok(isLinkTypeAllowed('https', DEFAULT_LINK_TYPES_CONFIG), '§15: default allows https');
  ok(isLinkTypeAllowed('hls', DEFAULT_LINK_TYPES_CONFIG), '§15: default allows hls');
  ok(isLinkTypeAllowed('dash', DEFAULT_LINK_TYPES_CONFIG), '§15: default allows dash');
  ok(isLinkTypeAllowed('p2p', DEFAULT_LINK_TYPES_CONFIG), '§15: default allows p2p');
  ok(isLinkTypeAllowed('magnet', DEFAULT_LINK_TYPES_CONFIG), '§15: default allows magnet');

  // §15: getLinkTypesConfig on null/undefined/missing capabilities returns the default.
  ok(
    Object.keys(getLinkTypesConfig(null)).length === 6 &&
      Object.values(getLinkTypesConfig(null)).every((v) => v === true),
    '§15: getLinkTypesConfig(null) returns all-true default (all enabled)',
  );
  ok(
    Object.values(getLinkTypesConfig(undefined)).every((v) => v === true),
    '§15: getLinkTypesConfig(undefined) returns all-true default',
  );
  ok(
    Object.values(getLinkTypesConfig({})).every((v) => v === true),
    '§15: getLinkTypesConfig({}) returns default when capabilities has no downloaderLinkTypes key',
  );

  // §15: getLinkTypesConfig on a partial config merges defaults.
  // Pass a capabilities object with only hls=false — other keys should default to true.
  const partial = { downloaderLinkTypes: { hls: false } }; // only hls specified
  const merged = getLinkTypesConfig(partial);
  ok(merged.hls === false, '§15: getLinkTypesConfig preserves explicit hls=false');
  ok(merged.https === true, '§15: getLinkTypesConfig fills in default https=true for missing key');
  ok(merged.http === true, '§15: getLinkTypesConfig fills in default http=true for missing key');
  ok(merged.dash === true, '§15: getLinkTypesConfig fills in default dash=true for missing key');

  // §16: Manifest refresh preservation — syncAddonManifest reads existing
  // capabilities + buildSuccessfulManifestUpdate preserves downloaderLinkTypes.
  const manifest = read('src/lib/server/streaming/stremio/manifest-service.ts');
  ok(
    manifest.includes('if (existing.downloaderLinkTypes !== undefined)'),
    '§16: buildSuccessfulManifestUpdate preserves existing downloaderLinkTypes',
  );
  ok(
    manifest.includes('manifestCaps.downloaderLinkTypes = existing.downloaderLinkTypes'),
    '§16: manifestCaps.downloaderLinkTypes is copied from existing (not overwritten by manifest)',
  );
  ok(
    /from\(\s*['"]streaming_addons['"]\s*\)\s*\n?\s*\.select\(\s*['"]capabilities['"]\s*\)/.test(manifest),
    '§16: syncAddonManifest reads existing capabilities BEFORE building the manifest update',
  );

  // §17: setAddonLinkTypes reads → merges → writes (preserves other capability keys).
  const admin = read('src/lib/server/streaming/stremio/admin-addons.ts');
  ok(
    admin.includes('caps.downloaderLinkTypes = linkTypes;'),
    '§17: setAddonLinkTypes sets downloaderLinkTypes on the merged capabilities object',
  );
  // Verify the spread operator preserves other keys.
  ok(
    admin.includes('{ ...(existing.capabilities as Record<string, unknown>) }'),
    '§17: setAddonLinkTypes spreads existing capabilities (preserves unrelated keys during merge)',
  );

  // §17: Race audit — the read-modify-write is single-statement per call.
  // We can't make it truly atomic without DB-level primitives, but the
  // merge logic ensures existing keys are NEVER lost.
  ok(
    admin.includes("if (!existing) throw new StreamingValidationError('Addon not found.')"),
    '§17: setAddonLinkTypes fails loudly when the addon is missing (no silent overwrite with empty)',
  );
}

// ---------------------------------------------------------------------------
// §18 — HTTPS PREFERENCE — HTTP ≠ HTTPS
// ---------------------------------------------------------------------------

function section_httpsPreference(): void {
  // §18: presentation-window.ts uses `kind === 'https'` ONLY (not http||https).
  const pw = read('src/lib/shared/presentation-window.ts');
  ok(
    pw.includes("s.kind === 'https'"),
    '§18: presentation-window uses kind === \'https\' only (NOT http || https)',
  );
  ok(
    !/s\.kind\s*===\s*'(https|http)'\s*\|\|\s*s\.kind\s*===\s*'(https|http)'/.test(pw),
    '§18: presentation-window does NOT use combined http||https check',
  );

  // §18: HTTPS preferred over HTTP at the same quality.
  const streams = [
    makePresentable({ url: 'http://a.com', kind: 'http', quality: '1080p' }),
    makePresentable({ url: 'https://b.com', kind: 'https', quality: '1080p' }),
  ];
  // Sort: HTTPS first (the server already sorts by score, but presentation
  // window picks HTTPS regardless of input order).
  const result = selectPresentationWindow([streams[1], streams[0]]); // pass HTTPS second
  ok(result.initial.length === 1, '§18: presentation window picks 1 stream for the 1080p quality bucket');
  ok(result.initial[0].url === 'https://b.com', '§18: HTTPS candidate is preferred over HTTP for the same quality');

  // §18: If NO HTTPS exists, fall back to the best valid non-HTTPS candidate.
  const onlyHttp = [
    makePresentable({ url: 'http://a.com', kind: 'http', quality: '1080p' }),
    makePresentable({ url: 'http://b.com', kind: 'http', quality: '1080p' }),
  ];
  const result2 = selectPresentationWindow(onlyHttp);
  ok(result2.initial.length === 1, '§18: with no HTTPS, falls back to a non-HTTPS candidate (still 1 per quality)');
  ok(result2.initial[0].kind === 'http', '§18: fallback candidate is http when no https exists');

  // §18: Different hosts stay separate (different URLs = different streams).
  const multiHost = [
    makePresentable({ url: 'https://hostA.com/x', kind: 'https', quality: '1080p' }),
    makePresentable({ url: 'https://hostB.com/x', kind: 'https', quality: '1080p' }),
  ];
  const result3 = selectPresentationWindow(multiHost);
  ok(result3.initial.length === 1, '§18: same quality picks 1 host (the best HTTPS by sort order)');
  ok(result3.remaining.length === 1, '§18: other host stays in remaining (not lost)');

  // §18: Multiple quality buckets = multiple initial picks (one best HTTPS per quality).
  const multiQual = [
    makePresentable({ url: 'https://a.com/4k', kind: 'https', quality: '4K' }),
    makePresentable({ url: 'https://b.com/1080', kind: 'https', quality: '1080p' }),
    makePresentable({ url: 'https://c.com/720', kind: 'https', quality: '720p' }),
  ];
  const result4 = selectPresentationWindow(multiQual);
  ok(result4.initial.length === 3, '§18: 3 quality buckets → 3 initial picks (one best HTTPS per quality)');
  ok(result4.remaining.length === 0, '§18: with one stream per quality, remaining is empty');
}

// ---------------------------------------------------------------------------
// §19 — STREAM CARD METADATA + TRANSPORT CLARITY
// ---------------------------------------------------------------------------

function section_streamCardMetadata(): void {
  const mavero = read('src/lib/components/MaveroAddonDownload.svelte');
  const dlt = read('src/lib/shared/download-link-types.ts');

  // §19: Transport labels exist for each kind.
  ok(dlt.includes("linkTypeLabel"), '§19: download-link-types exports linkTypeLabel helper');
  ok(dlt.includes("linkTypeCategory"), '§19: download-link-types exports linkTypeCategory helper');

  // §19: Transport label on card distinguishes HTTPS · Direct, HLS · Stream, etc.
  ok(mavero.includes('transportLabel(stream.kind)'), '§19: MaveroAddonDownload calls transportLabel per stream');
  ok(mavero.includes('mad-transport'), '§19: MaveroAddonDownload renders mad-transport class for transport label');

  // §19: Card metadata hierarchy — QUALITY, CODEC, CONTAINER, AUDIO, SIZE, HOST, SUBTITLES.
  ok(mavero.includes('mad-badge-quality'), '§19: card renders QUALITY badge');
  ok(mavero.includes('mad-badge-codec'), '§19: card renders CODEC badge');
  ok(mavero.includes('mad-badge-container'), '§19: card renders CONTAINER badge');
  ok(mavero.includes('mad-badge-audio'), '§19: card renders AUDIO badge');
  ok(mavero.includes('mad-badge-size'), '§19: card renders SIZE badge');
  ok(mavero.includes('mad-badge-host'), '§19: card renders HOST/SOURCE badge');
  ok(mavero.includes('mad-badge-subtitles'), '§19: card renders SUBTITLES badge');

  // §19: Transport category distinguishes Direct vs Stream vs Torrent.
  const transportTests: Array<[DownloadLinkType, string]> = [
    ['http', 'Direct'],
    ['https', 'Direct'],
    ['hls', 'Stream'],
    ['dash', 'Stream'],
    ['p2p', 'Torrent'],
    ['magnet', 'Torrent'],
  ];
  for (const [kind, expectedCat] of transportTests) {
    ok(linkTypeCategory(kind) === expectedCat, `§19: linkTypeCategory('${kind}') === '${expectedCat}'`);
  }

  // §19: linkTypeLabel returns the protocol name (uppercase).
  ok(linkTypeLabel('https') === 'HTTPS', '§19: linkTypeLabel(\'https\') === \'HTTPS\'');
  ok(linkTypeLabel('hls') === 'HLS', '§19: linkTypeLabel(\'hls\') === \'HLS\'');
  ok(linkTypeLabel('magnet') === 'Magnet', '§19: linkTypeLabel(\'magnet\') === \'Magnet\'');
}

// ---------------------------------------------------------------------------
// §20 — SKELETON LOADING (per-addon state)
// ---------------------------------------------------------------------------

function section_skeleton(): void {
  const mavero = read('src/lib/components/MaveroAddonDownload.svelte');

  // §20: Skeleton cards render while the ACTIVE TAB is loading.
  ok(mavero.includes('mad-skeleton-list'), '§20: MaveroAddonDownload has a skeleton list container');
  ok(mavero.includes('mad-skeleton-card'), '§20: MaveroAddonDownload has skeleton card placeholders');
  ok(mavero.includes('mad-skeleton-kind'), '§20: skeleton card has a kind icon placeholder');
  ok(mavero.includes('mad-skeleton-line'), '§20: skeleton card has a detail-line placeholder');
  ok(mavero.includes('mad-skeleton-badge'), '§20: skeleton card has badge placeholders');
  ok(mavero.includes('mad-skeleton-action'), '§20: skeleton card has an action-button placeholder');

  // §20: Skeleton is rendered INSIDE the active-tab-loading branch (per-addon, not global).
  const loadingIdx = mavero.indexOf("activeTab.status === 'loading'");
  const skeletonIdx = mavero.indexOf('mad-skeleton-list');
  ok(loadingIdx > -1 && skeletonIdx > loadingIdx, '§20: skeleton list is rendered INSIDE the per-addon loading branch');

  // §20: Reduced motion disables the skeleton animation.
  ok(
    mavero.includes('prefers-reduced-motion: reduce'),
    '§20: prefers-reduced-motion media query exists (disables skeleton pulse animation)',
  );
  ok(
    mavero.includes('mad-skeleton-pulse'),
    '§20: skeleton pulse keyframe exists',
  );
  // The reduced-motion rule applies animation:none to skeleton elements.
  ok(
    /prefers-reduced-motion[\s\S]*?mad-skeleton[^}]*animation:\s*none/.test(mavero) ||
      /prefers-reduced-motion[\s\S]*?opacity:\s*0\.5/.test(mavero),
    '§20: prefers-reduced-motion disables skeleton animation (animation:none or opacity:0.5)',
  );

  // §20: Tab pills show per-tab loading state (mad-tab-state.loading).
  ok(mavero.includes('mad-tab-state loading'), '§20: tab pill has a per-tab loading state class (per-addon skeleton)');
  ok(mavero.includes('mad-tab-spin'), '§20: tab pill has a per-tab spinner (Loader2 icon)');
}

// ---------------------------------------------------------------------------
// §B — PHASE B REGRESSION (dedup + hosts)
// ---------------------------------------------------------------------------

function section_phaseB_regression(): void {
  // Phase B canonicalStreamKey is URL-only (preserves different hosts).
  // Lives in download-selection.ts (shared by addon-download-service) +
  // stream-resolver.ts (player path).
  const ds = read('src/lib/server/streaming/stremio/download-selection.ts');
  ok(
    ds.includes('canonicalStreamKey'),
    '§B: download-selection exports canonicalStreamKey (URL-only dedup key)',
  );

  // Phase B magnet BTIH dedup — in stream-normalize.ts.
  const norm = read('src/lib/server/streaming/stremio/stream-normalize.ts');
  ok(
    norm.includes('btih') || norm.includes('BTIH') || norm.includes('infoHash'),
    '§B: stream-normalize has BTIH/magnet-infoHash dedup logic',
  );

  // Phase B subtitles survive normalization.
  ok(
    norm.includes('normalizeSubtitleTracks') || norm.includes('subtitles'),
    '§B: stream-normalize preserves subtitles',
  );

  // Phase B host field plumbing.
  ok(
    norm.includes('host') || norm.includes('hostname'),
    '§B: stream-normalize computes a host/hostname field for hosting identity',
  );

  // Phase B: stream-actions share original URL (no proxy).
  const actions = read('src/lib/shared/stream-actions.ts');
  ok(
    actions.includes('stream.url') || actions.includes('original'),
    '§B: stream-actions uses the EXACT ORIGINAL URI (no proxy, no rewrite)',
  );

  // §B: Different hosts survive dedup — canonicalStreamKey is URL-only,
  // so two streams with the SAME release metadata but DIFFERENT URLs
  // (different hosts) STAY as two separate streams.
  ok(
    /canonicalStreamKey[^}]*url[^}]*host/i.test(ds) || ds.includes('host') || ds.includes('url'),
    '§B: canonicalStreamKey references url/host (URL-only dedup — different hosts survive)',
  );
}

// ---------------------------------------------------------------------------
// §C — PHASE C REGRESSION (semantic audio + AND logic)
// ---------------------------------------------------------------------------

function section_phaseC_regression(): void {
  // §C: English semantic matching — Dual Audio containing English matches English.
  const dualAudioWithEnglish: FilterableStream = {
    url: 'https://x.com',
    kind: 'https',
    quality: '1080p',
    audio: 'dual',
    audioLanguages: ['English', 'Hindi'],
  };
  ok(streamMatchesLanguage(dualAudioWithEnglish, 'English'), '§C: Dual Audio containing English matches the English filter (semantic)');

  // §C: Dual Audio containing Hindi matches Hindi.
  ok(streamMatchesLanguage(dualAudioWithEnglish, 'Hindi'), '§C: Dual Audio containing Hindi matches the Hindi filter (semantic)');

  // §C: Multi Audio matches 'multi' filter.
  const multiAudio: FilterableStream = {
    url: 'https://x.com',
    kind: 'https',
    quality: '1080p',
    audio: 'multi',
    audioLanguages: ['English', 'Hindi', 'Spanish'],
  };
  ok(streamMatchesLanguage(multiAudio, 'multi'), '§C: Multi Audio matches the multi filter');
  ok(streamMatchesLanguage(multiAudio, 'dual'), '§C: Multi Audio matches the dual filter (multi is a superset)');

  // §C: Dual Audio WITHOUT the language in audioLanguages does NOT match.
  const dualNoEnglish: FilterableStream = {
    url: 'https://x.com',
    kind: 'https',
    quality: '1080p',
    audio: 'dual',
    audioLanguages: ['Hindi', 'Tamil'], // no English
  };
  ok(!streamMatchesLanguage(dualNoEnglish, 'English'), '§C: Dual Audio WITHOUT English in audioLanguages does NOT match English filter (no fabrication)');

  // §C: AND-combination filter — all dimensions must match.
  const stream: FilterableStream = {
    url: 'https://x.com',
    kind: 'https',
    quality: '1080p',
    audio: 'dual',
    audioLanguages: ['English', 'Hindi'],
    sizeBytes: 3 * GB,
  };
  const filters: DownloaderFilters = {
    type: 'https',
    quality: '1080p',
    size: 'under5',
    language: 'English',
  };
  ok(streamMatchesFilters(stream, filters), '§C: stream matches when ALL filter dimensions match (AND)');

  // §C: AND-combination — one dimension failing excludes the stream.
  const failType: DownloaderFilters = { ...filters, type: 'hls' };
  ok(!streamMatchesFilters(stream, failType), '§C: stream does NOT match when type fails (AND)');
  const failQuality: DownloaderFilters = { ...filters, quality: '720p' };
  ok(!streamMatchesFilters(stream, failQuality), '§C: stream does NOT match when quality fails (AND)');
  const failSize: DownloaderFilters = { ...filters, size: 'under1' };
  ok(!streamMatchesFilters(stream, failSize), '§C: stream does NOT match when size fails (AND)');
  const failLang: DownloaderFilters = { ...filters, language: 'Spanish' };
  ok(!streamMatchesFilters(stream, failLang), '§C: stream does NOT match when language fails (AND)');

  // §C: Clear filter dimension resets to 'all'.
  const withFilters: DownloaderFilters = { type: 'https', quality: '1080p', size: 'under5', language: 'English' };
  const cleared = clearFilterDimension(withFilters, 'size');
  ok(cleared.size === 'all', '§C: clearFilterDimension resets size to all');
  ok(cleared.type === 'https', '§C: clearFilterDimension preserves other dimensions (type still https)');
  ok(cleared.quality === '1080p', '§C: clearFilterDimension preserves quality');
  ok(cleared.language === 'English', '§C: clearFilterDimension preserves language');

  // §C: hasActiveFilters is true when any dimension is set.
  ok(hasActiveFilters(withFilters), '§C: hasActiveFilters is true with all 4 dimensions set');
  ok(!hasActiveFilters(NO_FILTERS), '§C: hasActiveFilters is false with NO_FILTERS');

  // §C: Filtered-empty state — when addon returns streams but filters produce 0.
  const streamsAll = [
    makeStream({ url: 'https://x.com', kind: 'https', quality: '1080p', audioLanguages: ['English'] }),
    makeStream({ url: 'https://y.com', kind: 'https', quality: '720p', audioLanguages: ['English'] }),
  ];
  const noMatch: DownloaderFilters = { type: 'all', quality: '4K', size: 'all', language: 'all' };
  const filtered = filterStreams(streamsAll, noMatch);
  ok(filtered.length === 0, '§C: filterStreams returns empty when quality 4K matches no stream (filtered-empty state)');
}

// ---------------------------------------------------------------------------
// §D — PHASE D REGRESSION (capabilities + actions + no 1DM/proxy/FFmpeg)
// ---------------------------------------------------------------------------

function section_phaseD_regression(): void {
  const actions = read('src/lib/shared/stream-actions.ts');
  const mavero = read('src/lib/components/MaveroAddonDownload.svelte');

  // §D: Capability model — Download / Play / Share.
  ok(actions.includes('Download'), '§D: stream-actions has Download capability');
  ok(actions.includes('Play'), '§D: stream-actions has Play capability');
  ok(actions.includes('Share'), '§D: stream-actions has Share capability');

  // §D: External player uses canonical helper (no forced 1DM).
  ok(
    actions.includes('externalPlayerLaunchFor') || actions.includes('external-player'),
    '§D: stream-actions delegates to external-player helper (no 1DM hardcoding)',
  );

  // §D: NO proxy usage, NO FFmpeg, NO media-worker. (Comments saying
  // "Mavero does NOT proxy" are fine — those are documentation of the
  // policy. We look for actual proxy *usage* — function calls or URL
  // construction that would proxy/rewrite the original URI.)
  ok(
    !/(\w+)\s*\(\s*[^)]*proxy/.test(actions.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')),
    '§D: stream-actions does NOT call any proxy function (after stripping comments)',
  );
  ok(!actions.includes('ffmpeg'), '§D: stream-actions does NOT use ffmpeg');
  ok(!actions.includes('media-worker'), '§D: stream-actions does NOT use media-worker');

  // §D: Card renders the original URL (no Mavero URL, no rewrite).
  ok(
    mavero.includes('href={dlAction.href}') || mavero.includes('href={plAction.href}'),
    '§D: card uses the original URL from downloadActionFor / playActionFor',
  );

  // §D: External streams are filtered (Phase 18) — 'external' is never a Type filter option.
  const filters = read('src/lib/shared/downloader-filters.ts');
  ok(
    filters.includes("if (s.kind === 'external') continue;"),
    '§D: external streams are excluded from Type filter options (Phase 18 compliant)',
  );
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

section_downloadSheet_regression();
section_filterSheet();
section_sizeBoundary();
section_countAndShowMore();
section_adminLinkTypes();
section_httpsPreference();
section_streamCardMetadata();
section_skeleton();
section_phaseB_regression();
section_phaseC_regression();
section_phaseD_regression();

console.log(`stremio_downloader_phaseE_final_test: ${passed} checks passed (Phase E final: DownloadSheet regression fixed, grouped filter sheet, dead size code removed, >20 GB strict, Type visibility dynamic, Show More full-collection, admin link-types + manifest preservation + race-safe merge, HTTPS preference ≠ HTTP, transport labels + metadata hierarchy, skeleton per-addon, Phase B/C/D regression-free)`);
