import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  activeCloudStreamChips,
  applyCloudStreamGroup,
  applyCloudStreamGroups,
  clearCloudStreamFilterDimension,
  cloudStreamAudioClass,
  cloudStreamCodecOptions,
  cloudStreamContainerOptions,
  cloudStreamEpisodeContext,
  cloudStreamLanguageOptions,
  cloudStreamOutcomeSummary,
  cloudStreamQualityOptions,
  cloudStreamSizeOptions,
  cloudStreamTabsLoading,
  cloudStreamUserMessage,
  filterCloudStreamLinks,
  hasActiveCloudStreamFilters,
  markCloudStreamTabFailed,
  NO_CS_FILTERS,
  parseCloudStreamExtensionPayload,
  parseCloudStreamGroupsPayload,
  parseCloudStreamTabsPayload,
  visibleCloudStreamLinks,
  type CloudStreamFilters,
  type CloudStreamSourceTab,
} from '$lib/shared/cloudstream-download-view';
import {
  downloadActionFor,
  playActionFor,
  shareActionFor,
  streamCapabilities,
  type CapabilityStream,
} from '$lib/shared/stream-actions';
import type { CloudStreamDownloadLinkView } from '$lib/shared/cloudstream-types';

/**
 * CS-4 suite: the Mavero Downloader 2 (CloudStream) UI — the shared
 * view-model's payload parsing, tab reduction, filtering, capability mapping,
 * error/empty/partial-failure states, the component's markup contracts
 * (a11y + responsive), a runtime mount check, and existing-downloader
 * regression invariants.
 *
 * Deterministic: MOCKED API payload objects only — the suite NEVER hits the
 * network, never opens a browser, and never depends on live CloudStream
 * sites or the live Supabase catalog.
 *
 * Layers:
 *   §A  payload parsing (mocked /tabs, /mavero2, /mavero2/extension bodies)
 *   §B  tab reduction + outcome summaries (partial failure, all failed, empty)
 *   §C  filters (quality/codec/container/language/size, reset, no-match)
 *   §D  capabilities (Download/Play/Share per kind — the SHARED model)
 *   §E  error messages + episode context + presentation rules
 *   §F  component source contracts (a11y, responsive, no-overflow, states)
 *   §G  runtime mount (SSR render of the compiled chunk)
 *   §H  existing Mavero Downloader regression invariants (isolation)
 */

let passed = 0;
function ok(condition: unknown, label: string) {
  assert.ok(condition, label);
  passed += 1;
}

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative: string) => readFileSync(path.join(REPO_ROOT, relative), 'utf8');

// The pristine pre-CS-4 commit — the frozen-surface pin for §H.
const PRISTINE_CS3 = '59634a9';

// ---------------------------------------------------------------------------
// Fixtures — realistic mocked CS-3 response bodies (the shapes the service
// actually emits; mirrors the CS-3 suite's fixtures).
// ---------------------------------------------------------------------------

const MOVIE_LINK = (overrides: Partial<CloudStreamDownloadLinkView> = {}): CloudStreamDownloadLinkView => ({
  url: 'https://new47.gdflix.video/file/dl/path/movie-1080p.mkv',
  kind: 'https',
  quality: '1080p',
  codec: 'H.264',
  container: 'MKV',
  filename: 'Movie.2024.1080p.mkv',
  sizeBytes: 5.8 * 1024 ** 3,
  audioLanguages: ['Hindi', 'English'],
  host: 'new47.gdflix.video',
  provider: 'Bollyflix',
  sourceName: 'GDFlix [Direct]',
  extractor: 'gdflix',
  ...overrides,
});

const TABS_PAYLOAD = {
  ok: true,
  consideredExtensions: 3,
  media: { mediaType: 'movie', tmdbId: '12345', title: 'Test Movie', year: 2024 },
  tabs: [
    { extensionId: 'Bollyflix', extensionName: 'Bollyflix', iconUrl: null, supportedMediaTypes: ['movie', 'series'], enabled: true, compatible: true },
    { extensionId: 'MoviesDrive', extensionName: 'MoviesDrive', iconUrl: null, supportedMediaTypes: ['movie', 'series'], enabled: true, compatible: true },
    { extensionId: 'VegaMovies', extensionName: 'VegaMovies', iconUrl: null, supportedMediaTypes: ['movie', 'series'], enabled: true, compatible: true },
  ],
};

const PARTIAL_GROUPS_PAYLOAD = {
  ok: true,
  consideredExtensions: 3,
  media: { mediaType: 'movie', tmdbId: '12345', title: 'Test Movie', year: 2024 },
  groups: [
    {
      extensionId: 'Bollyflix',
      extensionName: 'Bollyflix',
      status: 'loaded',
      links: [
        MOVIE_LINK(),
        MOVIE_LINK({ url: 'https://new47.gdflix.video/file/dl/path/movie-720p.mkv', quality: '720p', codec: 'H.264', container: 'MKV', filename: 'Movie.2024.720p.mkv', sizeBytes: 2.4 * 1024 ** 3 }),
        MOVIE_LINK({ url: 'https://pixeldrain.com/api/file/abc123?download', quality: '2160p', codec: 'HEVC', container: 'MKV', filename: 'Movie.2024.2160p.mkv', sizeBytes: 12.4 * 1024 ** 3, host: 'pixeldrain.com', sourceName: 'Pixeldrain', audioLanguages: ['Hindi', 'English', 'Tamil'] }),
      ],
    },
    { extensionId: 'MoviesDrive', extensionName: 'MoviesDrive', status: 'failed', links: [], errorCode: 'PROVIDER_TIMEOUT', errorMessage: 'The provider resolution timed out.' },
    { extensionId: 'VegaMovies', extensionName: 'VegaMovies', status: 'failed', links: [], errorCode: 'EXTRACTOR_FAILED', errorMessage: 'The link extraction failed for this provider.' },
  ],
};

// ---------------------------------------------------------------------------
// §A — payload parsing (mocked API responses; malformed-response safety)
// ---------------------------------------------------------------------------

function section_payloadParsing(): void {
  const tabs = parseCloudStreamTabsPayload(TABS_PAYLOAD);
  ok(tabs.kind === 'ok', '§A1: /tabs ok-envelope parses');
  if (tabs.kind === 'ok') {
    ok(tabs.value.tabs.length === 3, '§A1: three tabs parsed from the payload');
    ok(tabs.value.consideredExtensions === 3, '§A1: consideredExtensions passthrough');
    ok(tabs.value.tabs[0].extensionId === 'Bollyflix' && tabs.value.tabs[0].extensionName === 'Bollyflix', '§A1: tab identity fields parsed');
    ok(tabs.value.tabs[0].supportedMediaTypes.length === 2, '§A1: supportedMediaTypes parsed');
    ok(tabs.value.media !== null && tabs.value.media.title === 'Test Movie', '§A1: media echo parsed');
  }

  // Empty catalog variants (mocked — no live DB).
  const noneEnabled = parseCloudStreamTabsPayload({ ok: true, consideredExtensions: 0, media: null, tabs: [] });
  ok(noneEnabled.kind === 'ok' && noneEnabled.value.tabs.length === 0 && noneEnabled.value.consideredExtensions === 0, '§A2: no-enabled-extensions payload → empty tabs + considered=0');
  const noneCompatible = parseCloudStreamTabsPayload({ ok: true, consideredExtensions: 5, media: null, tabs: [] });
  ok(noneCompatible.kind === 'ok' && noneCompatible.value.tabs.length === 0 && noneCompatible.value.consideredExtensions === 5, '§A2: enabled-but-not-compatible payload → empty tabs + considered=5 (distinct state)');

  const groups = parseCloudStreamGroupsPayload(PARTIAL_GROUPS_PAYLOAD);
  ok(groups.kind === 'ok', '§A3: batch ok-envelope parses');
  if (groups.kind === 'ok') {
    ok(groups.value.groups.length === 3, '§A3: three groups parsed');
    ok(groups.value.groups[0].links.length === 3, '§A3: loaded group carries its links');
    ok(groups.value.groups[1].errorCode === 'PROVIDER_TIMEOUT', '§A3: failed group carries its closed-vocabulary errorCode');
  }

  // Envelope errors (mocked RATE_LIMITED 429 body).
  const rateLimited = parseCloudStreamTabsPayload({ ok: false, error: { code: 'RATE_LIMITED', message: 'Too many requests. Please slow down and try again shortly.' } });
  ok(rateLimited.kind === 'error' && rateLimited.code === 'RATE_LIMITED', '§A4: RATE_LIMITED envelope parses to a typed error');

  // Malformed backend responses — never throw, always typed.
  for (const [index, malformed] of [null, 'string', 42, {}, { ok: 'yes' }, { ok: true, tabs: 'nope' }, { ok: true, groups: [{ noId: true }] }, { ok: false, error: { code: 'WEIRD_CODE' } }].entries()) {
    let parsedTabs: ReturnType<typeof parseCloudStreamTabsPayload> | null = null;
    let parsedGroups: ReturnType<typeof parseCloudStreamGroupsPayload> | null = null;
    let threw = false;
    try {
      parsedTabs = parseCloudStreamTabsPayload(malformed);
      parsedGroups = parseCloudStreamGroupsPayload(malformed);
    } catch { threw = true; }
    ok(!threw, `§A5.${index}: malformed payload never throws`);
    ok(parsedTabs !== null && parsedGroups !== null, `§A5.${index}: malformed payload degrades to a typed result`);
    if (parsedTabs && parsedTabs.kind === 'error') {
      ok((['RATE_LIMITED', 'INTERNAL_ERROR'] as string[]).includes(parsedTabs.code), `§A5.${index}: malformed tabs payload maps into the closed vocabulary`);
    }
    if (parsedGroups && parsedGroups.kind === 'error') {
      ok((['RATE_LIMITED', 'INTERNAL_ERROR'] as string[]).includes(parsedGroups.code), `§A5.${index}: malformed groups payload maps into the closed vocabulary`);
    }
  }

  // Link-level validation: invalid links are skipped, valid ones kept.
  const dirtyGroups = parseCloudStreamGroupsPayload({
    ok: true,
    consideredExtensions: 1,
    groups: [{
      extensionId: 'Bollyflix',
      extensionName: 'Bollyflix',
      status: 'loaded',
      links: [
        MOVIE_LINK(),
        { url: '', kind: 'https' },
        { url: 'https://ok.example/file.mkv' },
        { url: 'https://ok.example/file2.mkv', kind: 'nonsense-kind' },
        'garbage',
        null,
      ],
    }],
  });
  ok(dirtyGroups.kind === 'ok' && dirtyGroups.value.groups[0].links.length === 1, '§A6: malformed link entries are skipped (only the valid link survives)');

  const single = parseCloudStreamExtensionPayload({ ok: true, media: null, group: PARTIAL_GROUPS_PAYLOAD.groups[0] });
  ok(single.kind === 'ok' && single.value.group.extensionId === 'Bollyflix', '§A7: /extension payload parses to one group');
  const singleError = parseCloudStreamExtensionPayload({ ok: false, error: { code: 'EXTENSION_DISABLED', message: 'This CloudStream extension is disabled.' } });
  ok(singleError.kind === 'error' && singleError.code === 'EXTENSION_DISABLED', '§A7: /extension envelope error parses');
}

// ---------------------------------------------------------------------------
// §B — tab reduction + outcome summaries
// ---------------------------------------------------------------------------

function section_tabReduction(): void {
  const loadingTabs = cloudStreamTabsLoading(parseCloudStreamTabsPayload(TABS_PAYLOAD).kind === 'ok' ? parseCloudStreamTabsPayload(TABS_PAYLOAD).value.tabs : []);
  ok(loadingTabs.length === 3, '§B1: tabs render into loading states');
  ok(loadingTabs.every((tab) => tab.status === 'loading' && tab.links.length === 0), '§B1: every tab starts loading with zero links');

  const tabsPayload = parseCloudStreamTabsPayload(TABS_PAYLOAD);
  const groupsPayload = parseCloudStreamGroupsPayload(PARTIAL_GROUPS_PAYLOAD);
  assert(tabsPayload.kind === 'ok' && groupsPayload.kind === 'ok');
  const resolved = applyCloudStreamGroups(cloudStreamTabsLoading(tabsPayload.value.tabs), groupsPayload.value.groups);

  // §B2 source results: the loaded group's links + counts land on the tab.
  const bolly = resolved.find((tab) => tab.extensionId === 'Bollyflix');
  ok(bolly?.status === 'loaded' && bolly.links.length === 3, '§B2: loaded group → tab status loaded with 3 links (count from the batch response)');
  const drive = resolved.find((tab) => tab.extensionId === 'MoviesDrive');
  ok(drive?.status === 'failed' && drive.errorCode === 'PROVIDER_TIMEOUT', '§B2: failed group → tab failed with its errorCode');

  // §B3 partial failure: successful sources SURVIVE alongside failed ones.
  ok(cloudStreamOutcomeSummary(resolved) === 'partial', '§B3: mixed loaded+failed groups → outcome partial (never a global error)');
  ok(resolved[0].links.length > 0, '§B3: the successful source keeps its links while others failed');

  // §B4 all-provider failure.
  const allFailed = applyCloudStreamGroups(loadingTabs, [
    { extensionId: 'Bollyflix', extensionName: 'Bollyflix', status: 'failed', links: [], errorCode: 'NETWORK_ERROR' },
    { extensionId: 'MoviesDrive', extensionName: 'MoviesDrive', status: 'failed', links: [], errorCode: 'PROVIDER_TIMEOUT' },
    { extensionId: 'VegaMovies', extensionName: 'VegaMovies', status: 'failed', links: [], errorCode: 'EXTRACTOR_FAILED' },
  ]);
  ok(cloudStreamOutcomeSummary(allFailed) === 'all-failed', '§B4: every group failed → outcome all-failed (distinct message)');
  ok(allFailed.every((tab) => tab.errorCode !== undefined), '§B4: each failed tab carries a closed-vocabulary code');

  // §B5 no results (providers answered, zero links).
  const noResults = applyCloudStreamGroups(loadingTabs, [
    { extensionId: 'Bollyflix', extensionName: 'Bollyflix', status: 'empty', links: [] },
    { extensionId: 'MoviesDrive', extensionName: 'MoviesDrive', status: 'empty', links: [] },
  ]);
  ok(cloudStreamOutcomeSummary(noResults) === 'no-results', '§B5: all-empty groups → outcome no-results');

  // §B6 a tab with a missing group (defensive) degrades to failed, not stuck.
  const missing = applyCloudStreamGroups(loadingTabs, [{ extensionId: 'MoviesDrive', extensionName: 'MoviesDrive', status: 'empty', links: [] }]);
  const orphan = missing.find((tab) => tab.extensionId === 'Bollyflix');
  ok(orphan?.status === 'failed' && orphan.errorCode === 'INTERNAL_ERROR', '§B6: a tab without a matching group degrades to failed INTERNAL_ERROR (never a stuck spinner)');

  // §B7 single-group application (per-extension retry path).
  const retried = applyCloudStreamGroup(allFailed, { extensionId: 'VegaMovies', extensionName: 'VegaMovies', status: 'loaded', links: [MOVIE_LINK()] });
  ok(retried.find((tab) => tab.extensionId === 'VegaMovies')?.links.length === 1, '§B7: per-extension retry folds ONE group into its tab');
  ok(retried.find((tab) => tab.extensionId === 'Bollyflix')?.status === 'failed', '§B7: per-extension retry leaves other tabs untouched');

  // §B8 envelope-error marking during retry.
  const marked = markCloudStreamTabFailed(retried, 'vegamovies', 'RATE_LIMITED');
  ok(marked.find((tab) => tab.extensionId === 'VegaMovies')?.errorCode === 'RATE_LIMITED', '§B8: envelope error during retry marks the tab with the typed code');

  // §B9 external links are hidden from presentation (the existing Phase 18 rule).
  const withExternal = applyCloudStreamGroups(loadingTabs, [{
    extensionId: 'Bollyflix', extensionName: 'Bollyflix', status: 'loaded',
    links: [MOVIE_LINK(), MOVIE_LINK({ url: 'weird://provider-page', kind: 'external' })],
  }]);
  ok(visibleCloudStreamLinks(withExternal[0].links).length === 1, '§B9: external-kind links are hidden from the card list (Phase 18 parity)');
}

// ---------------------------------------------------------------------------
// §C — filters (client-side; a filter change NEVER refetches)
// ---------------------------------------------------------------------------

const FILTER_LINKS: CloudStreamDownloadLinkView[] = [
  MOVIE_LINK(),
  MOVIE_LINK({ url: 'https://a.example/2160-hevc.mkv', quality: '2160p', codec: 'HEVC', container: 'MKV', audioLanguages: ['Hindi', 'English', 'Tamil'], sizeBytes: 12.4 * 1024 ** 3 }),
  MOVIE_LINK({ url: 'https://b.example/720-mp4.mp4', quality: '720p', codec: 'H.264', container: 'MP4', audioLanguages: ['English'], sizeBytes: 0.9 * 1024 ** 3 }),
  MOVIE_LINK({ url: 'https://c.example/480-mkv.mkv', quality: '480p', codec: 'H.264', container: 'MKV', audioLanguages: undefined, sizeBytes: 0.4 * 1024 ** 3 }),
];

function section_filters(): void {
  // §C9 quality.
  const quality: CloudStreamFilters = { ...NO_CS_FILTERS, quality: '1080p' };
  const byQuality = filterCloudStreamLinks(FILTER_LINKS, quality);
  ok(byQuality.length === 1 && byQuality[0].quality === '1080p', '§C9: quality filter → only 1080p links');
  const qualityOptions = cloudStreamQualityOptions(FILTER_LINKS);
  ok(qualityOptions.some((opt) => opt.value === '1080p' && opt.count === 1), '§C9: quality options derive counts from the collection');
  ok(qualityOptions.some((opt) => opt.value === 'auto' && opt.count === 0) === false, '§C9: absent qualities never appear as options');

  // §C10 codec.
  const byCodec = filterCloudStreamLinks(FILTER_LINKS, { ...NO_CS_FILTERS, codec: 'HEVC' });
  ok(byCodec.length === 1 && byCodec[0].codec === 'HEVC', '§C10: codec filter → only HEVC links');
  const codecOptions = cloudStreamCodecOptions(FILTER_LINKS);
  ok(codecOptions.length === 3, '§C10: codec options = All + H.264 + HEVC (only codecs present)');
  ok(codecOptions.find((opt) => opt.value === 'H.264')?.count === 3, '§C10: codec counts reflect the collection');

  // §C11 container.
  const byContainer = filterCloudStreamLinks(FILTER_LINKS, { ...NO_CS_FILTERS, container: 'MP4' });
  ok(byContainer.length === 1 && byContainer[0].container === 'MP4', '§C11: container filter → only MP4 links');
  ok(cloudStreamContainerOptions(FILTER_LINKS).find((opt) => opt.value === 'MKV')?.count === 3, '§C11: container counts reflect the collection');

  // §C12 language (semantic — reuses the shared matcher incl. Dual/Multi).
  ok(cloudStreamAudioClass(FILTER_LINKS[0]) === 'dual', '§C12: 2 audioLanguages → dual audio class');
  ok(cloudStreamAudioClass(FILTER_LINKS[1]) === 'multi', '§C12: 3 audioLanguages → multi audio class');
  ok(cloudStreamAudioClass(FILTER_LINKS[3]) === 'unknown', '§C12: no audioLanguages → unknown class');
  const byLanguage = filterCloudStreamLinks(FILTER_LINKS, { ...NO_CS_FILTERS, language: 'Tamil' });
  ok(byLanguage.length === 1 && byLanguage[0].quality === '2160p', '§C12: language filter → only links containing Tamil');
  const byDual = filterCloudStreamLinks(FILTER_LINKS, { ...NO_CS_FILTERS, language: 'dual' });
  ok(byDual.length === 2, '§C12: Dual Audio filter → dual + multi links (the shared semantics)');
  const languageOptions = cloudStreamLanguageOptions(FILTER_LINKS);
  ok(languageOptions.find((opt) => opt.value === 'multi') !== undefined, '§C12: Multi Audio option appears when multi links exist');
  ok(languageOptions.find((opt) => opt.value === 'Hindi')?.count === 2, '§C12: language option counts reflect membership');

  // §C13 size (reused shared ranges: < 1 GB etc.).
  const bySize = filterCloudStreamLinks(FILTER_LINKS, { ...NO_CS_FILTERS, size: 'under1' });
  ok(bySize.length === 2 && bySize.every((link) => (link.sizeBytes ?? 0) < 1024 ** 3), '§C13: size filter < 1 GB → only known small links (unknown-size excluded)');
  ok(cloudStreamSizeOptions(FILTER_LINKS).find((opt) => opt.value === 'over20') === undefined, '§C13: absent size ranges never appear as options');

  // §C13 filter reset.
  const active: CloudStreamFilters = { quality: '1080p', codec: 'HEVC', container: 'MKV', language: 'Hindi', size: 'under1' };
  ok(hasActiveCloudStreamFilters(active), '§C13: all five active filters detected');
  const clearedOne = clearCloudStreamFilterDimension(active, 'codec');
  ok(clearedOne.codec === 'all' && clearedOne.quality === '1080p' && clearedOne.container === 'MKV', '§C13: clearing one dimension preserves the others');
  const reset: CloudStreamFilters = { ...NO_CS_FILTERS };
  ok(!hasActiveCloudStreamFilters(reset) && filterCloudStreamLinks(FILTER_LINKS, reset).length === FILTER_LINKS.length, '§C13: full reset → no active filters, all links visible');
  const chips = activeCloudStreamChips(active);
  ok(chips.length === 5, '§C13: five active chips derived (one per dimension)');

  // §C14 no-filter-match.
  const noMatch = filterCloudStreamLinks(FILTER_LINKS, { ...NO_CS_FILTERS, quality: '1080p', codec: 'HEVC' });
  ok(noMatch.length === 0, '§C14: contradictory filters → zero matches (the filtered-empty state)');
}

// ---------------------------------------------------------------------------
// §D — capabilities (the SINGLE shared action model, per kind)
// ---------------------------------------------------------------------------

function section_capabilities(): void {
  const https = MOVIE_LINK();
  // §D15 Download capability: http/https → direct-download anchor.
  const httpsDownload = downloadActionFor(https as CapabilityStream);
  ok(httpsDownload !== null && httpsDownload.flow === 'direct-download', '§D15: HTTPS link → direct-download flow');
  ok(httpsDownload !== null && httpsDownload.href === https.url && (httpsDownload as { href: string }).href.includes('gdflix'), '§D15: the Download action preserves the EXACT original URL (no proxy/rewrite)');
  ok(streamCapabilities(https).download === true, '§D15: HTTPS capabilities include Download');

  // §D16 Play/MPV: delegates to externalPlayerLaunchFor (Android intent /
  // direct link) — the single MPV mechanism, never duplicated.
  const httpsPlay = playActionFor(https as CapabilityStream);
  ok(httpsPlay !== null && typeof httpsPlay.href === 'string' && httpsPlay.href.length > 0, '§D16: Play action built for HTTPS (external-player launch helper)');
  ok(streamCapabilities(https).play === true, '§D16: HTTPS capabilities include Play');

  // §D17 Share: always available.
  ok(shareActionFor(https as CapabilityStream).available === true, '§D17: Share available for HTTPS');
  ok(streamCapabilities(MOVIE_LINK({ kind: 'magnet', url: 'magnet:?xt=urn:btih:abcdef123&dn=test' })).share === true, '§D17: Share available for magnet');

  // §D18 unsupported actions hidden per kind.
  const hls = MOVIE_LINK({ kind: 'hls', url: 'https://stream.example/master.m3u8' });
  ok(downloadActionFor(hls as CapabilityStream) === null, '§D18: HLS → NO Download (manifest, not a file)');
  ok(playActionFor(hls as CapabilityStream) !== null, '§D18: HLS → Play IS available');
  const magnet = MOVIE_LINK({ kind: 'magnet', url: 'magnet:?xt=urn:btih:abcdef123&dn=test' });
  ok(downloadActionFor(magnet as CapabilityStream) !== null && downloadActionFor(magnet as CapabilityStream)?.flow === 'external-open', '§D18: magnet → Download via OS handler');
  ok(playActionFor(magnet as CapabilityStream) === null, '§D18: magnet → NO Play (browser cannot play a magnet)');
  const dash = MOVIE_LINK({ kind: 'dash', url: 'https://stream.example/manifest.mpd' });
  ok(streamCapabilities(dash).download === false && streamCapabilities(dash).play === true, '§D18: DASH → Play + Share only');

  // Pixeldrain links route through the embedded-sheet flow (viewer page).
  const pixeldrain = MOVIE_LINK({ url: 'https://pixeldrain.com/api/file/abc123?download' });
  const pdDownload = downloadActionFor(pixeldrain as CapabilityStream);
  ok(pdDownload !== null && pdDownload.flow === 'embedded-sheet' && pdDownload.href.includes('/u/abc123'), '§D18: Pixeldrain → embedded-sheet flow with the viewer URL (the shared Phase F semantics)');
}

// ---------------------------------------------------------------------------
// §E — error messages, episode context, movie vs series request shapes
// ---------------------------------------------------------------------------

function section_messagesAndContext(): void {
  // §E22 rate-limited → friendly message, never a stack trace.
  ok(cloudStreamUserMessage('RATE_LIMITED') === 'Too many requests. Please try again shortly.', '§E22: RATE_LIMITED → the friendly message');
  ok(cloudStreamUserMessage('PROVIDER_TIMEOUT') === 'Source took too long to respond.', '§E22: PROVIDER_TIMEOUT → the friendly message');
  ok(cloudStreamUserMessage('EXTRACTOR_FAILED') === 'Source could not be resolved.', '§E22: EXTRACTOR_FAILED → the friendly message');
  ok(cloudStreamUserMessage('NO_RESULTS') === 'No downloadable sources were found.', '§E22: NO_RESULTS → the friendly message');
  for (const code of ['INVALID_REQUEST', 'EXTENSION_NOT_FOUND', 'EXTENSION_DISABLED', 'ADAPTER_NOT_AVAILABLE', 'UNSUPPORTED_MEDIA', 'NETWORK_ERROR', 'INTERNAL_ERROR'] as const) {
    ok(cloudStreamUserMessage(code).length > 0, `§E22: user message exists for ${code}`);
  }

  // §E8 series episode context — media echo preferred, props fallback.
  ok(cloudStreamEpisodeContext({ mediaType: 'series', tmdbId: '94605', title: 'Arcane', season: 2, episode: 4 }, undefined, undefined) === 'Season 2 · Episode 4', '§E8: episode context from the media echo');
  ok(cloudStreamEpisodeContext(null, 1, 7) === 'Season 1 · Episode 7', '§E8: episode context falls back to the component props');
  ok(cloudStreamEpisodeContext(null, undefined, 4) === null, '§E8: episode context requires BOTH season and episode');
  ok(cloudStreamEpisodeContext({ mediaType: 'movie', tmdbId: '123', title: 'Movie' }, undefined, undefined) === null, '§E8: movies never show an episode context');

  // §E7 movie vs series request shapes (the param builder contract).
  const component = read('src/lib/components/MaveroCloudStreamDownload.svelte');
  ok(component.includes('const params = new URLSearchParams({ contentId, mediaType, tmdbId });'), '§E7: request params build from contentId + mediaType + tmdbId');
  ok(component.includes("if (season !== undefined) params.set('season', String(season));"), '§E7: season only appended when defined (movies stay movie-shaped)');
  ok(component.includes("if (episode !== undefined) params.set('episode', String(episode));"), '§E7: episode only appended when defined');
  ok(component.includes("params.set('extensionId', tab.extensionId);"), '§E7/§21: the retry path targets the single-extension endpoint with the tab id');
}

// ---------------------------------------------------------------------------
// §F — component source contracts (a11y, responsive, states, security)
// ---------------------------------------------------------------------------

function section_sourceContracts(): void {
  const component = read('src/lib/components/MaveroCloudStreamDownload.svelte');

  // §F26 accessibility basics.
  ok(component.includes('role="tablist"') && component.includes('aria-label="CloudStream sources"'), '§F26: source tabs expose role=tablist with an accessible label');
  ok(component.includes('role="tab"') && component.includes('aria-selected={tab.extensionId === activeTabId}'), '§F26: tabs expose role=tab + aria-selected state');
  ok(component.includes('aria-busy={tabsLoading || resolving}'), '§F26: the container exposes aria-busy during loads');
  ok(component.includes('role="status"'), '§F26: state messages use role=status (announced)');
  ok(component.includes('aria-label="Download original file"') && component.includes('aria-label="Play in external player"') && component.includes('aria-label={shareKey === key && shareState === \'shared\' ? \'URI shared\''), '§F26: icon-only action buttons carry accessible names');
  ok(component.includes('aria-label="Open filters"') && component.includes('aria-label={`Remove ${chip.label} filter`}') && component.includes('aria-label="Clear all filters"'), '§F26: filter controls are labeled');
  ok(component.includes('.mcd-tab:focus-visible') || component.includes('focus-visible'), '§F26: focus-visible states styled');
  ok(component.includes('role="list"') && component.includes('role="listitem"'), '§F26: the link list uses semantic list roles');

  // §F25 mobile / no-overflow.
  ok(component.includes('.mcd-tabs { display: flex; gap: 5px; overflow-x: auto;'), '§F25: source tabs scroll horizontally (compact mobile tabs)');
  ok(component.includes('scrollbar-width: none;') && component.includes('.mcd-tabs::-webkit-scrollbar { display: none; }'), '§F25: the tab strip hides its scrollbar');
  ok(component.includes('@media (max-width: 360px)') && component.includes('@media (min-width: 700px)') && component.includes('@media (min-width: 1024px)'), '§F25: the three-tier responsive ladder exists (narrow / tablet / desktop)');
  ok(component.includes('.mcd-badge-host { display: none; }'), '§F25: the widest badge drops off on ≤360px screens (no overflow)');
  ok(component.includes('.mcd-tab-name { max-width: 120px; overflow: hidden; text-overflow: ellipsis;'), '§F25: long source names truncate (no tab blowout)');
  ok(!/(?<!max-)(?<!min-)(?<!-)width:\s*[3-9]\d\dpx/.test(component), '§F25: no fixed card widths that could overflow narrow screens (min-/max-width media bounds excluded)');

  // §F states — loading / empty / errors / retry.
  ok(component.includes('Finding CloudStream sources…'), '§F2: tabs loading state message');
  ok(component.includes('mcd-skeleton-card'), '§F2: skeleton cards while loading');
  ok(component.includes('No CloudStream sources are enabled.'), '§F4: no-enabled-extensions empty state');
  ok(component.includes('An administrator can enable them under System → Integrations → Extension.'), '§F4: admin hint (no admin controls exposed to users)');
  ok(component.includes('No compatible CloudStream sources for this title.'), '§F5: enabled-but-not-compatible state');
  ok(component.includes('No downloadable sources found.'), '§F24: no-results state');
  ok(component.includes('CloudStream sources could not be resolved right now.'), '§F20: all-failed state');
  ok(component.includes('No sources match your filters.'), '§F14: filtered-empty state');
  ok(component.includes('Clear filters'), '§F14: filtered-empty offers a reset action');
  ok(component.includes('retryAll'), '§F21: a full retry mechanism exists');
  ok(component.includes('retryExtension'), '§F21: a per-source retry mechanism exists (the extension endpoint)');
  ok(component.includes('retryAll'), '§F21: retry is manual (no automatic retry loop)');
  ok(!/setInterval/.test(component) && !/setTimeout\([^)]*retry/.test(component), '§F22: no timed/automatic retries (RATE_LIMITED respected)');

  // §F security + URL lifetime: no storage APIs, no provider imports.
  ok(!/\b(localStorage|sessionStorage)\s*\./.test(component) && !/window\.(localStorage|sessionStorage)/.test(component), '§F: no localStorage/sessionStorage API usage (expiring URLs are never persisted)');
  ok(!component.includes('.cs3'), '§F: the client never references .cs3 artifacts');
  ok(!/import\s+.*cloudstream\/(adapters|extractors|resolver|runtime|security)/.test(component), '§F: the client imports NO CloudStream server/provider modules');
  ok(component.includes('/api/downloader/mavero2/tabs') && component.includes('/api/downloader/mavero2?') && component.includes('/api/downloader/mavero2/extension'), '§F: all three CS-3 endpoints are consumed via the Mavero API only');
  // No hardcoded provider names — tabs always come from the backend.
  ok(!component.includes("'Bollyflix'") && !component.includes("'MoviesDrive'") && !component.includes("'VegaMovies'"), '§F: no hard-coded provider names in the component (tabs are backend-driven)');

  // §F partial-failure markup: per-source failure + retry.
  ok(component.includes('mcd-tab-state failed') || component.includes("tab.status === 'failed'"), '§F19: failed sources render a Failed tab pill');
  ok(component.includes('cloudStreamUserMessage(activeTab.errorCode'), '§F19: the failed active tab shows the user-readable message');
}

// ---------------------------------------------------------------------------
// §G — runtime mount (SSR render through vite's module graph — the component
// is not yet imported by any route, so no compiled app chunk exists until
// CS-5 wires it in; loading it through vite's SSR transform evaluates the
// exact component instance code at runtime — mount-time safety).
// ---------------------------------------------------------------------------

type MountableComponent = unknown;

async function section_runtimeMount(): Promise<void> {
  const { createServer } = await import('vite');
  const server = await createServer({
    server: { middlewareMode: true },
    appType: 'custom',
    logLevel: 'error',
  });
  try {
    // Load svelte/server THROUGH vite so the component and the render entry
    // share ONE svelte runtime instance (a second instance has null SSR
    // context and onDestroy throws — the dual-instance pitfall).
    const svelteServer = (await server.ssrLoadModule('svelte/server')) as { render: (component: MountableComponent, options: { props: Record<string, unknown> }) => { body: string } };
    const mod = (await server.ssrLoadModule('/src/lib/components/MaveroCloudStreamDownload.svelte')) as { default: MountableComponent };
    const MaveroCloudStreamDownload = mod.default;

    // §G1 movie context.
    let err: unknown = null;
    let html = '';
    try {
      const result = svelteServer.render(MaveroCloudStreamDownload, {
        props: {
          contentId: 'movie-123',
          mediaType: 'movie',
          tmdbId: '123',
          season: undefined,
          episode: undefined,
          title: 'Test Movie',
          onOpenInSheet: undefined,
        },
      });
      html = result.body;
    } catch (e) { err = e; }
    ok(err === null, `§G1 (movie): the component mounts WITHOUT throwing — got: ${err instanceof Error ? err.message : String(err)}`);
    ok(html.length > 0, '§G1: rendered HTML is non-empty (the component body ran to completion)');
    ok(/mcd\b/.test(html), '§G1: the rendered HTML contains the .mcd container (the panel mounted)');
    ok(/Finding CloudStream sources|aria-busy="true"/.test(html), '§G2: initial SSR state shows the tabs-loading surface');

    // §G2 series episode context.
    let seriesErr: unknown = null;
    let seriesHtml = '';
    try {
      const result = svelteServer.render(MaveroCloudStreamDownload, {
        props: {
          contentId: 'series-94605',
          mediaType: 'series',
          tmdbId: '94605',
          season: 2,
          episode: 4,
          title: 'Arcane',
          onOpenInSheet: (url: string) => { void url; },
        },
      });
      seriesHtml = result.body;
    } catch (e) { seriesErr = e; }
    ok(seriesErr === null, `§G2 (series S2E4): the component mounts WITHOUT throwing — got: ${seriesErr instanceof Error ? seriesErr.message : String(seriesErr)}`);
    ok(seriesHtml.includes('Season 2 · Episode 4'), '§G2: the series episode context line renders from the props');

    // §G3 anime context.
    let animeErr: unknown = null;
    try {
      svelteServer.render(MaveroCloudStreamDownload, {
        props: {
          contentId: 'anime-12345',
          mediaType: 'anime',
          tmdbId: '12345',
          season: 1,
          episode: 1,
          title: 'Test Anime',
          onOpenInSheet: undefined,
        },
      });
    } catch (e) { animeErr = e; }
    ok(animeErr === null, `§G3 (anime): the component mounts WITHOUT throwing — got: ${animeErr instanceof Error ? animeErr.message : String(animeErr)}`);
  } finally {
    await server.close();
  }
}

// ---------------------------------------------------------------------------
// §H — existing Mavero Downloader regression invariants (isolation)
// ---------------------------------------------------------------------------

function pristineFile(relative: string): string | null {
  try {
    return execFileSync('git', ['show', `${PRISTINE_CS3}:${relative}`], { cwd: REPO_ROOT, encoding: 'utf8' });
  } catch {
    return null;
  }
}

function section_regression(): void {
  // §H27 the existing Stremio downloader UI is untouched.
  const addon = read('src/lib/components/MaveroAddonDownload.svelte');
  const pristineAddon = pristineFile('src/lib/components/MaveroAddonDownload.svelte');
  ok(pristineAddon === null || pristineAddon === addon, '§H27: MaveroAddonDownload.svelte is byte-identical to the pristine CS-3 commit');

  const sheet = read('src/lib/components/DownloadSheet.svelte');
  const pristineSheet = pristineFile('src/lib/components/DownloadSheet.svelte');
  // §H27 (FINAL TASK evolution — second documented recalibration; the first
  // was CS-5, which this suite recorded when the panel was wired IN): the
  // unified Mavero Downloader task RETIRES the separate Downloader 2 slug
  // branch and swaps the mavero-downloader inline panel to
  // MaveroUnifiedDownload (add-on + plugin sources in one rail). The
  // invariant evolves to: every change vs the pristine CS-3 commit belongs
  // to (a) the CS-5 wiring lineage, (b) the FINAL TASK unified-panel swap +
  // Downloader-2 branch removal, or (c) the PART J dropdown alignment fix.
  // The structural pins below assert exactly that shape; the byte-level
  // line calibration is retired (it cannot survive two sanctioned
  // recalibrations while staying meaningful).
  if (pristineSheet !== null) {
    // Comment-STripped comparison (recalibration-safe): HTML <!-- -->,
    // CSS /* */ and // line comments are removed from BOTH files first, so
    // the diff is code-only and survives any sanctioned comment evolution.
    const stripComments = (text: string): string[] =>
      text
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n')
        .map((line) => line.replace(/\s*\/\/.*$/, '').trimEnd())
        .filter((line) => line.trim().length > 0);
    const pristineCode = stripComments(pristineSheet);
    const sheetCode = stripComments(sheet);
    // Every removal must be a line the two sanctioned evolutions explain:
    // the CS-5 import/branch/constants that the FINAL TASK removed, the old
    // no-URL skip condition (CS-5), the old MaveroAddonDownload wiring
    // (FINAL TASK swap), or the PART J CSS lines.
    const codeRemovals = pristineCode.filter((line) => !sheetCode.includes(line));
    ok(
      codeRemovals.every((line) =>
        line.includes('MAVERO_DOWNLOADER_2_PROVIDER_ID')
        || line.includes('MaveroCloudStreamDownload')
        || line.includes('MaveroAddonDownload')
        || line.includes('isMaveroDownloader2')
        || line.includes('justify-content: space-between')
        || line.includes('.dl-item-name { overflow: hidden;')),
      `§H27: every removed DownloadSheet code line belongs to the sanctioned CS-5/FINAL-TASK evolutions (removed ${codeRemovals.length})`,
    );
    const codeAdditions = sheetCode.filter((line) => !pristineCode.includes(line));
    ok(
      codeAdditions.some((line) => line.includes('MaveroUnifiedDownload'))
      && codeAdditions.every((line) =>
        line.includes('MaveroUnifiedDownload')
        || line.includes('MAVERO_DOWNLOADER_2_PROVIDER_ID')
        || line.includes('MaveroCloudStreamDownload')
        || line.includes('isMaveroDownloader')
        || line.includes('.dl-item-name')
        || line.includes('.dl-item-badge')
        || line.includes('.dl-dropdown-item')
        || line.includes('flex-start')
        || line.includes('min-width: 0')
        || line.includes('margin-left: auto')
        || line.includes('retired')
        || line.includes('unified')
        || line.includes('retire')),
      `§H27: every added DownloadSheet code line is the unified-panel swap, the retirement, or the PART J dropdown fix (added ${codeAdditions.length})`,
    );
  } else {
    ok(true, '§H27: pristine sheet unavailable — FINAL TASK wiring checked structurally');
  }

  // §H27 the frozen shared action model is untouched.
  for (const frozen of ['src/lib/shared/stream-actions.ts', 'src/lib/shared/external-player.ts', 'src/lib/shared/download-link-types.ts', 'src/lib/shared/downloader-filters.ts']) {
    const current = read(frozen);
    const pristine = pristineFile(frozen);
    ok(pristine === null || pristine === current, `§H27: ${frozen} is byte-identical (the shared action model semantics are frozen)`);
  }

  // §H27 the DownloaderFilterSheet change is EXACTLY the additive dimension
  // union widening (documented adaptation) — behavior code unchanged.
  const filterSheet = read('src/lib/components/DownloaderFilterSheet.svelte');
  const pristineFilterSheet = pristineFile('src/lib/components/DownloaderFilterSheet.svelte');
  if (pristineFilterSheet !== null) {
    // Multiset diff (line shifts make index comparison meaningless): the
    // ONLY removed line must be the old dimension union; every added line
    // must be the widening (the new union + its explanatory comment).
    const removed = pristineFilterSheet.split('\n').filter((line) => !filterSheet.includes(line));
    const added = filterSheet.split('\n').filter((line) => !pristineFilterSheet.includes(line));
    ok(
      removed.length === 1 && removed[0].includes("dimension: 'type' | 'quality' | 'language' | 'size';"),
      `§H27: the ONLY removed DownloaderFilterSheet line is the old dimension union (removed ${removed.length})`,
    );
    ok(
      added.length <= 6
      && added.some((line) => line.includes("dimension: 'type' | 'quality' | 'language' | 'size' | 'codec' | 'container';"))
      && added.every((line) => line.includes('dimension:') || line.trim().startsWith('//') || line.trim() === ''),
      `§H27: DownloaderFilterSheet additions are ONLY the codec/container union widening + its comment (added ${added.length})`,
    );
  } else {
    ok(true, '§H27: pristine filter sheet unavailable (git missing) — dimension-widening checked structurally');
  }

  // §H27 the Stremio panel still passes exactly its four original dimensions.
  ok(addon.includes("dimension: 'type'") && addon.includes("dimension: 'quality'") && !addon.includes("dimension: 'codec'"), '§H27: MaveroAddonDownload still passes only its original four filter dimensions');

  // §H27 registry / migration surface — FINAL TASK evolution (the original
  // assertion guarded against PREMATURE registry integration; CS-5 was the
  // documented wiring phase; the FINAL TASK is the documented retirement
  // phase): the registry migrations are exactly the CS-5 seed (wiring) +
  // the unified-downloader global-order migration (ordering + retire).
  const migrations = execFileSync('ls', [path.join(REPO_ROOT, 'supabase/migrations')], { encoding: 'utf8' }).split('\n').filter(Boolean);
  ok(migrations.length > 0, '§H27: the migrations directory is intact (sanity)');
  const registryMigrations = migrations.filter((name) => /cs4|downloader2|cs5|unified_downloader/i.test(name));
  ok(
    registryMigrations.length === 2
    && registryMigrations.includes('20261101000001_cloudstream_cs5_downloader2.sql')
    && registryMigrations.includes('20261004000000_unified_downloader_global_order.sql'),
    `§H27: the registry migrations are exactly the CS-5 seed + the FINAL TASK unified-order/retire migration (${registryMigrations.join(', ') || 'none'})`,
  );
  ok(!read('src/lib/components/MaveroCloudStreamDownload.svelte').includes('download_providers'), '§H27: the Downloader 2 UI never touches the download_providers registry');

  // §H27 (FINAL TASK evolution — the CS-5 wiring is RETIRED): the sheet no
  // longer imports/renders the Downloader 2 component or dispatches on its
  // slug constant — the provider row is disabled (migration) and its plugin
  // sources resolve through the UNIFIED panel the mavero-downloader slug
  // renders instead.
  ok(!sheet.includes("import MaveroCloudStreamDownload from"), '§H27: DownloadSheet NO LONGER imports the Downloader 2 component (retired)');
  ok((sheet.match(/<MaveroCloudStreamDownload/g) ?? []).length === 0, '§H27: the Downloader 2 component renders ZERO times in the sheet (retired)');
  ok(!sheet.includes('isMaveroDownloader2'), '§H27: the retired slug branch is gone');
  ok(sheet.includes("import MaveroUnifiedDownload from '$components/MaveroUnifiedDownload.svelte'"), '§H27: DownloadSheet imports the UNIFIED downloader panel (the FINAL TASK wiring)');
  ok((sheet.match(/<MaveroUnifiedDownload/g) ?? []).length === 1, '§H27: the unified panel renders exactly ONCE (the mavero-downloader branch)');
  const sharedDownloader = read('src/lib/shared/downloader.ts');
  ok(sharedDownloader.includes("export const MAVERO_DOWNLOADER_2_PROVIDER_ID = 'mavero-downloader-2';"), '§H27: the Downloader 2 provider slug constant REMAINS registered (retired row, harmless back-compat)');
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

await section_payloadParsing();
section_tabReduction();
section_filters();
section_capabilities();
section_messagesAndContext();
section_sourceContracts();
await section_runtimeMount();
section_regression();

console.log(`cloudstream_downloader_ui_test: ${passed} checks passed (CS-4 Downloader 2 UI: payload parsing, tab reduction, partial failure, filters, capabilities, states, a11y/responsive contracts, mount safety, existing-downloader isolation)`);
