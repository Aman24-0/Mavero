<script lang="ts">
  import { page } from '$app/state';
  import { ArrowLeft, Captions, ChevronDown, Maximize, Pause, Play, Settings2, Volume2 } from 'lucide-svelte';
  import { getMedia, formatType } from '$data/content';

  $: type = (page.params.type === 'series' || page.params.type === 'anime' ? page.params.type : 'movie') as 'movie' | 'series' | 'anime';
  $: item = getMedia(page.params.id ?? 'afterlight');
  let playing = false;
  let server = 'MAVERO Direct';
  let progress = 0;
  $: progress = item?.progress ?? 0;

  function togglePlayback() { playing = !playing; }
</script>

<svelte:head><title>Watching {item.title} — Mavero</title></svelte:head>

<div class="player-page">
  <header class="player-bar"><a class="wordmark" href={`/${type}/${item.id}`} aria-label="Back to details"><ArrowLeft size={16} /> MAVERO<span>.</span></a><div class="player-title"><strong>{item.title}</strong><span>{formatType(type)} · Resume enabled</span></div><div class="player-actions"><button class="icon-btn" aria-label="Player settings"><Settings2 size={17} /></button><button class="icon-btn" aria-label="Fullscreen"><Maximize size={17} /></button></div></header>

  <main>
    <section class="player-stage" aria-label="MAVERO player">
      <div class="player-placeholder"><div class="player-mark">MAVERO</div><div class="eyebrow">{server} / Ready to play</div><p class="player-note">This shell is prepared for an authorized direct source or provider embed. No unverified provider is activated by default.</p><button class="btn btn-primary" onclick={togglePlayback}>{#if playing}<Pause size={14} fill="currentColor" /> Pause preview{:else}<Play size={14} fill="currentColor" /> Play preview{/if}</button></div>
    </section>

    <div class="player-controls"><button class="icon-btn" aria-label={playing ? 'Pause' : 'Play'} onclick={togglePlayback}>{#if playing}<Pause size={16} fill="currentColor" />{:else}<Play size={16} fill="currentColor" />{/if}</button><span class="player-time">{progress}%</span><div class="progress-track" aria-label={`${progress}% watched`}><span style={`width: ${progress}%`}></span></div><span class="player-time">2:08:14</span><button class="icon-btn" aria-label="Volume"><Volume2 size={16} /></button><button class="icon-btn" aria-label="Subtitles"><Captions size={16} /></button></div>

    <section class="player-bottom container-wide"><div><div class="eyebrow">Source selection</div><h2>Choose a source</h2></div><div class="source-row"><button class="source-chip active" onclick={() => (server = 'MAVERO Direct')}>MAVERO Direct <span>Experimental</span></button><button class="source-chip" onclick={() => (server = 'VidLink')}>VidLink <span>Embed · Available</span></button><button class="source-chip" onclick={() => (server = 'Mapple Player')}>Mapple Player <span>Embed · Unknown</span></button><button class="source-chip" aria-label="More source options"><ChevronDown size={15} /></button></div><p class="player-disclaimer">Providers are database-driven and must be individually authorized before activation. Playback controls, source selection, and progress sync remain owned by the Mavero shell.</p></section>
  </main>
</div>

<style>
  .player-title { display: grid; justify-items: center; gap: 3px; color: var(--ink); font-size: .76rem; }
  .player-title span { color: var(--muted-deep); font-family: 'DM Mono', monospace; font-size: .56rem; }
  .player-actions { display: flex; gap: 5px; }
  .player-bar .wordmark { display: inline-flex; align-items: center; gap: 10px; font-size: .78rem; }
  .player-time { color: var(--muted-deep); font-family: 'DM Mono', monospace; font-size: .59rem; }
  .player-bottom { padding-bottom: 80px; }
  .player-bottom h2 { margin: 7px 0 17px; font-size: 1.4rem; letter-spacing: -.05em; }
  .source-row { display: flex; flex-wrap: wrap; gap: 8px; }
  .source-chip { display: inline-flex; align-items: center; gap: 9px; min-height: 42px; border: 1px solid var(--line); border-radius: 12px; padding: 0 12px; color: var(--muted); background: rgba(255,255,255,.03); font-size: .7rem; font-weight: 800; }
  .source-chip span { color: var(--muted-deep); font-family: 'DM Mono', monospace; font-size: .53rem; font-weight: 400; }
  .source-chip:hover, .source-chip.active { color: var(--ink); border-color: rgba(155,135,245,.5); background: var(--accent-soft); }
  .player-disclaimer { max-width: 650px; margin-top: 19px; color: var(--muted-deep); font-size: .7rem; line-height: 1.6; }
  @media (max-width: 640px) { .player-title { display: none; } .player-stage { margin-top: 12px; } .player-bottom { padding-bottom: 100px; } }
</style>
