<script lang="ts" module>
  // Shared types re-exported from the shared downloader module so the
  // DetailPage and DownloadSheet stay aligned on the public contract.
  export type { PublicDownloadProvider } from '$lib/shared/downloader';
</script>

<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { X, Download, ExternalLink, ChevronDown, AlertTriangle, Loader2, CalendarClock } from 'lucide-svelte';
  import {
    filterProvidersByMediaType,
    getDownloadUrlCandidates,
    type DownloadMediaType,
    type DownloadUrlCandidate,
    type PublicDownloadProvider,
  } from '$lib/shared/downloader';

  // ----- Props -----
  // Props are explicit per the spec. The parent (DetailPage) supplies the
  // resolved provider list + the media context. The sheet itself is purely
  // presentational + owns the open/close + iframe lifecycle.
  export let open = false;
  export let title = '';
  export let providers: PublicDownloadProvider[] = [];
  export let selectedProviderId: string | null = null;
  export let mediaType: DownloadMediaType = 'movie';
  export let tmdbId = '';
  export let season: number | undefined = undefined;
  export let episode: number | undefined = undefined;
  // Optional release year, used ONLY to compute a Cineverse alternate URL
  // candidate (e.g. "dhurandhar-the-revenge-2026"). Other providers ignore
  // this prop entirely. The primary iframe URL is always the year-less
  // deterministic slug; the alternate is offered as a manual fallback.
  export let releaseYear: number | undefined = undefined;
  export let onClose: () => void = () => {};

  // ----- Internal state -----
  // The currently-selected provider (object, not just id) — recomputed when
  // the parent's id prop or the providers list changes. We track this
  // separately so the dropdown's value survives provider-list refreshes.
  let activeProvider: PublicDownloadProvider | null = null;
  let iframeUrl: string | null = null;
  let iframeLoading = true;
  let iframeError = false;
  let sheetElement: HTMLDivElement | null = null;
  let previouslyFocused: HTMLElement | null = null;
  let dropdownOpen = false;

  // Cineverse alternate-URL state. When the active provider has a
  // year-suffixed alternate URL candidate, we surface a "Try with year"
  // affordance in the fallback bar. The user can swap the iframe src to
  // the alternate manually — we do NOT do this automatically (cross-origin
  // iframe onload cannot reliably detect a Cineverse 404).
  let urlCandidates: DownloadUrlCandidate[] = [];
  let alternateUrl: string | null = null;
  let useAlternate = false;

  // Body scroll lock: restored on close. We snapshot the previous overflow
  // value rather than assuming 'auto' so we don't clobber a custom scroll
  // lock set by another component (none today, but defensive).
  let previousBodyOverflow = '';

  // ----- Derived: filtered providers for the current media type -----
  // Providers that don't support the current content type are hidden from
  // the dropdown entirely (per spec).
  $: filteredProviders = filterProvidersByMediaType(providers, mediaType);

  // ----- Resolve the active provider -----
  // Priority:
  //   1. selectedProviderId prop (if it's in the filtered list)
  //   2. the isDefault provider (if present in the filtered list)
  //   3. the first provider in the filtered list
  // If none of those resolve (e.g. all providers were filtered out), the
  // sheet shows the empty state.
  function resolveActive(list: PublicDownloadProvider[]): PublicDownloadProvider | null {
    if (list.length === 0) return null;
    if (selectedProviderId) {
      const match = list.find((p) => p.id === selectedProviderId);
      if (match) return match;
    }
    const def = list.find((p) => p.isDefault);
    if (def) return def;
    return list[0];
  }

  $: activeProvider = resolveActive(filteredProviders);

  // ----- Compute URL candidates + iframe URL whenever inputs change -----
  // The PRIMARY URL is always buildDownloadUrl()'s output (year-less for
  // Cineverse, TMDB-id for everyone else). For Cineverse only, when a
  // releaseYear is supplied, an ALTERNATE year-suffixed URL is computed
  // and offered as a manual fallback (the user can swap the iframe src
  // to it via the "Try with year" button in the fallback bar).
  $: if (activeProvider && open) {
    urlCandidates = getDownloadUrlCandidates(activeProvider, { mediaType, tmdbId, title, season, episode, releaseYear });
    alternateUrl = urlCandidates.length > 1 ? urlCandidates[1].url : null;
    // Reset the useAlternate toggle whenever the active provider or media
    // context changes — a fresh sheet open always starts with the primary
    // URL (deterministic, no surprises).
    useAlternate = false;
    iframeUrl = urlCandidates.length > 0 ? urlCandidates[0].url : null;
    iframeLoading = iframeUrl !== null;
    iframeError = false;
  } else if (!activeProvider) {
    urlCandidates = [];
    alternateUrl = null;
    useAlternate = false;
    iframeUrl = null;
    iframeLoading = false;
  }

  // The currently-rendered iframe URL: primary by default, alternate when
  // the user has manually toggled to it.
  $: renderedIframeUrl = useAlternate && alternateUrl ? alternateUrl : iframeUrl;

  // ----- Body scroll lock + focus management -----
  function lockBodyScroll() {
    if (typeof document === 'undefined') return;
    previousBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
  }
  function restoreBodyScroll() {
    if (typeof document === 'undefined') return;
    document.body.style.overflow = previousBodyOverflow;
  }

  function focusSheet() {
    requestAnimationFrame(() => {
      sheetElement?.focus();
    });
  }

  function restoreFocus() {
    if (previouslyFocused && typeof previouslyFocused.focus === 'function') {
      previouslyFocused.focus();
    }
  }

  // ----- Open/close lifecycle -----
  // We watch `open` so the parent can drive the sheet via a boolean prop
  // (matches the existing SelectionSheet pattern). On open: lock scroll +
  // capture focus + move focus into the sheet. On close: restore scroll +
  // restore focus.
  let lastOpen = false;
  $: {
    if (open && !lastOpen) {
      if (typeof document !== 'undefined' && document.activeElement instanceof HTMLElement) {
        previouslyFocused = document.activeElement;
      }
      lockBodyScroll();
      focusSheet();
    } else if (!open && lastOpen) {
      restoreBodyScroll();
      restoreFocus();
      dropdownOpen = false;
    }
    lastOpen = open;
  }

  onDestroy(() => {
    // Defensive: if the component is destroyed while the sheet is open,
    // restore body scroll so the rest of the app doesn't stay locked.
    if (lastOpen) restoreBodyScroll();
  });

  // ----- Escape key handler -----
  function handleKeydown(event: KeyboardEvent) {
    if (!open) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      if (dropdownOpen) {
        dropdownOpen = false;
        return;
      }
      onClose();
    }
  }

  // ----- iframe load/error -----
  // Cross-origin iframe load errors cannot always be detected reliably.
  // We provide an explicit "Open Downloader" fallback link regardless so
  // the user is never stuck on a blank sheet.
  function handleIframeLoad() {
    iframeLoading = false;
  }
  function handleIframeError() {
    iframeLoading = false;
    iframeError = true;
  }

  // ----- Provider dropdown -----
  function toggleDropdown() {
    dropdownOpen = !dropdownOpen;
  }
  function chooseProvider(provider: PublicDownloadProvider) {
    activeProvider = provider;
    selectedProviderId = provider.id;
    dropdownOpen = false;
    // The reactive $: if (activeProvider && open) block above will
    // recompute urlCandidates, alternateUrl, useAlternate (reset to
    // false), and iframeUrl. We don't need to set iframeUrl manually
    // here — doing so would overwrite the candidate-aware reactive
    // assignment with the primary URL only.
    iframeLoading = true;
    iframeError = false;
  }

  // User-initiated swap to the Cineverse alternate year-suffixed URL.
  // Resets the loading state so the spinner shows while the new iframe
  // src loads.
  function toggleAlternate() {
    if (!alternateUrl) return;
    useAlternate = !useAlternate;
    iframeLoading = true;
    iframeError = false;
  }

  function handleBackdropClick() {
    onClose();
  }

  // Close the dropdown on any outside click. We listen at the window level
  // because the dropdown is positioned absolutely inside the sheet.
  function handleWindowClick(event: MouseEvent) {
    if (!dropdownOpen) return;
    const target = event.target as HTMLElement | null;
    if (target && !target.closest('.dl-dropdown') && !target.closest('.dl-dropdown-trigger')) {
      dropdownOpen = false;
    }
  }

  $: sheetTitle = title ? `Download ${title}` : 'Download';
  $: iframeTitle = activeProvider ? `Download ${activeProvider.name} for ${title || 'this title'}` : 'Download';
  $: hasProviders = filteredProviders.length > 0;
</script>

<svelte:window onkeydown={handleKeydown} onclick={handleWindowClick} />

{#if open}
  <div class="dl-layer" role="presentation">
    <button class="dl-backdrop" aria-label="Close download sheet" onclick={handleBackdropClick}></button>
    <div
      class="dl-sheet"
      role="dialog"
      aria-modal="true"
      aria-labelledby="dl-sheet-title"
      tabindex="-1"
      bind:this={sheetElement}
    >
      <div class="dl-handle" aria-hidden="true"></div>

      <header class="dl-header">
        <div class="dl-header-title">
          <div class="dl-eyebrow">MAVERO / Download</div>
          <h2 id="dl-sheet-title">{sheetTitle}</h2>
        </div>

        <div class="dl-header-controls">
          {#if hasProviders}
            <div class="dl-dropdown">
              <button
                type="button"
                class="dl-dropdown-trigger"
                onclick={toggleDropdown}
                aria-haspopup="listbox"
                aria-expanded={dropdownOpen}
              >
                <span class="dl-dropdown-label">{activeProvider?.name ?? 'Select'}</span>
                <ChevronDown size={14} />
              </button>
              {#if dropdownOpen}
                <ul class="dl-dropdown-menu" role="listbox" aria-label="Download providers">
                  {#each filteredProviders as provider}
                    <li>
                      <button
                        type="button"
                        role="option"
                        aria-selected={provider.id === activeProvider?.id}
                        class="dl-dropdown-item"
                        class:active={provider.id === activeProvider?.id}
                        onclick={() => chooseProvider(provider)}
                      >
                        <span class="dl-item-name">{provider.name}</span>
                        {#if provider.isDefault}
                          <span class="dl-item-badge">Default</span>
                        {/if}
                      </button>
                    </li>
                  {/each}
                </ul>
              {/if}
            </div>
          {/if}

          <button type="button" class="dl-close" aria-label="Close download sheet" onclick={onClose}>
            <X size={16} />
          </button>
        </div>
      </header>

      <div class="dl-body">
        {#if !hasProviders}
          <!-- Empty state: no enabled providers support this content type. -->
          <div class="dl-empty">
            <AlertTriangle size={26} />
            <h3>No downloaders available</h3>
            <p>Downloading is not configured for this content type right now. Please try again later.</p>
          </div>
        {:else if iframeUrl === null}
          <!-- getDownloadUrlCandidates() returned no candidates: the active
               provider cannot produce a valid URL for this title (missing
               TMDB id, missing title for the {titleSlug} placeholder,
               unsupported media type, or a non-HTTPS template). There is NO
               resolvable URL to link to — so we do NOT show a fallback
               "Open" link here. The only recovery is to switch provider or
               close the sheet. -->
          <div class="dl-empty">
            <AlertTriangle size={26} />
            <h3>This downloader can't open this title</h3>
            <p>{activeProvider?.name} could not generate a download link for this title. Try another provider from the dropdown above.</p>
          </div>
        {:else}
          <div class="dl-frame-wrap">
            {#if iframeLoading}
              <div class="dl-loading" role="status" aria-live="polite">
                <span class="dl-spin"><Loader2 size={22} /></span>
                <span>Loading {activeProvider?.name ?? 'downloader'}{#if useAlternate} (year-suffixed){/if}…</span>
              </div>
            {/if}
            {#if iframeError}
              <div class="dl-empty">
                <AlertTriangle size={26} />
                <h3>Couldn't embed {activeProvider?.name}</h3>
                <p>This downloader may not allow embedding. You can still open it in a new tab.</p>
                <a class="dl-open-external" href={renderedIframeUrl} target="_blank" rel="noopener noreferrer">
                  <ExternalLink size={14} /> Open {activeProvider?.name}
                </a>
              </div>
            {:else}
              <iframe
                class="dl-frame"
                class:hidden={iframeLoading}
                title={iframeTitle}
                src={renderedIframeUrl}
                loading="eager"
                referrerpolicy="no-referrer"
                allow="fullscreen; encrypted-media"
                onload={handleIframeLoad}
                onerror={handleIframeError}
              ></iframe>
            {/if}
          </div>
          <!-- Always-available fallback bar. Uses the SAME resolved URL
               that the iframe src uses (primary or alternate) — never a raw
               template. Cross-origin iframe load errors cannot always be
               detected; the "Open in new tab" link guarantees the user can
               reach the downloader page directly. -->
          <div class="dl-fallback-bar">
            <span>
              Can't see the downloader?
              {#if useAlternate && alternateUrl}
                <span class="dl-alt-tag">Showing year-suffixed URL</span>
              {/if}
            </span>
            <span class="dl-fallback-actions">
              {#if alternateUrl}
                <button
                  type="button"
                  class="dl-alt-toggle"
                  onclick={toggleAlternate}
                  aria-pressed={useAlternate}
                  title={useAlternate ? 'Switch back to the primary URL' : 'Try the year-suffixed URL'}
                >
                  <CalendarClock size={13} />
                  {useAlternate ? 'Use primary' : 'Try with year'}
                </button>
              {/if}
              <a href={renderedIframeUrl} target="_blank" rel="noopener noreferrer">
                <ExternalLink size={13} /> Open in new tab
              </a>
            </span>
          </div>
        {/if}
      </div>

      <div class="dl-safe-area" aria-hidden="true"></div>
    </div>
  </div>
{/if}

<style>
  .dl-layer {
    position: fixed;
    inset: 0;
    z-index: 95;
    display: grid;
    align-items: end;
    /* Allow pointer events through to the backdrop, but the sheet itself
       captures its own. */
  }
  .dl-backdrop {
    position: absolute;
    inset: 0;
    border: 0;
    background: rgba(3, 6, 7, 0.82);
    backdrop-filter: blur(10px);
    cursor: default;
    animation: dl-fade 200ms var(--ease-out, cubic-bezier(.22, 1, .36, 1));
  }
  .dl-sheet {
    position: relative;
    width: min(100%, 980px);
    /* ~70vh target per spec. Use min(70dvh, ...) so very small viewports
       still leave room for the device chrome. */
    height: min(70dvh, 720px);
    max-height: 90dvh;
    margin: 0 auto;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    border: 1px solid rgba(255, 255, 255, 0.14);
    border-bottom: 0;
    border-radius: var(--radius-xl, 26px) var(--radius-xl, 26px) 0 0;
    background: #0d0d0d;
    box-shadow: 0 -18px 80px rgba(0, 0, 0, 0.55);
    animation: dl-sheet-in 260ms var(--ease-out, cubic-bezier(.22, 1, .36, 1));
    outline: none;
  }
  .dl-handle {
    width: 38px;
    height: 4px;
    margin: 10px auto 0;
    border-radius: 99px;
    background: rgba(245, 246, 250, 0.25);
    flex: 0 0 auto;
  }
  .dl-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 16px;
    padding: 12px 18px 12px;
    border-bottom: 1px solid rgba(255, 255, 255, 0.08);
    flex: 0 0 auto;
  }
  .dl-header-title { min-width: 0; flex: 1; }
  .dl-eyebrow {
    color: #646464;
    font-family: 'Inter', ui-sans-serif, system-ui, sans-serif;
    font-size: 0.5rem;
    font-weight: 700;
    letter-spacing: 0.14em;
    text-transform: uppercase;
  }
  .dl-header h2 {
    margin: 4px 0 0;
    color: #f5f5f5;
    font-size: 1rem;
    font-weight: 800;
    letter-spacing: -0.015em;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .dl-header-controls {
    display: flex;
    align-items: center;
    gap: 8px;
    flex: 0 0 auto;
  }

  /* Dropdown */
  .dl-dropdown { position: relative; }
  .dl-dropdown-trigger {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    border: 1px solid rgba(255, 255, 255, 0.14);
    border-radius: 999px;
    color: #f5f5f5;
    background: rgba(255, 255, 255, 0.06);
    font-size: 0.72rem;
    font-weight: 700;
    cursor: pointer;
    transition: background 180ms ease, border-color 180ms ease;
    max-width: 220px;
  }
  .dl-dropdown-trigger:hover { background: rgba(255, 255, 255, 0.12); border-color: rgba(255, 255, 255, 0.24); }
  .dl-dropdown-label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .dl-dropdown-menu {
    position: absolute;
    top: calc(100% + 6px);
    right: 0;
    z-index: 2;
    min-width: 220px;
    max-width: 320px;
    margin: 0;
    padding: 6px;
    list-style: none;
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 12px;
    background: #141414;
    box-shadow: 0 18px 44px rgba(0, 0, 0, 0.6);
    animation: dl-fade 140ms ease;
  }
  .dl-dropdown-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    width: 100%;
    padding: 9px 11px;
    border: 0;
    border-radius: 8px;
    color: #c7c7cc;
    background: transparent;
    font-size: 0.74rem;
    font-weight: 600;
    text-align: left;
    cursor: pointer;
    transition: background 140ms ease, color 140ms ease;
  }
  .dl-dropdown-item:hover { background: rgba(255, 255, 255, 0.06); color: #f5f5f5; }
  .dl-dropdown-item.active { background: rgba(255, 255, 255, 0.1); color: #fff; }
  .dl-item-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .dl-item-badge {
    flex: 0 0 auto;
    padding: 2px 7px;
    border-radius: 999px;
    color: #0d0d0d;
    background: #f5f5f5;
    font-size: 0.55rem;
    font-weight: 800;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .dl-close {
    display: grid;
    place-items: center;
    width: 34px;
    height: 34px;
    border: 1px solid rgba(255, 255, 255, 0.14);
    border-radius: 50%;
    color: #b7b7bd;
    background: rgba(245, 246, 250, 0.04);
    cursor: pointer;
    transition: color 180ms ease, border-color 180ms ease, background 180ms ease;
  }
  .dl-close:hover { color: #fff; border-color: rgba(255, 255, 255, 0.3); background: rgba(255, 255, 255, 0.08); }

  .dl-body {
    flex: 1 1 auto;
    display: flex;
    flex-direction: column;
    min-height: 0;
    overflow: hidden;
  }

  /* iframe area: occupies essentially all remaining sheet space. */
  .dl-frame-wrap {
    position: relative;
    flex: 1 1 auto;
    min-height: 0;
    background: #000;
  }
  .dl-frame {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    border: 0;
    background: #000;
  }
  .dl-frame.hidden { opacity: 0; pointer-events: none; }

  .dl-loading {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 12px;
    color: #b7b7bd;
    background: #0a0a10;
    font-size: 0.78rem;
  }
  .dl-spin { animation: dl-spin 0.9s linear infinite; }

  /* Empty / error state */
  .dl-empty {
    flex: 1 1 auto;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 10px;
    padding: 40px 20px;
    text-align: center;
    color: #b7b7bd;
    background: #0a0a10;
  }
  .dl-empty h3 { margin: 6px 0 0; color: #f5f5f5; font-size: 1rem; font-weight: 800; }
  .dl-empty p { margin: 0; max-width: 460px; color: #969696; font-size: 0.78rem; line-height: 1.6; }
  .dl-open-external {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    margin-top: 14px;
    padding: 10px 16px;
    border-radius: 999px;
    color: #0d0d0d;
    background: #f5f5f5;
    font-size: 0.78rem;
    font-weight: 800;
    text-decoration: none;
    transition: transform 180ms ease, box-shadow 180ms ease;
  }
  .dl-open-external:hover { transform: translateY(-1px); box-shadow: 0 8px 24px rgba(255, 255, 255, 0.18); }

  /* Fallback bar — always visible when an iframe is rendered. */
  .dl-fallback-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    padding: 9px 18px;
    border-top: 1px solid rgba(255, 255, 255, 0.08);
    background: #0d0d0d;
    color: #646464;
    font-size: 0.66rem;
    flex: 0 0 auto;
  }
  .dl-fallback-bar a {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    color: #f5f5f5;
    font-weight: 700;
    text-decoration: none;
  }
  .dl-fallback-bar a:hover { text-decoration: underline; text-underline-offset: 3px; }

  .dl-fallback-actions {
    display: inline-flex;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
  }
  .dl-alt-toggle {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 4px 10px;
    border: 1px solid rgba(255, 255, 255, 0.14);
    border-radius: 999px;
    color: #c7c7cc;
    background: rgba(255, 255, 255, 0.04);
    font: inherit;
    font-size: 0.6rem;
    font-weight: 700;
    cursor: pointer;
    transition: color 180ms ease, background 180ms ease, border-color 180ms ease;
  }
  .dl-alt-toggle:hover { color: #f5f5f5; background: rgba(255, 255, 255, 0.1); border-color: rgba(255, 255, 255, 0.24); }
  .dl-alt-toggle[aria-pressed='true'] { color: #0d0d0d; background: #f5f5f5; border-color: transparent; }
  .dl-alt-tag {
    display: inline-block;
    margin-left: 6px;
    padding: 1px 7px;
    border-radius: 999px;
    color: #0d0d0d;
    background: rgba(245, 245, 245, 0.85);
    font-size: 0.5rem;
    font-weight: 800;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .dl-safe-area { height: max(12px, env(safe-area-inset-bottom)); flex: 0 0 auto; }

  /* Desktop: center the sheet instead of bottom-anchoring, but keep the
     70vh height contract. */
  @media (min-width: 900px) {
    .dl-layer { align-items: center; padding: 20px; }
    .dl-sheet {
      border-bottom: 1px solid rgba(255, 255, 255, 0.14);
      border-radius: var(--radius-xl, 26px);
    }
  }
  @media (max-width: 640px) {
    .dl-header { padding: 10px 14px; gap: 10px; }
    .dl-header h2 { font-size: 0.92rem; }
    .dl-dropdown-trigger { padding: 7px 10px; font-size: 0.68rem; max-width: 150px; }
    .dl-fallback-bar { padding: 8px 14px; font-size: 0.62rem; flex-wrap: wrap; }
  }
  @media (prefers-reduced-motion: reduce) {
    .dl-sheet, .dl-backdrop, .dl-dropdown-menu { animation: none; transition: none; }
    .dl-spin { animation: none; }
  }

  @keyframes dl-sheet-in { from { opacity: 0; transform: translateY(20px); } to { opacity: 1; transform: translateY(0); } }
  @keyframes dl-fade { from { opacity: 0; } to { opacity: 1; } }
  @keyframes dl-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
</style>
