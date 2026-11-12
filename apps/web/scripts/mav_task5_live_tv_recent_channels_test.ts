/**
 * Task 5 regression (2026-10-15) — Live TV "Recently played" row.
 *
 * Pins the full contract of the new feature:
 *   §A  Store behavior (behavioral, jsdom-free localStorage emulation):
 *       first play inserts, replay moves to front without duplication,
 *       bound of 12 entries, per-channel remove, Clear all, reload
 *       restores, safe parsing of corrupt payloads.
 *   §B  PRIVACY: the store persists ONLY bounded channel-ID strings —
 *       no signed media URLs, resolver responses, tokens or credentials.
 *   §C  Page wiring (static): the row renders between the player column
 *       and the toolbar; recording happens at engine 'loaded' (failed
 *       resolutions never pollute the row); selection reuses the
 *       EXISTING selectChannel lifecycle (no second playback engine);
 *       logos-only items; empty history hides the row; arrows exist only
 *       on overflow; removed/unknown channel IDs degrade gracefully.
 *
 * Run: pnpm exec tsx --tsconfig ./jsconfig.json scripts/mav_task5_live_tv_recent_channels_test.ts
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = (p: string) => readFileSync(resolve(root, p), 'utf-8');

let passed = 0;
let failed = 0;
function ok(cond: boolean, label: string): void {
  if (cond) { passed += 1; console.log(`  ok ${passed} - ${label}`); }
  else { failed += 1; console.log(`  FAIL - ${label}`); }
}

// ---------------------------------------------------------------------------
// Minimal localStorage emulation (the store guards on typeof localStorage,
// so defining a global is enough in Node).
// ---------------------------------------------------------------------------
const backing = new Map<string, string>();
const localStorageEmulated = {
  getItem: (key: string): string | null => backing.get(key) ?? null,
  setItem: (key: string, value: string): void => { backing.set(key, value); },
  removeItem: (key: string): void => { backing.delete(key); },
};
(globalThis as { localStorage?: unknown }).localStorage = localStorageEmulated;

async function run() {
  console.log('\nTask 5 — Live TV recently-played channels\n');

  const store = await import('../src/lib/client/live-tv/recent-channels');

  console.log('§A — store behavior');
  {
    backing.clear();
    ok(store.getRecentChannelIds().length === 0, 'A1. empty store → empty list');

    store.recordRecentChannel('ch-1');
    ok(store.getRecentChannelIds()[0] === 'ch-1', 'A2. first play inserts the channel');

    store.recordRecentChannel('ch-2');
    store.recordRecentChannel('ch-3');
    store.recordRecentChannel('ch-1'); // replay
    const list = store.getRecentChannelIds();
    ok(list.length === 3 && list[0] === 'ch-1', 'A3. replay moves the channel to the front WITHOUT duplication');
    ok(!list.includes('ch-1') === false && list.filter((e) => e === 'ch-1').length === 1, 'A4. no duplicate entries for the same channel');

    for (let i = 4; i <= 16; i += 1) store.recordRecentChannel(`ch-${i}`);
    ok(store.getRecentChannelIds().length === 12, 'A5. bounded at 12 entries (oldest evicted)');

    store.removeRecentChannel('ch-16');
    ok(!store.getRecentChannelIds().includes('ch-16'), 'A6. per-channel clear removes exactly that channel');

    store.clearRecentChannels();
    ok(store.getRecentChannelIds().length === 0, 'A7. Clear all empties the list');

    // Reload restores: simulate persisted state + a fresh read.
    backing.set('mavero:live-tv-recent-channels', JSON.stringify(['a', 'b', 'c']));
    ok(JSON.stringify(store.getRecentChannelIds()) === '["a","b","c"]', 'A8. reload restores the persisted recent list');

    // Corrupt payloads degrade safely.
    backing.set('mavero:live-tv-recent-channels', 'not-json');
    ok(store.getRecentChannelIds().length === 0, 'A9. corrupt payload → empty list (never throws)');
    backing.set('mavero:live-tv-recent-channels', JSON.stringify([42, null, 'ok', '']));
    ok(JSON.stringify(store.getRecentChannelIds()) === '["ok"]', 'A10. non-string/empty entries filtered out');
    backing.clear();
  }

  console.log('\n§B — privacy: IDs only, never URLs/tokens');
  {
    backing.clear();
    store.recordRecentChannel('gtv-1234567890');
    const raw = backing.get('mavero:live-tv-recent-channels') ?? '';
    ok(raw === JSON.stringify(['gtv-1234567890']), 'B1. the persisted payload contains ONLY the channel id');
    ok(!raw.includes('http') && !raw.includes('token') && !raw.includes('m3u8') && !raw.includes('expires'), 'B2. no signed media URLs, resolver responses, tokens or credentials');
    backing.clear();
  }

  console.log('\n§C — page wiring');
  {
    const page = src('src/routes/live-tv/+page.svelte');

    // Placement: the recent section appears AFTER the player column close
    // and BEFORE the toolbar section.
    const playerColumnEnd = page.indexOf('</section>\n\n    <!-- Task 5 — RECENTLY PLAYED row');
    const toolbarStart = page.indexOf('<section class="ltv-toolbar"');
    ok(playerColumnEnd > 0 && playerColumnEnd < toolbarStart, 'C1. the row renders immediately below the player and above the toolbar');

    // Recording point: INSIDE the engine-load success path.
    const onplayedIdx = page.indexOf('onplayed:');
    const recordIdx = page.indexOf('rememberPlayedChannel', onplayedIdx);
    ok(onplayedIdx > 0 && recordIdx > onplayedIdx, 'C2. R-6: recording happens via the router handlers.onplayed callback');

    // Selection reuses the EXISTING lifecycle.
    ok(/onclick=\{\(\) => void selectChannel\(channel\)\}/.test(page), 'C3. recent-channel click reuses the existing selectChannel flow (abort/destroy/resolve/load)');

    // Logos only + fallbacks.
    ok(/aria-label=\{`Play \$\{channel\.name\}`\}/.test(page), 'C4. accessible label/tooltip per item (name not rendered visibly)');
    ok(/recent-logo-fallback/.test(page) && /channelInitials\(channel\.name\)/.test(page), 'C5. missing logo → stable initials fallback');
    ok(/onerror=\{\(\) => recentLogoFailed\.add\(channel\.id\)\}/.test(page), 'C6. failed logo load → stable fallback');

    // Empty history → no wasted vertical space (the whole section is conditional).
    ok(/\{#if recentChannels\.length > 0\}/.test(page), 'C7. empty history renders NOTHING (no reserved vertical space)');

    // Arrows only on overflow + meaningful scroll amount.
    ok(/\{#if recentOverflow\}/.test(page) && /el\.clientWidth \* 0\.8/.test(page), 'C8. arrows exist only when the row overflows; each press moves ~80% of the visible width');

    // Two-step Clear all confirm; clearing is local-only (never touches playback).
    ok(/recentClearArmed/.test(page) && /Confirm clear/.test(page), 'C9. Clear all requires confirmation');
    ok(/function clearAllRecentChannels[\s\S]{0,200}clearRecentChannels\(\)/.test(page), 'C10. Clear all only clears the local store (playback untouched)');

    // Graceful removed/unknown IDs: the row resolves IDs against the LIVE catalogue.
    ok(/const byId = new Map\(channels\.map\(\(channel\) => \[channel\.id, channel\]\)\);[\s\S]{0,300}if \(channel\) resolved\.push\(channel\);/.test(page), 'C11. unknown/removed channel IDs drop out gracefully');

    // No per-row network requests: the row derives from the loaded catalogue
    // (inspect ONLY the recent-row markup slice — the page's selectChannel
    // legitimately calls resolveLiveTvPlayback elsewhere).
    const recentSection = page.slice(page.indexOf('<!-- Task 5 — RECENTLY PLAYED row'), page.indexOf('{/if}\n\n    <!-- LT-18'));
    ok(!recentSection.includes('resolveLiveTvPlayback') && !recentSection.includes('getLiveTv'), 'C12. no additional network requests for row items');

    // No page-wide horizontal overflow: the row scrolls within its own box.
    ok(/\.recent-row \{[\s\S]*?overflow-x: auto;/.test(page), 'C13. horizontal scroll is contained in the row (no page-wide overflow)');
  }

  console.log(`\nTask 5 result: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

void run();
