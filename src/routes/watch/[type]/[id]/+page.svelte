<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/state';
  import { ArrowLeft, Captions, ChevronDown, Maximize, Pause, Play, Settings2, Volume2 } from 'lucide-svelte';
  import { formatType } from '$data/content';
  import type { PageData } from './$types';
  import { createProgressWriter, getLocalPersistenceState, getResumeProgress } from '$lib/client/progress/service';
  import type { PlaybackContext } from '$lib/client/progress/types';

  export let data: PageData;
  $: type = (page.params.type === 'series' || page.params.type === 'anime' ? page.params.type : 'movie') as 'movie' | 'series' | 'anime';
  $: item = data.item;
  $: season = Number(page.url.searchParams.get('season') || '') || undefined;
  $: episode = Number(page.url.searchParams.get('episode') || '') || undefined;
  let playing = false;
  let server = 'MAVERO Direct';
  let currentTime = 0;
  let duration = 0;
  let localState = 'Preparing local progress…';
  let writer: ReturnType<typeof createProgressWriter> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;

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
      if (currentTime >= duration) {
        playing = false;
        void writer.complete(currentTime, duration);
      }
    }, 1000);

    const flushWhenHidden = () => { if (document.hidden) void writer?.pause(); };
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

  function togglePlayback() {
    playing = !playing;
    if (!playing) void writer?.pause();
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

    <section class="player-bottom container-wide"><div><div class="eyebrow">Source selection</div><h2>Choose a source</h2></div><div class="source-row"><button class="source-chip active" onclick={() => (server = 'MAVERO Direct')}>MAVERO Direct <span>Experimental</span></button><button class="source-chip" onclick={() => (server = 'VidLink')}>VidLink <span>Embed · Available</span></button><button class="source-chip" onclick={() => (server = 'Mapple Player')}>Mapple Player <span>Embed · Unknown</span></button><button class="source-chip" aria-label="More source options"><ChevronDown size={15} /></button></div><p class="player-disclaimer">Providers are database-driven and must be individually authorized before activation. Playback controls, source selection, and progress sync remain owned by the Mavero shell.</p></section>
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
  .source-chip:hover, .source-chip.active { color: var(--ink); border-color: rgba(155,135,245,.5); background: var(--accent-soft); }
  .player-disclaimer { max-width: 650px; margin-top: 19px; color: var(--muted-deep); font-size: .7rem; line-height: 1.6; }
  .progress-input { flex: 1; min-width: 100px; accent-color: var(--accent); }
  .local-status { margin-top: 15px; color: var(--muted-deep); font-family: 'DM Mono', monospace; font-size: .56rem; }
  @media (max-width: 640px) { .player-title { display: none; } .player-stage { margin-top: 12px; } .player-bottom { padding-bottom: 100px; } .player-controls { gap: 7px; } .progress-input { min-width: 60px; } }
</style>
