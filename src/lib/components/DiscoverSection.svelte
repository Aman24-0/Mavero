<script lang="ts">
  // Reusable Discover section — owns its own independent state.
  //
  // Each DiscoverSection instance holds:
  //   - language / provider filter (reset to page 1 on change)
  //   - loaded items (appended across pages on Show more)
  //   - page counter
  //   - hasNextPage flag
  //   - loading / error flags
  //
  // Changing Action's language must NOT reset Popular Movie — each
  // section's state is local to this component instance.
  //
  // MAV-20 Phase B — content-type chips. The consolidated Discover page
  // renders ONE rail family per title (Popular, Top Rated, New on OTT,
  // every genre rail) with Movie / TV Shows / Anime chips. The PARENT
  // owns the selected type and re-keys this component on chip switch,
  // so a switch is a fresh mount with fresh state — the previous type's
  // items, pagination cursor, loading state and error CANNOT leak by
  // construction. The active variant is identified by the `section` +
  // `requestType` props (the rail request parameters), while the chips
  // themselves are rendered here (beside the title) from the
  // `typeFilter` / `activeType` / `onTypeChange` props.
  //
  // MAV-20 Phase C — Show More is an INLINE terminal card at the end of
  // the horizontal rail (not a separate row underneath). The endcap
  // occupies one rail column, matches the card geometry, never looks
  // like a fake poster (no artwork, dashed outline), and turns into the
  // loading / retry state in place. It disappears when the dataset is
  // exhausted; a failed load-more keeps the loaded items and surfaces
  // an inline retry inside the same endcap.
  //
  // The "Show more" card appends the next batch; the existing items
  // remain. No full-page reload, no scroll reset — appending grid
  // columns to the right keeps the user's horizontal position stable.
  // The fetch goes through the cached /api/discover/rail endpoint.
  //
  // For anime sections (popular-anime / top-rated-anime variants, and
  // the anime chips of new-ott + genre families) no language dropdown
  // is rendered — the parent passes languageFilter=false for them (the
  // anime catalog is Japanese by construction; the same reason the
  // Anime Explorer offers no language row).

  import { onMount } from 'svelte';
  import { ArrowRight, ChevronLeft, ChevronRight, LoaderCircle, Plus, RotateCw } from 'lucide-svelte';
  import type { MediaItem } from '$data/content';
  import MediaCard from '$components/MediaCard.svelte';
  import DiscoverDropdown from '$components/DiscoverDropdown.svelte';
  import SkeletonCard from '$components/SkeletonCard.svelte';
  import { getCachedRail, setCachedRail } from '$lib/client/discover/rail-cache';
  import { page } from '$app/state';
  // MAV-25 WS1 — the ESTABLISHED carousel navigation behaviour (the same
  // edge-state + stepped-scroll contract ContentRail ships) as ONE shared
  // helper — no conflicting duplicate abstraction.
  import { railEdgeState, scrollRailByCards } from '$lib/shared/rail-navigation';
  // MAV-25 WS2 — the pure visible-row fill math (card-pitch → slot target)
  // and its bounded-fetch budgets.
  import { rowFillTarget, ROW_FILL_ITEM_CAP, ROW_FILL_FETCH_BUDGET } from '$lib/shared/rail-row-fill';
  import type { DiscoverLanguage, DiscoverRailType, DiscoverSectionKey } from '$lib/server/content/types';
  // Phase 9 fix: import the pure decision function from the SHARED module
  // (not from $lib/server/* which is server-only and rejected by the
  // SvelteKit browser-bundle guard).
  import { decideSectionLoad } from '$lib/shared/discover-batch';

  // Phase 9 fix: the batch lifecycle is now an explicit state machine.
  //
  //   pending → success | failed
  //
  // - pending:  DiscoverSection shows a loading skeleton and waits. It
  //             MUST NOT independently fetch /api/discover/rail — that
  //             would bypass the global cross-rail dedup contract.
  // - success:  DiscoverSection consumes the batch result for its section,
  //             EVEN IF initialItems is empty. An empty successful rail
  //             is the authoritative initial dataset, not a signal to
  //             fall back to independent fetching.
  // - failed:   Only then may DiscoverSection fall back to an independent
  //             /api/discover/rail fetch.
  //
  // The decision tree is centralized in `decideSectionLoad()` (pure
  // function — see discover-dedup.ts) so it is unit-testable without
  // rendering the component.
  //
  // Phase 9 fix: `initialHasNextPage` and `initialPage` are passed
  // explicitly from the batch result. We no longer infer hasNextPage
  // from `initialItems.length >= 10` — the batch result is authoritative.
  // `initialPage` reflects the ACTUAL last page the batch consumed for
  // this section, so Show More computes `nextPage = currentPage + 1`
  // from the correct continuation point (never re-fetching already-
  // consumed pages).
  //
  // MAV-20 Phase B: the parent passes 'failed' for chip variants that
  // are NOT part of the batch payload (the TV Shows / Anime variants of
  // the new-ott + genre families) — meaning "no batch dataset exists
  // for this variant; an independent fetch is allowed". The parent only
  // does that once the batch has RESOLVED (passing 'pending' until
  // then), so the independent fetch can carry the full cross-rail
  // exclude list and never races the dedup foundation.
  type BatchStatus = 'pending' | 'success' | 'failed';

  type LanguageOption = { value: DiscoverLanguage; label: string };
  type ProviderOption = { value: string; label: string; logoUrl?: string };

  let {
    section,
    requestType = undefined,
    title,
    typeFilter = false,
    activeType = 'movie',
    onTypeChange = undefined,
    languageFilter = true,
    providerFilter = false,
    providers = [],
    viewAllHref = '',
    initialLanguage = 'all' as DiscoverLanguage,
    initialProvider = '',
    initialItems = [] as MediaItem[],
    initialHasNextPage = false,
    initialPage = 1,
    excludeIds = [] as string[],
    batchStatus = 'pending' as BatchStatus,
  }: {
    /** The ACTIVE variant's rail section key (e.g. 'popular-series', 'genre-action', 'new-ott'). */
    section: DiscoverSectionKey;
    /** The ACTIVE variant's content-type dimension — only for new-ott / genre-* variants. */
    requestType?: DiscoverRailType;
    title: string;
    /** Render the Movie / TV Shows / Anime chips beside the title. */
    typeFilter?: boolean;
    /** The currently selected chip (parent-owned). */
    activeType?: DiscoverRailType;
    /** Chip switch handler (parent re-keys this component on change). */
    onTypeChange?: (type: DiscoverRailType) => void;
    languageFilter?: boolean;
    providerFilter?: boolean;
    providers?: ProviderOption[];
    viewAllHref?: string;
    initialLanguage?: DiscoverLanguage;
    initialProvider?: string;
    initialItems?: MediaItem[];
    initialHasNextPage?: boolean;
    initialPage?: number;
    excludeIds?: string[];
    batchStatus?: BatchStatus;
  } = $props();

  const LANGUAGE_OPTIONS: LanguageOption[] = [
    { value: 'all', label: 'All' },
    { value: 'hi', label: 'Hindi' },
    { value: 'en', label: 'English' },
    { value: 'ta', label: 'Tamil' },
    { value: 'te', label: 'Telugu' },
    { value: 'ml', label: 'Malayalam' },
    { value: 'kn', label: 'Kannada' },
    { value: 'other', label: 'Other language' },
  ];

  // MAV-20 Phase B — the three compact content-type chips shown beside
  // the section title. Labels follow the task spec exactly: Movie /
  // TV Shows / Anime.
  const TYPE_CHIP_OPTIONS: { value: DiscoverRailType; label: string }[] = [
    { value: 'movie', label: 'Movie' },
    { value: 'series', label: 'TV Shows' },
    { value: 'anime', label: 'Anime' },
  ];

  // Per-section independent state.
  let items = $state<MediaItem[]>([]);
  let loading = $state(false);
  let loadingMore = $state(false);
  let errorMessage = $state('');
  // Phase 2-L: separate error state for Show-more failures. The first-load
  // error replaces the empty state with an error message; the Show-more
  // error preserves the existing items and surfaces a retry action INSIDE
  // the inline endcap (never replaces the rail).
  let showMoreError = $state('');
  let currentPage = $state(1);
  let hasNextPage = $state(false);
  // Phase 8: tracks whether initialItems from the batch dedup were used.
  // When true, loadFirst() uses the provided initialItems instead of
  // fetching independently. On language/provider change, the flag is
  // cleared and a normal fetch is performed.
  let usedInitialItems = $state(false);
  // Phase 8 fix: tracks whether the user has changed language/provider.
  // Once true, the original batch initialItems are NEVER reused — even
  // if usedInitialItems is reset to false. This prevents stale "all"
  // language items from appearing after a filter change.
  let filterChanged = $state(false);
  // svelte-ignore state_referenced_locally -- intentional initial-value capture; initialLanguage is a prop snapshot
  let language = $state<DiscoverLanguage>(initialLanguage);
  // svelte-ignore state_referenced_locally -- intentional initial-value capture; initialProvider is a prop snapshot
  let provider = $state<string>(initialProvider);
  let requestSequence = 0;
  let requestController: AbortController | undefined;
  let mounted = false;

  // ============================================================
  // MAV-25 WS1 — rail navigation arrows (the ContentRail §11 contract).
  // Edge state derives from the rail's own scrollLeft/scrollWidth on
  // every scroll event + after the item set, container or viewport
  // changes (ResizeObserver on the rail). Arrows scroll ONLY this
  // section's rail — never the page, never another rail.
  // ============================================================
  let railEl: HTMLElement | undefined = $state();
  let atStart = $state(true);
  let atEnd = $state(false);

  function updateRailState(): void {
    if (!railEl) return;
    const edge = railEdgeState(railEl);
    atStart = edge.atStart;
    atEnd = edge.atEnd;
  }

  function scrollByCard(direction: 1 | -1): void {
    if (!railEl) return;
    scrollRailByCards(railEl, direction);
  }

  // ============================================================
  // MAV-25 WS2 — visible-row fill. The batch targets 10 items/rail;
  // dedup-starved rails (the genre tail, language-filtered variants)
  // can land with fewer items than a desktop row holds. When the rail's
  // ACTUAL container (clientWidth — sidebar/gutters already excluded)
  // fits more cards than are loaded AND more pages exist, additional
  // pages are fetched through the EXISTING Show More pipeline (same
  // endpoint, exclude contract, dedupe and loading guards) — bounded by
  // ROW_FILL_FETCH_BUDGET + ROW_FILL_ITEM_CAP, re-evaluated on
  // target-changing resizes, and never manufacturing placeholders.
  // Mobile is unaffected: at the 40vw card pitch the target is 2-3, so
  // the initially loaded items always satisfy it and NO extra fetch
  // ever fires — the mobile initial count and swipe behaviour are
  // preserved by construction.
  // ============================================================
  let fillFetchesUsed = 0;
  let lastFillTarget = 0;
  let fillToken = 0;
  let fillScheduled = false;

  function currentFillTarget(): number {
    if (!railEl) return 1;
    const firstCard = railEl.querySelector<HTMLElement>(':scope > *');
    if (!firstCard) return 1;
    const cardWidth = firstCard.getBoundingClientRect().width;
    const gap = parseFloat(getComputedStyle(railEl).columnGap || getComputedStyle(railEl).gap || '0') || 0;
    return rowFillTarget({
      containerWidth: railEl.clientWidth,
      cardWidth,
      gap,
      hasMore: hasNextPage,
    });
  }

  function scheduleRowFill(): void {
    if (fillScheduled || !mounted) return;
    fillScheduled = true;
    requestAnimationFrame(() => {
      fillScheduled = false;
      void runRowFill();
    });
  }

  async function runRowFill(): Promise<void> {
    if (!mounted || loading || loadingMore || showMoreError) return;
    if (!hasNextPage || items.length === 0) return;
    if (items.length >= ROW_FILL_ITEM_CAP) return;
    const target = currentFillTarget();
    if (items.length >= target) {
      lastFillTarget = target;
      return;
    }
    if (fillFetchesUsed >= ROW_FILL_FETCH_BUDGET) return;
    lastFillTarget = target;
    const token = ++fillToken;
    // One bounded fetch per iteration; the trigger effect re-runs the
    // driver after each append until the row is filled, the rail is
    // exhausted, the budget is spent or a Show More error surfaces.
    fillFetchesUsed += 1;
    await loadMore();
    if (token !== fillToken) return; // superseded by a filter change/retry
    scheduleRowFill();
  }

  function onRailResize(): void {
    updateRailState();
    // Only re-evaluate the fill when the DERIVED target changed — a
    // scroll-width-only mutation (appended columns) must never trigger
    // more requests (no layout loops, no duplicate pagination).
    const target = currentFillTarget();
    if (target !== lastFillTarget) scheduleRowFill();
  }

  // Phase 8 fix: railUrl now accepts an explicit exclude list instead of
  // relying on a boolean flag that only serialized the prop excludeIds.
  // This fixes the bug where current-rail items were NOT sent to the server.
  // MAV-20 Phase B: the content-type dimension is part of the rail URL —
  // and therefore of the client rail-cache key — so each chip variant
  // has its own cache entries (no cross-type cache leakage).
  function railUrl(targetPage: number, excludeList: string[] = []) {
    const params = new URLSearchParams({
      section,
      language,
      page: String(targetPage),
    });
    if (requestType) params.set('type', requestType);
    if (providerFilter && provider) params.set('provider', provider);
    // Phase 8: send the exclude list for Show More so the server can
    // filter out items already displayed in higher-priority rails AND
    // in this rail's current items.
    // MAV-20: the FIRST load of a non-batch chip variant (and any
    // language/provider change) sends the cross-rail exclude list too —
    // an independent fetch must honor the same cross-rail dedup contract
    // the batch enforces server-side.
    if (excludeList.length > 0) {
      params.set('exclude', excludeList.slice(0, 500).join(','));
    }
    return `/api/discover/rail?${params.toString()}`;
  }

  async function loadFirst() {
    // Phase 9 fix: use the pure decision function so the batch lifecycle
    // is unambiguous and unit-testable. The decision tree:
    //   - filterChanged        → fetch independently (stale batch unusable)
    //   - batch pending        → wait, do NOT fetch independently
    //   - batch failed         → fall back to independent fetch
    //   - batch success + not-yet-consumed → consume batch result,
    //     EVEN IF EMPTY. This is the critical correctness invariant:
    //     an empty successful rail is authoritative, not a signal to
    //     bypass dedup with an independent fetch.
    //   - batch success + already consumed → independent fetch (retry)
    const decision = decideSectionLoad({
      batchStatus,
      filterChanged,
      usedInitialItems,
      initialHasNextPage,
      initialPage,
    });

    if (decision.kind === 'wait') {
      // Batch pending — show skeleton, do NOT fetch.
      loading = true;
      return;
    }

    if (decision.kind === 'use-batch') {
      // Batch success — consume the result even if empty.
      // Phase 9 fix: use the authoritative hasNextPage from the batch,
      // NOT the heuristic `initialItems.length >= 10`.
      // Phase 9 fix: use the actual last-fetched page from the batch,
      // so Show More resumes from the correct continuation page.
      items = [...initialItems];
      currentPage = decision.page;
      hasNextPage = decision.hasNextPage;
      loading = false;
      usedInitialItems = true;
      return;
    }

    // decision.kind === 'fetch' — independent fetch path.
    requestSequence += 1;
    const requestId = requestSequence;
    requestController?.abort();
    const controller = new AbortController();
    requestController = controller;
    loading = true;
    loadingMore = false;
    errorMessage = '';
    // MAV-20: the independent first load carries the cross-rail exclude
    // list (higher-priority rails' canonical IDs) so it cannot
    // re-introduce items already displayed above — the same invariant
    // the server-side batch dedup enforces.
    const url = railUrl(1, excludeIds);
    // Phase 2-G: check the in-memory rail cache first. A hit avoids the
    // network roundtrip on back-navigation (component remount). The cache
    // is per-user + TTL-bound (see rail-cache.ts for the safety contract).
    const cached = getCachedRail<MediaItem>(url, page.data.user?.id);
    if (cached) {
      items = cached.items;
      currentPage = 1;
      hasNextPage = cached.hasNextPage;
      loading = false;
      requestController = undefined;
      return;
    }
    try {
      const response = await fetch(url, { signal: controller.signal });
      if (requestId !== requestSequence || controller.signal.aborted) return;
      const payload = await response.json();
      if (!response.ok || !payload.ok) throw new Error(payload?.error?.message || 'Section is temporarily unavailable.');
      if (requestId !== requestSequence) return;
      items = payload.items as MediaItem[];
      currentPage = 1;
      hasNextPage = Boolean(payload.hasNextPage);
      // Phase 2-G: store in the cache for the next back-nav.
      setCachedRail(url, page.data.user?.id, items, hasNextPage);
    } catch (error) {
      if (controller.signal.aborted || requestId !== requestSequence) return;
      errorMessage = error instanceof Error ? error.message : 'Section is temporarily unavailable.';
      items = [];
      hasNextPage = false;
    } finally {
      if (requestId === requestSequence) {
        loading = false;
        requestController = undefined;
      }
    }
  }

  async function loadMore() {
    if (loading || loadingMore || !hasNextPage) return;
    requestSequence += 1;
    const requestId = requestSequence;
    // Don't abort — let the in-flight first-load finish if any. But we
    // do track requestId so a stale Show-more response can't overwrite
    // a newer language-switch first-load.
    loadingMore = true;
    showMoreError = ''; // Phase 2-L: clear any previous Show-more error.
    try {
      const nextPage = currentPage + 1;
      // Phase 8 fix: build the COMBINED exclude list (higher-priority
      // rail IDs + current rail items) and pass it explicitly to railUrl().
      // The previous code called railUrl(nextPage, true) which only
      // serialized the prop excludeIds — current-rail items were NOT sent.
      const allExclude = [...excludeIds, ...items.map(i => `${i.type}:${i.externalIds?.tmdb ?? i.id}`)];
      const response = await fetch(railUrl(nextPage, allExclude));
      if (requestId !== requestSequence) return;
      const payload = await response.json();
      if (!response.ok || !payload.ok) throw new Error(payload?.error?.message || 'Could not load more titles.');
      if (requestId !== requestSequence) return;
      // Append to existing — do NOT replace.
      const incoming = payload.items as MediaItem[];
      // Dedupe by canonical type+id (defensive against upstream dupes).
      const seen = new Set(allExclude);
      for (const item of incoming) {
        const key = `${item.type}:${item.id}`;
        if (!seen.has(key)) {
          items = [...items, item];
          seen.add(key);
        }
      }
      currentPage = nextPage;
      hasNextPage = Boolean(payload.hasNextPage);
    } catch (error) {
      if (requestId !== requestSequence) return;
      // Phase 2-L: keep existing items visible AND surface a transient
      // error WITH a retry action INSIDE the inline endcap. The rail is
      // NOT replaced with an error page — only the endcap reflects the
      // failure (it becomes the Retry card in place).
      showMoreError = error instanceof Error ? error.message : 'Could not load more titles.';
    } finally {
      if (requestId === requestSequence) loadingMore = false;
    }
  }

  function changeLanguage(next: string) {
    const nextLang = next as DiscoverLanguage;
    if (nextLang === language) return;
    language = nextLang;
    // Phase 8 fix: set filterChanged so stale "all" language initialItems
    // are NEVER reused. A fresh filtered rail request will be performed.
    usedInitialItems = false;
    filterChanged = true;
    // MAV-25 WS2: a filter change is a NEW logical load — the row-fill
    // budget resets with it and any in-flight fill is invalidated.
    fillFetchesUsed = 0;
    lastFillTarget = 0;
    fillToken += 1;
    // Clear items to show loading skeleton for the new language.
    items = [];
    loading = true;
    // Reset to page 1, replace results (do NOT append old-language items).
    void loadFirst();
  }

  function changeProvider(next: string) {
    if (next === provider) return;
    provider = next;
    // Phase 8 fix: same as language change — stale initialItems must not be reused.
    usedInitialItems = false;
    filterChanged = true;
    // MAV-25 WS2: same new-logical-load budget reset as language change.
    fillFetchesUsed = 0;
    lastFillTarget = 0;
    fillToken += 1;
    items = [];
    loading = true;
    void loadFirst();
  }

  function changeType(next: DiscoverRailType) {
    if (next === activeType) return;
    // The parent owns the type selection and re-keys this component on
    // change — a fresh instance mounts with the new variant's props
    // (section/requestType/initialItems). This handler only forwards
    // the selection; no local state to migrate (nothing can leak).
    onTypeChange?.(next);
  }

  onMount(() => {
    mounted = true;
    void loadFirst();
    return () => {
      mounted = false;
      requestSequence += 1;
      requestController?.abort();
      fillToken += 1;
    };
  });

  // MAV-25 WS1 — edge-state + fill re-evaluation on container/viewport
  // changes. The rail element only exists once data lands (the loading
  // state renders the skeleton instead), so the observer attaches
  // REACTIVELY to `railEl` — this effect re-runs when the populated rail
  // mounts and cleans up the observer when it unmounts (no stale
  // observers, no leaks on chip-variant remounts). The responsive card
  // pitch (178px base / 40vw mobile / 210px TV) flows through here as a
  // measured clientWidth change, never a viewport guess.
  $effect(() => {
    const rail = railEl;
    if (!rail) return;
    updateRailState();
    const resizeObserver =
      typeof ResizeObserver === 'function' ? new ResizeObserver(() => onRailResize()) : undefined;
    resizeObserver?.observe(rail);
    return () => resizeObserver?.disconnect();
  });

  // Re-sync the arrow edge state whenever the item set changes (a rail
  // whose items grow may no longer be at the end), and (re-)evaluate the
  // MAV-25 WS2 visible-row fill once a load settles. The fill driver is
  // scheduled via rAF so this effect only ESTABLISHES tracking of the
  // settle signals — the async work (and its state writes) runs outside
  // the effect, preventing effect loops.
  $effect(() => {
    void items.length;
    void hasNextPage;
    void loading;
    void loadingMore;
    updateRailState();
    if (!loading && !loadingMore && items.length > 0) scheduleRowFill();
  });

  // Phase 9 fix: reactive $effect that re-calls loadFirst() when
  // batchStatus transitions out of 'pending'. This is the critical
  // missing piece — without this, DiscoverSection shows a skeleton
  // forever after the batch resolves because loadFirst() was only
  // called once (during onMount) and returned early due to pending.
  //
  // When batchStatus leaves 'pending':
  //   - If batch succeeded: decideSectionLoad() returns 'use-batch' →
  //     loadFirst() consumes initialItems (even if empty) directly,
  //     preserving initialHasNextPage and initialPage.
  //   - If batch failed: decideSectionLoad() returns 'fetch' →
  //     loadFirst() falls through to the independent fetch path.
  //
  // The guard `!filterChanged` ensures we don't re-trigger after the
  // user has changed language/provider (those paths already call
  // loadFirst() directly).
  // svelte-ignore state_referenced_locally -- intentional initial-value capture for transition detection
  let lastBatchStatus: BatchStatus = batchStatus;
  $effect(() => {
    const nowStatus: BatchStatus = batchStatus;
    if (lastBatchStatus === 'pending' && nowStatus !== 'pending' && !filterChanged && mounted) {
      void loadFirst();
    }
    lastBatchStatus = nowStatus;
  });

  // Build the dropdown options. For language-filterable sections we
  // render the language dropdown. For the OTT section we render the
  // provider dropdown (with logos). Both are mutually exclusive in the
  // current spec (OTT has no language dropdown; other sections
  // have no provider dropdown) but the component supports both.
  let showLanguageDropdown = $derived(languageFilter);
  let showProviderDropdown = $derived(providerFilter && providers.length > 0);
  let showAnyControl = $derived(showLanguageDropdown || showProviderDropdown || Boolean(viewAllHref));
</script>

<section class="discover-section" aria-labelledby={`section-${section}${requestType ? `-${requestType}` : ''}-title`}>
  <div class="section-head">
    <div class="section-head-left">
      <h2 id={`section-${section}${requestType ? `-${requestType}` : ''}-title`} class="section-title">{title}</h2>
      {#if typeFilter}
        <!-- MAV-20 Phase B — the three compact content-type chips beside
             the title. aria-pressed communicates the selection; the
             buttons are real buttons (keyboard + touch accessible). -->
        <div class="type-chips" role="group" aria-label={`Filter ${title} by content type`}>
          {#each TYPE_CHIP_OPTIONS as chip (chip.value)}
            <button
              class="type-chip"
              class:active={activeType === chip.value}
              type="button"
              aria-pressed={activeType === chip.value}
              onclick={() => changeType(chip.value)}
            >{chip.label}</button>
          {/each}
        </div>
      {/if}
    </div>
    <div class="section-head-right">
      {#if showProviderDropdown}
        <DiscoverDropdown
          label="All OTT"
          ariaLabel={`Filter ${title} by streaming provider`}
          options={[{ value: '', label: 'All OTT' }, ...providers]}
          value={provider}
          onChange={changeProvider}
        />
      {/if}
      {#if showLanguageDropdown}
        <DiscoverDropdown
          label="All"
          ariaLabel={`Filter ${title} by language`}
          options={LANGUAGE_OPTIONS}
          value={language}
          onChange={changeLanguage}
        />
      {/if}
      {#if viewAllHref}
        <a class="section-link" href={viewAllHref}>View all <ArrowRight size={14} /></a>
      {/if}
    </div>
  </div>

  <div class="section-body">
    {#if loading}
      <!-- Phase 2-H: skeleton rail (stable layout) instead of an empty spinner.
           The skeleton uses the SAME grid as the populated rail so the
           section height is stable from first paint — no jump from
           empty -> spinner -> rail. -->
      <div class="rail skeleton-rail" aria-busy="true" aria-live="polite">
        {#each Array(6) as _, i (i)}<SkeletonCard />{/each}
      </div>
    {:else if errorMessage && items.length === 0}
      <div class="section-error" role="alert">
        <span>{errorMessage}</span>
        <!-- Phase 2-L: retry button for first-load failure. -->
        <button class="retry-btn" type="button" onclick={() => loadFirst()} aria-label={`Retry loading ${title}`}>
          <RotateCw size={14} />
          <span>Retry</span>
        </button>
      </div>
    {:else if items.length === 0}
      <div class="section-empty" aria-live="polite">
        <span>No titles available right now.</span>
      </div>
    {:else}
      <!-- MAV-20 Phase C — the rail itself, with the Show More control as
           an INLINE terminal item at the end of the horizontal list (not
           a separate row underneath). Appending new grid columns to the
           right keeps the user's horizontal scroll position stable. -->
      <!-- MAV-25 WS1 — the rail-wrap hosts the ESTABLISHED edge-aligned
           navigation arrows (the ContentRail §11 pattern): VISIBLE on
           ≥641px pointer surfaces, DISABLED (not clickable dead) at the
           actual scroll ends, hidden on ≤640px phones where native swipe
           stays the primary interaction. The arrows sit OUTSIDE the rail
           scrollport and scroll ONLY this rail — never the page, never
           another section's rail. -->
      <div class="rail-wrap">
        <button
          type="button"
          class="rail-nav rail-nav-prev"
          aria-label={`Scroll ${title} left`}
          disabled={atStart}
          onclick={() => scrollByCard(-1)}
        >
          <ChevronLeft size={18} />
        </button>
        <button
          type="button"
          class="rail-nav rail-nav-next"
          aria-label={`Scroll ${title} right`}
          disabled={atEnd}
          onclick={() => scrollByCard(1)}
        >
          <ChevronRight size={18} />
        </button>
        <div
          class="rail"
          bind:this={railEl}
          onscroll={updateRailState}
        >
          {#each items as item (item.type + ':' + item.id)}
            <MediaCard {item} />
          {/each}
          {#if hasNextPage}
            <div class="rail-endcap">
              <button
                class="show-more-card"
                class:retry={Boolean(showMoreError)}
                type="button"
                onclick={loadMore}
                disabled={loadingMore}
                aria-label={showMoreError ? `Retry loading more ${title}` : `Show more ${title}`}
              >
                {#if loadingMore}
                  <LoaderCircle size={18} aria-hidden="true" />
                  <span>Loading…</span>
                {:else if showMoreError}
                  <RotateCw size={18} aria-hidden="true" />
                  <span>Retry</span>
                {:else}
                  <Plus size={18} aria-hidden="true" />
                  <span>Show more</span>
                {/if}
              </button>
              <!-- Phase 2-L: Show-more failure preserves the existing rail AND
                   surfaces the error inside the same endcap. The rail is NOT
                   replaced. -->
              {#if showMoreError}
                <p class="show-more-error" role="alert">{showMoreError}</p>
              {/if}
            </div>
          {/if}
        </div>
      </div>
    {/if}
  </div>
</section>

<style>
  .discover-section {
    margin-top: 36px;
    padding: 0 var(--d-gutter, clamp(16px, 5vw, 48px));
  }
  .section-head {
    display: flex; align-items: end; justify-content: space-between; gap: 12px;
    margin-bottom: 14px;
  }
  .section-head-left {
    min-width: 0;
    display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
  }
  .section-head-right {
    display: inline-flex; align-items: center; gap: 10px;
    flex-shrink: 0;
  }
  .section-title {
    margin: 0;
    color: var(--ink, #f5f5f5);
    font-family: 'Inter', sans-serif;
    font-size: clamp(1.05rem, 1.8vw, 1.35rem);
    font-weight: 800;
    letter-spacing: -.02em;
    line-height: 1.1;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }

  /* MAV-20 Phase B — compact content-type chips beside the title.
     Active chip: filled with the dynamic accent theme (the same
     --color-primary token every Mavero control uses); inactive chips:
     quiet bordered pills. Real buttons — keyboard focusable, visible
     focus ring, aria-pressed state. */
  .type-chips {
    display: inline-flex; align-items: center; gap: 5px;
    flex-shrink: 0;
  }
  .type-chip {
    display: inline-flex; align-items: center;
    min-height: 26px;
    padding: 0 11px;
    border: 1px solid rgba(255, 255, 255, .14);
    border-radius: 999px;
    color: var(--muted, #969696);
    background: rgba(255, 255, 255, .03);
    font: inherit;
    font-size: .64rem; font-weight: 700;
    letter-spacing: .02em;
    cursor: pointer;
    transition: background 160ms ease, border-color 160ms ease, color 160ms ease;
  }
  .type-chip:hover { color: var(--ink, #f5f5f5); background: rgba(255, 255, 255, .07); border-color: rgba(255, 255, 255, .26); }
  .type-chip:focus-visible { outline: 2px solid var(--color-focus, #f5f5f5); outline-offset: 1px; }
  .type-chip.active {
    color: #050708;
    background: var(--color-primary, #00ff9c);
    border-color: var(--color-primary, #00ff9c);
    box-shadow: 0 0 14px rgba(0, 255, 156, .22);
  }

  .section-link {
    display: inline-flex; align-items: center; gap: 6px;
    color: var(--muted, #969696);
    font-size: .72rem; font-weight: 700; text-decoration: none;
    transition: color 150ms ease, transform 150ms ease;
  }
  .section-link:hover { color: var(--ink, #f5f5f5); transform: translateX(3px); }

  .section-body { min-height: 60px; }
  /* MAV-25 WS1 — the rail-wrap clips overflow and hosts the edge-aligned
     navigation arrows OUTSIDE the rail scrollport (the ContentRail §11
     composition: a true edge overlay that never covers mid-scroll card
     content with layout-shifting appear/disappear behaviour — the slot
     stays, the disabled state communicates the end). */
  .rail-wrap { position: relative; overflow: hidden; border-radius: 14px; }
  .rail {
    display: grid; grid-auto-flow: column; grid-auto-columns: 178px; gap: 14px;
    overflow-x: auto; overflow-y: visible; scroll-snap-type: x proximity;
    scrollbar-width: none; padding: 6px 2px 12px;
  }
  .rail::-webkit-scrollbar { display: none; }

  /* MAV-25 WS1 — the shared carousel navigation arrows. Same visual
     language as ContentRail's .rail-nav (glass panel, focus ring, hover
     glow, disabled-at-the-ends). Hidden on ≤640px phones — native
     horizontal scroll remains the mobile interaction. */
  .rail-nav {
    position: absolute; top: 50%; transform: translateY(-50%);
    z-index: 6;
    display: grid; place-items: center;
    width: 38px; height: 56px;
    border: 1px solid var(--color-border-strong, rgba(255, 255, 255, .18)); border-radius: var(--radius-md, 12px);
    background: rgba(8, 11, 13, .82); backdrop-filter: blur(12px);
    color: var(--ink, #f5f5f5);
    cursor: pointer;
    transition: opacity var(--motion-fast, 150ms) var(--ease-out, ease-out), background var(--motion-fast, 150ms) var(--ease-out, ease-out), border-color var(--motion-fast, 150ms) var(--ease-out, ease-out), box-shadow var(--motion-fast, 150ms) var(--ease-out, ease-out);
  }
  .rail-nav:focus-visible {
    outline: 2px solid var(--color-focus, #f5f5f5); outline-offset: 2px;
  }
  .rail-nav:hover:not(:disabled) {
    background: rgba(0, 255, 156, .12);
    border-color: var(--color-primary-border, rgba(0, 255, 156, .4));
    box-shadow: var(--glow-primary, 0 0 18px rgba(0, 255, 156, .18));
  }
  /* Edge state: visibly and functionally off at the scroll ends (the
     layout slot stays — no arrow appear/disappear jumpiness). */
  .rail-nav:disabled {
    opacity: .22;
    pointer-events: none;
    box-shadow: none;
  }
  .rail-nav-prev { left: 6px; }
  .rail-nav-next { right: 6px; }

  /* MAV-20 Phase C — the inline terminal Show More card. Occupies one
     rail column (same grid geometry as the cards — no distortion), but
     is deliberately NOT poster-shaped: a dashed-outline glass panel
     with a centered icon + label. It stretches to the row height so it
     fits the rail's card geometry at every breakpoint. */
  .rail-endcap {
    display: flex; flex-direction: column; gap: 6px;
    min-width: 0;
  }
  .show-more-card {
    flex: 1;
    display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px;
    padding: 12px;
    border: 1px dashed rgba(255, 255, 255, .2);
    border-radius: 14px;
    color: var(--ink, #f5f5f5);
    background: rgba(255, 255, 255, .03);
    font: inherit;
    font-size: .7rem; font-weight: 700;
    cursor: pointer;
    transition: background 180ms ease, border-color 180ms ease;
  }
  .show-more-card:hover:not(:disabled) { background: rgba(255, 255, 255, .08); border-color: rgba(255, 255, 255, .38); }
  .show-more-card:focus-visible { outline: 2px solid var(--color-focus, #f5f5f5); outline-offset: 2px; }
  .show-more-card:disabled { opacity: .55; cursor: not-allowed; }
  .show-more-card :global(svg) { animation: spin 1s linear infinite; }
  /* Failure state: the SAME endcap becomes the retry card in place —
     the loaded items are never discarded. */
  .show-more-card.retry { border-style: solid; border-color: rgba(255, 176, 32, .45); color: #ffb020; background: rgba(255, 176, 32, .06); }
  .show-more-card.retry:hover:not(:disabled) { background: rgba(255, 176, 32, .14); border-color: rgba(255, 176, 32, .65); }
  .show-more-error {
    margin: 0;
    color: #ffb020;
    font-size: .62rem; font-weight: 600; line-height: 1.35;
    text-align: center;
  }

  .section-error, .section-empty {
    display: grid; place-items: center; gap: 8px;
    min-height: 120px;
    color: var(--muted, #777);
    font-size: .74rem;
  }
  .section-error { color: #ffb020; flex-direction: column; gap: 12px; }
  /* Phase 2-L: retry button — same visual language as Show-more. */
  .retry-btn {
    display: inline-flex; align-items: center; gap: 6px;
    min-height: 34px;
    padding: 0 16px;
    border: 1px solid rgba(255,176,32,.4);
    border-radius: 999px;
    color: #ffb020;
    background: rgba(255,176,32,.08);
    font: inherit;
    font-size: .7rem; font-weight: 700;
    cursor: pointer;
    transition: background 180ms ease, border-color 180ms ease;
  }
  .retry-btn:hover:not(:disabled) { background: rgba(255,176,32,.16); border-color: rgba(255,176,32,.6); }
  .retry-btn:focus-visible { outline: 2px solid #ffb020; outline-offset: 1px; }
  .retry-btn:disabled { opacity: .5; cursor: not-allowed; }
  .retry-btn :global(svg) { animation: spin 1s linear infinite; }
  /* Phase 2-H: skeleton rail uses the same grid as the populated rail so
     the section height is stable from first paint. The skeleton cards
     are aria-hidden — the aria-busy + aria-live on the parent communicates
     the loading state to screen readers. */
  .skeleton-rail { min-height: 0; }
  @keyframes spin { to { transform: rotate(360deg); } }

  @media (max-width: 640px) {
    .discover-section { margin-top: 28px; }
    .section-head { gap: 8px; }
    .section-title { font-size: 1.05rem; }
    .rail { grid-auto-columns: 40vw; gap: 10px; }
    .section-head-right { gap: 6px; }
    /* MAV-25 WS1 — hide the navigation arrows on phones: native
       horizontal swipe is the primary interaction and the existing
       mobile design is preserved unchanged. */
    .rail-nav { display: none; }
    /* Compact chips on mobile — the header stays tight. */
    .section-head-left { gap: 8px; }
    .type-chips { gap: 4px; }
    .type-chip { min-height: 24px; padding: 0 9px; font-size: .6rem; }
  }
  @media (min-width: 1900px) {
    .rail { grid-auto-columns: 210px; gap: 18px; }
    /* MAV-25 WS1 — TV-scale arrows for the TV-scale card pitch. */
    .rail-nav { width: 44px; height: 64px; }
  }
  @media (prefers-reduced-motion: reduce) {
    .show-more-card :global(svg) { animation: none; }
    .type-chip, .show-more-card { transition: none; }
    /* MAV-25 WS1 — reduced motion: the arrows never animate. */
    .rail-nav { transition: none; }
  }
</style>
