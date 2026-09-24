import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * Phase B — Stream Card UX test suite.
 *
 * Pins the §B2 card-visual-UX contract required by the approved plan:
 *
 *   "Each link/card should be visually understandable at a glance."
 *
 * The card now renders structured badges for each metadata dimension:
 *   * stream-kind icon (HTTP/HTTPS=FileVideo, HLS/DASH=Radio, P2P=Users,
 *     Magnet=Magnet) so the user can recognize the stream type at a glance
 *   * quality badge (4K / 1080p / 720p / 480p / Auto — color-coded)
 *   * codec badge (H.264 / HEVC / AV1 / VP9)
 *   * container badge (MKV / MP4 / WebM / MOV / …)
 *   * audio badge with icon (Volume2 — Multi / Dual / language codes)
 *   * size badge with icon (HardDrive — 8.8 GB / 500 MB / …)
 *   * hosting/server identity badge with icon (Server — pixeldrain.com /
 *     fsl.example.com / …) — this is the §B2 "hosting/server identity
 *     where useful" requirement
 *   * the existing Share action (mad-action mad-action-share) is
 *     PRESERVED with all its a11y / focus / state classes
 *
 * Hard requirements (from the approved plan):
 *   * Use existing Mavero design tokens (var(--ink), var(--muted),
 *     var(--accent), var(--line), var(--accent-soft), var(--radius-sm))
 *   * No excessive neon/glow — quality color coding uses tokens only
 *   * Maintain responsive behavior, keyboard a11y, visible focus states,
 *     touch usability, TV/large-screen usability, reduced-motion compat
 *   * Do NOT break the existing Share action — no Download/Play/Copy
 *     reintroduced (Phase 18 contract preserved)
 *
 * All assertions are static (source-level + structure) — no live streaming
 * providers are contacted.
 */

let passed = 0;
function ok(condition: unknown, label: string) {
  assert.ok(condition, label);
  passed += 1;
}

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative: string) => readFileSync(path.join(REPO_ROOT, relative), 'utf8');

// ---------------------------------------------------------------------------
// §B2.1 — Structured badges are rendered for each metadata dimension
// ---------------------------------------------------------------------------

function section1_structuredBadges(): void {
  const component = read('src/lib/components/MaveroAddonDownload.svelte');
  // Kind icon helper — maps each kind to a scannable icon.
  ok(component.includes('function kindIcon'), '1: kindIcon helper exists');
  ok(component.includes('FileVideo'), '1: HTTP/HTTPS uses FileVideo icon');
  ok(component.includes('Radio'), '1: HLS/DASH uses Radio icon (streaming broadcast metaphor)');
  ok(component.includes('Users'), '1: P2P uses Users icon (peer-sourced)');
  ok(component.includes('Magnet'), '1: Magnet uses Magnet icon');
  // Quality badge with color coding via existing tokens (no neon).
  ok(component.includes('function qualityBadgeClass'), '1: qualityBadgeClass helper exists');
  ok(component.includes('mad-badge-quality'), '1: quality badge class exists');
  ok(component.includes('mad-badge-4k'), '1: 4K quality badge modifier exists');
  ok(component.includes('mad-badge-1080'), '1: 1080p quality badge modifier exists');
  ok(component.includes('mad-badge-720'), '1: 720p quality badge modifier exists');
  ok(component.includes('mad-badge-480'), '1: 480p quality badge modifier exists');
  ok(component.includes('mad-badge-auto'), '1: auto quality badge modifier exists');
  // Codec + container badges.
  ok(component.includes('mad-badge-codec'), '1: codec badge exists');
  ok(component.includes('mad-badge-container'), '1: container badge exists');
  // Audio badge with Volume2 icon + Multi/Dual/language label.
  ok(component.includes('mad-badge-audio'), '1: audio badge exists');
  ok(component.includes('Volume2'), '1: Volume2 icon used for audio badge');
  ok(component.includes('function audioLabel'), '1: audioLabel helper exists (Multi/Dual/language)');
  ok(component.includes("'Multi'"), '1: audioLabel handles Multi');
  ok(component.includes("'Dual'"), '1: audioLabel handles Dual');
  // Size badge with HardDrive icon.
  ok(component.includes('mad-badge-size'), '1: size badge exists');
  ok(component.includes('HardDrive'), '1: HardDrive icon used for size badge');
  // Host badge with Server icon — the §B2 "hosting/server identity where useful" requirement.
  ok(component.includes('mad-badge-host'), '1: host badge exists');
  ok(component.includes('Server'), '1: Server icon used for host badge');
  // The card markup renders ALL the badges.
  ok(component.includes('mad-row-badges'), '1: mad-row-badges container exists in the markup');
  ok(component.includes('qualityBadgeClass(stream.quality)'), '1: the quality badge is rendered for each stream');
  ok(component.includes('stream.codec && stream.codec !== \'unknown\''), '1: codec badge is conditional on codec being known');
  ok(component.includes('stream.container'), '1: container badge is conditional on container being supplied');
  ok(component.includes('audioLabel(stream)'), '1: audio badge is conditional on audioLabel returning a value');
  ok(component.includes('formatSize(stream.sizeBytes)'), '1: size badge is conditional on formatSize returning a value');
  ok(component.includes('stream.host'), '1: host badge is conditional on stream.host being supplied');
  // Kind icon is rendered as a component (Svelte {@const KindIcon = kindIcon(stream.kind)} pattern).
  ok(component.includes('{@const KindIcon = kindIcon(stream.kind)}'), '1: KindIcon is bound per-stream via @const');
  ok(component.includes('<KindIcon size={13}'), '1: KindIcon component is rendered with size=13');
  // The header row has the kind icon + the filename/title (the primary scannable identity).
  ok(component.includes('mad-row-header'), '1: mad-row-header container exists (kind icon + filename/title)');
  ok(component.includes('mad-kind'), '1: mad-kind icon container exists');
}

// ---------------------------------------------------------------------------
// §B2.2 — Existing design tokens are used (no new color system)
// ---------------------------------------------------------------------------

function section2_designTokens(): void {
  const component = read('src/lib/components/MaveroAddonDownload.svelte');
  // The new badge styles use ONLY existing Mavero design tokens.
  ok(component.includes('var(--ink)'), '2: --ink token used');
  ok(component.includes('var(--ink-soft)'), '2: --ink-soft token used');
  ok(component.includes('var(--muted)'), '2: --muted token used');
  ok(component.includes('var(--accent)'), '2: --accent token used');
  ok(component.includes('var(--accent-soft)'), '2: --accent-soft token used');
  ok(component.includes('var(--line)'), '2: --line token used');
  ok(component.includes('var(--line-strong)'), '2: --line-strong token used');
  ok(component.includes('var(--radius-sm)'), '2: --radius-sm token used');
  // No neon / glow / hex colors introduced for badges (the only hex colors
  // are the pre-existing #d48a64 failure tones from Phase 18).
  const badgeBlock = component.split('.mad-badge')[1]?.split('/*')[0] ?? '';
  ok(!badgeBlock.includes('neon'), '2: NO neon keyword in badge styles');
  ok(!badgeBlock.includes('glow'), '2: NO glow keyword in badge styles');
  ok(!badgeBlock.includes('box-shadow'), '2: NO box-shadow on badges (no glow)');
  ok(!badgeBlock.includes('text-shadow'), '2: NO text-shadow on badges');
}

// ---------------------------------------------------------------------------
// §B2.3 — Responsive behavior — badges wrap on small screens
// ---------------------------------------------------------------------------

function section3_responsive(): void {
  const component = read('src/lib/components/MaveroAddonDownload.svelte');
  // Badges row uses flex-wrap so a stream with many metadata badges never
  // overflows horizontally — the Share button stays pinned on the right.
  ok(component.includes('.mad-row-badges { display: flex; flex-wrap: wrap'), '3: mad-row-badges uses flex-wrap: wrap');
  // Host badge has a max-width + ellipsis so a very long hostname doesn't
  // push everything else off the row.
  ok(component.includes('.mad-badge-host { color: var(--muted); max-width: 140px'), '3: mad-badge-host has max-width + ellipsis');
  // On very narrow viewports (≤ 360px), the host badge drops off FIRST so
  // the more important quality/codec/size metadata stays visible.
  ok(component.includes('@media (max-width: 360px) { .mad-badge-host { display: none; } }'), '3: host badge hidden on ≤ 360px viewports (graceful degradation)');
  // The row keeps the existing Phase 18 border + bg contract (.mad-row,
  // .mad-action, .mad-action-share — preserved).
  ok(component.includes('.mad-row {'), '3: .mad-row CSS rule preserved');
  ok(component.includes('.mad-action {'), '3: .mad-action CSS rule preserved');
  ok(component.includes('.mad-action-share {'), '3: .mad-action-share CSS rule preserved');
}

// ---------------------------------------------------------------------------
// §B2.4 — Keyboard accessibility + visible focus states
// ---------------------------------------------------------------------------

function section4_a11yFocus(): void {
  const component = read('src/lib/components/MaveroAddonDownload.svelte');
  // The Share button keeps its accessible label (Phase 18 contract preserved).
  ok(component.includes('aria-label={shareKey === key && shareState === \'shared\''), '4: Share button aria-label preserved');
  ok(component.includes('title="Share (original URI)"'), '4: Share button title preserved');
  // The Share button keeps visible focus state via :focus-visible.
  ok(component.includes('.mad-action:focus-visible'), '4: .mad-action:focus-visible rule exists (visible keyboard focus)');
  // The row itself gains a focus-within state so keyboard users see the
  // row is "active" when the Share button inside it is focused.
  ok(component.includes('.mad-row:focus-within { border-color: var(--accent); }'), '4: .mad-row:focus-within rule exists (row highlights when Share is focused)');
  // The article element has role=listitem (list semantics preserved).
  ok(component.includes('role="listitem"'), '4: article role=listitem preserved');
  ok(component.includes('aria-label={streamLabel(stream)}'), '4: article carries an aria-label derived from streamLabel (full metadata for screen readers)');
  // Icons inside badges are aria-hidden (decorative — the text label carries the meaning).
  ok(component.includes('aria-hidden="true"'), '4: decorative icons are aria-hidden (screen readers skip them)');
  // Badges with icons also carry a title attribute (tooltip for sighted users + a11y fallback).
  ok(component.includes('title={stream.audioLanguages?.length ? `Audio:'), '4: audio badge has a title attribute');
  ok(component.includes('title="File size"'), '4: size badge has a title attribute');
  ok(component.includes('title={`Hosting server: ${stream.host}`}'), '4: host badge has a title attribute');
}

// ---------------------------------------------------------------------------
// §B2.5 — Existing actions preserved (Phase 18 contract — Share only)
// ---------------------------------------------------------------------------

function section5_actionsPreserved(): void {
  const component = read('src/lib/components/MaveroAddonDownload.svelte');
  // Share action is preserved (the ONLY action on the card).
  ok(component.includes('class="mad-action mad-action-share"'), '5: Share button keeps mad-action mad-action-share class');
  ok(component.includes('handleShare'), '5: handleShare function preserved');
  ok(component.includes('await navigator.share('), '5: navigator.share is awaited');
  ok(component.includes('typeof navigator.share === \'function\''), '5: navigator.share is feature-detected');
  ok(component.includes('url = stream.url'), '5: Share handler binds url = stream.url (the EXACT ORIGINAL URI)');
  ok(component.includes('title: shareTitle('), '5: navigator.share receives a title from shareTitle()');
  ok(component.includes('function legacyCopy'), '5: legacyCopy clipboard fallback preserved');
  ok(component.includes("execCommand('copy')"), '5: execCommand fallback preserved');
  // NO Download/Play/Copy actions reintroduced (Phase 18 boundary preserved).
  ok(!component.includes('downloadAttributesFor'), '5: NO downloadAttributesFor (Download not reintroduced)');
  ok(!component.includes('handleDownload'), '5: NO handleDownload (Download not reintroduced)');
  ok(!component.includes('openingKey'), '5: NO openingKey state (Download not reintroduced)');
  ok(!component.includes('copyStreamUrl'), '5: NO copyStreamUrl (Copy not reintroduced)');
  ok(!component.includes('handleCopy'), '5: NO handleCopy (Copy not reintroduced)');
  ok(!component.includes('Play size='), '5: NO Play icon (Play not reintroduced)');
  ok(!component.includes('mad-action-play'), '5: NO mad-action-play class (Play not reintroduced)');
  // The Share button is the ONLY mad-action button in the row (Phase 18 contract).
  const rowMatch = component.match(/<article class="mad-row"[^>]*>([\s\S]*?)<\/article>/);
  if (rowMatch) {
    const rowBlock = rowMatch[1];
    const shareButtons = (rowBlock.match(/<button[^>]*class="mad-action mad-action-share"/g) ?? []).length;
    const allActions = (rowBlock.match(/class="mad-action(?:\s|")/g) ?? []).length;
    ok(shareButtons === 1, `5: exactly ONE Share button in the row (got ${shareButtons})`);
    ok(allActions === 1, `5: exactly ONE mad-action element total in the row (got ${allActions}) — no other actions`);
  }
}

// ---------------------------------------------------------------------------
// §B2.6 — Reduced-motion compatibility
// ---------------------------------------------------------------------------

function section6_reducedMotion(): void {
  const component = read('src/lib/components/MaveroAddonDownload.svelte');
  // The reduced-motion media query disables both spin animations AND the
  // new row transition (Phase B added .mad-row transition — must be in the
  // reduced-motion opt-out).
  ok(component.includes('@media (prefers-reduced-motion: reduce)'), '6: prefers-reduced-motion media query exists');
  ok(component.includes('animation: none'), '6: spin animations disabled under reduced-motion');
  // The reduced-motion block lists .mad-row in the transition opt-out so
  // the Phase B row hover/focus transition is also disabled.
  ok(component.includes('.mad-row { transition: none; }'), '6: .mad-row transition disabled under reduced-motion (Phase B addition)');
  ok(component.includes('.mad-action { transition: none; }') || component.includes('.mad-action,'), '6: .mad-action transition disabled under reduced-motion (Phase 18 preserved)');
}

// ---------------------------------------------------------------------------
// §B2.7 — TV / large-screen usability — badges don't shrink on wide viewports
// ---------------------------------------------------------------------------

function section7_tvUsability(): void {
  const component = read('src/lib/components/MaveroAddonDownload.svelte');
  // The card uses flex layout — on wide viewports (TV), the row stretches
  // to fill the available width and the badges row stays left-aligned with
  // the Share button pinned on the right. NO max-width on the row itself.
  ok(!/.mad-row\s*\{[^}]*max-width/.test(component), '7: NO max-width on .mad-row (stretches to fill on wide viewports)');
  // The list itself uses flex-direction: column so rows stack vertically
  // (full-width on TV, not constrained to a narrow column).
  ok(component.includes('.mad-list { display: flex; flex-direction: column'), '7: .mad-list is a column flex (rows stack full-width)');
  // Touch target — the Share button is 30×30 (Phase 18 contract preserved).
  ok(component.includes('width: 30px; height: 30px;'), '7: Share button touch target is 30×30 (preserved from Phase 18)');
}

// ---------------------------------------------------------------------------
// §B2.8 — Stream-view type carries the host field (server-side plumbing)
// ---------------------------------------------------------------------------

function section8_hostField(): void {
  const component = read('src/lib/components/MaveroAddonDownload.svelte');
  // The client-side StreamView type declares the optional host field.
  ok(component.includes('host?: string;'), '8: StreamView.host field declared on the client');
  // The host badge is rendered with the Server icon when host is present.
  ok(component.includes('{#if stream.host}'), '8: host badge is conditionally rendered when stream.host is present');
  // The host is used in a title attribute for tooltip + a11y.
  ok(component.includes('title={`Hosting server: ${stream.host}`}'), '8: host badge title attribute carries the hostname');
}

// ---------------------------------------------------------------------------
// §B2.9 — Subtitle badge (Phase B compliance audit point 1)
// The subtitle data IS available in the raw Stremio response (`record.subtitles`)
// AND in the player normalizer's existing model. Phase B must surface it.
// ---------------------------------------------------------------------------

function section9_subtitleBadge(): void {
  const component = read('src/lib/components/MaveroAddonDownload.svelte');
  // The Captions icon is imported (lucide-svelte).
  ok(component.includes('Captions'), '9: Captions icon imported for subtitle badge');
  // The StreamView type carries the subtitles field.
  ok(component.includes('subtitles?:'), '9: StreamView.subtitles field declared on the client');
  // The subtitle badge is conditional on stream.subtitles?.length.
  ok(component.includes('{#if stream.subtitles?.length}'), '9: subtitle badge is conditional on stream.subtitles?.length');
  ok(component.includes('mad-badge-subtitles'), '9: mad-badge-subtitles CSS class exists');
  // The badge shows the track count.
  ok(component.includes('{stream.subtitles.length}'), '9: subtitle badge shows the track count');
  // The badge has a title attribute for tooltip + a11y.
  ok(component.includes('title={`Subtitles:'), '9: subtitle badge has a title attribute');
  // The Captions icon is aria-hidden (decorative).
  ok(component.includes('<Captions size={10} aria-hidden="true"'), '9: Captions icon is aria-hidden (decorative)');
  // CSS for the subtitle badge uses existing tokens (no new color system).
  ok(component.includes('.mad-badge-subtitles { color: var(--ink-soft); }'), '9: subtitle badge uses --ink-soft token');
}

// ---------------------------------------------------------------------------
// runner
// ---------------------------------------------------------------------------

section1_structuredBadges();
section2_designTokens();
section3_responsive();
section4_a11yFocus();
section5_actionsPreserved();
section6_reducedMotion();
section7_tvUsability();
section8_hostField();
section9_subtitleBadge();

console.log(`stremio_downloader_phaseB_card_test: ${passed} checks passed (Phase B §B2: structured card UX — kind/quality/codec/container/audio/size/host/subtitles badges + design tokens + responsive + a11y + focus + reduced-motion + TV usability + Share action preserved)`);
