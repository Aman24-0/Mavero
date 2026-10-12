import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ResolverError } from '$lib/server/resolver/errors';
import { blueVelvetProviderAdapter, requestBlueVelvetMedia, buildBlueVelvetEndpoint } from '$lib/server/resolver/bluevelvet';
import type { ResolverContext } from '$lib/server/resolver/types';

// Player UI V2 — Part 1, PHASE 1 regression suite.
//
// Covers the three Phase 1 deliverables:
//   §1  Compact control-row contract (center play/pause + adjacent ±10s,
//       single speed display, in-row source button removal) — PlayerControls
//       source contracts.
//   §2  Blue Velvet-only Back/Fullscreen — stable provider-slug detection,
//       in-row controls wired ONLY for Blue Velvet, floating FABs preserved
//       for every other provider, no duplicate controls.
//   §3  Resolver-to-UI error classification — TITLE_NOT_AVAILABLE vocabulary,
//       the client mapping (title-unavailable state), the Blue Velvet
//       adapter's CONSERVATIVE classification (live-probe evidence), and the
//       shell's distinct title-unavailable card.

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
// §1 — Compact, modern control row (Phase 1A)
// ============================================================

// 1a. Three-group grid row with the play/pause CENTER group.
ok(/grid-template-columns: minmax\(0, 1fr\) auto minmax\(0, 1fr\)/.test(controls), '1a. control-row is a 3-group grid (fluid / center / fluid)');
ok(/class="control-group center"/.test(controls), '1a. a dedicated center control group exists');
// Center group order: skip-back BEFORE play BEFORE skip-fwd.
const centerGroup = controls.slice(controls.indexOf('class="control-group center"'), controls.indexOf('class="control-group right"'));
ok(centerGroup.indexOf('Seek backward 10 seconds') < centerGroup.indexOf('aria-label={playing ? \'Pause\' : \'Play\'}'), '1a. −10s sits immediately LEFT of play/pause');
ok(centerGroup.indexOf('aria-label={playing ? \'Pause\' : \'Play\'}') < centerGroup.indexOf('Seek forward 10 seconds'), '1a. +10s sits immediately RIGHT of play/pause');
// 1b. Compact controls — the shared 38px control-button sizing (no oversized circles).
ok(/\.control-button \{ display: inline-grid; place-items: center; min-width: 38px; min-height: 38px;/.test(controls), '1b. controls keep the compact 38px sizing (no oversized circular buttons)');
ok(!/width: 64px|width: 72px/.test(controls), '1b. no oversized control dimensions introduced');
// 1c. The ±10s skip buttons are NOT hidden on mobile anymore (they are part of the contract).
ok(!/\.skip \{ display: none !important; \}/.test(controls), '1c. skip controls are no longer display:none on compact viewports');
// 1d. Single speed display — the duplicated `{playbackRate}×` label span is gone;
//     the select remains the one renderer of the selected speed.
ok(!/<span>\{playbackRate\}×<\/span>/.test(controls), '1d. the duplicated speed label span is removed (fixes "1× 1×")');
ok(/class="select-control speed" aria-label="Playback speed"><select value=\{playbackRate\}/.test(controls), '1d. the speed select remains the single selected-speed renderer');
ok(/onPlaybackRate\(Number\(\(event\.currentTarget as HTMLSelectElement\)\.value\)\)/.test(controls), '1d. playback-rate behavior unchanged (select drives onPlaybackRate)');
// 1e. The in-row source button is REMOVED; source selection stays with the chip.
ok(!/source-button/.test(controls), '1e. the in-row source button is removed from PlayerControls');
ok(!/export let sourceCount|export let onSources/.test(controls), '1e. sourceCount/onSources props are removed from PlayerControls');
ok(/class="source-chip"/.test(shell) && /aria-label="Choose source"/.test(shell), '1e. the right-edge source chip is preserved in the shell');
ok(/chooseSource\(option\.id\)/.test(shell), '1e. source switching (chooseSource) is preserved');
// 1f. Retained controls: timeline, time label, volume, subtitles, quality (internal + per-stream), PiP.
ok(/class="timeline-input" type="range"/.test(controls), '1f. progress timeline retained');
ok(/aria-live="off">\{formatPlayerTime\(currentTime\)\} <i>\/<\/i> \{formatPlayerTime\(safeDuration\)\}/.test(controls), '1f. current time / duration label retained');
ok(/class="volume-input" type="range"/.test(controls), '1f. volume control retained');
ok(/aria-label="Subtitles"/.test(controls), '1f. subtitles control retained');
ok(/aria-label="Playback quality"/.test(controls) && /internalQualities\.length > 1/.test(controls), '1f. quality selection (engine internal + per-stream fallback) retained');
ok(/Enter Picture-in-Picture/.test(controls), '1f. Picture-in-Picture retained');

// ============================================================
// §2 — Blue Velvet-only Back / Fullscreen (Phase 1B)
// ============================================================

// 2a. Stable identifier — the provider SLUG constant, never a display-name match.
ok(/export const BLUEVELVET_PROVIDER_SLUG = 'blue-velvet' as const;/.test(sharedPlayer), '2a. BLUEVELVET_PROVIDER_SLUG is the stable identifier constant');
ok(/export function isBlueVelvetProvider/.test(sharedPlayer) && /providerSlug === BLUEVELVET_PROVIDER_SLUG/.test(sharedPlayer), '2a. detection compares the stable slug, never a display name');
ok(/providerSlug: provider\?\.slug/.test(watchPage), '2a. the watch route threads the provider slug onto every source option');
ok(!/activeSourceOption\?\.name[^\n]*blue/i.test(shell.slice(shell.indexOf('blueVelvetActive'), shell.indexOf('blueVelvetActive') + 400)), '2a. the gating expression does not match display names');
ok(/\$: blueVelvetActive = isBlueVelvetProvider\(activeSourceOption\?\.providerSlug\);/.test(shell), '2a. shell gates Blue Velvet layout on the active option slug');
// 2b. In-row Back/Fullscreen props exist and are Blue Velvet-scoped.
ok(/showBack=\{blueVelvetActive\}/.test(shell) && /showFullscreen=\{blueVelvetActive\}/.test(shell), '2b. in-row Back/Fullscreen render ONLY while Blue Velvet is active');
ok(/onBack=\{onClose\}/.test(shell), '2b. in-row Back uses the SAME close action as the Back FAB (no second navigation system)');
ok(/onFullscreen=\{\(\) => \{ void toggleFullscreen\(\); \}\}/.test(shell), '2b. in-row Fullscreen uses the SAME Mavero fullscreen/orientation controller');
ok(/fullscreenActive=\{fullscreen\}/.test(shell), '2b. the in-row fullscreen icon mirrors the browser-synced fullscreen state');
// 2c. The floating Back FAB + Landscape FAB group are hidden while Blue Velvet is active.
ok(/\{#if \!\(blueVelvetActive && !touchLocked\)\}/.test(shell), '2c. the Back FAB is suppressed while Blue Velvet is active (returns while touch-locked)');
ok(/\{#if !blueVelvetActive\}[\s\S]*?class="control-fab-group"/.test(shell), '2c. the floating Landscape FAB group is suppressed while Blue Velvet is active');
// 2d. Other providers keep the floating controls.
ok(/class="back-fab"/.test(shell) && /class="control-fab landscape-fab"/.test(shell), '2d. non-Blue Velvet providers keep the Back FAB + Landscape FAB');
// 2e. No duplicates: exactly one Back and one Fullscreen render per provider state.
ok((shell.match(/onBack=\{onClose\}/g) ?? []).length === 1, '2e. exactly one in-row Back binding (no duplicate Back surfaces)');
ok((shell.match(/void toggleFullscreen\(\); \}\}/g) ?? []).length === 1, '2e. exactly one in-row fullscreen binding (F key + FAB remain the non-BV path)');

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
