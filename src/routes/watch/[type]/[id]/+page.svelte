<script lang="ts">
  import { browser } from '$app/environment';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { onDestroy, onMount } from 'svelte';
  import PlayerShell from '$lib/components/player/PlayerShell.svelte';
  import type { PlayerEpisode, PlayerEpisodeTarget, PlayerProgressEvent, PlayerSource } from '$lib/shared/player';
  import { sandboxPolicyFromCapabilities } from '$lib/shared/sandbox-policy';
  import { appendReturnTo, safeReturnTo } from '$lib/shared/navigation';
  import type { PageData } from './$types';
  import { createProgressWriter, getLocalPersistenceState, getResumeProgress, setFavoriteStatus } from '$lib/client/progress/service';
  import { recordCloudHistory, syncAuthenticatedState } from '$lib/client/progress/cloud';
  import type { PlaybackContext } from '$lib/client/progress/types';
  import { PlaybackManager, type ResolutionState } from '$lib/client/player/PlaybackManager';

  export let data: PageData;

  $: contentType = (page.params.type === 'series' || page.params.type === 'anime' ? page.params.type : 'movie') as 'movie' | 'series' | 'anime';
  $: item = data.item;
  let season = Number(page.url.searchParams.get('season') || '') || undefined;
  let episode = Number(page.url.searchParams.get('episode') || '') || undefined;
  $: currentEpisode = season !== undefined && episode !== undefined ? data.episodes.find((candidate) => candidate.season === season && candidate.number === episode) : undefined;
  $: playbackContext = ({ contentType, contentId: item.id, season, episode, episodeTitle: currentEpisode?.title } satisfies PlaybackContext);
  $: playbackKey = [playbackContext.contentType, playbackContext.contentId, playbackContext.season ?? '-', playbackContext.episode ?? '-'].join(':');
  $: sourceOptions = data.streamingConfig.sources.map((source) => ({ id: source.id, name: source.name, status: source.status, integrationType: source.integration_type ?? undefined, sandboxPolicy: sandboxPolicyFromCapabilities(data.streamingConfig.providers.find((provider) => provider.id === source.provider_id)?.capabilities, source.capabilities) }));
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

  // Subscribe to manager state so the route's reactive locals mirror the
  // manager snapshot. PlayerShell receives these via its existing props.
  const unsubscribeManager = manager.subscribe((snapshot) => {
    resolvedSource = snapshot.source as PlayerSource | null;
    resolutionState = snapshot.resolutionState;
    resolutionMessage = snapshot.resolutionMessage;
    if (snapshot.duration && snapshot.duration !== duration) duration = snapshot.duration;
  });

  // Forward manager playback events to the existing progress writer.
  // This is the integration boundary described in Phase 0 gap §0.10.6 —
  // for direct sources, manager events translate to writer.update() calls
  // exactly as Phase 0's PlayerShell.handlePlayerProgress did. For embed
  // sources (no events), the writer is never updated — same as Phase 0.
  const unsubscribeManagerEvents = manager.onEvent((event) => {
    if (event.type === 'timeupdate' || event.type === 'seeked') {
      const currentDuration = event.type === 'timeupdate' && typeof event.duration === 'number' ? event.duration : duration;
      const completed = currentDuration > 0 && event.currentTime / currentDuration >= 0.9;
      writer?.update(event.currentTime, currentDuration, completed);
    } else if (event.type === 'pause') {
      void writer?.pause();
    } else if (event.type === 'ended') {
      // `ended` carries no currentTime in the normalized PlayerEvent union;
      // read the last known currentTime from the manager snapshot.
      const currentTime = manager.getState().currentTime;
      void writer?.complete(currentTime, duration);
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
  }
  $: if (browser && playbackKey !== writerKey) void setupProgressContext();
  $: if (!selectedSourceId && sourceOptions.length) selectedSourceId = sourceOptions[0].id;
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
    manager.dispose();
    void writer?.flush();
    writer?.dispose();
  });

  async function setupProgressContext() {
    if (!browser || !playbackKey || playbackKey === writerKey) return;
    writerKey = playbackKey;
    watchingSavedForSession = false;
    progressReady = false;
    await writer?.flush();
    writer?.dispose();
    const snapshot = { title: item.title, poster: item.poster, backdrop: item.backdrop, year: item.year, runtime: item.runtime, rating: item.rating, genres: item.genres, description: item.description };
    writer = createProgressWriter({ ...playbackContext, selectedSourceId: selectedSourceId || undefined, snapshot });
    const [resume, state] = await Promise.all([getResumeProgress(playbackContext), getLocalPersistenceState()]);
    if (!active || writerKey !== playbackKey) return;
    resumeTime = resume.resumeTime;
    duration = resume.record?.duration ?? 0;
    localState = state.status === 'indexeddb' ? 'Local progress on this device' : 'Temporary local progress only';
    progressReady = true;
  }

  async function replaceProgressSource(sourceId: string) {
    if (!browser || !writer || sourceId === selectedSourceId) return;
    await writer.flush();
    writer.dispose();
    selectedSourceId = sourceId;
    const snapshot = { title: item.title, poster: item.poster, backdrop: item.backdrop, year: item.year, runtime: item.runtime, rating: item.rating, genres: item.genres, description: item.description };
    writer = createProgressWriter({ ...playbackContext, selectedSourceId, snapshot });
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
      // No source option — surface as unavailable without invoking the manager.
      resolutionState = 'unavailable';
      resolutionMessage = 'No authorized source is available for this title.';
      resolvedSource = null;
      return;
    }
    await replaceProgressSource(sourceId);
    if (!active) return;
    selectedSourceId = sourceId;
    await manager.loadSource(
      { sourceId, contentId: item.id, mediaType: contentType, season, episode },
      resumeTime,
      allowFallback,
    );
    if (!active) return;
    const resolved = manager.getSource();
    // If the resolver walked the fallback list and selected a different source,
    // swap the writer to that source's id (mirrors Phase 0 behaviour).
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

  function handleSourceChange(sourceId: string) {
    void prepareSource(sourceId, false);
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
  <PlayerShell source={resolvedSource} content={playerContent} initialProgress={resumeTime} sourceOptions={sourceOptions} {episodes} currentEpisode={currentEpisode ? { season: currentEpisode.season, episode: currentEpisode.number, title: currentEpisode.title } : null} resolving={resolutionState === 'resolving'} resolutionError={resolutionState === 'provider-error' || resolutionState === 'unsupported' || resolutionState === 'unavailable' || resolutionState === 'network-error' ? resolutionMessage : ''} resolutionKind={resolutionState === 'unsupported' ? 'unsupported' : resolutionState === 'unavailable' ? 'unavailable' : 'provider-error'} resolutionMessage={resolutionState === 'resolving' ? resolutionMessage : ''} onProgress={handlePlayerProgress} onSourceChange={handleSourceChange} onEpisodeChange={handleEpisodeChange} onClose={closePlayer} onDetails={openDetails} />
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
