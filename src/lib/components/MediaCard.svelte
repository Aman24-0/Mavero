<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/state';
  import { Play, Star } from 'lucide-svelte';
  import { appendReturnTo } from '$lib/shared/navigation';
  import type { MediaItem } from '$data/content';
  import { formatType } from '$data/content';

  export let item: MediaItem;
  export let compact = false;
  export let editorial = false;
  let imageFailed = false;
  let imageReady = false;
  let posterElement: HTMLElement;
  $: if (item.poster) imageFailed = false;
  onMount(() => {
    if (!('IntersectionObserver' in window) || !posterElement) {
      imageReady = true;
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      imageReady = true;
      observer.disconnect();
    }, { rootMargin: '320px 0px' });
    observer.observe(posterElement);
    return () => observer.disconnect();
  });
  $: returnTo = `${page.url.pathname}${page.url.search}${page.url.hash}`;
  $: cardHref = item.resumeHref ? appendReturnTo(item.resumeHref, returnTo) : `/${item.type}/${item.id}`;
  $: detailHref = appendReturnTo(`/${item.type}/${item.id}`, returnTo);
</script>

<div class:compact class:editorial class="card-wrap">
  <a class="card" href={cardHref} aria-label={item.resumeHref ? `Resume ${item.title}` : `Open ${item.title}`}>
    <div class="poster" bind:this={posterElement} style={`--poster-accent: ${item.accent}`}>
      {#if !imageReady}
        <div class="poster-placeholder" aria-hidden="true"></div>
      {:else if imageFailed}
        <div class="poster-fallback" aria-label={`${item.title} image unavailable`}><span>{item.title.slice(0, 1).toUpperCase()}</span></div>
      {:else}
        <img src={item.poster} alt={`${item.title} poster`} loading="lazy" width="720" height="1080" onerror={() => { imageFailed = true; }} />
      {/if}
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
  .poster-placeholder { aspect-ratio: 2 / 3; background: linear-gradient(135deg, var(--surface-2), rgba(245,246,250,.04)); }
  .poster-fallback { display: grid; place-items: center; aspect-ratio: 2 / 3; color: rgba(245,246,250,.2); background: radial-gradient(circle at 72% 24%, color-mix(in srgb, var(--poster-accent) 45%, transparent), transparent 42%), var(--surface-2); }
  .poster-fallback span { font-size: clamp(2rem, 8vw, 4rem); font-weight: 900; }
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
