<script lang="ts">
  import { onMount } from 'svelte';
  import { AlertTriangle, Download, Info, Loader2, RotateCw, Share2, Check } from 'lucide-svelte';
  import { downloadAttributesFor } from '$lib/client/player/stream-actions';

  /**
   * MAVERO Downloader — COMPLETE DISCOVERY surface (Phase 17).
   *
   * Rendered inside the EXISTING DownloadSheet (when the built-in
   * "Mavero Downloader" provider is selected) and on the standalone
   * /watch/mavero-downloader deep-link pages. One surface, two hosts.
   *
   * PHASE 17 CONTRACT (task §1–§16):
   *   * COMPLETE DISCOVERY: preserve EVERY stream the addon returned — HTTP,
   *     HTTPS, HLS, DASH, P2P, Magnet, External. NO max cap, NO format
   *     filter, NO quality filter, NO size filter. If Stremio shows 15,
   *     MAVERO shows 15.
   *   * Stream cards have EXACTLY TWO actions: Download + Share. No Watch,
   *     No Play, No Copy.
   *   * Download: UNCHANGED — navigates the ORIGINAL URI through the
   *     browser's anchor mechanism. No proxy, no FFmpeg, no rewrite.
   *   * Share: navigator.share() with the EXACT ORIGINAL URI (HTTP/HTTPS
   *     URL, magnet URI, or externalUrl). On Android this opens the native
   *     share sheet (mpv/VLC/1DM/WhatsApp/Telegram/etc).
   *   * HEADER: "MAVERO Downloader" + the content title. NO "Available links".
   *   * INSTRUCTIONS: two compact lines telling the user to use Share when
   *     Download fails, and to share to a player for direct streaming.
   *   * SUGGESTED APPS: 1DM (downloader) + MPV (player) cards, linking to
   *     their official Google Play Store pages.
   *   * ADDON CHIPS: horizontally scrollable, showing the RAW fetched count
   *     per addon (not the filtered count).
   *   * FOUR FILTERS: Type / Size / Quality / Language. Filters operate on
   *     ALREADY-LOADED streams — they NEVER trigger a refetch. The addon chip
   *     count stays the raw fetched count; the filtered count is shown
   *     separately as "All / X shown".
   *   * SHEET HEIGHT: increased ~10–15% to accommodate the new sections.
   *   * NO FOOTER: the old "Download and Share use the provider's original
   *     address…" footer is REMOVED.
   *
   * PROGRESSIVE FLOW (Phase 15, preserved):
   *   1. onMount: fetch the addon TAB list from `/api/downloader/mavero/tabs`
   *      (NO stream fetches — fast). Render every tab in `loading` state.
   *   2. For EACH tab: fire an INDEPENDENT fetch to
   *      `/api/downloader/mavero/addon?...&addon=<id>` with its OWN
   *      AbortController + lifecycle. Successful tabs update IN PLACE.
   *   3. The server does bounded retry/backoff for transient failures
   *      (30s per-attempt timeout — Task 13).
   *   4. A per-tab Retry button re-fires ONLY that tab's request.
   */

  export let contentId = '';
  export let mediaType: 'movie' | 'series' | 'anime' = 'movie';
  export let tmdbId = '';
  export let season: number | undefined = undefined;
  export let episode: number | undefined = undefined;
  export let title = '';

  /** Phase 17: the stream view now carries `kind` for the type filter. */
  type StreamView = {
    url: string;
    kind: 'http' | 'https' | 'hls' | 'dash' | 'p2p' | 'magnet' | 'external';
    quality: string;
    codec: string;
    audio: string;
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

  // Per-link action states.
  let openingKey = '';
  let openingTimer: ReturnType<typeof setTimeout> | undefined;
  let shareKey = '';
  let shareState: 'sharing' | 'shared' | 'failed' | '' = '';
  let shareTimer: ReturnType<typeof setTimeout> | undefined;

  // Phase 17 (task §12): FOUR filter controls.
  let filterType: 'all' | StreamView['kind'] = 'all';
  let filterSize: 'all' | 'under1' | 'under2' | 'under3' | 'under5' | 'under10' | 'under20' | 'over20' = 'all';
  let filterQuality: 'all' | '360p' | '480p' | '720p' | '1080p' | '2K' | '4K' = 'all';
  let filterLanguage: string = 'all'; // dynamically generated

  $: activeTab = tabs.find((tab) => tab.addonId === activeTabId) ?? null;

  // Phase 17 (task §13): filters operate on ALREADY-LOADED streams. The addon
  // chip count stays the raw fetched count; the filtered count is computed
  // per active tab.
  $: activeStreams = activeTab?.streams ?? [];
  $: filteredStreams = applyFilters(activeStreams, filterType, filterSize, filterQuality, filterLanguage);

  // Phase 17 (task §12 FILTER 4): dynamically generate the language list from
  // ALL loaded addon streams (union of every detected language).
  $: allLoadedStreams = tabs.flatMap((tab) => tab.streams);
  $: detectedLanguages = Array.from(new Set(allLoadedStreams.flatMap((s) => s.audioLanguages ?? []))).sort();

  function applyFilters(streams: StreamView[], fType: typeof filterType, fSize: typeof filterSize, fQuality: typeof filterQuality, fLang: string): StreamView[] {
    return streams.filter((stream) => {
      // Type filter
      if (fType !== 'all' && stream.kind !== fType) return false;
      // Size filter
      if (fSize !== 'all') {
        const bytes = stream.sizeBytes;
        if (bytes === undefined) {
          // Unknown size — keep under 'all' only. For specific size filters,
          // exclude (we can't confirm the size matches).
          return false;
        }
        const gb = bytes / 1024 ** 3;
        if (fSize === 'under1' && gb >= 1) return false;
        if (fSize === 'under2' && gb >= 2) return false;
        if (fSize === 'under3' && gb >= 3) return false;
        if (fSize === 'under5' && gb >= 5) return false;
        if (fSize === 'under10' && gb >= 10) return false;
        if (fSize === 'under20' && gb >= 20) return false;
        if (fSize === 'over20' && gb < 20) return false;
      }
      // Quality filter
      if (fQuality !== 'all') {
        const q = stream.quality;
        if (fQuality === '2K') {
          // 2K = 1440p
          if (q !== '4K' && !(q === 'auto')) return false;
          // Actually 2K is between 1080p and 4K. Treat '4K' bucket as 2K+4K.
          // For simplicity, map 2K → any quality >= 1440p (the 4K bucket).
          if (q !== '4K') return false;
        } else if (q !== fQuality) {
          return false;
        }
      }
      // Language filter
      if (fLang !== 'all') {
        const langs = stream.audioLanguages ?? [];
        if (!langs.includes(fLang)) return false;
      }
      return true;
    });
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

  function streamDetail(stream: StreamView): string | undefined {
    const candidate = stream.filename || stream.title || stream.name;
    if (candidate && candidate.trim()) {
      const trimmed = candidate.trim();
      return trimmed.length > 140 ? `${trimmed.slice(0, 140)}…` : trimmed;
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

  function selectTab(id: string): void {
    activeTabId = id;
  }

  function handleDownload(event: MouseEvent, key: string) {
    event.stopPropagation();
    if (openingKey) return;
    openingKey = key;
    if (openingTimer) clearTimeout(openingTimer);
    openingTimer = setTimeout(() => { openingKey = ''; }, 2500);
  }

  async function handleShare(stream: StreamView, addonName: string, key: string): Promise<void> {
    if (shareKey === key && shareState === 'sharing') return;
    const url = stream.url; // the EXACT ORIGINAL URI (HTTP/HTTPS/magnet/external)
    if (!url) return;
    shareKey = key;
    shareState = 'sharing';
    if (shareTimer) clearTimeout(shareTimer);
    try {
      if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
        await navigator.share({ title: shareTitle(stream, addonName), url });
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

  onMount(load);
</script>

<div class="mad" aria-busy={tabsLoading}>
  <!-- Phase 17 (task §9): header — "MAVERO Downloader" + content title. NO "Available links". -->
  <div class="mad-header">
    <span class="mad-eyebrow">MAVERO Downloader</span>
    {#if title}<span class="mad-title">{title}</span>{/if}
  </div>

  <!-- Phase 17 (task §9): two instructional lines. -->
  <div class="mad-instructions">
    <p>If download button not work then use share button to download with download manager.</p>
    <p>Use share button and share stream to player to stream directly on phone.</p>
  </div>

  <!-- Phase 17 (task §10): Suggested Apps — 1DM + MPV, linking to Play Store. -->
  <div class="mad-suggested">
    <div class="mad-suggested-label">Suggested Downloader</div>
    <a class="mad-app-card" href="https://play.google.com/store/apps/details?id=idm.internet.download.manager" target="_blank" rel="noopener noreferrer">
      <div class="mad-app-icon mad-app-icon-1dm">1DM</div>
      <div class="mad-app-info">
        <span class="mad-app-name">1DM+</span>
        <span class="mad-app-desc">Download manager</span>
      </div>
    </a>
    <div class="mad-suggested-label mad-suggested-label-player">Suggested Player</div>
    <a class="mad-app-card" href="https://play.google.com/store/apps/details?id=is.xyz.mpv" target="_blank" rel="noopener noreferrer">
      <div class="mad-app-icon mad-app-icon-mpv">MPV</div>
      <div class="mad-app-info">
        <span class="mad-app-name">mpv-android</span>
        <span class="mad-app-desc">Media player</span>
      </div>
    </a>
  </div>

  {#if tabsLoading}
    <div class="mad-state" role="status"><span class="mad-spin"><Loader2 size={18} /></span><span>Finding addons…</span></div>
  {:else if tabsFailed}
    <div class="mad-state mad-state-error" role="status">
      <AlertTriangle size={18} />
      <span>Couldn't load addon tabs.</span>
      <button type="button" class="mad-retry" onclick={retryAll}><RotateCw size={12} /> Retry</button>
    </div>
  {:else if tabs.length === 0}
    <div class="mad-state" role="status"><Info size={18} /><span>No Stremio addons are enabled. Enable addons to see direct links here.</span></div>
  {:else}
    <!-- Phase 17 (task §11): addon chips — RAW fetched count, horizontally scrollable. -->
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
            <span class="mad-tab-state loading" role="status"><span class="mad-tab-spin"><Loader2 size={10} /></span></span>
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

    {#if activeTab}
      <!-- Phase 17 (task §12): FOUR filter controls — Type / Size / Quality / Language. -->
      <div class="mad-filters">
        <select class="mad-filter" bind:value={filterType} aria-label="Filter by type">
          <option value="all">All Types</option>
          <option value="http">HTTP</option>
          <option value="https">HTTPS</option>
          <option value="hls">HLS</option>
          <option value="dash">DASH</option>
          <option value="p2p">P2P</option>
          <option value="magnet">Magnet</option>
          <option value="external">External</option>
        </select>
        <select class="mad-filter" bind:value={filterSize} aria-label="Filter by size">
          <option value="all">All Sizes</option>
          <option value="under1">Under 1 GB</option>
          <option value="under2">Under 2 GB</option>
          <option value="under3">Under 3 GB</option>
          <option value="under5">Under 5 GB</option>
          <option value="under10">Under 10 GB</option>
          <option value="under20">Under 20 GB</option>
          <option value="over20">Over 20 GB</option>
        </select>
        <select class="mad-filter" bind:value={filterQuality} aria-label="Filter by quality">
          <option value="all">All Qualities</option>
          <option value="360p">360p</option>
          <option value="480p">480p</option>
          <option value="720p">720p</option>
          <option value="1080p">1080p</option>
          <option value="2K">2K</option>
          <option value="4K">4K</option>
        </select>
        <select class="mad-filter" bind:value={filterLanguage} aria-label="Filter by language">
          <option value="all">All Languages</option>
          {#each detectedLanguages as lang}
            <option value={lang}>{lang}</option>
          {/each}
        </select>
      </div>

      {#if activeTab.status === 'loading' || activeTab.status === 'retrying'}
        <div class="mad-state" role="status">
          <span class="mad-spin"><Loader2 size={18} /></span>
          <span>{activeTab.status === 'retrying' ? 'Trying again…' : `Finding links from ${activeTab.addonName}…`}</span>
        </div>
      {:else if activeTab.status === 'unavailable'}
        <div class="mad-state mad-state-error" role="status">
          <AlertTriangle size={16} />
          <span>{activeTab.addonName} is unavailable right now.</span>
          <button type="button" class="mad-retry" onclick={() => retryTab(activeTab)}><RotateCw size={12} /> Retry</button>
        </div>
      {:else if activeStreams.length === 0}
        <div class="mad-state" role="status">
          <Info size={16} />
          <span>{activeTab.addonName} returned zero streams.</span>
          <button type="button" class="mad-retry" onclick={() => retryTab(activeTab)}><RotateCw size={12} /> Retry</button>
        </div>
      {:else}
        <!-- Phase 17 (task §13): "All / X shown" — the filtered count is shown separately. -->
        <div class="mad-filter-count">
          {#if filteredStreams.length === activeStreams.length}
            All {activeStreams.length} shown
          {:else}
            {activeStreams.length} total · {filteredStreams.length} shown
          {/if}
        </div>
        <div class="mad-list" role="list" aria-label={`${activeTab.addonName} streams`}>
          {#each filteredStreams as stream, index (stream.url + '-' + index)}
            {@const key = `${activeTab.addonSlug}-${index}`}
            <article class="mad-row" role="listitem">
              <div class="mad-row-main">
                <span class="mad-row-label">{streamLabel(stream)}</span>
                {#if streamDetail(stream)}<span class="mad-row-detail">{streamDetail(stream)}</span>{/if}
                {#if stream.audioLanguages?.length}<span class="mad-row-sub">{stream.audioLanguages.join(' + ')} audio</span>{/if}
              </div>
              <div class="mad-row-actions">
                <!-- Download — UNCHANGED. Navigates the ORIGINAL URI. -->
                <a
                  class="mad-action"
                  class:opening={openingKey === key}
                  href={stream.url}
                  download={downloadAttributesFor({ url: stream.url, filename: stream.filename })?.download ?? 'stream'}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={openingKey === key ? 'Opening the original file' : 'Download the original file'}
                  title="Download (original URI)"
                  onclick={(event) => handleDownload(event, key)}
                ><Download size={14} /></a>
                <!-- Share — navigator.share with the EXACT ORIGINAL URI. -->
                <button
                  class="mad-action mad-action-share"
                  class:done={shareKey === key && shareState === 'shared'}
                  class:failed={shareKey === key && shareState === 'failed'}
                  type="button"
                  aria-label={shareKey === key && shareState === 'shared' ? 'URI shared' : shareKey === key && shareState === 'failed' ? 'Share failed' : 'Share original URI'}
                  title="Share (original URI)"
                  onclick={(event) => { event.stopPropagation(); void handleShare(stream, activeTab.addonName, key); }}
                >
                  {#if shareKey === key && shareState === 'sharing'}<Loader2 size={14} class="mad-spin" />
                  {:else if shareKey === key && shareState === 'shared'}<Check size={14} />
                  {:else if shareKey === key && shareState === 'failed'}<AlertTriangle size={14} />
                  {:else}<Share2 size={14} />{/if}
                </button>
              </div>
            </article>
          {/each}
        </div>
      {/if}
    {/if}
  {/if}
</div>

<style>
  /* Phase 17 (task §15): sheet height increased ~10-15% to accommodate the
     new sections (header, instructions, suggested apps, filters). */
  .mad { display: flex; flex-direction: column; gap: 8px; min-height: 260px; color: var(--ink); }
  .mad-header { display: flex; flex-direction: column; gap: 2px; }
  .mad-eyebrow { color: var(--muted); font-size: 0.55rem; font-weight: 800; letter-spacing: 0.14em; text-transform: uppercase; }
  .mad-title { overflow: hidden; color: var(--ink); font-size: 0.85rem; font-weight: 800; text-overflow: ellipsis; white-space: nowrap; }
  .mad-instructions { display: flex; flex-direction: column; gap: 2px; padding: 6px 8px; border: 1px solid var(--line); border-radius: var(--radius-sm); background: rgba(255, 255, 255, 0.02); }
  .mad-instructions p { margin: 0; color: var(--muted); font-size: 0.56rem; line-height: 1.4; }
  .mad-suggested { display: flex; flex-direction: column; gap: 4px; }
  .mad-suggested-label { color: var(--muted); font-size: 0.5rem; font-weight: 800; letter-spacing: 0.12em; text-transform: uppercase; }
  .mad-suggested-label-player { margin-top: 4px; }
  .mad-app-card { display: flex; align-items: center; gap: 8px; padding: 6px 8px; border: 1px solid var(--line); border-radius: var(--radius-sm); background: rgba(255, 255, 255, 0.02); text-decoration: none; }
  .mad-app-card:hover { border-color: var(--line-strong); background: var(--accent-soft); }
  .mad-app-icon { display: grid; place-items: center; width: 32px; height: 32px; border-radius: 6px; font-size: 0.6rem; font-weight: 800; color: #fff; }
  .mad-app-icon-1dm { background: #0c8; }
  .mad-app-icon-mpv { background: #66c; }
  .mad-app-info { display: flex; flex-direction: column; gap: 1px; }
  .mad-app-name { color: var(--ink); font-size: 0.66rem; font-weight: 700; }
  .mad-app-desc { color: var(--muted); font-size: 0.52rem; }
  .mad-state { display: flex; min-height: 120px; flex: 1 1 auto; align-items: center; justify-content: center; gap: 9px; flex-wrap: wrap; padding: 10px; color: var(--muted); font-size: 0.7rem; text-align: center; }
  .mad-state-error { color: #d48a64; }
  .mad-retry { display: inline-flex; align-items: center; gap: 5px; border: 1px solid var(--line-strong); border-radius: 999px; background: var(--accent-soft); color: var(--ink); padding: 6px 12px; font: inherit; font-size: 0.66rem; font-weight: 700; cursor: pointer; }
  .mad-retry:hover { border-color: var(--accent); color: var(--accent); }
  .mad-spin { display: grid; place-items: center; animation: mad-spin 0.9s linear infinite; }
  .mad-tabs { display: flex; gap: 6px; overflow-x: auto; padding-bottom: 2px; scrollbar-width: none; }
  .mad-tabs::-webkit-scrollbar { display: none; }
  .mad-tab { display: flex; flex: 0 0 auto; align-items: center; gap: 6px; border: 1px solid var(--line); border-radius: 999px; background: rgba(255, 255, 255, 0.02); color: var(--ink-soft); padding: 6px 11px; font: inherit; font-size: 0.66rem; font-weight: 700; cursor: pointer; }
  .mad-tab:hover { border-color: var(--line-strong); color: var(--ink); }
  .mad-tab.active { border-color: var(--accent); color: var(--ink); background: var(--accent-soft); }
  .mad-tab-name { max-width: 130px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .mad-tab-state { min-width: 18px; border-radius: 999px; background: rgba(255, 255, 255, 0.07); color: var(--muted); padding: 1px 6px; font-size: 0.55rem; font-weight: 700; text-align: center; display: inline-flex; align-items: center; justify-content: center; }
  .mad-tab-state.ok { color: var(--accent); }
  .mad-tab-state.failed { color: #d48a64; }
  .mad-tab-state.loading { background: transparent; padding: 1px 2px; }
  .mad-tab-spin { display: grid; place-items: center; animation: mad-spin 0.9s linear infinite; }
  .mad-filters { display: grid; grid-template-columns: repeat(2, 1fr); gap: 4px; }
  .mad-filter { width: 100%; border: 1px solid var(--line); border-radius: var(--radius-sm); background: rgba(255, 255, 255, 0.02); color: var(--ink); padding: 5px 6px; font: inherit; font-size: 0.58rem; font-weight: 600; cursor: pointer; }
  .mad-filter:hover { border-color: var(--line-strong); }
  .mad-filter:focus-visible { border-color: var(--accent); outline: none; }
  .mad-filter-count { color: var(--muted); font-size: 0.55rem; font-weight: 700; padding: 0 2px; }
  .mad-list { display: flex; flex-direction: column; gap: 6px; max-height: 320px; overflow-y: auto; scrollbar-width: thin; }
  .mad-list::-webkit-scrollbar { width: 4px; }
  .mad-list::-webkit-scrollbar-thumb { background: var(--line-strong); border-radius: 2px; }
  .mad-row { display: flex; align-items: center; gap: 8px; border: 1px solid var(--line); border-radius: var(--radius-sm); background: rgba(255, 255, 255, 0.025); padding: 9px 10px; }
  .mad-row-main { display: flex; flex: 1 1 auto; flex-direction: column; gap: 3px; min-width: 0; }
  .mad-row-label { overflow: hidden; color: var(--ink); font-size: 0.68rem; font-weight: 750; text-overflow: ellipsis; white-space: nowrap; }
  .mad-row-detail { display: -webkit-box; overflow: hidden; color: var(--muted); font-size: 0.57rem; word-break: break-word; -webkit-box-orient: vertical; -webkit-line-clamp: 2; line-clamp: 2; }
  .mad-row-sub { color: var(--muted); font-size: 0.55rem; }
  .mad-row-actions { display: flex; flex: 0 0 auto; align-items: center; gap: 5px; }
  .mad-action { position: relative; display: grid; place-items: center; width: 36px; height: 36px; border: 1px solid var(--line); border-radius: var(--radius-sm); color: var(--ink-soft); background: rgba(255, 255, 255, 0.03); cursor: pointer; text-decoration: none; }
  .mad-action:hover, .mad-action:focus-visible { border-color: var(--line-strong); background: var(--accent-soft); color: var(--ink); }
  .mad-action:active { transform: scale(0.96); }
  .mad-action.done { border-color: var(--accent); color: var(--accent); }
  .mad-action.failed { border-color: #d48a64; color: #d48a64; }
  .mad-action.opening { border-color: var(--accent); color: var(--accent); opacity: 0.7; pointer-events: none; }
  .mad-action-share { color: var(--ink); }
  @keyframes mad-spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .mad-spin, .mad-tab-spin { animation: none; } .mad-action { transition: none; } }
</style>
