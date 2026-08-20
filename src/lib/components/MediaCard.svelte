<script lang="ts">
  import { Star } from 'lucide-svelte';
  import type { MediaItem } from '$data/content';
  import { formatType } from '$data/content';

  export let item: MediaItem;
  export let compact = false;
</script>

<a class="card" href={item.resumeHref ?? `/${item.type}/${item.id}`} aria-label={item.resumeHref ? `Resume ${item.title}` : `Open ${item.title}`}>
  <div class="poster" style={`--poster-accent: ${item.accent}`}>
    <img src={item.poster} alt={`${item.title} poster`} loading="lazy" width="720" height="1080" />
    {#if item.tags?.[0] && !compact}
      <span class="card-tag">{item.tags[0]}</span>
    {/if}
    {#if item.rating > 0}
      <span class="card-rating"><Star size={10} fill="currentColor" strokeWidth={0} /> {item.rating.toFixed(1)}</span>
    {/if}
  </div>
  <div class="card-copy">
    <h3 class="card-title">{item.title}</h3>
    <div class="card-meta"><span>{item.year}</span><span>·</span><span>{formatType(item.type)}</span>{#if item.runtime}<span>·</span><span>{item.runtime}</span>{/if}</div>
    {#if item.progress}
      <div class="progress-track" role="progressbar" aria-label={`${item.progress}% watched`} aria-valuemin="0" aria-valuemax="100" aria-valuenow={item.progress}><span style={`width: ${item.progress}%`}></span></div>
      <div class="card-progress">{item.progressLabel}</div>
    {/if}
  </div>
</a>

<style>
  .card { display: block; }
  .card-copy { min-width: 0; padding: 8px 1px 0; }
  .card-title { letter-spacing: -.02em; }
  .card-meta { display: flex; align-items: center; gap: 5px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .card-progress { margin-top: 4px; color: var(--muted-deep); font-family: 'DM Mono', monospace; font-size: .53rem; }
  @media (prefers-reduced-motion: reduce) { .card, .poster img { transition: none; } }
</style>
