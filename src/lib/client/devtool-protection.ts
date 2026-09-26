/**
 * DevTools protection — client layer (disable-devtool integration).
 *
 * Goal (per the integration contract): for guests and normal users,
 * opening DevTools is detected and the visible Mavero content is
 * immediately replaced with a generic, Mavero-branded blocked page.
 * Authenticated administrators are exempt — the detector is never
 * initialized for them at all.
 *
 * SECURITY MODEL — read before editing:
 *   - This is a DETERRENCE layer, not a security boundary. Anything the
 *     client does can be defeated by a determined user. Server-side
 *     authorization (requireAdmin / Supabase RLS / is_admin()) is
 *     completely unaffected by this module and remains the ONLY source
 *     of truth for privileged operations.
 *   - The admin exemption is resolved by the SERVER (root layout load:
 *     authenticated session -> profiles.role === 'admin', see
 *     src/lib/server/streaming/admin-auth.ts isAdminUser) and reaches
 *     this module exclusively as the `devtoolExempt` boolean in the
 *     layout data. This module NEVER reads localStorage,
 *     sessionStorage, URL parameters, cookies, or any other
 *     client-controlled value to decide the exemption — there is no
 *     client-side bypass by construction.
 *
 * ARCHITECTURE:
 *   - The root layout (+layout.svelte) calls syncDevtoolProtection()
 *     from a $effect that tracks data.devtoolExempt. The root layout
 *     mounts exactly once per document and never unmounts during SPA
 *     navigation, so there is exactly ONE guard per browser document.
 *   - Module-level singleton + the library's own isRunning guard make
 *     duplicate initialization impossible (HMR remounts, repeated
 *     effect runs, double layout mounts).
 *   - The library is loaded via dynamic import inside start(). This
 *     module has NO top-level browser access (importable under SSR /
 *     plain node — covered by regression tests) and the detector chunk
 *     never loads for exempt (admin) documents at all.
 *   - Auth transitions: sign-in/sign-out are full-page navigations
 *     (fresh layout data). The QR big-screen login calls
 *     invalidateAll(), which re-runs the root layout server load —
 *     the effect then re-syncs: a detector that is already active for
 *     a document that becomes admin-owned is SUSPENDED (library
 *     isSuspend flag: detection + keyboard/menu blocking), and
 *     resumed when the exemption disappears. No stale exemption can
 *     outlive its server-resolved source.
 *
 * DETECTOR SET (pinned deliberately — see start()):
 *   DefineId, DateToString, FuncToString, Debugger, Performance,
 *   DebugLib — the library's curated default set. The two detectors
 *   the library authors removed from defaults are ALSO excluded here:
 *   Size (window-size heuristic; misfires with mobile keyboards and
 *   zoom) and RegToString (QQ Browser / Firefox misfires). On mobile
 *   the library itself stops the detection interval after
 *   stopIntervalTime (default 5s) — its built-in false-positive /
 *   performance mitigation — and crawler/Lighthouse user agents are
 *   skipped entirely (seo: true), so PWA/Lighthouse audits are not
 *   affected.
 */

// ---------------------------------------------------------------------------
// Guard state machine (pure — no browser access, unit-testable under node)
// ---------------------------------------------------------------------------

/**
 * Lifecycle of the per-document detector.
 *
 *  uninitialized -> initializing -> active <-> suspended
 *  initializing  -> settled   (library declined: crawler UA)
 *  uninitialized stays forever for admins (never initialized at all)
 */
export type DevtoolGuardState =
  | 'uninitialized'
  | 'initializing'
  | 'active'
  | 'suspended'
  | 'settled';

/** Result of a detector start attempt. */
export type DevtoolStartResult =
  /** The detector is now running in this document (or was already running). */
  | 'running'
  /** The library deterministically declined to run (e.g. crawler UA). */
  | 'declined';

/** Injected side effects — the real implementation is defined below. */
export interface DevtoolGuardHooks {
  start(): Promise<DevtoolStartResult>;
  suspend(): void;
  resume(): void;
}

export interface DevtoolGuardController {
  readonly state: DevtoolGuardState;
  /**
   * Re-syncs the desired exemption (server-resolved boolean) with the
   * detector lifecycle. Safe to call any number of times.
   */
  sync(exempt: boolean): void;
}

/**
 * Creates a per-document guard. The state machine guarantees:
 *   - admins (exempt before any init) NEVER trigger start();
 *   - start() is called at most once per state cycle (no duplicate
 *     initialization);
 *   - an exemption that arrives while the detector is initializing
 *     suspends it the moment the start resolves (never visibly active);
 *   - suspension is reversible (resume) so SPA auth transitions can
 *     never leave a stale state on either side.
 */
export function createDevtoolGuard(hooks: DevtoolGuardHooks): DevtoolGuardController {
  let state: DevtoolGuardState = 'uninitialized';
  let exemptDesired = false;

  function finishStart(result: DevtoolStartResult): void {
    if (state !== 'initializing') return; // defensive: never act twice
    if (result === 'running') {
      if (exemptDesired) {
        hooks.suspend();
        state = 'suspended';
      } else {
        state = 'active';
      }
    } else {
      // The library declined (crawler). Deterministic for this document
      // — no further syncs change anything.
      state = 'settled';
    }
  }

  return {
    get state() {
      return state;
    },
    sync(exempt: boolean) {
      exemptDesired = exempt;
      if (exempt) {
        if (state === 'active') {
          hooks.suspend();
          state = 'suspended';
        }
        // 'initializing' -> finishStart() suspends on completion.
        // 'uninitialized' (admin) -> intentionally nothing: the detector
        // is never initialized. 'suspended'/'settled' -> already off.
        return;
      }
      if (state === 'uninitialized') {
        state = 'initializing';
        hooks
          .start()
          .then(finishStart, () => {
            // Start failed (e.g. the lazy chunk could not be fetched).
            // Revert so a later sync can retry; protection is a
            // deterrence layer, so failing open to "not yet running"
            // for this document is acceptable and a full page load
            // re-attempts it.
            if (state === 'initializing') state = 'uninitialized';
            console.error('[DevtoolProtection] Detector failed to initialize.');
          });
        return;
      }
      if (state === 'suspended') {
        hooks.resume();
        state = 'active';
      }
      // 'active' -> already running. 'initializing' -> in flight.
      // 'settled' -> library declined; nothing to resume.
    },
  };
}

// ---------------------------------------------------------------------------
// Blocked (replacement) page
// ---------------------------------------------------------------------------

/** Generic, intentionally non-disclosing message. */
export const DEVTOOL_BLOCKED_MESSAGE = 'Page unavailable.';

/**
 * Full replacement markup for <html> children (head + body). Set as the
 * entire document content the moment DevTools opening is detected, so
 * the Mavero application UI (and any playing media) is removed from the
 * document — nothing of the app remains visible underneath.
 *
 * Content rules (integration contract):
 *   - generic message only: no detector type, no library name, no
 *     provider names, no internal route names, no API endpoints, no
 *     admin information, no security implementation details;
 *   - minimal Mavero branding using the app's own palette/typography
 *     (see src/app.css tokens) so the page reads as an intentional
 *     Mavero state rather than a browser error;
 *   - no navigation is performed: the replacement happens in-document,
 *     which makes it deterministic and loop-free (see handleDevtoolOpen).
 */
export const DEVTOOL_BLOCKED_PAGE_HTML =
  '<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><meta name="theme-color" content="#050708"><title>Page unavailable.</title>' +
  '<style>html,body{margin:0;padding:0;height:100%;background:#050708}' +
  "body{display:flex;align-items:center;justify-content:center;color:#9db3aa;font-family:Inter,ui-sans-serif,system-ui,-apple-system,'Segoe UI',Arial,sans-serif;-webkit-font-smoothing:antialiased}" +
  '.card{max-width:340px;padding:0 28px;text-align:center}' +
  '.brand{margin:0 0 20px;font-size:.68rem;font-weight:800;letter-spacing:.34em;text-transform:uppercase;color:#60736c}' +
  '.title{margin:0 0 10px;font-size:1.05rem;font-weight:700;letter-spacing:.01em;color:#f2fff8}' +
  '.note{margin:0;font-size:.8rem;line-height:1.65}' +
  '</style></head>' +
  '<body><main class="card"><p class="brand">Mavero</p><h1 class="title">Page unavailable.</h1>' +
  '<p class="note">Please close this page and open it again to continue.</p></main></body>';

/**
 * Best-effort media teardown before the document content is replaced.
 * A <video>/<audio> element keeps PLAYING (audio included) after it is
 * detached from the DOM, so removal alone would leak the playback.
 * Provider <iframe> players are torn down automatically when the
 * replacement removes them; Mavero never touches their internals.
 */
function pauseAllMedia(): void {
  try {
    document.querySelectorAll<HTMLMediaElement>('video, audio').forEach((el) => {
      try {
        el.pause();
        el.removeAttribute('src');
        el.load();
      } catch {
        // Best effort — never block the replacement.
      }
    });
  } catch {
    // Best effort — never block the replacement.
  }
}

/**
 * DevTools-opened handler (the library's ondevtoolopen callback).
 *
 * Contract:
 *   - immediately stop exposing the normal Mavero UI: the ENTIRE
 *     document content is replaced (head + body), so the application —
 *     and any player/iframe state — is gone from the visible page;
 *   - no navigation (no location change, no reload, no history use):
 *     the replacement is in-document and therefore deterministic and
 *     free of redirect/reload loops by construction;
 *   - no implementation details remain visible: the library's
 *     detection log (which names the detector type) is cleared, and the
 *     blocked page itself is generic;
 *   - the `next` parameter (the library's default close/redirect
 *     action) is deliberately NOT invoked — the default action would
 *     navigate away from Mavero.
 */
function handleDevtoolOpen(): void {
  pauseAllMedia();
  try {
    document.documentElement.innerHTML = DEVTOOL_BLOCKED_PAGE_HTML;
  } catch {
    // Environments that forbid innerHTML assignment (e.g.
    // trusted-types policies — not used by Mavero) must still stop
    // exposing the application: replace the document text instead.
    document.documentElement.textContent = DEVTOOL_BLOCKED_MESSAGE;
  }
  try {
    window.stop();
  } catch {
    // Best effort — halt in-flight resource loads.
  }
  try {
    console.clear();
  } catch {
    // Best effort — remove the library's detection log + residual logs.
  }
}

// ---------------------------------------------------------------------------
// Real hooks (the only place the library is touched)
// ---------------------------------------------------------------------------

/** Type-only reference to the library's exported function object. */
type DisableDevtoolModule = (typeof import('disable-devtool'))['default'];

/**
 * Live reference to the running detector instance (the library's
 * exported function object doubles as its controller). Kept only after
 * a successful start so suspend()/resume() are no-ops otherwise.
 */
let devtoolLib: DisableDevtoolModule | null = null;

/**
 * The library logs `You don't have permission to use DEVTOOL!【type = N】`
 * when a detector fires — that message names the detector type and
 * identifies the protection library, which the integration contract
 * forbids exposing. The message is suppressed here with a surgical
 * filter: ONLY console.warn calls whose first argument is a string
 * containing the library's distinctive uppercase "DEVTOOL" token are
 * dropped; every other console.warn (Mavero's own, dependencies') passes
 * through untouched. Verified: no Mavero code warns with that token.
 */
function installDevtoolWarnFilter(): void {
  const nativeWarn = console.warn.bind(console);
  console.warn = (...args: unknown[]) => {
    const first = args[0];
    if (typeof first === 'string' && first.includes('DEVTOOL')) return;
    nativeWarn(...args);
  };
}

/**
 * Starts the detector. Runs ONLY for non-exempt documents (see guard
 * state machine) — an admin document never executes this function.
 */
async function startProtection(): Promise<DevtoolStartResult> {
  const DisableDevtool = (await import('disable-devtool')).default;
  const { DetectorType } = DisableDevtool;

  installDevtoolWarnFilter();

  const result = DisableDevtool({
    // Replacement behavior — replaces the default close/redirect action.
    ondevtoolopen: handleDevtoolOpen,
    // Detector set: the library's curated default list, pinned
    // explicitly. Excludes Size and RegToString (false-positive prone —
    // removed from the library's own defaults). On iOS Chrome/Edge the
    // published bundle's Debugger detector is a harmless no-op (the
    // literal debugger statement is dropped by the library's minifier),
    // so no pause side effects exist in any environment.
    detectors: [
      DetectorType.DefineId,
      DetectorType.DateToString,
      DetectorType.FuncToString,
      DetectorType.Debugger,
      DetectorType.Performance,
      DetectorType.DebugLib,
    ],
    // Keyboard/menu protection: F12, Ctrl/Cmd+Shift+I/J,
    // Ctrl/Cmd+U/S view-source shortcuts, and the right-click context
    // menu (touch long-press stays available — the library exempts
    // pointerType 'touch'). Text selection and copy/cut/paste are left
    // enabled (library defaults) so normal input behavior is unchanged.
    disableMenu: true,
    // Mavero is never legitimately embedded (X-Frame-Options: DENY on
    // every route), so the library's parent-window handler walk is
    // explicitly disabled: handlers are registered on THIS document's
    // window only. Mavero's detector is never injected into any parent
    // or third-party iframe document, and provider iframes (children)
    // are not touched by this layer at all.
    disableIframeParents: false,
    // Stop the detection interval after the first trigger: the blocked
    // page is terminal, so repeated triggers (and repeated logs) would
    // add nothing. Deterministic end state.
    clearIntervalWhenDevOpenTrigger: true,
    // Keep the library's crawler/Lighthouse skip active (default) so
    // SEO audits and the PWA performance tooling are unaffected.
    seo: true,
    // Deliberately NOT set:
    //   md5/tkName — would create a URL-parameter bypass token;
    //   url/timeOutUrl — would navigate away from Mavero;
    //   rewriteHTML — the custom ondevtoolopen callback replaces the
    //     document itself (with console clearing);
    //   interval/stopIntervalTime/clearLog — library defaults
    //     (500ms / 5s mobile window / clear-on-tick) are used as-is;
    //   disableSelect/disableCopy/disableCut/disablePaste — stay false:
    //     normal copy/paste and selection must keep working.
  });

  // 'already running' can only happen after an HMR-style module
  // reload of THIS module (dev-only): the library still runs in the
  // document. Adopt it so suspend/resume keep working — never a second
  // detector instance.
  const running = result.success || result.reason === 'already running';
  if (running) devtoolLib = DisableDevtool;
  return running ? 'running' : 'declined';
}

// ---------------------------------------------------------------------------
// Module singleton — exactly one guard per browser document
// ---------------------------------------------------------------------------

const maveroDevtoolGuard: DevtoolGuardController = createDevtoolGuard({
  start: startProtection,
  suspend: () => {
    if (devtoolLib) devtoolLib.isSuspend = true;
  },
  resume: () => {
    if (devtoolLib) devtoolLib.isSuspend = false;
  },
});

/**
 * Re-syncs DevTools protection with the server-resolved exemption.
 * Called exclusively from the root layout's $effect with the layout
 * data's `devtoolExempt` (server truth: authenticated admin -> true;
 * guest / normal user -> false). Idempotent; safe under HMR.
 */
export function syncDevtoolProtection(exempt: boolean): void {
  maveroDevtoolGuard.sync(exempt);
}
