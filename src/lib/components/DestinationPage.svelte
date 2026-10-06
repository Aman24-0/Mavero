<script lang="ts">
  import { Clapperboard, Info, Play } from 'lucide-svelte';
  import type { ContentType } from '$data/content';
  import type { MediaItem } from '$data/content';
  import { DESTINATION_LABELS } from '$lib/shared/content-labels';
  import ContentRail from '$components/ContentRail.svelte';
  import CollectionPage from '$components/CollectionPage.svelte';

  // Navigation & Settings Redesign, Phase 4 — the rich destination page.
  //
  // One shared component powers /movies, /tv-shows and /anime:
  //
  //   1. A cinematic full-bleed HERO — the featured trending/popular
  //      title for THIS destination (backdrop, meta, Play + More
  //      details). Falls back to a quiet heading block when the server
  //      has no hero (no fake content — same honesty contract as
  //      Discover's hero-fallback).
  //   2. Destination-scoped RAILS — rendered with the existing
  //      ContentRail component (Trending / Popular / Top rated /
  //      New & recent / curated genre rails where supported). Empty
  //      rails are already omitted server-side; the page never renders
  //      an empty section.
  //   3. The full COLLECTION below — the existing CollectionPage
  //      (variant="section") with its filters, grid and pagination.
  //      Browsing stays primary; the filter controls remain available
  //      but no longer dominate the page.
  //
  // Data comes from loadDestinationData() (server, composed from the
  // existing cached TMDB loaders) — no new backend fetching, no
  // duplicate implementations, playback links preserved via MediaCard.

  let {
    type,
    heroItem = undefined,
    rails = [],
    contentItems = [],
    currentPage = 1,
    hasNextPage = false,
    totalPages = undefined,
    collectionFilters = {},
    errorMessage = undefined
  }: {
    type: ContentType;
    heroItem?: MediaItem | undefined;
    rails?: { key: string; title: string; items: MediaItem[] }[];
    contentItems?: MediaItem[];
    currentPage?: number;
    hasNextPage?: boolean;
    totalPages?: number | undefined;
    collectionFilters?: { genre?: string; year?: string; sort?: 'For you' | 'Top rated' | 'Newest' };
    errorMessage?: string | undefined;
  } = $props();

  const labels = $derived(DESTINATION_LABELS[type]);
  const heroMeta = $derived(
    heroItem
      ? [heroItem.year ? String(heroItem.year) : '', heroItem.rating ? `★ ${heroItem.rating.toFixed(1)}` : '', ...(heroItem.genres ?? []).slice(0, 3)].filter(Boolean).join('  ·  ')
      : ''
  );
  const heroDescription = $derived(heroItem?.description?.trim() ?? '');
</script>

<svelte:head>
  <title>{labels.plural} — Mavero</title>
  <meta name="description" content={`Explore MAVERO's ${labels.prose}: featured picks, trending and top rated titles, and the full collection.`} />
  <link rel="canonical" href={`/`} />
  <meta property="og:title" content={`${labels.plural} — Mavero`} />
  <meta property="og:description" content={`Explore MAVERO's ${labels.prose}: featured picks, trending and top rated titles, and the full collection.`} />
  <meta name="twitter:card" content="summary" />
</svelte:head>

<div class="destination-page" data-destination={type}>
  {#if heroItem}
    <!-- Cinematic featured hero (this destination's top pick) -->
    <section class="dest-hero" aria-label={`Featured ${labels.singular}`}>
      <div class="hero-media" aria-hidden="true">
        {#if heroItem.backdrop}<img src={heroItem.backdrop} alt="" loading="eager" />{/if}
      </div>
      <div class="hero-scrim" aria-hidden="true"></div>
      <div class="hero-content">
        <div class="hero-eyebrow"><Clapperboard size={12} /> MAVERO / {labels.plural}</div>
        <h1 class="hero-title">{heroItem.title}</h1>
        {#if heroMeta}<p class="hero-meta">{heroMeta}</p>{/if}
        {#if heroDescription}<p class="hero-desc">{heroDescription}</p>{/if}
        <div class="hero-actions">
          <a class="hero-play" href={`/watch/${heroItem.type}/${heroItem.id}`}>
            <Play size={15} /> Play
          </a>
          <a class="hero-more" href={`/${heroItem.type}/${heroItem.id}`}>
            <Info size={15} /> More details
          </a>
        </div>
      </div>
    </section>
  {:else}
    <!-- Quiet fallback heading when the catalog has no featured pick -->
    <section class="dest-hero dest-hero-fallback" aria-label={labels.plural}>
      <div class="hero-content">
        <div class="hero-eyebrow"><Clapperboard size={12} /> MAVERO / {labels.plural}</div>
        <h1 class="hero-title">{labels.plural} <em>in focus.</em></h1>
        <p class="hero-desc">{errorMessage ?? labels.description}</p>
      </div>
    </section>
  {/if}

  <!-- Destination rails (server-composed, cached; empty rails omitted) -->
  {#each rails as rail (rail.key)}
    <ContentRail title={rail.title} items={rail.items} />
  {/each}

  <!-- The full collection: filters + grid + pagination (browsing primary) -->
  <CollectionPage
    {type}
    {contentItems}
    {currentPage}
    {hasNextPage}
    {totalPages}
    {collectionFilters}
    {errorMessage}
  />
</div>

<style>
  .destination-page {
    /* Full-bleed shell (same model as DiscoverPage): the page container
       applies NO width constraint and NO padding — each child owns its
       gutter (hero-content, ContentRail's --d-gutter, the collection
       section's --c-gutter). One gutter layer, perfectly aligned. */
    --c-gutter: clamp(16px, 5vw, 48px);
    padding-bottom: 40px;
  }

  /* ── Cinematic hero (full-bleed, edge-to-edge at every breakpoint —
     same treatment as the Discover hero) ── */
  .dest-hero {
    position: relative;
    min-height: clamp(340px, 52vh, 560px);
    display: flex;
    align-items: flex-end;
    overflow: hidden;
    isolation: isolate;
  }
  .hero-media { position: absolute; inset: 0; z-index: -2; }
  .hero-media img {
    width: 100%; height: 100%;
    object-fit: cover;
    transform: scale(1.02);
    animation: hero-drift 18s ease-in-out infinite alternate;
  }
  @keyframes hero-drift {
    from { transform: scale(1.02) translateX(0); }
    to { transform: scale(1.07) translateX(-1.5%); }
  }
  .hero-scrim {
    position: absolute; inset: 0; z-index: -1;
    background:
      linear-gradient(to top, rgba(4, 6, 8, .96) 8%, rgba(4, 6, 8, .55) 46%, rgba(4, 6, 8, .18) 78%, rgba(4, 6, 8, .28) 100%),
      linear-gradient(to right, rgba(4, 6, 8, .75), transparent 60%);
  }
  .hero-content {
    display: grid; gap: 10px;
    width: min(640px, 100%);
    /* Horizontal padding matches the rail/collection gutter exactly
       (one shared token) so the hero copy, rail headings and grid all
       align on one left edge. */
    padding: clamp(20px, 4vw, 44px) var(--c-gutter) clamp(22px, 4vw, 42px);
  }
  .hero-eyebrow {
    display: inline-flex; align-items: center; gap: 7px;
    color: var(--color-primary);
    font-size: .6rem; font-weight: 800;
    letter-spacing: .14em; text-transform: uppercase;
    text-shadow: 0 0 12px rgba(0, 255, 156, .35);
  }
  .hero-title {
    margin: 0;
    color: #f5f5f5;
    font-size: clamp(1.8rem, 4.6vw, 3.3rem);
    font-weight: 880; line-height: 1.03; letter-spacing: -.025em;
    text-wrap: balance;
    text-shadow: 0 2px 24px rgba(0, 0, 0, .6);
  }
  .hero-title em { color: #9a9aa2; font-style: normal; }
  .hero-meta {
    margin: 0;
    color: #c7c7cd;
    font-size: .78rem; font-weight: 700; letter-spacing: .02em;
  }
  .hero-meta :global(svg) { color: #ffd17a; }
  .hero-desc {
    margin: 0;
    display: -webkit-box; -webkit-line-clamp: 3; line-clamp: 3; -webkit-box-orient: vertical;
    overflow: hidden;
    color: #9a9aa2;
    font-size: .82rem; line-height: 1.6;
    max-width: 520px;
  }
  .hero-actions { display: flex; align-items: center; gap: 10px; margin-top: 6px; }
  .hero-play, .hero-more {
    display: inline-flex; align-items: center; gap: 7px;
    min-height: 44px; padding: 0 20px;
    border-radius: 999px;
    font-size: .78rem; font-weight: 800; letter-spacing: .01em;
    text-decoration: none;
    transition: transform var(--motion-fast) var(--ease-out), filter var(--motion-fast) var(--ease-out), background var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out);
  }
  .hero-play {
    color: #050708;
    background: var(--color-primary);
    border: 1px solid var(--color-primary);
    box-shadow: var(--glow-primary);
  }
  .hero-play:hover { transform: translateY(-1px); filter: brightness(1.06); }
  .hero-play:active { transform: scale(.98); }
  .hero-more {
    color: #e7e7ea;
    background: rgba(8, 11, 13, .55);
    border: 1px solid rgba(255, 255, 255, .14);
    backdrop-filter: blur(10px);
    -webkit-backdrop-filter: blur(10px);
  }
  .hero-more:hover { border-color: rgba(255, 255, 255, .3); background: rgba(8, 11, 13, .75); }
  .hero-play:focus-visible, .hero-more:focus-visible { outline: 2px solid var(--color-focus); outline-offset: 2px; }

  /* Fallback hero (no featured pick available) — quiet framed block
     (NOT full-bleed — it is a resting state, not a hero with art). */
  .dest-hero-fallback {
    min-height: auto;
    margin: 20px var(--c-gutter) 0;
    border-radius: 16px;
    background:
      radial-gradient(circle at 88% -40%, var(--color-primary-soft), transparent 46%),
      var(--color-bg);
    border: 1px solid var(--color-border);
  }

  /* ── Mobile ── */
  @media (max-width: 640px) {
    .dest-hero { min-height: clamp(300px, 46vh, 420px); }
    .hero-content { padding: 18px var(--c-gutter) 24px; }
    .hero-desc { -webkit-line-clamp: 2; line-clamp: 2; font-size: .78rem; }
    .hero-actions { gap: 8px; }
    .hero-play, .hero-more { flex: 1 1 auto; justify-content: center; padding: 0 14px; }
    .hero-meta { font-size: .7rem; }
    .dest-hero-fallback { margin: 12px var(--c-gutter) 0; border-radius: 12px; }
    .dest-hero-fallback .hero-content { padding: 18px 4px 20px; }
  }

  @media (prefers-reduced-motion: reduce) {
    .hero-media img { animation: none; }
    .hero-play, .hero-more { transition: none; }
  }
</style>
