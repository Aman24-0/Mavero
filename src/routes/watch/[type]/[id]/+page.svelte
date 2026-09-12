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
  // Phase 10: progressive Stremio addon resolution — the ONE-fetch aggregate
  // (`resolveMaveroPlayerSource`) is superseded by a session + independent
  // per-addon requests merged live (GOALS 1–6). The aggregate endpoint stays
  // available for backward compatibility but is no longer on this path.
  import { mergeMaveroResults, startMaveroProgressiveResolution, type MaveroAddonResult, type MaveroAddonStatus, type ProgressiveSession } from '$lib/client/player/mavero-progressive';
  import { isMaveroPlayerSourceId, MAVERO_PLAYER_SOURCE_ID, MAVERO_PLAYER_SOURCE_NAME } from '$lib/shared/mavero-player';

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
  // Phase 15 (task §16): the MAVERO Player virtual source is NO LONGER
  // APPENDED to the source selector. The downloader is now the dedicated
  // surface for Stremio addon direct files (external player / download);
  // the native player keeps addon HLS through the unchanged aggregate
  // resolution path, but it is not surfaced as a separate "MAVERO Player"
  // entry in the embed/source selector. The underlying HLS implementation
  // and the addon resolution pipeline are untouched.
  $: sourceOptions = [
    ...data.streamingConfig.sources.map((source) => {
      const provider = data.streamingConfig.providers.find((provider) => provider.id === source.provider_id);
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
        sandboxPolicy: resolveSandboxRuntime(provider?.capabilities, source.capabilities).effectiveSandboxPolicy
      };
      return option;
    }),
  ];
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
  let progressReady = false;
  let localState = 'Preparing local progress…';
  let writer: ReturnType<typeof createProgressWriter> | undefined;
  let writerKey = '';
  let startedHistory = false;
  let lastHistoryAt = 0;
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
  // Phase 4: MAVERO Player in-flight resolution guards. `maveroRequestSeq`
  // invalidates stale resolution sessions (incremented on every new
  // resolution, on episode change and on destroy — an older session's
  // callbacks can never overwrite a newer selection).
  let maveroRequestSeq = 0;
  // Phase 10: the LIVE progressive session (per-addon requests + retry) and
  // its safe per-addon display statuses (GOAL 3). Results accumulate in
  // `maveroResults` keyed by addon key; every arrival recomputes the fair
  // aggregate and merges it into the manager WITHOUT restarting playback.
  let maveroSession: ProgressiveSession | null = null;
  let maveroAddonStatuses: MaveroAddonStatus[] = [];
  let maveroResults: MaveroAddonResult[] = [];
  // Serialized merge chain: the first playable result starts playback via
  // manager.loadSource; later results chain AFTER it so a fast merge can
  // never interleave with the initial load (mirrors sourceSwitchChain).
  let maveroLoadChain: Promise<void> = Promise.resolve();
  let maveroLoadStarted = false;

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
      const currentDuration = event.type === 'timeupdate' && typeof event.duration === 'number' ? event.duration : duration;
      if (currentDuration && currentDuration !== duration) duration = currentDuration;
      const completed = currentDuration > 0 && ct / currentDuration >= 0.9;
      writer?.update(ct, currentDuration, completed);
    } else if (event.type === 'pause') {
      void writer?.pause();
    } else if (event.type === 'ended') {
      const ct = manager.getState().currentTime || currentPlaybackTime;
      void writer?.complete(ct, duration);
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
    // Phase 4/10: invalidate any in-flight MAVERO resolution session — an
    // older session's addon results must never populate the new episode.
    maveroRequestSeq += 1;
    maveroSession?.dispose();
    maveroSession = null;
    maveroAddonStatuses = [];
    maveroResults = [];
    maveroLoadStarted = false;
    maveroLoadChain = Promise.resolve();
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
    const savedValid = savedSourceId && sourceOptions.some((s) => s.id === savedSourceId);
    const defaultValid = defaultSourceId && sourceOptions.some((s) => s.id === defaultSourceId);
    selectedSourceId = savedValid ? savedSourceId! : (defaultValid ? defaultSourceId! : sourceOptions[0].id);
  }
  $: if (browser && progressReady && selectedSourceId && resolutionState === 'idle') void prepareSource();

  onMount(() => {
    active = true;
    const flushWhenHidden = () => {
      if (!document.hidden) return;
      void writer?.pause();
      if (page.data.user) void syncAuthenticatedState();
    };
    const flushBeforeUnload = () => { void writer?.flush(); };
    document.addEventListener('visibilitychange', flushWhenHidden);
    window.addEventListener('beforeunload', flushBeforeUnload);

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
      window.removeEventListener('message', vidukiFallback);
      void writer?.flush();
      writer?.dispose();
    };
  });

  onDestroy(() => {
    active = false;
    unsubscribeManager();
    unsubscribeManagerEvents();
    // Phase 4/10: tear down any in-flight MAVERO resolution session.
    maveroRequestSeq += 1;
    maveroSession?.dispose();
    maveroSession = null;
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
    // Phase 9 fix: load existing progress BEFORE creating the writer so
    // sourceRuntimes from the record are available at writer initialization.
    const [resume, state] = await Promise.all([getResumeProgress(playbackContext), getLocalPersistenceState()]);
    if (!active || writerKey !== playbackKey) return;
    resumeTime = resume.resumeTime;
    duration = resume.record?.duration ?? 0;
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
    writer = createProgressWriter({ ...playbackContext, selectedSourceId: selectedSourceId || undefined, sourceRuntimes, snapshot, initialCurrentTime: resume.record?.currentTime ?? 0, initialDuration: resume.record?.duration ?? 0 });
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
    const knownDuration = duration;
    writer = createProgressWriter({ ...playbackContext, selectedSourceId, sourceRuntimes, snapshot, initialCurrentTime: knownCurrentTime, initialDuration: knownDuration });
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
    // Phase 4/10: the MAVERO Player virtual source takes the progressive
    // Stremio branch — session + independent per-addon requests, playback
    // starts from the FIRST playable result and later results merge live.
    // The existing provider branch below is unchanged (and any in-flight
    // MAVERO session is torn down when a provider source is selected).
    if (isMaveroPlayerSourceId(sourceId)) {
      prepareMaveroPlayerSource(startPosition);
      // Provider fallback bookkeeping below does not apply yet — the first
      // playable addon result owns the 'watching' promotion (see below).
      if (!watchingSavedForSession && active) {
        watchingSavedForSession = true;
        const snapshot = { title: item.title, poster: item.poster, backdrop: item.backdrop, year: item.year, runtime: item.runtime, rating: item.rating, genres: item.genres, description: item.description };
        try {
          await setFavoriteStatus(contentType, item.id, snapshot, 'watching');
          if (active && page.data.user) void syncAuthenticatedState();
        } catch {
          // Playback remains available even if local list promotion is unavailable.
        }
      }
    } else {
      // Phase 10: selecting a provider source tears down any MAVERO session —
      // late addon results must not merge into a provider playback session.
      maveroRequestSeq += 1;
      maveroSession?.dispose();
      maveroSession = null;
      maveroAddonStatuses = [];
      const request: Parameters<typeof manager.loadSource>[0] = { sourceId, contentId: item.id, mediaType: contentType, season, episode };
      if (allowFallback && defaultSourceId) request.defaultSourceId = defaultSourceId;
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

  /**
   * Phase 10 — MAVERO Player PROGRESSIVE resolution branch (supersedes the
   * Phase 4 one-shot aggregate fetch; GOALS 1–6).
   *
   *   1. POST /api/playback/stremio/session (content identifiers only).
   *   2. The controller fires ONE independent request per addon token — all
   *      in flight simultaneously. The first addon that yields playable
   *      streams STARTS PLAYBACK immediately (GOAL 2) through the SAME
   *      manager/adapter path (presetSource → direct adapter lifecycle).
   *   3. Every later addon result re-merges the fair aggregate
   *      (`mergeMaveroResults` — round-robin budgets shared with the server)
   *      and updates the manager via `updatePresetSource` — the video keeps
   *      playing, the stream sheet and the "N Streams" count update LIVE.
   *   4. A failed addon only marks that addon (sheet shows Failed — Retry);
   *      `handleMaveroRetry` re-runs exactly that addon (GOAL 6).
   *
   * Stale protection (GOAL 5): `maveroRequestSeq` invalidates superseded
   * sessions (new resolution / episode change / destroy), the controller's
   * generation guard drops late callbacks, every server token is signed and
   * content-bound, and `manager.updatePresetSource` refuses sources with a
   * different identity. A→B→A and movie↔episode switches are covered at
   * every layer.
   */
  function prepareMaveroPlayerSource(startPosition: number) {
    const requestId = ++maveroRequestSeq;
    maveroSession?.dispose();
    maveroAddonStatuses = [];
    maveroResults = [];
    maveroLoadStarted = false;
    maveroLoadChain = Promise.resolve();
    resolvedSource = null;
    resolutionState = 'resolving';
    resolutionMessage = 'Resolving MAVERO Player streams…';

    const mergeContext = { sourceId: MAVERO_PLAYER_SOURCE_ID, sourceName: MAVERO_PLAYER_SOURCE_NAME, mediaType: contentType, contentTitle: item.title };

    /** Applies one addon result: accumulate → re-merge → load-or-update. */
    const applyResult = (result: MaveroAddonResult) => {
      if (!active || requestId !== maveroRequestSeq) return;
      const existing = maveroResults.findIndex((entry) => entry.key === result.key);
      if (existing >= 0) maveroResults[existing] = result;
      else maveroResults.push(result);
      // The merged aggregate ALWAYS keeps the currently playing stream as
      // its lead (mergeMaveroResults pins `currentUrl`), so a late merge
      // never retargets the media element.
      const playingUrl = resolvedSource?.url ?? null;
      const merged = mergeMaveroResults(maveroResults, mergeContext, playingUrl);
      if (result.status !== 'ok') {
        // Failure/skip: statuses update; only the aggregate-state messaging
        // matters when NOTHING is playable and everything already settled.
        maybeSettleUnavailable();
        return;
      }
      if (!merged) {
        maybeSettleUnavailable();
        return;
      }
      if (!maveroLoadStarted) {
        // FIRST playable stream — start playback immediately (GOAL 2).
        maveroLoadStarted = true;
        maveroLoadChain = maveroLoadChain.then(async () => {
          if (!active || requestId !== maveroRequestSeq) return;
          await manager.loadSource(
            { sourceId: MAVERO_PLAYER_SOURCE_ID, contentId: item.id, mediaType: contentType, season, episode, presetSource: merged },
            startPosition,
            false,
          );
        }).catch(() => {
          // loadSource surfaces its own resolutionState — never unhandled.
        });
      } else {
        // LATER results — extend the aggregate LIVE without restart (GOAL 2).
        maveroLoadChain = maveroLoadChain.then(() => {
          if (!active || requestId !== maveroRequestSeq) return;
          manager.updatePresetSource(merged);
        });
      }
    };

    /** All addons settled and none produced a playable stream. */
    const maybeSettleUnavailable = () => {
      if (!active || requestId !== maveroRequestSeq) return;
      if (maveroLoadStarted) return;
      const statuses = maveroSession?.statuses() ?? [];
      const pending = statuses.some((status) => status.status === 'pending' || status.status === 'loading');
      if (pending) return;
      const anyOk = statuses.some((status) => status.status === 'ok');
      resolutionState = anyOk ? 'unavailable' : 'network-error';
      resolutionMessage = anyOk
        ? 'No playable streams are available from MAVERO Player right now.'
        : 'MAVERO Player could not be reached. Try again or choose another source.';
    };

    maveroSession = startMaveroProgressiveResolution(
      { contentId: item.id, mediaType: contentType, season, episode },
      {
        onSession: (summary) => {
          if (!active || requestId !== maveroRequestSeq) return;
          maveroAddonStatuses = summary.addons;
          if (summary.empty) {
            resolutionState = 'unavailable';
            resolutionMessage = 'No playable streams are available from MAVERO Player right now.';
          }
        },
        onResult: (result) => {
          // Live statuses for the sheet (GOAL 3) + merge (GOAL 2).
          if (!active || requestId !== maveroRequestSeq) return;
          maveroAddonStatuses = maveroSession?.statuses() ?? maveroAddonStatuses;
          applyResult(result);
        },
        onSessionError: (code, message) => {
          if (!active || requestId !== maveroRequestSeq) return;
          maveroAddonStatuses = [];
          resolutionState = code === 'INVALID_REQUEST' ? 'unavailable' : 'network-error';
          resolutionMessage = message;
        },
      },
    );
  }

  /** Phase 10 GOAL 6: retry ONE failed addon — never the whole session. */
  function handleMaveroRetry(addonKey: string) {
    if (maveroRequestSeq === 0) return;
    maveroSession?.retry(addonKey);
    maveroAddonStatuses = maveroSession?.statuses() ?? maveroAddonStatuses;
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
  <PlayerShell source={resolvedSource} content={playerContent} initialProgress={resumeTime} sourceOptions={sourceOptions} {episodes} currentEpisode={currentEpisode ? { season: currentEpisode.season, episode: currentEpisode.number, title: currentEpisode.title } : null} resolving={resolutionState === 'resolving'} resolutionError={resolutionState === 'provider-error' || resolutionState === 'unsupported' || resolutionState === 'unavailable' || resolutionState === 'network-error' ? resolutionMessage : ''} resolutionKind={resolutionState === 'unsupported' ? 'unsupported' : resolutionState === 'unavailable' ? 'unavailable' : 'provider-error'} resolutionMessage={resolutionState === 'resolving' ? resolutionMessage : ''} onProgress={handlePlayerProgress} onSourceChange={handleSourceChange} onEpisodeChange={handleEpisodeChange} onClose={closePlayer} onDetails={openDetails} onIframeReady={(iframe) => manager.setIframe(iframe)} {embedPlaybackEvent} maveroAddons={maveroAddonStatuses} onMaveroRetry={handleMaveroRetry} />
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
