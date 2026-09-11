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
  import { LoaderCircle, Plus, ArrowRight } from 'lucide-svelte';
  import type { MediaItem } from '$data/content';
  import MediaCard from '$components/MediaCard.svelte';
  import DiscoverDropdown from '$components/DiscoverDropdown.svelte';
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
  }: {
    section: DiscoverSectionKey;
    title: string;
    languageFilter?: boolean;
    providerFilter?: boolean;
    providers?: ProviderOption[];
    viewAllHref?: string;
    initialLanguage?: DiscoverLanguage;
    initialProvider?: string;
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
  let page = $state(1);
  let hasNextPage = $state(false);
  // svelte-ignore state_referenced_locally -- intentional initial-value capture; initialLanguage is a prop snapshot
  let language = $state<DiscoverLanguage>(initialLanguage);
  // svelte-ignore state_referenced_locally -- intentional initial-value capture; initialProvider is a prop snapshot
  let provider = $state<string>(initialProvider);
  let requestSequence = 0;
  let requestController: AbortController | undefined;
  let mounted = false;

  function railUrl(targetPage: number) {
    const params = new URLSearchParams({
      section,
      language,
      page: String(targetPage),
    });
    if (providerFilter && provider) params.set('provider', provider);
    return `/api/discover/rail?${params.toString()}`;
  }

  async function loadFirst() {
    // Reset and fetch page 1.
    requestSequence += 1;
    const requestId = requestSequence;
    requestController?.abort();
    const controller = new AbortController();
    requestController = controller;
    loading = true;
    loadingMore = false;
    errorMessage = '';
    try {
      const response = await fetch(railUrl(1), { signal: controller.signal });
      if (requestId !== requestSequence || controller.signal.aborted) return;
      const payload = await response.json();
      if (!response.ok || !payload.ok) throw new Error(payload?.error?.message || 'Section is temporarily unavailable.');
      if (requestId !== requestSequence) return;
      items = payload.items as MediaItem[];
      page = 1;
      hasNextPage = Boolean(payload.hasNextPage);
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
    try {
      const nextPage = page + 1;
      const response = await fetch(railUrl(nextPage));
      if (requestId !== requestSequence) return;
      const payload = await response.json();
      if (!response.ok || !payload.ok) throw new Error(payload?.error?.message || 'Could not load more titles.');
      if (requestId !== requestSequence) return;
      // Append to existing — do NOT replace.
      const incoming = payload.items as MediaItem[];
      // Dedupe by canonical type+id (defensive against upstream dupes).
      const seen = new Set(items.map((i) => `${i.type}:${i.id}`));
      for (const item of incoming) {
        const key = `${item.type}:${item.id}`;
        if (!seen.has(key)) {
          items = [...items, item];
          seen.add(key);
        }
      }
      page = nextPage;
      hasNextPage = Boolean(payload.hasNextPage);
    } catch (error) {
      if (requestId !== requestSequence) return;
      // Don't clear items on Show-more failure — keep the existing
      // titles visible and surface a transient error.
      errorMessage = error instanceof Error ? error.message : 'Could not load more titles.';
    } finally {
      if (requestId === requestSequence) loadingMore = false;
    }
  }

  function changeLanguage(next: string) {
    const nextLang = next as DiscoverLanguage;
    if (nextLang === language) return;
    language = nextLang;
    // Reset to page 1, replace results (do NOT append old-language items).
    void loadFirst();
  }

  function changeProvider(next: string) {
    if (next === provider) return;
    provider = next;
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
      <div class="section-loading" aria-live="polite">
        <LoaderCircle size={20} />
        <span>Loading…</span>
      </div>
    {:else if errorMessage && items.length === 0}
      <div class="section-error" role="alert">
        <span>{errorMessage}</span>
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

  .section-loading, .section-error, .section-empty {
    display: grid; place-items: center; gap: 8px;
    min-height: 120px;
    color: var(--muted, #777);
    font-size: .74rem;
  }
  .section-loading :global(svg) { color: #b7b7bd; animation: spin 1s linear infinite; }
  .section-error { color: #ffb020; }
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
    .section-loading :global(svg), .show-more :global(svg) { animation: none; }
  }
</style>
