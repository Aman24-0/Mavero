<script lang="ts">
  import { page } from '$app/state';
  import { ArrowUpRight, Star } from 'lucide-svelte';
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
      <span class="poster-action" aria-hidden="true"><ArrowUpRight size={14} /></span>
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
  {#if item.resumeHref}<a class="card-detail-link" href={detailHref} aria-label={`Open details for ${item.title}`}>Details <ArrowUpRight size={11} /></a>{/if}
</div>

<style>
  .card-wrap { position: relative; min-width: 0; }
  .card-wrap.editorial .poster { border-color: rgba(244,241,234,.11); box-shadow: 0 10px 28px rgba(0,0,0,.24); }
  .card-wrap.editorial .card-copy { padding-top: 11px; }
  .card-wrap.editorial .card-title { font-family: 'Space Grotesk', sans-serif; font-weight: 600; }
  .card-wrap.editorial .card-meta { color: var(--muted); }
  .card-wrap.editorial .poster-type { color: rgba(244,241,234,.82); }
  .card-wrap.editorial .card-tag { border-color: rgba(244,241,234,.12); background: rgba(9,10,12,.52); }
  .card { display: block; }
  .poster { isolation: isolate; }
  .poster-type { position: absolute; right: 10px; bottom: 10px; z-index: 1; color: rgba(243,240,233,.72); font-family: 'DM Mono', monospace; font-size: .48rem; letter-spacing: .1em; text-transform: uppercase; }
  .poster-action { position: absolute; right: 10px; bottom: 30px; z-index: 2; display: grid; place-items: center; width: 28px; height: 28px; border: 1px solid rgba(228,235,232,.24); border-radius: 50%; color: var(--ink); background: rgba(8,11,13,.68); opacity: 0; transform: translateY(5px); transition: opacity 180ms var(--ease-out), transform 180ms var(--ease-out), background 180ms var(--ease-out); }
  .card:hover .poster-action, .card:focus-visible .poster-action { opacity: 1; transform: translateY(0); background: rgba(212,168,106,.86); color: #101010; }
  .card-detail-link { position: absolute; right: 8px; bottom: 57px; z-index: 2; display: inline-flex; align-items: center; gap: 4px; border: 1px solid rgba(228,235,232,.2); border-radius: 8px; padding: 5px 8px; color: var(--ink); background: rgba(8,11,13,.83); font-family: 'DM Mono', monospace; font-size: .5rem; text-decoration: none; opacity: 0; transform: translateY(4px); transition: opacity 160ms var(--ease-out), transform 160ms var(--ease-out), border-color 160ms var(--ease-out); }
  .card-wrap:hover .card-detail-link, .card-detail-link:focus-visible { opacity: 1; transform: translateY(0); border-color: rgba(212,168,106,.58); }
  .card-copy { min-width: 0; padding: 9px 2px 0; }
  .card-title { letter-spacing: -.02em; }
  .card-meta { display: flex; align-items: center; gap: 5px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  @media (max-width: 640px) { .poster-action { opacity: .9; transform: none; } .card-detail-link { display: none; } }
  @media (prefers-reduced-motion: reduce) { .card, .poster img, .poster-action, .card-detail-link { transition: none; } }
</style>
