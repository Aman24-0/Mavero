<script lang="ts">
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { Calendar, Film, Tv, Sparkles, Star, ArrowUpRight, LoaderCircle, AlertCircle } from 'lucide-svelte';
  import Dropdown from '$components/Dropdown.svelte';
  import ScrollToTop from '$components/ScrollToTop.svelte';
  import AppFooter from '$components/AppFooter.svelte';
  import { appendReturnTo } from '$lib/shared/navigation';
  import { upcomingDetailPath, UPCOMING_LANGUAGE_OPTIONS } from '$lib/shared/upcoming-policy';
  import type { PageData } from './$types';
  import type { UpcomingItem, UpcomingType } from '$lib/server/content/upcoming-types';

  let { data }: { data: PageData } = $props();

  // ---- Infinite scroll pagination (v2: compact cursor + server-side
  // snapshots). The cursor is a small continuation token the server
  // validates against the active filters — it never carries item
  // payloads, so the URL stays small for every filter combination. ----
  let allItems = $state<UpcomingItem[]>([...data.items]);
  let currentPage = $state(data.page ?? 1);
  let hasNextPage = $state(data.hasNextPage ?? false);
  let nextCursor = $state<string>(data.cursor ?? '');
  let loadingMore = $state(false);
  // Filter change in flight (skeleton replaces the stale list so old
  // content is never shown as if it belonged to the new filter).
  let filterPending = $state(false);
  // Controlled restart in flight (expired/stale cursor).
  let restarting = $state(false);
  // Pagination failure state — NEVER silently swallowed; the sentinel
  // area offers an explicit, keyboard-accessible retry.
  let loadMoreError = $state<string | null>(null);
  // Consecutive zero-progress responses (defensive loop breaker).
  let zeroProgressStreak = $state(0);
  // Partial source failures (SSR + latest pagination response).
  // svelte-ignore state_referenced_locally -- intentional initial-value capture; the data-sync effect re-syncs on every navigation
  let pageWarnings = $state<string[]>([...(data.errors ?? [])]);
  // Complete upstream failure surfaced through a pagination response.
  // svelte-ignore state_referenced_locally -- intentional initial-value capture; the data-sync effect re-syncs on every navigation
  let pageError = $state<string | null>(data.errorMessage ?? null);
  // Screen-reader pagination status (aria-live region below).
  let liveMessage = $state('');
  // The sentinel is a STABLE element: bound via $state so the observer
  // effect re-attaches whenever the element (re-)enters the DOM.
  let sentinelEl = $state<HTMLElement | undefined>();
  let sentinelVisible = $state(false);
  // Request generation token: bumped by EVERY state transition that
  // invalidates in-flight requests (filter change, data sync, snapshot
  // restore). A response only mutates state when its token is current,
  // so old pagination requests can never mutate new filter state.
  let requestToken = 0;

  // Server data sync — runs on every SSR/navigation data change (filter
  // change, back/forward navigation). Resets pagination COMPLETELY (no
  // old cursor survives) and re-syncs every filter control with the
  // actual URL/server state.
  $effect(() => {
    const d = data;
    requestToken += 1;
    loadingMore = false;
    filterPending = false;
    loadMoreError = null;
    zeroProgressStreak = 0;
    pageError = d.errorMessage ?? null;
    pageWarnings = [...(d.errors ?? [])];
    allItems = [...d.items];
    currentPage = d.page ?? 1;
    hasNextPage = d.hasNextPage ?? false;
    nextCursor = d.cursor ?? '';
    selectedMonth = String(d.filters.month);
    selectedYear = String(d.filters.year);
    selectedType = d.filters.type;
    selectedLanguage = String(d.filters.language ?? 'all');
  });

  // Phase F.1 — COMPACT month labels keep all four filters on ONE row on
  // small mobile screens (the dropdown trigger shows the selected value).
  const monthOptions = [
    { value: '1', label: 'Jan' },
    { value: '2', label: 'Feb' },
    { value: '3', label: 'Mar' },
    { value: '4', label: 'Apr' },
    { value: '5', label: 'May' },
    { value: '6', label: 'Jun' },
    { value: '7', label: 'Jul' },
    { value: '8', label: 'Aug' },
    { value: '9', label: 'Sep' },
    { value: '10', label: 'Oct' },
    { value: '11', label: 'Nov' },
    { value: '12', label: 'Dec' }
  ];
  // Full month names for the page heading + empty state ("September 2026").
  const monthFullNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

  const typeOptions = [
    { value: 'all', label: 'All' },
    { value: 'movie', label: 'Movies' },
    { value: 'series', label: 'Series' },
    { value: 'anime', label: 'Anime' }
  ];

  // Phase F.1 — language filter (Month | Year | Type | Language, one row).
  // Options come from the shared pure policy module so the page and the
  // server parser share ONE canonical list. The filter means TMDB ORIGINAL
  // language — never dubbed-audio availability.
  const languageOptions = UPCOMING_LANGUAGE_OPTIONS.map((option) => ({ value: option.code, label: option.label }));

  // Build year options from the server-provided list.
  let yearOptions = $derived(
    (data.yearOptions ?? []).map((y: number) => ({ value: String(y), label: String(y) }))
  );

  let selectedMonth = $state(String(data.filters.month));
  let selectedYear = $state(String(data.filters.year));
  let selectedType = $state<'all' | UpcomingType>(data.filters.type);
  // svelte-ignore state_referenced_locally -- intentional initial-value capture, same pattern as the three lines above
  let selectedLanguage = $state(String(data.filters.language ?? 'all'));

  function updateFilter(next: { month?: string; year?: string; type?: string; language?: string }) {
    const params = new URLSearchParams(page.url.searchParams);
    if (next.month !== undefined) params.set('month', next.month);
    if (next.year !== undefined) params.set('year', next.year);
    if (next.type !== undefined) params.set('type', next.type);
    if (next.language !== undefined) params.set('language', next.language);
    // Filter changes reset pagination completely: the server re-runs
    // load with NO cursor and the data-sync effect invalidates any
    // in-flight pagination request from the previous filter.
    filterPending = true;
    requestToken += 1;
    void goto(`${page.url.pathname}?${params.toString()}`, { keepFocus: true, noScroll: true })
      .catch(() => {})
      .finally(() => {
        filterPending = false;
      });
  }

  function setMonth(value: string) { selectedMonth = value; updateFilter({ month: value }); }
  function setYear(value: string) { selectedYear = value; updateFilter({ year: value }); }
  function setType(value: string) { selectedType = value as 'all' | UpcomingType; updateFilter({ type: value }); }
  function setLanguage(value: string) { selectedLanguage = value; updateFilter({ language: value }); }

  // Group items by date for the calendar feel.
  type DayGroup = { date: string; label: string; items: UpcomingItem[] };
  const dayNames = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
  const monthLabels = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  let dayGroups = $derived.by(() => {
    const map = new Map<string, UpcomingItem[]>();
    for (const item of allItems) {
      const key = item.date;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(item);
    }
    const groups: DayGroup[] = [];
    for (const [date, items] of map) {
      const d = new Date(date + 'T00:00:00Z');
      const dayName = dayNames[d.getUTCDay()] ?? '';
      const monthLabel = monthLabels[d.getUTCMonth()] ?? '';
      const dayNum = String(d.getUTCDate()).padStart(2, '0');
      groups.push({ date, label: `${dayName}, ${monthLabel} ${dayNum}`, items: items.sort((a, b) => a.timestamp - b.timestamp) });
    }
    return groups.sort((a, b) => a.date.localeCompare(b.date));
  });

  let hasResults = $derived(allItems.length > 0);
  // Page heading keeps the FULL month name ("September 2026") while the
  // dropdown triggers use the compact labels.
  let monthLabel = $derived(monthFullNames[Number(selectedMonth) - 1] ?? '');
  let yearLabel = $derived(selectedYear);
  let languageLabel = $derived(UPCOMING_LANGUAGE_OPTIONS.find((option) => option.code === selectedLanguage)?.label ?? 'All');

  function typeIcon(type: UpcomingType) {
    return type === 'movie' ? Film : type === 'series' ? Tv : Sparkles;
  }
  function typeBadge(type: UpcomingType) {
    return type === 'movie' ? 'Movie' : type === 'series' ? 'Series' : 'Anime';
  }
  function formatDate(date: string) {
    const d = new Date(date + 'T00:00:00Z');
    return `${monthLabels[d.getUTCMonth()]} ${String(d.getUTCDate()).padStart(2, '0')} · ${d.getUTCFullYear()}`;
  }
  // Phase F — canonical detail navigation. Upcoming event IDs are
  // episode-unique ("series-123-s58e294") but the detail routes need the
  // parent TMDB ID ("/series/123"). The strict parser lives in the pure
  // upcoming-policy module so it is directly unit-testable; malformed IDs
  // yield null and the card renders WITHOUT a link instead of routing to
  // a guaranteed 404 ("Series not found" / "Anime not found").
  //
  // Phase F.1 — EXACT RETURN STATE: the detail link carries the FULL
  // current Upcoming URL (pathname + search + hash) in the `from`
  // parameter via the shared appendReturnTo helper — the SAME
  // architecture MediaCard uses for Discover/Search/My List. DetailPage's
  // existing `history.back()` then performs a real popstate navigation
  // back to this exact history entry, so month/year/type/language, the
  // result set and SvelteKit's snapshot/scroll restoration all survive
  // the round-trip. No plain-goto replacement of the listing route, no
  // fallback hardcoding.
  let currentReturnTo = $derived(`${page.url.pathname}${page.url.search}${page.url.hash}`);
  function detailHref(item: UpcomingItem) {
    const path = upcomingDetailPath(item.id);
    if (!path) return null;
    return appendReturnTo(path, currentReturnTo);
  }
  // Phase F — movie release channel label: THEATRICAL / OTT (or both).
  function releaseKindLabel(item: UpcomingItem) {
    if (item.type !== 'movie' || !item.releaseKinds?.length) return undefined;
    return item.releaseKinds.map((k) => (k === 'theatrical' ? 'Theatrical' : 'OTT')).join(' + ');
  }

  // Infinite scroll: load the next page from /api/upcoming using the
  // compact cursor. Guarantees:
  //   - no concurrent page requests (loadingMore gate),
  //   - stale responses discarded via the generation token,
  //   - pagination failures SURFACE as a retry state (never swallowed),
  //   - zero-progress responses cannot loop (streak breaker),
  //   - expired cursors restart through the explicit deterministic
  //     mechanism (never a silent page-1 reset).
  async function loadMore() {
    if (loadingMore || restarting || filterPending) return;
    if (!hasNextPage || !nextCursor) return;
    if (loadMoreError) return; // explicit retry required
    const token = ++requestToken;
    loadingMore = true;
    liveMessage = 'Loading more results…';
    try {
      const params = new URLSearchParams({
        month: String(data.filters.month),
        year: String(data.filters.year),
        type: data.filters.type,
        language: data.filters.language ?? 'all',
        page: String(currentPage + 1),
        cursor: nextCursor
      });
      const res = await fetch(`/api/upcoming?${params.toString()}`);
      if (token !== requestToken) return; // stale request
      const payload = await res.json().catch(() => null);
      if (token !== requestToken) return; // stale request
      if (!res.ok || !payload?.ok) {
        const code = payload?.error?.code ?? `HTTP ${res.status}`;
        if (code === 'INVALID_CURSOR' || code === 'CURSOR_STALE' || code === 'CURSOR_FILTER_MISMATCH') {
          // Controlled, deterministic restart — announced to the user.
          await restartPagination(token);
          return;
        }
        throw new Error(payload?.error?.message ?? `Could not load more results (${code}).`);
      }
      // Deduplicate by event ID — never render the same event twice.
      const incoming = (payload.items ?? []) as UpcomingItem[];
      const existing = new Set(allItems.map((i) => i.id));
      const fresh = incoming.filter((i) => !existing.has(i.id));
      if (fresh.length === 0 && payload.hasNextPage) {
        // Zero-progress defense: a response that advances nothing while
        // claiming more pages exist must not loop forever.
        zeroProgressStreak += 1;
        if (zeroProgressStreak >= 2) {
          loadMoreError = 'The next page returned no new results. Retry to continue.';
          liveMessage = 'Could not load more results. Retry available.';
          return;
        }
      } else {
        zeroProgressStreak = 0;
      }
      allItems = [...allItems, ...fresh];
      currentPage = typeof payload.page === 'number' ? payload.page : currentPage + 1;
      hasNextPage = Boolean(payload.hasNextPage);
      nextCursor = typeof payload.cursor === 'string' && payload.cursor ? payload.cursor : '';
      pageWarnings = Array.isArray(payload.errors) ? payload.errors : [];
      if (!hasNextPage) liveMessage = 'End of results.';
      else if (fresh.length === 0) liveMessage = 'No new results on this page.';
      else liveMessage = `${fresh.length} more results loaded.`;
    } catch (error) {
      if (token !== requestToken) return; // stale request
      loadMoreError = error instanceof Error ? error.message : 'Could not load more results.';
      liveMessage = 'Could not load more results. Retry available.';
    } finally {
      if (token === requestToken) {
        loadingMore = false;
        // If the sentinel is still on screen (short pages / tall
        // viewports), keep going — otherwise pagination would stall
        // until the next scroll event.
        if (!loadMoreError && hasNextPage && sentinelVisible) {
          queueMicrotask(() => void loadMore());
        }
      }
    }
  }

  function retryLoadMore() {
    loadMoreError = null;
    zeroProgressStreak = 0;
    void loadMore();
  }

  // Explicit deterministic restart for expired/stale cursors: fetch
  // page 1 fresh and REPLACE the list. Never a silent duplicate-prone
  // continuation, never a full page reload.
  async function restartPagination(token: number) {
    restarting = true;
    loadingMore = false;
    liveMessage = 'Results were refreshed — starting from the first page.';
    try {
      const params = new URLSearchParams({
        month: String(data.filters.month),
        year: String(data.filters.year),
        type: data.filters.type,
        language: data.filters.language ?? 'all',
        page: '1'
      });
      const res = await fetch(`/api/upcoming?${params.toString()}`);
      if (token !== requestToken) return;
      const payload = await res.json().catch(() => null);
      if (token !== requestToken) return;
      if (!res.ok || !payload?.ok) {
        loadMoreError = payload?.error?.message ?? `Could not refresh results (HTTP ${res.status}).`;
        liveMessage = 'Could not refresh results. Retry available.';
        return;
      }
      if ((payload.items ?? []).length === 0 && payload.errorMessage) {
        // The refresh itself surfaced an upstream failure — retry state.
        pageError = payload.errorMessage;
        pageWarnings = Array.isArray(payload.errors) ? payload.errors : [];
        allItems = [];
        hasNextPage = false;
        nextCursor = '';
        liveMessage = 'Upcoming releases are temporarily unavailable.';
        return;
      }
      allItems = (payload.items ?? []) as UpcomingItem[];
      currentPage = 1;
      hasNextPage = Boolean(payload.hasNextPage);
      nextCursor = typeof payload.cursor === 'string' && payload.cursor ? payload.cursor : '';
      pageWarnings = Array.isArray(payload.errors) ? payload.errors : [];
      pageError = null;
      loadMoreError = null;
      zeroProgressStreak = 0;
    } catch (error) {
      if (token !== requestToken) return;
      loadMoreError = error instanceof Error ? error.message : 'Could not refresh results.';
      liveMessage = 'Could not refresh results. Retry available.';
    } finally {
      if (token === requestToken) restarting = false;
    }
  }

  // IntersectionObserver lifecycle tied to the ACTUAL sentinel element:
  // the effect re-runs whenever sentinelEl is bound/replaced and
  // disconnects cleanly on teardown. No observer ever outlives its
  // element, and none is created on the server.
  $effect(() => {
    const el = sentinelEl;
    if (!el || !('IntersectionObserver' in window)) return;
    const observer = new IntersectionObserver((entries) => {
      sentinelVisible = entries.some((e) => e.isIntersecting);
      if (sentinelVisible) void loadMore();
    }, { rootMargin: '400px 0px' });
    observer.observe(el);
    return () => {
      sentinelVisible = false;
      observer.disconnect();
    };
  });

  // SvelteKit snapshot — preserves loaded items + pagination state
  // (including the compact cursor) across back/forward navigation. The
  // v2 cursor keeps this payload small (it never contained item
  // payloads). Restore invalidates in-flight requests so a restored
  // state can never be mutated by an old response.
  export const snapshot = {
    capture: () => ({ allItems, currentPage, hasNextPage, nextCursor }),
    restore: (value: any) => {
      if (!value || typeof value !== 'object') return;
      if (Array.isArray(value.allItems)) allItems = value.allItems;
      if (typeof value.currentPage === 'number') currentPage = value.currentPage;
      if (typeof value.hasNextPage === 'boolean') hasNextPage = value.hasNextPage;
      if (typeof value.nextCursor === 'string') nextCursor = value.nextCursor;
      requestToken += 1;
      loadingMore = false;
      loadMoreError = null;
      zeroProgressStreak = 0;
    }
  };
</script>

<svelte:head>
  <title>Upcoming — Mavero</title>
  <meta name="description" content="Upcoming movies, series episodes, and anime releases on MAVERO." />
  <meta name="robots" content="noindex,follow" />
</svelte:head>

<div class="upcoming-page">
  <header class="upcoming-header">
    <div class="header-inner">
      <div class="header-eyebrow"><Calendar size={13} /> MAVERO / Upcoming</div>
      <h1>Upcoming</h1>
      <p>What's coming next — movies, series episodes, and anime releases.</p>
    </div>
  </header>

  <div class="filters-bar">
    <div class="filters-inner">
      <div class="filter-wrap">
        <Dropdown id="upcoming-month" label="Month" value={selectedMonth} options={monthOptions} onChange={setMonth} />
      </div>
      <div class="filter-wrap">
        <Dropdown id="upcoming-year" label="Year" value={selectedYear} options={yearOptions} onChange={setYear} />
      </div>
      <div class="filter-wrap">
        <Dropdown id="upcoming-type" label="Type" value={selectedType} options={typeOptions} onChange={setType} />
      </div>
      <div class="filter-wrap">
        <Dropdown id="upcoming-language" label="Language" value={selectedLanguage} options={languageOptions} onChange={setLanguage} />
      </div>
    </div>
  </div>

  <div class="upcoming-body" aria-busy={filterPending}>
    {#if filterPending}
      <!-- Filter change in flight: the skeleton replaces the previous
           filter's list so stale content is never shown as if it
           belonged to the new selection. -->
      <div class="loading-state" role="status" aria-live="polite">
        <div class="loading-inline"><LoaderCircle size={16} /> Updating results…</div>
        <div class="skeleton-grid" aria-hidden="true">
          {#each Array(8) as _, i (i)}
            <div class="skeleton-card"></div>
          {/each}
        </div>
      </div>
    {:else if (data.errorMessage || pageError) && !hasResults}
      <section class="error-state" role="alert">
        <div class="error-mark">!</div>
        <h2>No releases found</h2>
        <p>{data.errorMessage ?? pageError}</p>
        <button class="retry-btn" type="button" onclick={() => window.location.reload()}>Try again</button>
      </section>
    {:else if !hasResults}
      <section class="empty-state" aria-live="polite">
        <div class="empty-mark" aria-hidden="true"><Calendar size={24} /></div>
        <h2>No releases found</h2>
        <p>No Movies, Series, or Anime matching {monthLabel} {yearLabel} with the {typeOptions.find((t) => t.value === selectedType)?.label}{#if selectedLanguage !== 'all'} · {languageLabel}{/if} filter.</p>
        <button class="empty-action" type="button" onclick={() => setType('all')}>Change filters</button>
      </section>
    {:else}
      {#if pageWarnings.length}
        <div class="partial-warning" role="status">
          Some sources were unavailable: {pageWarnings.join('; ')}
        </div>
      {/if}

      <div class="month-heading">{monthLabel} {yearLabel}</div>

      <div class="day-groups">
        {#each dayGroups as group (group.date)}
          <section class="day-group">
            <h2 class="day-label">{group.label}</h2>
            <div class="day-cards">
              {#each group.items as item (item.id)}
                {@const href = detailHref(item)}
                {@const kindLabel = releaseKindLabel(item)}
                <a class="release-card" href={href} {...href === null ? { 'aria-disabled': 'true' } : {}}>
                  <div class="card-poster">
                    {#if item.poster}
                      <img src={item.poster} alt={item.title} loading="lazy" decoding="async" />
                    {:else}
                      <div class="poster-fallback"><Film size={20} /></div>
                    {/if}
                    <span class="type-badge">{typeBadge(item.type)}</span>
                  </div>
                  <div class="card-body">
                    {#if item.providers?.length}
                      <div class="providers-row" aria-label="Streaming providers">
                        {#each item.providers.slice(0, 3) as provider}
                          <img src={provider.logo} alt={provider.name} class="provider-logo" loading="lazy" title={provider.name} />
                        {/each}
                        {#if item.providers.length > 3}
                          <span class="provider-more">+{item.providers.length - 3}</span>
                        {/if}
                      </div>
                    {/if}
                    <h3 class="card-title">{item.title}</h3>
                    <div class="card-meta">
                      {#if kindLabel}
                        <span class="ep-tag kind-tag">{kindLabel}</span>
                      {/if}
                      {#if item.type === 'series' && item.season !== undefined && item.episode !== undefined}
                        <span class="ep-tag">S{String(item.season).padStart(2, '0')} · E{String(item.episode).padStart(2, '0')}</span>
                      {:else if item.type === 'anime' && item.episode !== undefined}
                        <span class="ep-tag">Episode {item.episode}</span>
                      {/if}
                      <span class="date-tag">{formatDate(item.date)}</span>
                      {#if item.rating && item.rating > 0}
                        <span class="rating-tag"><Star size={9} fill="currentColor" strokeWidth={0} /> {item.rating.toFixed(1)}</span>
                      {/if}
                    </div>
                    {#if item.episodeTitle}
                      <div class="episode-title">{item.episodeTitle}</div>
                    {/if}
                    {#if item.genres?.length}
                      <div class="genres-row">{item.genres.join(' · ')}</div>
                    {/if}
                  </div>
                  <ArrowUpRight size={15} class="card-arrow" />
                </a>
              {/each}
            </div>
          </section>
        {/each}
      </div>
      <!-- STABLE pagination sentinel: always present while results are
           shown, so the IntersectionObserver never attaches to a
           detached element. Its CONTENT reflects the pagination state:
           loading / retry / clean end. -->
      <div class="load-more-sentinel" bind:this={sentinelEl}>
        {#if loadingMore || restarting}
          <div class="loading-more" role="status">
            <LoaderCircle size={16} /> {restarting ? 'Refreshing results…' : 'Loading more…'}
          </div>
        {:else if loadMoreError}
          <div class="load-error" role="alert">
            <AlertCircle size={14} />
            <span class="load-error-text">{loadMoreError}</span>
            <button class="retry-btn retry-inline" type="button" onclick={retryLoadMore}>Retry</button>
          </div>
        {:else if !hasNextPage}
          <div class="end-of-results" role="status">You're all caught up.</div>
        {/if}
      </div>
    {/if}
  </div>

  <!-- Pagination status for assistive technology. -->
  <div class="sr-only" aria-live="polite">{liveMessage}</div>
</div>

<AppFooter />

<ScrollToTop />

<style>
  .upcoming-page {
    --u-gutter: clamp(16px, 5vw, 48px);
    min-height: calc(100dvh - 76px);
    padding-bottom: calc(110px + env(safe-area-inset-bottom, 0px));
  }

  .upcoming-header {
    padding: 26px var(--u-gutter) 22px;
    border-bottom: 1px solid rgba(255, 255, 255, .05);
    background:
      radial-gradient(circle at 85% -20%, rgba(255, 255, 255, .04), transparent 50%),
      #000;
  }
  .header-inner { width: min(1100px, 100%); margin-inline: auto; }
  .header-eyebrow {
    display: inline-flex; align-items: center; gap: 6px;
    color: #77777f;
    font-size: .6rem; font-weight: 700;
    letter-spacing: .14em; text-transform: uppercase;
  }
  .upcoming-header h1 {
    margin: 8px 0 6px;
    color: #f5f5f5;
    font-size: clamp(1.8rem, 4vw, 2.6rem);
    font-weight: 800;
    letter-spacing: -.025em;
    line-height: 1.05;
  }
  .upcoming-header p {
    margin: 0;
    color: #b7b7bd;
    font-size: .82rem;
    line-height: 1.55;
    max-width: 520px;
  }

  .filters-bar {
    padding: 18px var(--u-gutter);
    border-bottom: 1px solid rgba(255, 255, 255, .05);
  }
  .filters-inner {
    display: flex; flex-wrap: wrap; gap: 10px; align-items: center;
    width: min(1100px, 100%);
    margin-inline: auto;
  }
  .filter-wrap { min-width: 130px; flex: 1 1 130px; }

  /* Month / Year / Type / Language share ONE horizontal row on every
     viewport. The micro labels stay in the DOM for aria-labelledby but
     are visually hidden — the selected values (compact month name, year,
     type, language) are self-descriptive, so labels would only burn a
     vertical row. */
  .filters-inner :global(.dropdown-label) {
    position: absolute;
    width: 1px; height: 1px;
    padding: 0; margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }

  .upcoming-body {
    padding: 0 var(--u-gutter);
    width: min(1100px, calc(100% - 2 * var(--u-gutter)));
    margin-inline: auto;
    padding-top: 22px;
  }

  .partial-warning {
    margin-bottom: 18px;
    padding: 10px 14px;
    border: 1px solid rgba(255, 176, 32, .25);
    border-radius: 10px;
    background: rgba(255, 176, 32, .04);
    color: #ffb020;
    font-size: .72rem;
    line-height: 1.5;
  }

  .month-heading {
    color: #f5f5f5;
    font-size: 1.2rem; font-weight: 800;
    letter-spacing: -.015em;
    margin-bottom: 16px;
  }

  .day-groups { display: grid; gap: 24px; }
  .load-more-sentinel { min-height: 60px; display: grid; place-items: center; padding: 20px 0; }
  .loading-more { display: inline-flex; align-items: center; gap: 8px; color: var(--muted); font-size: .72rem; }
  .loading-more :global(svg) { animation: spin 0.8s linear infinite; }
  @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }

  /* Pagination failure state — a visible, keyboard-accessible retry. */
  .load-error {
    display: inline-flex; align-items: center; flex-wrap: wrap;
    justify-content: center; gap: 10px;
    padding: 10px 16px;
    border: 1px solid rgba(255, 176, 32, .25);
    border-radius: 10px;
    background: rgba(255, 176, 32, .04);
    color: #ffb020;
    font-size: .72rem; font-weight: 600;
  }
  .load-error :global(svg) { flex: 0 0 auto; }
  .retry-inline { margin-top: 0; padding: 6px 16px; font-size: .68rem; }

  /* Clean end-of-results state. */
  .end-of-results {
    color: #646464;
    font-size: .68rem; font-weight: 700;
    letter-spacing: .1em; text-transform: uppercase;
  }

  /* Screen-reader-only live region for pagination announcements. */
  .sr-only {
    position: absolute;
    width: 1px; height: 1px;
    padding: 0; margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }

  /* Filter-change loading state: skeleton replaces the stale list. */
  .loading-state { display: grid; gap: 16px; padding: 8px 0 24px; }
  .loading-inline {
    display: inline-flex; align-items: center; gap: 8px;
    color: var(--muted); font-size: .72rem; font-weight: 700;
    justify-self: center;
  }
  .loading-inline :global(svg) { animation: spin 0.8s linear infinite; }
  .skeleton-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
    gap: 12px;
  }
  .skeleton-card {
    height: 128px;
    border-radius: 12px;
    border: 1px solid rgba(255, 255, 255, .05);
    background: linear-gradient(100deg, rgba(255, 255, 255, .02) 40%, rgba(255, 255, 255, .05) 50%, rgba(255, 255, 255, .02) 60%);
    background-size: 200% 100%;
    animation: shimmer 1.4s ease-in-out infinite;
  }
  @keyframes shimmer { from { background-position: 120% 0; } to { background-position: -80% 0; } }
  @media (min-width: 900px) {
    .skeleton-grid { grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); }
  }
  @media (prefers-reduced-motion: reduce) {
    .skeleton-card { animation: none; }
    .loading-more :global(svg), .loading-inline :global(svg) { animation: none; }
  }
  .day-group { display: grid; gap: 12px; }
  .day-label {
    margin: 0;
    color: #c7c7cc;
    font-size: .68rem; font-weight: 800;
    letter-spacing: .12em; text-transform: uppercase;
    padding-bottom: 8px;
    border-bottom: 1px solid rgba(255, 255, 255, .05);
  }

  .day-cards {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
    gap: 12px;
  }

  .release-card {
    display: grid;
    grid-template-columns: 80px 1fr auto;
    gap: 12px;
    align-items: start;
    padding: 12px;
    border: 1px solid rgba(255, 255, 255, .06);
    border-radius: 12px;
    background: rgba(255, 255, 255, .012);
    color: inherit;
    text-decoration: none;
    transition: border-color 200ms cubic-bezier(.22,1,.36,1), background 200ms cubic-bezier(.22,1,.36,1);
  }
  .release-card:hover { border-color: rgba(255, 255, 255, .16); background: rgba(255, 255, 255, .025); }
  .release-card:focus-visible { outline: 2px solid #f5f5f5; outline-offset: 2px; }

  .card-poster {
    position: relative;
    width: 80px; aspect-ratio: 2 / 3;
    border-radius: 8px; overflow: hidden;
    background: #141414;
    border: 1px solid rgba(255, 255, 255, .05);
  }
  .card-poster img { width: 100%; height: 100%; object-fit: cover; }
  .poster-fallback { display: grid; place-items: center; width: 100%; height: 100%; color: #555; }
  .type-badge {
    position: absolute; top: 4px; left: 4px;
    padding: 2px 6px;
    border-radius: 4px;
    background: rgba(0, 0, 0, .7);
    color: #f5f5f5;
    font-size: .48rem; font-weight: 800;
    letter-spacing: .04em; text-transform: uppercase;
  }

  .card-body { min-width: 0; }
  .providers-row {
    display: flex; align-items: center; gap: 4px;
    margin-bottom: 6px;
  }
  .provider-logo {
    width: 18px; height: 18px;
    border-radius: 4px;
    object-fit: contain;
    border: 1px solid rgba(255, 255, 255, .08);
  }
  .provider-more {
    color: #969696;
    font-size: .56rem; font-weight: 700;
  }
  .card-title {
    margin: 0;
    color: #f5f5f5;
    font-size: .84rem; font-weight: 700;
    letter-spacing: -.005em;
    line-height: 1.25;
    overflow: hidden;
    text-overflow: ellipsis;
    display: -webkit-box;
    -webkit-line-clamp: 2; line-clamp: 2;
    -webkit-box-orient: vertical;
  }
  .card-meta {
    display: flex; flex-wrap: wrap; align-items: center; gap: 6px;
    margin-top: 6px;
    color: #b7b7bd;
    font-size: .64rem; font-weight: 600;
  }
  .ep-tag {
    padding: 2px 7px;
    border-radius: 4px;
    background: rgba(255, 255, 255, .08);
    color: #f5f5f5;
    font-size: .58rem; font-weight: 800;
    letter-spacing: .03em;
  }
  /* Phase F — movie release channel tag (THEATRICAL / OTT). Shares the
     ep-tag geometry; only the tint differs so the channel is scannable
     without introducing a new component language. */
  .kind-tag {
    background: rgba(155, 135, 245, .16);
    color: #cabffe;
  }
  .date-tag { color: #c7c7cc; }
  .rating-tag {
    display: inline-flex; align-items: center; gap: 2px;
    color: #ffc94d;
    font-size: .58rem; font-weight: 700;
  }
  .episode-title {
    margin-top: 5px;
    color: #969696;
    font-size: .68rem; font-weight: 500;
    line-height: 1.35;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .genres-row {
    margin-top: 4px;
    color: #646464;
    font-size: .58rem;
    letter-spacing: .02em;
  }
  .release-card :global(.card-arrow) { color: #646464; align-self: center; flex: 0 0 auto; }

  .empty-state, .error-state {
    display: grid; place-items: center; gap: 8px;
    min-height: 280px;
    padding: 48px 24px;
    text-align: center;
  }
  .empty-mark, .error-mark {
    display: grid; place-items: center;
    width: 60px; height: 60px;
    margin-bottom: 6px;
    border: 1px solid rgba(255, 255, 255, .1);
    border-radius: 50%;
    color: #b7b7bd;
    background: rgba(255, 255, 255, .03);
  }
  .error-mark { color: #ffb020; border-color: rgba(255, 176, 32, .3); background: rgba(255, 176, 32, .05); font-size: 1.4rem; font-weight: 800; }
  .empty-state h2, .error-state h2 {
    margin: 4px 0;
    color: #f5f5f5;
    font-size: 1.3rem; font-weight: 800;
    letter-spacing: -.015em;
  }
  .empty-state p, .error-state p {
    margin: 0; max-width: 360px;
    color: #b7b7bd;
    font-size: .82rem; line-height: 1.6;
  }
  .empty-action, .retry-btn {
    margin-top: 12px;
    padding: 10px 22px;
    border: 1px solid rgba(255, 255, 255, .14);
    border-radius: 999px;
    color: #f5f5f5;
    background: rgba(255, 255, 255, .06);
    font: inherit;
    font-size: .76rem; font-weight: 700;
    cursor: pointer;
    transition: background 180ms ease, border-color 180ms ease;
  }
  .empty-action:hover, .retry-btn:hover { background: rgba(255, 255, 255, .12); border-color: rgba(255, 255, 255, .24); }

  @media (max-width: 640px) {
    .upcoming-header { padding-top: 22px; padding-bottom: 18px; }
    .upcoming-header h1 { font-size: clamp(1.5rem, 6vw, 2rem); }
    /* One row: four equal-width dropdowns (Month | Year | Type | Language).
       min-width: 0 lets each control shrink and ellipsize instead of
       pushing the row wider than the viewport (compact month labels keep
       the values readable at 360px). */
    .filters-inner { flex-wrap: nowrap; gap: 8px; }
    .filter-wrap { min-width: 0; flex: 1 1 0; }
    .day-cards { grid-template-columns: 1fr; }
    .release-card { grid-template-columns: 64px 1fr auto; gap: 10px; padding: 10px; }
    .card-poster { width: 64px; }
  }
  @media (min-width: 900px) {
    .upcoming-header { padding-top: 44px; padding-bottom: 26px; }
    .upcoming-header h1 { font-size: clamp(2rem, 3.4vw, 2.8rem); }
    .day-cards { grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); }
  }
  @media (prefers-reduced-motion: reduce) {
    .release-card { transition: none; }
  }
</style>
