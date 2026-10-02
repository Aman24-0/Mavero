<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { AlertTriangle, Info, Loader2, RotateCw, Share2, Check, FileVideo, Radio, Magnet, Users, Volume2, HardDrive, Server, X, SearchX, Download, Play, SlidersHorizontal } from 'lucide-svelte';
  import DownloaderFilterSheet from '$components/DownloaderFilterSheet.svelte';
  import {
    applyCloudStreamGroup,
    applyCloudStreamGroups,
    activeCloudStreamChips,
    clearCloudStreamFilterDimension,
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
  import { selectPresentationWindow, showMoreBatch, type PresentableStream } from '$lib/shared/presentation-window';
  import { isPixeldrainUrl } from '$lib/shared/external-player';
  import {
    downloadActionFor,
    playActionFor,
    type CapabilityStream,
  } from '$lib/shared/stream-actions';
  import { linkTypeLabel, linkTypeCategory, type DownloadLinkType } from '$lib/shared/download-link-types';
  import type { CloudStreamDownloadLinkView, CloudStreamDownloadMediaView, CloudStreamDownloaderErrorCode } from '$lib/shared/cloudstream-types';

  /**
   * MAVERO DOWNLOADER 2 — CloudStream discovery surface (CS-4, plan §14/§27).
   *
   * The user-facing panel for:
   *
   *     Mavero Downloader 2 → /api/downloader/mavero2 → CloudStream Extensions
   *
   * Deliberately SEPARATE from MaveroAddonDownload.svelte (Stremio — the two
   * resolvers are never merged, plan §2.3/§12) while sharing the SAME action
   * model (stream-actions.ts — no second MPV/Share), the same filter sheet,
   * and the same card/pill visual language so the experience feels native.
   *
   * DATA FLOW (the CS-3 contract — NO N+1):
   *   1. mount → GET /api/downloader/mavero2/tabs           (tabs, no provider fetches)
   *   2. tabs>0 → GET /api/downloader/mavero2               (ONE batch resolve, all sources)
   *   3. group/count display from the batch response         (counts never re-resolve)
   *   4. per-source retry → GET /api/downloader/mavero2/extension?extensionId=…
   *      (ONLY the necessary request — switching tabs NEVER refetches)
   *
   *   The browser never executes or imports CloudStream provider code; every
   *   resolution stays server-side behind the Mavero API.
   *
   * URL LIFETIME (plan §40.7): resolved URLs are never persisted (no
   * localStorage/sessionStorage, no long-lived caches) — reopening the panel
   * re-resolves through the API.
   *
   * PARTIAL SUCCESS: one failed source NEVER becomes a global error — its
   * tab shows a Failed pill + a user-readable message; successful sources
   * keep rendering their links.
   *
   * RATE LIMITS: no automatic retries anywhere — RATE_LIMITED shows a
   * message and a manual Retry action only.
   */

  // ----- Props (the same contract the parent DownloadSheet passes to
  // MaveroAddonDownload — CS-5 wires this panel into the provider routing).
  export let contentId = '';
  export let mediaType: 'movie' | 'series' | 'anime' = 'movie';
  export let tmdbId = '';
  export let season: number | undefined = undefined;
  export let episode: number | undefined = undefined;
  // Accepted for DownloadSheet API compatibility; the title is displayed by
  // the parent sheet header — this panel only shows the episode context line.
  // svelte-ignore export_let_unused
  export let title = '';
  // Callback into the parent sheet for the embedded-sheet download flow
  // (Pixeldrain viewer pages — the same Phase F mechanism as the Stremio
  // downloader). Falls back to an external-open anchor when absent.
  export let onOpenInSheet: ((url: string) => void) | undefined = undefined;

  // ----- Request state -----
  type EnvelopeError = { code: CloudStreamDownloaderErrorCode; message?: string };
  let tabs: CloudStreamSourceTab[] = [];
  let consideredExtensions = 0;
  let tabsLoading = true;
  /** Network/transport failure of the tabs request (retry-able). */
  let tabsFailed = false;
  /** Typed envelope error from the tabs request (RATE_LIMITED / INVALID_REQUEST / …). */
  let tabsEnvelope: EnvelopeError | null = null;
  /** True while the ONE batch resolution request is in flight. */
  let resolving = false;
  /** Typed envelope error from the batch request. */
  let resolveEnvelope: EnvelopeError | null = null;
  let activeTabId: string | null = null;
  /** Server media echo (drives the episode context line when present). */
  let media: CloudStreamDownloadMediaView | null = null;

  // Abort controllers — cancelled on destroy so no response ever lands on a
  // destroyed component (the same pattern as the Stremio addon panel).
  let tabsAbort: AbortController | undefined;
  let resolveAbort: AbortController | undefined;
  const retryAborts = new Map<string, AbortController>();

  // ----- Filters (client-side only — a filter change NEVER refetches) -----
  let filters: CloudStreamFilters = { ...NO_CS_FILTERS };
  let filterSheetOpen = false;
  function openFilterSheet(): void { filterSheetOpen = true; }
  function closeFilterSheet(): void { filterSheetOpen = false; }

  // ----- Share action state (same lifecycle as MaveroAddonDownload) -----
  let shareKey = '';
  let shareState: 'sharing' | 'shared' | 'failed' | '' = '';
  let shareTimer: ReturnType<typeof setTimeout> | undefined;

  // ----- Pixeldrain info state -----
  let pixeldrainInfoKey = '';

  // ----- Derived state -----
  $: activeTab = tabs.find((tab) => tab.extensionId === activeTabId) ?? null;
  $: activeLinks = visibleCloudStreamLinks(activeTab?.links ?? []);
  $: filteredLinks = filterCloudStreamLinks(activeLinks, filters);
  $: activeChips = activeCloudStreamChips(filters);
  $: anyFiltersActive = hasActiveCloudStreamFilters(filters);
  $: currentQualityOptions = cloudStreamQualityOptions(activeLinks);
  $: currentCodecOptions = cloudStreamCodecOptions(activeLinks);
  $: currentContainerOptions = cloudStreamContainerOptions(activeLinks);
  $: currentLanguageOptions = cloudStreamLanguageOptions(activeLinks);
  $: currentSizeOptions = cloudStreamSizeOptions(activeLinks);
  // Sections shown only when a real choice exists (>1 option beyond "All").
  $: showQualityFilter = currentQualityOptions.length > 2;
  $: showCodecFilter = currentCodecOptions.length > 2;
  $: showContainerFilter = currentContainerOptions.length > 2;
  $: showLanguageFilter = currentLanguageOptions.length > 2;
  $: showSizeFilter = currentSizeOptions.length > 2;
  $: episodeContext = cloudStreamEpisodeContext(media, season, episode);
  $: outcome = cloudStreamOutcomeSummary(tabs);
  // Batch-level terminal states (distinct from per-source partial failures):
  //   * every source failed          → one honest global message + Retry-all
  //   * every source came back empty → one honest global message + Retry-all
  // Mixed outcomes (some links + some failures) stay PARTIAL: the successful
  // sources keep rendering and each failed source shows its own message.
  $: batchAllFailed = tabs.length > 0 && outcome === 'all-failed';
  $: batchAllEmpty = tabs.length > 0
    && outcome === 'no-results'
    && tabs.every((tab) => tab.status === 'empty');

  // Presentation window / Show More (REUSED shared helpers).
  $: presentationResult = selectPresentationWindow(filteredLinks as PresentableStream[]);
  let visibleLinks: CloudStreamDownloadLinkView[] = [];
  let remainingLinks: CloudStreamDownloadLinkView[] = [];
  $: {
    presentationResult;
    visibleLinks = presentationResult.initial as CloudStreamDownloadLinkView[];
    remainingLinks = presentationResult.remaining as CloudStreamDownloadLinkView[];
  }

  function handleShowMore(): void {
    const next = showMoreBatch(visibleLinks, remainingLinks);
    visibleLinks = next.visible;
    remainingLinks = next.remaining;
  }

  function resetFilters(): void {
    filters = { ...NO_CS_FILTERS };
  }

  function clearAllFilters(): void {
    resetFilters();
  }

  function removeFilter(dimension: 'quality' | 'codec' | 'container' | 'language' | 'size'): void {
    filters = clearCloudStreamFilterDimension(filters, dimension);
  }

  // Switching sources is a PURE VIEW switch — the batch response already
  // holds every source's links (NO refetch on tab change). Stale filter
  // state is reset so it cannot hide all links on the new source.
  function selectTab(id: string): void {
    if (id !== activeTabId) resetFilters();
    activeTabId = id;
  }

  // ----- Transport / badge helpers (same visual language as the Stremio panel) -----
  function transportLabel(kind: CloudStreamDownloadLinkView['kind']): string {
    if (kind === 'external') return 'EXTERNAL · Page';
    const label = linkTypeLabel(kind as DownloadLinkType);
    const category = linkTypeCategory(kind as DownloadLinkType);
    return `${label} · ${category}`;
  }

  function kindIcon(kind: CloudStreamDownloadLinkView['kind']): typeof FileVideo {
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

  function kindLabel(kind: CloudStreamDownloadLinkView['kind']): string {
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

  function qualityBadgeClass(quality: string | undefined): string {
    switch (quality) {
      case '4K': return 'mcd-badge-quality mcd-badge-4k';
      case '1080p': return 'mcd-badge-quality mcd-badge-1080';
      case '720p': return 'mcd-badge-quality mcd-badge-720';
      case '480p': return 'mcd-badge-quality mcd-badge-480';
      default: return 'mcd-badge-quality mcd-badge-auto';
    }
  }

  function formatSize(bytes?: number): string | undefined {
    if (!bytes || bytes <= 0) return undefined;
    if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(bytes >= 10 * 1024 ** 3 ? 0 : 1)} GB`;
    if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`;
    return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  }

  function audioLabel(link: CloudStreamDownloadLinkView): string | undefined {
    const langs = link.audioLanguages;
    if (langs && langs.length > 0) {
      if (langs.length >= 3) return 'Multi';
      if (langs.length === 2) return 'Dual';
      return langs.slice(0, 3).join(',');
    }
    return undefined;
  }

  /** The card's primary scannable identity: filename, else the hosting server label. */
  function linkDetail(link: CloudStreamDownloadLinkView): string {
    const candidate = link.filename || link.sourceName;
    if (candidate && candidate.trim()) {
      const trimmed = candidate.trim();
      return trimmed.length > 120 ? `${trimmed.slice(0, 120)}…` : trimmed;
    }
    return `${kindLabel(link.kind)} · ${link.quality ?? 'Auto'}`;
  }

  function shareTitleFor(link: CloudStreamDownloadLinkView, sourceName: string): string {
    const fromLink = link.filename || link.sourceName;
    if (fromLink && fromLink.trim()) return fromLink.trim().slice(0, 120);
    return `${sourceName} · ${link.quality ?? 'Auto'}`;
  }

  function defaultTabId(list: CloudStreamSourceTab[]): string | null {
    if (!list.length) return null;
    return (list.find((tab) => tab.status === 'loaded' && tab.links.length > 0) ?? list[0]).extensionId;
  }

  function buildParams(): URLSearchParams {
    const params = new URLSearchParams({ contentId, mediaType, tmdbId });
    if (season !== undefined) params.set('season', String(season));
    if (episode !== undefined) params.set('episode', String(episode));
    return params;
  }

  // ----- Data flow -----

  async function loadTabs(): Promise<void> {
    tabsAbort?.abort();
    const abort = new AbortController();
    tabsAbort = abort;
    tabsLoading = true;
    tabsFailed = false;
    tabsEnvelope = null;
    try {
      const response = await fetch(`/api/downloader/mavero2/tabs?${buildParams().toString()}`, {
        headers: { accept: 'application/json' },
        signal: abort.signal,
      });
      if (abort.signal.aborted) return;
      const raw: unknown = await response.json().catch(() => null);
      const parsed = parseCloudStreamTabsPayload(raw);
      if (parsed.kind === 'error') {
        tabs = [];
        consideredExtensions = 0;
        tabsEnvelope = { code: parsed.code, ...(parsed.message !== undefined ? { message: parsed.message } : {}) };
        return;
      }
      tabs = cloudStreamTabsLoading(parsed.value.tabs);
      consideredExtensions = parsed.value.consideredExtensions;
      media = parsed.value.media;
      activeTabId = defaultTabId(tabs);
    } catch (error) {
      if (abort.signal.aborted) return;
      tabs = [];
      consideredExtensions = 0;
      activeTabId = null;
      tabsFailed = true;
      console.warn('[MaveroDownloader2] tabs fetch failed', error);
    } finally {
      if (!abort.signal.aborted) tabsLoading = false;
    }
  }

  /** ONE batch request resolves every eligible source (NO N+1 fan-out). */
  async function resolveAll(): Promise<void> {
    if (tabs.length === 0) return;
    resolveAbort?.abort();
    const abort = new AbortController();
    resolveAbort = abort;
    resolving = true;
    resolveEnvelope = null;
    try {
      const response = await fetch(`/api/downloader/mavero2?${buildParams().toString()}`, {
        headers: { accept: 'application/json' },
        signal: abort.signal,
      });
      if (abort.signal.aborted) return;
      const raw: unknown = await response.json().catch(() => null);
      const parsed = parseCloudStreamGroupsPayload(raw);
      if (parsed.kind === 'error') {
        // The tabs remain visible; the typed envelope drives the message.
        resolveEnvelope = { code: parsed.code, ...(parsed.message !== undefined ? { message: parsed.message } : {}) };
        return;
      }
      tabs = applyCloudStreamGroups(tabs, parsed.value.groups);
      if (parsed.value.media !== null) media = parsed.value.media;
      activeTabId = defaultTabId(tabs);
    } catch (error) {
      if (abort.signal.aborted) return;
      // Transport failure: mark every still-loading tab failed (NETWORK_ERROR)
      // so no tab is left stuck in a spinner — tabs/counts stay visible.
      tabs = tabs.map((tab) =>
        tab.status === 'loading'
          ? { ...tab, status: 'failed' as const, links: [], errorCode: 'NETWORK_ERROR' as const }
          : tab,
      );
      console.warn('[MaveroDownloader2] resolve failed', error);
    } finally {
      if (!abort.signal.aborted) resolving = false;
    }
  }

  /** Per-source retry — ONLY the failing extension is re-resolved. */
  async function retryExtension(tab: CloudStreamSourceTab): Promise<void> {
    if (tab.status === 'loading') return;
    retryAborts.get(tab.extensionId)?.abort();
    const abort = new AbortController();
    retryAborts.set(tab.extensionId, abort);
    tabs = tabs.map((candidate) =>
      candidate.extensionId === tab.extensionId
        ? { ...candidate, status: 'loading' as const, links: [], errorCode: undefined, errorMessage: undefined }
        : candidate,
    );
    const params = buildParams();
    params.set('extensionId', tab.extensionId);
    try {
      const response = await fetch(`/api/downloader/mavero2/extension?${params.toString()}`, {
        headers: { accept: 'application/json' },
        signal: abort.signal,
      });
      if (abort.signal.aborted) return;
      const raw: unknown = await response.json().catch(() => null);
      const parsed = parseCloudStreamExtensionPayload(raw);
      if (parsed.kind === 'error') {
        tabs = markCloudStreamTabFailed(tabs, tab.extensionId, parsed.code);
        return;
      }
      tabs = applyCloudStreamGroup(tabs, parsed.value.group);
    } catch (error) {
      if (abort.signal.aborted) return;
      tabs = markCloudStreamTabFailed(tabs, tab.extensionId, 'NETWORK_ERROR');
      console.warn('[MaveroDownloader2] extension retry failed', tab.extensionId, error);
    } finally {
      retryAborts.delete(tab.extensionId);
    }
  }

  async function load(): Promise<void> {
    await loadTabs();
    if (tabsAbort?.signal.aborted) return;
    if (tabs.length > 0 && tabsEnvelope === null) await resolveAll();
  }

  /** Full retry — tabs + batch (manual only; never automatic). */
  function retryAll(): void {
    if (tabsLoading || resolving) return;
    void load();
  }

  // ----- Share (the existing behavior — verbatim semantics) -----

  async function handleShare(link: CloudStreamDownloadLinkView, sourceName: string, key: string): Promise<void> {
    if (shareKey === key && shareState === 'sharing') return;
    const url = link.url; // the EXACT ORIGINAL URI (HTTP/HTTPS/magnet/P2P)
    if (!url) return;
    shareKey = key;
    shareState = 'sharing';
    if (shareTimer) clearTimeout(shareTimer);
    try {
      if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
        // Non-http(s) URIs (magnet:) go through the text field — the same
        // Phase 20 fix as the Stremio panel.
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

  function downloadAttr(link: CloudStreamDownloadLinkView) {
    return downloadActionFor(link as CapabilityStream);
  }
  function playAttr(link: CloudStreamDownloadLinkView) {
    return playActionFor(link as CapabilityStream, { android: typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent) });
  }

  onMount(load);

  onDestroy(() => {
    // Cancel every in-flight request so no response ever applies to a
    // destroyed panel (component swap during provider switching).
    tabsAbort?.abort();
    resolveAbort?.abort();
    for (const abort of retryAborts.values()) abort.abort();
    retryAborts.clear();
    if (shareTimer) clearTimeout(shareTimer);
  });
</script>

<div class="mcd" aria-busy={tabsLoading || resolving}>
  <!-- NO redundant heading — the parent sheet shows MAVERO / DOWNLOAD + the
       title. Series episodes get a compact context line (the CS-4 brief). -->
  <div class="mcd-instructions">
    <p>CloudStream sources — use Download, Play or Share on any link.</p>
    {#if episodeContext}
      <span class="mcd-context" title={episodeContext}>{episodeContext}</span>
    {/if}
  </div>

  {#if tabsLoading}
    <div class="mcd-state" role="status">
      <span class="mcd-spin"><Loader2 size={16} /></span>
      <span>Finding CloudStream sources…</span>
    </div>
    <div class="mcd-skeleton-list" aria-hidden="true">
      {#each Array(3) as _}
        <div class="mcd-skeleton-card">
          <div class="mcd-skeleton-kind"></div>
          <div class="mcd-skeleton-content">
            <div class="mcd-skeleton-line mcd-skeleton-line-wide"></div>
            <div class="mcd-skeleton-badges">
              <div class="mcd-skeleton-badge"></div>
              <div class="mcd-skeleton-badge"></div>
              <div class="mcd-skeleton-badge"></div>
            </div>
          </div>
          <div class="mcd-skeleton-action"></div>
        </div>
      {/each}
    </div>
  {:else if tabsFailed}
    <div class="mcd-state mcd-state-error" role="status">
      <AlertTriangle size={16} />
      <span>Couldn't load CloudStream sources.</span>
      <button type="button" class="mcd-retry" onclick={retryAll}><RotateCw size={11} /> Retry</button>
    </div>
  {:else if tabsEnvelope !== null}
    <!-- Typed envelope error (RATE_LIMITED / INVALID_REQUEST / INTERNAL_ERROR).
         RATE_LIMITED never auto-retries — manual Retry only. -->
    <div class="mcd-state mcd-state-error" role="status">
      <AlertTriangle size={16} />
      <span>{cloudStreamUserMessage(tabsEnvelope.code, tabsEnvelope.message)}</span>
      <button type="button" class="mcd-retry" onclick={retryAll}><RotateCw size={11} /> Retry</button>
    </div>
  {:else if tabs.length === 0}
    {#if consideredExtensions === 0}
      <!-- Empty state 1: nothing is enabled at all. -->
      <div class="mcd-state" role="status">
        <Info size={16} />
        <span>No CloudStream sources are enabled.</span>
      </div>
      <p class="mcd-hint">An administrator can enable them under System → Integrations → Extension.</p>
    {:else}
      <!-- Empty state 2: extensions exist, but none are compatible with this
           media type (tabs only lists ELIGIBLE sources). -->
      <div class="mcd-state" role="status">
        <Info size={16} />
        <span>No compatible CloudStream sources for this title.</span>
      </div>
    {/if}
  {:else}
    <!-- Source tabs — backend-driven (never hard-coded); counts come from the
         batch response (no extra provider requests). -->
    <div class="mcd-tabs" role="tablist" aria-label="CloudStream sources">
      {#each tabs as tab (tab.extensionId)}
        <button
          class="mcd-tab"
          class:active={tab.extensionId === activeTabId}
          type="button"
          role="tab"
          aria-selected={tab.extensionId === activeTabId}
          onclick={() => selectTab(tab.extensionId)}
        >
          <span class="mcd-tab-name">{tab.extensionName}</span>
          {#if tab.status === 'loading'}
            <span class="mcd-tab-state loading" role="status"><span class="mcd-tab-spin"><Loader2 size={9} /></span></span>
          {:else if tab.status === 'failed'}
            <span class="mcd-tab-state failed" role="status">Failed</span>
          {:else if tab.status === 'loaded' && tab.links.length > 0}
            <span class="mcd-tab-state ok" role="status">{visibleCloudStreamLinks(tab.links).length}</span>
          {:else}
            <span class="mcd-tab-state" role="status">0</span>
          {/if}
        </button>
      {/each}
    </div>

    {#if resolveEnvelope !== null}
      <!-- Typed envelope error from the batch resolve — tabs remain visible;
           the message + manual retry replace the card area. -->
      <div class="mcd-state mcd-state-error" role="status">
        <AlertTriangle size={16} />
        <span>{cloudStreamUserMessage(resolveEnvelope.code, resolveEnvelope.message)}</span>
        <button type="button" class="mcd-retry" onclick={retryAll}><RotateCw size={11} /> Retry</button>
      </div>
    {:else if batchAllFailed}
      <!-- Empty state 4: EVERY source failed — one honest global message +
           Retry-all (tabs stay visible with their Failed pills). -->
      <div class="mcd-state mcd-state-error" role="status">
        <AlertTriangle size={16} />
        <span>CloudStream sources could not be resolved right now.</span>
        <button type="button" class="mcd-retry" onclick={retryAll}><RotateCw size={11} /> Retry</button>
      </div>
    {:else if batchAllEmpty}
      <!-- Empty state 3: providers resolved but returned zero links. -->
      <div class="mcd-state" role="status">
        <Info size={16} />
        <span>No downloadable sources found.</span>
        <button type="button" class="mcd-retry" onclick={retryAll}><RotateCw size={11} /> Retry</button>
      </div>
    {:else}
      <!-- Compact filter bar — "N links + Filters". -->
      {#if activeTab && activeLinks.length > 0}
        <div class="mcd-filter-bar">
          <span class="mcd-filter-count">
            {#if filteredLinks.length === activeLinks.length}
              {activeLinks.length} links
            {:else}
              {filteredLinks.length} of {activeLinks.length}
            {/if}
          </span>
          <button type="button" class="mcd-filter-trigger" onclick={openFilterSheet} aria-label="Open filters" title="Open filters">
            <SlidersHorizontal size={13} />
            <span>Filters</span>
          </button>
        </div>
      {/if}

      <!-- Active filter chips + Clear (removable per dimension). -->
      {#if anyFiltersActive}
        <div class="mcd-active-filters" role="status" aria-label="Active filters">
          {#each activeChips as chip (chip.dimension)}
            <button
              class="mcd-active-chip"
              type="button"
              aria-label={`Remove ${chip.label} filter`}
              title={`Remove ${chip.label} filter`}
              onclick={() => removeFilter(chip.dimension)}
            >
              <span class="mcd-active-chip-label">{chip.label}</span>
              <X size={10} aria-hidden="true" />
            </button>
          {/each}
          <button
            class="mcd-clear"
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
        {#if activeTab.status === 'loading'}
          <div class="mcd-state" role="status">
            <span class="mcd-spin"><Loader2 size={16} /></span>
            <span>Resolving links from {activeTab.extensionName}…</span>
          </div>
          <div class="mcd-skeleton-list" aria-hidden="true">
            {#each Array(3) as _}
              <div class="mcd-skeleton-card">
                <div class="mcd-skeleton-kind"></div>
                <div class="mcd-skeleton-content">
                  <div class="mcd-skeleton-line mcd-skeleton-line-wide"></div>
                  <div class="mcd-skeleton-badges">
                    <div class="mcd-skeleton-badge"></div>
                    <div class="mcd-skeleton-badge"></div>
                    <div class="mcd-skeleton-badge"></div>
                  </div>
                </div>
                <div class="mcd-skeleton-action"></div>
              </div>
            {/each}
          </div>
        {:else if activeTab.status === 'failed'}
          <!-- Partial failure: ONLY this source failed — the others keep
               their results. User-readable message + per-source retry. -->
          <div class="mcd-state mcd-state-error" role="status">
            <AlertTriangle size={14} />
            <span>{cloudStreamUserMessage(activeTab.errorCode ?? 'INTERNAL_ERROR', activeTab.errorMessage)}</span>
            <button type="button" class="mcd-retry" onclick={() => void retryExtension(activeTab)}><RotateCw size={11} /> Retry</button>
          </div>
        {:else if activeLinks.length === 0}
          <div class="mcd-state" role="status">
            <Info size={14} />
            <span>No downloadable sources found for {activeTab.extensionName}.</span>
            <button type="button" class="mcd-retry" onclick={() => void retryExtension(activeTab)}><RotateCw size={11} /> Retry</button>
          </div>
        {:else if filteredLinks.length === 0}
          <!-- Filtered empty — distinct from a source failure: the source DID
               return links but the active filters match none. -->
          <div class="mcd-state mcd-state-filtered-empty" role="status">
            <SearchX size={14} aria-hidden="true" />
            <span>No sources match your filters.</span>
            {#if anyFiltersActive}
              <button type="button" class="mcd-retry" onclick={clearAllFilters}><RotateCw size={11} /> Clear filters</button>
            {/if}
          </div>
        {:else}
          <div class="mcd-list" role="list" aria-label={`${activeTab.extensionName} links`}>
            {#each visibleLinks as link, index (link.url + '-' + index)}
              {@const key = `${activeTab.extensionId}-${index}`}
              {@const KindIcon = kindIcon(link.kind)}
              {@const dlAction = downloadAttr(link)}
              {@const plAction = playAttr(link)}
              <article class="mcd-row" role="listitem" aria-label={`${linkDetail(link)} · ${transportLabel(link.kind)}`}>
                <div class="mcd-row-main">
                  <div class="mcd-row-header">
                    <span class="mcd-kind" title={kindLabel(link.kind)} aria-hidden="true">
                      <KindIcon size={13} />
                    </span>
                    <span class="mcd-row-detail">{linkDetail(link)}</span>
                    <span class="mcd-transport" title={transportLabel(link.kind)}>{transportLabel(link.kind)}</span>
                  </div>
                  <div class="mcd-row-badges">
                    <span class={qualityBadgeClass(link.quality)}>{link.quality ?? 'Auto'}</span>
                    {#if link.codec}<span class="mcd-badge mcd-badge-codec">{link.codec}</span>{/if}
                    {#if link.container}<span class="mcd-badge mcd-badge-container">{link.container}</span>{/if}
                    {#if audioLabel(link)}
                      <span class="mcd-badge mcd-badge-audio" title={link.audioLanguages?.length ? `Audio: ${link.audioLanguages.join(', ')}` : 'Audio'}>
                        <Volume2 size={10} aria-hidden="true" />
                        <span>{audioLabel(link)}</span>
                      </span>
                    {/if}
                    {#if formatSize(link.sizeBytes)}
                      <span class="mcd-badge mcd-badge-size" title="File size">
                        <HardDrive size={10} aria-hidden="true" />
                        <span>{formatSize(link.sizeBytes)}</span>
                      </span>
                    {/if}
                    {#if link.host}
                      <span class="mcd-badge mcd-badge-host" title={`Hosting server: ${link.host}`}>
                        <Server size={10} aria-hidden="true" />
                        <span>{link.host}</span>
                      </span>
                    {/if}
                  </div>
                </div>
                <!-- Capability-aware actions via the SINGLE shared model:
                     Download/Play appear only when the kind supports them;
                     Share is always available. The URL is the EXACT ORIGINAL
                     (no proxy, no rewrite). -->
                <div class="mcd-row-actions">
                  {#if dlAction}
                    {#if isPixeldrainUrl(link.url)}
                      <!-- Pixeldrain enforces Referer-based hotlink protection
                           on download endpoints — Info instead of a broken
                           Download button (the same Phase F pattern as the
                           Stremio panel). -->
                      <button
                        class="mcd-action mcd-action-info"
                        type="button"
                        aria-label="Download info"
                        title="Download can be done via external downloader only for this link."
                        onclick={(event) => { event.stopPropagation(); pixeldrainInfoKey = pixeldrainInfoKey === key ? '' : key; }}
                      >
                        <Info size={13} />
                      </button>
                    {:else if dlAction.flow === 'direct-download'}
                      <a
                        class="mcd-action mcd-action-download"
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
                        class="mcd-action mcd-action-download"
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
                          class="mcd-action mcd-action-download"
                          type="button"
                          aria-label="Open download page"
                          title="Open download page (embedded sheet)"
                          onclick={(event) => { event.stopPropagation(); onOpenInSheet(dlAction.href); }}
                        >
                          <Download size={13} />
                        </button>
                      {:else}
                        <a
                          class="mcd-action mcd-action-download"
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
                      class="mcd-action mcd-action-play"
                      href={plAction.href}
                      aria-label="Play in external player"
                      title="Play in external player"
                      onclick={(event) => event.stopPropagation()}
                    >
                      <Play size={13} />
                    </a>
                  {/if}
                  <button
                    class="mcd-action mcd-action-share"
                    class:done={shareKey === key && shareState === 'shared'}
                    class:failed={shareKey === key && shareState === 'failed'}
                    type="button"
                    aria-label={shareKey === key && shareState === 'shared' ? 'URI shared' : shareKey === key && shareState === 'failed' ? 'Share failed' : 'Share original URI'}
                    title="Share (original URI)"
                    onclick={(event) => { event.stopPropagation(); void handleShare(link, activeTab.extensionName, key); }}
                  >
                    {#if shareKey === key && shareState === 'sharing'}<Loader2 size={13} class="mcd-spin" />
                    {:else if shareKey === key && shareState === 'shared'}<Check size={13} />
                    {:else if shareKey === key && shareState === 'failed'}<AlertTriangle size={13} />
                    {:else}<Share2 size={13} />{/if}
                  </button>
                </div>
                {#if isPixeldrainUrl(link.url) && pixeldrainInfoKey === key}
                  <div class="mcd-pixeldrain-info" role="status">
                    Download can be done via external downloader only for this link.
                  </div>
                {/if}
              </article>
            {/each}
          </div>
          <!-- Show More + "Showing X of Y". -->
          {#if remainingLinks.length > 0}
            <div class="mcd-show-more">
              <span class="mcd-showing-count">Showing {visibleLinks.length} of {filteredLinks.length}</span>
              <button type="button" class="mcd-show-more-btn" onclick={handleShowMore} aria-label="Show more sources">
                Show more ({remainingLinks.length} remaining)
              </button>
            </div>
          {/if}
        {/if}
      {/if}
    {/if}
  {/if}
</div>

<!-- REUSED grouped filter sheet (the same primitive as the Stremio
     downloader — codec/container sections are CloudStream-specific). -->
<DownloaderFilterSheet
  open={filterSheetOpen}
  sections={[
    { dimension: 'quality', heading: 'QUALITY', options: currentQualityOptions, visible: showQualityFilter },
    { dimension: 'codec', heading: 'CODEC', options: currentCodecOptions, visible: showCodecFilter },
    { dimension: 'container', heading: 'CONTAINER', options: currentContainerOptions, visible: showContainerFilter },
    { dimension: 'language', heading: 'AUDIO', options: currentLanguageOptions, visible: showLanguageFilter },
    { dimension: 'size', heading: 'SIZE', options: currentSizeOptions, visible: showSizeFilter },
  ]}
  selected={{ quality: filters.quality, codec: filters.codec, container: filters.container, language: filters.language, size: filters.size }}
  onApply={(applied) => {
    filters = {
      quality: applied.quality || 'all',
      codec: applied.codec || 'all',
      container: applied.container || 'all',
      language: applied.language || 'all',
      size: (applied.size as CloudStreamFilters['size']) || 'all',
    };
  }}
  onClear={clearAllFilters}
  onClose={closeFilterSheet}
/>

<style>
  /* Same Mavero visual language as the Stremio downloader panel (dark
     cyberpunk surfaces, restrained accents, design tokens only). The mcd-*
     namespace keeps the two panels isolated while feeling native. */
  .mcd { display: flex; flex-direction: column; gap: 8px; min-height: 260px; color: var(--ink); }

  /* Instructions + episode context line. */
  .mcd-instructions { display: flex; flex-direction: row; align-items: center; justify-content: space-between; gap: 8px; padding: 6px 10px; border: 1px solid var(--line); border-left: 2px solid var(--accent); border-radius: var(--radius-sm); background: var(--color-surface); }
  .mcd-instructions p { margin: 0; color: var(--muted); font-size: 0.56rem; line-height: 1.4; flex: 1 1 auto; }
  .mcd-context { flex: 0 0 auto; border: 1px solid var(--color-secondary-soft); border-radius: 4px; background: var(--color-secondary-soft); color: var(--accent-2); padding: 1px 6px; font-size: 0.52rem; font-weight: 700; white-space: nowrap; }

  /* State messages. */
  .mcd-state { display: flex; min-height: 100px; flex: 1 1 auto; align-items: center; justify-content: center; gap: 8px; flex-wrap: wrap; padding: 12px; color: var(--muted); font-size: 0.68rem; text-align: center; }
  .mcd-state-error { color: var(--color-warning); }
  .mcd-retry { display: inline-flex; align-items: center; gap: 4px; border: 1px solid var(--line-strong); border-radius: 999px; background: var(--accent-soft); color: var(--ink); padding: 5px 12px; font: inherit; font-size: 0.62rem; font-weight: 700; cursor: pointer; transition: border-color var(--motion-fast) var(--ease-out); }
  .mcd-retry:hover { border-color: var(--accent); color: var(--accent); }
  .mcd-spin { display: grid; place-items: center; animation: mcd-spin 0.9s linear infinite; }
  .mcd-hint { margin: 0; color: var(--muted); font-size: 0.56rem; line-height: 1.5; text-align: center; }

  /* Active filter chips + Clear. */
  .mcd-active-filters { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; padding: 4px 6px; border-radius: var(--radius-sm); background: var(--accent-soft); }
  .mcd-active-chip { display: inline-flex; align-items: center; gap: 3px; border: 1px solid var(--accent); border-radius: 999px; background: var(--color-surface-elevated); color: var(--ink); padding: 3px 7px; font: inherit; font-size: 0.52rem; font-weight: 700; cursor: pointer; white-space: nowrap; transition: background var(--motion-fast) var(--ease-out); }
  .mcd-active-chip:hover { border-color: var(--accent); background: var(--accent); color: var(--color-bg); }
  .mcd-active-chip:focus-visible { outline: none; border-color: var(--accent); box-shadow: 0 0 0 2px var(--accent-soft); }
  .mcd-active-chip-label { line-height: 1.3; }
  .mcd-clear { display: inline-flex; align-items: center; border: 1px solid var(--line-strong); border-radius: 999px; background: transparent; color: var(--ink-soft); padding: 3px 10px; font: inherit; font-size: 0.52rem; font-weight: 700; cursor: pointer; white-space: nowrap; margin-left: auto; transition: border-color var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out); }
  .mcd-clear:hover { border-color: var(--accent); color: var(--accent); }
  .mcd-clear:focus-visible { outline: none; border-color: var(--accent); box-shadow: 0 0 0 2px var(--accent-soft); }
  .mcd-state-filtered-empty { color: var(--muted); }
  .mcd-state-filtered-empty .mcd-retry { margin-left: 4px; }

  /* Filter bar. */
  .mcd-filter-bar { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 4px 6px; }
  .mcd-filter-trigger { display: inline-flex; align-items: center; gap: 5px; border: 1px solid var(--line-strong); border-radius: 999px; background: var(--color-surface-elevated); color: var(--ink-soft); padding: 4px 10px; font: inherit; font-size: 0.56rem; font-weight: 700; cursor: pointer; white-space: nowrap; transition: border-color var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out); }
  .mcd-filter-trigger:hover, .mcd-filter-trigger:focus-visible { border-color: var(--accent); color: var(--accent); outline: none; }

  /* Transport label. */
  .mcd-transport { display: inline-flex; align-items: center; border: 1px solid var(--color-secondary-soft); border-radius: 4px; background: var(--color-secondary-soft); color: var(--accent-2); padding: 1px 5px; font-size: 0.48rem; font-weight: 700; white-space: nowrap; flex: 0 0 auto; }

  /* Show More. */
  .mcd-show-more { display: flex; flex-direction: column; align-items: center; gap: 4px; padding: 6px; }
  .mcd-showing-count { color: var(--muted); font-size: 0.52rem; font-weight: 600; }
  .mcd-show-more-btn { display: inline-flex; align-items: center; gap: 4px; border: 1px solid var(--line-strong); border-radius: 999px; background: var(--color-surface-elevated); color: var(--ink-soft); padding: 5px 14px; font: inherit; font-size: 0.56rem; font-weight: 700; cursor: pointer; transition: border-color var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out); }
  .mcd-show-more-btn:hover, .mcd-show-more-btn:focus-visible { border-color: var(--accent); color: var(--accent); outline: none; }

  /* Skeleton loading cards. */
  .mcd-skeleton-list { display: flex; flex-direction: column; gap: 5px; }
  .mcd-skeleton-card { display: flex; align-items: center; gap: 8px; border: 1px solid var(--line); border-radius: var(--radius-sm); background: var(--color-surface); padding: 8px 10px; }
  .mcd-skeleton-kind { width: 26px; height: 26px; border-radius: 6px; background: var(--color-surface-raised); flex: 0 0 auto; animation: mcd-skeleton-pulse 1.5s var(--ease-out) infinite; }
  .mcd-skeleton-content { flex: 1 1 auto; display: flex; flex-direction: column; gap: 4px; min-width: 0; }
  .mcd-skeleton-line { height: 10px; border-radius: 4px; background: var(--color-surface-raised); animation: mcd-skeleton-pulse 1.5s var(--ease-out) infinite; }
  .mcd-skeleton-line-wide { width: 80%; }
  .mcd-skeleton-badges { display: flex; gap: 4px; }
  .mcd-skeleton-badge { width: 40px; height: 14px; border-radius: 4px; background: var(--color-surface-raised); animation: mcd-skeleton-pulse 1.5s var(--ease-out) infinite; }
  .mcd-skeleton-action { width: 32px; height: 32px; border-radius: var(--radius-sm); background: var(--color-surface-raised); flex: 0 0 auto; animation: mcd-skeleton-pulse 1.5s var(--ease-out) infinite; }
  @keyframes mcd-skeleton-pulse { 0%, 100% { opacity: 0.4; } 50% { opacity: 0.8; } }

  /* Source tabs — horizontally scrollable pills (mobile-first). */
  .mcd-tabs { display: flex; gap: 5px; overflow-x: auto; padding-bottom: 2px; scrollbar-width: none; }
  .mcd-tabs::-webkit-scrollbar { display: none; }
  .mcd-tab { display: flex; flex: 0 0 auto; align-items: center; gap: 5px; border: 1px solid var(--line); border-radius: 999px; background: var(--color-surface-elevated); color: var(--ink-soft); padding: 5px 10px; font: inherit; font-size: 0.62rem; font-weight: 700; cursor: pointer; transition: border-color var(--motion-fast) var(--ease-out), background var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out); }
  .mcd-tab:hover { border-color: var(--line-strong); color: var(--ink); background: var(--color-surface-raised); }
  .mcd-tab:focus-visible { outline: none; border-color: var(--accent); box-shadow: 0 0 0 2px var(--accent-soft); }
  .mcd-tab.active { border-color: var(--accent); color: var(--ink); background: var(--accent-soft); }
  .mcd-tab-name { max-width: 120px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .mcd-tab-state { min-width: 16px; border-radius: 999px; background: var(--color-border-strong); color: var(--muted); padding: 1px 5px; font-size: 0.52rem; font-weight: 700; text-align: center; display: inline-flex; align-items: center; justify-content: center; }
  .mcd-tab-state.ok { color: var(--accent); }
  .mcd-tab-state.failed { color: var(--color-warning); }
  .mcd-tab-state.loading { background: transparent; padding: 1px 2px; }
  .mcd-tab-spin { display: grid; place-items: center; animation: mcd-spin 0.9s linear infinite; }
  .mcd-filter-count { color: var(--muted); font-size: 0.54rem; font-weight: 700; padding: 2px 4px; }

  /* Link list. */
  .mcd-list { display: flex; flex-direction: column; gap: 5px; flex: 1 1 auto; overflow-y: auto; scrollbar-width: thin; min-height: 0; }
  .mcd-list::-webkit-scrollbar { width: 3px; }
  .mcd-list::-webkit-scrollbar-thumb { background: var(--line-strong); border-radius: 2px; }

  /* Link cards. */
  .mcd-row { display: flex; align-items: center; gap: 8px; border: 1px solid var(--line); border-radius: var(--radius-sm); background: var(--color-surface); padding: 8px 10px; transition: border-color var(--motion-fast) var(--ease-out), background var(--motion-fast) var(--ease-out); }
  .mcd-row:hover { border-color: var(--line-strong); background: var(--color-surface-elevated); }
  .mcd-row:focus-within { border-color: var(--accent); box-shadow: var(--glow-primary); }
  .mcd-row-main { display: flex; flex: 1 1 auto; flex-direction: column; gap: 4px; min-width: 0; }
  .mcd-row-header { display: flex; align-items: center; gap: 6px; min-width: 0; }
  .mcd-kind { display: inline-flex; align-items: center; justify-content: center; width: 26px; height: 26px; border-radius: 6px; background: var(--accent-soft); color: var(--accent); flex: 0 0 auto; }
  .mcd-row-detail { display: -webkit-box; overflow: hidden; color: var(--ink); font-size: 0.62rem; font-weight: 650; word-break: break-word; -webkit-box-orient: vertical; -webkit-line-clamp: 1; line-clamp: 1; flex: 1 1 auto; min-width: 0; }

  /* Badges. */
  .mcd-row-badges { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; min-width: 0; }
  .mcd-badge { display: inline-flex; align-items: center; gap: 3px; border: 1px solid var(--line); border-radius: 4px; background: var(--color-surface-raised); color: var(--ink-soft); padding: 2px 6px; font-size: 0.52rem; font-weight: 700; line-height: 1.4; white-space: nowrap; }
  .mcd-badge :global(svg) { flex: 0 0 auto; opacity: 0.85; }
  .mcd-kind :global(svg) { flex: 0 0 auto; }
  .mcd-badge-quality { border-color: var(--accent-border); background: var(--accent-soft); color: var(--ink); }
  .mcd-badge-4k { color: var(--accent); }
  .mcd-badge-1080 { color: var(--ink); }
  .mcd-badge-720 { color: var(--ink-soft); }
  .mcd-badge-480 { color: var(--muted); }
  .mcd-badge-auto { color: var(--muted); }
  .mcd-badge-codec { color: var(--ink-soft); }
  .mcd-badge-container { color: var(--ink-soft); }
  .mcd-badge-audio { color: var(--ink-soft); }
  .mcd-badge-size { color: var(--ink); }
  .mcd-badge-host { color: var(--accent-2); max-width: 140px; overflow: hidden; text-overflow: ellipsis; border-color: var(--color-secondary-soft); }
  .mcd-badge-host span { overflow: hidden; text-overflow: ellipsis; }

  /* Action buttons — 32px touch targets. */
  .mcd-action { position: relative; display: grid; place-items: center; width: 32px; height: 32px; border: 1px solid var(--line); border-radius: var(--radius-sm); color: var(--ink-soft); background: var(--color-surface-raised); cursor: pointer; text-decoration: none; flex: 0 0 auto; transition: border-color var(--motion-fast) var(--ease-out), background var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out); }
  .mcd-action:hover, .mcd-action:focus-visible { border-color: var(--line-strong); background: var(--accent-soft); color: var(--ink); }
  .mcd-action:active { transform: scale(0.96); }
  .mcd-action.done { border-color: var(--accent); color: var(--accent); }
  .mcd-action.failed { border-color: var(--color-warning); color: var(--color-warning); }
  .mcd-action-share { color: var(--ink); }
  .mcd-action-download { color: var(--ink-soft); }
  .mcd-action-play { color: var(--ink-soft); }
  .mcd-action-info { color: var(--ink-soft); }
  .mcd-row-actions { display: flex; align-items: center; gap: 5px; flex: 0 0 auto; }

  /* Pixeldrain inline info. */
  .mcd-pixeldrain-info { padding: 6px 10px; margin-top: 4px; border: 1px solid var(--line); border-left: 2px solid var(--accent); border-radius: var(--radius-sm); background: var(--color-surface); color: var(--muted); font-size: 0.56rem; line-height: 1.4; }

  @keyframes mcd-spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .mcd-spin, .mcd-tab-spin { animation: none; } .mcd-action, .mcd-row, .mcd-tab { transition: none; } .mcd-skeleton-kind, .mcd-skeleton-line, .mcd-skeleton-badge, .mcd-skeleton-action { animation: none; opacity: 0.5; } }

  /* Responsive breakpoints (the same ladder as the Stremio panel). */
  @media (max-width: 360px) { .mcd-badge-host { display: none; } .mcd-action { width: 30px; height: 30px; } .mcd-instructions p { font-size: 0.52rem; } }
  @media (min-width: 700px) { .mcd { gap: 10px; } .mcd-tab { padding: 6px 12px; font-size: 0.66rem; } .mcd-row { padding: 10px 12px; gap: 10px; } .mcd-kind { width: 28px; height: 28px; } .mcd-row-detail { font-size: 0.66rem; } .mcd-badge { font-size: 0.56rem; padding: 3px 7px; } .mcd-action { width: 34px; height: 34px; } .mcd-list { gap: 6px; } }
  @media (min-width: 1024px) { .mcd { min-height: 320px; } .mcd-row:hover { box-shadow: var(--shadow-sm); } }
</style>
