<script lang="ts">
  // LT-4 — Live TV channel card (presentation only).
  //
  // Renders ONLY the catalogue metadata LiveGT actually provides (LT-2
  // LiveTvChannel: name, logo?, category?) — nothing is invented. Missing
  // logos degrade to an initials surface (epg.channelInitials — derived from
  // the real name) and a failed logo load falls back the same way, so a
  // broken image never appears. The card is a semantic <button> (keyboard
  // selectable, aria-pressed for the selected channel); the logo <img> is
  // lazy + async-decoded like MediaCard's posters.
  //
  // 2026-10 round 7 — Task 7: an optional Share button on the right side.
  // The share button is a SEPARATE <button> (NOT inside the main card
  // button — nested buttons are invalid HTML). The card is now a <div>
  // with a clickable inner button + a share button sibling.
  import { Share2 } from 'lucide-svelte';
  import { channelInitials } from '$lib/client/live-tv/epg';
  import type { LiveTvChannel } from '$lib/client/live-tv/types';

  let {
    channel,
    selected = false,
    disabled = false,
    onselect,
    onshare,
    showSourceName = false
  }: {
    channel: LiveTvChannel;
    selected?: boolean;
    disabled?: boolean;
    onselect: (channel: LiveTvChannel) => void;
    onshare?: (channel: LiveTvChannel) => void;
    /** 2026-10 round 10 — Task 1: when true (All Sources mode), show the
     *  source name below the category. */
    showSourceName?: boolean;
  } = $props();

  // Logo fallback: true when there is no usable logo OR the logo fails to
  // load (onerror). Both paths render the same initials surface.
  let logoFailed = $state(false);
  $effect(() => {
    // Reset the failure flag whenever the card represents a different
    // channel (cards are keyed by id in the grid, but stay defensive).
    logoFailed = false;
  });

  const hasLogo = $derived(Boolean(channel.logo) && !logoFailed);
  const initials = $derived(channelInitials(channel.name));
</script>

<div
  class="ltv-channel-card"
  class:selected
  class:disabled
  role="group"
  aria-label={`${channel.name}${channel.category ? ` (${channel.category})` : ''}`}
>
  <button
    type="button"
    class="card-main-btn"
    aria-pressed={selected}
    aria-label={`Watch ${channel.name}${channel.category ? ` (${channel.category})` : ''}`}
    disabled={disabled}
    onclick={() => onselect(channel)}
  >
    <span class="card-logo" class:placeholder={!hasLogo} aria-hidden="true">
      {#if hasLogo}
        <img
          src={channel.logo}
          alt=""
          loading="lazy"
          decoding="async"
          referrerpolicy="no-referrer"
          onerror={() => { logoFailed = true; }}
        />
      {:else}
        <span class="initials">{initials}</span>
      {/if}
    </span>
    <span class="card-copy">
      <span class="card-name">{channel.name}</span>
      {#if channel.category}
        <span class="card-category">{channel.category}</span>
      {/if}
      {#if showSourceName && channel.sources && channel.sources.length > 0}
        <span class="card-source">{channel.sources[0].label}</span>
      {/if}
    </span>
  </button>
  {#if onshare}
    <button
      type="button"
      class="card-share-btn"
      aria-label={`Share ${channel.name}`}
      title={`Share ${channel.name}`}
      onclick={(e) => { e.stopPropagation(); onshare(channel); }}
    >
      <Share2 size={15} />
    </button>
  {/if}
</div>

<style>
  .ltv-channel-card {
    display: flex;
    align-items: center;
    gap: 0;
    min-width: 0;
    min-height: 64px;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    background: var(--color-surface);
    overflow: hidden;
    transition: border-color var(--motion-fast) var(--ease-out), background var(--motion-fast) var(--ease-out), transform var(--motion-fast) var(--ease-out), box-shadow var(--motion-fast) var(--ease-out);
  }
  .ltv-channel-card:hover {
    border-color: var(--color-border-strong);
    background: var(--color-surface-elevated);
    transform: translateY(-1px);
  }

  .ltv-channel-card.selected {
    border-color: var(--color-primary-border);
    background: var(--color-primary-soft);
    box-shadow: var(--glow-primary);
  }
  .ltv-channel-card.selected .card-name { color: var(--color-primary); }

  .ltv-channel-card.disabled { opacity: .55; }
  .ltv-channel-card.disabled:hover { transform: none; background: var(--color-surface); border-color: var(--color-border); }

  /* The main clickable area (logo + name/category) fills the card. */
  .card-main-btn {
    display: flex;
    align-items: center;
    gap: 12px;
    flex: 1 1 auto;
    min-width: 0;
    padding: 10px 12px 10px 10px;
    border: 0;
    background: transparent;
    text-align: left;
    cursor: pointer;
    transition: background var(--motion-fast) var(--ease-out);
  }
  .card-main-btn:focus-visible { outline: 2px solid var(--color-focus); outline-offset: -2px; border-radius: var(--radius-md); }
  .card-main-btn:disabled { cursor: default; }

  /* 2026-10 round 7 — Task 7: the Share button. Compact icon button on
     the right edge of the card. Separate from the main button (nested
     buttons are invalid HTML). stopPropagation on click so the card's
     main click handler never fires. */
  .card-share-btn {
    display: grid;
    place-items: center;
    flex: 0 0 auto;
    width: 40px;
    height: 100%;
    min-height: 64px;
    border: 0;
    border-left: 1px solid var(--color-border);
    background: transparent;
    color: var(--color-text-muted);
    cursor: pointer;
    transition: background var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out);
  }
  .card-share-btn:hover { background: var(--color-surface-raised); color: var(--color-text); }
  .card-share-btn:focus-visible { outline: 2px solid var(--color-focus); outline-offset: -2px; }

  .card-logo {
    display: grid;
    place-items: center;
    flex: 0 0 auto;
    width: 44px;
    height: 44px;
    overflow: hidden;
    border: 1px solid var(--color-border);
    border-radius: 10px;
    background: var(--color-surface-raised);
  }
  .card-logo img {
    width: 100%;
    height: 100%;
    display: block;
    object-fit: contain;
    padding: 3px;
    background: #fff; /* channel logos are designed for light surfaces */
  }
  .card-logo.placeholder { background: var(--color-primary-soft); border-color: var(--color-primary-border); }
  .card-logo .initials {
    color: var(--color-primary);
    font-size: .8rem;
    font-weight: 800;
    letter-spacing: .02em;
  }

  .card-copy { display: grid; gap: 2px; min-width: 0; }
  .card-name {
    overflow: hidden;
    color: var(--color-text);
    font-size: .8rem;
    font-weight: 700;
    letter-spacing: -.01em;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .card-category {
    overflow: hidden;
    color: var(--color-text-deep);
    font-size: .68rem;
    font-weight: 600;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  /* 2026-10 round 10 — Task 1: source name (shown only in All Sources mode) */
  .card-source {
    overflow: hidden;
    color: var(--color-text-dim, var(--color-text-deep));
    font-size: .62rem;
    font-weight: 500;
    text-overflow: ellipsis;
    white-space: nowrap;
    opacity: 0.7;
  }
</style>
