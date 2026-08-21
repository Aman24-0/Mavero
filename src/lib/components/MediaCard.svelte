<script lang="ts">
  import { page } from '$app/state';
  import { Star } from 'lucide-svelte';
  import { appendReturnTo } from '$lib/shared/navigation';
  import type { MediaItem } from '$data/content';
  import { formatType } from '$data/content';

  export let item: MediaItem;
  export let compact = false;
  $: returnTo = `${page.url.pathname}${page.url.search}${page.url.hash}`;
  $: cardHref = item.resumeHref ? appendReturnTo(item.resumeHref, returnTo) : `/${item.type}/${item.id}`;
  $: detailHref = appendReturnTo(`/${item.type}/${item.id}`, returnTo);
</script>

<div class="card-wrap">
<a class="card" href={cardHref} aria-label={item.resumeHref ? `Resume ${item.title}` : `Open ${item.title}`}>
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
{#if item.resumeHref}<a class="card-detail-link" href={detailHref} aria-label={`Open details for ${item.title}`}>Details</a>{/if}
</div>

<style>
  .card-wrap { position: relative; min-width: 0; }
  .card { display: block; }
  .card-detail-link { position: absolute; right: 8px; bottom: 58px; z-index: 2; border: 1px solid rgba(255,255,255,.18); border-radius: 999px; padding: 5px 8px; color: var(--ink); background: rgba(8,9,11,.78); font-family: 'DM Mono', monospace; font-size: .52rem; text-decoration: none; opacity: 0; transform: translateY(4px); transition: opacity 160ms ease-out, transform 160ms ease-out, border-color 160ms ease-out; }
  .card-wrap:hover .card-detail-link, .card-detail-link:focus-visible { opacity: 1; transform: translateY(0); border-color: rgba(194,181,255,.55); }
  .card-copy { min-width: 0; padding: 8px 1px 0; }
  .card-title { letter-spacing: -.02em; }
  .card-meta { display: flex; align-items: center; gap: 5px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .card-progress { margin-top: 4px; color: var(--muted-deep); font-family: 'DM Mono', monospace; font-size: .53rem; }
  @media (prefers-reduced-motion: reduce) { .card, .poster img { transition: none; } }
</style>
