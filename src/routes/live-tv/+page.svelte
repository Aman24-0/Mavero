<script lang="ts">
  // LT-4 — /live-tv: the Live TV page (state orchestration only).
  //
  // ARCHITECTURE (live-tv-plan.md §4, LT-4 brief §1):
  //   LiveGT catalogue → LT-2 client (THIS page calls it) → LT-3 engine
  //   (page-owned instance) → LiveTvPlayer's <video> (page-owned element,
  //   rendered by the player component through the `video` bindable).
  //
  // The page NEVER builds LiveGT URLs, never touches Shaka, never spreads
  // raw wire objects. Playback resolutions exist ONLY inside the async
  // select flow: they are handed straight from LT-2 to engine.load() and are
  // NEVER stored in reactive state, URL params, storage or logs (plan §11).
  // Reactive state carries only non-sensitive data: catalogue metadata
  // (id/name/category/logo), engine states and SAFE messages from the fixed
  // LT-2/LT-3 tables.
  //
  // CHANNEL SWITCHING (LT-4 brief §9, plan §9 — the critical path):
  //   select(B) → abort A's controller (kills A's in-flight resolve/load
  //   through the LT-2/LT-3 signal contracts) → DESTROY A's engine (plan §9
  //   order: stop previous FIRST) → adopt B → resolve B fresh → new engine
  //   loads onto the SAME <video> element → 'loaded' → autoplay attempt in
  //   the player component. Every async continuation is guarded by the
  //   selection sequence + the AbortController state, so a late A result can
  //   never overwrite B's UI. Exactly ONE engine instance is alive at any
  //   moment (the old one is destroyed before the new one is created).
  //
  // SEARCH/CATEGORIES: 100% local filtering of the loaded catalogue through
  // the LT-2 pure utilities — no per-keystroke network, no second search
  // implementation, no new cache (LT-4 brief §6/§7/§20).
  //
  // GUIDE: loaded per selected channel, INDEPENDENT of playback — a guide
  // failure never touches the playback session (LT-4 brief §13). Guide
  // timestamps are absolute Unix seconds; the current programme is derived
  // from actual data only (epg.determineCurrentProgramme) — never fabricated.
  //
  // SSR: no data fetching and no browser access during server render — the
  // server paints the hero, player shell and catalogue skeleton; everything
  // data-related starts in onMount (existing Mavero page pattern).
  import { onDestroy, onMount } from 'svelte';
  import { page as appPage } from '$app/state';
  import { Search, X, Radio, RefreshCw, LoaderCircle } from 'lucide-svelte';
  import ScrollToTop from '$components/ScrollToTop.svelte';
  import ErrorState from '$components/ErrorState.svelte';
  import LiveTvPlayer from '$components/live-tv/LiveTvPlayer.svelte';
  import LiveTvCategoryBar from '$components/live-tv/LiveTvCategoryBar.svelte';
  import LiveTvChannelCard from '$components/live-tv/LiveTvChannelCard.svelte';
  import LiveTvNowPlaying from '$components/live-tv/LiveTvNowPlaying.svelte';
  import LiveTvGuide from '$components/live-tv/LiveTvGuide.svelte';
  import {
    getLiveTvChannels,
    getLiveTvGuide,
    resolveLiveTvPlayback,
    extractLiveTvCategories,
    filterLiveTvChannelsByCategory,
    filterLiveTvChannelsByQuery
  } from '$lib/client/live-tv/api';
  import { isLiveTvError } from '$lib/client/live-tv/errors';
  import { isLiveTvPlaybackError } from '$lib/client/live-tv/player-errors';
  import { LiveTvPlaybackEngine } from '$lib/client/live-tv/player';
  import { determineCurrentProgramme } from '$lib/client/live-tv/epg';
  import {
    trackLiveTvOpen,
    trackLiveTvChannelAction,
    trackLiveTvPlay,
    trackLiveTvPause,
    trackLiveTvError,
    trackLiveTvFullscreen
  } from '$lib/client/live-tv/analytics';
  import type { LiveTvChannel, LiveTvGuide as LiveTvGuideModel } from '$lib/client/live-tv/types';

  // ---------------------------------------------------------------------
  // Safe message mapping — ONLY fixed LT-2/LT-3 table text is ever shown.
  // Unknown errors get a static fallback; nothing is ever interpolated.
  // ---------------------------------------------------------------------
  const FALLBACK_MESSAGE = 'Live TV is unavailable right now.';
  const GUIDE_FALLBACK_MESSAGE = 'Guide unavailable right now.';

  function playbackSafeMessage(err: unknown): string {
    if (isLiveTvError(err)) return err.message; // LT-2 fixed safe table
    if (isLiveTvPlaybackError(err)) return err.message; // LT-3 fixed safe table
    return FALLBACK_MESSAGE;
  }

  function guideSafeMessage(err: unknown): string {
    if (isLiveTvError(err)) return err.message; // LT-2 fixed safe table
    return GUIDE_FALLBACK_MESSAGE;
  }

  function isSilentAbort(err: unknown): boolean {
    // Aborts (caller cancellation) are never surfaced as failures.
    if (isLiveTvError(err) && err.kind === 'aborted') return true;
    if (isLiveTvPlaybackError(err) && err.kind === 'aborted') return true;
    return false;
  }

  // ---------------------------------------------------------------------
  // Catalogue state.
  // ---------------------------------------------------------------------
  let catalogueState = $state<'loading' | 'ready' | 'error'>('loading');
  let channels = $state<LiveTvChannel[]>([]);
  let catalogueMessage = $state<string | null>(null);
  let catalogueController: AbortController | undefined;

  async function loadCatalogue(): Promise<void> {
    catalogueController?.abort();
    const controller = new AbortController();
    catalogueController = controller;
    catalogueState = 'loading';
    catalogueMessage = null;
    try {
      const list = await getLiveTvChannels({ signal: controller.signal });
      if (controller.signal.aborted) return; // superseded/unmounted — silent
      channels = list;
      catalogueState = 'ready';
    } catch (err) {
      if (controller.signal.aborted || isSilentAbort(err)) return;
      catalogueMessage = playbackSafeMessage(err);
      catalogueState = 'error';
    }
  }

  // ---------------------------------------------------------------------
  // Search + categories (LOCAL filtering only — LT-2 pure utilities).
  // ---------------------------------------------------------------------
  let query = $state('');
  let category = $state(''); // '' = All
  let searchInputEl: HTMLInputElement | undefined = $state();

  const categories = $derived(extractLiveTvCategories(channels));
  const visibleChannels = $derived.by(() => {
    let list = filterLiveTvChannelsByCategory(channels, category);
    const trimmed = query.trim();
    if (trimmed) list = filterLiveTvChannelsByQuery(list, trimmed);
    return list;
  });

  // Incremental rendering: the catalogue can exceed 1000 channels; the grid
  // renders in bounded batches behind an IntersectionObserver sentinel (the
  // existing Upcoming-page convention — not a virtualization framework).
  const CHANNEL_BATCH = 60;
  let visibleLimit = $state(CHANNEL_BATCH);
  let sentinelEl = $state<HTMLElement | undefined>();

  function resetVisibleLimit(): void {
    visibleLimit = CHANNEL_BATCH;
  }

  function applyCategory(next: string): void {
    category = next;
    resetVisibleLimit();
  }

  function clearSearch(): void {
    query = '';
    resetVisibleLimit();
    searchInputEl?.focus();
  }

  $effect(() => {
    const el = sentinelEl;
    if (!el) return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) visibleLimit += CHANNEL_BATCH;
        }
      },
      { rootMargin: '600px 0px' }
    );
    observer.observe(el);
    return () => observer.disconnect();
  });

  // ---------------------------------------------------------------------
  // Playback session state (page-owned; engine instance per session).
  // ---------------------------------------------------------------------
  let selectedChannel = $state<LiveTvChannel | null>(null);
  let resolving = $state(false);
  let sessionErrorMessage = $state<string | null>(null);
  let engine = $state<LiveTvPlaybackEngine | null>(null);
  let videoEl = $state<HTMLVideoElement | undefined>(undefined);
  let sessionController: AbortController | undefined;
  let sessionSeq = 0;

  const resolvingChannel = $derived(resolving ? selectedChannel : null);

  function destroyEngineSafely(target: LiveTvPlaybackEngine | null): void {
    // Idempotent (LT-3 contract); only clears the page reference if it still
    // points at THIS engine so a late continuation can never null a newer
    // session's engine.
    if (!target) return;
    target.destroy();
    if (engine === target) engine = null;
  }

  async function selectChannel(channel: LiveTvChannel): Promise<void> {
    // Same-channel selection is an intentional retry: the whole flow reruns
    // with a FRESH resolution (never a reused one — LT-4 brief §19).
    const seq = ++sessionSeq;
    sessionController?.abort(); // kill the previous selection's resolve/load
    const controller = new AbortController();
    sessionController = controller;

    // Analytics (LT-5): the selection intent — first selection, a retry of
    // the same channel, or a switch away from an active one. Payloads are
    // built inside the adapter from catalogue metadata only (channel id +
    // category + reason — never playback material). Fire-and-forget: an
    // analytics failure can never affect this flow.
    const previousChannel = selectedChannel;
    const selectReason = previousChannel
      ? previousChannel.id === channel.id ? 'retry' : 'switch'
      : 'initial';
    trackLiveTvChannelAction(channel, selectReason);

    // Plan §9 order: stop/destroy the previous playback FIRST.
    destroyEngineSafely(engine);

    // Adopt the selection (non-sensitive catalogue metadata only).
    selectedChannel = channel;
    resolving = true;
    sessionErrorMessage = null;

    // Guide for the new channel — independent of playback (§13).
    void loadGuide(channel);

    if (!videoEl) {
      // Structurally unreachable after mount; kept as a safe guard.
      resolving = false;
      sessionErrorMessage = 'Live TV playback could not start in this browser.';
      return;
    }

    try {
      // 1. Fresh resolution (LT-2 — every call hits the network; the result
      //    lives only in this local variable and is handed straight to the
      //    engine; it is never stored in reactive state).
      const resolution = await resolveLiveTvPlayback(channel.id, { signal: controller.signal });
      if (seq !== sessionSeq || controller.signal.aborted) return; // superseded — silent

      // 2. Fresh engine for the new session; it attaches to the SAME
      //    caller-owned <video> element (never two instances — the old one
      //    was destroyed above; LT-3 load also tears down defensively).
      const eng = new LiveTvPlaybackEngine();
      engine = eng;

      // Analytics (LT-5): the engine's normalized events are the single
      // source of playback truth — 'statechange' → 'playing' marks the
      // FIRST actual playback of this session (once per session; resumes
      // after a pause are deliberately not re-tracked), and 'error' carries
      // the normalized failure exactly once per surfaced session failure
      // (load failures AND mid-session failures both arrive here — the
      // catches below therefore never track errors twice). The
      // subscriptions die with the engine on destroy/switch (LT-3 clears
      // its listener map), so no explicit unsubscribe is needed.
      let playTracked = false;
      eng.on('statechange', ({ state }) => {
        if (state === 'playing' && !playTracked) {
          playTracked = true;
          trackLiveTvPlay(channel.id);
        }
      });
      eng.on('error', (error) => {
        trackLiveTvError(channel.id, error);
      });

      try {
        await eng.load(videoEl, resolution, { signal: controller.signal });
        if (seq !== sessionSeq || controller.signal.aborted) {
          destroyEngineSafely(eng); // stale completion — discard silently
          return;
        }
        resolving = false;
        // 'loaded' has fired; the player component attempts autoplay.
      } catch (err) {
        if (seq !== sessionSeq || controller.signal.aborted || isSilentAbort(err)) {
          destroyEngineSafely(eng);
          return;
        }
        destroyEngineSafely(eng); // failed session: surface via safe message
        resolving = false;
        sessionErrorMessage = playbackSafeMessage(err);
      }
    } catch (err) {
      // Resolution failure (LT-2) — silent when superseded/aborted.
      if (seq !== sessionSeq || controller.signal.aborted || isSilentAbort(err)) return;
      resolving = false;
      sessionErrorMessage = playbackSafeMessage(err);
      // Analytics: resolution failures never reach an engine, so this is
      // the one place they are tracked (normalized kind only). Engine-side
      // failures are tracked via the engine 'error' subscription above.
      trackLiveTvError(channel.id, err);
    }
  }

  function retryPlayback(): void {
    if (selectedChannel) void selectChannel(selectedChannel);
  }

  // ---------------------------------------------------------------------
  // Guide state (per selected channel; failures never touch playback).
  // ---------------------------------------------------------------------
  let guide = $state<LiveTvGuideModel | null>(null);
  let guideLoading = $state(false);
  let guideErrorMessage = $state<string | null>(null);
  let guideController: AbortController | undefined;
  let guideSeq = 0;

  async function loadGuide(channel: LiveTvChannel): Promise<void> {
    const seq = ++guideSeq;
    guideController?.abort(); // the previous channel's guide is irrelevant now
    const controller = new AbortController();
    guideController = controller;
    guideLoading = true;
    guideErrorMessage = null;
    guide = null;
    try {
      const result = await getLiveTvGuide(channel.id, { signal: controller.signal });
      if (seq !== guideSeq || controller.signal.aborted) return;
      guide = result;
      guideLoading = false;
    } catch (err) {
      if (seq !== guideSeq || controller.signal.aborted || isSilentAbort(err)) return;
      guideErrorMessage = guideSafeMessage(err);
      guideLoading = false;
    }
  }

  function retryGuide(): void {
    if (selectedChannel) void loadGuide(selectedChannel);
  }

  // Player-surface user actions (LT-5 analytics): the component REPORTS the
  // raw action; the page owns what (if anything) is tracked. Only real user
  // intents arrive here — pause via the control, fullscreen toggles.
  function handlePlayerUserAction(action: 'pause' | 'fullscreen_enter' | 'fullscreen_exit'): void {
    if (action === 'pause') {
      const id = selectedChannel?.id;
      if (id) trackLiveTvPause(id);
      return;
    }
    trackLiveTvFullscreen(selectedChannel?.id ?? null, action === 'fullscreen_enter' ? 'enter' : 'exit');
  }

  // Current programme for the info line — actual guide data only (the
  // provider's nowPlaying, or an unambiguous schedule time-window match).
  // Absolute Unix seconds on both sides: no timezone assumption (§14).
  let nowSeconds = $state(Math.floor(Date.now() / 1000));
  let nowTicker: ReturnType<typeof setInterval> | undefined;

  const currentProgramme = $derived(
    guide ? determineCurrentProgramme(guide, nowSeconds) : null
  );

  onMount(() => {
    void loadCatalogue();
    // Analytics (LT-5): page open — a pure page-load event that does NOT
    // count toward the active-user metric (refresh-safe, per plan §11).
    trackLiveTvOpen();
    nowTicker = setInterval(() => {
      nowSeconds = Math.floor(Date.now() / 1000);
    }, 30_000);
  });

  onDestroy(() => {
    // Invalidate every in-flight operation and release the session.
    sessionSeq += 1;
    guideSeq += 1;
    sessionController?.abort();
    sessionController = undefined;
    guideController?.abort();
    guideController = undefined;
    catalogueController?.abort();
    catalogueController = undefined;
    destroyEngineSafely(engine);
    if (nowTicker) clearInterval(nowTicker);
    nowTicker = undefined;
  });
</script>

<svelte:head>
  <title>Live TV — Mavero</title>
  <meta name="description" content="Browse and watch live TV channels in Mavero." />
  <link rel="canonical" href={`${appPage.url.origin}${appPage.url.pathname}`} />
  <meta property="og:title" content="Live TV — Mavero" />
  <meta property="og:description" content="Browse and watch live TV channels in Mavero." />
  <meta property="og:url" content={`${appPage.url.origin}${appPage.url.pathname}`} />
  <meta name="robots" content="noindex,follow" />
</svelte:head>

<div class="live-tv-page">
  <!-- Hero: heading + local channel search + data-derived categories -->
  <section class="ltv-hero" aria-label="Live TV">
    <div class="ltv-hero-inner">
      <h1 class="ltv-heading">
        <span class="heading-icon" aria-hidden="true"><Radio size={18} /></span>
        <span class="heading-brand">MAVERO</span>
        <span class="heading-sep" aria-hidden="true">/</span>
        <span class="heading-page">Live TV</span>
      </h1>

      <div class="ltv-search" role="search">
        <span class="search-leading" aria-hidden="true"><Search size={17} /></span>
        <label class="sr-only" for="live-tv-channel-search">Search channels</label>
        <input
          id="live-tv-channel-search"
          bind:this={searchInputEl}
          bind:value={query}
          oninput={resetVisibleLimit}
          aria-label="Search channels"
          placeholder="Search channels"
          autocomplete="off"
          spellcheck="false"
        />
        {#if query}
          <button class="clear-btn" type="button" aria-label="Clear channel search" onclick={clearSearch}>
            <X size={16} />
          </button>
        {/if}
      </div>

      {#if catalogueState === 'ready'}
        <div class="ltv-categories">
          <LiveTvCategoryBar {categories} selected={category} onselect={applyCategory} />
        </div>
      {/if}
    </div>
  </section>

  <div class="ltv-body">
    <!-- Player + channel information (player receives visual priority) -->
    <section class="ltv-player-column" aria-label="Live TV player and channel information">
      <LiveTvPlayer
        bind:video={videoEl}
        {engine}
        {resolvingChannel}
        {sessionErrorMessage}
        onretry={retryPlayback}
        onuseraction={handlePlayerUserAction}
      />

      {#if selectedChannel}
        <div class="ltv-channel-info">
          <span class="info-live" aria-hidden="true"><span class="live-dot"></span> LIVE</span>
          <span class="info-name">{selectedChannel.name}</span>
          {#if selectedChannel.category}
            <span class="info-category">{selectedChannel.category}</span>
          {/if}
          {#if currentProgramme}
            <span class="info-now">Now: {currentProgramme.title}</span>
          {/if}
        </div>
      {/if}
    </section>

    {#if selectedChannel}
      <LiveTvNowPlaying
        {guide}
        loading={guideLoading}
        errorMessage={guideErrorMessage}
        onretry={retryGuide}
      />
    {/if}

    <!-- Channel catalogue -->
    <section class="ltv-channels" aria-label="Channels">
      <div class="channels-head">
        <h2 class="ltv-section-title">Channels</h2>
        {#if catalogueState === 'ready'}
          <span class="channels-count">{visibleChannels.length} of {channels.length}</span>
        {/if}
      </div>

      {#if catalogueState === 'loading'}
        <div class="channel-grid" aria-busy="true">
          {#each Array(12) as _, i (i)}
            <div class="channel-skeleton" aria-hidden="true">
              <span class="sk-logo"></span>
              <span class="sk-lines"><span class="sk-line w70"></span><span class="sk-line w40"></span></span>
            </div>
          {/each}
        </div>
      {:else if catalogueState === 'error'}
        <ErrorState
          eyebrow="MAVERO / Live TV"
          title="The signal dropped."
          message={catalogueMessage ?? 'Live TV is unavailable right now.'}
          retry={loadCatalogue}
        />
      {:else if channels.length === 0}
        <div class="channels-empty" role="status">
          <span class="empty-mark" aria-hidden="true"><Radio size={22} /></span>
          <h3>No Live TV channels are currently available.</h3>
          <p>The channel guide is empty right now. Try again in a moment.</p>
          <button class="btn btn-secondary" type="button" onclick={() => void loadCatalogue()}>
            <RefreshCw size={15} /> Retry
          </button>
        </div>
      {:else if visibleChannels.length === 0}
        <div class="channels-empty" role="status">
          <span class="empty-mark" aria-hidden="true"><Search size={22} /></span>
          <h3>No channels match your search.</h3>
          <p>Try another name or pick a different category.</p>
          <button class="btn btn-secondary" type="button" onclick={clearSearch}>Clear search</button>
        </div>
      {:else}
        <div class="channel-grid">
          {#each visibleChannels.slice(0, visibleLimit) as channel (channel.id)}
            <LiveTvChannelCard
              {channel}
              selected={channel.id === selectedChannel?.id}
              onselect={(c) => void selectChannel(c)}
            />
          {/each}
          {#if visibleChannels.length > visibleLimit}
            <div class="grid-sentinel" bind:this={sentinelEl} aria-hidden="true"></div>
          {/if}
        </div>
        {#if visibleChannels.length > visibleLimit}
          <div class="channels-more" role="status" aria-live="polite">
            <LoaderCircle size={14} aria-hidden="true" /> Loading more channels…
          </div>
        {/if}
      {/if}
    </section>

    {#if selectedChannel}
      <LiveTvGuide
        {guide}
        {nowSeconds}
        loading={guideLoading}
        errorMessage={guideErrorMessage}
        onretry={retryGuide}
      />
    {/if}
  </div>
</div>

<ScrollToTop />

<style>
  .live-tv-page {
    --ltv-gutter: clamp(16px, 5vw, 48px);
    min-height: calc(100dvh - 76px);
    padding-bottom: 110px;
  }

  .ltv-hero {
    position: relative;
    padding: 22px var(--ltv-gutter) 18px;
    border-bottom: 1px solid var(--color-border);
    background:
      radial-gradient(circle at 80% -30%, var(--color-primary-soft), transparent 50%),
      var(--color-bg);
  }
  .ltv-hero-inner { width: min(1040px, 100%); margin-inline: auto; }

  .ltv-heading {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    margin: 0 0 16px;
    color: var(--color-text);
    font-size: clamp(1.4rem, 4.6vw, 2rem);
    font-weight: 900;
    letter-spacing: -.02em;
    line-height: 1.1;
  }
  .heading-icon { display: inline-grid; place-items: center; color: var(--color-text-muted); flex: 0 0 auto; }
  .heading-brand { color: var(--color-text); }
  .heading-sep { color: var(--color-text-deep); font-weight: 700; }
  .heading-page { color: var(--color-primary); }

  .ltv-search {
    display: flex;
    align-items: center;
    gap: 12px;
    height: 52px;
    padding: 0 10px 0 16px;
    border: 1px solid var(--color-border-strong);
    border-radius: var(--radius-md);
    background: var(--color-surface);
    transition: border-color var(--motion-fast) var(--ease-out), background var(--motion-fast) var(--ease-out), box-shadow var(--motion-fast) var(--ease-out);
  }
  .ltv-search:focus-within {
    border-color: var(--color-primary);
    background: var(--color-surface-elevated);
    box-shadow: var(--glow-primary);
  }
  .search-leading { display: grid; place-items: center; width: 26px; height: 26px; color: var(--color-text-muted); flex: 0 0 auto; }
  .ltv-search input {
    flex: 1;
    min-width: 0;
    border: 0;
    outline: 0;
    color: var(--color-text);
    background: transparent;
    font: inherit;
    font-size: .92rem;
    font-weight: 500;
  }
  .ltv-search input::placeholder { color: var(--color-text-deep); font-weight: 400; }
  .clear-btn {
    display: grid;
    place-items: center;
    width: 32px;
    height: 32px;
    border: 0;
    border-radius: 50%;
    color: var(--color-text-muted);
    background: rgba(242, 255, 248, .04);
    cursor: pointer;
    flex: 0 0 auto;
    transition: background var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out);
  }
  .clear-btn:hover { background: var(--color-primary-soft); color: var(--color-primary); }
  .clear-btn:active { transform: scale(.94); }
  .clear-btn:focus-visible { outline: 2px solid var(--color-focus); outline-offset: 2px; }

  .ltv-categories { margin-top: 14px; min-width: 0; }

  .sr-only {
    position: absolute;
    width: 1px; height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
  }

  /* ---- body ---- */
  .ltv-body {
    width: min(1040px, calc(100% - clamp(20px, 6vw, 96px)));
    margin-inline: auto;
    display: grid;
    gap: 34px;
    padding-top: 26px;
  }

  .ltv-player-column { display: grid; gap: 12px; min-width: 0; }

  .ltv-channel-info {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
    min-width: 0;
    padding: 2px 4px;
  }
  .info-live {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    flex: 0 0 auto;
    padding: 3px 10px;
    border: 1px solid rgba(255, 77, 109, .35);
    border-radius: 999px;
    color: #ff8fa3;
    background: rgba(255, 77, 109, .1);
    font-size: .6rem;
    font-weight: 800;
    letter-spacing: .14em;
  }
  .info-live .live-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--color-danger);
    box-shadow: 0 0 8px rgba(255, 77, 109, .8);
    animation: ltv-dot-pulse 2s ease-in-out infinite;
  }
  @keyframes ltv-dot-pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: .45; }
  }
  .info-name {
    color: var(--color-text);
    font-size: 1rem;
    font-weight: 800;
    letter-spacing: -.015em;
  }
  .info-category {
    color: var(--color-text-deep);
    font-size: .78rem;
    font-weight: 700;
  }
  .info-now {
    min-width: 0;
    overflow: hidden;
    color: var(--color-text-muted);
    font-size: .78rem;
    font-weight: 600;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .ltv-section-title {
    margin: 0;
    color: var(--color-text);
    font-size: clamp(1.05rem, 1.6vw, 1.3rem);
    font-weight: 800;
    letter-spacing: -.02em;
    line-height: 1.1;
  }

  /* ---- channels ---- */
  .ltv-channels { display: grid; gap: 12px; min-width: 0; }
  .channels-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 12px;
  }
  .channels-count { color: var(--color-text-deep); font-size: .72rem; font-weight: 700; white-space: nowrap; }

  .channel-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(250px, 1fr));
    gap: 10px;
    min-width: 0;
  }
  .grid-sentinel { width: 100%; min-height: 1px; grid-column: 1 / -1; }

  .channels-more {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    margin-top: 4px;
    color: var(--color-text-deep);
    font-size: .74rem;
    font-weight: 600;
  }
  .channels-more :global(svg) { animation: ltv-spin 1s linear infinite; }
  @keyframes ltv-spin { to { transform: rotate(360deg); } }

  .channel-skeleton {
    display: flex;
    align-items: center;
    gap: 12px;
    min-height: 64px;
    padding: 10px 14px 10px 10px;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    background: var(--color-surface);
  }
  .sk-logo {
    flex: 0 0 auto;
    width: 44px;
    height: 44px;
    border-radius: 10px;
    background: var(--color-surface-raised);
  }
  .sk-lines { display: grid; gap: 8px; flex: 1 1 auto; min-width: 0; }
  .sk-line {
    display: block;
    height: 11px;
    border-radius: 6px;
    background: linear-gradient(90deg, var(--color-surface-raised), var(--color-surface-elevated), var(--color-surface-raised));
    background-size: 200% 100%;
    animation: ltv-shimmer 1.6s ease-in-out infinite;
  }
  .sk-line.w70 { width: 70%; }
  .sk-line.w40 { width: 40%; }
  @keyframes ltv-shimmer {
    0% { background-position: 200% 0; }
    100% { background-position: -200% 0; }
  }

  .channels-empty {
    display: grid;
    justify-items: center;
    gap: 6px;
    min-height: 220px;
    place-content: center;
    padding: 30px 20px;
    border: 1px dashed var(--color-border-strong);
    border-radius: var(--radius-lg);
    background: var(--color-surface);
    text-align: center;
  }
  .empty-mark {
    display: grid;
    place-items: center;
    width: 48px;
    height: 48px;
    margin-bottom: 6px;
    border: 1px solid var(--color-border-strong);
    border-radius: 50%;
    color: var(--color-text-muted);
    background: var(--color-surface-raised);
  }
  .channels-empty h3 { margin: 0; color: var(--color-text); font-size: .95rem; font-weight: 800; letter-spacing: -.01em; }
  .channels-empty p { margin: 0 0 10px; max-width: 420px; color: var(--color-text-muted); font-size: .78rem; line-height: 1.6; }

  @media (max-width: 640px) {
    .ltv-body { width: min(100% - 28px, 1040px); gap: 26px; padding-top: 18px; }
    .channel-grid { grid-template-columns: 1fr; }
    .ltv-hero { padding: 18px var(--ltv-gutter) 14px; }
  }

  @media (prefers-reduced-motion: reduce) {
    .sk-line { animation: none; }
    .channels-more :global(svg) { animation: none; }
    .info-live .live-dot { animation: none; }
  }
</style>
