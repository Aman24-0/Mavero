/**
 * Shared device classification — client-safe.
 *
 * Task §7 (big-screen detection): the canonical device classification is
 * derived SERVER-SIDE from the request User-Agent (+ client hints) by
 * `parseDeviceMetadata` in `src/lib/server/auth/device-metadata.ts` and
 * projected to pages via the root layout load. This shared module provides
 * the derived capability helpers used by UI code (sign-in page, account
 * page) so the big-screen / QR-scanner decision logic lives in exactly
 * one place and is identical on server and client:
 *
 *   BIG_SCREEN  (shows QR / hides scanner CTAs):  desktop, tv
 *   QR_SCANNER  (shows "Login on Big Screen"):    mobile, tablet
 *   UNKNOWN     (safest fallback):                hide scanner CTAs
 *
 * This is deliberately NOT CSS/media-query based — the layout needs a
 * stable classification that matches what the device_sessions registry
 * recorded for the same request.
 */

export type ClientDeviceType = 'mobile' | 'tablet' | 'desktop' | 'tv' | 'unknown';

/** Desktop/TV-class screens: the QR-DISPLAY side of the pairing flow. */
export function isBigScreen(deviceType: ClientDeviceType | string | null | undefined): boolean {
  return deviceType === 'desktop' || deviceType === 'tv';
}

/** Phone/tablet devices: the QR-SCANNING / authorization side. */
export function isQrScannerDevice(deviceType: ClientDeviceType | string | null | undefined): boolean {
  return deviceType === 'mobile' || deviceType === 'tablet';
}

/** Human-readable device-class label for session cards. */
export function deviceTypeLabel(deviceType: ClientDeviceType | string | null | undefined): string {
  switch (deviceType) {
    case 'mobile': return 'Phone';
    case 'tablet': return 'Tablet';
    case 'desktop': return 'Desktop';
    case 'tv': return 'TV';
    default: return 'Device';
  }
}
