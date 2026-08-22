<script lang="ts">
  import { ArrowRight } from 'lucide-svelte';
  import type { MediaItem } from '$data/content';
  import MediaCard from '$components/MediaCard.svelte';

  export let title: string;
  export let eyebrow = '';
  export let items: MediaItem[] = [];
  export let href = '/discover';
  export let compact = false;
  export let variant: 'default' | 'editorial' = 'default';
</script>

<section class:compact class:editorial={variant === 'editorial'} class="section" aria-labelledby={`rail-${title.toLowerCase().replaceAll(' ', '-')}`}>
  <div class="section-head">
    <div class="section-heading-copy">
      {#if eyebrow}<div class="eyebrow">{eyebrow}</div>{/if}
      <h2 class="section-title" id={`rail-${title.toLowerCase().replaceAll(' ', '-')}`}>{title}</h2>
    </div>
    <a class="section-link" href={href} aria-label={`View all ${title}`}>View all <ArrowRight size={14} /></a>
  </div>
  <div class="rail" class:compact role="list" aria-label={title}>
    {#each items as item (item.type + ':' + item.id)}
      <div role="listitem"><MediaCard {item} {compact} editorial={variant === 'editorial'} /></div>
    {/each}
  </div>
</section>

<style>
  .section.editorial .section-heading-copy { position: relative; padding-left: 14px; }
  .section.editorial .section-heading-copy::before { content: ''; position: absolute; top: 4px; bottom: 2px; left: 0; width: 2px; border-radius: 999px; background: linear-gradient(180deg, var(--accent-strong), transparent); opacity: .82; }
  .section.editorial .section-link { letter-spacing: .02em; }
  .section.editorial .rail { gap: 16px; }
  @media (max-width: 640px) { .section.editorial .section-heading-copy { padding-left: 11px; } .section.editorial .rail { gap: 10px; } }
</style>
