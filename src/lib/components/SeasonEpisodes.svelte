<script lang="ts">
  import { onMount } from 'svelte';
  import { AlertTriangle, ChevronRight, LoaderCircle, Play } from 'lucide-svelte';

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

  onMount(() => { void loadSeason(1); });
</script>

<section class="episode-section" aria-labelledby="episode-heading">
  <div class="section-head"><div><div class="eyebrow">MAVERO / Series guide</div><h2 class="section-title" id="episode-heading">Episodes</h2></div><div class="season-tabs" role="group" aria-label="Select season">{#each Array(Math.max(seasonCount, 1)) as _, index}<button class:active={selectedSeason === index + 1} aria-pressed={selectedSeason === index + 1} onclick={() => loadSeason(index + 1)}>Season {index + 1}</button>{/each}</div>
</div>
  {#if loading}<div class="episode-loading"><LoaderCircle size={15} /> Loading episodes…</div>{:else if errorMessage}<div class="episode-error" role="alert"><AlertTriangle size={15} /> {errorMessage}<button class="section-link" onclick={() => loadSeason(selectedSeason)}>Try again</button></div>{:else if season?.episodes?.length}<div class="episode-list">{#each season.episodes as episode}<article class="episode-row"><div class="episode-number">{String(episode.number).padStart(2, '0')}</div>{#if episode.still}<img src={episode.still} alt={`${episode.title} still`} loading="lazy" width="320" height="180" />
{:else}<div class="episode-still" aria-hidden="true"></div>{/if}<div class="episode-copy"><h3>{episode.title}</h3><div class="episode-meta">{episode.runtime ?? 'Episode'}{#if episode.airDate}<span>·</span>{episode.airDate}{/if}</div><p>{episode.overview || 'Episode details are not available yet.'}</p></div><a class="episode-play" href={`/watch/series/${id}/${selectedSeason}/${episode.number}`} aria-label={`Watch ${episode.title}`}><Play size={14} fill="currentColor" /></a><span class="episode-chevron"><ChevronRight size={16} /></span></article>{/each}</div>{:else}<div class="episode-empty">No episode metadata is available for this season yet.</div>{/if}
</section>

<style>
  .episode-section { margin-top: 56px; }
  .season-tabs { display: flex; gap: 6px; overflow-x: auto; scrollbar-width: none; }
  .season-tabs::-webkit-scrollbar { display: none; }
  .season-tabs button { flex: 0 0 auto; border: 1px solid var(--line); border-radius: 999px; padding: 8px 11px; color: var(--muted); background: transparent; font-family: 'DM Mono', monospace; font-size: .58rem; }
  .season-tabs button.active, .season-tabs button:hover { color: var(--ink); border-color: rgba(155,135,245,.45); background: var(--accent-soft); }
  .episode-loading, .episode-error, .episode-empty { display: flex; align-items: center; gap: 9px; padding: 20px 0; border-top: 1px solid var(--line); border-bottom: 1px solid var(--line); color: var(--muted); font-size: .76rem; }
  .episode-error { color: #d4b27c; }
  .episode-error .section-link { margin-left: auto; border: 0; background: none; cursor: pointer; }
  .episode-list { border-top: 1px solid var(--line); }
  .episode-row { display: grid; grid-template-columns: 28px 120px minmax(0, 1fr) 32px 16px; align-items: center; gap: 15px; padding: 14px 0; border-bottom: 1px solid var(--line); }
  .episode-number { color: var(--muted-deep); font-family: 'DM Mono', monospace; font-size: .62rem; }
  .episode-row img, .episode-still { width: 120px; aspect-ratio: 16 / 9; object-fit: cover; border-radius: 9px; background: #15171c; }
  .episode-copy h3 { margin: 0 0 5px; color: var(--ink); font-size: .8rem; }
  .episode-meta { display: flex; gap: 7px; color: var(--muted-deep); font-family: 'DM Mono', monospace; font-size: .56rem; }
  .episode-copy p { max-width: 680px; margin: 7px 0 0; overflow: hidden; color: var(--muted); font-size: .7rem; line-height: 1.55; text-overflow: ellipsis; white-space: nowrap; }
  .episode-play { display: grid; place-items: center; width: 32px; height: 32px; border: 1px solid var(--line); border-radius: 50%; color: var(--ink); background: rgba(255,255,255,.04); }
  .episode-chevron { color: var(--muted-deep); }
  @media (max-width: 640px) { .section-head { align-items: start; flex-direction: column; } .episode-row { grid-template-columns: 25px 92px minmax(0, 1fr) 30px; gap: 10px; } .episode-row img, .episode-still { width: 92px; } .episode-chevron { display: none; } .episode-copy p { display: none; } }
</style>
