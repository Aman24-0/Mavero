<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/state';
  import { goto } from '$app/navigation';
  import { ArrowLeft, ArrowRight, Heart, Play, Share2, Star, Info, ListPlus } from 'lucide-svelte';
  import SelectionSheet from '$components/SelectionSheet.svelte';
  import type { ContentType } from '$data/content';
  import { getMedia, media, formatType, type MediaItem } from '$data/content';
  import ContentRail from '$components/ContentRail.svelte';
  import SeasonEpisodes from '$components/SeasonEpisodes.svelte';
  import { getFavoriteStatus, getLocalProgressRecords, removeFavoriteFromMyList, setFavoriteStatus } from '$lib/client/progress/service';
  import type { WatchlistStatus } from '$lib/client/progress/types';
  import { latestResumeEpisode } from '$lib/client/progress/presenter';
  import { deleteCloudFavorite, syncAuthenticatedState } from '$lib/client/progress/cloud';
  import { appendReturnTo } from '$lib/shared/navigation';
  import { haptic } from '$lib/client/haptics';

  export let id = 'afterlight';
  export let type: ContentType = 'movie';
  export let dataItem: MediaItem | undefined = undefined;
  export let recommendationItems: MediaItem[] = [];
  let watchlistStatus: WatchlistStatus | null = null;
  let statusSheetOpen = false;
  let saveError = '';
  let resumeEpisode: { season: number; episode: number } | undefined;
  const statusOptions = [
    { key: 'watching', label: 'Watching', icon: '▶', description: 'Keep this in your current rotation.' },
    { key: 'planned', label: 'Planned', icon: '＋', description: 'Save it for a future night.' },
    { key: 'completed', label: 'Completed', icon: '✓', description: 'Mark this story as finished.' },
    { key: 'remove', label: 'Remove from My List', icon: '×', description: 'Take it out of your saved library.' },
  ];
  $: item = dataItem ?? getMedia(id);
  $: recommendations = recommendationItems.length ? recommendationItems : media.filter((candidate) => candidate.id !== item.id && candidate.type === type).slice(0, 6);
  $: statusSheetOptions = watchlistStatus ? statusOptions : statusOptions.filter((option) => option.key !== 'remove');
  $: canonicalUrl = `${page.url.origin}/${type}/${item.id}`;
  $: watchPath = type === 'movie' ? `/watch/${type}/${item.id}` : `/watch/${type}/${item.id}?season=${resumeEpisode?.season ?? 1}&episode=${resumeEpisode?.episode ?? 1}`;
  $: watchHref = appendReturnTo(watchPath, `${page.url.pathname}${page.url.search}${page.url.hash}`);
  $: structuredData = JSON.stringify({ '@context': 'https://schema.org', '@type': type === 'movie' ? 'Movie' : 'TVSeries', name: item.title, description: item.description, image: item.backdrop || item.poster, dateCreated: String(item.year), aggregateRating: { '@type': 'AggregateRating', ratingValue: item.rating, bestRating: 10, ratingCount: 1 } });
  $: trailerUrl = item.tags?.find((t) => t?.startsWith('http')) ? '' : '';
  $: trailerKey = (dataItem as unknown as { trailerKey?: string })?.trailerKey ?? '';

  onMount(() => {
    let active = true;
    void (async () => {
      const status = await getFavoriteStatus(type, item.id);
      const progress = await getLocalProgressRecords();
      if (!active) return;
      const hasActiveProgress = progress.some((record) => record.contentType === type && record.contentId === item.id && record.completionState !== 'completed' && record.currentTime > 0);
      const effectiveStatus = status ?? (hasActiveProgress ? 'watching' : null);
      watchlistStatus = effectiveStatus;
      if (type !== 'movie' && effectiveStatus === 'watching') {
        resumeEpisode = latestResumeEpisode(type, item.id, progress);
      }
    })();
    const autoplay = page.url.searchParams.get('autoplay') === '1';
    if (autoplay && typeof window !== 'undefined') {
      const params = new URLSearchParams(page.url.searchParams);
      params.delete('autoplay');
      const query = params.toString();
      const cleanDetail = `/${type}/${item.id}${query ? `?${query}` : ''}`;
      window.history.replaceState(window.history.state, '', cleanDetail);
      void goto(`/watch/${type}/${item.id}${query ? `?${query}` : ''}`);
    }
    return () => { active = false; };
  });

  function openStatusSheet() { statusSheetOpen = true; }
  function closeStatusSheet() { statusSheetOpen = false; }

  async function chooseStatus(key: string) {
    closeStatusSheet();
    try {
      if (key === 'remove') {
        await removeFavoriteFromMyList(type, item.id);
        watchlistStatus = null;
        if (page.data.user) {
          const deleted = await deleteCloudFavorite(type, item.id);
          if (!deleted) { saveError = 'Removed from this device; cloud removal will retry automatically.'; void syncAuthenticatedState(); }
          else { saveError = ''; }
        } else { saveError = ''; }
        haptic('success');
      } else if (key === 'watching' || key === 'planned' || key === 'completed') {
        const snapshot = { title: item.title, poster: item.poster, backdrop: item.backdrop, year: item.year, runtime: item.runtime, rating: item.rating, genres: item.genres, description: item.description };
        const record = await setFavoriteStatus(type, item.id, snapshot, key);
        watchlistStatus = record.status ?? key;
        if (page.data.user) void syncAuthenticatedState();
        haptic('success');
      }
      if (key !== 'remove') saveError = '';
    } catch { saveError = 'This device could not update your local list.'; }
  }

  function statusLabel(status: WatchlistStatus | null) {
    return status ? status.charAt(0).toUpperCase() + status.slice(1) : 'My list';
  }

  function goBack(event: MouseEvent) {
    event.preventDefault();
    haptic('light');
    const returnTo = page.url.searchParams.get('from');
    if (returnTo?.startsWith('/') && !returnTo.startsWith('//')) { void goto(returnTo, { replaceState: true, keepFocus: true }); return; }
    void goto('/discover', { replaceState: true, keepFocus: true });
  }

  async function shareItem() {
    try {
      if (navigator.share) await navigator.share({ title: item.title, text: `Watch ${item.title} on MAVERO`, url: canonicalUrl });
      else await navigator.clipboard?.writeText(canonicalUrl);
      haptic('success');
    } catch { /* cancelled share */ }
  }
</script>

<svelte:head>
  <title>{item.title} — Mavero</title>
  <meta name="description" content={item.description} />
  <link rel="canonical" href={canonicalUrl} />
  <meta property="og:type" content="video.movie" />
  <meta property="og:title" content={`${item.title} — Mavero`} />
  <meta property="og:description" content={item.description} />
  <meta property="og:url" content={canonicalUrl} />
  <meta property="og:image" content={item.backdrop || item.poster} />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content={`${item.title} — Mavero`} />
  <meta name="twitter:description" content={item.description} />
  <meta name="twitter:image" content={item.backdrop || item.poster} />
  <script type="application/ld+json">{structuredData}</script>
</svelte:head>

<div class="detail-page">
  <!-- Cinematic backdrop hero -->
  <div class="hero-backdrop">
    {#if item.backdrop}
      <img src={item.backdropSmall || item.backdrop} alt="" class="hero-img" />
    {/if}
    <div class="hero-scrim"></div>
  </div>

  <div class="detail-container">
    <!-- Back button -->
    <button class="back-btn" type="button" onclick={goBack}>
      <ArrowLeft size={16} /> <span>Back</span>
    </button>

    <!-- Title section -->
    <section class="title-section">
      <div class="poster-col">
        {#if item.poster}
          <img src={item.posterSmall || item.poster} alt={`${item.title} poster`} class="poster-img" />
        {/if}
      </div>
      <div class="info-col">
        <div class="detail-eyebrow">{formatType(type)}{#if item.genres[0]} · {item.genres[0]}{/if}</div>
        <h1 class="detail-title">{item.title}</h1>
        <div class="meta-row">
          {#if item.rating > 0}<span class="rating"><Star size={13} fill="currentColor" strokeWidth={0} /> {item.rating.toFixed(1)}</span>{/if}
          {#if item.year > 0}<span class="dot"></span><span>{item.year}</span>{/if}
          {#if item.maturity}<span class="dot"></span><span>{item.maturity}</span>{/if}
          {#if item.runtime}<span class="dot"></span><span>{item.runtime}</span>{/if}
          {#if type === 'series' && item.seasons}<span class="dot"></span><span>{item.seasons} season{item.seasons === 1 ? '' : 's'}</span>{/if}
        </div>
        <p class="detail-desc">{item.description}</p>
        {#if item.genres.length > 1}
          <div class="genre-tags">
            {#each item.genres as genre}<span class="genre-tag">{genre}</span>{/each}
          </div>
        {/if}

        <!-- Actions -->
        <div class="action-row">
          <a class="play-btn" href={watchHref}>
            <Play size={16} fill="currentColor" strokeWidth={0} />
            {#if type === 'series' && resumeEpisode}Continue S{resumeEpisode.season}:E{resumeEpisode.episode}{:else}Play{/if}
          </a>
          <button class="secondary-btn" onclick={openStatusSheet} aria-haspopup="dialog" aria-expanded={statusSheetOpen}>
            {#if watchlistStatus}<Heart size={15} fill="currentColor" />{:else}<ListPlus size={15} />{/if}
            {statusLabel(watchlistStatus)}
          </button>
          <button class="icon-only-btn" onclick={shareItem} aria-label={`Share ${item.title}`}>
            <Share2 size={16} />
          </button>
        </div>
        {#if saveError}<div class="save-error" role="status">{saveError}</div>{/if}
      </div>
    </section>

    <!-- Series: seasons + episodes -->
    {#if type === 'series'}
      <SeasonEpisodes id={item.id} seasonCount={item.seasons ?? 1} />
    {/if}

    <!-- Details section -->
    <section class="info-section">
      <h2 class="section-h">{type === 'movie' ? 'Movie' : 'Show'} Details</h2>
      <div class="details-grid">
        {#if item.status}<div class="detail-item"><span class="detail-label">Status</span><span class="detail-value">{item.status}</span></div>{/if}
        {#if item.year > 0}<div class="detail-item"><span class="detail-label">{type === 'movie' ? 'Release date' : 'First air date'}</span><span class="detail-value">{item.year}</span></div>{/if}
        {#if item.runtime}<div class="detail-item"><span class="detail-label">{type === 'movie' ? 'Runtime' : 'Seasons'}</span><span class="detail-value">{item.runtime}</span></div>{/if}
        {#if item.maturity}<div class="detail-item"><span class="detail-label">Certification</span><span class="detail-value">{item.maturity}</span></div>{/if}
        {#if item.rating > 0}<div class="detail-item"><span class="detail-label">Rating</span><span class="detail-value">{item.rating.toFixed(1)}/10</span></div>{/if}
        {#if type === 'series' && item.episodes}<div class="detail-item"><span class="detail-label">Episodes</span><span class="detail-value">{item.episodes}</span></div>{/if}
      </div>
    </section>

    <!-- Trailer -->
    {#if trailerKey}
      <section class="info-section">
        <h2 class="section-h">Trailer</h2>
        <div class="trailer-embed">
          <iframe
            src={`https://www.youtube.com/embed/${trailerKey}`}
            title={`${item.title} trailer`}
            loading="lazy"
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
            allowfullscreen
          ></iframe>
        </div>
      </section>
    {/if}

    <!-- Recommendations -->
    {#if recommendations.length}
      <div class="recs-rail">
        <ContentRail title="You may also like" eyebrow="Keep exploring" items={recommendations} compact />
      </div>
    {/if}
  </div>

  <SelectionSheet open={statusSheetOpen} eyebrow="MAVERO / My List" title="Add to My List" options={statusSheetOptions} selected={watchlistStatus ?? ''} onClose={closeStatusSheet} onSelect={chooseStatus} />
</div>

<style>
  .detail-page { position: relative; overflow: hidden; padding-bottom: 64px; }

  /* Cinematic backdrop */
  .hero-backdrop { position: absolute; inset: 0 0 auto; z-index: 0; height: 520px; overflow: hidden; }
  .hero-img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; object-position: center 18%; }
  .hero-scrim {
    position: absolute; inset: 0; pointer-events: none;
    background: linear-gradient(to bottom, transparent 20%, rgba(0,0,0,.4) 50%, #000 100%);
  }

  .detail-container {
    position: relative; z-index: 1;
    width: min(1400px, calc(100% - clamp(16px, 5vw, 80px))); margin-inline: auto;
  }

  /* Back button */
  .back-btn {
    display: inline-flex; align-items: center; gap: 6px; min-height: 36px; margin-top: 16px;
    padding: 0 14px; border: 1px solid rgba(255,255,255,.08); border-radius: 8px;
    color: #b7b7bd; background: rgba(0,0,0,.4); font: inherit; font-size: .72rem; font-weight: 600;
    cursor: pointer; transition: all 200ms cubic-bezier(.22,1,.36,1);
  }
  .back-btn:hover { color: #f5f5f5; border-color: rgba(255,255,255,.14); background: rgba(0,0,0,.6); }
  .back-btn:active { transform: scale(.97); }

  /* Title section */
  .title-section {
    display: grid; grid-template-columns: 200px minmax(0, 1fr); gap: 32px;
    align-items: start; padding: 28px 0 40px;
  }
  .poster-img {
    width: 100%; border-radius: 10px; border: 1px solid rgba(255,255,255,.06);
    box-shadow: 0 10px 30px rgba(0,0,0,.4);
  }
  .detail-eyebrow { color: #77777f; font-size: .62rem; font-weight: 700; letter-spacing: .1em; text-transform: uppercase; margin-bottom: 6px; }
  .detail-title {
    margin: 0; color: #f5f5f5; font-size: clamp(1.8rem, 4vw, 3rem); font-weight: 800;
    letter-spacing: -.025em; line-height: 1; text-wrap: balance;
    text-shadow: 0 2px 16px rgba(0,0,0,.4);
  }
  .meta-row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 12px; color: #b7b7bd; font-size: .78rem; font-weight: 500; }
  .meta-row .rating { display: inline-flex; align-items: center; gap: 3px; color: #ffc94d; font-weight: 600; }
  .dot { width: 3px; height: 3px; border-radius: 50%; background: #555; }
  .detail-desc {
    max-width: 640px; margin: 14px 0 0; color: #b7b7bd; font-size: .86rem; line-height: 1.6;
    display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 4; line-clamp: 4; overflow: hidden;
  }
  .genre-tags { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 14px; }
  .genre-tag {
    padding: 3px 10px; border: 1px solid rgba(255,255,255,.08); border-radius: 4px;
    color: #b7b7bd; font-size: .66rem; font-weight: 600;
  }

  /* Actions */
  .action-row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 20px; }
  .play-btn {
    display: inline-flex; align-items: center; gap: 7px; padding: 10px 24px; border-radius: 999px;
    color: #000; font-size: .82rem; font-weight: 700; text-decoration: none;
    background: #fff; box-shadow: 0 4px 20px rgba(255,255,255,.15);
    transition: transform 220ms cubic-bezier(.22,1,.36,1), box-shadow 220ms cubic-bezier(.22,1,.36,1);
  }
  .play-btn:hover { transform: translateY(-1px); box-shadow: 0 6px 24px rgba(255,255,255,.2); }
  .secondary-btn {
    display: inline-flex; align-items: center; gap: 6px; padding: 10px 16px; border-radius: 999px;
    color: #f5f5f5; font-size: .76rem; font-weight: 600; border: 1px solid rgba(255,255,255,.12);
    background: rgba(255,255,255,.06); cursor: pointer;
    transition: background 220ms cubic-bezier(.22,1,.36,1), border-color 220ms cubic-bezier(.22,1,.36,1);
  }
  .secondary-btn:hover { background: rgba(255,255,255,.12); border-color: rgba(255,255,255,.2); }
  .icon-only-btn {
    display: grid; place-items: center; width: 40px; height: 40px; border: 1px solid rgba(255,255,255,.08);
    border-radius: 50%; color: #b7b7bd; background: rgba(255,255,255,.04); cursor: pointer;
    transition: all 200ms cubic-bezier(.22,1,.36,1);
  }
  .icon-only-btn:hover { color: #f5f5f5; border-color: rgba(255,255,255,.14); }
  .save-error { margin-top: 8px; color: #ffb020; font-size: .66rem; }

  /* Info sections */
  .info-section { margin-top: 36px; padding: 0; }
  .section-h {
    color: #f5f5f5; font-size: 1.1rem; font-weight: 700; letter-spacing: -.02em;
    margin: 0 0 14px; padding-bottom: 10px; border-bottom: 1px solid rgba(255,255,255,.06);
  }
  .details-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 12px; }
  .detail-item { display: flex; flex-direction: column; gap: 3px; padding: 10px 12px; border: 1px solid rgba(255,255,255,.04); border-radius: 8px; background: rgba(255,255,255,.02); }
  .detail-label { color: #77777f; font-size: .58rem; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; }
  .detail-value { color: #f5f5f5; font-size: .76rem; font-weight: 600; }

  /* Trailer */
  .trailer-embed { position: relative; aspect-ratio: 16 / 9; border-radius: 10px; overflow: hidden; border: 1px solid rgba(255,255,255,.06); }
  .trailer-embed iframe { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; }

  /* Recommendations */
  .recs-rail { margin-top: 36px; }

  @media (max-width: 900px) {
    .title-section { grid-template-columns: 160px minmax(0, 1fr); gap: 24px; }
  }
  @media (max-width: 640px) {
    .hero-backdrop { height: 380px; }
    .back-btn { margin-top: calc(10px + env(safe-area-inset-top)); }
    .title-section { grid-template-columns: 100px minmax(0, 1fr); gap: 14px; padding: 16px 0 28px; }
    .detail-title { font-size: clamp(1.5rem, 7vw, 2.2rem); }
    .detail-desc { font-size: .8rem; -webkit-line-clamp: 3; line-clamp: 3; }
    .meta-row { font-size: .72rem; gap: 6px; }
    .play-btn { flex: 1; justify-content: center; }
    .details-grid { grid-template-columns: 1fr 1fr; }
    .info-section { margin-top: 28px; }
  }
  @media (prefers-reduced-motion: reduce) {
    .back-btn, .play-btn, .secondary-btn, .icon-only-btn { transition: none; }
  }
</style>
