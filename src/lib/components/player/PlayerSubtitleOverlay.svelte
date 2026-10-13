<script lang="ts">
  // Custom subtitle renderer (focused player fixes 2026-10 — Issues 1+2).
  //
  // WHY THIS EXISTS: subtitles previously rendered through the browser's
  // NATIVE <track> path (track.mode = 'showing'). Native rendering offers
  // NO sync-offset control and NO styling control (size / position / colour
  // / border), which the Subtitle Settings surface requires. The affected
  // track types (the same-origin external VTT proxy tracks used by every
  // direct source) are therefore rendered HERE: the browser still PARSES
  // the WebVTT (the <track> element stays mounted with mode 'hidden'), and
  // this overlay renders the active cues with the user's preferences.
  //
  // GUARANTEES:
  //   * The offset is applied at RENDER time only (displayTime =
  //     mediaTime − offset) — upstream VTT files are never modified and
  //     media playback time is never touched.
  //   * The selection helper is PURE — toggling Off/on, switching tracks,
  //     episodes or sources can never double-apply the offset (no
  //     accumulated state; every frame recomputes from the raw cues).
  //   * Safe cleanup: the rAF loop is cancelled on every stop path
  //     (Off, suppression, unmount). No timers leak.
  //   * PiP / native video fullscreen SUPPRESSION: while the OS renders
  //     the video surface alone, the selected track flips back to
  //     'showing' (the browser paints subtitles inside the PiP /
  //     fullscreen video, preserving the previous PiP behaviour) and this
  //     overlay hides.
  //   * Accessibility: the overlay is aria-hidden (cues are presentational
  //     pixels; the TextTrack remains on the media element) and fully
  //     pointer-transparent so video gestures keep working.
  import { onDestroy } from 'svelte';
  import type { SubtitleBorderStyle } from '$lib/client/player/subtitles/subtitle-preferences';
  import { SUBTITLE_COLOR_PRESETS } from '$lib/client/player/subtitles/subtitle-preferences';
  import { cueDisplayText, selectActiveCues, subtitleDisplayTime, type SubtitleCueLike } from '$lib/client/player/subtitles/subtitle-render';

  /** The SELECTED TextTrack (mode 'hidden') — null when Off. */
  export let track: TextTrack | null = null;
  export let video: HTMLVideoElement | undefined = undefined;
  /** True while the OS surface owns subtitle painting (PiP / native fullscreen). */
  export let suppressed = false;
  // Preference values (bounded by subtitle-preferences.ts sanitize).
  export let offsetSeconds = 0;
  export let sizeScale = 1;
  export let position = 0;
  export let color: keyof typeof SUBTITLE_COLOR_PRESETS[number]['key'] | string = 'white';
  export let borderStyle: SubtitleBorderStyle = 'outline';

  let displayText = '';
  let rafId = 0;

  function frame() {
    rafId = 0;
    if (!track || !video || suppressed) return;
    const displayTime = subtitleDisplayTime(video.currentTime, offsetSeconds);
    // track.cues is null until the browser finishes parsing the VTT —
    // render nothing that frame; rendering starts as soon as cues exist.
    const cueList = track.cues as Iterable<SubtitleCueLike> | null;
    const text = cueDisplayText(selectActiveCues(cueList, displayTime));
    if (text !== displayText) displayText = text;
    rafId = requestAnimationFrame(frame);
  }

  function stopLoop() {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0;
  }

  // Start/stop ONLY on lifecycle inputs (track/video/suppression). Offset
  // changes are read live inside frame() — the next frame immediately
  // reflects them (the immediate-preview requirement) without a loop
  // restart or a text flash.
  $: if (track && video && !suppressed) {
    if (!rafId) rafId = requestAnimationFrame(frame);
  } else {
    stopLoop();
    if (displayText) displayText = '';
  }

  onDestroy(stopLoop);

  $: colorHex = SUBTITLE_COLOR_PRESETS.find((preset) => preset.key === color)?.hex ?? SUBTITLE_COLOR_PRESETS[0].hex;
  // 0 = standard bottom placement, 100 = near the top (bottom-to-top semantics).
  $: bottomPercent = 6 + (Math.min(100, Math.max(0, position)) * 0.58);
</script>

{#if track && video && !suppressed}
  <div class="subtitle-overlay" aria-hidden="true" style={`--sub-color: ${colorHex}; --sub-scale: ${sizeScale}; --sub-bottom: ${bottomPercent}%`}>
    {#if displayText}
      <div class="subtitle-text" class:style-none={borderStyle === 'none'} class:style-outline={borderStyle === 'outline'} class:style-shadow={borderStyle === 'shadow'} class:style-box={borderStyle === 'box'}>{displayText}</div>
    {/if}
  </div>
{/if}

<style>
  .subtitle-overlay {
    position: absolute;
    z-index: 4;
    left: 50%;
    bottom: var(--sub-bottom, 6%);
    transform: translateX(-50%);
    max-width: 92%;
    display: flex;
    justify-content: center;
    pointer-events: none;
  }
  .subtitle-text {
    white-space: pre-line;
    text-align: center;
    color: var(--sub-color, #fff);
    font-size: calc(var(--sub-scale, 1) * clamp(0.85rem, 3.4vh, 2.2rem));
    line-height: 1.35;
    font-weight: 600;
    font-family: 'Inter', ui-sans-serif, system-ui, sans-serif;
    overflow-wrap: break-word;
  }
  /* Border styles — the Subtitle Settings "Border Style" presets. em-based
     so they scale with the size preference. */
  .style-none { text-shadow: none; }
  .style-outline { text-shadow: -0.045em -0.045em 0 #000, 0.045em -0.045em 0 #000, -0.045em 0.045em 0 #000, 0.045em 0.045em 0 #000, 0 0.08em 0.14em rgba(0, 0, 0, 0.85); }
  .style-shadow { text-shadow: 0 0.1em 0.22em rgba(0, 0, 0, 0.95), 0 0 0.06em rgba(0, 0, 0, 0.9); }
  .style-box { background: rgba(0, 0, 0, 0.66); padding: 0.08em 0.38em; border-radius: 0.16em; -webkit-box-decoration-break: clone; box-decoration-break: clone; text-shadow: none; }
  @media (prefers-reduced-motion: reduce) {
    /* No animations here — declared for contract parity with the other
       player surfaces (this component renders no transitions). */
    .subtitle-overlay { transition: none; }
  }
</style>
