<script lang="ts">
  // Subtitle Settings sheet (focused player fixes 2026-10 — Issues 1+2+3).
  //
  // ONE Mavero-styled surface combining:
  //   * track selection (Off + every REAL track — never fabricated options);
  //   * Subtitle Sync / Offset — ±0.5 s steps, live value display, an
  //     obvious reset-to-zero, and the convention spelled out
  //     ("+ delays · − shows earlier");
  //   * Text size (stepper, bounded), Vertical position (bottom→top slider),
  //     Text colour (fixed preset swatches), Border style
  //     (None/Outline/Shadow/Box);
  //   * Reset — restores the default appearance AND offset.
  //
  // Every change dispatches through onPrefs/onSubtitle immediately — the
  // overlay re-renders on the very next frame (live preview while watching).
  // The parent (shell) sanitizes + persists; this component stays dumb.
  import { Check, RotateCcw } from 'lucide-svelte';
  import PlayerOptionSheet from './PlayerOptionSheet.svelte';
  import type { PlayerSubtitleTrack } from '$lib/shared/player';
  import {
    DEFAULT_SUBTITLE_PREFERENCES,
    SUBTITLE_COLOR_PRESETS,
    SUBTITLE_OFFSET,
    SUBTITLE_POSITION,
    SUBTITLE_SIZE_SCALE,
    formatSubtitleOffset,
    stepSubtitleOffset,
    stepSubtitleSize,
    type SubtitleBorderStyle,
    type SubtitleColorKey,
    type SubtitlePreferences,
  } from '$lib/client/player/subtitles/subtitle-preferences';

  export let tracks: PlayerSubtitleTrack[] = [];
  export let selectedSubtitle = '';
  /** Honest feature-state text ('Checking subtitles…' / 'No subtitles available' / 'Subtitles unavailable'). */
  export let notice = '';
  export let prefs: SubtitlePreferences = DEFAULT_SUBTITLE_PREFERENCES;
  export let onSubtitle: (url: string) => void = () => {};
  export let onPrefs: (next: SubtitlePreferences) => void = () => {};
  export let onClose: () => void = () => {};

  function trackLabel(track: PlayerSubtitleTrack, index: number): string {
    return track.label ?? track.language ?? `Track ${index + 1}`;
  }

  const BORDER_OPTIONS: ReadonlyArray<{ key: SubtitleBorderStyle; label: string }> = [
    { key: 'none', label: 'None' },
    { key: 'outline', label: 'Outline' },
    { key: 'shadow', label: 'Shadow' },
    { key: 'box', label: 'Box' },
  ];

  function positionValueText(value: number): string {
    if (value <= 0) return 'Bottom';
    if (value >= 100) return 'Top';
    return `${Math.round(value)}% from bottom`;
  }

  $: sizePercent = `${Math.round(prefs.sizeScale * 100)}%`;
  $: offsetAtMin = prefs.offsetSeconds <= SUBTITLE_OFFSET.min;
  $: offsetAtMax = prefs.offsetSeconds >= SUBTITLE_OFFSET.max;
  $: sizeAtMin = prefs.sizeScale <= SUBTITLE_SIZE_SCALE.min;
  $: sizeAtMax = prefs.sizeScale >= SUBTITLE_SIZE_SCALE.max;
</script>

<PlayerOptionSheet title="Subtitles" {onClose}>
  <!-- Section 1: track selection (honest states included). -->
  <div class="section-label" id="mav-sub-track-label">Subtitles</div>
  <div class="track-list" role="group" aria-labelledby="mav-sub-track-label">
    <button class="track-row" class:selected={selectedSubtitle === ''} type="button" onclick={() => onSubtitle('')}>
      <span class="row-mark">{#if selectedSubtitle === ''}<Check size={15} />{/if}</span>
      <span class="row-copy"><strong>Off</strong></span>
    </button>
    {#each tracks as track, index}
      <button class="track-row" class:selected={selectedSubtitle === track.url} type="button" onclick={() => onSubtitle(track.url)}>
        <span class="row-mark">{#if selectedSubtitle === track.url}<Check size={15} />{/if}</span>
        <span class="row-copy"><strong>{trackLabel(track, index)}</strong>{#if track.language}<small>{track.language}</small>{/if}</span>
      </button>
    {/each}
    {#if !tracks.length && notice}
      <div class="notice-row" role="status">{notice}</div>
    {/if}
  </div>

  <!-- Section 2: Subtitle Sync / Offset. Positive = LATER (the convention
       is stated verbatim next to the control). -->
  <div class="section-label" id="mav-sub-sync-label">Subtitle sync</div>
  <div class="control-row">
    <span class="control-copy" id="mav-sub-offset-label">Offset</span>
    <div class="stepper" role="group" aria-labelledby="mav-sub-offset-label">
      <button class="step-button" type="button" aria-label="Show subtitles 0.5 seconds earlier" disabled={offsetAtMin} onclick={() => onPrefs({ ...prefs, offsetSeconds: stepSubtitleOffset(prefs.offsetSeconds, -1) })}>&minus;0.5s</button>
      <span class="step-value" aria-live="polite">{formatSubtitleOffset(prefs.offsetSeconds)}</span>
      <button class="step-button" type="button" aria-label="Delay subtitles 0.5 seconds later" disabled={offsetAtMax} onclick={() => onPrefs({ ...prefs, offsetSeconds: stepSubtitleOffset(prefs.offsetSeconds, 1) })}>+0.5s</button>
      <button class="mini-reset" type="button" aria-label="Reset subtitle offset to zero" disabled={prefs.offsetSeconds === 0} onclick={() => onPrefs({ ...prefs, offsetSeconds: 0 })}><RotateCcw size={13} /></button>
    </div>
  </div>
  <p class="hint">Positive delays subtitles &middot; negative shows them earlier</p>

  <!-- Section 3: text size. -->
  <div class="section-label" id="mav-sub-size-label">Text size</div>
  <div class="control-row">
    <span class="control-copy" id="mav-sub-size-value">{sizePercent}</span>
    <div class="stepper" role="group" aria-labelledby="mav-sub-size-label">
      <button class="step-button" type="button" aria-label="Decrease subtitle text size" disabled={sizeAtMin} onclick={() => onPrefs({ ...prefs, sizeScale: stepSubtitleSize(prefs.sizeScale, -1) })}>&minus;</button>
      <div class="size-preview" aria-hidden="true" style={`font-size: calc(${prefs.sizeScale} * 0.82rem)`}>Aa</div>
      <button class="step-button" type="button" aria-label="Increase subtitle text size" disabled={sizeAtMax} onclick={() => onPrefs({ ...prefs, sizeScale: stepSubtitleSize(prefs.sizeScale, 1) })}>+</button>
    </div>
  </div>

  <!-- Section 4: vertical position (clear bottom→top semantics). -->
  <div class="section-label" id="mav-sub-pos-label">Vertical position</div>
  <div class="control-row slider-row">
    <span class="slider-bound">Bottom</span>
    <input class="pos-slider" type="range" min={SUBTITLE_POSITION.min} max={SUBTITLE_POSITION.max} step={SUBTITLE_POSITION.step} value={prefs.position} aria-labelledby="mav-sub-pos-label" aria-valuetext={positionValueText(prefs.position)} oninput={(event) => onPrefs({ ...prefs, position: Number((event.currentTarget as HTMLInputElement).value) })} />
    <span class="slider-bound">Top</span>
  </div>

  <!-- Section 5: text colour (fixed presets only). -->
  <div class="section-label" id="mav-sub-color-label">Colour</div>
  <div class="swatch-row" role="group" aria-labelledby="mav-sub-color-label">
    {#each SUBTITLE_COLOR_PRESETS as preset (preset.key)}
      <button class="swatch" class:selected={prefs.color === preset.key} type="button" style={`background: ${preset.hex}`} aria-label={`Subtitle colour ${preset.label}`} aria-pressed={prefs.color === preset.key} onclick={() => onPrefs({ ...prefs, color: preset.key as SubtitleColorKey })}>
        {#if prefs.color === preset.key}<Check size={13} />{/if}
      </button>
    {/each}
  </div>

  <!-- Section 6: border style. -->
  <div class="section-label" id="mav-sub-border-label">Border style</div>
  <div class="segmented" role="group" aria-labelledby="mav-sub-border-label">
    {#each BORDER_OPTIONS as option (option.key)}
      <button class="segment" class:selected={prefs.borderStyle === option.key} type="button" aria-pressed={prefs.borderStyle === option.key} onclick={() => onPrefs({ ...prefs, borderStyle: option.key })}>{option.label}</button>
    {/each}
  </div>

  <!-- Section 7: reset everything (appearance + offset). -->
  <button class="reset-all" type="button" onclick={() => onPrefs({ ...DEFAULT_SUBTITLE_PREFERENCES })}><RotateCcw size={14} /> Reset subtitle settings</button>
</PlayerOptionSheet>

<style>
  .section-label { color: var(--muted); font-family: 'Inter', ui-sans-serif, system-ui, sans-serif; font-size: 0.54rem; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; padding: 12px 6px 6px; border-top: 1px solid var(--line); margin-top: 8px; }
  .section-label:first-child { border-top: 0; margin-top: 0; padding-top: 4px; }
  .track-list { display: grid; gap: 3px; }
  .track-row { display: flex; align-items: center; gap: 11px; min-height: 46px; border: 1px solid transparent; border-radius: var(--radius-sm); padding: 7px 12px; color: var(--ink-soft); background: transparent; cursor: pointer; text-align: left; font: inherit; }
  .track-row:hover, .track-row:focus-visible, .track-row.selected { border-color: var(--line-strong); background: var(--accent-soft); }
  .track-row.selected { color: var(--ink); }
  .row-mark { display: grid; flex: 0 0 22px; place-items: center; width: 22px; height: 22px; color: var(--muted); }
  .track-row.selected .row-mark { border: 1px solid var(--line-strong); border-radius: 50%; color: var(--accent); }
  .row-copy { min-width: 0; }
  .row-copy strong { display: block; color: var(--ink); font-size: 0.72rem; overflow-wrap: anywhere; }
  .row-copy small { display: block; margin-top: 2px; color: var(--muted); font-size: 0.55rem; }
  .notice-row { min-height: 40px; display: flex; align-items: center; padding: 7px 12px; color: var(--muted); font-size: 0.64rem; }
  .control-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; min-height: 44px; padding: 0 6px; }
  .control-copy { color: var(--ink); font-size: 0.68rem; font-variant-numeric: tabular-nums; }
  .stepper { display: inline-flex; align-items: center; gap: 6px; }
  .step-button { display: inline-grid; place-items: center; min-width: 44px; min-height: 38px; border: 1px solid var(--line-strong); border-radius: var(--radius-sm); color: var(--ink); background: rgba(255, 255, 255, 0.04); cursor: pointer; font: inherit; font-size: 0.6rem; font-weight: 600; font-variant-numeric: tabular-nums; }
  .step-button:hover:not(:disabled), .step-button:focus-visible { border-color: var(--accent); background: var(--accent-soft); }
  .step-button:disabled { opacity: 0.4; cursor: default; }
  .step-value { min-width: 58px; text-align: center; color: var(--accent); font-size: 0.74rem; font-weight: 700; font-variant-numeric: tabular-nums; }
  .mini-reset { display: inline-grid; place-items: center; width: 34px; height: 34px; border: 1px solid var(--line); border-radius: var(--radius-sm); color: var(--muted); background: rgba(255, 255, 255, 0.03); cursor: pointer; }
  .mini-reset:hover:not(:disabled), .mini-reset:focus-visible { border-color: var(--line-strong); color: var(--ink); }
  .mini-reset:disabled { opacity: 0.4; cursor: default; }
  .size-preview { display: grid; place-items: center; min-width: 44px; height: 38px; color: var(--ink); font-weight: 700; }
  .hint { margin: 2px 6px 0; color: var(--muted); font-size: 0.55rem; }
  .slider-row { gap: 8px; }
  .slider-bound { color: var(--muted); font-size: 0.55rem; white-space: nowrap; }
  .pos-slider { flex: 1; min-width: 0; accent-color: var(--accent); }
  .swatch-row { display: flex; flex-wrap: wrap; gap: 8px; padding: 2px 6px; }
  .swatch { display: grid; place-items: center; width: 36px; height: 36px; border: 2px solid var(--line-strong); border-radius: 50%; color: #111; cursor: pointer; }
  .swatch:hover, .swatch:focus-visible { border-color: var(--ink); }
  .swatch.selected { border-color: var(--accent); box-shadow: 0 0 0 2px var(--accent-soft); }
  .segmented { display: flex; flex-wrap: wrap; gap: 5px; padding: 2px 6px; }
  .segment { display: inline-flex; align-items: center; justify-content: center; min-height: 38px; padding: 0 12px; border: 1px solid var(--line-strong); border-radius: var(--radius-sm); color: var(--ink-soft); background: rgba(255, 255, 255, 0.03); cursor: pointer; font: inherit; font-size: 0.6rem; font-weight: 600; }
  .segment:hover, .segment:focus-visible { border-color: var(--line-strong); background: var(--accent-soft); color: var(--ink); }
  .segment.selected { border-color: var(--accent); background: var(--accent-soft); color: var(--ink); }
  .reset-all { display: inline-flex; align-items: center; gap: 7px; min-height: 42px; margin: 14px 6px 2px; border: 1px solid var(--line-strong); border-radius: var(--radius-sm); padding: 0 14px; color: var(--ink); background: rgba(255, 255, 255, 0.04); cursor: pointer; font: inherit; font-size: 0.62rem; font-weight: 600; }
  .reset-all:hover, .reset-all:focus-visible { border-color: var(--accent); background: var(--accent-soft); }
</style>
