<script lang="ts">
  // Player V2 corrections (real-device feedback): the approved wireframe
  // layout. The control surface is a THREE-ZONE overlay on the player shell:
  //   * TOP-RIGHT utility zone  — Subtitles, Quality, Server, Cast, PiP, Lock
  //     (round 37 B moved Subtitles/Quality/Server here; round 51 moved the
  //     display-mode control DOWN into the bottom row's right group). Cast
  //     renders only when the shell's eligibility gates passed; PiP only
  //     when the browser supports it.
  //   * CENTER cluster          — [−10 s] [Play/Pause] [+10 s] centered on the
  //     VIDEO VIEWPORT (absolute center of the shell), Play/Pause dominant.
  //     Seek icons are the recognizable RotateCcwSquare/RotateCwSquare pair
  //     with the 10-second count overlaid (replaces the ambiguous chevrons).
  //   * BOTTOM zone             — time + duration, the seek bar, and the
  //     secondary row: LEFT group Play/Pause, ±10 s and volume (icon +
  //     slider, moved to the left group in round 51); RIGHT group audio
  //     (when the engine exposes tracks), display mode (Fit/Fill/Stretch,
  //     moved down in round 51), speed (single label — no "1× 1×") and
  //     fullscreen/landscape. Both rows stay ONE line in portrait; the
  //     quality control is NEVER hidden on phones.
  //   * PAUSED (round 51)       — while !playing NONE of the zones above
  //     render: the paused metadata card (bottom-left) is the ONLY chrome.
  //     While paused there is NO scrubber and no play row — the Resume
  //     pill is the way back (intended consequence).
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
  import { onDestroy, onMount } from 'svelte';
  import type { PlayerAudioTrackOption, PlayerInternalQualityOption, PlayerQualityOption, PlayerServerOption, PlayerSubtitleTrack } from '$lib/shared/player';
  import { formatPlayerTime, playbackSpeeds, PLAYER_AUTO_QUALITY_ID } from '$lib/shared/player';
  import PlayerOptionSheet from './PlayerOptionSheet.svelte';
  import PlayerSubtitleSheet from './PlayerSubtitleSheet.svelte';
  import PlayerUpNextCard from './PlayerUpNextCard.svelte';
  import { DEFAULT_SUBTITLE_PREFERENCES, type SubtitlePreferences } from '$lib/client/player/subtitles/subtitle-preferences';

  export let playing = false;
  // Round 52 (F1) — the SETTLED-pause derivation (see the derivation block
  // under the sheet state below, where `openSheet` is in scope). A quality/
  // audio/server switch re-prepares the stream and the engine reload briefly
  // fires a `pause` event while the stream keeps playing; presenting
  // "paused" on the raw `!playing` flag made the paused card flash up on
  // every switch. The paused zone and the C1 "paused = card only" chrome
  // hiding below are gated on `pausedSettled` instead of raw `!playing`.
  let pausedSettled = false;
  /** Round 52 (F1): a pause must persist this long before it is "settled". */
  const PAUSE_SETTLE_MS = 400;
  /** Round 52 (F1): the shell's source/quality/audio/server switching flag (its loading-card condition, passed as-is). */
  export let switching = false;
  // Round 53 (F2) — the shell's live gesture flag (the swipe/wheel indicator
  // or the 2× hold). Hover-to-open sheets stand down while ANY gesture is
  // active — the pointer belongs to the gesture, not to the chips.
  export let gestureActive = false;
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
  /** Meta line under the header title — movies: year · genres · runtime;
   *  series (round 51, Phase 3): S<n> · E<m> · <episode title>. */
  export let metaLine = '';
  /** One-line overview for the paused metadata card. */
  export let overview = '';
  /** Paused-card Resume pill label (e.g. “Resume 42:15”). */
  export let resumeLabel = '';
  /** The existing resume path (the shell's togglePlay). Absent → no pill. */
  export let onResume: (() => void) | null = null;
  // Round 51 (approved concept, Phase 3 — series context): the paused
  // Up-next card. `upNext` is the episode AFTER the current one, exactly as
  // the shell's EXISTING episode data holds it (no new fetching, nothing
  // invented); null hides the card. `onUpNext` switches to that episode via
  // the shell's EXISTING episode-change path; absent → no Play button.
  export let upNext: { still: string; title: string; season: number; episode: number } | null = null;
  export let onUpNext: (() => void) | null = null;
  // Round 52 (F4) — the AUTO Up-next card: while PLAYING a series episode
  // with a next episode, when the remaining playback drops to
  // UP_NEXT_REMAINING_S or less, the same card that shows while paused
  // slides in on its own at the bottom-right (variant="auto" — a floating
  // overlay above the bottom bar, it never shifts the timeline). Seeking
  // back above the threshold hides it again; a sheet being open or the lock
  // hides it; movies never have a next episode so they never see it. While
  // paused the card keeps showing exactly as before (the paused zone's
  // zone-variant instance).
  const UP_NEXT_REMAINING_S = 180;
  $: upNextAutoOpen = playing && upNext !== null && openSheet === null && !locked && safeDuration > 0 && safeDuration - currentTime <= UP_NEXT_REMAINING_S;

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
  // Round 53 (F2) — HOVER-TO-OPEN SHEETS (desktop only, see the hover block
  // below). `sheetOpenedByHover` marks a sheet the POINTER opened (120ms
  // hover on a chip): only such a sheet auto-closes when the pointer leaves
  // BOTH the trigger and the panel (200ms) — a CLICK-opened sheet keeps the
  // exact click semantics it always had (outside click / Escape / selection).
  let sheetOpenedByHover = false;
  function openMenu(kind: 'subtitles' | 'quality' | 'audio' | 'servers' | 'speed' | 'display', viaHover = false) {
    if (sheetCloseTimer) {
      clearTimeout(sheetCloseTimer);
      sheetCloseTimer = undefined;
    }
    // Round 56 (H1) — no pending hover close may outlive an open, and the
    // geometry close watch belongs to HOVER-opened sheets ONLY: a
    // click-opened sheet keeps the exact click semantics it always had.
    if (hoverCloseTimer) {
      clearTimeout(hoverCloseTimer);
      hoverCloseTimer = undefined;
    }
    sheetClosing = false;
    openSheet = kind;
    sheetOpenedByHover = viaHover;
    if (viaHover) startHoverCloseWatch(); else stopHoverCloseWatch();
    onMenuOpenChange(true);
  }
  function closeMenu() {
    if (openSheet === null || sheetClosing) return;
    if (sheetCloseTimer) clearTimeout(sheetCloseTimer);
    // Round 56 (H1) — no hover close may outlive a close.
    if (hoverCloseTimer) {
      clearTimeout(hoverCloseTimer);
      hoverCloseTimer = undefined;
    }
    sheetClosing = true;
    const reduced = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    sheetCloseTimer = setTimeout(() => {
      sheetCloseTimer = undefined;
      openSheet = null;
      sheetClosing = false;
      sheetOpenedByHover = false;
      // Round 56 (H1) — the geometry close watch (and its window listener)
      // dies with the sheet.
      stopHoverCloseWatch();
      onMenuOpenChange(false);
    }, reduced ? 0 : 90);
  }

  // ----- Round 53 (F2) / Round 56 (H1): HOVER-TO-OPEN SHEETS (desktop only) -----
  //
  // On `(hover: hover) and (pointer: fine)` devices ONLY: pointing at a chip
  // that opens a sheet (Subtitles, Quality, Server, Audio, Speed, Display)
  // opens that sheet after a 120ms hover delay; a hover-opened sheet closes
  // 220ms after the pointer leaves BOTH the trigger chip and the open panel.
  //
  // Round 56 (H1) — the CLOSE side is GEOMETRY, not DOM ancestry. The old
  // pointerout/relatedTarget zone broke the moment a popover opened: the
  // popover's full-surface click-catcher (.option-sheet-overlay,
  // pointer-events:auto, z-index 20) sits ON TOP of the chip, so pointerout
  // fired with relatedTarget = the overlay (outside the DOM zone) → 200ms
  // close → the sheet unmounted → the pointer was suddenly over the chip
  // again → reopen → an open/close flicker loop, and the 10px chip→panel gap
  // counted as "outside" too. While a hover-opened sheet is on screen, a
  // window-level `pointermove` listener now tests the pointer against the
  // trigger chip's rect and the open panel's rect (getBoundingClientRect),
  // each inflated by 8px (the gap counts as inside):
  //   * inside  → the pending close timer is cleared (chip → panel transit
  //               keeps the sheet open);
  //   * outside → the 220ms close timer starts — ONLY if it is not already
  //               running, so it fires 220ms after the pointer FIRST leaves.
  // The overlay no longer influences hover AT ALL (it never matches a rect;
  // it still handles click-outside dismissal on its own), so:
  //   * hovering a chip opens the sheet and it STAYS open (no flicker loop);
  //   * moving into the panel keeps it open and its options stay clickable;
  //   * moving anywhere else closes it after ~220ms;
  //   * CLICK still works on every device (touch and mouse) with the exact
  //     semantics it always had — a CLICK-opened sheet does NOT auto-close
  //     on pointer leave (sheetOpenedByHover gates the geometry close);
  //   * keyboard focus + Enter keeps working (the chips stay real buttons);
  //   * exactly ONE sheet is open at a time (openMenu is the single writer);
  //   * hover-open NEVER fires while a gesture is active (gestureActive),
  //     while the controls are locked, on touch devices, or mid-close;
  //   * every hover listener/timer is removed on destroy and whenever the
  //     sheet closes (and when hover capability disappears mid-session).
  let hoverCapable = false;
  let hoverOpenTimer: ReturnType<typeof setTimeout> | undefined = undefined;
  let hoverCloseTimer: ReturnType<typeof setTimeout> | undefined = undefined;
  let hoverMediaQuery: MediaQueryList | undefined;
  let hoverMediaListener: ((event: MediaQueryListEvent) => void) | undefined;
  let hoverMoveDetach: (() => void) | undefined = undefined;
  const HOVER_OPEN_DELAY_MS = 120;
  const HOVER_CLOSE_DELAY_MS = 220;
  const HOVER_RECT_INFLATE_PX = 8;

  function clearHoverTimers() {
    if (hoverOpenTimer) {
      clearTimeout(hoverOpenTimer);
      hoverOpenTimer = undefined;
    }
    if (hoverCloseTimer) {
      clearTimeout(hoverCloseTimer);
      hoverCloseTimer = undefined;
    }
  }

  function hoverOpenAllowed(): boolean {
    return hoverCapable && !locked && !gestureActive && !sheetClosing;
  }

  /** Round 56 (H1) — DOM matching is used ONLY for the OPEN trigger: the
   *  `.sheet-trigger` chip under a pointer target (null anywhere else). */
  function sheetTriggerTarget(target: EventTarget | null): HTMLElement | null {
    if (typeof Element === 'undefined' || !(target instanceof Element)) return null;
    const trigger = target.closest('.sheet-trigger');
    return trigger instanceof HTMLElement ? trigger : null;
  }

  function handleHoverOver(event: PointerEvent | MouseEvent) {
    if (!hoverOpenAllowed()) return;
    const trigger = sheetTriggerTarget(event.target);
    if (!trigger) return;
    const kind = trigger.dataset.sheet as 'subtitles' | 'quality' | 'audio' | 'servers' | 'speed' | 'display' | undefined;
    if (!kind) return;
    if (hoverOpenTimer) clearTimeout(hoverOpenTimer);
    hoverOpenTimer = setTimeout(() => {
      hoverOpenTimer = undefined;
      if (!hoverOpenAllowed()) return;
      openMenu(kind, true);
    }, HOVER_OPEN_DELAY_MS);
  }

  /** Round 56 (H1) — the open sheet's trigger chip (the anchor the popover
   *  attached to): the geometry zone's first rect. */
  function openSheetTriggerChip(): HTMLElement | null {
    switch (openSheet) {
      case 'subtitles': return subtitlesAnchor ?? null;
      case 'quality': return qualityAnchor ?? null;
      case 'audio': return audioAnchor ?? null;
      case 'servers': return serverAnchor ?? null;
      case 'speed': return speedAnchor ?? null;
      case 'display': return displayAnchor ?? null;
      default: return null;
    }
  }

  /** Round 56 (H1) — the open sheet's panel element (`.player-option-sheet`):
   *  the geometry zone's second rect. */
  function openSheetPanel(): Element | null {
    if (typeof document === 'undefined' || typeof document.querySelector !== 'function') return null;
    return document.querySelector('.player-option-sheet');
  }

  /** Round 56 (H1) — the geometry zone test: the point against an element's
   *  rect, inflated by HOVER_RECT_INFLATE_PX on every side. */
  function pointInRect(x: number, y: number, element: Element | null | undefined): boolean {
    if (!element || typeof element.getBoundingClientRect !== 'function') return false;
    const rect = element.getBoundingClientRect();
    return x >= rect.left - HOVER_RECT_INFLATE_PX
      && x <= rect.right + HOVER_RECT_INFLATE_PX
      && y >= rect.top - HOVER_RECT_INFLATE_PX
      && y <= rect.bottom + HOVER_RECT_INFLATE_PX;
  }

  /** Round 56 (H1) — while a HOVER-opened sheet is on screen, watch
   *  `pointermove` on window (desktop only): outside BOTH inflated rects
   *  (trigger chip + open panel) for HOVER_CLOSE_DELAY_MS closes the sheet;
   *  inside clears the pending close. An already-running close timer is
   *  never restarted, so it fires 220ms after the pointer FIRST leaves the
   *  zone. The window listener is removed on destroy, whenever the sheet
   *  closes, and whenever a CLICK-opened sheet replaces a hover-opened one. */
  function startHoverCloseWatch() {
    if (hoverMoveDetach || typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
    const onMove = (event: PointerEvent) => {
      if (openSheet === null || !sheetOpenedByHover || sheetClosing) return;
      const inside = pointInRect(event.clientX, event.clientY, openSheetTriggerChip())
        || pointInRect(event.clientX, event.clientY, openSheetPanel());
      if (inside) {
        if (hoverCloseTimer) {
          clearTimeout(hoverCloseTimer);
          hoverCloseTimer = undefined;
        }
        return;
      }
      if (!hoverCloseTimer) {
        hoverCloseTimer = setTimeout(() => {
          hoverCloseTimer = undefined;
          if (openSheet !== null && sheetOpenedByHover) closeMenu();
        }, HOVER_CLOSE_DELAY_MS);
      }
    };
    window.addEventListener('pointermove', onMove, true);
    hoverMoveDetach = () => {
      try { window.removeEventListener('pointermove', onMove, true); } catch { /* already removed */ }
    };
  }

  function stopHoverCloseWatch() {
    if (!hoverMoveDetach) return;
    hoverMoveDetach();
    hoverMoveDetach = undefined;
  }

  onMount(() => {
    if (typeof window !== 'undefined' && window.matchMedia) {
      hoverMediaQuery = window.matchMedia('(hover: hover) and (pointer: fine)');
      hoverCapable = hoverMediaQuery.matches;
      hoverMediaListener = (event: MediaQueryListEvent) => {
        hoverCapable = event.matches;
        if (!hoverCapable) {
          clearHoverTimers();
          stopHoverCloseWatch();
        }
      };
      hoverMediaQuery.addEventListener('change', hoverMediaListener);
    }
  });
  onDestroy(() => {
    clearHoverTimers();
    stopHoverCloseWatch();
    if (hoverMediaQuery && hoverMediaListener) {
      try { hoverMediaQuery.removeEventListener('change', hoverMediaListener); } catch { /* already removed */ }
      hoverMediaQuery = undefined;
      hoverMediaListener = undefined;
    }
  });

  // ----- Round 52 (F1): the SETTLED-pause derivation -----
  //
  // `pausedSettled` is true ONLY when ALL of the following hold:
  //   * `!playing` has been CONTINUOUSLY true for PAUSE_SETTLE_MS (400 ms) —
  //     the transient pause a quality/audio/server engine reload fires can
  //     never cross it;
  //   * no selection sheet is open (`openSheet === null`);
  //   * the shell is NOT switching sources/qualities/audios/servers (the
  //     `switching` prop — the shell passes the exact flag that drives its
  //     loading card, no second state machine).
  // The timer is set/cleared by the reactive statement and cleared in
  // onDestroy; pressing play clears the flag IMMEDIATELY (no delay). While
  // playing (including during a quality switch) the normal chrome stays —
  // the settled card appears only after a real, settled pause.
  let pausedSettleTimer: ReturnType<typeof setTimeout> | undefined;
  $: {
    if (!playing && openSheet === null && !switching) {
      if (!pausedSettled && pausedSettleTimer === undefined) {
        pausedSettleTimer = setTimeout(() => {
          pausedSettleTimer = undefined;
          // Re-check every condition at fire time — the reactive statement
          // clears the timer first on any change, but this guard keeps the
          // flag honest even if a state landed between flushes.
          if (!playing && openSheet === null && !switching) pausedSettled = true;
        }, PAUSE_SETTLE_MS);
      }
    } else if (pausedSettled || pausedSettleTimer !== undefined) {
      if (pausedSettleTimer !== undefined) {
        clearTimeout(pausedSettleTimer);
        pausedSettleTimer = undefined;
      }
      pausedSettled = false;
    }
  }
  onDestroy(() => {
    if (pausedSettleTimer !== undefined) clearTimeout(pausedSettleTimer);
  });

  $: safeDuration = Number.isFinite(duration) && duration > 0 ? duration : 0;
  // Round 53 (F6) — the RIGHT time label toggles TOTAL ↔ REMAINING. The
  // default shows the total duration exactly as before; clicking flips to
  // "−MM:SS" (duration − currentTime), clicking again flips back. Session-only
  // local state (no persistence); the LEFT (elapsed) label is unchanged.
  let durationMode: 'total' | 'remaining' = 'total';
  function toggleDurationMode() {
    durationMode = durationMode === 'total' ? 'remaining' : 'total';
  }
  $: durationLabelText = durationMode === 'remaining' && safeDuration > 0
    ? `−${formatPlayerTime(Math.max(0, safeDuration - currentTime))}`
    : formatPlayerTime(safeDuration);
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

<div class="controls" class:casting={castActive} role="group" onpointerover={handleHoverOver} aria-label="Playback controls">
  <!-- Round 50 — header (approved concept): title + meta line, TOP-LEFT of
       the utility-zone strip, before the right-aligned chips. The Back FAB
       keeps its own top-left spot: below 1024px the header sits just under
       the FAB line so it can never collide with the right-aligned chip row
       (the round 37 B one-line top row is untouched); ≥1024px it shares the
       FAB's line. Renders nothing when both strings are empty.
       Round 52 (F1) — the gate is `!pausedSettled` (not raw `playing`): the
       chrome (header included) stays up during a quality/audio/server
       switch (a transient pause), and steps aside only for a real, SETTLED
       pause. -->
  {#if !pausedSettled && (title || metaLine)}
    <div class="header-zone" aria-hidden="true">
      {#if title}<div class="header-title">{title}</div>{/if}
      {#if metaLine}<div class="header-meta">{metaLine}</div>{/if}
    </div>
  {/if}
  <!-- Round 51 — PAUSED ZONE (approved-concept fix C1): while PAUSED the
       paused metadata card is the ONLY chrome — the utility zone, the header
       title block, the timeline row and the secondary control row are all
       gated on `!pausedSettled` below, so the card never competes with them.
       Round 52 (F1) — the zone and the C1 chrome hiding are gated on
       `pausedSettled` (a SETTLED pause: !playing held continuously for
       400 ms, no sheet open, not switching) instead of raw `!playing`, so a
       quality/audio/server switch (whose engine reload briefly fires a
       pause event) can never flash the card or strip the chrome — the card
       appears only after a real, settled pause, and pressing play brings the
       chrome back IMMEDIATELY (no delay).
       While paused there is no scrubber — the Resume pill is the way back.
       The zone itself is pointer-transparent (only the cards re-enable
       pointer events), so a tap on the empty area still reaches the video
       and — round 52 (F5) — toggles playback through the shell's new
       single-tap gesture (play and hide the cards immediately).
       The zone's TOP edge sits below the native back chip (back FAB bottom
       edge + 12px) so the card can never collide with the back affordance
       in portrait, and every card additionally caps at the zone height as a
       hard guard. Renders only while settled-paused and not locked;
       `safeDuration > 0` keeps it out of the initial load flash. The 4px
       white accent rule + title/meta/overview come straight from the
       shell's already-available metadata; the Resume pill reuses the
       EXISTING resume path (onResume) and hides when it is absent. -->
  {#if pausedSettled && !locked && safeDuration > 0 && ((title || metaLine || overview) || upNext)}
    <div class="paused-zone">
      <!-- Round 51 (Phase 3 — series context): the Up-next card — FIRST in
           the DOM so the portrait column-reverse stack puts it ABOVE the
           metadata card; on desktop it anchors to the zone's BOTTOM-RIGHT
           (mirroring the metadata card). Hidden when there is no next
           episode, a sheet is open, or the player is locked. Round 52 (F4):
           the SAME card now lives in PlayerUpNextCard.svelte (the zone
           variant anchors here; the auto variant shows near the end while
           playing — see the instance below the zones). The 16:9 still is a
           fixed aspect box (no CLS; lazy); a missing still renders nothing —
           never fabricated. -->
      {#if upNext}
        <PlayerUpNextCard {upNext} onUpNext={onUpNext} />
      {/if}
      {#if title || metaLine || overview}
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
    </div>
  {/if}

  <!-- TOP-RIGHT utility zone: Subtitles, Quality, Server, Cast, Lock.
       Round 37 B — Subtitles/Quality/Server moved here from the bottom row so
       the bottom row fits a 360–430 px portrait width without wrapping.
       Round 51 — the display-mode control moved DOWN into the bottom row's
       right group (before Speed); in portrait the zone carries a 56px left
       inset so it can never slide behind the native back chip.
       Round 52 (F2) — PiP moved DOWN into the bottom row's right group as
       well (immediately LEFT of Fullscreen) so the utility row fits a 360 px
       portrait width entirely on screen; the zone keeps exactly Subtitles,
       Quality, Server, Cast, Lock (and nothing else). The gate is
       `!pausedSettled` (round 52 F1): the normal chrome stays up during a
       quality/audio/server switch and steps aside only for a settled pause. -->
  {#if !pausedSettled}
  <div class="utility-zone">
    {#if !castActive}
      <button bind:this={subtitlesAnchor} class="select-control subtitles sheet-trigger" data-sheet="subtitles" class:open={openSheet === 'subtitles'} type="button" aria-label={`Subtitles: ${subtitleButtonLabel}${subtitleNotice ? ` (${subtitleNotice})` : ''}`} aria-haspopup="dialog" title={subtitleNotice || undefined} onclick={() => openMenu('subtitles')}>
        <Captions size={16} strokeWidth={1.5} aria-hidden="true" />
        <span class="chip-label">Subtitles</span>
        <span class="chip-value">{subtitleButtonLabel}</span>
      </button>
      {#if qualityMode !== 'none'}
        <button bind:this={qualityAnchor} class="select-control quality sheet-trigger" data-sheet="quality" class:open={openSheet === 'quality'} type="button" aria-label={`Playback quality: ${qualityButtonLabel}`} aria-haspopup="dialog" onclick={() => openMenu('quality')}>
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
        <button bind:this={serverAnchor} class="select-control server sheet-trigger" data-sheet="servers" class:open={openSheet === 'servers'} type="button" aria-label={`Server: ${serverButtonLabel}`} aria-haspopup="dialog" onclick={() => openMenu('servers')}>
          <Server size={16} strokeWidth={1.5} aria-hidden="true" />
          <span class="chip-label">Server</span>
          <span class="chip-value">{serverButtonLabel}</span>
        </button>
      {/if}
    {/if}
    {#if castAvailable}
      <button class="control-button cast-button" class:casting={castActive} type="button" aria-label={castActive ? 'Disconnect cast session' : 'Cast to a device'} aria-pressed={castActive} onclick={onCast}><Cast size={17} strokeWidth={1.5} /></button>
    {/if}
    <button class="control-button lock-button" type="button" aria-label={locked ? 'Unlock player controls' : 'Lock player controls'} aria-pressed={locked} onclick={onToggleLock}>{#if locked}<LockOpen size={17} strokeWidth={1.5} />{:else}<Lock size={17} strokeWidth={1.5} />{/if}</button>
  </div>
  {/if}

  <!-- BOTTOM zone: time + timeline, then the control row.
       Round 37 B — the bottom row keeps only Play/Pause, ±10s, Volume, Speed,
       Fullscreen. Subtitles/Quality/Server moved to the top utility zone.
       Round 51 — the whole zone is {#if playing}-gated (paused = card only)
       and the groups swapped members: volume joined the LEFT group (after
       +10) and display mode joined the RIGHT group (before Speed).
       Round 52 (F1) — the gate is `!pausedSettled` (the chrome stays during a
       quality/audio/server switch; card-only only after a settled pause).
       Round 52 (F2) — PiP moved into the RIGHT group, immediately LEFT of
       Fullscreen (order: Volume · Audio · Display-mode · Speed · PiP ·
       Fullscreen) so the top utility row fits 360 px portrait. -->
  {#if !pausedSettled}
  <div class="bottom-zone">
    <!-- Round 51 (Phase 4 — scrubber detail): 2px chapter ticks would render
         above the track ONLY when chapter marks are available from the shell;
         the shell exposes NO chapter marks (its timeline data is only the
         buffered/progress playhead), so NOTHING is rendered here — no
         fabricated ticks. -->
    <div class="timeline-row">
      <span class="time-label" aria-live="off">{formatPlayerTime(currentTime)}</span>
      <div class="timeline-wrap">
        <div class="timeline-track" aria-hidden="true">
          <span class="timeline-buffered" style={`width: ${bufferedPercent}%`}></span>
          <span class="timeline-progress" style={`width: ${progressPercent}%`}></span>
        </div>
        <input class="timeline-input" type="range" min="0" max={safeDuration} step="0.1" value={currentTime} oninput={handleSeek} aria-label="Seek playback" />
      </div>
      <!-- Round 53 (F6) — the RIGHT time label is a real toggle button: total
           duration (default, exactly as before) ↔ remaining time ("−MM:SS" =
           duration − currentTime). aria-pressed carries the mode; the label
           describes the toggle. Session-only state; the left label is
           unchanged. -->
      <button class="time-label duration-toggle" type="button" aria-pressed={durationMode === 'remaining'} aria-label={durationMode === 'total' ? 'Show remaining time' : 'Show total duration'} onclick={toggleDurationMode}>{durationLabelText}</button>
    </div>

    <div class="secondary-row">
      <!-- LEFT group — Round 53 (F5): −10 s, PLAY/PAUSE, +10 s, Volume (icon +
           slider): Play/Pause moves BETWEEN the two seek buttons. Round 53
           (F3): the play button carries aria-keyshortcuts="Space" and the two
           seek buttons "ArrowLeft"/"ArrowRight" (the shell's existing keyboard
           shortcuts — Space/K toggle, ←/→ step ±10 s — already drive them).
           Same aria-labels and handlers as before. -->
      <div class="left-controls">
        <button class="control-button seek-inline" type="button" aria-label="Seek backward 10 seconds" aria-keyshortcuts="ArrowLeft" onclick={() => onStep(-10)}>
          <RotateCcwSquare size={18} strokeWidth={1.5} aria-hidden="true" />
        </button>
        <button class="control-button play-inline" type="button" aria-label={playing ? 'Pause' : 'Play'} aria-keyshortcuts="Space" onclick={onTogglePlay}>
          {#if playing}<Pause size={18} strokeWidth={1.5} aria-hidden="true" />{:else}<Play size={18} fill="currentColor" aria-hidden="true" />{/if}
        </button>
        <button class="control-button seek-inline" type="button" aria-label="Seek forward 10 seconds" aria-keyshortcuts="ArrowRight" onclick={() => onStep(10)}>
          <RotateCwSquare size={18} strokeWidth={1.5} aria-hidden="true" />
        </button>
        {#if !castActive}
          <div class="volume-control">
            <button class="control-button" type="button" aria-label={muted ? 'Unmute' : 'Mute'} onclick={onToggleMute}>
              {#if volumeIcon === 'muted'}<VolumeX size={18} strokeWidth={1.5} />{:else if volumeIcon === 'low'}<Volume1 size={18} strokeWidth={1.5} />{:else}<Volume2 size={18} strokeWidth={1.5} />{/if}
            </button>
            <input class="volume-input" type="range" min="0" max="1" step="0.05" value={muted ? 0 : volume} oninput={handleVolume} aria-label="Volume" style={`--volume-fill: ${volumeFillPercent}%;`} />
          </div>
        {/if}
      </div>
      <!-- RIGHT group (rounds 51/49): Audio (only when the engine exposes
           tracks), display mode (before Speed), Speed, PiP (immediately LEFT
           of Fullscreen — round 52 F2), Fullscreen. -->
      <div class="right-controls">
        {#if !castActive}
          {#if audioMode === 'menu'}
            <button bind:this={audioAnchor} class="select-control audio sheet-trigger" data-sheet="audio" class:open={openSheet === 'audio'} type="button" aria-label={`Audio track: ${audioButtonLabel}`} aria-haspopup="dialog" onclick={() => openMenu('audio')}>
              <AudioLines size={16} strokeWidth={1.5} aria-hidden="true" />
              <span class="chip-label">Audio</span>
              <span class="chip-value">{audioButtonLabel}</span>
            </button>
          {/if}
        {/if}
        <button bind:this={displayAnchor} class="control-button sheet-trigger" data-sheet="display" type="button" aria-label={`Display mode: ${displayMode}`} aria-haspopup="dialog" onclick={() => openMenu('display')}><Expand size={17} strokeWidth={1.5} /></button>
        {#if !castActive}
          <button bind:this={speedAnchor} class="select-control speed sheet-trigger" data-sheet="speed" class:open={openSheet === 'speed'} type="button" aria-label={`Playback speed: ${playbackRate}×`} aria-haspopup="dialog" onclick={() => openMenu('speed')}>
            <Gauge size={16} strokeWidth={1.5} aria-hidden="true" />
            <span class="chip-label">{playbackRate}×</span>
          </button>
        {/if}
        {#if !castActive && pictureInPictureSupported}
          <button class="control-button" type="button" aria-label={pictureInPicture ? 'Exit Picture-in-Picture' : 'Enter Picture-in-Picture'} aria-pressed={pictureInPicture} onclick={onPictureInPicture}><PictureInPicture2 size={17} strokeWidth={1.5} /></button>
        {/if}
        <button class="control-button" type="button" aria-label={fullscreenActive ? 'Exit fullscreen' : 'Enter fullscreen'} aria-pressed={fullscreenActive} onclick={onFullscreen}>{#if fullscreenActive}<Minimize2 size={18} strokeWidth={1.5} />{:else}<Maximize2 size={18} strokeWidth={1.5} />{/if}</button>
      </div>
    </div>
  </div>
  {/if}

  <!-- Round 52 (F4) — the AUTO Up-next card: while PLAYING a series episode
       with a next episode and at most 180 s left, the SAME card that shows
       while paused slides in on its own at the bottom-right (the component's
       "auto" variant — a floating overlay ABOVE the bottom bar; it never
       shifts the timeline). Seeking back above the threshold hides it; a
       sheet being open or the lock hides it; movies never have a next
       episode so they never see it. Rendered OUTSIDE the !pausedSettled
       zones so it shows WITH the normal chrome while playing, and hidden
       again the moment playback pauses into the settled zone instance
       (same card, one place at a time — no duplicates). -->
  {#if upNextAutoOpen && upNext}
    <PlayerUpNextCard {upNext} onUpNext={onUpNext} variant="auto" />
  {/if}

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
    <PlayerOptionSheet title="Server" wide anchor={serverAnchor ?? null} closing={sheetClosing} onClose={closeMenu}>
      <!-- Round 51 (approved-concept fix C2) — two-pane server popover: a
           vertical group rail (All, then one entry per group present in
           `servers`) + the selected group's rows in the right pane. Same
           selection handler, same row markup and labels as before — "All"
           shows every row exactly as today. The rail is sticky inside the
           popover body's existing scroll so the groups stay put while the
           rows scroll; the selected rail item carries a 2px white bar on
           its left edge. -->
      <div class="server-pane">
        {#if serverGroups.length > 1}
          <div class="server-rail-wrap">
            <span class="rail-label" aria-hidden="true">SERVER</span>
            <div class="server-rail" role="tablist" aria-label="Server groups">
              <button class="rail-item" class:active={activeServerGroup === 'all'} type="button" onclick={() => (activeServerGroup = 'all')}>All</button>
              {#each serverGroups as group (group)}
                <button class="rail-item" class:active={activeServerGroup === group} type="button" onclick={() => (activeServerGroup = group)}>{group}</button>
              {/each}
            </div>
          </div>
        {/if}
        <div class="server-list">
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
        </div>
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
     Round 51 — the token DEFINITIONS moved to the shell's player root
     (.player-shell) so the native back button and the chips share ONE set
     of values (no duplicated magic numbers); children still inherit them. */
  .controls {
    position: absolute; inset: 0; z-index: 10; pointer-events: none; color: var(--ink);
  }

  /* ---- Top-right utility zone ----
     Round 37 B — holds Subtitles, Quality, Server, Cast, Lock. In portrait
     these must fit one row (360–430 px); the zone uses flex-wrap: nowrap and
     shrinks button size/gap. Round 51 — the display-mode control moved down
     to the bottom row, the zone carries a portrait 56px LEFT inset (≤640px
     block below) so it can never slide behind the native back chip. Round 52
     (F2) — PiP moved down to the bottom row too, so the zone keeps exactly
     Subtitles, Quality, Server, Cast, Lock. Round 52 (F3) — the TOP offset
     comes from the shell root's shared --pl-chrome-top token (same value the
     native back chip uses — one vertical reference; the compact 12px and
     landscape 6px floors are token overrides on the ROOT, not per-component
     magic numbers). The select-control labels truncate so the row never
     overflows. */
  .utility-zone { position: absolute; z-index: 2; top: var(--pl-chrome-top, max(16px, env(safe-area-inset-top))); right: max(12px, env(safe-area-inset-right)); display: flex; align-items: center; flex-wrap: nowrap; gap: 8px; pointer-events: auto; max-width: calc(100vw - 24px); }

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
    /* Round 56 (H2) — the LEFT offset derives from the SAME shared tokens the
       native back chip uses (--pl-chip-size), so the header can never slide
       under it at any width (the old fixed-offset pair left a 1px overlap at
       ≥1024px where the back chip is 44px wide). */
    left: calc(max(16px, env(safe-area-inset-left)) + var(--pl-chip-size, 40px) + 16px);
    max-width: min(480px, calc(100vw - 32px));
    display: flex;
    flex-direction: column;
    gap: 2px;
    pointer-events: none;
  }
  .header-title { font-size: 20px; font-weight: 650; letter-spacing: -0.2px; line-height: 1.15; color: #fff; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-shadow: 0 2px 12px rgba(0,0,0,0.5); }
  .header-meta { font-size: 12.5px; color: var(--pl-ink-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-shadow: 0 1px 8px rgba(0,0,0,0.5); }
  @media (min-width: 1024px) {
    /* Round 56 (H2) — same token-derived LEFT offset as the base rule, and a
       width CAP that reserves the right-side 320px (the utility chip row) so
       the title can never reach it: 100vw − (left offset) − 320px. The
       vertical placement is unchanged. */
    .header-zone { top: max(14px, env(safe-area-inset-top)); left: calc(max(16px, env(safe-area-inset-left)) + var(--pl-chip-size, 40px) + 16px); max-width: min(460px, calc(100vw - (max(16px, env(safe-area-inset-left)) + var(--pl-chip-size, 40px) + 16px) - 320px)); }
  }

  /* Round 51 — paused zone (approved-concept fix C1): the while-paused
     chrome is ONLY the cards inside. The zone is pointer-transparent (a tap
     on the empty area reaches the video and toggles the chrome layer); its
     TOP edge sits below the native back chip's bottom edge + 12px so the
     cards can never collide with the back affordance in portrait, and every
     card additionally caps at the zone height (overflow hidden) as a hard
     guard. While !playing nothing else renders, so the card stands alone at
     the bottom-left with no scrubber above it. */
  .paused-zone { position: absolute; z-index: 2; top: 68px; left: 16px; right: 16px; bottom: max(20px, calc(env(safe-area-inset-bottom) + 16px)); pointer-events: none; }
  .paused-zone > * { pointer-events: auto; }
  /* Round 50 — paused metadata card (approved concept): bottom-left over the
     video, fading in with the chrome. Background-less (text + the 4px white
     accent rule on the video) so the video stays visible — same chrome
     language as the rest. */
  .paused-card {
    position: absolute;
    left: 0;
    bottom: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
    max-width: 520px;
    max-height: 100%;
    overflow: hidden;
    padding: 6px 16px 6px 14px;
    border-left: 4px solid #fff;
    animation: paused-card-in 140ms var(--pl-ease);
  }
  .paused-title { font-size: 30px; font-weight: 650; letter-spacing: -0.3px; line-height: 1.12; color: #fff; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-shadow: 0 2px 14px rgba(0,0,0,0.5); }
  .paused-meta { font-size: 13px; color: var(--pl-ink-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-shadow: 0 1px 8px rgba(0,0,0,0.5); }
  .paused-overview { margin: 0; font-size: 13px; line-height: 1.45; color: rgba(255,255,255,0.62); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-shadow: 0 1px 8px rgba(0,0,0,0.5); }
  .resume-pill { display: inline-flex; align-items: center; gap: 7px; align-self: flex-start; height: 38px; margin-top: 6px; padding: 0 18px; border: 0; border-radius: 999px; color: #101013; background: #fff; font: inherit; font-size: 13px; font-weight: 650; cursor: pointer; box-shadow: 0 6px 22px rgba(0,0,0,0.4); transition: transform var(--motion-fast) var(--pl-ease), box-shadow var(--motion-fast) var(--pl-ease); }
  .resume-pill:hover, .resume-pill:focus-visible { transform: scale(1.02); box-shadow: 0 8px 26px rgba(0,0,0,0.5); }
  .resume-pill:active { transform: scale(.98); }
  @keyframes paused-card-in { from { opacity: 0; } to { opacity: 1; } }

  /* Round 52 (F4) — the Up-next card's own styles (shape, still, label,
     title, episode line, Play pill and both anchor variants) moved WITH the
     card into PlayerUpNextCard.svelte, so the paused-zone instance and the
     auto-while-playing instance share ONE definition (no drift). The
     card's sizing/stacking contracts are unchanged. */

  /* Round 51 — mid widths: the two bottom cards share the zone, so the
     metadata card caps below (zone width − the 280px Up-next card − gap)
     and the pair can never overlap between 641–899px. ≥900px both fit at
     their full caps (868 ≥ 520 + 280 + 16). */
  @media (min-width: 641px) and (max-width: 899px) {
    .paused-card { max-width: min(520px, calc(100% - 312px)); }
  }

  .timeline-row { display: flex; align-items: center; gap: 10px; }
  /* Round 50 — tabular 12px time labels: secondary ink left (position),
     tertiary ink right (duration — the row's last label, no markup change). */
  .time-label { color: var(--pl-ink-2); font-family: 'Inter', ui-sans-serif, system-ui, sans-serif; font-size: 12px; white-space: nowrap; font-variant-numeric: tabular-nums; }
  .timeline-row .time-label:last-child { color: var(--pl-ink-3); }
  /* Round 53 (F6) — the RIGHT time label is a real toggle button (total ↔
     remaining). It keeps the plain .time-label look (no chrome, no shift —
     the row geometry is unchanged); only the hover colour, the pointer and
     the focus ring reveal it is interactive. */
  button.time-label.duration-toggle { border: 0; padding: 0; background: transparent; cursor: pointer; font: inherit; }
  button.time-label.duration-toggle:hover, button.time-label.duration-toggle:focus-visible { color: #fff; }
  button.time-label.duration-toggle:focus-visible { outline: 2px solid #fff; outline-offset: 2px; border-radius: 4px; }
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

  /* Secondary row: LEFT group (Play/Pause, ±10s, Volume — round 51) +
     RIGHT group (Audio, Display mode, Speed, Fullscreen — round 51) using
     space-between. 2026-10 round 25 — portrait uses nowrap (single row)
     with 8px gap. The right group packs tightly with flex-shrink on labels
     so everything fits on one line. Touch targets remain 36px+ minimum. */
  .secondary-row { display: flex; align-items: center; flex-wrap: nowrap; justify-content: space-between; gap: 8px; }
  .left-controls { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
  .right-controls { display: flex; align-items: center; flex-wrap: nowrap; gap: 8px; justify-content: flex-end; min-width: 0; }
  /* Round 50 — bottom-row buttons: 40px hit area, radius 12, transparent
     until hover (then the s1 surface); no per-button blur (the popover
     surface carries the single blur layer). */
  .control-button { display: inline-grid; place-items: center; min-width: 40px; min-height: 40px; border: 1px solid transparent; border-radius: var(--pl-r1); color: rgba(255,255,255,0.88); background: transparent; cursor: pointer; transition: background var(--motion-fast) var(--pl-ease), color var(--motion-fast) var(--pl-ease), transform var(--motion-fast) var(--pl-ease); }
  .control-button:hover, .control-button:focus-visible { background: var(--pl-s1); color: #fff; }
  .control-button:active { transform: scale(.97); }
  /* Round 50 — icon-only utility buttons (cast, PiP-before-round-49, lock):
     rounded squares on the chip surface tokens, icon 17px. Round 52 (F3) —
     the SIZE comes from the shell root's shared --pl-chip-size token (40px
     base; 44px ≥900px and 36px ≤640px are ROOT overrides) so the utility
     chips and the native back chip keep the SAME height and one vertical
     centre in portrait AND landscape (the back chip consumes the same
     token on the shell side). */
  .utility-zone .control-button { width: var(--pl-chip-size, 40px); min-width: var(--pl-chip-size, 40px); height: var(--pl-chip-size, 40px); border-color: var(--pl-line); background: var(--pl-s1); }
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
  .select-control { display: inline-flex; align-items: center; gap: 8px; height: var(--pl-chip-size, 40px); max-width: 180px; padding: 0 14px; border: 1px solid var(--pl-line); border-radius: 13px; color: #fff; background: var(--pl-s1); cursor: pointer; font: inherit; transition: background var(--motion-fast) var(--pl-ease), border-color var(--motion-fast) var(--pl-ease); }
  .select-control:hover:not(:disabled), .select-control:focus-visible, .select-control.open { background: var(--pl-s2); border-color: rgba(255,255,255,0.2); }
  .select-control:disabled { opacity: .6; cursor: default; }
  .select-control .chip-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; font-weight: 600; }
  .select-control .chip-value { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12.5px; color: var(--pl-ink-3); }
  .select-control .chip-label, .select-control .chip-value { flex: 0 1 auto; }
  .select-control.quality .chip-value { max-width: 64px; }
  .select-control.server .chip-value { max-width: 64px; }
  .select-control.speed .chip-label { max-width: 44px; }
  /* Round 51 (Phase 4 — keyboard focus): every chip, control button, popover
     row and rail item gets a :focus-visible ring — 2px solid white, 2px
     offset. The outline follows each element's own border-radius (browsers
     round outlines to the element's radius), so no per-element radius is
     restated here. (The native back chip's ring lives in the shell.) */
  .select-control:focus-visible, .control-button:focus-visible, .option-row:focus-visible, .rail-item:focus-visible, .resume-pill:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
  /* (The Up-next card's pill ring lives in PlayerUpNextCard.svelte — moved
     with the card, round 52.) */

  /* In-player selection sheet option rows (shared shape across quality /
     display / speed sheets; the subtitle sheet carries its own richer
     controls). */
  .option-list { display: grid; gap: 3px; }
  .option-row { display: flex; align-items: center; gap: 11px; min-height: 46px; border: 1px solid transparent; border-radius: var(--radius-sm); padding: 7px 12px; color: var(--ink-soft); background: transparent; cursor: pointer; text-align: left; font: inherit; }
  .option-row:hover, .option-row:focus-visible, .option-row.selected { border-color: var(--line-strong); background: var(--accent-soft); }
  .option-row.selected { color: var(--ink); }
  .row-mark { display: grid; flex: 0 0 22px; place-items: center; width: 22px; height: 22px; color: var(--muted); }
  .option-row.selected .row-mark { border: 1px solid var(--line-strong); border-radius: 50%; color: var(--accent); }
  /* Round 51 (approved-concept fix C2) — two-pane server popover: a
     vertical group rail + the selected group's rows. The rail is sticky
     inside the sheet body's existing scroll so the groups stay put while
     the rows scroll; the selected rail item carries a 2px white bar on its
     left edge (white text; inactive 66% white). The row markup is
     unchanged (check mark, label, group sub-label).
     Round 54 (G2) — the rail items and rows join the glassy visual language
     of the episode sheet (G1): rail items are 36px-tall radius-12 pills at
     13px/600 with a quiet white hover wash; the rows carry the 15px/600
     white title + 12.5px tertiary meta, ≥56px tall, hairline dividers
     BETWEEN rows (not boxes). NO layout change — the two-pane rail + list
     structure stays exactly as it is. */
  .server-pane { display: flex; align-items: flex-start; gap: 8px; }
  .server-rail-wrap { flex: 0 0 132px; position: sticky; top: 0; }
  .rail-label { display: block; padding: 4px 10px 8px 12px; color: rgba(255, 255, 255, 0.45); font-size: 10.5px; font-weight: 700; letter-spacing: 1.6px; text-transform: uppercase; }
  .server-rail { display: flex; flex-direction: column; gap: 2px; }
  .rail-item { position: relative; display: block; min-height: 36px; padding: 8px 10px 8px 14px; border: 0; border-radius: 12px; color: rgba(255, 255, 255, 0.72); background: transparent; cursor: pointer; text-align: left; font: inherit; font-size: 13px; font-weight: 600; transition: color var(--motion-fast) var(--pl-ease), background var(--motion-fast) var(--pl-ease); }
  .rail-item:hover, .rail-item:focus-visible { color: #fff; background: rgba(255, 255, 255, 0.05); }
  .rail-item.active { color: #fff; background: rgba(255, 255, 255, 0.06); }
  .rail-item.active::before { content: ''; position: absolute; left: 0; top: 9px; bottom: 9px; width: 2px; border-radius: 1px; background: #fff; }
  .server-list { flex: 1 1 auto; min-width: 0; }
  .server-list .option-list { gap: 0; }
  .server-list .option-row { min-height: 56px; border-radius: 12px; }
  .server-list .option-row + .option-row { box-shadow: 0 -1px 0 rgba(255, 255, 255, 0.08); }
  .server-list .option-row:hover, .server-list .option-row:focus-visible, .server-list .option-row.selected { border-color: transparent; background: rgba(255, 255, 255, 0.05); }
  .server-list .option-row.selected { background: rgba(255, 255, 255, 0.08); }
  .server-list .row-copy strong { display: block; color: #fff; font-size: 15px; font-weight: 600; overflow-wrap: anywhere; }
  .server-list .row-copy small { display: block; margin-top: 2px; color: var(--pl-ink-3); font-size: 12.5px; }
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
     desktop/TV hit area). Round 52 (F3) — the growth is a --pl-chip-size
     token override on the shell ROOT (PlayerShell.svelte) so the native
     back chip grows WITH the utility chips and both rows stay on one
     vertical reference; nothing to override here anymore. */
  /* Round 37 B — portrait (360–430 px): shrink the utility-zone + bottom-row
     buttons so both rows stay on ONE line. Round 50 — the chips keep the new
     chip surface but DROP the chip LABEL (the icon + value carry exactly the
     state text the old control-label carried, so the row fits portrait
     exactly as before); the values keep truncating so long names never
     expand the row. Round 52 (F3) — the compact TOP (12px) and chip SIZE
     (36px) are --pl-chrome-top/--pl-chip-size token overrides on the shell
     ROOT (the native back chip consumes the same tokens, so both rows keep
     one vertical reference — nothing size/top-related is re-declared here);
     this block only tightens padding, gaps and label widths. Touch targets
     stay 32px+ minimum. */
  @media (max-width: 640px) {
    .bottom-zone { padding: 8px 8px calc(10px + env(safe-area-inset-bottom)); }
    .secondary-row { gap: 6px; }
    .left-controls { gap: 6px; }
    .right-controls { gap: 4px; }
    /* Round 51 — the 56px LEFT inset: the native back chip ends at 52px, so
    the chip row can never slide behind it; the chips keep truncating so the
    row stays ONE line at 360px. (The compact top offset rides the root's
    --pl-chrome-top token — round 52 F3.) */
    .utility-zone { gap: 4px; left: max(56px, env(safe-area-inset-left)); max-width: calc(100vw - 68px); }
    .time-label { font-size: 11px; }
    .select-control { padding: 0 10px; gap: 6px; }
    .select-control .chip-label { display: none; }
    .select-control .chip-value { font-size: 12px; }
    .select-control.subtitles { max-width: 80px; }
    .select-control.quality { max-width: 72px; }
    .select-control.server { max-width: 72px; }
    .select-control.audio { max-width: 72px; }
    .control-button { min-width: 32px; min-height: 32px; }
    /* Round 51 — the server rail stays visible beside the list (104px);
       the list takes the rest — still two columns, no tabs. */
    .server-rail-wrap { flex: 0 0 104px; }
    /* Round 51 — paused zone portrait: same edges as the back chip (12px)
       and the card's top stays safely below the back chip's bottom edge
       (12 + 36 + 12 = 60px; 64px keeps a little slack). */
    .paused-zone { top: 64px; left: 12px; right: 12px; bottom: max(12px, calc(env(safe-area-inset-bottom) + 8px)); }
    .paused-card { max-width: 82vw; padding: 4px 10px 4px 10px; }
    .paused-title { font-size: 24px; }
    /* Round 51 (Phase 3) — portrait: the Up-next card stacks ABOVE the
       metadata card at the same left edge (column-reverse keeps the
       metadata card on the bottom); the card component itself joins the
       zone's flow as a static in-flow child (the card's own :not(.auto)
       compact rule — round 52 F4 moved it with the component). */
    .paused-zone { display: flex; flex-direction: column-reverse; align-items: flex-start; gap: 12px; }
    .paused-zone > :global(.paused-card) { position: static; }
  }
  /* (The Up-next card's reduced-motion rule moved with the card into
     PlayerUpNextCard.svelte — round 52 F4.) */
  @media (prefers-reduced-motion: reduce) { .control-button { transition: none; } .select-control { transition: none; } .paused-card { animation: none; } .rail-item { transition: none; } }
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
