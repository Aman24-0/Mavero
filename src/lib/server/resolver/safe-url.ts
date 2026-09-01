import { ResolverError } from './errors';
import type { Json } from '$lib/server/supabase/database.types';
import type { PlaybackProtocol, ResolverResultType } from './types';

const directProtocols = new Set(['https:']);
const embedProtocols = new Set(['https:']);

function parseUrl(raw: string): URL {
  try {
    return new URL(raw);
  } catch {
    throw new ResolverError('INVALID_SOURCE_URL');
  }
}

function isPrivateHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return true;
  if (host === '::1' || host === '[::1]') return true;
  if (/^127(?:\.[0-9]{1,3}){3}$/.test(host)) return true;
  if (/^10(?:\.[0-9]{1,3}){3}$/.test(host)) return true;
  if (/^192\.168(?:\.[0-9]{1,3}){2}$/.test(host)) return true;
  const private172 = host.match(/^172\.(\d{1,3})(?:\.[0-9]{1,3}){2}$/);
  if (private172 && Number(private172[1]) >= 16 && Number(private172[1]) <= 31) return true;
  if (/^169\.254(?:\.[0-9]{1,3}){2}$/.test(host)) return true;
  if (/^0(?:\.[0-9]{1,3}){3}$/.test(host)) return true;
  if (host.includes(':') && (host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe8') || host.startsWith('fe9') || host.startsWith('fea') || host.startsWith('feb'))) return true;
  return false;
}

export function validateProviderEndpoint(raw: string): string {
  const url = parseUrl(raw);
  if (url.protocol !== 'https:' || url.username || url.password || isPrivateHostname(url.hostname)) throw new ResolverError('INVALID_PROVIDER_ENDPOINT');
  return url.toString();
}

export function validatePlaybackUrl(raw: string, type: Exclude<ResolverResultType, 'unavailable' | 'error'>, allowedEmbedOrigins: string[] = [], allowDynamicEmbedOrigins = false): string {
  // Same-origin relative embed URLs (paths starting with "/" and no scheme/host)
  // are inherently same-origin with the Mavero deployment. They are used by
  // server-side redirect bootstrap routes (e.g. the SuperEmbed Advanced way
  // /api/playback/superembed route that reproduces the official se_player.php
  // flow). Such URLs cannot be parsed by `new URL()` without a base, so we
  // validate them structurally here and skip the origin allowlist (the browser
  // will treat them as same-origin automatically).
  if (type === 'embed' && raw.startsWith('/') && !raw.startsWith('//')) {
    if (/[\s\r\n]/.test(raw) || raw.includes('\\')) throw new ResolverError('INVALID_SOURCE_URL');
    if (raw.length > 2048) throw new ResolverError('INVALID_SOURCE_URL');
    return raw;
  }

  const url = parseUrl(raw);
  const protocols = type === 'embed' ? embedProtocols : directProtocols;
  if (!protocols.has(url.protocol) || url.username || url.password || isPrivateHostname(url.hostname)) throw new ResolverError('INVALID_SOURCE_URL');
  if (type === 'embed' && !allowDynamicEmbedOrigins) {
    const origin = url.origin.toLowerCase();
    const allowed = allowedEmbedOrigins.map((value) => parseUrl(value).origin.toLowerCase());
    if (!allowed.includes(origin)) throw new ResolverError('INVALID_SOURCE_URL');
  }
  return url.toString();
}

export function allowedEmbedOriginsFromCapabilities(capabilities: Json): string[] {
  if (!capabilities || typeof capabilities !== 'object' || Array.isArray(capabilities)) return [];
  const value = (capabilities as { [key: string]: Json | undefined }).allowed_embed_origins;
  if (!Array.isArray(value)) return [];
  return value.filter((origin): origin is string => typeof origin === 'string').slice(0, 20);
}

/**
 * Returns true when a source explicitly opts in to dynamic embed origins.
 * This is reserved for sources whose embed URL is returned by a remote API
 * (e.g. SuperEmbed) and therefore cannot be matched against a static
 * `allowed_embed_origins` list. HTTPS and non-private-host validation still
 * apply; only the origin allowlist is relaxed.
 */
export function allowDynamicEmbedOriginsFromCapabilities(capabilities: Json): boolean {
  if (!capabilities || typeof capabilities !== 'object' || Array.isArray(capabilities)) return false;
  const value = (capabilities as { [key: string]: Json | undefined }).allow_dynamic_embed_origins;
  return value === true;
}

export function protocolForUrl(raw: string): PlaybackProtocol {
  const pathname = new URL(raw).pathname.toLowerCase();
  if (pathname.endsWith('.m3u8')) return 'hls';
  if (pathname.endsWith('.mpd')) return 'dash';
  if (/\.(mp4|m4v|webm|mov)$/.test(pathname)) return 'mp4';
  return 'unknown';
}

export function isValidExpiry(expiresAt: string | undefined): boolean {
  if (!expiresAt) return true;
  const timestamp = Date.parse(expiresAt);
  return Number.isFinite(timestamp) && timestamp > Date.now();
}
