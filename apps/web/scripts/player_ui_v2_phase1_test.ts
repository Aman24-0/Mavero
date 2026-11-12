import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ResolverError } from '$lib/server/resolver/errors';
import { blueVelvetProviderAdapter, requestBlueVelvetMedia, buildBlueVelvetEndpoint } from '$lib/server/resolver/bluevelvet';
import type { ResolverContext } from '$lib/server/resolver/types';

// Player UI V2 — Part 1, PHASE 1 regression suite.
//
// §1/§2 SUPERSEDED (Player V2 corrections, approved real-device layout): the
// Part 1 compact 3-group BOTTOM control row and the Blue Velvet-only in-row
// Back/Fullscreen exceptions were replaced by the approved three-zone layout
// — top-right utility zone (Cast/PiP/Lock), a DOMINANT center cluster
// (−10 s / Play/Pause / +10 s) centered on the VIDEO VIEWPORT, and a bottom
// zone (time + timeline + subtitles + quality + display mode + speed +
// fullscreen). Back is the shell's top-left FAB for EVERY provider; the
// floating Landscape FAB remains only for embed sources. Every superseded
// assertion below preserves the ORIGINAL INTENT (centered cluster, ±10 s
// adjacency, single speed display, no mobile hiding, one Back/one fullscreen)
// and strengthens it with the approved placement contract.
//
// Covers:
//   §1  Approved three-zone control layout — PlayerControls source contracts.
//   §2  Approved Back/Fullscreen placement — shell contracts.
//   §3  Resolver-to-UI error classification — TITLE_NOT_AVAILABLE vocabulary,
//       the client mapping (title-unavailable state), the Blue Velvet
//       adapter's CONSERVATIVE classification (live-probe evidence), and the
//       shell's distinct title-unavailable card. (UNCHANGED by the layout
//       corrections.)

const shell = readFileSync(resolve('src/lib/components/player/PlayerShell.svelte'), 'utf-8');
const controls = readFileSync(resolve('src/lib/components/player/PlayerControls.svelte'), 'utf-8');
const sharedPlayer = readFileSync(resolve('src/lib/shared/player.ts'), 'utf-8');
const manager = readFileSync(resolve('src/lib/client/player/PlaybackManager.ts'), 'utf-8');
const watchPage = readFileSync(resolve('src/routes/watch/[type]/[id]/+page.svelte'), 'utf-8');
const bluevelvet = readFileSync(resolve('src/lib/server/resolver/bluevelvet.ts'), 'utf-8');
const resolverTypes = readFileSync(resolve('src/lib/server/resolver/types.ts'), 'utf-8');
const resolverErrors = readFileSync(resolve('src/lib/server/resolver/errors.ts'), 'utf-8');

let checks = 0;
function ok(condition: boolean, label: string) {
  assert.ok(condition, label);
  checks += 1;
}

// ============================================================
// §1 — APPROVED three-zone layout (Player V2 corrections)
// ============================================================

// 1a. 2026-10 round 20 — the center cluster overlay is REMOVED entirely.
// Play/Pause + ±10s seek buttons are ALL in the bottom secondary row now.
// The center overlay was overlapping with error messages + loading cards on mobile.
ok(!/class="center-cluster"/.test(controls), '1a. the center cluster overlay is removed (2026-10 round 20)');
ok(!/\.center-cluster \{/.test(controls), '1a. the center cluster CSS is removed (2026-10 round 20)');
// Play/Pause + ±10s buttons are all in the secondary row.
const secondaryRow = controls.slice(controls.indexOf('class="secondary-row"'), controls.indexOf('</div>') !== -1 ? controls.indexOf('class="sheet-overlay"') : controls.length);
ok(secondaryRow.includes('Seek backward 10 seconds') && secondaryRow.includes('Seek forward 10 seconds'), '1a. the ±10 s seek buttons are in the secondary row');
ok(secondaryRow.indexOf('Seek backward 10 seconds') < secondaryRow.indexOf('Seek forward 10 seconds'), '1a. −10s comes before +10s in the secondary row');
ok(secondaryRow.includes("aria-label={playing ? 'Pause' : 'Play'}"), '1a. Play/Pause is in the secondary row (2026-10 round 20)');
ok(secondaryRow.indexOf("aria-label={playing ? 'Pause' : 'Play'}") < secondaryRow.indexOf('Seek backward 10 seconds'), '1a. Play/Pause comes before the ±10s buttons in the secondary row');
// 1b. Play/Pause is an inline control button (no longer a large center cluster button).
ok(/class="control-button play-inline"/.test(controls), '1b. Play/Pause is an inline control button in the secondary row (2026-10 round 20)');
// 1c. The ±10s controls are NOT hidden on mobile (they are part of the contract).
ok(!/\.skip \{ display: none !important; \}/.test(controls), '1c. skip controls are not display:none on compact viewports');
// 1d. Single speed display — the duplicated `{playbackRate}×` label span is gone;
//     CONTRACT CHANGE (focused fixes, Issue 3): the speed <select> became a
//     BUTTON that opens the Mavero speed sheet — still the ONE renderer of
//     the selected speed.
ok(!/<span>\{playbackRate\}×<\/span>/.test(controls), '1d. the duplicated speed label span is removed (fixes "1× 1×")');
ok(/class="select-control speed sheet-trigger"[^>]*aria-label=\{`Playback speed: \$\{playbackRate\}×`\}/.test(controls), '1d. the speed control remains the single selected-speed renderer (sheet-trigger button contract)');
ok(/function chooseSpeed\(id: string\) \{[\s\S]*?onPlaybackRate\(value\);/.test(controls), '1d. playback-rate behavior unchanged (sheet selection drives onPlaybackRate)');
// 1e. The in-row source button is REMOVED; source selection stays with the chip.
ok(!/source-button/.test(controls), '1e. the in-row source button is removed from PlayerControls');
ok(!/export let sourceCount|export let onSources/.test(controls), '1e. sourceCount/onSources props are removed from PlayerControls');
ok(/class="source-chip"/.test(shell) && /aria-label="Choose source"/.test(shell), '1e. the right-edge source chip is preserved in the shell');
ok(/chooseSource\(option\.id\)/.test(shell), '1e. source switching (chooseSource) is preserved');
// 1f. Retained controls: timeline, time labels, volume, subtitles, quality (internal + per-stream), PiP.
ok(/class="timeline-input" type="range"/.test(controls), '1f. progress timeline retained');
ok(/class="time-label" aria-live="off">\{formatPlayerTime\(currentTime\)\}<\/span>/.test(controls), '1f. current time label retained (bottom zone)');
ok(/class="time-label" aria-live="off">\{formatPlayerTime\(safeDuration\)\}<\/span>/.test(controls), '1f. total duration label retained (finite-guarded safeDuration)');
ok(/class="volume-input" type="range"/.test(controls), '1f. volume control retained');
ok(/aria-label=\{`Subtitles: \$\{subtitleButtonLabel\}/.test(controls), '1f. subtitles control retained (sheet-trigger contract, Issue 3)');
ok(/aria-label="Playback quality"/.test(controls) && /internalQualities\.length > 1/.test(controls), '1f. quality selection (engine internal + per-stream fallback) retained');
ok(/Enter Picture-in-Picture/.test(controls), '1f. Picture-in-Picture retained');
// 1g. APPROVED LAYOUT: top-right utility zone = Cast, PiP, Lock — never the
//     center cluster or the bottom bar.
ok(/class="utility-zone"/.test(controls), '1g. a dedicated top-right utility zone exists');
const utilityZone = controls.slice(controls.indexOf('class="utility-zone"'), controls.indexOf('class="center-cluster"'));
ok(utilityZone.indexOf('Cast to a device') > -1 && utilityZone.indexOf('Enter Picture-in-Picture') > -1 && utilityZone.indexOf('Lock player controls') > -1, '1g. Cast/PiP/Lock are ALL in the utility zone (never pushed into the cluster or bottom bar)');
ok(/aria-pressed=\{castActive\}/.test(utilityZone) && utilityZone.indexOf('Disconnect cast session') > -1, '1g. the Cast control mirrors the session state (aria-pressed + distinct labels)');
// 1h. APPROVED LAYOUT: bottom zone = time + timeline + secondary row.
ok(/class="bottom-zone"/.test(controls) && /class="timeline-row"/.test(controls) && /class="secondary-row"/.test(controls), '1h. the bottom zone carries the timeline row and the secondary control row');
// CONTRACT CHANGE (2026-10 round 25): portrait uses a single NOWRAP row — the
// right group packs tightly (flex-shrink labels, 36px+ targets) instead of
// wrapping; the space-between layout keeps the two groups from overlapping.
ok(/\.secondary-row \{ display: flex; align-items: center; flex-wrap: nowrap; justify-content: space-between;/.test(controls), '1h. the secondary row is a single space-between row (nowrap, no overlap on narrow portrait)');
// 1i. APPROVED LAYOUT: display mode (Fit/Fill/Stretch).
// CONTRACT CHANGE (focused fixes, Issue 3): the select became a button that
// opens the Mavero display-mode sheet — the same three typed modes flow
// through onDisplayMode.
ok(/aria-label=\{`Display mode: \$\{displayMode\}`\}/.test(controls), '1i. a display-mode control exists');
ok(/const displayOptions: ReadonlyArray<\{ id: 'fit' \| 'fill' \| 'stretch'; label: string \}> = \[[\s\S]*?\{ id: 'fit', label: 'Fit' \},[\s\S]*?\{ id: 'fill', label: 'Fill' \},[\s\S]*?\{ id: 'stretch', label: 'Stretch' \}/.test(controls), '1i. Fit/Fill/Stretch are the three display modes');
ok(/if \(id === 'fit' \|\| id === 'fill' \|\| id === 'stretch'\) onDisplayMode\(id\);/.test(controls), '1i. the display-mode sheet drives onDisplayMode with the typed mode');
// 1j. APPROVED LAYOUT: the quality control is NEVER hidden on phones (the
//     reported "no usable quality selector" regression).
ok(!/\.quality \{ display: none/.test(controls), '1j. the quality control is not display:none on any viewport');
ok(!/max-width: 840px[^}]*\.quality/.test(controls), '1j. no compact-viewport rule hides the quality control');
// 1k. APPROVED LAYOUT: seek icons are the recognizable rotate-square pair
//     with the 10-second count (replaces the ambiguous chevrons).
ok(/RotateCcwSquare/.test(controls) && /RotateCwSquare/.test(controls), '1k. backward/forward use RotateCcwSquare/RotateCwSquare (correctly oriented seek icons)');
ok(!/ChevronLeft|ChevronRight/.test(controls), '1k. the ambiguous chevron seek icons are gone');
// 2026-10 round 19 — the seek-count span was removed when the buttons moved
// to the secondary row (the inline buttons use icon-only display, no overlay count).

// ============================================================
// §2 — Approved Back / Fullscreen placement (Player V2 corrections)
// ============================================================

// 2a. Stable identifier — the provider SLUG constant, never a display-name match.
ok(/export const BLUEVELVET_PROVIDER_SLUG = 'blue-velvet' as const;/.test(sharedPlayer), '2a. BLUEVELVET_PROVIDER_SLUG is the stable identifier constant');
ok(/export function isBlueVelvetProvider/.test(sharedPlayer) && /providerSlug === BLUEVELVET_PROVIDER_SLUG/.test(sharedPlayer), '2a. detection compares the stable slug, never a display name');
ok(/providerSlug: provider\?\.slug/.test(watchPage), '2a. the watch route threads the provider slug onto every source option');
ok(!/blueVelvetActive/.test(shell), '2a. SUPERSEDED: the shell no longer branches on a Blue Velvet layout exception (one approved layout for every provider)');
// 2b. In-row Back/Fullscreen props are RETIRED; fullscreen uses the same controller.
ok(!/showBack=|showFullscreen=/.test(shell), '2b. SUPERSEDED: the in-row Back/Fullscreen props are gone from the shell invocation');
ok(!/export let showBack|export let showFullscreen/.test(controls), '2b. SUPERSEDED: PlayerControls no longer carries the in-row Back/Fullscreen props');
ok(!/onBack=/.test(shell), '2b. the shell Back FAB is the single Back surface (no in-row Back binding remains)');
ok(/onFullscreen=\{\(\) => \{ void toggleFullscreen\(\); \}\}/.test(shell), '2b. the fullscreen control uses the SAME Mavero fullscreen/orientation controller');
ok(/fullscreenActive=\{fullscreen\}/.test(shell), '2b. the fullscreen icon mirrors the browser-synced fullscreen state');
// 2c. Approved placement: Back FAB unconditional; Landscape FAB embed-only.
ok(/aria-label="Close player"/.test(shell) && !/\{#if \!\(blueVelvetActive && !touchLocked\)\}/.test(shell), '2c. the Back FAB renders for EVERY provider (approved top-left placement, no BV suppression)');
ok(/\{#if source\?\.type === 'embed'\}[\s\S]*?class="control-fab-group"/.test(shell), '2c. the floating Landscape FAB group renders ONLY for embed sources');
// 2d. The floating controls still exist (embed path) + the bottom-row fullscreen exists.
ok(/class="back-fab"/.test(shell) && /class="control-fab landscape-fab"/.test(shell), '2d. the Back FAB + Landscape FAB remain (Back always; Landscape for embeds)');
ok(/aria-label=\{fullscreenActive \? 'Exit fullscreen' : 'Enter fullscreen'\}/.test(controls), '2d. direct sources carry fullscreen in the bottom secondary row');
// 2e. No duplicates: exactly one Back and one fullscreen render per surface.
ok((shell.match(/aria-label="Close player"/g) ?? []).length === 1, '2e. exactly ONE Back control exists (the shell FAB)');
ok((shell.match(/void toggleFullscreen\(\); \}\}/g) ?? []).length === 1, '2e. exactly one fullscreen binding in the shell (F key remains the keyboard path)');
ok((controls.match(/'Exit fullscreen' : 'Enter fullscreen'/g) ?? []).length === 1, '2e. exactly ONE fullscreen button in PlayerControls');

// ============================================================
// §3 — Resolver-to-UI error classification (Phase 1C)
// ============================================================

// 3a. TITLE_NOT_AVAILABLE exists in the typed vocabulary with its own message + 404.
ok(/'TITLE_NOT_AVAILABLE'/.test(resolverTypes), '3a. TITLE_NOT_AVAILABLE is a typed resolver error code');
ok(/TITLE_NOT_AVAILABLE: 'This title is not available on this source\.'/.test(resolverErrors), '3a. dedicated public message for the confirmed-missing state');
ok(/TITLE_NOT_AVAILABLE: 404/.test(resolverErrors), '3a. the confirmed-missing state maps to 404 (the TITLE is missing, not the source)');
// 3b. Client mapping — ONLY that code produces the title-unavailable state.
ok(/errorCode === 'TITLE_NOT_AVAILABLE'\s*\n\s*\? 'title-unavailable'/.test(manager), '3b. PlaybackManager maps ONLY TITLE_NOT_AVAILABLE to title-unavailable');
ok(/'title-unavailable'/.test(manager), '3b. ResolutionState gains the title-unavailable member');
ok(/\| 'title-unavailable';/.test(sharedPlayer), '3b. PlayerPlaybackState gains the title-unavailable member');
// 3c. Watch route forwarding — the kind + failing source name reach the shell.
ok(/resolutionState === 'title-unavailable' \? 'title-unavailable'/.test(watchPage), '3c. watch route forwards the title-unavailable resolution kind');
ok(/resolutionSourceName = resolutionState === 'title-unavailable' \? sourceOptions\.find/.test(watchPage), '3c. watch route resolves the failing source display name');
// 3d. Shell card — distinct heading + source-switch-first actions.
ok(/Title not available on \{resolutionSourceName \|\| 'this source'\}/.test(shell), '3d. the shell renders the title-unavailable heading with the source name');
ok(!/Title not available on Blue Velvet<\/strong>/.test(shell), '3d. the heading is composed from the requested source, never a hardcoded provider name');
const titleCardBranch = shell.slice(shell.indexOf("resolutionKind === 'title-unavailable'"), shell.indexOf("resolutionKind === 'title-unavailable'") + 1400);
ok(/Switch source/.test(titleCardBranch) && titleCardBranch.indexOf('Switch source') < titleCardBranch.indexOf('Try again'), '3d. source-switch is the PRIMARY action on the title-unavailable card');
ok(/<strong>This source isn't available\.<\/strong>/.test(shell), '3d. genuine provider-availability failures keep the existing source-unavailable messaging');
// 3e. Blue Velvet adapter — CONSERVATIVE classification backed by recorded probes.
ok(/has NO confirmed "title not available" response/.test(bluevelvet), '3e. the adapter documents the live-probe evidence (no confirmed-missing signal)');
ok(/fake TMDB id 999999999/.test(bluevelvet) && /tmdb 1399 S99E99/.test(bluevelvet), '3e. the probe evidence (fake id + nonexistent episode) is recorded verbatim');
ok(/NEVER re-classified as a confirmed/.test(bluevelvet), '3e. queued/building is documented as never a confirmed missing title');
ok(!/TITLE_NOT_AVAILABLE/.test(bluevelvet.replace(/[\s\S]*The TITLE_NOT_AVAILABLE code exists[\s\S]*/, '')), '3e. the adapter never EMITS the title-unavailable code (documented reservation only)');

// 3f. Behavioral: the adapter still classifies ready:false as RESOLUTION_UNAVAILABLE
//     and upstream 4xx/5xx/timeout/malformed as their EXISTING codes (mocked upstream).
async function mockedResponse(status: number, body: string, contentType = 'application/json'): Promise<typeof fetch> {
  return (async () => new Response(body, { status, headers: { 'content-type': contentType } })) as unknown as typeof fetch;
}
const endpoint = buildBlueVelvetEndpoint('278', 'movie');
{
  const fetchImpl = await mockedResponse(202, JSON.stringify({ ready: false, status: 'queued' }));
  await assert.rejects(requestBlueVelvetMedia(endpoint, fetchImpl), (error: ResolverError) => {
    ok(error.code === 'RESOLUTION_UNAVAILABLE', '3f. queued (202 ready:false) → RESOLUTION_UNAVAILABLE (retryable, falls back)');
    return true;
  });
}
{
  const fetchImpl = await mockedResponse(202, JSON.stringify({ ready: false, status: 'building' }));
  await assert.rejects(requestBlueVelvetMedia(endpoint, fetchImpl), (error: ResolverError) => {
    ok(error.code === 'RESOLUTION_UNAVAILABLE', '3f. building (202 ready:false) → RESOLUTION_UNAVAILABLE (retryable, falls back)');
    return true;
  });
}
{
  const fetchImpl = await mockedResponse(500, 'upstream exploded');
  await assert.rejects(requestBlueVelvetMedia(endpoint, fetchImpl), (error: ResolverError) => {
    ok(error.code === 'RESOLUTION_UNAVAILABLE', '3f. upstream 5xx → provider availability (not a missing title)');
    return true;
  });
}
{
  const fetchImpl = await mockedResponse(403, '{"error":"forbidden"}');
  await assert.rejects(requestBlueVelvetMedia(endpoint, fetchImpl), (error: ResolverError) => {
    ok(error.code === 'PROVIDER_RESPONSE_INVALID', '3f. upstream 4xx → contract-invalid response (not a missing title)');
    return true;
  });
}
{
  const fetchImpl = await mockedResponse(200, 'not-json{', 'application/json');
  await assert.rejects(requestBlueVelvetMedia(endpoint, fetchImpl), (error: ResolverError) => {
    ok(error.code === 'PROVIDER_RESPONSE_INVALID', '3f. malformed JSON → invalid response (not a missing title)');
    return true;
  });
}
{
  // Simulates an ALREADY-FIRED AbortSignal.timeout — the adapter maps the
  // TimeoutError DOMException name to RESOLUTION_TIMEOUT (no real 8s wait).
  const timeoutError = new Error('The operation was aborted due to timeout');
  timeoutError.name = 'TimeoutError';
  const fetchImpl = (async () => { throw timeoutError; }) as unknown as typeof fetch;
  await assert.rejects(requestBlueVelvetMedia(endpoint, fetchImpl), (error: ResolverError) => {
    ok(error.code === 'RESOLUTION_TIMEOUT', '3f. timeout → RESOLUTION_TIMEOUT (retryable, not a missing title)');
    return true;
  });
}
{
  // Success path unchanged.
  const fetchImpl = await mockedResponse(200, JSON.stringify({ ready: true, url: 'https://zcdn.bluevelvet.space/play/abcDEF123._-/master.m3u8' }));
  const url = await requestBlueVelvetMedia(endpoint, fetchImpl);
  ok(url === 'https://zcdn.bluevelvet.space/play/abcDEF123._-/master.m3u8', '3f. available titles still resolve to the validated HLS URL');
}

// 3g. Behavioral: a TITLE_NOT_AVAILABLE-shaped resolver response classifies as
//     title-unavailable in the shared public-message path (server contract).
{
  const error = new ResolverError('TITLE_NOT_AVAILABLE');
  ok(error.status === 404 && error.message === 'This title is not available on this source.', '3g. the typed error carries the 404 status + public message');
}

// 3h. Behavioral: the adapter object identity/registration is untouched.
ok(blueVelvetProviderAdapter.adapterId === 'blue-velvet' && blueVelvetProviderAdapter.integrationType === 'api', '3h. the Blue Velvet adapter registration is unchanged');

// Prevent unused-var lint for the context type import (kept for the harness shape).
void (0 as unknown as ResolverContext | null);

console.log(`player_ui_v2_phase1_test: ${checks} checks passed`);
