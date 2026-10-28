<script lang="ts">
  // 2026-10 round 5 — Task 5: Floating Live TV mini-player.
  //
  // Rendered by the root layout when a Live TV session is active AND the
  // user is NOT on /live-tv. The mini-player is a fixed-position floating
  // box (bottom-right) containing the channel's video element + two
  // overlay buttons: Close (stops playback + clears the session) and
  // Expand (navigates to /live-tv to re-adopt the session).
  //
  // The video element is MOVED from the /live-tv page into this container
  // by the store (the store holds the video element reference; this
  // component renders it via a Svelte snippet/bind). The video keeps
  // playing because the element itself is never destroyed — only its
  // DOM parent changes.
  //
  // SECURITY: only catalogue metadata (channel name/category/logo) is
  // displayed — never URLs, tokens, or resolver responses.

  import { onMount, onDestroy } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { X, Maximize2 } from 'lucide-svelte';
  import { channelInitials } from '$lib/client/live-tv/epg';
  import { getLiveTvSession, clearLiveTvSession } from '$lib/client/live-tv/live-player-store.svelte';

  let session = $derived(getLiveTvSession());
  // Hide the mini-player when the user is ON /live-tv (the page itself
  // owns the player there — the mini-player is only for other routes).
  const isOnLiveTvPage = $derived(page.url.pathname === '/live-tv');
  const visible = $derived(session !== null && !isOnLiveTvPage);

  let containerEl: HTMLDivElement | undefined = $state();
  let logoFailed = $state(false);

  // Move the video element into the mini-player container when visible.
  $effect(() => {
    if (!visible || !session || !containerEl) return;
    // The video element was created by the /live-tv page. We move it
    // into this container so it keeps playing. The store holds the
    // reference; we append it to our container.
    const video = session.videoEl;
    if (video.parentElement !== containerEl) {
      // Style the video to fill the mini-player.
      video.style.position = 'absolute';
      video.style.inset = '0';
      video.style.width = '100%';
      video.style.height = '100%';
      video.style.objectFit = 'contain';
      video.style.background = '#000';
      containerEl.appendChild(video);
    }
  });

  function handleClose(): void {
    clearLiveTvSession();
  }

  function handleExpand(): void {
    // Navigate to /live-tv — the page's onMount will adopt the session.
    void goto('/live-tv');
  }

  // Attempt native PiP on mount (only works for <video> elements, not
  // iframes — if the session is an embed, this silently fails).
  onMount(() => {
    // The PiP attempt is deferred to a user gesture in most browsers
    // (browsers block programmatic PiP without a user interaction).
    // We provide a button-less fallback: the mini-player itself IS the
    // custom PiP for iframe sessions. For <video> sessions, the user
    // can trigger native PiP from the player's own controls on /live-tv.
  });

  onDestroy(() => {
    // The video element is owned by the store, not this component.
    // We do NOT destroy it here — the store's clearLiveTvSession does
    // that when the user clicks Close.
  });
</script>

{#if visible && session}
  <div class="live-mini-player" role="dialog" aria-label="Live TV mini player">
    <div class="mini-video-container" bind:this={containerEl}>
      <!-- The video element is injected here by the $effect above. -->
    </div>
    <div class="mini-info">
      <span class="mini-live-dot" aria-hidden="true"></span>
      <span class="mini-channel-name">{session.channel.name}</span>
    </div>
    <button type="button" class="mini-btn mini-close" onclick={handleClose} aria-label="Stop playback and close mini player" title="Close">
      <X size={16} />
    </button>
    <button type="button" class="mini-btn mini-expand" onclick={handleExpand} aria-label="Expand to Live TV page" title="Expand">
      <Maximize2 size={16} />
    </button>
  </div>
{/if}

<style>
  .live-mini-player {
    position: fixed;
    bottom: 80px;
    right: 16px;
    width: 320px;
    height: 180px;
    z-index: 9999;
    background: #000;
    border: 1px solid var(--color-border-strong, rgba(255, 255, 255, 0.2));
    border-radius: 12px;
    overflow: hidden;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.6);
    transition: opacity 200ms ease, transform 200ms ease;
  }

  .mini-video-container {
    position: absolute;
    inset: 0;
    overflow: hidden;
  }

  .mini-info {
    position: absolute;
    bottom: 0;
    left: 0;
    right: 0;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 10px;
    background: linear-gradient(transparent, rgba(0, 0, 0, 0.8));
    pointer-events: none;
  }

  .mini-live-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: #ff4d6d;
    box-shadow: 0 0 6px rgba(255, 77, 109, 0.8);
    animation: mini-pulse 2s ease-in-out infinite;
    flex-shrink: 0;
  }
  @keyframes mini-pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.45; }
  }

  .mini-channel-name {
    color: #fff;
    font-size: 0.72rem;
    font-weight: 700;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .mini-btn {
    position: absolute;
    top: 6px;
    display: grid;
    place-items: center;
    width: 30px;
    height: 30px;
    border: 0;
    border-radius: 6px;
    background: rgba(0, 0, 0, 0.7);
    color: #fff;
    cursor: pointer;
    transition: background 150ms ease, color 150ms ease;
    backdrop-filter: blur(4px);
  }
  .mini-btn:hover { background: rgba(0, 0, 0, 0.9); }
  .mini-btn:focus-visible { outline: 2px solid var(--color-focus, #fff); outline-offset: 1px; }

  .mini-close { right: 6px; }
  .mini-expand { right: 40px; }

  @media (max-width: 640px) {
    .live-mini-player {
      width: 240px;
      height: 135px;
      bottom: 70px;
      right: 8px;
    }
  }
</style>
