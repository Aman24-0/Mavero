<script lang="ts">
  import { onMount } from 'svelte';
  import { AlertTriangle, Check, Copy, Download, ExternalLink, Info, Loader2, Play, RotateCw } from 'lucide-svelte';
  import { copyStreamUrl, downloadAttributesFor } from '$lib/client/player/stream-actions';
  import { externalPlayerHint, externalPlayerLaunchFor, isAndroidUserAgent } from '$lib/shared/external-player';

  /**
   * MAVERO Downloader — the addon-grouped "best available links" panel
   * (Phase 14, progressive independent flow in Phase 15).
   *
   * Rendered inside the EXISTING DownloadSheet (when the built-in
   * "Mavero Downloader" provider is selected) and on the standalone
   * /watch/mavero-downloader deep-link pages. One surface, two hosts.
   *
   * PHASE 15 PROGRESSIVE FLOW (task §1/§2/§3):
   *   1. onMount: fetch the addon TAB list from `/api/downloader/mavero/tabs`
   *      (NO stream fetches — fast). Render every tab in `loading` state.
   *   2. For EACH tab: fire an INDEPENDENT fetch to
   *      `/api/downloader/mavero/addon?...&addon=<id>` with its OWN
   *      AbortController + lifecycle. Successful tabs update IN PLACE —
   *      they never reset other tabs. Slow tabs keep loading in the
   *      background. A failed tab never disturbs successful tabs.
   *   3. The server does bounded retry/backoff for transient failures
   *      (TIMEOUT/NETWORK/HTTP_ERROR) internally; the frontend sees the
   *      final result (loaded/empty/unavailable).
   *   4. A per-tab Retry button re-fires ONLY that tab's request — it does
   *      NOT touch other tabs and does NOT reset global state.
   *
   * PRODUCT CONTRACT (task §3/§4/§7/§8/§9/§10/§14/§15):
   *   * The server already ranked + filtered everything: ≤10 BEST links per
   *     addon arrive here — never the raw 30–50 addon streams.
   *   * The addon tabs carry the FIVE-state model: Loading / Retrying / N
   *     links / 0 links / Unavailable + Retry. A per-link problem never
   *     renders as an addon failure (and vice versa).
   *   * Links are labelled "Best available links" — NEVER "guaranteed
   *     working": the backend ranks metadata, it does not open the URLs.
   *   * Play opens the ORIGINAL addon URL in an EXTERNAL player
   *     (mpv on Android through the VIEW-intent mechanism; a plain
   *     external link everywhere else). Copy copies the ORIGINAL URL.
   *     Download navigates the ORIGINAL URL — no proxy, no FFmpeg, no
   *     rewrite; if the provider serves the file inline instead of a
   *     download, that is the honest browser outcome.
   */

  export let contentId = '';
  export let mediaType: 'movie' | 'series' | 'anime' = 'movie';
  export let tmdbId = '';
  export let season: number | undefined = undefined;
  export let episode: number | undefined = undefined;
  export let title = '';

  type StreamView = {
    url: string;
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
    protocol: 'http' | 'https';
    confidence: 'high' | 'medium' | 'low';
  };
  /** Phase 15 five-state model (task §3). */
  type TabStatus = 'loading' | 'retrying' | 'loaded' | 'empty' | 'unavailable';
  type Tab = {
    addonId: string;
    addonName: string;
    addonSlug: string;
    addonOrdering: number;
    status: TabStatus;
    streams: StreamView[];
    errorCode?: string;
    /** Per-tab abort controller (independent lifecycle). */
    abort?: AbortController;
    /** Per-tab retry attempt count (for the retrying state). */
    attempts?: number;
  };

  let tabs: Tab[] = [];
  let tabsLoading = true;
  let tabsFailed = false;
  let activeTabId: string | null = null;

  // Per-link action states (bounded, self-restoring — the MaveroStreamCard
  // pattern: immediate feedback, duplicate rapid clicks suppressed).
  let copiedKey = '';
  let copiedTimer: ReturnType<typeof setTimeout> | undefined;
  let copyFailedKey = '';
  let openingKey = '';
  let openingTimer: ReturnType<typeof setTimeout> | undefined;

  $: activeTab = tabs.find((tab) => tab.addonId === activeTabId) ?? null;
  $: tabsReady = !tabsLoading && !tabsFailed && tabs.length > 0;

  function formatSize(bytes?: number): string | undefined {
    if (!bytes || bytes <= 0) return undefined;
    if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(bytes >= 10 * 1024 ** 3 ? 0 : 1)} GB`;
    if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`;
    return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  }

  /** "1080p · H.264 · Multi · MKV · 4.6 GB" — addon-supplied facts only. */
  function streamLabel(stream: StreamView): string {
    const parts = [
      stream.quality === 'auto' ? 'Auto' : stream.quality,
      stream.codec !== 'unknown' ? stream.codec : undefined,
      stream.container,
      stream.audio === 'multi' ? 'Multi Audio' : stream.audio === 'dual' ? 'Dual Audio' : undefined,
      formatSize(stream.sizeBytes),
    ];
    return parts.filter((part): part is string => Boolean(part)).join(' · ');
  }

  /** The honest secondary line: what the addon itself wrote about the file. */
  function streamDetail(stream: StreamView): string | undefined {
    const candidate = stream.filename || stream.title || stream.name;
    if (candidate && candidate.trim()) {
      const trimmed = candidate.trim();
      return trimmed.length > 140 ? `${trimmed.slice(0, 140)}…` : trimmed;
    }
    const firstLine = (stream.description ?? '').split('\n').map((line) => line.trim()).find(Boolean);
    return firstLine;
  }

  /** Default active tab: the first addon with links, else the first addon. */
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

  /** Phase 15 task §1/§2: load the addon TAB list (no streams). */
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

  /**
   * Phase 15 task §1: fire ONE independent per-addon resolution. Successful
   * tabs update IN PLACE — they never reset other tabs. The server does
   * bounded retry/backoff for transient failures internally.
   */
  async function loadAddon(tab: Tab): Promise<void> {
    // Abort any previous in-flight request for this tab (Retry re-fires cleanly).
    tab.abort?.abort();
    const abort = new AbortController();
    tab.abort = abort;
    tab.status = tab.status === 'unavailable' ? 'loading' : tab.status === 'retrying' ? 'retrying' : 'loading';
    tab.errorCode = undefined;
    tab.streams = [];
    tabs = [...tabs]; // trigger reactivity

    const params = buildParams();
    params.set('addon', tab.addonId);
    try {
      const response = await fetch(`/api/downloader/mavero/addon?${params.toString()}`, {
        headers: { accept: 'application/json' },
        signal: abort.signal,
      });
      if (abort.signal.aborted) return; // a newer Retry superseded this request
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
      if (abort.signal.aborted) return; // user retried / navigated away
      tab.status = 'unavailable';
      tab.streams = [];
      tab.errorCode = 'NETWORK';
      console.warn('[MaveroDownloader] tab fetch failed', tab.addonSlug, error);
    } finally {
      if (!abort.signal.aborted) {
        tabs = [...tabs]; // trigger reactivity with the final state
        // Auto-select the first loaded tab if the active tab is empty/failed.
        if (activeTabId === tab.addonId && tab.status !== 'loaded' && tab.streams.length === 0) {
          const firstLoaded = tabs.find((candidate) => candidate.status === 'loaded' && candidate.streams.length > 0);
          if (firstLoaded && firstLoaded.addonId !== activeTabId) {
            activeTabId = firstLoaded.addonId;
          }
        }
      }
    }
  }

  /**
   * Phase 15 task §1/§2: on mount, fetch the tab list then fire ONE
   * independent per-addon request for each tab. Each tab has its OWN
   * lifecycle — a successful tab never resets when another tab loads or
   * retries.
   */
  async function load(): Promise<void> {
    await loadTabs();
    if (tabs.length === 0) return;
    // Fire all per-addon requests in parallel; each resolves independently.
    // We do NOT await Promise.all before rendering — the reactive `tabs`
    // array updates each tab in place as it completes.
    for (const tab of tabs) {
      void loadAddon(tab);
    }
  }

  /** Phase 15 task §2: retry ONLY the selected tab — others stay untouched. */
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

  async function handleCopy(stream: StreamView, key: string) {
    const result = await copyStreamUrl(stream.url); // the ORIGINAL addon URL — never rewritten
    if (copiedTimer) clearTimeout(copiedTimer);
    if (result === 'copied') {
      copiedKey = key;
      copyFailedKey = '';
      copiedTimer = setTimeout(() => { copiedKey = ''; }, 2000);
    } else {
      copiedKey = '';
      copyFailedKey = key;
      copiedTimer = setTimeout(() => { copyFailedKey = ''; }, 2000);
    }
  }

  function handleDownload(event: MouseEvent, key: string) {
    event.stopPropagation();
    if (openingKey) return; // duplicate rapid clicks suppressed
    openingKey = key;
    if (openingTimer) clearTimeout(openingTimer);
    openingTimer = setTimeout(() => { openingKey = ''; }, 2500);
  }

  function openHref(stream: StreamView): string | null {
    return externalPlayerLaunchFor(stream.url)?.href ?? stream.url;
  }

  function openTarget(stream: StreamView): string | null {
    const launch = externalPlayerLaunchFor(stream.url);
    return launch?.kind === 'direct' ? '_blank' : null;
  }

  function openTitle(stream: StreamView): string {
    const launch = externalPlayerLaunchFor(stream.url);
    return externalPlayerHint(launch ?? { kind: 'direct' });
  }

  /** The footer hint depends only on the DEVICE (kind), not on any URL. */
  $: playerNote = externalPlayerHint({ kind: typeof navigator !== 'undefined' && isAndroidUserAgent(navigator.userAgent) ? 'android-intent' : 'direct' });

  onMount(load);
</script>

<div class="mad" aria-busy={tabsLoading}>
  <div class="mad-intro">
    <div class="mad-intro-copy">
      <span class="mad-eyebrow">MAVERO Downloader</span>
      {#if title}<span class="mad-title">{title}</span>{/if}
    </div>
    <span class="mad-hint"><ExternalLink size={11} /> Best available links</span>
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
      {:else if activeTab.streams.length === 0}
        <div class="mad-state" role="status">
          <Info size={16} />
          <span>No eligible direct file links from {activeTab.addonName} for this title.</span>
          <button type="button" class="mad-retry" onclick={() => retryTab(activeTab)}><RotateCw size={12} /> Retry</button>
        </div>
      {:else}
        <div class="mad-list" role="list" aria-label={`${activeTab.addonName} best links`}>
          {#each activeTab.streams as stream, index (stream.url)}
            {@const key = `${activeTab.addonSlug}-${index}`}
            <article class="mad-row" role="listitem">
              <div class="mad-row-main">
                <span class="mad-row-label">{streamLabel(stream)}</span>
                {#if streamDetail(stream)}<span class="mad-row-detail">{streamDetail(stream)}</span>{/if}
                {#if stream.audioLanguages?.length}<span class="mad-row-sub">{stream.audioLanguages.join(' + ')} audio</span>{/if}
              </div>
              <div class="mad-row-actions">
                <a
                  class="mad-action mad-action-play"
                  href={openHref(stream)}
                  target={openTarget(stream)}
                  rel="noopener noreferrer"
                  aria-label="Open in external player"
                  title={openTitle(stream)}
                  onclick={(event) => event.stopPropagation()}
                ><Play size={14} fill="currentColor" /></a>
                <a
                  class="mad-action"
                  class:opening={openingKey === key}
                  href={stream.url}
                  download={downloadAttributesFor({ url: stream.url, filename: stream.filename })?.download ?? 'stream'}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={openingKey === key ? 'Opening the original file' : 'Download the original file'}
                  title="Download (original URL)"
                  onclick={(event) => handleDownload(event, key)}
                ><Download size={14} /></a>
                <button
                  class="mad-action"
                  class:done={copiedKey === key}
                  type="button"
                  aria-label={copiedKey === key ? 'URL copied' : copyFailedKey === key ? 'Copy failed' : 'Copy URL'}
                  title={copiedKey === key ? 'Copied' : 'Copy URL'}
                  onclick={(event) => { event.stopPropagation(); void handleCopy(stream, key); }}
                >
                  {#if copiedKey === key}<Check size={14} />{:else if copyFailedKey === key}<AlertTriangle size={14} />{:else}<Copy size={14} />{/if}
                </button>
              </div>
            </article>
          {/each}
        </div>
        <p class="mad-note"><ExternalLink size={11} /> {playerNote} Links open or download with the provider's original address.</p>
      {/if}
    {/if}
  {/if}
</div>

<style>
  .mad { display: flex; flex-direction: column; gap: 10px; min-height: 220px; color: var(--ink); }
  .mad-intro { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
  .mad-intro-copy { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .mad-eyebrow { color: var(--muted); font-size: 0.55rem; font-weight: 800; letter-spacing: 0.14em; text-transform: uppercase; }
  .mad-title { overflow: hidden; color: var(--ink); font-size: 0.8rem; font-weight: 800; text-overflow: ellipsis; white-space: nowrap; }
  .mad-hint { display: inline-flex; flex: 0 0 auto; align-items: center; gap: 4px; color: var(--muted); font-size: 0.56rem; font-weight: 700; }
  .mad-state { display: flex; min-height: 150px; flex: 1 1 auto; align-items: center; justify-content: center; gap: 9px; flex-wrap: wrap; padding: 10px; color: var(--muted); font-size: 0.7rem; text-align: center; }
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
  .mad-list { display: flex; flex-direction: column; gap: 6px; }
  .mad-row { display: flex; align-items: center; gap: 8px; border: 1px solid var(--line); border-radius: var(--radius-sm); background: rgba(255, 255, 255, 0.025); padding: 9px 10px; }
  .mad-row-main { display: flex; flex: 1 1 auto; flex-direction: column; gap: 3px; min-width: 0; }
  .mad-row-label { overflow: hidden; color: var(--ink); font-size: 0.7rem; font-weight: 750; text-overflow: ellipsis; white-space: nowrap; }
  .mad-row-detail { display: -webkit-box; overflow: hidden; color: var(--muted); font-size: 0.57rem; word-break: break-word; -webkit-box-orient: vertical; -webkit-line-clamp: 2; line-clamp: 2; }
  .mad-row-sub { color: var(--muted); font-size: 0.55rem; }
  .mad-row-actions { display: flex; flex: 0 0 auto; align-items: center; gap: 5px; }
  .mad-action { position: relative; display: grid; place-items: center; width: 36px; height: 36px; border: 1px solid var(--line); border-radius: var(--radius-sm); color: var(--ink-soft); background: rgba(255, 255, 255, 0.03); cursor: pointer; text-decoration: none; }
  .mad-action:hover, .mad-action:focus-visible { border-color: var(--line-strong); background: var(--accent-soft); color: var(--ink); }
  .mad-action:active { transform: scale(0.96); }
  .mad-action.done { border-color: var(--accent); color: var(--accent); }
  .mad-action.opening { border-color: var(--accent); color: var(--accent); opacity: 0.7; pointer-events: none; }
  .mad-action-play { color: var(--ink); }
  .mad-note { display: flex; align-items: center; gap: 5px; margin: 0; color: var(--muted); font-size: 0.55rem; }
  @keyframes mad-spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .mad-spin, .mad-tab-spin { animation: none; } .mad-action { transition: none; } }
</style>
