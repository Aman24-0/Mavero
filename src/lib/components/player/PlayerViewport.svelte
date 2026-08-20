<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import type { PlayerPlaybackState, PlayerSource } from '$lib/shared/player';

  export let source: PlayerSource | null = null;
  export let mediaUrl: string | null = null;
  export let poster = '';
  export let title = 'MAVERO playback';
  export let state: PlayerPlaybackState = 'initial-loading';
  export let videoElement: HTMLVideoElement | undefined;

  const dispatch = createEventDispatcher<{
    loadedmetadata: void;
    timeupdate: { currentTime: number; duration: number };
    play: void;
    pause: void;
    waiting: void;
    playing: void;
    seeking: void;
    seeked: void;
    ended: void;
    error: void;
    embedload: void;
  }>();

  export function play() {
    return videoElement?.play() ?? Promise.reject(new Error('Video playback is unavailable.'));
  }

  export function pause() {
    videoElement?.pause();
  }

  export function seek(time: number) {
    if (videoElement && Number.isFinite(time)) videoElement.currentTime = Math.max(0, time);
  }

  export function setVolume(value: number) {
    if (videoElement) videoElement.volume = Math.min(1, Math.max(0, value));
  }

  export function setMuted(value: boolean) {
    if (videoElement) videoElement.muted = value;
  }

  export function setPlaybackRate(value: number) {
    if (videoElement && Number.isFinite(value)) videoElement.playbackRate = value;
  }

  export function requestPictureInPicture() {
    if (!videoElement || !('requestPictureInPicture' in videoElement)) return Promise.reject(new Error('Picture-in-Picture is unavailable.'));
    return videoElement.requestPictureInPicture();
  }
</script>

<div class="viewport" class:embed={source?.type === 'embed'} class:direct={source?.type === 'direct'}>
  {#if source?.type === 'direct' && mediaUrl}
    <video
      bind:this={videoElement}
      src={mediaUrl}
      poster={poster || undefined}
      preload="metadata"
      playsinline
      aria-label={title}
      on:loadedmetadata={() => dispatch('loadedmetadata')}
      on:timeupdate={() => dispatch('timeupdate', { currentTime: videoElement?.currentTime ?? 0, duration: videoElement?.duration || 0 })}
      on:play={() => dispatch('play')}
      on:pause={() => dispatch('pause')}
      on:waiting={() => dispatch('waiting')}
      on:playing={() => dispatch('playing')}
      on:seeking={() => dispatch('seeking')}
      on:seeked={() => dispatch('seeked')}
      on:ended={() => dispatch('ended')}
      on:error={() => dispatch('error')}
    >
      <track kind="captions" src={source.subtitles?.[0]?.url ?? 'data:text/vtt,WEBVTT'} srclang={source.subtitles?.[0]?.language ?? 'en'} label={source.subtitles?.[0]?.label ?? source.subtitles?.[0]?.language ?? 'Captions unavailable'} />
      {#each (source.subtitles ?? []).slice(1) as subtitle, index}
        <track kind="captions" src={subtitle.url} srclang={subtitle.language ?? 'und'} label={subtitle.label ?? subtitle.language ?? `Subtitle ${index + 2}`} />
      {/each}
    </video>
  {:else if source?.type === 'embed' && source.url}
    <iframe
      src={source.url}
      title={`${title} provider embed`}
      loading="eager"
      allow="autoplay; fullscreen; picture-in-picture"
      sandbox="allow-forms allow-presentation allow-same-origin allow-scripts"
      referrerpolicy="no-referrer"
      allowfullscreen
      on:load={() => dispatch('embedload')}
    ></iframe>
  {:else}
    <div class="empty-viewport" aria-hidden="true"><span class="empty-orb"></span></div>
  {/if}

  <div class="viewport-shade" aria-hidden="true"></div>
  <div class="state-label" aria-live="polite">
    {#if state === 'buffering'}Buffering…{:else if state === 'preparing' || state === 'resolving'}Preparing playback…{:else if state === 'switching-source'}Switching source…{:else if state === 'embed-loading'}Loading embed…{/if}
  </div>
</div>

<style>
  .viewport { position: relative; display: grid; min-height: clamp(220px, 56vw, 690px); overflow: hidden; background: #060607; isolation: isolate; }
  .viewport video, .viewport iframe { position: relative; z-index: 1; width: 100%; height: 100%; min-height: inherit; border: 0; object-fit: contain; background: #060607; }
  .viewport iframe { display: block; }
  .viewport-shade { position: absolute; z-index: 2; inset: auto 0 0; height: 38%; pointer-events: none; background: linear-gradient(0deg, rgba(4,4,6,.72), transparent); }
  .state-label { position: absolute; z-index: 3; top: 18px; left: 18px; color: rgba(248,247,242,.68); font-family: 'DM Mono', monospace; font-size: .58rem; letter-spacing: .08em; text-transform: uppercase; text-shadow: 0 1px 12px #000; }
  .empty-viewport { position: absolute; inset: 0; display: grid; place-items: center; background: radial-gradient(circle at 50% 43%, rgba(155,135,245,.18), transparent 26%), linear-gradient(145deg, #0d0d13, #060607 70%); }
  .empty-orb { width: 72px; height: 72px; border: 1px solid rgba(194,181,255,.42); border-radius: 50%; box-shadow: 0 0 0 18px rgba(155,135,245,.05), 0 0 80px rgba(155,135,245,.23); }
  @media (max-width: 640px) { .viewport { min-height: 56.25vw; max-height: 76dvh; } .state-label { top: 12px; left: 12px; font-size: .51rem; } }
  @media (prefers-reduced-motion: reduce) { .empty-orb { box-shadow: 0 0 0 18px rgba(155,135,245,.05); } }
</style>
