<script lang="ts">
  import { Search, ArrowUpRight, SlidersHorizontal } from 'lucide-svelte';
  import { media, formatType } from '$data/content';
  import MediaCard from '$components/MediaCard.svelte';

  let query = '';
  let type = 'All';
  const types = ['All', 'Movies', 'Series', 'Anime'];

  $: filtered = media.filter((item) => {
    const matchesQuery = !query.trim() || `${item.title} ${item.genres.join(' ')}`.toLowerCase().includes(query.trim().toLowerCase());
    const matchesType = type === 'All' || formatType(item.type) === type.slice(0, -1);
    return matchesQuery && matchesType;
  });
</script>

<svelte:head>
  <title>Search — Mavero</title>
</svelte:head>

<div class="container-wide">
  <section class="page-heading">
    <div class="eyebrow">MAVERO / Search</div>
    <h1>Find your next<br /><em>favorite.</em></h1>
    <p>Search the full Mavero universe across movies, series, and anime. Start with a title, a genre, or a mood.</p>
  </section>

  <div class="search-band search-large"><Search size={19} /><input bind:value={query} aria-label="Search titles" placeholder="What are you in the mood for?" /><kbd>⌘ K</kbd></div>
  <div class="mode-tabs" aria-label="Filter by content type">
    {#each types as item}
      <button class:active={type === item} class="mode-tab" onclick={() => (type = item)}>{item}</button>
    {/each}
    <button class="mode-tab"><SlidersHorizontal size={14} /> More filters</button>
  </div>

  {#if filtered.length}
    <section class="section" aria-live="polite">
      <div class="section-head"><div><div class="eyebrow">{filtered.length} titles</div><h2 class="section-title">{query ? `Results for “${query}”` : 'A considered place to start'}</h2></div></div>
      <div class="results-grid">
        {#each filtered as item}<MediaCard {item} compact />{/each}
      </div>
    </section>
  {:else}
    <section class="empty-search" aria-live="polite"><div class="eyebrow">No matching stories</div><h2>Nothing here yet.</h2><p>Try a different title, genre, or one of the curated collections on Discover.</p><a href="/discover" class="btn btn-secondary">Back to Discover <ArrowUpRight size={15} /></a></section>
  {/if}
</div>

<style>
  em { color: var(--accent); font-style: normal; }
  .search-large { margin-top: 9px; padding: 18px 17px; }
  .search-large input { font-size: 1rem; }
  kbd { color: var(--muted-deep); font-family: 'DM Mono', monospace; font-size: .6rem; white-space: nowrap; }
  .results-grid { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 21px 14px; }
  .empty-search { display: grid; place-items: center; min-height: 320px; margin-top: 45px; border-top: 1px solid var(--line); border-bottom: 1px solid var(--line); text-align: center; }
  .empty-search h2 { margin: 10px 0 6px; font-size: 2rem; letter-spacing: -.06em; }
  .empty-search p { max-width: 350px; margin: 0 0 22px; color: var(--muted); font-size: .82rem; line-height: 1.6; }
  @media (max-width: 1000px) { .results-grid { grid-template-columns: repeat(4, minmax(0, 1fr)); } }
  @media (max-width: 640px) { .results-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 24px 12px; } .page-heading h1 { font-size: 3.15rem; } }
</style>
