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

<section class="episode-section" aria-labelledby="episode-heading">
  <div class="section-head"><div><div class="eyebrow">MAVERO / Series guide</div><h2 class="section-title" id="episode-heading">Episodes</h2></div><div class="season-tabs" role="group" aria-label="Select season">{#each Array(Math.max(seasonCount, 1)) as _, index}<button class:active={selectedSeason === index + 1} aria-pressed={selectedSeason === index + 1} onclick={() => loadSeason(index + 1)}>Season {index + 1}</button>{/each}</div>
</div>
  {#if loading}<div class="episode-loading"><LoaderCircle size={15} /> Loading episodes…</div>{:else if errorMessage}<div class="episode-error" role="alert"><AlertTriangle size={15} /> {errorMessage}<button class="section-link" onclick={() => loadSeason(selectedSeason)}>Try again</button></div>{:else if season?.episodes?.length}<div class="episode-list">{#each season.episodes as episode}<article class="episode-row"><div class="episode-number">{String(episode.number).padStart(2, '0')}</div>{#if episode.still}<img src={episode.still} alt={`${episode.title} still`} loading="lazy" width="320" height="180" />
{:else}<div class="episode-still" aria-hidden="true"></div>{/if}<div class="episode-copy"><h3>{episode.title}</h3><div class="episode-meta">{episode.runtime ?? 'Episode'}{#if episode.airDate}<span>·</span>{episode.airDate}{/if}</div><p>{episode.overview || 'Episode details are not available yet.'}</p></div><a class="episode-play" href={appendReturnTo(`/watch/series/${id}?season=${selectedSeason}&episode=${episode.number}`, returnTo)} aria-label={`Watch ${episode.title}`}><Play size={14} fill="currentColor" /></a>
<span class="episode-chevron"><ChevronRight size={16} /></span></article>{/each}</div>{:else}<div class="episode-empty">No episode metadata is available for this season yet.</div>{/if}
</section>

<style>
  .episode-section { margin-top: 56px; }
  .episode-section > .section-head { align-items: end; padding-bottom: 15px; border-bottom: 1px solid var(--line); }
  .season-tabs { display: flex; gap: 4px; max-width: 58%; overflow-x: auto; padding: 4px; border: 1px solid var(--line); border-radius: var(--radius-sm); background: rgba(228,235,232,.035); scrollbar-width: none; }
  .season-tabs::-webkit-scrollbar { display: none; }
  .season-tabs button { flex: 0 0 auto; border: 0; border-radius: 7px; padding: 8px 11px; color: var(--muted); background: transparent; font-family: 'DM Mono', monospace; font-size: .58rem; }
  .season-tabs button.active, .season-tabs button:hover { color: var(--base); background: var(--accent-strong); }
  .episode-loading, .episode-error, .episode-empty { display: flex; align-items: center; gap: 9px; padding: 20px 0; border-bottom: 1px solid var(--line); color: var(--muted); font-size: .76rem; }
  .episode-error { color: var(--warning); }
  .episode-error .section-link { margin-left: auto; border: 0; background: none; cursor: pointer; }
  .episode-list { padding-top: 8px; }
  .episode-row { display: grid; grid-template-columns: 34px 150px minmax(0, 1fr) 32px 16px; align-items: center; gap: 16px; padding: 14px 12px; border-bottom: 1px solid var(--line); border-radius: 11px; transition: background 160ms var(--ease-out); }
  .episode-row:hover { background: rgba(228,235,232,.045); }
  .episode-number { color: var(--muted-deep); font-family: 'DM Mono', monospace; font-size: .62rem; }
  .episode-row img, .episode-still { width: 150px; aspect-ratio: 16 / 9; object-fit: cover; border: 1px solid var(--line); border-radius: 10px; background: var(--surface); }
  .episode-copy h3 { margin: 0 0 5px; color: var(--ink); font-size: .8rem; }
  .episode-meta { display: flex; gap: 7px; color: var(--muted-deep); font-family: 'DM Mono', monospace; font-size: .56rem; }
  .episode-copy p { max-width: 680px; margin: 7px 0 0; overflow: hidden; color: var(--muted); font-size: .7rem; line-height: 1.55; text-overflow: ellipsis; white-space: nowrap; }
  .episode-play { display: grid; place-items: center; width: 32px; height: 32px; border: 1px solid var(--line-strong); border-radius: 50%; color: var(--base); background: var(--accent-strong); transition: transform 160ms var(--ease-out), background 160ms var(--ease-out); }
  .episode-play:hover { background: #f3d29d; transform: translateY(-1px); }
  .episode-chevron { color: var(--muted-deep); }
  @media (max-width: 640px) { .episode-section > .section-head { align-items: start; flex-direction: column; gap: 13px; } .season-tabs { max-width: 100%; width: 100%; } .episode-row { grid-template-columns: 25px 92px minmax(0, 1fr) 30px; gap: 10px; padding-inline: 0; } .episode-row img, .episode-still { width: 92px; } .episode-chevron { display: none; } .episode-copy p { display: none; } }
</style>
