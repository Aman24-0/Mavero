<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/state';
  import { goto } from '$app/navigation';
  import { ArrowLeft, Heart, Play, Share2, Star, ListPlus, Film, X } from 'lucide-svelte';
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
  let overviewExpanded = false;
  let trailerOpen = false;
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
  $: trailerKey = item.trailerKey ?? '';
  $: hasTrailer = Boolean(trailerKey);
  $: castMembers = item.cast ?? [];
  $: hasLongOverview = item.description.length > 240;

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
    return status ? status.charAt(0).toUpperCase() + status.slice(1) : 'My List';
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

  function openTrailer() {
    if (!hasTrailer) return;
    trailerOpen = true;
    haptic('light');
  }
  function closeTrailer() { trailerOpen = false; }
  function handleTrailerKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape' && trailerOpen) closeTrailer();
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

<svelte:window onkeydown={handleTrailerKeydown} />

<div class="detail-page">
  <!-- Cinematic backdrop hero (full width) -->
  <header class="hero">
    {#if item.backdrop}
      <img src={item.backdropSmall || item.backdrop} alt="" class="hero-img" loading="eager" fetchpriority="high" />
    {/if}
    <div class="hero-scrim"></div>
    <button class="back-btn" type="button" onclick={goBack} aria-label="Go back">
      <ArrowLeft size={16} /> <span>Back</span>
    </button>
  </header>

  <!-- Centered poster overlapping backdrop -->
  <div class="poster-wrap">
    {#if item.poster}
      <img src={item.posterSmall || item.poster} alt={`${item.title} poster`} class="poster-img" />
    {/if}
  </div>

  <div class="detail-container">
    <!-- Title + metadata + overview + genres -->
    <section class="identity">
      <div class="detail-eyebrow">{formatType(type)}</div>
      <h1 class="detail-title">{item.title}</h1>

      <div class="meta-row">
        {#if item.rating > 0}
          <span class="rating"><Star size={12} fill="currentColor" strokeWidth={0} /> {item.rating.toFixed(1)}</span>
        {/if}
        {#if item.year > 0}<span class="dot"></span><span>{item.year}</span>{/if}
        {#if item.maturity}<span class="dot"></span><span>{item.maturity}</span>{/if}
        {#if type === 'series' && item.seasons}
          <span class="dot"></span><span>{item.seasons} season{item.seasons === 1 ? '' : 's'}</span>
        {:else if type === 'movie' && item.runtime}
          <span class="dot"></span><span>{item.runtime}</span>
        {/if}
      </div>

      {#if item.description}
        <p class="detail-desc" class:expanded={overviewExpanded}>{item.description}</p>
        {#if hasLongOverview}
          <button class="show-more" type="button" onclick={() => (overviewExpanded = !overviewExpanded)} aria-expanded={overviewExpanded}>
            {overviewExpanded ? 'Show Less' : 'Show More'}
          </button>
        {/if}
      {/if}

      {#if item.genres.length}
        <div class="genre-tags">
          {#each item.genres as genre}<span class="genre-tag">{genre}</span>{/each}
        </div>
      {/if}
    </section>

    <!-- Actions -->
    <section class="actions">
      <a class="play-btn" href={watchHref}>
        <Play size={16} fill="currentColor" strokeWidth={0} />
        {#if type === 'series' && resumeEpisode}Continue S{resumeEpisode.season}:E{resumeEpisode.episode}{:else}Play{/if}
      </a>
      <div class="secondary-actions">
        <button class="secondary-btn" onclick={openStatusSheet} aria-haspopup="dialog" aria-expanded={statusSheetOpen}>
          {#if watchlistStatus}<Heart size={15} fill="currentColor" />{:else}<ListPlus size={15} />{/if}
          <span>{statusLabel(watchlistStatus)}</span>
        </button>
        <button class="secondary-btn" onclick={shareItem} aria-label={`Share ${item.title}`}>
          <Share2 size={15} /><span>Share</span>
        </button>
        {#if hasTrailer}
          <button class="secondary-btn" onclick={openTrailer} aria-haspopup="dialog" aria-expanded={trailerOpen}>
            <Film size={15} /><span>Trailer</span>
          </button>
        {/if}
      </div>
      {#if saveError}<div class="save-error" role="status">{saveError}</div>{/if}
    </section>

    <!-- Cast -->
    {#if castMembers.length}
      <section class="cast-section" aria-labelledby="cast-heading">
        <h2 class="section-h" id="cast-heading">Cast</h2>
        <div class="cast-rail" role="list">
          {#each castMembers as member}
            <div class="cast-card" role="listitem">
              {#if member.photo}
                <img src={member.photo} alt={member.name} class="cast-photo" loading="lazy" decoding="async" />
              {:else}
                <div class="cast-photo cast-photo-fallback" aria-hidden="true"><span>{member.name.slice(0, 1).toUpperCase()}</span></div>
              {/if}
              <div class="cast-name">{member.name}</div>
              {#if member.character}<div class="cast-character">{member.character}</div>{/if}
            </div>
          {/each}
        </div>
      </section>
    {/if}

    <!-- Series: seasons + episodes -->
    {#if type === 'series'}
      <SeasonEpisodes id={item.id} seasonCount={item.seasons ?? 1} />
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

<!-- Trailer modal (only renders when a real trailerKey exists) -->
{#if trailerOpen && hasTrailer}
  <div class="trailer-layer" role="presentation">
    <button class="trailer-backdrop" aria-label="Close trailer" onclick={closeTrailer}></button>
    <div class="trailer-modal" role="dialog" aria-modal="true" aria-label={`${item.title} trailer`}>
      <div class="trailer-bar">
        <div class="trailer-title"><Film size={14} /> {item.title} — Trailer</div>
        <button class="trailer-close" type="button" aria-label="Close trailer" onclick={closeTrailer}><X size={16} /></button>
      </div>
      <div class="trailer-frame">
        <iframe
          src={`https://www.youtube.com/embed/${trailerKey}?autoplay=1&rel=0`}
          title={`${item.title} trailer`}
          loading="lazy"
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
          allowfullscreen
        ></iframe>
      </div>
    </div>
  </div>
{/if}

<style>
  .detail-page { position: relative; overflow: hidden; padding-bottom: 80px; background: #000; }

  /* Hero backdrop */
  .hero { position: relative; width: 100%; height: clamp(280px, 56vw, 460px); overflow: hidden; background: #0a0a10; }
  .hero-img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; object-position: center 22%; }
  .hero-scrim {
    position: absolute; inset: 0; pointer-events: none;
    background:
      linear-gradient(to bottom, rgba(0,0,0,.55) 0%, transparent 22%, transparent 55%, rgba(0,0,0,.55) 80%, #000 100%),
      linear-gradient(to right, rgba(0,0,0,.25), transparent 30%, transparent 70%, rgba(0,0,0,.25));
  }
  .back-btn {
    position: absolute; top: calc(14px + env(safe-area-inset-top)); left: 14px; z-index: 4;
    display: inline-flex; align-items: center; gap: 6px; min-height: 36px;
    padding: 0 14px; border: 1px solid rgba(255,255,255,.12); border-radius: 999px;
    color: #f5f5f5; background: rgba(0,0,0,.55); backdrop-filter: blur(8px);
    font: inherit; font-size: .72rem; font-weight: 700; cursor: pointer;
    transition: all 200ms cubic-bezier(.22,1,.36,1);
  }
  .back-btn:hover { background: rgba(0,0,0,.75); border-color: rgba(255,255,255,.22); }
  .back-btn:active { transform: scale(.97); }

  /* Centered poster overlapping the backdrop bottom */
  .poster-wrap {
    display: flex; justify-content: center;
    margin-top: clamp(-92px, -22vw, -52px); padding: 0 16px; position: relative; z-index: 3;
  }
  .poster-img {
    width: clamp(120px, 36vw, 156px); aspect-ratio: 2 / 3; object-fit: cover;
    border-radius: 12px; border: 1px solid rgba(255,255,255,.1);
    box-shadow: 0 18px 44px rgba(0,0,0,.55);
  }

  .detail-container {
    position: relative; z-index: 2;
    width: min(1100px, calc(100% - clamp(28px, 6vw, 96px))); margin-inline: auto;
  }

  /* Identity */
  .identity { text-align: center; margin-top: 18px; }
  .detail-eyebrow {
    color: #77777f; font-size: .58rem; font-weight: 700;
    letter-spacing: .14em; text-transform: uppercase; margin-bottom: 6px;
  }
  .detail-title {
    margin: 0; color: #f5f5f5; font-size: clamp(1.6rem, 5.5vw, 2.4rem); font-weight: 800;
    letter-spacing: -.025em; line-height: 1.05; text-wrap: balance;
    text-shadow: 0 2px 16px rgba(0,0,0,.4);
  }
  .meta-row {
    display: flex; flex-wrap: wrap; align-items: center; justify-content: center;
    gap: 7px; margin-top: 12px; color: #b7b7bd; font-size: .74rem; font-weight: 600;
  }
  .meta-row .rating { display: inline-flex; align-items: center; gap: 3px; color: #ffc94d; font-weight: 700; }
  .dot { width: 3px; height: 3px; border-radius: 50%; background: #555; }

  .detail-desc {
    max-width: 580px; margin: 14px auto 0; color: #b7b7bd; font-size: .82rem; line-height: 1.6;
    text-align: center;
    display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 3; line-clamp: 3; overflow: hidden;
  }
  .detail-desc.expanded { -webkit-line-clamp: unset; line-clamp: unset; overflow: visible; }
  .show-more {
    display: inline-block; margin: 8px auto 0; padding: 4px 8px;
    border: 0; background: transparent; color: #f5f5f5; font: inherit;
    font-size: .7rem; font-weight: 700; cursor: pointer; text-decoration: underline;
    text-underline-offset: 3px; text-decoration-color: rgba(255,255,255,.4);
  }
  .show-more:hover { text-decoration-color: #f5f5f5; }

  .genre-tags {
    display: flex; flex-wrap: wrap; gap: 6px; justify-content: center; margin-top: 16px;
  }
  .genre-tag {
    padding: 4px 11px; border: 1px solid rgba(255,255,255,.1); border-radius: 999px;
    color: #c7c7cc; font-size: .66rem; font-weight: 600;
    background: rgba(255,255,255,.03);
  }

  /* Actions */
  .actions { margin-top: 22px; display: flex; flex-direction: column; align-items: center; gap: 10px; }
  .play-btn {
    display: inline-flex; align-items: center; justify-content: center; gap: 8px;
    width: 100%; max-width: 420px; padding: 14px 24px; border-radius: 999px;
    color: #000; font-size: .9rem; font-weight: 800; text-decoration: none;
    background: #fff; box-shadow: 0 6px 24px rgba(255,255,255,.18);
    transition: transform 220ms cubic-bezier(.22,1,.36,1), box-shadow 220ms cubic-bezier(.22,1,.36,1);
  }
  .play-btn:hover { transform: translateY(-1px); box-shadow: 0 8px 28px rgba(255,255,255,.25); }
  .play-btn:active { transform: scale(.98); }
  .secondary-actions {
    display: flex; flex-wrap: wrap; align-items: center; justify-content: center; gap: 8px;
    width: 100%; max-width: 480px;
  }
  .secondary-btn {
    display: inline-flex; align-items: center; gap: 6px; padding: 10px 16px; border-radius: 999px;
    color: #f5f5f5; font-size: .76rem; font-weight: 700; border: 1px solid rgba(255,255,255,.14);
    background: rgba(255,255,255,.06); cursor: pointer;
    transition: background 220ms cubic-bezier(.22,1,.36,1), border-color 220ms cubic-bezier(.22,1,.36,1);
  }
  .secondary-btn:hover { background: rgba(255,255,255,.12); border-color: rgba(255,255,255,.24); }
  .secondary-btn:active { transform: scale(.97); }
  .save-error { margin-top: 4px; color: #ffb020; font-size: .66rem; text-align: center; }

  /* Cast rail */
  .cast-section { margin-top: 36px; }
  .section-h {
    color: #f5f5f5; font-size: 1.05rem; font-weight: 700; letter-spacing: -.02em;
    margin: 0 0 12px; padding-bottom: 8px; border-bottom: 1px solid rgba(255,255,255,.06);
  }
  .cast-rail {
    display: flex; gap: 10px; overflow-x: auto; scroll-snap-type: x proximity;
    padding: 2px 0 8px; scrollbar-width: none; -webkit-overflow-scrolling: touch;
  }
  .cast-rail::-webkit-scrollbar { display: none; }
  .cast-card {
    flex: 0 0 92px; min-width: 0; scroll-snap-align: start;
    display: flex; flex-direction: column; gap: 4px;
  }
  .cast-photo {
    width: 92px; height: 92px; border-radius: 50%; object-fit: cover;
    border: 1px solid rgba(255,255,255,.08); background: #1a1a22;
  }
  .cast-photo-fallback { display: grid; place-items: center; color: rgba(255,255,255,.18); font-size: 1.5rem; font-weight: 800; }
  .cast-name {
    color: #f5f5f5; font-size: .68rem; font-weight: 700; text-align: center;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .cast-character {
    color: #77777f; font-size: .6rem; text-align: center;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }

  /* Recommendations */
  .recs-rail { margin-top: 36px; }

  /* === Trailer modal === */
  .trailer-layer { position: fixed; inset: 0; z-index: 90; display: grid; place-items: center; padding: 16px; }
  .trailer-backdrop { position: absolute; inset: 0; border: 0; background: rgba(0,0,0,.82); backdrop-filter: blur(8px); cursor: default; }
  .trailer-modal {
    position: relative; width: min(960px, 100%); max-height: 90dvh; overflow: hidden;
    border: 1px solid rgba(255,255,255,.12); border-radius: 14px;
    background: #0a0a10; box-shadow: 0 30px 80px rgba(0,0,0,.6);
    animation: trailer-in 240ms cubic-bezier(.22,1,.36,1);
  }
  .trailer-bar {
    display: flex; align-items: center; justify-content: space-between;
    padding: 10px 14px; border-bottom: 1px solid rgba(255,255,255,.08);
    color: #f5f5f5; font-size: .76rem; font-weight: 700;
  }
  .trailer-title { display: inline-flex; align-items: center; gap: 8px; }
  .trailer-close {
    display: grid; place-items: center; width: 32px; height: 32px; border: 1px solid rgba(255,255,255,.12);
    border-radius: 50%; color: #b7b7bd; background: rgba(255,255,255,.04); cursor: pointer;
    transition: color 200ms ease, border-color 200ms ease;
  }
  .trailer-close:hover { color: #fff; border-color: rgba(255,255,255,.24); }
  .trailer-frame { position: relative; aspect-ratio: 16 / 9; background: #000; }
  .trailer-frame iframe { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; }
  @keyframes trailer-in { from { opacity: 0; transform: translateY(12px); } to { opacity: 1; transform: translateY(0); } }

  /* Desktop: richer two-column-ish hero identity */
  @media (min-width: 900px) {
    .hero { height: clamp(420px, 56vw, 620px); }
    .poster-wrap { margin-top: clamp(-130px, -18vw, -80px); }
    .poster-img { width: clamp(160px, 16vw, 200px); }
    .detail-container { width: min(1100px, calc(100% - 96px)); }
    .identity { margin-top: 22px; }
    .detail-title { font-size: clamp(2rem, 3.4vw, 3rem); }
    .detail-desc { font-size: .88rem; max-width: 720px; }
    .play-btn { max-width: 360px; padding: 14px 28px; }
    .cast-card { flex: 0 0 110px; }
    .cast-photo { width: 110px; height: 110px; }
  }
  @media (max-width: 640px) {
    .detail-page { padding-bottom: 96px; }
    .back-btn { top: calc(12px + env(safe-area-inset-top)); left: 12px; padding: 0 12px; min-height: 34px; font-size: .68rem; }
    .hero { height: clamp(260px, 58vw, 360px); }
    .poster-wrap { margin-top: clamp(-78px, -22vw, -50px); padding: 0 16px; }
    .poster-img { width: clamp(118px, 36vw, 142px); border-radius: 10px; }
    .detail-container { width: calc(100% - 32px); }
    .detail-title { font-size: clamp(1.4rem, 6.4vw, 2rem); }
    .meta-row { font-size: .7rem; gap: 6px; }
    .detail-desc { font-size: .8rem; }
    .play-btn { padding: 12px 22px; font-size: .85rem; }
    .secondary-btn { padding: 9px 14px; font-size: .72rem; }
    .cast-section { margin-top: 30px; }
    .recs-rail { margin-top: 28px; }
  }
  @media (prefers-reduced-motion: reduce) {
    .back-btn, .play-btn, .secondary-btn, .trailer-modal { transition: none; animation: none; }
  }
</style>
