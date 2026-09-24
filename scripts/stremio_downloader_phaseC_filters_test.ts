import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  filterStreams,
  streamMatchesLanguage,
  streamMatchesSize,
  streamMatchesQuality,
  streamMatchesType,
  typeOptions,
  qualityOptions,
  sizeOptions,
  languageOptions,
  activeFilterChips,
  hasActiveFilters,
  clearFilterDimension,
  NO_FILTERS,
  type DownloaderFilters,
  type FilterableStream,
} from '$lib/shared/downloader-filters';

/**
 * Phase C — Dynamic downloader filters test suite.
 *
 * Tests the pure filter helpers in `src/lib/shared/downloader-filters.ts` —
 * the SINGLE source of truth for filter logic shared by both the component
 * and the tests. Covers all the scenarios the approved plan §27/§28 requires:
 *
 *   TYPE:     only present types appear, absent types omitted, counts correct
 *   QUALITY:  only present qualities appear, counts correct, filtering works
 *   SIZE:     each supported range, boundary values, unknown-size behavior
 *   LANGUAGE: English, Hindi, English+Hindi, Dual Audio, Multi Audio, semantic
 *             matching (English matches Dual Audio containing English, etc.),
 *             unknown audio metadata not fabricated
 *   COMBINATIONS: type+quality, quality+language, language+size, all four
 *   EMPTY:    filters producing zero results, filtered-empty distinct from
 *             addon failure, Clear restores results
 *   SHOW MORE: filtering operates on full collection, no addon refetch
 *   REGRESSION: different hosts preserved, subtitles preserved, card metadata intact
 *
 * The filter helpers are pure (no DOM, no network) — all tests are
 * deterministic with mocked stream collections.
 */

let passed = 0;
function ok(condition: unknown, label: string) {
  assert.ok(condition, label);
  passed += 1;
}

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative: string) => readFileSync(path.join(REPO_ROOT, relative), 'utf8');

// ---------------------------------------------------------------------------
// Fixtures — a representative mixed stream collection covering every dimension
// ---------------------------------------------------------------------------

function makeStream(overrides: Partial<FilterableStream> & { url: string }): FilterableStream {
  return {
    kind: 'https',
    quality: '1080p',
    audio: 'unknown',
    ...overrides,
  };
}

const GB = 1024 ** 3;

const MIXED_STREAMS: FilterableStream[] = [
  // 1080p H.264 HTTPS with Multi audio (English + Hindi)
  makeStream({ url: 'https://hub.example/1080p-multi.mkv', kind: 'https', quality: '1080p', audio: 'multi', audioLanguages: ['English', 'Hindi'], sizeBytes: 8 * GB }),
  // 1080p H.264 HTTPS with Dual audio (English + Hindi)
  makeStream({ url: 'https://hub.example/1080p-dual.mkv', kind: 'https', quality: '1080p', audio: 'dual', audioLanguages: ['English', 'Hindi'], sizeBytes: 7 * GB }),
  // 1080p HTTPS single audio (English only)
  makeStream({ url: 'https://hub.example/1080p-en.mkv', kind: 'https', quality: '1080p', audio: 'single', audioLanguages: ['English'], sizeBytes: 5 * GB }),
  // 720p HTTPS single audio (Hindi only)
  makeStream({ url: 'https://hub.example/720p-hi.mkv', kind: 'https', quality: '720p', audio: 'single', audioLanguages: ['Hindi'], sizeBytes: 3 * GB }),
  // 4K HTTPS multi audio
  makeStream({ url: 'https://hub.example/4k-multi.mkv', kind: 'https', quality: '4K', audio: 'multi', audioLanguages: ['English', 'Hindi', 'Spanish'], sizeBytes: 25 * GB }),
  // HLS stream (no size, auto quality)
  makeStream({ url: 'https://hub.example/playlist.m3u8', kind: 'hls', quality: 'auto', audio: 'unknown' }),
  // P2P magnet (multi audio)
  makeStream({ url: 'magnet:?xt=urn:btih:deadbeef0123456789abcdef0123456789abcdef', kind: 'magnet', quality: '1080p', audio: 'multi', audioLanguages: ['English', 'Hindi'] }),
  // 1080p on a DIFFERENT host (PixelDrain) — same release, different hosting
  makeStream({ url: 'https://pixeldrain.com/api/file/abc.mkv', kind: 'https', quality: '1080p', audio: 'multi', audioLanguages: ['English', 'Hindi'], sizeBytes: 8 * GB }),
  // 480p small file
  makeStream({ url: 'https://hub.example/480p.mkv', kind: 'https', quality: '480p', audio: 'single', audioLanguages: ['English'], sizeBytes: 500 * 1024 ** 2 }), // 500 MB
  // Unknown-size stream (no videoSize)
  makeStream({ url: 'https://hub.example/unknown-size.mkv', kind: 'https', quality: '1080p', audio: 'unknown' }),
];

// ---------------------------------------------------------------------------
// TYPE FILTER
// ---------------------------------------------------------------------------

function section_type(): void {
  const opts = typeOptions(MIXED_STREAMS);
  // "All" is always first with the total count (non-external).
  ok(opts[0]?.value === 'all' && opts[0]?.label === 'All', 'TYPE: All is first');
  ok(opts[0]?.count === MIXED_STREAMS.length, `TYPE: All count = ${MIXED_STREAMS.length} (got ${opts[0]?.count})`);
  // Only present kinds appear — HTTP and DASH are absent from the fixture.
  const values = opts.map((o) => o.value);
  ok(values.includes('https'), 'TYPE: HTTPS present');
  ok(values.includes('hls'), 'TYPE: HLS present');
  ok(values.includes('magnet'), 'TYPE: Magnet present');
  ok(!values.includes('http'), 'TYPE: HTTP absent (not in fixture)');
  ok(!values.includes('dash'), 'TYPE: DASH absent (not in fixture)');
  ok(!values.includes('p2p'), 'TYPE: P2P absent (no infoHash-only entries in fixture)');
  // Counts are correct per kind.
  const httpsCount = opts.find((o) => o.value === 'https')?.count;
  ok(httpsCount === 8, `TYPE: HTTPS count = 8 (got ${httpsCount})`);
  const hlsCount = opts.find((o) => o.value === 'hls')?.count;
  ok(hlsCount === 1, `TYPE: HLS count = 1 (got ${hlsCount})`);
  const magnetCount = opts.find((o) => o.value === 'magnet')?.count;
  ok(magnetCount === 1, `TYPE: Magnet count = 1 (got ${magnetCount})`);
  // Type filtering works.
  const hlsOnly = filterStreams(MIXED_STREAMS, { ...NO_FILTERS, type: 'hls' });
  ok(hlsOnly.length === 1 && hlsOnly[0]?.kind === 'hls', 'TYPE: filter by HLS → 1 HLS stream');
  const httpsOnly = filterStreams(MIXED_STREAMS, { ...NO_FILTERS, type: 'https' });
  ok(httpsOnly.length === 8 && httpsOnly.every((s) => s.kind === 'https'), 'TYPE: filter by HTTPS → 8 HTTPS streams');
  const allTypes = filterStreams(MIXED_STREAMS, { ...NO_FILTERS, type: 'all' });
  ok(allTypes.length === MIXED_STREAMS.length, 'TYPE: filter by all → all streams');
}

// ---------------------------------------------------------------------------
// QUALITY FILTER
// ---------------------------------------------------------------------------

function section_quality(): void {
  const opts = qualityOptions(MIXED_STREAMS);
  ok(opts[0]?.value === 'all', 'QUALITY: All is first');
  ok(opts[0]?.count === MIXED_STREAMS.length, 'QUALITY: All count correct');
  const values = opts.map((o) => o.value);
  ok(values.includes('4K'), 'QUALITY: 4K present');
  ok(values.includes('1080p'), 'QUALITY: 1080p present');
  ok(values.includes('720p'), 'QUALITY: 720p present');
  ok(values.includes('480p'), 'QUALITY: 480p present');
  ok(values.includes('auto'), 'QUALITY: auto present (HLS with no height)');
  // Only present qualities — 360p absent.
  ok(!values.includes('360p'), 'QUALITY: 360p absent (not in fixture)');
  // Counts correct.
  ok(opts.find((o) => o.value === '1080p')?.count === 6, `QUALITY: 1080p count = 6 (got ${opts.find((o) => o.value === '1080p')?.count})`); // 5 explicit 1080p + 1 magnet 1080p = 6
  ok(opts.find((o) => o.value === '4K')?.count === 1, 'QUALITY: 4K count = 1');
  ok(opts.find((o) => o.value === '720p')?.count === 1, 'QUALITY: 720p count = 1');
  // Quality filtering works.
  const fourK = filterStreams(MIXED_STREAMS, { ...NO_FILTERS, quality: '4K' });
  ok(fourK.length === 1 && fourK[0]?.quality === '4K', 'QUALITY: filter by 4K → 1 stream');
  const autoQ = filterStreams(MIXED_STREAMS, { ...NO_FILTERS, quality: 'auto' });
  ok(autoQ.length === 1 && autoQ[0]?.kind === 'hls', 'QUALITY: filter by auto → 1 HLS stream');
}

// ---------------------------------------------------------------------------
// SIZE FILTER
// ---------------------------------------------------------------------------

function section_size(): void {
  const opts = sizeOptions(MIXED_STREAMS);
  ok(opts[0]?.value === 'all', 'SIZE: All is first');
  // Only present size ranges appear.
  const values = opts.map((o) => o.value);
  ok(values.includes('under1'), 'SIZE: <1 GB present (480p is 500 MB)');
  ok(values.includes('under5'), 'SIZE: <5 GB present (720p is 3 GB)');
  ok(values.includes('under10'), 'SIZE: <10 GB present (1080p dual/multi are 7-8 GB)');
  ok(values.includes('over20'), 'SIZE: >20 GB present (4K is 25 GB)');
  // Boundary tests (ranges are exclusive on the upper end).
  ok(streamMatchesSize({ ...makeStream({ url: 'x', sizeBytes: 8 * GB }) }, 'under10'), 'SIZE: 8 GB matches <10 GB');
  ok(!streamMatchesSize({ ...makeStream({ url: 'x', sizeBytes: 8 * GB }) }, 'under5'), 'SIZE: 8 GB does NOT match <5 GB');
  // 1 GB is exactly the boundary of <1 GB — the range is exclusive on the
  // upper end, so 1 GB does NOT match <1 GB. 0.999 GB does match.
  ok(!streamMatchesSize({ ...makeStream({ url: 'x', sizeBytes: 1 * GB }) }, 'under1'), 'SIZE: exactly 1 GB does NOT match <1 GB (exclusive upper bound)');
  ok(streamMatchesSize({ ...makeStream({ url: 'x', sizeBytes: Math.floor(0.999 * GB) }) }, 'under1'), 'SIZE: 0.999 GB matches <1 GB');
  // 20 GB is exactly the boundary of over20 — the range is inclusive on the
  // lower end (min: 20*GB), so 20 GB DOES match >20 GB.
  ok(streamMatchesSize({ ...makeStream({ url: 'x', sizeBytes: 20 * GB }) }, 'over20'), 'SIZE: exactly 20 GB matches >20 GB (inclusive lower bound)');
  // Unknown-size streams are PRESERVED (not silently deleted) per Phase C.
  const unknownSizeStream = makeStream({ url: 'x', sizeBytes: undefined });
  ok(streamMatchesSize(unknownSizeStream, 'under5'), 'SIZE: unknown-size stream is PRESERVED under <5 GB filter (not silently deleted)');
  ok(streamMatchesSize(unknownSizeStream, 'over20'), 'SIZE: unknown-size stream is PRESERVED under >20 GB filter (not silently deleted)');
  // Size filtering works on the mixed collection.
  const under1 = filterStreams(MIXED_STREAMS, { ...NO_FILTERS, size: 'under1' });
  ok(under1.some((s) => s.quality === '480p'), 'SIZE: <1 GB filter includes the 480p (500 MB) stream');
  ok(under1.some((s) => s.sizeBytes === undefined), 'SIZE: <1 GB filter PRESERVES unknown-size streams (not silently deleted)');
}

// ---------------------------------------------------------------------------
// LANGUAGE / AUDIO FILTER (semantic matching)
// ---------------------------------------------------------------------------

function section_language(): void {
  const opts = languageOptions(MIXED_STREAMS);
  ok(opts[0]?.value === 'all', 'LANGUAGE: All is first');
  const values = opts.map((o) => o.value);
  ok(values.includes('English'), 'LANGUAGE: English present');
  ok(values.includes('Hindi'), 'LANGUAGE: Hindi present');
  ok(values.includes('Spanish'), 'LANGUAGE: Spanish present (from the 4K multi)');
  ok(values.includes('dual'), 'LANGUAGE: Dual Audio present');
  ok(values.includes('multi'), 'LANGUAGE: Multi Audio present');
  // Dual Audio count includes both dual AND multi streams.
  ok(opts.find((o) => o.value === 'dual')?.count === 5, `LANGUAGE: Dual Audio count = 5 (dual+multi) (got ${opts.find((o) => o.value === 'dual')?.count})`); // 1 dual + 4 multi
  ok(opts.find((o) => o.value === 'multi')?.count === 4, `LANGUAGE: Multi Audio count = 4 (got ${opts.find((o) => o.value === 'multi')?.count})`);
  ok(opts.find((o) => o.value === 'English')?.count === 7, `LANGUAGE: English count = 7 (got ${opts.find((o) => o.value === 'English')?.count})`); // all dual+multi with English + single-en

  // SEMANTIC MATCHING — the critical Phase C requirement.

  // English selected → matches streams where audioLanguages includes English.
  const englishFilter: DownloaderFilters = { ...NO_FILTERS, language: 'English' };
  const englishStreams = filterStreams(MIXED_STREAMS, englishFilter);
  ok(englishStreams.every((s) => s.audioLanguages?.includes('English')), 'LANGUAGE: English filter → all results contain English in audioLanguages');
  ok(englishStreams.length === 7, `LANGUAGE: English filter → 7 streams (got ${englishStreams.length})`);

  // Hindi selected → matches streams where audioLanguages includes Hindi.
  const hindiFilter: DownloaderFilters = { ...NO_FILTERS, language: 'Hindi' };
  const hindiStreams = filterStreams(MIXED_STREAMS, hindiFilter);
  ok(hindiStreams.every((s) => s.audioLanguages?.includes('Hindi')), 'LANGUAGE: Hindi filter → all results contain Hindi in audioLanguages');
  ok(hindiStreams.length === 6, `LANGUAGE: Hindi filter → 6 streams (got ${hindiStreams.length})`);

  // Dual Audio selected → dual OR multi streams.
  const dualFilter: DownloaderFilters = { ...NO_FILTERS, language: 'dual' };
  const dualStreams = filterStreams(MIXED_STREAMS, dualFilter);
  ok(dualStreams.every((s) => s.audio === 'dual' || s.audio === 'multi'), 'LANGUAGE: Dual Audio filter → all results are dual or multi');
  ok(dualStreams.length === 5, `LANGUAGE: Dual Audio filter → 5 streams (got ${dualStreams.length})`);

  // Multi Audio selected → multi streams only.
  const multiFilter: DownloaderFilters = { ...NO_FILTERS, language: 'multi' };
  const multiStreams = filterStreams(MIXED_STREAMS, multiFilter);
  ok(multiStreams.every((s) => s.audio === 'multi'), 'LANGUAGE: Multi Audio filter → all results are multi');
  ok(multiStreams.length === 4, `LANGUAGE: Multi Audio filter → 4 streams (got ${multiStreams.length})`);

  // English matches Dual Audio containing English.
  const dualWithEnglish = makeStream({ url: 'x', audio: 'dual', audioLanguages: ['English', 'Hindi'] });
  ok(streamMatchesLanguage(dualWithEnglish, 'English'), 'LANGUAGE: English filter matches Dual Audio containing English');
  ok(streamMatchesLanguage(dualWithEnglish, 'Hindi'), 'LANGUAGE: Hindi filter matches Dual Audio containing Hindi');

  // English matches Multi Audio containing English.
  const multiWithEnglish = makeStream({ url: 'x', audio: 'multi', audioLanguages: ['English', 'Hindi', 'Spanish'] });
  ok(streamMatchesLanguage(multiWithEnglish, 'English'), 'LANGUAGE: English filter matches Multi Audio containing English');

  // Dual Audio WITHOUT the language in audioLanguages does NOT match (no fabrication).
  const dualWithoutEnglish = makeStream({ url: 'x', audio: 'dual', audioLanguages: [] });
  ok(!streamMatchesLanguage(dualWithoutEnglish, 'English'), 'LANGUAGE: English filter does NOT match Dual Audio without English in audioLanguages (no fabrication)');
  ok(streamMatchesLanguage(dualWithoutEnglish, 'dual'), 'LANGUAGE: Dual Audio filter matches dual stream regardless of audioLanguages');

  // Unknown audio metadata does not get fabricated.
  const unknownAudio = makeStream({ url: 'x', audio: 'unknown', audioLanguages: [] });
  ok(!streamMatchesLanguage(unknownAudio, 'English'), 'LANGUAGE: English filter does NOT match unknown-audio stream (no fabrication)');
  ok(!streamMatchesLanguage(unknownAudio, 'dual'), 'LANGUAGE: Dual Audio filter does NOT match unknown-audio stream');
  ok(!streamMatchesLanguage(unknownAudio, 'multi'), 'LANGUAGE: Multi Audio filter does NOT match unknown-audio stream');
}

// ---------------------------------------------------------------------------
// COMBINATIONS (AND logic)
// ---------------------------------------------------------------------------

function section_combinations(): void {
  // type + quality
  const https1080 = filterStreams(MIXED_STREAMS, { ...NO_FILTERS, type: 'https', quality: '1080p' });
  ok(https1080.every((s) => s.kind === 'https' && s.quality === '1080p'), 'COMBO: type+quality → all results are HTTPS 1080p');
  ok(https1080.length === 5, `COMBO: HTTPS+1080p → 5 streams (got ${https1080.length})`);

  // quality + language
  const multi1080 = filterStreams(MIXED_STREAMS, { ...NO_FILTERS, quality: '1080p', language: 'multi' });
  ok(multi1080.every((s) => s.quality === '1080p' && s.audio === 'multi'), 'COMBO: quality+language → all results are 1080p multi');
  ok(multi1080.length === 3, `COMBO: 1080p+Multi → 3 streams (got ${multi1080.length})`); // 2 HTTPS multi 1080p + 1 magnet multi 1080p

  // language + size
  const hindiUnder10 = filterStreams(MIXED_STREAMS, { ...NO_FILTERS, language: 'Hindi', size: 'under10' });
  ok(hindiUnder10.every((s) => s.audioLanguages?.includes('Hindi')), 'COMBO: language+size → all results contain Hindi');
  ok(hindiUnder10.every((s) => s.sizeBytes === undefined || (s.sizeBytes / GB) < 10), 'COMBO: language+size → all results are under 10 GB OR unknown size');

  // type + quality + language + size (all four)
  const allFour = filterStreams(MIXED_STREAMS, { type: 'https', quality: '1080p', language: 'multi', size: 'under10' });
  ok(allFour.every((s) => s.kind === 'https' && s.quality === '1080p' && s.audio === 'multi'), 'COMBO: all four → all results are HTTPS 1080p multi');
  ok(allFour.every((s) => s.sizeBytes === undefined || (s.sizeBytes / GB) < 10), 'COMBO: all four → all results under 10 GB OR unknown size');
  ok(allFour.length === 2, `COMBO: HTTPS+1080p+Multi+<10GB → 2 streams (got ${allFour.length})`); // the 8GB multi streams
}

// ---------------------------------------------------------------------------
// EMPTY STATE + CLEAR
// ---------------------------------------------------------------------------

function section_empty_clear(): void {
  // Filters producing zero results.
  const emptyFilter: DownloaderFilters = { ...NO_FILTERS, type: 'hls', quality: '4K' };
  const empty = filterStreams(MIXED_STREAMS, emptyFilter);
  ok(empty.length === 0, `EMPTY: HLS+4K filter → 0 results (got ${empty.length}) — no stream is both HLS and 4K`);

  // Filtered-empty is distinct from addon failure: the addon DID return
  // streams (MIXED_STREAMS.length > 0) but the filter produces 0.
  ok(MIXED_STREAMS.length > 0 && empty.length === 0, 'EMPTY: filtered-empty is distinct from addon-failure-empty (the collection is non-empty but the filter produces 0)');

  // Clear restores results.
  const cleared = clearFilterDimension(emptyFilter, 'type');
  const clearedResults = filterStreams(MIXED_STREAMS, cleared);
  ok(clearedResults.length > 0, 'EMPTY: clearing the type filter restores results');

  // hasActiveFilters + activeFilterChips
  ok(hasActiveFilters(emptyFilter), 'CLEAR: hasActiveFilters returns true when filters are active');
  ok(!hasActiveFilters(NO_FILTERS), 'CLEAR: hasActiveFilters returns false when no filters are active');
  const chips = activeFilterChips(emptyFilter);
  ok(chips.length === 2, `CLEAR: activeFilterChips returns 2 chips for 2 active filters (got ${chips.length})`);
  ok(chips.some((c) => c.dimension === 'type'), 'CLEAR: activeFilterChips includes the type dimension');
  ok(chips.some((c) => c.dimension === 'quality'), 'CLEAR: activeFilterChips includes the quality dimension');
}

// ---------------------------------------------------------------------------
// SHOW MORE / FULL COLLECTION (filtering operates on the full collection)
// ---------------------------------------------------------------------------

function section_showMore(): void {
  // Filtering operates on the FULL collection — not a pre-truncated subset.
  // If the collection has 10 streams and the filter matches 6, the filter
  // returns ALL 6 — not just the "first 4".
  const multiFilter: DownloaderFilters = { ...NO_FILTERS, language: 'multi' };
  const multiResults = filterStreams(MIXED_STREAMS, multiFilter);
  ok(multiResults.length === 4, `SHOW MORE: filtering operates on the FULL collection — 4 multi streams out of ${MIXED_STREAMS.length} total (got ${multiResults.length})`);
  // The filter does NOT truncate to 4 — it returns ALL matching streams.
  // (If Show More is implemented in a future phase, it would paginate AFTER
  // filterStreams returns the full filtered list — not before.)
  ok(multiResults.length === MIXED_STREAMS.filter((s) => s.audio === 'multi').length, 'SHOW MORE: filter returns ALL matching streams (no truncation to first N)');
}

// ---------------------------------------------------------------------------
// REGRESSION — Phase B behavior preserved
// ---------------------------------------------------------------------------

function section_regression(): void {
  // Different hosts remain available — filtering does NOT collapse them.
  const httpsFilter: DownloaderFilters = { ...NO_FILTERS, type: 'https' };
  const httpsResults = filterStreams(MIXED_STREAMS, httpsFilter);
  const hosts = httpsResults.map((s) => {
    try { return new URL(s.url).hostname; } catch { return s.url; }
  });
  ok(hosts.includes('hub.example'), 'REGRESSION: hub.example host preserved after filtering');
  ok(hosts.includes('pixeldrain.com'), 'REGRESSION: pixeldrain.com host preserved after filtering — different hosts NOT collapsed');
  // The card metadata (quality, codec, audio, etc.) is preserved through the filter.
  const firstResult = httpsResults[0];
  ok(firstResult.quality !== undefined, 'REGRESSION: quality metadata preserved through filter');
  ok(firstResult.audio !== undefined, 'REGRESSION: audio class metadata preserved through filter');
  ok(firstResult.kind !== undefined, 'REGRESSION: kind metadata preserved through filter');
  // The full StreamView type is preserved (generic filterStreams<T>).
  // The component's StreamView has codec/transport/confidence — the filter
  // must not strip them. We verify this structurally: the filter returns the
  // same type it receives.
  const fullStream = { ...MIXED_STREAMS[0], codec: 'H.264', transport: 'https' as const, confidence: 'high' as const };
  const fullResults = filterStreams([fullStream], NO_FILTERS);
  ok((fullResults[0] as typeof fullStream).codec === 'H.264', 'REGRESSION: codec field preserved through generic filterStreams<T>');
  ok((fullResults[0] as typeof fullStream).transport === 'https', 'REGRESSION: transport field preserved through generic filterStreams<T>');
  ok((fullResults[0] as typeof fullStream).confidence === 'high', 'REGRESSION: confidence field preserved through generic filterStreams<T>');
}

// ---------------------------------------------------------------------------
// SOURCE-LEVEL CONTRACT
// ---------------------------------------------------------------------------

function section_sourceContract(): void {
  const component = read('src/lib/components/MaveroAddonDownload.svelte');
  const helperSource = read('src/lib/shared/downloader-filters.ts');
  // The component imports the shared pure helper (no duplicated filter logic).
  ok(component.includes('import {') && component.includes('filterStreams'), 'SOURCE: component imports filterStreams from shared helper');
  ok(component.includes('typeOptions') && component.includes('qualityOptions') && component.includes('sizeOptions') && component.includes('languageOptions'), 'SOURCE: component imports all four option-derivation helpers');
  ok(component.includes('activeFilterChips') && component.includes('hasActiveFilters') && component.includes('clearFilterDimension'), 'SOURCE: component imports active-filter-chip + Clear helpers');
  // The shared helper exists and exports the expected functions.
  ok(helperSource.includes('export function filterStreams'), 'SOURCE: helper exports filterStreams');
  ok(helperSource.includes('export function streamMatchesLanguage'), 'SOURCE: helper exports streamMatchesLanguage (the semantic matching helper)');
  ok(helperSource.includes('export function typeOptions'), 'SOURCE: helper exports typeOptions');
  ok(helperSource.includes('export function qualityOptions'), 'SOURCE: helper exports qualityOptions');
  ok(helperSource.includes('export function sizeOptions'), 'SOURCE: helper exports sizeOptions');
  ok(helperSource.includes('export function languageOptions'), 'SOURCE: helper exports languageOptions');
  ok(helperSource.includes('export function activeFilterChips'), 'SOURCE: helper exports activeFilterChips');
  ok(helperSource.includes('export function hasActiveFilters'), 'SOURCE: helper exports hasActiveFilters');
  // The component uses chip-based UI (not native <select>).
  ok(component.includes('mad-chip'), 'SOURCE: component uses mad-chip class (chip-based UI)');
  // The component uses chip-based UI (not native <select>). Check that no
  // actual <select> HTML element exists in the markup — the string `<select`
  // may still appear in comments documenting the Phase C migration.
  ok(!/<select[\s>]/.test(component.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '')), 'SOURCE: component does NOT use native <select> element in markup (no browser-default dropdown)');
  // The component has a filtered-empty state distinct from addon failure.
  ok(component.includes('mad-state-filtered-empty'), 'SOURCE: component has a distinct filtered-empty state');
  ok(component.includes('No matching links'), 'SOURCE: filtered-empty state shows "No matching links"');
  // The component has active-filter chips + Clear.
  ok(component.includes('mad-active-filters'), 'SOURCE: component has an active-filters row');
  ok(component.includes('mad-active-chip'), 'SOURCE: component has removable active-filter chips');
  ok(component.includes('mad-clear'), 'SOURCE: component has a Clear button');
  ok(component.includes('clearAllFilters'), 'SOURCE: component wires clearAllFilters');
  // Accessibility: chips have aria-pressed for selected state.
  ok(component.includes('aria-pressed='), 'SOURCE: filter chips have aria-pressed (accessible selected state)');
  ok(component.includes('aria-label='), 'SOURCE: filter chips have aria-label');
  // The filter state resets when switching tabs.
  ok(component.includes('resetFilters'), 'SOURCE: component resets filters on tab switch');
}

// ---------------------------------------------------------------------------
// runner
// ---------------------------------------------------------------------------

section_type();
section_quality();
section_size();
section_language();
section_combinations();
section_empty_clear();
section_showMore();
section_regression();
section_sourceContract();

console.log(`stremio_downloader_phaseC_filters_test: ${passed} checks passed (Phase C: dynamic Type/Quality/Size/Language chips with counts, semantic audio matching, AND-combination, filtered-empty state, Clear, full-collection filtering, Phase B regression)`);
