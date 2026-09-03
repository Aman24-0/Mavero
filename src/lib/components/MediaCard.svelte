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
  $: posterSrcset = item.posterSmall ? `${item.posterSmall} 342w, ${item.poster} 500w` : undefined;
  $: posterSizes = compact ? '(max-width: 640px) calc((100vw - 38px) / 2), 150px' : '(max-width: 640px) 40vw, 178px';
</script>

<div class:compact class:editorial class="card-wrap">
  <a class="card" href={cardHref}>
    <div class="poster" bind:this={posterElement} style={`--poster-accent: ${item.accent}`}>
      {#if !imageReady}
        <div class="poster-placeholder" aria-hidden="true"></div>
      {:else if imageFailed}
        <div class="poster-fallback" aria-label={`${item.title} image unavailable`}><span>{item.title.slice(0, 1).toUpperCase()}</span></div>
      {:else}
        <img src={item.poster} srcset={posterSrcset} sizes={posterSizes} alt={`${item.title} poster`} loading="lazy" decoding="async" width="342" height="513" onerror={() => { imageFailed = true; }} />
      {/if}
      <span class="poster-type">{formatType(item.type)}</span>
      {#if item.rating > 0}<span class="card-rating"><Star size={10} fill="currentColor" strokeWidth={0} /> {item.rating.toFixed(1)}</span>{/if}
      <span class="poster-play" aria-hidden="true"><Play size={14} fill="currentColor" strokeWidth={0} /></span>
    </div>
    <div class="card-copy">
      <h3 class="card-title">{item.title}</h3>
      <div class="card-meta"><span>{item.year}</span>{#if item.runtime}<span class="meta-sep">·</span><span>{item.runtime}</span>{/if}</div>
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
  .poster { isolation: isolate; position: relative; border-radius: 8px; overflow: hidden; }
  .poster-placeholder { aspect-ratio: 2 / 3; background: linear-gradient(135deg, var(--surface-2), rgba(255,255,255,.03)); }
  .poster-fallback { display: grid; place-items: center; aspect-ratio: 2 / 3; color: rgba(255,255,255,.15); background: radial-gradient(circle at 72% 24%, color-mix(in srgb, var(--poster-accent) 35%, transparent), transparent 42%), var(--surface-2); }
  .poster-fallback span { font-size: clamp(2rem, 8vw, 3.5rem); font-weight: 900; }
  .poster img { display: block; width: 100%; aspect-ratio: 2 / 3; object-fit: cover; transition: transform 320ms var(--ease-out); }

  .poster-type { position: absolute; top: 6px; left: 6px; z-index: 2; padding: 2px 7px; border-radius: 4px; color: #fff; font-size: .55rem; font-weight: 800; letter-spacing: .06em; text-transform: uppercase; background: rgba(0,0,0,.65); backdrop-filter: blur(6px); }
  .card-rating { position: absolute; top: 6px; right: 6px; z-index: 2; display: inline-flex; align-items: center; gap: 3px; padding: 2px 7px; border-radius: 4px; color: #ffc94d; font-size: .6rem; font-weight: 700; background: rgba(0,0,0,.65); backdrop-filter: blur(6px); }
  .poster-play {
    position: absolute; right: 8px; bottom: 8px; z-index: 2; display: grid; place-items: center;
    width: 32px; height: 32px; border-radius: 50%; color: #fff; background: var(--accent-gradient);
    opacity: 0; transform: translateY(4px) scale(.85);
    transition: opacity 180ms var(--ease-out), transform 180ms var(--ease-spring);
    box-shadow: 0 4px 14px rgba(255, 56, 96, .35);
  }
  .card:hover .poster-play, .card:focus-visible .poster-play { opacity: 1; transform: translateY(0) scale(1); }
  .card:hover .poster img, .card:focus-visible .poster img { transform: scale(1.03); }

  .card-copy { padding: 8px 2px 0; }
  .card-title { color: var(--ink); font-size: .8rem; font-weight: 700; line-height: 1.3; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .card-meta { display: flex; align-items: center; gap: 5px; margin-top: 3px; color: var(--ink-soft); font-size: .68rem; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .meta-sep { color: var(--muted); }
  .progress-track { margin-top: 6px; height: 3px; border-radius: 999px; background: var(--surface-raised); overflow: hidden; }
  .progress-track > span { display: block; height: 100%; border-radius: 999px; background: var(--accent-gradient); }
  .card-progress { margin-top: 3px; color: var(--ink-soft); font-size: .58rem; font-weight: 600; }

  @media (max-width: 640px) {
    .poster-play { opacity: .9; transform: none; }
    .card-detail-link { display: none; }
  }
  @media (prefers-reduced-motion: reduce) {
    .poster-play, .poster img { transition: none; }
  }
</style>
