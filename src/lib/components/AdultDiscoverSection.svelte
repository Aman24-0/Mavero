<script lang="ts">
  // Phase 8 — the authorized Adult Discover rail (the "Indian Adult Shows"
  // surface), migrated to the Phase 7 dedicated Adult Discover backend.
  //
  // 2026-10-07 MOVIE/TV SELECTOR REMOVAL: the Adult catalog is TV-ONLY. The
  // production audit proved the movie half had no verifiable source (the
  // Indian adult OTT services are TMDB TV networks, not JustWatch India
  // watch providers — the movie query resolved an always-empty catalog and
  // the selector's "Movies" option showed "No titles available" forever).
  // Per the follow-up decision rule the dead selector is REMOVED: no
  // media-type dropdown is rendered, the API request always omits the type
  // parameter (server default: TV series), and a stale `type=movie` URL is
  // rejected server-side with 400 — it can never re-activate a movie view.
  //
  // WHY A DEDICATED COMPONENT (not a DiscoverSection prop):
  //   The old rail fetched /api/discover/rail?section=adult-shows — the
  //   legacy merged movie+TV rail without the Phase 7 catalog features
  //   (per-type catalogs, classifier defense). The Adult surface now has
  //   its OWN endpoint with a different contract (provider/page), so
  //   its data loading is intentionally isolated from the normal rail
  //   machinery. The VISUAL language is shared: the same MediaCard,
  //   DiscoverDropdown, loading / error / empty states and Show-more
  //   pagination conventions as DiscoverSection (no duplicated card
  //   components, no redesign).
  //
  // SECURITY MODEL (the UI is NOT the boundary):
  //   - Visibility: the parent (DiscoverPage) renders this section only
  //     when the server-reported adult authorization state allows it
  //     (/api/settings/adult-mode -> canAccess). That is convenience only.
  //   - Authority: EVERY fetch goes to /api/content/adult-discover, which
  //     re-evaluates the Phase 5 policy per request and answers
  //     unauthorized requests with the non-disclosing 404. A 404 hides the
  //     rail — it can never reveal Adult data because the 404 body carries
  //     none. No client flag (adult/enabled/showAdult) is ever sent, and
  //     no authorization decision is made here.
  //   - PROVIDER FILTER (post-release fix): a CLOSED-UNION key ('all' or a
  //     VERIFIED Adult registry key served by the policy-gated
  //     /api/discover/adult-providers endpoint). The client never sends a
  //     TMDB network/provider id — the server maps the key to the verified
  //     network id itself and re-validates it per request (Adult AND
  //     provider, never OR). The language filter was REMOVED from this
  //     surface (the server contract still validates the language
  //     dimension for compatibility, defaulting to 'all').
  //   - Adult catalog data is never persisted browser-side; component state
  //     dies with the section.
  import { onMount } from 'svelte';
  import { ChevronLeft, ChevronRight, LoaderCircle, Plus, RotateCw } from 'lucide-svelte';
  import type { MediaItem } from '$data/content';
  import MediaCard from '$components/MediaCard.svelte';
  import DiscoverDropdown from '$components/DiscoverDropdown.svelte';
  import SkeletonCard from '$components/SkeletonCard.svelte';
  // MAV-25 WS1 — the SHARED carousel navigation helpers (the ContentRail
  // §11 contract) + the WS2 visible-row fill math. The Adult surface
  // deliberately mirrors DiscoverSection's visual language — the same
  // arrows, the same fill semantics, ONE shared implementation.
  import { railEdgeState, scrollRailByCards } from '$lib/shared/rail-navigation';
  import { rowFillTarget, ROW_FILL_ITEM_CAP, ROW_FILL_FETCH_BUDGET } from '$lib/shared/rail-row-fill';

  let { title = 'Indian Adult Shows' }: { title?: string } = $props();

  type ProviderOption = { value: string; label: string; logoUrl?: string };

  // 'all' plus the VERIFIED Adult networks served by the policy-gated
  // endpoint (same registry the classifier uses). Never a hardcoded brand
  // list, never unverified candidates, never raw TMDB ids.
  const ALL_PROVIDER_OPTION: ProviderOption = { value: 'all', label: 'All' };

  // Per-section state (same shape/conventions as DiscoverSection).
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
  let provider = $state<string>('all');
  let providerOptions = $state<ProviderOption[]>([ALL_PROVIDER_OPTION]);
  let hidden = $state(false);
  let requestSequence = 0;
  let requestController: AbortController | undefined;

  // MAV-25 WS1 — rail navigation arrows (the ContentRail §11 contract,
  // shared with DiscoverSection via $lib/shared/rail-navigation).
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

  // MAV-25 WS2 — visible-row fill (the same bounded driver as
  // DiscoverSection: measured container, existing loadMore pipeline,
  // ROW_FILL budgets, no placeholder cards). A provider-filtered Adult
  // catalog can return fewer items than a desktop row holds; the fill
  // tops it up through the same pagination when more pages exist.
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
    fillFetchesUsed += 1;
    await loadMore();
    if (token !== fillToken) return;
    scheduleRowFill();
  }

  function onRailResize(): void {
    updateRailState();
    const target = currentFillTarget();
    if (target !== lastFillTarget) scheduleRowFill();
  }

  // The Phase 7 API contract — ONLY the supported parameters (provider,
  // page). No `type` is sent at all: the catalog is TV-only and the server
  // defaults to TV series (2026-10-07 movie-half removal). No language
  // (filter removed from this surface), no source/TMDB passthrough
  // parameters, no adult flag: the server owns the source boundary, the
  // provider->network-id mapping and the authorization.
  function discoverUrl(targetPage: number) {
    const params = new URLSearchParams({
      provider,
      page: String(targetPage)
    });
    return `/api/content/adult-discover?${params.toString()}`;
  }

  // Load the VERIFIED Adult provider options (closed union the server
  // accepts). The endpoint is policy-gated and returns [] when
  // unauthorized; the section is hidden by then anyway. Display-only —
  // fetching this list never widens the catalog.
  async function loadProviderOptions() {
    try {
      const response = await fetch('/api/discover/adult-providers');
      if (!response.ok) return;
      const payload = await response.json();
      if (!payload?.ok || !Array.isArray(payload.providers)) return;
      providerOptions = [
        ALL_PROVIDER_OPTION,
        ...payload.providers
          .filter((entry: { key?: unknown; name?: unknown }) => typeof entry?.key === 'string' && typeof entry?.name === 'string' && entry.key !== 'all')
          .map((entry: { key: string; name: string; logoUrl?: string }) => ({ value: entry.key as string, label: entry.name as string, logoUrl: entry.logoUrl }))
      ];
    } catch { /* the 'All' option remains usable — never blocks the rail */ }
  }

  async function loadFirst() {
    requestSequence += 1;
    const requestId = requestSequence;
    requestController?.abort();
    const controller = new AbortController();
    requestController = controller;
    loading = true;
    loadingMore = false;
    errorMessage = '';
    showMoreError = '';
    try {
      const response = await fetch(discoverUrl(1), { signal: controller.signal });
      if (requestId !== requestSequence || controller.signal.aborted) return;
      // A 404 is the API's non-disclosing "unauthorized" answer (e.g. the
      // admin policy flipped OFF mid-session). The Adult surface simply
      // disappears — no error text, no data (the 404 body carries none).
      if (response.status === 404) {
        hidden = true;
        items = [];
        hasNextPage = false;
        return;
      }
      const payload = await response.json();
      if (!response.ok || !payload.ok) throw new Error(payload?.error?.message || 'Section is temporarily unavailable.');
      if (requestId !== requestSequence) return;
      items = payload.items as MediaItem[];
      currentPage = 1;
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
    loadingMore = true;
    showMoreError = ''; // Phase 2-L: clear any previous Show-more error.
    try {
      const nextPage = currentPage + 1;
      const response = await fetch(discoverUrl(nextPage));
      if (requestId !== requestSequence) return;
      if (response.status === 404) {
        // Authorization revoked between pages — stop paginating, keep the
        // already-rendered titles (they were authorized when loaded) and
        // hide the "Show more" affordance. No new data arrives.
        hasNextPage = false;
        return;
      }
      const payload = await response.json();
      if (!response.ok || !payload.ok) throw new Error(payload?.error?.message || 'Could not load more titles.');
      if (requestId !== requestSequence) return;
      const incoming = payload.items as MediaItem[];
      // Append to existing — do NOT replace. Dedupe by canonical type+id.
      const seen = new Set(items.map((i) => `${i.type}:${i.id}`));
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

  function changeProvider(next: string) {
    if (next === provider) return;
    provider = next;
    // MAV-25 WS2: a provider change is a NEW logical load — the row-fill
    // budget resets with it and any in-flight fill is invalidated.
    fillFetchesUsed = 0;
    lastFillTarget = 0;
    fillToken += 1;
    void loadFirst();
  }

  let mounted = false;

  onMount(() => {
    mounted = true;
    void loadFirst();
    void loadProviderOptions();
    return () => {
      mounted = false;
      requestSequence += 1;
      requestController?.abort();
      fillToken += 1;
    };
  });

  // MAV-25 WS1 — the observer attaches REACTIVELY to the populated rail
  // (the loading state renders the skeleton instead) and cleans up on
  // unmount — no stale observers.
  $effect(() => {
    const rail = railEl;
    if (!rail) return;
    updateRailState();
    const resizeObserver =
      typeof ResizeObserver === 'function' ? new ResizeObserver(() => onRailResize()) : undefined;
    resizeObserver?.observe(rail);
    return () => resizeObserver?.disconnect();
  });

  // Re-sync arrow edge state on item-set changes and (re-)evaluate the
  // WS2 visible-row fill once a load settles (rAF-scheduled — the async
  // work runs outside the effect; no effect loops).
  $effect(() => {
    void items.length;
    void hasNextPage;
    void loading;
    void loadingMore;
    updateRailState();
    if (!loading && !loadingMore && items.length > 0) scheduleRowFill();
  });
</script>

{#if !hidden}
  <section class="adult-discover-section" aria-labelledby={`adult-discover-title`} data-adult-surface>
    <div class="section-head">
      <div class="section-head-left">
        <h2 id="adult-discover-title" class="section-title"><span class="adult-badge" aria-hidden="true">18+</span>{title}</h2>
      </div>
      <div class="section-head-right">
        <!-- Provider filter: full (labelled) instance and compact (icon-only)
             instance share the same options/value/handler. Exactly one is
             visible at any width. The Movies/TV media-type selector was
             REMOVED (2026-10-07): the Adult catalog is TV-only — see the
             script header note. -->
        <span class="provider-full">
          <DiscoverDropdown
            label="All"
            ariaLabel={`Filter ${title} by provider`}
            options={providerOptions}
            value={provider}
            onChange={changeProvider}
          />
        </span>
        <span class="provider-compact">
          <DiscoverDropdown
            label="All"
            compact
            ariaLabel={`Filter ${title} by provider`}
            options={providerOptions}
            value={provider}
            onChange={changeProvider}
          />
        </span>
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
             a separate row underneath) — the same endcap pattern as
             DiscoverSection. Appending new grid columns to the right keeps
             the user's horizontal scroll position stable. -->
        <!-- MAV-25 WS1 — the same shared navigation arrows as
             DiscoverSection (visible ≥641px, disabled at the scroll
             ends, hidden on phones). They scroll ONLY this rail. -->
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
{/if}

<style>
  /* Visual conventions mirror DiscoverSection (same design tokens, same
     spacing) with ONE deliberate distinction: the section title carries a
     small "18+" badge so the Adult surface is clearly distinguishable from
     normal catalog surfaces without redesigning anything. */
  .adult-discover-section {
    margin-top: 36px;
    padding: 0 var(--d-gutter, clamp(16px, 5vw, 48px));
  }
  /* ONE responsive header row at every width: the heading (left, ellipsis-
     truncated) and the filter controls (right, non-shrinking) can never
     wrap into a broken second row. */
  .section-head {
    display: flex; align-items: center; justify-content: space-between; gap: 12px;
    flex-wrap: nowrap;
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
    display: inline-flex; align-items: center; gap: 8px;
    min-width: 0; max-width: 100%;
  }
  .adult-badge {
    display: inline-flex; align-items: center; justify-content: center;
    min-width: 26px; height: 16px;
    padding: 0 5px;
    border: 1px solid rgba(255,255,255,.28);
    border-radius: 4px;
    color: #f5f5f5;
    background: rgba(255,255,255,.06);
    font-size: .58rem; font-weight: 800; letter-spacing: .04em;
    flex-shrink: 0;
  }
  /* Provider filter visibility switch: labelled pill by default, icon-only
     on very narrow viewports. aria-hidden on the hidden instance keeps the
     accessibility tree clean (exactly one control exposed). */
  .provider-compact { display: none; }

  .section-body { min-height: 60px; }
  /* MAV-25 WS1 — the shared navigation arrows (identical contract and
     visual language to DiscoverSection's — one composition: the wrap
     clips overflow, the arrows sit OUTSIDE the rail scrollport). */
  .rail-wrap { position: relative; overflow: hidden; border-radius: 14px; }
  .rail {
    display: grid; grid-auto-flow: column; grid-auto-columns: 178px; gap: 14px;
    overflow-x: auto; overflow-y: visible; scroll-snap-type: x proximity;
    scrollbar-width: none; padding: 6px 2px 12px;
  }
  .rail::-webkit-scrollbar { display: none; }
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
  .rail-nav:focus-visible { outline: 2px solid var(--color-focus, #f5f5f5); outline-offset: 2px; }
  .rail-nav:hover:not(:disabled) {
    background: rgba(0, 255, 156, .12);
    border-color: var(--color-primary-border, rgba(0, 255, 156, .4));
    box-shadow: var(--glow-primary, 0 0 18px rgba(0, 255, 156, .18));
  }
  .rail-nav:disabled { opacity: .22; pointer-events: none; box-shadow: none; }
  .rail-nav-prev { left: 6px; }
  .rail-nav-next { right: 6px; }

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
  /* Phase 2-L: Show-more error — preserved rail + inline retry inside
     the endcap. */
  .show-more-error {
    margin: 0;
    color: #ffb020;
    font-size: .62rem; font-weight: 600; line-height: 1.35;
    text-align: center;
  }
  /* Phase 2-H: skeleton rail uses the same grid as the populated rail so
     the section height is stable from first paint. */
  .skeleton-rail { min-height: 0; }
  @keyframes spin { to { transform: rotate(360deg); } }

  /* MAV-20 Phase C — the inline terminal Show More card (the same endcap
     pattern as DiscoverSection: one rail column, dashed glass panel,
     stretches to the row height, never looks like a poster). */
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
  .show-more-card.retry { border-style: solid; border-color: rgba(255, 176, 32, .45); color: #ffb020; background: rgba(255, 176, 32, .06); }
  .show-more-card.retry:hover:not(:disabled) { background: rgba(255, 176, 32, .14); border-color: rgba(255, 176, 32, .65); }

  @media (max-width: 640px) {
    .adult-discover-section { margin-top: 28px; }
    .section-head { gap: 8px; }
    .section-title { font-size: 1.05rem; }
    .rail { grid-auto-columns: 40vw; gap: 10px; }
    .section-head-right { gap: 6px; }
    /* MAV-25 WS1 — arrows hidden on phones (native swipe preserved). */
    .rail-nav { display: none; }
  }
  /* Very narrow viewports: collapse the provider filter to the icon-only
     compact control so heading + badge + content-type pill + provider
     control share ONE row (390px QA width) without overlap. */
  @media (max-width: 480px) {
    .provider-full { display: none; }
    .provider-compact { display: inline-flex; }
  }
  @media (min-width: 1900px) {
    .rail { grid-auto-columns: 210px; gap: 18px; }
    .rail-nav { width: 44px; height: 64px; }
  }
  @media (prefers-reduced-motion: reduce) {
    .show-more-card :global(svg) { animation: none; }
    .show-more-card { transition: none; }
    .rail-nav { transition: none; }
  }
</style>
