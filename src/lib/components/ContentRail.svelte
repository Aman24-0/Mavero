<script lang="ts">
  import { ArrowRight } from 'lucide-svelte';
  import type { MediaItem } from '$data/content';
  import MediaCard from '$components/MediaCard.svelte';

  export let title: string;
  export let eyebrow = '';
  export let items: MediaItem[] = [];
  export let href = '/discover';
  export let compact = false;
</script>

<section class:compact class="section" aria-labelledby={`rail-${title.toLowerCase().replaceAll(' ', '-')}`}>
  <div class="section-head">
    <div class="section-heading-copy">
      {#if eyebrow}<div class="eyebrow">{eyebrow}</div>{/if}
      <h2 class="section-title" id={`rail-${title.toLowerCase().replaceAll(' ', '-')}`}>{title}</h2>
    </div>
    <a class="section-link" href={href} aria-label={`View all ${title}`}>View all <ArrowRight size={14} /></a>
  </div>
  <div class="rail" class:compact role="list" aria-label={title}>
    {#each items as item (item.type + ':' + item.id)}
      <div role="listitem"><MediaCard {item} {compact} /></div>
    {/each}
  </div>
</section>
