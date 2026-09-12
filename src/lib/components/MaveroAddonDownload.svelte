<script lang="ts">
  import { onMount } from 'svelte';
  import { AlertTriangle, Info, Loader2, RotateCw, Share2, Check } from 'lucide-svelte';

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

  // Share action state.
  let shareKey = '';
  let shareState: 'sharing' | 'shared' | 'failed' | '' = '';
  let shareTimer: ReturnType<typeof setTimeout> | undefined;

  // Phase 18 (task §4/§12): FOUR filter controls.
  // Phase 18 (task §5): Type filter does NOT include "External".
  let filterType: 'all' | StreamView['kind'] = 'all';
  let filterSize: 'all' | 'under1' | 'under2' | 'under3' | 'under5' | 'under10' | 'under20' | 'over20' = 'all';
  let filterQuality: 'all' | '360p' | '480p' | '720p' | '1080p' | '2K' | '4K' = 'all';
  let filterLanguage: string = 'all';

  $: activeTab = tabs.find((tab) => tab.addonId === activeTabId) ?? null;
  $: activeStreams = activeTab?.streams ?? [];
  $: filteredStreams = applyFilters(activeStreams, filterType, filterSize, filterQuality, filterLanguage);

  // Phase 18 (task §12 FILTER 4): dynamically generate the language list.
  $: allLoadedStreams = tabs.flatMap((tab) => tab.streams);
  $: detectedLanguages = Array.from(new Set(allLoadedStreams.flatMap((s) => s.audioLanguages ?? []))).sort();

  function applyFilters(streams: StreamView[], fType: typeof filterType, fSize: typeof filterSize, fQuality: typeof filterQuality, fLang: string): StreamView[] {
    return streams.filter((stream) => {
      if (fType !== 'all' && stream.kind !== fType) return false;
      if (fSize !== 'all') {
        const bytes = stream.sizeBytes;
        if (bytes === undefined) return false;
        const gb = bytes / 1024 ** 3;
        if (fSize === 'under1' && gb >= 1) return false;
        if (fSize === 'under2' && gb >= 2) return false;
        if (fSize === 'under3' && gb >= 3) return false;
        if (fSize === 'under5' && gb >= 5) return false;
        if (fSize === 'under10' && gb >= 10) return false;
        if (fSize === 'under20' && gb >= 20) return false;
        if (fSize === 'over20' && gb < 20) return false;
      }
      if (fQuality !== 'all') {
        const q = stream.quality;
        if (fQuality === '2K') {
          if (q !== '4K') return false;
        } else if (q !== fQuality) {
          return false;
        }
      }
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

  function selectTab(id: string): void {
    activeTabId = id;
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
  <!-- Phase 18 (task §1): NO redundant heading. The parent DownloadSheet
       already shows "MAVERO / DOWNLOAD" + the movie title. -->

  <!-- Phase 18 (task §2): compact 2-line instruction block. -->
  <div class="mad-instructions">
    <p>Share the link to download manager to download</p>
    <p>Share the link to stream supported player to Play.</p>
  </div>

  <!-- Phase 18 (task §3): suggested apps in ONE compact horizontal row. -->
  <!-- Phase 19 (task §10): labels updated to "1DM+ Downloader" + "MPV Player". -->
  <div class="mad-apps">
    <a class="mad-app" href="https://play.google.com/store/apps/details?id=idm.internet.download.manager" target="_blank" rel="noopener noreferrer" aria-label="1DM+ Downloader on Google Play">
      <span class="mad-app-icon mad-app-icon-1dm">1DM</span>
      <span class="mad-app-name">1DM+ Downloader</span>
    </a>
    <a class="mad-app" href="https://play.google.com/store/apps/details?id=is.xyz.mpv" target="_blank" rel="noopener noreferrer" aria-label="MPV Player on Google Play">
      <span class="mad-app-icon mad-app-icon-mpv">MPV</span>
      <span class="mad-app-name">MPV Player</span>
    </a>
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
    <!-- Phase 18 (task §4): FILTER ROW — one horizontally scrollable row,
         ABOVE the addon chips. Order: Type · Size · Quality · Language. -->
    <div class="mad-filters">
      <select class="mad-filter" bind:value={filterType} aria-label="Filter by type">
        <option value="all">Type</option>
        <option value="http">HTTP</option>
        <option value="https">HTTPS</option>
        <option value="hls">HLS</option>
        <option value="dash">DASH</option>
        <option value="p2p">P2P</option>
        <option value="magnet">Magnet</option>
      </select>
      <select class="mad-filter" bind:value={filterSize} aria-label="Filter by size">
        <option value="all">Size</option>
        <option value="under1">&lt; 1 GB</option>
        <option value="under2">&lt; 2 GB</option>
        <option value="under3">&lt; 3 GB</option>
        <option value="under5">&lt; 5 GB</option>
        <option value="under10">&lt; 10 GB</option>
        <option value="under20">&lt; 20 GB</option>
        <option value="over20">&gt; 20 GB</option>
      </select>
      <select class="mad-filter" bind:value={filterQuality} aria-label="Filter by quality">
        <option value="all">Quality</option>
        <option value="360p">360p</option>
        <option value="480p">480p</option>
        <option value="720p">720p</option>
        <option value="1080p">1080p</option>
        <option value="2K">2K</option>
        <option value="4K">4K</option>
      </select>
      <select class="mad-filter" bind:value={filterLanguage} aria-label="Filter by language">
        <option value="all">Language</option>
        {#each detectedLanguages as lang}
          <option value={lang}>{lang}</option>
        {/each}
      </select>
    </div>

    <!-- Phase 18 (task §4): addon chips come AFTER the filter row. -->
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
      {:else}
        <!-- Phase 18 (task §13): "X shown" indicator. -->
        <div class="mad-filter-count">
          {#if filteredStreams.length === activeStreams.length}
            {activeStreams.length} links
          {:else}
            {filteredStreams.length} of {activeStreams.length}
          {/if}
        </div>
        <div class="mad-list" role="list" aria-label={`${activeTab.addonName} streams`}>
          {#each filteredStreams as stream, index (stream.url + '-' + index)}
            {@const key = `${activeTab.addonSlug}-${index}`}
            <article class="mad-row" role="listitem">
              <div class="mad-row-main">
                <span class="mad-row-label">{streamLabel(stream)}</span>
                {#if streamDetail(stream)}<span class="mad-row-detail">{streamDetail(stream)}</span>{/if}
              </div>
              <!-- Phase 18 (task §7): ONLY Share. No Download button. -->
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
            </article>
          {/each}
        </div>
      {/if}
    {/if}
  {/if}
</div>

<style>
  /* Phase 18 (task §15): MAXIMIZE stream area. Compact everything else. */
  .mad { display: flex; flex-direction: column; gap: 6px; min-height: 260px; color: var(--ink); }
  .mad-instructions { display: flex; flex-direction: column; gap: 1px; padding: 4px 6px; border: 1px solid var(--line); border-radius: var(--radius-sm); background: rgba(255, 255, 255, 0.02); }
  .mad-instructions p { margin: 0; color: var(--muted); font-size: 0.54rem; line-height: 1.35; }
  /* Phase 18 (task §3): ONE compact horizontal row for suggested apps. */
  .mad-apps { display: flex; gap: 6px; }
  .mad-app { display: flex; align-items: center; gap: 5px; padding: 4px 7px; border: 1px solid var(--line); border-radius: var(--radius-sm); background: rgba(255, 255, 255, 0.02); text-decoration: none; flex: 1 1 0; min-width: 0; }
  .mad-app:hover { border-color: var(--line-strong); background: var(--accent-soft); }
  .mad-app-icon { display: grid; place-items: center; width: 20px; height: 20px; border-radius: 4px; font-size: 0.5rem; font-weight: 800; color: #fff; flex: 0 0 auto; }
  .mad-app-icon-1dm { background: #0c8; }
  .mad-app-icon-mpv { background: #66c; }
  .mad-app-name { color: var(--ink); font-size: 0.6rem; font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .mad-state { display: flex; min-height: 100px; flex: 1 1 auto; align-items: center; justify-content: center; gap: 8px; flex-wrap: wrap; padding: 8px; color: var(--muted); font-size: 0.66rem; text-align: center; }
  .mad-state-error { color: #d48a64; }
  .mad-retry { display: inline-flex; align-items: center; gap: 4px; border: 1px solid var(--line-strong); border-radius: 999px; background: var(--accent-soft); color: var(--ink); padding: 4px 10px; font: inherit; font-size: 0.62rem; font-weight: 700; cursor: pointer; }
  .mad-retry:hover { border-color: var(--accent); color: var(--accent); }
  .mad-spin { display: grid; place-items: center; animation: mad-spin 0.9s linear infinite; }
  /* Phase 19 (task §11): filter row occupies the FULL available width.
     The four filters use flex: 1 so they distribute evenly — no blank right-side area. */
  .mad-filters { display: flex; gap: 4px; width: 100%; }
  .mad-filter { flex: 1 1 0; min-width: 0; border: 1px solid var(--line); border-radius: var(--radius-sm); background: rgba(255, 255, 255, 0.02); color: var(--ink); padding: 4px 4px; font: inherit; font-size: 0.56rem; font-weight: 600; cursor: pointer; text-align: center; }
  .mad-filter:hover { border-color: var(--line-strong); }
  .mad-filter:focus-visible { border-color: var(--accent); outline: none; }
  .mad-tabs { display: flex; gap: 5px; overflow-x: auto; padding-bottom: 1px; scrollbar-width: none; }
  .mad-tabs::-webkit-scrollbar { display: none; }
  .mad-tab { display: flex; flex: 0 0 auto; align-items: center; gap: 5px; border: 1px solid var(--line); border-radius: 999px; background: rgba(255, 255, 255, 0.02); color: var(--ink-soft); padding: 4px 9px; font: inherit; font-size: 0.62rem; font-weight: 700; cursor: pointer; }
  .mad-tab:hover { border-color: var(--line-strong); color: var(--ink); }
  .mad-tab.active { border-color: var(--accent); color: var(--ink); background: var(--accent-soft); }
  .mad-tab-name { max-width: 120px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .mad-tab-state { min-width: 16px; border-radius: 999px; background: rgba(255, 255, 255, 0.07); color: var(--muted); padding: 1px 5px; font-size: 0.52rem; font-weight: 700; text-align: center; display: inline-flex; align-items: center; justify-content: center; }
  .mad-tab-state.ok { color: var(--accent); }
  .mad-tab-state.failed { color: #d48a64; }
  .mad-tab-state.loading { background: transparent; padding: 1px 2px; }
  .mad-tab-spin { display: grid; place-items: center; animation: mad-spin 0.9s linear infinite; }
  .mad-filter-count { color: var(--muted); font-size: 0.52rem; font-weight: 700; padding: 0 1px; }
  /* Phase 18 (task §15): stream list gets MAXIMUM vertical space. */
  .mad-list { display: flex; flex-direction: column; gap: 4px; flex: 1 1 auto; overflow-y: auto; scrollbar-width: thin; min-height: 0; }
  .mad-list::-webkit-scrollbar { width: 3px; }
  .mad-list::-webkit-scrollbar-thumb { background: var(--line-strong); border-radius: 2px; }
  .mad-row { display: flex; align-items: center; gap: 6px; border: 1px solid var(--line); border-radius: var(--radius-sm); background: rgba(255, 255, 255, 0.025); padding: 6px 8px; }
  .mad-row-main { display: flex; flex: 1 1 auto; flex-direction: column; gap: 2px; min-width: 0; }
  .mad-row-label { overflow: hidden; color: var(--ink); font-size: 0.64rem; font-weight: 750; text-overflow: ellipsis; white-space: nowrap; }
  .mad-row-detail { display: -webkit-box; overflow: hidden; color: var(--muted); font-size: 0.54rem; word-break: break-word; -webkit-box-orient: vertical; -webkit-line-clamp: 1; line-clamp: 1; }
  /* Phase 18 (task §16): compact Share button. */
  .mad-action { position: relative; display: grid; place-items: center; width: 30px; height: 30px; border: 1px solid var(--line); border-radius: var(--radius-sm); color: var(--ink-soft); background: rgba(255, 255, 255, 0.03); cursor: pointer; text-decoration: none; flex: 0 0 auto; }
  .mad-action:hover, .mad-action:focus-visible { border-color: var(--line-strong); background: var(--accent-soft); color: var(--ink); }
  .mad-action:active { transform: scale(0.96); }
  .mad-action.done { border-color: var(--accent); color: var(--accent); }
  .mad-action.failed { border-color: #d48a64; color: #d48a64; }
  .mad-action-share { color: var(--ink); }
  @keyframes mad-spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .mad-spin, .mad-tab-spin { animation: none; } .mad-action { transition: none; } }
</style>
