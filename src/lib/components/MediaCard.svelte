<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/state';
  import { Play, Star, Check } from 'lucide-svelte';
  import { appendReturnTo } from '$lib/shared/navigation';
  import { haptic } from '$lib/client/haptics';
  import type { MediaItem } from '$data/content';
  import { formatBadges } from '$data/content';

  export let item: MediaItem;
  export let compact = false;
  export let editorial = false;
  // ============================================================
  // Opt-in selection props (My List management only).
  //
  // Default behavior is UNCHANGED: selectable=false means the card
  // behaves exactly as before (poster link → DetailPage, play button
  // → /watch). Discover / Search / Upcoming / Continue Watching /
  // recommendation rails never set these props.
  //
  // When `selectable=true`, the card:
  //   - shows a checkbox badge in the top-left of the poster,
  //   - intercepts the poster click and the title click so they
  //     toggle selection instead of navigating to DetailPage,
  //   - hides the play button (so the user cannot accidentally
  //     start a stream while batch-selecting),
  //   - adds a subtle selected outline to the poster.
  //
  // Selection identity is the caller's responsibility — the card just
  // reports `onSelect(item)` and renders `selected` (bool). Callers
  // key selection by `contentType + contentId` (stable identity).
  // ============================================================
  export let selectable = false;
  export let selected = false;
  export let onSelect: (item: MediaItem) => void = () => {};
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
  $: cardHref = appendReturnTo(`/${item.type}/${item.id}`, returnTo);
  $: detailHref = appendReturnTo(`/${item.type}/${item.id}`, returnTo);
  // BUG #1 + #7 fix: prefer item.resumeHref (which carries the correct
  // ?season=X&episode=Y for series) when available. Fall back to the
  // bare first-play watch route when no resume target exists.
  $: watchHref = appendReturnTo(item.resumeHref ?? `/watch/${item.type}/${item.id}`, returnTo);
  $: posterSrcset = item.posterSmall ? `${item.posterSmall} 342w, ${item.poster} 500w` : undefined;
  $: posterSizes = compact ? '(max-width: 640px) calc((100vw - 38px) / 2), 150px' : '(max-width: 640px) 40vw, 178px';
  // Phase 7F+ (anime routing): dual-badge layout. Anime-flagged titles
  // (TMDB-tagged Demon Slayer movie, Attack on Titan series) render
  // ANIME at top-left and MOVIE/SERIES at top-right (next to the rating).
  // Plain movie/series keep their single badge at top-left (legacy).
  $: badges = formatBadges(item);

  function handleSelectToggle(event: Event) {
    if (!selectable) return;
    // Prevent the poster <a> from navigating.
    event.preventDefault();
    event.stopPropagation();
    haptic('light');
    onSelect(item);
  }
</script>

<div class:compact class:editorial class:selectable class:selected class="mc-wrap">
  <div class="mc-poster" bind:this={posterElement} style={`--poster-accent: ${item.accent}`}>
    {#if selectable}
      <!-- Selection mode: a button overlaying the whole poster so the
           tap target is the entire card. We do NOT nest the button
           inside the <a> (that would be invalid HTML). Instead we
           render the <a> as a non-interactive backdrop (tabindex=-1,
           aria-hidden) and let the button own the interaction. -->
      <a class="mc-card-link mc-card-link-disabled" href={cardHref} aria-label={`${item.title}`} tabindex="-1" aria-hidden="true" onclick={handleSelectToggle}>
        {#if !imageReady}
          <div class="mc-placeholder" aria-hidden="true"></div>
        {:else if imageFailed}
          <div class="mc-fallback" aria-label={`${item.title} image unavailable`}><span>{item.title.slice(0, 1).toUpperCase()}</span></div>
        {:else}
          <img src={item.poster} srcset={posterSrcset} sizes={posterSizes} alt={`${item.title} poster`} loading="lazy" decoding="async" width="342" height="513" onerror={() => { imageFailed = true; }} />
        {/if}
      </a>
      <button
        class="mc-select"
        type="button"
        aria-pressed={selected}
        aria-label={selected ? `Deselect ${item.title}` : `Select ${item.title}`}
        onclick={handleSelectToggle}
      >
        <span class="mc-select-box" class:checked={selected}>
          {#if selected}<Check size={14} strokeWidth={3} />{/if}
        </span>
      </button>
    {:else}
      <a class="mc-card-link" href={cardHref} aria-label={`${item.title}`}>
        {#if !imageReady}
          <div class="mc-placeholder" aria-hidden="true"></div>
        {:else if imageFailed}
          <div class="mc-fallback" aria-label={`${item.title} image unavailable`}><span>{item.title.slice(0, 1).toUpperCase()}</span></div>
        {:else}
          <img src={item.poster} srcset={posterSrcset} sizes={posterSizes} alt={`${item.title} poster`} loading="lazy" decoding="async" width="342" height="513" onerror={() => { imageFailed = true; }} />
        {/if}
      </a>
      <span class="mc-type">{badges.primary}</span>
      {#if badges.secondary}<span class="mc-type mc-type-secondary">{badges.secondary}</span>{/if}
      {#if item.rating > 0}<span class="mc-rating"><Star size={9} fill="currentColor" strokeWidth={0} /> {item.rating.toFixed(1)}</span>{/if}
      <a class="mc-play" href={watchHref} aria-label={item.resumeHref ? `Resume ${item.title}` : `Play ${item.title}`} onclick={(e) => e.stopPropagation()}>
        <Play size={12} fill="currentColor" strokeWidth={0} />
      </a>
      {#if item.progress}
        <div class="mc-progress" role="progressbar" aria-label={`${item.progress}% watched`} aria-valuemin="0" aria-valuemax="100" aria-valuenow={item.progress}><span style={`width: ${item.progress}%`}></span></div>
      {/if}
    {/if}
  </div>
  <div class="mc-info">
    {#if selectable}
      <button class="mc-title-link mc-title-btn" type="button" onclick={handleSelectToggle}>
        <h3 class="mc-title">{item.title}</h3>
        <div class="mc-meta"><span>{item.year}</span>{#if item.runtime}<span class="mc-sep">·</span><span>{item.runtime}</span>{/if}</div>
      </button>
    {:else}
      <a class="mc-title-link" href={cardHref}>
        <h3 class="mc-title">{item.title}</h3>
        <div class="mc-meta"><span>{item.year}</span>{#if item.runtime}<span class="mc-sep">·</span><span>{item.runtime}</span>{/if}</div>
      </a>
    {/if}
    {#if item.progressLabel}<div class="mc-progress-label">{item.progressLabel}</div>{/if}
  </div>
  {#if !selectable && item.resumeHref}<a class="mc-detail" href={detailHref} aria-label={`Open details for ${item.title}`}>Details</a>{/if}
</div>

<style>
  .mc-wrap { position: relative; min-width: 0; }

  .mc-poster {
    isolation: isolate; position: relative; border-radius: var(--radius-md); overflow: hidden;
    aspect-ratio: 2 / 3; background: var(--color-surface-elevated);
    border: 1px solid var(--color-border);
    transition: transform var(--motion-normal) var(--ease-spring), box-shadow var(--motion-normal) var(--ease-out), border-color var(--motion-normal) var(--ease-out);
  }
  .mc-card-link { display: block; height: 100%; outline: none; }
  /* In selection mode the <a> becomes a non-interactive backdrop so we
     can layer the selection button on top of the poster without nesting
     interactive elements. */
  .mc-card-link-disabled { pointer-events: none; cursor: default; }
  .mc-select {
    position: absolute; inset: 0; z-index: 4;
    padding: 0; border: 0; background: transparent; cursor: pointer;
    display: grid;
    align-content: start;
    justify-content: start;
  }
  .mc-select:focus-visible { outline: none; }
  .mc-select-box {
    display: grid; place-items: center;
    width: 26px; height: 26px;
    margin: 8px;
    border: 2px solid rgba(242, 255, 248, .8);
    border-radius: 7px;
    background: rgba(5, 7, 8, .55);
    color: #050708;
    backdrop-filter: blur(6px);
    transition: background 160ms ease, border-color 160ms ease, transform 160ms ease;
  }
  .mc-select-box.checked {
    background: var(--color-primary);
    border-color: var(--color-primary);
    box-shadow: var(--glow-primary);
  }
  .mc-select:focus-visible .mc-select-box {
    box-shadow: 0 0 0 3px rgba(0, 255, 156, .35);
  }
  .mc-select:active .mc-select-box { transform: scale(.92); }
  .mc-title-btn {
    display: block; width: 100%;
    padding: 6px 2px 0; margin: 0;
    border: 0; background: transparent; text-align: left; cursor: pointer;
  }
  /* Subtle selected outline on the poster. */
  .mc-wrap.selectable .mc-poster {
    outline: 2px solid transparent;
    outline-offset: 2px;
    transition: transform var(--motion-normal) var(--ease-spring), outline-color 180ms ease;
  }
  .mc-wrap.selectable.selected .mc-poster {
    outline-color: var(--color-primary);
    box-shadow: var(--glow-primary);
  }
  .mc-wrap.selectable .mc-poster:hover { transform: none; box-shadow: none; }
  .mc-placeholder { position: absolute; inset: 0; background: linear-gradient(135deg, var(--color-surface-elevated), rgba(0,255,156,.02)); }
  .mc-fallback { position: absolute; inset: 0; display: grid; place-items: center; color: rgba(242,255,248,.12); background: radial-gradient(circle at 72% 24%, color-mix(in srgb, var(--poster-accent) 25%, transparent), transparent 42%), var(--color-surface-elevated); }
  .mc-fallback span { font-size: clamp(1.5rem, 6vw, 3rem); font-weight: 800; }

  .mc-poster img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }

  .mc-type {
    position: absolute; top: 6px; left: 6px; z-index: 2;
    padding: 2px 7px; border-radius: 4px;
    color: rgba(242,255,248,.85); font-size: .5rem; font-weight: 800; letter-spacing: .06em; text-transform: uppercase;
    background: rgba(5,7,8,.7); backdrop-filter: blur(6px);
    border: 1px solid var(--color-border-strong);
  }
  /* Phase 7F+ (anime routing): the secondary badge sits next to the
     primary badge at top-left, separated by a small gap. Both stay
     compact (.5rem font, 4px radius) so they fit on mobile without
     overlapping the rating pill at top-right. */
  .mc-type-secondary {
    left: auto; right: 6px;
  }
  .mc-rating {
    position: absolute; top: 6px; right: 6px; z-index: 1;
    display: inline-flex; align-items: center; gap: 2px;
    padding: 2px 7px; border-radius: 4px;
    color: #ffc94d; font-size: .54rem; font-weight: 800;
    background: rgba(5,7,8,.7); backdrop-filter: blur(6px);
    border: 1px solid var(--color-border-strong);
  }
  /* When the secondary badge is present, the rating pill drops to
     bottom-right so it doesn't overlap the secondary badge. This
     only happens for anime-flagged content (rare). For all other
     content, the rating stays at top-right (legacy behavior). */
  .mc-type-secondary ~ .mc-rating {
    top: auto; bottom: 6px; right: 6px;
  }

  .mc-play {
    position: absolute; right: 8px; bottom: 8px; z-index: 3;
    display: grid; place-items: center;
    width: 36px; height: 36px; border-radius: 50%;
    color: #050708; background: var(--color-primary);
    box-shadow: 0 4px 14px rgba(0,0,0,.45), var(--glow-primary);
    opacity: 0; transform: scale(.85);
    transition: opacity var(--motion-normal) var(--ease-out), transform var(--motion-normal) var(--ease-spring), box-shadow var(--motion-fast) var(--ease-out);
    text-decoration: none;
  }
  /* Hover + focus reveal — desktop hover, keyboard focus, and TV focus
     (which arrives via :focus-visible on the link) all elevate the
     poster so cards in every context get the same strong
     affordance. The scale is gentle (1.04) so it doesn't cause
     clipping inside the rail grid. */
  .mc-wrap:has(.mc-card-link:hover) .mc-poster, .mc-wrap:has(.mc-card-link:focus-visible) .mc-poster {
    transform: translateY(-4px) scale(1.04);
    box-shadow: 0 18px 36px rgba(0,0,0,.55), 0 0 0 1px var(--color-primary-border), var(--glow-primary);
    border-color: var(--color-primary-border);
  }
  .mc-wrap:has(.mc-card-link:hover) .mc-play, .mc-wrap:has(.mc-card-link:focus-visible) .mc-play { opacity: 1; transform: scale(1.06); }
  .mc-play:hover { background: var(--color-primary); filter: brightness(1.06); transform: scale(1.12); box-shadow: 0 6px 20px rgba(0,255,156,.4), var(--glow-primary); }
  /* Phase 2-M (A11Y-1): reveal Play/Details controls on their OWN keyboard focus
     too, not just when the parent card link is focused. Without this, Tab-ing
     from the card link onto the Play link leaves Play invisible (opacity:0)
     even though it's the active focus target — the focus ring is also
     suppressed by opacity. */
  .mc-play:focus-visible { opacity: 1; transform: scale(1.06); outline: 2px solid var(--color-focus); outline-offset: 2px; }
  .mc-detail:focus-visible { opacity: 1; outline: 2px solid var(--color-focus); outline-offset: 2px; }

  /* Watch progress bar — cyber green, restrained glow so it doesn't
     overpower the artwork. */
  .mc-progress { position: absolute; left: 0; right: 0; bottom: 0; z-index: 2; height: 3px; background: rgba(5,7,8,.45); }
  .mc-progress > span { display: block; height: 100%; background: var(--color-primary); box-shadow: 0 0 6px var(--color-primary); }

  .mc-info { padding: 8px 2px 0; }
  .mc-title-link { text-decoration: none; }
  .mc-title { margin: 0; color: var(--color-text); font-size: .8rem; font-weight: 700; line-height: 1.25; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .mc-meta { display: flex; align-items: center; gap: 4px; margin-top: 3px; color: var(--color-text-muted); font-size: .66rem; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .mc-sep { color: var(--color-text-deep); opacity: .65; }
  .mc-progress-label { margin-top: 3px; color: var(--color-primary); font-size: .58rem; font-weight: 700; letter-spacing: .02em; }
  .mc-detail { position: absolute; bottom: -22px; left: 0; font-size: .58rem; color: var(--color-text-muted); text-decoration: none; opacity: 0; transition: opacity 150ms ease; }
  .mc-wrap:hover .mc-detail { opacity: .7; }

  @media (max-width: 640px) {
    .mc-play { opacity: .9; transform: scale(1); width: 30px; height: 30px; }
    .mc-play :global(svg) { width: 11px; height: 11px; }
    .mc-detail { display: none; }
    .mc-type { font-size: .46rem; padding: 1px 6px; }
    .mc-type-secondary { font-size: .46rem; padding: 1px 6px; }
    .mc-rating { font-size: .5rem; padding: 1px 6px; }
    /* Mobile / touch: don't elevate the card on hover — there's no
       hover on touch, and an accidental :hover would leave the card
       visually elevated with no way to dismiss it. TV remotes still
       benefit from the :focus-visible elevation above. */
    .mc-wrap:has(.mc-card-link:hover) .mc-poster { transform: none; box-shadow: none; border-color: var(--color-border); }
  }
  @media (min-width: 1025px) {
    .mc-play { width: 40px; height: 40px; }
    .mc-title { font-size: .84rem; }
    .mc-meta { font-size: .7rem; }
  }
  @media (min-width: 1900px) {
    .mc-play { width: 44px; height: 44px; }
    .mc-type { font-size: .55rem; padding: 3px 8px; }
    .mc-rating { font-size: .58rem; padding: 3px 8px; }
  }
  @media (prefers-reduced-motion: reduce) {
    .mc-play, .mc-poster, .mc-select-box { transition: none; }
    .mc-wrap:has(.mc-card-link:hover) .mc-poster, .mc-wrap:has(.mc-card-link:focus-visible) .mc-poster { transform: none; }
  }
</style>
