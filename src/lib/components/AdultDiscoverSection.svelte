<script lang="ts">
  // Phase 8 — the authorized Adult Discover rail (the "Indian Adult Shows"
  // surface), migrated to the Phase 7 dedicated Adult Discover backend.
  //
  // WHY A DEDICATED COMPONENT (not a DiscoverSection prop):
  //   The old rail fetched /api/discover/rail?section=adult-shows — the
  //   legacy merged movie+TV rail without the Phase 7 catalog features
  //   (per-type catalogs, classifier defense). The Adult surface now has
  //   its OWN endpoint with a different contract (type/provider/page), so
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
  type AdultDiscoverType = 'movie' | 'series';

  import { onMount } from 'svelte';
  import { LoaderCircle, Plus } from 'lucide-svelte';
  import type { MediaItem } from '$data/content';
  import MediaCard from '$components/MediaCard.svelte';
  import DiscoverDropdown from '$components/DiscoverDropdown.svelte';

  let { title = 'Indian Adult Shows' }: { title?: string } = $props();

  type TypeOption = { value: AdultDiscoverType; label: string };
  type ProviderOption = { value: string; label: string; logoUrl?: string };

  const TYPE_OPTIONS: TypeOption[] = [
    { value: 'series', label: 'TV Shows' },
    { value: 'movie', label: 'Movies' }
  ];

  // 'all' plus the VERIFIED Adult networks served by the policy-gated
  // endpoint (same registry the classifier uses). Never a hardcoded brand
  // list, never unverified candidates, never raw TMDB ids.
  const ALL_PROVIDER_OPTION: ProviderOption = { value: 'all', label: 'All' };

  // Per-section state (same shape/conventions as DiscoverSection).
  let items = $state<MediaItem[]>([]);
  let loading = $state(false);
  let loadingMore = $state(false);
  let errorMessage = $state('');
  let page = $state(1);
  let hasNextPage = $state(false);
  let type = $state<AdultDiscoverType>('series');
  let provider = $state<string>('all');
  let providerOptions = $state<ProviderOption[]>([ALL_PROVIDER_OPTION]);
  let hidden = $state(false);
  let requestSequence = 0;
  let requestController: AbortController | undefined;

  // The Phase 7 API contract — ONLY the supported parameters (type,
  // provider, page). No language (filter removed from this surface), no
  // source/TMDB passthrough parameters, no adult flag: the server owns the
  // source boundary, the provider->network-id mapping and the
  // authorization.
  function discoverUrl(targetPage: number) {
    const params = new URLSearchParams({
      type,
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
    loadingMore = true;
    try {
      const nextPage = page + 1;
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
      page = nextPage;
      hasNextPage = Boolean(payload.hasNextPage);
    } catch (error) {
      if (requestId !== requestSequence) return;
      errorMessage = error instanceof Error ? error.message : 'Could not load more titles.';
    } finally {
      if (requestId === requestSequence) loadingMore = false;
    }
  }

  function changeType(next: string) {
    const nextType = next as AdultDiscoverType;
    if (nextType === type) return;
    type = nextType;
    void loadFirst();
  }

  function changeProvider(next: string) {
    if (next === provider) return;
    provider = next;
    void loadFirst();
  }

  onMount(() => {
    void loadFirst();
    void loadProviderOptions();
    return () => {
      requestSequence += 1;
      requestController?.abort();
    };
  });
</script>

{#if !hidden}
  <section class="adult-discover-section" aria-labelledby={`adult-discover-title`} data-adult-surface>
    <div class="section-head">
      <div class="section-head-left">
        <h2 id="adult-discover-title" class="section-title"><span class="adult-badge" aria-hidden="true">18+</span>{title}</h2>
      </div>
      <div class="section-head-right">
        <DiscoverDropdown
          label="TV Shows"
          ariaLabel={`Filter ${title} by catalog type`}
          options={TYPE_OPTIONS}
          value={type}
          onChange={changeType}
        />
        <!-- Provider filter: full (labelled) instance and compact (icon-only)
             instance share the same options/value/handler. Exactly one is
             visible at any width, so the filter NEVER wraps to a second row:
             wide viewports show both labelled pills; very narrow viewports
             keep the content-type pill and collapse the provider filter to
             an icon-only control (same tap target, same dropdown panel,
             same aria-label). -->
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
    .adult-discover-section { margin-top: 28px; }
    .section-head { gap: 8px; }
    .section-title { font-size: 1.05rem; }
    .rail { grid-auto-columns: 40vw; gap: 10px; }
    .section-head-right { gap: 6px; }
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
  }
  @media (prefers-reduced-motion: reduce) {
    .section-loading :global(svg), .show-more :global(svg) { animation: none; }
  }
</style>
