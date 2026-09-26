import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  createDevtoolGuard,
  DEVTOOL_BLOCKED_MESSAGE,
  DEVTOOL_BLOCKED_PAGE_HTML,
  syncDevtoolProtection,
  type DevtoolGuardHooks,
} from '$lib/client/devtool-protection';

/**
 * DevTools protection (disable-devtool integration) — regression suite.
 *
 * Covers the integration contract end to end:
 *
 *   1.  disable-devtool dependency installed & pinned
 *   2.  client-only initialization (no SSR/browser access at import)
 *   3.  guest -> detector enabled
 *   4.  authenticated normal user -> detector enabled
 *   5.  admin -> detector NOT initialized
 *   6.  admin determination never relies on client-controlled data
 *   7.  DevTools callback triggers the replacement behavior
 *   8.  replacement does not expose the original Mavero UI
 *   9.  no redirect/reload loop
 *   10. no duplicate detector initialization
 *   11. SPA navigation does not disable the protection
 *   12. logout/login transitions leave no stale admin exemption
 *   13. player route still loads correctly (source isolation)
 *   14. provider iframe/postMessage behavior unchanged
 *   15. fullscreen/PiP behavior unchanged
 *   16. mobile/PWA routes remain functional
 *   17. existing admin routes remain functional
 *   18. SSR/build hygiene (module importable outside the browser)
 *
 * The test is intentionally split: sections A/B are BEHAVIORAL (the
 * pure guard state machine from src/lib/client/devtool-protection.ts is
 * exercised under node with injected hooks — importing it at all proves
 * the module has no top-level browser access, i.e. SSR-safe), and the
 * remaining sections are SOURCE-LEVEL static assertions in the
 * established repo style (see phase2_session_projection_test.ts).
 */

let passed = 0;
function ok(condition: unknown, label: string) {
  assert.ok(condition, label);
  passed += 1;
  console.log(`  ok ${passed} - ${label}`);
}

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative: string) => readFileSync(path.join(REPO_ROOT, relative), 'utf8');

/** Flushes pending promise microtasks so guard state transitions settle. */
const tick = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

// ============================================================
// A. Behavioral — guard state machine (pure, node-executable).
//    Importing the module already proves section 18's import-time
//    browser-freedom; the sections below exercise the logic.
// ============================================================

function makeFakeHooks() {
  const calls = { start: 0, suspend: 0, resume: 0 };
  let resolveStart: ((result: 'running' | 'declined') => void) | null = null;
  const hooks: DevtoolGuardHooks = {
    start() {
      calls.start += 1;
      return new Promise<'running' | 'declined'>((resolve) => {
        resolveStart = resolve;
      });
    },
    suspend() {
      calls.suspend += 1;
    },
    resume() {
      calls.resume += 1;
    },
  };
  return {
    hooks,
    calls,
    resolve: (result: 'running' | 'declined') => {
      const r = resolveStart;
      resolveStart = null;
      r?.(result);
    },
  };
}

// --- A1/A10: duplicate sync never starts twice -------------------------------
{
  const { hooks, calls, resolve } = makeFakeHooks();
  const guard = createDevtoolGuard(hooks);
  guard.sync(false); // guest -> start
  guard.sync(false); // repeated non-exempt sync (effect re-run, HMR)
  guard.sync(false); // again
  ok(calls.start === 1, 'A1a. repeated non-exempt syncs start the detector exactly once');
  ok(guard.state === 'initializing', 'A1b. guard is initializing before the start resolves');
  resolve('running');
  await tick();
  ok(guard.state === 'active', 'A1c. guard becomes active when the start resolves');
  guard.sync(false); // still active
  ok(calls.start === 1, 'A1d. no second start while active (no duplicate detector)');
}

// --- A5: admin never initializes ---------------------------------------------
{
  const { hooks, calls } = makeFakeHooks();
  const guard = createDevtoolGuard(hooks);
  guard.sync(true); // admin from the very first effect run
  guard.sync(true);
  ok(calls.start === 0, 'A5a. exempt (admin) document NEVER calls start — detector not initialized');
  ok(calls.suspend === 0, 'A5b. nothing to suspend for an admin (never initialized)');
  ok(guard.state === 'uninitialized', 'A5c. admin guard stays uninitialized');
}

// --- A12: auth transitions (SPA) — suspend/resume, no stale state -----------
{
  const { hooks, calls, resolve } = makeFakeHooks();
  const guard = createDevtoolGuard(hooks);
  guard.sync(false); // guest/normal user browsing
  resolve('running');
  await tick();
  ok(guard.state === 'active', 'A12a. detector active for the non-exempt document');
  guard.sync(true); // user becomes admin mid-session (QR login + invalidateAll)
  ok(calls.suspend === 1, 'A12b. active detector is suspended when the exemption arrives');
  ok(guard.state === 'suspended', 'A12c. guard is suspended (not destroyed — no stale init either way)');
  guard.sync(false); // admin exemption disappears (logout transition)
  ok(calls.resume === 1, 'A12d. suspended detector resumes when the exemption disappears');
  ok(guard.state === 'active', 'A12e. guard is active again — no stale admin exemption');
  ok(calls.start === 1, 'A12f. transitions never re-initialize (still exactly one detector)');
}

// --- A12 (cont.): exemption arriving DURING initialization -----------------
{
  const { hooks, calls, resolve } = makeFakeHooks();
  const guard = createDevtoolGuard(hooks);
  guard.sync(false); // guest starts loading the detector chunk
  guard.sync(true); // exemption lands before the chunk finished loading
  resolve('running');
  await tick();
  ok(guard.state === 'suspended', 'A12g. late-arriving exemption suspends the just-started detector');
  ok(calls.suspend === 1, 'A12h. suspend was invoked on completion');
  guard.sync(false); // and back
  ok(guard.state === 'active', 'A12i. resume path works after late suspension');
}

// --- A10 (cont.): failed start allows a later retry ------------------------
{
  // A start that rejects (e.g. transient detector-chunk fetch failure)
  // must revert the guard to uninitialized so a later sync can retry —
  // and must never wedge the guard in 'initializing' forever.
  let startCount = 0;
  let rejectFirst: ((e: Error) => void) | null = null;
  const rejectingHooks: DevtoolGuardHooks = {
    start() {
      startCount += 1;
      return startCount === 1
        ? new Promise<'running' | 'declined'>((_resolve, reject) => { rejectFirst = reject; })
        : Promise.resolve<'running' | 'declined'>('running');
    },
    suspend() {},
    resume() {},
  };
  const guard = createDevtoolGuard(rejectingHooks);
  guard.sync(false);
  const originalError = console.error;
  console.error = () => {};
  try {
    rejectFirst?.(new Error('chunk load failure'));
    await tick();
  } finally {
    console.error = originalError;
  }
  ok(guard.state === 'uninitialized', 'A10a. rejected start reverts to uninitialized (retryable, never wedged)');
  guard.sync(false);
  ok(startCount === 2, 'A10b. a later sync retries the start after a failure');
}

// --- Declined (crawler) is terminal ------------------------------------------
{
  const { hooks, calls, resolve } = makeFakeHooks();
  const guard = createDevtoolGuard(hooks);
  guard.sync(false);
  resolve('declined'); // library skipped (crawler/Lighthouse UA)
  await tick();
  ok(guard.state === 'settled', 'A16a. crawler document settles without a detector');
  guard.sync(false);
  guard.sync(true);
  ok(calls.start === 1, 'A16b. settled state is terminal — no churn');
}

// ============================================================
// B. Behavioral — blocked (replacement) page content.
// ============================================================
{
  ok(DEVTOOL_BLOCKED_MESSAGE === 'Page unavailable.', 'B1a. blocked message is the generic "Page unavailable."');
  ok(DEVTOOL_BLOCKED_PAGE_HTML.includes(DEVTOOL_BLOCKED_MESSAGE), 'B1b. blocked page carries the generic message');
  // Full-viewport coverage — the blocked page must not leave the app
  // visible around itself.
  ok(/html,body\{[^}]*height:100%/.test(DEVTOOL_BLOCKED_PAGE_HTML), 'B1c. blocked page covers the full viewport (html+body 100%)');
  ok(/background:#050708/.test(DEVTOOL_BLOCKED_PAGE_HTML), 'B1d. opaque app-palette background — nothing shows through');
  // Non-disclosure contract: no detector/library/provider/route/API
  // details on the replacement page.
  const lower = DEVTOOL_BLOCKED_PAGE_HTML.toLowerCase();
  for (const forbidden of ['devtool', 'detector', 'disable-devtool', 'f12', 'inspect', 'debugger', 'provider', 'iframe', '/api/', '/watch', '/admin', '/auth', 'supabase', 'profile', 'admin', 'embed', 'postmessage', 'console', 'hook', 'script src', 'http://', 'https://']) {
    ok(!lower.includes(forbidden), `B2. blocked page does not expose "${forbidden}"`);
  }
  // Static, self-contained markup: no external resources, no scripts.
  ok(!/<script/i.test(DEVTOOL_BLOCKED_PAGE_HTML), 'B3a. blocked page contains no scripts');
  ok(!/<(img|link|iframe|video|audio)\b/i.test(DEVTOOL_BLOCKED_PAGE_HTML), 'B3b. blocked page loads no external resources');
  ok(/<meta name="viewport"/.test(DEVTOOL_BLOCKED_PAGE_HTML), 'B3c. blocked page is mobile-correct (viewport meta)');
  ok(/<title>Page unavailable\.<\/title>/.test(DEVTOOL_BLOCKED_PAGE_HTML), 'B3d. blocked page title is generic');
}

// ============================================================
// 1. Dependency installed & pinned.
// ============================================================
{
  const pkg = JSON.parse(read('package.json'));
  ok(pkg.dependencies && typeof pkg.dependencies['disable-devtool'] === 'string', '1a. disable-devtool present in dependencies');
  ok(pkg.dependencies['disable-devtool'] === '0.3.9', '1b. disable-devtool pinned to the exact audited version 0.3.9');
  const lock = read('pnpm-lock.yaml');
  ok(/disable-devtool@0\.3\.9/.test(lock), '1c. pnpm-lock.yaml records disable-devtool@0.3.9');
  const libPkg = JSON.parse(read('node_modules/disable-devtool/package.json'));
  ok(libPkg.version === '0.3.9', '1d. installed package is 0.3.9');
}

// ============================================================
// 2/18. Client-only initialization.
// ============================================================
const protectionModule = read('src/lib/client/devtool-protection.ts');
{
  // The library is reachable ONLY through a dynamic import executed
  // inside start() — no static value import, no top-level evaluation,
  // so the SSR/server bundle never runs it and the browser only loads
  // the chunk on the non-exempt path.
  ok(/await import\('disable-devtool'\)/.test(protectionModule), '2a. library loaded via dynamic import inside start()');
  ok(!/^import\s+(?!type)/m.test(protectionModule), '2b. protection module has no static value imports at all (type-only allowed)');
  const layoutSvelte = read('src/routes/+layout.svelte');
  ok(/\$effect\(\(\)\s*=>\s*\{[\s\S]*?syncDevtoolProtection\(/.test(layoutSvelte), '2c. initialization driven from a root-layout $effect (client-only lifecycle)');
  ok(!/onMount\([^)]*syncDevtoolProtection/.test(layoutSvelte), '2d. protection not tied to onMount remount semantics');
}

// ============================================================
// 3/4/5/6. Server-resolved exemption — guest, user, admin, sources.
// ============================================================
const layoutServer = read('src/routes/+layout.server.ts');
const adminAuth = read('src/lib/server/streaming/admin-auth.ts');
{
  // Guest: exempt=false, and the guest branch returns BEFORE any
  // profiles lookup — guests need no account for protection.
  ok(/if \(!user\) \{\s*\n\s*\/\/ Guests are NOT exempt[\s\S]*?devtoolExempt: false/.test(layoutServer), '3a. guest branch resolves devtoolExempt: false');
  ok(/devtoolExempt: false[\s\S]*?\}\s*\n\s*const userMeta/.test(layoutServer), '3b. guest branch returns before the profiles lookup (no login required for protection)');
  // Authenticated: resolved through the canonical profiles.role check.
  ok(/isAdminUser\(locals\.supabase,\s*user\.id\)/.test(layoutServer), '4a. authenticated exemption resolved via isAdminUser (profiles.role)');
  ok(/export async function isAdminUser/.test(adminAuth), '4b. isAdminUser exported from the canonical admin-auth module');
  ok(/from\('profiles'\)[\s\S]*?select\('role'\)[\s\S]*?eq\('id',\s*userId\)/.test(adminAuth), '4c. isAdminUser queries profiles.role by the authenticated user id');
  ok(/data\?\.role === 'admin'/.test(adminAuth), '4d. exemption is true only for profiles.role === "admin"');
  ok(/return false;[\s\S]*?return data\?\.role === 'admin'/.test(adminAuth), '4e. lookup errors fail CLOSED (protection stays on)');
  // Admin: never initialized (behavioral A5) — and the layout only
  // feeds the boolean to the client.
  ok(/devtoolExempt: boolean/.test(read('src/app.d.ts')), '5a. PageData declares devtoolExempt: boolean (minimal capability projection)');
  // 6. No client-controlled admin determination. Comment text is
  // stripped first (same technique as phase2_session_projection_test)
  // so the module's own security documentation — which names the
  // forbidden sources explicitly — does not false-positive.
  const protectionCode = protectionModule
    .replace(/\/\*[\s\S]*?\*\//g, '') // block comments
    .replace(/\/\/[^\n]*/g, ''); // line comments
  ok(!/localStorage/.test(protectionCode) && !/sessionStorage/.test(protectionCode), '6a. protection module never reads web storage');
  ok(!/document\.cookie/.test(protectionCode), '6b. protection module never reads cookies');
  ok(!/location\.(search|hash|href)/.test(protectionCode), '6c. protection module never reads the URL');
  ok(!/searchParams/.test(protectionCode), '6d. protection module never reads query parameters');
  const layoutSvelte = read('src/routes/+layout.svelte');
  ok(/syncDevtoolProtection\(data\.devtoolExempt === true\)/.test(layoutSvelte), '6e. the ONLY exemption input is the server layout data boolean');
  ok(!/devtoolExempt\s*[:=]\s*true/.test(protectionCode), '6f. no hardcoded exemption in client code');
}

// ============================================================
// 7/8/9. Detection -> replacement behavior (source wiring).
// ============================================================
{
  ok(/ondevtoolopen:\s*handleDevtoolOpen/.test(protectionModule), '7a. library wired to the replacement handler via ondevtoolopen');
  ok(/function handleDevtoolOpen\(\)[\s\S]*?document\.documentElement\.innerHTML = DEVTOOL_BLOCKED_PAGE_HTML/.test(protectionModule), '7b. callback replaces the ENTIRE document content (head + body)');
  ok(/pauseAllMedia\(\);/.test(protectionModule) && /el\.pause\(\)/.test(protectionModule), '7c. playing media is paused before replacement (no audio leak from detached elements)');
  ok(/console\.clear\(\)/.test(protectionModule), '7d. detection logs are cleared (detector type not exposed)');
  ok(/documentElement\.textContent = DEVTOOL_BLOCKED_MESSAGE/.test(protectionModule), '8a. fallback still stops exposing the app if innerHTML is refused');
  // 9. No navigation of any kind — in-document replacement only.
  ok(!/location\.(href|replace|assign)\s*=/.test(protectionModule), '9a. protection module never navigates (no location writes)');
  ok(!/window\.(open|close)/.test(protectionModule), '9b. protection module never opens/closes windows');
  ok(!/history\.(back|go|pushState|replaceState)/.test(protectionModule), '9c. protection module never touches history');
  ok(!/goto\(/.test(protectionModule), '9d. protection module never performs SPA navigation');
  ok(/clearIntervalWhenDevOpenTrigger:\s*true/.test(protectionModule), '9e. detector stops after the first trigger (terminal, deterministic — no repeat triggers)');
  // The library's own default action (close/redirect) must not be
  // invoked: the handler ignores the `next` parameter entirely.
  ok(/function handleDevtoolOpen\(\): void \{/.test(protectionModule), '9f. handler signature ignores the library default action (next not invoked)');
}

// ============================================================
// 10. No duplicate initialization.
// ============================================================
{
  ok(/const maveroDevtoolGuard/.test(protectionModule), '10a. module-level singleton guard (one per browser document)');
  ok(/result\.reason === 'already running'/.test(protectionModule), '10b. an already-running detector is adopted, never double-initialized');
  ok(/export function syncDevtoolProtection/.test(protectionModule), '10c. single exported sync entry point');
}

// ============================================================
// 11/12. SPA navigation + auth transitions.
// ============================================================
{
  const layoutSvelte = read('src/routes/+layout.svelte');
  ok(/never unmounts during SPA navigation/.test(layoutSvelte), '11a. root-layout init documented as document-scoped (survives SPA navigation)');
  ok(!/onDestroy\([\s\S]*?syncDevtoolProtection/.test(layoutSvelte) && !/\$effect\(\(\)\s*=>\s*\{[\s\S]*?return \(\)\s*=>\s*\{[\s\S]*?syncDevtoolProtection/.test(layoutSvelte), '11b. no teardown of the protection on unmount');
  // Behavioral suspend/resume coverage lives in section A12.
  const signIn = read('src/routes/auth/sign-in/+page.server.ts');
  ok(/throw redirect\(303, next\)/.test(signIn), '12a. sign-in completes with a full-page 303 redirect (fresh layout data)');
  const signOut = read('src/routes/auth/sign-out/+server.ts');
  ok(/throw redirect\(303, '\/discover'\)/.test(signOut), '12b. sign-out completes with a full-page 303 redirect (fresh layout data)');
  const tvLogin = read('src/routes/tv-login/+page.svelte');
  ok(/invalidateAll\(\)/.test(tvLogin), '12c. QR big-screen login refreshes root layout data (invalidateAll) — SPA auth transitions re-sync');
}

// ============================================================
// 13/14/15. Player, provider iframe/postMessage, fullscreen/PiP.
// ============================================================
{
  ok(!/from '\$lib\/(client\/player|shared\/player)/.test(protectionModule), '13a. protection module imports nothing from the player subsystem');
  ok(!/postMessage/.test(protectionModule), '14a. protection module never touches postMessage');
  ok(/disableIframeParents:\s*false/.test(protectionModule), '14b. iframe-parent walk explicitly disabled (detector never injected into parent/third-party documents)');
  ok(!/querySelector\((['"])(iframe|frame)/.test(protectionModule), '14c. protection module never queries/manipulates provider iframes');
  ok(!/requestFullscreen|exitFullscreen|pictureInPicture|webkitSetPresentationMode/i.test(protectionModule), '15a. protection module never touches fullscreen/PiP APIs');
  // The watch/player routes must not have been modified to know about
  // the protection (isolation — the full player test chain still
  // covers their behavior).
  const watchPage = read('src/routes/watch/[type]/[id]/+page.svelte');
  ok(!/devtool/i.test(watchPage), '13b. watch page has no devtool coupling (isolation preserved)');
  const watchServer = read('src/routes/watch/[type]/[id]/+page.server.ts');
  ok(!/devtool/i.test(watchServer), '13c. watch server load has no devtool coupling');
}

// ============================================================
// 16. Mobile/PWA friendliness.
// ============================================================
{
  ok(/seo:\s*true/.test(protectionModule), '16a. crawler/Lighthouse skip kept enabled (PWA audits unaffected)');
  ok(!/stopIntervalTime\s*:/.test(protectionModule), '16b. library default mobile detection window preserved (no aggressive override)');
  ok(!/interval\s*:/.test(protectionModule), '16c. library default detection interval preserved');
  ok(!/(disableSelect|disableCopy|disableCut|disablePaste|disableInputSelect)\s*:\s*true/.test(protectionModule), '16d. selection/copy/cut/paste remain ENABLED (normal input behavior)');
  ok(/disableMenu:\s*true/.test(protectionModule), '16e. right-click context menu disabled (desktop) per contract');
  // The library bundle itself keeps the touch long-press exemption.
  const libBundle = read('node_modules/disable-devtool/disable-devtool.min.js');
  ok(/pointerType/.test(libBundle), '16f. installed library keeps touch long-press context menu available');
  ok(/maxTouchPoints/.test(libBundle), '16g. installed library keeps its mobile-aware detection window');
}

// ============================================================
// 17. Existing admin authorization unchanged.
// ============================================================
{
  ok(/export async function requireAdmin/.test(adminAuth), '17a. requireAdmin still exported and unchanged in shape');
  ok(/export async function assertAdminClient/.test(adminAuth), '17b. assertAdminClient still exported and unchanged in shape');
  ok(/profile\?\.role !== 'admin'/.test(adminAuth), '17c. requireAdmin still enforces profiles.role === admin (source of truth)');
  const adminPage = read('src/routes/admin/+page.server.ts');
  ok(/requireAdmin\(locals, \{ redirectTo: '\/admin' \}\)/.test(adminPage), '17d. admin routes still gate through requireAdmin');
}

// ============================================================
// 18. SSR/build hygiene.
// ============================================================
{
  // Section A already imported the module under node with no window,
  // document, or navigator available — import-time browser-freedom is
  // proven behaviorally. Static additions:
  const layoutServerCode = read('src/routes/+layout.server.ts');
  ok(!/devtool-protection/.test(layoutServerCode), '18a. the server layout never imports the client protection module (SSR boundary)');
  ok(!/disable-devtool/.test(layoutServerCode), '18b. the server layout never imports the detector library');
  ok(!/^import\s+'disable-devtool'/m.test(protectionModule) && !/^import\s+\w+\s+from\s+'disable-devtool'/m.test(protectionModule), '18c. no static import of the library anywhere in the module');
  // svelte-check + vite build are executed in CI (pnpm check/build) —
  // this suite pins the source-level invariants they cannot express.
  ok(typeof syncDevtoolProtection === 'function', '18d. sync entry point exported for the root layout');
}

console.log(`devtool_protection_test: ${passed} checks passed (disable-devtool integration contract)`);
