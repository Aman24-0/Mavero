<script lang="ts">
  import { browser } from '$app/environment';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { onDestroy, onMount } from 'svelte';
  import PlayerShell from '$lib/components/player/PlayerShell.svelte';
  import { normalizePlayerSource } from '$lib/shared/player-guards';
  import type { PlayerEpisode, PlayerEpisodeTarget, PlayerProgressEvent, PlayerSource } from '$lib/shared/player';
  import { sandboxPolicyFromCapabilities } from '$lib/shared/sandbox-policy';
  import { appendReturnTo, safeReturnTo } from '$lib/shared/navigation';
  import type { PageData } from './$types';
  import { createProgressWriter, getLocalPersistenceState, getResumeProgress, setFavoriteStatus } from '$lib/client/progress/service';
  import { recordCloudHistory, syncAuthenticatedState } from '$lib/client/progress/cloud';
  import type { PlaybackContext } from '$lib/client/progress/types';

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

  let selectedSourceId = '';
  let resolvedSource: PlayerSource | null = null;
  type ResolutionState = 'idle' | 'resolving' | 'ready' | 'provider-error' | 'unsupported' | 'unavailable' | 'network-error';
  let resolutionState: ResolutionState = 'idle';
  let resolutionMessage = '';
  let resumeTime = 0;
  let duration = 0;
  let progressReady = false;
  let localState = 'Preparing local progress…';
  let writer: ReturnType<typeof createProgressWriter> | undefined;
  let writerKey = '';
  let active = true;
  let resolutionRequestId = 0;
  let resolutionController: AbortController | undefined;
  let startedHistory = false;
  let lastHistoryAt = 0;
  let watchingSavedForSession = false;
  let activePlaybackKey = '';

  $: if (browser && playbackKey !== activePlaybackKey) {
    activePlaybackKey = playbackKey;
    resolutionRequestId += 1;
    resolutionController?.abort();
    resolutionController = undefined;
    resolvedSource = null;
    resolutionState = 'idle';
    resolutionMessage = '';
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
    return () => {
      active = false;
      document.removeEventListener('visibilitychange', flushWhenHidden);
      window.removeEventListener('beforeunload', flushBeforeUnload);
      void writer?.flush();
      writer?.dispose();
    };
  });

  onDestroy(() => {
    active = false;
    resolutionRequestId += 1;
    resolutionController?.abort();
    resolutionController = undefined;
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

  async function prepareSource(sourceId = selectedSourceId, allowFallback = true) {
    const requestId = ++resolutionRequestId;
    resolutionController?.abort();
    resolutionController = undefined;
    const selected = sourceOptions.find((source) => source.id === sourceId);
    if (!selected) {
      resolvedSource = null;
      resolutionState = 'unavailable';
      resolutionMessage = 'No authorized source is available for this title.';
      return;
    }
    const controller = new AbortController();
    resolutionController = controller;
    await replaceProgressSource(sourceId);
    if (!active || requestId !== resolutionRequestId) return;
    selectedSourceId = sourceId;
    resolutionState = 'resolving';
    resolutionMessage = 'Resolving a safe playback source…';
    resolvedSource = null;
    try {
      const response = await fetch('/api/playback/resolve', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sourceId, contentId: item.id, mediaType: contentType, season, episode, enableFallback: allowFallback }),
        signal: controller.signal
      });
      const payload = await response.json() as { ok?: boolean; source?: unknown; error?: { code?: string; message?: string } };
      if (!active || requestId !== resolutionRequestId) return;
      const safeSource = normalizePlayerSource(payload.source);
      if (!response.ok || !payload.ok || !safeSource) {
        const error = new Error(payload.error?.message ?? 'This source is currently unavailable.') as Error & { code?: string };
        error.code = payload.error?.code;
        throw error;
      }
      if (safeSource.sourceId !== selectedSourceId) await replaceProgressSource(safeSource.sourceId);
      if (!active || requestId !== resolutionRequestId) return;
      selectedSourceId = safeSource.sourceId;
      resolvedSource = safeSource;
      resolutionState = 'ready';
      resolutionMessage = safeSource.type === 'direct' ? 'MAVERO direct playback is ready.' : 'Provider embed is ready inside the MAVERO shell.';
      if (!watchingSavedForSession) {
        watchingSavedForSession = true;
        const snapshot = { title: item.title, poster: item.poster, backdrop: item.backdrop, year: item.year, runtime: item.runtime, rating: item.rating, genres: item.genres, description: item.description };
        try {
          await setFavoriteStatus(contentType, item.id, snapshot, 'watching');
          if (active && requestId === resolutionRequestId && page.data.user) void syncAuthenticatedState();
        } catch {
          // Playback remains available even if local list promotion is unavailable.
        }
      }
    } catch (error) {
      if (!active || requestId !== resolutionRequestId || (error && typeof error === 'object' && 'name' in error && error.name === 'AbortError')) return;
      resolvedSource = null;
      const code = error instanceof Error ? (error as Error & { code?: string }).code : undefined;
      resolutionState = code === 'UNSUPPORTED_MEDIA_TYPE' ? 'unsupported' : code === 'SOURCE_DISABLED' || code === 'PROVIDER_DISABLED' || code === 'SOURCE_MAINTENANCE' || code === 'RESOLUTION_UNAVAILABLE' ? 'unavailable' : code ? 'provider-error' : 'network-error';
      resolutionMessage = code === 'UNSUPPORTED_MEDIA_TYPE'
        ? 'This provider does not support this title type.'
        : code === 'SOURCE_DISABLED' || code === 'PROVIDER_DISABLED' || code === 'SOURCE_MAINTENANCE' || code === 'RESOLUTION_UNAVAILABLE'
          ? 'This provider is unavailable. Choose another server.'
          : error instanceof Error
            ? error.message
            : 'The provider could not be reached. Try again or choose another server.';
    } finally {
      if (requestId === resolutionRequestId) resolutionController = undefined;
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
  .watch-loading { display: grid; place-items: center; align-content: center; gap: 18px; min-height: 100dvh; color: var(--muted); background: radial-gradient(circle at 50% 43%, rgba(155,135,245,.12), transparent 24rem), #050506; font-family: 'DM Mono', monospace; font-size: .66rem; text-align: center; }
  .loading-ring { display: grid; place-items: center; width: 72px; height: 72px; border: 1px solid rgba(255,255,255,.1); border-radius: 50%; background: conic-gradient(from 0deg, transparent 0 24%, rgba(194,181,255,.95) 42%, rgba(155,135,245,.2) 72%, transparent 100%); box-shadow: 0 0 0 14px rgba(155,135,245,.045), 0 0 60px rgba(155,135,245,.22); animation: spin 1.2s linear infinite; }
  .loading-ring span { width: 58px; height: 58px; border-radius: 50%; background: #07070a; box-shadow: inset 0 0 22px rgba(155,135,245,.12); }
  .loading-copy { display: grid; gap: 6px; }
  .loading-copy strong { color: var(--ink); font-family: Manrope, sans-serif; font-size: .92rem; letter-spacing: -.02em; }
  .loading-copy span { color: var(--muted); font-size: .6rem; }
  .watch-loading small { color: var(--muted-deep); font-size: .55rem; }
  @keyframes spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .loading-ring { animation: none; } }
</style>
