<script lang="ts">
  import { browser } from '$app/environment';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { onDestroy, onMount } from 'svelte';
  import PlayerShell from '$lib/components/player/PlayerShell.svelte';
  import { normalizePlayerSource } from '$lib/shared/player-guards';
  import type { PlayerEpisode, PlayerEpisodeTarget, PlayerProgressEvent, PlayerSource } from '$lib/shared/player';
  import type { PageData } from './$types';
  import { createProgressWriter, getLocalPersistenceState, getResumeProgress } from '$lib/client/progress/service';
  import { recordCloudHistory, syncAuthenticatedState } from '$lib/client/progress/cloud';
  import type { PlaybackContext } from '$lib/client/progress/types';

  export let data: PageData;

  $: contentType = (page.params.type === 'series' || page.params.type === 'anime' ? page.params.type : 'movie') as 'movie' | 'series' | 'anime';
  $: item = data.item;
  $: season = Number(page.url.searchParams.get('season') || '') || undefined;
  $: episode = Number(page.url.searchParams.get('episode') || '') || undefined;
  $: currentEpisode = season !== undefined && episode !== undefined ? data.episodes.find((candidate) => candidate.season === season && candidate.number === episode) : undefined;
  $: playbackContext = ({ contentType, contentId: item.id, season, episode, episodeTitle: currentEpisode?.title } satisfies PlaybackContext);
  $: playbackKey = [playbackContext.contentType, playbackContext.contentId, playbackContext.season ?? '-', playbackContext.episode ?? '-'].join(':');
  $: sourceOptions = data.streamingConfig.sources.map((source) => ({ id: source.id, name: source.name, status: source.status, integrationType: source.integration_type ?? undefined }));
  $: episodes = data.episodes.map((candidate) => ({ id: candidate.id, number: candidate.number, season: candidate.season, title: candidate.title, overview: candidate.overview, runtime: candidate.runtime, still: candidate.still })) satisfies PlayerEpisode[];
  $: playerContent = ({ id: item.id, type: contentType, title: item.title, poster: item.poster, backdrop: item.backdrop });

  let selectedSourceId = '';
  let resolvedSource: PlayerSource | null = null;
  let resolutionState: 'idle' | 'loading' | 'ready' | 'error' = 'idle';
  let resolutionMessage = '';
  let resumeTime = 0;
  let duration = 0;
  let progressReady = false;
  let localState = 'Preparing local progress…';
  let writer: ReturnType<typeof createProgressWriter> | undefined;
  let writerKey = '';
  let active = true;
  let startedHistory = false;
  let lastHistoryAt = 0;

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
    void writer?.flush();
    writer?.dispose();
  });

  async function setupProgressContext() {
    if (!browser || !playbackKey || playbackKey === writerKey) return;
    writerKey = playbackKey;
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

  async function prepareSource(sourceId = selectedSourceId) {
    const selected = sourceOptions.find((source) => source.id === sourceId);
    if (!selected) {
      resolvedSource = null;
      resolutionState = 'error';
      resolutionMessage = 'No authorized source is available for this title.';
      return;
    }
    await replaceProgressSource(sourceId);
    selectedSourceId = sourceId;
    resolutionState = 'loading';
    resolutionMessage = 'Resolving a safe playback source…';
    resolvedSource = null;
    try {
      const response = await fetch('/api/playback/resolve', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sourceId, contentId: item.id, mediaType: contentType, season, episode })
      });
      const payload = await response.json() as { ok?: boolean; source?: unknown; error?: { message?: string } };
      const safeSource = normalizePlayerSource(payload.source);
      if (!response.ok || !payload.ok || !safeSource) throw new Error(payload.error?.message ?? 'This source is currently unavailable.');
      resolvedSource = safeSource;
      resolutionState = 'ready';
      resolutionMessage = safeSource.type === 'direct' ? 'MAVERO direct playback is ready.' : 'Provider embed is ready inside the MAVERO shell.';
    } catch (error) {
      resolvedSource = null;
      resolutionState = 'error';
      resolutionMessage = error instanceof Error ? error.message : 'This source is currently unavailable.';
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
    if (event.completed && page.data.user) {
      void sendHistory('completed', event.currentTime, duration);
      void syncAuthenticatedState();
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
    void prepareSource(sourceId);
  }

  async function handleEpisodeChange(target: PlayerEpisodeTarget) {
    const params = new URLSearchParams(page.url.searchParams);
    params.set('season', String(target.season));
    params.set('episode', String(target.episode));
    await goto(`/watch/${contentType}/${item.id}?${params.toString()}`);
  }

  function closePlayer() {
    void goto(`/${contentType}/${item.id}`);
  }
</script>

<svelte:head><title>Watching {item.title} — Mavero</title></svelte:head>

{#if progressReady}
  <PlayerShell source={resolvedSource} content={playerContent} initialProgress={resumeTime} sourceOptions={sourceOptions} {episodes} currentEpisode={currentEpisode ? { season: currentEpisode.season, episode: currentEpisode.number, title: currentEpisode.title } : null} onProgress={handlePlayerProgress} onSourceChange={handleSourceChange} onEpisodeChange={handleEpisodeChange} onClose={closePlayer} />
{:else}
  <main class="watch-loading" aria-live="polite"><div class="loading-orb"></div><span>Preparing your watch session…</span><small>{localState}</small></main>
{/if}

<style>
  .watch-loading { display: grid; place-items: center; align-content: center; gap: 14px; min-height: 100dvh; color: var(--muted); background: #050506; font-family: 'DM Mono', monospace; font-size: .66rem; text-align: center; }
  .watch-loading small { color: var(--muted-deep); font-size: .55rem; }
  .loading-orb { width: 58px; height: 58px; border: 1px solid rgba(194,181,255,.5); border-radius: 50%; box-shadow: 0 0 0 16px rgba(155,135,245,.05), 0 0 54px rgba(155,135,245,.2); animation: pulse 1.7s ease-in-out infinite; }
  @keyframes pulse { 50% { transform: scale(1.07); opacity: .58; } }
  @media (prefers-reduced-motion: reduce) { .loading-orb { animation: none; } }
</style>
