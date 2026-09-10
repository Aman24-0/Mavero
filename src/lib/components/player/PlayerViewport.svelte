<script lang="ts">
  import { createEventDispatcher, onDestroy } from 'svelte';
  import type { PlayerPlaybackState, PlayerSource } from '$lib/shared/player';
  import { iframeSandboxAttribute } from '$lib/shared/sandbox-policy';
  import { HlsPlaybackEngine, resolveDirectPlaybackMode } from '$lib/client/player/hls-engine';

  export let source: PlayerSource | null = null;
  export let mediaUrl: string | null = null;
  export let poster = '';
  export let title = 'MAVERO playback';
  export let sandboxEnabled = true;
  export let state: PlayerPlaybackState = 'initial-loading';
  export let videoElement: HTMLVideoElement | undefined;
  export let iframeElement: HTMLIFrameElement | undefined;
  $: sandboxAttribute = sandboxEnabled ? iframeSandboxAttribute('required') : undefined;
  $: iframeKey = `${source?.sourceId ?? 'empty'}:${source?.url ?? ''}:${sandboxEnabled ? 'sandbox-on' : 'sandbox-off'}`;

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

  // ----- Phase 5: HLS playback engine wiring -----
  //
  // PlayerViewport owns the <video> element, so it also owns the ONLY hls.js
  // instance (spec §7 — the engine lifecycle stays close to the <video>
  // lifecycle). Routing decision per direct source:
  //
  //   non-HLS (MP4/WebM/file)  → 'native'  → existing <video src> path
  //                             (unchanged — hls.js is never imported)
  //   HLS + native support     → 'native'  → existing <video src> path
  //                             (Safari/iOS — video.src = hlsUrl, spec §4)
  //   HLS + no native support  → 'hls-js'  → engine drives the SAME <video>
  //                             via MediaSource; the src attribute binding
  //                             is released while the engine owns playback.
  //
  // Everything above the engine is untouched: the <video> element still
  // fires loadedmetadata/timeupdate/play/pause/… (hls.js feeds the element
  // through MediaSource), so PlayerShell's pendingSeek/position restore,
  // progress reporting, Media Session, PiP, fullscreen and Wake Lock keep
  // working unchanged. Source switching (HLS→HLS, HLS→MP4, MP4→HLS,
  // MP4→MP4) re-runs this wiring: the previous hls.js instance is destroyed
  // first, so at most ONE instance is ever attached to the video element,
  // and the shell's pendingSeek mechanism restores the captured position
  // on the next loadedmetadata. Player-level errors surface through the
  // EXISTING generic 'error' event — the UI never sees hls.js event names.

  let hlsEngine: HlsPlaybackEngine | null = null;
  let hlsEngineUrl: string | null = null;
  // When true the engine owns the media resource and the template must NOT
  // bind `src` (the binding would fight hls.js' MediaSource objectURL).
  let hlsEngineActive = false;

  function teardownHlsEngine() {
    if (hlsEngine) {
      hlsEngine.destroy();
      hlsEngine = null;
    }
    hlsEngineUrl = null;
    hlsEngineActive = false;
  }

  async function wireHlsEngine(url: string | null, currentSource: PlayerSource | null, video: HTMLVideoElement | undefined) {
    // SSR / embed / no video element → plain teardown (no hls.js ever loads).
    if (!url || !video || currentSource?.type !== 'direct') {
      teardownHlsEngine();
      return;
    }
    let mode: 'native' | 'hls-js';
    try {
      mode = resolveDirectPlaybackMode(currentSource, url, video);
    } catch {
      teardownHlsEngine();
      return;
    }
    if (mode !== 'hls-js') {
      // Native path (MP4 or native-HLS browser) — the existing src binding
      // keeps working exactly as before.
      teardownHlsEngine();
      return;
    }
    // Already wired to this exact URL (reactive re-runs must not re-attach
    // and must not create duplicate hls.js listeners).
    if (hlsEngineActive && hlsEngineUrl === url) return;
    const wasEngineActive = hlsEngineActive;
    teardownHlsEngine();
    // If a native resource fetch may already have started from the initial
    // src binding (e.g. the element was created with an .m3u8 src), reset it
    // so the stale native load cannot race the engine's MediaSource attach.
    if (!wasEngineActive) {
      try {
        video.removeAttribute('src');
        video.load();
      } catch { /* element already reset */ }
    }
    const engine = new HlsPlaybackEngine();
    hlsEngine = engine;
    hlsEngineUrl = url;
    hlsEngineActive = true;
    try {
      await engine.attach(video, url, {
        onFatalError: () => {
          // Stale engines (a newer source took over) never surface errors.
          if (hlsEngine !== engine) return;
          dispatch('error');
        },
      });
    } catch {
      if (hlsEngine === engine) {
        teardownHlsEngine();
        dispatch('error');
      }
    }
  }

  $: void wireHlsEngine(mediaUrl, source, videoElement);

  onDestroy(teardownHlsEngine);
</script>

<div class="viewport" class:embed={source?.type === 'embed'} class:direct={source?.type === 'direct'}>
  {#if source?.type === 'direct' && mediaUrl}
    <video
      bind:this={videoElement}
      src={hlsEngineActive ? undefined : mediaUrl}
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
    {#key iframeKey}
      <iframe
        bind:this={iframeElement}
        src={source.url}
        title={`${title} provider embed`}
        loading="eager"
        allow="autoplay; fullscreen; picture-in-picture; encrypted-media"
        sandbox={sandboxAttribute}
        referrerpolicy="no-referrer"
        allowfullscreen
        on:load={() => dispatch('embedload')}
      ></iframe>
    {/key}
  {:else}
    <div class="empty-viewport" aria-hidden="true"><span class="empty-orb"></span></div>
  {/if}

  {#if source?.type !== 'embed'}<div class="viewport-shade" aria-hidden="true"></div>{/if}
  <div class="state-label" aria-live="polite">
    {#if state === 'buffering'}Buffering…{:else if state === 'preparing' || state === 'resolving'}Preparing playback…{:else if state === 'switching-source'}Switching source…{:else if state === 'embed-loading'}Loading embed…{/if}
  </div>
</div>

<style>
  .viewport { position: relative; display: grid; min-height: clamp(220px, 56vw, 690px); overflow: hidden; background: var(--base); isolation: isolate; }
  .viewport video, .viewport iframe { position: relative; z-index: 1; width: 100%; height: 100%; min-height: inherit; border: 0; object-fit: contain; background: var(--base); }
  .viewport iframe { display: block; }
  .viewport.embed { min-height: 0; }
  .viewport.embed iframe { aspect-ratio: 16 / 9; }
  .viewport-shade { position: absolute; z-index: 2; inset: auto 0 0; height: 38%; pointer-events: none; background: linear-gradient(0deg, rgba(0,0,0,.72), transparent); }
  .state-label { position: absolute; z-index: 3; top: 18px; left: 18px; color: var(--muted); font-family: 'Inter', ui-sans-serif, system-ui, sans-serif; font-size: .58rem; letter-spacing: .08em; text-transform: uppercase; text-shadow: 0 1px 12px #000; }
  .empty-viewport { position: absolute; inset: 0; display: grid; place-items: center; background: radial-gradient(circle at 50% 43%, rgba(255,255,255,.06), transparent 26%), linear-gradient(145deg, var(--surface), var(--base) 70%); }
  .empty-orb { width: 72px; height: 72px; border: 1px solid var(--line-strong); border-radius: 50%; box-shadow: 0 0 0 18px rgba(255,255,255,.02), 0 0 80px rgba(255,255,255,.08); }
  @media (max-width: 640px) { .viewport { min-height: 56.25vw; max-height: 76dvh; } .state-label { top: 12px; left: 12px; font-size: .51rem; } }
  @media (prefers-reduced-motion: reduce) { .empty-orb { box-shadow: 0 0 0 18px rgba(255,255,255,.02); } }
</style>
