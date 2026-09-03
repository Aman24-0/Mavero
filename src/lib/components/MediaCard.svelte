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

<div class:compact class:editorial class="mc-wrap">
  <a class="mc-card" href={cardHref}>
    <div class="mc-poster" bind:this={posterElement} style={`--poster-accent: ${item.accent}`}>
      {#if !imageReady}
        <div class="mc-placeholder" aria-hidden="true"></div>
      {:else if imageFailed}
        <div class="mc-fallback" aria-label={`${item.title} image unavailable`}><span>{item.title.slice(0, 1).toUpperCase()}</span></div>
      {:else}
        <img src={item.poster} srcset={posterSrcset} sizes={posterSizes} alt={`${item.title} poster`} loading="lazy" decoding="async" width="342" height="513" onerror={() => { imageFailed = true; }} />
      {/if}
      <span class="mc-type">{formatType(item.type)}</span>
      {#if item.rating > 0}<span class="mc-rating"><Star size={9} fill="currentColor" strokeWidth={0} /> {item.rating.toFixed(1)}</span>{/if}
      <span class="mc-play" aria-hidden="true"><Play size={11} fill="currentColor" strokeWidth={0} /></span>
      {#if item.progress}
        <div class="mc-progress" role="progressbar" aria-label={`${item.progress}% watched`} aria-valuemin="0" aria-valuemax="100" aria-valuenow={item.progress}><span style={`width: ${item.progress}%`}></span></div>
      {/if}
    </div>
    <div class="mc-info">
      <h3 class="mc-title">{item.title}</h3>
      <div class="mc-meta"><span>{item.year}</span>{#if item.runtime}<span class="mc-sep">·</span><span>{item.runtime}</span>{/if}</div>
      {#if item.progressLabel}<div class="mc-progress-label">{item.progressLabel}</div>{/if}
    </div>
  </a>
  {#if item.resumeHref}<a class="mc-detail" href={detailHref} aria-label={`Open details for ${item.title}`}>Details</a>{/if}
</div>

<style>
  /* Use unique class names (mc-*) to avoid collision with global app.css .poster/.card rules */
  .mc-wrap { position: relative; min-width: 0; }
  .mc-card { display: block; text-decoration: none; }

  .mc-poster { isolation: isolate; position: relative; border-radius: 6px; overflow: hidden; aspect-ratio: 2 / 3; background: var(--surface-2); }
  .mc-placeholder { position: absolute; inset: 0; background: linear-gradient(135deg, var(--surface-2), rgba(255,255,255,.02)); }
  .mc-fallback { position: absolute; inset: 0; display: grid; place-items: center; color: rgba(255,255,255,.1); background: radial-gradient(circle at 72% 24%, color-mix(in srgb, var(--poster-accent) 25%, transparent), transparent 42%), var(--surface-2); }
  .mc-fallback span { font-size: clamp(1.5rem, 6vw, 3rem); font-weight: 900; }

  /* SHARP poster image — no blur, no filter, no overlay */
  .mc-poster img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; transition: transform 300ms var(--ease-out); }

  /* Compact badges — no backdrop-filter, no blur */
  .mc-type { position: absolute; top: 5px; left: 5px; z-index: 2; padding: 2px 6px; border-radius: 3px; color: rgba(255,255,255,.8); font-size: .5rem; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; background: rgba(0,0,0,.5); }
  .mc-rating { position: absolute; top: 5px; right: 5px; z-index: 2; display: inline-flex; align-items: center; gap: 2px; padding: 2px 6px; border-radius: 3px; color: #ffc94d; font-size: .52rem; font-weight: 700; background: rgba(0,0,0,.5); }

  /* Small play affordance */
  .mc-play {
    position: absolute; right: 6px; bottom: 6px; z-index: 2; display: grid; place-items: center;
    width: 24px; height: 24px; border-radius: 50%; color: #fff; background: rgba(255,56,96,.8);
    opacity: 0; transform: scale(.8);
    transition: opacity 200ms var(--ease-out), transform 200ms var(--ease-spring);
  }
  .mc-card:hover .mc-play, .mc-card:focus-visible .mc-play { opacity: 1; transform: scale(1); }
  .mc-card:hover .mc-poster img, .mc-card:focus-visible .mc-poster img { transform: scale(1.04); }

  /* Progress bar on poster */
  .mc-progress { position: absolute; left: 0; right: 0; bottom: 0; z-index: 2; height: 3px; background: rgba(0,0,0,.3); }
  .mc-progress > span { display: block; height: 100%; background: var(--accent); }

  .mc-info { padding: 6px 2px 0; }
  .mc-title { margin: 0; color: var(--ink); font-size: .76rem; font-weight: 600; line-height: 1.25; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .mc-meta { display: flex; align-items: center; gap: 4px; margin-top: 2px; color: var(--ink-soft); font-size: .64rem; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .mc-sep { color: var(--muted); opacity: .5; }
  .mc-progress-label { margin-top: 2px; color: var(--accent-strong); font-size: .55rem; font-weight: 600; }
  .mc-detail { position: absolute; bottom: -22px; left: 0; font-size: .58rem; color: var(--ink-soft); text-decoration: none; opacity: 0; transition: opacity var(--motion-fast); }
  .mc-wrap:hover .mc-detail { opacity: .7; }

  @media (max-width: 640px) {
    .mc-play { opacity: .8; transform: scale(1); width: 22px; height: 22px; }
    .mc-play :global(svg) { width: 10px; height: 10px; }
    .mc-detail { display: none; }
    .mc-type { font-size: .46rem; padding: 1px 5px; }
    .mc-rating { font-size: .48rem; padding: 1px 5px; }
  }
  @media (prefers-reduced-motion: reduce) {
    .mc-play, .mc-poster img { transition: none; }
  }
</style>
