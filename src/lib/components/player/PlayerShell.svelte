<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { AlertTriangle, ArrowLeft, Check, Maximize2, Minimize2, RotateCcw, Settings2, X } from 'lucide-svelte';
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
  export let resolutionKind: 'provider-error' | 'unsupported' | 'unavailable' = 'provider-error';
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
  // Player startup redesign: the shell mounts BEFORE the source resolves —
  // the initial state is 'preparing' (single lightweight loading card), never
  // 'source-unavailable'. Real unavailability still arrives through explicit
  // state mutations (togglePlay fallback, resolutionKind, adapter errors), so
  // no error path is lost — only the mount-time flash of the error card is.
  let state: PlayerPlaybackState = 'preparing';
  let errorMessage = '';
  let selectedQuality = '';
  let selectedSubtitle = '';
  let sourceMenuOpen = false;
  let episodeMenuOpen = false;
  let controlsVisible = true;
  let hideTimer: ReturnType<typeof setTimeout> | undefined;
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
  // MAVP-5 (Issue 4): the Episodes chip resolves through its OWN position
  // contract (position.episodes + sizes.episodes) — fully independent from
  // the Back and Landscape controls. Default (unset axes): attached to the
  // LEFT edge at the vertical centre, mirroring the source chip on the
  // right edge. Styles follow the exact same inline-style pipeline as the
  // other controls (placement axes + a disjoint size custom property).
  $: episodesSizePx = resolveControlSize(activeSourceOption?.controlsPosition ?? null, 'episodes');
  $: episodesControlStyle = [
    controlsPlacementInlineStyle(resolveControlPlacement(activeSourceOption?.controlsPosition ?? null, 'episodes', playerOrientation)),
    controlsSizeInlineStyle(activeSourceOption?.controlsPosition ?? null, 'episodes', '--episodes-chip-size'),
  ].filter(Boolean).join(';');
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
    if (document.pictureInPictureElement === videoElement) exitPipQuietly();
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
    void releaseWakeLock();
    clearMediaSession();
    if (document.pictureInPictureElement === videoElement) exitPipQuietly();
  }

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

  onMount(() => {
    // Player startup instrumentation: the shell is visible. Measured spans
    // are DEV-only logged; marks remain inspectable in production.
    markPlayerMilestone('mavero:shell');
    measurePlayerStartup();
    // MAVP-4 Issue 2: explicit document scroll lock for the player route —
    // the watch page renders bare (no AppShell) and the shell is exactly
    // 100dvh, but the document kept its default scroll behaviour, so browser
    // UI transitions and overscroll could scroll the page behind the player.
    // The project's established convention is an html data-attribute
    // (html[data-admin-sheet-open], html[data-a2-sheet-open] → body
    // overflow: hidden in app.css); the player follows the same pattern.
    // Set on mount, removed on destroy — never a global change.
    document.documentElement.setAttribute('data-player-open', '');
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
      const target = event.target as HTMLElement | null;
      // Never intercept shortcuts while typing in form fields or editable
      // surfaces (input/textarea/select/contenteditable).
      if (target?.matches('input, select, textarea, [contenteditable="true"]')) return;
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
      // Phase 8: clear embed load timeout on destroy.
      clearEmbedLoadTimeout();
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
      // Phase 6: explicit teardown of shell-level playback features. The browser
      // auto-exits fullscreen/PiP when playerRoot leaves the DOM, but explicit
      // calls are deterministic and prevent stale state across SPA navigation.
      if (document.pictureInPictureElement === videoElement) exitPipQuietly();
      if (document.fullscreenElement === playerRoot) exitFullscreenQuietly();
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
    duration = event.detail.duration || duration;
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

  function setSubtitle(url: string) {
    selectedSubtitle = url;
    if (!videoElement) return;
    Array.from(videoElement.textTracks).forEach((track) => { track.mode = 'disabled'; });
    if (!url) return;
    const trackIndex = Array.from(videoElement.querySelectorAll('track')).findIndex((track) => track.getAttribute('src') === url);
    const track = trackIndex >= 0 ? Array.from(videoElement.textTracks)[trackIndex] : Array.from(videoElement.textTracks).find((candidate) => candidate.label === url || candidate.language === url);
    if (track) track.mode = 'showing';
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
    if ((playing || embedPlaying || embedSessionArms) && !sourceMenuOpen && !episodeMenuOpen && !calibrationMode) {
      hideTimer = setTimeout(() => {
        if (!sourceMenuOpen && !episodeMenuOpen && !focusWithinMaveroControls()) {
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
    return Boolean(active.closest('.back-fab, .control-fab-group, .source-chip, .episode-chip, .direct-controls-overlay, .source-sheet, .episode-sheet'));
  }

  /** Open the source sheet from the bottom-right controls (focus returns there). */
  function openSourceSheetFromControl() {
    openSourceSheet(playerRoot ?? document.activeElement as HTMLElement);
  }

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

  <div bind:this={playerRoot} class="player-shell" class:landscape-mode={landscapeMode} class:controls-hidden={!controlsVisible} role="application" aria-label="MAVERO video player">

  <!-- Immersive redesign: stage fills the ENTIRE viewport — no header/footer consuming space. -->
  <section class="stage-wrap" aria-label="Player viewport">
    <PlayerViewport bind:this={viewport} bind:videoElement bind:iframeElement {source} {mediaUrl} sandboxEnabled={effectiveSandboxEnabled} sandboxPolicy={effectiveSandboxPolicy} poster={content.backdrop ?? content.poster ?? ''} title={content.title} state={effectiveState} subtitles={effectiveSubtitles} on:loadedmetadata={handleLoadedMetadata} on:timeupdate={handleTimeUpdate} on:play={handlePlay} on:pause={handlePause} on:waiting={handleWaiting} on:playing={handlePlaying} on:seeking={handleSeeking} on:seeked={handleSeeked} on:ended={handleEnded} on:error={handleMediaError} on:embedload={handleEmbedLoad} on:enginequality={handleEngineQuality} on:durationchange={handleSeekOpportunity} on:loadeddata={handleSeekOpportunity} on:canplay={handleSeekOpportunity} on:progress={handleSeekOpportunity} />

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

    {#if resolutionError || errorMessage || effectiveState === 'error' || effectiveState === 'provider-error' || effectiveState === 'source-unavailable' || effectiveState === 'unsupported-format' || effectiveState === 'embed-unavailable'}
      <div class="message-card" role="alert">
        <div class="message-icon"><AlertTriangle size={17} /></div>
        <div><strong>This source isn't available.</strong><p>{resolutionError || errorMessage || 'Choose another source or try again.'}</p></div>
        <div class="message-actions"><button class="small-button" type="button" aria-label="Try again" onclick={retry}><RotateCcw size={14} /> Try again</button>{#if sourceOptions.length}<button class="small-button secondary" type="button" aria-label="Switch source" onclick={(event) => openSourceSheet(event.currentTarget instanceof HTMLElement ? event.currentTarget : playerRoot)}><Settings2 size={14} /> Switch source</button>{/if}</div>
      </div>
    {:else if state === 'completed'}
      <div class="completion-card" role="status"><Check size={18} /><span>Episode complete</span></div>
    {:else if effectiveState === 'preparing' || effectiveState === 'resolving' || effectiveState === 'switching-source' || effectiveState === 'embed-loading'}
      <div class="loading-card" role="status"><span class="loading-ring" aria-hidden="true"><span></span></span><span class="loading-copy"><strong>{effectiveState === 'switching-source' ? 'Switching source…' : effectiveState === 'embed-loading' ? 'Starting your stream…' : 'Loading player…'}</strong><small>{resolutionMessage || (effectiveState === 'embed-loading' ? 'Loading provider embed…' : 'Preparing playback…')}</small></span></div>
    {/if}
  </section>

  <!-- Immersive redesign: Back FAB — top-left overlay, translucent, safe-area aware.
       MAVP-2 Phase 4/5: per-source Back-button placement (Admin "Player
       Controls Position" → Back control, independent portrait/landscape
       profiles). Empty inline style = stylesheet default (top-left).
       MAVP-3 Issue 5: the same inline style may carry the per-source Back
       SIZE (--back-fab-size); the custom-size class applies it on top of the
       stylesheet default without touching the placement. -->
  <button class="back-fab" class:custom-position={Boolean(backControlStyle)} class:custom-size={backSizePx !== null} type="button" aria-label="Close player" style={backControlStyle} onclick={onClose}>
    <ArrowLeft size={20} />
  </button>

  <!-- Immersive redesign: Direct source playback controls as an overlay (auto-hiding). -->
  {#if source?.type === 'direct'}
    <div class="direct-controls-overlay" class:visible={controlsVisible}>
      <PlayerControls playing={playing} {muted} {volume} {currentTime} {duration} {buffered} {playbackRate} {pictureInPictureSupported} {pictureInPicture} subtitles={subtitles} selectedSubtitle={selectedSubtitle} qualities={qualities} selectedQuality={selectedQuality} internalQualities={engineQuality?.options ?? []} selectedInternalQuality={engineQuality?.selected ?? PLAYER_AUTO_QUALITY_ID} sourceCount={sourceOptions.length} onTogglePlay={togglePlay} onSeek={seek} onVolume={setVolume} onToggleMute={toggleMute} onPlaybackRate={setPlaybackRate} onSubtitle={setSubtitle} onQuality={setQuality} onInternalQuality={setInternalQuality} onPictureInPicture={togglePictureInPicture} onStep={seekBy} onSources={openSourceSheetFromControl} />
    </div>
  {/if}

  <!-- Player redesign: dedicated bottom-right Landscape/Portrait control.
       ~48px circular touch target, safe-area aware, distinct orientation and
       fullscreen states (fullscreen state is mirrored by the browser-synced
       `fullscreen` flag + orientation lock attempt in toggleLandscape).
       Positioning is overridable per source via the Admin
       "Player Controls Position" config (CSS vars below). -->
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
       render it — the episodes list is empty there). Its position is the
       chip's OWN per-source contract (position.episodes + sizes.episodes) —
       it can never overwrite or share the source chip's or the Landscape
       control's configured position. Opens the EXISTING episode sheet,
       which now slides in from the LEFT. -->
  {#if episodes.length}
    <button class="episode-chip" class:visible={controlsVisible} class:custom-position={Boolean(episodesControlStyle)} class:custom-size={episodesSizePx !== null} type="button" aria-label="Choose episode" aria-haspopup="dialog" style={episodesControlStyle} onclick={(event) => openEpisodeSheet(event.currentTarget instanceof HTMLElement ? event.currentTarget : playerRoot)}>
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

  /* Direct source controls overlay — auto-hiding bottom bar. */
  .direct-controls-overlay { position: absolute; z-index: 10; bottom: 0; left: 0; right: 0; padding-bottom: env(safe-area-inset-bottom); opacity: 1; transition: opacity var(--motion-normal) var(--ease-out); pointer-events: auto; }
  .direct-controls-overlay:not(.visible) { opacity: 0; pointer-events: none; }

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
     overflow the viewport. A per-source position config overrides the
     placement via the same inline-style pipeline as the other controls; the
     per-source SIZE (--episodes-chip-size) applies to the chip's hit area
     height only when configured. Movies never render it (no episodes). */
  .episode-chip { position: absolute; z-index: 12; top: 50%; left: 0; transform: translateY(-50%); display: flex; align-items: center; justify-content: flex-start; min-width: 44px; min-height: var(--episodes-chip-size, 64px); padding: 0; border: 0; background: transparent; cursor: pointer; visibility: visible; transition: opacity var(--motion-normal) var(--ease-out), visibility 0s linear 0s; }
  .episode-chip.custom-size { min-height: var(--episodes-chip-size, 64px); }
  .episode-chip-bar { flex: 0 0 auto; width: 5px; height: 56px; border-radius: 0 999px 999px 0; background: var(--accent); box-shadow: inset 0 0 0 1px var(--accent-strong); backdrop-filter: blur(12px); transition: background var(--motion-fast) var(--ease-out), box-shadow var(--motion-fast) var(--ease-out); }
  .episode-chip-label { overflow: hidden; max-width: 0; opacity: 0; white-space: nowrap; text-overflow: ellipsis; font: inherit; font-size: .6rem; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; color: var(--accent); background: var(--accent-soft); border: 1px solid var(--accent-soft); border-left: 0; border-radius: 0 10px 10px 0; padding: 0 0 0 0; backdrop-filter: blur(12px); transition: max-width var(--motion-fast) var(--ease-out), opacity var(--motion-fast) var(--ease-out), padding var(--motion-fast) var(--ease-out); }
  .episode-chip:hover .episode-chip-bar, .episode-chip:focus-visible .episode-chip-bar { background: var(--accent-strong); box-shadow: inset 0 0 0 1px var(--accent); }
  .episode-chip:hover .episode-chip-label, .episode-chip:focus-visible .episode-chip-label { max-width: min(42vw, 220px); opacity: 1; padding: 12px 14px 12px 0; margin-left: 6px; }
  .episode-chip:active .episode-chip-bar { background: var(--accent-strong); }
  .player-shell.controls-hidden .episode-chip { opacity: 0; visibility: hidden; pointer-events: none; transition: opacity var(--motion-normal) var(--ease-out), visibility 0s linear var(--motion-normal); }

  /* MAVP-5 (Issue 4): the staggered-unfold `.fab-item` pill styles were
     removed together with the Episodes pill (its entry point is now the
     dedicated left-edge episode chip above). */

  /* Overlay cards (error/loading/completion) — centered in viewport. */
  .message-card, .completion-card, .loading-card { position: absolute; z-index: 7; right: 50%; bottom: 50%; display: flex; align-items: center; gap: 12px; max-width: min(590px, calc(100% - 36px)); transform: translate(50%, 50%); border: 1px solid var(--line); border-radius: var(--radius-md); padding: 15px 16px; color: var(--ink); background: rgba(13,13,13,.92); box-shadow: var(--shadow-lg); backdrop-filter: blur(22px); }
  .message-card strong { display: block; font-size: .75rem; }
  .message-card p { margin: 5px 0 0; color: var(--muted); font-size: .66rem; line-height: 1.45; }
  .message-icon { display: grid; flex: 0 0 34px; place-items: center; width: 34px; height: 34px; border-radius: var(--radius-sm); color: var(--ink-soft); background: var(--accent-soft); }
  .message-actions { display: flex; gap: 6px; margin-left: auto; }
  .small-button { display: inline-flex; align-items: center; gap: 6px; min-height: 34px; border: 1px solid var(--line-strong); border-radius: var(--radius-sm); padding: 0 12px; color: var(--ink); background: var(--accent-soft); cursor: pointer; font: inherit; font-size: .62rem; white-space: nowrap; }
  .small-button.secondary { border-color: var(--line); background: rgba(255,255,255,.04); }
  .completion-card { color: var(--ink-soft); }
  .loading-card { min-width: min(260px, calc(100% - 36px)); justify-content: center; color: var(--ink-soft); font-size: .68rem; }
  .loading-ring { display: grid; flex: 0 0 38px; place-items: center; width: 38px; height: 38px; border: 1px solid var(--line); border-radius: 50%; background: conic-gradient(from 0deg, transparent 0 24%, var(--ink-soft) 42%, var(--accent-soft) 72%, transparent 100%); animation: spin 1.2s linear infinite; }
  .loading-ring > span { width: 28px; height: 28px; border-radius: 50%; background: var(--surface); }
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

  /* Landscape phone — compact control positioning. */
  @media (orientation: landscape) and (max-height: 500px) {
    .back-fab { width: 40px; height: 40px; top: max(8px, env(safe-area-inset-top)); left: max(8px, env(safe-area-inset-left)); }
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
  }
</style>
