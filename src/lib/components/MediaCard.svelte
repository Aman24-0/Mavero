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
      {#if item.rating > 0}<span class="card-rating"><Star size={9} fill="currentColor" strokeWidth={0} /> {item.rating.toFixed(1)}</span>{/if}
      <span class="poster-play" aria-hidden="true"><Play size={11} fill="currentColor" strokeWidth={0} /></span>
      {#if item.progress}
        <div class="poster-progress" role="progressbar" aria-label={`${item.progress}% watched`} aria-valuemin="0" aria-valuemax="100" aria-valuenow={item.progress}><span style={`width: ${item.progress}%`}></span></div>
      {/if}
    </div>
    <div class="card-copy">
      <h3 class="card-title">{item.title}</h3>
      <div class="card-meta"><span>{item.year}</span>{#if item.runtime}<span class="meta-sep">·</span><span>{item.runtime}</span>{/if}</div>
      {#if item.progressLabel}<div class="card-progress">{item.progressLabel}</div>{/if}
    </div>
  </a>
  {#if item.resumeHref}<a class="card-detail-link" href={detailHref} aria-label={`Open details for ${item.title}`}>Details</a>{/if}
</div>

<style>
  .card-wrap { position: relative; min-width: 0; }
  .card { display: block; text-decoration: none; }
  .poster { isolation: isolate; position: relative; border-radius: 6px; overflow: hidden; aspect-ratio: 2 / 3; background: var(--surface-2); }
  .poster-placeholder { position: absolute; inset: 0; background: linear-gradient(135deg, var(--surface-2), rgba(255,255,255,.02)); }
  .poster-fallback { position: absolute; inset: 0; display: grid; place-items: center; color: rgba(255,255,255,.12); background: radial-gradient(circle at 72% 24%, color-mix(in srgb, var(--poster-accent) 28%, transparent), transparent 42%), var(--surface-2); }
  .poster-fallback span { font-size: clamp(1.5rem, 6vw, 3rem); font-weight: 900; }
  .poster img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; transition: transform 300ms var(--ease-out); }

  .poster-type { position: absolute; top: 5px; left: 5px; z-index: 2; padding: 2px 6px; border-radius: 3px; color: rgba(255,255,255,.85); font-size: .5rem; font-weight: 700; letter-spacing: .05em; text-transform: uppercase; background: rgba(0,0,0,.55); }
  .card-rating { position: absolute; top: 5px; right: 5px; z-index: 2; display: inline-flex; align-items: center; gap: 2px; padding: 2px 6px; border-radius: 3px; color: #ffc94d; font-size: .55rem; font-weight: 700; background: rgba(0,0,0,.55); }

  .poster-play {
    position: absolute; right: 6px; bottom: 6px; z-index: 2; display: grid; place-items: center;
    width: 26px; height: 26px; border-radius: 50%; color: #fff; background: rgba(255,56,96,.85);
    opacity: 0; transform: scale(.8);
    transition: opacity 200ms var(--ease-out), transform 200ms var(--ease-spring);
  }
  .card:hover .poster-play, .card:focus-visible .poster-play { opacity: 1; transform: scale(1); }
  .card:hover .poster img, .card:focus-visible .poster img { transform: scale(1.04); }

  .poster-progress { position: absolute; left: 0; right: 0; bottom: 0; z-index: 2; height: 3px; background: rgba(0,0,0,.4); }
  .poster-progress > span { display: block; height: 100%; background: var(--accent); }

  .card-copy { padding: 6px 2px 0; }
  .card-title { color: var(--ink); font-size: .76rem; font-weight: 600; line-height: 1.25; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .card-meta { display: flex; align-items: center; gap: 4px; margin-top: 2px; color: var(--ink-soft); font-size: .64rem; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .meta-sep { color: var(--muted); opacity: .6; }
  .card-progress { margin-top: 2px; color: var(--accent-strong); font-size: .55rem; font-weight: 600; }
  .card-detail-link { position: absolute; bottom: -24px; left: 0; font-size: .6rem; color: var(--ink-soft); text-decoration: none; opacity: 0; transition: opacity var(--motion-fast); }
  .card-wrap:hover .card-detail-link { opacity: .8; }

  @media (max-width: 640px) {
    .poster-play { opacity: .85; transform: scale(1); width: 24px; height: 24px; }
    .poster-play :global(svg) { width: 10px; height: 10px; }
    .card-detail-link { display: none; }
    .poster-type { font-size: .48rem; padding: 1px 5px; }
    .card-rating { font-size: .5rem; padding: 1px 5px; }
  }
  @media (prefers-reduced-motion: reduce) {
    .poster-play, .poster img { transition: none; }
  }
</style>
