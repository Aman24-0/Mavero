<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/state';
  import { goto } from '$app/navigation';
  import { ArrowLeft, ArrowRight, Heart, Play, Share2, Star } from 'lucide-svelte';
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

  function openStatusSheet() {
    statusSheetOpen = true;
  }

  function closeStatusSheet() {
    statusSheetOpen = false;
  }

  async function chooseStatus(key: string) {
    closeStatusSheet();
    try {
      if (key === 'remove') {
        await removeFavoriteFromMyList(type, item.id);
        watchlistStatus = null;
        if (page.data.user) {
          const deleted = await deleteCloudFavorite(type, item.id);
          if (!deleted) {
            saveError = 'Removed from this device; cloud removal will retry automatically.';
            void syncAuthenticatedState();
          } else {
            saveError = '';
          }
        } else {
          saveError = '';
        }
      } else if (key === 'watching' || key === 'planned' || key === 'completed') {
        const snapshot = { title: item.title, poster: item.poster, backdrop: item.backdrop, year: item.year, runtime: item.runtime, rating: item.rating, genres: item.genres, description: item.description };
        const record = await setFavoriteStatus(type, item.id, snapshot, key);
        watchlistStatus = record.status ?? key;
        if (page.data.user) void syncAuthenticatedState();
      }
      if (key !== 'remove') saveError = '';
    } catch {
      saveError = 'This device could not update your local list.';
    }
  }

  function statusLabel(status: WatchlistStatus | null) {
    return status ? status.charAt(0).toUpperCase() + status.slice(1) : 'My list';
  }

  function goBack(event: MouseEvent) {
    event.preventDefault();
    const returnTo = page.url.searchParams.get('from');
    if (returnTo?.startsWith('/') && !returnTo.startsWith('//')) {
      void goto(returnTo, { replaceState: true, keepFocus: true });
      return;
    }
    void goto('/discover', { replaceState: true, keepFocus: true });
  }

  async function shareItem() {
    try {
      if (navigator.share) await navigator.share({ title: item.title, text: `Watch ${item.title} on MAVERO`, url: canonicalUrl });
      else await navigator.clipboard?.writeText(canonicalUrl);
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

<div class="detail-wrap">
  <div class="detail-backdrop" style={`background-image: url('${item.backdrop || item.poster}')`}></div>
  <div class="container-wide">
    <a class="back-link" href="/discover" onclick={goBack}><ArrowLeft size={15} /> Back</a>
    <section class="detail-layout" aria-labelledby="detail-title">
      <div class="detail-poster"><img src={item.poster} alt={`${item.title} poster`} /></div>
      <div class="detail-copy">
        <div class="detail-lead">
          <div class="eyebrow">{formatType(type)}{#if item.genres[0]} / {item.genres[0]}{/if}</div>
          <h1 id="detail-title">{item.title}</h1>
          <div class="meta-row"><strong>{item.year}</strong><span class="dot"></span><span>{item.runtime}</span><span class="dot"></span><span>{item.maturity}</span>{#if item.rating > 0}<span class="dot"></span><span class="rating"><Star size={12} fill="currentColor" strokeWidth={0} /> {item.rating.toFixed(1)}</span>{/if}</div>
        </div>
        <p class="detail-description">{item.description}</p>
        <div class="detail-actions"><a class="btn btn-primary" href={watchHref}><Play size={15} fill="currentColor" /> Watch now</a><button class="btn btn-secondary" onclick={openStatusSheet} aria-haspopup="dialog" aria-expanded={statusSheetOpen}><Heart size={15} fill={watchlistStatus ? 'currentColor' : 'none'} /> {statusLabel(watchlistStatus)}</button><button class="icon-btn action-icon" onclick={shareItem} aria-label={`Share ${item.title}`}><Share2 size={16} /></button></div>
        {#if saveError}<div class="save-error" role="status">{saveError}</div>{/if}
        {#if type !== 'movie'}<div class="episode-strip"><div><div class="eyebrow">Episode guide</div><strong>{item.seasons ?? 1} season{item.seasons === 1 ? '' : 's'} · {item.episodes ?? 12} episodes</strong></div><a class="icon-btn" href={`/${type}/${item.id}#episodes`} aria-label="Open episode list"><ArrowRight size={16} /></a></div>{/if}
      </div>
    </section>
    {#if type === 'series'}<SeasonEpisodes id={item.id} seasonCount={item.seasons ?? 1} />{/if}
    {#if recommendations.length}<ContentRail title="You may also like" eyebrow="Keep exploring" items={recommendations} href="/discover" compact />{/if}
  </div>
  <SelectionSheet open={statusSheetOpen} eyebrow="MAVERO / My List" title="Add to My List" options={statusSheetOptions} selected={watchlistStatus ?? ''} onClose={closeStatusSheet} onSelect={chooseStatus} />
</div>

<style>
  .detail-wrap { position: relative; overflow: hidden; padding-bottom: 64px; }
  .detail-backdrop { position: absolute; inset: 0 0 auto; z-index: -1; height: 680px; background-position: center 18%; background-size: cover; opacity: .55; filter: saturate(1.05); }
  .detail-wrap::before {
    content: ''; position: absolute; inset: 0 0 auto; z-index: -1; height: 760px;
    background:
      linear-gradient(100deg, var(--base) 4%, rgba(6,6,10,.9) 42%, rgba(6,6,10,.35) 75%, rgba(6,6,10,.7) 100%),
      linear-gradient(0deg, var(--base) 2%, transparent 78%);
  }
  .back-link { display: inline-flex; align-items: center; gap: 7px; padding-top: 28px; color: var(--muted); font-size: .74rem; font-weight: 700; text-decoration: none; transition: color var(--motion-fast) var(--ease-out), transform var(--motion-fast) var(--ease-out); }
  .back-link:hover { color: var(--ink); transform: translateX(-2px); }
  .detail-layout { display: grid; grid-template-columns: 260px minmax(0, 1fr); gap: 40px; align-items: start; padding: 40px 0 54px; }
  .detail-poster { overflow: hidden; border: 1px solid var(--line); border-radius: var(--radius-lg); aspect-ratio: 2 / 3; background: var(--surface); box-shadow: var(--shadow-lg); }
  .detail-poster img { width: 100%; height: 100%; object-fit: cover; }
  .detail-copy { min-width: 0; padding-top: 6px; }
  .detail-lead { min-width: 0; }
  .detail-copy h1 { max-width: 820px; margin: 10px 0 14px; color: var(--ink); font-size: clamp(2rem, 4.2vw, 3.6rem); font-weight: 900; letter-spacing: -.025em; line-height: 1.02; text-wrap: balance; }
  .meta-row { display: flex; flex-wrap: wrap; align-items: center; gap: 9px; color: var(--ink-soft); font-size: .82rem; font-weight: 600; }
  .meta-row .dot { width: 3px; height: 3px; border-radius: 50%; background: var(--muted-deep); }
  .detail-description { max-width: 700px; margin: 22px 0 0; color: var(--ink-soft); font-size: .92rem; line-height: 1.75; }
  .rating { display: inline-flex; align-items: center; gap: 4px; color: #ffc94d; }
  .detail-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; margin-top: 26px; }
  .action-icon { border-color: var(--line-strong); }
  .episode-strip { display: flex; align-items: center; justify-content: space-between; width: min(460px, 100%); margin-top: 18px; padding: 13px 15px; border: 1px solid var(--line); border-radius: var(--radius-md); background: rgba(245,246,250,.045); }
  .episode-strip strong { display: block; margin-top: 4px; color: var(--ink); font-size: .76rem; font-weight: 700; }
  .save-error { margin-top: 10px; color: var(--warning); font-size: .68rem; font-weight: 600; }
  @media (max-width: 900px) { .detail-layout { grid-template-columns: 195px minmax(0, 1fr); gap: 26px; } }
  @media (max-width: 640px) {
    .detail-backdrop { height: 460px; }
    .detail-wrap::before { height: 540px; }
    .back-link { padding-top: 78px; }
    .detail-layout { display: grid; grid-template-columns: 108px minmax(0, 1fr); gap: 16px; padding: 24px 0 30px; align-items: start; }
    .detail-poster { border-radius: var(--radius-md); }
    .detail-copy { display: contents; }
    .detail-copy > .detail-lead { grid-column: 2; min-width: 0; }
    .detail-copy > .detail-description, .detail-copy > .detail-actions, .detail-copy > .episode-strip, .detail-copy > .save-error { grid-column: 1 / -1; }
    .detail-copy h1 { margin-top: 6px; font-size: clamp(1.7rem, 8vw, 2.3rem); line-height: 1.05; }
    .detail-description { margin-top: 18px; font-size: .84rem; }
  }
</style>
