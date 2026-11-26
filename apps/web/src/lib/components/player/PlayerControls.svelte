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
  import { AudioLines, Captions, Cast, Check, Expand, Lock, LockOpen, Maximize2, Minimize2, Pause, PictureInPicture2, Play, RotateCcwSquare, RotateCwSquare, Server, Settings2, Volume1, Volume2, VolumeX, Gauge } from 'lucide-svelte';
  import type { PlayerAudioTrackOption, PlayerInternalQualityOption, PlayerQualityOption, PlayerServerOption, PlayerSubtitleTrack } from '$lib/shared/player';
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
  // Phase 10 (GOAL 18) completion (2026-10-16): the HLS engine's REAL audio
  // tracks (hls.js audioTracks — e.g. Turkish + original-language renditions
  // on multi-audio manifests). Only tracks the ACTIVE engine actually
  // exposes are offered; the control renders ONLY when there is a real
  // choice (>1 track) — a missing menu can never be mistaken for a working
  // feature, mirroring the honest-empty subtitle/quality patterns.
  export let audioTracks: PlayerAudioTrackOption[] = [];
  export let selectedAudioTrack: number | null = null;
  export let onAudioTrack: (index: number) => void = () => {};
  // 2026-10 round 32 (VidCore Multi Stream): the ORDERED playback servers the
  // resolver exposed (Supreme / Prime / Horizon / …). Same honest-empty
  // pattern as the audio menu: the control renders ONLY when there is a REAL
  // choice (>1 server). Selection is a URL; switching re-prepares the stream
  // (position is captured by the shell) — no re-resolve needed.
  export let servers: PlayerServerOption[] = [];
  export let selectedServer = '';
  export let onServer: (url: string) => void = () => {};
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
  // Round 50 (approved concept) — header + paused metadata card. All
  // display-only, all optional; the shell passes what it has and nothing is
  // invented. `onResume` reuses the EXISTING resume path (the shell's
  // togglePlay) — when absent the Resume pill simply hides.
  /** Title shown in the top-left header while the chrome is visible. */
  export let title = '';
  /** Meta line (year · genres · runtime) under the header title. */
  export let metaLine = '';
  /** One-line overview for the paused metadata card. */
  export let overview = '';
  /** Paused-card Resume pill label (e.g. “Resume 42:15”). */
  export let resumeLabel = '';
  /** The existing resume path (the shell's togglePlay). Absent → no pill. */
  export let onResume: (() => void) | null = null;

  // ----- Sheet state (Issue 3) -----
  // Exactly ONE sheet open at a time. openMenu/closeMenu are the SINGLE
  // writers of the shell's open flag (deterministic — no mount/destroy
  // ordering dependence).
  let openSheet: 'subtitles' | 'quality' | 'audio' | 'servers' | 'speed' | 'display' | null = null;
  // Round 50 — the trigger chip each popover anchors to (bind:this below,
  // passed to the matching sheet's `anchor` prop → popoverAnchor action).
  let displayAnchor: HTMLButtonElement | undefined = undefined;
  let subtitlesAnchor: HTMLButtonElement | undefined = undefined;
  let qualityAnchor: HTMLButtonElement | undefined = undefined;
  let serverAnchor: HTMLButtonElement | undefined = undefined;
  let audioAnchor: HTMLButtonElement | undefined = undefined;
  let speedAnchor: HTMLButtonElement | undefined = undefined;
  // Round 50 — the 90ms EXIT animation: closeMenu() keeps the sheet mounted
  // (closing=true → fade-only exit) and unmounts it after the exit so the
  // popover never blinks out; the shell's open flag flips with the actual
  // unmount so gestures/shortcuts stand down exactly while it is on screen.
  // Reduced motion → instant close. openMenu() always cancels a pending
  // close so a rapid chip switch mounts the next popover fresh.
  let sheetClosing = false;
  let sheetCloseTimer: ReturnType<typeof setTimeout> | undefined = undefined;
  function openMenu(kind: 'subtitles' | 'quality' | 'audio' | 'servers' | 'speed' | 'display') {
    if (sheetCloseTimer) {
      clearTimeout(sheetCloseTimer);
      sheetCloseTimer = undefined;
    }
    sheetClosing = false;
    openSheet = kind;
    onMenuOpenChange(true);
  }
  function closeMenu() {
    if (openSheet === null || sheetClosing) return;
    if (sheetCloseTimer) clearTimeout(sheetCloseTimer);
    sheetClosing = true;
    const reduced = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    sheetCloseTimer = setTimeout(() => {
      sheetCloseTimer = undefined;
      openSheet = null;
      sheetClosing = false;
      onMenuOpenChange(false);
    }, reduced ? 0 : 90);
  }

  $: safeDuration = Number.isFinite(duration) && duration > 0 ? duration : 0;
  $: progressPercent = safeDuration ? Math.min(100, Math.max(0, (currentTime / safeDuration) * 100)) : 0;
  $: bufferedPercent = safeDuration ? Math.min(100, Math.max(0, (buffered / safeDuration) * 100)) : 0;
  $: volumeIcon = muted || volume === 0 ? 'muted' : volume < 0.5 ? 'low' : 'high';
  // Round 50 — the volume slider's white filled portion (webkit has no
  // ::-range-progress, so the track is a hard colour stop at this percent).
  $: volumeFillPercent = muted || volume <= 0 ? 0 : Math.round(Math.min(1, Math.max(0, volume)) * 100);

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

  // Audio track selector (GOAL 18 completion): REAL engine tracks only —
  // the control renders ONLY when the active HLS manifest actually exposes
  // more than one audio track. Labels are the manifest-provided name/lang
  // verbatim (never invented); with no selection reported yet, the engine
  // default stays active and the menu simply does not mark any row.
  // Server selector (round 32): REAL resolver-exposed servers only — the
  // control renders ONLY when the active source carries more than one
  // server. Labels are the resolver-provided names verbatim.
  $: serverMode = servers.length >= 1 ? 'menu' : 'none';
  $: serverButtonLabel = (selectedServer && servers.find((server) => server.url === selectedServer)?.label) || 'Server';
  // Round 36/38/45 — group servers by server name (Vidsrc | Vidstream |
  // VidVelvet | VidBox)
  // for the two-pane server sheet. The active group filter defaults to 'all'.
  $: serverGroups = [...new Set(servers.map((s) => s.server || 'Vidsrc'))];
  let activeServerGroup = 'all';
  $: filteredServers = activeServerGroup === 'all'
    ? servers
    : servers.filter((s) => (s.server || 'Vidsrc') === activeServerGroup);
  function chooseServer(url: string) {
    if (url !== selectedServer) onServer(url);
    closeMenu();
  }

  $: audioMode = audioTracks.length > 1 ? 'menu' : 'none';
  function audioTrackLabel(track: PlayerAudioTrackOption): string {
    const name = typeof track.name === 'string' ? track.name.trim() : '';
    if (name) return name;
    const lang = typeof track.lang === 'string' ? track.lang.trim() : '';
    return lang || `Track ${track.id + 1}`;
  }
  $: audioButtonLabel = selectedAudioTrack !== null && audioTracks[selectedAudioTrack]
    ? audioTrackLabel(audioTracks[selectedAudioTrack])
    : 'Audio';
  function chooseAudioTrack(index: number) {
    if (index !== selectedAudioTrack) onAudioTrack(index);
    closeMenu();
  }

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
  <!-- Round 50 — header (approved concept): title + meta line, TOP-LEFT of
       the utility-zone strip, before the right-aligned chips. The Back FAB
       keeps its own top-left spot: below 1024px the header sits just under
       the FAB line so it can never collide with the right-aligned chip row
       (the round 37 B one-line top row is untouched); ≥1024px it shares the
       FAB's line. Renders nothing when both strings are empty. -->
  {#if title || metaLine}
    <div class="header-zone" aria-hidden="true">
      {#if title}<div class="header-title">{title}</div>{/if}
      {#if metaLine}<div class="header-meta">{metaLine}</div>{/if}
    </div>
  {/if}
  <!-- TOP-RIGHT utility zone: Display Mode, Subtitles, Quality, Server, Cast, PiP, Lock.
       Round 37 B — Subtitles/Quality/Server moved here from the bottom row so
       the bottom row fits a 360–430 px portrait width without wrapping. -->
  <div class="utility-zone">
    <button bind:this={displayAnchor} class="control-button" type="button" aria-label={`Display mode: ${displayMode}`} aria-haspopup="dialog" onclick={() => openMenu('display')}><Expand size={17} strokeWidth={1.5} /></button>
    {#if !castActive}
      <button bind:this={subtitlesAnchor} class="select-control subtitles sheet-trigger" class:open={openSheet === 'subtitles'} type="button" aria-label={`Subtitles: ${subtitleButtonLabel}${subtitleNotice ? ` (${subtitleNotice})` : ''}`} aria-haspopup="dialog" title={subtitleNotice || undefined} onclick={() => openMenu('subtitles')}>
        <Captions size={16} strokeWidth={1.5} aria-hidden="true" />
        <span class="chip-label">Subtitles</span>
        <span class="chip-value">{subtitleButtonLabel}</span>
      </button>
      {#if qualityMode !== 'none'}
        <button bind:this={qualityAnchor} class="select-control quality sheet-trigger" class:open={openSheet === 'quality'} type="button" aria-label={`Playback quality: ${qualityButtonLabel}`} aria-haspopup="dialog" onclick={() => openMenu('quality')}>
          <Settings2 size={16} strokeWidth={1.5} aria-hidden="true" />
          <span class="chip-label">Quality</span>
          <span class="chip-value">{qualityButtonLabel}</span>
        </button>
      {:else if singleQualityLabel}
        <button class="select-control quality sheet-trigger" type="button" disabled aria-disabled="true" title={`Quality ${singleQualityLabel} (no other qualities available)`} aria-label={`Playback quality: ${singleQualityLabel} (single available quality)`}>
          <Settings2 size={16} strokeWidth={1.5} aria-hidden="true" />
          <span class="chip-label">Quality</span>
          <span class="chip-value">{singleQualityLabel}</span>
        </button>
      {/if}
      {#if serverMode === 'menu'}
        <button bind:this={serverAnchor} class="select-control server sheet-trigger" class:open={openSheet === 'servers'} type="button" aria-label={`Server: ${serverButtonLabel}`} aria-haspopup="dialog" onclick={() => openMenu('servers')}>
          <Server size={16} strokeWidth={1.5} aria-hidden="true" />
          <span class="chip-label">Server</span>
          <span class="chip-value">{serverButtonLabel}</span>
        </button>
      {/if}
    {/if}
    {#if castAvailable}
      <button class="control-button cast-button" class:casting={castActive} type="button" aria-label={castActive ? 'Disconnect cast session' : 'Cast to a device'} aria-pressed={castActive} onclick={onCast}><Cast size={17} strokeWidth={1.5} /></button>
    {/if}
    {#if !castActive && pictureInPictureSupported}
      <button class="control-button" type="button" aria-label={pictureInPicture ? 'Exit Picture-in-Picture' : 'Enter Picture-in-Picture'} aria-pressed={pictureInPicture} onclick={onPictureInPicture}><PictureInPicture2 size={17} strokeWidth={1.5} /></button>
    {/if}
    <button class="control-button lock-button" type="button" aria-label={locked ? 'Unlock player controls' : 'Lock player controls'} aria-pressed={locked} onclick={onToggleLock}>{#if locked}<LockOpen size={17} strokeWidth={1.5} />{:else}<Lock size={17} strokeWidth={1.5} />{/if}</button>
  </div>

  <!-- BOTTOM zone: time + timeline, then the control row.
       Round 37 B — the bottom row keeps only Play/Pause, ±10s, Volume, Speed,
       Fullscreen. Subtitles/Quality/Server moved to the top utility zone. -->
  <div class="bottom-zone">
    <!-- Round 50 — paused metadata card (approved concept): bottom-left,
         anchored to the bottom zone's TOP edge so it sits directly above
         the timeline row at every size. Renders only while PAUSED (and the
         chrome layer is visible — this component lives inside the chrome
         overlay, which owns the show/hide), with no sheet open and not
         locked; `safeDuration > 0` keeps it out of the initial load flash.
         The 4px white accent rule + title/meta/overview come straight from
         the shell's already-available metadata; the Resume pill reuses the
         EXISTING resume path (onResume) and hides when it is absent. -->
    {#if !playing && openSheet === null && !locked && safeDuration > 0 && (title || metaLine || overview)}
      <div class="paused-card">
        {#if title}<div class="paused-title">{title}</div>{/if}
        {#if metaLine}<div class="paused-meta">{metaLine}</div>{/if}
        {#if overview}<p class="paused-overview">{overview}</p>{/if}
        {#if onResume}
          <button class="resume-pill" type="button" aria-label={resumeLabel || 'Resume'} onclick={onResume}>
            <Play size={14} fill="currentColor" aria-hidden="true" />
            <span>{resumeLabel || 'Resume'}</span>
          </button>
        {/if}
      </div>
    {/if}
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
      <!-- LEFT group: Play/Pause + ±10 s seek buttons. -->
      <div class="left-controls">
        <button class="control-button play-inline" type="button" aria-label={playing ? 'Pause' : 'Play'} onclick={onTogglePlay}>
          {#if playing}<Pause size={18} strokeWidth={1.5} aria-hidden="true" />{:else}<Play size={18} fill="currentColor" aria-hidden="true" />{/if}
        </button>
        <button class="control-button seek-inline" type="button" aria-label="Seek backward 10 seconds" onclick={() => onStep(-10)}>
          <RotateCcwSquare size={18} strokeWidth={1.5} aria-hidden="true" />
        </button>
        <button class="control-button seek-inline" type="button" aria-label="Seek forward 10 seconds" onclick={() => onStep(10)}>
          <RotateCwSquare size={18} strokeWidth={1.5} aria-hidden="true" />
        </button>
      </div>
      <!-- RIGHT group: Volume, Audio, Speed, Fullscreen. -->
      <div class="right-controls">
        {#if !castActive}
          <div class="volume-control">
            <button class="control-button" type="button" aria-label={muted ? 'Unmute' : 'Mute'} onclick={onToggleMute}>
              {#if volumeIcon === 'muted'}<VolumeX size={18} strokeWidth={1.5} />{:else if volumeIcon === 'low'}<Volume1 size={18} strokeWidth={1.5} />{:else}<Volume2 size={18} strokeWidth={1.5} />{/if}
            </button>
            <input class="volume-input" type="range" min="0" max="1" step="0.05" value={muted ? 0 : volume} oninput={handleVolume} aria-label="Volume" style={`--volume-fill: ${volumeFillPercent}%;`} />
          </div>
          {#if audioMode === 'menu'}
            <button bind:this={audioAnchor} class="select-control audio sheet-trigger" class:open={openSheet === 'audio'} type="button" aria-label={`Audio track: ${audioButtonLabel}`} aria-haspopup="dialog" onclick={() => openMenu('audio')}>
              <AudioLines size={16} strokeWidth={1.5} aria-hidden="true" />
              <span class="chip-label">Audio</span>
              <span class="chip-value">{audioButtonLabel}</span>
            </button>
          {/if}
          <button bind:this={speedAnchor} class="select-control speed sheet-trigger" class:open={openSheet === 'speed'} type="button" aria-label={`Playback speed: ${playbackRate}×`} aria-haspopup="dialog" onclick={() => openMenu('speed')}>
            <Gauge size={16} strokeWidth={1.5} aria-hidden="true" />
            <span class="chip-label">{playbackRate}×</span>
          </button>
        {/if}
        <button class="control-button" type="button" aria-label={fullscreenActive ? 'Exit fullscreen' : 'Enter fullscreen'} aria-pressed={fullscreenActive} onclick={onFullscreen}>{#if fullscreenActive}<Minimize2 size={18} strokeWidth={1.5} />{:else}<Maximize2 size={18} strokeWidth={1.5} />{/if}</button>
      </div>
    </div>
  </div>

  <!-- In-player selection sheets (Issue 3): Mavero surfaces, rendered inside
       the control layer so they inherit its geometry (full-shell overlay). -->
  {#if openSheet === 'subtitles'}
    <PlayerSubtitleSheet tracks={subtitles} {selectedSubtitle} notice={subtitleNotice} prefs={subtitlePrefs} anchor={subtitlesAnchor ?? null} closing={sheetClosing} onSubtitle={(url) => { onSubtitle(url); closeMenu(); }} onPrefs={onSubtitlePreferences} onClose={closeMenu} />
  {/if}
  {#if openSheet === 'quality'}
    <PlayerOptionSheet title="Quality" anchor={qualityAnchor ?? null} closing={sheetClosing} onClose={closeMenu}>
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
  {#if openSheet === 'audio'}
    <PlayerOptionSheet title="Audio" anchor={audioAnchor ?? null} closing={sheetClosing} onClose={closeMenu}>
      <div class="option-list" role="group" aria-label="Audio track">
        {#each audioTracks as track (track.id)}
          <button class="option-row" class:selected={track.id === selectedAudioTrack} type="button" onclick={() => chooseAudioTrack(track.id)}>
            <span class="row-mark">{#if track.id === selectedAudioTrack}<Check size={15} />{/if}</span>
            <span class="row-copy"><strong>{audioTrackLabel(track)}</strong>{#if track.default}<small>Default</small>{/if}</span>
          </button>
        {/each}
      </div>
    </PlayerOptionSheet>
  {/if}
  {#if openSheet === 'servers'}
    <PlayerOptionSheet title="Server" anchor={serverAnchor ?? null} closing={sheetClosing} onClose={closeMenu}>
      <!-- Round 36 — two-pane: server group tabs (Vidsrc | Vidstream) +
           that group's source rows. Selecting a group filters the right
           pane; clicking a source starts that stream. -->
      {#if serverGroups.length > 1}
        <div class="server-group-tabs" role="tablist">
          <button class="server-group-tab" class:active={activeServerGroup === 'all'} type="button" onclick={() => (activeServerGroup = 'all')}>All</button>
          {#each serverGroups as group (group)}
            <button class="server-group-tab" class:active={activeServerGroup === group} type="button" onclick={() => (activeServerGroup = group)}>{group}</button>
          {/each}
        </div>
      {/if}
      <div class="option-list" role="group" aria-label="Playback server">
        {#each filteredServers as server (server.url)}
          <button class="option-row" class:selected={server.url === selectedServer} type="button" onclick={() => chooseServer(server.url)}>
            <span class="row-mark">{#if server.url === selectedServer}<Check size={15} />{/if}</span>
            <span class="row-copy">
              <strong>{server.label}</strong>
              {#if server.server}<small>{server.server}</small>{/if}
            </span>
          </button>
        {/each}
      </div>
    </PlayerOptionSheet>
  {/if}
  {#if openSheet === 'display'}
    <PlayerOptionSheet title="Display mode" anchor={displayAnchor ?? null} closing={sheetClosing} onClose={closeMenu}>
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
    <PlayerOptionSheet title="Playback speed" anchor={speedAnchor ?? null} closing={sheetClosing} onClose={closeMenu}>
      <div class="option-list" role="group" aria-label="Playback speed">
        {#each speedOptions as option (option.id)}
          <button class="option-row" class:selected={option.selected} type="button" onclick={() => chooseSpeed(option.id)}>
            <span class="row-mark">{#if option.selected}<Check size={15} strokeWidth={1.5} />{/if}</span>
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
     that miss every control reach the video surface (gestures/reveal).
     Round 50 — player-scope surface tokens (approved concept: white-only
     accent): s1/s2 surfaces, hairline, secondary/tertiary ink, radii, ease.
     Children (chips, buttons, sheets) inherit them. */
  .controls {
    position: absolute; inset: 0; z-index: 10; pointer-events: none; color: var(--ink);
    --pl-s1: rgba(255, 255, 255, 0.055);
    --pl-s2: rgba(255, 255, 255, 0.10);
    --pl-line: rgba(255, 255, 255, 0.12);
    --pl-ink-2: rgba(255, 255, 255, 0.72);
    --pl-ink-3: rgba(255, 255, 255, 0.50);
    --pl-r1: 12px;
    --pl-r2: 16px;
    --pl-ease: cubic-bezier(0.2, 0.8, 0.2, 1);
  }

  /* ---- Top-right utility zone ----
     Round 37 B — now holds Display Mode, Subtitles, Quality, Server, Cast,
     PiP, Lock. In portrait these must fit one row (360–430 px); the zone
     uses flex-wrap: nowrap and shrinks button size/gap. The select-control
     labels truncate so the row never overflows. */
  .utility-zone { position: absolute; z-index: 2; top: max(12px, env(safe-area-inset-top)); right: max(12px, env(safe-area-inset-right)); display: flex; align-items: center; flex-wrap: nowrap; gap: 8px; pointer-events: auto; max-width: calc(100vw - 24px); }

  /* 2026-10 round 20 — the center cluster + cluster-button CSS is REMOVED.
     Play/Pause moved to the bottom secondary row as .control-button.play-inline.
     The center overlay is gone — the bottom bar owns all playback controls. */

  /* ---- Bottom zone ---- */
  .bottom-zone { position: absolute; z-index: 2; bottom: 0; left: 0; right: 0; display: grid; gap: 4px; padding: 10px 14px calc(12px + env(safe-area-inset-bottom)); pointer-events: auto; background: linear-gradient(0deg, rgba(0,0,0,.62), rgba(0,0,0,.28) 62%, transparent); }

  /* Round 50 — header (approved concept, see markup comment above). */
  .header-zone {
    position: absolute;
    z-index: 2;
    top: calc(max(12px, env(safe-area-inset-top)) + 50px);
    left: max(16px, env(safe-area-inset-left));
    max-width: min(480px, calc(100vw - 32px));
    display: flex;
    flex-direction: column;
    gap: 2px;
    pointer-events: none;
  }
  .header-title { font-size: 20px; font-weight: 650; letter-spacing: -0.2px; line-height: 1.15; color: #fff; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-shadow: 0 2px 12px rgba(0,0,0,0.5); }
  .header-meta { font-size: 12.5px; color: var(--pl-ink-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-shadow: 0 1px 8px rgba(0,0,0,0.5); }
  @media (min-width: 1024px) {
    .header-zone { top: max(14px, env(safe-area-inset-top)); left: calc(max(12px, env(safe-area-inset-left)) + 47px); max-width: min(460px, 38vw); }
  }

  /* Round 50 — paused metadata card (approved concept): bottom-left over
     the video, directly above the timeline row, fading in with the chrome.
     Background-less (text + the 4px white accent rule on the bottom scrim)
     so the video stays visible — same chrome language as the rest. */
  .paused-card {
    position: absolute;
    left: 4px;
    bottom: calc(100% + 10px);
    z-index: 1;
    display: flex;
    flex-direction: column;
    gap: 4px;
    max-width: 520px;
    padding: 6px 16px 6px 14px;
    border-left: 4px solid #fff;
    animation: paused-card-in 140ms var(--pl-ease);
    pointer-events: auto;
  }
  .paused-title { font-size: 30px; font-weight: 650; letter-spacing: -0.3px; line-height: 1.12; color: #fff; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-shadow: 0 2px 14px rgba(0,0,0,0.5); }
  .paused-meta { font-size: 13px; color: var(--pl-ink-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-shadow: 0 1px 8px rgba(0,0,0,0.5); }
  .paused-overview { margin: 0; font-size: 13px; line-height: 1.45; color: rgba(255,255,255,0.62); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-shadow: 0 1px 8px rgba(0,0,0,0.5); }
  .resume-pill { display: inline-flex; align-items: center; gap: 7px; align-self: flex-start; height: 38px; margin-top: 6px; padding: 0 18px; border: 0; border-radius: 999px; color: #101013; background: #fff; font: inherit; font-size: 13px; font-weight: 650; cursor: pointer; box-shadow: 0 6px 22px rgba(0,0,0,0.4); transition: transform var(--motion-fast) var(--pl-ease), box-shadow var(--motion-fast) var(--pl-ease); }
  .resume-pill:hover, .resume-pill:focus-visible { transform: scale(1.02); box-shadow: 0 8px 26px rgba(0,0,0,0.5); }
  .resume-pill:active { transform: scale(.98); }
  @keyframes paused-card-in { from { opacity: 0; } to { opacity: 1; } }

  .timeline-row { display: flex; align-items: center; gap: 10px; }
  /* Round 50 — tabular 12px time labels: secondary ink left (position),
     tertiary ink right (duration — the row's last label, no markup change). */
  .time-label { color: var(--pl-ink-2); font-family: 'Inter', ui-sans-serif, system-ui, sans-serif; font-size: 12px; white-space: nowrap; font-variant-numeric: tabular-nums; }
  .timeline-row .time-label:last-child { color: var(--pl-ink-3); }
  .timeline-wrap { position: relative; flex: 1; min-width: 0; height: 22px; display: grid; align-items: center; }
  .timeline-track { position: absolute; right: 0; left: 0; height: 4px; overflow: hidden; border-radius: 2px; background: rgba(255,255,255,0.18); pointer-events: none; }
  .timeline-buffered, .timeline-progress { position: absolute; inset: 0 auto 0 0; border-radius: inherit; }
  .timeline-buffered { background: rgba(255,255,255,0.34); }
  .timeline-progress { background: #fff; }
  .timeline-input { position: relative; z-index: 2; width: 100%; height: 22px; margin: 0; appearance: none; cursor: pointer; background: transparent; }
  .timeline-input::-webkit-slider-runnable-track { height: 4px; background: transparent; }
  .timeline-input::-webkit-slider-thumb { width: 14px; height: 14px; margin-top: -5px; appearance: none; border: 0; border-radius: 50%; background: #fff; box-shadow: 0 0 0 3px rgba(0,0,0,0.35), 0 0 12px rgba(255,255,255,0.35); }
  .timeline-input::-moz-range-track { height: 4px; background: transparent; }
  .timeline-input::-moz-range-thumb { width: 14px; height: 14px; border: 0; border-radius: 50%; background: #fff; box-shadow: 0 0 0 3px rgba(0,0,0,0.35), 0 0 12px rgba(255,255,255,0.35); }

  /* Secondary row: LEFT group (Play/Pause, ±10s) + RIGHT group (Volume,
     Subtitles, Quality, Audio, Speed, Fullscreen) using space-between.
     2026-10 round 25 — portrait uses nowrap (single row) with 8px gap.
     The right group packs tightly with flex-shrink on labels so everything
     fits on one line. Touch targets remain 36px+ minimum. */
  .secondary-row { display: flex; align-items: center; flex-wrap: nowrap; justify-content: space-between; gap: 8px; }
  .left-controls { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
  .right-controls { display: flex; align-items: center; flex-wrap: nowrap; gap: 8px; justify-content: flex-end; min-width: 0; }
  /* Round 50 — bottom-row buttons: 40px hit area, radius 12, transparent
     until hover (then the s1 surface); no per-button blur (the popover
     surface carries the single blur layer). */
  .control-button { display: inline-grid; place-items: center; min-width: 40px; min-height: 40px; border: 1px solid transparent; border-radius: var(--pl-r1); color: rgba(255,255,255,0.88); background: transparent; cursor: pointer; transition: background var(--motion-fast) var(--pl-ease), color var(--motion-fast) var(--pl-ease), transform var(--motion-fast) var(--pl-ease); }
  .control-button:hover, .control-button:focus-visible { background: var(--pl-s1); color: #fff; }
  .control-button:active { transform: scale(.97); }
  /* Round 50 — icon-only utility buttons (display, cast, PiP, lock): 40px
     rounded squares on the chip surface tokens, icon 17px. */
  .utility-zone .control-button { width: 40px; min-width: 40px; height: 40px; border-color: var(--pl-line); background: var(--pl-s1); }
  .utility-zone .control-button:hover, .utility-zone .control-button:focus-visible { background: var(--pl-s2); border-color: rgba(255,255,255,0.2); color: #fff; }
  /* 2026-10 round 19 — inline ±10 s seek buttons in the secondary row. */
  .control-button.seek-inline { color: var(--ink-soft); }
  /* 2026-10 round 20 — inline Play/Pause button in the secondary row. */
  .control-button.play-inline { color: var(--ink-soft); }
  .volume-control { display: flex; align-items: center; gap: 4px; }
  /* Round 50 — volume slider: 4px hairline track with a white filled portion
     and a 5.5px white thumb (the existing input, styled per-engine). */
  .volume-input { width: 78px; height: 22px; margin: 0; appearance: none; background: transparent; cursor: pointer; }
  .volume-input::-webkit-slider-runnable-track { height: 4px; border-radius: 2px; background: linear-gradient(90deg, #fff var(--volume-fill, 100%), rgba(255,255,255,0.18) var(--volume-fill, 100%)); }
  .volume-input::-webkit-slider-thumb { width: 5.5px; height: 5.5px; margin-top: -0.75px; appearance: none; border: 0; border-radius: 50%; background: #fff; }
  .volume-input::-moz-range-track { height: 4px; border-radius: 2px; background: rgba(255,255,255,0.18); }
  .volume-input::-moz-range-progress { height: 4px; border-radius: 2px; background: #fff; }
  .volume-input::-moz-range-thumb { width: 5.5px; height: 5.5px; border: 0; border-radius: 50%; background: #fff; }
  /* Round 50 — CHIPS: every select-control is a chip (s1 surface, hairline
     border, 13px/600 label + 12.5px tertiary value). The label/value text
     derives from the EXISTING aria-label text — nothing is invented. Speed
     has no separate value (single “1×” label). Truncation keeps the top and
     bottom rows ONE line at every width (round 37 B). */
  .select-control { display: inline-flex; align-items: center; gap: 8px; height: 40px; max-width: 180px; padding: 0 14px; border: 1px solid var(--pl-line); border-radius: 13px; color: #fff; background: var(--pl-s1); cursor: pointer; font: inherit; transition: background var(--motion-fast) var(--pl-ease), border-color var(--motion-fast) var(--pl-ease); }
  .select-control:hover:not(:disabled), .select-control:focus-visible, .select-control.open { background: var(--pl-s2); border-color: rgba(255,255,255,0.2); }
  .select-control:disabled { opacity: .6; cursor: default; }
  .select-control .chip-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; font-weight: 600; }
  .select-control .chip-value { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12.5px; color: var(--pl-ink-3); }
  .select-control .chip-label, .select-control .chip-value { flex: 0 1 auto; }
  .select-control.quality .chip-value { max-width: 64px; }
  .select-control.server .chip-value { max-width: 64px; }
  .select-control.speed .chip-label { max-width: 44px; }

  /* In-player selection sheet option rows (shared shape across quality /
     display / speed sheets; the subtitle sheet carries its own richer
     controls). */
  .option-list { display: grid; gap: 3px; }
  .option-row { display: flex; align-items: center; gap: 11px; min-height: 46px; border: 1px solid transparent; border-radius: var(--radius-sm); padding: 7px 12px; color: var(--ink-soft); background: transparent; cursor: pointer; text-align: left; font: inherit; }
  .option-row:hover, .option-row:focus-visible, .option-row.selected { border-color: var(--line-strong); background: var(--accent-soft); }
  .option-row.selected { color: var(--ink); }
  .row-mark { display: grid; flex: 0 0 22px; place-items: center; width: 22px; height: 22px; color: var(--muted); }
  .option-row.selected .row-mark { border: 1px solid var(--line-strong); border-radius: 50%; color: var(--accent); }
  /* Round 36 — server group tabs (Vidsrc | Vidstream) */
  .server-group-tabs { display: flex; gap: 4px; padding: 4px; margin-bottom: 8px; border-bottom: 1px solid var(--line-soft); }
  .server-group-tab { flex: 1 1 auto; min-height: 36px; padding: 6px 12px; border: 1px solid transparent; border-radius: var(--radius-sm); color: var(--ink-soft); background: transparent; font: inherit; font-size: .72rem; font-weight: 700; cursor: pointer; text-align: center; }
  .server-group-tab:hover, .server-group-tab:focus-visible { border-color: var(--line-strong); background: var(--accent-soft); }
  .server-group-tab.active { color: var(--ink); border-color: var(--accent); background: var(--accent-soft); }
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
  /* Round 50 — ≥900px chips/utility squares grow to 44px (comfortable
     desktop/TV hit area). */
  @media (min-width: 900px) {
    .select-control { height: 44px; }
    .utility-zone .control-button { width: 44px; min-width: 44px; height: 44px; }
  }
  /* Round 37 B — portrait (360–430 px): shrink the utility-zone + bottom-row
     buttons so both rows stay on ONE line. Round 50 — the chips keep the new
     chip surface but DROP the chip LABEL (the icon + value carry exactly the
     state text the old control-label carried, so the row fits portrait
     exactly as before); the values keep truncating so long names never
     expand the row. Touch targets stay 32px+ minimum. */
  @media (max-width: 640px) {
    .bottom-zone { padding: 8px 8px calc(10px + env(safe-area-inset-bottom)); }
    .secondary-row { gap: 6px; }
    .left-controls { gap: 6px; }
    .right-controls { gap: 4px; }
    .utility-zone { gap: 4px; max-width: calc(100vw - 16px); }
    .time-label { font-size: 11px; }
    .select-control { height: 36px; padding: 0 10px; gap: 6px; }
    .select-control .chip-label { display: none; }
    .select-control .chip-value { font-size: 12px; }
    .select-control.subtitles { max-width: 80px; }
    .select-control.quality { max-width: 72px; }
    .select-control.server { max-width: 72px; }
    .select-control.audio { max-width: 72px; }
    .control-button { min-width: 32px; min-height: 32px; }
    .utility-zone .control-button { width: 32px; min-width: 32px; height: 32px; }
    /* Round 50 — the paused card spans 82vw on mobile (still directly above
       the timeline row). */
    .paused-card { max-width: 82vw; padding: 4px 10px 4px 10px; }
    .paused-title { font-size: 24px; }
  }
  @media (prefers-reduced-motion: reduce) { .control-button { transition: none; } .select-control { transition: none; } .paused-card { animation: none; } }
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
    .secondary-row { flex-wrap: nowrap; gap: 5px; }
    .right-controls { flex-wrap: nowrap; }
    .select-control.subtitles { flex: 0 1 auto; }
  }
  /* Landscape phone: compact the bottom zone. */
  @media (orientation: landscape) and (max-height: 500px) {
    .bottom-zone { padding: 6px 12px calc(8px + env(safe-area-inset-bottom)); }
  }
</style>
