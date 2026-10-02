/**
 * MAVERO Downloader 2 (CloudStream) — CS-4 shared view-model (pure).
 *
 * The SINGLE source of truth for the MaveroCloudStreamDownload component's
 * data shaping: response-payload validation, tab-state reduction, filter
 * logic, and user-readable error mapping. Both the Svelte component and the
 * test suite import from here so the rules can never drift between the UI
 * and the tests (the same architecture as `downloader-filters.ts` for the
 * Stremio downloader).
 *
 * ARCHITECTURE (plan §14/§27 — CS-4 consumes the CS-3 backend):
 *
 *   MaveroCloudStreamDownload.svelte
 *     → GET /api/downloader/mavero2/tabs      (parseCloudStreamTabsPayload)
 *     → GET /api/downloader/mavero2           (parseCloudStreamGroupsPayload — ONE batch)
 *     → applyCloudStreamGroups → per-extension tabs with links + counts
 *     → GET /api/downloader/mavero2/extension (single-extension RETRY only)
 *
 *   NO second action model: link `kind` uses the shared StreamKind
 *   vocabulary, so capabilities map EXACTLY onto `stream-actions.ts`
 *   (downloadActionFor / playActionFor / streamCapabilities).
 *
 *   NO client-side caching of resolved URLs (plan §40.7 — URLs expire);
 *   every mount re-resolves through the API.
 *
 * FILTER REUSE (genuinely generic, no duplication):
 *   * quality / size / language matching REUSES the existing pure matchers
 *     from `downloader-filters.ts` (`streamMatchesQuality`,
 *     `streamMatchesSize`, `streamMatchesLanguage`) plus its option
 *     derivation helpers (`qualityOptions`, `sizeOptions`,
 *     `languageOptions`, `sizeFilterLabel`) — CloudStream links structurally
 *     satisfy `FilterableStream` once an audio class is derived from
 *     `audioLanguages`.
 *   * codec / container are CloudStream-specific dimensions (the CS-3 link
 *     view carries them; the Stremio stream view does not) — new matchers +
 *     option derivation live here, NEXT TO the reused ones.
 *
 * MALFORMED-BACKEND-RESPONSE SAFETY: every payload field is validated before
 * it reaches component state — unknown shapes degrade to safe empty/error
 * states, never to "undefined"/"null" render artifacts, and never to thrown
 * exceptions inside render.
 *
 * Pure module: no DOM, no network, no Svelte, no server imports.
 */

import type { AudioClass } from '$lib/shared/stream-selection';
import type {
  CloudStreamDownloadGroupView,
  CloudStreamDownloadLinkView,
  CloudStreamDownloadMediaView,
  CloudStreamDownloadTabView,
  CloudStreamDownloaderErrorCode,
} from '$lib/shared/cloudstream-types';
import {
  qualityOptions,
  sizeOptions,
  sizeFilterLabel,
  languageOptions,
  streamMatchesLanguage,
  streamMatchesQuality,
  streamMatchesSize,
  type FilterableStream,
  type LanguageOption,
  type QualityOption,
  type SizeFilterValue,
  type SizeOption,
} from '$lib/shared/downloader-filters';
import type { StreamKind } from '$lib/shared/stream-actions';

// ---------------------------------------------------------------------------
// Closed vocabularies + bounds
// ---------------------------------------------------------------------------

const KINDS: readonly StreamKind[] = ['http', 'https', 'hls', 'dash', 'p2p', 'magnet', 'external'];

const ERROR_CODES: readonly CloudStreamDownloaderErrorCode[] = [
  'INVALID_REQUEST',
  'EXTENSION_NOT_FOUND',
  'EXTENSION_DISABLED',
  'ADAPTER_NOT_AVAILABLE',
  'UNSUPPORTED_MEDIA',
  'NO_RESULTS',
  'PROVIDER_TIMEOUT',
  'EXTRACTOR_FAILED',
  'NETWORK_ERROR',
  'RATE_LIMITED',
  'INTERNAL_ERROR',
];

/** Media types a tab can advertise (closed subset of ContentType). */
const MEDIA_TYPES: readonly ('movie' | 'series' | 'anime')[] = ['movie', 'series', 'anime'];

/** Display string bound — keeps malformed payloads from flooding the DOM. */
const MAX_DISPLAY_STRING = 300;
/** Link array bound — mirrors the CS-2 per-extractor link bound (≤24). */
const MAX_LINKS_PER_GROUP = 200;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Bounded, trimmed display string; undefined for malformed input. */
function boundedString(value: unknown, max = MAX_DISPLAY_STRING): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > max) return undefined;
  return trimmed;
}

// ---------------------------------------------------------------------------
// User-readable error messages (closed vocabulary → friendly text)
// ---------------------------------------------------------------------------

/**
 * Friendly per-code user messages (the CS-4 brief's canonical texts). The
 * server's curated `errorMessage` is a safe fallback for unknown codes —
 * internal stack traces never reach this layer by construction (CS-3).
 */
const USER_MESSAGES: Record<CloudStreamDownloaderErrorCode, string> = {
  INVALID_REQUEST: 'This request could not be processed.',
  EXTENSION_NOT_FOUND: 'This source is no longer installed.',
  EXTENSION_DISABLED: 'This source is currently disabled.',
  ADAPTER_NOT_AVAILABLE: 'This source is not supported yet.',
  UNSUPPORTED_MEDIA: 'This source does not support this kind of title.',
  NO_RESULTS: 'No downloadable sources were found.',
  PROVIDER_TIMEOUT: 'Source took too long to respond.',
  EXTRACTOR_FAILED: 'Source could not be resolved.',
  NETWORK_ERROR: 'Source could not be reached right now.',
  RATE_LIMITED: 'Too many requests. Please try again shortly.',
  INTERNAL_ERROR: 'Something went wrong. Please try again.',
};

/** The user-readable message for a closed-vocabulary error code. */
export function cloudStreamUserMessage(code: CloudStreamDownloaderErrorCode, fallback?: string): string {
  return USER_MESSAGES[code] ?? (typeof fallback === 'string' && fallback.length > 0 ? fallback : USER_MESSAGES.INTERNAL_ERROR);
}

// ---------------------------------------------------------------------------
// Tab state model (the component's per-extension UI state)
// ---------------------------------------------------------------------------

export type CloudStreamSourceStatus = 'loading' | 'loaded' | 'empty' | 'failed';

/**
 * One CloudStream source tab's UI state. Counts derive from the batch
 * response's link array — NO extra provider requests are made for counts.
 */
export type CloudStreamSourceTab = {
  extensionId: string;
  extensionName: string;
  iconUrl: string | null;
  status: CloudStreamSourceStatus;
  links: CloudStreamDownloadLinkView[];
  errorCode?: CloudStreamDownloaderErrorCode;
  /** Curated server message (fallback display only). */
  errorMessage?: string;
  /** Provider-matched page title when the adapter surfaced one. */
  matchedTitle?: string;
};

/** The batch payload's overall outcome for messaging decisions. */
export type CloudStreamOutcomeSummary = 'loaded' | 'partial' | 'no-results' | 'all-failed';

// ---------------------------------------------------------------------------
// Payload parsing (malformed-response-safe)
// ---------------------------------------------------------------------------

/** A validated `/tabs` or `/mavero2` response body, or a typed failure. */
export type CloudStreamParsedPayload<T> =
  | { kind: 'ok'; value: T }
  | { kind: 'error'; code: CloudStreamDownloaderErrorCode; message?: string };

function envelopeError(raw: Record<string, unknown>): CloudStreamParsedPayload<never> | null {
  const error = raw.error;
  if (!isRecord(error)) return null;
  const code = error.code;
  const message = boundedString(error.message);
  if (typeof code !== 'string' || !(ERROR_CODES as readonly string[]).includes(code)) {
    return { kind: 'error', code: 'INTERNAL_ERROR' };
  }
  return { kind: 'error', code: code as CloudStreamDownloaderErrorCode, ...(message !== undefined ? { message } : {}) };
}

/** Parses one link view from a raw payload entry (invalid → null). */
function parseLinkView(raw: unknown): CloudStreamDownloadLinkView | null {
  if (!isRecord(raw)) return null;
  const url = boundedString(raw.url, 2048);
  const kind = raw.kind;
  if (url === undefined || url.length === 0) return null;
  if (typeof kind !== 'string' || !(KINDS as readonly string[]).includes(kind)) return null;
  const sourceName = boundedString(raw.sourceName, 120) ?? 'CloudStream';
  const view: CloudStreamDownloadLinkView = {
    url,
    kind: kind as StreamKind,
    provider: boundedString(raw.provider, 120) ?? 'cloudstream',
    sourceName,
  };
  const quality = boundedString(raw.quality, 40);
  if (quality !== undefined) view.quality = quality;
  const codec = boundedString(raw.codec, 40);
  if (codec !== undefined) view.codec = codec;
  const container = boundedString(raw.container, 40);
  if (container !== undefined) view.container = container;
  const filename = boundedString(raw.filename, 200);
  if (filename !== undefined) view.filename = filename;
  const sizeBytes = raw.sizeBytes;
  if (typeof sizeBytes === 'number' && Number.isSafeInteger(sizeBytes) && sizeBytes > 0) view.sizeBytes = sizeBytes;
  if (Array.isArray(raw.audioLanguages)) {
    const langs = raw.audioLanguages
      .filter((lang): lang is string => typeof lang === 'string' && lang.trim().length > 0 && lang.length <= 40)
      .slice(0, 8);
    if (langs.length > 0) view.audioLanguages = langs;
  }
  const host = boundedString(raw.host, 120);
  if (host !== undefined) view.host = host;
  const extractor = boundedString(raw.extractor, 80);
  if (extractor !== undefined) view.extractor = extractor;
  return view;
}

/** Parses one group view (invalid entries degrade, never throw). */
function parseGroupView(raw: unknown): CloudStreamDownloadGroupView | null {
  if (!isRecord(raw)) return null;
  const extensionId = boundedString(raw.extensionId, 200);
  if (extensionId === undefined) return null;
  const status = raw.status;
  if (status !== 'loaded' && status !== 'empty' && status !== 'failed') return null;
  const links = Array.isArray(raw.links)
    ? raw.links.map(parseLinkView).filter((link): link is CloudStreamDownloadLinkView => link !== null).slice(0, MAX_LINKS_PER_GROUP)
    : [];
  const group: CloudStreamDownloadGroupView = {
    extensionId,
    extensionName: boundedString(raw.extensionName, 200) ?? extensionId,
    status,
    links,
  };
  if (status === 'failed') {
    const code = raw.errorCode;
    group.errorCode = typeof code === 'string' && (ERROR_CODES as readonly string[]).includes(code)
      ? (code as CloudStreamDownloaderErrorCode)
      : 'INTERNAL_ERROR';
    const message = boundedString(raw.errorMessage);
    if (message !== undefined) group.errorMessage = message;
  }
  const matchedTitle = boundedString(raw.matchedTitle);
  if (matchedTitle !== undefined) group.matchedTitle = matchedTitle;
  return group;
}

/**
 * Validates and shapes the `/api/downloader/mavero2/tabs` response body.
 * Malformed bodies degrade to typed errors; malformed TAB entries are
 * skipped; a missing `tabs` array is treated as empty.
 */
export function parseCloudStreamTabsPayload(raw: unknown): CloudStreamParsedPayload<{
  tabs: CloudStreamDownloadTabView[];
  consideredExtensions: number;
  media: CloudStreamDownloadMediaView | null;
}> {
  if (!isRecord(raw) || raw.ok !== true) {
    if (isRecord(raw)) {
      const typed = envelopeError(raw);
      if (typed !== null) return typed;
    }
    return { kind: 'error', code: 'INTERNAL_ERROR' };
  }
  const considered = raw.consideredExtensions;
  const consideredExtensions = typeof considered === 'number' && Number.isSafeInteger(considered) && considered >= 0
    ? considered
    : 0;
  const tabs: CloudStreamDownloadTabView[] = Array.isArray(raw.tabs)
    ? raw.tabs
        .map((tab): CloudStreamDownloadTabView | null => {
          if (!isRecord(tab)) return null;
          const extensionId = boundedString(tab.extensionId, 200);
          const extensionName = boundedString(tab.extensionName, 200);
          if (extensionId === undefined || extensionName === undefined) return null;
          const supportedMediaTypes = Array.isArray(tab.supportedMediaTypes)
            ? tab.supportedMediaTypes.filter(
                (type): type is 'movie' | 'series' | 'anime' =>
                  typeof type === 'string' && (MEDIA_TYPES as readonly string[]).includes(type),
              )
            : [];
          return {
            extensionId,
            extensionName,
            iconUrl: boundedString(tab.iconUrl, 2048) ?? null,
            supportedMediaTypes,
            enabled: tab.enabled === true,
            compatible: tab.compatible === true,
          };
        })
        .filter((tab): tab is CloudStreamDownloadTabView => tab !== null)
    : [];
  return { kind: 'ok', value: { tabs, consideredExtensions, media: parseMediaView(raw.media) } };
}

/** Parses the `media` echo when present (display-only). */
function parseMediaView(raw: unknown): CloudStreamDownloadMediaView | null {
  if (!isRecord(raw)) return null;
  const tmdbId = boundedString(raw.tmdbId, 12);
  const title = boundedString(raw.title);
  const mediaType = raw.mediaType;
  if (tmdbId === undefined || title === undefined) return null;
  if (mediaType !== 'movie' && mediaType !== 'series' && mediaType !== 'anime') return null;
  const media: CloudStreamDownloadMediaView = { mediaType, tmdbId, title };
  const year = raw.year;
  if (typeof year === 'number' && Number.isSafeInteger(year) && year > 0) media.year = year;
  const season = raw.season;
  if (typeof season === 'number' && Number.isSafeInteger(season) && season >= 1 && season <= 10000) media.season = season;
  const episode = raw.episode;
  if (typeof episode === 'number' && Number.isSafeInteger(episode) && episode >= 1 && episode <= 10000) media.episode = episode;
  return media;
}

/**
 * Validates and shapes the `/api/downloader/mavero2` batch response body.
 * Malformed bodies degrade to typed errors; malformed groups are skipped.
 */
export function parseCloudStreamGroupsPayload(raw: unknown): CloudStreamParsedPayload<{
  groups: CloudStreamDownloadGroupView[];
  consideredExtensions: number;
  media: CloudStreamDownloadMediaView | null;
}> {
  if (!isRecord(raw) || raw.ok !== true) {
    if (isRecord(raw)) {
      const typed = envelopeError(raw);
      if (typed !== null) return typed;
    }
    return { kind: 'error', code: 'INTERNAL_ERROR' };
  }
  const groups = Array.isArray(raw.groups)
    ? raw.groups.map(parseGroupView).filter((group): group is CloudStreamDownloadGroupView => group !== null)
    : [];
  const considered = raw.consideredExtensions;
  const consideredExtensions = typeof considered === 'number' && Number.isSafeInteger(considered) && considered >= 0
    ? considered
    : 0;
  return { kind: 'ok', value: { groups, consideredExtensions, media: parseMediaView(raw.media) } };
}

/** Validates and shapes the `/api/downloader/mavero2/extension` response body. */
export function parseCloudStreamExtensionPayload(raw: unknown): CloudStreamParsedPayload<{
  group: CloudStreamDownloadGroupView;
  media: CloudStreamDownloadMediaView | null;
}> {
  if (!isRecord(raw) || raw.ok !== true) {
    if (isRecord(raw)) {
      const typed = envelopeError(raw);
      if (typed !== null) return typed;
    }
    return { kind: 'error', code: 'INTERNAL_ERROR' };
  }
  const group = parseGroupView(raw.group);
  if (group === null) return { kind: 'error', code: 'INTERNAL_ERROR' };
  return { kind: 'ok', value: { group, media: parseMediaView(raw.media) } };
}

// ---------------------------------------------------------------------------
// Tab reduction (batch groups → tab states; single group → one tab)
// ---------------------------------------------------------------------------

function groupToTabState(tab: CloudStreamSourceTab, group: CloudStreamDownloadGroupView): CloudStreamSourceTab {
  return {
    ...tab,
    status: group.status === 'loaded' && group.links.length > 0 ? 'loaded' : group.status === 'failed' ? 'failed' : 'empty',
    links: group.links,
    ...(group.errorCode !== undefined ? { errorCode: group.errorCode } : { errorCode: undefined }),
    ...(group.errorMessage !== undefined ? { errorMessage: group.errorMessage } : { errorMessage: undefined }),
    ...(group.matchedTitle !== undefined ? { matchedTitle: group.matchedTitle } : { matchedTitle: undefined }),
  };
}

/** Tab rows in `loading` state from validated tab views (before resolution). */
export function cloudStreamTabsLoading(tabs: CloudStreamDownloadTabView[]): CloudStreamSourceTab[] {
  return tabs.map((tab) => ({
    extensionId: tab.extensionId,
    extensionName: tab.extensionName,
    iconUrl: tab.iconUrl,
    status: 'loading' as const,
    links: [],
  }));
}

/**
 * Folds a batch response's groups into the tab states (extensionId match is
 * case-insensitive — the CS-3 canonical id convention). Tabs with no matching
 * group degrade to a failed INTERNAL_ERROR tab (defensive — the batch
 * endpoint emits one group per eligible extension).
 */
export function applyCloudStreamGroups(
  tabs: CloudStreamSourceTab[],
  groups: CloudStreamDownloadGroupView[],
): CloudStreamSourceTab[] {
  const byId = new Map(groups.map((group) => [group.extensionId.toLowerCase(), group]));
  return tabs.map((tab) => {
    const group = byId.get(tab.extensionId.toLowerCase());
    if (group === undefined) {
      return { ...tab, status: 'failed' as const, links: [], errorCode: 'INTERNAL_ERROR' as const, errorMessage: undefined };
    }
    return groupToTabState(tab, group);
  });
}

/** Folds ONE group result into the matching tab (per-extension retry). */
export function applyCloudStreamGroup(
  tabs: CloudStreamSourceTab[],
  group: CloudStreamDownloadGroupView,
): CloudStreamSourceTab[] {
  return tabs.map((tab) =>
    tab.extensionId.toLowerCase() === group.extensionId.toLowerCase() ? groupToTabState(tab, group) : tab,
  );
}

/** Marks one tab as failed with a typed error (envelope error during retry). */
export function markCloudStreamTabFailed(
  tabs: CloudStreamSourceTab[],
  extensionId: string,
  code: CloudStreamDownloaderErrorCode,
): CloudStreamSourceTab[] {
  return tabs.map((tab) =>
    tab.extensionId.toLowerCase() === extensionId.toLowerCase()
      ? { ...tab, status: 'failed' as const, links: [], errorCode: code, errorMessage: undefined }
      : tab,
  );
}

/**
 * Settles every still-loading tab into a typed failure (Permanent Adapter
 * Plan Phase 1). Used when the batch resolve ends WITHOUT group results —
 * a typed envelope error (RATE_LIMITED / INTERNAL_ERROR / …) or a client
 * timeout — so no tab spinner can outlive the request that owns it.
 * Already-settled tabs (loaded/empty/failed) are NEVER touched: one failed
 * request must not reset successful providers.
 */
export function settleCloudStreamLoadingTabs(
  tabs: CloudStreamSourceTab[],
  code: CloudStreamDownloaderErrorCode,
): CloudStreamSourceTab[] {
  return tabs.map((tab) =>
    tab.status === 'loading'
      ? { ...tab, status: 'failed' as const, links: [], errorCode: code, errorMessage: undefined }
      : tab,
  );
}

// ---------------------------------------------------------------------------
// Outcome summary (distinct empty / failure messaging)
// ---------------------------------------------------------------------------

/**
 * Derives the batch outcome for messaging:
 *   * 'loaded'     — ≥1 tab with links, no failed tabs
 *   * 'partial'    — ≥1 tab with links AND ≥1 failed tab (partial success)
 *   * 'no-results' — zero links overall, not every tab failed
 *   * 'all-failed' — every tab failed
 */
export function cloudStreamOutcomeSummary(tabs: CloudStreamSourceTab[]): CloudStreamOutcomeSummary {
  if (tabs.length === 0) return 'no-results';
  const failed = tabs.filter((tab) => tab.status === 'failed');
  const withLinks = tabs.filter((tab) => tab.links.length > 0);
  if (withLinks.length > 0) return failed.length > 0 ? 'partial' : 'loaded';
  return failed.length === tabs.length ? 'all-failed' : 'no-results';
}

// ---------------------------------------------------------------------------
// Series-episode context (display)
// ---------------------------------------------------------------------------

/**
 * The "Season N · Episode M" context line for series episodes. Prefers the
 * server's media echo (the request identity as resolved server-side); falls
 * back to the component props. Movies → null (no episode context).
 */
export function cloudStreamEpisodeContext(
  media: CloudStreamDownloadMediaView | null | undefined,
  season: number | undefined,
  episode: number | undefined,
): string | null {
  const s = media?.season ?? season;
  const e = media?.episode ?? episode;
  if (s === undefined || e === undefined) return null;
  if (typeof s !== 'number' || typeof e !== 'number' || !Number.isSafeInteger(s) || !Number.isSafeInteger(e)) return null;
  if (s < 1 || s > 10000 || e < 1 || e > 10000) return null;
  return `Season ${s} · Episode ${e}`;
}

// ---------------------------------------------------------------------------
// Audio class derivation (for the REUSED language filter matchers)
// ---------------------------------------------------------------------------

/**
 * Derives the audio class from the link's `audioLanguages` (the same
 * derivation the Stremio normalizer applies server-side): 3+ languages →
 * multi, 2 → dual, 1 → single, none → unknown. Pure function of provided
 * data — no fabricated membership.
 */
export function cloudStreamAudioClass(link: CloudStreamDownloadLinkView): AudioClass {
  const langs = link.audioLanguages ?? [];
  if (langs.length >= 3) return 'multi';
  if (langs.length === 2) return 'dual';
  if (langs.length === 1) return 'single';
  return 'unknown';
}

/** Adapts a link view to the shared FilterableStream shape (structural). */
function asFilterable(link: CloudStreamDownloadLinkView): FilterableStream {
  return {
    url: link.url,
    kind: link.kind,
    quality: link.quality ?? 'auto',
    audio: cloudStreamAudioClass(link),
    ...(link.audioLanguages !== undefined ? { audioLanguages: link.audioLanguages } : {}),
    ...(link.sizeBytes !== undefined ? { sizeBytes: link.sizeBytes } : {}),
  };
}

// ---------------------------------------------------------------------------
// Filters (quality / codec / container / language / size — client-side)
// ---------------------------------------------------------------------------

/** The five CloudStream filter dimensions. Each defaults to `'all'`. */
export type CloudStreamFilters = {
  quality: 'all' | string;
  codec: 'all' | string;
  container: 'all' | string;
  language: 'all' | 'dual' | 'multi' | string;
  size: 'all' | SizeFilterValue;
};

export type CloudStreamFilterDimension = 'quality' | 'codec' | 'container' | 'language' | 'size';

/** The default (no-filter) state. */
export const NO_CS_FILTERS: CloudStreamFilters = { quality: 'all', codec: 'all', container: 'all', language: 'all', size: 'all' };

/**
 * Codec filter. A link with an UNKNOWN codec cannot be confirmed to match a
 * specific codec — it does not match (the same intended-exclusion semantics
 * as the size filter; never silently included, never fabricated).
 */
export function cloudStreamMatchesCodec(link: CloudStreamDownloadLinkView, codec: CloudStreamFilters['codec']): boolean {
  if (codec === 'all') return true;
  return link.codec === codec;
}

/** Container filter — same semantics as the codec filter. */
export function cloudStreamMatchesContainer(link: CloudStreamDownloadLinkView, container: CloudStreamFilters['container']): boolean {
  if (container === 'all') return true;
  return link.container === container;
}

/**
 * Composite filter — a link survives only if it matches EVERY active
 * dimension (AND composition, plan §10 of the Stremio filter contract).
 * quality/size/language delegate to the REUSED shared matchers.
 */
export function cloudStreamLinkMatchesFilters(link: CloudStreamDownloadLinkView, filters: CloudStreamFilters): boolean {
  const adapted = asFilterable(link);
  return (
    streamMatchesQuality(adapted, filters.quality) &&
    streamMatchesSize(adapted, filters.size) &&
    streamMatchesLanguage(adapted, filters.language) &&
    cloudStreamMatchesCodec(link, filters.codec) &&
    cloudStreamMatchesContainer(link, filters.container)
  );
}

/**
 * Filters a link collection client-side — NO network request is ever made
 * for a filter change (the CS-4 contract). Filters operate on the FULL
 * active-tab collection, never a pre-truncated subset.
 */
export function filterCloudStreamLinks(links: CloudStreamDownloadLinkView[], filters: CloudStreamFilters): CloudStreamDownloadLinkView[] {
  return links.filter((link) => cloudStreamLinkMatchesFilters(link, filters));
}

// ---------------------------------------------------------------------------
// Filter option derivation (only options actually present, with counts)
// ---------------------------------------------------------------------------

export type CloudStreamFilterOption = { value: string; label: string; count: number };

/** Distinct-value option derivation shared by the codec + container dimensions. */
function attributeOptions(
  links: CloudStreamDownloadLinkView[],
  read: (link: CloudStreamDownloadLinkView) => string | undefined,
): CloudStreamFilterOption[] {
  const counts = new Map<string, number>();
  for (const link of links) {
    const value = read(link);
    if (value === undefined) continue;
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  const options: CloudStreamFilterOption[] = [{ value: 'all', label: 'All', count: links.length }];
  for (const [value, count] of [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (count > 0) options.push({ value, label: value, count });
  }
  return options;
}

/** Codec chip options — only codecs actually present (unknown codecs never listed). */
export function cloudStreamCodecOptions(links: CloudStreamDownloadLinkView[]): CloudStreamFilterOption[] {
  return attributeOptions(links, (link) => link.codec);
}

/** Container chip options — only containers actually present. */
export function cloudStreamContainerOptions(links: CloudStreamDownloadLinkView[]): CloudStreamFilterOption[] {
  return attributeOptions(links, (link) => link.container);
}

/** Quality options — REUSED shared derivation (4K → 1080p → … priority order). */
export function cloudStreamQualityOptions(links: CloudStreamDownloadLinkView[]): QualityOption[] {
  return qualityOptions(links.map(asFilterable));
}

/** Size options — REUSED shared derivation (< 1 GB … > 20 GB ranges). */
export function cloudStreamSizeOptions(links: CloudStreamDownloadLinkView[]): SizeOption[] {
  return sizeOptions(links.map(asFilterable));
}

/** Language options — REUSED shared derivation (languages + Dual/Multi Audio). */
export function cloudStreamLanguageOptions(links: CloudStreamDownloadLinkView[]): LanguageOption[] {
  return languageOptions(links.map(asFilterable));
}

// ---------------------------------------------------------------------------
// Active-filter chips + Clear (per CloudStream's five dimensions)
// ---------------------------------------------------------------------------

export type CloudStreamActiveChip = { dimension: CloudStreamFilterDimension; value: string; label: string };

/** True when ANY CloudStream filter dimension is active. */
export function hasActiveCloudStreamFilters(filters: CloudStreamFilters): boolean {
  return (
    filters.quality !== 'all' ||
    filters.codec !== 'all' ||
    filters.container !== 'all' ||
    filters.language !== 'all' ||
    filters.size !== 'all'
  );
}

/** The removable active-filter chips (one per active dimension). */
export function activeCloudStreamChips(filters: CloudStreamFilters): CloudStreamActiveChip[] {
  const chips: CloudStreamActiveChip[] = [];
  if (filters.quality !== 'all') {
    const q = filters.quality;
    chips.push({ dimension: 'quality', value: q, label: q === 'auto' ? 'Auto' : q });
  }
  if (filters.codec !== 'all') chips.push({ dimension: 'codec', value: filters.codec, label: filters.codec });
  if (filters.container !== 'all') chips.push({ dimension: 'container', value: filters.container, label: filters.container });
  if (filters.language !== 'all') {
    const l = filters.language;
    if (l === 'dual') chips.push({ dimension: 'language', value: l, label: 'Dual Audio' });
    else if (l === 'multi') chips.push({ dimension: 'language', value: l, label: 'Multi Audio' });
    else chips.push({ dimension: 'language', value: l, label: l });
  }
  if (filters.size !== 'all') {
    chips.push({ dimension: 'size', value: filters.size, label: sizeFilterLabel(filters.size) });
  }
  return chips;
}

/** Clears one dimension (immutable — returns a NEW filters object). */
export function clearCloudStreamFilterDimension(filters: CloudStreamFilters, dimension: CloudStreamFilterDimension): CloudStreamFilters {
  return { ...filters, [dimension]: 'all' };
}

// ---------------------------------------------------------------------------
// Presentation filter (kind=external hidden — the existing downloader's
// Phase 18 presentation rule; CloudStream link cards follow the same rule)
// ---------------------------------------------------------------------------

/**
 * External links (provider/download pages, not direct media) are hidden from
 * the Downloader 2 card list — the same presentation rule as the existing
 * Stremio downloader (Phase 18). Direct/hls/dash/p2p/magnet links render.
 */
export function visibleCloudStreamLinks(links: CloudStreamDownloadLinkView[]): CloudStreamDownloadLinkView[] {
  return links.filter((link) => link.kind !== 'external');
}
