/**
 * TV fetch bridge — STAGE 2 data wiring (widget build only).
 *
 * WHY: the web app's client data layer fetches SAME-ORIGIN relative paths
 * (`fetch('/api/...')` — 60+ call sites: DiscoverPage batch rails,
 * recommendations, search, adult-mode settings, providers, downloader…).
 * Inside the .wgt those resolve against the file:// filesystem root
 * (`file:///api/...` → failure) because NO server runs on the device.
 *
 * This bridge wraps `window.fetch` ONCE, at client-hook boot (before any
 * page mounts), and rewrites root-relative `/api/...` URLs to the deployed
 * production API base (`TV_API_BASE` — see api-base.ts). One install point
 * covers every existing call site without touching them.
 *
 * CONTRACT:
 *   - Install is a no-op unless IS_WGT_BUILD (compile-time false in
 *     production — the web app keeps fetching same-origin paths).
 *   - Only ROOT-RELATIVE /api/... URLs are rewritten. Absolute URLs,
 *     protocol-relative URLs and non-API paths pass through untouched.
 *   - Credential-less by construction: the bridge adds no auth material;
 *     the TV endpoints answer with `Access-Control-Allow-Origin: *`
 *     (see $lib/server/http/cors.ts).
 *   - The bridge never throws: any wrap failure falls back to the native
 *     fetch untouched.
 */

import { IS_WGT_BUILD } from '$lib/shared/build-mode';
import { TV_API_BASE } from './api-base';

declare global {
  interface Window {
    __maveroTvFetchBridge?: boolean;
  }
}

export function installTvFetchBridge(): void {
  if (!IS_WGT_BUILD) return; // production: dead branch (compile-time flag)
  if (typeof window === 'undefined') return;
  if (window.__maveroTvFetchBridge) return;

  const nativeFetch = window.fetch.bind(window);

  window.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    try {
      let url: string | null = null;
      if (typeof input === 'string') {
        url = input;
      } else if (input instanceof URL) {
        url = input.href;
      } else if (input && typeof (input as Request).url === 'string') {
        url = (input as Request).url;
      }
      // Rewrite ONLY root-relative API paths (the widget's server-less gap).
      // Everything else — absolute https URLs, /_app assets, /auth pages —
      // passes through untouched.
      if (url && url.charAt(0) === '/' && (url === '/api' || url.startsWith('/api/'))) {
        return nativeFetch(TV_API_BASE + url, init);
      }
      return nativeFetch(input, init);
    } catch {
      // The bridge itself must never break a fetch.
      return nativeFetch(input, init);
    }
  };

  window.__maveroTvFetchBridge = true;
}
