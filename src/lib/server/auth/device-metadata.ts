/**
 * Device metadata parser.
 *
 * Derives safe, descriptive device metadata from the request
 * User-Agent header (plus optional client hints). This is purely
 * descriptive — it CANNOT act as an authentication identity. The
 * canonical security identity remains: user_id + Supabase session_id
 * (from the JWT).
 *
 * Detection strategy: deterministic conservative pattern matching
 * with safe fallbacks. NOT a fragile UA parser. We distinguish:
 *   - mobile (phone)
 *   - tablet
 *   - desktop
 *   - tv (Android TV, Tizen, webOS where reliably detectable)
 *   - unknown
 *
 * CLIENT HINTS (Newtask §6 — real metadata, no hardcoded fallbacks):
 *   Two device classes are NOT distinguishable from the User-Agent
 *   string alone:
 *
 *   1. Brave — Brave intentionally ships a Chrome-identical UA. The
 *      only reliable server-side signal is the `sec-ch-ua` brands
 *      header, where Brave includes a "Brave" brand while the UA says
 *      "Chrome". We parse the raw header server-side (it is a request
 *      header — still server-side classification, no client trust).
 *
 *   2. iPad (iPadOS 13+ default desktop mode) — Safari reports a
 *      Macintosh UA. The standard production signal is touch
 *      capability: a small inline script in app.html sets a purely
 *      descriptive `mavero:device-hint=tablet` cookie when
 *      `maxTouchPoints > 1 && platform === 'MacIntel'`. The cookie is
 *      NOT an authentication credential, NOT PII, and NOT used for
 *      access control — it only refines the descriptive device class
 *      on subsequent requests (first request shows macOS, which is
 *      the honest server-side view).
 *
 * We also derive reasonable browser, OS, and platform labels.
 */

export type DeviceType = 'mobile' | 'tablet' | 'desktop' | 'tv' | 'unknown';

export type DeviceMetadata = {
  deviceType: DeviceType;
  deviceName: string;
  browser: string | null;
  os: string | null;
  platform: string | null;
};

/**
 * Optional secondary signals parsed from REQUEST HEADERS (server-side).
 * All fields are descriptive-only and never trusted as identity.
 */
export type DeviceClientHints = {
  /** Raw `sec-ch-ua` header value, e.g. `"Chromium";v="130", "Brave";v="130", "Not?A_Brand";v="99"`. */
  clientHintsBrands?: string | null;
  /** True when the descriptive touch-hint cookie marks this client as a touch-capable Mac (iPad-as-Mac). */
  touchCapable?: boolean;
};

/** Cookie names owned by this module (descriptive only — never auth). */
export const DEVICE_ID_COOKIE = 'mavero:device-id';
export const DEVICE_HINT_COOKIE = 'mavero:device-hint';

/**
 * Parses the User-Agent header (+ optional client hints) and returns
 * safe device metadata. Never throws — returns 'unknown' on any
 * parse failure.
 */
export function parseDeviceMetadata(
  userAgent: string | null | undefined,
  hints?: DeviceClientHints
): DeviceMetadata {
  const ua = (userAgent ?? '').toLowerCase();

  if (!ua) {
    return { deviceType: 'unknown', deviceName: 'Unknown device', browser: null, os: null, platform: null };
  }

  const browser = detectBrowser(ua, hints);
  const os = detectOS(ua, hints);
  const deviceType = detectDeviceType(ua, hints);
  const platform = detectPlatform(ua, deviceType);
  const deviceName = buildDeviceName(os, browser, deviceType);

  return { deviceType, deviceName, browser, os, platform };
}

function detectDeviceType(ua: string, hints?: DeviceClientHints): DeviceType {
  // TV detection — must come before mobile/tablet because some TV
  // browsers also include "mobile" or "android" in their UA.
  if (
    ua.includes('android tv') ||
    ua.includes('smart-tv') ||
    ua.includes('smarttv') ||
    ua.includes('tizen') ||
    ua.includes('webos') ||
    ua.includes('googletv') ||
    (ua.includes('tv') && ua.includes('samsung'))
  ) {
    return 'tv';
  }

  // Tablet detection — iPad reports as Mac since iOS 13, so check
  // for the specific "ipad" token OR the touch-capable hint cookie
  // (set client-side by the app.html inline script — see module docs).
  // The previous `'ontouchend' in globalThis` check never worked
  // server-side (Node has no ontouchend) and is replaced by the
  // explicit touchCapable hint.
  if (
    ua.includes('ipad') ||
    ua.includes('tablet') ||
    (ua.includes('android') && !ua.includes('mobile')) ||
    (ua.includes('macintosh') && hints?.touchCapable === true)
  ) {
    return 'tablet';
  }

  // Mobile detection.
  if (
    ua.includes('mobile') ||
    ua.includes('iphone') ||
    ua.includes('android') ||
    ua.includes('windows phone') ||
    ua.includes('blackberry') ||
    ua.includes('opera mini')
  ) {
    return 'mobile';
  }

  // Desktop — anything with a desktop browser signature.
  if (
    ua.includes('windows') ||
    ua.includes('macintosh') ||
    ua.includes('linux') ||
    ua.includes('mac os') ||
    ua.includes('cros')
  ) {
    return 'desktop';
  }

  return 'unknown';
}

function detectBrowser(ua: string, hints?: DeviceClientHints): string | null {
  // Client-hints FIRST: Brave intentionally ships a Chrome-identical
  // UA string; the sec-ch-ua brands header is the only reliable
  // server-side Brave signal (Brave includes a "Brave" brand there).
  if (hints?.clientHintsBrands && /"brave"/i.test(hints.clientHintsBrands)) return 'Brave';

  // Order matters — check specific browsers before generic engines.
  if (ua.includes('edg/')) return 'Edge';
  if (ua.includes('opr/') || ua.includes('opera')) return 'Opera';
  if (ua.includes('samsungbrowser')) return 'Samsung Internet';
  if (ua.includes('chrome/') && !ua.includes('edg/') && !ua.includes('opr/')) return 'Chrome';
  if (ua.includes('firefox/')) return 'Firefox';
  if (ua.includes('safari/') && !ua.includes('chrome/')) return 'Safari';
  return null;
}

function detectOS(ua: string, hints?: DeviceClientHints): string | null {
  // iPhone/iPad must be checked before macOS because iPhone UAs
  // contain "Mac OS X" (from "like Mac OS X").
  // Tizen/webOS must be checked before Linux because their UAs
  // contain "Linux" as well.
  if (ua.includes('iphone') || ua.includes('ipad')) return 'iOS';
  // iPad-as-Mac: the touch hint upgrades the macOS classification.
  if (ua.includes('macintosh') && hints?.touchCapable === true) return 'iPadOS';
  if (ua.includes('tizen')) return 'Tizen';
  if (ua.includes('webos')) return 'webOS';
  if (ua.includes('windows')) return 'Windows';
  if (ua.includes('mac os') || ua.includes('macintosh')) return 'macOS';
  if (ua.includes('android')) return 'Android';
  if (ua.includes('linux')) return 'Linux';
  if (ua.includes('cros')) return 'ChromeOS';
  return null;
}

function detectPlatform(ua: string, deviceType: DeviceType): string | null {
  if (deviceType === 'tv') {
    if (ua.includes('tizen')) return 'Samsung TV';
    if (ua.includes('webos')) return 'LG TV';
    if (ua.includes('android tv')) return 'Android TV';
    if (ua.includes('googletv')) return 'Google TV';
    return 'Smart TV';
  }
  if (ua.includes('windows')) return 'Windows';
  if (ua.includes('mac')) return 'Apple';
  if (ua.includes('android')) return 'Android';
  if (ua.includes('iphone') || ua.includes('ipad')) return 'Apple';
  if (ua.includes('linux')) return 'Linux';
  return null;
}

function buildDeviceName(os: string | null, browser: string | null, deviceType: DeviceType): string {
  const parts: string[] = [];
  if (os) parts.push(os);
  if (browser) parts.push(browser);
  if (parts.length === 0) {
    return deviceType === 'unknown' ? 'Unknown device' : `${deviceType.charAt(0).toUpperCase() + deviceType.slice(1)} device`;
  }
  return parts.join(' • ');
}

/**
 * Generates or reads a random device_id from a cookie.
 * The device_id is a random UUID (v4) stored in a cookie named
 * `mavero:device-id`. It persists across sessions but is NOT an
 * authentication credential — it's a soft grouping identifier that
 * helps recognize the same browser across different auth sessions.
 *
 * Privacy: NOT derived from PII. NOT a fingerprint. NOT used for
 * access control. NOT sent to third parties.
 */
export function getOrCreateDeviceId(existingCookie: string | null | undefined): string {
  if (existingCookie && typeof existingCookie === 'string' && existingCookie.length >= 8) {
    return existingCookie;
  }
  // Generate a random UUID-like string (no crypto dependency needed
  // — this is a soft identifier, not a security credential).
  return crypto.randomUUID();
}

/**
 * Reads the descriptive touch-hint cookie. The app.html inline
 * script sets `mavero:device-hint=tablet` for touch-capable Macs
 * (iPads in desktop mode). This is a purely descriptive refinement
 * signal — never an identity, never auth.
 */
export function readDeviceHintCookie(value: string | null | undefined): boolean {
  return value === 'tablet';
}

/**
 * Centralized device-id cookie handling (Newtask §5 + §38 — small
 * reusable helper, no duplicated cookie logic across routes).
 *
 * Guarantees:
 *   - cookie is created only when absent/invalid (< 8 chars)
 *   - path is '/'
 *   - httpOnly, sameSite 'lax'
 *   - secure only on HTTPS
 *   - 1 year max-age
 *   - NO session token is ever stored in this cookie (it only ever
 *     holds the random device UUID)
 *
 * `set` is invoked ONLY when a new value had to be generated — an
 * existing valid cookie produces zero cookie writes.
 */
export function ensureDeviceIdCookie(
  existingValue: string | null | undefined,
  set: (value: string, options: {
    path: '/';
    httpOnly: true;
    sameSite: 'lax';
    maxAge: number;
    secure: boolean;
  }) => void,
  isSecureRequest: boolean
): string {
  const valid = typeof existingValue === 'string' && existingValue.length >= 8;
  if (valid) return existingValue as string;
  const deviceId = getOrCreateDeviceId(null);
  set(deviceId, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 60 * 60 * 24 * 365, // 1 year
    secure: isSecureRequest
  });
  return deviceId;
}
