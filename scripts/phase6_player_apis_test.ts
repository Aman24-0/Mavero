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
// Phase 6 must attach to videoElement.
assert.match(shell, /videoElement\.addEventListener\('enterpictureinpicture'/, 'PiP enter listener attached to videoElement');
assert.match(shell, /videoElement\.addEventListener\('leavepictureinpicture'/, 'PiP leave listener attached to videoElement');
assert.match(shell, /videoElement\.removeEventListener\('enterpictureinpicture'/, 'PiP enter listener removed from videoElement');
assert.match(shell, /videoElement\.removeEventListener\('leavepictureinpicture'/, 'PiP leave listener removed from videoElement');
// The dead document listeners must be ABSENT.
assert.doesNotMatch(shell, /document\.addEventListener\('enterpictureinpicture'/, 'no document PiP enter listener (dead code removed)');
assert.doesNotMatch(shell, /document\.addEventListener\('leavepictureinpicture'/, 'no document PiP leave listener (dead code removed)');
assert.doesNotMatch(shell, /document\.removeEventListener\('enterpictureinpicture'/, 'no document PiP enter removal');
assert.doesNotMatch(shell, /document\.removeEventListener\('leavepictureinpicture'/, 'no document PiP leave removal');
// Active state sync uses document.pictureInPictureElement as source of truth.
assert.match(shell, /pictureInPicture = document\.pictureInPictureElement === videoElement/, 'PiP active state synced from document.pictureInPictureElement');
// PiP cleanup on source switch.
assert.match(shell, /if \(document\.pictureInPictureElement === videoElement\)[\s\S]{0,80}exitPictureInPicture/, 'PiP exit on source switch');
// PiP cleanup on destroy.
assert.match(shell, /if \(document\.pictureInPictureElement === videoElement\)[\s\S]{0,120}exitPictureInPicture[\s\S]{0,200}releaseWakeLock/, 'PiP exit on destroy (in onMount cleanup)');
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
// Support detection in onMount.
assert.match(shell, /wakeLockSupported = Boolean\('wakeLock' in navigator/, 'wakeLock support detected');
// request('screen').
assert.match(shell, /wakeLock!\.request\('screen'\)/, "navigator.wakeLock.request('screen') called");
// Acquire wired to play (direct) + embedload (embed).
assert.match(shell, /function handlePlay\(\)[\s\S]{0,500}acquireWakeLock\(\)/, 'wake lock acquired on play');
assert.match(shell, /function handleEmbedLoad\(\)[\s\S]{0,800}acquireWakeLock\(\)/, 'wake lock acquired on embedload');
// Release wired to pause / end / error / source switch / episode switch / destroy.
assert.match(shell, /function handlePause\(\)[\s\S]{0,500}releaseWakeLock\(\)/, 'wake lock released on pause');
assert.match(shell, /function handleEnded\(\)[\s\S]{0,500}releaseWakeLock\(\)/, 'wake lock released on end');
assert.match(shell, /function handleMediaError\(\)[\s\S]{0,500}releaseWakeLock\(\)/, 'wake lock released on error');
assert.match(shell, /source\?\.sourceId && source\.sourceId !== sourceIdentity[\s\S]*?releaseWakeLock/, 'wake lock released on source switch');
assert.match(shell, /episodeIdentity[\s\S]*?releaseWakeLock/, 'wake lock released on episode switch');
assert.match(shell, /return \(\) => \{[\s\S]*?releaseWakeLock\(\)/, 'wake lock released on destroy');
// Visibility handling: release on hidden, re-acquire on visible if playing.
assert.match(shell, /function handleVisibilityChangeForWakeLock\(\)/, 'handleVisibilityChangeForWakeLock function exists');
assert.match(shell, /if \(document\.hidden\)[\s\S]{0,200}wasPlayingBeforeHidden = playing/, 'captured playing state on hide');
assert.match(shell, /if \(wasPlayingBeforeHidden && playing\)[\s\S]{0,100}acquireWakeLock/, 're-acquire on visible if still playing');
assert.match(shell, /onvisibilitychange=\{\(\) => \{[\s\S]{0,100}handleVisibilityChangeForWakeLock/, 'visibility handler wired to svelte:window');
// Sentinel release event listener.
assert.match(shell, /sentinel\?\.addEventListener\?\.\('release', handleWakeLockSentinelRelease\)/, 'sentinel release event observed');
assert.match(shell, /sentinel\.removeEventListener\?\.\('release', handleWakeLockSentinelRelease\)/, 'sentinel release listener removed');
// Race safety: if request resolves after destroy, release immediately.
assert.match(shell, /if \(!playerRoot\) \{[\s\S]{0,80}sentinel\?\.release/, 'race guard: release sentinel if destroyed during request');
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

console.log('Phase 6 player APIs contract tests passed: PiP listeners on videoElement (10 checks); fullscreen target + sync + cleanup + orientation unlock on Esc (8 checks); orientation fullscreen-before-lock + lock + unlock + fallback + rapid-toggle guard (15 checks); Wake Lock detection + acquire + release + visibility + sentinel + destroy + race safety (18 checks); Media Session detection + metadata + artwork validation + action handlers + playbackState + setPositionState validation + cleanup + direct-only gating (28 checks); PlayerControls PiP capability/active-state split (6 checks); PlayerViewport iframe permissions preserved (3 checks); Phase 5 landscape contract preserved (11 checks); Phase 5 UI contracts preserved (10 checks); Phase 1-4 callbacks preserved (12 checks); cross-origin safety (2 checks); PlaybackManager dual-path architecture preserved (5 checks).');
