/**
 * Device metadata parser.
 *
 * Derives safe, descriptive device metadata from the request
 * User-Agent header. This is purely descriptive — it CANNOT act as
 * an authentication identity. The canonical security identity
 * remains: user_id + Supabase session_id (from the JWT).
 *
 * Detection strategy: deterministic conservative pattern matching
 * with safe fallbacks. NOT a fragile UA parser. We distinguish:
 *   - mobile (phone)
 *   - tablet
 *   - desktop
 *   - tv (Android TV, Tizen, webOS where reliably detectable)
 *   - unknown
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
 * Parses the User-Agent header and returns safe device metadata.
 * Never throws — returns 'unknown' on any parse failure.
 */
export function parseDeviceMetadata(userAgent: string | null | undefined): DeviceMetadata {
  const ua = (userAgent ?? '').toLowerCase();

  if (!ua) {
    return { deviceType: 'unknown', deviceName: 'Unknown device', browser: null, os: null, platform: null };
  }

  const browser = detectBrowser(ua);
  const os = detectOS(ua);
  const deviceType = detectDeviceType(ua);
  const platform = detectPlatform(ua, deviceType);
  const deviceName = buildDeviceName(os, browser, deviceType);

  return { deviceType, deviceName, browser, os, platform };
}

function detectDeviceType(ua: string): DeviceType {
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
  // for the specific "ipad" token OR "macintosh" + "touch".
  if (
    ua.includes('ipad') ||
    ua.includes('tablet') ||
    (ua.includes('android') && !ua.includes('mobile')) ||
    (ua.includes('macintosh') && 'ontouchend' in globalThis)
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

function detectBrowser(ua: string): string | null {
  // Order matters — check specific browsers before generic engines.
  if (ua.includes('edg/')) return 'Edge';
  if (ua.includes('opr/') || ua.includes('opera')) return 'Opera';
  if (ua.includes('samsungbrowser')) return 'Samsung Internet';
  if (ua.includes('chrome/') && !ua.includes('edg/') && !ua.includes('opr/')) return 'Chrome';
  if (ua.includes('firefox/')) return 'Firefox';
  if (ua.includes('safari/') && !ua.includes('chrome/')) return 'Safari';
  return null;
}

function detectOS(ua: string): string | null {
  // iPhone/iPad must be checked before macOS because iPhone UAs
  // contain "Mac OS X" (from "like Mac OS X").
  // Tizen/webOS must be checked before Linux because their UAs
  // contain "Linux" as well.
  if (ua.includes('iphone') || ua.includes('ipad')) return 'iOS';
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
