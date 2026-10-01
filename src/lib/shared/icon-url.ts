/**
 * Phase I (audit fix) — Icon URL validation.
 *
 * Shared validation for URL-based icon fields on download_providers and
 * streaming_providers. Replaces the previous loose `text()` validation
 * that accepted arbitrary strings (FINDING-010, FINDING-017).
 *
 * Security contract:
 *   - Only `http:` and `https:` schemes are allowed.
 *   - `javascript:`, `data:`, `blob:`, `file:`, `vbscript:`, and any
 *     other scheme are REJECTED at the application layer.
 *   - The URL must have a non-empty hostname (no `http://` alone).
 *   - The URL must be <= 500 characters (defense against abuse).
 *   - Null/empty is allowed (icon is optional — the renderer shows a
 *     fallback when the field is null/invalid).
 *
 * This validation is defense-in-depth — the rendering component
 * (DownloaderIcon.svelte) ALSO sanitizes at render time and provides a
 * safe fallback for any URL that fails to load or was tampered with
 * after validation.
 *
 * CSP note: the icon is rendered as an `<img src="...">` tag. The
 * site's CSP must allow `img-src` from `https:` and `http:` (most
 * configs do). SVG URLs are allowed by the URL validation but the
 * renderer treats them as images (NOT inline SVG), so there is no
 * XSS risk from SVG content — the browser sandboxes `<img>` SVGs.
 */

/** Maximum allowed length for an icon URL. */
export const ICON_URL_MAX_LENGTH = 500;

/** Allowed URL schemes for icons. */
const ALLOWED_ICON_SCHEMES = new Set(['http:', 'https:']);

export class IconValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IconValidationError';
  }
}

/**
 * Validate an icon URL string. Returns the normalized URL string if
 * valid, or null if the input is empty/null (icon is optional).
 *
 * @throws IconValidationError if the URL is non-empty but invalid
 *   (wrong scheme, no hostname, too long, malformed).
 */
export function validateIconUrl(value: string | null | undefined): string | null {
  const normalized = String(value ?? '').trim();
  if (!normalized) return null;

  if (normalized.length > ICON_URL_MAX_LENGTH) {
    throw new IconValidationError(`Icon URL must be ${ICON_URL_MAX_LENGTH} characters or fewer.`);
  }

  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new IconValidationError('Icon URL is not a valid URL.');
  }

  if (!ALLOWED_ICON_SCHEMES.has(parsed.protocol)) {
    throw new IconValidationError(
      `Icon URL must use http: or https: scheme (got ${parsed.protocol}). javascript:, data:, blob:, and other schemes are rejected for security.`,
    );
  }

  if (!parsed.hostname || parsed.hostname.length < 3) {
    throw new IconValidationError('Icon URL must have a valid hostname.');
  }

  return normalized;
}

/**
 * Type guard: is the given value a valid icon URL string?
 * (Does not throw — returns false on any validation failure.)
 * Used by rendering components to decide whether to render an <img>
 * or fall back to a default icon.
 */
export function isValidIconUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    return validateIconUrl(value) !== null;
  } catch {
    return false;
  }
}
