<script lang="ts">
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { Calendar, Film, Tv, Sparkles, Star, ArrowUpRight, LoaderCircle, AlertCircle } from 'lucide-svelte';
  import Dropdown from '$components/Dropdown.svelte';
  import ScrollToTop from '$components/ScrollToTop.svelte';
  import AppFooter from '$components/AppFooter.svelte';
  import { appendReturnTo } from '$lib/shared/navigation';
  import { upcomingDetailPath, UPCOMING_LANGUAGE_OPTIONS, todayUtcDate } from '$lib/shared/upcoming-policy';
  import type { PageData } from './$types';
  import type { UpcomingItem, UpcomingType } from '$lib/server/content/upcoming-types';

  let { data }: { data: PageData } = $props();

  // ---- Infinite scroll pagination (v3: compact cursor + server-side
  // snapshots, keyed on startDate/30-day window). The cursor is a small
  // continuation token the server validates against the active filters
  // — it never carries item payloads, so the URL stays small for every
  // filter combination. ----
  // svelte-ignore state_referenced_locally -- intentional initial-value capture; the data-sync effect re-syncs on every navigation
  let allItems = $state<UpcomingItem[]>([...data.items]);
  // svelte-ignore state_referenced_locally -- intentional initial-value capture; the data-sync effect re-syncs on every navigation
  let currentPage = $state(data.page ?? 1);
  // svelte-ignore state_referenced_locally -- intentional initial-value capture; the data-sync effect re-syncs on every navigation
  let hasNextPage = $state(data.hasNextPage ?? false);
  // svelte-ignore state_referenced_locally -- intentional initial-value capture; the data-sync effect re-syncs on every navigation
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
    filterNavError = null;
    loadMoreError = null;
    zeroProgressStreak = 0;
    pageError = d.errorMessage ?? null;
    pageWarnings = [...(d.errors ?? [])];
    allItems = [...d.items];
    currentPage = d.page ?? 1;
    hasNextPage = d.hasNextPage ?? false;
    nextCursor = d.cursor ?? '';
    selectedStartDate = d.filters.startDate;
    selectedType = d.filters.type;
    selectedLanguage = String(d.filters.language ?? 'all');
  });

  // F7: type options changed from a dropdown with 'All' to three chips:
  // Movies (default), Shows, Anime. No 'All' option — each type is
  // loaded independently and lazily.
  const typeOptions = [
    { value: 'movie', label: 'Movies' },
    { value: 'series', label: 'Shows' },
    { value: 'anime', label: 'Anime' }
  ];

  // Phase F.1 — language filter (StartDate | Type | Language, one row).
  // Options come from the shared pure policy module so the page and the
  // server parser share ONE canonical list. The filter means TMDB ORIGINAL
  // language — never dubbed-audio availability.
  const languageOptions = UPCOMING_LANGUAGE_OPTIONS.map((option) => ({ value: option.code, label: option.label }));

  // F7-B: the date selector default. The server always returns a
  // canonical startDate (YYYY-MM-DD), so this is purely the SSR initial
  // value — direct user input is constrained by <input type="date">.
  // svelte-ignore state_referenced_locally -- intentional initial-value capture, same pattern as the three lines above
  let selectedStartDate = $state(data.filters.startDate);
  // svelte-ignore state_referenced_locally -- intentional initial-value capture, same pattern as the three lines above
  let selectedType = $state<'all' | UpcomingType>(data.filters.type);
  // svelte-ignore state_referenced_locally -- intentional initial-value capture, same pattern as the three lines above
  let selectedLanguage = $state(String(data.filters.language ?? 'all'));

  // Filter-navigation failure — a rejected goto() is NEVER silently
  // swallowed: the optimistic selection is rolled back to the last
  // server state and a small retryable error is surfaced next to the
  // filter bar (the same explicit-retry convention as pagination
  // failures).
  let filterNavError = $state<string | null>(null);
  // The filter values whose navigation failed, so Retry re-applies
  // exactly what failed. Non-reactive on purpose — only handlers read it.
  let failedFilter: { startDate?: string; type?: string; language?: string } | null = null;

  function restoreFilterSelections() {
    // After a failed navigation `data` still holds the last SUCCESSFUL
    // server state — the controls re-sync to it (the optimistic
    // selection is rolled back; no stale mismatch with the URL).
    selectedStartDate = data.filters.startDate;
    selectedType = data.filters.type;
    selectedLanguage = String(data.filters.language ?? 'all');
  }

  function updateFilter(next: { startDate?: string; type?: string; language?: string }) {
    const params = new URLSearchParams(page.url.searchParams);
    if (next.startDate !== undefined) params.set('startDate', next.startDate);
    if (next.type !== undefined) params.set('type', next.type);
    if (next.language !== undefined) params.set('language', next.language);
    // Filter changes reset pagination completely: the server re-runs
    // load with NO cursor and the data-sync effect invalidates any
    // in-flight pagination request from the previous filter.
    filterPending = true;
    filterNavError = null;
    const token = ++requestToken;
    void goto(`${page.url.pathname}?${params.toString()}`, { keepFocus: true, noScroll: true })
      .catch(() => {
        // Navigation failure (offline / route load rejection) must not
        // leave a silent dead end: roll the selection back and offer an
        // explicit retry. The token check keeps a STALE failure from
        // clobbering a newer navigation (a successful navigation bumps
        // the token through the data-sync effect, which also clears
        // this error) — and never breaks SvelteKit's own navigation
        // behavior; it only observes the rejection.
        if (token !== requestToken) return;
        restoreFilterSelections();
        failedFilter = next;
        filterNavError = 'Could not update the filters. Check your connection and retry.';
        liveMessage = 'Could not update the filters. Retry available.';
      })
      .finally(() => {
        // Only the CURRENT navigation may clear the pending flag — a
        // newer filter change's pending state must survive.
        if (token === requestToken) filterPending = false;
      });
  }

  function retryFilterNav() {
    const failed = failedFilter;
    filterNavError = null;
    failedFilter = null;
    if (failed) updateFilter(failed);
  }

  function setStartDate(value: string) { selectedStartDate = value; updateFilter({ startDate: value }); }
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
  // F7-B: page heading reflects the 30-day window starting at
  // selectedStartDate (e.g. "Sep 27 — Oct 26, 2026").
  let windowEndLabel = $derived.by(() => {
    // Mirror the canonical [startDate, startDate + 30 days) window. The
    // last in-window day is startDate + 29 calendar days.
    const startMs = Date.parse(selectedStartDate + 'T00:00:00Z');
    if (!Number.isFinite(startMs)) return '';
    const lastDayMs = startMs + 29 * 24 * 60 * 60 * 1000;
    const d = new Date(lastDayMs);
    return `${monthLabels[d.getUTCMonth()]} ${String(d.getUTCDate()).padStart(2, '0')}, ${d.getUTCFullYear()}`;
  });
  let startDateLabel = $derived.by(() => {
    const d = new Date(selectedStartDate + 'T00:00:00Z');
    if (Number.isNaN(d.getTime())) return selectedStartDate;
    return `${monthLabels[d.getUTCMonth()]} ${String(d.getUTCDate()).padStart(2, '0')}, ${d.getUTCFullYear()}`;
  });
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
        startDate: data.filters.startDate,
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
        startDate: data.filters.startDate,
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

  // SvelteKit snapshot — preserves the LOADED UI STATE (items, page,
  // continuation) across back/forward navigation. This is deliberately
  // NOT the same mechanism as the URL cursor:
  //   - URL cursor  = compact metadata ONLY (never item payloads),
  //   - this snapshot = the full loaded list + continuation, kept in
  //     SvelteKit's in-memory history state so back/forward restores
  //     the exact UI without re-fetching.
  // The snapshot is intentionally richer than the cursor; restore
  // invalidates in-flight requests so a restored state can never be
  // mutated by an old response.
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
      <!-- F7-B UX fix: two-row mobile layout.
           Row 1 = Date picker + Language dropdown (proportional widths).
           Row 2 = Movies / Shows / Anime chips (equal widths, full row).
           On >= 768px (tablet/desktop) the rows collapse back into a
           single horizontal row — see the responsive CSS at the bottom. -->
      <div class="filter-row filter-row-filters">
        <!-- F7-B: single date selector (default = today, UTC). The chosen
             date opens a fixed 30-calendar-day window. Native <input
             type="date"> constrains user input server-side independently
             via parseUpcomingStartDate (strict YYYY-MM-DD, fail-safe to
             today). -->
        <div class="filter-wrap filter-wrap-date">
          <label class="date-label" for="upcoming-start-date">From</label>
          <input
            id="upcoming-start-date"
            class="date-input"
            type="date"
            value={selectedStartDate}
            max="2100-12-31"
            min="1900-01-01"
            onchange={(e) => {
              const v = (e.currentTarget as HTMLInputElement).value;
              if (v) setStartDate(v);
            }}
          />
        </div>
        <div class="filter-wrap filter-wrap-language">
          <Dropdown id="upcoming-language" label="Language" value={selectedLanguage} options={languageOptions} onChange={setLanguage} />
        </div>
      </div>
      <!-- F7: type selector changed from a Dropdown to chips (Movies / Shows / Anime).
           No 'All' option — each type is loaded independently and lazily. -->
      <div class="filter-row filter-row-chips">
        <div class="type-chips" role="group" aria-label="Content type">
          {#each typeOptions as opt}
            <button
              type="button"
              class="type-chip"
              class:active={selectedType === opt.value}
              onclick={() => setType(opt.value)}
              aria-pressed={selectedType === opt.value}
            >{opt.label}</button>
          {/each}
        </div>
      </div>
    </div>
    {#if filterNavError}
      <!-- Failed filter navigation: a small, retryable error next to the
           filters — never a silent dead end, never a noisy global modal. -->
      <div class="filter-nav-error load-error" role="alert">
        <AlertCircle size={14} />
        <span class="load-error-text">{filterNavError}</span>
        <button class="retry-btn retry-inline" type="button" onclick={retryFilterNav}>Retry</button>
      </div>
    {/if}
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
        <p>No {typeOptions.find((t) => t.value === selectedType)?.label} releases in the 30-day window from {startDateLabel}{#if selectedLanguage !== 'all'} · {languageLabel}{/if}.</p>
        <button class="empty-action" type="button" onclick={() => setStartDate(todayUtcDate())}>Reset to today</button>
      </section>
    {:else}
      {#if pageWarnings.length}
        <div class="partial-warning" role="status">
          Some sources were unavailable: {pageWarnings.join('; ')}
        </div>
      {/if}

      <div class="month-heading">{startDateLabel} – {windowEndLabel}</div>

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
    border-bottom: 1px solid var(--color-border);
    background:
      radial-gradient(circle at 85% -20%, var(--color-primary-soft), transparent 50%),
      var(--color-bg);
  }
  .header-inner { width: min(1100px, 100%); margin-inline: auto; }
  .header-eyebrow {
    display: inline-flex; align-items: center; gap: 6px;
    color: var(--color-primary);
    font-size: .6rem; font-weight: 800;
    letter-spacing: .14em; text-transform: uppercase;
    text-shadow: 0 0 10px rgba(0, 255, 156, .3);
  }
  .upcoming-header h1 {
    margin: 8px 0 6px;
    color: var(--color-text);
    font-size: clamp(1.8rem, 4vw, 2.6rem);
    font-weight: 900;
    letter-spacing: -.025em;
    line-height: 1.05;
  }
  .upcoming-header p {
    margin: 0;
    color: var(--color-text-muted);
    font-size: .82rem;
    line-height: 1.55;
    max-width: 520px;
  }

  .filters-bar {
    padding: 18px var(--u-gutter);
    border-bottom: 1px solid var(--color-border);
  }
  /* F7-B UX fix: two-row mobile layout.
     - .filters-inner is a vertical stack of two .filter-row elements on
       mobile. Row 1 = Date + Language (proportional widths, each gets
       ~50% of the row). Row 2 = Movies / Shows / Anime chips (each chip
       takes an equal share of the full row width, no clipping).
     - On tablet/desktop (>=768px) the rows collapse into a single
       horizontal row (see the responsive media query below). */
  .filters-inner {
    display: flex;
    flex-direction: column;
    gap: 10px;
    width: min(1100px, 100%);
    margin-inline: auto;
  }
  .filter-row {
    display: flex;
    gap: 8px;
    align-items: center;
    width: 100%;
    min-width: 0;
  }
  .filter-row-filters { flex-wrap: nowrap; }
  .filter-row-chips { flex-wrap: nowrap; }
  /* Date + Language each take a proportional share of Row 1 so neither
     is squeezed off-screen. Date is slightly wider (the YYYY-MM-DD
     format needs the room); Language fills the rest. */
  .filter-wrap-date { flex: 1 1 55%; min-width: 0; display: inline-flex; align-items: center; gap: 8px; }
  .filter-wrap-language { flex: 1 1 45%; min-width: 0; }
  /* Type chips Row 2: each chip takes an equal share of the full row. */
  .filter-row-chips .type-chips { display: flex; gap: 6px; width: 100%; }
  .filter-row-chips .type-chip { flex: 1 1 0; min-width: 0; }

  /* F7-B: date selector — native <input type="date"> styled to match
     the existing Dropdown geometry so it sits cleanly on the filter row. */
  .date-label {
    color: var(--color-text-muted);
    font-size: .68rem;
    font-weight: 700;
    letter-spacing: .08em;
    text-transform: uppercase;
    white-space: nowrap;
    flex: 0 0 auto;
  }
  .date-input {
    flex: 1 1 auto;
    min-width: 0;
    min-height: 36px;
    padding: 0 10px;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    background: var(--color-surface);
    color: var(--color-text);
    font: inherit;
    font-size: .78rem;
    font-weight: 600;
    cursor: pointer;
    transition: border-color 150ms ease, background 150ms ease;
  }
  .date-input:hover { border-color: var(--color-primary-border); }
  .date-input:focus-visible { outline: 2px solid var(--color-focus); outline-offset: 2px; }
  /* Keep the native date-edit affordance but tone down the indicator
     icon so it matches the dark surface. Webkit + Firefox selectors. */
  .date-input::-webkit-calendar-picker-indicator {
    filter: invert(0.7);
    cursor: pointer;
  }

  /* F7: type chips — Movies / Shows / Anime on one row */
  .type-chips {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    flex: 0 0 auto;
  }
  .type-chip {
    min-height: 36px;
    padding: 0 14px;
    border: 1px solid var(--color-border);
    border-radius: 999px;
    background: var(--color-surface);
    color: var(--color-text-muted);
    font-size: .72rem;
    font-weight: 600;
    cursor: pointer;
    transition: border-color 150ms ease, background 150ms ease, color 150ms ease;
  }
  .type-chip:hover { border-color: var(--color-primary-border); color: var(--color-text); }
  .type-chip.active {
    border-color: var(--color-primary-border);
    background: var(--color-primary-soft);
    color: var(--color-primary);
  }
  .type-chip:focus-visible { outline: 2px solid var(--color-focus); outline-offset: 2px; }

  /* Date / Language labels stay in the DOM for aria-labelledby but are
     visually hidden — the selected values are self-descriptive, so
     labels would only burn a vertical row. */
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
    border: 1px solid rgba(255,194,71,.25);
    border-radius: var(--radius-sm);
    background: rgba(255,194,71,.04);
    color: var(--color-warning);
    font-size: .72rem;
    line-height: 1.5;
  }

  .month-heading {
    color: var(--color-text);
    font-size: 1.2rem; font-weight: 800;
    letter-spacing: -.015em;
    margin-bottom: 16px;
    /* F7-B UX fix: the concise date-window heading ("Sep 27 – Oct 26,
       2026") must stay one line on every viewport — wrapping would
       re-introduce the multi-line mess the user reported. */
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .day-groups { display: grid; gap: 24px; }
  .load-more-sentinel { min-height: 60px; display: grid; place-items: center; padding: 20px 0; }
  .loading-more { display: inline-flex; align-items: center; gap: 8px; color: var(--color-text-muted); font-size: .72rem; }
  .loading-more :global(svg) { animation: spin 0.8s linear infinite; }
  @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }

  /* Pagination failure state — a visible, keyboard-accessible retry. */
  .load-error {
    display: inline-flex; align-items: center; flex-wrap: wrap;
    justify-content: center; gap: 10px;
    padding: 10px 16px;
    border: 1px solid rgba(255,194,71,.25);
    border-radius: var(--radius-sm);
    background: rgba(255,194,71,.04);
    color: var(--color-warning);
    font-size: .72rem; font-weight: 600;
  }
  .load-error :global(svg) { flex: 0 0 auto; }
  .retry-inline { margin-top: 0; padding: 6px 16px; font-size: .68rem; }
  /* Filter-navigation failure reuses the pagination error chip, placed
     inside the filter bar. */
  .filter-nav-error { margin-top: 12px; }

  /* Clean end-of-results state. */
  .end-of-results {
    color: var(--color-text-deep);
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
    color: var(--color-text-muted); font-size: .72rem; font-weight: 700;
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
    border-radius: var(--radius-sm);
    border: 1px solid var(--color-border);
    background: linear-gradient(100deg, var(--color-surface-elevated) 40%, var(--color-surface-raised) 50%, var(--color-surface-elevated) 60%);
    background-size: 200% 100%;
    animation: shimmer 1.4s ease-in-out infinite;
  }
  @keyframes shimmer { from { background-position: 120% 0; } to { background-position: -80% 0; } }
  @media (min-width: 900px) {
    .skeleton-grid { grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); }
  }
  .day-group { display: grid; gap: 12px; }
  .day-label {
    margin: 0;
    color: var(--color-primary);
    font-size: .68rem; font-weight: 800;
    letter-spacing: .12em; text-transform: uppercase;
    padding-bottom: 8px;
    border-bottom: 1px solid var(--color-border);
    text-shadow: 0 0 10px rgba(0, 255, 156, .25);
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
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    background: var(--color-surface);
    color: inherit;
    text-decoration: none;
    transition: border-color var(--motion-fast) var(--ease-out), background var(--motion-fast) var(--ease-out), box-shadow var(--motion-fast) var(--ease-out);
  }
  .release-card:hover { border-color: var(--color-primary-border); background: var(--color-primary-soft); box-shadow: var(--glow-primary); }
  .release-card:focus-visible { outline: 2px solid var(--color-focus); outline-offset: 2px; }

  .card-poster {
    position: relative;
    width: 80px; aspect-ratio: 2 / 3;
    border-radius: var(--radius-sm); overflow: hidden;
    background: var(--color-surface-elevated);
    border: 1px solid var(--color-border);
  }
  .card-poster img { width: 100%; height: 100%; object-fit: cover; }
  .poster-fallback { display: grid; place-items: center; width: 100%; height: 100%; color: var(--color-text-deep); }
  .type-badge {
    position: absolute; top: 4px; left: 4px;
    padding: 2px 6px;
    border-radius: 4px;
    background: rgba(5,7,8,.7); backdrop-filter: blur(6px);
    color: var(--color-text);
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
    border: 1px solid var(--color-border-strong);
  }
  .provider-more {
    color: var(--color-text-deep);
    font-size: .56rem; font-weight: 700;
  }
  .card-title {
    margin: 0;
    color: var(--color-text);
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
    color: var(--color-text-muted);
    font-size: .64rem; font-weight: 600;
  }
  .ep-tag {
    padding: 2px 7px;
    border-radius: 4px;
    background: var(--color-primary-soft);
    border: 1px solid var(--color-primary-border);
    color: var(--color-primary);
    font-size: .58rem; font-weight: 800;
    letter-spacing: .03em;
  }
  /* Phase F — movie release channel tag (THEATRICAL / OTT). Shares the
     ep-tag geometry; only the tint differs so the channel is scannable
     without introducing a new component language. */
  .kind-tag {
    background: var(--color-secondary-soft);
    border-color: var(--color-border-strong);
    color: var(--color-secondary);
  }
  .date-tag { color: var(--color-text-muted); }
  .rating-tag {
    display: inline-flex; align-items: center; gap: 2px;
    color: #ffc94d;
    font-size: .58rem; font-weight: 700;
  }
  .episode-title {
    margin-top: 5px;
    color: var(--color-text-deep);
    font-size: .68rem; font-weight: 500;
    line-height: 1.35;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .genres-row {
    margin-top: 4px;
    color: var(--color-text-deep);
    font-size: .58rem;
    letter-spacing: .02em;
  }
  .release-card :global(.card-arrow) { color: var(--color-text-deep); align-self: center; flex: 0 0 auto; }

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
    border: 1px solid var(--color-border-strong);
    border-radius: 50%;
    color: var(--color-primary);
    background: var(--color-primary-soft);
    box-shadow: var(--glow-primary);
  }
  .error-mark { color: var(--color-warning); border-color: rgba(255,194,71,.3); background: rgba(255,194,71,.05); font-size: 1.4rem; font-weight: 800; }
  .empty-state h2, .error-state h2 {
    margin: 4px 0;
    color: var(--color-text);
    font-size: 1.3rem; font-weight: 800;
    letter-spacing: -.015em;
  }
  .empty-state p, .error-state p {
    margin: 0; max-width: 360px;
    color: var(--color-text-muted);
    font-size: .82rem; line-height: 1.6;
  }
  .empty-action, .retry-btn {
    margin-top: 12px;
    padding: 10px 22px;
    border: 1px solid var(--color-primary-border);
    border-radius: 999px;
    color: #050708;
    background: var(--color-primary);
    font: inherit;
    font-size: .76rem; font-weight: 700;
    cursor: pointer;
    box-shadow: 0 4px 18px rgba(0,255,156,.18), var(--glow-primary);
    transition: transform var(--motion-fast) var(--ease-out), filter var(--motion-fast) var(--ease-out);
  }
  .empty-action:hover, .retry-btn:hover { transform: translateY(-1px); filter: brightness(1.06); }
  .empty-action:focus-visible, .retry-btn:focus-visible { outline: 2px solid var(--color-focus); outline-offset: 2px; }

  /* F7-B UX fix: at <=640px the base styles already implement the
     two-row mobile layout (Row 1 = Date+Language, Row 2 = chips).
     We only need to tighten the heading + skeleton grid for small
     screens here — the filter rows themselves are handled by the
     base .filters-inner flex-direction: column rule. */
  @media (max-width: 640px) {
    .upcoming-header { padding-top: 22px; padding-bottom: 18px; }
    .upcoming-header h1 { font-size: clamp(1.5rem, 6vw, 2rem); }
    /* The concise date-window heading must stay one line. Allow it to
       shrink slightly on the narrowest phones so "Sep 27 – Oct 26,
       2026" never wraps. */
    .month-heading { font-size: 1.02rem; }
    .day-cards { grid-template-columns: 1fr; }
    .release-card { grid-template-columns: 64px 1fr auto; gap: 10px; padding: 10px; }
    .card-poster { width: 64px; }
  }
  /* F7-B UX fix: at >=768px (tablet + desktop) the two-row mobile
     layout collapses into a single horizontal row — Date + Type chips
     + Language all on one line. This matches the previous single-row
     desktop behavior, just with startDate replacing month/year. */
  @media (min-width: 768px) {
    .filters-inner { flex-direction: row; flex-wrap: wrap; gap: 10px; }
    .filter-row { width: auto; }
    .filter-row-filters { gap: 10px; }
    .filter-wrap-date { flex: 0 0 auto; }
    .filter-wrap-language { flex: 0 0 220px; }
    .filter-row-chips .type-chips { width: auto; }
    .filter-row-chips .type-chip { flex: 0 0 auto; }
  }
  /* Tablet — 2-3 columns per row. */
  @media (min-width: 641px) and (max-width: 1024px) {
    .day-cards { grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); }
  }
  @media (min-width: 900px) {
    .upcoming-header { padding-top: 44px; padding-bottom: 26px; }
    .upcoming-header h1 { font-size: clamp(2rem, 3.4vw, 2.8rem); }
    .day-cards { grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); }
  }
  /* Large desktop / TV — wider grid, more cards per row. */
  @media (min-width: 1900px) {
    .header-inner { width: min(1700px, 100%); }
    .upcoming-body { width: min(1700px, calc(100% - 2 * var(--u-gutter))); }
    .day-cards { grid-template-columns: repeat(auto-fill, minmax(360px, 1fr)); gap: 16px; }
  }
  @media (prefers-reduced-motion: reduce) {
    .skeleton-card, .loading-more :global(svg), .loading-inline :global(svg) { animation: none; }
    .release-card, .empty-action, .retry-btn { transition: none; }
  }
</style>
