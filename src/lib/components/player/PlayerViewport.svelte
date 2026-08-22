<script lang="ts">
  import { createEventDispatcher, onMount, tick } from 'svelte';
  import type { PlayerAudioTrack, PlayerPlaybackState, PlayerProtocol, PlayerSource } from '$lib/shared/player';
  import { iframeSandboxAttribute } from '$lib/shared/sandbox-policy';

  export let source: PlayerSource | null = null;
  export let mediaUrl: string | null = null;
  export let poster = '';
  export let title = 'MAVERO playback';
  export let sandboxEnabled = true;
  export let state: PlayerPlaybackState = 'initial-loading';
  export let videoElement: HTMLVideoElement | undefined;

  $: sandboxAttribute = sandboxEnabled ? iframeSandboxAttribute('required') : undefined;
  $: iframeKey = `${source?.sourceId ?? 'empty'}:${source?.url ?? ''}:${sandboxEnabled ? 'sandbox-on' : 'sandbox-off'}`;
  $: directKey = source?.type === 'direct' && mediaUrl ? `${source.sourceId}:${mediaUrl}:${source.metadata?.protocol ?? ''}` : '';

  type HlsRuntime = {
    loadSource: (url: string) => void;
    attachMedia: (element: HTMLMediaElement) => void;
    destroy: () => void;
    on?: (event: string, listener: (...args: unknown[]) => void) => void;
    audioTracks?: Array<{ id?: number; lang?: string; name?: string; default?: boolean }>;
    audioTrack?: number;
  };
  type DashRuntime = {
    initialize: (element: HTMLMediaElement, url: string, autoPlay: boolean) => void;
    reset: () => void;
    on?: (event: string, listener: (...args: unknown[]) => void) => void;
    getTracksFor?: (type: string) => Array<{ id?: string | number; lang?: string; labels?: Array<{ text?: string }> }>;
    setCurrentTrack?: (track: unknown) => void;
  };

  let hlsInstance: HlsRuntime | null = null;
  let dashInstance: DashRuntime | null = null;
  let mounted = false;
  let loadedDirectKey = '';
  let loadToken = 0;

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
    audiotracks: PlayerAudioTrack[];
  }>();

  onMount(() => {
    mounted = true;
    void syncDirectPlayback();
    return () => {
      mounted = false;
      loadedDirectKey = '';
      loadToken += 1;
      destroyPlaybackEngines();
    };
  });

  $: if (mounted && directKey && directKey !== loadedDirectKey) {
    loadedDirectKey = directKey;
    void syncDirectPlayback();
  }

  $: if (mounted && !directKey && loadedDirectKey) {
    loadedDirectKey = '';
    loadToken += 1;
    destroyPlaybackEngines();
  }

  function destroyPlaybackEngines() {
    try { hlsInstance?.destroy(); } catch { /* cleanup is best effort */ }
    try { dashInstance?.reset(); } catch { /* cleanup is best effort */ }
    hlsInstance = null;
    dashInstance = null;
  }

  function protocolForSource(): PlayerProtocol {
    return source?.metadata?.protocol ?? 'unknown';
  }

  function emitAudioTracks(tracks: PlayerAudioTrack[]) {
    if (tracks.length) dispatch('audiotracks', tracks);
  }

  async function syncDirectPlayback() {
    if (!mounted || source?.type !== 'direct' || !mediaUrl) return;
    await tick();
    const element = videoElement;
    if (!element) return;
    const token = ++loadToken;
    const url = mediaUrl;
    const protocol = protocolForSource();
    destroyPlaybackEngines();
    element.removeAttribute('src');
    element.load();

    if (protocol === 'hls') {
      if (element.canPlayType('application/vnd.apple.mpegurl')) {
        element.src = url;
        element.load();
        return;
      }
      try {
        const module = await import('hls.js');
        if (token !== loadToken || !mounted || !videoElement) return;
        if (module.default.isSupported()) {
          const instance = new module.default({ enableWorker: true }) as unknown as HlsRuntime;
          const emitHlsTracks = () => {
            const tracks = (instance.audioTracks ?? []).map((track, index) => ({ id: String(track.id ?? index), language: track.lang, label: track.name, default: track.default }));
            emitAudioTracks(tracks);
          };
          instance.on?.('hlsError', (...args) => { if ((args[1] as { fatal?: boolean } | undefined)?.fatal) dispatch('error'); });
          instance.on?.('hlsManifestParsed', emitHlsTracks);
          instance.loadSource(url);
          instance.attachMedia(videoElement);
          hlsInstance = instance;
          return;
        }
      } catch {
        // Fall through to the browser's native error path.
      }
    }

    if (protocol === 'dash') {
      try {
        const module = await import('dashjs');
        if (token !== loadToken || !mounted || !videoElement) return;
        const instance = module.MediaPlayer().create() as DashRuntime;
        instance.on?.('error', () => dispatch('error'));
        instance.initialize(videoElement, url, false);
        dashInstance = instance;
        const tracks = (instance.getTracksFor?.('audio') ?? []).map((track, index) => ({ id: String(track.id ?? index), language: track.lang, label: track.labels?.[0]?.text ?? track.lang }));
        emitAudioTracks(tracks);
        return;
      } catch {
        // Fall through to the browser's native error path.
      }
    }

    element.src = url;
    element.load();
  }

  export function selectAudioTrack(trackId: string) {
    if (hlsInstance?.audioTracks) {
      const index = hlsInstance.audioTracks.findIndex((track, position) => String(track.id ?? position) === trackId);
      if (index >= 0) hlsInstance.audioTrack = index;
      return;
    }
    if (dashInstance?.getTracksFor && dashInstance.setCurrentTrack) {
      const track = dashInstance.getTracksFor('audio').find((candidate, index) => String(candidate.id ?? index) === trackId);
      if (track) dashInstance.setCurrentTrack(track);
    }
  }

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
    {#key iframeKey}
      <iframe
        src={source.url}
        title={`${title} provider embed`}
        loading="eager"
        allow="autoplay; fullscreen; picture-in-picture"
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
  .viewport { position: relative; display: grid; min-height: clamp(220px, 56vw, 690px); overflow: hidden; background: #060607; isolation: isolate; }
  .viewport video, .viewport iframe { position: relative; z-index: 1; width: 100%; height: 100%; min-height: inherit; border: 0; object-fit: contain; background: #060607; }
  .viewport iframe { display: block; }
  .viewport.embed { min-height: 0; }
  .viewport.embed iframe { aspect-ratio: 16 / 9; }
  .viewport-shade { position: absolute; z-index: 2; inset: auto 0 0; height: 38%; pointer-events: none; background: linear-gradient(0deg, rgba(4,4,6,.72), transparent); }
  .state-label { position: absolute; z-index: 3; top: 18px; left: 18px; color: rgba(248,247,242,.68); font-family: 'DM Mono', monospace; font-size: .58rem; letter-spacing: .08em; text-transform: uppercase; text-shadow: 0 1px 12px #000; }
  .empty-viewport { position: absolute; inset: 0; display: grid; place-items: center; background: radial-gradient(circle at 50% 43%, rgba(155,135,245,.18), transparent 26%), linear-gradient(145deg, #0d0d13, #060607 70%); }
  .empty-orb { width: 72px; height: 72px; border: 1px solid rgba(194,181,255,.42); border-radius: 50%; box-shadow: 0 0 0 18px rgba(155,135,245,.05), 0 0 80px rgba(155,135,245,.23); }
  @media (max-width: 640px) { .viewport { min-height: 56.25vw; max-height: 76dvh; } .state-label { top: 12px; left: 12px; font-size: .51rem; } }
  @media (prefers-reduced-motion: reduce) { .empty-orb { box-shadow: 0 0 0 18px rgba(155,135,245,.05); } }
</style>
