<script lang="ts">
  import { ArrowLeft, ChevronDown, SlidersHorizontal } from 'lucide-svelte';
  import type { ContentType } from '$data/content';
  import { media, formatType } from '$data/content';
  import MediaCard from '$components/MediaCard.svelte';

  export let type: ContentType = 'movie';
  $: items = media.filter((item) => item.type === type);
  $: label = formatType(type);
  let sort = 'For you';
  const sorts = ['For you', 'Top rated', 'Newest'];
</script>

<svelte:head><title>{label}s — Mavero</title></svelte:head>

<div class="container-wide collection-page">
  <a class="back-link" href="/discover"><ArrowLeft size={15} /> Back to Discover</a>
  <section class="page-heading"><div class="eyebrow">MAVERO / Explore</div><h1>{label}s<br /><em>in focus.</em></h1><p>A focused collection for the nights when you know the kind of world you want to step into.</p></section>
  <div class="collection-tools"><div class="mode-tabs">{#each sorts as item}<button class:active={sort === item} class="mode-tab" onclick={() => (sort = item)}>{item}</button>{/each}</div><button class="mode-tab"><SlidersHorizontal size={14} /> Filters <ChevronDown size={13} /></button></div>
  <div class="results-grid">{#each items as item}<MediaCard {item} compact />{/each}</div>
</div>

<style>
  em { color: var(--accent); font-style: normal; }
  .back-link { display: inline-flex; align-items: center; gap: 8px; padding-top: 30px; color: var(--muted); font-size: .72rem; font-weight: 800; text-decoration: none; }
  .collection-page .page-heading { padding-top: 55px; }
  .collection-tools { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin: 6px 0 30px; }
  .collection-tools .mode-tabs { margin: 0; }
  .results-grid { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 22px 14px; padding-bottom: 90px; }
  @media (max-width: 1000px) { .results-grid { grid-template-columns: repeat(4, minmax(0, 1fr)); } }
  @media (max-width: 640px) { .back-link { padding-top: 101px; } .collection-page .page-heading { padding-top: 48px; } .collection-tools { align-items: start; flex-direction: column; } .results-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 24px 12px; } }
</style>
