<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/state';
  import { ArrowLeft, Captions, Maximize, Pause, Play, Settings2, Volume2 } from 'lucide-svelte';
  import { formatType } from '$data/content';
  import type { PageData } from './$types';
  import { createProgressWriter, getLocalPersistenceState, getResumeProgress } from '$lib/client/progress/service';
  import { recordCloudHistory, syncAuthenticatedState } from '$lib/client/progress/cloud';
  import type { PlaybackContext } from '$lib/client/progress/types';

  export let data: PageData;
  $: type = (page.params.type === 'series' || page.params.type === 'anime' ? page.params.type : 'movie') as 'movie' | 'series' | 'anime';
  $: item = data.item;
  $: season = Number(page.url.searchParams.get('season') || '') || undefined;
  $: episode = Number(page.url.searchParams.get('episode') || '') || undefined;
  let playing = false;
  let selectedSourceId = '';
  let resolutionState: 'idle' | 'loading' | 'ready' | 'error' = 'idle';
  let resolutionMessage = '';
  let resolvedSourceType: 'direct' | 'embed' | undefined;
  let currentTime = 0;
  let duration = 0;
  let localState = 'Preparing local progress…';
  let writer: ReturnType<typeof createProgressWriter> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let startedHistory = false;
  let lastHistoryAt = 0;

  $: sources = data.streamingConfig.sources;
  $: selectedSource = sources.find((source) => source.id === selectedSourceId) ?? sources[0];
  $: server = selectedSource?.name ?? 'Configuration pending';
  $: duration = duration || (type === 'movie' ? 7694 : type === 'series' ? 2640 : 1440);
  $: progress = duration > 0 ? Math.min(100, Math.round((currentTime / duration) * 100)) : 0;
  $: context = ({ contentType: type, contentId: item.id, season, episode } satisfies PlaybackContext);
  $: timeLabel = formatTime(currentTime);
  $: durationLabel = formatTime(duration);

  onMount(() => {
    const snapshot = { title: item.title, poster: item.poster, backdrop: item.backdrop, year: item.year, runtime: item.runtime, rating: item.rating, genres: item.genres, description: item.description };
    writer = createProgressWriter({ ...context, snapshot });
    let active = true;

    void (async () => {
      const [resume, state] = await Promise.all([getResumeProgress(context), getLocalPersistenceState()]);
      if (!active) return;
      currentTime = resume.resumeTime;
      if (resume.record?.duration) duration = resume.record.duration;
      localState = state.status === 'indexeddb' ? 'Local progress on this device' : 'Temporary local progress only';
    })();

    timer = setInterval(() => {
      if (!playing || !writer) return;
      currentTime = Math.min(duration, currentTime + 1);
      writer.update(currentTime, duration, currentTime >= duration);
      if (page.data.user && !startedHistory) {
        startedHistory = true;
        void sendHistory('started');
      }
      if (page.data.user && currentTime - lastHistoryAt >= 60) {
        lastHistoryAt = currentTime;
        void sendHistory('progressed');
      }
      if (currentTime >= duration) {
        playing = false;
        void writer.complete(currentTime, duration);
        if (page.data.user) { void sendHistory('completed'); void syncAuthenticatedState(); }
      }
    }, 1000);

    const flushWhenHidden = () => { if (document.hidden) { void writer?.pause(); if (page.data.user) void syncAuthenticatedState(); } };
    const flushBeforeUnload = () => { void writer?.flush(); };
    document.addEventListener('visibilitychange', flushWhenHidden);
    window.addEventListener('beforeunload', flushBeforeUnload);

    return () => {
      active = false;
      if (timer) clearInterval(timer);
      document.removeEventListener('visibilitychange', flushWhenHidden);
      window.removeEventListener('beforeunload', flushBeforeUnload);
      void writer?.flush();
    };
  });

  async function sendHistory(eventType: 'started' | 'progressed' | 'completed') {
    if (!page.data.user) return;
    await recordCloudHistory({ eventKey: `${context.contentType}:${context.contentId}:${context.season ?? '-'}:${context.episode ?? '-'}:${eventType}:${Math.floor(currentTime)}`, eventType, contentType: context.contentType, contentId: context.contentId, season: context.season, episode: context.episode, currentTime, duration, completionState: eventType === 'completed' ? 'completed' : 'in_progress', snapshot: { title: item.title, poster: item.poster, backdrop: item.backdrop, year: item.year, runtime: item.runtime, rating: item.rating, genres: item.genres, description: item.description }, occurredAt: Date.now() });
  }

  async function prepareSelectedSource() {
    if (!selectedSource) return;
    resolutionState = 'loading';
    resolutionMessage = 'Checking source configuration…';
    resolvedSourceType = undefined;
    try {
      const response = await fetch('/api/playback/resolve', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sourceId: selectedSource.id, contentId: item.id, mediaType: type, season, episode }),
      });
      const payload = await response.json() as { ok?: boolean; source?: { type?: 'direct' | 'embed' }; error?: { message?: string } };
      if (!response.ok || !payload.ok || !payload.source?.type) throw new Error(payload.error?.message ?? 'This source is currently unavailable.');
      resolutionState = 'ready';
      resolvedSourceType = payload.source.type;
      resolutionMessage = `Source prepared as ${payload.source.type}. Playback remains inactive in Phase 7B.`;
    } catch (error) {
      resolutionState = 'error';
      resolutionMessage = error instanceof Error ? error.message : 'This source is currently unavailable.';
    }
  }

  function togglePlayback() {
    playing = !playing;
    if (playing && page.data.user && !startedHistory) { startedHistory = true; void sendHistory('started'); }
    if (!playing) { void writer?.pause(); if (page.data.user) void syncAuthenticatedState(); }
  }

  function seek(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    currentTime = Number(input.value);
    writer?.update(currentTime, duration);
  }

  function formatTime(value: number) {
    const safe = Math.max(0, Math.round(value));
    const hours = Math.floor(safe / 3600);
    const minutes = Math.floor((safe % 3600) / 60);
    const seconds = safe % 60;
    return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}` : `${minutes}:${String(seconds).padStart(2, '0')}`;
  }
</script>

<svelte:head><title>Watching {item.title} — Mavero</title></svelte:head>

<div class="player-page">
  <header class="player-bar"><a class="wordmark" href={`/${type}/${item.id}`} aria-label="Back to details"><ArrowLeft size={16} /> MAVERO<span>.</span></a><div class="player-title"><strong>{item.title}</strong><span>{formatType(type)}{#if season && episode} · S{String(season).padStart(2, '0')} E{String(episode).padStart(2, '0')}{/if} · Resume enabled</span></div><div class="player-actions"><button class="icon-btn" aria-label="Player settings"><Settings2 size={17} /></button><button class="icon-btn" aria-label="Fullscreen"><Maximize size={17} /></button></div></header>

  <main>
    <section class="player-stage" aria-label="MAVERO player">
      <div class="player-placeholder"><div class="player-mark">MAVERO</div><div class="eyebrow">{server} / Ready to play</div><p class="player-note">This shell is prepared for an authorized direct source or provider embed. No unverified provider is activated by default.</p><button class="btn btn-primary" onclick={togglePlayback}>{#if playing}<Pause size={14} fill="currentColor" /> Pause preview{:else}<Play size={14} fill="currentColor" /> {currentTime > 0 ? `Resume at ${timeLabel}` : 'Play preview'}{/if}</button><span class="local-status">{localState}</span></div>
    </section>

    <div class="player-controls"><button class="icon-btn" aria-label={playing ? 'Pause' : 'Play'} onclick={togglePlayback}>{#if playing}<Pause size={16} fill="currentColor" />{:else}<Play size={16} fill="currentColor" />{/if}</button><span class="player-time">{timeLabel}</span><input class="progress-input" type="range" min="0" max={duration} step="1" value={currentTime} oninput={seek} aria-label={`${progress}% watched`} /><span class="player-time">{durationLabel}</span><button class="icon-btn" aria-label="Volume"><Volume2 size={16} /></button><button class="icon-btn" aria-label="Subtitles"><Captions size={16} /></button></div>

    <section class="player-bottom container-wide"><div><div class="eyebrow">Source selection</div><h2>Choose a source</h2></div>{#if sources.length}<div class="source-row">{#each sources as source}<button class:active={selectedSource?.id === source.id} class="source-chip" onclick={() => { selectedSourceId = source.id; resolutionState = 'idle'; resolutionMessage = ''; }}>{source.name} <span>{source.status} · {source.integration_type ?? 'Provider default'}</span></button>{/each}</div><div class="source-resolution"><button class="source-resolve-btn" disabled={resolutionState === 'loading'} onclick={prepareSelectedSource}>{resolutionState === 'loading' ? 'Preparing…' : 'Prepare selected source'}</button>{#if resolutionMessage}<span class:success={resolutionState === 'ready'} class:error={resolutionState === 'error'} aria-live="polite">{resolutionMessage}{#if resolvedSourceType} · Safe result received{/if}</span>{/if}</div>{:else}<div class="source-empty">No public sources are configured yet.</div>{/if}<p class="player-disclaimer">Providers are database-driven and must be individually authorized before activation. Phase 7B only requests a normalized safe source result; it does not start playback, call providers from the browser, or bypass provider controls.</p></section>
  </main>
</div>

<style>
  .player-title { display: grid; justify-items: center; gap: 3px; color: var(--ink); font-size: .76rem; }
  .player-title span { color: var(--muted-deep); font-family: 'DM Mono', monospace; font-size: .56rem; }
  .player-actions { display: flex; gap: 5px; }
  .player-bar .wordmark { display: inline-flex; align-items: center; gap: 10px; font-size: .78rem; }
  .player-time { color: var(--muted-deep); font-family: 'DM Mono', monospace; font-size: .59rem; white-space: nowrap; }
  .player-bottom { padding-bottom: 80px; }
  .player-bottom h2 { margin: 7px 0 17px; font-size: 1.4rem; letter-spacing: -.05em; }
  .source-row { display: flex; flex-wrap: wrap; gap: 8px; }
  .source-chip { display: inline-flex; align-items: center; gap: 9px; min-height: 42px; border: 1px solid var(--line); border-radius: 12px; padding: 0 12px; color: var(--muted); background: rgba(255,255,255,.03); font-size: .7rem; font-weight: 800; }
  .source-chip span { color: var(--muted-deep); font-family: 'DM Mono', monospace; font-size: .53rem; font-weight: 400; }
  .source-empty { padding: 18px 0; color: var(--muted-deep); font-family: 'DM Mono', monospace; font-size: .58rem; }
  .source-resolution { display: flex; align-items: center; flex-wrap: wrap; gap: 11px; margin-top: 15px; }
  .source-resolve-btn { border: 1px solid var(--line); border-radius: 8px; padding: 9px 12px; color: var(--ink); background: rgba(255,255,255,.04); cursor: pointer; font: inherit; font-size: .64rem; }
  .source-resolve-btn:hover:not(:disabled) { border-color: rgba(155,135,245,.5); background: var(--accent-soft); }
  .source-resolve-btn:disabled { cursor: wait; opacity: .6; }
  .source-resolution span { color: var(--muted-deep); font-family: 'DM Mono', monospace; font-size: .56rem; }
  .source-resolution .success { color: var(--success); }
  .source-resolution .error { color: #e6b6a4; }
  .source-chip:hover, .source-chip.active { color: var(--ink); border-color: rgba(155,135,245,.5); background: var(--accent-soft); }
  .player-disclaimer { max-width: 650px; margin-top: 19px; color: var(--muted-deep); font-size: .7rem; line-height: 1.6; }
  .progress-input { flex: 1; min-width: 100px; accent-color: var(--accent); }
  .local-status { margin-top: 15px; color: var(--muted-deep); font-family: 'DM Mono', monospace; font-size: .56rem; }
  @media (max-width: 640px) { .player-title { display: none; } .player-stage { margin-top: 12px; } .player-bottom { padding-bottom: 100px; } .player-controls { gap: 7px; } .progress-input { min-width: 60px; } }
</style>
