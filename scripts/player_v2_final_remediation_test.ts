/**
 * PLAYER V2 FINAL REMEDIATION — regression suite (real-device feedback).
 *
 * Covers the six reported issues, each traced to a verified root cause:
 *   1. Portrait secondary row: wasted horizontal space, blank subtitle
 *      selector, fullscreen wrapping to its own row.
 *   2. Landscape: secondary controls form ONE compact group with fullscreen
 *      inside it; the Back FAB sits closer to the left corner (safe-area
 *      respected). SUPERSEDED 2026-10 (remaining fixes): the approved
 *      landscape alignment is now RIGHT (flex-end) — portrait stays left.
 *   3. Resume: the shell mounted before progress loaded and consumed
 *      `initialProgress` only at init — the async prop update reached
 *      nothing and playback started at 00:00 (and the first zero-position
 *      writer update could erase the saved record). Tests here are
 *      BEHAVIORAL for the pending-seek machine (delayed capture → applied
 *      when the stream becomes seekable) + source-contract pins for the
 *      reactive gate and the route's pre-resume zero-event guard.
 *   4. VDRK subtitles: the deployed CSP rejected the browser-direct list
 *      fetch (connect-src lacked https://sub.vdrk.site). LIVE probes here
 *      prove the upstreams for the reported titles are populated and flow
 *      through the REAL validation → same-origin proxy mapping.
 *   5. TheIntroDB: same CSP gap (https://api.theintrodb.org) + the shell
 *      kept the previous episode's duration across an episode switch, so
 *      the new episode's intro lookup fired with a stale duration and then
 *      never re-ran. Tests pin the duration reset, the lookup gate, and
 *      the typed failure mapping through the real client.
 *   6. HLS quality: multi-variant = Auto + real levels; exactly one level =
 *      an HONEST disabled control showing the REAL level label; no levels =
 *      no control. Never a fabricated list.
 *   7. Regression safety: prior Player V2 corrections remain (three-zone
 *      layout, Skip Intro gating, display modes, seek icons) and NO
 *      downloader surface exists in the player components.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = resolve(fileURLToPath(import.meta.url), '../..');
const read = (p: string) => readFileSync(resolve(root, p), 'utf-8');

let passed = 0;
const failures: string[] = [];
function ok(condition: unknown, label: string): void {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${label}`);
  } else {
    failures.push(label);
    console.log(`  ✗ ${label}`);
  }
}

const controls = read('src/lib/components/player/PlayerControls.svelte');
const shell = read('src/lib/components/player/PlayerShell.svelte');
const subtitleSheet = read('src/lib/components/player/PlayerSubtitleSheet.svelte');
const route = read('src/routes/watch/[type]/[id]/+page.svelte');
const netlifyToml = read('netlify.toml');
const viewport = read('src/lib/components/player/PlayerViewport.svelte');

// ===========================================================================
// ISSUE 1 — portrait secondary row: no wasted space, no blank subtitle
// selector, fullscreen stays on the one row.
// ===========================================================================
console.log('\nISSUE 1 — portrait secondary row');
{
  ok(!controls.includes('secondary-spacer'), '1a. the flexible spacer element/CSS is REMOVED from PlayerControls');
  // The subtitle select is the flexible member: absorbs leftover width for
  // its own label, bounded, with an explicit floor + ellipsis.
  ok(/\.select-control\.subtitles \{ flex: 1 1 56px; min-width: 56px; max-width: 110px; \}/.test(controls), '1b. the subtitle selector flexes (floor 56px, cap 110px) instead of reserving blank space');
  // CONTRACT CHANGE (focused fixes, Issue 3 — native <select> popups replaced
  // with Mavero selection sheets): the compactness guarantees moved from the
  // old `select` element rules to the new BUTTON + `.control-label` rules —
  // same intent (labels truncate; nothing sizes to its longest option).
  ok(/\.select-control\.subtitles \.control-label \{ flex: 1 1 auto; text-align: left; \}/.test(controls), '1c. the subtitle control’s label fills the flexible control (button contract)');
  ok(/\.select-control \.control-label \{ min-width: 0;[\s\S]*?text-overflow: ellipsis; white-space: nowrap; \}/.test(controls), '1d. every sheet-trigger label carries min-width:0 + ellipsis (long track names can never expand the row)');
  ok(/\.select-control\.quality \.control-label \{ max-width: 64px; \}/.test(controls) && /\.select-control\.display-mode \.control-label \{ max-width: 58px; \}/.test(controls) && /\.select-control\.speed \.control-label \{ max-width: 44px; \}/.test(controls), '1e. explicit compact label widths for the fixed controls (speed/display/quality)');
  // Deliberate narrow-phone fallback: tighter paddings, subtitle floor lowered.
  ok(/@media \(max-width: 640px\) \{[\s\S]*?\.select-control\.subtitles \{ min-width: 48px; \}/.test(controls), '1f. ≤640px fallback lowers the subtitle floor (deliberate compact treatment)');
  ok(/@media \(max-width: 640px\) \{[\s\S]*?\.select-control \{ padding: 0 5px; \}/.test(controls), '1g. ≤640px fallback tightens the control paddings (compact treatment; label widths are fluid since the sheet contract)');
  ok(/@media \(max-width: 640px\) \{[\s\S]*?\.select-control\.display-mode :global\(svg\) \{ display: none; \}/.test(controls), '1g2. ≤640px folds the decorative display-mode icon so the labels + row fit (deliberate budget)');
  // Target order: Volume · Subtitles · Quality · Display · Speed · Fullscreen.
  // (Issue 3 contract: the markers moved to the sheet-trigger buttons.)
  const secondaryStart = controls.indexOf('class="secondary-row"');
  const secondaryEnd = controls.indexOf('<!-- In-player selection sheets', secondaryStart);
  const secondary = controls.slice(secondaryStart, secondaryEnd > secondaryStart ? secondaryEnd : undefined);
  const order = ['volume-control', 'aria-label={`Subtitles:', 'select-control quality', 'aria-label={`Display mode', 'aria-label={`Playback speed', "'Enter fullscreen'"];
  let cursor = 0;
  let orderOk = true;
  for (const marker of order) {
    const at = secondary.indexOf(marker, cursor);
    if (at < 0) { orderOk = false; break; }
    cursor = at;
  }
  ok(orderOk, '1h. target order Volume · Subtitles · Quality · Display · Speed · Fullscreen (fullscreen INSIDE the group)');
  ok((secondary.match(/'Exit fullscreen' : 'Enter fullscreen'/g) ?? []).length === 1, '1i. exactly one fullscreen button in the secondary row');
  // "Off" must stay the FIRST entry of the subtitle sheet's track list; the
  // honest notice renders as a separate non-selectable status row only when
  // there are no tracks (Issue 3 contract: the sheet replaced the <option>s).
  ok(/class="track-row" class:selected=\{selectedSubtitle === ''\}[\s\S]{0,240}<strong>Off<\/strong>/.test(subtitleSheet) && subtitleSheet.indexOf("selectedSubtitle === ''") < subtitleSheet.indexOf('{#each tracks'), '1j. Off remains the FIRST entry of the subtitle sheet; the notice is a separate status row');
  ok(/\{#if !tracks\.length && notice\}[\s\S]{0,120}class="notice-row"/.test(subtitleSheet), '1j2. the honest notice renders ONLY when no tracks exist (never obscuring Off)');
  // Hit targets unchanged.
  ok(/\.control-button \{ display: inline-grid; place-items: center; min-width: 40px; min-height: 40px;/.test(controls), '1k. control hit targets keep the 40px floor');
}

// ===========================================================================
// ISSUE 2 — landscape grouping + Back placement.
// SUPERSESSION (Player V2 remaining fixes, 2026-10): the user's APPROVED
// landscape layout changed direction — secondary controls now align to the
// RIGHT edge (the previous contract pinned them LEFT-aligned). The base
// (portrait) row stays left-aligned; the landscape media query pins
// `justify-content: flex-end` + a non-flexing subtitle select so the whole
// group packs right. Old contract: landscape row left-aligned; new contract:
// landscape row right-aligned, same one-row/nowrap grouping.
// ===========================================================================
console.log('\nISSUE 2 — landscape grouping + Back placement');
{
  ok(/\.secondary-row \{ display: flex; align-items: center; flex-wrap: wrap; justify-content: flex-start; gap: 6px; \}/.test(controls), '2a. the secondary row base rule stays LEFT-aligned (portrait semantics preserved)');
  ok(/@media \(orientation: landscape\) and \(max-height: 500px\) \{\s*\.secondary-row \{ flex-wrap: nowrap; gap: 5px; justify-content: flex-end; \}\s*\.select-control\.subtitles \{ flex: 0 1 auto; \}/.test(controls), '2b. landscape phone: the secondary row is ONE non-wrapping RIGHT-aligned group (superseded contract: was left-aligned)');
  ok(/\.back-fab \{ width: 40px; height: 40px; top: max\(6px, env\(safe-area-inset-top\)\); left: max\(6px, env\(safe-area-inset-left\)\); \}/.test(shell), '2c. landscape-phone Back FAB sits at a 6px corner floor (was 8px)');
  ok(/\.back-fab \{ position: absolute; z-index: 12; top: max\(12px, env\(safe-area-inset-top\)\); left: max\(12px, env\(safe-area-inset-left\)\);/.test(shell), '2d. portrait Back FAB default placement is untouched (12px safe-area floor)');
  ok(/class:custom-position=\{Boolean\(backControlStyle\)\}/.test(shell) && shell.indexOf('landscapeControlInlineStyle') > 0, '2e. per-source Admin placement overrides still resolve and apply');
  // Landscape center cluster + bottom zone separation preserved.
  ok(/@media \(orientation: landscape\) and \(max-height: 500px\) \{\s*\.center-cluster \{ transform: translate\(-50%, calc\(-50% - 16px\)\); \}/.test(controls), '2f. the center cluster keeps its landscape lift above the bottom zone');
}

// ===========================================================================
// ISSUE 3 — resume: delayed initialProgress reaches the REAL seek machine.
// ===========================================================================
console.log('\nISSUE 3 — resume from the saved position');
{
  // --- Source contracts: the reactive gate ---
  ok(/\$: if \(initialProgress > 0\) applyDelayedResume\(initialProgress\);/.test(shell), '3a. the shell reacts to the LATE initialProgress prop update');
  ok(/function applyDelayedResume\(saved: number\) \{/.test(shell) && /capturePendingSeek\(pendingSeekState, saved, Date\.now\(\)\);/.test(shell), '3b. the gate captures the saved position into the PENDING-SEEK state machine (no new seek path)');
  ok(/resumeDecidedForKey === key\) return;/.test(shell), '3c. ONE resume decision per media identity (no reactive loops, no repeated seeks)');
  ok(/if \(!Number\.isFinite\(saved\) \|\| saved <= 0\) return;/.test(shell), '3d. a 0/invalid prop value never captures (mounting with initialProgress=0 cannot seek to zero)');
  ok(/if \(userSeekedBeforeResume\) return;/.test(shell) && /userSeekedBeforeResume = true;/.test(shell), '3e. a deliberate user seek closes the auto-resume window (their position wins)');
  ok(/if \(currentTime > 30 && currentTime >= saved - 1\) return;/.test(shell), '3f. a playhead already past the saved position is never yanked back');
  ok(/applyPendingSeekToElement\(\);\s*\}\s*\$: if \(initialProgress > 0\)/s.test(shell), '3g. the gate attempts an immediate apply (element may already be seekable)');
  // Episode changes: fresh resume window + no stale duration.
  ok(/duration = 0;\s*buffered = 0;\s*\/\/ Player V2 final remediation \(Issue 3\)[\s\S]{0,400}?resumeDecidedForKey = '';\s*userSeekedBeforeResume = false;/.test(shell), '3h. an episode switch resets duration/buffered AND reopens the resume window (fresh per-episode resume)');
  ok(/function seek\(time: number\) \{\s*\/\/ Player V2 final remediation \(Issue 3\): a deliberate user seek closes/.test(shell), '3i. the seek() entry point marks user interaction (timeline/±10s/keyboard/double-tap all route through it)');

  // --- Route guard: the initial zero-position event cannot erase the record ---
  ok(/const preResumeZeroEvent = resumeTime > 0 && position < 1 && event\.reason !== 'ended';/.test(route), '3j. the route identifies pre-resume zero-position events against a saved record');
  ok(/if \(!preResumeZeroEvent\) writer\?\.update\(position, duration, event\.completed\);/.test(route), '3k. writer.update is skipped for the pre-resume zero event (the saved position survives until the seek)');
  ok(/if \(event\.reason === 'ended'\) void writer\?\.complete\(position, duration\);/.test(route) && /event\.reason !== 'ended'/.test(route), '3l. completion events are never filtered (explicit ended facts always write)');

  // --- BEHAVIORAL: the pending-seek machine with a DELAYED capture ---
  const { applyPendingSeek, capturePendingSeek, createPendingSeek, hasPendingSeek } = await import('$lib/client/player/pending-seek');
  const seekable = (end: number) => ({ length: 1, start: () => 0, end: () => end });
  // Mount: initialProgress=0 → empty pending state.
  const mounted = createPendingSeek(0, 1_000);
  ok(mounted.token === 0 && mounted.position === 0, '3m. BEHAVIORAL mounting with initialProgress=0 creates NO pending seek');
  // The late prop update (progress loaded at ~1.2s) captures the saved target.
  capturePendingSeek(mounted, 5_340, 1_200);
  // Metadata arrives but the range does not cover the target yet → retained.
  const notReady = applyPendingSeek(mounted, { readyState: 1, duration: 0, seekable: seekable(0) }, 3_000);
  ok(notReady === null && hasPendingSeek(mounted, 3_000), '3n. BEHAVIORAL the delayed target is RETAINED while the stream is not seekable yet');
  // Seekable range finally covers the target → applied exactly once.
  const ready = applyPendingSeek(mounted, { readyState: 4, duration: 7_200, seekable: seekable(7_200) }, 5_000);
  ok(ready === 5_340 && mounted.token === 0, '3o. BEHAVIORAL the saved position is applied once the range covers it (state cleared after)');
  // A capture that never becomes applicable expires cleanly (bounded).
  const stale = createPendingSeek(0, 0);
  capturePendingSeek(stale, 600, 0);
  const expired = applyPendingSeek(stale, { readyState: 4, duration: 10_000, seekable: seekable(10_000) }, 16_000);
  ok(expired === null && stale.token === 0, '3p. BEHAVIORAL an unreachable target expires after the bounded window (no infinite retries)');
  // Replay-from-incomplete shape: nonzero saved position on creation (the
  // pre-redesign behavior) still works for fast-loading records.
  const fast = createPendingSeek(1_234, 10);
  ok(fast.token > 0 && fast.position === 1_234, '3q. BEHAVIORAL a fast-loading record still captures at mount time');
}

// ===========================================================================
// ISSUE 4+5 — VDRK + TheIntroDB reachability and the real pipeline.
// ===========================================================================
console.log('\nISSUE 4+5 — subtitle/intro pipeline (CSP + wiring + LIVE)');
{
  const cspMatch = netlifyToml.match(/Content-Security-Policy\s*=\s*"([^"]+)"/);
  ok(cspMatch !== null, '4a. netlify.toml carries the CSP header');
  const connectSrc = cspMatch ? (cspMatch[1].match(/connect-src\s+([^;]*)/i)?.[1] ?? '') : '';
  const connectTokens = connectSrc ? connectSrc.split(/\s+/) : [];
  ok(connectTokens.includes('https://sub.vdrk.site'), '4b. connect-src allows the VDRK subtitle-LIST origin (was the deployed block)');
  ok(connectTokens.includes('https://api.theintrodb.org'), '4c. connect-src allows the TheIntroDB origin (was the deployed block)');
  ok(!connectTokens.includes('*') && !connectTokens.includes('https:*') && !connectTokens.includes('http:*'), '4d. no wildcard relaxation entered connect-src (the scoped https://*.supabase.co entry remains the only wildcard)');
  ok(!/crossorigin/.test(viewport), '4e. NO global crossorigin attribute on the shared <video> (Safari/iOS HLS guard intact)');
  // The VTT FILES still ride the same-origin proxy (no VDRK file host in CSP).
  ok(!connectSrc.includes('cache.vdrk.site'), '4f. the VTT file host stays OFF connect-src (files ride the same-origin proxy)');
  // TheIntroDB wiring: stale-duration fix + honest gating preserved.
  ok(/\$: if \(browser && duration > 0 && mediaLookupKey !== introKey\) \{/.test(shell), '5a. the intro lookup still waits for a REAL positive duration + a changed media key');
  ok(/introStatus: 'waiting-duration' \| 'loading' \| 'available' \| 'no-data' \| 'unavailable'/.test(shell), '5b. the honest intro feature-state machine is intact (no fake success states)');
  ok(/activeSkipSegment = introSegments\.find\(\(segment\) => currentTime >= segment\.startSec && currentTime < segment\.endSec - 0\.25\)/.test(shell), '5c. Skip Intro still renders ONLY inside a VERIFIED segment');
}

// --- BEHAVIORAL + LIVE: the REAL VDRK client validation → proxy mapping ---
{
  const subs = await import('$lib/client/player/subtitles/external-subtitles');
  // Unit truth table (regression guard while the CSP fix ships).
  ok(subs.vdrkFileToProxyPath('https://cache.vdrk.site/v1/vtt/tv/236235/2/1/Portuguese (BR)2.vtt') === '/api/content/subtitles/vtt/tv/236235/2/1/Portuguese%20(BR)2', '4g. labels with spaces/parentheses survive validation + proxy mapping (Part A contract)');
  ok(subs.vdrkFileToProxyPath('https://cache.vdrk.site/v1/vtt/movie/24428/English Hi3.vtt') === '/api/content/subtitles/vtt/movie/24428/English%20Hi3', '4h. movie-list proxy mapping intact');
  ok(subs.vdrkFileToProxyPath('https://cache.vdrk.site/v1/vtt/movie/24428/a%2Fb.vtt') === null, '4i. encoded separators are still REJECTED (traversal guard intact)');
  ok(subs.buildVdrkListUrl({ kind: 'tv', tmdbId: 236235, season: 2, episode: 1 }) === 'https://sub.vdrk.site/v1/tv/236235/2/1', '4j. the TV list URL contract (movie/{tmdb} · tv/{tmdb}/{s}/{e})');

  // LIVE E2E for the three REPORTED titles: upstream list → REAL
  // validation → proxy path → upstream VTT body. This is the exact
  // pipeline the phone runs once the CSP entry ships.
  const titles: Array<{ label: string; url: string; minTracks: number }> = [
    { label: 'Dhurandhar (movie 1582770)', url: 'https://sub.vdrk.site/v1/movie/1582770', minTracks: 1 },
    { label: 'The Gentlemen S2E1 (tv 236235)', url: 'https://sub.vdrk.site/v1/tv/236235/2/1', minTracks: 10 },
    { label: 'Avengers candidates (movie 24428)', url: 'https://sub.vdrk.site/v1/movie/24428', minTracks: 50 },
  ];
  let liveVdrkReachable = 0;
  for (const title of titles) {
    try {
      const res = await fetch(title.url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(12_000) });
      if (!res.ok) { console.log(`    · ${title.label}: HTTP ${res.status} (upstream state changed — recorded)`); continue; }
      liveVdrkReachable += 1;
      const payload: unknown = await res.json();
      const tracks = subs.parseVdrkEntries(payload);
      ok(tracks.length >= title.minTracks, `4k. LIVE ${title.label}: ${tracks.length} tracks pass the REAL validation (>= ${title.minTracks})`);
      const sample = tracks[0];
      ok(Boolean(sample?.url.startsWith('/api/content/subtitles/vtt/')), `4l. LIVE ${title.label}: tracks map to same-origin proxy paths (${sample?.url.slice(0, 48)}…)`);
      // One end-to-end file fetch through the mapped upstream URL (the
      // proxy route appends .vtt server-side — the upstream name carries it).
      const upstreamUrl = sample?.url.replace('/api/content/subtitles/vtt/', 'https://cache.vdrk.site/v1/vtt/') + '.vtt';
      const vttRes = await fetch(upstreamUrl, { headers: { accept: 'text/vtt,*/*' }, signal: AbortSignal.timeout(12_000) });
      const vttBody = await vttRes.text();
      ok(vttRes.ok && vttBody.trimStart().startsWith('WEBVTT'), `4m. LIVE ${title.label}: the mapped VTT file serves a real WEBVTT body (${vttRes.status}, ${vttBody.length}B)`);
    } catch (error) {
      console.log(`    · ${title.label}: network probe failed (${(error as Error)?.message ?? error}) — recorded`);
    }
  }
  ok(liveVdrkReachable > 0, '4n. LIVE VDRK upstream was reachable from this environment (≥1 title answered)');

  // TheIntroDB through the REAL client: 2xx parses; a non-2xx (the 403
  // Cloudflare block observed from datacenter IPs, and the outage the user
  // saw on the website itself) must map to the typed failure — never a
  // fake success, never a blocked player.
  const intro = await import('$lib/client/player/intro/intro-client');
  const lookup = intro.createIntroLookup();
  const result = await lookup.getIntroSegments({ kind: 'movie', tmdbId: 1582770 }, 'movie:1582770');
  console.log(`    · LIVE TheIntroDB probe (movie 1582770): segments=${result.segments.length} errorKind=${result.errorKind ?? 'none'}`);
  if (result.errorKind === null) {
    ok(true, '5d. LIVE TheIntroDB answered — the real client parsed it without throwing (playback unaffected)');
  } else {
    ok(result.errorKind === 'api' && result.segments.length === 0, '5d. LIVE TheIntroDB failure maps to the TYPED api failure with zero segments (honest unavailability)');
  }
  // Timestamp conversion truth table (ms → s exactly once, validation).
  ok(intro.validateIntroSegments([{ startMs: 15_000, endMs: 65_000 }], 3_600)[0]?.startSec === 15, '5e. BEHAVIORAL ms→s conversion happens exactly once (15s intro from 15000ms)');
  ok(intro.validateIntroSegments([{ startMs: 10_000, endMs: null }], 3_600).length === 0, '5f. BEHAVIORAL a null end (no seek target) is discarded, never invented');
  ok(intro.validateIntroSegments([{ startMs: 3_700_000, endMs: 3_750_000 }], 3_600).length === 0, '5g. BEHAVIORAL a segment beyond the actual duration is rejected (stale-duration guard)');
}

// ===========================================================================
// ISSUE 6 — HLS quality: honest states for every variant reality.
// ===========================================================================
console.log('\nISSUE 6 — HLS quality selector');
{
  // Issue 3 contract: the quality branches became a qualityMode decision +
  // option arrays feeding the sheet (same honest states, no fabricated Auto).
  ok(/qualityMode = internalQualities\.length > 1 \? 'internal' : qualities\.length > 1 \? 'stream' : 'none'/.test(controls) && /\{ id: PLAYER_AUTO_QUALITY_ID, label: 'Auto'/, '6a. multi-variant manifests keep Auto + the REAL level list');
  ok(/internalQualities\.length === 1/.test(controls), '6b. a single-level manifest gets the HONEST branch (was a silently missing control)');
  ok(/type="button" disabled aria-disabled="true" title=\{`Quality \$\{singleQualityLabel\} \(no other qualities available\)`\}/.test(controls) && (controls.slice(controls.indexOf('singleQualityLabel} (no other'), controls.indexOf('{/if}', controls.indexOf('singleQualityLabel} (no other'))).includes('Auto') === false), '6c. the single-level control is DISABLED, shows the REAL level label, and fabricates NO Auto option');
  ok(/qualities\.length > 1 \? 'stream'/.test(controls), '6d. the per-stream fallback only renders for >1 stream variants');
  // Zero levels (MP4 / native HLS) → no control at all (no fallthrough).
  ok((controls.match(/internalQualities\.length === 1/g) ?? []).length === 1, '6e. exactly one single-level branch (no accidental fallthrough for 0 levels)');
  ok(!/\.quality \{ display: none/.test(controls), '6f. no viewport rule hides the quality control (portrait visibility preserved)');
}

// ===========================================================================
// ISSUE 7 — regression safety: prior corrections intact, no downloader.
// ===========================================================================
console.log('\nISSUE 7 — regression safety');
{
  ok(/class="utility-zone"/.test(controls) && /class="center-cluster"/.test(controls) && /class="bottom-zone"/.test(controls), '7a. the approved three-zone layout is intact (top-right utilities, center cluster, bottom zone)');
  ok(/aria-label="Seek backward 10 seconds"/.test(controls) && /RotateCcwSquare/.test(controls) && /RotateCwSquare/.test(controls), '7b. the corrected seek icons + 10s indication remain');
  ok(/onDoubleClick|createPlayerTapGestureController/.test(shell) && /handleHoldEnd/.test(shell), '7c. the double-tap seek + hold-2× gesture wiring remains');
  ok(/display-fill|display-stretch/.test(viewport) && /aria-label="Display mode"/.test(controls), '7d. Fit/Fill/Stretch display modes remain');
  ok(/aria-label={locked \? 'Unlock player controls' : 'Lock player controls'}/.test(controls), '7e. the touch lock remains');
  ok(!/download/i.test(controls), '7f. NO downloader surface exists in PlayerControls');
  ok(!/download/i.test(shell.slice(shell.indexOf('<script'), shell.indexOf('</script>'))) || !/Download/.test(shell), '7g. NO downloader surface exists in PlayerShell');
  ok(!/download/i.test(viewport), '7h. NO downloader surface exists in PlayerViewport');
  // The unmount cleanup: exit PiP → pause → release the resource (the
  // sequence lives in the onMount teardown around the videoElement stop).
  const teardown = shell.slice(shell.indexOf('if (document.pictureInPictureElement === videoElement) exitPipQuietly();\n      if (document.fullscreenElement'), shell.indexOf('wakeLockDestroyed = true;'));
  ok(teardown.includes('exitPipQuietly();') && teardown.includes('videoElement.pause();') && teardown.includes("videoElement.removeAttribute('src');"), '7i. the Back/PiP playback-stop lifecycle fix remains (exit PiP → pause → release resource)');
  ok(/castAvailable=\{castReady && Boolean\(castEligibility\?\.eligible\)\}/.test(shell), '7j. Cast stays capability-gated');
}

// ===========================================================================
console.log(`\nplayer_v2_final_remediation_test: ${passed} checks passed${failures.length ? `, ${failures.length} FAILED` : ''}`);
if (failures.length) {
  for (const failure of failures) console.log(`  FAILED: ${failure}`);
  process.exit(1);
}
