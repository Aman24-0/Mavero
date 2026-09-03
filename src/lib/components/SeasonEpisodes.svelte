<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/state';
  import { AlertTriangle, ChevronRight, LoaderCircle, Play } from 'lucide-svelte';
  import { appendReturnTo } from '$lib/shared/navigation';

  type Episode = { id: string; number: number; season: number; title: string; overview?: string; airDate?: string; runtime?: string; still?: string };
  type Season = { number: number; title: string; episodeCount: number; episodes?: Episode[] };

  export let id: string;
  export let seasonCount = 1;
  let selectedSeason = 1;
  let season: Season | undefined;
  let loading = true;
  let errorMessage = '';

  async function loadSeason(number: number) {
    selectedSeason = number;
    loading = true;
    errorMessage = '';
    try {
      const response = await fetch(`/api/content/series/${encodeURIComponent(id)}/season/${number}`);
      const payload = await response.json();
      if (!response.ok || !payload.ok) throw new Error(payload.error?.message || 'Episodes are temporarily unavailable.');
      season = payload.season as Season;
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : 'Episodes are temporarily unavailable.';
      season = undefined;
    } finally {
      loading = false;
    }
  }

  $: returnTo = `${page.url.pathname}${page.url.search}${page.url.hash}`;

  onMount(() => { void loadSeason(1); });
</script>

<section class="ep-section" aria-labelledby="ep-heading">
  <div class="ep-head">
    <div><div class="ep-eyebrow">MAVERO / Series guide</div><h2 class="ep-title" id="ep-heading">Episodes</h2></div>
    <div class="season-tabs" role="group" aria-label="Select season">
      {#each Array(Math.max(seasonCount, 1)) as _, index}
        <button class:active={selectedSeason === index + 1} aria-pressed={selectedSeason === index + 1} onclick={() => loadSeason(index + 1)}>S{index + 1}</button>
      {/each}
    </div>
  </div>

  {#if loading}
    <div class="ep-loading"><LoaderCircle size={15} /> Loading episodes…</div>
  {:else if errorMessage}
    <div class="ep-error" role="alert"><AlertTriangle size={15} /> {errorMessage}<button class="retry-btn" onclick={() => loadSeason(selectedSeason)}>Try again</button></div>
  {:else if season?.episodes?.length}
    <div class="ep-list">
      {#each season.episodes as episode}
        <article class="ep-row">
          <div class="ep-num">{String(episode.number).padStart(2, '0')}</div>
          {#if episode.still}
            <img src={episode.still} alt={`${episode.title} still`} loading="lazy" width="320" height="180" />
          {:else}
            <div class="ep-still" aria-hidden="true"></div>
          {/if}
          <div class="ep-copy">
            <h3>{episode.title}</h3>
            <div class="ep-meta">{episode.runtime ?? 'Episode'}{#if episode.airDate}<span>·</span>{episode.airDate}{/if}</div>
            <p>{episode.overview || 'Episode details are not available yet.'}</p>
          </div>
          <a class="ep-play" href={appendReturnTo(`/watch/series/${id}?season=${selectedSeason}&episode=${episode.number}`, returnTo)} aria-label={`Watch ${episode.title}`}>
            <Play size={13} fill="currentColor" strokeWidth={0} />
          </a>
        </article>
      {/each}
    </div>
  {:else}
    <div class="ep-empty">No episode metadata is available for this season yet.</div>
  {/if}
</section>

<style>
  .ep-section { margin-top: 36px; }
  .ep-head { display: flex; align-items: end; justify-content: space-between; padding-bottom: 12px; border-bottom: 1px solid rgba(255,255,255,.06); }
  .ep-eyebrow { color: #77777f; font-size: .58rem; font-weight: 700; letter-spacing: .1em; text-transform: uppercase; }
  .ep-title { color: #f5f5f5; font-size: 1.1rem; font-weight: 700; letter-spacing: -.02em; margin: 2px 0 0; }

  .season-tabs { display: flex; gap: 4px; max-width: 58%; overflow-x: auto; padding: 4px; border: 1px solid rgba(255,255,255,.06); border-radius: 6px; background: rgba(255,255,255,.02); scrollbar-width: none; }
  .season-tabs::-webkit-scrollbar { display: none; }
  .season-tabs button { flex: 0 0 auto; border: 0; border-radius: 4px; padding: 6px 10px; color: #77777f; background: transparent; font: inherit; font-size: .58rem; font-weight: 700; cursor: pointer; transition: all 200ms cubic-bezier(.22,1,.36,1); }
  .season-tabs button.active { color: #000; background: #f5f5f5; }
  .season-tabs button:hover:not(.active) { color: #f5f5f5; background: rgba(255,255,255,.06); }

  .ep-loading, .ep-error, .ep-empty { display: flex; align-items: center; gap: 9px; padding: 20px 0; border-bottom: 1px solid rgba(255,255,255,.06); color: #77777f; font-size: .76rem; }
  .ep-error { color: #ffb020; }
  .retry-btn { margin-left: auto; border: 0; background: none; cursor: pointer; color: #f5f5f5; font-size: .72rem; font-weight: 600; }

  .ep-list { padding-top: 6px; }
  .ep-row {
    display: grid; grid-template-columns: 30px 140px minmax(0, 1fr) 32px; align-items: center; gap: 14px;
    padding: 12px 8px; border-bottom: 1px solid rgba(255,255,255,.04); border-radius: 8px;
    transition: background 200ms cubic-bezier(.22,1,.36,1);
  }
  .ep-row:hover { background: rgba(255,255,255,.03); }
  .ep-num { color: #555; font-size: .6rem; font-weight: 700; }
  .ep-row img, .ep-still { width: 140px; aspect-ratio: 16 / 9; object-fit: cover; border: 1px solid rgba(255,255,255,.04); border-radius: 6px; background: #111; }
  .ep-copy h3 { margin: 0 0 4px; color: #f5f5f5; font-size: .78rem; font-weight: 600; }
  .ep-meta { display: flex; gap: 6px; color: #555; font-size: .56rem; }
  .ep-copy p { max-width: 580px; margin: 6px 0 0; overflow: hidden; color: #77777f; font-size: .68rem; line-height: 1.5; text-overflow: ellipsis; white-space: nowrap; }
  .ep-play {
    display: grid; place-items: center; width: 30px; height: 30px; border-radius: 50%;
    color: #000; background: rgba(255,255,255,.9); box-shadow: 0 2px 8px rgba(0,0,0,.3);
    text-decoration: none; transition: transform 200ms cubic-bezier(.22,1,.36,1);
  }
  .ep-play:hover { background: #fff; transform: scale(1.08); }

  @media (max-width: 640px) {
    .ep-head { flex-direction: column; align-items: start; gap: 12px; }
    .season-tabs { max-width: 100%; width: 100%; }
    .ep-row { grid-template-columns: 22px 84px minmax(0, 1fr) 28px; gap: 10px; padding-inline: 0; }
    .ep-row img, .ep-still { width: 84px; }
    .ep-copy p { display: none; }
    .ep-play { width: 26px; height: 26px; }
  }
  @media (prefers-reduced-motion: reduce) {
    .ep-row, .ep-play, .season-tabs button { transition: none; }
  }
</style>
