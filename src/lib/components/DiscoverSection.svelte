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
  // The "Show more" button appends the next 10 items; the existing 10
  // remain. No full-page reload, no scroll reset. The fetch goes through
  // the cached /api/discover/rail endpoint.
  //
  // For anime sections (popular-anime / top-rated-anime) no dropdown is
  // rendered — they only get a "View all →" link to /discover/anime.

  import { onMount } from 'svelte';
  import { LoaderCircle, Plus, ArrowRight, RotateCw } from 'lucide-svelte';
  import type { MediaItem } from '$data/content';
  import MediaCard from '$components/MediaCard.svelte';
  import DiscoverDropdown from '$components/DiscoverDropdown.svelte';
  import SkeletonCard from '$components/SkeletonCard.svelte';
  import { getCachedRail, setCachedRail } from '$lib/client/discover/rail-cache';
  import { page } from '$app/state';
  import type { DiscoverLanguage, DiscoverSectionKey } from '$lib/server/content/types';

  type LanguageOption = { value: DiscoverLanguage; label: string };
  type ProviderOption = { value: string; label: string; logoUrl?: string };

  let {
    section,
    title,
    languageFilter = true,
    providerFilter = false,
    providers = [],
    viewAllHref = '',
    initialLanguage = 'all' as DiscoverLanguage,
    initialProvider = '',
    initialItems = [] as MediaItem[],
    excludeIds = [] as string[],
    batchPending = false,
  }: {
    section: DiscoverSectionKey;
    title: string;
    languageFilter?: boolean;
    providerFilter?: boolean;
    providers?: ProviderOption[];
    viewAllHref?: string;
    initialLanguage?: DiscoverLanguage;
    initialProvider?: string;
    initialItems?: MediaItem[];
    excludeIds?: string[];
    batchPending?: boolean;
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

  // Per-section independent state.
  let items = $state<MediaItem[]>([]);
  let loading = $state(false);
  let loadingMore = $state(false);
  let errorMessage = $state('');
  // Phase 2-L: separate error state for Show-more failures. The first-load
  // error replaces the empty state with an error message; the Show-more
  // error preserves the existing items and surfaces a retry action BELOW
  // them (never replaces the rail).
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

  // Phase 8 fix: railUrl now accepts an explicit exclude list instead of
  // relying on a boolean flag that only serialized the prop excludeIds.
  // This fixes the bug where current-rail items were NOT sent to the server.
  function railUrl(targetPage: number, excludeList: string[] = []) {
    const params = new URLSearchParams({
      section,
      language,
      page: String(targetPage),
    });
    if (providerFilter && provider) params.set('provider', provider);
    // Phase 8: send the exclude list for Show More so the server can
    // filter out items already displayed in higher-priority rails AND
    // in this rail's current items.
    if (excludeList.length > 0) {
      params.set('exclude', excludeList.slice(0, 500).join(','));
    }
    return `/api/discover/rail?${params.toString()}`;
  }

  async function loadFirst() {
    // Phase 8 fix: if initialItems were provided by the batch dedup AND
    // the user has NOT changed language/provider, use them directly.
    // The filterChanged flag ensures stale "all" language items are
    // never reused after a filter change.
    if (initialItems.length > 0 && !usedInitialItems && !filterChanged) {
      items = [...initialItems];
      currentPage = 1;
      hasNextPage = initialItems.length >= 10;
      loading = false;
      usedInitialItems = true;
      return;
    }

    // If batch is pending and we haven't changed filters, show loading
    // skeleton and wait — do NOT independently fetch page 1.
    if (batchPending && !filterChanged) {
      loading = true;
      return;
    }

    // Reset and fetch page 1.
    requestSequence += 1;
    const requestId = requestSequence;
    requestController?.abort();
    const controller = new AbortController();
    requestController = controller;
    loading = true;
    loadingMore = false;
    errorMessage = '';
    // Phase 2-G: check the in-memory rail cache first. A hit avoids the
    // network roundtrip on back-navigation (component remount). The cache
    // is per-user + TTL-bound (see rail-cache.ts for the safety contract).
    const url = railUrl(1);
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
      // error WITH a retry action. The rail is NOT replaced with an
      // error page — only the Show-more button reflects the failure.
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
    items = [];
    loading = true;
    void loadFirst();
  }

  onMount(() => {
    mounted = true;
    void loadFirst();
    return () => {
      mounted = false;
      requestSequence += 1;
      requestController?.abort();
    };
  });

  // Build the dropdown options. For language-filterable sections we
  // render the language dropdown. For the OTT section we render the
  // provider dropdown (with logos). Both are mutually exclusive in
  // the current spec (OTT has no language dropdown; other sections
  // have no provider dropdown) but the component supports both.
  let showLanguageDropdown = $derived(languageFilter);
  let showProviderDropdown = $derived(providerFilter && providers.length > 0);
  let showAnyControl = $derived(showLanguageDropdown || showProviderDropdown || Boolean(viewAllHref));
</script>

<section class="discover-section" aria-labelledby={`section-${section}-title`}>
  <div class="section-head">
    <div class="section-head-left">
      <h2 id={`section-${section}-title`} class="section-title">{title}</h2>
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
      <div class="rail">
        {#each items as item (item.type + ':' + item.id)}
          <MediaCard {item} />
        {/each}
      </div>
      {#if hasNextPage}
        <button
          class="show-more"
          type="button"
          onclick={loadMore}
          disabled={loadingMore}
          aria-label={`Show more ${title}`}
        >
          {#if loadingMore}<LoaderCircle size={14} />{:else}<Plus size={14} />{/if}
          <span>{loadingMore ? 'Loading…' : 'Show more'}</span>
        </button>
        <!-- Phase 2-L: Show-more failure preserves the existing rail AND
             surfaces the error with a retry. The rail is NOT replaced. -->
        {#if showMoreError}
          <div class="show-more-error" role="alert">
            <span>{showMoreError}</span>
            <button class="retry-btn" type="button" onclick={loadMore} disabled={loadingMore} aria-label={`Retry loading more ${title}`}>
              <RotateCw size={14} />
              <span>Retry</span>
            </button>
          </div>
        {/if}
      {/if}
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
  .section-head-left { min-width: 0; }
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
  .section-link {
    display: inline-flex; align-items: center; gap: 6px;
    color: var(--muted, #969696);
    font-size: .72rem; font-weight: 700; text-decoration: none;
    transition: color 150ms ease, transform 150ms ease;
  }
  .section-link:hover { color: var(--ink, #f5f5f5); transform: translateX(3px); }

  .section-body { min-height: 60px; }
  .rail {
    display: grid; grid-auto-flow: column; grid-auto-columns: 178px; gap: 14px;
    overflow-x: auto; overflow-y: visible; scroll-snap-type: x proximity;
    scrollbar-width: none; padding: 6px 2px 12px;
  }
  .rail::-webkit-scrollbar { display: none; }

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
  /* Phase 2-L: Show-more error — preserved rail + inline retry below. */
  .show-more-error {
    display: inline-flex; align-items: center; gap: 10px;
    margin-top: 8px;
    padding: 8px 14px;
    border: 1px solid rgba(255,176,32,.3);
    border-radius: 12px;
    color: #ffb020;
    background: rgba(255,176,32,.06);
    font-size: .72rem;
  }
  /* Phase 2-H: skeleton rail uses the same grid as the populated rail so
     the section height is stable from first paint. The skeleton cards
     are aria-hidden — the aria-busy + aria-live on the parent communicates
     the loading state to screen readers. */
  .skeleton-rail { min-height: 0; }
  @keyframes spin { to { transform: rotate(360deg); } }

  .show-more {
    display: inline-flex; align-items: center; gap: 6px;
    min-height: 34px;
    padding: 0 16px;
    margin-top: 4px;
    border: 1px solid rgba(255,255,255,.14);
    border-radius: 999px;
    color: #f5f5f5;
    background: rgba(255,255,255,.04);
    font: inherit;
    font-size: .7rem; font-weight: 700;
    cursor: pointer;
    transition: background 180ms ease, border-color 180ms ease;
  }
  .show-more:hover:not(:disabled) { background: rgba(255,255,255,.1); border-color: rgba(255,255,255,.28); }
  .show-more:focus-visible { outline: 2px solid #f5f5f5; outline-offset: 1px; }
  .show-more:disabled { opacity: .5; cursor: not-allowed; }
  .show-more :global(svg) { animation: spin 1s linear infinite; }

  @media (max-width: 640px) {
    .discover-section { margin-top: 28px; }
    .section-head { gap: 8px; }
    .section-title { font-size: 1.05rem; }
    .rail { grid-auto-columns: 40vw; gap: 10px; }
    .section-head-right { gap: 6px; }
  }
  @media (min-width: 1900px) {
    .rail { grid-auto-columns: 210px; gap: 18px; }
  }
  @media (prefers-reduced-motion: reduce) {
    .show-more :global(svg) { animation: none; }
  }
</style>
