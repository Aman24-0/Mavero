<script lang="ts">
  // Player V2 corrections (real-device feedback): the approved wireframe
  // layout. The control surface is a THREE-ZONE overlay on the player shell:
  //   * TOP-RIGHT utility zone  — Lock, PiP, Cast (never the center cluster
  //     or the bottom bar; Cast renders only when the shell's eligibility
  //     gates passed; PiP only when the browser supports it).
  //   * CENTER cluster          — [−10 s] [Play/Pause] [+10 s] centered on the
  //     VIDEO VIEWPORT (absolute center of the shell), Play/Pause dominant.
  //     Seek icons are the recognizable RotateCcwSquare/RotateCwSquare pair
  //     with the 10-second count overlaid (replaces the ambiguous chevrons).
  //   * BOTTOM zone             — time + duration, the seek bar, and the
  //     secondary row: volume, subtitles (ALWAYS rendered — Off / empty /
  //     error states included), quality (engine levels or stream variants),
  //     display mode (Fit/Fill/Stretch), speed (single label — no "1× 1×"),
  //     fullscreen/landscape. flex-wrap gives compact portrait a second row
  //     instead of overlap; the quality control is NEVER hidden on phones.
  // Back stays the shell's top-left FAB for EVERY provider (the Part 1
  // Blue Velvet in-row exception is retired by the approved layout — one
  // Back, one place, for all sources).
  import { Captions, Cast, Expand, Lock, LockOpen, Maximize2, Minimize2, Pause, PictureInPicture2, Play, RotateCcwSquare, RotateCwSquare, Settings2, Volume1, Volume2, VolumeX } from 'lucide-svelte';
  import type { PlayerInternalQualityOption, PlayerQualityOption, PlayerSubtitleTrack } from '$lib/shared/player';
  import { formatPlayerTime, playbackSpeeds, PLAYER_AUTO_QUALITY_ID } from '$lib/shared/player';

  export let playing = false;
  export let muted = false;
  export let volume = 1;
  export let currentTime = 0;
  export let duration = 0;
  export let buffered = 0;
  export let playbackRate = 1;
  export let fullscreenActive = false;
  export let onFullscreen: () => void = () => {};
  // Touch lock: when locked the shell hides this control surface entirely and
  // renders the persistent unlock FAB (top-right) itself — the lock control
  // here is the UNLOCKED-state entry point.
  export let locked = false;
  export let onToggleLock: () => void = () => {};
  export let pictureInPictureSupported = false;
  export let pictureInPicture = false;
  export let subtitles: PlayerSubtitleTrack[] = [];
  export let selectedSubtitle = '';
  // Player V2 corrections: the subtitle menu ALWAYS renders. When the lookup
  // produced no usable tracks, `subtitleNotice` carries the honest state text
  // ('No subtitles available' / 'Subtitles unavailable' / 'Checking
  // subtitles…') shown as a disabled menu entry next to Off.
  export let subtitleNotice = '';
  export let qualities: PlayerQualityOption[] = [];
  export let selectedQuality = '';
  // Engine-driven HLS quality options (AUTO + real manifest levels) REPLACE
  // the per-stream quality select when present — exactly ONE quality menu.
  export let internalQualities: PlayerInternalQualityOption[] = [];
  export let selectedInternalQuality: string = PLAYER_AUTO_QUALITY_ID;
  // Display mode (Fit/Fill/Stretch) — CSS object-fit on the video element.
  export let displayMode: 'fit' | 'fill' | 'stretch' = 'fit';
  export let onTogglePlay: () => void = () => {};
  export let onSeek: (time: number) => void = () => {};
  export let onVolume: (value: number) => void = () => {};
  export let onToggleMute: () => void = () => {};
  export let onPlaybackRate: (value: number) => void = () => {};
  export let onSubtitle: (value: string) => void = () => {};
  export let onQuality: (value: string) => void = () => {};
  export let onInternalQuality: (id: string) => void = () => {};
  export let onDisplayMode: (mode: 'fit' | 'fill' | 'stretch') => void = () => {};
  export let onPictureInPicture: () => void = () => {};
  export let onStep: (delta: number) => void = () => {};
  // Cast: the button renders ONLY when `castAvailable` is true — the shell
  // sets this only when the ACTIVE source passed every eligibility gate
  // (direct, no header binding, known receiver-compatible format, unexpired
  // URL), the CORS probe verified the media URL is receiver-accessible, and
  // the CAF SDK reported availability. While `castActive` the LOCAL-only
  // controls (volume, subtitles, quality, display mode, speed, PiP) hide —
  // the platform cast dialog owns receiver volume/tracks; play/pause, the
  // timeline, ±10 s and the lock keep working (routed to the receiver by the
  // shell).
  export let castAvailable = false;
  export let castActive = false;
  export let onCast: () => void = () => {};

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

  function handleDisplayMode(event: Event) {
    const select = event.currentTarget as HTMLSelectElement;
    const value = select.value;
    if (value === 'fit' || value === 'fill' || value === 'stretch') onDisplayMode(value);
  }

  function qualityLabel(option: PlayerQualityOption) {
    return option.label ?? (option.height ? `${option.height}p` : 'Source');
  }
</script>

<div class="controls" class:casting={castActive} aria-label="Playback controls">
  <!-- TOP-RIGHT utility zone: Lock, PiP, Cast (approved layout). -->
  <div class="utility-zone">
    {#if castAvailable}
      <!-- aria-pressed mirrors the session; the label names both actions. -->
      <button class="control-button cast-button" class:casting={castActive} type="button" aria-label={castActive ? 'Disconnect cast session' : 'Cast to a device'} aria-pressed={castActive} onclick={onCast}><Cast size={17} /></button>
    {/if}
    {#if !castActive && pictureInPictureSupported}
      <button class="control-button" type="button" aria-label={pictureInPicture ? 'Exit Picture-in-Picture' : 'Enter Picture-in-Picture'} aria-pressed={pictureInPicture} onclick={onPictureInPicture}><PictureInPicture2 size={17} /></button>
    {/if}
    <button class="control-button lock-button" type="button" aria-label={locked ? 'Unlock player controls' : 'Lock player controls'} aria-pressed={locked} onclick={onToggleLock}>{#if locked}<LockOpen size={17} />{:else}<Lock size={17} />{/if}</button>
  </div>

  <!-- CENTER playback cluster — centered on the VIDEO VIEWPORT (absolute
       center of the player shell), Play/Pause visually dominant, ±10 s
       immediately beside it with separate hit areas. -->
  <div class="center-cluster">
    <button class="cluster-button seek" type="button" aria-label="Seek backward 10 seconds" onclick={() => onStep(-10)}>
      <RotateCcwSquare size={30} aria-hidden="true" />
      <span class="seek-count" aria-hidden="true">10</span>
    </button>
    <button class="cluster-button play" type="button" aria-label={playing ? 'Pause' : 'Play'} onclick={onTogglePlay}>
      {#if playing}<Pause size={30} fill="currentColor" aria-hidden="true" />{:else}<Play size={30} fill="currentColor" aria-hidden="true" />{/if}
    </button>
    <button class="cluster-button seek" type="button" aria-label="Seek forward 10 seconds" onclick={() => onStep(10)}>
      <RotateCwSquare size={30} aria-hidden="true" />
      <span class="seek-count" aria-hidden="true">10</span>
    </button>
  </div>

  <!-- BOTTOM zone: time + timeline, then the secondary control row. -->
  <div class="bottom-zone">
    <div class="timeline-row">
      <span class="time-label" aria-live="off">{formatPlayerTime(currentTime)}</span>
      <div class="timeline-wrap">
        <div class="timeline-track" aria-hidden="true">
          <span class="timeline-buffered" style={`width: ${bufferedPercent}%`}></span>
          <span class="timeline-progress" style={`width: ${progressPercent}%`}></span>
        </div>
        <input class="timeline-input" type="range" min="0" max={safeDuration} step="0.1" value={currentTime} oninput={handleSeek} aria-label="Seek playback" />
      </div>
      <span class="time-label" aria-live="off">{formatPlayerTime(safeDuration)}</span>
    </div>

    <div class="secondary-row">
      {#if !castActive}
        <div class="volume-control">
          <button class="control-button" type="button" aria-label={muted ? 'Unmute' : 'Mute'} onclick={onToggleMute}>
            {#if volumeIcon === 'muted'}<VolumeX size={17} />{:else if volumeIcon === 'low'}<Volume1 size={17} />{:else}<Volume2 size={17} />{/if}
          </button>
          <input class="volume-input" type="range" min="0" max="1" step="0.05" value={muted ? 0 : volume} oninput={handleVolume} aria-label="Volume" />
        </div>
        <!-- Subtitles: ALWAYS rendered (approved corrections spec — the user
             must be able to see that no tracks exist; a missing menu must
             never be mistaken for a working feature). -->
        <label class="select-control" aria-label="Subtitles">
          <Captions size={16} aria-hidden="true" />
          <select value={selectedSubtitle} onchange={(event) => onSubtitle((event.currentTarget as HTMLSelectElement).value)}>
            <option value="">Off</option>
            {#each subtitles as track, index}<option value={track.url}>{track.label ?? track.language ?? `Track ${index + 1}`}</option>{/each}
            {#if !subtitles.length && subtitleNotice}<option value="" disabled>{subtitleNotice}</option>{/if}
          </select>
        </label>
        {#if internalQualities.length > 1}
          <!-- Engine-driven HLS quality: AUTO + the manifest's REAL levels. -->
          <label class="select-control quality" aria-label="Playback quality"><Settings2 size={15} aria-hidden="true" /><select value={selectedInternalQuality} onchange={(event) => onInternalQuality((event.currentTarget as HTMLSelectElement).value)}><option value={PLAYER_AUTO_QUALITY_ID}>Auto</option>{#each internalQualities as option}<option value={option.id}>{option.label}</option>{/each}</select></label>
        {:else if qualities.length > 1}
          <label class="select-control quality" aria-label="Quality"><Settings2 size={15} aria-hidden="true" /><select value={selectedQuality} onchange={(event) => onQuality((event.currentTarget as HTMLSelectElement).value)}><option value="">Auto</option>{#each qualities as quality}<option value={quality.url}>{qualityLabel(quality)}</option>{/each}</select></label>
        {/if}
        <!-- Display mode: Fit preserves aspect with letterboxing, Fill
             preserves aspect and crops, Stretch fills both axes. CSS-only —
             switching never restarts the stream or moves the playhead. -->
        <label class="select-control display-mode" aria-label="Display mode"><Expand size={15} aria-hidden="true" /><select value={displayMode} onchange={handleDisplayMode}><option value="fit">Fit</option><option value="fill">Fill</option><option value="stretch">Stretch</option></select></label>
        <!-- Speed: the selected speed renders ONCE (the select itself). -->
        <label class="select-control speed" aria-label="Playback speed"><select value={playbackRate} onchange={(event) => onPlaybackRate(Number((event.currentTarget as HTMLSelectElement).value))}>{#each playbackSpeeds as speed}<option value={speed}>{speed}×</option>{/each}</select></label>
      {/if}
      <span class="secondary-spacer" aria-hidden="true"></span>
      <!-- Fullscreen/landscape: the SAME Mavero fullscreen + orientation
           controller for every provider (the floating Landscape FAB remains
           only for embed sources, which have no Mavero control surface). -->
      <button class="control-button" type="button" aria-label={fullscreenActive ? 'Exit fullscreen' : 'Enter fullscreen'} aria-pressed={fullscreenActive} onclick={onFullscreen}>{#if fullscreenActive}<Minimize2 size={17} />{:else}<Maximize2 size={17} />{/if}</button>
    </div>
  </div>
</div>

<style>
  /* The control surface is a full-shell, pointer-transparent overlay; each
     zone re-enables pointer events for its own interactive children. Taps
     that miss every control reach the video surface (gestures/reveal). */
  .controls { position: absolute; inset: 0; z-index: 10; pointer-events: none; color: var(--ink); }

  /* ---- Top-right utility zone ---- */
  .utility-zone { position: absolute; z-index: 2; top: max(12px, env(safe-area-inset-top)); right: max(12px, env(safe-area-inset-right)); display: flex; align-items: center; gap: 8px; pointer-events: auto; }

  /* ---- Center cluster ---- */
  .center-cluster { position: absolute; z-index: 1; top: 50%; left: 50%; transform: translate(-50%, -50%); display: flex; align-items: center; gap: 26px; pointer-events: auto; }
  .cluster-button { position: relative; display: grid; place-items: center; border: 1px solid rgba(255,255,255,.14); border-radius: 50%; color: #fff; background: rgba(0,0,0,.55); cursor: pointer; backdrop-filter: blur(12px); box-shadow: 0 6px 22px rgba(0,0,0,.35); transition: border-color var(--motion-fast) var(--ease-out), background var(--motion-fast) var(--ease-out), transform var(--motion-fast) var(--ease-out); }
  .cluster-button:hover, .cluster-button:focus-visible { border-color: var(--accent); background: rgba(0,0,0,.72); }
  .cluster-button:active { transform: scale(.96); }
  /* Play/Pause is the central, visually dominant control (68px vs 54px). */
  .cluster-button.play { width: 68px; height: 68px; color: #000; background: var(--accent-strong); border-color: transparent; box-shadow: 0 8px 30px rgba(0,0,0,.45); }
  .cluster-button.play:hover, .cluster-button.play:focus-visible { background: var(--accent-strong); filter: brightness(1.06); }
  .cluster-button.seek { width: 54px; height: 54px; }
  .seek-count { position: absolute; inset: 0; display: grid; place-items: center; padding-top: 5px; font-size: .56rem; font-weight: 800; letter-spacing: .02em; pointer-events: none; }

  /* ---- Bottom zone ---- */
  .bottom-zone { position: absolute; z-index: 2; bottom: 0; left: 0; right: 0; display: grid; gap: 4px; padding: 10px 14px calc(12px + env(safe-area-inset-bottom)); pointer-events: auto; background: linear-gradient(0deg, rgba(0,0,0,.62), rgba(0,0,0,.28) 62%, transparent); }
  .timeline-row { display: flex; align-items: center; gap: 10px; }
  .time-label { color: var(--ink-soft); font-family: 'Inter', ui-sans-serif, system-ui, sans-serif; font-size: .62rem; white-space: nowrap; font-variant-numeric: tabular-nums; }
  .timeline-wrap { position: relative; flex: 1; min-width: 0; height: 22px; display: grid; align-items: center; }
  .timeline-track { position: absolute; right: 0; left: 0; height: 4px; overflow: hidden; border-radius: 999px; background: rgba(255,255,255,.15); pointer-events: none; }
  .timeline-buffered, .timeline-progress { position: absolute; inset: 0 auto 0 0; border-radius: inherit; }
  .timeline-buffered { background: rgba(255,255,255,.25); }
  .timeline-progress { background: var(--accent); box-shadow: 0 0 12px rgba(255,255,255,.25); }
  .timeline-input { position: relative; z-index: 2; width: 100%; height: 22px; margin: 0; appearance: none; cursor: pointer; background: transparent; accent-color: var(--accent); }
  .timeline-input::-webkit-slider-runnable-track { height: 4px; background: transparent; }
  .timeline-input::-webkit-slider-thumb { width: 13px; height: 13px; margin-top: -4px; appearance: none; border: 2px solid var(--ink); border-radius: 50%; background: var(--accent); box-shadow: 0 2px 10px rgba(0,0,0,.4); }
  .timeline-input::-moz-range-track { height: 4px; background: transparent; }
  .timeline-input::-moz-range-thumb { width: 11px; height: 11px; border: 2px solid var(--ink); border-radius: 50%; background: var(--accent); }

  /* Secondary row: flex-wrap gives narrow portrait a second compact row
     instead of overlap; the fullscreen button keeps its place at the end. */
  .secondary-row { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; }
  .secondary-spacer { flex: 1 1 0; min-width: 0; }
  .control-button { display: inline-grid; place-items: center; min-width: 40px; min-height: 40px; border: 1px solid transparent; border-radius: var(--radius-sm); color: var(--ink-soft); background: rgba(0,0,0,.5); cursor: pointer; transition: border-color var(--motion-fast) var(--ease-out), background var(--motion-fast) var(--ease-out), transform var(--motion-fast) var(--ease-out); }
  .control-button:hover, .control-button:focus-visible { border-color: var(--line-strong); background: var(--accent-soft); }
  .control-button:active { transform: scale(.97); }
  .volume-control { display: flex; align-items: center; gap: 4px; }
  .volume-input { width: 78px; accent-color: var(--accent); }
  .select-control { display: inline-flex; align-items: center; gap: 4px; min-height: 40px; padding: 0 7px; border: 1px solid transparent; border-radius: var(--radius-sm); color: var(--ink-soft); background: rgba(0,0,0,.5); font-size: .62rem; }
  .select-control:hover, .select-control:focus-within { border-color: var(--line-strong); }
  .select-control select { max-width: 110px; border: 0; outline: 0; color: inherit; background: transparent; font: inherit; cursor: pointer; }
  .select-control option { color: #181822; background: #f5f6fa; }
  .select-control.speed select { width: 44px; }
  .select-control.display-mode select { width: 58px; }
  /* Player V2 corrections: connected Cast state tinted with the accent. */
  .cast-button.casting { color: var(--accent); border-color: var(--line-strong); }

  /* Compact viewports: the volume slider folds away (the mute button and the
     right-zone volume swipe remain); every OTHER control — subtitles, quality,
     display mode, speed, fullscreen — stays reachable (the reported
     "no quality selector on phones" regression). */
  @media (max-width: 840px) {
    .volume-input { display: none; }
    .select-control select { max-width: 88px; }
  }
  @media (max-width: 640px) {
    .bottom-zone { padding: 8px 10px calc(10px + env(safe-area-inset-bottom)); }
    .secondary-row { gap: 4px; }
    .time-label { font-size: .56rem; }
    .select-control { padding: 0 4px; }
    .center-cluster { gap: 20px; }
    .cluster-button.play { width: 62px; height: 62px; }
    .cluster-button.seek { width: 50px; height: 50px; }
  }
  /* Landscape phone: keep the cluster clear of the bottom zone. */
  @media (orientation: landscape) and (max-height: 500px) {
    .center-cluster { transform: translate(-50%, calc(-50% - 16px)); }
    .bottom-zone { padding: 6px 12px calc(8px + env(safe-area-inset-bottom)); }
  }
  @media (prefers-reduced-motion: reduce) { .control-button, .cluster-button { transition: none; } }
</style>
