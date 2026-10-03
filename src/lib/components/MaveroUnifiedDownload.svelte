<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { AlertTriangle, Info, Loader2, RotateCw, Share2, Check, FileVideo, Radio, Magnet, Users, Volume2, HardDrive, Server, X, SearchX, Download, Play, SlidersHorizontal, HelpCircle, Captions } from 'lucide-svelte';
  import SelectionSheet from '$components/SelectionSheet.svelte';
  import DownloaderFilterSheet from '$components/DownloaderFilterSheet.svelte';
  import {
    filterStreams,
    typeOptions,
    qualityOptions,
    sizeOptions,
    languageOptions,
    activeFilterChips,
    clearFilterDimension,
    hasActiveFilters,
    NO_FILTERS,
    type DownloaderFilters,
  } from '$lib/shared/downloader-filters';
  import {
    activeCloudStreamChips,
    clearCloudStreamFilterDimension,
    cloudStreamCodecOptions,
    cloudStreamContainerOptions,
    cloudStreamEpisodeContext,
    cloudStreamLanguageOptions,
    cloudStreamQualityOptions,
    cloudStreamSizeOptions,
    cloudStreamUserMessage,
    filterCloudStreamLinks,
    hasActiveCloudStreamFilters,
    NO_CS_FILTERS,
    parseCloudStreamExtensionPayload,
    parseCloudStreamGroupsPayload,
    type CloudStreamFilters,
  } from '$lib/shared/cloudstream-download-view';
  import {
    downloadActionFor,
    playActionFor,
    type CapabilityStream,
  } from '$lib/shared/stream-actions';
  import { linkTypeLabel, linkTypeCategory, type DownloadLinkType } from '$lib/shared/download-link-types';
  import { selectPresentationWindow, showMoreBatch, type PresentableStream } from '$lib/shared/presentation-window';
  import { isPixeldrainUrl } from '$lib/shared/external-player';
  import type { UnifiedSourceView } from '$lib/shared/unified-downloader';
  import { cloudStreamAudioClass } from '$lib/shared/cloudstream-download-view';
  import type { CloudStreamDownloadLinkView, CloudStreamDownloadMediaView, CloudStreamDownloaderErrorCode } from '$lib/shared/cloudstream-types';
  import type { AudioClass } from '$lib/shared/stream-selection';

  /**
   * MAVERO DOWNLOADER — the UNIFIED source panel (FINAL TASK).
   *
   * ONE user-facing downloader carrying BOTH source kinds:
   *
   *     Mavero Downloader
   *       ├── 🟢 Add-on sources   (Stremio — /api/downloader/mavero/addon)
   *       └── 🔵 Plugin sources   (CloudStream/Nuvio — /api/downloader/mavero2,
   *                                permanent adapters — NEVER the Builder)
   *
   * Data flow:
   *   1. mount → GET /api/downloader/mavero/sources (the merged, globally
   *      ranked source list — ONE request, no provider fetches);
   *   2. add-on chips resolve INDEPENDENTLY through the EXISTING per-addon
   *      endpoint (progressive, per-source retry — the Phase 15/16 flow);
   *   3. plugin chips resolve through the EXISTING ONE-BATCH mavero2
   *      endpoint (no N+1; switching chips NEVER refetches; per-source
   *      retry through /mavero2/extension — the CS-4 flow).
   *
   * PARTIAL SUCCESS is the contract: one failed source NEVER becomes a
   * global error — its chip shows a Failed pill + a user-readable message;
   * successful sources keep rendering their links. A failed CATALOG
   * (add-ons or plugins unavailable) also degrades per-kind (the other
   * kind keeps working).
   *
   * GLOBAL ORDERING: the chip rail order comes EXCLUSIVELY from the
   * /sources payload positions (server-side persisted ordering data —
   * addon:<id> + extension:<canonicalKey> in ONE namespace; never array
   * index or insertion order).
   *
   * VISUAL LANGUAGE (task PART C): add-on chips keep the GREEN accent
   * (--accent) of the existing Stremio panel; plugin chips use the BLUE
   * secondary accent (--accent-2). Same chip architecture, same states
   * (loading/failed/count/active), same responsive behavior.
   *
   * URL LIFETIME: resolved URLs are never persisted (no localStorage/
   * sessionStorage, no long-lived caches) — reopening re-resolves.
   */

  // ----- Props (the SAME contract the parent DownloadSheet passed to
  // MaveroAddonDownload — the unified panel replaces it inline) -----
  export let contentId = '';
  export let mediaType: 'movie' | 'series' | 'anime' = 'movie';
  export let tmdbId = '';
  export let season: number | undefined = undefined;
  export let episode: number | undefined = undefined;
  // svelte-ignore export_let_unused -- displayed by the parent sheet header
  export let title = '';
  // Callback into the parent sheet for the embedded-sheet download flow
  // (Pixeldrain viewer pages — the Phase F mechanism). Falls back to an
  // external-open anchor when absent.
  export let onOpenInSheet: ((url: string) => void) | undefined = undefined;

  // ----- Local source model (the unified presentation layer) -----
  type SourceStatus = 'loading' | 'retrying' | 'loaded' | 'empty' | 'unavailable' | 'failed';
  type UnifiedSource = {
    kind: 'addon' | 'plugin';
    id: string;
    name: string;
    position: number;
    status: SourceStatus;
    links: UnifiedLinkView[];
    /** Plugin sources: closed-vocabulary error code (typed envelope). */
    errorCode?: CloudStreamDownloaderErrorCode;
    /** Plugin sources: curated server message (fallback display). */
    errorMessage?: string;
    abort?: AbortController;
  };

  /** The normalized link shape ONE card renderer consumes (both kinds). */
  type UnifiedLinkView = {
    url: string;
    kind: 'http' | 'https' | 'hls' | 'dash' | 'p2p' | 'magnet' | 'external';
    quality: string;
    codec: string;
    audio: AudioClass;
    container?: string;
    filename?: string;
    sizeBytes?: number;
    audioLanguages?: string[];
    host?: string;
    subtitles?: { url: string; language?: string; label?: string }[];
  };

  /** The add-on stream payload shape the unified link is derived from. */
  type AddonStreamPayload = {
    url?: string;
    kind?: string;
    quality?: string;
    codec?: string;
    audio?: string;
    container?: string;
    filename?: string;
    title?: string;
    name?: string;
    sizeBytes?: number;
    audioLanguages?: string[];
    host?: string;
    subtitles?: { url: string; language?: string; label?: string }[];
  };

  let sources: UnifiedSource[] = [];
  let sourcesLoading = true;
  /** Transport failure of the merged /sources request (retry-able). */
  let sourcesFailed = false;
  /** Per-kind catalog degradation flags (honest partial success). */
  let addonCatalogFailed = false;
  let extensionCatalogFailed = false;
  let activeSourceId: string | null = null;

  // The plugin batch carries a server media echo (episode context line).
  let pluginMedia: CloudStreamDownloadMediaView | null = null;

  // Abort controllers — cancelled on destroy so no response ever lands on a
  // destroyed component (the existing panels' pattern).
  let sourcesAbort: AbortController | undefined;
  let batchAbort: AbortController | undefined;
  const retryAborts = new Map<string, AbortController>();

  // ----- Filters: per-kind state (the EXISTING models, unchanged rules) -----
  // The add-on filter model (type/quality/size/language) applies when an
  // ADD-ON source is active; the plugin model (quality/codec/container/
  // language/size) applies when a PLUGIN source is active. Switching
  // sources resets the respective filter state (the existing per-tab rule).
  let addonFilters: DownloaderFilters = { ...NO_FILTERS };
  let pluginFilters: CloudStreamFilters = { ...NO_CS_FILTERS };

  let filterSheetOpen = false;
  function openFilterSheet(): void { filterSheetOpen = true; }
  function closeFilterSheet(): void { filterSheetOpen = false; }

  let infoSheetOpen = false;
  function openInfoSheet(): void { infoSheetOpen = true; }
  function closeInfoSheet(): void { infoSheetOpen = false; }

  // ----- Share action state (same lifecycle as the existing panels) -----
  let shareKey = '';
  let shareState: 'sharing' | 'shared' | 'failed' | '' = '';
  let shareTimer: ReturnType<typeof setTimeout> | undefined;

  // ----- Pixeldrain info state -----
  let pixeldrainInfoKey = '';

  // ----- Derived state -----
  $: activeSource = sources.find((source) => source.id === activeSourceId) ?? null;
  $: activeLinks = activeSource?.links ?? [];
  $: activeIsAddon = activeSource?.kind === 'addon';
  $: activeIsPlugin = activeSource?.kind === 'plugin';
  // The ACTIVE kind's filtered links — the OTHER kind's filter state never
  // applies (rule isolation preserved from the standalone panels). The
  // generic filterStreams preserves the UnifiedLinkView type directly; the
  // plugin filter reads only the structural fields (quality/codec/
  // container/language/size) so the double cast is safe.
  $: filteredLinks = activeIsAddon
    ? filterStreams(activeLinks, addonFilters)
    : activeIsPlugin
      ? filterCloudStreamLinks(activeLinks as unknown as CloudStreamDownloadLinkView[], pluginFilters) as unknown as UnifiedLinkView[]
      : [];
  $: anyFiltersActive = activeIsAddon ? hasActiveFilters(addonFilters) : activeIsPlugin ? hasActiveCloudStreamFilters(pluginFilters) : false;
  $: activeChips = activeIsAddon ? activeFilterChips(addonFilters) : activeIsPlugin ? activeCloudStreamChips(pluginFilters) : [];
  // The episode context line (the mcd surface language): computed from the
  // props immediately (SSR-visible for series) and refined by the plugin
  // batch's server media echo when it lands.
  $: episodeContext = cloudStreamEpisodeContext(pluginMedia, season, episode);

  // Per-kind dynamic filter options (the existing derivation helpers —
  // counts come from the FULL active collection, not the visible window).
  // UnifiedLinkView is structurally FilterableStream-compatible (the add-on
  // model); the plugin helpers read only the structural link fields.
  $: currentTypeOptions = activeIsAddon ? typeOptions(activeLinks) : [];
  $: currentAddonQualityOptions = activeIsAddon ? qualityOptions(activeLinks) : [];
  $: currentAddonLanguageOptions = activeIsAddon ? languageOptions(activeLinks) : [];
  $: currentAddonSizeOptions = activeIsAddon ? sizeOptions(activeLinks) : [];
  $: currentQualityOptions = activeIsPlugin ? cloudStreamQualityOptions(activeLinks as unknown as CloudStreamDownloadLinkView[]) : [];
  $: currentCodecOptions = activeIsPlugin ? cloudStreamCodecOptions(activeLinks as unknown as CloudStreamDownloadLinkView[]) : [];
  $: currentContainerOptions = activeIsPlugin ? cloudStreamContainerOptions(activeLinks as unknown as CloudStreamDownloadLinkView[]) : [];
  $: currentLanguageOptions = activeIsPlugin ? cloudStreamLanguageOptions(activeLinks as unknown as CloudStreamDownloadLinkView[]) : [];
  $: currentSizeOptions = activeIsPlugin ? cloudStreamSizeOptions(activeLinks as unknown as CloudStreamDownloadLinkView[]) : [];
  $: showTypeFilter = currentTypeOptions.length > 2;
  $: showQualityFilter = (activeIsAddon ? currentAddonQualityOptions : currentQualityOptions).length > 2;
  $: showCodecFilter = currentCodecOptions.length > 2;
  $: showContainerFilter = currentContainerOptions.length > 2;
  $: showLanguageFilter = (activeIsAddon ? currentAddonLanguageOptions : currentLanguageOptions).length > 2;
  $: showSizeFilter = (activeIsAddon ? currentAddonSizeOptions : currentSizeOptions).length > 2;

  // Presentation window / Show More (the REUSED shared helpers).
  $: presentationResult = selectPresentationWindow(filteredLinks as unknown as PresentableStream[]);
  let visibleLinks: UnifiedLinkView[] = [];
  let remainingLinks: UnifiedLinkView[] = [];
  $: {
    presentationResult;
    visibleLinks = presentationResult.initial as unknown as UnifiedLinkView[];
    remainingLinks = presentationResult.remaining as unknown as UnifiedLinkView[];
  }

  function handleShowMore(): void {
    const next = showMoreBatch(visibleLinks, remainingLinks);
    visibleLinks = next.visible;
    remainingLinks = next.remaining;
  }

  function resetActiveFilters(): void {
    addonFilters = { ...NO_FILTERS };
    pluginFilters = { ...NO_CS_FILTERS };
  }

  function clearAllFilters(): void { resetActiveFilters(); }

  function removeFilter(dimension: 'type' | 'quality' | 'size' | 'language' | 'codec' | 'container'): void {
    if (activeIsAddon) {
      addonFilters = clearFilterDimension(addonFilters, dimension as 'type' | 'quality' | 'size' | 'language');
    } else if (activeIsPlugin) {
      pluginFilters = clearCloudStreamFilterDimension(pluginFilters, dimension as 'quality' | 'codec' | 'container' | 'language' | 'size');
    }
  }

  // Switching sources is a PURE VIEW switch — both resolution flows already
  // hold every source's links (NO refetch). Stale filter state is reset so
  // it cannot hide all links on the new source (the existing rule).
  function selectSource(id: string): void {
    if (id !== activeSourceId) resetActiveFilters();
    activeSourceId = id;
  }

  // ----- Transport / badge helpers (the shared visual language) -----
  function transportLabel(kind: UnifiedLinkView['kind']): string {
    if (kind === 'external') return 'EXTERNAL · Page';
    const label = linkTypeLabel(kind as DownloadLinkType);
    const category = linkTypeCategory(kind as DownloadLinkType);
    return `${label} · ${category}`;
  }

  function kindIcon(kind: UnifiedLinkView['kind']): typeof FileVideo {
    switch (kind) {
      case 'http': return FileVideo;
      case 'https': return FileVideo;
      case 'hls': return Radio;
      case 'dash': return Radio;
      case 'p2p': return Users;
      case 'magnet': return Magnet;
      default: return FileVideo;
    }
  }

  function kindLabel(kind: UnifiedLinkView['kind']): string {
    switch (kind) {
      case 'http': return 'HTTP';
      case 'https': return 'HTTPS';
      case 'hls': return 'HLS';
      case 'dash': return 'DASH';
      case 'p2p': return 'P2P';
      case 'magnet': return 'MAGNET';
      default: return 'EXTERNAL';
    }
  }

  function qualityBadgeClass(quality: string): string {
    switch (quality) {
      case '4K': return 'mud-badge-quality mud-badge-4k';
      case '1080p': return 'mud-badge-quality mud-badge-1080';
      case '720p': return 'mud-badge-quality mud-badge-720';
      case '480p': return 'mud-badge-quality mud-badge-480';
      default: return 'mud-badge-quality mud-badge-auto';
    }
  }

  function formatSize(bytes?: number): string | undefined {
    if (!bytes || bytes <= 0) return undefined;
    if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(bytes >= 10 * 1024 ** 3 ? 0 : 1)} GB`;
    if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`;
    return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  }

  function audioLabel(link: UnifiedLinkView): string | undefined {
    const langs = link.audioLanguages;
    if (langs && langs.length > 0) {
      if (langs.length >= 3) return 'Multi';
      if (langs.length === 2) return 'Dual';
      return langs.slice(0, 3).join(',');
    }
    return undefined;
  }

  /** The card's primary scannable identity: filename, else the hosting server label. */
  function linkDetail(link: UnifiedLinkView): string | undefined {
    const candidate = link.filename;
    if (candidate && candidate.trim()) {
      const trimmed = candidate.trim();
      return trimmed.length > 120 ? `${trimmed.slice(0, 120)}…` : trimmed;
    }
    return undefined;
  }

  function shareTitleFor(link: UnifiedLinkView, sourceName: string): string {
    const fromLink = link.filename;
    if (fromLink && fromLink.trim()) return fromLink.trim().slice(0, 120);
    return `${sourceName} · ${link.quality === 'auto' ? 'Auto' : link.quality}`;
  }

  function defaultSourceId(list: UnifiedSource[]): string | null {
    if (!list.length) return null;
    return (list.find((source) => (source.status === 'loaded' || source.status === 'empty') && source.links.length > 0) ?? list[0]).id;
  }

  /**
   * The honest per-source failure message — the SAME vocabulary the
   * standalone panels use: add-on unavailability is plain English; plugin
   * failures carry the closed error code through cloudStreamUserMessage.
   */
  function activeSourceErrorMessage(source: UnifiedSource): string {
    if (source.kind === 'plugin') {
      return cloudStreamUserMessage(source.errorCode ?? 'INTERNAL_ERROR', source.errorMessage);
    }
    return `${source.name} is unavailable.`;
  }

  function buildParams(): URLSearchParams {
    const params = new URLSearchParams({ contentId, mediaType, tmdbId });
    if (season !== undefined) params.set('season', String(season));
    if (episode !== undefined) params.set('episode', String(episode));
    return params;
  }

  // ----- Client-side fetch deadlines (safety nets sized above the server
  // budgets — the MaveroCloudStreamDownload pattern) -----
  const SOURCES_FETCH_TIMEOUT_MS = 20_000;
  const RESOLVE_FETCH_TIMEOUT_MS = 45_000;

  /** fetch + client deadline; `signal` is the component's abort controller. */
  async function fetchWithTimeout(
    url: string,
    signal: AbortSignal,
    timeoutMs: number,
  ): Promise<{ response: Response; timedOut: boolean }> {
    const timeoutController = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      timeoutController.abort();
    }, timeoutMs);
    const onAbort = () => timeoutController.abort();
    if (signal.aborted) timeoutController.abort();
    else signal.addEventListener('abort', onAbort, { once: true });
    try {
      const response = await fetch(url, {
        headers: { accept: 'application/json' },
        signal: timeoutController.signal,
      });
      return { response, timedOut };
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    }
  }

  // ----- Data flow -----

  /** Normalizes an add-on stream into the unified link shape. */
  function addonStreamToLink(stream: AddonStreamPayload): UnifiedLinkView {
    return {
      url: stream.url ?? '',
      kind: (stream.kind as UnifiedLinkView['kind']) ?? 'https',
      quality: stream.quality ?? 'auto',
      codec: stream.codec ?? 'unknown',
      audio: (stream.audio as AudioClass) ?? 'unknown',
      container: stream.container,
      filename: stream.filename ?? stream.title ?? stream.name,
      sizeBytes: stream.sizeBytes,
      audioLanguages: stream.audioLanguages,
      host: stream.host,
      subtitles: stream.subtitles,
    };
  }

  /** Normalizes a plugin link into the unified link shape. */
  function pluginLinkToLink(link: CloudStreamDownloadLinkView): UnifiedLinkView {
    return {
      url: link.url,
      kind: link.kind,
      quality: link.quality ?? 'auto',
      codec: link.codec ?? 'unknown',
      audio: cloudStreamAudioClass(link),
      container: link.container,
      filename: link.filename ?? link.sourceName,
      sizeBytes: link.sizeBytes,
      audioLanguages: link.audioLanguages,
      host: link.host,
    };
  }

  /**
   * STEP 1 — the merged, globally ranked source list. Add-on and plugin
   * sources arrive interleaved with their global positions; resolution
   * state starts at 'loading' for every source.
   */
  async function loadSources(): Promise<void> {
    sourcesAbort?.abort();
    const abort = new AbortController();
    sourcesAbort = abort;
    sourcesLoading = true;
    sourcesFailed = false;
    addonCatalogFailed = false;
    extensionCatalogFailed = false;
    try {
      const { response, timedOut } = await fetchWithTimeout(
        `/api/downloader/mavero/sources?${buildParams().toString()}`,
        abort.signal,
        SOURCES_FETCH_TIMEOUT_MS,
      );
      if (abort.signal.aborted) return;
      if (timedOut) {
        sources = [];
        activeSourceId = null;
        sourcesFailed = true;
        return;
      }
      const raw: unknown = await response.json().catch(() => null);
      const payload = raw as { ok?: boolean; sources?: UnifiedSourceView[]; addonCatalogFailed?: boolean; extensionCatalogFailed?: boolean } | null;
      if (!response.ok || !payload?.ok || !Array.isArray(payload.sources)) throw new Error('unavailable');
      sources = payload.sources.map((source) => ({
        kind: source.kind,
        id: source.id,
        name: source.name,
        position: source.position,
        status: 'loading' as SourceStatus,
        links: [],
      }));
      addonCatalogFailed = payload.addonCatalogFailed === true;
      extensionCatalogFailed = payload.extensionCatalogFailed === true;
      activeSourceId = defaultSourceId(sources);
    } catch (error) {
      if (abort.signal.aborted) return;
      sources = [];
      activeSourceId = null;
      sourcesFailed = true;
      console.warn('[MaveroDownloader] sources fetch failed', error);
    } finally {
      if (!abort.signal.aborted) sourcesLoading = false;
    }
  }

  /**
   * STEP 2a — ONE add-on source resolution (the EXISTING per-addon
   * progressive flow: independent fetch, per-source abort + retry, a failed
   * add-on never resets the others).
   */
  async function resolveAddonSource(source: UnifiedSource): Promise<void> {
    source.abort?.abort();
    const abort = new AbortController();
    source.abort = abort;
    source.status = source.status === 'unavailable' ? 'loading' : source.status === 'retrying' ? 'retrying' : 'loading';
    source.links = [];
    sources = [...sources];
    const params = buildParams();
    params.set('addon', source.id);
    try {
      const response = await fetch(`/api/downloader/mavero/addon?${params.toString()}`, {
        headers: { accept: 'application/json' },
        signal: abort.signal,
      });
      if (abort.signal.aborted) return;
      const payload = await response.json() as {
        ok?: boolean;
        group?: { status?: string; streams?: AddonStreamPayload[]; errorCode?: string };
      };
      if (!response.ok || !payload.ok || !payload.group) throw new Error('unavailable');
      const groupStatus = payload.group.status;
      source.status = groupStatus === 'loaded' || groupStatus === 'empty' || groupStatus === 'loading' || groupStatus === 'retrying'
        ? (groupStatus as SourceStatus)
        : 'unavailable';
      source.links = (payload.group.streams ?? []).map((stream) => addonStreamToLink(stream));
    } catch (error) {
      if (abort.signal.aborted) return;
      source.status = 'unavailable';
      source.links = [];
      console.warn('[MaveroDownloader] addon source fetch failed', source.id, error);
    } finally {
      if (!abort.signal.aborted) {
        sources = [...sources];
        if (activeSourceId === source.id && source.links.length === 0 && source.status !== 'loaded' && source.status !== 'empty') {
          const firstLoaded = sources.find((candidate) => candidate.links.length > 0);
          if (firstLoaded && firstLoaded.id !== activeSourceId) {
            activeSourceId = firstLoaded.id;
          }
        }
      }
    }
  }

  /**
   * STEP 2b — the plugin BATCH (the EXISTING CS-4 flow: ONE request resolves
   * every plugin source; switching chips NEVER refetches; partial failures
   * surface per-source).
   */
  async function resolvePluginBatch(): Promise<void> {
    if (sources.every((source) => source.kind !== 'plugin')) return;
    batchAbort?.abort();
    const abort = new AbortController();
    batchAbort = abort;
    try {
      const { response, timedOut } = await fetchWithTimeout(
        `/api/downloader/mavero2?${buildParams().toString()}`,
        abort.signal,
        RESOLVE_FETCH_TIMEOUT_MS,
      );
      if (abort.signal.aborted) return;
      if (timedOut) {
        sources = sources.map((source) =>
          source.kind === 'plugin' && source.status === 'loading'
            ? { ...source, status: 'failed' as SourceStatus, errorCode: 'PROVIDER_TIMEOUT' as CloudStreamDownloaderErrorCode, links: [] }
            : source,
        );
        return;
      }
      const raw: unknown = await response.json().catch(() => null);
      const parsed = parseCloudStreamGroupsPayload(raw);
      if (parsed.kind === 'error') {
        sources = sources.map((source) =>
          source.kind === 'plugin' && source.status === 'loading'
            ? { ...source, status: 'failed' as SourceStatus, errorCode: parsed.code, errorMessage: parsed.message, links: [] }
            : source,
        );
        return;
      }
      applyPluginGroups(parsed.value.groups);
      if (parsed.value.media !== null) pluginMedia = parsed.value.media;
      activeSourceId = defaultSourceId(sources);
    } catch (error) {
      if (abort.signal.aborted) return;
      sources = sources.map((source) =>
        source.kind === 'plugin' && source.status === 'loading'
          ? { ...source, status: 'failed' as SourceStatus, errorCode: 'NETWORK_ERROR' as CloudStreamDownloaderErrorCode, links: [] }
          : source,
      );
      console.warn('[MaveroDownloader] plugin batch failed', error);
    }
  }

  /** Applies plugin batch groups to the matching sources (by extension id). */
  function applyPluginGroups(groups: Array<{ extensionId: string; extensionName?: string; status?: string; links?: CloudStreamDownloadLinkView[]; errorCode?: CloudStreamDownloaderErrorCode; errorMessage?: string }>): void {
    const byId = new Map(groups.map((group) => [group.extensionId, group]));
    sources = sources.map((source) => {
      if (source.kind !== 'plugin') return source;
      const group = byId.get(source.id);
      if (!group) return source;
      const status: SourceStatus = group.status === 'loaded' ? 'loaded' : group.status === 'empty' ? 'empty' : group.status === 'failed' ? 'failed' : 'loading';
      return {
        ...source,
        status,
        links: (group.links ?? []).map(pluginLinkToLink),
        errorCode: group.errorCode,
        errorMessage: group.errorMessage,
      };
    });
  }

  /** Per-source retry — ONLY the failing source is re-resolved. */
  async function retrySource(source: UnifiedSource): Promise<void> {
    if (source.status === 'loading' || source.status === 'retrying') return;
    if (source.kind === 'addon') {
      source.status = 'retrying';
      await resolveAddonSource(source);
      return;
    }
    retryAborts.get(source.id)?.abort();
    const abort = new AbortController();
    retryAborts.set(source.id, abort);
    sources = sources.map((candidate) =>
      candidate.id === source.id
        ? { ...candidate, status: 'loading' as const, links: [], errorCode: undefined, errorMessage: undefined }
        : candidate,
    );
    const params = buildParams();
    params.set('extensionId', source.id);
    try {
      const { response, timedOut } = await fetchWithTimeout(
        `/api/downloader/mavero2/extension?${params.toString()}`,
        abort.signal,
        RESOLVE_FETCH_TIMEOUT_MS,
      );
      if (abort.signal.aborted) return;
      if (timedOut) {
        markPluginSourceFailed(source.id, 'PROVIDER_TIMEOUT');
        return;
      }
      const raw: unknown = await response.json().catch(() => null);
      const parsed = parseCloudStreamExtensionPayload(raw);
      if (parsed.kind === 'error') {
        markPluginSourceFailed(source.id, parsed.code, parsed.message);
        return;
      }
      applyPluginGroups([parsed.value.group]);
    } catch (error) {
      if (abort.signal.aborted) return;
      markPluginSourceFailed(source.id, 'NETWORK_ERROR');
      console.warn('[MaveroDownloader] plugin retry failed', source.id, error);
    } finally {
      retryAborts.delete(source.id);
    }
  }

  function markPluginSourceFailed(id: string, code: CloudStreamDownloaderErrorCode, message?: string): void {
    sources = sources.map((source) =>
      source.id === id
        ? { ...source, status: 'failed' as const, errorCode: code, errorMessage: message, links: [] }
        : source,
    );
  }

  async function load(): Promise<void> {
    await loadSources();
    if (sourcesAbort?.signal.aborted) return;
    // Fire BOTH resolution engines in parallel — the add-on per-source
    // fetches and the ONE plugin batch. Partial success per source.
    for (const source of sources) {
      if (source.kind === 'addon') void resolveAddonSource(source);
    }
    if (sources.some((source) => source.kind === 'plugin')) {
      void resolvePluginBatch();
    }
  }

  /** Full retry — sources + both engines (manual only; never automatic). */
  function retryAll(): void {
    if (sourcesLoading) return;
    void load();
  }

  // ----- Share (the existing behavior — verbatim semantics) -----
  async function handleShare(link: UnifiedLinkView, sourceName: string, key: string): Promise<void> {
    if (shareKey === key && shareState === 'sharing') return;
    const url = link.url; // the EXACT ORIGINAL URI (HTTP/HTTPS/magnet/P2P)
    if (!url) return;
    shareKey = key;
    shareState = 'sharing';
    if (shareTimer) clearTimeout(shareTimer);
    try {
      if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
        // Non-http(s) URIs (magnet:) go through the text field — the same
        // Phase 20 fix as the existing panels.
        const isHttpUrl = url.startsWith('http://') || url.startsWith('https://');
        const shareData: { title: string; url?: string; text?: string } = { title: shareTitleFor(link, sourceName) };
        if (isHttpUrl) {
          shareData.url = url;
        } else {
          shareData.text = url;
        }
        await navigator.share(shareData);
        shareState = 'shared';
      } else if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        await navigator.clipboard.writeText(url);
        shareState = 'shared';
      } else {
        const copied = legacyCopy(url);
        shareState = copied ? 'shared' : 'failed';
      }
    } catch (error) {
      if (error instanceof DOMException && (error.name === 'AbortError' || error.name === 'NotAllowedError')) {
        shareState = '';
      } else {
        shareState = 'failed';
      }
    } finally {
      if (shareState === 'shared' || shareState === 'failed') {
        shareTimer = setTimeout(() => { shareKey = ''; shareState = ''; }, 2000);
      } else if (shareState === '') {
        shareKey = '';
      }
    }
  }

  function legacyCopy(url: string): boolean {
    if (typeof document === 'undefined') return false;
    try {
      const textarea = document.createElement('textarea');
      textarea.value = url;
      textarea.setAttribute('readonly', '');
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      const copied = document.execCommand('copy');
      textarea.remove();
      return copied;
    } catch {
      return false;
    }
  }

  // ----- Capability-aware action helpers (the SINGLE shared model) -----
  function downloadAttr(link: UnifiedLinkView) {
    return downloadActionFor(link as unknown as CapabilityStream);
  }
  function playAttr(link: UnifiedLinkView) {
    return playActionFor(link as unknown as CapabilityStream, { android: typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent) });
  }

  onMount(load);

  onDestroy(() => {
    // Cancel every in-flight request so no response ever applies to a
    // destroyed panel (provider switching unmounts the unified panel).
    sourcesAbort?.abort();
    batchAbort?.abort();
    for (const source of sources) source.abort?.abort();
    for (const abort of retryAborts.values()) abort.abort();
    retryAborts.clear();
    if (shareTimer) clearTimeout(shareTimer);
  });
</script>

<div class="mud" aria-busy={sourcesLoading}>
  <!-- Compact instruction block (the Phase 18 surface language — NO
       redundant heading; the parent DownloadSheet shows the title). -->
  <div class="mud-instructions">
    <p>Add-on and plugin sources — use Download, Play or Share on any link.</p>
    <div class="mud-instructions-side">
      {#if episodeContext}
        <span class="mud-context" title={episodeContext}>{episodeContext}</span>
      {/if}
      <button type="button" class="mud-info-btn" onclick={openInfoSheet} aria-label="More information" title="More information">
        <HelpCircle size={14} />
      </button>
    </div>
  </div>

  {#if sourcesLoading}
    <div class="mud-state" role="status">
      <span class="mud-spin"><Loader2 size={16} /></span>
      <span>Finding sources…</span>
    </div>
    <div class="mud-skeleton-list" aria-hidden="true">
      {#each Array(3) as _}
        <div class="mud-skeleton-card">
          <div class="mud-skeleton-kind"></div>
          <div class="mud-skeleton-content">
            <div class="mud-skeleton-line mud-skeleton-line-wide"></div>
            <div class="mud-skeleton-badges">
              <div class="mud-skeleton-badge"></div>
              <div class="mud-skeleton-badge"></div>
              <div class="mud-skeleton-badge"></div>
            </div>
          </div>
          <div class="mud-skeleton-action"></div>
        </div>
      {/each}
    </div>
  {:else if sourcesFailed}
    <div class="mud-state mud-state-error" role="status">
      <AlertTriangle size={16} />
      <span>Couldn't load sources.</span>
      <button type="button" class="mud-retry" onclick={retryAll}><RotateCw size={11} /> Retry</button>
    </div>
  {:else if sources.length === 0}
    <div class="mud-state" role="status"><Info size={16} /><span>No sources are enabled.</span></div>
    {#if addonCatalogFailed}
      <p class="mud-hint">Stremio add-ons are temporarily unavailable.</p>
    {/if}
    {#if extensionCatalogFailed}
      <p class="mud-hint">CloudStream/Nuvio sources are temporarily unavailable.</p>
    {/if}
  {:else}
    <!-- THE unified source chip rail — green = Stremio add-on, blue =
         CloudStream/Nuvio plugin (task PART C). Order = the global
         positions from the /sources payload (persisted ordering data,
         never array identity). Counts: add-on sources show their full
         stream count; plugin sources show non-external links (the
         existing panels' per-kind counting rules). -->
    <div class="mud-tabs" role="tablist" aria-label="Sources">
      {#each sources as source (source.id)}
        <button
          class="mud-tab"
          class:plugin={source.kind === 'plugin'}
          class:active={source.id === activeSourceId}
          type="button"
          role="tab"
          aria-selected={source.id === activeSourceId}
          onclick={() => selectSource(source.id)}
        >
          <span class="mud-tab-kind" aria-hidden="true" title={source.kind === 'plugin' ? 'CloudStream/Nuvio plugin' : 'Stremio add-on'}></span>
          <span class="mud-tab-name">{source.name}</span>
          {#if source.status === 'loading' || source.status === 'retrying'}
            <span class="mud-tab-state loading" role="status"><span class="mud-tab-spin"><Loader2 size={9} /></span></span>
          {:else if source.status === 'unavailable' || source.status === 'failed'}
            <span class="mud-tab-state failed" role="status">Failed</span>
          {:else if (source.status === 'loaded' || source.status === 'empty') && source.links.length > 0}
            <span class="mud-tab-state ok" class:plugin={source.kind === 'plugin'} role="status">{source.kind === 'plugin' ? source.links.filter((link) => link.kind !== 'external').length : source.links.length}</span>
          {:else}
            <span class="mud-tab-state" role="status">0</span>
          {/if}
        </button>
      {/each}
    </div>

    <!-- Per-kind catalog degradation notices (honest partial success). -->
    {#if addonCatalogFailed && sources.every((source) => source.kind !== 'addon')}
      <div class="mud-state mud-state-error" role="status">
        <AlertTriangle size={14} />
        <span>Stremio add-ons are unavailable right now.</span>
        <button type="button" class="mud-retry" onclick={retryAll}><RotateCw size={11} /> Retry</button>
      </div>
    {/if}
    {#if extensionCatalogFailed && sources.every((source) => source.kind !== 'plugin')}
      <div class="mud-state mud-state-error" role="status">
        <AlertTriangle size={14} />
        <span>CloudStream sources are unavailable right now.</span>
        <button type="button" class="mud-retry" onclick={retryAll}><RotateCw size={11} /> Retry</button>
      </div>
    {/if}

    <!-- Compact filter bar — "X links + Filters" (both kinds). -->
    {#if activeSource && activeLinks.length > 0}
      <div class="mud-filter-bar">
        <span class="mud-filter-count">
          {#if filteredLinks.length === activeLinks.length}
            {activeLinks.length} links
          {:else}
            {filteredLinks.length} of {activeLinks.length}
          {/if}
        </span>
        <button type="button" class="mud-filter-trigger" onclick={openFilterSheet} aria-label="Open filters" title="Open filters">
          <SlidersHorizontal size={13} />
          <span>Filters</span>
        </button>
      </div>
    {/if}

    <!-- Active filter chips + Clear (removable per dimension). -->
    {#if anyFiltersActive}
      <div class="mud-active-filters" role="status" aria-label="Active filters">
        {#each activeChips as chip (chip.dimension)}
          <button
            class="mud-active-chip"
            type="button"
            aria-label={`Remove ${chip.label} filter`}
            title={`Remove ${chip.label} filter`}
            onclick={() => removeFilter(chip.dimension)}
          >
            <span class="mud-active-chip-label">{chip.label}</span>
            <X size={10} aria-hidden="true" />
          </button>
        {/each}
        <button
          class="mud-clear"
          type="button"
          aria-label="Clear all filters"
          title="Clear all filters"
          onclick={clearAllFilters}
        >
          Clear
        </button>
      </div>
    {/if}

    {#if activeSource}
      {#if activeSource.status === 'loading' || activeSource.status === 'retrying'}
        <div class="mud-state" role="status">
          <span class="mud-spin"><Loader2 size={16} /></span>
          <span>{activeSource.status === 'retrying' ? 'Trying again…' : `Finding links from ${activeSource.name}…`}</span>
        </div>
        <div class="mud-skeleton-list" aria-hidden="true">
          {#each Array(3) as _}
            <div class="mud-skeleton-card">
              <div class="mud-skeleton-kind"></div>
              <div class="mud-skeleton-content">
                <div class="mud-skeleton-line mud-skeleton-line-wide"></div>
                <div class="mud-skeleton-badges">
                  <div class="mud-skeleton-badge"></div>
                  <div class="mud-skeleton-badge"></div>
                  <div class="mud-skeleton-badge"></div>
                </div>
              </div>
              <div class="mud-skeleton-action"></div>
            </div>
          {/each}
        </div>
      {:else if activeSource.status === 'unavailable' || activeSource.status === 'failed'}
        <!-- Partial failure: ONLY this source failed — the others keep
             their results. User-readable message + per-source retry. -->
        <div class="mud-state mud-state-error" role="status">
          <AlertTriangle size={14} />
          <span>{activeSourceErrorMessage(activeSource)}</span>
          <button type="button" class="mud-retry" onclick={() => void retrySource(activeSource)}><RotateCw size={11} /> Retry</button>
        </div>
      {:else if activeLinks.length === 0}
        <div class="mud-state" role="status">
          <Info size={14} />
          <span>No downloadable sources found for {activeSource.name}.</span>
          <button type="button" class="mud-retry" onclick={() => void retrySource(activeSource)}><RotateCw size={11} /> Retry</button>
        </div>
      {:else if filteredLinks.length === 0}
        <!-- Filtered empty — distinct from a source failure. -->
        <div class="mud-state mud-state-filtered-empty" role="status">
          <SearchX size={14} aria-hidden="true" />
          <span>No sources match your filters.</span>
          {#if anyFiltersActive}
            <button type="button" class="mud-retry" onclick={clearAllFilters}><RotateCw size={11} /> Clear filters</button>
          {/if}
        </div>
      {:else}
        <div class="mud-list" role="list" aria-label={`${activeSource.name} links`}>
          {#each visibleLinks as link, index (link.url + '-' + index)}
            {@const key = `${activeSource.id}-${index}`}
            {@const KindIcon = kindIcon(link.kind)}
            {@const dlAction = downloadAttr(link)}
            {@const plAction = playAttr(link)}
            <article class="mud-row" role="listitem" aria-label={`${linkDetail(link) ?? kindLabel(link.kind)} · ${transportLabel(link.kind)}`}>
              <div class="mud-row-main">
                <div class="mud-row-header">
                  <span class="mud-kind" class:plugin={activeIsPlugin} title={kindLabel(link.kind)} aria-hidden="true">
                    <KindIcon size={13} />
                  </span>
                  {#if linkDetail(link)}
                    <span class="mud-row-detail">{linkDetail(link)}</span>
                  {:else}
                    <span class="mud-row-detail mud-row-detail-fallback">{kindLabel(link.kind)} · {link.quality === 'auto' ? 'Auto' : link.quality}</span>
                  {/if}
                  <span class="mud-transport" title={transportLabel(link.kind)}>{transportLabel(link.kind)}</span>
                </div>
                <div class="mud-row-badges">
                  <span class={qualityBadgeClass(link.quality)}>{link.quality === 'auto' ? 'Auto' : link.quality}</span>
                  {#if link.codec && link.codec !== 'unknown'}<span class="mud-badge mud-badge-codec">{link.codec}</span>{/if}
                  {#if link.container}<span class="mud-badge mud-badge-container">{link.container}</span>{/if}
                  {#if audioLabel(link)}
                    <span class="mud-badge mud-badge-audio" title={link.audioLanguages?.length ? `Audio: ${link.audioLanguages.join(', ')}` : 'Audio'}>
                      <Volume2 size={10} aria-hidden="true" />
                      <span>{audioLabel(link)}</span>
                    </span>
                  {/if}
                  {#if formatSize(link.sizeBytes)}
                    <span class="mud-badge mud-badge-size" title="File size">
                      <HardDrive size={10} aria-hidden="true" />
                      <span>{formatSize(link.sizeBytes)}</span>
                    </span>
                  {/if}
                  {#if link.host}
                    <span class="mud-badge mud-badge-host" title={`Hosting server: ${link.host}`}>
                      <Server size={10} aria-hidden="true" />
                      <span>{link.host}</span>
                    </span>
                  {/if}
                  {#if link.subtitles?.length}
                    <span class="mud-badge mud-badge-subtitles" title={`Subtitles: ${link.subtitles.length} track${link.subtitles.length === 1 ? '' : 's'}${link.subtitles.some((track) => track.language) ? ` (${link.subtitles.map((track) => track.language).filter(Boolean).join(', ')})` : ''}`}>
                      <Captions size={10} aria-hidden="true" />
                      <span>{link.subtitles.length}</span>
                    </span>
                  {/if}
                </div>
              </div>
              <div class="mud-row-actions">
                {#if dlAction}
                  {#if isPixeldrainUrl(link.url)}
                    <!-- Pixeldrain: Info button instead of Download (Referer
                         hotlink protection — the existing panels' rule). -->
                    <button
                      class="mud-action mud-action-info"
                      type="button"
                      aria-label="Download info"
                      title="Download can be done via external downloader only for this link."
                      onclick={(event) => { event.stopPropagation(); pixeldrainInfoKey = pixeldrainInfoKey === key ? '' : key; }}
                    >
                      <Info size={13} />
                    </button>
                  {:else if dlAction.flow === 'direct-download'}
                    <a
                      class="mud-action mud-action-download"
                      href={dlAction.href}
                      download={dlAction.download}
                      target={dlAction.target}
                      rel={dlAction.rel}
                      aria-label="Download original file"
                      title="Download (original URL)"
                      onclick={(event) => event.stopPropagation()}
                    >
                      <Download size={13} />
                    </a>
                  {:else if dlAction.flow === 'external-open'}
                    <a
                      class="mud-action mud-action-download"
                      href={dlAction.href}
                      aria-label="Open in torrent app"
                      title="Open in torrent app (original magnet URI)"
                      onclick={(event) => event.stopPropagation()}
                    >
                      <Download size={13} />
                    </a>
                  {:else if dlAction.flow === 'embedded-sheet'}
                    {#if onOpenInSheet}
                      <button
                        class="mud-action mud-action-download"
                        type="button"
                        aria-label="Open download page"
                        title="Open download page (embedded sheet)"
                        onclick={(event) => { event.stopPropagation(); onOpenInSheet(dlAction.href); }}
                      >
                        <Download size={13} />
                      </button>
                    {:else}
                      <a
                        class="mud-action mud-action-download"
                        href={dlAction.href}
                        target="_blank"
                        rel="noopener noreferrer"
                        aria-label="Open download page"
                        title="Open download page (external)"
                        onclick={(event) => event.stopPropagation()}
                      >
                        <Download size={13} />
                      </a>
                    {/if}
                  {/if}
                {/if}
                {#if plAction}
                  <a
                    class="mud-action mud-action-play"
                    href={plAction.href}
                    aria-label="Play in external player"
                    title="Play in external player"
                    onclick={(event) => event.stopPropagation()}
                  >
                    <Play size={13} />
                  </a>
                {/if}
                <button
                  class="mud-action mud-action-share"
                  class:done={shareKey === key && shareState === 'shared'}
                  class:failed={shareKey === key && shareState === 'failed'}
                  type="button"
                  aria-label={shareKey === key && shareState === 'shared' ? 'URI shared' : shareKey === key && shareState === 'failed' ? 'Share failed' : 'Share original URI'}
                  title="Share (original URI)"
                  onclick={(event) => { event.stopPropagation(); void handleShare(link, activeSource.name, key); }}
                >
                  {#if shareKey === key && shareState === 'sharing'}<Loader2 size={13} class="mud-spin" />
                  {:else if shareKey === key && shareState === 'shared'}<Check size={13} />
                  {:else if shareKey === key && shareState === 'failed'}<AlertTriangle size={13} />
                  {:else}<Share2 size={13} />{/if}
                </button>
              </div>
              {#if isPixeldrainUrl(link.url) && pixeldrainInfoKey === key}
                <div class="mud-pixeldrain-info" role="status">
                  Download can be done via external downloader only for this link.
                </div>
              {/if}
            </article>
          {/each}
        </div>
        {#if remainingLinks.length > 0}
          <div class="mud-show-more">
            <span class="mud-showing-count">Showing {visibleLinks.length} of {filteredLinks.length}</span>
            <button type="button" class="mud-show-more-btn" onclick={handleShowMore} aria-label="Show more links">
              Show more ({remainingLinks.length} remaining)
            </button>
          </div>
        {/if}
      {/if}
    {/if}
  {/if}
</div>

<!-- Info sheet — recommended apps (the existing Phase E V2 surface). -->
<SelectionSheet
  open={infoSheetOpen}
  eyebrow="MAVERO / Info"
  title="Recommended Apps"
  options={[
    { key: '1dm', label: '1DM+ Downloader', description: 'Download manager', image: '/icons/1DM.png' },
    { key: 'mpv', label: 'MPV Player', description: 'Video player', image: '/icons/MPV.png' },
  ]}
  selected=""
  onClose={closeInfoSheet}
  onSelect={(key) => {
    const urls: Record<string, string> = {
      '1dm': 'https://play.google.com/store/apps/details?id=idm.internet.download.manager',
      'mpv': 'https://play.google.com/store/apps/details?id=is.xyz.mpv',
    };
    const url = urls[key];
    if (url && typeof window !== 'undefined') window.open(url, '_blank', 'noopener,noreferrer');
    infoSheetOpen = false;
  }}
/>

<!-- Grouped multi-dimensional Filter Sheet. The sections derive per active
     source kind: the add-on model (TYPE/QUALITY/AUDIO/SIZE) or the plugin
     model (QUALITY/CODEC/CONTAINER/AUDIO/SIZE) — the EXISTING rules. -->
<DownloaderFilterSheet
  open={filterSheetOpen}
  sections={activeIsAddon ? [
    { dimension: 'type', heading: 'TYPE', options: currentTypeOptions, visible: showTypeFilter },
    { dimension: 'quality', heading: 'QUALITY', options: currentAddonQualityOptions, visible: true },
    { dimension: 'language', heading: 'AUDIO', options: currentAddonLanguageOptions, visible: true },
    { dimension: 'size', heading: 'SIZE', options: currentAddonSizeOptions, visible: true },
  ] : [
    { dimension: 'quality', heading: 'QUALITY', options: currentQualityOptions, visible: showQualityFilter },
    { dimension: 'codec', heading: 'CODEC', options: currentCodecOptions, visible: showCodecFilter },
    { dimension: 'container', heading: 'CONTAINER', options: currentContainerOptions, visible: showContainerFilter },
    { dimension: 'language', heading: 'AUDIO', options: currentLanguageOptions, visible: showLanguageFilter },
    { dimension: 'size', heading: 'SIZE', options: currentSizeOptions, visible: showSizeFilter },
  ]}
  selected={activeIsAddon ? { type: addonFilters.type, quality: addonFilters.quality, language: addonFilters.language, size: addonFilters.size } : { quality: pluginFilters.quality, codec: pluginFilters.codec, container: pluginFilters.container, language: pluginFilters.language, size: pluginFilters.size }}
  onApply={(applied) => {
    if (activeIsAddon) {
      addonFilters = {
        type: (applied.type as DownloaderFilters['type']) || 'all',
        quality: applied.quality || 'all',
        language: (applied.language as DownloaderFilters['language']) || 'all',
        size: (applied.size as DownloaderFilters['size']) || 'all',
      };
    } else if (activeIsPlugin) {
      pluginFilters = {
        quality: (applied.quality as CloudStreamFilters['quality']) || 'all',
        codec: (applied.codec as CloudStreamFilters['codec']) || 'all',
        container: (applied.container as CloudStreamFilters['container']) || 'all',
        language: (applied.language as CloudStreamFilters['language']) || 'all',
        size: (applied.size as CloudStreamFilters['size']) || 'all',
      };
    }
    closeFilterSheet();
  }}
  onClose={closeFilterSheet}
/>

<style>
  /* Mavero Unified Downloader — the same visual language as the existing
     Stremio (mad-*) and CloudStream (mcd-*) panels: dark surfaces, pill
     chips, structured badges, accent treatments. The ONE deliberate
     distinction (task PART C): add-on chips keep the GREEN primary accent
     (--accent); plugin chips use the BLUE secondary accent (--accent-2).
     Both accents are existing design-system tokens — no new palette. */
  .mud {
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-height: 220px;
    font-family: inherit;
    color: var(--ink);
  }

  /* Instructions — compact info banner (the existing surface language). */
  .mud-instructions { display: flex; flex-direction: row; align-items: center; justify-content: space-between; gap: 8px; padding: 6px 10px; border: 1px solid var(--line); border-left: 2px solid var(--accent); border-radius: var(--radius-sm); background: var(--color-surface); }
  .mud-instructions p { margin: 0; font-size: 0.6rem; color: var(--ink-soft); font-weight: 600; }
  .mud-instructions-side { display: inline-flex; align-items: center; gap: 6px; flex: 0 0 auto; }
  .mud-info-btn { display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 24px; border: 1px solid var(--line); border-radius: 999px; background: transparent; color: var(--ink-soft); cursor: pointer; flex: 0 0 auto; }
  .mud-info-btn:hover, .mud-info-btn:focus-visible { border-color: var(--accent); color: var(--accent); outline: none; }

  /* States */
  .mud-state { display: flex; flex-direction: row; align-items: center; justify-content: flex-start; flex-wrap: wrap; gap: 6px; padding: 8px 10px; border: 1px solid var(--line); border-radius: var(--radius-sm); background: var(--color-surface); color: var(--ink-soft); font-size: 0.62rem; font-weight: 600; }
  .mud-state-error { border-color: rgba(255, 77, 109, 0.35); color: var(--ink); }
  .mud-state-filtered-empty { color: var(--ink-soft); }
  .mud-hint { margin: 0; padding: 0 10px; font-size: 0.58rem; color: var(--ink-soft); font-weight: 600; }
  .mud-retry { display: inline-flex; align-items: center; gap: 4px; border: 1px solid var(--line-strong); border-radius: 999px; background: var(--accent-soft); color: var(--ink); padding: 5px 12px; font: inherit; font-size: 0.62rem; font-weight: 700; cursor: pointer; transition: border-color var(--motion-fast) var(--ease-out); }
  .mud-retry:hover { border-color: var(--accent); color: var(--accent); }
  .mud-spin { display: inline-flex; animation: mud-spin 0.9s linear infinite; }

  /* ===== THE unified chip rail (task PART C) ===== */
  .mud-tabs { display: flex; flex-direction: row; flex-wrap: nowrap; overflow-x: auto; gap: 6px; padding: 2px; scrollbar-width: none; -ms-overflow-style: none; scroll-snap-type: x proximity; }
  .mud-tabs::-webkit-scrollbar { display: none; }
  .mud-tab { display: flex; flex: 0 0 auto; align-items: center; gap: 5px; border: 1px solid var(--line); border-radius: 999px; background: var(--color-surface-elevated); color: var(--ink-soft); padding: 5px 10px; font: inherit; font-size: 0.62rem; font-weight: 700; cursor: pointer; transition: border-color var(--motion-fast) var(--ease-out), background var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out); }
  .mud-tab:hover { border-color: var(--line-strong); color: var(--ink); background: var(--color-surface-raised); }
  .mud-tab:focus-visible { outline: none; border-color: var(--accent); box-shadow: 0 0 0 2px var(--accent-soft); }
  /* GREEN = Stremio Add-on (the existing .mad-tab.active treatment). */
  .mud-tab.active { border-color: var(--accent); color: var(--ink); background: var(--accent-soft); }
  /* BLUE = CloudStream/Nuvio plugin — the secondary accent, structurally
     identical treatment. Checked AFTER .active so the plugin accent wins
     whenever the chip is a plugin (both hover and active states). */
  .mud-tab.plugin { border-color: var(--color-secondary-soft); }
  .mud-tab.plugin:hover { border-color: var(--accent-2); color: var(--ink); }
  .mud-tab.plugin:focus-visible { outline: none; border-color: var(--accent-2); box-shadow: 0 0 0 2px var(--accent-2-soft); }
  .mud-tab.plugin.active { border-color: var(--accent-2); color: var(--ink); background: var(--accent-2-soft); }
  /* The kind dot: a 6px accent marker inside every chip — green for
     add-ons, blue for plugins. Color reinforces the rail at a glance
     without changing chip structure. */
  .mud-tab-kind { width: 6px; height: 6px; border-radius: 999px; background: var(--accent); flex: 0 0 auto; }
  .mud-tab.plugin .mud-tab-kind { background: var(--accent-2); }
  .mud-tab-name { max-width: 120px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .mud-tab-state { min-width: 16px; border-radius: 999px; background: var(--color-border-strong); color: var(--muted); padding: 1px 5px; font-size: 0.52rem; font-weight: 700; text-align: center; display: inline-flex; align-items: center; justify-content: center; }
  .mud-tab-state.ok { color: var(--accent); }
  .mud-tab-state.ok.plugin { color: var(--accent-2); }
  .mud-tab-state.failed { color: var(--color-warning); }
  .mud-tab-state.loading { background: transparent; padding: 1px 2px; }
  .mud-tab-spin { display: grid; place-items: center; animation: mud-spin 0.9s linear infinite; }

  /* Filter bar + chips */
  .mud-filter-bar { display: flex; align-items: center; gap: 8px; padding: 4px 8px; }
  .mud-filter-count { font-size: 0.6rem; font-weight: 700; color: var(--ink-soft); }
  .mud-context { flex: 0 0 auto; border: 1px solid var(--color-secondary-soft); border-radius: 4px; background: var(--color-secondary-soft); color: var(--accent-2); padding: 1px 6px; font-size: 0.52rem; font-weight: 700; white-space: nowrap; }
  .mud-filter-trigger { display: inline-flex; align-items: center; gap: 4px; border: 1px solid var(--line); border-radius: 999px; background: transparent; color: var(--ink-soft); padding: 4px 10px; font: inherit; font-size: 0.58rem; font-weight: 700; cursor: pointer; margin-left: auto; transition: border-color var(--motion-fast) var(--ease-out); }
  .mud-filter-trigger:hover, .mud-filter-trigger:focus-visible { border-color: var(--accent); color: var(--accent); outline: none; }
  .mud-active-filters { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; padding: 4px 6px; border-radius: var(--radius-sm); background: var(--accent-soft); }
  .mud-active-chip { display: inline-flex; align-items: center; gap: 3px; border: 1px solid var(--accent); border-radius: 999px; background: var(--color-surface-elevated); color: var(--ink); padding: 3px 7px; font: inherit; font-size: 0.52rem; font-weight: 700; cursor: pointer; white-space: nowrap; transition: background var(--motion-fast) var(--ease-out); }
  .mud-active-chip:hover { border-color: var(--accent); background: var(--accent); color: var(--color-bg); }
  .mud-active-chip:focus-visible { outline: none; border-color: var(--accent); box-shadow: 0 0 0 2px var(--accent-soft); }
  .mud-active-chip-label { max-width: 100px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .mud-clear { border: 0; background: transparent; color: var(--muted); font: inherit; font-size: 0.52rem; font-weight: 800; cursor: pointer; padding: 2px 4px; }
  .mud-clear:hover { border-color: var(--accent); color: var(--accent); }
  .mud-clear:focus-visible { outline: none; border-color: var(--accent); box-shadow: 0 0 0 2px var(--accent-soft); }

  /* Link cards (the shared structural language of mad-row / mcd-row). */
  .mud-list { display: flex; flex-direction: column; gap: 5px; }
  .mud-row { display: flex; flex-direction: column; gap: 5px; padding: 9px 10px; border: 1px solid var(--line); border-radius: var(--radius-sm); background: var(--color-surface-elevated); }
  .mud-row:hover { border-color: var(--line-strong); }
  .mud-row:focus-within { border-color: var(--accent); box-shadow: var(--glow-primary); }
  .mud-row:focus-within.plugin-card { border-color: var(--accent-2); box-shadow: var(--glow-secondary); }
  .mud-row-main { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
  .mud-row-header { display: flex; flex-direction: row; align-items: center; gap: 6px; min-width: 0; }
  .mud-kind { display: inline-flex; align-items: center; justify-content: center; width: 26px; height: 26px; border-radius: 6px; background: var(--accent-soft); color: var(--accent); flex: 0 0 auto; }
  .mud-kind.plugin { background: var(--accent-2-soft); color: var(--accent-2); }
  .mud-row-detail { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 0.62rem; font-weight: 600; color: var(--ink); }
  .mud-row-detail-fallback { color: var(--ink-soft); font-weight: 500; }
  .mud-transport { display: inline-flex; align-items: center; border: 1px solid var(--color-secondary-soft); border-radius: 4px; background: var(--color-secondary-soft); color: var(--accent-2); padding: 1px 5px; font-size: 0.48rem; font-weight: 700; white-space: nowrap; flex: 0 0 auto; }
  .mud-row-badges { display: flex; flex-direction: row; flex-wrap: wrap; align-items: center; gap: 3px; min-width: 0; }
  .mud-badge { display: inline-flex; align-items: center; gap: 3px; border: 1px solid var(--line); border-radius: 4px; background: var(--color-surface-raised); color: var(--ink-soft); padding: 1px 5px; font-size: 0.48rem; font-weight: 700; white-space: nowrap; max-width: 150px; overflow: hidden; text-overflow: ellipsis; }
  .mud-badge-quality { border-color: var(--accent-border); background: var(--accent-soft); color: var(--ink); }
  .mud-badge-4k { color: var(--accent); }
  .mud-badge-1080 { color: var(--ink); }
  .mud-badge-codec, .mud-badge-container { text-transform: uppercase; }
  .mud-badge-audio, .mud-badge-size { color: var(--muted); }
  .mud-badge-host { color: var(--accent-2); max-width: 140px; overflow: hidden; text-overflow: ellipsis; border-color: var(--color-secondary-soft); }
  .mud-badge-subtitles { color: var(--muted); }
  .mud-row-actions { display: flex; flex-direction: row; align-items: center; justify-content: flex-end; gap: 5px; }
  .mud-action { display: inline-flex; align-items: center; justify-content: center; width: 32px; height: 32px; border: 1px solid var(--line); border-radius: 999px; background: transparent; color: var(--ink-soft); cursor: pointer; transition: border-color var(--motion-fast) var(--ease-out), background var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out); }
  .mud-action:hover, .mud-action:focus-visible { border-color: var(--line-strong); background: var(--accent-soft); color: var(--ink); }
  .mud-action.done { border-color: var(--accent); color: var(--accent); }
  .mud-action.failed { border-color: var(--color-danger); color: var(--color-danger); }
  .mud-action:focus-visible { outline: none; }
  .mud-action-share { color: var(--accent); }
  .mud-action-play { color: var(--accent-2); }
  .mud-pixeldrain-info { padding: 5px 8px; border: 1px solid var(--line); border-radius: var(--radius-sm); background: var(--color-surface); color: var(--ink-soft); font-size: 0.55rem; font-weight: 600; }

  /* Show More */
  .mud-show-more { display: flex; flex-direction: row; align-items: center; justify-content: space-between; gap: 8px; padding: 6px 8px; }
  .mud-showing-count { font-size: 0.55rem; color: var(--muted-deep); font-weight: 600; }
  .mud-show-more-btn { border: 1px solid var(--line); border-radius: 999px; background: transparent; color: var(--ink-soft); padding: 5px 12px; font: inherit; font-size: 0.58rem; font-weight: 700; cursor: pointer; }
  .mud-show-more-btn:hover, .mud-show-more-btn:focus-visible { border-color: var(--accent); color: var(--accent); outline: none; }

  /* Skeletons */
  .mud-skeleton-list { display: flex; flex-direction: column; gap: 5px; }
  .mud-skeleton-card { display: flex; flex-direction: row; align-items: center; gap: 8px; padding: 9px 10px; border: 1px solid var(--line); border-radius: var(--radius-sm); background: var(--color-surface-elevated); }
  .mud-skeleton-kind { width: 26px; height: 26px; border-radius: 6px; background: var(--color-surface-raised); flex: 0 0 auto; animation: mud-pulse 1.4s ease infinite; }
  .mud-skeleton-content { display: flex; flex-direction: column; gap: 5px; flex: 1 1 auto; min-width: 0; }
  .mud-skeleton-line { height: 9px; width: 60%; border-radius: 4px; background: var(--color-surface-raised); animation: mud-pulse 1.4s ease infinite; }
  .mud-skeleton-line-wide { width: 85%; }
  .mud-skeleton-badges { display: flex; flex-direction: row; gap: 4px; }
  .mud-skeleton-badge { height: 12px; width: 44px; border-radius: 4px; background: var(--color-surface-raised); animation: mud-pulse 1.4s ease infinite; }
  .mud-skeleton-action { width: 32px; height: 32px; border-radius: 999px; background: var(--color-surface-raised); flex: 0 0 auto; animation: mud-pulse 1.4s ease infinite; }

  @keyframes mud-spin { to { transform: rotate(360deg); } }
  @keyframes mud-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.55; } }
  @keyframes mud-fade { from { opacity: 0; transform: translateY(-2px); } to { opacity: 1; transform: none; } }

  @media (prefers-reduced-motion: reduce) {
    .mud-spin, .mud-tab-spin { animation: none; }
    .mud-action, .mud-row, .mud-tab { transition: none; }
    .mud-skeleton-kind, .mud-skeleton-line, .mud-skeleton-badge, .mud-skeleton-action { animation: none; opacity: 0.5; }
  }

  /* Responsive breakpoints (the existing panels' rules). */
  @media (max-width: 360px) {
    .mud-badge-host { display: none; }
    .mud-action { width: 30px; height: 30px; }
    .mud-instructions p { font-size: 0.52rem; }
  }
  @media (min-width: 700px) {
    .mud { gap: 10px; }
    .mud-tab { padding: 6px 12px; font-size: 0.66rem; }
    .mud-row { padding: 10px 12px; gap: 10px; }
    .mud-kind { width: 28px; height: 28px; }
    .mud-row-detail { font-size: 0.66rem; }
    .mud-badge { font-size: 0.56rem; padding: 3px 7px; }
    .mud-action { width: 34px; height: 34px; }
    .mud-list { gap: 6px; }
  }
  @media (min-width: 1024px) {
    .mud { min-height: 320px; }
    .mud-row:hover { box-shadow: var(--shadow-sm); }
  }
</style>
