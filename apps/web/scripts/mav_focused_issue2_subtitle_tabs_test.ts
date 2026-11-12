/**
 * MAV-FOCUSED Issue 2 (2026-10) — two-tab subtitle sheet regression suite.
 *
 * Confirmed root cause (verified at HEAD before this fix):
 *   - `PlayerSubtitleSheet.svelte` rendered ONE long scrollable sheet:
 *     the language list (Off + every track) followed by sync, size,
 *     position, colour, border, reset. A source like Swapped that
 *     ships 15+ languages forced a long scroll to reach the sync /
 *     appearance controls.
 *
 * Behaviour after the fix:
 *   - The sheet opens with a two-tab header: Languages (default) +
 *     Settings. Both tabs sit above the active tab body.
 *   - The Languages tab is the default on every open.
 *   - Switching tabs is PURE local UI state — it does NOT call
 *     `onSubtitle` or `onPrefs`, so the selected track and the current
 *     preferences survive a tab switch.
 *   - The existing PlayerOptionSheet chrome (dialog semantics, focus
 *     trap, Escape, outside-tap, safe-area, independent scroll) is
 *     reused unchanged.
 *   - No browser-default dropdown, no second unrelated modal.
 *   - The Settings tab contains every existing control (sync offset +
 *     reset, text size, vertical position, colour, border style,
 *     reset-all) — no duplication, no second preference state.
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

let passed = 0;
let failed = 0;
function ok(condition: unknown, label: string) {
  if (condition) { passed += 1; console.log(`  ok ${passed} - ${label}`); }
  else { failed += 1; console.log(`  FAIL - ${label}`); }
}

const sheet = readCode('src/lib/components/player/PlayerSubtitleSheet.svelte');

console.log('\n1 — two-tab header structure');
{
  ok(sheet.includes("type SubtitleTab = 'languages' | 'settings'"), '1a. a typed SubtitleTab union exists (languages + settings)');
  ok(/let activeTab:\s*SubtitleTab\s*=\s*['"]languages['"]/.test(sheet), '1b. the default activeTab is "languages"');
  ok(sheet.includes('class="tab-row"') && sheet.includes('role="tablist"'), '1c. a tablist container is rendered');
  ok(sheet.includes('class="tab"'), '1d. tab buttons are rendered with the .tab class');
  // Two distinct tabs, each with its own aria-controls + aria-selected binding.
  const tabButtons = sheet.match(/class="tab"[\s\S]*?(?=<\/button>)/g) ?? [];
  ok(tabButtons.length >= 2, `1e. at least two .tab buttons exist (found ${tabButtons.length})`);
  ok(sheet.includes("aria-controls=\"mav-sub-tab-languages\"") && sheet.includes("aria-controls=\"mav-sub-tab-settings\""), '1f. both tabs wire aria-controls to their tabpanels');
  ok(sheet.includes("aria-selected={activeTab === 'languages'}") && sheet.includes("aria-selected={activeTab === 'settings'}"), '1g. both tabs wire aria-selected to activeTab');
}

console.log('\n2 — Languages tab is the default');
{
  // The Languages tabpanel is rendered when activeTab === 'languages'. The
  // Settings tabpanel is rendered in the {:else} branch — so the languages
  // panel renders by default.
  const languagesBranch = sheet.indexOf("activeTab === 'languages'");
  const settingsBranch = sheet.indexOf("activeTab === 'settings'");
  ok(languagesBranch > -1 && settingsBranch > -1, '2a. both branches are present');
  ok(languagesBranch < settingsBranch, '2b. the languages branch is checked FIRST — it is the default-rendered tab');
  ok(/aria-labelledby="mav-sub-tabbtn-languages"/.test(sheet) && /aria-labelledby="mav-sub-tabbtn-settings"/.test(sheet), '2c. each tabpanel carries its accessible label binding');
}

console.log('\n3 — tab switching is pure local UI state (does NOT touch track/prefs)');
{
  // The two tab buttons use `onclick={() => { activeTab = ...; }}` — the
  // handler body must NOT call onSubtitle or onPrefs. We extract each tab
  // button's onclick handler and assert its body directly.
  const tabButtonClicks = [...sheet.matchAll(/onclick=\{\(\)\s*=>\s*\{([^}]*)\}\}/g)].map((m) => m[1]);
  const tabClicks = tabButtonClicks.filter((body) => body.includes("activeTab ="));
  ok(tabClicks.length === 2, `3-pre. found exactly 2 tab-click handlers that assign activeTab (found ${tabClicks.length})`);
  for (const body of tabClicks) {
    ok(!body.includes('onSubtitle'), `3a. tab click handler does NOT call onSubtitle (body: "${body.trim()}")`);
    ok(!body.includes('onPrefs'), `3b. tab click handler does NOT call onPrefs (body: "${body.trim()}")`);
  }
  ok(tabClicks.every((body) => /activeTab\s*=\s*['"](?:languages|settings)['"]/.test(body)), '3c. tab click handlers ONLY assign activeTab');
}

console.log('\n4 — Settings tab carries every existing control');
{
  // Slice from `{:else}` (the Settings tab branch) to the closing
  // </PlayerOptionSheet> tag. The Settings tab contains nested {#if}
  // blocks (e.g. {#if prefs.color === preset.key}), so a naive
  // "{:else} to first {/if}" slice would cut off at the inner if.
  const settingsBranchStart = sheet.indexOf('{:else}');
  const settingsBranchEnd = sheet.indexOf('</PlayerOptionSheet>', settingsBranchStart);
  const settingsBranch = sheet.slice(settingsBranchStart, settingsBranchEnd);

  // Subtitle sync / offset.
  ok(/Subtitle sync/.test(settingsBranch), '4a. Settings tab includes "Subtitle sync"');
  ok(/stepSubtitleOffset/.test(settingsBranch) && /formatSubtitleOffset/.test(settingsBranch), '4b. Settings tab includes the offset stepper + value display');
  ok(/Reset subtitle offset to zero/.test(settingsBranch), '4c. Settings tab includes the offset reset button');

  // Text size.
  ok(/Text size/.test(settingsBranch), '4d. Settings tab includes "Text size"');
  ok(/stepSubtitleSize/.test(settingsBranch), '4e. Settings tab includes the size stepper');

  // Vertical position.
  ok(/Vertical position/.test(settingsBranch), '4f. Settings tab includes "Vertical position"');
  ok(/SUBTITLE_POSITION/.test(settingsBranch), '4g. Settings tab uses the SUBTITLE_POSITION bound');

  // Colour.
  ok(/Colour/.test(settingsBranch), '4h. Settings tab includes "Colour"');
  ok(/SUBTITLE_COLOR_PRESETS/.test(settingsBranch), '4i. Settings tab renders the colour preset swatches');

  // Border style.
  ok(/Border style/.test(settingsBranch), '4j. Settings tab includes "Border style"');
  ok(/BORDER_OPTIONS/.test(settingsBranch), '4k. Settings tab renders the border style segmented control');

  // Reset-all.
  ok(/Reset subtitle settings/.test(settingsBranch), '4l. Settings tab retains the reset-all behavior');
  ok(/DEFAULT_SUBTITLE_PREFERENCES/.test(settingsBranch), '4m. reset-all restores DEFAULT_SUBTITLE_PREFERENCES (the existing contract)');
}

console.log('\n5 — Languages tab carries the existing track list (Off + every track)');
{
  // Slice from the Languages branch start to the {:else} that begins the
  // Settings branch. Same nested-{#if} caveat as section 4 above.
  const languagesBranchStart = sheet.indexOf("activeTab === 'languages'");
  const languagesBranchEnd = sheet.indexOf('{:else}', languagesBranchStart);
  const languagesBranch = sheet.slice(languagesBranchStart, languagesBranchEnd);

  ok(/Off/.test(languagesBranch), '5a. Languages tab includes the "Off" row');
  ok(/onSubtitle\(''\)/.test(languagesBranch), '5b. Languages tab keeps the Off → onSubtitle("") contract');
  ok(/{#each tracks as track/.test(languagesBranch), '5c. Languages tab iterates the tracks array (every available track)');
  ok(/onSubtitle\(track\.url\)/.test(languagesBranch), '5d. Languages tab keeps the track → onSubtitle(track.url) contract');
  ok(/notice/.test(languagesBranch), '5e. Languages tab retains the honest notice state (no tracks / unavailable)');
}

console.log('\n6 — sheet chrome is reused (no second modal, no browser-default dropdown)');
{
  ok(sheet.includes("import PlayerOptionSheet from './PlayerOptionSheet.svelte'"), '6a. the existing PlayerOptionSheet chrome is reused');
  ok(/<PlayerOptionSheet title="Subtitles"/.test(sheet), '6b. the sheet opens through the existing PlayerOptionSheet wrapper');
  ok(!/<select/.test(sheet), '6c. no browser-default <select> dropdown is introduced');
  // The PlayerOptionSheet provides dialog semantics, focus trap, Escape, outside-tap,
  // safe-area — all preserved because we render through it.
  const optionSheet = readCode('src/lib/components/player/PlayerOptionSheet.svelte');
  ok(optionSheet.includes('role="dialog"') && optionSheet.includes('aria-modal="true"'), '6d. PlayerOptionSheet retains dialog semantics');
  ok(optionSheet.includes('aria-label={title}'), '6e. PlayerOptionSheet carries the accessible dialog label');
  ok(/Escape/.test(optionSheet), '6f. PlayerOptionSheet retains Escape handling');
}

console.log('\n7 — tab styling respects Mavero dark/cinematic surface + safe-area');
{
  ok(sheet.includes('.tab {') && sheet.includes('.tab-row {'), '7a. tab + tab-row styles are defined');
  ok(sheet.includes('.tab-panel {'), '7b. tab-panel container style is defined');
  // The tab styling uses the existing accent + muted colors (no new palette introduced).
  ok(sheet.includes('var(--accent)') && sheet.includes('var(--accent-soft)'), '7c. tab styling uses the existing accent vars');
  // The sheet's body keeps its existing safe-area + scroll behavior (provided by PlayerOptionSheet).
  const optionSheet = readCode('src/lib/components/player/PlayerOptionSheet.svelte');
  ok(optionSheet.includes('env(safe-area-inset-bottom)'), '7d. PlayerOptionSheet retains safe-area-inset-bottom');
  ok(optionSheet.includes('overflow-y: auto'), '7e. PlayerOptionSheet retains independent scroll within the sheet');
  ok(/max-height:\s*min\(62dvh,\s*560px\)/.test(optionSheet), '7f. PlayerOptionSheet retains its bounded height so both tabs are usable on mobile');
}

console.log(`\nmav_focused_issue2_subtitle_tabs_test: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
