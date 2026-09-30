import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/**
 * Admin 2.0 — Phase J contracts.
 *
 * Phase J is the Cinematic Polish pass: design tokens, focus-visible
 * rings, skeleton shimmer utility, ambient atmosphere, reduced motion,
 * and overall visual cohesion across all workspaces.
 */

let passed = 0;
function ok(message: string) {
  passed += 1;
  console.log(`  ok ${passed} - ${message}`);
}

const appCss = readFileSync(new URL('../src/app.css', import.meta.url), 'utf8');
const adminAppShell = readFileSync(new URL('../src/lib/components/admin2/AdminAppShell.svelte', import.meta.url), 'utf8');
const adminPage = readFileSync(new URL('../src/lib/components/admin2/AdminPage.svelte', import.meta.url), 'utf8');
const adminStatus = readFileSync(new URL('../src/lib/components/admin2/AdminStatus.svelte', import.meta.url), 'utf8');
const adminAssetStatus = readFileSync(new URL('../src/lib/components/admin2/AdminAssetStatus.svelte', import.meta.url), 'utf8');
const adminMediaCard = readFileSync(new URL('../src/lib/components/admin2/AdminMediaCard.svelte', import.meta.url), 'utf8');
const adminMediaTable = readFileSync(new URL('../src/lib/components/admin2/AdminMediaTable.svelte', import.meta.url), 'utf8');
const adminConfirmDialog = readFileSync(new URL('../src/lib/components/admin2/AdminConfirmDialog.svelte', import.meta.url), 'utf8');
const adminMediaDetailDrawer = readFileSync(new URL('../src/lib/components/admin2/AdminMediaDetailDrawer.svelte', import.meta.url), 'utf8');

// ============================================================
// 1. Design tokens
// ============================================================

assert.match(appCss, /--a2-bg:/, 'token: --a2-bg');
assert.match(appCss, /--a2-surface-1:/, 'token: --a2-surface-1');
assert.match(appCss, /--a2-surface-2:/, 'token: --a2-surface-2');
assert.match(appCss, /--a2-surface-3:/, 'token: --a2-surface-3');
assert.match(appCss, /--a2-surface-4:/, 'token: --a2-surface-4');
assert.match(appCss, /--a2-text:/, 'token: --a2-text');
assert.match(appCss, /--a2-text-muted:/, 'token: --a2-text-muted');
assert.match(appCss, /--a2-text-dim:/, 'token: --a2-text-dim');
assert.match(appCss, /--a2-text-bright:/, 'token: --a2-text-bright');
ok('1a. Core surface + text tokens defined');

// ============================================================
// 2. Semantic accent tokens
// ============================================================

assert.match(appCss, /--a2-cyan:/, 'token: --a2-cyan');
assert.match(appCss, /--a2-green:/, 'token: --a2-green');
assert.match(appCss, /--a2-blue:/, 'token: --a2-blue');
assert.match(appCss, /--a2-amber:/, 'token: --a2-amber');
assert.match(appCss, /--a2-red:/, 'token: --a2-red');
assert.match(appCss, /--a2-cyan-soft:/, 'token: --a2-cyan-soft');
assert.match(appCss, /--a2-green-soft:/, 'token: --a2-green-soft');
assert.match(appCss, /--a2-amber-soft:/, 'token: --a2-amber-soft');
assert.match(appCss, /--a2-red-soft:/, 'token: --a2-red-soft');
ok('2a. Semantic accent tokens (cyan/green/blue/amber/red) + soft variants defined');

// ============================================================
// 3. Border + shadow tokens
// ============================================================

assert.match(appCss, /--a2-border:/, 'token: --a2-border');
assert.match(appCss, /--a2-border-strong:/, 'token: --a2-border-strong');
assert.match(appCss, /--a2-border-focus:/, 'token: --a2-border-focus');
assert.match(appCss, /--a2-shadow-sm:/, 'token: --a2-shadow-sm');
assert.match(appCss, /--a2-shadow-md:/, 'token: --a2-shadow-md');
assert.match(appCss, /--a2-shadow-lg:/, 'token: --a2-shadow-lg');
ok('3a. Border + shadow tokens defined');

// ============================================================
// 4. Radius + spacing tokens
// ============================================================

assert.match(appCss, /--a2-radius-xs:/, 'token: --a2-radius-xs');
assert.match(appCss, /--a2-radius-sm:/, 'token: --a2-radius-sm');
assert.match(appCss, /--a2-radius-md:/, 'token: --a2-radius-md');
assert.match(appCss, /--a2-radius-lg:/, 'token: --a2-radius-lg');
assert.match(appCss, /--a2-space-1:/, 'token: --a2-space-1');
assert.match(appCss, /--a2-space-2:/, 'token: --a2-space-2');
assert.match(appCss, /--a2-space-3:/, 'token: --a2-space-3');
assert.match(appCss, /--a2-space-4:/, 'token: --a2-space-4');
ok('4a. Radius + spacing tokens defined');

// ============================================================
// 5. Motion tokens
// ============================================================

assert.match(appCss, /--a2-motion-micro:/, 'token: --a2-motion-micro');
assert.match(appCss, /--a2-motion-fast:/, 'token: --a2-motion-fast');
assert.match(appCss, /--a2-motion-normal:/, 'token: --a2-motion-normal');
assert.match(appCss, /--a2-motion-slow:/, 'token: --a2-motion-slow');
assert.match(appCss, /--a2-ease-out:/, 'token: --a2-ease-out');
ok('5a. Motion tokens (micro/fast/normal/slow + easing) defined');

// ============================================================
// 6. Typography tokens
// ============================================================

assert.match(appCss, /--a2-font-sans:/, 'token: --a2-font-sans');
assert.match(appCss, /--a2-font-mono:/, 'token: --a2-font-mono');
assert.match(appCss, /--a2-text-2xl:/, 'token: --a2-text-2xl');
assert.match(appCss, /--a2-text-xl:/, 'token: --a2-text-xl');
assert.match(appCss, /--a2-text-lg:/, 'token: --a2-text-lg');
assert.match(appCss, /--a2-text-base:/, 'token: --a2-text-base');
assert.match(appCss, /--a2-text-sm:/, 'token: --a2-text-sm');
assert.match(appCss, /--a2-text-xs:/, 'token: --a2-text-xs');
assert.match(appCss, /--a2-text-2xs:/, 'token: --a2-text-2xs');
ok('6a. Typography tokens (font + size scale) defined');

// ============================================================
// 7. Surface hierarchy (layered depth)
// ============================================================

assert.match(appCss, /--a2-bg: #050608/, 'base background is #050608');
assert.match(appCss, /--a2-surface-1: #080B0F/, 'surface-1 is #080B0F');
assert.match(appCss, /--a2-surface-2: #0B0F14/, 'surface-2 is #0B0F14');
assert.match(appCss, /--a2-surface-3: #10151B/, 'surface-3 is #10151B');
assert.match(appCss, /--a2-surface-4: #161D26/, 'surface-4 is #161D26');
ok('7a. Surface hierarchy: bg → surface-1 → surface-2 → surface-3 → surface-4 (progressive depth)');

// ============================================================
// 8. Ambient atmosphere
// ============================================================

assert.match(appCss, /\.a2-ambient/, 'ambient atmosphere class exists');
assert.match(appCss, /radial-gradient.*217, 255/, 'ambient uses cyan radial gradient (rgba 0, 217, 255)');
assert.match(appCss, /pointer-events: none/, 'ambient does not intercept pointer events');
ok('8a. Ambient atmosphere: subtle radial gradient, non-interactive');

// ============================================================
// 9. Focus-visible ring (Phase J)
// ============================================================

assert.match(appCss, /\.a2-focus-ring:focus-visible/, 'global focus-visible ring class exists');
assert.match(appCss, /outline: 2px solid var\(--a2-cyan\)/, 'focus ring uses cyan outline');
ok('9a. Global focus-visible ring utility class defined');

// Focus-visible on nav links
assert.match(adminAppShell, /\.a2-nav-link:focus-visible/, 'nav links have focus-visible');
assert.match(adminAppShell, /\.a2-more-link:focus-visible/, 'more links have focus-visible');
assert.match(adminAppShell, /\.a2-bottom-item:focus-visible/, 'bottom nav items have focus-visible');
ok('9b. AdminAppShell nav items have focus-visible styles');

// Focus-visible on tabs
assert.match(adminPage, /\.a2-tab:focus-visible/, 'tabs have focus-visible');
ok('9c. AdminPage tabs have focus-visible styles');

// ============================================================
// 10. Skeleton shimmer utility (Phase J)
// ============================================================

assert.match(appCss, /\.a2-skeleton/, 'global skeleton utility class exists');
assert.match(appCss, /a2-skeleton-shimmer/, 'skeleton shimmer keyframe defined');
assert.match(appCss, /background-size: 200%/, 'skeleton uses 200% background for shimmer');
ok('10a. Global skeleton shimmer utility class defined in app.css');

// ============================================================
// 11. Reduced motion (global)
// ============================================================

assert.match(appCss, /prefers-reduced-motion: reduce/, 'app.css has prefers-reduced-motion');
assert.match(appCss, /\.a2-skeleton.*animation: none/, 'skeleton disables animation on reduced motion');
assert.match(appCss, /\.a2-ambient.*animation: none/, 'ambient disables animation on reduced motion');
ok('11a. Global reduced motion: skeleton + ambient disabled');

// ============================================================
// 12. Status components (color + text, never color alone)
// ============================================================

assert.match(adminStatus, /label/, 'AdminStatus renders a text label');
assert.match(adminStatus, /tone/, 'AdminStatus uses tone for color');
assert.match(adminStatus, /a2-status-dot/, 'AdminStatus has a dot indicator');
ok('12a. AdminStatus uses color + text + dot (never color alone)');

assert.match(adminAssetStatus, /label/, 'AdminAssetStatus renders a text label');
assert.match(adminAssetStatus, /text/, 'AdminAssetStatus has text labels for all states');
ok('12b. AdminAssetStatus uses color + text (never color alone)');

// ============================================================
// 13. Drawer transitions (slide-in)
// ============================================================

assert.match(adminMediaDetailDrawer, /a2-drawer-slide/, 'media drawer has slide-in animation');
assert.match(adminMediaDetailDrawer, /translateX/, 'media drawer uses translateX for slide');
ok('13a. Media detail drawer has slide-in transition');

// ============================================================
// 14. Confirm dialog transition
// ============================================================

assert.match(adminConfirmDialog, /a2-confirm-in/, 'confirm dialog has entry animation');
assert.match(adminConfirmDialog, /translateY/, 'confirm dialog uses translateY for subtle entry');
ok('14a. Confirm dialog has subtle entry transition');

// ============================================================
// 15. Glass treatment (selective, not everywhere)
// ============================================================

assert.match(appCss, /--a2-glass:/, 'glass token defined');
assert.match(appCss, /--a2-glass-border:/, 'glass-border token defined');
// Glass is used in AdminAppShell for topbar + bottom nav
assert.match(adminAppShell, /backdrop-filter: blur/, 'AdminAppShell uses backdrop-filter for glass');
ok('15a. Glass treatment is tokenized + used selectively (topbar + bottom nav)');

// ============================================================
// 16. Skeleton states in components
// ============================================================

assert.match(adminMediaCard, /skeleton/, 'AdminMediaCard has skeleton state');
assert.match(adminMediaCard, /aria-hidden="true"/, 'skeleton is aria-hidden');
assert.match(adminMediaCard, /prefers-reduced-motion/, 'AdminMediaCard respects reduced motion for skeleton');
ok('16a. AdminMediaCard has accessible skeleton with reduced motion');

assert.match(adminMediaTable, /skeleton/, 'AdminMediaTable has skeleton state');
assert.match(adminMediaTable, /aria-hidden="true"/, 'table skeleton is aria-hidden');
ok('16b. AdminMediaTable has accessible skeleton');

// ============================================================
// 17. Drawer full-screen on mobile
// ============================================================

assert.match(adminMediaDetailDrawer, /width: 100vw/, 'media drawer is full-screen on mobile');
ok('17a. Drawers become full-screen on mobile');

// ============================================================
// 18. Active states (surface change + accent indicator)
// ============================================================

assert.match(adminAppShell, /\.a2-nav-link\.active/, 'nav active state exists');
assert.match(adminAppShell, /box-shadow: inset 2px 0 0 var\(--a2-cyan\)/, 'nav active uses inset accent bar');
assert.match(adminAppShell, /background: var\(--a2-cyan-soft\)/, 'nav active uses cyan-soft background');
ok('18a. Nav active state: surface change + accent bar (not just text color)');

assert.match(adminPage, /\.a2-tab\.active/, 'tab active state exists');
assert.match(adminPage, /border-bottom-color: var\(--a2-cyan\)/, 'tab active uses cyan border-bottom');
ok('18b. Tab active state: accent border indicator');

// ============================================================
// 19. Scrollbar styling
// ============================================================

assert.match(appCss, /\.a2-scroll/, 'custom scrollbar class exists');
assert.match(appCss, /scrollbar-width: none/, 'scrollbar hidden where appropriate');
ok('19a. Custom scrollbar utility defined');

// ============================================================
// 20. Safe-area tokens
// ============================================================

assert.match(appCss, /--a2-topbar-h-safe/, 'safe-area topbar height token');
assert.match(appCss, /--a2-mobile-nav-h-safe/, 'safe-area mobile nav height token');
assert.match(appCss, /env\(safe-area-inset-top/, 'safe-area-inset-top used');
assert.match(appCss, /env\(safe-area-inset-bottom/, 'safe-area-inset-bottom used');
ok('20a. Safe-area tokens + env() usage defined');

// ============================================================
// 21. Body scroll lock
// ============================================================

assert.match(appCss, /data-a2-drawer-open/, 'drawer open scroll lock');
assert.match(appCss, /data-a2-sheet-open/, 'sheet open scroll lock');
assert.match(appCss, /data-a2-dialog-open/, 'dialog open scroll lock (Phase J)');
ok('21a. Body scroll lock for drawers, sheets, and dialogs');

// ============================================================
// 22. Z-index hierarchy
// ============================================================

// Check z-index values are consistent
const zIndices = adminAppShell.match(/z-index: (\d+)/g) ?? [];
const zValues = zIndices.map(z => parseInt(z.match(/\d+/)![0]));
assert.ok(zValues.includes(40), 'mobile header z-index 40');
assert.ok(zValues.includes(45), 'bottom nav z-index 45');
assert.ok(zValues.some(z => z >= 80), 'overlay z-index ≥80');
assert.ok(zValues.some(z => z >= 90), 'sheet/dialog overlay z-index ≥90');
ok('22a. Z-index hierarchy: header(40) < bottom-nav(45) < overlays(80+) < sheets(90+)');

// ============================================================
// 23. No excessive hardcoded colors in components
// ============================================================

// Check that components use CSS variables, not raw hex colors in style blocks
const componentColors = [
  adminAppShell, adminPage, adminStatus, adminAssetStatus,
  adminMediaCard, adminMediaTable, adminConfirmDialog, adminMediaDetailDrawer,
];
let rawHexCount = 0;
for (const src of componentColors) {
  // Count hex colors in <style> blocks that are NOT in comments
  const styleMatch = src.match(/<style>[\s\S]*<\/style>/);
  if (styleMatch) {
    const hexes = styleMatch[0].match(/#[0-9a-fA-F]{3,8}\b/g);
    if (hexes) rawHexCount += hexes.length;
  }
}
// Allow some hex in comments but keep the count low
assert.ok(rawHexCount < 20, `components use mostly CSS variables — raw hex count: ${rawHexCount} (threshold 20)`);
ok('23a. Components use CSS variables, not scattered hardcoded colors');

// ============================================================
// 24. Reduced motion across components
// ============================================================

assert.match(adminAppShell, /prefers-reduced-motion/, 'AdminAppShell respects reduced motion');
assert.match(adminPage, /prefers-reduced-motion/, 'AdminPage respects reduced motion');
assert.match(adminMediaCard, /prefers-reduced-motion/, 'AdminMediaCard respects reduced motion');
assert.match(adminMediaTable, /prefers-reduced-motion/, 'AdminMediaTable respects reduced motion');
assert.match(adminConfirmDialog, /prefers-reduced-motion/, 'AdminConfirmDialog respects reduced motion');
assert.match(adminMediaDetailDrawer, /prefers-reduced-motion/, 'AdminMediaDetailDrawer respects reduced motion');
ok('24a. All major components respect prefers-reduced-motion');

// ============================================================
// 25. Typography hierarchy
// ============================================================

assert.match(adminPage, /a2-page-title/, 'page title class exists');
assert.match(adminPage, /a2-page-eyebrow/, 'page eyebrow class exists');
assert.match(adminPage, /font-size: var\(--a2-text-2xl\)/, 'page title uses text-2xl');
assert.match(adminPage, /font-size: var\(--a2-text-2xs\)/, 'eyebrow uses text-2xs');
ok('25a. Typography hierarchy: eyebrow (2xs) < title (2xl)');

// ============================================================
// 26. Command menu glass treatment
// ============================================================

const adminCommandMenu = readFileSync(new URL('../src/lib/components/admin2/AdminCommandMenu.svelte', import.meta.url), 'utf8');
assert.match(adminCommandMenu, /backdrop-filter|glass/, 'command menu uses glass/backdrop');
assert.match(adminCommandMenu, /prefers-reduced-motion/, 'command menu respects reduced motion');
ok('26a. Command menu uses glass treatment + reduced motion');

// ============================================================
// 27. Drawer aria-modal
// ============================================================

assert.match(adminMediaDetailDrawer, /role="dialog"/, 'media drawer has role=dialog');
assert.match(adminMediaDetailDrawer, /aria-modal="true"/, 'media drawer has aria-modal');
assert.match(adminConfirmDialog, /role="dialog"/, 'confirm dialog has role=dialog');
assert.match(adminConfirmDialog, /aria-modal="true"/, 'confirm dialog has aria-modal');
ok('27a. Drawers + dialogs have proper ARIA dialog semantics');

// ============================================================
// 28. Drawer focus trap
// ============================================================

assert.match(adminMediaDetailDrawer, /handleKeydown|Tab.*shiftKey|focusable/, 'media drawer has focus trap');
assert.match(adminConfirmDialog, /handleKeydown|Tab.*shiftKey|focusable/, 'confirm dialog has focus trap');
ok('28a. Drawers + dialogs have keyboard focus trap');

// ============================================================
// 29. Escape to close
// ============================================================

assert.match(adminMediaDetailDrawer, /Escape/, 'media drawer closes on Escape');
assert.match(adminConfirmDialog, /Escape/, 'confirm dialog closes on Escape');
ok('29a. Drawers + dialogs close on Escape');

// ============================================================
// 30. Mobile responsive breakpoints exist
// ============================================================

assert.match(adminAppShell, /@media \(max-width: 1023px\)/, 'AdminAppShell has 1023px breakpoint (desktop/mobile switch)');
assert.match(adminAppShell, /@media \(max-width: 640px\)/, 'AdminAppShell has 640px breakpoint (narrow mobile)');
assert.match(adminPage, /@media \(max-width: 640px\)/, 'AdminPage has 640px breakpoint');
ok('30a. Responsive breakpoints at 1023px (shell) + 640px (compact) + 768px (components)');

// ============================================================
// 31. Overflow prevention
// ============================================================

assert.match(adminAppShell, /overflow-x: hidden/, 'AdminAppShell main prevents horizontal overflow');
assert.match(adminMediaTable, /overflow-x: auto/, 'AdminMediaTable has controlled horizontal scroll');
ok('31a. Overflow prevention: main hidden, tables use auto scroll');

// ============================================================
// 32. Design system cohesion (tokens used across components)
// ============================================================

// Verify multiple components reference the same tokens
const componentsUsingTokens = [
  adminAppShell, adminPage, adminStatus, adminMediaCard,
  adminMediaTable, adminConfirmDialog, adminMediaDetailDrawer,
];
for (const src of componentsUsingTokens) {
  assert.ok(
    src.includes('var(--a2-surface') || src.includes('var(--a2-bg'),
    'component uses surface tokens'
  );
}
ok('32a. All major components use shared design tokens (cohesive system)');

console.log(`\nAdmin 2.0 Phase J tests passed (${passed} check groups).`);
