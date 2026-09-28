<script lang="ts">
  import { browser } from '$app/environment';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { onDestroy, onMount } from 'svelte';
  import PlayerShell from '$lib/components/player/PlayerShell.svelte';
  import type { PlayerEpisode, PlayerEpisodeTarget, PlayerProgressEvent, PlayerSource, PlayerSourceOption } from '$lib/shared/player';
  import { resolveSandboxRuntime } from '$lib/shared/sandbox-policy';
  import { appendReturnTo, safeReturnTo } from '$lib/shared/navigation';
  import type { PageData } from './$types';
  import { createProgressWriter, getLocalPersistenceState, getResumeProgress, setFavoriteStatus } from '$lib/client/progress/service';
  import { recordCloudHistory, syncAuthenticatedState } from '$lib/client/progress/cloud';
  import type { PlaybackContext } from '$lib/client/progress/types';
  import { PlaybackManager, type ResolutionState } from '$lib/client/player/PlaybackManager';
  import { isSourceBadge } from '$lib/shared/source-presentation';
  import { track as trackAnalytics } from '$lib/client/analytics/dispatcher';

  export let data: PageData;

  $: item = data.item;
  // The canonical `contentType` for the URL and progress keys stays as the
  // original route type ('movie', 'series', or 'anime'). This preserves
  // progress identity, My List keys, and Continue Watching.
  //
  // Anime content now comes from TMDB (TMDB TV series flagged as anime via
  // genre 16 + 'ja'). The resolver request's `mediaType` is `contentType`
  // directly — anime content with `contentType='series'` (the typical case
  // for TMDB-tagged anime series) routes through the normal series pipeline.
  // The legacy `/watch/anime/{id}` URL path still works for backward
  // compatibility with deep links but is no longer produced by the UI.
  $: contentType = (page.params.type === 'series' || page.params.type === 'anime' ? page.params.type : 'movie') as 'movie' | 'series' | 'anime';
  let season = Number(page.url.searchParams.get('season') || '') || undefined;
  let episode = Number(page.url.searchParams.get('episode') || '') || undefined;
  $: currentEpisode = season !== undefined && episode !== undefined ? data.episodes.find((candidate) => candidate.season === season && candidate.number === episode) : undefined;
  $: playbackContext = ({ contentType, contentId: item.id, season, episode, episodeTitle: currentEpisode?.title } satisfies PlaybackContext);
  $: playbackKey = [playbackContext.contentType, playbackContext.contentId, playbackContext.season ?? '-', playbackContext.episode ?? '-'].join(':');
  // Source options are built directly from the public streaming config. The
  // MegaPlay-style SUB/DUB variant toggle was removed alongside the Yenime
  // anime provider — all sources are now opaque options selected by name.
  //
  // The legacy "MAVERO Player" virtual source was removed in Phase 1 of the
  // Vidara + Abyss hosting implementation. The Stremio addon DOWNLOADER
  // surface (Download sheet, external player / download) is the dedicated
  // path for Stremio addon direct files; the native player no longer has an
  // addon-streams entry in the embed/source selector.
  // Task 13: PRIMARY category assignment + category-specific ordering.
  //
  // The public config's sourceCategories mapping can assign ONE source to
  // MULTIPLE categories, but the option model carries a single categoryName
  // (existing semantics). The primary assignment is the mapping whose
  // category comes FIRST in the category registry order — deterministic for
  // multi-assigned sources (previously it was whichever row happened to sort
  // first in a globally-mixed ordering array).
  type SourceCategoryAssignment = { categoryId: string; categoryName: string; ordering: number };
  $: categoryRankById = new Map<string, number>((data.streamingConfig.categories ?? []).map((category, index) => [category.id, index]));
  $: primaryAssignmentBySourceId = (() => {
    const primary = new Map<string, SourceCategoryAssignment>();
    for (const mapping of data.streamingConfig.sourceCategories ?? []) {
      const rank = categoryRankById.get(mapping.category_id);
      if (rank === undefined) continue; // mapping whose category is not public — not renderable
      const existing = primary.get(mapping.source_id);
      const existingRank = existing ? categoryRankById.get(existing.categoryId) : undefined;
      if (existing && existingRank !== undefined && existingRank <= rank) continue;
      const category = (data.streamingConfig.categories ?? []).find((candidate) => candidate.id === mapping.category_id);
      primary.set(mapping.source_id, { categoryId: mapping.category_id, categoryName: category?.name ?? 'Other', ordering: mapping.ordering });
    }
    return primary;
  })();

  // Task 13: category-order-aware option list.
  //   * GROUP order = first appearance in the global source list (previous
  //     behavior preserved; "Other" still moves to the end in PlayerShell).
  //   * WITHIN a group = the category-specific assignment ordering
  //     (streaming_source_categories.ordering). This was previously LOST —
  //     options rendered in global source order inside every group, so an
  //     admin's category reorder never reached the player. It is now derived
  //     here (the watch route owns sourceOptions) so PlayerShell stays
  //     presentation-only.
  //   * Unassigned sources keep the global source order and render in the
  //     trailing "Other" group.
  // Badge/icon are presentation metadata copied straight from the public
  // config (constrained badge enum; safe icon key with render fallback).
  $: sourceOptions = (() => {
    const options: PlayerSourceOption[] = data.streamingConfig.sources.map((source) => {
      const provider = data.streamingConfig.providers.find((provider) => provider.id === source.provider_id);
      const assignment = primaryAssignmentBySourceId.get(source.id);
      const option: PlayerSourceOption = {
        id: source.id,
        name: source.name,
        status: source.status,
        integrationType: source.integration_type ?? undefined,
        // Phase 11 (GOAL D): the option carries the EFFECTIVE policy resolved
        // server-side from the public config (source override → provider
        // default → system default). `resolveSandboxRuntime` exposes the
        // configured-vs-effective provenance in one place; the option and
        // the resolved source always agree.
        sandboxPolicy: resolveSandboxRuntime(provider?.capabilities, source.capabilities).effectiveSandboxPolicy,
        categoryName: assignment?.categoryName,
        // Guarded copy: only the constrained enum values ever reach the
        // option — unknown/legacy badge values render no badge.
        badge: isSourceBadge(source.badge) ? source.badge : undefined,
        icon: source.icon ?? undefined,
      };
      return option;
    });
    const groupFirstSeen = new Map<string, number>();
    options.forEach((option, index) => {
      const assignment = option.id ? primaryAssignmentBySourceId.get(option.id) : undefined;
      if (assignment && !groupFirstSeen.has(assignment.categoryId)) groupFirstSeen.set(assignment.categoryId, index);
    });
    const groupRank = (option: PlayerSourceOption): number => {
      const assignment = primaryAssignmentBySourceId.get(option.id);
      if (!assignment) return Number.MAX_SAFE_INTEGER;
      return groupFirstSeen.get(assignment.categoryId) ?? Number.MAX_SAFE_INTEGER;
    };
    return options
      .map((option, index) => ({ option, index }))
      .sort((a, b) => {
        const rankA = groupRank(a.option);
        const rankB = groupRank(b.option);
        if (rankA !== rankB) return rankA - rankB;
        const assignmentA = primaryAssignmentBySourceId.get(a.option.id);
        const assignmentB = primaryAssignmentBySourceId.get(b.option.id);
        // Same category group → category-specific ordering decides.
        if (assignmentA && assignmentB && assignmentA.categoryId === assignmentB.categoryId) return assignmentA.ordering - assignmentB.ordering;
        return a.index - b.index; // stable for ties / unassigned sources
      })
      .map((entry) => entry.option);
  })();
  $: episodes = data.episodes.map((candidate) => ({ id: candidate.id, number: candidate.number, season: candidate.season, title: candidate.title, overview: candidate.overview, runtime: candidate.runtime, still: candidate.still })) satisfies PlayerEpisode[];
  $: playerContent = ({ id: item.id, type: contentType, title: item.title, poster: item.poster, backdrop: item.backdrop });

  // ----- Phase 1: PlaybackManager owns source resolution + adapter lifecycle -----
  //
  // The manager is the single authoritative owner of:
  //   - resolvedSource
  //   - resolutionState / resolutionMessage / errorCode
  //   - resolver invocation (POST /api/playback/resolve)
  //   - race-condition guards (sessionId, abortController)
  //   - adapter lifecycle (load, destroy)
  //
  // The watch route retains (per Phase 1 scope):
  //   - selectedSourceId (Phase 0 first-source selection — preserved exactly)
  //   - progress writer (writer.update/flush — preserved per Phase 4 boundary)
  //   - Viduki V1→V2 listener (preserved — Phase 3 will move into adapter)
  //   - episode navigation (goto URL sync — preserved)
  //   - resume time (loaded into manager via startPosition on loadSource)
  //
  // Reactive Svelte 4 `let` locals mirror manager state so PlayerShell's
  // existing props continue to work without modification. The manager
  // notifies subscribers on every state patch; this route's subscriber
  // copies the snapshot into these locals.
  const manager = new PlaybackManager();
  let resolvedSource: PlayerSource | null = null;
  let resolutionState: ResolutionState = 'idle';
  let resolutionMessage = '';
  let active = true;
  let resumeTime = 0;
  let duration = 0;
  // Cross-device conflict resolution: the positionUpdatedAt from the
  // existing progress record. Passed to createProgressWriter so
  // runtime-only flushes preserve the position-freshness timestamp
  // instead of stamping now (which would make a stale-position record
  // look fresher than a real-position record from another device).
  let currentPositionUpdatedAt = 0;
  let progressReady = false;
  let localState = 'Preparing local progress…';
  let writer: ReturnType<typeof createProgressWriter> | undefined;
  let writerKey = '';
  let startedHistory = false;
  let lastHistoryAt = 0;
  // Phase 1 Analytics Foundation — playback-event state (parallel to
  // startedHistory / lastHistoryAt but for analytics, which fires for
  // guests too). Reset on playbackKey change (episode switch).
  let analyticsStartedEmitted = false;
  let lastAnalyticsProgressAt = 0;
  let watchingSavedForSession = false;
  let activePlaybackKey = '';
  let selectedSourceId = '';
  // Phase 2: admin-configured default source id for the current content type.
  let defaultSourceId: string | undefined;
  // Phase 4: saved last-successful source from progress record. Used for
  // resume source selection: saved → admin default → health-ranked fallback.
  let savedSourceId: string | undefined;
  // Phase 4: resume-once flag. Prevents repeated seeks when timeupdate events
  // arrive after the resume position has already been applied. Reset on
  // source switch and episode change.
  let resumeApplied = false;
  // Phase 4: the current playback position, tracked from BOTH direct
  // (handlePlayerProgress) and embed (manager.onEvent) sources. Used to
  // pass the timestamp to the new source when manually switching.
  let currentPlaybackTime = 0;
  // Phase 6 audit fix: embed playback event sink + sequence counter. Pushed
  // into PlayerShell via the embedPlaybackEvent prop whenever the
  // PlaybackManager receives a normalized provider play/pause/ended event.
  // The sourceId field lets PlayerShell reject stale events from an old source
  // after a source switch — the PlaybackManager has its own session guards,
  // but a stale postMessage could still arrive between the source switch and
  // the adapter destroy. Including selectedSourceId here is a safety net.
  let embedPlaybackEvent: { type: 'play' | 'pause' | 'ended'; _seq: number; sourceId?: string } | null = null;
  let embedPlaybackSeq = 0;

  // Subscribe to manager state so the route's reactive locals mirror the
  // manager snapshot. PlayerShell receives these via its existing props.
  const unsubscribeManager = manager.subscribe((snapshot) => {
    resolvedSource = snapshot.source as PlayerSource | null;
    resolutionState = snapshot.resolutionState;
    resolutionMessage = snapshot.resolutionMessage;
    if (snapshot.duration && snapshot.duration !== duration) duration = snapshot.duration;
  });

  // Forward manager playback events to the existing progress writer.
  // Phase 4: this is the UNIFIED progress pipeline for embed sources.
  // Direct sources use handlePlayerProgress (from PlayerShell's onProgress
  // callback) — both paths write to the same ProgressWriter. No double
  // writes because direct sources never emit manager events (the manager's
  // dispatchViewportEvent is never called for direct sources — PlayerShell
  // handles direct video events internally).
  const unsubscribeManagerEvents = manager.onEvent((event) => {
    if (event.type === 'timeupdate' || event.type === 'seeked') {
      const ct = event.currentTime;
      currentPlaybackTime = ct;
      // P1 fix: only use event.duration if it's a valid positive number.
      // A duration=0 or undefined from a provider must NOT erase a
      // previously-persisted valid duration.
      const eventDur = event.type === 'timeupdate' && typeof event.duration === 'number' && event.duration > 0 ? event.duration : undefined;
      const currentDuration = eventDur ?? duration;
      if (currentDuration && currentDuration !== duration) duration = currentDuration;
      // BUG #8 fix: no implicit 90% completion — only the explicit 'ended'
      // event (handled below) marks a record as completed. A movie watched
      // to 90/95/99% but not finished must remain resumable.
      writer?.update(ct, currentDuration, false);
    } else if (event.type === 'pause') {
      void writer?.pause();
    } else if (event.type === 'ended') {
      const ct = manager.getState().currentTime || currentPlaybackTime;
      void writer?.complete(ct, duration);
    }
    // BUG #9 fix: handle 'duration' and 'ready' events to persist the
    // provider's reported duration EVEN IF no timeupdate has fired yet.
    // Without this, a user who pauses/closes within the first 5 seconds
    // (before the first throttled timeupdate) would persist duration=0,
    // losing the progress bar and remaining-time label.
    // The writer.updateRuntime() method already exists (service.ts ~line 500)
    // and correctly updates lastKnownDuration + sourceRuntimes + schedules a flush.
    if (event.type === 'duration' || event.type === 'ready') {
      const dur = event.type === 'duration' ? event.duration : (event.type === 'ready' && 'duration' in event ? (event as { duration?: number }).duration : undefined);
      if (typeof dur === 'number' && Number.isFinite(dur) && dur > 0 && dur !== duration) {
        duration = dur;
        const sourceId = manager.getSource()?.sourceId ?? selectedSourceId;
        writer?.updateRuntime(sourceId, dur);
      }
    }
    // Phase 6 audit fix: forward normalized embed playback events (play/pause/ended)
    // to PlayerShell via the embedPlaybackEvent prop. PlayerShell uses these to
    // acquire/release the Wake Lock conservatively — only when the provider
    // actually reports playback state changes, NOT merely on iframe DOM load.
    // The _seq counter forces Svelte to re-trigger the reactive block even if
    // the same event type fires twice in a row. The sourceId field lets
    // PlayerShell reject stale events from an old source after a source switch.
    if (event.type === 'play' || event.type === 'pause' || event.type === 'ended') {
      embedPlaybackSeq++;
      embedPlaybackEvent = { type: event.type, _seq: embedPlaybackSeq, sourceId: resolvedSource?.sourceId ?? selectedSourceId };
    }
    // Authenticated history bookkeeping (preserved from Phase 0).
    if (page.data.user) {
      if ((event.type === 'timeupdate' || event.type === 'play') && !startedHistory) {
        const currentTime = 'currentTime' in event ? event.currentTime : 0;
        if (currentTime > 0) {
          startedHistory = true;
          void sendHistory('started', currentTime, duration);
        }
      }
      if (event.type === 'timeupdate') {
        const currentTime = event.currentTime;
        if (currentTime - lastHistoryAt >= 60) {
          lastHistoryAt = currentTime;
          void sendHistory('progressed', currentTime, duration);
        }
      }
      if (event.type === 'ended') {
        const currentTime = manager.getState().currentTime;
        const snapshot = { title: item.title, poster: item.poster, backdrop: item.backdrop, year: item.year, runtime: item.runtime, rating: item.rating, genres: item.genres, description: item.description };
        void setFavoriteStatus(contentType, item.id, snapshot, 'completed').then(() => void syncAuthenticatedState());
        void sendHistory('completed', currentTime, duration);
      }
    }
    // Phase 1 Analytics Foundation — client-side playback events. These
    // fire for BOTH guests and authenticated users (no `page.data.user`
    // gate) so guest watch activity is captured. The dispatcher
    // silently no-ops if analytics is disabled or anonymous_id is not
    // set. event_id is generated by the dispatcher (idempotency).
    if (event.type === 'timeupdate' || event.type === 'play') {
      const currentTime = 'currentTime' in event ? event.currentTime : 0;
      if (currentTime > 0 && !analyticsStartedEmitted) {
        analyticsStartedEmitted = true;
        trackAnalytics('watch_start', {
          content_id: item.id,
          content_type: contentType,
          provider_id: resolvedSource?.providerId,
          source_id: resolvedSource?.sourceId ?? (selectedSourceId || undefined),
          metadata: { season, episode, title: item.title },
        });
      }
    }
    if (event.type === 'timeupdate') {
      const currentTime = 'currentTime' in event ? event.currentTime : 0;
      if (currentTime - lastAnalyticsProgressAt >= 60) {
        lastAnalyticsProgressAt = currentTime;
        trackAnalytics('watch_progress', {
          content_id: item.id,
          content_type: contentType,
          provider_id: resolvedSource?.providerId,
          source_id: resolvedSource?.sourceId,
          metadata: { season, episode, position_seconds: Math.floor(currentTime), duration: duration || undefined },
        });
      }
    }
    if (event.type === 'ended') {
      const currentTime = manager.getState().currentTime;
      trackAnalytics('watch_complete', {
        content_id: item.id,
        content_type: contentType,
        provider_id: resolvedSource?.providerId,
        source_id: resolvedSource?.sourceId,
        metadata: { season, episode, position_seconds: Math.floor(currentTime), duration: duration || undefined },
      });
    }
  });

  $: if (browser && playbackKey !== activePlaybackKey) {
    activePlaybackKey = playbackKey;
    // Episode changed — reset the manager session so a stale in-flight
    // resolution cannot overwrite the new episode's state.
    manager.reset();
    progressReady = false;
    watchingSavedForSession = false;
    resumeApplied = false;
    currentPlaybackTime = 0;
    // Phase 4: clear savedSourceId so the new episode's progress record
    // is loaded fresh (different episode = different progressKey).
    savedSourceId = undefined;
    // Phase 1 Analytics: reset playback-event state so the new episode
    // emits a fresh watch_start and the progress cadence restarts.
    analyticsStartedEmitted = false;
    lastAnalyticsProgressAt = 0;
  }
  $: if (browser && playbackKey !== writerKey) void setupProgressContext();
  // Phase 2: select the admin-configured default source for this content type
  // as the initial source. Falls back to sourceOptions[0].id (Phase 0/1
  // behavior) when no default is configured or the default source is not in
  // the public sources list (the public config reader already filtered out
  // invalid/disabled defaults, so a present default is guaranteed eligible).
  // The default is only used for the INITIAL selection — manual source
  // switches set selectedSourceId directly and pass allowFallback=false, so
  // the default is NOT forced back after a manual switch.
  //
  // Post-release fix (adult default source): Adult-tagged titles use the
  // dedicated 'adult' default when one is configured. This page only renders
  // for ADULT titles when the Phase 6 server guard has ALREADY authorized the
  // request (unauthorized adult access is a non-disclosing 404 before any of
  // this code runs), so the adult default can never affect unauthorized
  // users — with Adult Mode OFF the watch route 404s adult titles and this
  // selection never executes for them. When no adult default is configured,
  // the content-type default applies exactly as before (unchanged behavior).
  $: isAdultTitle = item.tags?.includes('Adult') === true;
  $: defaultSourceId = (isAdultTitle ? data.streamingConfig.defaults?.adult : undefined) ?? data.streamingConfig.defaults?.[contentType];
  // Phase 9 fix: source selection MUST wait for progressReady before selecting.
  // The old code used `!selectedSourceId` which fired as soon as sourceOptions
  // was populated — before savedSourceId was loaded from IndexedDB. This caused
  // sourceOptions[0] to be selected instead of the admin default or saved source.
  // Now we gate on progressReady so the saved/default source is known first.
  $: if (browser && progressReady && !selectedSourceId && sourceOptions.length) {
    // Cross-device source-selection fix: the admin-configured default
    // source is AUTHORITATIVE for initial playback on ALL content types.
    //
    // Previous behavior (movies): saved → default → fallback. A stale
    // local savedSourceId (e.g. SLast from an old session on Device B)
    // would override the admin-configured default (VidStuck), causing
    // the user to see the wrong provider on cross-device resume.
    //
    // New behavior: default → saved → fallback.
    //   1. If the admin configured a default source for this content
    //      type (movie/series/anime/adult), use it. This is the
    //      authoritative source policy — it applies identically across
    //      all devices.
    //   2. If NO default is configured, fall back to the saved source
    //      (the user's last-used source on this device). This preserves
    //      the "last manually selected source" behavior for deployments
    //      where no default is set.
    //   3. If neither default nor saved is available/valid, use the
    //      first source in the admin-ordered source list.
    //
    // The user can still manually switch sources at any time — the
    // manual switch calls handleSourceChange() which sets
    // selectedSourceId directly, bypassing this reactive block.
    const defaultValid = defaultSourceId && sourceOptions.some((s) => s.id === defaultSourceId);
    const savedValid = savedSourceId && sourceOptions.some((s) => s.id === savedSourceId);
    selectedSourceId = defaultValid ? defaultSourceId! : (savedValid ? savedSourceId! : sourceOptions[0].id);
    // Phase 1 Analytics Foundation — provider_selected event for the
    // initial source. Emitted once per playbackKey change (the reactive
    // block only fires when selectedSourceId is empty). The dispatcher
    // no-ops for guests without a cookie. reason is 'initial' (not a
    // switch) — later phases may distinguish 'saved' vs 'default' vs
    // 'fallback' if the dashboard needs it. provider_id is looked up
    // from the streaming config (PlayerSourceOption does not carry it).
    if (selectedSourceId) {
      const sourceConfig = data.streamingConfig.sources.find((s) => s.id === selectedSourceId);
      trackAnalytics('provider_selected', {
        content_id: item.id,
        content_type: contentType,
        provider_id: sourceConfig?.provider_id,
        source_id: selectedSourceId,
        metadata: { reason: 'initial', season, episode },
      });
    }
  }
  $: if (browser && progressReady && selectedSourceId && resolutionState === 'idle') void prepareSource();

  onMount(() => {
    active = true;
    // BUG #4 + #5 fix: await writer.pause() (which flushes to IndexedDB)
    // BEFORE calling syncAuthenticatedState() — otherwise the sync reads
    // stale local state and writes it over the newer cloud record.
    const flushWhenHidden = async () => {
      if (!document.hidden) return;
      try { await writer?.pause(); } catch { /* writer may be disposed */ }
      if (page.data.user) void syncAuthenticatedState();
    };
    const flushBeforeUnload = () => { void writer?.flush(); };
    // Mobile progress flush: pagehide is the reliable lifecycle event on
    // mobile Safari (beforeunload is unreliable on iOS — it does not fire
    // when the user switches tabs or backgrounds the app). pagehide fires
    // on both desktop and mobile when the page is being unloaded or put
    // into the back/forward cache. We flush progress on pagehide so the
    // user's last playback position is persisted before the page is
    // discarded. The flush is fire-and-forget (the page is being torn
    // down — we cannot await), but IndexedDB writes are fast enough to
    // complete in the brief window before the page is destroyed.
    const flushOnPageHide = () => { void writer?.flush(); };
    document.addEventListener('visibilitychange', flushWhenHidden);
    window.addEventListener('beforeunload', flushBeforeUnload);
    window.addEventListener('pagehide', flushOnPageHide);

    // Viduki V1 → V2 automatic fallback.
    // Viduki (https://www.viduki.net) posts a 'viduki:all-servers-failed' message
    // when all backend servers in the current API fail. When the currently-selected
    // source is a Viduki V1 source, automatically switch to the sibling Viduki V2
    // source (same provider, different source). Only accepts events from the
    // documented origin. Does not trust arbitrary window messages. Does not allow
    // the iframe to inject arbitrary URLs — the switch only selects known
    // hard-coded Viduki provider endpoints already registered in Mavero.
    //
    // Phase 1: preserved here (not yet moved into a VidukiPlayerAdapter —
    // that is Phase 3 work). The listener calls prepareSource(v2.id, false)
    // which delegates to manager.loadSource() with allowFallback=false.
    const vidukiFallback = (event: MessageEvent) => {
      if (event.origin !== 'https://www.viduki.net') return;
      if (!event.data || typeof event.data !== 'object') return;
      const data = event.data as { type?: unknown };
      if (data.type !== 'viduki:all-servers-failed') return;
      const current = sourceOptions.find((source) => source.id === selectedSourceId);
      if (!current) return;
      const v2 = sourceOptions.find((source) => source.id !== current.id && source.name?.includes('V2'));
      if (!v2) return;
      if (!current.name?.includes('V1')) return;
      void prepareSource(v2.id, false);
    };
    window.addEventListener('message', vidukiFallback);

    return () => {
      active = false;
      document.removeEventListener('visibilitychange', flushWhenHidden);
      window.removeEventListener('beforeunload', flushBeforeUnload);
      window.removeEventListener('pagehide', flushOnPageHide);
      window.removeEventListener('message', vidukiFallback);
      void writer?.flush();
      writer?.dispose();
    };
  });

  onDestroy(() => {
    active = false;
    unsubscribeManager();
    unsubscribeManagerEvents();
    manager.dispose();
    void writer?.flush();
    writer?.dispose();
  });

  async function setupProgressContext() {
    if (!browser || !playbackKey || playbackKey === writerKey) return;
    writerKey = playbackKey;
    watchingSavedForSession = false;
    progressReady = false;
    resumeApplied = false;
    currentPlaybackTime = 0;
    await writer?.flush();
    const existingRuntimes = writer?.getSourceRuntimes();
    writer?.dispose();
    // Cross-device conflict resolution: await cloud sync BEFORE reading
    // local progress. The previous implementation read from IndexedDB
    // only — if the user navigated to the watch route before background
    // sync converged, the watch page would use a STALE local position
    // (e.g. 28m from Device B) instead of the authoritative cloud
    // position (e.g. 1h29m from Device A). Awaiting syncAuthenticatedState()
    // ensures the local IDB has the merged (cloud-authoritative) record
    // before getResumeProgress reads it.
    //
    // syncAuthenticatedState is a singleton (syncInFlight dedup) — if the
    // root layout already started a sync, this call shares the same
    // promise and does NOT trigger a duplicate network roundtrip. If the
    // user is offline or the sync fails, getResumeProgress still returns
    // the best available local record (graceful degradation).
    //
    // For guests (no user), syncAuthenticatedState returns immediately
    // with { authenticated: false } — no network call, no delay.
    if (data.user) {
      try { await syncAuthenticatedState(); } catch { /* offline/failed — use local */ }
    }
    // Phase 9 fix: load existing progress BEFORE creating the writer so
    // sourceRuntimes from the record are available at writer initialization.
    const [resume, state] = await Promise.all([getResumeProgress(playbackContext), getLocalPersistenceState()]);
    if (!active || writerKey !== playbackKey) return;
    resumeTime = resume.resumeTime;
    duration = resume.record?.duration ?? 0;
    currentPositionUpdatedAt = resume.record?.positionUpdatedAt ?? 0;
    // Phase 9: only use savedSourceId for INCOMPLETE progress. Completed
    // records should NOT force the old source — they should use admin default.
    if (resume.record && resume.record.completionState !== 'completed') {
      savedSourceId = resume.record.selectedSourceId;
    } else {
      savedSourceId = undefined;
    }
    // Phase 9 fix: initialize sourceRuntimes from the existing record.
    // If the record has no sourceRuntimes but has selectedSourceId + duration,
    // lazily initialize the map for backward compatibility.
    let sourceRuntimes = resume.record?.sourceRuntimes;
    if (!sourceRuntimes && resume.record?.selectedSourceId && resume.record.duration > 0) {
      sourceRuntimes = { [resume.record.selectedSourceId]: { duration: resume.record.duration, updatedAt: resume.record.updatedAt } };
    }
    const snapshot = { title: item.title, poster: item.poster, backdrop: item.backdrop, year: item.year, runtime: item.runtime, rating: item.rating, genres: item.genres, description: item.description };
    // Phase 20 fix: pass initialDuration from the existing record so the
    // ProgressWriter's lastKnownDuration is initialized correctly. This
    // prevents a later update() call with duration=0/undefined from
    // overwriting a previously persisted valid duration.
    // Cross-device fix: pass initialPositionUpdatedAt so runtime-only
    // flushes preserve the existing position-freshness timestamp instead
    // of stamping now (which would make a stale-position record look
    // fresher than a real-position record from another device).
    writer = createProgressWriter({ ...playbackContext, selectedSourceId: selectedSourceId || undefined, sourceRuntimes, snapshot, initialCurrentTime: resume.record?.currentTime ?? 0, initialDuration: resume.record?.duration ?? 0, initialPositionUpdatedAt: currentPositionUpdatedAt });
    localState = state.status === 'indexeddb' ? 'Local progress on this device' : 'Temporary local progress only';
    progressReady = true;
  }

  async function replaceProgressSource(sourceId: string) {
    if (!browser || !writer || sourceId === selectedSourceId) return;
    // Phase 9 fix: flush + capture sourceRuntimes + known position BEFORE disposing.
    await writer.flush();
    const sourceRuntimes = writer.getSourceRuntimes();
    const knownCurrentTime = writer.getKnownCurrentTime();
    writer.dispose();
    selectedSourceId = sourceId;
    const snapshot = { title: item.title, poster: item.poster, backdrop: item.backdrop, year: item.year, runtime: item.runtime, rating: item.rating, genres: item.genres, description: item.description };
    // Phase 9 fix: pass the accumulated sourceRuntimes + knownCurrentTime
    // into the new writer so per-source runtimes survive source switches
    // within the same episode, and the known position is never reset to 0.
    // Phase 20 fix: also pass the last known duration.
    // Cross-device fix: pass initialPositionUpdatedAt so the new writer
    // preserves the position-freshness timestamp across source switches
    // (a source switch is NOT a position advancement — it's a metadata
    // change. The new writer must not stamp positionUpdatedAt = now on
    // its first runtime-only flush).
    const knownDuration = duration;
    writer = createProgressWriter({ ...playbackContext, selectedSourceId, sourceRuntimes, snapshot, initialCurrentTime: knownCurrentTime, initialDuration: knownDuration, initialPositionUpdatedAt: currentPositionUpdatedAt });
  }

  /**
   * Delegate source resolution to the PlaybackManager. The manager owns:
   *   - POST /api/playback/resolve invocation
   *   - race-condition guards (sessionId, AbortController)
   *   - adapter lifecycle (pick adapter, load, destroy)
   *   - resolvedSource / resolutionState / resolutionMessage state
   *
   * The route retains:
   *   - sourceId selection (Phase 0 behaviour — first source by admin ordering)
   *   - allowFallback flag (true on initial resolution, false on manual switch)
   *   - progress writer swap (replaceProgressSource — preserved)
   *   - "watching" favorite promotion on first successful resolution
   *
   * If the manager selects a different sourceId (resolver walked the
   * fallback candidate list and the request source failed), the writer
   * is swapped to the new sourceId.
   */
  async function prepareSource(sourceId = selectedSourceId, allowFallback = true) {
    const selected = sourceOptions.find((source) => source.id === sourceId);
    if (!selected) {
      resolutionState = 'unavailable';
      resolutionMessage = 'No authorized source is available for this title.';
      resolvedSource = null;
      return;
    }
    await replaceProgressSource(sourceId);
    if (!active) return;
    selectedSourceId = sourceId;
    // Phase 4: reset resume-once flag for the new source session.
    resumeApplied = false;
    // Phase 4: pass the current playback position as startPosition so the
    // manager can append startAt URL params for embed providers that
    // support it (VidSrc, VidLink, VidY, CineSrc, VidAPI.qzz.io).
    // For the INITIAL load, startPosition = resumeTime (from saved progress).
    // For MANUAL source switches, startPosition = currentPlaybackTime
    // (the position the user was at in the previous source).
    const startPosition = allowFallback ? resumeTime : currentPlaybackTime;
    {
      const request: Parameters<typeof manager.loadSource>[0] = { sourceId, contentId: item.id, mediaType: contentType, season, episode };
      // P9: For SERIES/ANIME, ALWAYS forward the content-type default
      // source (e.g. VidZee) — the series default must always win.
      // For MOVIES, preserve the saved-source resume protection from BUG #3.
      const isSeriesLike = contentType === 'series' || contentType === 'anime';
      const isResumeWithSavedSource = !isSeriesLike && sourceId === savedSourceId && savedSourceId !== defaultSourceId;
      if (allowFallback && defaultSourceId && !isResumeWithSavedSource) {
        request.defaultSourceId = defaultSourceId;
      }
      await manager.loadSource(
        request,
        startPosition,
        allowFallback,
      );
    }
    if (!active) return;
    const resolved = manager.getSource();
    // Phase 4: if the resolver walked the fallback list and selected a
    // different source, swap the writer to that source's id. This records
    // the ACTUAL successful source in the progress record's selectedSourceId.
    if (resolved && resolved.sourceId !== selectedSourceId) {
      await replaceProgressSource(resolved.sourceId);
      selectedSourceId = resolved.sourceId;
    }
    if (resolved && !watchingSavedForSession) {
      watchingSavedForSession = true;
      const snapshot = { title: item.title, poster: item.poster, backdrop: item.backdrop, year: item.year, runtime: item.runtime, rating: item.rating, genres: item.genres, description: item.description };
      try {
        await setFavoriteStatus(contentType, item.id, snapshot, 'watching');
        if (active && page.data.user) void syncAuthenticatedState();
      } catch {
        // Playback remains available even if local list promotion is unavailable.
      }
    }
  }

  function handlePlayerProgress(event: PlayerProgressEvent) {
    duration = event.duration || duration;
    currentPlaybackTime = event.currentTime;
    writer?.update(event.currentTime, duration, event.completed);
    if (event.reason === 'pause' || event.reason === 'source-change' || event.reason === 'close' || event.reason === 'visibility') void writer?.pause();
    if (event.reason === 'ended') void writer?.complete(event.currentTime, duration);
    if (page.data.user && !startedHistory && event.currentTime > 0) {
      startedHistory = true;
      void sendHistory('started', event.currentTime, duration);
    }
    if (page.data.user && event.currentTime - lastHistoryAt >= 60) {
      lastHistoryAt = event.currentTime;
      void sendHistory('progressed', event.currentTime, duration);
    }
    if (event.completed) {
      const snapshot = { title: item.title, poster: item.poster, backdrop: item.backdrop, year: item.year, runtime: item.runtime, rating: item.rating, genres: item.genres, description: item.description };
      void setFavoriteStatus(contentType, item.id, snapshot, 'completed').then(() => { if (page.data.user) void syncAuthenticatedState(); });
      if (page.data.user) void sendHistory('completed', event.currentTime, duration);
    }
  }

  async function sendHistory(eventType: 'started' | 'progressed' | 'completed', currentTime: number, currentDuration: number) {
    await recordCloudHistory({
      eventKey: `${playbackContext.contentType}:${playbackContext.contentId}:${playbackContext.season ?? '-'}:${playbackContext.episode ?? '-'}:${eventType}:${Math.floor(currentTime)}`,
      eventType,
      contentType: playbackContext.contentType,
      contentId: playbackContext.contentId,
      season: playbackContext.season,
      episode: playbackContext.episode,
      currentTime,
      duration: currentDuration,
      completionState: eventType === 'completed' ? 'completed' : 'in_progress',
      snapshot: { title: item.title, poster: item.poster, backdrop: item.backdrop, year: item.year, runtime: item.runtime, rating: item.rating, genres: item.genres, description: item.description },
      occurredAt: Date.now()
    });
  }

  // Phase 9 fix: serialized source-switch chain. Rapid A→B→C must not
  // interleave writer mutations. Each prepareSource chains after the previous.
  let sourceSwitchChain: Promise<void> = Promise.resolve();
  // Phase 9 fix: generation token — the latest source switch wins.
  let sourceSwitchGeneration = 0;

  function handleSourceChange(sourceId: string) {
    // Phase 9 fix: removed the separate void writer?.flush() call.
    // replaceProgressSource() inside prepareSource() already does the flush.
    // This was causing a double-flush race.
    // Phase 1 Analytics Foundation — provider_switched event. Emitted
    // BEFORE the chain so we capture the user's intent even if the
    // switch is later aborted by a newer switch. The dispatcher no-ops
    // for guests without a cookie. from_source/to_source are recorded
    // in metadata for the provider analytics page (Phase 5). provider_id
    // is looked up from the streaming config (PlayerSourceOption does
    // not carry it).
    if (sourceId && sourceId !== selectedSourceId) {
      const fromSourceConfig = data.streamingConfig.sources.find((s) => s.id === selectedSourceId);
      const toSourceConfig = data.streamingConfig.sources.find((s) => s.id === sourceId);
      trackAnalytics('provider_switched', {
        content_id: item.id,
        content_type: contentType,
        provider_id: toSourceConfig?.provider_id,
        source_id: sourceId,
        metadata: {
          from_source_id: selectedSourceId || null,
          from_provider_id: fromSourceConfig?.provider_id ?? null,
          to_source_id: sourceId,
          to_provider_id: toSourceConfig?.provider_id ?? null,
          reason: 'manual_switch',
          season,
          episode,
        },
      });
    }
    const generation = ++sourceSwitchGeneration;
    sourceSwitchChain = sourceSwitchChain.then(() => {
      // If a newer source switch was initiated while we were waiting, abort.
      if (generation !== sourceSwitchGeneration) return;
      // Pass allowFallback=false (manual switch — do NOT walk fallback).
      return prepareSource(sourceId, false);
    }).catch(() => {
      // Swallow — prepareSource handles its own errors via resolutionState.
    });
  }

  async function handleEpisodeChange(target: PlayerEpisodeTarget) {
    season = target.season;
    episode = target.episode;
    // P11: reset selectedSourceId, savedSourceId, and resume state on
    // episode change. The previous episode's selected source must NOT
    // silently carry into the new episode. For series, the content-type
    // default (e.g. VidZee) will be re-selected by the reactive block
    // above. For movies, the existing source rules remain unchanged
    // (movies don't have episode changes).
    selectedSourceId = '';
    savedSourceId = '';
    resumeApplied = false;
    currentPlaybackTime = 0;
    resumeTime = 0;
    duration = 0;
    resolutionState = 'idle';
    resolvedSource = null;
    const params = new URLSearchParams(page.url.searchParams);
    params.set('season', String(target.season));
    params.set('episode', String(target.episode));
    await goto(`/watch/${contentType}/${item.id}?${params.toString()}`, { replaceState: true, keepFocus: true, noScroll: true });
  }

  function isDetailPath(value: string) {
    return /^\/(movie|series|anime)\/[^/?#]+(?:[?#].*)?$/.test(value);
  }

  function closePlayer() {
    const returnTo = safeReturnTo(page.url.searchParams.get('from'));
    const destination = returnTo && isDetailPath(returnTo) ? returnTo : appendReturnTo(`/${contentType}/${item.id}`, returnTo ?? '/discover');
    void goto(destination, { replaceState: true, keepFocus: true });
  }

  function openDetails() {
    const returnTo = safeReturnTo(page.url.searchParams.get('from'));
    const destination = appendReturnTo(`/${contentType}/${item.id}`, returnTo && !isDetailPath(returnTo) ? returnTo : '/discover');
    void goto(destination, { replaceState: true, keepFocus: true });
  }
</script>

<svelte:head><title>Watching {item.title} — Mavero</title></svelte:head>

{#if progressReady}
  <PlayerShell source={resolvedSource} content={playerContent} initialProgress={resumeTime} sourceOptions={sourceOptions} {episodes} currentEpisode={currentEpisode ? { season: currentEpisode.season, episode: currentEpisode.number, title: currentEpisode.title } : null} resolving={resolutionState === 'resolving'} resolutionError={resolutionState === 'provider-error' || resolutionState === 'unsupported' || resolutionState === 'unavailable' || resolutionState === 'network-error' ? resolutionMessage : ''} resolutionKind={resolutionState === 'unsupported' ? 'unsupported' : resolutionState === 'unavailable' ? 'unavailable' : 'provider-error'} resolutionMessage={resolutionState === 'resolving' ? resolutionMessage : ''} onProgress={handlePlayerProgress} onSourceChange={handleSourceChange} onEpisodeChange={handleEpisodeChange} onClose={closePlayer} onDetails={openDetails} onIframeReady={(iframe) => manager.setIframe(iframe)} {embedPlaybackEvent} />
{:else}
  <main class="watch-loading" aria-live="polite"><div class="loading-ring" aria-hidden="true"><span></span></div><div class="loading-copy"><strong>{progressReady ? 'Starting your stream' : 'Loading player'}</strong><span>{progressReady ? 'Connecting to your provider…' : 'Preparing your watch session…'}</span></div><small>{progressReady ? resolutionMessage || 'Finding the best available source' : localState}</small></main>
{/if}

<style>
  .watch-loading { display: grid; place-items: center; align-content: center; gap: 18px; min-height: 100dvh; color: var(--muted); background: radial-gradient(circle at 50% 43%, rgba(255, 62, 94,.12), transparent 24rem), #07070c; font-family: 'Inter', ui-sans-serif, system-ui, sans-serif; font-size: .66rem; text-align: center; }
  .loading-ring { display: grid; place-items: center; width: 72px; height: 72px; border: 1px solid rgba(255,255,255,.1); border-radius: 50%; background: conic-gradient(from 0deg, transparent 0 24%, rgba(255, 88, 120, .95) 42%, rgba(255, 62, 94,.2) 72%, transparent 100%); box-shadow: 0 0 0 14px rgba(255, 62, 94,.045), 0 0 60px rgba(255, 62, 94,.22); animation: spin 1.2s linear infinite; }
  .loading-ring span { width: 58px; height: 58px; border-radius: 50%; background: #07070c; box-shadow: inset 0 0 22px rgba(255, 62, 94,.12); }
  .loading-copy { display: grid; gap: 6px; }
  .loading-copy strong { color: var(--ink); font-family: 'Inter', ui-sans-serif, system-ui, sans-serif; font-size: .92rem; letter-spacing: -.02em; }
  .loading-copy span { color: var(--muted); font-size: .6rem; }
  .watch-loading small { color: var(--muted-deep); font-size: .55rem; }
  @keyframes spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .loading-ring { animation: none; } }
</style>
