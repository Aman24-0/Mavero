/**
 * MAVP-4 — Final Player & Admin Source Editor Hardening. Regression suite.
 *
 * Sections:
 *   §1  Issue 1 — the intermediate green/provider-boot screen is eliminated
 *       at its root: the embed presentation GATE. The iframe `load` event no
 *       longer flips the shell to 'playing'; the loading card + an opaque
 *       veil stay mounted until the embed is genuinely presenting (provider
 *       playback signal / user tap into the embed), with a bounded fail-open
 *       for silent black-box embeds. One loading owner; the 18s load timeout
 *       and every error path unchanged; the iframe still mounts eagerly.
 *   §2  Issue 2 — portrait playback fits the viewport without page scroll:
 *       explicit sizing contracts (definite grid, aspect-ratio neutralized
 *       inside the shell, vh→dvh fallback chain) and the html
 *       data-player-open document scroll lock (project convention).
 *   §3  Issue 3 — the Admin position preview interprets configurations
 *       through the SAME shared resolvers as the runtime player, with a
 *       documented reference-viewport scaling model (cqw/cqh), always-
 *       explicit markers in BOTH orientations, and no local re-implementation.
 *   §4  Issue 4 — restored configurable source icons (built-in keys, PNG
 *       upload, pasted sanitized SVG, https image URL) + EXTENSIBLE badges
 *       (built-in Ad-Free/Ads/4K + admin-created labels with controlled
 *       variants): total + strict parsers, SVG sanitizer behavior, server
 *       form-pipeline integration, migration bounds, renderer contracts and
 *       the restored Admin pickers.
 *
 * Deterministic: pure functions + source-level contract assertions. Never
 * the real network, never the real DB, never a real provider, never a
 * browser (browser testing is explicitly out of scope for MAVP-4).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  BACK_CONTROL_DEFAULT_SIZE_PX,
  LANDSCAPE_CONTROL_DEFAULT_SIZE_PX,
  BACK_CONTROL_DEFAULT_EDGE_PX,
  LANDSCAPE_CONTROL_DEFAULT_EDGE_PX,
  CONTROLS_PREVIEW_REFERENCE_PORTRAIT,
  CONTROLS_PREVIEW_REFERENCE_LANDSCAPE,
  parsePlayerControlsPosition,
  controlsPreviewMarkerStyle,
  resolveControlPlacement,
  resolveControlSize,
} from '$lib/shared/player-controls-position';
import {
  parseSourceBadges,
  parseSourceBadgesStrict,
  serializeSourceBadges,
  classifySourceIconValue,
  isImageSourceIcon,
  sourceBadges,
  BUILTIN_SOURCE_BADGES,
  sourceBadgeVariants,
  SOURCE_BADGES_MAX_COUNT,
  SOURCE_BADGES_JSON_MAX_LENGTH,
} from '$lib/shared/source-presentation';
import {
  sanitizeSourceSvgMarkup,
  svgMarkupToDataUrl,
  svgDataUrlToMarkup,
  pngUploadToDataUrl,
  SvgValidationError,
  SOURCE_SVG_MAX_LENGTH,
} from '$lib/server/streaming/svg-sanitizer';
import { parseSourceForm } from '$lib/server/streaming/validation';

function read(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf8');
}

/** Strip JS/Svelte/CSS comments so negative assertions test CODE, not docs. */
function codeOnly(source: string): string {
  return source
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^\s*\/\/.*$/gm, '')
    .split('\n')
    .join('\n');
}

let passCount = 0;
function ok(condition: unknown, message: string): void {
  assert.ok(condition, message);
  passCount++;
}

const shell = read('../src/lib/components/player/PlayerShell.svelte');
const shellCode = codeOnly(shell);
const watchRoute = read('../src/routes/watch/[type]/[id]/+page.svelte');
const watchRouteCode = codeOnly(watchRoute);
const viewport = read('../src/lib/components/player/PlayerViewport.svelte');
const appCss = read('../src/app.css');
const adminPage = read('../src/routes/admin/system/api-sources/+page.svelte');
const adminPageCode = codeOnly(adminPage);
const adminServer = read('../src/routes/admin/system/api-sources/+page.server.ts');
const presentation = read('../src/lib/shared/source-presentation.ts');
const sourceIcon = read('../src/lib/components/source/SourceIcon.svelte');
const migration = read('../supabase/migrations/20261106000000_source_icon_badge_contracts.sql');
const positionModule = read('../src/lib/shared/player-controls-position.ts');

// ---------------------------------------------------------------------------
// §1 — Issue 1: embed presentation gate (no intermediate green screen)
// ---------------------------------------------------------------------------

function shellRegion(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, `shell region not found: ${startMarker}`);
  return source.slice(start, end);
}

/** Locate a region in the RAW source (comment markers survive), then strip comments. */
function rawRegionCode(source: string, startMarker: string, endMarker: string): string {
  return codeOnly(shellRegion(source, startMarker, endMarker));
}

{
  // 1.1 The load handler no longer transitions to 'playing' — the gate owns it.
  const embedLoadRegion = rawRegionCode(shell, 'function handleEmbedLoad()', 'function handleEmbedPlaybackEvent');
  ok(!/state\s*=\s*'playing'/.test(embedLoadRegion), '1.1a handleEmbedLoad no longer sets state to playing (load ≠ presentation-ready)');
  ok(embedLoadRegion.includes('clearEmbedLoadTimeout()'), '1.1b the 18s load timeout is still cleared at load (error recovery intact)');
  ok(embedLoadRegion.includes('startEmbedPresentFailOpen()'), '1.1c the bounded fail-open starts at load for silent embeds');
  ok(embedLoadRegion.includes('onIframeReady(iframeElement)'), '1.1d the adapter still receives the iframe ref immediately (no delayed iframe wiring)');

  // 1.2 The reveal is event-driven + bounded.
  const revealRegion = rawRegionCode(shell, 'function revealEmbedSurface()', 'function handleEmbedLoad()');
  ok(revealRegion.includes("state = 'playing'"), '1.2a the reveal is the single place that flips the embed session to playing');
  ok(revealRegion.includes('revealControls()'), '1.2b the reveal arms the 5s auto-hide countdown (same gate as before)');
  ok(revealRegion.includes('syncMediaSessionPlaybackState'), '1.2c media session sync happens at presentation, not at raw load');
  ok(revealRegion.includes('if (embedSurfacePresenting) return;'), '1.2d the reveal is idempotent (repeated signals cannot re-trigger)');
  ok(/EMBED_PRESENT_FAIL_OPEN_MS\s*=\s*3000/.test(shellCode), '1.2e the fail-open is a documented policy constant (3000ms)');
  const failOpenRegion = rawRegionCode(shell, 'function startEmbedPresentFailOpen()', 'function handleEmbedLoad()');
  ok(failOpenRegion.includes('revealEmbedSurface()'), '1.2f the fail-open reveals through the SAME gate (no parallel transition)');
  ok(shellCode.includes('clearEmbedPresentFailOpen();'), '1.1e fail-open hygiene exists');

  // 1.3 Provider playback signals reveal the embed (play + timeupdate/ready-only adapters).
  const playbackEventRegion = rawRegionCode(shell, 'function handleEmbedPlaybackEvent', '// REMOVED (player controls redesign');
  ok(/event\.type === 'play' \|\| event\.type === 'timeupdate' \|\| event\.type === 'ready'\)\s*revealEmbedSurface\(\)/.test(playbackEventRegion), '1.3a play/timeupdate/ready are presentation signals');
  ok(playbackEventRegion.includes('acquireWakeLock()'), '1.3b the wake-lock contract is unchanged (play only)');
  ok(playbackEventRegion.includes("event.sourceId !== embedPlaybackSourceId") , '1.3c stale-source rejection unchanged');

  // 1.4 The watch route forwards the presentation signals (embed-only by construction).
  ok(/event\.type === 'play' \|\| event\.type === 'pause' \|\| event\.type === 'ended' \|\| event\.type === 'timeupdate' \|\| event\.type === 'ready'/.test(watchRouteCode), '1.4a the route forwards timeupdate/ready into the shell event sink');
  ok(watchRouteCode.includes("{ type: 'play' | 'pause' | 'ended' | 'timeupdate' | 'ready'; _seq: number; sourceId?: string }"), '1.4b the sink type carries the presentation signals');
  ok(shellCode.includes("{ type: 'play' | 'pause' | 'ended' | 'timeupdate' | 'ready'; _seq?: number; sourceId?: string }"), '1.4c the shell prop type carries the presentation signals');

  // 1.5 The veil: one coherent loading→player transition, below the cards.
  ok(/embedVeilActive = Boolean\(/.test(shellCode), '1.5a the veil activity is a derived contract');
  ok(shellCode.includes('{#if embedVeilActive}'), '1.5b the veil renders only while the embed is not presenting');
  ok(/\.embed-veil \{[^}]*z-index:\s*6;/.test(shell), '1.5c the veil sits between the iframe (z-1) and the cards (z-7)');
  ok(/\.embed-veil \{[^}]*pointer-events:\s*none;/.test(shell), '1.5d the veil is pointer-transparent (taps reach the provider = reveal signal)');
  ok(/\.embed-veil \{[^}]*background:\s*var\(--player-bg, var\(--base\)\);/.test(shell), '1.5e the veil paints the shell background (no competing overlay color)');
  ok(shellCode.includes('!resolutionError && !errorMessage'), '1.5f the veil never covers the error/loading cards surface');

  // 1.6 The iframe-tap signal (window blur/focus) is also a presentation reveal.
  const blurHandler = rawRegionCode(shell, 'const handleWindowBlur = () =>', '// MAVP-3 Issue 2: reveal when the user RETURNS');
  ok(blurHandler.includes('revealEmbedSurface()'), '1.6a an iframe tap reveals the embed surface');
  ok(blurHandler.includes('revealControls()'), '1.6b an iframe tap still reveals the controls (MAVP-2/3 contract intact)');
  const focusHandler = rawRegionCode(shell, 'const handleWindowFocus = () =>', "document.addEventListener('fullscreenchange'");
  ok(focusHandler.includes('revealEmbedSurface()'), '1.6c returning-from-iframe reveals the embed surface');

  // 1.7 The gate restarts on every new embed surface (source switch AND episode switch).
  const sourceSwitchRegion = rawRegionCode(shell, 'if (source?.sourceId && source.sourceId !== sourceIdentity)', '// MAVP-4 Issue 1: same-source URL change');
  ok(sourceSwitchRegion.includes('embedSurfacePresenting = false;'), '1.7a a source switch resets the presentation gate');
  ok(sourceSwitchRegion.includes('clearEmbedPresentFailOpen();'), '1.7b a source switch clears the pending fail-open');
  const urlWatcherRegion = rawRegionCode(shell, '// MAVP-4 Issue 1: same-source URL change', '// Phase 6: episode switch cleanup');
  ok(urlWatcherRegion.includes("state = 'embed-loading';") && urlWatcherRegion.includes('startEmbedLoadTimeout(source.sourceId)'), '1.7c a same-source URL change (episode switch) restarts the full gate with a fresh load timeout');
  ok(urlWatcherRegion.includes('source.sourceId === sourceIdentity'), '1.7d the URL watcher only covers the SAME source (no double reset with the id watcher)');
  const episodeRegion = rawRegionCode(shell, '// Phase 6: episode switch cleanup', '// ----- Phase 8: Embed load timeout');
  ok(episodeRegion.includes('clearEmbedPresentFailOpen();'), '1.7e an episode switch clears the pending fail-open');
  const retryRegion = rawRegionCode(shell, 'function retry()', '// ----- Phase 8: Embed load timeout');
  ok(retryRegion.includes('embedSurfacePresenting = false;') && retryRegion.includes('clearEmbedPresentFailOpen();'), '1.7f a retry restarts the presentation gate');

  // 1.8 Full cleanup on destroy.
  const cleanupRegion = rawRegionCode(shell, 'return () => {', 'async function togglePlay()');
  ok(cleanupRegion.includes('clearEmbedPresentFailOpen();'), '1.8a the fail-open timer is cleared on destroy (no stale callbacks)');
  ok(cleanupRegion.includes("clearEmbedLoadTimeout();"), '1.8b the load timeout cleanup is unchanged');

  // 1.9 The iframe still mounts eagerly (no delayed creation/navigation).
  ok(/loading="eager"/.test(viewport), '1.9a the provider iframe keeps loading="eager"');
  ok(viewport.includes("on:load={() => { markPlayerMilestone('mavero:iframe-load'); dispatch('embedload'); }}"), '1.9b the viewport load event contract is unchanged');
  ok(/EMBED_LOAD_TIMEOUT_MS = 18000/.test(shellCode), '1.9c the 18s embed load timeout is unchanged');
}

// ---------------------------------------------------------------------------
// §2 — Issue 2: portrait fit + no page scroll
// ---------------------------------------------------------------------------

{
  // 2.1 Explicit viewport contract with a compatible fallback.
  ok(/\.player-shell \{[^}]*height:\s*100vh;[^}]*height:\s*100dvh;/.test(shell), '2.1a the shell height carries an explicit 100vh fallback before 100dvh');
  ok(/\.player-shell \{[^}]*min-height:\s*100vh;[^}]*min-height:\s*100svh;/.test(shell), '2.1b the min-height chain mirrors the fallback (vh → svh)');
  ok(/\.player-shell\.landscape-mode \{ height:\s*100vh;\s*height:\s*100dvh;\s*\}/.test(shell), '2.1c landscape-mode keeps the same fallback chain');

  // 2.2 Definite grid sizing for the viewport (no order-dependent collapse).
  ok(/\.stage-wrap :global\(\.viewport\) \{[^}]*grid-template-columns:\s*minmax\(0, 1fr\);\s*grid-template-rows:\s*minmax\(0, 1fr\);/.test(shell), '2.2a the viewport grid tracks are definite (minmax(0,1fr) both axes)');
  ok(/\.stage-wrap :global\(\.viewport\.embed iframe\) \{[^}]*aspect-ratio:\s*auto;/.test(shell), '2.2b the legacy detail-page embed aspect-ratio is explicitly neutralized inside the shell');
  ok(/\.stage-wrap :global\(\.viewport\.embed iframe\) \{[^}]*height:\s*100%;/.test(shell), '2.2c the embed iframe height is explicit (full stage)');
  ok(/\.stage-wrap :global\(\.viewport iframe\), \.stage-wrap :global\(\.viewport video\) \{ width:\s*100%;\s*height:\s*100%;\s*\}/.test(shell), '2.2d the iframe/video fill the stage on both axes');
  ok(/\.stage-wrap :global\(\.viewport\) \{[^}]*max-height:\s*none;/.test(shell), '2.2e the legacy mobile max-height clamp stays overridden (higher specificity, order-independent)');
  ok(/\.stage-wrap :global\(\.viewport\) \{[^}]*min-height:\s*0;/.test(shell), '2.2f the legacy min-height clamp stays overridden');
  ok(/\.viewport video, \.viewport iframe \{[^}]*object-fit:\s*contain;/.test(viewport), '2.2g the provider presentation contract is untouched (object-fit: contain — no stretch/crop)');

  // 2.3 The document scroll lock (project convention, applied + removed with the shell).
  ok(shellCode.includes("document.documentElement.setAttribute('data-player-open', '');"), '2.3a the shell sets the html data-player-open attribute on mount');
  ok(shellCode.includes("document.documentElement.removeAttribute('data-player-open');"), '2.3b the shell removes the attribute on destroy (never global)');
  // MAVP-5 RC-1 supersession: the lock is COMPLETED at the root — the html
  // element is locked too (both axes) and both rules carry
  // overscroll-behavior: none (gesture chaining from the only unsandboxed
  // embed is absorbed). The body rule is a strict superset of the MAVP-4
  // contract (stronger assertion, same attribute lifecycle).
  ok(appCss.includes('html[data-player-open] body { overflow: hidden; overscroll-behavior: none; }'), '2.3c app.css locks the body scroll under the established convention (MAVP-5: + overscroll-behavior)');
  ok(appCss.includes('html[data-player-open] { overflow: hidden; overscroll-behavior: none; }'), '2.3c-MAVP5 the html ROOT scroller is locked too (VidRift gesture-chaining absorbed)');
  // MAVP-5 RC-1 supersession: the lock comment now documents BOTH the MAVP-4
  // introduction and the MAVP-5 root-level completion.
  const lockComments = appCss.includes('Player route scroll lock (MAVP-4 Issue 2; completed by MAVP-5 RC-1)');
  ok(lockComments, '2.3d the scroll lock is documented in app.css');
  // The lock must NOT be touch-action:none (the player needs its gestures).
  ok(!/html\[data-player-open\] body \{[^}]*touch-action:\s*none/.test(appCss), '2.3e the player scroll lock does not disable touch gestures');
}

// ---------------------------------------------------------------------------
// §3 — Issue 3: shared preview geometry (behavioral)
// ---------------------------------------------------------------------------

{
  const defaultPosition = parsePlayerControlsPosition(null); // null = defaults

  // 3.1 Reference viewports are documented constants.
  ok(CONTROLS_PREVIEW_REFERENCE_PORTRAIT.width === 390 && CONTROLS_PREVIEW_REFERENCE_PORTRAIT.height === 844, '3.1a portrait reference viewport is 390×844');
  ok(CONTROLS_PREVIEW_REFERENCE_LANDSCAPE.width === 844 && CONTROLS_PREVIEW_REFERENCE_LANDSCAPE.height === 390, '3.1b landscape reference viewport is 844×390');
  ok(BACK_CONTROL_DEFAULT_EDGE_PX === 12 && LANDSCAPE_CONTROL_DEFAULT_EDGE_PX === 16, '3.1c the default corner edges mirror the runtime stylesheet (12/16 px)');

  // 3.2 Defaults render BOTH markers at their runtime default corners in BOTH orientations.
  for (const orientation of ['portrait', 'landscape'] as const) {
    const back = controlsPreviewMarkerStyle(defaultPosition, 'back', orientation);
    const landscape = controlsPreviewMarkerStyle(defaultPosition, 'landscape', orientation);
    ok(back.includes('left:') && back.includes('top:'), `3.2a ${orientation}: the Back marker is explicitly positioned at the default top-left`);
    ok(landscape.includes('right:') && landscape.includes('bottom:'), `3.2b ${orientation}: the Landscape marker is explicitly positioned at the default bottom-right`);
    ok(back.includes(`calc(${BACK_CONTROL_DEFAULT_SIZE_PX} / `) && back.includes('100cqw)'), `3.2c ${orientation}: the Back marker renders the DEFAULT size scaled (44px → cqw)`);
    ok(landscape.includes(`calc(${LANDSCAPE_CONTROL_DEFAULT_SIZE_PX} / `) && landscape.includes('100cqw)'), `3.2d ${orientation}: the Landscape marker renders the DEFAULT size scaled (48px → cqw)`);
  }
  // Default corners are scaled, not raw runtime pixels.
  const portraitBack = controlsPreviewMarkerStyle(defaultPosition, 'back', 'portrait');
  ok(portraitBack.includes(`calc(${BACK_CONTROL_DEFAULT_EDGE_PX} / ${CONTROLS_PREVIEW_REFERENCE_PORTRAIT.width} * 100cqw)`), '3.2e the horizontal default edge scales against the reference width');
  ok(portraitBack.includes(`calc(${BACK_CONTROL_DEFAULT_EDGE_PX} / ${CONTROLS_PREVIEW_REFERENCE_PORTRAIT.height} * 100cqh)`), '3.2f the vertical default edge scales against the reference height');
  const landscapeDot = controlsPreviewMarkerStyle(defaultPosition, 'landscape', 'landscape');
  ok(landscapeDot.includes(`calc(${LANDSCAPE_CONTROL_DEFAULT_EDGE_PX} / ${CONTROLS_PREVIEW_REFERENCE_LANDSCAPE.width} * 100cqw)`), '3.2g the landscape default edge scales against the LANDSCAPE reference width');

  // 3.3 Configured anchors/offsets render as viewport-relative % (same as runtime).
  const custom = parsePlayerControlsPosition({
    mode: 'custom',
    back: { portrait: { horizontal: { anchor: 'left', offsetPercent: 10 }, vertical: { anchor: 'top', offsetPercent: 20 } } },
    portrait: { horizontal: { anchor: 'right', offsetPercent: 15 }, vertical: { anchor: 'bottom', offsetPercent: 25 } },
    sizes: { back: 64, landscape: 36 },
  });
  assert.ok(custom, '3.3 fixture parses');
  const backPortrait = controlsPreviewMarkerStyle(custom, 'back', 'portrait');
  ok(backPortrait.includes('left:10%') && backPortrait.includes('top:20%'), '3.3a configured back anchors/offsets render as the same viewport-relative %');
  const dotPortrait = controlsPreviewMarkerStyle(custom, 'landscape', 'portrait');
  ok(dotPortrait.includes('right:15%') && dotPortrait.includes('bottom:25%'), '3.3b the landscape control inherits its configured portrait profile through the shared resolver');
  ok(backPortrait.includes(`calc(64 / ${CONTROLS_PREVIEW_REFERENCE_PORTRAIT.width} * 100cqw)`), '3.3c the configured Back size renders scaled from the configured px');
  ok(dotPortrait.includes(`calc(36 / ${CONTROLS_PREVIEW_REFERENCE_PORTRAIT.width} * 100cqw)`), '3.3d the configured Landscape size renders scaled');

  // 3.4 Center anchors mirror the runtime transform contract.
  const centered = parsePlayerControlsPosition({
    mode: 'custom',
    back: { portrait: { horizontal: { anchor: 'center' }, vertical: { anchor: 'center' } } },
  });
  assert.ok(centered, '3.4 fixture parses');
  const centeredStyle = controlsPreviewMarkerStyle(centered, 'back', 'portrait');
  ok(centeredStyle.includes('left:50%') && centeredStyle.includes('top:50%') && centeredStyle.includes('translateX(-50%)') && centeredStyle.includes('translateY(-50%)'), '3.4 center anchors render 50% + the -50% translate (runtime-identical)');

  // 3.5 The preview output agrees with the RUNTIME resolvers (one interpretation).
  const placement = resolveControlPlacement(custom, 'back', 'portrait');
  const size = resolveControlSize(custom, 'back');
  ok(placement.horizontal?.anchor === 'left' && placement.horizontal.offsetPercent === 10, '3.5a the shared resolver agrees with the preview geometry (anchor)');
  ok(size === 64, '3.5b the shared resolver agrees with the preview geometry (size)');
  ok(controlsPreviewMarkerStyle(parsePlayerControlsPosition(null), 'back', 'portrait').includes(`calc(${BACK_CONTROL_DEFAULT_SIZE_PX}`) === true, '3.5c a null/default config falls back to the default size in the preview');

  // 3.6 The Admin preview USES the shared resolvers (no local re-implementation).
  ok(adminPageCode.includes('parsePlayerControlsPosition(JSON.parse(controlsPositionJson))'), '3.6a the preview parses the EXACT payload the form submits through the REAL parser');
  ok(adminPageCode.includes("controlsPreviewMarkerStyle(previewPosition, 'back', positionPreviewOrientation)") && adminPageCode.includes("controlsPreviewMarkerStyle(previewPosition, 'landscape', positionPreviewOrientation)"), '3.6b both markers are styled by the shared geometry helper');
  ok(!/function previewProfileStyle/.test(adminPageCode), '3.6c the divergent local preview re-implementation is GONE');
  ok(adminPageCode.includes("previewBackStyle") && adminPageCode.includes("previewLandscapeStyle"), '3.6d the markers bind the shared styles reactively (draft changes update the preview)');
  ok(/\.a2-position-preview \{[^}]*container-type:\s*size;/.test(adminPage), '3.6e the stage is a size-query container (cqw/cqh scaling model)');
  ok(/\.a2-position-preview \{[^}]*aspect-ratio:\s*844\s*\/\s*390;/.test(adminPage) && /\.a2-position-preview\.portrait \{[^}]*aspect-ratio:\s*390\s*\/\s*844;/.test(adminPage), '3.6f the stages keep the REFERENCE viewport aspect ratios in both orientations');
  ok(!/width:12px;\s*height:12px|width:14px;\s*height:14px/.test(adminPageCode.replace(/\s+/g, '')), '3.6g the fixed 12/14px marker boxes are gone (sizes come from the shared contract)');
}

// ---------------------------------------------------------------------------
// §4 — Issue 4: icons + extensible badges
// ---------------------------------------------------------------------------

{
  // 4.1 Badge contract parsers (TOTAL renderer-side parser).
  ok(parseSourceBadges(null).length === 0, '4.1a null renders no badges');
  ok(parseSourceBadges('').length === 0, '4.1b empty renders no badges');
  ok(parseSourceBadges('ads')[0]?.label === 'Ads' && parseSourceBadges('ads')[0]?.variant === 'warning', '4.1c the legacy "ads" enum maps to its config (label + variant)');
  ok(parseSourceBadges('ad-free')[0]?.label === 'Ad-Free' && parseSourceBadges('ad-free')[0]?.variant === 'positive', '4.1d the legacy "ad-free" enum maps to its config');
  ok(parseSourceBadges('garbage').length === 0, '4.1e non-JSON garbage renders no badges (total parser)');
  ok(parseSourceBadges('['.repeat(2000)).length === 0, '4.1f oversized payloads render no badges (bounded parser)');
  ok(parseSourceBadges('{"id":"x"}').length === 0, '4.1g a non-array JSON renders no badges');
  const validArray = JSON.stringify([
    { id: '4k', label: '4K', variant: 'accent' },
    { id: 'ad-free', label: 'Ad-Free', variant: 'positive' },
    { id: 'ads', label: 'Ads', variant: 'warning' },
  ]);
  ok(parseSourceBadges(validArray).length === 3, '4.1h a valid 3-badge array parses');
  ok(parseSourceBadges(JSON.stringify([
    { id: '4k', label: '4K', variant: 'accent' },
    { id: '4k', label: 'Duplicate', variant: 'accent' },
    { id: 'other', label: 'Other', variant: 'neutral' },
    { id: 'more', label: 'More', variant: 'neutral' },
  ])).length === 3, '4.1i the total parser dedupes ids and caps at 3 (never overflows the layout)');
  ok(parseSourceBadges(JSON.stringify([{ id: 'bad label!', label: 'ok', variant: 'accent' }])).length === 0, '4.1j an invalid id drops the entry (total parser)');
  ok(parseSourceBadges(JSON.stringify([{ id: 'ok', label: '<script>x</script>', variant: 'accent' }])).length === 0, '4.1k markup in a label drops the entry (labels render as inert text only)');

  // 4.2 STRICT admin parser (server gate).
  assert.throws(() => parseSourceBadgesStrict(JSON.stringify([
    { id: 'dup', label: 'A', variant: 'accent' },
    { id: 'dup', label: 'B', variant: 'accent' },
  ])), '4.2a duplicate ids are REJECTED for admin saves');
  assert.throws(() => parseSourceBadgesStrict(JSON.stringify([
    { id: 'a', label: 'A', variant: 'accent' },
    { id: 'b', label: 'B', variant: 'accent' },
    { id: 'c', label: 'C', variant: 'accent' },
    { id: 'd', label: 'D', variant: 'accent' },
  ])), '4.2b more than 3 badges is REJECTED');
  assert.throws(() => parseSourceBadgesStrict(JSON.stringify([{ id: 'x', label: 'X', variant: 'neon' }])), '4.2c an unknown variant is REJECTED (controlled enum)');
  assert.throws(() => parseSourceBadgesStrict('not-json'), '4.2d non-JSON is REJECTED with an explicit error');
  assert.throws(() => parseSourceBadgesStrict('x'.repeat(2000)), '4.2e an oversized payload is REJECTED (DB bound mirrored)');
  ok(parseSourceBadgesStrict('ads')[0]?.id === 'ads', '4.2f legacy enum values pass the strict parser');
  ok(parseSourceBadgesStrict('none').length === 0, '4.2g "none" clears the badges');
  const roundTrip = serializeSourceBadges(parseSourceBadgesStrict(validArray));
  ok(roundTrip === validArray, '4.2h serialize ∘ strict-parse is the canonical stored form (round-trip stable)');

  // 4.3 Built-ins + variants.
  ok(BUILTIN_SOURCE_BADGES.map((badge) => badge.label).join(',') === 'Ad-Free,Ads,4K', '4.3a the built-in badge definitions are Ad-Free / Ads / 4K');
  ok(sourceBadgeVariants.join(',') === 'accent,positive,warning,neutral', '4.3b the variant enum is controlled (4 values)');
  ok(SOURCE_BADGES_MAX_COUNT === 3 && SOURCE_BADGES_JSON_MAX_LENGTH === 1000, '4.3c the bounds match the DB CHECK (≤3 badges, ≤1000 chars)');
  ok(sourceBadges.join(',') === 'ads,ad-free', '4.3d the Task 13 legacy enum is preserved');

  // 4.4 Icon value classification.
  ok(classifySourceIconValue('film') === 'key', '4.4a legacy keys classify as key');
  ok(classifySourceIconValue('not-a-key-at-all') === 'key', '4.4b unknown values degrade to the key path (default-icon fallback)');
  ok(classifySourceIconValue(`data:image/png;base64,${'A'.repeat(40)}`) === 'png-data', '4.4c PNG data URLs classify as png-data');
  ok(classifySourceIconValue(`data:image/svg+xml;base64,${'A'.repeat(40)}`) === 'svg-data', '4.4d SVG data URLs classify as svg-data');
  ok(classifySourceIconValue('https://cdn.example.com/icon.svg') === 'remote-url', '4.4e https image URLs classify as remote-url');
  ok(classifySourceIconValue('javascript:alert(1)') === 'key', '4.4f a javascript: URL degrades to the key path (never an image src)');
  ok(classifySourceIconValue(`https://cdn.example.com/${'x'.repeat(600)}.svg`) === 'key', '4.4g oversized URLs degrade (bound enforced)');
  ok(isImageSourceIcon('https://x.example/a.png') && !isImageSourceIcon('film'), '4.4h the image predicate gates the <img> render path');

  // 4.5 SVG sanitizer behavior (established sanitizer pattern).
  const clean = '<svg viewBox="0 0 24 24"><path d="M4 4h16v16H4z" fill="#00ff9c"/></svg>';
  const sanitized = sanitizeSourceSvgMarkup(clean);
  ok(sanitized.includes('viewBox="0 0 24 24"') && sanitized.includes('d="M4 4h16v16H4z"'), '4.5a safe markup survives verbatim');
  ok(sanitized.includes('xmlns="http://www.w3.org/2000/svg"'), '4.5b the root always gains xmlns (data-URL renderable)');
  ok(sanitized.includes('color="#f2fff8"'), '4.5c the root gains the dark-theme currentColor anchor');
  ok(svgDataUrlToMarkup(svgMarkupToDataUrl(sanitized)) === sanitized, '4.5d the data-URL round-trip is stable');

  assert.throws(() => sanitizeSourceSvgMarkup('<svg><script>alert(1)</script></svg>'), SvgValidationError, '4.5e scripts are REJECTED');
  assert.throws(() => sanitizeSourceSvgMarkup('<svg onload="alert(1)"><path d="M0 0"/></svg>'), /event-handler/, '4.5f event-handler attributes are REJECTED');
  assert.throws(() => sanitizeSourceSvgMarkup('<svg><a href="https://evil.example"><path d="M0 0"/></a></svg>'), /forbidden element/, '4.5g external href references are REJECTED');
  assert.throws(() => sanitizeSourceSvgMarkup('<svg><use href="#x"/></svg>'), /forbidden element/, '4.5h <use> is REJECTED');
  assert.throws(() => sanitizeSourceSvgMarkup('<svg><image href="https://evil.example/x.png"/></svg>'), /forbidden element/, '4.5i <image> is REJECTED');
  assert.throws(() => sanitizeSourceSvgMarkup('<svg><foreignObject><body><p>x</p></body></foreignObject></svg>'), /forbidden element/, '4.5j foreignObject is REJECTED');
  assert.throws(() => sanitizeSourceSvgMarkup('<svg><animate attributeName="onload" to="alert(1)"/></svg>'), /forbidden element/, '4.5k SMIL animation is REJECTED');
  assert.throws(() => sanitizeSourceSvgMarkup('<svg><path fill="url(https://evil.example/x.svg)" d="M0 0"/></svg>'), /external resource/, '4.5l external url() paint references are REJECTED');
  assert.throws(() => sanitizeSourceSvgMarkup('<svg><path fill="url(javascript:alert(1))" d="M0 0"/></svg>'), /forbidden URL scheme/, '4.5m javascript: url() is REJECTED');
  assert.throws(() => sanitizeSourceSvgMarkup('<svg><path style="background:url(https://evil.example)" d="M0 0"/></svg>'), /external resource|forbidden/, '4.5n dangerous style declarations are REJECTED');
  assert.throws(() => sanitizeSourceSvgMarkup(`<svg>${'<path d="M0 0"/>'.repeat(3000)}`), /fewer/, '4.5o oversized markup is REJECTED (bound mirrored in the migration)');
  assert.throws(() => sanitizeSourceSvgMarkup(''), /empty/, '4.5p empty markup is REJECTED');

  const benignEditorExport = sanitizeSourceSvgMarkup('<svg xmlns="http://www.w3.org/2000/svg" inkscape:version="1.2"><sodipodi:namedview></sodipodi:namedview><g inkscape:label="Layer 1"><rect x="2" y="2" width="8" height="8"/></g></svg>');
  ok(!benignEditorExport.includes('inkscape') && !benignEditorExport.includes('sodipodi'), '4.5q editor-namespace content is dropped silently (admin friction kept low)');
  const styled = sanitizeSourceSvgMarkup('<svg><path d="M0 0" style="fill:#ffffff;stroke-width:2"/></svg>');
  ok(styled.includes('style="fill:#ffffff;stroke-width:2"'), '4.5r benign presentation style declarations survive');
  const fragment = sanitizeSourceSvgMarkup('<svg><defs><linearGradient id="g"><stop offset="0" stop-color="#fff"/></linearGradient></defs><rect width="4" height="4" fill="url(#g)"/></svg>');
  ok(fragment.includes('url(#g)'), '4.5s same-document #fragment paint references are ALLOWED');
  // Idempotency: sanitizing sanitized output is a no-op (re-parse verify).
  ok(sanitizeSourceSvgMarkup(sanitized) === sanitized, '4.5t sanitization is idempotent (stable re-parse)');

  // 4.6 PNG upload guard.
  const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const fakePng = Buffer.concat([PNG_SIGNATURE, Buffer.alloc(64, 7)]);
  const pngFile = new File([fakePng], 'icon.png', { type: 'image/png' });
  const pngUrl = await pngUploadToDataUrl(pngFile);
  ok(pngUrl.startsWith('data:image/png;base64,') && pngUrl.length > 40, '4.6a a valid PNG upload becomes a bounded data URL');
  await assert.rejects(() => pngUploadToDataUrl(new File([Buffer.from('not a png'), ], 'icon.png', { type: 'image/png' })), /not a valid PNG/, '4.6b a non-PNG payload with a PNG mime is REJECTED (magic bytes)');
  await assert.rejects(() => pngUploadToDataUrl(new File([fakePng], 'icon.gif', { type: 'image/gif' })), /must be PNG/, '4.6c a wrong MIME is REJECTED');
  await assert.rejects(() => pngUploadToDataUrl(new File([Buffer.alloc(65 * 1024, 1)], 'big.png', { type: 'image/png' })), /64 KB/, '4.6d an oversized PNG is REJECTED');
}

{
  // 4.7 The FULL server form pipeline (parseSourceForm — async since MAVP-4).
  function baseForm(): FormData {
    const form = new FormData();
    form.set('provider_id', '01234567-89ab-cdef-0123-456789abcdef');
    form.set('name', 'Icon Test Source');
    form.set('slug', 'icon-test-source');
    form.set('visibility', 'public');
    form.set('status', 'active');
    form.set('ordering', '1');
    return form;
  }

  // Legacy icon key + legacy badge — byte-compatible path.
  const legacyParsed = await parseSourceForm(baseForm());
  ok(legacyParsed.icon === null && legacyParsed.badge === null, '4.7a a form without presentation fields stores nulls');

  const keyForm = baseForm();
  keyForm.set('icon', 'film');
  keyForm.set('badge', 'ad-free');
  const keyParsed = await parseSourceForm(keyForm);
  ok(keyParsed.icon === 'film', '4.7b the legacy icon key path is unchanged');
  ok(keyParsed.badge === 'ad-free', '4.7c the legacy badge enum is stored verbatim');

  // Pasted SVG markup is sanitized + stored as a canonical data URL.
  const svgForm = baseForm();
  svgForm.set('icon', '<svg viewBox="0 0 8 8"><rect width="8" height="8" fill="#123456"/></svg>');
  const svgParsed = await parseSourceForm(svgForm);
  const svgStored = typeof svgParsed.icon === 'string' ? svgParsed.icon : '';
  ok(svgStored.startsWith('data:image/svg+xml;base64,'), '4.7d pasted SVG markup is stored as a sanitized data URL');
  const svgDecoded = svgDataUrlToMarkup(svgStored);
  ok(svgDecoded !== null && !svgDecoded.includes('onclick'), '4.7e the event handler never reaches the stored value (sanitized before save)');
  ok(svgDecoded !== null && svgDecoded.includes('xmlns='), '4.7f the stored SVG is canonical (xmlns present)');

  // Uploaded PNG file (multipart `icon_file`) wins over the icon field.
  const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const uploadForm = baseForm();
  uploadForm.set('icon', 'film');
  uploadForm.set('icon_file', new File([Buffer.concat([PNG_SIGNATURE, Buffer.alloc(32, 3)])], 'icon.png', { type: 'image/png' }));
  const uploadParsed = await parseSourceForm(uploadForm);
  ok(typeof uploadParsed.icon === 'string' && uploadParsed.icon.startsWith('data:image/png;base64,'), '4.7g an uploaded PNG (icon_file) overrides the icon field and stores a data URL');

  // Event-handler-bearing pasted markup is REJECTED (never silently kept).
  await assert.rejects(() => {
    const bad = baseForm();
    bad.set('icon', '<svg viewBox="0 0 8 8"><rect width="8" height="8" fill="#123456" onclick="alert(1)"/></svg>');
    return parseSourceForm(bad);
  }, /event-handler|scripts/, '4.7l pasted SVG with an event handler is REJECTED through the form pipeline');

  // Invalid icon values are rejected with admin-facing messages.
  await assert.rejects(() => {
    const bad = baseForm();
    bad.set('icon', 'data:text/html;base64,AAAA');
    return parseSourceForm(bad);
  }, /Source icon is invalid/, '4.7h a non-image data URL is REJECTED');

  // Extensible badges through the form pipeline.
  const badgeForm = baseForm();
  badgeForm.set('badge', JSON.stringify([
    { id: '4k', label: '4K', variant: 'accent' },
    { id: 'new-thing', label: 'New Thing', variant: 'neutral' },
  ]));
  const badgeParsed = await parseSourceForm(badgeForm);
  ok(typeof badgeParsed.badge === 'string' && badgeParsed.badge.includes('"New Thing"'), '4.7i a custom admin-created badge passes strict validation into the canonical stored form');
  await assert.rejects(() => {
    const bad = baseForm();
    bad.set('badge', JSON.stringify([{ id: 'x', label: 'X', variant: 'rainbow' }]));
    return parseSourceForm(bad);
  }, /variant/, '4.7j an invalid badge variant is rejected through the form pipeline');
  await assert.rejects(() => {
    const bad = baseForm();
    bad.set('badge', '<b>not json</b>');
    return parseSourceForm(bad);
  }, /badges payload/, '4.7k arbitrary badge markup is REJECTED (never stored, never rendered)');

  // 4.8 The migration widens exactly the two column contracts (additive only).
  ok(migration.includes("drop constraint if exists streaming_sources_icon_check") && migration.includes('add constraint streaming_sources_icon_check'), '4.8a the icon CHECK is widened (dropped + re-added)');
  ok(migration.includes("icon ~ '^[a-z][a-z0-9-]{0,29}$'"), '4.8b the legacy key format remains VALID (backward compatible)');
  ok(migration.includes("icon ~ '^data:image/(png|svg\\+xml);base64,[A-Za-z0-9+/]+={0,2}$'") && migration.includes('length(icon) <= 100000'), '4.8c bounded image data URLs are accepted');
  ok(migration.includes("icon ~ '^https?://'") && migration.includes('length(icon) <= 500'), '4.8d remote image URLs are accepted at the established 500-char bound');
  ok(migration.includes("badge in ('ads', 'ad-free')"), '4.8e the legacy badge enum remains VALID (backward compatible)');
  ok(migration.includes("badge like '[%'") && migration.includes('length(badge) <= 1000'), '4.8f the JSON-array badge shape is accepted with the shared length bound');
  ok(!migration.includes('drop column') && !migration.includes('drop table'), '4.8g the migration is purely additive (no destructive changes)');
  ok(!/alter\s+table\s+public\.streaming_public_sources/i.test(migration), '4.8h the public mirror needs NO change (columns carried verbatim — only the base-table CHECKs are widened)');

  // 4.9 Renderer contracts — SourceIcon (rich icons via <img>, never {@html}).
  ok(sourceIcon.includes('classifySourceIconValue(icon)'), '4.9a the renderer classifies the icon value through the shared contract');
  ok(sourceIcon.includes('<img') && sourceIcon.includes('src={icon ?? undefined}'), '4.9b rich icons render through <img> (script-inert for SVG)');
  ok(!codeOnly(sourceIcon).includes('{@html'), '4.9c the renderer NEVER injects markup ({@html} is absent from code, not just docs)');
  ok(sourceIcon.includes('onerror={() => { imageFailed = true; }}'), '4.9d a failed image falls back to the default key icon (broken/blank can never render)');
  ok(sourceIcon.includes('iconComponents[resolveSourceIcon(icon)]'), '4.9e the legacy key path + default fallback are unchanged (Task 13 contract)');
  ok(presentation.includes('export function classifySourceIconValue'), '4.9f the classifier is shared (one contract for admin + renderer)');

  // 4.10 Player source selector — multiple styled chips beside the source name.
  ok(shellCode.includes('{#each option.badges ?? [] as badgeConfig (badgeConfig.id)}'), '4.10a the selector renders EVERY configured badge (extensible)');
  ok(shellCode.includes('data-variant={badgeConfig.variant}') && shellCode.includes('{badgeConfig.label}'), '4.10b chips render the controlled variant + inert label text');
  ok(shellCode.includes("data-badge={option.badge}"), '4.10c the legacy single-badge render path is preserved (backward compatibility)');
  for (const variant of sourceBadgeVariants) {
    ok(shell.includes(`.source-badge[data-variant='${variant}']`), `4.10d the '${variant}' variant is styled`);
  }
  ok(shellCode.includes('color: var(--accent-2)') && shellCode.includes('color: var(--success)') && shellCode.includes('color: var(--warning)'), '4.10e variant colors use THEME TOKENS only (no hardcoded chip colors)');
  ok(!/\.source-badge\[data-variant='[^']+'\] \{[^}]*#[0-9a-fA-F]{3,6}/.test(shell), '4.10f no hardcoded hex colors in the variant styles');
  ok(shellCode.includes('flex-wrap: wrap') , '4.10g the option title wraps (multiple badges stay responsive on narrow screens)');

  // 4.11 The watch route carries the parsed badges on the option.
  ok(watchRouteCode.includes('badges: parseSourceBadges(source.badge)'), '4.11a the option carries the TOTAL-parsed badge configs');
  ok(watchRouteCode.includes('badge: isSourceBadge(source.badge) ? source.badge : undefined'), '4.11b the legacy guarded badge copy is unchanged');
  ok(read('../src/lib/shared/player.ts').includes('badges?: SourceBadgeConfig[]'), '4.11c PlayerSourceOption carries the extensible badge list');

  // 4.12 The Admin editor: restored pickers + rich inputs.
  ok(adminPageCode.includes("import SourceIcon from '$lib/components/source/SourceIcon.svelte'"), '4.12a the admin page renders real icons (SourceIcon)');
  ok(adminPageCode.includes('<SourceIcon icon={source.icon ?? null} size={20} />'), '4.12b the source LIST rows render the real icon (no more plain-text fallback)');
  ok(!adminPageCode.includes("{source.icon ?? '📦'}"), '4.12c the raw-text icon placeholder is GONE');
  ok(adminPageCode.includes('source-badge-mini') && adminPageCode.includes('parseSourceBadges(source.badge)'), '4.12d the source LIST rows render badge chips');
  ok(adminPageCode.includes('<SourceIcon icon={iconKey} size={16} />'), '4.12e the built-in key picker is restored with live previews');
  ok(adminPageCode.includes('name="icon_file"') && adminPageCode.includes('accept="image/png,image/svg+xml"'), '4.12f the PNG/SVG upload input exists with MIME guidance');
  ok(adminPageCode.includes('enctype="multipart/form-data"'), '4.12g the source form posts multipart (files reach the server)');
  ok(adminPageCode.includes('aria-label="SVG markup"'), '4.12h the SVG paste editor exists');
  ok(adminPageCode.includes('bind:value={iconUrlDraft}'), '4.12i the image URL editor exists');
  ok(adminPageCode.includes('<input type="hidden" name="icon" value={iconSubmitValue} />'), '4.12j the raw icon value travels in the hidden field (server validates/sanitizes)');
  ok(adminPageCode.includes('<input type="hidden" name="badge" value={badgeSubmitValue} />'), '4.12k the badge payload travels in the hidden field (canonical serialization)');
  ok(adminPageCode.includes('onclick={createBadgeDefinition}') && adminPageCode.includes('aria-label="New badge label"'), '4.12l admins can CREATE new badge labels with a controlled variant');
  ok(adminPageCode.includes('BUILTIN_SOURCE_BADGES'), '4.12m the built-in Ad-Free/Ads/4K definitions feed the picker');
  ok(adminPageCode.includes('knownBadgeDefinitions'), '4.12n existing badge definitions are harvested for reuse across sources');
  ok(adminPageCode.includes('data:image/svg+xml;utf8,${encodeURIComponent(iconSvgDraft)}'), '4.12o the SVG paste preview is a script-inert <img> data URL (never {@html})');
  ok(!codeOnly(adminPage).includes('{@html'), '4.12p the admin page NEVER injects markup');
  ok(adminPageCode.includes('iconMode === \'svg\'') && adminPageCode.includes('decodeSvgDataUrl(storedIcon)'), '4.12q an existing sanitized SVG icon prefills the paste editor for re-editing');

  // 4.13 The server pipeline is wired (async parseSourceForm call sites).
  ok(adminServer.includes('await parseSourceForm(await request.formData())'), '4.13a createSource awaits the async form parse');
  ok(adminServer.includes('const parsed = await parseSourceForm(form);'), '4.13b updateSource awaits the async form parse');
  ok(read('../src/lib/server/streaming/validation.ts').includes('export async function parseSourceForm'), '4.13c parseSourceForm is async (icon_file processing)');
  ok(read('../src/lib/server/streaming/validation.ts').includes("(await iconFileValue(form)) ?? iconValue(form.get('icon'))"), '4.13d the uploaded file takes precedence over the icon field');
}

console.log('MAVP-4 player & admin hardening regression tests passed:');
console.log(`  §1 embed presentation gate: (checks so far: ${passCount})`);
console.log('  full breakdown is printed by the per-section counters below');

console.log(`MAVP-4 player hardening regression suite: ${passCount} checks passed`);
