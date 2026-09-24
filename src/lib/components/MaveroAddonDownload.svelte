<script lang="ts">
  import { onMount } from 'svelte';
  import { AlertTriangle, Info, Loader2, RotateCw, Share2, Check, FileVideo, Radio, Magnet, Users, Volume2, HardDrive, Server, Captions, X, SearchX, ChevronDown, Download, Play, SlidersHorizontal, HelpCircle } from 'lucide-svelte';
  import SelectionSheet from '$components/SelectionSheet.svelte';
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
    sizeFilterLabel,
    type DownloaderFilters,
    type FilterableStream,
    type SizeFilterValue,
  } from '$lib/shared/downloader-filters';
  import {
    streamCapabilities,
    downloadActionFor,
    playActionFor,
    type CapabilityStream,
  } from '$lib/shared/stream-actions';
  import { linkTypeLabel, linkTypeCategory, type DownloadLinkType } from '$lib/shared/download-link-types';
  import { selectPresentationWindow, showMoreBatch, type PresentableStream } from '$lib/shared/presentation-window';
  import type { AudioClass } from '$lib/shared/stream-selection';

  /**
   * MAVERO Downloader — Compact discovery surface (Phase 18).
   *
   * PHASE 18 CONTRACT (task §1-§17):
   *   * NO redundant heading — the parent DownloadSheet already shows the title.
   *   * Compact 2-line instruction block.
   *   * Suggested apps (1DM + MPV) in ONE compact horizontal row.
   *   * FOUR filters (Type/Size/Quality/Language) in ONE horizontally scrollable
   *     row, ABOVE the addon chips.
   *   * Addon chips (horizontally scrollable, non-external count).
   *   * Stream cards with ONLY a Share action (no Download button).
   *   * NO footer.
   *   * MAXIMIZED vertical space for stream links.
   *
   * EXTERNAL STREAMS (task §6):
   *   * kind === 'external' streams are HIDDEN from the UI (filtered server-side).
   *   * "External" is NOT a Type filter option.
   *   * The addon chip count reflects NON-EXTERNAL streams only.
   *
   * SHARE (task §7/§8):
   *   * navigator.share({ title, url }) with the EXACT ORIGINAL URI.
   *   * HTTP/HTTPS/HLS/DASH/magnet/P2P — all shared verbatim.
   *   * No Mavero URL, no proxy, no rewrite.
   */

  export let contentId = '';
  export let mediaType: 'movie' | 'series' | 'anime' = 'movie';
  export let tmdbId = '';
  export let season: number | undefined = undefined;
  export let episode: number | undefined = undefined;
  // svelte-ignore export_let_unused -- accepted by the parent DownloadSheet for API compatibility; the title is displayed in the parent sheet header, not duplicated here (Phase 18 task §1)
  export let title = '';
  // Phase D: callback to the parent DownloadSheet for the embedded-sheet flow.
  // When the Download action flow is 'embedded-sheet' (external/provider-page URL),
  // the component calls this callback with the URL. The DownloadSheet opens the
  // URL in its existing iframe overlay (with onload/onerror + external-open fallback).
  // If no callback is provided (standalone usage), falls back to an external-open anchor.
  export let onOpenInSheet: ((url: string) => void) | undefined = undefined;

  type StreamView = {
    url: string;
    kind: 'http' | 'https' | 'hls' | 'dash' | 'p2p' | 'magnet' | 'external';
    quality: string;
    codec: string;
    audio: AudioClass;
    audioLanguages?: string[];
    container?: string;
    filename?: string;
    title?: string;
    name?: string;
    description?: string;
    sizeBytes?: number;
    transport: 'http' | 'https' | 'magnet' | 'external';
    streamType?: string;
    availability?: number;
    tag?: string;
    /** Phase B (card UX §B2): server-derived hostname for hosting/server identity display. */
    host?: string;
    /** Phase B (§B2 subtitles): addon-supplied subtitle tracks (mirrored from the player normalizer). */
    subtitles?: { url: string; language?: string; label?: string }[];
    confidence: 'high' | 'medium' | 'low';
  };
  type TabStatus = 'loading' | 'retrying' | 'loaded' | 'empty' | 'unavailable';
  type Tab = {
    addonId: string;
    addonName: string;
    addonSlug: string;
    addonOrdering: number;
    status: TabStatus;
    streams: StreamView[];
    errorCode?: string;
    abort?: AbortController;
    attempts?: number;
  };

  let tabs: Tab[] = [];
  let tabsLoading = true;
  let tabsFailed = false;
  let activeTabId: string | null = null;

  // Share action state.
  let shareKey = '';
  let shareState: 'sharing' | 'shared' | 'failed' | '' = '';
  let shareTimer: ReturnType<typeof setTimeout> | undefined;

  // Phase C: filter state is a single object (DownloaderFilters). The four
  // dimensions (type/quality/size/language) default to 'all'. The filter
  // LOGIC lives in the shared pure helper `filterStreams` so the same rules
  // are used by the tests — the component never re-implements matching.
  let filters: DownloaderFilters = { ...NO_FILTERS };

  $: activeTab = tabs.find((tab) => tab.addonId === activeTabId) ?? null;
  $: activeStreams = activeTab?.streams ?? [];
  // Phase C: filters operate on the FULL active-tab stream collection (never
  // a pre-truncated subset). Changing a filter recomputes the view from the
  // already-resolved collection — NO addon refetch. filterStreams is generic
  // over T so the full StreamView type (with codec/transport/confidence) is
  // preserved through the filter — the card still gets every field it needs.
  $: filteredStreams = filterStreams(activeStreams, filters);

  // Phase C: dynamic option derivation — only show options actually present
  // in the current active-tab stream collection, with counts from the FULL
  // collection (not just the visible cards). These helpers only read the
  // filterable fields, so the cast to FilterableStream[] is safe.
  $: currentTypeOptions = typeOptions(activeStreams as FilterableStream[]);
  $: currentQualityOptions = qualityOptions(activeStreams as FilterableStream[]);
  $: currentSizeOptions = sizeOptions(activeStreams as FilterableStream[]);
  $: currentLanguageOptions = languageOptions(activeStreams as FilterableStream[]);

  // Phase C: active-filter chips + Clear. When filters are active, show
  // removable chips for each active dimension + a single Clear action.
  $: activeChips = activeFilterChips(filters);
  $: anyFiltersActive = hasActiveFilters(filters);

  // Phase C corrective: Size uses a SelectionSheet popover (per the approved
  // plan STEP 4: "compact Mavero-themed popover/sheet"). The existing
  // SelectionSheet primitive is reused — no new component framework.
  let sizeSheetOpen = false;

  // Map the dynamic SizeOptions to SelectionSheet's { key, label, description }.
  // SelectionSheet uses `key` (not `value`) — we map accordingly. The count
  // goes into the `description` field so the user sees how many streams match
  // each range before selecting. Type is inferred — no inline type alias
  // (Svelte's parser doesn't handle `type X = ...` before `$:` cleanly).
  $: sizeSheetOptions = currentSizeOptions.map((opt) => ({
    key: opt.value,
    label: opt.label,
    description: `${opt.count} stream${opt.count === 1 ? '' : 's'}`,
  }));

  // The Size trigger button shows the current filter label (or "Size" when
  // unfiltered) + a chevron icon.
  $: sizeTriggerLabel = filters.size === 'all' ? 'Size' : sizeFilterLabel(filters.size as SizeFilterValue);

  function openSizeSheet(): void { sizeSheetOpen = true; }
  function closeSizeSheet(): void { sizeSheetOpen = false; }
  function selectSize(key: string): void {
    filters = { ...filters, size: key as DownloaderFilters['size'] };
    sizeSheetOpen = false;
  }

  // Phase E V2: Info sheet + Filters sheet (stream-first IA).
  let infoSheetOpen = false;
  function openInfoSheet(): void { infoSheetOpen = true; }
  function closeInfoSheet(): void { infoSheetOpen = false; }

  let filterSheetOpen = false;
  function openFilterSheet(): void { filterSheetOpen = true; }
  function closeFilterSheet(): void { filterSheetOpen = false; }

  // Phase E V2: transport label for each stream kind (HTTPS · Direct, HLS · Stream, etc.)
  function transportLabel(kind: StreamView['kind']): string {
    const label = linkTypeLabel(kind as DownloadLinkType);
    const category = linkTypeCategory(kind as DownloadLinkType);
    return `${label} · ${category}`;
  }

  // Phase E V2: Type filter visibility — only show Type when >1 type is available.
  $: showTypeFilter = currentTypeOptions.length > 2; // >2 because "All" is always first

  // Phase E V2: presentation window / Show More.
  // The filtered streams are split into an initial window (best HTTPS per
  // quality) + remaining streams. Show More reveals the next batch.
  $: presentationResult = selectPresentationWindow(filteredStreams as PresentableStream[]);
  let visibleStreams: typeof filteredStreams = presentationResult.initial as typeof filteredStreams;
  let remainingStreams: typeof filteredStreams = presentationResult.remaining as typeof filteredStreams;
  // Reset visible/remaining when filters or tab change.
  $: { presentationResult; visibleStreams = presentationResult.initial as typeof filteredStreams; remainingStreams = presentationResult.remaining as typeof filteredStreams; }

  function handleShowMore(): void {
    const next = showMoreBatch(visibleStreams, remainingStreams);
    visibleStreams = next.visible;
    remainingStreams = next.remaining;
  }

  // Phase C: when the active tab changes, RESET filters to 'all'. The filter
  // state is per-tab (different addons have different stream types). This
  // prevents stale filter state from hiding all streams when the user
  // switches tabs.
  function resetFilters(): void {
    filters = { ...NO_FILTERS };
  }

  function clearAllFilters(): void {
    resetFilters();
  }

  function removeFilter(dimension: 'type' | 'quality' | 'size' | 'language'): void {
    filters = clearFilterDimension(filters, dimension);
  }

  // When the user switches tabs, reset the filters so stale state doesn't
  // hide all streams in the new tab.
  function selectTab(id: string): void {
    if (id !== activeTabId) resetFilters();
    activeTabId = id;
  }

  function formatSize(bytes?: number): string | undefined {
    if (!bytes || bytes <= 0) return undefined;
    if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(bytes >= 10 * 1024 ** 3 ? 0 : 1)} GB`;
    if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`;
    return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  }

  function streamLabel(stream: StreamView): string {
    const parts = [
      stream.quality === 'auto' ? 'Auto' : stream.quality,
      stream.codec !== 'unknown' ? stream.codec : undefined,
      stream.container,
      stream.audio === 'multi' ? 'Multi Audio' : stream.audio === 'dual' ? 'Dual Audio' : undefined,
      formatSize(stream.sizeBytes),
      stream.kind.toUpperCase(),
    ];
    return parts.filter((part): part is string => Boolean(part)).join(' · ');
  }

  /**
   * Phase B (card UX §B2): structured-badge helpers. The card now renders
   * each metadata dimension as its own pill (kind icon + quality + codec +
   * container + audio + size + host) so the user can scan a list of links
   * at a glance — comparable to Nuvio / Streamio-style source selectors in
   * information density, without copying any proprietary markup. The old
   * `streamLabel` text is preserved as the Share button's accessible
   * label fallback (so screen readers still get a full description).
   */
  function kindIcon(kind: StreamView['kind']): typeof FileVideo {
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

  function kindLabel(kind: StreamView['kind']): string {
    switch (kind) {
      case 'http': return 'HTTP';
      case 'https': return 'HTTPS';
      case 'hls': return 'HLS';
      case 'dash': return 'DASH';
      case 'p2p': return 'P2P';
      case 'magnet': return 'MAGNET';
      default: return kind.toUpperCase();
    }
  }

  function qualityBadgeClass(quality: string): string {
    switch (quality) {
      case '4K': return 'mad-badge-quality mad-badge-4k';
      case '1080p': return 'mad-badge-quality mad-badge-1080';
      case '720p': return 'mad-badge-quality mad-badge-720';
      case '480p': return 'mad-badge-quality mad-badge-480';
      default: return 'mad-badge-quality mad-badge-auto';
    }
  }

  function audioLabel(stream: StreamView): string | undefined {
    if (stream.audio === 'multi') return 'Multi';
    if (stream.audio === 'dual') return 'Dual';
    if (stream.audioLanguages?.length) return stream.audioLanguages.slice(0, 3).join(',');
    return undefined;
  }

  function streamDetail(stream: StreamView): string | undefined {
    const candidate = stream.filename || stream.title || stream.name;
    if (candidate && candidate.trim()) {
      const trimmed = candidate.trim();
      return trimmed.length > 120 ? `${trimmed.slice(0, 120)}…` : trimmed;
    }
    const firstLine = (stream.description ?? '').split('\n').map((line) => line.trim()).find(Boolean);
    return firstLine;
  }

  function shareTitle(stream: StreamView, addonName: string): string {
    const fromStream = stream.title || stream.name || stream.filename;
    if (fromStream && fromStream.trim()) return fromStream.trim().slice(0, 120);
    const quality = stream.quality === 'auto' ? 'Auto' : stream.quality;
    return `${addonName} · ${quality}`;
  }

  function defaultTabId(list: Tab[]): string | null {
    if (!list.length) return null;
    return (list.find((tab) => tab.status === 'loaded' && tab.streams.length > 0) ?? list[0]).addonId;
  }

  function buildParams(): URLSearchParams {
    const params = new URLSearchParams({ contentId, mediaType, tmdbId });
    if (season !== undefined) params.set('season', String(season));
    if (episode !== undefined) params.set('episode', String(episode));
    return params;
  }

  async function loadTabs(): Promise<void> {
    tabsLoading = true;
    tabsFailed = false;
    try {
      const response = await fetch(`/api/downloader/mavero/tabs?${buildParams().toString()}`, { headers: { accept: 'application/json' } });
      const payload = await response.json() as { ok?: boolean; tabs?: Array<{ addonId: string; addonName: string; addonSlug: string; addonOrdering: number }> };
      if (!response.ok || !payload.ok) throw new Error('unavailable');
      tabs = (payload.tabs ?? []).map((tab) => ({ ...tab, status: 'loading' as TabStatus, streams: [] }));
      activeTabId = defaultTabId(tabs);
      tabsFailed = false;
    } catch {
      tabsFailed = true;
      tabs = [];
      activeTabId = null;
    } finally {
      tabsLoading = false;
    }
  }

  async function loadAddon(tab: Tab): Promise<void> {
    tab.abort?.abort();
    const abort = new AbortController();
    tab.abort = abort;
    tab.status = tab.status === 'unavailable' ? 'loading' : tab.status === 'retrying' ? 'retrying' : 'loading';
    tab.errorCode = undefined;
    tab.streams = [];
    tabs = [...tabs];
    const params = buildParams();
    params.set('addon', tab.addonId);
    try {
      const response = await fetch(`/api/downloader/mavero/addon?${params.toString()}`, {
        headers: { accept: 'application/json' },
        signal: abort.signal,
      });
      if (abort.signal.aborted) return;
      const payload = await response.json() as {
        ok?: boolean;
        group?: { status: TabStatus; streams: StreamView[]; errorCode?: string; attempts?: number };
      };
      if (!response.ok || !payload.ok || !payload.group) throw new Error('unavailable');
      tab.status = payload.group.status;
      tab.streams = payload.group.streams ?? [];
      tab.errorCode = payload.group.errorCode;
      tab.attempts = payload.group.attempts;
    } catch (error) {
      if (abort.signal.aborted) return;
      tab.status = 'unavailable';
      tab.streams = [];
      tab.errorCode = 'NETWORK';
      console.warn('[MaveroDownloader] tab fetch failed', tab.addonSlug, error);
    } finally {
      if (!abort.signal.aborted) {
        tabs = [...tabs];
        if (activeTabId === tab.addonId && tab.status !== 'loaded' && tab.streams.length === 0) {
          const firstLoaded = tabs.find((candidate) => candidate.status === 'loaded' && candidate.streams.length > 0);
          if (firstLoaded && firstLoaded.addonId !== activeTabId) {
            activeTabId = firstLoaded.addonId;
          }
        }
      }
    }
  }

  async function load(): Promise<void> {
    await loadTabs();
    if (tabs.length === 0) return;
    for (const tab of tabs) {
      void loadAddon(tab);
    }
  }

  function retryTab(tab: Tab): void {
    if (tab.status === 'loading' || tab.status === 'retrying') return;
    void loadAddon(tab);
  }

  function retryAll(): void {
    if (tabsLoading) return;
    void load();
  }

  async function handleShare(stream: StreamView, addonName: string, key: string): Promise<void> {
    if (shareKey === key && shareState === 'sharing') return;
    const url = stream.url; // the EXACT ORIGINAL URI (HTTP/HTTPS/magnet/P2P)
    if (!url) return;
    shareKey = key;
    shareState = 'sharing';
    if (shareTimer) clearTimeout(shareTimer);
    try {
      if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
        // Phase 20 (task §4): FIX P2P/magnet Share bug.
        // navigator.share({ url }) can FAIL for non-http(s) URIs (magnet:?xt=...)
        // on some browsers/Android — the `url` field expects an http(s) URL.
        // For non-http(s) URIs (magnet, etc.), use the `text` field instead,
        // which carries any string and reliably invokes the native share sheet.
        // The user can then choose 1DM / torrent-capable player / another app.
        const isHttpUrl = url.startsWith('http://') || url.startsWith('https://');
        const shareData: { title: string; url?: string; text?: string } = { title: shareTitle(stream, addonName) };
        if (isHttpUrl) {
          shareData.url = url;
        } else {
          // magnet:/non-http URIs: use text field (universally accepted).
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

  // Phase D: capability-aware action helpers. These delegate to the shared
  // stream-actions module so the capability rules + action construction live
  // in ONE place (imported by both the component and the tests). The
  // component never re-implements capability logic.
  function capsFor(stream: StreamView) {
    return streamCapabilities(stream as CapabilityStream);
  }
  function downloadAttr(stream: StreamView) {
    return downloadActionFor(stream as CapabilityStream);
  }
  function playAttr(stream: StreamView) {
    return playActionFor(stream as CapabilityStream, { android: typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent) });
  }

  onMount(load);
</script>

<div class="mad" aria-busy={tabsLoading}>
  <!-- Phase 18 (task §1): NO redundant heading. The parent DownloadSheet
       already shows "MAVERO / DOWNLOAD" + the movie title. -->

  <!-- Phase E V2: compact instruction + Info button (stream-first IA). -->
  <div class="mad-instructions">
    <p>Use Download, Play or Share on any link.</p>
    <button type="button" class="mad-info-btn" onclick={openInfoSheet} aria-label="More information" title="More information">
      <HelpCircle size={14} />
    </button>
  </div>

  {#if tabsLoading}
    <div class="mad-state" role="status"><span class="mad-spin"><Loader2 size={16} /></span><span>Finding addons…</span></div>
  {:else if tabsFailed}
    <div class="mad-state mad-state-error" role="status">
      <AlertTriangle size={16} />
      <span>Couldn't load addons.</span>
      <button type="button" class="mad-retry" onclick={retryAll}><RotateCw size={11} /> Retry</button>
    </div>
  {:else if tabs.length === 0}
    <div class="mad-state" role="status"><Info size={16} /><span>No Stremio addons enabled.</span></div>
  {:else}
    <!-- Phase E V2: addon chips come FIRST (stream-first IA). -->
    <div class="mad-tabs" role="tablist" aria-label="Addons">
      {#each tabs as tab (tab.addonId)}
        <button
          class="mad-tab"
          class:active={tab.addonId === activeTabId}
          type="button"
          role="tab"
          aria-selected={tab.addonId === activeTabId}
          onclick={() => selectTab(tab.addonId)}
        >
          <span class="mad-tab-name">{tab.addonName}</span>
          {#if tab.status === 'loading' || tab.status === 'retrying'}
            <span class="mad-tab-state loading" role="status"><span class="mad-tab-spin"><Loader2 size={9} /></span></span>
          {:else if tab.status === 'unavailable'}
            <span class="mad-tab-state failed" role="status">Failed</span>
          {:else if tab.status === 'loaded' && tab.streams.length > 0}
            <span class="mad-tab-state ok" role="status">{tab.streams.length}</span>
          {:else}
            <span class="mad-tab-state" role="status">0</span>
          {/if}
        </button>
      {/each}
    </div>

    <!-- Phase E V2: compact filter bar — "X links + Filters" (stream-first). -->
    {#if activeTab && activeStreams.length > 0}
      <div class="mad-filter-bar">
        <span class="mad-filter-count">
          {#if filteredStreams.length === activeStreams.length}
            {activeStreams.length} links
          {:else}
            {filteredStreams.length} of {activeStreams.length}
          {/if}
        </span>
        <button type="button" class="mad-filter-trigger" onclick={openFilterSheet} aria-label="Open filters" title="Open filters">
          <SlidersHorizontal size={13} />
          <span>Filters</span>
        </button>
      </div>
    {/if}

    <!-- Phase E V2: active filter chips (only when filters are active). -->
    {#if anyFiltersActive}
      <div class="mad-active-filters" role="status" aria-label="Active filters">
        {#each activeChips as chip (chip.dimension)}
          <button
            class="mad-active-chip"
            type="button"
            aria-label={`Remove ${chip.label} filter`}
            title={`Remove ${chip.label} filter`}
            onclick={() => removeFilter(chip.dimension)}
          >
            <span class="mad-active-chip-label">{chip.label}</span>
            <X size={10} aria-hidden="true" />
          </button>
        {/each}
        <button
          class="mad-clear"
          type="button"
          aria-label="Clear all filters"
          title="Clear all filters"
          onclick={clearAllFilters}
        >
          Clear
        </button>
      </div>
    {/if}

    {#if activeTab}
      {#if activeTab.status === 'loading' || activeTab.status === 'retrying'}
        <div class="mad-state" role="status">
          <span class="mad-spin"><Loader2 size={16} /></span>
          <span>{activeTab.status === 'retrying' ? 'Trying again…' : `Finding links from ${activeTab.addonName}…`}</span>
        </div>
      {:else if activeTab.status === 'unavailable'}
        <div class="mad-state mad-state-error" role="status">
          <AlertTriangle size={14} />
          <span>{activeTab.addonName} is unavailable.</span>
          <button type="button" class="mad-retry" onclick={() => retryTab(activeTab)}><RotateCw size={11} /> Retry</button>
        </div>
      {:else if activeStreams.length === 0}
        <div class="mad-state" role="status">
          <Info size={14} />
          <span>{activeTab.addonName} returned zero streams.</span>
          <button type="button" class="mad-retry" onclick={() => retryTab(activeTab)}><RotateCw size={11} /> Retry</button>
        </div>
      {:else if filteredStreams.length === 0}
        <!-- Phase C: FILTERED EMPTY STATE — distinct from addon failure. The
             addon DID return streams (activeStreams.length > 0) but the active
             filters produce zero matches. Show a "No matching links" message
             with a Clear-filters action so the user can recover directly.
             This is NOT an addon failure — it's a valid-data + filter mismatch. -->
        <div class="mad-state mad-state-filtered-empty" role="status">
          <SearchX size={14} aria-hidden="true" />
          <span>No matching links</span>
          {#if anyFiltersActive}
            <button type="button" class="mad-retry" onclick={clearAllFilters}><RotateCw size={11} /> Clear filters</button>
          {/if}
        </div>
      {:else}
        <!-- Phase E V2: the count is already shown in the filter bar above.
             No duplicate count here — the stream list starts immediately.
             Uses visibleStreams (the presentation window) instead of filteredStreams. -->
        <div class="mad-list" role="list" aria-label={`${activeTab.addonName} streams`}>
          {#each visibleStreams as stream, index (stream.url + '-' + index)}
            {@const key = `${activeTab.addonSlug}-${index}`}
            {@const KindIcon = kindIcon(stream.kind)}
            {@const dlAction = downloadAttr(stream)}
            {@const plAction = playAttr(stream)}
            <article class="mad-row" role="listitem" aria-label={streamLabel(stream)}>
              <!-- Phase B (card UX §B2): structured card layout. Kind icon +
                   filename/title as the primary scannable identity; metadata
                   badges below give quality/codec/container/audio/size/host
                   at a glance. The card stays compact (one row + one badges
                   row) so density is preserved. -->
              <div class="mad-row-main">
                <div class="mad-row-header">
                  <span class="mad-kind" title={kindLabel(stream.kind)} aria-hidden="true">
                    <KindIcon size={13} />
                  </span>
                  {#if streamDetail(stream)}
                    <span class="mad-row-detail">{streamDetail(stream)}</span>
                  {:else}
                    <span class="mad-row-detail mad-row-detail-fallback">{kindLabel(stream.kind)} · {stream.quality === 'auto' ? 'Auto' : stream.quality}</span>
                  {/if}
                  <span class="mad-transport" title={transportLabel(stream.kind)}>{transportLabel(stream.kind)}</span>
                </div>
                <div class="mad-row-badges">
                  <span class={qualityBadgeClass(stream.quality)}>{stream.quality === 'auto' ? 'Auto' : stream.quality}</span>
                  {#if stream.codec && stream.codec !== 'unknown'}<span class="mad-badge mad-badge-codec">{stream.codec}</span>{/if}
                  {#if stream.container}<span class="mad-badge mad-badge-container">{stream.container}</span>{/if}
                  {#if audioLabel(stream)}
                    <span class="mad-badge mad-badge-audio" title={stream.audioLanguages?.length ? `Audio: ${stream.audioLanguages.join(', ')}` : 'Audio'}>
                      <Volume2 size={10} aria-hidden="true" />
                      <span>{audioLabel(stream)}</span>
                    </span>
                  {/if}
                  {#if formatSize(stream.sizeBytes)}
                    <span class="mad-badge mad-badge-size" title="File size">
                      <HardDrive size={10} aria-hidden="true" />
                      <span>{formatSize(stream.sizeBytes)}</span>
                    </span>
                  {/if}
                  {#if stream.host}
                    <span class="mad-badge mad-badge-host" title={`Hosting server: ${stream.host}`}>
                      <Server size={10} aria-hidden="true" />
                      <span>{stream.host}</span>
                    </span>
                  {/if}
                  {#if stream.subtitles?.length}
                    <span class="mad-badge mad-badge-subtitles" title={`Subtitles: ${stream.subtitles.length} track${stream.subtitles.length === 1 ? '' : 's'}${stream.subtitles.some((t) => t.language) ? ` (${stream.subtitles.map((t) => t.language).filter(Boolean).join(', ')})` : ''}`}>
                      <Captions size={10} aria-hidden="true" />
                      <span>{stream.subtitles.length}</span>
                    </span>
                  {/if}
                </div>
              </div>
              <!-- Phase D: capability-aware actions. Download + Play are
                   shown only when the stream kind supports them. Share is
                   always available. The actions use the EXACT ORIGINAL URI —
                   no proxy, no rewrite, no forced 1DM. Download uses the
                   browser's native anchor mechanism; Play uses the shared
                   external-player launch helper (Android intent for mpv on
                   Chrome with browser_fallback_url; direct link elsewhere). -->
              <div class="mad-row-actions">
                {#if dlAction}
                  {#if dlAction.flow === 'direct-download'}
                    <!-- Direct media file — browser native <a href download> anchor.
                         If the URL is actually a provider page, the browser opens it
                         in a new tab (the download attr is advisory cross-origin). -->
                    <a
                      class="mad-action mad-action-download"
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
                    <!-- Magnet/P2P — direct anchor to the magnet URI. The OS
                         resolves the handler (torrent app if registered). -->
                    <a
                      class="mad-action mad-action-download"
                      href={dlAction.href}
                      aria-label="Open in torrent app"
                      title="Open in torrent app (original magnet URI)"
                      onclick={(event) => event.stopPropagation()}
                    >
                      <Download size={13} />
                    </a>
                  {:else if dlAction.flow === 'embedded-sheet'}
                    <!-- Third-party provider/download page — the addon explicitly
                         supplied an externalUrl. Route through the DownloadSheet's
                         iframe infrastructure (attempt to embed → if blocked by
                         CSP/X-Frame-Options/browser security → external-open fallback).
                         Mavero does NOT proxy or bypass security. (External streams
                         are hidden by Phase 18, so this path exists in the model but
                         is not triggered in the current card UI.) -->
                    {#if onOpenInSheet}
                      <button
                        class="mad-action mad-action-download"
                        type="button"
                        aria-label="Open download page"
                        title="Open download page (embedded sheet)"
                        onclick={(event) => { event.stopPropagation(); onOpenInSheet(dlAction.href); }}
                      >
                        <Download size={13} />
                      </button>
                    {:else}
                      <a
                        class="mad-action mad-action-download"
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
                    class="mad-action mad-action-play"
                    href={plAction.href}
                    aria-label="Play in external player"
                    title="Play in external player"
                    onclick={(event) => event.stopPropagation()}
                  >
                    <Play size={13} />
                  </a>
                {/if}
                <!-- Phase D: Share preserved (Phase 18 contract intact). -->
                <button
                  class="mad-action mad-action-share"
                  class:done={shareKey === key && shareState === 'shared'}
                  class:failed={shareKey === key && shareState === 'failed'}
                  type="button"
                  aria-label={shareKey === key && shareState === 'shared' ? 'URI shared' : shareKey === key && shareState === 'failed' ? 'Share failed' : 'Share original URI'}
                  title="Share (original URI)"
                  onclick={(event) => { event.stopPropagation(); void handleShare(stream, activeTab.addonName, key); }}
                >
                  {#if shareKey === key && shareState === 'sharing'}<Loader2 size={13} class="mad-spin" />
                  {:else if shareKey === key && shareState === 'shared'}<Check size={13} />
                  {:else if shareKey === key && shareState === 'failed'}<AlertTriangle size={13} />
                  {:else}<Share2 size={13} />{/if}
                </button>
              </div>
            </article>
          {/each}
        </div>
        <!-- Phase E V2: Show More + "Showing X of Y" indicator. -->
        {#if remainingStreams.length > 0}
          <div class="mad-show-more">
            <span class="mad-showing-count">Showing {visibleStreams.length} of {filteredStreams.length}</span>
            <button type="button" class="mad-show-more-btn" onclick={handleShowMore} aria-label="Show more streams">
              Show more ({remainingStreams.length} remaining)
            </button>
          </div>
        {/if}
      {/if}
    {/if}
  {/if}
</div>

<!-- Phase C corrective: Size filter as a SelectionSheet popover/sheet (per
     the approved plan STEP 4). Reuses the existing SelectionSheet primitive
     — no new component framework. Options are dynamically derived from the
     FULL active-tab stream collection. Counts are shown in the description
     field. Selecting an option sets filters.size and closes the sheet —
     NO addon refetch. -->
<SelectionSheet
  open={sizeSheetOpen}
  eyebrow="MAVERO / Filter"
  title="Size"
  options={sizeSheetOptions}
  selected={filters.size}
  onClose={closeSizeSheet}
  onSelect={selectSize}
/>

<!-- Phase E V2: Info sheet — recommended apps moved from the main surface
     into a Mavero-styled sheet. Opens when the Info button is clicked.
     Uses the EXISTING repository app icon assets (/icons/1DM.png + /icons/MPV.png).
     Reuses the existing SelectionSheet primitive. -->
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

<!-- Phase E V2: Filters sheet — all 4 filter dimensions in one sheet.
     Type is only shown when >1 type is available (Phase E V2 §9).
     Reuses SelectionSheet for Size; Type/Quality/Language use inline chips
     within the sheet's options list. The sheet replaces the permanent
     4-row filter stack on the main surface. -->
<SelectionSheet
  open={filterSheetOpen}
  eyebrow="MAVERO / Filter"
  title="Filters"
  options={[
    ...currentTypeOptions.map((o) => ({ key: `type:${o.value}`, label: `${o.label}`, description: `${o.count} stream${o.count === 1 ? '' : 's'}` })),
    ...currentQualityOptions.map((o) => ({ key: `quality:${o.value}`, label: o.label, description: `${o.count} stream${o.count === 1 ? '' : 's'}` })),
    ...currentLanguageOptions.map((o) => ({ key: `lang:${o.value}`, label: o.label, description: `${o.count} stream${o.count === 1 ? '' : 's'}` })),
    ...currentSizeOptions.map((o) => ({ key: `size:${o.value}`, label: o.label, description: `${o.count} stream${o.count === 1 ? '' : 's'}` })),
  ]}
  selected=""
  onClose={closeFilterSheet}
  onSelect={(key) => {
    const [dim, val] = key.split(':');
    if (dim === 'type') filters = { ...filters, type: filters.type === val ? 'all' : val as DownloaderFilters['type'] };
    else if (dim === 'quality') filters = { ...filters, quality: filters.quality === val ? 'all' : val };
    else if (dim === 'lang') filters = { ...filters, language: filters.language === val ? 'all' : val };
    else if (dim === 'size') filters = { ...filters, size: filters.size === val ? 'all' : val as DownloaderFilters['size'] };
    filterSheetOpen = false;
  }}
/>

<style>
  /* Phase E: Mavero visual redesign — dark cyberpunk surfaces, restrained
     accent treatments, strong hierarchy, readable contrast. All hardcoded
     rgba backgrounds replaced with Mavero design tokens. */
  .mad { display: flex; flex-direction: column; gap: 8px; min-height: 260px; color: var(--ink); }

  /* Instructions — compact info banner with Mavero surface + accent border. */
  .mad-instructions { display: flex; flex-direction: row; align-items: center; justify-content: space-between; gap: 8px; padding: 6px 10px; border: 1px solid var(--line); border-left: 2px solid var(--accent); border-radius: var(--radius-sm); background: var(--color-surface); }
  .mad-instructions p { margin: 0; color: var(--muted); font-size: 0.56rem; line-height: 1.4; flex: 1 1 auto; }
  .mad-info-btn { display: grid; place-items: center; width: 26px; height: 26px; border: 1px solid var(--line); border-radius: 999px; background: var(--color-surface-elevated); color: var(--ink-soft); cursor: pointer; flex: 0 0 auto; transition: border-color var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out); }
  .mad-info-btn:hover, .mad-info-btn:focus-visible { border-color: var(--accent); color: var(--accent); outline: none; }

  /* Suggested apps — Mavero surface cards. */
  .mad-apps { display: flex; gap: 6px; }
  .mad-app { display: flex; align-items: center; gap: 6px; padding: 5px 8px; border: 1px solid var(--line); border-radius: var(--radius-sm); background: var(--color-surface); text-decoration: none; flex: 1 1 0; min-width: 0; transition: border-color var(--motion-fast) var(--ease-out), background var(--motion-fast) var(--ease-out); }
  .mad-app:hover { border-color: var(--line-strong); background: var(--accent-soft); }
  .mad-app-icon { width: 24px; height: 24px; border-radius: 6px; object-fit: cover; flex: 0 0 auto; }
  .mad-app-name { color: var(--ink); font-size: 0.6rem; font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  /* State messages — centered, muted, with Mavero surface. */
  .mad-state { display: flex; min-height: 100px; flex: 1 1 auto; align-items: center; justify-content: center; gap: 8px; flex-wrap: wrap; padding: 12px; color: var(--muted); font-size: 0.68rem; text-align: center; }
  .mad-state-error { color: var(--color-warning); }
  .mad-retry { display: inline-flex; align-items: center; gap: 4px; border: 1px solid var(--line-strong); border-radius: 999px; background: var(--accent-soft); color: var(--ink); padding: 5px 12px; font: inherit; font-size: 0.62rem; font-weight: 700; cursor: pointer; transition: border-color var(--motion-fast) var(--ease-out); }
  .mad-retry:hover { border-color: var(--accent); color: var(--accent); }
  .mad-spin { display: grid; place-items: center; animation: mad-spin 0.9s linear infinite; }

  /* Filter controls — back-compat + Phase E refinement. */
  .mad-filters { display: flex; gap: 4px; width: 100%; }
  .mad-filter { flex: 1 1 0; min-width: 0; border: 1px solid var(--line); border-radius: var(--radius-sm); background: var(--color-surface); color: var(--ink); padding: 4px; font: inherit; font-size: 0.56rem; font-weight: 600; cursor: pointer; text-align: center; }
  .mad-filter:hover { border-color: var(--line-strong); }
  .mad-filter:focus-visible { border-color: var(--accent); outline: none; }
  .mad-filter-group { display: flex; flex-direction: column; gap: 5px; padding: 6px; border: 1px solid var(--line); border-radius: var(--radius-sm); background: var(--color-surface); }

  /* Chip rows — horizontally scrollable Mavero pills. */
  .mad-chips { display: flex; gap: 5px; overflow-x: auto; padding-bottom: 1px; scrollbar-width: none; min-height: 28px; }
  .mad-chips::-webkit-scrollbar { display: none; }
  .mad-chip { display: inline-flex; align-items: center; gap: 4px; flex: 0 0 auto; border: 1px solid var(--line); border-radius: 999px; background: var(--color-surface-elevated); color: var(--ink-soft); padding: 4px 9px; font: inherit; font-size: 0.56rem; font-weight: 700; cursor: pointer; white-space: nowrap; transition: border-color var(--motion-fast) var(--ease-out), background var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out); }
  .mad-chip:hover { border-color: var(--line-strong); color: var(--ink); background: var(--color-surface-raised); }
  .mad-chip:focus-visible { border-color: var(--accent); outline: none; }
  .mad-chip.active { border-color: var(--accent); background: var(--accent-soft); color: var(--ink); }
  .mad-chip-label { line-height: 1.3; }
  .mad-chip-count { display: inline-flex; min-width: 16px; height: 15px; align-items: center; justify-content: center; border-radius: 999px; background: var(--color-border-strong); color: var(--muted); padding: 0 4px; font-size: 0.48rem; font-weight: 700; }
  .mad-chip.active .mad-chip-count { background: var(--accent); color: var(--color-bg); }

  /* Size trigger — popover button consistent with chips. */
  .mad-size-trigger { display: inline-flex; align-items: center; gap: 4px; flex: 0 0 auto; border: 1px solid var(--line); border-radius: 999px; background: var(--color-surface-elevated); color: var(--ink-soft); padding: 4px 9px; font: inherit; font-size: 0.56rem; font-weight: 700; cursor: pointer; white-space: nowrap; transition: border-color var(--motion-fast) var(--ease-out), background var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out); }
  .mad-size-trigger:hover { border-color: var(--line-strong); color: var(--ink); background: var(--color-surface-raised); }
  .mad-size-trigger:focus-visible { border-color: var(--accent); outline: none; }
  .mad-size-trigger.active { border-color: var(--accent); background: var(--accent-soft); color: var(--ink); }
  .mad-size-trigger-label { line-height: 1.3; }
  .mad-size-trigger :global(.mad-size-trigger-chevron) { transition: transform var(--motion-fast) var(--ease-out); }
  .mad-size-trigger[aria-expanded="true"] :global(.mad-size-trigger-chevron) { transform: rotate(180deg); }

  /* Active filter chips + Clear. */
  .mad-active-filters { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; padding: 4px 6px; border-radius: var(--radius-sm); background: var(--accent-soft); }
  .mad-active-chip { display: inline-flex; align-items: center; gap: 3px; border: 1px solid var(--accent); border-radius: 999px; background: var(--color-surface-elevated); color: var(--ink); padding: 3px 7px; font: inherit; font-size: 0.52rem; font-weight: 700; cursor: pointer; white-space: nowrap; transition: background var(--motion-fast) var(--ease-out); }
  .mad-active-chip:hover { border-color: var(--accent); background: var(--accent); color: var(--color-bg); }
  .mad-active-chip:focus-visible { outline: none; border-color: var(--accent); box-shadow: 0 0 0 2px var(--accent-soft); }
  .mad-active-chip-label { line-height: 1.3; }
  .mad-clear { display: inline-flex; align-items: center; border: 1px solid var(--line-strong); border-radius: 999px; background: transparent; color: var(--ink-soft); padding: 3px 10px; font: inherit; font-size: 0.52rem; font-weight: 700; cursor: pointer; white-space: nowrap; margin-left: auto; transition: border-color var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out); }
  .mad-clear:hover { border-color: var(--accent); color: var(--accent); }
  .mad-clear:focus-visible { outline: none; border-color: var(--accent); box-shadow: 0 0 0 2px var(--accent-soft); }

  /* Filtered-empty state. */
  .mad-state-filtered-empty { color: var(--muted); }
  .mad-state-filtered-empty .mad-retry { margin-left: 4px; }

  /* Phase E V2: compact filter bar — "X links + Filters" (stream-first IA). */
  .mad-filter-bar { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 4px 6px; }
  .mad-filter-trigger { display: inline-flex; align-items: center; gap: 5px; border: 1px solid var(--line-strong); border-radius: 999px; background: var(--color-surface-elevated); color: var(--ink-soft); padding: 4px 10px; font: inherit; font-size: 0.56rem; font-weight: 700; cursor: pointer; white-space: nowrap; transition: border-color var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out); }
  .mad-filter-trigger:hover, .mad-filter-trigger:focus-visible { border-color: var(--accent); color: var(--accent); outline: none; }

  /* Phase E V2: transport label on cards (HTTPS · Direct, HLS · Stream, etc.) */
  .mad-transport { display: inline-flex; align-items: center; border: 1px solid var(--color-secondary-soft); border-radius: 4px; background: var(--color-secondary-soft); color: var(--accent-2); padding: 1px 5px; font-size: 0.48rem; font-weight: 700; white-space: nowrap; flex: 0 0 auto; }

  /* Phase E V2: Show More + Showing X of Y. */
  .mad-show-more { display: flex; flex-direction: column; align-items: center; gap: 4px; padding: 6px; }
  .mad-showing-count { color: var(--muted); font-size: 0.52rem; font-weight: 600; }
  .mad-show-more-btn { display: inline-flex; align-items: center; gap: 4px; border: 1px solid var(--line-strong); border-radius: 999px; background: var(--color-surface-elevated); color: var(--ink-soft); padding: 5px 14px; font: inherit; font-size: 0.56rem; font-weight: 700; cursor: pointer; transition: border-color var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out); }
  .mad-show-more-btn:hover, .mad-show-more-btn:focus-visible { border-color: var(--accent); color: var(--accent); outline: none; }

  /* Addon tabs — horizontally scrollable pills with status. */
  .mad-tabs { display: flex; gap: 5px; overflow-x: auto; padding-bottom: 2px; scrollbar-width: none; }
  .mad-tabs::-webkit-scrollbar { display: none; }
  .mad-tab { display: flex; flex: 0 0 auto; align-items: center; gap: 5px; border: 1px solid var(--line); border-radius: 999px; background: var(--color-surface-elevated); color: var(--ink-soft); padding: 5px 10px; font: inherit; font-size: 0.62rem; font-weight: 700; cursor: pointer; transition: border-color var(--motion-fast) var(--ease-out), background var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out); }
  .mad-tab:hover { border-color: var(--line-strong); color: var(--ink); background: var(--color-surface-raised); }
  .mad-tab.active { border-color: var(--accent); color: var(--ink); background: var(--accent-soft); }
  .mad-tab-name { max-width: 120px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .mad-tab-state { min-width: 16px; border-radius: 999px; background: var(--color-border-strong); color: var(--muted); padding: 1px 5px; font-size: 0.52rem; font-weight: 700; text-align: center; display: inline-flex; align-items: center; justify-content: center; }
  .mad-tab-state.ok { color: var(--accent); }
  .mad-tab-state.failed { color: var(--color-warning); }
  .mad-tab-state.loading { background: transparent; padding: 1px 2px; }
  .mad-tab-spin { display: grid; place-items: center; animation: mad-spin 0.9s linear infinite; }
  .mad-filter-count { color: var(--muted); font-size: 0.54rem; font-weight: 700; padding: 2px 4px; }

  /* Stream list — maximum vertical space, thin scrollbar. */
  .mad-list { display: flex; flex-direction: column; gap: 5px; flex: 1 1 auto; overflow-y: auto; scrollbar-width: thin; min-height: 0; }
  .mad-list::-webkit-scrollbar { width: 3px; }
  .mad-list::-webkit-scrollbar-thumb { background: var(--line-strong); border-radius: 2px; }

  /* Stream cards — Mavero dark surface with restrained accent treatment. */
  .mad-row { display: flex; align-items: center; gap: 8px; border: 1px solid var(--line); border-radius: var(--radius-sm); background: var(--color-surface); padding: 8px 10px; transition: border-color var(--motion-fast) var(--ease-out), background var(--motion-fast) var(--ease-out); }
  .mad-row:hover { border-color: var(--line-strong); background: var(--color-surface-elevated); }
  .mad-row:focus-within { border-color: var(--accent); box-shadow: var(--glow-primary); }
  .mad-row-main { display: flex; flex: 1 1 auto; flex-direction: column; gap: 4px; min-width: 0; }
  .mad-row-header { display: flex; align-items: center; gap: 6px; min-width: 0; }
  .mad-kind { display: inline-flex; align-items: center; justify-content: center; width: 26px; height: 26px; border-radius: 6px; background: var(--accent-soft); color: var(--accent); flex: 0 0 auto; }
  .mad-row-label { overflow: hidden; color: var(--ink); font-size: 0.64rem; font-weight: 750; text-overflow: ellipsis; white-space: nowrap; }
  .mad-row-detail { display: -webkit-box; overflow: hidden; color: var(--ink); font-size: 0.62rem; font-weight: 650; word-break: break-word; -webkit-box-orient: vertical; -webkit-line-clamp: 1; line-clamp: 1; flex: 1 1 auto; min-width: 0; }
  .mad-row-detail-fallback { color: var(--muted); font-weight: 600; }

  /* Badges row — wraps on small screens, Mavero-styled pills. */
  .mad-row-badges { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; min-width: 0; }
  .mad-badge { display: inline-flex; align-items: center; gap: 3px; border: 1px solid var(--line); border-radius: 4px; background: var(--color-surface-raised); color: var(--ink-soft); padding: 2px 6px; font-size: 0.52rem; font-weight: 700; line-height: 1.4; white-space: nowrap; }
  .mad-badge :global(svg) { flex: 0 0 auto; opacity: 0.85; }
  .mad-kind :global(svg) { flex: 0 0 auto; }
  .mad-badge-quality { border-color: var(--accent-border); background: var(--accent-soft); color: var(--ink); }
  .mad-badge-4k { color: var(--accent); }
  .mad-badge-1080 { color: var(--ink); }
  .mad-badge-720 { color: var(--ink-soft); }
  .mad-badge-480 { color: var(--muted); }
  .mad-badge-auto { color: var(--muted); }
  .mad-badge-codec { color: var(--ink-soft); }
  .mad-badge-container { color: var(--ink-soft); }
  .mad-badge-audio { color: var(--ink-soft); }
  .mad-badge-size { color: var(--ink); }
  .mad-badge-host { color: var(--accent-2); max-width: 140px; overflow: hidden; text-overflow: ellipsis; border-color: var(--color-secondary-soft); }
  .mad-badge-host span { overflow: hidden; text-overflow: ellipsis; }
  .mad-badge-subtitles { color: var(--ink-soft); }

  /* Action buttons — 32px touch targets, Mavero surface + accent on hover. */
  .mad-action { position: relative; display: grid; place-items: center; width: 32px; height: 32px; border: 1px solid var(--line); border-radius: var(--radius-sm); color: var(--ink-soft); background: var(--color-surface-raised); cursor: pointer; text-decoration: none; flex: 0 0 auto; transition: border-color var(--motion-fast) var(--ease-out), background var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out); }
  .mad-action:hover, .mad-action:focus-visible { border-color: var(--line-strong); background: var(--accent-soft); color: var(--ink); }
  .mad-action:active { transform: scale(0.96); }
  .mad-action.done { border-color: var(--accent); color: var(--accent); }
  .mad-action.failed { border-color: var(--color-warning); color: var(--color-warning); }
  .mad-action-share { color: var(--ink); }
  .mad-action-download { color: var(--ink-soft); }
  .mad-action-play { color: var(--ink-soft); }
  .mad-row-actions { display: flex; align-items: center; gap: 5px; flex: 0 0 auto; }

  @keyframes mad-spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .mad-spin, .mad-tab-spin { animation: none; } .mad-action, .mad-row, .mad-chip, .mad-tab, .mad-app, .mad-size-trigger { transition: none; } }

  /* Phase E: responsive breakpoints. */
  /* Narrow mobile (≤ 360px) — host badge drops off to save space. */
  @media (max-width: 360px) { .mad-badge-host { display: none; } .mad-action { width: 30px; height: 30px; } .mad-instructions p { font-size: 0.52rem; } }
  /* Tablet / desktop (≥ 700px) — more breathing room, larger fonts. */
  @media (min-width: 700px) { .mad { gap: 10px; } .mad-filter-group { padding: 8px 10px; gap: 6px; } .mad-chip { padding: 5px 11px; font-size: 0.6rem; } .mad-size-trigger { padding: 5px 11px; font-size: 0.6rem; } .mad-tab { padding: 6px 12px; font-size: 0.66rem; } .mad-row { padding: 10px 12px; gap: 10px; } .mad-kind { width: 28px; height: 28px; } .mad-row-detail { font-size: 0.66rem; } .mad-badge { font-size: 0.56rem; padding: 3px 7px; } .mad-action { width: 34px; height: 34px; } .mad-list { gap: 6px; } }
  /* Large screen / TV (≥ 1024px) — clear focus states, navigable controls. */
  @media (min-width: 1024px) { .mad { min-height: 320px; } .mad-filter-group { padding: 10px 12px; } .mad-row:hover { box-shadow: var(--shadow-sm); } }
</style>
