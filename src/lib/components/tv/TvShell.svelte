<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { page } from '$app/state';
  import {
    TVFocusCoordinator,
    canExitApplication,
    createTVNavigation,
    exitApplication,
    getTVRemoteAction,
    isTizen,
    isTizenBrewHostedModule,
    type TVRemoteEvent,
    type TVScreen
  } from '$lib/tv';
  import type { MediaItem } from '$data/content';
  import type { Episode, NormalizedMediaItem, Season } from '$lib/server/content/types';
  import type { WatchlistStatus } from '$lib/client/progress/types';
  import { getContinueWatching, getFavoriteStatus, getLocalFavorites, getLocalPersistenceState, getLocalProgressRecords, removeFavoriteFromMyList, setFavoriteStatus } from '$lib/client/progress/service';
  import { listFavoriteDeletions } from '$lib/client/progress/database';
  import { favoriteToMedia, progressToMedia } from '$lib/client/progress/presenter';
  import { deleteCloudFavorite, syncAuthenticatedState } from '$lib/client/progress/cloud';
  import { mergeFavoritesWithProgress } from '$lib/shared/progress-merge';
  import TvDetail from './TvDetail.svelte';
  import TvError from './TvError.svelte';
  import TvHeader from './TvHeader.svelte';
  import TvHero from './TvHero.svelte';
  import TvLoading from './TvLoading.svelte';
  import TvMediaRail from './TvMediaRail.svelte';
  import TvMyList from './TvMyList.svelte';
  import TvNav from './TvNav.svelte';
  import TvPlayer from './TvPlayer.svelte';
  import TvPerformance from './TvPerformance.svelte';
  import TvSearch, { type TvSearchCategory } from './TvSearch.svelte';

  type ActionTarget = HTMLElement & { dataset: DOMStringMap };
  type AsyncState = 'loading' | 'ready' | 'error';
  type TvDetailItem = NormalizedMediaItem & { recommendations?: NormalizedMediaItem[] };
  type DetailPayload = { ok?: boolean; item?: TvDetailItem; error?: { message?: string } };
  type SeasonPayload = { ok?: boolean; season?: Season; error?: { message?: string } };
  type DiscoverData = {
    featured?: MediaItem;
    movies: MediaItem[];
    series: MediaItem[];
    anime: MediaItem[];
    popularMovies?: MediaItem[];
    popularSeries?: MediaItem[];
    popularAnime?: MediaItem[];
    errorMessage?: string;
  };

  const emptyDiscover: DiscoverData = { movies: [], series: [], anime: [] };
  const detailCache = new Map<string, TvDetailItem>();
  const detailCacheLimit = 4;

  function detailCacheKey(item: Pick<MediaItem, 'type' | 'id'>) {
    return `${item.type}:${item.id}`;
  }

  function readDetailCache(item: Pick<MediaItem, 'type' | 'id'>) {
    const key = detailCacheKey(item);
    const cached = detailCache.get(key);
    if (!cached) return undefined;
    detailCache.delete(key);
    detailCache.set(key, cached);
    return cached;
  }

  function writeDetailCache(item: TvDetailItem) {
    const key = detailCacheKey(item);
    detailCache.delete(key);
    detailCache.set(key, item);
    while (detailCache.size > detailCacheLimit) {
      const oldest = detailCache.keys().next().value;
      if (oldest === undefined) break;
      detailCache.delete(oldest);
    }
  }

  let {
    discover = emptyDiscover
  }: {
    discover?: DiscoverData;
  } = $props();

  let root: HTMLElement;
  let coordinator: TVFocusCoordinator;
  const navigation = createTVNavigation();

  let screen = $state<TVScreen>('home');
  let exitDialogOpen = $state(false);
  let previousFocusId = $state<string | null>(null);
  let asyncState = $state<AsyncState>('ready');
  let errorMessage = $state('The Discover section did not respond.');
  let statusMessage = $state('Ready for real Discover content.');
  let selectedTitle = $state<string | null>(null);
  let exitCapability = $state('Browser-safe mode');
  let lastActivationKey = '';
  let lastActivationAt = 0;

  let searchQuery = $state('');
  let searchCategory = $state<TvSearchCategory>('all');
  let searchResults = $state<MediaItem[]>([]);
  let searchKeyboardOpen = $state(false);
  let searchSubmitted = $state(false);
  let searchLoading = $state(false);
  let searchError = $state('');
  let searchStatusMessage = $state('Open Edit query to begin.');
  let nativeImeExperiment = $state(false);
  let nativeQuery = $state('');
  let tvPerformanceEnabled = $state(false);
  let searchController: AbortController | undefined;
  let searchRequestSequence = 0;

  let detailItem = $state<TvDetailItem | null>(null);
  let detailLoading = $state(false);
  let detailError = $state('');
  let detailController: AbortController | undefined;
  let detailRequestSequence = 0;
  let detailActiveSeason = $state(1);
  let detailSeasons = $state<Season[]>([]);
  let detailEpisodesLoading = $state(false);
  let detailEpisodesError = $state('');
  let detailFavoriteStatus = $state<WatchlistStatus | null>(null);
  let detailFavoriteSaving = $state(false);
  let detailSaveError = $state('');
  let myListItems = $state<MediaItem[]>([]);
  let continueWatchingItems = $state<MediaItem[]>([]);
  let myListLoading = $state(false);
  let myListError = $state('');
  let myListSyncMessage = $state('Local-first library');
  let myListRequestSequence = 0;
  let playerTitle = $state('');
  let playerSource = $state('');
  let playerRetryNonce = $state(0);
  let playerReturnScrollY = $state<number | null>(null);

  const phase7MockPlaybackUrl = 'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4';

  const navItems: Array<{ id: string; label: string; screen: TVScreen }> = [
    { id: 'tv-nav-home', label: 'Home', screen: 'home' },
    { id: 'tv-nav-search', label: 'Search', screen: 'search' },
    { id: 'tv-nav-list', label: 'My List', screen: 'my-list' },
    { id: 'tv-nav-settings', label: 'Settings', screen: 'settings' }
  ];

  async function loadContinueWatching() {
    try {
      const records = await getContinueWatching();
      continueWatchingItems = records.slice(0, 12).map(progressToMedia);
    } catch {
      continueWatchingItems = [];
    }
  }

  onMount(() => {
    coordinator = new TVFocusCoordinator(root);
    coordinator.initialize('tv-nav-home');
    const url = new URL(globalThis.location.href);
    nativeImeExperiment = url.searchParams.get('ime') === '1';
    nativeQuery = url.searchParams.get('q')?.slice(0, 120) ?? '';
    tvPerformanceEnabled = url.searchParams.get('tvperf') === '1';
    void loadContinueWatching();
    if (nativeQuery) searchQuery = nativeQuery;
    exitCapability = isTizenBrewHostedModule()
      ? 'TizenBrew host-return mode'
      : isTizen() && canExitApplication()
        ? 'Tizen standalone exit API available'
        : 'Browser-safe mode';

    const handleKeydown = (event: KeyboardEvent) => {
      const action = getTVRemoteAction(event as TVRemoteEvent);
      if (!action) return;

      if (action === 'back') {
        event.preventDefault();
        handleBack();
        return;
      }

      if (screen === 'player') {
        event.preventDefault();
        window.dispatchEvent(new CustomEvent('tv-player-remote', { detail: action }));
        return;
      }

      if (action === 'up' || action === 'down' || action === 'left' || action === 'right') {
        event.preventDefault();
        coordinator.move(action, exitDialogOpen ? 'tv-exit' : undefined);
        return;
      }

      if (action === 'enter') {
        event.preventDefault();
        const active = document.activeElement;
        if (active instanceof HTMLElement && root.contains(active)) active.click();
      }
    };

    window.addEventListener('keydown', handleKeydown);
    return () => {
      window.removeEventListener('keydown', handleKeydown);
      searchController?.abort();
      detailController?.abort();
      detailRequestSequence += 1;
      coordinator.destroy();
    };
  });

  function hasDiscoverContent(data: DiscoverData) {
    return Boolean(data.featured || data.movies.length || data.series.length || data.anime.length);
  }

  function handleBack() {
    if (exitDialogOpen) {
      cancelExit();
      return;
    }

    if (screen === 'player') {
      const previous = navigation.goBack();
      if (previous) {
        screen = previous.screen;
        statusMessage = `Returned to ${screenLabel(screen)}.`;
        if (previous.screen === 'detail' && previous.focusId === 'tv-detail-watch-now') restoreDetailFocusAfterPlayer();
        else restoreAfterRender([previous.focusId, 'tv-detail-watch-now', 'tv-nav-home']);
      } else {
        openExitConfirmation();
      }
      return;
    }

    if (screen === 'detail') {
      detailRequestSequence += 1;
      detailController?.abort();
      detailController = undefined;
      const previous = navigation.goBack();
      if (previous) {
        screen = previous.screen;
        statusMessage = `Returned to ${screenLabel(screen)}.`;
        if (screen === 'my-list') void loadMyList();
        restoreAfterRender([previous.focusId, `tv-nav-${screen}`, 'tv-nav-home']);
      } else {
        openExitConfirmation();
      }
      return;
    }

    if (screen === 'search' && searchKeyboardOpen) {
      searchKeyboardOpen = false;
      searchStatusMessage = 'Keyboard closed. Query preserved.';
      restoreAfterRender(['tv-search-input', 'tv-search-submit', 'tv-search-category-all']);
      return;
    }

    if (
      screen === 'search' &&
      nativeImeExperiment &&
      document.activeElement instanceof HTMLInputElement &&
      document.activeElement.dataset.tvFocusId === 'tv-search-native-ime-input'
    ) {
      searchStatusMessage = 'Back received. Verify that the Samsung IME closed and input focus is still available.';
      restoreAfterRender(['tv-search-native-ime-input', 'tv-search-input']);
      return;
    }

    if (screen === 'search' && (searchSubmitted || searchResults.length || searchError)) {
      searchRequestSequence += 1;
      searchController?.abort();
      searchController = undefined;
      searchSubmitted = false;
      searchResults = [];
      searchError = '';
      searchLoading = false;
      searchStatusMessage = 'Search cleared. Query preserved for editing.';
      restoreAfterRender(['tv-search-input', 'tv-search-category-all', 'tv-nav-search']);
      return;
    }

    const leavingScreen = screen;
    const previous = navigation.goBack();
    if (previous) {
      if (leavingScreen === 'search') clearSearchUrl();
      screen = previous.screen;
      asyncState = discover.errorMessage && !hasDiscoverContent(discover) ? 'error' : 'ready';
      statusMessage = `Returned to ${screenLabel(screen)}.`;
      restoreAfterRender([previous.focusId, `tv-nav-${screen}`, 'tv-nav-home']);
      return;
    }

    openExitConfirmation();
  }

  function openExitConfirmation() {
    previousFocusId = coordinator.rememberFocus();
    exitDialogOpen = true;
    statusMessage = 'Exit confirmation opened.';
    restoreAfterRender(['tv-exit-cancel']);
  }

  function cancelExit() {
    exitDialogOpen = false;
    statusMessage = 'Exit cancelled. Focus restored.';
    const restoreId = previousFocusId;
    previousFocusId = null;
    restoreAfterRender([restoreId, `tv-nav-${screen}`, 'tv-nav-home']);
  }

  function confirmExit() {
    const result = exitApplication();
    if (result.ok && result.reason === 'host-returned') {
      exitDialogOpen = false;
      previousFocusId = null;
      statusMessage = 'Returning to the TizenBrew host.';
      return;
    }

    if (result.ok && result.reason === 'native-requested') {
      exitDialogOpen = false;
      previousFocusId = null;
      statusMessage = 'Native Tizen exit requested for the standalone application.';
      return;
    }

    exitDialogOpen = false;
    statusMessage = 'Native Tizen exit is unavailable in this browser preview.';
    const restoreId = previousFocusId;
    previousFocusId = null;
    restoreAfterRender([restoreId, `tv-nav-${screen}`, 'tv-nav-home']);
  }

  function handleAction(event: MouseEvent, explicitFocusId?: string, explicitAction?: string) {
    const target = event.currentTarget as ActionTarget;
    const focusId = explicitFocusId ?? target.dataset.tvFocusId ?? '';
    const now = performance.now();
    if (focusId && focusId === lastActivationKey && now - lastActivationAt < 180) return;
    lastActivationKey = focusId;
    lastActivationAt = now;
    const action = explicitAction ?? target.dataset.tvAction ?? '';

    if (action.startsWith('screen:')) {
      const nextScreen = action.slice('screen:'.length) as TVScreen;
      if (nextScreen === screen) {
        statusMessage = `${screenLabel(nextScreen)} is already active.`;
        return;
      }
      navigation.rememberFocus(focusId || null);
      navigation.open(nextScreen, focusId || null);
      screen = nextScreen;
      asyncState = 'ready';
      statusMessage = `${screenLabel(nextScreen)} is ready for remote navigation.`;
      if (nextScreen === 'search') {
        searchStatusMessage = searchSubmitted ? 'Search state preserved.' : 'Open Edit query to begin.';
      }
      if (nextScreen === 'my-list') void loadMyList();
      return;
    }

    if (action === 'retry') {
      statusMessage = 'Retrying Discover content.';
      globalThis.location.reload();
      return;
    }

    if (action === 'placeholder') {
      statusMessage = `${screenLabel(screen)} TV content is reserved for its roadmap phase.`;
      return;
    }

    if (action === 'quit') {
      openExitConfirmation();
      return;
    }

    if (action === 'cancel-exit') {
      cancelExit();
      return;
    }

    if (action === 'confirm-exit') confirmExit();
  }

  function handleMediaSelect(item: MediaItem, _event: MouseEvent, focusId: string) {
    openDetail(item, focusId);
  }

  function searchTypeParam(category: TvSearchCategory) {
    return category === 'all' ? undefined : category;
  }

  function clearSearchUrl() {
    if (typeof globalThis.location === 'undefined') return;
    const url = new URL(globalThis.location.href);
    url.searchParams.delete('q');
    url.searchParams.delete('type');
    globalThis.history.replaceState(globalThis.history.state, '', `${url.pathname}${url.search}${url.hash}`);
  }

  function updateSearchUrl() {
    if (typeof globalThis.location === 'undefined') return;
    const url = new URL(globalThis.location.href);
    if (searchQuery.trim()) url.searchParams.set('q', searchQuery.trim());
    else url.searchParams.delete('q');
    const type = searchTypeParam(searchCategory);
    if (type) url.searchParams.set('type', type);
    else url.searchParams.delete('type');
    globalThis.history.replaceState(globalThis.history.state, '', `${url.pathname}${url.search}${url.hash}`);
  }

  async function runSearch(restoreIds?: string[]) {
    const normalized = searchQuery.trim();
    updateSearchUrl();
    if (!normalized) {
      searchSubmitted = false;
      searchResults = [];
      searchError = '';
      searchLoading = false;
      searchStatusMessage = 'Enter a title before searching.';
      restoreAfterRender(['tv-search-input', 'tv-search-category-all']);
      return;
    }

    const requestId = ++searchRequestSequence;
    searchController?.abort();
    const controller = new AbortController();
    searchController = controller;
    searchSubmitted = true;
    searchLoading = true;
    searchError = '';
    searchStatusMessage = `Searching for “${normalized}”…`;
    restoreAfterRender(restoreIds?.length ? restoreIds : ['tv-search-input', 'tv-search-category-all']);

    try {
      const params = new URLSearchParams({ q: normalized });
      const type = searchTypeParam(searchCategory);
      if (type) params.set('type', type);
      const response = await fetch(`/api/content/search?${params.toString()}`, { signal: controller.signal });
      const payload = await response.json() as { ok?: boolean; items?: MediaItem[]; partial?: boolean; warnings?: string[]; error?: { message?: string } };
      if (requestId !== searchRequestSequence || controller.signal.aborted) return;
      if (!response.ok || !payload.ok) throw new Error(payload.error?.message || 'Search is temporarily unavailable.');
      searchResults = Array.isArray(payload.items) ? payload.items.slice(0, 24) : [];
      const warning = payload.partial ? ` ${payload.warnings?.[0] ?? 'Some catalog sources are unavailable.'}` : '';
      searchStatusMessage = searchResults.length
        ? `${searchResults.length} result${searchResults.length === 1 ? '' : 's'} found.${warning}`
        : `No matching stories. Try another title or category.${warning}`;
    } catch (error) {
      if (controller.signal.aborted || requestId !== searchRequestSequence) return;
      searchError = error instanceof Error ? error.message : 'Search is temporarily unavailable.';
      searchResults = [];
      searchStatusMessage = 'Search failed. Retry or edit the query.';
    } finally {
      if (requestId !== searchRequestSequence) return;
      searchLoading = false;
      searchController = undefined;
      if (searchError) {
        restoreAfterRender(['tv-retry', 'tv-search-input', 'tv-search-category-all']);
      } else if (restoreIds?.length) {
        restoreAfterRender(restoreIds);
      } else if (searchResults[0]) {
        restoreAfterRender([`tv-media-tv-search-results-${searchResults[0].id}`, 'tv-search-input', 'tv-search-category-all']);
      } else {
        restoreAfterRender(['tv-search-input', 'tv-search-category-all']);
      }
    }
  }

  function openSearchKeyboard() {
    searchKeyboardOpen = true;
    searchStatusMessage = 'Use Arrow keys and Enter to build the query.';
    restoreAfterRender(['tv-search-key-a', 'tv-search-input']);
  }

  function closeSearchKeyboard() {
    searchKeyboardOpen = false;
    searchStatusMessage = 'Keyboard closed. Query preserved.';
    restoreAfterRender(['tv-search-input', 'tv-search-submit', 'tv-search-category-all']);
  }

  function handleSearchKey(key: string) {
    if (key === 'backspace') searchQuery = searchQuery.slice(0, -1);
    else if (key === 'clear') searchQuery = '';
    else if (searchQuery.length < 120) searchQuery += key;
    nativeQuery = searchQuery;
    searchStatusMessage = searchQuery ? `Query: ${searchQuery}` : 'Query is empty.';
  }

  function handleNativeQueryInput(value: string) {
    nativeQuery = value.slice(0, 120);
    searchQuery = nativeQuery;
    searchStatusMessage = nativeQuery ? `Native input query: ${nativeQuery}` : 'Native input query is empty.';
  }

  function submitNativeQuery() {
    searchQuery = nativeQuery;
    searchKeyboardOpen = false;
    void runSearch(['tv-search-native-ime-input']);
  }

  function submitSearch() {
    nativeQuery = searchQuery;
    searchKeyboardOpen = false;
    void runSearch(['tv-search-input', 'tv-search-category-all']);
  }

  function changeSearchCategory(nextCategory: TvSearchCategory, focusId: string) {
    searchCategory = nextCategory;
    searchStatusMessage = `Category: ${searchCategoryLabel(nextCategory)}.`;
    if (searchQuery.trim()) void runSearch([focusId]);
    else restoreAfterRender([focusId]);
  }

  function retrySearch() {
    void runSearch(['tv-search-input', 'tv-search-category-all']);
  }

  function handleSearchSelect(item: MediaItem, event: MouseEvent, focusId: string) {
    handleMediaSelect(item, event, focusId);
  }

  async function openDetail(item: MediaItem, focusId: string) {
    navigation.rememberFocus(focusId);
    navigation.open('detail', focusId);
    screen = 'detail';
    selectedTitle = null;
    statusMessage = `Loading ${item.title} details…`;
    detailItem = item as TvDetailItem;
    detailLoading = true;
    detailError = '';
    detailSaveError = '';
    detailFavoriteStatus = null;
    detailSeasons = [];
    detailActiveSeason = 1;
    detailEpisodesLoading = false;
    detailEpisodesError = '';
    const requestId = ++detailRequestSequence;
    detailController?.abort();
    const controller = new AbortController();
    detailController = controller;
    restoreAfterRender(['tv-detail-back']);

    const cachedDetail = readDetailCache(item);
    if (cachedDetail) {
      detailItem = cachedDetail;
      detailLoading = false;
      statusMessage = `${cachedDetail.title} details restored from TV cache.`;
      const status = await getFavoriteStatus(cachedDetail.type, cachedDetail.id);
      if (requestId !== detailRequestSequence || controller.signal.aborted) return;
      detailFavoriteStatus = status;
      restoreAfterRender(['tv-detail-my-list', 'tv-detail-back']);
      if (cachedDetail.type === 'series') void loadDetailSeason(cachedDetail.id, 1, requestId);
      if (!cachedDetail.recommendations?.length) void loadDetailRecommendations(cachedDetail, requestId, controller);
      return;
    }

    try {
      const response = await fetch(`/api/content/${item.type}/${encodeURIComponent(item.id)}`, { signal: controller.signal });
      const payload = await response.json() as DetailPayload;
      if (requestId !== detailRequestSequence || controller.signal.aborted) return;
      if (!response.ok || !payload.ok || !payload.item) throw new Error(payload.error?.message || 'Title details are temporarily unavailable.');
      detailItem = payload.item;
      writeDetailCache(payload.item);
      const status = await getFavoriteStatus(payload.item.type, payload.item.id);
      if (requestId !== detailRequestSequence || controller.signal.aborted) return;
      detailFavoriteStatus = status;
      detailLoading = false;
      statusMessage = `${payload.item.title} details ready.`;
      restoreAfterRender(['tv-detail-my-list', 'tv-detail-back']);
      if (payload.item.type === 'series') void loadDetailSeason(payload.item.id, 1, requestId);
      void loadDetailRecommendations(payload.item, requestId, controller);
    } catch (error) {
      if (controller.signal.aborted || requestId !== detailRequestSequence) return;
      detailError = error instanceof Error ? error.message : 'Title details are temporarily unavailable.';
      detailLoading = false;
      statusMessage = 'Title details are unavailable. Retry or go back.';
      restoreAfterRender(['tv-detail-back']);
    }
  }

  async function loadDetailRecommendations(item: TvDetailItem, requestId: number, controller: AbortController) {
    const seed = item.genres[0] || item.title;
    try {
      const params = new URLSearchParams({ q: seed, type: item.type });
      const response = await fetch(`/api/content/search?${params.toString()}`, { signal: controller.signal });
      const payload = await response.json() as { ok?: boolean; items?: NormalizedMediaItem[] };
      if (!response.ok || !payload.ok || requestId !== detailRequestSequence || controller.signal.aborted) return;
      const seen = new Set<string>([item.id]);
      const recommendations = [...(item.recommendations ?? []), ...(payload.items ?? [])].filter((candidate) => {
        if (candidate.id === item.id || seen.has(candidate.id)) return false;
        seen.add(candidate.id);
        return candidate.type === item.type;
      });
      detailItem = { ...item, recommendations };
      writeDetailCache(detailItem);
    } catch {
      // Detail recommendations remain usable when the optional expansion request fails.
    }
  }

  async function loadDetailSeason(seriesId: string, seasonNumber: number, requestId = detailRequestSequence) {
    detailActiveSeason = seasonNumber;
    detailEpisodesLoading = true;
    detailEpisodesError = '';
    try {
      const response = await fetch(`/api/content/series/${encodeURIComponent(seriesId)}/season/${seasonNumber}`);
      const payload = await response.json() as SeasonPayload;
      if (requestId !== detailRequestSequence) return;
      if (!response.ok || !payload.ok || !payload.season) throw new Error(payload.error?.message || 'Season data is temporarily unavailable.');
      detailSeasons = [payload.season];
      restoreAfterRender([`tv-detail-season-${seasonNumber}`, `tv-detail-episode-${seasonNumber}-1`, 'tv-detail-my-list']);
    } catch (error) {
      if (requestId !== detailRequestSequence) return;
      detailEpisodesError = error instanceof Error ? error.message : 'Season data is temporarily unavailable.';
    } finally {
      if (requestId === detailRequestSequence) detailEpisodesLoading = false;
    }
  }

  function handleDetailSeasonChange(seasonNumber: number) {
    if (!detailItem || detailItem.type !== 'series') return;
    void loadDetailSeason(detailItem.id, seasonNumber);
  }

  function handleEpisodeSelect(episode: Episode) {
    statusMessage = `Selected Season ${episode.season}, Episode ${episode.number}. Player actions remain outside Phase 7 initial playback scope.`;
    restoreAfterRender([`tv-detail-episode-${episode.season}-${episode.number}`]);
  }

  function restoreDetailFocusAfterPlayer() {
    const savedScrollY = playerReturnScrollY;
    playerReturnScrollY = null;
    void tick().then(() => {
      if (typeof window !== 'undefined' && savedScrollY !== null) window.scrollTo(window.scrollX, savedScrollY);
      const target = root?.querySelector<HTMLElement>('[data-tv-focus-id="tv-detail-watch-now"]');
      if (!target) {
        restoreAfterRender(['tv-detail-watch-now', 'tv-detail-back', 'tv-nav-home']);
        return;
      }
      target.tabIndex = 0;
      target.focus({ preventScroll: true });
    });
  }

  function openPlayer() {
    if (!detailItem) return;
    playerReturnScrollY = typeof window !== 'undefined' ? window.scrollY : null;
    navigation.rememberFocus('tv-detail-watch-now');
    navigation.open('player', 'tv-detail-watch-now');
    screen = 'player';
    playerTitle = detailItem.title;
    playerSource = phase7MockPlaybackUrl;
    playerRetryNonce += 1;
    statusMessage = `${detailItem.title} player ready.`;
    restoreAfterRender(['tv-player-toggle', 'tv-player-back']);
  }

  function retryPlayer() {
    playerRetryNonce += 1;
    statusMessage = `${playerTitle} player retry requested.`;
    restoreAfterRender(['tv-player-toggle', 'tv-player-back']);
  }

  function detailSnapshot(item: TvDetailItem) {
    return { title: String(item.title), poster: String(item.poster), backdrop: String(item.backdrop), year: Number(item.year), runtime: String(item.runtime), rating: Number(item.rating), genres: Array.from(item.genres ?? [], (genre) => String(genre)), description: String(item.description ?? '') };
  }

  async function toggleDetailFavorite() {
    if (!detailItem || detailFavoriteSaving) return;
    detailFavoriteSaving = true;
    detailSaveError = '';
    try {
      if (detailFavoriteStatus) {
        await removeFavoriteFromMyList(detailItem.type, detailItem.id);
        detailFavoriteStatus = null;
        if (page.data.user) {
          const removed = await deleteCloudFavorite(detailItem.type, detailItem.id);
          if (!removed) void syncAuthenticatedState();
        }
        statusMessage = `${detailItem.title} removed from My List.`;
      } else {
        await setFavoriteStatus(detailItem.type, detailItem.id, detailSnapshot(detailItem), 'planned');
        detailFavoriteStatus = 'planned';
        if (page.data.user) void syncAuthenticatedState();
        statusMessage = `${detailItem.title} added to My List.`;
      }
      if (screen === 'my-list') void loadMyList();
    } catch {
      detailSaveError = 'This device could not update My List.';
    } finally {
      detailFavoriteSaving = false;
      restoreAfterRender(['tv-detail-my-list', 'tv-detail-back']);
    }
  }

  async function loadMyList() {
    const requestId = ++myListRequestSequence;
    myListLoading = true;
    myListError = '';
    try {
      const [favorites, progress, deletions, persistence, continueWatching] = await Promise.all([getLocalFavorites(), getLocalProgressRecords(), listFavoriteDeletions(), getLocalPersistenceState(), getContinueWatching()]);
      if (requestId !== myListRequestSequence) return;
      const local = mergeFavoritesWithProgress(favorites, progress, deletions);
      myListItems = local.map((record) => favoriteToMedia(record, progress));
      continueWatchingItems = continueWatching.slice(0, 12).map(progressToMedia);
      myListLoading = false;
      myListSyncMessage = persistence.status === 'indexeddb' ? 'Local-first · background sync' : 'Memory fallback · this session';
      restoreAfterRender(['tv-media-tv-my-list-' + (myListItems[0]?.id ?? ''), 'tv-my-list-browse', 'tv-nav-list']);
      if (page.data.user) {
        void syncAuthenticatedState().then((cloud) => {
          if (requestId !== myListRequestSequence || !cloud.authenticated) return;
          myListItems = cloud.favorites.map((record) => favoriteToMedia(record, cloud.progress));
          myListSyncMessage = `Cloud sync: ${cloud.status}`;
        });
      }
    } catch {
      if (requestId !== myListRequestSequence) return;
      myListLoading = false;
      myListError = 'Your TV library is temporarily unavailable.';
      restoreAfterRender(['tv-retry', 'tv-my-list-browse', 'tv-nav-list']);
    }
  }

  function handleDetailRecommendation(item: MediaItem, _event: MouseEvent, focusId: string) {
    openDetail(item, focusId);
  }

  function browseFromMyList() {
    navigation.rememberFocus('tv-my-list-browse');
    navigation.open('home', 'tv-my-list-browse');
    screen = 'home';
    statusMessage = 'Discover is ready for remote navigation.';
    restoreAfterRender(['tv-nav-home', 'tv-featured-action', 'tv-rail-anime']);
  }

  function searchCategoryLabel(value: TvSearchCategory) {
    return value === 'all' ? 'All / Search' : value === 'series' ? 'Shows' : value[0].toUpperCase() + value.slice(1) + (value === 'movie' ? 's' : '');
  }

  function restoreAfterRender(ids: Array<string | null>) {
    if (!coordinator) return;
    void tick().then(() => {
      const restore = (attempt = 0) => {
        if (coordinator.restoreFirst(ids)) return;
        if (attempt < 20) {
          setTimeout(() => restore(attempt + 1), 20);
          return;
        }
        coordinator.focusFirst();
      };

      const schedule = () => restore();
      if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(() => requestAnimationFrame(schedule));
      } else {
        setTimeout(schedule, 0);
      }
    });
  }

  function screenLabel(value: TVScreen) {
    return value === 'my-list' ? 'My List' : value[0].toUpperCase() + value.slice(1);
  }
</script>

<TvPerformance screen={screen} enabled={tvPerformanceEnabled} />
<div class="tv-page" bind:this={root} data-tv-screen={screen}>
  <TvHeader {exitCapability} />

  <main class="tv-main" aria-label="Mavero TV shell">
    <div class="tv-layout">
      <aside class="tv-sidebar" aria-label="TV navigation">
        <TvNav items={navItems} activeScreen={screen} onActivate={(item, event) => handleAction(event, item.id, `screen:${item.screen}`)} />
      </aside>

      <div class="tv-canvas">
        <section class="tv-hero" aria-labelledby="tv-shell-title">
      <div>
        <p class="eyebrow">Mavero TV / {screenLabel(screen)}</p>
        <h1 id="tv-shell-title">Your screen. Your story.</h1>
        <p class="hero-copy">A focused, remote-first home for the titles you want to watch next.</p>
      </div>
      <div class="hero-status" aria-live="polite">
        <span class="status-label">Now browsing</span>
        <strong>{screenLabel(screen)}</strong>
        <span>{selectedTitle ? `Selected: ${selectedTitle}` : screen === 'search' ? searchStatusMessage : screen === 'home' ? discover.errorMessage ?? statusMessage : statusMessage}</span>
      </div>
    </section>

    {#if screen === 'home'}
      <section class="tv-section tv-discover" aria-label="Discover TV content" aria-busy={asyncState === 'loading'}>
        {#if asyncState === 'error' || (Boolean(discover.errorMessage) && !hasDiscoverContent(discover))}
          <TvError message={discover.errorMessage ?? errorMessage} onRetry={(event) => handleAction(event, 'tv-retry', 'retry')} />
        {:else if !hasDiscoverContent(discover)}
          <TvLoading label="Loading Discover content…" />
        {:else}
          {#if discover.featured}
            <TvHero item={discover.featured} onSelect={handleMediaSelect} />
          {/if}
          {#if continueWatchingItems.length}
            <TvMediaRail title="Continue Watching" eyebrow="Pick up where you left off" railId="tv-continue-watching" items={continueWatchingItems} onSelect={handleMediaSelect} showProgress />
          {/if}
          <TvMediaRail title="Movies" eyebrow="Discover / films" railId="tv-rail-movies" items={discover.movies} onSelect={handleMediaSelect} />
          <TvMediaRail title="Series" eyebrow="Discover / series" railId="tv-rail-series" items={discover.series} onSelect={handleMediaSelect} />
          <TvMediaRail title="Anime" eyebrow="Discover / anime" railId="tv-rail-anime" items={discover.anime} onSelect={handleMediaSelect} />
        {/if}
      </section>
    {:else if screen === 'search'}
      <section class="tv-section tv-search-section" aria-label="TV Search">
        <TvSearch
          query={searchQuery}
          category={searchCategory}
          results={searchResults}
          keyboardOpen={searchKeyboardOpen}
          submitted={searchSubmitted}
          loading={searchLoading}
          errorMessage={searchError}
          statusMessage={searchStatusMessage}
          onOpenKeyboard={openSearchKeyboard}
          onCloseKeyboard={closeSearchKeyboard}
          onKeyPress={handleSearchKey}
          onSubmit={submitSearch}
          onCategoryChange={changeSearchCategory}
          onRetry={retrySearch}
          onSelect={handleSearchSelect}
          nativeImeExperiment={nativeImeExperiment}
          nativeQuery={nativeQuery}
          onNativeQueryInput={handleNativeQueryInput}
          onNativeQuerySubmit={submitNativeQuery}
        />
      </section>
    {:else if screen === 'my-list'}
      <section class="tv-section" aria-label="TV My List">
        <TvMyList items={myListItems} loading={myListLoading} errorMessage={myListError} syncMessage={myListSyncMessage} onRetry={(event) => { event.preventDefault(); void loadMyList(); }} onBrowse={(event) => { event.preventDefault(); browseFromMyList(); }} onSelect={handleMediaSelect} />
      </section>
    {:else if screen === 'detail'}
      <section class="tv-section" aria-label="TV title details">
        <TvDetail item={detailItem ?? undefined} loading={detailLoading} errorMessage={detailError} favoriteStatus={detailFavoriteStatus} saving={detailFavoriteSaving} seasons={detailSeasons} activeSeason={detailActiveSeason} episodesLoading={detailEpisodesLoading} episodesError={detailEpisodesError} recommendations={(detailItem?.recommendations ?? []) as MediaItem[]} saveError={detailSaveError} onBack={handleBack} onRetry={(event) => { event.preventDefault(); if (detailItem) void openDetail(detailItem, 'tv-detail-back'); }} onWatchNow={(event) => { event.preventDefault(); openPlayer(); }} onToggleFavorite={(event) => { event.preventDefault(); void toggleDetailFavorite(); }} onSeasonChange={handleDetailSeasonChange} onEpisodeSelect={(episode, event) => { event.preventDefault(); handleEpisodeSelect(episode); }} onRecommendationSelect={handleDetailRecommendation} />
      </section>
    {:else if screen === 'player'}
      <section class="tv-section tv-player-section" aria-label="TV player">
        {#key playerRetryNonce}
          <TvPlayer src={playerSource} title={playerTitle} onBack={() => handleBack()} onRetry={retryPlayer} />
        {/key}
      </section>
    {:else}
      <section class="tv-section" aria-labelledby="tv-placeholder-title">
        <div class="placeholder-panel">
          <p class="eyebrow">TV roadmap placeholder</p>
          <h2 id="tv-placeholder-title">{screenLabel(screen)} is ready for a later TV phase.</h2>
          <p>Phase 4 connects Search data first. This route stays remote-safe without duplicating the Web/PWA feature before its planned TV phase.</p>
          <button class="tv-focusable tv-action-button" data-tv-focusable="true" data-tv-focus-id="tv-placeholder-action" data-tv-focus-group="tv-placeholder" data-tv-action="placeholder" type="button" onclick={handleAction}>Keep browsing Home</button>
        </div>
      </section>
    {/if}

    <section class="tv-footer-actions" aria-label="TV exit actions">
      <div class="footer-note">
        <span class="eyebrow">Exit policy</span>
        <span>Back closes local states, restores logical focus, and confirms only at the TV root. Samsung’s dedicated Exit key is not intercepted.</span>
        <span class="tmdb-attribution"><a class="tmdb-credit" href="https://www.themoviedb.org/about/logos-attribution?language=en-US" target="_blank" rel="noreferrer"><img src="https://upload.wikimedia.org/wikipedia/commons/8/89/Tmdb.new.logo.svg" alt="TMDB" loading="lazy" decoding="async" /> TMDB</a> · This product uses the <a href="https://www.themoviedb.org" target="_blank" rel="noreferrer">TMDB API</a> but is not endorsed or certified by TMDB.</span>
      </div>
      <button class="tv-focusable quit-button" data-tv-focusable="true" data-tv-focus-id="tv-quit" data-tv-focus-group="tv-footer-actions" data-tv-action="quit" type="button" onclick={handleAction}>Quit Mavero</button>
        </section>
      </div>
    </div>
  </main>

  {#if exitDialogOpen}
    <div class="exit-layer" role="presentation">
      <div class="exit-backdrop" aria-hidden="true"></div>
      <div class="exit-dialog" role="alertdialog" aria-modal="true" aria-labelledby="exit-title" aria-describedby="exit-description">
        <p class="eyebrow">Mavero / Exit</p>
        <h2 id="exit-title">Exit Mavero?</h2>
        <p id="exit-description">Return to the TV home screen. Cancel keeps the application open and restores your previous focus.</p>
        <div class="exit-actions">
          <button class="tv-focusable exit-button cancel" data-tv-focusable="true" data-tv-focus-id="tv-exit-cancel" data-tv-focus-group="tv-exit" data-tv-action="cancel-exit" type="button" onclick={handleAction}>Cancel</button>
          <button class="tv-focusable exit-button confirm" data-tv-focusable="true" data-tv-focus-id="tv-exit-confirm" data-tv-focus-group="tv-exit" data-tv-action="confirm-exit" type="button" onclick={handleAction}>Exit</button>
        </div>
      </div>
    </div>
  {/if}
</div>

<style>
  .tv-page { --tv-bg: #060a13; --tv-surface: rgba(17, 25, 42, .96); --tv-surface-soft: rgba(101, 184, 255, .09); --tv-line: rgba(126, 186, 255, .2); --tv-muted: #b9c9df; --tv-muted-strong: #eaf4ff; --tv-ink: #ffffff; --tv-accent: #61e4ff; min-height: 100dvh; color: var(--tv-ink); background: radial-gradient(circle at 85% 0%, rgba(46, 153, 255, .18), transparent 32%), radial-gradient(circle at 0% 75%, rgba(0, 224, 255, .08), transparent 30%), var(--tv-bg); font-family: 'Inter', ui-sans-serif, system-ui, sans-serif; }
  .tv-main { width: min(100%, 1600px); margin-inline: auto; padding: 14px 56px 52px; }
  .tv-layout { display: grid; grid-template-columns: minmax(220px, 250px) minmax(0, 1fr); align-items: start; gap: clamp(28px, 4vw, 58px); }
  .tv-sidebar, .tv-canvas { min-width: 0; }
  .tv-focusable { outline: none; }
  .tv-focusable:focus-visible, .tv-focusable[data-tv-focus-id]:focus { border-color: #fff; box-shadow: 0 0 0 4px rgba(71, 221, 255, .88), 0 0 0 8px rgba(49, 122, 255, .24); }
  .tv-hero { display: grid; grid-template-columns: minmax(0, 1.35fr) minmax(230px, .65fr); align-items: end; gap: 28px; padding: 34px 6px 32px; border-bottom: 1px solid var(--tv-line); }
  .eyebrow { margin: 0 0 10px; color: var(--tv-accent); font-size: .68rem; font-weight: 900; letter-spacing: .16em; text-transform: uppercase; }
  .tv-hero h1 { max-width: 720px; margin: 0; font-size: clamp(2.55rem, 5vw, 5.2rem); font-weight: 950; letter-spacing: -.075em; line-height: .96; }
  .hero-copy { max-width: 620px; margin: 16px 0 0; color: var(--tv-muted); font-size: clamp(1rem, 1.35vw, 1.17rem); font-weight: 700; line-height: 1.55; }
  .hero-status { display: grid; gap: 8px; padding: 18px; border: 1px solid var(--tv-line); border-radius: 16px; background: linear-gradient(145deg, rgba(23, 42, 70, .94), rgba(14, 20, 34, .96)); }
  .status-label { color: var(--tv-muted); font-size: .72rem; font-weight: 850; letter-spacing: .12em; text-transform: uppercase; }
  .hero-status strong { color: #fff; font-size: 1.28rem; font-weight: 950; }
  .hero-status span:last-child { color: var(--tv-muted-strong); font-size: .9rem; font-weight: 700; line-height: 1.45; }
  .tv-section { padding: 34px 6px 0; }
  .tv-discover { padding-top: 38px; }
  .tv-search-section { padding-top: 0; }
  .placeholder-panel { display: grid; max-width: 760px; gap: 12px; padding: 34px; border: 1px solid var(--tv-line); border-radius: 17px; background: var(--tv-surface); }
  .placeholder-panel h2 { margin: 0; font-size: clamp(1.7rem, 3vw, 2.5rem); letter-spacing: -.05em; }
  .placeholder-panel p:not(.eyebrow) { max-width: 620px; margin: 0; color: var(--tv-muted); line-height: 1.6; }
  .tv-action-button { width: fit-content; padding: 14px 18px; border: 1px solid rgba(102, 220, 255, .32); border-radius: 11px; color: var(--tv-ink); background: var(--tv-surface-soft); font-size: .9rem; font-weight: 850; cursor: pointer; }
  .tv-footer-actions { display: flex; align-items: center; justify-content: space-between; gap: 24px; margin: 46px 6px 0; padding-top: 24px; border-top: 1px solid var(--tv-line); }
  .footer-note { display: grid; gap: 5px; max-width: 760px; color: var(--tv-muted); font-size: .9rem; font-weight: 650; line-height: 1.55; }
  .footer-note .eyebrow { margin: 0; }
  .tmdb-attribution { display: inline-flex; align-items: center; flex-wrap: wrap; gap: 5px; color: var(--tv-muted); font-size: .76rem; font-weight: 650; }
  .tmdb-attribution a { color: var(--tv-muted-strong); font-weight: 850; text-decoration: underline; text-underline-offset: 3px; }
  .tmdb-attribution .tmdb-credit { display: inline-flex; align-items: center; gap: 5px; }
  .tmdb-attribution img { width: 28px; height: 20px; object-fit: contain; }
  .quit-button { min-width: 176px; min-height: 56px; padding: 15px 20px; border: 2px solid rgba(255, 82, 112, .72); border-radius: 11px; color: #fff; background: rgba(255, 62, 94, .22); font-size: .96rem; font-weight: 900; cursor: pointer; }
  .exit-layer { position: fixed; inset: 0; z-index: 10; display: grid; place-items: center; padding: 30px; }
  .exit-backdrop { position: absolute; inset: 0; background: rgba(2, 4, 8, .84); }
  .exit-dialog { position: relative; width: min(100%, 560px); padding: 36px; border: 1px solid rgba(255,255,255,.18); border-radius: 20px; background: #151925; box-shadow: 0 30px 120px rgba(0,0,0,.6); }
  .exit-dialog h2 { margin: 0; font-size: clamp(2rem, 4vw, 3.2rem); letter-spacing: -.07em; }
  .exit-dialog > p:not(.eyebrow) { max-width: 440px; margin: 14px 0 0; color: var(--tv-muted); line-height: 1.6; }
  .exit-actions { display: flex; justify-content: flex-end; gap: 12px; margin-top: 30px; }
  .exit-button { min-width: 138px; padding: 15px 20px; border: 1px solid rgba(255,255,255,.18); border-radius: 11px; color: var(--tv-ink); background: var(--tv-surface-soft); font-size: .82rem; font-weight: 800; cursor: pointer; }
  .exit-button.confirm { border-color: var(--tv-accent); color: #fff; background: var(--tv-accent); }
  @media (max-width: 1100px) { .tv-main { padding-inline: 30px; } .tv-layout { grid-template-columns: 210px minmax(0, 1fr); gap: 26px; } }
  @media (max-width: 900px) { .tv-main { padding-inline: 22px; } .tv-layout { display: block; } .tv-sidebar { margin-bottom: 18px; } }
  @media (max-width: 760px) { .tv-hero { grid-template-columns: 1fr; padding-top: 30px; } .tv-footer-actions { align-items: flex-start; flex-direction: column; } .quit-button { width: 100%; } }
</style>
