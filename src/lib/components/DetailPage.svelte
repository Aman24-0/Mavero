<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { page } from '$app/state';
  import { goto } from '$app/navigation';
  import { ArrowLeft, Heart, Play, Share2, Star, ListPlus, Film, X, Download, AlertCircle, LoaderCircle } from 'lucide-svelte';
  import SelectionSheet from '$components/SelectionSheet.svelte';
  import DownloadSheet from '$components/DownloadSheet.svelte';
  import type { ContentType } from '$data/content';
  import { getMedia, formatBadges, type MediaItem } from '$data/content';
  import ContentRail from '$components/ContentRail.svelte';
  import SkeletonCard from '$components/SkeletonCard.svelte';
  import { getCachedRail, setCachedRail } from '$lib/client/discover/rail-cache';
  import SeasonEpisodes from '$components/SeasonEpisodes.svelte';
  import { getFavoriteStatus, getLocalProgressRecords, removeFavoriteFromMyList, setFavoriteStatus } from '$lib/client/progress/service';
  import type { WatchlistStatus } from '$lib/client/progress/types';
  import { latestResumeEpisode, getLatestResumeTarget } from '$lib/client/progress/presenter';
  import { deleteCloudFavorite, syncAuthenticatedState } from '$lib/client/progress/cloud';
  import { appendReturnTo, navigateBackOr } from '$lib/shared/navigation';
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
  // MAV-20 Phase D — the "You may also like" rail loads CLIENT-SIDE.
  //
  // The server page load now returns the parent detail only (the
  // per-recommendation classification N+1 no longer blocks navigation —
  // the reported ~2-3s back-from-player stall). The component fetches
  // the classified rail from /api/content/recommendations after mount:
  //   loading → skeleton rail;
  //   ready   → the classified items (an EMPTY successful result hides
  //             the section — no fixture fallback, the honest-empty
  //             convention every other rail follows);
  //   failed  → the section stays hidden (supplementary below-fold
  //             content; a failed fetch must not break the page).
  // The response is served through the same per-user TTL-bounded client
  // cache as every other rail (rail-cache.ts) — back-nav within the TTL
  // renders the rail instantly.
  let recommendationState = $state<'loading' | 'ready' | 'failed'>('loading');
  let clientRecommendations = $state<MediaItem[]>([]);
  const recommendations = $derived(recommendationItems.length ? recommendationItems : clientRecommendations);
  const statusSheetOptions = $derived(watchlistStatus ? statusOptions : statusOptions.filter((option) => option.key !== 'remove'));
  const canonicalUrl = $derived(`${page.url.origin}/${type}/${item.id}`);
  const watchPath = $derived(type === 'movie' ? `/watch/${type}/${item.id}` : `/watch/${type}/${item.id}?season=${resumeEpisode?.season ?? 1}&episode=${resumeEpisode?.episode ?? 1}`);
  const watchHref = $derived(appendReturnTo(watchPath, `${page.url.pathname}${page.url.search}${page.url.hash}`));
  const structuredData = $derived(JSON.stringify({ '@context': 'https://schema.org', '@type': type === 'movie' ? 'Movie' : 'TVSeries', name: item.title, description: item.description, image: item.backdrop || item.poster, dateCreated: String(item.year), aggregateRating: { '@type': 'AggregateRating', ratingValue: item.rating, bestRating: 10, ratingCount: 1 } }));
  const trailerKey = $derived(item.trailerKey ?? '');
  const hasTrailer = $derived(Boolean(trailerKey));
  const castMembers = $derived(item.cast ?? []);

  // ============================================================
  // MAV-21 Workstream F — Cinematic Detail Page 2.0 derived state.
  // ============================================================

  // Series-like covers TV series AND anime series (the established
  // resume/seasons predicate — identical to the progress pipeline's).
  const isSeriesLike = $derived(type === 'series' || (item.isAnime && item.animeFormat !== 'movie'));

  // Hero artwork: backdrop first (immersive), poster as the graceful
  // fallback when no backdrop exists. A failed image load falls back to
  // the gradient surface (never a broken-image icon over the hero).
  let heroArtworkFailed = $state(false);
  const heroArtwork = $derived(item.backdropHero || item.backdrop || item.poster || '');
  const heroArtworkSrc = $derived(heroArtworkFailed ? '' : heroArtwork);

  // Primary action label — the dominant button communicates EXACTLY what
  // pressing it does, using the existing playback/progress logic:
  //   series-like + resume target → "Continue Watching" (+ SxEy sub-label)
  //   movie + active progress     → "Resume"
  //   otherwise                   → "Play" (series: the established
  //                                 first-episode behavior via watchHref)
  const playLabel = $derived(
    isSeriesLike && resumeEpisode ? 'Continue Watching'
      : !isSeriesLike && hasActiveProgress ? 'Resume'
        : 'Play'
  );
  const playSubLabel = $derived(isSeriesLike && resumeEpisode ? `S${resumeEpisode.season} · E${resumeEpisode.episode}` : '');

  // Compact genre presentation for the first viewport: at most 4 genres
  // on one bounded line; the FULL list lives in the Overview facts
  // (never let a long genre list dominate the hero).
  const MAX_HERO_GENRES = 4;
  const heroGenres = $derived(item.genres.slice(0, MAX_HERO_GENRES));
  const heroGenreOverflow = $derived(Math.max(0, item.genres.length - MAX_HERO_GENRES));

  // Overview expansion (below-fold full synopsis).
  const hasLongOverview = $derived(item.description.length > 280);

  // Readable language name from the TMDB code (client-side
  // Intl.DisplayNames; falls back to the raw code, never invents).
  function languageName(code: string | undefined): string {
    if (!code) return '';
    try {
      return new Intl.DisplayNames(['en'], { type: 'language' }).of(code) ?? code;
    } catch {
      return code;
    }
  }

  // P2: Format an ISO date string (YYYY-MM-DD) into a human-readable date.
  // Returns the year-only fallback if the date is invalid/missing.
  function formatDate(iso: string | undefined): string {
    if (!iso) return String(item.year > 0 ? item.year : '');
    const d = new Date(iso + 'T00:00:00Z');
    if (isNaN(d.getTime())) return String(item.year > 0 ? item.year : '');
    // Use en-GB for day-before-month format (07 Mar 2026).
    return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });
  }

  // Facts rows — ONLY values the trusted metadata actually supplies.
  // Missing metadata renders NO row (no empty labels, no misleading
  // zeros, no fabricated certifications). All values come from the SSR
  // detail payload, so the grid cannot shift when it renders.
  const factRows = $derived.by(() => {
    const rows: Array<{ label: string; value: string }> = [];
    if (item.releaseDate) rows.push({ label: isSeriesLike ? 'First aired' : 'Release date', value: formatDate(item.releaseDate) });
    else if (item.year > 0) rows.push({ label: isSeriesLike ? 'First aired' : 'Release year', value: String(item.year) });
    if (!isSeriesLike && item.runtime) rows.push({ label: 'Runtime', value: item.runtime });
    if (isSeriesLike && item.seasons) rows.push({ label: 'Seasons', value: String(item.seasons) });
    if (isSeriesLike && item.episodes) rows.push({ label: 'Episodes', value: String(item.episodes) });
    if (item.maturity) rows.push({ label: 'Certification', value: item.maturity });
    const language = languageName(item.originalLanguage);
    if (language) rows.push({ label: 'Original language', value: language });
    if (!isSeriesLike && item.director) rows.push({ label: 'Director', value: item.director });
    if (isSeriesLike && item.creators?.length) rows.push({ label: 'Creators', value: item.creators.join(', ') });
    if (item.genres.length) rows.push({ label: 'Genres', value: item.genres.join(', ') });
    return rows;
  });

  // MAV-20 Phase D — client-side "You may also like" fetch (see the
  // recommendations derived above). Cached per-user for 2 minutes, so
  // back-nav to this page renders the rail instantly; the SERVER cache
  // (30-minute detail policy) makes the classification cheap after the
  // first request. Failures settle silently to the hidden state — the
  // rail is supplementary and must never block or break the page.
  async function loadRecommendations() {
    const url = `/api/content/recommendations/${type}/${encodeURIComponent(item.id)}`;
    const cached = getCachedRail<MediaItem>(url, page.data.user?.id);
    if (cached) {
      clientRecommendations = cached.items;
      recommendationState = 'ready';
      return;
    }
    try {
      const response = await fetch(url);
      const payload = await response.json();
      if (!response.ok || !payload.ok) throw new Error('unavailable');
      clientRecommendations = (payload.recommendations ?? []) as MediaItem[];
      recommendationState = 'ready';
      setCachedRail(url, page.data.user?.id, clientRecommendations, clientRecommendations.length > 0);
    } catch {
      recommendationState = 'failed';
    }
  }

  onMount(() => {
    let active = true;
    const loadProgressState = async () => {
      const status = await getFavoriteStatus(type, item.id);
      const progress = await getLocalProgressRecords();
      if (!active) return;
      // P5: For series, the resume target doesn't require currentTime > 0.
      // A user can click S2E3 and leave immediately — S2E3 is still the
      // resume target. For movies, we still require currentTime > 0
      // (a zero-progress movie record means nothing was actually watched).
      if (isSeriesLike) {
        const target = getLatestResumeTarget(type, item.id, progress);
        hasActiveProgress = !!target;
        resumeEpisode = target ? { season: target.season!, episode: target.episode! } : undefined;
      } else {
        // Movie: require actual playback time > 0
        hasActiveProgress = progress.some((record) => record.contentType === type && record.contentId === item.id && record.completionState !== 'completed' && record.currentTime > 0);
        resumeEpisode = undefined;
      }
      const effectiveStatus = status ?? (hasActiveProgress ? 'watching' : null);
      watchlistStatus = effectiveStatus;
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
    // MAV-20 Phase D — the classified recommendations load client-side
    // (skeleton first; see loadRecommendations). Never blocks the page.
    void loadRecommendations();
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
    // MAV-20 Phase D — the single coherent back policy
    // (shared/navigation.ts navigateBackOr):
    //
    //   1. `from` present + valid  → REAL history.back() through the
    //      watchdog. The origin listing's own history entry carries its
    //      query/filter state and SvelteKit snapshot — popstate is what
    //      restores the origin page's content + scroll position.
    //   2. `from` absent           → REAL history.back() WHENEVER an
    //      in-app previous entry exists (SvelteKit's history index > 0).
    //   3. No in-app origin at all (deep link, first entry) → the safe
    //      fallback destination. The goto uses replaceState so the
    //      deep-linked detail entry is replaced by the destination —
    //      the user cannot go "back" to a page they never navigated to.
    //
    // history.back() is fire-and-forget and SILENTLY no-ops without a
    // previous entry — navigateBackOr's popstate watchdog detects that
    // (popstate fires as a macrotask; if it hasn't fired by the next
    // macrotask, back() did nothing) and runs the fallback.
    const validReturnTo = returnTo?.startsWith('/') && !returnTo.startsWith('//') ? returnTo : null;
    const fallbackDestination = validReturnTo ?? '/discover';
    navigateBackOr(() => {
      void goto(fallbackDestination, { replaceState: true, keepFocus: true });
    });
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

  // The top-level Download button beside Play is MOVIES-ONLY.
  // TV/anime series get a Download button on each episode card instead.
  const isMovieLike = $derived(downloadMediaType === 'movie');

  // Filtered providers for the current media type. The DownloadSheet uses
  // this list when it has providers; when the prefetch is loading/failed/empty,
  // the sheet itself renders the appropriate state (loading spinner, error
  // retry, or empty "no downloaders" message).
  const visibleDownloadProviders = $derived(filterProvidersByMediaType(downloadProviders, downloadMediaType));
  // Phase E final corrective (§6): the top-level Download button is shown
  // for ALL movie-like items UNCONDITIONALLY — it must NOT be gated on
  // `downloadProvidersLoaded` or `visibleDownloadProviders.length > 0`.
  //
  // Architecture: USER CLICKS DOWNLOAD → SHEET OPENS IMMEDIATELY →
  // sheet renders Loading / Success / Empty / Error state internally. The
  // prefetch remains an optimization but is not a functional prerequisite.
  const showDownloadButton = $derived(isMovieLike);
  // The inline "Download unavailable · Retry" affordance is kept for the
  // narrow case where the prefetch FAILED before the user clicked.
  const showDownloadFailure = $derived(false);

  // TMDB id resolution. The DetailPage's `item.id` is the content id used
  // across the app — for TMDB-backed content this IS the TMDB id.
  const downloadTmdbId = $derived(item.externalIds?.tmdb || item.id || '');

  // Release year for the Cineverse alternate-URL candidate.
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
    } finally {
      downloadProvidersLoading = false;
    }
  }

  // Phase 2-K: retry entry point — re-attempts the prefetch when the user
  // clicks the inline Retry affordance.
  function retryDownloadProviders() {
    if (downloadProvidersLoading || downloadProvidersLoaded) return;
    void loadDownloadProviders();
  }

  // Open the sheet for a MOVIE download. No season/episode — the sheet
  // uses the movie URL template. The target state stays undefined.
  function openDownloadSheet() {
    haptic('light');
    if (!downloadProvidersLoaded && !downloadProvidersLoading) {
      void loadDownloadProviders();
    }
    downloadTargetSeason = undefined;
    downloadTargetEpisode = undefined;
    downloadSheetOpen = true;
  }

  // Open the sheet for an EPISODE download — the EXACT clicked episode.
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
       MAV-21 WORKSTREAM F — CINEMATIC HERO 2.0.

       Immersive full-bleed artwork (backdrop, poster as the graceful
       fallback), bottom-anchored identity, and an action hierarchy that
       fits the first mobile viewport (target 390×844):

         content-type label
         title (line-clamped — long titles never push actions away)
         compact meta line (only available facts)
         one-line genre strip (max 4 + overflow count)
         2-line synopsis preview (full synopsis lives in Overview)
         ▶ dominant Play / Resume / Continue Watching
         Watching · Share · Trailer (· Download for movie-like items)

       Touch surfaces (≤1024px) prioritize the artwork — no poster in
       the hero. Desktop (≥1025px) adds the poster composition to the
       lower-left of the backdrop.
       ============================================================ -->
  <header class="hero">
    {#if heroArtworkSrc}
      <!-- MAV-21 Workstream E — the hero follows the SAME responsive
           artwork contract as the Discover/Explorer carousels (the
           established tier decision, documented there): mobile ≤640px
           standard DPI gets w780 (bandwidth-friendly), mobile retina
           gets w1280, tablet/desktop ≥641px gets original. A single
           original-size <img> on a 390px phone was a multi-hundred-KB
           LCP penalty on every detail page. Sources WITHOUT a tier fall
           back through the chain; a missing srcset makes that <source>
           inert, and the <img> fallback (w1280 backdrop, poster when no
           backdrop exists) still renders. -->
      <picture>
        <source media="(max-width: 640px) and (-webkit-min-device-pixel-ratio: 2), (max-width: 640px) and (min-resolution: 192dpi)" srcset={item.backdrop || item.backdropSmall || item.poster} />
        <source media="(max-width: 640px)" srcset={item.backdropSmall || item.backdrop || item.poster} />
        <source media="(min-width: 641px)" srcset={item.backdropHero || item.backdrop || item.backdropSmall || item.poster} />
        <img
          src={heroArtworkSrc}
          alt=""
          class="hero-img"
          width="1280"
          height="720"
          sizes="100vw"
          loading="eager"
          fetchpriority="high"
          decoding="async"
          onerror={() => (heroArtworkFailed = true)}
        />
      </picture>
    {/if}
    <div class="hero-scrim" aria-hidden="true"></div>
    <button class="back-btn" type="button" onclick={goBack} aria-label="Go back">
      <ArrowLeft size={16} /> <span>Back</span>
    </button>

    <div class="hero-inner">
      <div class="hero-composition">
        <!-- Poster — desktop composition only (hidden ≤1024px; the
             mobile/tablet hero is poster-free so the artwork stays
             immersive and the actions stay in the first viewport). -->
        {#if item.poster}
          <div class="poster-wrap">
            <img src={item.posterSmall || item.poster} alt={`${item.title} poster`} class="poster-img" loading="eager" />
          </div>
        {/if}

        <section class="identity">
          <div class="detail-eyebrow">{detailBadges.primary}{#if detailBadges.secondary} · {detailBadges.secondary}{/if}</div>
          <h1 class="detail-title">{item.title}</h1>

          <div class="meta-row">
            {#if item.rating > 0}
              <span class="rating"><Star size={12} fill="currentColor" strokeWidth={0} /> {item.rating.toFixed(1)}</span>
            {/if}
            {#if item.releaseDate}
              <span class="dot"></span><span>{formatDate(item.releaseDate)}</span>
            {:else if item.year > 0}
              <span class="dot"></span><span>{item.year}</span>
            {/if}
            {#if item.maturity}<span class="dot"></span><span class="maturity">{item.maturity}</span>{/if}
            {#if isSeriesLike && item.seasons}
              <span class="dot"></span><span>{item.seasons} season{item.seasons === 1 ? '' : 's'}</span>
            {:else if isSeriesLike && item.episodes}
              <span class="dot"></span><span>{item.episodes} episode{item.episodes === 1 ? '' : 's'}</span>
            {:else if !isSeriesLike && item.runtime}
              <span class="dot"></span><span>{item.runtime}</span>
            {/if}
          </div>

          {#if heroGenres.length}
            <p class="genre-line">
              {#each heroGenres as genre, index}{index > 0 ? ' · ' : ''}{genre}{/each}{#if heroGenreOverflow > 0} <span class="genre-more">+{heroGenreOverflow} more</span>{/if}
            </p>
          {/if}

          {#if item.description}
            <p class="detail-desc">{item.description}</p>
          {/if}

          <!-- Action hierarchy: the dominant main action first, the
               approved secondary row immediately beneath it. -->
          <div class="actions">
            <div class="primary-actions">
              <a class="play-btn" href={watchHref} aria-label={playSubLabel ? `${playLabel} — season ${resumeEpisode?.season}, episode ${resumeEpisode?.episode}` : `${playLabel} ${item.title}`}>
                <Play size={17} fill="currentColor" strokeWidth={0} />
                <span class="play-copy">
                  <span class="play-label">{playLabel}</span>
                  {#if playSubLabel}<span class="play-sub">{playSubLabel}</span>{/if}
                </span>
              </a>
              {#if showDownloadButton}
                <button class="download-btn" type="button" onclick={openDownloadSheet} aria-haspopup="dialog" aria-expanded={downloadSheetOpen} aria-label={`Download ${item.title}`}>
                  <Download size={17} />
                  <span>Download</span>
                </button>
              {:else if showDownloadFailure}
                <button class="download-btn download-unavailable" type="button" onclick={retryDownloadProviders} disabled={downloadProvidersLoading} aria-label="Download temporarily unavailable — retry loading providers">
                  {#if downloadProvidersLoading}<LoaderCircle size={17} />{:else}<AlertCircle size={17} />{/if}
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
       BELOW THE FOLD — Overview (+ facts) / Available on / Cast /
       Seasons & Episodes / Recommendations. Scannable sections in one
       composed column; nothing here blocks the hero (all hero data is
       SSR; recommendations load progressively client-side).
       ============================================================ -->
  <div class="detail-body">
    <!-- Overview: the expandable full synopsis + compact factual
         metadata. Facts render ONLY when the trusted metadata supplies
         them — no empty labels, no invented values. -->
    {#if item.description || factRows.length}
      <section class="overview-section" aria-labelledby="overview-heading">
        <h2 class="section-h" id="overview-heading">Overview</h2>
        {#if item.description}
          <p class="overview-text" class:expanded={overviewExpanded}>{item.description}</p>
          {#if hasLongOverview}
            <button class="show-more" type="button" onclick={() => (overviewExpanded = !overviewExpanded)} aria-expanded={overviewExpanded}>
              {overviewExpanded ? 'Show Less' : 'Show More'}
            </button>
          {/if}
        {/if}
        {#if factRows.length}
          <dl class="facts-grid">
            {#each factRows as fact (fact.label)}
              <div class="fact-row">
                <dt class="fact-label">{fact.label}</dt>
                <dd class="fact-value">{fact.value}</dd>
              </div>
            {/each}
          </dl>
        {/if}
      </section>
    {/if}

    <!-- P3: Available on (renamed from "Streaming on" in the Explorer
         redesign, Change 6 — label copy only; the provider cards/logos
         and their behavior are unchanged) — India flatrate OTT
         providers from TMDB. -->
    {#if item.streamingProviders && item.streamingProviders.length > 0}
      <section class="streaming-section" aria-labelledby="streaming-heading">
        <h2 class="section-h" id="streaming-heading">Available on</h2>
        <div class="streaming-providers" role="list">
          {#each item.streamingProviders as provider (provider.id)}
            <div class="streaming-provider" role="listitem">
              {#if provider.logo}
                <img src={provider.logo} alt="" class="streaming-logo" loading="lazy" decoding="async" width="32" height="32" />
              {/if}
              <span class="streaming-name">{provider.name}</span>
            </div>
          {/each}
        </div>
      </section>
    {/if}

    <!-- Cast -->
    {#if castMembers.length}
      <section class="cast-section" aria-labelledby="cast-heading">
        <h2 class="section-h" id="cast-heading">Cast</h2>
        <div class="cast-rail" role="list">
          {#each castMembers as member}
            <div class="cast-card" role="listitem">
              {#if member.photo}
                <img src={member.photo} alt={member.name} class="cast-photo" loading="lazy" decoding="async" width="96" height="96" />
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
    {#if isSeriesLike}
      <SeasonEpisodes
        id={item.id}
        seasonCount={item.seasons ?? 1}
        watchType={type === 'anime' ? 'anime' : 'series'}
        onDownload={openEpisodeDownloadSheet}
        contentSnapshot={{ title: item.title, poster: item.poster, backdrop: item.backdrop, year: item.year, runtime: typeof item.runtime === 'string' ? item.runtime : String(item.runtime), rating: item.rating, genres: item.genres, description: item.description }}
      />
    {/if}

    <!-- Recommendations (MAV-20 Phase D: loaded client-side — skeleton
         while loading, hidden when empty/failed; never fixture-filled) -->
    {#if recommendations.length}
      <div class="recs-rail">
        <ContentRail title="You may also like" eyebrow="Keep exploring" items={recommendations} compact />
      </div>
    {:else if recommendationState === 'loading'}
      <div class="recs-rail" aria-busy="true" aria-live="polite">
        <div class="recs-head">
          <h2 class="recs-title">You may also like</h2>
        </div>
        <div class="recs-skeleton">
          {#each Array(6) as _, i (i)}<SkeletonCard />{/each}
        </div>
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
     the parent only flips `open` and supplies the media context. -->
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
     MAV-21 WORKSTREAM F — CINEMATIC DETAIL PAGE 2.0
     -----------------------------------------------------------------
     Layout modes (one DOM, CSS decides the composition):
       • mobile  (≤640px): immersive full-bleed backdrop, poster-free
         hero, identity + actions BOTTOM-ANCHORED — the dominant Play
         action and the Watching / Share / Trailer row fit the first
         390×844 viewport together with the title and compact metadata.
       • tablet  (641–1024px): same immersive composition, wider type
         scale, still poster-free (touch surfaces prioritize artwork).
       • desktop (≥1025px): the poster joins the composition — poster +
         identity + actions form one block anchored over the lower-left
         of the full-bleed backdrop.
       • large   (≥1900px): wider max-width, bounded typography.
     The hero never has a hard rectangular backdrop edge: dark
     gradients blend it into the page background. Space is reserved
     (min-height + aspect-ratio) so metadata cannot shift the layout.
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
    min-height: clamp(440px, 78vh, 760px);
    display: flex;
    align-items: flex-end;
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
  /* Scrim — cinematic gradients: a readable top (back button), a clear
     band for the artwork, and a strong bottom fade that guarantees
     title/action contrast over ANY artwork. */
  .hero-scrim {
    position: absolute; inset: 0; z-index: 1; pointer-events: none;
    background:
      linear-gradient(180deg, rgba(5,7,8,.58) 0%, rgba(5,7,8,.14) 24%, rgba(5,7,8,.30) 52%, rgba(5,7,8,.78) 76%, rgba(5,7,8,.94) 92%, var(--color-bg) 100%),
      linear-gradient(90deg, rgba(5,7,8,.55) 0%, rgba(5,7,8,.22) 34%, transparent 62%);
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

  /* ---- Hero inner (bottom-anchored composition) ---- */
  .hero-inner {
    position: relative; z-index: 3;
    width: min(1500px, calc(100% - clamp(28px, 5vw, 96px)));
    margin-inline: auto;
    padding-bottom: clamp(18px, 3vh, 34px);
  }
  .hero-composition {
    display: grid;
    grid-template-columns: 1fr;
    gap: clamp(20px, 3vw, 36px);
    align-items: end;
  }

  /* Poster — desktop composition only (hidden on touch surfaces). */
  .poster-wrap { display: none; }
  .poster-img {
    width: clamp(220px, 18vw, 280px);
    aspect-ratio: 2 / 3; object-fit: cover;
    border-radius: var(--radius-md);
    border: 1px solid var(--color-border-strong);
    box-shadow: 0 22px 50px rgba(0,0,0,.6);
  }

  /* Identity block */
  .identity {
    text-align: center;
    min-width: 0;
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
    font-size: clamp(1.65rem, 6.2vw, 2.6rem);
    font-weight: 900;
    letter-spacing: -.025em;
    line-height: 1.06;
    text-wrap: balance;
    text-shadow: 0 2px 18px rgba(0,0,0,.55);
    /* Deliberate clamp: a long title never pushes the actions out of
       the first viewport (spec: prioritize actions without clipping
       essential title information — 3 lines on touch, 2 on desktop). */
    display: -webkit-box; -webkit-box-orient: vertical;
    -webkit-line-clamp: 3; line-clamp: 3; overflow: hidden;
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
  .maturity {
    border: 1px solid var(--color-border-strong);
    border-radius: 5px;
    padding: 1px 6px;
    font-size: .64rem; font-weight: 800; letter-spacing: .03em;
  }
  .dot { width: 3px; height: 3px; border-radius: 50%; background: var(--color-text-deep); }

  /* Compact genre strip — ONE bounded line; the full list lives in the
     Overview facts. A long genre list can never dominate the hero. */
  .genre-line {
    margin: 10px auto 0;
    max-width: 560px;
    color: var(--color-text-muted);
    font-size: .7rem; font-weight: 700; letter-spacing: .02em;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .genre-more { color: var(--color-text-deep); font-weight: 600; }

  /* Hero synopsis preview — two lines; the expandable full synopsis
     lives in the Overview section below. */
  .detail-desc {
    max-width: 620px; margin: 10px auto 0;
    color: var(--color-text-muted); font-size: .8rem; line-height: 1.55;
    display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; line-clamp: 2; overflow: hidden;
  }

  /* ---- Actions ----
     The main action is DOMINANT (primary-filled, largest target);
     the approved secondary row sits immediately beneath it. */
  .actions {
    margin-top: 18px;
    display: flex; flex-direction: column; align-items: center; gap: 10px;
  }
  .primary-actions {
    display: flex; align-items: stretch; gap: 8px;
    width: 100%; max-width: 480px;
  }
  .play-btn {
    display: inline-flex; align-items: center; justify-content: center; gap: 10px;
    flex: 1 1 62%; min-height: 52px;
    padding: 12px 22px; border-radius: 999px;
    color: #050708; font-size: .92rem; font-weight: 800;
    text-decoration: none;
    background: var(--color-primary);
    box-shadow: 0 6px 22px rgba(0,255,156,.28), var(--glow-primary);
    transition: transform var(--motion-fast) var(--ease-out), box-shadow var(--motion-fast) var(--ease-out), filter var(--motion-fast) var(--ease-out);
  }
  .play-btn:hover { transform: translateY(-1px); filter: brightness(1.06); box-shadow: 0 8px 28px rgba(0,255,156,.4), var(--glow-primary); }
  .play-btn:active { transform: scale(.98); }
  .play-btn:focus-visible { outline: 2px solid var(--color-focus); outline-offset: 3px; }
  .play-copy { display: flex; flex-direction: column; align-items: flex-start; gap: 1px; min-width: 0; }
  .play-label { line-height: 1.1; }
  .play-sub {
    font-size: .62rem; font-weight: 700; letter-spacing: .05em;
    color: rgba(5,7,8,.72); line-height: 1.1;
  }
  .download-btn {
    display: inline-flex; align-items: center; justify-content: center; gap: 8px;
    flex: 1 1 38%; min-height: 52px;
    padding: 12px 16px; border-radius: 999px;
    border: 1px solid var(--color-border-strong);
    color: var(--color-text); font-size: .88rem; font-weight: 800; cursor: pointer;
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
    width: 100%; max-width: 480px;
  }
  .secondary-btn {
    display: inline-flex; align-items: center; gap: 6px;
    min-height: 44px; padding: 10px 16px; border-radius: 999px;
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

  .section-h {
    color: var(--color-text);
    font-size: clamp(1.05rem, 1.6vw, 1.3rem);
    font-weight: 800; letter-spacing: -.02em;
    margin: 0 0 14px;
    padding-bottom: 8px;
    border-bottom: 1px solid var(--color-border);
  }

  /* Overview — full synopsis + facts grid. */
  .overview-section { margin-top: clamp(20px, 3vw, 32px); }
  .overview-text {
    margin: 0;
    color: var(--color-text-muted); font-size: .86rem; line-height: 1.65;
    display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 4; line-clamp: 4; overflow: hidden;
  }
  .overview-text.expanded { -webkit-line-clamp: unset; line-clamp: unset; overflow: visible; }
  .show-more {
    display: inline-block; margin: 8px 0 0;
    padding: 4px 8px; border: 0; background: transparent;
    color: var(--color-primary); font: inherit;
    font-size: .7rem; font-weight: 700; cursor: pointer;
    text-decoration: underline; text-underline-offset: 3px;
    text-decoration-color: var(--color-primary-border);
    transition: text-decoration-color var(--motion-fast) var(--ease-out);
  }
  .show-more:hover { text-decoration-color: var(--color-primary); }
  .show-more:focus-visible { outline: 2px solid var(--color-focus); outline-offset: 2px; border-radius: 4px; }
  .facts-grid {
    margin: 16px 0 0;
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    gap: 10px 26px;
  }
  .fact-row { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .fact-label {
    color: var(--color-text-deep);
    font-size: .62rem; font-weight: 800; letter-spacing: .1em; text-transform: uppercase;
  }
  .fact-value {
    margin: 0;
    color: var(--color-text);
    font-size: .8rem; font-weight: 600; line-height: 1.45;
    overflow-wrap: anywhere;
  }

  /* P3: Available on section — compact, above Cast. */
  .streaming-section { margin-top: clamp(28px, 4vw, 40px); }
  .streaming-providers { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 10px; }
  .streaming-provider { display: inline-flex; align-items: center; gap: 8px; padding: 6px 12px; border: 1px solid var(--color-border-strong); border-radius: 999px; background: var(--color-surface); }
  .streaming-logo { width: 24px; height: 24px; border-radius: 4px; object-fit: cover; flex: 0 0 auto; }
  .streaming-name { color: var(--color-text); font-size: .75rem; font-weight: 600; white-space: nowrap; }

  /* Cast rail */
  .cast-section { margin-top: clamp(28px, 4vw, 40px); }
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
  /* MAV-20 Phase D — skeleton state for the client-side rec rail. Uses
     the SAME horizontal grid geometry as the populated rail so the
     section height is stable from first paint. */
  .recs-head { display: flex; align-items: baseline; gap: 8px; margin-bottom: 10px; padding: 0 clamp(16px, 4vw, 32px); }
  .recs-title {
    margin: 0;
    color: var(--ink, #f5f5f5);
    font-family: 'Inter', sans-serif;
    font-size: clamp(1rem, 1.7vw, 1.25rem);
    font-weight: 800;
    letter-spacing: -.02em;
  }
  .recs-skeleton {
    display: grid; grid-auto-flow: column; grid-auto-columns: 178px; gap: 14px;
    overflow: hidden; padding: 6px clamp(16px, 4vw, 32px) 12px;
  }

  /* === Trailer modal === (unchanged behavior) */
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
     RESPONSIVE — deliberate composition per surface.
     ============================================================ */

  /* TABLET — immersive artwork, left-aligned identity, poster-free. */
  @media (min-width: 641px) and (max-width: 1024px) {
    .hero { min-height: clamp(460px, 70vh, 640px); }
    .hero-inner { padding-top: clamp(60px, 10vh, 120px); }
    .identity { text-align: left; }
    .meta-row { justify-content: flex-start; }
    .genre-line { margin-left: 0; }
    .detail-desc { margin-left: 0; margin-right: 0; }
    .actions { align-items: flex-start; }
    .primary-actions, .secondary-actions { max-width: 480px; }
    .cast-card { flex: 0 0 110px; }
    .cast-photo { width: 110px; height: 110px; }
    .facts-grid { grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); }
  }

  /* DESKTOP — the poster joins the cinematic composition. */
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
    .poster-wrap { display: flex; justify-content: flex-start; }
    .identity { text-align: left; }
    .detail-eyebrow { font-size: .68rem; }
    .detail-title { font-size: clamp(2.2rem, 4.2vw, 3.4rem); -webkit-line-clamp: 2; line-clamp: 2; }
    .meta-row { justify-content: flex-start; font-size: .82rem; }
    .genre-line { margin-left: 0; }
    .detail-desc {
      margin-left: 0; margin-right: 0;
      font-size: .9rem; max-width: 680px;
    }
    .actions { align-items: flex-start; }
    .primary-actions, .secondary-actions { max-width: 480px; }
    .play-btn { padding: 14px 28px; }
    .cast-card { flex: 0 0 120px; }
    .cast-photo { width: 120px; height: 120px; }
    .facts-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px 32px; }
  }

  /* LARGE DESKTOP / 4K — wider composition + bounded typography. */
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
    .facts-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  }

  /* MOBILE — the poster-free immersive hero; identity + actions
     bottom-anchored so the dominant Play action and the Watching /
     Share / Trailer row land INSIDE the first 390×844 viewport. */
  @media (max-width: 640px) {
    .detail-page { padding-bottom: 96px; }
    .hero { min-height: clamp(430px, 68vh, 580px); }
    .back-btn { top: calc(12px + env(safe-area-inset-top)); left: 12px; padding: 0 12px; min-height: 34px; font-size: .68rem; }
    /* The scrim keeps the artwork visible at the top while the
       bottom-anchored identity/actions sit on a strong readable fade —
       all rgba stops, no opaque band (the audited mobile-backdrop
       contract). */
    .hero-scrim {
      background:
        linear-gradient(180deg,
          rgba(5,7,8,.42) 0%,
          rgba(5,7,8,.30) 16%,
          rgba(5,7,8,.48) 34%,
          rgba(5,7,8,.72) 55%,
          rgba(5,7,8,.88) 74%,
          rgba(5,7,8,.95) 90%,
          var(--color-bg) 100%),
        linear-gradient(90deg, rgba(5,7,8,.38) 0%, rgba(5,7,8,.16) 40%, transparent 68%);
    }
    .hero-inner { width: calc(100% - 30px); }
    .hero-composition { gap: 0; }
    .poster-wrap { display: none; }
    .detail-title { font-size: clamp(1.5rem, 6.4vw, 2rem); }
    .meta-row { font-size: .7rem; gap: 6px; }
    .genre-line { font-size: .68rem; }
    .detail-desc { font-size: .78rem; }
    .primary-actions { max-width: 100%; }
    .play-btn { flex: 1 1 100%; min-height: 52px; }
    .download-btn { flex: 1 1 100%; min-height: 48px; }
    .secondary-btn { padding: 10px 14px; font-size: .72rem; }
    .hero-inner { padding-bottom: 14px; }
    .detail-body { padding-top: 0; }
    .overview-section { margin-top: 18px; }
    .cast-section { margin-top: 24px; }
    .recs-rail { margin-top: 24px; }
    .facts-grid { grid-template-columns: 1fr; gap: 10px; }
  }

  /* LANDSCAPE MOBILE — short viewport: keep the title + actions above
     the fold, never push content below the visible area. */
  @media (max-width: 1024px) and (orientation: landscape) and (max-height: 480px) {
    .hero { min-height: auto; height: auto; }
    .hero-inner { padding-top: clamp(44px, 10vh, 72px); padding-bottom: 12px; }
    .detail-title { font-size: clamp(1.3rem, 3vw, 1.8rem); }
    .detail-desc { -webkit-line-clamp: 1; line-clamp: 1; }
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

