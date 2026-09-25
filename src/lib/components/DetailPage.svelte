<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { page } from '$app/state';
  import { goto } from '$app/navigation';
  import { ArrowLeft, Heart, Play, Share2, Star, ListPlus, Film, X, Download, AlertCircle, LoaderCircle } from 'lucide-svelte';
  import SelectionSheet from '$components/SelectionSheet.svelte';
  import DownloadSheet from '$components/DownloadSheet.svelte';
  import type { ContentType } from '$data/content';
  import { getMedia, media, formatBadges, type MediaItem } from '$data/content';
  import ContentRail from '$components/ContentRail.svelte';
  import SeasonEpisodes from '$components/SeasonEpisodes.svelte';
  import { getFavoriteStatus, getLocalProgressRecords, removeFavoriteFromMyList, setFavoriteStatus } from '$lib/client/progress/service';
  import type { WatchlistStatus } from '$lib/client/progress/types';
  import { latestResumeEpisode } from '$lib/client/progress/presenter';
  import { deleteCloudFavorite, syncAuthenticatedState } from '$lib/client/progress/cloud';
  import { appendReturnTo } from '$lib/shared/navigation';
  import { haptic } from '$lib/client/haptics';
  import { showSuccessToast, showErrorToast } from '$lib/client/toast.svelte';
  import type { PublicDownloadProvider, DownloadMediaType } from '$lib/shared/downloader';
  import { filterProvidersByMediaType } from '$lib/shared/downloader';

  let {
    id = 'afterlight',
    type = 'movie' as ContentType,
    dataItem = undefined,
    recommendationItems = []
  }: {
    id?: string;
    type?: ContentType;
    dataItem?: MediaItem;
    recommendationItems?: MediaItem[];
  } = $props();
  let watchlistStatus = $state<WatchlistStatus | null>(null);
  let statusSheetOpen = $state(false);
  let saveError = $state('');
  let resumeEpisode = $state<{ season: number; episode: number } | undefined>(undefined);
  let hasActiveProgress = $state(false);
  let overviewExpanded = $state(false);
  let trailerOpen = $state(false);
  // Phase 4-E: trailer modal focus management.
  let trailerModal = $state<HTMLDivElement>();
  let trailerTrigger: HTMLElement | null = null;

  // ----- Download sheet state -----
  // The downloader registry is loaded lazily from the public
  // /api/downloader/config endpoint the FIRST time the user opens the
  // Download sheet. We keep the resolved providers in component state so
  // subsequent opens are instant (and benefit from the HTTP cache-control
  // header).
  let downloadSheetOpen = $state(false);
  let downloadProviders = $state<PublicDownloadProvider[]>([]);
  let downloadProvidersLoaded = $state(false);
  let downloadProvidersLoading = $state(false);
  let downloadProvidersFailed = $state(false);
  // Phase 2 downloader refinement: the episode-card download target.
  // When the user clicks an episode's Download button, SeasonEpisodes
  // fires onDownload(season, episode) which sets these two values + opens
  // the existing DownloadSheet. They are SEPARATE from `resumeEpisode`
  // (which drives the main Play link's "Resume S1E1" behavior) so the
  // download URL always targets the EXACT episode the user clicked —
  // never a resume fallback or S1E1 default.
  // For movies, these stay undefined (the sheet uses the movie URL).
  let downloadTargetSeason = $state<number | undefined>(undefined);
  let downloadTargetEpisode = $state<number | undefined>(undefined);
  const statusOptions = [
    { key: 'watching', label: 'Watching', icon: '▶', description: 'Keep this in your current rotation.' },
    { key: 'planned', label: 'Planned', icon: '＋', description: 'Save it for a future night.' },
    { key: 'completed', label: 'Completed', icon: '✓', description: 'Mark this story as finished.' },
    { key: 'remove', label: 'Remove from My List', icon: '×', description: 'Take it out of your saved library.' },
  ];
  const item = $derived(dataItem ?? getMedia(id));
  // Phase 7F+ (anime routing): dual-badge layout for anime-flagged
  // titles. Anime movie → "Anime · Movie", anime series → "Anime · Series".
  // Plain movie/series keep their single label (legacy).
  const detailBadges = $derived(formatBadges(item));
  const recommendations = $derived(recommendationItems.length ? recommendationItems : media.filter((candidate) => candidate.id !== item.id && candidate.type === type).slice(0, 6));
  const statusSheetOptions = $derived(watchlistStatus ? statusOptions : statusOptions.filter((option) => option.key !== 'remove'));
  const canonicalUrl = $derived(`${page.url.origin}/${type}/${item.id}`);
  const watchPath = $derived(type === 'movie' ? `/watch/${type}/${item.id}` : `/watch/${type}/${item.id}?season=${resumeEpisode?.season ?? 1}&episode=${resumeEpisode?.episode ?? 1}`);
  const watchHref = $derived(appendReturnTo(watchPath, `${page.url.pathname}${page.url.search}${page.url.hash}`));
  const structuredData = $derived(JSON.stringify({ '@context': 'https://schema.org', '@type': type === 'movie' ? 'Movie' : 'TVSeries', name: item.title, description: item.description, image: item.backdrop || item.poster, dateCreated: String(item.year), aggregateRating: { '@type': 'AggregateRating', ratingValue: item.rating, bestRating: 10, ratingCount: 1 } }));
  const trailerKey = $derived(item.trailerKey ?? '');
  const hasTrailer = $derived(Boolean(trailerKey));
  const castMembers = $derived(item.cast ?? []);
  const hasLongOverview = $derived(item.description.length > 240);

  onMount(() => {
    let active = true;
    const loadProgressState = async () => {
      const status = await getFavoriteStatus(type, item.id);
      const progress = await getLocalProgressRecords();
      if (!active) return;
      const activeProgress = progress.some((record) => record.contentType === type && record.contentId === item.id && record.completionState !== 'completed' && record.currentTime > 0);
      hasActiveProgress = activeProgress;
      const effectiveStatus = status ?? (hasActiveProgress ? 'watching' : null);
      watchlistStatus = effectiveStatus;
      if (type !== 'movie' && hasActiveProgress) {
        resumeEpisode = latestResumeEpisode(type, item.id, progress);
      }
    };
    void loadProgressState();
    // P0: Cloud convergence — for authenticated users, cloud sync may
    // produce newer local progress than what was available on mount.
    // Listen for the 'mavero:sync-status' event (dispatched by
    // setSyncStatus() in cloud.ts when sync completes) and recompute
    // the resume state. This makes DetailPage converge with cloud
    // progress without requiring a hard refresh.
    const handleSyncComplete = () => {
      if (active) void loadProgressState();
    };
    if (typeof window !== 'undefined') {
      window.addEventListener('mavero:sync-status', handleSyncComplete);
    }
    // Prefetch the downloader registry on mount so the Download button is
    // reachable as soon as config loads (instead of being hidden behind a
    // click handler that never fires because the button is hidden). This
    // is purely additive client-side prefetching — no server-side load is
    // added to the movie/series/anime routes. The fetch hits the cached
    // /api/downloader/config endpoint (HTTP cache-control + in-process
    // server cache), so subsequent DetailPage visits reuse the response.
    void loadDownloadProviders();
    const autoplay = page.url.searchParams.get('autoplay') === '1';
    if (autoplay && typeof window !== 'undefined') {
      const params = new URLSearchParams(page.url.searchParams);
      params.delete('autoplay');
      const query = params.toString();
      const cleanDetail = `/${type}/${item.id}${query ? `?${query}` : ''}`;
      window.history.replaceState(window.history.state, '', cleanDetail);
      void goto(`/watch/${type}/${item.id}${query ? `?${query}` : ''}`);
    }
    return () => {
      active = false;
      if (typeof window !== 'undefined') {
        window.removeEventListener('mavero:sync-status', handleSyncComplete);
      }
    };
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
          if (!deleted) {
            saveError = 'Removed from this device; cloud removal will retry automatically.';
            void syncAuthenticatedState();
            showErrorToast('Removed locally. Cloud sync will retry.');
          } else {
            saveError = '';
            showSuccessToast('Removed from My List');
          }
        } else {
          saveError = '';
          showSuccessToast('Removed from My List');
        }
        haptic('destructive');
      } else if (key === 'watching' || key === 'planned' || key === 'completed') {
        const snapshot = { title: item.title, poster: item.poster, backdrop: item.backdrop, year: item.year, runtime: item.runtime, rating: item.rating, genres: item.genres, description: item.description };
        const record = await setFavoriteStatus(type, item.id, snapshot, key);
        const wasNew = watchlistStatus === null;
        watchlistStatus = record.status ?? key;
        if (page.data.user) void syncAuthenticatedState();
        haptic('success');
        // Toast feedback:
        //   - If the title was NOT in My List before, this is an Add.
        //   - Otherwise it's a status change ("Moved to Watching").
        if (wasNew) {
          showSuccessToast('Added to My List');
        } else {
          const label = key.charAt(0).toUpperCase() + key.slice(1);
          showSuccessToast(`Moved to ${label}`);
        }
      }
      if (key !== 'remove') saveError = '';
    } catch {
      saveError = 'This device could not update your local list.';
      showErrorToast('Could not update My List. Please try again.');
    }
  }

  function statusLabel(status: WatchlistStatus | null) {
    return status ? status.charAt(0).toUpperCase() + status.slice(1) : 'My List';
  }

  function goBack(event: MouseEvent) {
    event.preventDefault();
    haptic('light');
    const returnTo = page.url.searchParams.get('from');
    // When the user arrived at this detail page from an internal
    // listing (Search / Discover / My List / Upcoming / collection),
    // MediaCard's `appendReturnTo` injected the originating URL into
    // the `from` query parameter. We use `history.back()` so the
    // browser/SvelteKit performs a real popstate navigation back to
    // the original history entry — this is what allows SvelteKit's
    // snapshot/scroll restoration to fire and bring the user back to
    // the exact state (query, filter, results, scroll position) they
    // left.
    //
    // Using `goto(returnTo, { replaceState: true })` here would NOT
    // trigger popstate — it would replace the current history entry
    // with the listing URL and skip SvelteKit's snapshot/scroll
    // restoration entirely, leaving the user at the top of an empty
    // listing.
    //
    // CRITICAL RELIABILITY FIX (history.back() silent no-op):
    //   `window.history.back()` is fire-and-forget: it returns void,
    //   has no callback, and SILENTLY does nothing when there is no
    //   previous history entry (history index 0). This happens when
    //   the user deep-links / shares / refreshes the DetailPage URL —
    //   the DetailPage becomes the first history entry, and back()
    //   no-ops. BOTH the DetailPage Back button AND the Android/browser
    //   hardware Back button fail simultaneously because they rely on
    //   the same empty history stack.
    //
    //   The existing fallback (goto '/discover') only fires when `from`
    //   is missing/invalid. When `from` IS present (shared link with a
    //   from param), the old code called back() and returned — but
    //   back() was a no-op, leaving the user stuck.
    //
    //   Fix: after calling back(), listen for popstate. If popstate
    //   doesn't fire within one macrotask (setTimeout 0 — browsers
    //   fire popstate as a macrotask, so if it hasn't fired by the
    //   next macrotask it won't fire), fall back to goto(returnTo).
    //   This preserves the snapshot-restore path for normal navigation
    //   and only falls back when back() provably did nothing.
    //
    //   Fast path: if history.length === 1, there is provably no
    //   previous entry — skip back() entirely and go straight to the
    //   goto fallback (no timeout needed).
    //
    // The final fallback (`goto('/discover', ...)`) is preserved for
    // the direct-detail-page case where there is no valid internal
    // `from` to go back to.
    if (returnTo?.startsWith('/') && !returnTo.startsWith('//')) {
      if (typeof window !== 'undefined' && typeof window.history.back === 'function') {
        // Fast path: history.length === 1 means we're at the first entry
        // — back() would no-op. Skip it and go straight to goto.
        // replaceState: true replaces the deep-link DetailPage entry with
        // the listing URL so the user can't go "back" to a page they
        // never navigated to.
        if (window.history.length <= 1) {
          void goto(returnTo, { replaceState: true, keepFocus: true });
          return;
        }
        // Normal path: call back() + detect whether popstate fires.
        // If it doesn't (back() no-op due to history cursor at index 0
        // despite length > 1 — rare but possible), fall back to goto.
        let navigated = false;
        const onPopState = () => { navigated = true; cleanup(); };
        const timer = setTimeout(() => {
          cleanup();
          if (!navigated) {
            // back() was a no-op — no previous history entry. Fall
            // back to a fresh goto. replaceState: true replaces the
            // DetailPage entry so the user can't go "back" to a page
            // they never navigated to. This loses snapshot restore, but
            // there's no snapshot to restore (deep-link case).
            void goto(returnTo, { replaceState: true, keepFocus: true });
          }
        }, 0);
        function cleanup() {
          window.removeEventListener('popstate', onPopState);
          clearTimeout(timer);
        }
        window.addEventListener('popstate', onPopState, { once: true });
        window.history.back();
        return;
      }
      // Defensive fallback (very old browsers, JSdom) — preserve the
      // pre-fix behavior so the button still works.
      void goto(returnTo, { replaceState: true, keepFocus: true });
      return;
    }
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
    // Phase 4-E: store the trigger element so we can restore focus on close.
    trailerTrigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    trailerOpen = true;
    haptic('light');
    // Auto-focus the close button after the modal renders.
    void tick().then(() => trailerModal?.querySelector<HTMLElement>('.trailer-close')?.focus());
  }
  function closeTrailer() {
    trailerOpen = false;
    // Phase 4-E: restore focus to the triggering element.
    trailerTrigger?.focus();
    trailerTrigger = null;
  }
  function handleTrailerKeydown(event: KeyboardEvent) {
    if (!trailerOpen) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      closeTrailer();
      return;
    }
    // Phase 4-E: Tab trap — focus stays inside the trailer modal.
    if (event.key !== 'Tab' || !trailerModal) return;
    const focusable = [...trailerModal.querySelectorAll<HTMLElement>('button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])')];
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  // ----- Download integration -----
  //
  // Phase 2 refinement:
  //   - MOVIES: keep the existing main DetailPage Download button beside
  //     Play. The sheet opens with mediaType='movie' and no season/episode.
  //   - TV SERIES + ANIME SERIES: REMOVE the main Download button. The
  //     Download action moves into each episode card (see SeasonEpisodes's
  //     onDownload callback). The sheet opens with the EXACT clicked
  //     episode's season + episode — never a resume fallback or S1E1
  //     default.
  //   - ANIME MOVIES: keep the main DetailPage Download button (uses the
  //     movie URL, same as a regular movie).
  //
  // Adult content is gated by the existing SSR load (the load throws 404
  // for unauthorized adult items), so the DetailPage only ever renders
  // for items the user is authorized to see — no extra adult guard is
  // needed here. Adult authorization, classifier, and routing are NOT
  // modified.
  //
  // Media type mapping (per spec):
  //   - movie                  -> 'movie'
  //   - series                 -> 'tv'
  //   - anime movie            -> 'movie'
  //   - anime series           -> 'tv'
  // The mapping is computed from the existing `item.isAnime` + `item.animeFormat`
  // fields preserved by the existing anime routing.
  const downloadMediaType = $derived((type === 'movie' || (item.isAnime && item.animeFormat === 'movie')) ? 'movie' : 'tv' as DownloadMediaType);

  // The top-level Download button beside Play is now MOVIES-ONLY.
  // TV/anime series get a Download button on each episode card instead.
  // This avoids the previous bug where the top-level TV Download button
  // could only resolve one episode (the resume/S1E1 fallback).
  const isMovieLike = $derived(downloadMediaType === 'movie');

  // Filtered providers for the current media type. The DownloadSheet uses
  // this list when it has providers; when the prefetch is loading/failed/empty,
  // the sheet itself renders the appropriate state (loading spinner, error
  // retry, or empty "no downloaders" message).
  const visibleDownloadProviders = $derived(filterProvidersByMediaType(downloadProviders, downloadMediaType));
  // Phase E final corrective (§6): the top-level Download button is shown
  // for ALL movie-like items UNCONDITIONALLY — it must NOT be gated on
  // `downloadProvidersLoaded` or `visibleDownloadProviders.length > 0`. The
  // previous gating caused a real production regression where the button
  // silently disappeared when the prefetch failed OR returned zero matching
  // providers, leaving the user with no way to open the sheet at all.
  //
  // Architecture now: USER CLICKS DOWNLOAD → SHEET OPENS IMMEDIATELY →
  // sheet renders Loading / Success / Empty / Error state internally. The
  // prefetch remains an optimization (so the sheet can show providers
  // instantly when the prefetch already resolved) but it is no longer a
  // functional prerequisite for opening the sheet.
  const showDownloadButton = $derived(isMovieLike);
  // The inline "Download unavailable · Retry" affordance is kept for the
  // narrow case where the prefetch FAILED before the user clicked. When
  // the user clicks Retry, the prefetch re-runs; on success the normal
  // Download button replaces the retry affordance. The user can ALSO just
  // click the normal Download button to open the sheet (which will retry
  // internally and show its own loading state).
  const showDownloadFailure = $derived(false);

  // TMDB id resolution. The DetailPage's `item.id` is the content id used
  // across the app — for TMDB-backed content this IS the TMDB id. For
  // fixtures (the static `media` array used in dev) the id is a slug like
  // 'afterlight'; the download URLs would not resolve for those, but
  // production DetailPage is always reached via the SSR load which sets
  // dataItem from a real TMDB detail (so item.externalIds?.tmdb is set).
  // We prefer the explicit externalIds.tmdb, fall back to item.id, and
  // finally to '' (the sheet will show its "can't open this title" state).
  const downloadTmdbId = $derived(item.externalIds?.tmdb || item.id || '');

  // Release year for the Cineverse alternate-URL candidate. item.year is
  // already resolved by the existing content presenter (TMDB release_year
  // for movies, first-air-year for series). Passed through to the sheet
  // — other providers ignore it.
  const downloadReleaseYear = $derived(item.year || undefined);

  async function loadDownloadProviders() {
    if (downloadProvidersLoaded || downloadProvidersLoading) return;
    downloadProvidersLoading = true;
    downloadProvidersFailed = false;
    try {
      const res = await fetch('/api/downloader/config', { headers: { accept: 'application/json' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const payload = await res.json() as { ok: boolean; config?: { providers: PublicDownloadProvider[] } };
      if (!payload.ok || !payload.config) throw new Error('Downloader config unavailable');
      downloadProviders = payload.config.providers ?? [];
      downloadProvidersLoaded = true;
    } catch (error) {
      console.error('[DetailPage] Failed to load downloader config', error);
      downloadProvidersFailed = true;
      // Phase 2-K (audit UIX-2): the failure is now surfaced via the
      // showDownloadFailure derived state (an inline "Download temporarily
      // unavailable / Retry" affordance in the actions row). No toast —
      // the user hasn't opened the sheet yet, and the inline affordance
      // is more discoverable than a transient toast.
    } finally {
      downloadProvidersLoading = false;
    }
  }

  // Phase 2-K: retry entry point — re-attempts the prefetch when the user
  // clicks the inline Retry affordance. Resets the failed flag and re-runs
  // loadDownloadProviders (which has its own loading/failure management).
  function retryDownloadProviders() {
    if (downloadProvidersLoading || downloadProvidersLoaded) return;
    void loadDownloadProviders();
  }

  // Open the sheet for a MOVIE download. No season/episode — the sheet
  // uses the movie URL template. The target state stays undefined.
  function openDownloadSheet() {
    haptic('light');
    // The downloader config is prefetched on mount, so by the time the
    // user can see + click the Download button the providers are already
    // loaded. If the prefetch failed (e.g. transient network error), we
    // retry here so a click still opens the sheet with a fresh attempt —
    // the sheet itself shows the empty state if the retry also fails.
    if (!downloadProvidersLoaded && !downloadProvidersLoading) {
      void loadDownloadProviders();
    }
    downloadTargetSeason = undefined;
    downloadTargetEpisode = undefined;
    downloadSheetOpen = true;
  }

  // Open the sheet for an EPISODE download. Called from SeasonEpisodes's
  // onDownload callback with the EXACT clicked episode's season + number.
  // We do NOT consult resumeEpisode or fall back to S1E1 — the user
  // clicked a specific episode, so that's what the download URL targets.
  function openEpisodeDownloadSheet(season: number, episode: number) {
    haptic('light');
    if (!downloadProvidersLoaded && !downloadProvidersLoading) {
      void loadDownloadProviders();
    }
    downloadTargetSeason = season;
    downloadTargetEpisode = episode;
    downloadSheetOpen = true;
  }

  function closeDownloadSheet() {
    downloadSheetOpen = false;
    // Leave downloadTargetSeason/Episode alone so re-opening the sheet
    // (e.g. by clicking another episode) sees the last values until the
    // new onDownload call overwrites them. The openDownloadSheet and
    // openEpisodeDownloadSheet functions always set both values before
    // flipping downloadSheetOpen=true, so there's no stale-state risk.
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
  <!-- ============================================================
       CINEMATIC HERO — three intentional layout modes:
         • mobile  (≤640px): full-bleed backdrop → centered poster
           overlapping the hero/content boundary → left-aligned title,
           full-width Play, grouped secondary actions.
         • tablet  (641–1024px): backdrop still on top, but poster +
           identity sit side-by-side in a horizontal composition.
         • desktop (≥1025px): one cinematic hero. Backdrop fills the
           hero, dark gradient scrims guarantee readability, and the
           poster + identity + actions form a single horizontal block
           left-aligned over the lower-left of the backdrop.
       The same DOM is rendered at every breakpoint — only CSS Grid
       + clamp() decide the composition.
       ============================================================ -->
  <header class="hero">
    {#if item.backdrop}
      <img src={item.backdropSmall || item.backdrop} alt="" class="hero-img" loading="eager" fetchpriority="high" />
    {/if}
    <div class="hero-scrim" aria-hidden="true"></div>
    <button class="back-btn" type="button" onclick={goBack} aria-label="Go back">
      <ArrowLeft size={16} /> <span>Back</span>
    </button>

    <div class="hero-inner">
      <div class="hero-composition">
        <!-- Poster — never centered on desktop. On mobile it sits
             below the backdrop image and overlaps the boundary. -->
        {#if item.poster}
          <div class="poster-wrap">
            <img src={item.posterSmall || item.poster} alt={`${item.title} poster`} class="poster-img" />
          </div>
        {/if}

        <!-- Identity + actions: title / metadata / overview / genres /
             primary CTA / secondary actions all live in one block so
             they visually belong together. -->
        <section class="identity">
          <div class="detail-eyebrow">{detailBadges.primary}{#if detailBadges.secondary} · {detailBadges.secondary}{/if}</div>
          <h1 class="detail-title">{item.title}</h1>

          <div class="meta-row">
            {#if item.rating > 0}
              <span class="rating"><Star size={12} fill="currentColor" strokeWidth={0} /> {item.rating.toFixed(1)}</span>
            {/if}
            {#if item.year > 0}<span class="dot"></span><span>{item.year}</span>{/if}
            {#if item.maturity}<span class="dot"></span><span>{item.maturity}</span>{/if}
            {#if type === 'series' && item.seasons}
              <span class="dot"></span><span>{item.seasons} season{item.seasons === 1 ? '' : 's'}</span>
            {:else if item.isAnime && item.episodes}
              <span class="dot"></span><span>{item.episodes} episode{item.episodes === 1 ? '' : 's'}</span>
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

          <!-- Actions -->
          <div class="actions">
            <div class="primary-actions">
              <a class="play-btn" href={watchHref}>
                <Play size={16} fill="currentColor" strokeWidth={0} />
                {#if type === 'series' && resumeEpisode}Resume S{resumeEpisode.season}E{resumeEpisode.episode}{:else if type === 'movie' && hasActiveProgress}Resume{:else}Play{/if}
              </a>
              {#if showDownloadButton}
                <button class="download-btn" type="button" onclick={openDownloadSheet} aria-haspopup="dialog" aria-expanded={downloadSheetOpen}>
                  <Download size={16} />
                  <span>Download</span>
                </button>
              {:else if showDownloadFailure}
                <button class="download-btn download-unavailable" type="button" onclick={retryDownloadProviders} disabled={downloadProvidersLoading} aria-label="Download temporarily unavailable — retry loading providers">
                  {#if downloadProvidersLoading}<LoaderCircle size={16} />{:else}<AlertCircle size={16} />{/if}
                  <span>{downloadProvidersLoading ? 'Retrying…' : 'Download unavailable · Retry'}</span>
                </button>
              {/if}
            </div>
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
          </div>
        </section>
      </div>
    </div>
  </header>

  <!-- ============================================================
       BELOW THE FOLD — Cast / Episodes / Recommendations.
       All sections share the same content max-width so the page
       reads as one composed column rather than a stack of
       disconnected cards.
       ============================================================ -->
  <div class="detail-body">
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

    <!-- Series: seasons + episodes (includes anime series via isAnime + animeFormat) -->
    {#if type === 'series' || (item.isAnime && item.animeFormat !== 'movie')}
      <SeasonEpisodes
        id={item.id}
        seasonCount={item.seasons ?? 1}
        watchType={type === 'anime' ? 'anime' : 'series'}
        onDownload={openEpisodeDownloadSheet}
      />
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
    <div class="trailer-modal" bind:this={trailerModal} role="dialog" aria-modal="true" aria-label={`${item.title} trailer`} tabindex="-1">
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

<!-- Download sheet (modal bottom-sheet). The sheet is rendered always-on
     (with open=false) so the iframe lifecycle is owned by the sheet itself;
     the parent only flips `open` and supplies the media context. For
     movies, season/episode are undefined (the sheet uses the movie URL).
     For TV/anime series, the values come from downloadTargetSeason/
     downloadTargetEpisode which are set by openEpisodeDownloadSheet when
     the user clicks an episode card's Download button.

     Phase E final corrective (§6): the parent passes provider loading/
     failed/retry state to the sheet so the sheet can render Loading / Error
     states internally — decoupled from the parent's prefetch timing. The
     button is always visible for movie-like items; clicking it opens the
     sheet immediately, which then handles the loading/error/empty UX. -->
<DownloadSheet
  open={downloadSheetOpen}
  title={item.title}
  providers={visibleDownloadProviders}
  providersLoading={downloadProvidersLoading}
  providersFailed={downloadProvidersFailed}
  onRetryProviders={retryDownloadProviders}
  selectedProviderId={null}
  mediaType={downloadMediaType}
  tmdbId={downloadTmdbId}
  contentId={item.id}
  contentType={type}
  season={downloadMediaType === 'tv' ? downloadTargetSeason : undefined}
  episode={downloadMediaType === 'tv' ? downloadTargetEpisode : undefined}
  releaseYear={downloadReleaseYear}
  onClose={closeDownloadSheet}
/>

<style>
  /* ============================================================
     DETAIL PAGE — Matrix/Cyberpunk cinematic redesign (Phase B P2)
     -----------------------------------------------------------------
     Layout modes:
       • mobile  (≤640px): backdrop hero → centered poster overlap
         → left-aligned identity → full-width Play → grouped secondary
       • tablet  (641–1024px): poster + identity side-by-side
       • desktop (≥1025px): cinematic hero with horizontal composition
         (poster left, identity/actions right) over the lower-left of
         a full-bleed backdrop.
       • large   (≥1900px): same composition, wider max-width, larger
         poster + bounded typography so 4K doesn't look like an
         enlarged 1080p layout.
     The hero never has a hard rectangular backdrop edge: a dark
     bottom gradient blends into the page background so the
     transition below the fold is invisible.
     ============================================================ */

  .detail-page {
    position: relative;
    background: var(--color-bg);
    overflow-x: hidden;
    padding-bottom: clamp(72px, 8vw, 110px);
  }

  /* ---- Hero backdrop ---- */
  .hero {
    position: relative;
    width: 100%;
    /* Hero height adapts to viewport — short landscape phones stay
       tall enough to show poster + title, but never eats the whole
       viewport on desktop. */
    min-height: clamp(440px, 78vh, 760px);
    overflow: hidden;
    background: var(--color-surface);
    isolation: isolate;
  }
  .hero-img {
    position: absolute; inset: 0;
    width: 100%; height: 100%;
    object-fit: cover;
    object-position: center 18%;
  }
  /* Scrim — cinematic dark gradients. Multiple stops blend the
     backdrop into the page background so there's no hard edge. */
  .hero-scrim {
    position: absolute; inset: 0; z-index: 1; pointer-events: none;
    background:
      linear-gradient(180deg, rgba(5,7,8,.55) 0%, rgba(5,7,8,.18) 22%, rgba(5,7,8,.32) 60%, rgba(5,7,8,.92) 88%, var(--color-bg) 100%),
      linear-gradient(90deg, rgba(5,7,8,.72) 0%, rgba(5,7,8,.32) 32%, transparent 60%);
  }

  /* Back button — floats over the hero top-left, with safe-area. */
  .back-btn {
    position: absolute; top: calc(14px + env(safe-area-inset-top));
    left: clamp(14px, 3vw, 32px); z-index: 6;
    display: inline-flex; align-items: center; gap: 6px;
    min-height: 36px; padding: 0 14px;
    border: 1px solid var(--color-border-strong); border-radius: 999px;
    color: var(--color-text); background: rgba(5,7,8,.62); backdrop-filter: blur(10px);
    font: inherit; font-size: .72rem; font-weight: 700;
    cursor: pointer;
    transition: background var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out), transform var(--motion-fast) var(--ease-out);
  }
  .back-btn:hover { background: rgba(5,7,8,.78); border-color: var(--color-primary-border); }
  .back-btn:active { transform: scale(.97); }
  .back-btn:focus-visible { outline: 2px solid var(--color-focus); outline-offset: 2px; }

  /* ---- Hero inner (the responsive composition container) ----
     On mobile this is a vertical flex (poster overlaps the boundary).
     On tablet/desktop it becomes a horizontal grid: poster + identity. */
  .hero-inner {
    position: relative; z-index: 3;
    width: min(1500px, calc(100% - clamp(28px, 5vw, 96px)));
    margin-inline: auto;
    padding-top: clamp(60px, 10vh, 120px);
    padding-bottom: clamp(28px, 4vh, 56px);
  }
  .hero-composition {
    display: grid;
    grid-template-columns: 1fr;
    gap: clamp(20px, 3vw, 36px);
    align-items: end;
  }

  /* Poster — on mobile, centered + overlapping the hero/content
     boundary. On tablet/desktop, left-aligned, sitting on top of the
     lower-left of the backdrop. */
  .poster-wrap {
    display: flex; justify-content: center;
    /* Pull the poster down so it overlaps the hero bottom edge. */
    margin-top: clamp(-92px, -16vw, -52px);
    position: relative; z-index: 4;
  }
  .poster-img {
    width: clamp(120px, 36vw, 156px);
    aspect-ratio: 2 / 3; object-fit: cover;
    border-radius: var(--radius-md);
    border: 1px solid var(--color-border-strong);
    box-shadow: 0 22px 50px rgba(0,0,0,.6);
  }

  /* Identity block */
  .identity {
    text-align: center;
    /* On desktop this becomes left-aligned (see media queries). */
  }
  .detail-eyebrow {
    color: var(--color-primary);
    font-size: .62rem; font-weight: 800;
    letter-spacing: .16em; text-transform: uppercase;
    margin-bottom: 8px;
    text-shadow: 0 0 12px rgba(0,255,156,.35);
  }
  .detail-title {
    margin: 0;
    color: var(--color-text);
    font-size: clamp(1.7rem, 6vw, 2.6rem);
    font-weight: 900;
    letter-spacing: -.025em;
    line-height: 1.04;
    text-wrap: balance;
    text-shadow: 0 2px 18px rgba(0,0,0,.55);
  }
  .meta-row {
    display: flex; flex-wrap: wrap; align-items: center; justify-content: center;
    gap: 7px; margin-top: 12px;
    color: var(--color-text-muted);
    font-size: .76rem; font-weight: 600;
  }
  .meta-row .rating {
    display: inline-flex; align-items: center; gap: 3px;
    color: #ffc94d; font-weight: 800;
  }
  .dot { width: 3px; height: 3px; border-radius: 50%; background: var(--color-text-deep); }

  .detail-desc {
    /* On desktop this becomes left-aligned (see media queries). */
    max-width: 620px; margin: 14px auto 0;
    color: var(--color-text-muted); font-size: .84rem; line-height: 1.6;
    display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 3; line-clamp: 3; overflow: hidden;
  }
  .detail-desc.expanded { -webkit-line-clamp: unset; line-clamp: unset; overflow: visible; }
  .show-more {
    display: inline-block; margin: 8px auto 0;
    padding: 4px 8px; border: 0; background: transparent;
    color: var(--color-primary); font: inherit;
    font-size: .7rem; font-weight: 700; cursor: pointer;
    text-decoration: underline; text-underline-offset: 3px;
    text-decoration-color: var(--color-primary-border);
    transition: text-decoration-color var(--motion-fast) var(--ease-out);
  }
  .show-more:hover { text-decoration-color: var(--color-primary); }
  .show-more:focus-visible { outline: 2px solid var(--color-focus); outline-offset: 2px; border-radius: 4px; }

  .genre-tags {
    display: flex; flex-wrap: wrap; gap: 6px;
    justify-content: center;
    margin-top: 16px;
  }
  .genre-tag {
    padding: 4px 11px;
    border: 1px solid var(--color-border-strong);
    border-radius: 999px;
    color: var(--color-text-muted);
    font-size: .66rem; font-weight: 700;
    background: rgba(0,255,156,.04);
    backdrop-filter: blur(6px);
  }

  /* ---- Actions ----
     Mobile: Play is near-full-width, secondary actions wrap below in a
     compact grouped row. Desktop: inline cluster, left-aligned. */
  .actions {
    margin-top: 22px;
    display: flex; flex-direction: column; align-items: center; gap: 10px;
  }
  .primary-actions {
    display: flex; align-items: stretch; gap: 8px;
    width: 100%; max-width: 460px;
  }
  .play-btn {
    display: inline-flex; align-items: center; justify-content: center; gap: 8px;
    flex: 1 1 60%; min-height: 48px;
    padding: 14px 24px; border-radius: 999px;
    color: #050708; font-size: .9rem; font-weight: 800;
    text-decoration: none;
    background: var(--color-primary);
    box-shadow: 0 6px 22px rgba(0,255,156,.28), var(--glow-primary);
    transition: transform var(--motion-fast) var(--ease-out), box-shadow var(--motion-fast) var(--ease-out), filter var(--motion-fast) var(--ease-out);
  }
  .play-btn:hover { transform: translateY(-1px); filter: brightness(1.06); box-shadow: 0 8px 28px rgba(0,255,156,.4), var(--glow-primary); }
  .play-btn:active { transform: scale(.98); }
  .play-btn:focus-visible { outline: 2px solid var(--color-focus); outline-offset: 3px; }
  .download-btn {
    display: inline-flex; align-items: center; justify-content: center; gap: 8px;
    flex: 1 1 40%; min-height: 48px;
    padding: 14px 18px; border-radius: 999px;
    border: 1px solid var(--color-border-strong);
    color: var(--color-text); font-size: .9rem; font-weight: 800; cursor: pointer;
    background: rgba(255,255,255,.04); backdrop-filter: blur(6px);
    transition: transform var(--motion-fast) var(--ease-out), background var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out);
  }
  .download-btn:hover { transform: translateY(-1px); background: rgba(0,255,156,.08); border-color: var(--color-primary-border); }
  .download-btn:active { transform: scale(.98); }
  .download-btn:focus-visible { outline: 2px solid var(--color-focus); outline-offset: 3px; }
  .download-btn.download-unavailable {
    color: var(--color-warning);
    border-color: rgba(255,194,71,.4);
    background: rgba(255,194,71,.06);
  }
  .download-btn.download-unavailable:hover:not(:disabled) {
    background: rgba(255,194,71,.12);
    border-color: rgba(255,194,71,.6);
  }
  .download-btn.download-unavailable:disabled { opacity: .6; cursor: progress; }
  .download-btn.download-unavailable :global(svg) { animation: spin 1s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .secondary-actions {
    display: flex; flex-wrap: wrap; align-items: center; justify-content: center;
    gap: 8px;
    width: 100%; max-width: 460px;
  }
  .secondary-btn {
    display: inline-flex; align-items: center; gap: 6px;
    min-height: 40px; padding: 10px 16px; border-radius: 999px;
    color: var(--color-text); font-size: .76rem; font-weight: 700;
    border: 1px solid var(--color-border-strong);
    background: rgba(255,255,255,.04); cursor: pointer;
    transition: background var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out), transform var(--motion-fast) var(--ease-out);
  }
  .secondary-btn:hover { background: var(--color-primary-soft); border-color: var(--color-primary-border); }
  .secondary-btn:active { transform: scale(.97); }
  .secondary-btn:focus-visible { outline: 2px solid var(--color-focus); outline-offset: 2px; }
  .save-error { margin-top: 4px; color: var(--color-warning); font-size: .66rem; text-align: center; }

  /* ---- Below the fold ---- */
  .detail-body {
    position: relative; z-index: 2;
    width: min(1500px, calc(100% - clamp(28px, 5vw, 96px)));
    margin-inline: auto;
    padding-top: clamp(8px, 2vh, 24px);
  }

  /* Cast rail */
  .cast-section { margin-top: clamp(28px, 4vw, 40px); }
  .section-h {
    color: var(--color-text);
    font-size: clamp(1.05rem, 1.6vw, 1.3rem);
    font-weight: 800; letter-spacing: -.02em;
    margin: 0 0 14px;
    padding-bottom: 8px;
    border-bottom: 1px solid var(--color-border);
  }
  .cast-rail {
    display: flex; gap: 12px;
    overflow-x: auto; scroll-snap-type: x proximity;
    padding: 2px 0 10px;
    scrollbar-width: none; -webkit-overflow-scrolling: touch;
  }
  .cast-rail::-webkit-scrollbar { display: none; }
  .cast-card {
    flex: 0 0 96px; min-width: 0; scroll-snap-align: start;
    display: flex; flex-direction: column; gap: 4px;
  }
  .cast-photo {
    width: 96px; height: 96px; border-radius: 50%; object-fit: cover;
    border: 1px solid var(--color-border-strong);
    background: var(--color-surface-elevated);
  }
  .cast-photo-fallback {
    display: grid; place-items: center;
    color: var(--color-text-deep);
    font-size: 1.5rem; font-weight: 800;
  }
  .cast-name {
    color: var(--color-text); font-size: .68rem; font-weight: 700; text-align: center;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .cast-character {
    color: var(--color-text-deep); font-size: .6rem; text-align: center;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }

  /* Recommendations */
  .recs-rail { margin-top: clamp(28px, 4vw, 40px); }

  /* === Trailer modal ===
     Unchanged behavior — only colors aligned to Phase B tokens. */
  .trailer-layer { position: fixed; inset: 0; z-index: 90; display: grid; place-items: center; padding: 16px; }
  .trailer-backdrop {
    position: absolute; inset: 0; border: 0;
    background: rgba(5,7,8,.85); backdrop-filter: blur(8px);
    cursor: default;
  }
  .trailer-modal {
    position: relative; width: min(960px, 100%); max-height: 90dvh; overflow: hidden;
    border: 1px solid var(--color-border-strong); border-radius: var(--radius-lg);
    background: var(--color-surface); box-shadow: var(--shadow-lg);
    animation: trailer-in 240ms var(--ease-out);
  }
  .trailer-bar {
    display: flex; align-items: center; justify-content: space-between;
    padding: 10px 14px;
    border-bottom: 1px solid var(--color-border);
    color: var(--color-text); font-size: .76rem; font-weight: 700;
  }
  .trailer-title { display: inline-flex; align-items: center; gap: 8px; }
  .trailer-close {
    display: grid; place-items: center;
    width: 32px; height: 32px;
    border: 1px solid var(--color-border-strong); border-radius: 50%;
    color: var(--color-text-muted);
    background: rgba(255,255,255,.04);
    cursor: pointer;
    transition: color var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out);
  }
  .trailer-close:hover { color: var(--color-text); border-color: var(--color-primary-border); }
  .trailer-close:focus-visible { outline: 2px solid var(--color-focus); outline-offset: 2px; }
  .trailer-frame { position: relative; aspect-ratio: 16 / 9; background: #000; }
  .trailer-frame iframe { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; }
  @keyframes trailer-in { from { opacity: 0; transform: translateY(12px); } to { opacity: 1; transform: translateY(0); } }

  /* ============================================================
     RESPONSIVE — three intentional layout modes.
     Mobile is the base stylesheet above. Below: tablet, desktop,
     large desktop/4K, and landscape mobile tweaks.
     ============================================================ */

  /* TABLET — poster + identity side-by-side. */
  @media (min-width: 641px) and (max-width: 1024px) {
    .hero { min-height: clamp(420px, 60vh, 560px); }
    .hero-inner { padding-top: clamp(80px, 12vh, 140px); }
    .hero-composition {
      grid-template-columns: minmax(180px, 240px) minmax(0, 1fr);
      gap: clamp(24px, 4vw, 40px);
      align-items: end;
    }
    .poster-wrap { justify-content: flex-start; margin-top: 0; }
    .poster-img { width: clamp(160px, 22vw, 220px); }
    .identity { text-align: left; }
    .meta-row { justify-content: flex-start; }
    .detail-desc {
      margin-left: 0; margin-right: 0;
      text-align: left;
    }
    .genre-tags { justify-content: flex-start; }
    .actions { align-items: flex-start; }
    .primary-actions, .secondary-actions { max-width: 460px; }
    .cast-card { flex: 0 0 110px; }
    .cast-photo { width: 110px; height: 110px; }
  }

  /* DESKTOP — full cinematic hero. */
  @media (min-width: 1025px) {
    .hero { min-height: clamp(520px, 76vh, 760px); }
    .hero-inner {
      width: min(1500px, calc(100% - clamp(48px, 6vw, 120px)));
      padding-top: clamp(96px, 14vh, 160px);
      padding-bottom: clamp(36px, 6vh, 80px);
    }
    .hero-composition {
      grid-template-columns: minmax(220px, 280px) minmax(0, 1fr);
      gap: clamp(32px, 4vw, 56px);
      align-items: end;
    }
    .poster-wrap { justify-content: flex-start; margin-top: 0; }
    .poster-img { width: clamp(220px, 18vw, 280px); }
    .identity { text-align: left; }
    .detail-eyebrow { font-size: .68rem; }
    .detail-title { font-size: clamp(2.2rem, 4.2vw, 3.4rem); }
    .meta-row { justify-content: flex-start; font-size: .82rem; }
    .detail-desc {
      margin-left: 0; margin-right: 0; text-align: left;
      font-size: .9rem; max-width: 680px;
    }
    .show-more { margin-left: 0; }
    .genre-tags { justify-content: flex-start; }
    .actions { align-items: flex-start; }
    .primary-actions, .secondary-actions { max-width: 480px; }
    .play-btn { padding: 16px 28px; }
    .cast-card { flex: 0 0 120px; }
    .cast-photo { width: 120px; height: 120px; }
  }

  /* LARGE DESKTOP / 4K — wider composition + bounded typography.
     The hero composition stays anchored to the lower-left, the
     content max-width grows but typography stays readable so 4K
     doesn't look like an enlarged 1080p layout. */
  @media (min-width: 1900px) {
    .hero-inner {
      width: min(1700px, calc(100% - 120px));
      padding-top: clamp(120px, 16vh, 200px);
    }
    .hero-composition { grid-template-columns: minmax(280px, 340px) minmax(0, 1fr); gap: 56px; }
    .poster-img { width: clamp(260px, 14vw, 320px); }
    .detail-title { font-size: clamp(2.6rem, 3vw, 3.6rem); }
    .detail-desc { max-width: 760px; font-size: .94rem; }
    .detail-body { width: min(1700px, calc(100% - 120px)); }
    .cast-card { flex: 0 0 130px; }
    .cast-photo { width: 130px; height: 130px; }
  }

  /* MOBILE — fine-tune base. */
  @media (max-width: 640px) {
    .detail-page { padding-bottom: 96px; }
    /* Mobile hero: remove the viewport-relative min-height. The base rule
       `min-height: clamp(440px, 78vh, 760px)` is overridden to `auto` so
       the hero sizes to its content — poster + title + metadata +
       description + actions. The previous min-height forced the hero to
       be 520px+ tall even when the content was only ~400px, leaving
       100-140px of dead space between the last action button and the
       hero bottom edge (which is where the Cast section starts). */
    .hero { min-height: auto; }
    .back-btn { top: calc(12px + env(safe-area-inset-top)); left: 12px; padding: 0 12px; min-height: 34px; font-size: .68rem; }
    /* Mobile backdrop fix: the backdrop image MUST be visible from the
       actual top of the hero. The previous design used an opaque
       var(--color-bg) gradient for the top 38%, hiding the backdrop.
       The new design uses a cinematic gradient that keeps the backdrop
       visible from the top while maintaining readable text:
         TOP → light dark overlay (backdrop visible)
         MIDDLE → darker overlay for poster/title/metadata
         BOTTOM → strong fade into var(--color-bg)
       The poster/content composition enters ~30-40% down from the top,
       over the darker middle section. */
    .hero-scrim {
      background:
        linear-gradient(180deg,
          rgba(5,7,8,.45) 0%,
          rgba(5,7,8,.35) 15%,
          rgba(5,7,8,.55) 30%,
          rgba(5,7,8,.78) 45%,
          rgba(5,7,8,.88) 60%,
          rgba(5,7,8,.94) 80%,
          var(--color-bg) 100%);
    }
    .hero-inner {
      width: calc(100% - 28px);
      padding-top: clamp(56px, 12vh, 100px);
    }
    .hero-composition { gap: 18px; }
    .poster-wrap { margin-top: clamp(-78px, -22vw, -50px); }
    .poster-img { width: clamp(120px, 36vw, 142px); border-radius: 10px; }
    .detail-title { font-size: clamp(1.5rem, 6.4vw, 2rem); }
    .meta-row { font-size: .7rem; gap: 6px; }
    .detail-desc { font-size: .8rem; }
    .primary-actions { max-width: 100%; }
    .play-btn { flex: 1 1 100%; padding: 14px 22px; font-size: .9rem; }
    .download-btn {
      flex: 1 1 100%;
    }
    .secondary-btn { padding: 9px 14px; font-size: .72rem; }
    /* Consolidate the gap between the last hero action row and the first
       content section below (Cast / Episodes / Recommendations). The base
       rules stack three independent spacings: hero-inner padding-bottom
       (clamp(28px, 4vh, 56px)) + detail-body padding-top (clamp(8px, 2vh,
       24px)) + cast-section margin-top (clamp(28px, 4vw, 40px)). On a tall
       phone these can total 80-100px+ of dead space. The mobile override
       below collapses them into a single compact 24px total gap. */
    .hero-inner { padding-bottom: 8px; }
    .detail-body { padding-top: 0; }
    .cast-section { margin-top: 16px; }
    .recs-rail { margin-top: 16px; }
  }

  /* LANDSCAPE MOBILE — short viewport: keep the title + Play above
     the fold, never push content below the visible area. */
  @media (max-width: 1024px) and (orientation: landscape) and (max-height: 480px) {
    .hero {
      min-height: auto;
      height: auto;
    }
    .hero-inner { padding-top: clamp(48px, 10vh, 80px); padding-bottom: 16px; }
    .hero-composition { gap: 18px; }
    .poster-img { width: clamp(110px, 18vw, 160px); }
    .detail-title { font-size: clamp(1.3rem, 3vw, 1.8rem); }
    .detail-desc { -webkit-line-clamp: 2; line-clamp: 2; }
    .primary-actions { max-width: 100%; }
    .play-btn { flex: 1 1 100%; }
  }

  @media (prefers-reduced-motion: reduce) {
    .back-btn, .play-btn, .download-btn, .secondary-btn, .trailer-modal,
    .show-more, .trailer-close {
      transition: none !important;
      animation: none !important;
    }
  }
</style>
