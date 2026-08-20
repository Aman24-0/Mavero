<script lang="ts">
  import { Star, Play } from 'lucide-svelte';
  import type { MediaItem } from '$data/content';
  import { formatType } from '$data/content';

  export let item: MediaItem;
  export let compact = false;
</script>

<a class="card" href={item.resumeHref ?? `/${item.type}/${item.id}`} aria-label={item.resumeHref ? `Resume ${item.title}` : `Open ${item.title}`}>
  <div class="poster" style={`--poster-accent: ${item.accent}`}>
    <img src={item.poster} alt={`${item.title} poster`} loading="lazy" width="720" height="1080" />
    {#if item.tags?.[0]}
      <span class="card-tag">{item.tags[0]}</span>
    {/if}
    <span class="card-rating"><Star size={11} fill="currentColor" strokeWidth={0} /> {item.rating.toFixed(1)}</span>
    {#if compact}
      <span class="card-play" aria-hidden="true"><Play size={13} fill="currentColor" /></span>
    {/if}
  </div>
  <div class="card-copy">
    <h3 class="card-title">{item.title}</h3>
    <div class="card-meta">{item.year} <span>·</span> {formatType(item.type)} <span>·</span> {item.runtime}</div>
    {#if item.progress}
      <div class="progress-track" role="progressbar" aria-label={`${item.progress}% watched`} aria-valuemin="0" aria-valuemax="100" aria-valuenow={item.progress}><span style={`width: ${item.progress}%`}></span></div>
      <div class="card-progress">{item.progressLabel}</div>
    {/if}
  </div>
</a>

<style>
  .card-play { position: absolute; right: 10px; bottom: 10px; z-index: 2; display: grid; place-items: center; width: 30px; height: 30px; border: 1px solid rgba(255,255,255,.22); border-radius: 50%; color: var(--ink); background: rgba(8,9,11,.62); }
  .card-progress { margin-top: 5px; color: var(--muted-deep); font-family: 'DM Mono', monospace; font-size: .55rem; }
  @media (prefers-reduced-motion: reduce) { .card-play { transition: none; } }
</style>
