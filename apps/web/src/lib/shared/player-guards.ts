import type { PlayerSource } from './player';
import { isSandboxPolicy } from './sandbox-policy';

function isHttpsUrl(value: unknown) {
  if (typeof value !== 'string' || !value) return false;
  // Same-origin relative embed URLs (paths starting with "/" and not "//")
  // are valid for sources that use a server-side redirect bootstrap route.
  // The browser resolves these against the page origin, so they are
  // inherently same-origin and HTTPS when Mavero is served over HTTPS.
  if (value.startsWith('/') && !value.startsWith('//')) {
    return !/[\s\r\n]/.test(value) && !value.includes('\\') && value.length <= 2048;
  }
  try {
    const url = new URL(value);
    return url.protocol === 'https:';
  } catch {
    return false;
  }
}

export function isPlayablePlayerSource(value: unknown): value is PlayerSource {
  if (!value || typeof value !== 'object') return false;
  const source = value as Partial<PlayerSource>;
  if (source.type !== 'direct' && source.type !== 'embed') return false;
  if (!isHttpsUrl(source.url)) return false;
  if (source.sandboxPolicy !== undefined && !isSandboxPolicy(source.sandboxPolicy)) return false;
  return typeof source.sourceId === 'string' && typeof source.providerId === 'string';
}

export function normalizePlayerSource(value: unknown): PlayerSource | null {
  if (!isPlayablePlayerSource(value)) return null;
  return value;
}

export function sourceIsExpired(source: PlayerSource, now = Date.now()) {
  if (!source.expiresAt) return false;
  const timestamp = Date.parse(source.expiresAt);
  return Number.isFinite(timestamp) && timestamp <= now;
}

export function isEmbedOriginAllowed(source: PlayerSource) {
  if (source.type !== 'embed' || !source.url) return false;
  // Same-origin relative embed URLs are always allowed (the browser resolves
  // them against the page origin). This mirrors the server-side
  // validatePlaybackUrl relative-URL allowance in safe-url.ts.
  if (source.url.startsWith('/') && !source.url.startsWith('//')) return true;
  try {
    const url = new URL(source.url);
    return url.protocol === 'https:' && url.origin !== 'null';
  } catch {
    return false;
  }
}
