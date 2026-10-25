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
  import { channelInitials } from '$lib/client/live-tv/epg';
  import type { LiveTvChannel } from '$lib/client/live-tv/types';

  let {
    channel,
    selected = false,
    disabled = false,
    onselect
  }: {
    channel: LiveTvChannel;
    selected?: boolean;
    disabled?: boolean;
    onselect: (channel: LiveTvChannel) => void;
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

<button
  type="button"
  class="ltv-channel-card"
  class:selected
  class:disabled
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
  </span>
</button>

<style>
  .ltv-channel-card {
    display: flex;
    align-items: center;
    gap: 12px;
    min-width: 0;
    min-height: 64px;
    padding: 10px 14px 10px 10px;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    background: var(--color-surface);
    text-align: left;
    cursor: pointer;
    transition: border-color var(--motion-fast) var(--ease-out), background var(--motion-fast) var(--ease-out), transform var(--motion-fast) var(--ease-out), box-shadow var(--motion-fast) var(--ease-out);
  }
  .ltv-channel-card:hover {
    border-color: var(--color-border-strong);
    background: var(--color-surface-elevated);
    transform: translateY(-1px);
  }
  .ltv-channel-card:focus-visible { outline: 2px solid var(--color-focus); outline-offset: 2px; }

  .ltv-channel-card.selected {
    border-color: var(--color-primary-border);
    background: var(--color-primary-soft);
    box-shadow: var(--glow-primary);
  }
  .ltv-channel-card.selected .card-name { color: var(--color-primary); }

  .ltv-channel-card.disabled { opacity: .55; cursor: default; }
  .ltv-channel-card.disabled:hover { transform: none; background: var(--color-surface); border-color: var(--color-border); }

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
</style>
