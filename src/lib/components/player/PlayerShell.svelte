<script lang="ts">
  import { browser } from '$app/environment';
  import { onDestroy, onMount, tick } from 'svelte';
  import { AlertTriangle, ArrowLeft, Check, LockOpen, Maximize2, Minimize2, RotateCcw, RotateCcwSquare, RotateCwSquare, Settings2, Sun, Volume2, X } from 'lucide-svelte';
  // Task 13: safe source icon renderer + centralized badge labels for the
  // source selector (presentation metadata from the public streaming config).
  import SourceIcon from '$lib/components/source/SourceIcon.svelte';
  import { sourceBadgeLabel } from '$lib/shared/source-presentation';
  import PlayerControls from './PlayerControls.svelte';
  import PlayerViewport from './PlayerViewport.svelte';
  import type { PlayerContentContext, PlayerEpisode, PlayerEpisodeTarget, PlayerInternalQualityOption, PlayerPlaybackState, PlayerProgressEvent, PlayerQualityOption, PlayerSource, PlayerSourceOption } from '$lib/shared/player';
  import { PLAYER_AUTO_QUALITY_ID } from '$lib/shared/player';
  import { sourceIsExpired, isEmbedOriginAllowed, isPlayablePlayerSource } from '$lib/shared/player-guards';
  import { adjacentEpisode, adjacentSource, clampSeek } from '$lib/shared/player-state';
  // Phase 9: robust pending-seek state machine (streaming VOD seeking) — pure,
  // unit-tested; the shell feeds it media snapshots and applies the result.
  import { applyPendingSeek, capturePendingSeek, createPendingSeek, type PendingSeekState } from '$lib/client/player/pending-seek';
  // Player UI V2 (Part 1, Phase 2): touch gestures (left = simulated
  // brightness overlay, right = volume) + the pure helpers for the indicator.
  // Player V2 corrections: the tap-gesture controller adds double-tap seek
  // (left −10 s / right +10 s) and press-and-hold 2× with exact restore.
  import { brightnessDimOpacity, clampBrightness, createPlayerGestureController, createPlayerTapGestureController, gestureIndicatorPercent, type GestureKind, type PlayerGestureController, type PlayerTapGestureController, type TapSeekDirection } from '$lib/client/player/touch/gestures';
  // Player UI V2 (Part 1, Phase 3A): external (VDRK) subtitle lists — same-origin
  // proxy tracks, bounded TTL cache, validated entries. The request-key
  // helper aliases the controller's OWN key space — the shell's stale guards
  // must compare results against it (see loadExternalSubtitles below).
  import { createExternalSubtitleController, externalSubtitlesKey as externalSubtitleRequestKey, mergeSubtitleTracks, type ExternalSubtitleRequest, type ExternalSubtitleTrack } from '$lib/client/player/subtitles/external-subtitles';
  // Focused player fixes (Issues 1+2): versioned local subtitle preferences
  // (size / position / sync offset / colour / border) — safe defaults, no DB.
  import { DEFAULT_SUBTITLE_PREFERENCES, loadSubtitlePreferences, sanitizeSubtitlePreferences, saveSubtitlePreferences, type SubtitlePreferences } from '$lib/client/player/subtitles/subtitle-preferences';
  // Player UI V2 (Part 1, Phase 3B): TheIntroDB Skip Intro lookup — read-only,
  // optional-by-design, validated segments in SECONDS for the player seek API.
  import { createIntroLookup, introRequestKey, type IntroMediaRequest, type IntroSegment } from '$lib/client/player/intro/intro-client';
  // Player UI V2 (Part 2, Phase 4): Google Cast (Web Sender) for eligible
  // direct-media sources — static eligibility gates + CORS probe + CAF SDK
  // controller (lazy, once per page; remote state mirrored into the shell).
  import {
    createCastController,
    evaluateCastEligibility,
    probeMediaCastability,
    type CastControllerState,
    type CastEligibility,
  } from '$lib/client/player/cast/cast-client';
  // Phase 10 (GOAL 18): audio-track display — a LOCAL structural type so the
  // shell stays engine-library-name-free (same pattern as WakeLockSentinelHandle).
  type AudioTrackHandle = { id: number; lang?: string; name?: string; default?: boolean };
  // Phase 10 (GOALS 12–15): honest badges for uncertain formats.
  import { checkMediaCompatibility, type MediaCompatibilityDecision } from '$lib/client/player/media-capabilities';
  import { markPlayerMilestone, measurePlayerStartup } from '$lib/client/player/player-timing';
  // Per-source Landscape-control positioning (Admin "Player Controls Position").
  import { landscapeControlInlineStyle, controlsPlacementInlineStyle, controlsSizeInlineStyle, resolveControlPlacement, resolveControlSize, resolveLandscapeControlPlacement } from '$lib/shared/player-controls-position';
  // MAVP-3 Issue 1: the MAVP-2 landscape-first presentation (click-time
  // request + shell mount adoption) was REMOVED — playback opens in the
  // device's EXISTING orientation on every entry path. The manual Landscape
  // control (toggleLandscape) and the F-key fullscreen remain the only
  // orientation/fullscreen entry points, exactly as before.

  export let source: PlayerSource | null = null;
  export let content: PlayerContentContext;
  export let initialProgress = 0;
  export let sourceOptions: PlayerSourceOption[] = [];
  export let episodes: PlayerEpisode[] = [];
  export let currentEpisode: PlayerEpisodeTarget | null = null;
  export let onProgress: (event: PlayerProgressEvent) => void = () => {};
  export let onSourceChange: (sourceId: string, variant?: string) => void = () => {};
  export let onEpisodeChange: (target: PlayerEpisodeTarget) => void = () => {};
  export let onClose: () => void = () => {};
  // svelte-ignore export_let_unused -- accepted by the watch route for API compatibility; the immersive redesign uses a Back FAB instead of a Details button
  export let onDetails: () => void = () => {};
  export let onIframeReady: (iframe: HTMLIFrameElement) => void = () => {};
  // Phase 6 audit fix 2: embed playback event sink. The watch route sets this
  // prop to { type, _seq, sourceId } whenever the PlaybackManager receives a
  // normalized provider playback event from an embed adapter. PlayerShell
  // watches this prop reactively and acquires/releases the Wake Lock
  // accordingly. The `sourceId` field lets PlayerShell reject stale events
  // from an old source after a source switch — the PlaybackManager has its
  // own session guards, but a stale postMessage could still arrive between
  // the source switch and the adapter destroy. The `embedPlaying` state is
  // driven ONLY by these normalized events (never by iframe DOM load), so
  // black-box embed providers that never post play/pause events never
  // acquire a wake lock — which is correct (iframe load ≠ actual playback).
  // MAVP-4 Issue 1: the forward also carries 'timeupdate'/'ready' — the
  // presentation signals for the embed presentation gate (see
  // handleEmbedPlaybackEvent).
  export let embedPlaybackEvent: { type: 'play' | 'pause' | 'ended' | 'timeupdate' | 'ready'; _seq?: number; sourceId?: string } | null = null;
  export let resolving = false;
  // MAVP-3 Issue 4: explicit control-position CALIBRATION session. The watch
  // route sets this when the player was opened with `?controls=calibrate` —
  // the documented way to inspect a per-source calibration in the running
  // player. While the calibration session is open, the floating controls and
  // the positioning are held visible (the inactivity timer is never armed);
  // every playback session opened WITHOUT the parameter keeps the exact 5s
  // auto-hide contract. The mode is per-session, opt-in, and never disables
  // auto-hide globally or forces controls visible during normal playback.
  export let calibrationMode = false;
  // MAVP-3 Issue 1: the deviceType prop was removed together with the
  // automatic landscape-first presentation it existed to gate. The shell no
  // longer rotates or locks orientation on any entry path; desktop/TV and
  // mobile behave identically at startup (the device's current orientation).
  export let resolutionError = '';
  export let resolutionMessage = '';
  // Player UI V2 (Part 1, Phase 1C): 'title-unavailable' is forwarded when the
  // resolver CONFIRMED the title does not exist on the selected source
  // (TITLE_NOT_AVAILABLE). The card then shows the title-unavailable heading
  // with the failing source's display name + a source-switch action.
  export let resolutionKind: 'provider-error' | 'unsupported' | 'unavailable' | 'title-unavailable' = 'provider-error';
  // Player UI V2 (Part 1, Phase 1C): display name of the source the user last
  // requested (watch route); used only by the title-unavailable heading.
  export let resolutionSourceName = '';
  let viewport: PlayerViewport;
  let videoElement: HTMLVideoElement | undefined;
  let iframeElement: HTMLIFrameElement | undefined;
  let playerRoot: HTMLElement;
  let currentTime = initialProgress;
  let duration = 0;
  let buffered = 0;
  let playing = false;
  let muted = false;
  let volume = 1;
  let playbackRate = 1;
  // Player V2 corrections (real-device feedback): display mode of the DIRECT
  // video surface — 'fit' (object-fit: contain, the historical default),
  // 'fill' (cover — aspect preserved, crop allowed), 'stretch' (fill — both
  // axes, distortion allowed). CSS-only: switching never restarts the stream
  // and never moves the playhead. Embeds never receive the control.
  let displayMode: 'fit' | 'fill' | 'stretch' = 'fit';
  let fullscreen = false;
  let landscapeMode = false;
  let landscapeToggleInFlight = false;
  // MAVP-5 (Issue 5) — LANDSCAPE PRESENTATION-INTENT PRESERVATION.
  //
  // A source switch REMOUNTS the provider iframe ({#key iframeKey}); when
  // the provider iframe holds document focus (the normal post-Play state —
  // the MAVP-3 recurring-reveal contract relies on it), removing the
  // focused element inside the fullscreen element makes mobile browsers
  // fire a fullscreen-exit. The fullscreenchange handler treated EVERY
  // fullscreen loss as a user exit — unlocking the orientation and
  // reverting the shell to portrait mid-source-switch.
  //
  // The presentation is now intent-preserving:
  //   * entering the landscape presentation records `landscapePresentationIntent`;
  //   * a fullscreen loss WHILE the intent is active AND within a bounded
  //     window after the last source switch (lastSourceSwitchAt — both the
  //     new-source and same-source-URL remount watchers stamp it) is treated
  //     as a switch-triggered loss: the shell re-acquires the Mavero
  //     fullscreen + re-issues the landscape orientation lock ONCE
  //     (bounded, no duplicate lock requests — landscapeRestoreInFlight)
  //     and KEEPS the CSS landscape presentation (`.landscape-mode` works
  //     without fullscreen) if the platform declines the re-acquisition;
  //   * explicit user exits (toggleLandscape exit branch,
  //     exitMaveroFullscreen) clear the intent and behave exactly as before;
  //   * portrait sessions are untouched — nothing in the switch path ever
  //     SETS landscapeMode, so switching sources in portrait stays portrait;
  //   * the intent clears on destroy (no stale state across navigation).
  // The window is a documented policy bound (like the 18 s load timeout and
  // the 5 s auto-hide) — it can never capture a deliberate user exit more
  // than LANDSCAPE_RESTORE_WINDOW_MS after a source switch.
  let landscapePresentationIntent = false;
  let landscapeRestoreInFlight = false;
  let lastSourceSwitchAt = 0;
  const LANDSCAPE_RESTORE_WINDOW_MS = 2000;
  // MAVP-2 Phase 5: the position PROFILES follow the REAL viewport orientation
  // (not the Mavero landscape presentation toggle) so a physically rotated
  // device — even when the orientation LOCK was declined — immediately uses
  // the matching saved profile. Tracked via matchMedia in onMount; the SSR
  // default mirrors the previous behaviour (landscapeMode=false → portrait).
  let playerOrientation: 'portrait' | 'landscape' = 'portrait';
  let orientationMediaQuery: MediaQueryList | undefined;
  let pictureInPicture = false;
  let pictureInPictureSupported = false;
  // Focused fixes (Issue 1): the custom subtitle overlay yields to the OS
  // painter while the video surface alone is visible (PiP window, native
  // VIDEO fullscreen — iOS path). Mavero fullscreen (playerRoot) keeps the
  // overlay (it is part of the shell surface).
  let nativeVideoFullscreen = false;
  $: subtitleOverlaySuppressed = pictureInPicture || nativeVideoFullscreen;
  // Player startup redesign: the shell mounts BEFORE the source resolves —
  // the initial state is 'preparing' (single lightweight loading card), never
  // 'source-unavailable'. Real unavailability still arrives through explicit
  // state mutations (togglePlay fallback, resolutionKind, adapter errors), so
  // no error path is lost — only the mount-time flash of the error card is.
  let state: PlayerPlaybackState = 'preparing';
  let errorMessage = '';
  let selectedQuality = '';
  let selectedSubtitle = '';
  // Focused fixes (Issues 1+2): subtitle appearance + sync preferences.
  // Loaded once on mount from the versioned local store; every change is
  // sanitized and persisted (safe on SSR/private mode — session values only).
  let subtitlePrefs: SubtitlePreferences = DEFAULT_SUBTITLE_PREFERENCES;
  let sourceMenuOpen = false;
  let episodeMenuOpen = false;
  // Focused fixes (Issue 3): true while ANY PlayerControls selection sheet is
  // open — the shell stands its keyboard shortcuts and touch gestures down
  // (the sheets own Escape/Tab and every tap inside them).
  let controlsSheetsOpen = false;
  let controlsVisible = true;
  let hideTimer: ReturnType<typeof setTimeout> | undefined;
  // Player UI V2 (Part 1, Phase 2C): touch lock. When locked, taps and swipes
  // are ignored (the gesture controller's enabled() gate + the reveal gate
  // below), the control row stays hidden, and ONE persistent unlock FAB stays
  // visible (top-right, safe-area aware) so the player can never strand the
  // user. The Back FAB remains reachable while locked (essential navigation is
  // never blocked); deliberate keyboard shortcuts are disabled while locked.
  let touchLocked = false;
  // Player UI V2 (Part 1, Phase 2A): simulated player-video brightness
  // (Mavero-rendered black overlay — never a system/display brightness API).
  let brightness = 1;
  // Player UI V2 (Part 1, Phase 2A/2B): the transient gesture indicator.
  let gestureIndicator: GestureKind | null = null;
  let gestureIndicatorHideTimer: ReturnType<typeof setTimeout> | undefined;
  // The polite live announcement fired ONCE per completed gesture.
  let gestureAnnouncement = '';
  // Player UI V2 (Part 1, Phase 3A): external (VDRK) subtitle tracks for the
  // CURRENT media — same-origin proxy URLs, validated, media-scoped (they
  // survive source switches and reload per title/episode).
  let externalSubtitles: ExternalSubtitleTrack[] = [];
  let externalSubtitlesKey = '';
  // Player V2 corrections (Phase 2C): honest subtitle feature-state — the
  // menu ALWAYS renders and these drive its empty/error notice (the reported
  // "no subtitle controls" confusion) plus the safe diagnostic log. States:
  // loading (request in flight) → ready (tracks attached) / empty (API
  // answered with no usable tracks) / failed (network, timeout or invalid
  // response — typed by externalSubtitleError).
  let externalSubtitleStatus: 'loading' | 'ready' | 'empty' | 'failed' = 'loading';
  let externalSubtitleNotice = 'Checking subtitles…';
  let externalSubtitleError: 'network' | 'timeout' | 'invalid-response' | null = null;
  // Player UI V2 (Part 1, Phase 3B): validated intro segments (SECONDS) for
  // the current media + the active Skip Intro target derived from the playhead.
  let introSegments: IntroSegment[] = [];
  let introKey = '';
  // Player V2 corrections (Phase 2C): Skip Intro feature-state distinction —
  // 'waiting-duration' until the ACTUAL media duration is known (the lookup
  // gate never uses the catalog runtime), then loading → available /
  // no-data (the API answered; this title has no intro) / unavailable (the
  // request failed or the response was invalid — typed by introErrorKind).
  // A missing button must be explainable, never mistaken for a working
  // feature — and never rendered as a fake control either.
  let introStatus: 'waiting-duration' | 'loading' | 'available' | 'no-data' | 'unavailable' = 'waiting-duration';
  let introErrorKind: 'api' | 'timeout' | 'invalid' | 'network' | null = null;
  // The attached gesture controllers (created in onMount; destroyed in
  // cleanup): the swipe controller (brightness/volume) and the tap
  // controller (double-tap seek + press-and-hold 2×).
  let gestureController: PlayerGestureController | null = null;
  let tapGestureController: PlayerTapGestureController | null = null;
  // Player V2 corrections: transient double-tap seek feedback (direction
  // pill near the tapped side) + press-and-hold 2× state. The exact speed
  // active before the hold is restored on release, cancel, lock, cast,
  // source/episode switch and destroy — 2× can never leak.
  let seekFeedback: TapSeekDirection | null = null;
  let seekFeedbackTimer: ReturnType<typeof setTimeout> | undefined;
  let holdSpeedActive = false;
  let savedPlaybackRate = 1;
  // Player UI V2 (Part 2, Phase 4): Google Cast state. The controller is
  // created lazily (browser only) and destroyed in cleanup. `castReady` is
  // true only when the ACTIVE source passed every eligibility gate (direct,
  // no header binding, known receiver-compatible format, unexpired) AND the
  // CORS probe verified the media URL is receiver-accessible AND the CAF SDK
  // reported availability. While connected, remote media state is mirrored
  // into the shell's normal timeline/progress pipeline.
  let castController: ReturnType<typeof createCastController> | null = null;
  let castEligibility: CastEligibility | null = null;
  let castState: CastControllerState | null = null;
  let castProbeDoneFor = '';
  let castConnected = false;
  let castReady = false;
  // Progress throttling while casting (mirrors the local 5 s gate).
  let castLastProgressReport = 0;
  let castEndedEmitted = false;
  // Player controls redesign: the menu FAB was replaced by dedicated controls
  // (bottom-right Landscape FAB, Episodes pill, right-edge source chip) — no
  // menu state remains.
  // Responsive viewport detection: compact (portrait mobile) → bottom sheet;
  // wide (landscape/desktop/TV) → right drawer. Based on actual viewport,
  // NOT on landscapeMode toggle.
  let isWideViewport = false;
  let viewportMediaQuery: MediaQueryList | undefined;
  // Phase 9: the pending seek is a STATE MACHINE, not a bare number. It is
  // retained until the media has a usable seekable range/duration (adaptive VOD
  // readiness), retried from bounded media lifecycle events, and stamped
  // with a monotonic token so a stale seek from a previous source can never
  // land on a newly selected stream. See `pending-seek.ts`.
  let pendingSeekState: PendingSeekState = createPendingSeek(initialProgress, Date.now());
  let lastProgressReport = 0;
  let sourceIdentity = '';
  // Phase 11 (GOAL D): the EFFECTIVE sandbox policy the viewport renders is
  // resolved SERVER-side (source override → provider default → system default)
  // and carried on the resolved source (`sandboxRuntime`). The player-redesign
  // phase removed the user-facing Sandbox menu item AND its client-side
  // override state — the runtime now applies the server-resolved policy
  // verbatim and can never contradict the admin configuration.
  // Phase 6: episode identity tracker for the episode-switch reactive block.
  let episodeIdentity = '';
  // Phase 6 audit fix: sequence counter for embed playback events. Used by
  // the reactive watcher to detect new events even when the type is the same.
  let lastEmbedPlaybackSeq = 0;
  // Phase 9 fix: removed landscape controls hide timer — landscape header is always visible.
  // Phase 8: embed iframe load timeout. If the iframe doesn't fire `on:load`
  // within this window, we transition to the error state instead of leaving
  // the player stuck in `embed-loading` indefinitely.
  const EMBED_LOAD_TIMEOUT_MS = 18000;
  let embedLoadTimer: ReturnType<typeof setTimeout> | undefined;
  // Phase 8: identity guard for the embed load timeout. A stale timeout from
  // source A must NOT affect source B. This is checked in the timeout
  // callback — if the source identity has changed, the timeout is a no-op.
  let embedLoadTimeoutSourceId = '';

  // Phase 6: Wake Lock state — shell-local, never exposed as a provider capability.
  let wakeLockSupported = false;
  let wakeLockSentinel: WakeLockSentinelHandle | null = null;
  let wasPlayingBeforeHidden = false;
  // Phase 6 audit fix: request-generation mechanism. Each acquireWakeLock()
  // call increments wakeLockRequestId and captures the new value. After the
  // async request resolves, we verify the current request id still matches.
  // If releaseWakeLock() or any other invalidating event fired during the
  // await, the id will have changed (or destroyed will be true), and the
  // resolved sentinel is released immediately rather than installed.
  let wakeLockRequestId = 0;
  let wakeLockDestroyed = false;
  // Phase 6 audit fix 2: separate embed playback state. Driven ONLY by
  // normalized provider play/pause/ended events (NOT by iframe DOM load).
  // Used by the visibility handler to decide whether to re-acquire the wake
  // lock when the document becomes visible again. The direct `playing` flag
  // cannot be reused for embed sources because handleEmbedLoad sets state to
  // 'playing' but that does not reflect actual provider playback.
  let embedPlaying = false;
  // MAVP-2 Phase 3: true once the ACTIVE embed source has posted at least one
  // normalized 'play' event. Distinguishes event-posting providers (whose
  // pause state is real) from black-box providers (whose playback state is
  // unobservable — the shell-visible session state drives auto-hide).
  let embedEverPlayed = false;
  // Phase 6 audit fix 2: the sourceId that the current embedPlaybackEvent
  // was emitted for. Used to reject stale events from an old source after a
  // source switch. Set in the source-switch reactive block, checked in
  // handleEmbedPlaybackEvent.
  let embedPlaybackSourceId = '';

  // MAVP-4 Issue 1: EMBED PRESENTATION GATE. The iframe's document `load`
  // event means the provider document finished loading — NOT that the
  // provider's player is ready to be presented. The previous behaviour
  // flipped the shell to 'playing' at `load`, which unmounted the loading
  // card and exposed the provider's own boot surface (green/brand-coloured
  // on several providers) for another 1–2 s. The presentation is now gated:
  // the loading card + an opaque veil stay mounted until the embed is
  // genuinely presenting (first provider playback signal / user tap into
  // the embed), with a bounded fail-open for silent black-box embeds.
  // The fail-open is a documented policy bound (like the 18 s load timeout
  // and the 5 s auto-hide) — the LAST resort for embeds that never signal;
  // signal-capable providers always reveal earlier, event-driven.
  const EMBED_PRESENT_FAIL_OPEN_MS = 3000;
  let embedPresentFailOpenTimer: ReturnType<typeof setTimeout> | undefined;
  // True once the CURRENT embed surface is presenting (revealed). Reset on
  // every embed surface identity change (source switch OR same-source URL
  // change — e.g. an episode switch remounts the iframe with a new URL).
  let embedSurfacePresenting = false;
  // Composite identity of the embed surface currently being waited on:
  // `${sourceId}:${url}` — the iframe remounts exactly when this changes.
  let embedSurfaceIdentity = '';

  // Phase 6: Media Session state — direct playback only.
  let mediaSessionSupported = false;
  let mediaSessionActive = false;

  // Phase 8: focus management for source/episode/streams sheets. When a
  // sheet opens, we save the trigger element so we can restore focus when it
  // closes.
  let sourceSheetTrigger: HTMLElement | null = null;
  let episodeSheetTrigger: HTMLElement | null = null;
  // Phase 6: internal quality state of the ACTIVE engine-driven streaming source
  // (AUTO + manifest levels). Populated ONLY by the viewport's generic
  // `enginequality` events — the shell never sees engine-library types. `null` when the
  // current playback is not engine-driven (MP4, native streaming, embeds) —
  // the quality UI then falls back to the existing per-stream select.
  // Phase 10 (GOAL 18): the payload also carries the manifest's audio tracks
  // (empty unless the stream REALLY has alternates) + the active index.
  let engineQuality: { options: PlayerInternalQualityOption[]; selected: string | null; audioTracks: AudioTrackHandle[]; selectedAudioTrack: number | null } | null = null;

  /** Safe audio-track label: manifest-provided name/lang verbatim — never invented. */
  function audioTrackLabel(track: AudioTrackHandle): string {
    const name = typeof track.name === 'string' ? track.name.trim() : '';
    if (name) return name;
    const lang = typeof track.lang === 'string' ? track.lang.trim() : '';
    return lang || `Track ${track.id + 1}`;
  }

  // Phase 6: local WakeLockSentinel type. lib.dom.d.ts may not include this on
  // older TS versions, so we declare the minimal shape we use, matching the
  // existing OrientationController optional-method pattern.
  type WakeLockSentinelHandle = {
    released?: boolean;
    addEventListener?: (type: 'release', listener: () => void) => void;
    removeEventListener?: (type: 'release', listener: () => void) => void;
    release?: () => Promise<void>;
  };
  type WakeLockNavigator = Navigator & { wakeLock?: { request: (type: 'screen') => Promise<WakeLockSentinelHandle> } };
  type MediaSessionNavigator = Navigator & { mediaSession?: { playbackState?: string; metadata?: MediaMetadata | null; setActionHandler?: (action: string, handler: (() => void) | null) => void; setPositionState?: (state: { duration?: number; playbackRate?: number; position?: number }) => void } };

  $: qualities = source?.qualities ?? [];
  $: subtitles = source?.subtitles ?? [];
  $: selectedQualityOption = qualities.find((quality) => quality.url === selectedQuality) as PlayerQualityOption | undefined;
  // Phase 10: compat override — when a compatibility session succeeds, the
  // player plays the WORKER-PROVIDED streaming url instead of the addon’s direct URL
  // (which the browser cannot decode). Cleared on any source/stream switch.
  $: mediaUrl = selectedQualityOption?.url ?? source?.url ?? null;
  // statusNote (Phase 10 GOAL 14) removed with the duplicate viewport status
  // label — see PlayerViewport. The shell surfaces loading/errors via its
  // single loading/error card.
  // Stale-guard: a source object that no longer contains the selected
  // stream (e.g. after an episode switch clears the source) invalidates
  // any pending quality selection so it cannot ride into the new source.
  $: if (source && source.sourceId === sourceIdentity && selectedQuality && !source.qualities?.some((quality) => quality.url === selectedQuality)) {
    
    
    selectedQuality = '';
  }
  // Category grouping: sources that have a categoryName are grouped under
  // a category header in the source selector. Sources without a category
  // appear under "Other" at the bottom. The order follows the source list
  // order (which is already ordered by the admin's `ordering` field).
  $: groupedSourceOptions = (() => {
    const groups: { name: string; options: typeof sourceOptions }[] = [];
    const seen = new Set<string>();
    for (const option of sourceOptions) {
      const name = option.categoryName ?? 'Other';
      if (!seen.has(name)) {
        seen.add(name);
        groups.push({ name, options: [] });
      }
      const group = groups.find((g) => g.name === name);
      if (group) group.options.push(option);
    }
    // Move "Other" to the end if it exists and isn't already last.
    const otherIdx = groups.findIndex((g) => g.name === 'Other');
    if (otherIdx !== -1 && otherIdx !== groups.length - 1) {
      const [other] = groups.splice(otherIdx, 1);
      groups.push(other);
    }
    return groups;
  })();
  // Phase 9: per-stream subtitle tracks — the SELECTED stream's addon-
  // provided tracks win, the aggregate source's tracks are the fallback.
  $: effectiveSubtitles = selectedQualityOption?.subtitles?.length ? selectedQualityOption.subtitles : source?.subtitles ?? [];
  // Player UI V2 (Part 1, Phase 3A): the subtitle menu + <track> list = the
  // source's NATIVE tracks (unchanged, first) + the validated external VDRK
  // tracks (same-origin proxy URLs), deduped by URL. Distinct variants stay
  // individually selectable (keyed by their own file URL).
  $: mergedSubtitles = mergeSubtitleTracks(effectiveSubtitles, externalSubtitles);
  // Selection cleanup: a selected track that is no longer in the merged list
  // (episode change rebuilt the native list, external list superseded, source
  // switch) is cleared so no stale/dangling selection can survive.
  $: if (selectedSubtitle && mergedSubtitles.length && !mergedSubtitles.some((track) => track.url === selectedSubtitle)) {
    selectedSubtitle = '';
  }
  $: sourceReady = Boolean(source && isPlayablePlayerSource(source) && !sourceIsExpired(source));
  $: sourceIndex = source ? sourceOptions.findIndex((option) => option.id === source.sourceId) : -1;
  $: previousSourceId = adjacentSource(sourceOptions, source?.sourceId, -1);
  $: nextSourceId = adjacentSource(sourceOptions, source?.sourceId, 1);
  $: hasPreviousSource = Boolean(previousSourceId);
  $: hasNextSource = Boolean(nextSourceId);
  // Player redesign: the ACTIVE source's Admin-configured floating-control
  // placements (parsed + bounded; null/legacy axes keep the stylesheet
  // defaults — back = top-left, landscape control = bottom-right). Derived
  // from the source option for the CURRENT sourceId only — one source's
  // config can never leak into another's, and the portrait/landscape
  // profiles resolve independently per control per orientation.
  $: activeSourceOption = source ? sourceOptions.find((option) => option.id === source.sourceId) ?? null : null;
  // MAVP-3 Issue 5: per-control SIZE overrides resolve independently of the
  // placement axes — a size change can never move a control, and a placement
  // change can never resize one. The size rides the SAME inline style as the
  // placement (disjoint CSS keys: anchors/offsets vs a custom-property var)
  // so the element still gets ONE style write per orientation/profile change.
  $: backSizePx = resolveControlSize(activeSourceOption?.controlsPosition ?? null, 'back');
  $: landscapeSizePx = resolveControlSize(activeSourceOption?.controlsPosition ?? null, 'landscape');
  // MAVP-6 (Issues 2+3): the EPISODES CHIP IS FIXED — it consumes NO
  // per-source position/size. The source chip (right edge) is anchored to
  // the vertical centre by the player stylesheet; the episode chip (left
  // edge) follows the SAME fixed vertical reference (identical selectors'
  // mechanics: top:50% + translateY(-50%), 64px hit area, 56px bar), so the
  // two edge chips are vertically aligned BY CONSTRUCTION in both
  // orientations and for every source. Legacy stored `episodes` /
  // `sizes.episodes` capability keys are dropped by the total parser (see
  // player-controls-position.ts) and can never move the chip.
  // The chip's hover label mirrors the source chip's content-aware label:
  // it shows the CURRENT episode ("S2 · E08"), or simply "Episodes" when no
  // specific episode is active.
  $: episodeChipLabel = currentEpisode ? `S${currentEpisode.season} · E${String(currentEpisode.episode).padStart(2, '0')}` : 'Episodes';
  $: backControlStyle = [
    controlsPlacementInlineStyle(resolveControlPlacement(activeSourceOption?.controlsPosition ?? null, 'back', playerOrientation)),
    controlsSizeInlineStyle(activeSourceOption?.controlsPosition ?? null, 'back', '--back-fab-size'),
  ].filter(Boolean).join(';');
  $: landscapeControlStyle = [
    landscapeControlInlineStyle(resolveLandscapeControlPlacement(activeSourceOption?.controlsPosition ?? null, playerOrientation)),
    controlsSizeInlineStyle(activeSourceOption?.controlsPosition ?? null, 'landscape', '--landscape-fab-size'),
  ].filter(Boolean).join(';');
  $: effectiveState = resolving ? 'switching-source' : resolutionError ? resolutionKind : state;
  // Player UI V2 (Part 1, Phase 1B) — SUPERSEDED by the approved Player V2
  // corrections layout: the Blue Velvet provider-slug detection and its
  // in-row Back/Fullscreen + hidden-FAB exceptions are RETIRED. The approved
  // layout is EXACT for every provider: Back = the shell's top-left FAB,
  // Lock/PiP/Cast = the top-right utility zone, ±10s/Play/Pause = the center
  // cluster, fullscreen = the bottom secondary row (embeds keep the floating
  // Landscape FAB because they have no Mavero control surface).
  // Player UI V2 (Part 1, Phase 3A/3B): the media identity both optional
  // lookups key on — content type + TMDB id + season/episode. Source switches
  // do NOT change it (subtitles/intro belong to the MEDIA); episode switches
  // reload both.
  $: mediaLookupKey = `${content.type}:${content.id}:${currentEpisode?.season ?? ''}:${currentEpisode?.episode ?? ''}`;
  // Player UI V2 (Part 1, Phase 3B): the Skip Intro action targets the
  // verified segment containing the playhead (position-based, playing or
  // paused); the button renders only for it.
  $: activeSkipSegment = introSegments.find((segment) => currentTime >= segment.startSec && currentTime < segment.endSec - 0.25) ?? null;
  // Player UI V2 (Part 1, Phase 2A/2B): live indicator percentage for the
  // active gesture (effective volume shows 0 while muted).
  $: gesturePercent = gestureIndicator === 'brightness'
    ? gestureIndicatorPercent(brightness)
    : gestureIndicator === 'volume'
      ? gestureIndicatorPercent(muted ? 0 : volume)
      : 0;
  // MAVP-4 Issue 1: the veil covers the stage (below the message/loading
  // cards, above the iframe) while an embed is mounted but not yet
  // presenting. It unmounts together with the loading card at the reveal —
  // ONE coherent loading→player transition, no second loading state.
  $: embedVeilActive = Boolean(
    source?.type === 'embed' && source.url
    && !embedSurfacePresenting
    && !resolutionError && !errorMessage
    && state !== 'completed'
  );
  $: embedReady = Boolean(source?.type === 'embed' && isEmbedOriginAllowed(source) && !sourceIsExpired(source));
  // Phase 11 (GOAL D): the runtime applies the EFFECTIVE policy resolved
  // SERVER-side (source override → provider default → system default) and
  // carried on the resolved source (`sandboxRuntime`) — the client never
  // guesses. An intentionally unrestricted embed therefore renders NO
  // sandbox attribute, and the provider's own "sandbox" warning can no
  // longer contradict the admin configuration. (The former client-side
  // sandbox toggle + override were removed with the player control redesign.)
  $: sourceEffectiveSandboxPolicy = source ? source.sandboxRuntime?.effectiveSandboxPolicy ?? source.sandboxPolicy ?? 'required' : 'required';
  $: effectiveSandboxPolicy = source?.type === 'embed' ? sourceEffectiveSandboxPolicy : 'required';
  $: effectiveSandboxEnabled = effectiveSandboxPolicy !== 'unrestricted';
  // Phase 6 audit fix: reactive watcher for embed playback events. The watch
  // route pushes { type, _seq } into the embedPlaybackEvent prop whenever the
  // PlaybackManager receives a normalized provider play/pause/ended event.
  // The _seq counter forces Svelte to re-trigger the reactive block even if
  // the same event type fires twice in a row. PlayerShell acquires/releases
  // the Wake Lock conservatively — only when a reliable provider event arrives.
  $: if (embedPlaybackEvent?._seq && embedPlaybackEvent._seq !== lastEmbedPlaybackSeq) {
    lastEmbedPlaybackSeq = embedPlaybackEvent._seq;
    handleEmbedPlaybackEvent(embedPlaybackEvent);
  }
  $: if (source?.sourceId && source.sourceId !== sourceIdentity) {
    sourceIdentity = source.sourceId;
    // MAVP-5 (Issue 5): stamp the source-switch window — a fullscreen loss
    // within LANDSCAPE_RESTORE_WINDOW_MS of this stamp while the landscape
    // intent is active is the switch-triggered loss (see handleFullscreen).
    lastSourceSwitchAt = Date.now();
    // Phase 9: capture (re-stamp) the pending seek for the NEW source —
    // position-preserving switches keep working, and the new token makes
    // any older capture inapplicable.
    capturePendingSeek(pendingSeekState, currentTime, Date.now());
    errorMessage = '';
    playing = false;
    state = source.type === 'embed' ? 'embed-loading' : 'preparing';
    // Phase 10: any pending compatibility override belongs to the previous
    // source session — the new session starts direct.
    
    
    // Phase 11 (GOAL B7): a pending compat POLL from the old session is
    // invalidated too — its result can never touch the new session.
    
    // Phase 6: a genuinely new source session starts with the engine's
    // internal quality state cleared (the viewport re-dispatches fresh
    // levels once the new manifest is parsed). The AUTO default never
    // leaks a manual selection across sources.
    engineQuality = null;
    // Player V2 corrections: an in-flight tap gesture belongs to the OLD
    // source session — cancel it (restores 2× if a hold was active).
    tapGestureController?.cancel();
    // Phase 8: clear any previous embed load timeout, then start a new one
    // for embed sources. Direct sources don't need this — the <video> element
    // fires `error` on failure.
    clearEmbedLoadTimeout();
    // MAVP-4 Issue 1: every new embed source session restarts the
    // presentation gate (the new provider surface has not presented yet).
    clearEmbedPresentFailOpen();
    embedSurfacePresenting = false;
    embedSurfaceIdentity = source.type === 'embed' ? `${source.sourceId}:${source.url ?? ''}` : '';
    if (source.type === 'embed') startEmbedLoadTimeout(source.sourceId);
    // Phase 6 audit fix 2: reset embed playback state on source switch. The
    // new source's embedPlaying will be set only if a reliable normalized
    // 'play' event arrives. Also stamp the sourceId so stale events from
    // the old source can be rejected in handleEmbedPlaybackEvent.
    embedPlaying = false;
    embedEverPlayed = false;
    embedPlaybackSourceId = source.sourceId;
    // Phase 6: release wake lock + clear Media Session on source switch.
    // Wake lock is re-acquired when the new source starts playing (handlePlay
    // for direct, handleEmbedPlaybackEvent for embeds). Media Session metadata
    // is re-set in handleLoadedMetadata.
    void releaseWakeLock();
    clearMediaSession();
    // Phase 6: exit PiP if the active PiP element was Mavero's video. This
    // prevents the PiP window from showing stale video after a source switch.
    // Phase 5 fix: guard document access during SSR. The `document`
    // global is only available in the browser — accessing it during SSR
    // (which happens for series/anime watch pages) throws ReferenceError.
    // The `browser` import from $app/environment is the canonical guard.
    if (browser && document.pictureInPictureElement === videoElement) exitPipQuietly();
  }
  // MAVP-4 Issue 1: same-source URL change (episode switch — the resolver
  // rebuilds the embed URL for the new episode while sourceId stays equal).
  // The sourceId watcher above does NOT fire in this case, but the iframe
  // REMOUNTS (PlayerViewport's iframeKey includes the URL), so the shell
  // must restart the presentation gate exactly like a fresh source session:
  // back to 'embed-loading', veiled, with a fresh load timeout.
  $: if (source?.type === 'embed' && source.url && source.sourceId && source.sourceId === sourceIdentity) {
    const identity = `${source.sourceId}:${source.url}`;
    if (identity !== embedSurfaceIdentity) {
      embedSurfaceIdentity = identity;
      // MAVP-5 (Issue 5): same-source URL change (episode switch) remounts
      // the iframe too — stamp the switch window identically.
      lastSourceSwitchAt = Date.now();
      // Phase 9: re-stamp the pending seek for the NEW surface — the old
      // capture can never land on the remounted iframe.
      capturePendingSeek(pendingSeekState, currentTime, Date.now());
      errorMessage = '';
      playing = false;
      state = 'embed-loading';
      embedPlaying = false;
      embedEverPlayed = false;
      embedPlaybackSourceId = source.sourceId;
      // Player V2 corrections: same-source URL remount — kill the old
      // session's tap gesture (restores 2×) exactly like a source switch.
      tapGestureController?.cancel();
      void releaseWakeLock();
      clearMediaSession();
      clearEmbedLoadTimeout();
      clearEmbedPresentFailOpen();
      embedSurfacePresenting = false;
      startEmbedLoadTimeout(source.sourceId);
    }
  }
  // Phase 6: episode switch cleanup. PlayerShell stays mounted across episode
  // changes (only props change), so we must release wake lock + clear Media
  // Session + exit PiP here. The new episode's source will re-acquire them.
  $: if (currentEpisode && `${currentEpisode.season}:${currentEpisode.episode}` !== episodeIdentity) {
    episodeIdentity = `${currentEpisode.season}:${currentEpisode.episode}`;
    // Player V2 final remediation (Issue 5): the PREVIOUS episode's media
    // duration must not survive the switch. The intro lookup is gated on
    // `duration > 0` + a changed mediaLookupKey — with the stale duration
    // still set, the NEW episode's lookup fired immediately against the OLD
    // episode's duration (wrong durationMs hint to TheIntroDB + wrong
    // validation bound) and, because introKey then equaled mediaLookupKey,
    // NEVER re-ran when the real duration arrived (permanently suppressing
    // or corrupting Skip Intro for the new episode). Resetting the duration
    // makes the lookup wait for the NEW episode's actual metadata. The
    // buffered watermark resets with it (the old buffer is meaningless for
    // the new timeline).
    duration = 0;
    buffered = 0;
    // Player V2 final remediation (Issue 3): the new episode gets a fresh
    // auto-resume window (a user seek in the PREVIOUS episode must not
    // cancel the new episode's resume) and a fresh user-seek marker.
    resumeDecidedForKey = '';
    userSeekedBeforeResume = false;
    // Phase 8: clear embed load timeout on episode switch — the new episode
    // will start its own timeout when its source loads.
    clearEmbedLoadTimeout();
    // MAVP-4 Issue 1: a pending presentation fail-open belongs to the
    // previous embed surface — it must never fire across an episode switch.
    clearEmbedPresentFailOpen();
    // Phase 6 audit fix 2: reset embed playback state on episode switch.
    embedPlaying = false;
    embedEverPlayed = false;
    if (source?.sourceId) embedPlaybackSourceId = source.sourceId;
    // Player V2 corrections: an episode switch ends the previous session's
    // tap gesture (restores 2×).
    tapGestureController?.cancel();
    void releaseWakeLock();
    clearMediaSession();
    // Phase 5 fix: guard document access during SSR. The `document`
    // global is only available in the browser — accessing it during SSR
    // (which happens for series/anime watch pages) throws ReferenceError.
    // The `browser` import from $app/environment is the canonical guard.
    if (browser && document.pictureInPictureElement === videoElement) exitPipQuietly();
  }

  // ----- Player V2 final remediation (Issue 3): DELAYED RESUME APPLICATION -----
  //
  // The watch route renders this shell IMMEDIATELY (player startup redesign)
  // while the saved progress record is still loading asynchronously
  // (IndexedDB + cloud sync in setupProgressContext). The `initialProgress`
  // prop therefore arrives as 0 and is updated to the saved position AFTER
  // mount — but both consumers of that value were one-time initializations
  // (`let currentTime = initialProgress` and
  // `createPendingSeek(initialProgress)`), so the updated prop reached
  // NOTHING and every direct playback session started at 00:00 (the
  // reported regression; the empty pending seek also let the new session's
  // near-zero timeupdate events overwrite the saved record through the
  // progress writer).
  //
  // This reactive gate propagates the LATE prop value through the exact
  // existing resume machinery (no new seek path):
  //   * ONE decision per media identity (mediaLookupKey = type:id:s:e) —
  //     no reactive loop (the block depends on initialProgress, writes
  //     only currentTime/pendingSeekState), and a title/episode switch
  //     reopens the gate for the NEW media (the route resets resumeTime to
  //     0 on episode change, so the block stays dormant until the new
  //     episode's real position arrives).
  //   * `0` never captures (createPendingSeek/capturePendingSeek contract)
  //     — mounting with initialProgress=0 cannot seek to zero.
  //   * User-safety guard: if the playhead has ALREADY moved past the saved
  //     position by the time a late response lands, the saved position is
  //     stale for this session — it is marked decided WITHOUT seeking (no
  //     yanking the user backwards). A position still ahead of the playhead
  //     applies normally (the user cannot have legitimately passed a
  //     position they have not reached).
  //   * The pending-seek state machine retains the target until the media
  //     is actually seekable (HLS VOD readiness) and applies it through the
  //     bounded retry chain (applyPendingSeekToElement below) — the same
  //     proven Phase 9 path used by source switches.
  let resumeDecidedForKey = '';
  // Any deliberate user position change (timeline, ±10 s, keyboard,
  // double-tap) cancels the pending auto-resume for the CURRENT media —
  // once the user has chosen a position themselves, a late-arriving saved
  // position must never yank them elsewhere. Reset per media (episode
  // switch block) so the next episode's resume still applies.
  let userSeekedBeforeResume = false;

  function applyDelayedResume(saved: number) {
    if (!Number.isFinite(saved) || saved <= 0) return; // 0 = no record yet — never seek
    const key = mediaLookupKey;
    if (resumeDecidedForKey === key) return; // one resume decision per media
    resumeDecidedForKey = key;
    // The user already picked a position themselves → their choice wins.
    if (userSeekedBeforeResume) return;
    // The playhead already moved meaningfully past the saved position →
    // the record is stale for this session; never seek back over the user.
    if (currentTime > 30 && currentTime >= saved - 1) return;
    capturePendingSeek(pendingSeekState, saved, Date.now());
    currentTime = saved;
    // The element may already be ready (progress raced the metadata): apply
    // immediately; otherwise the lifecycle retry chain applies it as soon
    // as the stream is seekable.
    applyPendingSeekToElement();
  }
  $: if (initialProgress > 0) applyDelayedResume(initialProgress);

  // Phase 6 audit fix: PiP events fire on the HTMLVideoElement, NOT on
  // document. The handler and listener attachment are at the top level of the
  // instance script (NOT inside onMount) so that the reactive block
  // `$: attachPipListeners(videoElement)` can track the actual videoElement
  // lifecycle. This correctly handles:
  //   - embed → direct (videoElement goes from undefined → <video>)
  //   - direct → embed (videoElement goes from <video> → undefined)
  //   - embed → direct → embed → direct (no duplicate listeners)
  // The reactive block detaches from the old element and attaches to the
  // new element whenever the identity of videoElement changes.
  let lastPipVideoElement: HTMLVideoElement | undefined = undefined;
  function handlePictureInPicture() { pictureInPicture = document.pictureInPictureElement === videoElement; }
  /**
   * Player redesign QA hardening: fire-and-forget PiP/fullscreen exit. The DOM
   * methods return PROMISES that REJECT when there is nothing to exit (no
   * active PiP element / no active fullscreen — e.g. a source switch racing
   * an already-exited session). That is an expected no-op: the synchronous
   * try/catch alone cannot stop an unhandled rejection.
   */
  function exitPipQuietly() {
    try { Promise.resolve(document.exitPictureInPicture?.()).catch(() => { /* already exited */ }); } catch { /* already exited */ }
  }
  function exitFullscreenQuietly() {
    try { Promise.resolve(document.exitFullscreen?.()).catch(() => { /* already exited */ }); } catch { /* already exited */ }
  }
  function attachPipListeners(current: HTMLVideoElement | undefined) {
    if (current === lastPipVideoElement) return; // no change — avoid duplicates
    // Detach from the previous video element (if any).
    if (lastPipVideoElement) {
      try {
        lastPipVideoElement.removeEventListener('enterpictureinpicture', handlePictureInPicture);
        lastPipVideoElement.removeEventListener('leavepictureinpicture', handlePictureInPicture);
      } catch { /* already removed */ }
    }
    // Attach to the new video element (if any).
    if (current) {
      current.addEventListener('enterpictureinpicture', handlePictureInPicture);
      current.addEventListener('leavepictureinpicture', handlePictureInPicture);
      // Sync active state immediately — the new video might already be in PiP.
      pictureInPicture = document.pictureInPictureElement === current;
    } else {
      pictureInPicture = false;
    }
    lastPipVideoElement = current;
  }
  // Reactive attachment: runs whenever videoElement identity changes.
  $: attachPipListeners(videoElement);
  function detachPictureInPictureListeners() {
    if (lastPipVideoElement) {
      try {
        lastPipVideoElement.removeEventListener('enterpictureinpicture', handlePictureInPicture);
        lastPipVideoElement.removeEventListener('leavepictureinpicture', handlePictureInPicture);
      } catch { /* already removed */ }
      lastPipVideoElement = undefined;
    }
  }

  const handleFullscreen = () => {
    fullscreen = document.fullscreenElement === playerRoot;
    // Focused fixes (Issue 1): native VIDEO fullscreen hands the surface to
    // the OS — subtitles flip back to the native painter there (the overlay
    // could never paint over a fullscreened <video> element).
    nativeVideoFullscreen = document.fullscreenElement === videoElement;
    if (!fullscreen && landscapeMode) {
      // MAVP-5 (Issue 5): a fullscreen loss WITHIN the source-switch window
      // while the user's landscape intent is active is the switch-triggered
      // loss (the iframe remount dropped the focused element inside the
      // fullscreen element). Restore the presentation ONCE instead of
      // reverting to portrait: re-acquire Mavero fullscreen + re-issue the
      // landscape lock (bounded by landscapeRestoreInFlight — never a
      // duplicate lock request loop); if the platform declines, the CSS
      // landscape presentation remains (`.landscape-mode` does not require
      // fullscreen). The intent stays active until an explicit user exit.
      if (landscapePresentationIntent && lastSourceSwitchAt > 0 && Date.now() - lastSourceSwitchAt <= LANDSCAPE_RESTORE_WINDOW_MS) {
        void restoreLandscapePresentationOnce();
        return;
      }
      // Phase 6: browser-initiated fullscreen exit (Esc / F11 / navigation)
      // must release the orientation lock explicitly. The Screen Orientation
      // API spec says the browser auto-releases the lock when the document
      // exits fullscreen, but some browsers leave a stale lock — calling
      // unlock() is safe (it's a no-op if the lock was already released).
      try { orientationController()?.unlock?.(); } catch { /* unsupported */ }
      landscapeMode = false;
      revealControls();
    }
  };

  /** MAVP-5 (Issue 5): ONE bounded re-acquisition attempt per fullscreen loss. */
  async function restoreLandscapePresentationOnce() {
    if (landscapeRestoreInFlight) return;
    landscapeRestoreInFlight = true;
    try {
      if (document.fullscreenElement !== playerRoot) {
        try { await playerRoot?.requestFullscreen?.(); } catch { /* declined — the CSS landscape presentation remains */ }
      }
      try { await orientationController()?.lock?.('landscape'); } catch { /* device/browser declined; CSS presentation remains */ }
      revealControls();
    } finally {
      landscapeRestoreInFlight = false;
    }
  }

  // ----- Player UI V2 (Part 1): optional lookups + touch gestures -----
  //
  // External subtitles (3A) and intro timestamps (3B) are strictly OPTIONAL
  // lookups: both are fire-and-forget (playback never awaits them), both
  // discard stale results by media key, and both degrade to "feature off"
  // without any user-visible error. The gesture controller (2A/2B/2C) owns
  // the left/right vertical swipes and is gated per-touch by enabled() so the
  // touch lock, embed ownership and open sheets always take effect instantly.

  const externalSubtitleController = createExternalSubtitleController();
  const introLookup = createIntroLookup();

  /** TMDB ids: the same canonical shape the server-side adapters validate. */
  const TMDB_ID_PATTERN = /^[1-9][0-9]{0,15}$/;

  /**
   * Player V2 remaining fixes (2026-10): resolves the item's NUMERIC TMDB id
   * for the optional external lookups (VDRK subtitles / TheIntroDB).
   *
   * ROOT CAUSE FIXED HERE: production catalog ids are PREFIXED
   * (`movie-24428`, `series-236235` — the TMDB adapter's normalized shape),
   * so the previous bare-numeric gate rejected EVERY production title and
   * both lookups died silently ("No subtitles available" with no request
   * ever issued; no Skip Intro). Resolution order:
   *   1. `content.tmdbId` — the authoritative external id the watch route
   *      forwards from `item.externalIds.tmdb`;
   *   2. a BARE numeric catalog id (legacy fixtures) — unchanged behavior;
   *   3. the codebase-standard prefix strip (`^(movie|series)-`) — the same
   *      defensive shape the TMDB adapter itself uses for its own lookups.
   * Returns null when no trustworthy TMDB id exists (fixture/non-TMDB
   * content) — the lookups then honestly report "no data" (never a
   * fabricated request).
   */
  function resolveContentTmdbId(): number | null {
    const explicit = String(content.tmdbId ?? '').trim();
    if (TMDB_ID_PATTERN.test(explicit)) return Number.parseInt(explicit, 10);
    const raw = String(content.id ?? '');
    if (TMDB_ID_PATTERN.test(raw)) return Number.parseInt(raw, 10);
    const stripped = raw.replace(/^(movie|series|anime)-/, '');
    if (stripped !== raw && TMDB_ID_PATTERN.test(stripped)) return Number.parseInt(stripped, 10);
    return null;
  }

  async function loadExternalSubtitles(key: string) {
    // The TMDB id is the content id on the TMDB pipeline; a non-TMDB id (or a
    // movie context for a series route) silently disables the feature.
    const tmdbId = resolveContentTmdbId();
    if (tmdbId === null) {
      externalSubtitleStatus = 'empty';
      externalSubtitleNotice = 'No subtitles available';
      externalSubtitleError = null;
      return;
    }
    const kind: 'movie' | 'tv' = content.type === 'movie' ? 'movie' : 'tv';
    const request: ExternalSubtitleRequest = kind === 'tv'
      ? { kind, tmdbId, season: currentEpisode?.season, episode: currentEpisode?.episode }
      : { kind, tmdbId };
    externalSubtitleStatus = 'loading';
    externalSubtitleNotice = 'Checking subtitles…';
    // Player V2 remaining fixes (2026-10): the stale guard must compare in
    // the CONTROLLER's key space. The shell previously passed its
    // `mediaLookupKey` (`movie:24428::` / `series:236235:2:1`) while the
    // controller computes `movie:24428` / `tv:236235:2:1` — the two never
    // matched, so `result.superseded` was TRUE for every response and every
    // validated track list was dropped before it could attach (the menu
    // stayed on "Checking subtitles…" forever). The controller key for the
    // CURRENT request is now the caller key; staleness across title/episode
    // switches stays owned by the shell's own mediaLookupKey guard below.
    const requestKey = externalSubtitleRequestKey(request);
    const result = await externalSubtitleController.load(request, requestKey);
    // Stale-response guard: only the CURRENT media's result may attach.
    if (key !== externalSubtitlesKey || result.key !== requestKey || result.superseded) return;
    externalSubtitles = result.tracks;
    externalSubtitleError = result.error;
    if (result.error === null) {
      externalSubtitleStatus = result.tracks.length ? 'ready' : 'empty';
      externalSubtitleNotice = result.tracks.length ? '' : 'No subtitles available';
    } else {
      externalSubtitleStatus = 'failed';
      externalSubtitleNotice = 'Subtitles unavailable';
    }
    // Safe diagnostic line (Player V2 corrections Phase 2C): state, track
    // count and typed failure kind only — never URLs, provider payloads or
    // credentials. Makes the reported "no subtitle controls" diagnosable
    // from the field (not-initialized / pending / empty / failed / ready).
    console.info(`[mavero:subtitles] ${kind} tmdb=${tmdbId} status=${externalSubtitleStatus} tracks=${result.tracks.length}${result.error ? ` error=${result.error}` : ''}`);
  }

  async function loadIntro(key: string) {
    // Same TMDB-id resolution as the subtitle lookup (see resolveContentTmdbId
    // — the prefixed production catalog id previously killed this lookup at
    // the gate for every title).
    const tmdbId = resolveContentTmdbId();
    if (tmdbId === null) {
      introStatus = 'no-data';
      introErrorKind = null;
      return;
    }
    const kind: 'movie' | 'tv' = content.type === 'movie' ? 'movie' : 'tv';
    const durationSec = duration > 0 ? duration : null;
    const request: IntroMediaRequest = kind === 'tv'
      ? { kind, tmdbId, season: currentEpisode?.season, episode: currentEpisode?.episode, durationSec }
      : { kind, tmdbId, durationSec };
    introStatus = 'loading';
    // Player V2 remaining fixes (2026-10): stale guard in the CONTROLLER's
    // key space (see loadExternalSubtitles) — the shell's mediaLookupKey
    // (`series:236235:2:1`) could never equal the controller's `tv:…` key,
    // so every intro result was superseded+dropped and Skip Intro could
    // never render. Staleness across episode switches stays with the
    // shell's own mediaLookupKey guard.
    const requestKey = introRequestKey(request);
    const result = await introLookup.getIntroSegments(request, requestKey);
    if (key !== introKey || result.key !== requestKey || result.superseded) return;
    introSegments = result.segments;
    introErrorKind = result.errorKind;
    introStatus = result.segments.length ? 'available' : result.errorKind ? 'unavailable' : 'no-data';
    // Safe diagnostic line (Phase 2C): state + typed failure kind only. The
    // API is IP-blocked from some networks (Cloudflare) — 'unavailable' with
    // a typed kind makes that distinguishable from 'no-data' in the field.
    console.info(`[mavero:intro] ${kind} tmdb=${tmdbId} status=${introStatus}${introErrorKind ? ` error=${introErrorKind}` : ''} segments=${result.segments.length}`);
  }

  $: if (browser && mediaLookupKey !== externalSubtitlesKey) {
    externalSubtitlesKey = mediaLookupKey;
    externalSubtitles = [];
    void loadExternalSubtitles(mediaLookupKey);
  }
  // Intro lookup waits for a trustworthy ACTUAL playback duration (the media
  // element's duration — the catalog runtime is never substituted).
  $: if (browser && duration > 0 && mediaLookupKey !== introKey) {
    introKey = mediaLookupKey;
    introSegments = [];
    void loadIntro(mediaLookupKey);
  }

  // ----- Player UI V2 (Part 2, Phase 4): Google Cast wiring -----
  //
  // The Cast action appears ONLY when every gate passes for the ACTIVE
  // source: static eligibility (direct, no header binding, known
  // receiver-compatible format, unexpired URL) + a CORS probe of the actual
  // media URL (the receiver fetches the media itself — CORS is required for
  // adaptive streaming per the official docs) + SDK availability. Anything
  // that fails any gate simply never shows a Cast button — playback and
  // source selection are untouched (Cast unavailable = current behavior).

  function ensureCastController() {
    if (!browser || castController) return castController;
    castController = createCastController({
      onStateChange: (next) => {
        castState = next;
        castConnected = next.connection === 'connected';
        if (next.connection === 'connected' && next.media) mirrorRemoteMedia(next.media);
        if ((next.connection === 'disconnected' || next.connection === 'error') && castWasConnected) handleCastSessionEnded();
        if (next.connection === 'connected') castWasConnected = true;
      },
    });
    return castController;
  }

  // Handles the connected→disconnected transition exactly once.
  let castWasConnected = false;

  /** Mirrors remote media state into the shell's existing timeline/progress pipeline. */
  function mirrorRemoteMedia(media: { currentTime: number; duration: number; playing: boolean; playerState: string }) {
    currentTime = media.currentTime;
    // Phase 5: remote duration must be finite+positive too (live receivers
    // report Infinity — never adopt it as a VOD duration).
    if (Number.isFinite(media.duration) && media.duration > 0) duration = media.duration;
    playing = media.playing;
    if (media.playing) state = 'playing';
    else if (state === 'playing') state = 'paused';
    // Remote 'ended' detection: the receiver reports IDLE once the media
    // finished (currentTime reached the duration). Emit ONE completion.
    if (media.playerState === 'IDLE' && media.duration > 0 && media.currentTime >= media.duration - 0.5 && !castEndedEmitted) {
      castEndedEmitted = true;
      playing = false;
      state = 'completed';
      emitProgress('ended');
    } else if (media.playing && currentTime - castLastProgressReport >= 5) {
      castLastProgressReport = currentTime;
      emitProgress('progress');
    }
  }

  /** Local teardown of the cast mirror when the session goes away. */
  function handleCastSessionEnded() {
    castWasConnected = false;
    castConnected = false;
    castEndedEmitted = false;
    castLastProgressReport = 0;
    playing = false;
    if (state === 'playing') state = 'paused';
    // Return the local timeline to the last position the receiver reported
    // (already mirrored into `currentTime`). Apply it to the paused local
    // element so resuming locally continues where casting left off.
    if (videoElement && Number.isFinite(currentTime) && currentTime > 0) {
      try { videoElement.currentTime = clampSeek(currentTime, videoElement.duration || duration); } catch { /* teardown race — pending-seek machinery still applies */ }
    }
    emitProgress('pause');
    revealControls();
  }

  /** The Cast button: starts a session (device picker) or stops casting. */
  async function handleCastAction() {
    const controller = ensureCastController();
    if (!controller) return;
    if (castConnected) {
      controller.stopCasting();
      return;
    }
    if (!castEligibility?.eligible || !sourceReady) return;
    // No duplicate local+remote playback: pause the local element first.
    // (Also ends any active 2× hold — the hold is a LOCAL surface gesture.)
    handleHoldEnd();
    if (videoElement && !videoElement.paused) {
      videoElement.pause();
      playing = false;
    }
    releaseWakeLock();
    try {
      await controller.initialize();
      await controller.requestCast({
        url: castEligibility.url,
        contentType: castEligibility.contentType,
        title: content.title,
        currentTime,
      });
    } catch {
      // Picker cancelled / no device / load failure — restore the idle UI.
      // Local playback stays PAUSED at the pre-cast position (honest state).
      castConnected = false;
      if (state === 'playing') state = 'paused';
      errorMessage = 'Casting did not start. The local player stays paused.';
    }
  }

  // Reactive: re-evaluate eligibility + probe + SDK whenever the ACTIVE
  // source changes. Any gate failure keeps castReady false (button hidden).
  $: if (browser) {
    const evaluation = evaluateCastEligibility(source);
    castEligibility = evaluation;
    if (!evaluation.eligible) {
      castReady = false;
      castProbeDoneFor = '';
    } else if (castProbeDoneFor !== evaluation.url) {
      castProbeDoneFor = evaluation.url;
      castReady = false;
      const controller = ensureCastController();
      void (async () => {
        if (!controller) return;
        const [probeOk] = await Promise.all([probeMediaCastability(evaluation.url), controller.initialize()]);
        // Guard: the source may have changed while probing.
        if (castEligibility?.eligible && castEligibility.url === evaluation.url) castReady = probeOk;
      })();
    }
    if (!evaluation.eligible && castConnected) castController?.stopCasting();
  }

  // A source or episode switch while casting would leave the receiver playing
  // the OLD media with no controlling session — end the session immediately
  // (the media keeps playing on the TV until the session ends; the local
  // player then resumes normal control). First run is ignored.
  let castSwitchKey = '';
  $: {
    const switchKey = `${source?.sourceId ?? ''}|${mediaLookupKey}`;
    if (castSwitchKey === '') {
      castSwitchKey = switchKey;
    } else if (castSwitchKey !== switchKey) {
      castSwitchKey = switchKey;
      if (castConnected && castController) castController.stopCasting();
    }
  }

  function handleGestureStart(gesture: GestureKind) {
    if (gestureIndicatorHideTimer) clearTimeout(gestureIndicatorHideTimer);
    gestureIndicatorHideTimer = undefined;
    gestureIndicator = gesture;
  }

  function handleGestureEnd(gesture: GestureKind, _totalDelta: number) {
    // One polite announcement per completed gesture (visual indicator hides
    // shortly after; the visual itself is aria-hidden).
    gestureAnnouncement = gesture === 'brightness' ? `Brightness ${gestureIndicatorPercent(brightness)}%` : `Volume ${gestureIndicatorPercent(muted ? 0 : volume)}%`;
    if (gestureIndicatorHideTimer) clearTimeout(gestureIndicatorHideTimer);
    gestureIndicatorHideTimer = setTimeout(() => {
      gestureIndicatorHideTimer = undefined;
      gestureIndicator = null;
    }, 600);
  }

  // ----- Player V2 corrections: tap gestures (double-tap seek + hold 2×) -----
  //
  // The controller enforces target/lock/sheet eligibility per touch; the
  // shell owns the actions: double-tap → clamped ±10 s seek + transient
  // direction feedback; hold → 2× with EXACT restore of the previous speed.

  function showSeekFeedback(direction: TapSeekDirection) {
    seekFeedback = direction;
    gestureAnnouncement = direction === 'backward' ? 'Rewound 10 seconds' : 'Skipped forward 10 seconds';
    if (seekFeedbackTimer) clearTimeout(seekFeedbackTimer);
    seekFeedbackTimer = setTimeout(() => {
      seekFeedbackTimer = undefined;
      seekFeedback = null;
    }, 650);
  }

  function handleDoubleTap(direction: TapSeekDirection) {
    if (!sourceReady || source?.type !== 'direct') return;
    seekBy(direction === 'backward' ? -10 : 10);
    showSeekFeedback(direction);
  }

  function handleHoldStart() {
    if (holdSpeedActive || !sourceReady || source?.type !== 'direct') return;
    holdSpeedActive = true;
    savedPlaybackRate = playbackRate;
    setPlaybackRate(2);
    gestureAnnouncement = 'Playback speed 2×';
  }

  /** Exact restore of the pre-hold speed — every exit path routes here. */
  function handleHoldEnd() {
    if (!holdSpeedActive) return;
    holdSpeedActive = false;
    setPlaybackRate(savedPlaybackRate);
    gestureAnnouncement = `Playback speed ${savedPlaybackRate}×`;
  }

  function toggleTouchLock() {
    touchLocked = !touchLocked;
    if (touchLocked) {
      // Locked: controls stay hidden; taps/swipes are inert (the gesture
      // controllers' enabled() gates + the reveal gate below). An in-flight
      // tap gesture (pending double-tap / active hold) dies immediately —
      // the 2× speed can never survive a lock engagement.
      tapGestureController?.cancel();
      controlsVisible = false;
      if (hideTimer) clearTimeout(hideTimer);
    } else {
      revealControls();
    }
  }

  onMount(() => {
    // Player startup instrumentation: the shell is visible. Measured spans
    // are DEV-only logged; marks remain inspectable in production.
    markPlayerMilestone('mavero:shell');
    measurePlayerStartup();
    // Focused fixes (Issues 1+2): load the saved subtitle preferences once
    // (safe defaults on SSR/private mode/corrupt payloads — never throws).
    subtitlePrefs = loadSubtitlePreferences();
    // MAVP-4 Issue 2: explicit document scroll lock for the player route —
    // the watch page renders bare (no AppShell) and the shell is exactly
    // 100dvh, but the document kept its default scroll behaviour, so browser
    // UI transitions and overscroll could scroll the page behind the player.
    // The project's established convention is an html data-attribute
    // (html[data-admin-sheet-open], html[data-a2-sheet-open] → body
    // overflow: hidden in app.css); the player follows the same pattern.
    // Set on mount, removed on destroy — never a global change.
    document.documentElement.setAttribute('data-player-open', '');
    // Player UI V2 (Part 1, Phase 2): touch gestures over the player surface.
    // The controller is created ONCE per mount and destroyed in cleanup (no
    // duplicate listeners across mount cycles); per-touch gating below makes
    // the lock, embed ownership and sheets take effect without re-attaching.
    gestureController = createPlayerGestureController({
      surface: playerRoot,
      // Phase 4: while casting, the local surface is a paused mirror of the
      // receiver — swipes would adjust local-only brightness/volume, so the
      // gestures gate off entirely until the session ends.
      // Focused fixes (Issue 3): an open controls selection sheet also gates
      // the gestures off (the sheet owns every tap inside it).
      enabled: () => !touchLocked && source?.type === 'direct' && !sourceMenuOpen && !episodeMenuOpen && !controlsSheetsOpen && sourceReady && !castConnected,
      onBrightnessDelta: (delta) => { brightness = clampBrightness(brightness + delta); },
      onVolumeDelta: (delta) => { setVolume(volume + delta); },
      onGestureStart: handleGestureStart,
      onGestureEnd: handleGestureEnd,
    });
    // Player V2 corrections: double-tap seek + press-and-hold 2×. Same
    // per-touch eligibility gate as the swipe controller (touch lock, direct
    // ownership, sheets, cast) plus the interactive-target exclusion inside
    // the controller — buttons, the seekbar, selects and sheets never trigger
    // a double-tap or a 2× hold.
    tapGestureController = createPlayerTapGestureController({
      surface: playerRoot,
      enabled: () => !touchLocked && source?.type === 'direct' && !sourceMenuOpen && !episodeMenuOpen && !controlsSheetsOpen && sourceReady && !castConnected,
      onDoubleTap: handleDoubleTap,
      onHoldStart: handleHoldStart,
      onHoldEnd: handleHoldEnd,
    });
    pictureInPictureSupported = Boolean(document.pictureInPictureEnabled && videoElement && 'requestPictureInPicture' in videoElement);
    // Immersive redesign: responsive viewport detection for source sheet placement.
    // compact (portrait) → bottom sheet; wide (landscape/desktop/TV) → right drawer.
    // Based on actual viewport width, NOT on landscapeMode toggle.
    //
    // Phase 2-I (PLR-02): the previous implementation registered a
    // `change` listener on viewportMediaQuery but NEVER removed it in the
    // onMount cleanup. Over a long-lived session with many PlayerShell
    // mount/unmount cycles (e.g. navigating between watch pages), this
    // leaked listeners on the MediaQueryList — each new mount added a new
    // listener, none were removed, and the old listeners kept firing
    // handleViewportChange on viewport changes, calling setState on a
    // destroyed component. Now we hoist the handler into the onMount
    // scope so the cleanup can remove it, matching the existing pattern
    // used for handleFullscreen / handleKeydown / showControls.
    let handleViewportChange: ((e: MediaQueryListEvent) => void) | undefined;
    if (typeof window !== 'undefined' && window.matchMedia) {
      viewportMediaQuery = window.matchMedia('(min-width: 769px)');
      isWideViewport = viewportMediaQuery.matches;
      handleViewportChange = (e: MediaQueryListEvent) => { isWideViewport = e.matches; };
      viewportMediaQuery.addEventListener('change', handleViewportChange);
    }
    // Phase 6: detect Wake Lock + Media Session support at mount, matching the
    // existing pictureInPictureSupported pattern (Boolean coercion, no try/catch,
    // optional chaining on every API call).
    wakeLockSupported = Boolean('wakeLock' in navigator && (navigator as WakeLockNavigator).wakeLock?.request);
    mediaSessionSupported = Boolean('mediaSession' in navigator && (navigator as MediaSessionNavigator).mediaSession);
    // Phase 6: register Media Session action handlers for DIRECT playback only.
    // Embed sources cannot be commanded reliably (except CineSrc, but the
    // postMessage round-trip makes Media Session state updates unreliable).
    if (mediaSessionSupported) registerMediaSessionHandlers();
    // MAVP-2 Phase 5: track the REAL viewport orientation so per-orientation
    // position profiles switch the moment the device rotates — including when
    // the orientation LOCK was declined and the OS auto-rotated on its own.
    let handleOrientationChange: ((e: MediaQueryListEvent) => void) | undefined;
    if (typeof window !== 'undefined' && window.matchMedia) {
      orientationMediaQuery = window.matchMedia('(orientation: landscape)');
      playerOrientation = orientationMediaQuery.matches ? 'landscape' : 'portrait';
      handleOrientationChange = (e: MediaQueryListEvent) => { playerOrientation = e.matches ? 'landscape' : 'portrait'; };
      orientationMediaQuery.addEventListener('change', handleOrientationChange);
    }
    // MAVP-3 Issue 1: the automatic landscape-first attempt that previously
    // ran here (ONE best-effort playerRoot fullscreen + orientation lock on
    // portrait mobile/tablet-class mounts) was REMOVED — playback must open
    // in the device's existing orientation on every entry path (card, detail
    // page, Continue Watching, episode links, programmatic navigations). The
    // manual Landscape control and the F-key fullscreen remain the only
    // fullscreen/orientation entry points; no hidden fallback re-introduces
    // automatic rotation after navigation or iframe mounting.
    const handleKeydown = (event: KeyboardEvent) => {
      // Phase 8: sheet focus trap + Escape takes priority over player shortcuts.
      if (sourceMenuOpen || episodeMenuOpen) {
        handleSheetKeydown(event);
        return;
      }
      // Focused fixes (Issue 3): while a controls selection sheet is open, the
      // sheet's own handler owns Escape/Tab (PlayerOptionSheet); Mavero player
      // shortcuts and fullscreen keys stand down entirely.
      if (controlsSheetsOpen) return;
      const target = event.target as HTMLElement | null;
      // Never intercept shortcuts while typing in form fields or editable
      // surfaces (input/textarea/select/contenteditable).
      if (target?.matches('input, select, textarea, [contenteditable="true"]')) return;
      // Player UI V2 (Part 1, Phase 2C): the touch lock disables Mavero's
      // keyboard shortcuts as well — the lock means "no further input into
      // the player". Escape keeps its fullscreen-exit semantics, the unlock
      // FAB stays visible/clickable, and the Back FAB is never blocked
      // (essential navigation is never trapped).
      if (touchLocked) {
        if (event.key === 'Escape' && document.fullscreenElement === playerRoot) {
          event.preventDefault();
          void exitMaveroFullscreen();
        }
        return;
      }
      // MAVP-2 Phase 3: ANY key press outside editable surfaces is user
      // activity — TV remotes and keyboard users navigate with keys that are
      // NOT Mavero shortcuts (channel/volume/scroll keys); all of them must
      // reveal the controls and reset the inactivity deadline.
      revealControls();
      // Player redesign shortcuts — available for BOTH direct and embed
      // sources (Mavero owns these surfaces; they do not command the video
      // element or the provider):
      //   Escape → close an open sheet (above); otherwise exit Mavero
      //     fullscreen when the SHELL owns fullscreen; otherwise the browser's
      //     expected navigation behaviour is preserved (no preventDefault).
      //   F      → toggle Mavero fullscreen (playerRoot), all sources.
      //   S      → open the source selector sheet, all sources.
      if (event.key === 'Escape') {
        if (document.fullscreenElement === playerRoot) {
          event.preventDefault();
          void exitMaveroFullscreen();
        }
        return;
      }
      if (event.repeat) return; // toggles must not machine-gun on key repeat
      if (event.key === 'f' || event.key === 'F') {
        event.preventDefault();
        void toggleFullscreen();
        return;
      }
      if (event.key === 's' || event.key === 'S') {
        if (sourceOptions.length) {
          event.preventDefault();
          openSourceSheet(playerRoot ?? (document.activeElement instanceof HTMLElement ? document.activeElement : playerRoot));
        }
        return;
      }
      // Direct-playback-only shortcuts — they command the <video> element.
      if (source?.type !== 'direct') return;
      // Don't hijack Space on a focused button (double activation).
      if (target?.matches('button')) return;
      if (event.key === ' ' || event.key.toLowerCase() === 'k') { event.preventDefault(); void togglePlay(); }
      else if (event.key === 'ArrowLeft') { event.preventDefault(); seekBy(-10); }
      else if (event.key === 'ArrowRight') { event.preventDefault(); seekBy(10); }
      else if (event.key.toLowerCase() === 'm') { event.preventDefault(); toggleMute(); }
    };
    // Player redesign: ONE authoritative inactivity timer. All interaction
    // signals (pointer move, pointer down, touch, focus) route through
    // `revealControls` — there is no duplicate timer body here.
    // `revealControls` clears any pending hideTimer and starts a fresh
    // 5-second countdown, gated by the sheet-open and focus-in-controls
    // guards so an open sheet or a focused control is never auto-hidden.
    const showControls = () => { revealControls(); };
    const handleFocusIn = (event: FocusEvent) => {
      // Keyboard/tv-navigation activity: focusing any Mavero-owned surface
      // inside the shell counts as user activity and keeps controls visible.
      if (event.target instanceof Node && playerRoot?.contains(event.target)) revealControls();
    };
    // MAVP-2 Phase 3: reveal on iframe-tap. When the user taps/clicks INSIDE
    // a provider embed, the iframe takes focus and the PARENT window fires
    // `blur` with document.activeElement === the iframe — the only honest,
    // cross-origin-safe signal that touch activity happened inside the
    // embed. Without it, controls that auto-hid during embed playback could
    // never be revealed again on touch-only devices (pointer/touch events
    // inside a cross-origin iframe are unobservable — documented limitation).
    // Non-iframe blurs (tab switches, address bar) are filtered out; the
    // listener never touches the iframe's DOM or contentWindow.
    // MAVP-4 Issue 1: the same signal is a presentation reveal — a tap into
    // the embed (e.g. pressing the provider's play button) proves the
    // provider surface is interactive, so the loading card + veil unmount.
    const handleWindowBlur = () => {
      const active = document.activeElement;
      if (active instanceof HTMLIFrameElement && playerRoot?.contains(active)) {
        revealEmbedSurface();
        revealControls();
      }
    };
    // MAVP-3 Issue 2: reveal when the user RETURNS to this document while the
    // embed holds focus (tab/app switch back). Returning to a playing embed
    // is genuine user activity and the controls must not stay stuck hidden —
    // this is the "returning from an iframe" recovery path.
    // MAVP-4 Issue 1: also a presentation reveal (same reasoning as blur).
    const handleWindowFocus = () => {
      const active = document.activeElement;
      if (active instanceof HTMLIFrameElement && playerRoot?.contains(active)) {
        revealEmbedSurface();
        revealControls();
      }
    };
    document.addEventListener('fullscreenchange', handleFullscreen);
    window.addEventListener('keydown', handleKeydown);
    window.addEventListener('blur', handleWindowBlur);
    window.addEventListener('focus', handleWindowFocus);
    document.addEventListener('focusin', handleFocusIn);
    playerRoot?.addEventListener('pointermove', showControls, { passive: true });
    playerRoot?.addEventListener('pointerdown', showControls, { passive: true });
    playerRoot?.addEventListener('touchstart', showControls, { passive: true });
    return () => {
      if (hideTimer) clearTimeout(hideTimer);
      // MAVP-4 Issue 2: release the document scroll lock with the shell.
      document.documentElement.removeAttribute('data-player-open');
      // Player V2 corrections: restore the exact pre-hold speed BEFORE the
      // tap controller dies (a release event missed during teardown can
      // never leave the player at 2×), then clear the seek feedback timer.
      handleHoldEnd();
      if (seekFeedbackTimer) clearTimeout(seekFeedbackTimer);
      seekFeedback = null;
      // Phase 8: clear embed load timeout on destroy.
      clearEmbedLoadTimeout();
      // Focused fixes (Issue 4): clear the direct load timeout on destroy.
      clearDirectLoadTimeout();
      // Player UI V2 (Phase 2) teardown:
      gestureController?.destroy();
      gestureController = null;
      tapGestureController?.destroy();
      tapGestureController = null;
      if (gestureIndicatorHideTimer) clearTimeout(gestureIndicatorHideTimer);
      // MAVP-4 Issue 1: clear the presentation fail-open timer on destroy.
      clearEmbedPresentFailOpen();
      // Phase 2-I (PLR-02): remove the viewport MediaQueryList listener —
      // matches the addEventListener call above. Without this, each
      // mount cycle leaked a listener on the MediaQueryList.
      if (viewportMediaQuery && handleViewportChange) {
        try { viewportMediaQuery.removeEventListener('change', handleViewportChange); } catch { /* already removed */ }
      }
      // MAVP-2 Phase 5: remove the orientation MediaQueryList listener
      // (same leak class as PLR-02 — one listener per mount, never removed).
      if (orientationMediaQuery && handleOrientationChange) {
        try { orientationMediaQuery.removeEventListener('change', handleOrientationChange); } catch { /* already removed */ }
      }
      document.removeEventListener('fullscreenchange', handleFullscreen);
      detachPictureInPictureListeners();
      window.removeEventListener('keydown', handleKeydown);
      window.removeEventListener('blur', handleWindowBlur);
      window.removeEventListener('focus', handleWindowFocus);
      document.removeEventListener('focusin', handleFocusIn);
      playerRoot?.removeEventListener('pointermove', showControls);
      playerRoot?.removeEventListener('pointerdown', showControls);
      playerRoot?.removeEventListener('touchstart', showControls);
      // Phase 4: release the Cast controller (removes its SDK listeners; the
      // receiver session itself is intentionally left running — documented).
      castController?.destroy();
      castController = null;
      // Phase 6: explicit teardown of shell-level playback features. The browser
      // auto-exits fullscreen/PiP when playerRoot leaves the DOM, but explicit
      // calls are deterministic and prevent stale state across SPA navigation.
      // Phase 5 fix: guard document access during SSR. The `document`
    // global is only available in the browser — accessing it during SSR
    // (which happens for series/anime watch pages) throws ReferenceError.
    // The `browser` import from $app/environment is the canonical guard.
    if (browser && document.pictureInPictureElement === videoElement) exitPipQuietly();
      if (document.fullscreenElement === playerRoot) exitFullscreenQuietly();
      // Player V2 corrections (real-device feedback — the reported "audio
      // keeps playing after pressing Back" and "PiP close leaves audio"):
      // removing the shell from the DOM does NOT stop a detached <video> —
      // the browser keeps playing the element's resource, and a PiP window
      // keeps the detached element alive across SPA navigation. The media
      // session must actually STOP when the player exits:
      //   1. exit PiP first (done above — the window would hold the element),
      //   2. pause the element (fires the final progress 'pause' emission),
      //   3. release the resource (removeAttribute('src') + load()).
      // hls.js teardown (MediaSource detach) already ran in PlayerViewport's
      // onDestroy; embed adapters are disposed by the watch route's
      // manager.dispose(). No duplicate media instance can survive a route
      // transition — the next playback session starts from a stopped element.
      if (videoElement) {
        try { videoElement.pause(); } catch { /* already stopped */ }
        try {
          videoElement.removeAttribute('src');
          videoElement.load();
        } catch { /* element already reset */ }
      }
      // Phase 6 audit fix: set the destroyed flag BEFORE releaseWakeLock() so
      // any in-flight acquireWakeLock() request that resolves after this
      // cleanup will see wakeLockDestroyed === true and release its sentinel
      // immediately instead of installing a stale wake lock.
      wakeLockDestroyed = true;
      releaseWakeLock();
      clearMediaSession();
      // MAVP-5 (Issue 5): the presentation intent dies with the shell — no
      // stale landscape intent can leak into the next playback session.
      landscapePresentationIntent = false;
    };
  });

  async function togglePlay() {
    if (!sourceReady || source?.type !== 'direct' || !videoElement) {
      errorMessage = source?.type === 'embed' ? 'This source uses its own provider controls.' : 'Choose an available source to begin playback.';
      state = source?.type === 'embed' ? 'embed-loading' : 'source-unavailable';
      return;
    }
    // Phase 4: while casting, play/pause targets the RECEIVER (RemotePlayer
    // contract) — the local element stays paused to avoid duplicate playback.
    if (castConnected && castController) {
      castController.toggleRemotePlay();
      return;
    }
    try {
      if (videoElement.paused) await videoElement.play();
      else videoElement.pause();
    } catch {
      playing = false;
      state = 'paused';
      errorMessage = 'Playback is ready. Tap Play to start it.';
    }
  }

  function handleLoadedMetadata() {
    if (!videoElement) return;
    pictureInPictureSupported = Boolean(document.pictureInPictureEnabled && 'requestPictureInPicture' in videoElement);
    duration = Number.isFinite(videoElement.duration) ? videoElement.duration : duration;
    videoElement.volume = volume;
    videoElement.muted = muted;
    videoElement.playbackRate = playbackRate;
    state = 'paused';
    // Phase 9: attempt the pending seek, but NEVER discard it here. For streaming
    // VOD the seekable range/duration may not be final at loadedmetadata —
    // the controller retains the target until a range actually covers it,
    // and the durationchange/loadeddata/canplay/progress handlers retry.
    applyPendingSeekToElement();
    // Phase 6: set Media Session metadata + initial position state once the
    // direct source has loaded. Safe to call for embed sources too —
    // setupMediaSession is a no-op when mediaSessionSupported is false.
    setupMediaSession();
    syncMediaSessionPositionState();
  }

  // ----- Phase 9: reliable pending-seek application -----
  //
  // The pending seek survives `loadedmetadata` and is retried from the
  // media lifecycle events the viewport now forwards (durationchange,
  // loadeddata, canplay, progress) — event-driven, no timers, bounded by
  // the controller's attempt cap + wall-clock window (no infinite loops).
  // The DOM write happens ONLY in this shell (the controller is pure).

  function applyPendingSeekToElement() {
    if (!videoElement) return;
    const applied = applyPendingSeek(
      pendingSeekState,
      { readyState: videoElement.readyState, duration: videoElement.duration, seekable: videoElement.seekable },
      Date.now(),
    );
    if (applied === null) return;
    try {
      videoElement.currentTime = applied;
      currentTime = applied;
    } catch {
      // The element rejected the write (rare teardown race) — the target is
      // already cleared; a user seek remains fully functional.
    }
  }

  /** Retry sink for durationchange/loadeddata/canplay/progress. */
  function handleSeekOpportunity() {
    if (!pendingSeekState.token) return;
    applyPendingSeekToElement();
  }

  function handleTimeUpdate(event: CustomEvent<{ currentTime: number; duration: number }>) {
    currentTime = event.detail.currentTime;
    // Player UI V2 (Part 2, Phase 5): the shell duration is the ACTUAL media
    // duration only — finite and positive. A 0/NaN/Infinity report (source
    // still probing, live/unbounded media) must NOT overwrite a previously
    // received valid duration (and Infinity is never treated as a VOD
    // duration — the timeline stays on the last known finite value).
    if (Number.isFinite(event.detail.duration) && event.detail.duration > 0) duration = event.detail.duration;
    if (videoElement?.buffered.length) buffered = videoElement.buffered.end(videoElement.buffered.length - 1);
    if (currentTime - lastProgressReport >= 5) {
      lastProgressReport = currentTime;
      emitProgress('progress');
    }
    // Phase 6: keep Media Session position state in sync. setPositionState is
    // only called for direct sources (mediaSessionActive gate) and only when
    // values are finite/positive. Called on every timeupdate (throttled by the
    // 5-second progress gate above is too coarse for position state — the OS
    // media controls should update more frequently).
    syncMediaSessionPositionState();
  }

  function handlePlay() {
    playing = true;
    state = 'playing';
    errorMessage = '';
    revealControls();
    // Phase 6: acquire wake lock when playback starts. Safe for both direct
    // and embed sources — for embeds, `state === 'playing'` is set by
    // handleEmbedLoad, and the wake lock keeps the screen awake while the
    // provider plays inside the iframe.
    acquireWakeLock();
    syncMediaSessionPlaybackState('playing');
  }

  function handlePause() {
    playing = false;
    if (state !== 'completed') state = 'paused';
    emitProgress('pause');
    revealControls();
    // Phase 6: release wake lock on pause. Wake Lock must NOT remain active
    // indefinitely while playback is paused.
    releaseWakeLock();
    syncMediaSessionPlaybackState('paused');
  }

  function handleWaiting() { state = 'buffering'; }
  function handlePlaying() { state = 'playing'; errorMessage = ''; }
  function handleSeeking() { state = 'seeking'; }
  function handleSeeked() { state = playing ? 'playing' : 'paused'; }
  function handleEnded() {
    playing = false;
    state = 'completed';
    emitProgress('ended');
    revealControls();
    // Phase 6: release wake lock on end.
    releaseWakeLock();
    syncMediaSessionPlaybackState('paused');
  }

  function handleMediaError() {
    playing = false;
    state = 'error';
    errorMessage = 'Playback could not be started. Try again or choose another source.';
    revealControls();
    // Phase 6: release wake lock on error.
    releaseWakeLock();
    syncMediaSessionPlaybackState('paused');
  }
  // ----- MAVP-4 Issue 1: embed presentation gate -----
  //
  // The iframe `load` event is NOT the presentation moment: it says the
  // provider document finished loading, while the provider's player usually
  // boots for another 1–2 s (several providers render a green/brand-coloured
  // boot surface during that window). The shell therefore keeps the loading
  // card + veil mounted until the embed is genuinely presenting.
  //
  // Reveal conditions (whichever arrives first):
  //   1. First provider playback signal — normalized 'play' (VidRift,
  //      VidSrc, VidLink, VidY, CineSrc) or 'timeupdate'/'ready' (the
  //      timeupdate-only adapters: VidStuck, Viduki, MoviesNexus,
  //      VidApiQzz). Fully event-driven; no timer decides the reveal.
  //   2. An observable tap into the embed (the cross-origin-safe window
  //      blur/focus signal) — the user interacting with the provider UI
  //      (e.g. pressing its play button when autoplay is blocked).
  //   3. A bounded fail-open (EMBED_PRESENT_FAIL_OPEN_MS after `load`) —
  //      the documented last resort for silent black-box embeds, so the
  //      loading card can never conceal a live provider surface.
  // The reveal keeps ONE loading owner (the shell's single card) and does
  // not delay the iframe: the veil is pointer-transparent and the iframe
  // mounts and loads eagerly exactly as before.
  function revealEmbedSurface() {
    if (embedSurfacePresenting) return;
    if (source?.type !== 'embed' || !source.url) return;
    clearEmbedPresentFailOpen();
    embedSurfacePresenting = true;
    state = 'playing';
    errorMessage = '';
    // The 5s auto-hide countdown arms at the PRESENTATION reveal (the same
    // gate lives inside revealControls) — provider activity inside the
    // cross-origin iframe remains unobservable (documented limitation) and
    // does NOT reset the deadline.
    revealControls();
    // Media Session sync moved here from the old load-time transition: it
    // now reflects the embed surface being presented, not merely loaded.
    syncMediaSessionPlaybackState('playing');
  }

  function startEmbedPresentFailOpen() {
    clearEmbedPresentFailOpen();
    embedPresentFailOpenTimer = setTimeout(() => {
      embedPresentFailOpenTimer = undefined;
      revealEmbedSurface();
    }, EMBED_PRESENT_FAIL_OPEN_MS);
  }

  function clearEmbedPresentFailOpen() {
    if (embedPresentFailOpenTimer) {
      clearTimeout(embedPresentFailOpenTimer);
      embedPresentFailOpenTimer = undefined;
    }
  }

  function handleEmbedLoad() {
    errorMessage = '';
    // MAVP-4 Issue 1: `load` no longer flips the shell to 'playing' — the
    // presentation gate decides when the loading card unmounts (see
    // revealEmbedSurface). The rest of the load bookkeeping is unchanged.
    // Phase 8: the iframe loaded successfully — clear the load timeout so
    // it cannot fire and override the state.
    clearEmbedLoadTimeout();
    // Bounded fail-open: if no provider signal and no user tap revealed the
    // embed within the policy window, reveal it anyway (silent black-box
    // embeds must never be hidden behind the loading card indefinitely).
    if (!embedSurfacePresenting) startEmbedPresentFailOpen();
    // Phase 3 fix: forward the iframe element ref to the watch route so
    // provider adapters (CineSrc) can post commands to
    // iframe.contentWindow.postMessage(payload, origin) — the documented
    // CineSrc API target. Without this ref, commands cannot reach the
    // provider's player.
    if (iframeElement) onIframeReady(iframeElement);
    // Phase 6 audit fix: do NOT acquire the wake lock here. iframe load only
    // means the provider's player UI is displayed — it does NOT mean the
    // user has pressed Play or that actual playback has started. Wake Lock
    // is acquired only when a reliable 'play' event arrives from the provider
    // via the onEmbedPlaybackEvent callback (wired by the watch route to
    // manager.onEvent). For black-box embed providers that never post
    // play/pause events, the wake lock is never acquired — which is the
    // correct conservative behavior.
    // Media Session playbackState is synced here only to reflect the
    // shell-level 'embed-loading → playing' state transition; this does not
    // claim the provider is actually playing audio/video.
    syncMediaSessionPlaybackState('playing');
  }

  // Phase 6 audit fix: handle normalized embed playback events forwarded by
  // the watch route from the PlaybackManager. Only these events (not iframe
  // load) indicate actual provider playback state. Used to acquire/release
  // the wake lock conservatively — if the provider never posts these events,
  // no wake lock is acquired. Also maintains the `embedPlaying` state which
  // the visibility handler uses to decide whether to re-acquire the wake lock
  // when the document becomes visible again.
  // Phase 6 audit fix: handle normalized embed playback events forwarded by
  // the watch route from the PlaybackManager. 'play'/'pause'/'ended' drive
  // the wake lock + completion mirroring as before. MAVP-4 Issue 1: the
  // forward now also carries 'timeupdate'/'ready' (emitted by the
  // timeupdate-only adapters — VidStuck, Viduki, MoviesNexus, VidApiQzz),
  // which are presentation signals for the embed presentation gate.
  function handleEmbedPlaybackEvent(event: { type: 'play' | 'pause' | 'ended' | 'timeupdate' | 'ready'; sourceId?: string }) {
    if (source?.type !== 'embed') return;
    // Phase 6 audit fix 2: reject stale events from an old source. The watch
    // route stamps the sourceId at emit time. If a source switch happened
    // between emit and this reactive handler firing, the event's sourceId
    // will not match the current embedPlaybackSourceId. This is a safety net
    // — the PlaybackManager already has session guards — but it prevents a
    // stale postMessage from activating the wake lock for the wrong source.
    if (event.sourceId && embedPlaybackSourceId && event.sourceId !== embedPlaybackSourceId) return;
    // MAVP-4 Issue 1: any provider playback signal proves the embed surface
    // is presenting — reveal it (no-op once presenting). Runs for 'play' AND
    // for the timeupdate/ready-only adapters.
    if (event.type === 'play' || event.type === 'timeupdate' || event.type === 'ready') revealEmbedSurface();
    if (event.type === 'play') {
      embedPlaying = true;
      embedEverPlayed = true;
      acquireWakeLock();
    } else if (event.type === 'pause' || event.type === 'ended') {
      embedPlaying = false;
      releaseWakeLock();
      // Embed completion truthfulness (VidRift integration): mirror the
      // provider's ended signal into the shell state so (a) the completion
      // card reflects the finished playback and (b) the close/visibility
      // progress emission carries completed=true — a page close after the
      // provider ended must not regress the completed progress record.
      if (event.type === 'ended' && state !== 'completed') state = 'completed';
    }
  }

  // REMOVED (player controls redesign — supersedes the Phase 2-I (PLR-05)
  // sandbox-remount fix): the user-facing Sandbox menu item and its client-side
  // override state are gone. The iframe sandbox attribute is applied from the
  // SERVER-resolved effective policy (`resolveSandboxRuntime` →
  // option.sandboxPolicy → source.sandboxRuntime → PlayerViewport
  // `iframeSandboxAttribute`) — no runtime mutation path exists anymore. The
  // Admin provider form remains the single place where sandbox policy changes.

  function seek(time: number) {
    // Player V2 final remediation (Issue 3): a deliberate user seek closes
    // the pending auto-resume window for the current media (their choice of
    // position always wins over the late-arriving saved position).
    userSeekedBeforeResume = true;
    // Phase 4: while casting, the timeline and ±10 s controls seek the
    // RECEIVER (RemotePlayer.currentTime + RemotePlayerController.seek).
    if (castConnected && castController) {
      castController.remoteSeek(Number.isFinite(time) ? clampSeek(time, duration) : 0);
      currentTime = clampSeek(time, duration);
      emitProgress('progress');
      return;
    }
    if (!videoElement || !Number.isFinite(time)) return;
    currentTime = clampSeek(time, duration);
    videoElement.currentTime = currentTime;
    emitProgress('progress');
  }

  function seekBy(delta: number) { seek(currentTime + delta); }
  function toggleMute() { muted = !muted; if (videoElement) videoElement.muted = muted; }
  function setVolume(value: number) { volume = Math.min(1, Math.max(0, value)); muted = volume === 0; if (videoElement) { videoElement.volume = volume; videoElement.muted = muted; } }
  function setPlaybackRate(value: number) {
    playbackRate = value;
    if (videoElement) videoElement.playbackRate = value;
    // Phase 6: position state includes playbackRate — re-sync on change.
    syncMediaSessionPositionState();
  }

  /**
   * Player V2 corrections: display mode (Fit/Fill/Stretch). CSS-only — the
   * class swap changes the video's object-fit; the stream, the engine and
   * the playhead are untouched (no restart, no reset).
   */
  function setDisplayMode(mode: 'fit' | 'fill' | 'stretch') {
    displayMode = mode;
  }

  function setSubtitle(url: string) {
    // Focused fixes (Issues 1+2): the selection is URL state ONLY. The
    // viewport owns the TextTrack modes ('hidden' → the custom overlay
    // paints; 'showing' while the OS surface owns painting). The old
    // shell-side mode loop is GONE — it would fight the viewport's sync.
    selectedSubtitle = url;
  }

  /**
   * Focused fixes (Issues 1+2): the single writer of subtitle preferences
   * from the settings sheet. Sanitizes (bounded ranges, allowlisted
   * colours/styles) and persists to the versioned local store — the custom
   * overlay reflects the change on its very next animation frame.
   */
  function setSubtitlePreferences(next: SubtitlePreferences) {
    subtitlePrefs = sanitizeSubtitlePreferences(next);
    if (browser) saveSubtitlePreferences(subtitlePrefs);
  }

  function setQuality(url: string) {
    if (url === selectedQuality) return;
    // Phase 9: capture (re-stamp) the position for the next stream — the
    // token invalidates any earlier pending capture.
    capturePendingSeek(pendingSeekState, currentTime, Date.now());
    selectedQuality = url;
    state = 'preparing';
    playing = false;
  }

  // ----- Phase 6: engine internal-quality selection -----

  /**
   * Viewport `enginequality` event sink: the ONLY writer of `engineQuality`.
   * An empty options list with no selectable audio tracks means the engine is
   * gone (source switch to MP4/native, teardown) — the quality UI falls back
   * to the stream list. Audio tracks alone keep the state alive (GOAL 18).
   */
  function handleEngineQuality(event: CustomEvent<{ options: PlayerInternalQualityOption[]; selected: string | null; audioTracks: AudioTrackHandle[]; selectedAudioTrack: number | null }>) {
    engineQuality = event.detail.options.length || event.detail.audioTracks.length > 1 ? event.detail : null;
  }

  /** Phase 10 (GOAL 18): audio track selection through the viewport controller. */
  function setAudioTrack(index: number) {
    viewport?.selectEngineAudioTrack(index);
  }

  /**
   * Internal quality selection (AUTO or one manifest level). Delegates to
   * the viewport's generic controller — the engine is NOT recreated, the
   * switch is seamless, and playback position is untouched.
   */
  function setInternalQuality(id: string) {
    viewport?.selectEngineQuality(id);
  }

  type OrientationController = ScreenOrientation & { lock?: (value: 'landscape' | 'portrait' | 'any' | 'natural' | 'landscape-primary' | 'landscape-secondary' | 'portrait-primary' | 'portrait-secondary') => Promise<void>; unlock?: () => void };

  function orientationController() {
    return screen.orientation as OrientationController;
  }

  /**
   * MAVP-3 Issue 1: `enterLandscapePresentation()` was REMOVED together with
   * the automatic landscape-first presentation. No code path requests
   * fullscreen or an orientation lock without an explicit user action:
   *   * toggleLandscape()     — the manual Landscape control (all sources);
   *   * toggleFullscreen()    — the F-key fullscreen (all sources);
   *   * exitMaveroFullscreen — keyboard/manual exit (unlock only).
   * Playback startup never rotates or locks the device.
   */
  async function toggleLandscape() {
    if (landscapeToggleInFlight) return;
    const entering = !landscapeMode;
    revealControls();
    landscapeToggleInFlight = true;
    try {
      const orientation = orientationController();
      if (entering) {
        // MAVP-5 (Issue 5): record the user's landscape presentation intent.
        landscapePresentationIntent = true;
        // Fullscreen belongs to MAVERO's shell. The provider iframe is never invoked or manipulated.
        await playerRoot?.requestFullscreen?.();
        try { await orientation?.lock?.('landscape'); } catch { /* device/browser declined; fullscreen layout remains active */ }
        landscapeMode = true;
        // FAB auto-hide: portrait↔landscape must NOT break the inactivity
        // timer. Restart the 5s countdown cleanly via revealControls() so
        // the FABs remain visible now and auto-hide after 5s of inactivity.
        revealControls();
      } else {
        // MAVP-5 (Issue 5): an explicit user exit clears the presentation
        // intent — a later fullscreen loss must behave exactly as before.
        landscapePresentationIntent = false;
        try { orientation?.unlock?.(); } catch { /* unsupported */ }
        landscapeMode = false;
        if (document.fullscreenElement === playerRoot) await document.exitFullscreen?.();
        revealControls();
      }
    } catch {
      landscapeMode = false;
      landscapePresentationIntent = false;
      errorMessage = 'Landscape mode is not available in this browser.';
    } finally {
      landscapeToggleInFlight = false;
    }
  }

  async function toggleFullscreen() {
    try {
      if (!document.fullscreenElement) {
        await playerRoot?.requestFullscreen?.();
        try { await orientationController()?.lock?.('landscape'); } catch { /* device/browser declined */ }
      } else if (document.fullscreenElement === playerRoot) {
        await document.exitFullscreen?.();
        try { orientationController()?.unlock?.(); } catch { /* unsupported */ }
      }
    } catch {
      errorMessage = 'Fullscreen is not available in this browser.';
    }
  }

  /**
   * Player redesign keyboard contract: exit the MAVERO-owned fullscreen
   * (entered by either toggleFullscreen or toggleLandscape). Used by the
   * Escape branch AFTER sheets; state sync + orientation release mirror the
   * browser-initiated-exit path in the fullscreenchange handler.
   */
  async function exitMaveroFullscreen() {
    // MAVP-5 (Issue 5): an explicit keyboard exit clears the presentation intent.
    landscapePresentationIntent = false;
    try { orientationController()?.unlock?.(); } catch { /* unsupported */ }
    landscapeMode = false;
    if (document.fullscreenElement === playerRoot) exitFullscreenQuietly();
    revealControls();
  }

  async function togglePictureInPicture() {
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture?.();
      else await viewport.requestPictureInPicture();
    } catch {
      errorMessage = 'Picture-in-Picture is not available for this source.';
    }
  }

  function chooseSource(sourceId: string, variant?: string) {
    // Phase 8: closeSourceSheet restores focus to the trigger.
    closeSourceSheet();
    // Phase 7F (MegaPlay): only fire onSourceChange when the source
    // OR the variant actually changed. Clicking the active variant
    // button should be a no-op (no re-resolution).
    const sourceChanged = sourceId !== source?.sourceId;
    const variantChanged = variant !== undefined && variant !== source?.metadata?.selectedVariant;
    if (sourceChanged || variantChanged) {
      state = 'switching-source';
      errorMessage = '';
      onSourceChange(sourceId, variant);
    }
  }

  function chooseAdjacentSource(delta: -1 | 1) {
    const nextId = adjacentSource(sourceOptions, source?.sourceId, delta);
    if (nextId) chooseSource(nextId);
  }

  function chooseEpisode(target: PlayerEpisodeTarget) {
    // Phase 8: closeEpisodeSheet restores focus to the trigger.
    closeEpisodeSheet();
    onEpisodeChange(target);
  }

  function emitProgress(reason: PlayerProgressEvent['reason']) {
    // BUG #8 fix: completion is ONLY from the explicit 'ended' state.
    // The previous 0.9 (90%) threshold marked titles completed too early.
    onProgress({ currentTime, duration, completed: state === 'completed', reason });
  }

  function revealControls() {
    // Player UI V2 (Part 1, Phase 2C): while touch-locked, activity cannot
    // reveal the controls — the persistent unlock FAB (and the Back FAB) stay
    // the only reachable surfaces. Unlocking calls revealControls() itself.
    if (touchLocked) return;
    controlsVisible = true;
    if (hideTimer) clearTimeout(hideTimer);
    // Player redesign: FIVE-second auto-hide, applies in all modes (portrait +
    // landscape). Source/episode sheets being open prevents auto-hide (checked
    // again in the timer callback), as does keyboard focus resting on a
    // Mavero-owned control (focused controls are never hidden — a11y guard).
    //
    // Phase 2-I (PLR-04): embed playback must ALSO participate in auto-hide.
    // The previous condition checked only `playing` (set for direct sources),
    // so an embed source that was actively playing never auto-hid the
    // controls. We now OR with `embedPlaying` so the same 5s countdown
    // applies to embed playback too. The provider iframe content itself is
    // NOT hidden — only the Mavero control overlay (which is irrelevant
    // while the embed is playing).
    //
    // MAVP-2 Phase 3 ROOT-CAUSE FIX: `(playing || embedPlaying)` alone was
    // never true for a typical embed session — `playing` is the DIRECT-video
    // flag and `embedPlaying` is only set when a provider posts normalized
    // play/pause postMessage events, which most black-box providers never do.
    // Combined with the missing revealControls() call at embed load (fixed in
    // handleEmbedLoad), NO timer was ever armed → the floating controls never
    // auto-hid on real devices. The shell-visible embed session state
    // (`source.type === 'embed' && state === 'playing'`) now participates:
    //   * black-box embeds (embedEverPlayed=false): armed from iframe load —
    //     honest, since the provider controls playback inside the iframe and
    //     Mavero cannot observe pause events;
    //   * event-posting embeds (embedEverPlayed=true): armed on the provider's
    //     OWN play state — a provider-reported pause keeps the controls up.
    // Media progress events (timeupdate etc.) never call revealControls —
    // background playback cannot reset the deadline (spec requirement).
    //
    // Cross-origin honesty (documented limitation): pointer/touch activity
    // INSIDE a provider iframe is unobservable from the parent page, so while
    // an embed is playing the countdown reflects page-level activity only.
    const embedSessionArms = source?.type === 'embed'
      && state === 'playing'
      && (!embedEverPlayed || embedPlaying);
    // MAVP-3 Issue 4: a calibration session holds the controls visible — the
    // hide timer is simply never armed while `calibrationMode` is set, so
    // admin calibration/inspection cannot be interrupted by the 5s auto-hide.
    // Normal playback (no calibration session) arms exactly as before.
    if ((playing || embedPlaying || embedSessionArms) && !sourceMenuOpen && !episodeMenuOpen && !controlsSheetsOpen && !calibrationMode) {
      hideTimer = setTimeout(() => {
        if (!sourceMenuOpen && !episodeMenuOpen && !controlsSheetsOpen && !focusWithinMaveroControls()) {
          controlsVisible = false;
          // MAVP-3 Issue 2 (the reported "controls permanently hidden" bug):
          // the ONLY parent-observable signal for activity inside a
          // cross-origin embed is the focus TRANSITION into the iframe
          // (window `blur` + `focusin` with the iframe as activeElement).
          // Once the iframe HOLDS focus — the normal state after the user
          // presses Play inside the provider, which happens while the
          // controls are still visible — later taps inside the embed emit NO
          // parent-observable events, so the one-shot signal could never fire
          // again and touch/mouse users had no way to reveal hidden controls
          // (the full-viewport iframe swallows every tap; keyboard input goes
          // to the iframe too). Releasing focus back to the parent at hide
          // time makes the signal RECURRING: the user's NEXT tap inside the
          // embed re-enters focus → handleWindowBlur/handleFocusIn →
          // revealControls. blur() acts on the parent-owned iframe ELEMENT —
          // the provider's DOM is never touched; playback is unaffected
          // (focus is not required for video playback). The bounded trade-off
          // (an in-iframe text field loses focus at hide time) is strictly
          // better than permanently inaccessible controls.
          releaseEmbedFocusForRecovery();
        }
      }, 5_000);
    }
  }

  /**
   * MAVP-3 Issue 2: make the iframe-focus reveal signal recurring. See the
   * hide-timer comment above for the full root-cause analysis. No-op unless
   * the provider iframe currently holds document focus.
   */
  function releaseEmbedFocusForRecovery() {
    if (!iframeElement || document.activeElement !== iframeElement) return;
    try { iframeElement.blur(); } catch { /* focus already gone */ }
  }

  /**
   * Player redesign a11y guard: true while keyboard focus rests inside a
   * Mavero-owned control surface (FABs, source chip, direct controls, sheets).
   * Focused controls must never auto-hide — keyboard/TV users would lose the
   * element they are interacting with.
   */
  function focusWithinMaveroControls(): boolean {
    if (!playerRoot) return false;
    const active = document.activeElement;
    if (!(active instanceof HTMLElement) || !playerRoot.contains(active)) return false;
    return Boolean(active.closest('.back-fab, .control-fab-group, .source-chip, .episode-chip, .direct-controls-overlay, .source-sheet, .episode-sheet, .player-option-sheet, .unlock-fab, .skip-intro-button'));
  }

  // Player UI V2 (Part 1, Phase 1A): the former in-row source-sheet opener
  // helper was removed together with the redundant control-row source button —
  // the persistent right-edge source chip is the single opener (it passes
  // itself as the focus-restore trigger) and source switching is unchanged.

  // MAVP-5 (Issue 4): the old openEpisodeSheetFromControl helper was removed
  // together with the bottom-right Episodes pill — the dedicated left-edge
  // episode chip opens the sheet directly with itself as the focus-restore
  // trigger (openEpisodeSheet(event.currentTarget)).

  function retry() {
    errorMessage = '';
    // Phase 8: clear any pending embed load timeout before retrying.
    clearEmbedLoadTimeout();
    // MAVP-4 Issue 1: a retry restarts the presentation gate — the provider
    // surface has to present again (fresh signal / tap / fail-open).
    clearEmbedPresentFailOpen();
    embedSurfacePresenting = false;
    if (source?.sourceId) {
      state = 'switching-source';
      onSourceChange(source.sourceId);
      return;
    }
    if (videoElement) { videoElement.load(); capturePendingSeek(pendingSeekState, currentTime, Date.now()); }
    state = source?.type === 'embed' ? 'embed-loading' : 'preparing';
    // Phase 8: if retrying an embed, start the timeout again.
    if (state === 'embed-loading' && source?.sourceId) startEmbedLoadTimeout(source.sourceId);
  }

  // ----- Phase 8: Embed load timeout -----
  //
  // If an embed iframe never fires `on:load`, the player would stay in
  // `embed-loading` indefinitely. This timeout transitions to the error
  // state after EMBED_LOAD_TIMEOUT_MS (18s) — conservative enough to not
  // interrupt slow legitimate providers.
  //
  // Stale-source protection: the timeout captures the sourceId at start
  // time. When it fires, it checks that the current sourceIdentity still
  // matches. If the user switched sources while the timeout was pending,
  // the timeout is a no-op — the new source's timeout is managed by its
  // own startEmbedLoadTimeout call.

  function startEmbedLoadTimeout(sourceId: string) {
    clearEmbedLoadTimeout();
    // Phase 8 bug fix: capture the sourceId in a local const so the timeout
    // callback validates against the identity that belonged to THIS PARTICULAR
    // timer invocation — NOT the mutable `embedLoadTimeoutSourceId` which
    // may have been overwritten by a newer source's startEmbedLoadTimeout call.
    // Without this capture, a stale queued callback from source A could read
    // the current mutable value ('B') after source B started, and incorrectly
    // transition source B to error.
    const timeoutSourceId = sourceId;
    embedLoadTimeoutSourceId = timeoutSourceId;
    embedLoadTimer = setTimeout(() => {
      embedLoadTimer = undefined;
      // Stale-source guard: compare against the captured `timeoutSourceId`
      // (immutable per-timer), NOT the mutable `embedLoadTimeoutSourceId`.
      // If the user switched to a different source while this timeout was
      // pending, sourceIdentity will not match timeoutSourceId.
      if (sourceIdentity !== timeoutSourceId) return;
      // Only transition to error if we're still in the embed-loading state.
      // If handleEmbedLoad already fired, state will be 'playing' and we
      // must NOT override it.
      if (state !== 'embed-loading') return;
      state = 'error';
      errorMessage = 'This source is taking too long to load.';
      revealControls();
    }, EMBED_LOAD_TIMEOUT_MS);
  }

  function clearEmbedLoadTimeout() {
    if (embedLoadTimer) {
      clearTimeout(embedLoadTimer);
      embedLoadTimer = undefined;
    }
    embedLoadTimeoutSourceId = '';
  }

  // ----- Focused fixes (Issue 4): direct-source load timeout -----
  //
  // A DIRECT stream that never reaches loadedmetadata AND never errors
  // (hung origin, dead HLS publication) would leave the loading indicator
  // up forever. The embed path already bounds this (EMBED_LOAD_TIMEOUT_MS);
  // direct playback now gets the same contract: a bounded 20 s window per
  // (sourceId, mediaUrl) prepare session, with the SAME captured-key guard
  // — a stale timer from a previous source/stream can never error the
  // current one, and a ready/error arrival always disarms it first.
  const DIRECT_LOAD_TIMEOUT_MS = 20000;
  let directLoadTimer: ReturnType<typeof setTimeout> | undefined;
  let directLoadKey = '';
  function startDirectLoadTimeout(key: string) {
    clearDirectLoadTimeout();
    directLoadKey = key;
    directLoadTimer = setTimeout(() => {
      directLoadTimer = undefined;
      // Stale-key guard: only the session that ARMED this timer may act.
      if (directLoadKey !== key) return;
      // Only a genuine still-preparing session transitions — ready/error
      // already flipped the state before firing.
      if (state !== 'preparing') return;
      state = 'error';
      errorMessage = 'The video is taking too long to load. Try again or choose another source.';
      revealControls();
    }, DIRECT_LOAD_TIMEOUT_MS);
  }
  function clearDirectLoadTimeout() {
    if (directLoadTimer) {
      clearTimeout(directLoadTimer);
      directLoadTimer = undefined;
    }
    directLoadKey = '';
  }
  // Arm exactly while a direct stream is PREPARING on a specific media URL;
  // disarm the moment the state leaves 'preparing' (ready, error, switch).
  $: if (source?.type === 'direct' && mediaUrl && state === 'preparing') startDirectLoadTimeout(`${source.sourceId}:${mediaUrl}`);
  $: if (state !== 'preparing') clearDirectLoadTimeout();

  // ----- Phase 8: Focus management for source/episode sheets -----
  //
  // When a sheet opens, focus moves into the sheet (close button preferred).
  // When it closes (via close button, backdrop, Escape, or selection), focus
  // restores to the trigger element if it's still connected to the DOM.
  //
  // Tab/Shift+Tab is trapped within the active sheet so focus cannot escape
  // behind the modal backdrop. Only one sheet can be open at a time.

  function openSourceSheet(trigger: HTMLElement) {
    sourceSheetTrigger = trigger;
    episodeMenuOpen = false; // only one sheet at a time
    sourceMenuOpen = true;
    // Focus the close button after Svelte renders the sheet.
    setTimeout(() => focusSheetCloseButton('source'), 0);
  }

  function openEpisodeSheet(trigger: HTMLElement) {
    episodeSheetTrigger = trigger;
    sourceMenuOpen = false; // only one sheet at a time
    episodeMenuOpen = true;
    setTimeout(() => focusSheetCloseButton('episode'), 0);
  }

  function closeSourceSheet() {
    sourceMenuOpen = false;
    restoreFocus(sourceSheetTrigger);
    sourceSheetTrigger = null;
    // FAB auto-hide: closing a sheet restarts the 5s inactivity countdown.
    revealControls();
  }

  function closeEpisodeSheet() {
    episodeMenuOpen = false;
    restoreFocus(episodeSheetTrigger);
    episodeSheetTrigger = null;
    // FAB auto-hide: closing a sheet restarts the 5s inactivity countdown.
    revealControls();
  }

  function restoreFocus(element: HTMLElement | null) {
    if (element instanceof HTMLElement && element.isConnected) {
      try { element.focus(); } catch { /* element not focusable */ }
    }
  }

  function focusSheetCloseButton(which: 'source' | 'episode') {
    const sheetClass = which === 'source' ? '.source-sheet' : '.episode-sheet';
    const sheet = playerRoot?.querySelector(sheetClass);
    if (!sheet) return;
    const closeBtn = sheet.querySelector('.close-button');
    if (closeBtn instanceof HTMLElement) {
      closeBtn.focus();
      return;
    }
    // Fallback: focus the first focusable element in the sheet.
    const firstFocusable = sheet.querySelector('button, a, input, select, textarea, [tabindex]:not([tabindex="-1"])');
    if (firstFocusable instanceof HTMLElement) firstFocusable.focus();
  }

  function handleSheetKeydown(event: KeyboardEvent) {
    // Phase 8/9: focus trap + Escape for both sheets. Only active when
    // a sheet is open.
    if (!sourceMenuOpen && !episodeMenuOpen) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      if (sourceMenuOpen) closeSourceSheet();
      else if (episodeMenuOpen) closeEpisodeSheet();
      return;
    }
    if (event.key !== 'Tab') return;
    const activeSheet = sourceMenuOpen
      ? playerRoot?.querySelector('.source-sheet')
      : episodeMenuOpen
        ? playerRoot?.querySelector('.episode-sheet')
        : null;
    if (!activeSheet) return;
    const focusables = Array.from(activeSheet.querySelectorAll<HTMLElement>('button, a, input, select, textarea, [tabindex]:not([tabindex="-1"])')).filter((el) => el.offsetParent !== null);
    if (!focusables.length) {
      event.preventDefault();
      return;
    }
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = document.activeElement;
    if (event.shiftKey) {
      if (active === first || !activeSheet.contains(active)) {
        event.preventDefault();
        last.focus();
      }
    } else {
      if (active === last || !activeSheet.contains(active)) {
        event.preventDefault();
        first.focus();
      }
    }
  }

  // ----- Phase 6: Wake Lock -----
  //
  // Shell-local screen wake lock. Acquired while Mavero considers playback
  // to be actively playing (direct video 'play' event, or embed 'embedload'
  // event). Released on pause/end/error/source-switch/episode-switch/destroy
  // and when the document becomes hidden. Re-acquired on visibility-visible
  // if playback was still active when the document hid.
  //
  // The sentinel's `release` event is observed so that a system-initiated
  // release (e.g. OS power management) updates internal state.
  //
  // Race-condition-safe: if `request('screen')` resolves after PlayerShell
  // is destroyed, the sentinel is released immediately and no destroyed
  // component state is touched.

  async function acquireWakeLock() {
    if (!wakeLockSupported) return;
    // Don't acquire if we already hold a sentinel that hasn't been released.
    if (wakeLockSentinel && !wakeLockSentinel.released) return;
    // Phase 6 audit fix: request-generation mechanism. Capture the request id
    // at call time. After the async request resolves, verify the id is still
    // current. If releaseWakeLock() or any other invalidating event fired
    // during the await (incrementing wakeLockRequestId or setting
    // wakeLockDestroyed), the resolved sentinel is released immediately
    // rather than installed as a stale wake lock.
    const requestId = ++wakeLockRequestId;
    try {
      const nav = navigator as WakeLockNavigator;
      const sentinel = await nav.wakeLock!.request('screen');
      // Validity check after await: the request must still be current, the
      // component must not be destroyed, the document must still be visible
      // (wake lock is meaningless if hidden), and playback must still require
      // a wake lock (no newer acquire superseded this one).
      if (
        wakeLockDestroyed ||
        requestId !== wakeLockRequestId ||
        document.hidden ||
        (wakeLockSentinel && !wakeLockSentinel.released)
      ) {
        try { await sentinel?.release?.(); } catch { /* already released */ }
        return;
      }
      wakeLockSentinel = sentinel;
      try { sentinel?.addEventListener?.('release', handleWakeLockSentinelRelease); } catch { /* some browsers lack addEventListener on the sentinel */ }
    } catch {
      // Spec: rejects if document not visible, or if permission denied.
      // Silently no-op — wake lock is best-effort. Do NOT install a sentinel.
    }
  }

  function handleWakeLockSentinelRelease() {
    // The sentinel fired its `release` event (system-initiated or our own
    // release() call). Clear the local ref so acquireWakeLock() can re-acquire.
    if (wakeLockSentinel) {
      try { wakeLockSentinel.removeEventListener?.('release', handleWakeLockSentinelRelease); } catch { /* already removed */ }
    }
    wakeLockSentinel = null;
  }

  async function releaseWakeLock() {
    // Phase 6 audit fix: increment the request id so any in-flight
    // acquireWakeLock() call that resolves AFTER this release will fail
    // the validity check and release its sentinel immediately instead of
    // installing a stale wake lock.
    wakeLockRequestId++;
    const sentinel = wakeLockSentinel;
    wakeLockSentinel = null;
    if (!sentinel) return;
    try { sentinel.removeEventListener?.('release', handleWakeLockSentinelRelease); } catch { /* already removed */ }
    try { await sentinel.release?.(); } catch { /* already released */ }
  }

  // ----- Phase 6: Media Session -----
  //
  // Media Session metadata + action handlers for DIRECT playback only.
  // Embed sources cannot be commanded reliably (except CineSrc, but the
  // postMessage round-trip makes Media Session state updates unreliable).
  //
  // Action handlers registered: play, pause, seekbackward, seekforward, seekto.
  // NOT registered: previoustrack/nexttrack (no existing chooseAdjacentEpisode
  // helper exists in the current architecture).
  //
  // setPositionState is called only when:
  //   - duration is finite and > 0
  //   - position is finite, >= 0, and <= duration
  //   - playbackRate is finite and > 0

  // Phase 6 audit fix: derive artwork MIME type from URL extension. Falls back
  // to 'image/jpeg' (the most common poster/backdrop format) when the extension
  // is unknown or missing. Avoids claiming every artwork is JPEG when the URL
  // might be PNG or WebP.
  function artworkMimeType(url: string): string {
    const lower = url.toLowerCase().split('?')[0].split('#')[0];
    if (lower.endsWith('.png')) return 'image/png';
    if (lower.endsWith('.webp')) return 'image/webp';
    if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
    if (lower.endsWith('.gif')) return 'image/gif';
    if (lower.endsWith('.svg')) return 'image/svg+xml';
    if (lower.endsWith('.avif')) return 'image/avif';
    return 'image/jpeg'; // conservative fallback
  }

  function setupMediaSession() {
    if (!mediaSessionSupported) return;
    const nav = navigator as MediaSessionNavigator;
    const session = nav.mediaSession;
    if (!session) return;
    // Build metadata. Artwork is only included when a valid image URL exists
    // — empty URLs would create invalid artwork entries. The MIME type is
    // derived from the URL extension when possible (avoids claiming every
    // artwork is JPEG when the URL might be PNG/WebP).
    const artworkUrl = content.backdrop ?? content.poster ?? '';
    const artwork = artworkUrl ? [{ src: artworkUrl, sizes: '512x512', type: artworkMimeType(artworkUrl) }] : undefined;
    try {
      if ('MediaMetadata' in window) {
        session.metadata = new MediaMetadata({
          title: content.title,
          artist: currentEpisode?.title ?? (content.type === 'movie' ? 'Movie' : content.type === 'series' ? 'Series' : 'Anime'),
          album: 'MAVERO',
          ...(artwork ? { artwork } : {})
        });
      }
      mediaSessionActive = true;
    } catch {
      // MediaMetadata constructor may be unavailable on older Safari.
      mediaSessionActive = false;
    }
    // Phase 2-I (PLR-03): the source-switch path calls clearMediaSession()
    // (line 345 / 366) which clears BOTH metadata AND action handlers.
    // The previous setupMediaSession restored metadata but NOT the action
    // handlers — so after the first source switch, play/pause/seek media
    // keys stopped working. We now re-register action handlers here for
    // DIRECT sources (embed sources cannot be commanded reliably — see the
    // existing comment in registerMediaSessionHandlers). For embed sources
    // we intentionally do NOT register handlers (preserves the existing
    // "no Media Session controls for unsupported embed playback" rule).
    if (source?.type === 'direct') {
      registerMediaSessionHandlers();
    }
  }

  function registerMediaSessionHandlers() {
    if (!mediaSessionSupported) return;
    const nav = navigator as MediaSessionNavigator;
    const session = nav.mediaSession;
    if (!session?.setActionHandler) return;
    // Only register handlers that can be correctly implemented for DIRECT
    // playback. Embed sources do not get action handlers (caller gates this
    // by only invoking on direct sources — see handleLoadedMetadata).
    const trySet = (action: string, handler: () => void) => {
      try { session.setActionHandler!(action, handler); } catch { /* some Safari versions throw for unsupported actions */ }
    };
    trySet('play', () => { if (source?.type === 'direct' && videoElement?.paused) void videoElement.play(); });
    trySet('pause', () => { if (source?.type === 'direct' && videoElement && !videoElement.paused) videoElement.pause(); });
    trySet('seekbackward', () => seekBy(-10));
    trySet('seekforward', () => seekBy(10));
    // seekto: MediaSessionActionDetails includes seekTime / fastSeek. The handler
    // signature accepts an optional details argument; we cast through unknown
    // to avoid relying on lib.dom typings that may not be present on older TS.
    type SeekToDetails = { seekTime?: number; fastSeek?: boolean };
    const seekToHandler = (raw: unknown) => {
      const details = raw as SeekToDetails | undefined;
      if (typeof details?.seekTime === 'number' && Number.isFinite(details.seekTime)) seek(details.seekTime);
    };
    try { session.setActionHandler('seekto', seekToHandler as () => void); } catch { /* unsupported */ }
  }

  function clearMediaSession() {
    if (!mediaSessionSupported) return;
    const nav = navigator as MediaSessionNavigator;
    const session = nav.mediaSession;
    if (!session) return;
    try { session.metadata = null; } catch { /* unsupported */ }
    try { session.playbackState = 'none'; } catch { /* unsupported */ }
    // Clear action handlers. Wrapped in try/catch because browser
    // implementations differ (Safari may throw for null handler on some actions).
    const actions = ['play', 'pause', 'seekbackward', 'seekforward', 'seekto'];
    for (const action of actions) {
      try { session.setActionHandler?.(action, null); } catch { /* unsupported */ }
    }
    mediaSessionActive = false;
  }

  function syncMediaSessionPlaybackState(value: 'playing' | 'paused' | 'none') {
    if (!mediaSessionSupported || !mediaSessionActive) return;
    const nav = navigator as MediaSessionNavigator;
    try { nav.mediaSession!.playbackState = value; } catch { /* unsupported */ }
  }

  function syncMediaSessionPositionState() {
    if (!mediaSessionSupported || !mediaSessionActive) return;
    const nav = navigator as MediaSessionNavigator;
    const session = nav.mediaSession;
    if (!session?.setPositionState) return;
    // Validate per spec — invalid values throw or are silently ignored.
    if (!Number.isFinite(duration) || duration <= 0) return;
    if (!Number.isFinite(currentTime) || currentTime < 0 || currentTime > duration) return;
    if (!Number.isFinite(playbackRate) || playbackRate <= 0) return;
    try {
      session.setPositionState({ duration, playbackRate, position: currentTime });
    } catch { /* invalid position state — silently skip */ }
  }

  // ----- Phase 6: visibility/wake-lock coordination -----
  //
  // Wake Lock spec: the sentinel auto-releases when the document becomes
  // hidden. We track whether playback was active when the document hid so we
  // can re-acquire on visibility-visible. This is invoked from the existing
  // svelte:window onvisibilitychange handler (extended below to call this).

  function handleVisibilityChangeForWakeLock() {
    if (document.hidden) {
      // Phase 6 audit fix 2: capture BOTH direct and embed playback state
      // before the auto-release. The `playing` flag tracks direct HTMLVideo
      // playback; `embedPlaying` tracks normalized provider playback events.
      // Either may be active when the document hides, and either should
      // trigger re-acquisition on visible.
      wasPlayingBeforeHidden = playing || embedPlaying;
      // Per spec, the sentinel auto-releases. But explicit release is safer
      // for cross-browser consistency — some browsers hold the lock briefly.
      void releaseWakeLock();
    } else {
      // Phase 6 audit fix 2: re-acquire only if the same playback state is
      // still active. Do NOT re-acquire if the user paused/stopped while
      // hidden, or if the source changed while hidden (which resets both
      // playing and embedPlaying). Direct playback re-acquires if `playing`
      // is still true; embed playback re-acquires if `embedPlaying` is still
      // true. Either path uses the same acquireWakeLock mechanism.
      const stillActive = wasPlayingBeforeHidden && (playing || embedPlaying);
      if (stillActive) {
        void acquireWakeLock();
      }
      wasPlayingBeforeHidden = false;
    }
  }
</script>

<svelte:window onbeforeunload={() => emitProgress('close')} onvisibilitychange={() => { if (document.hidden) emitProgress('visibility'); handleVisibilityChangeForWakeLock(); }} />

  <div bind:this={playerRoot} class="player-shell" class:landscape-mode={landscapeMode} class:controls-hidden={!controlsVisible} class:touch-locked={touchLocked} role="application" aria-label="MAVERO video player">

  <!-- Immersive redesign: stage fills the ENTIRE viewport — no header/footer consuming space. -->
  <section class="stage-wrap" aria-label="Player viewport">
    <PlayerViewport bind:this={viewport} bind:videoElement bind:iframeElement {source} {mediaUrl} sandboxEnabled={effectiveSandboxEnabled} sandboxPolicy={effectiveSandboxPolicy} poster={content.backdrop ?? content.poster ?? ''} title={content.title} state={effectiveState} subtitles={mergedSubtitles} {displayMode} selectedSubtitleUrl={selectedSubtitle} subtitlePrefs={subtitlePrefs} {subtitleOverlaySuppressed} on:loadedmetadata={handleLoadedMetadata} on:timeupdate={handleTimeUpdate} on:play={handlePlay} on:pause={handlePause} on:waiting={handleWaiting} on:playing={handlePlaying} on:seeking={handleSeeking} on:seeked={handleSeeked} on:ended={handleEnded} on:error={handleMediaError} on:embedload={handleEmbedLoad} on:enginequality={handleEngineQuality} on:durationchange={handleSeekOpportunity} on:loadeddata={handleSeekOpportunity} on:canplay={handleSeekOpportunity} on:progress={handleSeekOpportunity} />

    <!-- MAVP-4 Issue 1: embed presentation veil. While the provider iframe is
         mounted but not yet presenting, this opaque layer covers the stage
         (below the message/loading cards, above the iframe) so the
         provider's boot surface can never flash through. It is
         pointer-transparent (taps reach the provider — the cross-origin
         focus signal is the user-interaction reveal) and unmounts together
         with the loading card at the reveal: ONE coherent loading→player
         transition, no blank frames, no competing loading overlays. -->
    {#if embedVeilActive}
      <div class="embed-veil" aria-hidden="true"></div>
    {/if}

    {#if resolutionError || errorMessage || effectiveState === 'error' || effectiveState === 'provider-error' || effectiveState === 'source-unavailable' || effectiveState === 'unsupported-format' || effectiveState === 'embed-unavailable' || effectiveState === 'title-unavailable'}
      <div class="message-card" role="alert">
        <div class="message-icon"><AlertTriangle size={17} /></div>
        <div>
          {#if resolutionKind === 'title-unavailable'}
            <!-- Player UI V2 (Part 1, Phase 1C): the resolver CONFIRMED the title
                 does not exist on the selected source (TITLE_NOT_AVAILABLE — a
                 verified missing-title contract, NEVER a generic HTTP/empty/
                 unknown failure). The heading names the source and the primary
                 action is choosing another one. Retry stays available but
                 secondary — retry behavior is preserved, not removed. -->
            <strong>Title not available on {resolutionSourceName || 'this source'}.</strong>
            <p>{resolutionError || errorMessage || 'Choose another source to keep watching.'}</p>
          {:else}
            <strong>This source isn't available.</strong>
            <p>{resolutionError || errorMessage || 'Choose another source or try again.'}</p>
          {/if}
        </div>
        <div class="message-actions">
          {#if resolutionKind === 'title-unavailable'}
            {#if sourceOptions.length}<button class="small-button" type="button" aria-label="Switch source" onclick={(event) => openSourceSheet(event.currentTarget instanceof HTMLElement ? event.currentTarget : playerRoot)}><Settings2 size={14} /> Switch source</button>{/if}
            <button class="small-button secondary" type="button" aria-label="Try again" onclick={retry}><RotateCcw size={14} /> Try again</button>
          {:else}
            <button class="small-button" type="button" aria-label="Try again" onclick={retry}><RotateCcw size={14} /> Try again</button>{#if sourceOptions.length}<button class="small-button secondary" type="button" aria-label="Switch source" onclick={(event) => openSourceSheet(event.currentTarget instanceof HTMLElement ? event.currentTarget : playerRoot)}><Settings2 size={14} /> Switch source</button>{/if}
          {/if}
        </div>
      </div>
    {:else if state === 'completed'}
      <div class="completion-card" role="status"><Check size={18} /><span>Episode complete</span></div>
    {:else if effectiveState === 'preparing' || effectiveState === 'resolving' || effectiveState === 'switching-source' || effectiveState === 'embed-loading'}
      <div class="loading-card" role="status"><span class="loading-ring" aria-hidden="true"></span><span class="loading-copy"><strong>{effectiveState === 'switching-source' ? 'Switching source…' : effectiveState === 'embed-loading' ? 'Starting your stream…' : 'Loading player…'}</strong><small>{resolutionMessage || (effectiveState === 'embed-loading' ? 'Loading provider embed…' : 'Preparing playback…')}</small></span></div>
    {/if}
    <!-- Player UI V2 (Part 1, Phase 2A): simulated BRIGHTNESS overlay — a
         Mavero-rendered black layer whose opacity follows the left-zone
         vertical swipe. Pointer-transparent, covers only the stage (below
         the message cards and controls), and never claims to change system
         display brightness. -->
    {#if source?.type === 'direct'}
      <div class="brightness-overlay" style={`opacity: ${brightnessDimOpacity(brightness)}`} aria-hidden="true"></div>
    {/if}

    <!-- Player UI V2 (Part 1, Phase 2A/2B): compact transient gesture
         indicator (brightness / volume). Visual layer is aria-hidden — the
         completed gesture announces once through the polite live region. -->
    {#if gestureIndicator}
      <div class="gesture-indicator" aria-hidden="true">
        {#if gestureIndicator === 'brightness'}<Sun size={14} />{:else}<Volume2 size={14} />{/if}
        <span class="gesture-indicator-bar"><span style={`width: ${gesturePercent}%`}></span></span>
        <span class="gesture-indicator-value">{gesturePercent}%</span>
      </div>
    {/if}
    <div class="gesture-announcement" role="status" aria-live="polite">{gestureAnnouncement}</div>

    <!-- Player V2 corrections: transient double-tap seek feedback — a brief
         direction pill on the tapped half (left = rewind, right = forward).
         Visual layer is aria-hidden; the polite announcement carries the
         state for screen readers. -->
    {#if seekFeedback}
      <div class="seek-feedback" class:backward={seekFeedback === 'backward'} class:forward={seekFeedback === 'forward'} aria-hidden="true">
        {#if seekFeedback === 'backward'}<RotateCcwSquare size={18} />{:else}<RotateCwSquare size={18} />{/if}
        <span>{seekFeedback === 'backward' ? '−10' : '+10'} s</span>
      </div>
    {/if}
    <!-- Player V2 corrections: press-and-hold 2× indicator. While the hold
         is active the pill shows the temporary speed; the exact previous
         speed returns on release/cancel (announced through the live region). -->
    {#if holdSpeedActive}
      <div class="gesture-indicator hold-indicator" aria-hidden="true">
        <span class="hold-badge">2×</span>
        <span class="hold-copy">Holding — release for normal speed</span>
      </div>
    {/if}

    <!-- Player UI V2 (Part 1, Phase 3B): Skip Intro — rendered ONLY while the
         playhead is inside a VERIFIED intro segment of the CURRENT media
         (stale/invalid/missing data never render a button). Seeking uses the
         existing shell seek() so resume/progress behavior is preserved. -->
    {#if activeSkipSegment && source?.type === 'direct' && !touchLocked && !castConnected}
      <button class="skip-intro-button" type="button" aria-label={`Skip intro, seek to ${Math.round(activeSkipSegment.endSec)} seconds`} onclick={() => activeSkipSegment && seek(activeSkipSegment.endSec)}>Skip Intro</button>
    {/if}
  </section>

  <!-- Immersive redesign: Back FAB — top-left overlay, translucent, safe-area aware.
       Player V2 corrections (approved layout): the Back control is the
       top-left FAB for EVERY provider — the Part 1 Blue Velvet in-row
       Back/Fullscreen exception is retired (one Back, one place). Per-source
       Admin placement/size overrides (MAVP-2 Phase 4/5) still apply to THIS
       FAB; every source without a custom profile keeps the safe-area-aware
       top-left default. While touch-locked the FAB stays reachable
       (essential navigation is never blocked). -->
  <button class="back-fab" class:custom-position={Boolean(backControlStyle)} class:custom-size={backSizePx !== null} type="button" aria-label="Close player" style={backControlStyle} onclick={onClose}>
    <ArrowLeft size={20} />
  </button>

  <!-- Immersive redesign: Direct source playback controls as an overlay (auto-hiding).
       Player V2 corrections (approved layout): PlayerControls is the
       three-zone control surface — top-right utilities (Lock/PiP/Cast),
       dominant center cluster (±10 s / Play / Pause) and the bottom zone
       (time, timeline, subtitles, quality, display mode, speed, fullscreen).
       Subtitle menu receives native + external tracks. -->
  {#if source?.type === 'direct'}
    <div class="direct-controls-overlay" class:visible={controlsVisible}>
      <PlayerControls playing={playing} {muted} {volume} {currentTime} {duration} {buffered} {playbackRate} {pictureInPictureSupported} {pictureInPicture} fullscreenActive={fullscreen} onFullscreen={() => { void toggleFullscreen(); }} locked={touchLocked} onToggleLock={toggleTouchLock} subtitles={mergedSubtitles} selectedSubtitle={selectedSubtitle} subtitleNotice={externalSubtitleNotice} subtitlePrefs={subtitlePrefs} onSubtitlePreferences={setSubtitlePreferences} onMenuOpenChange={(open) => { controlsSheetsOpen = open; }} qualities={qualities} selectedQuality={selectedQuality} internalQualities={engineQuality?.options ?? []} selectedInternalQuality={engineQuality?.selected ?? PLAYER_AUTO_QUALITY_ID} {displayMode} onDisplayMode={setDisplayMode} castAvailable={castReady && Boolean(castEligibility?.eligible)} castActive={castConnected} onCast={() => { void handleCastAction(); }} onTogglePlay={togglePlay} onSeek={seek} onVolume={setVolume} onToggleMute={toggleMute} onPlaybackRate={setPlaybackRate} onSubtitle={setSubtitle} onQuality={setQuality} onInternalQuality={setInternalQuality} onPictureInPicture={togglePictureInPicture} onStep={seekBy} />
    </div>
  {/if}

  <!-- Player redesign: dedicated bottom-right Landscape/Portrait control.
       ~48px circular touch target, safe-area aware, distinct orientation and
       fullscreen states (fullscreen state is mirrored by the browser-synced
       `fullscreen` flag + orientation lock attempt in toggleLandscape).
       Positioning is overridable per source via the Admin
       "Player Controls Position" config (CSS vars below).
       Player V2 corrections (approved layout): direct sources now carry
       fullscreen INSIDE the bottom secondary row for EVERY provider, so this
       floating FAB renders ONLY for embed sources — their provider-owned
       surface has no Mavero control row, and losing fullscreen there would
       remove an existing feature. -->
  {#if source?.type === 'embed'}
  <div class="control-fab-group" class:visible={controlsVisible} style={landscapeControlStyle}>
    <!-- MAVP-5 (Issue 4): the Episodes entry point moved OUT of the
         Landscape control group into the dedicated left-edge episode chip
         (mirroring the right-edge source chip) with its own independent
         position contract. The group now carries only the Landscape FAB,
         whose per-source positioning/sizing is byte-unchanged. -->
    <button class="control-fab landscape-fab" class:custom-size={landscapeSizePx !== null} type="button" aria-label={landscapeMode ? 'Exit landscape player' : 'Enter landscape player'} aria-pressed={landscapeMode} onclick={() => { void toggleLandscape(); }}>
      {#if landscapeMode}<Minimize2 size={22} />{:else}<Maximize2 size={22} />{/if}
    </button>
  </div>
  {/if}

  <!-- Player UI V2 (Part 1, Phase 2C): persistent unlock FAB. Rendered ONLY
       while touch-locked and INDEPENDENT of the auto-hide cycle — the player
       can never strand the user without controls. Tapping it unlocks and
       immediately reveals the controls. -->
  {#if touchLocked}
    <button class="unlock-fab" type="button" aria-label="Unlock player controls" onclick={toggleTouchLock}>
      <LockOpen size={20} />
    </button>
  {/if}

  <!-- Player redesign: slim vertical source chip on the right edge, attached
       around the vertical centre of the viewport (Rivestream reference).
       MAVP-2 Phase 2: the CLOSED chip is only the ~6px visible bar — the
       dark translucent surface is carried by the BAR (and the hover label
       pill), NOT by a wide slab behind them; the button itself is a
       transparent ≥44×64 hit area so the touch target stays usable without
       the visual bulk. On hover/focus it reveals the ACTIVE source's name
       (content-aware) truncated with an ellipsis at a bounded max-width so
       long names can never expand the chip or push controls off-screen.
       Opens the EXISTING source sheet (the same sheet, grouping, ordering
       and state as before — no second source system). Playback keeps
       running while the sheet is open. Hides with the other Mavero
       controls; never covers provider controls (it hugs the right edge and
       expands only leftward on hover). -->
  {#if sourceOptions.length}
    <button class="source-chip" class:visible={controlsVisible} type="button" aria-label="Choose source" aria-haspopup="dialog" onclick={(event) => openSourceSheet(event.currentTarget instanceof HTMLElement ? event.currentTarget : playerRoot)}>
      <span class="source-chip-label" aria-hidden="true">{activeSourceOption?.name || 'Source'}</span>
      <span class="source-chip-bar" aria-hidden="true"></span>
    </button>
  {/if}

  <!-- MAVP-5 (Issue 4): dedicated LEFT-edge episode chip — the exact mirror
       of the source chip (bar + hover label + ≥44px touch target), rendered
       ONLY when the current content supports episode selection (movies never
       render it — the episodes list is empty there).
       MAVP-6 (Issues 2+3): the chip is FIXED like the source chip — no
       per-source placement/size style is applied, so both edge chips share
       the identical stylesheet vertical reference (top:50% +
       translateY(-50%)) and are vertically aligned by construction.
       Opens the EXISTING episode sheet, which slides in from the LEFT. -->
  {#if episodes.length}
    <button class="episode-chip" class:visible={controlsVisible} type="button" aria-label="Choose episode" aria-haspopup="dialog" onclick={(event) => openEpisodeSheet(event.currentTarget instanceof HTMLElement ? event.currentTarget : playerRoot)}>
      <span class="episode-chip-bar" aria-hidden="true"></span>
      <span class="episode-chip-label" aria-hidden="true">{episodeChipLabel}</span>
    </button>
  {/if}

  {#if sourceMenuOpen}
    <!-- Source sheet — responsive: bottom sheet on compact, right drawer on wide. -->
    <div class="sheet-overlay" role="presentation" onclick={() => closeSourceSheet()}></div>
    <div class="source-sheet" role="dialog" aria-modal="true" aria-label="Available playback sources">
      <div class="sheet-handle" aria-hidden="true"></div>
      <div class="sheet-head"><span class="eyebrow">Source</span><button class="close-button" type="button" aria-label="Close source list" onclick={() => closeSourceSheet()}><X size={17} /></button></div>
      <div class="sheet-list">{#each groupedSourceOptions as group}{#if groupedSourceOptions.length > 1 || group.name !== 'Other'}<div class="sheet-group-label" aria-hidden="true">{group.name}</div>{/if}{#each group.options as option}<div class="sheet-option-row"><button class="sheet-option" class:active={option.id === source?.sourceId && (!option.variants || option.variants.length === 0 || option.variants.includes(source?.metadata?.selectedVariant ?? ''))} type="button" onclick={() => chooseSource(option.id)}><span class="option-mark" class:selected={option.id === source?.sourceId}>{#if option.id === source?.sourceId}<Check size={14} />{:else}<SourceIcon icon={option.icon} size={15} />{/if}</span><span class="option-copy"><strong class="option-title"><span class="option-name">{option.name}</span>{#each option.badges ?? [] as badgeConfig (badgeConfig.id)}<span class="source-badge" data-variant={badgeConfig.variant}>{badgeConfig.label}</span>{/each}{#if option.badge && !(option.badges ?? []).length}<span class="source-badge" data-badge={option.badge}>{sourceBadgeLabel(option.badge)}</span>{/if}</strong><small>{option.status ?? 'available'}{#if option.integrationType} · {option.integrationType}{/if}</small></span></button>{#if option.variants && option.variants.length > 0}<div class="variant-row" role="group" aria-label={`${option.name} variants`}>{#each option.variants as variant}<button class="variant-button" class:active={option.id === source?.sourceId && source?.metadata?.selectedVariant === variant} type="button" aria-pressed={option.id === source?.sourceId && source?.metadata?.selectedVariant === variant} onclick={(e) => { e.stopPropagation(); chooseSource(option.id, variant); }}>{variant === 'sub' ? 'SUB' : variant === 'dub' ? 'DUB' : variant.toUpperCase()}</button>{/each}</div>{/if}</div>{/each}{/each}
      </div>
    </div>
  {/if}

  {#if episodeMenuOpen}
    <div class="sheet-overlay" role="presentation" onclick={() => closeEpisodeSheet()}></div>
    <div class="episode-sheet" role="dialog" aria-modal="true" aria-label="Episode list">
      <div class="sheet-handle" aria-hidden="true"></div>
      <div class="sheet-head"><span class="eyebrow">Episodes · {episodes.length}</span><button class="close-button" type="button" aria-label="Close episode list" onclick={() => closeEpisodeSheet()}><X size={17} /></button></div>
      <div class="sheet-list">{#each episodes as episode}<button class="sheet-option" class:active={currentEpisode?.season === episode.season && currentEpisode?.episode === episode.number} type="button" onclick={() => chooseEpisode({ season: episode.season, episode: episode.number, title: episode.title })}><span class="episode-number">{String(episode.number).padStart(2, '0')}</span><span><strong>{episode.title}</strong><small>S{episode.season} · {episode.runtime ?? 'Episode'}</small></span></button>{/each}</div>
    </div>
  {/if}

</div>

<style>
  /* Immersive redesign: player owns the ENTIRE viewport.
     No persistent header/footer — controls are overlays.
     MAVP-4 Issue 2: explicit viewport contract — 100vh first (compatible
     fallback for browsers without dynamic viewport units), then 100dvh
     (tracks mobile browser UI); min-height mirrors the same chain. The
     scroll lock itself is the html[data-player-open] convention (app.css). */
  .player-shell { --player-bg: var(--base); position: relative; width: 100%; height: 100vh; height: 100dvh; min-height: 100vh; min-height: 100svh; min-height: 100dvh; overflow: hidden; color: var(--ink); background: var(--player-bg); }
  .player-shell.landscape-mode { height: 100vh; height: 100dvh; }

  /* Stage: fills the ENTIRE shell — no header/footer space consumed.
     MAVP-4 Issue 2: the viewport inside the stage gets a DEFINITE grid
     (minmax(0,1fr) tracks) so the iframe/video `height: 100%` always
     resolves against a definite grid area — the legacy in-flow
     `aspect-ratio: 16/9` embed rule (PlayerViewport) can no longer win
     during intrinsic sizing and collapse the embed into a letterboxed box
     with shell-painted bands around it (the reported portrait black
     space). The provider keeps its OWN presentation inside the full-viewport
     iframe (no stretch, no crop, object-fit untouched). */
  .stage-wrap { position: absolute; inset: 0; display: grid; place-items: center; overflow: hidden; }
  .stage-wrap :global(.viewport) { width: 100%; height: 100%; min-height: 0; max-height: none; border-radius: 0; box-shadow: none; display: grid; grid-template-columns: minmax(0, 1fr); grid-template-rows: minmax(0, 1fr); }
  .stage-wrap :global(.viewport.embed) { width: 100%; }
  .stage-wrap :global(.viewport iframe), .stage-wrap :global(.viewport video) { width: 100%; height: 100%; }
  /* MAVP-4 Issue 2: inside the fullscreen shell the embed iframe is an
     explicit full-viewport surface — the legacy detail-page-era
     `aspect-ratio: 16/9` (PlayerViewport) is neutralized HERE so the
     sizing model is explicit and order-independent, and the provider's own
     aspect handling is preserved inside the iframe. */
  .stage-wrap :global(.viewport.embed iframe) { aspect-ratio: auto; height: 100%; min-height: 0; }
  /* MAVP-5 RC-1: the embed iframe box is EXPLICITLY bounded on both axes —
     width:100%/height:100% size it to the stage, and the max-* invariants
     guarantee the box can never exceed the stage even if a future rule
     reintroduces intrinsic sizing pressure (the provider's OWN presentation
     inside the box is untouched; no stretch, no crop — object-fit
     untouched). The unsandboxed VidRift frame renders in exactly the same
     bounded box as every other provider. */
  .stage-wrap :global(.viewport.embed iframe) { max-width: 100%; max-height: 100%; }

  /* MAVP-4 Issue 1: embed presentation veil — opaque shell-background layer
     covering the stage while the embed loads/boots. z-index sits BETWEEN the
     iframe (z-1) and the message/loading cards (z-7); pointer-events:none
     keeps the provider interactable (tap = reveal signal). */
  .embed-veil { position: absolute; z-index: 6; inset: 0; background: var(--player-bg, var(--base)); pointer-events: none; }

  /* Back FAB — top-left overlay, translucent, safe-area aware.
     MAVP-2 Phase 4/5: a per-source Back-button placement (Admin "Player
     Controls Position" → Back control) is applied as an inline style and
     overrides the top/left/bottom/right defaults below; the DEFAULTS (and
     every source without a custom profile) keep the safe-area-aware
     top-left placement exactly as shipped. */
  .back-fab { position: absolute; z-index: 12; top: max(12px, env(safe-area-inset-top)); left: max(12px, env(safe-area-inset-left)); display: grid; place-items: center; width: 44px; height: 44px; border: 1px solid var(--line-strong); border-radius: 50%; color: #fff; background: rgba(0,0,0,.55); cursor: pointer; backdrop-filter: blur(12px); visibility: visible; transition: opacity var(--motion-normal) var(--ease-out), transform var(--motion-normal) var(--ease-out), background var(--motion-fast) var(--ease-out), visibility 0s linear 0s; }
  .back-fab:hover, .back-fab:focus-visible { background: rgba(0,0,0,.75); border-color: var(--accent); }
  .back-fab:active { transform: scale(.94); }
  /* MAVP-3 Issue 5: per-source Back-button SIZE (Admin "Player Controls
     Position" → size, px). The custom-size class is applied ONLY when the
     active source configures a size, so sources without custom sizing keep
     the stylesheet defaults byte-identically (including the compact
     landscape-phone media query below). The icon scales proportionally
     (20/44 = the shipped default ratio). */
  .back-fab.custom-size { width: var(--back-fab-size, 44px); height: var(--back-fab-size, 44px); }
  .back-fab.custom-size :global(svg) { width: calc(var(--back-fab-size, 44px) * 0.4545); height: calc(var(--back-fab-size, 44px) * 0.4545); }
  /* FAB auto-hide: hidden state is opacity:0 + visibility:hidden + pointer-events:none.
     The visibility transition has a delay matching the opacity fade so the FAB
     stays visible during the fade-out, then becomes invisible + non-interactive
     after the fade completes. When revealing, visibility flips back instantly. */
  .player-shell.controls-hidden .back-fab { opacity: 0; visibility: hidden; pointer-events: none; transition: opacity var(--motion-normal) var(--ease-out), transform var(--motion-normal) var(--ease-out), background var(--motion-fast) var(--ease-out), visibility 0s linear var(--motion-normal); }

  /* Direct source controls overlay — auto-hiding full-shell control surface.
     Player V2 corrections: the overlay covers the ENTIRE shell (the approved
     layout's three zones — top-right utilities, center cluster, bottom zone —
     all position against it). It is pointer-transparent; PlayerControls'
     zones re-enable pointer events for their interactive children, so taps
     that miss every control still reach the video surface (gestures, reveal). */
  .direct-controls-overlay { position: absolute; z-index: 10; inset: 0; opacity: 1; transition: opacity var(--motion-normal) var(--ease-out); pointer-events: none; }
  .direct-controls-overlay:not(.visible) { opacity: 0; pointer-events: none; }
  .direct-controls-overlay:not(.visible) :global(*) { pointer-events: none !important; }

  /* Player redesign bottom-right control group — Landscape FAB + Episodes
     pill. Bottom-right by default (safe-area aware); the Admin's per-source
     "Player Controls Position" config overrides the offset via inline style
     (viewport-relative percentages, see player-controls-position.ts). */
  .control-fab-group { position: absolute; z-index: 12; bottom: max(16px, env(safe-area-inset-bottom)); right: max(16px, env(safe-area-inset-right)); display: flex; flex-direction: column; align-items: flex-end; gap: 8px; visibility: visible; transition: opacity var(--motion-normal) var(--ease-out), visibility 0s linear 0s; }
  .control-fab-group:not(.visible) { opacity: 0; visibility: hidden; pointer-events: none; transition: opacity var(--motion-normal) var(--ease-out), visibility 0s linear var(--motion-normal); }
  .player-shell.controls-hidden .control-fab-group { opacity: 0; visibility: hidden; pointer-events: none; transition: opacity var(--motion-normal) var(--ease-out), visibility 0s linear var(--motion-normal); }

  /* Landscape/fullscreen control — the group's primary FAB (48px touch
     target, spec range 44–48). Distinct orientation states: Maximize2 when
     entering landscape, Minimize2 when returning to portrait; the fullscreen
     state itself is browser-synced via the fullscreenchange listener. */
  .control-fab { display: grid; place-items: center; width: 48px; height: 48px; border: 1px solid var(--line-strong); border-radius: 50%; color: #fff; background: rgba(0,0,0,.65); cursor: pointer; backdrop-filter: blur(12px); box-shadow: 0 4px 16px rgba(0,0,0,.4); transition: background var(--motion-fast) var(--ease-out), transform var(--motion-fast) var(--ease-out); }
  .control-fab:hover, .control-fab:focus-visible { background: rgba(0,0,0,.85); border-color: var(--accent); }
  .control-fab:active { transform: scale(.93); }
  /* MAVP-3 Issue 5: per-source Landscape-button SIZE (px). Same pattern as
     the Back FAB — applied only when configured (22/48 = the shipped icon
     ratio); the Episodes pill in the same group is never resized. */
  .control-fab.custom-size { width: var(--landscape-fab-size, 48px); height: var(--landscape-fab-size, 48px); }
  .control-fab.custom-size :global(svg) { width: calc(var(--landscape-fab-size, 48px) * 0.4583); height: calc(var(--landscape-fab-size, 48px) * 0.4583); }

  /* Source chip — slim vertical control attached to the right edge around the
     vertical centre (Rivestream reference). MAVP-2 Phase 2: the CLOSED chip
     paints ONLY the ~5px bar — the dark translucent surface lives on the BAR
     (and the hover label pill), not on the button, so there is no wide
     translucent slab beside the edge. The button stays a transparent ≥44×64
     hit area (touch target preserved without visual bulk). Hover/focus
     reveals the ACTIVE source's name leftward, ellipsis-truncated at a
     bounded max-width so long names can never expand the chip or push other
     controls off-screen (the chip is absolutely positioned and expands
     leftward only — no layout shift possible). z-index below sheets (20/21);
     the chip NEVER blocks provider controls — it hugs the edge and hides
     with the other Mavero controls. */
  .source-chip { position: absolute; z-index: 12; top: 50%; right: 0; transform: translateY(-50%); display: flex; align-items: center; justify-content: flex-end; min-width: 44px; min-height: 64px; padding: 0; border: 0; background: transparent; cursor: pointer; visibility: visible; transition: opacity var(--motion-normal) var(--ease-out), visibility 0s linear 0s; }
  .source-chip-bar { flex: 0 0 auto; width: 5px; height: 56px; border-radius: 999px 0 0 999px; background: var(--accent); box-shadow: inset 0 0 0 1px var(--accent-strong); backdrop-filter: blur(12px); transition: background var(--motion-fast) var(--ease-out), box-shadow var(--motion-fast) var(--ease-out); }
  .source-chip-label { overflow: hidden; max-width: 0; opacity: 0; white-space: nowrap; text-overflow: ellipsis; font: inherit; font-size: .6rem; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; color: var(--accent); background: var(--accent-soft); border: 1px solid var(--accent-soft); border-right: 0; border-radius: 10px 0 0 10px; padding: 0 0 0 0; backdrop-filter: blur(12px); transition: max-width var(--motion-fast) var(--ease-out), opacity var(--motion-fast) var(--ease-out), padding var(--motion-fast) var(--ease-out); }
  .source-chip:hover .source-chip-bar, .source-chip:focus-visible .source-chip-bar { background: var(--accent-strong); box-shadow: inset 0 0 0 1px var(--accent); }
  .source-chip:hover .source-chip-label, .source-chip:focus-visible .source-chip-label { max-width: min(42vw, 220px); opacity: 1; padding: 12px 0 12px 14px; margin-right: 6px; }
  .source-chip:active .source-chip-bar { background: var(--accent-strong); }
  .player-shell.controls-hidden .source-chip { opacity: 0; visibility: hidden; pointer-events: none; transition: opacity var(--motion-normal) var(--ease-out), visibility 0s linear var(--motion-normal); }

  /* MAVP-5 (Issue 4): LEFT-edge episode chip — the exact mirror of the
     source chip (same bar + hover-label design system, same ≥44×64 hit
     area, same auto-hide participation, same z-index layering). Attached to
     the LEFT edge at the vertical centre; the hover label expands RIGHTWARD
     (bounded max-width, ellipsis) so it can never push other controls or
     overflow the viewport.
     MAVP-6 (Issues 2+3): the chip is FIXED like the source chip — no
     per-source position config or size override exists anymore; both edge
     chips share the identical vertical reference (top:50% +
     translateY(-50%), 64px hit area, 56px bar) and are vertically aligned
     BY CONSTRUCTION in both orientations. Movies never render it (no
     episodes). */
  .episode-chip { position: absolute; z-index: 12; top: 50%; left: 0; transform: translateY(-50%); display: flex; align-items: center; justify-content: flex-start; min-width: 44px; min-height: 64px; padding: 0; border: 0; background: transparent; cursor: pointer; visibility: visible; transition: opacity var(--motion-normal) var(--ease-out), visibility 0s linear 0s; }
  .episode-chip-bar { flex: 0 0 auto; width: 5px; height: 56px; border-radius: 0 999px 999px 0; background: var(--accent); box-shadow: inset 0 0 0 1px var(--accent-strong); backdrop-filter: blur(12px); transition: background var(--motion-fast) var(--ease-out), box-shadow var(--motion-fast) var(--ease-out); }
  .episode-chip-label { overflow: hidden; max-width: 0; opacity: 0; white-space: nowrap; text-overflow: ellipsis; font: inherit; font-size: .6rem; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; color: var(--accent); background: var(--accent-soft); border: 1px solid var(--accent-soft); border-left: 0; border-radius: 0 10px 10px 0; padding: 0 0 0 0; backdrop-filter: blur(12px); transition: max-width var(--motion-fast) var(--ease-out), opacity var(--motion-fast) var(--ease-out), padding var(--motion-fast) var(--ease-out); }
  .episode-chip:hover .episode-chip-bar, .episode-chip:focus-visible .episode-chip-bar { background: var(--accent-strong); box-shadow: inset 0 0 0 1px var(--accent); }
  .episode-chip:hover .episode-chip-label, .episode-chip:focus-visible .episode-chip-label { max-width: min(42vw, 220px); opacity: 1; padding: 12px 14px 12px 0; margin-left: 6px; }
  .episode-chip:active .episode-chip-bar { background: var(--accent-strong); }
  .player-shell.controls-hidden .episode-chip { opacity: 0; visibility: hidden; pointer-events: none; transition: opacity var(--motion-normal) var(--ease-out), visibility 0s linear var(--motion-normal); }

  /* MAVP-5 (Issue 4): the staggered-unfold `.fab-item` pill styles were
     removed together with the Episodes pill (its entry point is now the
     dedicated left-edge episode chip above). */

  /* Player UI V2 (Part 1, Phase 2A): simulated brightness overlay. Covers the
     stage only (z between the viewport and the message cards), pointer-
     transparent, and its opacity is driven inline from the gesture state. */
  .brightness-overlay { position: absolute; z-index: 5; inset: 0; background: #000; pointer-events: none; transition: opacity 80ms linear; }

  /* Player UI V2 (Part 1, Phase 2A/2B): compact transient gesture indicator —
     top-center pill, icon + bounded progress bar + percent. aria-hidden (the
     polite announcement lives in the sr-only live region below). */
  .gesture-indicator { position: absolute; z-index: 8; top: max(18px, env(safe-area-inset-top)); left: 50%; transform: translateX(-50%); display: flex; align-items: center; gap: 8px; min-height: 34px; padding: 0 12px; border: 1px solid var(--line); border-radius: 999px; color: var(--ink); background: rgba(13,13,13,.88); box-shadow: var(--shadow-lg); backdrop-filter: blur(18px); pointer-events: none; }
  /* Player V2 corrections: double-tap seek feedback — a transient direction
     pill on the tapped half of the video surface (left = rewind, right =
     forward), vertically clear of the center cluster and the bottom zone. */
  .seek-feedback { position: absolute; z-index: 8; top: 38%; display: flex; align-items: center; gap: 7px; min-height: 38px; padding: 0 14px; border: 1px solid var(--line); border-radius: 999px; color: var(--ink); background: rgba(13,13,13,.88); box-shadow: var(--shadow-lg); backdrop-filter: blur(18px); font-size: .72rem; font-weight: 700; font-variant-numeric: tabular-nums; pointer-events: none; }
  .seek-feedback.backward { left: max(20px, env(safe-area-inset-left)); }
  .seek-feedback.forward { right: max(20px, env(safe-area-inset-right)); }
  .seek-feedback :global(svg) { color: var(--accent); }
  /* Player V2 corrections: press-and-hold 2× indicator — same top-center
     pill system as the gesture indicator, with an accent speed badge. */
  .hold-indicator .hold-badge { display: grid; place-items: center; min-width: 30px; height: 24px; border-radius: 999px; color: #000; background: var(--accent-strong); font-size: .64rem; font-weight: 800; }
  .hold-indicator .hold-copy { color: var(--ink-soft); font-size: .6rem; }
  .gesture-indicator-bar { position: relative; overflow: hidden; width: 96px; height: 4px; border-radius: 999px; background: rgba(255,255,255,.18); }
  .gesture-indicator-bar > span { position: absolute; inset: 0 auto 0 0; border-radius: inherit; background: var(--accent); transition: width 60ms linear; }
  .gesture-indicator-value { min-width: 34px; color: var(--ink-soft); font-family: 'Inter', ui-sans-serif, system-ui, sans-serif; font-size: .6rem; text-align: right; font-variant-numeric: tabular-nums; }
  .gesture-announcement { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); clip-path: inset(50%); white-space: nowrap; }

  /* Player UI V2 (Part 1, Phase 3B): compact Skip Intro action — bottom-right,
     above the control row, visually quiet. Rendered only while the playhead
     is inside a verified intro segment. */
  .skip-intro-button { position: absolute; z-index: 11; right: max(18px, env(safe-area-inset-right)); bottom: 92px; min-height: 38px; padding: 0 16px; border: 1px solid var(--line-strong); border-radius: 999px; color: var(--ink); background: rgba(13,13,13,.85); cursor: pointer; font: inherit; font-size: .66rem; font-weight: 600; letter-spacing: .02em; box-shadow: var(--shadow-lg); backdrop-filter: blur(18px); transition: border-color var(--motion-fast) var(--ease-out), background var(--motion-fast) var(--ease-out), transform var(--motion-fast) var(--ease-out); }
  .skip-intro-button:hover, .skip-intro-button:focus-visible { border-color: var(--accent); background: var(--accent-soft); }
  .skip-intro-button:active { transform: scale(.97); }

  /* Player UI V2 (Part 1, Phase 2C): persistent unlock FAB — top-right,
     safe-area aware, always visible while locked (independent of the
     auto-hide cycle). */
  .unlock-fab { position: absolute; z-index: 12; top: max(12px, env(safe-area-inset-top)); right: max(12px, env(safe-area-inset-right)); display: grid; place-items: center; width: 44px; height: 44px; border: 1px solid var(--line-strong); border-radius: 50%; color: #fff; background: rgba(0,0,0,.55); cursor: pointer; backdrop-filter: blur(12px); transition: background var(--motion-fast) var(--ease-out), transform var(--motion-fast) var(--ease-out); }
  .unlock-fab:hover, .unlock-fab:focus-visible { background: rgba(0,0,0,.75); border-color: var(--accent); }
  .unlock-fab:active { transform: scale(.94); }

  /* Player UI V2 (Part 1, Phase 2C): while touch-locked the Back FAB stays
     reachable (essential navigation is never blocked) even though the rest of
     the controls are suppressed. Rule placed after the controls-hidden rule
     so it wins the cascade. */
  .player-shell.touch-locked .back-fab { opacity: 1; visibility: visible; pointer-events: auto; }

  /* Overlay cards (error/completion/loading) — all centered in the
     playback viewport (stage-wrap). Focused fixes Issue 3 (2026-10):
     the LOADING card rejoins the centered group — it is now CENTERED
     in the playback viewport (top: 50%; left: 50%; translate(-50%, -50%))
     so it is positioned relative to the ACTUAL playback viewport, not
     at an arbitrary top offset. The previous top-center placement
     produced the screenshot's "Loading player…" card near the top of
     the screen with a SEPARATE oversized dark empty-orb in the middle
     of the empty viewport — two competing loading indicators. The
     empty-orb is now retired in PlayerViewport; the loading card is
     the SINGLE coherent loading presentation.

     z-index 7 keeps the loading card ABOVE the media surface
     (z-index 1) and BELOW the actionable player controls
     (z-index 10/12 — back/lock/subtitle/quality/fullscreen). The
     loading card therefore never covers those controls — it sits
     beneath them in the cascade. */
  .message-card, .completion-card { position: absolute; z-index: 7; right: 50%; bottom: 50%; display: flex; align-items: center; gap: 12px; max-width: min(590px, calc(100% - 36px)); transform: translate(50%, 50%); border: 1px solid var(--line); border-radius: var(--radius-md); padding: 15px 16px; color: var(--ink); background: rgba(13,13,13,.92); box-shadow: var(--shadow-lg); backdrop-filter: blur(22px); }
  .message-card strong { display: block; font-size: .75rem; }
  .message-card p { margin: 5px 0 0; color: var(--muted); font-size: .66rem; line-height: 1.45; }
  .message-icon { display: grid; flex: 0 0 34px; place-items: center; width: 34px; height: 34px; border-radius: var(--radius-sm); color: var(--ink-soft); background: var(--accent-soft); }
  .message-actions { display: flex; gap: 6px; margin-left: auto; }
  .small-button { display: inline-flex; align-items: center; gap: 6px; min-height: 34px; border: 1px solid var(--line-strong); border-radius: var(--radius-sm); padding: 0 12px; color: var(--ink); background: var(--accent-soft); cursor: pointer; font: inherit; font-size: .62rem; white-space: nowrap; }
  .small-button.secondary { border-color: var(--line); background: rgba(255,255,255,.04); }
  .completion-card { color: var(--ink-soft); }
  /* Focused fixes Issue 3 (2026-10): the loading indicator is the
     SINGLE coherent loading presentation — centered in the playback
     viewport (stage-wrap). It represents source resolution / player
     initialization / stream start ONLY — active buffering after
     playback already started is the viewport's corner 'Buffering…'
     note (no two overlapping loading indicators). The empty-orb that
     used to render in PlayerViewport during the no-source state is
     retired so the loading card alone owns the loading surface. */
  .loading-card { position: absolute; z-index: 7; top: 50%; left: 50%; right: auto; bottom: auto; transform: translate(-50%, -50%); display: flex; align-items: center; gap: 12px; max-width: min(420px, calc(100% - 24px)); border: 1px solid var(--line); border-radius: var(--radius-md); padding: 14px 16px; color: var(--ink); background: rgba(13,13,13,.92); box-shadow: var(--shadow-lg); backdrop-filter: blur(22px); }
  .loading-card { min-width: min(260px, calc(100% - 36px)); justify-content: center; color: var(--ink-soft); font-size: .68rem; }
  /* Focused fixes Issue 3 (2026-10): clean, modern Material/iOS-style
     spinner — a 2.5px ring with the Mavero accent on the leading edge.
     Replaces the previous conic-gradient ring (which was nearly
     invisible: --ink-soft on a dark surface, 38px diameter, with a
     28px inner hole). The new ring is 36px, brighter, and uses the
     accent color directly so it reads at a glance against any
     backdrop. Sensible dimensions (not oversized), appropriate
     contrast (accent green on dark with a 0.12 white track for the
     remaining arc), and the existing `spin` animation is reused. */
  .loading-ring { flex: 0 0 36px; width: 36px; height: 36px; border: 2.5px solid rgba(255, 255, 255, 0.12); border-top-color: var(--accent, #00d18a); border-radius: 50%; animation: spin 0.9s linear infinite; }
  .loading-copy { display: grid; gap: 4px; text-align: left; }
  .loading-copy strong { color: var(--ink); font-size: .72rem; }
  .loading-copy small { color: var(--muted); font-family: 'Inter', ui-sans-serif, system-ui, sans-serif; font-size: .53rem; }
  :global(.spin) { animation: spin 1s linear infinite; }

  /* Source/episode/streams sheets — responsive:
     compact viewport → bottom sheet; wide viewport → right drawer.
     Based on actual viewport width (matchMedia), NOT landscapeMode.
     MAVP-5 (Issue 4): the EPISODE sheet is removed from this shared rule —
     it is now a LEFT drawer at every viewport (see below). */
  .sheet-overlay { position: absolute; z-index: 20; inset: 0; background: rgba(0,0,0,.4); backdrop-filter: blur(2px); }
  .source-sheet { position: absolute; z-index: 21; bottom: 0; left: 0; right: 0; top: auto; max-height: 60dvh; overflow: auto; border-top: 1px solid var(--line-strong); border-radius: var(--radius-lg) var(--radius-lg) 0 0; background: rgba(13,13,13,.98); box-shadow: var(--shadow-lg); backdrop-filter: blur(28px); padding-bottom: env(safe-area-inset-bottom); transform: none; animation: sheet-up var(--motion-normal) var(--ease-out); }
  .sheet-handle { width: 36px; height: 4px; margin: 8px auto 4px; border-radius: 999px; background: var(--line-strong); }
  .sheet-head { display: flex; align-items: center; justify-content: space-between; padding: 4px 18px 10px; }
  .sheet-head .eyebrow { color: var(--muted); }
  .close-button { display: grid; place-items: center; width: 34px; height: 34px; border: 1px solid var(--line); border-radius: var(--radius-sm); color: var(--muted); background: rgba(255,255,255,.04); cursor: pointer; }
  .sheet-list { display: grid; gap: 4px; padding: 0 12px 14px; }
  .sheet-group-label { color: var(--muted); font-family: 'Inter', ui-sans-serif, system-ui, sans-serif; font-size: .54rem; font-weight: 700; letter-spacing: .1em; text-transform: uppercase; padding: 10px 0 4px; border-top: 1px solid var(--line); margin-top: 6px; }
  .sheet-group-label:first-child { border-top: 0; margin-top: 0; padding-top: 0; }
  .sheet-option { display: flex; align-items: center; gap: 11px; min-height: 52px; border: 1px solid transparent; border-radius: var(--radius-sm); padding: 7px 12px; color: var(--ink-soft); background: transparent; cursor: pointer; text-align: left; }
  .sheet-option:hover, .sheet-option:focus-visible, .sheet-option.active { border-color: var(--line-strong); background: var(--accent-soft); }
  .sheet-option strong, .sheet-option small { display: block; }
  .sheet-option strong { color: var(--ink); font-size: .72rem; }
  .sheet-option small { margin-top: 4px; color: var(--muted); font-family: 'Inter', ui-sans-serif, system-ui, sans-serif; font-size: .55rem; }
  .sheet-option-row { display: flex; flex-direction: column; gap: 6px; }
  .variant-row { display: flex; gap: 6px; padding: 0 12px 6px; }
  .variant-button { display: inline-flex; align-items: center; justify-content: center; min-height: 36px; min-width: 56px; padding: 0 10px; border: 1px solid var(--line-strong); border-radius: var(--radius-sm); color: var(--ink-soft); background: rgba(255,255,255,.02); cursor: pointer; font: inherit; font-size: .58rem; font-weight: 600; letter-spacing: .04em; text-transform: uppercase; transition: border-color var(--motion-fast) var(--ease-out), background var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out); }
  .variant-button:hover, .variant-button:focus-visible { border-color: var(--line-strong); background: var(--accent-soft); color: var(--ink); }
  .variant-button.active { border-color: var(--accent); background: var(--accent-soft); color: var(--ink); }
  .option-mark { display: grid; flex: 0 0 24px; place-items: center; width: 24px; height: 24px; color: var(--muted); }
  .option-mark.selected { border: 1px solid var(--line-strong); border-radius: 50%; color: var(--accent); }
  .option-copy { min-width: 0; flex: 1; }
  .option-title { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; min-width: 0; }
  .option-name { min-width: 0; overflow-wrap: anywhere; }
  /* Task 13: user-facing source badge — visually small and secondary to the
     source name. Existing design tokens only; the amber tint re-uses the
     sheet's existing failed-state tone. */
  .source-badge { flex: 0 0 auto; border: 1px solid var(--line-strong); border-radius: 999px; padding: 1px 7px; color: var(--muted); font-family: 'Inter', ui-sans-serif, system-ui, sans-serif; font-size: .48rem; font-weight: 700; letter-spacing: .08em; line-height: 1.5; text-transform: uppercase; }
  .source-badge[data-badge='ads'] { color: #ffb020; border-color: rgba(255, 176, 32, .35); }
  .source-badge[data-badge='ad-free'] { color: var(--accent); border-color: var(--accent-soft); }
  /* MAVP-4 Issue 4: extensible badge VARIANTS — theme tokens only (accent
     renders on the secondary accent so 4K/Ad-Free/Ads stay visually distinct;
     the legacy single-badge rules above are kept for backward compatibility). */
  .source-badge[data-variant='accent'] { color: var(--accent-2); border-color: var(--accent-2-soft); }
  .source-badge[data-variant='positive'] { color: var(--success); border-color: var(--accent-soft); }
  .source-badge[data-variant='warning'] { color: var(--warning); border-color: color-mix(in srgb, var(--warning) 35%, transparent); }
  .source-badge[data-variant='neutral'] { color: var(--muted); border-color: var(--line-strong); }
  .episode-number { flex: 0 0 28px; color: var(--accent); font-family: 'Inter', ui-sans-serif, system-ui, sans-serif; font-size: .65rem; }
  @keyframes spin { to { transform: rotate(360deg); } }
  @keyframes sheet-up { from { transform: translateY(100%); } to { transform: translateY(0); } }

  /* MAVP-5 (Issue 4): the episode sheet opens from the LEFT at every
     viewport — a full-height drawer sliding in from the left edge with a
     consistent open/close animation, mirroring the right-edge source sheet
     on wide viewports. Same surface system (z-21, blur, border, safe-area
     bottom padding); same focus trap, Escape and focus-restore contracts. */
  .episode-sheet { position: absolute; z-index: 21; top: 0; bottom: 0; left: 0; right: auto; width: min(360px, 88vw); max-height: none; overflow: hidden; display: grid; grid-template-rows: auto auto 1fr; border-top: 0; border-right: 1px solid var(--line-strong); border-radius: 0; background: rgba(13,13,13,.98); box-shadow: var(--shadow-lg); backdrop-filter: blur(28px); padding-bottom: 0; animation: sheet-left var(--motion-normal) var(--ease-out); }
  .episode-sheet .sheet-list { max-height: 100%; overflow-y: auto; padding-bottom: max(14px, env(safe-area-inset-bottom)); }
  @keyframes sheet-left { from { transform: translateX(-100%); } to { transform: translateX(0); } }

  /* Wide viewport (landscape/desktop/TV): the source sheet becomes a
     right-edge drawer (the episode sheet is a LEFT drawer at every
     viewport — MAVP-5 Issue 4). Based on viewport width, NOT landscapeMode. */
  @media (min-width: 769px) {
    .source-sheet { top: 0; right: 0; bottom: 0; left: auto; width: min(360px, 32vw); height: 100%; max-height: 100%; border-top: 0; border-radius: 0; border-left: 1px solid var(--line-strong); animation: slide-right var(--motion-normal) var(--ease-out); }
    .source-sheet .sheet-list { max-height: 100%; overflow-y: auto; padding-bottom: max(14px, env(safe-area-inset-bottom)); }
    @keyframes slide-right { from { transform: translateX(100%); } to { transform: translateX(0); } }
  }

  /* Mobile: compact FAB sizing. */
  @media (max-width: 640px) {
    .message-card { bottom: 50%; flex-wrap: wrap; }
    .message-actions { width: 100%; margin-left: 46px; }
  }

  /* Landscape phone — compact control positioning.
     Final remediation (Issue 2): the Back FAB sits closer to the landscape
     viewport's left corner (6px floor instead of 8px, still under the
     max() contract so a REAL device safe-area inset always wins). Portrait
     placement is untouched; per-source Admin overrides (inline styles)
     keep winning over both defaults. */
  @media (orientation: landscape) and (max-height: 500px) {
    .back-fab { width: 40px; height: 40px; top: max(6px, env(safe-area-inset-top)); left: max(6px, env(safe-area-inset-left)); }
    .control-fab { width: 46px; height: 46px; }
    .source-chip { min-height: 56px; }
    .source-chip-bar { height: 48px; }
    .episode-chip { min-height: 56px; }
    .episode-chip-bar { height: 48px; }
  }

  @media (prefers-reduced-motion: reduce) {
    .loading-ring, :global(.spin) { animation: none; }
    .back-fab, .control-fab, .control-fab-group, .direct-controls-overlay, .source-chip, .source-chip-label, .episode-chip, .episode-chip-label { transition: none; }
    .source-sheet, .episode-sheet { animation: none; }
    /* Player UI V2 (Part 1, Phase 2/3): new gesture/skip surfaces follow the
       same reduced-motion contract. */
    .brightness-overlay, .gesture-indicator-bar > span, .skip-intro-button, .unlock-fab { transition: none; }
    /* Player V2 corrections: seek feedback + hold indicator join the
       reduced-motion contract. */
    .seek-feedback, .hold-indicator { transition: none; }
  }
</style>
