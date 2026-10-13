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
  //
  // Focused player fixes (Issue 3, 2026-10): every browser-default select
  // popup is REPLACED with Mavero's own in-player selection sheets — the
  // shared PlayerOptionSheet chrome (dark translucent cinematic surface,
  // safe-area aware, scrollable, focus-trapped, Escape/outside-click
  // dismissal, accent selected-state). Subtitles additionally open the
  // Subtitle Settings sheet (track list + sync offset + appearance —
  // Issues 1+2). Only REAL values are ever offered: the tracks, quality
  // levels and speeds of the ACTIVE source.
  import { Captions, Cast, Check, Expand, Lock, LockOpen, Maximize2, Minimize2, Pause, PictureInPicture2, Play, RotateCcwSquare, RotateCwSquare, Settings2, Volume1, Volume2, VolumeX } from 'lucide-svelte';
  import type { PlayerInternalQualityOption, PlayerQualityOption, PlayerSubtitleTrack } from '$lib/shared/player';
  import { formatPlayerTime, playbackSpeeds, PLAYER_AUTO_QUALITY_ID } from '$lib/shared/player';
  import PlayerOptionSheet from './PlayerOptionSheet.svelte';
  import PlayerSubtitleSheet from './PlayerSubtitleSheet.svelte';
  import { DEFAULT_SUBTITLE_PREFERENCES, type SubtitlePreferences } from '$lib/client/player/subtitles/subtitle-preferences';

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
  // subtitles…') shown inside the sheet next to Off.
  export let subtitleNotice = '';
  export let qualities: PlayerQualityOption[] = [];
  export let selectedQuality = '';
  // Engine-driven HLS quality options (AUTO + real manifest levels) REPLACE
  // the per-stream quality select when present — exactly ONE quality menu.
  export let internalQualities: PlayerInternalQualityOption[] = [];
  export let selectedInternalQuality: string = PLAYER_AUTO_QUALITY_ID;
  // Display mode (Fit/Fill/Stretch) — CSS object-fit on the video element.
  export let displayMode: 'fit' | 'fill' | 'stretch' = 'fit';
  // Focused fixes (Issues 1+2): subtitle preference state + writer (the
  // shell sanitizes + persists; this surface stays presentation-only).
  export let subtitlePrefs: SubtitlePreferences = DEFAULT_SUBTITLE_PREFERENCES;
  export let onSubtitlePreferences: (prefs: SubtitlePreferences) => void = () => {};
  // Issue 3: the shell stands its shortcuts/gestures down while a controls
  // sheet is open — one flag for the whole surface, driven by open/close.
  export let onMenuOpenChange: (open: boolean) => void = () => {};
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

  // ----- Sheet state (Issue 3) -----
  // Exactly ONE sheet open at a time. openMenu/closeMenu are the SINGLE
  // writers of the shell's open flag (deterministic — no mount/destroy
  // ordering dependence).
  let openSheet: 'subtitles' | 'quality' | 'speed' | 'display' | null = null;
  function openMenu(kind: 'subtitles' | 'quality' | 'speed' | 'display') {
    openSheet = kind;
    onMenuOpenChange(true);
  }
  function closeMenu() {
    if (openSheet === null) return;
    openSheet = null;
    onMenuOpenChange(false);
  }

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

  // Subtitle button label: the selected track's display label, or Off.
  $: selectedSubtitleTrack = selectedSubtitle ? subtitles.find((track) => track.url === selectedSubtitle) : undefined;
  $: subtitleButtonLabel = selectedSubtitleTrack ? (selectedSubtitleTrack.label ?? selectedSubtitleTrack.language ?? 'Subtitles') : 'Off';

  // Quality menu: engine levels (AUTO + manifest levels) when present, the
  // per-stream variant list otherwise. NEVER both; empty = no control.
  $: qualityMode = internalQualities.length > 1 ? 'internal' : qualities.length > 1 ? 'stream' : 'none';
  $: qualityOptions = qualityMode === 'internal'
    ? [{ id: PLAYER_AUTO_QUALITY_ID, label: 'Auto', selected: selectedInternalQuality === PLAYER_AUTO_QUALITY_ID }, ...internalQualities.map((option) => ({ id: option.id, label: option.label, selected: option.id === selectedInternalQuality && option.id !== PLAYER_AUTO_QUALITY_ID }))]
    : qualityMode === 'stream'
      ? [{ id: '', label: 'Auto', selected: selectedQuality === '' }, ...qualities.map((option) => ({ id: option.url, label: qualityLabel(option), selected: option.url === selectedQuality }))]
      : [];
  $: qualityButtonLabel = qualityMode === 'internal'
    ? (selectedInternalQuality === PLAYER_AUTO_QUALITY_ID ? 'Auto' : internalQualities.find((option) => option.id === selectedInternalQuality)?.label ?? 'Auto')
    : qualityMode === 'stream'
      ? (selectedQuality ? (qualities.find((option) => option.url === selectedQuality) ? qualityLabel(qualities.find((option) => option.url === selectedQuality)!) : 'Auto') : 'Auto')
      : '';
  $: singleQualityLabel = internalQualities.length === 1 ? internalQualities[0].label : '';

  function chooseQuality(id: string) {
    if (qualityMode === 'internal') {
      if (id !== selectedInternalQuality) onInternalQuality(id);
    } else if (qualityMode === 'stream') {
      onQuality(id);
    }
    closeMenu();
  }

  $: speedOptions = playbackSpeeds.map((speed) => ({ id: String(speed), label: `${speed}×`, selected: speed === playbackRate }));
  function chooseSpeed(id: string) {
    const value = Number(id);
    if (Number.isFinite(value)) onPlaybackRate(value);
    closeMenu();
  }

  const displayOptions: ReadonlyArray<{ id: 'fit' | 'fill' | 'stretch'; label: string }> = [
    { id: 'fit', label: 'Fit' },
    { id: 'fill', label: 'Fill' },
    { id: 'stretch', label: 'Stretch' },
  ];
  function chooseDisplay(id: string) {
    if (id === 'fit' || id === 'fill' || id === 'stretch') onDisplayMode(id);
    closeMenu();
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

    <!-- Secondary row: buttons open Mavero selection sheets (Issue 3 — no
         browser-default select popups). Same row semantics as the
         approved layout: portrait left-aligned group, landscape packs
         right; the subtitle control flexes to absorb leftover width in
         portrait and stops flexing in landscape. -->
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
             never be mistaken for a working feature). Opens the Subtitle
             Settings sheet: track list + sync + appearance (Issues 1+2+3). -->
        <button class="select-control subtitles sheet-trigger" type="button" aria-label={`Subtitles: ${subtitleButtonLabel}${subtitleNotice ? ` (${subtitleNotice})` : ''}`} aria-haspopup="dialog" title={subtitleNotice || undefined} onclick={() => openMenu('subtitles')}>
          <Captions size={16} aria-hidden="true" />
          <span class="control-label">{subtitleButtonLabel}</span>
        </button>
        {#if qualityMode !== 'none'}
          <!-- Engine-driven HLS quality: AUTO + the manifest's REAL levels;
               otherwise the stream's real variant list. -->
          <button class="select-control quality sheet-trigger" type="button" aria-label={`Playback quality: ${qualityButtonLabel}`} aria-haspopup="dialog" onclick={() => openMenu('quality')}>
            <Settings2 size={15} aria-hidden="true" />
            <span class="control-label">{qualityButtonLabel}</span>
          </button>
        {:else if singleQualityLabel}
          <!-- A manifest with exactly ONE level cannot offer a selection —
               the truthful state is a DISABLED control showing the REAL
               level label (never a fabricated Auto/quality list). -->
          <button class="select-control quality sheet-trigger" type="button" disabled aria-disabled="true" title={`Quality ${singleQualityLabel} (no other qualities available)`} aria-label={`Playback quality: ${singleQualityLabel} (single available quality)`}>
            <Settings2 size={15} aria-hidden="true" />
            <span class="control-label">{singleQualityLabel}</span>
          </button>
        {/if}
        <!-- Display mode: Fit preserves aspect with letterboxing, Fill
             preserves aspect and crops, Stretch fills both axes. CSS-only —
             switching never restarts the stream or moves the playhead. -->
        <button class="select-control display-mode sheet-trigger" type="button" aria-label={`Display mode: ${displayMode}`} aria-haspopup="dialog" onclick={() => openMenu('display')}>
          <Expand size={15} aria-hidden="true" />
          <span class="control-label">{displayMode === 'fit' ? 'Fit' : displayMode === 'fill' ? 'Fill' : 'Stretch'}</span>
        </button>
        <!-- Speed: the selected speed renders ONCE (the button itself). -->
        <button class="select-control speed sheet-trigger" type="button" aria-label={`Playback speed: ${playbackRate}×`} aria-haspopup="dialog" onclick={() => openMenu('speed')}>
          <span class="control-label">{playbackRate}×</span>
        </button>
      {/if}
      <!-- Fullscreen/landscape: the SAME Mavero fullscreen + orientation
           controller for every provider (the floating Landscape FAB remains
           only for embed sources, which have no Mavero control surface). -->
      <button class="control-button" type="button" aria-label={fullscreenActive ? 'Exit fullscreen' : 'Enter fullscreen'} aria-pressed={fullscreenActive} onclick={onFullscreen}>{#if fullscreenActive}<Minimize2 size={17} />{:else}<Maximize2 size={17} />{/if}</button>
    </div>
  </div>

  <!-- In-player selection sheets (Issue 3): Mavero surfaces, rendered inside
       the control layer so they inherit its geometry (full-shell overlay). -->
  {#if openSheet === 'subtitles'}
    <PlayerSubtitleSheet tracks={subtitles} {selectedSubtitle} notice={subtitleNotice} prefs={subtitlePrefs} onSubtitle={(url) => { onSubtitle(url); closeMenu(); }} onPrefs={onSubtitlePreferences} onClose={closeMenu} />
  {/if}
  {#if openSheet === 'quality'}
    <PlayerOptionSheet title="Quality" onClose={closeMenu}>
      <div class="option-list" role="group" aria-label="Playback quality">
        {#each qualityOptions as option (option.id)}
          <button class="option-row" class:selected={option.selected} type="button" onclick={() => chooseQuality(option.id)}>
            <span class="row-mark">{#if option.selected}<Check size={15} />{/if}</span>
            <span class="row-copy"><strong>{option.label}</strong></span>
          </button>
        {/each}
      </div>
    </PlayerOptionSheet>
  {/if}
  {#if openSheet === 'display'}
    <PlayerOptionSheet title="Display mode" onClose={closeMenu}>
      <div class="option-list" role="group" aria-label="Display mode">
        {#each displayOptions as option (option.id)}
          <button class="option-row" class:selected={displayMode === option.id} type="button" onclick={() => chooseDisplay(option.id)}>
            <span class="row-mark">{#if displayMode === option.id}<Check size={15} />{/if}</span>
            <span class="row-copy"><strong>{option.label}</strong><small>{option.id === 'fit' ? 'Preserves aspect (letterbox allowed)' : option.id === 'fill' ? 'Preserves aspect (crops to fill)' : 'Fills both axes (distorts)'}</small></span>
          </button>
        {/each}
      </div>
    </PlayerOptionSheet>
  {/if}
  {#if openSheet === 'speed'}
    <PlayerOptionSheet title="Playback speed" onClose={closeMenu}>
      <div class="option-list" role="group" aria-label="Playback speed">
        {#each speedOptions as option (option.id)}
          <button class="option-row" class:selected={option.selected} type="button" onclick={() => chooseSpeed(option.id)}>
            <span class="row-mark">{#if option.selected}<Check size={15} />{/if}</span>
            <span class="row-copy"><strong>{option.label}</strong></span>
          </button>
        {/each}
      </div>
    </PlayerOptionSheet>
  {/if}
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

  /* Secondary row: ONE compact left-aligned control group in BOTH
     orientations (final remediation). flex-wrap remains only as the
     deliberate narrow-viewport fallback — it can no longer produce the
     reported "fullscreen on its own row" result, because nothing in the
     row stretches anymore (the former flex-grow spacer is REMOVED) and the
     subtitle control shrinks before anything wraps. */
  .secondary-row { display: flex; align-items: center; flex-wrap: wrap; justify-content: flex-start; gap: 6px; }
  .control-button { display: inline-grid; place-items: center; min-width: 40px; min-height: 40px; border: 1px solid transparent; border-radius: var(--radius-sm); color: var(--ink-soft); background: rgba(0,0,0,.5); cursor: pointer; transition: border-color var(--motion-fast) var(--ease-out), background var(--motion-fast) var(--ease-out), transform var(--motion-fast) var(--ease-out); }
  .control-button:hover, .control-button:focus-visible { border-color: var(--line-strong); background: var(--accent-soft); }
  .control-button:active { transform: scale(.97); }
  .volume-control { display: flex; align-items: center; gap: 4px; }
  .volume-input { width: 78px; accent-color: var(--accent); }
  /* Issue 3: the former native select popups are now BUTTONS that open
     Mavero sheets. Same compact footprint; the label truncates with an
     ellipsis so long track names can never expand the row. */
  .select-control { display: inline-flex; align-items: center; gap: 4px; min-height: 40px; padding: 0 7px; border: 1px solid transparent; border-radius: var(--radius-sm); color: var(--ink-soft); background: rgba(0,0,0,.5); font-size: .62rem; cursor: pointer; font: inherit; font-size: .62rem; }
  .select-control:hover:not(:disabled), .select-control:focus-visible { border-color: var(--line-strong); background: var(--accent-soft); }
  .select-control:disabled { opacity: .6; cursor: default; }
  .select-control .control-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .select-control.subtitles { flex: 1 1 56px; min-width: 56px; max-width: 110px; }
  .select-control.subtitles .control-label { flex: 1 1 auto; text-align: left; }
  .select-control.quality .control-label { max-width: 64px; }
  .select-control.display-mode .control-label { max-width: 58px; }
  .select-control.speed .control-label { max-width: 44px; }

  /* In-player selection sheet option rows (shared shape across quality /
     display / speed sheets; the subtitle sheet carries its own richer
     controls). */
  .option-list { display: grid; gap: 3px; }
  .option-row { display: flex; align-items: center; gap: 11px; min-height: 46px; border: 1px solid transparent; border-radius: var(--radius-sm); padding: 7px 12px; color: var(--ink-soft); background: transparent; cursor: pointer; text-align: left; font: inherit; }
  .option-row:hover, .option-row:focus-visible, .option-row.selected { border-color: var(--line-strong); background: var(--accent-soft); }
  .option-row.selected { color: var(--ink); }
  .row-mark { display: grid; flex: 0 0 22px; place-items: center; width: 22px; height: 22px; color: var(--muted); }
  .option-row.selected .row-mark { border: 1px solid var(--line-strong); border-radius: 50%; color: var(--accent); }
  .row-copy { min-width: 0; }
  .row-copy strong { display: block; color: var(--ink); font-size: .72rem; overflow-wrap: anywhere; }
  .row-copy small { display: block; margin-top: 2px; color: var(--muted); font-size: .55rem; }

  /* Player V2 corrections: connected Cast state tinted with the accent. */
  .cast-button.casting { color: var(--accent); border-color: var(--line-strong); }

  /* Compact viewports: the volume slider folds away (the mute button and the
     right-zone volume swipe remain); every OTHER control — subtitles,
     quality, display mode, speed, fullscreen — stays reachable (the reported
     "no quality selector on phones" regression). */
  @media (max-width: 840px) {
    .volume-input { display: none; }
  }
  @media (max-width: 640px) {
    .bottom-zone { padding: 8px 8px calc(10px + env(safe-area-inset-bottom)); }
    .secondary-row { gap: 3px; }
    .time-label { font-size: .56rem; }
    .select-control { padding: 0 5px; }
    .select-control.subtitles { min-width: 48px; }
    .select-control.display-mode { gap: 0; }
    /* The display-mode icon is decorative — on narrow phones it folds away
       so Fit/Fill/Stretch keeps its readable labels and the row stays ONE
       line down to 360px (deliberate compact fallback budget). */
    .select-control.display-mode :global(svg) { display: none; }
    .center-cluster { gap: 20px; }
    .cluster-button.play { width: 62px; height: 62px; }
    .cluster-button.seek { width: 50px; height: 50px; }
  }
  /* Landscape phone (Player V2 remaining fixes, 2026-10): the secondary row
     is ONE RIGHT-aligned compact group — the user's approved landscape
     layout puts the secondary controls on the RIGHT edge (the center cluster
     and the top-left Back FAB are untouched). fullscreen stays INSIDE the
     group and the row cannot collide with the timeline above it (the grid
     gap + the bottom-zone padding hold the separation). The subtitle control
     stops flexing in landscape (flex: 0 1 auto) so the leftover row width is
     NOT absorbed by the group — the whole group packs to the right edge.
     Portrait keeps the same left-aligned group semantics (the base rule
     above is untouched; this block only tightens landscape). */
  @media (orientation: landscape) and (max-height: 500px) {
    .secondary-row { flex-wrap: nowrap; gap: 5px; justify-content: flex-end; }
    .select-control.subtitles { flex: 0 1 auto; }
  }
  /* Landscape phone: keep the cluster clear of the bottom zone. */
  @media (orientation: landscape) and (max-height: 500px) {
    .center-cluster { transform: translate(-50%, calc(-50% - 16px)); }
    .bottom-zone { padding: 6px 12px calc(8px + env(safe-area-inset-bottom)); }
  }
  @media (prefers-reduced-motion: reduce) { .control-button, .cluster-button { transition: none; } }
</style>
