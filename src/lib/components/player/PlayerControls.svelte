<script lang="ts">
  import { ArrowLeft, Captions, Cast, ChevronLeft, ChevronRight, Lock, LockOpen, Maximize2, Minimize2, Pause, PictureInPicture2, Play, Settings2, Volume1, Volume2, VolumeX } from 'lucide-svelte';
  import type { PlayerInternalQualityOption, PlayerQualityOption, PlayerSubtitleTrack } from '$lib/shared/player';
  import { formatPlayerTime, playbackSpeeds, PLAYER_AUTO_QUALITY_ID } from '$lib/shared/player';

  export let playing = false;
  export let muted = false;
  export let volume = 1;
  export let currentTime = 0;
  export let duration = 0;
  export let buffered = 0;
  export let playbackRate = 1;
  // Phase 9: fullscreen prop removed — fullscreen is handled by the header
  // orientation button in PlayerShell, not duplicated in PlayerControls.
  // Player UI V2 (Part 1, Phase 1B): Blue Velvet is the ONLY provider whose
  // Back/Fullscreen controls render INSIDE this control row (showBack /
  // showFullscreen) — every other provider keeps the shell's top-left Back
  // FAB and bottom-right Landscape FAB. `fullscreenActive` mirrors the
  // browser-synced fullscreen state so the icon/label never drift.
  export let showBack = false;
  export let showFullscreen = false;
  export let fullscreenActive = false;
  export let onBack: () => void = () => {};
  export let onFullscreen: () => void = () => {};
  // Player UI V2 (Part 1, Phase 2C): the compact touch-lock control. When
  // locked the shell hides this control row entirely; the shell renders a
  // persistent unlock FAB so the player can never strand the user.
  export let locked = false;
  export let onToggleLock: () => void = () => {};
  // Phase 6: split capability flag from active state.
  //   pictureInPictureSupported — whether the PiP button renders at all.
  //   pictureInPicture — whether PiP is currently active (drives aria-label/icon).
  // Previously the parent passed the supported flag into `pictureInPicture`
  // which made the active-state label always wrong.
  export let pictureInPictureSupported = false;
  export let pictureInPicture = false;
  export let subtitles: PlayerSubtitleTrack[] = [];
  export let selectedSubtitle = '';
  export let qualities: PlayerQualityOption[] = [];
  export let selectedQuality = '';
  // Phase 6: internal quality options of the ACTIVE playback engine (e.g.
  // hls.js ABR levels). When non-empty they REPLACE the per-stream quality
  // select so exactly ONE quality menu is ever rendered (spec §30/§AQ):
  //   engine-driven HLS  → AUTO + manifest levels (internal selection)
  //   everything else    → the existing per-stream select (unchanged)
  export let internalQualities: PlayerInternalQualityOption[] = [];
  export let selectedInternalQuality: string = PLAYER_AUTO_QUALITY_ID;
  export let onTogglePlay: () => void = () => {};
  export let onSeek: (time: number) => void = () => {};
  export let onVolume: (value: number) => void = () => {};
  export let onToggleMute: () => void = () => {};
  export let onPlaybackRate: (value: number) => void = () => {};
  export let onSubtitle: (value: string) => void = () => {};
  export let onQuality: (value: string) => void = () => {};
  // Phase 6: internal quality selection — id is PLAYER_AUTO_QUALITY_ID or
  // one internal option id. Never touches the stream/quality URL state.
  export let onInternalQuality: (id: string) => void = () => {};
  export let onPictureInPicture: () => void = () => {};
  // Phase 9: onFullscreen removed — handled by PlayerShell header.
  export let onStep: (delta: number) => void = () => {};
  // Player UI V2 (Part 2, Phase 4): Cast control. The button renders ONLY
  // when `castAvailable` is true — the shell sets this only when the ACTIVE
  // source passed every eligibility gate (direct, no header binding, known
  // receiver-compatible format, unexpired URL), the CORS probe verified the
  // media URL is receiver-accessible, and the CAF SDK reported availability.
  // While `castActive` (a session is connected) the controls that only make
  // sense for LOCAL playback are hidden (volume, subtitles, quality, speed,
  // PiP — the platform cast dialog owns receiver volume/tracks); play/pause,
  // the timeline, ±10 s seek and the lock keep working (they route to the
  // receiver via the shell).
  export let castAvailable = false;
  export let castActive = false;
  export let onCast: () => void = () => {};
  // Player UI V2 (Part 1, Phase 1A): `sourceCount` / `onSources` were removed
  // together with the redundant in-row source button — the persistent
  // right-edge source chip (PlayerShell `.source-chip`) remains the single
  // source-selection entry point, and source switching is unchanged.

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

  <!-- Player UI V2 (Part 1, Phase 1A): three-group compact row. The center
       group (−10 / Play-Pause / +10) is grid-centered — it never dominates
       the video (same compact 38/40px buttons as every other control). Left:
       Back (Blue Velvet only) + time. Right: volume, subtitles, quality,
       speed (shown ONCE by the select — the duplicated label span is gone),
       PiP, Fullscreen (Blue Velvet only), touch lock. The in-row source
       button is removed; the right-edge source chip stays the opener. -->
  <div class="control-row">
    <div class="control-group left">
      {#if showBack}
        <button class="control-button" type="button" aria-label="Close player" onclick={onBack}><ArrowLeft size={16} /></button>
      {/if}
      <span class="time-label" aria-live="off">{formatPlayerTime(currentTime)} <i>/</i> {formatPlayerTime(safeDuration)}</span>
    </div>

    <div class="control-group center">
      <button class="control-button skip" type="button" aria-label="Seek backward 10 seconds" onclick={() => onStep(-10)}><ChevronLeft size={16} /><span>10</span></button>
      <button class="control-button primary" type="button" aria-label={playing ? 'Pause' : 'Play'} onclick={onTogglePlay}>{#if playing}<Pause size={17} fill="currentColor" />{:else}<Play size={17} fill="currentColor" />{/if}</button>
      <button class="control-button skip" type="button" aria-label="Seek forward 10 seconds" onclick={() => onStep(10)}><ChevronRight size={16} /><span>10</span></button>
    </div>

    <div class="control-group right">
      {#if !castActive}
      <div class="volume-control">
        <button class="control-button" type="button" aria-label={muted ? 'Unmute' : 'Mute'} onclick={onToggleMute}>
          {#if volumeIcon === 'muted'}<VolumeX size={17} />{:else if volumeIcon === 'low'}<Volume1 size={17} />{:else}<Volume2 size={17} />{/if}
        </button>
        <input class="volume-input" type="range" min="0" max="1" step="0.05" value={muted ? 0 : volume} oninput={handleVolume} aria-label="Volume" />
      </div>
      {#if subtitles.length}<label class="select-control" aria-label="Subtitles"><Captions size={16} /><select value={selectedSubtitle} onchange={(event) => onSubtitle((event.currentTarget as HTMLSelectElement).value)}><option value="">Subtitles off</option>{#each subtitles as track, index}<option value={track.url}>{track.label ?? track.language ?? `Track ${index + 1}`}</option>{/each}</select></label>{/if}
      {#if internalQualities.length > 1}
        <!-- Phase 6: internal quality of the engine-driven HLS source (AUTO + levels). -->
        <label class="select-control quality" aria-label="Playback quality"><Settings2 size={15} /><select value={selectedInternalQuality} onchange={(event) => onInternalQuality((event.currentTarget as HTMLSelectElement).value)}><option value={PLAYER_AUTO_QUALITY_ID}>Auto</option>{#each internalQualities as option}<option value={option.id}>{option.label}</option>{/each}</select></label>
      {:else if qualities.length > 1}
        <label class="select-control quality" aria-label="Quality"><Settings2 size={15} /><select value={selectedQuality} onchange={(event) => onQuality((event.currentTarget as HTMLSelectElement).value)}><option value="">Auto</option>{#each qualities as quality}<option value={quality.url}>{qualityLabel(quality)}</option>{/each}</select></label>
      {/if}
      <!-- Player UI V2 (Part 1, Phase 1A): the selected speed renders ONCE —
           the select itself (the duplicated `{playbackRate}×` label span that
           produced the reported "1× 1×" is removed). Playback-rate behavior
           (setPlaybackRate → video.playbackRate + Media Session re-sync) is
           byte-unchanged. -->
      <label class="select-control speed" aria-label="Playback speed"><select value={playbackRate} onchange={(event) => onPlaybackRate(Number((event.currentTarget as HTMLSelectElement).value))}>{#each playbackSpeeds as speed}<option value={speed}>{speed}×</option>{/each}</select></label>
      {/if}
      {#if castAvailable}
        <!-- Player UI V2 (Part 2, Phase 4): Cast — rendered only when the
             active source + browser + CORS gates all pass. aria-pressed
             mirrors the session; the label names both actions explicitly. -->
        <button class="control-button cast-button" class:casting={castActive} type="button" aria-label={castActive ? 'Disconnect cast session' : 'Cast to a device'} aria-pressed={castActive} onclick={onCast}><Cast size={16} /></button>
      {/if}
      {#if !castActive && pictureInPictureSupported}<button class="control-button optional" type="button" aria-label={pictureInPicture ? 'Exit Picture-in-Picture' : 'Enter Picture-in-Picture'} aria-pressed={pictureInPicture} onclick={onPictureInPicture}><PictureInPicture2 size={16} /></button>{/if}
      {#if showFullscreen}
        <!-- Player UI V2 (Part 1, Phase 1B): Blue Velvet-only in-row Fullscreen —
             the SAME Mavero fullscreen/orientation controller as the F-key and
             the Landscape FAB (no second fullscreen system, no duplicate when
             switching providers or entering/exiting fullscreen: the shell
             renders either the FABs or these in-row controls, never both). -->
        <button class="control-button" type="button" aria-label={fullscreenActive ? 'Exit fullscreen' : 'Enter fullscreen'} aria-pressed={fullscreenActive} onclick={onFullscreen}>{#if fullscreenActive}<Minimize2 size={16} />{:else}<Maximize2 size={16} />{/if}</button>
      {/if}
      <button class="control-button lock-button" type="button" aria-label={locked ? 'Unlock player controls' : 'Lock player controls'} aria-pressed={locked} onclick={onToggleLock}>{#if locked}<LockOpen size={16} />{:else}<Lock size={16} />{/if}</button>
    </div>
  </div>
</div>

<style>
  .controls { position: relative; z-index: 4; width: min(100% - 28px, 1380px); margin: -72px auto 0; padding: 0 0 18px; color: var(--ink); }
  .timeline-wrap { position: relative; height: 22px; display: grid; align-items: center; }
  .timeline-track { position: absolute; right: 0; left: 0; height: 4px; overflow: hidden; border-radius: 999px; background: rgba(255,255,255,.15); pointer-events: none; }
  .timeline-buffered, .timeline-progress { position: absolute; inset: 0 auto 0 0; border-radius: inherit; }
  .timeline-buffered { background: rgba(255,255,255,.25); }
  .timeline-progress { background: var(--accent); box-shadow: 0 0 12px rgba(255,255,255,.25); }
  .timeline-input { position: relative; z-index: 2; width: 100%; height: 22px; margin: 0; appearance: none; cursor: pointer; background: transparent; accent-color: var(--accent); }
  .timeline-input::-webkit-slider-runnable-track { height: 4px; background: transparent; }
  .timeline-input::-webkit-slider-thumb { width: 13px; height: 13px; margin-top: -4px; appearance: none; border: 2px solid var(--ink); border-radius: 50%; background: var(--accent); box-shadow: 0 2px 10px rgba(0,0,0,.4); }
  .timeline-input::-moz-range-track { height: 4px; background: transparent; }
  .timeline-input::-moz-range-thumb { width: 11px; height: 11px; border: 2px solid var(--ink); border-radius: 50%; background: var(--accent); }
  /* Player UI V2 (Part 1, Phase 1A): grid row — center group stays exactly
     centered between the fluid side groups. */
  .control-row { display: grid; grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr); align-items: center; gap: 12px; }
  .control-group { display: flex; align-items: center; gap: 5px; min-width: 0; }
  .control-group.left { justify-content: flex-start; }
  .control-group.center { justify-content: center; }
  .control-group.right { justify-content: flex-end; }
  .control-button { display: inline-grid; place-items: center; min-width: 38px; min-height: 38px; border: 1px solid transparent; border-radius: var(--radius-sm); color: var(--ink-soft); background: rgba(0,0,0,.68); cursor: pointer; transition: border-color var(--motion-fast) var(--ease-out), background var(--motion-fast) var(--ease-out), transform var(--motion-fast) var(--ease-out); }
  .control-button:hover, .control-button:focus-visible { border-color: var(--line-strong); background: var(--accent-soft); }
  .control-button:active { transform: scale(.97); }
  .control-button.primary { color: #000; background: var(--accent-strong); box-shadow: 0 4px 14px rgba(255,255,255,.15); }
  .control-button.skip { position: relative; min-width: 36px; }
  .control-button.skip span { position: absolute; font-size: .47rem; font-weight: 800; }
  .control-button.skip:first-of-type span { margin-left: 1px; }
  .control-button.skip:last-of-type span { margin-left: -1px; }
  .time-label { padding: 0 7px; color: var(--ink-soft); font-family: 'Inter', ui-sans-serif, system-ui, sans-serif; font-size: .62rem; white-space: nowrap; }
  .time-label i { color: var(--muted-deep); font-style: normal; }
  .volume-control { display: flex; align-items: center; gap: 4px; }
  .volume-input { width: 78px; accent-color: var(--accent); }
  .select-control { display: inline-flex; align-items: center; gap: 4px; min-height: 38px; padding: 0 7px; border: 1px solid transparent; border-radius: var(--radius-sm); color: var(--ink-soft); background: rgba(0,0,0,.68); font-size: .62rem; }
  .select-control:hover, .select-control:focus-within { border-color: var(--line-strong); }
  .select-control select { max-width: 90px; border: 0; outline: 0; color: inherit; background: transparent; font: inherit; cursor: pointer; }
  .select-control option { color: #181822; background: #f5f6fa; }
  .select-control.speed select { width: 44px; }
  /* Player UI V2 (Part 2, Phase 4): connected Cast state tinted with the
     accent so the active session is legible at a glance (compact 38px —
     never oversized). */
  .cast-button.casting { color: var(--accent); border-color: var(--line-strong); }
  @media (max-width: 840px) { .volume-input, .quality { display: none; } .control-row { gap: 8px; } .control-group.right { gap: 2px; } }
  @media (max-width: 640px) { .controls { width: calc(100% - 24px); margin-top: -65px; padding-bottom: 11px; } .control-row { gap: 5px; } .control-button { min-width: 40px; min-height: 40px; } .time-label { padding: 0 3px; font-size: .56rem; } .select-control.speed { min-width: 40px; padding: 0 4px; } }
  @media (prefers-reduced-motion: reduce) { .control-button { transition: none; } }
</style>
