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
  // (id/name/category/logo), engine states and SAFE messages from
  // the fixed LT-2/LT-3 tables.
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
  // AUTOMATIC EMBED FALLBACK (LT-15):
  //   The native engine is ALWAYS attempted first. When — and only when —
  //   the CURRENT engine reports a GENUINE native playback failure (see
  //   shouldFallbackToEmbed: every fatal playback kind except autoplay
  //   blocks and aborts; data-layer/catalogue/guide errors never qualify),
  //   the page destroys the Shaka engine, suppresses the native error
  //   message and hands the player component the channel id, which renders
  //   LiveGT's OWN documented embed player page in an iframe (URL built
  //   exclusively by the LT-2 client from its base-URL constant + a
  //   strictly validated numeric id — never from API wire data). One
  //   mechanism is active at a time: a new selection always tears the
  //   fallback down and starts a fresh native attempt; "Try again" while
  //   the fallback is active recreates the iframe instead of retrying
  //   Shaka. The activation point is the engine 'error' subscription,
  //   identity-guarded so a stale engine can never mount a fallback.
  //
  // PAGE LAYOUT (LT-18 §4 — compact, mobile-first; LT-19 updates):
  //     MAVERO / Live TV (title)
  //     PLAYER (controls INSIDE the player surface — LiveTvPlayer)
  //     TOOLBAR [Search channels…] [Filter] [Guide]
  //     CHANNELS (search + category filtered list)
  //   The permanent category chip row is GONE (the Filter sheet owns the
  //   category dimension — the ORIGINAL provider taxonomy, no separate
  //   language section — LT-19), and the guide experience lives in the
  //   Guide sheet (the FULL GUIDE schedule — one continuous list whose
  //   current programme is marked "On air" — LT-19) instead of permanent
  //   page sections. Both sheets render as overlays, never as page
  //   structure.
  //
  // SEARCH/FILTERS: 100% local filtering of the loaded catalogue through
  // the LT-2 pure utilities — no per-keystroke network, no URL params, no
  // second search implementation, no new cache (LT-4 brief §6/§7/§20,
  // LT-18 §4D).
  //
  // GUIDE: loaded per selected channel, INDEPENDENT of playback — a guide
  //   failure never touches the playback session (LT-4 brief §13). Guide
  //   timestamps are absolute Unix seconds; the current programme is derived
  //   from actual data only (epg.determineCurrentProgramme) — never
  //   fabricated. Opening the Guide sheet NEVER refetches: it renders the
  //   page's existing guide state.
  //
  // SSR: no data fetching and no browser access during server render — the
  // server paints the hero, player shell and catalogue skeleton; everything
  //   data-related starts in onMount (existing Mavero page pattern).
  import { onDestroy, onMount } from 'svelte';
  import { env as publicEnv } from '$env/dynamic/public';
  import { page as appPage } from '$app/state';
  import { goto } from '$app/navigation';
  import { PRODUCTION_ORIGIN } from '$lib/shared/seo';
  import { Search, X, Radio, RefreshCw, LoaderCircle, SlidersHorizontal, BookOpen, ChevronLeft, ChevronRight, ChevronDown, Check, Tv, Share2, Maximize2 } from 'lucide-svelte';
  import { SvelteSet } from 'svelte/reactivity';
  import ScrollToTop from '$components/ScrollToTop.svelte';
  import ErrorState from '$components/ErrorState.svelte';
  import LiveTvPlayer from '$components/live-tv/LiveTvPlayer.svelte';
  import LiveTvChannelCard from '$components/live-tv/LiveTvChannelCard.svelte';
  import LiveTvFilterSheet from '$components/live-tv/LiveTvFilterSheet.svelte';
  import LiveTvGuideSheet from '$components/live-tv/LiveTvGuideSheet.svelte';
  import {
    getLiveTvChannels,
    getLiveTvGuide,
    resolveLiveTvPlayback,
    extractLiveTvCategories,
    filterLiveTvChannelsByCategory,
    filterLiveTvChannelsByQuery
  } from '$lib/client/live-tv/api';
  import { isLiveTvError, LiveTvError } from '$lib/client/live-tv/errors';
  import { isLiveTvPlaybackError, shouldFallbackToEmbed } from '$lib/client/live-tv/player-errors';
  import { LiveTvPlaybackEngine } from '$lib/client/live-tv/player';
  // Phase 5 — unified playback routing (behind the unified_enabled lever).
  // While the lever is FALSE (production default) the router never starts
  // and the legacy flow below runs byte-identical to the shipped page.
  // Phase 6 — the SAME module owns the ONE shared flag read; the catalogue
  // and guide loaders below consume it so there is exactly ONE flag, ONE
  // read path and ONE cache (never a second gate, never a page fetch).
  import { LiveTvPlaybackRouter, isUnifiedLivetvGateEnabled } from '$lib/client/live-tv/resolution-router';
  // Phase 6 — the flag-ON data surface: the merged canonical catalogue and
  // the Phase 3 mapping-contract guide (both bounded server endpoints; the
  // legacy LT-2 client above stays the flag-OFF surface, byte-identical).
  import { getUnifiedLivetvCatalogue, getUnifiedLivetvGuide } from '$lib/client/live-tv/unified-catalogue';
  import { determineCurrentProgramme, channelInitials } from '$lib/client/live-tv/epg';
  // Task 5 — recently-played channels (local, bounded, channel-id only).
  import { getRecentChannelIds, recordRecentChannel, removeRecentChannel, clearRecentChannels } from '$lib/client/live-tv/recent-channels';
  // 2026-10 round 5 — global background player store (persistent mini-player).
  import { setLiveTvSession, adoptLiveTvSession, clearLiveTvSession, updateLiveTvSessionEngine, updateLiveTvSessionChannel } from '$lib/client/live-tv/live-player-store.svelte';
  import {
    trackLiveTvOpen,
    trackLiveTvChannelAction,
    trackLiveTvPlay,
    trackLiveTvPause,
    trackLiveTvError,
    trackLiveTvFullscreen,
    trackLiveTvFallbackEmbed
  } from '$lib/client/live-tv/analytics';
  import type { LiveTvChannel, LiveTvGuide as LiveTvGuideModel } from '$lib/client/live-tv/types';
  import type { PageData } from './$types';

  // ---------------------------------------------------------------------
  // R-2 — SSR availability guard. `data.availability.available` is the
  // AUTHORITATIVE source ON/OFF contract: when false (no eligible public
  // source — every source OFF / non-eligible / non-public) the page renders
  // the honest unavailable state and NEVER calls the legacy LiveGT
  // catalogue path. This closes the R-1 regression where a disabled
  // LiveGT source could bypass the owner's decision through the legacy
  // fallback (the unified catalogue path already filtered by source.enabled
  // in R-1, but the legacy path ran unconditionally when the unified flag
  // was OFF — which is the production default).
  // ---------------------------------------------------------------------
  let { data } = $props<{ data: PageData }>();
  const availability = $derived(data.availability);
  const sourcesAvailable = $derived(availability?.available === true);
  // The bounded list of eligible public sources for the Source selector.
  const selectorSources = $derived(availability?.sources ?? []);
  /** The currently-applied source filter (null = All Sources). */
  let selectedSourceFilter = $state<string | null>(null);

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
    // R-3 — the SOURCE-FIRST catalogue. The page now uses the unified
    // catalogue endpoint unconditionally (no flag gate). The endpoint
    // returns channels from EVERY eligible public source (enabled +
    // playback-eligible status + visibility=public), regardless of the
    // `unified_enabled` flag. This closes the R-2 regression where turning
    // LiveGT OFF blanked JioHotstar/Sony channels (the legacy LiveGT API
    // doesn't know about playlist sources).
    //
    // The SSR availability guard still applies: when no eligible public
    // source exists, render the honest unavailable state and never fetch.
    if (!sourcesAvailable) {
      catalogueState = 'ready';
      channels = [];
      catalogueMessage = null;
      return;
    }
    catalogueController?.abort();
    const controller = new AbortController();
    catalogueController = controller;
    catalogueState = 'loading';
    catalogueMessage = null;
    try {
      // R-3 — the source-first catalogue. The optional sourceId filter
      // scopes the catalogue to ONE source's channels (the heading-row
      // Source selector). When null, all eligible sources contribute.
      const list = await getUnifiedLivetvCatalogue({ signal: controller.signal, sourceId: selectedSourceFilter });
      if (controller.signal.aborted) return; // superseded/unmounted — silent
      channels = list;
      catalogueState = 'ready';
      // Task 5: resolve the persisted recent channel IDs against the LIVE
      // catalogue (graceful: removed/unknown IDs simply drop out of the
      // row; the stored IDs stay untouched). Zero extra network requests —
      // this reads the catalogue that was just loaded.
    } catch (err) {
      if (controller.signal.aborted || isSilentAbort(err)) return;
      catalogueMessage = playbackSafeMessage(err);
      catalogueState = 'error';
    }
  }

  // ---------------------------------------------------------------------
  // Search + filters (LOCAL filtering only — LT-2 pure utilities).
  // LT-19: the category filter lives in the Filter sheet; it applies
  // immediately and composes with the toolbar search. Category values are
  // the ORIGINAL provider taxonomy (language-like values included as
  // ordinary categories; no separate language dimension).
  //
  // R-2 — the SOURCE filter. A channel belongs to a source when one of its
  // catalogue-provided alternatives carries that source's display name
  // (the alternatives' labels ARE the admin display names; never raw ids).
  // The filter is applied FIRST so the search/category filters compose on
  // the already-source-scoped list. In All Sources mode (null) every
  // channel remains visible — the deduplication model in R-1 already
  // guarantees no duplicate cards.
  // ---------------------------------------------------------------------
  let query = $state('');
  let category = $state(''); // '' = All
  let searchInputEl: HTMLInputElement | undefined = $state();

  // LT-18 sheet open state (page-owned; overlays, never page sections).
  let filterSheetOpen = $state(false);
  let guideSheetOpen = $state(false);
  // R-2 — the Source selector sheet (heading-row affordance).
  let sourceSheetOpen = $state(false);

  /**
   * R-2 — the active source filter's DISPLAY NAME (or null = All Sources).
   * Resolved from `selectorSources` by id so the catalogue's source labels
   * (the alternatives' `label` field) match exactly. Selecting a source
   * scopes the catalogue to that source's channels: a channel survives
   * the filter iff it carries an alternative whose label equals the
   * selected source's display name. The channel identity, guide and
   * recents are NEVER touched by the filter — only the visible set.
   */
  type AvailabilitySource = { id: string; name: string; builtin: boolean };
  const selectedSourceName = $derived.by<string | null>(() => {
    if (selectedSourceFilter === null) return null;
    const match = selectorSources.find((s: AvailabilitySource) => s.id === selectedSourceFilter);
    return match ? match.name : null;
  });
  /** The currently-displayed source label for the heading-row button. */
  const sourceSelectorLabel = $derived(selectedSourceName ?? 'All Sources');

  const categories = $derived(extractLiveTvCategories(channels));
  const visibleChannels = $derived.by(() => {
    // R-4 — the source filter is applied SERVER-SIDE (the sourceId query
    // param). The catalogue returned by the API is ALREADY scoped to the
    // selected source. The previous client-side label-match filter was
    // REDUNDANT and BROKEN: when the server scopes to one source, each
    // channel's `sources` (alternatives) array has only 1 entry, which is
    // < 2, so the `sources` field is OMITTED from the wire → the client
    // filter found no match → 0 channels. The server filter is the
    // authority; the client only applies category + search on top.
    let list = filterLiveTvChannelsByCategory(channels, category);
    const trimmed = query.trim();
    if (trimmed) list = filterLiveTvChannelsByQuery(list, trimmed);
    return list;
  });
  const filtersActive = $derived(Boolean(category) || selectedSourceFilter !== null);
  const activeFilterCount = $derived((category ? 1 : 0) + (selectedSourceFilter !== null ? 1 : 0));

  /**
   * R-3 — select a source from the heading-row Source selector. Switching
   * the source dimension is a CATALOGUE-CONTEXT change: the catalogue is
   * reloaded scoped to the selected source (the sourceId query param), the
   * selected-channel state is cleared when the current selection is no
   * longer in the filtered set (incompatible source), and any in-flight
   * catalogue/guide request is aborted to resist stale overwrites. The
   * selected source is preserved while browsing and selecting channels.
   */
  function applySourceFilter(sourceId: string | null): void {
    if (sourceId === selectedSourceFilter) {
      sourceSheetOpen = false;
      return;
    }
    selectedSourceFilter = sourceId;
    sourceSheetOpen = false;
    // R-3 — reload the catalogue scoped to the new source. The sourceId is
    // passed to the unified catalogue endpoint (the source-first path).
    void loadCatalogue();
    // If the current selection is no longer in the filtered set, clear it
    // (the user is now browsing a different source — the prior channel
    // is incompatible). The guide recents remain in storage; only the
    // active session is reset.
    if (selectedChannel) {
      const selectedId = selectedChannel.id;
      const stillVisible = visibleChannels.some((c) => c.id === selectedId);
      if (!stillVisible) {
        sessionController?.abort();
        destroyEngineSafely(engine);
        embedFallbackChannelId = null;
        unifiedEmbedSrc = null;
        selectedChannel = null;
        activeSourceId = null;
        sourceSwitchMessage = null;
        guide = null;
      }
    }
    resetVisibleLimit();
  }

  function clearSourceFilter(): void {
    applySourceFilter(null);
  }

  function toggleSourceSheet(): void {
    sourceSheetOpen = !sourceSheetOpen;
  }

  /** R-4 — close the source selector sheet WITHOUT changing the selection. */
  function closeSourceSheet(): void {
    sourceSheetOpen = false;
  }

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

  function resetFilters(): void {
    category = '';
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
  // Task 5 — RECENTLY PLAYED CHANNELS (local, bounded, ID-only).
  //
  // The row lives immediately BELOW the player and ABOVE the toolbar. The
  // store persists only catalogue channel IDs (never signed URLs, resolver
  // responses, tokens or credentials — see recent-channels.ts). The row's
  // channels are resolved against the ALREADY-LOADED catalogue — removed
  // IDs disappear gracefully and NO per-row network requests happen.
  // Selecting a recent channel reuses the existing selectChannel flow
  // (abort/destroy/resolve/load — no bypass of cancellation, playback-engine
  // lifecycle, geo/DRM handling or fallback behavior).
  // ---------------------------------------------------------------------
  let recentChannelIds = $state<string[]>([]);
  let recentClearArmed = $state(false);

  // Recent channels that still exist in the loaded catalogue, in recency
  // order. Derived — never stored — so a catalogue refresh (removed
  // channel, category change) is honored on the next render.
  const recentChannels = $derived.by(() => {
    if (channels.length === 0 || recentChannelIds.length === 0) return [];
    const byId = new Map(channels.map((channel) => [channel.id, channel]));
    const resolved: LiveTvChannel[] = [];
    for (const id of recentChannelIds) {
      const channel = byId.get(id);
      if (channel) resolved.push(channel);
    }
    return resolved;
  });

  function loadRecentFromStorage(): void {
    recentChannelIds = getRecentChannelIds();
  }

  // A successful PLAYBACK START (engine 'loaded') moves the channel to the
  // front — a selection that fails to resolve never pollutes the row.
  function rememberPlayedChannel(channel: LiveTvChannel): void {
    recentChannelIds = recordRecentChannel(channel.id);
  }

  function forgetRecentChannel(channelId: string): void {
    recentChannelIds = removeRecentChannel(channelId);
  }

  function clearAllRecentChannels(): void {
    recentChannelIds = clearRecentChannels();
    recentClearArmed = false;
  }

  // Task 5 — row overflow + arrow controls. The arrows exist ONLY when the
  // logos exceed the visible row width (TV/desktop); each press moves the
  // row by a meaningful amount (~80% of the visible width). The page can
  // never gain horizontal overflow: the row scrolls WITHIN its own box.
  let recentRowEl: HTMLElement | undefined = $state();
  let recentCanScrollLeft = $state(false);
  let recentCanScrollRight = $state(false);
  const recentOverflow = $derived(recentCanScrollLeft || recentCanScrollRight);
  const recentLogoFailed = new SvelteSet<string>();

  function updateRecentArrows(): void {
    const el = recentRowEl;
    if (!el) {
      recentCanScrollLeft = false;
      recentCanScrollRight = false;
      return;
    }
    recentCanScrollLeft = el.scrollLeft > 4;
    recentCanScrollRight = el.scrollLeft + el.clientWidth < el.scrollWidth - 4;
  }

  function scrollRecentRow(direction: -1 | 1): void {
    const el = recentRowEl;
    if (!el) return;
    el.scrollBy({ left: direction * Math.round(el.clientWidth * 0.8), behavior: 'smooth' });
  }

  // Keep the arrow state honest: when the row first renders, when the
  // recent list changes, and when the viewport resizes.
  $effect(() => {
    // Track the reactive inputs so the effect re-runs on change.
    void recentChannels.length;
    void recentRowEl;
    updateRecentArrows();
  });
  $effect(() => {
    if (typeof window === 'undefined') return;
    window.addEventListener('resize', updateRecentArrows);
    return () => window.removeEventListener('resize', updateRecentArrows);
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

  // LT-15 — automatic embed fallback state. `embedFallbackChannelId` is the
  // ONLY fallback signal: non-null exclusively while the documented LiveGT
  // embed player is mounted for the CURRENT channel after the native engine
  // genuinely failed. It carries a catalogue channel id (never a URL — the
  // player component builds the documented embed URL from the validated id
  // at render time; nothing about the fallback is ever persisted).
  let embedFallbackChannelId = $state<string | null>(null);
  // Bumped to force-recreate the embed iframe (user "Try again" while the
  // fallback is active — a fresh iframe mount, NEVER a new Shaka attempt).
  let embedReloadToken = $state(0);

  // ---------------------------------------------------------------------
  // Phase 5 — unified playback router state.
  //
  // `unifiedEmbedSrc` is the router-mounted embed iframe src (a VALIDATED
  // https URL from the server's bounded candidate list, or the documented
  // LiveGT embed URL built client-side). Non-null EXCLUSIVELY while the
  // unified router's embed candidate is the active playback surface. The
  // legacy `embedFallbackChannelId` above stays untouched by unified
  // sessions (one embed signal per mode; the component derives the final
  // src from both, legacy first).
  //
  // `playbackRouter` is created lazily on the first selection (a client
  // event path — never during SSR) and destroyed with the page.
  // ---------------------------------------------------------------------
  let unifiedEmbedSrc = $state<string | null>(null);
  let playbackRouter: LiveTvPlaybackRouter | null = null;

  // ---------------------------------------------------------------------
  // R-1 — source switching (the same channel, another provider).
  //
  // `activeSourceId` is the selection id the CURRENT stream was resolved
  // from: null = the default resolution for the card (the card id itself —
  // the canonical path for canonical groups, the preferred entry for
  // name-groups), or one of the card's catalogue-provided alternative
  // selection ids (`entry:<rowId>`) after an explicit switch. The CHANNEL
  // identity (card id, guide, recents, info line) never changes on a
  // switch — only the source does.
  //
  // `sourceSwitchMessage` is a NON-BLOCKING status line beside the Source
  // control: a failed switch reports there while the prior stream keeps
  // playing (the blocking player error overlay is reserved for sessions
  // where playback genuinely ended).
  // ---------------------------------------------------------------------
  let activeSourceId = $state<string | null>(null);
  let sourceSwitchMessage = $state<string | null>(null);

  /** The catalogue-provided switcher options (only when ≥2 usable exist). */
  const sourceOptions = $derived(selectedChannel?.sources ?? []);
  /** Whether the card anchors on a default (auto) resolution vs an entry. */
  const hasAutoSource = $derived(selectedChannel !== null && !selectedChannel.id.startsWith('entry:'));

  function handleSourceSwitch(event: Event): void {
    const select = event.currentTarget as HTMLSelectElement | null;
    const value = select?.value ?? '';
    if (!selectedChannel) return;
    const target = value === 'auto' ? null : value;
    void switchSource(selectedChannel, target, 0);
  }

  /**
   * Switch the active playback source for the CURRENT channel.
   *
   * Failure contract (plan §18.3):
   *   * The alternative is PROBED first (a read-only resolution through the
   *     same bounded endpoint) — a failure leaves the current stream
   *     completely untouched and reports a clear, non-technical message.
   *   * If the switch session itself exhausts (the probe passed but the
   *     stream failed), the page makes ONE bounded restore attempt of the
   *     previous selection; if that also fails, the honest retryable
   *     message is shown. The lifecycle always settles — the player can
   *     never be left permanently loading or black.
   *   * The channel identity, guide and recents are never touched.
   */
  async function switchSource(channel: LiveTvChannel, sourceId: string | null, restoreDepth: number): Promise<void> {
    const targetId = sourceId ?? channel.id;
    if (restoreDepth === 0 && targetId === activeSourceId) return; // no-op switch
    const seq = ++sessionSeq;
    const probeController = new AbortController();

    if (restoreDepth === 0) {
      sourceSwitchMessage = null;
      if (!playbackRouter) playbackRouter = createLivetvPlaybackRouter();
      // 1. Pre-resolve BEFORE touching current playback (read-only).
      let probeOk = false;
      try {
        probeOk = await playbackRouter.probeSelection(targetId, probeController.signal);
      } catch {
        probeOk = false;
      }
      if (seq !== sessionSeq) return; // superseded by a newer selection/switch — silent
      if (!probeOk) {
        sourceSwitchMessage = 'That source is not available right now. The current stream keeps playing.';
        return;
      }
    }

    // 2. Take over the session (the same lifecycle as a selection — a fresh
    //    resolution + engine; the stream material is never reused).
    const previousSourceId = activeSourceId;
    sessionController?.abort();
    const controller = new AbortController();
    sessionController = controller;
    activeSourceId = sourceId;
    resolving = true;
    sessionErrorMessage = null;

    if (!videoEl) {
      resolving = false;
      sourceSwitchMessage = 'Live TV playback could not start in this browser.';
      return;
    }
    if (!playbackRouter) playbackRouter = createLivetvPlaybackRouter();

    const outcome = await playbackRouter.start({ id: targetId, name: channel.name }, videoEl, controller.signal);
    if (seq !== sessionSeq || controller.signal.aborted) return; // superseded — silent

    if (outcome === 'legacy') {
      // The selection is not under unified management (e.g. the source was
      // disabled between listing and the switch — the resolver answered
      // honestly). One bounded restore attempt, then the honest message.
      resolving = false;
      await restoreAfterFailedSwitch(channel, previousSourceId, restoreDepth, seq);
      return;
    }
    if (playbackRouter.getState() === 'exhausted') {
      // The switch's stream genuinely failed after the engine swap — one
      // bounded restore attempt of the prior selection.
      resolving = false;
      await restoreAfterFailedSwitch(channel, previousSourceId, restoreDepth, seq);
      return;
    }
    if (restoreDepth > 0) sourceSwitchMessage = null; // restore succeeded
  }

  /** ONE bounded restore attempt after a failed switch (never a loop). */
  async function restoreAfterFailedSwitch(channel: LiveTvChannel, previousSourceId: string | null, restoreDepth: number, seq: number): Promise<void> {
    if (restoreDepth > 0 || seq !== sessionSeq) {
      sourceSwitchMessage = 'That source could not be played. Try another one.';
      return;
    }
    sourceSwitchMessage = 'That source could not be played. Restoring the previous one…';
    await switchSource(channel, previousSourceId, restoreDepth + 1);
  }

  const resolvingChannel = $derived(resolving ? selectedChannel : null);

  function destroyEngineSafely(target: LiveTvPlaybackEngine | null): void {
    // Idempotent (LT-3 contract); only clears the page reference if it still
    // points at THIS engine so a late continuation can never null a newer
    // session's engine.
    if (!target) return;
    target.destroy();
    if (engine === target) engine = null;
  }

  // ---------------------------------------------------------------------
  // LT-15 — automatic embed fallback activation.
  //
  // Invoked from EXACTLY ONE place: the current engine's 'error' event
  // subscription (which is the single point where BOTH load-phase and
  // mid-session native failures surface — the load() rejection that
  // follows a load-phase failure therefore never re-activates it).
  // Set-once per session: a second failure while the fallback is already
  // active is ignored (no double activation, no double analytics).
  // ---------------------------------------------------------------------
  function activateEmbedFallback(channel: LiveTvChannel, err: unknown): void {
    if (embedFallbackChannelId !== null) return; // already active — never twice
    // Abort/destroy the native session completely: the Shaka engine is
    // destroyed (single-owner rule) and the page stops resolving. Only the
    // embed iframe remains as the active playback mechanism.
    destroyEngineSafely(engine);
    resolving = false;
    // Suppress the native failure message — the fallback UI replaces it.
    sessionErrorMessage = null;
    embedFallbackChannelId = channel.id;
    embedReloadToken += 1; // fresh iframe mount
    // Analytics (LT-5/LT-15): channel id + normalized failure kind ONLY.
    trackLiveTvFallbackEmbed(channel.id, err);
  }

  async function selectChannel(channel: LiveTvChannel): Promise<void> {
    // Same-channel selection is an intentional retry: the whole flow reruns
    // with a FRESH resolution (never a reused one — LT-4 brief §19).
    const seq = ++sessionSeq;
    sessionController?.abort(); // kill the previous selection's resolve/load
    const controller = new AbortController();
    sessionController = controller;

    // 2026-10 round 3 — Task 3 fix: record the channel to Recently Played
    // IMMEDIATELY (before the playback attempt), regardless of whether the
    // stream is Direct or Embed. The previous implementation only recorded
    // on the engine 'loaded' event — a channel that failed to resolve or
    // took too long was never added. Now every selection is recorded; the
    // user sees their choice in the recents row instantly.
    rememberPlayedChannel(channel);

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

    // LT-15: every new selection starts from a FRESH native attempt — any
    // previous embed fallback is torn down with it (the iframe unmounts,
    // so no old embed player can keep playing in the background).
    embedFallbackChannelId = null;

    // Adopt the selection (non-sensitive catalogue metadata only).
    selectedChannel = channel;
    resolving = true;
    sessionErrorMessage = null;
    // R-1 — a fresh selection resets the source dimension: entry-anchored
    // cards default to their (preferred-entry) selection id; everything
    // else plays the default (auto) resolution. A non-blocking switch
    // message from a previous session is cleared with it.
    activeSourceId = channel.id.startsWith('entry:') ? channel.id : null;
    sourceSwitchMessage = null;

    // Guide for the new channel — independent of playback (§13).
    void loadGuide(channel);

    if (!videoEl) {
      // Structurally unreachable after mount; kept as a safe guard.
      resolving = false;
      sessionErrorMessage = 'Live TV playback could not start in this browser.';
      return;
    }

    // -------------------------------------------------------------------
    // R-6/R-7 — unified playback routing. The router handles ALL playback
    // for catalogue IDs (entry:<rowId> and canonical UUIDs). After R-3,
    // the catalogue is source-first — ALL channel IDs are registry-
    // governed identities that the legacy LiveGT V1 API does NOT
    // recognize. The legacy fallback is REMOVED.
    // -------------------------------------------------------------------
    if (!playbackRouter) {
      playbackRouter = createLivetvPlaybackRouter();
    }
    {
      const outcome = await playbackRouter.start(channel, videoEl, controller.signal);
      if (outcome === 'handled') return;
      // R-6 — the router returned 'legacy'. Show an honest error instead
      // of calling resolveLiveTvPlayback with a catalogue ID the LiveGT
      // V1 API can't recognize.
      if (seq !== sessionSeq || controller.signal.aborted) return;
      resolving = false;
      sessionErrorMessage = 'This channel could not be played right now. Try again.';
      trackLiveTvError(channel.id, new LiveTvError('server', {}));
    }
  }

  /**
   * Phase 5 — the page-owned playback router. The handlers map the
   * router's session events onto THIS page's existing state variables —
   * the same state the legacy flow drives (engine, resolving, safe error
   * message, embed mount) — so the player component cannot tell which
   * path is active. Analytics reuse the closed taxonomy inside the router.
   */
  function createLivetvPlaybackRouter(): LiveTvPlaybackRouter {
    return new LiveTvPlaybackRouter({
      // Optional external proxy (Cloudflare Worker) via PUBLIC_STREAM_PROXY_URL.
      streamProxyBase: publicEnv.PUBLIC_STREAM_PROXY_URL ?? '',
      handlers: {
        onengine: (eng) => {
          engine = eng;
          // 2026-10 round 5 — sync the global store's engine reference so
          // the mini-player can destroy it on Close.
          updateLiveTvSessionEngine(eng);
        },
        onresolving: (value) => {
          resolving = value;
        },
        onsessionerror: (message) => {
          sessionErrorMessage = message;
        },
        onembed: (src) => {
          unifiedEmbedSrc = src;
          if (src !== null) embedReloadToken += 1; // fresh iframe mount
        },
        onplayed: () => {
          // Same semantic as the legacy path: the session reached readiness
          // — this channel is the most recently PLAYED one. The 2026-10
          // round 3 fix already recorded the channel at selection time
          // (before the playback attempt), so this is now a no-op for the
          // recents row — kept for backward compatibility.
          if (selectedChannel) {
            rememberPlayedChannel(selectedChannel);
            // 2026-10 round 5 — sync the global store so the mini-player
            // shows the correct channel.
            updateLiveTvSessionChannel(selectedChannel);
            if (videoEl) setLiveTvSession(selectedChannel, videoEl, engine);
          }
        }
      }
    });
  }

  /** Phase 5 — the player component forwards the unified iframe load signal. */
  function handleUnifiedEmbedReady(): void {
    playbackRouter?.noteEmbedLoaded();
  }

  function retryPlayback(): void {
    // Phase 5 — unified embed fallback: EXACTLY the LT-15 remount-only
    // semantics (a fresh iframe mount of the SAME validated src; never a
    // new engine run while the fallback is the active surface).
    if (unifiedEmbedSrc !== null) {
      embedReloadToken += 1;
      return;
    }
    // LT-15: while the embed fallback is active for the selected channel,
    // "Try again" recreates the embed iframe ONCE (a fresh mount of the
    // documented embed URL) — it must NOT repeatedly instantiate Shaka.
    // Selecting any channel card remains the clean way to start a fully
    // fresh native session.
    if (selectedChannel && embedFallbackChannelId === selectedChannel.id) {
      embedReloadToken += 1;
      return;
    }
    if (selectedChannel) void selectChannel(selectedChannel);
  }

  // ---------------------------------------------------------------------
  // Guide state (per selected channel; failures never touch playback).
  // LT-18: the SAME state renders inside the Guide sheet — opening the
  // sheet never refetches; only a channel selection (or its Retry) does.
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
      // -----------------------------------------------------------------
      // R-3 — the SOURCE-FIRST guide. The page now uses the unified guide
      // endpoint unconditionally (no flag gate). The endpoint reads the
      // EPG tables directly through the ESTABLISHED Phase 3 mapping
      // contract, regardless of the `unified_enabled` flag. This closes
      // the R-2 "Live TV took too long to respond" regression for
      // JioHotstar/Sony channels: the legacy LiveGT guide API was being
      // called for non-LiveGT channel ids (`entry:<uuid>`), which it
      // doesn't recognize — causing timeouts and HTML 404 responses.
      //
      // A channel with no matching guide data honestly returns an empty
      // guide (now: null, upcoming: []) — never a fabricated programme,
      // never a timeout. The guide cache (30s TTL) is preserved.
      // -----------------------------------------------------------------
      const result = await getUnifiedLivetvGuide(channel.id, { signal: controller.signal });
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

  // 2026-10 round 7 — Task 7: Channel Share feature (deep linking).
  // Uses the native Web Share API when available; falls back to clipboard
  // copy. The deep link format is https://maveroweb.space/live-tv?channel=<id>.
  async function shareChannel(channel: LiveTvChannel): Promise<void> {
    const shareUrl = `${PRODUCTION_ORIGIN}/live-tv?channel=${encodeURIComponent(channel.id)}`;
    const shareText = `Watch ${channel.name} on Mavero Live TV`;
    if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
      try {
        await navigator.share({ title: 'Mavero Live TV', text: shareText, url: shareUrl });
        return;
      } catch {
        // User cancelled — silent, no error surface.
        return;
      }
    }
    // Fallback: copy to clipboard.
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      try {
        await navigator.clipboard.writeText(shareUrl);
      } catch { /* best-effort */ }
    }
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
    // Task 5: restore the persisted recent-channel IDs (channel objects are
    // resolved against the catalogue once it arrives).
    loadRecentFromStorage();
    nowTicker = setInterval(() => {
      nowSeconds = Math.floor(Date.now() / 1000);
    }, 30_000);

    // 2026-10 round 5 — adopt a leftover background session (the user
    // navigated away from /live-tv while a channel was playing, then came
    // back). The global store holds the session; the page takes ownership
    // by reading the video element + engine back into its own state. The
    // mini-player hides because this page is now mounted.
    const leftover = adoptLiveTvSession();
    if (leftover) {
      videoEl = leftover.videoEl;
      engine = leftover.engine;
      selectedChannel = leftover.channel;
      activeSourceId = leftover.channel.id.startsWith('entry:') ? leftover.channel.id : null;
      // Re-create the router so the session continues to work (the page's
      // router handlers wire onto the page's state variables).
      if (!playbackRouter) playbackRouter = createLivetvPlaybackRouter();
    }

    // 2026-10 round 7 — Task 7: deep-link auto-play. If the URL carries
    // ?channel=<id>, wait for the catalogue to load, then find that channel
    // and auto-select it so playback starts immediately. Uses a polling
    // approach (bounded to 10 attempts × 500ms = 5s max) to avoid the
    // Svelte 5 restriction on nested $effect inside $effect.root.
    const deepLinkedChannelId = appPage.url.searchParams.get('channel');
    if (deepLinkedChannelId) {
      let attempts = 0;
      const maxAttempts = 20;
      const poll = setInterval(() => {
        attempts++;
        if (catalogueState === 'ready' && channels.length > 0) {
          const target = channels.find((c) => c.id === deepLinkedChannelId);
          if (target) {
            clearInterval(poll);
            void selectChannel(target);
          } else if (attempts >= maxAttempts) {
            clearInterval(poll);
          }
        } else if (attempts >= maxAttempts) {
          clearInterval(poll);
        }
      }, 500);
    }
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
    // 2026-10 round 5 — Task 5: persistent background player. If a channel
    // is playing, hand the session to the GLOBAL store instead of destroying
    // it. The root layout renders a floating mini-player while the user is
    // away from /live-tv. The engine + video element stay alive in the
    // store; the page's own engine reference is released WITHOUT destroying
    // (destroyEngineSafely is NOT called when handing off to the store).
    if (selectedChannel && videoEl && (engine || unifiedEmbedSrc || embedFallbackChannelId)) {
      setLiveTvSession(selectedChannel, videoEl, engine);
      // The page releases its own references WITHOUT destroying the engine.
      // The store owns it now; the mini-player's Close button will destroy it.
      engine = null;
    } else {
      // No active playback — destroy the engine normally.
      destroyEngineSafely(engine);
    }
    // Phase 5: the unified router session dies with the page (engines,
    // timers, controllers, iframe — and the embed state it owns).
    // NOTE: do NOT destroy the router if we handed the session to the store
    // — the router's engine is still alive in the store. The router itself
    // is a page-level orchestrator; its engine reference was already moved
    // to the store. We null the page's router reference but leave the
    // engine alive.
    if (!selectedChannel || !videoEl) {
      playbackRouter?.destroy();
    }
    playbackRouter = null;
    unifiedEmbedSrc = null;
    // LT-15: the embed fallback dies with the page (the iframe unmounts
    // with the player component — nothing outlives the route).
    embedFallbackChannelId = null;
    if (nowTicker) clearInterval(nowTicker);
    nowTicker = undefined;
  });
</script>

<svelte:head>
  <title>Live TV — Mavero</title>
  <meta name="description" content="Browse and watch live TV channels in Mavero." />
  <link rel="canonical" href={`${PRODUCTION_ORIGIN}${appPage.url.pathname}`} /><!-- SEO: fixed production host -->
  <meta property="og:title" content="Live TV — Mavero" />
  <meta property="og:description" content="Browse and watch live TV channels in Mavero." />
  <meta property="og:url" content={`${PRODUCTION_ORIGIN}${appPage.url.pathname}`} /><!-- SEO follow-up: fixed production host -->
  <meta name="robots" content="noindex,follow" />
</svelte:head>

<div class="live-tv-page">
  <!-- 2026-10 round 6 — Task 4: the Source selector button is NO LONGER
       floating. It moved into the toolbar row (the last item after
       Search + Filter + Guide) for a cleaner layout. See the toolbar
       section below. -->

  <!-- R-4 — the Source selector bottom sheet (mobile) / popover (desktop).
       A single accessible dialog with a backdrop. On mobile it docks to
       the bottom (safe-area aware, internal scroll); on desktop it
       anchors to the top-right under the button. Closing the sheet
       preserves the current selection. -->
  {#if sourceSheetOpen}
    <div
      class="ltv-source-backdrop"
      role="presentation"
      onclick={closeSourceSheet}
      onkeydown={(e) => { if (e.key === 'Escape') closeSourceSheet(); }}
    ></div>
    <div class="ltv-source-dialog" role="dialog" aria-label="Choose a source" aria-modal="true">
      <div class="ltv-source-dialog-head">
        <span class="ltv-source-dialog-title">Source</span>
        <button type="button" class="ltv-source-dialog-close" onclick={closeSourceSheet} aria-label="Close source selector">
          <X size={16} aria-hidden="true" />
        </button>
      </div>
      <div class="ltv-source-dialog-list">
        <button
          type="button"
          class="ltv-source-option"
          class:active={selectedSourceFilter === null}
          onclick={() => applySourceFilter(null)}
        >
          <span class="ltv-source-option-label">All Sources</span>
          {#if selectedSourceFilter === null}<Check size={16} aria-hidden="true" />{/if}
        </button>
        {#each selectorSources as source (source.id)}
          <button
            type="button"
            class="ltv-source-option"
            class:active={selectedSourceFilter === source.id}
            onclick={() => applySourceFilter(source.id)}
          >
            <span class="ltv-source-option-label">{source.name}</span>
            {#if selectedSourceFilter === source.id}<Check size={16} aria-hidden="true" />{/if}
          </button>
        {/each}
      </div>
    </div>
  {/if}

  {#if !sourcesAvailable}
    <!-- R-2 — the SSR availability guard's honest unavailable state. No
         eligible public source exists (every source OFF / non-eligible /
         non-public); the legacy LiveGT catalogue path is NEVER loaded. The
         navbar also hides the link (defense in depth); the route guard is
         the authority. -->
    <section class="ltv-unavailable" aria-label="Live TV unavailable">
      <div class="ltv-unavailable-card">
        <Radio size={28} aria-hidden="true" />
        <h2 class="ltv-unavailable-title">Live TV is unavailable</h2>
        <p class="ltv-unavailable-message">No Live TV sources are turned on right now. Try again later.</p>
      </div>
    </section>
  {:else}
    <div class="ltv-body">
      <!-- 2026-10 round 2 — Task 2: Sticky player window. When a channel
           is active, the player + channel info row become sticky at the
           top so they stay visible while scrolling the channel list. When
           no channel is playing, they scroll normally. The sticky
           container has a solid background so content doesn't show
           through. z-index: 50 stays below the mobile bottom-nav (45)
           and the source sheet dialog (90+). -->
      <section class="ltv-player-column" class:sticky={selectedChannel !== null} aria-label="Live TV player and channel information">
        <LiveTvPlayer
          bind:video={videoEl}
          {engine}
          {resolvingChannel}
          {sessionErrorMessage}
          embedChannelId={embedFallbackChannelId}
          {embedReloadToken}
          unifiedEmbedSrc={unifiedEmbedSrc}
          onembedready={handleUnifiedEmbedReady}
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
          <!-- R-1 — the compact Source control (page-level player section,
               visible in native AND embed mode; the embed iframe surface
               itself stays Mavero-control-free per LT-18). Shown ONLY when
               the catalogue provides ≥2 usable alternatives; labels are
               provider display names, never raw ids. Switching keeps the
               SAME channel (guide, recents and info line untouched). -->
          {#if sourceOptions.length >= 2}
            <label class="ltv-source-switch">
              <span class="source-switch-label">Source</span>
              <select class="source-switch-select" value={activeSourceId ?? (hasAutoSource ? 'auto' : (sourceOptions[0]?.id ?? ''))} onchange={handleSourceSwitch} aria-label="Playback source for {selectedChannel.name}">
                {#if hasAutoSource}
                  <option value="auto">Auto</option>
                {/if}
                {#each sourceOptions as option (option.id)}
                  <option value={option.id}>{option.label}</option>
                {/each}
              </select>
            </label>
          {/if}
          {#if sourceSwitchMessage}
            <span class="source-switch-message" role="status">{sourceSwitchMessage}</span>
          {/if}
        </div>
      {/if}
    </section>

    <!-- Task 5 — RECENTLY PLAYED row: logos ONLY (no visible channel
         names), immediately below the player and ABOVE the toolbar.
         Hidden entirely when history is empty (no wasted vertical space).
         Items resolve against the live catalogue; selection reuses the
         existing selectChannel playback lifecycle. -->
    {#if recentChannels.length > 0}
      <section class="ltv-recent" aria-label="Recently played channels">
        <div class="recent-head">
          <span class="recent-title">Recently played</span>
          <div class="recent-tools">
            {#if recentClearArmed}
              <button class="recent-tool confirm" type="button" onclick={clearAllRecentChannels}>Confirm clear</button>
              <button class="recent-tool" type="button" onclick={() => (recentClearArmed = false)}>Keep</button>
            {:else}
              <button class="recent-tool" type="button" onclick={() => (recentClearArmed = true)} aria-label="Clear all recently played channels">Clear all</button>
            {/if}
            {#if recentOverflow}
              <button class="recent-arrow" type="button" onclick={() => scrollRecentRow(-1)} disabled={!recentCanScrollLeft} aria-label="Scroll recently played left"><ChevronLeft size={15} /></button>
              <button class="recent-arrow" type="button" onclick={() => scrollRecentRow(1)} disabled={!recentCanScrollRight} aria-label="Scroll recently played right"><ChevronRight size={15} /></button>
            {/if}
          </div>
        </div>
        <div class="recent-row" bind:this={recentRowEl} onscroll={updateRecentArrows}>
          {#each recentChannels as channel (channel.id)}
            <div class="recent-item">
              <button
                type="button"
                class="recent-logo-btn"
                class:selected={channel.id === selectedChannel?.id}
                onclick={() => void selectChannel(channel)}
                aria-label={`Play ${channel.name}`}
                aria-pressed={channel.id === selectedChannel?.id}
                title={channel.name}
              >
                {#if channel.logo && !recentLogoFailed.has(channel.id)}
                  <img src={channel.logo} alt="" loading="lazy" onerror={() => recentLogoFailed.add(channel.id)} />
                {:else}
                  <span class="recent-logo-fallback" aria-hidden="true">{channelInitials(channel.name)}</span>
                {/if}
              </button>
              <button type="button" class="recent-remove" aria-label={`Remove ${channel.name} from recently played`} onclick={() => forgetRecentChannel(channel.id)}>
                <X size={11} />
              </button>
            </div>
          {/each}
        </div>
      </section>
    {/if}

    <!-- LT-18 — the ONE compact toolbar row directly below the player:
         search (majority width) + Filter (active-state aware) + Guide
         (needs a selected channel). No category chips on the page. -->
    <section class="ltv-toolbar" aria-label="Channel tools">
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

      <button
        class="tool-btn"
        class:active={filtersActive}
        type="button"
        onclick={() => (filterSheetOpen = true)}
        aria-label="Filter channels"
        aria-haspopup="dialog"
        aria-expanded={filterSheetOpen}
      >
        <SlidersHorizontal size={15} />
        <span>Filter</span>
        {#if activeFilterCount > 0}
          <span class="tool-count" aria-label="{activeFilterCount} filters active">{activeFilterCount}</span>
        {/if}
      </button>

      <button
        class="tool-btn"
        type="button"
        onclick={() => (guideSheetOpen = true)}
        disabled={!selectedChannel}
        aria-label="Channel guide"
        aria-haspopup="dialog"
        aria-expanded={guideSheetOpen}
        title={selectedChannel ? 'Now playing and full guide' : 'Select a channel first'}
      >
        <BookOpen size={15} />
        <span>Guide</span>
      </button>

      <!-- 2026-10 round 6 — Task 4: the Source selector button is the LAST
           item in the toolbar row (after Search + Filter + Guide). Shown only
           when multiple sources are available. Uses the same .tool-btn style
           as Filter/Guide for visual consistency. -->
      {#if sourcesAvailable && selectorSources.length > 1}
        <button
          class="tool-btn"
          class:active={selectedSourceFilter !== null}
          type="button"
          onclick={toggleSourceSheet}
          aria-label="Select source. Current: {sourceSelectorLabel}"
          aria-haspopup="dialog"
          aria-expanded={sourceSheetOpen}
          title="Source: {sourceSelectorLabel}"
        >
          <Tv size={15} />
          <span>Source</span>
          {#if selectedSourceFilter !== null}
            <span class="tool-count" aria-label="Source filter active">1</span>
          {/if}
        </button>
      {/if}
    </section>

    <!-- Channel catalogue (respects search + category filters) -->
    <section class="ltv-channels" aria-label="Channels">
      <div class="channels-head">
        <h2 class="ltv-section-title">Channels</h2>
        {#if catalogueState === 'ready'}
          <span class="channels-count">{visibleChannels.length} of {channels.length}</span>
        {/if}
      </div>

      <!-- MAV-25 WS3 — the ONE vertically-scrolling region. On desktop/TV
           the right panel is height-constrained and ONLY this wrapper
           scrolls (overflow-y: auto with min-height: 0 in the desktop
           media query); the head, toolbar, player and app shell never
           move. On mobile/tablet it renders as a plain block and the
           existing stacked page scroll is unchanged. The Intersection-
           Observer sentinel keeps working in both compositions (the
           observer clips against ancestor scrollers, so the sentinel
           fires as the internal list approaches its end). -->
      <div class="channels-scroll">
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
                onshare={(c) => void shareChannel(c)}
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
      </div>
    </section>
  </div>
  {/if}
</div>

<!-- LT-18 — the filter + guide sheets: overlays, never page sections. -->
<LiveTvFilterSheet
  open={filterSheetOpen}
  {categories}
  selectedCategory={category}
  onclose={() => (filterSheetOpen = false)}
  onselectcategory={applyCategory}
  onreset={resetFilters}
/>
<LiveTvGuideSheet
  open={guideSheetOpen}
  channel={selectedChannel}
  {guide}
  {nowSeconds}
  loading={guideLoading}
  errorMessage={guideErrorMessage}
  onclose={() => (guideSheetOpen = false)}
  onretry={retryGuide}
/>

<ScrollToTop />

<style>
  .live-tv-page {
    --ltv-gutter: clamp(16px, 5vw, 48px);
    min-height: calc(100dvh - 76px);
    padding-bottom: 110px;
  }

  /* 2026-10 round 6 — Task 4: the .ltv-source-float + .ltv-source-icon-btn
     classes are GONE. The Source selector is now a .tool-btn in the toolbar
     row (same style as Filter/Guide). The icon-button CSS below is kept
     for reference but unused. */

  /* 2026-10 round 2 — Task 2: Sticky player window. When a channel is
     active (selectedChannel !== null), the player column becomes sticky
     at the top of the scroll container. The solid background prevents
     content from showing through during scroll. z-index: 50 stays below
     the mobile bottom-nav (45) is WRONG — the mobile bottom-nav is 45
     which is BELOW 50; but the bottom-nav is at the BOTTOM of the screen
     so there's no overlap. The source sheet (90+) and the filter/guide
     sheets (90+) stay above. The mobile topbar (var(--topbar-h)) is
     fixed at the top — the sticky top: 0 sits below it because the
     page-shell adds padding-top for the topbar. */
  .ltv-player-column.sticky {
    position: sticky;
    top: 0;
    z-index: 50;
    background: var(--color-bg);
    padding: 8px 0;
    margin: -8px 0;
  }

  /* 2026-10 round 1 — the .ltv-hero + .ltv-hero-inner + .ltv-heading
     classes were REMOVED (the heading is gone). The source icon button
     now floats at the top-right of the player column. The hero CSS is
     kept here for reference but unused — the unused-selector warnings
     are silenced by the :global() wrapper below. */

  /* 2026-10 round 6 — Task 4: the .ltv-source-icon-btn + .ltv-source-icon-dot
     CSS was REMOVED (the Source selector is now a .tool-btn in the toolbar).
     The source selector backdrop + dialog CSS below is still used. */
  .ltv-source-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, .5);
    z-index: 90;
    animation: ltv-source-fade .15s ease;
  }
  @keyframes ltv-source-fade { from { opacity: 0; } to { opacity: 1; } }
  .ltv-source-dialog {
    position: fixed;
    left: 0;
    right: 0;
    bottom: 0;
    max-height: 60vh;
    display: flex;
    flex-direction: column;
    background: var(--color-surface-1, var(--color-bg));
    border: 1px solid var(--color-border-strong, var(--color-border));
    border-radius: 16px 16px 0 0;
    box-shadow: 0 -8px 32px rgba(0, 0, 0, .4);
    z-index: 91;
    padding-bottom: env(safe-area-inset-bottom, 0);
    animation: ltv-source-slide .2s ease;
  }
  @keyframes ltv-source-slide { from { transform: translateY(100%); } to { transform: translateY(0); } }
  .ltv-source-dialog-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 14px 16px 10px;
    border-bottom: 1px solid var(--color-border);
    flex: 0 0 auto;
  }
  .ltv-source-dialog-title { font-size: 15px; font-weight: 600; color: var(--color-text); }
  .ltv-source-dialog-close {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    background: transparent;
    border: none;
    border-radius: 8px;
    color: var(--color-text-muted);
    cursor: pointer;
  }
  .ltv-source-dialog-close:hover { background: var(--color-surface-2); color: var(--color-text); }
  .ltv-source-dialog-close:focus-visible { outline: 2px solid var(--color-primary); outline-offset: 1px; }
  .ltv-source-dialog-list {
    overflow-y: auto;
    -webkit-overflow-scrolling: touch;
    padding: 6px;
    display: flex;
    flex-direction: column;
    gap: 2px;
    flex: 1 1 auto;
  }
  .ltv-source-option {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 12px 14px;
    background: transparent;
    border: none;
    border-radius: 10px;
    color: var(--color-text);
    font-size: 15px;
    font-weight: 500;
    cursor: pointer;
    text-align: left;
    min-height: 44px;
    transition: background .12s ease;
  }
  .ltv-source-option:hover { background: var(--color-surface-2, rgba(255,255,255,.06)); }
  .ltv-source-option:focus-visible { outline: 2px solid var(--color-primary); outline-offset: -2px; }
  .ltv-source-option.active { background: var(--color-primary-soft); color: var(--color-primary); }
  .ltv-source-option-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  /* Desktop ≥641px: popover anchored to the top-right (under the button). */
  @media (min-width: 641px) {
    .ltv-source-backdrop { background: rgba(0, 0, 0, .3); }
    .ltv-source-dialog {
      position: fixed;
      left: auto;
      right: max(16px, calc((100vw - 1040px) / 2));
      bottom: auto;
      top: 88px;
      width: min(320px, calc(100vw - 32px));
      max-height: 70vh;
      border-radius: 14px;
      box-shadow: 0 12px 36px rgba(0, 0, 0, .36);
      padding-bottom: 6px;
      animation: ltv-source-pop .15s ease;
    }
    @keyframes ltv-source-pop { from { opacity: 0; transform: translateY(-6px); } to { opacity: 1; transform: translateY(0); } }
    .ltv-source-dialog-head { padding: 12px 14px 8px; }
    .ltv-source-option { padding: 10px 12px; font-size: 14px; min-height: 40px; border-radius: 8px; }
  }

  /* R-2 — the honest unavailable state (no eligible public source). */
  .ltv-unavailable { padding: 60px var(--ltv-gutter); display: flex; justify-content: center; }
  .ltv-unavailable-card {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 12px;
    padding: 40px 28px;
    background: var(--color-surface-1, var(--color-bg));
    border: 1px solid var(--color-border);
    border-radius: 16px;
    max-width: 440px;
    text-align: center;
    color: var(--color-text-muted);
  }
  .ltv-unavailable-title { margin: 0; font-size: 1.15rem; color: var(--color-text); font-weight: 700; }
  .ltv-unavailable-message { margin: 0; font-size: 14px; line-height: 1.5; }

  /* 2026-10 round 1 — .ltv-heading + .heading-* classes removed (the
     heading is gone; the player sits at the top of the page). */

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
    gap: 22px;
    padding-top: 18px;
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

  /* ---- R-1 — the compact Source switch (page player section) ---- */
  .ltv-source-switch {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    flex: 0 0 auto;
    min-width: 0;
  }
  .source-switch-label {
    color: var(--color-text-muted);
    font-size: .68rem;
    font-weight: 800;
    letter-spacing: .1em;
    text-transform: uppercase;
  }
  .source-switch-select {
    max-width: 190px;
    min-width: 0;
    padding: 6px 26px 6px 10px;
    border: 1px solid var(--color-border);
    border-radius: 10px;
    background: var(--color-surface);
    color: var(--color-text);
    font-size: .78rem;
    font-weight: 700;
    text-overflow: ellipsis;
    cursor: pointer;
  }
  .source-switch-select:focus-visible {
    outline: 2px solid var(--color-accent, #4cc9f0);
    outline-offset: 2px;
  }
  .source-switch-message {
    flex: 1 1 100%;
    min-width: 0;
    color: var(--color-text-muted);
    font-size: .72rem;
    font-weight: 600;
    overflow-wrap: anywhere;
  }

  /* ---- Task 5 — recently played channels row ---- */
  .ltv-recent {
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-width: 0;
  }
  .recent-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    min-width: 0;
  }
  .recent-title {
    font-size: .72rem;
    font-weight: 700;
    letter-spacing: .08em;
    text-transform: uppercase;
    color: var(--muted, #9a93b0);
  }
  .recent-tools {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-shrink: 0;
  }
  .recent-tool {
    border: 1px solid var(--line, #2a2537);
    background: transparent;
    color: var(--muted, #9a93b0);
    border-radius: 999px;
    padding: 3px 10px;
    font-size: .7rem;
    font-weight: 600;
    cursor: pointer;
  }
  .recent-tool:hover { color: var(--ink, #f2f0f7); border-color: var(--line-strong, #3a3450); }
  .recent-tool.confirm { color: #ff8fa3; border-color: #ff8fa355; }
  .recent-arrow {
    display: grid;
    place-items: center;
    width: 26px;
    height: 26px;
    border: 1px solid var(--line, #2a2537);
    border-radius: 50%;
    background: rgba(0, 0, 0, .35);
    color: var(--ink, #f2f0f7);
    cursor: pointer;
  }
  .recent-arrow:disabled { opacity: .35; cursor: default; }
  /* The row scrolls WITHIN its own box — the page never gains horizontal
     overflow (Task 5). Touch scrolling is native; desktop users get the
     arrow controls above (shown only when the content overflows). */
  .recent-row {
    display: flex;
    gap: 12px;
    overflow-x: auto;
    scrollbar-width: none;
    padding-bottom: 2px;
    -webkit-overflow-scrolling: touch;
  }
  .recent-row::-webkit-scrollbar { display: none; }
  .recent-item {
    position: relative;
    flex-shrink: 0;
    width: 64px;
    height: 64px;
  }
  .recent-logo-btn {
    width: 64px;
    height: 64px;
    display: grid;
    place-items: center;
    padding: 8px;
    border: 1px solid var(--line, #2a2537);
    border-radius: 12px;
    background: var(--surface, #17131f);
    cursor: pointer;
    transition: border-color 120ms ease, transform 120ms ease;
  }
  .recent-logo-btn:hover { border-color: var(--accent, #9b87f5); transform: translateY(-1px); }
  .recent-logo-btn.selected { border-color: var(--accent, #9b87f5); box-shadow: 0 0 0 1px var(--accent, #9b87f5); }
  .recent-logo-btn img { max-width: 100%; max-height: 100%; object-fit: contain; }
  .recent-logo-fallback {
    font-size: .72rem;
    font-weight: 700;
    color: var(--muted, #9a93b0);
  }
  .recent-remove {
    position: absolute;
    top: -5px;
    right: -5px;
    display: grid;
    place-items: center;
    width: 18px;
    height: 18px;
    padding: 0;
    border: 1px solid var(--line, #2a2537);
    border-radius: 50%;
    background: rgba(0, 0, 0, .8);
    color: var(--muted, #9a93b0);
    cursor: pointer;
  }
  .recent-remove:hover { color: #ff8fa3; border-color: #ff8fa355; }

  /* ---- LT-18 toolbar: one row, search-first ---- */
  .ltv-toolbar {
    display: flex;
    align-items: center;
    gap: 10px;
    min-width: 0;
  }
  .ltv-search {
    display: flex;
    align-items: center;
    gap: 12px;
    flex: 1 1 auto;
    min-width: 0;
    height: 48px;
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

  .tool-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 7px;
    flex: 0 0 auto;
    min-height: 48px;
    padding: 0 15px;
    border: 1px solid var(--color-border-strong);
    border-radius: var(--radius-md);
    color: var(--color-text-muted);
    background: var(--color-surface);
    font: inherit;
    font-size: .8rem;
    font-weight: 800;
    letter-spacing: .01em;
    white-space: nowrap;
    cursor: pointer;
    transition: color var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out), background var(--motion-fast) var(--ease-out), box-shadow var(--motion-fast) var(--ease-out);
  }
  .tool-btn:hover:not(:disabled) {
    color: var(--color-text);
    border-color: var(--color-text-muted);
  }
  .tool-btn:active:not(:disabled) { transform: scale(.97); }
  .tool-btn:disabled { opacity: .4; cursor: default; }
  .tool-btn:focus-visible { outline: 2px solid var(--color-focus); outline-offset: 2px; }
  .tool-btn.active {
    color: var(--color-primary);
    border-color: var(--color-primary-border);
    background: var(--color-primary-soft);
    box-shadow: var(--glow-primary);
  }
  .tool-count {
    display: grid;
    place-items: center;
    min-width: 20px;
    height: 20px;
    padding: 0 6px;
    border-radius: 999px;
    color: #050708;
    background: var(--color-primary);
    font-size: .66rem;
    font-weight: 800;
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
  .ltv-channels { display: grid; gap: 12px; min-width: 0; min-height: 0; }
  .channels-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 12px;
  }
  .channels-count { color: var(--color-text-deep); font-size: .72rem; font-weight: 700; white-space: nowrap; }

  /* MAV-25 WS3 — the ONE vertically-scrolling region of the page. On
     mobile/tablet it is a plain block (the page scrolls as before); the
     desktop/TV media query below turns it into the right panel's
     internal scrollport. */
  .channels-scroll { min-width: 0; min-height: 0; }

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
    .ltv-body { width: min(100% - 28px, 1040px); gap: 18px; padding-top: 14px; }
    .channel-grid { grid-template-columns: 1fr; }
    .ltv-toolbar { gap: 8px; }
    .ltv-search { height: 44px; gap: 8px; padding-left: 12px; }
    .tool-btn { min-height: 44px; padding: 0 12px; font-size: .76rem; }
    .tool-btn span { display: none; }
    .tool-btn .tool-count { display: grid; }
  }

  /* ============================================================
     MAV-25 WS3 — DESKTOP/TV 70/30 LAYOUT (≥1280px only).
     -----------------------------------------------------------------
     Approved design: ~70% of the available content width for the
     player area (left), ~30% for channel controls + channel list
     (right); search/filter/guide visible at the top of the right
     panel; ONLY the channel-list region scrolls vertically; the page
     fits the desktop viewport without unnecessary outer scrolling.

     Breakpoint choice: the application desktop shell starts at 1025px,
     but below ~1280px the fixed 240px sidebar leaves a content area
     whose 30% falls under the right panel's practical minimum
     (~320px). 1025–1279px therefore keeps the EXISTING stacked layout
     unchanged (the safe fallback — phone/tablet compositions are
     untouched below 1025px as before).

     Scroll ownership (verified in the Phase 0 audit): on desktop the
     app shell's `.app-main` is the page scroll container (height:
     100dvh, overflow-y: auto). The page therefore sizes itself to
     exactly one .app-main viewport (height: 100dvh, flex column) so
     NOTHING overflows into an outer scrollbar, and the right panel's
     `.channels-scroll` becomes the single internal scrollport
     (overflow-y: auto + min-height: 0 inside the minmax(0, 1fr) grid
     row). No global overflow: hidden anywhere — if content ever
     overflows (error states, browser zoom), .app-main scrolls
     gracefully instead of trapping anyone.

     Grid areas keep the DOM order (title → player → toolbar →
     channels) untouched — the two-column arrangement is purely a
     desktop placement over the same elements, so the existing phone
     layout and the page-order contracts are preserved byte-for-byte.
     ============================================================ */
  @media (min-width: 1280px) {
    .live-tv-page {
      height: 100dvh;
      display: flex;
      flex-direction: column;
      /* No mobile bottom-pill clearance on desktop (the pill does not
         exist ≥1025px) — the page fits one shell viewport exactly. */
      padding-bottom: 24px;
      min-height: 0;
    }
    .ltv-body {
      flex: 1 1 auto;
      min-height: 0;
      width: min(1720px, calc(100% - clamp(24px, 3vw, 64px)));
      display: grid;
      grid-template-columns: minmax(0, 70fr) minmax(320px, 30fr);
      grid-template-rows: auto minmax(0, 1fr);
      grid-template-areas:
        'player rail-tools'
        'player rail-list';
      gap: 14px 22px;
      padding-top: 18px;
    }
    .ltv-player-column {
      grid-area: player;
      align-content: start;
      min-height: 0;
    }
    /* The right panel header/control group (search + Filter + Guide):
       always visible, never scrolls. */
    .ltv-toolbar { grid-area: rail-tools; }
    .ltv-channels {
      grid-area: rail-list;
      display: flex;
      flex-direction: column;
      gap: 12px;
      min-height: 0;
      min-width: 0;
    }
    .channels-head { flex: 0 0 auto; }
    /* The ONE scrolling region: the channel list itself. */
    .channels-scroll {
      flex: 1 1 auto;
      min-height: 0;
      min-width: 0;
      overflow-y: auto;
      /* A hair of bottom padding so the last channel card never sits
         flush against the shell edge while scrolling. */
      padding-bottom: 6px;
      overscroll-behavior: contain;
      scrollbar-width: thin;
      scrollbar-color: var(--color-border-strong, rgba(255, 255, 255, .2)) transparent;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .sk-line { animation: none; }
    .channels-more :global(svg) { animation: none; }
    .info-live .live-dot { animation: none; }
  }
</style>
