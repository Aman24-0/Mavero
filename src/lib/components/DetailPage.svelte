<script lang="ts">
  import { onMount, tick, untrack } from 'svelte';
  import { page } from '$app/state';
  import { goto } from '$app/navigation';
  import { ArrowLeft, Heart, Play, Share2, Star, ListPlus, Film, Download, AlertCircle, LoaderCircle, AlertTriangle, Maximize, Minimize } from 'lucide-svelte';
  import SelectionSheet from '$components/SelectionSheet.svelte';
  import DownloadSheet from '$components/DownloadSheet.svelte';
  import type { ContentType } from '$data/content';
  import { getMedia, type MediaItem } from '$data/content';
  import SkeletonCard from '$components/SkeletonCard.svelte';
  import { getCachedRail, setCachedRail } from '$lib/client/discover/rail-cache';
  import { markPlayerMilestone } from '$lib/client/player/player-timing';
  import SeasonEpisodes from '$components/SeasonEpisodes.svelte';
  import { getFavoriteStatus, getLocalProgressRecords, removeFavoriteFromMyList, setFavoriteStatus } from '$lib/client/progress/service';
  import type { WatchlistStatus } from '$lib/client/progress/types';
  import { getLatestResumeTarget } from '$lib/client/progress/presenter';
  import { deleteCloudFavorite, syncAuthenticatedState } from '$lib/client/progress/cloud';
  import { appendReturnTo, navigateBackOr } from '$lib/shared/navigation';
  import { haptic } from '$lib/client/haptics';
  import { showSuccessToast, showErrorToast } from '$lib/client/toast.svelte';
  import type { PublicDownloadProvider, DownloadMediaType } from '$lib/shared/downloader';
  import { filterProvidersByMediaType } from '$lib/shared/downloader';
  // MAV-22 — Detail Page 3.0 dynamic artwork palette (scoped to this page).
  import { DetailPaletteController, buildPaletteStyle, type DetailPalette } from '$lib/client/detail/palette';

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
  // MAV-23 Fix 4 — INLINE trailer playback inside the cinematic backdrop.
  // The trailer plays in the hero artwork area using the SAME YouTube
  // embed source contract as the former modal (no new provider, no new
  // stream, no untrusted fetch). The secondary "Trailer" button toggles
  // playback; while active its label reads "Trailer Off" and an adjacent
  // accessible Fullscreen control appears. Stopping unmounts the iframe,
  // which releases the media element, its network fetches and listeners.
  let trailerActive = $state(false);
  let trailerStatus = $state<'loading' | 'ready' | 'error'>('loading');
  // Retry remounts a FRESH iframe ({#key trailerAttempt}) — no stale media.
  let trailerAttempt = $state(0);
  let trailerContainer = $state<HTMLDivElement | null>(null);
  let trailerFullscreen = $state(false);
  let trailerToggle: HTMLElement | null = null;
  let trailerLoadTimer: ReturnType<typeof setTimeout> | undefined = undefined;
  // YouTube does not surface embed playback errors to the parent page
  // without its IFrame API, so a bounded load timeout is the honest
  // error signal: if the frame never loads, the error state renders.
  const TRAILER_LOAD_TIMEOUT_MS = 12000;

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
  // MAV-22 — the hero content-type label uses the approved vocabulary:
  // Movie / TV Series / Anime Movie / Anime Series (the card-level
  // formatBadges vocabulary is unchanged for rails).
  const contentTypeLabel = $derived.by(() => {
    if (item.isAnime) {
      const format = item.animeFormat ?? (type === 'movie' ? 'movie' : 'series');
      return format === 'movie' ? 'Anime Movie' : 'Anime Series';
    }
    if (type === 'movie') return 'Movie';
    if (type === 'anime') return 'Anime';
    return 'TV Series';
  });
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
  // renders the rail instantly. MAV-22: the load is re-run when the
  // displayed title changes (client-side detail → detail navigation).
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
  // MAV-21 Workstream F — Cinematic hero derived state (preserved).
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

  // Compact genre presentation for the first viewport: at most 4 genre
  // chips on bounded rows; the FULL list lives in the Overview facts
  // (never let a long genre list dominate the hero).
  const MAX_HERO_GENRES = 4;
  const heroGenres = $derived(item.genres.slice(0, MAX_HERO_GENRES));
  const heroGenreOverflow = $derived(Math.max(0, item.genres.length - MAX_HERO_GENRES));

  // MAV-24 Issue 3 — provider availability moved OUT of the hero into the
  // More Details grid (the hero action area must stay compact). The same
  // genuine-metadata contract as the former hero strip: only providers the
  // metadata actually supplies, and a missing/empty list renders NO field
  // (no invented availability). Every provider renders — the grid cell is
  // a wrapping flex container, so multiple providers can never overflow;
  // the former 3-logo cap and "+N" overflow count were hero-space
  // constraints that no longer apply inside the details grid.
  const detailProviders = $derived((item.streamingProviders ?? []).filter((provider) => provider.name?.trim()));
  const providerFieldLabel = $derived(detailProviders.length > 1 ? 'Streaming Providers' : 'Streaming Provider');

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

  // ============================================================
  // MAV-22 — More Details rows with the STRICT hero-dedup contract.
  //
  // The hero shows: rating, concise year, certification, and for
  // movie-like titles the runtime / for series-like titles the season
  // (or episode) count. More Details therefore shows ONLY facts the
  // hero does NOT: the full release date, director/creators, the
  // original language, and the episode count the hero's season count
  // leaves out. No fact ever appears in both places.
  // Missing metadata renders NO row (no empty labels, no misleading
  // zeros, no fabricated certifications).
  // ============================================================
  const factRows = $derived.by(() => {
    const rows: Array<{ label: string; value: string }> = [];
    if (item.releaseDate) rows.push({ label: isSeriesLike ? 'First aired' : 'Release date', value: formatDate(item.releaseDate) });
    if (!isSeriesLike && item.director) rows.push({ label: 'Director', value: item.director });
    if (isSeriesLike && item.creators?.length) rows.push({ label: 'Creators', value: item.creators.join(', ') });
    const language = languageName(item.originalLanguage);
    if (language) rows.push({ label: 'Original language', value: language });
    // Series counts: the hero shows "N seasons" when seasons exist
    // (else episodes) — More Details completes the OTHER count only.
    if (isSeriesLike && item.seasons && item.episodes) rows.push({ label: 'Episodes', value: String(item.episodes) });
    return rows;
  });

  // ============================================================
  // MAV-22 — Dynamic artwork palette (scoped to this page).
  //
  // The page background is derived from the CURRENT title's artwork —
  // never the fixed global background, never the global green accent.
  // Extraction is async and non-blocking: the page renders with the
  // neutral cinematic fallback and the artwork palette fades in when
  // ready. The controller discards stale extractions on rapid
  // navigation, and results are cached by the artwork URL.
  // ============================================================
  let palette = $state<DetailPalette | null>(null);
  const paletteStyle = $derived(palette ? buildPaletteStyle(palette) : '');
  const paletteController = new DetailPaletteController((next) => {
    palette = next;
  });
  // Extraction source preference: backdrop first, poster as the
  // fallback (the small variants keep the download bounded — the sampler
  // downscales to a tiny canvas anyway).
  const paletteSource = $derived(item.backdropSmall || item.backdrop || item.posterSmall || item.poster || '');

  // Poster card failure state (deliberate fallback — never a broken
  // image icon inside the overlap composition).
  let posterFailed = $state(false);
  const posterSrc = $derived(item.posterSmall || item.poster || '');

  // MAV-22 — title-scoped reactivity: client-side navigation between two
  // detail pages (rec rail, browser back) must refresh EVERYTHING that
  // belongs to the displayed title: watch progress/watchlist state,
  // recommendations, the artwork palette, and the artwork failure
  // states. The effects track the current item so each load re-runs and
  // late responses for a previous title are discarded by sequence.
  let progressSequence = 0;
  async function loadProgressState() {
    const sequence = ++progressSequence;
    const status = await getFavoriteStatus(type, item.id);
    const progress = await getLocalProgressRecords();
    if (sequence !== progressSequence) return;
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
  }

  $effect(() => {
    // Tracks the displayed title (+ its anime format — the series-like
    // predicate depends on it) and reloads the progress state.
    void item.id;
    void type;
    void isSeriesLike;
    void loadProgressState();
  });

  $effect(() => {
    // Tracks the artwork URLs; failed artwork never poisons the next
    // title (the failure flags reset with every source change).
    void heroArtwork;
    void posterSrc;
    heroArtworkFailed = false;
    posterFailed = false;
    // MAV-23 Fix 4 — stale-playback guard: navigating to another title
    // must never keep the previous title's trailer playing. Stopping
    // unmounts the iframe (media + listeners released with the DOM node).
    // untrack() is REQUIRED: the playback state must NOT become a
    // dependency of this effect, or the stop itself would re-trigger the
    // effect and immediately undo a fresh start.
    untrack(() => {
      if (trailerActive) stopTrailer();
    });
  });

  $effect(() => {
    // Palette: request extraction for the CURRENT artwork; the
    // controller discards stale results (rapid navigation) and applies
    // cached palettes synchronously.
    const source = paletteSource;
    paletteController.request(source);
  });

  async function loadRecommendations(forId: string) {
    const url = `/api/content/recommendations/${type}/${encodeURIComponent(forId)}`;
    const cached = getCachedRail<MediaItem>(url, page.data.user?.id);
    if (cached) {
      clientRecommendations = cached.items;
      recommendationState = 'ready';
      return;
    }
    try {
      const response = await fetch(url);
      const payload = await response.json();
      if (forId !== item.id) return; // superseded by a newer title
      if (!response.ok || !payload.ok) throw new Error('unavailable');
      clientRecommendations = (payload.recommendations ?? []) as MediaItem[];
      recommendationState = 'ready';
      setCachedRail(url, page.data.user?.id, clientRecommendations, clientRecommendations.length > 0);
    } catch {
      if (forId !== item.id) return;
      recommendationState = 'failed';
    }
  }

  $effect(() => {
    // Tracks the displayed title; the rail resets + reloads with it.
    const forId = item.id;
    clientRecommendations = [];
    recommendationState = 'loading';
    void loadRecommendations(forId);
  });

  onMount(() => {
    let active = true;
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
      // MAV-22 — palette teardown: no in-flight extraction may outlive
      // the page (nothing can mutate another route's state).
      paletteController.dispose();
      // MAV-23 Fix 4 — teardown: no iframe media, load timer or
      // fullscreen state may outlive the page (client-side navigation
      // away during playback must leave nothing running).
      clearTrailerLoadTimeout();
      if (trailerActive && typeof document !== 'undefined' && document.fullscreenElement) {
        void document.exitFullscreen().catch(() => {});
      }
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

  // ============================================================
  // MAV-23 Fix 4 — inline trailer lifecycle.
  //
  //   openTrailer()  — user-initiated start: mounts ONE iframe in the
  //                    hero, arms the load timeout, moves focus to the
  //                    adjacent fullscreen control (keyboard reachable).
  //   stopTrailer()  — Trailer Off: unmounts the iframe (playback stops,
  //                    media/listeners released), exits fullscreen if the
  //                    user fullscreened the player, restores focus.
  //   Fullscreen     — Fullscreen API on the player container, guarded by
  //                    try/catch; landscape orientation lock is attempted
  //                    ONLY after a user-initiated fullscreen entry AND
  //                    only where the API exists (Android/Chromium).
  //                    Unsupported platforms keep inline playback — the
  //                    limitation is documented, never faked.
  // ============================================================
  function openTrailer() {
    if (!hasTrailer || trailerActive) return;
    trailerToggle = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    trailerActive = true;
    trailerStatus = 'loading';
    trailerAttempt += 1;
    armTrailerLoadTimeout();
    haptic('light');
    void tick().then(() => trailerContainer?.querySelector<HTMLElement>('.trailer-fs-btn')?.focus());
  }

  function stopTrailer() {
    if (!trailerActive) return;
    clearTrailerLoadTimeout();
    if (trailerFullscreen) void exitTrailerFullscreen();
    trailerActive = false;
    trailerStatus = 'loading';
    // Focus returns to the toggle (it is the same button — label flips
    // back to "Trailer").
    trailerToggle?.focus();
    trailerToggle = null;
  }

  function armTrailerLoadTimeout() {
    clearTrailerLoadTimeout();
    trailerLoadTimer = setTimeout(() => {
      if (trailerActive && trailerStatus === 'loading') trailerStatus = 'error';
    }, TRAILER_LOAD_TIMEOUT_MS);
  }

  function clearTrailerLoadTimeout() {
    if (trailerLoadTimer) {
      clearTimeout(trailerLoadTimer);
      trailerLoadTimer = undefined;
    }
  }

  function retryTrailer() {
    if (!hasTrailer) return;
    trailerStatus = 'loading';
    trailerAttempt += 1;
    armTrailerLoadTimeout();
  }

  async function enterTrailerFullscreen() {
    const el = trailerContainer;
    if (!el || !trailerActive) return;
    haptic('light');
    try {
      if (el.requestFullscreen) {
        await el.requestFullscreen({ navigationUI: 'hide' });
      } else if ('webkitRequestFullscreen' in el) {
        // Older WebKit fallback — best-effort, guarded below.
        (el as HTMLElement & { webkitRequestFullscreen: () => void }).webkitRequestFullscreen();
      }
    } catch {
      /* Fullscreen unsupported or refused — inline playback continues
         (documented limitation: e.g. iOS Safari on non-video elements). */
    }
    // Landscape lock: Chromium/Android only, valid ONLY inside
    // fullscreen and ONLY from this user-initiated handler. Any
    // unsupported/refused case silently keeps the current orientation.
    try {
      const orientation = screen.orientation as (ScreenOrientation & { lock?: (orientation: string) => Promise<void> }) | undefined;
      if (orientation?.lock && document.fullscreenElement) {
        await orientation.lock('landscape');
      }
    } catch {
      /* Orientation lock unsupported (e.g. iOS Safari) — playback
         continues in the current orientation (documented limitation). */
    }
  }

  async function exitTrailerFullscreen() {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
    } catch { /* already exiting */ }
    try {
      (screen.orientation as (ScreenOrientation & { unlock?: () => void }) | undefined)?.unlock?.();
    } catch { /* unsupported — nothing to unlock */ }
  }

  // System UI can exit fullscreen on its own (back gesture, notification);
  // the player then simply returns to the inline layout — state and scroll
  // position are untouched because fullscreen never scrolls the page.
  function handleFullscreenChange() {
    trailerFullscreen = trailerActive && document.fullscreenElement === trailerContainer;
  }

  function handleTrailerKeydown(event: KeyboardEvent) {
    if (!trailerActive) return;
    // Escape stops the inline trailer — EXCEPT while fullscreen, where
    // the browser itself consumes Escape to exit fullscreen (and the
    // trailer keeps playing, matching platform convention).
    if (event.key === 'Escape' && !document.fullscreenElement) {
      event.preventDefault();
      stopTrailer();
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
<svelte:document onfullscreenchange={handleFullscreenChange} />

<!-- ============================================================
     MAV-22 — CINEMATIC DETAIL PAGE 3.0.

     Composition (the approved overlap layout):
       • palette-canvas — the artwork-derived page backdrop (a page-wide
         gradient that flows from the derived deep tone into the global
         base; never a hard black rectangle).
       • hero — the full-bleed cinematic artwork (backdrop, poster as
         the graceful fallback) with a readability scrim.
       • hero-body — the poster card OVERLAPS the lower portion of the
         artwork (negative margin), with the title + compact metadata
         BESIDE it on every surface. Genre chips and the action
         hierarchy complete the hero (MAV-24: the hero synopsis preview
         was REMOVED — the Overview section owns the synopsis; the
         provider indicator lives in the More Details grid).
       • detail-body — Overview (the full synopsis with Show More),
         More Details (two-column grid incl. the streaming-provider
         field), Cast (rectangular portrait cards), Seasons &
         Episodes, You May Also Like.

     All hero data is SSR; recommendations load progressively
     client-side. The palette is async and non-blocking.
     ============================================================ -->
<div class="detail-page" style={paletteStyle}>
  <!-- Artwork-derived backdrop layer (fades in when the palette lands;
       the CSS fallback values are the neutral cinematic slate). -->
  <div class="palette-canvas" class:active={paletteStyle !== ''} aria-hidden="true"></div>

  <header class="hero">
    {#if trailerActive && hasTrailer}
      <!-- MAV-23 Fix 4 — INLINE trailer: plays INSIDE the cinematic
           backdrop area. The poster-overlap composition, title metadata
           and actions below are untouched; stopping restores the artwork
           backdrop exactly. The iframe uses the existing trailer source
           contract (item.trailerKey → YouTube embed). -->
      <div class="trailer-inline" bind:this={trailerContainer}>
        {#if trailerStatus !== 'error'}
          {#key trailerAttempt}
            <iframe
              src={`https://www.youtube.com/embed/${trailerKey}?autoplay=1&rel=0`}
              title={`${item.title} trailer`}
              allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; fullscreen"
              allowfullscreen
              onload={() => { clearTrailerLoadTimeout(); trailerStatus = 'ready'; }}
              onerror={() => { clearTrailerLoadTimeout(); trailerStatus = 'error'; }}
            ></iframe>
          {/key}
        {/if}
        {#if trailerStatus === 'loading'}
          <div class="trailer-inline-note" role="status" aria-live="polite">
            <LoaderCircle size={22} class="trailer-spinner" />
            <span>Loading trailer…</span>
          </div>
        {:else if trailerStatus === 'error'}
          <div class="trailer-inline-note trailer-inline-error" role="alert">
            <AlertTriangle size={22} />
            <span>Trailer is unavailable right now.</span>
            <button type="button" class="trailer-inline-retry" onclick={retryTrailer}>Retry</button>
          </div>
        {/if}
      </div>
    {:else}
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
    {/if}
    <button class="back-btn" type="button" onclick={goBack} aria-label="Go back">
      <ArrowLeft size={16} /> <span>Back</span>
    </button>
  </header>

  <!-- Poster-overlap body: pulled up over the artwork's lower portion.
       The poster card + the title/compact-metadata block sit side by
       side; genre chips and the action hierarchy complete the hero
       block. MAV-24: no synopsis here (Overview owns it below) and no
       provider strip here (More Details owns it below). -->
  <div class="hero-body">
    <div class="hero-grid">
      {#if posterSrc && !posterFailed}
        <div class="poster-card">
          <img src={posterSrc} alt={`${item.title} poster`} class="poster-img" width="300" height="450" loading="eager" decoding="async" onerror={() => (posterFailed = true)} />
        </div>
      {:else}
        <!-- Deliberate fallback when poster artwork is missing/failed. -->
        <div class="poster-card poster-card-fallback" role="img" aria-label={`${item.title} poster unavailable`}>
          <span aria-hidden="true">{item.title.slice(0, 1).toUpperCase()}</span>
        </div>
      {/if}

      <section class="hero-info">
        <div class="detail-eyebrow">{contentTypeLabel}</div>
        <h1 class="detail-title">{item.title}</h1>

        <div class="meta-row">
          {#if item.rating > 0}
            <span class="rating"><Star size={12} fill="currentColor" strokeWidth={0} /> {item.rating.toFixed(1)}</span>
          {/if}
          {#if item.year > 0}
            <span class="dot"></span><span>{item.year}</span>
          {/if}
          {#if !isSeriesLike && item.runtime}
            <span class="dot"></span><span>{item.runtime}</span>
          {:else if isSeriesLike && item.seasons}
            <span class="dot"></span><span>{item.seasons} season{item.seasons === 1 ? '' : 's'}</span>
          {:else if isSeriesLike && item.episodes}
            <span class="dot"></span><span>{item.episodes} episode{item.episodes === 1 ? '' : 's'}</span>
          {/if}
          {#if item.maturity}<span class="dot"></span><span class="maturity">{item.maturity}</span>{/if}
        </div>
      </section>

      <div class="hero-lower">
        {#if heroGenres.length}
          <div class="genre-chips">
            {#each heroGenres as genre (genre)}<span class="genre-chip">{genre}</span>{/each}
            {#if heroGenreOverflow > 0} <span class="genre-more">+{heroGenreOverflow} more</span>{/if}
          </div>
        {/if}

        <!-- MAV-24 Issue 1 — the hero synopsis preview is REMOVED: the
             Overview section below the hero carries the full expandable
             synopsis (Show More), so a second truncated copy here only
             consumed first-viewport space. -->

        <!-- Action hierarchy: the dominant main action first, the
             approved secondary row immediately beneath it. -->
        <div class="actions">
          <div class="primary-actions">
            <a class="play-btn" href={watchHref} aria-label={playSubLabel ? `${playLabel} — season ${resumeEpisode?.season}, episode ${resumeEpisode?.episode}` : `${playLabel} ${item.title}`} onclick={() => markPlayerMilestone('mavero:play')}>
              <Play size={17} fill="currentColor" strokeWidth={0} />
              <span class="play-copy">
                <span class="play-label">{playLabel}</span>
                {#if playSubLabel}<span class="play-sub">{playSubLabel}</span>{/if}
              </span>
            </a>
            {#if showDownloadButton}
              <!-- MAV-24 Issue 2 — icon-only Download (the visible text
                   was unnecessary; the accessible name carries the
                   semantics). Same click behavior, one aligned primary
                   row with Play. -->
              <button class="download-btn" type="button" onclick={openDownloadSheet} aria-haspopup="dialog" aria-expanded={downloadSheetOpen} aria-label={`Download ${item.title}`}>
                <Download size={18} aria-hidden="true" />
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
              <!-- MAV-23 Fix 4 — the toggle doubles as Trailer / Trailer
                   Off. aria-pressed communicates the playing state; the
                   adjacent fullscreen control appears only while active. -->
              <button
                class="secondary-btn trailer-toggle"
                class:engaged={trailerActive}
                aria-pressed={trailerActive}
                onclick={() => (trailerActive ? stopTrailer() : openTrailer())}
              >
                <Film size={15} /><span>{trailerActive ? 'Trailer Off' : 'Trailer'}</span>
              </button>
              {#if trailerActive}
                <!-- MAV-24 Issue 2 — icon-only fullscreen control beside
                    Trailer Off (the word "Fullscreen" was unnecessary and
                    its width pushed the control onto its own wrapped row).
                    Placement note: the PREFERRED spot (bottom-left, over
                    the player) is not reliably possible here — the YouTube
                    iframe owns that corner (its play/pause + volume bar),
                    and a parent-page overlay is a cross-origin boundary we
                    cannot integrate with, so it would obscure YouTube's
                    own essential controls. The spec's sanctioned fallback
                    is this spot, immediately beside Trailer Off. The
                    button toggles fullscreen and announces its state. -->
                <button
                  class="secondary-btn trailer-fs-btn"
                  onclick={() => (trailerFullscreen ? exitTrailerFullscreen() : enterTrailerFullscreen())}
                  aria-pressed={trailerFullscreen}
                  aria-label={trailerFullscreen ? 'Exit trailer fullscreen' : 'Show trailer fullscreen'}
                >
                  {#if trailerFullscreen}<Minimize size={15} aria-hidden="true" />{:else}<Maximize size={15} aria-hidden="true" />{/if}
                </button>
              {/if}
            {/if}
          </div>
          {#if saveError}<div class="save-error" role="status">{saveError}</div>{/if}
        </div>

        <!-- MAV-24 Issue 3 — the hero provider strip is REMOVED: the same
             provider information renders as a labelled field inside the
             More Details grid below (see the details-section), so the
             hero action area stays compact. -->
      </div>
    </div>
  </div>

  <!-- ============================================================
       BELOW THE FOLD — Overview / More Details / Cast / Seasons &
       Episodes / You May Also Like. The palette canvas keeps flowing
       behind these sections (tinted → global base) — no hard rectangle
       edge under the hero.
       ============================================================ -->
  <div class="detail-body">
    <!-- Overview: the expandable FULL synopsis. The hero carries only a
         short CSS-clamped preview — never a duplicate truncated copy of
         the same text in a second section. -->
    {#if item.description}
      <section class="overview-section" aria-labelledby="overview-heading">
        <h2 class="section-h" id="overview-heading">Overview</h2>
        <p class="overview-text" class:expanded={overviewExpanded}>{item.description}</p>
        {#if hasLongOverview}
          <button class="show-more" type="button" onclick={() => (overviewExpanded = !overviewExpanded)} aria-expanded={overviewExpanded}>
            {overviewExpanded ? 'Show Less' : 'Show More'}
          </button>
        {/if}
      </section>
    {/if}

    <!-- MAV-22 — More Details: the responsive information grid
         (two columns on mobile, expanding on larger screens). Every row
         is presence-gated and hero-deduplicated (see factRows).
         MAV-24 Issue 3: the streaming-provider field renders here as the
         FIRST grid field (labelled, logo + name per provider, wrapping —
         never overflowing), gated on genuine data. The section itself
         renders when EITHER the fact rows OR the provider field has
         content. -->
    {#if factRows.length || detailProviders.length}
      <section class="details-section" aria-labelledby="details-heading">
        <h2 class="section-h" id="details-heading">More Details</h2>
        <dl class="details-grid">
          {#if detailProviders.length}
            <div class="fact-row fact-row-providers">
              <dt class="fact-label">{providerFieldLabel}</dt>
              <dd class="fact-value">
                <span class="provider-list">
                  {#each detailProviders as provider (provider.id)}
                    <span class="provider-chip">
                      {#if provider.logo}
                        <img src={provider.logo} alt="" class="provider-logo" width="20" height="20" loading="lazy" decoding="async" />
                      {:else}
                        <span class="provider-logo provider-logo-fallback" aria-hidden="true">{provider.name.slice(0, 1)}</span>
                      {/if}
                      <span class="provider-chip-name">{provider.name}</span>
                    </span>
                  {/each}
                </span>
              </dd>
            </div>
          {/if}
          {#each factRows as fact (fact.label)}
            <div class="fact-row">
              <dt class="fact-label">{fact.label}</dt>
              <dd class="fact-value">{fact.value}</dd>
            </div>
          {/each}
        </dl>
      </section>
    {/if}

    <!-- MAV-22 — Cast: rectangular portrait cards (2:3), consistent
         width, horizontal scroll rail, graceful initial fallback.
         Director/creators live in More Details — never mixed in here. -->
    {#if castMembers.length}
      <section class="cast-section" aria-labelledby="cast-heading">
        <h2 class="section-h" id="cast-heading">Cast</h2>
        <div class="cast-rail" role="list">
          {#each castMembers as member}
            <div class="cast-card" role="listitem">
              {#if member.photo}
                <img src={member.photo} alt={member.name} class="cast-photo" loading="lazy" decoding="async" width="200" height="300" />
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

    <!-- MAV-22 — You May Also Like: portrait recommendation cards with
         stable dimensions (poster, title, year, rating). Loaded
         client-side (skeleton while loading, hidden when empty/failed;
         never fixture-filled). -->
    {#if recommendations.length}
      <section class="recs-section" aria-labelledby="recs-heading">
        <h2 class="section-h" id="recs-heading">You may also like</h2>
        <div class="recs-row" role="list">
          {#each recommendations as rec (rec.id)}
            <div class="rec-slot" role="listitem">
              <a class="rec-card" href={appendReturnTo(`/${rec.type}/${rec.id}`, `${page.url.pathname}${page.url.search}`)} aria-label={`${rec.title}${rec.year > 0 ? ` (${rec.year})` : ''}`}>
                <span class="rec-poster">
                  {#if rec.poster}
                    <img src={rec.posterSmall || rec.poster} alt="" class="rec-img" width="200" height="300" loading="lazy" decoding="async" />
                  {:else}
                    <span class="rec-img rec-poster-fallback" aria-hidden="true">{rec.title.slice(0, 1).toUpperCase()}</span>
                  {/if}
                </span>
                <span class="rec-title">{rec.title}</span>
                <span class="rec-meta">
                  {#if rec.year > 0}<span>{rec.year}</span>{/if}
                  {#if rec.rating > 0}<span class="rec-rating"><Star size={10} fill="currentColor" strokeWidth={0} /> {rec.rating.toFixed(1)}</span>{/if}
                </span>
              </a>
            </div>
          {/each}
        </div>
      </section>
    {:else if recommendationState === 'loading'}
      <div class="recs-section" aria-busy="true" aria-live="polite">
        <h2 class="section-h" id="recs-heading-loading">You may also like</h2>
        <div class="recs-row">
          {#each Array(6) as _, i (i)}<div class="rec-skeleton"><SkeletonCard /></div>{/each}
        </div>
      </div>
    {/if}
  </div>

  <SelectionSheet open={statusSheetOpen} eyebrow="MAVERO / My List" title="Add to My List" options={statusSheetOptions} selected={watchlistStatus ?? ''} onClose={closeStatusSheet} onSelect={chooseStatus} />
</div>

<!-- MAV-23 Fix 5 — the download sheet receives the ACTIVE title palette
     (the same inline --dp-* custom-property string the page root uses).
     The sheet applies it scoped to its own layer; closing the sheet or
     navigating to another title updates/discards it automatically. -->
<DownloadSheet
  open={downloadSheetOpen}
  paletteStyle={paletteStyle}
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
     MAV-22 — CINEMATIC DETAIL PAGE 3.0
     -----------------------------------------------------------------
     The approved overlap composition:
       • palette-canvas: an artwork-derived page-wide gradient that
         flows from the derived deep tone into the global base — the
         page NEVER sits on a fixed black background or the global
         green accent. CSS var() defaults = the neutral cinematic
         slate (missing artwork / extraction failure / SSR).
       • hero: full-bleed artwork + readability scrim; its bottom fades
         INTO the palette deep tone (no hard rectangle edge).
       • hero-body: the poster card overlaps the artwork (negative
         margin) with the title + compact metadata BESIDE it; genre
         chips, the 2-line synopsis, the dominant action, the approved
         secondary row and the compact provider strip complete it.
       • detail-body: Overview / More Details (2-col grid) / rectangular
         Cast cards / Seasons / You May Also Like — all on the flowing
         palette backdrop.
     All --dp-* tokens are scoped to .detail-page (inline style) — no
     global theme mutation, no leakage into other routes.
     ============================================================ */

  .detail-page {
    /* Palette custom properties — neutral cinematic slate defaults.
       The inline paletteStyle (when a palette lands) overrides them. */
    --dp-deep: hsl(210, 16%, 7%);
    --dp-deep-alt: hsl(210, 18%, 11%);
    --dp-fade-mid: rgb(5, 8, 10);
    --dp-surface: hsla(210, 16%, 32%, 0.1);
    --dp-accent: hsl(210, 30%, 60%);
    --dp-accent-soft: hsla(210, 30%, 60%, 0.12);
    --dp-accent-border: hsla(210, 30%, 62%, 0.3);
    --dp-glow: hsla(210, 30%, 55%, 0.22);
    --dp-scrim: hsla(210, 14%, 4%, 0.55);

    position: relative;
    isolation: isolate;
    overflow-x: clip;
    /* The flowing page backdrop: derived deep tone → global base.
       Pixel stops anchor the tinted band to the hero/overlap zone and
       HOLD the palette-derived tone through the Cast / Episodes region
       (MAV-23 Fix 2 — the MAV-22 1500px stop faded to near-black exactly
       below the Cast row). The final stop is a percentage so the tail
       ALWAYS lands on the app background at the page end, whatever the
       page height. */
    background: linear-gradient(180deg,
      var(--dp-deep-alt) 0px,
      var(--dp-deep) 420px,
      var(--dp-deep) 900px,
      var(--dp-fade-mid) 2100px,
      #050708 100%);
    /* MAV-23 Fix 6 — reduced page bottom padding (was clamp(72px, 8vw,
       110px)); the safe-area inset below covers system chrome. */
    padding-bottom: clamp(36px, 5vw, 72px);
  }

  /* Cross-fade layer: transparent until the artwork palette arrives,
     then fades in over the neutral default (a subtle color transition,
     no flash; disabled under prefers-reduced-motion). */
  .palette-canvas {
    position: absolute; inset: 0; z-index: 0;
    pointer-events: none;
    background: linear-gradient(180deg,
      var(--dp-deep-alt) 0px,
      var(--dp-deep) 420px,
      var(--dp-deep) 900px,
      var(--dp-fade-mid) 2100px,
      #050708 100%);
    opacity: 0;
    transition: opacity 480ms var(--ease-out);
  }
  .palette-canvas.active { opacity: 1; }

  /* ---- Hero backdrop ---- */
  .hero {
    position: relative;
    z-index: 1;
    width: 100%;
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
  /* Scrim — cinematic gradients: a readable top (back button), a clear
     band for the artwork, and a bottom fade that lands EXACTLY on the
     palette deep tone, so the artwork flows into the page backdrop. */
  .hero-scrim {
    position: absolute; inset: 0; z-index: 1; pointer-events: none;
    background:
      linear-gradient(180deg, rgba(4,6,7,.6) 0%, rgba(4,6,7,.16) 22%, rgba(4,6,7,.14) 42%, rgba(5,8,10,.6) 70%, var(--dp-deep) 100%),
      linear-gradient(90deg, rgba(4,6,7,.5) 0%, rgba(4,6,7,.16) 36%, transparent 64%);
  }

  /* Back button — floats over the hero top-left, with safe-area. */
  .back-btn {
    position: absolute; top: calc(14px + env(safe-area-inset-top));
    left: clamp(14px, 3vw, 32px); z-index: 6;
    display: inline-flex; align-items: center; gap: 6px;
    min-height: 36px; padding: 0 14px;
    border: 1px solid rgba(255,255,255,.16); border-radius: 999px;
    color: var(--color-text); background: rgba(5,7,8,.62); backdrop-filter: blur(10px);
    font: inherit; font-size: .72rem; font-weight: 700;
    cursor: pointer;
    transition: background var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out), transform var(--motion-fast) var(--ease-out);
  }
  .back-btn:hover { background: rgba(5,7,8,.78); border-color: var(--dp-accent-border); }
  .back-btn:active { transform: scale(.97); }
  .back-btn:focus-visible { outline: 2px solid var(--dp-accent); outline-offset: 2px; }

  /* ---- Poster-overlap body ----
     Pulled up over the artwork's lower portion: the poster card (and
     the metadata block beside it) overlaps the cinematic backdrop on
     EVERY surface — mobile included. */
  .hero-body {
    position: relative; z-index: 3;
    width: min(1500px, calc(100% - clamp(24px, 4vw, 96px)));
    margin-inline: auto;
    margin-top: calc(-1 * clamp(96px, 20vw, 150px));
  }
  .hero-grid {
    display: grid;
    grid-template-columns: clamp(100px, 27vw, 132px) minmax(0, 1fr);
    column-gap: clamp(12px, 3vw, 18px);
    row-gap: 12px;
    align-items: end;
  }

  /* Poster card — a distinct portrait card with depth, subtle border
     and shadow; 2:3 aspect reserved (no layout shift). */
  .poster-card {
    grid-column: 1;
    grid-row: 1;
    position: relative;
    aspect-ratio: 2 / 3;
    width: 100%;
    border-radius: 14px;
    overflow: hidden;
    border: 1px solid rgba(255,255,255,.12);
    background: var(--color-surface-elevated);
    box-shadow: 0 18px 44px rgba(0,0,0,.55), 0 4px 16px rgba(0,0,0,.45);
  }
  .poster-img {
    display: block; width: 100%; height: 100%;
    object-fit: cover;
  }
  .poster-card-fallback {
    display: grid; place-items: center;
  }
  .poster-card-fallback span {
    color: var(--dp-accent);
    font-size: clamp(1.6rem, 6vw, 2.2rem);
    font-weight: 800;
  }

  /* Identity block — beside the poster. */
  .hero-info {
    grid-column: 2;
    grid-row: 1;
    min-width: 0;
    padding-bottom: 2px;
  }
  .detail-eyebrow {
    color: var(--dp-accent);
    font-size: .6rem; font-weight: 800;
    letter-spacing: .16em; text-transform: uppercase;
    margin-bottom: 6px;
  }
  .detail-title {
    margin: 0;
    color: var(--color-text);
    font-size: clamp(1.28rem, 5.2vw, 1.7rem);
    font-weight: 900;
    letter-spacing: -.02em;
    line-height: 1.08;
    text-wrap: balance;
    text-shadow: 0 2px 16px rgba(0,0,0,.55);
    /* Deliberate clamp: a long title never pushes the actions out of
       the first viewport (spec: prioritize actions without clipping
       essential title information — 3 lines on touch, 2 on desktop). */
    display: -webkit-box; -webkit-box-orient: vertical;
    -webkit-line-clamp: 3; line-clamp: 3; overflow: hidden;
  }
  .meta-row {
    display: flex; flex-wrap: wrap; align-items: center;
    gap: 6px; margin-top: 8px;
    color: var(--color-text-muted);
    font-size: .72rem; font-weight: 600;
  }
  .meta-row .rating {
    display: inline-flex; align-items: center; gap: 3px;
    color: #ffc94d; font-weight: 800;
  }
  .maturity {
    border: 1px solid rgba(255,255,255,.18);
    border-radius: 5px;
    padding: 1px 6px;
    font-size: .62rem; font-weight: 800; letter-spacing: .03em;
  }
  .dot { width: 3px; height: 3px; border-radius: 50%; background: var(--color-text-deep); }

  /* Lower hero block — genre chips, synopsis preview, actions,
     provider strip (spans the full width beneath the poster row). */
  .hero-lower {
    grid-column: 1 / -1;
    grid-row: 2;
    min-width: 0;
  }
  .genre-chips {
    display: flex; flex-wrap: wrap; align-items: center;
    gap: 6px; margin-top: 2px;
  }
  .genre-chip {
    display: inline-flex; align-items: center;
    padding: 3px 10px;
    border: 1px solid var(--dp-accent-border);
    border-radius: 999px;
    background: var(--dp-accent-soft);
    color: var(--color-text);
    font-size: .62rem; font-weight: 700; letter-spacing: .02em;
    white-space: nowrap;
  }
  .genre-more { color: var(--color-text-deep); font-size: .62rem; font-weight: 600; }

  /* MAV-24 Issue 1 — the hero synopsis preview CSS is REMOVED with the
     markup: the Overview section below the hero owns the synopsis. */

  /* ---- Actions ----
     The main action is DOMINANT (largest target, bright surface that
     reads on EVERY palette); the approved secondary row sits beneath. */
  .actions {
    margin-top: 14px;
    display: flex; flex-direction: column; gap: 10px;
  }
  .primary-actions {
    display: flex; align-items: stretch; gap: 8px;
    width: 100%;
  }
  .play-btn {
    display: inline-flex; align-items: center; justify-content: center; gap: 10px;
    flex: 1 1 62%; min-height: 52px;
    padding: 12px 22px; border-radius: 999px;
    color: #050708; font-size: .9rem; font-weight: 800;
    text-decoration: none;
    background: var(--color-text);
    box-shadow: 0 6px 22px var(--dp-glow);
    transition: transform var(--motion-fast) var(--ease-out), box-shadow var(--motion-fast) var(--ease-out), filter var(--motion-fast) var(--ease-out);
  }
  .play-btn:hover { transform: translateY(-1px); filter: brightness(1.05); box-shadow: 0 8px 28px var(--dp-glow); }
  .play-btn:active { transform: scale(.98); }
  .play-btn:focus-visible { outline: 2px solid var(--dp-accent); outline-offset: 3px; }
  .play-copy { display: flex; flex-direction: column; align-items: flex-start; gap: 1px; min-width: 0; }
  .play-label { line-height: 1.1; }
  .play-sub {
    font-size: .62rem; font-weight: 700; letter-spacing: .05em;
    color: rgba(5,7,8,.72); line-height: 1.1;
  }
  /* MAV-24 Issue 2 — icon-only Download: a square target locked to the
     SAME 52px height as Play, so the primary row reads as one aligned
     bar (Play flexes, Download keeps a fixed icon square). */
  .download-btn {
    display: inline-flex; align-items: center; justify-content: center;
    flex: 0 0 auto; width: 52px; min-height: 52px;
    padding: 0; border-radius: 999px;
    border: 1px solid rgba(255,255,255,.16);
    color: var(--color-text); font-size: .86rem; font-weight: 800; cursor: pointer;
    background: rgba(255,255,255,.05); backdrop-filter: blur(6px);
    transition: transform var(--motion-fast) var(--ease-out), background var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out);
  }
  .download-btn:hover { transform: translateY(-1px); background: var(--dp-accent-soft); border-color: var(--dp-accent-border); }
  .download-btn:active { transform: scale(.98); }
  .download-btn:focus-visible { outline: 2px solid var(--dp-accent); outline-offset: 3px; }
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
    display: flex; flex-wrap: wrap; align-items: center;
    gap: 8px;
    width: 100%;
  }
  .secondary-btn {
    display: inline-flex; align-items: center; gap: 6px;
    min-height: 44px; padding: 10px 16px; border-radius: 999px;
    color: var(--color-text); font-size: .74rem; font-weight: 700;
    border: 1px solid rgba(255,255,255,.16);
    background: rgba(255,255,255,.05); cursor: pointer;
    transition: background var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out), transform var(--motion-fast) var(--ease-out);
  }
  .secondary-btn:hover { background: var(--dp-accent-soft); border-color: var(--dp-accent-border); }
  .secondary-btn:active { transform: scale(.97); }
  .secondary-btn:focus-visible { outline: 2px solid var(--dp-accent); outline-offset: 2px; }
  .save-error { margin-top: 4px; color: var(--color-warning); font-size: .66rem; text-align: center; }

  /* ---- Streaming-provider field (MAV-24 Issue 3) ----
     Renders INSIDE the More Details grid as a labelled field: one chip
     per provider (logo + name), wrapping safely so multiple providers
     can never overflow the grid cell. The same title-palette tokens as
     the rest of the page (--dp-* surfaces/borders/accent). Only genuine
     provider data renders (empty list → no field at all). */
  .provider-list {
    display: flex; flex-wrap: wrap; align-items: center;
    gap: 6px;
  }
  .provider-chip {
    display: inline-flex; align-items: center; gap: 6px;
    max-width: 100%;
    padding: 4px 10px 4px 5px;
    border: 1px solid var(--dp-accent-border);
    border-radius: 999px;
    background: var(--dp-surface);
  }
  .provider-logo {
    width: 20px; height: 20px; border-radius: 4px;
    object-fit: cover; flex: 0 0 auto;
    border: 1px solid rgba(255,255,255,.1);
    background: var(--color-surface-elevated);
  }
  .provider-logo-fallback {
    display: grid; place-items: center;
    color: var(--dp-accent);
    font-size: .6rem; font-weight: 800;
    background: var(--dp-accent-soft);
  }
  .provider-chip-name {
    color: var(--color-text); font-size: .72rem; font-weight: 700;
    overflow-wrap: anywhere;
  }

  /* ---- Below the fold ---- */
  .detail-body {
    position: relative; z-index: 2;
    width: min(1500px, calc(100% - clamp(24px, 4vw, 96px)));
    margin-inline: auto;
    padding-top: clamp(20px, 3.5vw, 40px);
  }

  .section-h {
    color: var(--color-text);
    font-size: clamp(1.02rem, 1.6vw, 1.28rem);
    font-weight: 800; letter-spacing: -.02em;
    margin: 0 0 14px;
    padding-bottom: 8px;
    border-bottom: 1px solid rgba(255,255,255,.07);
  }

  /* Overview — the full expandable synopsis ONLY (no fact rows: they
     live in More Details; no duplicate truncated hero copy). */
  .overview-section { margin-top: 0; }
  .overview-text {
    margin: 0;
    max-width: 760px;
    color: var(--color-text-muted); font-size: .86rem; line-height: 1.65;
    display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 4; line-clamp: 4; overflow: hidden;
  }
  .overview-text.expanded { -webkit-line-clamp: unset; line-clamp: unset; overflow: visible; }
  .show-more {
    display: inline-block; margin: 8px 0 0;
    padding: 4px 8px; border: 0; background: transparent;
    color: var(--dp-accent); font: inherit;
    font-size: .7rem; font-weight: 700; cursor: pointer;
    text-decoration: underline; text-underline-offset: 3px;
    transition: text-decoration-color var(--motion-fast) var(--ease-out);
  }
  .show-more:hover { color: var(--color-text); }
  .show-more:focus-visible { outline: 2px solid var(--dp-accent); outline-offset: 2px; border-radius: 4px; }

  /* MAV-22 — More Details: the responsive information grid.
     TWO columns on mobile (the approved change), expanding to three on
     desktop and four on large displays. Labels stay secondary; values
     wrap safely (long names, multilingual text). */
  .details-section { margin-top: clamp(24px, 3.5vw, 40px); }
  .details-grid {
    margin: 0;
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 14px 18px;
  }
  .fact-row { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .fact-label {
    color: var(--color-text-deep);
    font-size: .6rem; font-weight: 800; letter-spacing: .1em; text-transform: uppercase;
  }
  .fact-value {
    margin: 0;
    color: var(--color-text);
    font-size: .8rem; font-weight: 600; line-height: 1.45;
    overflow-wrap: anywhere;
  }

  /* MAV-22 — Cast: RECTANGULAR portrait cards (2:3), consistent width,
     horizontal rail, graceful initial fallback. */
  .cast-section { margin-top: clamp(24px, 3.5vw, 40px); }
  .cast-rail {
    display: flex; gap: 12px;
    overflow-x: auto; scroll-snap-type: x proximity;
    padding: 2px 0 10px;
    scrollbar-width: none; -webkit-overflow-scrolling: touch;
  }
  .cast-rail::-webkit-scrollbar { display: none; }
  .cast-card {
    flex: 0 0 clamp(108px, 26vw, 136px); min-width: 0; scroll-snap-align: start;
    display: flex; flex-direction: column; gap: 6px;
  }
  .cast-photo {
    width: 100%; height: auto;
    aspect-ratio: 2 / 3;
    border-radius: 12px; object-fit: cover; object-position: center 20%;
    border: 1px solid rgba(255,255,255,.08);
    background: var(--color-surface-elevated);
  }
  .cast-photo-fallback {
    display: grid; place-items: center;
    background: var(--dp-surface);
    border: 1px solid var(--dp-accent-border);
  }
  .cast-photo-fallback span {
    color: var(--dp-accent);
    font-size: 1.6rem; font-weight: 800;
  }
  .cast-name {
    color: var(--color-text); font-size: .72rem; font-weight: 700; line-height: 1.3;
    display: -webkit-box; -webkit-box-orient: vertical;
    -webkit-line-clamp: 2; line-clamp: 2; overflow: hidden;
  }
  .cast-character {
    color: var(--color-text-deep); font-size: .62rem;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }

  /* MAV-22 — You May Also Like: portrait recommendation cards with
     stable dimensions (poster 2:3, title, year, rating). */
  .recs-section { margin-top: clamp(24px, 3.5vw, 40px); }
  .recs-row {
    display: grid; grid-auto-flow: column;
    grid-auto-columns: clamp(128px, 34vw, 160px); gap: 14px;
    overflow-x: auto; scroll-snap-type: x proximity;
    padding: 2px 0 12px;
    scrollbar-width: none; -webkit-overflow-scrolling: touch;
  }
  .recs-row::-webkit-scrollbar { display: none; }
  .rec-slot { min-width: 0; scroll-snap-align: start; display: flex; }
  .rec-card {
    display: flex; flex-direction: column; gap: 6px;
    min-width: 0;
    text-decoration: none;
    border-radius: 12px;
  }
  .rec-card:focus-visible { outline: 2px solid var(--dp-accent); outline-offset: 3px; }
  .rec-poster {
    display: block; width: 100%;
    aspect-ratio: 2 / 3;
    border-radius: 12px; overflow: hidden;
    border: 1px solid rgba(255,255,255,.08);
    background: var(--color-surface-elevated);
    transition: transform var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out);
  }
  .rec-card:hover .rec-poster { transform: translateY(-3px); border-color: var(--dp-accent-border); }
  .rec-img {
    display: block; width: 100%; height: 100%;
    object-fit: cover;
  }
  .rec-poster-fallback {
    display: grid; place-items: center;
    color: var(--dp-accent);
    font-size: 1.5rem; font-weight: 800;
    background: var(--dp-surface);
  }
  .rec-title {
    color: var(--color-text); font-size: .74rem; font-weight: 700; line-height: 1.3;
    display: -webkit-box; -webkit-box-orient: vertical;
    -webkit-line-clamp: 2; line-clamp: 2; overflow: hidden;
  }
  .rec-meta {
    display: flex; align-items: center; gap: 6px;
    color: var(--color-text-deep); font-size: .64rem; font-weight: 600;
  }
  .rec-rating { display: inline-flex; align-items: center; gap: 2px; color: #ffc94d; font-weight: 700; }
  .rec-skeleton { min-width: 0; }

  /* === Inline trailer (MAV-23 Fix 4) ===
     Plays INSIDE the hero backdrop area. The hero keeps its full size;
     the player fills it (letterboxed by the provider), the loading and
     error states sit above it, and the back button stays reachable. */
  .trailer-inline {
    position: absolute; inset: 0; z-index: 2;
    background: #000;
  }
  .trailer-inline iframe {
    position: absolute; inset: 0;
    width: 100%; height: 100%;
    border: 0;
  }
  /* Fullscreen: the container itself becomes the screen. */
  .trailer-inline:fullscreen { position: fixed; width: 100%; height: 100%; }
  .trailer-inline-note {
    position: absolute; inset: 0; z-index: 1;
    display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px;
    padding: 16px; text-align: center;
    color: var(--color-text);
    background: rgba(5, 7, 8, 0.72);
    font-size: 0.8rem; font-weight: 600;
  }
  .trailer-inline-note :global(svg) { color: var(--dp-accent); }
  /* The spinner class passes through the lucide component boundary —
     scope it globally (Svelte cannot see the forwarded class). */
  .trailer-inline-note :global(.trailer-spinner) { animation: spin 1s linear infinite; }
  .trailer-inline-error span { color: var(--color-text-muted); }
  .trailer-inline-retry {
    min-height: 40px; padding: 8px 18px;
    border: 1px solid var(--dp-accent-border); border-radius: 999px;
    color: var(--color-text); background: var(--dp-accent-soft);
    font: inherit; font-size: 0.72rem; font-weight: 700;
    cursor: pointer;
    transition: background var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out);
  }
  .trailer-inline-retry:hover { background: var(--dp-surface); border-color: var(--dp-accent); }
  .trailer-inline-retry:focus-visible { outline: 2px solid var(--dp-accent); outline-offset: 2px; }
  /* The engaged Trailer toggle reads as "on" without shouting. */
  .trailer-toggle.engaged { background: var(--dp-accent-soft); border-color: var(--dp-accent-border); }
  /* MAV-24 Issue 2 — the fullscreen control is ICON-ONLY: a compact
     square that stays beside Trailer Off on one row (the labelled
     version wrapped onto its own row on narrow screens). The 44px
     min-width keeps an adequate touch/keyboard target. */
  .trailer-fs-btn {
    min-width: 44px; justify-content: center; padding: 10px 12px;
  }
  .trailer-fs-btn:focus-visible { outline: 2px solid var(--dp-accent); outline-offset: 2px; }

  /* ============================================================
     RESPONSIVE — the overlap composition at every surface.
     ============================================================ */

  /* TABLET — wider poster column, larger type, deeper overlap. */
  @media (min-width: 641px) and (max-width: 1024px) {
    .hero { min-height: clamp(480px, 70vh, 680px); }
    .hero-body { margin-top: calc(-1 * clamp(140px, 22vw, 200px)); }
    .hero-grid { grid-template-columns: clamp(150px, 22vw, 200px) minmax(0, 1fr); }
    .detail-eyebrow { font-size: .64rem; }
    .detail-title { font-size: clamp(1.6rem, 3.2vw, 2.2rem); }
    .meta-row { font-size: .76rem; }
    /* MAV-24: .detail-desc removed with the hero synopsis. */
    .primary-actions, .secondary-actions { max-width: 480px; }
    .cast-card { flex: 0 0 clamp(120px, 18vw, 150px); }
  }

  /* DESKTOP — the poster joins the composition full-height (it spans
     both hero rows) beside the identity + actions columns. */
  @media (min-width: 1025px) {
    .hero { min-height: clamp(520px, 76vh, 760px); }
    .hero-body {
      width: min(1500px, calc(100% - clamp(48px, 6vw, 120px)));
      margin-top: calc(-1 * clamp(180px, 22vw, 260px));
    }
    .hero-grid {
      grid-template-columns: clamp(230px, 20vw, 300px) minmax(0, 1fr);
      column-gap: clamp(28px, 3.5vw, 48px);
      row-gap: 20px;
    }
    .poster-card { grid-row: 1 / span 2; border-radius: 16px; }
    .hero-info { grid-column: 2; grid-row: 1; align-self: end; padding-bottom: 4px; }
    .hero-lower { grid-column: 2; grid-row: 2; }
    .detail-eyebrow { font-size: .68rem; }
    .detail-title { font-size: clamp(2rem, 3.4vw, 2.9rem); -webkit-line-clamp: 2; line-clamp: 2; }
    .meta-row { font-size: .8rem; gap: 8px; }
    /* MAV-24: .detail-desc removed with the hero synopsis. */
    .primary-actions, .secondary-actions { max-width: 480px; }
    .play-btn { padding: 14px 28px; }
    .cast-card { flex: 0 0 clamp(130px, 12vw, 160px); }
    .details-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px 28px; }
  }

  /* LARGE DESKTOP / 4K — wider composition + bounded typography. */
  @media (min-width: 1900px) {
    .hero-body, .detail-body { width: min(1700px, calc(100% - 120px)); }
    .hero-grid { grid-template-columns: clamp(280px, 16vw, 340px) minmax(0, 1fr); }
    .detail-title { font-size: clamp(2.6rem, 3vw, 3.4rem); }
    /* MAV-24: .detail-desc removed with the hero synopsis. */
    .details-grid { grid-template-columns: repeat(4, minmax(0, 1fr)); }
  }

  /* MOBILE — MAV-23 Fix 1: the compact fold. The base rules ARE the
     mobile layout; this block tunes spacing/heights so the COMPLETE
     cinematic hero composition — poster overlap, title, metadata, genre
     chips, synopsis preview, Play + secondary actions AND the compact
     provider chip — lands inside the initial viewport at 360×800,
     390×844 and 430×932 (with browser chrome budgeted). Everything is a
     min-height/spacing tune: nothing clips, nothing hides, and the
     page scrolls normally when content legitimately exceeds the fold. */
  @media (max-width: 640px) {
    .detail-page { padding-bottom: calc(36px + env(safe-area-inset-bottom, 0px)); }
    .hero { min-height: clamp(300px, 44vh, 460px); }
    .back-btn { top: calc(12px + env(safe-area-inset-top)); left: 12px; padding: 0 12px; min-height: 34px; font-size: .68rem; }
    /* The scrim keeps the artwork visible at the top while the overlap
       zone sits on a strong readable fade that lands on the palette
       deep tone — all rgba stops, no opaque band. */
    .hero-scrim {
      background:
        linear-gradient(180deg,
          rgba(4,6,7,.44) 0%,
          rgba(4,6,7,.28) 16%,
          rgba(4,6,7,.42) 34%,
          rgba(5,8,10,.66) 55%,
          rgba(5,8,10,.85) 76%,
          var(--dp-deep) 100%),
        linear-gradient(90deg, rgba(4,6,7,.36) 0%, rgba(4,6,7,.14) 40%, transparent 68%);
    }
    .hero-body { width: calc(100% - 24px); margin-top: calc(-1 * clamp(78px, 19vw, 112px)); }
    .hero-grid { grid-template-columns: clamp(96px, 25vw, 124px) minmax(0, 1fr); row-gap: 10px; }
    .detail-title { font-size: clamp(1.24rem, 5vw, 1.6rem); }
    .meta-row { margin-top: 6px; }
    /* MAV-24: .detail-desc removed with the hero synopsis. */
    /* Compact action block: Play + Download share ONE dominant row
       (Play flexes; Download is a fixed 52px icon square at the same
       height). The secondary row follows. */
    .actions { margin-top: 12px; gap: 8px; }
    .primary-actions { max-width: 100%; }
    .play-btn { flex: 1 1 62%; min-height: 52px; padding: 12px 16px; }
    /* MAV-24 Issue 2: the icon-only fullscreen control joins this row
       while the trailer plays — the 3px/side padding trim + 5px gap keep
       ALL FOUR controls (My List · Share · Trailer Off · fs-icon) on ONE
       row at 360px (measured 337px needed vs 336px available before the
       trim; ~316-322px after). Heights are untouched (min 44px targets). */
    .secondary-actions { gap: 5px; }
    .secondary-btn { padding: 10px 9px; font-size: .72rem; }
    .recs-row { grid-auto-columns: clamp(122px, 36vw, 148px); }
  }

  /* LANDSCAPE MOBILE — short viewport: keep the title + actions above
     the fold, never push content below the visible area. */
  @media (max-width: 1024px) and (orientation: landscape) and (max-height: 480px) {
    .hero { min-height: auto; height: auto; }
    .hero-body { margin-top: -64px; }
    .hero-grid { grid-template-columns: clamp(84px, 18vw, 120px) minmax(0, 1fr); }
    .detail-title { font-size: clamp(1.2rem, 3vw, 1.6rem); }
    /* MAV-24: .detail-desc removed with the hero synopsis. */
    .primary-actions { max-width: 100%; }
    /* MAV-23 Fix 1: landscape-short keeps Play + Download on ONE row so
       the action block stays reachable on short viewports (MAV-24:
       Download is the fixed icon square at the row height). */
    .play-btn { flex: 1 1 62%; min-height: 46px; }
    .download-btn { min-height: 46px; width: 46px; }
  }

  @media (prefers-reduced-motion: reduce) {
    .palette-canvas,
    .back-btn, .play-btn, .download-btn, .secondary-btn,
    .show-more, .rec-poster, .trailer-inline-retry {
      transition: none !important;
      animation: none !important;
    }
    .trailer-inline :global(.trailer-spinner) { animation: none !important; }
  }
</style>
