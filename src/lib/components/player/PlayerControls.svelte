<script lang="ts">
  import { Captions, ChevronLeft, ChevronRight, Maximize, Minimize, Pause, PictureInPicture2, Play, Settings2, Volume1, Volume2, VolumeX } from 'lucide-svelte';
  import type { PlayerQualityOption, PlayerSubtitleTrack } from '$lib/shared/player';
  import { formatPlayerTime, playbackSpeeds } from '$lib/shared/player';

  export let playing = false;
  export let muted = false;
  export let volume = 1;
  export let currentTime = 0;
  export let duration = 0;
  export let buffered = 0;
  export let playbackRate = 1;
  export let fullscreen = false;
  export let pictureInPicture = false;
  export let subtitles: PlayerSubtitleTrack[] = [];
  export let selectedSubtitle = '';
  export let qualities: PlayerQualityOption[] = [];
  export let selectedQuality = '';
  export let sourceCount = 0;
  export let onTogglePlay: () => void = () => {};
  export let onSeek: (time: number) => void = () => {};
  export let onVolume: (value: number) => void = () => {};
  export let onToggleMute: () => void = () => {};
  export let onPlaybackRate: (value: number) => void = () => {};
  export let onSubtitle: (value: string) => void = () => {};
  export let onQuality: (value: string) => void = () => {};
  export let onFullscreen: () => void = () => {};
  export let onPictureInPicture: () => void = () => {};
  export let onStep: (delta: number) => void = () => {};
  export let onSources: () => void = () => {};

  $: safeDuration = Number.isFinite(duration) && duration > 0 ? duration : 0;
  $: progressPercent = safeDuration ? Math.min(100, Math.max(0, (currentTime / safeDuration) * 100)) : 0;
  $: bufferedPercent = safeDuration ? Math.min(100, Math.max(0, (buffered / safeDuration) * 100)) : 0;
  $: volumeIcon = muted || volume === 0 ? 'muted' : volume < 0.5 ? 'low' : 'high';

  function handleSeek(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    onSeek(Number(input.value));
  }

  function handleVolume(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    onVolume(Number(input.value));
  }

  function qualityLabel(option: PlayerQualityOption) {
    return option.label ?? (option.height ? `${option.height}p` : 'Source');
  }
</script>

<div class="controls" aria-label="Playback controls">
  <div class="timeline-wrap">
    <div class="timeline-track" aria-hidden="true">
      <span class="timeline-buffered" style={`width: ${bufferedPercent}%`}></span>
      <span class="timeline-progress" style={`width: ${progressPercent}%`}></span>
    </div>
    <input class="timeline-input" type="range" min="0" max={safeDuration} step="0.1" value={currentTime} oninput={handleSeek} aria-label="Seek playback" />
  </div>

  <div class="control-row">
    <div class="control-group left">
      <button class="control-button primary" type="button" aria-label={playing ? 'Pause' : 'Play'} onclick={onTogglePlay}>{#if playing}<Pause size={17} fill="currentColor" />{:else}<Play size={17} fill="currentColor" />{/if}</button>
      <button class="control-button skip" type="button" aria-label="Seek backward 10 seconds" onclick={() => onStep(-10)}><ChevronLeft size={16} /><span>10</span></button>
      <button class="control-button skip" type="button" aria-label="Seek forward 10 seconds" onclick={() => onStep(10)}><ChevronRight size={16} /><span>10</span></button>
      <span class="time-label" aria-live="off">{formatPlayerTime(currentTime)} <i>/</i> {formatPlayerTime(safeDuration)}</span>
    </div>

    <div class="control-group right">
      <div class="volume-control">
        <button class="control-button" type="button" aria-label={muted ? 'Unmute' : 'Mute'} onclick={onToggleMute}>
          {#if volumeIcon === 'muted'}<VolumeX size={17} />{:else if volumeIcon === 'low'}<Volume1 size={17} />{:else}<Volume2 size={17} />{/if}
        </button>
        <input class="volume-input" type="range" min="0" max="1" step="0.05" value={muted ? 0 : volume} oninput={handleVolume} aria-label="Volume" />
      </div>
      {#if sourceCount > 0}<button class="control-button source-button" type="button" aria-label={`Choose source, ${sourceCount} available`} onclick={onSources}><span>{sourceCount}</span><span class="source-dot"></span></button>{/if}
      {#if subtitles.length}<label class="select-control" aria-label="Subtitles"><Captions size={16} /><select value={selectedSubtitle} onchange={(event) => onSubtitle((event.currentTarget as HTMLSelectElement).value)}><option value="">Subtitles off</option>{#each subtitles as track, index}<option value={track.url}>{track.label ?? track.language ?? `Track ${index + 1}`}</option>{/each}</select></label>{/if}
      {#if qualities.length > 1}<label class="select-control quality" aria-label="Quality"><Settings2 size={15} /><select value={selectedQuality} onchange={(event) => onQuality((event.currentTarget as HTMLSelectElement).value)}><option value="">Auto</option>{#each qualities as quality}<option value={quality.url}>{qualityLabel(quality)}</option>{/each}</select></label>{/if}
      <label class="select-control speed" aria-label="Playback speed"><span>{playbackRate}×</span><select value={playbackRate} onchange={(event) => onPlaybackRate(Number((event.currentTarget as HTMLSelectElement).value))}>{#each playbackSpeeds as speed}<option value={speed}>{speed}×</option>{/each}</select></label>
      {#if pictureInPicture}<button class="control-button optional" type="button" aria-label="Picture-in-Picture" onclick={onPictureInPicture}><PictureInPicture2 size={16} /></button>{/if}
      <button class="control-button" type="button" aria-label={fullscreen ? 'Exit fullscreen' : 'Enter fullscreen'} onclick={onFullscreen}>{#if fullscreen}<Minimize size={17} />{:else}<Maximize size={17} />{/if}</button>
    </div>
  </div>
</div>

<style>
  .controls { position: relative; z-index: 4; width: min(100% - 28px, 1380px); margin: -72px auto 0; padding: 0 0 18px; color: var(--ink); }
  .timeline-wrap { position: relative; height: 22px; display: grid; align-items: center; }
  .timeline-track { position: absolute; right: 0; left: 0; height: 4px; overflow: hidden; border-radius: 999px; background: rgba(255,255,255,.23); pointer-events: none; }
  .timeline-buffered, .timeline-progress { position: absolute; inset: 0 auto 0 0; border-radius: inherit; }
  .timeline-buffered { background: rgba(255,255,255,.34); }
  .timeline-progress { background: var(--accent); box-shadow: 0 0 15px rgba(155,135,245,.65); }
  .timeline-input { position: relative; z-index: 2; width: 100%; height: 22px; margin: 0; appearance: none; cursor: pointer; background: transparent; accent-color: var(--accent); }
  .timeline-input::-webkit-slider-runnable-track { height: 4px; background: transparent; }
  .timeline-input::-webkit-slider-thumb { width: 13px; height: 13px; margin-top: -4px; appearance: none; border: 2px solid #fff; border-radius: 50%; background: var(--accent); box-shadow: 0 2px 10px rgba(0,0,0,.4); }
  .timeline-input::-moz-range-track { height: 4px; background: transparent; }
  .timeline-input::-moz-range-thumb { width: 11px; height: 11px; border: 2px solid #fff; border-radius: 50%; background: var(--accent); }
  .control-row { display: flex; align-items: center; justify-content: space-between; gap: 18px; }
  .control-group { display: flex; align-items: center; gap: 5px; min-width: 0; }
  .control-button { display: inline-grid; place-items: center; min-width: 38px; min-height: 38px; border: 1px solid transparent; border-radius: 10px; color: rgba(255,255,255,.84); background: rgba(7,7,10,.68); cursor: pointer; transition: border-color 160ms ease-out, background 160ms ease-out, transform 160ms ease-out; }
  .control-button:hover, .control-button:focus-visible { border-color: rgba(194,181,255,.55); background: rgba(33,27,52,.86); }
  .control-button:active { transform: scale(.97); }
  .control-button.primary { color: #fff; background: var(--accent-gradient); box-shadow: 0 6px 18px rgba(255, 56, 96, .35); }
  .control-button.skip { position: relative; min-width: 36px; }
  .control-button.skip span { position: absolute; font-size: .47rem; font-weight: 800; }
  .control-button.skip:first-of-type span { margin-left: 1px; }
  .control-button.skip:nth-of-type(3) span { margin-left: -1px; }
  .time-label { padding: 0 7px; color: rgba(255,255,255,.75); font-family: 'Inter', ui-sans-serif, system-ui, sans-serif; font-size: .62rem; white-space: nowrap; }
  .time-label i { color: rgba(255,255,255,.36); font-style: normal; }
  .volume-control { display: flex; align-items: center; gap: 4px; }
  .volume-input { width: 78px; accent-color: var(--accent); }
  .source-button { gap: 3px; min-width: 38px; font-family: 'Inter', ui-sans-serif, system-ui, sans-serif; font-size: .6rem; }
  .source-dot { width: 5px; height: 5px; border-radius: 50%; background: var(--accent); box-shadow: 0 0 8px var(--accent); }
  .select-control { display: inline-flex; align-items: center; gap: 4px; min-height: 38px; padding: 0 7px; border: 1px solid transparent; border-radius: 10px; color: rgba(255,255,255,.78); background: rgba(7,7,10,.68); font-size: .62rem; }
  .select-control:hover, .select-control:focus-within { border-color: rgba(194,181,255,.55); }
  .select-control select { max-width: 90px; border: 0; outline: 0; color: inherit; background: transparent; font: inherit; cursor: pointer; }
  .select-control option { color: #181822; background: #f5f6fa; }
  .select-control.speed select { width: 37px; }
  .select-control.speed { padding-left: 9px; }
  @media (max-width: 840px) { .volume-input, .quality { display: none; } .control-row { gap: 8px; } .right { gap: 2px; } }
  @media (max-width: 640px) { .controls { width: calc(100% - 24px); margin-top: -65px; padding-bottom: 11px; } .control-row { gap: 6px; } .control-button { min-width: 40px; min-height: 40px; } .skip { display: none !important; } .time-label { padding: 0 3px; font-size: .56rem; } .select-control.speed { min-width: 40px; padding: 0 4px; } .source-button { min-width: 36px; } }
  @media (prefers-reduced-motion: reduce) { .control-button { transition: none; } }
</style>
