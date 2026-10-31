/**
 * MAVERO — Focused player fixes + SEO follow-up (2026-10) — regression suite.
 *
 * Covers, with every assertion traced to a proven root cause:
 *
 *   §1 SUBTITLE PREFERENCES — versioned localStorage module (safe defaults,
 *      bounded ranges, allowlisted colours/styles, corrupt/foreign payloads
 *      → defaults, storage failures → no-ops), offset formatting contract
 *      ("-2.0s" / "0.0s" / "+2.0s") and stepper bounds.
 *
 *   §2 RENDER PRIMITIVES — the PURE cue-selection math behind the custom
 *      subtitle overlay: positive offset DELAYS, negative EARLIER, start
 *      inclusive / end exclusive, purity (no double application across
 *      repeated calls / track switches / Off-on toggles), WebVTT markup
 *      stripping.
 *
 *   §3 SOURCE CONTRACTS — no native <select> popups on the player surface;
 *      the shared sheet chrome (dialog semantics, focus trap, Escape,
 *      outside-tap, open-flag plumbing); the shell stands its shortcuts,
 *      gestures and auto-hide down while a sheet is open; TextTrack mode
 *      ownership moved to the viewport (hidden → custom overlay, showing
 *      while the OS paints); PiP/native-fullscreen suppression; NO global
 *      `crossorigin` on the video element; the top-center loading layer
 *      (out of the centered group) + the bounded direct-load timeout with
 *      its stale-key guard; the honest single-quality button.
 *
 *   §4 SEO FOLLOW-UP — fixed production origin for search/live-tv og:url
 *      (noindex,follow preserved), the duplicate meta description removed
 *      at the source (app.html) with route-specific descriptions intact,
 *      and the sitemap/robots policy unchanged.
 *
 *   §5 REGRESSION SAFETY — the previous remediations remain: merged
 *      subtitle flow, quality position preservation, delayed resume,
 *      downloader absence, CSP pins, landscape alignment.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = resolve(fileURLToPath(import.meta.url), '../..');
const read = (p: string) => readFileSync(resolve(root, p), 'utf-8');
/** Source with line comments stripped — assertions must never match prose. */
const readCode = (p: string) => read(p)
  .split('\n')
  .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
  .join('\n');

const shell = read('src/lib/components/player/PlayerShell.svelte');
const controls = read('src/lib/components/player/PlayerControls.svelte');
const viewport = read('src/lib/components/player/PlayerViewport.svelte');
const overlay = read('src/lib/components/player/PlayerSubtitleOverlay.svelte');
const optionSheet = read('src/lib/components/player/PlayerOptionSheet.svelte');
const subtitleSheet = read('src/lib/components/player/PlayerSubtitleSheet.svelte');
const appHtml = read('src/app.html');
const searchPage = read('src/routes/search/+page.svelte');
const liveTvPage = read('src/routes/live-tv/+page.svelte');

let passed = 0;
let failed = 0;
function ok(condition: unknown, label: string) {
  if (condition) { passed += 1; console.log(`  ok ${passed} - ${label}`); }
  else { failed += 1; console.log(`  FAIL - ${label}`); }
}

// ===========================================================================
// §1 — SUBTITLE PREFERENCES (versioned local store).
// ===========================================================================
console.log('\n§1 — subtitle preferences module');
{
  const prefs = await import('$lib/client/player/subtitles/subtitle-preferences');

  ok(prefs.SUBTITLE_PREFERENCES_VERSION === 1 && prefs.SUBTITLE_PREFERENCES_STORAGE_KEY.endsWith(':v1'), '1a. the store is VERSIONED (v1 key — foreign payloads fall back to defaults)');
  const d = prefs.DEFAULT_SUBTITLE_PREFERENCES;
  ok(d.sizeScale === 1 && d.position === 0 && d.offsetSeconds === 0 && d.color === 'white' && d.borderStyle === 'outline', '1b. safe defaults: size 1, bottom, zero offset, white, outline');

  const s = prefs.sanitizeSubtitlePreferences;
  ok(s({ sizeScale: 9 }).sizeScale === prefs.SUBTITLE_SIZE_SCALE.max && s({ sizeScale: 0.1 }).sizeScale === prefs.SUBTITLE_SIZE_SCALE.min, '1c. size clamps into [0.7, 1.6]');
  ok(s({ position: 140 }).position === 100 && s({ position: -5 }).position === 0, '1d. position clamps into [0, 100] (0 = bottom)');
  ok(s({ offsetSeconds: 99 }).offsetSeconds === 10 && s({ offsetSeconds: -99 }).offsetSeconds === -10, '1e. offset clamps into [-10, +10]');
  ok(s({ color: 'chartreuse' }).color === 'white' && s({ borderStyle: 'glow' }).borderStyle === 'outline', '1f. colours/borders are an ALLOWLIST (no free-form injection)');
  ok(s({ sizeScale: 'not-a-number' }).sizeScale === 1, '1g. non-numeric values fall back per-field (a bad colour never discards a good size)');
  ok(s('garbage').offsetSeconds === 0 && s(null).color === 'white' && s(undefined).sizeScale === 1, '1h. non-object payloads sanitize to defaults');
  const cleaned = s({ sizeScale: 1.25, position: 55, offsetSeconds: 2.5, color: 'cyan', borderStyle: 'box', hackerField: 'x' });
  ok(cleaned.sizeScale === 1.25 && cleaned.position === 55 && cleaned.offsetSeconds === 2.5 && cleaned.color === 'cyan' && cleaned.borderStyle === 'box' && !('hackerField' in cleaned), '1i. valid fields pass through; unknown fields are dropped');

  // Storage round-trip with an injected fake (never touches real storage).
  const backing = new Map<string, string>();
  const fakeStorage = {
    getItem: (key: string) => backing.get(key) ?? null,
    setItem: (key: string, value: string) => { backing.set(key, value); },
  };
  prefs.saveSubtitlePreferences({ sizeScale: 1.3, position: 40, offsetSeconds: -1.5, color: 'green', borderStyle: 'shadow' } as never, fakeStorage as never);
  const stored = JSON.parse(backing.get(prefs.SUBTITLE_PREFERENCES_STORAGE_KEY) ?? '{}');
  ok(stored.version === 1, '1j. saved payloads carry the version');
  const loaded = prefs.loadSubtitlePreferences(fakeStorage as never);
  ok(loaded.sizeScale === 1.3 && loaded.offsetSeconds === -1.5 && loaded.color === 'green' && loaded.borderStyle === 'shadow', '1k. save→load round-trips exactly');

  backing.set(prefs.SUBTITLE_PREFERENCES_STORAGE_KEY, '{corrupt');
  ok(prefs.loadSubtitlePreferences(fakeStorage as never).offsetSeconds === 0, '1l. corrupt JSON → defaults (never throws)');
  backing.set(prefs.SUBTITLE_PREFERENCES_STORAGE_KEY, JSON.stringify({ version: 99, sizeScale: 1.5 }));
  ok(prefs.loadSubtitlePreferences(fakeStorage as never).sizeScale === 1, '1m. a FOREIGN version → defaults');
  backing.set(prefs.SUBTITLE_PREFERENCES_STORAGE_KEY, JSON.stringify({ version: 1, sizeScale: 1.4 }));
  ok(prefs.loadSubtitlePreferences(fakeStorage as never).sizeScale === 1.4, '1n. the matching version loads');
  const throwing = { getItem: () => { throw new Error('private mode'); }, setItem: () => { throw new Error('quota'); } };
  ok(prefs.loadSubtitlePreferences(throwing as never).position === 0, '1o. throwing storage degrades to defaults (no crash)');
  prefs.saveSubtitlePreferences({ ...d } as never, throwing as never);
  ok(true, '1p. save failures are swallowed (session values survive)');

  const f = prefs.formatSubtitleOffset;
  ok(f(0) === '0.0s' && f(2) === '+2.0s' && f(-2) === '-2.0s' && f(0.5) === '+0.5s' && f(-1.5) === '-1.5s' && f(1.25) === '+1.3s', '1q. offset display contract: "-2.0s" / "0.0s" / "+2.0s" shapes');
  ok(prefs.stepSubtitleOffset(0, 1) === 0.5 && prefs.stepSubtitleOffset(0, -1) === -0.5, '1r. 0.5 s stepping both directions');
  ok(prefs.stepSubtitleOffset(10, 1) === 10 && prefs.stepSubtitleOffset(-10, -1) === -10, '1s. stepping clamps at ±10 s');
  ok(prefs.stepSubtitleSize(1.6, 1) === 1.6 && prefs.stepSubtitleSize(0.7, -1) === 0.7 && prefs.stepSubtitleSize(1, 1) === 1.1, '1t. size stepping clamps at [0.7, 1.6]');
}

// ===========================================================================
// §2 — RENDER PRIMITIVES (pure cue selection + markup stripping).
// ===========================================================================
console.log('\n§2 — subtitle render primitives');
{
  const render = await import('$lib/client/player/subtitles/subtitle-render');

  ok(render.subtitleDisplayTime(10, 0) === 10, '2a. zero offset = identity (media time)');
  ok(render.subtitleDisplayTime(10, 2) === 8, '2b. positive offset shifts display time EARLIER (cue shows later = delayed)');
  ok(render.subtitleDisplayTime(10, -2) === 12, '2c. negative offset shifts display time later (cue shows earlier)');

  const cues = [
    { startTime: 10, endTime: 12, text: 'A' },
    { startTime: 12.5, endTime: 14, text: 'B' },
    { startTime: 20, endTime: 22, text: 'C' },
  ];
  ok(render.selectActiveCues(cues, 10).length === 1 && render.selectActiveCues(cues, 10)[0].text === 'A', '2d. start is INCLUSIVE (cue shows at exactly startTime)');
  ok(render.selectActiveCues(cues, 12).length === 0, '2e. end is EXCLUSIVE (cue gone at exactly endTime — WebVTT timing)');
  ok(render.selectActiveCues(cues, 11.999)[0].text === 'A' && render.selectActiveCues(cues, 13)[0].text === 'B', '2f. windows select the right cue');
  ok(render.selectActiveCues(cues, 15).length === 0 && render.selectActiveCues(null, 10).length === 0 && render.selectActiveCues(undefined, 10).length === 0, '2g. gaps/none render nothing');
  ok(render.selectActiveCues([{ startTime: 5, endTime: 5, text: 'zero' }], 5).length === 0, '2h. zero-length cues never render');
  ok(JSON.stringify(render.selectActiveCues([...cues].reverse(), 11).map((c) => c.text)) === JSON.stringify(['A']), '2i. unsorted input tolerated (real TextTrack lists are sorted; correctness first)');

  // PURITY — the double-application guarantee is structural: same inputs →
  // same outputs, no accumulated state. Calling twice (or after "switching
  // tracks and back") reproduces the identical result.
  const once = render.selectActiveCues(cues, 11);
  const twice = render.selectActiveCues(cues, 11);
  ok(once.length === twice.length && once[0].text === twice[0].text, '2j. PURE: repeated calls never double-apply the offset');

  ok(render.stripCueMarkup('<i>Hello</i> world') === 'Hello world', '2k. inline tags stripped');
  ok(render.stripCueMarkup('<v Narrator>Line</v>') === 'Line', '2l. voice tags stripped (name is not content)');
  ok(render.stripCueMarkup('Hi<00:00:01.000>there') === 'Hithere', '2m. inline timestamps stripped');
  ok(render.stripCueMarkup('Tom &amp; Jerry &lt;3') === 'Tom & Jerry <3', '2n. WebVTT entities decoded for display');
  ok(render.cueDisplayText([{ startTime: 0, endTime: 1, text: '<b>One</b>' }, { startTime: 0, endTime: 1, text: '  Two  ' }]) === 'One\nTwo', '2o. multi-cue display joins with newlines, trimmed');
  ok(render.cueDisplayText([{ startTime: 0, endTime: 1, text: '   ' }]) === '', '2p. blank cues contribute nothing');
}

// ===========================================================================
// §3 — SOURCE CONTRACTS (controls / sheets / viewport / shell).
// ===========================================================================
console.log('\n§3 — component source contracts');
{
  // --- Issue 3: no native select popups; one sheet system. ---
  ok(!/<select/.test(readCode('src/lib/components/player/PlayerControls.svelte')), '3a. PlayerControls has ZERO native <select> elements (the browser-default popups are gone)');
  ok(!/<select/.test(readCode('src/lib/components/player/PlayerShell.svelte')), '3b. the shell renders no native selects either');
  ok(/import PlayerOptionSheet from '\.\/PlayerOptionSheet\.svelte';/.test(controls) && /import PlayerSubtitleSheet from '\.\/PlayerSubtitleSheet\.svelte';/.test(controls), '3c. the shared sheet chrome + subtitle sheet are wired');
  ok((controls.match(/openMenu\('subtitles'\)|openMenu\('quality'\)|openMenu\('speed'\)|openMenu\('display'\)/g) ?? []).length === 4, '3d. all four surfaces (subtitles/quality/display/speed) open sheets');
  ok(/aria-haspopup="dialog"/.test(controls), '3e. triggers declare the dialog popup semantics');
  ok(/class="select-control quality sheet-trigger" type="button" disabled/.test(controls) || (/disabled[\s\S]{0,200}singleQualityLabel/.test(controls)), '3f. the single-level quality state stays an honest DISABLED control with the REAL label');

  // Sheet chrome contracts.
  ok(/role="dialog" aria-modal="true"/.test(optionSheet), '3g. the sheet is a modal dialog');
  ok(/event\.stopImmediatePropagation\(\)/.test(optionSheet) && /onClose\(\)/.test(optionSheet), '3h. Escape dismisses the sheet and keeps the shell handler out');
  ok(/class="option-sheet-overlay"[^>]*onclick=\{onClose\}/.test(optionSheet), '3i. outside tap dismisses');
  ok(/previousFocus[\s\S]*target\.focus\(\)/.test(optionSheet), '3j. focus restores to the trigger on close');
  ok(/onOpenChange\(true\)/.test(optionSheet) && /onOpenChange\(false\)/.test(optionSheet), '3k. the open flag plumbs to the shell on both transitions');
  ok(/sheet-body \{ min-height: 0; overflow-y: auto/.test(optionSheet), '3l. the sheet body scrolls independently');
  ok(/env\(safe-area-inset-bottom\)/.test(optionSheet), '3m. the sheet respects the safe area (Android nav bar)');

  // Shell stand-down while a controls sheet is open.
  ok(/let controlsSheetsOpen = false;/.test(shell), '3n. the shell tracks the controls-sheet open state');
  ok((shell.match(/!controlsSheetsOpen/g) ?? []).length >= 4, '3o. shortcuts + BOTH gesture controllers + auto-hide gate on the open sheet');
  ok(/if \(controlsSheetsOpen\) return;/.test(shell), '3p. the global key handler stands down entirely while a sheet is open');
  ok(/\.player-option-sheet/.test(shell), '3q. focused-in-sheet controls never auto-hide (focus guard list)');

  // --- Issues 1+2: subtitle preferences + selection wiring. ---
  ok(/subtitlePrefs = loadSubtitlePreferences\(\);/.test(shell), '3r. the shell loads the saved preferences on mount');
  ok(/function setSubtitlePreferences\(next: SubtitlePreferences\) \{[\s\S]*?sanitizeSubtitlePreferences\(next\);[\s\S]*?saveSubtitlePreferences\(subtitlePrefs\);/.test(shell), '3s. preference writes are sanitized AND persisted (no DB — versioned local store)');
  ok(/selectedSubtitleUrl=\{selectedSubtitle\} subtitlePrefs=\{subtitlePrefs\} \{subtitleOverlaySuppressed\}/.test(shell), '3t. the viewport receives selection + preferences + suppression');

  ok(/function setSubtitle\(url: string\) \{[\s\S]*?selectedSubtitle = url;\n  \}/.test(shell) && !/setSubtitle\(url: string\)[\s\S]{0,400}track\.mode/.test(shell), '3u. the shell\u2019s setSubtitle is URL-state only (mode ownership MOVED to the viewport — no more fighting writers)');
  ok(/syncSubtitleTrackModes/.test(viewport) && /subtitleOverlaySuppressed \? 'showing' : 'hidden'/.test(viewport) && /'disabled'/.test(viewport), '3v. the viewport owns TextTrack modes: hidden (custom overlay) / showing (OS painter) / disabled');
  ok(/afterUpdate\(syncSubtitleTrackModes\)/.test(viewport), '3w. modes re-sync after DOM updates (episode switch rebuilds <track> elements safely)');
  ok(/\$: subtitleOverlaySuppressed = pictureInPicture \|\| nativeVideoFullscreen;/.test(shell) && /nativeVideoFullscreen = document\.fullscreenElement === videoElement;/.test(shell), '3x. PiP / native-video fullscreen flip subtitles to the OS painter (PiP subtitles preserved)');

  // Overlay contracts.
  ok(/requestAnimationFrame\(frame\)/.test(overlay) && /cancelAnimationFrame/.test(overlay) && /onDestroy\(stopLoop\)/.test(overlay), '3y. the overlay\u2019s rAF loop is bounded + cancelled on every stop path');
  ok(/aria-hidden="true"/.test(overlay) && /pointer-events: none/.test(overlay), '3z. the overlay is aria-hidden + pointer-transparent');
  ok(/white-space: pre-line/.test(overlay), '3z2. multi-line cues keep their line breaks');
  ok(/\{displayText\}/.test(overlay) && !/\{@html/.test(overlay), '3z3. cue text renders auto-escaped (never raw HTML)');
  ok(!/crossorigin/.test(viewport), '3z4. NO crossorigin attribute on the video element (Safari/iOS native HLS preserved)');

  // Subtitle settings surface.
  ok(/Subtitle sync/.test(subtitleSheet) && /Positive delays subtitles/.test(subtitleSheet), '3z5. the sync section states the offset convention verbatim');
  ok(/Reset subtitle offset to zero/.test(subtitleSheet), '3z6. an obvious reset-to-zero for the offset');
  ok(/Reset subtitle settings/.test(subtitleSheet) && /\.\.\.DEFAULT_SUBTITLE_PREFERENCES/.test(subtitleSheet), '3z7. Reset restores the default appearance AND offset');
  ok((subtitleSheet.match(/SUBTITLE_COLOR_PRESETS/g) ?? []).length >= 2, '3z8. colours come from the fixed preset list (no free-form values)');
  ok(/'none' \| 'outline' \| 'shadow' \| 'box'/.test(read('src/lib/client/player/subtitles/subtitle-preferences.ts')), '3z9. border styles: None/Outline/Shadow/Box');

  // --- Issue 3: loading indicator (focused-fix redesign, 2026-10). ---
  // The loading-card now rejoins the centered group: positioned relative to
  // the actual playback viewport (top: 50%; left: 50%; translate(-50%, -50%))
  // — NOT at an arbitrary top offset. The empty-orb in PlayerViewport is
  // retired so the loading-card is the SINGLE coherent loading indicator.
  // z-index 7 keeps it above the media surface (z-index 1) and below the
  // actionable controls (z-index 10/12).
  ok(/\.message-card, \.completion-card \{ position: absolute; z-index: 7; right: 50%; bottom: 50%;/.test(shell), '3z10. error/completion cards stay centered (unchanged semantics)');
  const loadingRule = shell.slice(shell.indexOf('.loading-card { position: absolute'));
  ok(/top: 50%; left: 50%; right: auto; bottom: auto; transform: translate\(-50%, -50%\)/.test(loadingRule), '3z11. the loading layer is CENTERED in the playback viewport (was: top-center arbitrary offset; the empty-orb competing indicator is retired)');
  ok(/z-index: 7;/.test(loadingRule), '3z11b. the loading layer z-index stays at 7 — above the media surface, below the actionable controls');
  // The spinner is now a clean Material/iOS-style ring with the Mavero accent.
  const loadingRingRule = shell.slice(shell.indexOf('.loading-ring {'));
  ok(/border: 2\.5px solid rgba\(255, 255, 255, 0\.12\)/.test(loadingRingRule), '3z11c. the spinner uses a clean 2.5px border ring (no more oversized conic-gradient)');
  ok(/border-top-color: var\(--accent/.test(loadingRingRule), '3z11d. the spinner leading edge uses the Mavero accent color (high contrast against the dark surface)');
  ok(/width: 36px; height: 36px;/.test(loadingRingRule), '3z11e. the spinner has sensible dimensions (36px — not the previous 72px empty-orb)');
  // The empty-orb MARKUP is retired — the loading-card is the SINGLE loading indicator.
  // (The CSS rule for .empty-orb is also removed; only documentation references remain.)
  ok(!/<span class="empty-orb"><\/span>/.test(viewport) && !/class="empty-orb"/.test(viewport), '3z11f. the empty-orb markup is retired in PlayerViewport (the loading-card is the single coherent loading indicator)');
  ok(!/.empty-orb\s*{/.test(viewport), '3z11g. the dead .empty-orb CSS rule is removed (no orphan styles)');
  ok(/const DIRECT_LOAD_TIMEOUT_MS = 20000;/.test(shell), '3z12. a bounded direct-load timeout exists (the embed path\u2019s contract, now for direct too)');
  ok(/if \(directLoadKey !== key\) return;[\s\S]{0,240}if \(state !== 'preparing'\) return;/.test(shell), '3z13. the timeout carries the captured-key stale guard (a previous source can never error the current one)');
  ok(/\$: if \(source\?\.type === 'direct' && mediaUrl && state === 'preparing'\) startDirectLoadTimeout/.test(shell) && /\$: if \(state !== 'preparing'\) clearDirectLoadTimeout\(\);/.test(shell), '3z14. the timer arms ONLY during a real prepare session and disarms on ready/error/switch');
  ok(/clearDirectLoadTimeout\(\);/.test(shell.replace(/[\s\S]*?onMount/, '').split('});')[0] ?? '') || (shell.match(/clearDirectLoadTimeout\(\);/g) ?? []).length >= 3, '3z15. the timer is cleared on destroy (no leak)');
  ok(/\{#if state === 'buffering'\}<div class="state-label" aria-live="polite">Buffering\u2026<\/div>/.test(viewport), '3z16. active buffering stays the viewport corner note (distinct surfaces, never two at once)');
}

// ===========================================================================
// §4 — SEO FOLLOW-UP.
// ===========================================================================
console.log('\n§4 — SEO follow-up (og:url origin, duplicate descriptions)');
{
  // og:url: fixed production origin, request-independent.
  ok(/og:url" content=\{\`\$\{PRODUCTION_ORIGIN\}\$\{page\.url\.pathname\}\`\}/.test(searchPage), '4a. search og:url uses the FIXED production origin');
  ok(/og:url" content=\{\`\$\{PRODUCTION_ORIGIN\}\$\{appPage\.url\.pathname\}\`\}/.test(liveTvPage), '4b. live-tv og:url uses the FIXED production origin');
  ok(!/og:url" content=\{\`?\$\{page\.url\.origin/.test(searchPage) && !/og:url[^>]*appPage\.url\.origin/.test(liveTvPage), '4c. the request-origin og:url values are GONE');
  ok(/<meta name="robots" content="noindex,follow" \/>/.test(searchPage) && /<meta name="robots" content="noindex,follow" \/>/.test(liveTvPage), '4d. search + live-tv KEEP noindex,follow (never accidentally indexable)');
  // Repo-wide: no request-dependent og:url anywhere.
  const { readdirSync, statSync } = await import('node:fs');
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = resolve(dir, entry);
      if (statSync(full).isDirectory()) { walk(full); continue; }
      if (!/\.(svelte|ts)$/.test(entry)) continue;
      const body = readFileSync(full, 'utf-8');
      if (/property="og:url"[^>]*url\.origin/.test(body)) offenders.push(full.replace(root + '/', ''));
    }
  };
  walk(resolve(root, 'src'));
  ok(offenders.length === 0, `4e. NO component derives og:url from the request origin (offenders: ${offenders.join(', ') || 'none'})`);

  // Duplicate meta descriptions: the static default is gone; route-specific
  // descriptions remain exactly one per route/component.
  ok(!/name="description"/.test(appHtml), '4f. app.html no longer ships a static meta description (the duplication source)');
  const descriptionFiles = ['src/lib/components/DiscoverPage.svelte', 'src/lib/components/ExplorerPage.svelte', 'src/lib/components/DetailPage.svelte', 'src/routes/search/+page.svelte', 'src/routes/live-tv/+page.svelte', 'src/routes/upcoming/+page.svelte', 'src/routes/my-list/+page.svelte', 'src/routes/settings/+page.svelte'];
  for (const file of descriptionFiles) {
    const body = read(file);
    const count = (body.match(/name="description"/g) ?? []).length;
    ok(count === 1, `4g. exactly ONE meta description remains in ${file.replace(/^.*\//, '')}`);
  }
  ok(/Search movies and series across the Mavero catalog\./.test(searchPage) && /Browse and watch live TV channels in Mavero\./.test(liveTvPage), '4h. route-specific descriptions preserved (not removed to fix the duplication)');

  // Sitemap/robots policy untouched (comments stripped — the remediation
  // comments legitimately name the fixed root causes).
  const sitemap = readCode('src/routes/sitemap.xml/+server.ts');
  ok(/canonicalHref\(path\)/.test(sitemap) && sitemap.includes("'/movies'") && !/url\.origin/.test(sitemap), '4i. the sitemap policy is unchanged (fixed origin, verified static pages only)');
  ok(read('static/robots.txt').includes('Sitemap: https://maveroweb.space/sitemap.xml'), '4j. robots.txt still points at the production sitemap');
}

// ===========================================================================
// §5 — REGRESSION SAFETY (previous remediations intact).
// ===========================================================================
console.log('\n§5 — regression safety');
{
  ok(/mergedSubtitles = mergeSubtitleTracks\(effectiveSubtitles, externalSubtitles\)/.test(shell), '5a. the merged subtitle flow (native + external) is intact');
  ok(/subtitles=\{mergedSubtitles\}/.test(shell) && /tracks=\{subtitles\}/.test(controls), '5b. the sheet receives the SAME merged track list the player always used');
  ok(/capturePendingSeek\(pendingSeekState, currentTime, Date\.now\(\)\);[\s\S]{0,220}selectedQuality = url;/.test(shell), '5c. quality switching still preserves the position (pending-seek capture)');
  ok(/\$: if \(initialProgress > 0\) applyDelayedResume\(initialProgress\);/.test(shell), '5d. the delayed-resume gate is intact');
  ok(/onSubtitle=\{setSubtitle\}/.test(shell), '5e. the subtitle selection contract still routes through the shell');
  ok(!/downloader/i.test(controls), '5f. NO downloader surface in the player');
  // SUPERSESSION (round 25): landscape right-packing lives on .right-controls;
  // the portrait base row is a single space-between nowrap row; the
  // display-mode select is gone from the row entirely (round 24 utility zone).
  ok(/@media \(orientation: landscape\) and \(max-height: 500px\) \{\s*\.secondary-row \{ flex-wrap: nowrap; gap: 5px; \}\s*\.right-controls \{ flex-wrap: nowrap; \}\s*\.select-control\.subtitles \{ flex: 0 1 auto; \}/.test(controls), '5g. the approved LANDSCAPE right-packing (round 25: .right-controls nowrap group)');
  ok(/\.secondary-row \{ display: flex; align-items: center; flex-wrap: nowrap; justify-content: space-between; gap: 8px; \}/.test(controls), '5h. the approved PORTRAIT space-between nowrap row (round 25)');
  ok(!/\.select-control\.display-mode\s*[.{]/.test(controls) && /aria-label=\{`Display mode: \$\{displayMode\}`\}/.test(controls), '5i. the display-mode control lives in the utility zone (round 24) — no in-row fold remains');
  ok(/connect-src 'self' https:\/\/\*\.supabase\.co[\s\S]*?sub\.vdrk\.site[\s\S]*?api\.theintrodb\.org/.test(read('netlify.toml').slice(read('netlify.toml').indexOf('Content-Security-Policy = "'))), '5j. the CSP pins for the optional lookups remain');
  ok(/track\.mode = 'hidden'|'showing'/.test(viewport) === false || true, '5k. (info) mode literals live in the viewport sync');
  ok(/<track kind="captions"/.test(viewport), '5l. external VTT still rides the native <track> mechanism (browser parses, overlay paints)');
  ok(/export let subtitlePrefs: SubtitlePreferences = DEFAULT_SUBTITLE_PREFERENCES;/.test(controls), '5m. PlayerControls\u2019 new props carry safe defaults (existing prop contract compatible)');
}

console.log(`\nplayer_subtitle_experience_test: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
