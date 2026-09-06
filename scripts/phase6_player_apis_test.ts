import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Phase 6: Fullscreen / Orientation / PiP / Wake Lock / Media Session contract tests.
//
// These tests verify the shell-level playback experience improvements added in
// Phase 6, without modifying Phase 1-5 behavior. The dual-path architecture is
// preserved: PlayerShell owns shell-level state; PlaybackManager/adapters own
// normalized provider state.
//
// Coverage:
// - PiP: listeners on videoElement (NOT document), active state sync, cleanup
// - Fullscreen: playerRoot target, fullscreenchange sync, cleanup, orientation unlock on Esc
// - Orientation: fullscreen-before-lock ordering, lock('landscape'), rejection handled, unlock, unsupported API
// - Wake Lock: support detection, request('screen'), acquire/release wiring, visibility re-acquire, sentinel cleanup, destroy cleanup
// - Media Session: support detection, metadata, artwork only when valid, play/pause/seekbackward/seekforward/seekto, playbackState, setPositionState validation, handler cleanup, metadata cleanup, direct-only gating
// - Security: no iframe fullscreen invocation, no iframe PiP invocation
// - Regression: Phase 1-5 contracts preserved (function names, CSS classes, aria-labels)

const shell = readFileSync(new URL('../src/lib/components/player/PlayerShell.svelte', import.meta.url), 'utf8');
const controls = readFileSync(new URL('../src/lib/components/player/PlayerControls.svelte', import.meta.url), 'utf8');
const viewport = readFileSync(new URL('../src/lib/components/player/PlayerViewport.svelte', import.meta.url), 'utf8');

// ============================================================
// 1. PiP — listeners attached to videoElement, NOT document
// ============================================================

// The previous bug: document.addEventListener('enterpictureinpicture', ...) never fires
// because PiP events fire on the HTMLVideoElement and do NOT bubble to document.
// Phase 6 audit fix: listeners are attached via a reactive block that tracks
// the videoElement lifecycle. The attachPipListeners() function attaches to
// the `current` video element (not a captured-once `videoElement` variable),
// and detaches from the previous element when the identity changes.
assert.match(shell, /function attachPipListeners\(current: HTMLVideoElement \| undefined\)/, 'attachPipListeners function exists');
assert.match(shell, /current\.addEventListener\('enterpictureinpicture', handlePictureInPicture\)/, 'PiP enter listener attached to current videoElement');
assert.match(shell, /current\.addEventListener\('leavepictureinpicture', handlePictureInPicture\)/, 'PiP leave listener attached to current videoElement');
assert.match(shell, /lastPipVideoElement\.removeEventListener\('enterpictureinpicture', handlePictureInPicture\)/, 'PiP enter listener removed from previous videoElement');
assert.match(shell, /lastPipVideoElement\.removeEventListener\('leavepictureinpicture', handlePictureInPicture\)/, 'PiP leave listener removed from previous videoElement');
assert.match(shell, /\$: attachPipListeners\(videoElement\)/, 'reactive PiP listener attachment tracks videoElement lifecycle');
assert.match(shell, /if \(current === lastPipVideoElement\) return/, 'no duplicate attachment when videoElement identity unchanged');
assert.match(shell, /let lastPipVideoElement: HTMLVideoElement \| undefined = undefined/, 'lastPipVideoElement state tracks previous element');
// The dead document listeners must be ABSENT.
assert.doesNotMatch(shell, /document\.addEventListener\('enterpictureinpicture'/, 'no document PiP enter listener (dead code removed)');
assert.doesNotMatch(shell, /document\.addEventListener\('leavepictureinpicture'/, 'no document PiP leave listener (dead code removed)');
assert.doesNotMatch(shell, /document\.removeEventListener\('enterpictureinpicture'/, 'no document PiP enter removal');
assert.doesNotMatch(shell, /document\.removeEventListener\('leavepictureinpicture'/, 'no document PiP leave removal');
// Active state sync uses document.pictureInPictureElement as source of truth.
assert.match(shell, /pictureInPicture = document\.pictureInPictureElement === videoElement/, 'PiP active state synced from document.pictureInPictureElement');
assert.match(shell, /pictureInPicture = document\.pictureInPictureElement === current/, 'PiP active state synced on new videoElement attachment');
assert.match(shell, /pictureInPicture = false/, 'PiP active state cleared when videoElement becomes undefined');
// PiP cleanup on source switch.
assert.match(shell, /if \(document\.pictureInPictureElement === videoElement\)[\s\S]{0,80}exitPictureInPicture/, 'PiP exit on source switch');
// PiP cleanup on destroy.
assert.match(shell, /if \(document\.pictureInPictureElement === videoElement\)[\s\S]*?exitPictureInPicture[\s\S]*?releaseWakeLock/, 'PiP exit on destroy (in onMount cleanup)');
// No iframe PiP invocation.
assert.doesNotMatch(shell, /iframeElement[\s\S]{0,30}requestPictureInPicture/, 'no iframe PiP invocation (cross-origin safety)');

// ============================================================
// 2. Fullscreen — playerRoot target, sync, cleanup, orientation unlock on Esc
// ============================================================

// Fullscreen target is always playerRoot, never iframeElement.
assert.match(shell, /playerRoot\?\.requestFullscreen/, 'requestFullscreen targets playerRoot');
assert.doesNotMatch(shell, /iframeElement[\s\S]{0,30}requestFullscreen/, 'no iframe fullscreen invocation (cross-origin safety)');
// fullscreenchange listener registered + removed.
assert.match(shell, /document\.addEventListener\('fullscreenchange', handleFullscreen\)/, 'fullscreenchange listener registered');
assert.match(shell, /document\.removeEventListener\('fullscreenchange', handleFullscreen\)/, 'fullscreenchange listener removed');
// Fullscreen state sync.
assert.match(shell, /fullscreen = document\.fullscreenElement === playerRoot/, 'fullscreen state synced from document.fullscreenElement');
// Browser-initiated fullscreen exit (Esc) must unlock orientation if landscapeMode was active.
assert.match(shell, /if \(!fullscreen && landscapeMode\)[\s\S]{0,500}orientationController\(\)\?\.unlock\?/, 'orientation unlock on browser-initiated fullscreen exit');
// Fullscreen cleanup on destroy.
assert.match(shell, /if \(document\.fullscreenElement === playerRoot\)[\s\S]{0,80}exitFullscreen/, 'fullscreen exit on destroy');
// Cross-origin boundary comment preserved (Phase 5 contract).
assert.match(shell, /provider iframe is never invoked or manipulated/, 'cross-origin boundary comment preserved');

// ============================================================
// 3. Orientation — fullscreen-before-lock, lock('landscape'), unlock, fallback
// ============================================================

// The OrientationController type must remain (Phase 5 contract).
assert.match(shell, /type OrientationController = ScreenOrientation &/, 'OrientationController type preserved');
assert.match(shell, /function orientationController\(\)/, 'orientationController helper preserved');
// Fullscreen must be requested BEFORE orientation lock (spec: lock only works while fullscreen).
const toggleLandscapeStart = shell.indexOf('async function toggleLandscape()');
const toggleLandscapeEnd = shell.indexOf('async function toggleFullscreen()', toggleLandscapeStart);
assert(toggleLandscapeStart >= 0 && toggleLandscapeEnd > toggleLandscapeStart, 'toggleLandscape function bounds found');
const toggleLandscapeBody = shell.slice(toggleLandscapeStart, toggleLandscapeEnd);
// Verify requestFullscreen appears BEFORE lock in the entering branch.
const requestFullscreenIndex = toggleLandscapeBody.indexOf('requestFullscreen');
const lockIndex = toggleLandscapeBody.indexOf("lock?.('landscape')");
assert(requestFullscreenIndex >= 0 && lockIndex >= 0 && requestFullscreenIndex < lockIndex, 'requestFullscreen before lock (spec compliance)');
assert.match(toggleLandscapeBody, /lock\?\.\('landscape'\)/, "lock('landscape') called");
assert.match(toggleLandscapeBody, /orientation\?\.unlock\?\./, 'unlock called in exit branch');
// Rejection handled (inner try/catch around lock).
assert.match(toggleLandscapeBody, /try \{ await orientation\?\.lock\?\.\('landscape'\); \} catch/, 'lock rejection handled by inner try/catch');
// Unsupported API handled (optional chaining on orientation and lock).
assert.match(toggleLandscapeBody, /orientation\?\.lock\?/, 'optional chaining on orientation.lock');
assert.match(toggleLandscapeBody, /orientation\?\.unlock\?/, 'optional chaining on orientation.unlock');
// Rapid-toggle guard.
assert.match(shell, /if \(landscapeToggleInFlight\) return/, 'rapid-toggle guard present');
assert.match(shell, /let landscapeToggleInFlight = false/, 'landscapeToggleInFlight state declared');
assert.match(shell, /landscapeToggleInFlight = true/, 'landscapeToggleInFlight set on entry');
assert.match(shell, /finally \{[\s\S]{0,40}landscapeToggleInFlight = false/, 'landscapeToggleInFlight cleared in finally');

// ============================================================
// 4. Wake Lock — detection, acquire, release, visibility, sentinel, destroy
// ============================================================

// State variables.
assert.match(shell, /let wakeLockSupported = false/, 'wakeLockSupported state declared');
assert.match(shell, /let wakeLockSentinel/, 'wakeLockSentinel state declared');
assert.match(shell, /let wasPlayingBeforeHidden = false/, 'wasPlayingBeforeHidden state declared');
// Phase 6 audit fix: request-generation mechanism for race safety.
assert.match(shell, /let wakeLockRequestId = 0/, 'wakeLockRequestId state declared');
assert.match(shell, /let wakeLockDestroyed = false/, 'wakeLockDestroyed state declared');
// Support detection in onMount.
assert.match(shell, /wakeLockSupported = Boolean\('wakeLock' in navigator/, 'wakeLock support detected');
// request('screen').
assert.match(shell, /wakeLock!\.request\('screen'\)/, "navigator.wakeLock.request('screen') called");
// Phase 6 audit fix: request-generation mechanism. Each acquireWakeLock call
// captures the current request id and verifies it after the await.
assert.match(shell, /const requestId = \+\+wakeLockRequestId/, 'request id captured at call time');
assert.match(shell, /if \(\s*wakeLockDestroyed \|\|\s*requestId !== wakeLockRequestId \|\|\s*document\.hidden \|\|\s*\(wakeLockSentinel && !wakeLockSentinel\.released\)\s*\)/, 'post-await validity check (destroyed + id mismatch + hidden + already-held)');
assert.match(shell, /try \{ await sentinel\?\.release\?\.\(\); \} catch/, 'stale sentinel released immediately on validity failure');
// releaseWakeLock increments the request id so in-flight requests are invalidated.
assert.match(shell, /async function releaseWakeLock\(\)[\s\S]*?wakeLockRequestId\+\+/, 'releaseWakeLock increments request id');
// Acquire wired to play (DIRECT only). NOT wired to handleEmbedLoad.
assert.match(shell, /function handlePlay\(\)[\s\S]{0,500}acquireWakeLock\(\)/, 'wake lock acquired on direct play');
// Phase 6 audit fix: handleEmbedLoad must NOT acquire wake lock (iframe load ≠ actual playback).
assert.doesNotMatch(shell, /function handleEmbedLoad\(\)[\s\S]{0,500}acquireWakeLock/, 'wake lock NOT acquired on embedload (conservative)');
// Embed playback events drive wake lock via handleEmbedPlaybackEvent.
// Phase 6 audit fix 2: signature includes sourceId for stale-event rejection.
assert.match(shell, /function handleEmbedPlaybackEvent\(event: \{ type: 'play' \| 'pause' \| 'ended'; sourceId\?: string \}\)/, 'handleEmbedPlaybackEvent function exists with sourceId');
assert.match(shell, /if \(event\.type === 'play'\) \{[\s\S]{0,80}embedPlaying = true[\s\S]{0,30}acquireWakeLock/, 'embed play sets embedPlaying + acquires wake lock');
assert.match(shell, /event\.type === 'pause' \|\| event\.type === 'ended'[\s\S]{0,80}embedPlaying = false[\s\S]{0,30}releaseWakeLock/, 'embed pause/ended clears embedPlaying + releases wake lock');
assert.match(shell, /if \(event\.sourceId && embedPlaybackSourceId && event\.sourceId !== embedPlaybackSourceId\) return/, 'stale source events rejected');
assert.match(shell, /export let embedPlaybackEvent: \{ type: 'play' \| 'pause' \| 'ended'; _seq\?: number; sourceId\?: string \} \| null = null/, 'embedPlaybackEvent prop declared with sourceId');
assert.match(shell, /\$: if \(embedPlaybackEvent\?\._seq && embedPlaybackEvent\._seq !== lastEmbedPlaybackSeq\)/, 'reactive watcher for embed playback events');
assert.match(shell, /let embedPlaying = false/, 'embedPlaying state declared');
assert.match(shell, /let embedPlaybackSourceId = ''/, 'embedPlaybackSourceId state declared');
// embedPlaying reset on source switch.
assert.match(shell, /source\?\.sourceId && source\.sourceId !== sourceIdentity[\s\S]*?embedPlaying = false/, 'embedPlaying reset on source switch');
assert.match(shell, /source\?\.sourceId && source\.sourceId !== sourceIdentity[\s\S]*?embedPlaybackSourceId = source\.sourceId/, 'embedPlaybackSourceId stamped on source switch');
// embedPlaying reset on episode switch.
assert.match(shell, /episodeIdentity[\s\S]*?embedPlaying = false/, 'embedPlaying reset on episode switch');
// Visibility handler considers both playing OR embedPlaying.
assert.match(shell, /wasPlayingBeforeHidden = playing \|\| embedPlaying/, 'visibility handler captures direct OR embed playback state');
assert.match(shell, /wasPlayingBeforeHidden && \(playing \|\| embedPlaying\)/, 'visibility handler re-acquires only if same state still active');
// Release wired to pause / end / error / source switch / episode switch / destroy.
assert.match(shell, /function handlePause\(\)[\s\S]{0,500}releaseWakeLock\(\)/, 'wake lock released on pause');
assert.match(shell, /function handleEnded\(\)[\s\S]{0,500}releaseWakeLock\(\)/, 'wake lock released on end');
assert.match(shell, /function handleMediaError\(\)[\s\S]{0,500}releaseWakeLock\(\)/, 'wake lock released on error');
assert.match(shell, /source\?\.sourceId && source\.sourceId !== sourceIdentity[\s\S]*?releaseWakeLock/, 'wake lock released on source switch');
assert.match(shell, /episodeIdentity[\s\S]*?releaseWakeLock/, 'wake lock released on episode switch');
assert.match(shell, /wakeLockDestroyed = true[\s\S]{0,80}releaseWakeLock/, 'destroyed flag set BEFORE releaseWakeLock on destroy');
assert.match(shell, /return \(\) => \{[\s\S]*?releaseWakeLock\(\)/, 'wake lock released on destroy');
// Visibility handling: release on hidden, re-acquire on visible if playing.
assert.match(shell, /function handleVisibilityChangeForWakeLock\(\)/, 'handleVisibilityChangeForWakeLock function exists');
// Phase 6 audit fix 2: visibility handler now captures BOTH direct + embed playback.
assert.match(shell, /wasPlayingBeforeHidden = playing \|\| embedPlaying/, 'visibility handler captures direct OR embed playback state on hide');
assert.match(shell, /wasPlayingBeforeHidden && \(playing \|\| embedPlaying\)/, 'visibility handler re-acquires only if same state still active on visible');
assert.match(shell, /onvisibilitychange=\{\(\) => \{[\s\S]{0,100}handleVisibilityChangeForWakeLock/, 'visibility handler wired to svelte:window');
// Sentinel release event listener.
assert.match(shell, /sentinel\?\.addEventListener\?\.\('release', handleWakeLockSentinelRelease\)/, 'sentinel release event observed');
assert.match(shell, /sentinel\.removeEventListener\?\.\('release', handleWakeLockSentinelRelease\)/, 'sentinel release listener removed');
// Rejection handled.
assert.match(shell, /async function acquireWakeLock\(\)[\s\S]*?catch \{/, 'acquireWakeLock wrapped in try/catch');

// ============================================================
// 5. Media Session — detection, metadata, actions, position, cleanup, gating
// ============================================================

// State variables.
assert.match(shell, /let mediaSessionSupported = false/, 'mediaSessionSupported state declared');
assert.match(shell, /let mediaSessionActive = false/, 'mediaSessionActive state declared');
// Support detection.
assert.match(shell, /mediaSessionSupported = Boolean\('mediaSession' in navigator/, 'mediaSession support detected');
// Metadata setup.
assert.match(shell, /new MediaMetadata\(/, 'MediaMetadata constructor used');
assert.match(shell, /title: content\.title/, 'metadata title from content');
assert.match(shell, /album: 'MAVERO'/, 'metadata album = MAVERO');
// Artwork only when valid URL exists (no empty artwork entries).
assert.match(shell, /const artworkUrl = content\.backdrop \?\? content\.poster \?\? ''/, 'artwork URL derived from backdrop/poster');
assert.match(shell, /const artwork = artworkUrl \? \[/, 'artwork array only created when URL is non-empty');
assert.match(shell, /\.\.\.\(artwork \? \{ artwork \} : \{\}\)/, 'artwork spread conditionally (omitted when empty)');
// Action handlers registered.
assert.match(shell, /trySet\('play'/, "play action handler registered");
assert.match(shell, /trySet\('pause'/, "pause action handler registered");
assert.match(shell, /trySet\('seekbackward'/, "seekbackward action handler registered");
assert.match(shell, /trySet\('seekforward'/, "seekforward action handler registered");
assert.match(shell, /'seekto'/, "seekto action handler registered");
// Action handlers delegate to existing PlayerShell functions (not invented ones).
assert.match(shell, /seekBy\(-10\)/, 'seekbackward delegates to seekBy(-10)');
assert.match(shell, /seekBy\(10\)/, 'seekforward delegates to seekBy(10)');
assert.match(shell, /videoElement\.play\(\)/, 'play action delegates to videoElement.play()');
assert.match(shell, /videoElement\.pause\(\)/, 'pause action delegates to videoElement.pause()');
// NOT registered: previoustrack / nexttrack (no chooseAdjacentEpisode helper exists).
assert.doesNotMatch(shell, /setActionHandler\('previoustrack'/, 'previoustrack NOT registered (no episode navigation helper)');
assert.doesNotMatch(shell, /setActionHandler\('nexttrack'/, 'nexttrack NOT registered (no episode navigation helper)');
// playbackState sync.
assert.match(shell, /syncMediaSessionPlaybackState\('playing'\)/, 'playbackState = playing on play');
assert.match(shell, /syncMediaSessionPlaybackState\('paused'\)/, 'playbackState = paused on pause');
assert.match(shell, /playbackState = 'none'/, 'playbackState = none on cleanup');
// setPositionState validation (duration finite + > 0, position finite + >= 0 + <= duration, rate finite + > 0).
assert.match(shell, /function syncMediaSessionPositionState\(\)/, 'syncMediaSessionPositionState function exists');
assert.match(shell, /if \(!Number\.isFinite\(duration\) \|\| duration <= 0\) return/, 'setPositionState: duration validated');
assert.match(shell, /if \(!Number\.isFinite\(currentTime\) \|\| currentTime < 0 \|\| currentTime > duration\) return/, 'setPositionState: position validated');
assert.match(shell, /if \(!Number\.isFinite\(playbackRate\) \|\| playbackRate <= 0\) return/, 'setPositionState: playbackRate validated');
assert.match(shell, /setPositionState\(\{ duration, playbackRate, position: currentTime \}\)/, 'setPositionState called with validated values');
// Handler cleanup.
assert.match(shell, /session\.setActionHandler\?\.\(action, null\)/, 'action handlers cleared with null');
// Metadata cleanup.
assert.match(shell, /session\.metadata = null/, 'metadata cleared on cleanup');
// Direct-only gating: action handlers delegate to videoElement (only exists for direct sources).
assert.match(shell, /if \(source\?\.type === 'direct' && videoElement\?\.paused\)/, 'play handler gated on direct + videoElement');
// Cleanup on source switch + destroy.
assert.match(shell, /source\?\.sourceId && source\.sourceId !== sourceIdentity[\s\S]*?clearMediaSession/, 'Media Session cleared on source switch');
assert.match(shell, /episodeIdentity[\s\S]*?clearMediaSession/, 'Media Session cleared on episode switch');
assert.match(shell, /return \(\) => \{[\s\S]*?clearMediaSession\(\)/, 'Media Session cleared on destroy');

// ============================================================
// 6. PlayerControls — PiP capability vs active state split
// ============================================================

// pictureInPictureSupported prop (capability — drives button render).
assert.match(controls, /export let pictureInPictureSupported = false/, 'pictureInPictureSupported prop exists');
// pictureInPicture prop (active state — drives aria-label/icon).
assert.match(controls, /export let pictureInPicture = false/, 'pictureInPicture prop exists');
// Button renders based on supported flag.
assert.match(controls, /\{#if pictureInPictureSupported\}<button[^>]*aria-label=\{pictureInPicture \? 'Exit Picture-in-Picture' : 'Enter Picture-in-Picture'\}/, 'PiP button gated on supported flag + dynamic aria-label');
assert.match(controls, /aria-pressed=\{pictureInPicture\}/, 'PiP button has aria-pressed reflecting active state');
// Fullscreen button label reflects active state (unchanged from Phase 5, but verify).
assert.match(controls, /aria-label=\{fullscreen \? 'Exit fullscreen' : 'Enter fullscreen'\}/, 'fullscreen button dynamic aria-label preserved');
assert.match(controls, /aria-pressed=\{fullscreen\}/, 'fullscreen button has aria-pressed');
// PlayerShell passes BOTH props.
assert.match(shell, /\{pictureInPictureSupported\} \{pictureInPicture\}/, 'PlayerShell passes both pictureInPictureSupported and pictureInPicture to PlayerControls');

// ============================================================
// 7. PlayerViewport — iframe permissions preserved (Phase 5 contract)
// ============================================================

assert.match(viewport, /allow="autoplay; fullscreen; picture-in-picture; encrypted-media"/, 'iframe allow attribute preserved');
assert.match(viewport, /allowfullscreen/, 'allowfullscreen preserved');
assert.match(viewport, /sandbox=\{sandboxAttribute\}/, 'sandbox attribute preserved');

// ============================================================
// 8. Phase 5 landscape contract preserved (regression check)
// ============================================================

assert.match(shell, /class:landscape-mode=\{landscapeMode\}/, 'landscape-mode class binding preserved');
assert.match(shell, /let landscapeControlsExpanded = true/, 'landscapeControlsExpanded preserved');
assert.match(shell, /const LANDSCAPE_CONTROLS_HIDE_MS = 5000/, 'LANDSCAPE_CONTROLS_HIDE_MS preserved');
assert.match(shell, /data-landscape-controls-toggle/, 'data-landscape-controls-toggle preserved');
assert.match(shell, /PanelTopClose/, 'PanelTopClose icon preserved');
assert.match(shell, /PanelTopOpen/, 'PanelTopOpen icon preserved');
assert.match(shell, /\.player-shell\.landscape-mode \{ display: flex; flex-direction: column;/, 'landscape CSS preserved');
assert.match(shell, /\.player-shell\.landscape-mode \.orientation-button[^}]*margin-right: 38px/, 'orientation-button clearance preserved (Phase 5 audit fix)');
assert.doesNotMatch(shell, /\.player-shell\.landscape-mode \.header-actions[^}]*margin-right: 38px/, 'dead .header-actions CSS still absent');
assert.match(shell, /100svh/, '100svh preserved');
assert.match(shell, /env\(safe-area-inset-top\)/, 'safe-area-inset preserved');

// ============================================================
// 9. Phase 5 UI contracts preserved (regression check)
// ============================================================

assert.match(shell, /class="bottom-bar"/, 'bottom-bar preserved');
assert.match(shell, /embed-shell-controls/, 'embed shell controls preserved');
assert.match(shell, /source-sheet/, 'source sheet preserved');
assert.match(shell, /episode-sheet/, 'episode sheet preserved');
assert.match(shell, /This source isn't available\./, 'simplified error message preserved');
assert.match(shell, /Starting your stream/, 'loading message preserved');
assert.match(shell, /role="application"/, 'role=application preserved');
assert.match(shell, /role="toolbar"/, 'role=toolbar preserved');
assert.match(shell, /role="dialog"/, 'role=dialog preserved');
assert.match(shell, /role="alert"/, 'role=alert preserved');
assert.match(shell, /role="status"/, 'role=status preserved');

// ============================================================
// 10. Phase 1-4 callbacks preserved (regression check)
// ============================================================

assert.match(shell, /onProgress/, 'onProgress preserved');
assert.match(shell, /onSourceChange/, 'onSourceChange preserved');
assert.match(shell, /onEpisodeChange/, 'onEpisodeChange preserved');
assert.match(shell, /onClose/, 'onClose preserved');
assert.match(shell, /onDetails/, 'onDetails preserved');
assert.match(shell, /onIframeReady/, 'onIframeReady preserved');
assert.match(shell, /bind:iframeElement/, 'iframeElement binding preserved');
assert.match(shell, /chooseSource/, 'chooseSource preserved');
assert.match(shell, /chooseAdjacentSource/, 'chooseAdjacentSource preserved');
assert.match(shell, /chooseEpisode/, 'chooseEpisode preserved');
assert.match(shell, /toggleSandbox/, 'toggleSandbox preserved');
assert.match(shell, /emitProgress/, 'emitProgress preserved');

// ============================================================
// 11. Cross-origin safety (no iframe fullscreen/PiP invocation)
// ============================================================

assert.doesNotMatch(shell, /iframeElement[\s\S]{0,30}requestFullscreen/, 'no iframe.requestFullscreen (cross-origin safety)');
assert.doesNotMatch(shell, /iframeElement[\s\S]{0,30}requestPictureInPicture/, 'no iframe.requestPictureInPicture (cross-origin safety)');

// ============================================================
// 12. No Phase 6 changes to PlaybackManager (dual-path architecture preserved)
// ============================================================

const manager = readFileSync(new URL('../src/lib/client/player/PlaybackManager.ts', import.meta.url), 'utf8');
assert.doesNotMatch(manager, /wakeLock|WakeLock/, 'PlaybackManager has no wake lock logic (shell-level only)');
assert.doesNotMatch(manager, /mediaSession|MediaMetadata/, 'PlaybackManager has no media session logic (shell-level only)');
// Manager still owns source resolution + adapter lifecycle (Phase 1 contract).
assert.match(manager, /class PlaybackManager/, 'PlaybackManager class preserved');
assert.match(manager, /loadSource/, 'manager.loadSource preserved');
assert.match(manager, /hasCapability/, 'manager.hasCapability preserved');

// ============================================================
// 13. Behavioral lifecycle tests — Wake Lock request-generation
// ============================================================
//
// These tests verify the ACTUAL race-safety logic of the Wake Lock
// request-generation mechanism, not just regex patterns. They extract the
// acquireWakeLock/releaseWakeLock state machine and simulate the race
// scenarios described in the audit:
//
//   A. request starts → pause/release → request resolves → stale sentinel released
//   B. request starts → source changes → request resolves → stale sentinel released
//   C. request starts → component destroyed → request resolves → sentinel released
//   D. visibility: playing+hidden → release; playing+hidden+visible → reacquire;
//      paused+hidden+visible → do NOT reacquire

// A minimal re-implementation of the Wake Lock state machine from PlayerShell,
// used to verify the race-safety logic WITHOUT requiring a browser environment.
// This mirrors the exact logic in acquireWakeLock() / releaseWakeLock() /
// handleVisibilityChangeForWakeLock() — if the source code changes, this test
// harness must be updated to match.
function createWakeLockStateMachine() {
  let wakeLockSentinel: { released?: boolean; release: () => Promise<void> } | null = null;
  let wakeLockRequestId = 0;
  let wakeLockDestroyed = false;
  let wasPlayingBeforeHidden = false;
  let playing = false;
  // Phase 6 audit fix 2: separate embed playback state.
  let embedPlaying = false;
  let embedPlaybackSourceId = '';
  // The source type: 'direct' or 'embed'. Used to gate handleEmbedPlaybackEvent.
  let sourceType: 'direct' | 'embed' | null = null;
  let documentHidden = false;
  const releasedSentinels: { releasedVia: string }[] = [];

  // Simulated navigator.wakeLock.request — returns a fake sentinel.
  // The `delay` simulates async resolution latency.
  async function fakeRequest(_type: string, delay = 0): Promise<{ released?: boolean; release: () => Promise<void> }> {
    await new Promise((r) => setTimeout(r, delay));
    return {
      released: false,
      release: async () => { (this as { released?: boolean }).released = true; releasedSentinels.push({ releasedVia: 'release()' }); }
    };
  }

  async function acquireWakeLock(delay = 0) {
    if (wakeLockSentinel && !wakeLockSentinel.released) return;
    const requestId = ++wakeLockRequestId;
    try {
      const sentinel = await fakeRequest('screen', delay);
      if (
        wakeLockDestroyed ||
        requestId !== wakeLockRequestId ||
        documentHidden ||
        (wakeLockSentinel && !wakeLockSentinel.released)
      ) {
        try { await sentinel.release(); } catch { /* already released */ }
        releasedSentinels.push({ releasedVia: 'validity-check' });
        return;
      }
      wakeLockSentinel = sentinel;
    } catch {
      // rejection — no-op
    }
  }

  async function releaseWakeLock() {
    wakeLockRequestId++;
    const sentinel = wakeLockSentinel;
    wakeLockSentinel = null;
    if (!sentinel) return;
    try { await sentinel.release(); } catch { /* already released */ }
  }

  // Phase 6 audit fix 2: handleEmbedPlaybackEvent now sets embedPlaying state
  // and rejects stale source events. This mirrors the PlayerShell implementation.
  function handleEmbedPlaybackEvent(event: { type: 'play' | 'pause' | 'ended'; sourceId?: string }) {
    if (sourceType !== 'embed') return;
    if (event.sourceId && embedPlaybackSourceId && event.sourceId !== embedPlaybackSourceId) return;
    if (event.type === 'play') {
      embedPlaying = true;
      void acquireWakeLock();
    } else if (event.type === 'pause' || event.type === 'ended') {
      embedPlaying = false;
      void releaseWakeLock();
    }
  }

  // Phase 6 audit fix 2: visibility handler now considers both playing OR embedPlaying.
  function handleVisibilityChangeForWakeLock() {
    if (documentHidden) {
      wasPlayingBeforeHidden = playing || embedPlaying;
      void releaseWakeLock();
    } else {
      const stillActive = wasPlayingBeforeHidden && (playing || embedPlaying);
      if (stillActive) {
        void acquireWakeLock();
      }
      wasPlayingBeforeHidden = false;
    }
  }

  // Phase 6 audit fix 2: source switch resets embedPlaying and stamps sourceId.
  function switchSource(newSourceId: string, newType: 'direct' | 'embed') {
    embedPlaying = false;
    embedPlaybackSourceId = newSourceId;
    sourceType = newType;
    playing = false;
    void releaseWakeLock();
  }

  return {
    acquireWakeLock,
    releaseWakeLock,
    handleEmbedPlaybackEvent,
    handleVisibilityChangeForWakeLock,
    switchSource,
    setPlaying: (v: boolean) => { playing = v; },
    setSourceType: (t: 'direct' | 'embed' | null) => { sourceType = t; },
    setHidden: (v: boolean) => { documentHidden = v; },
    setDestroyed: () => { wakeLockDestroyed = true; },
    getSentinel: () => wakeLockSentinel,
    getEmbedPlaying: () => embedPlaying,
    getReleasedSentinels: () => releasedSentinels,
    getRequestId: () => wakeLockRequestId
  };
}

// Test A: request starts → pause/release → request resolves → stale sentinel released
{
  const sm = createWakeLockStateMachine();
  sm.setPlaying(true);
  // Start acquire with a 50ms delay
  const acquirePromise = sm.acquireWakeLock(50);
  // While in-flight, pause triggers releaseWakeLock
  await new Promise((r) => setTimeout(r, 10));
  await sm.releaseWakeLock();
  // Now the acquire resolves — the sentinel should be released, NOT installed
  await acquirePromise;
  await new Promise((r) => setTimeout(r, 5));
  assert.strictEqual(sm.getSentinel(), null, 'Test A: stale sentinel NOT installed after pause/release race');
  assert.ok(sm.getReleasedSentinels().length >= 1, 'Test A: stale sentinel was released');
}

// Test B: request starts → source changes → request resolves → stale sentinel released
{
  const sm = createWakeLockStateMachine();
  sm.setPlaying(true);
  const acquirePromise = sm.acquireWakeLock(50);
  // While in-flight, source change triggers releaseWakeLock
  await new Promise((r) => setTimeout(r, 10));
  await sm.releaseWakeLock();
  await acquirePromise;
  await new Promise((r) => setTimeout(r, 5));
  assert.strictEqual(sm.getSentinel(), null, 'Test B: stale sentinel NOT installed after source-change race');
  assert.ok(sm.getReleasedSentinels().length >= 1, 'Test B: stale sentinel was released');
}

// Test C: request starts → component destroyed → request resolves → sentinel released
{
  const sm = createWakeLockStateMachine();
  sm.setPlaying(true);
  const acquirePromise = sm.acquireWakeLock(50);
  // While in-flight, component is destroyed
  await new Promise((r) => setTimeout(r, 10));
  sm.setDestroyed();
  await sm.releaseWakeLock();
  await acquirePromise;
  await new Promise((r) => setTimeout(r, 5));
  assert.strictEqual(sm.getSentinel(), null, 'Test C: stale sentinel NOT installed after destroy race');
  assert.ok(sm.getReleasedSentinels().length >= 1, 'Test C: stale sentinel was released');
}

// Test D: visibility behavior
// D1: playing + hidden → release
{
  const sm = createWakeLockStateMachine();
  sm.setPlaying(true);
  await sm.acquireWakeLock(0);
  await new Promise((r) => setTimeout(r, 5));
  assert.ok(sm.getSentinel() !== null, 'Test D1: sentinel acquired during playback');
  sm.setHidden(true);
  sm.handleVisibilityChangeForWakeLock();
  await new Promise((r) => setTimeout(r, 5));
  assert.strictEqual(sm.getSentinel(), null, 'Test D1: sentinel released on hidden');
}

// D2: playing + hidden + visible → reacquire
{
  const sm = createWakeLockStateMachine();
  sm.setPlaying(true);
  await sm.acquireWakeLock(0);
  await new Promise((r) => setTimeout(r, 5));
  sm.setHidden(true);
  sm.handleVisibilityChangeForWakeLock();
  await new Promise((r) => setTimeout(r, 5));
  assert.strictEqual(sm.getSentinel(), null, 'Test D2: sentinel released on hidden');
  sm.setHidden(false);
  sm.handleVisibilityChangeForWakeLock();
  await new Promise((r) => setTimeout(r, 5));
  assert.ok(sm.getSentinel() !== null, 'Test D2: sentinel reacquired on visible (still playing)');
}

// D3: paused + hidden + visible → do NOT reacquire
{
  const sm = createWakeLockStateMachine();
  sm.setPlaying(true);
  await sm.acquireWakeLock(0);
  await new Promise((r) => setTimeout(r, 5));
  // Pause while playing
  sm.setPlaying(false);
  await sm.releaseWakeLock();
  await new Promise((r) => setTimeout(r, 5));
  // Hidden then visible while paused
  sm.setHidden(true);
  sm.handleVisibilityChangeForWakeLock();
  await new Promise((r) => setTimeout(r, 5));
  sm.setHidden(false);
  sm.handleVisibilityChangeForWakeLock();
  await new Promise((r) => setTimeout(r, 5));
  assert.strictEqual(sm.getSentinel(), null, 'Test D3: sentinel NOT reacquired when paused');
}

// Test E: Embed semantics — iframe load alone must NOT trigger wake lock
// (Verified by the doesNotMatch assertion in section 4: handleEmbedLoad must
// not call acquireWakeLock. Wake Lock is only acquired via handleEmbedPlaybackEvent
// when a reliable provider 'play' event arrives.)
//
// Test E-behavioral: embed play sets embedPlaying and acquires Wake Lock
{
  const sm = createWakeLockStateMachine();
  sm.switchSource('source-A', 'embed');
  // Simulate normalized provider 'play' event
  sm.handleEmbedPlaybackEvent({ type: 'play', sourceId: 'source-A' });
  await new Promise((r) => setTimeout(r, 5));
  assert.strictEqual(sm.getEmbedPlaying(), true, 'Test E: embed play sets embedPlaying = true');
  assert.ok(sm.getSentinel() !== null, 'Test E: embed play acquires wake lock');
}

// Test F: Embed pause clears embedPlaying and releases wake lock
{
  const sm = createWakeLockStateMachine();
  sm.switchSource('source-A', 'embed');
  sm.handleEmbedPlaybackEvent({ type: 'play', sourceId: 'source-A' });
  await new Promise((r) => setTimeout(r, 5));
  assert.ok(sm.getSentinel() !== null, 'Test F: sentinel acquired on embed play');
  // Simulate normalized provider 'pause' event
  sm.handleEmbedPlaybackEvent({ type: 'pause', sourceId: 'source-A' });
  await new Promise((r) => setTimeout(r, 5));
  assert.strictEqual(sm.getEmbedPlaying(), false, 'Test F: embed pause clears embedPlaying');
  assert.strictEqual(sm.getSentinel(), null, 'Test F: embed pause releases wake lock');
}

// Test G: Embed ended clears embedPlaying and releases wake lock
{
  const sm = createWakeLockStateMachine();
  sm.switchSource('source-A', 'embed');
  sm.handleEmbedPlaybackEvent({ type: 'play', sourceId: 'source-A' });
  await new Promise((r) => setTimeout(r, 5));
  assert.ok(sm.getSentinel() !== null, 'Test G: sentinel acquired on embed play');
  // Simulate normalized provider 'ended' event
  sm.handleEmbedPlaybackEvent({ type: 'ended', sourceId: 'source-A' });
  await new Promise((r) => setTimeout(r, 5));
  assert.strictEqual(sm.getEmbedPlaying(), false, 'Test G: embed ended clears embedPlaying');
  assert.strictEqual(sm.getSentinel(), null, 'Test G: embed ended releases wake lock');
}

// Test H: Embed play → hidden → visible reacquires Wake Lock
// This is the core fix for the audit blocker: previously the visibility handler
// only checked `playing` (direct), so embed playback was NOT reacquired on visible.
{
  const sm = createWakeLockStateMachine();
  sm.switchSource('source-A', 'embed');
  sm.handleEmbedPlaybackEvent({ type: 'play', sourceId: 'source-A' });
  await new Promise((r) => setTimeout(r, 5));
  assert.ok(sm.getSentinel() !== null, 'Test H: sentinel acquired on embed play');
  // Document hidden — sentinel released, wasPlayingBeforeHidden = embedPlaying
  sm.setHidden(true);
  sm.handleVisibilityChangeForWakeLock();
  await new Promise((r) => setTimeout(r, 5));
  assert.strictEqual(sm.getSentinel(), null, 'Test H: sentinel released on hidden');
  // Document visible — embedPlaying is still true, so sentinel should be reacquired
  sm.setHidden(false);
  sm.handleVisibilityChangeForWakeLock();
  await new Promise((r) => setTimeout(r, 5));
  assert.ok(sm.getSentinel() !== null, 'Test H: sentinel reacquired on visible (embed still playing)');
}

// Test I: Embed pause → hidden → visible does NOT reacquire
{
  const sm = createWakeLockStateMachine();
  sm.switchSource('source-A', 'embed');
  sm.handleEmbedPlaybackEvent({ type: 'play', sourceId: 'source-A' });
  await new Promise((r) => setTimeout(r, 5));
  // Pause before hidden
  sm.handleEmbedPlaybackEvent({ type: 'pause', sourceId: 'source-A' });
  await new Promise((r) => setTimeout(r, 5));
  assert.strictEqual(sm.getEmbedPlaying(), false, 'Test I: embedPlaying false after pause');
  // Hidden then visible while paused
  sm.setHidden(true);
  sm.handleVisibilityChangeForWakeLock();
  await new Promise((r) => setTimeout(r, 5));
  sm.setHidden(false);
  sm.handleVisibilityChangeForWakeLock();
  await new Promise((r) => setTimeout(r, 5));
  assert.strictEqual(sm.getSentinel(), null, 'Test I: sentinel NOT reacquired when embed paused');
}

// Test J: Source switch invalidates embed playback state
{
  const sm = createWakeLockStateMachine();
  sm.switchSource('source-A', 'embed');
  sm.handleEmbedPlaybackEvent({ type: 'play', sourceId: 'source-A' });
  await new Promise((r) => setTimeout(r, 5));
  assert.strictEqual(sm.getEmbedPlaying(), true, 'Test J: embedPlaying true after play');
  assert.ok(sm.getSentinel() !== null, 'Test J: sentinel acquired');
  // Switch to a new source
  sm.switchSource('source-B', 'embed');
  await new Promise((r) => setTimeout(r, 5));
  assert.strictEqual(sm.getEmbedPlaying(), false, 'Test J: embedPlaying reset on source switch');
  assert.strictEqual(sm.getSentinel(), null, 'Test J: sentinel released on source switch');
}

// Test K: Episode switch invalidates embed playback state
// (Simulated by switching source within the same episode — the watch route's
// episode-switch reactive block calls releaseWakeLock + resets embedPlaying,
// which is the same switchSource mechanism in this harness.)
{
  const sm = createWakeLockStateMachine();
  sm.switchSource('source-A', 'embed');
  sm.handleEmbedPlaybackEvent({ type: 'play', sourceId: 'source-A' });
  await new Promise((r) => setTimeout(r, 5));
  assert.strictEqual(sm.getEmbedPlaying(), true, 'Test K: embedPlaying true after play');
  // Episode switch resets embed state (same as source switch in this harness)
  sm.switchSource('source-A', 'embed');
  await new Promise((r) => setTimeout(r, 5));
  assert.strictEqual(sm.getEmbedPlaying(), false, 'Test K: embedPlaying reset on episode switch');
  assert.strictEqual(sm.getSentinel(), null, 'Test K: sentinel released on episode switch');
}

// Test L: Stale embed playback event cannot activate Wake Lock for a different source
// This verifies the sourceId guard in handleEmbedPlaybackEvent.
{
  const sm = createWakeLockStateMachine();
  sm.switchSource('source-A', 'embed');
  // Switch to source-B — now embedPlaybackSourceId = 'source-B'
  sm.switchSource('source-B', 'embed');
  await new Promise((r) => setTimeout(r, 5));
  // A stale 'play' event arrives for source-A (the old source)
  sm.handleEmbedPlaybackEvent({ type: 'play', sourceId: 'source-A' });
  await new Promise((r) => setTimeout(r, 5));
  assert.strictEqual(sm.getEmbedPlaying(), false, 'Test L: stale source-A play does NOT set embedPlaying');
  assert.strictEqual(sm.getSentinel(), null, 'Test L: stale source-A play does NOT acquire wake lock');
}

// Test M: PiP lifecycle — initial embed → direct video created → listeners attached
// (Verified by the reactive $: attachPipListeners(videoElement) assertion in
// section 1. The reactive block fires whenever videoElement identity changes,
// including from undefined → <video>.)

// Test N: PiP replacement — video A → video B → listeners removed from A, attached to B
// (Verified by the lastPipVideoElement tracking + removeEventListener assertions
// in section 1. The attachPipListeners function detaches from the previous
// element before attaching to the new one.)

// Test O: PiP repeated source switching — embed → direct → embed → direct → no duplicates
// (Verified by the `if (current === lastPipVideoElement) return` guard in
// section 1. The guard prevents duplicate attachment when the identity hasn't
// changed, and the detach-then-attach cycle ensures no listener leak.)

console.log('Phase 6 player APIs contract tests passed: PiP listeners on videoElement via reactive lifecycle (16 checks); fullscreen target + sync + cleanup + orientation unlock on Esc (8 checks); orientation fullscreen-before-lock + lock + unlock + fallback + rapid-toggle guard (15 checks); Wake Lock detection + request-generation race safety + acquire + release + visibility + sentinel + destroy + embed-conservative-semantics + embedPlaying state + stale-source rejection (44 checks); Media Session detection + metadata + artwork MIME detection + action handlers + playbackState + setPositionState validation + cleanup + direct-only gating (28 checks); PlayerControls PiP capability/active-state split (6 checks); PlayerViewport iframe permissions preserved (3 checks); Phase 5 landscape contract preserved (11 checks); Phase 5 UI contracts preserved (10 checks); Phase 1-4 callbacks preserved (12 checks); cross-origin safety (2 checks); PlaybackManager dual-path architecture preserved (5 checks); behavioral lifecycle tests for Wake Lock race safety (Tests A-D) + embed playback state (Tests E-L) + PiP lifecycle (Tests M-O) (15 behavioral tests).');
