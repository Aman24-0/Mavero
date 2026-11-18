/**
 * TV status toast — Stage 2 diagnostics (widget build only).
 *
 * A retail TV has no devtools and no console: when a Stage-2 data fetch
 * fails, the failure must be VISIBLE on the screen (per the TV plan:
 * "if a fetch fails, the on-screen overlay/status shows the URL + error").
 * This renders a small NON-BLOCKING status strip at the bottom of the
 * screen — it never covers the app shell, auto-hides, and is dismissed by
 * Back/Escape. It is deliberately separate from the boot-error overlay:
 * a data-fetch failure is NOT a boot failure (the empty-state fallback
 * keeps the app usable).
 *
 * Only ever called from IS_WGT_BUILD-guarded code paths (production never
 * imports a call site — the module itself is side-effect-free until
 * showTvStatus is invoked).
 */

import { IS_WGT_BUILD } from '$lib/shared/build-mode';

const STATUS_ID = 'mavero-tv-status';
const AUTO_HIDE_MS = 9000;

let hideTimer: ReturnType<typeof setTimeout> | undefined;

function ensureStrip(): HTMLElement | null {
  try {
    let strip = document.getElementById(STATUS_ID);
    if (strip) return strip;
    strip = document.createElement('div');
    strip.id = STATUS_ID;
    strip.setAttribute('role', 'status');
    strip.setAttribute('aria-live', 'polite');
    strip.setAttribute(
      'style',
      'position:fixed;left:50%;bottom:18px;transform:translateX(-50%);z-index:2147483645;' +
        'max-width:92%;box-sizing:border-box;background:#0b0f14;color:#ffb454;border:1px solid #41576d;' +
        'border-radius:6px;padding:10px 14px;font:12px/1.5 monospace;white-space:pre-wrap;' +
        'word-break:break-all;display:none;pointer-events:none;'
    );
    (document.body || document.documentElement).appendChild(strip);
    return strip;
  } catch {
    return null;
  }
}

/** Show a TV data-fetch failure on screen (URL + error message). */
export function showTvStatus(message: string, url?: string): void {
  if (!IS_WGT_BUILD) return; // production: dead branch
  try {
    const strip = ensureStrip();
    if (!strip) return;
    strip.textContent = url ? `${message}\n${url}` : message;
    strip.style.display = 'block';
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      try {
        strip.style.display = 'none';
      } catch {
        /* the strip is best-effort diagnostics only */
      }
    }, AUTO_HIDE_MS);
  } catch {
    /* diagnostics must never break the app */
  }
}

/** Dismiss the status strip (Back/Escape key handling, Stage 4 wires the key). */
export function hideTvStatus(): void {
  if (!IS_WGT_BUILD) return;
  try {
    const strip = document.getElementById(STATUS_ID);
    if (strip) strip.style.display = 'none';
  } catch {
    /* ignore */
  }
}
