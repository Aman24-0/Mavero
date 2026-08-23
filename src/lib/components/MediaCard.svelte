<script lang="ts">
  import { page } from '$app/state';
  import { Play, Star } from 'lucide-svelte';
  import { appendReturnTo } from '$lib/shared/navigation';
  import type { MediaItem } from '$data/content';
  import { formatType } from '$data/content';

  export let item: MediaItem;
  export let compact = false;
  export let editorial = false;
  $: returnTo = `${page.url.pathname}${page.url.search}${page.url.hash}`;
  $: cardHref = item.resumeHref ? appendReturnTo(item.resumeHref, returnTo) : `/${item.type}/${item.id}`;
  $: detailHref = appendReturnTo(`/${item.type}/${item.id}`, returnTo);
</script>

<div class:compact class:editorial class="card-wrap">
  <a class="card" href={cardHref} aria-label={item.resumeHref ? `Resume ${item.title}` : `Open ${item.title}`}>
    <div class="poster" style={`--poster-accent: ${item.accent}`}>
      <img src={item.poster} alt={`${item.title} poster`} loading="lazy" width="720" height="1080" />
      <span class="poster-type">{formatType(item.type)}</span>
      {#if item.tags?.[0] && !compact}<span class="card-tag">{item.tags[0]}</span>{/if}
      {#if item.rating > 0}<span class="card-rating"><Star size={10} fill="currentColor" strokeWidth={0} /> {item.rating.toFixed(1)}</span>{/if}
      <span class="poster-play" aria-hidden="true"><Play size={14} fill="currentColor" strokeWidth={0} /></span>
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
  {#if item.resumeHref}<a class="card-detail-link" href={detailHref} aria-label={`Open details for ${item.title}`}>Details</a>{/if}
</div>

<style>
  .card-wrap { position: relative; min-width: 0; }
  .card { display: block; }
  .poster { isolation: isolate; }
  .poster-play {
    position: absolute; right: 9px; bottom: 26px; z-index: 2; display: grid; place-items: center;
    width: 30px; height: 30px; border-radius: 50%; color: #fff; background: var(--accent-gradient);
    opacity: 0; transform: translateY(6px) scale(.85);
    transition: opacity 180ms var(--ease-out), transform 180ms var(--ease-spring);
    box-shadow: 0 6px 16px rgba(255, 56, 96, .35);
  }
  .card:hover .poster-play, .card:focus-visible .poster-play { opacity: 1; transform: translateY(0) scale(1); }
  .card-meta { display: flex; align-items: center; gap: 5px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  @media (max-width: 640px) { .poster-play { opacity: .95; transform: none; } .card-detail-link { display: none; } }
  @media (prefers-reduced-motion: reduce) { .poster-play { transition: none; } }
</style>
