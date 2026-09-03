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

<section class="section" class:editorial={variant === 'editorial'} aria-labelledby={`rail-${title.toLowerCase().replaceAll(' ', '-')}`}>
  <div class="section-head">
    <div class="section-heading-copy">
      {#if eyebrow}<div class="eyebrow">{eyebrow}</div>{/if}
      <h2 class="section-title" id={`rail-${title.toLowerCase().replaceAll(' ', '-')}`}>{title}</h2>
    </div>
    {#if href}<a class="section-link" href={href} aria-label={`View all ${title}`}>View all <ArrowRight size={13} /></a>{/if}
  </div>
  <div class="rail" class:compact role="list" aria-label={title}>
    {#each items as item (item.type + ':' + item.id)}
      <div role="listitem"><MediaCard {item} {compact} editorial={variant === 'editorial'} /></div>
    {/each}
  </div>
</section>

<style>
  .section { margin-top: 24px; }
  .section.editorial { margin-top: 32px; }
  .section-head { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 10px; padding: 0 clamp(16px, 4vw, 48px); }
  .section-heading-copy { display: flex; flex-direction: column; gap: 2px; }
  .eyebrow { color: var(--accent-strong); font-size: .58rem; font-weight: 700; letter-spacing: .1em; text-transform: uppercase; }
  .section-title { color: var(--ink); font-size: clamp(1rem, 2vw, 1.3rem); font-weight: 700; letter-spacing: -.015em; }
  .section-link { display: inline-flex; align-items: center; gap: 4px; color: var(--muted); text-decoration: none; font-size: .7rem; font-weight: 600; transition: color var(--motion-fast) var(--ease-out); flex: 0 0 auto; }
  .section-link:hover { color: var(--ink-soft); }
  .section-link :global(svg) { transition: transform var(--motion-fast) var(--ease-out); }
  .section-link:hover :global(svg) { transform: translateX(2px); }

  .rail { display: flex; gap: 8px; overflow-x: auto; scroll-snap-type: x proximity; padding: 0 clamp(16px, 4vw, 48px) 2px; scrollbar-width: none; -webkit-overflow-scrolling: touch; }
  .rail::-webkit-scrollbar { display: none; }
  .rail > * { scroll-snap-align: start; flex: 0 0 178px; min-width: 0; }

  @media (min-width: 641px) {
    .rail { gap: 12px; }
  }
  @media (max-width: 640px) {
    .rail > * { flex-basis: 40vw; }
    .section { margin-top: 20px; }
  }
</style>
